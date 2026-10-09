/**
 * Tauri environment detection and IPC wrapper.
 * Keeps browser dev mode working by feature-detecting the Tauri runtime.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TaskbarAppearance, TaskbarStateKey } from "../store/settings-store";

/**
 * 特性检测当前是否运行在 Tauri（桌面）环境。
 *
 * @returns true 表示 WebView 内已注入 `__TAURI_INTERNALS__`，可安全 invoke/listen。
 * @example
 * ```ts
 * if (isTauri()) void invoke("set_edit_mode", { enabled: true });
 * ```
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 读取当前 WebView 窗口的 label。
 *
 * @returns 窗口标识（如 `"widget-0"` / `"settings"` / `"quick-note"`）；
 *          浏览器模式或读取失败时返回 null。O(1)。
 * @throws 无。
 *
 * @example
 * ```ts
 * if (currentWindowLabel() === "settings") renderSettingsChrome();
 * ```
 */
export function currentWindowLabel(): string | null {
  if (!isTauri()) return null;
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

/**
 * 判断本窗口是否为主小组件窗口（单例职责模式）。
 *
 * 主窗口（label `"widget-0"`）唯一负责驱动番茄钟 tick / 通知 / 托盘 /
 * 快捷键监听。多显示器下每个物理屏幕各有一个 widget-<i> 窗口，若全部独立
 * 跑表会把同一段专注双写、通知 ×N。浏览器模式（label 为 null，
 * 仅单窗口）视为 primary。
 *
 * @returns true 表示本窗口应承担全局副作用。
 * @example
 * `ts
 * if (isPrimaryWidgetWindow()) startGlobalTicker();
 * `
 */
export function isPrimaryWidgetWindow(): boolean {
  const label = currentWindowLabel();
  return label === null || label === "widget-0";
}

type InvokeArgs = Record<string, unknown>;

/**
 * 调用 Tauri 命令（IPC 门面）。
 *
 * @typeParam T - Rust 命令返回值反序列化后的类型。
 * @param cmd - 命令名（与 `src-tauri` `generate_handler!` 注册项一致）。
 * @param args - 参数对象，键为 camelCase（Tauri 自动映射到 Rust snake_case）。
 * @returns 命令执行结果 Promise。
 * @throws 浏览器模式抛 Error（调用方应据此回退 localStorage 适配器）；
 *         Rust 侧命令错误原样 reject。
 *
 * @example
 * ```ts
 * const tasks = await invoke<RustTask[]>("list_tasks");
 * ```
 */
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  if (!isTauri()) {
    throw new Error(`[Vela] Tauri command "${cmd}" called outside Tauri runtime`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * 呼出独立设置窗口（label `"settings"`）。
 *
 * 已存在的实例会先还原（unminimize）再聚焦；浏览器开发模式为 no-op，
 * 改为打开内嵌设置面板，保证设置功能在纯前端环境仍可用。
 *
 * @returns 窗口就绪（已显示/聚焦）后 resolve。
 * @throws 动态导入或窗口 API 失败时向上传播（调用方可 catch 兜底）。
 */
export async function openSettingsWindow(): Promise<void> {
  if (!isTauri()) {
    const { useSettingsStore } = await import("../store/settings-store");
    useSettingsStore.getState().setSettingsOpen(true);
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel("settings");
  if (win) {
    // 设置窗口可能被"关闭"（= 最小化到任务栏），呼出时需要先还原再聚焦。
    try {
      await win.unminimize();
    } catch {
      // not minimized / unsupported — ignore
    }
    await win.show();
    await win.setFocus();
  }
}

/* ---------------- 任务栏 · 实时预览通道（TB-PREVIEW） ---------------- */

/**
 * 任务栏实时预览（需求 ）：把 `state` 的外观（合并 `overrides`）临时强制到
 * 全部任务栏并挂起状态机输出 60s；`state=null` 取消预览，回到真实求值结果。
 *
 * 与 `apply_taskbar_config`（切片变化 350ms 防抖后整包落定）是两条独立通道：
 * 预览不改配置、不落盘。Rust 端把滑动期的高频调用按 ≤80ms 步进合并下发，
 * 60s 无新提交自动取消；真实 apply / reset 亦结束预览。
 *
 * @param state - 目标状态键；null = 取消预览。
 * @param overrides - 部分外观覆盖。拖动时把编辑器里整套外观全传，保证任务栏
 *        所见与滑条一致（不依赖 Rust 侧配置存底是否已对账）。
 * @returns Rust 命令完成后 resolve；模块未就绪 / 非可信窗口 / 浏览器模式 reject。
 *
 * @example
 * `ts
 * await previewTaskbarState("maximizedWindow", { color: "#00000080" });
 * await previewTaskbarState(null); // 取消
 * `
 */
export async function previewTaskbarState(
  state: TaskbarStateKey | null,
  overrides?: Partial<TaskbarAppearance> | null
): Promise<void> {
  await invoke<void>("preview_taskbar_state", { state, overrides: overrides ?? null });
}
