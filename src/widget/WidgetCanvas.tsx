/**
 * 桌面画布：小组件实例的布局容器与编辑器。
 *
 * 职责：按当前视图渲染全部 WidgetCard（绝对定位 + z 序）；编辑模式下提供
 * 拖拽/缩放/对齐参考线/框选/网格/对齐分发/模板保存；空白处右键弹出全局
 * 菜单（添加组件、视图管理、呼出设置）。布局持久化经 widget-store 的
 * 防抖双后端写；跨窗口广播由 cross-window 层处理。
 */
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
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
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { isTauri, openSettingsWindow } from "../lib/tauri";
import { appAccelMatches } from "../lib/shortcuts";
import { useSettingsStore } from "../store/settings-store";
import { useAppStore } from "../store/app-store";
import { useT } from "../i18n-lite";
import { getWidgetMeta } from "./registry";
import { promptDialog } from "../components/PromptDialog";
import { pushAppToast } from "../components/ToastHost";
import { openContextMenu } from "../components/ContextMenu";
import { useClickThrough } from "./useClickThrough";
import { useDelayedUnmount, prefersReducedMotion } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useSafeTimeout } from "../lib/use-safe-timeout";
import { useConfirmAction } from "../lib/use-confirm-remove";
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
import { WidgetCard } from "./WidgetCard";
import { WidgetGallery } from "./WidgetGallery";
import { DockShell } from "./dock/DockShell";
import { DockShortcuts } from "./dock/DockShortcuts";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";

/* 灵动岛配置面板懒加载：其内部 M3Slider → WakeSlider 静态引入 motion/react，
   若随画布静态打进主 chunk，会让每屏小组件层/速记窗/任务栏网速条都为这
   一个滑条背走整套 motion 引擎（编辑工具栏点击「灵动岛」时才需要它）。
   入编辑模式即预热 chunk，点开面板时本地加载瞬时完成。 */
const DockConfigPanel = lazy(() => import("./dock/DockConfigPanel").then((m) => ({ default: m.DockConfigPanel })));
const preloadDockConfigPanel = () => {
  void import("./dock/DockConfigPanel").catch(() => {});
};

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

/* P2（审计修复）：默认布局种子的模块级幂等标记——StrictMode 双跑/重复挂载
   时防止对同一视图播种两次（防抖落盘窗口内的 TOCTOU）。 */
const seededViews = new Set<string>();

/* 悬浮编辑工具栏自定义位置：编辑模式下拖动把手
   调整，按屏幕分区持久化到 localStorage（镜像备份，见 bar-pos.ts），双击把手
   复位默认位置。 */

/** 当前窗口的可用视口：小组件窗口铺满整屏（含任务栏区），高度需扣掉任务栏。 */
function usableViewport(): Viewport {
  const taskbar = Math.max(0, window.screen.height - window.screen.availHeight);
  return { width: window.innerWidth, height: window.innerHeight - taskbar };
}

/** 指针位移低于此值视为纯点击（把手可被点击以获取焦点、用方向键微移组件）。 */
const BAR_DRAG_THRESHOLD = 3;

