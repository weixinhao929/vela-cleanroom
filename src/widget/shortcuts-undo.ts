/**
 * 快捷方式小组件的操作历史：
 *
 * - **存命令不存快照**：每条历史是 { undo, redo } 逆操作闭包，内存 O(操作数)；
 *   本组件操作全是引用级（条目 = 路径引用，文件本体从不动），undo 不需要
 *   参考实现 那样的 payload 文件托管。
 * - **push 清空重做栈**、栈深上限 100。
 * - undo/redo 执行时**现读权威配置再打逆补丁**（与组件写路径同一模式），
 *   因此与后续无关操作天然可组合，不会拿陈旧快照覆写并发改动。
 * - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 全局接线：模块单例只挂一次；快捷方式
 *   组件的多个实例共用一条时间线（操作闭包各自写回自己的 instanceId），
 *   文本输入焦点内不拦截，交给输入框原生的撤销。
 *
 * 独立于组件文件，避免 fast-refresh 警告。
 */
import { t } from "../i18n-lite";
import { pushAppToast } from "../components/ToastHost";

export type ShortcutsOp = {
  /** 操作名（撤销/重做 toast 展示用，如「移入文件夹」）。 */
  label: string;
  undo: () => void;
  redo: () => void;
};

/** 栈深上限。 */
const MAX_OPS = 100;

const undoStack: ShortcutsOp[] = [];
const redoStack: ShortcutsOp[] = [];

/** 记录一条已执行的操作：入撤销栈并清空重做栈。 */
export function pushOp(op: ShortcutsOp): void {
  undoStack.push(op);
  if (undoStack.length > MAX_OPS) undoStack.shift();
  redoStack.length = 0;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** 撤销一步：弹出栈顶执行其 undo，转入重做栈。栈空返回 null（不弹 toast）。 */
export function undoOp(): ShortcutsOp | null {
  const op = undoStack.pop();
  if (!op) return null;
  op.undo();
  redoStack.push(op);
  pushAppToast(t("已撤销"), op.label, "info");
  return op;
}

/** 重做一步：弹出重做栈执行其 redo，转回撤销栈。 */
export function redoOp(): ShortcutsOp | null {
  const op = redoStack.pop();
  if (!op) return null;
  op.redo();
  undoStack.push(op);
  pushAppToast(t("已重做"), op.label, "info");
  return op;
}

/** 全局键位只接一次；每个挂载的快捷方式组件调用它是幂等的。 */
let wired = false;
export function ensureShortcutsUndoKeys(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      // 文本输入焦点内让给原生撤销（重命名弹窗、URL 输入等）。
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const wantRedo = key === "y" || (key === "z" && e.shiftKey);
      const op = wantRedo ? redoOp() : undoOp();
      if (op) e.preventDefault();
    },
    true
  );
}
