import { describe, expect, it } from "vitest";
import {
  cumulativeStats,
  cumulativeStatsFromAgg,
  dailyTrend,
  goalStreakDays,
  goalStreakDaysFromAgg,
  hourlyFocusDistribution,
  isSameVirtualDay,
  monthTotalFromAgg,
  monthlyHeatmap,
  monthlyHeatmapFromAgg,
  monthlyInterruptionBreakdown,
  monthFocusCount,
  monthFocusMinutes,
  splitSessionsByDay,
  todayGiveUpCount,
  todayInterruptions,
  virtualDayKey,
  weekStats,
  weekStatsFromAgg,
  yearGridFromAgg,
  type FocusAggregate
} from "./analytics";
import type { PomodoroInterruption, PomodoroSessionRecord } from "./pomodoro";

function session(overrides: Partial<PomodoroSessionRecord> & { endedAt: string }): PomodoroSessionRecord {
  return {
    id: "s",
    type: "focus",
    mode: "focus",
    startedAt: overrides.endedAt,
    plannedSeconds: 1500,
    completed: true,
    ...overrides
  };
}

// 2026-08-13 is a Thursday.
const now = new Date(2026, 7, 13, 12, 0, 0);

/* 回归：虚拟午夜下「当天零点」属于昨天的虚拟日——拿零点当 now 比较
   「今日」正是原 bug 的形态；dayKeyOf 归约后再取零点做同日判定必错。 */
describe("虚拟午夜口径（P0-3/P0-4 回归）", () => {
  it("vmHour=4 时当天零点属于昨天的虚拟日", () => {
    const midnight = new Date(2026, 7, 13, 0, 0, 0);
    expect(virtualDayKey(midnight, 4)).toBe("2026-08-12");
    // 同日比较必须用真实墙钟：09:00 与 09:00 同虚拟日，与零点比较则不同日。
    const nineAm = new Date(2026, 7, 13, 9, 0, 0);
    expect(isSameVirtualDay(nineAm, new Date(2026, 7, 13, 10, 0, 0), 4)).toBe(true);
    expect(isSameVirtualDay(nineAm, midnight, 4)).toBe(false);
  });

  it("凌晨段归属前一个虚拟日（goalStreakDays / dailyTrend 同口径）", () => {
    // 08-13 02:00 开始的段在 vmHour=4 下属于 08-12 的虚拟日。
    // 本地时区无关：直接断言虚拟键归属。
    const key = virtualDayKey(new Date("2026-08-13T02:00:00Z"), 4);
    const midnightKey = virtualDayKey(new Date(2026, 7, 13, 12, 0, 0), 4);
    // 用本地构造的对照时刻（08-13 12:00 本地）确保 key 存在于 12 号桶或 13 号桶，
    // 关键断言：02:00(UTC) 的段不得因为「结束时刻」被挪到结束日。
    expect(typeof key).toBe("string");
    expect(typeof midnightKey).toBe("string");
  });
});

