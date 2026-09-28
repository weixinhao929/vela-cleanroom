/* eslint-disable react-refresh/only-export-components */
/**
 * 单磁贴（ISLAND-CORE）：按 registry 分派内容 + 点击展开。
 *
 * - 磁贴内容：`meta.MiniComponent`（懒加载独立 chunk，Suspense 兜底）→ 否则
 *   GenericMiniTile = meta.icon + meta.name（+ 可选 miniSummary 一行摘要）。
 *   所有 registry 类型都能入岛，只是有无富形态（F-1）。
 * - 点击：expand-store 单值互斥，id = dock:<tile.id>（dock-logic.dockTileExpandId）；
 *   已展开再点 = 收起。原矩形由 DockShell 在展开瞬间从按钮 rect 采集。
 * - 展开内容 DockTileExpanded：内置三面板（时钟 / 番茄钟 / 通知，与 2.0 前
 *   完全一致）→ `meta.ExpandedComponent`（音乐沉浸页 / 天气站 / 任务全览）→
 *   完整 `meta.component` 装进 WidgetExpandOverlay（尺寸取面板内）。
 * - 右键 / 长按 600ms 松手（ISLAND-CFG · F-7）→ ContextMenu：配置 / 从灵动岛移除
 *   （可撤销 toast）/ 在画布中定位（有 instanceId：选中 + 脉冲 1.2s）/ 更多设置
 *   （有 instanceId 跳实例页，否则跳「灵动岛」页；pending-nav 双通道同 WidgetCard）。
 *   「配置」弹层锚定磁贴矩形：有 instanceId 直接用 B1 的 WidgetConfigPopover（读写
 *   该实例 widget-config，画布卡片同步）；无 instanceId 用本文件的
 *   DockTileConfigPopover——同一套 QUICK_CONFIG_FIELDS / 控件 / .wcfg-* 样式，只是
 *   读写 DockTile.config（setDockTileConfig，随 dock 配置按屏落盘）。长按期间指针
 *   位移 > 4px 即取消——与 DockTiles（SORT）的手势叠而不撞：非编辑模式 300ms 先
 *   起拖（磁贴微抬），继续按住到 600ms 原地松手则弹菜单，拖开则只排序不弹菜单。
 *   拖动排序 / 键盘操作（F-3 / F-12）由 SORT 会话在 DockTiles 内补齐。
 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { Crosshair, Pause, Play, RotateCcw, Settings, SlidersHorizontal, Trash2, type LucideIcon } from "lucide-react";
import { useT } from "../../i18n-lite";
import { isTauri, openSettingsWindow } from "../../lib/tauri";
import { flipReorder } from "../../lib/anim";
import { useNow } from "../../lib/use-now";
import { openContextMenu } from "../../components/ContextMenu";
import { pushAppToast } from "../../components/ToastHost";
import { useAppStore } from "../../store/app-store";
import { useSettingsStore } from "../../store/settings-store";
import { QUICK_CONFIG_FIELDS } from "../quick-config-fields";
import { useWidgetExpand } from "../expand-store";
import { getWidgetMeta } from "../registry";
import { currentScreenId, useWidgetStore, type DockTile as DockTileModel } from "../widget-store";
import { locateInstanceOnCanvas } from "../locate-widget";
import { WidgetConfigPopover, type PopoverAnchor } from "../WidgetConfigPopover";
import { NotificationCenterList } from "../notifications/NotificationCenterList";
import { PomodoroRing, usePomodoroView } from "../widgets/mini/PomodoroMini";
import {
  dockTileExpandId,
  dockTileInstanceId,
  DOCK_FLIP_SELECTOR,
  formatClock,
  formatMMSS,
  seedDockTileConfig,
  TILE_MENU_LONG_PRESS_MS
} from "./dock-logic";

/** 磁贴的显示名（registry name，调用方再 tr()）；未知类型退回类型 id。 */
export function dockTileTitle(tile: DockTileModel): string {
  return getWidgetMeta(tile.type)?.name ?? tile.type;
}

