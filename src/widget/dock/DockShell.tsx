/**
 * 灵动岛本体（ISLAND-CORE 拆出的外壳；ISLAND-MOVE 补齐 autoHide / ）。
 *
 * - 几何：贴屏幕顶边（top:dock.topInset；bangs 外形贴屏顶边，topInset 不生效）。
 *   底边 / 竖边贴边已退役：设置页不再提供顶 / 底选择（贴底边没有使用价值），
 *   parseDockConfig 把一切旧值归为 top；bottom 渲染分支保留只为类型稳定。
 *   沿边水平位置由 offset（岛中心/屏宽 0–1）决定：free / center 用 left 百分比 +
 *   translateX(-50%)，resize / 换屏天然按比例保持；start / end 吸附点渲染为贴边
 *   像素留白 + transform:none（data-snap 驱动），三点吸附才有「贴边」手感。
 * - 拖动（沿边 + 三点吸附，不做自由摆放、不换边）：编辑模式岛左端六点纹拖动柄
 *   pointerdown → 拖动期 rAF 逐帧只写 transform（不改 offset 状态），只沿顶边滑动。
 *   松手 snapOffset(中心比例, 屏宽, 32) → setDockPlacement 一次落盘，然后 FLIP：
 *   目标几何瞬时到位 + 补偿 transform 作为起始态，再把 transform 过渡到落点
 *   （--dur-dock-spring dockQ 弹簧，JS 侧经 animDurations().dockSpringMs 同源）——
 *   全程只动 transform 走合成器；reduce-motion 由
 *   全局门控把过渡压到 0.001s = 瞬移。
 *   拖动只在编辑模式发生，而 useClickThrough(!editMode) 此时不上报交互矩形，
 *   故拖动 rAF 内无需重报；退出编辑模式时 MutationObserver 自会重采集。
 * - hover 微涨（dock.mouse.hover="peak"）：折叠态挂 is-peak，padding 过渡
 *   360ms --ease-fx（宽 +16 / 高 +6 / 圆角 +3）；编辑 / 展开 / 隐藏期间不生效。
 * - 外形（ISLAND-POLISH）：dock.style === "bangs" 挂 is-bangs，几何全在
 *   feature-dock.css SHELL 区段（顶边贴屏 + 两侧过渡翼；仅顶边生效）。
 * - 自动隐藏（dock.autoHide，QQ 式）：开启后平时收进屏幕上缘只留 6px 一条（is-tucked，
 *   feature-dock.css 用独立 translate 属性 360ms 滑动，与 transform 基线互不覆盖）；那一条
 *   仍是岛的一部分且在屏内，Tauri 命中矩形照常上报——指针碰到即 pointerenter → 整体
 *   滑出；离开 TUCK_LEAVE_MS 后收回。编辑模式 / 有展开面 / 接管条活动期间强制弹出。
 * - 键盘：Ctrl+Shift+←/→ 沿边移到上一个 / 下一个吸附点（动画同拖动松手）。
 * - 子件：DockTiles（磁贴层）与 DockTakeoverLayer（接管层）叠在同一格，切换
 *   只动透明度；DockDropZone / DockPanel 挂在本组件内。DockShortcuts（全局热键）
 *   由 WidgetCanvas 挂在 dock.enabled 门控之外——关岛后热键仍要能开岛。
 * - 展开：点击磁贴 → expand-store 单值互斥（dock:<tileId>），WidgetExpandOverlay
 *   从磁贴矩形 500ms 弹性生长 / 360ms 收回 / 常驻叠放不重建。原矩形在展开
 *   瞬间从按钮 rect 采集（tileRefs），接管条点击落到对应类型磁贴时同法。
 * - 鼠标动作（dock.mouse）：hover=expand-first → 折叠态指针停留 300ms 展开
 *   首磁贴（停留门槛避免掠过屏幕边缘时误触）；blank=panel → 点空白开全岛面板；
 *   middle=collapse（默认）→ 中键收起岛上正在展开的面 / middle=panel → 开面板；
 *   wheel=cycle → 滚轮在磁贴间轮换展开（200ms 节流，无展开时从首 / 末枚起）。
 *   hover / wheel 在编辑模式（拖动柄 / 岛内排序）下不生效。
 * - 磁贴降级提示：widget-store.reconcileDockTiles 把绑定实例已永久删除的磁贴降级为
 *   无实例磁贴并派发 DOCK_TILES_DEGRADED_EVENT，这里弹一次 toast 列出磁贴名。
 * - 视图切换（dock.viewArrows）：岛两端各一枚窄「‹ ›」按钮，点击切到上一个 / 下一个
 *   视图（首尾循环）；只有一个视图时不渲染。桌面层不再有常驻视图切换器，这两枚
 *   按钮与设置页「视图」是仅有的两处切换入口（快捷键 / 命令面板除外）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "../../i18n-lite";
import { invoke, isTauri } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { animDurations } from "../../lib/durations";
import { prefersReducedMotion } from "../../lib/anim";
import { uiZoom } from "../../lib/ui-zoom";
import { useMediaPlaying } from "../../lib/use-now-playing";
import { ensureSystemNotifyListeners } from "../../lib/system-notify";
import { pushAppToast } from "../../components/ToastHost";
import { useWidgetExpand } from "../expand-store";
import { getWidgetMeta } from "../registry";
import {
  DOCK_TILES_DEGRADED_EVENT,
  useWidgetStore,
  type DockEdge,
  type DockSnap,
  type DockTile
} from "../widget-store";
import { WidgetExpandOverlay, type ExpandRect } from "../WidgetExpandOverlay";
import { HIT_RECTS_DIRTY_EVENT } from "../useClickThrough";
import { ensureNotificationListeners } from "../notifications/notification-store";
import { DockDropZone } from "./DockDropZone";
import { DockPanel } from "./DockPanel";
import { DockTakeoverLayer, useDockTakeover } from "./DockTakeover";
import { DockCoverBg } from "./DockCoverBg";
import { DockTileExpanded, dockTileDisplayName } from "./DockTile";
import { DockTiles } from "./DockTiles";
import {
  DOCK_EXPAND_PREFIX,
  DOCK_FLUSH_PX,
  DOCK_PANEL_EXPAND_ID,
  dockForceVisible,
  dockTileExpandId,
  dockTucked,
  snapOffset,
  TILE_MENU_LONG_PRESS_MS
} from "./dock-logic";
import "../../styles/feature-dock.css";

/** 沿边吸附距离（px）：任务口径，与 dock-logic.snapOffset 的缺省阈值一致。 */
const SNAP_PX = 32;

