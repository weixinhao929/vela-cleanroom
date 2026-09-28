/* eslint-disable react-refresh/only-export-components -- 纯函数与组件同文件导出供测试与迷你磁贴复用（FileBrowserWidget 同款惯例） */
/**
 * 秒表小组件（借鉴 ClassSoftwareHub #3）：正计时 + 计次（保留最近 N 次，
 * 从新到旧展示差值与累计值）。计时基准用绝对时间戳（startAt + accumulated
 * 换算，与倒计时同一套「重启后接着跑」方案）；计次记录随状态持久化。
 * 无「结束」语义，不参与托盘仲裁；rAF 循环仅运行期间存在。
 */
import { useEffect, useRef, useState } from "react";
import { Flag, Pause, Play, RotateCcw, TimerReset } from "lucide-react";
import { persistMirrored } from "../../lib/local-backup";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";

type PersistedState = {
  running: boolean;
  /** 本次运行的起点（running=true 时有效）。 */
  startAt: number;
  /** 暂停前累计的毫秒数。 */
  accumulated: number;
  /** 计次点（累计毫秒，升序）。 */
  laps: number[];
};

function stateKey(instanceId: string) {
  return `focus-desk.stopwatch.state.${instanceId}`;
}

function loadPersisted(instanceId: string): PersistedState {
  try {
    const raw = localStorage.getItem(stateKey(instanceId));
    if (!raw) return { running: false, startAt: 0, accumulated: 0, laps: [] };
    const p = JSON.parse(raw) as Partial<PersistedState>;
    const accumulated = typeof p.accumulated === "number" && p.accumulated >= 0 ? p.accumulated : 0;
    const laps = Array.isArray(p.laps) ? p.laps.filter((n): n is number => typeof n === "number" && n >= 0) : [];
    if (p.running && typeof p.startAt === "number" && p.startAt > 0) {
      return { running: true, startAt: p.startAt, accumulated, laps };
    }
    return { running: false, startAt: 0, accumulated, laps };
  } catch {
    return { running: false, startAt: 0, accumulated: 0, laps: [] };
  }
}

/** 毫秒 → 秒表文本：h:mm:ss.cc / mm:ss.cc（showCentis=false 时无百分秒）。 */
export function fmtStopwatch(ms: number, showCentis = true): string {
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const cs = Math.floor((total % 1000) / 10);
  const body =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return showCentis ? `${body}.${String(cs).padStart(2, "0")}` : body;
}

/** 计次行：从新到旧，含与上一次的差值。 */
export function lapRows(laps: readonly number[]): { index: number; delta: number; cumulative: number }[] {
  const out: { index: number; delta: number; cumulative: number }[] = [];
  for (let i = laps.length - 1; i >= 0; i--) {
    out.push({ index: i + 1, delta: laps[i] - (i > 0 ? laps[i - 1] : 0), cumulative: laps[i] });
  }
  return out;
}

