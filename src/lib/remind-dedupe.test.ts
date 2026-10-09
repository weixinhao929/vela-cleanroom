import { beforeEach, describe, expect, it } from "vitest";
import { markReminded, readPendingPayloads, sweepStaleReminders, tryMarkOnce } from "./remind-dedupe";

describe("remind-dedupe", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("首次标记返回 true 并写键，再次标记返回 false", () => {
    const key = "focus-desk.sweep-remind.i.ev.2026-08-13";
    expect(markReminded(key, "focus-desk.cal-remind.", "2026-08-13")).toBe(true);
    expect(localStorage.getItem(key)).toBe("1");
    expect(markReminded(key, "focus-desk.cal-remind.", "2026-08-13")).toBe(false);
  });

  it("写入时清扫同前缀下早于今天的旧键，保留今天/未来与其它前缀的键", () => {
    localStorage.setItem("focus-desk.sweep-remind.i.a.2026-08-11", "1");
    localStorage.setItem("focus-desk.sweep-remind.i.b.2026-08-12", "1");
    localStorage.setItem("focus-desk.sweep-remind.i.c.2026-08-13", "1");
    localStorage.setItem("focus-desk.sweep-remind.i.d.2026-08-14", "1");
    localStorage.setItem("focus-desk.tt-remind.s.2026-08-11", "1");
    localStorage.setItem("focus-desk.sweep-remind.i.weird.notadate", "1");
    // 不同前缀走各自的每日清扫闸；用一个新前缀值触发本前缀首次清扫。
    markReminded("focus-desk.sweep-remind.i.e.2026-08-13", "focus-desk.sweep-remind.", "2026-08-13");
    expect(localStorage.getItem("focus-desk.sweep-remind.i.a.2026-08-11")).toBeNull();
    expect(localStorage.getItem("focus-desk.sweep-remind.i.b.2026-08-12")).toBeNull();
    expect(localStorage.getItem("focus-desk.sweep-remind.i.c.2026-08-13")).toBe("1");
    expect(localStorage.getItem("focus-desk.sweep-remind.i.d.2026-08-14")).toBe("1");
    expect(localStorage.getItem("focus-desk.tt-remind.s.2026-08-11")).toBe("1");
    expect(localStorage.getItem("focus-desk.sweep-remind.i.weird.notadate")).toBe("1");
  });

  it("同一前缀同一天只扫一次（第二次写入不再遍历）", () => {
    sweepStaleReminders("focus-desk.x-remind.", "2026-08-13");
    localStorage.setItem("focus-desk.x-remind.a.2026-08-01", "1");
    sweepStaleReminders("focus-desk.x-remind.", "2026-08-13");
    expect(localStorage.getItem("focus-desk.x-remind.a.2026-08-01")).toBe("1");
    sweepStaleReminders("focus-desk.x-remind.", "2026-08-14");
    expect(localStorage.getItem("focus-desk.x-remind.a.2026-08-01")).toBeNull();
  });
});

describe("tryMarkOnce 负载暂存 / readPendingPayloads 对账（P2 崩溃窗口恢复）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("无负载写 '1'（旧语义）；带负载写 JSON 且对账可读回", () => {
    expect(tryMarkOnce("focus-desk.seg.a.2026-08-13", "focus-desk.seg.", "2026-08-13")).toBe("marked");
    expect(localStorage.getItem("focus-desk.seg.a.2026-08-13")).toBe("1");

    const record = { id: "s-1", plannedSeconds: 1500 };
    expect(tryMarkOnce("focus-desk.seg.b.2026-08-13", "focus-desk.seg.", "2026-08-13", record)).toBe("marked");
    expect(localStorage.getItem("focus-desk.seg.b.2026-08-13")).toBe(JSON.stringify(record));

    const pending = readPendingPayloads<{ id: string }>("focus-desk.seg.");
    expect(pending).toEqual([{ key: "focus-desk.seg.b.2026-08-13", payload: record }]);
  });

  it("重复标记 duplicate 且不覆盖既有负载", () => {
    const record = { id: "s-2" };
    tryMarkOnce("focus-desk.seg.c.2026-08-13", "focus-desk.seg.", "2026-08-13", record);
    expect(tryMarkOnce("focus-desk.seg.c.2026-08-13", "focus-desk.seg.", "2026-08-13", { id: "evil" })).toBe(
      "duplicate"
    );
    expect(localStorage.getItem("focus-desk.seg.c.2026-08-13")).toBe(JSON.stringify(record));
  });

  it("损坏负载的标记被对账跳过，键本身保留（去重语义不受影响）", () => {
    localStorage.setItem("focus-desk.seg.d.2026-08-13", "{not-json");
    expect(readPendingPayloads("focus-desk.seg.")).toEqual([]);
    expect(localStorage.getItem("focus-desk.seg.d.2026-08-13")).toBe("{not-json");
  });
});
