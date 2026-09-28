/**
 * lib/tauri · previewTaskbarState（F-8 预览通道包装）：
 * - 载荷形状与 Rust `preview_taskbar_state(state, overrides)` 一致：`overrides` 缺省 / undefined
 *   一律传 null（取消 = state null）；
 * - 浏览器模式（无 __TAURI_INTERNALS__）与所有 invoke 一样 reject，不吞错。
 * TaskbarPage.test.tsx 把本包装 mock 成同形载荷的 invokeMock 调用，两边合起来覆盖整条链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreInvoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => coreInvoke(cmd, args)
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "settings" })
}));

import { previewTaskbarState } from "./tauri";

const win = window as unknown as Record<string, unknown>;

beforeEach(() => {
  coreInvoke.mockClear();
  win.__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete win.__TAURI_INTERNALS__;
});

describe("previewTaskbarState", () => {
  it("state + overrides 原样透传为 { state, overrides }", async () => {
    const overrides = { color: "#00000080", blurRadius: 12 };
    await previewTaskbarState("maximizedWindow", overrides);
    expect(coreInvoke).toHaveBeenCalledTimes(1);
    expect(coreInvoke).toHaveBeenCalledWith("preview_taskbar_state", { state: "maximizedWindow", overrides });
  });

  it("overrides 缺省 / undefined / null 一律归为 null；state=null 即取消", async () => {
    await previewTaskbarState("desktop");
    await previewTaskbarState("desktop", undefined);
    await previewTaskbarState(null, null);
    await previewTaskbarState(null);
    expect(coreInvoke.mock.calls.map(([, args]) => args)).toEqual([
      { state: "desktop", overrides: null },
      { state: "desktop", overrides: null },
      { state: null, overrides: null },
      { state: null, overrides: null }
    ]);
  });

  it("Rust 侧拒绝原样 reject（调用方决定 toast 或静默）", async () => {
    coreInvoke.mockRejectedValueOnce("任务栏模块未就绪，无法预览");
    await expect(previewTaskbarState("desktop", { color: "#fff" })).rejects.toBe("任务栏模块未就绪，无法预览");
  });

  it("浏览器模式（无 Tauri 运行时）reject 且不触达 core invoke", async () => {
    delete win.__TAURI_INTERNALS__;
    await expect(previewTaskbarState("desktop")).rejects.toThrow(/outside Tauri runtime/);
    expect(coreInvoke).not.toHaveBeenCalled();
  });
});
