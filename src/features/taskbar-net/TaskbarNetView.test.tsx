/**
 * 任务栏网速条视图（审计修复回归）：
 * - ：内容宽度实测上报（set_taskbar_net_width，宽度变化才发 IPC）；
 * - ：订阅走 netOnly 档（不把全系统遥测钉在 1Hz）；
 * - ：广播停帧超 2.5s 视为陈旧，回落 "—" 而不是冻结旧数字；
 * - ：hudGiveWay 悬停退役——点击穿透后 pointer 事件不再到达，无避让类。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

type Frame = { networks: { rx: number; tx: number }[] } | null;
let frame: Frame = null;
let capturedIntervalSec = 0;
let capturedNetOnly: boolean | undefined;
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

vi.mock("../../lib/system-stats", () => ({
  useSystemBroadcast: (intervalSec: number, opts?: { netOnly?: boolean }) => {
    capturedIntervalSec = intervalSec;
    capturedNetOnly = opts?.netOnly;
    return frame;
  },
  useNetRate: () => ({ fmt: (bps: number) => `${Math.round(bps / 1024)}K`, swap: false }),
  selectNetworkRows: (networks: { rx: number; tx: number }[]) =>
    networks.length ? [{ rx: networks[0].rx, tx: networks[0].tx }] : []
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

import { TaskbarNetView } from "./TaskbarNetView";

describe("TaskbarNetView · 审计修复回归", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    frame = null;
    capturedNetOnly = undefined;
    invokeMock.mockReset();
    // jsdom 无布局：scrollWidth 恒 0，的上报分支需要人为给宽度。
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return (this.classList.contains("taskbar-net") && 187) || 0;
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("P2-12/P1-5：1s + netOnly 订阅；首帧后按实测宽度上报一次", () => {
    const view = render(<TaskbarNetView />);
    expect(capturedIntervalSec).toBe(1);
    expect(capturedNetOnly).toBe(true);

    frame = { networks: [{ rx: 2048, tx: 4096 }] };
    act(() => {
      view.rerender(<TaskbarNetView />);
    });
    /* 容器不再挂 role="status"、数字区 aria-hidden
       （1Hz live region 会轰炸读屏）——查询改走容器类名而非语义角色。 */
    const root = view.container.querySelector(".taskbar-net") as HTMLElement;
    expect(root).toHaveTextContent("2K");
    expect(root).toHaveTextContent("4K");
    const widthCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "set_taskbar_net_width");
    expect(widthCalls).toHaveLength(1);
    expect(widthCalls[0][1]).toEqual({ width: 187 });
  });

  it("P2-13：停帧超 2.5s 回落「—」，恢复供帧后回到数字", () => {
    const view = render(<TaskbarNetView />);
    frame = { networks: [{ rx: 2048, tx: 4096 }] };
    act(() => {
      view.rerender(<TaskbarNetView />);
    });
    const root = view.container.querySelector(".taskbar-net") as HTMLElement;
    expect(root).toHaveTextContent("2K");

    // presence 暂停等场景：帧停更。3s 后判定陈旧。
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(root).toHaveTextContent("—");
    expect(root).not.toHaveTextContent("2K");

    // 供帧恢复：立即回到数字（该拍先标新鲜）。
    frame = { networks: [{ rx: 3072, tx: 6144 }] };
    act(() => {
      view.rerender(<TaskbarNetView />);
    });
    expect(root).toHaveTextContent("3K");
  });

  it("P0-2/P3-21：无 pointer 交互残留、无 role=status 读屏轰炸；数字区 aria-hidden", () => {
    const view = render(<TaskbarNetView />);
    const root = view.container.querySelector(".taskbar-net") as HTMLElement;
    expect(root.className).toBe("taskbar-net");
    // 纯展示 HUD 移出可访问性树——不再是 live region，数字区隐藏。
    expect(root.getAttribute("role")).toBeNull();
    const items = root.querySelectorAll(".taskbar-net-item");
    expect(items).toHaveLength(2);
    for (const item of Array.from(items)) {
      expect(item.getAttribute("aria-hidden")).toBe("true");
    }
  });
});
