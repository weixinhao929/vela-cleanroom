import { describe, expect, it } from "vitest";
import {
  dayHourGrid,
  hourlyFocusDistribution,
  splitSessionAcrossDays,
  splitSessionsByDay,
  virtualDayKey
} from "./analytics";
import type { PomodoroSessionRecord } from "./pomodoro";

describe("splitSessionAcrossDays（跨午夜切分）", () => {
  it("本地 23:40 → 次日 00:20 切成两片、秒数对半、末片承接轮数", () => {
    // 构造「今天的本地 23:40」+ 40 分钟跨度：无论机器在哪个时区，只要这段
    // 跨过一个本地午夜，就应切两片、各 20 分钟；分段键值关系用
    // virtualDayKey 自身断言，不硬编码日期。
    const start = new Date();
    start.setHours(23, 40, 0, 0);
    const end = new Date(start.getTime() + 40 * 60_000);
    const pieces = splitSessionAcrossDays(start.toISOString(), end.toISOString(), 2400, 0);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].seconds).toBe(1200);
    expect(pieces[1].seconds).toBe(1200);
    expect(pieces[0].last).toBe(false);
    expect(pieces[1].last).toBe(true);
    expect(pieces[0].dayKey).not.toBe(pieces[1].dayKey);
  });

  it("不跨日且 H=0 时单片返回（last=true，秒数全额）", () => {
    const start = new Date(2026, 0, 15, 10, 0, 0);
    const end = new Date(2026, 0, 15, 11, 0, 0);
    const pieces = splitSessionAcrossDays(start.toISOString(), end.toISOString(), 3600, 0);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].seconds).toBe(3600);
    expect(pieces[0].last).toBe(true);
    expect(pieces[0].dayKey).toBe("2026-01-15");
  });

  it("虚拟午夜 H=2：本地 01:00-03:00 在 02:00 切开，前片属「昨天」", () => {
    // 本地 01:00（当日）→ 03:00（当日）。machine-tz 无关：直接用本地 Date 构造。
    const start = new Date(2026, 0, 15, 1, 0, 0);
    const end = new Date(2026, 0, 15, 3, 0, 0);
    const pieces = splitSessionAcrossDays(start.toISOString(), end.toISOString(), 7200, 2);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].dayKey).toBe("2026-01-14");
    expect(pieces[1].dayKey).toBe("2026-01-15");
    expect(pieces[0].seconds).toBe(3600);
    expect(pieces[1].seconds).toBe(3600);
    expect(pieces[1].last).toBe(true);
  });

  it("virtualDayKey：H=2 时凌晨 01:30 属于昨天", () => {
    expect(virtualDayKey(new Date(2026, 0, 15, 1, 30), 2)).toBe("2026-01-14");
    expect(virtualDayKey(new Date(2026, 0, 15, 2, 0), 2)).toBe("2026-01-15");
    expect(virtualDayKey(new Date(2026, 0, 15, 23, 30), 0)).toBe("2026-01-15");
  });

  it("无效时间 / end<=start / 秒数<=0 返回空", () => {
    expect(splitSessionAcrossDays("not-a-date", new Date().toISOString(), 60, 0)).toEqual([]);
    const t = new Date();
    expect(splitSessionAcrossDays(t.toISOString(), t.toISOString(), 60, 0)).toEqual([]);
    expect(splitSessionAcrossDays(t.toISOString(), new Date(t.getTime() + 1000).toISOString(), 0, 0)).toEqual([]);
  });
});

const mk = (over: Partial<PomodoroSessionRecord>): PomodoroSessionRecord => ({
  id: "s",
  type: "focus",
  mode: "focus",
  startedAt: new Date(2026, 0, 15, 1, 0).toISOString(),
  endedAt: new Date(2026, 0, 15, 3, 0).toISOString(),
  plannedSeconds: 7200,
  completed: true,
  taskId: null,
  eventLabel: null,
  ...over
});