/** 全局左键监视开/关的单调序号——毫秒级收起→再展开时两条 fire-and-forget
 *  IPC 可能乱序到达（false 晚于 true 落地会把钩子错关）；每次调用带 seq，
 * Rust 侧按窗口只采纳最新一条（global_input.rs 的 WANTERS 记账）。 */
let leftClickWatchSeq = 0;
const setLeftClickWatch = (enabled: boolean) => {
  const seq = ++leftClickWatchSeq;
  void invoke("set_global_left_click_watch", { enabled, seq }).catch(() => {});
};
/** 吸附动画时长：二.7 起与收合 / 接管宽度共用 dockQ 弹簧（--dur-dock-spring）。
 *  实际值经 animDurations().dockSpringMs 实时取（时长双轨制收口：随
 *  设置→动效 速度档缩放），此处不再写死 450ms。 */
function snapAnimMs(): number {
  return Math.round(animDurations().dockSpringMs);
}
/** 自动隐藏：指针离开岛后多久收回（ms）。太短会在磁贴间移动时误收，太长像没收。 */
const TUCK_LEAVE_MS = 1200;
/** 二.8 悬停展开面的离开自动收起延迟：
 *  只作用于 hover=expand-first 这类「非点击打开」的展开面——点击打开是明确
 *  意图，必须常驻到 Esc / 岛外点击 / 中键。 */
const HOVER_COLLAPSE_MS = 1200;
/** 收合 / 弹出的 translate 过渡时长（ms），与 feature-dock.css .dock 的 translate 过渡同源（--dur-dock-spring，经 animDurations 实时取）。 */
function tuckAnimMs(): number {
  return snapAnimMs();
}
/** hover=expand-first 的停留门槛（ms）：指针掠过屏幕边缘不该把面板弹出来。 */
const HOVER_EXPAND_MS = 300;
/** hover 面板自动收起后的再武装冷却（ms）——防「收起 → 遮罩移除 →
 *  指针微动 → 再展开」的振荡回路（周期约 HOVER_COLLAPSE_MS + HOVER_EXPAND_MS）。 */
const HOVER_REARM_COOLDOWN_MS = 1500;

/** 五.11 岛启停出入场的卸载延迟 hook：enabled 翻 false 后保持挂载 fx 档时长
 *  播 is-leaving 收出再卸载；翻 true 立即恢复挂载（入场走挂载动画）。
 *  reduce-motion 命中时立即卸载（退场已被全局门控压为瞬跳，同口径）。 */
function useIslandMounted(enabled: boolean): boolean {
  const [mounted, setMounted] = useState(enabled);
  useEffect(() => {
    if (enabled) {
      setMounted(true);
      return;
    }
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), Math.round(animDurations().fxMs) + 40);
    return () => window.clearTimeout(t);
  }, [enabled]);
  return mounted;
}
/** wheel=cycle 的步进节流（ms）：一次滚轮手势会连发多枚 wheel 事件。 */
const WHEEL_STEP_MS = 200;
/** 键盘循环用三点，与 dock-logic.snapOffset 的吸附点一致。 */
const SNAP_POINTS: { snap: DockSnap; offset: number }[] = [
  { snap: "start", offset: 0 },
  { snap: "center", offset: 0.5 },
  { snap: "end", offset: 1 }
];

/** 渲染边：解析层已把 edge 归为 top，这里的 bottom 分支只为类型稳定保留。 */
type RenderedEdge = "top" | "bottom";
const renderedEdgeOf = (edge: DockEdge): RenderedEdge => (edge === "bottom" ? "bottom" : "top");

type Placement = { edge: RenderedEdge; offset: number; snap: DockSnap };

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** 拖动开始时的岛矩形（视口 CSS 像素）；拖动期 transform 无 Y 分量，top 恒等于它。 */
  origCenterX: number;
  origTop: number;
  width: number;
  height: number;
  /** 拖动开始时的配置边（松手原样回写）。 */
  edge: DockEdge;
  /** 起拖时静止态是否为贴边吸附（start / end：transform 基线是 none 而非 translateX(-50%)）。 */
  flush: boolean;
  /** 吸附动画在途抓起时的残留补偿（布局单位，解析自内联 transform）——
   *  拖动帧叠加其上，首帧不再回跳到静止位；Y 锁在残留值（拖动本就不改 Y）。 */
  baseDx: number;
  baseDy: number;
  /** document 级 lostpointercapture——编辑模式中途被翻掉时拖动柄直接卸载，
   *  该事件派发到 document 而非元素（React 根容器收不到），此处代收收会话，
   *  否则 dragRef 搁浅、onHandlePointerDown 对 dragRef 早退把后续拖动全压死。 */
  onLost: (ev: PointerEvent) => void;
};

