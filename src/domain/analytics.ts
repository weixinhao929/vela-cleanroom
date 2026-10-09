import type { PomodoroInterruption, PomodoroSessionRecord } from "./pomodoro";
import { t } from "../i18n-lite";

/**
 * 专注统计领域层：把番茄钟会话/打断记录聚合为统计面板所需的各种口径。
 * 全部纯函数、无副作用，可用固定时间戳单测；「今天」= 当前日历日，
 * 「本周」= 周一起。n 为会话数，d 为桶数（趋势 ≤30 / 热图 = 当月天数）。
 */

/**
 * 判断两个 Date 是否为同一本地日历日。
 *
 * @param a - 第一个日期。
 * @param b - 第二个日期。
 * @returns 年月日均相同则为 true。O(1)。
 */
export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/* （归日规则唯一入口）：所有按日/月/年聚合一律用「片起始时刻的虚拟日键」
 * （virtualDayKey(startedAt, vmHour)）归组，与 Rust 聚合（repositories.rs 按
 * piece_start 的 virtual_day_key 分桶）一一对应。此前各函数按 endedAt 的自然
 * 日归组——splitSessionsByDay 切出的非末片 endedAt 恰为虚拟午夜边界，被记入
 * **次日**，浏览器模式永久错日，Tauri 模式下趋势图与同屏 SQL 热图口径相反。
 * vmHour=0 时 virtualDayKey(start) === 自然日起始日，与旧口径对未切分数据
 * 完全等价。
 * 分钟口径（统一）：一律先按秒累计、出口再一次 round——逐段 round 再求和
 * 在多片切分下与 SQL 口径（先秒求和）可差 1-2 分钟。 */

export interface DailyTrend {
  date: string; // YYYY-MM-DD (local; vmHour>0 时为虚拟日键)
  label: string; // weekday label, "今天" for today
  focusMinutes: number;
}

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weekdayLabel(d: Date, tr: (s: string) => string = t): string {
  return tr(["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]);
}

/** Per-day focus minutes for the last `days` calendar days (including today).
 *  Pure and side-effect free; used by the analytics widget whose "显示天数"
 *  config controls the trend chart range.
 *  P-perf：桶查找由数组 find（O(n×days)）改为 Map 索引（O(n+days)）。 */
export function dailyTrend(
  sessions: PomodoroSessionRecord[],
  now: Date,
  days: number,
  tr: (s: string) => string = t,
  vmHour = 0
): DailyTrend[] {
  const n = Math.max(1, Math.min(30, Math.round(days)));
  const out: DailyTrend[] = [];
  const byKey = new Map<string, DailyTrend>();
  // 桶按虚拟日键排布（vmHour=0 即自然日）：末桶 = now 所属虚拟日。
  const curVirtual = new Date(now.getTime() - vmHour * 3_600_000);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(curVirtual.getFullYear(), curVirtual.getMonth(), curVirtual.getDate() - i);
    const row: DailyTrend = { date: toDateKey(d), label: i === 0 ? tr("今天") : weekdayLabel(d, tr), focusMinutes: 0 };
    out.push(row);
    byKey.set(row.date, row);
  }
  const secByKey = new Map<string, number>();
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (!key || !byKey.has(key)) continue;
    secByKey.set(key, (secByKey.get(key) ?? 0) + s.plannedSeconds);
  }
  for (const [key, sec] of secByKey) byKey.get(key)!.focusMinutes = Math.round(sec / 60);
  return out;
}

export interface CumulativeStats {
  totalFocusCount: number;
  totalFocusMinutes: number;
  dailyAverageMinutes: number;
  firstFocusDate: string | null; // YYYY-MM-DD of the oldest completed focus session
}

/**
 * 累计统计：全量专注总数/总分钟数与日均（自首个专注日起，或 startDate 起）。
 * 单遍完成过滤/求和/最早日期（P-perf）；daysElapsed 下限 1 防除零。
 *
 * @param sessions - 全量会话记录。
 * @param now - 参考当前时间。
 * @param startDate - 可选窗口起点（YYYY-MM-DD 本地日），早于它的会话剔除，
 *                    日均按该日起算；null/undefined 时从最早记录起算。
 * @returns {@link CumulativeStats}。O(n)。
 */
