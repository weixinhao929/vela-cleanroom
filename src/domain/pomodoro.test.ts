import { describe, expect, it } from "vitest";
import {
  buildInterruption,
  buildSessionRecord,
  createInitialState,
  normalizeConfig,
  plannedSecondsFor,
  pomodoroReducer,
  DEFAULT_CONFIG
} from "./pomodoro";

const cfg = {
  ...DEFAULT_CONFIG,
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakInterval: 4,
  autoStartNext: false,
  autoCycle: false
};

describe("pomodoroReducer", () => {
  it("creates an initial focus state with full duration, not running", () => {
    const s = createInitialState(cfg);
    expect(s.mode).toBe("focus");
    expect(s.remainingSeconds).toBe(25 * 60);
    expect(s.isRunning).toBe(false);
    expect(s.completedFocusSessions).toBe(0);
  });

  it("ignores ticks while not running", () => {
    const s = createInitialState(cfg);
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next).toEqual(s);
  });

  it("decrements by one second when running", () => {
    const running = { ...createInitialState(cfg), isRunning: true };
    const next = pomodoroReducer(running, { type: "tick" }, cfg);
    expect(next.remainingSeconds).toBe(25 * 60 - 1);
    expect(next.isRunning).toBe(true);
  });

  it("toggles running state", () => {
    const s = createInitialState(cfg);
    expect(pomodoroReducer(s, { type: "toggle" }, cfg).isRunning).toBe(true);
    expect(pomodoroReducer({ ...s, isRunning: true }, { type: "toggle" }, cfg).isRunning).toBe(false);
  });

  it("resets current mode duration and stops", () => {
    const running = { ...createInitialState(cfg), isRunning: true, remainingSeconds: 100 };
    const next = pomodoroReducer(running, { type: "reset" }, cfg);
    expect(next.remainingSeconds).toBe(25 * 60);
    expect(next.isRunning).toBe(false);
  });

  it("a completed focus returns to a fresh paused focus (no break cycle)", () => {
    const running = { ...createInitialState(cfg), isRunning: true, remainingSeconds: 1, completedFocusSessions: 2 };
    const next = pomodoroReducer(running, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.remainingSeconds).toBe(25 * 60);
    expect(next.isRunning).toBe(false);
    expect(next.completedFocusSessions).toBe(3);
  });

  it("a completed focus keeps focus mode regardless of interval", () => {
    const running = { ...createInitialState(cfg), isRunning: true, remainingSeconds: 1, completedFocusSessions: 3 };
    const next = pomodoroReducer(running, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.remainingSeconds).toBe(25 * 60);
    expect(next.completedFocusSessions).toBe(4);
  });

  it("a completed focus does not auto-start a break; it stays paused", () => {
    const running = { ...createInitialState(cfg), isRunning: true, remainingSeconds: 1, completedFocusSessions: 4 };
    const next = pomodoroReducer(running, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.remainingSeconds).toBe(25 * 60);
    expect(next.completedFocusSessions).toBe(5);
    expect(next.isRunning).toBe(false);
  });

  it("setMode changes mode and resets duration", () => {
    const s = createInitialState(cfg);
    const next = pomodoroReducer(s, { type: "setMode", mode: "longBreak" }, cfg);
    expect(next.mode).toBe("longBreak");
    expect(next.remainingSeconds).toBe(15 * 60);
    expect(next.isRunning).toBe(false);
  });

  it("setMode to a break forces countdown even from a countup focus", () => {
    // A countup focus must not leak into a break: switching to a break should
    // reset to the full break duration and run as countdown, not count up from 0.
    const countupFocus = {
      ...createInitialState(cfg),
      timerMode: "countup" as const,
      focusTimerMode: "countup" as const,
      remainingSeconds: 600
    };
    const next = pomodoroReducer(countupFocus, { type: "setMode", mode: "shortBreak" }, cfg);
    expect(next.mode).toBe("shortBreak");
    expect(next.timerMode).toBe("countdown");
    expect(next.remainingSeconds).toBe(5 * 60);
  });

  it("setMode back to focus restores the preferred focus timer mode", () => {
    const breakState = {
      ...createInitialState(cfg),
      mode: "shortBreak" as const,
      timerMode: "countdown" as const,
      focusTimerMode: "countup" as const,
      remainingSeconds: 100
    };
    const next = pomodoroReducer(breakState, { type: "setMode", mode: "focus" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.timerMode).toBe("countup");
    expect(next.remainingSeconds).toBe(0);
  });

  it("setTimerMode in focus updates both the active and preferred focus mode", () => {
    const s = createInitialState(cfg);
    const next = pomodoroReducer(s, { type: "setTimerMode", timerMode: "countup" }, cfg);
    expect(next.timerMode).toBe("countup");
    expect(next.focusTimerMode).toBe("countup");
    expect(next.remainingSeconds).toBe(0);
  });

  it("interrupt aborts a running focus segment and resets to focus", () => {
    const running = { ...createInitialState(cfg), isRunning: true, remainingSeconds: 900 };
    const next = pomodoroReducer(running, { type: "interrupt" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.remainingSeconds).toBe(25 * 60);
    expect(next.isRunning).toBe(false);
  });

  it("interrupt is a no-op when not in focus or not running", () => {
    const idle = createInitialState(cfg);
    expect(pomodoroReducer(idle, { type: "interrupt" }, cfg)).toEqual(idle);

    const breakRunning = {
      mode: "shortBreak" as const,
      timerMode: "countdown" as const,
      focusTimerMode: "countdown" as const,
      remainingSeconds: 100,
      isRunning: true,
      completedFocusSessions: 1,
      currentTaskId: null,
      currentEventLabel: null,
      awaitingActivity: false
    };
    expect(pomodoroReducer(breakRunning, { type: "interrupt" }, cfg)).toEqual(breakRunning);
  });
});

describe("plannedSecondsFor", () => {
  it("returns the planned duration per mode", () => {
    expect(plannedSecondsFor("focus")).toBe(25 * 60);
    expect(plannedSecondsFor("shortBreak")).toBe(5 * 60);
    expect(plannedSecondsFor("longBreak")).toBe(15 * 60);
  });
});

describe("buildSessionRecord", () => {
  it("marks a focus segment as type focus", () => {
    const r = buildSessionRecord({
      id: "s1",
      mode: "focus",
      startedAt: "t0",
      endedAt: "t1",
      plannedSeconds: 1500,
      completed: true
    });
    expect(r.type).toBe("focus");
    expect(r.mode).toBe("focus");
    expect(r.completed).toBe(true);
  });

  it("marks a break segment as type break", () => {
    const r = buildSessionRecord({
      id: "s2",
      mode: "shortBreak",
      startedAt: "t0",
      endedAt: "t1",
      plannedSeconds: 300,
      completed: true
    });
    expect(r.type).toBe("break");
    expect(r.mode).toBe("shortBreak");
  });
});

describe("buildInterruption", () => {
  it("builds a focus interruption record with clamped elapsed time", () => {
    const i = buildInterruption({ startedAt: "t0", endedAt: "t1", reason: "电话", elapsedSeconds: 300 });
    expect(i.mode).toBe("focus");
    expect(i.reason).toBe("电话");
    expect(i.elapsedSeconds).toBe(300);
    expect(i.startedAt).toBe("t0");
    expect(i.endedAt).toBe("t1");
  });

  it("clamps negative elapsed time to zero", () => {
    const i = buildInterruption({ startedAt: "t0", endedAt: "t1", reason: "其他", elapsedSeconds: -5 });
    expect(i.elapsedSeconds).toBe(0);
  });
});

describe("auto-start on segment completion", () => {
  it("a completed focus never auto-starts a break", () => {
    const cfg = { ...DEFAULT_CONFIG, autoStartNext: false, autoCycle: false };
    const s = { ...createInitialState(cfg), remainingSeconds: 1, isRunning: true };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.isRunning).toBe(false);
  });

  it("a completed focus auto-starts the next focus when enabled", () => {
    const cfg = { ...DEFAULT_CONFIG, autoStartNext: true, autoCycle: false };
    const s = { ...createInitialState(cfg), remainingSeconds: 1, isRunning: true, currentTaskId: "t1" };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.isRunning).toBe(true);
    expect(next.currentTaskId).toBe("t1");
  });

  it("stays paused after completion when auto-start is disabled", () => {
    const disabled = { ...DEFAULT_CONFIG, autoStartNext: false, autoCycle: false };
    const s = { ...createInitialState(disabled), remainingSeconds: 1, isRunning: true };
    const next = pomodoroReducer(s, { type: "tick" }, disabled);
    expect(next.isRunning).toBe(false);
  });
});

