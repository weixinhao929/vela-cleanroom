/**
 * 剪贴板历史小组件（CLIP / §4.10）：Win+V 的 Vela 版，数据来自 SQLite
 * clipboard_history（db v8），由 Rust 剪贴板监听线程写入。
 *
 * 交互：
 *  - 列表新→旧，置顶条目固定最前；搜索框对摘要 / 全文做子串匹配（服务端 LIKE，
 *    200ms 防抖）；
 *  - 点击条目 = 回写系统剪贴板（行内闪「已复制」），Rust 侧先 touch 置顶再写，
 *    随后的剪贴板变化命中去重不产生重复行；
 *  - 右键菜单：复制 / 置顶（取消置顶）/ 删除——复用全局 ContextMenu；
 *  - 底栏「清空」两段式确认（useConfirmAction，与通知中心同范式）；
 *  - 图片条目按需拉缩略图（≤256px dataURL，模块级缓存按 id 复用）；
 *  - 监听 clipboard:changed 事件刷新（150ms 合并）；总开关关闭时顶部提示。
 *
 * 隐私：列表 / 缩略图 / 回写全部走 trusted_window 门控命令；本组件不缓存全文
 * 到任何持久化位置。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  Check,
  ClipboardList,
  Copy,
  FolderClosed,
  Image as ImageIcon,
  Pin,
  PinOff,
  Search,
  ShieldOff,
  Trash2,
  X
} from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { openContextMenu, type ContextMenuItem } from "../../components/ContextMenu";
import { useT } from "../../i18n-lite";
import { invoke, isTauri } from "../../lib/tauri";
import { useNow } from "../../lib/use-now";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { useConfirmAction, useDelayedRemoval } from "../../lib/use-confirm-remove";
import { useIncrementalList } from "../../lib/use-incremental-list";
import { useSettingsStore } from "../../store/settings-store";
import type { ClipboardEntry } from "../../types/bindings/ClipboardEntry";
import { friendlyTime } from "../notifications/notification-model";
import { entryTitle, filesListOf, lineCountOf, sortEntries } from "./clipboard-shared";
import "../../styles/feature-clipboard.css";

/** 一屏够用的上限；表本身 ≤500 行（+置顶）。 */
const LIST_LIMIT = 200;
/** 搜索输入防抖。 */
const SEARCH_DEBOUNCE_MS = 200;
/** 事件刷新合并窗口：连续复制只拉一次。 */
const REFRESH_DEBOUNCE_MS = 150;
/** 行内「已复制」反馈停留。 */
const COPIED_MS = 1200;
/** 新到达入场动画时长（与 feature-clipboard.css 的 clip-row-in 对齐）。 */
const ENTERING_MS = 360;

/** 缩略图缓存（id → dataURL）。条目不可变，跨实例共享；超量整体清空防无界增长。 */
const thumbCache = new Map<string, string>();
const THUMB_CACHE_CAP = 300;

async function fetchThumb(id: string): Promise<string | null> {
  const hit = thumbCache.get(id);
  if (hit !== undefined) return hit;
  const url = await invoke<string | null>("get_clipboard_thumbnail", { id }).catch(() => null);
  if (url) {
    if (thumbCache.size >= THUMB_CACHE_CAP) thumbCache.clear();
    thumbCache.set(id, url);
  }
  return url;
}

function ImageThumb({ entry, alt }: { entry: ClipboardEntry; alt: string }) {
  const [src, setSrc] = useState<string | null>(() => thumbCache.get(entry.id) ?? null);
  useEffect(() => {
    if (src) return;
    let alive = true;
    void fetchThumb(entry.id).then((u) => {
      if (alive && u) setSrc(u);
    });
    return () => {
      alive = false;
    };
  }, [entry.id, src]);
  // 用真实宽高比撑占位，缩略图到达前不跳动。
  const w = entry.image_w ?? 4;
  const h = entry.image_h ?? 3;
  return (
    <span className="clip-thumb" style={{ aspectRatio: `${Math.max(1, w)} / ${Math.max(1, h)}` }}>
      {src ? <img src={src} alt={alt} draggable={false} /> : <ImageIcon size={14} />}
    </span>
  );
}

type RowProps = {
  entry: ClipboardEntry;
  now: number;
  copied: boolean;
  /** 新到达条目（refresh diff 出的 id）：播 is-entering 入场。 */
  entering: boolean;
  /** 退场中（useDelayedRemoval）：播 is-closing 收拢淡出。 */
  removing: boolean;
  tr: (zh: string) => string;
  onRestore: (entry: ClipboardEntry) => void;
  onMenu: (e: MouseEvent, entry: ClipboardEntry) => void;
};

