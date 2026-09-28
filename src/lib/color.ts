/**
 * 主题色彩数学工具（自 settings-store 原样迁出）。
 * 纯函数、无副作用，供主题引擎与设置层共用；注意与 widget/color-shared.ts
 * 及 widgets 内联实现的输入宽容度不同（此处 rgba 输入走 withAlpha 覆写），
 * 合并前须先统一各副本语义。
 */

/**
 * 把 `#rrggbb` 颜色转为指定透明度的 `rgba()` 字符串。
 * 输入宽容：rgba()/rgb() 输入转走 {@link withAlpha} 覆写透明度；
 * 无法解析的输入原样返回（CSS 端兜底）。
 *
 * @param hex - `#rrggbb`（可省略 `#`）或 rgba()/rgb() 字符串。
 * @param alpha - 目标不透明度，0~1。
 * @returns 形如 `rgba(r,g,b,a)` 的 CSS 颜色；解析失败时原样返回入参。
 * @example
 * ```ts
 * hexToRgba("#3b82f6", 0.5);        // "rgba(59,130,246,0.50)"
 * hexToRgba("rgba(255,255,255,.08)", 0.9); // 走 withAlpha → "rgba(255,255,255,0.90)"
 * ```
 */
export function hexToRgba(hex: string, alpha: number): string {
  if (typeof hex !== "string") return hex;
  // 预设的 paper 多为 rgba(...) 字符串（如 glass 的 "rgba(255,255,255,.08)"），
  // 此前只认 #rrggbb，非匹配输入原样返回 → 五级 alpha 派生整体失效，
  // 「不透明度 100%」时背景仍带原始半透明。rgba 输入改走 withAlpha 覆写透明度。
  if (/^rgba?\(/i.test(hex.trim())) return withAlpha(hex, alpha);
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

/**
 * 把已有的 rgba()/rgb() 字符串的透明度替换为指定值。
 *
 * @param rgba - 形如 `rgba(255,255,255,.08)` 的颜色字符串。
 * @param alpha - 目标不透明度，0~1。
 * @returns 替换透明度后的字符串；非 rgba 输入原样返回。O(1)。
 * @example
 * ```ts
 * withAlpha("rgba(0,0,0,0.2)", 0.9); // "rgba(0,0,0,0.90)"
 * ```
 */
export function withAlpha(rgba: string, alpha: number): string {
  if (typeof rgba !== "string") return rgba;
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)[,\s]*([\d.]*)\s*\)$/i.exec(rgba.trim());
  if (!m) return rgba;
  const r = m[1].includes(".") ? `${Math.round(parseFloat(m[1]))}` : m[1];
  const g = m[2].includes(".") ? `${Math.round(parseFloat(m[2]))}` : m[2];
  const b = m[3].includes(".") ? `${Math.round(parseFloat(m[3]))}` : m[3];
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

/**
 * 计算颜色的 WCAG 相对亮度（近似公式）。
 * 使用场景：判断主色上应使用深色还是浅色按钮文字（阈值约 0.55）。
 *
 * @param hex - `#rrggbb` 颜色字符串。
 * @returns 0（纯黑）~1（纯白）的相对亮度；输入非法时返回中值 0.5。
 * @example
 * ```ts
 * luminance("#ffffff") > 0.55; // true → 用深色文字
 * ```
 */
export function luminance(hex: string): number {
  if (typeof hex !== "string") return 0.5;
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = ch(parseInt(m[1], 16));
  const g = ch(parseInt(m[2], 16));
  const b = ch(parseInt(m[3], 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 由主色派生渐变副色：浅色主题下向黑混 18%、深色主题下向白混 22%，
 * 保持渐变的明暗层次。
 *
 * @param hex - `#rrggbb` 主色。
 * @param isLight - 当前是否浅色主题（决定混合方向）。
 * @returns 派生出的 `#rrggbb` 副色；输入非法时原样返回。
 * @example
 * ```ts
 * deriveAccent2("#3b82f6", false); // 深色主题下提亮后的副色
 * ```
 */
export function deriveAccent2(hex: string, isLight: boolean): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  // 浅色主题向深色方向混 18%，深色主题向白色方向混 22%。
  const t = isLight ? 0.18 : 0.22;
  const target = isLight ? 0 : 255;
  const rr = mix(r, target, t);
  const gg = mix(g, target, t);
  const bb = mix(b, target, t);
  return `#${[rr, gg, bb].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 两个 hex 颜色按比例 t 插值（t=0 返回 a，t=1 返回 b）。
 * 使用场景：自定义主题由「底色 + 文字色」派生 paper/line 等次级 token
 * （底色向文字色方向微抬即得悬浮层色）。
 *
 * @param a - 起始色 `#rrggbb`。
 * @param b - 目标色 `#rrggbb`。
 * @param t - 插值比例 0~1。
 * @returns `#rrggbb` 形式的插值结果；任一输入非法时返回 a。
 */
export function mixHex(a: string, b: string, t: number): string {
  const ma = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(a.trim());
  const mb = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(b.trim());
  if (!ma || !mb) return a;
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  // 解构名不能用 b：与参数 b（目标色）同函数作用域冲突。
  const [r, g, bb] = [0, 2, 4].map((i) => mix(parseInt(ma[i + 1], 16), parseInt(mb[i + 1], 16)));
  return `#${[r, g, bb].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
