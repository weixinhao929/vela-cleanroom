import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { animDurations } from "./durations";
import { armPopupClickShield } from "./click-shield";
import { uiZoom } from "./ui-zoom";

/* reduce-motion 偏好此前是模块加载时的一次性快照——OS 里切换
   「减少动态」后 JS 动效（countup/粒子/高光循环）需重启应用才跟随。
   改为实时 matchMedia + change 订阅，并提供 React Hook 版本。 */
const reduceMql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/**
 * 同步读取「减少动态」偏好（实时双信号）。
 * OS `prefers-reduced-motion` + 应用内开关（`html[data-reduce-motion]`，
 * 由 settings-store applySettings 写入）任一命中即为 true。实现廉价
 * （属性读 + 缓存 MQL.matches），可在渲染/动画热路径安全调用。
 *
 * @returns true 表示应跳过 JS 动效。
 * @throws 无（非浏览器环境返回 false）。
 */
export function prefersReducedMotion(): boolean {
  const appReduced =
    typeof document !== "undefined" && document.documentElement.getAttribute("data-reduce-motion") === "1";
  return appReduced || !!reduceMql?.matches;
}

function subscribeReduce(cb: () => void): () => void {
  reduceMql?.addEventListener("change", cb);
  // 应用内「减少动态」开关由 theme-engine 写根节点属性，OS 媒体查询不感知：
  // MutationObserver 一并观察，两个信号源任一翻转都通知订阅者。
  const obs = typeof document !== "undefined" ? new MutationObserver(cb) : null;
  obs?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
  return () => {
    reduceMql?.removeEventListener("change", cb);
    obs?.disconnect();
  };
}

/**
 * React Hook：实时订阅系统「减少动态」偏好（外部存储订阅模式，
 * useSyncExternalStore 保证并发渲染下读取一致）。
 *
 * @returns true 表示 OS 已开启减少动态；偏好变化触发重渲。
 * @throws 无。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduce,
    // 双信号合成快照：OS 偏好 OR 应用内开关（与 prefersReducedMotion() 同口径）。
    () => prefersReducedMotion(),
    () => false
  );
}

/**
 * 弹层/行退场统一 hook：open 变 false 后仍渲染 duration 毫秒（组件加
 * .is-closing 类播退场动画），结束后真正卸载；重开立即恢复挂载。
 *
 * @param open - 期望的开关状态。
 * @param duration - 退场动画时长毫秒数（必传；从 animDurations().fx*Ms 取
 *        同源值，与 CSS 退场 token 同步跟随动效速度档）。
 * @returns 当前是否应保持挂载。挂起的卸载计时器在 open 翻回 true 或组件卸载时
 *          取消：退场窗口内重开、以及挂载后 duration 内首次打开，都不会被旧
 *          计时器误卸载。reduce-motion（OS 或应用内「减少动态」开关）命中时
 *          跳过等待窗口立即卸载——退场动画已被全局门控压成瞬移，若仍等满
 *          duration，元素会以不透明冻结在原地再消失（「愣住再消失」）。
 * @throws 无。
 *
 * @example
 * `tsx
 * const visible = useDelayedUnmount(menuOpen, animDurations().fxFastMs);
 * return visible ? <div className={menuOpen ? "" : "is-closing"}>…</div> : null;
 * `
 */
export function useDelayedUnmount(open: boolean, duration: number): boolean {
  const [render, setRender] = useState(open);
  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    // [CLICK-SHIELD]：退场开始的瞬间屏蔽紧邻的
    // 连点（默认关；弹窗恰好停在可点元素上方时，第二次点击不再穿透到
    // 下层）。放这里 = 全部统一退场弹窗一处覆盖。
    armPopupClickShield();
    if (prefersReducedMotion()) {
      setRender(false);
      return;
    }
    const id = window.setTimeout(() => setRender(false), duration);
    return () => window.clearTimeout(id);
  }, [open, duration]);
  return render;
}

