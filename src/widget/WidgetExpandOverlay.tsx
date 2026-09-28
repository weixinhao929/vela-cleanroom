/**
 * 小组件沉浸展开遮罩层（C1）。
 *
 * 动画配方（沉浸展开基准参数的 DOM 适配）：
 *  - 展开：从卡片原矩形生长到沉浸矩形（默认 min(720px, 90vw) × min(600px, 86vh)，
 *    用户拖过边角后按 expand-size 记住的尺寸），曲线/时长按 A3 小增量降档由
 *    pickSpatialEase 依生长量选档——常规卡片生长数百 px 走 cardReflow 默认档
 *    （--ease-card-reflow / 500ms Spatial 过冲族），已接近沉浸尺寸的卡片（四边
 *    变化 ≤20px）走 elementMove 快档（350ms）；
 *  - 收回 --dur-spatial-fast（350ms 档）减速曲线（--ease-in，退场加速消失，
 *    CSS .is-closing 配方）；
 *  - 内容 200ms 交叉淡化 + 120ms 延迟（表面先动、内容后现）；
 *  - 常驻叠放不重建：收起后保留挂载（.is-idle 置 display:none——既不
 *    参与绘制也不进点击穿透区域上报），重开从原矩形瞬时复位再展开。
 *
 * 调整大小：面板四边四角各一枚拖动柄（.wexp-grip），拖动期内联 transition:none
 * 直写矩形（不再是固定尺寸），松手把 {w,h} 按 sizeKey 存进 expand-size（按屏分区）；
 * 双击任一柄恢复默认尺寸。尺寸下限 320×240，四边钳在视口安全边内。
 *
 * 点击穿透协作：模态模式根节点带 data-interactive，展开期间整个视口作为
 * 一块交互矩形上报（同 useClickThrough 的 OVERLAY_SELECTOR 语义），空白处
 * 点击落到本层（关闭）而不是穿透到桌面；浮动模式（floating）相反——根
 * 节点不占命中，仅面板矩形（.wexp-panel data-interactive）上报，面板外
 * 点击穿透到桌面，普通窗口语义；display:none 时矩形为 0×0，采集器自动
 * 跳过。
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { X } from "lucide-react";
import { useT } from "../i18n-lite";
import { pickSpatialEase, prefersReducedMotion, type SpatialEase } from "../lib/anim";
import { animDurations } from "../lib/durations";
import {
  EXPAND_MIN_H,
  EXPAND_MIN_W,
  EXPAND_VIEWPORT_MARGIN,
  clampExpandSize,
  loadExpandSize,
  saveExpandSize,
  type ExpandSize
} from "./expand-size";
import "../styles/feature-immersive.css";

/** 视口坐标系矩形（与卡片布局同源：桌面层窗口 1:1 映射屏幕）。 */
export type ExpandRect = { x: number; y: number; w: number; h: number };

/** 沉浸面板默认尺寸：宽 min(720px, 90vw)，高 min(600px, 86vh)。 */
function defaultExpandSize(vw: number, vh: number): ExpandSize {
  return { w: Math.min(720, Math.round(vw * 0.9)), h: Math.min(600, Math.round(vh * 0.86)) };
}

/** 沉浸矩形：尺寸取记住的（钳进视口）或默认；以卡片中心为意向中心，clamp 进视口（留 12px 安全边）。 */
function immersiveRect(origin: ExpandRect, remembered: ExpandSize | null): ExpandRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = remembered ? clampExpandSize(remembered, vw, vh) : defaultExpandSize(vw, vh);
  const m = EXPAND_VIEWPORT_MARGIN;
  const x = Math.max(m, Math.min(Math.round(origin.x + origin.w / 2 - w / 2), vw - w - m));
  const y = Math.max(m, Math.min(Math.round(origin.y + origin.h / 2 - h / 2), vh - h - m));
  return { x, y, w, h };
}

/** 两矩形四边（位置 + 尺寸）变化量的最大值，作为选档依据。 */
function rectDelta(a: ExpandRect, b: ExpandRect): number {
  return Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.w - a.w), Math.abs(b.h - a.h));
}

type Phase = "enter" | "open" | "closing" | "idle";

/** 拖动柄：四角 16×16 可同时改两向（面板 20px 圆角会裁掉最外侧一角，留得大些好命中），
 *  四边 8px 细条只改一向。 */
const GRIP_CORNER = 16;
const GRIP_EDGE = 8;
type GripId = "nw" | "ne" | "se" | "sw" | "n" | "s" | "w" | "e";
/* F3：柄是纯指针控件（div 不可聚焦），对 AT 隐藏——键盘缩放由卡片选中后的
   Shift+方向键承担（WidgetCard keyboard nudge 同一约定），不再给读屏用户
   一个「读得到却进不去」的假入口。 */
