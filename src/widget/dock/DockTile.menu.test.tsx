/**
 * DockTile 右键 / 长按菜单（ISLAND-CFG · ）组件测试：
 *  - 右键 → 四项菜单；无实例磁贴「配置」打开私有弹层，改动经 setDockTileConfig 写入
 *    DockTile.config 并随 dock 配置落盘（重启保持）；
 *  - 有实例磁贴「配置」打开 WidgetConfigPopover，改动写该实例 widget-config
 *    （与画布卡片同一份数据）；「在画布中定位」复用画布选中态 + 脉冲；
 *  - 「从灵动岛移除」可撤销（toast 撤销恢复原位）；
 *  - 长按 600ms 松手弹菜单且吞掉随之的 click（不展开）；位移 > 4px 取消。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DockTile } from "./DockTile";
import { ContextMenuHost } from "../../components/ContextMenu";
import { ToastHost } from "../../components/ToastHost";
import { parseDockConfig, useWidgetStore, type DockTile as DockTileModel, type WidgetInstance } from "../widget-store";
import { useSettingsStore } from "../../store/settings-store";

/* jsdom 无 PointerEvent：fireEvent.pointer* 会退化成不带 button / pointerId 的 Event，
   长按分支 `e.button !== 0` 直接返回。与 DockTiles.test 同款最小 polyfill。 */
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}
if (typeof window.PointerEvent === "undefined") {
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const KEY = "focus-desk.screen.0.dock.v1";
const dock = () => useWidgetStore.getState().dock;
const stored = () => parseDockConfig(localStorage.getItem(KEY));

const CLOCK: DockTileModel = { id: "t-clock", type: "clock" };
const WEATHER: DockTileModel = { id: "t-weather", type: "weather", instanceId: "w-1" };
const INST: WidgetInstance = { id: "w-1", type: "weather", x: 40, y: 40, w: 240, h: 140, z: 1 };

/** 与 DockTiles 同法：磁贴对象从 store 订阅，setDockTileConfig / 撤销恢复后随 store 重渲。 */
function StoreTile({ id, onOpen }: { id: string; onOpen: (tile: DockTileModel) => void }) {
  const tile = useWidgetStore((s) => s.dock.tiles.find((t) => t.id === id));
  if (!tile) return null;
  return <DockTile tile={tile} takeoverActive={false} isOpen={false} registerRef={() => {}} onOpen={onOpen} />;
}

function mount(tile: DockTileModel, onOpen = vi.fn()) {
  const utils = render(
    <>
      <ContextMenuHost />
      <ToastHost />
      <StoreTile id={tile.id} onOpen={onOpen} />
    </>
  );
  return { ...utils, onOpen, button: screen.getByRole("button", { name: /时钟|天气/ }) };
}

describe("DockTile · 右键菜单", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ settingsPage: "style", settingsOpen: false });
    useWidgetStore.setState({
      dock: { ...parseDockConfig(null), tiles: [CLOCK, WEATHER] },
      dockDrag: null,
      instances: [INST],
      selectedId: null,
      selectedIds: [],
      pulseIds: []
    });
  });
  afterEach(() => {
    fireEvent.keyDown(document, { key: "Escape" });
  });

  it("右键 → 配置 / 在画布中定位（无实例禁用）/ 更多设置 / 从灵动岛移除", () => {
    const { button } = mount(CLOCK);
    fireEvent.contextMenu(button, { clientX: 100, clientY: 20 });
    const menu = screen.getByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
    expect(items).toEqual(["配置", "在画布中定位", "更多设置", "从灵动岛移除"]);
    expect(within(menu).getByRole("menuitem", { name: "在画布中定位" })).toHaveClass("disabled");
    expect(within(menu).getByRole("menuitem", { name: "配置" })).not.toHaveClass("disabled");
  });

  it("无实例磁贴「配置」→ 私有弹层，改「显示秒」写入 DockTile.config 并落盘（重启保持）", async () => {
    const user = userEvent.setup();
    const { button } = mount(CLOCK);
    fireEvent.contextMenu(button, { clientX: 100, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "配置" }));
    // 全量并行跑时 worker 抢 CPU，默认 1s 偶发不够（单跑稳定）→ 放宽到 3s。
    const dialog = await screen.findByRole("dialog", { name: "时钟 配置" }, { timeout: 3000 });
    expect(dialog).toHaveClass("dock-tile-cfg");
    // 私有弹层没有实例级「透明度 / 鼠标穿透」行
    expect(within(dialog).queryByRole("slider", { name: "透明度" })).toBeNull();
    // 时钟 showSeconds 默认 true → 开关初始为开，点一下写 false
    const sw = within(dialog).getByRole("switch", { name: "显示秒" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await user.click(sw);
    const tile = dock().tiles.find((t) => t.id === "t-clock");
    expect(tile?.config?.showSeconds).toBe(false);
    // 经 schema 洗涤：其余字段补默认（face 存在），并且落盘后重新解析仍带 config
    expect(tile?.config?.face).toBeDefined();
    expect(stored().tiles.find((t) => t.id === "t-clock")?.config?.showSeconds).toBe(false);
    // 弹层随 store 重渲：开关显示为关
    expect(within(dialog).getByRole("switch", { name: "显示秒" })).toHaveAttribute("aria-checked", "false");
    // 无实例磁贴挂载即把 tile.config 落种到合成键（折叠态 Mini 的配置源，
    // 与展开面同口径）——除本磁贴合成键外不误写任何 widget-config 键。
    expect(Object.keys(localStorage).filter((k) => k.startsWith("focus-desk.widget-config."))).toEqual([
      "focus-desk.widget-config.dock-tile-t-clock.v1"
    ]);
    // Esc 关闭
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("有实例磁贴「配置」→ B1 弹层，改动写该实例 widget-config（画布卡片同源）", async () => {
    const user = userEvent.setup();
    const { button } = mount(WEATHER);
    fireEvent.contextMenu(button, { clientX: 100, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "天气 配置" }, { timeout: 3000 });
    expect(dialog).not.toHaveClass("dock-tile-cfg");
    await user.click(within(dialog).getByRole("switch", { name: "显示未来预报" }));
    const saved = JSON.parse(localStorage.getItem("focus-desk.widget-config.w-1.v1") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(typeof saved.showForecast).toBe("boolean");
    // 磁贴自身不持有私有 config
    expect(dock().tiles.find((t) => t.id === "t-weather")?.config).toBeUndefined();
  });

  it("「在画布中定位」→ 选中该实例（画布选中态）+ 加入 pulseIds 高亮", async () => {
    const user = userEvent.setup();
    const { button } = mount(WEATHER);
    fireEvent.contextMenu(button, { clientX: 100, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "在画布中定位" }));
    await waitFor(() => {
      const s = useWidgetStore.getState();
      expect(s.selectedId).toBe("w-1");
      expect(s.selectedIds).toEqual(["w-1"]);
      expect(s.pulseIds).toContain("w-1");
    });
  });

  it("「更多设置」：绑定与无实例磁贴统一跳磁贴设置页 dock-tile-<id>（完整组件设置 + 磁贴区）", async () => {
    const user = userEvent.setup();
    const w = mount(WEATHER);
    fireEvent.contextMenu(w.button, { clientX: 100, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "更多设置" }));
    expect(useSettingsStore.getState().settingsPage).toBe("dock-tile-t-weather");
    expect(JSON.parse(localStorage.getItem("focus-desk.pending-nav") ?? "{}")).toMatchObject({
      page: "dock-tile-t-weather"
    });
    w.unmount();
    const c = mount(CLOCK);
    fireEvent.contextMenu(c.button, { clientX: 100, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "更多设置" }));
    expect(useSettingsStore.getState().settingsPage).toBe("dock-tile-t-clock");
    expect(JSON.parse(localStorage.getItem("focus-desk.pending-nav") ?? "{}")).toMatchObject({
      page: "dock-tile-t-clock"
    });
  });

  it("「从灵动岛移除」→ removeDockTile 落盘；toast「撤销」恢复到原下标", async () => {
    const user = userEvent.setup();
    const { button } = mount(CLOCK);
    fireEvent.contextMenu(button, { clientX: 100, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "从灵动岛移除" }));
    expect(dock().tiles.map((t) => t.id)).toEqual(["t-weather"]);
    expect(stored().tiles.map((t) => t.id)).toEqual(["t-weather"]);
    await user.click(await screen.findByRole("button", { name: "撤销" }));
    expect(dock().tiles.map((t) => t.id)).toEqual(["t-clock", "t-weather"]);
    expect(stored().tiles.map((t) => t.id)).toEqual(["t-clock", "t-weather"]);
  });
});

