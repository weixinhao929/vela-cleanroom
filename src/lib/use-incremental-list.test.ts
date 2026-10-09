import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIncrementalList } from "./use-incremental-list";

/** 构造 n 个可辨识元素。 */
const mk = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("useIncrementalList", () => {
  it("总数不超过首屏窗口时返回原数组引用（零介入）", () => {
    const src = mk(10);
    const { result } = renderHook(() => useIncrementalList(src, { initial: 40 }));
    expect(result.current.items).toBe(src);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.remaining).toBe(0);
  });

  it("超出窗口时只返回首屏条数并报告剩余量", () => {
    const { result } = renderHook(() => useIncrementalList(mk(100), { initial: 30, step: 30 }));
    expect(result.current.items).toHaveLength(30);
    expect(result.current.items[29]).toBe(29);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.remaining).toBe(70);
  });

  it("loadMore 按 step 扩容且不越界", () => {
    const { result } = renderHook(() => useIncrementalList(mk(70), { initial: 30, step: 30 }));
    act(() => result.current.loadMore());
    expect(result.current.items).toHaveLength(60);
    act(() => result.current.loadMore());
    expect(result.current.items).toHaveLength(70);
    expect(result.current.hasMore).toBe(false);
    // 已到底再调用不应改变任何东西。
    act(() => result.current.loadMore());
    expect(result.current.items).toHaveLength(70);
  });

  it("总数减小时窗口只钳制不回缩（删除不闪列表）", () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: number[] }) => useIncrementalList(data, { initial: 20, step: 20 }),
      { initialProps: { data: mk(200) } }
    );
    act(() => result.current.loadMore());
    expect(result.current.items).toHaveLength(40);

    // 三轮：模拟删除条目后总数变小——已扩容的窗口保持，不回缩回首屏
    //（此前任何 total 变化都重置，已滚动的长列表删一条就视觉上「闪一下」）。
    rerender({ data: mk(120) });
    expect(result.current.items).toHaveLength(40);
    expect(result.current.remaining).toBe(80);

    // 总数跌破窗口时钳到总数（不悬挂空窗口）。
    rerender({ data: mk(10) });
    expect(result.current.items).toHaveLength(10);
    expect(result.current.remaining).toBe(0);
    expect(result.current.hasMore).toBe(false);
  });

  it("总数增大（切换筛选）时窗口重置回首屏", () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: number[] }) => useIncrementalList(data, { initial: 20, step: 20 }),
      { initialProps: { data: mk(200) } }
    );
    act(() => result.current.loadMore());
    expect(result.current.items).toHaveLength(40);

    rerender({ data: mk(300) });
    expect(result.current.items).toHaveLength(20);
    expect(result.current.remaining).toBe(280);
  });

  it("滚动到底部附近时自动扩容", () => {
    const { result } = renderHook(() => useIncrementalList(mk(100), { initial: 30, step: 30, threshold: 100 }));

    // 构造一个可滚动容器：scrollHeight 远大于 clientHeight。
    const el = document.createElement("div");
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 3000, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
    act(() => result.current.scrollRef(el));

    // 未接近底部：不扩容。
    act(() => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.items).toHaveLength(30);

    // 接近底部（3000 - 300 - 100 = 2600）：扩容一次。
    act(() => {
      el.scrollTop = 2650;
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.items).toHaveLength(60);
  });

  it("容器高于首屏内容时自动补齐（无需滚动）", () => {
    const { result } = renderHook(() => useIncrementalList(mk(100), { initial: 30, step: 30, threshold: 100 }));
    const el = document.createElement("div");
    // scrollHeight 未超过 clientHeight + threshold → 说明首屏没填满。
    Object.defineProperty(el, "clientHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
    act(() => result.current.scrollRef(el));
    expect(result.current.items.length).toBeGreaterThan(30);
  });
});
