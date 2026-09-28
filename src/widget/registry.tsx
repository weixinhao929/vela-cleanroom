/**
 * 小组件注册表（注册表模式 + 工厂惰性加载）。
 *
 * 职责：集中声明全部小组件的元数据（类型 id/名称/描述/分类/图标/默认与
 * 最小尺寸）与懒加载组件（React.lazy，按需分 chunk）。WidgetGallery 据此
 * 渲染添加面板，WidgetCanvas 据此解析实例类型；新增小组件只需在
 * WIDGET_REGISTRY 与 WIDGET_LOADERS 各登记一条。
 */
import { lazy, memo, useMemo, type ComponentType } from "react";
import {
  Activity,
  AlarmClock,
  Bell,
  Bluetooth,
  Bookmark,
  Brush,
  Calculator,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  CloudSun,
  Disc3,
  Folder,
  Gauge,
  Image,
  Inbox,
  LayoutGrid,
  ListTodo,
  Monitor,
  Music,
  Palette,
  Pin,
  Repeat,
  Ruler,
  StickyNote,
  Timer,
  TimerReset,
  Trash2,
  Sun,
  SunDim,
  type LucideIcon
} from "lucide-react";
import { t, useT } from "../i18n-lite";
import { useAppStore } from "../store/app-store";
import { loadNotes, subscribeNotes } from "./notes-store";
import { CHANGE_EVENT, loadWidgetConfig } from "./widget-config";
import { useWidgetStore } from "./widget-store";
import type { ExpandedComponentProps, ExpandedComponentType } from "./expand-store";

/** C1 沉浸组件 props 契约（re-export，供 Dock/卡片等消费方从 registry 单点引用）。 */
export type { ExpandedComponentProps, ExpandedComponentType } from "./expand-store";

/* ------------------------------------------------------------------ *
 * 小组件懒加载（P4）
 *
 * 之前这里静态 import 了全部 23 个小组件 + 4 个功能面板，于是主 bundle
 * 里塞进了 canvas 绘图、Markdown 渲染、Excel 课表解析、蓝牙/硬件监控、
 * 邮件 IMAP 客户端等全部代码 —— 而典型用户桌面上只放 3~5 个小组件。
 * 冷启动要下载 + 解析 + 执行这些永远用不到的模块。
 *
 * 改为 `React.lazy`：每个小组件成为独立 chunk，只在被实际放上画布时
 * 才请求。渲染侧由 `WidgetCard` 的 `<Suspense>` 提供骨架占位。
 *
 * 注意保持 `WidgetMeta.component` 的类型不变（`ComponentType`），这样
 * 下方 27 条注册项与所有消费方代码都不需要改动：`lazy()` 返回的
 * `LazyExoticComponent` 在渲染语义上完全等价，仅类型签名不同。
 * ------------------------------------------------------------------ */

type WidgetComponent = ComponentType<{ instanceId: string }>;

/**
 * 包装一个具名导出的动态 import 为可直接渲染的组件。
 * `lazy` 要求模块默认导出，这里统一把具名导出映射成 default。
 */
function lazyWidget<K extends string>(
  loader: () => Promise<Record<K, WidgetComponent>>,
  exportName: K
): WidgetComponent {
  const Lazy = lazy<ComponentType<{ instanceId: string }>>(async () => ({
    default: (await loader())[exportName] as ComponentType<{ instanceId: string }>
  }));
  // PERF-1：内容组件统一 memo。编辑会话中被拖拽/缩放的卡片外壳每帧重渲，
  // 但其内容子树 props（instanceId）不变，memo 在此处短路，避免 24+ 挂件
  // 的整棵内容树随拖拽逐帧重渲染（Timetable/Calendar 同屏时单帧 5-20ms）。
  return memo(function MemoizedWidget(props: { instanceId: string }) {
    return <Lazy instanceId={props.instanceId} />;
  }) as unknown as WidgetComponent;
}

/**
 * C1 沉浸组件懒加载：与 lazyWidget 同构，但 props 为 ExpandedComponentProps
 * （instanceId + active）。独立 chunk——只在首次展开时才拉取。
 *
 * 登记规范（供 Dock 会话对接）：
 *  1. 在 `src/widget/widgets/` 写沉浸组件，具名导出，签名
 *     `({ instanceId, active }: ExpandedComponentProps) => JSX`；
 *     active=false 时**必须**暂停轮询 / rAF / 采集（组件保持挂载不重建）；
 *  2. 下方用 `lazyExpanded(() => import(...), "ExportName")` 包一层；
 *  3. 在 WIDGET_REGISTRY 对应条目加 `ExpandedComponent: <上一步的常量>`，
 *     并在 EXPANDED_LOADERS 登记同一 import 表达式（预热用）。
 *  卡片悬浮工具条据 `meta.ExpandedComponent` 是否存在决定显示「展开」入口；
 *  展开态互斥由 expand-store（expandedId 单值）保证。
 */
