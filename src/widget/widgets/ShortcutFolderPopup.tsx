/**
 * 快捷方式文件夹弹层（类手机桌面文件夹）：快捷方式组件里的文件夹磁贴展开
 * 后的就地条目网格——点条目直接打开，右键条目就地操作，与真实文件系统的
 * FolderPopup（DeskOrder 借鉴 #13）互不相干。
 *
 * 开合（BentoDesk Zone 胶囊↔网格同表面语义的 webview 等价物）：WAAPI FLIP
 * 从磁贴矩形连续变形到弹层矩形（240ms cubic-bezier(0,0,0.58,1)，无过冲——
 * 面板先到位而内容未至会像两块分离的板子）；关闭反向收回磁贴，从当前
 * 计算值续跑（展开中途反向不跳层）。打开后 260ms 展开锁内忽略外点关闭，
 * 防双击误关；pin 模式外点不关，仅 ×/Esc 收。
 *
 * 分页：固定高度页区，行列数测量
 * 自适应（rowsPerPage 按实测条目高度折算），translateX 位移翻页 + 页点；
 * 非当前页懒挂载（只挂 ±1 页）——分页即虚拟化。锚点保页：重排/增删后
 * 让用户正在交互（拖拽/翻页锚定）的条目跟随其新页，不丢翻页位置。
 * 搜索过滤态退化为整区滚动浏览（分页只服务浏览态）。
 *
 * 展示排序：头部按钮循环 自由/名称/时间；
 * 自由 = childIds 顺序（拖拽重排目标序），name 区域感知名称序，time 按
 * 目标修改时间倒序（paths_mtimes 批量拉取）。非自由态网格内拖拽不重排
 * （拖出弹层仍可用）。
 *
 * 内联搜索（BentoDesk InlineSearch）：contains 就地过滤，Enter 打开第一个
 * 匹配并收起；空查询闲置 3s 自动收起、非空查询永不闲置关闭；无结果居中
 * muted 文案；每次输入重置滚动。
 *
 * 弹层内拖拽（BentoDesk 内部拖拽语义）：>4px 视为拖动；被拖条目 fixed 定身
 * + transform 跟手，网格内实时重排（reorderChildIds 纯函数），拖出弹层边界
 * 切换为画布/其它文件夹落点预览，松手提交。
 *
 * 定位复用 placeFolderPopup（靠锚点一侧生长、翻侧、贴边钳制）；Portal 到
 * body + 整体 data-interactive。条目错峰进场：stagger 10ms、前 5 张、Y 偏移 6px。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUpDown, FileText, FolderClosed, Link2, Search, X } from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useT } from "../../i18n-lite";
import { animDurations } from "../../lib/durations";
import type { PopoverAnchor } from "../WidgetConfigPopover";
import { placeFolderPopup } from "./FolderPopup";
import {
  clampPage,
  pageCountOf,
  pageIndexOf,
  reorderChildIds,
  sortFolderItems,
  type CustomShortcut,
  type ShortcutFolder,
  type SfDropTarget,
  type SfOpenMode,
  type SfSortMode
} from "../shortcuts-shared";

/** 展开锁（BentoDesk EXPAND_LOCK_MS = 240 动画 + 20 余量）：锁窗内的外点不关闭。 */
const EXPAND_LOCK_MS = 260;
/** 搜索条空查询闲置自动收起（非空查询永不闲置关闭——不丢用户输入）。 */
const SEARCH_IDLE_DISMISS_MS = 3000;
/** FLIP 时长与缓动：曲线消费 A3 契约 token（--ease-out / --ease-in，运行时
   读取根内联值，WAAPI 需要字符串；读不到时回退 token 的 CSS 原值），
   时长用 --dur-fx / --dur-fx-fast 同源毫秒——私有 cubic-bezier 游离契约外的
   状态就此收敛，速度三档设置对开合动画同样生效。 */
const FALLBACK_EASE_OUT =
  "cubic-bezier(0.22, 1, 0.36, 1)"; /* ease: ok token 回退字面量，运行时 rootToken 优先读 --ease-out 内联值 */
