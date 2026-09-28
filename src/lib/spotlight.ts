/**
 * Spotlight 共享内核（SPOT）：应用索引、使用统计、启动路径、文件搜索、
 * 网页搜索兜底。
 *
 * 命令面板（CommandPalette）使用的应用索引与启动辅助（应用启动器小组件
 * 已下线）套数据与排序；评分复用 match-tier 五级分档。G11 文件搜索模式
 * 已并入：path-like 查询触发，命中经 launch 统计获得频率主序。
 *
 * 搜索引擎等配置暂存 localStorage（focus-desk.spotlight.v1），待 SYS 会话的
 * 可配置设置体系收工后迁移进 settings-store。
 */

import { invoke, isTauri } from "./tauri";
import { pinyinInitials } from "./pinyin";
import { scoreMatch, type MatchFields } from "./match-tier";

/** W-088 自定义应用可带启动参数与搜索别名（Rust list_apps 只回填 name/path）。 */
export type AppInfo = { name: string; path: string; args?: string; alias?: string };

/* ---- W-086 启动频率与置顶（全局 localStorage，随账号漫游而非实例） ---- */

export const STATS_KEY = "focus-desk.launch-stats.v1";
export const PINNED_KEY = "focus-desk.launch-pinned.v1";

export type LaunchStats = Record<string, { count: number; last: number }>;

export function loadLaunchStats(): LaunchStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as LaunchStats) : {};
  } catch {
    return {};
  }
}

function saveLaunchStats(stats: LaunchStats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    /* ignore */
  }
}

/** 累计一次启动（count+1、last=now）并落盘，返回新快照。 */
export function bumpLaunchStat(path: string): LaunchStats {
  const stats = loadLaunchStats();
  const cur = stats[path] ?? { count: 0, last: 0 };
  stats[path] = { count: cur.count + 1, last: Date.now() };
  saveLaunchStats(stats);
  return stats;
}

