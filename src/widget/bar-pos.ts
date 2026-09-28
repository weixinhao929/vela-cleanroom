/**
 * 悬浮工具条（视图切换器 / 编辑工具栏）自定义位置的持久化。
 *
 * 位置按屏幕分区（`#screen=N`，见 widget-store `currentScreenId`）分别存储。
 * 每块显示器各有一个铺满该屏的小组件窗口，逻辑分辨率往往不同（如主屏
 * 1920×1080、副屏 2560×1440@150% → 1707×960），同一组绝对坐标在一块屏上
 * 刚好贴着任务栏，在另一块屏上就整体落在视口之外。早期版本用单一全局键
 * `focus-desk.bar-pos.v1`，两块屏互相覆盖：在 A 屏调好，B 屏就错位或消失，
 * 用户只能反复重拖（docs/issues-2026-09-10-bar-position.md）。
 */
import { persistMirrored } from "../lib/local-backup";
import { currentScreenId } from "./widget-store";

export type BarKind = "switcher" | "toolbar";
export type BarPos = { x: number; y: number };
type BarPosMap = Partial<Record<BarKind, BarPos>>;

/** 可用视口：宽为 innerWidth，高应已扣除任务栏（工具条落在任务栏后面同样够不着）。 */
export type Viewport = { width: number; height: number };

/** 旧版全局键（不分屏）。只读不写：作为本屏尚无记录时的一次性迁移来源。 */
export const LEGACY_BAR_POS_KEY = "focus-desk.bar-pos.v1";

/** 当前屏幕分区的存储键（调用时求值，与 widget-store 其余分区键一致）。 */
export function barPosKey(): string {
  return `focus-desk.screen.${currentScreenId()}.bar-pos.v1`;
}

/** 越界判定余量：左上角至少留这么多像素在可视区内，保证拖动把手可抓。 */
const MIN_VISIBLE = 24;

function isBarPos(v: unknown): v is BarPos {
  if (!v || typeof v !== "object") return false;
  const { x, y } = v as Record<string, unknown>;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
}

/** localStorage 不可用（隐私模式 / 受限）时返回 undefined，与"键不存在"的 null 区分。 */
function readRaw(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function parseMap(raw: string | null | undefined): BarPosMap {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    const out: BarPosMap = {};
    for (const kind of ["switcher", "toolbar"] as const) {
      const v = (p as Record<string, unknown>)[kind];
      if (isBarPos(v)) out[kind] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 位置左上角是否落在可视区内（带 {@link MIN_VISIBLE} 余量）。
 *
 * @param p - 待判定的位置。
 * @param vp - 当前可用视口。
 * @returns 在可视区内为 true。
 */
export function isWithinViewport(p: BarPos, vp: Viewport): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= vp.width - MIN_VISIBLE && p.y <= vp.height - MIN_VISIBLE;
}

/** 迁移只在视口尺寸可信时落盘：0×0 之类的异常视口会把所有旧记录误判为越界而永久丢弃。 */
const MIN_SANE_VIEWPORT: Viewport = { width: 320, height: 240 };

/**
 * 读取当前屏幕分区的位置表。本屏尚无记录且存在旧全局键时，把旧表中
 * 仍在本屏可视区内的条目迁入本屏键（越界条目丢弃——那正是旧全局键在
 * "另一块屏"上的典型状态），此后旧键对本屏不再生效，复位也不会被它复活。
 * 迁移每屏至多发生一次；localStorage 不可用或视口尺寸异常时不写入，
 * 仅按旧表只读回落。
 */
function loadMap(vp: Viewport): BarPosMap {
  const own = readRaw(barPosKey());
  if (own === undefined) return {};
  if (own !== null) return parseMap(own);
  const legacy = parseMap(readRaw(LEGACY_BAR_POS_KEY));
  if (vp.width < MIN_SANE_VIEWPORT.width || vp.height < MIN_SANE_VIEWPORT.height) return legacy;
  const migrated: BarPosMap = {};
  for (const kind of ["switcher", "toolbar"] as const) {
    const v = legacy[kind];
    if (v && isWithinViewport(v, vp)) migrated[kind] = v;
  }
  persistMirrored(barPosKey(), JSON.stringify(migrated));
  return migrated;
}

/**
 * 读取某工具条在当前屏幕分区的自定义位置。
 * 无论来源，落在 `viewport` 之外的位置一律视为无效并返回 null，由调用方
 * 回到随任务栏 / 分辨率自适应的默认位置。
 *
 * @param kind - 工具条类型。
 * @param viewport - 当前可用视口（宽 = innerWidth，高 = 扣除任务栏后的高度）。
 * @returns 位置；无记录 / 损坏 / 越界时为 null。
 * @throws 无。
 *
 * @example
 * ```ts
 * const pos = loadBarPos("switcher", { width: innerWidth, height: innerHeight - taskbar });
 * ```
 */
export function loadBarPos(kind: BarKind, viewport: Viewport): BarPos | null {
  const p = loadMap(viewport)[kind];
  return p && isWithinViewport(p, viewport) ? p : null;
}

/**
 * 写入（`null` 为清除）某工具条在当前屏幕分区的自定义位置。
 * 只改本 kind 的条目，另一条工具条的位置原样保留。
 *
 * @param kind - 工具条类型。
 * @param pos - 新位置；null 表示恢复默认位置。
 * @returns 无。
 * @throws 无（配额溢出等由 persistMirrored 记日志 / 弹 toast）。
 */
export function saveBarPos(kind: BarKind, pos: BarPos | null): void {
  const all = parseMap(readRaw(barPosKey()));
  if (pos) all[kind] = pos;
  else delete all[kind];
  persistMirrored(barPosKey(), JSON.stringify(all));
}
