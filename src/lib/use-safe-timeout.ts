import { useCallback, useEffect, useRef } from "react";

/**
 * 返回卸载安全的 setTimeout 包装（B-21 / D-4，资源释放模式）。
 *
 * 模块职责：退场动画/二次确认等延时回调若在组件卸载后触发会 setState
 * 泄漏告警并滞留句柄；本 hook 统一登记全部定时器并在卸载时批量清除。
 *
 * @returns `(fn, ms) => void` 的稳定调度函数（useCallback 固化，可安全
 *          写入依赖数组）。触发时先从登记表移除自身再执行 fn。
 * @throws 无；fn 内部异常不会被捕获吞掉。
 *
 * @example
 * ```tsx
 * const safeTimeout = useSafeTimeout();
 * const flash = () => setFlash(false);
 * safeTimeout(flash, 600); // 组件卸载则 flash 永不执行且句柄被清理
 * ```
 */
export function useSafeTimeout() {
  const ids = useRef<Set<number>>(new Set());

  useEffect(() => {
    const set = ids.current;
    return () => {
      set.forEach((id) => window.clearTimeout(id));
      set.clear();
    };
  }, []);

  return useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      ids.current.delete(id);
      fn();
    }, ms);
    ids.current.add(id);
  }, []);
}
