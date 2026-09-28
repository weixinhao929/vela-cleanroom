import type { PomodoroInterruption, PomodoroSessionRecord } from "./pomodoro";
import { t } from "../i18n-lite";

/**
 * 专注统计领域层：把番茄钟会话/打断记录聚合为统计面板所需的各种口径。
 * 全部纯函数、无副作用，可用固定时间戳单测；「今天」= 当前日历日，
 * 「本周」= 周一起。n 为会话数，d 为桶数（趋势 ≤30 / 热图 = 当月天数）。
 */

/** 一段时间窗（日/周）内的专注计数与分钟聚合。 */
export interface DayStats {
  focusCount: number;
  focusMinutes: number;
  totalCount: number;
}

/** 今日 + 本周两窗口的统计快照。 */
export interface SessionStats {
  today: DayStats;
  week: DayStats;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1; // shift to Monday
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
}

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

const empty: DayStats = { focusCount: 0, focusMinutes: 0, totalCount: 0 };

/**
 * 单遍聚合今日与本周的专注统计。
 *
 * @param sessions - 全量会话记录（含非专注类型）。
 * @param now - 参考当前时间（决定「今天/本周」边界）。
 * @returns 两窗口统计；无效时间戳的会话跳过。O(n)。
 *
 * @example
 * ```ts
 * const { today, week } = computeStats(sessions, new Date());
 * ```
 */
export function computeStats(sessions: PomodoroSessionRecord[], now: Date): SessionStats {
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const today: DayStats = { ...empty };
  const week: DayStats = { ...empty };

  // 口径（与 PomodoroPanel A-36 一致）：**轮数只计已完成**——中断放弃会补落
  // completed:false 的段（app-store.interruptPomodoro），此前一并计入轮数，
  // 连续启动-放弃即可"达成每日目标"；**分钟数**仍含部分时长（中断段的
  // plannedSeconds 写的是实际专注秒数）。下同。
  for (const s of sessions) {
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    const minutes = Math.round(s.plannedSeconds / 60);

    if (ended >= weekStart) {
      week.totalCount++;
      if (s.type === "focus") {
        if (s.completed) week.focusCount++;
        week.focusMinutes += minutes;
      }
    }
    if (ended >= todayStart && isSameDay(ended, now)) {
      today.totalCount++;
      if (s.type === "focus") {
        if (s.completed) today.focusCount++;
        today.focusMinutes += minutes;
      }
    }
  }

  return { today, week };
}