function ClipRow({ entry, now, copied, entering, removing, tr, onRestore, onMenu }: RowProps) {
  const isImage = entry.kind === "image";
  const isFiles = entry.kind === "files";
  const fileCount = isFiles ? filesListOf(entry).length : 0;
  const lines = isImage || isFiles ? 0 : lineCountOf(entry.text);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRestore(entry);
    }
  };
  const title = entryTitle(entry, tr);
  return (
    <div
      className={`clip-row${entry.pinned ? " is-pinned" : ""}${copied ? " is-copied" : ""}${entering ? " is-entering" : ""}${removing ? " is-closing" : ""}`}
      role="button"
      tabIndex={0}
      data-interactive
      title={isFiles ? filesListOf(entry).join("\n") : tr("点击复制到剪贴板")}
      aria-label={title}
      onClick={() => onRestore(entry)}
      onKeyDown={onKey}
      onContextMenu={(e) => onMenu(e, entry)}
    >
      <span className="clip-row-ico" aria-hidden="true">
        {isImage ? <ImageIcon size={13} /> : isFiles ? <FolderClosed size={13} /> : <ClipboardList size={13} />}
      </span>
      <div className="clip-row-main">
        {isImage ? (
          <ImageThumb entry={entry} alt={title} />
        ) : (
          <div className="clip-row-text">{entry.preview || tr("（空白）")}</div>
        )}
        <div className="clip-row-meta">
          {entry.pinned && (
            <span className="clip-row-pin" aria-label={tr("已置顶")}>
              <Pin size={10} />
            </span>
          )}
          <span>{friendlyTime(entry.created_at, now, tr)}</span>
          {isImage && (
            <span>
              {entry.image_w}×{entry.image_h}
            </span>
          )}
          {isFiles && fileCount > 0 && <span>{tr("{n} 个文件").replace("{n}", String(fileCount))}</span>}
          {!isImage && !isFiles && lines > 1 && <span>{tr("{n} 行").replace("{n}", String(lines))}</span>}
          {entry.source_app && <span className="clip-row-src">{entry.source_app}</span>}
        </div>
      </div>
      <span className="clip-row-copied" aria-hidden="true">
        <Check size={13} />
        {tr("已复制")}
      </span>
    </div>
  );
}

