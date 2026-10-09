/**
 * 书签小组件：分组/置顶/搜索（拼音首字母）/拖拽排序的书签管理；
 * 数据存 localStorage 并进备份镜像，支持浏览器书签 HTML 导入。
 */
import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, PanelTop, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useWidgetConfig } from "../widget-config";
import { useT } from "../../i18n-lite";
import { persistMirrored } from "../../lib/local-backup";
import { useIncrementalList } from "../../lib/use-incremental-list";
import { invoke, isTauri } from "../../lib/tauri";
import { copyText } from "../../lib/clipboard";
import { openContextMenu } from "../../components/ContextMenu";
import { EmptyState } from "../../components/ui/EmptyState";
import { flipReorder } from "../../lib/anim";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useConfirmAction, useDelayedRemoval } from "../../lib/use-confirm-remove";

type Bookmark = { id: string; name: string; url: string; group?: string; order?: number };

const bookmarkKey = (instanceId: string) => `focus-desk.bookmarks.${instanceId}`;

const AVATAR_PALETTES = [
  ["#5c8df6", "#3f6fe0"],
  ["#4fc3f7", "#2f9ed8"],
  ["#7c8cf8", "#5a6ae0"],
  ["#38bdf8", "#0ea5e9"],
  ["#f59e0b", "#d97706"],
  ["#34d399", "#10b981"],
  ["#f472b6", "#ec4899"],
  ["#a78bfa", "#8b5cf6"]
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function initial(name: string): string {
  const t = name.trim();
  return t.charAt(0).toUpperCase() || "?";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const DEFAULTS: Bookmark[] = [
  { id: "1", name: "Google", url: "https://www.google.com" },
  { id: "2", name: "GitHub", url: "https://github.com" },
  { id: "3", name: "Bilibili", url: "https://www.bilibili.com" },
  { id: "4", name: "知乎", url: "https://www.zhihu.com" }
];

function load(instanceId: string): Bookmark[] {
  try {
    const raw = localStorage.getItem(bookmarkKey(instanceId));
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Bookmark[]) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** 解析浏览器导出的 Netscape 书签 HTML（Chrome/Edge/Firefox 通用格式）。 */
// 被 notes-store.test.ts 复用，需保留导出；非组件导出与 Fast Refresh 冲突，故显式豁免。
// eslint-disable-next-line react-refresh/only-export-components
export function parseNetscapeBookmarks(html: string): Bookmark[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: Bookmark[] = [];
  const push = (a: Element, group: string) => {
    const url = a.getAttribute("href") || "";
    if (!/^https?:\/\//.test(url)) return;
    out.push({
      id: crypto.randomUUID(),
      name: (a.textContent || "").trim() || hostOf(url) || url,
      url,
      group: group || undefined
    });
  };
  const walk = (dl: Element, group: string) => {
    let el: Element | null = dl.firstElementChild;
    while (el) {
      if (el.tagName === "DT") {
        const a = el.querySelector(":scope > a[href]");
        if (a) {
          push(a, group);
        } else {
          const h3 = el.querySelector(":scope > h3");
          if (h3) {
            // Netscape 格式中文件夹的 <DL> 通常是 <DT><> 的后续兄弟节点，
            // 但部分解析器（DOMParser 的 HTML 容错）会把它挪成子节点——两处都找。
            let sub: Element | null = el.querySelector(":scope > dl");
            if (!sub) {
              let sib: Element | null = el.nextElementSibling;
              while (sib && sib.tagName !== "DL") sib = sib.nextElementSibling;
              sub = sib;
            }
            if (sub) walk(sub, (h3.textContent || "").trim() || group);
          }
        }
      } else if (el.tagName === "DL") {
        walk(el, group);
      }
      el = el.nextElementSibling;
    }
  };
  const root = doc.querySelector("dl");
  if (root) walk(root, "");
  return out;
}

/** favicon 双源回退（DuckDuckGo → Google s2 → 首字母头像）。 */
function Favicon({ url, name }: { url: string; name: string }) {
  const [stage, setStage] = useState(0);
  const host = hostOf(url);
  const [c1, c2] = AVATAR_PALETTES[hashName(name) % AVATAR_PALETTES.length];
  if (stage >= 2 || !host) {
    return (
      <span className="bm-avatar" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
        {initial(name)}
      </span>
    );
  }
  const src =
    stage === 0
      ? `https://icons.duckduckgo.com/ip3/${host}.ico`
      : `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  return <img className="bm-favicon" src={src} alt="" onError={() => setStage((s) => s + 1)} loading="lazy" />;
}

export function BookmarksWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [items, setItems] = useState<Bookmark[]>(() => load(instanceId));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [group, setGroup] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editGroup, setEditGroup] = useState("");
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const dragIdRef = useRef<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const { config } = useWidgetConfig(instanceId);
  const sortBy = (config.sortBy as string) || "newest";
  const layout = (config.layout as string) || "list";
  const manualSort = sortBy === "manual";
  const showFavicon = config.showFavicon !== false;
  const showSearch = config.showSearch !== false;

  // 搜索过滤（名称 / 网址 / 分组）。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (b) =>
        b.name.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || (b.group ?? "").toLowerCase().includes(q)
    );
  }, [items, query]);

  const sortedItems = useMemo(() => {
    const list = [...filtered];
    if (manualSort) {
      list.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
    } else if (sortBy === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      // "newest" — id 以毫秒时间戳开头（旧数据是纯时间戳，新数据带随机后缀防
      // 同毫秒撞 id），按数值前缀倒序；localeCompare 整串比较在长度不等时会错序。
      const stamp = (id: string) => parseInt(id, 10) || 0;
      list.sort((a, b) => stamp(b.id) - stamp(a.id));
    }
    return list;
  }, [filtered, sortBy, manualSort]);

  // 增量渲染：书签导入后常有上百条，首屏只挂 40 条，滚动补齐。
  const {
    items: visibleItems,
    scrollRef,
    remaining
  } = useIncrementalList(sortedItems, {
    initial: 40,
    step: 40
  });

  // 分组渲染（手动排序时不分组，避免拖拽与分组头互相干扰）。
  const grouped = useMemo(() => {
    if (manualSort) return null;
    const ungrouped: Bookmark[] = [];
    const map = new Map<string, Bookmark[]>();
    for (const b of sortedItems) {
      if (!b.group) ungrouped.push(b);
      else {
        const arr = map.get(b.group) ?? [];
        arr.push(b);
        map.set(b.group, arr);
      }
    }
    const groups = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { ungrouped, groups };
  }, [sortedItems, manualSort]);

  const allGroups = useMemo(() => {
    const set = new Set<string>();
    for (const b of items) if (b.group) set.add(b.group);
    return [...set];
  }, [items]);

  // 增量窗口（分组分支）：分组渲染此前绕过 useIncrementalList，导入上百条书签
  // 时整组全量挂载导致首帧卡死。把「展开态」内容按显示顺序摊平后走同一套窗口，
  // 渲染时再按分组边界从窗口切片还原；折叠组不占窗口预算。展开/折叠会改变
  // 摊平序列，hook 按总数变化自动重置回首屏——与切换筛选同语义。
  const expandedFlat = useMemo(() => {
    if (!grouped) return [];
    const out = [...grouped.ungrouped];
    for (const [g, list] of grouped.groups) {
      if (!collapsedGroups.has(g)) out.push(...list);
    }
    return out;
  }, [grouped, collapsedGroups]);

  const groupedWindow = useIncrementalList(expandedFlat, { initial: 40, step: 40 });

  const groupedSections = useMemo(() => {
    if (!grouped) return null;
    const q = groupedWindow.items;
    let idx = 0;
    const ungrouped = q.slice(0, Math.min(grouped.ungrouped.length, q.length));
    idx += ungrouped.length;
    const groups = grouped.groups.map(([g, list]) => {
      if (collapsedGroups.has(g)) return { g, total: list.length, shown: list };
      const shown = q.slice(idx, idx + list.length);
      idx += shown.length;
      return { g, total: list.length, shown };
    });
    return { ungrouped, groups };
  }, [grouped, groupedWindow.items, collapsedGroups]);

  const persist = (next: Bookmark[]) => {
    setItems(next);
    // persistMirrored：写入 + 防抖镜像同步，批量导入时只落一次整表。
    persistMirrored(bookmarkKey(instanceId), JSON.stringify(next));
  };

  // 正则加 i 标志——`HTTP://example.com` 此前判不中协议头，被拼成
  // `https://HTTP://example.com` 坏链。
  const normalizeUrl = (raw: string) => (/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);

  // Tauri WebView 会拦截 <a target="_blank">（新窗口被吞或替换整个应用页面），
  // 因此桌面端必须走 Rust 侧 open_path 用系统默认浏览器打开；浏览器开发模式
  // 回退到 window.open。
  /** 仅放行 http(s)（外加 about:blank#blocked 这类惰性占位）。书签可经
   *  .url 快捷方式导入（URL= 行内容不受控），javascript:/data: 等方案若进了
   *  href，中键 / 右键“打开链接”会绕过 onClick 拦截触发原生导航。 */
  const safeHref = (url: string): string => {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? url : "javascript:void(0)";
    } catch {
      return "javascript:void(0)";
    }
  };

  const openBookmark = (url: string) => {
    if (safeHref(url) === "javascript:void(0)") return;
    if (isTauri()) {
      // 打开失败不再空吞——点了没反应且无提示，用户无从判断是链接坏了
      // 还是没点上。复用现有 error 通道 + 3s 自动清除（与导入失败提示同款）。
      void invoke("open_path", { path: url }).catch(() => {
        setError(tr("打开失败，请检查链接"));
        safeTimeout(() => setError(""), 3000);
      });
    } else {
      window.open(url, "_blank", "noreferrer");
    }
  };

  const add = () => {
    if (!name.trim() || !url.trim()) {
      setError(tr("请填写名称和网址"));
      return;
    }
    persist([
      ...items,
      {
        // 时间戳前缀保住"最新优先"排序，随机后缀杜绝同毫秒连续添加撞 id（重复 key）。
        id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        name: name.trim(),
        url: normalizeUrl(url.trim()),
        group: group.trim() || undefined,
        ...(manualSort ? { order: items.length } : {})
      }
    ]);
    setName("");
    setUrl("");
    setGroup("");
    setError("");
    setAdding(false);
  };

  const startEdit = (b: Bookmark) => {
    setEditingId(b.id);
    setEditName(b.name);
    setEditUrl(b.url.replace(/^https?:\/\//, ""));
    setEditGroup(b.group ?? "");
    setError("");
  };

  const saveEdit = () => {
    if (!editName.trim() || !editUrl.trim()) {
      setError(tr("名称和网址不能为空"));
      return;
    }
    persist(
      items.map((b) =>
        b.id === editingId
          ? { ...b, name: editName.trim(), url: normalizeUrl(editUrl.trim()), group: editGroup.trim() || undefined }
          : b
      )
    );
    setEditingId(null);
    setError("");
  };

  /* 删除退场：先播收拢淡出，再真正移除（时长由 hook 按 --dur-fx 运行时派生，
     写死 220ms 不随动效速度档缩放）。 */
  const { confirmingId: confirmDeleteId, request: confirmRequest } = useConfirmAction();
  const { removingIds, begin: beginRemoval } = useDelayedRemoval((id) => persist(items.filter((b) => b.id !== id)));
  const remove = (id: string) => {
    if (confirmRequest(id)) beginRemoval(id);
  };

  // 手动拖拽排序（以显示顺序为基准重写 order）。
  // 落位用 FLIP 过渡回弹，替代此前的瞬间跳变。
  const reorderManual = (from: number, to: number, container: HTMLElement | null) => {
    if (from < 0 || to < 0 || from === to || from >= items.length || to >= items.length) return;
    const display = [...items].sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    );
    const next = [...display];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const commit = () => persist(next.map((b, i) => ({ ...b, order: i })));
    if (container) flipReorder(container, ".bm-item", commit);
    else commit();
  };

  const dropOn = (targetId: string, container: HTMLElement | null) => {
    const dragId = dragIdRef.current;
    dragIdRef.current = null;
    if (!dragId || dragId === targetId) return;
    const display = [...items].sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    );
    const from = display.findIndex((b) => b.id === dragId);
    const to = display.findIndex((b) => b.id === targetId);
    reorderManual(from, to, container);
  };

  // 键盘替代——书签行聚焦后 Alt+↑/↓ 移动顺序（对齐 TodayTasksPanel）。
  const moveBookmark = (id: string, dir: -1 | 1, container: HTMLElement | null) => {
    const display = [...items].sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    );
    const from = display.findIndex((b) => b.id === id);
    reorderManual(from, from + dir, container);
  };

  // 导入浏览器书签 HTML（按 URL 去重后合并）。
  const importHtml = (file: File) => {
    void file.text().then((html) => {
      const imported = parseNetscapeBookmarks(html);
      if (imported.length === 0) {
        setError(tr("未识别到书签（请选择浏览器导出的 HTML 文件）"));
        safeTimeout(() => setError(""), 3000);
        return;
      }
      const existing = new Set(items.map((b) => b.url));
      const fresh = imported.filter((b) => !existing.has(b.url));
      const base = items.length;
      persist([...items, ...fresh.map((b, i) => ({ ...b, order: base + i }))]);
      // 导入成功走 success 语义（此前复用 .bm-error 红色，语义误用）。
      setNotice(
        tr("已导入 {n} 条书签", { n: fresh.length }) +
          (imported.length - fresh.length > 0 ? tr("（跳过重复 {k} 条）", { k: imported.length - fresh.length }) : "")
      );
      safeTimeout(() => setNotice(""), 4000);
    });
  };

  // 分组折叠。
  const toggleGroup = (g: string) => {
    setCollapsedGroups((s) => {
      const nx = new Set(s);
      if (nx.has(g)) nx.delete(g);
      else nx.add(g);
      return nx;
    });
  };

  const renderItem = (b: Bookmark) => {
    if (editingId === b.id) {
      return (
        <div className="bm-form bm-edit-form" key={b.id}>
          <input
            placeholder={tr("名称")}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            /* IME 组合期 Enter（确认候选词）不当作提交。 */
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveEdit()}
            autoFocus
            data-interactive
          />
          <input
            placeholder={tr("网址")}
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveEdit()}
            data-interactive
          />
          <input
            list="bm-group-list"
            placeholder={tr("分组（可选）")}
            value={editGroup}
            onChange={(e) => setEditGroup(e.target.value)}
            data-interactive
          />
          {error && <div className="bm-error">{error}</div>}
          <div className="bm-form-actions">
            <button className="bm-save" onClick={saveEdit} data-interactive>
              <Check size={13} />
              {tr("保存")}
            </button>
            <button
              className="bm-cancel"
              onClick={() => {
                setEditingId(null);
                setError("");
              }}
              aria-label={tr("取消")}
              data-interactive
            >
              <X size={13} />
            </button>
          </div>
        </div>
      );
    }
    return (
      <div
        className={`bm-item${confirmDeleteId === b.id ? " confirm" : ""}${removingIds.has(b.id) ? " is-closing" : ""}`}
        key={b.id}
        draggable={manualSort}
        onDragStart={() => {
          dragIdRef.current = b.id;
        }}
        onDragOver={(e) => {
          if (manualSort && dragIdRef.current) e.preventDefault();
        }}
        onDrop={(e) => {
          if (manualSort) {
            e.preventDefault();
            dropOn(b.id, e.currentTarget.parentElement);
          }
        }}
        onKeyDown={(e) => {
          if (!manualSort || !e.altKey) return;
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          moveBookmark(b.id, e.key === "ArrowUp" ? -1 : 1, e.currentTarget.parentElement);
        }}
        onDragEnd={() => {
          dragIdRef.current = null;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // 右键就地操作。
          openContextMenu(e, [
            { label: tr("打开链接"), icon: <ExternalLink size={13} />, onSelect: () => openBookmark(b.url) },
            // [WEB-PREVIEW]：应用内浮层预览——查完文档就回来的路径不断。
            {
              label: tr("在浮层中打开"),
              icon: <PanelTop size={13} />,
              onSelect: () => void invoke("open_web_preview", { url: b.url }).catch(() => {})
            },
            { label: tr("复制链接"), icon: <Check size={13} />, onSelect: () => void copyText(b.url) },
            { type: "separator" },
            { label: tr("编辑"), icon: <Pencil size={13} />, onSelect: () => startEdit(b) },
            { label: tr("删除"), danger: true, icon: <Trash2 size={13} />, onSelect: () => remove(b.id) }
          ]);
        }}
      >
        <a
          href={safeHref(b.url)}
          onClick={(e) => {
            e.preventDefault();
            openBookmark(b.url);
          }}
          rel="noreferrer"
          title={b.url}
          data-interactive
        >
          {showFavicon ? <Favicon url={b.url} name={b.name} /> : null}
          <span>{b.name}</span>
          <ExternalLink size={12} />
        </a>
        <button
          className="bm-edit"
          onClick={() => startEdit(b)}
          aria-label={tr("编辑")}
          title={tr("编辑书签")}
          data-interactive
        >
          <Pencil size={12} />
        </button>
        <button
          className={`bm-remove${confirmDeleteId === b.id ? " danger" : ""}`}
          onClick={() => remove(b.id)}
          aria-label={tr("删除")}
          title={confirmDeleteId === b.id ? tr("再次点击确认删除") : tr("删除书签")}
          data-interactive
        >
          {confirmDeleteId === b.id ? <span className="bm-confirm">{tr("确认")}</span> : <X size={12} />}
        </button>
      </div>
    );
  };

  // 分组 / 平铺两条分支共用一个滚动容器，但各自的增量窗口需要各自接管
  // scroll 监听与「剩余条数」提示。
  const activeScrollRef = grouped ? groupedWindow.scrollRef : scrollRef;
  const activeRemaining = grouped ? groupedWindow.remaining : remaining;

  return (
    <div className="bm">
      <datalist id="bm-group-list">
        {allGroups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <div className="bm-toolbar">
        {showSearch && (
          <div className="bm-search">
            <Search size={12} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("搜索书签…")}
              data-interactive
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label={tr("清除")} className="bm-search-clear" data-interactive>
                <X size={11} />
              </button>
            )}
          </div>
        )}
        <button
          className="bm-import"
          onClick={() => importRef.current?.click()}
          aria-label={tr("导入浏览器书签 HTML")}
          title={tr("导入浏览器书签 HTML")}
          data-interactive
        >
          <Upload size={12} />
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".html,.htm"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importHtml(f);
            e.target.value = "";
          }}
        />
      </div>
      {!adding ? (
        <button className="bm-add" onClick={() => setAdding(true)} data-interactive>
          <Plus size={14} />
          {tr("添加书签")}
        </button>
      ) : (
        <div className="bm-form">
          <input
            placeholder={tr("名称")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
            autoFocus
            data-interactive
          />
          <input
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
            data-interactive
          />
          <input
            list="bm-group-list"
            placeholder={tr("分组（可选）")}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
            data-interactive
          />
          {error && <div className="bm-error">{error}</div>}
          <div className="bm-form-actions">
            <button className="bm-save" onClick={add} data-interactive>
              {tr("保存")}
            </button>
            <button
              className="bm-cancel"
              onClick={() => {
                setAdding(false);
                setError("");
              }}
              aria-label={tr("取消")}
              data-interactive
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      {error && !adding && <div className="bm-error">{error}</div>}
      {notice && !adding && <div className="bm-ok">{notice}</div>}
      <div className={`bm-list bm-${layout}`} ref={activeScrollRef}>
        {sortedItems.length === 0 && !adding && (
          <EmptyState
            text={query ? tr("没有匹配的书签") : tr("暂无书签")}
            hint={query ? undefined : tr("点击上方添加")}
            compact
          />
        )}
        {groupedSections ? (
          <>
            {groupedSections.ungrouped.map(renderItem)}
            {groupedSections.groups.map(({ g, total, shown }, gi) => (
              <div className="bm-group" key={g}>
                <button
                  className="bm-group-head"
                  onClick={() => toggleGroup(g)}
                  aria-expanded={!collapsedGroups.has(g)}
                  aria-controls={`bm-group-${instanceId}-${gi}`}
                  data-interactive
                >
                  <ChevronDown size={12} className={`bm-group-chevron${collapsedGroups.has(g) ? " collapsed" : ""}`} />
                  <span>{g}</span>
                  <span className="bm-group-count">{total}</span>
                </button>
                <div className="bm-group-body" id={`bm-group-${instanceId}-${gi}`}>
                  {!collapsedGroups.has(g) && shown.map(renderItem)}
                </div>
              </div>
            ))}
          </>
        ) : (
          visibleItems.map(renderItem)
        )}
        {activeRemaining > 0 && (
          <div className="widget-list-more" aria-live="polite" key={activeRemaining}>
            {tr("继续滚动加载剩余 {n} 条", { n: activeRemaining })}
          </div>
        )}
      </div>
      {manualSort && items.length > 1 && <div className="bm-manual-hint">{tr("按住书签拖动可调整顺序")}</div>}
    </div>
  );
}
