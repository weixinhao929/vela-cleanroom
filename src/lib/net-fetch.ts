import { invoke, isTauri } from "./tauri";

/**
 * W-016/W-018 通用文本拉取：桌面版走 Rust `fetch_url_text`（绕过 webview
 * CORS，Google/Outlook 的 ICS 与 GitHub Raw JSON 都能拉），浏览器开发环境
 * 回退原生 fetch。失败抛错，由调用方决定降级行为。
 */
/**
 * 通用文本拉取（W-016/W-018）。
 *
 * 桌面版走 Rust `fetch_url_text` 绕过 webview CORS（Google/Outlook 的 ICS
 * 与 GitHub Raw JSON 都能拉）；浏览器开发环境回退原生 fetch。
 *
 * @param url - 目标资源地址（http/https）。
 * @returns 响应正文文本（UTF-8 解码）。
 * @throws 桌面端：Rust 网络错误原样 reject；浏览器端：非 2xx 抛
 *         `Error("HTTP <status>")`，网络失败抛 fetch 原生错误。
 *
 * @example
 * ```ts
 * const ics = await fetchText("https://calendar.google.com/calendar/ical/.../basic.ics");
 * ```
 */
export async function fetchText(url: string): Promise<string> {
  if (isTauri()) {
    return invoke<string>("fetch_url_text", { url });
  }
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}
