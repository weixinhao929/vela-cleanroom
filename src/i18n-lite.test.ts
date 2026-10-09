import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore } from "./store/settings-store";
import { t, appLocale } from "./i18n-lite";

/** 「跟随系统」档：存储值在读取点按 OS locale 解析成两档实际语言。 */
describe("i18n-lite · 跟随系统档", () => {
  const setLang = (lang: string) => useSettingsStore.setState((s) => ({ general: { ...s.general, language: lang } }));

  beforeEach(() => {
    setLang("简体中文");
  });

  it("跟随系统：OS locale 为英文时按 English 处理（locale 解析立即生效）", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    setLang("跟随系统");
    // 英文词典 chunk 按需加载、迟到回退中文键——断言只锚定 locale 解析。
    expect(appLocale()).toBe("en-US");
    setLang("简体中文");
    expect(appLocale()).toBe("zh-CN");
    vi.unstubAllGlobals();
  });

  it("跟随系统：zh* locale 按简体中文处理", () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    setLang("跟随系统");
    expect(appLocale()).toBe("zh-CN");
    vi.unstubAllGlobals();
  });

  it("显式 English 档不受 OS locale 影响；未知串清洗后同简体中文", () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    setLang("English");
    expect(appLocale()).toBe("en-US");
    // 白名单外的串走 sanitize 会回默认，但直接读取点也应按中文兜底。
    setLang("Français");
    expect(appLocale()).toBe("zh-CN");
    expect(t("语言")).toBe("语言");
    vi.unstubAllGlobals();
  });
});
