/**
 * 设置页「灵动岛」（ISLAND-CFG · F-6）组件测试：v2 全部字段（含外形 bangs / QQ 式
 * 自动隐藏开关 / 顶部内边距）经页面控件改动后即时写入 widget-store.dock 并按屏落盘
 * （focus-desk.screen.0.dock.v1），重新解析持久化载荷与内存一致（刷新保持）；
 * B2 行可达性（leading 图标 / aria-label）；settings-search 索引命中「灵动岛」「接管」；
 * Dropdown 键盘可达回归。「贴边 顶 / 底」选择已移除，页面不再有该分段。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DockPage } from "./DockPage";
import { searchSettings } from "../settings-search";
import { parseDockConfig, useWidgetStore } from "../../../widget/widget-store";
import { useSettingsStore } from "../../../store/settings-store";

/** WakeSlider 无原生 input：键盘驱动（Home 归 min → N 次方向键）。 */
function keySlider(label: string, value: number, min: number) {
  const s = screen.getByRole("slider", { name: label });
  s.focus();
  fireEvent.keyDown(s, { key: "Home" });
  for (let i = 0; i < value - min; i++) fireEvent.keyDown(s, { key: "ArrowRight" });
}

/** jsdom 无 #screen hash → 分区 "0"。 */
const KEY = "focus-desk.screen.0.dock.v1";
const dock = () => useWidgetStore.getState().dock;
const stored = () => parseDockConfig(localStorage.getItem(KEY));

describe("DockPage · 七字段即时生效 + 按屏落盘 + 刷新保持", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ settingsPage: "style", settingsOpen: false });
    useWidgetStore.setState({ dock: parseDockConfig(null), dockDrag: null });
  });

  it("enabled：开关「启用灵动岛」→ dock.enabled 翻转并落盘", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    const sw = screen.getByRole("switch", { name: "启用灵动岛" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);
    expect(dock().enabled).toBe(true);
    expect(stored().enabled).toBe(true);
    expect(screen.getByRole("switch", { name: "启用灵动岛" })).toHaveAttribute("aria-checked", "true");
  });

  it("edge：页面不再提供「贴边 顶 / 底」分段（贴底边已退役，岛只贴顶边）", () => {
    render(<DockPage />);
    expect(screen.queryByRole("group", { name: "贴边" })).toBeNull();
    expect(dock().edge).toBe("top");
  });

  it("snap：选「左」吸附到 offset 0；选「自由」保持偏移并解锁偏移滑条", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    const offset = screen.getByRole("slider", { name: "偏移" });
    // 默认 center：滑条被 fieldset[disabled] 禁用。
    expect(offset).toBeDisabled();
    const group = screen.getByRole("group", { name: "位置吸附" });
    await user.click(within(group).getByRole("radio", { name: "左" }));
    expect(dock().snap).toBe("start");
    expect(dock().offset).toBe(0);
    await user.click(within(group).getByRole("radio", { name: "自由" }));
    expect(dock().snap).toBe("free");
    expect(dock().offset).toBe(0);
    expect(screen.getByRole("slider", { name: "偏移" })).toBeEnabled();
    keySlider("偏移", 30, 0);
    expect(dock().offset).toBeCloseTo(0.3);
    expect(stored().snap).toBe("free");
    expect(stored().offset).toBeCloseTo(0.3);
  });

  it("mouse.hover：「悬停」下拉选「微涨」→ mouse.hover = peak（其余鼠标项不变）", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    const group = screen.getByRole("group", { name: "悬停" });
    await user.click(within(group).getByRole("button"));
    await user.click(screen.getByRole("option", { name: "微涨" }));
    expect(dock().mouse).toEqual({ hover: "peak", blank: "none", middle: "collapse", wheel: "none" });
    expect(stored().mouse.hover).toBe("peak");
  });

  it("takeover.media：关闭「媒体接管」→ takeover.media = false，其余接管项与时长不变", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    await user.click(screen.getByRole("switch", { name: "媒体接管" }));
    expect(dock().takeover).toEqual({
      pomodoro: true,
      media: false,
      notification: true,
      brightness: true,
      volume: true,
      link: true,
      durationMs: 6000
    });
    expect(stored().takeover.media).toBe(false);
    keySlider("展示时长", 9, 3);
    expect(dock().takeover.durationMs).toBe(9000);
    expect(stored().takeover.durationMs).toBe(9000);
  });

  it("autoHide（一.6）：关闭 / 常驻收起 / 仅播放时显示三段；不再有开关与空闲时长滑条", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    expect(screen.queryByRole("switch", { name: "自动隐藏" })).toBeNull();
    expect(screen.queryByText("空闲时长")).toBeNull();
    const group = screen.getByRole("group", { name: "自动隐藏" });
    // 默认关闭。
    expect(dock().autoHide).toBe(false);
    // 常驻收起。
    await user.click(within(group).getByRole("radio", { name: "常驻收起" }));
    expect(dock().autoHide).toBe(true);
    expect(stored().autoHide).toBe(true);
    // 仅播放时显示（一.6 新模式，字符串载荷）。
    await user.click(within(group).getByRole("radio", { name: "仅播放时" }));
    expect(dock().autoHide).toBe("when-playing");
    expect(stored().autoHide).toBe("when-playing");
    // 回到关闭。
    await user.click(within(group).getByRole("radio", { name: "关闭" }));
    expect(dock().autoHide).toBe(false);
    expect(stored().autoHide).toBe(false);
  });

  it("density：选「48」→ density = 48（数字类型，非字符串）", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    const group = screen.getByRole("group", { name: "密度" });
    await user.click(within(group).getByRole("radio", { name: "48" }));
    expect(dock().density).toBe(48);
    expect(stored().density).toBe(48);
  });

  it("面板形态 / 外形：网格落盘；「贴边刘海」可选 → style = bangs 并落盘", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    await user.click(within(screen.getByRole("group", { name: "面板形态" })).getByRole("radio", { name: "网格" }));
    expect(dock().panel.mode).toBe("grid");
    expect(stored().panel.mode).toBe("grid");
    const shape = screen.getByRole("group", { name: "外形" });
    expect(within(shape).getByRole("radio", { name: "胶囊" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(shape).getByRole("radio", { name: "贴边刘海" }));
    expect(dock().style).toBe("bangs");
    expect(stored().style).toBe("bangs");
    await user.click(within(shape).getByRole("radio", { name: "胶囊" }));
    expect(dock().style).toBe("pill");
  });

  it("topInset：「顶部内边距」滑条 0–64px → dock.topInset 并落盘", () => {
    render(<DockPage />);
    const inset = screen.getByRole("slider", { name: "顶部内边距" });
    expect(inset.getAttribute("aria-valuenow")).toBe("10");
    keySlider("顶部内边距", 24, 0);
    expect(dock().topInset).toBe(24);
    expect(stored().topInset).toBe(24);
  });

  it("刷新保持：多项改动后重新解析持久化载荷与内存 dock 深等", async () => {
    const user = userEvent.setup();
    render(<DockPage />);
    await user.click(screen.getByRole("switch", { name: "启用灵动岛" }));
    await user.click(within(screen.getByRole("group", { name: "自动隐藏" })).getByRole("radio", { name: "常驻收起" }));
    await user.click(within(screen.getByRole("group", { name: "密度" })).getByRole("radio", { name: "36" }));
    await user.click(screen.getByRole("switch", { name: "通知接管" }));
    expect(stored()).toEqual(dock());
    expect(stored().version).toBe(2);
  });
});

