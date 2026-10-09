/**
 * §4.7 IP 自动定位单测：parseIpGeo 纯函数边界 + fetchIpGeo 的离线短路 /
 * 缓存 TTL / 网络失败回退（必须返回 null 且不抛，调用方据此沿用手动城市）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSettingsStore } from "../store/settings-store";
import {
  parseIpGeo,
  parseIpSbGeo,
  fetchIpGeo,
  readIpGeoCache,
  clearIpGeoCache,
  IPGEO_CACHE_KEY,
  IPGEO_TTL_MS
} from "./ip-geo";

/** ipwho.is 真实成功响应的字段子集（其余字段调用方不关心，解析器须忽略）。 */
const OK_PAYLOAD = {
  ip: "203.0.113.7",
  success: true,
  type: "IPv4",
  country: "China",
  region: "Shanghai",
  city: "Shanghai",
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: { id: "Asia/Shanghai", utc: "+08:00" }
};

/** 覆写 navigator.onLine（原属性只读，需用 defineProperty）。 */
function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("parseIpGeo", () => {
  it("解析成功：取 latitude/longitude/city 与 ip/country/isp，忽略其余字段", () => {
    expect(parseIpGeo(OK_PAYLOAD)).toEqual({
      lat: 31.2304,
      lon: 121.4737,
      city: "Shanghai",
      ip: "203.0.113.7",
      country: "China"
    });
    expect(parseIpGeo({ ...OK_PAYLOAD, connection: { isp: "China Telecom" } })?.isp).toBe("China Telecom");
  });

  it("success:false（保留地址段 / 限流）返回 null", () => {
    expect(parseIpGeo({ success: false, message: "Reserved range" })).toBeNull();
    // 缺 success 字段同样视为失败，不能默认放行。
    expect(parseIpGeo({ latitude: 1, longitude: 2, city: "X" })).toBeNull();
  });

  it("越界 / 非有限坐标一律拒绝", () => {
    expect(parseIpGeo({ ...OK_PAYLOAD, latitude: 90.001 })).toBeNull();
    expect(parseIpGeo({ ...OK_PAYLOAD, latitude: -90.5 })).toBeNull();
    expect(parseIpGeo({ ...OK_PAYLOAD, longitude: 180.1 })).toBeNull();
    expect(parseIpGeo({ ...OK_PAYLOAD, longitude: -181 })).toBeNull();
    expect(parseIpGeo({ ...OK_PAYLOAD, latitude: Number.NaN })).toBeNull();
    expect(parseIpGeo({ ...OK_PAYLOAD, longitude: Number.POSITIVE_INFINITY })).toBeNull();
    // 字符串形式的数字也拒绝：服务端契约是 number，不做隐式转换。
    expect(parseIpGeo({ ...OK_PAYLOAD, latitude: "31.2" })).toBeNull();
    // 边界值本身合法。
    expect(parseIpGeo({ ...OK_PAYLOAD, latitude: 90, longitude: -180 })).toEqual({
      lat: 90,
      lon: -180,
      city: "Shanghai",
      ip: "203.0.113.7",
      country: "China"
    });
  });

  it("坏形状返回 null；city 缺失 / 空白回退「当前位置」", () => {
    expect(parseIpGeo(null)).toBeNull();
    expect(parseIpGeo(undefined)).toBeNull();
    expect(parseIpGeo("success")).toBeNull();
    expect(parseIpGeo([OK_PAYLOAD])).toBeNull();
    expect(parseIpGeo({ ...OK_PAYLOAD, city: undefined })?.city).toBe("当前位置");
    expect(parseIpGeo({ ...OK_PAYLOAD, city: "   " })?.city).toBe("当前位置");
    expect(parseIpGeo({ ...OK_PAYLOAD, city: "  Suzhou " })?.city).toBe("Suzhou");
  });
});