export function cumulativeStats(
  sessions: PomodoroSessionRecord[],
  now: Date,
  startDate?: string | null,
  vmHour = 0
): CumulativeStats {
  // 非法 startDate（解析失败）视为未设置窗口——与 parseDateKey 失败回退语义一致。
  const startKey = startDate && parseDateKey(startDate) ? startDate : null;
  let totalFocusCount = 0;
  let totalFocusSeconds = 0;
  let firstFocusDate: string | null = null;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    // 归日/窗口过滤都用起始时刻的虚拟日键（键为 YYYY-MM-DD，可按字典序
    // 与 startDate 比较），与 SQL 聚合同口径。
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (!key) continue;
    if (startKey !== null && key < startKey) continue;
    if (s.completed) totalFocusCount++;
    totalFocusSeconds += s.plannedSeconds;
    if (firstFocusDate === null || key < firstFocusDate) firstFocusDate = key;
  }
  const totalFocusMinutes = Math.round(totalFocusSeconds / 60);
  let daysElapsed = 1;
  const anchorDate = startDate ?? firstFocusDate;
  if (anchorDate) {
    const anchor = parseDateKey(anchorDate);
    if (anchor) {
      // 日历日差而非毫秒差：DST 调整日 anchor 与 now 之间差 23/25 小时，
      // 直接毫秒除法会 ±1 天。两侧先取本地零点的 UTC 毫秒（Date.UTC 无
      // DST），差值恒为整天。锚点是自然日键而数据按虚拟日键过滤——首日
      // 0–H 点的段归前一虚拟日被排除在窗口外，属「按起始虚拟日归属」的
      // 一致代价，不做偏移补偿。
      const anchorDay = Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      daysElapsed = Math.max(1, Math.round((nowDay - anchorDay) / 86_400_000) + 1);
    }
  }
  return {
    totalFocusCount,
    totalFocusMinutes,
    dailyAverageMinutes: Math.round(totalFocusMinutes / daysElapsed),
    firstFocusDate
  };
}

/** Parses a YYYY-MM-DD key as a local midnight Date; invalid input → null. */
function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 今日判定（口径统一）：vmHour>0 时按「虚拟午夜」切日——内存侧的
 * 「今日」与 SQL 聚合（aggregateSessions(virtualMidnightHour)）归日一致，
 * 否则 vmHour=4 时 00:00-04:00 结束的段会与热图/月度统计分属两天。 */
export function isSameVirtualDay(a: Date, b: Date, vmHour = 0): boolean {
  if (vmHour <= 0) return isSameDay(a, b);
  return virtualDayKey(a, vmHour) === virtualDayKey(b, vmHour);
}

/** 今日（vmHour>0 按虚拟午夜）**开始**的打断总次数。O(n)。
 *  归日锚点从 endedAt 改为 startedAt——与会话侧「按起始
 *  虚拟日归组」的统一规则一致（跨午夜打断不再记入次日），且与 Rust
 *  monthly_breakdown 同口径。 */
export function todayInterruptions(interruptions: PomodoroInterruption[], now: Date, vmHour = 0): number {
  const todayKey = virtualDayKey(now, vmHour);
  let count = 0;
  for (const i of interruptions) {
    const started = new Date(i.startedAt);
    if (Number.isNaN(started.getTime())) continue;
    if (virtualDayKey(started, vmHour) === todayKey) count++;
  }
  return count;
}

/** 今日被中断放弃（未达计划时长且未标记完成）的专注轮数。
 *  按起始时刻的虚拟日归属（与 Rust 聚合同口径；endedAt 归日会把
 *  跨午夜放弃段记入次日）。 */
export function todayGiveUpCount(sessions: PomodoroSessionRecord[], now: Date, vmHour = 0): number {
  const todayKey = virtualDayKey(now, vmHour);
  let count = 0;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    // A focus segment that ended before its planned duration and was not
    // marked complete counts as an abandoned / give-up session.
    if (s.completed) continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (key === todayKey) count++;
  }
  return count;
}

/** 月热图单元格：日期键 + 日号 + 当日专注分钟 + 是否今天。 */
export interface HeatCell {
  date: string; // YYYY-MM-DD
  day: number; // 1-31
  focusMinutes: number;
  isToday: boolean;
}

/**
 * Per-day focus minutes for the given month, laid out week-by-week (Sunday-led
 * rows) for a GitHub-style contribution heatmap. Pure and timezone-consistent.
 */
export function monthlyHeatmap(sessions: PomodoroSessionRecord[], now: Date, vmHour = 0): HeatCell[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // （isToday 虚拟化）：格子按虚拟日键归属数据，「今天」高亮也按 now 的
  // 虚拟日键比较——vmHour>0 的 00:00–H 点间数据落在昨日格，高亮圈必须
  // 跟着落在昨日格（此前按自然日比较，高亮圈套在空格上）。
  const vTodayKey = virtualDayKey(now, vmHour);
  const cells: HeatCell[] = [];
  // P-perf：与 dailyTrend 同法，Map 索引替代逐会话 cells.find（O(n×31)→O(n+31)）。
  const byKey = new Map<string, HeatCell>();
  for (let d = 1; d <= daysInMonth; d++) {
    const cell: HeatCell = {
      date: toDateKey(new Date(year, month, d)),
      day: d,
      focusMinutes: 0,
      isToday: false
    };
    cells.push(cell);
    byKey.set(cell.date, cell);
  }
  const todayCell = byKey.get(vTodayKey);
  if (todayCell) todayCell.isToday = true;
  const secByKey = new Map<string, number>();
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (!key || !byKey.has(key)) continue;
    secByKey.set(key, (secByKey.get(key) ?? 0) + s.plannedSeconds);
  }
  for (const [key, sec] of secByKey) byKey.get(key)!.focusMinutes = Math.round(sec / 60);
  return cells;
}

