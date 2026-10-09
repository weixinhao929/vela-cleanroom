/**
 * 「杂项」磁贴的展开面板：一块可自由排布多个小组件的格子板（对标 Android / KDE 小组件板）。
 *
 * - 布局模型见 misc-layout.ts：MISC_COLS 列、行高 MISC_ROW_PX；条目 {id,type,x,y,w,h}
 *   存在磁贴自己的 config.items 里（setDockTileConfig → 按屏落盘 + sync:dock 跨窗口同步 +
 *   备份），任何来源进来先过 sanitizeMiscItems。
 * - 每个条目渲染 registry 的画布组件（component），instanceId = `<tileId>:<itemId>`，
 *   各自的 useWidgetConfig 独立（同一面板放两枚天气可各配城市）。
 * - 拖动：条目顶部的把手条 pointerdown 起拖（不抢内容区的点击 / 输入）；拖动中条目
 *   跟手（transform），占位框吸到最近的格并实时预演 moveItem 结果——被压住的条目
 *   下推、其余上移填空（CSS 过渡 left / top，「磁性吸附 + 自适应」）；松手 FLIP 落格：
 *   React 写死新格位 left / top，补偿 transform 把视觉位置钉回松手处，再只过渡
 *   transform（dockQ 弹簧 --ease-dock-spring，对齐 DockShell.animatePlacement）弹进格。
 * - 调整大小：条目右下角手柄（.misc-item-rs）拖出目标格数，拖动期 resizeItem 实时
 *   预演（变大的条目下推别人），松手 resizeItem 定稿；Esc 语义 = pointercancel 原样。
 * - 「+」打开 DockTypePicker 挑类型（禁掉「杂项」自己），按 gridSizeFor(defaultSize) 占格
 *   放进第一个空位；把手条右侧 × 移除。
 * - 面板宽度由 WidgetExpandOverlay 决定（可拖大小），ResizeObserver 跟随算格宽。
 */
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { GripHorizontal, LayoutGrid, Plus, X } from "lucide-react";
import { useT } from "../../../i18n-lite";
import { animDurations } from "../../../lib/durations";
import { uiZoom } from "../../../lib/ui-zoom";
import { getWidgetMeta } from "../../registry";
import { useWidgetStore, type DockTile } from "../../widget-store";
import { removeInstanceData } from "../../instance-data";
import { WidgetErrorBoundary } from "../../WidgetErrorBoundary";
import { DockTypePicker } from "../../dock/DockTypePicker";
import type { PopoverAnchor } from "../../WidgetConfigPopover";
import {
  MISC_COLS,
  MISC_GAP_PX,
  MISC_MAX_H,
  MISC_ROW_PX,
  gridSizeFor,
  moveItem,
  newMiscItemId,
  placeNewItem,
  removeItem,
  resizeItem,
  sanitizeMiscItems,
  type MiscItem
} from "./misc-layout";

/** 本面板类型 id（registry 登记名；面板里不允许再放一块面板）。 */
export const MISC_TYPE = "misc";

/** 松手落格 FLIP 的弹簧时长：运行时取 --dur-dock-spring 的派生值（时长单一
 *  真源，与曲线 var(--ease-dock-spring) 配对）：此前写死 450ms 不随
 *  设置→动效 速度档缩放——同一动画「弹但节奏错」。 */
const settleMs = () => animDurations().dockSpringMs;

/** 松手落格会话：补偿位移（松手视觉位置 − 新格位原点），由绘制前的 useLayoutEffect 消费。 */
type SettleState = { id: string; dx: number; dy: number };

type DragState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** 起拖时条目左上角（板内 px）。 */
  origLeft: number;
  origTop: number;
  /** 起拖时的格位（未移动时预演布局 = 原布局）。 */
  gx: number;
  gy: number;
};

