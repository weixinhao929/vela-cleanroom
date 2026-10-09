import { describe, expect, it } from "vitest";
import { ALIGN_THRESHOLD_PX, computeAlignAdjust } from "./align-guides";

/**
 * 共享对齐纯函数的锚点测试：卡片与编组容器拖拽共用同一套吸附数学，
 * 这里锁三线互吸、参考线产出、无线恒等与视口零线回落四条行为。
 */

describe("computeAlignAdjust", () => {
  it("无线候选时原样返回且不产参考线", () => {
    const out = computeAlignAdjust(300, 300, 200, 160, [], ALIGN_THRESHOLD_PX);
    expect(out).toEqual({ x: 300, y: 300, guideXs: [], guideYs: [] });
  });

  it("左缘进入阈值吸附到候选左缘，并产出该参考线", () => {
    // 被拖矩形左缘 103，候选左缘 100：差 3 ≤ 阈值 → 吸到 100。
    const out = computeAlignAdjust(103, 300, 200, 160, [{ x: 100, y: 0, w: 120, h: 90 }], ALIGN_THRESHOLD_PX);
    expect(out.x).toBe(100);
    expect(out.guideXs).toEqual([100]);
    // y 无线：原样。
    expect(out.y).toBe(300);
    expect(out.guideYs).toEqual([]);
  });

  it("中线对中线同样互吸（垂直居中）", () => {
    // 候选中线 y = 0 + 90/2 = 45；被拖矩形中线 300 + 160/2 = 380 → 差远超阈值，
    // 改用近值：被拖 y=−40 → 中线 40，与 45 差 5 ≤ 8 → 吸到中线 45（y = 45 − 80 = −35）。
    const out = computeAlignAdjust(300, -40, 200, 160, [{ x: 0, y: 0, w: 120, h: 90 }], ALIGN_THRESHOLD_PX);
    expect(out.y).toBe(-35);
    expect(out.guideYs).toEqual([45]);
  });

  it("贴近视口零线且无线时贴边（x/y 双轴独立）", () => {
    const out = computeAlignAdjust(5, 400, 200, 160, [], ALIGN_THRESHOLD_PX);
    expect(out.x).toBe(0);
    expect(out.guideXs).toEqual([0]);
    expect(out.y).toBe(400);
    expect(out.guideYs).toEqual([]);
  });

  it("阈值是多候选竞争时取最小偏差者", () => {
    // 候选 A 左缘 100（差 3）、候选 B 左缘 106（差 −1）→ 取 B（更近）。
    const out = computeAlignAdjust(
      105,
      300,
      200,
      160,
      [
        { x: 100, y: 1000, w: 50, h: 50 },
        { x: 106, y: 2000, w: 50, h: 50 }
      ],
      ALIGN_THRESHOLD_PX
    );
    expect(out.x).toBe(106);
    expect(out.guideXs).toEqual([106]);
  });
});