/** Focus minutes in the current month (口径：含未完成段；vmHour>0 按虚拟日归属月)。 */
export function monthFocusMinutes(sessions: PomodoroSessionRecord[], now: Date, vmHour = 0): number {
  const prefix = monthPrefix(now);
  let seconds = 0;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (key?.startsWith(prefix)) seconds += s.plannedSeconds;
  }
  return Math.round(seconds / 60);
}

/** Completed focus sessions in the current month（虚拟日归属月）。 */
export function monthFocusCount(sessions: PomodoroSessionRecord[], now: Date, vmHour = 0): number {
  const prefix = monthPrefix(now);
  let count = 0;
  for (const s of sessions) {
    if (s.type !== "focus" || !s.completed) continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (key?.startsWith(prefix)) count++;
  }
  return count;
}

/** 当前自然月的 `YYYY-MM` 前缀（虚拟日键可直接按前缀归属月）。 */
function monthPrefix(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/* ---- 任务用时归集 ---- */

export interface TaskFocusAgg {
  /** 展示名：任务标题或自定义事件名。 */
  label: string;
  /** 关联 id（taskId / 自定义标签原文）；无归属会话不计入。 */
  key: string;
  focusMinutes: number;
  sessions: number;
}

/**
 * 按专注事件（待办 / 自定义事件）聚合完成专注时长，降序返回。
 * taskTitle 用于把 taskId 解析成可读标题（任务可能已删除，缺省回退 id）。
 */
export function taskFocusBreakdown(
  sessions: PomodoroSessionRecord[],
  resolveTitle: (taskId: string) => string | undefined
): TaskFocusAgg[] {
  const map = new Map<string, { label: string; key: string; seconds: number; sessions: number }>();
  for (const s of sessions) {
    if (s.type !== "focus" || !s.completed) continue;
    const key = s.taskId ?? (s.eventLabel ? `label:${s.eventLabel}` : null);
    if (!key) continue;
    const label = s.taskId ? (resolveTitle(s.taskId) ?? s.eventLabel ?? s.taskId) : (s.eventLabel as string);
    const agg = map.get(key) ?? { label, key, seconds: 0, sessions: 0 };
    // 秒累计、出口一次 round，与 SQL 聚合一致。
    agg.seconds += s.plannedSeconds;
    agg.sessions += 1;
    map.set(key, agg);
  }
  return [...map.values()]
    .map(({ label, key, seconds, sessions }) => ({ label, key, focusMinutes: Math.round(seconds / 60), sessions }))
    .sort((a, b) => b.focusMinutes - a.focusMinutes);
}

/* ---- 周/月目标与连胜 ---- */

export interface WeekStats {
  focusMinutes: number;
  focusCount: number;
}

/** 本周（周一起算）专注合计；vmHour>0 时片按虚拟日键归属，与 weekStatsFromAgg
 *  对虚拟日聚合键做自然周键比较的口径一致。 */
export function weekStats(sessions: PomodoroSessionRecord[], now: Date, vmHour = 0): WeekStats {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const startKey = toDateKey(start);
  let focusSeconds = 0;
  let focusCount = 0;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (!key || key < startKey) continue;
    focusSeconds += s.plannedSeconds;
    if (s.completed) focusCount += 1;
  }
  return { focusMinutes: Math.round(focusSeconds / 60), focusCount };
}

/**
 * 连续达标天数：从今天往回数，每日完成专注轮数 ≥ goal 即达标；
 * 今天尚未达标不打断连胜（从昨天起算），goal ≤ 0 恒为 0。
 * 分钟指标含未完成段（口径），轮数只计完成段；vmHour>0 按虚拟日键归属。
 */
export function goalStreakDays(
  sessions: PomodoroSessionRecord[],
  goal: number,
  now: Date,
  metric: "sessions" | "minutes" = "sessions",
  vmHour = 0
): number {
  if (goal <= 0) return 0;
  const countPerDay = new Map<string, number>();
  const secPerDay = new Map<string, number>();
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    // 按轮数达标时只认已完成的段；按分钟达标时部分时长照计。
    if (metric === "sessions" && !s.completed) continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (!key) continue;
    countPerDay.set(key, (countPerDay.get(key) ?? 0) + (s.completed ? 1 : 0));
    secPerDay.set(key, (secPerDay.get(key) ?? 0) + s.plannedSeconds);
  }
  const dayValue = (key: string): number =>
    metric === "minutes" ? Math.round((secPerDay.get(key) ?? 0) / 60) : (countPerDay.get(key) ?? 0);
  let streak = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  // 今天未达标不中断连胜：先检查今天，未达标则从昨天开始累计。
  if (dayValue(toDateKey(cursor)) >= goal) {
    streak += 1;
  }
  cursor.setDate(cursor.getDate() - 1);
  while (dayValue(toDateKey(cursor)) >= goal) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
    if (streak > 3650) break; // 数据异常保护
  }
  return streak;
}