const GRIPS: { id: GripId; cursor: string; style: CSSProperties }[] = [
  { id: "nw", cursor: "nw-resize", style: { top: 0, left: 0, width: GRIP_CORNER, height: GRIP_CORNER } },
  { id: "ne", cursor: "ne-resize", style: { top: 0, right: 0, width: GRIP_CORNER, height: GRIP_CORNER } },
  { id: "se", cursor: "se-resize", style: { bottom: 0, right: 0, width: GRIP_CORNER, height: GRIP_CORNER } },
  { id: "sw", cursor: "sw-resize", style: { bottom: 0, left: 0, width: GRIP_CORNER, height: GRIP_CORNER } },
  { id: "n", cursor: "n-resize", style: { top: 0, left: GRIP_CORNER, right: GRIP_CORNER, height: GRIP_EDGE } },
  { id: "s", cursor: "s-resize", style: { bottom: 0, left: GRIP_CORNER, right: GRIP_CORNER, height: GRIP_EDGE } },
  { id: "w", cursor: "w-resize", style: { left: 0, top: GRIP_CORNER, bottom: GRIP_CORNER, width: GRIP_EDGE } },
  { id: "e", cursor: "e-resize", style: { right: 0, top: GRIP_CORNER, bottom: GRIP_CORNER, width: GRIP_EDGE } }
];

type ResizeState = { grip: GripId; pointerId: number; startX: number; startY: number; orig: ExpandRect };

/**
 * 按拖动柄与指针位移算新矩形：拖的那一边跟手，对边不动；尺寸不小于下限
 * （缩到下限后对边开始跟着走，避免翻转）；四边钳在视口安全边内。
 */
