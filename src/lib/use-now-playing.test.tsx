import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * §4.8 useNowPlaying 回归：事件快照应用（封面增量协议）、空闲清空、
 * 锚点插值本地推进（250ms 步进、按真实流逝时间、曲长钳制）、seekTo
 * 乐观跳转、首帧命令拉取。
 */

const eventHandlers = new Map<string, (payload: unknown) => void>();
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

vi.mock("./use-tauri-event", () => ({
  useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
    eventHandlers.set(event, handler);
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

import { useNowPlaying, type NowPlaying } from "./use-now-playing";

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

const emitMedia = (payload: unknown) => act(() => eventHandlers.get("media:snapshot")!(payload));

beforeEach(() => {
  eventHandlers.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNowPlaying", () => {
  it("事件快照入态；thumbChanged=false 沿用上次封面", () => {
    const { result } = renderHook(() => useNowPlaying());
    emitMedia(snap({ thumbChanged: true, thumb: "data:image/png;base64,AAA" }));
    expect(result.current.media?.thumb).toBe("data:image/png;base64,AAA");
    expect(result.current.pos).toBe(30);

    // 播放态变化事件（封面未变）：thumb 保持。
    emitMedia(snap({ playing: false, position: 42, thumbChanged: false }));
    expect(result.current.media?.playing).toBe(false);
    expect(result.current.media?.thumb).toBe("data:image/png;base64,AAA");
    expect(result.current.pos).toBe(42);
  });

  it("thumbChanged=true 且 thumb=null 表示封面清除", () => {
    const { result } = renderHook(() => useNowPlaying());
    emitMedia(snap({ thumbChanged: true, thumb: "data:image/png;base64,AAA" }));
    emitMedia(snap({ thumbChanged: true, thumb: null }));
    expect(result.current.media?.thumb).toBeNull();
  });

  it("空载荷（无会话）清空显示", () => {
    const { result } = renderHook(() => useNowPlaying());
    emitMedia(snap());
    emitMedia(null);
    expect(result.current.media).toBeNull();
    expect(result.current.pos).toBe(0);
  });

  it("palette 增量：null 沿用上次，携带时替换", () => {
    const { result } = renderHook(() => useNowPlaying());
    const blue = { primary: "#4f7ecf", onPrimary: "#ffffff", track: "#1d2a45" };
    emitMedia(snap({ palette: blue }));
    expect(result.current.media?.palette).toEqual(blue);

    // 播放态变化事件（palette 未携带）：沿用。
    emitMedia(snap({ playing: false, position: 40 }));
    expect(result.current.media?.palette).toEqual(blue);

    // 换曲携带新取色：替换。
    const warm = { primary: "#cf8a4f", onPrimary: "#101418", track: "#453a1d" };
    emitMedia(snap({ title: "新歌", palette: warm, thumbChanged: true, thumb: null }));
    expect(result.current.media?.palette).toEqual(warm);
  });

  it("播放中 250ms 本地推进；暂停冻结", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    emitMedia(snap({ playing: true, position: 10 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.pos).toBeCloseTo(10.5, 5);

    emitMedia(snap({ playing: false, position: 11 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.pos).toBe(11);
  });

  it("推进按真实流逝时间插值（不累加漂移）并钳制到曲长", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    emitMedia(snap({ playing: true, position: 199.5, duration: 200 }));
    // 距曲末 0.5s，快进 2s：推进不越过曲长（曲目结束态）。
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.pos).toBe(200);
  });

  it("seekTo 乐观跳转并以秒为单位下发 seek 命令", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    emitMedia(snap({ playing: false, position: 10 }));
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
    emitMedia(snap({ controls: ctl }));
    expect(result.current.media?.controls).toEqual(ctl);
    // 后续事件未携带 controls（能力位未变的那一拍）：沿用。
    emitMedia(snap({ playing: false, position: 40 }));
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

  it("自愈补拉：media 为空期间每 4s 重拉，拉到数据即入态并停止", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNowPlaying());
    await act(async () => {}); // 首帧拉取（resolve null）冲刷
    expect(invokeMock).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
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
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.media?.title).toBe("自愈歌");
    // 有数据后不再补拉（自愈轮询只服务于空态）。
    const calls = invokeMock.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(12000);
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
    emitMedia(snap());
    invokeMock.mockClear();
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
