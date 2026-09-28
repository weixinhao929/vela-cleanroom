import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "./app-store";
import { createInitialState } from "../domain/pomodoro";

/**
 * A-1 墙钟锚点：计时进度由 (Date.now() - segmentAnchorMs) 反推，而非 tick
 * 次数。系统睡眠 / 后台节流导致 tick 停摆后，唤醒后的第一次 tick 即可把
 * remaining 拉回墙钟真实值。本组用 fake timers 推进系统时间模拟「tick 完全
 * 停摆、墙钟继续走」的场景。
 */
describe("番茄钟墙钟锚点（A-1）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 0));
    localStorage.clear();
    useAppStore.setState({
      pomodoro: createInitialState(useAppStore.getState().pomodoroConfig),
      sessions: [],
      interruptions: []
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const startFocus = () => {
    const s = useAppStore.getState();
    s.selectPomodoroEvent(null, "测试专注");
    expect(s.togglePomodoro()).toBe(true);
    const p = useAppStore.getState().pomodoro;
    expect(p.isRunning).toBe(true);
    expect(p.remainingSeconds).toBe(25 * 60);
  };

  it("tick 停摆 100 秒后唤醒：一次 tick 即按墙钟差缩短 100 秒", () => {
    startFocus();
    // 模拟系统睡眠：墙钟前进 100 秒，期间没有任何 tick。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 1, 40));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 100);
  });

  it("连续 tick 与墙钟同步：每秒一次 tick 时 remaining 逐秒递减", () => {
    startFocus();
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(new Date(2026, 7, 18, 10, 0, i));
      useAppStore.getState().tickPomodoro();
      expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - i);
    }
  });

  it("暂停冻结墙钟值并清除锚点：暂停期间墙钟前进不影响恢复后的倒计时", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 60));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 60);

    // 暂停：remaining 冻结在墙钟真实值。
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    expect(useAppStore.getState().pomodoro.isRunning).toBe(false);
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 60);

    // 暂停 5 分钟：恢复后锚点重设，remaining 从冻结值继续。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 6, 0));
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 60);

    // 恢复 30 秒后的一次 tick：只扣 30 秒，暂停的 5 分钟不计入。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 6, 30));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 90);
  });

  it("resetPomodoro 清锚点：重置后不运行的 tick 无副作用", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 10));
    useAppStore.getState().resetPomodoro();
    const after = useAppStore.getState().pomodoro;
    expect(after.isRunning).toBe(false);
    expect(after.remainingSeconds).toBe(25 * 60);
    // 重置后（未运行）tick 不改变状态。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 5, 0));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60);
  });
});
