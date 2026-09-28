/**
 * 「杂项」面板的网格布局引擎（纯函数，无 DOM）。
 *
 * 面板是 MISC_COLS 列、行高固定的格子板；每个条目占 w×h 个格子（整数）。交互口径
 * 对标 Android / KDE 的小组件板：
 *  - 拖动条目到某格：占位框吸到最近的格（磁性），被压住的条目向下推开（连锁），
 *    其余条目再向上压实填空——松手前实时预演，松手即定稿；
 *  - 新增条目：从上到下、从左到右扫第一个放得下的空位；
 *  - 任何入口进来的布局先过 sanitizeMiscItems：越界 / 重叠 / 坏值一律修正，
 *    保证渲染层拿到的永远是合法、无重叠、已压实的布局。
 *
 * 全部函数不改入参，返回新数组（条目对象浅拷贝），顺序与入参一致（渲染 key 稳定）。
 */

export type MiscItem = {
  /** 条目 id（面板内唯一；内嵌小组件的 instanceId = `<tileId>:<id>`）。 */
  id: string;
  /** registry 类型 id。 */
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** 列数。4 列在默认 720px 宽的面板里每格约 160px，够放一枚常规小组件的最小宽度。 */
export const MISC_COLS = 4;
/** 行高（px）。 */
export const MISC_ROW_PX = 104;
/** 格间距（px）。 */
export const MISC_GAP_PX = 10;
/** 条目最大行数（防止某个类型 defaultSize 极高把板撑爆）。 */
export const MISC_MAX_H = 4;

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** 两条目在格子板上是否重叠。 */
export function collides(a: MiscItem, b: MiscItem): boolean {
  if (a.id === b.id) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const byRowCol = (a: MiscItem, b: MiscItem) => (a.y === b.y ? a.x - b.x : a.y - b.y);

/**
 * 按画布默认尺寸（px）换算条目占格：宽按 160px/格、高按行高取整，钳在 1..cols / 1..MISC_MAX_H。
 * 常规 320×200 的卡片 → 2×2；小工具类（≤160 宽）→ 1 列。
 */
export function gridSizeFor(defaultSize: { w: number; h: number }, cols = MISC_COLS): { w: number; h: number } {
  return {
    w: clampInt(defaultSize.w / 160, 1, cols),
    h: clampInt(defaultSize.h / MISC_ROW_PX, 1, MISC_MAX_H)
  };
}

/**
 * 向上压实：按行列序逐条目上移到不与已放置条目重叠的最高位置；staticId 指定的条目
 * 不动（拖动中的那一枚），其余条目绕着它排。
 */
export function compactLayout(items: MiscItem[], cols = MISC_COLS, staticId?: string): MiscItem[] {
  const list = items.map((i) => ({
    ...i,
    x: clampInt(i.x, 0, Math.max(0, cols - i.w)),
    y: Math.max(0, Math.round(i.y))
  }));
  const placed: MiscItem[] = [];
  const pinned = staticId ? list.find((i) => i.id === staticId) : undefined;
  if (pinned) placed.push(pinned);
  for (const item of [...list].sort(byRowCol)) {
    if (item === pinned) continue;
    let y = item.y;
    while (y > 0 && !placed.some((p) => collides(p, { ...item, y: y - 1 }))) y -= 1;
    while (placed.some((p) => collides(p, { ...item, y }))) y += 1;
    item.y = y;
    placed.push(item);
  }
  return list;
}

/**
 * 把条目移到 (x, y)：越界钳回；压到谁就把谁往下推（连锁，被推的条目再压到别的照样推），
 * 最后其余条目向上压实——被移动的条目钉在目标位。
 */
export function moveItem(items: MiscItem[], id: string, x: number, y: number, cols = MISC_COLS): MiscItem[] {
  const list = items.map((i) => ({ ...i }));
  const it = list.find((i) => i.id === id);
  if (!it) return list;
  it.x = clampInt(x, 0, Math.max(0, cols - it.w));
  it.y = Math.max(0, Math.round(y));
  const queue: MiscItem[] = [it];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const other of [...list].sort(byRowCol)) {
      if (other.id === id || other === cur) continue;
      if (collides(other, cur)) {
        other.y = cur.y + cur.h;
        queue.push(other);
      }
    }
  }
  return compactLayout(list, cols, id);
}

