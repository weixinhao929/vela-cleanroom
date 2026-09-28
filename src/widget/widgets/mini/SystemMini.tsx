/**
 * 系统监控迷你磁贴（ISLAND-MINI）：CPU / 内存 / 网络三行 3px 细条。
 * 数据只读 lib/system-stats 的 useSystemBroadcast（Rust 侧 sys:stats 订阅制
 * 广播，无自建轮询）。订阅者子组件 LiveRows 仅在 active 时挂载——接管期间
 * （active=false）卸载即退订，磁贴层重新可见再订阅；磁贴移出岛同样退订。
 * 细条走 transform: scaleX（合成器友好），不动 width。
 *
 * W-145 新增网络行：速率类指标没有固定满量程，细条按「近 HISTORY_LEN 帧
 * 峰值」归一（与 sparkline 同口径），数值显示 ↓ 下载速率。
 */
import { useEffect, useRef } from "react";
import { selectNetworkRows, useNetRate, useSystemBroadcast, type SystemBroadcast } from "../../../lib/system-stats";
import type { MiniComponentProps } from "../../registry";

const valid = (v: number | undefined): v is number => v != null && Number.isFinite(v);

/** 网络细条归一窗口：迷你磁贴场景 20 帧 ≈ 1 分钟足够。 */
const NET_WINDOW = 20;

function Row({ label, value }: { label: string; value: number | undefined }) {
  const ratio = valid(value) ? Math.max(0, Math.min(1, value / 100)) : 0;
  return (
    <span className="dock-mini-sys-row">
      <span className="dock-mini-sys-label">{label}</span>
      <span className="dock-mini-bar" aria-hidden="true">
        <i style={{ transform: `scaleX(${ratio})` }} />
      </span>
      <span className="dock-mini-sys-pct">{valid(value) ? `${Math.round(value)}%` : "–"}</span>
    </span>
  );
}

function NetRow({ frame }: { frame: SystemBroadcast | null }) {
  const { fmt } = useNetRate();
  const hist = useRef<number[]>([]);
  const rx = frame ? (selectNetworkRows(frame.networks, "aggregate")[0]?.rx ?? 0) : 0;
  // 历史在 effect 内追加（渲染期写 ref 会在无关重渲时重复采样，sysbar 同款教训）。
  useEffect(() => {
    hist.current = [...hist.current, rx].slice(-NET_WINDOW);
  }, [rx]);
  const peak = Math.max(1024, ...(hist.current.length ? hist.current : [0])) * 1.2;
  const ratio = frame ? Math.max(0, Math.min(1, rx / peak)) : 0;
  return (
    <span className="dock-mini-sys-row">
      <span className="dock-mini-sys-label">NET</span>
      <span className="dock-mini-bar" aria-hidden="true">
        <i style={{ transform: `scaleX(${ratio})` }} />
      </span>
      <span className="dock-mini-sys-text">{frame ? `↓${fmt(rx)}` : "–"}</span>
    </span>
  );
}

function Rows({ frame }: { frame: SystemBroadcast | null }) {
  return (
    <>
      <Row label="CPU" value={frame?.stats.cpu_usage} />
      <Row label="MEM" value={frame?.stats.mem_percent} />
      <NetRow frame={frame} />
    </>
  );
}

function LiveRows() {
  return <Rows frame={useSystemBroadcast(3)} />;
}

export function SystemMini({ active }: MiniComponentProps) {
  return <span className="dock-mini dock-mini-system">{active ? <LiveRows /> : <Rows frame={null} />}</span>;
}
