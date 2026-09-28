import { afterEach, describe, expect, it } from "vitest";
import {
  boostPreferred,
  normalizePrefQuery,
  preferredIdFor,
  recordSelection,
  resetPreferenceForTest
} from "./palette-preference";
import { isAbsolutePath, isPureUrl } from "./palette-payload";
import { classifyForeground, titleFromUrl } from "./palette-context";
import { MS_SETTINGS, msSettingMatches, searchMsSettings } from "./ms-settings";

/* ── #6 搜索偏好 ── */

describe("palette-preference", () => {
  afterEach(() => resetPreferenceForTest());

  it("同词上次选中置顶且不改其余相对序", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(boostPreferred(items, "词")).toEqual(items);
    recordSelection("词", "c");
    expect(preferredIdFor("词")).toBe("c");
    expect(boostPreferred(items, "词")).toEqual([{ id: "c" }, { id: "a" }, { id: "b" }]);
    // 查询词归一：大小写 / 首尾空白 / 连续空格等价。
    expect(boostPreferred(items, "  词  ")).toEqual([{ id: "c" }, { id: "a" }, { id: "b" }]);
    expect(boostPreferred(items, "他词")).toEqual(items);
    // 已在首位时原样返回（同引用）。
    const first = [{ id: "c" }, { id: "a" }];
    expect(boostPreferred(first, "词")).toBe(first);
  });

  it("空词不记录；LRU 上限 100", () => {
    recordSelection("", "x");
    expect(preferredIdFor("")).toBeNull();
    for (let i = 0; i < 120; i++) recordSelection(`q${i}`, `id${i}`);
    expect(preferredIdFor("q0")).toBeNull(); // 最旧被挤出
    expect(preferredIdFor("q119")).toBe("id119");
    expect(normalizePrefQuery("  A   B ")).toBe("a b");
  });
});

/* ── #1 粘贴态判定 ── */

describe("palette-payload 判定", () => {
  it("isPureUrl：整段 URL 才算", () => {
    expect(isPureUrl("https://example.com/a?b=1")).toBe(true);
    expect(isPureUrl("http://a.b")).toBe(true);
    expect(isPureUrl("www.example.com")).toBe(true);
    expect(isPureUrl("看这个 https://a.com 很棒")).toBe(false);
    expect(isPureUrl("https://a.com https://b.com")).toBe(false);
    expect(isPureUrl("")).toBe(false);
  });

  it("isAbsolutePath：盘符 / UNC", () => {
    expect(isAbsolutePath("C:\\Users\\me")).toBe(true);
    expect(isAbsolutePath("D:/Docs")).toBe(true);
    expect(isAbsolutePath('"C:\\Program Files"')).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("relative/path")).toBe(false);
    expect(isAbsolutePath("https://a.com")).toBe(false);
  });
});

/* ── #2 窗口上下文 ── */

describe("palette-context", () => {
  it("classifyForeground：Explorer / 浏览器 / 其他", () => {
    expect(classifyForeground("explorer.exe")).toBe("explorer");
    expect(classifyForeground("EXPLORER.EXE")).toBe("explorer");
    expect(classifyForeground("chrome.exe")).toBe("browser");
    expect(classifyForeground("msedge.exe")).toBe("browser");
    expect(classifyForeground("firefox.exe")).toBe("browser");
    expect(classifyForeground("Code.exe")).toBeNull();
    expect(classifyForeground("")).toBeNull();
  });

  it("titleFromUrl：host + 首段路径", () => {
    expect(titleFromUrl("https://example.com")).toBe("example.com");
    expect(titleFromUrl("https://example.com/articles/123?x=1")).toBe("example.com/articles");
    expect(titleFromUrl("not a url")).toBe("not a url");
  });
});

/* ── #3 ms-settings 深链 ── */

describe("ms-settings", () => {
  it("表无重复页 id 且分类合法", () => {
    const pages = new Set(MS_SETTINGS.map((e) => e.page));
    expect(pages.size).toBe(MS_SETTINGS.length);
    expect(pages.size).toBeGreaterThanOrEqual(80);
    for (const e of MS_SETTINGS) expect(MS_SETTINGS_CATEGORIES_SET.has(e.cat)).toBe(true);
  });

  it("中文 / 英文 / 拼音首字母三级匹配", () => {
    expect(searchMsSettings("蓝牙").map((e) => e.page)).toContain("bluetooth");
    expect(searchMsSettings("bluetooth").map((e) => e.page)).toContain("bluetooth");
    // 拼音首字母：蓝牙 = ly；屏幕显示 = pmxs。
    expect(searchMsSettings("ly").map((e) => e.page)).toContain("bluetooth");
    expect(searchMsSettings("pmxs").map((e) => e.page)).toContain("display");
    expect(searchMsSettings("Update").map((e) => e.page)).toContain("windowsupdate");
    expect(searchMsSettings("")).toEqual([]);
    expect(searchMsSettings("绝对不存在的东西")).toEqual([]);
    expect(msSettingMatches(MS_SETTINGS[0], "")).toBe(false);
  });

  it("limit 生效", () => {
    expect(searchMsSettings("e", 3).length).toBeLessThanOrEqual(3);
  });
});

const MS_SETTINGS_CATEGORIES_SET = new Set<string>([
  "系统",
  "蓝牙和其他设备",
  "网络和 Internet",
  "个性化",
  "应用",
  "账户",
  "时间和语言",
  "游戏",
  "辅助功能",
  "隐私和安全性",
  "Windows 更新"
]);
