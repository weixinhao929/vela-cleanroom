/**
 * 应用根组件（按窗口类型分派渲染，组合根模式）。
 *
 * F7（组合根瘦身）：全局副作用 handler（专注/presence/通知/设置桥）按域
 * 拆到 ./handlers/*，窗口类型判定收敛到 ./window-kind；本文件只保留
 * 懒加载视图声明 + 窗口分派表，任何窗口形态读一遍分派即知全貌。
 *
 * 三种主要形态：速记窗（QuickNoteView）/ 设置窗（SettingsView + 全局面板）/
 * 桌面小组件层（WidgetCanvas + 番茄钟全局心跳）。挂载托盘事件与跨窗口
 * 同步；多显示器下仅主窗口（widget-0）驱动 tick/通知（D-1），其余只读。
 */
import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { SettingsSync } from "./SettingsSync";
import { FloatingThemeSync } from "./FloatingThemeSync";
import { useTrayEvents } from "../lib/tray-events";
import { useCrossWindowSync } from "../lib/cross-window";
import { WidgetCanvas } from "../widget/WidgetCanvas";
import { PromptDialogHost } from "../components/PromptDialog";
import { ContextMenuHost } from "../components/ContextMenu";
import { ShortcutCheatsheetHost } from "../components/ShortcutCheatsheet";
import { ToastHost } from "../components/ToastHost";
import { ThemeTooltipHost } from "../components/ThemeTooltip";
import { FxController } from "../lib/fx";
import { useWallpaperTheme } from "../lib/use-wallpaper-theme";
import { isPrimaryWidgetWindow } from "../lib/tauri";
import {
  useMediaPrefsSync,
  useDesktopDoubleClickSync,
  WidgetHydrate,
  ShortcutConfigSync
} from "./handlers/settings-sync";
import { PrimarySchedulers } from "./handlers/schedulers";
import { GlobalIdleDim, GlobalIdleGlass, GlobalIdleDecor } from "./handlers/presence";
import {
  GlobalPomodoroTicker,
  StandbyPomodoroTicker,
  GlobalGamePause,
  GlobalIdlePause,
  GlobalActivityGate,
  PomodoroAutomationHost,
  FocusTickPlayer,
  AmbienceMediaGuard
} from "./handlers/focus";
import {
  PomodoroNotifier,
  SystemFeedbackListeners,
  OsNotifyActivationHandler,
  PinOnSnipHandler
} from "./handlers/notify";
import { resolveWindowKind } from "./window-kind";

/* C1（bundle）：SettingsView 及其 pages 全家（约 116KB 源码）此前被静态
   导入——常驻的桌面小组件层窗口永远走不到该分支，却要下载并执行整个模块。
   改为按窗口类型懒加载：桌面层首屏不再包含设置窗代码。 */
const SettingsView = lazy(() => import("../features/settings/SettingsView").then((m) => ({ default: m.SettingsView })));
/* 命令面板懒壳：模块（含 command-palette.css）自包含、无外部打开方——设置 /
   速记 / 截图等窗口不再背负其代码与样式，桌面层首帧后按需拉取（Ctrl+K 热键
   监听随 chunk 挂载，首帧后毫秒级就绪）。 */
const CommandPaletteHost = lazy(() =>
  import("../components/CommandPalette").then((m) => ({ default: m.CommandPaletteHost }))
);
const QuickNoteView = lazy(() => import("../widget/QuickNoteView").then((m) => ({ default: m.QuickNoteView })));
/* [SNIP] 截图覆盖窗（借鉴 ClassSoftwareHub #4）：冻结帧框选 + 标注 + 钉图。 */
const SnipView = lazy(() => import("../features/snip/SnipView").then((m) => ({ default: m.SnipView })));
/* [SUPER-PANEL]（ZTools 借鉴 #11）长按右键取词操作面板（独立小窗）。 */
const SuperPanelView = lazy(() =>
  import("../features/super-panel/SuperPanelView").then((m) => ({ default: m.SuperPanelView }))
);
/* [FULLSCREEN] 全屏展示窗（借鉴 ClassSoftwareHub #5）：投影用时钟/倒计时/番茄钟。 */
const FullscreenView = lazy(() =>
  import("../features/fullscreen/FullscreenView").then((m) => ({ default: m.FullscreenView }))
);
/* [TB-UI] 任务栏配置对账组件与设置页同 chunk：仅设置窗挂载，桌面层首屏不含任务栏设置代码。 */
const TaskbarConfigSync = lazy(() =>
  import("../features/settings/pages/TaskbarPage").then((m) => ({ default: m.TaskbarConfigSync }))
);
/* W-171 / P2-8 任务栏网速条视图：由 taskbar-net.html 精简入口挂载（Rust 侧
   按开关创建该窗口）；main.tsx 把 index.html#taskbar-net 旧路径重定向过去，
   本文件不再保留第二棵渲染树（F8）。 */

