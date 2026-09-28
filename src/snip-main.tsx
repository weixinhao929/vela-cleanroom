/* eslint-disable react-refresh/only-export-components */
/**
 * 截图覆盖窗的独立精简入口（snip.html；C-10，对照 taskbar-net.html 模式）。
 * 原走 index.html#snip 共用主入口——每次截图都要解析执行 3.5 万行 CSS 的
 * 大头（widget.css 11.8k 行等）+ 双 store 水合 + 全部全局 handler，与
 * 「按键到可见」的瞬时窗性能目标相悖。
 *
 * 职责（对照 main.tsx 裁剪）：
 *  - 样式：字体/全局 token + ToastHost 自带的 feature-toast.css（C-1 失败
 *    toast）+ SnipView 自带的 snip.css；
 *  - 水合：只水合 settings-store（主题 token / 语言）；不水合
 *    app-store/widget-store——截图窗不渲染它们；
 *  - 同步：SettingsSync（主题 CSS 变量）+ useCrossWindowSettingsSync（只收发
 *    sync:settings）+ useWallpaperTheme（壁纸派生 token 跟随）；
 *  - 不挂：托盘事件、番茄钟心跳、通知、跨窗 widgets/app 通道、layer-fade
 *    （Rust 只对 widget-N 标签广播）。
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SettingsSync } from "./app/SettingsSync";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastHost } from "./components/ToastHost";
import { SnipView } from "./features/snip/SnipView";
import { useCrossWindowSettingsSync } from "./lib/cross-window";
import { installAppVisibilityGate } from "./lib/anim";
import { useWallpaperTheme } from "./lib/use-wallpaper-theme";
import { isTauri } from "./lib/tauri";
import { logCrash, toCrashFields } from "./lib/crash-log";
import { hydrateSettingsFromDb } from "./store/settings-store";
import "./styles/fonts.css";
import "./styles/global.css";

// 首帧即透明：与 main.tsx 同款处置（本窗不是设置窗，保持 widget-layer 形态；
// 窗口由 Rust visible(false) 创建，SnipView 取到冻结帧后自行 show）。
document.body.classList.add("tm-widget-layer");
document.documentElement.classList.add("tm-widget-layer");
// P3：隐藏时挂起循环动画（data-app-hidden → global.css paused）。
installAppVisibilityGate();

window.addEventListener("error", (e) => {
  const fields = e.error ? toCrashFields(e.error) : { message: e.message };
  logCrash({ source: "snip:error", detail: e.filename ? `${e.filename}:${e.lineno}` : undefined, ...fields });
});
window.addEventListener("unhandledrejection", (e) => {
  logCrash({ source: "snip:promise", ...toCrashFields(e.reason) });
});

function Root() {
  /* 精简跨窗同步：只收发 sync:settings（主题/语言）。此前挂完整
     useCrossWindowSync，为一次截图背走 widgets/app/habits/pomodoro 全通道
     整包接收 + 三方合并 + repullWidgetsFromDb。 */
  useCrossWindowSettingsSync();
  useWallpaperTheme();
  useEffect(() => {
    if (isTauri()) document.body.classList.add("is-tauri");
    // 不设 ready 门：主题默认值先上，DB 值到达后 SettingsSync 重应用；
    // 截图窗就绪握手由 SnipView 自己掌握（取到冻结帧才 show）。
    void hydrateSettingsFromDb().catch((err) => console.error("[Vela] snip hydration failed", err));
  }, []);
  return (
    <>
      <SettingsSync />
      <ToastHost />
      <ErrorBoundary>
        <SnipView />
      </ErrorBoundary>
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