function lazyExpanded<K extends string>(
  loader: () => Promise<Record<K, ExpandedComponentType>>,
  exportName: K
): ExpandedComponentType {
  const Lazy = lazy<ExpandedComponentType>(async () => ({
    default: (await loader())[exportName] as ExpandedComponentType
  }));
  return memo(function MemoizedExpanded(props: ExpandedComponentProps) {
    return <Lazy {...props} />;
  }) as unknown as ExpandedComponentType;
}

/**
 * 灵动岛迷你形态（ISLAND-CORE §4.2）props 契约：
 * - `instanceId`：磁贴绑定的画布实例（可选——无实例的磁贴读 DockTile.config）；
 * - `active`：磁贴层当前是否可见（接管期间 false）。迷你组件只读已有
 *   store / 事件，禁止自建 interval；有持续性工作的须在 active=false 时暂停。
 */
export type MiniComponentProps = { instanceId?: string; active: boolean };
export type MiniComponentType = ComponentType<MiniComponentProps>;

/**
 * 迷你形态懒加载：与 lazyExpanded 同构（独立 chunk，首次入岛才拉取）。
 *
 * 登记规范（供后续迷你形态会话对接）：
 *  1. 在 `src/widget/widgets/mini/<Type>Mini.tsx` 写迷你组件（≤60 行），
 *     具名导出，签名 `(props: MiniComponentProps) => JSX`；
 *  2. 下方用 `lazyMini(() => import("./widgets/mini/<Type>Mini"), "<Type>Mini")`；
 *  3. 在 WIDGET_REGISTRY 对应条目加 `MiniComponent`，可选 `miniSummary`。
 *  未登记 MiniComponent 的类型由 DockTile 以通用磁贴（icon + name + miniSummary）渲染。
 */
function lazyMini<K extends string>(
  loader: () => Promise<Record<K, MiniComponentType>>,
  exportName: K
): MiniComponentType {
  const Lazy = lazy<MiniComponentType>(async () => ({
    default: (await loader())[exportName] as MiniComponentType
  }));
  return memo(function MemoizedMini(props: MiniComponentProps) {
    return <Lazy {...props} />;
  }) as unknown as MiniComponentType;
}

const AnalyticsPanel = lazyWidget(() => import("../features/analytics/AnalyticsPanel"), "AnalyticsPanel");
const DeadlinePanel = lazyWidget(() => import("../features/deadlines/DeadlinePanel"), "DeadlinePanel");
const PomodoroPanel = lazyWidget(() => import("../features/pomodoro/PomodoroPanel"), "PomodoroPanel");
const TodayTasksPanel = lazyWidget(() => import("../features/tasks/TodayTasksPanel"), "TodayTasksPanel");
const BluetoothWidget = lazyWidget(() => import("./widgets/BluetoothWidget"), "BluetoothWidget");
const BookmarksWidget = lazyWidget(() => import("./widgets/BookmarksWidget"), "BookmarksWidget");
const BrightnessWidget = lazyWidget(() => import("./widgets/BrightnessWidget"), "BrightnessWidget");
const CalculatorWidget = lazyWidget(() => import("./widgets/CalculatorWidget"), "CalculatorWidget");
const CalendarWidget = lazyWidget(() => import("./widgets/CalendarWidget"), "CalendarWidget");
const ClockWidget = lazyWidget(() => import("./widgets/ClockWidget"), "ClockWidget");
const ColorPickerWidget = lazyWidget(() => import("./widgets/ColorPickerWidget"), "ColorPickerWidget");
const CountdownWidget = lazyWidget(() => import("./widgets/CountdownWidget"), "CountdownWidget");
const EmailWidget = lazyWidget(() => import("./widgets/EmailWidget"), "EmailWidget");
const FileBrowserWidget = lazyWidget(() => import("./widgets/FileBrowserWidget"), "FileBrowserWidget");
const GalleryWidget = lazyWidget(() => import("./widgets/GalleryWidget"), "GalleryWidget");
const HabitWidget = lazyWidget(() => import("./widgets/HabitWidget"), "HabitWidget");
const HardwareWidget = lazyWidget(() => import("./widgets/HardwareWidget"), "HardwareWidget");
const MusicWidget = lazyWidget(() => import("./widgets/MusicWidget"), "MusicWidget");
const NowPlayingWidget = lazyWidget(() => import("./widgets/MusicWidget"), "NowPlayingWidget");
const NotificationCenterWidget = lazyWidget(
  () => import("./widgets/NotificationCenterWidget"),
  "NotificationCenterWidget"
);
const NotesWidget = lazyWidget(() => import("./widgets/NotesWidget"), "NotesWidget");
const PinWidget = lazyWidget(() => import("./widgets/PinWidget"), "PinWidget");
const RecycleWidget = lazyWidget(() => import("./widgets/RecycleWidget"), "RecycleWidget");
const ShortcutsWidget = lazyWidget(() => import("./widgets/ShortcutsWidget"), "ShortcutsWidget");
const SketchWidget = lazyWidget(() => import("./widgets/SketchWidget"), "SketchWidget");
const StopwatchWidget = lazyWidget(() => import("./widgets/StopwatchWidget"), "StopwatchWidget");
const SystemBarWidget = lazyWidget(() => import("./widgets/SystemBarWidget"), "SystemBarWidget");
const SystemWidget = lazyWidget(() => import("./widgets/SystemWidget"), "SystemWidget");
const TimetableWidget = lazyWidget(() => import("./widgets/TimetableWidget"), "TimetableWidget");
const TodayOverviewWidget = lazyWidget(() => import("./widgets/TodayOverviewWidget"), "TodayOverviewWidget");
const UnitConverterWidget = lazyWidget(() => import("./widgets/UnitConverterWidget"), "UnitConverterWidget");
const WeatherWidget = lazyWidget(() => import("./widgets/WeatherWidget"), "WeatherWidget");
const ClipboardHistoryWidget = lazyWidget(() => import("./widgets/ClipboardHistoryWidget"), "ClipboardHistoryWidget");

