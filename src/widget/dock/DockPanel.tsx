/* eslint-disable react-refresh/only-export-components */
/**
 * 全岛面板（PANEL 会话）：expand id "dock:panel"（dock-logic.DOCK_PANEL_EXPAND_ID），
 * 一次展开看到所有入岛小组件——轮播 / 网格两种视图切换。
 *
 * - 卡片 = dock.tiles 顺序渲染，内容按 registry 分派：`meta.ExpandedComponent`
 *   （传 {instanceId, active}）→ 否则完整 `meta.component`（传 instanceId）。
 *   无实例的磁贴以 `dock-tile-<tileId>` 作合成 instanceId，并把 DockTile.config
 *   落种到 widget-config 存储层作临时配置源（组件经 useWidgetConfig 同一读径）。
 *   卡片常驻挂载（收起 / 重开不重建），只有「面板展开且为当前卡」active=true——
 *   非当前卡按 契约暂停持续性工作，轮播下还置 inert（不可聚焦 / 不可命中）。
 * - 轮播（默认；dock.panel.mode 由 CFG 设置页写、此处只读，右上角按钮只做会话内
 *   视图切换）：一屏一卡，pointer 拖动 1:1 跟手（rAF 合并、只写 transform、零重渲），
 *   松手按速度 settle 到最近卡（300ms --ease-spatial-fast，拖动 / 甩动 settle），首末卡越界 0.3× 阻尼回弹；
 *   ←/→（含 Home/End）与滚轮切卡（卡片内可滚方向先让内容滚）；底部圆点可点。
 * - 网格：自适应列 minmax(280px, 1fr)、每卡等高 200px、容器可滚动；点卡片标题
 *   进入该卡的单磁贴展开（expand("dock:<tileId>")，面板经单值互斥自动收起）。
 * - 外壳 WidgetExpandOverlay：origin 取岛实测矩形（.dock），Esc / 遮罩点击 /
 *   右上角关闭由外壳提供；与单磁贴展开、音乐沉浸页经 expand-store 单值天然互斥。
 * 样式在 feature-dock.css 的 ══ PANEL ══ 区段（dp-*）。
 */
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent
} from "react";
import { GalleryHorizontal, LayoutGrid, Maximize2, Sparkles } from "lucide-react";
import { useT } from "../../i18n-lite";
import { animDurations } from "../../lib/durations";
import { makeResettableLazy } from "../../lib/make-resettable-lazy";
import { uiZoom } from "../../lib/ui-zoom";
import { prefersReducedMotion } from "../../lib/anim";
import { useWidgetExpand } from "../expand-store";
import { getWidgetMeta, resetWidgetLazy } from "../registry";
import { useWidgetStore, type DockConfig, type DockEdge, type DockTile } from "../widget-store";
import { WidgetExpandOverlay, type ExpandRect } from "../WidgetExpandOverlay";
import { WidgetErrorBoundary } from "../WidgetErrorBoundary";
import { dockTileDisplayName } from "./DockTile";
import {
  DOCK_FLUSH_PX,
  DOCK_PANEL_EXPAND_ID,
  dockTileExpandId,
  dockTileInstanceId,
  seedDockTileConfig
} from "./dock-logic";

/** 「杂项」面板需要整个 tile（items 存在 tile.config 上），与 DockTileExpanded 同口径分派。
    可重置 lazy——chunk 拉取失败弃缓存，重试（下方边界 onRetry）重新 import。 */
const MiscBoardPanel = makeResettableLazy(() => import("../widgets/misc/MiscBoardPanel"), "MiscBoardPanel");

// 与 DockTileExpanded 共用的口径搬去 dock-logic；这里保留导出供既有调用方/测试。
export { dockTileInstanceId };

export type DockPanelMode = DockConfig["panel"]["mode"];

/** 松手 settle 时长：与 CSS .dp-strip 的 `--dur-fx-slow` transform 过渡同源
 *  （标准档恰为 300ms）。此前硬编码常量只在标准速度档成立——慢速档下滚轮
 *  切卡的冷却会先于 settle 动画结束，运行期一律经 animDurations() 实时取。 */
