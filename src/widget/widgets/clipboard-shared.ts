/**
 * 剪贴板历史小组件的纯函数（与 ClipboardHistoryWidget 分文件：小组件文件只
 * 导出组件，保持 Fast Refresh 语义；纯函数在此可独立单测）。
 */
import type { ClipboardEntry } from "../../types/bindings/ClipboardEntry";

/** 文本条目的行数（>1 时在元信息里提示，摘要只显首行）。结尾换行不算新行。 */
export function lineCountOf(text: string | null): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith("\n")) n--;
  return Math.max(1, n);
}

/** 列表排序：置顶在前，其余按时间倒序（与 Rust 侧 ClipboardRepo::list 同口径，
 *  供乐观更新后本地重排）。 */
export function sortEntries(list: ClipboardEntry[]): ClipboardEntry[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at));
}

/** [FILES]（ZTools 借鉴 #8）文件条目的路径列表（坏 JSON / 非数组回空）。 */
export function filesListOf(entry: ClipboardEntry): string[] {
  if (entry.kind !== "files" || !entry.files) return [];
  try {
    const parsed: unknown = JSON.parse(entry.files);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

/** 列表行的可读标题（aria-label / 图片 alt）。 */
export function entryTitle(entry: ClipboardEntry, tr: (zh: string) => string): string {
  if (entry.kind === "image") return `${tr("图片")} ${entry.image_w ?? "?"}×${entry.image_h ?? "?"}`;
  if (entry.kind === "files") {
    const n = filesListOf(entry).length;
    return n > 0 ? `${tr("文件")} ×${n}` : tr("文件");
  }
  return entry.preview || tr("（空白）");
}
