import { describe, expect, it } from "vitest";
import { widgetAutoName, widgetDisplayName } from "./display-name";

/**
 * 显示名单一口径的锚点测试：重命名标签（instance.label）全局优先，空白回落
 * 自动名（类型名 + 同类型序号）。用未注册类型避开 registry 内容依赖
 * （getWidgetMeta 未命中时 base = type 原串）。
 */

const tr = (s: string) => s;
const inst = (id: string, type: string, label?: string) => ({ id, type, ...(label ? { label } : {}) });

describe("widgetDisplayName（重命名标签同步口径）", () => {
  it("label 优先：同类型多实例的序号自动名被自定义名取代", () => {
    const list = [inst("a", "zzz"), inst("b", "zzz", "我的看板"), inst("c", "zzz")];
    expect(widgetDisplayName("zzz", "b", list, tr)).toBe("我的看板");
    // 未改名的实例保持自动名。
    expect(widgetDisplayName("zzz", "a", list, tr)).toBe("zzz1");
    expect(widgetDisplayName("zzz", "c", list, tr)).toBe("zzz3");
  });

  it("空白 label 视为未设置，回落自动名", () => {
    const list = [inst("a", "zzz", "   "), inst("b", "zzz")];
    expect(widgetDisplayName("zzz", "a", list, tr)).toBe("zzz1");
  });

  it("单实例无 label = 类型名原样", () => {
    expect(widgetDisplayName("zzz", "a", [inst("a", "zzz")], tr)).toBe("zzz");
  });
});

describe("widgetAutoName（S1：忽略 label 的自动名）", () => {
  it("已命名的实例也返回自动名——重命名弹窗 placeholder 靠它示「留空恢复成什么」", () => {
    const list = [inst("a", "zzz"), inst("b", "zzz", "我的看板")];
    // displayName 优先 label；autoName 无视 label（回归：placeholder 此前
    // 与预填值相同，用户看不到默认名）。
    expect(widgetDisplayName("zzz", "b", list, tr)).toBe("我的看板");
    expect(widgetAutoName("zzz", "b", list, tr)).toBe("zzz2");
  });

  it("单实例 = 类型名；序号按同类型计数（与 displayName 的自动名同口径）", () => {
    expect(widgetAutoName("zzz", "a", [inst("a", "zzz", "名")], tr)).toBe("zzz");
  });
});
