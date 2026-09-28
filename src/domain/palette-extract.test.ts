import { describe, expect, it } from "vitest";
import {
  clampToSoftZone,
  collectPixels,
  extractPalette,
  hslToRgb,
  rgbToHex,
  rgbToHsl,
  scoreColor,
  shadeRamp,
  type ImageLike
} from "./palette-extract";

/** 图片色板提取（借鉴 CSH #12）：色彩空间换算往返 / 像素采集 / 柔和区间 /
 *  梯度档数 / 合成图种子色命中主色块。 */

function solidImage(w: number, h: number, fill: [number, number, number, number?]): ImageLike {
  const data: number[] = [];
  for (let i = 0; i < w * h; i++) data.push(fill[0], fill[1], fill[2], fill[3] ?? 255);
  return { data, width: w, height: h };
}

describe("hsl 往返", () => {
  it("rgb → hsl → rgb 保真（整数域）", () => {
    for (const rgb of [
      { r: 200, g: 60, b: 40 },
      { r: 40, g: 180, b: 90 },
      { r: 30, g: 30, b: 30 },
      { r: 240, g: 240, b: 100 }
    ]) {
      const back = hslToRgb(rgbToHsl(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });
  it("灰色的 S=0", () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128 }).s).toBe(0);
  });
  it("hex 输出钳到合法域", () => {
    expect(rgbToHex({ r: 300, g: -5, b: 12 })).toBe("#ff000c");
  });
});

describe("collectPixels", () => {
  it("跳过半透明像素（alpha < 125）", () => {
    const img: ImageLike = {
      data: [10, 20, 30, 255, 40, 50, 60, 100],
      width: 2,
      height: 1
    };
    const px = collectPixels(img);
    expect(px).toEqual([{ r: 10, g: 20, b: 30 }]);
  });
  it("超大图抽样不超过 cap", () => {
    const img = solidImage(400, 400, [50, 120, 200]);
    expect(collectPixels(img, 125, 100).length).toBeLessThanOrEqual(101);
  });
  it("空图返回空", () => {
    expect(collectPixels({ data: [], width: 0, height: 0 })).toEqual([]);
  });
});

describe("scoreColor / clampToSoftZone", () => {
  it("近灰零分、中等饱和加分、过暗惩罚", () => {
    expect(scoreColor({ r: 128, g: 128, b: 128 }, 100)).toBe(0);
    const mid = scoreColor({ r: 200, g: 90, b: 70 }, 100);
    const dark = scoreColor({ r: 8, g: 10, b: 12 }, 100);
    expect(mid).toBeGreaterThan(0);
    expect(dark).toBeLessThan(mid);
  });
  it("柔和区间夹取", () => {
    expect(clampToSoftZone({ h: -10, s: 5, l: 99 })).toEqual({ h: 350, s: 30, l: 75 });
    expect(clampToSoftZone({ h: 200, s: 99, l: 2 })).toEqual({ h: 200, s: 85, l: 25 });
  });
});

describe("shadeRamp", () => {
  it("7 档，中间档 = 基准色", () => {
    const ramp = shadeRamp({ h: 210, s: 60, l: 50 });
    expect(ramp).toHaveLength(7);
    expect(ramp[3]).toBe(rgbToHex(hslToRgb({ h: 210, s: 60, l: 50 })));
  });
});

describe("extractPalette 端到端（合成图）", () => {
  it("主色块成为种子色（柔和化后）", () => {
    // 60% 饱和蓝 + 40% 暗红：种子应落在蓝色系（H ∈ [190, 240]）。
    const data: number[] = [];
    for (let i = 0; i < 600; i++) data.push(60, 110, 210, 255);
    for (let i = 0; i < 400; i++) data.push(90, 20, 20, 255);
    const img: ImageLike = { data, width: 1000, height: 1 };
    const p = extractPalette(img);
    expect(p).not.toBeNull();
    expect(p!.shades).toHaveLength(7);
    const seedH = rgbToHsl({
      r: parseInt(p!.seed.hex.slice(1, 3), 16),
      g: parseInt(p!.seed.hex.slice(3, 5), 16),
      b: parseInt(p!.seed.hex.slice(5, 7), 16)
    }).h;
    expect(seedH).toBeGreaterThan(180);
    expect(seedH).toBeLessThan(250);
  });
  it("全透明/全灰图返回 null", () => {
    expect(extractPalette({ data: [1, 2, 3, 0], width: 1, height: 1 })).toBeNull();
    expect(extractPalette(solidImage(10, 10, [128, 128, 128]))).toBeNull();
  });
});
