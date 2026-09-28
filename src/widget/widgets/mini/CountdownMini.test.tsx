import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CountdownMini } from "./CountdownMini";

/**
 * CountdownMini 回归：只读绑定实例 widget config 的 targets（与 CountdownWidget
 * 同 key），取最早的未到期倒数日：N 天 + 名称；今天 → 「就是今天」；全部已过
 * → 最近过去的一个「已过去 N 天」；无实例 / 无目标 → 「—」。
 */
const cfg = (id: string, targets: unknown) =>
  localStorage.setItem(`focus-desk.widget-config.${id}.v1`, JSON.stringify({ targets }));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 16, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CountdownMini", () => {
  it("最早的未到期目标：剩余天数 + 名称（跳过非法条目）", () => {
    cfg("cd1", [
      { id: "b", label: "旧纪念日", date: "2026-01-01" },
      { id: "a", label: "生日", date: "2026-09-26" },
      { id: "c", label: "更远", date: "2026-12-31" },
      { id: "x", label: "坏日期", date: "26/09/2026" }
    ]);
    render(<CountdownMini instanceId="cd1" active />);
    expect(screen.getByText("10 天")).toBeInTheDocument();
    expect(screen.getByText("生日")).toBeInTheDocument();
  });

  it("目标就是今天 → 「就是今天」+ .is-today；全部已过 → 最近的一个「已过去 N 天」", () => {
    cfg("cd2", [{ id: "a", label: "发布日", date: "2026-09-16" }]);
    const { unmount } = render(<CountdownMini instanceId="cd2" active />);
    expect(screen.getByText("就是今天")).toBeInTheDocument();
    expect(document.querySelector(".dock-mini-countdown")).toHaveClass("is-today");
    unmount();

    cfg("cd3", [
      { id: "a", label: "远古", date: "2026-01-01" },
      { id: "b", label: "上周", date: "2026-09-09" }
    ]);
    render(<CountdownMini instanceId="cd3" active />);
    expect(screen.getByText("已过去 7 天")).toBeInTheDocument();
    expect(screen.getByText("上周")).toBeInTheDocument();
  });

  it("无实例 / 无目标：占位「—」", () => {
    render(<CountdownMini active />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
