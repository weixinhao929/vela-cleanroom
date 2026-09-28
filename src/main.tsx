/* eslint-disable react-refresh/only-export-components */
/**
 * 应用启动入口（多窗口共用：小组件主窗 / 设置窗 #/settings / 速记窗）。
 *
 * 职责：① 按窗口 hash 分包加载样式（设置窗不背负小组件层 CSS）；
 * ② React 挂载前同步置透明层，保证桌面覆盖层首帧即透明；
 * ③ 全局 error/unhandledrejection 兜底进崩溃日志；
 * ④ Root 组件串行水合（app-store → settings-store）并带 4s 安全网，
 *    防止慢/挂起的水合把界面永远卡在闪屏。
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./app/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { isTauri } from "./lib/tauri";
import { logCrash, toCrashFields } from "./lib/crash-log";
import { hydrateApp } from "./store/app-store";
import { hydrateSettingsFromDb } from "./store/settings-store";
import { markBoot } from "./lib/boot-profile";
import { installAppVisibilityGate } from "./lib/anim";
import { useSafeTimeout } from "./lib/use-safe-timeout";
import { resolveWindowKind } from "./app/window-kind";
/* ── 样式分包：所有窗口共享的基础样式静态加载；窗口专属样式按上下文
   动态 import（Vite 会拆成独立 chunk）。设置窗口不再背负小组件层的
   feature-*.css，2+ 个常驻小组件窗口也不再加载 settings.css（1.1k 行）。
   rb.css（设置页动效）随 SettingsView chunk、command-palette.css 随命令
   面板 chunk 走，不再由所有窗口静态背负。 */
import "./styles/fonts.css";
import "./styles/global.css";
import "./styles/widget.css";
import "./styles/widget-anim.css";
import "./styles/feature-context-menu.css";
import "./styles/feature-animations.css";
import "./styles/feature-fx.css";
/* POLISH 打磨包（滑条 v2 / 曲线编辑器 / 快捷键速查表）：两窗共用，静态加载。 */
import "./styles/feature-polish.css";

// 按窗口按需加载的样式 chunk。此前 `void import(...)` 不等待：设置窗的
// SettingsView 懒 chunk 与 settings.css 并行到达，JS 先到即渲染出无样式首帧。
// 这里把加载 promise 交给 Root 的 ready 门控一并等待（4s 兜底仍在）。
// 六个小组件层效果样式只对 widget 窗口加载——速记 / 截图 / 取词 / 全屏等
// 瞬时小窗此前也要多等一轮 chunk 往返才放行首帧，拖慢「按键到可见」。
const windowCssReady: Promise<unknown> =
  window.location.hash === "#/settings"
    ? import("./styles/settings.css")
    : resolveWindowKind() === "widget"
      ? Promise.all([
          import("./styles/feature-task-complete.css"),
          import("./styles/feature-calendar.css"),
          import("./styles/feature-widget-interaction.css"),
          import("./styles/feature-pomodoro.css"),
          import("./styles/feature-analytics.css"),
          import("./styles/feature-views.css")
        ])
      : Promise.resolve();
windowCssReady.catch((err) => console.error("[Vela] window css chunk failed", err));

// 冷启动第一个打点：bundle 已下载并开始执行。此前的耗时（进程创建、
// WebView2 初始化、HTML/JS 下载与解析）都体现在这个数值本身里。
markBoot("script-eval");

// F8（双入口收敛）：#taskbar-net 旧路径在此重定向到 taskbar-net.html 精简
// 入口（vite 多页，dev/build 均可达），App 里不再保留第二棵渲染树——两棵树
// 靠人肉对齐必然漂移（兜底分支实际多挂了托盘事件/媒体偏好推送/双击手势等
// 桌面层职责，与「只挂主题同步」的口径不符）。replace 不留历史，E2E 与
// 浏览器开发的旧链接照常可用。
// C-10（卫星窗精简入口）：snip / super-panel / fullscreen 同款重定向——
// Rust 建窗已直连新 html，这里兜住浏览器开发与旧链接；fullscreen 的
// #fullscreen&kind=xx 整段 hash 原样带过去（FullscreenView 靠它解析模式）。
if (window.location.hash === "#taskbar-net") {
  window.location.replace("taskbar-net.html");
} else if (window.location.hash === "#snip") {
  window.location.replace("snip.html");
} else if (window.location.hash === "#super-panel") {
  window.location.replace("super-panel.html");
} else if (window.location.hash.startsWith("#fullscreen")) {
  window.location.replace(`fullscreen.html${window.location.hash}`);
}

// P3：窗口隐藏（遮挡/最小化）时给根节点写 data-app-hidden，global.css 据此
// 把循环动画置 paused。多窗口共用入口，settings 窗同样受益。
installAppVisibilityGate();

/**
 * Applied synchronously BEFORE React mounts so the widget layer is transparent
 * from the very first frame. The settings window (hash `#/settings`) keeps the
 * normal opaque app background; the desktop widget window must never show the
 * default beige body background (not even during hydration), or it would cover
 * the desktop like a solid color panel.
 */
if (window.location.hash !== "#/settings") {
  document.body.classList.add("tm-widget-layer");
  document.documentElement.classList.add("tm-widget-layer");
}

