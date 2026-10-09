/**
 * 设置页 · 视图管理页组：视图列表增删改名、每屏视图分配与默认视图设置；
 * 布局数据经 widget-store 双后端持久化。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Layers,
  LayoutGrid,
  Monitor,
  Pencil,
  Plus,
  Search,
  Trash2,
  X
} from "lucide-react";
import { useSettingsStore } from "../../../store/settings-store";
import {
  getWidgetMeta,
  WIDGET_REGISTRY,
  CATEGORY_NAMES,
  type WidgetCategory,
  type WidgetMeta
} from "../../../widget/registry";
import { loadInstances, useWidgetStore } from "../../../widget/widget-store";
import { widgetDisplayName } from "../../../widget/display-name";
import { promptRenameInstance, promptViewName } from "../../../widget/rename";
import { useT } from "../../../i18n-lite";
import { alertDialog, confirmDialog } from "../../../components/PromptDialog";
import { pushAppToast } from "../../../components/ToastHost";
import { FxText } from "../../../lib/fx";
import { useSafeTimeout } from "../../../lib/use-safe-timeout";
import { useDelayedUnmount } from "../../../lib/anim";
import { animDurations } from "../../../lib/durations";
import type { Page } from "../shared";
import type { MonitorInfo } from "./DisplayPage";

/**
 * Multi-view management: shows every dynamic view, its widget count, which one
 * is active, and lets the user switch / rename / delete / reset a view.
 * 列表里点任意一行 = 切换到该视图并收起设置窗（与行内「切换」按钮、下方「切换到 X」
 * 同一动作）；要进某个视图的管理页走左侧边栏——此前行点击是跳管理页，列表不变只有
 * 标题和操作区换、入场错落重放，用户看到的就是「闪一下、没切换」。
 */
