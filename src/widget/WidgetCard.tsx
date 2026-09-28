/**
 * 单个小组件卡片：实例渲染外壳 + 编辑态交互。
 *
 * 职责：绝对定位/尺寸/透明度样式；拖拽移动（组内多选刚性平移、网格吸附、
 * 对齐参考线）与 8 向缩放（PERF-1/F-2：rAF 节流 + 位移直写 DOM transform、
 * 会话期挂起跨窗口广播，pointerup 一次性 commit）；就地配置弹层（B1：悬浮
 * 工具条与右键菜单的「配置」不再跳设置窗口）、置顶/底层、复制、穿透开关、
 * 右键删除。内部组件经 registry 懒加载并包错误边界。
 */
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Maximize2,
  MousePointerClick,
  Pencil,
  Settings,
  Trash2,
  X
} from "lucide-react";
import { getWidgetMeta, preloadExpanded } from "./registry";
import { createDockTile, useWidgetStore, GRID, MAX_Z } from "./widget-store";
import { useWidgetExpand } from "./expand-store";
import { useFileDragStore } from "./file-drag-store";
import { setWidgetsSyncSuspended } from "../lib/cross-window";
import { resumeHitRects, suspendHitRects } from "./useClickThrough";
import { useSettingsStore } from "../store/settings-store";
import { useT } from "../i18n-lite";
import { openContextMenu } from "../components/ContextMenu";
import { pushAppToast } from "../components/ToastHost";
import { pickSpatialEase, prefersReducedMotion, useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useSafeTimeout } from "../lib/use-safe-timeout";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";
import { WidgetConfigPopover } from "./WidgetConfigPopover";

/* C1 沉浸遮罩层懒加载：连其 CSS（feature-immersive.css）一起进独立 chunk，
   首次展开（或悬停「展开」按钮预热）才加载，主 bundle 不背负沉浸样式。
   挂载即播 origin→沉浸矩形 的入场相位（见 WidgetExpandOverlay 相位机）。 */
const WidgetExpandOverlay = lazy(() => import("./WidgetExpandOverlay"));

type Props = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  opacity?: number;
  clickThrough?: boolean;
  /** false 时开启穿透也不显示右上角「穿透」角标（缺省显示）。 */
  ctBadge?: boolean;
};

type ResizeState = {
  handle: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
};

/* ------------------------------------------------------------------ */
/*  边缘缩放区域：细长条覆盖整个边缘，任意位置均可拖动调整大小           */
/*  角落保持小块以便同时调整两个方向。                                  */
/* ------------------------------------------------------------------ */
/* A14（可用性）：命中区从 6px/2px 加宽到 10px/8px——2px 边在高 DPI 与
   zoom≠100% 下几乎无法命中，新用户也发现不了卡片可缩放。视觉仍由 CSS
   控制（默认透明、悬停浮现），这里只是不可见的命中范围。 */
const HS = 10; // corner handle size
const EDGE = 8; // edge thickness

interface HandleDef {
  id: string;
  cursor: string;
  /** 读屏标签：手柄本身无文字，键盘缩放由 Shift+方向键承担。 */
  label: string;
  style: React.CSSProperties;
}

// 更细的引导条，紧贴悬浮窗边缘，四角与四条边相连形成全封闭的缩放框。
const HANDLES: HandleDef[] = [
  // 四角（小块，允许同时拖拽两个方向）
  { id: "nw", cursor: "nw-resize", label: "缩放：左上角", style: { top: 0, left: 0, width: HS, height: HS } },
  { id: "ne", cursor: "ne-resize", label: "缩放：右上角", style: { top: 0, right: 0, width: HS, height: HS } },
  { id: "se", cursor: "se-resize", label: "缩放：右下角", style: { bottom: 0, right: 0, width: HS, height: HS } },
  { id: "sw", cursor: "sw-resize", label: "缩放：左下角", style: { bottom: 0, left: 0, width: HS, height: HS } },
  // 四条边：细长条覆盖边缘，与四角相接形成封闭框
  { id: "n", cursor: "n-resize", label: "缩放：上边缘", style: { top: 0, left: HS, right: HS, height: EDGE } },
  { id: "s", cursor: "s-resize", label: "缩放：下边缘", style: { bottom: 0, left: HS, right: HS, height: EDGE } },
  { id: "w", cursor: "w-resize", label: "缩放：左边缘", style: { left: 0, top: HS, bottom: HS, width: EDGE } },
  { id: "e", cursor: "e-resize", label: "缩放：右边缘", style: { right: 0, top: HS, bottom: HS, width: EDGE } }
];

/* ------------------------------------------------------------------ */
/*  工具函数                                                          */
/* ------------------------------------------------------------------ */
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** 对齐吸附阈值（px）：拖拽中的边/中线与目标线距离小于该值时吸附。 */
const ALIGN_THRESHOLD = 8;

/** 拖拽合并（BentoDesk 借鉴 #2）命中：光标所在、未被拖拽、未编组的
    卡片里取 z 最高者——即投放点可见的最上层卡；堆叠卡片只命中露出者。 */
function mergeTargetAt(
  instances: { id: string; x: number; y: number; w: number; h: number; z: number; groupId?: string }[],
  cx: number,
  cy: number,
  draggedIds: string[]
) {
  let best: (typeof instances)[number] | null = null;
  for (const i of instances) {
    if (draggedIds.includes(i.id) || i.groupId) continue;
    if (cx < i.x || cx > i.x + i.w || cy < i.y || cy > i.y + i.h) continue;
    if (!best || i.z > best.z) best = i;
  }
  return best;
}

