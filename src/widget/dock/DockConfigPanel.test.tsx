/**
 * 编辑模式浮层 DockConfigPanel（ISLAND-CFG · F-6 快捷项 + F-2 入口 c）组件测试：
 * 快捷项（启用 / 吸附 + 偏移 / 悬停 / 接管三开关）经 CORE 动作即时落盘；
 * 已入岛磁贴芯片行 ↑↓ 排序、× 移除、「+」下拉追加（registry 任意类型）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DockConfigPanel } from "./DockConfigPanel";
import { parseDockConfig, useWidgetStore } from "../widget-store";

const KEY = "focus-desk.screen.0.dock.v1";
const dock = () => useWidgetStore.getState().dock;
const stored = () => parseDockConfig(localStorage.getItem(KEY));
const chipNames = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector(".dock-cfg-tile-name")?.textContent ?? "");

describe("DockConfigPanel · 快捷项", () => {
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({ dock: parseDockConfig(null), dockDrag: null });
  });

  it("启用 / 悬停 / 接管开关全部即时写入 store 并落盘；不再有「贴边 顶 / 底」分段", async () => {
    const user = userEvent.setup();
    render(<DockConfigPanel />);
    await user.click(screen.getByRole("switch", { name: "启用灵动岛" }));
    expect(dock().enabled).toBe(true);
    expect(screen.queryByRole("radiogroup", { name: "贴边" })).toBeNull();
    await user.click(
      within(screen.getByRole("radiogroup", { name: "悬停" })).getByRole("radio", { name: "展开首磁贴" })
    );
    expect(dock().mouse.hover).toBe("expand-first");
    await user.click(screen.getByRole("switch", { name: "媒体接管" }));
    await user.click(screen.getByRole("switch", { name: "通知接管" }));
    expect(dock().takeover).toEqual({
      pomodoro: true,
      media: false,
      notification: false,
      brightness: true,
      volume: true,
      link: true,
      durationMs: 6000
    });
    expect(stored()).toEqual(dock());
  });

  it("位置吸附：左 / 居中 / 右 写规范偏移；自由位解锁偏移滑条并保持当前偏移", async () => {
    const user = userEvent.setup();
    render(<DockConfigPanel />);
    const group = screen.getByRole("radiogroup", { name: "位置吸附" });
    const slider = () => screen.getByRole("slider", { name: "偏移" });
    expect(slider()).toBeDisabled();
    await user.click(within(group).getByRole("radio", { name: "右" }));
    expect(dock()).toMatchObject({ snap: "end", offset: 1 });
    await user.click(within(group).getByRole("radio", { name: "自由" }));
    expect(dock()).toMatchObject({ snap: "free", offset: 1 });
    expect(slider()).toBeEnabled();
    // WakeSlider 无原生 input：键盘从当前偏移 100 步进回 25。
    slider().focus();
    for (let i = 0; i < 75; i++) fireEvent.keyDown(slider(), { key: "ArrowLeft" });
    expect(dock()).toMatchObject({ snap: "free", offset: 0.25 });
    await user.click(within(group).getByRole("radio", { name: "居中" }));
    expect(dock()).toMatchObject({ snap: "center", offset: 0.5 });
    expect(stored()).toMatchObject({ snap: "center", offset: 0.5 });
  });

  it("radiogroup 方向键切换（ArrowRight 到下一项）", () => {
    render(<DockConfigPanel />);
    const none = within(screen.getByRole("radiogroup", { name: "悬停" })).getByRole("radio", { name: "无" });
    fireEvent.keyDown(none, { key: "ArrowRight" });
    expect(dock().mouse.hover).toBe("peak");
  });
});

describe("DockConfigPanel · 已入岛磁贴芯片行", () => {
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({ dock: parseDockConfig(null), dockDrag: null });
  });

  it("按 tiles 顺序渲染芯片；首枚「上移」与末枚「下移」禁用", () => {
    render(<DockConfigPanel />);
    expect(chipNames()).toEqual(["时钟", "番茄钟", "通知中心"]);
    expect(screen.getByRole("button", { name: "上移 时钟" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移 时钟" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "下移 通知中心" })).toBeDisabled();
  });

  it("↓ 排序 → moveDockTile 落盘；× 移除 → 先播收缩退场再 removeDockTile 落盘（保留其余磁贴 id）", async () => {
    const user = userEvent.setup();
    render(<DockConfigPanel />);
    await user.click(screen.getByRole("button", { name: "下移 时钟" }));
    expect(chipNames()).toEqual(["番茄钟", "时钟", "通知中心"]);
    expect(stored().tiles.map((t) => t.type)).toEqual(["pomodoro", "clock", "notifications"]);
    await user.click(screen.getByRole("button", { name: "移除 番茄钟" }));
    // 移除走延迟提交（退场收缩播完才落盘），退场帧内芯片仍挂载。
    await waitFor(() => expect(chipNames()).toEqual(["时钟", "通知中心"]));
    expect(stored().tiles.map((t) => t.id)).toEqual(["dock-tile-clock", "dock-tile-notifications"]);
  });

  it("「+」打开类型菜单（registry 全部类型），选「计算器」追加通用磁贴到末尾；已在岛上的类型禁用；Esc 关闭菜单", async () => {
    const user = userEvent.setup();
    render(<DockConfigPanel />);
    const add = screen.getByRole("button", { name: "添加磁贴" });
    expect(add).toHaveAttribute("aria-expanded", "false");
    await user.click(add);
    const menu = screen.getByRole("menu", { name: "添加磁贴" });
    expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(10);
    // 入岛去重：默认三磁贴（无实例）对应类型在菜单里禁用，与图库入口同一规则。
    expect(within(menu).getByRole("menuitem", { name: "时钟" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "计算器" })).toBeEnabled();
    await user.click(within(menu).getByRole("menuitem", { name: "计算器" }));
    // 选中后退场帧（is-closing）内菜单仍挂载，播完（fxXfast ≈120ms）才卸载。
    expect(screen.getByRole("menu")).toHaveClass("is-closing");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(chipNames()).toEqual(["时钟", "番茄钟", "通知中心", "计算器"]);
    const added = stored().tiles[3];
    expect(added.type).toBe("calculator");
    expect(added.id).not.toBe("");
    expect(added.instanceId).toBeUndefined();
    // Esc 关闭（同样经退场帧延迟卸载）
    await user.click(screen.getByRole("button", { name: "添加磁贴" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("空列表显示占位提示；已绑定实例的磁贴带 accent 小点", () => {
    useWidgetStore.setState({ dock: { ...parseDockConfig(null), tiles: [] } });
    const { unmount } = render(<DockConfigPanel />);
    expect(screen.getByText("暂无磁贴，点「+」添加")).toBeInTheDocument();
    unmount();
    useWidgetStore.setState({
      dock: {
        ...parseDockConfig(null),
        tiles: [
          { id: "t-w", type: "weather", instanceId: "inst-1" },
          { id: "t-c", type: "clock" }
        ]
      }
    });
    render(<DockConfigPanel />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].querySelector(".dock-cfg-tile-bound")).not.toBeNull();
    expect(items[1].querySelector(".dock-cfg-tile-bound")).toBeNull();
  });
});
