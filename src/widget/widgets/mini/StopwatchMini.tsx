/**
 * 秒表迷你磁贴（ISLAND-MINI）：当前正计时值（运行中）或最后累计值。
 * 只读 StopwatchWidget 的持久化状态（同 key），节拍复用 useNow 共享
 * metronome（500ms 档），不自建 interval；运行中数字着主题色。
 */
import { TimerReset } from "lucide-react";
import { useT } from "../../../i18n-lite";
import { useNow } from "../../../lib/use-now";
import { fmtStopwatch } from "../StopwatchWidget";
import type { MiniComponentProps } from "../../registry";

type PersistedState = { running: boolean; startAt: number; accumulated: number; laps: number[] };

function loadState(instanceId: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(`focus-desk.stopwatch.state.${instanceId}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedState>;
    const accumulated = typeof p.accumulated === "number" && p.accumulated >= 0 ? p.accumulated : 0;
    if (p.running && typeof p.startAt === "number" && p.startAt > 0) {
      return { running: true, startAt: p.startAt, accumulated, laps: [] };
    }
    return { running: false, startAt: 0, accumulated, laps: [] };
  } catch {
    return null;
  }
}

export function StopwatchMini({ instanceId }: MiniComponentProps) {
  const tr = useT();
  // 运行中需要走秒：挂 1s 共享档驱动重渲（显示粒度是秒，500ms 每秒多一次
  // 必现重渲）；状态每次渲染重读 localStorage（O(1) JSON 解析），elapsed 用
  // Date.now() 现算。
  useNow(1000);
  const state = instanceId ? loadState(instanceId) : null;

  const elapsed = state ? state.accumulated + (state.running ? Math.max(0, Date.now() - state.startAt) : 0) : 0;
  if (!state || elapsed <= 0) {
    return (
      <span className="dock-mini dock-mini-stopwatch is-empty">
        <TimerReset size={13} className="dock-mini-ico" />
        <span className="dock-mini-num">00:00</span>
      </span>
    );
  }
  return (
    <span className={`dock-mini dock-mini-stopwatch${state.running ? " is-running" : ""}`}>
      <span className="dock-mini-num">{fmtStopwatch(elapsed, false)}</span>
      <span className="dock-mini-text">{state.running ? tr("计时中") : tr("已暂停")}</span>
    </span>
  );
}
