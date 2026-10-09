import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NowPlaying } from "../../lib/use-now-playing";

/**
 * MusicWidget 组件回归：布局渲染（频谱状态行 / 正在播放卡）、audio:status
 * 降级与口径冲突提示、播放控制走 toggle、配置开关（showStatusText）。
 * 数据源全部 mock（use-now-playing / media-sessions / tauri），事件经
 * use-tauri-event 的捕获表手工派发。
 */
const state = vi.hoisted(() => ({
  media: null as NowPlaying | null,
  sessions: [] as { id: string; name: string; playing: boolean; blocked?: boolean }[],
  selected: null as string | null,
  audioStatus: null as unknown
}));
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
const eventHandlers = new Map<string, (payload: unknown) => void>();
/** 稳定身份的 seekTo 桩（此前 mock 里每次渲染新建 vi.fn，断言不到）。 */
const seekToMock = vi.hoisted(() => vi.fn());
/** 会话菜单桩——openContextMenu 是 store 驱动的全局面板，直接捕获 items。 */
const menuSpy = vi.hoisted(() => vi.fn());

vi.mock("../../lib/use-tauri-event", () => ({
  useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
    eventHandlers.set(event, handler);
  }
}));

vi.mock("../../lib/use-now-playing", () => ({
  useNowPlaying: () => ({ media: state.media, pos: state.media?.position ?? 0, seekTo: seekToMock })
}));

vi.mock("../../lib/media-sessions", () => ({
  useMediaSessions: () => ({ sessions: state.sessions, selectedId: state.selected })
}));

vi.mock("../../components/ContextMenu", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../components/ContextMenu")>();
  return { ...mod, openContextMenu: (...args: unknown[]) => menuSpy(...args) };
});

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

import { MusicWidget } from "./MusicWidget";
import { useSettingsStore } from "../../store/settings-store";

const ID = "music-test";
const CFG_KEY = `focus-desk.widget-config.${ID}.v1`;

const track = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  title: "夜空中最亮的星",
  artist: "逃跑计划",
  album: "",
  playing: true,
  position: 30,
  duration: 200,
  thumb: null,
  palette: null,
  controls: {
    play: true,
    pause: true,
    next: true,
    previous: true,
    seek: true,
    shuffle: false,
    repeat: false,
    shuffleActive: false,
    repeatMode: "off"
  },
  aumid: "Test.Player!App",
  ...over
});

/** 发一条 Tauri 事件（audio:status / audio:spectrum …）。 */
const emit = (event: string, payload: unknown) => act(() => eventHandlers.get(event)?.(payload));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "spectrum", showStatusText: true }));
  state.media = null;
  state.sessions = [];
  state.selected = null;
  state.audioStatus = null;
  eventHandlers.clear();
  invokeMock.mockReset();
  seekToMock.mockClear();
  menuSpy.mockClear();
  // 媒体行为偏好回默认（会话菜单用例会经 setGeneral 写入真实 store）。
  useSettingsStore.setState((s) => ({
    general: { ...s.general, media: { pauseOthers: false, blockedSessions: [], focusPause: false } }
  }));
  // get_audio_status 初值：默认无（null）。
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "get_audio_status" ? null : null));
});

afterEach(() => {
  localStorage.clear();
});

describe("MusicWidget · 频谱布局状态行", () => {
  it("默认显示「监听中」与检测源文案；无降级/口径提示", () => {
    render(<MusicWidget instanceId={ID} />);
    expect(screen.getByText("监听中")).toBeInTheDocument();
    expect(screen.getByText("系统音频实时频谱")).toBeInTheDocument();
    expect(screen.queryByText(/麦克风不可用/)).toBeNull();
    expect(screen.queryByText(/跟随全局/)).toBeNull();
  });

  it("audio:status：麦克风源失败 → 「麦克风不可用」；口径被顶掉 → 「跟随全局」", async () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "spectrum", showStatusText: true, mode: "both" }));
    render(<MusicWidget instanceId={ID} />);
    expect(screen.getByText("播放 + 麦克风实时频谱")).toBeInTheDocument();
    emit("audio:status", {
      mode: "both",
      dist: "log",
      sources: [
        { kind: "loopback", ok: true },
        { kind: "capture", ok: false }
      ]
    });
    expect(screen.getByText(/麦克风不可用/)).toBeInTheDocument();
    // 口径一致（both/log）不提示跟随全局。
    expect(screen.queryByText(/跟随全局/)).toBeNull();
    // 别的窗口把管线顶成 playback：口径冲突提示出现。
    emit("audio:status", { mode: "playback", dist: "log", sources: [{ kind: "loopback", ok: true }] });
    expect(screen.getByText(/跟随全局/)).toBeInTheDocument();
  });

  it("showStatusText=false：状态行整体隐藏", () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "spectrum", showStatusText: false }));
    render(<MusicWidget instanceId={ID} />);
    expect(screen.queryByText("监听中")).toBeNull();
    expect(screen.queryByText("系统音频实时频谱")).toBeNull();
  });
});