/** Interruption counts for the current month, sorted by count descending.
 *  vmHour>0 时按打断**开始时刻**的虚拟日归属月（与会话侧按起始归日的
 *  统一规则一致）。 */
export function monthlyInterruptionBreakdown(
  interruptions: PomodoroInterruption[],
  now: Date,
  vmHour = 0
): { reason: string; count: number }[] {
  const prefix = monthPrefix(now);
  const map = new Map<string, number>();
  for (const i of interruptions) {
    const started = new Date(i.startedAt);
    if (Number.isNaN(started.getTime())) continue;
    if (!virtualDayKey(started, vmHour).startsWith(prefix)) continue;
    map.set(i.reason, (map.get(i.reason) ?? 0) + 1);
  }
  return [...map.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

export interface YearMonthLabel {
  label: string; // "1月"
  startWeek: number; // 0-based week column where the month begins
  span: number; // number of week columns the month occupies
}

export interface YearWeekGrid {
  weeks: (HeatCell | null)[][]; // [weekday 0-6 (Sun first)][week 0..]
  monthLabels: YearMonthLabel[];
  totalWeeks: number;
}

/**
 * GitHub-style yearly contribution grid: 7 weekday rows (Sun first) × week
 * columns for the whole calendar year. Dates flow left-to-right by week;
 * month labels span the week columns they occupy. Pure and timezone-consistent
 * with `monthlyHeatmap`. `byDate` maps a local date key to focus minutes.
 */
function buildYearGrid(
  byDate: Map<string, number>,
  year: number,
  tr: (s: string) => string,
  now: Date = new Date(),
  vmHour = 0
): YearWeekGrid {
  const jan1 = new Date(year, 0, 1);
  const startWeekday = jan1.getDay(); // 0 = Sunday
  const dec31 = new Date(year, 11, 31);
  const totalDays = Math.round((dec31.getTime() - jan1.getTime()) / 86400000) + 1;
  const totalWeeks = Math.ceil((startWeekday + totalDays) / 7);
  // （isToday 虚拟化 + 纯度）：today 圈按 now 的虚拟日键比较（与月热图
  // 同口径）；now 由调用方显式传入（年视图的「今日圈」才能随跨日重算）。
  const vTodayKey = virtualDayKey(now, vmHour);

  const weeks: (HeatCell | null)[][] = Array.from({ length: 7 }, () => Array<HeatCell | null>(totalWeeks).fill(null));
  // 当前年的未来格子不渲染数据（系统时间回拨会产出晚于今天的日期
  // 键），历史年视图不受影响。buildYearGrid 为内存/SQL 两条路径共用。
  const capFuture = year === now.getFullYear();
  for (let d = 0; d < totalDays; d++) {
    const date = new Date(year, 0, 1 + d);
    const key = toDateKey(date);
    const idx = startWeekday + d;
    const weekday = idx % 7;
    const week = Math.floor(idx / 7);
    weeks[weekday][week] = {
      date: key,
      day: date.getDate(),
      focusMinutes: capFuture && key > vTodayKey ? 0 : (byDate.get(key) ?? 0),
      isToday: key === vTodayKey
    };
  }

  const monthLabels: YearMonthLabel[] = [];
  for (let m = 0; m < 12; m++) {
    const firstDay = new Date(year, m, 1);
    const idx = startWeekday + Math.round((firstDay.getTime() - jan1.getTime()) / 86400000);
    const startWeek = Math.floor(idx / 7);
    const nextFirst = new Date(year, m + 1, 1);
    const nextIdx = startWeekday + Math.round((nextFirst.getTime() - jan1.getTime()) / 86400000);
    const endWeek = Math.max(startWeek, Math.floor((nextIdx - 1) / 7));
    monthLabels.push({ label: `${m + 1}${tr("月")}`, startWeek, span: endWeek - startWeek + 1 });
  }

  return { weeks, monthLabels, totalWeeks };
}

export function yearGrid(
  sessions: PomodoroSessionRecord[],
  year: number,
  tr: (s: string) => string = t,
  vmHour = 0,
  now: Date = new Date()
): YearWeekGrid {
  const secByDate = new Map<string, number>();
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const key = virtualDayKeyOfStarted(s, vmHour);
    if (!key) continue;
    secByDate.set(key, (secByDate.get(key) ?? 0) + s.plannedSeconds);
  }
  const byDate = new Map<string, number>();
  for (const [key, sec] of secByDate) byDate.set(key, Math.round(sec / 60));
  return buildYearGrid(byDate, year, tr, now, vmHour);
}

/* ---- SQLite 聚合口径 ---- */

export interface DailyFocusAgg {
  date: string; // YYYY-MM-DD (local)
  focusSeconds: number;
  focusCount: number;
}

export interface FocusAggregate {
  daily: DailyFocusAgg[];
}

function dailyFocusMap(agg: FocusAggregate): Map<string, DailyFocusAgg> {
  const m = new Map<string, DailyFocusAgg>();
  for (const d of agg.daily) m.set(d.date, d);
  return m;
}

/** 累计统计（全量，替代 session 口径的 `cumulativeStats`，突破 SESSIONS_CAP）。 */
export function cumulativeStatsFromAgg(agg: FocusAggregate, now: Date, startDate?: string | null): CumulativeStats {
  const startMs = startDate ? (parseDateKey(startDate)?.getTime() ?? null) : null;
  let totalFocusCount = 0;
  let totalFocusSeconds = 0;
  let firstFocusDate: string | null = null;
  for (const d of agg.daily) {
    if (startMs !== null) {
      const dt = parseDateKey(d.date);
      if (!dt || dt.getTime() < startMs) continue;
    }
    totalFocusCount += d.focusCount;
    totalFocusSeconds += d.focusSeconds;
    if (firstFocusDate === null || d.date < firstFocusDate) firstFocusDate = d.date;
  }
  const totalFocusMinutes = Math.round(totalFocusSeconds / 60);
  let daysElapsed = 1;
  const anchorDate = startDate ?? firstFocusDate;
  if (anchorDate) {
    const anchor = parseDateKey(anchorDate);
    // 同 cumulativeStatsFromAgg：日历日差（本地零点 UTC 毫秒差，DST 日不漂移）。
    if (anchor) {
      const anchorDay = Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      daysElapsed = Math.max(1, Math.round((nowDay - anchorDay) / 86_400_000) + 1);
    }
  }
  return {
    totalFocusCount,
    totalFocusMinutes,
    dailyAverageMinutes: Math.round(totalFocusMinutes / daysElapsed),
    firstFocusDate
  };
}

/** 当前自然月的专注分钟数与轮数（全量口径）。 */
export function monthTotalFromAgg(agg: FocusAggregate, now: Date): { minutes: number; count: number } {
  const year = now.getFullYear();
  const month = now.getMonth();
  let seconds = 0;
  let count = 0;
  for (const d of agg.daily) {
    const dt = parseDateKey(d.date);
    if (!dt || dt.getFullYear() !== year || dt.getMonth() !== month) continue;
    seconds += d.focusSeconds;
    count += d.focusCount;
  }
  return { minutes: Math.round(seconds / 60), count };
}

/** 本周专注合计（全量口径，替代 `weekStats`）。
 *  口径相容性论证（复核确认非缺陷）：agg 键是虚拟日键——它本身就是日历
 *  日期串，所以与「自然周一起点键」直接比较是自洽的：虚拟归属把周一
 *  00:00–H:00 的段归虚拟周日（上周），本周窗口从虚拟周一（与自然周一
 *  同一键）起算，两者不冲突。 */
export function weekStatsFromAgg(agg: FocusAggregate, now: Date): WeekStats {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const startKey = toDateKey(start);
  let focusSeconds = 0;
  let focusCount = 0;
  for (const d of agg.daily) {
    if (d.date < startKey) continue;
    focusSeconds += d.focusSeconds;
    focusCount += d.focusCount;
  }
  return { focusMinutes: Math.round(focusSeconds / 60), focusCount };
}

/** 连续达标天数（全量口径，替代 `goalStreakDays`）。 */
export function goalStreakDaysFromAgg(
  agg: FocusAggregate,
  goal: number,
  now: Date,
  metric: "sessions" | "minutes" = "sessions"
): number {
  if (goal <= 0) return 0;
  const byDay = dailyFocusMap(agg);
  const dayValue = (key: string): number => {
    const d = byDay.get(key);
    if (!d) return 0;
    return metric === "minutes" ? Math.round(d.focusSeconds / 60) : d.focusCount;
  };
  let streak = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  const todayKey = toDateKey(cursor);
  if (dayValue(todayKey) >= goal) streak += 1;
  cursor.setDate(cursor.getDate() - 1);
  while (dayValue(toDateKey(cursor)) >= goal) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
    if (streak > 3650) break;
  }
  return streak;
}

