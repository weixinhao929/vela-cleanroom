import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTranslations,
  buildTransTable,
  containsEitherWay,
  decodeEntities,
  fetchLyrics,
  indexForTime,
  isLyricsCacheMiss,
  isUsableTranslation,
  lyricsCacheKey,
  parseLrc,
  readLyricsCache,
  type LyricsCacheEntry
} from "./lyrics";

describe("lyrics.parseLrc（LRC 解析）", () => {
  it("基本时间标签 [mm:ss.xx] → 秒；按时间升序", () => {
    const lines = parseLrc("[00:12.50]第二句\n[00:01.00]第一句\n[01:00.000]第三句");
    expect(lines.map((l) => l.text)).toEqual(["第一句", "第二句", "第三句"]);
    expect(lines[0].time).toBe(1);
    expect(lines[1].time).toBeCloseTo(12.5, 6);
    expect(lines[2].time).toBe(60);
  });

  it("一行多时间戳展开为多行（重复段落）", () => {
    const lines = parseLrc("[00:10.00][00:40.00]副歌");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ time: 10, text: "副歌" });
    expect(lines[1]).toEqual({ time: 40, text: "副歌" });
  });

  it("[offset:±ms] 元数据整体平移（正值提前=时间戳减小），且不产生行；提前量超出时间戳不出现负时间", () => {
    const plus = parseLrc("[offset:+500]\n[00:10.00]a");
    expect(plus).toHaveLength(1);
    expect(plus[0].time).toBeCloseTo(9.5, 6);
    const clamp = parseLrc("[offset:+20000]\n[00:10.00]a");
    expect(clamp[0].time).toBe(0);
  });

  it("分数位数按位解释：.5 与 .50 与 .500 都是 500ms；冒号分隔也接受", () => {
    expect(parseLrc("[00:01.5]x")[0].time).toBeCloseTo(1.5, 6);
    expect(parseLrc("[00:01.50]x")[0].time).toBeCloseTo(1.5, 6);
    expect(parseLrc("[00:01.500]x")[0].time).toBeCloseTo(1.5, 6);
    expect(parseLrc("[00:01:50]x")[0].time).toBeCloseTo(1.5, 6);
  });

  it("空文本行用 ♪ 占位；纯元数据行（ti/ar/al）跳过；空输入返回空数组", () => {
    const lines = parseLrc("[ti:歌名]\n[ar:歌手]\n[00:05.00]\n[00:06.00]词");
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("♪");
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("没有标签的纯文本")).toEqual([]);
  });

  it("同刻多行保持出现顺序（stable）", () => {
    const lines = parseLrc("[00:03.00]A\n[00:03.00]B\n[00:03.00]C");
    expect(lines.map((l) => l.text)).toEqual(["A", "B", "C"]);
  });
});

describe("lyrics.indexForTime（二分定位）", () => {
  const lines = parseLrc("[00:00.00]a\n[00:05.00]b\n[00:10.00]c\n[00:15.00]d");

  it("落在区间内 → 该区间起始行；恰好等于时间戳 → 该行", () => {
    expect(indexForTime(lines, 7)).toBe(1);
    expect(indexForTime(lines, 10)).toBe(2);
    expect(indexForTime(lines, 14.999)).toBe(2);
  });

  it("早于首行 → -1（前奏）；超过末行 → 末行", () => {
    expect(indexForTime(parseLrc("[00:05.00]x"), 2)).toBe(-1);
    expect(indexForTime(lines, 999)).toBe(3);
  });

  it("空集合 → -1", () => {
    expect(indexForTime([], 5)).toBe(-1);
  });
});

describe("lyrics 本地缓存键与读取", () => {
  beforeEach(() => localStorage.clear());

  it("缓存键大小写/多空格归一", () => {
    expect(lyricsCacheKey("  Taylor  Swift ", "Style")).toBe("taylor swift|style");
    expect(lyricsCacheKey("taylor swift", "STYLE")).toBe(lyricsCacheKey("Taylor Swift", "style"));
  });

  it("未命中返回 null；写入后可读（缓存 v2：v1 旧条目随引擎升版作废）", () => {
    expect(readLyricsCache("a", "b")).toBeNull();
    localStorage.setItem(
      "focus-desk.lyrics.cache.v2",
      JSON.stringify({ "a|b": { lines: [{ time: 1, text: "x", translation: "y" }], at: 1, source: "qq" } })
    );
    expect(readLyricsCache("A", "B")?.lines).toEqual([{ time: 1, text: "x", translation: "y" }]);
    // 旧 v1 键不再被读取。
    localStorage.setItem(
      "focus-desk.lyrics.cache.v1",
      JSON.stringify({ "old|old": { lines: [{ time: 1, text: "旧" }], at: 1, source: "get" } })
    );
    expect(readLyricsCache("old", "old")).toBeNull();
  });
});

/* ══ 引擎升级（QQ → 网易云 → LRCLIB + 译文双行）的纯逻辑 ══ */