/* 完整自动循环链：专注 → 长短休轮换 → 专注。 */
describe("autoCycle focus/break loop", () => {
  const cycled = {
    ...DEFAULT_CONFIG,
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    longBreakInterval: 4,
    autoStartNext: false,
    autoCycle: true
  };

  it("a completed focus enters a short break when the interval is not reached", () => {
    const s = { ...createInitialState(cycled), remainingSeconds: 1, isRunning: true, completedFocusSessions: 0 };
    const next = pomodoroReducer(s, { type: "tick" }, cycled);
    expect(next.mode).toBe("shortBreak");
    expect(next.timerMode).toBe("countdown");
    expect(next.remainingSeconds).toBe(5 * 60);
    expect(next.isRunning).toBe(false);
    expect(next.completedFocusSessions).toBe(1);
  });

  it("a completed focus enters a long break every interval-th round", () => {
    const s = { ...createInitialState(cycled), remainingSeconds: 1, isRunning: true, completedFocusSessions: 3 };
    const next = pomodoroReducer(s, { type: "tick" }, cycled);
    expect(next.mode).toBe("longBreak");
    expect(next.remainingSeconds).toBe(15 * 60);
    expect(next.completedFocusSessions).toBe(4);
  });

  it("a completed break returns to focus with the preferred timer mode", () => {
    const s = {
      ...createInitialState(cycled),
      mode: "shortBreak" as const,
      timerMode: "countdown" as const,
      focusTimerMode: "countup" as const,
      remainingSeconds: 1,
      isRunning: true,
      completedFocusSessions: 2
    };
    const next = pomodoroReducer(s, { type: "tick" }, cycled);
    expect(next.mode).toBe("focus");
    expect(next.timerMode).toBe("countup");
    expect(next.remainingSeconds).toBe(0);
    // 休息结束不累计专注轮数。
    expect(next.completedFocusSessions).toBe(2);
  });

  it("segments auto-run when autoStartNext is on", () => {
    const auto = { ...cycled, autoStartNext: true };
    const focus = { ...createInitialState(auto), remainingSeconds: 1, isRunning: true };
    const brk = pomodoroReducer(focus, { type: "tick" }, auto);
    expect(brk.mode).toBe("shortBreak");
    expect(brk.isRunning).toBe(true);
    const nextFocus = pomodoroReducer({ ...brk, remainingSeconds: 1 }, { type: "tick" }, auto);
    expect(nextFocus.mode).toBe("focus");
    expect(nextFocus.isRunning).toBe(true);
  });

  it("the selected event survives the whole cycle", () => {
    const s = { ...createInitialState(cycled), remainingSeconds: 1, isRunning: true, currentTaskId: "t1" };
    const brk = pomodoroReducer(s, { type: "tick" }, cycled);
    expect(brk.currentTaskId).toBe("t1");
    const focus = pomodoroReducer({ ...brk, remainingSeconds: 1, isRunning: true }, { type: "tick" }, cycled);
    expect(focus.currentTaskId).toBe("t1");
    expect(focus.mode).toBe("focus");
  });
});

