import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";

/**
 * 回归：无手势环境下 AudioContext 停在 suspended 时，
 * isAmbiencePlaying 必须报 false；下一次用户手势补 resume 成功后才翻转。
 * 用可控 state 的 Fake AudioContext 模拟自动播放策略。
 * 补充：prefs 读写回退、音量钳制、媒体守卫的初始态拉取（事件只在
 * 变化时到达——挂载时已在播的场景靠首拉补齐）。
 */
const policy = vi.hoisted(() => ({ allowResume: false }));
const invokeMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));
/** 守卫事件注册表：unlisten 真正摘除 handler，退订后不再响应。 */
const guardHandlers = vi.hoisted(() => new Set<(e: { payload: unknown }) => void>());
const listenMock = vi.hoisted(() =>
  vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    guardHandlers.add(handler);
    return () => guardHandlers.delete(handler);
  })
);

vi.mock("./tauri", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

/** 可链式 connect 的哑节点（connect 返回自身，覆盖 src.connect(x).connect(y)）。 */
function makeNode(extra: Record<string, unknown> = {}) {
  const node: Record<string, unknown> = { start: vi.fn(), stop: vi.fn(), ...extra };
  node.connect = vi.fn(() => node);
  return node;
}

const paramLike = {
  value: 0,
  setValueAtTime: vi.fn(),
  setTargetAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
  exponentialRampToValueAtTime: vi.fn()
};

class FakeAudioContext {
  state = "suspended";
  sampleRate = 48000;
  currentTime = 0;
  destination = makeNode();
  /** 捕获各 gain 节点，供音量钳制断言读取 setTargetAtTime 调用。 */
  static gains: Array<{ gain: { setTargetAtTime: ReturnType<typeof vi.fn> } }> = [];
  async resume(): Promise<void> {
    if (policy.allowResume) this.state = "running";
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
  createGain() {
    const gain = { ...paramLike, setTargetAtTime: vi.fn() };
    const node = makeNode({ gain });
    FakeAudioContext.gains.push(node as unknown as { gain: { setTargetAtTime: ReturnType<typeof vi.fn> } });
    return node;
  }
  createBiquadFilter() {
    return makeNode({ frequency: { ...paramLike }, Q: { ...paramLike }, type: "lowpass" });
  }
  createBufferSource() {
    return makeNode({ loop: false, buffer: null });
  }
  createOscillator() {
    return makeNode({ frequency: { ...paramLike }, type: "sine" });
  }
  createBuffer(_ch: number, len: number, _rate: number) {
    return { getChannelData: () => new Float32Array(len) };
  }
}

const flush = () => new Promise((r) => window.setTimeout(r, 0));

import {
  isAmbienceMediaInhibited,
  isAmbiencePlaying,
  loadAmbiencePrefs,
  saveAmbiencePrefs,
  setAmbienceMediaInhibited,
  setAmbiencePlaying,
  setAmbienceVolume,
  startAmbienceMediaGuard
} from "./ambience";

beforeEach(() => {
  policy.allowResume = false;
  FakeAudioContext.gains = [];
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  listenMock.mockClear();
  guardHandlers.clear();
  localStorage.clear();
  (window as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
});

afterEach(async () => {
  // 清态：停图 + 复位抑制（对 stopNodes/手势监听也是自清理路径）。
  setAmbiencePlaying("white", 0, false);
  setAmbienceMediaInhibited(false);
  delete (window as unknown as { AudioContext?: typeof FakeAudioContext }).AudioContext;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("ambience · 假播放修复（suspended 不算播放中）", () => {
  it("resume 被策略拒绝 → isAmbiencePlaying 报 false（不再谎报）", async () => {
    expect(setAmbiencePlaying("white", 0.4, true)).toBe(true); // 意图成功
    await flush();
    expect(isAmbiencePlaying()).toBe(false); // ctx 停在 suspended
  });

  it("手势补恢复：下一次用户交互 resume 成功后翻转为播放中", async () => {
    setAmbiencePlaying("white", 0.4, true);
    await flush();
    expect(isAmbiencePlaying()).toBe(false);

    // 手势到达但策略仍拒绝：保持待恢复，不抛错。
    fireEvent.pointerDown(window);
    await flush();
    expect(isAmbiencePlaying()).toBe(false);

    // 策略放行后的下一次手势：resume 成功。
    policy.allowResume = true;
    fireEvent.keyDown(window);
    await flush();
    expect(isAmbiencePlaying()).toBe(true);
  });

  it("媒体抑制周期：抑制恢复由事件驱动（无手势）重建，仍 suspended 时如实报 false", async () => {
    setAmbiencePlaying("white", 0.4, true);
    setAmbienceMediaInhibited(true);
    expect(isAmbiencePlaying()).toBe(false);

    // 抑制解除（media:snapshot 事件路径，无手势）：重建但被策略拦下。
    setAmbienceMediaInhibited(false);
    await flush();
    expect(isAmbiencePlaying()).toBe(false);

    policy.allowResume = true;
    fireEvent.pointerDown(window);
    await flush();
    expect(isAmbiencePlaying()).toBe(true);
  });
});

describe("ambience · prefs 与音量（R4 回归网）", () => {
  it("loadAmbiencePrefs：缺省/损坏回退默认，volume 钳制，kind 校验", () => {
    expect(loadAmbiencePrefs()).toEqual({ kind: "rain", volume: 0.4 });
    localStorage.setItem("focus-desk.ambience.v1", "{broken json");
    expect(loadAmbiencePrefs()).toEqual({ kind: "rain", volume: 0.4 });
    localStorage.setItem("focus-desk.ambience.v1", JSON.stringify({ kind: "fire", volume: 7 }));
    expect(loadAmbiencePrefs()).toEqual({ kind: "fire", volume: 1 });
    localStorage.setItem("focus-desk.ambience.v1", JSON.stringify({ kind: "not-a-kind", volume: -1 }));
    expect(loadAmbiencePrefs()).toEqual({ kind: "rain", volume: 0 });
  });

  it("saveAmbiencePrefs 往返；写失败静默不抛错", () => {
    saveAmbiencePrefs({ kind: "cafe", volume: 0.6 });
    expect(loadAmbiencePrefs()).toEqual({ kind: "cafe", volume: 0.6 });
    // localStorage 不可用时静默。
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveAmbiencePrefs({ kind: "rain", volume: 0.4 })).not.toThrow();
    spy.mockRestore();
  });

  it("setAmbienceVolume：越界钳制到 0..1；未播放时 no-op 不抛错", async () => {
    expect(() => setAmbienceVolume(5)).not.toThrow();
    policy.allowResume = true;
    setAmbiencePlaying("rain", 0.2, true);
    await flush();
    expect(isAmbiencePlaying()).toBe(true);
    setAmbienceVolume(7); // → 1（钳制）
    // build 先建 master 再建 swell 的 amp：按「最后一次调用值为 1」定位
    // master（amp 从不被 setTargetAtTime 调用）。
    const master = FakeAudioContext.gains.find((g) => g.gain.setTargetAtTime.mock.calls.at(-1)?.[0] === 1);
    expect(master).toBeTruthy();
    expect(master!.gain.setTargetAtTime.mock.calls.at(-1)?.[0]).toBe(1);
  });

  it("isAmbienceMediaInhibited 直读当前抑制态", () => {
    expect(isAmbienceMediaInhibited()).toBe(false);
    setAmbienceMediaInhibited(true);
    expect(isAmbienceMediaInhibited()).toBe(true);
    setAmbienceMediaInhibited(false);
    expect(isAmbienceMediaInhibited()).toBe(false);
  });
});

describe("ambience · 媒体守卫初始态（R4-6）", () => {
  it("guard 启动即拉快照：音乐已在播 → 立即抑制（不等下一次播放态变化）", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValueOnce({ playing: true, title: "歌" });
    const stop = startAmbienceMediaGuard();
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("get_system_media_info");
    expect(isAmbienceMediaInhibited()).toBe(true);

    // 事件路径照常：播放停止 → 解除抑制（经注册表派发，模拟真实事件到达）。
    expect(listenMock).toHaveBeenCalledWith("media:snapshot", expect.any(Function));
    guardHandlers.forEach((h) => h({ payload: { playing: false } }));
    expect(isAmbienceMediaInhibited()).toBe(false);

    // 停止守卫后：unlisten 摘除 handler，事件不再到达。
    stop();
    guardHandlers.forEach((h) => h({ payload: { playing: true } }));
    expect(isAmbienceMediaInhibited()).toBe(false);
  });

  it("guard 初始态拉取失败静默：只损失初始抑制，事件链路照常", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValueOnce(new Error("ipc down"));
    startAmbienceMediaGuard();
    await flush();
    expect(isAmbienceMediaInhibited()).toBe(false);
  });

  it("非 Tauri 环境：no-op 退订函数，不发起任何调用", () => {
    const stop = startAmbienceMediaGuard();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    stop();
  });
});