describe("lyrics.containsEitherWay（歌名/歌手双向包含匹配）", () => {
  it("大小写与多空格不敏感；任一侧包含另一侧即命中", () => {
    expect(containsEitherWay("Style", "style")).toBe(true);
    expect(containsEitherWay("Style (Taylor's Version)", "style")).toBe(true);
    expect(containsEitherWay("style", "Style (Taylor's Version)")).toBe(true);
    expect(containsEitherWay("周  杰伦", "周杰伦")).toBe(true);
  });
  it("完全不相关不命中；缺侧（空串）不参与否决（无歌手场景）", () => {
    expect(containsEitherWay("abc", "xyz")).toBe(false);
    expect(containsEitherWay("", "anything")).toBe(true);
    expect(containsEitherWay("anything", "")).toBe(true);
  });
});

describe("lyrics.decodeEntities（QQ 实体反转义）", () => {
  it("命名实体与数字实体都解；无实体的串原样返回", () => {
    expect(decodeEntities("A&#10;B&#32;C&#45;D&#40;E&#41;")).toBe("A\nB C-D(E)");
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;")).toBe("&<>\"'");
    expect(decodeEntities("plain text")).toBe("plain text");
  });
});

describe("lyrics.isUsableTranslation（译文占位过滤）", () => {
  it("符号占位行与版权声明按无译文处理；中日韩/拉丁内容算有效", () => {
    expect(isUsableTranslation("//")).toBe(false);
    expect(isUsableTranslation("/")).toBe(false);
    expect(isUsableTranslation("…")).toBe(false);
    expect(isUsableTranslation("")).toBe(false);
    expect(isUsableTranslation("本翻译作品的著作权归作者所有")).toBe(false);
    expect(isUsableTranslation("橡胶擦")).toBe(true);
    expect(isUsableTranslation("消しゴム")).toBe(true);
    expect(isUsableTranslation("eraser 2B")).toBe(true);
  });
});

describe("lyrics.buildTransTable + attachTranslations（译文对齐）", () => {
  it("±300ms 容差命中：几十毫秒偏差的译文行贴得上，超容差的丢弃", () => {
    const lines = parseLrc("[00:10.00]原文A\n[00:20.00]原文B\n[00:30.00]原文C");
    const table = buildTransTable("[00:10.05]译文A\n[00:19.80]译文B\n[00:35.00]孤儿译文");
    const out = attachTranslations(lines, table);
    expect(out[0].translation).toBe("译文A");
    expect(out[1].translation).toBe("译文B");
    expect(out[2].translation).toBeUndefined(); // 5s 偏差，无对应原文。
  });
  it("占位与版权行不进表；空表 / 空行集原样返回", () => {
    expect(buildTransTable("[00:01.00]//\n[00:02.00]…\n[00:03.00]翻译作品声明")).toEqual([]);
    const lines = parseLrc("[00:01.00]a");
    expect(attachTranslations(lines, [])).toBe(lines);
    expect(attachTranslations([], [{ time: 1, text: "x" }])).toEqual([]);
  });
  it("游标单调前进：长表 O(n) 对齐不重不漏（回归口径）", () => {
    const src = Array.from({ length: 50 }, (_, i) => `[00:${String(i + 1).padStart(2, "0")}.00]行${i}`).join("\n");
    const trans = Array.from({ length: 50 }, (_, i) => `[00:${String(i + 1).padStart(2, "0")}.10]译${i}`).join("\n");
    const out = attachTranslations(parseLrc(src), buildTransTable(trans));
    out.forEach((l, i) => expect(l.translation).toBe(`译${i}`));
  });
});

/* ══ 负缓存：无词曲目不重放全引擎链 ══ */

/* mock 签名带 rest 参数：fetchJson 转发 ...args 时 spread 才能通过类型检查
   （无参签名的 vi.fn 不接受 unknown[] 展开）。 */
const fetchJsonMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));
vi.mock("./network", () => ({ fetchJson: (...args: unknown[]) => fetchJsonMock(...args) }));
vi.mock("./tauri", () => ({ isTauri: () => false, invoke: vi.fn() }));

describe("lyrics 负缓存（miss 短期记忆）", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchJsonMock.mockReset();
    fetchJsonMock.mockResolvedValue(null);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("全引擎无词 → miss 入缓存；TTL 内重试不再发网络请求", async () => {
    const first = await fetchLyrics("artist", "no-lyrics");
    expect(first).toBeNull();
    expect(fetchJsonMock).toHaveBeenCalledTimes(2); // LRCLIB get + search
    const entry = readLyricsCache("artist", "no-lyrics");
    expect(entry && isLyricsCacheMiss(entry)).toBe(true);

    // TTL 内第二次：直接吃负缓存，零网络。
    const second = await fetchLyrics("artist", "no-lyrics");
    expect(second).toBeNull();
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);

    // TTL 过期（>10min）：重放引擎链。
    vi.advanceTimersByTime(11 * 60_000);
    await fetchLyrics("artist", "no-lyrics");
    expect(fetchJsonMock).toHaveBeenCalledTimes(4);
  });

  it("正缓存命中不经过 miss 分支；miss 条目不会伪装成正缓存", async () => {
    const hit: LyricsCacheEntry = { lines: [{ time: 1, text: "词" }], at: Date.now(), source: "qq" };
    localStorage.setItem("focus-desk.lyrics.cache.v2", JSON.stringify({ "a|hit": hit }));
    const got = await fetchLyrics("a", "hit");
    expect(got?.[0].text).toBe("词");
    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(isLyricsCacheMiss(hit)).toBe(false);
  });
});