/* C1 沉浸展开态组件（首批：音乐沉浸页 / 天气站；G9 补任务全览/课程表/
   专注统计/邮件——任务全览在 todo 条目上，其余三个复用面板本体）。 */
const MusicImmersive = lazyExpanded(() => import("./widgets/MusicImmersive"), "MusicImmersive");
const WeatherStation = lazyExpanded(() => import("./widgets/WeatherStation"), "WeatherStation");
const AnalyticsExpanded = lazyExpanded(() => import("./widgets/AnalyticsExpanded"), "AnalyticsExpanded");
const TimetableExpanded = lazyExpanded(() => import("./widgets/TimetableExpanded"), "TimetableExpanded");
const EmailExpanded = lazyExpanded(() => import("./widgets/EmailExpanded"), "EmailExpanded");

/* 灵动岛迷你形态（首批三枚：自 DockContainer 迁出，行为不变）。 */
const ClockMini = lazyMini(() => import("./widgets/mini/ClockMini"), "ClockMini");
const PomodoroMini = lazyMini(() => import("./widgets/mini/PomodoroMini"), "PomodoroMini");
const NotificationsMini = lazyMini(() => import("./widgets/mini/NotificationsMini"), "NotificationsMini");

/* 灵动岛迷你形态（ISLAND-MINI 首批九种；music 与 nowplaying 共用 MusicMini）。 */
const MusicMini = lazyMini(() => import("./widgets/mini/MusicMini"), "MusicMini");
const WeatherMini = lazyMini(() => import("./widgets/mini/WeatherMini"), "WeatherMini");
const SystemMini = lazyMini(() => import("./widgets/mini/SystemMini"), "SystemMini");
const ClipboardMini = lazyMini(() => import("./widgets/mini/ClipboardMini"), "ClipboardMini");
const BrightnessMini = lazyMini(() => import("./widgets/mini/BrightnessMini"), "BrightnessMini");
const TodoMini = lazyMini(() => import("./widgets/mini/TodoMini"), "TodoMini");
const CalendarMini = lazyMini(() => import("./widgets/mini/CalendarMini"), "CalendarMini");
const CountdownMini = lazyMini(() => import("./widgets/mini/CountdownMini"), "CountdownMini");
const HabitMini = lazyMini(() => import("./widgets/mini/HabitMini"), "HabitMini");
const StopwatchMini = lazyMini(() => import("./widgets/mini/StopwatchMini"), "StopwatchMini");

/* 「杂项」面板（仅灵动岛）：磁贴 = 图标 + 条目数；展开面板由 DockTile.DockTileExpanded 按类型
   分派到 MiscBoardPanel（需要整个 tile 对象存布局，不走 ExpandedComponent 的 instanceId 契约）；
   画布组件只是一块提示（dockOnly，画廊不展示，只防旧布局 / 导入带进来时白屏）。 */
const MiscCanvasHint = lazyWidget(() => import("./widgets/misc/MiscBoardPanel"), "MiscCanvasHint");
const MiscMini = lazyMini(() => import("./widgets/mini/MiscMini"), "MiscMini");

/* ------------------------------------------------------------------ *
 * G8 通用磁贴摘要：MiniComponent 之外的常见类型入岛后只有 图标 + 名称，
 * 补一行同步可算的摘要（todo 有 TodoMini 不在此列）。计算只读已有
 * store / localStorage 快照（O(条目数)，条目均为两位数级）；配套的
 * miniSummarySubscribe 让 DockTile 在数据变化时重算，避免摘要成为
 * 挂载时刻的死值。空串 = 不显示摘要行（GenericMiniTile 对 falsy 不渲染）。
 * ------------------------------------------------------------------ */

