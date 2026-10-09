/* eslint-disable react-refresh/only-export-components */
/**
 * 磁贴列表（ISLAND-CORE 迁出骨架 → ISLAND-SORT 补齐岛内交互）：按 dock.tiles
 * 顺序渲染 DockTile。接管期间整层 aria-hidden + 磁贴失焦，显隐只切透明度
 * （`.dock.has-takeover .dock-tiles`），层常驻叠放不卸载。
 *
 * 磁贴被移除时同步清掉它在 expand-store 的展开 / 挂载记录（对齐卡片卸载时
 * forget 的契约；2.0 前磁贴不可移除故无此路径）。
 *
 * 岛内交互（入口 b / ，拖动协调器范式）：
 * - 拖动排序：编辑模式越过 4px 即拖；非编辑模式长按 300ms 进入拖动（长按前
 *   移动 >10px 视为普通点击 / 滚动，取消长按）。拖动期间被拖磁贴本体留在原槽
 *   透明占位，body 下挂一枚 cloneNode 的**幽灵芯片**跟手（scale 1.04，每帧只写
 *   transform；用幽灵而非本体是为了 >8 枚横向可滚时不被 overflow 裁切、且
 *   永远压在岛之上）。其余磁贴按 insertionIndexAt(拖动开始时缓存的矩形, 指针 x)
 *   实时让位——跨过的磁贴整体平移一枚宽度 + 间距，位移过渡走 pickSpatialEase
 *   （≤20px fast 350ms，否则 500ms；reduce-motion 瞬移），落位空槽中心显示 2px
 *   竖条预览（InsertBar 读 widget-store.dockDrag，DROP 会话的画布卡片拖入
 *   同样由它显示插入位）。松手：本体先跳到幽灵位置再 flipReorder 回弹落位 →
 *   moveDockTile 一次落盘；Esc / pointercancel 原位放回。
 * - 拖出移除：指针离岛矩形 ≥48px 时幽灵半透明、其余磁贴提前补位；松手
 *   removeDockTile + toast「已从灵动岛移除 · 撤销」，撤销 = addDockTile(原 tile, 原 index)
 *   （撤销槽就是 toast action 的闭包，与通知中心 undo 槽同一语义）。
 * - 长按 / 拖动结束后的 click 在容器 capture 阶段吞掉，不触发展开；普通单击照常。
 * - 键盘：←/→ 在磁贴与「+」间移焦点，Home/End 首尾，Ctrl+←/→ moveDockTile
 *   （flipReorder），Delete removeDockTile（同样可撤销，焦点落到邻位），Enter 展开
 *   走 DockTile 原生按钮。tabIndex 序即 DOM 序 = tiles 顺序。
 * - 「+」磁贴：编辑模式显示于末尾，弹 DockTypePicker 选类型 → addDockTile 追加。
 * - >8 枚：容器横向可滚（鼠标滚轮竖滚转横滚，两端按可滚方向渐隐），不换行、不撑破屏宽。
 * - 新磁贴（添加 / 撤销恢复）播 .is-growing + .is-entering 弹入（0 宽长到自然宽 + scale .8 + opacity 0 → 1）。
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { Plus } from "lucide-react";
import { pushAppToast } from "../../components/ToastHost";
import { useT } from "../../i18n-lite";
import { flipReorder, pickSpatialEase, prefersReducedMotion } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { uiZoom } from "../../lib/ui-zoom";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useWidgetExpand } from "../expand-store";
import { useOsFileDrop } from "../use-os-file-drop";
import { loadNotes, saveNotes, type Note } from "../notes-store";
import {
  cancelDockTileDataRemoval,
  createDockTileAutoBound,
  finalizeDockTileDataRemoval,
  findDockTileConflict,
  useWidgetStore,
  type DockTile as DockTileModel
} from "../widget-store";
import type { PopoverAnchor } from "../WidgetConfigPopover";
import { DockTile, dockTileDisplayName } from "./DockTile";
import { WidgetErrorBoundary } from "../WidgetErrorBoundary";
import { DockTypePicker, type PickerCloseReason } from "./DockTypePicker";
import {
  DOCK_EXPAND_PREFIX,
  DOCK_FLIP_SELECTOR,
  DOCK_PANEL_EXPAND_ID,
  DOCK_TILE_GAP_PX,
  dockTileExpandId,
  dockTileInstanceId,
  insertionIndexAt,
  TILE_DRAG_LONG_PRESS_MS
} from "./dock-logic";

/** 非编辑模式长按进入拖动的时长：单点化后即
 *  dock-logic 的 TILE_DRAG_LONG_PRESS_MS，原同名导出保留别名供既有
 *  测试/消费面平滑迁移。 */
export const LONG_PRESS_MS = TILE_DRAG_LONG_PRESS_MS;
/** 编辑模式下指针位移达到此值视为拖动而非点击（px）。 */
export const DRAG_THRESHOLD_PX = 4;
/** 非编辑模式长按等待期内的位移容差（px）：超过即当作普通点击 / 滚动，取消长按。 */
export const LONG_PRESS_SLOP_PX = 10;
/** 指针离岛矩形至少此距离松手 = 移除。 */
export const REMOVE_DISTANCE_PX = 48;
/** 磁贴数超过此值岛内横向可滚（两端渐隐）。 */
export const OVERFLOW_TILE_COUNT = 8;

const TILE_SELECTOR = ".dock-tile";
/** FLIP 参与元素选择器收敛到 dock-logic（DOCK_FLIP_SELECTOR），与右键移除共用。 */

type Rect = { left: number; width: number };

