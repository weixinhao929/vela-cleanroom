import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 长列表增量渲染（P1）。
 *
 * 为什么不用「固定行高虚拟滚动」：便签 / 书签的行高是内容驱动的（正文
 * 可换行、Markdown 渲染、编辑态会展开 textarea），固定行高方案会算错
 * 偏移导致跳动，而测量式虚拟滚动在这种小容器里收益远小于复杂度。
 *
 * 这里采用「窗口只增不减 + 滚到底再扩」的增量策略：
 *  - 首屏只挂载 `initial` 条，DOM 节点数与首帧布局成本直接下降。
 *  - 滚动接近底部时按 `step` 扩容，用户感知是"一直都在"。
 *  - 已挂载的行配合 CSS `content-visibility: auto` 让浏览器跳过屏外行的
 *    渲染与布局，等价于原生虚拟化，且不会破坏 Ctrl+F / 无障碍焦点顺序。
 *  - 列表长度增大/筛选条件变化时窗口重置回 `initial`，避免筛选后仍挂着上万行；
 *    总数减小时仅钳制不回缩（删除不应引发已展开列表的视觉跳变）。
 *
 * 当总数不超过 `initial` 时完全不介入（返回原数组引用），零额外开销。
 */
export interface IncrementalListOptions {
  /** 首屏挂载条数。 */
  initial?: number;
  /** 每次扩容的条数。 */
  step?: number;
  /** 距底部多少像素时触发扩容。 */
  threshold?: number;
}

export interface IncrementalList<T> {
  /** 当前应渲染的子集（未超阈值时即原数组）。 */
  items: T[];
  /** 挂到滚动容器上的 ref。 */
  scrollRef: (node: HTMLElement | null) => void;
  /** 是否还有未挂载的行。 */
  hasMore: boolean;
  /** 剩余未挂载条数，可用于展示"还有 N 条"。 */
  remaining: number;
  /** 手动扩容一次（例如点击"加载更多"按钮）。 */
  loadMore: () => void;
}

/**
 * 长列表增量渲染 hook（P1，「窗口只增不减 + 滚到底再扩」策略）。
 *
 * 为什么不用固定行高虚拟滚动：便签/书签的行高是内容驱动的（换行、Markdown、
 * 编辑态展开），测量式方案复杂度远超收益。本实现首屏只挂 `initial` 条，
 * 接近底部按 `step` 扩容；已挂载行配合 CSS `content-visibility:auto` 跳过
 * 屏外渲染，不破坏 Ctrl+F 与无障碍焦点顺序。列表长度变化时窗口重置回
 * `initial`。总数不超过 `initial` 时零介入（返回原数组引用）。
 *
 * @typeParam T - 列表元素类型。
 * @param source - 完整数据数组（已排序/筛选后的最终顺序）。
 * @param opts - `initial` 首屏条数（默认 40）、`step` 扩容步长（默认 40）、
 *                `threshold` 距底部触发扩容的像素（默认 240）。
 * @returns {@link IncrementalList}：子集 items + 滚动容器 ref + 扩容控制。
 * @throws 无。
 *
 * @example
 * ```tsx
 * const { items, scrollRef, remaining } = useIncrementalList(notes, { initial: 30 });
 * <div ref={scrollRef}>{items.map(renderRow)}{remaining > 0 && <button onClick={loadMore}>…</button>}</div>
 * ```
 */
export function useIncrementalList<T>(
  source: T[],
  { initial = 40, step = 40, threshold = 240 }: IncrementalListOptions = {}
): IncrementalList<T> {
  const [limit, setLimit] = useState(initial);
  const nodeRef = useRef<HTMLElement | null>(null);
  const total = source.length;

  // 列表规模变化时的窗口策略（P2 三轮细分）：
  //  - 总数减少（删一条便签/书签、条目完成）：只把已扩容窗口钳到新总数，
  //    不回缩——此前任何 total 变化都重置回 initial，已滚动扩容到几百条的
  //    列表删一条就瞬间卸载大半（滚动位置被 clamp，视觉上「列表闪一下」）。
  //  - 总数增大（切换筛选 / 新增）：回首屏窗口，避免筛选后仍挂着上万行。
  // 依赖 total 而非数组引用：仅内容原地更新时不该重置用户已展开的窗口。
  const prevTotal = useRef(total);
  useEffect(() => {
    if (total < prevTotal.current) {
      setLimit((n) => Math.min(n, total));
    } else if (total > prevTotal.current) {
      setLimit(initial);
    }
    prevTotal.current = total;
  }, [total, initial]);

  const loadMore = useCallback(() => {
    setLimit((n) => (n >= total ? n : Math.min(total, n + step)));
  }, [total, step]);

  // 滚动监听只在确实超出窗口时挂载，短列表不产生任何事件开销。
  const onScroll = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) loadMore();
  }, [loadMore, threshold]);

  /** 容器比首屏内容还高时（大尺寸小组件 / 稀疏筛选结果）主动补齐，否则永远等不到滚动事件。 */
  const maybeFill = useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + threshold) loadMore();
  }, [loadMore, threshold]);

  // P2（审计修复）：scroll 监听只由本 effect 一处挂/卸载。此前回调 ref 与
  // effect 各挂一次（同一闭包挂两遍 → loadMore 双触发）；且回调 ref 里用
  // 当前闭包 removeEventListener，摘不掉历史闭包的监听，ref 身份变化
  // detach/reattach 后旧监听残留到节点销毁。
  const [nodeVer, setNodeVer] = useState(0);
  const scrollRef = useCallback(
    (node: HTMLElement | null) => {
      const prev = nodeRef.current;
      nodeRef.current = node;
      if ((prev ?? null) !== (node ?? null)) setNodeVer((v) => v + 1);
      // 容器比首屏内容还高时（大尺寸小组件 / 稀疏筛选结果）主动补齐，
      // 否则永远等不到滚动事件；ref 回调可能晚于本轮 effect（测试环境 /
      // 条件渲染），这里补一次检查。loadMore 用函数式 setState，幂等安全。
      if (node) maybeFill();
    },
    [maybeFill]
  );
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [onScroll, nodeVer]);

  // 窗口/总数变化后再检查一次：扩容后若仍未填满容器，继续补齐直到出现滚动条。
  useEffect(() => {
    if (limit >= total) return;
    maybeFill();
  }, [limit, total, maybeFill]);

  const items = useMemo(() => (total <= limit ? source : source.slice(0, limit)), [source, total, limit]);

  return {
    items,
    scrollRef,
    hasMore: limit < total,
    remaining: Math.max(0, total - limit),
    loadMore
  };
}
