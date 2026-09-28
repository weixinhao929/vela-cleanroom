/**
 * P1 空屏窗口对账（前端侧触发器）。
 *
 * Rust 侧按各屏持久化内容的 SQLite 镜像决定 widget-N 窗口的建/销
 * （`reconcile_widget_windows` 命令，见 monitor.rs）。本模块在每次布局/
 * dock 落盘后防抖触发一次对账：
 * - 清空某屏全部小组件/磁贴 → 该屏窗口被销毁，不再白养一个 WebView2
 *   渲染进程（约 120–170MB/屏）；
 * - 给空屏放入第一个小组件/磁贴 → 窗口即时重建。
 *
 * 防抖 1.2s：SQLite 镜像写（writeInstancesNow/saveDock 内的 setSetting）
 * 是异步 IPC，对账前留出落库时间；连续拖拽只对账尾沿一次。
 */
import { invoke, isTauri } from "../lib/tauri";

const RECONCILE_DEBOUNCE_MS = 1200;

let timer: number | null = null;

/** 防抖触发一次 Rust 侧窗口对账（浏览器模式 no-op）。 */
export function scheduleWidgetWindowReconcile(): void {
  if (!isTauri()) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    // 调用窗口自身可能就是对账销毁的目标（在空屏上删光小组件）：命令
    // 返回前 webview 被销毁属预期，静默即可。
    invoke("reconcile_widget_windows").catch(() => {});
  }, RECONCILE_DEBOUNCE_MS);
}
