/**
 * 编组花瓣预览（BentoDesk 借鉴 #3）定位纯函数测试。
 */
import { describe, expect, it } from "vitest";

import { bloomPlacement } from "./GroupBloom";

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
