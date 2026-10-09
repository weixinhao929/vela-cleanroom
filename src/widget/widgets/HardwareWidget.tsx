/**
 * 硬件监控小组件：CPU/GPU/内存/磁盘/网络实时曲线（共享 sys:stats 广播）
 * 与静态型号信息（sys:hardware 低频事件），sparkline 绘制历史趋势。
 */
import { useEffect, useRef, useState } from "react";
import { Battery, Cpu, Gauge, HardDrive, MemoryStick, Network } from "lucide-react";
import { formatBytesTotal } from "../../lib/network";
import { invoke, isTauri } from "../../lib/tauri";
import { useT } from "../../i18n-lite";
import { FxCount } from "../../lib/fx";
import {
  fmtUptime,
  useNetRate,
  useSystemBroadcast,
  type GpuInfo,
  type NetworkDetail,
  type SystemBroadcast,
  type TrafficSummary
} from "../../lib/system-stats";
import { useWidgetConfig } from "../widget-config";
import { Sparkline } from "./sparkline";

/** 单核占用率 → 色阶（任务管理器小格子）。 */
function coreColor(v: number): string {
  if (v >= 90) return "var(--danger, #ef4444)";
  if (v >= 60) return "var(--amber, #f59e0b)";
  if (v >= 30) return "var(--accent, #7c8cf8)";
  return "var(--accent-2, #4fc3f7)";
}

/** 网络趋势纵轴满量程：窗口峰值 ×1.2（下限 1KB/s）。 */
function netHistMax(data: number[]): number {
  const peak = data.length ? Math.max(...data) : 0;
  return Math.max(1024, peak * 1.2);
}

function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="hw-meter">
      <div className="hw-meter-head">
        <span>{label}</span>
        {/* FxCount 平滑滚动到新值；不再按整数重挂（每 1% 重播 fade 属于噪声）。 */}
        <span className="hw-meter-num">
          <FxCount value={Math.round(value)} />%
        </span>
      </div>
      <div className="hw-meter-track">
        <div
          className="hw-meter-fill"
          style={{ transform: `scaleX(${Math.min(100, value) / 100})`, background: color }}
        />
      </div>
    </div>
  );
}

/**
 * Real-time hardware monitor with history curves for CPU / memory / GPU, plus
 * disk, network and battery readouts. Data comes from the Rust-side
 * `sys:stats` broadcast (one shared sampler for all monitor widgets); in
 * browser mode it shows "–" placeholders (never fabricated).
 *
 * 静态硬件信息头（CPU/GPU 型号 + 总内存 + 核数）。
 * 开机时长 + 进程数（头部 meta 行）。
 * historyLen 可配趋势窗口 + showPeak 峰值虚线。
 * 点击卡片展开明细（每核格子 / 每 GB 内存 / VRAM 明细）。
 */
