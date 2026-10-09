/**
 * 便签共享存储：普通便签 + 回收站（删除后先进入回收站，可在设置中恢复）。
 * 小组件与设置页共用同一组 localStorage key，保证删除/恢复实时一致。
 */

import { persistMirrored, scheduleMirrorSync } from "../lib/local-backup";

/** 回收站保留天数（软删除 30 天后由数据层自动清理；主窗启动时执行一轮）。 */
export const NOTES_TRASH_RETENTION_DAYS = 30;
/** 每实例便签条数上限：超出部分按 updatedAt 最旧的转回收站（可恢复，
 *  置顶豁免）。防长年使用无限增长撑爆 localStorage 配额。 */
export const NOTES_CAP = 500;

export type Note = {
  id: string;
  text: string;
  updatedAt: string;
  pinned?: boolean;
  /** 便签颜色（默认无色）。 */
  color?: string;
  /** 手动排序序号（小者在前，仅 sortBy=manual 时生效）。 */
  order?: number;
  /** 定时提醒（ISO；到点由 notes-reminders 发通知后清除）。 */
  remindAt?: string;
};
/**
 * 便签持久化仓储（按实例分键的 localStorage + 防抖镜像）。
 * 职责：便签列表与回收站的读写、软删除/恢复/彻底清除、Markdown 导入导出。
 * 所有写入走 persistMirrored（进备份）；删除为软删除（回收站保留 30 天语义
 * 由 UI 层展示，数据层不自动清理）。
 */

export type TrashNote = { id: string; text: string; updatedAt: string; deletedAt: string };

/** 便签列表键。 */
function notesKey(instanceId: string) {
  return `focus-desk.notes.${instanceId}`;
}
/** 回收站键。 */
function trashKey(instanceId: string) {
  return `focus-desk.notes.${instanceId}.trash`;
}

/* ---- 模块级轻量 pub/sub：便签数据变更通知 ----
   供只读订阅方（灵动岛磁贴摘要等）使用，替代此前的定时盲轮询——
   轮询不判 document.hidden、不对比结果，磁贴挂一天就空转 2880 次。
   写路径（saveNotes/saveTrash）落盘后触发；跨窗口写入经 sync:notes
   事件落地到本窗口的 saveNotes，同样会走到这里。 */
type NotesListener = () => void;
const notesListeners = new Set<NotesListener>();

/** 订阅任一便签实例的数据变更；返回退订函数。 */
export function subscribeNotes(fn: NotesListener): () => void {
  notesListeners.add(fn);
  return () => {
    notesListeners.delete(fn);
  };
}

function notifyNotesChanged(): void {
  for (const fn of notesListeners) fn();
}

/**
 * 读取便签列表；缺失/损坏返回空数组。
 *
 * @param instanceId - 便签组件实例 id。
 * @returns Note 数组（不保证排序，排序由 UI 层负责）。
 */