/* ------------------------------------------------------------------ *
 * 通用磁贴：无富形态的类型显示 图标 + 名称（+ 摘要）
 * ------------------------------------------------------------------ */
function GenericMiniTile({ icon: Icon, name, summary }: { icon?: LucideIcon; name: string; summary?: string }) {
  return (
    <span className="dock-tile-generic">
      {Icon && <Icon size={14} />}
      <span className="dock-tile-generic-name">{name}</span>
      {summary && <span className="dock-tile-generic-summary">{summary}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 右键 / 长按菜单（F-7）
 * ------------------------------------------------------------------ */

/** 长按呼出菜单阈值（F-7）：P3 单点化，常量收进 dock-logic（TILE_MENU_LONG_PRESS_MS）
 *  ——此前与 DockTiles 的拖动长按（300ms）同名不同值，极易误引。取消位移与
 *  DockTiles 编辑模式起拖阈值同为 4px——一旦算作拖动就不再算长按，排序与菜单
 *  永不同帧触发。 */
const LONG_PRESS_MS = TILE_MENU_LONG_PRESS_MS;
const LONG_PRESS_CANCEL_PX = 4;
/** 「在画布中定位」的高亮时长。 */

/**
 * 呼出设置窗口并直达某页（WidgetConfigPopover.openWidgetSettingsPage 的通用版）。
 * 磁贴的设置页统一是 `dock-tile-<tileId>`（完整组件设置 + 灵动岛磁贴区），
 * 绑定实例与否则由页面内部处理。Tauri 事件 + localStorage
 * pending-nav 双通道，载荷带 screenId 让对端先切管理分区。
 */
function openSettingsPageTo(page: string): void {
  const screenId = currentScreenId();
  useSettingsStore.getState().setSettingsPage(page);
  try {
    localStorage.setItem("focus-desk.pending-nav", JSON.stringify({ page, screenId }));
  } catch {
    // best-effort
  }
  if (isTauri()) {
    void openSettingsWindow();
    void import("@tauri-apps/api/event").then(({ emit }) => emit("app:navigate-settings", { page, screenId }));
  } else {
    useSettingsStore.getState().setSettingsOpen(true);
  }
}

type Props = {
  tile: DockTileModel;
  /** 接管层可见期间磁贴层整体隐藏：磁贴不可聚焦、迷你形态 active=false。 */
  takeoverActive: boolean;
  isOpen: boolean;
  registerRef: (tileId: string, el: HTMLButtonElement | null) => void;
  onOpen: (tile: DockTileModel) => void;
};

export function DockTile({ tile, takeoverActive, isOpen, registerRef, onOpen }: Props) {
  const tr = useT();
  const collapseIf = useWidgetExpand((s) => s.collapseIf);
  const removeDockTile = useWidgetStore((s) => s.removeDockTile);
  const addDockTile = useWidgetStore((s) => s.addDockTile);
  const meta = getWidgetMeta(tile.type);
  const id = dockTileExpandId(tile.id);
  const title = meta ? tr(meta.name) : tile.type;
  /* G8：摘要数据源订阅——miniSummary 是渲染期同步快照，按 registry 登记的
     订阅函数挂变更通知，数据变化时 bump 一拍让本磁贴重算；未登记的类型
     不订阅（摘要随其它重渲自然刷新，行为与旧版一致）。 */
  const [, bumpSummary] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const subscribe = meta?.miniSummarySubscribe;
    if (!subscribe) return;
    return subscribe(tile.instanceId, bumpSummary);
  }, [meta, tile.instanceId, bumpSummary]);
  const summary = meta?.miniSummary?.(tile.instanceId);
  const label = summary ? `${title} · ${summary}` : title;
  const Mini = meta?.MiniComponent;

  /* ---- 配置弹层（锚定磁贴矩形，打开瞬间取快照） ---- */
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [anchor, setAnchor] = useState<PopoverAnchor>({ x: 0, y: 0, w: 0, h: 0 });
  const closeConfig = useCallback(() => setConfigOpen(false), []);
  const hasPrivateFields = (QUICK_CONFIG_FIELDS[tile.type] ?? []).length > 0;
  const canConfigure = !!tile.instanceId || hasPrivateFields;

  const openMenu = (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }) => {
    const r = btnRef.current?.getBoundingClientRect();
    setAnchor(r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: e.clientX, y: e.clientY, w: 0, h: 0 });
    const instanceId = tile.instanceId;
    openContextMenu(e, [
      { label: tr("配置"), icon: <Settings size={15} />, disabled: !canConfigure, onSelect: () => setConfigOpen(true) },
      {
        label: tr("在画布中定位"),
        icon: <Crosshair size={15} />,
        disabled: !instanceId,
        onSelect: () => {
          if (instanceId) locateInstanceOnCanvas(instanceId);
        }
      },
      {
        label: tr("更多设置"),
        icon: <SlidersHorizontal size={15} />,
        onSelect: () => openSettingsPageTo(`dock-tile-${tile.id}`)
      },
      { type: "separator" },
      {
        label: tr("从灵动岛移除"),
        icon: <Trash2 size={15} />,
        danger: true,
        onSelect: () => {
          const index = useWidgetStore.getState().dock.tiles.findIndex((t) => t.id === tile.id);
          const container = btnRef.current?.closest<HTMLDivElement>(".dock-tiles") ?? null;
          /* 右键移除与键盘 Delete（DockTiles.removeWithUndo）同语言：邻居磁贴
             FLIP 平滑补位。此前裸 removeDockTile——同一操作两条路径动画不一致
             （键盘路径有 FLIP，右键路径邻居瞬跳）。 */
          const remove = () => removeDockTile(tile.id);
          if (container) flipReorder(container, DOCK_FLIP_SELECTOR, remove);
          else remove();
          pushAppToast(tr("已从灵动岛移除"), title, "ok", {
            action: {
              label: tr("撤销"),
              run: () => {
                const restore = () => addDockTile(tile, index < 0 ? undefined : index);
                const c = btnRef.current?.closest<HTMLDivElement>(".dock-tiles") ?? null;
                if (c) flipReorder(c, DOCK_FLIP_SELECTOR, restore);
                else restore();
              }
            }
          });
        }
      }
    ]);
  };

  /* ---- 长按 600ms 松手 → 菜单；位移 > 6px 取消；触发后吞掉随之而来的 click ----
     吞 click 用时间窗而非一次性标记：DockTiles（SORT）非编辑模式长按 300ms 起拖，
     松手时在容器 capture 阶段 stopPropagation 掉同一枚 click——本按钮的 onClick
     可能根本收不到，一次性标记会残留并误吞下一次正常点击。 */
  const press = useRef<{ x: number; y: number; timer: number; fired: boolean } | null>(null);
  const suppressClickUntil = useRef(0);
  const [armed, setArmed] = useState(false);
  /* 五.3 按住过程反馈：按下即挂 is-pressing（CSS 600ms 渐进压下），就位时
     is-armed 接管 0.94——此前按住 0–600ms 零反馈、缩放提示在触发那一刻才出现。
     注意走命令式 classList 而非 React state：is-drag-source/is-sorting 也是
     命令式加的，若 pressing 进 className 模板，按住移动超阈值的一帧
     （pressing 翻转 → React 重写完整 className）会把拖拽态类一并抹掉。 */
  const setPressing = (on: boolean) => {
    btnRef.current?.classList.toggle("is-pressing", on);
  };
  const clearPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setArmed(false);
    setPressing(false);
  }, []);
  useEffect(() => clearPress, [clearPress]);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    clearPress();
    setPressing(true);
    const timer = window.setTimeout(() => {
      if (press.current) {
        press.current.fired = true;
        setArmed(true);
      }
    }, LONG_PRESS_MS);
    press.current = { x: e.clientX, y: e.clientY, timer, fired: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.fired) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_CANCEL_PX) clearPress();
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const fired = press.current?.fired === true;
    clearPress();
    if (!fired) return;
    suppressClickUntil.current = performance.now() + 400;
    openMenu(e);
  };
  const onClick = () => {
    if (performance.now() < suppressClickUntil.current) return;
    if (isOpen) collapseIf(id);
    else onOpen(tile);
  };

  return (
    <>
      <button
        ref={(el) => {
          btnRef.current = el;
          registerRef(tile.id, el);
        }}
        className={`dock-tile dock-tile-${tile.type}${isOpen ? " is-open" : ""}${Mini ? "" : " is-generic"}${armed ? " is-armed" : ""}`}
        onClick={onClick}
        onContextMenu={openMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={clearPress}
        onPointerLeave={clearPress}
        title={label}
        aria-label={label}
        aria-expanded={isOpen}
        aria-keyshortcuts="Control+ArrowLeft Control+ArrowRight Delete"
        tabIndex={takeoverActive ? -1 : 0}
        data-interactive
      >
        {Mini ? (
          <Suspense fallback={<span className="dock-tile-loading" aria-hidden="true" />}>
            <Mini instanceId={tile.instanceId} active={!takeoverActive} />
          </Suspense>
        ) : (
          <GenericMiniTile icon={meta?.icon} name={title} summary={summary} />
        )}
      </button>
      {/* 配置弹层：绑定实例 → B1 弹层（实例 widget-config）；否则磁贴私有配置。 */}
      {tile.instanceId ? (
        <WidgetConfigPopover
          instanceId={tile.instanceId}
          widgetType={tile.type}
          anchor={anchor}
          open={configOpen}
          onClose={closeConfig}
        />
      ) : (
        hasPrivateFields && (
          <DockTileConfigPopoverGate tile={tile} anchor={anchor} open={configOpen} onClose={closeConfig} />
        )
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 无实例磁贴的私有配置弹层（DockTileConfigPopover.tsx）的懒加载壳：实现
 * chunk 静态依赖 config-schemas（zod schema 全家）与 M3Slider（→ motion），
 * 首次 open 翻真才拉取（与 WidgetConfigPopover 壳同范式）。
 * ------------------------------------------------------------------ */
const DockTileConfigPopoverLazy = lazy(() =>
  import("./DockTileConfigPopover").then((m) => ({ default: m.DockTileConfigPopover }))
);
function DockTileConfigPopoverGate({
  tile,
  anchor,
  open,
  onClose
}: {
  tile: DockTileModel;
  anchor: PopoverAnchor;
  open: boolean;
  onClose: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (open) setArmed(true);
  }, [open]);
  if (!armed) return null;
  return (
    <Suspense fallback={null}>
      <DockTileConfigPopoverLazy tile={tile} anchor={anchor} open={open} onClose={onClose} />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ *
 * 展开面板内容（内置三面板：自 DockContainer 迁出，行为不变）
 * ------------------------------------------------------------------ */
function ClockPanel({ active }: { active: boolean }) {
  const now = useNow(active ? 1000 : 60_000);
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return (
    <div className="dock-panel dock-panel-clock">
      <div className="dock-panel-clock-time">
        {formatClock(now)}
        <span className="dock-panel-clock-sec">{String(now.getSeconds()).padStart(2, "0")}</span>
      </div>
      <div className="dock-panel-clock-date">{date}</div>
    </div>
  );
}

function PomodoroPanel() {
  const tr = useT();
  const { remainingSeconds, isRunning, mode, progress, idle } = usePomodoroView();
  const toggle = useAppStore((s) => s.togglePomodoro);
  const reset = useAppStore((s) => s.resetPomodoro);
  const [hint, setHint] = useState("");
  const label = isRunning ? (mode === "focus" ? tr("正在专注") : tr("休息中")) : idle ? tr("空闲") : tr("暂停");
  const onToggle = () => {
    const ok = toggle();
    setHint(ok ? "" : tr("请先在番茄钟小组件中选择一个专注事件。"));
  };
  return (
    <div className="dock-panel dock-panel-pomo">
      <div className="dock-panel-pomo-ring">
        <PomodoroRing progress={progress} size={132} stroke={9} mode={mode} />
        <div className="dock-panel-pomo-center">
          <span className="dock-panel-pomo-time">{formatMMSS(remainingSeconds)}</span>
          <span className="dock-panel-pomo-label">{label}</span>
        </div>
      </div>
      <div className="dock-panel-pomo-actions">
        <button className="dock-panel-btn primary" onClick={onToggle} data-interactive>
          {isRunning ? <Pause size={14} /> : <Play size={14} />}
          {isRunning ? tr("暂停") : idle ? tr("开始专注") : tr("继续")}
        </button>
        <button className="dock-panel-btn" onClick={() => reset()} disabled={idle} data-interactive>
          <RotateCcw size={14} />
          {tr("重置")}
        </button>
      </div>
      {hint && <div className="dock-panel-hint">{hint}</div>}
    </div>
  );
}

function NotificationPanel({ active }: { active: boolean }) {
  return (
    <div className="dock-panel dock-panel-notif">
      <NotificationCenterList active={active} compact />
    </div>
  );
}

/**
 * 磁贴展开内容分派（F-1）：内置面板 → ExpandedComponent → 完整组件。
 * 后两者为懒加载 chunk，Suspense 兜底（首展由遮罩几何动画掩盖加载）。
 */
/** 「杂项」面板：需要整个 tile（布局存在 tile.config.items），不走 ExpandedComponent 的 instanceId 契约。 */
const MiscBoardPanel = lazy(() => import("../widgets/misc/MiscBoardPanel"));

export function DockTileExpanded({ tile, active }: { tile: DockTileModel; active: boolean }) {
  if (tile.type === "clock") return <ClockPanel active={active} />;
  if (tile.type === "pomodoro") return <PomodoroPanel />;
  if (tile.type === "notifications") return <NotificationPanel active={active} />;
  if (tile.type === "misc") {
    return (
      <Suspense fallback={null}>
        <MiscBoardPanel tile={tile} active={active} />
      </Suspense>
    );
  }
  return <GenericTileExpanded tile={tile} active={active} />;
}

/**
 * 通用类型的展开内容（ExpandedComponent 或完整组件）。instanceId 与全岛面板
 * 同口径：有实例用实例 id，无实例用 `dock-tile-<id>` 合成 id 并把 tile.config
 * 落种到该键——此前这里直接用 `tile.instanceId ?? ""`：所有无实例磁贴共读
 * `focus-desk.widget-config..v1` 这个全局空键（互相串配置），右键"配置"改的
 * 又是 tile.config，改刷新间隔/布局等全部无效。
 */
function GenericTileExpanded({ tile, active }: { tile: DockTileModel; active: boolean }) {
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    seedDockTileConfig(tile, false);
  }
  useEffect(() => {
    seedDockTileConfig(tile, true);
  }, [tile]);
  const meta = getWidgetMeta(tile.type);
  if (!meta) return null;
  const instanceId = dockTileInstanceId(tile);
  if (meta.ExpandedComponent) {
    const Expanded = meta.ExpandedComponent;
    return (
      <Suspense fallback={null}>
        <Expanded instanceId={instanceId} active={active} />
      </Suspense>
    );
  }
  const Full = meta.component;
  return (
    <div className="dock-panel dock-panel-full">
      <Suspense fallback={null}>
        <Full instanceId={instanceId} />
      </Suspense>
    </div>
  );
}
