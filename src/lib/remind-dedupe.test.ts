import { beforeEach, describe, expect, it } from "vitest";
import { markReminded, sweepStaleReminders } from "./remind-dedupe";

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
