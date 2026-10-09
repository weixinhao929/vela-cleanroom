import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * AudioVisualizer 组件回归（此前整组件零测试）——静音按钮行为、
 * aria-pressed 三源（本组件 toggle / osd:volume 外部变化 / get_system_mute
 * 挂载初值）。canvas 在 jsdom 下 getContext 为 null，绘制循环早退，不影响
 * 交互面断言。
 */
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
const eventHandlers = new Map<string, (payload: unknown) => void>();

vi.mock("../../lib/use-tauri-event", () => ({
  useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
    eventHandlers.set(event, handler);
  }
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {}
}));

vi.mock("../../lib/anim", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/anim")>();
  return { ...mod, prefersReducedMotion: () => false };
});

vi.mock("../../lib/use-covered", () => ({ coveredTickGate: () => false }));

import { AudioVisualizer } from "./AudioVisualizer";

const btn = () => screen.getByRole("button", { name: "点击切换系统静音" });
/* mock 包装转发 args 形参（undefined 也占一位）：单参命令断言需带 undefined。 */
const emitOsd = (payload: unknown) => act(() => eventHandlers.get("osd:volume")?.(payload));

beforeEach(() => {
  eventHandlers.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "get_system_mute" ? false : null));
});

describe("AudioVisualizer · 静音交互（W-128）", () => {
  it("点击切换系统静音：toggle 后 aria-pressed 与角标文案同步", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "toggle_system_mute" ? true : false));
    render(<AudioVisualizer />);
    expect(btn()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn());
    await waitFor(() => expect(btn()).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByText("已静音")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("toggle_system_mute", undefined);

    // 再点一次：取消静音。
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "toggle_system_mute" ? false : false));
    fireEvent.click(btn());
    await waitFor(() => expect(btn()).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByText("已取消静音")).toBeInTheDocument();
  });

  it("osd:volume 事件同步外部静音变化（键盘静音键/其它软件），不发 invoke", () => {
    render(<AudioVisualizer />);
    emitOsd({ level: 0.5, muted: true });
    expect(btn()).toHaveAttribute("aria-pressed", "true");
    emitOsd({ level: 0.5, muted: false });
    expect(btn()).toHaveAttribute("aria-pressed", "false");
    expect(invokeMock).not.toHaveBeenCalledWith("toggle_system_mute", undefined);
  });

  it("挂载初值走 get_system_mute（晚挂载组件对齐系统现状）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "get_system_mute" ? true : null));
    render(<AudioVisualizer />);
    await waitFor(() => expect(btn()).toHaveAttribute("aria-pressed", "true"));
    expect(invokeMock).toHaveBeenCalledWith("get_system_mute", undefined);
  });

  it("静音角标按入场/退场过渡卸载（残迹不常驻）", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation(async (cmd: string) => (cmd === "toggle_system_mute" ? true : false));
      render(<AudioVisualizer />);
      fireEvent.click(btn());
      await act(async () => {}); // 冲刷 toggle promise（微任务不受假时钟影响）
      expect(screen.getByText("已静音")).toBeInTheDocument();
      // 1.5s 显示期 + 退场过渡（animMs≈250 + 10）后整节点卸载。
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByText("已静音")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
