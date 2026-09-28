import { beforeEach, describe, expect, it } from "vitest";
import {
  SEARCH_ENGINES,
  isPathLikeQuery,
  appAvatarColors,
  appInitial,
  bumpLaunchStat,
  cycleSearchEngine,
  loadLaunchStats,
  loadPinnedApps,
  loadSpotlightSettings,
  saveSpotlightSettings,
  searchApps,
  webSearchUrl,
  type AppInfo,
  type LaunchStats,
  type SearchEngineId
} from "./spotlight";

const app = (name: string, path = `C:/${name}.exe`, alias?: string): AppInfo => ({ name, path, alias });

describe("isPathLikeQuery —— G11 文件意图判定", () => {
  it("路径分隔符 / 盘符前缀触发；普通词与空查询不触发", () => {
    expect(isPathLikeQuery("report\\final")).toBe(true);
    expect(isPathLikeQuery("D:/work")).toBe(true);
    expect(isPathLikeQuery("C:")).toBe(true);
    expect(isPathLikeQuery("photos/")).toBe(true);
    expect(isPathLikeQuery("chrome")).toBe(false);
    expect(isPathLikeQuery("微信")).toBe(false);
    expect(isPathLikeQuery("   ")).toBe(false);
    expect(isPathLikeQuery("")).toBe(false);
  });
});

describe("searchApps —— 频率主序 + match-tier 次级", () => {
  const empty: LaunchStats = {};

  it("空查询返回全部（是否调用由调用方决定）", () => {
    const apps = [app("Chrome"), app("微信"), app("Steam")];
    expect(searchApps(apps, "", empty, [])).toHaveLength(3);
    expect(searchApps(apps, "   ", empty, [])).toHaveLength(3);
  });

  it("只保留命中的应用（拼音首字母走 keywords 字段）", () => {
    const apps = [app("网易云音乐"), app("微信"), app("Steam")];
    const out = searchApps(apps, "wyy", empty, []);
    expect(out.map((a) => a.name)).toEqual(["网易云音乐"]);
    expect(searchApps(apps, "zzz", empty, [])).toEqual([]);
  });

  it("置顶 > 启动次数 > 最近使用（主序保留 W-086 语义）", () => {
    const chrome = app("Chrome");
    const steam = app("Steam");
    const wechat = app("微信");
    const stats: LaunchStats = {
      [steam.path]: { count: 3, last: 100 },
      [chrome.path]: { count: 3, last: 900 }
    };
    // 微信无统计但置顶居首；Chrome 与 Steam 次数同为 3，last 更近者在前。
    const out = searchApps([chrome, steam, wechat], "", stats, [wechat.path]);
    expect(out.map((a) => a.name)).toEqual(["微信", "Chrome", "Steam"]);
  });

  it("频率相同时 tier 作次级键：prefix 命中排在 substring 命中前", () => {
    const chrome = app("Chrome"); // "chr" 前缀
    const ochre = app("Ochre"); // "chr" 词中子串
    const out = searchApps([ochre, chrome], "chr", empty, []);
    expect(out.map((a) => a.name)).toEqual(["Chrome", "Ochre"]);
  });

  it("tier 也拉不过频率：高频 subsequence 仍排在低频 prefix 前", () => {
    const chrome = app("Chrome"); // "ce" 子序列命中
    const central = app("Central"); // "ce" 前缀命中（更高档）
    const stats: LaunchStats = { [chrome.path]: { count: 10, last: 1 } };
    const out = searchApps([chrome, central], "ce", stats, []);
    expect(out[0].name).toBe("Chrome"); // 次数 10 压过 Central 的 prefix 档
  });

  it("同级按名称字典序稳定化", () => {
    const out = searchApps([app("Amazon"), app("Alpha")], "a", empty, []);
    expect(out.map((x) => x.name)).toEqual(["Alpha", "Amazon"]);
  });

  it("frequency=false 保持传入顺序（小组件「按名称关闭」语义）", () => {
    const apps = [app("Zulu"), app("Alpha")];
    const stats: LaunchStats = { [apps[1].path]: { count: 5, last: 1 } };
    const out = searchApps(apps, "", stats, [], { frequency: false });
    expect(out.map((x) => x.name)).toEqual(["Zulu", "Alpha"]);
  });

  it("limit 截断", () => {
    const apps = [app("Alpha"), app("Amazon"), app("Apple")];
    expect(searchApps(apps, "a", empty, [], { limit: 2 })).toHaveLength(2);
  });

  it("别名与别名首字母参与匹配（W-088 语义不回退）", () => {
    const wechat = app("微信", "C:/wx.exe", "WeChat");
    expect(searchApps([wechat], "chat", empty, [])).toHaveLength(1); // 别名子串
    expect(searchApps([wechat], "wc", empty, [])).toHaveLength(1); // 别名首字母
    // 超出名称首字母长度的查询：仅别名首字母可命中（旧 matchesQuery 语义）。
    expect(searchApps([app("微信", "C:/wx.exe")], "wxb", empty, [])).toEqual([]);
    expect(searchApps([app("微信", "C:/wx.exe", "微信备份")], "wxb", empty, [])).toHaveLength(1); // 微信备份 → wxbf 的前缀
  });
});