export function loadPinnedApps(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/* ---- 应用索引（模块级缓存，经典开始菜单先行、UWP 后台合并） ---- */

const APP_INDEX_TTL = 180_000;
let appIndexCache: { apps: AppInfo[]; at: number } | null = null;

function mergeDedupe(prev: AppInfo[], add: AppInfo[]): AppInfo[] {
  const seen = new Set(prev.map((a) => a.name.toLowerCase()));
  return [...prev, ...add.filter((a) => !seen.has(a.name.toLowerCase()))];
}

function cacheApps(apps: AppInfo[]): AppInfo[] {
  appIndexCache = { apps, at: Date.now() };
  return apps;
}

/**
 * 加载已安装应用索引（经典开始菜单 .lnk + UWP 商店应用），两阶段回调：
 * 经典列表先行（文件系统遍历，几十 ms 内），UWP 合并（PowerShell 扫描
 * 1-2s）到达后第二次回调。模块级缓存 3 分钟内直接复用，`force = true`
 * 强制重扫（重扫按钮 / 新装软件后）。浏览器开发模式回调空列表。
 *
 * @param onUpdate - 每个阶段完成时以当前全量列表回调（至多两次）。
 * @param force - 跳过缓存强制重扫。
 */
export function loadAppIndex(onUpdate: (apps: AppInfo[]) => void, force = false): void {
  if (!isTauri()) {
    onUpdate([]);
    return;
  }
  if (!force && appIndexCache && Date.now() - appIndexCache.at < APP_INDEX_TTL) {
    onUpdate(appIndexCache.apps);
    return;
  }
  void invoke<AppInfo[]>("list_apps")
    .then((list) => {
      const classic = Array.isArray(list) ? list : [];
      onUpdate(cacheApps(classic));
      return invoke<AppInfo[]>("list_uwp_apps")
        .then((uwp) => {
          if (!Array.isArray(uwp) || uwp.length === 0) return;
          onUpdate(cacheApps(mergeDedupe(classic, uwp)));
        })
        .catch(() => {
          /* UWP 不可用只影响商店应用，经典列表已回调 */
        });
    })
    .catch(() => {
      /* 扫描失败保持静默：调用方维持上一次列表 */
    });
}

/* ---- 启动路径（exe/带参数走 launch_app，其余经 open_path 默认处理器） ---- */

/** 只启动不计数（小组件用 FLIP 包裹 bumpLaunchStat 后自行调用）。 */
export function openApp(app: AppInfo): void {
  if (!isTauri()) return;
  if (app.args || app.path.endsWith(".exe")) {
    void invoke("launch_app", { path: app.path, args: app.args ?? null }).catch(() => {});
  } else {
    void invoke("open_path", { path: app.path }).catch(() => {});
  }
}

/** 启动并累计使用统计（命令面板路径）。 */
export function launchApp(app: AppInfo): void {
  bumpLaunchStat(app.path);
  openApp(app);
}

/* ---- G11 文件搜索模式（path-like 查询触发，Rust 预算式扫描） ---- */

export type FileHit = { name: string; path: string; isDir: boolean; modified?: string | null };

/**
 * 文件意图判定：包含路径分隔符或盘符前缀（`report\`、`D:/work`、`C:`）。
 * 普通词不触发——避免每个 2 字查询都扫盘；文件需求天然带路径痕迹。
 */
export function isPathLikeQuery(q: string): boolean {
  const t = q.trim();
  if (!t) return false;
  return t.includes("/") || t.includes("\\") || /^[a-zA-Z]:/.test(t);
}

/** 异步搜索用户常用目录（桌面/文档/下载/图片/音乐/视频），失败静默回空。 */
export async function searchFiles(query: string, limit = 8): Promise<FileHit[]> {
  if (!isTauri() || query.trim().length < 2) return [];
  try {
    const list = await invoke<FileHit[]>("search_files", { query: query.trim(), limit });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 打开文件命中并累计使用统计（与 launchApp 同一频率口径，key = 完整路径）。 */
export function launchFileHit(hit: FileHit): void {
  bumpLaunchStat(hit.path);
  if (isTauri()) void invoke("open_path", { path: hit.path }).catch(() => {});
}

/* ---- 搜索：频率主序 + match-tier 次级（纯函数，可单测） ---- */

/** 单应用评分：名称 / 别名 / 名称首字母 / 别名首字母四路字段取最大。 */
export function scoreApp(app: AppInfo, query: string): number {
  const fields: MatchFields = {
    name: app.name,
    generic: app.alias,
    keywords: pinyinInitials(app.name) || undefined,
    id: app.alias ? pinyinInitials(app.alias) : undefined
  };
  return scoreMatch(fields, query);
}

export type SearchAppsOptions = {
  /** 截断条数（不传 = 不截断）。 */
  limit?: number;
  /** false 时跳过频率排序、保持传入顺序（小组件「按名称」配置的语义）。默认 true。 */
  frequency?: boolean;
};

/**
 * 过滤并排序应用：置顶 > launchCount > lastUsedAt 为主序（W-086 频率排序是
 * Vela 的既有优势，保留），match-tier 得分为次级键（prefix 命中排在
 * subsequence 命中前），同级再按名称字典序稳定化。空查询 = 全部命中
 * （是否在空查询时调用由调用方决定）。
 */
export function searchApps(
  apps: AppInfo[],
  query: string,
  stats: LaunchStats,
  pinned: string[],
  opts: SearchAppsOptions = {}
): AppInfo[] {
  const q = query.trim();
  const scored = apps.map((a) => ({ a, s: q ? scoreApp(a, q) : 0 }));
  const matched = q ? scored.filter((x) => x.s > 0) : scored;
  const sorted =
    opts.frequency === false
      ? matched
      : [...matched].sort((x, y) => {
          const rx: [number, number, number, number] = [
            pinned.includes(x.a.path) ? 0 : 1,
            -(stats[x.a.path]?.count ?? 0),
            -(stats[x.a.path]?.last ?? 0),
            -x.s
          ];
          const ry: [number, number, number, number] = [
            pinned.includes(y.a.path) ? 0 : 1,
            -(stats[y.a.path]?.count ?? 0),
            -(stats[y.a.path]?.last ?? 0),
            -y.s
          ];
          for (let i = 0; i < 4; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
          return x.a.name.toLowerCase().localeCompare(y.a.name.toLowerCase());
        });
  const out = sorted.map((x) => x.a);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

/* ---- 应用头像（无真实图标时的字母磁贴配色，小组件与面板同款） ---- */

const AVATAR_PALETTES: readonly [string, string][] = [
  ["#5c8df6", "#3f6fe0"],
  ["#4fc3f7", "#2f9ed8"],
  ["#7c8cf8", "#5a6ae0"],
  ["#38bdf8", "#0ea5e9"],
  ["#6aa8f0", "#4a86d8"],
  ["#5a9ef0", "#3a7ad0"],
  ["#67c3f0", "#3fa3d8"],
  ["#8b9cf8", "#6b7ce0"]
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

/** 字母磁贴的渐变配色（同名恒定）。 */
export function appAvatarColors(name: string): readonly [string, string] {
  return AVATAR_PALETTES[hashName(name) % AVATAR_PALETTES.length];
}

/** 字母磁贴的首字符（大写化；空名兜底 "?"）。 */
export function appInitial(name: string): string {
  const t = name.trim();
  return t.charAt(0).toUpperCase() || "?";
}

/* ---- 网页搜索兜底（Bing/Google/百度/DuckDuckGo 精简目录） ---- */

export type SearchEngineId = "bing" | "google" | "baidu" | "duckduckgo";

export type SearchEngine = {
  id: SearchEngineId;
  /** 中文显示名（英文模式经 i18n 字典翻译）。 */
  label: string;
  makeUrl: (query: string) => string;
};

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: "bing", label: "必应", makeUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { id: "google", label: "Google", makeUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { id: "baidu", label: "百度", makeUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
  { id: "duckduckgo", label: "DuckDuckGo", makeUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` }
];

const DEFAULT_ENGINE: SearchEngineId = "bing";

/** 面板本地配置（暂存 localStorage，SYS 设置体系收工后迁移 settings-store）。 */
export type SpotlightSettings = { engine: SearchEngineId };

const SPOTLIGHT_KEY = "focus-desk.spotlight.v1";

function isEngineId(v: unknown): v is SearchEngineId {
  return SEARCH_ENGINES.some((e) => e.id === v);
}

export function loadSpotlightSettings(): SpotlightSettings {
  try {
    const raw = localStorage.getItem(SPOTLIGHT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && isEngineId((parsed as SpotlightSettings).engine)) {
        return { engine: (parsed as SpotlightSettings).engine };
      }
    }
  } catch {
    /* 损坏配置回退默认引擎 */
  }
  return { engine: DEFAULT_ENGINE };
}

export function saveSpotlightSettings(s: SpotlightSettings): void {
  try {
    localStorage.setItem(SPOTLIGHT_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** 目录内的下一个引擎（未知 id 从头开始，保证恒有返回）。 */
export function cycleSearchEngine(id: SearchEngineId): SearchEngineId {
  const i = SEARCH_ENGINES.findIndex((e) => e.id === id);
  return SEARCH_ENGINES[(i + 1) % SEARCH_ENGINES.length].id;
}

/** 构造搜索 URL（查询词 encodeURIComponent；未知引擎回退默认）。 */
export function webSearchUrl(id: SearchEngineId, query: string): string {
  const e = SEARCH_ENGINES.find((x) => x.id === id) ?? SEARCH_ENGINES[0];
  return e.makeUrl(query.trim());
}

/** 用默认浏览器打开搜索（Tauri 下经 open_path 的 URL 分支；浏览器模式 window.open）。 */
export function openWebSearch(id: SearchEngineId, query: string): void {
  const url = webSearchUrl(id, query);
  if (isTauri()) {
    void invoke("open_path", { path: url }).catch(() => {});
  } else if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener");
  }
}
