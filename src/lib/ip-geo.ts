/**
 * §4.7 天气 IP 自动定位（主源 ipwho.is，备源 api.ip.sb，均免密钥、城市级精度）。
 *
 * 隐私边界：只在用户显式开启 `extra.weatherAutoLocate`（默认关）后才会发起
 * 请求；请求不带任何用户数据（服务端仅凭来源 IP 反查）；结果只落本机
 * localStorage，24h 内复用不重复请求。任何失败一律收敛为 null——调用方沿用
 * 手动城市，绝不因定位失败改坏已有坐标。
 *
 * 分层：parseIpGeo / parseIpSbGeo 是纯函数（可单测），fetchIpGeo 组合
 * fetchJson（统一超时 + 指数退避重试，4xx 不重试）与离线短路（isOnline 为
 * false 不发请求）。主备两个供应商依次尝试：单源故障/被墙不再让「自动
 * 定位」整功能失效（ipwho.is 历史上发生过整站宕机）。
 */
import { fetchJson } from "./network";
import { isOnline } from "./online-status";
import { appLocale } from "../i18n-lite";

export type IpGeo = {
  lat: number;
  lon: number;
  city: string;
  /** 来源公网 IP（ipwho.is / ip.sb 均返回，供连接页展示）。 */
  ip?: string;
  /** 国家/地区名（跟随界面语言）。 */
  country?: string;
  /** 运营商（ipwho.is connection.isp / ip.sb organization）。 */
  isp?: string;
};

/** localStorage 缓存键（v1：{ lat, lon, city, at }，v1.1 起可含 ip/country/isp）。 */
export const IPGEO_CACHE_KEY = "focus-desk.ipgeo.v1";
/** 缓存有效期：IP 归属地几乎不变，24h 足够，且把对外部服务的请求压到每天至多一次。 */
export const IPGEO_TTL_MS = 24 * 60 * 60 * 1000;
/** 服务端 city 为空时的城市名兜底（沿用设备定位路径的既有文案键）。 */
const FALLBACK_CITY = "当前位置";

type IpGeoCacheEntry = IpGeo & { at: number };

/** 在途请求去重：多个天气实例 / StrictMode 双挂载同时触发只发一次请求，共享同一 Promise。 */
let inflight: Promise<IpGeo | null> | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 可选字符串字段：非空字符串才保留，否则 undefined（不写入 undefined 键值）。 */
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * 解析 ipwho.is 响应为经纬度 + 城市（附带公网 IP / 国家 / ISP）。
 * 校验：`success === true`；latitude/longitude 为有限数且分别落在 [-90, 90] /
 * [-180, 180]；city 非空字符串（空则回退「当前位置」）。任何一项不满足返回 null。
 *
 * @param json - 已反序列化的响应体（unknown，容忍任意坏形状）。
 * @returns `{ lat, lon, city }`；失败响应 / 坏形状 / 越界坐标一律 null。
 * @throws 无。O(1)。
 *
 * @example
 * ```ts
 * parseIpGeo({ success: true, latitude: 31.23, longitude: 121.47, city: "Shanghai" });
 * // → { lat: 31.23, lon: 121.47, city: "Shanghai" }
 * parseIpGeo({ success: false, message: "Reserved range" }); // → null
 * ```
 */
export function parseIpGeo(json: unknown): IpGeo | null {
  if (!isRecord(json)) return null;
  if (json.success !== true) return null;
  const lat = json.latitude;
  const lon = json.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const city = optStr(json.city) ?? FALLBACK_CITY;
  const connection = isRecord(json.connection) ? json.connection : undefined;
  return {
    lat,
    lon,
    city,
    ip: optStr(json.ip),
    country: optStr(json.country),
    isp: connection ? optStr(connection.isp) : undefined
  };
}

/**
 * 解析备用源 api.ip.sb/geoip 响应（形状：{ ip, city, country, latitude,
 * longitude, organization }；出错时返回纯文本错误，parse 自然得 null）。
 * 坐标校验与 {@link parseIpGeo} 同一标准。
 *
 * @param json - 已反序列化的响应体。
 * @returns `{ lat, lon, city, ip?, country?, isp? }`；坏形状 / 越界坐标 null。
 * @throws 无。O(1)。
 */
export function parseIpSbGeo(json: unknown): IpGeo | null {
  if (!isRecord(json)) return null;
  const lat = json.latitude;
  const lon = json.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat,
    lon,
    city: optStr(json.city) ?? FALLBACK_CITY,
    ip: optStr(json.ip),
    country: optStr(json.country),
    isp: optStr(json.organization)
  };
}

