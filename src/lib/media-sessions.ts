import { useEffect, useState } from "react";
import { invoke, isTauri } from "./tauri";

/**
 * 媒体会话列表的共享轮询器（引用计数单例）。
 *
 * 「正在播放」卡片（nowplaying/both 布局）与音乐沉浸页各自需要媒体会话数据
 * （get_media_sessions_page 单命令 1 IPC / 3s / 窗口），
 * 沉浸页展开时底层卡片仍挂载继续轮询——同窗口同数据 2 份并发；每多一个
 * 音乐实例再翻一倍。本模块把轮询收敛为窗口级单例：首个订阅者启动 3s
 * 定时器（页面隐藏跳拍），末个退订停止；数据经订阅分发，内容不变时分发
 * 旧引用（消费方 setState 被短路，不触发重渲）。
 */

/**
 * 视图容忍类型：blocked 允许缺省（旧载荷/本地构造）。线协议的严格形态见
 * types/bindings/MediaSessionInfo.ts（Rust media.rs::MediaSessionInfo，M3）。
 */
export interface MediaSessionEntry {
  id: string;
  name: string;
  playing: boolean;
  /** W-131 黑名单态（渲染分组用；缺省视为未隐藏）。 */
  blocked?: boolean;
}

type Snapshot = { sessions: MediaSessionEntry[]; selectedId: string | null };

let started = false;
let timer = 0;
let current: Snapshot = { sessions: [], selectedId: null };
const listeners = new Set<() => void>();

function sameSessions(a: MediaSessionEntry[], b: MediaSessionEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (s, i) => s.id === b[i].id && s.name === b[i].name && s.playing === b[i].playing && !!s.blocked === !!b[i].blocked
    )
  );
}

function notify() {
  for (const fn of listeners) fn();
}

function poll() {
  if (document.hidden) return;
  // 合并命令（Rust get_media_sessions_page）：列表 + 锁定 id 一次往返——
  // 此前每 3s 两条 IPC，各走一遍 GMS 枚举/读锁。
  void invoke<{ sessions: MediaSessionEntry[] | null; selected_id: string | null }>("get_media_sessions_page")
    .then((page) => {
      const next = page.sessions ?? [];
      const selectedId = page.selected_id ?? null;
      if (!sameSessions(current.sessions, next)) current = { ...current, sessions: next };
      if (current.selectedId !== selectedId) current = { ...current, selectedId };
      notify();
    })
    .catch(() => {});
}

function ensurePolling() {
  if (started || !isTauri()) return;
  started = true;
  poll();
  timer = window.setInterval(poll, 3000);
}

function maybeStop() {
  if (listeners.size > 0 || !started) return;
  started = false;
  window.clearInterval(timer);
  timer = 0;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensurePolling();
  return () => {
    listeners.delete(cb);
    maybeStop();
  };
}

function getSnapshot(): Snapshot {
  return current;
}

/**
 * 订阅共享的媒体会话列表与当前锁定会话。
 * @param active - false 时不订阅（组件不可见 / 无入口时的空转省略）。
 * @returns `{ sessions, selectedId }`（浏览器模式恒为空表 + null）。
 */
export function useMediaSessions(active: boolean): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(current);
  useEffect(() => {
    if (!active) return;
    if (!isTauri()) return;
    let disposed = false;
    const onChange = () => {
      if (!disposed) setSnap(getSnapshot());
    };
    const unsub = subscribe(onChange);
    onChange();
    return () => {
      disposed = true;
      unsub();
    };
  }, [active]);
  return active ? snap : { sessions: [], selectedId: null };
}
