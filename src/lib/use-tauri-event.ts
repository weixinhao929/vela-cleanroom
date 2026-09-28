import { useEffect, useRef } from "react";
import { isTauri } from "./tauri";

/**
 * 订阅 Tauri 事件；浏览器开发模式下为 no-op。
 *
 * 模块职责：统一收口各组件手写的「动态 import → listen → disposed/unlisten
 * 守卫」样板（适配器模式）。卸载后才到达的订阅会立即被取消，动态导入失败
 * 静默忽略。
 *
 * handler 经 ref 持有，始终为最新一次渲染的闭包——回调身份变化不会触发
 * 重订阅（原样板中依赖数组里塞业务 id 导致的反复解绑/重绑随之消失）。
 *
 * @typeParam T - 事件负载类型（与 Rust 侧 `emit` 的 JSON 结构对应）。
 * @param event - Tauri 事件名；变更时自动退订旧事件、订阅新事件。
 * @param handler - 收到事件的同步回调，每次派发取最新闭包。
 * @returns 无（副作用型 hook）。
 * @throws 无（listen 失败仅静默忽略——桌面端缺失属正常场景）。
 *
 * @example
 * ```tsx
 * useTauriEvent<{ instanceId: string }>("sync:notes", (p) => {
 *   if (p.instanceId === id) reload();
 * });
 * ```
 */
export function useTauriEvent<T = unknown>(event: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<T>(event, (e) => handlerRef.current(e.payload)))
      .then((f) => {
        if (disposed) f();
        else unlisten = f;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}
