/**
 * 便签小组件：Markdown 便签（任务清单/标签/颜色/置顶/手动排序）、
 * 增量渲染长列表、软删除回收站与速记窗口联动（sync:notes 实时合并）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  Bell,
  BellRing,
  Check,
  Copy,
  Download,
  FileDown,
  GripVertical,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { copyText } from "../../lib/clipboard";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";
import {
  deleteToTrash,
  restoreFromTrash,
  purgeTrash,
  emptyTrash,
  loadTrash,
  loadNotes,
  saveNotes,
  exportNotesMarkdown,
  parseNotesImport,
  downloadTextFile,
  absorbQuickNoteOrphan,
  subscribeNotes,
  type Note,
  type TrashNote
} from "../notes-store";
import { extractTags, renderMiniMd } from "../../lib/mini-md";
import { useIncrementalList } from "../../lib/use-incremental-list";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { animDurations } from "../../lib/durations";
import { uiZoom } from "../../lib/ui-zoom";
import { promptDialog, alertDialog } from "../../components/PromptDialog";
import { parseNaturalDateTime } from "../../lib/natural-date";
import { useDelayedRemoval } from "../../lib/use-confirm-remove";
import { useNow } from "../../lib/use-now";

/** 提醒时间展示：今天/明天给时刻，其余给月日+时刻（本地时区）。 */
function fmtRemind(iso: string, tr: (s: string) => string): string {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(d);
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return hm;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `${tr("明天")} ${hm}`;
  const md = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(d);
  return `${md} ${hm}`;
}
function relTime(iso: string, tr: (s: string) => string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return tr("刚刚");
  if (mins < 60) return `${mins}${tr(" 分钟前")}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}${tr(" 小时前")}`;
  return `${Math.floor(hours / 24)}${tr(" 天前")}`;
}

/** 便签颜色调色板（id 同时是 data-color 取值）。 */
const NOTE_COLORS = [
  { id: "amber", label: "琥珀", hex: "#f59e0b" },
  { id: "green", label: "青绿", hex: "#10b981" },
  { id: "blue", label: "天蓝", hex: "#3b82f6" },
  { id: "pink", label: "樱粉", hex: "#ec4899" },
  { id: "purple", label: "黛紫", hex: "#8b5cf6" },
  { id: "gray", label: "石墨", hex: "#64748b" }
];

/** 颜色单一来源：data-color 仅作兼容标记，实际取色由 TSX 注入 --note-accent。 */
function noteAccentHex(color?: string): string | undefined {
  return color ? NOTE_COLORS.find((c) => c.id === color)?.hex : undefined;
}

/** 切换某一行的任务清单勾选状态并写回文本。 */
function toggleTaskLine(text: string, lineIndex: number): string {
  const lines = text.split("\n");
  const line = lines[lineIndex];
  if (line === undefined || !/^\s*[-*]\s+\[[ xX]\]/.test(line)) return text;
  lines[lineIndex] = line.replace(/\[[ xX]\]/, (m) => (m === "[ ]" ? "[x]" : "[ ]"));
  return lines.join("\n");
}

