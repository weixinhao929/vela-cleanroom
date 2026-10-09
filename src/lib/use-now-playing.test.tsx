import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * §4.8 useNowPlaying 回归：事件快照应用（封面增量协议）、空闲清空、
 * 锚点插值本地推进（250ms 步进、按真实流逝时间、曲长钳制）、seekTo
 * 乐观跳转、首帧命令拉取、空态自愈退避。
 * 收敛后 media:snapshot 走模块级单例 store（动态 import listen），
 * 每个用例前重置 store 保证隔离。
 */
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

/* 单例 store 经动态 import("@tauri-apps/api/event") 订阅 media:snapshot
   （listen 的载荷包在 e.payload 里）。 */
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

import { __resetNowPlayingStoreForTest, useMediaPlaying, useNowPlaying, type NowPlaying } from "./use-now-playing";

const snap = (over: Partial<Record<string, unknown>> = {}) => ({
  title: "歌",
  artist: "歌手",
  album: "专辑",
  playing: true,
  position: 30,
  duration: 200,
  thumbChanged: false,
  thumb: null,
  ...over
});

/** 先冲一拍微任务让动态 import 的 listen 注册完成，再同步派发事件。 */
const emitMedia = async (payload: unknown) => {
  await act(async () => {});
  act(() => tauriListenHandlers.get("media:snapshot")!({ payload }));
};

