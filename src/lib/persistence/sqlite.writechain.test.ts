import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tauri", () => ({ invoke: vi.fn(async () => null), isTauri: () => true }));

import { enqueueWrite } from "./sqlite";

/**
 * 写链超时语义（+ 对账闭环）：
 *  - 单笔挂起超 60s 时队列放行，后续写照常执行（不被挂死的 IPC 永久堵住）；
 *  - 调用方拿到的是原写的真实落定结果，不再被超时提前 reject——此前超时即
 *    报失败，store 的 persist-first 动作在 catch 里按失败处理，而 Rust 侧迟到
 *    成功时内存那一步永远不执行，内存与 DB 静默分叉直到重启。
 */
describe("enqueueWrite 超时", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("超时只放行队列：后续写执行，超时的那笔仍把迟到结果交给调用方", async () => {
    let resolveFirst!: (v: string) => void;
    const first = enqueueWrite(() => new Promise<string>((res) => (resolveFirst = res)));
    const secondRan = vi.fn();
    const second = enqueueWrite(async () => {
      secondRan();
      return "second";
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(secondRan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(secondRan).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe("second");

    let firstSettled = false;
    void first.then(
      () => (firstSettled = true),
      () => (firstSettled = true)
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(firstSettled).toBe(false); // 超时不再 reject 调用方

    resolveFirst("late");
    await expect(first).resolves.toBe("late");
  });

  it("超时后迟到失败照常传给调用方；未超时的写按序执行", async () => {
    let rejectFirst!: (e: Error) => void;
    const first = enqueueWrite(() => new Promise<string>((_, rej) => (rejectFirst = rej)));
    const order: string[] = [];
    const second = enqueueWrite(async () => {
      order.push("second");
    });
    const third = enqueueWrite(async () => {
      order.push("third");
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
    const failure = expect(first).rejects.toThrow("rust failed late");
    rejectFirst(new Error("rust failed late"));
    await failure;
  });
});
