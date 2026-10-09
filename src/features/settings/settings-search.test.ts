/**
 * 设置搜索纯函数测试：匹配口径（标题/分组/关键词、大小写不敏感）、
 * 空白查询、limit 截断与索引结构完整性。中文模式下 t() 原样返回键，
 * 故标题匹配与翻译后匹配等价，无需加载英文词典。
 */
import { describe, expect, it } from "vitest";

import { searchSettings, type SettingsSearchEntry } from "./settings-search";

describe("searchSettings", () => {
  it("空查询与纯空白查询返回空数组", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("\t\n")).toEqual([]);
  });

  it("按标题子串命中（中文）", () => {
    const hits = searchSettings("备份");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((e) => e.title === "备份与恢复")).toBe(true);
  });

  it("按关键词命中（中文与英文、大小写不敏感）", () => {
    // 英文关键词小写入库，查询大写也应命中
    expect(searchSettings("AUTOSTART").some((e) => e.title === "开机启动")).toBe(true);
    expect(searchSettings("timeout").some((e) => e.title === "网络超时")).toBe(true);
    // 中文关键词
    expect(searchSettings("录屏").some((e) => e.title === "在屏幕共享/录屏中隐藏桌面层")).toBe(true);
  });

  it("同一关键词的多条命中保持索引顺序", () => {
    const hits = searchSettings("blur");
    const titles = hits.map((e) => e.title);
    expect(titles).toContain("毛玻璃模糊");
    expect(titles).toContain("自定义任务栏外观");
    // 索引顺序：样式块在任务栏块之前
    expect(titles.indexOf("毛玻璃模糊")).toBeLessThan(titles.indexOf("自定义任务栏外观"));
  });

  it("查询串两侧空白被裁剪", () => {
    expect(searchSettings("  壁纸  ")).toEqual(searchSettings("壁纸"));
  });

  it("limit 截断结果条数", () => {
    // 「设置」能命中多条（设置窗口不透明度、导入/导出设置等）
    const all = searchSettings("设置");
    expect(all.length).toBeGreaterThan(1);
    const capped = searchSettings("设置", 1);
    expect(capped.length).toBe(1);
    expect(capped[0]).toEqual(all[0]);
  });

  it("无命中返回空数组", () => {
    expect(searchSettings("绝不存在的查询词xyzzy")).toEqual([]);
  });

  it("P2 索引补全：常规页后加的设置项与整个快捷键分区可检索", () => {
    // 此前「快捷键 / hotkey」零结果——它是常规页最大的功能区。
    expect(searchSettings("快捷键").some((e) => e.title === "快捷键")).toBe(true);
    expect(searchSettings("HOTKEY").some((e) => e.title === "快捷键")).toBe(true);
    // 面板与唤起 / 诊断 / 其它常规开关。
    for (const title of [
      "双击桌面切换显示",
      "减少特效",
      "新手引导",
      "超级面板",
      "长按时长",
      "双击修饰键呼出面板",
      "热键唤醒黑名单",
      "崩溃统计",
      "启动耗时",
      "运行日志"
    ]) {
      expect(searchSettings(title).some((e) => e.title === title)).toBe(true);
    }
  });

  it("extra 动态词条参与匹配且排在静态索引之前（视图名直达视图页）", () => {
    const extra: SettingsSearchEntry[] = [
      { page: "view-home", group: "视图", title: "视图管理", keywords: ["视图", "新建视图", "切换视图"] },
      { page: "view-work", group: "视图", title: "Work", keywords: ["Work", "视图"] }
    ];
    // 按视图名搜索：动态词条命中且置顶（静态索引无 view-<id> 页面可达）
    const byName = searchSettings("work", 12, extra);
    expect(byName[0]).toMatchObject({ page: "view-work", title: "Work" });
    // 管理词命中「视图管理」总词条
    const byAction = searchSettings("新建视图", 12, extra);
    expect(byAction.some((e) => e.page === "view-home")).toBe(true);
    // 不传 extra 时这些页面不可达（回归背景：动态页此前搜不到）
    expect(searchSettings("work").some((e) => e.page === "view-work")).toBe(false);
  });

  it("索引结构完整性：字段非空、keywords 为字符串数组", () => {
    // 结构性守卫：新增词条漏字段/ keywords 混入非字符串时在此暴露。
    const seen = searchSettings("a", 1); // 先确认函数可用
    expect(seen).toBeDefined();
    // 直接驱动全量索引：用宽查询逐条过一遍（空串不走匹配，改用白盒方式）
    const probe = searchSettings("", 999);
    expect(probe).toEqual([]); // 空串短路
    // 全量结构校验通过「单字符高频词」覆盖：中文字与英文字母各扫一轮
    const covered = new Set<SettingsSearchEntry>();
    for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789设置任务栏小组件常规样式动画连接显示器更新视图背景灵动岛隐私") {
      for (const e of searchSettings(ch, 999)) covered.add(e);
    }
    // 至少覆盖大部分词条；逐条校验字段
    expect(covered.size).toBeGreaterThan(30);
    for (const e of covered) {
      expect(e.page.length).toBeGreaterThan(0);
      expect(e.group.length).toBeGreaterThan(0);
      expect(e.title.length).toBeGreaterThan(0);
      for (const k of e.keywords ?? []) expect(typeof k).toBe("string");
    }
  });
});