export function loadNotes(instanceId: string): Note[] {
  try {
    const raw = localStorage.getItem(notesKey(instanceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Note[]) : [];
  } catch {
    return [];
  }
}

/**
 * 整体保存便签列表（persistMirrored：写入 + 防抖镜像同步，保证进备份
 * 且连续保存不重复整表重写）。超过 {@link NOTES_CAP} 时最旧的非置顶便签
 * 转入回收站（不硬删，30 天内可恢复）。
 *
 * @param instanceId - 实例 id。
 * @param notes - 完整便签数组（整体覆写）。
 */
export function saveNotes(instanceId: string, notes: Note[]) {
  let kept = notes;
  if (notes.length > NOTES_CAP) {
    // 置顶豁免；其余按 updatedAt 最旧的出列（时间缺失视为最旧）。
    // i 必须是原数组下标（先 map 后 filter），否则与 overflowIdx 比对时错位。
    const candidates = notes
      .map((n, i) => ({ n, i, at: Date.parse(n.updatedAt) || 0 }))
      .filter((c) => !c.n.pinned)
      .sort((a, b) => a.at - b.at || a.i - b.i);
    const overflowCount = notes.length - NOTES_CAP;
    const overflowIdx = new Set(candidates.slice(0, overflowCount).map((c) => c.i));
    const trash = loadTrash(instanceId);
    kept = notes.filter((_, i) => !overflowIdx.has(i));
    saveTrash(instanceId, [
      ...trash,
      ...notes
        .filter((_, i) => overflowIdx.has(i))
        .map(({ id, text, updatedAt }) => ({ id, text, updatedAt, deletedAt: new Date().toISOString() }))
    ]);
  }
  persistMirrored(notesKey(instanceId), JSON.stringify(kept));
  notifyNotesChanged();
}

/** 读取回收站条目；缺失/损坏返回空数组。 */
export function loadTrash(instanceId: string): TrashNote[] {
  try {
    const raw = localStorage.getItem(trashKey(instanceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrashNote[]) : [];
  } catch {
    return [];
  }
}

/** 整体保存回收站（persistMirrored）。 */
export function saveTrash(instanceId: string, trash: TrashNote[]) {
  persistMirrored(trashKey(instanceId), JSON.stringify(trash));
  notifyNotesChanged();
}

/**
 * 删除一条便签：不直接抹除，而是移入回收站（保留原文与删除时间）。
 * 注意：这是纯副作用函数，必须在 React state updater 之外调用——
 * StrictMode 下 updater 会被双调用，若在此写回收站会导致便签重复入站。
 */
export function deleteToTrash(instanceId: string, note: Note): void {
  // remindAt 一并剥掉：删除即取消提醒——否则已过期的 remindAt 随回收站幸存，
  // 恢复后 ≤30s 内被提醒扫描器当「错过补发」弹出陈旧通知。
  const { pinned: _pinned, color: _color, order: _order, remindAt: _remindAt, ...rest } = note;
  void _pinned;
  void _color;
  void _order;
  void _remindAt;
  const trash = loadTrash(instanceId);
  saveTrash(instanceId, [...trash, { ...rest, deletedAt: new Date().toISOString() }]);
}

/** 从回收站恢复：放回便签列表顶部，并移除回收站记录。 */
export function restoreFromTrash(instanceId: string, id: string): Note | null {
  const trash = loadTrash(instanceId);
  const item = trash.find((t) => t.id === id);
  if (!item) return null;
  saveTrash(
    instanceId,
    trash.filter((t) => t.id !== id)
  );
  const { deletedAt: _deletedAt, ...note } = item;
  void _deletedAt;
  const restored: Note = { ...note, updatedAt: new Date().toISOString() };
  saveNotes(instanceId, [restored, ...loadNotes(instanceId)]);
  return restored;
}

/** 彻底删除回收站中的一条记录（不可恢复）。 */
export function purgeTrash(instanceId: string, id: string): void {
  saveTrash(
    instanceId,
    loadTrash(instanceId).filter((t) => t.id !== id)
  );
}

/** 清空回收站。 */
export function emptyTrash(instanceId: string): void {
  saveTrash(instanceId, []);
}

/**
 * 聚合便签回收站：枚举所有便签实例的回收站条目，供组件回收站统一
 * 管理（原先便签回收站只在各便签组件内部，与组件回收站割裂两处）。
 */
export type TrashNoteRef = { instanceId: string; note: TrashNote };

export function listAllNotesTrash(): TrashNoteRef[] {
  const out: TrashNoteRef[] = [];
  const prefix = "focus-desk.notes.";
  const suffix = ".trash";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const instanceId = key.slice(prefix.length, key.length - suffix.length);
    if (!instanceId) continue;
    for (const note of loadTrash(instanceId)) out.push({ instanceId, note });
  }
  return out;
}

/**
 * 回收站过期自动清理：删除软删除超过 {@link NOTES_TRASH_RETENTION_DAYS}
 * 天的条目（与组件回收站 purgeExpiredTrash 同语义，补齐便签侧——此前
 * 注释自述「数据层不自动清理」，删除的便签全文永久滞留 localStorage）。
 * 由主窗启动时调用一轮；返回清理条数供观测/测试。
 */
export function purgeExpiredNotesTrash(): number {
  const prefix = "focus-desk.notes.";
  const suffix = ".trash";
  const cutoff = Date.now() - NOTES_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const instanceId = key.slice(prefix.length, key.length - suffix.length);
    if (!instanceId) continue;
    const trash = loadTrash(instanceId);
    const kept = trash.filter((t) => (Date.parse(t.deletedAt) || 0) >= cutoff);
    if (kept.length !== trash.length) {
      purged += trash.length - kept.length;
      saveTrash(instanceId, kept);
    }
  }
  return purged;
}

// ── 导出 / 导入 ─────────────────────────────────────────
// 导出格式（Markdown，带可解析的注释标记）：
//   <!-- vela-note id=<uuid> at=<ISO> -->
//   正文…
//   <!-- /vela-note -->
// 无任何标记的 .md/.txt 导入时整体作为一条新便签。

const NOTE_OPEN = /^<!--\s*vela-note id=([\w-]+) at=([^\s>]+)([^>]*)-->$/;
const NOTE_CLOSE = /^<!--\s*\/vela-note\s*-->$/;

/** 导出转义：正文里恰好独占一行、形如开/闭标记的文本会让导入解析提前
 * 闭合（后续正文被当新内容错切）。在行尾追加零宽空格打破整行匹配；导入
 * 侧统一剥离行尾零宽空格还原（用户正文的行尾 ZWSP 无语义）。 */
function escapeMarkerLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (NOTE_OPEN.test(line.trim()) || NOTE_CLOSE.test(line.trim()) ? `${line}\u200B` : line))
    .join("\n");
}

export function exportNotesMarkdown(notes: Note[]): string {
  const head = `<!-- vela-notes-export v1 count=${notes.length} -->`;
  const body = notes
    .map((n) => {
      // order/remindAt 此前不进导出，round-trip 丢失手动排序与提醒设置。
      const meta = [
        n.pinned ? "pinned" : "",
        n.color ? `color=${n.color}` : "",
        typeof n.order === "number" && Number.isFinite(n.order) ? `order=${n.order}` : "",
        n.remindAt ? `remindAt=${n.remindAt}` : ""
      ]
        .filter(Boolean)
        .join(" ");
      const open = `<!-- vela-note id=${n.id} at=${n.updatedAt}${meta ? ` ${meta}` : ""} -->`;
      return `${open}\n${escapeMarkerLines(n.text)}\n<!-- /vela-note -->`;
    })
    .join("\n\n");
  return `${head}\n\n${body}\n`;
}

