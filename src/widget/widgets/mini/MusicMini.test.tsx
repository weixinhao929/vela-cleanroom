import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { NowPlaying } from "../../../lib/use-now-playing";

/**
 * MusicMini 回归：标题 + 播放/暂停按钮走 control_system_media；跑马只在
 * active 且标题溢出时挂 .is-marquee（active=false 停）；无媒体显占位。
 */
const state = vi.hoisted(() => ({ media: null as NowPlaying | null }));
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

vi.mock("../../../lib/use-now-playing", () => ({
  useNowPlaying: () => ({ media: state.media, pos: 0 })
}));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

import { MusicMini } from "./MusicMini";

const track = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  title: "夜空中最亮的星",
  artist: "逃跑计划",
  album: "",
  playing: true,
  position: 0,
  duration: 200,
  thumb: null,
  palette: { primary: "#4f7ecf", onPrimary: "#fff", track: "#123" },
  ...over
});

beforeEach(() => {
  state.media = null;
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
});

afterEach(() => {
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe("MusicMini", () => {
  it("播放中：显示标题、按钮为「暂停」，点击发 control_system_media toggle 且不冒泡", () => {
    state.media = track({ playing: true });
    const onTile = vi.fn();
    const { container } = render(
      <button onClick={onTile}>
        <MusicMini active />
      </button>
    );
    expect(screen.getByText("夜空中最亮的星")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "暂停" });
    expect(btn).toHaveAttribute("data-interactive");
    fireEvent.click(btn);
    // toggle 不依赖可能过期的 playing 快照（与卡片/沉浸页同口径）。
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", { action: "toggle" });
    expect(onTile).not.toHaveBeenCalled();
    // palette.primary 注入为点缀色变量。
    const root = container.querySelector(".dock-mini-music") as HTMLElement;
    expect(root.style.getPropertyValue("--mini-accent")).toBe("#4f7ecf");
  });

  it("暂停中：按钮为「播放」，点击同样发 toggle", () => {
    state.media = track({ playing: false, palette: null });
    render(<MusicMini active />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", { action: "toggle" });
  });

  it("键盘激活：Enter/Space 触发 toggle 且不冒泡到宿主磁贴（R4 回归网）", () => {
    state.media = track();
    const onTile = vi.fn();
    render(
      <button onClick={onTile}>
        <MusicMini active />
      </button>
    );
    const btn = screen.getByRole("button", { name: "暂停" });
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", { action: "toggle" });
    expect(onTile).not.toHaveBeenCalled();
    invokeMock.mockClear();
    fireEvent.keyDown(btn, { key: " " });
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", { action: "toggle" });
    // 其它键不触发。
    invokeMock.mockClear();
    fireEvent.keyDown(btn, { key: "ArrowRight" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("跑马：标题溢出且 active 才挂 .is-marquee；active=false 时静止", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 60 });
    state.media = track();
    const { container, rerender } = render(<MusicMini active />);
    const root = () => container.querySelector(".dock-mini-music") as HTMLElement;
    expect(root().classList.contains("is-marquee")).toBe(true);
    expect(root().style.getPropertyValue("--mini-scroll")).toBe("-140px");
    rerender(<MusicMini active={false} />);
    expect(root().classList.contains("is-marquee")).toBe(false);
  });

  it("无媒体：显示「暂无播放信息」，不渲染播放键", () => {
    render(<MusicMini active />);
    expect(screen.getByText("暂无播放信息")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