export function panelSettleMs(): number {
  return Math.round(animDurations().fxSlowMs);
}
/** 首末卡越界时的位移阻尼系数。 */
export const PANEL_OVERSCROLL_DAMPING = 0.3;
/** 起拖阈值（px）：小于此位移视为点击，不劫持卡片内的原生交互。 */
export const PANEL_DRAG_THRESHOLD_PX = 6;
/** 甩动投影时长（ms）：松手速度 × 此值 = 惯性位移，参与最近卡判定。 */
export const PANEL_FLING_PROJECT_MS = 160;
/** 甩动判定的最小速度（px/ms）：达到即至少朝甩动方向翻一卡。 */
export const PANEL_FLING_MIN_VELOCITY = 0.6;
/** 滚轮切卡：累计触发阈值（px）与切卡后的冷却（settle 时长 + 余量，随速度档）。 */
const WHEEL_THRESHOLD_PX = 30;
const wheelCooldownMs = () => panelSettleMs() + 60;

const clampIndex = (i: number, count: number): number => Math.max(0, Math.min(count - 1, i));

/** 越界阻尼：首卡右拖 / 末卡左拖时位移乘 0.3，其余 1:1。 */
export function dampOverscroll(dx: number, index: number, count: number): number {
  const beyondStart = index <= 0 && dx > 0;
  const beyondEnd = index >= count - 1 && dx < 0;
  return beyondStart || beyondEnd ? dx * PANEL_OVERSCROLL_DAMPING : dx;
}

/**
 * 松手 settle 目标下标（纯函数）：按拖动位移 + 甩动速度投影到「最近卡」；
 * 速度超过 {@link PANEL_FLING_MIN_VELOCITY} 时至少朝甩动方向翻一卡（快速轻甩
 * 即位移不足半屏也能翻页，对标 KeyholeCardCarousel 的 fling settle）。
 *
 * @param index    松手时的当前卡下标。
 * @param dx       拖动位移（px，右拖为正；越界部分应先经 dampOverscroll）。
 * @param velocity 松手速度（px/ms，右为正）；非有限值按 0。
 * @param width    视口宽（px）；非正值无法求最近卡，回退当前卡。
 * @param count    卡片总数；≤0 回退 0。
 */
export function settleIndex(index: number, dx: number, velocity: number, width: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(width) || width <= 0) return clampIndex(index, count);
  const v = Number.isFinite(velocity) ? velocity : 0;
  const projected = index * width - dx - v * PANEL_FLING_PROJECT_MS;
  let target = Math.round(projected / width);
  if (Math.abs(v) >= PANEL_FLING_MIN_VELOCITY && target === index) target += v > 0 ? -1 : 1;
  return clampIndex(target, count);
}

type DragSample = { t: number; x: number };
type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  engaged: boolean;
  captured: boolean;
  samples: DragSample[];
};

/** 松手速度：取最近 100ms 采样窗的首末位移 / 时长（先压入松手采样，静止松手 ≈ 0）。 */
function flingVelocity(samples: DragSample[]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > 100) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** 起拖排除区：卡片内的原生交互元素（按钮 / 输入 / 画布 / 看板拖卡等）不发起轮播拖动。 */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, canvas, video, [contenteditable], [role='slider'], [draggable='true'], [data-interactive]";

function isInteractiveTarget(target: EventTarget | null, boundary: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const hit = target.closest(INTERACTIVE_SELECTOR);
  return !!hit && boundary.contains(hit) && hit !== boundary;
}

/** 箭头键拦截排除：焦点已在卡片内容里（或可编辑元素上）时不抢按键。 */
function shouldIgnoreArrowKey(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".dp-card-body")) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target as HTMLElement).isContentEditable;
}

