import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useInvalidationSignal } from "./use-invalidation-signal";

/**
 * C-9：失效信号 hook 的行为守卫——signals 引用变化即重跑、其余闭包值取
 * 最新快照、cleanup 语义与 useEffect 一致。
 */
describe("useInvalidationSignal", () => {
  it("挂载即执行一次；signal 引用不变不重跑", () => {
    const run = vi.fn();
    const sig = { rev: 1 };
    const { rerender } = renderHook(() => useInvalidationSignal([sig], run));
    expect(run).toHaveBeenCalledTimes(1);
    rerender();
    rerender();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("signal 引用变化即重跑（其余闭包值取最新快照）", () => {
    let snapshot = "a";
    const seen: string[] = [];
    let sig = { rev: 1 };
    const { rerender } = renderHook(() => useInvalidationSignal([sig], () => void seen.push(snapshot)));
    expect(seen).toEqual(["a"]);
    snapshot = "b"; // 闭包值变了但 signal 没变：不重跑（旧值继续用）
    rerender();
    expect(seen).toEqual(["a"]);
    sig = { rev: 2 }; // signal 变了：重跑，读到最新闭包快照
    rerender();
    expect(seen).toEqual(["a", "b"]);
  });

  it("cleanup 在下一拍与卸载时执行（与 useEffect 同语义）", () => {
    const cleanups: number[] = [];
    let sig = 1;
    const { rerender, unmount } = renderHook(() =>
      useInvalidationSignal([sig], () => {
        const id = sig;
        return () => void cleanups.push(id);
      })
    );
    sig = 2;
    rerender();
    expect(cleanups).toEqual([1]);
    unmount();
    expect(cleanups).toEqual([1, 2]);
  });
});
