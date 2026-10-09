/**
 * 剪贴板迷你磁贴（ISLAND-MINI）：最近一条摘要（文本前 24 字 / 「图片」）。
 * 首帧拉 list_recent 首条（纯 created_at 序——置顶是列表浏览语义，不该霸占
 * 迷你位：此前 pinned 优先排序让置顶项永远占着迷你磁贴）；此后只由
 * clipboard:changed 事件触发重拉（150ms 合并，"pin" 载荷跳过），无轮询；
 * active=false 期间忽略事件不重拉，重新激活时补拉一次（否则要等下一次复制
 * 才能看到新内容）。隐私总开关（settings general.clipboard.enabled）关闭 →
 * 禁用态 + title 提示且不可点；开启时点击回写系统剪贴板
 * （restore_clipboard_entry）并闪「已复制」。可点区是 role=button 的 span
 * （宿主磁贴本身是 <button>），点击 stopPropagation。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { ClipboardList, FolderClosed, Image as ImageIcon } from "lucide-react";
import { useT } from "../../../i18n-lite";
import { invoke, isTauri } from "../../../lib/tauri";
import { useSafeTimeout } from "../../../lib/use-safe-timeout";
import { useTauriEvent } from "../../../lib/use-tauri-event";
import { useSettingsStore } from "../../../store/settings-store";
import type { ClipboardEntry } from "../../../types/bindings/ClipboardEntry";
import type { MiniComponentProps } from "../../registry";

export function ClipboardMini({ active }: MiniComponentProps) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const enabled = useSettingsStore((s) => s.general.clipboard.enabled);
  const [entry, setEntry] = useState<ClipboardEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const refreshTimer = useRef(0);

  const load = useCallback(() => {
    if (!isTauri()) return;
    void invoke<ClipboardEntry[]>("list_clipboard_history", { query: null, limit: 1, latest: true })
      .then((list) => setEntry(list[0] ?? null))
      .catch(() => {});
  }, []);
  // 挂载 + 每次激活（active=false 期间错过的事件）都拉一次。
  useEffect(() => {
    if (active) load();
  }, [active, load]);
  useEffect(() => {
    return () => window.clearTimeout(refreshTimer.current);
  }, []);
  useTauriEvent<string | null>("clipboard:changed", (payload) => {
    if (!activeRef.current || payload === "pin") return;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(load, 150);
  });

  const restore = (e: SyntheticEvent) => {
    e.stopPropagation();
    if (!entry || !enabled || !isTauri()) return;
    void invoke("restore_clipboard_entry", { id: entry.id })
      .then(() => {
        setCopied(true);
        safeTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      restore(e);
    }
  };
  const isImage = entry?.kind === "image";
  const isFiles = entry?.kind === "files";
  const summary = !entry
    ? tr("暂无剪贴板记录")
    : isImage
      ? tr("图片")
      : Array.from(entry.preview || tr("（空白）"))
          .slice(0, 24)
          .join("");
  const clickable = !!entry && enabled;
  return (
    <span
      className={`dock-mini dock-mini-clipboard${enabled ? "" : " is-disabled"}${copied ? " is-copied" : ""}`}
      title={enabled ? undefined : tr("记录已在设置中关闭，仅显示已有历史")}
      aria-disabled={enabled ? undefined : true}
    >
      {isImage ? (
        <ImageIcon size={13} className="dock-mini-ico" />
      ) : isFiles ? (
        <FolderClosed size={13} className="dock-mini-ico" />
      ) : (
        <ClipboardList size={13} className="dock-mini-ico" />
      )}
      <span
        className="dock-mini-text"
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? restore : undefined}
        onKeyDown={clickable ? onKey : undefined}
        aria-label={clickable ? tr("点击复制到剪贴板") : undefined}
        data-interactive={clickable || undefined}
      >
        {copied ? tr("已复制") : summary}
      </span>
    </span>
  );
}