export function ViewPage({
  view,
  onNavigate,
  monitors
}: {
  view: string;
  onNavigate: (p: Page) => void;
  /** 设置窗当前显示器列表（SettingsView 唯一数据源下发）；多屏时标题旁
      显示「作用于哪块屏」徽标，单屏无歧义不显示。 */
  monitors?: MonitorInfo[];
}) {
  const tr = useT();
  const views = useWidgetStore((s) => s.views);
  const activeView = useWidgetStore((s) => s.activeView);
  const setActiveView = useWidgetStore((s) => s.setActiveView);
  const renameView = useWidgetStore((s) => s.renameView);
  const removeView = useWidgetStore((s) => s.removeView);
  const resetView = useWidgetStore((s) => s.resetView);
  const addView = useWidgetStore((s) => s.addView);
  const duplicateView = useWidgetStore((s) => s.duplicateView);
  const reorderViews = useWidgetStore((s) => s.reorderViews);
  const setSettingsOpen = useSettingsStore((s) => s.setSettingsOpen);
  /* 视图页必须点明「正在管理哪块屏」——多屏下这里切换/删除的是管理
     分区那块屏的视图，不是用户眼前这块屏；唯一提示原先只在显示器页。 */
  const managedScreen = useWidgetStore((s) => s.screenId);
  const managedName = monitors?.find((m) => String(m.id) === managedScreen)?.name;
  const multiScreen = (monitors?.length ?? 0) > 1;
  /* 视图计数：loadInstances 每次都全量读 localStorage + JSON.parse，此前在
     views.map 渲染体内逐视图调用——本页任何重渲（store 任意变化）都重复解析
     全部布局。改 useMemo 缓存，实例表引用变化作失效信号（侧栏同款手法，
     见 SettingsView viewWidgetCounts）。 */
  const layoutRev = useWidgetStore((s) => s.instances);
  // layoutRev 仅作失效信号：实例表引用一变（含其它视图的保存）即重算计数。
  const viewCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const v of views) counts[v.id] = loadInstances(v.id).length;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, layoutRev]);
  const current = views.find((v) => v.id === view);
  /* 视图可能已被其它窗口删除（跨窗口同步）——此前 `return null` 整页
     空白且无提示；重定向到剩余第一个视图的管理页，一个不剩时给出空态。 */
  useEffect(() => {
    if (current || views.length === 0) return;
    const first = views[0];
    if (first && first.id !== view) onNavigate(`view-${first.id}`);
  }, [current, views, view, onNavigate]);
  /* 拖拽排序：行拖拽与上移/下移共用 reorderViews。 */
  const [dragViewId, setDragViewId] = useState<string | null>(null);
  const moveView = (id: string, dir: -1 | 1) => {
    const idx = views.findIndex((v) => v.id === id);
    const neighbor = views[idx + dir];
    if (idx < 0 || !neighbor) return;
    reorderViews(id, neighbor.id);
  };

  const switchToView = (id: string) => {
    setActiveView(id);
    setSettingsOpen(false);
  };

  if (!current) {
    return (
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("视图")} />
        </div>
        <div className="tm-placeholder">{tr("该视图不存在或已被删除。")}</div>
      </section>
    );
  }

  const switchTo = () => switchToView(view);

  const handleRename = async () => {
    /* 命名约束（长度上限 + 重名拦截）与撤销 toast——与小组件/编组重命名
       同一套三件套，此前视图命名无任何约束。 */
    const name = await promptViewName(tr, {
      title: tr("输入新的视图名称"),
      initial: current.name,
      existing: views,
      selfId: view
    });
    if (!name || name === current.name) return;
    const prevName = current.name;
    renameView(view, name);
    pushAppToast(tr("已重命名视图"), "", "info", {
      action: { label: tr("撤销"), run: () => renameView(view, prevName) }
    });
  };

  const handleAddView = async () => {
    // 不做撞名拦截：store 的 addView 自动加序号（"Work" → "Work 2"）。
    const name = await promptViewName(tr, { title: tr("输入新视图名称") });
    if (!name) return;
    const id = addView(name);
    if (id) onNavigate(`view-${id}`);
  };

  /** 复制视图：克隆当前视图（实例重造 id + 数据桶搬家，store 内完成），
      名称以「（副本）」为基，撞名由 store 自动加序号。 */
  const handleDuplicate = () => {
    const id = duplicateView(view, `${current.name}（${tr("副本")}）`);
    if (id) onNavigate(`view-${id}`);
  };

  /**
   * 删除任意视图（按 id），不再只能删"当前页"的视图：
   *  - 每行都有独立删除按钮，删的就是那一行对应的视图；
   *  - 若删除的正是本页视图，跳转到剩余的第一个视图管理页；
   *  - 活动视图被删时由 removeView 内部回退到第一个视图。
   */
  const handleDeleteView = async (id: string, name: string) => {
    if (views.length <= 1) {
      await alertDialog({ title: tr("无法删除"), message: tr("至少需要保留一个视图。") });
      return;
    }
    /* 删视图 = 组件进回收站（store 内实现），确认文案如实说明可恢复。 */
    if (
      !(await confirmDialog({
        title: tr("删除视图"),
        message: tr("确定删除视图「{name}」吗？其中 {n} 个小组件将移入回收站，30 天内可恢复。", {
          name,
          n: viewCounts[id] ?? 0
        }),
        confirmLabel: tr("删除"),
        danger: true
      }))
    )
      return;
    const fallback = views.find((v) => v.id !== id)?.id ?? "home";
    removeView(id);
    if (id === view) onNavigate(`view-${fallback}`);
  };

  const handleReset = async () => {
    if (
      await confirmDialog({
        title: tr("清空视图"),
        message: tr("清空「{name}」视图的全部小组件？它们将移入回收站，30 天内可恢复。", {
          name: current.name
        }),
        confirmLabel: tr("清空"),
        danger: true
      })
    ) {
      resetView(view);
    }
  };

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        <FxText text={tr("{name} 视图", { name: current.name })} />
        {multiScreen && managedName && (
          <button
            className="tm-managed-chip"
            onClick={() => onNavigate("display")}
            title={tr("视图与小组件的添加、配置作用于：") + managedName}
          >
            <Monitor size={12} /> {tr("作用于：{name}", { name: managedName })}
          </button>
        )}
      </div>

      <div className="tm-view-list">
        {views.map((v, vi) => {
          const n = viewCounts[v.id] ?? 0;
          const active = activeView === v.id;
          return (
            <div
              key={v.id}
              className={`tm-view-row${active ? " active" : ""}${dragViewId === v.id ? " dragging" : ""}`}
              style={{ "--sti": vi } as CSSProperties}
              onClick={() => switchToView(v.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  switchToView(v.id);
                }
              }}
              role="button"
              tabIndex={0}
              title={tr("切换到 {name}", { name: v.name })}
              data-interactive
              draggable
              onDragStart={(e) => {
                setDragViewId(v.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragViewId && dragViewId !== v.id) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragViewId && dragViewId !== v.id) reorderViews(dragViewId, v.id);
                setDragViewId(null);
              }}
              onDragEnd={() => setDragViewId(null)}
            >
              <div className="tm-view-icon">
                <LayoutGrid size={16} />
              </div>
              <div className="tm-view-info">
                <span className="tm-view-name">{v.name}</span>
                <span className="tm-view-count">{tr("{n} 个小组件", { n })}</span>
              </div>
              {active ? (
                <span className="tm-view-active">
                  <Check size={13} /> {tr("已启用")}
                </span>
              ) : (
                <button
                  className="tm-view-switch"
                  onClick={(e) => {
                    e.stopPropagation();
                    switchToView(v.id);
                  }}
                  data-interactive
                >
                  {tr("切换")}
                  <ArrowRight size={12} />
                </button>
              )}
              {/* 上移/下移（拖拽的键盘等价物；行首/行尾禁用）。 */}
              <span className="tm-view-move">
                <button
                  aria-label={tr("上移")}
                  title={tr("上移")}
                  disabled={vi === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveView(v.id, -1);
                  }}
                  data-interactive
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  aria-label={tr("下移")}
                  title={tr("下移")}
                  disabled={vi === views.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveView(v.id, 1);
                  }}
                  data-interactive
                >
                  <ChevronDown size={13} />
                </button>
              </span>
              <button
                className="tm-view-del"
                aria-label={tr("删除视图 {name}", { name: v.name })}
                title={tr("删除视图")}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDeleteView(v.id, v.name);
                }}
                data-interactive
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="tm-view-actions">
        <div className="tm-view-actions-label">{tr("视图操作")}</div>
        <button className="tm-action-row" onClick={switchTo}>
          <ArrowRight size={15} />
          <span>{tr("切换到 {name}", { name: current.name })}</span>
        </button>
        <button className="tm-action-row" onClick={handleRename}>
          <Pencil size={15} />
          <span>{tr("重命名")}</span>
        </button>
        {/* 页内补齐「添加视图」（此前只在侧栏底部）与「复制视图」。 */}
        <button className="tm-action-row" onClick={() => void handleAddView()}>
          <Plus size={15} />
          <span>{tr("添加视图")}</span>
        </button>
        <button className="tm-action-row" onClick={handleDuplicate}>
          <Copy size={15} />
          <span>{tr("复制视图")}</span>
        </button>
        <button className="tm-action-row danger" onClick={handleReset}>
          <Trash2 size={15} />
          <span>{tr("清空本视图")}</span>
        </button>
        <button className="tm-action-row danger" onClick={() => void handleDeleteView(view, current.name)}>
          <Trash2 size={15} />
          <span>{tr("删除视图")}</span>
        </button>
      </div>

      <button className="tm-add-widget-btn" onClick={() => onNavigate("gallery")}>
        <Plus size={15} /> {tr("添加小组件")}
      </button>
    </section>
  );
}

