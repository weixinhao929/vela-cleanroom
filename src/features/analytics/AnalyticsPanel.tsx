/**
 * 专注统计面板：今日/本周/累计指标卡、趋势图、月热图、时长分布、打断
 * 归因与目标连续天数；数据经 domain/analytics 纯函数聚合（memo 化），
 * SQLite 全量口径（FromAgg 系列）突破内存截断。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  Flame,
  PieChart,
  Target,
  TrendingUp
} from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { Panel } from "../../components/ui/Panel";
import {
  cumulativeStats,
  cumulativeStatsFromAgg,
  dailyTrend,
  dayHourGrid,
  goalStreakDays,
  goalStreakDaysFromAgg,
  hourlyFocusDistribution,
  monthCalendarGrid,
  monthTotalFromAgg,
  monthlyHeatmap,
  monthlyHeatmapFromAgg,
  monthlyInterruptionBreakdown,
  monthFocusCount,
  monthFocusMinutes,
  isSameDay,
  splitSessionsByDay,
  taskFocusBreakdown,
  todayGiveUpCount,
  todayInterruptions,
  weekStats,
  weekStatsFromAgg,
  yearGrid,
  yearGridFromAgg,
  type DayHourGrid,
  type FocusAggregate,
  type HeatCell,
  type HourlyFocusBucket,
  type YearWeekGrid
} from "../../domain/analytics";
import { isTauri } from "../../lib/tauri";
import { sqliteRepo } from "../../lib/persistence/sqlite";
import { useCountUp } from "../../lib/anim";
import { useAppStore } from "../../store/app-store";
import { useSettingsStore } from "../../store/settings-store";
import { useWidgetConfig } from "../../widget/widget-config";
import { useAppLocale, useT } from "../../i18n-lite";
import { dayKeyOf, dayKeyToDate, useNow } from "../../lib/use-now";

const HEAT_COLORS = ["var(--track)", "var(--accent-2)", "var(--accent)", "var(--ink)"];

/** E4（i18n）：星期标签按应用内语言经 Intl 生成（周日开头，与月历网格一致）。 */
function buildWeekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
  // 2023-10-01 是周日：以它为锚生成 周日..周六 七个标签。
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 9, 1 + i)));
}

/**
 * 主色锚定浓淡坡（圆头环配色）：占比最大的首档用 accent-2 主导的冷色，
 * 与后续 accent 暖蓝档形成冷暖对比；往后逐档变淡、与整体配色同源。
 * 混合底用 --paper-opaque（不透明），保证在玻璃面板上不透底。
 */
const PIE_TINTS = [72, 58, 46, 36, 27, 20];
function sliceColor(i: number): string {
  if (i === 0) return "color-mix(in srgb, var(--accent-2) 78%, var(--accent))";
  const cycle = Math.floor((i - 1) / PIE_TINTS.length);
  const tint = Math.max(9, PIE_TINTS[(i - 1) % PIE_TINTS.length] - cycle * 5);
  // --paper-opaque 缺 fallback 时整条 color-mix 非法 → 扇区透明，回退 --bg。
  return `color-mix(in srgb, var(--accent) ${tint}%, var(--paper-opaque, var(--bg)))`;
}

