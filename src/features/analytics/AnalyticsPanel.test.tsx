/**
 * 专注统计面板 UI 回归（此前仅一条冒烟）：热图 tab 切换与语义、天粒度配置、
 * 目标模式文案、月度打断图渲染。浏览器模式（无 Tauri）走内存口径。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null)
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {})
}));

import { AnalyticsPanel } from "./AnalyticsPanel";
import { useAppStore } from "../../store/app-store";
import { useSettingsStore } from "../../store/settings-store";

const INSTANCE = "ana-test";

function seedConfig(config: Record<string, unknown>) {
  localStorage.setItem(`focus-desk.widget-config.${INSTANCE}.v1`, JSON.stringify(config));
}

let seq = 0;
function session(over: Record<string, unknown>): void {
  const base = {
    id: `test-session-${++seq}`,
    type: "focus",
    mode: "focus",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    plannedSeconds: 1500,
    completed: true,
    taskId: null,
    eventLabel: null,
    ...over
  };
  useAppStore.setState((s) => ({ sessions: [...s.sessions, base as never] }));
}

describe("AnalyticsPanel UI", () => {
  beforeEach(() => {
    localStorage.clear();
    const s = useAppStore.getState();
    useAppStore.setState({
      ...s,
      sessions: [],
      interruptions: [],
      tasks: [],
      pomodoroConfig: { ...s.pomodoroConfig, dailyGoalSessions: 0, dailyGoalMode: "sessions", dailyGoalMinutes: 0 }
    });
    useSettingsStore.setState((s2) => ({ ...s2, extra: { ...s2.extra, virtualMidnightHour: 0 } }));
  });

  it("热图 tab：tablist/tab 语义齐全，切到本年出现年导航，翻年后「今年」一键回位", async () => {
    render(<AnalyticsPanel instanceId={INSTANCE} />);
    const tablist = screen.getByRole("tablist");
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const yearTab = screen.getByRole("tab", { name: "本年" });
    expect(yearTab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(yearTab);
    expect(yearTab.getAttribute("aria-selected")).toBe("true");
    // 年视图经 120ms 淡出后换挂载——findBy 兜住这拍延迟。
    expect(await screen.findByLabelText("上一年")).toBeInTheDocument();
    expect(screen.queryByText("今年")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("上一年"));
    expect(screen.getByText("今年")).toBeInTheDocument();
    fireEvent.click(screen.getByText("今年"));
    expect(screen.queryByText("今年")).not.toBeInTheDocument();
    expect(document.querySelector(".year-value")?.textContent).toBe(String(new Date().getFullYear()));
  });

  it("显示天数配置驱动趋势标题（days=3）", () => {
    seedConfig({ days: 3, showMonthHeatmap: true });
    render(<AnalyticsPanel instanceId={INSTANCE} />);
    expect(screen.getByText("近 3 天专注趋势")).toBeInTheDocument();
  });

  it("目标文案：未设目标（隐藏 chip）/ 轮数目标 / 分钟目标三态", () => {
    seedConfig({});
    const { rerender } = render(<AnalyticsPanel instanceId={INSTANCE} />);
    // goal=0 时不再渲染「0 连续达标/未设目标」chip（与番茄钟面板的
    // 隐藏策略一致）。
    expect(screen.queryByText("未设目标")).not.toBeInTheDocument();
    expect(screen.queryByText("连续达标")).not.toBeInTheDocument();

    act(() => {
      const s = useAppStore.getState();
      useAppStore.setState({ ...s, pomodoroConfig: { ...s.pomodoroConfig, dailyGoalSessions: 8 } });
    });
    rerender(<AnalyticsPanel instanceId={INSTANCE} />);
    expect(screen.getByText("目标 8 轮/天")).toBeInTheDocument();

    act(() => {
      const s = useAppStore.getState();
      useAppStore.setState({
        ...s,
        pomodoroConfig: { ...s.pomodoroConfig, dailyGoalMode: "minutes", dailyGoalMinutes: 120 }
      });
    });
    rerender(<AnalyticsPanel instanceId={INSTANCE} />);
    expect(screen.getByText("目标 2小时/天")).toBeInTheDocument();
  });

  it("月度打断原因列表渲染（内存口径）与空态", () => {
    seedConfig({});
    const { rerender } = render(<AnalyticsPanel instanceId={INSTANCE} />);
    expect(screen.getByText("本月暂无中断记录，保持专注！")).toBeInTheDocument();

    act(() => {
      const s = useAppStore.getState();
      useAppStore.setState({
        ...s,
        interruptions: [
          {
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            reason: "电话",
            mode: "focus",
            elapsedSeconds: 60
          },
          {
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            reason: "电话",
            mode: "focus",
            elapsedSeconds: 60
          },
          {
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            reason: "消息",
            mode: "focus",
            elapsedSeconds: 60
          }
        ]
      });
    });
    rerender(<AnalyticsPanel instanceId={INSTANCE} />);
    expect(screen.getAllByText("电话").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("消息").length).toBeGreaterThanOrEqual(1);
  });

  it("今日瓦片按起始虚拟日归属：vmHour=4 时凌晨段计入昨日（今日时长为 0）", () => {
    seedConfig({});
    act(() => {
      useSettingsStore.setState((s) => ({ ...s, extra: { ...s.extra, virtualMidnightHour: 4 } }));
    });
    // 本地凌晨 01:00 的段在 vm=4 下属昨日虚拟日。
    const early = new Date();
    early.setHours(1, 0, 0, 0);
    if (early.getTime() > Date.now()) early.setDate(early.getDate() - 1);
    session({ startedAt: early.toISOString(), endedAt: new Date(early.getTime() + 1500_000).toISOString() });
    render(<AnalyticsPanel instanceId={INSTANCE} />);
    // 「今日时长」瓦片的数值为 0（凌晨段归昨日）；单位 em 与数值同节点。
    const tiles = Array.from(document.querySelectorAll(".metric-tile"));
    const minutesTile = tiles.find((t) => t.textContent?.includes("今日时长"));
    expect(minutesTile?.querySelector(".metric-tile-value")?.textContent).toContain("0");
  });
});