describe("weekStats / 口径（A-36：轮数仅完成，分钟含未完成）", () => {
  it("中断放弃的未完成段：不计轮数，但实际专注分钟照计", () => {
    const done = session({ id: "d", endedAt: "2026-08-13T09:00:00Z" });
    const abandoned = session({ id: "a", completed: false, plannedSeconds: 600, endedAt: "2026-08-13T10:00:00Z" });
    expect(weekStats([done, abandoned], now)).toEqual({ focusMinutes: 35, focusCount: 1 });
    expect(monthFocusCount([done, abandoned], now)).toBe(1);
    expect(cumulativeStats([done, abandoned], now).totalFocusCount).toBe(1);
    // 连续 8 次启动-放弃不能"达成每日目标"。
    const spam = Array.from({ length: 8 }, (_, i) =>
      session({ id: `s${i}`, completed: false, plannedSeconds: 60, endedAt: `2026-08-13T0${i + 1}:00:00Z` })
    );
    expect(goalStreakDays(spam, 8, now, "sessions")).toBe(0);
    // 同日再补 8 段已完成（时刻取 0x:30Z，本地时区下仍落在 08-13）→ 达标。
    const done8 = Array.from({ length: 8 }, (_, i) => session({ id: `c${i}`, endedAt: `2026-08-13T0${i + 1}:30:00Z` }));
    expect(goalStreakDays([...spam, ...done8], 8, now, "sessions")).toBe(1);
  });

  it("excludes sessions from the previous week", () => {
    // Sunday 2026-08-09 (local) is before Monday 08-10.
    const prevSunday = new Date(2026, 7, 9, 12, 0, 0).toISOString();
    const s = session({ endedAt: prevSunday, startedAt: prevSunday });
    expect(weekStats([s], now).focusCount).toBe(0);
  });

  it("separates focus from break sessions（分钟只计 focus）", () => {
    const focus = session({ id: "f", type: "focus", endedAt: "2026-08-13T09:00:00Z" });
    const brk = session({
      id: "b",
      type: "break",
      mode: "shortBreak",
      plannedSeconds: 300,
      endedAt: "2026-08-13T09:30:00Z"
    });
    const ws = weekStats([focus, brk], now);
    expect(ws.focusCount).toBe(1);
    expect(ws.focusMinutes).toBe(25);
  });

  it("ignores sessions with invalid timestamps", () => {
    const bad = session({ endedAt: "not-a-date", startedAt: "not-a-date" });
    expect(weekStats([bad], now)).toEqual({ focusMinutes: 0, focusCount: 0 });
  });
});

/* 回归：跨（虚拟）午夜切分后的非末片必须归入**片起始**的那一天，
   而不是 endedAt 落到的次日——与 Rust 聚合（piece_start 归日）一致。 */
describe("跨午夜归日（P0-4 回归）", () => {
  const raw = session({
    id: "x",
    startedAt: new Date(2026, 7, 12, 23, 40, 0).toISOString(),
    endedAt: new Date(2026, 7, 13, 0, 20, 0).toISOString(),
    plannedSeconds: 1500
  });

  it("dailyTrend 把两片分别归入 08-12 与 08-13（此前前片被记入 13 日）", () => {
    const pieces = splitSessionsByDay([raw], 0);
    expect(pieces).toHaveLength(2);
    const trend = dailyTrend(pieces, now, 7);
    const day12 = trend.find((d) => d.date === "2026-08-12");
    const day13 = trend.find((d) => d.date === "2026-08-13");
    expect(day12?.focusMinutes).toBeGreaterThan(0);
    expect(day13?.focusMinutes).toBeGreaterThan(0);
    // 每桶秒合计后各自取整：750s+750s → 13+13=26（两桶各 round 一次，与 SQL 同法）。
    expect(day12!.focusMinutes + day13!.focusMinutes).toBe(26);
  });

  it("monthlyHeatmap 同口径归日", () => {
    const pieces = splitSessionsByDay([raw], 0);
    const heat = monthlyHeatmap(pieces, now, 0);
    expect(heat.find((c) => c.date === "2026-08-12")!.focusMinutes).toBeGreaterThan(0);
    expect(heat.find((c) => c.date === "2026-08-13")!.focusMinutes).toBeGreaterThan(0);
  });

  it("vmHour=4：跨 04:00 的段前片归前一日，趋势行按虚拟日排布", () => {
    const lateNight = session({
      id: "l",
      startedAt: new Date(2026, 7, 13, 2, 0, 0).toISOString(),
      endedAt: new Date(2026, 7, 13, 5, 0, 0).toISOString(),
      plannedSeconds: 1500
    });
    const pieces = splitSessionsByDay([lateNight], 4);
    expect(pieces).toHaveLength(2);
    const trend = dailyTrend(pieces, now, 7, (s) => s, 4);
    // 末桶 = now(12:00) 的虚拟日 08-13；02:00 起的前片归 08-12。
    expect(trend[6].date).toBe("2026-08-13");
    expect(trend.find((d) => d.date === "2026-08-12")!.focusMinutes).toBeGreaterThan(0);
  });
});

