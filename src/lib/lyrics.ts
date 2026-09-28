/**
 * 歌词（§4.11 起步 → 引擎升级）：LRC 解析 + position 二分定位 + 三引擎取词
 * （QQ 音乐 → 网易云 → LRCLIB）+ 译文双行 + 本地缓存。
 *
 * 范围纪律变更记录：初版只接 LRCLIB（免费无密钥，「不碰网易云等灰色源」）。
 * 2026-09-26 项目所有者显式解除该边界（对标 NotchPeninsula 的多引擎管线，
 * 中文曲库覆盖率差距显著），QQ/网易云改走 system_integration.rs 的
 * fetch_lyric_page 受控代理（域名白名单 c.y.qq.com / y.qq.com /
 * music.163.com，带内网拒绝与限额读取，不构成开放代理）。浏览器开发模式
 * 仍只有 LRCLIB：无 CORS 头的引擎直连 webview 必被拦，属环境限制而非回退
 * 策略。QQ/网易云均为公开无鉴权接口，仅做歌词元数据查询，低频 + 本地缓存。
 *
 * 工程约束（clean-room 部分保留）：
 *  - 单飞锁：同一时刻只跑一条取词链（换歌连点时前一条整链排队作废）；
 *  - 防串台：调用方（MusicImmersive）以 trackKey 为依赖 + AbortController；
 *    代理调用本身不可中断，慢返回的旧歌响应靠调用方事后判废丢弃；
 *  - 译文：QQ 的 trans / 网易云的 tlyric 与原文同时间轴，按 ±300ms 容差
 *    对齐贴到原文行（游标法 O(n)，NPS LookupTrans 同款）；`//`、`…` 这类
 *    占位行与「翻译作品」版权声明按无译文处理；
 *  - 匹配精度：歌名 / 歌手双向包含（大小写不敏感），网易云加时长 ±4s
 *    校验过滤 Live / 伴奏版。
 *
 * SMTC position 与流媒体 App 内部进度存在漂移：调用方应周期（≈10s）用轮询
 * 快照重锚（重拉 get_system_media_info 的 position），二分只在锚点间推进。
 */
import { fetchJson } from "./network";
import { invoke, isTauri } from "./tauri";

/** 一行同步歌词：时间戳（秒）+ 文本（空行用 "♪" 占位由渲染层决定）+
 *  可选译文（与原文同时刻的第二行，引擎升级新增）。 */
export type LrcLine = { time: number; text: string; translation?: string };

const TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG_RE = /^\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * 解析 LRC 文本：支持一行多时间戳、`[offset:+500]` 元数据偏移（毫秒，
 * 正值提前）、无标签行按纯文本跳过（保留 word-free 时间轴）。输出按时间
 * 升序；同刻多行保持出现顺序（stable sort）。
 */
export function parseLrc(text: string): LrcLine[] {
  let offsetMs = 0;
  const lines: LrcLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    /* 先扫掉行首全部时间标签（matchAll 自带 /g 且不动共享 lastIndex），
       剩下的才是文本；同时收集本行的全部时刻。 */
    const times: number[] = [];
    let lastEnd = 0;
    for (const match of line.matchAll(TIME_TAG_RE)) {
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const fracRaw = match[3] ?? "0";
      /* 分数部分按位数解释：.5 = 500ms，.50 = 500ms，.500 = 500ms。 */
      const frac = Number(fracRaw) / Math.pow(10, fracRaw.length);
      if (Number.isFinite(min) && Number.isFinite(sec) && Number.isFinite(frac)) {
        times.push(min * 60 + sec + frac);
      }
      lastEnd = (match.index ?? 0) + match[0].length;
    }
    const body = line.slice(lastEnd).trim();
    if (times.length === 0) {
      /* 元数据行：只认 offset（毫秒，±）。 */
      const m = line.trim().match(OFFSET_TAG_RE);
      if (m) offsetMs += Number(m[1]);
      continue;
    }
    for (const t of times) {
      lines.push({ time: Math.max(0, t + offsetMs / 1000), text: body || "♪" });
    }
  }
  /* stable sort：等时刻行保持出现顺序（多标签一行的语义）。 */
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.time - b.l.time || a.i - b.i)
    .map((x) => x.l);
}

/**
 * 二分定位当前行：返回最后一个 time <= t 的行索引；t 早于首行返回 -1
 * （前奏期）。行集为空返回 -1。
 */