describe("搜索引擎目录", () => {
  it("URL 模板与查询词编码", () => {
    expect(webSearchUrl("bing", "hello world")).toBe("https://www.bing.com/search?q=hello%20world");
    expect(webSearchUrl("baidu", "测试")).toBe(`https://www.baidu.com/s?wd=${encodeURIComponent("测试")}`);
    expect(webSearchUrl("duckduckgo", "a&b=c")).toBe(`https://duckduckgo.com/?q=${encodeURIComponent("a&b=c")}`);
  });

  it("cycle 顺序覆盖全部引擎并回到起点", () => {
    const order = ["bing", "google", "baidu", "duckduckgo"];
    expect(SEARCH_ENGINES.map((e) => e.id)).toEqual(order);
    let cur: SearchEngineId = "bing";
    const seen: SearchEngineId[] = [cur];
    for (let i = 0; i < order.length; i++) {
      cur = cycleSearchEngine(cur);
      seen.push(cur);
    }
    expect(seen).toEqual([...order, "bing"]);
  });

  it("未知引擎 id 回退默认（必应）", () => {
    expect(webSearchUrl("nope" as "bing", "q")).toBe("https://www.bing.com/search?q=q");
  });
});

describe("spotlight 本地配置（focus-desk.spotlight.v1）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("无配置时默认必应", () => {
    expect(loadSpotlightSettings()).toEqual({ engine: "bing" });
  });

  it("保存后可读回", () => {
    saveSpotlightSettings({ engine: "duckduckgo" });
    expect(loadSpotlightSettings()).toEqual({ engine: "duckduckgo" });
  });

  it("损坏 JSON 或非法引擎值回退默认", () => {
    localStorage.setItem("focus-desk.spotlight.v1", "{not json");
    expect(loadSpotlightSettings()).toEqual({ engine: "bing" });
    localStorage.setItem("focus-desk.spotlight.v1", JSON.stringify({ engine: "altaVista" }));
    expect(loadSpotlightSettings()).toEqual({ engine: "bing" });
  });
});

describe("启动统计与置顶存储", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("bump 递增次数并刷新时间戳", () => {
    const before = Date.now();
    const s1 = bumpLaunchStat("C:/a.exe");
    expect(s1["C:/a.exe"]).toEqual({ count: 1, last: expect.any(Number) });
    expect(s1["C:/a.exe"].last).toBeGreaterThanOrEqual(before);
    const s2 = bumpLaunchStat("C:/a.exe");
    expect(s2["C:/a.exe"].count).toBe(2);
    expect(loadLaunchStats()["C:/a.exe"].count).toBe(2);
  });

  it("损坏的置顶数据回退空数组", () => {
    localStorage.setItem("focus-desk.launch-pinned.v1", "{oops");
    expect(loadPinnedApps()).toEqual([]);
  });
});

describe("字母磁贴头像", () => {
  it("同名恒定、异名可能不同，格式合法", () => {
    expect(appAvatarColors("Chrome")).toEqual(appAvatarColors("Chrome"));
    const [c1, c2] = appAvatarColors("微信");
    expect(c1).toMatch(/^#[0-9a-f]{6}$/i);
    expect(c2).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("首字符大写化，空名兜底", () => {
    expect(appInitial("chrome")).toBe("C");
    expect(appInitial("网易云音乐")).toBe("网");
    expect(appInitial("")).toBe("?");
  });
});
