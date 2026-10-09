/**
 * 系统事件路由（一.1 / 一.3 / 一.4 的前端接线）：把 Rust 侧三类事件汇入
 * 既有通知管线，让「留档 → 通知历史 ↔ 灵动岛接管」零新增路径地工作。
 *
 * - `sysnotify:captured`（Rust sysnotify.rs）：其它应用的系统 Toast 镜像。
 *   Windows 自己已经弹过原生 toast，这里只做**留档 + 岛上接管**，绝不再发
 *   一条 OS 通知（否则同一条消息双重打扰）。
 * - `push:received`（Rust push_server.rs）：本地 HTTP 推送。作为外部主动
 *   送达的消息，留档 + OS toast（免打扰压制 toast 但不压制留档）。
 * - `clipboard:url`（Rust clipboard.rs）：复制纯链接 → 转成 DOM 事件
 *   `focus-desk:clip-link`，由 DockTakeover 提案 kind=link 接管（点击即用
 *   默认浏览器打开）。
 *
 * 多窗口纪律：三类 Tauri 事件广播给全部 widget 窗口 + 设置窗，但**留档只由
 * widget-0（主屏，无条件建窗）执行**，记录经 `app:notification` 广播回所有
 * 窗口——与 lib/notifications 的既有数据流同构（发送窗口两路事件、按 id 去重）。
 *
 * 权限提示：`sysnotify:status`（access=denied）转成 DOM 事件供设置页显示
 * 「去系统设置开权限」的提示行。
 */
import { useSettingsStore } from "../store/settings-store";
import { currentWindowLabel, isTauri } from "./tauri";
import { notifyUser, recordHistory } from "./notifications";
import { dndSuppressing } from "./dnd";

/** 剪贴板链接快开的 DOM 事件（载荷 { url }；DockTakeover 消费）。 */
export const CLIP_LINK_EVENT = "focus-desk:clip-link";
/** 系统通知监听权限状态（载荷 { access: "ok" | "denied" }；设置页消费）。 */
export const SYSNOTIFY_STATUS_EVENT = "focus-desk:sysnotify-status";

/** Rust sysnotify.rs SysNotificationPayload（camelCase）。 */
export type SysNotificationCaptured = {
  id: number;
  appName: string;
  title: string;
  body: string;
  aumid: string;
};

/** Rust push_server.rs PushReceivedPayload（camelCase）。 */
export type PushReceived = {
  title: string;
  body: string;
  source: string;
};

/** 留档领导者：只有主屏窗口执行 IPC 写入，避免多屏各记一份。 */
function isRecorder(): boolean {
  return currentWindowLabel() === "widget-0";
}

let installed = false;

/** 安装三类事件的模块级监听（幂等；由 DockShell 挂载时调用）。 */
export function ensureSystemNotifyListeners(): void {
  if (installed || !isTauri() || typeof window === "undefined") return;
  installed = true;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => {
      // 一.1 系统通知镜像：只留档 + 岛上接管（Windows 已弹过原生 toast）。
      void listen<SysNotificationCaptured>("sysnotify:captured", (e) => {
        const p = e.payload;
        if (!p || typeof p.id !== "number") return;
        if (!useSettingsStore.getState().notifications.systemListener) return;
        if (!isRecorder()) return;
        const title = p.appName && p.title ? `${p.appName}：${p.title}` : p.title || p.appName;
        recordHistory("system", title, p.body || "", "info");
      }).catch(() => {});

      // 一.3 外部推送：留档 + OS toast（免打扰只压制 toast）。
      void listen<PushReceived>("push:received", (e) => {
        const p = e.payload;
        if (!p || typeof p.title !== "string") return;
        if (!useSettingsStore.getState().notifications.pushEnabled) return;
        if (!isRecorder()) return;
        recordHistory(p.source || "push", p.title, p.body || "", "info");
        if (!dndSuppressing()) void notifyUser(p.title, p.body || "", { source: "app" });
      }).catch(() => {});

      // 一.4 剪贴板纯链接：转 DOM 事件供接管层提案（每屏的岛各自弹条）。
      void listen<{ url: string }>("clipboard:url", (e) => {
        const url = e.payload?.url;
        if (typeof url !== "string" || !url) return;
        try {
          window.dispatchEvent(new CustomEvent(CLIP_LINK_EVENT, { detail: { url } }));
        } catch {
          // best-effort
        }
      }).catch(() => {});

      // 权限状态：设置页提示行用。
      void listen<{ access: string }>("sysnotify:status", (e) => {
        try {
          window.dispatchEvent(
            new CustomEvent(SYSNOTIFY_STATUS_EVENT, { detail: { access: e.payload?.access ?? "denied" } })
          );
        } catch {
          // best-effort
        }
      }).catch(() => {});
    })
    /* 外层 import 链补 catch——失败只损失本窗的
       系统事件路由（留档在 widget-0，多屏冗余），裸 rejection 不可接受。 */
    .catch((err: unknown) => console.error("[sysnotify] listener setup failed", err));
}
