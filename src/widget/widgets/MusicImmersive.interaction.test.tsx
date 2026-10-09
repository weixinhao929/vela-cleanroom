import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { NowPlaying } from "../../lib/use-now-playing";
import type { LrcLine } from "../../lib/lyrics";

/**
 * MusicImmersive 组件主体回归（此前仅 extractPalette 有契约测试）——
 * 歌词开关/取词状态机、行点击 seek、延迟微调与译文开关（写实例配置）、
 * 键盘 seek、repeat 三态 aria、active 门控频谱挂载。
 */
const state = vi.hoisted(() => ({
  media: null as NowPlaying | null,
  pos: 0
}));
const seekToMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
const fetchLyricsMock = vi.hoisted(() => vi.fn());
const updateConfigMock = vi.hoisted(() => vi.fn());
const configState = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock("../../lib/use-now-playing", () => ({
  useNowPlaying: (_active: boolean) => ({
    media: state.media, // media 常驻挂载语义：事件照常，仅 pos 推进受 active 门控
    pos: state.pos,
    seekTo: seekToMock
  })
}));

vi.mock("../../lib/media-sessions", () => ({
  useMediaSessions: () => ({
    sessions: [
      { id: "Spotify", name: "Spotify", playing: true },
      { id: "Chrome", name: "Chrome", playing: false }
    ],
    selectedId: "Spotify"
  })
}));

vi.mock("../widget-config", () => ({
  useWidgetConfig: () => ({ config: configState.config, update: updateConfigMock })
}));

vi.mock("../../lib/lyrics", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/lyrics")>();
  return { ...mod, fetchLyrics: fetchLyricsMock };
});

vi.mock("./AudioVisualizer", () => ({
  AudioVisualizer: () => <div data-testid="av-stub" />
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

vi.mock("../../lib/anim", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/anim")>();
  return { ...mod, prefersReducedMotion: () => false };
});

import { MusicImmersive } from "./MusicImmersive";

const LINES: LrcLine[] = [
  { time: 1, text: "第一句" },
  { time: 5, text: "第二句", translation: "second line" }
];

const track = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  title: "歌名",
  artist: "歌手",
  album: "",
  playing: true,
  position: 6,
  duration: 200,
  thumb: null,
  palette: null,
  controls: {
    play: true,
    pause: true,
    next: true,
    previous: true,
    seek: true,
    shuffle: true,
    repeat: true,
    shuffleActive: false,
    repeatMode: "off"
  },
  aumid: "Test.Player!App",
  ...over
});

beforeAll(() => {
  // jsdom 未实现 Element.scrollTo：歌词自动居中效果会调它，补哑桩。
  Element.prototype.scrollTo = vi.fn();
});

beforeEach(() => {
  state.media = track();
  state.pos = 6;
  configState.config = {};
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  seekToMock.mockClear();
  updateConfigMock.mockClear();
  fetchLyricsMock.mockReset();
  fetchLyricsMock.mockResolvedValue(LINES);
});

describe("MusicImmersive · repeat 三态 aria（R4-12）", () => {
  it.each([
    ["one", "单曲循环", true],
    ["all", "列表循环", true],
    ["off", "关闭循环", false]
  ])("repeatMode=%s → label=%s, aria-pressed=%s", (mode, label, pressed) => {
    state.media = track({ controls: { ...track().controls!, repeat: true, repeatMode: mode } });
    render(<MusicImmersive instanceId="mi" active />);
    const btn = screen.getByRole("button", { name: label });
    expect(btn.getAttribute("aria-pressed")).toBe(String(pressed));
    fireEvent.click(btn);
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", { action: "repeat" });
  });
});

