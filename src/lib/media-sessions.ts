import { useEffect, useState } from "react";
import { invoke, isTauri } from "./tauri";

/**
 * 媒体会话列表的共享数据源（引用计数单例）。
 *
 * （事件化）：此前「正在播放」卡片/沉浸页各自经 3s 轮询
 * get_media_sessions_page 拉列表（每窗口 1 IPC / 3s，Rust 侧走一遍全量
 * GMS 枚举）。现在 Rust 事件线程每拍本就枚举全量会话，变化时 emit
 * `media:sessions`（签名去抖），本模块退化为：
 *  - 初值：首个订阅者挂载时全量拉一次 get_media_sessions_page；
 *  - 增量：订阅 media:sessions 事件（≤1s 可见延迟，事件线程 1s 粒度）；
 *  - 兜底：30s 低频复核（事件线程 panic 退避/事件丢失时自愈）+ 恢复可见
 *    立即拉一次（此前轮询在 document.hidden 跳拍，恢复后最长 3s 陈旧）。
 * 数据经订阅分发，内容不变时分发旧引用（消费方 setState 被短路）。
 */

/**
 * 视图容忍类型：blocked 允许缺省（旧载荷/本地构造）。线协议的严格形态见
 * types/bindings/MediaSessionInfo.ts（Rust media.rs::MediaSessionInfo，M3）。
 */
export interface MediaSessionEntry {
  id: string;
  name: string;
  playing: boolean;
  /** 黑名单态（渲染分组用；缺省视为未隐藏）。 */
  blocked?: boolean;
}

type Snapshot = { sessions: MediaSessionEntry[]; selectedId: string | null };
type PagePayload = { sessions: MediaSessionEntry[] | null; selected_id: string | null };

const EMPTY: Snapshot = { sessions: [], selectedId: null };

let current: Snapshot = EMPTY;
let installed = false;
/** 安装代数。teardown / 测试 reset 时自增——异步 listen 注册完成时
 *  若代数已翻（期间拆过又重装），旧代监听立即自拆，不叠加第二份。 */
let installGen = 0;
/** media:sessions 事件监听的反注册句柄（此前 listen 返回的 UnlistenFn
 *  被丢弃，监听装上后永远无法移除）。 */
let unlistenEvent: (() => void) | null = null;
let reviewTimer = 0;
let onVisibility: (() => void) | null = null;
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

function applyPage(page: PagePayload | null | undefined) {
  if (!page) return;
  const next = page.sessions ?? [];
  const selectedId = page.selected_id ?? null;
  if (sameSessions(current.sessions, next) && current.selectedId === selectedId) return;
  current = { sessions: next, selectedId };
  notify();
}

function pull(): void {
  if (!isTauri()) return;
  void invoke<PagePayload | null>("get_media_sessions_page")
    .then(applyPage)
    .catch(() => {});
}

function ensureInstalled() {
  if (installed || !isTauri()) return;
  installed = true;
  const gen = ++installGen;
  pull();
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<PagePayload | null>("media:sessions", (e) => applyPage(e.payload)))
    .then((un) => {
      // 异步注册完成时安装代数已翻（teardown/reset 后重装）→ 旧代
      // 监听立即反注册；同代才持有句柄供 teardown 调用。
      if (gen !== installGen) {
        un();
        return;
      }
      unlistenEvent = un;
    })
    .catch(() => {
      // 事件链路缺失：30s 兜底复核仍在。
    });
  // 兜底复核：事件线程异常（panic 退避中/事件丢失）时最长 30s 自愈；隐藏
  // 期间跳过，恢复可见立即拉一次（比旧轮询的 3s 陈旧更紧）。定时器与
  // visibilitychange 的移除句柄由模块持有（见 teardownMediaSessions）。
  const review = () => {
    if (!document.hidden && listeners.size > 0) pull();
  };
  onVisibility = review;
  reviewTimer = window.setInterval(review, 30_000);
  document.addEventListener("visibilitychange", review);
}

/** 拆除模块单例的全部常驻监听（media:sessions 事件监听 + 30s 复核
 *  interval + visibilitychange）。此前 listen 的 UnlistenFn 被丢弃、两个
 *  DOM 层监听永不移除——测试 reset 后再订阅会叠加第二份 interval 与
 *  visibilitychange。幂等；拆完 installed=false，下次订阅按需重装。
 *  生产路径如需随窗口生命周期整体卸载也走本入口。 */
export function teardownMediaSessions(): void {
  installGen++;
  if (reviewTimer) {
    window.clearInterval(reviewTimer);
    reviewTimer = 0;
  }
  if (onVisibility) {
    document.removeEventListener("visibilitychange", onVisibility);
    onVisibility = null;
  }
  if (unlistenEvent) {
    unlistenEvent();
    unlistenEvent = null;
  }
  installed = false;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureInstalled();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Snapshot {
  return current;
}

/** 测试专用：重置模块级单例（清状态 + 拆旧监听/定时器），保证用例隔离。
 *  必须先拆旧监听再允许重订阅——此前只翻转 installed 标志，下一用例
 *  的首个订阅者会再装一套 interval/visibilitychange/事件监听（逐用例叠加）。 */
export function __resetMediaSessionsForTest(): void {
  teardownMediaSessions();
  current = EMPTY;
  listeners.clear();
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
  return active ? snap : EMPTY;
}
