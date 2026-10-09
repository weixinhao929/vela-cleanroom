/* eslint-disable react-refresh/only-export-components */
/**
 * 超级面板窗的独立精简入口（super-panel.html；，对照 taskbar-net.html
 * 模式）。原走 index.html#super-panel 共用主入口——长按右键取词到面板可见
 * 的链路里塞进了 3.5 万行 CSS 大头 + 双 store 水合 + 全部全局 handler。
 *
 * 职责（对照 main.tsx 裁剪）：
 *  - 样式：字体/全局 token + SuperPanelView 自带的 super-panel.css；
 *  - 水合：只水合 settings-store（主题 token / 语言）；搜索引擎等面板选项
 *    由 SuperPanelView 直读 localStorage（loadSpotlightSettings）；
 *  - 同步：SettingsSync + useCrossWindowSettingsSync + useWallpaperTheme；
 *  - 不挂：托盘事件、番茄钟心跳、通知、跨窗 widgets/app 通道、layer-fade。
 * 窗口为 Rust 复用型（失焦 hide 不销毁），本入口常驻但零轮询。
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SettingsSync } from "./app/SettingsSync";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SuperPanelView } from "./features/super-panel/SuperPanelView";
import { useCrossWindowSettingsSync } from "./lib/cross-window";
import { installAppVisibilityGate } from "./lib/anim";
import { useWallpaperTheme } from "./lib/use-wallpaper-theme";
import { isTauri } from "./lib/tauri";
import { logCrash, toCrashFields } from "./lib/crash-log";
import { hydrateSettingsFromDb } from "./store/settings-store";
import "./styles/fonts.css";
import "./styles/global.css";
/* 动效令牌面（--ease-* / --dur-* 派生链）定义在
   feature-animations.css，vite 多入口不共享 CSS——不加载则本窗动效时长
   恒吃回退字面量、速度三档失效。规则限定在本窗不存在的类名/fx 闸下，
   无视觉泄漏。 */
import "./styles/feature-animations.css";

// 首帧即透明：与 main.tsx 同款处置（面板底色由 super-panel.css 自绘）。
document.body.classList.add("tm-widget-layer");
document.documentElement.classList.add("tm-widget-layer");
installAppVisibilityGate();

window.addEventListener("error", (e) => {
  const fields = e.error ? toCrashFields(e.error) : { message: e.message };
  logCrash({ source: "super-panel:error", detail: e.filename ? `${e.filename}:${e.lineno}` : undefined, ...fields });
});
window.addEventListener("unhandledrejection", (e) => {
  logCrash({ source: "super-panel:promise", ...toCrashFields(e.reason) });
});

function Root() {
  useCrossWindowSettingsSync();
  useWallpaperTheme();
  useEffect(() => {
    if (isTauri()) document.body.classList.add("is-tauri");
    // 面板是复用型瞬时窗：默认主题先上，DB 值到达后重应用；就绪握手
    // （show）由 SuperPanelView 在补拉载荷完成后自己掌握。
    void hydrateSettingsFromDb().catch((err) => console.error("[Vela] super-panel hydration failed", err));
  }, []);
  return (
    <>
      <SettingsSync />
      <ErrorBoundary>
        <SuperPanelView />
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