/** 订阅某实例小组件配置的同窗口变更（saveWidgetConfig 必发 CHANGE_EVENT）。 */
function subscribeWidgetConfig(instanceId: string | undefined, onChange: () => void): () => void {
  if (!instanceId) return () => {};
  const onEvent = (e: Event) => {
    if ((e as CustomEvent<string>).detail === instanceId) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onEvent);
  return () => window.removeEventListener(CHANGE_EVENT, onEvent);
}

/** 今日概览：未完成待办数（与 TodayOverviewWidget 的 pendingTasks 同口径，不限日期）。 */
const todayOverviewSummary = () => {
  const n = useAppStore.getState().tasks.filter((task) => !task.completed).length;
  return n > 0 ? t("{n} 项待办", { n }) : t("今日无待办");
};

/** 截止日期：未完成数 + 逾期数（逾期判定与 DeadlinePanel 一致：dueAt < 当前时刻）。 */
const deadlinesSummary = () => {
  const open = useAppStore.getState().deadlines.filter((d) => !d.completed);
  if (open.length === 0) return t("无未完成截止");
  const now = Date.now();
  const overdue = open.filter((d) => Date.parse(d.dueAt) < now).length;
  return overdue > 0
    ? t("{n} 项未完成 · 逾期 {k}", { n: open.length, k: overdue })
    : t("{n} 项未完成", { n: open.length });
};

/** 便签：当前实例的条数（含回收站外的全部便签）。 */
const notesSummary = (instanceId?: string) => {
  if (!instanceId) return "";
  return t("共 {n} 条", { n: loadNotes(instanceId).length });
};

/** 回收站：可恢复的小组件数。 */
const recycleSummary = () => {
  const n = useWidgetStore.getState().trash.length;
  return n > 0 ? t("{n} 个可恢复", { n }) : t("空");
};

/** 快捷方式：已添加的自定义快捷方式数（config.customShortcuts）。 */
const shortcutsSummary = (instanceId?: string) => {
  if (!instanceId) return "";
  const list = loadWidgetConfig(instanceId).customShortcuts;
  const n = Array.isArray(list) ? list.length : 0;
  return n > 0 ? t("共 {n} 个", { n }) : t("未添加");
};

/** 桌面文件：根目录名（未设置时按组件默认显示桌面）。 */
const filesSummary = (instanceId?: string) => {
  if (!instanceId) return "";
  const root = loadWidgetConfig(instanceId).root;
  if (typeof root !== "string" || !root) return t("桌面");
  const name =
    root
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return name || root;
};

/** 小组件分类。 */
export type WidgetCategory = "focus" | "tools" | "system" | "online";

/** 单个小组件的注册元数据（画廊展示 + 画布解析共用）。 */
export type WidgetMeta = {
  /** 类型 id（持久化在实例上，不可变更）。 */
  type: string;
  name: string;
  desc: string;
  category: WidgetCategory;
  icon: LucideIcon;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  component: ComponentType<{ instanceId: string }>;
  /**
   * C1 展开态：登记后卡片悬浮工具条出现「展开」入口，点击进入沉浸面板
   * （min(720px, 90vw)，z 序置顶 + blur 遮罩，Esc 收回）。懒加载独立 chunk；
   * 常驻叠放不重建——active=false 时组件保持挂载但须自行暂停持续性工作。
   */
  ExpandedComponent?: ExpandedComponentType;
  /**
   * 沉浸展开用「浮动窗口」模式（WidgetExpandOverlay floating）：无全屏玻璃
   * 遮罩，点击面板外不收回且穿透到桌面（普通窗口语义），仅关闭按钮 / Esc
   * 收回。未登记 = 既有模态语义（全屏遮罩 + 点击空白收回）。
   */
  expandFloating?: boolean;
  /**
   * 灵动岛迷你形态（F-1）：登记后磁贴显示富形态（时间 / 进度环 / 温度…），
   * 未登记则 DockTile 用通用磁贴（icon + name + miniSummary）。所有类型都可入岛。
   */
  MiniComponent?: MiniComponentType;
  /** 通用磁贴的一行摘要（可选），也用于磁贴 aria-label「类型名 · 摘要」。 */
  miniSummary?: (instanceId?: string) => string;
  /**
   * G8 摘要数据源订阅：DockTile 挂载时调用，返回退订函数；数据变化时回调
   * 让磁贴重算 miniSummary（订阅 selector 只做引用比较，O(1)/次变更）。
   * 未登记则摘要只在磁贴因其它原因重渲时刷新（与旧版行为一致）。
   */
  miniSummarySubscribe?: (instanceId: string | undefined, onChange: () => void) => () => void;
  /**
   * 仅灵动岛可用：画布图库 / 设置页「添加小组件」不展示（useTranslatedWidgetRegistry 已过滤），
   * 灵动岛类型选择器照常列出。用于「杂项」这类只有作为磁贴才有意义的类型。
   */
  dockOnly?: boolean;
  /**
   * 内部类型：不出现在任何添加入口（画布图库 / 设置页 / 灵动岛选择器 /
   * 磁贴配置面板），实例只由内部流程创建——如截图套件「钉到桌面」写出的
   * 贴图。注册项仍供画布渲染与磁贴解析使用。
   */
  hidden?: boolean;
  /**
   * 接收 OS 文件拖放（useOsFileDrop）：登记后，用户从资源管理器拖文件
   * 进入屏幕时（file-drag-store active），WidgetCard 给本类型卡片挂
   * `.file-drop-target` 显形类。投放命中后的行为仍由组件内部处理。
   */
  acceptsOsFiles?: boolean;
};

