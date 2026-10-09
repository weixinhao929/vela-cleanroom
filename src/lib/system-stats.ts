import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "./tauri";
import { formatRateStyled } from "./network";
import { useSettingsStore } from "../store/settings-store";

export type GpuInfo = { model: string; usage: number; mem_used_gb: number; mem_total_gb: number };

export type SystemStats = {
  cpu_usage: number;
  mem_used_gb: number;
  mem_total_gb: number;
  mem_percent: number;
  cores: number;
  gpu_usage: number;
  gpu_mem_used_gb: number;
  gpu_mem_total_gb: number;
  gpu_present: boolean;
  /** 每块显卡一条记录（model 来自后端 DXGI 枚举，可能为空串）；
   *  旧标量字段为"最忙一块"的兼容口径。 */
  gpus?: GpuInfo[];
  /** 每核占用率数组（与 cores 等长）。 */
  cpu_per_core: number[];
  /** CPU 型号（静态）。 */
  cpu_model: string;
  /** 显卡型号（静态，注册表 DriverDesc）。 */
  gpu_model: string;
  /** 开机时长（秒）。 */
  uptime_secs: number;
  /** 进程数。 */
  process_count: number;
};

// 线协议单一来源（M3）：DiskInfo / NetworkInfo / BatteryInfo 与 Rust system.rs
// 经 ts-rs 生成的绑定逐字段一致，原手写类型改为绑定再导出；SystemStats/GpuInfo
// 是「线协议 + 静态硬件合并」的视图类型，保留手写（勿与绑定同名混淆）。
import type { DiskInfo } from "../types/bindings/DiskInfo";
import type { NetworkInfo } from "../types/bindings/NetworkInfo";
import type { BatteryInfo } from "../types/bindings/BatteryInfo";
export type { DiskInfo, NetworkInfo, BatteryInfo };

/** 网卡连接详情（get_network_details，按需命令）。 */
export type NetworkDetail = {
  name: string;
  description: string;
  if_type: "ethernet" | "wifi" | "ppp" | "tunnel" | "loopback" | "other" | string;
  oper_status: "up" | "down" | "dormant" | "not_present" | "unknown" | string;
  /** 链路速度 Mbps（0 = 未知/断开）。 */
  link_mbps: number;
  mac: string;
  ips: string[];
  gateway: string;
  /** DNS 服务器（去重列表；后端 GetAdaptersAddresses FirstDnsServerAddress）。 */
  dns: string[];
  mtu: number;
  total_received: number;
  total_transmitted: number;
};

/** 当前 TCP 连接（含归属进程；get_tcp_connections 按需命令）。 */
export type TcpConnectionInfo = {
  local: string;
  remote: string;
  state: string;
  pid: number;
  process: string;
};

/** 流量汇总（get_traffic_summary）。今日值来自记录器内存（含未落库增量）。 */
export type TrafficSummary = {
  day: string;
  today_rx: number;
  today_tx: number;
  month_rx: number;
  month_tx: number;
};

/** 单日流量（get_traffic_daily，升序）。 */
export type TrafficDay = { day: string; rx: number; tx: number };

export type SystemBroadcast = {
  stats: SystemStats;
  disks: DiskInfo[];
  networks: NetworkInfo[];
  battery: BatteryInfo;
};

/** 静态硬件信息（CPU/GPU 型号），由低频 `sys:hardware` 事件投递，
 *  前端在收到每帧 `sys:stats` 时合并进 stats，避免每帧重复传输。 */
export type HardwareSnapshot = { cpu_model: string; gpu_model: string };

