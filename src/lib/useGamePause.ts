import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../store/settings-store";
import { isTauri } from "./tauri";

/**
 * 全屏应用（游戏）接管屏幕时自动暂停计时器，退出全屏后恢复倒计时。
 * 保证用户不在桌面前时计时诚实；由「游戏时暂停」设置
 * （`general.pauseDuringGaming`）门控。
 *
 * `isRunning`/`toggle` 经 ref 每次渲染同步（P2 修复：此前只在挂载时赋值
 * 一次会拿到过期闭包），hook 因此永不重订阅原生事件通道。
 *
 * @param opts - `isRunning`：读取计时是否运行中（实时调用）；`toggle`：
 *                切换运行状态（暂停/恢复都靠它）。
 * @returns 无（副作用型 hook）；浏览器模式为 no-op。
 * @throws 无（listen 失败静默忽略）。
 *
 * @example
 * ```tsx
 * useGamePause({ isRunning: () => pomodoro.isRunning, toggle: () => togglePomodoro() });
 * ```
 */
export function useGamePause(opts: { isRunning: () => boolean; toggle: () => void }) {
  // P2（审计修复）：refs 此前只在挂载 effect 里赋值一次——注释声称
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
    }).then((f) => {
      if (disposed) f();
      else unEnter = f;
    });
    void listen<unknown>("focus:game-paused-exited", () => {
      if (autoPaused) {
        autoPaused = false;
        toggleRef.current();
      }
    }).then((f) => {
      if (disposed) f();
      else unExit = f;
    });

    return () => {
      disposed = true;
      unEnter?.();
      unExit?.();
    };
  }, []);
}
