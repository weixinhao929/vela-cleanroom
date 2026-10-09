/**
 * 取色器共享存储与色彩换算（~109）。
 *
 * 取色历史原先只是各实例私有 string[]；本模块把它结构化（固定/删除/容量），
 * 并提供跨实例聚合读取（涂鸦组件用作「最近取色」色源）与跨实例
 * 共享的命名色板。所有写入走 persistMirrored，随本地镜像进备份。
 */

import { persistMirrored } from "../lib/local-backup";

/* ── 色彩换算 ─────────────────────────────────────────────── */

/**
 * `#rrggbb` → RGB 三元组；解析失败返回 [0,0,0]。
 *
 * @param hex - 十六进制颜色（可省略 `#`）。
 * @returns `[r, g, b]`（各 0-255）。
 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

/** HSV（Photoshop/Figma 的 HSB 语义：V = max）。 */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      default:
        h = ((r - g) / d + 4) * 60;
    }
  }
  const s = max === 0 ? 0 : d / max;
  return [Math.round(h), Math.round(s * 100), Math.round(max * 100)];
}

/** CMYK（印刷常用近似换算，K = 1 − max(R,G,B)）。 */
export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const rr = r / 255,
    gg = g / 255,
    bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k >= 1) return [0, 0, 0, 100];
  const c = (1 - rr - k) / (1 - k);
  const m = (1 - gg - k) / (1 - k);
  const y = (1 - bb - k) / (1 - k);
  return [Math.round(c * 100), Math.round(m * 100), Math.round(y * 100), Math.round(k * 100)];
}

/* ── 取色历史（结构化） ────────────────────────────── */

export type HistoryColor = { hex: string; pinned?: boolean };

function historyKey(instanceId: string) {
  return `focus-desk.cp.history.${instanceId}`;
}

/** 读取历史：兼容旧版纯 string[]（迁移为未固定条目）。 */
export function loadPickerHistory(instanceId: string): HistoryColor[] {
  try {
    const raw = localStorage.getItem(historyKey(instanceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => (typeof v === "string" ? { hex: v.toLowerCase() } : v))
        .filter((v): v is HistoryColor => !!v && typeof v.hex === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export function savePickerHistory(instanceId: string, list: HistoryColor[]) {
  persistMirrored(historyKey(instanceId), JSON.stringify(list));
}

/**
 * 跨实例聚合：按时间序合并所有取色器实例的历史（去重、固定优先），
 * 供涂鸦等组件作为「最近取色」色源。limit 上限避免渲染过多色块。
 */
export function listAllPickerHistory(limit = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const prefix = "focus-desk.cp.history.";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    for (const item of loadPickerHistory(id)) {
      const hex = item.hex.toLowerCase();
      if (!hex || seen.has(hex)) continue;
      seen.add(hex);
      out.push(hex);
    }
  }
  // 固定的颜色排前面（更可能是常用色）。
  const pinned = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    for (const item of loadPickerHistory(key.slice(prefix.length))) {
      if (item.pinned) pinned.add(item.hex.toLowerCase());
    }
  }
  const ranked = [...out].sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)));
  return ranked.slice(0, limit);
}

/* ── 命名色板（跨实例共享） ────────────────────────── */

export type Palette = { id: string; name: string; colors: string[] };

const PALETTES_KEY = "focus-desk.palettes.v1";
export const PALETTES_EVENT = "focus-desk:palettes-changed";

export function loadPalettes(): Palette[] {
  try {
    const raw = localStorage.getItem(PALETTES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((p): p is Palette => !!p && typeof p.name === "string" && Array.isArray(p.colors))
      : [];
  } catch {
    return [];
  }
}

export function savePalettes(list: Palette[]) {
  persistMirrored(PALETTES_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(PALETTES_EVENT));
  // 多显示器场景每屏一个 widget 窗，window 级 CustomEvent 不跨窗——
  // 显示器 0 上改色板，显示器 1 的取色器不刷新。补一条 Tauri 全局事件作
  // 跨窗通知（各窗收到后自行重读共享 localStorage）。失败静默：本窗事件
  // 已保证本窗刷新，跨窗最迟在下次打开时读到新值。
  void import("@tauri-apps/api/event").then(({ emit }) => emit(PALETTES_EVENT)).catch(() => {});
}
