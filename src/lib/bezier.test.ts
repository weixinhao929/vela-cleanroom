import { describe, expect, it } from "vitest";

/** B3 贝塞尔曲线编辑器：合法性判定（非法曲线拒绝提交）与求值回归。 */
import {
  BEZIER_PRESETS,
  bezierEase,
  bezierPointAt,
  bezierValidity,
  isBezierValid,
  isMonotonicX,
  parseCubicBezier,
  sanitizeBezier,
  toCubicBezierCss,
  type BezierPoints
} from "./bezier";

/** 采样版单调判定：与解析判定交叉验证。 */
function monotonicBySampling(p: BezierPoints, steps = 512): boolean {
  let prev = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const { x } = bezierPointAt(p, i / steps);
    if (x < prev - 1e-9) return false;
    prev = x;
  }
  return true;
}

describe("bezierValidity 合法性判定", () => {
  it("A3 两族预设与常见 CSS 曲线全部合法", () => {
    for (const { points } of BEZIER_PRESETS) expect(isBezierValid(points)).toBe(true);
    expect(isBezierValid([0.25, 0.1, 0.25, 1])).toBe(true); // ease
    expect(isBezierValid([0.42, 0, 0.58, 1])).toBe(true); // ease-in-out
    expect(isBezierValid([0, 0, 1, 1])).toBe(true); // linear
  });

  it("Y 越界（过冲 / 回拉）允许——只有 X 受 CSS 规范约束", () => {
    expect(isBezierValid([0.34, 1.56, 0.64, 1])).toBe(true);
    expect(isBezierValid([0.5, -0.6, 0.5, 1.6])).toBe(true);
  });

  it("X 超出 [0,1] 直接拒绝", () => {
    expect(bezierValidity([-0.01, 0, 0.5, 1])).toEqual({ ok: false, reason: "x-out-of-range" });
    expect(bezierValidity([0.2, 0, 1.01, 1])).toEqual({ ok: false, reason: "x-out-of-range" });
    expect(bezierValidity([1.5, 0.2, 0.2, 1])).toEqual({ ok: false, reason: "x-out-of-range" });
  });

  it("非有限数拒绝", () => {
    expect(bezierValidity([NaN, 0, 0.5, 1])).toEqual({ ok: false, reason: "not-finite" });
    expect(bezierValidity([0.2, Infinity, 0.5, 1])).toEqual({ ok: false, reason: "not-finite" });
  });

  it("isMonotonicX：X 越界的曲线会回头（x1<0 起步倒退 / x2>1 收尾倒退 / x1 过大中段折返）", () => {
    expect(isMonotonicX([-0.01, 0, 0.5, 1])).toBe(false);
    expect(isMonotonicX([0.2, 0, 1.01, 1])).toBe(false);
    expect(isMonotonicX([1.5, 0.2, 0.2, 1])).toBe(false);
    expect(monotonicBySampling([1.5, 0.2, 0.2, 1])).toBe(false);
  });

  it("isMonotonicX：驻点允许——cubic-bezier(1,0,0,1) 中点 x'(t)=0 仍是合法曲线", () => {
    expect(isMonotonicX([1, 0, 0, 1])).toBe(true);
    expect(isBezierValid([1, 0, 0, 1])).toBe(true);
  });

  it("x1 > x2 但 X 在范围内的曲线不误杀（充分条件 x1≤x2 并非必要）", () => {
    const p: BezierPoints = [0.6, 0.1, 0.4, 0.9];
    expect(isBezierValid(p)).toBe(true);
    expect(monotonicBySampling(p)).toBe(true);
    expect(isBezierValid([0.9, 0.2, 0.05, 1])).toBe(true);
  });

  it("定理：X ∈ [0,1] ⇒ 单调（网格全测，解析判定与采样一致）", () => {
    const grid = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1];
    for (const x1 of grid)
      for (const x2 of grid) {
        const p: BezierPoints = [x1, 0.3, x2, 0.8];
        expect(isMonotonicX(p)).toBe(true);
        expect(isMonotonicX(p)).toBe(monotonicBySampling(p));
        expect(isBezierValid(p)).toBe(true);
      }
  });

  it("解析判定与采样判定在越界网格上也一致", () => {
    const grid = [-0.5, -0.1, 0, 0.5, 1, 1.1, 1.5];
    for (const x1 of grid)
      for (const x2 of grid) {
        const p: BezierPoints = [x1, 0.3, x2, 0.8];
        expect(isMonotonicX(p)).toBe(monotonicBySampling(p, 2048));
      }
  });
});

describe("bezierEase 求值", () => {
  it("端点固定 0 / 1，线性曲线恒等", () => {
    const lin: BezierPoints = [0, 0, 1, 1];
    expect(bezierEase(lin, 0)).toBe(0);
    expect(bezierEase(lin, 1)).toBe(1);
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) expect(bezierEase(lin, x)).toBeCloseTo(x, 4);
  });

  it("ease-in-out 中点为 0.5，过冲曲线中段超过 1", () => {
    expect(bezierEase([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 3);
    const spring: BezierPoints = [0.34, 1.56, 0.64, 1];
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => bezierEase(spring, (i + 1) / 51)));
    expect(peak).toBeGreaterThan(1);
  });

  it("单调递增（合法曲线的 y 随 x 单向变化，减速曲线）", () => {
    const out: BezierPoints = [0.22, 1, 0.36, 1];
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const y = bezierEase(out, i / 20);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });
});

describe("CSS 串互转与 sanitize", () => {
  it("toCubicBezierCss 三位小数去尾零，parse 回读一致", () => {
    expect(toCubicBezierCss([0.38, 1.21, 0.22, 1])).toBe("cubic-bezier(0.38, 1.21, 0.22, 1)");
    expect(toCubicBezierCss([0.123456, 0, 1, -0.0001])).toBe("cubic-bezier(0.123, 0, 1, 0)");
    expect(parseCubicBezier("cubic-bezier(0.38, 1.21, 0.22, 1)")).toEqual([0.38, 1.21, 0.22, 1]);
    expect(parseCubicBezier(" CUBIC-BEZIER(.2,.9,.3,1) ")).toEqual([0.2, 0.9, 0.3, 1]);
    expect(parseCubicBezier("ease-in")).toBeNull();
    expect(parseCubicBezier("cubic-bezier(a, 0, 1, 1)")).toBeNull();
  });

  it("sanitizeBezier：合法通过，非法/损坏一律 null", () => {
    expect(sanitizeBezier([0.38, 1.21, 0.22, 1])).toEqual([0.38, 1.21, 0.22, 1]);
    expect(sanitizeBezier(["0.2", "0.9", "0.3", "1"])).toEqual([0.2, 0.9, 0.3, 1]);
    expect(sanitizeBezier([1.2, 0, 0.5, 1])).toBeNull(); // x 越界
    expect(sanitizeBezier([0.3, -0.2, 1.5, 1])).toBeNull(); // x2 越界（曲线收尾回头）
    expect(sanitizeBezier([0.3, 5, 0.6, 1])).toBeNull(); // y 超出过冲允许带
    expect(sanitizeBezier([0.3, 0.3, 0.6])).toBeNull();
    expect(sanitizeBezier("cubic-bezier(0,0,1,1)")).toBeNull();
    expect(sanitizeBezier(null)).toBeNull();
  });
});