export function indexForTime(lines: LrcLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/* ------------------------------------------------------------------ */
/*  引擎共用纯逻辑（可单测）                                            */
/* ------------------------------------------------------------------ */

/** 双向包含匹配（大小写不敏感、比较态去全部空白）：歌名或歌手任一侧包含
 *  另一侧即算命中——「Title (Live)」/「feat. X」类后缀不会挡掉正确结果，
 *  CJK 场景的杂散空格（「周 杰伦」）也不会误杀。只用于比较，不改写展示。 */
export function containsEitherWay(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true; // 缺侧（无歌手）不参与否决，与 NPS 口径一致。
  return x.includes(y) || y.includes(x);
}

/** QQ 音乐歌词接口的 HTML 实体反转义（`&#10;` 换行、`&#32;` 空格等 + 命名实体）。 */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#(\d+);/g, (_, d: string) => {
      const code = Number(d);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 译文里的占位与版权声明不该被当成歌词显示：`//`、`/`、`…` 这类整行只有
 *  符号的占位，以及 QQ 音乐那句「享有本翻译作品的著作权」，统一按「这句
 *  没有译文」处理（NPS IsUsableTranslation 同款）。 */
export function isUsableTranslation(text: string): boolean {
  if (!text.trim()) return false;
  if (text.includes("翻译作品") || text.includes("本译文")) return false;
  return /[0-9A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

/** 译文时间容差（秒）：两个源与歌词正文偶差几十毫秒，精确相等会白白丢行；
 *  300ms 又不会串到隔壁句（正常行距都是秒级）。 */
const TRANS_MATCH_TOLERANCE_SEC = 0.3;

/** 译文 LRC → 按时间升序的 (秒, 文本) 表（过滤占位行；多时间标签展开）。 */
export function buildTransTable(lrc: string): { time: number; text: string }[] {
  const out: { time: number; text: string }[] = [];
  for (const line of parseLrc(lrc)) {
    if (line.text === "♪") continue;
    if (isUsableTranslation(line.text)) out.push({ time: line.time, text: line.text });
  }
  return out;
}

/**
 * 把译文按时间容差贴到原文行（游标法 O(n)：原文与译文都按时间升序，游标
 * 单调前进）。差超容差的译文行丢弃（没有对应原文，多半是元数据行）。
 */
export function attachTranslations(lines: LrcLine[], table: { time: number; text: string }[]): LrcLine[] {
  if (lines.length === 0 || table.length === 0) return lines;
  let cursor = 0;
  return lines.map((line) => {
    while (cursor < table.length && table[cursor].time < line.time - TRANS_MATCH_TOLERANCE_SEC) cursor++;
    if (cursor >= table.length) return line;
    const hit = Math.abs(table[cursor].time - line.time) <= TRANS_MATCH_TOLERANCE_SEC ? table[cursor].text : undefined;
    return hit ? { ...line, translation: hit } : line;
  });
}

/* ------------------------------------------------------------------ */
/*  本地缓存（第一级）                                                  */
/* ------------------------------------------------------------------ */

export type LyricsCacheEntry = { lines: LrcLine[]; at: number; source: string };

/** v2：v1 条目不含译文，升版一次性作废旧缓存（重取即带译文）。 */
const CACHE_KEY = "focus-desk.lyrics.cache.v2";
const CACHE_MAX = 50;

/** 缓存键：小写化去空白，容忍大小写/多空格差异。 */
export function lyricsCacheKey(artist: string, title: string): string {
  return `${artist.trim().toLowerCase().replace(/\s+/g, " ")}|${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function readCache(): Record<string, LyricsCacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, LyricsCacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeCache(key: string, entry: LyricsCacheEntry): void {
  try {
    const all = readCache();
    all[key] = entry;
    const keys = Object.keys(all);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => all[a].at - all[b].at);
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete all[k];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // best-effort：配额溢出静默（下次重新拉取）
  }
}

/** 读本地缓存（命中返回条目；miss 返回 null）。 */
export function readLyricsCache(artist: string, title: string): LyricsCacheEntry | null {
  return readCache()[lyricsCacheKey(artist, title)] ?? null;
}

/* ------------------------------------------------------------------ */
/*  引擎 1：QQ 音乐（优先；trans 与 lyric 同接口返回，译文一步到位）     */
/* ------------------------------------------------------------------ */

/** 受控代理调用：返回 body 文本；引擎对任何失败一律返回 null 落到下一家。 */
async function proxyFetchText(url: string, opts?: { referer?: string; post?: string }): Promise<string | null> {
  try {
    const r = await invoke<{ status: number; body: string }>("fetch_lyric_page", {
      url,
      referer: opts?.referer ?? null,
      postBody: opts?.post ?? null
    });
    if (typeof r?.body !== "string" || r.status >= 400) return null;
    return r.body;
  } catch {
    return null;
  }
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 深层安全取值：obj.a.b 的每跳都做对象校验，畸形响应不至于抛错。 */
function deepArray(obj: Record<string, unknown> | null, k1: string, k2: string): unknown[] | null {
  if (!obj) return null;
  const mid = obj[k1];
  if (!mid || typeof mid !== "object" || Array.isArray(mid)) return null;
  const list = (mid as Record<string, unknown>)[k2];
  return Array.isArray(list) ? list : null;
}

type EngineResult = { lrc: string; trans: string } | null;

async function fetchFromQq(artist: string, title: string): Promise<EngineResult> {
  const query = encodeURIComponent(`${title} ${artist}`.trim());
  const search = await proxyFetchText(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${query}&n=5&format=json`);
  if (!search) return null;
  const songObj = parseJsonLoose(search)?.["data"];
  const rows =
    songObj && typeof songObj === "object" && !Array.isArray(songObj)
      ? deepArray(songObj as Record<string, unknown>, "song", "list")
      : null;
  if (!rows) return null;

  let songmid = "";
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = typeof r["songname"] === "string" ? r["songname"] : "";
    const singers = Array.isArray(r["singer"]) ? (r["singer"] as Record<string, unknown>[]) : [];
    const singer = typeof singers[0]?.["name"] === "string" ? (singers[0]["name"] as string) : "";
    if (containsEitherWay(name, title) && containsEitherWay(singer, artist)) {
      const mid = typeof r["songmid"] === "string" ? r["songmid"] : "";
      if (mid) {
        songmid = mid;
        break;
      }
    }
  }
  if (!songmid) return null;

  const lyricBody = await proxyFetchText(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&format=json&nobase64=1`,
    { referer: "https://y.qq.com/" }
  );
  if (!lyricBody) return null;
  const ld = parseJsonLoose(lyricBody);
  const lrc = typeof ld?.["lyric"] === "string" ? decodeEntities(ld["lyric"]) : "";
  if (!lrc) return null;
  const trans = typeof ld?.["trans"] === "string" ? decodeEntities(ld["trans"]) : "";
  return { lrc, trans };
}

/* ------------------------------------------------------------------ */
/*  引擎 2：网易云（搜索 POST + 时长 ±4s 校验 + tlyric 译文）            */
/* ------------------------------------------------------------------ */

async function fetchFromNetease(artist: string, title: string, durationSec?: number): Promise<EngineResult> {
  const form = new URLSearchParams({
    s: `${title} ${artist}`.trim(),
    type: "1",
    limit: "5",
    offset: "0"
  }).toString();
  const search = await proxyFetchText("https://music.163.com/api/search/get/web", {
    referer: "https://music.163.com",
    post: form
  });
  if (!search) return null;
  const doc = parseJsonLoose(search);
  const result =
    doc?.["result"] && typeof doc["result"] === "object" ? (doc["result"] as Record<string, unknown>) : null;
  const songs = Array.isArray(result?.["songs"]) ? (result!["songs"] as Record<string, unknown>[]) : null;
  if (!songs) return null;

  let songId = 0;
  for (const song of songs) {
    const name = typeof song["name"] === "string" ? song["name"] : "";
    const artists = Array.isArray(song["artists"]) ? (song["artists"] as Record<string, unknown>[]) : [];
    const singer = typeof artists[0]?.["name"] === "string" ? (artists[0]["name"] as string) : "";
    if (!containsEitherWay(name, title) || !containsEitherWay(singer, artist)) continue;
    // 时长校验（±4s）：同名 Live / 伴奏版与录音室版差几十秒；无时长信息时跳过该项不否决。
    const durationMs = typeof song["duration"] === "number" ? (song["duration"] as number) : 0;
    if (durationSec && durationMs > 0 && Math.abs(durationMs / 1000 - durationSec) > 4) continue;
    const id = typeof song["id"] === "number" ? (song["id"] as number) : 0;
    if (id) {
      songId = id;
      break;
    }
  }
  if (!songId) return null;

  const lyricBody = await proxyFetchText(`https://music.163.com/api/song/lyric?id=${songId}&lv=-1&kv=-1&tv=-1`, {
    referer: "https://music.163.com"
  });
  if (!lyricBody) return null;
  const ld = parseJsonLoose(lyricBody);
  const lrcObj = ld?.["lrc"] && typeof ld["lrc"] === "object" ? (ld["lrc"] as Record<string, unknown>) : null;
  const lrc = typeof lrcObj?.["lyric"] === "string" ? (lrcObj["lyric"] as string) : "";
  if (!lrc) return null;
  const tObj = ld?.["tlyric"] && typeof ld["tlyric"] === "object" ? (ld["tlyric"] as Record<string, unknown>) : null;
  const trans = typeof tObj?.["lyric"] === "string" ? (tObj["lyric"] as string) : "";
  return { lrc, trans };
}

