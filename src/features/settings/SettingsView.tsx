/**
 * 设置窗口主视图：左侧导航（页面 + 各小组件配置项，支持搜索过滤）+
 * 右侧内容路由；独立 WebView 与内嵌两种宿主形态共用。
 */
import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { useDelayedUnmount } from "../../lib/anim";
import { makeResettableLazy } from "../../lib/make-resettable-lazy";
import { animDurations } from "../../lib/durations";
import { useDismissable } from "../../lib/use-dismissable";
import {
  BadgeCheck,
  ChevronDown,
  Layers,
  LayoutGrid,
  Minus,
  Monitor,
  Paintbrush,
  PanelBottom,
  PanelTop,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Wifi,
  X,
  Zap,
  type LucideIcon
} from "lucide-react";
import { isTauri, invoke } from "../../lib/tauri";
import { appAccelMatches } from "../../lib/shortcuts";
import { luminance } from "../../lib/color";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { useInvalidationSignal } from "../../lib/use-invalidation-signal";
import { FxText, useFxEffectEnabled } from "../../lib/fx";
import { ParticleText } from "../../lib/rb";
import { useSettingsStore } from "../../store/settings-store";
import { getWidgetMeta, WIDGET_REGISTRY } from "../../widget/registry";
import { widgetDisplayName } from "../../widget/display-name";
import { loadInstances, loadGroups, useWidgetStore, type WidgetInstance } from "../../widget/widget-store";
import { useT } from "../../i18n-lite";
// 收款码图片不随仓库分发：用 glob 式按需取图，图片缺失时
// 下方捐款卡片区块整体不渲染，构建不报缺文件。
const donateImages = import.meta.glob<{ default: string }>("../../assets/donate-*.jpg", {
  eager: true
});
const donateWechat = donateImages["../../assets/donate-wechat.jpg"]?.default;
const donateAlipay = donateImages["../../assets/donate-alipay.jpg"]?.default;
import { pushAppToast } from "../../components/ToastHost";
import { promptViewName } from "../../widget/rename";
import { searchSettings, type SettingsSearchEntry } from "./settings-search";
import {
  SETTINGS_JUMP_EVENT,
  flashSettingsRowByTitle,
  peekPendingSettingsJump,
  requestSettingsJump,
  takePendingSettingsJump
} from "./settings-jump";
import { type Page, resolveDarkTheme } from "./shared";
/* （chunk 瘦身）：设置子页改 React.lazy——此前 9 个页面 + 小组件配置
   页全部静态 import，SettingsView 主 chunk 267KB（含任务栏 / 更新 / 常规
   等各自的 IPC 与 UI 依赖），设置窗首开即全量解析。现在每页独立 chunk、
   首次进入该页才加载（本地文件，毫秒级）。搜索索引（settings-search.ts）
   自带全部词条元数据、不依赖页面模块，侧栏导航照常立即可用；既有测试
   直接 import 页面文件不受影响。MonitorInfo 是纯类型，保留静态导入。 */
import type { MonitorInfo } from "./pages/DisplayPage";
/* 各子页改可重置 lazy（make-resettable-lazy）——页面 chunk 拉取失败后
   重试不再永久失效（失败沿 App 的设置窗错误边界兜住，其 onRetry 接本模块
   的 reset；页面级无本地边界，弃缓存后「重试」重渲染即重新 import）。 */
const StylePage = makeResettableLazy(
  () => import("./pages/StylePage").then((m) => ({ default: m.StylePage })),
  "StylePage"
);
const GeneralPage = makeResettableLazy(
  () => import("./pages/GeneralPage").then((m) => ({ default: m.GeneralPage })),
  "GeneralPage"
);
const AnimationPage = makeResettableLazy(
  () => import("./pages/AnimationPage").then((m) => ({ default: m.AnimationPage })),
  "AnimationPage"
);
const ConnectionPage = makeResettableLazy(
  () => import("./pages/ConnectionPage").then((m) => ({ default: m.ConnectionPage })),
  "ConnectionPage"
);
const ViewPage = makeResettableLazy(
  () => import("./pages/ViewPages").then((m) => ({ default: m.ViewPage })),
  "ViewPage"
);
const WidgetsPage = makeResettableLazy(
  () => import("./pages/ViewPages").then((m) => ({ default: m.WidgetsPage })),
  "WidgetsPage"
);
const WidgetGalleryPage = makeResettableLazy(
  () => import("./pages/ViewPages").then((m) => ({ default: m.WidgetGalleryPage })),
  "WidgetGalleryPage"
);
const UpdatePage = makeResettableLazy(
  () => import("./pages/UpdatePage").then((m) => ({ default: m.UpdatePage })),
  "UpdatePage"
);
const DisplayPage = makeResettableLazy(
  () => import("./pages/DisplayPage").then((m) => ({ default: m.DisplayPage })),
  "DisplayPage"
);
const DockPage = makeResettableLazy(
  () => import("./pages/DockPage").then((m) => ({ default: m.DockPage })),
  "DockPage"
);
const TaskbarPage = makeResettableLazy(
  () => import("./pages/TaskbarPage").then((m) => ({ default: m.TaskbarPage })),
  "TaskbarPage"
);
const WidgetConfigPage = makeResettableLazy(
  () => import("./widget-configs").then((m) => ({ default: m.WidgetConfigPage })),
  "WidgetConfigPage"
);
const DockTileConfigPage = makeResettableLazy(
  () => import("./widget-configs").then((m) => ({ default: m.DockTileConfigPage })),
  "DockTileConfigPage"
);
const MiscItemConfigPage = makeResettableLazy(
  () => import("./widget-configs").then((m) => ({ default: m.MiscItemConfigPage })),
  "MiscItemConfigPage"
);
const GroupConfigPage = makeResettableLazy(
  () => import("./widget-configs").then((m) => ({ default: m.GroupConfigPage })),
  "GroupConfigPage"
);
import { sanitizeMiscItems } from "../../widget/widgets/misc/misc-layout";
import { MISC_TYPE } from "../../widget/widgets/misc/MiscBoardPanel";
import { OnboardingOverlay } from "./OnboardingOverlay";
/* 动效样式（ParticleText / Bento 光斑 / 弹性开关等，仅设置页消费）：
   随本 chunk 加载，不再由 main 入口静态打包进所有窗口。 */
import "../../styles/rb.css";

/* 版本展示改用构建注入常量（vite.config.ts 从 package.json version 注入，
   __BUILD_TIME__ 同款 define；类型就近声明在唯一消费方，vite-env.d.ts 未动）。
   define 未注入的环境（理论上的裸转译）回落 0.1.0。 */
declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.1.0";

/** 懒页首进的轻量骨架——fallback=null 在冷启动 WebView 首拉 chunk 的
 *  一拍里右栏整块闪空。复用现有令牌与动画（tm-section 卡片 + tm-spinner +
 *  tm-content-swap 淡入），不引新样式文件/依赖。 */
function LazyPageFallback() {
  const tr = useT();
  return (
    <section
      className="tm-section"
      style={{
        minHeight: 200,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        color: "var(--muted-2)",
        animation: "tm-content-swap var(--dur-fx-fast, 0.15s) var(--ease-out) backwards"
      }}
    >
      <span className="tm-spinner" aria-hidden="true" />
      <span className="tm-placeholder" style={{ padding: 0 }}>
        {tr("加载中…")}
      </span>
    </section>
  );
}

