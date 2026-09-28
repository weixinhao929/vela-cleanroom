/* eslint-disable react-refresh/only-export-components */
/**
 * 文件夹悬浮预览小窗（DeskOrder 借鉴 #13）：快捷方式组件里的文件夹条目
 * 单击不再跳资源管理器，而是就地弹出图标网格浮层——不离开桌面即可浏览、
 * 下钻子文件夹、打开文件；「在资源管理器中打开」保留在浮层头部与条目右键。
 *
 * 定位（DeskOrder ComputePosAndAnchor 的翻侧策略）：锚定条目矩形，优先向
 * 右展开，右侧放不下翻到左侧，底部越界贴底钳制；打开动画从靠锚点一侧生长。
 * 纯函数 placeFolderPopup 便于单测。
 *
 * 点击穿透：容器 Portal 到 body 且整体 data-interactive；.folder-popup 同时
 * 列入 useClickThrough 的 OVERLAY_SELECTOR——打开期间整窗可交互，外点才能被
 * 捕获用于关闭（与 wcfg-popover / 右键菜单同语义）。
 *
 * 竞态防护（DeskOrder token 世代校验的等价简化）：
 *  - 目录加载世代号守卫：快速下钻时慢请求不得覆盖新目录结果；
 *  - 关闭动画 160ms 后才回调 onClose，期间重复关闭幂等；父组件用 key 换弹
 *    层（换目录）时本实例卸载、关闭计时器随之清除，不会误关后来者。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowUp, File, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useT } from "../../i18n-lite";
import { animDurations } from "../../lib/durations";
import type { PopoverAnchor } from "../WidgetConfigPopover";

type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  modified: string | null;
};

/** 最多渲染的条目数 / 提取真实图标的条目数：映射整盘这类极端目录时保底。 */
const DISPLAY_LIMIT = 200;
const ICON_LIMIT = 120;
/** 图标提取的分批并发：一次压太多 SHGetFileInfoW 调用会卡 IPC 通道。 */
const ICON_BATCH = 6;

const MARGIN = 10;
const GAP = 8;

export type FolderPopupProps = {
  /** 初始目录（真实路径，非 shell: 位置）。 */
  path: string;
  /** 锚定条目矩形（视口 CSS 像素，getBoundingClientRect 直取）。 */
  anchor: PopoverAnchor;
  onClose: () => void;
};

type Placement = { left: number; top: number; side: "left" | "right" };

/**
 * 计算浮层位置：向右展开优先，右缘放不下翻到锚点左侧；纵向顶对齐锚点、
 * 底部越界贴底钳制；两轴最终都钳进视口留白内。纯函数便于单测。
 */
export function placeFolderPopup(
  anchor: PopoverAnchor,
  size: { w: number; h: number },
  viewport: { w: number; h: number }
): Placement {
  let left = anchor.x + anchor.w + GAP;
  let side: "left" | "right" = "right";
  if (left + size.w > viewport.w - MARGIN) {
    left = anchor.x - size.w - GAP;
    side = "left";
  }
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewport.w - size.w - MARGIN));
  let top = anchor.y;
  if (top + size.h > viewport.h - MARGIN) top = Math.max(MARGIN, viewport.h - size.h - MARGIN);
  return { left, top, side };
}

export type Crumb = { name: string; path: string; current: boolean };

/**
 * 面包屑段：深路径只保留
 * 最后 keep 段（更早的折叠为「…」），点击段与下钻同走 navigate——返回栈语义
 * 不变（祖先也在栈上，返回逐步回退）。路径用 "/" 逐段累积重建（Windows 侧
 * 接受正斜杠）；UNC 根（\\server\share）在此场景（快捷方式指向的普通文件夹）
 * 不多见，不做专门处理。纯函数便于单测。
 */
export function breadcrumbSegments(dir: string, keep = 3): { items: Crumb[]; truncated: boolean } {
  const segs = dir.split(/[\\/]+/).filter(Boolean);
  const total = segs.length;
  const start = Math.max(0, total - keep);
  const items: Crumb[] = [];
  let acc = "";
  segs.forEach((name, i) => {
    acc = i === 0 ? name : `${acc}/${name}`;
    if (i >= start) items.push({ name, path: acc, current: i === total - 1 });
  });
  return { items, truncated: start > 0 };
}