/* ------------------------------------------------------------------ */
/*  引擎 3：LRCLIB（免费无密钥；浏览器开发模式的唯一引擎）               */
/* ------------------------------------------------------------------ */

const LRCLIB = "https://lrclib.net/api";

type LrcLibGet = { syncedLyrics?: string | null; plainLyrics?: string | null };
type LrcLibSearchItem = LrcLibGet & { artistName?: string; trackName?: string; duration?: number };

/* ------------------------------------------------------------------ */
/*  取词编排：缓存 → QQ → 网易云 → LRCLIB（单飞锁串行）                  */
/* ------------------------------------------------------------------ */

/** 单飞锁：同一时刻只跑一条取词链。换歌连点时后一条排队，前一条的慢响应
 *  由调用方的 AbortController 判废，不会把旧歌歌词写给新歌。 */
let fetchChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = fetchChain.then(fn, fn);
  fetchChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function finalize(lrc: string, trans: string): LrcLine[] | null {
  const lines = parseLrc(lrc);
  if (lines.length === 0) return null;
  return trans ? attachTranslations(lines, buildTransTable(trans)) : lines;
}

/**
 * 取同步歌词：本地缓存 → QQ 音乐 → 网易云 → LRCLIB 精确接口 → LRCLIB 搜索
 * 兜底。无同步歌词 / 网络失败返回 null（调用方显示「暂无歌词」），异常不抛出。
 * 译文（QQ trans / 网易云 tlyric）随行携带，渲染层自行决定是否展示。
 */