export const CATEGORY_NAMES: Record<WidgetCategory, string> = {
  focus: "专注",
  tools: "工具",
  system: "系统",
  online: "在线"
};

export const WIDGET_REGISTRY: WidgetMeta[] = [
  {
    type: "clock",
    name: "时钟",
    desc: "超大数字时钟与日期",
    category: "tools",
    icon: AlarmClock,
    defaultSize: { w: 320, h: 200 },
    minSize: { w: 200, h: 140 },
    component: ClockWidget,
    MiniComponent: ClockMini
  },
  {
    type: "todayoverview",
    name: "今日概览",
    desc: "今日课程、待办与截止日期一屏掌握",
    category: "focus",
    icon: Sun,
    defaultSize: { w: 320, h: 380 },
    minSize: { w: 260, h: 260 },
    component: TodayOverviewWidget,
    miniSummary: todayOverviewSummary,
    miniSummarySubscribe: (_instanceId, onChange) => useAppStore.subscribe((s) => s.tasks, onChange)
  },
  {
    type: "todo",
    name: "待办清单",
    desc: "跟踪任务并勾选完成",
    category: "focus",
    icon: CheckSquare,
    defaultSize: { w: 320, h: 360 },
    minSize: { w: 240, h: 220 },
    component: TodayTasksPanel,
    ExpandedComponent: lazyExpanded(() => import("./widgets/TaskOverview"), "TaskOverview"),
    MiniComponent: TodoMini
  },
  {
    type: "pomodoro",
    name: "番茄钟",
    desc: "专注计时与休息提醒",
    category: "focus",
    icon: Timer,
    defaultSize: { w: 340, h: 430 },
    minSize: { w: 260, h: 340 },
    component: PomodoroPanel,
    MiniComponent: PomodoroMini
  },
  {
    type: "deadlines",
    name: "截止日期",
    desc: "查看即将到来的截止时间",
    category: "focus",
    icon: ListTodo,
    defaultSize: { w: 320, h: 300 },
    minSize: { w: 240, h: 200 },
    component: DeadlinePanel,
    miniSummary: deadlinesSummary,
    miniSummarySubscribe: (_instanceId, onChange) => useAppStore.subscribe((s) => s.deadlines, onChange)
  },
  {
    type: "analytics",
    name: "专注统计",
    desc: "专注时长与趋势图表",
    category: "focus",
    icon: Activity,
    defaultSize: { w: 320, h: 300 },
    minSize: { w: 240, h: 200 },
    component: AnalyticsPanel,
    ExpandedComponent: AnalyticsExpanded
  },
  {
    type: "notes",
    name: "便签",
    desc: "快速记录想法",
    category: "tools",
    icon: StickyNote,
    defaultSize: { w: 300, h: 280 },
    minSize: { w: 200, h: 180 },
    component: NotesWidget,
    miniSummary: notesSummary,
    // 数据驱动（saveNotes/saveTrash 落盘即触发，跨窗口写入经 sync:notes
    // 落到本窗口的 saveNotes 同样覆盖）：替代此前 30s 盲轮询——轮询不判
    // document.hidden、不对比结果，磁贴挂一天空转近三千次。
    miniSummarySubscribe: (_instanceId, onChange) => subscribeNotes(onChange)
  },
  {
    type: "recycle",
    name: "回收站",
    desc: "恢复误删的小组件",
    category: "system",
    icon: Trash2,
    defaultSize: { w: 300, h: 300 },
    minSize: { w: 240, h: 200 },
    component: RecycleWidget,
    miniSummary: recycleSummary,
    miniSummarySubscribe: (_instanceId, onChange) => useWidgetStore.subscribe((s) => s.trash, onChange)
  },
  {
    type: "timetable",
    name: "课程表",
    desc: "导入 Excel 课表，周视图展示",
    category: "focus",
    icon: CalendarDays,
    defaultSize: { w: 420, h: 460 },
    minSize: { w: 320, h: 300 },
    component: TimetableWidget,
    ExpandedComponent: TimetableExpanded
  },
  {
    type: "sketch",
    name: "涂鸦板",
    desc: "手写与绘制的便签版",
    category: "tools",
    icon: Brush,
    defaultSize: { w: 320, h: 300 },
    minSize: { w: 240, h: 220 },
    component: SketchWidget
  },
  {
    type: "system",
    name: "系统监控",
    desc: "CPU 与内存实时占用",
    category: "system",
    icon: Activity,
    defaultSize: { w: 300, h: 260 },
    minSize: { w: 220, h: 180 },
    component: SystemWidget,
    MiniComponent: SystemMini
  },
  {
    type: "hardware",
    name: "硬件监控",
    desc: "CPU / 内存 / GPU / 磁盘 / 网络 / 电池",
    category: "system",
    icon: Activity,
    defaultSize: { w: 340, h: 380 },
    minSize: { w: 260, h: 300 },
    component: HardwareWidget
  },
  {
    type: "calendar",
    name: "日历",
    desc: "查看日期与事件",
    category: "tools",
    icon: CalendarDays,
    defaultSize: { w: 320, h: 320 },
    minSize: { w: 240, h: 240 },
    component: CalendarWidget,
    MiniComponent: CalendarMini
  },
  {
    type: "weather",
    name: "天气",
    desc: "任意位置的实时天气",
    category: "online",
    icon: CloudSun,
    defaultSize: { w: 300, h: 200 },
    minSize: { w: 220, h: 150 },
    component: WeatherWidget,
    ExpandedComponent: WeatherStation,
    MiniComponent: WeatherMini
  },
  {
    type: "sysbar",
    name: "系统监控栏",
    desc: "FPS / GPU / CPU / 延迟",
    category: "system",
    icon: Gauge,
    defaultSize: { w: 560, h: 60 },
    minSize: { w: 320, h: 48 },
    component: SystemBarWidget
  },
  {
    type: "shortcuts",
    name: "快捷方式",
    desc: "桌面文件拖入即用，图标自由排布",
    category: "system",
    icon: Monitor,
    defaultSize: { w: 240, h: 220 },
    minSize: { w: 180, h: 160 },
    component: ShortcutsWidget,
    acceptsOsFiles: true,
    miniSummary: shortcutsSummary,
    miniSummarySubscribe: subscribeWidgetConfig
  },
  {
    type: "files",
    name: "桌面文件",
    desc: "直接浏览桌面文件夹",
    category: "system",
    icon: Folder,
    defaultSize: { w: 320, h: 400 },
    minSize: { w: 240, h: 240 },
    component: FileBrowserWidget,
    miniSummary: filesSummary,
    miniSummarySubscribe: subscribeWidgetConfig
  },
  {
    // 编码哈希并入计算器（三页签：计算 / 编码 / 哈希），尺寸取三页的折中。
    type: "calculator",
    name: "计算器",
    desc: "计算 · Base64/URL 编解码 · 哈希核对",
    category: "tools",
    icon: Calculator,
    defaultSize: { w: 300, h: 400 },
    minSize: { w: 240, h: 320 },
    component: CalculatorWidget,
    acceptsOsFiles: true
  },
  {
    type: "unitconverter",
    name: "单位换算",
    desc: "长度 / 重量 / 温度 / 数据",
    category: "tools",
    icon: Ruler,
    defaultSize: { w: 280, h: 260 },
    minSize: { w: 240, h: 220 },
    component: UnitConverterWidget
  },
  {
    type: "colorpicker",
    name: "取色器",
    desc: "拾取颜色并复制",
    category: "tools",
    icon: Palette,
    defaultSize: { w: 260, h: 240 },
    minSize: { w: 220, h: 200 },
    component: ColorPickerWidget
  },
  {
    type: "stopwatch",
    name: "秒表",
    desc: "正计时与计次",
    category: "tools",
    icon: TimerReset,
    defaultSize: { w: 260, h: 320 },
    minSize: { w: 200, h: 240 },
    component: StopwatchWidget,
    MiniComponent: StopwatchMini
  },
  {
    // 贴图：只由截图套件「钉到桌面」创建（hidden = 不进任何添加入口，
    // 手动加出来的只能是空贴图）；钉出后与普通组件一样可拖动 / 缩放 / 删除。
    type: "pin",
    name: "贴图",
    desc: "钉在桌面的截图",
    category: "tools",
    icon: Pin,
    defaultSize: { w: 320, h: 240 },
    minSize: { w: 80, h: 60 },
    component: PinWidget,
    hidden: true
  },
  {
    type: "bookmarks",
    name: "书签",
    desc: "收藏常用网址",
    category: "online",
    icon: Bookmark,
    defaultSize: { w: 280, h: 300 },
    minSize: { w: 240, h: 220 },
    component: BookmarksWidget
  },
  {
    type: "music",
    name: "音频监控",
    desc: "播放/麦克风实时频谱",
    category: "system",
    icon: Music,
    defaultSize: { w: 320, h: 120 },
    minSize: { w: 200, h: 80 },
    component: MusicWidget,
    ExpandedComponent: MusicImmersive,
    expandFloating: true,
    MiniComponent: MusicMini
  },
  {
    // W-129：「正在播放」独立小组件（锁定卡片布局的 MusicWidget 变体）。
    type: "nowplaying",
    name: "正在播放",
    desc: "系统媒体控制卡片",
    category: "system",
    icon: Disc3,
    defaultSize: { w: 320, h: 90 },
    minSize: { w: 240, h: 72 },
    component: NowPlayingWidget,
    ExpandedComponent: MusicImmersive,
    expandFloating: true,
    MiniComponent: MusicMini
  },
  {
    type: "bluetooth",
    name: "蓝牙设备",
    desc: "已连接设备状态",
    category: "system",
    icon: Bluetooth,
    defaultSize: { w: 300, h: 280 },
    minSize: { w: 240, h: 220 },
    component: BluetoothWidget
  },
  {
    type: "gallery",
    name: "图库",
    desc: "图片网格与查看器",
    category: "tools",
    icon: Image,
    defaultSize: { w: 320, h: 320 },
    minSize: { w: 240, h: 220 },
    component: GalleryWidget
  },
  {
    type: "habit",
    name: "习惯打卡",
    desc: "每日习惯与连续天数",
    category: "focus",
    icon: Repeat,
    defaultSize: { w: 300, h: 320 },
    minSize: { w: 240, h: 220 },
    component: HabitWidget,
    MiniComponent: HabitMini
  },
  {
    type: "countdown",
    name: "倒计时",
    desc: "专注倒计时与预设时长",
    category: "focus",
    icon: Timer,
    defaultSize: { w: 300, h: 360 },
    minSize: { w: 240, h: 280 },
    component: CountdownWidget,
    MiniComponent: CountdownMini
  },
  {
    type: "email",
    name: "统一收件箱",
    desc: "多账号邮件聚合",
    category: "online",
    icon: Inbox,
    defaultSize: { w: 320, h: 360 },
    minSize: { w: 260, h: 260 },
    component: EmailWidget,
    ExpandedComponent: EmailExpanded
  },
  {
    // DOCK / 方案 D：通知中心——自发通知历史（SQLite v7）分组回看 + 滑动删除。
    type: "notifications",
    name: "通知中心",
    desc: "自发通知历史回看（分组/滑动删除/免打扰）",
    category: "system",
    icon: Bell,
    defaultSize: { w: 340, h: 430 },
    minSize: { w: 260, h: 320 },
    component: NotificationCenterWidget,
    MiniComponent: NotificationsMini
  },
  {
    // §4.12 亮度控制（实验性）：内置屏 WMI + 外接屏 DDC/CI，每屏一组滑条。
    type: "brightness",
    name: "亮度控制",
    desc: "逐屏调节显示器亮度（内置屏 / DDC 外接屏，实验性）",
    category: "system",
    icon: SunDim,
    defaultSize: { w: 300, h: 260 },
    minSize: { w: 230, h: 170 },
    component: BrightnessWidget,
    MiniComponent: BrightnessMini
  },
  {
    // §4.10 剪贴板历史（CLIP）：Rust 监听入库，纯本地存储；隐私开关在设置页通用 → 隐私区。
    type: "clipboard",
    name: "剪贴板历史",
    desc: "回看复制过的文本与图片，点击即再次复制",
    category: "system",
    icon: ClipboardList,
    defaultSize: { w: 320, h: 420 },
    minSize: { w: 250, h: 260 },
    component: ClipboardHistoryWidget,
    MiniComponent: ClipboardMini
  },
  {
    // 「杂项」面板（仅灵动岛）：点开是一块格子板，多枚小组件可拖动排布（磁性吸附 + 自动整理）。
    type: "misc",
    name: "杂项",
    desc: "一块面板装多个小组件：拖动排布、磁性吸附、自动整理",
    category: "tools",
    icon: LayoutGrid,
    defaultSize: { w: 320, h: 200 },
    minSize: { w: 200, h: 140 },
    component: MiscCanvasHint,
    MiniComponent: MiscMini,
    dockOnly: true
  }
];