describe("timerMode (countdown / countup)", () => {
  it("defaults to countdown", () => {
    expect(createInitialState(cfg).timerMode).toBe("countdown");
  });

  it("switching to countup resets remainingSeconds to zero", () => {
    const s = createInitialState(cfg);
    const next = pomodoroReducer(s, { type: "setTimerMode", timerMode: "countup" }, cfg);
    expect(next.timerMode).toBe("countup");
    expect(next.remainingSeconds).toBe(0);
    expect(next.isRunning).toBe(false);
  });

  it("switching back to countdown restores the planned duration", () => {
    const s = { ...createInitialState(cfg), timerMode: "countup" as const, remainingSeconds: 120 };
    const next = pomodoroReducer(s, { type: "setTimerMode", timerMode: "countdown" }, cfg);
    expect(next.timerMode).toBe("countdown");
    expect(next.remainingSeconds).toBe(25 * 60);
  });

  it("countup tick accumulates elapsed seconds and never switches mode", () => {
    const s = { ...createInitialState(cfg), timerMode: "countup" as const, remainingSeconds: 0, isRunning: true };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.remainingSeconds).toBe(1);
    expect(next.mode).toBe("focus");
    expect(next.completedFocusSessions).toBe(0);
    expect(next.isRunning).toBe(true);
  });

  it("countup ignores auto-start break on completion thresholds", () => {
    const s = { ...createInitialState(cfg), timerMode: "countup" as const, remainingSeconds: 25 * 60, isRunning: true };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.remainingSeconds).toBe(25 * 60 + 1);
  });

  it("reset in countup mode returns to zero", () => {
    const s = { ...createInitialState(cfg), timerMode: "countup" as const, remainingSeconds: 300, isRunning: true };
    const next = pomodoroReducer(s, { type: "reset" }, cfg);
    expect(next.remainingSeconds).toBe(0);
    expect(next.isRunning).toBe(false);
  });
});