/**
 * 把条目尺寸改为 w×h（拖动条目右下角的手柄）：宽钳在 1..cols（越宽时 x 左移钳回）、
 * 高钳在 1..MISC_MAX_H；变大压到谁就把谁往下推（连锁同 moveItem），最后其余条目向上
 * 压实——被调条目钉在原位（x,y 不动，除非越界钳回）。
 */
export function resizeItem(items: MiscItem[], id: string, w: number, h: number, cols = MISC_COLS): MiscItem[] {
  const list = items.map((i) => ({ ...i }));
  const it = list.find((i) => i.id === id);
  if (!it) return list;
  it.w = clampInt(w, 1, cols);
  it.h = clampInt(h, 1, MISC_MAX_H);
  it.x = clampInt(it.x, 0, Math.max(0, cols - it.w));
  const queue: MiscItem[] = [it];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const other of [...list].sort(byRowCol)) {
      if (other.id === id || other === cur) continue;
      if (collides(other, cur)) {
        other.y = cur.y + cur.h;
        queue.push(other);
      }
    }
  }
  return compactLayout(list, cols, id);
}

/** 从上到下、从左到右找第一个放得下 w×h 的空位。 */
export function findFreeSlot(items: MiscItem[], w: number, h: number, cols = MISC_COLS): { x: number; y: number } {
  const probe: MiscItem = { id: "__probe__", type: "", x: 0, y: 0, w: Math.min(w, cols), h };
  const maxY = items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x + probe.w <= cols; x += 1) {
      probe.x = x;
      probe.y = y;
      if (!items.some((i) => collides(i, probe))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

/** 新增条目：放进第一个空位，返回新布局（已压实）。 */
export function placeNewItem(items: MiscItem[], item: Omit<MiscItem, "x" | "y">, cols = MISC_COLS): MiscItem[] {
  const w = Math.min(item.w, cols);
  const { x, y } = findFreeSlot(items, w, item.h, cols);
  return compactLayout([...items, { ...item, w, x, y }], cols);
}

/** 移除条目并压实。 */
export function removeItem(items: MiscItem[], id: string, cols = MISC_COLS): MiscItem[] {
  return compactLayout(
    items.filter((i) => i.id !== id),
    cols
  );
}

/**
 * 校验持久化布局：剔除坏条目（缺 id / type、尺寸非法），按 id 去重，越界钳回，
 * 重叠的后来者往下推，最后压实。任何来源（磁贴 config、跨窗口同步）都先过这里。
 */
export function sanitizeMiscItems(raw: unknown, cols = MISC_COLS): MiscItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MiscItem[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || typeof o.type !== "string" || !o.type || seen.has(o.id)) continue;
    const num = (k: string, d: number) =>
      typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : d;
    const w = clampInt(num("w", 1), 1, cols);
    const h = clampInt(num("h", 1), 1, MISC_MAX_H);
    const item: MiscItem = {
      id: o.id,
      type: o.type,
      w,
      h,
      x: clampInt(num("x", 0), 0, cols - w),
      y: Math.max(0, Math.round(num("y", 0)))
    };
    // 与已收下的条目重叠 → 往下推到不重叠为止（保留先来者的位置）。
    while (out.some((p) => collides(p, item))) item.y += 1;
    out.push(item);
    seen.add(item.id);
  }
  return compactLayout(out, cols);
}

/** 新条目 id。 */
export function newMiscItemId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m-${Math.random().toString(36).slice(2, 10)}`;
}
