/**
 * 三次贝塞尔缓动曲线的纯数学（B3 曲线编辑器的合法性判定与求值）。
 *
 * 曲线固定端点 P0=(0,0)、P3=(1,1)，用户只操控 P1=(x1,y1)、P2=(x2,y2)。
 * 一条能当 CSS `cubic-bezier()` 用的曲线必须满足两条（CSS 规范判定）：
 *   1. 控制点 X 落在 [0,1]（CSS 规范硬性要求；Y 可越界表达过冲）；
 *   2. x(t) 在 [0,1] 上单调不减——否则同一时间点对应多个进度值，
 *      浏览器会直接拒绝该 timing-function。
 * 本模块不依赖 DOM，可被 store 的 sanitize 与 UI 共同复用。
 */

/** 控制点四元组 [x1, y1, x2, y2]。 */
export type BezierPoints = readonly [number, number, number, number];

export type BezierInvalidReason = "not-finite" | "x-out-of-range" | "non-monotonic";

/** 允许的浮点误差（导数极小值判定）。 */
const EPS = 1e-9;

/**
 * x(t) 在 [0,1] 上是否单调不减（允许驻点，如 cubic-bezier(1,0,0,1) 的中点）。
 *
 * x'(t) = 3[(1-t)²x1 + 2t(1-t)(x2-x1) + t²(1-x2)] 展开为二次式
 * a·t² + b·t + c，其中 a = 3x1 − 3x2 + 1、b = 2x2 − 4x1、c = x1；
 * 在 [0,1] 上取最小值（两端点 + 落在区间内的抛物线顶点）≥ 0 即单调。
 * 解析判定无采样漏判；注意 x1 > x2 并不必然非单调（.6/.4 仍合法），
 * 不能用「x1 ≤ x2」这类充分条件替代。
 */
export function isMonotonicX(p: BezierPoints): boolean {
  const [x1, , x2] = p;
  const a = 3 * x1 - 3 * x2 + 1;
  const b = 2 * x2 - 4 * x1;
  const c = x1;
  let min = Math.min(c, a + b + c);
  if (a > EPS) {
    const tv = -b / (2 * a);
    if (tv > 0 && tv < 1) min = Math.min(min, a * tv * tv + b * tv + c);
  }
  return min >= -EPS;
}

/**
 * 判定控制点能否构成合法缓动曲线（编辑器提交闸门）。
 *
 * 顺序：有限数 → X ∈ [0,1] → 单调。数学上「X ∈ [0,1]」已蕴含单调
 * （x2 < x1 时 (x1−x2)² ≤ x1(1−x2) 恒成立，x'(t) 是非负二次型），
 * 所以第三步是纵深防御而非独立条件；反过来 X 越界必导致 x(t) 回头
 * （x1<0 ⇒ x'(0)<0，x2>1 ⇒ x'(1)<0），两条判据等价。分开报告是为了
 * 给用户可操作的提示：越界直说「X 需在 0~1」。
 *
 * @returns `{ ok: true }` 或带原因的 `{ ok: false, reason }`。
 */
export function bezierValidity(p: BezierPoints): { ok: true } | { ok: false; reason: BezierInvalidReason } {
  const [x1, , x2] = p;
  if (!p.every((v) => Number.isFinite(v))) return { ok: false, reason: "not-finite" };
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return { ok: false, reason: "x-out-of-range" };
  if (!isMonotonicX(p)) return { ok: false, reason: "non-monotonic" };
  return { ok: true };
}

/** {@link bezierValidity} 的布尔简写。 */
export function isBezierValid(p: BezierPoints): boolean {
  return bezierValidity(p).ok;
}

/** 曲线上参数 t 处的坐标（t ∈ [0,1]）。 */
export function bezierPointAt(p: BezierPoints, t: number): { x: number; y: number } {
  const [x1, y1, x2, y2] = p;
  const mt = 1 - t;
  const a = 3 * mt * mt * t;
  const b = 3 * mt * t * t;
  const c = t * t * t;
  return { x: a * x1 + b * x2 + c, y: a * y1 + b * y2 + c };
}

/**
 * 给定时间进度 x（0~1），解出对应的输出进度 y——即浏览器执行该
 * timing-function 时的实际插值。牛顿迭代 8 步，收敛失败退二分
 * （WebKit UnitBezier 同款策略）。非法曲线上结果无意义，调用方先校验。
 */
export function bezierEase(p: BezierPoints, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, , x2] = p;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const derivX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(t) - x;
    if (Math.abs(dx) < 1e-6) return bezierPointAt(p, t).y;
    const d = derivX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  while (hi - lo > 1e-6) {
    const sx = sampleX(t);
    if (Math.abs(sx - x) < 1e-6) break;
    if (x > sx) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return bezierPointAt(p, t).y;
}

/** 输出 CSS `cubic-bezier(x1, y1, x2, y2)`，保留 3 位小数并去尾零。 */
export function toCubicBezierCss(p: BezierPoints): string {
  const f = (v: number) => {
    const r = Math.round(v * 1000) / 1000;
    return Object.is(r, -0) ? "0" : String(r);
  };
  return `cubic-bezier(${f(p[0])}, ${f(p[1])}, ${f(p[2])}, ${f(p[3])})`;
}

/** 解析 `cubic-bezier(a, b, c, d)` 字符串；格式不符或数值非有限返回 null。 */
export function parseCubicBezier(css: string): BezierPoints | null {
  const m = /^\s*cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)\s*$/i.exec(css);
  if (!m) return null;
  const nums = m.slice(1, 5).map((s) => Number(s.trim()));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

/**
 * 把任意输入规整为合法控制点：非数组 / 长度不为 4 / 含非有限数 / 不合法
 * 曲线一律返回 null（store sanitize 用）。Y 允许在 [-2, 3] 内表达过冲，
 * 超出则视为损坏数据。
 */
export function sanitizeBezier(v: unknown): BezierPoints | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const p = v.map((n) => (typeof n === "number" ? n : Number(n)));
  if (p.some((n) => !Number.isFinite(n))) return null;
  const pts: BezierPoints = [p[0], p[1], p[2], p[3]];
  if (pts[1] < -2 || pts[1] > 3 || pts[3] < -2 || pts[3] > 3) return null;
  return isBezierValid(pts) ? pts : null;
}

/** 编辑器预设：与 feature-animations.css 的 A3 两族曲线一一对应。 */
export const BEZIER_PRESETS: { id: string; label: string; points: BezierPoints }[] = [
  { id: "spatial", label: "过冲 · 默认", points: [0.38, 1.21, 0.22, 1] },
  { id: "spatial-fast", label: "过冲 · 快", points: [0.42, 1.67, 0.21, 0.9] },
  { id: "spatial-slow", label: "过冲 · 慢", points: [0.39, 1.29, 0.35, 0.98] },
  { id: "fx", label: "近对称", points: [0.34, 0.8, 0.34, 1] },
  { id: "out", label: "减速", points: [0.22, 1, 0.36, 1] },
  { id: "spring", label: "弹性", points: [0.34, 1.56, 0.64, 1] },
  { id: "linear", label: "线性", points: [0, 0, 1, 1] }
];

/** 默认自定义曲线 = Spatial 过冲族默认档。 */
export const DEFAULT_CUSTOM_EASE: BezierPoints = BEZIER_PRESETS[0].points;
