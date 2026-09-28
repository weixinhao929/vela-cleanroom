/**
 * F7（组合根瘦身）：窗口类型判定单点。此前 App.tsx 里散落 6 个 isXxxWindow()
 * 谓词，各 handler 自行引用其一，新增窗口类型要改多处。这里收敛为按 hash
 * 解析的单一函数；App 只消费解析结果做分派。
 *
 * 约定（与 Rust 侧建窗 URL 一一对应）：
 *  - index.html            → widget（桌面小组件层，可能多屏 widget-1/2…）
 *  - index.html#/settings  → settings
 *  - index.html#quick-note → quick-note（W-067 全局速记）
 *  - index.html#snip       → snip（截图覆盖窗；正式入口 snip.html——C-10，
 *                            main.tsx 把旧 hash 重定向过去，枚举保留作兜底）
 *  - index.html#super-panel→ super-panel（取词面板；正式入口
 *                            super-panel.html，同上）
 *  - index.html#fullscreen…→ fullscreen（投影大字钟/倒计时/番茄钟；正式
 *                            入口 fullscreen.html，同上）
 *  - #taskbar-net          → taskbar-net（main.tsx 已重定向到 taskbar-net.html；
 *                            保留枚举值作防御，App 对它渲染 null）
 */
export type WindowKind = "widget" | "settings" | "quick-note" | "snip" | "super-panel" | "fullscreen" | "taskbar-net";

export function resolveWindowKind(): WindowKind {
  const hash = window.location.hash;
  if (hash === "#/settings") return "settings";
  if (hash === "#quick-note") return "quick-note";
  if (hash === "#snip") return "snip";
  if (hash === "#super-panel") return "super-panel";
  if (hash.startsWith("#fullscreen")) return "fullscreen";
  if (hash === "#taskbar-net") return "taskbar-net";
  return "widget";
}