// 桌面层窗口（非设置/速记）安装层显隐淡入淡出：Rust toggle_widget_layer
// 隐藏前发 layer:fade-out、显示后发 layer:fade-in（见 lib/layer-fade.ts）。
if (window.location.hash !== "#/settings" && window.location.hash !== "#quick-note") {
  void import("./lib/layer-fade").then((m) => m.installLayerFade());
}

/**
 * 全局未捕获异常 → 崩溃日志（设置页诊断区可查看）。小组件渲染错误由
 * 各自的 WidgetErrorBoundary 捕获；这里的钩子兜底 Promise 拒绝与
 * 边界外抛出的异常，保证任何崩溃都有迹可循。
 */
window.addEventListener("error", (e) => {
  const fields = e.error ? toCrashFields(e.error) : { message: e.message };
  logCrash({ source: "global:error", detail: e.filename ? `${e.filename}:${e.lineno}` : undefined, ...fields });
});
window.addEventListener("unhandledrejection", (e) => {
  logCrash({ source: "global:promise", ...toCrashFields(e.reason) });
});

/**
 * Adds the Tauri-only body class. The `data-theme` attribute is owned by
 * applySettings (settings-store) so the 7 presets stay the single source of
 * truth for theming.
 */
/**
 * 挂载 Tauri 专属 body 类（is-tauri）；data-theme 由 applySettings 独占
 * 管理（7 预设为主题唯一事实来源），此处不触碰。
 *
 * @returns null（纯副作用组件）。
 */
function ThemeSync() {
  useEffect(() => {
    if (isTauri()) document.body.classList.add("is-tauri");
  }, []);
  return null;
}

/**
 * Bootstraps the app. In the Tauri runtime this hydrates the store from SQLite
 * (running the one-time localStorage migration first); in browser dev mode it
 * loads from localStorage. A minimal loading gate avoids rendering an empty
 * dashboard before data is available.
 */
/**
 * 启动根组件：串行水合数据（SQLite 迁移→app-store→settings-store；浏览器
 * 模式读 localStorage），ready 后挂载 App；闪屏在就绪后播 200ms 淡出卸载
 * （#59 crossfade）。水合失败或超 4s 均放行渲染默认状态，绝不卡死启动。
 *
 * @returns 根节点（App + 启动闪屏）。
 */
function Root() {
  const [ready, setReady] = useState(false);
  /* #59 crossfade：ready 后画布先挂载，闪屏播 200ms 淡出再卸载。 */
  const [splashGone, setSplashGone] = useState(false);
  const safeTimeout = useSafeTimeout();

  // 首帧打点：ready 变 true 后的第一次绘制即真实界面出现的时刻。
  useEffect(() => {
    if (ready) markBoot("first-paint");
  }, [ready]);

  /* 窗口就绪握手（H1/H2）：设置窗与速记窗由 Rust 侧 visible(false) 创建，
     此前 build() 返回即 show()，WebView 未加载完先以一块空影出现，经历
     「空影 → 闪屏 → 内容」三段跳变。改为首帧真正绘制后由本窗自行显示
     （用户看到的第一眼就是设计过的闪屏/内容）；Rust 侧另有 3s 超时兜底
     （windows.rs spawn_show_fallback），前端崩溃时窗口也会强制显示。
     桌面层窗口不受影响（启动即全屏，由 lib.rs 直接显示）。 */
  useEffect(() => {
    if (!ready || !isTauri()) return;
    const hash = window.location.hash;
    if (hash !== "#/settings" && hash !== "#quick-note") return;
    const raf = requestAnimationFrame(() => {
      const w = getCurrentWindow();
      void w.show();
      void w.setFocus();
    });
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    safeTimeout(() => setSplashGone(true), 240);
  }, [ready, safeTimeout]);

  useEffect(() => {
    const cancelled = { value: false };
    markBoot("hydrate-start");
    // 两路水合互不依赖（app-store / settings-store 各自独立），此前串行
    // await 把 2 个 IPC 往返叠加进首帧；样式 chunk 等待与水合并行（仅挡
    // 极端情况下的无样式首帧，失败不阻塞）。
    Promise.all([
      hydrateApp().then(() => {
        markBoot("hydrate-db");
      }),
      hydrateSettingsFromDb().then(() => {
        markBoot("hydrate-settings");
      }),
      windowCssReady.catch(() => undefined)
    ])
      .catch((err) => console.error("[Vela] hydration failed", err))
      .finally(() => {
        if (!cancelled.value) setReady(true);
      });
    // Safety net: never block the UI on a slow/hung hydration. Render the app
    // (with defaults) so the widget layer is never stuck on the boot splash.
    safeTimeout(() => {
      if (!cancelled.value) setReady(true);
    }, 4000);
    return () => {
      cancelled.value = true;
    };
  }, [safeTimeout]);

  return (
    <>
      <ThemeSync />
      {ready && <App />}
      {!splashGone && (
        <div className={`boot-splash${ready ? " is-out" : ""}`} aria-hidden="true">
          <div className="boot-splash-inner">
            <span className="boot-splash-logo">Vela</span>
            <span className="boot-splash-dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>
);

// React 挂载调用已返回（渲染本身是异步的，此处衡量的是 bundle 到挂载的开销）。
markBoot("react-mount");