describe("MusicImmersive · 歌词链路", () => {
  it("默认关闭；开启后取词（artist/title/album/duration）并渲染行 + 译文", async () => {
    render(<MusicImmersive instanceId="mi" active />);
    expect(screen.queryByText("第一句")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    expect(fetchLyricsMock).toHaveBeenCalledWith("歌手", "歌名", {
      album: "",
      durationSec: 200,
      signal: expect.any(AbortSignal)
    });
    expect(await screen.findByText("第二句")).toBeInTheDocument();
    expect(screen.getByText("second line")).toBeInTheDocument(); // 译文默认显示
  });

  it("歌词行点击 → seekTo(行时间)；不可 seek 时行不可点", async () => {
    const first = render(<MusicImmersive instanceId="mi" active />);
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    fireEvent.click(await screen.findByText("第一句"));
    expect(seekToMock).toHaveBeenCalledWith(1);
    first.unmount();

    // 不可 seek（能力位 false）：行点击不下发。
    state.media = track({ controls: { ...track().controls!, seek: false } });
    render(<MusicImmersive instanceId="mi" active />);
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    fireEvent.click(await screen.findByText("第一句"));
    expect(seekToMock).toHaveBeenCalledTimes(1); // 只有点了可 seek 那次
  });

  it("延迟微调 ±0.5s 写实例配置（lyricOffsetSec）", async () => {
    const { rerender } = render(<MusicImmersive instanceId="mi" active />);
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    await screen.findByText("第一句");
    fireEvent.click(screen.getByRole("button", { name: "歌词延后" }));
    expect(updateConfigMock).toHaveBeenCalledWith({ lyricOffsetSec: 0.5 });
    // 配置回读 -2 后再 −0.5：从现值出发（mock 配置需 rerender 才进闭包）。
    configState.config = { lyricOffsetSec: -2 };
    rerender(<MusicImmersive instanceId="mi" active />);
    fireEvent.click(screen.getByRole("button", { name: "歌词提前" }));
    expect(updateConfigMock).toHaveBeenLastCalledWith({ lyricOffsetSec: -2.5 });
  });

  it("译文开关：仅当歌词带译文时出现；点击写 lyricTranslation=false", async () => {
    render(<MusicImmersive instanceId="mi" active />);
    expect(screen.queryByRole("button", { name: "译文" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    fireEvent.click(await screen.findByRole("button", { name: "译文" }));
    expect(updateConfigMock).toHaveBeenCalledWith({ lyricTranslation: false });
  });

  it("取词失败 → 「暂无歌词」不崩溃", async () => {
    fetchLyricsMock.mockResolvedValue(null);
    render(<MusicImmersive instanceId="mi" active />);
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    expect(await screen.findByText("暂无歌词")).toBeInTheDocument();
  });
});

describe("MusicImmersive · 进度与频谱门控", () => {
  it("进度条键盘 seek：←/→ ±5s（Shift ±30s）、Home/End", () => {
    render(<MusicImmersive instanceId="mi" active />);
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(seekToMock).toHaveBeenLastCalledWith(11);
    fireEvent.keyDown(slider, { key: "ArrowLeft", shiftKey: true });
    expect(seekToMock).toHaveBeenLastCalledWith(0); // max(0, 6-30)
    fireEvent.keyDown(slider, { key: "End" });
    expect(seekToMock).toHaveBeenLastCalledWith(200);
  });

  it("active=false：频谱不挂载（收起即停采集）；active=true 挂载", () => {
    const { rerender } = render(<MusicImmersive instanceId="mi" active={false} />);
    expect(screen.queryByTestId("av-stub")).toBeNull();
    rerender(<MusicImmersive instanceId="mi" active />);
    expect(screen.getByTestId("av-stub")).toBeInTheDocument();
  });

  it("播放源按钮：显示锁定会话名，点击唤起播放器", () => {
    render(<MusicImmersive instanceId="mi" active />);
    fireEvent.click(screen.getByRole("button", { name: /播放源 · Spotify/ }));
    expect(invokeMock).toHaveBeenCalledWith("open_media_player", { aumid: "Test.Player!App", title: "歌名" });
  });
});