/**
 * 订阅 Rust 侧统一的 `sys:stats` 采样广播（观察者模式）。
 *
 * 多个监控组件共享同一条推送：Rust 端按所有订阅者中最小的间隔采样一次
 * 并广播，替代每个组件各自 invoke 轮询（N 组件 × 3 条 IPC/秒 → 全局
 * 1 次采样/秒）。前端侧每个订阅者再按自己的 intervalSec 节流取帧（全局
 * 下限被最小订阅者钉住时，大间隔组件不再被迫跟着最小间隔重渲）。
 * 附带订阅 `sys:hardware` 低频事件合并静态型号信息。
 * 卸载时无条件补发 unsubscribe（幂等），杜绝 StrictMode 双挂载下的
 * Rust 订阅计数泄漏。
 *
 * 可见性门控（「不可见即不花钱」原则）：`Ctrl+Alt+D` 隐藏桌面层后
 * WebView 的 document 变 hidden，本 hook 据此立即退订——Rust 订阅账本归零
 * 即停采样线程；重新可见时恢复订阅。番茄钟心跳（app:heartbeat）是独立
 * 原生线程，不受影响。
 *
 * @param intervalSec - 期望的采样间隔秒数（下限 0.5），默认 3。
 * @param opts.netOnly - ：只消费 networks 字段时置 true——Rust 侧在所有
 *        订阅者均为 net-only 时跳过 CPU/GPU/磁盘/电池采样，两个数字不再把
 *        全系统遥测钉在 1Hz。载荷仍带零值 stats（帧合法性判据）。
 * @returns 最近一帧系统数据；浏览器模式或首帧未到为 null（UI 渲 "–"，
 *          绝不伪造数据）。
 * @throws 无（订阅/退订失败静默忽略）。
 *
 * @example
 * `tsx
 * const frame = useSystemBroadcast(2);
 * if (!frame) return <span>–</span>;
 * <CpuGauge value={frame.stats.cpu_usage} />
 * `
 */
export function useSystemBroadcast(intervalSec = 3, opts?: { netOnly?: boolean }): SystemBroadcast | null {
  const [data, setData] = useState<SystemBroadcast | null>(null);
  // 静态硬件型号缓存。`sys:hardware` 低频投递一次，之后每帧 `sys:stats`
  // 到达时合并进去，组件对 stats.cpu_model/gpu_model 的读取保持不变。
  const hardwareRef = useRef<HardwareSnapshot>({ cpu_model: "", gpu_model: "" });
  /* 订阅者侧节流（P-perf 三轮）：Rust 按所有订阅者中最小间隔采样广播——
     常驻可见的任务栏网速条（1s 档）把全局下限钉在 1Hz，此前每个订阅者对
     每一帧都 setData（新对象引用必然重渲），配置 5s 的组件也被迫 1Hz 重渲。
     每个 hook 现在只取属于自己的拍点：距上次应用 ≥ intervalSec×0.95（5% 容差
     防 setInterval 漂移导致的节拍僵持）才应用最新帧，未到点直接丢弃。 */
  const lastApplyAt = useRef(0);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let unlistenHw: (() => void) | undefined;
    let disposed = false;
    // 「意图」标志：本窗口当前是否想让 Rust 采样。不等 IPC 确认——退订在
    // Rust 侧是饱和递减 + 幂等 no-op，意图翻转即可放心补发对账。
    let subscribed = false;
    // 订阅确认标志在 IPC .then 里置位存在竞态：组件在 subscribe IPC 落地前
    // 卸载（StrictMode 双挂载 / 快速增删小组件）时 cleanup 永远不会发送
    // unsubscribe → Rust 订阅计数泄漏，广播线程在无消费者时仍持续采样。
    // 处理：无论确认与否，卸载/隐藏时都尝试 unsubscribe——若订阅尚未生效，
    // Rust 侧计数为 0，unsubscribe 是幂等 no-op，无副作用。
    void listen<HardwareSnapshot>("sys:hardware", (e) => {
      if (e.payload) {
        hardwareRef.current = {
          cpu_model: e.payload.cpu_model ?? "",
          gpu_model: e.payload.gpu_model ?? ""
        };
      }
    })
      .then((f) => {
        if (disposed) f();
        else unlistenHw = f;
      })
      /* 注册失败不留未处理 rejection。 */
      .catch((err: unknown) => console.error("[system-stats] listen sys:hardware failed:", err));
    void listen<SystemBroadcast>("sys:stats", (e) => {
      if (!e.payload?.stats) return;
      const now = performance.now();
      if (now - lastApplyAt.current < Math.max(0.5, intervalSec) * 1000 * 0.95) return;
      lastApplyAt.current = now;
      setData({
        ...e.payload,
        stats: {
          ...e.payload.stats,
          cpu_model: hardwareRef.current.cpu_model,
          gpu_model: hardwareRef.current.gpu_model
        }
      });
    })
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      })
      .catch((err: unknown) => console.error("[system-stats] listen sys:stats failed:", err));

    const subscribe = () => {
      // 窗口隐藏期间不订阅：隐藏的桌面层无人观看，采样纯属浪费。
      if (disposed || subscribed || document.hidden) return;
      subscribed = true;
      void invoke("subscribe_system_stats", {
        intervalMs: Math.round(Math.max(0.5, intervalSec) * 1000),
        netOnly: opts?.netOnly === true
      })
        .then(() => {
          // 订阅确认时组件已卸载：cleanup 的 unsubscribe 先于 subscribe 落地
          // （IPC 乱序）时会被饱和递减压成 no-op，这里补发一次退订兜底。
          // 隐藏路径不做此兜底：hide→unsubscribe 与本次 subscribe 严格一配一，
          // FIFO 下再补发会双重递减、误伤同窗口其他订阅者。
          if (disposed) void invoke("unsubscribe_system_stats").catch(() => {});
        })
        .catch(() => {
          // 订阅失败（IPC 异常）：复位意图，下次可见性翻转可重试。
          subscribed = false;
        });
    };
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      void invoke("unsubscribe_system_stats").catch(() => {});
    };
    const onVisibility = () => {
      if (document.hidden) unsubscribe();
      else subscribe();
    };
    document.addEventListener("visibilitychange", onVisibility);
    subscribe();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      unlisten?.();
      unlistenHw?.();
      unsubscribe();
    };
  }, [intervalSec, opts?.netOnly]);

  return data;
}