const FALLBACK_EASE_IN = "cubic-bezier(0.4, 0, 1, 1)"; /* ease: ok 同上，回退 --ease-in 的契约原值 */
function rootToken(name: string, fallback: string): string {
  const v = document.documentElement.style.getPropertyValue(name).trim();
  return v || fallback;
}
function flipOpenOptions(): KeyframeAnimationOptions {
  const d = animDurations();
  return { duration: d.fxMs, easing: rootToken("--ease-out", FALLBACK_EASE_OUT) };
}
function flipCloseOptions(): KeyframeAnimationOptions {
  const d = animDurations();
  return { duration: d.fxFastMs, easing: rootToken("--ease-in", FALLBACK_EASE_IN) };
}
/** 分页网格测量基准（与 CSS 对齐）：最小列宽 72 + 列间隙 4、页区左右内边距 20。 */
const PAGE_COL_MIN = 72;
const PAGE_GAP = 4;
const PAGE_PAD_X = 20;
const PAGE_MAX_ROWS = 6;
/** 排序循环顺序。 */
const SORT_CYCLE: SfSortMode[] = ["free", "name", "time"];

export type ShortcutFolderPopupProps = {
  folder: ShortcutFolder;
  /** 已解析的子条目（childIds ∩ 现存 customShortcuts，按 childIds 顺序，由调用方过滤）。 */
  items: CustomShortcut[];
  anchor: PopoverAnchor;
  /** path → data:image/png;base64 的真实图标缓存（与画布共享同一份）。 */
  icons: Record<string, string>;
  openMode: SfOpenMode;
  /** 展示排序模式（folder.sort，由调用方持久化）。 */
  sort: SfSortMode;
  onSortChange: (mode: SfSortMode) => void;
  onClose: () => void;
  onOpenItem: (item: CustomShortcut) => void;
  onMoveOut: (item: CustomShortcut) => void;
  onRemoveItem: (item: CustomShortcut) => void;
  onRevealItem: (item: CustomShortcut) => void;
  onCopyItemPath: (item: CustomShortcut) => void;
  onRenameItem: (item: CustomShortcut) => void;
  /** 缺失条目重新定位（文件选择对话框 → 重挂 path/kind/label）。 */
  onRelocateItem: (item: CustomShortcut) => void;
  /** 弹层内重排提交（完整 childIds；仅自由排序下由拖拽触发）。 */
  onReorder: (childIds: string[]) => void;
  /** 条目拖出弹层松手：target 为 null = 无有效落点（取消）。 */
  onDropOutside: (item: CustomShortcut, target: SfDropTarget | null) => void;
  /** 拖出弹层期间的落点预览（调用方渲染画布占位框 / 磁贴高亮）。 */
  onDropTargetMove: (target: SfDropTarget | null) => void;
  /** 画布命中测试（调用方实现：文件夹磁贴优先，其次内容区格位）。 */
  hitTestOutside: (x: number, y: number) => SfDropTarget | null;
  /** hover 模式：指针进入/离开弹层 → 调用方取消/调度宽限收回。 */
  onHoverEnter: () => void;
  onHoverLeave: () => void;
};

function childIcon(item: CustomShortcut, icons: Record<string, string>) {
  const real = icons[item.path];
  if (real) return <img src={real} alt="" draggable={false} />;
  if (item.kind === "url") return <Link2 size={22} />;
  if (item.kind === "folder") return <FolderClosed size={22} />;
  return <FileText size={22} />;
}