/**
 * type → meta 索引。原先是 `WIDGET_REGISTRY.find()` 线性查找，而
 * `getWidgetMeta` 在每个小组件的每次渲染中都被调用（画布上 10 个小组件
 * 每帧就是 10 × 26 次字符串比较），换成 Map 是 O(1)。
 */
const REGISTRY_BY_TYPE = new Map(WIDGET_REGISTRY.map((w) => [w.type, w]));

/**
 * 按类型 id 查找注册元数据。
 *
 * @param type - 小组件类型 id。
 * @returns 元数据；未知类型返回 undefined（画布侧跳过渲染）。
 */
export function getWidgetMeta(type: string): WidgetMeta | undefined {
  return REGISTRY_BY_TYPE.get(type);
}

/** Hook: translated category names. */
export function useCategoryNames(): Record<WidgetCategory, string> {
  const tr = useT();
  return useMemo(
    () => ({
      focus: tr("专注"),
      tools: tr("工具"),
      system: tr("系统"),
      online: tr("在线")
    }),
    [tr]
  );
}

/** Hook: translated widget registry (name + desc). */
export function useTranslatedWidgetRegistry(): WidgetMeta[] {
  const tr = useT();
  return useMemo(
    () =>
      WIDGET_REGISTRY.filter((w) => !w.dockOnly && !w.hidden).map((w) => ({
        ...w,
        name: tr(w.name),
        desc: tr(w.desc)
      })),
    [tr]
  );
}