export function NotesWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [notes, setNotes] = useState<Note[]>(() => loadNotes(instanceId));
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // 每分钟刷新一次相对时间，避免长时间停留后显示过期的"x 分钟前"。
  const now = useNow(60_000).getTime();
  const { config } = useWidgetConfig(instanceId);
  const fontSize = (config.fontSize as string) || "medium";
  const sortBy = (config.sortBy as string) || "newest";
  const manualSort = sortBy === "manual";
  const showDate = config.showDate !== false;
  const showEmptyState = config.showEmptyState !== false;
  const showCount = config.showCount !== false;
  const showSearch = config.showSearch !== false;
  const markdown = config.markdown !== false;
  const showTagBar = config.showTagBar !== false;
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 当前打开调色板的便签 id。
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  // 组件内回收站面板。
  const [trashOpen, setTrashOpen] = useState(false);
  // 初始即读一次（此前初始空数组、只在打开面板时才加载——徽标挂载后恒不显示）。
  const [trash, setTrash] = useState<TrashNote[]>(() => loadTrash(instanceId));
  // 彻底删除 / 清空不可恢复：两段式确认（2 秒内再点才执行，超时自动退出）。
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  const [emptyConfirm, setEmptyConfirm] = useState(false);
  // 拖拽排序状态。
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // 全部标签（按便签顺序去重）。
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes) for (const t of extractTags(n.text)) set.add(t);
    return [...set].slice(0, 12);
  }, [notes]);

  const sortedNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = [...notes];
    if (q) {
      list = list.filter((n) => n.text.toLowerCase().includes(q));
    }
    if (tagFilter) {
      list = list.filter((n) => extractTags(n.text).includes(tagFilter));
    }
    list.sort((a, b) => {
      // 置顶优先，其次按所选方式排序。
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (manualSort) {
        const oa = a.order ?? Number.MAX_SAFE_INTEGER;
        const ob = b.order ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
      }
      const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return sortBy === "oldest" ? -diff : diff;
    });
    return list;
  }, [notes, sortBy, manualSort, query, tagFilter]);

  // 增量渲染：便签上百条后一次性挂载会明显拖慢首帧与每次筛选。
  // 首屏 30 条，滚到底自动补 30 条；配合 CSS content-visibility 跳过屏外行。
  const {
    items: visibleNotes,
    scrollRef,
    remaining
  } = useIncrementalList(sortedNotes, {
    initial: 30,
    step: 30
  });

  /* FLIP 置顶重排（#16）需要直接持有容器节点：包装增量列表的回调 ref，
     attach 时同步存入本地 ref，卸载时置空。 */
  const scrollNodeRef = useRef<HTMLElement | null>(null);
  const listRef = useCallback(
    (node: HTMLElement | null) => {
      scrollNodeRef.current = node;
      scrollRef(node);
    },
    [scrollRef]
  );

  useEffect(() => {
    saveNotes(instanceId, notes);
  }, [notes, instanceId]);

  /* 外部写入对账：回收站恢复便签 / 提醒到点清除 remindAt / 超上限裁剪
     都只写存储并 notifyNotesChanged；若不回读，本组件下一次任意编辑会把
     旧内存态整表覆写回去——恢复的便签被永久抹掉（双重不可逆）。内容一致
     时返回 cur 短路，避免自身保存触发的通知形成回写循环。 */
  useEffect(() => {
    return subscribeNotes(() => {
      setNotes((cur) => {
        const stored = loadNotes(instanceId);
        if (JSON.stringify(stored) === JSON.stringify(cur)) return cur;
        return stored;
      });
      // 回收站徽标跟随外部写入（速记/回收站恢复/其他窗口删除）一起刷新。
      setTrash(loadTrash(instanceId));
    });
  }, [instanceId]);

  // 速记兜底桶吸收：Ctrl+Alt+Q 在没有任何便签组件时写进固定桶，这里在
  // 第一块便签组件挂载时把孤儿便签搬进本实例（黑洞修复，见 notes-store）。
  useEffect(() => {
    if (absorbQuickNoteOrphan(instanceId) > 0) setNotes(loadNotes(instanceId));
  }, [instanceId]);

  // 速记窗口保存后广播 sync:notes，这里实时合并。
  useTauriEvent<{ instanceId: string; notes: Note[] }>("sync:notes", (payload) => {
    if (payload?.instanceId !== instanceId || !Array.isArray(payload.notes)) return;
    // 逐项形状过滤：畸形元素若直入 state，下方保存 effect 会把它整表覆写进
    // localStorage，污染持久层。
    const clean = payload.notes.filter(
      (n): n is Note => !!n && typeof n === "object" && typeof n.id === "string" && typeof n.text === "string"
    );
    setNotes(clean);
    setTrash(loadTrash(instanceId));
  });

  const minOrder = useMemo(() => notes.reduce((m, n) => Math.min(m, n.order ?? 0), 0), [notes]);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setNotes((n) => [
      {
        id: crypto.randomUUID(),
        text,
        updatedAt: new Date().toISOString(),
        // 手动排序时新便签放最上面（order 取当前最小值 - 1）。
        ...(manualSort ? { order: minOrder - 1 } : {})
      },
      ...n
    ]);
    setDraft("");
  };

  const startEdit = (n: Note) => {
    setEditingId(n.id);
    setEditText(n.text);
  };

  const saveEdit = (id: string) => {
    const text = editText.trim();
    setNotes((list) =>
      list.map((n) => (n.id === id ? { ...n, text: text || n.text, updatedAt: new Date().toISOString() } : n))
    );
    setEditingId(null);
  };

  // 任务清单勾选写回正文（不改 updatedAt，避免排序跳动）。
  const toggleTask = (id: string, lineIndex: number) => {
    setNotes((list) => list.map((n) => (n.id === id ? { ...n, text: toggleTaskLine(n.text, lineIndex) } : n)));
  };

  // 设置便签颜色（undefined = 恢复默认）。
  const setColor = (id: string, color: string | undefined) => {
    setNotes((list) => list.map((n) => (n.id === id ? { ...n, color, updatedAt: n.updatedAt } : n)));
    setPaletteFor(null);
  };

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async (n: Note) => {
    const ok = await copyText(n.text);
    if (ok) {
      setCopiedId(n.id);
      setCopyFailed(false);
      safeTimeout(() => setCopiedId((id) => (id === n.id ? null : id)), 1200);
    } else {
      setCopyFailed(true);
      safeTimeout(() => setCopyFailed(false), 1200);
    }
  };

  /* 删除退场：先播收拢淡出，再真正移除（进回收站 + 撤销逻辑不变）。 */
  const { removingIds, begin: beginRemoval } = useDelayedRemoval((id) => {
    const target = notes.find((n) => n.id === id);
    if (target) {
      deleteToTrash(instanceId, target);
      setUndoNote(target);
      setTrash(loadTrash(instanceId));
    }
    setNotes((list) => list.filter((n) => n.id !== id));
  }, 220);
  const remove = (id: string) => beginRemoval(id);

  // 便签删除后支持撤销：3 秒内可恢复，避免误删。
  const [undoNote, setUndoNote] = useState<Note | null>(null);
  useEffect(() => {
    if (!undoNote) return;
    safeTimeout(() => setUndoNote(null), 3000);
  }, [undoNote, safeTimeout]);
  const undoRemove = () => {
    if (!undoNote) return;
    restoreFromTrash(instanceId, undoNote.id);
    setNotes((list) => [undoNote, ...list]);
    setUndoNote(null);
  };

  const togglePin = (id: string) => {
    captureNotePositions();
    setNotes((list) => list.map((n) => (n.id === id ? { ...n, pinned: !n.pinned, updatedAt: n.updatedAt } : n)));
  };

  /* ---- 便签定时提醒（自然语言输入 → notes-reminders 到点通知）。 ---- */
  const setRemind = async (note: Note) => {
    const input = await promptDialog({
      title: tr("设置提醒"),
      initialValue: "",
      placeholder: tr("明天9点 / 周五 14:30 / 20:00")
    });
    const v = input?.trim();
    if (!v) return;
    const parsed = parseNaturalDateTime(v);
    if (!parsed) {
      void alertDialog({ title: tr("无法识别时间"), message: tr("试试「明天9点」「周五 14:30」「2小时后」这类写法") });
      return;
    }
    // updatedAt 不动：设提醒不改变便签的「最近修改」排序位置。
    setNotes((list) => list.map((x) => (x.id === note.id ? { ...x, remindAt: parsed.date.toISOString() } : x)));
  };
  const clearRemind = (id: string) => {
    setNotes((list) =>
      list.map((x) => {
        if (x.id !== id || !x.remindAt) return x;
        const { remindAt: _drop, ...rest } = x;
        void _drop;
        return rest as Note;
      })
    );
  };

  // 手动拖拽排序。以「显示顺序」（置顶优先 + order）为基准移动，
  // 落点为「拖拽项移动到目标项之前」，随后按显示顺序重写 order 序列。
  const dropOn = (targetId: string) => {
    const dragId = dragIdRef.current;
    setDragOverId(null);
    dragIdRef.current = null;
    if (!dragId || dragId === targetId) return;
    captureNotePositions();
    setNotes((list) => {
      const display = [...list].sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        const oa = a.order ?? Number.MAX_SAFE_INTEGER;
        const ob = b.order ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
      const from = display.findIndex((n) => n.id === dragId);
      const to = display.findIndex((n) => n.id === targetId);
      if (from < 0 || to < 0) return list;
      const next = [...display];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      let seq = 0;
      return next.map((n) => (n.pinned ? n : { ...n, order: seq++, updatedAt: n.updatedAt }));
    });
  };

  // 回收站面板。事件处理器里直接用当前值：updater 内嵌套 setState +
  // 同步读 localStorage 属渲染期副作用，StrictMode 下双跑重复 I/O。
  const openTrash = () => {
    const next = !trashOpen;
    setTrashOpen(next);
    if (next) {
      setTrash(loadTrash(instanceId));
      setPurgeConfirmId(null);
      setEmptyConfirm(false);
    }
  };
  const doRestore = (id: string) => {
    const restored = restoreFromTrash(instanceId, id);
    if (restored) setNotes((list) => [restored, ...list]);
    setTrash(loadTrash(instanceId));
  };
  const doPurge = (id: string) => {
    if (purgeConfirmId !== id) {
      setPurgeConfirmId(id);
      safeTimeout(() => setPurgeConfirmId((cur) => (cur === id ? null : cur)), 2000);
      return;
    }
    setPurgeConfirmId(null);
    purgeTrash(instanceId, id);
    setTrash(loadTrash(instanceId));
  };
  const doEmptyTrash = () => {
    if (!emptyConfirm) {
      setEmptyConfirm(true);
      safeTimeout(() => setEmptyConfirm(false), 2000);
      return;
    }
    setEmptyConfirm(false);
    emptyTrash(instanceId);
    setTrash([]);
  };

  // 导出 / 导入。
  const exportAll = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    downloadTextFile(`vela-notes-${stamp}.md`, exportNotesMarkdown(notes));
  };
  const exportOne = (n: Note) => {
    downloadTextFile(`vela-note-${n.id.slice(0, 8)}.md`, exportNotesMarkdown([n]));
  };
  const importRef = useRef<HTMLInputElement | null>(null);
  const importFile = (file: File) => {
    void file.text().then((raw) => {
      const imported = parseNotesImport(raw);
      if (imported.length === 0) return;
      setNotes((list) => {
        const ids = new Set(list.map((n) => n.id));
        const fresh = imported
          .filter((n) => !ids.has(n.id))
          .map((n) => ({ ...n, updatedAt: new Date().toISOString() }));
        return [...fresh, ...list];
      });
    });
  };

  /* 置顶重排 FLIP（动画机会 #16）：置顶切换前记录各便签位置，
     DOM 更新后对位移项做反向 transform 再过渡回 0 —— 元素本身
     不重挂载，位移动画连续；transform 瞬态结束于 none，符合 。 */
  const notePositions = useRef(new Map<string, number>());
  const captureNotePositions = () => {
    notePositions.current.clear();
    scrollNodeRef.current?.querySelectorAll<HTMLElement>(".widget-note").forEach((el) => {
      notePositions.current.set(el.dataset.noteId ?? "", el.getBoundingClientRect().top);
    });
  };
  useLayoutEffect(() => {
    const prev = notePositions.current;
    if (prev.size === 0) return;
    const nodes = scrollNodeRef.current?.querySelectorAll<HTMLElement>(".widget-note") ?? [];
    /* dy 来自两次 gBCR 的视觉差，而 transform 写在布局层——先除回
       uiZoom（lib/anim 的 flipReorder 同款换算），否则缩放 ≠100% 时回弹
       过冲 zoom 倍。 */
    const z = uiZoom();
    for (const el of nodes) {
      const before = prev.get(el.dataset.noteId ?? "");
      if (before == null) continue;
      const dy = (before - el.getBoundingClientRect().top) / z;
      if (Math.abs(dy) < 2) continue;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetHeight;
      /* 时长走 --dur-spatial-fast 同源档（原裸 .26s，标准档 350ms 档内） */
      el.style.transition = `transform ${Math.round(animDurations().spatialFastMs)}ms var(--ease-out)`;
      el.style.transform = "";
      el.addEventListener(
        "transitionend",
        () => {
          el.style.transition = "";
        },
        { once: true }
      );
    }
    prev.clear();
  }, [sortedNotes, scrollRef]);

  return (
    <div className={`widget-notes font-${fontSize}`}>
      {showSearch && (
        <div className="widget-notes-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("搜索 {n} 条便签…", { n: notes.length })}
            data-interactive
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label={tr("清除搜索")}
              className="widget-notes-search-clear"
              data-interactive
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {showTagBar && allTags.length > 0 && (
        <div className="widget-notes-tags" role="group" aria-label={tr("标签筛选")}>
          {allTags.map((t) => (
            <button
              key={t}
              className={`widget-notes-tag${tagFilter === t ? " active" : ""}`}
              onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
              title={tagFilter === t ? tr("取消按此标签筛选") : tr("按此标签筛选")}
              data-interactive
            >
              #{t}
            </button>
          ))}
        </div>
      )}
      <div className="widget-notes-input">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            /* IME 组合期的 Enter 是「确认候选词」不是
               提交（WidgetCanvas.tsx 同款守卫），漏判会把拼音串存成便签。 */
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          placeholder={tr("记点什么…（Enter 保存，Shift+Enter 换行）")}
          rows={2}
          data-interactive
        />
        <button onClick={add} aria-label={tr("添加便签")} data-interactive>
          <Plus size={15} />
        </button>
      </div>
      {manualSort && notes.length > 1 && <div className="widget-notes-drag-hint">{tr("按住便签拖动即可调整顺序")}</div>}
      <div className="widget-notes-list" ref={listRef}>
        {showEmptyState && sortedNotes.length === 0 && (
          <EmptyState
            text={query ? tr("没有匹配的便签") : tr("暂无便签")}
            hint={query ? undefined : tr("新建一张便签开始记录")}
            compact
          />
        )}
        {visibleNotes.map((n, ni) => (
          <div
            className={`widget-note${n.pinned ? " custom-pinned" : ""}${removingIds.has(n.id) ? " is-closing" : ""}${dragOverId === n.id ? " drag-over" : ""}`}
            key={n.id}
            data-note-id={n.id}
            data-color={n.color}
            style={{ "--sti": ni, "--note-accent": noteAccentHex(n.color) } as React.CSSProperties}
            draggable={manualSort}
            onDragStart={() => {
              dragIdRef.current = n.id;
            }}
            onDragOver={(e) => {
              if (manualSort && dragIdRef.current) {
                e.preventDefault();
                setDragOverId(n.id);
              }
            }}
            onDragLeave={() => setDragOverId((cur) => (cur === n.id ? null : cur))}
            onDrop={(e) => {
              if (manualSort) {
                e.preventDefault();
                dropOn(n.id);
              }
            }}
            onDragEnd={() => {
              dragIdRef.current = null;
              setDragOverId(null);
            }}
          >
            {editingId === n.id ? (
              <div className="widget-note-edit">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      saveEdit(n.id);
                    }
                  }}
                  rows={2}
                  autoFocus
                  data-interactive
                />
                <button onClick={() => saveEdit(n.id)} aria-label={tr("保存")} data-interactive>
                  <Check size={13} />
                </button>
              </div>
            ) : (
              <>
                {manualSort && (
                  <span className="widget-note-drag" aria-hidden="true">
                    <GripVertical size={12} />
                  </span>
                )}
                <span className="widget-note-text">
                  {markdown
                    ? renderMiniMd(n.text, {
                        onTagClick: (t) => setTagFilter((cur) => (cur === t ? null : t)),
                        onToggleTask: (lineIndex) => toggleTask(n.id, lineIndex)
                      })
                    : n.text}
                </span>
                {paletteFor === n.id && (
                  <div className="widget-note-palette" role="menu">
                    <button
                      className="widget-note-swatch none"
                      onClick={() => setColor(n.id, undefined)}
                      title={tr("默认")}
                      data-interactive
                    />
                    {NOTE_COLORS.map((c) => (
                      <button
                        key={c.id}
                        className={`widget-note-swatch${n.color === c.id ? " active" : ""}`}
                        style={{ "--swatch": c.hex } as React.CSSProperties}
                        onClick={() => setColor(n.id, c.id)}
                        title={tr(c.label)}
                        data-interactive
                      />
                    ))}
                  </div>
                )}
                <div className="widget-note-meta">
                  {showDate && <span className="widget-note-time">{relTime(n.updatedAt, tr, now)}</span>}
                  {n.remindAt ? (
                    <button
                      className="widget-note-btn active"
                      onClick={() => clearRemind(n.id)}
                      aria-label={tr("取消提醒")}
                      title={`${tr("提醒时间：")}${fmtRemind(n.remindAt, tr)}（${tr("点击取消")}）`}
                      data-interactive
                    >
                      <BellRing size={12} />
                    </button>
                  ) : (
                    <button
                      className="widget-note-btn"
                      onClick={() => void setRemind(n)}
                      aria-label={tr("设置提醒")}
                      title={tr("设置提醒")}
                      data-interactive
                    >
                      <Bell size={12} />
                    </button>
                  )}
                  <button
                    className={`widget-note-btn${n.pinned ? " pinned" : ""}`}
                    onClick={() => togglePin(n.id)}
                    aria-label={n.pinned ? tr("取消置顶") : tr("置顶")}
                    data-interactive
                    title={n.pinned ? tr("取消置顶") : tr("置顶")}
                  >
                    {n.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <button
                    className={`widget-note-btn${paletteFor === n.id ? " active" : ""}`}
                    onClick={() => setPaletteFor((cur) => (cur === n.id ? null : n.id))}
                    aria-label={tr("颜色")}
                    title={tr("便签颜色")}
                    data-interactive
                  >
                    <Palette size={12} />
                  </button>
                  <button
                    className={`widget-note-btn${copiedId === n.id ? " copied" : ""}`}
                    onClick={() => void copy(n)}
                    aria-label={tr("复制")}
                    data-interactive
                    title={copiedId === n.id ? tr("已复制") : tr("复制文本")}
                  >
                    {copiedId === n.id ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                  <button
                    className="widget-note-btn"
                    onClick={() => startEdit(n)}
                    aria-label={tr("编辑")}
                    data-interactive
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="widget-note-btn"
                    onClick={() => exportOne(n)}
                    aria-label={tr("导出此条")}
                    title={tr("导出为 Markdown")}
                    data-interactive
                  >
                    <FileDown size={12} />
                  </button>
                  <button
                    className="widget-note-btn danger"
                    onClick={() => remove(n.id)}
                    aria-label={tr("删除")}
                    data-interactive
                    title={tr("删除便签")}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {remaining > 0 && (
          <div className="widget-list-more" aria-live="polite">
            {tr("继续滚动加载剩余 {n} 条", { n: remaining })}
          </div>
        )}
      </div>
      {undoNote && (
        <div className="widget-notes-undo">
          <span>{tr("已移入回收站")}</span>
          <button onClick={undoRemove} data-interactive>
            {tr("撤销")}
          </button>
        </div>
      )}

      {/* 组件内回收站 */}
      {trashOpen && (
        <div className="widget-notes-trash">
          <div className="widget-notes-trash-head">
            <span>
              {tr("回收站")} · {trash.length}
            </span>
            {trash.length > 0 && (
              <button className={emptyConfirm ? "confirming" : undefined} onClick={doEmptyTrash} data-interactive>
                {emptyConfirm ? tr("确定清空？") : tr("清空")}
              </button>
            )}
          </div>
          {trash.length === 0 ? (
            <div className="widget-notes-trash-empty">{tr("回收站为空")}</div>
          ) : (
            <>
              {trash.slice(0, 12).map((t) => (
                <div className="widget-notes-trash-row" key={t.id}>
                  <span className="widget-notes-trash-text">{t.text.slice(0, 60) || tr("（空便签）")}</span>
                  <button title={tr("恢复")} aria-label={tr("恢复")} onClick={() => doRestore(t.id)} data-interactive>
                    <ArchiveRestore size={12} />
                  </button>
                  <button
                    className={`danger${purgeConfirmId === t.id ? " confirming" : ""}`}
                    title={purgeConfirmId === t.id ? tr("再次点击确认删除") : tr("彻底删除")}
                    aria-label={purgeConfirmId === t.id ? tr("再次点击确认删除") : tr("彻底删除")}
                    onClick={() => doPurge(t.id)}
                    data-interactive
                  >
                    {purgeConfirmId === t.id ? <X size={12} /> : <Trash2 size={12} />}
                  </button>
                </div>
              ))}
              {/* 12 条后面还有时给出余量提示——静默截断会让后面的便签看似不存在。 */}
              {trash.length > 12 && <div className="widget-notes-trash-empty">+{trash.length - 12} …</div>}
            </>
          )}
        </div>
      )}

      <div className="widget-notes-toolbar">
        <button
          className={`widget-notes-tool${trashOpen ? " active" : ""}`}
          onClick={openTrash}
          title={tr("回收站")}
          aria-label={tr("回收站")}
          data-interactive
        >
          <Trash2 size={12} />
          {trash.length > 0 && <span className="widget-notes-tool-badge">{trash.length}</span>}
        </button>
        <button
          className="widget-notes-tool"
          onClick={exportAll}
          title={tr("导出全部便签")}
          aria-label={tr("导出全部便签")}
          data-interactive
        >
          <Download size={12} />
        </button>
        <button
          className="widget-notes-tool"
          onClick={() => importRef.current?.click()}
          title={tr("导入便签")}
          aria-label={tr("导入便签")}
          data-interactive
        >
          <Upload size={12} />
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".md,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importFile(f);
            e.target.value = "";
          }}
        />
        <span className="widget-notes-meta">
          {copyFailed ? tr("复制失败，请手动复制") : showCount ? `${notes.length}${tr(" 条便签")}` : ""}
        </span>
      </div>
    </div>
  );
}
