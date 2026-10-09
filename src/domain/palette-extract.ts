/**
 * 任意图片 → 主题色板：
 * 跳过半透明像素（alpha < 125）→ 中位切分 8 块 → 按频率 × 灰度惩罚 ×
 * 过亮过暗惩罚 × 中等饱和度加分选出种子色 → 夹进柔和区间（L 25–75，
 * S 30–85）→ 生成 7 档明暗梯度（亮 3 … 基准 … 暗 3，饱和度随亮度反向微调）。
 * 纯函数（ImageData 注入），供样式页「从图片提取色板」与单测共用。
 */

export type Rgb = { r: number; g: number; b: number };
export type Hsl = { h: number; s: number; l: number };

/** 最小图像数据形状（ImageData 的结构子集，测试可注入普通对象）。 */
export type ImageLike = { data: Uint8ClampedArray | Uint8Array | number[]; width: number; height: number };

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = s / 100;
  const ln = l / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hn = (((h % 360) + 360) % 360) / 360;
  return {
    r: Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hn) * 255),
    b: Math.round(hue2rgb(p, q, hn - 1 / 3) * 255)
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

type Pixel = { r: number; g: number; b: number };

/** 采集有效像素（跳过半透明），超过 cap 时等距抽样控制规模。 */
export function collectPixels(img: ImageLike, alphaMin = 125, cap = 20_000): Pixel[] {
  const { data, width, height } = img;
  const total = width * height;
  const out: Pixel[] = [];
  if (total <= 0) return out;
  const step = Math.max(1, Math.ceil(total / cap));
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if ((data[o + 3] ?? 255) < alphaMin) continue;
    out.push({ r: data[o], g: data[o + 1], b: data[o + 2] });
  }
  return out;
}

type Box = { pixels: Pixel[] };

/** 中位切分：递归分裂「色域最长」的盒子，直至 8 块。 */
export function medianCut(pixels: Pixel[], boxes = 8): Pixel[][] {
  if (pixels.length === 0) return [];
  let list: Box[] = [{ pixels }];
  while (list.length < boxes) {
    // 挑体积（像素数 × 色域）最大的盒子分裂；全为单色时提前结束。
    let bestIdx = -1;
    let bestScore = -1;
    let bestAxis: "r" | "g" | "b" = "r";
    let bestRange = 0;
    for (let i = 0; i < list.length; i++) {
      const range = axisRange(list[i].pixels);
      const score = list[i].pixels.length * range.max;
      if (range.max === 0) continue;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestAxis = range.axis;
        bestRange = range.max;
      }
    }
    if (bestIdx < 0 || bestRange === 0) break;
    const target = list[bestIdx];
    const sorted = [...target.pixels].sort((a, b) => a[bestAxis] - b[bestAxis]);
    const mid = Math.floor(sorted.length / 2);
    list = list
      .filter((_, i) => i !== bestIdx)
      .concat([{ pixels: sorted.slice(0, mid) }, { pixels: sorted.slice(mid) }]);
  }
  return list.map((b) => b.pixels).filter((p) => p.length > 0);
}

function axisRange(pixels: Pixel[]): { axis: "r" | "g" | "b"; max: number } {
  const axes: ("r" | "g" | "b")[] = ["r", "g", "b"];
  let bestAxis: "r" | "g" | "b" = "r";
  let bestMax = 0;
  for (const axis of axes) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of pixels) {
      const v = p[axis];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min > bestMax) {
      bestMax = max - min;
      bestAxis = axis;
    }
  }
  return { axis: bestAxis, max: bestMax };
}

/** 盒均色。 */
export function averageColor(pixels: Pixel[]): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  const n = pixels.length;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** 打分：频率 × 灰度惩罚 × 过亮过暗惩罚 × 中等饱和度加分（CSH 同款思路）。 */
export function scoreColor(rgb: Rgb, count: number): number {
  const { s, l } = rgbToHsl(rgb);
  if (s < 10) return 0; // 近灰/黑白的盒子不配当种子色。
  let score = count;
  if (s < 20) score *= 0.4;
  if (l < 15 || l > 92) score *= 0.2;
  else if (l < 25 || l > 85) score *= 0.6;
  if (s >= 30 && s <= 70) score *= 1.35;
  return score;
}

/** 夹进柔和区间：L → [25,75]，S → [30,85]。 */
export function clampToSoftZone(hsl: Hsl): Hsl {
  return {
    h: ((hsl.h % 360) + 360) % 360,
    s: Math.min(85, Math.max(30, hsl.s)),
    l: Math.min(75, Math.max(25, hsl.l))
  };
}

/** 7 档明暗梯度（亮 3 … 基准 … 暗 3）：亮度 ±10/档，饱和度随亮度反向微调。 */
export function shadeRamp(base: Hsl): string[] {
  const out: string[] = [];
  for (let i = -3; i <= 3; i++) {
    const l = Math.min(94, Math.max(10, base.l + i * 10));
    // 变亮降饱和、变暗增饱和（每档 ∓4%），符合自然色阶直觉。
    const s = Math.min(95, Math.max(18, base.s - i * 4));
    out.push(rgbToHex(hslToRgb({ h: base.h, s, l })));
  }
  return out;
}

export type ExtractedPalette = {
  seed: { hex: string; hsl: Hsl };
  shades: string[];
};

/** 梯度直接映射的自定义主题双档配色（结构兼容 store 的 CustomThemeColors，
 *  domain 不反向依赖 store，故就地声明同形类型）。 */
export type PaletteThemeColors = {
  dark: { bg: string; ink: string };
  light: { bg: string; ink: string };
};

/**
 * 7 档梯度 → 自定义主题整套配色：暗档取最暗端作底、最亮端作文字，亮档
 * 镜像互换；基准色留给调用方作主色（setPrimaryColor）。梯度两端亮度差
 * 由 shadeRamp 的 ±3 档（每档 10 L）构造保证，明暗极性与可读性天然成立。
 * 梯度不完整（<2 档）时双档同用基准色（引擎按底色亮度自判极性，不炸）。
 */
export function paletteToCustomColors(palette: ExtractedPalette): PaletteThemeColors {
  const darkest = palette.shades[0] ?? palette.seed.hex;
  const lightest = palette.shades[palette.shades.length - 1] ?? palette.seed.hex;
  return {
    dark: { bg: darkest, ink: lightest },
    light: { bg: lightest, ink: darkest }
  };
}

/** 全链路：像素 → 中位切分 → 打分选种子 → 柔和化 → 7 档梯度。 */
export function extractPalette(img: ImageLike): ExtractedPalette | null {
  const pixels = collectPixels(img);
  if (pixels.length === 0) return null;
  const boxes = medianCut(pixels, 8);
  if (boxes.length === 0) return null;
  let bestColor: Rgb | null = null;
  let bestScore = -1;
  for (const boxPixels of boxes) {
    const avg = averageColor(boxPixels);
    const score = scoreColor(avg, boxPixels.length);
    if (score > bestScore) {
      bestScore = score;
      bestColor = avg;
    }
  }
  if (!bestColor || bestScore <= 0) return null;
  const soft = clampToSoftZone(rgbToHsl(bestColor));
  return {
    seed: { hex: rgbToHex(hslToRgb(soft)), hsl: soft },
    shades: shadeRamp(soft)
  };
}