/**
 * Widget management for the current view (the "通知区域" group). Lists the
 * widgets already added to the active view (name + delete) and offers an
 * "添加小组件" picker backed by WIDGET_REGISTRY. Works without edit mode.
 */
export function WidgetsPage({
  onNavigate,
  monitors
}: {
  onNavigate: (p: Page) => void;
  /** 同 ViewPage：多屏时标题旁显示管理分区指向哪块屏。 */
  monitors?: MonitorInfo[];
}) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const instances = useWidgetStore((s) => s.instances);
  const activeView = useWidgetStore((s) => s.activeView);
  const views = useWidgetStore((s) => s.views);
  const trash = useWidgetStore((s) => s.trash);
  /* 与 ViewPage 同款管理分区徽标。 */
  const managedScreen = useWidgetStore((s) => s.screenId);
  const managedName = monitors?.find((m) => String(m.id) === managedScreen)?.name;
  const multiScreen = (monitors?.length ?? 0) > 1;
  /* 编组归属徽标的数据源——小组件住进编组后从桌面消失，列表里指明
     它住在哪个组（点击直达组页）。 */
  const groups = useWidgetStore((s) => s.groups);
  const removeWidget = useWidgetStore((s) => s.removeWidget);
  const restoreWidget = useWidgetStore((s) => s.restoreWidget);
  const purgeWidget = useWidgetStore((s) => s.purgeWidget);
  const emptyWidgetTrash = useWidgetStore((s) => s.emptyWidgetTrash);
  const [pickerOpen, setPickerOpen] = useState(false);
  /* 关闭回调必须引用稳定——此前调用处传内联箭头函数，父组件任何重渲
     （store 任意字段变化）都会让 WidgetPicker 的 [onClose] effect 重跑并经
     rAF 抢回焦点，用户正在操作的别处控件被拽走。 */
  const closePicker = useCallback(() => setPickerOpen(false), []);
  /* 关闭退场：面板 pop-out（--dur-fx-xfast 档）播完再卸载，时长同源跟随速度档。 */
  const pickerRender = useDelayedUnmount(pickerOpen, animDurations().fxXfastMs);
  const viewName = views.find((v) => v.id === activeView)?.name ?? activeView;

  /* #52：行退场先播淡出（--dur-fx，三.1 与 CSS 同源取值——原固定 180ms 在
     慢档会把 w-row-out 截断、快档又空等）再执行删除/恢复/彻底删除。 */
  const [rowOut, setRowOut] = useState<Set<string>>(new Set());
  const rowRemove = (id: string, fn: () => void) => {
    if (rowOut.has(id)) return;
    setRowOut((s) => new Set(s).add(id));
    safeTimeout(
      () => {
        fn();
        setRowOut((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      },
      Math.round(animDurations().fxMs) + 20
    );
  };

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        <FxText text={tr("当前视图小组件（{name}）", { name: viewName })} />
        {multiScreen && managedName && (
          <button
            className="tm-managed-chip"
            onClick={() => onNavigate("display")}
            title={tr("视图与小组件的添加、配置作用于：") + managedName}
          >
            <Monitor size={12} /> {tr("作用于：{name}", { name: managedName })}
          </button>
        )}
      </div>
      {instances.length === 0 ? (
        <div className="tm-placeholder">{tr("当前视图还没有小组件。")}</div>
      ) : (
        <div className="tm-widget-list">
          {instances.map((inst, i) => {
            const meta = getWidgetMeta(inst.type);
            const Icon = meta?.icon ?? LayoutGrid;
            /* 所属编组（有则显示徽标，点击直达组页）。 */
            const owner = groups.find((g) => g.memberIds.includes(inst.id));
            return (
              <div
                className={`tm-widget-row${rowOut.has(inst.id) ? " is-closing" : ""}`}
                key={inst.id}
                style={{ "--sti": i } as CSSProperties}
              >
                {/* 列表行走 widgetDisplayName（重命名 label + 同类型序号）——
                    与桌面卡片标题/组标签同源，此前两个时钟显示同名无法区分。 */}
                <span className="tm-widget-name" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon size={15} />
                  {widgetDisplayName(inst.type, inst.id, instances, tr)}
                </span>
                {owner && (
                  <button
                    className="tm-btn-secondary"
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
                    onClick={() => onNavigate(`group-config-${owner.id}`)}
                    title={tr("查看编组")}
                    data-interactive
                  >
                    <Layers size={12} /> {owner.name?.trim() || tr("编组")}
                  </button>
                )}
                {/* 列表页重命名入口（与卡片右键/配置弹层/组页同一共享实现）。 */}
                <button
                  className="tm-btn-secondary"
                  onClick={() => void promptRenameInstance(inst.id, tr)}
                  data-interactive
                >
                  {tr("重命名")}
                </button>
                <button className="tm-btn-danger" onClick={() => rowRemove(inst.id, () => removeWidget(inst.id))}>
                  <Trash2 size={14} /> {tr("删除")}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="tm-view-actions">
        <button className="tm-btn-secondary" onClick={() => setPickerOpen(true)}>
          <Plus size={14} /> {tr("添加小组件")}
        </button>
      </div>
      {pickerRender && <WidgetPicker onClose={closePicker} closing={!pickerOpen} />}

      {/* 回收站：删除的小组件先进这里，30 天内可恢复 */}
      <div className="tm-section-title" style={{ marginTop: 20 }}>
        <FxText text={tr("回收站")} />
      </div>
      <p className="tm-setting-desc" style={{ margin: "2px 0 8px" }}>
        {tr("删除的小组件可在 30 天内恢复")}
      </p>
      {trash.length === 0 ? (
        <div className="tm-placeholder">{tr("回收站为空")}</div>
      ) : (
        <div className="tm-widget-list">
          {trash.map((t, i) => {
            const meta = getWidgetMeta(t.type);
            const viewName2 = views.find((v) => v.id === t.view)?.name ?? t.view;
            return (
              <div
                className={`tm-widget-row${rowOut.has(t.id) ? " is-closing" : ""}`}
                key={t.id}
                style={{ "--sti": i } as CSSProperties}
              >
                <span className="tm-widget-name">
                  {/* 回收站行优先显示删除时的自定义名（label 随条目快照带入，
                      恢复时原样带回）；此处无实例表，不做同类型序号。 */}
                  {t.label?.trim() || (meta ? tr(meta.name) : t.type)}
                  <span className="tm-widget-sub">
                    {tr("删除于 {date} · {view}", {
                      date: new Date(t.deletedAt).toLocaleString(),
                      view: viewName2
                    })}
                  </span>
                </span>
                <button className="tm-btn-secondary" onClick={() => rowRemove(t.id, () => restoreWidget(t.id))}>
                  <Check size={14} /> {tr("恢复")}
                </button>
                <button
                  className="tm-btn-danger"
                  onClick={async () => {
                    /* 彻底删除不可恢复，与同页「清空回收站」统一走确认弹窗。 */
                    if (
                      await confirmDialog({
                        title: tr("彻底删除"),
                        message: tr("该小组件将从回收站永久移除，无法恢复。确定继续？"),
                        confirmLabel: tr("彻底删除"),
                        danger: true
                      })
                    )
                      rowRemove(t.id, () => purgeWidget(t.id));
                  }}
                >
                  <Trash2 size={14} /> {tr("彻底删除")}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {trash.length > 0 && (
        <div className="tm-view-actions">
          <button
            className="tm-btn-danger"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: tr("清空回收站"),
                  message: tr("确定清空回收站？"),
                  confirmLabel: tr("清空"),
                  danger: true
                })
              )
                emptyWidgetTrash();
            }}
          >
            <Trash2 size={14} /> {tr("清空回收站")}
          </button>
        </div>
      )}
    </section>
  );
}

/** Modal picker that adds a widget (from WIDGET_REGISTRY) to the current view.
 *  （可达性）：补 role=dialog/aria-modal、Esc 关闭与打开时首焦。
 *  顶部搜索框（双语匹配，与 Gallery 同口径）——此前弹层只能逐格翻找。 */
function WidgetPicker({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const tr = useT();
  const addWidget = useWidgetStore((s) => s.addWidget);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WIDGET_REGISTRY.filter(
      (w) =>
        !w.dockOnly &&
        !w.hidden &&
        (!q ||
          w.name.toLowerCase().includes(q) ||
          w.desc.toLowerCase().includes(q) ||
          tr(w.name).toLowerCase().includes(q) ||
          tr(w.desc).toLowerCase().includes(q))
    );
    // tr 引用稳定但内容随语言变：useT 的 useCallback 以语言为依赖，语言切换
    // 会换引用并触发本 memo 重算（tr 本身就在依赖里，无需额外失效键）。
  }, [query, tr]);
  /* 首焦只做一次（ref 兜底，effect 因任何原因重跑不再抢焦点）。 */
  const didFocusRef = useRef(false);
  useEffect(() => {
    /* Esc 关闭 + Tab 焦点陷阱（移植 PromptDialog 模型）——
       Tab/Shift+Tab 循环限制在弹层内，焦点意外逃逸时拉回首元素。 */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!panelRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const raf = requestAnimationFrame(() => {
      if (didFocusRef.current) return;
      didFocusRef.current = true;
      panelRef.current?.querySelector<HTMLButtonElement>(".widget-picker-card")?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
    };
  }, [onClose]);
  return (
    <div className={`widget-picker-overlay${closing ? " is-closing" : ""}`} onClick={onClose}>
      <div
        ref={panelRef}
        className={`widget-picker-panel${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={tr("添加小组件")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="widget-picker-head">
          <span className="widget-picker-title">{tr("添加小组件")}</span>
          <button className="widget-picker-close" onClick={onClose} aria-label={tr("关闭")}>
            <X size={15} />
          </button>
        </div>
        {/* 弹层内搜索（双语），与 Gallery 页同口径。 */}
        <div className="widget-picker-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("搜索小组件…")}
            aria-label={tr("搜索小组件")}
            spellCheck={false}
            data-interactive
          />
        </div>
        <div className="widget-picker-grid">
          {filtered.map((w) => {
            const Icon = w.icon;
            return (
              <button
                key={w.type}
                className="widget-picker-card"
                onClick={() => {
                  addWidget(w.type, w.defaultSize);
                  onClose();
                }}
                data-interactive
              >
                <Icon size={18} />
                <span>{tr(w.name)}</span>
              </button>
            );
          })}
          {filtered.length === 0 && <div className="tm-placeholder">{tr("没有匹配的小组件")}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Full-size widget gallery shown as a settings page (the "添加小组件" target).
 * M3 大改版：顶栏 = 返回 + 搜索 + 分类芯片（全部 / 常用 / 办公 / 在线）；
 * 主体为全宽卡片网格（图标芯片 + 名称，悬停浮起并浮现「+」），单击即添加
 * 到当前视图，卡片短暂打勾反馈；描述收敛到卡片 tooltip。
 * 图标芯片不再按类型随机配色（旧 GALLERY_HUES 与主题主色脱节），统一走
 * settings.css 的 `--h` 缺省 = var(--accent)。
 */

export function WidgetGalleryPage({ onBack }: { onBack: () => void }) {
  const tr = useT();
  const addWidget = useWidgetStore((s) => s.addWidget);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<"all" | WidgetCategory>("all");
  /* 刚添加的组件类型：卡片上短暂打勾反馈。 */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const addedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(addedTimer.current), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WIDGET_REGISTRY.filter((w) => {
      if (w.dockOnly || w.hidden) return false;
      if (cat !== "all" && w.category !== cat) return false;
      if (!q) return true;
      /* 双语匹配——注册表原名（中文）+ 界面语言译文。此前只匹配原文，
         英文界面搜 "clock" 零结果（卡片显示的却正是英文名）。 */
      return (
        w.name.toLowerCase().includes(q) ||
        w.desc.toLowerCase().includes(q) ||
        tr(w.name).toLowerCase().includes(q) ||
        tr(w.desc).toLowerCase().includes(q)
      );
    });
    // tr 在依赖里且随语言换引用（useT 的 useCallback）：语言切换自动重算命中。
  }, [query, cat, tr]);

  const handleAdd = (w: WidgetMeta) => {
    addWidget(w.type, w.defaultSize);
    setJustAdded(w.type);
    window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => setJustAdded(null), 1200);
  };

  const cats: { id: "all" | WidgetCategory; label: string; count: number }[] = [
    { id: "all", label: tr("全部"), count: WIDGET_REGISTRY.filter((w) => !w.dockOnly && !w.hidden).length },
    ...(["focus", "tools", "system", "online"] as WidgetCategory[]).map((c) => ({
      id: c,
      label: tr(CATEGORY_NAMES[c]),
      count: WIDGET_REGISTRY.filter((w) => !w.dockOnly && !w.hidden && w.category === c).length
    }))
  ];

  return (
    <section className="tm-section tm-gallery-page">
      <div className="tm-gallery-topbar">
        <button className="tm-btn-secondary" onClick={onBack}>
          <ArrowLeft size={15} /> {tr("返回")}
        </button>
        <div className="tm-gallery-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("搜索小组件…")}
            aria-label={tr("搜索小组件")}
            data-interactive
          />
        </div>
      </div>
      <div className="tm-gallery-chips" role="tablist" aria-label={tr("分类")}>
        {cats.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={cat === c.id}
            className={`tm-gallery-chip${cat === c.id ? " active" : ""}`}
            onClick={() => setCat(c.id)}
            data-interactive
          >
            {c.label}
            <span className="tm-gallery-chip-count">{c.count}</span>
          </button>
        ))}
      </div>
      {/* 「全部」= 按分类分节展示（节标题 + 两列网格）；选了具体分类则平铺该类。
          二.7：key 只含分类——此前 key 拼入 query，搜索每敲一个字符整网格重挂并
          重放 tm-page-in 入场动画（连打持续闪烁）；换分类保留整页入场语义。 */}
      <div className="tm-gallery-scroll" key={cat}>
        {(() => {
          const renderCard = (w: WidgetMeta) => {
            const Icon = w.icon;
            const added = justAdded === w.type;
            return (
              <button
                key={w.type}
                type="button"
                className={`tm-gallery-card${added ? " just-added" : ""}`}
                title={tr(w.desc)}
                onClick={() => handleAdd(w)}
                data-interactive
              >
                <span className="tm-gallery-card-icon" aria-hidden="true">
                  <Icon size={20} />
                </span>
                <span className="tm-gallery-card-text">
                  <span className="tm-gallery-card-name">{tr(w.name)}</span>
                  <span className="tm-gallery-card-desc">{tr(w.desc)}</span>
                </span>
                <span className="tm-gallery-card-add" aria-hidden="true">
                  {added ? <Check size={14} /> : <Plus size={14} />}
                </span>
              </button>
            );
          };
          if (cat !== "all") return <div className="tm-gallery-grid">{filtered.map(renderCard)}</div>;
          const sections = (["focus", "tools", "system", "online"] as WidgetCategory[])
            .map((c) => ({
              category: c,
              label: tr(CATEGORY_NAMES[c]),
              items: filtered.filter((w) => w.category === c)
            }))
            .filter((g) => g.items.length > 0);
          return sections.map((g) => (
            <div className="tm-gallery-cat" key={g.category}>
              <div className="tm-gallery-cat-label">{g.label}</div>
              <div className="tm-gallery-grid">{g.items.map(renderCard)}</div>
            </div>
          ));
        })()}
        {filtered.length === 0 && <div className="tm-placeholder">{tr("没有匹配的小组件")}</div>}
      </div>
    </section>
  );
}