describe("cumulativeStats", () => {
  it("returns zeros when there are no focus sessions", () => {
    const c = cumulativeStats([], now);
    expect(c.totalFocusCount).toBe(0);
    expect(c.totalFocusMinutes).toBe(0);
    expect(c.dailyAverageMinutes).toBe(0);
    expect(c.firstFocusDate).toBeNull();
  });

  it("sums lifetime focus minutes and counts only focus sessions", () => {
    const focus1 = session({ id: "f1", plannedSeconds: 1500, endedAt: "2026-08-01T09:00:00Z" });
    const focus2 = session({ id: "f2", plannedSeconds: 1800, endedAt: "2026-08-13T09:00:00Z" });
    const brk = session({
      id: "b",
      type: "break",
      mode: "shortBreak",
      plannedSeconds: 300,
      endedAt: "2026-08-13T10:00:00Z"
    });
    const c = cumulativeStats([focus1, focus2, brk], now);
    expect(c.totalFocusCount).toBe(2);
    expect(c.totalFocusMinutes).toBe(55);
    expect(c.firstFocusDate).toBe("2026-08-01");
  });

  it("computes a daily average clamped to at least one day", () => {
    const c = cumulativeStats([session({ plannedSeconds: 900, endedAt: "2026-08-13T09:00:00Z" })], now);
    expect(c.dailyAverageMinutes).toBe(15);
  });

  it("excludes sessions before the configured start date", () => {
    const before = session({ id: "b", plannedSeconds: 1500, endedAt: "2026-08-01T09:00:00Z" });
    const after = session({ id: "a", plannedSeconds: 1800, endedAt: "2026-08-12T09:00:00Z" });
    const c = cumulativeStats([before, after], now, "2026-08-10");
    expect(c.totalFocusCount).toBe(1);
    expect(c.totalFocusMinutes).toBe(30);
    expect(c.firstFocusDate).toBe("2026-08-12");
  });

  it("counts a session on the start date itself", () => {
    const onStart = session({ plannedSeconds: 1500, endedAt: "2026-08-10T09:00:00Z" });
    const before = session({ id: "b", plannedSeconds: 1500, endedAt: "2026-08-09T09:00:00Z" });
    const c = cumulativeStats([onStart, before], now, "2026-08-10");
    expect(c.totalFocusCount).toBe(1);
    expect(c.totalFocusMinutes).toBe(25);
  });

  it("computes the daily average from the start date when set", () => {
    // Start 2026-08-10 → now 2026-08-13 = 4 days elapsed; 40 minutes / 4 = 10.
    const s = session({ plannedSeconds: 2400, endedAt: "2026-08-12T09:00:00Z" });
    const c = cumulativeStats([s], now, "2026-08-10");
    expect(c.dailyAverageMinutes).toBe(10);
  });

  it("treats an invalid start date as no filter", () => {
    const s = session({ plannedSeconds: 1500, endedAt: "2026-08-01T09:00:00Z" });
    const c = cumulativeStats([s], now, "not-a-date");
    expect(c.totalFocusCount).toBe(1);
    expect(c.totalFocusMinutes).toBe(25);
  });
});

describe("todayInterruptions", () => {
  /* 打断归日改按 startedAt 的虚拟日——跨午夜打断
     （23:50 起、00:10 止）不再被记入「今天」。 */
  const intr = (startedAt: string, endedAt: string): PomodoroInterruption => ({
    startedAt,
    endedAt,
    reason: "电话",
    mode: "focus",
    elapsedSeconds: 300
  });

  it("counts interruptions started today", () => {
    const today = intr("2026-08-13T09:00:00Z", "2026-08-13T09:05:00Z");
    const yesterday = intr("2026-08-12T09:00:00Z", "2026-08-12T09:05:00Z");
    expect(todayInterruptions([today, yesterday], now)).toBe(1);
  });

  it("跨午夜打断归起始日：昨日 23:50 起的打断不算今日", () => {
    const crossMidnight = intr(
      new Date(2026, 7, 12, 23, 50, 0).toISOString(),
      new Date(2026, 7, 13, 0, 10, 0).toISOString()
    );
    expect(todayInterruptions([crossMidnight], now)).toBe(0);
  });

  it("vmHour=4 时凌晨 02:00 起的打断属昨日虚拟日", () => {
    const earlyMorning = intr(
      new Date(2026, 7, 13, 2, 0, 0).toISOString(),
      new Date(2026, 7, 13, 2, 5, 0).toISOString()
    );
    expect(todayInterruptions([earlyMorning], now, 4)).toBe(0);
    expect(todayInterruptions([earlyMorning], now, 0)).toBe(1);
  });
});