/** 指针到矩形的最短欧氏距离（矩形内为 0）。 */
export function distanceToRect(
  x: number,
  y: number,
  r: { left: number; top: number; right: number; bottom: number }
): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/**
 * 拖动中其余磁贴的让位位移（纯函数）。from 为被拖磁贴原下标，to 为目标下标
 * （按移出后的数组计，与 moveDockTile 同口径），stride = 被拖磁贴宽 + 间距：
 * 被跨过的磁贴整体平移一枚；outside（拟移除）时 from 之后的磁贴全部左移补位。
 *
 * @returns 原下标 → 位移 px 的映射（无位移的下标不含）。
 */
export function reorderShifts(
  count: number,
  from: number,
  to: number,
  stride: number,
  outside: boolean
): Map<number, number> {
  const out = new Map<number, number>();
  for (let j = 0; j < count; j++) {
    if (j === from) continue;
    if (outside) {
      if (j > from) out.set(j, -stride);
    } else if (from < to && j > from && j <= to) {
      out.set(j, -stride);
    } else if (to < from && j >= to && j < from) {
      out.set(j, stride);
    }
  }
  return out;
}

/**
 * 插入位竖条的中心 x（与 rects 同坐标系）：让位后落位空槽的中心。
 * to === from 空槽即原位；to > from 空槽紧贴被跨过的最后一枚右缘；to < from 空槽
 * 从被跨过的第一枚左缘起。
 */
export function insertionBarX(rects: readonly Rect[], from: number, to: number): number {
  const w = rects[from].width;
  if (to === from) return rects[from].left + w / 2;
  if (to > from) return rects[to].left + rects[to].width - w / 2;
  return rects[to].left + w / 2;
}

type Pending = {
  tile: DockTileModel;
  pointerId: number;
  sx: number;
  sy: number;
  /** 非编辑模式的长按计时器；编辑模式为 null（越过阈值即拖）。 */
  timer: number | null;
};

type Drag = {
  tile: DockTileModel;
  from: number;
  pointerId: number;
  sx: number;
  sy: number;
  /** 拖动开始时缓存的全部磁贴矩形（视口坐标，含被拖磁贴）。 */
  rects: Rect[];
  /** 去掉被拖磁贴后的矩形（insertionIndexAt 的输入）。 */
  others: Rect[];
  island: { left: number; top: number; right: number; bottom: number };
  /** 容器内容坐标原点（视口 left − scrollLeft），竖条定位用。 */
  originX: number;
  stride: number;
  ghost: HTMLElement;
  source: HTMLButtonElement;
  to: number;
  outside: boolean;
  shifts: Map<number, number>;
  lastX: number;
  lastY: number;
  /** 二.3 store 写合帧：pointermove 高回报率（125–1000Hz）下逐事件 setDockDrag
   *  会让 InsertBar 逐事件重渲；d.to/outside 同步维护（endDrag 语义不变），
   *  仅把 React 可见的 store 写合并到每帧一次。 */
  raf: number;
  framePending: boolean;
  px: number;
  py: number;
  pi: number;
  po: boolean;
  /** 横滚自动滚动：>8 枚溢出模式下指针停在容器左右缘带内时的持续滚动
   *  方向（-1/0/1，updateDrag 事件时刻判定）；autoRaf 为独立常驻帧循环句柄
   *  （指针静止也要持续滚，不能复用合帧的「有事件才挂帧」机制）。 */
  autoDir: -1 | 0 | 1;
  autoRaf: number;
  /** document 级 lostpointercapture 监听（被拖磁贴被卸载时该事件派发到
   *  document 而非元素，React 挂在根容器上的合成监听收不到），收会话用。 */
  onLost: (e: PointerEvent) => void;
};

type Props = {
  tiles: DockTileModel[];
  takeoverActive: boolean;
  /** 岛体收合（自动隐藏）：磁贴退出 Tab 序（岛根已 aria-hidden，可聚焦子元素
   *  会构成非法的 aria-hidden 焦点链）。缺省 false（测试挂载免传）。 */
  tucked?: boolean;
  registerTileRef: (tileId: string, el: HTMLButtonElement | null) => void;
  onTileOpen: (tile: DockTileModel) => void;
};

/* memo——DockShell 的高频瞬态 state（hover 微涨 peak / 自动隐藏 revealed /
 * 拖动 dragging / 展开原点 origins）每次翻转都重渲磁贴层。props 引用全部稳定
 * （tiles 数组未变时引用不变、布尔项极少翻转、registerTileRef / onTileOpen 是
 * useCallback），套 memo 后这些纯壳层动画不再触达磁贴子树；tiles 真正变化时
 * 照常重渲。 */
