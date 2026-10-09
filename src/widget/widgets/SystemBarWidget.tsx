/**
 * 系统栏小组件：CPU/内存/磁盘/网络紧凑条状展示 + 悬停详情卡；
 * 数据来自共享 sys:stats 广播帧，历史采样在 effect 中一帧一样本（P-perf）。
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Zap } from "lucide-react";
import { isTauri } from "../../lib/tauri";
import { useDelayedUnmount } from "../../lib/anim";
import { coveredTickGate } from "../../lib/use-covered";
import { animDurations } from "../../lib/durations";
import { FxCount } from "../../lib/fx";
import { uiZoom } from "../../lib/ui-zoom";
import {
  fmtUptime,
  selectNetworkRows,
  useNetRate,
  useSystemBroadcast,
  type SystemBroadcast
} from "../../lib/system-stats";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";
import { Sparkline } from "./sparkline";

type Stats = SystemBroadcast["stats"];

const HISTORY_LEN = 40;

/** 可选显示项（顺序即渲染顺序）。 */
const ITEM_KEYS = ["fps", "lat", "gpu", "cpu", "mem", "cores", "net", "battery"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];

/** 悬停迷你趋势浮层：CPU/内存/网络近 HISTORY_LEN 帧的 sparkline（portal 定位）。
 *  range 填底部当前值文本（此前 sysbar-trend-range 是个永不填充的空占位）；
 *  网络类指标可传第二组数据画 ↓/↑ 双曲线（与其余监控组件同口径）。 */
function HoverTrend({
  data,
  color,
  label,
  anchor,
  max,
  closing,
  data2,
  color2,
  range
}: {
  data: number[];
  color: string;
  label: string;
  anchor: { x: number; y: number };
  max?: number;
  closing?: boolean;
  data2?: number[];
  color2?: string;
  range?: string;
}) {
  return createPortal(
    <div className={`sysbar-trend${closing ? " is-closing" : ""}`} style={{ left: anchor.x, top: anchor.y }}>
      <span className="sysbar-trend-title">{label}</span>
      <Sparkline data={data} color={color} max={max} span={HISTORY_LEN} />
      {data2 && color2 && <Sparkline data={data2} color={color2} max={max} span={HISTORY_LEN} />}
      {range && <span className="sysbar-trend-range">{range}</span>}
    </div>,
    document.body
  );
}

/** 网络趋势纵轴满量程：窗口峰值 ×1.2（下限 1KB/s），避免曲线全程贴顶。 */
function netHistMax(data: number[]): number {
  const peak = data.length ? Math.max(...data) : 0;
  return Math.max(1024, peak * 1.2);
}

/**
 * Vela-style top system monitor bar: a plain text strip (no card) showing a
 * user-defined set of items (: fps / latency / gpu / cpu / mem / cores /
 * net / battery). FPS is measured from the widget's own rAF render loop;
 * "延迟" is the age of the latest `sys:stats` broadcast frame. CPU/memory/GPU/
 * net/battery come from the shared Rust sampling broadcast.
 *
 * 网速 ↓↑（全网卡聚合）；>80% 变红；字号 + 分隔符样式；
 * 悬停 CPU/内存 出迷你趋势浮层。
 */
