import { describe, expect, it } from "vitest";
import { getWidgetMeta, WIDGET_REGISTRY } from "../registry";
import { DOCK_EXPAND_PREFIX, DOCK_PANEL_EXPAND_ID, dockTileExpandId, V1_DOCK_TILE_TYPES } from "./dock-logic";
import { dockTileTitle } from "./DockTile";

/**
 * F-1 验收：registry 的每个类型都能渲染为 DockTile——要么登记了 MiniComponent
 * （富磁贴），要么 GenericMiniTile 所需的 icon / name / component 齐备（通用磁贴
 * + 完整组件兜底展开）。DockTile 的分派只依赖这些元数据，这里遍历断言。
 */
describe("registry 迷你形态遍历（每个类型都能渲染为 DockTile）", () => {
  it("WIDGET_REGISTRY 每个条目：MiniComponent 或通用磁贴所需元数据齐备", () => {
    expect(WIDGET_REGISTRY.length).toBeGreaterThan(0);
    for (const meta of WIDGET_REGISTRY) {
      const generic = !!meta.icon && meta.name.length > 0 && !!meta.component;
      expect(generic, `${meta.type} 缺通用磁贴元数据`).toBe(true);
      expect(!!meta.MiniComponent || generic, `${meta.type} 不可渲染为 DockTile`).toBe(true);
      if (meta.miniSummary) expect(typeof meta.miniSummary("any")).toBe("string");
    }
  });

  it("富磁贴：v1 三枚 + ISLAND-MINI 首批九种（music/nowplaying 共用）+ 「杂项」已登记 MiniComponent，其余走通用磁贴", () => {
    for (const t of V1_DOCK_TILE_TYPES) expect(getWidgetMeta(t)?.MiniComponent, t).toBeTruthy();
    const MINI_BATCH_1 = [
      "brightness",
      "calendar",
      "clipboard",
      "countdown",
      "habit",
      "music",
      "stopwatch",
      "nowplaying",
      "system",
      "todo",
      "weather"
    ];
    /* 「杂项」面板只在灵动岛可用（dockOnly），画布图库不列出。 */
    const DOCK_ONLY = ["misc"];
    const rich = WIDGET_REGISTRY.filter((m) => m.MiniComponent)
      .map((m) => m.type)
      .sort();
    expect(rich).toEqual([...V1_DOCK_TILE_TYPES, ...MINI_BATCH_1, ...DOCK_ONLY].sort());
    expect(WIDGET_REGISTRY.filter((m) => m.dockOnly).map((m) => m.type)).toEqual(DOCK_ONLY);
    // music 与 nowplaying 共用同一枚 MusicMini（同一 lazyMini 实例）。
    expect(getWidgetMeta("music")?.MiniComponent).toBe(getWidgetMeta("nowplaying")?.MiniComponent);
  });

  it("磁贴标题：registry name（时钟 / 番茄钟 / 通知中心，与 2.0 前 TILE_LABEL 一致）；未知类型退回类型 id", () => {
    expect(dockTileTitle({ id: "a", type: "clock" })).toBe("时钟");
    expect(dockTileTitle({ id: "b", type: "pomodoro" })).toBe("番茄钟");
    expect(dockTileTitle({ id: "c", type: "notifications" })).toBe("通知中心");
    expect(dockTileTitle({ id: "d", type: "weather" })).toBe("天气");
    expect(dockTileTitle({ id: "e", type: "no-such-type" })).toBe("no-such-type");
  });

  it("expand id：磁贴 dock:<tileId>，全岛面板 dock:panel 共享前缀但不与任何 uuid 磁贴撞名", () => {
    expect(dockTileExpandId("abc")).toBe("dock:abc");
    expect(dockTileExpandId("abc").startsWith(DOCK_EXPAND_PREFIX)).toBe(true);
    expect(DOCK_PANEL_EXPAND_ID).toBe("dock:panel");
    expect(DOCK_PANEL_EXPAND_ID.startsWith(DOCK_EXPAND_PREFIX)).toBe(true);
    expect(dockTileExpandId(crypto.randomUUID())).not.toBe(DOCK_PANEL_EXPAND_ID);
  });
});
