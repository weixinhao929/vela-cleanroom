/**
 * 系统信息小组件：开机时长、进程数、CPU/内存占用与电池状态；
 * 数据来自共享 sys:stats 广播，无独立轮询。
 */
import { useEffect, useRef, useState } from "react";
import { Cpu, Gauge, HardDrive, MemoryStick, Network, WifiOff } from "lucide-react";
import { useT } from "../../i18n-lite";
import { FxCount } from "../../lib/fx";
import { selectNetworkRows, useNetRate, useSystemBroadcast, type NetworkMode } from "../../lib/system-stats";
import { useWidgetConfig } from "../widget-config";
import { Sparkline } from "./sparkline";

const HISTORY_LEN = 40;
/** W-144 阈值告警线（%）：高于此值进度条与数值变红。 */
const ALERT_THRESHOLD = 80;

/** W-146 单核占用率 → 色阶（任务管理器小格子）。 */
function coreColor(v: number): string {
  if (v >= 90) return "var(--danger, #ef4444)";
  if (v >= 60) return "var(--amber, #f59e0b)";
  if (v >= 30) return "var(--accent, #7c8cf8)";
  return "var(--accent-2, #4fc3f7)";
}

/** W-145 网络趋势纵轴满量程：窗口峰值 ×1.2（下限 1KB/s），避免曲线全程贴顶。 */
function netHistMax(data: number[]): number {
  const peak = data.length ? Math.max(...data) : 0;
  return Math.max(1024, peak * 1.2);
}

/**
 * System monitor widget — CPU / memory bars plus optional disk and network
 * readouts. Data comes from the Rust-side `sys:stats` broadcast (one shared
 * sampler for every monitor widget); in browser mode it shows "–" placeholders
 * (never fabricated).
 *
 * Widget-specific config (settings → 小组件 → 系统监控):
 *  - showCPU / showRAM / showGPU / showDisk / showNetwork: toggle each section
 *  - compactMode: tighter layout
 *  - refreshInterval: broadcast cadence this instance asks for
 *  - showTrend (W-142): 每行迷你趋势曲线
 *  - showAllDisks (W-143): 显示全部磁盘
 *  - thresholdAlert (W-144): >80% 变红
 *  - networkMode (W-145): first / all / aggregate
 *  - showCoresGrid (W-146): CPU 每核小格子
 */