/** 当月热图（全量口径，替代 `monthlyHeatmap`）。
 *  （isToday 虚拟化）：today 圈按 now 的虚拟日键比较，vmHour>0 的凌晨
 *  时段数据落昨日格、圈也套昨日格，与数据归属一致。 */
export function monthlyHeatmapFromAgg(agg: FocusAggregate, now: Date, vmHour = 0): HeatCell[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = dailyFocusMap(agg);
  const vTodayKey = virtualDayKey(now, vmHour);
  const cells: HeatCell[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = toDateKey(new Date(year, month, d));
    const cell = byDay.get(key);
    cells.push({
      date: key,
      day: d,
      // 未来日不渲染数据（与年视图 buildYearGrid 的封顶口径一致）。
      focusMinutes: cell && key <= vTodayKey ? Math.round(cell.focusSeconds / 60) : 0,
      isToday: key === vTodayKey
    });
  }
  return cells;
}

/** 年度热图（全量口径，替代 `yearGrid`）。
 *  now 由调用方显式传入——「今日圈」随跨日/跨虚拟午夜重算（此前用
 *  函数体内的 new Date()，memo 不重算圈就停在挂载日）。 */
export function yearGridFromAgg(
  agg: FocusAggregate,
  year: number,
  tr: (s: string) => string = t,
  now: Date = new Date(),
  vmHour = 0
): YearWeekGrid {
  const byDate = new Map<string, number>();
  const prefix = `${year}-`;
  for (const d of agg.daily) {
    if (d.date.startsWith(prefix)) byDate.set(d.date, Math.round(d.focusSeconds / 60));
  }
  return buildYearGrid(byDate, year, tr, now, vmHour);
}