function resizeRect(orig: ExpandRect, grip: GripId, dx: number, dy: number, vw: number, vh: number): ExpandRect {
  const m = EXPAND_VIEWPORT_MARGIN;
  let left = orig.x;
  let right = orig.x + orig.w;
  let top = orig.y;
  let bottom = orig.y + orig.h;
  if (grip.includes("e")) right = Math.min(vw - m, Math.max(left + EXPAND_MIN_W, right + dx));
  if (grip.includes("w")) left = Math.max(m, Math.min(right - EXPAND_MIN_W, left + dx));
  if (grip.includes("s")) bottom = Math.min(vh - m, Math.max(top + EXPAND_MIN_H, bottom + dy));
  if (grip.includes("n")) top = Math.max(m, Math.min(bottom - EXPAND_MIN_H, top + dy));
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

type Props = {
  /** 是否处于展开态（expand-store 的 expandedId === 本卡 id）。 */
  active: boolean;
  /** 卡片原矩形（收回动画的目标，也是展开动画的起点）。 */
  origin: ExpandRect;
  /** 面板标题（读屏）。 */
  title: string;
  /** 请求收起（Esc / 关闭按钮；模态模式另有遮罩点击）。 */
  onClose: () => void;
  /** 记住尺寸用的键（如 `dock:weather` / `widget:music` / `dock:panel`）；不给则每次用默认尺寸、拖过也不记。 */
  sizeKey?: string;
  /** 背景压暗 + 毛玻璃遮罩（默认开）。灵动岛的面板传 false：桌面层本来就是透明的，
      盖一层灰膜反而「灰蒙蒙一片」——只保留透明命中层（点击空白收回）。 */
  scrim?: boolean;
  /** 浮动窗口模式（普通窗口语义；音频沉浸面板用）：不渲染全屏玻璃遮罩，
      点击面板外不收回且穿透到桌面（面板矩形经 data-interactive 单独上报
      命中，其余区域直达桌面），仅关闭按钮 / Esc 收回。默认 false = 既有
      模态语义（全屏遮罩 + 点击空白收回）。 */
  floating?: boolean;
  children: ReactNode;
};

export function WidgetExpandOverlay({
  active,
  origin,
  title,
  onClose,
  sizeKey,
  scrim = true,
  floating = false,
  children
}: Props) {
  const tr = useT();
  const [phase, setPhase] = useState<Phase>(active ? "enter" : "idle");
  const [rect, setRect] = useState<ExpandRect>(origin);
  /* A3 小增量降档：展开生长的曲线/时长，按原矩形 → 沉浸矩形的四边最大变化量
     在切目标矩形的同一帧选定；只在 open 相位内联（enter 需 transition:none
     复位、closing 走 CSS --dur-spatial-fast --ease-in 退场配方，两者都不能被
     内联覆盖）。 */
  const [growEase, setGrowEase] = useState<SpatialEase>(() => pickSpatialEase(Number.POSITIVE_INFINITY));
  /* BentoDesk 借鉴 #7：closing 中途重开的续播时长（null = 走 growEase 默认档）。 */
  const [retargetDur, setRetargetDur] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const resizeRaf = useRef(0);
  /* enter→open 的双 rAF 与 closing→idle 的延迟都需可清理（active 快速翻转时）。 */
  const rafRef = useRef(0);
  const idleTimer = useRef(0);

  const targetRect = () => immersiveRect(origin, sizeKey ? loadExpandSize(sizeKey) : null);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(resizeRaf.current);
      window.clearTimeout(idleTimer.current);
    },
    []
  );

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    window.clearTimeout(idleTimer.current);
    if (active) {
      setRetargetDur(null);
      /* BentoDesk 借鉴 #7：closing 中途重开不复位回原矩形——采样面板当前
         视觉矩形钉住（enter 无过渡），再从那里续播展开；时长按剩余视觉
         距离相对全程的比例线性缩短（60ms 下限，反向反转更快）。 */
      if (phase === "closing" && !prefersReducedMotion() && panelRef.current) {
        const cur = panelRef.current.getBoundingClientRect();
        const sampled: ExpandRect = {
          x: Math.round(cur.left),
          y: Math.round(cur.top),
          w: Math.round(cur.width),
          h: Math.round(cur.height)
        };
        setRect(sampled);
        setPhase("enter");
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = requestAnimationFrame(() => {
            const target = targetRect();
            const full = rectDelta(origin, target);
            const remain = rectDelta(sampled, target);
            const ratio = full > 0 ? Math.min(1, Math.max(0, remain / full)) : 1;
            setRetargetDur(Math.max(60, Math.round(pickSpatialEase(full).durMs * ratio)));
            setGrowEase(pickSpatialEase(remain));
            setRect(target);
            setPhase("open");
          });
        });
        return;
      }
      /* 复位到原矩形且无过渡（idle 重开）。 */
      setRect(origin);
      setPhase("enter");
      if (prefersReducedMotion()) {
        setRect(targetRect());
        setPhase("open");
        return;
      }
      /* 双 rAF：确保浏览器已按原矩形提交一帧，再切目标矩形触发过渡。 */
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => {
          const target = targetRect();
          setGrowEase(pickSpatialEase(rectDelta(origin, target)));
          setRect(target);
          setPhase("open");
        });
      });
      return;
    }
    if (phase === "idle") return;
    /* 收回：回到卡片原矩形播 --dur-spatial-fast 收缩；结束后置 idle
       （display:none）。兜底定时器与 CSS 收回配方同源（spatialFast + 50ms 余量，
       一起跟随动效速度档）；reduce-motion 时 CSS 时长已被压到 0.001s，直接进 idle。 */
    resizeRef.current = null;
    setResizing(false);
    setRetargetDur(null);
    setRect(origin);
    setPhase("closing");
    idleTimer.current = window.setTimeout(
      () => setPhase("idle"),
      prefersReducedMotion() ? 30 : animDurations().spatialFastMs + 50
    );
    // origin 每帧变化（拖拽中）不应重启相位机；仅在 active 翻转时迁移。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* Esc 收回 + Tab 焦点圈（F3）：仅展开态监听（同一时刻至多一个监听者）。
     aria-modal 已向读屏隐藏背景，Tab 圈补上视觉键盘用户的一致语义——焦点
     不再从面板走出到背景画布上「不存在」的元素。 */
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const panel = panelRef.current;
        const focusables = [
          ...panel.querySelectorAll<HTMLElement>(
            "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
          )
        ].filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
        if (focusables.length === 0) {
          e.preventDefault();
          panel.focus({ preventScroll: true });
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const cur = document.activeElement;
        const inside = cur instanceof HTMLElement && panel.contains(cur);
        if (!inside) {
          /* 焦点漂在面板外（如点过遮罩）：拉回圈里。 */
          e.preventDefault();
          (e.shiftKey ? last : first).focus({ preventScroll: true });
        } else if (e.shiftKey && cur === first) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!e.shiftKey && cur === last) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onClose]);

  /* F3（焦点归还）：展开时记录触发元素，收起时归还。触发按钮常是 hover 才
     出现的 portal 快捷条，收起时多半已卸载——isConnected 守卫下退化为不动
     （焦点落 body），尽力而为不抛错。 */
  const lastFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (active) {
      lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else {
      const el = lastFocusRef.current;
      lastFocusRef.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    }
  }, [active]);

  /* 展开后把焦点移进面板（键盘可用性）；关闭按钮是首个可聚焦元素。 */
  useEffect(() => {
    if (phase === "open") panelRef.current?.focus({ preventScroll: true });
  }, [phase]);

  /* ---- 调整大小：柄上 pointerdown 起拖（捕获指针），rAF 逐帧直写矩形，松手落盘 ---- */
  const onGripDown = (grip: GripId, e: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== "open" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { grip, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, orig: rect };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || e.pointerId !== r.pointerId) return;
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    cancelAnimationFrame(resizeRaf.current);
    resizeRaf.current = requestAnimationFrame(() => {
      setRect(resizeRect(r.orig, r.grip, dx, dy, window.innerWidth, window.innerHeight));
    });
  };
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || e.pointerId !== r.pointerId) return;
    cancelAnimationFrame(resizeRaf.current);
    resizeRef.current = null;
    // 松手那一帧的位移直接算终态，不等 rAF（避免最后 16ms 的位移丢掉）。
    const next = resizeRect(
      r.orig,
      r.grip,
      e.clientX - r.startX,
      e.clientY - r.startY,
      window.innerWidth,
      window.innerHeight
    );
    setRect(next);
    setResizing(false);
    if (sizeKey && (next.w !== r.orig.w || next.h !== r.orig.h)) saveExpandSize(sizeKey, { w: next.w, h: next.h });
  };
  /** 双击任一柄：忘掉记住的尺寸，回到默认尺寸（以当前中心为意向中心）。 */
  const onGripReset = () => {
    if (phase !== "open") return;
    if (sizeKey) saveExpandSize(sizeKey, null);
    const center: ExpandRect = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: 0, h: 0 };
    setRect(immersiveRect(center, null));
  };

  const rectStyle: CSSProperties = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  if (phase === "open") {
    /* 内联优先于 .wexp.is-open 的 CSS 过渡；reduce-motion 的 !important 0.001s
       压制在层叠上仍高于内联，双信号门禁不受影响。拖动调整大小期间关掉过渡，
       矩形逐帧跟手；松手（含双击复位）恢复过渡。retargetDur 覆盖时长（BentoDesk
       借鉴 #7：中途重开按剩余距离缩短），曲线仍按位移量选档。 */
    const dur = retargetDur ?? growEase.durMs;
    const t = `${dur}ms ${growEase.ease}`;
    rectStyle.transition = resizing ? "none" : `left ${t}, top ${t}, width ${t}, height ${t}`;
  }
  /* 相位名即 CSS 状态类（is-enter / is-open / is-closing / is-idle），
     feature-immersive.css 的收回配方与 pointer-events 均挂在 .is-closing 上。 */
  const cls = `wexp is-${phase}${resizing ? " is-resizing" : ""}${scrim ? "" : " is-noscrim"}${floating ? " is-floating" : ""}`;

  return (
    <div
      className={cls}
      /* 浮动模式：根节点不占命中（穿透上报靠面板自身的 data-interactive），
         外点直达桌面；模态模式保持全视口可交互（点击空白收回的语义）。 */
      data-interactive={floating ? undefined : true}
      role="presentation"
      onClick={
        floating
          ? undefined
          : (e) => {
              /* 点击遮罩空白处收回；面板内部点击不冒泡到遮罩。 */
              if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("wexp-backdrop"))
                onClose();
            }
      }
    >
      {!floating && <div className="wexp-backdrop" aria-hidden="true" />}
      <div
        ref={panelRef}
        className="wexp-panel"
        style={rectStyle}
        role="dialog"
        aria-modal={floating ? undefined : true}
        aria-label={title}
        tabIndex={-1}
        data-interactive
        onClick={(e) => e.stopPropagation()}
      >
        <button className="wexp-close" onClick={onClose} aria-label={tr("收起")} title={tr("收起")} data-interactive>
          <X size={15} />
        </button>
        {/* 内容层常驻（含 idle）——切换的只是透明度，React 树不重建。 */}
        <div className="wexp-content">{children}</div>
        {GRIPS.map((g) => (
          <div
            key={g.id}
            className="wexp-grip"
            data-grip={g.id}
            aria-hidden="true"
            title={tr("拖动调整大小，双击恢复默认")}
            style={{ cursor: g.cursor, ...g.style }}
            data-interactive
            onPointerDown={(e) => onGripDown(g.id, e)}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onDoubleClick={onGripReset}
          />
        ))}
      </div>
    </div>
  );
}

export default WidgetExpandOverlay;
