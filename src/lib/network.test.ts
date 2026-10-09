import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, formatByteRate, formatBytesTotal, formatRateStyled, mbpsToBps } from "./network";
import { isAbortError } from "./retry";

describe("formatByteRate", () => {
  it("formats bytes-per-second into B/s / KB/s / MB/s", () => {
    expect(formatByteRate(0)).toBe("0 B/s");
    expect(formatByteRate(512)).toBe("512 B/s");
    expect(formatByteRate(1024)).toBe("1.0 KB/s");
    expect(formatByteRate(2048)).toBe("2.0 KB/s");
    expect(formatByteRate(1024 * 1024)).toBe("1.00 MB/s");
    expect(formatByteRate(5 * 1024 * 1024)).toBe("5.00 MB/s");
  });

  it("guards non-finite and negative input", () => {
    expect(formatByteRate(NaN)).toBe("0 B/s");
    expect(formatByteRate(Infinity)).toBe("0 B/s");
    expect(formatByteRate(-5)).toBe("0 B/s");
  });

  it("is invariant to the legacy kbit-vs-kbyte confusion", () => {
    // 8 Mbit/s = 1 MB/s. A raw byte counter of 1_048_576 B/s must show ~1 MB/s,
    // never ~8 MB/s (the old bug misread kbit as kbyte).
    expect(formatByteRate(8 * 1024 * 1024)).toBe("8.00 MB/s");
    expect(formatByteRate(1 * 1024 * 1024)).toBe("1.00 MB/s");
  });
});

describe("mbpsToBps", () => {
  it("converts megabits to bytes", () => {
    expect(mbpsToBps(1)).toBe(125_000);
    expect(mbpsToBps(100)).toBe(12_500_000);
  });
});

describe("fetchWithTimeout 取消信号合并", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("外部 signal 已取消时不发起请求", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const ac = new AbortController();
    ac.abort();
    await expect(fetchWithTimeout("https://example.com", { signal: ac.signal })).rejects.toSatisfy(isAbortError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("外部 signal 中止在途请求（历史缺陷：外部 signal 被内部超时 signal 覆盖）", async () => {
    // 模拟一个永不 resolve 的请求，只响应 signal 的 abort 事件。
    vi.stubGlobal(
      "fetch",
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    const ac = new AbortController();
    const p = fetchWithTimeout("https://example.com", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it("请求正常完成时传递响应并保留其他 init 字段", async () => {
    const received: RequestInit[] = [];
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      if (init) received.push(init);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    const ac = new AbortController();
    const res = await fetchWithTimeout("https://example.com", { method: "HEAD", signal: ac.signal });
    expect(res.status).toBe(200);
    expect(received[0]?.method).toBe("HEAD");
    // 内部 controller 的 signal 才是最终传给 fetch 的那个（合并结果）。
    expect(received[0]?.signal).not.toBe(ac.signal);
  });
});
describe("formatRateStyled（W-167 全局显示选项）", () => {
  it("默认口径与 formatByteRate 一致", () => {
    expect(formatRateStyled(0)).toBe("0 B/s");
    expect(formatRateStyled(1024)).toBe("1.0 KB/s");
    expect(formatRateStyled(1024 * 1024)).toBe("1.00 MB/s");
  });

  it("bits：值 ×8、十进制档位、单位换 bps（与测速结果的 Mbps 口径一致）", () => {
    expect(formatRateStyled(1024, { bits: true })).toBe("8.2 Kbps"); // 8192 bit ÷ 1000
    expect(formatRateStyled(500, { bits: true })).toBe("4.0 Kbps"); // 4000 bit ÷ 1000
    // 1 Mbps = 125 000 B/s：应显示 1.00 Mbps，而不是二进制档的 976.6 Kbps。
    expect(formatRateStyled(125_000, { bits: true })).toBe("1.00 Mbps");
    expect(formatRateStyled(125, { bits: true })).toBe("1.0 Kbps");
  });

  it("compact：档位字母紧跟数字、省略 /s", () => {
    expect(formatRateStyled(1024 * 1024, { compact: true })).toBe("1.0M");
    expect(formatRateStyled(2048, { compact: true })).toBe("2.0K");
    expect(formatRateStyled(512, { compact: true })).toBe("512B");
  });

  it("hideUnit：仅数字", () => {
    expect(formatRateStyled(2048, { hideUnit: true })).toBe("2.0");
  });

  it("非有限/负值按 0 处理", () => {
    expect(formatRateStyled(NaN, { bits: true })).toBe("0 bps");
    expect(formatRateStyled(-1, { compact: true })).toBe("0B");
  });
});

describe("formatBytesTotal（W-153 流量统计）", () => {
  it("按 B/KB/MB/GB 分档", () => {
    expect(formatBytesTotal(0)).toBe("0 B");
    expect(formatBytesTotal(512)).toBe("512 B");
    expect(formatBytesTotal(2048)).toBe("2.0 KB");
    expect(formatBytesTotal(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytesTotal(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
  });

  it("非有限/负值按 0 处理", () => {
    expect(formatBytesTotal(NaN)).toBe("0 B");
    expect(formatBytesTotal(-1024)).toBe("0 B");
  });
});
