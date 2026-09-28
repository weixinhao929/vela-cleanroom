/* eslint-disable react-refresh/only-export-components */
/**
 * 画布卡片拖入岛（F-2 入口 a，DROP 会话）：命中检测 + 高亮 / 插入位 / 幽灵芯片。
 *
 * 数据契约（CORE 已建）：widget-store.dockDrag 瞬态 {pointer, overIsland, insertIndex}，
 * 由画布卡片拖入（本文件）与岛内排序（DockTiles，REORDER 会话）共用。
 * WidgetCard 拖动的每个 rAF 只写 pointer；本组件用 store.subscribe **同步**订阅：
 *  - 拖动会话开始（dockDrag null → 非 null）读一次 DOM 缓存：岛矩形（.dock 外扩
 *    DROP_HIT_MARGIN）、磁贴矩形（DOM 顺序 = 排布顺序）、被拖卡片类型
 *    （.widget-card.dragging 的 data-widget-type）；会话结束（null）清缓存。
 *    **没有 .widget-card.dragging 即不是画布卡片拖动**（岛内排序 / 岛位移也写
 *    dockDrag），整段会话不计算、不回写、不渲染，不干扰其他写方的让位规则。
 *  - 之后每帧只做一次矩形包含判断 + insertionIndexAt，结果有变化才 setDockDrag
 *    回写。回写发生在 WidgetCard 那次 set 的同步通知链里，pointerup 读到的
 *    overIsland 不会落后一帧（React 渲染 / effect 的异步间隙不参与判定）。
 *
 * 渲染只在 overIsland 时出现（指针离开命中区即清除），Portal 到 body——.dock 自带
 * translateX(-50%)，fixed 子元素会以它为包含块。三件预览：岛高亮描边
 * （--accent 45%）、插入位 2px 竖条（槽位变化时 transform 滑动；DockTiles 的共用
 * InsertBar 在场时由 CSS 隐藏本竖条，避免双条）、指针处幽灵芯片（类型图标 + 名称 +
 * D1 语义提示，scale 1.04，拖动 ghost）。
 * 全部 pointer-events:none；位置走 transform，动效只碰 opacity / transform。
 * 样式在 feature-dock.css 的 ══ DROP ══ 区段。
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n-lite";
import { getWidgetMeta } from "../registry";
import { useWidgetStore, type DockDrag } from "../widget-store";
import { insertionIndexAt } from "./dock-logic";

/** 岛命中区外扩（px）：指针离胶囊边缘这么近就算命中，投放不必精确压在岛上。 */
export const DROP_HIT_MARGIN = 24;

/** `.dock-tiles` 的 flex gap（px）：插入竖条落在相邻磁贴的间隙中线。 */
const TILE_GAP = 4;

export type DropCache = {
  /** 岛本体视口矩形（高亮描边用）。 */
  island: { left: number; top: number; width: number; height: number };
  /** 外扩后的命中区。 */
  hit: { left: number; top: number; right: number; bottom: number };
  /** 磁贴视口矩形，DOM 顺序即排布顺序（insertionIndexAt 的输入）。 */
  tiles: { left: number; width: number }[];
  /** 被拖卡片的 registry 类型（幽灵芯片图标 / 名称）。 */
  type: string;
};

/**
 * 拖动会话开始时读一次 DOM。返回 null 的两种情况都表示「本次拖动与画布拖入无关」：
 * 页面无 .dock（岛未启用，没有投放目标）、或没有 .widget-card.dragging（不是画布
 * 卡片在拖，而是岛内排序 / 岛位移等其他 dockDrag 写方）。
 */
export function readDropCache(doc: Document = document): DropCache | null {
  const dragging = doc.querySelector(".widget-card.dragging");
  const type = dragging?.getAttribute("data-widget-type");
  if (!type) return null;
  const dockEl = doc.querySelector(".dock");
  if (!dockEl) return null;
  const r = dockEl.getBoundingClientRect();
  const tiles = Array.from(dockEl.querySelectorAll(".dock-tiles > .dock-tile"), (el) => {
    const t = el.getBoundingClientRect();
    return { left: t.left, width: t.width };
  });
  return {
    island: { left: r.left, top: r.top, width: r.width, height: r.height },
    hit: {
      left: r.left - DROP_HIT_MARGIN,
      top: r.top - DROP_HIT_MARGIN,
      right: r.right + DROP_HIT_MARGIN,
      bottom: r.bottom + DROP_HIT_MARGIN
    },
    tiles,
    type
  };
}

