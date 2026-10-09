/**
 * TaskbarConfigSync 审计修复回归（独立于 TaskbarPage.test.tsx 的 对账用例）：
 * - ：在飞链路串行 + token——快速连续改动时，新链必须等旧链 settle 后才发车；
 *   排队期间被取代的链（token 过期）不再发 get/apply。最终 Rust 收到的最后一次
 *   apply 必然是最新配置（原实现的竞态：慢的旧 apply 晚于新 apply 落定，引擎停在
 *   旧配置且无收敛）。
 * - ：taskbarConfigEquals 对 monitorOverrides 键序不敏感（normalizeTaskbar 排序），
 *   Rust HashMap 序列化序随机不再造成「假性不等 → 每次切片变化整包重 apply +
 *   打断钉住的预览」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
const toastMock = vi.fn();
let tauriOn = false;

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return { ...mod, isTauri: () => tauriOn, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

vi.mock("../../../components/ToastHost", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../components/ToastHost")>();
  return { ...mod, showToast: (text: string, kind?: string) => toastMock(text, kind) };
});

import { TASKBAR_APPLY_DEBOUNCE_MS, TaskbarConfigSync, taskbarConfigEquals } from "./TaskbarConfigSync";
import { defaultTaskbarSettings, defaultTaskbarStates, useSettingsStore } from "../../../store/settings-store";

function Probe() {
  TaskbarConfigSync();
  return null;
}

const setEnabled = (enabled: boolean) =>
  act(() => {
    useSettingsStore.setState((s) => ({ general: { ...s.general, taskbar: { ...s.general.taskbar, enabled } } }));
  });

/** 手动闸门（微任务安全）：apply 第一拍挂起，测试里显式放行——vi.waitUntil 的
 *  轮询与 fake timers 不兼容。 */
function makeGate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  toastMock.mockReset();
  tauriOn = true;
  window.location.hash = "#/settings";
  useSettingsStore.setState((s) => ({ general: { ...s.general, taskbar: defaultTaskbarSettings() } }));
});

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = "";
});

describe("TaskbarConfigSync · 审计修复回归", () => {
  it("B4：monitorOverrides 键序不同视为等价（Rust HashMap 序随机不再假性不等）", () => {
    const ov = { states: defaultTaskbarStates() };
    const a = { ...defaultTaskbarSettings(), monitorOverrides: { "2": ov, "10": ov } };
    const b = { ...defaultTaskbarSettings(), monitorOverrides: { "10": ov, "2": ov } };
    expect(taskbarConfigEquals(a, b)).toBe(true);
    // 真差异仍要判不等：覆盖内桌面颜色不同。
    const defaults = defaultTaskbarStates();
    const ovOther = { states: { ...defaults, desktop: { ...defaults.desktop, color: "#11223344" } } };
    const c = { ...defaultTaskbarSettings(), monitorOverrides: { "2": ov } };
    const d = { ...defaultTaskbarSettings(), monitorOverrides: { "2": ovOther } };
    expect(c).not.toEqual(d);
    expect(taskbarConfigEquals(c, d)).toBe(false);
  });

  it("B3：快速开→关——新链等旧链 settle 后才 apply，最后一次 apply 是新配置", async () => {
    vi.useFakeTimers();
    const applyConfigs: boolean[] = [];
    const gate = makeGate();
    // Rust 侧回一个与本地任何状态都不同的配置（桌面色错开）→ 每条链都会走到
    // apply（若回默认配置，最终 store=关 时与 get 结果相等，链 B 会正当跳过）。
    const rustSide = defaultTaskbarSettings();
    rustSide.states.desktop.color = "#01020304";
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_taskbar_config") return rustSide;
      if (cmd === "apply_taskbar_config") {
        applyConfigs.push((args as { config: { enabled: boolean } }).config.enabled);
        if (applyConfigs.length === 1) {
          // 第一条链的 apply 卡在 wait_ready（最长 10s）：竞态场景的慢旧链。
          await gate.promise;
        }
        return [];
      }
      return null;
    });

    render(<Probe />);
    // 改动 A（开）：防抖到期 → 链 A 发车，apply(true) 挂起。
    setEnabled(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKBAR_APPLY_DEBOUNCE_MS + 10);
    });
    expect(applyConfigs).toEqual([true]);

    // 改动 B（关）：防抖到期 → 链 B 排队（前一条未 settle），不得并发派发。
    setEnabled(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKBAR_APPLY_DEBOUNCE_MS + 10);
    });
    expect(applyConfigs).toEqual([true]);

    // 旧链 settle → 新链发车，apply(false) 成为最后一次——引擎最终停在最新配置。
    gate.open();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      // 队列链全在微任务上：gate 解除 → run_A 收尾 → run_B 排到 → get/apply，
      // 每一步一个微任务拍，显式冲刷足够多轮。
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(applyConfigs).toEqual([true, false]);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("B3：排队期间被取代的链不再 apply（token 过期直接跳过）", async () => {
    vi.useFakeTimers();
    const getCalls: number[] = [];
    const gate = makeGate();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_taskbar_config") {
        getCalls.push(getCalls.length + 1);
        return defaultTaskbarSettings();
      }
      if (cmd === "apply_taskbar_config") {
        await gate.promise;
        return [];
      }
      return null;
    });

    render(<Probe />);
    // 三次连续改动：链 1 发车（apply 挂起），链 2/3 排队。
    setEnabled(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKBAR_APPLY_DEBOUNCE_MS + 10);
    });
    setEnabled(false);
    setEnabled(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKBAR_APPLY_DEBOUNCE_MS + 10);
    });
    expect(getCalls).toEqual([1]);

    gate.open();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    // 链 2 的 token 已被链 3 取代 → 跳过；链 3（最新）发车 get。
    expect(getCalls).toEqual([1, 2]);
    const applies = invokeMock.mock.calls.filter(([cmd]) => cmd === "apply_taskbar_config");
    expect(applies).toHaveLength(2);
    expect((applies[1][1] as { config: { enabled: boolean } }).config.enabled).toBe(true);
  });
});
