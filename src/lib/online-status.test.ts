import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isOnline, subscribeOnline, waitForOnline, __resetOnlineStatusForTests } from "./online-status";

/**
 * 离线感知模块测试。
 *
 * 关注四件事：
 *  1. isOnline 的保守语义：只有明确 false 才判定离线。
 *  2. 事件广播：online/offline 事件能到达所有订阅者，取消订阅后不再收到。
 *  3. 单个订阅者抛错不影响其他订阅者（避免一个坏组件拖垮全局）。
 *  4. waitForOnline 的 resolve / abort 行为。
 */

/** 覆写 navigator.onLine（原属性只读，需用 defineProperty）。 */
function setOnLine(value: boolean | undefined): void {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => value
  });
}

function fireOnline(): void {
  window.dispatchEvent(new Event("online"));
}

function fireOffline(): void {
  window.dispatchEvent(new Event("offline"));
}

describe("isOnline", () => {
  afterEach(() => {
    setOnLine(true);
  });

  it("navigator.onLine 为 true 时判定在线", () => {
    setOnLine(true);
    expect(isOnline()).toBe(true);
  });

  it("navigator.onLine 为 false 时判定离线", () => {
    setOnLine(false);
    expect(isOnline()).toBe(false);
  });

  it("navigator.onLine 为 undefined 时保守判定为在线", () => {
    // 某些环境不实现该属性，此时不应把用户误判为离线而停掉所有轮询。
    setOnLine(undefined);
    expect(isOnline()).toBe(true);
  });
});

describe("subscribeOnline", () => {
  beforeEach(() => {
    __resetOnlineStatusForTests();
    setOnLine(true);
  });

  it("offline / online 事件都能广播到订阅者", () => {
    const seen: boolean[] = [];
    subscribeOnline((online) => seen.push(online));

    fireOffline();
    fireOnline();

    expect(seen).toEqual([false, true]);
  });

  it("订阅时不会立即回调（当前状态需自行读取）", () => {
    const fn = vi.fn();
    subscribeOnline(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("取消订阅后不再收到通知", () => {
    const fn = vi.fn();
    const unsub = subscribeOnline(fn);

    fireOffline();
    expect(fn).toHaveBeenCalledTimes(1);

    unsub();
    fireOnline();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("多个订阅者都会收到同一次事件", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeOnline(a);
    subscribeOnline(b);

    fireOffline();

    expect(a).toHaveBeenCalledWith(false);
    expect(b).toHaveBeenCalledWith(false);
  });

  it("单个订阅者抛错不影响后续订阅者", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    subscribeOnline(() => {
      throw new Error("boom");
    });
    subscribeOnline(good);

    fireOffline();

    expect(good).toHaveBeenCalledWith(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("回调内取消订阅不会导致其他订阅者被漏掉", () => {
    // emit 遍历前先复制一份 Set，正是为了这个场景。
    const later = vi.fn();
    const unsubHolder: { fn?: () => void } = {};
    unsubHolder.fn = subscribeOnline(() => {
      unsubHolder.fn?.();
    });
    subscribeOnline(later);

    fireOffline();

    expect(later).toHaveBeenCalledWith(false);
  });
});

describe("waitForOnline", () => {
  beforeEach(() => {
    __resetOnlineStatusForTests();
    setOnLine(true);
  });

  afterEach(() => {
    setOnLine(true);
  });

  it("已在线时立即 resolve", async () => {
    setOnLine(true);
    await expect(waitForOnline()).resolves.toBeUndefined();
  });

  it("离线时等待，恢复联网后 resolve", async () => {
    setOnLine(false);
    const pending = waitForOnline();

    setOnLine(true);
    fireOnline();

    await expect(pending).resolves.toBeUndefined();
  });

  it("离线事件不会误触发 resolve", async () => {
    setOnLine(false);
    let settled = false;
    void waitForOnline().then(() => {
      settled = true;
    });

    fireOffline();
    await Promise.resolve();

    expect(settled).toBe(false);
  });

  it("传入已 abort 的 signal 直接 reject", async () => {
    setOnLine(false);
    const controller = new AbortController();
    controller.abort();
    await expect(waitForOnline(controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
  });

  it("等待期间 abort 会 reject 并停止订阅", async () => {
    setOnLine(false);
    const controller = new AbortController();
    const pending = waitForOnline(controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // 已 abort 的等待不应再持有订阅，否则组件卸载后仍会被唤醒。
    setOnLine(true);
    fireOnline();
  });
});