/* 五.7 侧栏滑移指示条（组内）：量测本组顶层 .active 项几何，3px accent 圆棒
   平滑跟随（与 Segmented 滑动胶囊同语言）；active 不在本组时淡出。只做组内
   滑移——跨组共享一根指示条的 #90 方案此前已被产品决策否决（M3 药丸取代），
   组内滑动 + 跨组淡出淡入不与之冲突。折叠展开 / 界面缩放经 ResizeObserver
   与每次渲染后的重测保持对位。 */
function SidebarSlideBar({ page }: { page: string }) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ y: number; h: number; on: boolean }>({ y: 0, h: 0, on: false });
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const el =
      section.querySelector<HTMLElement>(
        ":scope > .tm-sidebar-item.active, :scope > .tm-sidebar-view > .tm-sidebar-item.active"
      ) ?? null;
    if (!el) {
      setBar((b) => (b.on ? { ...b, on: false } : b));
      return;
    }
    const y = el.offsetTop;
    const h = el.offsetHeight;
    setBar((b) => (b.y === y && b.h === h && b.on ? b : { y, h, on: true }));
  }, [page]);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const el =
        section.querySelector<HTMLElement>(
          ":scope > .tm-sidebar-item.active, :scope > .tm-sidebar-view > .tm-sidebar-item.active"
        ) ?? null;
      setBar((b) => (el ? { y: el.offsetTop, h: el.offsetHeight, on: true } : b.on ? { ...b, on: false } : b));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(section);
    return () => ro.disconnect();
  }, []);
  return (
    <span
      className={`tm-sidebar-slidebar${bar.on ? " on" : ""}`}
      style={{ transform: `translateY(${bar.y}px)`, height: bar.h }}
      aria-hidden="true"
    />
  );
}

/**
 * 侧栏导航（M3 单行列表）：彩色圆形图标芯片（--h 色相）+ 名称 + 行尾计数/箭头。
 * 「灵动岛」是折叠行：下方常驻挂载磁贴子列表，点磁贴直达其配置页（绑定实例 →
 * 实例页；无实例 → 磁贴页），与「视图」的折叠子列表同一交互。
 */
const NAV_ITEMS: { id: Page; name: string; hue: string; icon: LucideIcon }[] = [
  { id: "general", name: "常规", hue: "#8a97ab", icon: SlidersHorizontal },
  { id: "style", name: "样式", hue: "#e0559d", icon: Paintbrush },
  { id: "animation", name: "动画", hue: "#f59e0b", icon: Zap },
  { id: "connection", name: "连接", hue: "#0ea5e9", icon: Wifi },
  { id: "dock", name: "灵动岛", hue: "#22c55e", icon: PanelTop },
  { id: "taskbar", name: "任务栏", hue: "#8b5cf6", icon: PanelBottom },
  { id: "license", name: "许可证", hue: "#f43f5e", icon: BadgeCheck },
  { id: "update", name: "更新", hue: "#3b82f6", icon: RefreshCw }
];
const MONITOR_HUE = "#14b8a6";
const VIEW_HUE = "#a78bfa";
const EDIT_HUE = "#0ea5e9";

/* 色块芯片（--h）上的前景按亮度选择（同 theme-engine --btn-fg 口径）：固定
   色板里的绿/琥珀等中亮色上写死白字只有 ≈1.9:1，settings.css 消费 --h-ink。
   --h 传 CSS 值（var(--accent)）时无法测亮度，直接借用引擎按主色亮度算好
   的 --btn-fg。 */
function hueChipStyle(hue: string): CSSProperties {
  const ink = hue.startsWith("var(") ? "var(--btn-fg)" : luminance(hue) > 0.55 ? "#0a0e1a" : "#ffffff";
  return { "--h": hue, "--h-ink": ink } as CSSProperties;
}