/**
 * Lays a month's days into a calendar grid: rows = weeks, columns = 7 weekdays
 * (Sun first). grid[week][weekday] holds the day's cell or null for empty slots.
 */
export function monthCalendarGrid(year: number, month: number, cells: HeatCell[]): (HeatCell | null)[][] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const weeks = Math.ceil((firstWeekday + cells.length) / 7);
  const grid: (HeatCell | null)[][] = Array.from({ length: weeks }, () => Array<HeatCell | null>(7).fill(null));
  cells.forEach((cell, i) => {
    const idx = firstWeekday + i;
    grid[Math.floor(idx / 7)][idx % 7] = cell;
  });
  return grid;
}

/* ---------------- 跨午夜切分 / 虚拟午夜 / 小时分布 ---------------- */

/**
 * 「虚拟午夜」日界线小时（0/2/4）：0 = 自然午夜；2/4 = 熬夜用户的「今天」
 * 延续到凌晨 2/4 点。与 Rust aggregate 的切分口径一一对应。
 */
export type VirtualMidnightHour = 0 | 2 | 4;

/** 把本地时间归到所属「虚拟日」的 YYYY-MM-DD 键：时刻减去 H 小时后取日期。 */
export function virtualDayKey(d: Date, hour: number): string {
  const shifted = new Date(d.getTime() - hour * 3_600_000);
  return toDateKey(shifted);
}

/** （归日唯一入口）：会话/片归属的虚拟日键 = 起始时刻的虚拟日；无效时间返回 null。 */
function virtualDayKeyOfStarted(s: Pick<PomodoroSessionRecord, "startedAt">, vmHour: number): string | null {
  const started = new Date(s.startedAt);
  if (Number.isNaN(started.getTime())) return null;
  return virtualDayKey(started, vmHour);
}

interface DayPiece {
  /** 所属虚拟日键。 */
  dayKey: string;
  /** 该片起始时刻。 */
  start: Date;
  /** 该片结束时刻（含）。 */
  end: Date;
  /** 按墙钟占比分摊到的秒数（末片吸收取整余量）。 */
  seconds: number;
  /** 是否为最后一片（末片吸收取整余量；轮数/完成计数只落在**首片**）。 */
  last: boolean;
}

/**
 * 把一段会话在「虚拟午夜」边界切分为多片（ split-at-midnight）。
 * 时间无效 / end ≤ start / 秒数 ≤0 返回空数组。
 *
 * @param startedAt - ISO 起始时间。
 * @param endedAt - ISO 结束时间。
 * @param totalSeconds - 该段总专注秒数（按各片墙钟时长占比分摊）。
 * @param hour - 虚拟午夜小时（0/2/4）。
 * @returns 时间有序的分片列表。
 */