/**
 * 数值滚动 hook（零依赖 rAF 版轻量 Count Up）。
 * reduce-motion、disabled 或值未变时直接跳变；跨 0 上下与 NaN 均安全
 * （NaN 按 0 处理）。outCubic 缓动，卸载时取消 rAF。
 *
 * @param value - 目标数值。
 * @param opts - `duration` 补间毫秒（默认 420）、`decimals` 小数位
 *               （默认 0）、`disabled` 强制直出真实值（增强档关闭时
 *               由调用方置 true）。
 * @returns 格式化后的显示字符串（toFixed(decimals)）。
 * @throws 无。
 *
 * @example
 * `tsx
 * <span>{useCountUp(cpu, { decimals: 1 })}%</span>
 * `
 */
export function useCountUp(
  value: number,
  {
    duration = 420,
    decimals = 0,
    disabled = false
  }: {
    duration?: number;
    decimals?: number;
    /** 调用方（FxCount）在增强档关闭时置 true，直接跳变显示真实值。 */ disabled?: boolean;
  } = {}
): string {
  const safe = Number.isFinite(value) ? value : 0;
  const [display, setDisplay] = useState(safe);
  const prev = useRef(safe);

  useEffect(() => {
    const from = prev.current;
    prev.current = safe;
    if (prefersReducedMotion() || disabled || from === safe) {
      setDisplay(safe);
      return;
    }
    let raf = 0;
    const start = performance.now();
    /* raf: ok 一次性短补间，调度前已检 reduce-motion（effect 内早退） */
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (safe - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [safe, duration, disabled]);

  return display.toFixed(decimals);
}

/* ══ 小增量降档（Keystone 规则的 JS 判定）══
   几何变化 ≤ SMALL_INCREMENT_PX 的位移/缩放取 elementMove 快档，更大的位移
   或整体重排取 cardReflow 默认档。曲线本体只定义在 feature-animations.css
   :root（check-transitions ease-contract 守卫），JS 只返回别名，不复制值。 */

/** 小增量阈值（px，含等号）：|delta| ≤ 20 视为小位移，走快档。 */
export const SMALL_INCREMENT_PX = 20;
/** elementMove 档：小位移曲线别名 + 时长（= --ease-spatial-fast / --dur-spatial-fast）。
 *  常量是 100% 标准档的参考值（动效契约与测试基线）；运行时实际时长由
 *  pickSpatialEase 经 animDurations() 按速度档实时派生，两者在标准档下相等。 */
export const EASE_ELEMENT_MOVE = "var(--ease-element-move)";
export const DUR_ELEMENT_MOVE_MS = 350;
/** cardReflow 档：大位移/重排曲线别名 + 时长（= --ease-spatial / --dur-spatial）。 */
export const EASE_CARD_REFLOW = "var(--ease-card-reflow)";
export const DUR_CARD_REFLOW_MS = 500;

export type SpatialEase = { ease: string; durMs: number };

/**
 * 按几何变化量选空间动效档位（小增量降档）。
 *
 * @param deltaPx - 位移或尺寸变化量（px），正负皆可，按绝对值比较。
 * @returns `{ ease, durMs }`：|delta| ≤ SMALL_INCREMENT_PX → elementMove
 *          （`var(--ease-element-move)` / --dur-spatial-fast，100% 档 350ms）；
 *          否则 cardReflow（`var(--ease-card-reflow)` / --dur-spatial，500ms）。
 *          时长经 animDurations() 实时跟随 设置→动效 速度档；NaN / ±Infinity
 *          等非有限值回默认档 cardReflow——测量失败不能误入快档。
 * @throws 无。
 *
 * @example
 * `ts
 * const { ease, durMs } = pickSpatialEase(target.left - current.left);
 * el.style.transition = `left ${durMs}ms ${ease}`;
 * `
 */
export function pickSpatialEase(deltaPx: number): SpatialEase {
  const d = Math.abs(deltaPx);
  const dur = animDurations();
  if (Number.isFinite(d) && d <= SMALL_INCREMENT_PX) {
    return { ease: EASE_ELEMENT_MOVE, durMs: dur.spatialFastMs };
  }
  return { ease: EASE_CARD_REFLOW, durMs: dur.spatialMs };
}

/**
 * 零依赖 FLIP 重排过渡（First-Last-Invert-Play 模式）。
 * First：记录 mutate 前各元素位置 → 执行 mutate（触发 React 重排）→
 * Last：双 rAF 等提交后读取新位置，把差值写为起始 transform → 过渡回 0。
 * 用于列表拖拽/键盘排序的「落位回弹」。reduce-motion 直接执行 mutate。
 * Play 阶段逐元素按实际位移量走 小增量降档（pickSpatialEase）：
 * 相邻行互换等 ≤20px 的小步进用 elementMove 快档，跨多行的大位移用
 * cardReflow 默认档，同一次重排里两档可并存。
 *
 * @param container - 列表容器元素。
 * @param itemSelector - 行元素选择器（相对 container 查询）。
 * @param mutate - 改变 DOM 顺序的同步回调（如 setState 触发重排）。
 * @param opts - `duration` 显式覆盖过渡毫秒数（只覆盖时长，曲线仍按位移量选档）；
 *               缺省由 pickSpatialEase 决定（350 / 500ms）。
 * @returns 无。位移 <1px 的元素跳过动画；清理定时器独立于组件生命周期。
 * @throws 无（querySelectorAll 为空时安全 no-op）。
 *
 * @example
 * `ts
 * flipReorder(listEl, ".bookmark-row", () => reorder(ids));
 * `
 */
export function flipReorder(
  container: HTMLElement,
  itemSelector: string,
  mutate: () => void,
  opts?: { duration?: number }
): void {
  if (prefersReducedMotion()) {
    mutate();
    return;
  }
  const first = new Map<HTMLElement, DOMRect>();
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(itemSelector))) {
    first.set(el, el.getBoundingClientRect());
  }
  mutate();
  // 双 rAF：确保 React 已提交新的 DOM 顺序后再测量 Last。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      /* gBCR 是视觉坐标、transform 是布局单位（html zoom 下渲染 ×zoom，
         ui-zoom 坐标模型）——差值 ÷zoom 后写入，缩放 ≠100% 时 FLIP 起始
         补偿不再按 z 倍过冲。 */
      const z = uiZoom();
      for (const el of Array.from(container.querySelectorAll<HTMLElement>(itemSelector))) {
        const f = first.get(el);
        if (!f) continue;
        const l = el.getBoundingClientRect();
        const dx = (f.left - l.left) / z;
        const dy = (f.top - l.top) / z;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        const { ease, durMs } = pickSpatialEase(Math.max(Math.abs(dx), Math.abs(dy)));
        const duration = opts?.duration ?? durMs;
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.getBoundingClientRect();
        el.style.transition = `transform ${duration}ms ${ease}`;
        el.style.transform = "";
        window.setTimeout(() => {
          // 拖拽排序进行中（容器挂 is-sorting）不让位内联被兜底清理抹掉——
          // 会话结束时统一 clearInline；此时清掉会被下一帧让位重写前的空窗闪回。
          if (el.closest(".is-sorting")) return;
          el.style.transition = "";
          el.style.transform = "";
        }, duration + 60);
      }
    });
  });
}

/* ══ 窗口隐藏挂起（app-hidden 循环暂停基建）══
   遮挡/最小化期间给根节点写 data-app-hidden，配合 global.css 把全部动画
   play-state 置 paused：WebView 的合成器节流跨平台不一致，显式暂停兜底，
   常驻装饰循环（光晕/跑马/呼吸）隐藏期间不再空转。 */
let appVisInstalled = false;

/**
 * 安装窗口可见性 → 根节点 data-app-hidden 的同步门（每文档一次）。
 * 各窗口入口（main / taskbar-net）启动时调用；幂等，重复调用为 no-op。
 *
 * @returns 无。
 * @throws 无（非浏览器环境 no-op）。
 */
export function installAppVisibilityGate(): void {
  if (appVisInstalled || typeof document === "undefined") return;
  appVisInstalled = true;
  const apply = () => {
    document.documentElement.toggleAttribute("data-app-hidden", document.hidden);
  };
  document.addEventListener("visibilitychange", apply, { passive: true });
  apply();
}