describe("parseIpSbGeo（备用源 api.ip.sb/geoip）", () => {
  const SB_PAYLOAD = {
    organization: "AS4134 CHINANET",
    country: "China",
    country_code: "CN",
    city: "Shanghai",
    latitude: 31.2304,
    longitude: 121.4737,
    ip: "203.0.113.9",
    asn: "4134"
  };

  it("解析成功：organization → isp，ip/country 附带", () => {
    expect(parseIpSbGeo(SB_PAYLOAD)).toEqual({
      lat: 31.2304,
      lon: 121.4737,
      city: "Shanghai",
      ip: "203.0.113.9",
      country: "China",
      isp: "AS4134 CHINANET"
    });
  });

  it("坏形状 / 缺坐标 / 越界坐标 / 纯文本错误体一律 null", () => {
    expect(parseIpSbGeo("error")).toBeNull();
    expect(parseIpSbGeo(null)).toBeNull();
    expect(parseIpSbGeo({ ip: "1.2.3.4", city: "X" })).toBeNull();
    expect(parseIpSbGeo({ ...SB_PAYLOAD, latitude: 91 })).toBeNull();
    expect(parseIpSbGeo({ ...SB_PAYLOAD, city: "" })?.city).toBe("当前位置");
  });
});

describe("fetchIpGeo", () => {
  beforeEach(() => {
    clearIpGeoCache();
    setOnLine(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setOnLine(true);
    clearIpGeoCache();
  });

  it("网络失败（fetch 抛 TypeError，重试耗尽）逐源尝试后回退 null 且不抛；不写缓存", async () => {
    const spy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", spy);
    await expect(fetchIpGeo()).resolves.toBeNull();
    // retries: 1 → 每源共 2 次尝试；主备两源都失败 = 4 次（真实退避 ≈0.8s×2 起）。
    expect(spy).toHaveBeenCalledTimes(4);
    expect(localStorage.getItem(IPGEO_CACHE_KEY)).toBeNull();
  });

  it("主源 4xx 不重试直接换备源；备源成功即返回（主源单点故障不拖垮整功能）", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: false }, 403))
      .mockResolvedValueOnce(
        jsonResponse({
          ip: "203.0.113.9",
          city: "Shanghai",
          country: "China",
          latitude: 31.23,
          longitude: 121.47,
          organization: "AS4134"
        })
      );
    vi.stubGlobal("fetch", spy);
    const geo = await fetchIpGeo();
    expect(geo).toEqual({
      lat: 31.23,
      lon: 121.47,
      city: "Shanghai",
      ip: "203.0.113.9",
      country: "China",
      isp: "AS4134"
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0][0])).toContain("ipwho.is");
    expect(String(spy.mock.calls[1][0])).toContain("ip.sb");
  });

  it("离线时不发请求，直接返回 null", async () => {
    setOnLine(false);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(fetchIpGeo()).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("成功即写缓存；24h 内再次调用命中缓存不发请求；force 跳过缓存", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(OK_PAYLOAD));
    vi.stubGlobal("fetch", spy);

    const first = await fetchIpGeo();
    expect(first).toEqual({
      lat: 31.2304,
      lon: 121.4737,
      city: "Shanghai",
      ip: "203.0.113.7",
      country: "China"
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // 中文界面（测试默认语言）带 lang=zh-CN 取中文城市名。
    expect(String(spy.mock.calls[0][0])).toBe("https://ipwho.is/?lang=zh-CN");
    const stored = JSON.parse(localStorage.getItem(IPGEO_CACHE_KEY) ?? "null") as { at: number; city: string };
    expect(stored.city).toBe("Shanghai");
    expect(typeof stored.at).toBe("number");

    const second = await fetchIpGeo();
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockResolvedValue(jsonResponse({ ...OK_PAYLOAD, city: "Hangzhou", latitude: 30.27, longitude: 120.15 }));
    const forced = await fetchIpGeo({ force: true });
    expect(forced).toEqual({ lat: 30.27, lon: 120.15, city: "Hangzhou", ip: "203.0.113.7", country: "China" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(readIpGeoCache()?.city).toBe("Hangzhou");
  });

  it("success:false 的 200 响应返回 null，且不覆盖既有缓存", async () => {
    localStorage.setItem(IPGEO_CACHE_KEY, JSON.stringify({ lat: 1, lon: 2, city: "Old", at: Date.now() }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: false, message: "Reserved range" })));
    await expect(fetchIpGeo({ force: true })).resolves.toBeNull();
    expect(readIpGeoCache()?.city).toBe("Old");
  });

  it("英文界面不带 lang 参数（服务端默认英文城市名）", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(OK_PAYLOAD));
    vi.stubGlobal("fetch", spy);
    const prev = useSettingsStore.getState().general.language;
    useSettingsStore.getState().setGeneral({ language: "English" });
    try {
      await fetchIpGeo({ force: true });
      expect(String(spy.mock.calls[0][0])).toBe("https://ipwho.is/");
    } finally {
      useSettingsStore.getState().setGeneral({ language: prev });
    }
  });

  it("并发调用共享同一在途请求：两个天气实例同时启动只发一次", async () => {
    let release!: (r: Response) => void;
    const spy = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((res) => {
          release = res;
        })
    );
    vi.stubGlobal("fetch", spy);
    const a = fetchIpGeo();
    const b = fetchIpGeo({ force: true });
    // 让两个调用都越过同步的缓存检查、进入在途共享。
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    release(jsonResponse(OK_PAYLOAD));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({
      lat: 31.2304,
      lon: 121.4737,
      city: "Shanghai",
      ip: "203.0.113.7",
      country: "China"
    });
    expect(rb).toEqual(ra);
    expect(spy).toHaveBeenCalledTimes(1);
    // 在途结束后再次调用命中缓存，不再请求。
    await fetchIpGeo();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("调用方中止后拿到 null，但共享请求照常完成并写缓存供下次复用", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((res) => {
            release = res;
          })
      )
    );
    const ac = new AbortController();
    const p = fetchIpGeo({ signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    release(jsonResponse(OK_PAYLOAD));
    await expect(p).resolves.toBeNull();
    expect(readIpGeoCache()?.city).toBe("Shanghai");
    // 已中止的 signal 直接短路，不发请求。
    const spy2 = vi.fn();
    vi.stubGlobal("fetch", spy2);
    clearIpGeoCache();
    await expect(fetchIpGeo({ signal: ac.signal, force: true })).resolves.toBeNull();
    expect(spy2).not.toHaveBeenCalled();
  });
});