export function DockShell({ bottomInset }: { bottomInset: number }) {
  const tr = useT();
  const dock = useWidgetStore((s) => s.dock);
  const editMode = useWidgetStore((s) => s.editMode);
  const setDockPlacement = useWidgetStore((s) => s.setDockPlacement);
  const views = useWidgetStore((s) => s.views);
  const activeView = useWidgetStore((s) => s.activeView);
  const setActiveView = useWidgetStore((s) => s.setActiveView);
  const expandedId = useWidgetExpand((s) => s.expandedId);
  const mountedIds = useWidgetExpand((s) => s.mountedIds);
  const expand = useWidgetExpand((s) => s.expand);
  const collapseIf = useWidgetExpand((s) => s.collapseIf);
  /* 展开面板标题需要绑定实例的显示名（重命名处处同步）——此前
     渲染期 getState() 非响应式读取，常驻挂载的面板标题在实例重命名后陈旧。
     instances 引用仅在增删/重命名提交时变化（拖动期走 dragPreview），
     订阅代价可接受。 */
  const instances = useWidgetStore((s) => s.instances);
  const { takeover, dismiss } = useDockTakeover(dock.enabled, tr, {
    pomodoro: dock.takeover.pomodoro,
    media: dock.takeover.media,
    notification: dock.takeover.notification,
    brightness: dock.takeover.brightness,
    volume: dock.takeover.volume,
    link: dock.takeover.link
  });
  /* 接管当前值经 ref 供定时器 / 手势回调在触发时刻复核（悬停停留期间接管可能
     出现，闭包捕获的是进入那一刻的旧值——与 DockTiles 的 takeoverRef 同款）。 */
  const takeoverRef = useRef(takeover);
  takeoverRef.current = takeover;
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [origins, setOrigins] = useState<Record<string, ExpandRect>>({});

  const dockRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const endDragRef = useRef<(commit: boolean) => void>(() => {});
  const rafRef = useRef(0);
  const animRef = useRef<{
    el: HTMLElement;
    timer: ReturnType<typeof setTimeout>;
    onEnd: (e: TransitionEvent) => void;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [peak, setPeak] = useState(false);
  /** 自动隐藏：指针进入岛后弹出；离开 TUCK_LEAVE_MS 后收回（计时器随再次进入取消）。 */
  const [revealed, setRevealed] = useState(false);
  const tuckTimer = useRef(0);
  /** hover=expand-first 的停留计时器；wheel=cycle 的上次步进时刻。 */
  const hoverExpandTimer = useRef(0);
  const lastWheelStep = useRef(0);
  /** 二.8：悬停打开的展开面 → 指针离开岛体/面板后延迟收起（陈旧计时器防误收：
   *  只收「挂计时那一刻对着的那一张」；期间若已换成别的展开面 / 用户点开过，
   *  计时器到点不动作）。 */
  const hoverCollapseTimer = useRef(0);
  const hoverCollapseTarget = useRef<string | null>(null);
  const openVia = useRef<Map<string, "click" | "hover">>(new Map());
  /* hover 面板自动收起后的再武装冷却——悬停展开的面板收起（遮罩移除）
     后，指针恰停在岛体未被面板覆盖的区域（岛宽 > 面板宽时两端外露）会立刻
     pointerenter → 300ms 再展开 → 1.2s 又收起，形成 ~1.5s 周期振荡。冷却
     窗内 hover 不再自动展开（点击 / 键盘不受影响）。 */
  const hoverRearmCooldownUntil = useRef(0);

  // 一.6：媒体播放态（仅 when-playing 模式消费；事件驱动订阅，无定时器）。
  const mediaPlaying = useMediaPlaying();

  /* 五.11 岛启停出入场：关岛不再瞬消——保持挂载播 is-leaving 收出（240ms
     fx 档）再卸载；开岛的滑入由 .dock 挂载动画承担（CSS 侧 dock-boot-in）。
     reduce-motion 命中时立即卸载（入场动画被全局门控压为瞬跳，无需等待）。 */
  const islandMounted = useIslandMounted(dock.enabled);

  // bangs 外形贴屏顶边（feature-dock.css 以 top:0 !important 落位）：FLIP 起始补偿
  // 也按 0 计算，否则吸附动画会多出 topInset 的纵向「探出」。
  const topInset = dock.style === "bangs" && renderedEdgeOf(dock.edge) === "top" ? 0 : dock.topInset;
  /* QQ 式自动隐藏的收合态：dock-logic.dockTucked/dockForceVisible 单一真源
     （二.12：编辑 / 展开面 / 接管（全 kind）/ 拖动 / 悬停任一成立即强制弹出，
     保证「弹出时机不由用户决定的内容」绝不被自动隐藏压掉）。
     dragging 同时并入磁贴拖拽会话（dockDrag 由 DockTiles 写入）——此前
     只覆盖拖动柄，磁贴拖出移除期间 autoHide 会在 1.2s 后收合岛体撕裂手势。 */
  const tileDragActive = useWidgetStore((s) => s.dockDrag != null);
  const tucked = dockTucked(
    dock.autoHide,
    mediaPlaying,
    dockForceVisible({ editMode, expandedId, takeover, dragging: dragging || tileDragActive, revealed })
  );

  useEffect(() => {
    if (dock.enabled) {
      ensureNotificationListeners();
      ensureSystemNotifyListeners();
    }
  }, [dock.enabled]);

  /* ---- 磁贴降级一次性提示（需求 §7 风险表）：reconcileDockTiles 派发的事件在此落 toast ---- */
  useEffect(() => {
    const onDegraded = (e: Event) => {
      const tiles = (e as CustomEvent<DockTile[]>).detail;
      if (!Array.isArray(tiles) || tiles.length === 0) return;
      const names = tiles.map((t) => tr(getWidgetMeta(t.type)?.name ?? t.type)).join("、");
      pushAppToast(tr("灵动岛磁贴已降级"), `${names} · ${tr("绑定的画布小组件已删除，磁贴改为通用形态")}`, "info");
    };
    window.addEventListener(DOCK_TILES_DEGRADED_EVENT, onDegraded);
    return () => window.removeEventListener(DOCK_TILES_DEGRADED_EVENT, onDegraded);
  }, [tr]);

  /* ---- 自动隐藏：关掉开关或岛被强制弹出时清掉待收回计时器，免得开关刚关又被旧计时器收一下。 ---- */
  useEffect(() => {
    if (dock.autoHide) return;
    window.clearTimeout(tuckTimer.current);
    tuckTimer.current = 0;
    setRevealed(false);
  }, [dock.autoHide]);

  /* 收合 / 弹出只是 translate 过渡，DOM 上除了 class 没别的变化：过渡结束后主动让
     useClickThrough 重采命中矩形，否则上报的还是滑动起点的矩形——收合后岛原位那块
     会变成吃掉点击的死区，弹出后下半截又点不到。 */
  useEffect(() => {
    const t = window.setTimeout(() => window.dispatchEvent(new CustomEvent(HIT_RECTS_DIRTY_EVENT)), tuckAnimMs() + 40);
    return () => window.clearTimeout(t);
  }, [tucked]);

  /* 远端 / 配置面板关岛时 DockShell 并不卸载（useIslandMounted 只是
     return null），卸载兜底的清理永不执行——enabled 翻 false 的瞬间就地
     清掉 dock: 前缀展开态。否则 expandedId 残留使 dockFaceActive 恒真
     （全局左键监视钩子常开）、重开岛面板凭空弹出、自动隐藏被拖垮。 */
  useEffect(() => {
    if (dock.enabled) return;
    const ex = useWidgetExpand.getState();
    if (ex.expandedId?.startsWith(DOCK_EXPAND_PREFIX)) ex.collapse();
    for (const id of ex.mountedIds) {
      if (id.startsWith(DOCK_EXPAND_PREFIX)) ex.forget(id);
    }
  }, [dock.enabled]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      // 拖动会话在途卸载（窗口销毁）——摘掉 document 级 lostpointercapture 监听。
      const d = dragRef.current;
      if (d) document.removeEventListener("lostpointercapture", d.onLost);
      window.clearTimeout(hoverExpandTimer.current);
      window.clearTimeout(tuckTimer.current);
      window.clearTimeout(hoverCollapseTimer.current);
      const anim = animRef.current;
      if (anim) {
        clearTimeout(anim.timer);
        anim.el.removeEventListener("transitionend", anim.onEnd);
      }
      // 经 DockConfigPanel / 设置窗远端关岛（enabled:false）时 DockShell 直接
      // 卸载，无人调 collapse/forget——expandedId 与 mountedIds 残留 dock:<tileId>，
      // 重新开岛时面板凭空弹出、dockForceVisible 恒真拖垮自动隐藏。卸载兜底清掉。
      const ex = useWidgetExpand.getState();
      if (ex.expandedId?.startsWith(DOCK_EXPAND_PREFIX)) ex.collapse();
      for (const id of ex.mountedIds) {
        if (id.startsWith(DOCK_EXPAND_PREFIX)) ex.forget(id);
      }
    },
    []
  );

  /* ---- 二.8 悬停展开面的延迟自动收起（schedule / cancel / fire 三件套） ---- */

  const cancelHoverCollapse = useCallback(() => {
    window.clearTimeout(hoverCollapseTimer.current);
    hoverCollapseTimer.current = 0;
    hoverCollapseTarget.current = null;
  }, []);

  /** 挂起一次延迟收起：只记「当前这张」；到点再次核对 expandedId 与打开方式，
   *  期间换了面板 / 变成点击打开就不动它。 */
  const scheduleHoverCollapse = useCallback(() => {
    const ex = useWidgetExpand.getState();
    const id = ex.expandedId;
    if (!id || !id.startsWith(DOCK_EXPAND_PREFIX)) return;
    if (openVia.current.get(id) !== "hover") return;
    window.clearTimeout(hoverCollapseTimer.current);
    hoverCollapseTarget.current = id;
    hoverCollapseTimer.current = window.setTimeout(() => {
      const target = hoverCollapseTarget.current;
      hoverCollapseTarget.current = null;
      hoverCollapseTimer.current = 0;
      const ex = useWidgetExpand.getState();
      if (!target || ex.expandedId !== target) return; // 已换面：不动
      if (openVia.current.get(target) !== "hover") return; // 已被点击接管：常驻
      ex.collapseIf(target);
      /* 真收起即进入再武装冷却（从收起时刻起算，非挂计时时刻）。 */
      hoverRearmCooldownUntil.current = Date.now() + HOVER_REARM_COOLDOWN_MS;
    }, HOVER_COLLAPSE_MS);
  }, []);

  /* ---- 二.9 岛外点击收起：Rust WH_MOUSE_LL 监视（按窗口记账） ----
     展开面出现 → 打开全局监视；收起 → 关闭。收到的 global:left-down 是
     「点了本应用窗口之外」的信号（点击落在穿透区也算外面——它去了桌面）。
     同类工具 的「唤醒点击防误收」在 Vela 不适用：收合岛靠 pointerenter 弹出，
     没有「点击唤醒」手势，天然无此 bug（审查结论，见 global_input.rs 注释）。 */
  const dockFaceActive = !!expandedId?.startsWith(DOCK_EXPAND_PREFIX);
  useEffect(() => {
    if (!isTauri()) return;
    if (dockFaceActive) {
      setLeftClickWatch(true);
      return () => {
        setLeftClickWatch(false);
      };
    }
  }, [dockFaceActive]);
  useTauriEvent<unknown>("global:left-down", () => {
    const ex = useWidgetExpand.getState();
    if (ex.expandedId?.startsWith(DOCK_EXPAND_PREFIX)) {
      cancelHoverCollapse();
      ex.collapse();
    }
  });

  /* 磁贴移除时清掉它的 openVia 记录（Map 不随卸载自清）。 */
  useEffect(() => {
    const live = new Set(dock.tiles.map((t) => dockTileExpandId(t.id)));
    for (const k of openVia.current.keys()) {
      if (!live.has(k)) openVia.current.delete(k);
    }
  }, [dock.tiles]);

  /* tileRefs / origins 同步回收已移除磁贴的键——此前 ref 表只置 null 不删
     键、origins 只增不减，磁贴 id 是一次性 uuid，长会话（反复加删磁贴）下
     两张表无限累积。 */
  useEffect(() => {
    const live = new Set(dock.tiles.map((t) => t.id));
    for (const k of Object.keys(tileRefs.current)) {
      if (!live.has(k)) delete tileRefs.current[k];
    }
    setOrigins((o) => {
      const stale = Object.keys(o).filter((k) => !live.has(k));
      if (stale.length === 0) return o;
      const next: Record<string, ExpandRect> = {};
      for (const k of Object.keys(o)) if (live.has(k)) next[k] = o[k];
      return next;
    });
  }, [dock.tiles]);

  const registerTileRef = useCallback((tileId: string, el: HTMLButtonElement | null) => {
    tileRefs.current[tileId] = el;
  }, []);

  const openTile = useCallback(
    (tile: DockTile, via: "click" | "hover" = "click") => {
      const el = tileRefs.current[tile.id];
      if (el) {
        /* ExpandRect 契约是布局单位（WidgetExpandOverlay 按 innerWidth 钳制、
           渲染为 CSS left/top；画布卡片路径传的一直是布局值）——gBCR 是视觉值，
           此前原样塞入，zoom≠100% 时展开/收回动画的起点矩形偏大且偏位。
           y 不直接用 gBCR，改「岛静止 top（topInset，布局）+ 磁贴在岛内
           的偏移（两 gBCR 之差）」——autoHide 收合的 tuck 过渡只平移 Y，该差值
           不受过渡影响，滑出途中悬停展开不再从半藏位置生长。 */
        const z = uiZoom();
        const r = el.getBoundingClientRect();
        const dy = dockRef.current ? r.top - dockRef.current.getBoundingClientRect().top : 0;
        setOrigins((o) => ({
          ...o,
          [tile.id]: { x: r.left / z, y: topInset + dy / z, w: r.width / z, h: r.height / z }
        }));
      }
      cancelHoverCollapse();
      openVia.current.set(dockTileExpandId(tile.id), via);
      expand(dockTileExpandId(tile.id));
    },
    [expand, cancelHoverCollapse, topInset]
  );

  const onTakeoverClick = () => {
    if (!takeover) return;
    /* 一.4 链接快开：点击接管条 = 默认浏览器打开（www. 开头补 https://），
     *  open_path 的 URL 分支走 explorer 默认处理器。 */
    if (takeover.kind === "link" && takeover.url && isTauri()) {
      const url = takeover.url.includes("://") ? takeover.url : `https://${takeover.url}`;
      void invoke("open_path", { path: url }).catch(() => {});
      dismiss();
      return;
    }
    const target =
      takeover.kind === "pomodoro" ? "pomodoro" : takeover.kind === "notification" ? "notifications" : null;
    const tile = target ? dock.tiles.find((t) => t.type === target) : undefined;
    if (tile) openTile(tile);
    dismiss();
  };

  /* ---- 几何：与 JSX style 完全同值的命令式写法（FLIP 起始态需先于 React 重渲染落到 DOM） ---- */

  const applyPlacementStyle = (el: HTMLElement, p: Placement) => {
    if (p.edge === "bottom") {
      el.style.top = "";
      el.style.bottom = `${bottomInset + 48}px`;
    } else {
      el.style.bottom = "";
      el.style.top = `${topInset}px`;
    }
    el.style.right = "";
    // end 吸附点必须显式 left:auto：.dock 基础样式有 left:50%，fixed 元素左右
    // 同时约束会把岛拉宽成一条。
    if (p.snap === "start") el.style.left = `${DOCK_FLUSH_PX}px`;
    else if (p.snap === "end") {
      el.style.left = "auto";
      el.style.right = `${DOCK_FLUSH_PX}px`;
    } else el.style.left = `${p.offset * 100}%`;
    el.dataset.snap = p.snap;
  };

  /**
   * FLIP 到新落点：先把目标几何写到位并用补偿 transform 钉住当前视觉位置，
   * 强制回流提交起始态，再只过渡 transform 到静止值（start/end 为 none，其余
   * translateX(-50%)，与 CSS data-snap 规则一致），结束后清掉内联让 CSS 接管。
   */
  const animatePlacement = (from: { centerX: number; top: number }, to: Placement) => {
    const el = dockRef.current;
    if (!el) return;
    const prev = animRef.current;
    if (prev) {
      clearTimeout(prev.timer);
      prev.el.removeEventListener("transitionend", prev.onEnd);
      animRef.current = null;
    }
    /* 坐标模型（ui-zoom.ts）：gBCR / 指针是视觉坐标，left/top/transform 是
       布局单位（渲染时 ×zoom）。from 来自 gBCR、rect 同为视觉——统一除回
       uiZoom 后再与布局目标（vw/topInset 均未缩放）求差，zoom≠1 时 FLIP
       起始补偿不再漂移。 */
    const z = uiZoom();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    const half = rect.width / 2 / z;
    const flush = to.snap === "start" || to.snap === "end";
    const targetCenterX =
      to.snap === "start" ? DOCK_FLUSH_PX + half : to.snap === "end" ? vw - DOCK_FLUSH_PX - half : to.offset * vw;
    const targetTop = to.edge === "bottom" ? vh - (bottomInset + 48) - rect.height / z : topInset;
    const dx = from.centerX / z - targetCenterX;
    const dy = from.top / z - targetTop;

    el.style.transition = "none";
    applyPlacementStyle(el, to);
    el.style.transform = flush ? `translate(${dx}px, ${dy}px)` : `translate(calc(-50% + ${dx}px), ${dy}px)`;
    el.getBoundingClientRect();

    const ms = snapAnimMs();
    el.style.transition = `transform ${ms}ms var(--ease-dock-spring)`;
    el.style.transform = flush ? "translate(0px, 0px)" : "translateX(-50%)";

    // transitionend 缺席（reduce-motion 压到 0.001s 仍会触发；display:none 不会）
    // 时由兜底定时器清理，两条路径共用同一个 cleanup。cleanup 里顺带让
    // useClickThrough 重采：吸附过渡中途若发生采集（style 变更节流路径），
    // 上报的是插值中的矩形，清内联后岛已到位而矩形停在半路——磁贴点击
    // 会穿透（同类成因，与 tucked 的处理同款）。
    const node: HTMLElement = el;
    function cleanup() {
      clearTimeout(timer);
      node.style.transition = "";
      node.style.transform = "";
      node.removeEventListener("transitionend", onEnd);
      animRef.current = null;
      window.dispatchEvent(new CustomEvent(HIT_RECTS_DIRTY_EVENT));
    }
    function onEnd(e: TransitionEvent) {
      if (e.target !== node || e.propertyName !== "transform") return;
      cleanup();
    }
    const timer = setTimeout(cleanup, ms + 100);
    node.addEventListener("transitionend", onEnd);
    animRef.current = { el: node, timer, onEnd };
  };

  /* ---- 拖动柄：pointerdown 起拖，rAF 逐帧只写 transform，松手一次 commit ---- */

  const applyDragFrame = () => {
    const d = dragRef.current;
    const el = dockRef.current;
    if (!d || !el) return;
    /* 钳制统一在视觉坐标系内进行——origCenterX / lastX / width 都是
       视觉值（gBCR / 指针），innerWidth 是布局单位，此前直接相减：zoom=125%
       时岛拖不到右侧 20% 屏区。 */
    const vw = window.innerWidth * uiZoom();
    const half = d.width / 2;
    // 只沿顶边滑动：X 跟手且岛不出视口，Y 锁死在起拖时的视觉位（baseDy 含
    // 在途吸附动画的残留补偿）。位移叠在起拖时的静止 transform 基线上
    // （贴边吸附为 none，其余为 -50% 居中），否则首帧会跳半个岛宽。
    const cx = Math.min(vw - half, Math.max(half, d.origCenterX + (d.lastX - d.startX)));
    // 视觉位移 ÷zoom 才是布局单位（ui-zoom 坐标模型），否则缩放 ≠100% 时
    // 拖动中的岛以 zoom 倍速脱离指针。
    const dx = (cx - d.origCenterX) / uiZoom();
    el.style.transform = d.flush
      ? `translate(${d.baseDx + dx}px, ${d.baseDy}px)`
      : `translate(calc(-50% + ${d.baseDx + dx}px), ${d.baseDy}px)`;
  };

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const el = dockRef.current;
    if (!editMode || e.button !== 0 || !el || dragRef.current) return;
    const anim = animRef.current;
    if (anim) {
      clearTimeout(anim.timer);
      anim.el.removeEventListener("transitionend", anim.onEnd);
      animRef.current = null;
    }
    const r = el.getBoundingClientRect();
    const cur = useWidgetStore.getState().dock;
    /* 吸附动画在途抓起——内联 transform 还带着未走完的补偿位移，解析成
       基线（拖动帧叠加其上），首帧不再回跳到静止位。两种书写格式各恰好含
       两个 px 值（calc 的 -50% 无单位）：flush → [dx, dy]，calc → [dx, dy]；
       静止态内联为空串 → 基线 0,0。 */
    const px = el.style.transform.match(/-?[\d.]+px/g);
    const baseDx = px ? parseFloat(px[0]) : 0;
    const baseDy = px && px.length > 1 ? parseFloat(px[1]) : 0;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      origCenterX: r.left + r.width / 2,
      origTop: r.top,
      width: r.width,
      height: r.height,
      edge: cur.edge,
      flush: cur.snap === "start" || cur.snap === "end",
      baseDx,
      baseDy,
      onLost: () => {}
    };
    const d = dragRef.current;
    // 编辑模式中途被翻掉 → 拖动柄卸载 → lostpointercapture 派发到
    // document（React 根收不到）——document 级代收，原位放回收会话。
    d.onLost = (ev: PointerEvent) => {
      if (dragRef.current !== d || ev.pointerId !== d.pointerId) return;
      endDragRef.current(false);
    };
    document.addEventListener("lostpointercapture", d.onLost);
    el.style.transition = "none";
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(applyDragFrame);
  };

  const endDrag = (commit: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    document.removeEventListener("lostpointercapture", d.onLost);
    cancelAnimationFrame(rafRef.current);
    setDragging(false);
    const el = dockRef.current;
    if (!el) return;

    /* 与 applyDragFrame 同款——endDrag 的钳制与 ratio 都在视觉坐标系
       内算（此前视觉 cx ÷ 布局 vw，落盘 offset 是真实位置的 1/z 倍，自由位
       松手后岛跳位）。 */
    const vw = window.innerWidth * uiZoom();
    const half = d.width / 2;
    const cx = Math.min(vw - half, Math.max(half, d.origCenterX + (d.lastX - d.startX)));
    const moved = Math.abs(d.lastX - d.startX) > 2 || Math.abs(d.lastY - d.startY) > 2;
    const cur = useWidgetStore.getState().dock;

    if (!commit || !moved) {
      if (!moved && d.baseDx === 0 && d.baseDy === 0) {
        // 静止位抓起未移动：无残留补偿可续，直接清内联（零成本路径）。
        el.style.transition = "";
        el.style.transform = "";
        return;
      }
      /* 中途（吸附动画在途）抓起后放回 / 取消：从中途视觉位继续过渡到当前
         配置落点——此前直接清内联 transform 会瞬跳。 */
      const r = el.getBoundingClientRect();
      animatePlacement(
        { centerX: r.left + r.width / 2, top: r.top },
        { edge: renderedEdgeOf(cur.edge), offset: cur.offset, snap: cur.snap }
      );
      return;
    }

    // 岛中心被钳在可见范围内，贴到钳制边界即视觉贴边：比例归到 0 / 1，
    // 让 start / end 两点在拖动中可达（snapOffset 的三点按中心比例定义）。
    let ratio = cx / vw;
    if (cx - half <= SNAP_PX) ratio = 0;
    else if (vw - (cx + half) <= SNAP_PX) ratio = 1;
    const { offset, snap } = snapOffset(ratio, vw, SNAP_PX);
    setDockPlacement({ edge: d.edge, offset, snap });
    animatePlacement({ centerX: cx, top: d.origTop }, { edge: renderedEdgeOf(d.edge), offset, snap });
  };
  endDragRef.current = endDrag;

  /* ---- 键盘：Ctrl+Shift+←/→ 循环三点（在岛内任意焦点位生效，编辑模式限定） ---- */

  const stepSnapPoint = (dir: 1 | -1) => {
    const cur = useWidgetStore.getState().dock;
    const eps = 1e-4;
    const next =
      dir === 1
        ? (SNAP_POINTS.find((p) => p.offset > cur.offset + eps) ?? SNAP_POINTS[0])
        : ([...SNAP_POINTS].reverse().find((p) => p.offset < cur.offset - eps) ?? SNAP_POINTS[SNAP_POINTS.length - 1]);
    setDockPlacement({ edge: cur.edge, offset: next.offset, snap: next.snap });
    const el = dockRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    animatePlacement(
      { centerX: r.left + r.width / 2, top: r.top },
      { edge: renderedEdgeOf(cur.edge), offset: next.offset, snap: next.snap }
    );
  };

  const onDockKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!editMode || dragRef.current) return;
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    stepSnapPoint(e.key === "ArrowLeft" ? -1 : 1);
  };

  /* ---- 鼠标动作：hover（peak 微涨 / expand-first 停留展开首磁贴）---- */

  /** 折叠态判定：编辑中 / 有展开面 / 接管期，hover 类动作一律不生效——接管期
   *  磁贴层 opacity:0 隐藏，悬在接管条上不该把看不见的磁贴弹出来（DockTiles
   *  各手势的 takeover 守卫同纪律，此前 Shell 层三个 入口漏了）。 */
  const isFolded = () => {
    if (takeoverRef.current) return false;
    const s = useWidgetStore.getState();
    return !s.editMode && !useWidgetExpand.getState().expandedId;
  };

  const onDockPointerEnter = () => {
    // 自动隐藏：指针进入岛（含收合后留在屏内的那一条）即弹出，并取消待收回计时。
    window.clearTimeout(tuckTimer.current);
    tuckTimer.current = 0;
    if (useWidgetStore.getState().dock.autoHide) setRevealed(true);
    // 二.8：回到岛上 = 还在跟这张悬停面板交互，取消挂起的自动收起。
    cancelHoverCollapse();
    if (!isFolded()) return;
    const hover = useWidgetStore.getState().dock.mouse.hover;
    if (hover === "peak") {
      setPeak(true);
      return;
    }
    if (hover !== "expand-first") return;
    window.clearTimeout(hoverExpandTimer.current);
    hoverExpandTimer.current = window.setTimeout(() => {
      hoverExpandTimer.current = 0;
      const s = useWidgetStore.getState();
      const first = s.dock.tiles[0];
      if (!first || s.dock.mouse.hover !== "expand-first" || !isFolded()) return;
      /* hover 自动收起的冷却窗内不再自动展开（防振荡；点击路径不受影响）。 */
      if (Date.now() < hoverRearmCooldownUntil.current) return;
      openTile(first, "hover");
    }, HOVER_EXPAND_MS);
  };
  const onDockPointerLeave = () => {
    setPeak(false);
    window.clearTimeout(hoverExpandTimer.current);
    hoverExpandTimer.current = 0;
    // 二.8：离开岛体 → 悬停打开的面板挂延迟收起（点击打开的不动）。
    scheduleHoverCollapse();
    if (!useWidgetStore.getState().dock.autoHide) return;
    // 离开后延时收回：在磁贴间横向移动时指针可能短暂出岛，立刻收会抖。
    window.clearTimeout(tuckTimer.current);
    tuckTimer.current = window.setTimeout(() => {
      tuckTimer.current = 0;
      setRevealed(false);
    }, TUCK_LEAVE_MS);
  };

  /* ---- 鼠标动作：wheel=cycle 在磁贴间轮换展开（节流；无展开时从首 / 末枚起） ---- */
  const onDockWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const s = useWidgetStore.getState();
    if (s.dock.mouse.wheel !== "cycle" || s.editMode || dragRef.current || takeoverRef.current) return;
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    const now = performance.now();
    if (now - lastWheelStep.current < WHEEL_STEP_MS) return;
    const list = s.dock.tiles;
    if (list.length === 0) return;
    lastWheelStep.current = now;
    const dir = delta > 0 ? 1 : -1;
    const expandedNow = useWidgetExpand.getState().expandedId;
    const cur = list.findIndex((t) => dockTileExpandId(t.id) === expandedNow);
    const next = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
    openTile(list[next]);
  };

  const tiles = dock.tiles;
  /* 五.11：enabled=false 时保持挂载播收出动画，动画完才真正卸载。 */
  if (!islandMounted) return null;
  const islandLeaving = !dock.enabled;

  /* 「‹ ›」视图切换：按 views 顺序取相邻视图，首尾循环；单视图无可切目标，不渲染。
     开关（dock.viewArrows）不走条件渲染而是挂 is-off：按钮收合到 0 宽 + 淡出，岛宽跟着
     网格列平滑过渡，而不是瞬间多出 / 少掉 36px。 */
  const showViewArrows = views.length > 1;
  const arrowsOn = dock.viewArrows;
  /* 箭头只在真可见时进 Tab 序——is-off（CSS 收合）与接管期（.has-takeover
     的 opacity:0 隐藏）都只是视觉隐藏，元素仍可聚焦；tucked 时整个岛体
     aria-hidden，箭头与磁贴一并退出焦点序（DockTiles 侧同口径 tabIndex=-1）。 */
  const arrowsLive = arrowsOn && !takeover && !tucked;
  const viewIdx = Math.max(
    0,
    views.findIndex((v) => v.id === activeView)
  );
  const prevView = views[(viewIdx - 1 + views.length) % views.length];
  const nextView = views[(viewIdx + 1) % views.length];

  const onShellClick = (e: MouseEvent<HTMLDivElement>) => {
    if (dock.mouse.blank !== "panel") return;
    if (useWidgetStore.getState().editMode || takeover) return;
    /* 磁贴层 flex 铺满岛体，严格 e.target===currentTarget 时命中区只剩
       3px padding 环——磁贴层自身的背景（磁贴之间 / 上下的空隙）也算「空白」；
       磁贴按钮 / 箭头等控件的 target 是控件自身，不匹配 data-dock-blank，
       照常各自消费点击不受影响。 */
    const t = e.target as HTMLElement;
    if (e.target !== e.currentTarget && !t.matches("[data-dock-blank]")) return;
    expand(DOCK_PANEL_EXPAND_ID);
  };
  /* middle=panel → 全岛面板（接管期让位，不展开）；middle=collapse（默认）→
     收起岛上正在展开的面（磁贴 / 全岛面板），画布实例的展开不受影响。 */
  const onShellAuxClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 1) return;
    if (dock.mouse.middle === "panel") {
      if (!takeoverRef.current) expand(DOCK_PANEL_EXPAND_ID);
      return;
    }
    const ex = useWidgetExpand.getState();
    if (ex.expandedId?.startsWith(DOCK_EXPAND_PREFIX)) ex.collapse();
  };

  const renderedEdge = renderedEdgeOf(dock.edge);
  const placement: CSSProperties = renderedEdge === "bottom" ? { bottom: bottomInset + 48 } : { top: topInset };
  if (dock.snap === "start") placement.left = DOCK_FLUSH_PX;
  else if (dock.snap === "end") {
    placement.left = "auto";
    placement.right = DOCK_FLUSH_PX;
  } else placement.left = `${dock.offset * 100}%`;
  /* 自动隐藏收合量要补偿顶部内边距（is-tucked 平移 -100% - inset，见 feature-dock.css）：
     否则胶囊外形收进屏幕上缘后还露出一截（贴边刘海 top=0 无此问题）。 */
  (placement as Record<string, string>)["--dock-inset"] = renderedEdge === "bottom" ? "0px" : `${topInset}px`;
  /* 长按渐进压下的时长单点化：CSS 的 .is-pressing 过渡消费本变量，值来自
     dock-logic 常量——此前 CSS 写死 600ms 靠注释与 JS 对账，改值必须两处同步。 */
  (placement as Record<string, string>)["--dock-press-dur"] = `${TILE_MENU_LONG_PRESS_MS}ms`;

  const isPeak = peak && dock.mouse.hover === "peak" && !editMode && !expandedId && !dragging && !tucked;
  const className =
    "dock" +
    ` dock-edge-${dock.edge}` +
    (dock.style === "bangs" ? " is-bangs" : "") +
    (takeover ? " has-takeover" : "") +
    (editMode ? " is-editing" : "") +
    (dragging ? " is-dragging" : "") +
    (isPeak ? " is-peak" : "") +
    (tucked ? " is-tucked" : "") +
    (islandLeaving ? " is-leaving" : "");

  return (
    <>
      <div
        ref={dockRef}
        className={className}
        style={placement}
        data-interactive
        data-snap={dock.snap}
        role="toolbar"
        aria-label={tr("灵动岛")}
        aria-hidden={tucked || undefined}
        onClick={onShellClick}
        onAuxClick={onShellAuxClick}
        onWheel={onDockWheel}
        onKeyDown={onDockKeyDown}
        onPointerEnter={onDockPointerEnter}
        onPointerLeave={onDockPointerLeave}
      >
        {editMode && (
          <button
            type="button"
            className="dock-handle"
            data-interactive
            aria-label={tr("拖动灵动岛")}
            aria-keyshortcuts="Control+Shift+ArrowLeft Control+Shift+ArrowRight"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={(e) => {
              if (dragRef.current?.pointerId === e.pointerId) endDragRef.current(true);
            }}
            onPointerCancel={(e) => {
              if (dragRef.current?.pointerId === e.pointerId) endDragRef.current(false);
            }}
            onLostPointerCapture={(e) => {
              if (dragRef.current?.pointerId === e.pointerId) endDragRef.current(false);
            }}
          />
        )}
        {/* [DOCK-COVER]：媒体封面/专注态背景层，
            铺满岛体垫在磁贴与接管层之下。 */}
        <DockCoverBg />
        {/* 常规磁贴层与接管层常驻叠放，切换的只是透明度（内容 200ms 交叉淡化）。 */}
        {showViewArrows && (
          <button
            type="button"
            className={`dock-view-arrow is-prev${arrowsOn ? "" : " is-off"}`}
            data-interactive
            aria-label={`${tr("上一视图")}：${prevView.name}`}
            title={`${tr("上一视图")}：${prevView.name}`}
            aria-hidden={arrowsLive ? undefined : true}
            tabIndex={arrowsLive ? undefined : -1}
            disabled={!arrowsOn}
            onClick={() => setActiveView(prevView.id)}
          >
            <ChevronLeft size={14} />
          </button>
        )}
        <DockTiles
          tiles={tiles}
          takeoverActive={!!takeover}
          tucked={tucked}
          registerTileRef={registerTileRef}
          onTileOpen={openTile}
        />
        <DockTakeoverLayer takeover={takeover} onClick={onTakeoverClick} />
        {showViewArrows && (
          <button
            type="button"
            className={`dock-view-arrow is-next${arrowsOn ? "" : " is-off"}`}
            data-interactive
            aria-label={`${tr("下一视图")}：${nextView.name}`}
            title={`${tr("下一视图")}：${nextView.name}`}
            aria-hidden={arrowsLive ? undefined : true}
            tabIndex={arrowsLive ? undefined : -1}
            disabled={!arrowsOn}
            onClick={() => setActiveView(nextView.id)}
          >
            <ChevronRight size={14} />
          </button>
        )}
      </div>

      <DockDropZone />
      <DockPanel />

      {/* 展开面板：首次点开后常驻挂载（expand-store.mountedIds），收起只是 idle。
          二.8：内容包一层 hover-surface——指针在面板上 = 还在交互（取消自动收起），
          离开面板且不在岛体上 = 挂延迟收起（仅对悬停打开的面板生效）。 */}
      {tiles
        .filter((tile) => mountedIds.includes(dockTileExpandId(tile.id)))
        .map((tile) => {
          const id = dockTileExpandId(tile.id);
          const active = expandedId === id;
          const origin = origins[tile.id] ?? {
            x: window.innerWidth / 2 - 24,
            y: renderedEdge === "bottom" ? window.innerHeight - bottomInset - 80 : topInset,
            w: 48,
            h: 34
          };
          return (
            <WidgetExpandOverlay
              key={id}
              active={active}
              origin={origin}
              title={dockTileDisplayName(tile, instances, tr)}
              onClose={() => collapseIf(id)}
              /* middle=collapse 的可达落点——模态遮罩盖住岛本体，岛上的
                 auxclick 永远收不到，中键收起由遮罩代收（见 onShellAuxClick）。 */
              onAuxCollapse={() => {
                if (useWidgetStore.getState().dock.mouse.middle === "collapse") collapseIf(id);
              }}
              sizeKey={`dock:${tile.type}`}
              scrim={false}
            >
              <div
                className="dock-expand-surface"
                onPointerEnter={cancelHoverCollapse}
                onPointerLeave={scheduleHoverCollapse}
              >
                <DockTileExpanded tile={tile} active={active} />
              </div>
            </WidgetExpandOverlay>
          );
        })}
    </>
  );
}
