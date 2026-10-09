/**
 * [TB-MONITOR] 显示器覆盖（settings-store monitorOverrides 段）：
 * - withTaskbarOverride：只写 monitorOverrides[slot]（字段整体替换、其余覆盖字段与统一
 *   配置不动、顺带 perMonitor=true）；null 删除；空白槽位 / 超上限新槽位原样返回；
 * - taskbarViewForSlot：浅合并视图（覆盖字段整体替换、未覆盖沿用、monitorOverrides 保留）；
 * - taskbarOverriddenKeys：覆盖内出现的字段；
 * - setTaskbarOverride 动作：sanitize 入 state（坏色回默认）、防抖落盘快照含覆盖表且
 *   normalizeTaskbar 往返一致（与 Rust from_json_value 同构：空白槽位丢弃、上限 16）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TASKBAR_MAX_MONITOR_OVERRIDES,
  defaultTaskbarSettings,
  defaultTaskbarStates,
  normalizeTaskbar,
  taskbarOverriddenKeys,
  taskbarSlotKey,
  taskbarViewForSlot,
  useSettingsStore,
  withTaskbarOverride,
  type TaskbarSettings
} from "./settings-store";

const SETTINGS_KEY = "focus-desk.settings.v1";

function base(): TaskbarSettings {
  const t = defaultTaskbarSettings();
  t.enabled = true;
  t.states.desktop.color = "#0000ffff";
  t.rules.maximizedWindow = [
    { id: "r-note", matchType: "class", pattern: "Notepad", appearance: { ...t.states.desktop, accent: "opaque" } }
  ];
  return t;
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState((s) => ({ general: { ...s.general, taskbar: defaultTaskbarSettings() } }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("taskbarSlotKey", () => {
  it("槽位键 = 稳定槽位十进制字串（与 Rust slot_key 同口径）", () => {
    expect(taskbarSlotKey(0)).toBe("0");
    expect(taskbarSlotKey(3)).toBe("3");
  });
});

describe("withTaskbarOverride", () => {
  it("只写 monitorOverrides[slot]：patch 字段整体写入，统一配置不动，顺带 perMonitor=true", () => {
    const t = base();
    const states = { ...defaultTaskbarStates(), desktop: { ...defaultTaskbarStates().desktop, color: "#ff0000ff" } };
    const next = withTaskbarOverride(t, "1", { states });
    expect(next).not.toBe(t);
    expect(next.perMonitor).toBe(true);
    expect(next.monitorOverrides["1"]).toEqual({ states });
    // 统一配置逐字段未变。
    expect(next.states).toEqual(t.states);
    expect(next.rules).toEqual(t.rules);
    expect(next.ignoredWindows).toEqual(t.ignoredWindows);
    expect(next.enabled).toBe(true);
    // 原对象未被就地修改。
    expect(t.perMonitor).toBe(false);
    expect(t.monitorOverrides).toEqual({});
  });

  it("部分覆盖再写另一字段：已有覆盖字段保留，只替换 patch 内出现的字段", () => {
    const t = base();
    const states = defaultTaskbarStates();
    const step1 = withTaskbarOverride(t, "1", { states });
    const ignored = { classes: ["X"], titles: [], processes: [] };
    const step2 = withTaskbarOverride(step1, "1", { ignoredWindows: ignored });
    expect(step2.monitorOverrides["1"]).toEqual({ states, ignoredWindows: ignored });
    // 整体替换语义：再写 states 用新值整体覆盖。
    const states2 = { ...states, desktop: { ...states.desktop, accent: "blur" as const } };
    const step3 = withTaskbarOverride(step2, "1", { states: states2 });
    expect(step3.monitorOverrides["1"]).toEqual({ states: states2, ignoredWindows: ignored });
    // 其他槽位互不影响。
    const other = withTaskbarOverride(step3, "0", { rules: { visibleWindow: [], maximizedWindow: [] } });
    expect(Object.keys(other.monitorOverrides).sort()).toEqual(["0", "1"]);
    expect(other.monitorOverrides["1"]).toEqual(step3.monitorOverrides["1"]);
  });

  it("null 删除该槽位覆盖（不存在时原样返回）；perMonitor 保持不变", () => {
    const t = withTaskbarOverride(base(), "1", { states: defaultTaskbarStates() });
    const removed = withTaskbarOverride(t, "1", null);
    expect(removed.monitorOverrides).toEqual({});
    expect(removed.perMonitor).toBe(true);
    expect(withTaskbarOverride(removed, "1", null)).toBe(removed);
  });

  it("坏 slot：空白键原样返回；空 patch 也会建立空覆盖占位（不算坏）", () => {
    const t = base();
    expect(withTaskbarOverride(t, "", { states: defaultTaskbarStates() })).toBe(t);
    expect(withTaskbarOverride(t, "   ", { states: defaultTaskbarStates() })).toBe(t);
    // 键裁剪：" 1 " 写到 "1"。
    expect(Object.keys(withTaskbarOverride(t, " 1 ", { enabled: false }).monitorOverrides)).toEqual(["1"]);
    const empty = withTaskbarOverride(t, "2", {});
    expect(empty.monitorOverrides["2"]).toEqual({});
  });

  it("上限：已有 16 个槽位覆盖时新增原样返回，更新既有槽位仍可", () => {
    let t = base();
    for (let i = 0; i < TASKBAR_MAX_MONITOR_OVERRIDES; i++) t = withTaskbarOverride(t, String(i), { enabled: false });
    expect(Object.keys(t.monitorOverrides)).toHaveLength(TASKBAR_MAX_MONITOR_OVERRIDES);
    expect(withTaskbarOverride(t, "99", { enabled: false })).toBe(t);
    const updated = withTaskbarOverride(t, "3", { enabled: true });
    expect(updated.monitorOverrides["3"]).toEqual({ enabled: true });
  });
});

describe("taskbarViewForSlot / taskbarOverriddenKeys", () => {
  it("浅合并视图：覆盖字段整体替换、未覆盖沿用统一、monitorOverrides 原表保留；无覆盖返回原对象", () => {
    const t = base();
    expect(taskbarViewForSlot(t, "1")).toBe(t);
    expect(taskbarOverriddenKeys(t, "1")).toEqual([]);
    const states = { ...defaultTaskbarStates(), desktop: { ...defaultTaskbarStates().desktop, color: "#ff0000ff" } };
    const withOv = withTaskbarOverride(t, "1", { states, enabled: false });
    const view = taskbarViewForSlot(withOv, "1");
    expect(view.states).toBe(states);
    expect(view.enabled).toBe(false);
    expect(view.rules).toEqual(t.rules);
    expect(view.ignoredWindows).toEqual(t.ignoredWindows);
    expect(view.monitorOverrides).toBe(withOv.monitorOverrides);
    expect(view.perMonitor).toBe(true);
    expect(taskbarOverriddenKeys(withOv, "1")).toEqual(["enabled", "states"]);
    // 视图不看 perMonitor：关闭时仍展示覆盖内容（是否生效由页面提示）。
    const off = { ...withOv, perMonitor: false };
    expect(taskbarViewForSlot(off, "1").states).toBe(states);
  });
});

describe("settings-store.setTaskbarOverride", () => {
  it("经 sanitize 入 state（坏色回默认、非法 accent 回默认），只写该槽位；防抖落盘快照可 normalizeTaskbar 往返", () => {
    vi.useFakeTimers();
    const states = defaultTaskbarStates();
    states.desktop = { ...states.desktop, color: "#ABC", accent: "neon" as never };
    useSettingsStore.getState().setTaskbarOverride("1", { states });
    const tb = useSettingsStore.getState().general.taskbar;
    expect(tb.perMonitor).toBe(true);
    expect(tb.monitorOverrides["1"]?.states?.desktop.color).toBe("#aabbccff");
    expect(tb.monitorOverrides["1"]?.states?.desktop.accent).toBe("clear");
    expect(tb.states.desktop.color).toBe("#00000000");
    // 无变化的写入（删除不存在的槽位）不触发 set。
    const before = useSettingsStore.getState().general;
    useSettingsStore.getState().setTaskbarOverride("404", null);
    expect(useSettingsStore.getState().general).toBe(before);

    vi.advanceTimersByTime(400);
    const raw = localStorage.getItem(SETTINGS_KEY);
    expect(raw).not.toBeNull();
    const snapshot = JSON.parse(raw as string) as { general: { taskbar: unknown } };
    const back = normalizeTaskbar(snapshot.general.taskbar);
    expect(back).toEqual(useSettingsStore.getState().general.taskbar);
    expect(back.monitorOverrides["1"]?.states?.desktop.color).toBe("#aabbccff");
  });

  it("normalizeTaskbar 覆盖表边界（与 Rust from_json_value 同构）：空白槽位丢弃、非对象丢弃、上限 16、只收合法顶层字段", () => {
    const overrides: Record<string, unknown> = {
      " ": { enabled: false },
      "": { enabled: false },
      bad: 42,
      "1": {
        enabled: "yes",
        states: 5,
        rules: { visibleWindow: "x" },
        ignoredWindows: { classes: ["A", "", 3] },
        perMonitor: true,
        monitorOverrides: { nested: {} }
      }
    };
    for (let i = 10; i < 40; i++) overrides[String(i)] = { enabled: false };
    const n = normalizeTaskbar({ perMonitor: true, monitorOverrides: overrides });
    expect(Object.keys(n.monitorOverrides)).toHaveLength(TASKBAR_MAX_MONITOR_OVERRIDES);
    expect(n.monitorOverrides[" "]).toBeUndefined();
    expect(n.monitorOverrides[""]).toBeUndefined();
    expect(n.monitorOverrides.bad).toBeUndefined();
    const one = n.monitorOverrides["1"] as Record<string, unknown>;
    expect(one.enabled).toBeUndefined();
    expect(one.states).toBeUndefined();
    expect(one.rules).toEqual({ visibleWindow: [], maximizedWindow: [] });
    expect(one.ignoredWindows).toEqual({ classes: ["A"], titles: [], processes: [] });
    expect(one.perMonitor).toBe(true);
    expect(one.monitorOverrides).toBeUndefined();
  });
});