export function SystemWidget({ instanceId }: { instanceId: string }) {
  const { config } = useWidgetConfig(instanceId);
  const tr = useT();
  const showCPU = config.showCPU !== false;
  const showRAM = config.showRAM !== false;
  const showGPU = config.showGPU !== false;
  const showDisk = config.showDisk !== false;
  const showNetwork = config.showNetwork !== false;
  const compactMode = !!config.compactMode;
  const refreshIntervalSec = Math.max(1, (config.refreshInterval as number) || 3);
  const showTrend = config.showTrend === true;
  const showAllDisks = config.showAllDisks === true;
  const thresholdAlert = config.thresholdAlert !== false;
  const networkMode = ((config.networkMode as NetworkMode) || "first") satisfies NetworkMode;
  const networkSelect = ((config.networkSelect as string) || "") as string;
  const showCoresGrid = config.showCoresGrid === true;

  const frame = useSystemBroadcast(refreshIntervalSec);
  const stats = frame?.stats ?? null;
  const disks = frame?.disks ?? [];
  const network = frame?.networks ?? [];
  // W-167 全局网速显示选项（bit 计/简洁/隐藏单位/上下行交换）。
  const { fmt: fmtRate, swap: netSwap } = useNetRate();

  // W-142 趋势历史：ref 数组 + 强制重渲染（与 HardwareWidget 同模式）。
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  const gpuHist = useRef<number[]>([]);
  /** W-145 网络趋势（聚合 ↓/↑ 两条）。 */
  const netDownHist = useRef<number[]>([]);
  const netUpHist = useRef<number[]>([]);
  const [, force] = useState(0);
  useEffect(() => {
    if (!frame) return;
    cpuHist.current = [...cpuHist.current, frame.stats.cpu_usage].slice(-HISTORY_LEN);
    memHist.current = [...memHist.current, frame.stats.mem_percent].slice(-HISTORY_LEN);
    gpuHist.current = [...gpuHist.current, frame.stats.gpu_usage].slice(-HISTORY_LEN);
    netDownHist.current = [...netDownHist.current, frame.networks.reduce((s, n) => s + (n.up ? n.rx_bps : 0), 0)].slice(
      -HISTORY_LEN
    );
    netUpHist.current = [...netUpHist.current, frame.networks.reduce((s, n) => s + (n.up ? n.tx_bps : 0), 0)].slice(
      -HISTORY_LEN
    );
    force((x) => x + 1);
  }, [frame]);

  /* 骨架→数据交叉淡出：数据到达后骨架再保留 ~120ms（is-closing 淡出），
     与首帧行内容交叠，避免硬切闪烁。依赖布尔量而非 stats 引用——
     广播每帧都是新对象，直接依赖会让定时器永远重置。 */
  const [skeletonGone, setSkeletonGone] = useState(false);
  const hasStats = !!stats;
  useEffect(() => {
    if (!hasStats) {
      setSkeletonGone(false);
      return;
    }
    const t = window.setTimeout(() => setSkeletonGone(true), 120);
    return () => window.clearTimeout(t);
  }, [hasStats]);

  const alertCls = (pct: number) => (thresholdAlert && pct > ALERT_THRESHOLD ? " alert" : "");

  // W-143 磁盘：默认第一块；showAllDisks 渲染全部（按挂载点排序，系统盘在前）。
  const visibleDisks = showAllDisks ? disks.slice().sort((a, b) => a.mount.localeCompare(b.mount)) : disks.slice(0, 1);

  // W-145 网卡：first(自动选最活跃) / all 全部 / aggregate 聚合 / select 指定。
  // 选卡口径统一在 lib/system-stats 的 selectNetworkRows（与 sysbar/mini 一致）。
  const netRows = selectNetworkRows(network, networkMode, networkSelect, tr("合计"));

  const showSkeleton = !stats || !skeletonGone;

  return (
    <div
      className={`widget-system${compactMode ? " compact" : ""}${showSkeleton ? " loading" : ""}`}
      aria-busy={showSkeleton || undefined}
    >
      {showSkeleton && (
        <div className={`sys-skeleton${stats ? " is-closing" : ""}`}>
          {Array.from({ length: 3 }, (_, i) => (
            <div className="widget-skeleton sys-skeleton-row" key={i} style={{ ["--sd" as string]: `${i * 0.12}s` }} />
          ))}
        </div>
      )}
      {stats && (
        <>
          {showCPU && (
            <div className="widget-sys-row">
              <span className="widget-sys-icon">
                <Cpu size={16} />
              </span>
              <div className="widget-sys-body">
                <span className="widget-sys-label">{tr("CPU · {n} 核", { n: stats.cores })}</span>
                <div className="widget-sys-bar">
                  <span
                    className={alertCls(stats.cpu_usage)}
                    style={{ transform: `scaleX(${Math.min(100, stats.cpu_usage) / 100})` }}
                  />
                </div>
                {/* 告警态前置 aria-hidden 三角标记：红色不是唯一提示（色盲可辨）。
                    不按数值分桶重挂：占用率在档位边界震荡时每 tick 重挂一次 →
                    数字反复淡入闪烁且打断 FxCount 滚动；fade 仅首次挂载播一次。 */}
                <span className={`widget-sys-value${alertCls(stats.cpu_usage)}`}>
                  {alertCls(stats.cpu_usage) ? <span aria-hidden="true">▲ </span> : null}
                  <FxCount value={stats.cpu_usage} />%
                </span>
                {showTrend && (
                  <div className="widget-sys-trend">
                    <Sparkline data={cpuHist.current} color="var(--accent)" />
                  </div>
                )}
              </div>
            </div>
          )}
          {showCoresGrid && stats.cpu_per_core.length > 0 && (
            <div className="sys-cores-grid" title={tr("每核占用率")}>
              {stats.cpu_per_core.map((v, i) => (
                <span
                  key={i}
                  className="sys-core-cell"
                  style={{
                    background: coreColor(Math.min(100, Math.max(0, v))),
                    opacity: 0.25 + 0.75 * (Math.min(100, v) / 100)
                  }}
                  title={`#${i + 1} ${Math.round(v)}%`}
                />
              ))}
            </div>
          )}
          {showRAM && (
            <div className="widget-sys-row">
              <span className="widget-sys-icon">
                <MemoryStick size={16} />
              </span>
              <div className="widget-sys-body">
                <span className="widget-sys-label">{tr("内存")}</span>
                <div className="widget-sys-bar">
                  <span
                    className={alertCls(stats.mem_percent)}
                    style={{ transform: `scaleX(${Math.min(100, stats.mem_percent) / 100})` }}
                  />
                </div>
                <span className={`widget-sys-value${alertCls(stats.mem_percent)}`}>
                  {alertCls(stats.mem_percent) ? <span aria-hidden="true">▲ </span> : null}
                  <FxCount value={stats.mem_used_gb} decimals={1} /> / {stats.mem_total_gb.toFixed(0)} GB
                </span>
                {showTrend && (
                  <div className="widget-sys-trend">
                    <Sparkline data={memHist.current} color="var(--accent-2)" />
                  </div>
                )}
              </div>
            </div>
          )}
          {/* GPU row only renders when real GPU counters exist (gpu_present).
              VRAM (· N GB) is shown only when the memory counter reports a total. */}
          {showGPU && stats.gpu_present && (
            <div className="widget-sys-row">
              <span className="widget-sys-icon">
                <Gauge size={16} />
              </span>
              <div className="widget-sys-body">
                <span className="widget-sys-label">{tr("GPU")}</span>
                <div className="widget-sys-bar">
                  <span
                    className={alertCls(stats.gpu_usage)}
                    style={{ transform: `scaleX(${Math.min(100, stats.gpu_usage) / 100})` }}
                  />
                </div>
                <span className={`widget-sys-value${alertCls(stats.gpu_usage)}`}>
                  {alertCls(stats.gpu_usage) ? <span aria-hidden="true">▲ </span> : null}
                  <FxCount value={stats.gpu_usage} />%
                  {stats.gpu_mem_used_gb > 0 ? ` · ${stats.gpu_mem_used_gb.toFixed(1)} GB` : ""}
                </span>
                {showTrend && (
                  <div className="widget-sys-trend">
                    <Sparkline data={gpuHist.current} color="var(--warn, var(--amber))" />
                  </div>
                )}
              </div>
            </div>
          )}
          {showDisk &&
            visibleDisks.map((d) => (
              <div className="widget-sys-row" key={d.mount}>
                <span className="widget-sys-icon">
                  <HardDrive size={16} />
                </span>
                <div className="widget-sys-body">
                  <span className="widget-sys-label">{tr("磁盘 · {m}", { m: d.mount })}</span>
                  <div className="widget-sys-bar">
                    <span
                      className={alertCls(d.percent)}
                      style={{ transform: `scaleX(${Math.min(100, d.percent) / 100})` }}
                    />
                  </div>
                  <span className={`widget-sys-value${alertCls(d.percent)}`}>
                    {alertCls(d.percent) ? <span aria-hidden="true">▲ </span> : null}
                    {d.used_gb.toFixed(0)} / {d.total_gb.toFixed(0)} GB
                  </span>
                </div>
              </div>
            ))}
          {showNetwork &&
            netRows.length > 0 &&
            netRows.map((n) => (
              <div className="widget-sys-row" key={n.name}>
                <span className="widget-sys-icon">{n.up ? <Network size={16} /> : <WifiOff size={16} />}</span>
                <div className="widget-sys-body">
                  <span className="widget-sys-label">
                    {tr("网络")}
                    {networkMode !== "first" ? ` · ${n.name}` : ""}
                    {!n.up && <span className="widget-sys-net-down">{tr("未连接")}</span>}
                  </span>
                  {showTrend && (
                    <div className="widget-sys-trend widget-sys-trend-net">
                      <Sparkline
                        data={netDownHist.current}
                        color="var(--accent-2)"
                        max={netHistMax(netDownHist.current)}
                      />
                      <Sparkline data={netUpHist.current} color="var(--accent)" max={netHistMax(netUpHist.current)} />
                    </div>
                  )}
                  <div className="widget-sys-net">
                    {/* W-167 上下行交换：交换「谁在前」，默认 ↓下载在前。 */}
                    <span className="widget-sys-net-item">{netSwap ? `↑ ${fmtRate(n.tx)}` : `↓ ${fmtRate(n.rx)}`}</span>
                    <span className="widget-sys-net-item">{netSwap ? `↓ ${fmtRate(n.rx)}` : `↑ ${fmtRate(n.tx)}`}</span>
                  </div>
                </div>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
