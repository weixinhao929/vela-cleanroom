import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * （会话列表事件化）回归：初值拉取 + media:sessions 事件增量 +
 * 内容去抖 + active 门控。30s 兜底与可见性恢复属定时器路径，此处锁
 * 数据主链路（事件到达 → 分发 → 消费者快照更新）。
 */
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
const tauriListenHandlers = new Map<string, (e: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    tauriListenHandlers.set(event, handler);
    return Promise.resolve(() => tauriListenHandlers.delete(event));
  }
}));

vi.mock("./tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./tauri")>();
  return {
    ...mod,
    isTauri: () => true,
    invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args)
  };
});

import { useMediaSessions, __resetMediaSessionsForTest, teardownMediaSessions } from "./media-sessions";

/** 发一条 media:sessions 事件；未注册监听时返回 false（active=false 未订阅）。 */
const emitSessions = async (payload: unknown): Promise<boolean> => {
  await act(async () => {});
  const h = tauriListenHandlers.get("media:sessions");
  if (!h) return false;
  act(() => h({ payload }));
  return true;
};

const page = (
  sessions: { id: string; name?: string; playing?: boolean; blocked?: boolean }[],
  selected?: string | null
) => ({
  sessions: sessions.map((s) => ({
    name: s.name ?? s.id,
    playing: s.playing ?? false,
    blocked: s.blocked ?? false,
    ...s
  })),
  selected_id: selected ?? null
});

beforeEach(() => {
  __resetMediaSessionsForTest();
  tauriListenHandlers.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ sessions: [], selected_id: null });
});

describe("useMediaSessions（事件化单例）", () => {
  it("首个订阅者触发初值拉取一次；事件增量更新快照", async () => {
    invokeMock.mockResolvedValue(page([{ id: "Spotify", playing: true }], "Spotify"));
    const { result } = renderHook(() => useMediaSessions(true));
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.sessions.map((s) => s.id)).toEqual(["Spotify"]);
    expect(result.current.selectedId).toBe("Spotify");

    // 事件增量：新增会话 + 解锁。
    await emitSessions(page([{ id: "Spotify", playing: true }, { id: "Chrome" }], null));
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.selectedId).toBeNull();
  });

  it("内容不变的事件不触发分发（去抖）；仅 selectedId 变化会分发", async () => {
    invokeMock.mockResolvedValue(page([{ id: "A" }]));
    const { result } = renderHook(() => useMediaSessions(true));
    await act(async () => {});
    const before = result.current;
    await emitSessions(page([{ id: "A" }]));
    expect(result.current).toBe(before); // 引用不变 → 消费方不重渲

    await emitSessions(page([{ id: "A" }], "A"));
    expect(result.current.selectedId).toBe("A");
    expect(result.current).not.toBe(before);
  });

  it("active=false：不订阅，返回空快照（固定引用）", async () => {
    invokeMock.mockResolvedValue(page([{ id: "A" }]));
    const { result } = renderHook(() => useMediaSessions(false));
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.sessions).toEqual([]);
    expect(result.current.selectedId).toBeNull();
    // 未订阅：监听从未注册，事件无处到达。
    expect(await emitSessions(page([{ id: "B" }]))).toBe(false);
    expect(result.current.sessions).toEqual([]);
  });
});

describe("useMediaSessions · 兜底复核与拆装（F9 定时器路径，R4 回归网）", () => {
  const setHidden = (v: boolean) => Object.defineProperty(document, "hidden", { configurable: true, get: () => v });

  it("30s 兜底复核：可见且有订阅者时重拉；隐藏期间跳拍；恢复可见立即拉一次", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockResolvedValue(page([{ id: "A" }]));
      const { unmount } = renderHook(() => useMediaSessions(true));
      await act(async () => {});
      expect(invokeMock).toHaveBeenCalledTimes(1);

      // 隐藏期间：定时器到点也不拉（review 跳拍）。
      setHidden(true);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(invokeMock).toHaveBeenCalledTimes(1);

      // 恢复可见：visibilitychange 立即补一拍。
      setHidden(false);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(invokeMock).toHaveBeenCalledTimes(2);

      // 可见状态下 30s 定时器正常兜底。
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(invokeMock).toHaveBeenCalledTimes(3);
      unmount();
    } finally {
      vi.useRealTimers();
      setHidden(false);
    }
  });

  it("teardownMediaSessions：拆尽 interval/visibilitychange/事件监听，重订不叠加第二份", async () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(window, "setInterval");
    try {
      const first = renderHook(() => useMediaSessions(true));
      await act(async () => {});
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      first.unmount();

      teardownMediaSessions();
      // 事件监听一并拆除：媒体事件不再到达。
      expect(tauriListenHandlers.has("media:sessions")).toBe(false);

      // 重订：只装一份 interval（不随拆装叠加）。
      const second = renderHook(() => useMediaSessions(true));
      await act(async () => {});
      expect(intervalSpy).toHaveBeenCalledTimes(2);
      second.unmount();
    } finally {
      vi.useRealTimers();
      intervalSpy.mockRestore();
    }
  });
});