/* ======================================================================
 * C10（性能）：懒加载 chunk 的预加载通道。
 * 此前图库卡片只有点击/双击，首次添加任一小组件都要现场拉 chunk（有骨架
 * 但可感）。Vite 对同一模块的重复动态 import 会复用同一 chunk，这里按
 * registry type 建立与上方 lazyWidget 相同 import 表达式的映射即可安全去重。
 * ------------------------------------------------------------------ */
export const WIDGET_LOADERS: Record<string, () => Promise<unknown>> = {
  analytics: () => import("../features/analytics/AnalyticsPanel"),
  deadlines: () => import("../features/deadlines/DeadlinePanel"),
  pomodoro: () => import("../features/pomodoro/PomodoroPanel"),
  todo: () => import("../features/tasks/TodayTasksPanel"),
  bluetooth: () => import("./widgets/BluetoothWidget"),
  bookmarks: () => import("./widgets/BookmarksWidget"),
  calculator: () => import("./widgets/CalculatorWidget"),
  calendar: () => import("./widgets/CalendarWidget"),
  clock: () => import("./widgets/ClockWidget"),
  colorpicker: () => import("./widgets/ColorPickerWidget"),
  countdown: () => import("./widgets/CountdownWidget"),
  email: () => import("./widgets/EmailWidget"),
  files: () => import("./widgets/FileBrowserWidget"),
  gallery: () => import("./widgets/GalleryWidget"),
  habit: () => import("./widgets/HabitWidget"),
  hardware: () => import("./widgets/HardwareWidget"),
  music: () => import("./widgets/MusicWidget"),
  nowplaying: () => import("./widgets/MusicWidget"),
  notifications: () => import("./widgets/NotificationCenterWidget"),
  notes: () => import("./widgets/NotesWidget"),
  pin: () => import("./widgets/PinWidget"),
  recycle: () => import("./widgets/RecycleWidget"),
  shortcuts: () => import("./widgets/ShortcutsWidget"),
  sketch: () => import("./widgets/SketchWidget"),
  stopwatch: () => import("./widgets/StopwatchWidget"),
  sysbar: () => import("./widgets/SystemBarWidget"),
  system: () => import("./widgets/SystemWidget"),
  timetable: () => import("./widgets/TimetableWidget"),
  todayoverview: () => import("./widgets/TodayOverviewWidget"),
  unitconverter: () => import("./widgets/UnitConverterWidget"),
  weather: () => import("./widgets/WeatherWidget"),
  brightness: () => import("./widgets/BrightnessWidget"),
  clipboard: () => import("./widgets/ClipboardHistoryWidget"),
  misc: () => import("./widgets/misc/MiscBoardPanel")
};

