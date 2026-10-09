/**
 * 桌面画布：小组件实例的布局容器与编辑器。
 *
 * 职责：按当前视图渲染全部 WidgetCard（绝对定位 + z 序）；编辑模式下提供
 * 拖拽/缩放/对齐参考线/框选/网格/对齐分发/模板保存；空白处右键弹出全局
 * 菜单（添加组件、视图管理、呼出设置）。布局持久化经 widget-store 的
 * 防抖双后端写；跨窗口广播由 cross-window 层处理。
 */
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ComponentType } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Check,
  Columns3,
  Combine,
  Dock,
  GripVertical,
  Grid3X3,
  History,
  LayoutGrid,
  LayoutTemplate,
  MoveHorizontal,
  MoveVertical,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Rows3,
  Settings,
  SquareDashed,
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { isTauri, openSettingsWindow } from "../lib/tauri";
import { appAccelMatches } from "../lib/shortcuts";
import { useSettingsStore } from "../store/settings-store";
import { useAppStore } from "../store/app-store";
import { useT, t } from "../i18n-lite";
import { getWidgetMeta } from "./registry";
import { makeResettableLazy } from "../lib/make-resettable-lazy";
import { promptViewName } from "./rename";
import { pushAppToast } from "../components/ToastHost";
import { openContextMenu } from "../components/ContextMenu";
import { useClickThrough } from "./useClickThrough";
import { uiZoom } from "../lib/ui-zoom";
import { useDelayedUnmount, prefersReducedMotion } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useSafeTimeout } from "../lib/use-safe-timeout";
import { useConfirmAction } from "../lib/use-confirm-remove";
import { useDismissable } from "../lib/use-dismissable";
import {
  hasPersistedDock,
  hasPersistedLayout,
  reconcileDockTiles,
  useWidgetStore,
  GRID,
  type WidgetInstance
} from "./widget-store";
import { loadWidgetConfig, saveWidgetConfig } from "./widget-config";
import { listStylePresets, mergeStyleConfig, type StylePreset } from "../lib/style-presets";
import { GroupCard } from "./GroupCard";
import {
  initLayoutTimeline,
  subscribeTimeline,
  getTimelineEntries,
  deltaOf,
  pinSnapshot,
  restoreSnapshot,
  clearTimeline,
  undoLayout
} from "./layout-timeline";
import { LOCATE_WIDGET_EVENT, locateInstanceOnCanvas } from "./locate-widget";
import { loadBarPos, saveBarPos, type BarKind, type BarPos, type Viewport } from "./bar-pos";
import { ensureSystemNotifyListeners } from "../lib/system-notify";
import { ensureNotificationListeners } from "./notifications/notification-store";
import { WidgetCard } from "./WidgetCard";
import { WidgetGallery } from "./WidgetGallery";
import { DockShell } from "./dock/DockShell";
import { DockShortcuts } from "./dock/DockShortcuts";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";

/* 灵动岛配置面板懒加载：其内部 M3Slider → WakeSlider 静态引入 motion/react，
   若随画布静态打进主 chunk，会让每屏小组件层/速记窗/任务栏网速条都为这
   一个滑条背走整套 motion 引擎（编辑工具栏点击「灵动岛」时才需要它）。
   入编辑模式即预热 chunk，点开面板时本地加载瞬时完成。
   可重置 loader 由此前提为共享工具（make-resettable-lazy）——chunk
   拉取失败不再缓存成永久 rejection，错误边界「重试」（onRetry 接 reset）
   重新 import。 */
const DockConfigPanelLazy = makeResettableLazy<{ closing?: boolean; style?: CSSProperties }>(
  () =>
    import("./dock/DockConfigPanel").then((m) => ({
      default: m.DockConfigPanel as ComponentType<{ closing?: boolean; style?: CSSProperties }>
    })),
  "DockConfigPanel"
);
const preloadDockConfigPanel = () => {
  void import("./dock/DockConfigPanel").catch(() => {});
};

/* 壳层（岛壳 / 岛配置面板）崩溃的一次性 toast 告警——此前 fallback=null
   崩溃即永久空白、无任何入口。「重试」再失败会在短窗内重复进边界，30s 去抖
   避免错误风暴刷屏（toast 计时经 后互不重置，不会叠加成永驻条）。 */
let shellErrToastAt = 0;
function warnShellError(detail: string): void {
  const now = Date.now();
  if (now - shellErrToastAt < 30_000) return;
  shellErrToastAt = now;
  pushAppToast(t("小组件层组件加载失败"), detail, "error");
}

/** 壳层崩溃恢复 UI（灵动岛 / 岛配置面板共用）：WidgetErrorBoundary
 *  函数式 fallback 渲染的迷你重试条——一次性 toast 已另行告警，这里给可点
 *  的「重试」入口（定位由调用方经 style 传入：岛壳贴屏底居中、面板占编辑
 *  弹层位）。复用 .widget-error 的图标 / .widget-error-retry 按钮语言。 */
function ShellErrorRetry({ label, onRetry, style }: { label: string; onRetry: () => void; style?: CSSProperties }) {
  const tr = useT();
  return (
    <div className="widget-shell-error" style={style} role="alert">
      <TriangleAlert size={16} />
      <span className="widget-error-text">{label}</span>
      <button className="widget-error-retry" onClick={onRetry} title={tr("重试")} aria-label={tr("重试")}>
        <RotateCcw size={13} />
      </button>
    </div>
  );
}

/* 默认种子（真正首次运行才播；addWidget 按级联定位，条目里的 x/y 仅示意）。
   核心三件套（番茄钟/待办/DDL）放最前——产品核心卖点必须出现在新用户
   首屏，此前种子只有工具/系统类组件。 */
const DEFAULT_SEED: { type: string; x: number; y: number }[] = [
  { type: "pomodoro", x: 24, y: 24 },
  { type: "todo", x: 620, y: 24 },
  { type: "deadlines", x: 24, y: 480 },
  { type: "shortcuts", x: 24, y: 24 },
  { type: "sysbar", x: 620, y: 24 },
  { type: "clock", x: 620, y: 100 },
  { type: "hardware", x: 24, y: 280 },
  { type: "notes", x: 360, y: 280 },
  { type: "files", x: 620, y: 280 }
];

/* 对齐/等距动作静态骨架：模块级常量（icon 是不可变 ReactNode 可安全复用），
   翻译键在使用点经 tr() 现算——避免画布每次重渲都重建整组图标元素。 */
const ALIGN_ACTION_DEFS: {
  mode: "left" | "center" | "right" | "top" | "middle" | "bottom" | "hspace" | "vspace";
  title: string;
  icon: React.ReactNode;
}[] = [
  { mode: "left", title: "左对齐", icon: <AlignStartHorizontal size={14} /> },
  { mode: "center", title: "垂直居中", icon: <AlignCenterHorizontal size={14} /> },
  { mode: "right", title: "右对齐", icon: <AlignEndHorizontal size={14} /> },
  { mode: "top", title: "顶部对齐", icon: <AlignStartVertical size={14} /> },
  { mode: "middle", title: "水平居中", icon: <AlignCenterVertical size={14} /> },
  { mode: "bottom", title: "底部对齐", icon: <AlignEndVertical size={14} /> },
  { mode: "hspace", title: "水平等距分布", icon: <MoveHorizontal size={14} /> },
  { mode: "vspace", title: "垂直等距分布", icon: <MoveVertical size={14} /> }
];

/* 默认布局种子的模块级幂等标记——StrictMode 双跑/重复挂载
   时防止对同一视图播种两次（防抖落盘窗口内的 TOCTOU）。 */
const seededViews = new Set<string>();

/* 悬浮编辑工具栏自定义位置：编辑模式下拖动把手
   调整，按屏幕分区持久化到 localStorage（镜像备份，见 bar-pos.ts），双击把手
   复位默认位置。 */

/** 当前窗口的可用视口：小组件窗口铺满整屏（含任务栏区），高度需扣掉任务栏。
 *  估算为 0（自动隐藏 / 左右竖排任务栏）时按 52px 兜底——与 bottomInset 的
 *  同款钳制对齐，避免默认布局把种子撒进隐藏的任务栏带。 */
function usableViewport(): Viewport {
  const taskbar = Math.max(window.screen.height - window.screen.availHeight, 52);
  return { width: window.innerWidth, height: window.innerHeight - taskbar };
}

/** 指针位移低于此值视为纯点击（把手可被点击以获取焦点、用方向键微移组件）。 */
const BAR_DRAG_THRESHOLD = 3;

/** 焦点正落在某个编辑弹层内时，把焦点归还它的触发按钮（面板 id ↔ 按钮
 *  aria-controls 对应）。模块级稳定引用：Esc effect 与渲染期闭包共用，
 *  不必进 effect 依赖数组。键盘用户 Esc 收面板后从触发钮继续，不必从
 *  body 重新 Tab 一轮。 */
function restorePanelFocus(): void {
  const active = document.activeElement as Element | null;
  const panel = active?.closest?.(".widget-template-panel, .dock-cfg") as HTMLElement | null;
  if (!panel) return;
  const trigger = document.querySelector(`[aria-controls="${panel.id}"]`);
  if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
}