export interface DailyTrend {
  date: string; // YYYY-MM-DD (local)
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

/**
 * 最近 7 天（含今日）逐日专注分钟数，旧→新排列。
 * 与 computeStats 同用本地日历日口径；weeklyTrend 是 dailyTrend(…, 7) 的
 * 语义别名。
 *
 * @param sessions - 全量会话记录。
 * @param now - 参考当前时间。
 * @returns 长度 7 的趋势数组。O(n+7)。
 */
export function weeklyTrend(sessions: PomodoroSessionRecord[], now: Date): DailyTrend[] {
  return dailyTrend(sessions, now, 7);
}

/** Per-day focus minutes for the last `days` calendar days (including today).
 *  Pure and side-effect free; used by the analytics widget whose "显示天数"
 *  config controls the trend chart range.
 *  P-perf：桶查找由数组 find（O(n×days)）改为 Map 索引（O(n+days)）。 */
export function dailyTrend(
  sessions: PomodoroSessionRecord[],
  now: Date,
  days: number,
  tr: (s: string) => string = t
): DailyTrend[] {
  const n = Math.max(1, Math.min(30, Math.round(days)));
  const out: DailyTrend[] = [];
  const byKey = new Map<string, DailyTrend>();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const row: DailyTrend = { date: toDateKey(d), label: i === 0 ? tr("今天") : weekdayLabel(d, tr), focusMinutes: 0 };
    out.push(row);
    byKey.set(row.date, row);
  }
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    const day = byKey.get(toDateKey(ended));
    if (day) day.focusMinutes += Math.round(s.plannedSeconds / 60);
  }
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
  startDate?: string | null
): CumulativeStats {
  const startMs = startDate ? (parseDateKey(startDate)?.getTime() ?? null) : null;
  // P-perf：单遍完成过滤/求和/最早日期（此前 filter 一遍 + 再循环一遍，
  // 每个 session 的 endedAt 被 new Date 解析两次）。
  let totalFocusCount = 0;
  let totalFocusMinutes = 0;
  let firstFocusDate: string | null = null;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const tMs = new Date(s.endedAt).getTime();
    if (Number.isNaN(tMs)) continue;
    if (startMs !== null && tMs < startMs) continue;
    if (s.completed) totalFocusCount++;
    totalFocusMinutes += Math.round(s.plannedSeconds / 60);
    const key = toDateKey(new Date(tMs));
    if (firstFocusDate === null || key < firstFocusDate) firstFocusDate = key;
  }
  let daysElapsed = 1;
  const anchorDate = startDate ?? firstFocusDate;
  if (anchorDate) {
    const anchor = parseDateKey(anchorDate);
    if (anchor) {
      daysElapsed = Math.max(1, Math.floor((now.getTime() - anchor.getTime()) / 86_400_000) + 1);
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

/**
 * 按原因聚合打断次数，次数降序排列。
 *
 * @param interruptions - 打断记录数组。
 * @returns `{reason, count}` 数组。O(n log n)（排序主导）。
 */
export function interruptionBreakdown(interruptions: PomodoroInterruption[]): { reason: string; count: number }[] {
  const map = new Map<string, number>();
  for (const i of interruptions) {
    map.set(i.reason, (map.get(i.reason) ?? 0) + 1);
  }
  return [...map.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

/** 今日（本地日历日）结束的打断总次数。O(n)。 */
export function todayInterruptions(interruptions: PomodoroInterruption[], now: Date): number {
  let count = 0;
  for (const i of interruptions) {
    const ended = new Date(i.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (isSameDay(ended, now)) count++;
  }
  return count;
}

/** 今日被中断放弃（未达计划时长且未标记完成）的专注轮数。O(n)。 */
export function todayGiveUpCount(sessions: PomodoroSessionRecord[], now: Date): number {
  let count = 0;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (!isSameDay(ended, now)) continue;
    // A focus segment that ended before its planned duration and was not
    // marked complete counts as an abandoned / give-up session.
    if (!s.completed) count++;
  }
  return count;
}

/** 时长分桶（≤5 / 6-15 / 16-25 / 26-45 / >45 分钟）及各桶计数与分钟合计。 */
export interface DurationBucket {
  label: string; // e.g. "≈25分"
  count: number;
  minutes: number;
}

/**
 * 把已完成的专注会话按计划时长分桶，展示「哪种专注长度最常发生」。
 *
 * @param sessions - 全量会话记录。
 * @returns 桶数组按分钟合计升序。O(n log n)。
 *
 * @example
 * ```ts
 * focusDurationDistribution(sessions); // [{ label: "16-25分", count: 42, minutes: 1050 }, …]
 * ```
 */
export function focusDurationDistribution(sessions: PomodoroSessionRecord[]): DurationBucket[] {
  const buckets = new Map<string, DurationBucket>();
  const step = (label: string) => ({
    label,
    count: 0,
    minutes: 0
  });
  for (const s of sessions) {
    if (s.type !== "focus" || !s.completed) continue;
    const mins = Math.round(s.plannedSeconds / 60);
    let key: string;
    if (mins <= 5) key = t("≤5分");
    else if (mins <= 15) key = t("6-15分");
    else if (mins <= 25) key = t("16-25分");
    else if (mins <= 45) key = t("26-45分");
    else key = t(">45分");
    const b = buckets.get(key) ?? step(key);
    b.count++;
    b.minutes += mins;
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => a.minutes - b.minutes);
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
export function monthlyHeatmap(sessions: PomodoroSessionRecord[], now: Date): HeatCell[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: HeatCell[] = [];
  // P-perf：与 dailyTrend 同法，Map 索引替代逐会话 cells.find（O(n×31)→O(n+31)）。
  const byKey = new Map<string, HeatCell>();
  for (let d = 1; d <= daysInMonth; d++) {
    const cell: HeatCell = {
      date: toDateKey(new Date(year, month, d)),
      day: d,
      focusMinutes: 0,
      isToday: d === now.getDate()
    };
    cells.push(cell);
    byKey.set(cell.date, cell);
  }
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (ended.getFullYear() !== year || ended.getMonth() !== month) continue;
    const cell = byKey.get(toDateKey(ended));
    if (cell) cell.focusMinutes += Math.round(s.plannedSeconds / 60);
  }
  return cells;
}

/** Completed focus minutes in the current month (local calendar). */
export function monthFocusMinutes(sessions: PomodoroSessionRecord[], now: Date): number {
  const year = now.getFullYear();
  const month = now.getMonth();
  let total = 0;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (ended.getFullYear() === year && ended.getMonth() === month) {
      total += Math.round(s.plannedSeconds / 60);
    }
  }
  return total;
}

/** Completed focus sessions in the current month (local calendar). */
export function monthFocusCount(sessions: PomodoroSessionRecord[], now: Date): number {
  const year = now.getFullYear();
  const month = now.getMonth();
  let count = 0;
  for (const s of sessions) {
    if (s.type !== "focus" || !s.completed) continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (ended.getFullYear() === year && ended.getMonth() === month) count++;
  }
  return count;
}

/* ---- W-051 任务用时归集 ---- */

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
  const map = new Map<string, TaskFocusAgg>();
  for (const s of sessions) {
    if (s.type !== "focus" || !s.completed) continue;
    const key = s.taskId ?? (s.eventLabel ? `label:${s.eventLabel}` : null);
    if (!key) continue;
    const label = s.taskId ? (resolveTitle(s.taskId) ?? s.eventLabel ?? s.taskId) : (s.eventLabel as string);
    const agg = map.get(key) ?? { label, key, focusMinutes: 0, sessions: 0 };
    agg.focusMinutes += Math.round(s.plannedSeconds / 60);
    agg.sessions += 1;
    map.set(key, agg);
  }
  return [...map.values()].sort((a, b) => b.focusMinutes - a.focusMinutes);
}

/* ---- W-052 周/月目标与连胜 ---- */

export interface WeekStats {
  focusMinutes: number;
  focusCount: number;
}

/** 本周（周一起算，本地日历）完成专注合计。 */
export function weekStats(sessions: PomodoroSessionRecord[], now: Date): WeekStats {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  let focusMinutes = 0;
  let focusCount = 0;
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime()) || ended < start) continue;
    focusMinutes += Math.round(s.plannedSeconds / 60);
    if (s.completed) focusCount += 1;
  }
  return { focusMinutes, focusCount };
}

