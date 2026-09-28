/**
 * 天气共享缓存槽（localStorage `focus-desk.weather.cache.v1`，slot = lat/lon 各取三位
 * 小数）：WeatherWidget 拉取后写入富快照；WeatherMini / TodayOverview 只读
 * （需求 F-10「与卡片共享缓存槽，不重复请求」）。
 *
 * 例外两处只写「当前天气」（writeCurrentWeatherSlot）：天气站（展开页）自己拉取成功后
 * 回写，收起后磁贴不会退回「—」；磁贴在槽位缺失 / 过期时兜底拉一次——灵动岛里通过
 * 类型选择器加进来的天气磁贴没有绑定实例，桌面上又未必有天气卡片在维护缓存，此前
 * 这种磁贴永远显示「—」，只有点开才有温度。
 *
 * 读方要「跟着刷新」而不是挂载时读一次：localStorage 的 `storage` 事件只投递给
 * **其他**窗口，同窗口内卡片写缓存时磁贴收不到任何通知——写入口在这里统一派发
 * WEATHER_CACHE_EVENT，subscribeWeatherCache 同时监听它与跨窗口的 storage 事件。
 */

export const WEATHER_CACHE_KEY = "focus-desk.weather.cache.v1";
/** 同窗口写入通知（CustomEvent，无 detail；订阅方自行重读）。 */
export const WEATHER_CACHE_EVENT = "vela:weather-cache";
/** LRU 槽位上限：超出后按写入时刻 `at` 淘汰最旧的。 */
const MAX_SLOTS = 9;

/** 槽位里的「当前天气」字段（与 Open-Meteo current_weather 同名；卡片 CurrentWeather 同型）。 */
export type CachedCurrentWeather = {
  temperature: number;
  weathercode: number;
  windspeed: number;
  apparent_temperature?: number;
};

export const weatherCacheSlot = (lat: number, lon: number): string => `${lat.toFixed(3)},${lon.toFixed(3)}`;

/** 读整份缓存表；缺失 / 损坏返回空表。 */
export function readWeatherCache<T = unknown>(): Record<string, T> {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

/** 写一个槽位（LRU 淘汰到 MAX_SLOTS）并通知本窗口订阅者。写失败静默。 */
export function writeWeatherCacheSlot<T extends { at: number }>(slot: string, snap: T): void {
  try {
    const all = readWeatherCache<T>();
    all[slot] = snap;
    const keys = Object.keys(all);
    if (keys.length > MAX_SLOTS) {
      keys.sort((a, b) => all[a].at - all[b].at);
      for (const k of keys.slice(0, keys.length - MAX_SLOTS)) delete all[k];
    }
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(all));
  } catch {
    return;
  }
  try {
    window.dispatchEvent(new CustomEvent(WEATHER_CACHE_EVENT));
  } catch {
    // best-effort
  }
}

/**
 * 只更新一个槽位的「当前天气」（天气站回写 / 磁贴兜底拉取）：
 *  - 槽位已有卡片写的富快照 → 只换 weather / at（及给到的附加字段），预报 / 逐时 /
 *    预警等原样保留，不会把卡片的数据降级成只有温度；
 *  - 槽位缺失 → 补齐卡片快照的必填字段（forecast null / hourly [] / alerts []），
 *    卡片之后挂载从缓存播种时不会读到 undefined。
 *
 * @param lat - 城市纬度。
 * @param lon - 城市经度。
 * @param weather - 当前天气。
 * @param extra - 可选附加字段（未给的键不改动已有值）。
 * @returns 无。写失败静默。
 */
export function writeCurrentWeatherSlot(
  lat: number,
  lon: number,
  weather: CachedCurrentWeather,
  extra: { humidity?: number | null; aqi?: number | null; uv?: number | null } = {}
): void {
  const slot = weatherCacheSlot(lat, lon);
  const prev = readWeatherCache<Record<string, unknown>>()[slot];
  const base: Record<string, unknown> =
    prev && typeof prev === "object" ? prev : { forecast: null, hourly: [], humidity: null, alerts: [] };
  const next: Record<string, unknown> & { at: number } = { ...base, weather, at: Date.now() };
  if (extra.humidity !== undefined) next.humidity = extra.humidity;
  if (extra.aqi !== undefined) next.aqi = extra.aqi;
  if (extra.uv !== undefined) next.uv = extra.uv;
  writeWeatherCacheSlot(slot, next);
}

/**
 * 订阅缓存变化（本窗口写入 + 其他窗口写入）。回调不带数据，订阅方重读 readWeatherCache。
 * 可直接作为 useSyncExternalStore 的 subscribe。
 */
export function subscribeWeatherCache(cb: () => void): () => void {
  const onLocal = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === WEATHER_CACHE_KEY) cb();
  };
  window.addEventListener(WEATHER_CACHE_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(WEATHER_CACHE_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}

/** useSyncExternalStore 的快照：原始字符串（按值比较，未变则不重渲）。 */
export function weatherCacheSnapshot(): string {
  try {
    return localStorage.getItem(WEATHER_CACHE_KEY) ?? "";
  } catch {
    return "";
  }
}
