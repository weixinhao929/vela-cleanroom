import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QQ / 网易云引擎分支（isTauri=true，经 fetch_lyric_page 受控代理）
 * + 引擎链降级顺序 + 时长校验 + abort 不写负缓存。
 * 此前 lyrics.test.ts 只覆盖浏览器模式（isTauri=false，仅 LRCLIB）。
 */
const invokeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => null));
const fetchJsonMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => null));

vi.mock("./tauri", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invokeMock(...args)
}));
vi.mock("./network", () => ({ fetchJson: (...args: unknown[]) => fetchJsonMock(...args) }));

import { fetchLyrics, isLyricsCacheMiss, readLyricsCache } from "./lyrics";

/** fetch_lyric_page 代理桩：按 URL 分派到预置响应表。 */
type ProxyRoute = { match: (url: string) => boolean; body: unknown; status?: number };
const routeProxy = (routes: ProxyRoute[]) => {
  invokeMock.mockImplementation(async (...args: unknown[]) => {
    const url = String((args[1] as { url?: string } | undefined)?.url ?? "");
    for (const r of routes) {
      if (r.match(url)) return { status: r.status ?? 200, body: JSON.stringify(r.body) };
    }
    return { status: 404, body: "" };
  });
};

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  fetchJsonMock.mockReset();
  fetchJsonMock.mockResolvedValue(null);
});

describe("lyrics 引擎 1：QQ 音乐（优先，trans 译文一步到位）", () => {
  it("搜索命中 → 歌词 + 译文对齐 → 正缓存 source=qq，不走 LRCLIB", async () => {
    routeProxy([
      {
        match: (u) => u.includes("client_search_cp"),
        body: { data: { song: { list: [{ songname: "歌名", singer: [{ name: "歌手" }], songmid: "MID1" }] } } }
      },
      {
        match: (u) => u.includes("fcg_query_lyric_new"),
        body: { lyric: "[00:01.00]原文", trans: "[00:01.10]译文" }
      }
    ]);
    const lines = await fetchLyrics("歌手", "歌名");
    expect(lines?.[0]?.text).toBe("原文");
    expect(lines?.[0]?.translation).toBe("译文");
    expect(readLyricsCache("歌手", "歌名")?.source).toBe("qq");
    expect(fetchJsonMock).not.toHaveBeenCalled();
    // 二次调用吃缓存：代理零请求。
    const calls = invokeMock.mock.calls.length;
    await fetchLyrics("歌手", "歌名");
    expect(invokeMock.mock.calls.length).toBe(calls);
  });

  it("搜索无匹配（歌名/歌手对不上）→ 引擎返回 null 落到下一家", async () => {
    routeProxy([
      {
        match: (u) => u.includes("client_search_cp"),
        body: { data: { song: { list: [{ songname: "完全无关", singer: [{ name: "路人" }], songmid: "X" }] } } }
      }
    ]);
    fetchJsonMock.mockResolvedValue(null); // LRCLIB 也无词
    const lines = await fetchLyrics("歌手", "歌名");
    expect(lines).toBeNull();
    // 网易云搜索也被尝试过（引擎链顺序：QQ → 网易云 → LRCLIB）。
    const urls = invokeMock.mock.calls.map((c) => String((c[1] as { url?: string } | undefined)?.url ?? ""));
    expect(urls.some((u) => u.includes("music.163.com/api/search"))).toBe(true);
    expect(fetchJsonMock).toHaveBeenCalledTimes(2); // LRCLIB get + search
  });
});

describe("lyrics 引擎 2：网易云（时长 ±4s 校验 + tlyric）", () => {
  it("时长超差的候选被跳过，±4s 内的候选胜出；tlyric 贴行", async () => {
    routeProxy([
      { match: (u) => u.includes("client_search_cp"), body: {} },
      {
        match: (u) => u.includes("music.163.com/api/search"),
        body: {
          result: {
            songs: [
              { name: "歌名", artists: [{ name: "歌手" }], id: 111, duration: 300_000 }, // 300s，超差
              { name: "歌名", artists: [{ name: "歌手" }], id: 222, duration: 200_000 } // 200s，命中
            ]
          }
        }
      },
      {
        match: (u) => u.includes("/api/song/lyric"),
        body: { lrc: { lyric: "[00:02.00]词" }, tlyric: { lyric: "[00:02.00]译" } }
      }
    ]);
    const lines = await fetchLyrics("歌手", "歌名", { durationSec: 200 });
    expect(lines?.[0]?.text).toBe("词");
    expect(lines?.[0]?.translation).toBe("译");
    expect(readLyricsCache("歌手", "歌名")?.source).toBe("netease");
    // 请求的是第二个候选（id=222）。
    const lyricCall = invokeMock.mock.calls
      .map((c) => String((c[1] as { url?: string } | undefined)?.url ?? ""))
      .find((u) => u.includes("/api/song/lyric"));
    expect(lyricCall).toContain("id=222");
  });

  it("无时长信息时不否决（duration 缺省跳过校验）", async () => {
    routeProxy([
      { match: (u) => u.includes("client_search_cp"), body: {} },
      {
        match: (u) => u.includes("music.163.com/api/search"),
        body: { result: { songs: [{ name: "歌名", artists: [{ name: "歌手" }], id: 333, duration: 0 }] } }
      },
      {
        match: (u) => u.includes("/api/song/lyric"),
        body: { lrc: { lyric: "[00:03.00]无时长校验" }, tlyric: { lyric: "" } }
      }
    ]);
    const lines = await fetchLyrics("歌手", "歌名", { durationSec: 200 });
    expect(lines?.[0]?.text).toBe("无时长校验");
  });
});

describe("lyrics 引擎链兜底与 abort 口径（R4-7）", () => {
  it("QQ/网易云全失败（代理 4xx）→ LRCLIB 兜底命中", async () => {
    routeProxy([{ match: () => true, body: "", status: 500 }]);
    fetchJsonMock.mockResolvedValueOnce({ syncedLyrics: "[00:04.00]lrclib 词", plainLyrics: null });
    const lines = await fetchLyrics("歌手", "歌名");
    expect(lines?.[0]?.text).toBe("lrclib 词");
    expect(readLyricsCache("歌手", "歌名")?.source).toBe("lrclib-get");
  });

  it("调用方先 abort → 直接返回 null 且不写负缓存（正常曲目不被误标无词）", async () => {
    routeProxy([{ match: () => true, body: "", status: 500 }]);
    const controller = new AbortController();
    controller.abort();
    const lines = await fetchLyrics("歌手", "某歌", { signal: controller.signal });
    expect(lines).toBeNull();
    expect(readLyricsCache("歌手", "某歌")).toBeNull();

    // 对照：未 abort 的失败链照常写 miss（负缓存语义不变）。
    await fetchLyrics("歌手", "另一歌");
    const entry = readLyricsCache("歌手", "另一歌");
    expect(entry && isLyricsCacheMiss(entry)).toBe(true);
  });
});
