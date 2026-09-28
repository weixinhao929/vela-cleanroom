/**
 * 离线感知与自动暂停（S3）。
 *
 * 问题：天气、邮件、更新检查这些联网小组件在断网时会照常按定时器发起
 * 请求，每次都要走完超时 + 2 次重试退避（约 10s + 0.8s + 1.6s）才失败。
 * 笔记本合盖、切换 WiFi、坐地铁这类常见场景下，这些注定失败的请求纯粹
 * 浪费电量，还会在界面上反复闪错误态。
 *
 * 方案：以 `navigator.onLine` 为基础信号，配合 online/offline 事件广播
 * 给所有订阅者。联网组件在离线期间跳过轮询，恢复联网时立即补一次请求。
 *
 * 关于 `navigator.onLine` 的可靠性：它为 false 时**一定**没有网络（可靠的
 * 否定信号）；为 true 时只能说明有链路层连接，不保证能访问外网（不可靠的
 * 肯定信号）。因此这里只用它做"跳过必然失败的请求"，绝不用它判断"一定能
 * 成功" —— 实际请求仍然保留完整的错误处理与重试。
 */

import { useSyncExternalStore } from "react";

type Listener = (online: boolean) => void;

const listeners = new Set<Listener>();

/**
 * 读取当前联网状态（同步快照）。
 *
 * @returns true 表示有链路层连接。注意语义边界：false 时**一定**离线
 *          （可靠的否定信号）；true 不保证外网可达，实际请求仍需完整错误处理。
 * @throws 无；SSR/非浏览器环境保守返回 true。
 *
 * @example
 * ```ts
 * if (!isOnline()) return; // 跳过注定失败的轮询
 * ```
 */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  // navigator.onLine 在部分环境下可能是 undefined，此时同样保守视为在线。
  return navigator.onLine !== false;
}

function emit(online: boolean): void {
  // 复制一份再遍历：回调里可能会取消订阅，直接遍历 Set 会漏项。
  for (const fn of [...listeners]) {
    try {
      fn(online);
    } catch (err) {
      // 单个订阅者出错不应影响其他订阅者。
      console.error("[online-status] listener failed", err);
    }
  }
}

let installed = false;

/** 惰性安装全局监听：只在第一个订阅者出现时挂载。 */
function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("online", () => emit(true));
  window.addEventListener("offline", () => emit(false));
}

/**
 * 订阅联网状态变化（发布/订阅模式）。
 * 回调只在**状态发生变化**时触发，订阅时不立即调用——当前状态用
 * {@link isOnline} 读取。首个订阅者出现时惰性安装全局监听。
 *
 * @param fn - 状态变化回调，入参为最新联网状态。
 * @returns 取消订阅函数（幂等）。
 * @throws 无；单个回调异常被捕获记录，不影响其它订阅者。
 *
 * @example
 * ```ts
 * const off = subscribeOnline((online) => online && refresh());
 * // 组件卸载时：
 * off();
 * ```
 */
export function subscribeOnline(fn: Listener): () => void {
  install();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 仅测试使用：重置内部状态。 */
export function __resetOnlineStatusForTests(): void {
  listeners.clear();
}

/**
 * React hook：订阅联网状态（外部存储订阅模式）。
 * 用 `useSyncExternalStore` 保证读取与订阅的一致性，天然兼容并发渲染
 * （useState+effect 组合在首渲与 effect 之间有读到过期值的窗口期）。
 *
 * @returns 当前是否联网；状态变化触发重渲。
 * @throws 无。
 *
 * @example
 * ```tsx
 * const online = useOnline();
 * return <span>{online ? "已联网" : "离线中"}</span>;
 * ```
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => subscribeOnline(() => onChange()),
    isOnline,
    // 服务端/无 navigator 环境的快照：保守视为在线。
    () => true
  );
}

/**
 * 等待网络恢复；已在线时立即 resolve。
 * 用于「离线不轮询、恢复后补一次」场景，比定时探测省电。
 *
 * @param signal - 可选中止信号（组件卸载时取消等待）。
 * @returns 联网恢复后 resolve 的 Promise。
 * @throws signal 已中止或等待期间被中止时抛 AbortError。
 *
 * @example
 * ```ts
 * await waitForOnline(controller.signal);
 * void refreshWeather();
 * ```
 */
export function waitForOnline(signal?: AbortSignal): Promise<void> {
  if (isOnline()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const done = () => {
      unsub();
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      unsub();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const unsub = subscribeOnline((online) => {
      if (online) done();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