describe("readIpGeoCache", () => {
  afterEach(() => clearIpGeoCache());

  it("TTL 过期 / 时钟倒退 / 损坏 JSON / 越界坐标均视为无缓存", () => {
    const now = 1_700_000_000_000;
    localStorage.setItem(IPGEO_CACHE_KEY, JSON.stringify({ lat: 1, lon: 2, city: "A", at: now - IPGEO_TTL_MS + 1 }));
    expect(readIpGeoCache(now)?.city).toBe("A");
    localStorage.setItem(IPGEO_CACHE_KEY, JSON.stringify({ lat: 1, lon: 2, city: "A", at: now - IPGEO_TTL_MS }));
    expect(readIpGeoCache(now)).toBeNull();
    localStorage.setItem(IPGEO_CACHE_KEY, JSON.stringify({ lat: 1, lon: 2, city: "A", at: now + 60_000 }));
    expect(readIpGeoCache(now)).toBeNull();
    localStorage.setItem(IPGEO_CACHE_KEY, "{not json");
    expect(readIpGeoCache(now)).toBeNull();
    localStorage.setItem(IPGEO_CACHE_KEY, JSON.stringify({ lat: 95, lon: 2, city: "A", at: now }));
    expect(readIpGeoCache(now)).toBeNull();
    clearIpGeoCache();
    expect(readIpGeoCache(now)).toBeNull();
  });
});
