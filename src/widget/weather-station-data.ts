/**
 * 天气站数据层（C1 天气沉浸页 + WeatherWidget 卡片增强共用，§4.7）。
 *
 * 纯函数（可单测）：
 *  - 气候常模：Open-Meteo archive 逐日 max/min/mean → 按 MM-DD 聚合多年均值，
 *    ±window 天滑窗平滑；localStorage 缓存（常模年内几乎不变，TTL 30 天）。
 *  - minutely_15 降水：15 分钟槽 mm → mm/h（×4），取「现在起未来 60 分钟」
 *    4 槽并给出强度分级 / 起雨时刻摘要。
 *  - 24h 多指标切片：从 hourly 数组按城市本地时间定位当前小时起 24 点。
 *  - 折线几何：值序列 → SVG path（null 断线）。
 *
 * 时间口径：Open-Meteo `timezone=auto` 返回的时间串是城市本地时间、不带
 * 偏移；必须用 utc_offset_seconds 换算真实瞬时（与 WeatherWidget 同源）。
 */
import { fetchJson } from "../lib/network";

/* ------------------------------------------------------------------ */
/*  时间工具                                                            */
/* ------------------------------------------------------------------ */

/** 城市本地时间串 → UTC 毫秒（无偏移信息时退回本机时区解析）。 */
export function localTimeToMs(t: string, utcOffsetSeconds: number | undefined): number {
  if (utcOffsetSeconds === undefined) return new Date(t).getTime();
  return Date.parse(t + "Z") - utcOffsetSeconds * 1000;
}

/** 小时标签直接取时间串里的城市本地小时（避免 Date 往返受 DST 影响）。 */
export function hourLabel(t: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? `${t.slice(11, 13)}:00` : "";
}

/** "2026-09-15" / "2026-09-15T13:00" → "09-15"（常模按日历日聚合的键）。 */
export function dayKey(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}` : "";
}

/* ------------------------------------------------------------------ */
/*  气候常模（archive API）                                             */
/* ------------------------------------------------------------------ */

export type DailyNormal = {
  /** 多年平均日最高 / 最低 / 均温（°C）。 */
  tmax: number;
  tmin: number;
  tmean: number;
  /** 参与平均的样本天数（年数 × 滑窗天数）。 */
  samples: number;
};

export type ArchiveDaily = {
  time: string[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  temperature_2m_mean?: (number | null)[];
};

export type ClimateNormals = {
  /** MM-DD → 该日历日的多年平均（未平滑，normalForDate 时再滑窗）。 */
  byDay: Record<string, DailyNormal>;
  /** 数据覆盖的年份区间（含）。 */
  fromYear: number;
  toYear: number;
  /** 缓存写入时间戳。 */
  at: number;
};

/** archive 拉取的完整年数（10 年常模是气候学常用口径的轻量版）。 */
export const NORMALS_YEARS = 10;

/** archive API 请求 URL：最近 NORMALS_YEARS 个完整年份的逐日 max/min/mean。 */
export function archiveUrl(lat: number, lon: number, fromYear: number, toYear: number): string {
  return (
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${fromYear}-01-01&end_date=${toYear}-12-31` +
    `&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean&timezone=auto`
  );
}

/** 逐日样本 → MM-DD 多年均值（null 样本跳过；缺 mean 时用 (max+min)/2）。 */
export function aggregateNormals(daily: ArchiveDaily): Record<string, DailyNormal> {
  const acc: Record<string, { max: number; min: number; mean: number; n: number }> = {};
  const n = daily.time?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const max = daily.temperature_2m_max?.[i];
    const min = daily.temperature_2m_min?.[i];
    if (max == null || min == null || !Number.isFinite(max) || !Number.isFinite(min)) continue;
    const meanRaw = daily.temperature_2m_mean?.[i];
    const mean = meanRaw != null && Number.isFinite(meanRaw) ? meanRaw : (max + min) / 2;
    const key = dayKey(daily.time[i]);
    if (!key) continue;
    const a = (acc[key] ??= { max: 0, min: 0, mean: 0, n: 0 });
    a.max += max;
    a.min += min;
    a.mean += mean;
    a.n += 1;
  }
  const out: Record<string, DailyNormal> = {};
  for (const [k, a] of Object.entries(acc)) {
    if (a.n === 0) continue;
    out[k] = { tmax: a.max / a.n, tmin: a.min / a.n, tmean: a.mean / a.n, samples: a.n };
  }
  return out;
}