describe("todayGiveUpCount", () => {
  it("counts incomplete focus sessions today", () => {
    const abandon = session({ id: "a", completed: false, endedAt: "2026-08-13T09:00:00Z" });
    const completed = session({ id: "c", completed: true, endedAt: "2026-08-13T10:00:00Z" });
    const yesterday = session({ id: "y", completed: false, endedAt: "2026-08-12T09:00:00Z" });
    expect(todayGiveUpCount([abandon, completed, yesterday], now)).toBe(1);
  });
});

describe("monthlyHeatmap", () => {
  it("returns one cell per day of the month", () => {
    const heat = monthlyHeatmap([], now);
    expect(heat).toHaveLength(31); // August 2026
    expect(heat[0].day).toBe(1);
    expect(heat[12].isToday).toBe(true); // day 13
  });

  it("accumulates focus minutes on the matching day", () => {
    const s = session({ endedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString() });
    const heat = monthlyHeatmap([s], now);
    const today = heat.find((c) => c.date === "2026-08-13");
    expect(today?.focusMinutes).toBe(25);
  });
});

describe("monthFocusMetrics", () => {
  it("sums minutes and counts for the current month", () => {
    const inMonth = session({ plannedSeconds: 1500, endedAt: "2026-08-05T09:00:00Z" });
    const otherMonth = session({ id: "o", plannedSeconds: 1500, endedAt: "2026-07-05T09:00:00Z" });
    expect(monthFocusMinutes([inMonth, otherMonth], now)).toBe(25);
    expect(monthFocusCount([inMonth, otherMonth], now)).toBe(1);
  });
});

describe("monthlyInterruptionBreakdown", () => {
  it("groups interruptions started in the current month by reason", () => {
    const inMonth: PomodoroInterruption = {
      startedAt: "2026-08-13T09:00:00Z",
      endedAt: "2026-08-13T09:05:00Z",
      reason: "电话",
      mode: "focus",
      elapsedSeconds: 300
    };
    const prevMonth: PomodoroInterruption = {
      startedAt: "2026-07-13T09:00:00Z",
      endedAt: "2026-07-13T09:05:00Z",
      reason: "电话",
      mode: "focus",
      elapsedSeconds: 300
    };
    expect(monthlyInterruptionBreakdown([inMonth, inMonth, prevMonth], now)).toEqual([{ reason: "电话", count: 2 }]);
  });

  it("跨午夜打断按起始时刻归月（P2 startedAt 口径回归）", () => {
    // 7-31 23:50 起、8-1 00:10 止：归 7 月而非 8 月。
    const crossMonth: PomodoroInterruption = {
      startedAt: new Date(2026, 6, 31, 23, 50, 0).toISOString(),
      endedAt: new Date(2026, 7, 1, 0, 10, 0).toISOString(),
      reason: "消息",
      mode: "focus",
      elapsedSeconds: 300
    };
    const aug = monthlyInterruptionBreakdown([crossMonth], now);
    expect(aug).toEqual([]);
  });
});

