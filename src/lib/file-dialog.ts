/**
 * 文件选择对话框封装（tauri-plugin-dialog）。
 *
 * 为什么不用自研 `pick_file`（rfd）：rfd 的同步对话框拿不到调用方窗口句柄，
 * 在 Windows 上对话框没有 owner，会落在 Z 序最后——悬浮窗层是
 * always-on-bottom + skip_taskbar 的桌面覆盖层，从它发起的对话框经常
 * 弹在所有窗口后面甚至完全不可见，表现为「点了导入没反应」。
 * tauri-plugin-dialog 会把对话框附着到发起调用的 webview 窗口上，
 * 保证弹窗置前可见。错误会向上抛出，让调用方 UI 显示原因。
 */
import { isTauri } from "./tauri";

/** 文件类型过滤器（透传 tauri-plugin-dialog）。 */
export type FileFilter = { name: string; extensions: string[] };

/**
 * 打开单选文件对话框并返回所选路径。
 * 必须用 tauri-plugin-dialog（附着到发起窗口）：自研 rfd 同步对话框拿不到
 * owner，在本应用的 always-on-bottom 桌面覆盖层上会弹到 Z 序底部不可见。
 *
 * @param opts - `title` 对话框标题；`filters` 类型过滤（名称+扩展名列表）。
 * @returns 所选文件的绝对路径；用户取消返回 null。
 * @throws 浏览器模式抛 Error（"文件选择需要桌面版"）；插件调用失败原样抛。
 *
 * @example
 * ```ts
 * const path = await pickFilePath({ title: "选择课表文件", filters: [{ name: "Excel", extensions: ["xlsx"] }] });
 * if (path) void importTimetable(path);
 * ```
 */
export async function pickFilePath(
  opts: {
    title?: string;
    filters?: FileFilter[];
    /** 对话框初始目录（恢复备份等场景直接定位到备份目录，用户不必知道路径）。 */
    defaultPath?: string;
  } = {}
): Promise<string | null> {
  if (!isTauri()) {
    throw new Error("文件选择需要桌面版");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: false,
    directory: false,
    title: opts.title,
    filters: opts.filters,
    defaultPath: opts.defaultPath
  });
  return typeof res === "string" ? res : null;
}
