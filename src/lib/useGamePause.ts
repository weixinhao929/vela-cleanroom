import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../store/settings-store";
import { isTauri } from "./tauri";

/**
 * 全屏应用（游戏）接管屏幕时自动暂停计时器，退出全屏后恢复倒计时。
 * 保证用户不在桌面前时计时诚实；由「游戏时暂停」设置
 * （`general.pauseDuringGaming`）门控。
 *
 * `isRunning`/`toggle` 经 ref 每次渲染同步（修复：此前只在挂载时赋值
 * 一次会拿到过期闭包），hook 因此永不重订阅原生事件通道。
 *
 * @param opts - `isRunning`：读取计时是否运行中（实时调用）；`toggle`：
 *                切换运行状态（暂停/恢复都靠它）。
 * @returns 无（副作用型 hook）；浏览器模式为 no-op。
 * @throws 无（listen 失败静默忽略）。
 *
 * @example
 * `tsx
 * useGamePause({ isRunning: () => pomodoro.isRunning, toggle: () => togglePomodoro() });
 * `
 */
export function useGamePause(opts: { isRunning: () => boolean; toggle: () => void }) {
  // refs 此前只在挂载 effect 里赋值一次——注释声称
  // "Keep the latest callbacks in refs"，实际之后传入的新闭包永不更新，
  // 任何按直觉传普通箭头函数的调用方都会拿到过期状态。改为每次渲染同步。
  const isRunningRef = useRef(opts.isRunning);
  const toggleRef = useRef(opts.toggle);
  isRunningRef.current = opts.isRunning;
  toggleRef.current = opts.toggle;

  useEffect(() => {
    if (!isTauri()) return;

    let unEnter: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let disposed = false;
    let autoPaused = false;

    void listen<unknown>("focus:game-paused-entered", () => {
      if (!useSettingsStore.getState().general.pauseDuringGaming) return;
      if (isRunningRef.current()) {
        autoPaused = true;
        toggleRef.current();
      }
    })
      .then((f) => {
        if (disposed) f();
        else unEnter = f;
      })
      /* 监听注册失败不留未处理 rejection（同款样板
         focus.tsx/notify.tsx 均有，此处此前是全仓手写链里唯一漏网）。 */
      .catch((err: unknown) => console.error("[game-pause] listen entered failed:", err));
    void listen<unknown>("focus:game-paused-exited", () => {
      if (autoPaused) {
        autoPaused = false;
        // 恢复守卫：游戏期间用户可能经快捷键/托盘手动恢复，此刻已在运行——
        // 盲 toggle 会把运行中的倒计时反向暂停（与番茄钟同型 handler 同款守卫）。
        if (!isRunningRef.current()) toggleRef.current();
      }
    })
      .then((f) => {
        if (disposed) f();
        else unExit = f;
      })
      .catch((err: unknown) => console.error("[game-pause] listen exited failed:", err));

    return () => {
      disposed = true;
      unEnter?.();
      unExit?.();
    };
  }, []);
}