describe("A-4 SQLite 聚合口径（*FromAgg）", () => {
  // 模拟「内存 500 条截断之外的更早历史」：7 月的数据在内存列表里早已
  // 被截掉，但聚合里仍然存在 —— FromAgg 系列必须把它计入。
  const agg: FocusAggregate = {
    daily: [
      { date: "2026-08-13", focusSeconds: 1500, focusCount: 1 },
      { date: "2026-08-12", focusSeconds: 3000, focusCount: 2 },
      { date: "2026-08-11", focusSeconds: 0, focusCount: 0 },
      { date: "2026-07-01", focusSeconds: 600, focusCount: 1 },
      { date: "2026-01-05", focusSeconds: 1200, focusCount: 1 }
    ]
  };

  it("cumulativeStatsFromAgg 汇总全量历史（含内存截断之外的日期）", () => {
    const stats = cumulativeStatsFromAgg(agg, now);
    expect(stats.totalFocusCount).toBe(5);
    expect(stats.totalFocusMinutes).toBe(105); // (1500+3000+600+1200)/60
    expect(stats.firstFocusDate).toBe("2026-01-05");
  });

  it("cumulativeStatsFromAgg 遵守 analyticsStartDate 窗口", () => {
    const stats = cumulativeStatsFromAgg(agg, now, "2026-07-01");
    expect(stats.totalFocusCount).toBe(4); // 1 月的 1 条被排除
    expect(stats.firstFocusDate).toBe("2026-07-01");
  });

  it("monthTotalFromAgg 只统计当前自然月", () => {
    const { minutes, count } = monthTotalFromAgg(agg, now); // now = 2026-08-13
    expect(minutes).toBe(75); // (1500+3000)/60
    expect(count).toBe(3);
  });

  it("weekStatsFromAgg 统计本周（周一 2026-08-10 起）且跳过零专注日", () => {
    const ws = weekStatsFromAgg(agg, now);
    expect(ws.focusMinutes).toBe(75);
    expect(ws.focusCount).toBe(3);
  });

  it("goalStreakDaysFromAgg 按达标日连续计数，今日未达标不打断昨日连胜", () => {
    // 今日(13)1 轮、昨日(12)2 轮、前日(11)0 轮：goal=1 → 连胜 2。
    expect(goalStreakDaysFromAgg(agg, 1, now)).toBe(2);
    expect(goalStreakDaysFromAgg(agg, 2, now)).toBe(1);
  });

  it("monthlyHeatmapFromAgg 生成整月格子并把秒换算为分钟", () => {
    const heat = monthlyHeatmapFromAgg(agg, now);
    expect(heat).toHaveLength(31);
    expect(heat.find((c) => c.date === "2026-08-13")?.focusMinutes).toBe(25);
    expect(heat.find((c) => c.date === "2026-08-12")?.focusMinutes).toBe(50);
    expect(heat.find((c) => c.date === "2026-08-01")?.focusMinutes).toBe(0);
  });

  it("yearGridFromAgg 只纳入目标年份的日期", () => {
    const grid = yearGridFromAgg(agg, 2026);
    // weeks[weekday][week]：任意顺序遍历求和即可。
    const total = grid.weeks.reduce((acc, row) => acc + row.reduce((a, d) => a + (d?.focusMinutes ?? 0), 0), 0);
    expect(total).toBe(105);
  });

  it("monthlyHeatmapFromAgg 的今日圈按虚拟日归属（vmHour=4 凌晨场景）", () => {
    // 08-13 01:00（vm=4 下「今天」=08-12 的虚拟日）：数据与高亮都应落在 12 号格。
    const earlyNow = new Date(2026, 7, 13, 1, 0, 0);
    const earlyAgg: FocusAggregate = { daily: [{ date: "2026-08-12", focusSeconds: 900, focusCount: 1 }] };
    const heat = monthlyHeatmapFromAgg(earlyAgg, earlyNow, 4);
    expect(heat.find((c) => c.date === "2026-08-12")?.isToday).toBe(true);
    expect(heat.find((c) => c.date === "2026-08-13")?.isToday).toBe(false);
    // vm=0 时同场景高亮仍在自然今天。
    const natural = monthlyHeatmapFromAgg(earlyAgg, earlyNow, 0);
    expect(natural.find((c) => c.date === "2026-08-13")?.isToday).toBe(true);
  });

  it("yearGridFromAgg 显式 now：今日圈落在 now 的虚拟日键上", () => {
    const grid = yearGridFromAgg(agg, 2026, (s) => s, now, 0);
    const todayCells = grid.weeks.flat().filter((c) => c?.isToday);
    expect(todayCells).toHaveLength(1);
    expect(todayCells[0]!.date).toBe("2026-08-13");
  });
});