/** 磁贴矩形→弹层矩形的 FLIP 逆变换（中心对齐；layout rect 不含 transform）。 */
function flipTransformFor(anchor: PopoverAnchor, left: number, top: number, w: number, h: number): string {
  const sx = anchor.w / w;
  const sy = anchor.h / h;
  const dx = anchor.x + anchor.w / 2 - (left + w / 2);
  const dy = anchor.y + anchor.h / 2 - (top + h / 2);
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

function motionOk(): boolean {
  // 双信号：OS 偏好 + 应用内「减少动态」开关（与 lib/anim prefersReducedMotion 同口径）。
  const osReduce =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return !osReduce && document.documentElement.getAttribute("data-reduce-motion") !== "1";
}

type PopupDrag = {
  id: string;
  dx: number;
  dy: number;
  mode: "inside" | "outside";
  /** 拖动开始时的视口矩形：幽灵按此定身，重排回流不再移动 ghost。 */
  frozen: { left: number; top: number; width: number };
};

export function ShortcutFolderPopup({
  folder,
  items,
  anchor,
  icons,
  openMode,
  sort,
  onSortChange,
  onClose,
  onOpenItem,
  onMoveOut,
  onRemoveItem,
  onRevealItem,
  onCopyItemPath,
  onRenameItem,
  onRelocateItem,
  onReorder,
  onDropOutside,
  onDropTargetMove,
  hitTestOutside,
  onHoverEnter,
  onHoverLeave
}: ShortcutFolderPopupProps) {
  const tr = useT();

  /* ---- 关闭：160ms 反向 FLIP 后回调 onClose；期间重复触发幂等。 ---- */
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (!closing) setClosing(true);
  }, [closing]);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => onCloseRef.current(), animDurations().fxFastMs);
    return () => window.clearTimeout(t);
  }, [closing]);

  /* ---- 定位：渲染后测量实际尺寸再落位（绘制前完成，无闪动）。 ---- */
  const ref = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const placed = placeFolderPopup(
      anchorRef.current,
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight }
    );
    setPos({ left: placed.left, top: placed.top });
  }, [items.length]);

  /* ---- FLIP 开合：展开从磁贴矩形长出来，收起反向缩回（中途反向从当前值续跑）。 ---- */
  const flipOpenedRef = useRef(false);
  useLayoutEffect(() => {
    if (!pos || flipOpenedRef.current) return;
    flipOpenedRef.current = true;
    const el = ref.current;
    if (!el || typeof el.animate !== "function" || !motionOk()) return;
    const from = flipTransformFor(anchorRef.current, pos.left, pos.top, el.offsetWidth, el.offsetHeight);
    try {
      el.animate(
        [
          { opacity: 0.35, transform: from },
          { opacity: 1, transform: "none" }
        ],
        flipOpenOptions()
      );
    } catch {
      /* 动画不可用直接呈现 */
    }
  }, [pos]);
  useEffect(() => {
    if (!closing) return;
    const el = ref.current;
    if (!el || !pos || typeof el.animate !== "function" || !motionOk()) return;
    const cs = getComputedStyle(el);
    const from = { opacity: cs.opacity, transform: cs.transform === "none" ? "none" : cs.transform };
    const to = flipTransformFor(anchorRef.current, pos.left, pos.top, el.offsetWidth, el.offsetHeight);
    try {
      el.animate([from, { opacity: 0, transform: to }], flipCloseOptions());
    } catch {
      /* 无动画时由关闭计时器直接收 */
    }
  }, [closing, pos]);

  /* ---- 外点 / Esc 关闭：capture 阶段，先于画布与编辑模式的 Esc。
          展开锁窗内外点忽略（防双击误关）；pin 模式外点不关。 ---- */
  const openedAtRef = useRef(0);
  useEffect(() => {
    openedAtRef.current = performance.now();
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (openMode === "pin") return;
      if (performance.now() - openedAtRef.current < EXPAND_LOCK_MS) return;
      if (ref.current && !ref.current.contains(e.target as Node)) requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (searchOpen) closeSearch();
      else requestClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMode, requestClose, searchOpen]);

  /* ---- hover 模式：进入取消宽限收回、离开交还调用方调度。 ---- */
  useEffect(() => {
    if (closing) return;
    const el = ref.current;
    if (!el) return;
    const enter = () => onHoverEnter();
    const leave = () => onHoverLeave();
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  }, [closing, onHoverEnter, onHoverLeave]);

  /* ---- 错峰进场只作用于首次打开（--dur-fx + stagger 最长 250ms 后摘除动画
          作用域）：拖拽重排会移动 DOM 节点导致 animation 重放，若不加作用域
          松手瞬间全网格闪一遍。 ---- */
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), animDurations().fxMs + 60);
    return () => window.clearTimeout(t);
  }, []);

  /* ---- 内联搜索：Enter 打开首个匹配并收起；空查询闲置 3s 自动收起。 ---- */
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);
  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    if (query.trim()) return; // 非空查询永不闲置关闭
    const t = window.setTimeout(closeSearch, SEARCH_IDLE_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [searchOpen, query, closeSearch]);

  /* ---- 展示排序：time 模式批量拉取目标修改时间（缺省 0 = 排最后）。 ---- */
  const [mtimes, setMtimes] = useState<Record<string, number>>({});
  const mtimeSig = items.map((i) => i.path).join("|");
  useEffect(() => {
    if (sort !== "time" || !isTauri() || items.length === 0) return;
    let cancelled = false;
    void invoke<number[]>("paths_mtimes", { paths: items.map((i) => i.path) })
      .then((arr) => {
        if (cancelled || !Array.isArray(arr)) return;
        const next: Record<string, number> = {};
        items.forEach((it, i) => {
          next[it.path] = arr[i] ?? 0;
        });
        setMtimes(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, mtimeSig]);

  /* ---- 排序 + 搜索过滤后的展示列表（浏览态 = 分页，搜索态 = 滚动）。 ---- */
  const baseIds = items.map((i) => i.id);
  const [orderOverride, setOrderOverrideState] = useState<string[] | null>(null);
  const orderOverrideRef = useRef<string[] | null>(null);
  const applyOverride = useCallback((next: string[] | null) => {
    orderOverrideRef.current = next;
    setOrderOverrideState(next);
  }, []);
  const overrideApplied = orderOverride
    ? orderOverride.map((id) => items.find((i) => i.id === id)).filter((i): i is CustomShortcut => !!i)
    : items;
  const sorted = sortFolderItems(overrideApplied, sort, (it) => mtimes[it.path] ?? 0);
  const q = query.trim().toLowerCase();
  const searchBrowsing = q.length > 0;
  const visible = q ? sorted.filter((i) => i.label.toLowerCase().includes(q)) : sorted;
  const byId = new Map(items.map((i) => [i.id, i]));

  /* ---- 分页：固定高度页区，行列测量自适应；
          非当前页懒挂载（±1 页）——分页即虚拟化；锚点保页跟随交互条目。 ---- */
  const viewportRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ columns: number; rows: number }>({ columns: 4, rows: 3 });
  const perPage = Math.max(1, layout.columns * layout.rows);
  const pages = pageCountOf(visible.length, perPage);
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);
  const anchorIdRef = useRef<string | null>(null);
  const goToPage = useCallback(
    (i: number) => {
      const next = clampPage(i, pageCountOf(visible.length, perPage));
      pageRef.current = next;
      setPage(next);
      anchorIdRef.current = visible[next * perPage]?.id ?? anchorIdRef.current;
    },
    [visible, perPage]
  );
  // 锚点保页：列表（顺序/数量）或每页容量变化时，锚定条目跟随其新页；
  // 无锚点则钳制当前页，锚点更新为新页首条目。
  const orderSig = `${sorted.map((i) => i.id).join("\u{1}")}#${perPage}`;
  useEffect(() => {
    const ids = sorted.map((i) => i.id);
    const anchorIdx = anchorIdRef.current ? ids.indexOf(anchorIdRef.current) : -1;
    const next = clampPage(
      anchorIdx >= 0 ? pageIndexOf(anchorIdx, perPage) : pageRef.current,
      pageCountOf(ids.length, perPage)
    );
    if (next !== pageRef.current) {
      pageRef.current = next;
      setPage(next);
    }
    anchorIdRef.current = ids[next * perPage] ?? anchorIdRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderSig]);
  // 页区行列测量：列宽按 72px 最小列折算，行高按实测首条目折算（挂载后有真值）。
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const measure = () => {
      const w = vp.clientWidth;
      const h = vp.clientHeight;
      if (w <= 0 || h <= 0) return;
      const columns = Math.max(3, Math.floor((w - PAGE_PAD_X + PAGE_GAP) / (PAGE_COL_MIN + PAGE_GAP)));
      const item = vp.querySelector<HTMLElement>(".sfolder-popup-item");
      const itemH = item && item.offsetHeight > 0 ? item.offsetHeight : 70;
      const rows = Math.min(PAGE_MAX_ROWS, Math.max(1, Math.floor((h + PAGE_GAP) / (itemH + PAGE_GAP))));
      setLayout((prev) => (prev.columns === columns && prev.rows === rows ? prev : { columns, rows }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [pos, items.length, searchBrowsing]);

  /* ---- 弹层内拖拽：网格内重排（预演，仅自由排序），拖出边界转画布/文件夹落点。
          幽灵经 Portal 挂 body：被拖条目位于 .sfolder-pages-track（恒有
          transform 位移），transformed 祖先会把条目自身 position:fixed 的
          包含块改成 track，冻结的视口坐标整体错位、条目被 overflow:hidden
          裁掉——表现为「一拖就消失」。本体 display:none 收拢占位，视觉由
          body 下的幽灵承担。 ---- */
  const [drag, setDrag] = useState<PopupDrag | null>(null);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    mode: "inside" | "outside";
    frozen: { left: number; top: number; width: number };
    beforeId: string | null;
    lastHit: SfDropTarget | null;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const moveTarget = useRef(onDropTargetMove);
  moveTarget.current = onDropTargetMove;

  /* 指针事件挂 window 而非条目元素：拖拽跨页时条目 DOM 会被分页懒挂载
     卸载重建（跟随被拖条目翻页），元素级监听随节点销毁失联，pointerup
     丢失会把拖拽态卡死——条目以幽灵态滞留到重开弹层。window 监听与
     DOM 重建解耦；经 ref 取最新处理器，闭包不随渲染过期。 */
  const winMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const winUpRef = useRef<(e: PointerEvent) => void>(() => {});
  const winCancelRef = useRef<() => void>(() => {});
  const detachDragRef = useRef<(() => void) | null>(null);
  const detachDragWindow = useCallback(() => {
    detachDragRef.current?.();
    detachDragRef.current = null;
  }, []);
  useEffect(
    () => () => {
      detachDragRef.current?.();
      moveTarget.current(null);
    },
    []
  );

  // 拖拽目标条目被并发移除（watch/另一侧操作）时复位拖拽态与落点预览。
  useEffect(() => {
    const d = dragRef.current;
    if (d && !items.some((i) => i.id === d.id)) {
      dragRef.current = null;
      detachDragWindow();
      applyOverride(null);
      setDrag(null);
      moveTarget.current(null);
    }
  }, [items, applyOverride, detachDragWindow]);

  const followDraggedPage = (id: string) => {
    if (searchBrowsing) return;
    const ids = orderOverrideRef.current ?? baseIds;
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const p = clampPage(pageIndexOf(idx, perPage), pageCountOf(ids.length, perPage));
    if (p !== pageRef.current) {
      pageRef.current = p;
      setPage(p);
    }
  };

  const onItemDown = (item: CustomShortcut, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || closing) return;
    e.stopPropagation();
    const el = e.currentTarget;
    anchorIdRef.current = item.id; // 锚点保页：跟随正在交互的条目
    // 冻结矩形在按下瞬间采集（此刻条目必然有布局）。
    const fr = el.getBoundingClientRect();
    dragRef.current = {
      id: item.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      mode: "inside",
      frozen: { left: fr.left, top: fr.top, width: el.offsetWidth },
      beforeId: item.id,
      lastHit: null
    };
    // 不用 setPointerCapture：第一帧 setDrag 后本体条目 display:none，Chromium
    // 对「已 display:none 的捕获目标」会停止派发后续指针事件 → dx/dy 冻结、
    // 幽灵滞留起点不跟手。事件靠正常命中冒泡到 window（幽灵 pointer-events:
    // none，命中穿透到下层条目），与捕获解耦，追踪永不中断。
    detachDragWindow();
    const onMove = (ev: PointerEvent) => winMoveRef.current(ev);
    const onUp = (ev: PointerEvent) => winUpRef.current(ev);
    const onCancel = () => winCancelRef.current();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    detachDragRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  };

  const winMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    const root = ref.current;
    if (!root) return;
    d.moved = true;
    const r = root.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) {
      if (d.mode !== "inside") {
        d.mode = "inside";
        d.lastHit = null;
        moveTarget.current(null);
        applyOverride(null);
      }
      // 目标插入位：指针下的条目（data-sf-id）之前；网格空白处 = 末尾；
      // 头部/搜索条上方不更新（沿用上次插入位）。elementFromPoint 兼容守卫：
      // 旧浏览器 / jsdom 可能未实现。
      let hitEl: Element | null = null;
      try {
        hitEl =
          typeof document.elementFromPoint === "function"
            ? ((document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest?.(
                ".sfolder-popup-item"
              ) ?? null)
            : null;
      } catch {
        hitEl = null;
      }
      const pageArea = viewportRef.current ?? gridRef.current;
      const gr = pageArea?.getBoundingClientRect();
      const inGrid =
        !!gr && e.clientX >= gr.left && e.clientX <= gr.right && e.clientY >= gr.top && e.clientY <= gr.bottom;
      if (hitEl) {
        const beforeId = (hitEl as HTMLElement).dataset.sfId ?? null;
        if (beforeId !== d.beforeId && beforeId !== d.id) {
          d.beforeId = beforeId;
          if (sort === "free") {
            applyOverride(reorderChildIds(baseIds, d.id, beforeId));
            followDraggedPage(d.id);
          }
        }
      } else if (inGrid && d.beforeId !== null) {
        d.beforeId = null;
        if (sort === "free") {
          applyOverride(reorderChildIds(baseIds, d.id, null));
          followDraggedPage(d.id);
        }
      }
    } else {
      if (d.mode !== "outside") {
        d.mode = "outside";
        applyOverride(null);
      }
      const hit = hitTestOutside(e.clientX, e.clientY);
      const sig = hit ? JSON.stringify(hit) : "";
      const lastSig = d.lastHit ? JSON.stringify(d.lastHit) : "";
      if (sig !== lastSig) {
        d.lastHit = hit;
        moveTarget.current(hit);
      }
    }
    setDrag({ id: d.id, dx, dy, mode: d.mode, frozen: d.frozen });
  };

  const winUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    detachDragWindow();
    dragRef.current = null;
    if (!d.moved) return; // 纯点击：交给 onClick 打开
    // 指针捕获元素松手后浏览器会补发一次合成 click：压住它，避免拖拽重排
    // 顺带打开条目（与画布拖拽同一手法）。
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (d.mode === "inside") {
      const next = orderOverrideRef.current;
      applyOverride(null);
      setDrag(null);
      // 仅自由排序提交重排（排序态的拖拽视为取消）。
      if (sort === "free" && next && next.join("\u{1}") !== baseIds.join("\u{1}")) onReorder(next);
    } else {
      setDrag(null);
      const item = byId.get(d.id);
      if (item) onDropOutside(item, d.lastHit);
      moveTarget.current(null);
    }
  };

  const winCancel = () => {
    const d = dragRef.current;
    if (!d) return;
    detachDragWindow();
    dragRef.current = null;
    applyOverride(null);
    setDrag(null);
    if (d.mode === "outside") moveTarget.current(null);
  };
  // 处理器镜像（每次渲染刷新）：window 监听闭包固定，逻辑永远读最新值。
  winMoveRef.current = winMove;
  winUpRef.current = winUp;
  winCancelRef.current = winCancel;

  /* ---- 条目右键：就地菜单（Portal 到 body，同 widget-context-menu 语义）。 ---- */
  const [menu, setMenu] = useState<{ x: number; y: number; item: CustomShortcut } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const style: CSSProperties = pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 };

  const sortTitle =
    sort === "name" ? tr("排序：按名称") : sort === "time" ? tr("排序：按时间") : tr("排序：自由（可拖拽调整顺序）");

  const renderItemNode = (item: CustomShortcut, indexInPage: number) => {
    const isDragItem = drag?.id === item.id;
    const itemStyle = { "--sf-i": String(Math.min(indexInPage, 5)) } as CSSProperties;
    if (isDragItem) {
      // 本体隐身收拢占位（不留洞），视觉由 body 下的 Portal 幽灵承担——
      // 幽灵若留在 track 内，fixed 会被 transformed 祖先劫持包含块而错位
      // 消失（本组件的原始 bug）。节点保持挂载，指针事件在 window 层。
      itemStyle.display = "none";
    }
    return (
      <div
        key={item.id}
        className={`sfolder-popup-item${item.missing ? " is-missing" : ""}${isDragItem ? " is-dragging" : ""}`}
        style={itemStyle}
        role="button"
        tabIndex={0}
        data-interactive
        data-sf-id={item.id}
        aria-label={item.label}
        title={item.missing ? `${item.path}（${tr("目标缺失")}）` : item.path}
        onClick={() => {
          if (suppressClickRef.current) return;
          onOpenItem(item);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onOpenItem(item);
            return;
          }
          if (ev.key === "Delete" && !item.missing) {
            ev.preventDefault();
            onRemoveItem(item);
          }
        }}
        onPointerDown={(ev) => onItemDown(item, ev)}
        onContextMenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setMenu({ x: ev.clientX, y: ev.clientY, item });
        }}
      >
        <span className="sfolder-popup-icon">{childIcon(item, icons)}</span>
        <span className="sfolder-popup-name">{item.label}</span>
      </div>
    );
  };

  const stateClass = `${closing ? " is-closing" : ""}${searchOpen ? " is-searching" : ""}${
    entering ? " is-entering" : ""
  }${drag ? " is-dragging" : ""}`;

  // 浏览态分页切片（搜索态走滚动网格，不分页）。
  const pageSlices: CustomShortcut[][] = [];
  if (!searchBrowsing && visible.length > 0) {
    for (let i = 0; i < visible.length; i += perPage) {
      pageSlices.push(visible.slice(i, i + perPage));
    }
  }

  return (
    <>
      {createPortal(
        <div
          ref={ref}
          className={`sfolder-popup${stateClass}`}
          role="dialog"
          aria-label={folder.label}
          tabIndex={-1}
          data-interactive
          style={style}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="sfolder-popup-head">
            <span className="sfolder-popup-title">{folder.label}</span>
            <span className="sfolder-popup-count">{items.length}</span>
            <button
              type="button"
              className={`sfolder-popup-act${sort !== "free" ? " is-on" : ""}`}
              onClick={() => onSortChange(SORT_CYCLE[(SORT_CYCLE.indexOf(sort) + 1) % SORT_CYCLE.length])}
              aria-label={sortTitle}
              title={sortTitle}
              data-interactive
            >
              <ArrowUpDown size={13} />
            </button>
            <button
              type="button"
              className={`sfolder-popup-act${searchOpen ? " is-on" : ""}`}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              aria-label={tr("搜索")}
              title={tr("搜索")}
              data-interactive
            >
              <Search size={13} />
            </button>
            <button
              type="button"
              className="sfolder-popup-act"
              onClick={requestClose}
              aria-label={tr("关闭")}
              title={tr("关闭")}
              data-interactive
            >
              <X size={13} />
            </button>
          </div>
          <div className="sfolder-popup-search" data-interactive>
            <Search size={12} />
            <input
              ref={searchInputRef}
              className="sfolder-popup-search-input"
              value={query}
              placeholder={tr("搜索快捷方式…")}
              aria-label={tr("搜索快捷方式…")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const first = visible[0];
                if (first) {
                  onOpenItem(first);
                  closeSearch();
                }
              }}
            />
          </div>
          {items.length === 0 ? (
            <div className="sfolder-popup-empty">
              <FolderClosed size={20} />
              <span>{tr("文件夹是空的")}</span>
              <span className="sfolder-popup-empty-sub">
                {tr("把图标拖到文件夹磁贴上，或右键快捷方式选「移入文件夹」")}
              </span>
            </div>
          ) : searchBrowsing && visible.length === 0 ? (
            <div className="sfolder-popup-nomatch">{tr("没有找到匹配结果")}</div>
          ) : searchBrowsing ? (
            /* 搜索态：整区滚动浏览（分页只服务浏览态，避免对动态过滤集分页）。 */
            <div
              ref={gridRef}
              className={`sfolder-popup-grid${entering ? " is-entering" : ""}${drag ? " is-dragging" : ""}`}
            >
              {visible.map((item, i) => renderItemNode(item, i))}
            </div>
          ) : (
            <>
              <div
                ref={viewportRef}
                className="sfolder-pages"
                onScroll={(e) => {
                  // 懒挂载兜底：万一内容溢出（测量偏差）允许横向滑动时同步页码。
                  const el = e.currentTarget;
                  const w = el.clientWidth;
                  if (w > 0) goToPage(Math.round(el.scrollLeft / w));
                }}
              >
                <div className="sfolder-pages-track" style={{ transform: `translateX(-${page * 100}%)` }}>
                  {pageSlices.map((pageItems, pi) => (
                    <div
                      key={pi}
                      className={`sfolder-page${pi === page ? " is-current" : ""}${Math.abs(pi - page) === 1 ? " is-adjacent" : ""}`}
                      aria-hidden={pi !== page}
                      style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}
                    >
                      {/* 懒挂载：只渲染当前 ±1 页——分页即虚拟化。 */}
                      {Math.abs(pi - page) <= 1 ? pageItems.map((item, i) => renderItemNode(item, i)) : null}
                    </div>
                  ))}
                </div>
              </div>
              {pages > 1 && (
                <div className="sfolder-dots" data-interactive>
                  {Array.from({ length: pages }, (_, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`sfolder-dot${i === page ? " is-current" : ""}`}
                      onClick={() => goToPage(i)}
                      aria-label={tr("跳转到第 {n} 页", { n: i + 1 })}
                      aria-current={i === page}
                      data-interactive
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>,
        document.body
      )}

      {/* 拖拽幽灵：Portal 到 body，fixed 相对视口定身（视口冻结坐标 + 全量
          transform 跟手）。z-index 压过弹层本体（10110）；pointer-events:none
          由 .is-dragging 提供，不挡 elementFromPoint 的插入位判定。 */}
      {drag &&
        byId.get(drag.id) &&
        createPortal(
          <div
            className="sfolder-popup-item is-dragging"
            style={{
              position: "fixed",
              left: drag.frozen.left,
              top: drag.frozen.top,
              width: drag.frozen.width,
              transform: `translate(${drag.dx}px, ${drag.dy}px)`,
              zIndex: 10111
            }}
          >
            <span className="sfolder-popup-icon">{childIcon(byId.get(drag.id)!, icons)}</span>
            <span className="sfolder-popup-name">{byId.get(drag.id)!.label}</span>
          </div>,
          document.body
        )}

      {menu &&
        createPortal(
          <div
            className="widget-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
          >
            <button
              role="menuitem"
              onClick={() => {
                onOpenItem(menu.item);
                setMenu(null);
              }}
            >
              {tr("打开")}
            </button>
            {menu.item.kind !== "url" && !menu.item.missing && (
              <button
                role="menuitem"
                onClick={() => {
                  onRevealItem(menu.item);
                  setMenu(null);
                }}
              >
                {tr("在资源管理器中显示")}
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                onCopyItemPath(menu.item);
                setMenu(null);
              }}
            >
              {tr("复制路径")}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                onRenameItem(menu.item);
                setMenu(null);
              }}
            >
              {tr("重命名")}
            </button>
            {menu.item.missing && (
              <button
                role="menuitem"
                onClick={() => {
                  onRelocateItem(menu.item);
                  setMenu(null);
                }}
              >
                {tr("重新定位…")}
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                onMoveOut(menu.item);
                setMenu(null);
              }}
            >
              {tr("移出文件夹")}
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                onRemoveItem(menu.item);
                setMenu(null);
              }}
            >
              {tr("移除")}
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