function fmtDur(minutes: number, tr: (s: string) => string): string {
  if (minutes < 60) return `${minutes}${tr("分")}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  // 对照参考稿："75小时24分"；en 走 "75 h 24 m"。
  return m ? `${h}${tr("小时")}${m}${tr("分")}` : `${h}${tr("小时")}`;
}

function heatLevel(minutes: number): number {
  if (minutes <= 0) return 0;
  if (minutes < 30) return 1;
  if (minutes < 60) return 2;
  return 3;
}

interface PieSliceGeom {
  key: string;
  label: string;
  minutes: number;
  frac: number;
  a0: number; // 起始角（自顶部顺时针，弧度）
  a1: number;
  mid: number;
}

const f2 = (n: number): number => Math.round(n * 100) / 100;

/** 圆心 (50,50)，极坐标转直角坐标（SVG y 向下，角度顺时针增长）。 */
function piePt(r: number, a: number): [number, number] {
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
}

/**
 * 环形占比图（克制的数据环，端头只带小圆角）：
 *  - 每片为填充式环形扇区，四个直角以小圆角（PIE_RAD ≈ 带厚的 1/5）平滑
 *    ——端头「圆一点点」而非半圆鼓包；片间 0.8° 细缝，无描边无黑边；
 *  - 悬浮片沿中点角外扩、其余片压淡；图例联动同一状态；
 *  - 中心为「联动信息窗」：默认展示 总计 / 日均，悬浮任一事件即切换成
 *    该事件的 名称 / 时长 / 占比；
 *  - 时长标注走外侧折线引导线（大扇区名称内嵌环带），
 *    小扇区在左右两列自上而下堆叠；标签层 pointer-events:none。
 */
const PIE_R = 40; // 外半径
const PIE_r = 26; // 内半径
const PIE_MID = (PIE_R + PIE_r) / 2; // 环带中径（内嵌名称基线）
const PIE_PAD = (Math.PI / 180) * 0.8; // 片间细缝：每侧 0.8°
const PIE_RAD = 3; // 角圆角半径
/** 环形扇区路径，四角带 PIE_RAD 圆角；a0/a1 已含 pad。 */
function roundedAnnularPath(a0: number, a1: number): string {
  const dR = PIE_RAD / PIE_R; // 外弧上的圆角退角
  const dr = PIE_RAD / PIE_r; // 内弧上的圆角退角
  const [ox0, oy0] = piePt(PIE_R, a0 + dR);
  const [ox1, oy1] = piePt(PIE_R, a1 - dR);
  const [ix1, iy1] = piePt(PIE_r, a1 - dr);
  const [ix0, iy0] = piePt(PIE_r, a0 + dr);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  // 四个角点与各自的圆角终点（沿邻边退 PIE_RAD）。
  const [kO1x, kO1y] = piePt(PIE_R, a1);
  const [tO1x, tO1y] = piePt(PIE_R - PIE_RAD, a1);
  const [kI1x, kI1y] = piePt(PIE_r, a1);
  const [tI1x, tI1y] = piePt(PIE_r + PIE_RAD, a1);
  const [kI0x, kI0y] = piePt(PIE_r, a0);
  const [tI0x, tI0y] = piePt(PIE_r + PIE_RAD, a0);
  const [kO0x, kO0y] = piePt(PIE_R, a0);
  const [tO0x, tO0y] = piePt(PIE_R - PIE_RAD, a0);
  return [
    `M ${f2(ox0)} ${f2(oy0)}`,
    `A ${PIE_R} ${PIE_R} 0 ${large} 1 ${f2(ox1)} ${f2(oy1)}`,
    `Q ${f2(kO1x)} ${f2(kO1y)} ${f2(tO1x)} ${f2(tO1y)}`,
    `L ${f2(tI1x)} ${f2(tI1y)}`,
    `Q ${f2(kI1x)} ${f2(kI1y)} ${f2(ix1)} ${f2(iy1)}`,
    `A ${PIE_r} ${PIE_r} 0 ${large} 0 ${f2(ix0)} ${f2(iy0)}`,
    `Q ${f2(kI0x)} ${f2(kI0y)} ${f2(tI0x)} ${f2(tI0y)}`,
    `L ${f2(tO0x)} ${f2(tO0y)}`,
    `Q ${f2(kO0x)} ${f2(kO0y)} ${f2(ox0)} ${f2(oy0)}`,
    "Z"
  ].join(" ");
}

function clampLabel(s: string): string {
  return s.length > 9 ? `${s.slice(0, 9)}…` : s;
}

/** 无圆角环形扇区（极小片退化用：空间装不下四个圆角时）。 */
function annularPath(a0: number, a1: number): string {
  const [ox0, oy0] = piePt(PIE_R, a0);
  const [ox1, oy1] = piePt(PIE_R, a1);
  const [ix1, iy1] = piePt(PIE_r, a1);
  const [ix0, iy0] = piePt(PIE_r, a0);
  const largeArc = a1 - a0 > Math.PI ? 1 : 0;
  return [
    `M ${f2(ox0)} ${f2(oy0)}`,
    `A ${PIE_R} ${PIE_R} 0 ${largeArc} 1 ${f2(ox1)} ${f2(oy1)}`,
    `L ${f2(ix1)} ${f2(iy1)}`,
    `A ${PIE_r} ${PIE_r} 0 ${largeArc} 0 ${f2(ix0)} ${f2(iy0)}`,
    "Z"
  ].join(" ");
}

function TaskPie({
  data,
  hover,
  onHover,
  dailyAvg
}: {
  data: { key: string; label: string; minutes: number }[];
  hover: number | null;
  onHover: (i: number | null) => void;
  dailyAvg: string;
}) {
  const tr = useT();
  const total = data.reduce((acc, d) => acc + d.minutes, 0);
  if (!(total > 0)) return null;

  /* 第一遍：几何计算 */
  let accAngle = 0;
  const slices: PieSliceGeom[] = data.map((d) => {
    const frac = d.minutes / total;
    const a0 = -Math.PI / 2 + accAngle * Math.PI * 2;
    accAngle += frac;
    const a1 = -Math.PI / 2 + accAngle * Math.PI * 2;
    return { ...d, frac, a0, a1, mid: (a0 + a1) / 2 };
  });

  /* 第二遍：引导线标签（大扇区名称入环带，小扇区两侧堆叠） */
  const labels: React.ReactNode[] = [];
  let stackLeftY = 0;
  let stackRightY = 0;
  slices.forEach((s, i) => {
    const dirX = Math.cos(s.mid);
    const dirY = Math.sin(s.mid);
    const sideRight = dirX >= 0;
    const [sx, sy] = piePt(PIE_R + 2, s.mid);

    if (s.frac >= 0.07) {
      // 名称内嵌于环带中径；时长在外侧：径向段 + 水平段折线。
      const [nx, ny] = piePt(PIE_MID, s.mid);
      const ex = sx + dirX * 5;
      const ey = sy + dirY * 5;
      const tx = ex + (sideRight ? 4 : -4);
      labels.push(
        <text
          key={`n${i}`}
          className="pie-label-inner"
          x={f2(nx)}
          y={f2(ny)}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {s.label}
        </text>,
        <polyline
          key={`l${i}`}
          className="pie-leader"
          points={`${f2(sx)},${f2(sy)} ${f2(ex)},${f2(ey)} ${f2(tx)},${f2(ey)}`}
        />,
        <text
          key={`t${i}`}
          className="pie-label"
          x={f2(tx + (sideRight ? 1.5 : -1.5))}
          y={f2(ey + 1.8)}
          textAnchor={sideRight ? "start" : "end"}
        >
          {fmtDur(s.minutes, tr)}
        </text>
      );
    } else if (s.frac >= 0.02) {
      // 中扇区：仅外侧时长引导线。
      const ex = sx + dirX * 5;
      const ey = sy + dirY * 5;
      const tx = ex + (sideRight ? 4 : -4);
      labels.push(
        <polyline
          key={`l${i}`}
          className="pie-leader"
          points={`${f2(sx)},${f2(sy)} ${f2(ex)},${f2(ey)} ${f2(tx)},${f2(ey)}`}
        />,
        <text
          key={`t${i}`}
          className="pie-label"
          x={f2(tx + (sideRight ? 1.5 : -1.5))}
          y={f2(ey + 1.8)}
          textAnchor={sideRight ? "start" : "end"}
        >
          {fmtDur(s.minutes, tr)}
        </text>
      );
    } else {
      // 小扇区：堆叠标签（左半圆进左列、右半圆进右列），上限每侧 12 条。
      if (sideRight && stackRightY < 12) {
        const ly = -2 + stackRightY * 9;
        stackRightY += 1;
        labels.push(
          <polyline
            key={`l${i}`}
            className="pie-leader"
            points={`118,${f2(ly + 1.8)} ${f2((118 + sx) / 2)},${f2(ly + 1.8)} ${f2(sx)},${f2(sy)}`}
          />,
          <text key={`t${i}`} className="pie-label" x={122} y={f2(ly + 3)}>
            {fmtDur(s.minutes, tr)}
          </text>
        );
      } else if (!sideRight && stackLeftY < 12) {
        const ly = -2 + stackLeftY * 9;
        stackLeftY += 1;
        labels.push(
          <polyline
            key={`l${i}`}
            className="pie-leader"
            points={`-18,${f2(ly + 1.8)} ${f2((-18 + sx) / 2)},${f2(ly + 1.8)} ${f2(sx)},${f2(sy)}`}
          />,
          <text key={`t${i}`} className="pie-label" x={-22} y={f2(ly + 3)} textAnchor="end">
            {fmtDur(s.minutes, tr)}
          </text>
        );
      }
    }
  });

  /* 中心信息窗：默认总计 / 日均；悬浮时切换为该事件详情。 */
  const hov = hover !== null ? slices[hover] : null;
  const center =
    hov && hover !== null ? (
      <>
        <text className="pie-center-cap" x={50} y={43.5} textAnchor="middle">
          {clampLabel(hov.label)}
        </text>
        <text className="pie-center-value" x={50} y={51.5} textAnchor="middle">
          {fmtDur(hov.minutes, tr)}
        </text>
        <text className="pie-center-sub" x={50} y={59} textAnchor="middle">
          {(Math.round(hov.frac * 1000) / 10).toFixed(1)}%
        </text>
      </>
    ) : (
      <>
        <text className="pie-center-cap" x={50} y={43.5} textAnchor="middle">
          {tr("总计")}
        </text>
        <text className="pie-center-value" x={50} y={51.5} textAnchor="middle">
          {fmtDur(total, tr)}
        </text>
        <text className="pie-center-sub" x={50} y={59} textAnchor="middle">
          {tr("日均")} {dailyAvg}
        </text>
      </>
    );

  return (
    <svg viewBox="-58 -6 216 112" className="pie-svg">
      {slices.map((s, i) => {
        const span = s.a1 - s.a0;
        const active = hover === i;
        const dx = Math.cos(s.mid) * 2.5;
        const dy = Math.sin(s.mid) * 2.5;
        // 极小片（< 约 15°）装不下四个圆角，退化为无圆角小楔形（仍留缝）。
        const d =
          span > 2 * (PIE_RAD / PIE_r) + 2 * PIE_PAD + 0.02
            ? roundedAnnularPath(s.a0 + PIE_PAD, s.a1 - PIE_PAD)
            : annularPath(s.a0 + PIE_PAD, s.a1 - PIE_PAD);
        return (
          <path
            key={s.key}
            d={d}
            fill={sliceColor(i)}
            className="pie-slice"
            style={{
              opacity: hover === null || active ? 1 : 0.35,
              transform: active ? `translate(${f2(dx)}px, ${f2(dy)}px)` : undefined,
              transformOrigin: "50px 50px"
            }}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
          />
        );
      })}
      {/* 引导线与文字不响应指针，避免遮挡扇区 hover。 */}
      <g pointerEvents="none">{labels}</g>
      {/* 中心联动信息：key 随内容重建，触发轻量缩放淡入。 */}
      <g pointerEvents="none" key={hover === null ? "total" : `h${hover}`} className="pie-center">
        {center}
      </g>
    </svg>
  );
}

/* ── 数值滚动叶子组件：rAF 补间（lib/anim useCountUp，与 FxCount / HabitWidget
      同一实现）被隔离在最小子树内，补间期间父面板不重渲；memo 短路无关更新。 ── */

/** 整数滚动（次数 / 轮数 / 天数）。 */
const AnimatedStat = memo(function AnimatedStat({ value }: { value: number }) {
  const n = useCountUp(value, { duration: 650 });
  return <>{n}</>;
});

/** 时长滚动：补间原始分钟数，逐帧走 fmtDur 格式化。 */
const AnimatedDuration = memo(function AnimatedDuration({ minutes }: { minutes: number }) {
  const tr = useT();
  const n = Number(useCountUp(minutes, { duration: 750 }));
  return <>{fmtDur(n, tr)}</>;
});

/* 统一区块标题：图标章 + 标题 + 弹性发丝线。 */
function SectionHead({ icon, title, extra }: { icon: React.ReactNode; title: string; extra?: React.ReactNode }) {
  return (
    <div className="analytics-head">
      <span className="analytics-head-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      <span className="analytics-head-line" aria-hidden="true" />
      {extra}
    </div>
  );
}

/** 指标瓦片：图标章 + 标签 + 大数字（可滚动）+ 单位/副行。C3：memo 隔离。 */
const MetricTile = memo(function MetricTile({
  icon,
  label,
  value,
  unit,
  sub,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  unit?: string;
  sub?: React.ReactNode;
  tone?: "streak" | "giveup";
}) {
  return (
    <div className={`metric-tile${tone ? ` tone-${tone}` : ""}`}>
      <div className="metric-tile-top">
        <span className="metric-tile-icon">{icon}</span>
        <span className="metric-tile-label">{label}</span>
      </div>
      <strong className="metric-tile-value">
        {value}
        {unit && <em>{unit}</em>}
      </strong>
      {sub != null && <span className="metric-tile-sub">{sub}</span>}
    </div>
  );
});

interface HeatTip {
  x: number;
  y: number;
  date: string;
  minutes: number;
}

/** Portal-rendered tooltip for heatmap cells (avoids clipping by overflow). */
function HeatTooltip({ tip }: { tip: HeatTip | null }) {
  const tr = useT();
  if (!tip) return null;
  return createPortal(
    <div className="heat-tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      <strong>{tip.date}</strong>
      <span>{tip.minutes > 0 ? `${tip.minutes} ${tr("分钟")}` : tr("无专注")}</span>
    </div>,
    document.body
  );
}

/** A single heatmap cell with a hover tooltip showing the day's focus time.
 *  C3：memo 化——此前面板任何状态变化都会让月/年热力图数百个格子全量重渲。
 *  键盘可达：Tab 聚焦同样出 tooltip（aria-label 带数值）；
 *  rect 在 mouseenter/focus 时测一次并缓存，mousemove 不再逐帧 getBoundingClientRect。 */
const HeatCellView = memo(function HeatCellView({
  cell,
  onTip
}: {
  cell: HeatCell;
  onTip: (t: HeatTip | null) => void;
}) {
  const tr = useT();
  const level = heatLevel(cell.focusMinutes);
  const rectRef = useRef<DOMRect | null>(null);
  const measure = (e: React.SyntheticEvent) => {
    rectRef.current = (e.currentTarget as HTMLElement).getBoundingClientRect();
  };
  const emit = () => {
    const r = rectRef.current;
    if (r) onTip({ x: r.left + r.width / 2, y: r.top, date: cell.date, minutes: cell.focusMinutes });
  };
  const leave = () => {
    rectRef.current = null;
    onTip(null);
  };
  return (
    <span
      className={`heat-cell${level > 0 ? ` lvl-${level}` : ""}${cell.isToday ? " today" : ""}`}
      style={level > 0 ? { background: HEAT_COLORS[level] } : undefined}
      tabIndex={0}
      aria-label={`${cell.date} · ${cell.focusMinutes} ${tr("分钟")}`}
      onMouseEnter={(e) => {
        measure(e);
        emit();
      }}
      onMouseMove={emit}
      onMouseLeave={leave}
      onFocus={(e) => {
        measure(e);
        emit();
      }}
      onBlur={leave}
    />
  );
});

/** Month heatmap laid out like a calendar: weekday labels on top, dates flow down by week. */
const MonthHeatmap = memo(function MonthHeatmap({
  cells,
  year,
  month,
  weekdayLabels
}: {
  cells: HeatCell[];
  year: number;
  month: number;
  weekdayLabels: string[];
}) {
  const [tip, setTip] = useState<HeatTip | null>(null);
  /* C3：网格布局只在输入变化时重算（此前 tip 每动一格整图重算）。 */
  const grid = useMemo(() => monthCalendarGrid(year, month, cells), [year, month, cells]);
  return (
    <div className="month-heatmap">
      <div className="month-heatmap-grid">
        {weekdayLabels.map((w) => (
          <span key={w} className="heat-weekday">
            {w}
          </span>
        ))}
        {grid.map((row, ri) =>
          row.map((cell, ci) =>
            cell ? (
              <HeatCellView key={cell.date} cell={cell} onTip={setTip} />
            ) : (
              <span key={`e-${ri}-${ci}`} className="heat-cell void" />
            )
          )
        )}
      </div>
      <HeatTooltip tip={tip} />
    </div>
  );
});

/** GitHub-style yearly contribution graph: 7 weekday rows × week columns, horizontal scroll. */
const YearHeatmap = memo(function YearHeatmap({
  grid,
  year,
  onYearChange,
  weekdayLabels
}: {
  grid: YearWeekGrid;
  year: number;
  onYearChange: (y: number) => void;
  weekdayLabels: string[];
}) {
  const tr = useT();
  const [tip, setTip] = useState<HeatTip | null>(null);
  const { weeks, monthLabels, totalWeeks } = grid;
  return (
    <div className="year-heatmap">
      <div className="year-heatmap-scroll">
        <div className="year-heatmap-inner">
          <div className="year-month-labels" style={{ width: totalWeeks * 14 - 3 }}>
            {monthLabels.map((ml) => (
              <span
                key={ml.label}
                className="year-month-label"
                style={{ left: ml.startWeek * 14, width: ml.span * 14 - 3 }}
              >
                {ml.label}
              </span>
            ))}
          </div>
          <div className="year-grid-row">
            <div className="year-weekday-labels">
              {weekdayLabels.map((w) => (
                <span key={w} className="heat-weekday">
                  {w}
                </span>
              ))}
            </div>
            <div className="year-cells" style={{ gridTemplateColumns: `repeat(${totalWeeks}, 11px)` }}>
              {Array.from({ length: 7 }, (_, di) =>
                Array.from({ length: totalWeeks }, (_, wi) => {
                  const cell = weeks[di][wi];
                  if (!cell) return <span key={`e-${di}-${wi}`} className="heat-cell void" />;
                  return <HeatCellView key={cell.date} cell={cell} onTip={setTip} />;
                })
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="year-heatmap-side">
        <button className="year-nav" onClick={() => onYearChange(year - 1)} aria-label={tr("上一年")}>
          <ChevronLeft size={14} />
        </button>
        <span className="year-value">{year}</span>
        <button className="year-nav" onClick={() => onYearChange(year + 1)} aria-label={tr("下一年")}>
          <ChevronRight size={14} />
        </button>
      </div>
      <HeatTooltip tip={tip} />
    </div>
  );
});

/** 近 N 天专注趋势：渐变圆角柱 + 悬停数值气泡（纯 CSS ::after，无 JS 状态）+ 今日高亮。
 *  键盘可达：柱格可聚焦，:focus-visible 复用同一气泡展示数值。 */
const DailyBars = memo(function DailyBars({ data }: { data: ReturnType<typeof dailyTrend> }) {
  const tr = useT();
  const max = Math.max(...data.map((d) => d.focusMinutes), 1);
  const lastIndex = data.length - 1;
  return (
    <div className="daily-bars">
      {data.map((d, i) => (
        <div
          className={`daily-bar-col${i === lastIndex ? " today" : ""}`}
          key={d.date}
          data-tip={`${d.date} · ${d.focusMinutes} ${tr("分钟")}`}
          tabIndex={0}
          aria-label={`${d.date} · ${d.focusMinutes} ${tr("分钟")}`}
        >
          <div className="daily-bar-track">
            <div
              className={`daily-bar-fill${d.focusMinutes === 0 ? " empty" : ""}`}
              style={{ transform: `scaleY(${Math.max(0.03, d.focusMinutes / max).toFixed(4)})` }}
            />
          </div>
          <span className="daily-bar-label">{d.label}</span>
        </div>
      ))}
    </div>
  );
});

/** FocusTimer 借鉴（#13 时段分布图）：近 N 天 × 24 小时气泡矩阵（参考其
 *  月页 BubbleChart：半径 ∝ sqrt(值/最大值) 分 4 级量化、空值画 10% 基圆、
 *  hover 提亮）。行 = 天（今日行高亮），列 = 小时（0/6/12/18 刻度），
 *  一眼看出黄金专注时段与「下午三点必崩」。格尺寸由 CSS --hb-cell 控制。 */
const HB_DIAMETERS = (() => {
  const base = 5; // 空值基圆直径
  const maxD = 14; // 满值直径
  return Array.from({ length: 5 }, (_, i) => {
    const t = i / 4;
    return Math.round(Math.sqrt(base * base + (maxD * maxD - base * base) * t));
  });
})();

function hbLevel(minutes: number, max: number): number {
  if (minutes < 1) return 0; // < 1 分钟 = 空基圆
  return 1 + Math.min(3, Math.floor((3 * minutes) / max));
}

const HourlyBubbles = memo(function HourlyBubbles({ grid }: { grid: DayHourGrid }) {
  const tr = useT();
  const max = Math.max(1, ...grid.cells.flat());
  const ticks = grid.cells[0].map((_, h) => (h % 6 === 0 ? `${String(h).padStart(2, "0")}` : ""));
  return (
    <div className="hourly-bubbles" role="img" aria-label={tr("近 {n} 天的小时分布", { n: grid.dayKeys.length })}>
      <div className="hb-row hb-head" aria-hidden="true">
        <span className="hb-day" />
        {ticks.map((label, h) => (
          <span key={h} className={`hb-cell hb-tick${h % 6 === 0 ? " major" : ""}`}>
            {label}
          </span>
        ))}
      </div>
      {grid.cells.map((row, di) => (
        <div key={grid.dayKeys[di]} className={`hb-row${grid.isToday[di] ? " today" : ""}`}>
          <span className="hb-day">{grid.dayLabels[di]}</span>
          {row.map((minutes, h) => {
            const level = hbLevel(minutes, max);
            const d = HB_DIAMETERS[level];
            const tip = `${grid.dayLabels[di]} ${String(h).padStart(2, "0")}:00 · ${minutes} ${tr("分钟")}`;
            return (
              <span
                key={h}
                className="hb-cell"
                data-tip={minutes > 0 ? tip : undefined}
                tabIndex={minutes > 0 ? 0 : -1}
                aria-label={minutes > 0 ? tip : undefined}
              >
                <i className={`hb-bubble${minutes <= 0 ? " empty" : ""}`} style={{ width: d, height: d }} />
              </span>
            );
          })}
        </div>
      ))}
      <div className="hb-axis" aria-hidden="true">
        <span className="hb-day" />
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
      </div>
    </div>
  );
});

/** 累计小时分布（全历史）：24 根迷你柱，回答「你通常几点专注」。SQL 全量
 *  口径优先（hourly 聚合），内存回退；峰值列高亮。 */
const HourlyBars = memo(function HourlyBars({ data }: { data: HourlyFocusBucket[] }) {
  const tr = useT();
  const max = Math.max(...data.map((d) => d.focusSeconds), 1);
  const peak = data.reduce((best, d) => (d.focusSeconds > best.focusSeconds ? d : best), data[0]);
  return (
    <div className="hourly-bars">
      <div className="hourly-cells">
        {data.map((d) => (
          <div
            key={d.hour}
            className={`hourly-bar-col${d.focusSeconds > 0 && d.focusSeconds === peak.focusSeconds ? " peak" : ""}`}
            data-tip={`${String(d.hour).padStart(2, "0")}:00 · ${Math.round(d.focusSeconds / 60)} ${tr("分钟")}`}
            tabIndex={0}
            aria-label={`${String(d.hour).padStart(2, "0")}:00 · ${Math.round(d.focusSeconds / 60)} ${tr("分钟")}`}
          >
            <div className="hourly-bar-track">
              <div
                className={`hourly-bar-fill${d.focusSeconds === 0 ? " empty" : ""}`}
                style={{ transform: `scaleY(${Math.max(0.03, d.focusSeconds / max).toFixed(4)})` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="hourly-axis" aria-hidden="true">
        {[0, 6, 12, 18].map((h) => (
          <span key={h}>{`${String(h).padStart(2, "0")}:00`}</span>
        ))}
      </div>
    </div>
  );
});

/* C3：饼图 + 图例联动抽成自包含区块——distHover 状态下沉到这里，
   hover 图例/扇区不再重渲整个面板（热力图/stat 卡/趋势图全部隔离）。 */
function DistSection({
  distribution,
  dailyAvgLabel
}: {
  distribution: { key: string; label: string; minutes: number }[];
  dailyAvgLabel: string;
}) {
  const tr = useT();
  const [distHover, setDistHover] = useState<number | null>(null);
  const total = distribution.reduce((acc, d) => acc + d.minutes, 0);
  if (distribution.length === 0) {
    return <EmptyState text={tr("暂无数据")} hint={tr("完成一次专注后自动生成。")} />;
  }
  return (
    <div className="dist-wrap">
      {/* 总计 / 日均移入环形图中心（悬浮联动切换），不再单占一行。 */}
      <TaskPie data={distribution} hover={distHover} onHover={setDistHover} dailyAvg={dailyAvgLabel} />
      <div className="dist-list">
        {distribution.map((d, i) => (
          <div
            className={`dist-item${distHover === i ? " is-hover" : ""}`}
            key={d.key}
            onMouseEnter={() => setDistHover(i)}
            onMouseLeave={() => setDistHover(null)}
          >
            <span className="dist-color" style={{ background: sliceColor(i) }} />
            <span className="dist-name" title={d.label}>
              {d.label}
            </span>
            <span className="dist-dur">{fmtDur(d.minutes, tr)}</span>
            <span className="dist-pct">{(Math.round((d.minutes / total) * 1000) / 10).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** W-051 任务用时归集：饼图 + 图例已完整呈现各事件时长，排行条区块移除以精简版面。 */

export function AnalyticsPanel({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const nowTick = useNow();
  /* C2（E-dayKey）：六个重型 useMemo 此前依赖每 30s 翻新的 nowTick——
     数据没变也会整面板重算全年热力图。这些统计全部只关心「日期边界」，
     统一归约成天粒度依赖；跨零点由 todayKey 变化触发，语义不变。 */
  const todayKey = dayKeyOf(nowTick);
  const today = useMemo(() => dayKeyToDate(todayKey) ?? new Date(), [todayKey]);
  const locale = useAppLocale();
  const weekdayLabels = useMemo(() => buildWeekdayLabels(locale), [locale]);
  const sessions = useAppStore((s) => s.sessions);
  const interruptions = useAppStore((s) => s.interruptions);
  const tasks = useAppStore((s) => s.tasks);
  const dailyGoalSessions = useAppStore((s) => s.pomodoroConfig.dailyGoalSessions);
  const dailyGoalMode = useAppStore((s) => s.pomodoroConfig.dailyGoalMode ?? "sessions");
  const dailyGoalMinutes = useAppStore((s) => s.pomodoroConfig.dailyGoalMinutes ?? 0);
  const { config } = useWidgetConfig(instanceId);
  const trendDays = (config.days as number) || 7;
  const showMonthHeatmap = config.showMonthHeatmap !== false;
  const analyticsStartDate = useSettingsStore((s) => s.extra.analyticsStartDate);
  // FocusTimer 借鉴：虚拟午夜口径（0/2/4）——SQL 聚合与内存切分共用此值。
  const vmHour = useSettingsStore((s) => s.extra.virtualMidnightHour ?? 0);
  const [heatTab, setHeatTab] = useState<"month" | "year">("month");
  /* 月/年切换：先 120ms 淡出旧视图再换挂载（新视图以 an-rise-in 入场），
     避免此前瞬切生硬。卸载/重选时清理定时器。 */
  const [heatShown, setHeatShown] = useState<"month" | "year">("month");
  const [tabFading, setTabFading] = useState(false);
  const tabTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(tabTimerRef.current), []);
  const pickHeatTab = (t: "month" | "year") => {
    setHeatTab(t);
    if (t === heatShown) return;
    window.clearTimeout(tabTimerRef.current);
    setTabFading(true);
    tabTimerRef.current = window.setTimeout(() => {
      setHeatShown(t);
      setTabFading(false);
    }, 120);
  };
  const [heatYear, setHeatYear] = useState(() => new Date().getFullYear());
  const native = isTauri();
  // A-4：SQLite 全量按日聚合，累计/年度/连胜等长周期统计据此计算，突破内存
  // SESSIONS_CAP=500 的截断。加载失败（浏览器模式/首次未就绪）回退内存口径。
  const [focusAgg, setFocusAgg] = useState<FocusAggregate | null>(null);
  // 聚合刷新信号：内存 sessions 尾部新增一条（完成专注/中断补录）时重新读库。
  // 此前只在挂载时读一次，「今日次数」随内存实时 +1 而「累计/本周/热力图」
  // 停在旧快照，两个口径在组件存活期内分叉。用尾条 id 而非 length 做键：
  // SESSIONS_CAP 截断后 length 恒为 500，内容变化不再可见。
  const lastSessionId = sessions.length > 0 ? sessions[sessions.length - 1].id : "";
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    sqliteRepo
      .aggregateSessions(vmHour)
      .then((agg) => {
        if (!cancelled) setFocusAgg(agg);
      })
      .catch(() => {
        // 聚合加载失败回退内存口径（SESSIONS_CAP 截断），不让统计面板报错。
      });
    return () => {
      cancelled = true;
    };
  }, [native, lastSessionId, vmHour]);
  // FocusTimer 借鉴（#13）：24 小时分布。SQL 全量口径优先，失败回退内存。
  // SQL 口径按墙钟小时分桶、与虚拟午夜无关，故不依赖 vmHour。
  const [hourly, setHourly] = useState<HourlyFocusBucket[] | null>(null);
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    sqliteRepo
      .hourlyFocusDistribution()
      .then((rows) => {
        if (!cancelled)
          setHourly(rows.map((r) => ({ hour: r.hour, focusSeconds: r.focus_seconds, focusCount: r.focus_count })));
      })
      .catch(() => {
        // 回退内存口径
      });
    return () => {
      cancelled = true;
    };
  }, [native, lastSessionId]);
  // 内存口径统一先按虚拟午夜切分（#12），与 SQL 聚合的归日结果一致；无跨日
  // 段时 splitSessionsByDay 快路径原样返回。
  const memSessions = useMemo(() => splitSessionsByDay(sessions, vmHour), [sessions, vmHour]);
  const hourlyData = useMemo(() => hourly ?? hourlyFocusDistribution(memSessions), [hourly, memSessions]);
  // FocusTimer 月页同款气泡矩阵的数据：近 trendDays 天 × 24 小时。
  const dayGrid = useMemo(() => dayHourGrid(memSessions, today, trendDays, tr), [memSessions, today, trendDays, tr]);
  const stats = useMemo(() => {
    const now = today;
    const cum = focusAgg
      ? cumulativeStatsFromAgg(focusAgg, now, analyticsStartDate)
      : cumulativeStats(memSessions, now, analyticsStartDate);
    const todayMinutes = memSessions
      .filter(
        (s) => s.type === "focus" && !Number.isNaN(new Date(s.endedAt).getTime()) && isSameDay(new Date(s.endedAt), now)
      )
      .reduce((acc, s) => acc + Math.round(s.plannedSeconds / 60), 0);
    const month = focusAgg
      ? monthTotalFromAgg(focusAgg, now)
      : { minutes: monthFocusMinutes(memSessions, now), count: monthFocusCount(memSessions, now) };
    const goalValue = dailyGoalMode === "minutes" ? dailyGoalMinutes : dailyGoalSessions;
    return {
      cum,
      todayCount: countFocusToday(memSessions, now),
      todayMinutes,
      todayGiveUp: todayGiveUpCount(memSessions, now),
      todayInterrupt: todayInterruptions(interruptions, now),
      monthMinutes: month.minutes,
      monthCount: month.count,
      week: focusAgg ? weekStatsFromAgg(focusAgg, now) : weekStats(memSessions, now),
      streak: focusAgg
        ? goalStreakDaysFromAgg(focusAgg, goalValue, now, dailyGoalMode)
        : goalStreakDays(memSessions, goalValue, now, dailyGoalMode)
    };
  }, [
    memSessions,
    interruptions,
    analyticsStartDate,
    dailyGoalSessions,
    dailyGoalMinutes,
    dailyGoalMode,
    today,
    focusAgg
  ]);

  /* C4（性能）：taskFocusBreakdown 只算一遍供饼图消费；回调里对每个 session
     做 tasks.find 是 O(sessions×tasks)，改为 Map 化标题查询。 */
  const titleById = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const breakdown = useMemo(() => taskFocusBreakdown(memSessions, (id) => titleById.get(id)), [memSessions, titleById]);

  /* 时长分布：按专注事件（待办/自定义事件）聚合，每个事件一个扇区；
     未归属任何事件的完成专注归入「未关联」，保证饼图覆盖全部时长。 */
  const distribution = useMemo(() => {
    const parts = breakdown.map((r) => ({ key: r.key, label: r.label, minutes: r.focusMinutes }));
    let unlinked = 0;
    for (const s of memSessions) {
      if (s.type !== "focus" || !s.completed) continue;
      if (!s.taskId && !s.eventLabel) unlinked += Math.round(s.plannedSeconds / 60);
    }
    if (unlinked > 0) parts.push({ key: "__unlinked", label: tr("未关联"), minutes: unlinked });
    parts.sort((a, b) => b.minutes - a.minutes);
    return parts;
  }, [breakdown, memSessions, tr]);
  const heat = useMemo(
    () => (focusAgg ? monthlyHeatmapFromAgg(focusAgg, today) : monthlyHeatmap(memSessions, today)),
    [focusAgg, memSessions, today]
  );
  const monthInterrupt = useMemo(() => monthlyInterruptionBreakdown(interruptions, today), [interruptions, today]);
  const yearGridData = useMemo(
    () => (focusAgg ? yearGridFromAgg(focusAgg, heatYear, tr) : yearGrid(memSessions, heatYear, tr)),
    [focusAgg, memSessions, heatYear, tr]
  );
  // 标签（今天 / 星期）随应用语言：把 tr 传进去，语言切换后 memo 才会重算。
  const daily = useMemo(() => dailyTrend(memSessions, today, trendDays, tr), [memSessions, trendDays, today, tr]);
  const monthLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const dailyAvgLabel = fmtDur(stats.cum.dailyAverageMinutes, tr);

  return (
    <Panel
      title={tr("专注统计")}
      kicker="ANALYTICS"
      className="analytics-panel"
      action={
        <span className="session-count">
          <PieChart size={15} />
          {tr("数据统计")}
        </span>
      }
    >
      {/* 总览：累计时长为主视觉，累计次数与连续达标为侧柱（原三组卡片收敛为一条英雄带） */}
      <div className="analytics-group analytics-hero-group">
        <div className="analytics-hero">
          <div className="hero-main">
            <span className="hero-label">{tr("累计专注时长")}</span>
            <strong className="hero-value">
              <AnimatedDuration minutes={stats.cum.totalFocusMinutes} />
            </strong>
            <span className="hero-sub">
              {tr("日均")} {dailyAvgLabel}
            </span>
          </div>
          <div className="hero-side">
            <div className="hero-chip">
              <Flame size={14} />
              <b>
                <AnimatedStat value={stats.cum.totalFocusCount} />
              </b>
              <span>{tr("累计次数")}</span>
            </div>
            <div className="hero-chip streak">
              <Flame size={14} />
              <b>
                <AnimatedStat value={stats.streak} />
              </b>
              <span>
                {tr("连续达标")}
                <em>
                  {dailyGoalMode === "minutes"
                    ? dailyGoalMinutes > 0
                      ? tr("目标 {d}/天", { d: fmtDur(dailyGoalMinutes, tr) })
                      : tr("未设目标")
                    : dailyGoalSessions > 0
                      ? tr("目标 {n} 轮/天", { n: dailyGoalSessions })
                      : tr("未设目标")}
                </em>
              </span>
            </div>
          </div>
        </div>

        {/* 今日：三个紧凑瓦片 */}
        <div className="metric-grid three">
          <MetricTile
            icon={<CalendarDays size={14} />}
            label={tr("今日次数")}
            value={<AnimatedStat value={stats.todayCount} />}
            unit={tr("轮")}
          />
          <MetricTile
            icon={<Target size={14} />}
            label={tr("今日时长")}
            value={<AnimatedStat value={stats.todayMinutes} />}
            unit={tr("分钟")}
          />
          <MetricTile
            tone="giveup"
            icon={<Flag size={14} />}
            label={tr("放弃")}
            value={<AnimatedStat value={stats.todayGiveUp} />}
            unit={tr("次")}
            sub={tr("中断 {n} 次", { n: stats.todayInterrupt })}
          />
        </div>

        {/* 本周与目标 */}
        <div className="metric-grid two">
          <MetricTile
            icon={<TrendingUp size={14} />}
            label={tr("本周轮数")}
            value={<AnimatedStat value={stats.week.focusCount} />}
            unit={tr("轮")}
            sub={tr("本月 {n} 轮", { n: stats.monthCount })}
          />
          <MetricTile
            icon={<Target size={14} />}
            label={tr("本周时长")}
            value={<AnimatedDuration minutes={stats.week.focusMinutes} />}
          />
        </div>
      </div>

      {/* W-051 任务用时归集：由「专注时长分布」饼图 + 图例承担，不再单独排行 */}

      <div className="analytics-group">
        <SectionHead
          icon={<PieChart size={13} />}
          title={tr("专注时长分布")}
          extra={<span className="head-note">{monthLabel}</span>}
        />
        <DistSection distribution={distribution} dailyAvgLabel={dailyAvgLabel} />
      </div>

      {showMonthHeatmap && (
        <div className="analytics-group">
          <SectionHead
            icon={<Flame size={13} />}
            title={tr("专注时段分布")}
            extra={
              <div className="heat-tabs" role="group" aria-label={tr("专注时段分布")}>
                <button
                  type="button"
                  className={`heat-tab${heatTab === "month" ? " active" : ""}`}
                  onClick={() => pickHeatTab("month")}
                >
                  {tr("本月")}
                </button>
                <button
                  type="button"
                  className={`heat-tab${heatTab === "year" ? " active" : ""}`}
                  onClick={() => pickHeatTab("year")}
                >
                  {tr("本年")}
                </button>
              </div>
            }
          />
          <div key={heatShown} className={`heat-pane${tabFading ? " heat-pane-out" : ""}`}>
            {heatShown === "month" ? (
              <>
                <div className="heat-wrap">
                  <MonthHeatmap
                    cells={heat}
                    year={today.getFullYear()}
                    month={today.getMonth()}
                    weekdayLabels={weekdayLabels}
                  />
                </div>
                <div className="heat-legend">
                  <span>{tr("少")}</span>
                  {HEAT_COLORS.map((c, i) => (
                    <span key={i} className="heat-cell" style={i === 0 ? undefined : { background: c }} />
                  ))}
                  <span>{tr("多")}</span>
                  <span className="heat-total">
                    {tr("本月 {n} 次", { n: stats.monthCount })} · {fmtDur(stats.monthMinutes, tr)}
                  </span>
                </div>
              </>
            ) : (
              <YearHeatmap
                grid={yearGridData}
                year={heatYear}
                onYearChange={setHeatYear}
                weekdayLabels={weekdayLabels}
              />
            )}
          </div>
        </div>
      )}

      <div className="analytics-group">
        <SectionHead icon={<TrendingUp size={13} />} title={tr("近 {n} 天专注趋势", { n: trendDays })} />
        <DailyBars data={daily} />
      </div>

      {/* FocusTimer 借鉴（#13 时段分布图）：近 N 天 × 小时气泡矩阵（月页
          BubbleChart 同款视觉）+ 下方全历史累计迷你行 */}
      <div className="analytics-group">
        <SectionHead
          icon={<Clock size={13} />}
          title={tr("小时分布")}
          extra={<span className="head-note">{tr("最近 {n} 天", { n: trendDays })}</span>}
        />
        <HourlyBubbles grid={dayGrid} />
        <div className="hourly-totals-caption">{tr("累计小时分布")}</div>
        <HourlyBars data={hourlyData} />
      </div>

      <div className="analytics-group">
        <SectionHead icon={<Flag size={13} />} title={tr("月度打断原因 · {m}", { m: monthLabel })} />
        {monthInterrupt.length === 0 ? (
          <EmptyState text={tr("本月暂无中断记录，保持专注！")} compact />
        ) : (
          <div className="bar-list interrupt-list">
            {monthInterrupt.map((r) => (
              <div className="bar-row tone-danger" key={r.reason}>
                <span className="bar-name" title={tr(r.reason)}>
                  {tr(r.reason)}
                </span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(r.count / monthInterrupt[0].count) * 100}%` }} />
                </div>
                <span className="bar-val">
                  {r.count} {tr("次")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="analytics-hint">{tr("完成一个专注阶段后，数据会自动记录。")}</p>
    </Panel>
  );
}

/** 今日已完成专注轮数（A-36 口径：中断放弃的 completed:false 段不计，与番茄钟小组件一致）。 */
function countFocusToday(sessions: ReturnType<typeof useAppStore.getState>["sessions"], now: Date): number {
  return sessions.filter(
    (s) =>
      s.type === "focus" &&
      s.completed &&
      !Number.isNaN(new Date(s.endedAt).getTime()) &&
      isSameDay(new Date(s.endedAt), now)
  ).length;
}