export async function fetchLyrics(
  artist: string,
  title: string,
  opts?: { album?: string; durationSec?: number; signal?: AbortSignal }
): Promise<LrcLine[] | null> {
  const key = lyricsCacheKey(artist, title);
  const cached = readCache()[key];
  if (cached) return cached.lines;

  return serialized(async () => {
    // 引擎 1/2 需要 Rust 代理（域名白名单 + 无 CORS 头）；浏览器模式只有 LRCLIB。
    if (isTauri()) {
      const qq = await fetchFromQq(artist, title);
      if (qq) {
        const lines = finalize(qq.lrc, qq.trans);
        if (lines) {
          writeCache(key, { lines, at: Date.now(), source: "qq" });
          return lines;
        }
      }
      const ne = await fetchFromNetease(artist, title, opts?.durationSec);
      if (ne) {
        const lines = finalize(ne.lrc, ne.trans);
        if (lines) {
          writeCache(key, { lines, at: Date.now(), source: "netease" });
          return lines;
        }
      }
    }

    const q = (params: Record<string, string | number | undefined>) =>
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");

    const parse = (d: LrcLibGet | null | undefined): LrcLine[] | null => {
      if (!d?.syncedLyrics) return null;
      const lines = parseLrc(d.syncedLyrics);
      return lines.length > 0 ? lines : null;
    };

    try {
      const got = await fetchJson<LrcLibGet | null>(
        `${LRCLIB}/get?${q({ artist_name: artist, track_name: title, album_name: opts?.album, duration: opts?.durationSec })}`,
        { retries: 1, signal: opts?.signal }
      );
      const parsed = parse(got);
      if (parsed) {
        writeCache(key, { lines: parsed, at: Date.now(), source: "lrclib-get" });
        return parsed;
      }
    } catch {
      /* 落到搜索兜底 */
    }
    try {
      const found = await fetchJson<LrcLibSearchItem[]>(
        `${LRCLIB}/search?${q({ track_name: title, artist_name: artist })}`,
        { retries: 1, signal: opts?.signal }
      );
      /* 时长接近度优先（±3s 内的带同步歌词候选），否则取首个。 */
      const withSynced = (found ?? []).filter((c) => !!c.syncedLyrics);
      if (withSynced.length === 0) return null;
      const near = withSynced.find(
        (c) => opts?.durationSec && c.duration && Math.abs(c.duration - opts.durationSec) <= 3
      );
      const parsed = parse(near ?? withSynced[0]);
      if (parsed) writeCache(key, { lines: parsed, at: Date.now(), source: "lrclib-search" });
      return parsed;
    } catch {
      return null;
    }
  });
}
