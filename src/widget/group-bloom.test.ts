/**
 * 编组花瓣预览定位纯函数测试。
 */
import { describe, expect, it } from "vitest";

import { anchorToLayout, bloomPlacement } from "./GroupBloom";

describe("bloomPlacement", () => {
  it("上方放得下：在锚点上方展开，缩放锚为底部", () => {
    const p = bloomPlacement(
      { left: 100, top: 400, width: 300, bottom: 430 },
      { w: 1920, h: 1080 },
      { w: 280, h: 220 }
    );
    expect(p.top).toBe(400 - 220 - 8);
    expect(p.originY).toBe("bottom");
  });

  it("上方放不下且下方也放不下：翻下方并钳在视口内", () => {
    const p = bloomPlacement({ left: 100, top: 60, width: 300, bottom: 90 }, { w: 1920, h: 400 }, { w: 280, h: 220 });
    // 上方 60-228 < 8 放不下；下方 90+228=318 < 400-8 其实放得下 → 用下方。
    expect(p.top).toBe(90 + 8);
    expect(p.originY).toBe("top");
    // 视口太矮时钳到 8 安全边。
    const tight = bloomPlacement(
      { left: 100, top: 10, width: 300, bottom: 40 },
      { w: 1920, h: 160 },
      { w: 280, h: 220 }
    );
    expect(tight.top).toBe(8);
  });

  it("横向：锚点靠右时夹在视口内", () => {
    const p = bloomPlacement(
      { left: 1800, top: 400, width: 100, bottom: 430 },
      { w: 1920, h: 1080 },
      { w: 280, h: 220 }
    );
    expect(p.left).toBeLessThanOrEqual(1920 - 280 - 8);
    expect(p.left).toBeGreaterThan(8);
  });
});

describe("anchorToLayout（界面缩放换算）", () => {
  it("锚点与视口视觉坐标除回缩放系数，得到 fixed 定位布局单位", () => {
    // html zoom 1.25 下：gBCR/clientX 是视觉坐标，fixed left/top 渲染再乘
    // zoom——除回后渲染位置恰好回到视觉目标（实机验证模型，见 ui-zoom.ts）。
    const out = anchorToLayout({ left: 500, top: 375, width: 250, bottom: 425 }, { w: 1600, h: 900 }, 1.25);
    expect(out.anchor).toEqual({ left: 400, top: 300, width: 200, bottom: 340 });
    expect(out.viewport).toEqual({ w: 1280, h: 720 });
  });

  it("缩放 1 时原样返回（不引入舍入误差）", () => {
    const out = anchorToLayout({ left: 12.5, top: 8, width: 100, bottom: 38 }, { w: 1920, h: 1080 }, 1);
    expect(out.anchor).toEqual({ left: 12.5, top: 8, width: 100, bottom: 38 });
    expect(out.viewport).toEqual({ w: 1920, h: 1080 });
  });
});