export const DockTiles = memo(function DockTiles({
  tiles,
  takeoverActive,
  tucked,
  registerTileRef,
  onTileOpen
}: Props) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const editMode = useWidgetStore((s) => s.editMode);
  const expandedId = useWidgetExpand((s) => s.expandedId);
  const forget = useWidgetExpand((s) => s.forget);
  /* takeover 当前值经 ref 供定时器 / OS 文件拖放回调在触发时刻复核——
     闭包捕获的是起拖 / 挂钩那一刻的旧值。 */
  const takeoverRef = useRef(takeoverActive);
  takeoverRef.current = takeoverActive;

  const containerRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const tileEls = useRef<Record<string, HTMLButtonElement | null>>({});
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const pendingRef = useRef<Pending | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const swallowClick = useRef(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<PopoverAnchor>({ x: 0, y: 0, w: 0, h: 0 });
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  /* is-sorting 由 React 管理——此前命令式 classList 挂的类会在
     scrollEdges / isOverflow 触发的重渲染中被 React 重写 className 抹掉
     （拖拽中滚轮横滚即触发），级联放大 / hover 过渡提前复活。 */
  const [sorting, setSorting] = useState(false);

  useEffect(() => {
    const live = new Set(tiles.map((t) => dockTileExpandId(t.id)));
    for (const id of useWidgetExpand.getState().mountedIds) {
      if (id.startsWith(DOCK_EXPAND_PREFIX) && id !== DOCK_PANEL_EXPAND_ID && !live.has(id)) forget(id);
    }
    /* tileEls 同步回收已移除磁贴的键——此前 ref 回调只置 null 不删键，
       磁贴 id 是一次性 uuid，长会话反复加删会无限累积。 */
    const liveIds = new Set(tiles.map((t) => t.id));
    for (const k of Object.keys(tileEls.current)) {
      if (!liveIds.has(k)) delete tileEls.current[k];
    }
  }, [tiles, forget]);

  const registerRef = useCallback(
    (tileId: string, el: HTMLButtonElement | null) => {
      tileEls.current[tileId] = el;
      registerTileRef(tileId, el);
    },
    [registerTileRef]
  );

  /* ---- 新磁贴入场：绘制前给新挂载的按钮加 .is-growing + .is-entering（首挂载的磁贴不算新）
          ——起始态是 0 宽 / 透明 / scale .8；强制回流提交后下一帧摘掉 .is-entering，磁贴
          从 0 宽长到自然宽、淡入放大，岛宽随之平滑变化（此前岛先瞬跳到新宽度，磁贴再
          原地弹入，看起来就是「没有动画」）。.is-growing 承载过渡与 overflow:hidden，
          ENTER_MS 后摘除。DockTile 是 CFG 会话的文件，不经 props，直接改类名。 ---- */
  const prevIds = useRef<Set<string>>(new Set(tiles.map((t) => t.id)));
  useLayoutEffect(() => {
    const prev = prevIds.current;
    prevIds.current = new Set(tiles.map((t) => t.id));
    const added = tiles.filter((t) => !prev.has(t.id)).map((t) => t.id);
    if (added.length === 0) return;
    const els = added.map((id) => tileEls.current[id]).filter((el): el is HTMLButtonElement => !!el);
    for (const el of els) el.classList.add("is-growing", "is-entering");
    // 读一次布局把收合起始态钉进渲染树，否则同帧内加了又摘等于没加，过渡不会触发。
    for (const el of els) void el.getBoundingClientRect();
    requestAnimationFrame(() => {
      for (const el of els) el.classList.remove("is-entering");
    });
    safeTimeout(() => {
      for (const el of els) el.classList.remove("is-growing");
      /* 保留时长 = CSS 生长过渡 --dur-dock-spring（animDurations 同源随速度档）
         + 余量：此前硬编码 400ms 在标准档就掐掉弹簧最后 50ms。 */
    }, animDurations().dockSpringMs + 60);
  }, [tiles, safeTimeout]);

  /* ---- >8 枚横向可滚：滚轮转横滚 + 两端渐隐 ---- */
  const isOverflow = tiles.length > OVERFLOW_TILE_COUNT;
  const updateEdges = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setScrollEdges((s) => (s.left === left && s.right === right ? s : { left, right }));
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isOverflow) return;
    updateEdges();
    // React 的 onWheel 是 passive 监听，preventDefault 无效；原生非 passive 才能把竖滚接成横滚。
    const onWheel = (e: WheelEvent) => {
      /* 拖拽会话期间冻结横滚——会话快照（rects/others/originX）不随
         scrollLeft 补偿，滚了会让插入位 / 让位与实际矩形错位；松手后恢复。 */
      if (dragRef.current) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      /* wheel=cycle 时磁贴层的滚轮属于 Shell 的轮换手势——此前这里
         stopPropagation 把事件拦死，cycle 在 >8 枚（横滚模式）下只有悬停
         岛 padding 环才触发（主区域失效）。不拦冒泡（也不 preventDefault
         转横滚），让 .dock 根的 onDockWheel 收到并按节流轮换磁贴。 */
      if (useWidgetStore.getState().dock.mouse.wheel === "cycle") return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", updateEdges, { passive: true });
    window.addEventListener("resize", updateEdges);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", updateEdges);
      window.removeEventListener("resize", updateEdges);
    };
  }, [isOverflow, tiles.length, updateEdges]);

  /* ---- 二.11 OS 文件拖到收起态磁贴----
     从资源管理器拖文件悬到磁贴上：Rust 点击穿透命中测试会把窗口切成可交互
     （widget.rs），useOsFileDrop 把物理坐标换成本窗口 CSS 坐标——对磁贴矩形
     命中即「收下」。当前消费方：
       · notes（便签磁贴）：每个文件追加一条路径便签（notes-store 自带变更
         广播，画布同实例便签同步）；
       · 其余类型：同类工具 语义 = 「磁贴声明收文件 → 自动展开详情页交给组件」，
         Vela 的通用兜底是展开该磁贴面板 + toast 列出路径（用户在面板里继续
         操作），不假装消费了文件。 */
  const onTileOpenRef = useRef(onTileOpen);
  onTileOpenRef.current = onTileOpen;
  useOsFileDrop((e) => {
    if (e.type !== "drop" || e.paths.length === 0) return;
    /* 接管期间磁贴层 opacity:0 隐藏——文件命中「隐形磁贴」不应静默写入
       便签 / 展开看不见的面板，等接管结束再拖。 */
    if (takeoverRef.current) return;
    const hit = tilesRef.current.find((t) => {
      const r = tileEls.current[t.id]?.getBoundingClientRect();
      return !!r && e.x >= r.left && e.x <= r.right && e.y >= r.top && e.y <= r.bottom;
    });
    if (!hit) return;
    if (hit.type === "notes") {
      const instanceId = dockTileInstanceId(hit);
      const notes = loadNotes(instanceId);
      const at = new Date().toISOString();
      const added: Note[] = e.paths.map((p, i) => ({
        id: crypto.randomUUID(),
        text: p,
        updatedAt: new Date(Date.parse(at) + i).toISOString()
      }));
      saveNotes(instanceId, [...notes, ...added]);
      pushAppToast(tr("已存入便签磁贴"), `${e.paths.length} ${tr("个文件路径")}`, "ok");
      return;
    }
    onTileOpenRef.current(hit);
    pushAppToast(tr("已展开磁贴"), `${e.paths.join("\n").slice(0, 300)}`, "info");
  });

  /* ---- 拖动 ---- */

  /** 事件目标 → 所属磁贴（幽灵克隆在 body 下、「+」类名不同，均不命中）。 */
  const findTile = (
    target: EventTarget | null
  ): { tile: DockTileModel; index: number; el: HTMLButtonElement } | null => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLButtonElement>(TILE_SELECTOR) ?? null;
    if (!el || !containerRef.current?.contains(el)) return null;
    const list = tilesRef.current;
    for (let i = 0; i < list.length; i++) {
      if (tileEls.current[list[i].id] === el) return { tile: list[i], index: i, el };
    }
    return null;
  };

  const clearPending = () => {
    const p = pendingRef.current;
    if (p?.timer != null) window.clearTimeout(p.timer);
    pendingRef.current = null;
  };

  /** 移除 + 可撤销 toast（拖出 / Delete 共用）：撤销把原 tile 插回原 index。
   *  toast 副标走 dockTileDisplayName——绑定实例的重命名跟着显示（口径）。
   *  undo 先取消延迟清理（磁贴私有数据随 undo 完整恢复）；toast 关闭
   *  （onDismiss）时立即执行未取消的清理——撤销窗口与 toast 生命周期精确同步。 */
  const removeWithUndo = (tile: DockTileModel, index: number) => {
    useWidgetStore.getState().removeDockTile(tile.id);
    pushAppToast(tr("已从灵动岛移除"), dockTileDisplayName(tile, useWidgetStore.getState().instances, tr), "info", {
      action: {
        label: tr("撤销"),
        run: () => {
          cancelDockTileDataRemoval(tile.id);
          const restore = () => {
            useWidgetStore.getState().addDockTile(tile, index);
            /* undo 恢复被入岛去重拦截（撤销窗口内对端 / 用户加了同身份
               磁贴，findDockTileConflict 静默 no-op）时给出显式反馈——「点了
               撤销没反应」比明确提示更糟。 */
            if (!useWidgetStore.getState().dock.tiles.some((t) => t.id === tile.id)) {
              pushAppToast(tr("无法恢复"), tr("同类型小组件已在灵动岛上"), "info");
            }
          };
          const c = containerRef.current;
          if (c) flipReorder(c, DOCK_FLIP_SELECTOR, restore);
          else restore();
        }
      },
      onDismiss: () => finalizeDockTileDataRemoval(tile.id)
    });
  };

  const applyShifts = (d: Drag) => {
    const list = tilesRef.current;
    const shifts = reorderShifts(list.length, d.from, d.to, d.stride, d.outside);
    for (let j = 0; j < list.length; j++) {
      if (j === d.from) continue;
      const s = shifts.get(j) ?? 0;
      /* 不做「值相同即跳过」的幂等优化——FLIP 落位后的兜底清理定时器
         （flipReorder）可能在拖拽进行中把内联 transform 清空，跳过会让让位
         预览缺失直到跨入新槽位；每帧重写的代价可忽略。 */
      const el = tileEls.current[list[j].id];
      if (el) el.style.transform = s ? `translate3d(${s}px, 0, 0)` : "";
    }
    d.shifts = shifts;
  };

  const updateDrag = (d: Drag, x: number, y: number) => {
    d.lastX = x;
    d.lastY = y;
    // 幽灵 transform 是布局单位：视觉位移 ÷zoom（ui-zoom 坐标模型）。
    const z = uiZoom();
    d.ghost.style.transform = `translate3d(${(x - d.sx) / z}px, ${(y - d.sy) / z}px, 0) scale(1.04)`;
    const outside = distanceToRect(x, y, d.island) >= REMOVE_DISTANCE_PX;
    const to = outside ? d.to : insertionIndexAt(d.others, x);
    // 二.3 合帧：离散状态变化（跨插入位 / 进出岛界）立即同步写——低频且语义
    // 关键（插入竖条预览、拟移除态必须即时可见）；连续的指针坐标更新合并到
    // 每帧一次（挂帧回调读 d.px/py 最新值，非事件时刻快照）。
    d.px = x;
    d.py = y;
    d.pi = to;
    d.po = !outside;
    /* 横滚模式下的自动滚动方向（指针停在缘带内时由常驻帧循环驱动，
       指针静止也持续滚——无法复用下方「有事件才挂帧」的合帧机制）。 */
    const cr = containerRef.current?.getBoundingClientRect();
    if (cr && isOverflow && !outside) {
      const EDGE = 36;
      d.autoDir = x < cr.left + EDGE ? -1 : x > cr.right - EDGE ? 1 : 0;
    } else d.autoDir = 0;
    if (to !== d.to || outside !== d.outside) {
      d.to = to;
      d.outside = outside;
      d.ghost.classList.toggle("is-removing", outside);
      applyShifts(d);
      if (d.framePending) {
        window.cancelAnimationFrame(d.raf);
        d.framePending = false;
      }
      useWidgetStore.getState().setDockDrag({ pointer: { x, y }, overIsland: !outside, insertIndex: to });
    } else if (!d.framePending) {
      d.framePending = true;
      d.raf = window.requestAnimationFrame(() => {
        d.framePending = false;
        useWidgetStore.getState().setDockDrag({ pointer: { x: d.px, y: d.py }, overIsland: d.po, insertIndex: d.pi });
      });
    }
  };

  /* >8 枚溢出（横滚）模式的拖动排序自动滚动。指针停在容器左右缘带内
   *  时持续推进 scrollLeft（每帧 ~14px ≈ 840px/s），并把 ΔS **同步补偿进快照**
   *  （rects 元素与 others 共享引用，就地平移 left；originX 同步减 ΔS）——
   *  插入位判定 / 让位 transform / 竖条预览因此始终与滚动后的实际矩形一致，
   *  松手落点按补偿后的快照求位，不破坏「拖拽会话冻结外部滚轮」的既有纪律
   *  （onWheel 的 dragRef 守卫不变，滚动的唯一来源就是这个循环）。 */
  const startAutoScroll = (d: Drag) => {
    /* raf: ok 拖拽会话域循环——起停随 drag（endDrag 必 cancel autoRaf），
       窗口隐藏期间不可能有活跃拖拽会话，无需再加 reduce-motion/hidden
       健康信号（补注记归零 check-js-anim 告警）。 */
    const tick = () => {
      d.autoRaf = window.requestAnimationFrame(tick);
      if (!d.autoDir) return;
      const c = containerRef.current;
      if (!c || c.scrollWidth <= c.clientWidth) return;
      const before = c.scrollLeft;
      c.scrollLeft = Math.max(0, Math.min(c.scrollWidth - c.clientWidth, before + d.autoDir * 14));
      const ds = c.scrollLeft - before;
      if (!ds) return;
      // 快照补偿：磁贴视觉 left 随滚动平移 −ΔS；originX（视口 left − scrollLeft）同移。
      for (const r of d.rects) r.left -= ds;
      d.originX -= ds;
      // 让位与竖条按补偿后的快照重算（指针未动而矩形动了，槽位可能翻转）。
      const to = d.outside ? d.to : insertionIndexAt(d.others, d.px);
      if (to !== d.to) {
        d.to = to;
        d.pi = to;
        applyShifts(d);
      }
      useWidgetStore.getState().setDockDrag({ pointer: { x: d.px, y: d.py }, overIsland: d.po, insertIndex: to });
    };
    d.autoRaf = window.requestAnimationFrame(tick);
  };

  const endDragRef = useRef<(cancelled: boolean) => void>(() => {});
  /** 拖动期间 Esc = 原位放回（capture 拦截，不让别处的 Esc 监听抢先）。 */
  const onDragKey = useRef((e: KeyboardEvent) => {
    if (e.key !== "Escape" || !dragRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    endDragRef.current(true);
  }).current;

  const beginDrag = (p: Pending, x: number, y: number) => {
    clearPending();
    const container = containerRef.current;
    const source = tileEls.current[p.tile.id];
    const list = tilesRef.current;
    const from = list.findIndex((t) => t.id === p.tile.id);
    if (!container || !source || from < 0) return;
    const rects: Rect[] = list.map((t) => {
      const r = tileEls.current[t.id]?.getBoundingClientRect();
      return { left: r?.left ?? 0, width: r?.width ?? 0 };
    });
    const gap = rects.length > 1 ? Math.max(0, rects[1].left - rects[0].left - rects[0].width) : DOCK_TILE_GAP_PX;
    const stride = rects[from].width + gap;
    const ir = (container.closest<HTMLElement>(".dock") ?? container).getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    const sr = source.getBoundingClientRect();

    const ghost = document.createElement("div");
    ghost.className = "dock-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    // 非编辑模式下窗口按交互矩形穿透（useClickThrough）：幽灵跟手上报矩形，拖出岛外时指针
    // 所在处仍保持可交互，pointerup 才能回到本窗口。
    ghost.setAttribute("data-interactive", "");
    // fixed 元素的 left/top 是布局单位：gBCR 视觉值 ÷zoom（ui-zoom 坐标模型）。
    const z = uiZoom();
    ghost.style.left = `${sr.left / z}px`;
    ghost.style.top = `${sr.top / z}px`;
    ghost.style.width = `${sr.width / z}px`;
    ghost.style.height = `${sr.height / z}px`;
    const clone = source.cloneNode(true) as HTMLElement;
    for (const attr of ["tabindex", "aria-label", "aria-expanded", "title", "data-interactive"])
      clone.removeAttribute(attr);
    clone.classList.remove("is-drag-source", "is-entering", "is-growing");
    ghost.appendChild(clone);
    document.body.appendChild(ghost);

    source.classList.add("is-drag-source");
    setSorting(true);
    container.classList.add("is-sorting");
    try {
      source.setPointerCapture(p.pointerId);
    } catch {
      // 极少数环境不支持捕获：仍可在岛内拖动
    }
    // stride 驱动让位 transform（布局单位）：视觉宽 + 间距 ÷zoom。
    const strideLayout = stride / z;
    const reduce = prefersReducedMotion();
    const { ease, durMs } = pickSpatialEase(stride);
    for (const t of list) {
      const el = tileEls.current[t.id];
      if (el && el !== source) el.style.transition = reduce ? "none" : `transform ${durMs}ms ${ease}`;
    }
    const d: Drag = {
      tile: p.tile,
      from,
      pointerId: p.pointerId,
      sx: p.sx,
      sy: p.sy,
      rects,
      others: rects.filter((_, i) => i !== from),
      island: { left: ir.left, top: ir.top, right: ir.right, bottom: ir.bottom },
      originX: cr.left - container.scrollLeft,
      stride: strideLayout,
      ghost,
      source,
      to: from,
      outside: false,
      shifts: new Map(),
      lastX: x,
      lastY: y,
      raf: 0,
      framePending: false,
      px: x,
      py: y,
      pi: from,
      po: true,
      autoDir: 0,
      autoRaf: 0,
      onLost: () => {}
    };
    // 捕获目标（源磁贴）被卸载时 lostpointercapture 派发到 document——
    // 原生监听代收，收会话（原位放回），否则幽灵滞留 + dragRef 残留把排序卡死。
    d.onLost = (ev: PointerEvent) => {
      if (dragRef.current !== d || ev.pointerId !== d.pointerId) return;
      endDragRef.current(true);
    };
    document.addEventListener("lostpointercapture", d.onLost);
    dragRef.current = d;
    window.addEventListener("keydown", onDragKey, true);
    // 溢出模式常驻自动滚动帧循环（会话结束在 endDrag 取消）。
    if (isOverflow) startAutoScroll(d);
    // 初始拖动态同步写一次（二.3 合帧的例外：to/outside 与初值相同属「非离散」，
    // 不写会让竖条预览/dockDrag 在起拖首帧为 null）。
    useWidgetStore.getState().setDockDrag({ pointer: { x, y }, overIsland: true, insertIndex: from });
    updateDrag(d, x, y);
  };

  const endDrag = (cancelled: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    // 二.3：作废挂帧中的 store 写——endDrag 随后 clearDockDrag，晚到的帧会写回陈旧拖动态。
    if (d.framePending) window.cancelAnimationFrame(d.raf);
    // 停自动滚动帧循环（先停再 clearDockDrag，防晚到帧写回陈旧拖动态）。
    window.cancelAnimationFrame(d.autoRaf);
    document.removeEventListener("lostpointercapture", d.onLost);
    window.removeEventListener("keydown", onDragKey, true);
    // 松手后紧随的 click 落在同一按钮上：吞掉，不触发展开（长按 / 拖动都不算点击）。
    /* 复位挂在下一次 pointerdown（见 onPointerDown 首行）而非 setTimeout(0)——
       长帧下 click 可能晚于定时器到达，标志已复位，点击漏吞误触发展开。本次
       手势的 click 一定先于任何新 pointerdown，不会误吞下一次正常点击。 */
    swallowClick.current = true;
    try {
      d.source.releasePointerCapture(d.pointerId);
    } catch {
      // ignore
    }
    useWidgetStore.getState().clearDockDrag();
    const container = containerRef.current;
    container?.classList.remove("is-sorting");
    setSorting(false);
    const clearInline = () => {
      for (const t of tilesRef.current) {
        const el = tileEls.current[t.id];
        if (el) {
          el.style.transform = "";
          el.style.transition = "";
        }
      }
    };
    const flip = (mutate: () => void) => {
      if (container) flipReorder(container, DOCK_FLIP_SELECTOR, mutate);
      else mutate();
    };

    if (d.outside && !cancelled) {
      // 拟移除：幽灵原地缩小淡出，其余磁贴已提前补位（FLIP 首末一致不再动）。
      if (prefersReducedMotion()) d.ghost.remove();
      else {
        d.ghost.classList.add("is-exiting");
        // 与 CSS dock-ghost-out 的 --dur-fx-fast 同源（标准档 150ms）。
        window.setTimeout(() => d.ghost.remove(), animDurations().fxFastMs + 40);
      }
      d.source.classList.remove("is-drag-source");
      flip(() => {
        clearInline();
        removeWithUndo(d.tile, d.from);
      });
      return;
    }

    // 落位 / 放回：本体先跳到幽灵所在位置再撤幽灵，flipReorder 以此为 First 回弹到目标槽。
    // 视觉位移 ÷zoom（源磁贴在 zoomed 容器内，transform 是布局单位）。
    const zEnd = uiZoom();
    d.source.style.transition = "none";
    d.source.style.transform = `translate3d(${(d.lastX - d.sx) / zEnd}px, ${(d.lastY - d.sy) / zEnd}px, 0) scale(1.04)`;
    d.source.classList.remove("is-drag-source");
    d.ghost.remove();
    const moved = !cancelled && d.to !== d.from;
    flip(() => {
      clearInline();
      if (moved) useWidgetStore.getState().moveDockTile(d.tile.id, d.to);
    });
  };
  endDragRef.current = endDrag;

  /* 拖拽会话对 tiles 变更零防御此前是两处缺陷的共根——会话进行中
     tiles 被整体替换（跨窗 applyRemoteDock / 另一窗口删除触发 reconcile 降级），
     快照（rects/from/to/shifts）与新列表错位、被拖磁贴可能已不存在。任何
     tiles 引用变化发生在会话中即原位放回（本窗 moveDockTile 的提交发生在
     endDrag 之后，届时 dragRef 已置 null，不会被本守卫误吞）。 */
  useEffect(() => {
    if (dragRef.current) endDragRef.current(true);
  }, [tiles]);

  /* 卸载兜底：拖动中被整层卸载（关岛）时清掉幽灵与监听。 */
  useEffect(
    () => () => {
      const d = dragRef.current;
      if (d) {
        window.cancelAnimationFrame(d.raf);
        window.cancelAnimationFrame(d.autoRaf);
        document.removeEventListener("lostpointercapture", d.onLost);
        d.ghost.remove();
        dragRef.current = null;
      }
      window.removeEventListener("keydown", onDragKey, true);
      const p = pendingRef.current;
      if (p?.timer != null) window.clearTimeout(p.timer);
      useWidgetStore.getState().clearDockDrag();
    },
    [onDragKey]
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 上一次会话遗留的吞点击标志随新手势复位（click 只在 pointerdown 之后到达）。
    swallowClick.current = false;
    if (e.button !== 0 || takeoverActive || dragRef.current) return;
    const hit = findTile(e.target);
    if (!hit) return;
    clearPending();
    const pending: Pending = {
      tile: hit.tile,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      timer: null
    };
    if (!editMode) {
      pending.timer = window.setTimeout(() => {
        if (pendingRef.current !== pending) return;
        /* 等待期内接管条出现（磁贴层已隐藏）→ 放弃起拖，否则会在
           隐形磁贴层上开一场看不见的拖拽。 */
        if (takeoverRef.current) {
          clearPending();
          return;
        }
        pending.timer = null;
        beginDrag(pending, pending.sx, pending.sy);
      }, TILE_DRAG_LONG_PRESS_MS);
    }
    pendingRef.current = pending;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      if (e.pointerId === d.pointerId) updateDrag(d, e.clientX, e.clientY);
      return;
    }
    const p = pendingRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const dx = Math.abs(e.clientX - p.sx);
    const dy = Math.abs(e.clientY - p.sy);
    if (editMode) {
      if (dx >= DRAG_THRESHOLD_PX || dy >= DRAG_THRESHOLD_PX) beginDrag(p, e.clientX, e.clientY);
    } else if (dx > LONG_PRESS_SLOP_PX || dy > LONG_PRESS_SLOP_PX) {
      clearPending();
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      if (e.pointerId === d.pointerId) {
        updateDrag(d, e.clientX, e.clientY);
        endDrag(false);
      }
      return;
    }
    // 普通点击：放行给 DockTile 的 onClick 展开。
    if (pendingRef.current?.pointerId === e.pointerId) clearPending();
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      if (e.pointerId === d.pointerId) endDrag(true);
      return;
    }
    clearPending();
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  /* ---- 键盘 ---- */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || dragRef.current) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !container.contains(active)) return;
    /* 焦点可能落在磁贴内嵌的可聚焦控件上（音乐磁贴的播放钮等）——
       closest 归一化到磁贴 / 「+」槽位再取下标，否则 indexOf 得 -1 直接
       return，←/→/Home/End/Delete 在该焦点位全部失效（键盘导航死区）。 */
    const seat = active.closest<HTMLElement>(DOCK_FLIP_SELECTOR);
    if (!seat) return;
    const focusables = Array.from(container.querySelectorAll<HTMLElement>(DOCK_FLIP_SELECTOR));
    const pos = focusables.indexOf(seat);
    if (pos < 0) return;
    const hit = findTile(seat);
    const ctrl = e.ctrlKey || e.metaKey;
    // 岛内消费的按键不再冒泡到 window：编辑模式下 WidgetCard 的全局 keydown 会把同一次
    // ←/→/Delete 施加到画布上被选中的卡片（与 BarGrip 同一防双触发口径）。
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      /* Ctrl+Shift+←/→ 是 DockShell 的「跳相邻吸附点」快捷键——此前
         箭头分支无条件 consume()（含 stopPropagation），该组合在磁贴焦点位
         被当成 Ctrl+← 执行了磁贴排序，Shell 层永远收不到。不消费、原样
         冒泡让位（纯 Shift+←/→ 无 Shell 语义，仍走本层的焦点移动）。 */
      if (ctrl && e.shiftKey) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      consume();
      if (ctrl) {
        if (!hit) return;
        const target = hit.index + dir;
        if (target < 0 || target >= tilesRef.current.length) return;
        flipReorder(container, DOCK_FLIP_SELECTOR, () => useWidgetStore.getState().moveDockTile(hit.tile.id, target));
        return;
      }
      focusables[Math.min(focusables.length - 1, Math.max(0, pos + dir))]?.focus();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      consume();
      focusables[e.key === "Home" ? 0 : focusables.length - 1]?.focus();
      return;
    }
    if (e.key === "Delete" && hit) {
      consume();
      const list = tilesRef.current;
      const neighbor = list[hit.index + 1] ?? list[hit.index - 1];
      flipReorder(container, DOCK_FLIP_SELECTOR, () => removeWithUndo(hit.tile, hit.index));
      requestAnimationFrame(() => (neighbor ? tileEls.current[neighbor.id] : addRef.current)?.focus());
    }
  };

  /* ---- 「+」磁贴 → 类型选择器 ---- */
  const openPicker = () => {
    const r = addRef.current?.getBoundingClientRect();
    if (r) setPickerAnchor({ x: r.left, y: r.top, w: r.width, h: r.height });
    setPickerOpen(true);
  };
  const closePicker = useCallback((reason: PickerCloseReason) => {
    setPickerOpen(false);
    // 外点关闭时焦点正转移到点中的元素，不抢回；Esc / × / 选中后回到「+」。
    if (reason !== "outside") requestAnimationFrame(() => addRef.current?.focus({ preventScroll: true }));
  }, []);
  const pickType = (type: string) => {
    /* 入岛去重在选取时预判——pickerTypeDisabled 只按「无实例候选」判定，
       挡不住 timetable 这类自动绑定实例的类型（岛上已有绑定实例的课程表磁贴
       时条目仍可点，addDockTile 按实例冲突静默 no-op）。与画布拖入路径
       （WidgetCard 的「已在灵动岛」toast）同口径：冲突时提示而不是无声失败。 */
    const st = useWidgetStore.getState();
    const cand = createDockTileAutoBound(type);
    if (findDockTileConflict(st.dock.tiles, cand)) {
      pushAppToast(tr("已在灵动岛"), dockTileDisplayName(cand, st.instances, tr), "info");
      closePicker("pick");
      return;
    }
    const add = () => useWidgetStore.getState().addDockTile(cand);
    const c = containerRef.current;
    if (c) flipReorder(c, DOCK_FLIP_SELECTOR, add);
    else add();
    closePicker("pick");
  };
  /* 入岛去重（widget-store.findDockTileConflict）：按该类型的**实际入岛形态**
     （createDockTileAutoBound 会为 timetable 绑定实例）预判冲突 → 选择器禁用。 */
  const pickerTypeDisabled = useCallback(
    (type: string) => !!findDockTileConflict(tiles, createDockTileAutoBound(type)),
    [tiles]
  );
  useEffect(() => {
    if (!editMode) setPickerOpen(false);
  }, [editMode]);

  const showAdd = editMode && !takeoverActive;
  const className =
    "dock-tiles" +
    (isOverflow ? " is-overflow" : "") +
    (isOverflow && scrollEdges.left ? " can-scroll-left" : "") +
    (isOverflow && scrollEdges.right ? " can-scroll-right" : "") +
    (sorting ? " is-sorting" : "");

  return (
    <div
      ref={containerRef}
      className={className}
      aria-hidden={takeoverActive}
      /* blank=panel 的空白命中区——本层背景（磁贴之间的空隙）算「点空白」，
         DockShell.onShellClick 按 data-dock-blank 识别；磁贴按钮自身不匹配。 */
      data-dock-blank=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
    >
      {tiles.map((tile) => (
        /* 单磁贴错误边界：任一迷你形态抛错只灰化该磁贴，不再连坐整岛
           （DockShell 的外层边界 fallback=null 会把整条岛静默卸载）。 */
        <WidgetErrorBoundary
          key={tile.id}
          instanceId={tile.instanceId ?? tile.id}
          type={`dock-tile:${tile.type}`}
          fallback={null}
        >
          <DockTile
            tile={tile}
            takeoverActive={takeoverActive}
            tucked={!!tucked}
            isOpen={expandedId === dockTileExpandId(tile.id)}
            registerRef={registerRef}
            onOpen={onTileOpen}
          />
        </WidgetErrorBoundary>
      ))}
      {showAdd && (
        <button
          ref={addRef}
          type="button"
          className="dock-tile-add"
          onClick={openPicker}
          aria-label={tr("添加磁贴")}
          title={tr("添加磁贴")}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          tabIndex={tucked ? -1 : undefined}
          data-interactive
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      )}
      <InsertBar containerRef={containerRef} tileEls={tileEls} tilesRef={tilesRef} dragRef={dragRef} />
      <DockTypePicker
        anchor={pickerAnchor}
        open={pickerOpen}
        onClose={closePicker}
        onPick={pickType}
        isTypeDisabled={pickerTypeDisabled}
      />
    </div>
  );
});

