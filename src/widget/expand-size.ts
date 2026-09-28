/**
 * 展开面板（WidgetExpandOverlay）记住的尺寸：按屏幕分区、按面板键持久化。
 *
 * 面板键由调用方给：磁贴按类型（`dock:<type>`，同类磁贴共用一份，删了再加也不丢）、
 * 全岛面板 `dock:panel`、画布小组件按类型（`widget:<type>`）。按屏分区的理由与
 * bar-pos.ts 相同：两块显示器逻辑分辨率不同，一块屏上合适的尺寸在另一块上可能出屏。
 *
 * 读出的尺寸只是「意向」：调用方仍要按当时视口钳制（这里只保证下限与结构合法）。
 */
import { persistMirrored } from "../lib/local-backup";
import { currentScreenId } from "./widget-store";

export type ExpandSize = { w: number; h: number };

/** 面板最小尺寸（px）：天气站 / 任务总览等内容在此之下只剩滚动条。 */
export const EXPAND_MIN_W = 320;
export const EXPAND_MIN_H = 240;
/** 面板距视口四边的安全边（px），与 WidgetExpandOverlay.immersiveRect 同源。 */
export const EXPAND_VIEWPORT_MARGIN = 12;

/** 当前屏幕分区的存储键（调用时求值，与 widget-store 其余分区键一致）。 */
export function expandSizeKey(): string {
  return `focus-desk.screen.${currentScreenId()}.expand-size.v1`;
}

function isSize(v: unknown): v is ExpandSize {
  if (!v || typeof v !== "object") return false;
  const { w, h } = v as Record<string, unknown>;
  return typeof w === "number" && Number.isFinite(w) && typeof h === "number" && Number.isFinite(h);
}

function readMap(): Record<string, ExpandSize> {
  try {
    const raw = localStorage.getItem(expandSizeKey());
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    const out: Record<string, ExpandSize> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (isSize(v) && v.w >= EXPAND_MIN_W && v.h >= EXPAND_MIN_H) out[k] = { w: Math.round(v.w), h: Math.round(v.h) };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 读取某面板记住的尺寸。
 *
 * @param key - 面板键（如 `dock:weather`）。
 * @returns 尺寸；无记录 / 损坏 / 小于下限时为 null（调用方回默认 min(720, 90vw) × min(600, 86vh)）。
 */
export function loadExpandSize(key: string): ExpandSize | null {
  return readMap()[key] ?? null;
}

/**
 * 写入（`null` 为清除，恢复默认尺寸）某面板的尺寸。只改本键，其余面板原样保留。
 *
 * @param key - 面板键。
 * @param size - 新尺寸；null 表示恢复默认。
 * @returns 无。写失败由 persistMirrored 记日志 / 弹 toast。
 */
export function saveExpandSize(key: string, size: ExpandSize | null): void {
  const all = readMap();
  if (size) all[key] = { w: Math.round(size.w), h: Math.round(size.h) };
  else delete all[key];
  persistMirrored(expandSizeKey(), JSON.stringify(all));
}

/**
 * 把意向尺寸钳进当前视口（留安全边）并不小于下限。
 *
 * @param size - 意向尺寸。
 * @param vw - 视口宽。
 * @param vh - 视口高。
 * @returns 合法尺寸。
 */
export function clampExpandSize(size: ExpandSize, vw: number, vh: number): ExpandSize {
  const maxW = Math.max(EXPAND_MIN_W, vw - EXPAND_VIEWPORT_MARGIN * 2);
  const maxH = Math.max(EXPAND_MIN_H, vh - EXPAND_VIEWPORT_MARGIN * 2);
  return {
    w: Math.round(Math.min(maxW, Math.max(EXPAND_MIN_W, size.w))),
    h: Math.round(Math.min(maxH, Math.max(EXPAND_MIN_H, size.h)))
  };
}
