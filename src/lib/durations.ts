/**
 * JS 侧动效时长单一真源（时长双轨制收口）。
 *
 * 此前 CSS 静态令牌（--dur-fx / --dur-spatial / --dur-dock-spring）与 JS 常量
 * （toast 210ms、ctx 120ms、palette 130ms、dock tuck 450ms、flipReorder
 * 350/500ms）各写各的，都不跟随 设置→动效 的速度三档；只有 --anim-dur 族
 * 被 theme-engine 缩放。现在两侧同用一套派生规则：
 *
 *   CSS（feature-animations.css :root，消费方 var(--dur-*) 自动缩放）：
 *     --dur-fx-xfast   = --anim-dur      × 0.48
 *     --dur-fx         = --anim-dur      × 0.8
 *     --dur-fx-fast    = --anim-dur-fast × 1.2
 *     --dur-fx-slow    = --anim-dur-slow × 0.6
 *     --dur-spatial-fast = --anim-dur      × 1.4
 *     --dur-spatial      = --anim-dur-slow
 *     --dur-spatial-slow = --anim-dur-slow × 1.3
 *     --dur-dock-spring  = --anim-dur      × 1.8
 *     --dur-clock-hand   = --anim-dur      × 1.6
 *
 *   JS（本文件）：读取 theme-engine 写在 :root 内联的 --anim-dur[-fast|-slow]
 *   （它们永远是 theme-engine 直接 setProperty 的纯 "Ns" 字符串，不含 calc，
 *   解析稳健），按同一组乘数派生。默认值对应 100% 标准档（250/125/500ms），
 *   与 theme-engine 的标准档完全一致；theme-engine 未运行（测试/首帧）时兜底。
 *
 * 修改乘数时必须同步 feature-animations.css 的 token 定义，两侧以
 * `npm run lint:anim` 之外的 review 为准（乘数是动效契约的一部分）。
 */

export type AnimDurations = {
  /** 标准档（= --anim-dur），toast 入场等。 */
  animMs: number;
  /** 快档（= --anim-dur-fast）。 */
  fastMs: number;
  /** 慢档（= --anim-dur-slow）。 */
  slowMs: number;
  /** fx 近对称族：状态/颜色过渡（默认 120 / 150 / 200 / 300ms）。 */
  fxXfastMs: number;
  fxFastMs: number;
  fxMs: number;
  fxSlowMs: number;
  /** spatial 族：位移/几何（默认 350 / 500 / 650ms）。 */
  spatialFastMs: number;
  spatialMs: number;
  spatialSlowMs: number;
  /** dockQ 弹簧时长（默认 450ms），灵动岛收合/吸附/接管宽度。 */
  dockSpringMs: number;
};

/** 标准档兜底（ms）：theme-engine 100% + 标准速度档的产出。 */
const FALLBACK = { anim: 250, fast: 125, slow: 500 } as const;

function rootDurMs(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = document.documentElement.style.getPropertyValue(name).trim();
  const m = raw.match(/^([\d.]+)(m?s)$/);
  if (!m) return fallback;
  const n = Number.parseFloat(m[1]);
  return m[2] === "s" ? n * 1000 : n;
}

/**
 * 读取当前生效的动效时长（ms）。每次调用实时读根节点内联变量——
 * theme-engine 每次设置变更都会重写它们，无需订阅即可拿到最新档位；
 * 「禁用动画」时 --anim-dur 为 0s，各派生值同为 0。
 * 渲染热路径外的计时器/过渡字符串拼接均可安全调用。
 */
export function animDurations(): AnimDurations {
  const anim = rootDurMs("--anim-dur", FALLBACK.anim);
  const fast = rootDurMs("--anim-dur-fast", FALLBACK.fast);
  const slow = rootDurMs("--anim-dur-slow", FALLBACK.slow);
  return {
    animMs: anim,
    fastMs: fast,
    slowMs: slow,
    fxXfastMs: anim * 0.48,
    fxFastMs: fast * 1.2,
    fxMs: anim * 0.8,
    fxSlowMs: slow * 0.6,
    spatialFastMs: anim * 1.4,
    spatialMs: slow,
    spatialSlowMs: slow * 1.3,
    dockSpringMs: anim * 1.8
  };
}
