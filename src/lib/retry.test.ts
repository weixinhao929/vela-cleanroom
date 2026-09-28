import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, defaultIsRetryable, sleep, withRetry } from "./retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first successful result without waiting", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue("recovered");
    const promise = withRetry(fn, { baseMs: 100 });
    // Advance through the two backoff windows (with jitter handled via
    // running all pending timers).
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    const promise = withRetry(fn, { retries: 2, baseMs: 50 });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx HttpError", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(404, "https://x.test"));
    await expect(withRetry(fn)).rejects.toThrow("HTTP 404");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx and 429 HttpError", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, "https://x.test"))
      .mockRejectedValueOnce(new HttpError(429, "https://x.test"))
      .mockResolvedValue("back");
    const promise = withRetry(fn, { baseMs: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("back");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects a custom isRetryable predicate", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("custom nope"));
    await expect(withRetry(fn, { isRetryable: (e) => !(e instanceof TypeError) })).rejects.toThrow("custom nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the abort signal fires", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("flaky"));
    const promise = withRetry(fn, { baseMs: 5000, signal: controller.signal });
    promise.catch(() => {});
    // Trigger the abort while the backoff sleep is pending.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the attempt index to the callback", async () => {
    const seen: number[] = [];
    const fn = vi.fn().mockImplementation(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 2) throw new Error("again");
      return "done";
    });
    const promise = withRetry(fn, { baseMs: 1 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("done");
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("sleep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves after the delay", async () => {
    let resolved = false;
    const p = sleep(1000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    await expect(sleep(10, c.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("defaultIsRetryable", () => {
  it("treats 4xx as final and everything else as retryable", () => {
    expect(defaultIsRetryable(new HttpError(400, "u"))).toBe(false);
    expect(defaultIsRetryable(new HttpError(404, "u"))).toBe(false);
    expect(defaultIsRetryable(new HttpError(500, "u"))).toBe(true);
    expect(defaultIsRetryable(new Error("timeout"))).toBe(true);
    expect(defaultIsRetryable(undefined)).toBe(true);
  });
});
