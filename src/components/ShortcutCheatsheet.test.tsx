/**
 * 快捷键速查表（Ctrl+?）：数据与实际快捷键一致（全局段 = settings-store
 * 实时配置；命令目录 = lib/commands.buildCommands 当前快照）、Ctrl+? 切换、
 * Esc / 遮罩关闭、对称退场延迟卸载。
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShortcutCheatsheetHost } from "./ShortcutCheatsheet";
import { closeShortcutCheatsheet, isCheatsheetHotkey, openShortcutCheatsheet } from "../lib/cheatsheet-store";
import { buildCommands } from "../lib/commands";
import { useSettingsStore } from "../store/settings-store";
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_LABELS } from "../lib/shortcuts";
import { t } from "../i18n-lite";

afterEach(() => {
  closeShortcutCheatsheet();
  cleanup();
  useSettingsStore.getState().setShortcuts(DEFAULT_SHORTCUTS);
});

const keyEv = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("isCheatsheetHotkey", () => {
  it("Ctrl+? 的两种上报形态都命中，缺 Ctrl 或其它键不命中", () => {
    expect(isCheatsheetHotkey(keyEv({ key: "?", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCheatsheetHotkey(keyEv({ key: "/", code: "Slash", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCheatsheetHotkey(keyEv({ key: "?", metaKey: true }))).toBe(true);
    expect(isCheatsheetHotkey(keyEv({ key: "?" }))).toBe(false);
    expect(isCheatsheetHotkey(keyEv({ key: "/", ctrlKey: true }))).toBe(false);
    expect(isCheatsheetHotkey(keyEv({ key: "k", ctrlKey: true }))).toBe(false);
  });
});

describe("ShortcutCheatsheetHost", () => {
  it("默认不渲染；Ctrl+? 打开，再按一次收起（延迟卸载后消失）", async () => {
    render(<ShortcutCheatsheetHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      window.dispatchEvent(keyEv({ key: "?", ctrlKey: true, shiftKey: true }));
    });
    expect(screen.getByRole("dialog", { name: t("快捷键速查") })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(keyEv({ key: "?", ctrlKey: true, shiftKey: true }));
    });
    // 退场期间仍挂载（is-closing），160ms 后卸载
    expect(screen.getByRole("dialog").className).toContain("is-closing");
    await act(() => new Promise((r) => setTimeout(r, 220)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("全局快捷键段逐条等于 settings-store 的实时配置（改配置即刷新）", () => {
    render(<ShortcutCheatsheetHost />);
    act(() => openShortcutCheatsheet());
    for (const a of SHORTCUT_ACTIONS) {
      const row = screen.getByText(t(SHORTCUT_LABELS[a])).closest(".tm-cheatsheet-row") as HTMLElement;
      const kbds = Array.from(row.querySelectorAll("kbd")).map((k) => k.textContent);
      // [TB-TRAY] 未绑定动作（taskbar:toggle 出厂空串）在速查表上没有 kbd；filter(Boolean)
      // 让期望值与 chord() 的空串处理一致。
      expect(kbds).toEqual(
        DEFAULT_SHORTCUTS[a]
          .split("+")
          .filter(Boolean)
          .map((p) => (p === "Space" ? "␣" : p))
      );
    }
    // 用户改了「打开设置」→ 速查表跟随
    act(() => useSettingsStore.getState().setShortcut("show-settings", "Ctrl+Shift+F9"));
    const row = screen.getByText(t(SHORTCUT_LABELS["show-settings"])).closest(".tm-cheatsheet-row") as HTMLElement;
    expect(Array.from(row.querySelectorAll("kbd")).map((k) => k.textContent)).toEqual(["Ctrl", "Shift", "F9"]);
  });

  it("命令目录段 = buildCommands 当前快照（去掉设置搜索项），含速查表自身入口与 Ctrl+? 提示", () => {
    render(<ShortcutCheatsheetHost />);
    act(() => openShortcutCheatsheet());
    const expected = buildCommands(t).filter((c) => !c.id.startsWith("set-"));
    expect(expected.length).toBeGreaterThan(0);
    for (const c of expected) {
      expect(screen.getAllByText(c.label).length).toBeGreaterThan(0);
    }
    const sheetRow = screen.getByText(t("查看快捷键速查表")).closest(".tm-cheatsheet-row") as HTMLElement;
    expect(Array.from(sheetRow.querySelectorAll("kbd")).map((k) => k.textContent)).toEqual(["Ctrl", "?"]);
    // 视图切换命令不再带「Ctrl+数字」这种并不存在的快捷键提示
    const viewCmd = expected.find((c) => c.id.startsWith("view-"));
    expect(viewCmd?.hint).toBeUndefined();
  });

  it("Esc 关闭（capture 阶段拦截）；点遮罩关闭；点面板不关闭", () => {
    render(<ShortcutCheatsheetHost />);
    act(() => openShortcutCheatsheet());
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.querySelector(".tm-cheatsheet-panel") as HTMLElement);
    expect(dialog.className).not.toContain("is-closing");
    act(() => {
      window.dispatchEvent(keyEv({ key: "Escape" }));
    });
    expect(screen.getByRole("dialog").className).toContain("is-closing");
    // 重开后点遮罩
    act(() => openShortcutCheatsheet());
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog").className).toContain("is-closing");
  });
});
