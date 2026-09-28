/**
 * 系统栏小组件：CPU/内存/磁盘/网络紧凑条状展示 + 悬停详情卡；
 * 数据来自共享 sys:stats 广播帧，历史采样在 effect 中一帧一样本（P-perf）。
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Zap } from "lucide-react";
import { isTauri } from "../../lib/tauri";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { FxCount } from "../../lib/fx";
import { selectNetworkRows, useNetRate, useSystemBroadcast, type SystemBroadcast } from "../../lib/system-stats";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";
import { Sparkline } from "./sparkline";

type Stats = SystemBroadcast["stats"];

const HISTORY_LEN = 40;
/** W-156 阈值告警线（%）：CPU/内存高于此值数值变红。 */
const ALERT_THRESHOLD = 80;

/** W-154 可选显示项（顺序即渲染顺序）。 */
const ITEM_KEYS = ["fps", "lat", "gpu", "cpu", "mem", "cores", "net", "battery"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];

/** W-159 悬停迷你趋势浮层：CPU/内存/网络近 HISTORY_LEN 帧的 sparkline（portal 定位）。 */
function HoverTrend({
  data,
  color,
  label,
  anchor,
  max,
  closing
}: {
  data: number[];
  color: string;
  label: string;
  anchor: { x: number; y: number };
  max?: number;
  closing?: boolean;
}) {
  return createPortal(
    <div className={`sysbar-trend${closing ? " is-closing" : ""}`} style={{ left: anchor.x, top: anchor.y }}>
      <span className="sysbar-trend-title">{label}</span>
      <Sparkline data={data} color={color} max={max} />
      <span className="sysbar-trend-range" />
    </div>,
    document.body
  );
}

/** W-145 网络趋势纵轴满量程：窗口峰值 ×1.2（下限 1KB/s），避免曲线全程贴顶。 */
function netHistMax(data: number[]): number {
  const peak = data.length ? Math.max(...data) : 0;
  return Math.max(1024, peak * 1.2);
}

/**
 * Vela-style top system monitor bar: a plain text strip (no card) showing a
 * user-defined set of items (W-154: fps / latency / gpu / cpu / mem / cores /
 * net / battery). FPS is measured from the widget's own rAF render loop;
 * "延迟" is the age of the latest `sys:stats` broadcast frame. CPU/memory/GPU/
 * net/battery come from the shared Rust sampling broadcast.
 *
 * W-155 网速 ↓↑（全网卡聚合）；W-156 >80% 变红；W-157 字号 + 分隔符样式；
 * W-159 悬停 CPU/内存 出迷你趋势浮层。
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

  // W-154 显示项：config.items 驱动；未知值过滤，兼容旧 showGPU/showCores 缺省。
  const rawItems = Array.isArray(config.items) ? (config.items as string[]) : null;
  const items: ItemKey[] = (rawItems && rawItems.length > 0 ? rawItems : ITEM_KEYS.slice(0, 6)).filter(
    (k): k is ItemKey => (ITEM_KEYS as readonly string[]).includes(k)
  );

  // W-159 趋势历史（CPU/内存）：与广播帧同步 append。
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  /** W-159/W-145 网络趋势（聚合 ↓）。 */
  const netHist = useRef<number[]>([]);
  const [hover, setHover] = useState<{ key: "cpu" | "mem" | "net"; x: number; y: number } | null>(null);
  /* #57 统一弹层退场：悬停浮卡不再硬切消失——关闭后播 .is-closing 再卸载，
     期间以最后一次悬停快照渲染（划过常驻条的高频路径，进出场都要轻）。 */
  const trendVisible = useDelayedUnmount(!!hover, Math.round(animDurations().fxXfastMs));
  const lastHover = useRef(hover);
  if (hover) lastHover.current = hover;
  const shownHover = hover ?? lastHover.current;

  const frame = useSystemBroadcast(refreshIntervalSec);
  const stats: Stats | null = frame?.stats ?? null;
  // W-167 全局网速显示选项（bit 计/简洁/隐藏单位/上下行交换）。
  const { fmt: fmtRate, swap: netSwap } = useNetRate();

  // W-159 趋势历史（CPU/内存）：与广播帧同步 append。
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
  }, [frame]);

  // F-7：FPS 采样由「常驻 60Hz rAF 循环」改为「1s 定时 + 两帧差值」，窗口
  // 隐藏时完全停表（不再有隐形 WebView 永续排帧抑制空闲降频）。visible 恢复即重采。
  useEffect(() => {
    let alive = true;
    let iv = 0;
    const sample = () => {
      if (!alive || document.hidden) return;
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
      if (!document.hidden) sample();
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
  const latTxt = lastFrameAt.current ? `${Math.max(0, Math.round(now - lastFrameAt.current))}ms` : "—";
  // W-155 网速：聚合 ↓/↑（在连网卡；W-167 走全局显示选项与上下行交换）。
  const netRows = selectNetworkRows(frame?.networks ?? [], "aggregate", "", tr("合计"));
  const netAgg = netRows[0];
  const netTxt = netAgg
    ? netSwap
      ? `↑${fmtRate(netAgg.tx)} ↓${fmtRate(netAgg.rx)}`
      : `↓${fmtRate(netAgg.rx)} ↑${fmtRate(netAgg.tx)}`
    : `↓— ↑—`;
  // W-158 电池。充电态用 lucide 图标（emoji 不随主题变色且跨平台不一致）。
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
  // W-156 阈值告警。
  const alertOf = (pct: number | undefined) => pct !== undefined && pct > ALERT_THRESHOLD;

  const onTrendEnter =
    (key: "cpu" | "mem" | "net") => (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>) => {
      const gap = 10;
      // 鼠标用指针位置锚定浮层；键盘聚焦时退化为元素几何中心（FocusEvent 无坐标）。
      const pos =
        "clientX" in e
          ? { x: e.clientX, y: e.clientY }
          : (() => {
              const r = e.currentTarget.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top };
            })();
      setHover({
        key,
        x: Math.max(4, Math.min(pos.x - 60, window.innerWidth - 150)),
        y: Math.max(4, pos.y - 76 - gap)
      });
    };

  const nodes: Record<ItemKey, React.ReactNode> = {
    fps: <span>{num(fpsTxt)}</span>,
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
      <span>
        {tr("电池")} {num(battTxt, batt?.present === true && batt.percent <= 20)}
        {batt?.present && batt.charging ? <Zap size={10} className="sysbar-charge" aria-hidden="true" /> : null}
      </span>
    )
  };

  const sepChar = separator === "dot" ? "·" : "|";

  return (
    <div className={`widget-sysbar fs-${fontSize}`}>
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
          max={shownHover.key === "net" ? netHistMax(netHist.current) : undefined}
          anchor={{ x: shownHover.x, y: shownHover.y }}
        />
      )}
    </div>
  );
}