/**
 * 连续达标天数：从今天往回数，每日完成专注轮数 ≥ goal 即达标；
 * 今天尚未达标不打断连胜（从昨天起算），goal ≤ 0 恒为 0。
 */
export function goalStreakDays(
  sessions: PomodoroSessionRecord[],
  goal: number,
  now: Date,
  metric: "sessions" | "minutes" = "sessions"
): number {
  if (goal <= 0) return 0;
  const perDay = new Map<string, number>();
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    // 按轮数达标时只认已完成的段；按分钟达标时部分时长照计。
    if (metric === "sessions" && !s.completed) continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    const key = toDateKey(ended);
    const delta = metric === "minutes" ? Math.round(s.plannedSeconds / 60) : 1;
    perDay.set(key, (perDay.get(key) ?? 0) + delta);
  }
  let streak = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  // 今天未达标不中断连胜：先检查今天，未达标则从昨天开始累计。
  if ((perDay.get(toDateKey(cursor)) ?? 0) >= goal) {
    streak += 1;
  }
  cursor.setDate(cursor.getDate() - 1);
  while ((perDay.get(toDateKey(cursor)) ?? 0) >= goal) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
    if (streak > 3650) break; // 数据异常保护
  }
  return streak;
}

/** Interruption counts for the current month, sorted by count descending. */
export function monthlyInterruptionBreakdown(
  interruptions: PomodoroInterruption[],
  now: Date
): { reason: string; count: number }[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const map = new Map<string, number>();
  for (const i of interruptions) {
    const ended = new Date(i.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (ended.getFullYear() !== year || ended.getMonth() !== month) continue;
    map.set(i.reason, (map.get(i.reason) ?? 0) + 1);
  }
  return [...map.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

export interface MonthPoint {
  month: number; // 1-12
  label: string; // "1月"
  focusMinutes: number;
  focusCount: number;
}

/** Focus minutes + count per month across the current year (local calendar). */
export function annualTrend(sessions: PomodoroSessionRecord[], now: Date): MonthPoint[] {
  const year = now.getFullYear();
  const points: MonthPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    points.push({ month: m, label: `${m}${t("月")}`, focusMinutes: 0, focusCount: 0 });
  }
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (ended.getFullYear() !== year) continue;
    const point = points[ended.getMonth()];
    point.focusMinutes += Math.round(s.plannedSeconds / 60);
    if (s.completed) point.focusCount++;
  }
  return points;
}

export interface YearMonthLabel {
  label: string; // "1月"
  startWeek: number; // 0-based week column where the month begins
  span: number; // number of week columns the month occupies
}

export interface YearWeekGrid {
  weeks: (HeatCell | null)[][]; // [weekday 0-6 (Sun first)][week 0..N-1]
  monthLabels: YearMonthLabel[];
  totalWeeks: number;
}

/**
 * GitHub-style yearly contribution grid: 7 weekday rows (Sun first) × week
 * columns for the whole calendar year. Dates flow left-to-right by week;
 * month labels span the week columns they occupy. Pure and timezone-consistent
 * with `monthlyHeatmap`. `byDate` maps a local date key to focus minutes.
 */
function buildYearGrid(byDate: Map<string, number>, year: number, tr: (s: string) => string): YearWeekGrid {
  const now = new Date();
  const jan1 = new Date(year, 0, 1);
  const startWeekday = jan1.getDay(); // 0 = Sunday
  const dec31 = new Date(year, 11, 31);
  const totalDays = Math.round((dec31.getTime() - jan1.getTime()) / 86400000) + 1;
  const totalWeeks = Math.ceil((startWeekday + totalDays) / 7);

  const weeks: (HeatCell | null)[][] = Array.from({ length: 7 }, () => Array<HeatCell | null>(totalWeeks).fill(null));
  for (let d = 0; d < totalDays; d++) {
    const date = new Date(year, 0, 1 + d);
    const key = toDateKey(date);
    const idx = startWeekday + d;
    const weekday = idx % 7;
    const week = Math.floor(idx / 7);
    weeks[weekday][week] = {
      date: key,
      day: date.getDate(),
      focusMinutes: byDate.get(key) ?? 0,
      isToday: now.getFullYear() === year && now.getMonth() === date.getMonth() && now.getDate() === date.getDate()
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

export function yearGrid(sessions: PomodoroSessionRecord[], year: number, tr: (s: string) => string = t): YearWeekGrid {
  const byDate = new Map<string, number>();
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    const ended = new Date(s.endedAt);
    if (Number.isNaN(ended.getTime())) continue;
    if (ended.getFullYear() !== year) continue;
    const key = toDateKey(ended);
    byDate.set(key, (byDate.get(key) ?? 0) + Math.round(s.plannedSeconds / 60));
  }
  return buildYearGrid(byDate, year, tr);
}

/* ---- A-4 SQLite 聚合口径 ---- */

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
    if (anchor) daysElapsed = Math.max(1, Math.floor((now.getTime() - anchor.getTime()) / 86_400_000) + 1);
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

/** 本周专注合计（全量口径，替代 `weekStats`）。 */
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

/** 当月热图（全量口径，替代 `monthlyHeatmap`）。 */
export function monthlyHeatmapFromAgg(agg: FocusAggregate, now: Date): HeatCell[] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = dailyFocusMap(agg);
  const cells: HeatCell[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = toDateKey(new Date(year, month, d));
    const cell = byDay.get(key);
    cells.push({
      date: key,
      day: d,
      focusMinutes: cell ? Math.round(cell.focusSeconds / 60) : 0,
      isToday: d === now.getDate()
    });
  }
  return cells;
}

/** 年度热图（全量口径，替代 `yearGrid`）。 */
export function yearGridFromAgg(agg: FocusAggregate, year: number, tr: (s: string) => string = t): YearWeekGrid {
  const byDate = new Map<string, number>();
  const prefix = `${year}-`;
  for (const d of agg.daily) {
    if (d.date.startsWith(prefix)) byDate.set(d.date, Math.round(d.focusSeconds / 60));
  }
  return buildYearGrid(byDate, year, tr);
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

/* ---------------- FocusTimer 借鉴：跨午夜切分 / 虚拟午夜 / 小时分布 ---------------- */

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

interface DayPiece {
  /** 所属虚拟日键。 */
  dayKey: string;
  /** 该片起始时刻。 */
  start: Date;
  /** 该片结束时刻（含）。 */
  end: Date;
  /** 按墙钟占比分摊到的秒数（末片吸收取整余量）。 */
  seconds: number;
  /** 是否为最后一片（轮数/完成计数只落在最后一片，避免跨日重复计数）。 */
  last: boolean;
}

/**
 * 把一段会话在「虚拟午夜」边界切分为多片（FocusTimer 的 split-at-midnight）。
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

  // 收集 (start, end) 开区间内的全部虚拟午夜边界。
  const boundaries: Date[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour, 0, 0, 0);
  if (hour === 0 && cursor.getTime() <= start.getTime()) cursor.setDate(cursor.getDate() + 1);
  // hour>0 时第一个候选可能已在 start 之前，先推进到 start 之后。
  while (cursor.getTime() <= start.getTime()) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() < end.getTime()) {
    boundaries.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
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
        plannedSeconds: p.seconds
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
    if (pieces.length === 0) continue;
    for (const p of pieces) buckets[p.hour].focusSeconds += p.seconds;
    const endHour = new Date(s.endedAt).getHours();
    if (!Number.isNaN(endHour)) buckets[endHour].focusCount += 1;
  }
  return buckets;
}

/** 近 N 天 × 24 小时专注分钟矩阵（FocusTimer 月页气泡图的数据口径）。 */
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
  tr: (s: string) => string = t
): DayHourGrid {
  const n = Math.max(1, Math.min(30, Math.round(days)));
  const cells: number[][] = Array.from({ length: n }, () => Array<number>(24).fill(0));
  const dayKeys: string[] = [];
  const keyIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i));
    const key = toDateKey(d);
    dayKeys.push(key);
    keyIndex.set(key, i);
  }
  for (const s of sessions) {
    if (s.type !== "focus") continue;
    for (const p of splitAcrossHours(s.startedAt, s.endedAt, s.plannedSeconds)) {
      const row = keyIndex.get(toDateKey(p.start));
      if (row !== undefined) cells[row][p.hour] += p.seconds;
    }
  }
  // 秒 → 分钟（四舍五入；单格误差 ≤30s，可接受）。
  for (const row of cells) {
    for (let h = 0; h < 24; h++) row[h] = Math.round(row[h] / 60);
  }
  const isToday: boolean[] = dayKeys.map((key) => key === toDateKey(now));
  const dayLabels = dayKeys.map((_, i) => {
    if (isToday[i]) return tr("今天");
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i));
    return weekdayLabel(d, tr);
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
  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(cursor.getHours() + 1);
  while (cursor.getTime() < end.getTime()) {
    boundaries.push(new Date(cursor));
    cursor.setHours(cursor.getHours() + 1);
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
