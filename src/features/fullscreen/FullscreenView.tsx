/**
 * 全屏展示窗视图：投影/课堂用大字时钟、倒计时、
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
import { readPomodoroLiveSnapshot } from "../../store/app-store";
import { useSettingsStore as useSettingsStoreLite } from "../../store/settings-store";
import {
  fmtBig,
  interpolatePomodoro,
  parseFullscreenKind,
  scanRunningCountdown,
  type PomodoroSnapshotLike
} from "./fullscreen-logic";
import "./fullscreen.css";

function closeSelf() {
  /*动态 import 失败不留未处理 rejection（Rust 侧 on_window_event
     兜底关窗语义不受影响）。 */
  return import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch(console.error);
}

/* 从 URL hash 解析 Rust 建窗时注入的武装代数
   （#fullscreen&kind=xx&gen=N，解析方式与 parseFullscreenKind 同款）。
   解析失败回 0——武装代数从 1 起，0 永不构成有效 ack（看门狗保持戒备，
   保守正确；浏览器直开开发页本就没有 Tauri IPC，ack 走不通道也是预期）。 */
function fullscreenGen(): number {
  const h = window.location.hash;
  const query = h.indexOf("&") >= 0 ? h.slice(h.indexOf("&") + 1) : "";
  const raw = new URLSearchParams(query).get("gen");
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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
  /* （迟加入窗口初始拉取）：全屏窗常在番茄钟暂停时打开——sync:pomodoro
     暂停态不广播，此前会永远停在「等待番茄钟数据…」。挂载时先读共享 LS
     引导快照（主同步订阅在每次发射时落盘），随后被实时广播自然接管。 */
  const [snap, setSnap] = useState<PomodoroSnapshotLike | null>(() => readPomodoroLiveSnapshot());
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
  /* （文案如实）：非运行态区分「从未开始」（待命）与「暂停中」——
     此前一律显示「专注中 · 已暂停」，刚打开还没开始的段被误读为暂停。 */
  const stateLabel = cur.running
    ? cur.mode === "focus"
      ? tr("专注中")
      : tr("休息中")
    : snap.segmentStartedAt != null
      ? `${cur.mode === "focus" ? tr("专注中") : tr("休息中")} · ${tr("已暂停")}`
      : cur.mode === "focus"
        ? tr("专注待命")
        : tr("休息待命");
  return (
    <div className="fs-body" key="running">
      <div className={`fs-clock${cur.running ? (cur.mode === "focus" ? " is-focus" : " is-break") : " is-idle"}`}>
        {fmtBig(cur.seconds)}
      </div>
      <div className="fs-date">{stateLabel}</div>
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
  /* [HUD-GIVEWAY]：鼠标悬停淡出避让（默认关）——
     全屏展示常叠加在演示内容上，让路后演示者可临时看清被挡住的区域。 */
  const giveWay = useSettingsStoreLite((s) => s.extra.hudGiveWay);
  const [hover, setHover] = useState(false);
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
    void Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/event")])
      .then(([{ getCurrentWindow }, { emit }]) => {
        /* 回发 ready ack（payload = 建窗代数）——
           Rust 侧 12s 看门狗未收到即判定 WebView 假死并关闭本窗，用户不会
           被困在无装饰真全屏窗里；正常加载时 ack 即解除看门狗，本窗无感。
           ack 失败（如浏览器直开）不阻断 show 握手。 */
        void emit("fullscreen:ready", fullscreenGen()).catch(() => {});
        const w = getCurrentWindow();
        void w.show();
        void w.setFocus();
      })
      /*import 失败不留未处理 rejection（3s 兜底会顶上）。 */
      .catch(console.error);
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
    <div
      className={`fs-root${closing ? " is-closing" : ""}${giveWay && hover ? " hud-giveway" : ""}`}
      onDoubleClick={exit}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {kind === "clock" && <ClockBody now={now} />}
      {kind === "countdown" && <CountdownBody nowMs={nowMs} />}
      {kind === "pomodoro" && <PomodoroBody nowMs={nowMs} />}
    </div>
  );
}