export function splitSessionAcrossDays(
  startedAt: string,
  endedAt: string,
  totalSeconds: number,
  hour: number
): DayPiece[] {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (end.getTime() <= start.getTime() || !(totalSeconds > 0)) return [];

  // 收集 (start, end) 开区间内的全部虚拟午夜边界。逐日**按日历分量重建**
  // 候选时刻（而非 cursor+24h 递增）：DST 缺口日 JS 会把不存在的 H:00
  // 归一化到 H+1，cursor 递增会让后续每天的边界永久漂移一小时；重建则
  // 只影响当天。归一化过的候选（getHours() !== hour）视为该日边界不
  // 存在，跳过——与 Rust midnight_boundaries 的 DST 跳边语义对齐。
  const boundaries: Date[] = [];
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  for (let guard = 0; guard < 800 && day <= lastDay; guard++) {
    const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
    if (cand.getHours() === hour && cand.getTime() > start.getTime() && cand.getTime() < end.getTime()) {
      boundaries.push(cand);
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }

  const pieces: DayPiece[] = [];
  const totalMs = end.getTime() - start.getTime();
  let allocated = 0;
  let prev = start;
  for (let i = 0; i <= boundaries.length; i++) {
    const pieceEnd = i < boundaries.length ? boundaries[i] : end;
    const last = i === boundaries.length;
    const seconds = last
      ? Math.max(0, totalSeconds - allocated)
      : Math.floor((totalSeconds * (pieceEnd.getTime() - prev.getTime())) / totalMs);
    allocated += last ? 0 : seconds;
    pieces.push({ dayKey: virtualDayKey(prev, hour), start: prev, end: pieceEnd, seconds, last });
    prev = pieceEnd;
  }
  return pieces;
}

/**
 * 把会话列表按虚拟午夜切成「片会话」（每片都在单个虚拟日内，plannedSeconds
 * 为分摊值），供既有的按 endedAt 归日统计函数直接消费——内存口径（浏览器
 * 模式 / SQL 聚合失败回退）由此与 Rust 聚合的切分口径对齐。
 *
 * @param sessions - 全量会话记录。
 * @param hour - 虚拟午夜小时（0/2/4）。
 * @returns 切分后的记录（id 加 `#n` 后缀保 key 唯一；单片会话原样返回）。
 */
export function splitSessionsByDay(sessions: PomodoroSessionRecord[], hour: number): PomodoroSessionRecord[] {
  if (
    hour === 0 &&
    sessions.every((s) => new Date(s.startedAt).toDateString() === new Date(s.endedAt).toDateString())
  ) {
    return sessions; // 快路径：无跨日段且 H=0，免分配
  }
  const out: PomodoroSessionRecord[] = [];
  for (const s of sessions) {
    const pieces = splitSessionAcrossDays(s.startedAt, s.endedAt, s.plannedSeconds, hour);
    if (pieces.length <= 1) {
      out.push(s);
      continue;
    }
    pieces.forEach((p, i) => {
      out.push({
        ...s,
        id: `${s.id}#${i}`,
        startedAt: p.start.toISOString(),
        endedAt: p.end.toISOString(),
        plannedSeconds: p.seconds,
        // 轮数只落首片（与 Rust aggregate 的 i==0 口径一致）——此前
        // completed 随 ...s 传播到每片，跨午夜完成段在内存路径两天各计 1 轮，
        // 与 SQL 路径（仅首片）互相矛盾。
        completed: i === 0 && s.completed
      });
    });
  }
  return out;
}

/** 每小时专注分布的一格（hour 为本地 0-23 小时）。 */
export interface HourlyFocusBucket {
  hour: number;
  focusSeconds: number;
  focusCount: number;
}

/**
 * 24 小时时段分布（内存口径）：把专注会话按小时边界切分后分摊秒数；
 * 轮数落在该段结束时刻所在的小时（与 Rust 聚合同口径，避免跨小时重复计数）。
 *  零时长旧行（startedAt == endedAt，或秒数 ≤0）与 Rust 侧 legacy 分支
 *  对齐：秒数 max(0) 计入结束小时、计次不分 completed（与 inline
 *  实现及 口径同步的 JSDoc 修正——此前此句仍写「完成则计次」）。
 *
 * @param sessions - 全量会话记录。
 * @returns 长度 24 的分布（0-23 点，无数据的桶为 0）。
 */
export function hourlyFocusDistribution(sessions: PomodoroSessionRecord[]): HourlyFocusBucket[] {
  const buckets: HourlyFocusBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    focusSeconds: 0,
    focusCount: 0
  }));
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const pieces = splitAcrossHours(s.startedAt, s.endedAt, s.plannedSeconds);
    if (pieces.length === 0) {
      // 与 Rust hourly_distribution 的零时长/零秒兼容分支同口径：秒数
      // max(0) 计入结束小时；计次与正常行一致（该小时结束过的段数，不分
      // completed——此前此处仅 completed 计次而 Rust 不分，两条路径
      // 的 focusCount 互差）。
      const end = new Date(s.endedAt);
      if (Number.isNaN(end.getTime())) continue;
      buckets[end.getHours()].focusSeconds += Math.max(0, s.plannedSeconds);
      buckets[end.getHours()].focusCount += 1;
      continue;
    }
    for (const p of pieces) buckets[p.hour].focusSeconds += p.seconds;
    buckets[new Date(s.endedAt).getHours()].focusCount += 1;
  }
  return buckets;
}

/** 近 N 天 × 24 小时专注分钟矩阵（ 月页气泡图的数据口径）。 */
export interface DayHourGrid {
  /** 每行的日期键（旧→新，YYYY-MM-DD 本地日）。 */
  dayKeys: string[];
  /** 每行标签（今天 / 星期几），随 tr。 */
  dayLabels: string[];
  /** 每行是否今天。 */
  isToday: boolean[];
  /** cells[i][h] = 第 i 行（天）h 时的专注分钟数。 */
  cells: number[][];
}