/* selectTask 动作已随无调用者的 selectPomodoroTask 一并移除（selectEvent 取代）；
   下面只保留与动作无关的「阶段完成后任务 / 事件标签不丢」回归。 */
describe("task / event label persistence across a completed segment", () => {
  it("keeps the selected task across a completed countdown segment", () => {
    const s = { ...createInitialState(cfg), currentTaskId: "t1", remainingSeconds: 1, isRunning: true };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.currentTaskId).toBe("t1");
    expect(next.mode).toBe("focus");
  });

  it("keeps a custom event label across a completed countdown segment", () => {
    const s = { ...createInitialState(cfg), currentEventLabel: "写周报", remainingSeconds: 1, isRunning: true };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.currentEventLabel).toBe("写周报");
    expect(next.mode).toBe("focus");
  });

  it("keeps the custom event through a completed focus segment", () => {
    const s = { ...createInitialState(cfg), currentEventLabel: "写周报", remainingSeconds: 1, isRunning: true };
    const afterFocus = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(afterFocus.mode).toBe("focus");
    expect(afterFocus.currentEventLabel).toBe("写周报");
    expect(afterFocus.isRunning).toBe(false);
  });
});

describe("selectEvent", () => {
  it("selecting a custom label starts a fresh focus with that label", () => {
    const s = createInitialState(cfg);
    const next = pomodoroReducer(s, { type: "selectEvent", taskId: null, label: "写周报" }, cfg);
    expect(next.currentEventLabel).toBe("写周报");
    expect(next.currentTaskId).toBeNull();
    expect(next.mode).toBe("focus");
    expect(next.isRunning).toBe(false);
    expect(next.remainingSeconds).toBe(25 * 60);
  });

  it("selecting an event during a running focus does not disturb the timer", () => {
    const s = {
      mode: "focus" as const,
      timerMode: "countdown" as const,
      focusTimerMode: "countdown" as const,
      remainingSeconds: 200,
      isRunning: true,
      completedFocusSessions: 1,
      currentTaskId: null,
      currentEventLabel: null,
      awaitingActivity: false
    };
    const next = pomodoroReducer(s, { type: "selectEvent", taskId: "t1", label: null }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.isRunning).toBe(true);
    expect(next.remainingSeconds).toBe(200);
    expect(next.currentTaskId).toBe("t1");
  });

  it("clearing the event resets to a fresh paused focus", () => {
    const s = { ...createInitialState(cfg), currentEventLabel: "写周报", remainingSeconds: 500 };
    const next = pomodoroReducer(s, { type: "selectEvent", taskId: null, label: null }, cfg);
    expect(next.currentEventLabel).toBeNull();
    expect(next.currentTaskId).toBeNull();
    expect(next.remainingSeconds).toBe(25 * 60);
    expect(next.isRunning).toBe(false);
  });
});

