import { expect } from "@wdio/globals";

/**
 * 核心链路回归：
 *  1. 应用正常启动，主 widget 层（title "Vela Widgets"，label `widget-{slot}`）
 *     渲染出小组件画布。
 *  2. 跨窗口同步：设置窗口（"settings"）修改主题后，主窗口的 data-theme 随之更新。
 *
 * 说明：穿透命中（click-through）是原生层（widget.rs 低层鼠标钩子 + 命中矩形）
 * 行为，WebDriver 无法代理系统级命中测试，故这里只覆盖 WebDriver 可触达的
 * 跨窗口同步与 UI 状态。
 */

/** 主窗口当前 data-theme（theme-engine：亮色 "light"，暗色 "glass"）。 */
async function widgetsTheme(): Promise<string | null> {
  await browser.switchWindow("Vela Widgets");
  return browser.execute(() => document.documentElement.getAttribute("data-theme"));
}

/** 在设置窗「样式」页点击主题 Segmented 的某一段（"深色" / "浅色"）。 */
async function pickThemeMode(label: "深色" | "浅色"): Promise<void> {
  await browser.switchWindow(/settings/);
  await $(".tm-sidebar-item*=样式").click();
  await $(`.tm-segmented-item*=${label}`).click();
}

async function waitForWidgetsTheme(expected: "light" | "glass", what: string): Promise<void> {
  await browser.waitUntil(async () => (await widgetsTheme()) === expected, {
    timeout: 5000,
    timeoutMsg: `主窗口未同步到${what}（data-theme=${expected}）`
  });
}

describe("Focus Desk 核心链路", () => {
  it("应用启动并渲染主 widget 层", async () => {
    await browser.switchWindow("Vela Widgets");
    // 桌面层根容器：只要加载完成且未崩溃即有该节点（WidgetCanvas 的 className，无 id）。
    const canvas = await $(".widget-canvas");
    await expect(canvas).toBeDisplayed();
  });

  it("设置窗口存在且可切换到它", async () => {
    // 设置窗口由 tauri-driver 启动时一并创建（visible:false，启动流程随即显示）。
    await browser.switchWindow(/settings/);
    await expect($(".tm-settings-window")).toBeDisplayed();
  });

  it("跨窗口同步：设置窗口切主题 → 主窗口 data-theme 跟随（深→浅双向切换）", async () => {
    // 主题会持久化（localStorage + SQLite）。单向「切到浅色再断言变了」在第二次
    // 运行时（已经是浅色）不产生任何变化，必然假失败；这里先深后浅、断言精确值，
    // 不依赖初始状态，结束后恢复原值。
    const before = await widgetsTheme();
    await pickThemeMode("深色");
    await waitForWidgetsTheme("glass", "深色");
    await pickThemeMode("浅色");
    await waitForWidgetsTheme("light", "浅色");
    if (before === "glass") {
      await pickThemeMode("深色");
      await waitForWidgetsTheme("glass", "深色（恢复）");
    }
  });
});

// 本轮（第二轮路线图）新增功能冒烟回归。E-2 修复「空转通过」：组件不在
// 画布上时用例此前直接通过（isExisting 容错），等于没测。现在先走真实
// 用户路径主动添加（画布空白右键 → 添加小组件 → 图库双击卡片），再对
// 内容做无条件断言；已存在（上次运行遗留，布局持久化）则跳过添加直接
// 断言。不依赖外部数据（天气/课表内容），可离线稳定运行。
describe("第二轮新增功能冒烟", () => {
  /** 确保画布上存在指定类型的小组件（无则经图库添加），返回是否新添加。 */
  async function ensureWidget(type: string, galleryName: string): Promise<boolean> {
    await browser.switchWindow("Vela Widgets");
    const existing = await $(`.widget-card[data-widget-type="${type}"]`);
    if (await existing.isExisting()) return false;
    // 画布空白处右键（避开中心可能压着的卡片，取左上角内侧）：CDP 派发的
    // 合成事件不经过 OS 级穿透命中（WS_EX_TRANSPARENT 只拦真实输入）。
    const canvas = await $(".widget-canvas");
    await canvas.click({ button: "right", x: 8, y: 8 });
    const addItem = await $(".ctx-item*=添加小组件");
    await addItem.waitForDisplayed({ timeout: 5000 });
    await addItem.click();
    // 图库打开后搜索定位目标卡片，双击落组件（单击仅选中）。
    const search = await $(".widget-gallery-search input");
    await search.waitForDisplayed({ timeout: 5000 });
    await search.setValue(galleryName);
    const card = await $(`.widget-gallery-card*=${galleryName}`);
    await card.waitForDisplayed({ timeout: 5000 });
    await card.doubleClick();
    // 图库关闭 + 新卡片挂载（跨窗落盘 + 卡片入场）。
    await browser.waitUntil(async () => !(await $(".widget-gallery-overlay").isDisplayed()), {
      timeout: 8000,
      timeoutMsg: "添加后图库未关闭"
    });
    await $(`.widget-card[data-widget-type="${type}"]`).waitForDisplayed({
      timeout: 8000,
      timeoutMsg: `小组件实例 ${type} 未挂载`
    });
    return true;
  }

  /** 断言后收尾：退出编辑模式（添加路径会进入；Escape 是编辑模式兜底退出键）。 */
  async function exitEditModeIfAny(): Promise<void> {
    await browser.keys(["Escape"]);
  }

  it("回收站小组件：添加后渲染空态", async () => {
    await ensureWidget("recycle", "回收站");
    await expect($(".recycle-empty")).toBeDisplayed();
    await exitEditModeIfAny();
  });

  it("今日概览小组件：添加后渲染日期标题与今日待办区块", async () => {
    await ensureWidget("todayoverview", "今日概览");
    await expect($(".today-overview")).toBeDisplayed();
    await expect($(".today-overview-date")).toBeDisplayed();
    await exitEditModeIfAny();
  });

  it("课表小组件：添加后工具条提供 Excel 导出入口", async () => {
    await ensureWidget("timetable", "课程表");
    // 课表工具条上有多个 .tt-mini-btn（重命名/新建/删除方案在前），裸类名取到的是
    // 「重命名方案」；按 title 精确定位导出按钮（title "导出为 Excel (.xlsx)"）。
    const exportBtn = await $('.tt-mini-btn[title*="xlsx"]');
    await exportBtn.waitForDisplayed({ timeout: 5000 });
    await expect(exportBtn).toHaveAttribute("title", expect.stringContaining("xlsx"));
    await exitEditModeIfAny();
  });

  it("更新页提供「下载并安装」入口（E1 应用内更新）", async () => {
    await browser.switchWindow(/settings/);
    await $(".tm-sidebar-item*=更新").click();
    // 依赖外部更新源与版本比较：仅在检测到新版本时按钮出现。此用例的
    // 容错是「环境态」而非「空转」——无源/无新版时明确记录跳过原因。
    const dlBtn = await $(".tm-update-dl");
    if (await dlBtn.isExisting()) {
      await expect(dlBtn).toHaveText(expect.stringContaining("下载并安装"));
    } else {
      console.warn("[e2e] 更新页未检测到新版本（未配源/已是最新），「下载并安装」断言跳过");
    }
  });
});
