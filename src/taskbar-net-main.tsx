/* eslint-disable react-refresh/only-export-components */
/**
 * 任务栏网速条窗口的独立精简入口（taskbar-net.html；原走 index.html#taskbar-net
 * 共用主入口，为两个数字背走整套主包——stores 全家、画布、设置窗、i18n、动效）。
 *
 * 职责（对照 main.tsx 裁剪）：
 *  - 样式：只带字体/全局 token + 本窗样式（feature-taskbar-net.css）；
 *  - 水合：只水合 settings-store（网速显示选项与主题 token 所需）；不水合
 *    app-store/widget-store——本窗不渲染它们，跨窗同步里它们只作静默接收端；
 *  - 同步：SettingsSync（主题 CSS 变量）+ useCrossWindowSettingsSync（只收发
 *    sync:settings，设置窗改网速选项/主题即时生效；不再订阅 widgets/app 等
 *    整包通道）+ useWallpaperTheme（壁纸派生 token 跟随）；
 *  - 不挂：托盘事件、番茄钟心跳、通知、媒体偏好推送、双击桌面手势（均为
 *    桌面层/主窗职责）。
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SettingsSync } from "./app/SettingsSync";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TaskbarNetView } from "./features/taskbar-net/TaskbarNetView";
import { useCrossWindowSettingsSync } from "./lib/cross-window";
import { installAppVisibilityGate } from "./lib/anim";
import { useWallpaperTheme } from "./lib/use-wallpaper-theme";
import { invoke, isTauri } from "./lib/tauri";
import { logCrash, toCrashFields } from "./lib/crash-log";
import { hydrateSettingsFromDb } from "./store/settings-store";
import "./styles/fonts.css";
import "./styles/global.css";
/* 动效令牌面（--ease-* / --dur-* 派生链）定义在
   feature-animations.css，vite 多入口不共享 CSS——不加载则本窗动效时长
   恒吃回退字面量、速度三档失效。规则限定在本窗不存在的类名/fx 闸下，
   无视觉泄漏。 */
import "./styles/feature-animations.css";
import "./styles/feature-taskbar-net.css";

// 首帧即透明：与 main.tsx 同款处置（本窗不是设置窗，保持 widget-layer 形态）。
document.body.classList.add("tm-widget-layer");
document.documentElement.classList.add("tm-widget-layer");
// 隐藏时挂起循环动画（data-app-hidden → global.css paused）。
installAppVisibilityGate();

window.addEventListener("error", (e) => {
  const fields = e.error ? toCrashFields(e.error) : { message: e.message };
  logCrash({ source: "taskbar-net:error", detail: e.filename ? `${e.filename}:${e.lineno}` : undefined, ...fields });
});
window.addEventListener("unhandledrejection", (e) => {
  logCrash({ source: "taskbar-net:promise", ...toCrashFields(e.reason) });
});

function Root() {
  /* 精简跨窗同步：只收发 sync:settings（主题/网速选项）。此前挂完整
     useCrossWindowSync，为两个数字背走 widgets/app/habits/pomodoro 全通道
     整包接收 + 三方合并 + repullWidgetsFromDb。 */
  useCrossWindowSettingsSync();
  useWallpaperTheme();
  useEffect(() => {
    if (isTauri()) document.body.classList.add("is-tauri");
    void hydrateSettingsFromDb().catch((err) => console.error("[Vela] taskbar-net hydration failed", err));
  }, []);
  /* 存活心跳：挂载即首跳 + 5s 周跳。Rust 贴靠线程据此区分「页面活着」
     与「白屏/脚本崩了」——后者关窗重建（有界），杜绝全透明空窗常态压在
     任务栏上。失败静默（非 Tauri/命令暂不可用时只是没有心跳）。 */
  useEffect(() => {
    if (!isTauri()) return;
    const beat = () => void invoke("taskbar_net_heartbeat").catch(() => {});
    beat();
    const id = window.setInterval(beat, 5_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <>
      <SettingsSync />
      <ErrorBoundary>
        <TaskbarNetView />
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