/** 解析导出的 Markdown；无标记的纯文本返回单条新便签。 */
export function parseNotesImport(raw: string): Note[] {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\u200B+$/, ""));
  const out: Note[] = [];
  let current: Note | null = null;
  const now = new Date().toISOString();
  for (const line of lines) {
    const open = line.trim().match(NOTE_OPEN);
    if (open) {
      if (current && current.text.trim()) out.push(current);
      const extra = open[3] ?? "";
      const orderRaw = extra.match(/(?:^|\s)order=(-?\d+(?:\.\d+)?)(?:\s|$)/)?.[1];
      const remindRaw = extra.match(/(?:^|\s)remindAt=([^\s>]+)(?:\s|$)/)?.[1];
      current = {
        id: open[1],
        text: "",
        updatedAt: open[2] || now,
        pinned: /(?:^|\s)pinned(?:\s|$)/.test(extra),
        color: extra.match(/(?:^|\s)color=([\w-]+)(?:\s|$)/)?.[1],
        ...(orderRaw !== undefined ? { order: Number(orderRaw) } : {}),
        // 已过期的提醒不还原：导入即弹陈旧通知（与回收站恢复同口径）。
        ...(remindRaw && Date.parse(remindRaw) > Date.now() ? { remindAt: remindRaw } : {})
      };
      continue;
    }
    if (NOTE_CLOSE.test(line.trim())) {
      if (current && current.text.trim()) out.push(current);
      current = null;
      continue;
    }
    if (current) current.text += (current.text ? "\n" : "") + line;
  }
  if (current && current.text.trim()) out.push(current);
  for (const n of out) n.text = n.text.replace(/\n+$/, "");
  if (out.length > 0) return out;
  const text = raw.trim();
  return text ? [{ id: crypto.randomUUID(), text, updatedAt: now }] : [];
}

/** 下载文本文件（Blob + a[download]，无 Rust 依赖）。 */
export function downloadTextFile(filename: string, content: string, mime = "text/markdown"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 全局速记 ────────────────────────────────────────────

/** 速记窗口没有任何便签实例可落时的兜底桶 id（见 {@link pickQuickNoteTarget}）。 */
export const QUICK_NOTE_FALLBACK_ID = "quicknote";

/**
 * 枚举所有便签实例及其内容（不含回收站）：命令面板内容级搜索等全局
 * 检索入口使用（便签按实例分键，没有这条就找不到「我的那条便签」）。
 */
export function listNoteInstances(): { instanceId: string; notes: Note[] }[] {
  const out: { instanceId: string; notes: Note[] }[] = [];
  const prefix = "focus-desk.notes.";
  const suffix = ".trash";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix) || key.endsWith(suffix)) continue;
    const instanceId = key.slice(prefix.length);
    if (!instanceId) continue;
    const notes = loadNotes(instanceId);
    if (notes.length > 0) out.push({ instanceId, notes });
  }
  return out;
}

/**
 * 为速记窗口挑选目标便签实例：扫描 localStorage 中所有
 * focus-desk.notes.* key，取便签数最多的实例（≈ 用户主用的列表）；
 * 没有任何便签实例时落到固定兜底桶（由 {@link absorbQuickNoteOrphan}
 * 在第一块便签组件挂载时吸收，数据不丢）。
 */
export function pickQuickNoteTarget(): string {
  let best: { id: string; count: number } | null = null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("focus-desk.notes.") || key.endsWith(".trash")) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
      const count = Array.isArray(parsed) ? parsed.length : 0;
      if (!best || count > best.count) best = { id: key.slice("focus-desk.notes.".length), count };
    } catch {
      // ignore malformed entries
    }
  }
  return best?.id ?? QUICK_NOTE_FALLBACK_ID;
}

/**
 * 便签实例挂载时吸收速记兜底桶：用户在没有任何便签组件时用 Ctrl+Alt+Q
 * 速记的内容落到固定桶后，永远等不到同 id 的实例出现（实例 id 是随机 uid），
 * 形成「保存后再也看不见」的黑洞。第一块便签组件挂载时把孤儿便签搬进自己
 * 名下并删除兜底桶，修复该黑洞。返回被吸收的条数（0 = 无孤儿可收）。
 */
export function absorbQuickNoteOrphan(instanceId: string): number {
  if (instanceId === QUICK_NOTE_FALLBACK_ID) return 0;
  const orphan = loadNotes(QUICK_NOTE_FALLBACK_ID);
  if (orphan.length === 0) return 0;
  saveNotes(instanceId, [...orphan, ...loadNotes(instanceId)]);
  localStorage.removeItem(notesKey(QUICK_NOTE_FALLBACK_ID));
  scheduleMirrorSync();
  return orphan.length;
}
