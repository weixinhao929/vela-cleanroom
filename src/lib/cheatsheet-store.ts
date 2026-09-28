/**
 * 快捷键速查表（Ctrl+?）的打开状态与控制函数。
 *
 * 模块级外部存储：`ShortcutCheatsheetHost` 用 useSyncExternalStore 订阅，
 * 命令面板「查看快捷键速查表」命令与窗口级 Ctrl+? 监听经这里的控制函数驱动。
 * 与组件分文件是为了让 ShortcutCheatsheet.tsx 只导出组件（Fast Refresh
 * 边界完整），也避免命令目录（lib/commands）反向依赖组件模块。
 */

let sheetOpen = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** 订阅打开状态变化；返回退订函数（useSyncExternalStore 签名）。 */
export function subscribeShortcutCheatsheet(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 当前是否打开（useSyncExternalStore 的 getSnapshot）。 */
export function isShortcutCheatsheetOpen(): boolean {
  return sheetOpen;
}

export function openShortcutCheatsheet(): void {
  sheetOpen = true;
  notify();
}

export function closeShortcutCheatsheet(): void {
  sheetOpen = false;
  notify();
}

export function toggleShortcutCheatsheet(): void {
  sheetOpen = !sheetOpen;
  notify();
}

/** Ctrl+? ：主键 `?` 在多数布局是 Shift+/，两种上报形态都接。 */
export function isCheatsheetHotkey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  return e.key === "?" || (e.shiftKey && (e.key === "/" || e.code === "Slash"));
}
