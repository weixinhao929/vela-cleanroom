/**
 * 便签定时提醒（DeskOrder 借鉴 #8）：Note.remindAt 到点经通知中心提醒
 * （sourceNotify("note")，受「通知来源」逐源开关 + 免打扰 + 专注静音治理），
 * 发出后清除 remindAt。
 *
 * 错过补发（DeskOrder CheckMissedReminders 的等价简化）：扫描器对
 * remindAt <= now 且未清除的便签一律发出——应用停机期间错过的提醒在下次
 * 启动的首轮扫描自然补发，无需单独路径。
 *
 * 数据发现：便签按实例分键存 localStorage（focus-desk.notes.<id>），扫描
 * 前缀即可枚举全部实例；.trash 后缀的回收站键不参与。
 */
import { loadNotes, saveNotes } from "./notes-store";
import type { Note } from "./notes-store";
import { sourceNotify } from "../lib/notifications";
import { t } from "../i18n-lite";

/** 便签键前缀（与 notes-store 的 notesKey 一致；单独声明避免循环依赖）。 */
const NOTES_KEY_PREFIX = "focus-desk.notes.";

/** 扫描间隔：与 DeskOrder ReminderService 的 30s 对齐（提醒粒度 ±30s）。 */
export const REMINDER_SCAN_MS = 30_000;

/** 首行摘要：清单/空行跳过，截 40 字符。 */
export function noteSummary(text: string): string {
  const first = text
    .split("\n")
    .map((l) => l.replace(/^[-*+]\s*\[[ xX]\]\s*/, "").trim())
    .find((l) => l.length > 0);
  const s = first ?? "";
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** 枚举所有便签实例 id（含空实例；.trash 键排除）。 */
export function noteInstanceIds(): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(NOTES_KEY_PREFIX) || key.endsWith(".trash")) continue;
      ids.push(key.slice(NOTES_KEY_PREFIX.length));
    }
  } catch {
    // localStorage 不可用（极端）时返回空，扫描 no-op。
  }
  return ids;
}

/** 到点未发的便签（remindAt <= now）。 */
export function dueReminderNotes(now: Date): { instanceId: string; note: Note }[] {
  const ts = now.getTime();
  const due: { instanceId: string; note: Note }[] = [];
  for (const instanceId of noteInstanceIds()) {
    for (const note of loadNotes(instanceId)) {
      const at = note.remindAt ? Date.parse(note.remindAt) : Number.NaN;
      if (Number.isFinite(at) && at <= ts) {
        due.push({ instanceId, note });
      }
    }
  }
  return due;
}

/**
 * 发出并清除一条到期提醒（发出即清除 = 幂等，30s 扫描不会重复打扰）。
 * 清除走「现读 → 只改这一条的 remindAt → 整表写回」，不覆盖并发的其他改动。
 */
export function fireNoteReminder(instanceId: string, noteId: string, _now?: Date): boolean {
  const list = loadNotes(instanceId);
  const idx = list.findIndex((n) => n.id === noteId);
  if (idx < 0 || !list[idx].remindAt) return false;
  const body = noteSummary(list[idx].text) || t("（无内容）");
  sourceNotify("note", t("便签提醒"), body);
  const next = list.slice();
  const { remindAt: _drop, ...rest } = next[idx];
  void _drop;
  // updatedAt 不动：设提醒/提醒触发都不该把便签顶到「最近修改」排序的最上面。
  next[idx] = rest as Note;
  saveNotes(instanceId, next);
  return true;
}

/** 单轮扫描：发出全部到期提醒。返回发出条数（测试用）。 */
export function scanNoteReminders(now = new Date()): number {
  let fired = 0;
  for (const { instanceId, note } of dueReminderNotes(now)) {
    if (fireNoteReminder(instanceId, note.id, now)) fired++;
  }
  return fired;
}

/**
 * 启动周期扫描（仅主窗口调用一次，D-1 单驱动原则）。立即先扫一轮——
 * 错过补发就发生在这一轮。返回停止函数。
 */
export function startNoteReminderScheduler(): () => void {
  scanNoteReminders();
  const timer = window.setInterval(() => scanNoteReminders(), REMINDER_SCAN_MS);
  return () => window.clearInterval(timer);
}