export function SystemBarWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const [fps, setFps] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  const lastFrameAt = useRef(0);
  const { config } = useWidgetConfig(instanceId);
  const refreshIntervalSec = Math.max(1, (config.refreshInterval as number) || 2);
  const fontSize = (config.fontSize as string) || "sm";
  const separator = (config.separator as string) || "bar";
  /** 无底板：根元素挂 transparent 类，卡片壳层经 :has 摘掉底板（时钟/音乐同款）。 */
  const transparent = config.transparent === true;
  /** 阈值告警线（%）与电池低电线（%）：均可配（默认 80 / 20）。 */
  const alertThreshold = Math.max(10, Math.min(100, (config.alertThreshold as number) || 80));
  const battLowThreshold = Math.max(5, Math.min(50, (config.battLowThreshold as number) || 20));

  // 显示项：config.items 驱动；未知值过滤，兼容旧 showGPU/showCores 缺省。
  const rawItems = Array.isArray(config.items) ? (config.items as string[]) : null;
  const items: ItemKey[] = (rawItems && rawItems.length > 0 ? rawItems : ITEM_KEYS.slice(0, 6)).filter(
    (k): k is ItemKey => (ITEM_KEYS as readonly string[]).includes(k)
  );

  // 趋势历史（CPU/内存）：与广播帧同步 append。
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  /** 网络趋势（聚合 ↓/↑ 双曲线）。 */
  const netHist = useRef<number[]>([]);
  const netUpHist = useRef<number[]>([]);
  const [hover, setHover] = useState<{ key: "cpu" | "mem" | "net"; x: number; y: number } | null>(null);
  /* 统一弹层退场：悬停浮卡不再硬切消失——关闭后播 .is-closing 再卸载，
     期间以最后一次悬停快照渲染（划过常驻条的高频路径，进出场都要轻）。 */
  const trendVisible = useDelayedUnmount(!!hover, Math.round(animDurations().fxXfastMs));
  const lastHover = useRef(hover);
  if (hover) lastHover.current = hover;
  const shownHover = hover ?? lastHover.current;

  const frame = useSystemBroadcast(refreshIntervalSec);
  const stats: Stats | null = frame?.stats ?? null;
  // 全局网速显示选项（bit 计/简洁/隐藏单位/上下行交换）。
  const { fmt: fmtRate, swap: netSwap } = useNetRate();

  // 趋势历史（CPU/内存）：与广播帧同步 append。
  // P-perf/正确性：此前 append 写在渲染体内——任何无关重渲（如 hover 状态）
  // 都会重复追加同一帧样本并各做一次 O(L) 数组拷贝，趋势曲线被失真拉平。
  // 移入 effect 后严格「一帧一样本」。
  useEffect(() => {
    if (!frame) return;
    lastFrameAt.current = performance.now();
    cpuHist.current = [...cpuHist.current, frame.stats.cpu_usage].slice(-HISTORY_LEN);
    memHist.current = [...memHist.current, frame.stats.mem_percent].slice(-HISTORY_LEN);
    netHist.current = [...netHist.current, frame.networks.reduce((s, n) => s + (n.up ? n.rx_bps : 0), 0)].slice(
      -HISTORY_LEN
    );
    netUpHist.current = [...netUpHist.current, frame.networks.reduce((s, n) => s + (n.up ? n.tx_bps : 0), 0)].slice(
      -HISTORY_LEN
    );
  }, [frame]);

  // FPS 采样由「常驻 60Hz rAF 循环」改为「1s 定时 + 两帧差值」，窗口
  // 隐藏时完全停表（不再有隐形 WebView 永续排帧抑制空闲降频）。visible 恢复即重采。
  useEffect(() => {
    let alive = true;
    let iv = 0;
    const sample = () => {
      if (!alive || document.hidden || coveredTickGate()) return;
      requestAnimationFrame((t1) => {
        requestAnimationFrame((t2) => {
          if (!alive) return;
          const dt = t2 - t1;
          setFps(Math.round(1000 / Math.max(1, dt)));
          setNow(t2);
        });
      });
    };
    iv = window.setInterval(sample, 1000);
    sample();
    const onVis = () => {
      if (!document.hidden && !coveredTickGate()) sample();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  /* cpu/mem/gpu/电池（采样驱动、变化平缓）接 FxCount 滚动：不重挂、不闪烁，
     数字滚动过渡而非跳变。duration 收窄到 280ms（P-perf 三轮）：采样值 ~1Hz
     更新，默认 550ms 补间占空比 >50%，4 个计数器合计让 WebView 每秒约半数
     时间在 rAF 中无法空闲——280ms 保住滚动观感、占空比 <30%。FPS/延迟/网速
     等高频抖动值保持直出——滚动追不上变化频率反而成噪声（历史教训见下）。 */
  const cpu = stats ? (
    <>
      <FxCount value={stats.cpu_usage} duration={280} />%
    </>
  ) : (
    "—"
  );
  const mem = stats ? (
    <>
      <FxCount value={stats.mem_percent} duration={280} />%
    </>
  ) : (
    "—"
  );
  const gpu = stats ? (
    <>
      <FxCount value={stats.gpu_usage} duration={280} />%
    </>
  ) : (
    "—"
  );
  const cores = stats ? `${stats.cores}${tr(" 核")}` : "—";
  const fpsTxt = isTauri() ? `${fps} FPS` : `${tr("演示")} FPS`;
  // （暂停期延迟读数）：presence 暂停期间 sys:stats 停发，但本组件的 FPS
  // 采样每秒仍 setNow——now-lastFrameAt 无限增长，延迟读数滚成几分钟。超过
  // 5s 一律按「无数据」显示（真实帧间隔 ≤ 刷新间隔 ×2）。
  const latTxt = lastFrameAt.current
    ? now - lastFrameAt.current <= 5000
      ? `${Math.max(0, Math.round(now - lastFrameAt.current))}ms`
      : "—"
    : "—";
  // 网速：聚合 ↓/↑（在连网卡；走全局显示选项与上下行交换）。
  // aggregate 模式对空网卡表也恒返回一行 0 速率——首帧未到时须显示占位，
  // 不能把「无数据」渲染成「↓0 B/s」假读数（「绝不伪造数据」口径）。
  const netRows = selectNetworkRows(frame?.networks ?? [], "aggregate", "", tr("合计"));
  const netAgg = netRows[0];
  const netTxt = !frame
    ? "—"
    : netSwap
      ? `↑${fmtRate(netAgg.tx)} ↓${fmtRate(netAgg.rx)}`
      : `↓${fmtRate(netAgg.rx)} ↑${fmtRate(netAgg.tx)}`;
  // 电池。充电态用 lucide 图标（emoji 不随主题变色且跨平台不一致）。
  const batt = frame?.battery;
  const battTxt = batt?.present ? (
    <>
      <FxCount value={batt.percent} duration={280} />%
    </>
  ) : (
    "—"
  );

  /* 数值展示：不以「文本」为 key 重挂载触发 fade（FPS/延迟/网速等高频值
     每秒都在变，等于数字永远处于淡入中途）。改为文本/滚动更新 + 告警态
     色彩过渡；告警态额外前置 aria-hidden 三角标记，不让红色成为唯一提示
     （色盲可辨）。 */
  const num = (v: React.ReactNode, alert = false) => (
    <span className={`sys-num${alert ? " alert" : ""}`}>
      {alert ? <span aria-hidden="true">▲ </span> : null}
      {v}
    </span>
  );
  // 阈值告警。
  const alertOf = (pct: number | undefined) => pct !== undefined && pct > alertThreshold;

  const onTrendEnter =
    (key: "cpu" | "mem" | "net") => (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>) => {
      const gap = 10;
      // 网络浮层带 ↓/↑ 双曲线，比 CPU/内存的单曲线高约一个 sparkline 档，
      // 锚点上移量按内容高度区分，避免浮层下沿压住悬停项。
      const lift = key === "net" ? 106 : 76;
      // 鼠标用指针位置锚定浮层；键盘聚焦时退化为元素几何中心（FocusEvent 无坐标）。
      const pos =
        "clientX" in e
          ? { x: e.clientX, y: e.clientY }
          : (() => {
              const r = e.currentTarget.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top };
            })();
      /* pos（clientX / gBCR）是视觉坐标，消费处 .sysbar-trend 为 fixed 定位，
         且下方钳制与 innerWidth（布局）混算——统一 ÷uiZoom 换算为布局单位。 */
      const z = uiZoom();
      setHover({
        key,
        x: Math.max(4, Math.min(pos.x / z - 60, window.innerWidth - 150)),
        y: Math.max(4, pos.y / z - lift - gap)
      });
    };

  const nodes: Record<ItemKey, React.ReactNode> = {
    fps: <span title={tr("桌面层自身渲染帧率（反映合成负载），非游戏帧率")}>{num(fpsTxt)}</span>,
    lat: (
      <span>
        {tr("延迟")} {num(latTxt)}
      </span>
    ),
    gpu: <span>GPU {num(gpu)}</span>,
    cpu: (
      <span
        tabIndex={0}
        onMouseEnter={onTrendEnter("cpu")}
        onMouseLeave={() => setHover(null)}
        onFocus={onTrendEnter("cpu")}
        onBlur={() => setHover(null)}
        data-trend="cpu"
      >
        CPU {num(cpu, alertOf(stats?.cpu_usage))}
      </span>
    ),
    mem: (
      <span
        tabIndex={0}
        onMouseEnter={onTrendEnter("mem")}
        onMouseLeave={() => setHover(null)}
        onFocus={onTrendEnter("mem")}
        onBlur={() => setHover(null)}
        data-trend="mem"
      >
        {tr("内存")} {num(mem, alertOf(stats?.mem_percent))}
      </span>
    ),
    cores: <span>{num(cores)}</span>,
    net: (
      <span
        tabIndex={0}
        onMouseEnter={onTrendEnter("net")}
        onMouseLeave={() => setHover(null)}
        onFocus={onTrendEnter("net")}
        onBlur={() => setHover(null)}
        data-trend="net"
      >
        {num(netTxt)}
      </span>
    ),
    battery: (
      <span
        /* 剩余时间走悬停提示：条本身保持紧凑（放电且有有效估计才提示，
           secs_left=0 表示未知/交流供电——不编造）。 */
        title={
          batt?.present && !batt.charging && batt.secs_left > 0
            ? tr("剩余约 {t}", { t: fmtUptime(batt.secs_left, tr) })
            : undefined
        }
      >
        {tr("电池")} {num(battTxt, batt?.present === true && batt.percent <= battLowThreshold)}
        {batt?.present && batt.charging ? <Zap size={10} className="sysbar-charge" aria-hidden="true" /> : null}
      </span>
    )
  };

  const sepChar = separator === "dot" ? "·" : "|";

  return (
    <div className={`widget-sysbar fs-${fontSize}${transparent ? " transparent" : ""}`}>
      {items.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && separator !== "none" && <span className="sep">{sepChar}</span>}
          {nodes[k]}
        </Fragment>
      ))}
      {trendVisible && shownHover && (
        <HoverTrend
          closing={!hover}
          data={
            shownHover.key === "cpu" ? cpuHist.current : shownHover.key === "mem" ? memHist.current : netHist.current
          }
          color={shownHover.key === "cpu" ? "var(--accent)" : "var(--accent-2)"}
          label={
            shownHover.key === "cpu"
              ? `CPU ${tr("趋势")}`
              : shownHover.key === "mem"
                ? `${tr("内存")}${tr("趋势")}`
                : `${tr("网络")}${tr("趋势")}`
          }
          /* 双曲线共用同一纵轴标尺（取 ↓/↑ 峰值较大者 ×1.2）：只按下行
             定标时，上行突发会被压在顶边失真；同标尺也让两曲线可直接比。 */
          max={
            shownHover.key === "net" ? Math.max(netHistMax(netHist.current), netHistMax(netUpHist.current)) : undefined
          }
          anchor={{ x: shownHover.x, y: shownHover.y }}
          data2={shownHover.key === "net" ? netUpHist.current : undefined}
          color2={shownHover.key === "net" ? "var(--accent)" : undefined}
          range={
            shownHover.key === "cpu"
              ? `${Math.round(stats?.cpu_usage ?? 0)}%`
              : shownHover.key === "mem"
                ? `${Math.round(stats?.mem_percent ?? 0)}%`
                : stats
                  ? netSwap
                    ? `↑${fmtRate(netAgg.tx)} ↓${fmtRate(netAgg.rx)}`
                    : `↓${fmtRate(netAgg.rx)} ↑${fmtRate(netAgg.tx)}`
                  : undefined
          }
        />
      )}
    </div>
  );
}
