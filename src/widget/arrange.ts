/**
 * 批量自动排布（BentoDesk 借鉴 #8）：把多选卡片重排成网格 / 横排 / 纵列。
 *
 * - 排布区域取成员**包围盒**——用户在哪块排就在哪块排，不跳屏；
 * - 行/列 track 布局：区域放得下时等间隙均匀铺满；放不下时退化为等宽
 *   「槽位」（每卡在自己的槽内居中，宁可轻微重叠也不出包围盒——
 *   BentoDesk「放不下→等中心距重叠」降级的同款语义）；
 * - 网格：列数 ⌈√n⌉、行数 ⌈n/列⌉，格子按包围盒等分、卡片在格内居中，
 *   扫描序（y 后 x）保持就近移动；
 * - 结果逐卡 clamp 到视口（与 widget-store.clampAxis 同语义：至少留
 *   40px 抓边在视口内）。
 *
 * 纯函数；store 动作 arrangeSelected 在 widget-store.ts。
 */

/** 至少留在视口内的可抓边宽度（clampAxis 同款）。 */
const KEEP_PX = 40;

export type ArrangeMode = "grid" | "row" | "column";

export type ArrangeRect = { id: string; x: number; y: number; w: number; h: number };

function clampToViewport(x: number, y: number, vp: { w: number; h: number }): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, vp.w - KEEP_PX)),
    y: Math.min(Math.max(0, y), Math.max(0, vp.h - KEEP_PX))
  };
}

/**
 * 计算排布结果（纯函数）。返回 id → 新左上角；成员不足 2 个返回空 Map
 * （与对齐动作同门槛）。
 */
export function computeArrangement(
  members: ArrangeRect[],
  mode: ArrangeMode,
  viewport: { w: number; h: number }
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (members.length < 2) return out;
  const bx = Math.min(...members.map((m) => m.x));
  const by = Math.min(...members.map((m) => m.y));
  const bw = Math.max(...members.map((m) => m.x + m.w)) - bx;
  const bh = Math.max(...members.map((m) => m.y + m.h)) - by;

  const place = (id: string, cx: number, cy: number, w: number, h: number) => {
    const p = clampToViewport(Math.round(cx - w / 2), Math.round(cy - h / 2), viewport);
    out.set(id, p);
  };

  if (mode === "row" || mode === "column") {
    const horizontal = mode === "row";
    const sorted = [...members].sort((a, b) =>
      horizontal ? a.x + a.w / 2 - (b.x + b.w / 2) : a.y + a.h / 2 - (b.y + b.h / 2)
    );
    const span = horizontal ? bw : bh;
    const sizes = sorted.map((m) => (horizontal ? m.w : m.h));
    const sum = sizes.reduce((s, v) => s + v, 0);
    const cross = horizontal ? by + bh / 2 : bx + bw / 2; // 非排布轴：包围盒中线
    if (sum <= span && sorted.length > 1) {
      // 放得下：等间隙铺满（首卡贴起点，尾卡贴终点）。
      const gap = (span - sum) / (sorted.length - 1);
      let cursor = horizontal ? bx : by;
      for (const m of sorted) {
        const size = horizontal ? m.w : m.h;
        if (horizontal) place(m.id, cursor + size / 2, cross, m.w, m.h);
        else place(m.id, cross, cursor + size / 2, m.w, m.h);
        cursor += size + gap;
      }
      return out;
    }
    // 放不下：等宽槽位，每卡槽内居中（允许相邻轻微重叠，不出包围盒）。
    const slot = span / sorted.length;
    sorted.forEach((m, i) => {
      const c = (i + 0.5) * slot + (horizontal ? bx : by);
      if (horizontal) place(m.id, c, cross, m.w, m.h);
      else place(m.id, cross, c, m.w, m.h);
    });
    return out;
  }

  // 网格：扫描序（y 后 x）就近入格。
  const cols = Math.ceil(Math.sqrt(members.length));
  const rows = Math.ceil(members.length / cols);
  const cw = bw / cols;
  const ch = bh / rows;
  const sorted = [...members].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x + a.w / 2 - (b.x + b.w / 2));
  sorted.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    place(m.id, bx + (col + 0.5) * cw, by + (row + 0.5) * ch, m.w, m.h);
  });
  return out;
}
