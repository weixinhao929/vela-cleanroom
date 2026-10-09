/**
 * 拖拽智能对齐（纯函数，卡片/编组容器共用）：被拖矩形与候选矩形的三线
 * （左/中/右、上/中/下）互吸，取最小偏差；候选全不在线上时退到视口零线
 * （贴边吸附）。返回吸附后的左上角与应当亮出的参考线（画布坐标）。
 *
 * 从 WidgetCard.onDragMove 的内联循环提取（组对等）：组拖拽接入同一
 * 套吸附数学——同一画布上卡片与组的拖拽语言一致（磁吸 + 参考线），候选
 * 集由调用方决定（卡片=非本拖拽组的实例；组=实例∪其它组）。
 */

export type AlignRect = { x: number; y: number; w: number; h: number };

/** 对齐吸附阈值（px）：拖拽中的边/中线与目标线距离小于该值时吸附
 *  （卡片/组共用同一阈值，原 WidgetCard 内联常量收敛于此）。 */
export const ALIGN_THRESHOLD_PX = 8;

export function computeAlignAdjust(
  nx: number,
  ny: number,
  w: number,
  h: number,
  others: ReadonlyArray<AlignRect>,
  threshold: number
): { x: number; y: number; guideXs: number[]; guideYs: number[] } {
  const myXs = [nx, nx + w / 2, nx + w];
  const myYs = [ny, ny + h / 2, ny + h];
  let bestX: { delta: number; line: number } | null = null;
  let bestY: { delta: number; line: number } | null = null;
  for (const o of others) {
    for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) {
      for (const mx of myXs) {
        const diff = ox - mx;
        if (Math.abs(diff) <= threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.delta))) {
          bestX = { delta: diff, line: ox };
        }
      }
    }
    for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) {
      for (const my of myYs) {
        const diff = oy - my;
        if (Math.abs(diff) <= threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.delta))) {
          bestY = { delta: diff, line: oy };
        }
      }
    }
  }
  // 视口零线：候选都不在线上且已贴近左/上边缘时贴边（与卡片拖拽既有行为一致）。
  if (!bestX && nx <= threshold) bestX = { delta: -nx, line: 0 };
  if (!bestY && ny <= threshold) bestY = { delta: -ny, line: 0 };
  const guideXs: number[] = [];
  const guideYs: number[] = [];
  if (bestX) {
    nx += bestX.delta;
    guideXs.push(bestX.line);
  }
  if (bestY) {
    ny += bestY.delta;
    guideYs.push(bestY.line);
  }
  return { x: nx, y: ny, guideXs, guideYs };
}