/**
 * 把会话按小时边界切分后归入「近 N 天（含今日）× 24 小时」矩阵。
 * 片的起始时刻决定归属日（小时片不跨日，午夜片从次日 0 点起算）。
 *
 * @param sessions - 全量会话记录（仅专注类型计入）。
 * @param now - 参考当前时间（决定今日与窗口）。
 * @param days - 天数（1–30，含今日）。
 * @param tr - 标签翻译函数。
 * @returns {@link DayHourGrid}。
 */
export function dayHourGrid(
  sessions: PomodoroSessionRecord[],
  now: Date,
  days: number,
  tr: (s: string) => string = t,
  vmHour = 0
): DayHourGrid {
  const n = Math.max(1, Math.min(30, Math.round(days)));
  const cells: number[][] = Array.from({ length: n }, () => Array<number>(24).fill(0));
  const dayKeys: string[] = [];
  const keyIndex = new Map<string, number>();
  // 行 = 虚拟日（vmHour=0 即自然日），与 dailyTrend 的行口径一致。
  const curVirtual = new Date(now.getTime() - vmHour * 3_600_000);
  for (let i = 0; i < n; i++) {
    const d = new Date(curVirtual.getFullYear(), curVirtual.getMonth(), curVirtual.getDate() - (n - 1 - i));
    const key = toDateKey(d);
    dayKeys.push(key);
    keyIndex.set(key, i);
  }
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const pieces = splitAcrossHours(s.startedAt, s.endedAt, s.plannedSeconds);
    if (pieces.length === 0) {
      // 零时长旧行与 hourlyFocusDistribution 的 legacy 分支同口径——
      // 计入结束时刻所在的（虚拟日, 小时）格，不再整段丢弃（此前同一批
      // 旧行在累计小时分布里出现、在气泡矩阵里消失）。
      const end = new Date(s.endedAt);
      if (Number.isNaN(end.getTime())) continue;
      const row = keyIndex.get(virtualDayKey(end, vmHour));
      if (row !== undefined) cells[row][end.getHours()] += Math.max(0, s.plannedSeconds);
      continue;
    }
    for (const p of pieces) {
      const row = keyIndex.get(virtualDayKey(p.start, vmHour));
      if (row !== undefined) cells[row][p.hour] += p.seconds;
    }
  }
  // 秒 → 分钟（四舍五入；单格误差 ≤30s，可接受）。
  for (const row of cells) {
    for (let h = 0; h < 24; h++) row[h] = Math.round(row[h] / 60);
  }
  const todayKey = virtualDayKey(now, vmHour);
  const isToday: boolean[] = dayKeys.map((key) => key === todayKey);
  const dayLabels = dayKeys.map((key, i) => {
    if (isToday[i]) return tr("今天");
    const d = parseDateKey(key);
    return d ? weekdayLabel(d, tr) : key;
  });
  return { dayKeys, dayLabels, isToday, cells };
}

/** 按本地小时边界切一段时长：返回 (片起始, 小时, 秒) 分摊（末段吸收余量）。
 *  片不跨日——午夜片从次日 0 点起算，故片起始时刻可安全归属到某一天。 */
function splitAcrossHours(
  startedAt: string,
  endedAt: string,
  totalSeconds: number
): { start: Date; hour: number; seconds: number }[] {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (end.getTime() <= start.getTime() || !(totalSeconds > 0)) return [];
  const boundaries: Date[] = [];
  // 按绝对时长推进（与 Rust hour_boundaries 的 Duration::hours(1) 同
  // 口径）——墙钟 setHours(+1) 在 DST 换钟夜会重复/跳过本地小时标签，两条
  // 路径的分桶可差一小时（splitSessionAcrossDays 已改日历重建，此处同步）。
  // 首个边界取**本地整点**截断再绝对 +1h（对齐 Rust 的
  // with_minute(0)/with_second(0) 起步）——此前按 UTC 整点对齐，半时区偏移
  // （UTC+5:30 类）下本地边界落在 :30，与 SQL 路径的本地整点分桶不一致。
  const startHourLocal = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
  let boundaryMs = startHourLocal.getTime() + 3_600_000;
  while (boundaryMs < end.getTime()) {
    boundaries.push(new Date(boundaryMs));
    boundaryMs += 3_600_000;
  }
  const out: { start: Date; hour: number; seconds: number }[] = [];
  const totalMs = end.getTime() - start.getTime();
  let allocated = 0;
  let prev = start;
  for (let i = 0; i <= boundaries.length; i++) {
    const pieceEnd = i < boundaries.length ? boundaries[i] : end;
    const last = i === boundaries.length;
    const seconds = last
      ? Math.max(0, totalSeconds - allocated)
      : Math.floor((totalSeconds * (pieceEnd.getTime() - prev.getTime())) / totalMs);
    allocated += last ? 0 : seconds;
    out.push({ start: prev, hour: prev.getHours(), seconds });
    prev = pieceEnd;
  }
  return out;
}