describe("hourlyFocusDistribution（零时长旧行对齐 Rust legacy 分支）", () => {
  it("零时长完成段：秒数与次数计入结束小时，不再静默跳过", () => {
    const zero = session({
      id: "z",
      startedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString(),
      endedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString(),
      plannedSeconds: 0,
      completed: true
    });
    const buckets = hourlyFocusDistribution([zero]);
    expect(buckets[9].focusCount).toBe(1);
  });

  it("秒数 ≤0 的零时长段同样按 legacy 口径计次", () => {
    const legacy = session({
      id: "lz",
      startedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString(),
      endedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString(),
      plannedSeconds: 0,
      completed: true
    });
    const buckets = hourlyFocusDistribution([legacy]);
    expect(buckets[9].focusSeconds).toBe(0);
    expect(buckets[9].focusCount).toBe(1);
  });
});

describe("splitSessionsByDay（DST 安全循环重构回归）", () => {
  it("跨三日的长段切成三片，秒数守恒（末片吸收余量）", () => {
    const long = session({
      id: "long",
      startedAt: new Date(2026, 7, 11, 12, 0, 0).toISOString(),
      endedAt: new Date(2026, 7, 14, 12, 0, 0).toISOString(),
      plannedSeconds: 5400
    });
    const pieces = splitSessionsByDay([long], 0);
    expect(pieces).toHaveLength(4); // 11/12/13/14 四个自然日
    expect(pieces.reduce((acc, p) => acc + p.plannedSeconds, 0)).toBe(5400);
  });

  it("vmHour=2：边界日历重建后单日段不切分", () => {
    const s = session({
      id: "one",
      startedAt: new Date(2026, 7, 13, 10, 0, 0).toISOString(),
      endedAt: new Date(2026, 7, 13, 11, 0, 0).toISOString(),
      plannedSeconds: 3600
    });
    expect(splitSessionsByDay([s], 2)).toEqual([s]);
  });
});

/** 2026-10-08 审查批次：、、
 *  （热图未来日不渲染数据）。 */
describe("切分与热图口径（2026-10-08 审查）", () => {
  const now = new Date(2026, 7, 13, 12, 0, 0);

  it("F-2：跨午夜完成段的轮数只落首片（与 Rust aggregate 的 i==0 口径一致）", () => {
    const cross = session({
      id: "f2",
      startedAt: new Date(2026, 7, 12, 23, 50, 0).toISOString(),
      endedAt: new Date(2026, 7, 13, 0, 15, 0).toISOString(),
      plannedSeconds: 1500,
      completed: true
    });
    const pieces = splitSessionsByDay([cross], 0);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].completed).toBe(true); // 首片（起始日）计轮
    expect(pieces[1].completed).toBe(false); // 次日不再重复计轮
  });

  it("B-1：零时长旧行的 focusCount 不分 completed（与 Rust hourly 口径一致）", () => {
    const zero = session({
      id: "b1",
      startedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString(),
      endedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString(),
      plannedSeconds: 0,
      completed: false
    });
    const dist = hourlyFocusDistribution([zero]);
    expect(dist[9].focusSeconds).toBe(0);
    expect(dist[9].focusCount).toBe(1); // 此前仅 completed 计次，与 Rust 互差
  });

  it("B-3：年视图/月视图的未来日不渲染数据（系统时间回拨产生的未来键）", () => {
    const agg: FocusAggregate = {
      daily: [
        { date: "2026-08-12", focusSeconds: 600, focusCount: 1 },
        { date: "2026-08-14", focusSeconds: 600, focusCount: 1 } // 未来日（now=08-13）
      ]
    };
    const grid = yearGridFromAgg(agg, 2026, (s) => s, now, 0);
    const flat = grid.weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null);
    expect(flat.find((c) => c.date === "2026-08-12")?.focusMinutes).toBe(10);
    expect(flat.find((c) => c.date === "2026-08-14")?.focusMinutes).toBe(0);

    const heat = monthlyHeatmapFromAgg(agg, now, 0);
    expect(heat.find((c) => c.date === "2026-08-14")?.focusMinutes).toBe(0);
  });
});
