import { describe, expect, it } from "vitest";

/** §4.5 快捷键录制/归一/查重纯函数回归。 */
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  SHORTCUT_UNBOUND,
  acceleratorFromEvent,
  findDuplicate,
  hasModifier,
  isShortcutBound,
  keyNameFromCode,
  normalizeAccelerator,
  toRustAccelerator
} from "./shortcuts";

const keydown = (
  code: string,
  key: string,
  mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}
) => ({
  code,
  key,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta
});

describe("shortcuts 工具", () => {
  it("event.code 归并 Key/Digit 前缀，其余按原名", () => {
    expect(keyNameFromCode("KeyD")).toBe("D");
    expect(keyNameFromCode("Digit1")).toBe("1");
    expect(keyNameFromCode("Space")).toBe("Space");
    expect(keyNameFromCode("ArrowUp")).toBe("ArrowUp");
    expect(keyNameFromCode("Numpad0")).toBe("Numpad0");
    expect(keyNameFromCode("F9")).toBe("F9");
  });

  it("从 keydown 构造组合键；纯修饰键返回 null 继续等待", () => {
    expect(acceleratorFromEvent(keydown("KeyD", "d", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+D");
    expect(acceleratorFromEvent(keydown("Space", " ", { ctrl: true }))).toBe("Ctrl+Space");
    expect(acceleratorFromEvent(keydown("F9", "F9", { alt: true }))).toBe("Alt+F9");
    expect(acceleratorFromEvent(keydown("ControlLeft", "Control", { ctrl: true }))).toBeNull();
    expect(acceleratorFromEvent(keydown("Shift", "Shift", { shift: true }))).toBeNull();
    // 无修饰也是合法组合字符串（保存前另有 hasModifier 门槛拦截）。
    expect(acceleratorFromEvent(keydown("KeyA", "a"))).toBe("A");
  });

  it("归一化折叠同义修饰键与写法差异，排序后比较", () => {
    expect(normalizeAccelerator("Ctrl+Alt+D")).toBe(normalizeAccelerator("control+alt+KeyD"));
    expect(normalizeAccelerator("ALT+CTRL+KeyD")).toBe(normalizeAccelerator("Ctrl+Alt+D"));
    expect(normalizeAccelerator("Ctrl+Win+KeyX")).toBe(normalizeAccelerator("Super+Control+X"));
    expect(normalizeAccelerator("")).toBe("");
  });

  it("查重：等价写法算冲突，自身与不同键不算", () => {
    const cfg = { ...DEFAULT_SHORTCUTS };
    // 与 toggle-layer 默认值 Ctrl+Alt+D 等价的另一种写法。
    expect(findDuplicate(cfg, "new-task", "control+alt+KeyD")).toBe("toggle-layer");
    expect(findDuplicate(cfg, "new-task", "Ctrl+Alt+KeyD")).toBe("toggle-layer");
    expect(findDuplicate(cfg, "new-task", "Ctrl+Alt+N")).toBeNull(); // 与自身相同不算
    expect(findDuplicate(cfg, "new-task", "Ctrl+Shift+N")).toBeNull();
  });

  it("修饰键门槛与 Win→Super 别名转换", () => {
    expect(hasModifier("Ctrl+Alt+D")).toBe(true);
    expect(hasModifier("A")).toBe(false);
    expect(toRustAccelerator("Ctrl+Win+KeyX")).toBe("Ctrl+Super+KeyX");
    expect(toRustAccelerator("Ctrl+Alt+D")).toBe("Ctrl+Alt+D");
  });

  it("[HOTKEY] 默认表覆盖全部动作、有默认键的每项带修饰键且互不冲突（shortcuts.rs 同款约束）", () => {
    expect(Object.keys(DEFAULT_SHORTCUTS).sort()).toEqual([...SHORTCUT_ACTIONS].sort());
    expect(Object.keys(SHORTCUT_LABELS).sort()).toEqual([...SHORTCUT_ACTIONS].sort());
    const seen = new Set<string>();
    const unbound: string[] = [];
    for (const a of SHORTCUT_ACTIONS) {
      expect(SHORTCUT_LABELS[a]).toBeTruthy();
      if (!isShortcutBound(DEFAULT_SHORTCUTS[a])) {
        unbound.push(a);
        continue;
      }
      expect(hasModifier(DEFAULT_SHORTCUTS[a])).toBe(true);
      const norm = normalizeAccelerator(DEFAULT_SHORTCUTS[a]);
      expect(seen.has(norm)).toBe(false);
      seen.add(norm);
    }
    // [TB-TRAY] 唯一的无默认键动作是任务栏总开关（Rust default_for 同款断言）。
    expect(unbound).toEqual(["taskbar:toggle"]);
  });

  it("[HOTKEY] toggle-palette：默认 Ctrl+Alt+K，录制得到同一写法，与其它行双向查重", () => {
    expect(SHORTCUT_ACTIONS).toContain("toggle-palette");
    expect(DEFAULT_SHORTCUTS["toggle-palette"]).toBe("Ctrl+Alt+K");
    // 设置页录制 Ctrl+Alt+K 得到与默认值相同的字符串（恢复默认按钮据此判等）。
    expect(acceleratorFromEvent(keydown("KeyK", "k", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+K");
    const cfg = { ...DEFAULT_SHORTCUTS };
    // 别的动作想占 Ctrl+Alt+K → 报与 toggle-palette 冲突；反向同理。
    expect(findDuplicate(cfg, "new-task", "control+alt+KeyK")).toBe("toggle-palette");
    expect(findDuplicate(cfg, "toggle-palette", "Ctrl+Alt+Q")).toBe("quick-note");
    expect(findDuplicate(cfg, "toggle-palette", "Ctrl+Alt+K")).toBeNull();
    // 窗口内 Ctrl+K 与全局 Ctrl+Alt+K 是不同组合（不会因默认值互相吞键）。
    expect(normalizeAccelerator("Ctrl+K")).not.toBe(normalizeAccelerator(DEFAULT_SHORTCUTS["toggle-palette"]));
  });

  it("[ISLAND-LINK] toggle-dock / open-dock-panel：默认 Ctrl+Alt+I / Ctrl+Alt+O，双向查重", () => {
    // 9 项灵动岛期动作 + [TB-TRAY] 2 项任务栏动作 + [SNIP] 截图 = 12。
    expect(SHORTCUT_ACTIONS).toHaveLength(12);
    expect(SHORTCUT_ACTIONS).toContain("toggle-dock");
    expect(SHORTCUT_ACTIONS).toContain("open-dock-panel");
    expect(DEFAULT_SHORTCUTS["toggle-dock"]).toBe("Ctrl+Alt+I");
    expect(DEFAULT_SHORTCUTS["open-dock-panel"]).toBe("Ctrl+Alt+O");
    // 录制得到与默认值相同的字符串（恢复默认按钮据此判等）。
    expect(acceleratorFromEvent(keydown("KeyI", "i", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+I");
    expect(acceleratorFromEvent(keydown("KeyO", "o", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+O");
    const cfg = { ...DEFAULT_SHORTCUTS };
    // 别的动作想占 Ctrl+Alt+I / O → 报与新动作冲突；新动作想占别人的 → 反向命中；两新动作之间也互斥。
    expect(findDuplicate(cfg, "new-task", "control+alt+KeyI")).toBe("toggle-dock");
    expect(findDuplicate(cfg, "quick-note", "Ctrl+Alt+O")).toBe("open-dock-panel");
    expect(findDuplicate(cfg, "toggle-dock", "Ctrl+Alt+K")).toBe("toggle-palette");
    expect(findDuplicate(cfg, "open-dock-panel", "Ctrl+Alt+I")).toBe("toggle-dock");
    expect(findDuplicate(cfg, "toggle-dock", "Ctrl+Alt+I")).toBeNull();
    // 标签避开既有 UI 标题「灵动岛」「灵动岛面板」（按文本定位的测试/辅助技术不会命中两处）。
    expect(SHORTCUT_LABELS["toggle-dock"]).toBe("显隐灵动岛");
    expect(SHORTCUT_LABELS["open-dock-panel"]).toBe("打开灵动岛面板");
  });

  it("[TB-TRAY] taskbar:reset-state 默认 Ctrl+Alt+Shift+F1（标杆热键）、可录制、双向查重", () => {
    expect(SHORTCUT_ACTIONS).toContain("taskbar:reset-state");
    expect(DEFAULT_SHORTCUTS["taskbar:reset-state"]).toBe("Ctrl+Alt+Shift+F1");
    expect(isShortcutBound(DEFAULT_SHORTCUTS["taskbar:reset-state"])).toBe(true);
    // 录制 Ctrl+Alt+Shift+F1 得到与默认值相同的字符串（恢复默认按钮据此判等）；
    // 下发 Rust 不需要别名转换（无 Win 键）。
    expect(acceleratorFromEvent(keydown("F1", "F1", { ctrl: true, alt: true, shift: true }))).toBe("Ctrl+Alt+Shift+F1");
    expect(toRustAccelerator("Ctrl+Alt+Shift+F1")).toBe("Ctrl+Alt+Shift+F1");
    const cfg = { ...DEFAULT_SHORTCUTS };
    // 别的动作想占 Ctrl+Alt+Shift+F1 → 报与 reset-state 冲突（等价写法亦然）；反向同理。
    expect(findDuplicate(cfg, "new-task", "Ctrl+Alt+Shift+F1")).toBe("taskbar:reset-state");
    expect(findDuplicate(cfg, "quick-note", "shift+control+alt+F1")).toBe("taskbar:reset-state");
    expect(findDuplicate(cfg, "taskbar:reset-state", "Ctrl+Alt+K")).toBe("toggle-palette");
    expect(findDuplicate(cfg, "taskbar:reset-state", "Ctrl+Alt+Shift+F1")).toBeNull();
    // 少一个 Shift 的 Ctrl+Alt+F1 是另一组合，不与默认值冲突。
    expect(findDuplicate(cfg, "new-task", "Ctrl+Alt+F1")).toBeNull();
    expect(SHORTCUT_LABELS["taskbar:reset-state"]).toBe("重置任务栏状态");
  });

  it("[TB-TRAY] taskbar:toggle 出厂未绑定：空串哨兵、查重不把空串当键、录制后正常参与查重", () => {
    expect(SHORTCUT_ACTIONS).toContain("taskbar:toggle");
    expect(DEFAULT_SHORTCUTS["taskbar:toggle"]).toBe(SHORTCUT_UNBOUND);
    expect(SHORTCUT_UNBOUND).toBe("");
    expect(isShortcutBound(SHORTCUT_UNBOUND)).toBe(false);
    expect(isShortcutBound("   ")).toBe(false);
    expect(isShortcutBound("Ctrl+Alt+T")).toBe(true);
    // 未绑定行不会与任何动作「冲突」：其它动作的查重也不会误报到它。
    const cfg = { ...DEFAULT_SHORTCUTS };
    expect(findDuplicate(cfg, "taskbar:toggle", SHORTCUT_UNBOUND)).toBeNull();
    expect(findDuplicate(cfg, "new-task", "Ctrl+Shift+T")).toBeNull();
    // 「恢复默认」= 回到未绑定；hasModifier 对空串为 false（录制器不会产生空串，
    // 该门槛只拦无修饰的真实按键）。
    expect(hasModifier(SHORTCUT_UNBOUND)).toBe(false);
    expect(normalizeAccelerator(SHORTCUT_UNBOUND)).toBe("");
    // 用户录制后与其它行无差别：双向查重覆盖它。
    const bound = { ...DEFAULT_SHORTCUTS, "taskbar:toggle": "Ctrl+Alt+T" };
    expect(findDuplicate(bound, "quick-note", "control+alt+KeyT")).toBe("taskbar:toggle");
    expect(findDuplicate(bound, "taskbar:toggle", "Ctrl+Alt+Shift+F1")).toBe("taskbar:reset-state");
    expect(findDuplicate(bound, "taskbar:toggle", "Ctrl+Alt+T")).toBeNull();
    expect(SHORTCUT_LABELS["taskbar:toggle"]).toBe("开关任务栏外观");
  });
});
