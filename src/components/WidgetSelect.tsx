/**
 * 小组件层自绘下拉（WidgetSelect）：替换原生 <select>（系统弹窗白底、
 * 无法跟随主题）。交互范式参考 Glide Select" 的可观察行为
 * 自绘：弹出层从触发角缩放淡入（收起更快）、高亮是**一枚滑行药丸**
 * （hover/键盘移动时在行间平移，替代逐行 hover 底色）、选中行在指针
 * 离开时静息高亮、换值瞬间触发标签模糊交换、菜单空间不足自动向上
 * 翻转。键盘：↑↓/Home/End 移动（首跳瞬移）、Enter/Space 选中、Esc /
 * Tab 关闭、单字符 typeahead；焦点恒留在触发钮（aria-activedescendant）。
 *
 * 样式在 styles/widget.css 的 .wsel 区（桌面层窗口加载）；减少动态由
 * 全局兜底 + 区内 prefers-reduced-motion 回退块关停。
 *
 * 弹层此前内联渲染在 .wsel（relative）下 absolute
 * 展开——单位换算器 / 课表编辑等消费方的触发点贴卡片底缘，被
 * .widget-card-body 的 overflow:auto 裁剪掉大半（修 DatePicker 时的
 * 同型漏网）。改为 createPortal 到 document.body + fixed 定位（锚点 =
 * 触发钮 gBCR ÷ uiZoom 打开时快照；垂直复用 WidgetConfigPopover 的
 * placePopover：上方优先、放不下翻下方、视口钳制），卡片内滚动 / resize /
 * 失焦即收起；水平保持本组件边缘对齐语义（align=left 共左缘 / 缺省共右缘）
 * 并钳制视口。焦点模型（焦点恒留触发钮 + typeahead）与 phase 退场动画不变。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type AnimationEvent as ReactAnimationEvent,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { animDurations } from "../lib/durations";
import { useDismissable } from "../lib/use-dismissable";
import { uiZoom } from "../lib/ui-zoom";
import { placePopover, type PopoverAnchor } from "../widget/WidgetConfigPopover";

/** 水平钳制的视口留白（px）——与 placePopover 的 MARGIN 同值（后者未
 *  导出，本地常量保持口径一致）。 */
const WSEL_VIEW_MARGIN = 10;

/** 弹层锚点快照——.wsel 根（触发钮）的 gBCR 是视觉
 *  坐标（已含 --ui-zoom），÷ uiZoom() 归一为布局单位（fixed left/top 的
 *  量纲契约，见 lib/ui-zoom.ts；与 DatePicker 同范式）。 */
function wselAnchor(rootRef: RefObject<HTMLDivElement | null>): PopoverAnchor {
  const r = rootRef.current?.getBoundingClientRect();
  const z = uiZoom();
  return r ? { x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z } : { x: 0, y: 0, w: 0, h: 0 };
}

/** 收起时长 = 弹出（--dur-fx-fast，见 widget.css .wsel-pop）的 0.8 倍：
 *  离开比进入利落；与 CSS 的 calc(--dur-fx-fast × 0.8) 同源，随速度档缩放。 */
function closeLingerMs(): number {
  return Math.round(animDurations().fxFastMs * 0.8);
}

