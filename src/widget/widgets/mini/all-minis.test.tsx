import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { DockTiles } from "../../dock/DockTiles";
import { V1_DOCK_TILE_TYPES } from "../../dock/dock-logic";
import { getWidgetMeta } from "../../registry";
import { createDockTile, useWidgetStore } from "../../widget-store";

/**
 * 集成验收（ISLAND-MINI）：把全部登记了 MiniComponent 的类型经 CORE 的
 * addDockTile 加入岛，DockTiles 渲染后每枚都以富形态落地（懒 chunk 解析完，
 * 无 .is-generic 兜底、无加载占位），根元素带 .dock-mini.dock-mini-<type>
 * （music / nowplaying 共用 dock-mini-music）。浏览器模式（isTauri=false）下
 * 各迷你形态均走无 IPC 的占位路径，不抛错。
 */
vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return { ...mod, isTauri: () => false };
});

const MINI_ROOT: Record<string, string> = { nowplaying: "music" };

beforeEach(() => {
  localStorage.clear();
  useWidgetStore.setState((s) => ({ dock: { ...s.dock, tiles: [] } }));
});

afterEach(() => {
  useWidgetStore.setState((s) => ({ dock: { ...s.dock, tiles: [] } }));
});

describe("全部迷你形态入岛", () => {
  it("14 条富磁贴（v1 三枚 + 首批九种/十条目 + 秒表）经 addDockTile 入岛后全部以富形态渲染", async () => {
    const { addDockTile } = useWidgetStore.getState();
    const richTypes = [
      "brightness",
      "calendar",
      "clipboard",
      "countdown",
      "habit",
      "music",
      "nowplaying",
      "stopwatch",
      "system",
      "todo",
      "weather",
      ...V1_DOCK_TILE_TYPES
    ];
    for (const type of richTypes) addDockTile(createDockTile(type, type === "weather" ? "w-1" : undefined));
    const tiles = useWidgetStore.getState().dock.tiles;
    expect(tiles).toHaveLength(14);

    const { container } = render(
      <DockTiles tiles={tiles} takeoverActive={false} registerTileRef={() => {}} onTileOpen={() => {}} />
    );
    await waitFor(() => expect(container.querySelectorAll(".dock-tile-loading")).toHaveLength(0), { timeout: 5000 });

    expect(container.querySelectorAll(".dock-tile")).toHaveLength(14);
    expect(container.querySelectorAll(".dock-tile.is-generic")).toHaveLength(0);
    for (const type of richTypes) {
      expect(getWidgetMeta(type)?.MiniComponent, type).toBeTruthy();
      const tile = container.querySelector(`.dock-tile-${type}`);
      expect(tile, type).not.toBeNull();
      if (V1_DOCK_TILE_TYPES.includes(type)) continue; // CORE 迁入的三枚不在 .dock-mini 骨架内
      const root = MINI_ROOT[type] ?? type;
      expect(tile!.querySelector(`.dock-mini.dock-mini-${root}`), type).not.toBeNull();
    }
    // 每枚都是可聚焦的 data-interactive 按钮（接管未激活）。
    for (const btn of container.querySelectorAll<HTMLButtonElement>(".dock-tile")) {
      expect(btn).toHaveAttribute("data-interactive");
      expect(btn.tabIndex).toBe(0);
    }
  });
});