/** 纯函数：指针对缓存几何求 {overIsland, insertIndex}；岛外 insertIndex 归 0。 */
export function resolveDrop(
  cache: DropCache,
  pointer: { x: number; y: number }
): { overIsland: boolean; insertIndex: number } {
  const { hit } = cache;
  const over = pointer.x >= hit.left && pointer.x <= hit.right && pointer.y >= hit.top && pointer.y <= hit.bottom;
  return { overIsland: over, insertIndex: over ? insertionIndexAt(cache.tiles, pointer.x) : 0 };
}

/** 插入竖条中心 x：落在目标槽位两侧磁贴的间隙中线；空岛取岛中心。 */
export function insertionBarX(cache: DropCache, insertIndex: number): number {
  const { tiles, island } = cache;
  if (tiles.length === 0) return island.left + island.width / 2;
  if (insertIndex >= tiles.length) {
    const last = tiles[tiles.length - 1];
    return last.left + last.width + TILE_GAP / 2;
  }
  return tiles[Math.max(0, insertIndex)].left - TILE_GAP / 2;
}

export function DockDropZone() {
  const tr = useT();
  /* 细粒度订阅：只在布尔 / 槽位变化时重渲。此前整对象订阅 s.dockDrag——画布
     任意卡片拖动的每个 rAF 都写新对象，本组件（即使指针远离岛、返回 null）
     也要跑一遍 render + vdom diff。指针坐标经下方 subscribe 直写幽灵芯片
     transform，不参与 React 渲染。 */
  const overIsland = useWidgetStore((s) => s.dockDrag?.overIsland ?? false);
  const insertIndex = useWidgetStore((s) => s.dockDrag?.insertIndex ?? 0);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  /* 一次拖动会话的缓存：null = 会话未开始；{cache:null} = 已判定与画布拖入无关
     （不再每帧重读 DOM）；{cache} = 画布卡片在拖，几何已缓存。 */
  const session = useRef<{ cache: DropCache | null } | null>(null);

  useEffect(() => {
    const sync = (d: DockDrag | null) => {
      if (!d) {
        session.current = null;
        return;
      }
      if (!session.current) session.current = { cache: readDropCache() };
      const c = session.current.cache;
      if (!c || !d.pointer) return;
      const next = resolveDrop(c, d.pointer);
      if (next.overIsland !== d.overIsland || next.insertIndex !== d.insertIndex) {
        useWidgetStore.getState().setDockDrag({ pointer: d.pointer, ...next });
      }
    };
    /* 幽灵芯片跟随指针：订阅回调里直写 transform（写方已保证一帧一次）。 */
    const moveGhost = (d: DockDrag | null) => {
      const el = ghostRef.current;
      if (el && d?.pointer) {
        el.style.transform = `translate3d(${d.pointer.x + 14}px, ${d.pointer.y + 18}px, 0) scale(1.04)`;
      }
    };
    sync(useWidgetStore.getState().dockDrag);
    moveGhost(useWidgetStore.getState().dockDrag);
    return useWidgetStore.subscribe((s, prev) => {
      if (s.dockDrag !== prev.dockDrag) {
        sync(s.dockDrag);
        moveGhost(s.dockDrag);
      }
    });
  }, []);

  const c = session.current?.cache ?? null;
  if (!overIsland || !c) return null;

  /* 挂载/槽位变化时刻的指针位置（非响应式读取即可：后续帧由 moveGhost 直写）。 */
  const { x, y } = useWidgetStore.getState().dockDrag?.pointer ?? { x: 0, y: 0 };
  const meta = getWidgetMeta(c.type);
  const Icon = meta?.icon;
  const name = meta ? tr(meta.name) : c.type;
  const barX = insertionBarX(c, insertIndex);
  const barTop = c.island.top + 5;
  const barHeight = Math.max(8, c.island.height - 10);

  return createPortal(
    <div className="dock-drop" aria-hidden="true" data-testid="dock-drop">
      <div
        className="dock-drop-ring"
        style={{
          left: c.island.left,
          top: c.island.top,
          width: c.island.width,
          height: c.island.height,
          borderRadius: c.island.height / 2
        }}
      />
      <div
        className="dock-drop-bar"
        data-insert-index={insertIndex}
        style={{ height: barHeight, transform: `translate3d(${barX - 1}px, ${barTop}px, 0)` }}
      />
      <div
        ref={ghostRef}
        className="dock-drop-ghost"
        style={{ transform: `translate3d(${x + 14}px, ${y + 18}px, 0) scale(1.04)` }}
      >
        {Icon && <Icon size={14} />}
        <span className="dock-drop-ghost-name">{name}</span>
        <span className="dock-drop-ghost-hint">{tr("松手复制 · Alt 移动")}</span>
      </div>
    </div>,
    document.body
  );
}
