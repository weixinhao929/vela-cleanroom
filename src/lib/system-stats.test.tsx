import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * sys:stats 可见性门控回归（§4.1「不可见即不花钱」）：
 *  - 可见挂载 → 发 subscribe_system_stats；
 *  - document 变 hidden（Ctrl+Alt+D 隐藏桌面层）→ 发 unsubscribe_system_stats；
 *  - 重新可见 → 恢复订阅；
 *  - 隐藏期间挂载不订阅，可见后才订阅；
 *  - 卸载 → 补发一次 unsubscribe（幂等对账）。
 */

const listenMock = vi.fn(async (_name: string, _cb: (e: { payload: unknown }) => void) => () => {});
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => null);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => listenMock(name, cb)
}));

vi.mock("./tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./tauri")>();
  return {
    ...mod,
    isTauri: () => true,
    invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args)
  };
});

import { useSystemBroadcast } from "./system-stats";

/** 测试内可控的 document.hidden。 */
let hidden = false;
function setVisibility(v: boolean) {
  hidden = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  invokeMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const calls = () => invokeMock.mock.calls.filter(([cmd]) => typeof cmd === "string" && cmd.endsWith("system_stats"));
const subCount = () => calls().filter(([cmd]) => cmd === "subscribe_system_stats").length;
const unsubCount = () => calls().filter(([cmd]) => cmd === "unsubscribe_system_stats").length;

describe("useSystemBroadcast 可见性门控", () => {
  it("可见挂载即订阅", async () => {
    const { unmount } = renderHook(() => useSystemBroadcast(2));
    await vi.waitFor(() => expect(subCount()).toBe(1));
    // intervalSec 下限 0.5，换算为毫秒传入。
    expect(calls()[0]?.[1]).toEqual({ intervalMs: 2000 });
    unmount();
  });

  it("隐藏 → 退订；重新可见 → 恢复订阅", async () => {
    const { unmount } = renderHook(() => useSystemBroadcast());
    await vi.waitFor(() => expect(subCount()).toBe(1));
    invokeMock.mockClear();

    setVisibility(true);
    expect(unsubCount()).toBe(1);
    expect(subCount()).toBe(0);

    setVisibility(false);
    expect(subCount()).toBe(1);
    expect(unsubCount()).toBe(1);

    unmount();
    // 卸载只补发一次退订，不与隐藏路径叠加（一配一平衡记账）。
    expect(unsubCount()).toBe(2);
  });

  it("隐藏期间挂载：不订阅，可见后订阅", async () => {
    hidden = true;
    const { unmount } = renderHook(() => useSystemBroadcast());
    expect(subCount()).toBe(0);

    setVisibility(false);
    await vi.waitFor(() => expect(subCount()).toBe(1));
    unmount();
    expect(unsubCount()).toBe(1);
  });

  it("重复 hidden 事件不重复退订（幂等）", async () => {
    const { unmount } = renderHook(() => useSystemBroadcast());
    await vi.waitFor(() => expect(subCount()).toBe(1));
    invokeMock.mockClear();

    setVisibility(true);
    setVisibility(true); // 重复事件
    expect(unsubCount()).toBe(1);

    unmount();
  });

  it("浏览器模式 no-op（不触达任何 IPC）", async () => {
    // 动态换 mock：isTauri=false 的模块副本 + 独立 invoke 计数。
    const browserInvoke = vi.fn(async (_cmd: string, _args?: unknown) => null);
    vi.doMock("./tauri", async (importOriginal) => {
      const mod = await importOriginal<typeof import("./tauri")>();
      return {
        ...mod,
        isTauri: () => false,
        invoke: (cmd: string, args?: unknown) => browserInvoke(cmd, args)
      };
    });
    vi.resetModules();
    const { useSystemBroadcast: useHook } = await import("./system-stats");
    const { unmount } = renderHook(() => useHook());
    expect(browserInvoke).not.toHaveBeenCalled();
    unmount();
    vi.doUnmock("./tauri");
    vi.resetModules();
  });
});