/** 供应商表：主源 ipwho.is（中文界面带 lang=zh-CN 拿中文城市名，与默认城市
 *  「北京」同一命名体系），备源 ip.sb（英文默认）。逐个尝试，先解析成功者胜。 */
const PROVIDERS: Array<{ url: () => string; parse: (json: unknown) => IpGeo | null }> = [
  {
    url: () => (appLocale() === "zh-CN" ? `https://ipwho.is/?lang=zh-CN` : "https://ipwho.is/"),
    parse: parseIpGeo
  },
  { url: () => "https://api.ip.sb/geoip", parse: parseIpSbGeo }
];

/**
 * 读取本机缓存的定位结果（仅在 TTL 内有效）。
 *
 * @param now - 当前时间戳（默认 Date.now()，测试注入）。
 * @returns 有效缓存返回 `{ lat, lon, city }`；缺失 / 损坏 / 过期返回 null。
 * @throws 无。
 */
export function readIpGeoCache(now: number = Date.now()): IpGeo | null {
  try {
    const raw = localStorage.getItem(IPGEO_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as unknown;
    if (!isRecord(entry) || typeof entry.at !== "number") return null;
    if (now - entry.at >= IPGEO_TTL_MS || now < entry.at) return null;
    // 缓存内容同样过一遍坐标校验：旧版本 / 被篡改的存储不得放出越界坐标。
    return parseIpGeo({
      success: true,
      latitude: entry.lat,
      longitude: entry.lon,
      city: entry.city,
      ip: entry.ip,
      country: entry.country,
      connection: entry.isp === undefined ? undefined : { isp: entry.isp }
    });
  } catch {
    return null;
  }
}

function writeIpGeoCache(geo: IpGeo, now: number = Date.now()): void {
  try {
    const entry: IpGeoCacheEntry = { ...geo, at: now };
    localStorage.setItem(IPGEO_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // best-effort：配额 / 隐私模式写失败不影响本次定位结果
  }
}

/**
 * 清除定位缓存（用户关闭「自动定位」时调用，不留本机痕迹）。
 *
 * @throws 无。
 */
export function clearIpGeoCache(): void {
  try {
    localStorage.removeItem(IPGEO_CACHE_KEY);
  } catch {
    // best-effort
  }
}

/**
 * IP 自动定位：主源 ipwho.is、备源 api.ip.sb，解析为城市级坐标（附公网
 * IP / 国家 / ISP）。
 *
 * 行为：
 *  - 离线（`isOnline()` 为 false）直接返回 null，不发请求。
 *  - 默认命中 24h 内缓存即返回缓存，不发请求；`force` 为 true 时跳过缓存
 *    （设置页「重新定位」按钮）。
 *  - 并发去重：请求在途期间的其他调用共享同一个 Promise（两个天气实例 /
 *    StrictMode 双挂载同时启动只发一次）；请求本身不随单个调用方的 signal
 *    中止——结果照常写缓存供下次复用，被中止的调用方只是拿到 null。
 *  - 走 fetchJson（用户配置的网络超时 + 指数退避重试，1 次重试）。
 *  - 成功即写缓存；全部供应商失败 / 服务端 `success:false` / 坏坐标一律
 *    返回 null，**不抛错**——调用方据此沿用现有手动坐标。
 *
 * @param opts - `signal` 取消信号（中止后本调用返回 null）；`force` 跳过缓存强制请求。
 * @returns `{ lat, lon, city }` 或 null。
 * @throws 无。
 *
 * @example
 * ```ts
 * const geo = await fetchIpGeo({ signal: controller.signal });
 * if (geo) setExtra({ weatherCity: geo.city, weatherLat: geo.lat, weatherLon: geo.lon });
 * ```
 */
export async function fetchIpGeo(opts?: { signal?: AbortSignal; force?: boolean }): Promise<IpGeo | null> {
  if (opts?.signal?.aborted) return null;
  if (!isOnline()) return null;
  if (!opts?.force) {
    const cached = readIpGeoCache();
    if (cached) return cached;
  }
  if (!inflight) {
    inflight = requestIpGeo().finally(() => {
      inflight = null;
    });
  }
  const geo = await inflight;
  return opts?.signal?.aborted ? null : geo;
}

async function requestIpGeo(): Promise<IpGeo | null> {
  // 主备源依次尝试：主源网络失败 / 服务端 success:false / 坏形状都换下一个；
  // 单源彻底宕机不再让整功能失效。每源 1 次重试（fetchJson 指数退避）。
  for (const provider of PROVIDERS) {
    try {
      const data = await fetchJson<unknown>(provider.url(), { retries: 1 });
      const geo = provider.parse(data);
      if (geo) {
        writeIpGeoCache(geo);
        return geo;
      }
    } catch {
      // 换下一个供应商
    }
  }
  return null;
}
