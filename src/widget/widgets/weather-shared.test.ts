import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * weather-shared 回归：
 *  - weatherIcon 的 WMO 映射（雾 45/48、雪阵 85/86 补入前的缺口）；
 *  - fetchJsonShared 在途合并：同 URL 只发一次、结果共享；
 *    abort 解绑——共享请求不随首个调用方中止，后加入者仍拿到数据；
 *    调用方自己的 signal 只切断自己的等待（AbortError，isAbortError 可判）。
 */
const mocks = vi.hoisted(() => ({ fetchJson: vi.fn<(url: string, opts?: unknown) => Promise<unknown>>() }));
vi.mock("../../lib/network", () => ({ fetchJson: mocks.fetchJson }));

import { CloudFog, CloudRain, Cloudy, Snowflake, Sun, Zap } from "lucide-react";
import { isAbortError } from "../../lib/retry";
import { fetchJsonShared, moodOf, weatherIcon } from "./weather-shared";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

const flush = () => Promise.resolve();

beforeEach(() => {
  mocks.fetchJson.mockReset();
  mocks.fetchJson.mockResolvedValue({});
});

describe("weatherIcon / moodOf WMO 映射", () => {
  it("晴 / 多云 / 阴 / 雨 / 雷暴主分支", () => {
    expect(weatherIcon(0)).toBe(Sun);
    expect(weatherIcon(1)).not.toBe(Sun); // 1 主晴 → CloudSun
    expect(weatherIcon(3)).toBe(Cloudy);
    expect(weatherIcon(63)).toBe(CloudRain);
    expect(weatherIcon(95)).toBe(Zap);
  });

  it("雾（45/48）→ CloudFog（此前落到 Cloud）", () => {
    expect(weatherIcon(45)).toBe(CloudFog);
    expect(weatherIcon(48)).toBe(CloudFog);
  });

  it("雪阵（85/86）→ Snowflake（此前落到 Cloud，与 mood=snow 背景不一致）", () => {
    expect(weatherIcon(85)).toBe(Snowflake);
    expect(weatherIcon(86)).toBe(Snowflake);
    expect(weatherIcon(71)).toBe(Snowflake);
    // 图标雪系与 moodOf 雪系对齐（85/86 也归 snow 背景）。
    expect(moodOf(85)).toBe("snow");
    expect(moodOf(86)).toBe("snow");
  });
});

describe("fetchJsonShared 在途合并", () => {
  it("同 URL 并发只发一次请求，结果共享；不同 URL 各自请求", async () => {
    const d = deferred<{ v: 1 }>();
    mocks.fetchJson.mockReturnValueOnce(d.p);
    const a = fetchJsonShared<{ v: 1 }>("https://x/api");
    const b = fetchJsonShared<{ v: 1 }>("https://x/api");
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
    d.resolve({ v: 1 });
    expect(await a).toEqual({ v: 1 });
    expect(await b).toEqual({ v: 1 });

    const d2 = deferred<Record<string, never>>();
    mocks.fetchJson.mockReturnValueOnce(d2.p);
    const c = fetchJsonShared("https://x/other");
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    d2.resolve({});
    await c;
  });

  it("底层请求不携带调用方 signal（abort 解绑的前提）", async () => {
    const d = deferred<Record<string, never>>();
    mocks.fetchJson.mockReturnValueOnce(d.p);
    const controller = new AbortController();
    void fetchJsonShared("https://x/api", { signal: controller.signal }).catch(() => {});
    await flush();
    expect(mocks.fetchJson.mock.calls[0][1]).not.toHaveProperty("signal");
    controller.abort();
    d.resolve({});
  });

  it("首个调用方中止不影响后加入者；被中止者拿到 AbortError", async () => {
    const d = deferred<{ v: 42 }>();
    mocks.fetchJson.mockReturnValueOnce(d.p);
    const controller = new AbortController();
    const a = fetchJsonShared<{ v: 42 }>("https://x/api", { signal: controller.signal });
    const b = fetchJsonShared<{ v: 42 }>("https://x/api");
    controller.abort();
    const errA = await a.then(
      () => {
        throw new Error("should have rejected");
      },
      (e: unknown) => e
    );
    expect(isAbortError(errA)).toBe(true);
    d.resolve({ v: 42 });
    // b 仍拿到完整结果——共享请求没有随 a 的卸载中止而作废。
    await expect(b).resolves.toEqual({ v: 42 });
    // 在途结束后的新调用重新发请求（Map 已清理）。
    mocks.fetchJson.mockResolvedValueOnce({ v: 2 });
    await expect(fetchJsonShared<{ v: 2 }>("https://x/api")).resolves.toEqual({ v: 2 });
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("已中止的 signal 直接拒绝，不发起请求", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await fetchJsonShared("https://x/api", { signal: controller.signal }).then(
      () => {
        throw new Error("should have rejected");
      },
      (e: unknown) => e
    );
    expect(isAbortError(err)).toBe(true);
    expect(mocks.fetchJson).not.toHaveBeenCalled();
  });

  it("共享请求失败：所有加入者收到同一错误，之后可重试", async () => {
    const d = deferred<never>();
    mocks.fetchJson.mockReturnValueOnce(d.p);
    const a = fetchJsonShared("https://x/fail");
    const b = fetchJsonShared("https://x/fail");
    d.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    mocks.fetchJson.mockResolvedValueOnce({ ok: true });
    await expect(fetchJsonShared("https://x/fail")).resolves.toEqual({ ok: true });
  });
});