/** 排序：目录在前，组内按系统区域感知的名称序（与文件组件一致）。 */
function sortEntries(list: FileEntry[]): FileEntry[] {
  return [...list].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

export function FolderPopup({ path, anchor, onClose }: FolderPopupProps) {
  const tr = useT();
  /* ---- 导航：当前目录 + 历史栈（下钻 / 返回 / 上一级） ---- */
  const [dir, setDir] = useState(path);
  const [stack, setStack] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const dirRef = useRef(dir);
  dirRef.current = dir;
  const navigate = useCallback((next: string) => {
    setStack((s) => [...s, dirRef.current]);
    setDir(next);
  }, []);
  const goBack = () => {
    setStack((s) => {
      if (s.length === 0) return s;
      setDir(s[s.length - 1]);
      return s.slice(0, -1);
    });
  };
  const parent = dir.replace(/[\\/][^\\/]+$/, "");
  const atRoot = parent === dir;
  const crumbs = useMemo(() => breadcrumbSegments(dir), [dir]);

  /* ---- 关闭：folder-pop-out（--dur-fx-fast）缩放淡出后回调 onClose，+20ms
          余量随速度档；实例卸载（父组件 key 换弹层）时计时器随 effect 清理，
          不误关后来者。 ---- */
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (!closing) setClosing(true);
  }, [closing]);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => onCloseRef.current(), animDurations().fxFastMs + 20);
    return () => window.clearTimeout(t);
  }, [closing]);

  /* ---- 目录加载：世代号守卫（慢请求不得覆盖新目录）。 ---- */
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadSeq = useRef(0);
  useEffect(() => {
    const seq = ++loadSeq.current;
    let disposed = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await invoke<FileEntry[]>("list_directory", { path: dir, showHidden: false });
        if (seq === loadSeq.current && !disposed) setEntries(sortEntries(list));
      } catch (e) {
        if (seq === loadSeq.current && !disposed) {
          setError(String(e));
          setEntries([]);
        }
      } finally {
        if (seq === loadSeq.current && !disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [dir, reloadKey]);

  /* BentoDesk 借鉴 #9：行内筛选——在大目录（200 项展示上限）里就地找文件；
     筛选作用于完整条目集，能翻出上限之外的内容。 */
  const [query, setQuery] = useState("");
  useEffect(() => {
    setQuery("");
  }, [dir]);
  const visible = useMemo(() => {
    const list = entries ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? list.filter((e) => e.name.toLowerCase().includes(q)) : list;
    return filtered.slice(0, DISPLAY_LIMIT);
  }, [entries, query]);
  const overflow = useMemo(() => {
    const list = entries ?? [];
    const q = query.trim().toLowerCase();
    const total = q ? list.filter((e) => e.name.toLowerCase().includes(q)).length : list.length;
    return total > visible.length;
  }, [entries, query, visible.length]);

  /* ---- 真实图标：分批并发提取，icons 只作去重缓存（签名驱动，不进重提循环）。 ---- */
  const [icons, setIcons] = useState<Record<string, string>>({});
  const iconSig = visible.map((e) => e.path).join("|");
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const pending = visible.filter((e) => !icons[e.path]).slice(0, ICON_LIMIT);
    if (pending.length === 0) return;
    void (async () => {
      for (let i = 0; i < pending.length; i += ICON_BATCH) {
        if (cancelled) return;
        const results = await Promise.all(
          pending.slice(i, i + ICON_BATCH).map((e) =>
            invoke<string | null>("get_app_icon", { path: e.path })
              .then((b64) => (b64 ? ([e.path, `data:image/png;base64,${b64}`] as const) : null))
              .catch(() => null)
          )
        );
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const r of results) if (r) next[r[0]] = r[1];
        if (Object.keys(next).length > 0) setIcons((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconSig]);

  /* ---- 定位：渲染后测量实际尺寸再落位（绘制前完成，无闪动）。 ---- */
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  const [pos, setPos] = useState<Placement | null>(null);
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setPos(
      placeFolderPopup(
        anchorRef.current,
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight }
      )
    );
  }, []);
  useLayoutEffect(() => {
    place();
  }, [place, entries, loading, error]);
  useEffect(() => {
    if (!pos) return;
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos, place]);

  /* ---- 外点 / Esc 关闭（capture 阶段，先于画布与编辑模式的 Esc）。 ---- */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        requestClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [requestClose]);

  const openEntry = (entry: FileEntry) => {
    if (!isTauri()) return;
    if (entry.is_dir) navigate(entry.path);
    else void invoke("open_path", { path: entry.path }).catch(() => {});
  };

  if (!isTauri()) return null;

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, transformOrigin: pos.side === "right" ? "left center" : "right center" }
    : { left: -9999, top: -9999 };

  return createPortal(
    <div
      ref={ref}
      className={`folder-popup${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-label={tr("文件夹预览")}
      tabIndex={-1}
      data-interactive
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="folder-popup-head">
        <button
          type="button"
          className="folder-popup-act"
          disabled={stack.length === 0}
          onClick={goBack}
          aria-label={tr("返回")}
          title={tr("返回")}
          data-interactive
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          className="folder-popup-act"
          disabled={atRoot}
          onClick={() => navigate(parent)}
          aria-label={tr("上一级")}
          title={tr("上一级")}
          data-interactive
        >
          <ArrowUp size={13} />
        </button>
        {/* B4 面包屑：点击祖先段就地下钻（返回栈不变）；当前段纯文本高亮。 */}
        <nav className="folder-popup-crumbs" aria-label={tr("路径")} title={dir}>
          {crumbs.truncated && <span className="folder-popup-crumb-ellipsis">…</span>}
          {crumbs.items.map((c) =>
            c.current ? (
              <span key={c.path} className="folder-popup-crumb is-current">
                {c.name}
              </span>
            ) : (
              <button
                type="button"
                key={c.path}
                className="folder-popup-crumb"
                onClick={() => navigate(c.path)}
                data-interactive
              >
                {c.name}
              </button>
            )
          )}
        </nav>
        <button
          type="button"
          className="folder-popup-act"
          onClick={() => void invoke("open_path", { path: dir }).catch(() => {})}
          aria-label={tr("在资源管理器中打开")}
          title={tr("在资源管理器中打开")}
          data-interactive
        >
          <FolderOpen size={13} />
        </button>
        <button
          type="button"
          className="folder-popup-act"
          onClick={() => setReloadKey((k) => k + 1)}
          aria-label={tr("重试")}
          title={tr("重试")}
          data-interactive
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="folder-popup-act"
          onClick={requestClose}
          aria-label={tr("关闭")}
          title={tr("关闭")}
          data-interactive
        >
          <X size={13} />
        </button>
      </div>
      <div className="folder-popup-filter">
        <Search size={12} />
        <input
          className="folder-popup-filter-input"
          value={query}
          placeholder={tr("筛选文件…")}
          aria-label={tr("筛选文件…")}
          onChange={(e) => setQuery(e.target.value)}
          data-interactive
        />
      </div>
      <div className="folder-popup-grid">
        {error && (
          <div className="folder-popup-state">
            <span>{tr("目录读取失败")}</span>
            <button
              type="button"
              className="folder-popup-mini"
              onClick={() => setReloadKey((k) => k + 1)}
              data-interactive
            >
              {tr("重试")}
            </button>
          </div>
        )}
        {!error && loading && <div className="folder-popup-state">{tr("加载中…")}</div>}
        {!error && !loading && visible.length === 0 && (
          <div className="folder-popup-state">{query.trim() ? tr("没有匹配的文件") : tr("空文件夹")}</div>
        )}
        {visible.map((e) => (
          <div
            key={e.path}
            className="folder-popup-item"
            role="button"
            tabIndex={0}
            data-interactive
            aria-label={e.name}
            title={e.path}
            onClick={() => openEntry(e)}
            onKeyDown={(ev) => {
              if (ev.key !== "Enter" && ev.key !== " ") return;
              ev.preventDefault();
              openEntry(e);
            }}
          >
            <span className={`folder-popup-icon${e.is_dir ? " is-dir" : ""}`}>
              {icons[e.path] ? (
                <img src={icons[e.path]} alt="" draggable={false} />
              ) : e.is_dir ? (
                <FolderOpen size={26} />
              ) : (
                <File size={26} />
              )}
            </span>
            <span className="folder-popup-name">{e.name}</span>
          </div>
        ))}
      </div>
      {overflow && (
        <div className="folder-popup-foot">
          {tr("仅显示前")} {DISPLAY_LIMIT} {tr("项，共")} {entries!.length} {tr("项")}
        </div>
      )}
    </div>,
    document.body
  );
}