beforeEach(() => {
  __resetNowPlayingStoreForTest();
  tauriListenHandlers.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNowPlaying", () => {
  it("事件快照入态；thumbChanged=false 沿用上次封面", async () => {
    const { result } = renderHook(() => useNowPlaying());
    await emitMedia(snap({ thumbChanged: true, thumb: "data:image/png;base64,AAA" }));
    expect(result.current.media?.thumb).toBe("data:image/png;base64,AAA");
    expect(result.current.pos).toBe(30);

    // 播放态变化事件（封面未变）：thumb 保持。
    await emitMedia(snap({ playing: false, position: 42, thumbChanged: false }));
    expect(result.current.media?.playing).toBe(false);
    expect(result.current.media?.thumb).toBe("data:image/png;base64,AAA");
    expect(result.current.pos).toBe(42);
  });

  it("thumbChanged=true 且 thumb=null 表示封面清除", async () => {
    const { result } = renderHook(() => useNowPlaying());
    await emitMedia(snap({ thumbChanged: true, thumb: "data:image/png;base64,AAA" }));
    await emitMedia(snap({ thumbChanged: true, thumb: null }));
    expect(result.current.media?.thumb).toBeNull();
  });

  it("空载荷（无会话）清空显示", async () => {
    const { result } = renderHook(() => useNowPlaying());
    await emitMedia(snap());
    await emitMedia(null);
    expect(result.current.media).toBeNull();
    expect(result.current.pos).toBe(0);
  });

  it("palette 增量：null 沿用上次，携带时替换", async () => {
    const { result } = renderHook(() => useNowPlaying());
    const blue = { primary: "#4f7ecf", onPrimary: "#ffffff", track: "#1d2a45" };
    await emitMedia(snap({ palette: blue }));
    expect(result.current.media?.palette).toEqual(blue);

    // 播放态变化事件（palette 未携带）：沿用。
    await emitMedia(snap({ playing: false, position: 40 }));
    expect(result.current.media?.palette).toEqual(blue);

    // 换曲携带新取色：替换。
    const warm = { primary: "#cf8a4f", onPrimary: "#101418", track: "#453a1d" };
    await emitMedia(snap({ title: "新歌", palette: warm, thumbChanged: true, thumb: null }));
    expect(result.current.media?.palette).toEqual(warm);
  });

  it("播放中 250ms 本地推进；暂停冻结", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    await emitMedia(snap({ playing: true, position: 10 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.pos).toBeCloseTo(10.5, 5);

    await emitMedia(snap({ playing: false, position: 11 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.pos).toBe(11);
  });

  it("推进按真实流逝时间插值（不累加漂移）并钳制到曲长", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    await emitMedia(snap({ playing: true, position: 199.5, duration: 200 }));
    // 距曲末 0.5s，快进 2s：推进不越过曲长（曲目结束态）。
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.pos).toBe(200);
  });

  it("seekTo 乐观跳转并以秒为单位下发 seek 命令", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    await emitMedia(snap({ playing: false, position: 10 }));
    invokeMock.mockClear();
    act(() => {
      result.current.seekTo(75.5);
    });
    expect(result.current.pos).toBe(75.5);
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", {
      action: "seek",
      position: 75.5
    });
    // 暂停状态下 seek 后推进保持冻结。
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.pos).toBe(75.5);
  });

  it("controls 随快照更新：缺失时沿用上次，不误清", async () => {
    const { result } = renderHook(() => useNowPlaying());
    const ctl = {
      play: true,
      pause: true,
      next: true,
      previous: false,
      seek: true,
      shuffle: true,
      repeat: true,
      shuffleActive: false,
      repeatMode: "off"
    };
    await emitMedia(snap({ controls: ctl }));
    expect(result.current.media?.controls).toEqual(ctl);
    // 后续事件未携带 controls（能力位未变的那一拍）：沿用。
    await emitMedia(snap({ playing: false, position: 40 }));
    expect(result.current.media?.controls).toEqual(ctl);
  });

  it("首帧经 get_system_media_info 全量拉取（thumbChanged 语义补全）", async () => {
    invokeMock.mockResolvedValue({
      title: "首帧歌",
      artist: "A",
      album: "",
      playing: true,
      position: 5,
      duration: 100,
      thumb: "data:image/png;base64,FFF",
      palette: null
    } satisfies NowPlaying);
    const { result } = renderHook(() => useNowPlaying());
    await vi.waitFor(() => expect(result.current.media?.title).toBe("首帧歌"));
    expect(result.current.media?.thumb).toBe("data:image/png;base64,FFF");
    expect(result.current.pos).toBe(5);
  });

  it("自愈补拉：空态按 4s→8s→15s 退避重拉，拉到数据即入态并停止", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    await act(async () => {}); // 首帧拉取（resolve null）冲刷
    expect(invokeMock).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    // 第二档 8s：累计 4s 处未到点，不拉。
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    invokeMock.mockResolvedValue({
      title: "自愈歌",
      artist: "A",
      album: "",
      playing: true,
      position: 7,
      duration: 100,
      thumb: null,
      palette: null
    } satisfies NowPlaying);
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(result.current.media?.title).toBe("自愈歌");
    // 有数据后不再补拉（自愈轮询只服务于空态，档位归零）。
    const calls = invokeMock.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(calls);
  });

  it("active 翻转为可见且无数据时立即补拉；已有数据不拉", async () => {
    const { rerender } = renderHook(({ active }: { active: boolean }) => useNowPlaying(active), {
      initialProps: { active: false }
    });
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledTimes(1); // 首帧拉取照常
    invokeMock.mockClear();
    rerender({ active: true });
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // 已有数据后再翻转：不补拉。
    await emitMedia(snap());
    invokeMock.mockClear();
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("单例共享：两个消费者只拉一次初值；inactive 消费者不随 pos 推进", async () => {
    vi.useFakeTimers();
    const a = renderHook(() => useNowPlaying());
    const b = renderHook(() => useNowPlaying(false));
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await emitMedia(snap({ playing: true, position: 10 }));
    expect(a.result.current.pos).toBe(10);
    // inactive 消费者 media 到达照常（换曲级别重渲读到事件锚点），
    // 但不订阅 4Hz 推进节拍：1s 后 a 前进、b 冻结在事件锚点。
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(a.result.current.pos).toBeCloseTo(11, 5);
    expect(b.result.current.pos).toBe(10);
    a.unmount();
    b.unmount();
  });

  it("F-9 heal 空转自停：无消费者且无媒体连拍后停表；新消费者经 ensureHeal 重启（R4 回归网）", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useNowPlaying());
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledTimes(1); // 首帧拉取
    unmount();

    // 消费者归零且无媒体：4s/8s/15s 三拍空转后自停（期间不实际拉取）。
    act(() => {
      vi.advanceTimersByTime(4000 + 8000 + 15000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // 自停后再过一分钟也无声唤醒。
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // 新消费者到来：重启 heal（退避档已归零，首拍 4s）→ 恢复补拉。
    renderHook(() => useNowPlaying());
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("useMediaPlaying 单例（P2 收敛）", () => {
  const emitTauriMedia = async (payload: unknown) => {
    await act(async () => {});
    act(() => tauriListenHandlers.get("media:snapshot")!({ payload }));
  };

  it("多处消费共享一份监听与一次初值拉取，播放态翻转同步通知", async () => {
    const a = renderHook(() => useMediaPlaying());
    const b = renderHook(() => useMediaPlaying());
    await act(async () => {});
    expect(a.result.current).toBe(false);
    expect(b.result.current).toBe(false);
    // 初值拉取只发生一次（第二个消费者挂载不再拉）。
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "get_system_media_info")).toHaveLength(1);

    await emitTauriMedia(snap({ playing: true }));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);

    await emitTauriMedia(snap({ playing: false }));
    expect(a.result.current).toBe(false);
    expect(b.result.current).toBe(false);

    // 空载荷（无会话）与「有会话但无标题」都不算播放中。
    await emitTauriMedia(snap({ playing: true, title: "" }));
    expect(a.result.current).toBe(false);
    await emitTauriMedia(null);
    expect(a.result.current).toBe(false);

    a.unmount();
    b.unmount();
  });

  it("事件先到后，陈旧的初值回复不回退覆盖播放态", async () => {
    let resolveInfo: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "get_system_media_info" ? new Promise((r) => (resolveInfo = r)) : Promise.resolve(null)
    );
    const { result } = renderHook(() => useMediaPlaying());
    await act(async () => {});
    // 初值请求在途时事件先到（暂停）：事件胜出，稍后回复的 playing=true 不回写。
    await emitTauriMedia(snap({ playing: false }));
    resolveInfo({ playing: true, title: "歌" });
    await act(async () => {});
    expect(result.current).toBe(false);
  });
});
