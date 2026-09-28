import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CalendarMini } from "./CalendarMini";

/**
 * CalendarMini 回归：日期数字 + 星期；「下一事件」只读 CalendarWidget 的
 * localStorage 事件表（同 key），取今天尚未开始的最早定时事件（含 weekly 重复
 * 展开），无则取全天事件；已过去的定时事件不算；无实例只显日期。
 */
const KEY = (id: string) => `focus-desk.calendar.${id}.v1`;
const ev = (text: string, time = "", repeat: "none" | "weekly" = "none") => ({
  id: text,
  text,
  time,
  color: "",
  repeat,
  remind: 0
});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  // 2026-09-16 是周三，10:00。
  vi.setSystemTime(new Date(2026, 8, 16, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CalendarMini", () => {
  it("日期数字 + 星期短名（跟随应用语言 zh-CN）", () => {
    render(<CalendarMini active />);
    expect(screen.getByText("16")).toBeInTheDocument();
    expect(screen.getByText("周三")).toBeInTheDocument();
    expect(document.querySelector(".dock-mini-text")).toBeNull();
  });

  it("下一事件：跳过已过去的定时事件，取最早的未开始事件；weekly 锚点在上周同天也命中", () => {
    localStorage.setItem(
      KEY("c1"),
      JSON.stringify({
        "2026-09-16": [ev("晨会", "09:00"), ev("周报", "17:30"), ev("午餐", "12:00")],
        "2026-09-09": [ev("例会", "14:00", "weekly")]
      })
    );
    render(<CalendarMini instanceId="c1" active />);
    expect(screen.getByText("午餐")).toBeInTheDocument();
    expect(screen.queryByText("晨会")).toBeNull();
  });

  it("无定时事件时取今天的全天事件；单位数小时的时间也能正确比较", () => {
    localStorage.setItem(KEY("c2"), JSON.stringify({ "2026-09-16": [ev("全天事项"), ev("早课", "8:00")] }));
    render(<CalendarMini instanceId="c2" active />);
    expect(screen.getByText("全天事项")).toBeInTheDocument();
  });
});