/** 右下角手柄的调整大小会话：拖动期按指针位移换算目标格数（吸附到整数格），松手定稿。 */
type ResizeState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  origW: number;
  origH: number;
  /** 已吸附的目标格数（未越过新格前不变，避免预演抖动）。 */
  w: number;
  h: number;
};

/** 条目的 px 几何。 */
function itemRect(item: MiscItem, cellW: number): CSSProperties {
  const step = cellW + MISC_GAP_PX;
  const rowStep = MISC_ROW_PX + MISC_GAP_PX;
  return {
    left: Math.round(item.x * step),
    top: Math.round(item.y * rowStep),
    width: Math.round(item.w * cellW + (item.w - 1) * MISC_GAP_PX),
    height: item.h * MISC_ROW_PX + (item.h - 1) * MISC_GAP_PX
  };
}

export function MiscBoardPanel({ tile, active }: { tile: DockTile; active: boolean }) {
  const tr = useT();
  const setDockTileConfig = useWidgetStore((s) => s.setDockTileConfig);
  const items = useMemo(() => sanitizeMiscItems(tile.config?.items), [tile.config]);

  const boardRef = useRef<HTMLDivElement>(null);
  const [boardW, setBoardW] = useState(0);
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => setBoardW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cellW = boardW > 0 ? (boardW - (MISC_COLS - 1) * MISC_GAP_PX) / MISC_COLS : 160;

  const commit = useCallback(
    (next: MiscItem[]) => setDockTileConfig(tile.id, { items: next }),
    [setDockTileConfig, tile.id]
  );

  /* ---- 添加 ---- */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<PopoverAnchor>({ x: 0, y: 0, w: 0, h: 0 });
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const openPicker = () => {
    const r = addBtnRef.current?.getBoundingClientRect();
    if (r) setPickerAnchor({ x: r.left, y: r.top, w: r.width, h: r.height });
    setPickerOpen(true);
  };
  const onPick = (type: string) => {
    setPickerOpen(false);
    const meta = getWidgetMeta(type);
    if (!meta || type === MISC_TYPE) return;
    const size = gridSizeFor(meta.defaultSize);
    commit(placeNewItem(items, { id: newMiscItemId(), type, ...size }));
  };

  /* ---- 拖动排布 ---- */
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef(0);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [preview, setPreview] = useState<MiscItem[] | null>(null);
  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      for (const cancel of settleCancelsRef.current) cancel();
    },
    []
  );

  /* 挂起中的落格 FLIP（多条可并发）。再次抓起 / 调整大小 / 卸载时必须取消：行内
     transition 不清会压过 .is-dragging 的 transition:none，条目就拖着弹簧跟手。 */
  const settleRef = useRef<SettleState | null>(null);
  const settleCancelsRef = useRef(new Set<() => void>());
  const cancelSettles = () => {
    for (const cancel of settleCancelsRef.current) cancel();
  };

  const onBarDown = (item: MiscItem, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelSettles();
    const rect = itemRect(item, cellW);
    dragRef.current = {
      id: item.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: Number(rect.left),
      origTop: Number(rect.top),
      gx: item.x,
      gy: item.y
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: item.id, dx: 0, dy: 0 });
    setPreview(items);
  };
  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    /* clientX 差值是视觉位移 → 布局单位：÷uiZoom——dx/dy 换算后全程使用
       （transform 的 px 与格位计算 (origLeft+dx)/(cellW+GAP) 均为布局）。 */
    const z = uiZoom();
    const dx = (e.clientX - d.startX) / z;
    const dy = (e.clientY - d.startY) / z;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setDrag({ id: d.id, dx, dy });
      // 磁性吸附：条目左上角落到最近的格；格位变了才重算预演布局。
      const gx = Math.round((d.origLeft + dx) / (cellW + MISC_GAP_PX));
      const gy = Math.round((d.origTop + dy) / (MISC_ROW_PX + MISC_GAP_PX));
      if (gx !== d.gx || gy !== d.gy) {
        d.gx = gx;
        d.gy = gy;
        setPreview(moveItem(items, d.id, gx, gy));
      }
    });
  };
  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>, commitIt: boolean) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    cancelAnimationFrame(rafRef.current);
    dragRef.current = null;
    setDrag(null);
    setPreview(null);
    // clientX 视觉差 → 布局单位：÷uiZoom（与 onBarMove 同口径，格位与 FLIP 均布局）。
    const z = uiZoom();
    const dx = (e.clientX - d.startX) / z;
    const dy = (e.clientY - d.startY) / z;
    // 松手视觉位置（起拖原点 + 指针位移）与落格后的格位原点：两者之差即 FLIP 补偿位移。
    let finalLeft = d.origLeft;
    let finalTop = d.origTop;
    if (commitIt) {
      const gx = Math.round((d.origLeft + dx) / (cellW + MISC_GAP_PX));
      const gy = Math.round((d.origTop + dy) / (MISC_ROW_PX + MISC_GAP_PX));
      const next = moveItem(items, d.id, gx, gy);
      const moved = next.find((n) => n.id === d.id);
      if (moved) {
        const rect = itemRect(moved, cellW);
        finalLeft = Number(rect.left);
        finalTop = Number(rect.top);
      }
      const changed = next.some((n) => {
        const o = items.find((i) => i.id === n.id);
        return !o || o.x !== n.x || o.y !== n.y;
      });
      if (changed) commit(next);
    }
    // 记一笔落格 FLIP（取消 / 原位放回也走这里，弹簧归位），绘制前的 layout effect 消费。
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
      settleRef.current = { id: d.id, dx: d.origLeft + dx - finalLeft, dy: d.origTop + dy - finalTop };
    }
  };

  /* ---- 松手落格 FLIP（对齐 DockShell.animatePlacement，统一走 dockQ 弹簧）----
     松手那一帧 React 已把新格位 left / top 写死；这里抢在绘制前把视觉位置用补偿
     transform 钉回松手处（transition:none 压掉本帧 left / top 过渡，避免「跳回起点
     再滑入」），强制回流提交起始态后只过渡 transform 到静止值——「弹一下」就是
     --ease-dock-spring 的过冲；box-shadow / opacity 一并挂上，拖动投影按原 200ms
     淡出。结束清内联交还 CSS。reduce-motion 由全局 !important 压成瞬时落格。 */
  useLayoutEffect(() => {
    const s = settleRef.current;
    if (!s) return;
    settleRef.current = null;
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(s.id)}"]`);
    if (!el) return;
    const node: HTMLElement = el;
    function cleanup() {
      clearTimeout(timer);
      node.removeEventListener("transitionend", onEnd);
      node.style.transition = "";
      node.style.transform = "";
      node.style.zIndex = "";
      settleCancelsRef.current.delete(cancel);
    }
    function onEnd(ev: TransitionEvent) {
      if (ev.target !== node || ev.propertyName !== "transform") return;
      cleanup();
    }
    const cancel = () => cleanup();
    const ms = settleMs();
    node.style.transition = "none";
    node.style.transform = `translate(${s.dx}px, ${s.dy}px)`;
    node.style.zIndex = "5";
    node.getBoundingClientRect();
    node.style.transition = `transform ${ms}ms var(--ease-dock-spring), box-shadow var(--dur-fx) var(--ease-fx), opacity var(--dur-fx) var(--ease-fx)`;
    node.style.transform = "translate(0px, 0px)";
    node.addEventListener("transitionend", onEnd);
    const timer = setTimeout(cleanup, ms + 100);
    settleCancelsRef.current.add(cancel);
  });

  /* ---- 调整大小：条目右下角手柄，拖动期实时预演目标格（其余条目让位），松手落盘 ---- */
  const resizeRef = useRef<ResizeState | null>(null);
  const [resizing, setResizing] = useState<{ id: string } | null>(null);
  const onResizeDown = (item: MiscItem, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelSettles();
    resizeRef.current = {
      id: item.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origW: item.w,
      origH: item.h,
      w: item.w,
      h: item.h
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing({ id: item.id });
    setPreview(items);
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || e.pointerId !== r.pointerId) return;
    // 指针位移 → 目标格数：宽按格步进（含间距），高按行步进；钳在 1..剩余列 / 1..MISC_MAX_H。
    // clientX/Y 差是视觉坐标，格步进（stepW/MISC_ROW_PX）是布局单位——先除回 uiZoom。
    const it = items.find((i) => i.id === r.id);
    if (!it) return;
    const z = uiZoom();
    const stepW = cellW + MISC_GAP_PX;
    const w = Math.max(
      1,
      Math.min(MISC_COLS - it.x, Math.round((r.origW * stepW - MISC_GAP_PX + (e.clientX - r.startX) / z) / stepW))
    );
    const h = Math.max(
      1,
      Math.min(
        MISC_MAX_H,
        Math.round(
          (r.origH * MISC_ROW_PX + (r.origH - 1) * MISC_GAP_PX + (e.clientY - r.startY) / z) /
            (MISC_ROW_PX + MISC_GAP_PX)
        )
      )
    );
    if (w === r.w && h === r.h) return;
    r.w = w;
    r.h = h;
    setPreview(resizeItem(items, r.id, w, h));
  };
  const finishResize = (e: ReactPointerEvent<HTMLDivElement>, commitIt: boolean) => {
    const r = resizeRef.current;
    if (!r || e.pointerId !== r.pointerId) return;
    resizeRef.current = null;
    setResizing(null);
    setPreview(null);
    if (!commitIt) return;
    const it = items.find((i) => i.id === r.id);
    if (!it || (it.w === r.w && it.h === r.h)) return;
    commit(resizeItem(items, r.id, r.w, r.h));
  };

  const shown = preview ?? items;
  const rows = shown.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  const boardH = rows > 0 ? rows * MISC_ROW_PX + (rows - 1) * MISC_GAP_PX : 0;
  const dragged = drag ? shown.find((i) => i.id === drag.id) : undefined;

  return (
    <div className="dock-panel dock-panel-misc">
      <div className="misc-head">
        <LayoutGrid size={15} />
        <span className="misc-title">{tr("杂项")}</span>
        <span className="misc-count">
          {items.length} {tr("个小组件")}
        </span>
        <button
          ref={addBtnRef}
          type="button"
          className="misc-add"
          data-interactive
          aria-label={tr("添加小组件")}
          title={tr("添加小组件")}
          onClick={openPicker}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="misc-scroll">
        <div
          ref={boardRef}
          className={`misc-board${drag ? " is-dragging" : ""}${resizing ? " is-resizing" : ""}`}
          style={{ height: boardH }}
          data-cols={MISC_COLS}
        >
          {items.length === 0 && (
            <div className="misc-empty">
              <LayoutGrid size={22} />
              <span>{tr("这里还没有小组件")}</span>
              <span className="misc-empty-sub">{tr("点右上角「+」添加，拖顶部把手排布、拖右下角调大小")}</span>
            </div>
          )}
          {dragged && <div className="misc-placeholder" style={itemRect(dragged, cellW)} aria-hidden="true" />}
          {shown.map((item) => {
            const meta = getWidgetMeta(item.type);
            const isDragging = drag?.id === item.id;
            const isResizing = resizing?.id === item.id;
            const style: CSSProperties = itemRect(item, cellW);
            const d = dragRef.current;
            if (isDragging && drag && d) {
              // 拖动中的条目跟手：从起拖位置平移，不吸格（占位框负责提示吸附目标）。
              style.left = d.origLeft;
              style.top = d.origTop;
              style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
            }
            const Content = meta?.component;
            const instanceId = `${tile.id}:${item.id}`;
            return (
              <div
                key={item.id}
                className={`misc-item${isDragging ? " is-dragging" : ""}${isResizing ? " is-resizing" : ""}`}
                style={style}
                data-item-id={item.id}
                data-item-type={item.type}
              >
                <div
                  className="misc-item-bar"
                  data-interactive
                  onPointerDown={(e) => onBarDown(item, e)}
                  onPointerMove={onBarMove}
                  onPointerUp={(e) => finishDrag(e, true)}
                  onPointerCancel={(e) => finishDrag(e, false)}
                  title={tr("拖动排布")}
                >
                  <GripHorizontal size={13} className="misc-item-grip" />
                  <span className="misc-item-name">{meta ? tr(meta.name) : item.type}</span>
                  <button
                    type="button"
                    className="misc-item-del"
                    data-interactive
                    aria-label={`${tr("移除")} ${meta ? tr(meta.name) : item.type}`}
                    title={tr("移除")}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      // （条目移除不清嵌套数据）：嵌套小组件以
                      // `<tileId>:<itemId>` 为 instanceId，移除条目后其配置/
                      // 数据桶（便签、倒计时状态、gallery 磁盘副本等）永留
                      // localStorage——与整卡删除同契约，先清再提交。
                      removeInstanceData(`${tile.id}:${item.id}`);
                      commit(removeItem(items, item.id));
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="misc-item-body">
                  {/* 收起（active=false，display:none）时不渲染嵌套组件——
                      画布组件契约为 instanceId-only，无法内部感知面板可见性，
                      常驻挂载会让天气轮询/回收站 8s 扫描等在面板收起后全速跑。
                      代价是重开时数据重取（骨架占位），符合「active=false 暂停」
                      的迷你/沉浸契约精神。 */}
                  {!active ? (
                    <div className="widget-skeleton" aria-hidden="true" />
                  ) : Content ? (
                    <WidgetErrorBoundary instanceId={instanceId} type={item.type}>
                      <Suspense fallback={<div className="widget-skeleton" aria-busy="true" />}>
                        <Content instanceId={instanceId} />
                      </Suspense>
                    </WidgetErrorBoundary>
                  ) : (
                    <div className="misc-item-unknown">{tr("未知小组件类型")}</div>
                  )}
                </div>
                <div
                  className="misc-item-rs"
                  data-interactive
                  role="button"
                  tabIndex={0}
                  aria-label={`${tr("调整大小")} ${meta ? tr(meta.name) : item.type}`}
                  title={tr("拖动或聚焦后用方向键调整大小")}
                  onPointerDown={(e) => onResizeDown(item, e)}
                  onPointerMove={onResizeMove}
                  onPointerUp={(e) => finishResize(e, true)}
                  onPointerCancel={(e) => finishResize(e, false)}
                  onKeyDown={(e) => {
                    /* 键盘等价路径（09-19 遗留）：方向键 ±1 格步进，同指针的
                       格数钳制（宽 1..剩余列 / 高 1..MISC_MAX_H）。 */
                    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
                      e.key
                    ];
                    if (!delta) return;
                    e.preventDefault();
                    const it = items.find((i) => i.id === item.id);
                    if (!it) return;
                    const nw = Math.max(1, Math.min(MISC_COLS - it.x, it.w + delta[0]));
                    const nh = Math.max(1, Math.min(MISC_MAX_H, it.h + delta[1]));
                    if (nw !== it.w || nh !== it.h) commit(resizeItem(items, item.id, nw, nh));
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      <DockTypePicker
        anchor={pickerAnchor}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={onPick}
        isTypeDisabled={(t) => t === MISC_TYPE}
      />
    </div>
  );
}

export default MiscBoardPanel;

/** 画布占位：杂项只在灵动岛里有意义（registry dockOnly），旧布局 / 导入带进来时给一句提示而不是白屏。 */
export function MiscCanvasHint(_props: { instanceId: string }) {
  const tr = useT();
  return (
    <div className="misc-canvas-hint">
      <LayoutGrid size={18} />
      <span>{tr("「杂项」面板请在灵动岛中使用")}</span>
    </div>
  );
}