describe("MusicWidget · 正在播放卡", () => {
  it("无媒体显示占位；有媒体显示曲目，播放/暂停走 toggle", async () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    const { rerender } = render(<MusicWidget instanceId={ID} />);
    expect(screen.getByText("暂无播放信息")).toBeInTheDocument();

    state.media = track();
    rerender(<MusicWidget instanceId={ID} />);
    expect(screen.getByText("夜空中最亮的星")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", { action: "toggle" });
    fireEvent.click(screen.getByRole("button", { name: "下一曲" }));
    expect(invokeMock).toHaveBeenCalledWith("control_system_media", { action: "next" });
  });

  it("时长未知（直播）：不渲染进度拖条，只留时间", () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    state.media = track({ duration: 0, position: 75 });
    render(<MusicWidget instanceId={ID} />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByText("1:15")).toBeInTheDocument();
    expect(screen.queryByText("0:00")).toBeNull();
  });

  it("有时长：进度条以 slider 暴露并带 aria 值", () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    state.media = track({ position: 100, duration: 200 });
    render(<MusicWidget instanceId={ID} />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "200");
    expect(slider.getAttribute("aria-valuenow")).toBeTruthy();
  });

  it("键盘 seek：←/→ ±5s（Shift ±30s）、Home/End 到首尾（R4 回归网）", () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    state.media = track({ position: 100, duration: 200 });
    const { rerender } = render(<MusicWidget instanceId={ID} />);
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(seekToMock).toHaveBeenLastCalledWith(105);
    fireEvent.keyDown(slider, { key: "ArrowLeft", shiftKey: true });
    expect(seekToMock).toHaveBeenLastCalledWith(70);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(seekToMock).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: "End" });
    expect(seekToMock).toHaveBeenLastCalledWith(200);
    // 不可 seek（能力位 false）：按键不下发（需 rerender 让新 controls 进闭包）。
    state.media = track({ position: 100, duration: 200, controls: { ...track().controls!, seek: false } });
    rerender(<MusicWidget instanceId={ID} />);
    seekToMock.mockClear();
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(seekToMock).not.toHaveBeenCalled();
  });

  it("封面按钮：有 aumid 时可打开播放器；无 aumid 时不暴露 button 语义（R4-13）", async () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    state.media = track();
    const { rerender } = render(<MusicWidget instanceId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "打开播放器" }));
    expect(invokeMock).toHaveBeenCalledWith("open_media_player", { aumid: "Test.Player!App", title: "夜空中最亮的星" });

    // 无 aumid：退化为纯封面容器，读屏不再遇到打不开的按钮。
    state.media = track({ aumid: undefined });
    rerender(<MusicWidget instanceId={ID} />);
    expect(screen.queryByRole("button", { name: "打开播放器" })).toBeNull();
  });

  it("滚轮调应用音量：上滚 +5%，回显浮标 + 灵动岛 OSD 广播（R4 回归网）", async () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    state.media = track();
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "adjust_media_app_volume" ? 0.55 : null));
    const osd: unknown[] = [];
    window.addEventListener("focus-desk:osd", (e) => osd.push((e as CustomEvent).detail));
    render(<MusicWidget instanceId={ID} />);
    fireEvent.wheel(screen.getByText("夜空中最亮的星"), { deltaY: -100 });
    expect(invokeMock).toHaveBeenCalledWith("adjust_media_app_volume", {
      aumid: "Test.Player!App",
      delta: 0.05
    });
    expect(await screen.findByText("55%")).toBeInTheDocument();
    expect(osd).toEqual([{ kind: "volume", title: "应用音量", sub: "55%" }]);
    // wheelVolume=false：滚轮静默。
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying", wheelVolume: false }));
    invokeMock.mockClear();
    rerenderFresh();
    fireEvent.wheel(screen.getByText("夜空中最亮的星"), { deltaY: -100 });
    expect(invokeMock).not.toHaveBeenCalledWith("adjust_media_app_volume", expect.anything());
  });
});