function useBarDrag(kind: BarKind) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<BarPos | null>(() => loadBarPos(kind, usableViewport()));
  const [dragging, setDragging] = useState(false);
  // 活动拖拽期间的全局监听随组件卸载一并清理，避免隐式挂载切换时泄漏。
  const cleanupRef = useRef<(() => void) | null>(null);

  const beginDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    /* 统一布局坐标系：gBCR/指针位移是视觉坐标（含 uiZoom），落盘的 BarPos 与
       innerWidth 是布局单位——gBCR 矩形与位移都除回 zoom 再参与运算。 */
    const zoom = uiZoom();
    const origin = pos ?? { x: rect.left / zoom, y: rect.top / zoom };
    // 纯点击不落盘：否则会把随任务栏 / 分辨率自适应的默认位置冻结成一组绝对坐标。
    let moved = false;
    setDragging(true);
    const clamp = (x: number, y: number): BarPos => ({
      x: Math.round(Math.min(Math.max(0, x), Math.max(0, window.innerWidth - rect.width / zoom))),
      y: Math.round(Math.min(Math.max(0, y), Math.max(0, window.innerHeight - rect.height / zoom)))
    });
    // pointermove 逐事件 setState 是跟手路径里唯一未限帧的 React 更新：
    // rAF 合并成每帧一次（与画布卡片拖拽同范式），跟手性不变。
    let raf = 0;
    let live: BarPos | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < BAR_DRAG_THRESHOLD) return;
      moved = true;
      live = clamp(origin.x + (ev.clientX - startX) / zoom, origin.y + (ev.clientY - startY) / zoom);
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (live) setPos(live);
        });
      }
    };
    const onUp = () => {
      removeListeners();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (live) setPos(live);
      setDragging(false);
      if (moved) saveBarPos(kind, live ?? origin);
    };
    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (cleanupRef.current) cleanupRef.current = null;
    };
    cleanupRef.current = removeListeners;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const reset = () => {
    setPos(null);
    saveBarPos(kind, null);
  };

  /* 视口变小后把自定义位置收回可视区，防工具条永久出屏。gBCR 是视觉像素
     （含 uiZoom），BarPos 与 innerWidth 是布局单位——除回 zoom 再比（与
     beginDrag 的拖拽数学同一口径，此前界面缩放 ≠100% 时钳制位置偏移）。 */
  useEffect(() => {
    if (!pos) return;
    const onResize = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const zoom = uiZoom();
      const next = {
        x: Math.min(pos.x, Math.max(0, window.innerWidth - rect.width / zoom)),
        y: Math.min(pos.y, Math.max(0, window.innerHeight - rect.height / zoom))
      };
      if (next.x !== pos.x || next.y !== pos.y) {
        setPos(next);
        saveBarPos(kind, next);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  useEffect(() => () => cleanupRef.current?.(), []);

  return { ref, pos, dragging, beginDrag, reset };
}

/** 编辑模式下工具条左端的拖动把手（双击/回车复位，方向键微移选中组件）。 */
function BarGrip({
  onDown,
  onReset,
  title
}: {
  onDown: (e: React.PointerEvent) => void;
  onReset: () => void;
  title: string;
}) {
  const moveSelectedBy = useWidgetStore((s) => s.moveSelectedBy);
  return (
    <span
      className="bar-grip"
      data-interactive
      role="button"
      tabIndex={0}
      aria-label={title}
      title={title}
      onPointerDown={onDown}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onReset();
          return;
        }
        const arrows: Record<string, [number, number]> = {
          ArrowUp: [0, -GRID],
          ArrowDown: [0, GRID],
          ArrowLeft: [-GRID, 0],
          ArrowRight: [GRID, 0]
        };
        const delta = arrows[e.key];
        if (delta) {
          e.preventDefault();
          // 把手上聚焦时的方向键只走这里：阻止冒泡到 window，避免与主选中
          // 卡片的全局 keydown（WidgetCard）各执行一次 moveSelectedBy（×2 跳）。
          e.stopPropagation();
          moveSelectedBy(delta[0], delta[1]);
        }
      }}
    >
      <GripVertical size={13} />
    </span>
  );
}

/** 编辑模式下的「布局模板」面板：保存当前布局为命名模板、套用、删除。
 *  删除走两步确认：首次点击进入确认态（2 秒未确认自动解除），再次点击才真删。 */
