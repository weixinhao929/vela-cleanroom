/**
 * 全屏展示窗视图（借鉴 ClassSoftwareHub #5）：投影/课堂用大字时钟、倒计时、
 * 番茄钟。独立于桌面层 store——时钟走 useNow，倒计时扫 localStorage 运行态，
 * 番茄钟吃 sync:pomodoro 快照 + 墙钟插值。Esc / 双击退出；窗口由 Rust
 * visible(false) + 真全屏创建，本视图就绪后自行 show。日期/星期用 Intl
 * 按 OS 语言格式化（零词典依赖）。
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n-lite";
import { prefersReducedMotion } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useNow } from "../../lib/use-now";
import { useTauriEvent } from "../../lib/use-tauri-event";
import {
  fmtBig,
  interpolatePomodoro,
  parseFullscreenKind,
  scanRunningCountdown,
  type PomodoroSnapshotLike
} from "./fullscreen-logic";
import "./fullscreen.css";

function closeSelf() {
  return import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
}

function ClockBody({ now }: { now: Date }) {
  const tr = useT();
  const p = (n: number) => String(n).padStart(2, "0");
  const hh = p(now.getHours());
  const mm = p(now.getMinutes());
  const ss = p(now.getSeconds());
  const locale = navigator.language || "zh-CN";
  const date = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(now);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(now);
  return (
    <div className="fs-body">
      <div className="fs-clock">
        <span>{hh}</span>
        <span className="fs-colon">:</span>
        <span>{mm}</span>
        <span className="fs-seconds">{ss}</span>
      </div>
      <div className="fs-date">
        {date} · {weekday}
      </div>
      <span className="fs-exit-hint">{tr("按 Esc 或双击退出")}</span>
    </div>
  );
}

function CountdownBody({ nowMs }: { nowMs: number }) {
  const tr = useT();
  const running = scanRunningCountdown(localStorage, nowMs);
  if (!running) {
    /* key=数据态：占位 ↔ 数据切换重挂 fs-body 重播上浮入场，替代硬切。 */
    return (
      <div className="fs-body" key="placeholder">
        <div className="fs-clock fs-placeholder">{tr("没有正在运行的倒计时")}</div>
        <div className="fs-date">{tr("在倒计时小组件上开始计时后再进入全屏")}</div>
        <span className="fs-exit-hint">{tr("按 Esc 或双击退出")}</span>
      </div>
    );
  }
  const remain = Math.max(0, Math.round((running.endAt - nowMs) / 1000));
  return (
    <div className="fs-body" key="running">
      <div className={`fs-clock${remain === 0 ? " is-done" : ""}`}>{fmtBig(remain)}</div>
      <div className="fs-date">{remain === 0 ? tr("时间到") : tr("倒计时进行中")}</div>
      <span className="fs-exit-hint">{tr("按 Esc 或双击退出")}</span>
    </div>
  );
}

function PomodoroBody({ nowMs }: { nowMs: number }) {
  const tr = useT();
  const [snap, setSnap] = useState<PomodoroSnapshotLike | null>(null);
  useTauriEvent<PomodoroSnapshotLike>("sync:pomodoro", (payload) => {
    if (payload && payload.pomodoro && typeof payload.pomodoro.isRunning === "boolean") {
      setSnap(payload);
    }
  });
  if (!snap) {
    return (
      <div className="fs-body" key="placeholder">
        <div className="fs-clock fs-placeholder">{tr("等待番茄钟数据…")}</div>
        <div className="fs-date">{tr("在番茄钟上开始专注后自动显示")}</div>
        <span className="fs-exit-hint">{tr("按 Esc 或双击退出")}</span>
      </div>
    );
  }
  const cur = interpolatePomodoro(snap, nowMs);
  const label = cur.mode === "focus" ? tr("专注中") : tr("休息中");
  return (
    <div className="fs-body" key="running">
      <div className={`fs-clock${cur.running ? (cur.mode === "focus" ? " is-focus" : " is-break") : " is-idle"}`}>
        {fmtBig(cur.seconds)}
      </div>
      <div className="fs-date">
        {label}
        {cur.running ? "" : ` · ${tr("已暂停")}`}
      </div>
      <span className="fs-exit-hint">{tr("按 Esc 或双击退出")}</span>
    </div>
  );
}

export function FullscreenView() {
  const kind = parseFullscreenKind(window.location.hash);
  /* 1s 档：显示粒度是秒，500ms 意味着每秒两次必现重渲（setNow 引用必变，
     不 bail out），纯浪费。 */
  const now = useNow(1000);
  const nowMs = now.getTime();
  const shownRef = useRef(false);
  /* 退场淡出：Esc/双击先播 is-closing 再关窗（此前直接 closeSelf，窗口瞬消）。 */
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const exit = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(() => void closeSelf(), prefersReducedMotion() ? 30 : Math.round(animDurations().fxMs) + 30);
  };

  /* 就绪握手：首帧渲染后自行 show（Rust 侧 3s 兜底）。 */
  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      void w.show();
      void w.setFocus();
    });
  }, []);

  /* Esc 退出。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`fs-root${closing ? " is-closing" : ""}`} onDoubleClick={exit}>
      {kind === "clock" && <ClockBody now={now} />}
      {kind === "countdown" && <CountdownBody nowMs={nowMs} />}
      {kind === "pomodoro" && <PomodoroBody nowMs={nowMs} />}
    </div>
  );
}