/**
 * 滚轮方向上卡片内是否还有可滚内容（从事件目标上溯到轮播视口为止）：
 * 有就让内容先滚（如课表 / 通知列表的纵向滚动），滚到边界再切卡。
 */
function canScrollWithin(start: EventTarget | null, boundary: HTMLElement, axis: "x" | "y", delta: number): boolean {
  let el = start instanceof Element ? start : null;
  while (el && el !== boundary) {
    const cs = getComputedStyle(el);
    const overflow = axis === "y" ? cs.overflowY : cs.overflowX;
    if (overflow === "auto" || overflow === "scroll") {
      const max = (axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth) || 0;
      const pos = axis === "y" ? el.scrollTop : el.scrollLeft;
      if (max > 1 && ((delta > 0 && pos < max - 1) || (delta < 0 && pos > 1))) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** 面板 origin：岛静止几何按 dock 配置推导，实测矩形只取宽高——展开瞬间
 *  岛正从 tucked 收合位滑出（autoHide 过渡进行中），gBCR 含过渡位移，直接
 *  量测会让面板生长起点偏上甚至出屏；宽高不受 translate 影响，照实测取。
 *  坐标推导与 DockShell 的静止几何（applyPlacementStyle）同口径。
 *  ExpandRect 契约是布局单位（WidgetExpandOverlay 按 innerWidth 钳制、
 *  渲染为 CSS left/top）——此前 vw（布局）与 gBCR 宽高、DOCK_FLUSH_PX*z（视觉）
 *  混算，zoom≠100% 时起点矩形偏大偏位；现统一 ÷uiZoom 折回布局单位。 */
function islandOrigin(edge: DockEdge, place: Pick<DockConfig, "snap" | "offset" | "style" | "topInset">): ExpandRect {
  const r = typeof document !== "undefined" ? document.querySelector(".dock")?.getBoundingClientRect() : undefined;
  if (r && r.width > 0 && r.height > 0) {
    const z = uiZoom();
    const vw = window.innerWidth;
    const w = r.width / z;
    let x: number;
    if (place.snap === "start") x = DOCK_FLUSH_PX;
    else if (place.snap === "end") x = vw - DOCK_FLUSH_PX - w;
    else x = place.offset * vw - w / 2;
    const y = edge === "bottom" ? r.top / z : place.style === "bangs" ? 0 : place.topInset;
    return { x, y, w, h: r.height / z };
  }
  return { x: window.innerWidth / 2 - 60, y: edge === "bottom" ? window.innerHeight - 120 : 10, w: 120, h: 38 };
}

/* ------------------------------------------------------------------ *
 * 无实例磁贴的临时配置源：把 DockTile.config 落种到 widget-config
 * 存储层的合成键（focus-desk.widget-config.dock-tile-<id>.v1）——实现见
 * dock-logic.seedDockTileConfig，与单磁贴展开（DockTileExpanded）共用。
 * 首次落种在渲染期同步完成（子组件 useWidgetConfig 的初值就在挂载前读取），
 * 之后 tile.config 变化经 effect 重种并广播 CHANGE_EVENT 让挂载组件重读。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 单张卡片
 * ------------------------------------------------------------------ */
type CardProps = {
  tile: DockTile;
  index: number;
  grid: boolean;
  current: boolean;
  active: boolean;
  /** 卡片标题（绑定实例跟随实例显示名，由 DockPanel 订阅 instances 后
   *  算好传入——原始值不参与 memo 比对，重命名只重渲名字变化的卡）。 */
  title: string;
  onOpen: (tile: DockTile) => void;
};

/* memo——DockPanel 的订阅面很宽（expandedId / mountedIds 的任何翻转——含
 * 画布卡片展开与 LRU 重排——都会重渲本组件，还有轮播切卡与岛几何字段），此前
 * 每次都全量重跑 N 张卡（卡内是天气站/音乐一类重组件）。props 引用全部稳定
 * （tile 对象未变时引用不变、onOpen 是 useCallback、布尔/下标为原始值），套
 * memo 后切卡只重渲 current/active 翻转的新旧两张卡，其余订阅触发的重渲
 * 不进卡片子树。 */
const PanelCard = memo(function PanelCard({ tile, index, grid, current, active, title, onOpen }: CardProps) {
  const tr = useT();
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    seedDockTileConfig(tile, false);
  }
  useEffect(() => {
    seedDockTileConfig(tile, true);
  }, [tile]);

  const meta = getWidgetMeta(tile.type);
  const instanceId = dockTileInstanceId(tile);
  const Icon = meta?.icon;
  const Expanded = meta?.ExpandedComponent;
  const Full = meta?.component;
  const hidden = !grid && !current; // 轮播下的非当前卡：遮蔽 + inert（不可聚焦 / 不可命中）

  return (
    <section
      className={`dp-card${current ? " is-current" : ""}`}
      data-tile-id={tile.id}
      data-index={index}
      data-active={active ? "true" : "false"}
      aria-label={title}
      aria-hidden={hidden || undefined}
      inert={hidden}
    >
      {grid && (
        <button
          type="button"
          className="dp-card-title"
          onClick={() => onOpen(tile)}
          title={`${tr("展开")} ${title}`}
          data-interactive
        >
          {Icon && <Icon size={13} />}
          <span className="dp-card-title-text">{title}</span>
          <Maximize2 size={12} className="dp-card-title-ico" />
        </button>
      )}
      <div className="dp-card-body">
        {/* 逐卡错误边界——单卡抛错不再沿 DockShell 外层边界把整条岛静默卸载。
            重试经 onRetry 弃缓存该类型的全部懒 chunk（含杂项正主）。 */}
        <WidgetErrorBoundary
          instanceId={dockTileInstanceId(tile)}
          type={`dock-panel-card:${tile.type}`}
          onRetry={() => {
            resetWidgetLazy(tile.type);
            MiscBoardPanel.reset();
          }}
        >
          <Suspense fallback={<div className="dp-card-skeleton" aria-hidden="true" />}>
            {tile.type === "misc" ? (
              /* misc 无 ExpandedComponent、meta.component 是画布占位提示
                 （「请在灵动岛中使用」的自指死循环）——按 DockTileExpanded 同口径
                 分派正主。 */
              <MiscBoardPanel.Component tile={tile} active={active} />
            ) : Expanded ? (
              <Expanded instanceId={instanceId} active={active} />
            ) : Full ? (
              <div className="dp-card-full">
                {/* Full 兜底无 active 契约且卡片常驻挂载——收起即卸载
                    （对齐 MiscBoardPanel 取舍），否则约 20 个类型永久轮询。 */}
                {active ? <Full instanceId={instanceId} /> : null}
              </div>
            ) : (
              <div className="dp-card-unknown">{tile.type}</div>
            )}
          </Suspense>
        </WidgetErrorBoundary>
      </div>
    </section>
  );
});

/* ------------------------------------------------------------------ *
 * 面板本体
 * ------------------------------------------------------------------ */
export function DockPanel() {
  const tr = useT();
  const tiles = useWidgetStore((s) => s.dock.tiles);
  const edge = useWidgetStore((s) => s.dock.edge);
  const snap = useWidgetStore((s) => s.dock.snap);
  const offset = useWidgetStore((s) => s.dock.offset);
  const dockStyle = useWidgetStore((s) => s.dock.style);
  const topInset = useWidgetStore((s) => s.dock.topInset);
  const configMode = useWidgetStore((s) => s.dock.panel.mode);
  /* 卡标题 / 圆点跟随实例显示名（重命名后面板同步）。instances 引用变化
     会重渲本组件，但 PanelCard 已 memo 且 title 是原始值——只有名字真变了
     的卡会跟着重渲，其余全跳过。 */
  const instances = useWidgetStore((s) => s.instances);
  const expandedId = useWidgetExpand((s) => s.expandedId);
  const mountedIds = useWidgetExpand((s) => s.mountedIds);
  const expand = useWidgetExpand((s) => s.expand);
  const collapseIf = useWidgetExpand((s) => s.collapseIf);

  const mounted = mountedIds.includes(DOCK_PANEL_EXPAND_ID);
  const active = expandedId === DOCK_PANEL_EXPAND_ID;

  const [index, setIndex] = useState(0);
  /* 会话内视图切换（不写配置）；收起后回到配置默认形态。 */
  const [modeOverride, setModeOverride] = useState<DockPanelMode | null>(null);
  const mode: DockPanelMode = modeOverride ?? configMode;
  const isGrid = mode === "grid";
  const count = tiles.length;
  const current = clampIndex(index, count);
  const hasCards = count > 0;

  /* 岛几何快照在展开 / 收起翻转时重取（生长起点 / 收回终点各取当下推导）；
     其余渲染（切卡 / 换模式）复用缓存，避免在拖动热路径强制布局。 */
  const origin = useMemo(
    () => islandOrigin(edge, { snap, offset, style: dockStyle, topInset }),
    // active 是刻意的重取触发器：翻转时重测岛宽（宽高经 gBCR 量测，对
    // 依赖 lint 不可见），几何推导入参之外的重取时机。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edge, snap, offset, dockStyle, topInset, active]
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(current);
  const countRef = useRef(count);
  const modeRef = useRef(mode);
  useEffect(() => {
    indexRef.current = current;
    countRef.current = count;
    modeRef.current = mode;
  }, [current, count, mode]);

  /* 磁贴增删后钳制当前下标。 */
  useEffect(() => {
    setIndex((i) => clampIndex(i, count));
  }, [count]);
  /* 收起（或被单磁贴展开顶掉）后回到配置默认视图。 */
  useEffect(() => {
    if (!active) setModeOverride(null);
  }, [active]);

  const go = useCallback(
    (i: number) => {
      setIndex(clampIndex(i, count));
    },
    [count]
  );
  const toggleMode = () => setModeOverride(isGrid ? "carousel" : "grid");
  const openTile = useCallback((tile: DockTile) => expand(dockTileExpandId(tile.id)), [expand]);

  /* ---- 轮播拖动：1:1 跟手（只写 transform、rAF 合并、零重渲）→ 松手 settle ---- */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !hasCards) return;
    let drag: DragState | null = null;
    let raf = 0;
    let framePending = false;
    const strip = () => stripRef.current;

    const paint = () => {
      framePending = false;
      const s = strip();
      if (drag && s) s.style.transform = `translateX(calc(${-indexRef.current * 100}% + ${drag.dx}px))`;
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };

    const finish = (settle: boolean) => {
      const d = drag;
      drag = null;
      detach();
      cancelAnimationFrame(raf);
      framePending = false;
      if (!d?.engaged) return;
      viewport.classList.remove("is-dragging");
      if (d.captured) {
        try {
          viewport.releasePointerCapture(d.pointerId);
        } catch {
          /* 指针已离开 */
        }
      }
      const s = strip();
      if (!s) return;
      const from = indexRef.current;
      const target = settle
        ? settleIndex(from, d.dx, flingVelocity(d.samples), viewport.clientWidth, countRef.current)
        : from;
      /* 恢复 CSS 过渡后再写目标位：从跟手位置起 300ms settle（flipReorder 同法）；
         reduce-motion 下显式关过渡直接落位（与 FLIP / 幽灵退场同口径，
         不依赖全局 0.001s 压缩兜底）。 */
      if (prefersReducedMotion()) {
        s.style.transition = "none";
        s.style.transform = `translateX(${-target * 100}%)`;
      } else {
        s.style.transition = "";
        s.style.transform = `translateX(${-target * 100}%)`;
      }
      if (target !== from) setIndex(target);
    };

    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      /* 跟手量与结算量统一为布局单位（paint 写进 translateX 的 px、
         settleIndex 对照的 clientWidth 都是布局）——clientX 是视觉值，此前
         未除 zoom，UI 缩放 ≠100% 时跟手速度 z 倍、settle 投影失真。engage
         阈值判定仍用视觉原始差（px 手感阈值）。 */
      const z = uiZoom();
      const dxRaw = e.clientX - drag.startX;
      const dyRaw = e.clientY - drag.startY;
      const dx = dxRaw / z;
      if (!drag.engaged) {
        if (Math.abs(dxRaw) < PANEL_DRAG_THRESHOLD_PX) return;
        if (Math.abs(dyRaw) > Math.abs(dxRaw)) {
          finish(false); // 纵向意图：不起拖，交还点击 / 滚动
          return;
        }
        drag.engaged = true;
        viewport.classList.add("is-dragging");
        const s = strip();
        if (s) {
          /* 采样当前视觉位置（三轮）：settle 过渡中途被抓取时，内联
             transform 已是目标值——直接以整数 index 为基会在 transition:none
             的瞬间瞬跳到目标卡，再从那里跟手。把「当前视觉位 − 整数基」的
             偏差折进 startX（translateX 百分比基 = strip 自身宽度：
             偏差全取视觉量——clientWidth ×z 折成视觉宽再与 gBCR 差混合，
             startX 是视觉基准），跟手从当前画面无缝续接，settle 可被随时打断续拖。 */
          const transient =
            s.getBoundingClientRect().left -
            viewport.getBoundingClientRect().left +
            indexRef.current * s.clientWidth * z;
          if (Math.abs(transient) > 0.5) drag.startX -= transient;
          s.style.transition = "none";
        }
        try {
          viewport.setPointerCapture(drag.pointerId);
          drag.captured = true;
        } catch {
          /* 指针已消失 */
        }
      }
      drag.dx = dampOverscroll(dx, indexRef.current, countRef.current);
      drag.samples.push({ t: performance.now(), x: dx });
      if (drag.samples.length > 8) drag.samples.shift();
      if (!framePending) {
        framePending = true;
        raf = requestAnimationFrame(paint);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.samples.push({ t: performance.now(), x: (e.clientX - drag.startX) / uiZoom() });
      finish(true);
    };
    const onCancel = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      finish(false);
    };
    const onDown = (e: PointerEvent) => {
      if (drag || modeRef.current !== "carousel" || e.button !== 0 || !e.isPrimary) return;
      if (countRef.current < 2 || isInteractiveTarget(e.target, viewport)) return;
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dx: 0,
        engaged: false,
        captured: false,
        /* 采样存「相对 startX 的布局位移」（onMove/onUp 同口径）——
           flingVelocity 取首末差，起点恒为 0。 */
        samples: [{ t: performance.now(), x: 0 }]
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };

    viewport.addEventListener("pointerdown", onDown);
    return () => {
      viewport.removeEventListener("pointerdown", onDown);
      detach();
      cancelAnimationFrame(raf);
      if (drag?.engaged) {
        viewport.classList.remove("is-dragging");
        const s = strip();
        if (s) {
          s.style.transition = "";
          s.style.transform = `translateX(${-indexRef.current * 100}%)`;
        }
      }
    };
  }, [hasCards, mounted]);

  /* ---- ←/→（Home/End）切卡：面板展开时全局监听，焦点在卡片内容里则让位 ---- */
  useEffect(() => {
    if (!active || mode !== "carousel" || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (shouldIgnoreArrowKey(e.target)) return;
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      const jump = e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
      if (!step && jump === null) return;
      e.preventDefault();
      setIndex((i) => clampIndex(jump ?? i + step, count));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, mode, count]);

  /* ---- 滚轮切卡（卡片内可滚方向先让内容滚）---- */
  const wheel = useRef({ acc: 0, lockUntil: 0, lastT: 0 });
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (mode !== "carousel" || count < 2) return;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const delta = horizontal ? e.deltaX : e.deltaY;
    if (!delta) return;
    if (canScrollWithin(e.target, e.currentTarget, horizontal ? "x" : "y", delta)) return;
    const now = performance.now();
    const w = wheel.current;
    if (now < w.lockUntil) return;
    if (now - w.lastT > 300 || Math.sign(delta) !== Math.sign(w.acc)) w.acc = 0;
    w.lastT = now;
    w.acc += delta;
    if (Math.abs(w.acc) < WHEEL_THRESHOLD_PX) return;
    w.acc = 0;
    w.lockUntil = now + wheelCooldownMs();
    go(current + (delta > 0 ? 1 : -1));
  };

  if (!mounted) return null;

  const currentTile = tiles[current];
  const currentTitle = currentTile ? dockTileDisplayName(currentTile, instances, tr) : "";

  return (
    <WidgetExpandOverlay
      active={active}
      origin={origin}
      title={tr("灵动岛面板")}
      onClose={() => collapseIf(DOCK_PANEL_EXPAND_ID)}
      /* middle=collapse 的可达落点（模态遮罩盖住岛本体，中键收起由遮罩代收）。 */
      onAuxCollapse={() => {
        if (useWidgetStore.getState().dock.mouse.middle === "collapse") collapseIf(DOCK_PANEL_EXPAND_ID);
      }}
      sizeKey={DOCK_PANEL_EXPAND_ID}
      scrim={false}
    >
      <div className={`dock-panel dock-panel-island is-${mode}`}>
        <div className="dp-head">
          <div className="dp-head-text">
            <span className="dp-title">{tr("灵动岛")}</span>
            {!isGrid && currentTile && (
              <>
                <span className="dp-sep" aria-hidden="true">
                  ·
                </span>
                <span className="dp-cardname" aria-live="polite">
                  {currentTitle}
                </span>
              </>
            )}
          </div>
          {hasCards && (
            <button
              type="button"
              className="dp-iconbtn"
              onClick={toggleMode}
              aria-pressed={isGrid}
              aria-label={isGrid ? tr("切换到轮播视图") : tr("切换到网格视图")}
              title={isGrid ? tr("切换到轮播视图") : tr("切换到网格视图")}
              data-interactive
            >
              {isGrid ? <GalleryHorizontal size={15} /> : <LayoutGrid size={15} />}
            </button>
          )}
        </div>

        {!hasCards ? (
          <div className="dp-empty" role="status">
            <Sparkles size={16} className="dp-empty-ico" />
            <span>{tr("拖一张卡片到灵动岛，或按 + 添加")}</span>
          </div>
        ) : (
          <>
            <div
              ref={viewportRef}
              className={`dp-viewport is-${mode}`}
              role="group"
              aria-roledescription={isGrid ? tr("网格") : tr("轮播")}
              onWheel={onWheel}
            >
              <div
                ref={stripRef}
                className="dp-strip"
                style={isGrid ? undefined : { transform: `translateX(${-current * 100}%)` }}
              >
                {tiles.map((tile, i) => (
                  <PanelCard
                    key={tile.id}
                    tile={tile}
                    index={i}
                    grid={isGrid}
                    current={i === current}
                    title={dockTileDisplayName(tile, instances, tr)}
                    /* 网格模式全部可见卡都 active（轮播仍只有当前卡）——
                       Expanded 组件以 active 门控拉取（WeatherStation 等
                       `if (!active) return`），此前网格里除一张陈旧卡外全是骨架。 */
                    active={active && (isGrid || i === current)}
                    onOpen={openTile}
                  />
                ))}
              </div>
            </div>
            {!isGrid && count > 1 && (
              <div className="dp-dots" role="group" aria-label={tr("切换卡片")}>
                {tiles.map((tile, i) => (
                  <button
                    key={tile.id}
                    type="button"
                    className={`dp-dot${i === current ? " is-current" : ""}`}
                    aria-label={tr("切换到 {name}", { name: dockTileDisplayName(tile, instances, tr) })}
                    aria-current={i === current ? "true" : undefined}
                    onClick={() => go(i)}
                    data-interactive
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </WidgetExpandOverlay>
  );
}