export function StopwatchWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const { config, update } = useWidgetConfig(instanceId);
  const showCentis = config.showCentis !== false;
  const lapLimit = Math.min(50, Math.max(3, (config.lapLimit as number) || 10));

  const [restored] = useState(() => loadPersisted(instanceId));
  const [running, setRunning] = useState(restored.running);
  const [accumulated, setAccumulated] = useState(restored.accumulated);
  const [laps, setLaps] = useState<number[]>(restored.laps);
  /* 二.1 渲染分层（对齐 ClockWidget 内置秒表）：百分秒 30fps 直写 DOM
     （csRef.textContent，不进 React），整卡重渲只在秒翻转时发生（1Hz）——
     旧版 forceTick 每帧 setState，以 60fps 重渲含计次列表/按钮的整棵子树。 */
  const [, tickSecond] = useState(0);

  const startRef = useRef(restored.startAt);
  const accumulatedRef = useRef(accumulated);
  accumulatedRef.current = accumulated;
  const lapsRef = useRef(laps);
  lapsRef.current = laps;
  /* 运行中当前累计毫秒：rAF 每帧直写；暂停/重置时同步写一次。 */
  const elapsedRef = useRef(
    restored.running && restored.startAt > 0
      ? restored.accumulated + (Date.now() - restored.startAt)
      : restored.accumulated
  );
  const lastSecRef = useRef(-1);
  const csRef = useRef<HTMLSpanElement>(null);

  const stateRef = useRef({ running, startAt: startRef, accumulated, laps });
  stateRef.current = { running, startAt: startRef, accumulated, laps };
  const lastWriteRef = useRef(0);

  const paintCs = () => {
    if (csRef.current) {
      csRef.current.textContent = String(Math.floor((elapsedRef.current % 1000) / 10)).padStart(2, "0");
    }
  };

  /** 节流落盘：状态切换立即写，运行中最多 3s 一次（与倒计时同规格）。 */
  const persist = (force = true) => {
    const now = Date.now();
    if (!force && now - lastWriteRef.current < 3000) return;
    lastWriteRef.current = now;
    const s = stateRef.current;
    persistMirrored(
      stateKey(instanceId),
      JSON.stringify({ running: s.running, startAt: s.startAt.current, accumulated: s.accumulated, laps: s.laps })
    );
  };

  useEffect(() => {
    if (!running) return;
    /* rAF 而非 setInterval：节奏与刷新率一致，窗口被遮挡时浏览器自动暂停
       rAF（显示冻结、恢复后按墙钟追平，不丢时）。百分秒 30fps 已限速。 */
    const CS_INTERVAL_MS = 33;
    let raf = 0;
    let lastPaint = 0;
    /* raf: ok 计时数据（厘秒走字）非装饰动画，遮挡时 rAF 自动暂停 */
    const loop = (now: number) => {
      elapsedRef.current = accumulatedRef.current + (Date.now() - startRef.current);
      if (now - lastPaint >= CS_INTERVAL_MS) {
        lastPaint = now;
        paintCs();
      }
      const total = Math.floor(elapsedRef.current / 1000);
      if (total !== lastSecRef.current) {
        lastSecRef.current = total;
        tickSecond((v) => v + 1);
      }
      persist(false);
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    persist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, laps.length]);

  /* 每次渲染后同步一次百分秒文本：暂停 / 重置 / 显隐配置切换时 rAF 不在跑。 */
  useEffect(() => {
    paintCs();
  });

  const elapsed = elapsedRef.current;

  function toggle() {
    if (running) {
      const nowElapsed = accumulated + (Date.now() - startRef.current);
      elapsedRef.current = nowElapsed;
      setAccumulated(nowElapsed);
      setRunning(false);
      startRef.current = 0;
    } else {
      startRef.current = Date.now();
      lastSecRef.current = -1;
      setRunning(true);
    }
  }

  function lap() {
    /* 计次取点击时刻的精确值（与 toggle 暂停同源），不用 rAF 上一帧的 ref——
       逐帧 ref 与真实墙钟最多差一帧，计次差值会带 ±一帧误差。 */
    const nowElapsed = running ? accumulatedRef.current + (Date.now() - startRef.current) : accumulatedRef.current;
    if (nowElapsed <= 0) return;
    setLaps((prev) => [...prev, nowElapsed].slice(-lapLimit));
  }

  function reset() {
    setRunning(false);
    startRef.current = 0;
    elapsedRef.current = 0;
    lastSecRef.current = -1;
    setAccumulated(0);
    setLaps([]);
  }

  /* 计次列表：新增行走 .sw-lap 进场动画；清空时容器播 .is-closing 淡出再卸载
     （useDelayedUnmount + 最后一份行快照，key 不变不重挂、行动画不重播）。 */
  const rows = lapRows(laps);
  const lapsVisible = useDelayedUnmount(laps.length > 0, Math.round(animDurations().fxMs));
  const lastRows = useRef(rows);
  if (rows.length > 0) lastRows.current = rows;
  const shownRows = rows.length > 0 ? rows : lastRows.current;

  return (
    <div className="sw">
      <div className={`sw-display${running ? " is-running" : ""}`} data-interactive>
        {fmtStopwatch(elapsed, false)}
        {showCentis && (
          <>
            .<span ref={csRef}>{String(Math.floor((elapsed % 1000) / 10)).padStart(2, "0")}</span>
          </>
        )}
      </div>
      <div className="sw-actions">
        <button className="sw-btn is-primary" onClick={toggle} data-interactive>
          {running ? <Pause size={13} /> : <Play size={13} />}
          {running ? tr("暂停") : accumulated > 0 ? tr("继续") : tr("开始")}
        </button>
        <button className="sw-btn" onClick={lap} disabled={elapsed <= 0} title={tr("记录一次计次")} data-interactive>
          <Flag size={13} />
          {tr("计次")}
        </button>
        <button className="sw-btn" onClick={reset} disabled={elapsed <= 0 && laps.length === 0} data-interactive>
          <RotateCcw size={13} />
          {tr("重置")}
        </button>
      </div>
      {lapsVisible && shownRows.length > 0 ? (
        <div className={`sw-laps${rows.length === 0 ? " is-closing" : ""}`} data-interactive>
          {shownRows.map((r) => (
            <div key={r.index} className="sw-lap">
              <span className="sw-lap-idx">{tr("第 {n} 次", { n: r.index })}</span>
              <span className="sw-lap-delta">+{fmtStopwatch(r.delta, true)}</span>
              <span className="sw-lap-total">{fmtStopwatch(r.cumulative, true)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="sw-empty">
          <TimerReset size={16} />
          {tr("无计次记录")}
        </div>
      )}
      <label className="sw-cfg-hint" data-interactive>
        <input type="checkbox" checked={showCentis} onChange={(e) => update({ showCentis: e.target.checked })} />
        {tr("显示百分秒")}
      </label>
    </div>
  );
}
