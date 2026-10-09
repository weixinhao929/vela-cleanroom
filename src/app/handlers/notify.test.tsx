/**
 * PomodoroNotifier 回归：完成通知此前被「store 里的 timerMode」
 * 门控——completedSeq 自增时它已是**下一段**的计时方式。专注偏好为正计时
 * （focusTimerMode="countup"）且自动循环开启时，休息（倒计时）结束 → 下一段
 * 专注 timerMode="countup" → 通知/铃声全部静默丢失。此处直接复现该场景。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {})
}));

const notificationMock = vi.fn();
vi.mock("../../lib/notifications", () => ({
  pomodoroNotification: (...args: unknown[]) => notificationMock(...args)
}));

import { PomodoroNotifier } from "./notify";
import { useAppStore } from "../../store/app-store";

describe("PomodoroNotifier · P0-2 完成通知门控", () => {
  beforeEach(() => {
    notificationMock.mockClear();
    useAppStore.setState({
      pomodoro: {
        ...useAppStore.getState().pomodoro,
        mode: "focus",
        // 复现事故现场：休息段刚结束，reducer 已把 timerMode 切到下一段专注
        // 的用户偏好 countup。
        timerMode: "countup",
        focusTimerMode: "countup",
        isRunning: true,
        remainingSeconds: 0
      },
      pomodoroCompletedSeq: 0,
      pomodoroLastCompletedMode: null
    });
    render(<PomodoroNotifier />);
  });

  it("正计时偏好的用户在休息结束（seq 自增）时必须收到通知", () => {
    // 模拟 tickPomodoro 的完成分支：seq+1，刚结束的是短休。
    act(() => {
      useAppStore.setState((s) => ({
        pomodoroCompletedSeq: s.pomodoroCompletedSeq + 1,
        pomodoroLastCompletedMode: "shortBreak"
      }));
    });
    expect(notificationMock).toHaveBeenCalledTimes(1);
    const call = notificationMock.mock.calls[0][0] as { kind: string; sound?: { event: string } };
    expect(call.kind).toBe("mode-switch");
    expect(call.sound?.event).toBe("break-end");
  });

  it("专注结束且 autoCycle 关闭时文案不再说「休息一下」", () => {
    act(() => {
      useAppStore.setState({ pomodoroConfig: { ...useAppStore.getState().pomodoroConfig, autoCycle: false } });
      useAppStore.setState((s) => ({
        pomodoroCompletedSeq: s.pomodoroCompletedSeq + 1,
        pomodoroLastCompletedMode: "focus"
      }));
    });
    expect(notificationMock).toHaveBeenCalledTimes(1);
    const call = notificationMock.mock.calls[0][0] as { body: string };
    expect(call.body).toContain("本段专注已完成");
  });
});