export function SettingsView() {
  const tr = useT();
  const open = useSettingsStore((s) => s.settingsOpen);
  const setOpen = useSettingsStore((s) => s.setSettingsOpen);
  // 设置窗口跟随用户的明暗偏好：data-theme 决定 settings.css 里 Vercel 深浅
  // 两套色板。此前硬编码 glass 导致浅色主题下设置窗口仍为深色，且浅色色板
  // .tm-settings-window[data-theme="light"] 从未生效。
  const themePreset = useSettingsStore((s) => s.preset);
  const themeMode = useSettingsStore((s) => s.themeMode);
  /* 内层 data-theme 必须与**生效档**一致——浮窗覆盖（FloatingThemeSync
     写在 html 上的档）非 follow 时本窗实际生效的是浮窗档；此前仍按全局档
     判定，「全局暗 + 浮窗浅」时 settings.css 的 :has 规则读到错配色板。 */
  const floatingThemeMode = useSettingsStore((s) => s.floatingThemeMode);
  const effectiveThemeMode = floatingThemeMode !== "follow" ? floatingThemeMode : themeMode;
  const darkTheme = resolveDarkTheme(themePreset, effectiveThemeMode);
  const views = useWidgetStore((s) => s.views);
  /* 侧栏「视图 → 小组件计数」：loadInstances 每次都全量读 localStorage +
     JSON.parse，此前在 views.map 渲染体内逐视图调用——searchQ 每键重渲都
     重复解析全部布局。改 useMemo 缓存，并监听 widget-store 的持久化字段
     变化作失效键（实例增删 / 拖拽后计数即时更新，此前计数只在重挂载时刷新）。 */
  const layoutRev = useWidgetStore((s) => s.instances);
  const groupsRev = useWidgetStore((s) => s.groups);
  const { viewWidgetCounts, viewWidgetIds, viewGroups } = useMemo(() => {
    const counts: Record<string, number> = {};
    const ids: Record<string, WidgetInstance[]> = {};
    const groups: Record<string, ReturnType<typeof loadGroups>> = {};
    for (const v of views) {
      const list = loadInstances(v.id);
      ids[v.id] = list;
      counts[v.id] = list.length;
      groups[v.id] = loadGroups(v.id);
    }
    return { viewWidgetCounts: counts, viewWidgetIds: ids, viewGroups: groups };
    // layoutRev 作失效信号：实例表引用一变（含其它视图的保存）即重算；
    // groupsRev 同理（编组同步/增删后侧栏编组节点跟随）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, layoutRev, groupsRev]);
  const addView = useWidgetStore((s) => s.addView);
  const activeView = useWidgetStore((s) => s.activeView);
  const setActiveView = useWidgetStore((s) => s.setActiveView);
  const setEditMode = useWidgetStore((s) => s.setEditMode);
  // 视图折叠状态：默认展开当前页面对应的视图。
  const [expandedViews, setExpandedViews] = useState<Record<string, boolean>>({});
  // 编组节点（视图下第二级）的成员子列表折叠状态。
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  /* 设置搜索：关键词 + 输入框引用（Ctrl+K 聚焦、Escape 清空）。
     （性能）：searchQ 每键都会重渲整棵设置树（当前页全部控件 + 侧栏 +
     指示条重测）。索引检索用 useDeferredValue 延迟——输入框保持同步响应，
     重活（搜索 + 侧栏过滤渲染）在空闲帧跟进。 */
  const [searchQ, setSearchQ] = useState("");
  const deferredSearchQ = useDeferredValue(searchQ);
  const searchRef = useRef<HTMLInputElement | null>(null);
  /* 动态视图词条：静态索引表达不了 `view-<id>` 这类动态页面 id——搜视图名
     （如 "work"）此前零结果。逐视图生成词条 + 一条「视图管理」总词条（指向
     第一个视图的管理页，那里有切换/重命名/复制/清空/删除与排序的全部入口）。 */
  const viewSearchEntries = useMemo(() => {
    if (views.length === 0) return [];
    const entries: SettingsSearchEntry[] = [
      {
        page: `view-${views[0].id}`,
        group: "视图",
        title: "视图管理",
        keywords: [
          "view",
          "视图",
          "切换视图",
          "新建视图",
          "添加视图",
          "复制视图",
          "删除视图",
          "重命名视图",
          "排序",
          "多视图"
        ]
      }
    ];
    for (const v of views) {
      entries.push({
        page: `view-${v.id}`,
        group: "视图",
        title: v.name,
        keywords: [v.name, "view", "视图"]
      });
    }
    return entries;
  }, [views]);
  /* 搜索索引同时匹配中文词条与翻译后文本（English 界面）：tr 传入
     searchSettings 作翻译函数——其引用随语言切换变化（useT 的 useCallback
     依赖），作为 memo 依赖自然获得语言响应，无需 language 失效键绕法。 */
  const searchResults = useMemo(
    () => searchSettings(deferredSearchQ, 12, viewSearchEntries, tr),
    [deferredSearchQ, viewSearchEntries, tr]
  ); /* kbd 提示跟随实际快捷键（此前写死 "Ctrl K"，改绑后提示撒谎）；停用或
     未绑定时隐藏提示。 */
  const searchShortcut = useSettingsStore((s) => s.appShortcuts["settings-search"]);
  const searchKbd = searchShortcut?.enabled && searchShortcut.accel ? searchShortcut.accel.split("+").join(" ") : "";
  const [page, setPage] = usePageState();
  const targetPage = useSettingsStore((s) => s.settingsPage);
  // 兜底导航用的当前页引用（避免 effect 闭包捕获过期 page）。
  const pageRef = useRef(page);
  pageRef.current = page;

  /* 页面切换方向感知已移除：侧栏切页不再播放滑入动画（用户反馈「切页
     一直跳」），切页即时呈现；主题切换的晕开过渡（lib/theme-ink）不受影响。 */
  const navigate = useCallback(
    (p: Page) => {
      setPage(p);
    },
    [setPage]
  );

  /* 搜索命中 → 行级定位（settings-jump）：词条携带标题写入 pending，
     页面落地后按标题文本找到设置行滚动居中并脉冲。三个触发面汇到同一
     check：同窗事件（同页跳转）、page/open 变化（跨页跳转与懒加载落地）、
     跨窗 app:navigate-settings（其 handler 先 request 再 navigate）。
     page 不匹配时 pending 保留，等导航到达再消费。 */
  const stopRowFlashRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const check = () => {
      const jump = peekPendingSettingsJump();
      if (!jump || !open || jump.page !== pageRef.current) return;
      takePendingSettingsJump();
      stopRowFlashRef.current?.();
      stopRowFlashRef.current = flashSettingsRowByTitle(jump.title, tr);
    };
    window.addEventListener(SETTINGS_JUMP_EVENT, check);
    check();
    return () => {
      window.removeEventListener(SETTINGS_JUMP_EVENT, check);
      stopRowFlashRef.current?.();
      stopRowFlashRef.current = null;
    };
  }, [page, open, tr]);

  /* 显示器侧栏分组（动态）：list_monitors 枚举真实显示器，热插拔随
     monitors-changed 刷新。选中某屏 = 把「视图/小组件」的管理分区切到该屏。
     这里是设置窗口内显示器列表的唯一数据源（DisplayPage / TaskbarPage 经
     props 消费）——TaskbarPage 此前自建一套拉取 + 订阅，挂载与每次热插拔
     都双份 IPC，已收编到 props 下发（未提供时它才退回自取）。 */
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  /* list_monitors 失败此前静默（侧栏悄悄退回兜底入口，用户无从得知枚举
     坏了）——记录失败态，给出可见错误 + 重试入口。 */
  const [monitorsFailed, setMonitorsFailed] = useState(false);
  const managedScreen = useWidgetStore((s) => s.screenId);
  /** 拉取显示器列表；失败置位 monitorsFailed 供重试入口。管理分区的合法性
      校验（幽灵屏回落）见下方 effect——那里同时覆盖首拉、热插拔与 hydrate
      晚于首拉恢复持久化分区的竞态。 */
  const reloadMonitors = useCallback(() => {
    if (!isTauri()) return;
    invoke<MonitorInfo[]>("list_monitors")
      .then((ms) => {
        setMonitors(ms);
        setMonitorsFailed(false);
      })
      .catch(() => {
        setMonitors([]);
        setMonitorsFailed(true);
      });
  }, []);
  useEffect(() => {
    reloadMonitors();
  }, [reloadMonitors]);
  useTauriEvent("monitors-changed", reloadMonitors);
  /* 管理分区必须活在当前显示器列表里。三种来源会让它变成「幽灵屏」：
     ① 上次管理的屏被拔掉（WidgetHydrate 恢复持久化分区时无条件信任）；
     ② 热插拔后槽位消失；③ 恢复动作晚于首拉到达（竞态）。此前只有「恰好
     剩一块屏」才纠正，两屏以上时设置窗会继续管理不存在的分区——侧栏视图
     列表是幽灵数据，编辑落不到任何可见桌面。以 effect 方式在
     [monitors, managedScreen] 任一变化时校验（含 hydrate 恢复触发的变更），
     失效则回落主屏并提示。 */
  useEffect(() => {
    if (!isTauri() || monitors.length === 0) return;
    if (monitors.some((m) => String(m.id) === managedScreen)) return;
    const target = monitors.find((m) => m.is_primary) ?? monitors[0];
    useWidgetStore.getState().switchScreen(String(target.id));
    pushAppToast(tr("上次管理的显示器已断开，已切换回主屏"), "", "info");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitors, managedScreen]);
  /** 打开某显示器的管理页并切换小组件管理分区到该屏。 */
  const openMonitor = useCallback(
    (slot: number) => {
      useWidgetStore.getState().switchScreen(String(slot));
      navigate(`display-${slot}`);
    },
    [navigate]
  );
  /** DisplayPage「管理此屏小组件」：切管理分区并直达该屏第一个视图的管理页。
      此前与侧栏 openMonitor 同款跳 display-<slot>，而那渲染的还是显示器页
      本身——按钮按下页面几乎不变，用户感知「点了没反应」。 */
  const openMonitorManage = useCallback(
    (slot: number) => {
      useWidgetStore.getState().switchScreen(String(slot));
      // switchScreen 同步重载目标屏 views（localStorage 直读），这里取到的
      // 已是目标屏清单；一个视图都没有时退到小组件页（空态自解释）。
      const first = useWidgetStore.getState().views[0]?.id;
      navigate(first ? `view-${first}` : "widgets");
    },
    [navigate]
  );

  /* 搜索结果方向键：ArrowDown/Up 在结果间移动，Enter 打开选中（缺省第一条）。
     语言切换（tr 换引用 → 结果集重算）或词条表变化会让同一查询词命中不同
     结果集——一并重置，防 aria-activedescendant 指向已不存在的选项。 */
  const [resultIdx, setResultIdx] = useState(-1);
  useEffect(() => setResultIdx(-1), [deferredSearchQ, searchResults]);
  /* 结果下拉外点关闭（统一骨架）：有查询词时，按下侧栏其它区域清空收起——
     此前下拉只能靠导航 / 清空键关闭，会常驻在侧栏上。 */
  const searchWrapRef = useRef<HTMLDivElement | null>(null);
  useDismissable(
    searchQ.trim() !== "",
    searchWrapRef,
    () => {
      setSearchQ("");
      setResultIdx(-1);
    },
    { escape: false }
  );

  /* 侧栏共享指示条已被 M3 药丸激活态取代（激活项自带 accent 淡底）。 */

  /* 灵动岛折叠：磁贴子列表默认收起；页面落在灵动岛 / 磁贴配置 / 绑定实例配置时自动展开。
     「杂项」磁贴还有第三级（面板里的组件），按磁贴 id 各自记忆展开态。 */
  const dockTiles = useWidgetStore((s) => s.dock.tiles);
  const [dockOpen, setDockOpen] = useState(false);
  const [miscOpen, setMiscOpen] = useState<Record<string, boolean>>({});

  // 是否为独立设置窗口（URL hash 为 #/settings）
  const isSettingsWin = window.location.hash === "#/settings";

  /** 关闭设置：独立窗口下真关闭（销毁）——与「X = 关闭」的通用桌面心智
      一致，renderer 随之释放（省一份 WebView2 常驻内存）。此前是最小化，
      用户会疑惑窗口为何「关不掉」。冷启动重建的空影已由 ready 握手消除
      （main.tsx + windows.rs spawn_show_fallback），销毁不再有体验代价；
      Rust 侧 on_window_event 兜底：本窗为最后一个窗口时只隐藏保活。 */
  const handleClose = useCallback(() => {
    if (isSettingsWin) {
      /*外层 import 链补 catch（内层 close/minimize 已有）。 */
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => {
          getCurrentWindow().close().catch(console.error);
        })
        .catch(console.error);
    } else {
      setOpen(false);
    }
  }, [isSettingsWin, setOpen]);

  /** 独立窗口的最小化按钮（应用主界面自带的标准窗口控制）。 */
  const handleMinimize = useCallback(() => {
    if (!isSettingsWin) return;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        getCurrentWindow().minimize().catch(console.error);
      })
      .catch(console.error);
  }, [isSettingsWin]);

  // 进入某个小组件的配置页时，自动展开其所属视图的折叠（或灵动岛折叠），避免
  // 用户选完一个组件后折叠收起、无法直接切换下一个组件。杂项组件设置页
  // （dock-tile-item-<tileId>:<itemId>）还会展开对应「杂项」磁贴的第三级。
  // 编组设置页（group-config-<gid>）同理展开所属视图；成员配置页若挂在编组
  // 下，还要展开该编组节点的成员子列表。
  useEffect(() => {
    if (!page.startsWith("widget-config-") && !page.startsWith("dock-tile-item-") && !page.startsWith("group-config-"))
      return;
    if (page.startsWith("dock-tile-item-")) {
      const tileId = page.slice("dock-tile-item-".length).split(":")[0];
      if (tileId) setMiscOpen((prev) => ({ ...prev, [tileId]: true }));
      setDockOpen(true);
      return;
    }
    if (page.startsWith("group-config-")) {
      const gid = page.slice("group-config-".length);
      setExpandedGroups((prev) => ({ ...prev, [gid]: true }));
      const owner = views.find((v) => loadGroups(v.id).some((g) => g.id === gid));
      if (owner) setExpandedViews((prev) => ({ ...prev, [owner.id]: true }));
      return;
    }
    const wid = page.startsWith("widget-config-") ? page.slice("widget-config-".length) : null;
    if (wid && useWidgetStore.getState().dock.tiles.some((t) => t.instanceId === wid)) {
      setDockOpen(true);
      return;
    }
    const owner = views.find((v) => loadInstances(v.id).some((i) => i.id === wid));
    if (owner) setExpandedViews((prev) => ({ ...prev, [owner.id]: true }));
    // 成员在编组下：展开该编组节点。
    for (const v of views) {
      const g = loadGroups(v.id).find((x) => wid && x.memberIds.includes(wid));
      if (g) {
        setExpandedGroups((prev) => ({ ...prev, [g.id]: true }));
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    if (open) document.body.classList.add("settings-open");
    else document.body.classList.remove("settings-open");
    return () => document.body.classList.remove("settings-open");
  }, [open]);

  /* Ctrl+K / Cmd+K（可配置的应用内快捷键「聚焦设置搜索」）：聚焦设置搜索框；
     Escape：清空并失焦。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const entry = useSettingsStore.getState().appShortcuts["settings-search"];
      if (entry.enabled && appAccelMatches(entry.accel, e)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setSearchQ("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // When the panel opens, honor any requested target page (e.g. a widget's
  // "配置" button) by navigating straight to that sub-page.
  // open 作失效信号——targetPage/navigate 取渲染闭包最新快照即可
  //（navigate 是 zustand 稳定引用；targetPage 需要的恰是「打开那一刻」的值）。
  useInvalidationSignal([open], () => {
    if (open && targetPage && targetPage !== "style") navigate(targetPage as Page);
  });

  // 独立窗口：桌面小组件 hover 的"设置"快捷按钮会呼出本窗口并要求直接
  // 跳到该组件的配置页（另一个 WebView 的导航只能通过事件传递）。
  // 载荷带来源 screenId：外接屏的组件不在默认 screen-0 分区里，必须先
  // 切换管理分区再导航，否则配置页找不到实例弹回空列表。
  useEffect(() => {
    if (!isSettingsWin || !isTauri()) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ page: string; screenId?: string; title?: string }>("app:navigate-settings", (e) => {
          const p = e.payload;
          if (!p?.page) return;
          if (p.screenId && p.screenId !== useWidgetStore.getState().screenId) {
            useWidgetStore.getState().switchScreen(p.screenId);
          }
          // 命令面板的设置词条带行标题：写入 pending 供落地后的行级定位。
          requestSettingsJump(p.page, p.title);
          navigate(p.page as never);
          // 发起方同时写了 localStorage 兜底键（首启事件可能丢失）。事件已送达
          // 即意图已兑现，必须清掉；否则下面的焦点兜底看到"页面相同"不清键，
          // 用户随后切到别的页、alt-tab 回来又被拽回这一页。
          try {
            localStorage.removeItem("focus-desk.pending-nav");
          } catch {
            // best-effort
          }
        })
      )
      .then((f) => {
        if (disposed) f();
        else un = f;
      })
      /* 动态 import / listen 链补 catch——注册失败
         （IPC 抖动）时不再产生 unhandledrejection，上报供诊断（导航兜底仍由
         localStorage pending-nav 路径覆盖）。 */
      .catch((err: unknown) => console.error("[settings] navigate-settings listen failed", err));
    return () => {
      disposed = true;
      un?.();
    };
    // setPage 是 zustand store 的稳定引用，仅需在窗口身份变化时重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsWin]);

  // 兜底：首次启动时设置窗口 WebView 尚未就绪，导航事件可能丢失。
  // 两窗口同源共享 localStorage，挂载时与每次获得焦点时读取待导航页面。
  // 值为 JSON（{ page, screenId }）或旧版纯页面字符串。
  useEffect(() => {
    if (!isSettingsWin) return;
    let disposed = false;
    const readPending = () => {
      try {
        const pending = localStorage.getItem("focus-desk.pending-nav");
        if (!pending) return;
        let page = pending;
        let screenId: string | undefined;
        if (pending.startsWith("{")) {
          try {
            const obj = JSON.parse(pending) as { page?: string; screenId?: string };
            if (obj?.page) {
              page = obj.page;
              screenId = obj.screenId;
            }
          } catch {
            // 非法 JSON：按旧版纯字符串页面 id 处理
          }
        }
        if (page && page !== pageRef.current) {
          if (screenId && screenId !== useWidgetStore.getState().screenId) {
            useWidgetStore.getState().switchScreen(screenId);
          }
          navigate(page as Page);
        }
        // 无论是否真的跳转，待导航意图都已消费（页面相同 = 已在目标页）。
        localStorage.removeItem("focus-desk.pending-nav");
      } catch {
        // best-effort
      }
    };
    readPending();
    let unFocus: (() => void) | undefined;
    if (isTauri()) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onFocusChanged(({ payload }) => {
            if (payload) readPending();
          })
        )
        .then((f) => {
          if (disposed) f();
          else unFocus = f;
        })
        /* onFocusChanged 注册链补 catch（同上，防
           unhandledrejection；失败只损失焦点兜底，导航事件主路径不受影响）。 */
        .catch((err: unknown) => console.error("[settings] focus listener registration failed", err));
    }
    return () => {
      disposed = true;
      unFocus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsWin]);

  // 主窗口中：设置面板未打开时不渲染。独立设置窗口中始终渲染。
  // 关闭对称退场：open→false 后保留 220ms 播遮罩/窗口退出动画再卸载。
  const overlayMounted = useDelayedUnmount(isSettingsWin || open, animDurations().fxMs);
  if (!overlayMounted) return null;
  const overlayClosing = !isSettingsWin && !open;

  const handleAddView = async () => {
    /* 与视图页同一命名入口（长度上限 + 码点截断）；撞名不拦截——
       store 的 addView 自动加序号。 */
    const name = await promptViewName(tr, { title: tr("输入新视图名称") });
    if (!name) return;
    const id = addView(name);
    if (id) navigate(`view-${id}`);
  };

  const enterEditMode = () => {
    setEditMode(true);
    handleClose();
  };

  return (
    <div
      className={`tm-settings-overlay${overlayClosing ? " is-closing" : ""}`}
      onClick={() => !isSettingsWin && handleClose()}
    >
      {/* 设置窗口即应用本体：独立窗口下无遮罩、无内框，整页就是应用主界面。 */}
      <div
        className={`tm-settings-window${overlayClosing ? " is-closing" : ""}`}
        data-theme={darkTheme ? "glass" : "light"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tm-titlebar" data-tauri-drag-region>
          <div className="tm-titlebar-title" data-tauri-drag-region>
            <FxText text="Vela" mode="pullup" />
          </div>
          {isSettingsWin ? (
            <div className="tm-titlebar-controls">
              <button className="tm-titlebar-btn" onClick={handleMinimize} aria-label={tr("最小化")}>
                <Minus size={14} />
              </button>
              <button className="tm-titlebar-btn tm-titlebar-close" onClick={handleClose} aria-label={tr("关闭")}>
                <X size={15} />
              </button>
            </div>
          ) : (
            <button className="tm-titlebar-btn tm-titlebar-close" onClick={handleClose} aria-label={tr("关闭")}>
              <X size={15} />
            </button>
          )}
        </div>
        <div className="tm-settings-body">
          <aside className="tm-sidebar">
            {/* 设置搜索：按关键词定位设置项，Ctrl+K 快速聚焦。 */}
            <div className="tm-sidebar-search" ref={searchWrapRef}>
              <Search size={14} />
              <input
                ref={searchRef}
                className="tm-sidebar-search-input"
                value={searchQ}
                placeholder={tr("搜索设置…")}
                aria-label={tr("搜索设置")}
                role="combobox"
                aria-expanded={searchQ.trim() !== ""}
                aria-controls="tm-settings-search-list"
                aria-activedescendant={resultIdx >= 0 ? `tm-search-opt-${resultIdx}` : undefined}
                aria-autocomplete="list"
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && searchResults.length > 0) {
                    e.preventDefault();
                    setResultIdx((i) => Math.min(searchResults.length - 1, i + 1));
                  } else if (e.key === "ArrowUp" && searchResults.length > 0) {
                    e.preventDefault();
                    setResultIdx((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter" && searchResults.length > 0) {
                    const pick = searchResults[resultIdx >= 0 ? Math.min(resultIdx, searchResults.length - 1) : 0];
                    navigate(pick.page);
                    setSearchQ("");
                  }
                }}
                spellCheck={false}
              />
              {/* kbd ↔ 清空常驻挂载交叉淡化（不瞬换，也不挤动布局）。 */}
              <kbd
                className={`tm-sidebar-search-kbd${searchQ || !searchKbd ? " is-hidden" : ""}`}
                aria-hidden={!!searchQ || !searchKbd}
              >
                {searchKbd}
              </kbd>
              <button
                type="button"
                className={`tm-sidebar-search-clear${searchQ ? "" : " is-hidden"}`}
                tabIndex={searchQ ? 0 : -1}
                onClick={() => setSearchQ("")}
                aria-label={tr("清空")}
                aria-hidden={!searchQ}
              >
                <X size={12} />
              </button>
              {/* 结果下拉常驻挂载 + is-open 过渡（fd-tip 范式）：出入场都平滑，免去卸载时序。 */}
              <div
                id="tm-settings-search-list"
                role="listbox"
                aria-label={tr("搜索设置")}
                className={`tm-sidebar-search-results${searchResults.length > 0 || (searchQ.trim() !== "" && searchResults.length === 0) ? " is-open" : ""}`}
                aria-hidden={searchResults.length === 0 && searchQ.trim() === ""}
              >
                {searchQ.trim() !== "" && searchResults.length === 0 ? (
                  <div className="tm-sidebar-search-empty">{tr("没有匹配的设置")}</div>
                ) : (
                  searchResults.map((r, ri) => (
                    <button
                      key={`${r.page}:${r.title}`}
                      role="option"
                      id={`tm-search-opt-${ri}`}
                      aria-selected={ri === resultIdx}
                      className={`tm-sidebar-search-item${ri === resultIdx ? " kb-focus" : ""}`}
                      onMouseEnter={() => setResultIdx(ri)}
                      onClick={() => {
                        // 行级定位：词条标题随跳转携带（同页时经同窗事件
                        // 即时脉冲，跨页时等页面落地后由 effect 消费）。
                        requestSettingsJump(r.page, r.title);
                        navigate(r.page);
                        setSearchQ("");
                      }}
                    >
                      <Search size={12} />
                      <span className="tm-sidebar-search-title">{tr(r.title)}</span>
                      <span className="tm-sidebar-search-group">{tr(r.group)}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
            {/* ═══ 应用设置 ═══ */}
            <div className="tm-sidebar-section">
              <div className="tm-sidebar-label">{tr("应用设置")}</div>
              <SidebarSlideBar page={page} />
              {NAV_ITEMS.map((item) => {
                if (item.id !== "dock") {
                  const Icon = item.icon;
                  const active = page === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`tm-sidebar-item${active ? " active" : ""}`}
                      style={hueChipStyle(item.hue)}
                      onClick={() => navigate(item.id)}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="tm-nav-ic" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <span className="tm-sidebar-item-title">{tr(item.name)}</span>
                    </button>
                  );
                }
                /* 灵动岛折叠行：子列表 = 岛上磁贴，点击直达磁贴 / 实例配置页（类似视图）。 */
                const active = page === "dock" || page.startsWith("dock-tile-");
                const expanded = dockOpen || active;
                return (
                  <div key={item.id} className="tm-sidebar-view">
                    {/* 外层用 div[role=button]：行内还嵌着「展开/收起」真按钮，
                        button 套 button 是非法 HTML（validateDOMNesting 报错、a11y 树降级）。 */}
                    <div
                      role="button"
                      tabIndex={0}
                      className={`tm-sidebar-item${active ? " active" : ""}`}
                      style={hueChipStyle(item.hue)}
                      onClick={() => {
                        navigate("dock");
                        setDockOpen(true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate("dock");
                          setDockOpen(true);
                        }
                      }}
                      aria-current={page === "dock" ? "page" : undefined}
                    >
                      <span className="tm-nav-ic" aria-hidden="true">
                        <item.icon size={16} />
                      </span>
                      <span className="tm-sidebar-item-title">{tr(item.name)}</span>
                      <span className="tm-sidebar-count">{dockTiles.length}</span>
                      <button
                        type="button"
                        className="tm-sidebar-chevron-btn"
                        aria-expanded={expanded}
                        aria-label={expanded ? tr("收起") : tr("展开")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDockOpen((v) => !v);
                        }}
                      >
                        <ChevronDown size={14} className={`tm-sidebar-chevron${expanded ? " open" : ""}`} />
                      </button>
                    </div>
                    <div
                      className={`tm-sidebar-sub-wrap${expanded ? " open" : ""}`}
                      aria-hidden={!expanded}
                      inert={!expanded}
                    >
                      <div className="tm-sidebar-sub">
                        {dockTiles.length === 0 && <div className="tm-sidebar-sub-empty">{tr("未添加磁贴")}</div>}
                        {dockTiles.map((tile) => {
                          const meta = getWidgetMeta(tile.type);
                          const Icon = meta?.icon ?? LayoutGrid;
                          /* 「杂项」磁贴 = 下级目录：下一级是面板里的组件，组件的设置页
                             再下一级（dock-tile-item-<tileId>:<itemId>），与视图折叠同级交互。 */
                          if (tile.type === MISC_TYPE) {
                            const items = sanitizeMiscItems(tile.config?.items);
                            const target = `dock-tile-${tile.id}`;
                            const tileActive = page === target;
                            const subActive = page.startsWith(`dock-tile-item-${tile.id}:`);
                            const tileExpanded = miscOpen[tile.id] || tileActive || subActive;
                            return (
                              <div key={tile.id} className="tm-sidebar-view">
                                <div
                                  role="button"
                                  tabIndex={0}
                                  className={`tm-sidebar-sub-item${tileActive || subActive ? " active" : ""}`}
                                  onClick={() => {
                                    navigate(target);
                                    setMiscOpen((prev) => ({ ...prev, [tile.id]: true }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      navigate(target);
                                      setMiscOpen((prev) => ({ ...prev, [tile.id]: true }));
                                    }
                                  }}
                                  aria-current={tileActive ? "page" : undefined}
                                >
                                  <Icon size={14} />
                                  {meta ? tr(meta.name) : tile.type}
                                  <span className="tm-sidebar-count">{items.length}</span>
                                  <button
                                    type="button"
                                    className="tm-sidebar-chevron-btn"
                                    aria-expanded={tileExpanded}
                                    aria-label={tileExpanded ? tr("收起") : tr("展开")}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMiscOpen((prev) => ({ ...prev, [tile.id]: !tileExpanded }));
                                    }}
                                  >
                                    <ChevronDown
                                      size={14}
                                      className={`tm-sidebar-chevron${tileExpanded ? " open" : ""}`}
                                    />
                                  </button>
                                </div>
                                <div
                                  className={`tm-sidebar-sub-wrap${tileExpanded ? " open" : ""}`}
                                  aria-hidden={!tileExpanded}
                                  inert={!tileExpanded}
                                >
                                  <div className="tm-sidebar-sub tm-sidebar-sub2">
                                    {items.length === 0 && (
                                      <div className="tm-sidebar-sub-empty">{tr("面板里还没有组件")}</div>
                                    )}
                                    {items.map((item) => {
                                      const itemMeta = getWidgetMeta(item.type);
                                      const ItemIcon = itemMeta?.icon ?? LayoutGrid;
                                      const itemPage = `dock-tile-item-${tile.id}:${item.id}`;
                                      return (
                                        <button
                                          key={item.id}
                                          type="button"
                                          className={`tm-sidebar-sub-item${page === itemPage ? " active" : ""}`}
                                          onClick={() => navigate(itemPage)}
                                        >
                                          <ItemIcon size={14} />
                                          {itemMeta ? tr(itemMeta.name) : item.type}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            );
                          }
                          // 磁贴设置页统一是 dock-tile-<id>：完整组件设置 + 灵动岛磁贴区
                          //（绑定实例时页面内部读写实例配置，含透明度 / 穿透）。
                          const target = `dock-tile-${tile.id}`;
                          return (
                            <button
                              key={tile.id}
                              type="button"
                              className={`tm-sidebar-sub-item${page === target ? " active" : ""}`}
                              onClick={() => navigate(target)}
                            >
                              <Icon size={14} />
                              {meta ? tr(meta.name) : tile.type}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="tm-sidebar-sep" role="presentation" />

            {/* ═══ 显示器（动态分组）═══ */}
            <div className="tm-sidebar-section">
              <div className="tm-sidebar-label">{tr("显示器")}</div>
              <SidebarSlideBar page={page} />
              {monitors.map((m) => {
                const active = page === `display-${m.id}`;
                const managed = managedScreen === String(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`tm-sidebar-item${active ? " active" : ""}`}
                    style={hueChipStyle(MONITOR_HUE)}
                    onClick={() => openMonitor(m.id)}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="tm-nav-ic" aria-hidden="true">
                      <Monitor size={16} />
                    </span>
                    <span className="tm-sidebar-item-title">
                      {m.name}
                      {m.is_primary ? tr("（主显示器）") : ""}
                    </span>
                    {/* 装饰点此前 aria-hidden——读屏对「正在管理此屏」完全
                        无感；role=img + aria-label 承载 title 信息。 */}
                    {managed && (
                      <span
                        className="tm-sidebar-managed-dot"
                        title={tr("正在管理此屏的小组件")}
                        role="img"
                        aria-label={tr("正在管理此屏的小组件")}
                      />
                    )}
                  </button>
                );
              })}
              {/* 枚举失败的可见反馈 + 重试入口（风格随侧栏空态行与 accent
                  文字按钮，令牌全走 CSS 变量）。 */}
              {monitorsFailed && (
                <div
                  className="tm-sidebar-sub-empty"
                  style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 46 }}
                >
                  <span>{tr("显示器列表获取失败")}</span>
                  <button
                    type="button"
                    onClick={reloadMonitors}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      color: "var(--accent)",
                      font: "inherit",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer"
                    }}
                  >
                    <RefreshCw size={12} />
                    {tr("重试")}
                  </button>
                </div>
              )}
              {monitors.length === 0 && (
                <button
                  type="button"
                  className={`tm-sidebar-item${page === "display" ? " active" : ""}`}
                  style={{ "--h": MONITOR_HUE } as CSSProperties}
                  onClick={() => navigate("display")}
                >
                  <span className="tm-nav-ic" aria-hidden="true">
                    <Monitor size={16} />
                  </span>
                  <span className="tm-sidebar-item-title">{tr("显示器")}</span>
                </button>
              )}
            </div>

            <div className="tm-sidebar-sep" role="presentation" />

            {/* ═══ 视图 ═══ */}
            <div className="tm-sidebar-section">
              <div className="tm-sidebar-label">{tr("视图")}</div>
              <SidebarSlideBar page={page} />
              {views.map((v) => {
                const expanded = expandedViews[v.id] ?? page === `view-${v.id}`;
                const viewWidgetCount = viewWidgetCounts[v.id] ?? 0;
                return (
                  <div key={v.id} className="tm-sidebar-view">
                    <div
                      role="button"
                      tabIndex={0}
                      className={`tm-sidebar-item${page === `view-${v.id}` ? " active" : ""}`}
                      style={hueChipStyle(VIEW_HUE)}
                      onClick={() => {
                        navigate(`view-${v.id}`);
                        setExpandedViews((prev) => ({ ...prev, [v.id]: true }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`view-${v.id}`);
                          setExpandedViews((prev) => ({ ...prev, [v.id]: true }));
                        }
                      }}
                      aria-current={page === `view-${v.id}` ? "page" : undefined}
                    >
                      <span className="tm-nav-ic" aria-hidden="true">
                        <LayoutGrid size={16} />
                      </span>
                      <span className="tm-sidebar-item-title">{v.name}</span>
                      <span className="tm-sidebar-count">{viewWidgetCount}</span>
                      <button
                        type="button"
                        className="tm-sidebar-chevron-btn"
                        aria-expanded={expanded}
                        aria-label={expanded ? tr("收起") : tr("展开")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedViews((prev) => ({ ...prev, [v.id]: !expanded }));
                        }}
                      >
                        <ChevronDown size={14} className={`tm-sidebar-chevron${expanded ? " open" : ""}`} />
                      </button>
                    </div>
                    {/* 折叠子列表：常驻挂载 + grid-rows 展开/收拢过渡，收起不再瞬间消失。
                        inert：收起时子树整体移出焦点序列与交互——CSS 的
                        pointer-events:none 挡不住键盘 Tab，且 aria-hidden 包可聚焦
                        元素本身违规（焦点会"消失"在隐形按钮上）。 */}
                    <div
                      className={`tm-sidebar-sub-wrap${expanded ? " open" : ""}`}
                      aria-hidden={!expanded}
                      inert={!expanded}
                    >
                      <div className="tm-sidebar-sub">
                        {(() => {
                          const instances = viewWidgetIds[v.id] ?? [];
                          const groups = viewGroups[v.id] ?? [];
                          if (instances.length === 0 && groups.length === 0) {
                            return <div className="tm-sidebar-sub-empty">{tr("无小组件")}</div>;
                          }
                          const memberButton = (inst: WidgetInstance) => {
                            const meta = getWidgetMeta(inst.type);
                            const Icon = meta?.icon ?? LayoutGrid;
                            return (
                              <button
                                key={inst.id}
                                type="button"
                                className="tm-sidebar-sub-item"
                                onClick={() => {
                                  if (activeView !== v.id) setActiveView(v.id);
                                  setExpandedViews((prev) => ({ ...prev, [v.id]: true }));
                                  navigate(`widget-config-${inst.id}`);
                                }}
                              >
                                <Icon size={14} />
                                {widgetDisplayName(inst.type, inst.id, instances, tr)}
                              </button>
                            );
                          };
                          /* 编组作为中间节点（视图 → 编组 → 成员）：行点击进编组
                             设置页（组级透明度/成员管理），箭头展开成员子列表。 */
                          const groupNode = (g: (typeof groups)[number]) => {
                            const members = g.memberIds
                              .map((id) => instances.find((i) => i.id === id))
                              .filter((i): i is WidgetInstance => !!i);
                            const gOpen = expandedGroups[g.id] ?? page === `group-config-${g.id}`;
                            return (
                              <div key={g.id} className="tm-sidebar-sub-group">
                                <div
                                  role="button"
                                  tabIndex={0}
                                  className={`tm-sidebar-sub-item tm-sidebar-sub-group-row${page === `group-config-${g.id}` ? " active" : ""}`}
                                  onClick={() => {
                                    if (activeView !== v.id) setActiveView(v.id);
                                    setExpandedViews((prev) => ({ ...prev, [v.id]: true }));
                                    navigate(`group-config-${g.id}`);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      if (activeView !== v.id) setActiveView(v.id);
                                      navigate(`group-config-${g.id}`);
                                    }
                                  }}
                                >
                                  <Layers size={14} />
                                  <span className="tm-sidebar-sub-group-name">
                                    {/* 组名（未命名回落「编组」）——两个以上编组
                                        靠「编组 · N」无法区分。 */}
                                    {g.name?.trim() || tr("编组")} · {members.length}
                                  </span>
                                  <button
                                    type="button"
                                    className="tm-sidebar-chevron-btn"
                                    aria-expanded={gOpen}
                                    aria-label={gOpen ? tr("收起") : tr("展开")}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedGroups((prev) => ({ ...prev, [g.id]: !gOpen }));
                                    }}
                                  >
                                    <ChevronDown size={12} className={`tm-sidebar-chevron${gOpen ? " open" : ""}`} />
                                  </button>
                                </div>
                                <div
                                  className={`tm-sidebar-sub-wrap${gOpen ? " open" : ""}`}
                                  aria-hidden={!gOpen}
                                  inert={!gOpen}
                                >
                                  <div className="tm-sidebar-sub">
                                    {members.map((m) => {
                                      const meta = getWidgetMeta(m.type);
                                      const Icon = meta?.icon ?? LayoutGrid;
                                      return (
                                        <button
                                          key={m.id}
                                          type="button"
                                          className={`tm-sidebar-sub-item${page === `widget-config-${m.id}` ? " active" : ""}`}
                                          onClick={() => {
                                            if (activeView !== v.id) setActiveView(v.id);
                                            setExpandedViews((prev) => ({ ...prev, [v.id]: true }));
                                            setExpandedGroups((prev) => ({ ...prev, [g.id]: true }));
                                            navigate(`widget-config-${m.id}`);
                                          }}
                                        >
                                          <Icon size={14} />
                                          {widgetDisplayName(m.type, m.id, instances, tr)}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            );
                          };
                          /* 顺序：按实例 z 序穿插输出——编组节点在该组成员首次
                             出现的位置输出（与桌面视觉顺序一致），其余成员归入
                             编组子列表不再平铺。布局存储序 ≠ z 序，先按 z 排序。 */
                          const emitted = new Set<string>();
                          const nodes: React.ReactNode[] = [];
                          const byZ = [...instances].sort((a, b) => a.z - b.z);
                          for (const inst of byZ) {
                            const owner = groups.find((g) => g.memberIds.includes(inst.id));
                            if (!owner) {
                              nodes.push(memberButton(inst));
                              continue;
                            }
                            if (!emitted.has(owner.id)) {
                              emitted.add(owner.id);
                              nodes.push(groupNode(owner));
                            }
                          }
                          return nodes;
                        })()}
                      </div>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="tm-sidebar-item"
                style={hueChipStyle("var(--accent)")}
                onClick={handleAddView}
              >
                <span className="tm-nav-ic" aria-hidden="true">
                  <Plus size={16} />
                </span>
                <span className="tm-sidebar-item-title">{tr("添加视图")}</span>
              </button>
            </div>

            <div className="tm-sidebar-sep" role="presentation" />

            {/* ═══ 小组件 ═══ */}
            <div className="tm-sidebar-section">
              <div className="tm-sidebar-label">{tr("小组件")}</div>
              <SidebarSlideBar page={page} />
              <button
                type="button"
                className="tm-sidebar-item"
                style={hueChipStyle("var(--accent)")}
                onClick={() => navigate("gallery")}
              >
                <span className="tm-nav-ic" aria-hidden="true">
                  <Plus size={16} />
                </span>
                <span className="tm-sidebar-item-title">{tr("添加小组件")}</span>
                {/* 侧栏计数与图库页「全部」同口径：排除 dockOnly 与 hidden（内部类型）。 */}
                <span className="tm-sidebar-count">
                  {WIDGET_REGISTRY.filter((w) => !w.dockOnly && !w.hidden).length}
                </span>
              </button>
              <button type="button" className="tm-sidebar-item" style={hueChipStyle(EDIT_HUE)} onClick={enterEditMode}>
                <span className="tm-nav-ic" aria-hidden="true">
                  <Pencil size={16} />
                </span>
                <span className="tm-sidebar-item-title">{tr("编辑小组件")}</span>
              </button>
            </div>
          </aside>
          <main className="tm-content" key={page}>
            {/* 懒加载页首次进入时按需拉 chunk；fallback 给轻量骨架
                （null 在冷启动首拉的一拍里整块闪空，见 LazyPageFallback）。 */}
            <Suspense fallback={<LazyPageFallback />}>
              {page === "style" && <StylePage.Component />}
              {page === "general" && <GeneralPage.Component />}
              {page === "animation" && <AnimationPage.Component />}
              {page === "connection" && <ConnectionPage.Component />}
              {page === "dock" && <DockPage.Component />}
              {page === "taskbar" && <TaskbarPage.Component monitors={monitors} />}
              {page === "license" && <LicensePage />}
              {page === "update" && <UpdatePage.Component />}
              {(page === "display" || page.startsWith("display-")) && (
                <DisplayPage.Component onManage={openMonitorManage} monitors={monitors} onRefresh={reloadMonitors} />
              )}
              {page === "widgets" && <WidgetsPage.Component onNavigate={navigate} monitors={monitors} />}
              {page === "gallery" && <WidgetGalleryPage.Component onBack={() => navigate("widgets")} />}
              {page.startsWith("view-") && (
                <ViewPage.Component view={page.slice("view-".length)} onNavigate={navigate} monitors={monitors} />
              )}
              {page.startsWith("widget-config-") && (
                <WidgetConfigPage.Component instanceId={page.slice("widget-config-".length)} onNavigate={navigate} />
              )}
              {page.startsWith("group-config-") && (
                <GroupConfigPage.Component groupId={page.slice("group-config-".length)} onNavigate={navigate} />
              )}
              {page.startsWith("dock-tile-item-") && (
                <MiscItemConfigPage.Component pageId={page} onNavigate={navigate} />
              )}
              {page.startsWith("dock-tile-") && !page.startsWith("dock-tile-item-") && (
                <DockTileConfigPage.Component tileId={page.slice("dock-tile-".length)} onNavigate={navigate} />
              )}
            </Suspense>
          </main>
        </div>
      </div>
      {/* 首次启动引导：extra.onboarded 未置位时覆盖在设置窗内容之上（自管
          挂卸与退场，见 OnboardingOverlay）。 */}
      <OnboardingOverlay />
    </div>
  );
}

function LicensePage() {
  const tr = useT();
  // 粒子文字（含旧版环形文字装饰）受「特效管理」particleText 开关控制；
  // 关闭时不挂 canvas，省掉 rAF 粒子循环。
  const particleFx = useFxEffectEnabled("particleText");
  return (
    <section className="tm-section">
      <div className="tm-section-title">{tr("许可证")}</div>
      {/* Particle Text（）：粒子聚合成 "Vela"；
          取代原先的转圈环形文字，左下角的品牌小字也随之移除。 */}
      {particleFx && <ParticleText text="Vela" className="tm-license-particles" height={150} />}
      {/* 四行信息错落淡入（--sti 递增 40ms），与其它列表的 rb-row-in 语言一致 */}
      <div className="tm-license-item" style={{ "--sti": 0 } as CSSProperties}>
        <span>{tr("版本")}</span>
        {/* 此前硬编码 0.1.0，发版即撒谎——改用 package.json 注入的版本。 */}
        <b>{APP_VERSION}</b>
      </div>
      <div className="tm-license-item" style={{ "--sti": 1 } as CSSProperties}>
        <span>{tr("作者")}</span>
        <b>浩浩浩</b>
      </div>
      <div className="tm-license-item" style={{ "--sti": 2 } as CSSProperties}>
        <span>{tr("许可证")}</span>
        <b>{tr("MIT 开源许可")}</b>
      </div>
      <div className="tm-license-item" style={{ "--sti": 3 } as CSSProperties}>
        <span>{tr("构建")}</span>
        <b>{tr("社区版")}</b>
      </div>
      <div className="tm-note">
        {tr("本应用为本地桌面小组件应用，用于学习和个人使用。所有小组件与数据均保存在本地。")}
      </div>
      {(donateWechat || donateAlipay) && (
        <>
          <div className="tm-section-title" style={{ marginTop: 22 }}>
            {tr("请作者喝杯奶茶")}
          </div>
          <p className="tm-donate-note">{tr("如果这款小组件陪你度过了高效的时光，可以请作者喝杯奶茶～")}</p>
          <div className="tm-donate-cards">
            {donateWechat && (
              <figure className="tm-donate-card">
                <img src={donateWechat} alt={tr("微信收款码")} loading="lazy" />
                <figcaption>{tr("微信")}</figcaption>
              </figure>
            )}
            {donateAlipay && (
              <figure className="tm-donate-card">
                <img src={donateAlipay} alt={tr("支付宝收款码")} loading="lazy" />
                <figcaption>{tr("支付宝")}</figcaption>
              </figure>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// Local page state. Initializes from the store's requested page (e.g. when a
// widget's toolbar asks to open its own config), otherwise defaults to "style".
function usePageState(): [Page, (p: Page) => void] {
  const target = useSettingsStore((s) => s.settingsPage);
  const [page, setPage] = useState<Page>(() => (target && target !== "style" ? (target as Page) : "style"));
  return [page, setPage];
}