/**
 * 插入位预览竖条：订阅 widget-store.dockDrag（岛内排序 / 画布卡片拖入共用），
 * 独立订阅避免每帧指针更新重渲整层磁贴。岛内排序时按缓存矩形 + 让位规则算落位
 * 空槽中心；外部拖入时按当前磁贴矩形取 insertIndex 前后两枚的间隙中点。
 */
function InsertBar({
  containerRef,
  tileEls,
  tilesRef,
  dragRef
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  tileEls: MutableRefObject<Record<string, HTMLButtonElement | null>>;
  tilesRef: MutableRefObject<DockTileModel[]>;
  dragRef: MutableRefObject<Drag | null>;
}) {
  /* 细粒度订阅：竖条位置只依赖布尔命中与离散槽位（连续指针坐标不影响 x），
     此前整对象订阅让岛内排序每个合帧都重渲一次本组件 + 重跑 layout effect。 */
  const overIsland = useWidgetStore((s) => s.dockDrag?.overIsland ?? false);
  const insertIndex = useWidgetStore((s) => s.dockDrag?.insertIndex ?? 0);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    const c = containerRef.current;
    if (!bar || !c || !overIsland) return;
    // 竖条 transform 是 zoomed 容器内的布局单位：容器内偏移（视觉）÷zoom。
    const z = uiZoom();
    const d = dragRef.current;
    let x: number;
    if (d) {
      x = (insertionBarX(d.rects, d.from, d.to) - d.originX) / z;
    } else {
      const rects = tilesRef.current
        .map((t) => tileEls.current[t.id]?.getBoundingClientRect())
        .filter((r): r is DOMRect => !!r);
      const cr = c.getBoundingClientRect();
      const origin = cr.left - c.scrollLeft;
      if (rects.length === 0) {
        x = cr.width / 2 / z;
      } else {
        const i = Math.min(Math.max(0, insertIndex), rects.length);
        /* 首尾留白与 DockDropZone 同源（DOCK_TILE_GAP_PX / 2，视觉值
           ×z）——此前硬编码 ±3px 与 gap=4 的半值差 1px，且违背「gap 单点化」
           纪律（dock-logic 头注）。 */
        const pad = (DOCK_TILE_GAP_PX / 2) * z;
        const vx =
          i === 0
            ? rects[0].left - pad
            : i === rects.length
              ? rects[rects.length - 1].right + pad
              : (rects[i - 1].right + rects[i].left) / 2;
        x = (vx - origin) / z;
      }
    }
    bar.style.transform = `translate3d(${x - 1}px, 0, 0)`;
  }, [overIsland, insertIndex, containerRef, tileEls, tilesRef, dragRef]);
  if (!overIsland) return null;
  return <span ref={ref} className="dock-insert-bar" aria-hidden="true" />;
}
