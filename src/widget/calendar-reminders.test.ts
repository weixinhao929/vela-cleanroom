import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanCalendarReminders } from "./calendar-reminders";
import { sourceNotify } from "../lib/notifications";

/**
 * 日历提醒调度（主窗单驱动）单轮扫描语义：
 * - 窗口 [开始−提醒, 开始+15 分钟]：到点发、错过仍补发、超宽限放弃；
 * - 全天事件 / remind=0 不提醒；去重键按天（同一天只发一次）；
 * - 重复事件在非锚点日的命中也提醒。
 */
vi.mock("../lib/notifications", () => ({
  sourceNotify: vi.fn()
}));
vi.mock("../lib/dnd", () => ({
  dndSuppressing: () => false
}));

const KEY = (id: string) => `focus-desk.calendar.${id}.v1`;
const ev = (p: Record<string, unknown>) => ({
  id: "e1",
  text: "事项",
  time: "10:00",
  color: "",
  repeat: "none",
  repeatEvery: 1,
  repeatUntil: "",
  excepted: [],
  remind: 30,
  location: "",
  note: "",
  endTime: "",
  ...p
});

const notified = () => (sourceNotify as ReturnType<typeof vi.fn>).mock.calls;

describe("scanCalendarReminders", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  const at = (h: number, m: number) => new Date(2026, 8, 16, h, m, 0);

  it("到点（开始−提醒）发送一次；早于到点不发送", () => {
    localStorage.setItem(KEY("c1"), JSON.stringify({ "2026-09-16": [ev({})] }));
    expect(scanCalendarReminders(at(9, 29))).toBe(0);
    expect(scanCalendarReminders(at(9, 30))).toBe(1);
    expect(scanCalendarReminders(at(9, 31))).toBe(0); // 同天已去重
    expect(notified()).toHaveLength(1);
    expect(notified()[0][2]).toContain("10:00 事项");
  });

  it("错过到点仍在宽限窗口（开始后 15 分钟内）补发；超宽限放弃", () => {
    localStorage.setItem(KEY("c1"), JSON.stringify({ "2026-09-16": [ev({})] }));
    expect(scanCalendarReminders(at(10, 14))).toBe(1); // 睡眠跨过到点，仍在窗口
    expect(scanCalendarReminders(at(10, 16))).toBe(0); // 超过 开始+15 放弃
  });

  it("全天事件与 remind=0 不发送", () => {
    localStorage.setItem(
      KEY("c1"),
      JSON.stringify({ "2026-09-16": [ev({ time: "", remind: 30 }), ev({ id: "e2", remind: 0 })] })
    );
    expect(scanCalendarReminders(at(10, 0))).toBe(0);
  });

  it("重复事件在非锚点日的命中也提醒；例外日不提醒；去重键按天独立", () => {
    localStorage.setItem(
      KEY("c1"),
      JSON.stringify({ "2026-09-09": [ev({ repeat: "weekly", excepted: ["2026-09-16"] })] })
    );
    expect(scanCalendarReminders(at(9, 30))).toBe(0); // 例外日
    localStorage.setItem(KEY("c1"), JSON.stringify({ "2026-09-09": [ev({ repeat: "weekly" })] }));
    // 预置昨天的去重键：不应影响今天的提醒。
    localStorage.setItem("focus-desk.cal-remind.c1.e1.2026-09-15", "1");
    expect(scanCalendarReminders(at(9, 30))).toBe(1);
  });

  it("提前量跨零点（00:10 事件提前 30 分）钳到 0 点起算", () => {
    localStorage.setItem(KEY("c1"), JSON.stringify({ "2026-09-16": [ev({ time: "00:10", remind: 30 })] }));
    expect(scanCalendarReminders(at(0, 0))).toBe(1);
  });
});