export function WidgetSelect({
  value,
  onChange,
  options,
  ariaLabel,
  align = "right"
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
  /** 菜单与触发钮共享哪条边（缺省右对齐，保持既有弹层方位）。 */
  align?: "left" | "right";
}) {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [active, setActive] = useState<number | null>(null);
  /* fixed 定位结果（布局单位）+ 翻侧——定位完成前为 null（弹层
     visibility:hidden 防闪现）；closing 相位沿用最后一次定位继续播退场。 */
  const [pos, setPos] = useState<{ left: number; top: number; minW: number; side: "bottom" | "top" } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  /* 弹层根 ref——portal 到 body 后不再是 rootRef 的 DOM 后代，须作为
     anchors 交给 useDismissable，弹层内的按下/点击才不算外点。 */
  const popRef = useRef<HTMLDivElement>(null);
  /** 首次定位/键盘跳格/换值后：药丸与菜单下一步位移不做过渡（瞬移）。 */
  const instantRef = useRef(false);
  const closeTimer = useRef(0);
  /** 行高 + 行距（打开时实测，兜底 29px）。 */
  const stepRef = useRef(29);
  const id = useId();
  const selected = options.findIndex((o) => o.value === value);

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = 0;
    }
  };
  useEffect(() => () => clearCloseTimer(), []);

  const open = useCallback(
    (viaKey: boolean) => {
      if (options.length === 0) return;
      clearCloseTimer();
      instantRef.current = true;
      setActive(selected >= 0 ? selected : viaKey ? 0 : null);
      setPhase("open");
    },
    [options.length, selected]
  );

  const close = useCallback((mode: "instant" | "pop") => {
    setActive(null);
    clearCloseTimer();
    if (mode === "instant") {
      setPhase("closed");
      return;
    }
    setPhase("closing");
    closeTimer.current = window.setTimeout(() => setPhase("closed"), closeLingerMs());
  }, []);

  /* 打开：锚点快照 + 实测定位 + 行步距 + 药丸就位（瞬移、隐藏）。
     垂直口径复用 placePopover（上方优先、放不下翻下方、视口钳制，
     与 DatePicker 同源——此前只对视口底缘翻侧，卡片在视口中部时永远
     向下展开，恒被卡体裁剪）；水平保持边缘对齐（align=left 共左缘 / 缺省
     共右缘）并钳制视口。fixed 的 min-width 百分比包含块是视口（原
     min-width:100% 会撑满整屏），改由 JS 按触发钮宽度内联下限。 */
  useLayoutEffect(() => {
    if (phase !== "open") return;
    const root = rootRef.current;
    const list = listRef.current;
    const pop = popRef.current;
    if (!root || !list || !pop) return;
    const anchor = wselAnchor(rootRef);
    const placed = placePopover(
      anchor,
      { w: pop.offsetWidth, h: pop.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight }
    );
    let left = align === "left" ? anchor.x : anchor.x + anchor.w - pop.offsetWidth;
    left = Math.min(
      Math.max(left, WSEL_VIEW_MARGIN),
      Math.max(WSEL_VIEW_MARGIN, window.innerWidth - pop.offsetWidth - WSEL_VIEW_MARGIN)
    );
    setPos({ left, top: placed.top, minW: anchor.w, side: placed.below ? "bottom" : "top" });
    const first = list.querySelector<HTMLElement>("[data-index]");
    stepRef.current = (first?.offsetHeight ?? 28) + 1;
    const p = pillRef.current;
    if (p) {
      p.style.transition = "none";
      p.style.opacity = "0";
      void p.offsetHeight;
      p.style.transition = "";
    }
  }, [phase, align]);

  /* fixed 弹层不随卡片滚动——卡片内滚动（capture）/ resize / 失焦即
     收起（对齐 DatePicker / ContextMenuHost 的关闭口径，否则菜单悬在原地
     与触发钮脱节）。菜单列表自身的滚动（wsel-list max-height 溢出）不是
     位移源，豁免。 */
  useEffect(() => {
    if (phase !== "open") return;
    const dismiss = () => close("pop");
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return;
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [phase, close]);

  /* 高亮移动：药丸平移（瞬移条件：刚打开 / 键盘跳格 / 首次显示）。 */
  useLayoutEffect(() => {
    const p = pillRef.current;
    if (!p || phase !== "open") return;
    if (active === null) {
      p.style.opacity = "0";
      return;
    }
    const jump = instantRef.current || p.style.opacity !== "1";
    p.style.transitionDuration = jump ? `0ms, ${Math.round(animDurations().fxFastMs)}ms` : "";
    p.style.transform = `translateY(${active * stepRef.current}px)`;
    p.style.opacity = "1";
    instantRef.current = false;
    if (typeof p.scrollIntoView !== "function") return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, phase]);

  const pick = useCallback(
    (i: number) => {
      const it = options[i];
      if (!it) {
        close("instant");
        return;
      }
      if (it.value !== value) {
        onChange(it.value);
        // 换值：触发钮标签做一次模糊交换（动画结束由 onAnimationEnd 摘标记）。
        rootRef.current?.setAttribute("data-swap", "");
      }
      close("instant");
    },
    [options, value, onChange, close]
  );

  const typeahead = (from: number, ch: string) => {
    const c = ch.toLowerCase();
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (options[i].label.toLowerCase().startsWith(c)) return i;
    }
    return from;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const n = options.length;
    if (n === 0) return;
    const cur = active ?? (selected >= 0 ? selected : 0);
    if (phase !== "open") {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        open(true);
      }
      return;
    }
    const go = (i: number) => {
      e.preventDefault();
      instantRef.current = true;
      setActive(Math.min(n - 1, Math.max(0, i)));
    };
    if (e.key === "ArrowDown") go(active === null ? cur : cur + 1);
    else if (e.key === "ArrowUp") go(active === null ? cur : cur - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(cur);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close("instant");
    } else if (e.key === "Tab") {
      close("instant");
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      go(typeahead(cur, e.key));
    }
  };

  /* 外点关闭（带收起动画）；指针悬停移动药丸。Esc 由上方键盘逻辑分步处理
     （先收列表再收药丸），故 hook 只接管外点。：弹层 portal 到 body 后
     不是 rootRef 的 DOM 后代，popRef 进 anchors 才不算外点。 */
  useDismissable(phase !== "closed", rootRef, () => close("pop"), { escape: false, anchors: [popRef] });

  const onSwapEnd = (e: ReactAnimationEvent<HTMLDivElement>) => {
    if (e.animationName === "wsel-swap") rootRef.current?.removeAttribute("data-swap");
  };

  const isOpen = phase === "open";
  /* data-align 移到弹层根（原挂在 .wsel 根上，而 CSS 选择器
     .wsel-pop[data-align] 从未命中——align="left" 实际一直无效的潜伏
     错位，随 portal 化一并修正：水平对齐由 JS 读 align 计算）。 */
  return (
    <div ref={rootRef} className="wsel" onAnimationEnd={onSwapEnd}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={`${id}-list`}
        aria-activedescendant={isOpen && active !== null ? `${id}-${active}` : undefined}
        aria-label={ariaLabel}
        className={`wsel-field${isOpen ? " is-open" : ""}`}
        data-interactive
        onClick={() => (isOpen || phase === "closing" ? close("instant") : open(false))}
        onKeyDown={onKeyDown}
      >
        <span>{selected >= 0 ? options[selected].label : ""}</span>
        <ChevronDown size={13} />
      </button>
      {phase !== "closed" &&
        /* portal 到 document.body——left/top/min-width 由 JS 内联（布局
           单位），CSS 只保留 fixed 与视觉；定位完成前 visibility:hidden。 */
        createPortal(
          <div
            ref={popRef}
            className={`wsel-pop${phase === "closing" ? " is-closing" : ""}`}
            data-align={align}
            data-side={pos?.side ?? "bottom"}
            data-state={isOpen ? "open" : "closed"}
            style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minW } : { visibility: "hidden" }}
          >
            <div
              id={`${id}-list`}
              ref={listRef}
              role="listbox"
              aria-label={ariaLabel}
              className="wsel-list"
              data-live={active !== null ? "" : undefined}
              onPointerOver={(e) => {
                const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
                if (!row) return;
                const i = Number(row.dataset.index);
                if (i !== active) setActive(i);
              }}
              onPointerLeave={() => {
                if (active !== null) setActive(null);
              }}
            >
              <span ref={pillRef} className="wsel-pill" aria-hidden="true" />
              {options.map((o, i) => (
                <div
                  key={o.value}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  data-index={i}
                  className={`wsel-opt${o.value === value ? " is-selected" : ""}`}
                  onClick={() => pick(i)}
                >
                  <span className="wsel-opt-name">{o.label}</span>
                  {o.value === value && <Check size={13} />}
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
