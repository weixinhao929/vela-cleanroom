/**
 * 节假日数据在线更新。
 *
 * 内置表只覆盖到发版前已公布的年份（lunar.ts 节日名 / timetable-extras.ts
 * 休班表）；跨年后通过远程 JSON 补齐——默认源为 NateScarlet/holiday-cn
 * （每年一份 {year}.json，国务院发布后社区当天更新）。缓存写入
 * localStorage，7 天刷新一次；离线 / 拉取失败静默回退内置表。
 */

import { fetchText } from "./net-fetch";
import { isOnline } from "./online-status";

export type RemoteHolidayDay = { name: string; off: boolean };

type HolidayCache = {
  fetchedAt: number;
  /** ISO 日期 → 当日安排（放假日 off=true，调休上班日 off=false）。 */
  days: Record<string, RemoteHolidayDay>;
};

const CACHE_KEY = "focus-desk.holidays.remote.v1";
const REFRESH_MS = 7 * 24 * 3600 * 1000;
/** 两年中有一年拉取失败时的重试间隔（成功年份照常缓存）。 */
const PARTIAL_RETRY_MS = 24 * 3600 * 1000;

let memory: HolidayCache | null = null;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function loadCache(): HolidayCache {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    // 形状守卫：键值被写坏成 "null" / "[]" / 缺 days 时，此前直接当 HolidayCache
    // 用，remoteHoliday 读 days[iso] 会 TypeError 到日历渲染；fetchedAt 非数字
    // 则 Date.now() - NaN < REFRESH_MS 恒 false，每次都触发请求。
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as HolidayCache).fetchedAt === "number" &&
      Number.isFinite((parsed as HolidayCache).fetchedAt) &&
      (parsed as HolidayCache).days &&
      typeof (parsed as HolidayCache).days === "object" &&
      !Array.isArray((parsed as HolidayCache).days)
    ) {
      memory = parsed as HolidayCache;
    } else {
      memory = { fetchedAt: 0, days: {} };
    }
  } catch {
    memory = { fetchedAt: 0, days: {} };
  }
  return memory;
}

function saveCache(next: HolidayCache) {
  memory = next;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
  for (const fn of listeners) fn();
}

/**
 * 查询某日的远程节假日安排。
 *
 * @param iso - ISO 日期字符串（`YYYY-MM-DD`）。
 * @returns 当日安排（name + off）；无远程数据时返回 null（调用方回退内置表）。
 * @throws 无。
 *
 * @example
 * ```ts
 * const h = remoteHoliday("2026-10-01"); // { name: "国庆节", off: true } | null
 * ```
 */
export function remoteHoliday(iso: string): RemoteHolidayDay | null {
  return loadCache().days[iso] ?? null;
}

/**
 * 远程数据版本号（fetchedAt 时间戳）。
 * 使用场景：作为组件 useMemo 的失效信号——版本不变时跳过派生数据重算。
 *
 * @returns 缓存写入时间戳；从未成功拉取过为 0。
 */
export function remoteHolidayVersion(): number {
  const c = loadCache();
  return c.fetchedAt;
}

/**
 * 订阅远程节假日缓存更新。
 *
 * @param fn - 缓存写入后的回调。
 * @returns 取消订阅函数。
 */
export function subscribeRemoteHolidays(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type HolidayCnYear = {
  year?: number;
  days?: { name?: string; date?: string; isOffDay?: boolean }[];
};

async function fetchYear(year: number, days: Record<string, RemoteHolidayDay>) {
  const url = `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
  const text = await fetchText(url);
  const data = JSON.parse(text) as HolidayCnYear;
  // 空数据按失败处理（throw）：调用侧只替换「成功」年份，若把 days:[] 当
  // 成功，该年旧缓存会被按前缀清空且 fetchedAt 记为成功（7 天不再重试）。
  if (!data || !Array.isArray(data.days)) throw new Error(`holiday-cn ${year}: malformed payload`);
  let picked = 0;
  for (const d of data.days) {
    if (typeof d.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
    days[d.date] = { name: d.name || "", off: d.isOffDay === true };
    picked++;
  }
  if (picked === 0) throw new Error(`holiday-cn ${year}: empty days`);
}

/**
 * 确保远程节假日数据可用（7 天缓存 + 并发去重）。
 * 拉取当年 + 次年（次年通常未发布，404 忽略）；两年都失败则不更新时间戳，
 * 下次启动重试；离线/失败静默回退内置表。
 *
 * @returns 刷新完成（或判定无需刷新）后 resolve 的共享 Promise。
 * @throws 无（内部全部捕获——数据更新绝不能打断界面）。
 *
 * @example
 * ```ts
 * useEffect(() => { void ensureHolidayData(); }, []);
 * ```
 */
export function ensureHolidayData(): Promise<void> {
  if (inFlight) return inFlight;
  const cache = loadCache();
  if (Date.now() - cache.fetchedAt < REFRESH_MS) return Promise.resolve();
  if (!isOnline()) return Promise.resolve();
  inFlight = (async () => {
    try {
      const y = new Date().getFullYear();
      const years = [y, y + 1];
      const fresh: Record<string, RemoteHolidayDay> = {};
      const results = await Promise.allSettled(years.map((yy) => fetchYear(yy, fresh)));
      // 两年都失败（无网络 / 源失效）则不更新时间戳，下次启动重试。
      if (results.every((r) => r.status === "rejected")) return;
      // 只替换成功年份：此前从空表起步、整表覆盖，"当年瞬时失败 + 次年成功"
      // （次年 JSON 已发布时是常态）会把已缓存的当年数据清空，7 天内不再重试。
      const days: Record<string, RemoteHolidayDay> = { ...cache.days };
      years.forEach((yy, i) => {
        if (results[i].status !== "fulfilled") return;
        const prefix = `${yy}-`;
        for (const k of Object.keys(days)) if (k.startsWith(prefix)) delete days[k];
      });
      Object.assign(days, fresh);
      const allOk = results.every((r) => r.status === "fulfilled");
      // 部分失败：把时间戳往回拨，让失败年份在一天后重试而不是等满 7 天。
      const fetchedAt = allOk ? Date.now() : Date.now() - REFRESH_MS + PARTIAL_RETRY_MS;
      saveCache({ fetchedAt, days });
    } catch {
      // 静默失败：内置表兜底。
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
