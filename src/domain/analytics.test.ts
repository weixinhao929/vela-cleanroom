import { describe, expect, it } from "vitest";
import {
  annualTrend,
  computeStats,
  cumulativeStats,
  cumulativeStatsFromAgg,
  focusDurationDistribution,
  goalStreakDays,
  goalStreakDaysFromAgg,
  interruptionBreakdown,
  monthTotalFromAgg,
  monthlyHeatmap,
  monthlyHeatmapFromAgg,
  monthlyInterruptionBreakdown,
  monthFocusCount,
  monthFocusMinutes,
  todayGiveUpCount,
  todayInterruptions,
  weekStats,
  weekStatsFromAgg,
  weeklyTrend,
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

describe("computeStats", () => {
  it("returns empty stats when there are no sessions", () => {
    const stats = computeStats([], now);
    expect(stats).toEqual({
      today: { focusCount: 0, focusMinutes: 0, totalCount: 0 },
      week: { focusCount: 0, focusMinutes: 0, totalCount: 0 }
    });
  });

  it("counts a session finished today in both today and week", () => {
    const s = session({ endedAt: "2026-08-13T09:00:00Z" });
    const stats = computeStats([s], now);
    expect(stats.today).toEqual({ focusCount: 1, focusMinutes: 25, totalCount: 1 });
    expect(stats.week).toEqual({ focusCount: 1, focusMinutes: 25, totalCount: 1 });
  });

  it("counts a session earlier this week in week but not today", () => {
    // Monday of this week is 2026-08-10.
    const s = session({ endedAt: "2026-08-11T09:00:00Z" });
    const stats = computeStats([s], now);
    expect(stats.today.totalCount).toBe(0);
    expect(stats.week).toEqual({ focusCount: 1, focusMinutes: 25, totalCount: 1 });
  });

  it("excludes sessions from the previous week", () => {
    // Sunday 2026-08-09 (local) is before Monday 08-10.
    const prevSunday = new Date(2026, 7, 9, 12, 0, 0).toISOString();
    const s = session({ endedAt: prevSunday });
    const stats = computeStats([s], now);
    expect(stats.week.totalCount).toBe(0);
  });

  it("separates focus from break sessions", () => {
    const focus = session({ id: "f", type: "focus", endedAt: "2026-08-13T09:00:00Z" });
    const brk = session({
      id: "b",
      type: "break",
      mode: "shortBreak",
      plannedSeconds: 300,
      endedAt: "2026-08-13T09:30:00Z"
    });
    const stats = computeStats([focus, brk], now);
    expect(stats.today.totalCount).toBe(2);
    expect(stats.today.focusCount).toBe(1);
    expect(stats.today.focusMinutes).toBe(25);
  });

  it("ignores sessions with invalid timestamps", () => {
    const bad = session({ endedAt: "not-a-date" });
    const stats = computeStats([bad], now);
    expect(stats.today.totalCount).toBe(0);
  });

  it("中断放弃的未完成段：不计轮数，但实际专注分钟照计（与番茄钟 A-36 口径一致）", () => {
    const done = session({ id: "d", endedAt: "2026-08-13T09:00:00Z" });
    const abandoned = session({ id: "a", completed: false, plannedSeconds: 600, endedAt: "2026-08-13T10:00:00Z" });
    const stats = computeStats([done, abandoned], now);
    expect(stats.today.focusCount).toBe(1);
    expect(stats.today.focusMinutes).toBe(35);
    expect(stats.today.totalCount).toBe(2);
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
});

describe("weeklyTrend", () => {
  it("returns 7 days ending today, oldest first", () => {
    const trend = weeklyTrend([], now);
    expect(trend).toHaveLength(7);
    expect(trend[6].label).toBe("今天");
    expect(trend[0].date).toBe("2026-08-07");
    expect(trend[6].date).toBe("2026-08-13");
  });

  it("accumulates focus minutes per day", () => {
    const s = session({ endedAt: new Date(2026, 7, 13, 9, 0, 0).toISOString() });
    const trend = weeklyTrend([s], now);
    const today = trend[6];
    expect(today.focusMinutes).toBe(25);
  });

  it("ignores break sessions", () => {
    const brk = session({
      id: "b",
      type: "break",
      mode: "shortBreak",
      plannedSeconds: 300,
      endedAt: new Date(2026, 7, 13, 9, 30, 0).toISOString()
    });
    const trend = weeklyTrend([brk], now);
    expect(trend[6].focusMinutes).toBe(0);
  });

  it("ignores sessions outside the 7-day window", () => {
    const old = session({ endedAt: new Date(2026, 7, 1, 9, 0, 0).toISOString() });
    const trend = weeklyTrend([old], now);
    expect(trend.every((d) => d.focusMinutes === 0)).toBe(true);
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

describe("interruptionBreakdown", () => {
  const i = (reason: string): PomodoroInterruption => ({
    startedAt: "t0",
    endedAt: "t1",
    reason,
    mode: "focus",
    elapsedSeconds: 300
  });

  it("returns empty for no interruptions", () => {
    expect(interruptionBreakdown([])).toEqual([]);
  });

  it("groups and sorts by count descending", () => {
    const breakdown = interruptionBreakdown([i("电话"), i("消息"), i("电话"), i("网页")]);
    expect(breakdown).toEqual([
      { reason: "电话", count: 2 },
      { reason: "消息", count: 1 },
      { reason: "网页", count: 1 }
    ]);
  });
});

describe("todayInterruptions", () => {
  it("counts interruptions that ended today", () => {
    const today = {
      startedAt: "t0",
      endedAt: "2026-08-13T09:00:00Z",
      reason: "电话",
      mode: "focus" as const,
      elapsedSeconds: 300
    };
    const yesterday = {
      startedAt: "t0",
      endedAt: "2026-08-12T09:00:00Z",
      reason: "消息",
      mode: "focus" as const,
      elapsedSeconds: 300
    };
    expect(todayInterruptions([today, yesterday], now)).toBe(1);
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

describe("focusDurationDistribution", () => {
  it("groups completed focus sessions into duration buckets", () => {
    const s25 = session({ plannedSeconds: 1500, endedAt: "2026-08-13T09:00:00Z" });
    const s25b = session({ id: "b", plannedSeconds: 1500, completed: false, endedAt: "2026-08-13T10:00:00Z" });
    const s50 = session({ id: "c", plannedSeconds: 3000, endedAt: "2026-08-13T11:00:00Z" });
    const dist = focusDurationDistribution([s25, s25b, s50]);
    // s25b is incomplete and excluded; 25 + 50 minutes.
    const total = dist.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(2);
    const bucket25 = dist.find((b) => b.label === "16-25分");
    expect(bucket25?.count).toBe(1);
    const bucket50 = dist.find((b) => b.label === ">45分");
    expect(bucket50?.count).toBe(1);
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
  it("groups interruptions in the current month by reason", () => {
    const inMonth = {
      startedAt: "t0",
      endedAt: "2026-08-13T09:00:00Z",
      reason: "电话",
      mode: "focus" as const,
      elapsedSeconds: 300
    };
    const prevMonth = {
      startedAt: "t0",
      endedAt: "2026-07-13T09:00:00Z",
      reason: "电话",
      mode: "focus" as const,
      elapsedSeconds: 300
    };
    expect(monthlyInterruptionBreakdown([inMonth, inMonth, prevMonth], now)).toEqual([{ reason: "电话", count: 2 }]);
  });
});

describe("annualTrend", () => {
  it("returns 12 months with focus minutes distributed", () => {
    const aug = session({ plannedSeconds: 1500, endedAt: "2026-08-13T09:00:00Z" });
    const jan = session({ id: "j", plannedSeconds: 900, endedAt: new Date(2026, 0, 5, 9, 0, 0).toISOString() });
    const trend = annualTrend([aug, jan], now);
    expect(trend).toHaveLength(12);
    expect(trend[0].focusMinutes).toBe(15); // 1月
    expect(trend[7].focusMinutes).toBe(25); // 8月
    expect(trend[7].focusCount).toBe(1);
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
});