function useBarDrag(kind: BarKind) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<BarPos | null>(() => loadBarPos(kind, usableViewport()));
  const [dragging, setDragging] = useState(false);
  // F-11：活动拖拽期间的全局监听随组件卸载一并清理，避免隐式挂载切换时泄漏。
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
    const origin = pos ?? { x: rect.left, y: rect.top };
    // 纯点击不落盘：否则会把随任务栏 / 分辨率自适应的默认位置冻结成一组绝对坐标。
    let moved = false;
    setDragging(true);
    const clamp = (x: number, y: number): BarPos => ({
      x: Math.round(Math.min(Math.max(0, x), Math.max(0, window.innerWidth - rect.width))),
      y: Math.round(Math.min(Math.max(0, y), Math.max(0, window.innerHeight - rect.height)))
    });
    // pointermove 逐事件 setState 是跟手路径里唯一未限帧的 React 更新：
    // rAF 合并成每帧一次（与画布卡片拖拽同范式），跟手性不变。
    let raf = 0;
    let live: BarPos | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < BAR_DRAG_THRESHOLD) return;
      moved = true;
      live = clamp(origin.x + ev.clientX - startX, origin.y + ev.clientY - startY);
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

  /* 视口变小后把自定义位置收回可视区，防工具条永久出屏。 */
  useEffect(() => {
    if (!pos) return;
    const onResize = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = {
        x: Math.min(pos.x, Math.max(0, window.innerWidth - rect.width)),
        y: Math.min(pos.y, Math.max(0, window.innerHeight - rect.height))
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

/** 编辑模式下的「布局模板」面板（I2）：保存当前布局为命名模板、套用、删除。
 *  删除走两步确认：首次点击进入确认态（2 秒未确认自动解除），再次点击才真删。 */
function LayoutTemplatePanel({ closing }: { closing?: boolean }) {
  const tr = useT();
  const templates = useWidgetStore((s) => s.templates);
  const saveTemplate = useWidgetStore((s) => s.saveTemplate);
  const applyTemplate = useWidgetStore((s) => s.applyTemplate);
  const deleteTemplate = useWidgetStore((s) => s.deleteTemplate);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const { confirmingId: confirmDeleteId, request: confirmRequest } = useConfirmAction();
  /* 行删除退场：确认后先播 .is-closing 收缩，播完再提交 store（不再瞬删）。 */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const requestDeleteTemplate = (id: string) => {
    if (!confirmRequest(id) || removingId) return;
    setRemovingId(id);
    window.setTimeout(
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
      className={`widget-template-panel${closing ? " is-closing" : ""}`}
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
            if (e.key === "Enter") doSave();
          }}
          placeholder={tr("模板名称，如「工作台」")}
          data-interactive
        />
        <button className="widget-template-save-btn" onClick={doSave} data-interactive>
          <Plus size={13} /> {tr("保存")}
        </button>
      </div>
      {/* #55 key=错误文本：同类错误连续触发时重挂载重播 shake */}
      {error && (
        <div className="widget-template-error" key={error}>
          {error}
        </div>
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

/** 编辑模式下的「布局历史」面板（BentoDesk 借鉴 #1 v2）：时间轴列出自动
 *  快照（结构变更各一份），任意点恢复（恢复前当前态自动补快照，可再撤销）；
 *  pinned 快照不参与容量淘汰；清空走两步确认。
 *  与「布局模板」互斥打开（同一锚位）。 */
function LayoutHistoryPanel({ closing }: { closing?: boolean }) {
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
    return parts.length ? parts.join(" · ") : tr("无结构变化");
  };

  return (
    <div
      className={`widget-template-panel${closing ? " is-closing" : ""}`}
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
  const removeAnimated = useWidgetStore((s) => s.removeWidgetsAnimated);
  const multiSelected = selectedIds.length >= 2;
  /* #70 空态引导卡：hydrate 完成前不显示（启动瞬间 instances 必为空）。 */
  const [bootDone, setBootDone] = useState(false);
  // 专注沉浸强度（I5）：medium 隐藏其他小组件，deep 额外锁定交互。
  const focusMode = useSettingsStore((s) => s.extra.focusMode);
  const pomodoroRunning = useAppStore((s) => s.pomodoro.isRunning);
  const immersive = pomodoroRunning && (focusMode === "medium" || focusMode === "deep");
  const deepLock = pomodoroRunning && focusMode === "deep";
  // Re-trigger the view-switch animation without remounting child widgets
  // (remounting would reset their internal state like timers / inputs).
  const [viewAnim, setViewAnim] = useState(false);
  /* #60 首启/恢复布局错落入场：挂载后 900ms 内给视口挂 .hydrate-anim，
     期间出现的卡片按 nth-child 递增延迟（复用入场动画曲线）。 */
  const [bootStagger, setBootStagger] = useState(true);
  useEffect(() => {
    safeTimeout(() => setBootStagger(false), 900);
  }, [safeTimeout]);
  /* BentoDesk 借鉴 #1：布局时间线（自动快照 + Ctrl+Z/Ctrl+Shift+Z 撤销重做）。
     幂等初始化：订阅 widget-store 捕获结构变更 + 注册全局快捷键。 */
  useEffect(() => {
    initLayoutTimeline();
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
    safeTimeout(() => setStaggerNow(false), 700);
  }, [instances, safeTimeout]);
  /* #62 编辑工具栏退场：退出编辑模式后延迟 160ms 播 .is-closing 下滑淡出。 */
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
  /* #70 空态引导：出现小组件后延迟 200ms 淡出卸载；删光后即刻淡入。 */
  const hasWidgets = instances.length > 0;
  const guideKeep = useDelayedUnmount(!hasWidgets, animDurations().fxMs);
  const showGuide = bootDone && guideKeep;
  const guideClosing = bootDone && hasWidgets && guideKeep;
  /* #75 布局保存失败提示条：localStorage 写满 / SQLite 写失败时滑入，2.4s 自动退出。 */
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
  /* BentoDesk 借鉴 #1 v2：布局历史面板（与模板面板互斥打开，同一锚位）。 */
  const [showHistory, setShowHistory] = useState(false);
  /* DOCK（C2 → 灵动岛 2.0）：编辑工具栏「灵动岛」配置面板（开关 / 选边 / 磁贴）。 */
  const [showDockPanel, setShowDockPanel] = useState(false);
  /* 弹层退场（F-9 弹层退场档）：模板 / 历史 / 灵动岛配置面板与多选工具栏
     关闭时在延迟窗口内播 .is-closing 下滑淡出，不再瞬删。 */
  const templatesKeep = useDelayedUnmount(showTemplates, animDurations().fxFastMs);
  const historyKeep = useDelayedUnmount(showHistory, animDurations().fxFastMs);
  const dockPanelOpen = showDockPanel && editMode;
  const dockPanelKeep = useDelayedUnmount(dockPanelOpen, animDurations().fxFastMs);
  const batchOpen = editMode && multiSelected;
  const batchKeep = useDelayedUnmount(batchOpen, animDurations().fxFastMs);
  const [showGrid, setShowGrid] = useState(true);
  // 框选（I3）：鼠标在画布空白处拖拽画矩形，松开选中矩形内所有小组件。
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  /* 框选矩形的退场窗口（P2 三轮）：松手后播一拍淡出再卸载。 */
  const [marqueeFading, setMarqueeFading] = useState(false);
  const marqueeFadeTimer = useRef(0);
  // 防御性同步：任何路径退出编辑模式（含跨窗口 widget:edit-mode 事件）时，
  // 强制关闭添加面板，避免全屏遮罩残留在已不可交互的画布上。
  useEffect(() => {
    if (!editMode) {
      setShowGallery(false);
      setShowDockPanel(false);
    } else {
      preloadDockConfigPanel();
    }
  }, [editMode]);
  // 任务栏避让：编辑工具栏、灵动岛与批量工具栏共用同一个 bottom 偏移，
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
  useEffect(() => {
    const onResize = () => {
      const { instances, alignMoveWidget, setPosAnim } = useWidgetStore.getState();
      /* #76 clamp 位移走一次性 200ms 过渡，而不是瞬移。 */
      setPosAnim(instances.map((i) => i.id));
      for (const i of instances) {
        alignMoveWidget(i.id, i.x, i.y);
      }
    };
    // 等一轮 resize 事件全部落定再 clamp（连续 DPI 切换会触发多次）。
    let timer = 0;
    const debounced = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onResize, 250);
    };
    window.addEventListener("resize", debounced);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", debounced);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unEnter: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let disposed = false;
    void listen<unknown>("focus:game-paused-entered", () => {
      if (useSettingsStore.getState().general.pauseDuringGaming) setGameCovered(true);
    }).then((f) => {
      if (disposed) f();
      else unEnter = f;
    });
    void listen<unknown>("focus:game-paused-exited", () => setGameCovered(false)).then((f) => {
      if (disposed) f();
      else unExit = f;
    });
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
  // P2（审计修复）：StrictMode 双跑时第二遍会在 addWidget 的防抖落盘窗口内
  // 读到"无布局"而再播一遍默认组件（开发模式 12 个）；且 .then 无取消，卸载
  // 后仍执行。加 cancelled 标志 + 模块级 seeded 幂等标记双保险。
  useEffect(() => {
    let cancelled = false;
    void hydrate().then(() => {
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
      setBootDone(true);
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
  useEffect(() => {
    if (!editMode) return;
    const onKey = (e: KeyboardEvent) => {
      const exit = useSettingsStore.getState().appShortcuts["exit-edit"];
      if (!exit.enabled || !appAccelMatches(exit.accel, e)) return;
      if (showGallery) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      useWidgetStore.getState().setEditMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, showGallery]);

  // 命令面板「添加小组件」入口：进入编辑模式并打开图库。
  useEffect(() => {
    const onOpen = () => {
      useWidgetStore.getState().setEditMode(true);
      setShowGallery(true);
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
    }).then((f) => {
      if (disposed) f();
      else un = f;
    });
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
    }).then((f) => {
      if (disposed) f();
      else un = f;
    });
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
    }).then((f) => {
      if (disposed) f();
      else un = f;
    });
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
          setShowGallery(true);
        }
      },
      editMode
        ? { label: tr("退出编辑"), icon: <X size={15} />, onSelect: () => setEditMode(false) }
        : { label: tr("编辑布局"), icon: <Pencil size={15} />, onSelect: () => setEditMode(true) },
      { type: "separator" },
      {
        label: tr("网格显示"),
        icon: <Grid3X3 size={15} />,
        onSelect: () => {
          setEditMode(true);
          setShowGrid((g) => !g);
        }
      },
      {
        label: tr("灵动岛"),
        icon: <Dock size={15} />,
        onSelect: () => {
          setEditMode(true);
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

  /* #69 添加视图后自动切换到新视图，让「新建」即刻可见（配合新按钮入场动画）。 */
  const addViewPrompt = async () => {
    const name = await promptDialog({ title: tr("输入新视图名称") });
    if (name && name.trim()) {
      const id = addView(name.trim());
      if (id) setActiveView(id);
    }
  };

  /* 框选（I3）：在编辑模式空白处按下左键开始画矩形，松开选中矩形内的全部小组件；
     按到的若是小组件/交互控件则交给各自处理。
     P2（审计修复）：拖选中途组件卸载（切视图等）会让 window 上的三个监听器
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
    const startX = e.clientX;
    const startY = e.clientY;
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
      pendingX = ev.clientX;
      pendingY = ev.clientY;
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
      const x1 = Math.min(startX, ev.clientX);
      const x2 = Math.max(startX, ev.clientX);
      const y1 = Math.min(startY, ev.clientY);
      const y2 = Math.max(startY, ev.clientY);
      /* P2 三轮：矩形先播一拍淡出再卸载（命中计算已在下方完成，淡出期间
         pointer-events 已被 CSS 关闭）。 */
      setMarqueeFading(true);
      marqueeFadeTimer.current = window.setTimeout(() => {
        marqueeFadeTimer.current = 0;
        setMarquee(null);
        setMarqueeFading(false);
      }, animDurations().fxXfastMs);
      const ids = useWidgetStore
        .getState()
        .instances.filter((i) => i.x < x2 && i.x + i.w > x1 && i.y < y2 && i.y + i.h > y1)
        .map((i) => i.id);
      if (ids.length) {
        setSelected(ids);
        /* #67 命中确认：命中卡描边播一次 accent 脉冲。 */
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

  return (
    <div
      className={`widget-canvas${editMode ? " editing" : ""}${gameCovered ? " game-covered" : ""}${showGrid && editMode ? " show-grid" : ""}${immersive ? " focus-immersed" : ""}${deepLock ? " focus-locked" : ""}`}
      onPointerDown={onCanvasPointerDown}
      onContextMenu={onCanvasContextMenu}
    >
      {/* DOCK（C2 → 灵动岛 2.0）：贴边聚合容器外壳（几何/磁贴/接管按屏持久化；
          展开态复用 expand-store）。单磁贴内容各有边界，但岛壳自身抛错此前会
          沿 WidgetCanvas 炸掉整个桌面层窗口——这里兜一层，崩溃即隐藏岛
          （已写崩溃日志），画布照常。 */}
      <WidgetErrorBoundary instanceId="dock" type="dock-shell" fallback={null}>
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
        {/* DeskOrder 借鉴 #12：编组容器（成员卡不单独渲染）。 */}
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

      {/* #70 空态引导卡：切到空视图 / 清空后提示添加入口。
          五.9：整卡可点击——直接进编辑模式并打开图库（最低成本的「从零到一」
          路径，不必先知道右键菜单存在）；图标挂 ambientMotion 门控的轻脉冲。 */}
      {showGuide && (
        <div
          className={`canvas-empty-guide${guideClosing ? " is-closing" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            useWidgetStore.getState().setEditMode(true);
            setShowGallery(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              useWidgetStore.getState().setEditMode(true);
              setShowGallery(true);
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

      {/* 框选矩形（I3）：编辑模式空白处拖拽时显示。#67 淡入 + 虚线行军；
          P2 三轮补松手淡出退场。 */}
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

      {/* #75 布局保存失败提示条 */}
      {(saveFailed || toastVisible) && (
        <div className={`canvas-save-toast${toastClosing ? " is-closing" : ""}`}>
          <TriangleAlert size={14} />
          {tr("布局保存失败，请检查磁盘空间")}
        </div>
      )}

      {/* 多选批量工具栏（I3）：框选 ≥2 个小组件时浮出，含对齐/等距/删除。 */}
      {batchKeep && (
        <div
          className={`widget-batch-toolbar${batchOpen ? "" : " is-closing"}`}
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
          {/* BentoDesk 借鉴 #8：自动排布（网格/横排/纵列，包围盒内 track 布局）。 */}
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
          {/* 样式预设批量套用（DeskOrder 借鉴 #4）：选中全为同类型时可把该类型的
              预设一键套到所有选中实例（内容字段不随预设走，见 style-presets.ts）。 */}
          <BatchPresetButton selectedIds={selectedIds} instances={instances} />
          <button
            className="widget-batch-btn danger"
            title={tr("删除选中")}
            aria-label={tr("删除选中")}
            onClick={() => removeAnimated(useWidgetStore.getState().selectedIds)}
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
            onClick={() => setShowGallery(true)}
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
          <button
            className={`widget-edit-toolbar-btn${showTemplates ? " active" : ""}`}
            onClick={() => {
              setShowTemplates((v) => !v);
              if (showHistory) setShowHistory(false);
            }}
            title={tr("布局模板")}
            data-interactive
          >
            <LayoutTemplate size={16} />
            <span>{tr("布局模板")}</span>
          </button>
          <button
            className={`widget-edit-toolbar-btn${showHistory ? " active" : ""}`}
            onClick={() => {
              setShowHistory((v) => !v);
              if (showTemplates) setShowTemplates(false);
            }}
            title={tr("布局历史")}
            data-interactive
          >
            <History size={16} />
            <span>{tr("布局历史")}</span>
          </button>
          <button
            className={`widget-edit-toolbar-btn${showDockPanel ? " active" : ""}`}
            onClick={() => setShowDockPanel((v) => !v)}
            title={tr("灵动岛")}
            data-interactive
          >
            <Dock size={16} />
            <span>{tr("灵动岛")}</span>
          </button>
          <button
            className={`widget-edit-toolbar-btn${showGrid ? " active" : ""}`}
            onClick={() => setShowGrid((g) => !g)}
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

      {templatesKeep && <LayoutTemplatePanel closing={!showTemplates} />}
      {historyKeep && <LayoutHistoryPanel closing={!showHistory} />}
      {dockPanelKeep && (
        <WidgetErrorBoundary instanceId="dock" type="dock-config-panel" fallback={null}>
          <Suspense fallback={null}>
            <DockConfigPanel closing={!dockPanelOpen} />
          </Suspense>
        </WidgetErrorBoundary>
      )}

      {showGallery && <WidgetGallery onClose={() => setShowGallery(false)} />}
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
  const types = new Set(instances.filter((i) => selectedIds.includes(i.id)).map((i) => i.type));
  const uniformType = types.size === 1 ? ([...types][0] as string) : null;
  const presets = uniformType ? listStylePresets(uniformType) : [];
  /* 菜单退场（P2 三轮）：.widget-context-menu 自带 menu-in 入场与
     .is-closing（ctx-menu-out）退场，此前条件渲染直接卸载导致退场缺失。
     与 ContextMenu 同范式：关闭后保留一拍播退场再卸载，期间 pointer-events
     已被 CSS 关闭。 */
  const menuVisible = useDelayedUnmount(open && !!uniformType, animDurations().fxFastMs);

  const applyToSelection = (preset: StylePreset) => {
    if (!uniformType) return;
    /* sanitizeWidgetConfig 静态依赖 config-schemas（32 个 zod schema）：该模块
       已随配置弹层拆异步，此处（批量套预设，编辑模式低频动作）动态取用，
       不把 schema 全家拖回主 chunk。 */
    void import("./config-schemas").then(({ sanitizeWidgetConfig }) => {
      for (const id of selectedIds) {
        // 现读权威副本再合并：预设已剥内容字段，条目/格位等不随预设走。
        const cur = loadWidgetConfig(id);
        saveWidgetConfig(id, sanitizeWidgetConfig(uniformType, mergeStyleConfig(cur, preset)));
        if (preset.opacity != null) updateWidget(id, { opacity: preset.opacity });
      }
      setOpen(false);
    });
  };

  return (
    <div className="wbatch-preset-wrap">
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