export function ClipboardHistoryWidget() {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const captureEnabled = useSettingsStore((s) => s.general.clipboard.enabled);
  const now = useNow(30_000).getTime();
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  /* 增量窗口（initial 30）：LIST_LIMIT=200 条 + 图片缩略图 <img> 此前一次
     全量挂载，且 useNow(30s) 周期性整列表重渲——窗口化后常驻 DOM 与重渲
     行数都随首屏规模而非历史上限走（与便签/书签/文件浏览器同范式）。 */
  const clipList = useIncrementalList(entries, { initial: 30, step: 30 });
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /* 新到达入场：load() 与上次的 id 集合做 diff，fresh id 播 is-entering
     （首次水合不播，整表开机静默入场；清除搜索后的回填属过滤切换，
     与邮件列表同语言也播入场）。 */
  const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(() => new Set());
  const knownIdsRef = useRef<Set<string> | null>(null);
  const { confirmingId: confirmClear, request: requestClear } = useConfirmAction();
  const queryRef = useRef("");
  const searchTimer = useRef<number>(0);
  const refreshTimer = useRef<number>(0);
  const desktop = isTauri();

  const load = useCallback(async () => {
    if (!desktop) {
      setHydrated(true);
      return;
    }
    const q = queryRef.current.trim();
    try {
      const list = await invoke<ClipboardEntry[]>("list_clipboard_history", {
        query: q || null,
        limit: LIST_LIMIT
      });
      // 响应到达时搜索词已变：丢弃过期结果。
      if (queryRef.current.trim() !== q) return;
      const prev = knownIdsRef.current;
      if (prev) {
        const fresh = list.filter((e) => !prev.has(e.id)).map((e) => e.id);
        if (fresh.length > 0) {
          setEnteringIds((s) => {
            const next = new Set(s);
            for (const id of fresh) next.add(id);
            return next;
          });
          for (const id of fresh) {
            safeTimeout(() => {
              setEnteringIds((s) => {
                if (!s.has(id)) return s;
                const next = new Set(s);
                next.delete(id);
                return next;
              });
            }, ENTERING_MS);
          }
        }
      }
      knownIdsRef.current = new Set(list.map((e) => e.id));
      setEntries(list);
    } catch {
      // 门控拒绝 / DB 忙：保留现有列表。
    } finally {
      setHydrated(true);
    }
  }, [desktop, safeTimeout]);

  useEffect(() => {
    void load();
    return () => {
      window.clearTimeout(searchTimer.current);
      window.clearTimeout(refreshTimer.current);
    };
  }, [load]);

  useTauriEvent("clipboard:changed", () => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
  });

  const onQuery = (v: string) => {
    setQuery(v);
    queryRef.current = v;
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
  };

  const restore = useCallback(
    (entry: ClipboardEntry) => {
      if (!desktop) return;
      void invoke<ClipboardEntry | null>("restore_clipboard_entry", { id: entry.id })
        .then(() => {
          setCopiedId(entry.id);
          safeTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), COPIED_MS);
        })
        .catch(() => {});
    },
    [desktop, safeTimeout]
  );

  const togglePin = (entry: ClipboardEntry) => {
    const next = !entry.pinned;
    // 乐观更新 + 重排（置顶在前），事件到达后以服务端为准。
    setEntries((list) => sortEntries(list.map((e) => (e.id === entry.id ? { ...e, pinned: next } : e))));
    void invoke("toggle_clipboard_pin", { id: entry.id, pinned: next }).catch(() => void load());
  };

  // 删除退场：先播 is-closing 收拢淡出（w-item-out 语言，对齐便签/书签），
  // 240ms 播完再真正落删；期间 clipboard:changed 触发的刷新会用同一 key
  // 复用 DOM 节点，动画 forwards 保持透明态，不会闪回。
  const { removingIds, begin: beginRemoval } = useDelayedRemoval((id: string) => {
    setEntries((list) => list.filter((e) => e.id !== id));
    knownIdsRef.current?.delete(id);
    thumbCache.delete(id);
    void invoke("delete_clipboard_entry", { id }).catch(() => void load());
  }, 240);

  const remove = (entry: ClipboardEntry) => beginRemoval(entry.id);

  const clearAll = () => {
    if (!requestClear("clear")) return;
    setEntries([]);
    thumbCache.clear();
    void invoke("clear_clipboard_history").catch(() => void load());
  };

  const onMenu = (e: MouseEvent, entry: ClipboardEntry) => {
    const items: ContextMenuItem[] = [
      { label: tr("复制"), icon: <Copy size={14} />, onSelect: () => restore(entry) },
      {
        label: entry.pinned ? tr("取消置顶") : tr("置顶"),
        icon: entry.pinned ? <PinOff size={14} /> : <Pin size={14} />,
        onSelect: () => togglePin(entry)
      },
      { type: "separator" },
      { label: tr("删除"), icon: <Trash2 size={14} />, danger: true, onSelect: () => remove(entry) }
    ];
    openContextMenu(e, items);
  };

  const pinnedCount = useMemo(() => entries.filter((e) => e.pinned).length, [entries]);
  const searching = query.trim().length > 0;

  return (
    <div className="clipw">
      <div className="clipw-head" data-interactive>
        <ClipboardList size={14} className="clipw-ico" />
        <span className="clipw-title">{tr("剪贴板历史")}</span>
        {entries.length > 0 && (
          <span
            className="clipw-count"
            title={pinnedCount > 0 ? tr("{n} 条置顶").replace("{n}", String(pinnedCount)) : undefined}
          >
            {entries.length}
          </span>
        )}
      </div>

      <label className="clipw-search" data-interactive>
        <Search size={13} aria-hidden="true" />
        <input
          type="text"
          value={query}
          placeholder={tr("搜索剪贴板…")}
          aria-label={tr("搜索剪贴板…")}
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              onQuery("");
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="clipw-search-clear"
            onClick={() => onQuery("")}
            aria-label={tr("清除搜索")}
            title={tr("清除搜索")}
            data-interactive
          >
            <X size={12} />
          </button>
        )}
      </label>

      {desktop && !captureEnabled && (
        <div className="clipw-notice" role="status">
          <ShieldOff size={12} />
          <span>{tr("记录已在设置中关闭，仅显示已有历史")}</span>
        </div>
      )}

      <div className="clipw-list scroll-fade-y" data-interactive ref={clipList.scrollRef}>
        {clipList.items.map((e) => (
          <ClipRow
            key={e.id}
            entry={e}
            now={now}
            copied={copiedId === e.id}
            entering={enteringIds.has(e.id)}
            removing={removingIds.has(e.id)}
            tr={tr}
            onRestore={restore}
            onMenu={onMenu}
          />
        ))}
        {clipList.remaining > 0 && (
          <button type="button" className="clipw-more" aria-live="polite" onClick={clipList.loadMore} data-interactive>
            {tr("继续滚动加载剩余 {n} 条", { n: clipList.remaining })}
          </button>
        )}
        {hydrated && entries.length === 0 && (
          <EmptyState
            icon={<ClipboardList size={22} aria-hidden="true" />}
            text={!desktop ? tr("剪贴板历史仅在桌面端可用") : searching ? tr("没有匹配的记录") : tr("暂无剪贴板记录")}
            hint={desktop && !searching ? tr("复制的文本与图片会出现在这里，点击即可再次复制") : undefined}
          />
        )}
      </div>

      <div className="clipw-foot" data-interactive>
        <span className="clipw-foot-hint">{tr("纯本地存储 · 最多 500 条 · 30 天")}</span>
        <button
          className={`clipw-clear${confirmClear ? " is-confirming" : ""}`}
          onClick={clearAll}
          disabled={entries.length === 0 || !desktop}
          title={confirmClear ? tr("再次点击确认清除") : tr("清空剪贴板历史")}
          aria-label={confirmClear ? tr("再次点击确认清除") : tr("清空剪贴板历史")}
          data-interactive
        >
          {confirmClear ? <Check size={13} /> : <Trash2 size={13} />}
          <span>{confirmClear ? tr("确认清除") : tr("清空")}</span>
        </button>
      </div>
    </div>
  );
}
