/**
 * 回归锁：removeDockTile 的磁贴私有数据**延迟清理**。
 *
 * 此前 removeDockTile 在移除的同一同步调用里 removeInstanceData（合成
 * widget-config 键 + notes/calendar/sketch 数据桶 + gallery 元数据与磁盘
 * 副本），而「已从灵动岛移除 · 撤销」的 undo 只回插 tile——组件写进合成键
 * 的用户数据（课程表 data/profiles、便签、图库）在点撤销前就永久丢失。
 *
 * 现契约：
 *  - removeDockTile 后数据仍在（toast 撤销窗口内随时可恢复）；
 *  - undo 首步 cancelDockTileDataRemoval → 数据永久保留；
 *  - 撤销窗口关闭 finalizeDockTileDataRemoval → 立即清理；
 *  - 无 undo 的调用方走 15s 兜底定时器清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelDockTileDataRemoval, finalizeDockTileDataRemoval, useWidgetStore, type DockTile } from "../widget-store";

const noInstanceTile = (type = "calculator"): DockTile => ({
  id: "tile-1",
  type
});

/** 模拟组件写进合成键的用户数据（如课程表磁贴展开面板导入的 profiles）。 */
const seedUserData = (tile: DockTile) => {
  localStorage.setItem(
    `focus-desk.widget-config.dock-tile-${tile.id}.v1`,
    JSON.stringify({ data: { profiles: ["课表A"] } })
  );
};

describe("removeDockTile 延迟数据清理（P0-3）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    useWidgetStore.setState({ dock: { ...useWidgetStore.getState().dock, tiles: [] } });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("移除后数据仍在撤销窗口内；undo（cancel）→ 数据完整保留", () => {
    const tile = noInstanceTile();
    useWidgetStore.getState().addDockTile(tile);
    seedUserData(tile);
    useWidgetStore.getState().removeDockTile(tile.id);
    expect(useWidgetStore.getState().dock.tiles).toHaveLength(0);
    // 关键断言：同步移除后数据键仍在（此前立即被删）。
    expect(localStorage.getItem(`focus-desk.widget-config.dock-tile-${tile.id}.v1`)).toBeTruthy();
    // undo 路径：先 cancel 再回插。
    cancelDockTileDataRemoval(tile.id);
    useWidgetStore.getState().addDockTile(tile);
    expect(localStorage.getItem(`focus-desk.widget-config.dock-tile-${tile.id}.v1`)).toContain("课表A");
  });

  it("撤销窗口关闭（finalize）→ 立即清理数据键", () => {
    const tile = noInstanceTile();
    useWidgetStore.getState().addDockTile(tile);
    seedUserData(tile);
    useWidgetStore.getState().removeDockTile(tile.id);
    finalizeDockTileDataRemoval(tile.id);
    expect(localStorage.getItem(`focus-desk.widget-config.dock-tile-${tile.id}.v1`)).toBeNull();
  });

  it("无 undo 的调用方：15s 兜底定时器后清理", () => {
    const tile = noInstanceTile();
    useWidgetStore.getState().addDockTile(tile);
    seedUserData(tile);
    useWidgetStore.getState().removeDockTile(tile.id);
    vi.advanceTimersByTime(10_000);
    expect(localStorage.getItem(`focus-desk.widget-config.dock-tile-${tile.id}.v1`)).toBeTruthy();
    vi.advanceTimersByTime(6_000);
    expect(localStorage.getItem(`focus-desk.widget-config.dock-tile-${tile.id}.v1`)).toBeNull();
  });

  it("绑定实例的磁贴移除：不触碰任何实例数据（延迟清理只针对无实例磁贴）", () => {
    const tile: DockTile = { id: "tile-2", type: "notes", instanceId: "inst-9" };
    useWidgetStore.getState().addDockTile(tile);
    localStorage.setItem("focus-desk.notes.inst-9", JSON.stringify([{ id: "n", text: "x" }]));
    useWidgetStore.getState().removeDockTile(tile.id);
    vi.advanceTimersByTime(20_000);
    expect(localStorage.getItem("focus-desk.notes.inst-9")).toBeTruthy();
  });

  it("移除 → 撤销 → 再移除：第二次撤销窗口内数据仍受保护（重复调度不误删）", () => {
    const tile = noInstanceTile();
    useWidgetStore.getState().addDockTile(tile);
    seedUserData(tile);
    useWidgetStore.getState().removeDockTile(tile.id);
    cancelDockTileDataRemoval(tile.id);
    useWidgetStore.getState().addDockTile(tile);
    useWidgetStore.getState().removeDockTile(tile.id);
    vi.advanceTimersByTime(5_000);
    expect(localStorage.getItem(`focus-desk.widget-config.dock-tile-${tile.id}.v1`)).toBeTruthy();
    finalizeDockTileDataRemoval(tile.id);
    expect(localStorage.getItem(`focus-desk.widget-config.dock-tile-${tile.id}.v1`)).toBeNull();
  });
});