/** 重新挂载（配置经 localStorage 读取，需要干净 remount 生效）。 */
function rerenderFresh() {
  cleanup();
  render(<MusicWidget instanceId={ID} />);
}

describe("MusicWidget · 会话菜单（W-123/W-131，R4 回归网）", () => {
  type MenuItem = { label?: string; onSelect?: () => void; type?: string };
  const itemsOf = (): MenuItem[] => (menuSpy.mock.calls.at(-1)?.[1] as MenuItem[]) ?? [];

  it("右键卡片：自动项 + 会话列表（在播 ▶ 图标位）+ 独占播放 + 隐藏入口 + 已隐藏恢复", async () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    state.media = track();
    state.sessions = [
      { id: "Spotify", name: "Spotify", playing: true },
      { id: "Chrome", name: "Chrome", playing: false },
      { id: "Ghost", name: "Ghost", playing: false, blocked: true }
    ];
    // Ghost 已在黑名单（store 与会话分页两侧同源）。
    useSettingsStore.setState((s) => ({
      general: { ...s.general, media: { pauseOthers: false, blockedSessions: ["Ghost"], focusPause: false } }
    }));
    const { container } = render(<MusicWidget instanceId={ID} />);
    const card = container.querySelector(".np")!;
    fireEvent.contextMenu(card);

    const labels = itemsOf().map((i) => i.label ?? "");
    expect(labels).toContain("自动选择播放源");
    expect(labels).toContain("Spotify");
    expect(labels).toContain("独占播放");
    expect(labels).toContain("隐藏播放源…");
    expect(labels.some((l) => l.includes("已隐藏") && l.includes("Ghost"))).toBe(true);

    // 锁定会话：onSelect → select_media_session。
    itemsOf()
      .find((i) => i.label === "Spotify")!
      .onSelect?.();
    expect(invokeMock).toHaveBeenCalledWith("select_media_session", { id: "Spotify" });
    // 自动模式：id=null。
    itemsOf()
      .find((i) => i.label === "自动选择播放源")!
      .onSelect?.();
    expect(invokeMock).toHaveBeenCalledWith("select_media_session", { id: null });

    // 独占播放开关：写全局设置（前端 store）。
    itemsOf()
      .find((i) => i.label === "独占播放")!
      .onSelect?.();
    expect(useSettingsStore.getState().general.media?.pauseOthers).toBe(true);

    // 已隐藏恢复：从黑名单移除。
    itemsOf()
      .find((i) => typeof i.label === "string" && i.label.includes("Ghost"))!
      .onSelect?.();
    expect(useSettingsStore.getState().general.media?.blockedSessions).toEqual([]);
  });

  it("全部会话被隐藏时：菜单只剩自动项 + 已隐藏区（独占/隐藏入口随可见列表收起）", () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ layout: "nowplaying" }));
    state.media = track();
    state.sessions = [{ id: "Ghost", name: "Ghost", playing: false, blocked: true }];
    useSettingsStore.setState((s) => ({
      general: { ...s.general, media: { pauseOthers: false, blockedSessions: ["Ghost"], focusPause: false } }
    }));
    const { container } = render(<MusicWidget instanceId={ID} />);
    fireEvent.contextMenu(container.querySelector(".np")!);
    const labels = itemsOf().map((i) => i.label ?? "");
    expect(labels).toContain("自动选择播放源");
    expect(labels).not.toContain("独占播放");
    expect(labels).not.toContain("隐藏播放源…");
  });
});
