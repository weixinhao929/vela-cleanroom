/**
 * （MPRIS 插件）：专注期系统媒体自动暂停 / 智能恢复。
 *
 *  - 专注段开始运行 → 暂停全部在播媒体会话（黑名单除外），记下哪些是
 *    我们暂停的（auto_paused 语义）；
 *  - 专注结束 / 进入休息 / 中断 / 停止 → 智能恢复：若此刻有别的播放器
 *    在播（不是我们暂停的——用户休息时手动开了别的音乐），不顶掉它；
 *    否则恢复我们暂停的那批会话，随后清账。
 *
 * Rust 侧提供两条无状态命令（pomodoro_media_pause_all / pomodoro_media_resume），
 * 会话清单不跨进程持久化——重启丢失 auto_paused 只是少恢复一次，无副作用。
 * 仅挂载在 primary widget 窗口。
 */

import { invoke, isTauri } from "./tauri";
import { onPomodoroEvent, type PomodoroEventName } from "../domain/automation";
import { useSettingsStore } from "../store/settings-store";

/** 被本引擎暂停的媒体会话 AUMID（ auto_paused 集合）。 */
let autoPausedAumids: string[] = [];
/** 恢复流程互斥（focus-finish 与 break-start 常连续触发）。 */
let resuming = false;

interface MediaSessionBrief {
  id: string;
  playing: boolean;
}

async function pauseAllPlaying(): Promise<void> {
  try {
    const paused = await invoke<string[]>("pomodoro_media_pause_all");
    autoPausedAumids = paused;
  } catch {
    autoPausedAumids = [];
  }
}

async function smartResume(): Promise<void> {
  if (resuming || autoPausedAumids.length === 0) return;
  resuming = true;
  const aumids = autoPausedAumids;
  autoPausedAumids = [];
  try {
    // 恢复前检查：有别处在播（非我们所暂停）就不恢复。
    const sessions = await invoke<MediaSessionBrief[]>("list_media_sessions");
    const othersPlaying = (sessions ?? []).some((s) => s.playing && !aumids.includes(s.id));
    if (!othersPlaying) {
      await invoke("pomodoro_media_resume", { aumids });
    }
  } catch {
    // 媒体恢复失败静默——绝不能打断专注主流程
  } finally {
    resuming = false;
  }
}

const RESUME_EVENTS: readonly PomodoroEventName[] = ["break-start", "focus-finish", "interrupt", "stop", "skip"];

/**
 * 启动媒体联动引擎（读取 settings.general.media.focusPause 开关）。
 *
 * @returns 退订函数（幂等）。开关关闭时若仍有未恢复的会话，先恢复再挂起。
 */
export function setupPomodoroMediaLink(): () => void {
  if (!isTauri()) return () => {};
  const off = onPomodoroEvent((name) => {
    const enabled = useSettingsStore.getState().general.media?.focusPause === true;
    if (!enabled) {
      if (autoPausedAumids.length > 0) void smartResume();
      return;
    }
    if (name === "focus-start") {
      void pauseAllPlaying();
    } else if (RESUME_EVENTS.includes(name)) {
      void smartResume();
    }
  });
  return off;
}
