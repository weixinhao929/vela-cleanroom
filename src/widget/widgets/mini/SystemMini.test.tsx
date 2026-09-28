import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

/**
 * SystemMini 回归：数据来自 useSystemBroadcast（sys:stats 订阅制广播）：
 *  - active 挂载 → 发 subscribe_system_stats，收到帧后显示 CPU / 内存百分比；
 *  - active=false → 订阅者子组件不挂载，不发任何订阅 IPC，显示占位「–」。
 */
type Listener = (e: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
const listenMock = vi.fn(async (name: string, cb: Listener) => {
  listeners.set(name, cb);
  return () => listeners.delete(name);
});
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: Listener) => listenMock(name, cb)
}));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

import { SystemMini } from "./SystemMini";

const frame = (cpu: number, mem: number) => ({
  stats: { cpu_usage: cpu, mem_percent: mem, mem_used_gb: 8, mem_total_gb: 16, cores: 8, cpu_per_core: [] },
  disks: [],
  networks: [],
  battery: { present: false, percent: 0, charging: false }
});

beforeEach(() => {
  listeners.clear();
  listenMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  // 订阅者侧节流（P-perf 三轮）以 performance.now 计拍点：测试启动的墙钟
  // 通常 < 3s 档的节流窗口（2850ms），首帧会被当作「未到拍点」丢弃——把
  // 时钟拨到窗口之外，首帧确定性通过节流。
  vi.spyOn(performance, "now").mockReturnValue(100_000);
});

describe("SystemMini", () => {
  it("active：订阅 sys:stats 并渲染 CPU / MEM 百分比与三条细条（W-145 加 NET 行）", async () => {
    render(<SystemMini active />);
    await vi.waitFor(() => expect(listeners.has("sys:stats")).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith("subscribe_system_stats", expect.objectContaining({ intervalMs: 3000 }));
    act(() => listeners.get("sys:stats")!({ payload: frame(42.4, 61) }));
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("61%")).toBeInTheDocument();
    // W-145：CPU/MEM/NET 三行细条；NET 行数值显示 ↓ 下载速率（空网络列表 → 0B）。
    expect(document.querySelectorAll(".dock-mini-bar")).toHaveLength(3);
    expect(screen.getByText(/↓/)).toBeInTheDocument();
    expect(document.querySelector(".dock-mini-system")).toHaveClass("dock-mini");
  });

  it("active=false：不订阅（无 subscribe IPC），显示占位「–」", async () => {
    render(<SystemMini active={false} />);
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    // CPU/MEM/NET 三行占位（NET 行 frame=null 显示「–」）。
    expect(screen.getAllByText("–")).toHaveLength(3);
  });

  it("active 翻 false 时退订（unsubscribe_system_stats）", async () => {
    const { rerender } = render(<SystemMini active />);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("subscribe_system_stats", expect.anything()));
    rerender(<SystemMini active={false} />);
    expect(invokeMock).toHaveBeenCalledWith("unsubscribe_system_stats", undefined);
  });
});