function LayoutTemplatePanel({ closing, style }: { closing?: boolean; style?: CSSProperties }) {
  const tr = useT();
  const templates = useWidgetStore((s) => s.templates);
  const saveTemplate = useWidgetStore((s) => s.saveTemplate);
  const applyTemplate = useWidgetStore((s) => s.applyTemplate);
  const deleteTemplate = useWidgetStore((s) => s.deleteTemplate);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const { confirmingId: confirmDeleteId, request: confirmRequest } = useConfirmAction();
  /* 退场提交定时器走 safeTimeout（卸载即取消），
     对齐全文件其余定时器纪律——面板在 150ms 退场窗口内关闭时不再于卸载后
     迟到执行 store 写。 */
  const safeTimeout = useSafeTimeout();
  /* 行删除退场：确认后先播 .is-closing 收缩，播完再提交 store（不再瞬删）。 */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const requestDeleteTemplate = (id: string) => {
    if (!confirmRequest(id) || removingId) return;
    setRemovingId(id);
    safeTimeout(
      () => {
        deleteTemplate(id);
        setRemovingId((cur) => (cur === id ? null : cur));
      },
      prefersReducedMotion() ? 0 : animDurations().fxFastMs
    );
  };

  /* 套用是整视图替换（旧布局可 Ctrl+Z 找回），明确告知撤销入口；
     时间线 undoLayout 会先冲刷未落盘快照，直接调用是安全的。 */
  const doApply = (id: string) => {
    if (applyTemplate(id)) {
      pushAppToast(tr("已套用布局模板"), tr("原布局已存入时间线"), "info", {
        action: { label: tr("撤销"), run: () => void undoLayout() }
      });
    }
  };

  const doSave = () => {
    if (!name.trim()) {
      setError(tr("请输入模板名称"));
      return;
    }
    if (!saveTemplate(name)) {
      setError(tr("已存在同名模板"));
      return;
    }
    setName("");
    setError("");
  };

  return (
    <div
      id="edit-panel-templates"
      className={`widget-template-panel${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-label={tr("布局模板")}
      style={style}
      data-interactive
      onClick={(e) => e.stopPropagation()}
    >
      <div className="widget-template-head">
        <span className="widget-template-title">{tr("布局模板")}</span>
        <span className="widget-template-desc">{tr("保存当前布局，一键套用")}</span>
      </div>
      <div className="widget-template-save">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            /* 同款：IME 组词期 Enter（拼音选字确认）不提交——否则中文名
              打到一半就被半截拼音建了模板。 */
            if (e.key === "Enter" && !e.nativeEvent.isComposing) doSave();
          }}
          placeholder={tr("模板名称，如「工作台」")}
          aria-label={tr("模板名称")}
          /* 打开即聚焦名称框：面板的主路径就是「起名 → 保存」，键盘用户
             不必再 Tab 一次（placeholder 不作为可访问名，补 aria-label）。 */
          autoFocus
          data-interactive
        />
        <button className="widget-template-save-btn" onClick={doSave} data-interactive>
          <Plus size={13} /> {tr("保存")}
        </button>
      </div>
      {/* key=错误文本：同类错误连续触发时重挂载重播 shake */}
      {error && (
        <div className="widget-template-error" key={error}>
          {error}
        </div>
      )}
      {templates.length === 0 && (
        <div className="widget-template-empty">{tr("暂无模板：保存当前布局后会显示在这里")}</div>
      )}
      {templates.length > 0 && (
        <div className="widget-template-list">
          {templates.map((t, i) => (
            <div
              className={`widget-template-row${removingId === t.id ? " is-closing" : ""}`}
              key={t.id}
              style={{ "--sti": Math.min(i, 3) } as CSSProperties}
            >
              <span className="widget-template-row-name" title={tr("套用此模板")}>
                {t.name}
              </span>
              <span className="widget-template-row-count">
                {t.instances.length} {tr("个小组件")}
              </span>
              <button
                className="widget-template-row-btn"
                onClick={() => doApply(t.id)}
                title={tr("套用此模板")}
                data-interactive
              >
                <LayoutTemplate size={13} />
              </button>
              <button
                className={`widget-template-row-btn danger${confirmDeleteId === t.id ? " confirming" : ""}`}
                onClick={() => requestDeleteTemplate(t.id)}
                title={confirmDeleteId === t.id ? tr("再次点击确认删除") : tr("删除模板")}
                aria-label={confirmDeleteId === t.id ? tr("再次点击确认删除") : tr("删除模板")}
                data-interactive
              >
                {confirmDeleteId === t.id ? <Check size={13} /> : <X size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 编辑模式下的「布局历史」面板：时间轴列出自动
 *  快照（结构变更各一份），任意点恢复（恢复前当前态自动补快照，可再撤销）；
 *  pinned 快照不参与容量淘汰；清空走两步确认。
 *  与「布局模板」互斥打开（同一锚位）。 */
function LayoutHistoryPanel({ closing, style }: { closing?: boolean; style?: CSSProperties }) {
  const tr = useT();
  const view = useWidgetStore((s) => s.activeView);
  const [, force] = useState(0);
  useEffect(() => subscribeTimeline(() => force((n) => n + 1)), []);
  const entries = getTimelineEntries(view);
  const { confirmingId: confirmClear, request: confirmRequest } = useConfirmAction();

  const deltaText = (d: ReturnType<typeof deltaOf>): string => {
    const parts: string[] = [];
    if (d.added) parts.push(`+${d.added} ${tr("组件")}`);
    if (d.removed) parts.push(`−${d.removed} ${tr("组件")}`);
    if (d.groupsAdded) parts.push(`+${d.groupsAdded} ${tr("组")}`);
    if (d.groupsRemoved) parts.push(`−${d.groupsRemoved} ${tr("组")}`);
    // 既有组的成员变化（并入/摘出/重排）不改组 id 集合，单独一行呈现。
    if (d.membersMoved) parts.push(`${tr("编组调整")} ×${d.membersMoved}`);
    return parts.length ? parts.join(" · ") : tr("无结构变化");
  };

  return (
    <div
      id="edit-panel-history"
      className={`widget-template-panel${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-label={tr("布局历史")}
      style={style}
      data-interactive
      onClick={(e) => e.stopPropagation()}
    >
      <div className="widget-template-head">
        <span className="widget-template-title">{tr("布局历史")}</span>
        <span className="widget-template-desc">{tr("结构变更自动快照，点击恢复到任一时点（Ctrl+Z 撤销）")}</span>
      </div>
      {entries.length === 0 ? (
        <div className="widget-template-error">{tr("暂无历史：增删小组件或编组后自动记录")}</div>
      ) : (
        <>
          <div className="widget-template-list">
            {entries.map((s, i) => {
              const prev = i + 1 < entries.length ? entries[i + 1] : null;
              return (
                <div
                  className={`widget-template-row${s.pinned ? " pinned" : ""}`}
                  key={s.id}
                  style={{ "--sti": Math.min(i, 3) } as CSSProperties}
                >
                  <span className="widget-template-row-name" title={new Date(s.capturedAt).toLocaleString()}>
                    {new Date(s.capturedAt).toLocaleTimeString()}
                  </span>
                  <span className="widget-template-row-count">{deltaText(deltaOf(prev, s))}</span>
                  <button
                    className={`widget-template-row-btn${s.pinned ? " active" : ""}`}
                    onClick={() => pinSnapshot(view, s.id, !s.pinned)}
                    title={s.pinned ? tr("取消固定（恢复容量淘汰）") : tr("固定（永不自动清除）")}
                    aria-label={s.pinned ? tr("取消固定（恢复容量淘汰）") : tr("固定（永不自动清除）")}
                    data-interactive
                  >
                    {s.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                  </button>
                  <button
                    className="widget-template-row-btn"
                    onClick={() => restoreSnapshot(view, s.id)}
                    title={tr("恢复到此快照")}
                    aria-label={tr("恢复到此快照")}
                    data-interactive
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="widget-template-save">
            <button
              className={`widget-template-row-btn danger${confirmClear === "all" ? " confirming" : ""}`}
              onClick={() => {
                if (confirmRequest("all")) clearTimeline(view);
              }}
              title={confirmClear === "all" ? tr("再次点击确认清空") : tr("清空历史（含已固定）")}
              data-interactive
            >
              {confirmClear === "all" ? <Check size={13} /> : <Trash2 size={13} />}
              <span>{confirmClear === "all" ? tr("确认清空") : tr("清空历史")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 桌面画布组件（见模块头）。挂载即订阅 store 渲染实例层；
 * 编辑态交互全部经 pointer 事件 + rAF 节流（拖拽路径见 WidgetCard）。
 *
 * @returns 画布根节点（含网格、对齐参考线、框选矩形与小组件卡片）。
 */
/** V4：把越界布局收回可视区（实例 + 编组）。持久坐标在提交时都经过钳制，
 *  正常重启是空操作；只有视口变小（换显示器/改分辨率）后才有实际位移。
 *  clamp 位移走一次性 200ms 过渡，而不是瞬移。只在桌面画布侧调用
 *  （resize 监听 / 启动 / 切视图）——store 为两窗共享，设置窗视口不同。 */
function reclampLayoutToViewport() {
  const { instances, groups, alignMoveWidget, updateGroup, setPosAnim } = useWidgetStore.getState();
  setPosAnim([...instances.map((i) => i.id), ...groups.map((g) => g.id)]);
  for (const i of instances) {
    alignMoveWidget(i.id, i.x, i.y);
  }
  for (const g of groups) {
    updateGroup(g.id, { x: g.x, y: g.y });
  }
}

export function WidgetCanvas() {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const instances = useWidgetStore((s) => s.instances);
  const alignGuides = useWidgetStore((s) => s.alignGuides);
  const editMode = useWidgetStore((s) => s.editMode);
  const addWidget = useWidgetStore((s) => s.addWidget);
  const hydrate = useWidgetStore((s) => s.hydrate);
  const activeView = useWidgetStore((s) => s.activeView);
  const setEditMode = useWidgetStore((s) => s.setEditMode);
  const addView = useWidgetStore((s) => s.addView);
  const setActiveView = useWidgetStore((s) => s.setActiveView);
  const views = useWidgetStore((s) => s.views);
  const selectedIds = useWidgetStore((s) => s.selectedIds);
  const groups = useWidgetStore((s) => s.groups);
  const groupSelected = useWidgetStore((s) => s.groupSelected);
  const setSelected = useWidgetStore((s) => s.setSelected);
  const clearSelection = useWidgetStore((s) => s.clearSelection);
  const alignSelected = useWidgetStore((s) => s.alignSelected);
  const arrangeSelected = useWidgetStore((s) => s.arrangeSelected);
  const multiSelected = selectedIds.length >= 2;
  /* 空态引导卡：hydrate 完成前不显示（启动瞬间 instances 必为空）。 */
  const [bootDone, setBootDone] = useState(false);
  // 专注沉浸强度：medium 隐藏其他小组件，deep 额外锁定交互。
  const focusMode = useSettingsStore((s) => s.extra.focusMode);
  const pomodoroRunning = useAppStore((s) => s.pomodoro.isRunning);
  const immersive = pomodoroRunning && (focusMode === "medium" || focusMode === "deep");
  const deepLock = pomodoroRunning && focusMode === "deep";
  // Re-trigger the view-switch animation without remounting child widgets
  // (remounting would reset their internal state like timers / inputs).
  const [viewAnim, setViewAnim] = useState(false);
  /* 首启/恢复布局错落入场：挂载后一段时间内给视口挂 .hydrate-anim，
     期间出现的卡片按 nth-child 递增延迟（复用入场动画曲线）。
     窗口时长不再硬编码 900ms——错落延迟 = nth × animMs × 0.16
     （至多 5 档 = 0.8 × animMs）+ 入场动画 1 × animMs，标准档（250ms）
     视觉全程 ≈ 450ms，900ms 即 2 倍余量；按同比例换算 = animMs × 3.6
     （标准档仍为 900ms，视觉不变），快速/慢速/禁用（animMs=0）随速度
     档同步缩放，禁用动画时即刻摘类。 */
  const [bootStagger, setBootStagger] = useState(true);
  /* 错落窗口的起始时刻（挂载首跑时锚定）——档位水合/切换重排时
     deadline 以它为锚整体重算，而不是从重排时刻重新起算完整窗口。 */
  const bootStaggerStartRef = useRef(0);
  /*订阅动效三要素——theme-engine 水合（DB 异步）晚于本 effect
     首跑时，animDurations() 只能读到标准档兜底，慢速档的摘类窗会被排短
     （首启卡片错落截尾）。水合后设置切片变化触发本 effect 重排一次，
     animDurations() 即读到内联真值；运行中改速度档同理重排。 */
  const animSpeed = useSettingsStore((s) => s.extra.animationSpeed);
  const animDurPct = useSettingsStore((s) => s.extra.animationDuration);
  const animEnabled = useSettingsStore((s) => s.extra.enableAnimations);
  useEffect(() => {
    /* 重排必须真正**替换**旧定时器——safeTimeout
       只在卸载时清句柄，effect 重跑后挂载期按标准档排的旧定时器仍在跑：
       慢档水合到达后旧定时器先到期摘 .hydrate-anim，尾部卡片入场被截断。
       改为本地句柄 + cleanup 取消（卸载安全等价）；重算以错落窗口的起始
       时刻为锚整体重算（deadline = start + 新时长 × 3.6，已过期立即摘类），
       窗口已结束（bootStagger=false）则晚到的档位变化不重挂类——避免已
       经播完的卡片重播。 */
    if (!bootStagger) return;
    if (bootStaggerStartRef.current === 0) bootStaggerStartRef.current = Date.now();
    const wait = Math.max(0, bootStaggerStartRef.current + Math.round(animDurations().animMs * 3.6) - Date.now());
    const id = window.setTimeout(() => setBootStagger(false), wait);
    return () => window.clearTimeout(id);
  }, [bootStagger, animSpeed, animDurPct, animEnabled]);
  /* 布局时间线（自动快照 + Ctrl+Z/Ctrl+Shift+Z 撤销重做）。
     幂等初始化：订阅 widget-store 捕获结构变更 + 注册全局快捷键。 */
  useEffect(() => {
    initLayoutTimeline();
  }, []);
  /* 系统事件路由的常驻安装（widget 窗口级）——sysnotify:captured（系统
     Toast 镜像留档）/ push:received（HTTP 推送）/ clipboard:url / 通知留档
     应用此前只在 dock.enabled 时由 DockShell 安装，灵动岛一关（且岛默认关）
     这些**独立功能**的接收端整体静默失效。DockShell 内的调用保留为幂等兜底。 */
  useEffect(() => {
    ensureNotificationListeners();
    ensureSystemNotifyListeners();
  }, []);
  /* #61/#66 整组替换交叉过渡：检测「旧组 id 与新组完全不重叠」的瞬间
     （视图切换 / 套用模板 / 清空重排 / 导入布局），旧布局以幽灵层淡出、
     新组错落入场，形成 A→B 交叉感。 */
  const [ghost, setGhost] = useState<WidgetInstance[] | null>(null);
  const [staggerNow, setStaggerNow] = useState(false);
  const prevInstances = useRef(instances);
  useEffect(() => {
    const prev = prevInstances.current;
    prevInstances.current = instances;
    if (prev.length === 0 || instances.length === 0) {
      setGhost(null);
      return;
    }
    const prevIds = new Set(prev.map((i) => i.id));
    if (!instances.every((i) => !prevIds.has(i.id))) {
      setGhost(null);
      return;
    }
    setGhost(prev);
    setStaggerNow(true);
    /* 幽灵退场 w-fade-out = --dur-fx，+20ms 余量随速度档（此前 220ms 硬编码）。 */
    safeTimeout(() => setGhost(null), animDurations().fxMs + 20);
    /* 新组错落窗口不再硬编码 700ms——stagger-now 的延迟至多
       4 × animMs × 0.16（≈0.64 × animMs）+ 入场 1 × animMs ≈ 1.64 ×
       animMs，标准档（250ms）视觉全程 ≈ 410ms，700ms 即 ≈ 2.8 × animMs
       的余量；按该比例随速度档缩放（禁用动画时即刻摘类）。 */
    safeTimeout(() => setStaggerNow(false), Math.round(animDurations().animMs * 2.8));
  }, [instances, safeTimeout]);
  /* 编辑工具栏退场：退出编辑模式后延迟 160ms 播 .is-closing 下滑淡出。 */
  const editBarVisible = useDelayedUnmount(editMode, animDurations().fxFastMs);
  const showEditBar = editMode || editBarVisible;
  const editBarClosing = !editMode && editBarVisible;
  /* 编辑工具栏自定义位置（拖动把手调整，双击复位）。 */
  const {
    ref: toolbarRef,
    pos: toolbarPos,
    dragging: toolbarDragging,
    beginDrag: beginToolbarDrag,
    reset: resetToolbar
  } = useBarDrag("toolbar");
  /* 编辑弹层锚点所需的工具栏几何（宽/高）缓存。editPanelStyle 此前
     在渲染期直接读 toolbarRef 的 offsetHeight/offsetWidth——渲染路径触碰
     布局属性会强制同步 reflow，画布任何重渲（框选逐帧 setState、拖拽 rAF
     提交）都连带刷洗布局。改为 DOM 就绪后 useLayoutEffect 测量一次写入
     缓存，ResizeObserver 跟随内容/窗口变化；渲染只读缓存。缓存键到
     showEditBar：工具栏条件挂载，卸载后清空，弹层退场窗口内取兜底常量
     （与旧实现 el?.offsetHeight || 38 的兜底一致，视觉不变）。 */
  const [toolbarBox, setToolbarBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      setToolbarBox(null);
      return;
    }
    const measure = () => setToolbarBox({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showEditBar, toolbarRef]);
  /* 空态引导：出现小组件后延迟 200ms 淡出卸载；删光后即刻淡入。
     extra.hideEmptyGuide（桌面右键可切）：关闭后整卡不渲染——切开关是
     即时生效，不走淡出动画（guideClosing 只服务「加进第一个小组件」）。 */
  const hasWidgets = instances.length > 0;
  const guideKeep = useDelayedUnmount(!hasWidgets, animDurations().fxMs);
  const hideEmptyGuide = useSettingsStore((s) => s.extra.hideEmptyGuide);
  const showGuide = bootDone && guideKeep && !hideEmptyGuide;
  const guideClosing = bootDone && hasWidgets && guideKeep;
  /* 布局保存失败提示条：localStorage 写满 / SQLite 写失败时滑入，2.4s 自动退出。 */
  const [saveFailed, setSaveFailed] = useState(false);
  const toastVisible = useDelayedUnmount(saveFailed, animDurations().fxMs);
  const toastClosing = !saveFailed && toastVisible;
  useEffect(() => {
    const onFail = () => setSaveFailed(true);
    window.addEventListener("vela:layout-save-failed", onFail);
    return () => window.removeEventListener("vela:layout-save-failed", onFail);
  }, []);
  useEffect(() => {
    if (!saveFailed) return;
    safeTimeout(() => setSaveFailed(false), 2400);
  }, [saveFailed, safeTimeout]);
  // Fade the widgets out while a fullscreen game covers the screen (when the
  // "游戏时暂停" setting is enabled). Mirrors the setting's promise.
  const [gameCovered, setGameCovered] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  /*  v2：布局历史面板（与模板面板互斥打开，同一锚位）。 */
  const [showHistory, setShowHistory] = useState(false);
  /* DOCK（→ 灵动岛 2.0）：编辑工具栏「灵动岛」配置面板（开关 / 选边 / 磁贴）。 */
  const [showDockPanel, setShowDockPanel] = useState(false);
  /* 弹层退场（弹层退场档）：模板 / 历史 / 灵动岛配置面板与多选工具栏
     关闭时在延迟窗口内播 .is-closing 下滑淡出，不再瞬删。 */
  const templatesKeep = useDelayedUnmount(showTemplates, animDurations().fxFastMs);
  const historyKeep = useDelayedUnmount(showHistory, animDurations().fxFastMs);
  /* 图库退场：自身 closeAnimated 播完才调 onClose；退出编辑等父级强制关闭
     路径经 forceClosing 补播同一退场动画再卸载（此前父级直接卸载瞬删，
     与其余编辑浮层的退场语言不一致）。 */
  const galleryKeep = useDelayedUnmount(showGallery, animDurations().fxMs + 20);
  const dockPanelOpen = showDockPanel && editMode;
  const dockPanelKeep = useDelayedUnmount(dockPanelOpen, animDurations().fxFastMs);
  /* 同锚位弹层互斥的聚合态：模板 / 历史 / 灵动岛共用工具栏上方锚点，任一
     打开时其余收起；多选批量工具栏同锚位（底部居中），弹层打开时让位——
     面板收起后选区仍在，批量工具栏自动回来，不丢用户选择。 */
  const anyEditPanel = showTemplates || showHistory || dockPanelOpen;
  const batchOpen = editMode && multiSelected && !anyEditPanel;
  const batchKeep = useDelayedUnmount(batchOpen, animDurations().fxFastMs);
  /* 编辑网格开关并入 settings 的 extra 切片（extra.editGrid）——此前是
     本地 useState(true)，重启即回默认、跨窗不同步。默认值 true 与现状一致；
     写入走 setExtra（sanitize + 落盘 + 跨窗广播既有通道），hydrate 时读回。 */
  const showGrid = useSettingsStore((s) => s.extra.editGrid);
  // 框选：鼠标在画布空白处拖拽画矩形，松开选中矩形内所有小组件。
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  /* 框选矩形的退场窗口（三轮）：松手后播一拍淡出再卸载。 */
  const [marqueeFading, setMarqueeFading] = useState(false);
  const marqueeFadeTimer = useRef(0);
  /* Ctrl+G 编组快捷键（Figma/PowerPoint 肌肉记忆）：编辑模式多选 ≥2 个
     未编组实例即成组；挂在画布级单监听（WidgetCard 的键盘处理器对
     Ctrl/Meta 修饰键早退，不适合承载）。 */
  useEffect(() => {
    if (!editMode) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "g" && e.key !== "G") || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const st = useWidgetStore.getState();
      const free = st.instances.filter((i) => st.selectedIds.includes(i.id) && !i.groupId);
      if (free.length < 2) return;
      e.preventDefault();
      st.groupSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode]);
  // 防御性同步：任何路径退出编辑模式（含跨窗口 widget:edit-mode 事件）时，
  // 强制关闭编辑态的全部浮层——图库（全屏遮罩残留）与模板/历史/灵动岛面板。
  // 此前面板漏清：退出编辑后画布转穿透态，工具栏已随编辑模式退场，残留的
  // 面板既关不掉也挡视线，直到重新进编辑模式（用户实测「点开的留在那里」）。
  useEffect(() => {
    if (!editMode) {
      setShowGallery(false);
      setShowTemplates(false);
      setShowHistory(false);
      setShowDockPanel(false);
    } else {
      preloadDockConfigPanel();
    }
  }, [editMode]);
  /* 外点关闭编辑弹层（模板 / 历史 / 灵动岛）：按下落在工具栏与面板之外
     （画布空白、小组件卡片、图库遮罩等）即收起——弹层语义的统一预期，
     此前面板只能靠再点一次工具栏按钮关掉。capture 阶段判定不被卡片自身
     的 stopPropagation 截胡；右键菜单打开期间不连坐（菜单自身管理关闭，
     菜单项可能正是「打开弹层」的入口，与 useDismissable 同款守卫）。 */
  useEffect(() => {
    if (!anyEditPanel) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.(".widget-edit-toolbar, .widget-template-panel, .dock-cfg, .ctx-menu")) {
        setShowTemplates(false);
        setShowHistory(false);
        setShowDockPanel(false);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anyEditPanel]); // 任务栏避让：编辑工具栏、灵动岛与批量工具栏共用同一个 bottom 偏移，
  // 保证底边对齐、都不被任务栏挡住。
  const [bottomInset, setBottomInset] = useState(10);
  useEffect(() => {
    const calc = () => {
      const taskbar = window.screen.height - window.screen.availHeight;
      setBottomInset(Math.max(taskbar, 52) + 16);
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  // 显示器热插拔/分辨率变化：窗口尺寸改变后，把因视口变小而越界的小组件
  // 收回可视区（alignMoveWidget 只 clamp 不改吸附位置），防“消失”的组件。
  // 编组容器一并回收（组拖拽提交虽 clamp，但视口缩小后组同样可能整只出屏，
  // 而组的可交互面只有标签条——不回收就永久丢组）。
  useEffect(() => {
    // 等一轮 resize 事件全部落定再 clamp（连续 DPI 切换会触发多次）。
    let timer = 0;
    const debounced = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reclampLayoutToViewport, 250);
    };
    window.addEventListener("resize", debounced);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", debounced);
    };
  }, []);
  /* V4：启动/切视图也回收一次越界布局——resize 监听只在窗口尺寸变化时触发，
     换显示器/改分辨率后重启的越界组此前要等到下一次 resize 才被救回（组可
     交互面只有标签条，出屏即永久丢失）。持久坐标提交时都经过钳制，同视口
     重启是空操作；放一帧等布局尺寸就绪。不能放进 hydrate/setActiveView——
     store 为桌面/设置两窗共享，设置窗视口不同会把布局往小窗里拽。 */
  useEffect(() => {
    const raf = requestAnimationFrame(reclampLayoutToViewport);
    return () => cancelAnimationFrame(raf);
  }, [activeView]);

  useEffect(() => {
    if (!isTauri()) return;
    let unEnter: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let disposed = false;
    void listen<unknown>("focus:game-paused-entered", () => {
      if (useSettingsStore.getState().general.pauseDuringGaming) setGameCovered(true);
    })
      .then((f) => {
        if (disposed) f();
        else unEnter = f;
      })
      /* listen 失败（事件系统异常）不留未处理 rejection——记日志即可，
         游戏覆盖态保持默认值（不淡出）。 */
      .catch((err: unknown) => console.error("[WidgetCanvas] listen focus:game-paused-entered failed:", err));
    void listen<unknown>("focus:game-paused-exited", () => setGameCovered(false))
      .then((f) => {
        if (disposed) f();
        else unExit = f;
      })
      /* 同上，退场监听失败兜底。 */
      .catch((err: unknown) => console.error("[WidgetCanvas] listen focus:game-paused-exited failed:", err));
    return () => {
      disposed = true;
      unEnter?.();
      unExit?.();
    };
  }, []);

  useEffect(() => {
    /* 重触发标准手法：动画持续期间再次切视图，class 恒 true 会让第二次动画
       静默丢失——先摘类、双 rAF 后再挂，保证每次切换都从头播放。
       时长 = --anim-dur（与 CSS .view-anim 动画同源）+ 摘类余量。 */
    let raf2 = 0;
    let timeoutId = 0;
    setViewAnim(false);
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setViewAnim(true);
        timeoutId = window.setTimeout(
          () => setViewAnim(false),
          prefersReducedMotion() ? 0 : Math.round(animDurations().animMs) + 60
        );
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timeoutId);
    };
  }, [activeView]);

  // Load persisted layout and seed a default layout only on a genuine first run
  // (no layout key ever persisted). A deliberately emptied desktop ([] persisted)
  // must NOT be re-seeded with the default widgets on every restart.
  // Seeding WAITS for hydrate(): the durable SQLite copy is loaded async, and
  // seeding before it resolves would overwrite the user's persisted layout.
  // StrictMode 双跑时第二遍会在 addWidget 的防抖落盘窗口内
  // 读到"无布局"而再播一遍默认组件（开发模式 12 个）；且 .then 无取消，卸载
  // 后仍执行。加 cancelled 标志 + 模块级 seeded 幂等标记双保险。
  useEffect(() => {
    let cancelled = false;
    void hydrate()
      .then(() => {
        if (cancelled) return;
        const view = useWidgetStore.getState().activeView;
        if (!seededViews.has(view) && !hasPersistedLayout(view)) {
          seededViews.add(view);
          for (const d of DEFAULT_SEED) {
            const meta = getWidgetMeta(d.type);
            if (meta) addWidget(d.type, meta.defaultSize);
          }
          // DOCK：真正的首次运行一并开启 dock（默认顶部居中）。既有安装升级后
          // dock 键缺省为「未设置」，不会凭空多出一条——由用户在编辑模式里开启。
          if (!hasPersistedDock()) useWidgetStore.getState().setDock({ enabled: true });
        }
        // 布局与回收站都就位后对账磁贴绑定：上次运行期间逾期清理 / 备份恢复到新机
        // 可能让磁贴绑定的实例已不存在——降级为无实例磁贴并提示（DockShell 监听）。
        reconcileDockTiles();
        /* V4：hydrate 是异步的，挂载帧的 reclamp 可能跑在空/半空 store 上——
           最终布局就位后再回收一次越界组/卡片（换显示器重启场景）。 */
        reclampLayoutToViewport();
        setBootDone(true);
      })
      /* hydrate 链路兜底。SQLite/存储层异常若不接住：一是留下未处理
         rejection；二是 bootDone 恒 false——空态引导卡永不出现、#60 入场
         错落窗口不结束，启动流程卡在中间态。失败即记日志并复位启动态
         （此时内存态已是 localStorage 同步加载的布局，画布可正常使用）。 */
      .catch((err: unknown) => {
        console.error("[WidgetCanvas] hydrate failed:", err);
        if (!cancelled) setBootDone(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc 是编辑模式的兜底出口：即使工具栏被遮挡（如全屏游戏覆盖层），
  // 键盘用户也能退出编辑。图库打开时 Esc 由图库自己处理（WidgetGallery 的
  // keydown 监听走 180ms 退场动画再 onClose）；这里不能再直接 setShowGallery(false)
  // ——那会立刻卸载图库，退场动画永远播不到。
  // 弹层分层（标准弹层惯例）：模板/历史/灵动岛任一打开时，Esc（或退出编辑
  // 快捷键）先收面板——即便焦点在面板输入框里打字也收（收面板不吞焦点）；
  // 面板全收后再按一次才退出编辑。此前一键直达退出，面板靠防御性同步兜底
  // 收走，键盘用户「想关面板却退出编辑」的误操作率高。
  useEffect(() => {
    if (!editMode) return;
    const onKey = (e: KeyboardEvent) => {
      const exit = useSettingsStore.getState().appShortcuts["exit-edit"];
      const isExitAccel = exit.enabled && appAccelMatches(exit.accel, e);
      if (e.key !== "Escape" && !isExitAccel) return;
      if (showGallery) return;
      if (showTemplates || showHistory || showDockPanel) {
        setShowTemplates(false);
        setShowHistory(false);
        setShowDockPanel(false);
        /* 焦点归还触发按钮：Esc 时焦点多半在面板输入框/按钮上，面板卸载后
           会掉到 body——归还后键盘流从触发钮继续（面板 id ↔ aria-controls）。 */
        restorePanelFocus();
        return;
      }
      if (!isExitAccel) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      useWidgetStore.getState().setEditMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, showGallery, showTemplates, showHistory, showDockPanel]);

  // 命令面板「添加小组件」入口：进入编辑模式并打开图库（先收同锚位弹层，
  // setState 引用稳定，无依赖数组问题）。
  useEffect(() => {
    const onOpen = () => {
      useWidgetStore.getState().setEditMode(true);
      setShowGallery(true);
      setShowTemplates(false);
      setShowHistory(false);
      setShowDockPanel(false);
    };
    window.addEventListener("focus-desk:open-gallery", onOpen);
    return () => window.removeEventListener("focus-desk:open-gallery", onOpen);
  }, []);

  // Global keyboard shortcuts for switching views. Bindings (and on/off) come
  // from the configurable in-app shortcut table (settings → 快捷键); the first
  // three enabled view slots map to view-1/2/3 in list order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      const st = useSettingsStore.getState().appShortcuts;
      const ws = useWidgetStore.getState();
      const ids = ["view-1", "view-2", "view-3"] as const;
      for (let i = 0; i < ids.length; i++) {
        const entry = st[ids[i]];
        if (entry.enabled && appAccelMatches(entry.accel, e)) {
          const view = ws.views[i]?.id;
          if (view && view !== ws.activeView) {
            e.preventDefault();
            ws.setActiveView(view);
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Bring the clicked widget to the front. Uses a capture-phase listener on the
  // canvas so it fires even if a widget's inner content stops propagation, and
  // reads the widget id from the card's data attribute for a single source of
  // truth. This is the reliable path for "last clicked stays on top". Both
  // pointerdown and mousedown are wired so the bring-to-front still fires on
  // platforms/edge cases where one of the two event types is not delivered.
  useEffect(() => {
    const bringFront = (e: Event) => {
      if (useWidgetStore.getState().editMode) return;
      const card = (e.target as HTMLElement | null)?.closest?.(".widget-card") as HTMLElement | null;
      const id = card?.dataset.widgetId;
      if (id) useWidgetStore.getState().bringToFront(id);
    };
    window.addEventListener("pointerdown", bringFront, true);
    window.addEventListener("mousedown", bringFront, true);
    return () => {
      window.removeEventListener("pointerdown", bringFront, true);
      window.removeEventListener("mousedown", bringFront, true);
    };
  }, []);

  // Native, race-proof bring-to-front: the Rust click-through poller detects a
  // left-button press over a widget card and emits this event with the widget
  // id. This covers the case where the click-through toggle races with the
  // click and the pointer event never reaches the webview.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void listen<string>("widget:bring-to-front", (e) => {
      if (useWidgetStore.getState().editMode) return;
      if (e.payload) useWidgetStore.getState().bringToFront(e.payload);
    })
      .then((f) => {
        if (disposed) f();
        else un = f;
      })
      /* 监听失败兜底，不留未处理 rejection（置顶仍有上方 DOM 捕获路径）。 */
      .catch((err: unknown) => console.error("[WidgetCanvas] listen widget:bring-to-front failed:", err));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // 跨窗口编辑模式：设置窗口点「编辑小组件」时 invoke(set_edit_mode) 会让
  // Rust 广播 widget:edit-mode 事件。桌面层（本窗口）必须监听它，否则桌面
  // 上的小组件永远不会进入可拖拽/可调整大小的编辑状态。
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void listen<boolean>("widget:edit-mode", (e) => {
      useWidgetStore.setState({ editMode: !!e.payload });
    })
      .then((f) => {
        if (disposed) f();
        else un = f;
      })
      /* 监听失败兜底，不留未处理 rejection（本窗仍可自行进出编辑）。 */
      .catch((err: unknown) => console.error("[WidgetCanvas] listen widget:edit-mode failed:", err));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // 设置窗口「灵动岛磁贴 → 在画布中定位」：设置窗没有画布，广播事件由本
  // 窗口执行完整的切视图 + 选中 + 置顶 + 脉冲定位。
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void listen<string>(LOCATE_WIDGET_EVENT, (e) => {
      if (typeof e.payload === "string" && e.payload) locateInstanceOnCanvas(e.payload);
    })
      .then((f) => {
        if (disposed) f();
        else un = f;
      })
      /* 监听失败兜底，不留未处理 rejection（定位是低频辅助入口）。 */
      .catch((err: unknown) => console.error("[WidgetCanvas] listen locate-widget failed:", err));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  useClickThrough(!editMode);

  /* 画布空白处右键：仅在窗口处于可交互状态（编辑模式 / 菜单打开期间 /
     hover 扩展区）才会收到事件，弹出画布级菜单；穿透状态下右键直接落到
     桌面（原生桌面菜单），符合桌面层的预期。 */
  const onCanvasContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // 小组件卡片自行处理右键；编辑控件交给全局编辑菜单。
    if (target.closest(".widget-card")) return;
    if (target.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    openContextMenu(e, [
      {
        label: tr("添加小组件"),
        icon: <Plus size={15} />,
        onSelect: () => {
          setEditMode(true);
          openGalleryFrom();
        }
      },
      editMode
        ? { label: tr("退出编辑"), icon: <X size={15} />, onSelect: () => setEditMode(false) }
        : { label: tr("编辑布局"), icon: <Pencil size={15} />, onSelect: () => setEditMode(true) },
      { type: "separator" },
      {
        /* 菜单项反映当前网格开关态（同下方视图项的打勾语言），不再是永远
           同一个「网格显示」标签——用户分不清这一下是开还是关。 */
        label: showGrid ? tr("隐藏网格") : tr("显示网格"),
        icon: showGrid ? <Check size={15} /> : <Grid3X3 size={15} />,
        onSelect: () => {
          setEditMode(true);
          /* 切换写 settings extra，持久化 + 跨窗同步。 */
          useSettingsStore.getState().setExtra({ editGrid: !showGrid });
        }
      },
      {
        /* 空视图引导卡开关（「当前视图还没有小组件」）：与网格项同款
           「反映当前态」的标签语言；持久化在 extra.hideEmptyGuide，全局生效。
           引导卡隐藏后添加入口仍可达（本菜单「添加小组件」/ 编辑模式图库）。 */
        label: hideEmptyGuide ? tr("显示空视图引导") : tr("隐藏空视图引导"),
        icon: hideEmptyGuide ? <SquareDashed size={15} /> : <Check size={15} />,
        onSelect: () => {
          useSettingsStore.getState().setExtra({ hideEmptyGuide: !hideEmptyGuide });
        }
      },
      {
        label: tr("灵动岛"),
        icon: <Dock size={15} />,
        onSelect: () => {
          setEditMode(true);
          setShowTemplates(false);
          setShowHistory(false);
          setShowDockPanel(true);
        }
      },
      { label: tr("添加视图"), icon: <LayoutGrid size={15} />, onSelect: () => void addViewPrompt() },
      /* 视图切换直达（可达性）：入口此前 = Dock 箭头（需开岛）+ 键盘（仅前 3
         视图）+ 命令面板；关闭灵动岛后第 4+ 视图在桌面无鼠标入口。空白处
         右键就地切换，当前视图打勾（icon 槽，空占位保列对齐）。 */
      ...views.slice(0, 8).map((v) => ({
        label: tr("切换到视图「{name}」").replace("{name}", () => v.name),
        icon: v.id === activeView ? <Check size={15} /> : null,
        onSelect: () => setActiveView(v.id)
      })),
      { type: "separator" },
      { label: tr("打开设置"), icon: <Settings size={15} />, onSelect: () => void openSettingsWindow() }
    ]);
  };

  /* 添加视图后自动切换到新视图，让「新建」即刻可见（配合新按钮入场动画）。
     命名走统一的 promptViewName（长度上限 + 重名拦截）——与设置窗侧栏/视图
     管理页同一入口，此前桌面右键与编辑工具栏新建的视图无任何约束。 */
  const addViewPrompt = async () => {
    const name = await promptViewName(tr, { title: tr("输入新视图名称"), existing: views });
    if (!name) return;
    const id = addView(name);
    if (id) setActiveView(id);
  };

  /* 图库是全屏模态：任何入口打开它都先收起同锚位弹层，避免面板被遮罩盖住
     成「幽灵开关态」（工具栏按钮 active 但面板不可见不可关）。 */
  const openGalleryFrom = () => {
    setShowTemplates(false);
    setShowHistory(false);
    setShowDockPanel(false);
    setShowGallery(true);
  };

  /* 框选：在编辑模式空白处按下左键开始画矩形，松开选中矩形内的全部小组件；
     按到的若是小组件/交互控件则交给各自处理。
     拖选中途组件卸载（切视图等）会让 window 上的三个监听器
     连同闭包泄漏——用 cleanup ref 模式在卸载 effect 里统一摘除。 */
  const marqueeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      marqueeCleanupRef.current?.();
    };
  }, []);
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (!editMode) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".widget-card")) return;
    if (target.closest("[data-interactive]")) return;
    e.preventDefault();
    /* 界面缩放下 clientX/Y 是视觉坐标、实例几何与框选矩形（fixed 定位）是
       布局单位——统一除回缩放，框选矩形才跟手、命中比较才对位。 */
    const zoom = uiZoom();
    const startX = e.clientX / zoom;
    const startY = e.clientY / zoom;
    /* 上一轮淡出未结束时立刻重新起框：取消待发的清空定时器并复位退场态，
       否则旧定时器会把新矩形在拖拽中途清掉。 */
    if (marqueeFadeTimer.current) {
      window.clearTimeout(marqueeFadeTimer.current);
      marqueeFadeTimer.current = 0;
    }
    setMarqueeFading(false);
    setMarquee({ startX, startY, endX: startX, endY: startY });
    // rAF 合帧（与拖拽/缩放同款约束）：pointermove 事件率随鼠标报告率可达
    // 125–1000Hz，而 marquee 是画布根组件的 state，逐事件 setState 会整树
    // reconcile；每帧只落一次最新坐标。
    let rafId: number | null = null;
    let pendingX = startX;
    let pendingY = startY;
    const onMove = (ev: PointerEvent) => {
      pendingX = ev.clientX / zoom;
      pendingY = ev.clientY / zoom;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const ex = pendingX;
        const ey = pendingY;
        setMarquee((m) => (m ? { ...m, endX: ex, endY: ey } : m));
      });
    };
    const detach = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      marqueeCleanupRef.current = null;
    };
    const onUp = (ev: PointerEvent) => {
      detach();
      // 命中矩形直接由闭包里的起点 + 本次 up 事件坐标算出，不必在 setState
      // updater 里读 marquee（updater 须纯函数：StrictMode 双调用会重复
      // setSelected / pulse / 定时器，且读外部 store 让渲染依赖可变态）。
      const x1 = Math.min(startX, ev.clientX / zoom);
      const x2 = Math.max(startX, ev.clientX / zoom);
      const y1 = Math.min(startY, ev.clientY / zoom);
      const y2 = Math.max(startY, ev.clientY / zoom);
      /* 三轮：矩形先播一拍淡出再卸载（命中计算已在下方完成，淡出期间
         pointer-events 已被 CSS 关闭）。 */
      setMarqueeFading(true);
      marqueeFadeTimer.current = window.setTimeout(() => {
        marqueeFadeTimer.current = 0;
        setMarquee(null);
        setMarqueeFading(false);
      }, animDurations().fxXfastMs);
      /* 只选未编组实例（编组成员不单独渲染，其存储坐标是解散恢复位而非视觉
          位置——框中即选中会选中看不见的成员）：编组容器本身按容器矩形
          参与框选（组是编辑模式一等公民，可与卡片混选对齐/排布/删除）。 */
      const st = useWidgetStore.getState();
      const ids = [
        ...st.instances
          .filter((i) => !i.groupId && i.x < x2 && i.x + i.w > x1 && i.y < y2 && i.y + i.h > y1)
          .map((i) => i.id),
        ...st.groups.filter((g) => g.x < x2 && g.x + g.w > x1 && g.y < y2 && g.y + g.h > y1).map((g) => g.id)
      ];
      if (ids.length) {
        setSelected(ids);
        /* 命中确认：命中卡描边播一次 accent 脉冲。 */
        useWidgetStore.setState((s) => ({
          pulseIds: [...s.pulseIds, ...ids.filter((x) => !s.pulseIds.includes(x))]
        }));
        safeTimeout(() => {
          useWidgetStore.setState((s) => ({ pulseIds: s.pulseIds.filter((x) => !ids.includes(x)) }));
        }, 750);
      } else {
        clearSelection();
      }
    };
    const onCancel = () => {
      // H-审计：触屏手势被系统接管（pointercancel）时对称清理，否则 marquee
      // 滞留在画布上且后续 up 无法命中配对。
      detach();
      if (marqueeFadeTimer.current) {
        window.clearTimeout(marqueeFadeTimer.current);
        marqueeFadeTimer.current = 0;
      }
      setMarquee(null);
      setMarqueeFading(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    marqueeCleanupRef.current = detach;
  };

  const marqueeRect = marquee
    ? {
        left: Math.min(marquee.startX, marquee.endX),
        top: Math.min(marquee.startY, marquee.endY),
        width: Math.abs(marquee.endX - marquee.startX),
        height: Math.abs(marquee.endY - marquee.startY)
      }
    : null;

  /* 对齐/等距动作的静态骨架（icon 元素为不可变 ReactNode，模块级复用安全）；
     翻译在使用点做——整个数组提出渲染体，画布每次重渲（框选逐帧 setState
     也会触发）不再重建 8 个 lucide 图标元素。 */
  const alignActions = ALIGN_ACTION_DEFS;

  /* 编辑弹层锚点（模板 / 历史 / 灵动岛共用）：跟随工具栏。默认底部居中时
     悬于工具栏正上方——此前面板硬编码 bottom:68px，既不随任务栏避让偏移
     （bottomInset 动态值）走、又被工具栏盖住下缘；工具栏拖到自定义位置后
     贴边跟随：下半屏放上方、上半屏放下方，水平钳到视口内（--panel-tx 归零
     让 CSS 里的居中 transform 与 pop 动画一致地退位）。
     工具栏几何读 toolbarBox 缓存（useLayoutEffect + ResizeObserver
     维护，见上方声明），渲染期不再触碰 offsetHeight/offsetWidth——那会
     强制同步布局，画布每次重渲（框选/拖拽）都连带刷洗。缓存未就绪（首帧、
     测试环境无 ResizeObserver 或退场窗口内工具栏已卸载）时取兜底常量，
     与旧实现 el?.offsetHeight || 38 的 fallback 语义一致（0 同样兜底）。 */
  const editPanelStyle = (width: number): CSSProperties => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tbH = toolbarBox?.h || 38;
    if (!toolbarPos) {
      return { left: "50%", bottom: bottomInset + tbH + 10 };
    }
    const tbW = toolbarBox?.w || 320;
    const w = Math.min(width, vw - 16);
    const left = Math.round(Math.min(Math.max(8, toolbarPos.x + tbW / 2 - w / 2), vw - 8 - w));
    if (toolbarPos.y + tbH / 2 < vh / 2) {
      return { left, width: w, top: toolbarPos.y + tbH + 10, "--panel-tx": "0px" } as CSSProperties;
    }
    return { left, width: w, bottom: Math.max(8, vh - toolbarPos.y + 10), "--panel-tx": "0px" } as CSSProperties;
  };

  return (
    <div
      className={`widget-canvas${editMode ? " editing" : ""}${gameCovered ? " game-covered" : ""}${showGrid && editMode ? " show-grid" : ""}${immersive ? " focus-immersed" : ""}${deepLock ? " focus-locked" : ""}`}
      onPointerDown={onCanvasPointerDown}
      onContextMenu={onCanvasContextMenu}
    >
      {/* DOCK（→ 灵动岛 2.0）：贴边聚合容器外壳（几何/磁贴/接管按屏持久化；
          展开态复用 expand-store）。单磁贴内容各有边界，但岛壳自身抛错此前会
          沿 WidgetCanvas 炸掉整个桌面层窗口——这里兜一层（已写崩溃日志），
          画布照常。：崩溃不再永久空白——一次性 toast 告警 + 贴屏底的
          迷你「重试」条（重试经 attempt 重建岛壳）。 */}
      <WidgetErrorBoundary
        instanceId="dock"
        type="dock-shell"
        onError={() => warnShellError(tr("灵动岛出现问题，点击重试可恢复"))}
        fallback={(retry) => (
          <ShellErrorRetry
            label={tr("灵动岛出现问题")}
            onRetry={retry}
            style={{
              position: "fixed",
              left: "50%",
              bottom: 16,
              transform: "translateX(-50%)",
              zIndex: "var(--z-float-menu)"
            }}
          />
        )}
      >
        <DockShell bottomInset={bottomInset} />
      </WidgetErrorBoundary>
      {/* 岛的全局热键监听必须在 dock.enabled 门控之外：DockShell 关岛即整体卸载，
          挂在它里面时 Ctrl+Alt+I / `--toggle-dock` 只能关不能开。 */}
      <DockShortcuts />
      {/* #61/#66 旧布局幽灵层：整组替换瞬间以占位矩形淡出，形成 A→B 交叉
          （置于 viewport 之外，避免挤占卡片 nth-child 错落索引） */}
      {ghost && (
        <div className="canvas-ghost" aria-hidden="true">
          {ghost.map((g) => (
            <div key={g.id} className="canvas-ghost-card" style={{ left: g.x, top: g.y, width: g.w, height: g.h }} />
          ))}
        </div>
      )}
      {/* 视图切换动画只作用于小组件，不作用到顶部/边缘的固定悬浮控件，
          避免 backdrop-filter 的视图切换栏在动画时闪烁。 */}
      <div
        className={`widget-canvas-viewport${viewAnim ? " view-anim" : ""}${bootStagger ? " hydrate-anim" : ""}${staggerNow ? " stagger-now" : ""}`}
      >
        {instances
          .filter((inst) => !inst.groupId)
          .map((inst) => (
            <WidgetCard key={inst.id} {...inst} />
          ))}
        {/* 编组容器（成员卡不单独渲染）。 */}
        {groups.map((g) => (
          <GroupCard key={g.id} group={g} />
        ))}
        {/* 拖拽对齐辅助线：仅拖拽期间出现，贯穿画布的吸附参考线。 */}
        {alignGuides.xs.map((gx, i) => (
          <div key={`gx-${i}`} className="widget-align-guide guide-x" style={{ left: gx }} />
        ))}
        {alignGuides.ys.map((gy, i) => (
          <div key={`gy-${i}`} className="widget-align-guide guide-y" style={{ top: gy }} />
        ))}
      </div>

      {/* 空态引导卡：切到空视图 / 清空后提示添加入口。
          五.9：整卡可点击——直接进编辑模式并打开图库（最低成本的「从零到一」
          路径，不必先知道右键菜单存在）；图标挂 ambientMotion 门控的轻脉冲。 */}
      {showGuide && (
        <div
          className={`canvas-empty-guide${guideClosing ? " is-closing" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            useWidgetStore.getState().setEditMode(true);
            openGalleryFrom();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              useWidgetStore.getState().setEditMode(true);
              openGalleryFrom();
            }
          }}
          data-interactive
        >
          <span className="canvas-empty-guide-ico">
            <LayoutGrid size={22} />
          </span>
          <span>{tr("当前视图还没有小组件")}</span>
          <span className="canvas-empty-guide-sub">{tr("点击这里打开图库，或右键桌面空白处添加")}</span>
        </div>
      )}

      {/* 框选矩形：编辑模式空白处拖拽时显示。#67 淡入 + 虚线行军；
          三轮补松手淡出退场。 */}
      {marqueeRect && (
        <div
          className={`widget-marquee${marqueeFading ? " is-ending" : ""}`}
          data-interactive
          style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }}
        >
          <svg className="widget-marquee-svg" width="100%" height="100%" aria-hidden="true">
            <rect
              className="widget-marquee-rect"
              x="1"
              y="1"
              style={{ width: "calc(100% - 2px)", height: "calc(100% - 2px)", rx: 3 }}
            />
          </svg>
        </div>
      )}

      {/* 布局保存失败提示条 */}
      {(saveFailed || toastVisible) && (
        <div className={`canvas-save-toast${toastClosing ? " is-closing" : ""}`}>
          <TriangleAlert size={14} />
          {tr("布局保存失败，请检查磁盘空间")}
        </div>
      )}

      {/* 多选批量工具栏：框选 ≥2 个小组件时浮出，含对齐/等距/删除。 */}
      {batchKeep && (
        <div
          className={`widget-batch-toolbar${batchOpen ? "" : " is-closing"}`}
          role="toolbar"
          aria-label={tr("批量操作工具栏")}
          style={{ bottom: bottomInset + 52 }}
          data-interactive
          onClick={(e) => e.stopPropagation()}
        >
          <span className="widget-batch-count">{selectedIds.length}</span>
          {alignActions.map((a) => (
            <button
              key={a.mode}
              className="widget-batch-btn"
              title={tr(a.title)}
              aria-label={tr(a.title)}
              onClick={() => alignSelected(a.mode)}
              data-interactive
            >
              {a.icon}
            </button>
          ))}
          <span className="widget-batch-divider" />
          {/* 自动排布（网格/横排/纵列，包围盒内 track 布局）。 */}
          {[
            { mode: "grid" as const, title: tr("网格排布"), icon: <LayoutGrid size={14} /> },
            { mode: "row" as const, title: tr("横排排布"), icon: <Rows3 size={14} /> },
            { mode: "column" as const, title: tr("纵列排布"), icon: <Columns3 size={14} /> }
          ].map((a) => (
            <button
              key={a.mode}
              className="widget-batch-btn"
              title={a.title}
              aria-label={a.title}
              onClick={() => arrangeSelected(a.mode)}
              data-interactive
            >
              {a.icon}
            </button>
          ))}
          <button
            className="widget-batch-btn"
            title={tr("编组")}
            aria-label={tr("编组")}
            onClick={() => groupSelected()}
            data-interactive
          >
            <Combine size={14} />
          </button>
          <span className="widget-batch-divider" />
          {/* 样式预设批量套用：选中全为同类型时可把该类型的
              预设一键套到所有选中实例（内容字段不随预设走，见 style-presets.ts）。 */}
          <BatchPresetButton selectedIds={selectedIds} instances={instances} />
          <button
            className="widget-batch-btn danger"
            title={tr("删除选中")}
            aria-label={tr("删除选中")}
            onClick={() => useWidgetStore.getState().removeSelectionAnimated()}
            data-interactive
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* 编辑模式底部弹出工具栏（#62：延迟卸载补退场）。编辑模式下可拖动
          左端把手调整位置（持久化，双击复位）。 */}
      {showEditBar && (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={tr("编辑工具栏")}
          aria-orientation="horizontal"
          /* ARIA toolbar 键盘模式：←→ 在按钮间移动焦点（循环），Home/End 跳
             首/末。stopPropagation 防冒泡到 window 的卡片方向键微移（把手
             自己的方向键微移在其 keydown 里已先行 stopPropagation，不受影响）。 */
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
            const bar = toolbarRef.current;
            if (!bar || e.ctrlKey || e.altKey || e.metaKey) return;
            const items = [...bar.querySelectorAll<HTMLElement>("button:not([disabled])")];
            if (items.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            const idx = items.indexOf(document.activeElement as HTMLElement);
            let next: number;
            if (e.key === "Home") next = 0;
            else if (e.key === "End") next = items.length - 1;
            else if (e.key === "ArrowRight") next = idx < 0 ? 0 : (idx + 1) % items.length;
            else next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
            items[next].focus();
          }}
          className={`widget-edit-toolbar${editBarClosing ? " is-closing" : ""}${toolbarPos ? " is-custom" : ""}${toolbarDragging ? " dragging" : ""}`}
          style={
            toolbarPos
              ? { left: toolbarPos.x, top: toolbarPos.y, transform: "none", bottom: "auto" }
              : { bottom: bottomInset }
          }
        >
          <BarGrip onDown={beginToolbarDrag} onReset={resetToolbar} title={tr("拖动调整位置（双击复位）")} />
          <button
            className="widget-edit-toolbar-btn"
            onClick={() => openGalleryFrom()}
            title={tr("添加小组件")}
            data-interactive
          >
            <Plus size={16} />
            <span>{tr("添加小组件")}</span>
          </button>
          <button
            className="widget-edit-toolbar-btn"
            onClick={() => void addViewPrompt()}
            title={tr("添加视图")}
            data-interactive
          >
            <LayoutGrid size={16} />
            <span>{tr("添加视图")}</span>
          </button>
          {/* 同锚位弹层互斥：模板 / 历史 / 灵动岛共用工具栏上方锚点，打开
              任一收起其余（此前灵动岛与模板/历史可同时打开，完全重叠）。 */}
          <button
            className={`widget-edit-toolbar-btn${showTemplates ? " active" : ""}`}
            onClick={() => {
              setShowTemplates((v) => !v);
              setShowHistory(false);
              setShowDockPanel(false);
            }}
            title={tr("布局模板")}
            aria-haspopup="dialog"
            aria-expanded={showTemplates}
            aria-controls="edit-panel-templates"
            data-interactive
          >
            <LayoutTemplate size={16} />
            <span>{tr("布局模板")}</span>
          </button>
          <button
            className={`widget-edit-toolbar-btn${showHistory ? " active" : ""}`}
            onClick={() => {
              setShowHistory((v) => !v);
              setShowTemplates(false);
              setShowDockPanel(false);
            }}
            title={tr("布局历史")}
            aria-haspopup="dialog"
            aria-expanded={showHistory}
            aria-controls="edit-panel-history"
            data-interactive
          >
            <History size={16} />
            <span>{tr("布局历史")}</span>
          </button>
          <button
            className={`widget-edit-toolbar-btn${showDockPanel ? " active" : ""}`}
            onClick={() => {
              setShowDockPanel((v) => !v);
              setShowTemplates(false);
              setShowHistory(false);
            }}
            title={tr("灵动岛")}
            aria-haspopup="dialog"
            aria-expanded={dockPanelOpen}
            aria-controls="edit-panel-dock"
            data-interactive
          >
            <Dock size={16} />
            <span>{tr("灵动岛")}</span>
          </button>
          <button
            className={`widget-edit-toolbar-btn${showGrid ? " active" : ""}`}
            /* 切换写 settings extra，持久化 + 跨窗同步。 */
            onClick={() => useSettingsStore.getState().setExtra({ editGrid: !showGrid })}
            title={tr("网格显示")}
            data-interactive
          >
            <Grid3X3 size={16} />
            <span>{tr("网格")}</span>
          </button>
          <button
            className="widget-edit-toolbar-btn"
            onClick={() => openSettingsWindow()}
            title={tr("设置")}
            data-interactive
          >
            <Settings size={16} />
            <span>{tr("设置")}</span>
          </button>
          <button
            className="widget-edit-toolbar-btn danger"
            onClick={() => setEditMode(false)}
            title={tr("退出编辑")}
            data-interactive
          >
            <X size={16} />
            <span>{tr("退出编辑")}</span>
          </button>
        </div>
      )}

      {templatesKeep && <LayoutTemplatePanel closing={!showTemplates} style={editPanelStyle(360)} />}
      {historyKeep && <LayoutHistoryPanel closing={!showHistory} style={editPanelStyle(360)} />}
      {dockPanelKeep && (
        /* 面板 chunk 拉取失败 / 渲染崩溃不再永久空白——一次性 toast 告警
           + 占面板位的迷你「重试」条（onRetry 先弃缓存再重挂，重试即重新
           import）。水平定位与编辑弹层同款 --panel-tx 参数化。 */
        <WidgetErrorBoundary
          instanceId="dock"
          type="dock-config-panel"
          onError={() => warnShellError(tr("灵动岛面板未能加载，点击重试可恢复"))}
          onRetry={DockConfigPanelLazy.reset}
          fallback={(retry) => (
            <ShellErrorRetry
              label={tr("灵动岛面板未能加载")}
              onRetry={retry}
              style={
                {
                  ...editPanelStyle(240),
                  transform: "translateX(var(--panel-tx, -50%))"
                } as CSSProperties
              }
            />
          )}
        >
          <Suspense fallback={null}>
            <DockConfigPanelLazy.Component closing={!dockPanelOpen} style={editPanelStyle(380)} />
          </Suspense>
        </WidgetErrorBoundary>
      )}

      {galleryKeep && <WidgetGallery onClose={() => setShowGallery(false)} forceClosing={!showGallery} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  样式预设批量套用按钮（多选工具栏）：选中全为同类型时可用                 */
/* ------------------------------------------------------------------ */

function BatchPresetButton({ selectedIds, instances }: { selectedIds: string[]; instances: WidgetInstance[] }) {
  const tr = useT();
  const updateWidget = useWidgetStore((s) => s.updateWidget);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  /* 菜单此前是全库菜单范式孤例——无外点关闭、无 Esc、
     无键盘巡览（画布外点 effect 与 Esc 分层的清单都归不到它：菜单 open 态
     在本组件内，画布摸不到）。wrap（触发钮 + 菜单共祖）喂 useDismissable：
     外点即收，Esc 走 capture + stopPropagation 的分层（先菜单、再编辑面板、
     最后退出编辑）。 */
  useDismissable(open, wrapRef, () => setOpen(false));
  const types = new Set(instances.filter((i) => selectedIds.includes(i.id)).map((i) => i.type));
  const uniformType = types.size === 1 ? ([...types][0] as string) : null;
  const presets = uniformType ? listStylePresets(uniformType) : [];
  /* 菜单退场（三轮）：.widget-context-menu 自带 menu-in 入场与
     .is-closing（ctx-menu-out）退场，此前条件渲染直接卸载导致退场缺失。
     与 ContextMenu 同范式：关闭后保留一拍播退场再卸载，期间 pointer-events
     已被 CSS 关闭。 */
  const menuVisible = useDelayedUnmount(open && !!uniformType, animDurations().fxFastMs);

  const applyToSelection = (preset: StylePreset) => {
    if (!uniformType) return;
    /* sanitizeWidgetConfig 静态依赖 config-schemas（32 个 zod schema）：该模块
       已随配置弹层拆异步，此处（批量套预设，编辑模式低频动作）动态取用，
       不把 schema 全家拖回主 chunk。 */
    void import("./config-schemas")
      .then(({ sanitizeWidgetConfig }) => {
        for (const id of selectedIds) {
          // 现读权威副本再合并：预设已剥内容字段，条目/格位等不随预设走。
          const cur = loadWidgetConfig(id);
          saveWidgetConfig(id, sanitizeWidgetConfig(uniformType, mergeStyleConfig(cur, preset)));
          if (preset.opacity != null) updateWidget(id, { opacity: preset.opacity });
        }
        setOpen(false);
      })
      /* schema chunk 拉取失败兜底——记日志，菜单保持打开（用户可重试），
         不留未处理 rejection。 */
      .catch((err: unknown) => console.error("[WidgetCanvas] load config-schemas failed:", err));
  };

  return (
    <div className="wbatch-preset-wrap" ref={wrapRef}>
      <button
        className="widget-batch-btn"
        title={uniformType ? tr("批量套用样式预设") : tr("仅同类型组件可套用")}
        aria-label={uniformType ? tr("批量套用样式预设") : tr("仅同类型组件可套用")}
        disabled={!uniformType}
        onClick={() => setOpen((v) => !v)}
        data-interactive
      >
        <Palette size={14} />
      </button>
      {menuVisible && uniformType && (
        <div
          className={`widget-context-menu wbatch-preset-menu${open ? "" : " is-closing"}`}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {presets.length === 0 ? (
            <button className="wbatch-preset-empty" disabled>
              {tr("暂无预设，可在组件配置弹层中保存")}
            </button>
          ) : (
            presets.map((p) => (
              <button key={p.id} role="menuitem" onClick={() => applyToSelection(p)}>
                {p.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