/** 以给定日期为中心的 MM-DD 键序列（跨年环绕；闰日按 2024 基准年生成）。 */
function dayKeysAround(date: Date, window: number): string[] {
  const keys: string[] = [];
  // 用固定闰年基准，保证 02-29 可被枚举；聚合表里没有的键会被跳过。
  const base = new Date(Date.UTC(2024, date.getMonth(), date.getDate()));
  for (let d = -window; d <= window; d++) {
    const t = new Date(base.getTime() + d * 86400000);
    keys.push(`${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`);
  }
  return keys;
}

/**
 * 某日期的常模（±window 天样本加权平均，平滑单日噪声）。
 * 返回 null 表示常模表中该日期附近无任何样本。
 */
export function normalForDate(normals: Record<string, DailyNormal>, date: Date, window = 3): DailyNormal | null {
  let max = 0;
  let min = 0;
  let mean = 0;
  let samples = 0;
  for (const k of dayKeysAround(date, window)) {
    const d = normals[k];
    if (!d) continue;
    max += d.tmax * d.samples;
    min += d.tmin * d.samples;
    mean += d.tmean * d.samples;
    samples += d.samples;
  }
  if (samples === 0) return null;
  return { tmax: max / samples, tmin: min / samples, tmean: mean / samples, samples };
}

const NORMALS_CACHE_KEY = "focus-desk.weather.normals.v1";
const NORMALS_TTL_MS = 30 * 86400000;
const NORMALS_MAX_SLOTS = 4;

export const normalsSlot = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

function readNormalsCache(): Record<string, ClimateNormals> {
  try {
    const raw = localStorage.getItem(NORMALS_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ClimateNormals>) : {};
  } catch {
    return {};
  }
}

function writeNormalsCache(slot: string, value: ClimateNormals): void {
  try {
    const all = readNormalsCache();
    all[slot] = value;
    const keys = Object.keys(all);
    if (keys.length > NORMALS_MAX_SLOTS) {
      keys.sort((a, b) => all[a].at - all[b].at);
      for (const k of keys.slice(0, keys.length - NORMALS_MAX_SLOTS)) delete all[k];
    }
    localStorage.setItem(NORMALS_CACHE_KEY, JSON.stringify(all));
  } catch {
    // best-effort：配额溢出时静默（下次展开重新拉取）
  }
}

/** 读缓存中的新鲜常模（TTL 内）；无则 null。 */
export function readCachedNormals(lat: number, lon: number, now = Date.now()): ClimateNormals | null {
  const c = readNormalsCache()[normalsSlot(lat, lon)];
  if (!c || !c.byDay || now - c.at > NORMALS_TTL_MS) return null;
  return c;
}

/**
 * 加载常模：缓存新鲜直接返回；否则拉 archive 最近 NORMALS_YEARS 个完整年
 * 并聚合入缓存。网络失败向上抛（调用方渲染「加载失败」降级态）。
 */
export async function loadClimateNormals(lat: number, lon: number, signal?: AbortSignal): Promise<ClimateNormals> {
  const cached = readCachedNormals(lat, lon);
  if (cached) return cached;
  const thisYear = new Date().getFullYear();
  const toYear = thisYear - 1;
  const fromYear = toYear - NORMALS_YEARS + 1;
  const data = await fetchJson<{ daily?: ArchiveDaily }>(archiveUrl(lat, lon, fromYear, toYear), {
    retries: 1,
    signal
  });
  if (!data?.daily?.time?.length) throw new Error("archive: empty daily");
  const normals: ClimateNormals = { byDay: aggregateNormals(data.daily), fromYear, toYear, at: Date.now() };
  writeNormalsCache(normalsSlot(lat, lon), normals);
  return normals;
}

/* ------------------------------------------------------------------ */
/*  minutely_15 降水（未来一小时降雨）                                    */
/* ------------------------------------------------------------------ */

export type Minutely15 = { time: string[]; precipitation: (number | null)[] };

export type PrecipSlot = {
  /** 槽起始（城市本地时间串）。 */
  time: string;
  /** 槽内降水量换算成的强度 mm/h（15 分钟量 ×4）。 */
  mmPerHour: number;
};

export type PrecipKind = "none" | "light" | "moderate" | "heavy";

export type NextHourPrecip = {
  slots: PrecipSlot[];
  /** 4 槽降水总量（mm）。 */
  totalMm: number;
  /** 峰值强度（mm/h）。 */
  peakMmPerHour: number;
  /** 首个有降水的槽距现在多少分钟（0 = 正在下）；无降水为 null。 */
  startsInMin: number | null;
  kind: PrecipKind;
};

