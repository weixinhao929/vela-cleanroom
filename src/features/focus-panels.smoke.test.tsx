/**
 * 专注双面板（番茄钟 / 专注统计）UI 改版冒烟测试：
 * 在 jsdom 下挂载两个面板，验证数值滚动（lib/anim useCountUp，rAF 版）
 * 与新布局结构不抛运行时错误、核心信息可见。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null)
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {})
}));

// SQLite 仓储在浏览器模式不可用，AnalyticsPanel 会走内存口径回退。
vi.mock("../lib/persistence/sqlite", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/persistence/sqlite")>();
  return { ...mod, sqliteRepo: { ...mod.sqliteRepo } };
});

import { PomodoroPanel } from "./pomodoro/PomodoroPanel";
import { AnalyticsPanel } from "./analytics/AnalyticsPanel";
import { useAppStore } from "../store/app-store";

describe("番茄钟面板（改版）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("渲染控制栏 / 表盘 / 操作区 / 统计带", () => {
    render(<PomodoroPanel instanceId="pom-smoke" />);
    expect(screen.getAllByText("专注").length).toBeGreaterThan(0);
    // 主按钮 + 可点击表盘都是「开始专注」
    expect(screen.getAllByRole("button", { name: "开始专注" }).length).toBeGreaterThanOrEqual(1);
    // 统计带四个指标
    expect(screen.getByText("今日专注")).toBeInTheDocument();
    expect(screen.getByText("累计时长")).toBeInTheDocument();
    // 分段控件指示块存在
    expect(document.querySelector(".pomodoro-seg-thumb")).not.toBeNull();
    expect(document.querySelector(".focus-timer")).not.toBeNull();
  });

  it("ZV-2：空闲态（无进行段）不渲染「记录中断」入口——点击 no-op 的死按钮不再出现", () => {
    // 全新启动默认态：mode=focus、倒计时、未运行、剩余=满额。修复引入的
    // planned==null 分支曾让空闲态误判「暂停中」，按钮常驻但 store no-op。
    render(<PomodoroPanel instanceId="pom-zv2" />);
    expect(screen.queryByRole("button", { name: /放弃本次专注并记录原因/ })).not.toBeInTheDocument();
  });
});

describe("专注统计面板（改版）", () => {
  beforeEach(() => {
    localStorage.clear();
    const s = useAppStore.getState();
    useAppStore.setState({ ...s, sessions: [], interruptions: [], tasks: [] });
  });

  it("渲染英雄带 / 今日瓦片 / 图表区块标题", () => {
    render(<AnalyticsPanel instanceId="ana-smoke" />);
    expect(screen.getByText("累计专注时长")).toBeInTheDocument();
    expect(screen.getByText("今日次数")).toBeInTheDocument();
    expect(screen.getByText("本周轮数")).toBeInTheDocument();
    // 任务排行区块已移除（饼图 + 图例承担），分布区块标题仍在
    expect(screen.getAllByText("专注时长分布").length).toBeGreaterThan(0);
    expect(screen.getByText("近 7 天专注趋势")).toBeInTheDocument();
    expect(document.querySelector(".analytics-hero")).not.toBeNull();
    expect(document.querySelectorAll(".metric-tile").length).toBeGreaterThanOrEqual(5);
  });
});
