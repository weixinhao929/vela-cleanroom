import { useCallback, useRef, useState } from "react";
import { useSafeTimeout } from "./use-safe-timeout";
import { animDurations } from "./durations";

/**
 * 「再次点击确认」状态机 hook（两段式确认模式）。
 *
 * 第一次 `request(id)` 进入待确认态（confirmingId 供按钮双态文案/样式），
 * confirmMs 后自动复位；确认期内对同一 id 再次 request 返回 true（调用方
 * 执行实际删除），对其它 id 调用则切换待确认目标。
 *
 * 用 ref 镜像当前确认目标：点击是离散事件且间必有重渲，但 setState updater
 * 不保证同步执行，依赖函数式更新会拿到过期值；ref 在事件回调内同步可读。
 *
 * @param confirmMs - 待确认态自动复位的时长，默认 2000ms。
 * @returns `confirmingId`：当前待确认的 id（无则 null）；`request(id)`：
 *          返回 true 表示本次点击已确认、应立即执行动作。
 * @throws 无。
 *
 * @example
 * ```tsx
 * const { confirmingId, request } = useConfirmAction();
 * <button onClick={() => request(id) && doDelete()}>
 *   {confirmingId === id ? "再点一次确认" : "删除"}
 * </button>
 * ```
 */
export function useConfirmAction(confirmMs = 2000) {
  const safeTimeout = useSafeTimeout();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmingRef = useRef<string | null>(null);
  /** 返回 true = 本次点击已确认，调用方应立即执行动作。 */
  const request = useCallback(
    (id: string): boolean => {
      if (confirmingRef.current === id) {
        confirmingRef.current = null;
        setConfirmingId(null);
        return true;
      }
      confirmingRef.current = id;
      setConfirmingId(id);
      safeTimeout(() => {
        if (confirmingRef.current !== id) return;
        confirmingRef.current = null;
        setConfirmingId(null);
      }, confirmMs);
      return false;
    },
    [confirmMs, safeTimeout]
  );
  return { confirmingId, request };
}

/**
 * 删除退场动画 hook：begin(id) 先把 id 标记为退场中（UI 据此加 is-closing
 * 类播动画），exitMs 播完后执行 commit(id) 真正移除数据并解除标记。
 *
 * commit 经 ref 持有，无需因回调身份变化而重订阅；定时器由 useSafeTimeout
 * 保证卸载时清理（不会在卸载后 commit）。
 *
 * @param commit - 真正执行数据删除的回调。
 * @param exitMs - 退场动画时长；缺省时按时长单一真源运行时派生
 *                  （`--dur-fx` + 40ms 余量：此前写死 240ms 不随
 *                  设置→动效 速度档缩放，slow 档会把收拢动画掐断）。
 * @returns `removingIds`：退场中的 id 集合；`begin(id)`：发起一次延迟删除。
 * @throws 无。
 *
 * @example
 * `tsx
 * const { removingIds, begin } = useDelayedRemoval((id) => removeNote(id));
 * <div className={removingIds.has(n.id) ? "is-closing" : ""}>…</div>
 * `
 */
export function useDelayedRemoval(commit: (id: string) => void, exitMs?: number) {
  const safeTimeout = useSafeTimeout();
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const begin = useCallback(
    (id: string) => {
      setRemovingIds((s) => new Set(s).add(id));
      // 时长在调用时刻读取：速度档变更无需重渲本组件即可生效。
      const ms = exitMs ?? animDurations().fxMs + 40;
      safeTimeout(() => {
        commitRef.current(id);
        setRemovingIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }, ms);
    },
    [exitMs, safeTimeout]
  );
  return { removingIds, begin };
}