/** 预加载一个（或全部）小组件 chunk；失败静默（骨架屏兜底）。 */
/**
 * 预热指定类型（缺省全部）的懒加载 chunk。
 * 使用场景：应用空闲时调用，消除首次添加小组件时的网络/解码延迟。
 *
 * @param types - 要预载的类型 id 数组；省略时预载全部。
 * @returns 无（fire-and-forget）。
 */
export function preloadWidgets(types?: string[]): void {
  const list = types ?? Object.keys(WIDGET_LOADERS);
  for (const t of list) WIDGET_LOADERS[t]?.().catch(() => {});
}

/* C1：沉浸组件 chunk 的预热通道（与 lazyExpanded 同一 import 表达式，Vite 去重）。 */
export const EXPANDED_LOADERS: Record<string, () => Promise<unknown>> = {
  music: () => import("./widgets/MusicImmersive"),
  nowplaying: () => import("./widgets/MusicImmersive"),
  weather: () => import("./widgets/WeatherStation"),
  analytics: () => import("./widgets/AnalyticsExpanded"),
  timetable: () => import("./widgets/TimetableExpanded"),
  email: () => import("./widgets/EmailExpanded"),
  // F2：五列看板是交互最重的沉浸页之一，缺登记会让悬停预热落空、首展吃
  // 一次 chunk 加载骨架（登记当时遗漏，现补齐）。
  todo: () => import("./widgets/TaskOverview")
};

/**
 * 预热指定类型的沉浸组件 chunk（悬停「展开」按钮时调用，消除首展加载
 * 骨架）；未登记沉浸组件的类型为 no-op，失败静默。
 */
export function preloadExpanded(type: string): void {
  EXPANDED_LOADERS[type]?.().catch(() => {});
}
