/**
 * 迷你趋势曲线（共享组件）：Catmull-Rom → 三次贝塞尔平滑折线。
 * 派生自 HardwareWidget 的 Sparkline（W-142 起被系统监控 / 系统栏复用）。
 *
 * @param data    历史样本（0–max），通常由 ref 数组按广播帧 append。
 * @param color   描边色（CSS 变量或字面量）。
 * @param max     纵轴满量程（百分比类指标为 100）。
 * @param span    横轴样本容量（决定 x 归一化；与调用方 slice 长度一致）。
 * @param peak    W-150 峰值标记：在曲线峰值高度画一条水平虚线。
 */
export function Sparkline({
  data,
  color,
  max = 100,
  span,
  peak = false
}: {
  data: number[];
  color: string;
  max?: number;
  span?: number;
  peak?: boolean;
}) {
  const n = Math.max(2, span ?? data.length);
  const pts = data.map((v, i) => ({
    x: (i / (n - 1)) * 100,
    y: 100 - (Math.min(v, max) / max) * 100
  }));
  let d = "";
  if (pts.length === 1) {
    d = `M ${pts[0].x},${pts[0].y}`;
  } else {
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      if (i === 0) d += `M ${p1.x.toFixed(2)},${p1.y.toFixed(2)} `;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += `C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)} `;
    }
  }
  const peakVal = data.length ? Math.max(...data) : 0;
  const peakY = 100 - (Math.min(peakVal, max) / max) * 100;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="hw-spark" aria-hidden="true">
      {peak && data.length > 1 && peakVal > 0 && (
        <line
          x1="0"
          y1={peakY}
          x2="100"
          y2={peakY}
          stroke={color}
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