describe("DockTile · 长按 600ms 松手", () => {
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({ dock: { ...parseDockConfig(null), tiles: [CLOCK] }, dockDrag: null });
    // 吞 click 的 400ms 时间窗读 performance.now：一并伪造，advanceTimersByTime 才能越过它。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    fireEvent.keyDown(document, { key: "Escape" });
  });

  it("按住 600ms 松手 → 菜单出现，随之的 click 不展开；不足 600ms 松手 → 正常点击展开", () => {
    const { button, onOpen } = mount(CLOCK);
    fireEvent.pointerDown(button, { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(button).toHaveClass("is-armed");
    fireEvent.pointerUp(button, { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    fireEvent.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(button).not.toHaveClass("is-armed");
    fireEvent.keyDown(document, { key: "Escape" });

    // 短按：不弹菜单，click 正常展开
    fireEvent.pointerDown(button, { button: 0, clientX: 50, clientY: 20, pointerId: 2 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(button, { button: 0, clientX: 50, clientY: 20, pointerId: 2 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("长按期间位移 > 4px（拖动排序手势）→ 取消长按，松手不弹菜单", () => {
    const { button } = mount(CLOCK);
    fireEvent.pointerDown(button, { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(button, { clientX: 70, clientY: 20, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(button).not.toHaveClass("is-armed");
    fireEvent.pointerUp(button, { button: 0, clientX: 70, clientY: 20, pointerId: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
