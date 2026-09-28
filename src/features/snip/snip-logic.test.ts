import { describe, expect, it } from "vitest";
import {
  MIN_SELECTION,
  clampRect,
  hitTestCorner,
  moveRect,
  normalizeRect,
  rectContains,
  resizeRect,
  snipFileName
} from "./snip-logic";

/** 截图套件纯逻辑：框选矩形运算（归一/钳制/移动/角点缩放/命中/包含）。 */

describe("normalizeRect", () => {
  it("任意拖拽方向都归一为正向矩形", () => {
    expect(normalizeRect(10, 20, 30, 60)).toEqual({ x: 10, y: 20, w: 20, h: 40 });
    expect(normalizeRect(30, 60, 10, 20)).toEqual({ x: 10, y: 20, w: 20, h: 40 });
  });
});

describe("clampRect", () => {
  it("越界部分裁回视口", () => {
    expect(clampRect({ x: -5, y: -5, w: 100, h: 50 }, 1920, 1080)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(clampRect({ x: 1900, y: 500, w: 100, h: 200 }, 1920, 1080)).toEqual({ x: 1900, y: 500, w: 20, h: 200 });
  });
});

describe("moveRect", () => {
  it("平移并钳制在视口内", () => {
    expect(moveRect({ x: 100, y: 100, w: 50, h: 50 }, 30, -200, 1920, 1080)).toEqual({ x: 130, y: 0, w: 50, h: 50 });
    expect(moveRect({ x: 100, y: 100, w: 50, h: 50 }, -500, 0, 1920, 1080)).toEqual({ x: 0, y: 100, w: 50, h: 50 });
  });
});

describe("resizeRect", () => {
  const r = { x: 100, y: 100, w: 100, h: 80 };
  it("拖东南角：西北角为锚", () => {
    expect(resizeRect(r, "se", 200, 200, 1920, 1080)).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });
  it("拖西北角反向穿过时翻转为正向矩形", () => {
    expect(resizeRect(r, "nw", 160, 160, 1920, 1080)).toEqual({ x: 160, y: 160, w: 40, h: 20 });
  });
});

describe("hitTestCorner / rectContains", () => {
  const r = { x: 100, y: 100, w: 100, h: 80 };
  it("四角命中（含容差）", () => {
    expect(hitTestCorner(r, 100, 100)).toBe("nw");
    expect(hitTestCorner(r, 200, 100)).toBe("ne");
    expect(hitTestCorner(r, 100, 180)).toBe("sw");
    expect(hitTestCorner(r, 200, 180)).toBe("se");
    expect(hitTestCorner(r, 105, 95)).toBe("nw");
    expect(hitTestCorner(r, 150, 140)).toBeNull();
  });
  it("包含判定含边界", () => {
    expect(rectContains(r, 150, 140)).toBe(true);
    expect(rectContains(r, 100, 100)).toBe(true);
    expect(rectContains(r, 99, 140)).toBe(false);
  });
});

describe("常量与文件名", () => {
  it("最小选区阈值合理（防误触）", () => {
    expect(MIN_SELECTION).toBeGreaterThanOrEqual(4);
  });
  it("文件名格式 截图_yyyyMMdd_HHmmss.png", () => {
    const name = snipFileName(new Date(2026, 8, 26, 14, 5, 9));
    expect(name).toBe("截图_20260926_140509.png");
  });
});
