import { expect } from "@wdio/globals";

/**
 * 任务栏功能冒烟回归（审计修复后补的 e2e 零覆盖盲区）：
 *  1. 设置页「任务栏」页：七态卡 / 规则区 / 忽略列表渲染；
 *  2. 「连接」页：任务栏网速条开关存在（含 的「仅主屏」说明）。
 *
 * 边界（刻意不覆盖）：注入 explorer 改外观 / 建贴靠小窗是机器级行为，CI 与
 * WebDriver 环境不宜触发真实注入——注入链路由 Rust 单测（taskbar/injector
 * 的 #[cfg(test)]）与人工验收覆盖；此处只验证 WebDriver 可触达的 UI 控制面。
 * 全部只读断言，不翻转任何开关（避免污染用户环境的任务栏/网速条状态）。
 */

describe("任务栏功能冒烟", () => {
  it("设置页「任务栏」页渲染七态卡与规则 / 忽略区", async () => {
    await browser.switchWindow(/settings/);
    await $(".tm-sidebar-item*=任务栏").click();
    // 状态卡：七态至少渲染「桌面 / 可见窗口」两张（group role 带 aria-label）。
    await browser.waitUntil(async () => (await $$('[role="group"][aria-label="桌面"]')).length > 0, {
      timeout: 5000,
      timeoutMsg: "任务栏页未渲染「桌面」状态卡"
    });
    await expect($('[role="group"][aria-label="可见窗口"]')).toBeDisplayed();
    // 规则区：空态提示或规则列表的容器在。
    await expect($(".tm-tb-sub-title*=窗口规则")).toBeDisplayed();
    // 忽略列表：三组 TagList 至少渲染「窗口类名」一组。
    await expect($("input[aria-label*=类名], input[aria-label*=匹配值]")).toExist();
    // 顺序说明就位（规则从上到下、先命中生效——与状态卡语义相反的澄清）。
    await expect($(".tm-tb-note*=先命中的生效")).toBeDisplayed();
  });

  it("「连接」页提供任务栏网速条开关与「仅主屏」说明（P2-10）", async () => {
    await browser.switchWindow(/settings/);
    await $(".tm-sidebar-item*=连接").click();
    // NetToggleRow 的标题（i18n 键「任务栏网速条」）。
    const row = await $(".tm-setting-row*=任务栏网速条");
    await row.waitForDisplayed({ timeout: 5000, timeoutMsg: "连接页未见任务栏网速条开关" });
    await expect(row).toHaveText(expect.stringContaining("仅主屏"));
    // 开关本体存在（不点击——不污染任务栏状态）。
    await expect(row.$("button[role='switch'], .tm-toggle, input[type='checkbox']")).toExist();
  });
});
