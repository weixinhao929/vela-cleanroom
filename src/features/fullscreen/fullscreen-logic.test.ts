import { describe, expect, it } from "vitest";
import {
  fmtBig,
  interpolatePomodoro,
  parseFullscreenKind,
  scanRunningCountdown,
  storageKeys,
  type PomodoroSnapshotLike,
  type ReadOnlyStorage
} from "./fullscreen-logic";

/** 全屏展示纯逻辑：hash 解析、倒计时扫描（假存储注入）、番茄钟插值。 */

function fakeStorage(entries: Record<string, string>): ReadOnlyStorage {
  const keys = Object.keys(entries);
  return {
    getItem: (k) => (k in entries ? entries[k] : null),
    length: keys.length,
    key: (i) => keys[i] ?? null
  };
}

describe("parseFullscreenKind", () => {
  it("三种模式解析与未知回退", () => {
    expect(parseFullscreenKind("#fullscreen&kind=clock")).toBe("clock");
    expect(parseFullscreenKind("#fullscreen&kind=countdown")).toBe("countdown");
    expect(parseFullscreenKind("#fullscreen&kind=pomodoro")).toBe("pomodoro");
    expect(parseFullscreenKind("#fullscreen&kind=evil")).toBe("clock");
    expect(parseFullscreenKind("#fullscreen")).toBe("clock");
  });
});

describe("scanRunningCountdown", () => {
  const now = 1_000_000;
  it("找最早到期的运行实例，跳过暂停/到期/坏数据", () => {
    const ls = fakeStorage({
      "focus-desk.countdown.state.a": JSON.stringify({ running: true, endAt: now + 60_000, total: 120 }),
      "focus-desk.countdown.state.b": JSON.stringify({ running: true, endAt: now + 30_000, total: 60 }),
      "focus-desk.countdown.state.c": JSON.stringify({ running: false, endAt: now + 10_000, total: 30 }),
      "focus-desk.countdown.state.d": JSON.stringify({ running: true, endAt: now - 5_000, total: 30 }),
      "focus-desk.countdown.state.e": "{broken json",
      "other-key": "1"
    });
    expect(scanRunningCountdown(ls, now)).toEqual({ endAt: now + 30_000, total: 60 });
  });
  it("无运行实例返回 null", () => {
    expect(scanRunningCountdown(fakeStorage({}), now)).toBeNull();
  });
});

describe("storageKeys", () => {
  it("枚举全部键名", () => {
    const ls = fakeStorage({ a: "1", b: "2" });
    expect(storageKeys(ls).sort()).toEqual(["a", "b"]);
  });
});

describe("interpolatePomodoro", () => {
  const snap = (over: Partial<PomodoroSnapshotLike> = {}): PomodoroSnapshotLike => ({
    pomodoro: { mode: "focus", timerMode: "countdown", remainingSeconds: 1500, isRunning: true },
    segmentAnchorMs: 1_000_000,
    segmentBaseSeconds: 1500,
    segmentStartedAt: null,
    ...over
  });
  it("倒计时模式：从锚点按墙钟递减", () => {
    expect(interpolatePomodoro(snap(), 1_000_000 + 90_000)).toEqual({
      seconds: 1410,
      running: true,
      countUp: false,
      mode: "focus"
    });
  });
  it("走到底钳到 0", () => {
    expect(interpolatePomodoro(snap(), 1_000_000 + 1_600_000).seconds).toBe(0);
  });
  it("暂停时用快照 remaining", () => {
    const s = snap({
      pomodoro: { mode: "shortBreak", timerMode: "countdown", remainingSeconds: 42, isRunning: false }
    });
    expect(interpolatePomodoro(s, 2_000_000)).toEqual({
      seconds: 42,
      running: false,
      countUp: false,
      mode: "shortBreak"
    });
  });
  it("countup 累加", () => {
    const s = snap({
      pomodoro: { mode: "focus", timerMode: "countup", remainingSeconds: 0, isRunning: true },
      segmentBaseSeconds: 100
    });
    expect(interpolatePomodoro(s, 1_000_000 + 50_000).seconds).toBe(150);
  });
});

describe("fmtBig", () => {
  it("h:mm:ss / mm:ss", () => {
    expect(fmtBig(0)).toBe("00:00");
    expect(fmtBig(65)).toBe("01:05");
    expect(fmtBig(3661)).toBe("1:01:01");
    expect(fmtBig(-5)).toBe("00:00");
  });
});