describe("completed focus auto-start behavior", () => {
  it("auto-starts the next focus when enabled and no break is inserted", () => {
    const cfg = { ...DEFAULT_CONFIG, autoStartNext: true, autoCycle: false };
    const s = {
      ...createInitialState(cfg),
      timerMode: "countdown" as const,
      focusTimerMode: "countdown" as const,
      remainingSeconds: 1,
      isRunning: true,
      completedFocusSessions: 1,
      currentTaskId: null,
      currentEventLabel: null
    };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.isRunning).toBe(true);
    expect(next.completedFocusSessions).toBe(2);
  });

  it("auto-starts the next focus and keeps the selected event", () => {
    const cfg = { ...DEFAULT_CONFIG, autoStartNext: true, autoCycle: false };
    const s = {
      ...createInitialState(cfg),
      timerMode: "countdown" as const,
      focusTimerMode: "countdown" as const,
      remainingSeconds: 1,
      isRunning: true,
      completedFocusSessions: 1,
      currentTaskId: "t1",
      currentEventLabel: null
    };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.isRunning).toBe(true);
    expect(next.currentTaskId).toBe("t1");
  });
});

describe("focusTimerMode preservation", () => {
  it("switching to countup sets the focus preference too", () => {
    const next = pomodoroReducer(createInitialState(cfg), { type: "setTimerMode", timerMode: "countup" }, cfg);
    expect(next.timerMode).toBe("countup");
    expect(next.focusTimerMode).toBe("countup");
  });

  it("a completed focus keeps the preferred countup focus mode", () => {
    // The focus runs as countdown (so it can complete); the user's preferred
    // focus mode is countup and must survive into the next focus.
    const s = {
      ...createInitialState(cfg),
      timerMode: "countdown" as const,
      focusTimerMode: "countup" as const,
      remainingSeconds: 1,
      isRunning: true
    };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.timerMode).toBe("countup");
    expect(next.focusTimerMode).toBe("countup");
    expect(next.remainingSeconds).toBe(0);
  });

  it("a completed focus resets to the preferred countup focus mode", () => {
    const s = {
      ...createInitialState(cfg),
      timerMode: "countdown" as const,
      focusTimerMode: "countup" as const,
      remainingSeconds: 1,
      isRunning: true,
      completedFocusSessions: 1,
      currentTaskId: null,
      currentEventLabel: null
    };
    const next = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(next.mode).toBe("focus");
    expect(next.timerMode).toBe("countup");
    expect(next.remainingSeconds).toBe(0);
  });
});

describe("normalizeConfig", () => {
  it("fills missing fields with defaults", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("clamps out-of-range values", () => {
    const c = normalizeConfig({ focusMinutes: 999, shortBreakMinutes: 0, longBreakInterval: 99 });
    expect(c.focusMinutes).toBe(180);
    expect(c.shortBreakMinutes).toBe(1);
    expect(c.longBreakInterval).toBe(12);
  });

  it("rounds fractional values", () => {
    expect(normalizeConfig({ focusMinutes: 25.6 }).focusMinutes).toBe(26);
  });

  it("ignores non-numeric values", () => {
    const c = normalizeConfig({ focusMinutes: Number.NaN, shortBreakMinutes: 7 });
    expect(c.focusMinutes).toBe(DEFAULT_CONFIG.focusMinutes);
    expect(c.shortBreakMinutes).toBe(7);
  });
});