describe("DockPage · 可达性与搜索索引", () => {
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({ dock: parseDockConfig(null), dockDrag: null });
  });

  it("每行都有 leading 图标；分段 / 下拉外包 group 带 aria-label；开关 / 滑条带可访问名", () => {
    render(<DockPage />);
    const rows = document.querySelectorAll(".tm-setting-row");
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) expect(row.querySelector(".tm-setting-leading")).not.toBeNull();
    for (const g of screen.getAllByRole("group")) expect(g.getAttribute("aria-label")).toBeTruthy();
    for (const sw of screen.getAllByRole("switch")) expect(sw.getAttribute("aria-label")).toBeTruthy();
    for (const s of screen.getAllByRole("slider")) expect(s.getAttribute("aria-label")).toBeTruthy();
    // 曾标「即将推出」的三项（贴边刘海 / 空闲分钟数 / 顶部内边距）均已接线，页面不再有占位徽标。
    expect(screen.queryByText(/即将推出/)).toBeNull();
    expect(screen.getByRole("slider", { name: "顶部内边距" })).toBeInTheDocument();
  });

  it("Dropdown 键盘可达（回归基线）：Enter 打开 → ↓ → Enter 选中「微涨」", async () => {
    render(<DockPage />);
    const trigger = within(screen.getByRole("group", { name: "悬停" })).getByRole("button");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const listbox = await screen.findByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(dock().mouse.hover).toBe("peak");
  });

  it("settings-search：「灵动岛」「接管」「dock」都命中 page=dock", () => {
    expect(searchSettings("灵动岛").some((e) => e.page === "dock")).toBe(true);
    expect(searchSettings("接管").some((e) => e.page === "dock" && e.title === "接管")).toBe(true);
    expect(searchSettings("dock").some((e) => e.page === "dock")).toBe(true);
    expect(searchSettings("自动隐藏").some((e) => e.page === "dock")).toBe(true);
  });
});