/**
 * 全局网速显示选项 hook：订阅 settings-store，返回按用户偏好
 * （bit 计 / 简洁模式 / 隐藏单位）格式化速率的函数与上下行交换标志。
 * 所有监控组件共享同一口径（经典网速工具的全局单位设置等价物）。
 */
export function useNetRate(): {
  fmt: (bytesPerSec: number) => string;
  /** 上下行交换（↑ 在前）。 */
  swap: boolean;
} {
  const bits = useSettingsStore((s) => s.extra.netRateBits);
  const compact = useSettingsStore((s) => s.extra.netRateCompact);
  const hideUnit = useSettingsStore((s) => s.extra.netRateHideUnit);
  const swap = useSettingsStore((s) => s.extra.netSwapUpDown);
  const fmt = useCallback(
    (bps: number) => formatRateStyled(bps, { bits, compact, hideUnit }),
    [bits, compact, hideUnit]
  );
  return { fmt, swap };
}

/* ------------------------------------------------------------------ */
/* 共享格式化：开机时长 / 电池剩余时间（硬件监控与系统监控栏同口径）。      */
/* ------------------------------------------------------------------ */

/** 秒数 → 「N天 N小时 / N小时 N分 / N分 / N秒」紧凑时长（tr 译「天/小时/分/秒」）。 */
export function fmtUptime(sec: number, tr: (s: string) => string): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}${tr("天")} ${h % 24}${tr("小时")}`;
  if (h > 0) return `${h}${tr("小时")} ${m}${tr("分")}`;
  // 刚开机（<1 分钟）显示秒数，不再出现「0分」。
  return m > 0 ? `${m}${tr("分")}` : `${Math.floor(sec)}${tr("秒")}`;
}

/* ------------------------------------------------------------------ */
/* 网卡选择（共享纯逻辑）：system / sysbar / mini 统一口径。 */
/* ------------------------------------------------------------------ */

export type NetworkMode = "first" | "all" | "aggregate" | "select";

/** 选卡结果行（幽灵行速率恒为 0，up=false 供 UI 显示「未连接」）。 */
export type NetworkRow = { name: string; rx: number; tx: number; up: boolean };

/**
 * 按显示模式从广播帧的网卡列表选出要渲染的行。
 *
 * - `first`：经典网速工具 AutoSelect 思路——在连网卡中取「当前窗口收发
 *   之和」最大的一块，全零时退回第一块。修复旧实现固定取列表第一块时
 *   命中闲置虚拟网卡的问题。
 * - `all`：全部网卡（含刚断开的幽灵行，up=false）。
 * - `aggregate`：全部在连网卡求和（幽灵行速率恒 0，参与与否不影响数值，
 *   仍显式过滤以便语义清晰）。
 * - `select`：指定网卡名；名字不存在（改名/被拔）返回**幽灵行**而非空
 *   数组——整节静默消失会让用户以为组件坏了，显示「未连接」可指回设置
 *   里重新选卡（网卡回归后自动恢复真实速率）。
 *
 * @param networks - 广播帧的 NetworkInfo 列表。
 * @param mode - 显示模式。
 * @param selectName - `select` 模式下的网卡名。
 * @param aggregateLabel - 聚合行的显示名（调用方传译文）。
 */
/** 「自动选最活跃」的滞回锚点：上一拍选中的网卡名。模块级——两个活跃
 *  网卡速率接近时逐帧抖动换行（VPN+物理网卡常态），粘滞 1.5× 阈值内
 *  不换（经典网速工具 AutoSelect 同款语义）。 */
let autoSelectSticky: string | null = null;

export function selectNetworkRows(
  networks: NetworkInfo[],
  mode: NetworkMode,
  selectName = "",
  aggregateLabel = "合计"
): NetworkRow[] {
  const live = networks ?? [];
  switch (mode) {
    case "aggregate":
      return [
        {
          name: aggregateLabel,
          rx: live.reduce((s, n) => s + (n.up ? n.rx_bps : 0), 0),
          tx: live.reduce((s, n) => s + (n.up ? n.tx_bps : 0), 0),
          up: live.some((n) => n.up)
        }
      ];
    case "all":
      return live.map((n) => ({ name: n.name, rx: n.rx_bps, tx: n.tx_bps, up: n.up }));
    case "select": {
      const hit = live.find((n) => n.name === selectName);
      return hit
        ? [{ name: hit.name, rx: hit.rx_bps, tx: hit.tx_bps, up: hit.up }]
        : selectName.trim()
          ? [{ name: selectName, rx: 0, tx: 0, up: false }]
          : [];
    }
    default: {
      const connected = live.filter((n) => n.up);
      const pool = connected.length > 0 ? connected : live;
      if (pool.length === 0) {
        autoSelectSticky = null;
        return [];
      }
      const rate = (n: NetworkInfo) => n.rx_bps + n.tx_bps;
      // 全零 = 无流量信号：粘滞无依据，回退列表第一块（确定性，不空转）。
      if (!pool.some((n) => rate(n) > 0)) {
        autoSelectSticky = null;
        const first = pool[0];
        return [{ name: first.name, rx: first.rx_bps, tx: first.tx_bps, up: first.up }];
      }
      const best = pool.reduce((a, b) => (rate(b) > rate(a) ? b : a));
      const sticky = autoSelectSticky != null ? pool.find((n) => n.name === autoSelectSticky) : undefined;
      // 滞回：上一拍的选择在 1.5× 阈值内不被同量级竞争者顶掉；真爆发
      // （新网卡速率 > 粘住的 1.5×）或粘住的消失则立即切换。
      const chosen = sticky && rate(best) > rate(sticky) * 1.5 ? best : (sticky ?? best);
      autoSelectSticky = chosen.name;
      return [{ name: chosen.name, rx: chosen.rx_bps, tx: chosen.tx_bps, up: chosen.up }];
    }
  }
}
