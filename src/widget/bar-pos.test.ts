import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 悬浮工具条位置按屏幕分区持久化（docs/issues-2026-09-10-bar-position.md）。
 *
 * 复现场景取自真实机器：主屏 1920×1080（任务栏 48 → 可用 1032），副屏
 * 2560×1440@150% → 逻辑 1707×960（可用 912）。旧版单一全局键 `focus-desk.bar-pos.v1`
 * 在两屏之间互相覆盖：主屏贴任务栏的 y=988 在副屏整体出屏，副屏贴任务栏的
 * y=867 在主屏又悬在半空。
 */

const state = vi.hoisted(() => ({ screen: "0" }));

vi.mock("./widget-store", () => ({
  currentScreenId: () => state.screen
}));

import { LEGACY_BAR_POS_KEY, barPosKey, isWithinViewport, loadBarPos, saveBarPos } from "./bar-pos";

/** 主屏可用视口。 */
const PRIMARY = { width: 1920, height: 1032 };
/** 副屏可用视口（150% 缩放后的逻辑尺寸）。 */
const SECONDARY = { width: 1707, height: 912 };

beforeEach(() => {
  localStorage.clear();
  state.screen = "0";
});

describe("bar-pos · 按屏幕分区存储", () => {
  it("写入后可按 kind 读回，且键带屏幕分区", () => {
    saveBarPos("switcher", { x: 0, y: 988 });
    saveBarPos("toolbar", { x: 648, y: 988 });
    expect(barPosKey()).toBe("focus-desk.screen.0.bar-pos.v1");
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 0, y: 988 });
    expect(loadBarPos("toolbar", PRIMARY)).toEqual({ x: 648, y: 988 });
  });

  it("不同屏幕分区互不影响：主屏贴任务栏、副屏贴任务栏各存各的", () => {
    saveBarPos("switcher", { x: 0, y: 988 });

    state.screen = "1";
    expect(loadBarPos("switcher", SECONDARY)).toBeNull();
    saveBarPos("switcher", { x: 2, y: 867 });
    expect(loadBarPos("switcher", SECONDARY)).toEqual({ x: 2, y: 867 });

    state.screen = "0";
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 0, y: 988 });
  });

  it("清除某个 kind 只删该条目，另一条工具条保留", () => {
    saveBarPos("switcher", { x: 0, y: 988 });
    saveBarPos("toolbar", { x: 648, y: 988 });
    saveBarPos("switcher", null);
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
    expect(loadBarPos("toolbar", PRIMARY)).toEqual({ x: 648, y: 988 });
  });
});

describe("bar-pos · 越界与损坏数据", () => {
  it("落在可用视口之外（如被任务栏挡住 / 整体出屏）的位置视为无效", () => {
    saveBarPos("switcher", { x: 0, y: 988 });
    // 同一坐标：主屏可见，副屏（可用高 912）出屏。
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 0, y: 988 });
    expect(loadBarPos("switcher", SECONDARY)).toBeNull();
    // 右边缘 / 负坐标同样无效。
    saveBarPos("switcher", { x: 1910, y: 100 });
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
    saveBarPos("switcher", { x: -5, y: 100 });
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
  });

  it("isWithinViewport 保留 24px 可抓余量", () => {
    expect(isWithinViewport({ x: 1896, y: 1008 }, PRIMARY)).toBe(true);
    expect(isWithinViewport({ x: 1897, y: 1008 }, PRIMARY)).toBe(false);
    expect(isWithinViewport({ x: 1896, y: 1009 }, PRIMARY)).toBe(false);
  });

  it("损坏的 JSON / 非对象 / 非数字坐标一律当作无记录", () => {
    localStorage.setItem(barPosKey(), "not json");
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
    localStorage.setItem(barPosKey(), "[1,2]");
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
    localStorage.setItem(barPosKey(), JSON.stringify({ switcher: { x: "0", y: 988 } }));
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
    localStorage.setItem(barPosKey(), JSON.stringify({ switcher: { x: 0, y: Number.NaN } }));
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
    // 损坏值不会阻断同表里合法的另一条。
    localStorage.setItem(barPosKey(), JSON.stringify({ switcher: 42, toolbar: { x: 648, y: 988 } }));
    expect(loadBarPos("toolbar", PRIMARY)).toEqual({ x: 648, y: 988 });
  });
});

describe("bar-pos · 旧全局键迁移", () => {
  const legacy = { switcher: { x: 0, y: 988 }, toolbar: { x: 648, y: 988 } };

  it("本屏无记录时采纳仍在视口内的旧值，并一次性迁入本屏键", () => {
    localStorage.setItem(LEGACY_BAR_POS_KEY, JSON.stringify(legacy));
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 0, y: 988 });
    expect(loadBarPos("toolbar", PRIMARY)).toEqual({ x: 648, y: 988 });
    expect(JSON.parse(localStorage.getItem(barPosKey())!)).toEqual(legacy);
    // 旧键原样保留（其它尚未迁移的屏幕还要读）。
    expect(JSON.parse(localStorage.getItem(LEGACY_BAR_POS_KEY)!)).toEqual(legacy);
  });

  it("旧值在本屏出屏时丢弃，本屏落回默认位置，且写入空表阻断后续回落", () => {
    localStorage.setItem(LEGACY_BAR_POS_KEY, JSON.stringify(legacy));
    state.screen = "1";
    expect(loadBarPos("switcher", SECONDARY)).toBeNull();
    expect(loadBarPos("toolbar", SECONDARY)).toBeNull();
    expect(localStorage.getItem(barPosKey())).toBe("{}");
  });

  it("迁移后旧键的改动对本屏不再生效；复位也不会被旧值复活", () => {
    localStorage.setItem(LEGACY_BAR_POS_KEY, JSON.stringify(legacy));
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 0, y: 988 });

    localStorage.setItem(LEGACY_BAR_POS_KEY, JSON.stringify({ switcher: { x: 300, y: 300 } }));
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 0, y: 988 });

    saveBarPos("switcher", null);
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
  });

  it("视口尺寸异常（尚未布局的 0×0）时只读回落、不落盘迁移，避免误删旧记录", () => {
    localStorage.setItem(LEGACY_BAR_POS_KEY, JSON.stringify(legacy));
    expect(loadBarPos("switcher", { width: 0, height: 0 })).toBeNull();
    expect(localStorage.getItem(barPosKey())).toBeNull();
    // 视口就位后正常迁移。
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 0, y: 988 });
    expect(localStorage.getItem(barPosKey())).not.toBeNull();
  });

  it("没有旧键时首次读取写入空表，之后行为与普通空记录一致", () => {
    expect(loadBarPos("switcher", PRIMARY)).toBeNull();
    expect(localStorage.getItem(barPosKey())).toBe("{}");
    saveBarPos("switcher", { x: 11, y: 865 });
    expect(loadBarPos("switcher", PRIMARY)).toEqual({ x: 11, y: 865 });
  });
});