function WidgetCardBase({ id, type, x, y, w, h, z, opacity, clickThrough, ctBadge }: Props) {
  const tr = useT();
  const meta = getWidgetMeta(type);
  /* 多实例命名：同类型实例 ≥2 个时按创建序在名称后追加序号（快捷方式/快捷方式2…），
     只有一个时保持注册名原样。
     订阅派生值而非 instances 数组引用：拖拽 commit / 改任意一张卡的配置 / 置顶
     都会换数组引用，原始引用订阅会把这类写入放大成全部 N 张 memo 卡重渲
     （memo 只挡 props，挡不住 hook 变化）；签名只在「同类型成员增删」时变化。
     selector 每次全表扫是 O(N)/卡，与原 useMemo 失效重算同阶，但重渲被消掉。 */
  const instanceIndex = useWidgetStore((s) => {
    let n = 0;
    let idx = -1;
    for (const i of s.instances) {
      if (i.type !== type) continue;
      if (i.id === id) idx = n;
      n++;
    }
    return n > 1 ? idx : -1;
  });
  // 全局不透明度驱动整窗透明度（组件设置里的每窗 opacity 作为乘数）。
  const globalOpacity = useSettingsStore((s) => s.widgetOpacity);
  // 透明度滑条拖动中的瞬态预览（仅本卡订阅）：拖动期间 instances 未写，
  // 画布与其余卡片不重渲；松手后 updateWidget 一次性提交。
  const previewOpacity = useWidgetStore((s) =>
    s.opacityPreview && s.opacityPreview.id === id ? s.opacityPreview.value : null
  );
  const editMode = useWidgetStore((s) => s.editMode);
  // P2（审计修复）：订阅派生布尔而非原始 selectedId/selectedIds 引用——原始
  // 值订阅下任一选择变化（框选逐个命中、Ctrl+点击）都会让全部 N 张 memo 卡片
  // 重渲染（memo 只挡 props，挡不住 hook 变化）。
  const isSelected = useWidgetStore((s) => s.selectedId === id || s.selectedIds.includes(id));
  // 键盘微移/缩放只由「主单元」（selectedId，setSelected 恒取选中集最后一个）
  // 挂监听：多选时若每张选中卡都各挂一个全局 keydown，一次方向键会被
  // moveSelectedBy（本身就平移全部选中项）执行 N 次，整组跳 N×GRID。
  const isPrimarySelection = useWidgetStore((s) => s.selectedId === id);
  const selectWidget = useWidgetStore((s) => s.selectWidget);
  const toggleSelect = useWidgetStore((s) => s.toggleSelect);
  const update = useWidgetStore((s) => s.updateWidget);
  const removeAnimated = useWidgetStore((s) => s.removeWidgetsAnimated);
  const moveSelectedBy = useWidgetStore((s) => s.moveSelectedBy);
  const bringToFront = useWidgetStore((s) => s.bringToFront);
  const sendToBack = useWidgetStore((s) => s.sendToBack);
  const setEditMode = useWidgetStore((s) => s.setEditMode);
  const duplicateW = useWidgetStore((s) => s.duplicateWidget);
  /* D 节动画标记订阅 */
  const exiting = useWidgetStore((s) => s.exitingIds.includes(id));
  const entering = useWidgetStore((s) => s.enteringIds.includes(id));
  const pulsing = useWidgetStore((s) => s.pulseIds.includes(id));
  const posAnim = useWidgetStore((s) => s.posAnimIds.includes(id));
  /* A3 小增量降档：pos-anim（批量对齐 / #76 越界 clamp）的一次性 left/top 过渡
     按本次提交的位移量选档——≤20px 走 elementMove 快档（350ms），更大位移走
     cardReflow 默认档（500ms）。渲染期用 prevPos（上一提交位置）算 delta，选档
     结果与新坐标同帧内联，过渡才会以所选曲线起步；posLatched 把声明保留到
     过渡结束（durMs+60）——store 的 .pos-anim 类 280ms 就摘，若声明随之消失，
     运行中的过渡会被浏览器取消而瞬移（CSS Transitions §3 规则 3）。
     reduce-motion 下不内联，交给 CSS 的 transition:none !important 压制。 */
  const prevPos = useRef({ x, y });
  const posSeq = useRef(0);
  const [posLatched, setPosLatched] = useState<string | undefined>();
  const posMoved = posAnim ? Math.max(Math.abs(x - prevPos.current.x), Math.abs(y - prevPos.current.y)) : 0;
  let posCss: string | undefined;
  let posDur = 0;
  if (posMoved >= 1 && !prefersReducedMotion()) {
    const { ease, durMs } = pickSpatialEase(posMoved);
    posCss = `left ${durMs}ms ${ease}, top ${durMs}ms ${ease}`;
    posDur = durMs;
  }
  const posTransition = posCss ?? posLatched;
  /* PERF-1（v2）：拖拽预览不再走 store——位移在 onDragMove 里直写各卡 DOM
     transform，pointerup 一次性 commit。旧版逐帧 setDragPreview 生成新引用，
     组内每张卡每帧 reconcile（dragPreview[id] 订阅随之移除）。 */
  /* 缩放瞬态预览矩形：只有正在缩放的卡片读到非空值；其余卡片恒为 null。 */
  const resizeRect = useWidgetStore((s) => (s.resizePreview && s.resizePreview.id === id ? s.resizePreview : null));
  /* #74 开启鼠标穿透时的确认反馈：卡片短暂降透明 + 角标。 */
  const [ctFlash, setCtFlash] = useState(false);
  const [dragging, setDragging] = useState(false);
  /* [DROP] 松手命中灵动岛后卡片不提交位移、回原位：挂 .dock-drop-back 播 160ms 回弹。 */
  const [dockSpring, setDockSpring] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  /* B1 就地配置弹层：悬浮工具条/右键菜单的「配置」打开，不再跳设置窗口。 */
  const [configOpen, setConfigOpen] = useState(false);
  const closeConfig = useCallback(() => setConfigOpen(false), []);
  /* C1 展开态：expandedId 单值互斥（expand-store）；expandedOnce 后遮罩常驻
     （active=false → display:none，内容层不重建）。派生布尔订阅，非展开卡
     恒 false，memo 不受其他卡展开影响。 */
  const hasExpanded = !!meta?.ExpandedComponent;
  /* A1 文件拖拽显形：OS 拖文件进入屏幕时，
     可接收文件的本类型卡片亮出投放提示。派生布尔订阅——非接收类型的卡片
     恒 false，拖拽会话的置位/复位不会让它们重渲。 */
  const fileDropTarget = useFileDragStore((s) => s.active && !!meta?.acceptsOsFiles);
  /* BentoDesk #2 合并投放目标：派生布尔订阅——非目标的卡片恒 false，
     拖拽移动中目标切换只重渲新旧两张卡。 */
  const isMergeTarget = useWidgetStore((s) => s.mergeTargetId === id);
  const expandedActive = useWidgetExpand((s) => s.expandedId === id);
  const expandedOnce = useWidgetExpand((s) => s.mountedIds.includes(id));
  const hoverHideTimer = useRef<number | null>(null);
  /* 拖拽启动阈值：位移超过该值才升级为拖拽会话（对齐 useBarDrag 3px /
     DockTiles 4px / DockPanel 6px）——此前按下即算拖，单击也经历
     dragging→false 一轮（scale(1.01) 托起有 1 帧闪现风险），手颤就触发
     跨窗同步挂起。engaged 之前不挂起同步、不挂起命中采集、不进拖拽渲染。 */
  const DRAG_THRESHOLD_PX = 3;
  const drag = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    dx: number;
    dy: number;
    engaged: boolean;
    group: { id: string; x: number; y: number }[];
  } | null>(null);
  const resize = useRef<ResizeState | null>(null);
  const raf = useRef(0);
  const safeTimeout = useSafeTimeout();

  /* 卸载时清理所有挂起的定时器，避免组件移除后仍触发 setState / 导航。 */
  useEffect(() => {
    return () => {
      if (hoverHideTimer.current) window.clearTimeout(hoverHideTimer.current);
      cancelAnimationFrame(raf.current);
    };
  }, []);

  /* pos-anim 选档配套：提交后记录位置供下次算 delta；有选档结果时 latch 声明，
     到期按序号清理（560ms 内连续两次对齐时旧定时器不得清掉新声明）。 */
  useEffect(() => {
    prevPos.current = { x, y };
  }, [x, y]);
  useEffect(() => {
    if (!posCss) return;
    const seq = ++posSeq.current;
    setPosLatched(posCss);
    safeTimeout(() => {
      if (posSeq.current === seq) setPosLatched(undefined);
    }, posDur + 60);
  }, [posCss, posDur, safeTimeout]);

  /* 进入编辑模式时收起就地配置弹层、沉浸展开态与双击置顶（编辑手势与
     三者冲突；pinned 的常显工具条会挡住编辑手柄）。 */
  useEffect(() => {
    if (!editMode) return;
    setConfigOpen(false);
    setPinned(false);
    useWidgetExpand.getState().collapseIf(id);
  }, [editMode, id]);

  /* C1 卸载清理：卡片移除/视图切换时清掉展开与挂载记录，避免 expandedId
     指向已消失的实例（互斥状态机悬死、Esc 失效）。 */
  useEffect(() => () => useWidgetExpand.getState().forget(id), [id]);
  /* 卸载时同步清掉在途的 hover 置顶 dwell 定时器（迟到的 bringToFront 不应
     打在已卸载的卡片上）。 */
  useEffect(() => () => cancelRaise(), []);

  /* ---- Hover 悬停显示快捷操作 ----
     快捷操作条画在卡片外部（右上角外伸），鼠标从卡片移到操作条的途中
     会触发 mouseleave。这里用 200ms 延迟隐藏 + 操作条 onMouseEnter 立即续上，
     保证鼠标移上操作条不会消失，真正移开后才收起。 */
  const scheduleHide = () => {
    if (hoverHideTimer.current) window.clearTimeout(hoverHideTimer.current);
    hoverHideTimer.current = window.setTimeout(() => setHovered(false), 200);
  };
  const cancelHide = () => {
    if (hoverHideTimer.current) {
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
  };
  /* F5（写放大治理）：hover 置顶走 140ms dwell。鼠标扫过 N 张部分堆叠的卡，
     逐张即时置顶 = N 次 store 写 → 整表 sync:widgets 广播 + 全表落盘（此前的
     唯一纯 hover 高频写源）；dwell 让「扫过」不写、短暂停留才抬升。双击与
     右键「置顶显示」仍即时。 */
  const raiseTimer = useRef(0);
  const cancelRaise = () => {
    if (raiseTimer.current) {
      window.clearTimeout(raiseTimer.current);
      raiseTimer.current = 0;
    }
  };

  /* ---- Keyboard nudge：方向键移动、Shift+方向键缩放、Delete 删除 ---- */
  // The global keydown listener is attached once per editMode (the primary /
  // last-selected card) instead of being torn down/re-added on every x/y change
  // during a drag (which would churn the DOM event listener).
  /* 键盘缩放：与指针缩放同约束（吸附网格、不小于 minSize），整组选中一并生效。 */
  const resizeSelectedBy = useCallback(
    (dw: number, dh: number) => {
      const st = useWidgetStore.getState();
      const sel = st.instances.filter((i) => st.selectedIds.includes(i.id));
      for (const inst of sel) {
        const m = getWidgetMeta(inst.type);
        if (!m) continue;
        update(inst.id, {
          w: Math.max(m.minSize.w, snap(inst.w + dw)),
          h: Math.max(m.minSize.h, snap(inst.h + dh))
        });
      }
    },
    [update]
  );
  useEffect(() => {
    // 见 isPrimarySelection 注释：只有主单元挂全局 keydown，多选微移不再 ×N。
    if (!editMode || !isPrimarySelection) return;
    const onKey = (e: KeyboardEvent) => {
      // Only the SELECTED widget responds. Without this, every card mounted its
      // own global keydown in edit mode and one arrow press moved every widget
      // at once (and Delete removed the focused card regardless of selection).
      if (!isSelected) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      const arrow: Record<string, [number, number] | null> = {
        ArrowUp: [0, -GRID],
        ArrowDown: [0, GRID],
        ArrowLeft: [-GRID, 0],
        ArrowRight: [GRID, 0]
      };
      const delta = arrow[e.key];
      if (delta && e.shiftKey) {
        e.preventDefault();
        resizeSelectedBy(delta[0], delta[1]);
      } else if (delta) {
        e.preventDefault();
        moveSelectedBy(delta[0], delta[1]);
      } else if (e.key === "Delete") {
        e.preventDefault();
        removeAnimated(useWidgetStore.getState().selectedIds);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, isPrimarySelection, isSelected, id, moveSelectedBy, removeAnimated, resizeSelectedBy]);

  /* #62 编辑 UI 退场：退出编辑模式后延迟 150ms 播 .is-closing 淡出再卸载。
     （必须在早期 return 之前调用，遵守 Rules of Hooks） */
  const editUiVisible = useDelayedUnmount(editMode, animDurations().fxFastMs);
  /* 穿透角标退场窗口（P2 三轮，见 JSX 处注释）。 */
  const ctBadgeVisible = useDelayedUnmount(!!clickThrough && ctBadge !== false, animDurations().fxXfastMs);
  const showEditUi = editMode || editUiVisible;
  const editUiClosing = !editMode && editUiVisible;

  /* 快捷操作条退场：hover 结束后保留 150ms 播缩放淡出（入场 qa-in 已有）。
     就地配置弹层打开期间隐藏操作条：弹层锚在卡片上方，两者会重叠，且弹层
     自身已是配置会话，操作条没有保留意义。沉浸展开期间同理（遮罩已置顶）。
     F9 补全 pinned 语义：双击置顶后操作条保持常显（pin 不随 mouseleave 清除，
     再双击才解除）——否则图钉环只是一个悬停期高亮，锁不住任何东西。 */
  const quickOpen = (hovered || pinned) && !clickThrough && !configOpen && !expandedActive;
  const quickVisible = useDelayedUnmount(quickOpen, animDurations().fxFastMs);
  const quickClosing = !quickOpen && quickVisible;

  /** Esc = 原位放回（对齐 DockTiles 拖拽语义）：清直写变量、不提交位移，
      挂起闸全部复位。capture 拦截，不让别处的 Esc 监听抢先。
      （hooks 须在下方 `!meta` 提前 return 之前调用。） */
  const cancelDrag = useCallback(() => {
    const session = drag.current;
    if (!session) return;
    drag.current = null;
    setDragging(false);
    setWidgetsSyncSuspended(false);
    resumeHitRects();
    /* 五.1 FLIP 回弹：清变量前先读当前位移，挂 transform 过渡后再归零——
       卡片从松手处弹回原位（对齐 GroupCard 吸附回弹 / DockTiles Esc 语义），
       此前是 removeProperty 瞬移。reduce-motion 或位移 <1px 直接清。 */
    const reduce = prefersReducedMotion();
    for (const g of session.group) {
      const el = document.querySelector<HTMLElement>(`[data-widget-id="${g.id}"]`);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const dx = Number.parseFloat(cs.getPropertyValue("--drag-dx")) || 0;
      const dy = Number.parseFloat(cs.getPropertyValue("--drag-dy")) || 0;
      if (reduce || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) {
        el.style.removeProperty("--drag-dx");
        el.style.removeProperty("--drag-dy");
        continue;
      }
      const { ease, durMs } = pickSpatialEase(Math.max(Math.abs(dx), Math.abs(dy)));
      el.style.transition = `transform ${durMs}ms ${ease}`;
      el.style.removeProperty("--drag-dx");
      el.style.removeProperty("--drag-dy");
      window.setTimeout(() => {
        el.style.transition = "";
      }, durMs + 60);
    }
    const st = useWidgetStore.getState();
    st.setMergeTargetId(null);
    st.setAlignGuides([], []);
    st.clearDockDrag();
  }, []);

  /* 拖拽会话期间 Esc 取消（capture）。 */
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current?.engaged) return;
      e.stopPropagation();
      e.preventDefault();
      cancelDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, cancelDrag]);

  /* ---- J-2 溢出可发现性：卡体内容高出视口时挂 has-more-below（CSS 底缘
     渐隐提示可滚动）。卡体盒子定高，RO 观察盒子 + 内容根（首个元素子节点）
     ——内容长高才是滚动高度变化的信号；Suspense 懒加载会替换内容根，用
     MutationObserver 转挂。滚动中即时同步（滚到底渐隐消失）。须在
     `if (!meta) return null` 之前：hooks 不允许条件调用。 */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const syncMoreBelow = useCallback(() => {
    const el = bodyRef.current;
    if (el) el.classList.toggle("has-more-below", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // jsdom 无 ResizeObserver：测试环境直接放弃渐隐提示（真机 Chromium 恒有）。
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncMoreBelow);
    ro.observe(el);
    let watched: Element | null = el.firstElementChild;
    if (watched) ro.observe(watched);
    const mo = new MutationObserver(() => {
      const next: Element | null = el.firstElementChild;
      if (next !== watched) {
        ro.disconnect();
        ro.observe(el);
        watched = next;
        if (watched) ro.observe(watched);
      }
      syncMoreBelow();
    });
    mo.observe(el, { childList: true });
    syncMoreBelow();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [syncMoreBelow]);

  if (!meta) return null;
  const Content = meta.component;
  const Expanded = meta.ExpandedComponent;
  /* 显示名：序号追加在翻译后的名称上（en 用户得到 Shortcuts2 而非 快捷方式2）。 */
  const displayName = instanceIndex >= 0 ? `${tr(meta.name)}${instanceIndex + 1}` : tr(meta.name);

  /* ---- C1 展开 / 收起 ----
     展开：登记 expand-store（互斥，其余自动收起）+ 置顶本卡。悬停「展开」
     按钮即预热沉浸组件与遮罩两个 chunk，消除首展骨架。 */
  const openExpanded = () => {
    if (!Expanded) return;
    setHovered(false);
    setConfigOpen(false);
    bringToFront(id);
    useWidgetExpand.getState().expand(id);
  };
  const closeExpanded = () => useWidgetExpand.getState().collapseIf(id);
  const warmExpanded = () => {
    if (!Expanded) return;
    preloadExpanded(type);
    void import("./WidgetExpandOverlay").catch(() => {});
  };

  /* ---- 拖动（编辑模式下卡片任意位置） ---- */
  const onDragStart = (e: React.PointerEvent) => {
    if (!editMode) return;
    e.stopPropagation();
    // Ctrl/Shift+点击：切换选中（多选的一部分）；否则若非已选中，单选该卡。
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    if (multi) {
      toggleSelect(id);
      if (!useWidgetStore.getState().selectedIds.includes(id)) return; // 反选取消 → 不拖拽
    } else if (!useWidgetStore.getState().selectedIds.includes(id)) {
      selectWidget(id);
    }
    bringToFront(id);
    // 快照整组原点，拖拽时整组刚性平移、保持相对位置。
    const sel = useWidgetStore.getState().selectedIds;
    const group = useWidgetStore
      .getState()
      .instances.filter((i) => sel.includes(i.id))
      .map((i) => ({ id: i.id, x: i.x, y: i.y }));
    drag.current = { startX: e.clientX, startY: e.clientY, origX: x, origY: y, dx: 0, dy: 0, engaged: false, group };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent) => {
    const session = drag.current;
    if (!session) return;
    /* 启动阈值：未过 3px 死区前不升级会话（选中已在 pointerdown 完成）。 */
    if (!session.engaged) {
      if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD_PX) return;
      session.engaged = true;
      setDragging(true);
      setWidgetsSyncSuspended(true);
      suspendHitRects();
    }
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const d = drag.current!;
      let nx = Math.max(0, snap(d.origX + (e.clientX - d.startX)));
      let ny = Math.max(0, snap(d.origY + (e.clientY - d.startY)));
      /* 智能对齐：仅以主单元与其它「非本组」组件/视口边界吸附。 */
      const guideXs: number[] = [];
      const guideYs: number[] = [];
      const others = useWidgetStore.getState().instances.filter((i) => !d.group.some((g) => g.id === i.id));
      const myXs = [nx, nx + w / 2, nx + w];
      const myYs = [ny, ny + h / 2, ny + h];
      let bestX: { delta: number; line: number } | null = null;
      let bestY: { delta: number; line: number } | null = null;
      for (const o of others) {
        for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) {
          for (const mx of myXs) {
            const diff = ox - mx;
            if (Math.abs(diff) <= ALIGN_THRESHOLD && (!bestX || Math.abs(diff) < Math.abs(bestX.delta))) {
              bestX = { delta: diff, line: ox };
            }
          }
        }
        for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) {
          for (const my of myYs) {
            const diff = oy - my;
            if (Math.abs(diff) <= ALIGN_THRESHOLD && (!bestY || Math.abs(diff) < Math.abs(bestY.delta))) {
              bestY = { delta: diff, line: oy };
            }
          }
        }
      }
      if (!bestX && nx <= ALIGN_THRESHOLD) bestX = { delta: -nx, line: 0 };
      if (!bestY && ny <= ALIGN_THRESHOLD) bestY = { delta: -ny, line: 0 };
      if (bestX) {
        nx += bestX.delta;
        guideXs.push(bestX.line);
      }
      if (bestY) {
        ny += bestY.delta;
        guideYs.push(bestY.line);
      }
      // 主单元已吸附。预览位移直写各卡 --drag-dx/--drag-dy（不写 instances、不落盘、
      // 拖拽期间不进 store）——逐帧 setDragPreview 会给组内每张卡每帧生成新
      // {dx,dy} 引用，React 逐帧 reconcile；直写 CSS 变量只碰合成器 transform
      // （.dragging 的 transform 组合 translate3d(var(--drag-dx)…) 与 scale(1.01)，
      // 变量改值不整体覆盖类 transform，托起缩放在整个拖拽期保持），pointerup
      // 时把最终位移一次性交给 commitDragMove 提交。
      const maxX = Math.max(0, window.innerWidth - 40);
      const maxY = Math.max(0, window.innerHeight - 40);
      const dx = Math.min(Math.max(0, nx), maxX) - d.origX;
      const dy = Math.min(Math.max(0, ny), maxY) - d.origY;
      d.dx = dx;
      d.dy = dy;
      for (const g of d.group) {
        const el = document.querySelector<HTMLElement>(`[data-widget-id="${g.id}"]`);
        if (el) {
          el.style.setProperty("--drag-dx", `${dx}px`);
          el.style.setProperty("--drag-dy", `${dy}px`);
        }
      }
      // 对齐参考线只在数值变化时写 store：参考线层无需逐帧 reconcile。
      const guides = useWidgetStore.getState().alignGuides;
      if (guides.xs.join() !== guideXs.join() || guides.ys.join() !== guideYs.join()) {
        useWidgetStore.getState().setAlignGuides(guideXs, guideYs);
      }
      // 合并投放目标高亮：光标下的候选卡（非本组、未编组）实时亮出提示。
      const target = mergeTargetAt(
        useWidgetStore.getState().instances,
        e.clientX,
        e.clientY,
        d.group.map((g) => g.id)
      );
      useWidgetStore.getState().setMergeTargetId(target?.id ?? null);
      /* [DROP] 岛拖入：每帧只写指针视口坐标，零几何——命中判定（岛矩形外扩 24px）
         与插入位由 DockDropZone 同步订阅计算并回写，这里原样保留上一帧的结果。 */
      const dd = useWidgetStore.getState().dockDrag;
      useWidgetStore.getState().setDockDrag({
        pointer: { x: e.clientX, y: e.clientY },
        overIsland: dd?.overIsland ?? false,
        insertIndex: dd?.insertIndex ?? 0
      });
    });
  };

  const onDragEnd = (e?: React.PointerEvent) => {
    cancelAnimationFrame(raf.current);
    const wasDragging = drag.current !== null;
    const draggedIds = wasDragging ? drag.current!.group.map((g) => g.id) : [];
    /* 未过启动阈值的按压：无拖拽语义，直接结束（不写 dragPreview、不提交、
       不触碰任何挂起闸——engage 时才挂起，这里自然无需恢复）。 */
    if (wasDragging && !drag.current!.engaged) {
      drag.current = null;
      return;
    }
    /* 拖拽期间位移直写在 --drag-dx/--drag-dy 上（见 onDragMove），松手时一次性：
       ① 把最终位移写进 dragPreview（commitDragMove 的数据源，入岛/合并分支会清掉）；
       ② 清除直写的 CSS 变量——React 对命令式样式无感知，不清会与提交后的
          left/top 双重偏移；同帧清+提交由 drag-commit 两帧过渡抑制兜住。 */
    const dragSession = drag.current;
    drag.current = null;
    setDragging(false);
    setWidgetsSyncSuspended(false);
    resumeHitRects();
    const st = useWidgetStore.getState();
    st.setMergeTargetId(null);
    if (dragSession) {
      const finalPreview: Record<string, { dx: number; dy: number }> = {};
      for (const g of dragSession.group) finalPreview[g.id] = { dx: dragSession.dx, dy: dragSession.dy };
      st.setDragPreview(finalPreview);
      for (const g of dragSession.group) {
        const el = document.querySelector<HTMLElement>(`[data-widget-id="${g.id}"]`);
        if (el) {
          el.style.removeProperty("--drag-dx");
          el.style.removeProperty("--drag-dy");
        }
      }
    }
    /* [DROP] F-2 入口 a：松手命中岛 → 本卡成为岛磁贴（D1 默认复制：磁贴绑定本实例、
       卡片留在画布回原位；Alt = 移动：实例再走既有回收站可撤销路径），不提交拖拽
       位移。pointercancel（Alt-Tab / 系统手势接管）与缩放松手不视为投放。 */
    const overIsland = wasDragging && e?.type === "pointerup" && !!st.dockDrag?.overIsland;
    /* BentoDesk 借鉴 #2：岛之外的投放若落在另一张卡上（取 z 最高的命中卡，
       与用户所见一致）→ 合并编组，同样不提交位移。 */
    let merged: { groupId: string; appendedIds: string[] } | null = null;
    if (wasDragging && e?.type === "pointerup" && !overIsland) {
      const target = mergeTargetAt(st.instances, e.clientX, e.clientY, draggedIds);
      if (target) merged = st.mergeIntoGroup(draggedIds, target.id);
      if (merged) {
        st.setDragPreview({});
        st.setAlignGuides([], []);
        const { groupId, appendedIds } = merged;
        pushAppToast(tr("已合并编组"), "", "info", {
          action: {
            label: tr("撤销"),
            run: () => {
              const s = useWidgetStore.getState();
              for (let k = appendedIds.length - 1; k >= 0; k--) s.removeGroupMember(groupId, appendedIds[k]);
            }
          }
        });
      }
    }
    if (overIsland) {
      const tile = createDockTile(type, id);
      st.addDockTile(tile, st.dockDrag!.insertIndex);
      st.setDragPreview({});
      st.setAlignGuides([], []);
      // 入岛去重（widget-store.findDockTileConflict）：本实例已绑定在岛上时 addDockTile
      // 是 no-op——不复制、不移动，回弹 + 提示，与图库入口的「已在灵动岛」同口径。
      const added = useWidgetStore.getState().dock.tiles.some((t) => t.id === tile.id);
      if (!added) {
        pushAppToast(tr("已在灵动岛"), "", "info");
        setDockSpring(true);
        safeTimeout(() => setDockSpring(false), 220);
      } else if (e!.altKey) {
        removeAnimated([id]);
        pushAppToast(tr("已移入灵动岛"), "", "info", {
          action: {
            label: tr("撤销"),
            run: () => {
              const s = useWidgetStore.getState();
              s.restoreWidget(id);
              s.removeDockTile(tile.id);
            }
          }
        });
      } else {
        setDockSpring(true);
        safeTimeout(() => setDockSpring(false), 220);
      }
    } else if (!merged) {
      st.commitDragMove();
    }
    st.clearDockDrag();
  };

  /* ---- 8 方向缩放 ---- */
  const onResizeStart = (handle: string, e: React.PointerEvent) => {
    if (!editMode) return;
    e.stopPropagation();
    selectWidget(id);
    resize.current = { handle, startX: e.clientX, startY: e.clientY, origX: x, origY: y, origW: w, origH: h };
    // PERF-1/F-2：缩放与拖拽同属「编辑会话」，期间只写瞬态 resizePreview，
    // 挂起跨窗口广播，pointerup 解除时一次性 commit + 补发最终快照。
    setWidgetsSyncSuspended(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    if (!resize.current) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const r = resize.current!;
      if (!r) return;
      const dx = e.clientX - r.startX;
      const dy = e.clientY - r.startY;
      const { handle, origX, origY, origW, origH } = r;
      const minW = meta.minSize.w;
      const minH = meta.minSize.h;

      /* 计算原始新矩形 */
      let rawLeft = origX;
      let rawTop = origY;
      let rawRight = origX + origW;
      let rawBottom = origY + origH;

      if (handle.includes("e")) rawRight = origX + origW + dx;
      if (handle.includes("w")) rawLeft = origX + dx;
      if (handle.includes("s")) rawBottom = origY + origH + dy;
      if (handle.includes("n")) rawTop = origY + dy;

      /* 对齐到网格，且不允许把窗口拖出左上边界 */
      const sLeft = Math.max(0, snap(rawLeft));
      const sRight = Math.max(snap(rawRight), sLeft);
      const sTop = Math.max(0, snap(rawTop));
      const sBottom = Math.max(snap(rawBottom), sTop);

      /* 保证最小尺寸 */
      let newX = sLeft;
      let newY = sTop;
      let newW = sRight - sLeft;
      let newH = sBottom - sTop;

      if (newW < minW) {
        if (handle.includes("w")) newX = sRight - minW;
        newW = minW;
      }
      if (newH < minH) {
        if (handle.includes("n")) newY = sBottom - minH;
        newH = minH;
      }

      // 只写瞬态 resizePreview（不写 instances、不落盘），pointerup 时一次性 commit；
      // 否则每 rAF 重建 instances 会让所有订阅它的组件逐帧重算。
      useWidgetStore.getState().setResizePreview({ id, x: newX, y: newY, w: newW, h: newH });
    });
  };

  const onResizeEnd = () => {
    cancelAnimationFrame(raf.current);
    resize.current = null;
    // 与 onResizeStart 对称：解除挂起并补发最终快照（幂等，与 onDragEnd 重复调用无害）。
    setWidgetsSyncSuspended(false);
    useWidgetStore.getState().commitResize();
  };

  /* ---- 统一 pointermove / pointerup ---- */
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) onDragMove(e);
    else if (resize.current) onResizeMove(e);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    onDragEnd(e);
    onResizeEnd();
  };

  /* G13 键盘选中：编辑模式下卡片可 Tab 聚焦（非编辑模式不进 Tab 序——卡片
     内容控件已各自可聚焦，壳层再加一站只会污染遍历顺序）。聚焦壳层即选中
     （与指针按下选中同语义），选中后方向键微移 / Shift+方向键缩放 / Delete
     删除（见上方 Keyboard nudge）随之可用；e.target 校验保证焦点来自壳层
     本身，聚焦内部控件不劫持选中。 */
  const onCardFocus = (e: React.FocusEvent) => {
    if (!editMode || e.target !== e.currentTarget) return;
    if (!useWidgetStore.getState().selectedIds.includes(id)) selectWidget(id);
    bringToFront(id);
  };

  /* ---- 右键：统一上下文菜单。编辑模式同样弹菜单而非直接删除——右键的
     心智是「操作菜单」，秒删极易误伤；菜单里的删除项自带撤销 toast。 ---- */
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // 输入框等编辑控件右键交给全局「剪切/复制/粘贴」编辑菜单。
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    bringToFront(id);
    openContextMenu(e, [
      // 编辑模式下「编辑布局」是冗余项（已经在编辑了）。
      ...(editMode ? [] : [{ label: tr("编辑布局"), icon: <Pencil size={15} />, onSelect: () => setEditMode(true) }]),
      { label: tr("配置"), icon: <Settings size={15} />, onSelect: () => setConfigOpen(true) },
      ...(hasExpanded
        ? [{ label: tr("展开沉浸视图"), icon: <Maximize2 size={15} />, onSelect: () => openExpanded() }]
        : []),
      { type: "separator" },
      {
        label: tr(clickThrough ? "鼠标穿透：开" : "鼠标穿透：关"),
        icon: <MousePointerClick size={15} />,
        onSelect: () => {
          update(id, { clickThrough: !clickThrough });
          /* #74 开启瞬间：降透明回弹确认，角标随状态淡入。 */
          if (!clickThrough) {
            setCtFlash(true);
            safeTimeout(() => setCtFlash(false), 600);
          }
        }
      },
      { type: "separator" },
      { label: tr("置顶显示"), icon: <ArrowUpToLine size={15} />, onSelect: () => bringToFront(id) },
      { label: tr("移到底层"), icon: <ArrowDownToLine size={15} />, onSelect: () => sendToBack(id) },
      { type: "separator" },
      { label: tr("复制小组件"), icon: <Copy size={15} />, onSelect: () => duplicateW(id) },
      { type: "separator" },
      { label: tr("删除"), icon: <Trash2 size={15} />, danger: true, onSelect: () => removeAnimated([id]) }
    ]);
  };

  /* ---- B1 就地配置弹层 ----
     「配置」不再跳设置窗口：悬浮工具条与右键菜单都打开锚定在卡片上方的
     WidgetConfigPopover（常用项就地改，「更多设置」再跳深度页）。open 无需
     防抖——setState 幂等，pointerdown 与 click 双触发无害。 */

  return (
    <div
      className={`widget-card${editMode ? " editing" : ""}${dragging ? " dragging" : ""}${dockSpring ? " dock-drop-back" : ""}${hovered ? " hovered" : ""}${pinned ? " pinned" : ""}${isMergeTarget ? " merge-target" : ""}${isSelected ? " selected" : ""}${exiting ? " is-exiting" : ""}${entering ? " fly-in" : ""}${pulsing ? " pulse-in" : ""}${posAnim ? " pos-anim" : ""}${ctFlash ? " ct-flash" : ""}${fileDropTarget ? " file-drop-target" : ""}`}
      data-widget-id={id}
      data-widget-type={type}
      data-click-through={clickThrough ? "true" : undefined}
      style={
        {
          left: resizeRect?.x ?? x,
          top: resizeRect?.y ?? y,
          width: resizeRect?.w ?? w,
          height: resizeRect?.h ?? h,
          // 拖拽中必须压在所有卡片之上：z 随每次置顶单调 +1、只在超过 MAX_Z 才
          // 归一，长期会话里轻易越过此前写死的 9999，拖动的卡片会钻到别的卡下面。
          zIndex: dragging ? MAX_Z + 1 : z,
          transition: posTransition,
          "--widget-bg-alpha": (globalOpacity / 100) * (previewOpacity ?? opacity ?? 1)
        } as React.CSSProperties
      }
      onPointerDown={editMode ? onDragStart : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      /* P1（审计修复）：Windows 上拖拽/缩放中 Alt-Tab 或系统手势接管会派发
         pointercancel 而非 pointerup——不处理会让 drag/resize ref 残留、
         widgetsSyncSuspended 永久为 true，此后所有布局编辑不再同步到其他窗口。
         cancel 的收尾语义与 up 完全一致（提交已预览的位移、解除挂起）。 */
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onFocus={onCardFocus}
      tabIndex={editMode ? 0 : undefined}
      role={editMode ? "group" : undefined}
      aria-label={editMode ? `${displayName}（${tr("已选中，方向键移动，Shift+方向键缩放，Delete 删除")}）` : undefined}
      onMouseEnter={() => {
        cancelHide();
        if (!editMode && !clickThrough) {
          cancelRaise();
          raiseTimer.current = window.setTimeout(() => bringToFront(id), 140);
        }
        setHovered(!clickThrough);
      }}
      onMouseLeave={() => {
        cancelRaise();
        scheduleHide();
      }}
      onDoubleClick={() => {
        bringToFront(id);
        setPinned((p) => !p);
      }}
    >
      <div className="widget-card-body" ref={bodyRef} onScroll={syncMoreBelow}>
        {/* Suspense 在 ErrorBoundary 内层：chunk 加载失败时由错误边界兜住，
            显示可重试的错误卡片而不是让整个画布白屏（P4 懒加载配套）。 */}
        <WidgetErrorBoundary instanceId={id} type={type}>
          <Suspense fallback={<div className="widget-skeleton" aria-busy="true" />}>
            <Content instanceId={id} />
          </Suspense>
        </WidgetErrorBoundary>
      </div>

      {/* #74 鼠标穿透开启时的角落角标（实例级 ctBadge=false 可关闭显示）。
          P2 三轮补退场：关闭穿透时保留一拍播淡出再卸载（与开启的 flash 补偿
          对称，此前瞬消）。 */}
      {ctBadgeVisible && (
        <span className={`widget-ct-badge${clickThrough && ctBadge !== false ? "" : " is-closing"}`}>{tr("穿透")}</span>
      )}

      {/* 编辑模式底部弹出工具栏（#62：延迟卸载补退场） */}
      {showEditUi && (
        <div
          className={`widget-editbar-bottom${editUiClosing ? " is-closing" : ""}`}
          style={{
            position: "absolute",
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            /* 高度与左下角视图切换器一致：4px padding + 28px 内容 + 1px 边框 */
            padding: "4px 8px",
            borderRadius: 14,
            background: "var(--paper-solid)",
            border: "1px solid var(--line)",
            color: "var(--muted)",
            fontSize: 12,
            fontWeight: 600,
            /* 不设阴影：每卡编辑栏浮在卡片底部，带阴影会盖到下方悬浮窗上 */
            boxShadow: "none",
            zIndex: 5,
            pointerEvents: "auto"
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span>{displayName}</span>
          <button
            className="widget-del"
            onClick={() => removeAnimated([id])}
            aria-label={tr("删除小组件")}
            data-interactive
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              border: 0,
              borderRadius: 9,
              background: "transparent",
              color: "var(--muted)",
              cursor: "pointer",
              marginLeft: 4
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* 8 个缩放手柄（编辑模式）：无文字，标签供读屏；键盘缩放走 Shift+方向键。 */}
      {editMode &&
        HANDLES.map((h) => (
          <div
            key={h.id}
            data-resize-handle={h.id}
            aria-label={tr(h.label)}
            style={{
              position: "absolute",
              cursor: h.cursor,
              zIndex: 6,
              ...h.style
            }}
            onPointerDown={(e) => onResizeStart(h.id, e)}
          />
        ))}

      {/* 非编辑模式 hover 快捷操作。
          Portal 到 body：卡片设 overflow:hidden 强制裁剪边界（防止内容阴影越界
          "黑影"盖到相邻悬浮窗），因此悬浮在卡片上边缘之外的快捷操作条必须脱离
          卡片 DOM 树，否则会被裁剪掉、设置按钮不可见。用 fixed 定位到卡片右上角。
          #62 同款延迟卸载：hover 结束后播 .is-closing 退场再卸载。 */}
      {!editMode &&
        quickVisible &&
        createPortal(
          <div
            className={`widget-quickactions${quickClosing ? " is-closing" : ""}`}
            data-interactive
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
            style={{
              position: "fixed",
              /* 卡片贴近屏幕顶部时（上方放不下），改为在卡片下方显示，
               保证设置按钮始终可达、不会悬到屏幕外点不到。 */
              top: y < 40 ? y + h + 4 : y - 32,
              right: window.innerWidth - (x + w) + 10
            }}
          >
            <span className="widget-quick-name">{displayName}</span>
            <span className="widget-quick-divider" />
            {/* C1 展开入口：仅登记了 ExpandedComponent 的类型显示（悬浮工具条第五键）。 */}
            {hasExpanded && (
              <button
                className="quick-btn"
                onPointerEnter={warmExpanded}
                onClick={(e) => {
                  e.stopPropagation();
                  openExpanded();
                }}
                title={tr("展开沉浸视图")}
                aria-label={tr("展开沉浸视图")}
                aria-haspopup="dialog"
                aria-expanded={expandedActive}
                data-interactive
              >
                <Maximize2 size={13} />
              </button>
            )}
            <button
              className="quick-btn"
              onPointerDown={(e) => {
                e.stopPropagation();
                setConfigOpen(true);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setConfigOpen(true);
              }}
              title={tr("配置此小组件")}
              aria-label={tr("配置此小组件")}
              aria-haspopup="dialog"
              aria-expanded={configOpen}
              data-interactive
            >
              <Settings size={13} />
            </button>
            <button
              className="quick-btn"
              onClick={() => bringToFront(id)}
              title={tr("置顶显示")}
              aria-label={tr("置顶显示")}
              data-interactive
            >
              <ArrowUpToLine size={13} />
            </button>
            <button
              className="quick-btn"
              onClick={() => sendToBack(id)}
              title={tr("移到底层")}
              aria-label={tr("移到底层")}
              data-interactive
            >
              <ArrowDownToLine size={13} />
            </button>
            <button
              className="quick-btn danger"
              onClick={() => removeAnimated([id])}
              title={tr("删除小组件")}
              aria-label={tr("删除小组件")}
              data-interactive
            >
              <Trash2 size={13} />
            </button>
          </div>,
          document.body
        )}

      {/* B1 就地配置弹层：非编辑模式常挂载（内部自管延迟卸载），锚定卡片矩形。
          弹层虽 Portal 到 body，React 合成事件仍沿组件树冒泡回卡片——弹层容器
          已对 pointerdown/click/contextmenu/doubleclick stopPropagation，不会
          误触发卡片的拖拽/右键/双击钉住。 */}
      {!editMode && (
        <WidgetConfigPopover
          instanceId={id}
          widgetType={type}
          anchor={{ x, y, w, h }}
          open={configOpen}
          onClose={closeConfig}
        />
      )}

      {/* C1 沉浸展开遮罩：首次展开后常驻挂载（expandedOnce），收起只切
          active（遮罩 display:none + 内容暂停），重开不重建。Portal 到 body
          脱离卡片 overflow 裁剪；外层 Suspense 兜遮罩 chunk，内层兜沉浸组件
          chunk（骨架在面板内显示），错误边界隔离沉浸组件崩溃。 */}
      {expandedOnce &&
        Expanded &&
        createPortal(
          <Suspense fallback={null}>
            {/* 遮罩外壳自身抛错也要兜住（内层边界只包沉浸组件）：崩溃即收起展开态，
              否则 expand-store 里仍是展开、Esc 由已崩溃的遮罩接管、整窗白屏。 */}
            <WidgetErrorBoundary
              instanceId={id}
              type={`${type}:expand-overlay`}
              fallback={null}
              onError={closeExpanded}
            >
              <WidgetExpandOverlay
                active={expandedActive}
                origin={{ x, y, w, h }}
                title={displayName}
                onClose={closeExpanded}
                sizeKey={`widget:${type}`}
                floating={!!meta?.expandFloating}
              >
                <WidgetErrorBoundary instanceId={id} type={type}>
                  <Suspense
                    fallback={
                      <div className="widget-skeleton" aria-busy="true" style={{ position: "absolute", inset: 16 }} />
                    }
                  >
                    <Expanded instanceId={id} active={expandedActive} />
                  </Suspense>
                </WidgetErrorBoundary>
              </WidgetExpandOverlay>
            </WidgetErrorBoundary>
          </Suspense>,
          document.body
        )}
    </div>
  );
}

/* PERF-1：卡片默认 memo——拖拽/缩放期间只有参与的卡片因 props/预览位移变化
   重渲，未参与的卡片 props 稳定（原始值）跳过渲染，避免全画布组件树逐帧重渲。 */
export const WidgetCard = memo(WidgetCardBase);