/**
 * 应用根组件（组合根）。按 resolveWindowKind() 分派渲染；全局副作用按域
 * 挂载在 ./handlers/ 下。除桌面层默认分支外，每个窗口形态只挂「主题同步 +
 * 视图本体」（+ 各自分内职责），不带桌面层全局 handler。
 *
 * @returns 当前窗口对应的界面树。
 */
export function App() {
  useTrayEvents();
  // 设置窗口与桌面小组件层是两个独立 WebView：这里双向同步设置项、
  // 小组件布局与小组件配置，保证"设置改了桌面立即生效"。
  useCrossWindowSync();
  // §4.4 壁纸派生 token：每个窗口独立拉取 + 监听 wallpaper:changed（速记窗也要跟随）。
  useWallpaperTheme();
  // W-131 媒体监控行为偏好 → Rust watcher 单向推送（幂等，多窗并发无副作用）。
  useMediaPrefsSync();
  // DeskOrder 借鉴 #6：双击空白桌面手势开关 → Rust 鼠标钩子。
  useDesktopDoubleClickSync();
  // F7：窗口类型单点解析（原 6 个 isXxxWindow 谓词收敛于此）。
  const kind = resolveWindowKind();
  const isSettings = kind === "settings";
  const isQuickNote = kind === "quick-note";
  const isSnip = kind === "snip";
  const isSuperPanel = kind === "super-panel";
  const isFullscreen = kind === "fullscreen";
  // D-1：多显示器下仅主窗口（widget-0）驱动番茄钟 tick/通知与游戏暂停，
  // 其余 widget-* 窗口只读展示，避免同一段专注双写、通知 ×N。
  const primary = isPrimaryWidgetWindow();

  // 根据窗口类型控制背景：小组件层透明（露出桌面），设置窗口也透明
  // （html + body，露出桌面的份额由「设置窗口不透明度」的 color-mix 控制）。
  useEffect(() => {
    document.body.classList.toggle("tm-widget-layer", kind === "widget" || kind === "taskbar-net");
    document.body.classList.toggle("tm-settings-layer", isSettings);
    document.documentElement.classList.toggle("tm-settings-layer", isSettings);
    return () => {
      document.body.classList.remove("tm-widget-layer", "tm-settings-layer");
      document.documentElement.classList.remove("tm-settings-layer");
    };
  }, [kind, isSettings]);

  if (kind === "taskbar-net") {
    // F8 防御分支：main.tsx 已把旧路径重定向到 taskbar-net.html；走到这里
    // 说明重定向被绕过（如手工改 hash），宁可不渲染也不在网速条窗里挂整棵
    // 桌面层。
    return null;
  }

  if (isQuickNote) {
    return (
      <>
        <SettingsSync />
        {/* [SPLIT-THEME] 分体主题：速记窗可在 SettingsSync 之后覆盖明暗档。 */}
        <FloatingThemeSync />
        {/* P3（审计修复）：速记窗渲染异常此前直接顶穿根边界，整窗替换为
            全局错误页。包一层边界把故障限制在速记视图内。 */}
        <ErrorBoundary>
          <Suspense fallback={null}>
            <QuickNoteView />
          </Suspense>
        </ErrorBoundary>
      </>
    );
  }

  if (isSnip) {
    // [SNIP] 截图覆盖窗：只挂主题同步 + 视图本体（无画布/托盘/番茄钟职责），
    // 背景类不套 tm-widget-layer（该类带点击穿透语义，截图窗必须可交互）。
    // C-1：复制/保存/钉图失败要能弹 toast，本窗也挂 Host（队列是 WebView
    // 级单例，不挂就静默丢失）。C-10 后正式入口走 snip.html 精简入口，
    // 本分支退居旧 hash 兜底。
    return (
      <>
        <SettingsSync />
        <ToastHost />
        <ErrorBoundary>
          <Suspense fallback={null}>
            <SnipView />
          </Suspense>
        </ErrorBoundary>
      </>
    );
  }

  if (isSuperPanel) {
    // [SUPER-PANEL]（ZTools #11）超级面板窗：同 snip，只挂主题同步 + 视图本体。
    return (
      <>
        <SettingsSync />
        <ErrorBoundary>
          <Suspense fallback={null}>
            <SuperPanelView />
          </Suspense>
        </ErrorBoundary>
      </>
    );
  }

  if (isFullscreen) {
    // [FULLSCREEN] 全屏展示窗：同 snip，只挂主题同步 + 视图本体。
    return (
      <>
        <SettingsSync />
        <ErrorBoundary>
          <Suspense fallback={null}>
            <FullscreenView />
          </Suspense>
        </ErrorBoundary>
      </>
    );
  }

  if (isSettings) {
    return (
      <>
        <SettingsSync />
        {/* [SPLIT-THEME] 分体主题：设置窗独立明暗档（借鉴 CSH #13）。 */}
        <FloatingThemeSync />
        <StandbyPomodoroTicker />
        <WidgetHydrate />
        <FxController />
        {/* §4.5 快捷键配置的下发/对账只在设置窗做（唯一编辑入口，避免多窗并发重注册）；
            SystemFeedbackListeners 让设置窗也能看到快捷键注册失败的 toast。 */}
        <ShortcutConfigSync />
        {/* [TB-UI] 任务栏配置对账/下发（F-1 模式 B）：与快捷键同理只在设置窗做（唯一编辑
            入口）；store.general.taskbar 变化 → get_taskbar_config 对账 → 不同才 apply。 */}
        <Suspense fallback={null}>
          <TaskbarConfigSync />
        </Suspense>
        <SystemFeedbackListeners />
        {/* P3（审计修复）：设置页渲染异常不再顶穿根边界（否则所有正常
            小组件窗口一起被全局错误页替换）。 */}
        <ErrorBoundary>
          <Suspense fallback={null}>
            <SettingsView />
          </Suspense>
        </ErrorBoundary>
        {/* toast 队列是每个 WebView 独立的模块级单例：设置窗口不挂 Host 时，
            reportPersistError（导入/镜像写失败）、配额溢出提示在本窗口全部
            静默丢失——本地 flash 显示「成功」而真实落库失败，重启即回档。 */}
        <ToastHost />
        <PromptDialogHost />
        <ContextMenuHost />
        <ThemeTooltipHost />
        {/* [POLISH] Ctrl+? 快捷键速查表：两窗各挂一个 Host（全局快捷键表跨窗口） */}
        <ShortcutCheatsheetHost />
      </>
    );
  }

  return (
    <>
      <SettingsSync />
      {primary && <PrimarySchedulers />}
      {primary && <GlobalPomodoroTicker />}
      {!primary && <StandbyPomodoroTicker />}
      {primary && <GlobalGamePause />}
      {primary && <GlobalIdlePause />}
      {/* FocusTimer 借鉴批次：wait-activity 回座门 / 自动化+媒体联动引擎 /
          专注滴答声（全部 primary-only，D-1）；环境音媒体守卫每个 widget 窗口。 */}
      {primary && <GlobalActivityGate />}
      {primary && <PomodoroAutomationHost />}
      {primary && <FocusTickPlayer />}
      <AmbienceMediaGuard />
      <GlobalIdleDim />
      <GlobalIdleGlass />
      {/* G-9：空闲装饰降级（ambientMotion 特效闸 + 时钟降频），每屏各自挂。 */}
      <GlobalIdleDecor />
      {primary && <PomodoroNotifier />}
      <SystemFeedbackListeners />
      <OsNotifyActivationHandler />
      {primary && <PinOnSnipHandler />}
      <FxController />
      <WidgetCanvas />
      <PromptDialogHost />
      <ContextMenuHost />
      <Suspense fallback={null}>
        <CommandPaletteHost />
      </Suspense>
      <ShortcutCheatsheetHost />
      <ToastHost />
      <ThemeTooltipHost />
    </>
  );
}