/** WMO 降雨强度分级（mm/h）：<0.1 无 / <2.5 小 / <10 中 / ≥10 大。 */
export function precipKind(mmPerHour: number): PrecipKind {
  if (!(mmPerHour >= 0.1)) return "none";
  if (mmPerHour < 2.5) return "light";
  if (mmPerHour < 10) return "moderate";
  return "heavy";
}

/**
 * 从 minutely_15 序列取「包含现在的槽」起连续 4 槽（60 分钟），
 * 15 分钟量换算 mm/h。序列不覆盖当前时刻时返回空数组（调用方隐藏该条）。
 */
export function nextHourPrecip(m: Minutely15 | undefined, nowMs: number, utcOffsetSeconds?: number): PrecipSlot[] {
  if (!m?.time?.length) return [];
  let start = -1;
  for (let i = 0; i < m.time.length; i++) {
    const t = localTimeToMs(m.time[i], utcOffsetSeconds);
    if (t + 15 * 60000 > nowMs) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const out: PrecipSlot[] = [];
  for (let i = start; i < Math.min(start + 4, m.time.length); i++) {
    const v = m.precipitation?.[i];
    out.push({ time: m.time[i], mmPerHour: v != null && Number.isFinite(v) ? Math.max(0, v) * 4 : 0 });
  }
  return out;
}

/** 4 槽摘要：总量 / 峰值 / 起雨时刻 / 分级。 */
export function summarizeNextHour(slots: PrecipSlot[]): NextHourPrecip {
  let totalMm = 0;
  let peak = 0;
  let startsInMin: number | null = null;
  slots.forEach((s, i) => {
    totalMm += s.mmPerHour / 4;
    if (s.mmPerHour > peak) peak = s.mmPerHour;
    if (startsInMin === null && precipKind(s.mmPerHour) !== "none") startsInMin = i * 15;
  });
  return { slots, totalMm, peakMmPerHour: peak, startsInMin, kind: precipKind(peak) };
}

/* ------------------------------------------------------------------ */
/*  24h 多指标切片                                                       */
/* ------------------------------------------------------------------ */

export type HourlyRaw = {
  time: string[];
  temperature_2m?: (number | null)[];
  apparent_temperature?: (number | null)[];
  precipitation_probability?: (number | null)[];
  precipitation?: (number | null)[];
  relative_humidity_2m?: (number | null)[];
  wind_speed_10m?: (number | null)[];
  weather_code?: (number | null)[];
  weathercode?: (number | null)[];
};

export type HourlyMetric = {
  time: string;
  temp: number | null;
  feels: number | null;
  precipProb: number | null;
  precip: number | null;
  humidity: number | null;
  wind: number | null;
  code: number;
};

const num = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) ? v : null);

/** 从当前小时（城市本地）起切 24 点；序列不覆盖现在时从 0 起。 */
export function sliceNext24h(h: HourlyRaw | undefined, nowMs: number, utcOffsetSeconds?: number): HourlyMetric[] {
  if (!h?.time?.length) return [];
  let from = h.time.findIndex((t) => localTimeToMs(t, utcOffsetSeconds) + 3600000 > nowMs);
  if (from < 0) from = 0;
  const out: HourlyMetric[] = [];
  for (let i = from; i < Math.min(from + 24, h.time.length); i++) {
    out.push({
      time: h.time[i],
      temp: num(h.temperature_2m?.[i]),
      feels: num(h.apparent_temperature?.[i]),
      precipProb: num(h.precipitation_probability?.[i]),
      precip: num(h.precipitation?.[i]),
      humidity: num(h.relative_humidity_2m?.[i]),
      wind: num(h.wind_speed_10m?.[i]),
      code: num(h.weather_code?.[i] ?? h.weathercode?.[i]) ?? 0
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  折线几何                                                             */
/* ------------------------------------------------------------------ */

/** 值域带边距的「好看」区间（min==max 时上下各扩 1）。 */
export function valueRange(values: (number | null)[], padRatio = 0.12): { min: number; max: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 };
  if (hi - lo < 0.001) return { min: lo - 1, max: hi + 1 };
  const pad = (hi - lo) * padRatio;
  return { min: lo - pad, max: hi + pad };
}

/** 值 → y 坐标（min→h，max→0）。 */
export function yFor(v: number, min: number, max: number, h: number): number {
  return h - ((v - min) / Math.max(1e-9, max - min)) * h;
}

/**
 * 值序列 → SVG path（等距 x；null 处断线，下一有效点重新 M）。
 */
export function polylinePath(values: (number | null)[], w: number, h: number, min: number, max: number): string {
  const n = values.length;
  if (n === 0) return "";
  const parts: string[] = [];
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    const y = yFor(v, min, max, h);
    parts.push(`${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`);
    pen = true;
  }
  return parts.join(" ");
}
