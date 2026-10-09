/**
 * （组合根瘦身）：专注（番茄钟）域全局 handler。全部组件只做副作用/订阅、
 * 渲染 null；primary-only 的组件由 App 按窗口角色挂载（事件只 emit
 * 一次，动作/媒体指令不重复执行）。职责原居 App.tsx，按域拆出；行为与
 * 注释原样迁移。
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { useSettingsStore } from "../../store/settings-store";
import { useAppStore } from "../../store/app-store";
import { setupPomodoroAutomation } from "../../lib/automation-engine";
import { setupPomodoroMediaLink } from "../../lib/pomodoro-media";
import { setTickActive } from "../../lib/chimes";
import { startAmbienceMediaGuard } from "../../lib/ambience";
import type { PresenceSnapshot } from "./presence";

/**
 * Global 1-second ticker for the Pomodoro timer. Lives at the app level so
 * the timer keeps running even when the Pomodoro widget is hidden or on
 * another view. The store action handles session recording internally.
 *
 * A-tick failover（审计修复，二期下沉 Rust）：
 *  1. 主时钟下沉 Rust 心跳（app:heartbeat，原生线程每秒定向 widget-0 广播，
 *     事件派发不受隐藏 WebView 的 Chromium 定时器节流影响——此前副屏倒计时
 *     分钟级跳动）；
 *  2. primary 每拍回 heartbeat_ack，Rust 检测失联（>5s）后把心跳切换为全
 *     widget 窗口 + 设置窗广播，副屏接管不再依赖自身被节流的 JS interval
 *     轮询 localStorage 竞选；primary 恢复应答自动回到定向模式；
 *  3. JS interval 仅作兜底；tickPomodoro 按墙钟锚点幂等计算，双源重复触发
 *     无副作用。
 */
export function GlobalPomodoroTicker() {
  const isRunning = useAppStore((s) => s.pomodoro.isRunning);
  const tick = useAppStore((s) => s.tickPomodoro);
  /* 公共 hook（浏览器模式 no-op + 静默失败），替代手写的「动态 import →
     listen → disposed 守卫」样板——手写版漏了 .catch，浏览器开发模式每次
     开始计时都产生一条 unhandled rejection 并被记入崩溃日志。 */
  useTauriEvent<number>("app:heartbeat", (beat) => {
    tick(typeof beat === "number" ? beat : undefined);
    // 喂狗：Rust 以此判定 primary WebView 存活（见 lib.rs failover 注释）。
    void invoke("heartbeat_ack").catch(() => {});
  });
  /* 把番茄钟运行态同步给 Rust 心跳线程——没在跑时线程在 Condvar 上
     真挂起（每秒一次的原生唤醒 + 事件序列化全免），跑起来再唤醒。
     组件只在 primary 挂载，所以「谁消费心跳谁开关」。失败静默：心跳
     保持默认开启，行为不劣化。 */
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_heartbeat_enabled", { enabled: isRunning }).catch(() => {});
  }, [isRunning]);
  useEffect(() => {
    if (!isRunning) return;
    // 兜底节拍（Rust 心跳失联且尚未 failover 的空窗期）。
    const interval = window.setInterval(tick, 1000);
    // 从后台节流/睡眠恢复可见时立即重算一次，把倒计时拉回墙钟真实值。
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isRunning, tick]);
  return null;
}

/**
 * A-tick failover 副屏/设置窗候补：二期改为纯事件驱动——Rust 检测 primary
 * 失联后把 app:heartbeat 广播到全部 widget 窗口与设置窗，本组件收到即 tick
 * （tickPomodoro 幂等，短暂双主无副作用）。primary 恢复定向投递后本窗口
 * 自然收不到心跳，无需让位协议；原先的 localStorage liveness/claim 轮询
 * 在隐藏 WebView 里会被 Chromium 节流到 ~1 次/分，接管检测本身分钟级迟到。
 */
export function StandbyPomodoroTicker() {
  const isRunning = useAppStore((s) => s.pomodoro.isRunning);
  const tick = useAppStore((s) => s.tickPomodoro);
  useTauriEvent<number>("app:heartbeat", (beat) => {
    // 读即时态而非闭包：failover 期间本窗可能刚好暂停了专注。拍号透传给
    // tickPomodoro，双主同拍完成时按拍号跨窗去重落库。
    if (useAppStore.getState().pomodoro.isRunning) tick(typeof beat === "number" ? beat : undefined);
  });
  /* primary 失联期间由本窗接管计时：用户在此窗停止专注时也要把心跳线程
     挂起（幂等 IPC，与 primary 并发表态同一值无副作用）。 */
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_heartbeat_enabled", { enabled: isRunning }).catch(() => {});
  }, [isRunning]);
  return null;
}

/**
 * App-level "游戏时暂停" handler. Lives here (not inside the Pomodoro widget)
 * so a fullscreen game pauses the countdown even when the Pomodoro widget is
 * hidden or on another view — otherwise the timer keeps running under a
 * covered screen and records misleading durations.
 */
