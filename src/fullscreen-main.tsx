/* eslint-disable react-refresh/only-export-components */
/**
 * 全屏展示窗的独立精简入口（fullscreen.html#fullscreen&kind=xx；，对照
 * taskbar-net.html 模式）。原走 index.html#fullscreen 共用主入口——投影大字
 * 钟的「按键到可见」链路里塞进了 3.5 万行 CSS 大头 + 双 store 水合 + 全部
 * 全局 handler。
 *
 * 职责（对照 main.tsx 裁剪）：
 *  - 样式：字体/全局 token + FullscreenView 自带的 fullscreen.css；
 *  - 水合：只水合 settings-store（主题 token / 语言）；时钟走 useNow、
 *    倒计时扫 localStorage、番茄钟吃 sync:pomodoro 快照，全不需要
 *    app-store 水合；
 *  - 同步：SettingsSync + useCrossWindowSettingsSync + useWallpaperTheme；
 *  - 不挂：托盘事件、番茄钟心跳（本窗只读展示）、通知、跨窗 widgets/app
 *    通道、layer-fade（Rust 只对 widget-N 标签广播）。
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SettingsSync } from "./app/SettingsSync";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FullscreenView } from "./features/fullscreen/FullscreenView";
import { useCrossWindowSettingsSync } from "./lib/cross-window";
import { installAppVisibilityGate } from "./lib/anim";
import { useWallpaperTheme } from "./lib/use-wallpaper-theme";
import { isTauri } from "./lib/tauri";
import { logCrash, toCrashFields } from "./lib/crash-log";
import { hydrateSettingsFromDb } from "./store/settings-store";
import "./styles/fonts.css";
import "./styles/global.css";
/* 动效令牌面（--ease-* 两族 + --dur-* 派生链）定义
   在 feature-animations.css，vite 多入口不共享 CSS——本窗此前的
   var(--ease-out) 无定义致整条 animation 简写 unset（入场/退场/爆闪全静默
   失效），--dur-fx 也恒吃回退字面量。该文件规则全部限定在 .widget-* 等本窗
   不存在的类名 / fx 闸下，加载无视觉泄漏。 */
import "./styles/feature-animations.css";

// 首帧即透明：与 main.tsx 同款处置（投影底色由 fullscreen.css 自绘）。
document.body.classList.add("tm-widget-layer");
document.documentElement.classList.add("tm-widget-layer");
installAppVisibilityGate();

window.addEventListener("error", (e) => {
  const fields = e.error ? toCrashFields(e.error) : { message: e.message };
  logCrash({ source: "fullscreen:error", detail: e.filename ? `${e.filename}:${e.lineno}` : undefined, ...fields });
});
window.addEventListener("unhandledrejection", (e) => {
  logCrash({ source: "fullscreen:promise", ...toCrashFields(e.reason) });
});

function Root() {
  useCrossWindowSettingsSync();
  useWallpaperTheme();
  useEffect(() => {
    if (isTauri()) document.body.classList.add("is-tauri");
    // 不设 ready 门：默认主题先上，DB 值到达后重应用；就绪握手（show）
    // 由 FullscreenView 首帧后自己掌握。
    void hydrateSettingsFromDb().catch((err) => console.error("[Vela] fullscreen hydration failed", err));
  }, []);
  return (
    <>
      <SettingsSync />
      <ErrorBoundary>
        <FullscreenView />
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