describe("splitSessionsByDay / hourlyFocusDistribution", () => {
  it("跨虚拟日的会话切成两条记录，秒数守恒", () => {
    const out = splitSessionsByDay([mk({ id: "a", plannedSeconds: 7200 })], 2);
    expect(out).toHaveLength(2);
    expect(out.reduce((acc, r) => acc + r.plannedSeconds, 0)).toBe(7200);
    expect(out[0].id).toBe("a#0");
    expect(out[1].id).toBe("a#1");
  });

  it("无跨日段且 H=0 时走快路径原样返回（同引用）", () => {
    const rec = mk({
      id: "b",
      startedAt: new Date(2026, 0, 15, 9, 0).toISOString(),
      endedAt: new Date(2026, 0, 15, 10, 0).toISOString()
    });
    const out = splitSessionsByDay([rec], 0);
    expect(out[0]).toBe(rec);
  });

  it("hourlyFocusDistribution：小时分摊 + 轮数落在结束小时", () => {
    const buckets = hourlyFocusDistribution([
      mk({
        id: "c",
        startedAt: new Date(2026, 0, 15, 1, 0).toISOString(),
        endedAt: new Date(2026, 0, 15, 3, 0).toISOString(),
        plannedSeconds: 7200
      })
    ]);
    expect(buckets).toHaveLength(24);
    expect(buckets[1].focusSeconds).toBe(3600);
    expect(buckets[2].focusSeconds).toBe(3600);
    // 轮数只落在结束小时（3 点），不重复计数。
    expect(buckets[3].focusCount).toBe(1);
    expect(buckets[1].focusCount).toBe(0);
    expect(buckets[2].focusCount).toBe(0);
  });

  it("非专注类型不计入小时分布", () => {
    const buckets = hourlyFocusDistribution([mk({ id: "d", type: "break" })]);
    expect(buckets.every((b) => b.focusSeconds === 0 && b.focusCount === 0)).toBe(true);
  });
});

describe("dayHourGrid（近 N 天 × 24 小时矩阵）", () => {
  const identity = (s: string) => s;

  it("窗口含今日在内的前 N 天，今日行标「今天」且 isToday", () => {
    const now = new Date(2026, 8, 27, 15, 0); // 2026-09-27
    const grid = dayHourGrid([], now, 7, identity);
    expect(grid.dayKeys).toHaveLength(7);
    expect(grid.dayKeys[6]).toBe("2026-09-27");
    expect(grid.dayKeys[0]).toBe("2026-09-21");
    expect(grid.isToday[6]).toBe(true);
    expect(grid.dayLabels[6]).toBe("今天");
    expect(grid.dayLabels[0]).not.toBe("今天");
  });

  it("同日两段分摊到各自小时；跨小时段按墙钟占比切分", () => {
    const now = new Date(2026, 8, 27, 23, 0);
    const sessions = [
      mk({
        id: "h1",
        // 10:00–11:40（100 分钟）跨 10 与 11 两个整点：10 点 60 分钟、11 点 40 分钟。
        startedAt: new Date(2026, 8, 27, 10, 0).toISOString(),
        endedAt: new Date(2026, 8, 27, 11, 40).toISOString(),
        plannedSeconds: 6000
      })
    ];
    const grid = dayHourGrid(sessions, now, 3, identity);
    expect(grid.cells[2][10]).toBe(60);
    expect(grid.cells[2][11]).toBe(40);
    expect(grid.cells[0][10]).toBe(0);
  });

  it("跨午夜段分摊到两天的对应小时；窗口外不计", () => {
    const now = new Date(2026, 8, 27, 10, 0);
    const sessions = [
      mk({
        id: "h2",
        // 26 日 23:40 → 27 日 00:20。
        startedAt: new Date(2026, 8, 26, 23, 40).toISOString(),
        endedAt: new Date(2026, 8, 27, 0, 20).toISOString(),
        plannedSeconds: 2400
      }),
      mk({
        id: "h3",
        // 窗口外（24 日）。
        startedAt: new Date(2026, 8, 24, 9, 0).toISOString(),
        endedAt: new Date(2026, 8, 24, 10, 0).toISOString(),
        plannedSeconds: 3600
      })
    ];
    const grid = dayHourGrid(sessions, now, 3, identity); // 25/26/27
    expect(grid.cells[1][23]).toBe(20); // 26 日 23 点
    expect(grid.cells[2][0]).toBe(20); // 27 日 0 点
    expect(grid.cells.flat().reduce((a, b) => a + b, 0)).toBe(40);
  });
});