export function GlobalGamePause() {
  useEffect(() => {
    if (!isTauri()) return;
    let unEnter: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let disposed = false;
    let autoPaused = false;
    void listen<unknown>("focus:game-paused-entered", () => {
      if (!useSettingsStore.getState().general.pauseDuringGaming) return;
      if (useAppStore.getState().pomodoro.isRunning) {
        autoPaused = true;
        useAppStore.getState().togglePomodoro();
      }
    })
      .then((f) => {
        if (disposed) f();
        else unEnter = f;
        /* 监听失败兜底，不留未处理 rejection（游戏暂停只是增强行为）。 */
      })
      .catch((err: unknown) => console.error("[focus] listen game-paused-entered failed:", err));
    void listen<unknown>("focus:game-paused-exited", () => {
      if (autoPaused) {
        autoPaused = false;
        // 用户可能在自动暂停期间已手动继续：此时不能再 toggle（会把刚开始的
        // 计时反向暂停），只清标记。
        if (!useAppStore.getState().pomodoro.isRunning) useAppStore.getState().togglePomodoro();
      }
    })
      .then((f) => {
        if (disposed) f();
        else unExit = f;
        /* 监听失败兜底，不留未处理 rejection。 */
      })
      .catch((err: unknown) => console.error("[focus] listen game-paused-exited failed:", err));
    return () => {
      disposed = true;
      unEnter?.();
      unExit?.();
    };
  }, []);
  return null;
}

/** §4.6 空闲打断阈值：无键鼠输入达到该秒数（且"空闲时暂停"开启）时暂停专注。 */
const IDLE_PAUSE_SECS = 5 * 60;

/**
 * §4.6 presence「空闲时暂停」handler：与 GlobalGamePause 同型——idle 态且
 * 空闲秒数越过阈值时暂停专注（仅一次），恢复 active 自动续跑。Rust 侧
 * Idle 稳态每 30s 重发一次快照，错过首个事件也能在下一拍补上；采样降载
 * （sys:stats/音频）由 Rust presence 线程独立完成，不经过本组件。
 */
export function GlobalIdlePause() {
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    let disposed = false;
    let autoPaused = false;
    void listen<PresenceSnapshot>("presence:state", (e) => {
      const p = e.payload;
      if (!p) return;
      if (p.state === "idle") {
        if (
          !autoPaused &&
          useSettingsStore.getState().general.pauseWhenIdle &&
          p.idle_secs >= IDLE_PAUSE_SECS &&
          useAppStore.getState().pomodoro.isRunning
        ) {
          autoPaused = true;
          useAppStore.getState().togglePomodoro();
        }
      } else if (p.state === "active" && autoPaused) {
        autoPaused = false;
        // 同 GamePause：用户手动继续后（该点击本身会让 presence 变 active）不再反向 toggle。
        if (!useAppStore.getState().pomodoro.isRunning) useAppStore.getState().togglePomodoro();
      }
    })
      .then((f) => {
        if (disposed) f();
        else un = f;
        /* 监听失败兜底，不留未处理 rejection（空闲暂停只是增强行为）。 */
      })
      .catch((err: unknown) => console.error("[focus] listen presence:state failed:", err));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);
  return null;
}

/**
 * （wait-activity 推进门）：presence 翻回 active 时若下一段
 * 专注正处于「等你回来」就位态，自动开始。仅 primary 挂载（与 tick 同窗口，
 * 避免多屏重复启动）；togglePomodoro 返回 false（未选事件）时清掉等待标记，
 * 由用户手动接管。
 */
export function GlobalActivityGate() {
  useTauriEvent<PresenceSnapshot>("presence:state", (p) => {
    if (p?.state !== "active") return;
    const st = useAppStore.getState();
    if (!st.pomodoro.awaitingActivity || st.pomodoro.isRunning) return;
    if (!st.togglePomodoro()) st.clearAwaitingActivity();
  });
  return null;
}

/**
 * （Automation + MPRIS）：专注自动化引擎与媒体联动的挂载点，
 * 仅 primary 窗口运行（事件只 emit 一次，动作/媒体指令不重复执行）。
 */
export function PomodoroAutomationHost() {
  useEffect(() => setupPomodoroAutomation(), []);
  useEffect(() => setupPomodoroMediaLink(), []);
  return null;
}

/**
 * （媒体在播时抑制白噪音）：media:snapshot → ambience 守卫。
 * 每个 widget 窗口各自守卫自己的音频图（氛围音的 AudioContext 就在其中某个
 * widget 窗口里）；设置窗等非 widget 窗口不挂（收不到该事件）。
 */
export function AmbienceMediaGuard() {
  useEffect(() => startAmbienceMediaGuard(), []);
  return null;
}

/**
 * （滴答声）：专注运行中按设置循环播放挂钟/节拍器背景音。
 * 仅 primary 窗口——多屏窗口各播一路会叠加响度。tick 音色 none / 未运行时
 * 由 chimes 模块自行停止（卸载兜底）。
 */
export function FocusTickPlayer() {
  const tickSound = useSettingsStore((s) => s.notifications.pomodoroTickSound ?? "none");
  const tickVolume = useSettingsStore((s) => s.notifications.pomodoroTickVolume ?? 50);
  const isRunning = useAppStore((s) => s.pomodoro.isRunning);
  const mode = useAppStore((s) => s.pomodoro.mode);
  useEffect(() => {
    const active = isRunning && mode === "focus" && tickSound !== "none";
    setTickActive(tickSound, tickVolume / 100, active);
    return () => setTickActive("none", 0, false);
  }, [tickSound, tickVolume, isRunning, mode]);
  return null;
}