export function HardwareWidget({ instanceId }: { instanceId: string }) {
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  const gpuHist = useRef<number[]>([]);
  /** 网络趋势（全网卡聚合 ↓/↑）。 */
  const netDownHist = useRef<number[]>([]);
  const netUpHist = useRef<number[]>([]);
  const [, force] = useState(0);
  /** 展开的卡片（"cpu" | "ram" | "gpu" | "net" | null）。 */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 网卡详情（展开网络卡片时按需拉取一次）。 */
  const [netDetails, setNetDetails] = useState<NetworkDetail[] | null>(null);
  const { config } = useWidgetConfig(instanceId);
  const tr = useT();
  // Default 3s to match config-schemas (refreshInterval: num(3,1,30)) and the
  // settings Stepper. Passed to the shared broadcast as this instance's
  // requested cadence — Rust samples once per smallest interval across widgets.
  const refreshIntervalSec = Math.max(1, (config.refreshInterval as number) || 3);
  // 趋势窗口：historyLen 个样本 × 刷新间隔 ≈ 时间范围（默认 40 ≈ 2 分钟）。
  const historyLen = Math.max(10, Math.min(120, (config.historyLen as number) || 40));

  const showCPU = (config.showCPU as boolean) !== false;
  const showRAM = (config.showRAM as boolean) !== false;
  const showGPU = (config.showGPU as boolean) !== false;
  const showDisk = (config.showDisk as boolean) !== false;
  const showNetwork = (config.showNetwork as boolean) !== false;
  const showBattery = (config.showBattery as boolean) !== false;
  const showTrend = (config.showTrend as boolean) !== false;
  const showStaticInfo = (config.showStaticInfo as boolean) !== false;
  const showUptimeProcess = (config.showUptimeProcess as boolean) !== false;
  const showPeak = config.showPeak === true;

  const frame = useSystemBroadcast(refreshIntervalSec);
  const stats = frame?.stats ?? null;
  const disks = frame?.disks ?? [];
  const network = frame?.networks ?? [];
  const battery = frame?.battery ?? null;
  // 全局网速显示选项。
  const { fmt: fmtRate } = useNetRate();

  /** 已 append 过的最后一帧：effect 依赖含 historyLen 等配置项，配置变更
   *  会让 effect 带着同一帧对象重跑——无守卫时同一采样被重复追加，趋势
   *  曲线被阶梯状失真（「一帧一样本」不变量）。 */
  const lastSampled = useRef<SystemBroadcast | null>(null);

  // Append each broadcast frame to the trend history (refs + forced re-render
  // keep the sparklines cheap — no per-tick state churn on the whole widget).
  useEffect(() => {
    if (!frame || lastSampled.current === frame) return;
    lastSampled.current = frame;
    const s = frame.stats;
    if (showCPU) cpuHist.current = [...cpuHist.current, s.cpu_usage].slice(-historyLen);
    if (showRAM) memHist.current = [...memHist.current, s.mem_percent].slice(-historyLen);
    if (showGPU) gpuHist.current = [...gpuHist.current, s.gpu_usage].slice(-historyLen);
    if (showNetwork) {
      netDownHist.current = [
        ...netDownHist.current,
        frame.networks.reduce((acc, n) => acc + (n.up ? n.rx_bps : 0), 0)
      ].slice(-historyLen);
      netUpHist.current = [
        ...netUpHist.current,
        frame.networks.reduce((acc, n) => acc + (n.up ? n.tx_bps : 0), 0)
      ].slice(-historyLen);
    }
    force((x) => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, historyLen]);

  // 展开网络卡片时拉取网卡详情（名称/类型/MAC/IP/链路速度），展开
  // 期间每 60s 重拉：VPN 拨上/断开、DHCP 续租后不展示陈旧 IP/网关。
  useEffect(() => {
    if (expanded !== "net" || !isTauri()) return;
    let alive = true;
    const load = () => {
      void invoke<NetworkDetail[]>("get_network_details")
        .then((d) => {
          if (alive) setNetDetails(d);
        })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [expanded]);

  const cpu = stats?.cpu_usage ?? 0;
  const mem = stats?.mem_percent ?? 0;
  const gpu = stats?.gpu_usage ?? 0;
  const memSub = stats ? `${stats.mem_used_gb.toFixed(1)} / ${stats.mem_total_gb.toFixed(0)} GB` : tr("加载中…");
  const gpuSub =
    stats && stats.gpu_mem_total_gb > 0
      ? `${stats.gpu_mem_used_gb.toFixed(1)} / ${stats.gpu_mem_total_gb.toFixed(0)} GB`
      : stats
        ? `${Math.round(gpu)}%`
        : tr("加载中…");
  /* 多卡列表（后端 DXGI 名称 + 每-LUID 采样）；旧后端/空数据回退单标量。 */
  const gpuList: GpuInfo[] = stats?.gpus?.length
    ? stats.gpus
    : stats && stats.gpu_present
      ? [
          {
            model: stats.gpu_model,
            usage: stats.gpu_usage,
            mem_used_gb: stats.gpu_mem_used_gb,
            mem_total_gb: stats.gpu_mem_total_gb
          }
        ]
      : [];
  const gpuModels = gpuList.map((g) => g.model).filter(Boolean);

  /** 点击卡片切换展开态（再点收起）。 */
  const toggleCell = (key: string) => setExpanded((cur) => (cur === key ? null : key));

  // 网络聚合速率（全部在连网卡求和）与 累计收发字节。
  const netAggRx = network.reduce((s, n) => s + (n.up ? n.rx_bps : 0), 0);
  const netAggTx = network.reduce((s, n) => s + (n.up ? n.tx_bps : 0), 0);
  const netTotalRx = network.reduce((s, n) => s + n.total_received, 0);
  const netTotalTx = network.reduce((s, n) => s + n.total_transmitted, 0);

  /* 「今日收发」改用 net_history 的当日口径——total_received 是开机以来
     累计字节（挂机一周显示 7 天总量却标着「今日」）。60s 轮询足够（量级为
     字节累计，非速率）；DB 不可用时回退旧口径。仅在显示网络区时轮询——
     关掉 showNetwork 的实例不必每分钟空打一条 IPC。 */
  const [todayTraffic, setTodayTraffic] = useState<{ rx: number; tx: number } | null>(null);
  useEffect(() => {
    if (!isTauri() || !showNetwork) return;
    let alive = true;
    const load = () => {
      void invoke<TrafficSummary>("get_traffic_summary")
        .then((s) => {
          if (alive && s) setTodayTraffic({ rx: s.today_rx, tx: s.today_tx });
        })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [showNetwork]);

  return (
    <div className="hw">
      {/* 静态硬件信息头：型号行 + meta 行。 */}
      {showStaticInfo && stats && (
        <div className="hw-static">
          <div className="hw-static-models">
            <span className="hw-static-model" title={stats.cpu_model}>
              {stats.cpu_model || tr("未知 CPU")}
            </span>
            {gpuModels.length > 0 && (
              <span className="hw-static-model" title={gpuModels.join(" / ")}>
                {gpuModels.join(" / ")}
              </span>
            )}
          </div>
          <div className="hw-static-meta">
            <span>
              {stats.cores}
              {tr(" 核")}
            </span>
            <span>
              {/* 空格独立于词条：zh「32 GB 内存」/ en「32 GB Memory」，
                  直接把 GB 拼进 tr 会让英文变成 GBMemory。 */}
              {stats.mem_total_gb.toFixed(0)} GB {tr("内存")}
            </span>
            {showUptimeProcess && stats.uptime_secs > 0 && (
              <>
                <span>
                  {tr("开机")} {fmtUptime(stats.uptime_secs, tr)}
                </span>
                <span>
                  {stats.process_count} {tr("进程")}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      <div className="hw-grid">
        {showCPU && (
          <div
            className={`hw-cell${expanded === "cpu" ? " expanded" : ""}`}
            onClick={() => toggleCell("cpu")}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleCell("cpu");
              }
            }}
            role="button"
            tabIndex={0}
            aria-expanded={expanded === "cpu"}
            data-interactive
            title={tr("点击展开明细")}
          >
            <div className="hw-cell-head">
              <Cpu size={14} />
              <span>CPU</span>
              <b>
                {stats ? (
                  <>
                    <FxCount value={Math.round(cpu)} />%
                  </>
                ) : (
                  "—"
                )}
              </b>
            </div>
            {showTrend && <Sparkline data={cpuHist.current} color="var(--accent)" span={historyLen} peak={showPeak} />}
            <div className="hw-cell-sub">
              {stats?.cores ?? 0} {tr("核")}
            </div>
            {/* 展开：grid-rows 0fr→1fr 平滑展开（天气预警同款样板）。 */}
            <div className={`hw-detail-wrap${expanded === "cpu" ? " open" : ""}`}>
              <div className="hw-detail-clip">
                {stats && stats.cpu_per_core.length > 0 && (
                  <div className="hw-cores-grid">
                    {stats.cpu_per_core.map((v, i) => (
                      <span
                        key={i}
                        className={`hw-core-cell${v >= 90 ? " hot" : ""}`}
                        style={{
                          background: coreColor(Math.min(100, Math.max(0, v))),
                          opacity: 0.25 + 0.75 * (Math.min(100, v) / 100)
                        }}
                        title={`#${i + 1} ${Math.round(v)}%`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {showRAM && (
          <div
            className={`hw-cell${expanded === "ram" ? " expanded" : ""}`}
            onClick={() => toggleCell("ram")}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleCell("ram");
              }
            }}
            role="button"
            tabIndex={0}
            aria-expanded={expanded === "ram"}
            data-interactive
            title={tr("点击展开明细")}
          >
            <div className="hw-cell-head">
              <MemoryStick size={14} />
              <span>{tr("内存")}</span>
              <b>
                {stats ? (
                  <>
                    <FxCount value={Math.round(mem)} />%
                  </>
                ) : (
                  "—"
                )}
              </b>
            </div>
            {showTrend && (
              <Sparkline data={memHist.current} color="var(--accent-2)" span={historyLen} peak={showPeak} />
            )}
            <div className="hw-cell-sub">{memSub}</div>
            <div className={`hw-detail-wrap${expanded === "ram" ? " open" : ""}`}>
              <div className="hw-detail-clip">
                {stats && (
                  <div className="hw-detail">
                    <span>
                      {tr("已用")} {stats.mem_used_gb.toFixed(1)} GB
                    </span>
                    <span>
                      {tr("总量")} {stats.mem_total_gb.toFixed(1)} GB
                    </span>
                    <span>
                      {tr("可用")} {Math.max(0, stats.mem_total_gb - stats.mem_used_gb).toFixed(1)} GB
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {showGPU && stats?.gpu_present && (
          <div
            className={`hw-cell${expanded === "gpu" ? " expanded" : ""}`}
            onClick={() => toggleCell("gpu")}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleCell("gpu");
              }
            }}
            role="button"
            tabIndex={0}
            aria-expanded={expanded === "gpu"}
            data-interactive
            title={tr("点击展开明细")}
          >
            <div className="hw-cell-head">
              <Gauge size={14} />
              <span>GPU</span>
              <b>
                {stats ? (
                  <>
                    <FxCount value={Math.round(gpu)} />%
                  </>
                ) : (
                  "—"
                )}
              </b>
            </div>
            {showTrend && (
              <Sparkline data={gpuHist.current} color="var(--warn, var(--amber))" span={historyLen} peak={showPeak} />
            )}
            <div className="hw-cell-sub">{gpuSub}</div>
            <div className={`hw-detail-wrap${expanded === "gpu" ? " open" : ""}`}>
              <div className="hw-detail-clip">
                {stats && (
                  <div className="hw-detail">
                    {/* 逐卡展示型号/占用/显存——独显空闲时也可见。 */}
                    {gpuList.flatMap((g, i) => [
                      <span key={`gn${i}`} className="hw-detail-wide" title={g.model || undefined}>
                        {g.model || tr("型号未知")} · {Math.round(g.usage)}%
                      </span>,
                      ...(g.mem_total_gb > 0
                        ? [
                            <span key={`gm${i}`} title={tr("显存为已提交口径（独占+共享，与任务管理器一致）")}>
                              {tr("显存")} {g.mem_used_gb.toFixed(1)} / {g.mem_total_gb.toFixed(1)} GB
                            </span>
                          ]
                        : [])
                    ])}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 网络卡片：↓/↑ 聚合速率 + 双趋势曲线 + 可展开明细。 */}
      {showNetwork && (
        <div
          className={`hw-cell${expanded === "net" ? " expanded" : ""}`}
          onClick={() => toggleCell("net")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleCell("net");
            }
          }}
          role="button"
          tabIndex={0}
          aria-expanded={expanded === "net"}
          data-interactive
          title={tr("点击展开明细")}
        >
          <div className="hw-cell-head">
            <Network size={14} />
            <span>{tr("网络")}</span>
            <b>{frame ? `↓${fmtRate(netAggRx)} ↑${fmtRate(netAggTx)}` : "—"}</b>
          </div>
          {showTrend && (
            <div className="hw-net-sparks">
              <Sparkline data={netDownHist.current} color="var(--accent-2)" max={netHistMax(netDownHist.current)} />
              <Sparkline data={netUpHist.current} color="var(--accent)" max={netHistMax(netUpHist.current)} />
            </div>
          )}
          <div className="hw-cell-sub">
            {(() => {
              const upCount = network.filter((n) => n.up).length;
              if (upCount > 0) return `${tr("在连")} ×${upCount}`;
              return network.length > 0 ? tr("全部未连接") : tr("加载中…");
            })()}
          </div>
          <div className={`hw-detail-wrap${expanded === "net" ? " open" : ""}`}>
            <div className="hw-detail-clip">
              {frame && (
                <div className="hw-detail">
                  <span>
                    {tr("今日收发")} {formatBytesTotal(todayTraffic?.rx ?? netTotalRx)} /{" "}
                    {formatBytesTotal(todayTraffic?.tx ?? netTotalTx)}
                  </span>
                  {(
                    netDetails ??
                    network.map((n) => ({
                      name: n.name,
                      description: "",
                      if_type: "",
                      oper_status: n.up ? "up" : "down",
                      link_mbps: 0,
                      mac: "",
                      ips: [] as string[],
                      gateway: "",
                      mtu: 0,
                      total_received: n.total_received,
                      total_transmitted: n.total_transmitted
                    }))
                  ).map((d, i) => (
                    <span
                      key={`${d.name}-${i}`}
                      className="hw-detail-wide"
                      title={`${d.description}${d.mac ? ` · ${d.mac}` : ""}${d.ips.length ? ` · ${d.ips.join(" / ")}` : ""}`}
                    >
                      {d.name}
                      {d.if_type ? ` · ${d.if_type}` : ""}
                      {d.link_mbps > 0
                        ? ` · ${d.link_mbps >= 1000 ? `${(d.link_mbps / 1000).toFixed(1)}G` : `${Math.round(d.link_mbps)}M`}bps`
                        : ""}
                      {` · ${d.oper_status === "up" ? tr("已连接") : tr("未连接")}`}
                      {` · ${formatBytesTotal(d.total_received + d.total_transmitted)}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="hw-meters">
        {showCPU && <Meter label="CPU" value={cpu} color="var(--accent)" />}
        {showRAM && <Meter label={tr("内存")} value={mem} color="var(--accent-2)" />}
        {showGPU && stats?.gpu_present && <Meter label="GPU" value={gpu} color="var(--warn, var(--amber))" />}
      </div>

      <div className="hw-rows">
        {showDisk && (
          <div className="hw-row">
            <HardDrive size={14} />
            <span>{tr("磁盘")}</span>
            <div className="hw-row-right">
              {disks.map((d) => (
                /* key 只做列表身份（挂载点）：不按数值分桶重挂——占用率在档位
                   边界震荡时每 tick 重挂重播 fade，芯片反复淡入闪烁。 */
                <span key={d.mount} className="hw-chip">
                  {d.mount} {Math.round(d.percent)}%
                </span>
              ))}
            </div>
          </div>
        )}
        {showNetwork && (
          <div className="hw-row">
            <Network size={14} />
            <span>{tr("网络")}</span>
            <div className="hw-row-right">
              {network.map((n) => (
                /* key 只做列表身份（名称+连接态）：速率数值变化就地更新，
                   不分桶重挂（边界震荡时芯片反复淡入闪烁）。 */
                <span
                  key={`${n.name}-${n.up}`}
                  className="hw-chip"
                  title={n.up ? n.name : `${n.name} · ${tr("未连接")}`}
                >
                  {n.up ? `↓${fmtRate(n.rx_bps)} ↑${fmtRate(n.tx_bps)}` : `${n.name} · ${tr("未连接")}`}
                </span>
              ))}
            </div>
          </div>
        )}
        {showBattery && battery?.present && (
          <div className="hw-row">
            <Battery size={14} />
            <span>{tr("电池")}</span>
            <div className="hw-row-right">
              <span className="hw-chip">
                {Math.round(battery.percent)}% {battery.charging ? tr("充电中") : tr("使用中")}
                {/* 剩余时间：仅放电且系统给出有效估计时显示（secs_left=0
                    表示未知/交流供电，隐藏而非编造）。 */}
                {!battery.charging && battery.secs_left > 0
                  ? ` · ${tr("剩余约 {t}", { t: fmtUptime(battery.secs_left, tr) })}`
                  : ""}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
