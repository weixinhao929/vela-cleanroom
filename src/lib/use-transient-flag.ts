import { useEffect, useRef, useState } from "react";
import { useSafeTimeout } from "./use-safe-timeout";

/**
 * 「依赖变化 → 置位脉冲标志 → ms 后自动清除」的状态机 hook。
 *
 * 替代各处手写的 prevRef + useState + useEffect + safeTimeout 四件套。
 * 首次挂载视为无变化，不触发；与原手写版本的初值语义一致。
 *
 * @param dep - 被观察的依赖值（用 Object.is 判等）。
 * @param ms - 标志保持 true 的时长毫秒数。
 * @param mode - `"change"`：依赖每次变化都触发；`"rise"`：仅布尔依赖
 *                false→true 时触发（回落只静默重置基准，再升起可再触发）。
 * @returns 当前脉冲标志；true 持续 ms 后自动回落 false。
 * @throws 无。
 *
 * @example
 * ```tsx
 * const flash = useTransientFlag(count, 600);            // 变化即闪 600ms
 * const opened = useTransientFlag(isOpen, 300, "rise"); // 仅打开瞬间触发入场动画
 * ```
 */
export function useTransientFlag(dep: unknown, ms: number, mode: "change" | "rise" = "change"): boolean {
  const safeTimeout = useSafeTimeout();
  const [on, setOn] = useState(false);
  const prevRef = useRef(dep);
  useEffect(() => {
    const changed = !Object.is(prevRef.current, dep);
    prevRef.current = dep;
    if (!changed) return;
    if (mode === "rise" && dep !== true) return;
    setOn(true);
    safeTimeout(() => setOn(false), ms);
  }, [dep, ms, mode, safeTimeout]);
  return on;
}
