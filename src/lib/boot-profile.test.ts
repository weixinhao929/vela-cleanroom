import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** 每个用例都重新加载模块，清空模块级的 marks 数组。 */
async function fresh() {
  vi.resetModules();
  return await import("./boot-profile");
}

/** 把当前 WebView 伪装成指定 Tauri 窗口（jsdom 默认无 internals = 浏览器/主体窗口）。 */
function fakeWindowLabel(label: string | undefined) {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  };
  if (label === undefined) {
    delete w.__TAURI_INTERNALS__;
  } else {
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
  }
}

describe("boot-profile 冷启动打点", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    fakeWindowLabel(undefined);
  });

  it("按调用顺序记录阶段", async () => {
    const { markBoot, readBootProfile } = await fresh();
    markBoot("script-eval");
    markBoot("react-mount");
    markBoot("first-paint");
    expect(readBootProfile().map((m) => m.phase)).toEqual(["script-eval", "react-mount", "first-paint"]);
  });

  it("重复记录同一阶段只保留第一次（StrictMode 双执行）", async () => {
    const { markBoot, readBootProfile } = await fresh();
    markBoot("hydrate-start");
    const first = readBootProfile()[0].at;
    markBoot("hydrate-start");
    const list = readBootProfile();
    expect(list).toHaveLength(1);
    expect(list[0].at).toBe(first);
  });

  it("时间戳单调不减", async () => {
    const { markBoot, readBootProfile } = await fresh();
    markBoot("script-eval");
    markBoot("react-mount");
    markBoot("hydrate-start");
    const ats = readBootProfile().map((m) => m.at);
    for (let i = 1; i < ats.length; i++) {
      expect(ats[i]).toBeGreaterThanOrEqual(ats[i - 1]);
    }
  });

  it("写入 sessionStorage 以便同窗口跨页面读取", async () => {
    const { markBoot } = await fresh();
    markBoot("script-eval");
    const raw = sessionStorage.getItem("focus-desk.boot-profile.v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)[0].phase).toBe("script-eval");
  });

  it("主窗口（widget-0 / 浏览器）把时间轴发布到共享 localStorage", async () => {
    fakeWindowLabel(undefined); // 浏览器模式：视为主体窗口
    const { markBoot } = await fresh();
    markBoot("script-eval");
    markBoot("first-paint");
    const shared = JSON.parse(localStorage.getItem("focus-desk.boot-profile.shared.v1")!);
    expect(Array.isArray(shared.marks)).toBe(true);
    expect(shared.marks.map((m: { phase: string }) => m.phase)).toEqual(["script-eval", "first-paint"]);
    expect(typeof shared.bootAt).toBe("number");

    // widget-0 同样是主体窗口。
    fakeWindowLabel("widget-0");
    const again = await fresh();
    again.markBoot("script-eval");
    expect(JSON.parse(localStorage.getItem("focus-desk.boot-profile.shared.v1")!).marks.length).toBe(1);
  });

  it("非主窗口（设置窗）不覆盖共享时间轴，读取时优先取主窗口数据", async () => {
    // 主窗口先发布共享时间轴。
    fakeWindowLabel("widget-0");
    const primary = await fresh();
    primary.markBoot("script-eval");
    primary.markBoot("first-paint");
    // 设置窗随后启动：自身打点不发布（防覆盖），读取优先命中共享数据。
    fakeWindowLabel("settings");
    const settings = await fresh();
    settings.markBoot("script-eval");
    settings.markBoot("hydrate-settings");
    expect(localStorage.getItem("focus-desk.boot-profile.shared.v1")).toBeTruthy();
    const shared = JSON.parse(localStorage.getItem("focus-desk.boot-profile.shared.v1")!);
    expect(shared.marks.map((m: { phase: string }) => m.phase)).toEqual(["script-eval", "first-paint"]);
    expect(settings.readBootProfile().map((m) => m.phase)).toEqual(["script-eval", "first-paint"]);
  });

  it("无数据时格式化输出占位文本", async () => {
    const { formatBootProfile, bootTotalMs } = await fresh();
    expect(formatBootProfile()).toBe("（无启动数据）");
    expect(bootTotalMs()).toBeNull();
  });

  it("格式化输出包含各阶段增量与总计", async () => {
    const { formatBootProfile } = await fresh();
    const text = formatBootProfile([
      { phase: "script-eval", at: 100 },
      { phase: "react-mount", at: 150 },
      { phase: "first-paint", at: 400 }
    ]);
    expect(text).toContain("script-eval");
    // 相对上一阶段的增量：150 - 100 = 50。
    expect(text).toContain("(+50.0ms)");
    expect(text).toContain("(+250.0ms)");
    expect(text).toContain("total");
    expect(text).toContain("400.0ms");
  });

  it("bootTotalMs 取 first-paint 时刻", async () => {
    const { markBoot, bootTotalMs } = await fresh();
    markBoot("script-eval");
    markBoot("first-paint");
    expect(bootTotalMs()).not.toBeNull();
    expect(bootTotalMs()).toBeGreaterThanOrEqual(0);
  });
});
