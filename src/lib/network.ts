import { useSettingsStore } from "../store/settings-store";
import { HttpError, withRetry } from "./retry";
import { invoke, isTauri } from "./tauri";

/**
 * Shared network helpers for online widgets.
 *
 * - fetchWithTimeout wraps `fetch` with the user-configured network timeout
 *   (设置 → 连接 → 网络超时) and aborts the request when it elapses.
 * - fetchJson adds unified retry (exponential backoff, 4xx = no retry) so all
 *   online widgets share one resilience policy instead of ad-hoc catch blocks.
 * - geocodeCity resolves a human-readable city name to lat/lon via Open-Meteo
 *   (free, no API key), so the "位置" section of the connection settings can
 *   actually convert a typed city into coordinates.
 */

export type GeoResult = { lat: number; lon: number; name: string };

/** Current network timeout in ms from the settings store. */
function currentTimeoutMs(): number {
  const t = useSettingsStore.getState().extra.networkTimeout;
  const clamped = Math.max(3, Math.min(60, t));
  return clamped * 1000;
}

/**
 * 带超时的 fetch：超时上限读设置（3~60s，默认见 settings-store）。
 * 调用方 `init.signal` 与内部超时 signal **合并**而非覆盖（早期实现覆盖
 * 外部 signal 导致组件卸载后请求继续跑完，是天气旧响应覆盖新城市的根因）。
 *
 * @param input - fetch 的资源描述符（URL 或 Request）。
 * @param init - 标准 fetch 初始化参数；`signal` 会被合并非破坏性传递。
 * @returns fetch Response。
 * @throws 超时或外部中止抛 AbortError；网络失败原样抛。
 *
 * @example
 * ```ts
 * const res = await fetchWithTimeout(url, { signal: controller.signal });
 * ```
 */
export async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const external = init?.signal ?? null;
  // 外部已取消则无需发起请求。
  if (external?.aborted) throw new DOMException("Aborted", "AbortError");

  const timeoutMs = currentTimeoutMs();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * GET + JSON 解析，统一走指数退避重试（网络错误/超时/5xx/429 重试；
 * 4xx 立即抛 HttpError）。所有联网小组件共享这一套韧性策略。
 *
 * @typeParam T - 期望的 JSON 结构类型。
 * @param url - 目标 URL。
 * @param opts - `retries` 最大重试次数（默认 2）；`signal` 取消信号。
 * @returns 反序列化后的 JSON。
 * @throws 重试耗尽抛最后一次错误（HttpError / AbortError / 网络错误）。
 *
 * @example
 * ```ts
 * const data = await fetchJson<WeatherResp>(apiUrl, { signal });
 * ```
 */
export async function fetchJson<T>(url: string, opts?: { retries?: number; signal?: AbortSignal }): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(url, opts?.signal ? { signal: opts.signal } : undefined);
      if (!res.ok) throw new HttpError(res.status, url);
      return (await res.json()) as T;
    },
    { retries: opts?.retries ?? 2, signal: opts?.signal }
  );
}

/**
 * 城市名 → 经纬度（Open-Meteo 免费地理编码，无需 API key）。
 * 使用场景：连接设置的「位置」区把输入城市转成天气坐标。
 *
 * @param query - 人类可读的城市名（中文/英文均可）。
 * @returns 首个匹配结果；无匹配或网络失败返回 null（调用方提示重试）。
 * @throws 无。
 *
 * @example
 * ```ts
 * const geo = await geocodeCity("上海"); // { lat: 31.2, lon: 121.5, name: "上海" } | null
 * ```
 */
export async function geocodeCity(query: string): Promise<GeoResult | null> {
  const q = query.trim();
  if (!q) return null;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=zh&format=json`;
  try {
    const data = await fetchJson<{ results?: Array<{ latitude: number; longitude: number; name?: string }> }>(url, {
      retries: 1
    });
    const hit = data?.results?.[0];
    if (!hit) return null;
    return { lat: hit.latitude, lon: hit.longitude, name: hit.name || q };
  } catch {
    return null;
  }
}

/**
 * 读取设备地理定位（需用户授权）。
 *
 * @returns 经纬度；不支持/拒绝授权/8s 超时返回 null（不抛错）。
 * @throws 无。
 */
export function getCurrentPosition(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

export type Connectivity = {
  online: boolean;
  latencyMs: number | null;
};

/**
 * Tests whether the app can reach the public internet. Returns the measured
 * latency in ms (or null on failure). Browsers only report a coarse online
 * flag, so we also probe lightweight endpoints to get real latency.
 * 多候选源：gstatic / 微软 / 小米连通性检测，任一可达即判定在线；
 * 全部被拦（企业代理/防火墙）时再由 Rust 侧直连兜底一次。
 */
const CONNECTIVITY_PROBES = [
  "https://www.gstatic.com/generate_204",
  "https://www.msftconnecttest.com/connecttest.txt",
  "https://connect.rom.miui.com/generate_204"
];

/**
 * 探测公网连通性并测量延迟。
 * 策略：navigator.onLine 为 false 直接判离线；否则依次探测 gstatic/微软/
 * 小米三个 generate_204 轻量端点（任一可达即在线）；全部被企业代理拦截时
 * 桌面端再由 Rust 直连兜底一次。
 *
 * @returns `online` 判定与实测延迟毫秒（失败为 null）。
 * @throws 无。
 *
 * @example
 * ```ts
 * const { online, latencyMs } = await testConnectivity();
 * ```
 */
export async function testConnectivity(): Promise<Connectivity> {
  const navigatorOnline = typeof navigator !== "undefined" && navigator.onLine;
  if (!navigatorOnline) return { online: false, latencyMs: null };
  for (const url of CONNECTIVITY_PROBES) {
    const started = performance.now();
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return { online: true, latencyMs: Math.round(performance.now() - started) };
    } catch {
      // 换下一个探测源
    }
  }
  if (isTauri()) {
    const started = performance.now();
    try {
      await invoke<[number, number]>("net_speed_probe", { url: CONNECTIVITY_PROBES[1], maxBytes: 4096 });
      return { online: true, latencyMs: Math.round(performance.now() - started) };
    } catch {
      // fall through
    }
  }
  return { online: false, latencyMs: null };
}

export type SpeedSample = {
  /** Bytes received in this sample window. */
  bytes: number;
  /** Sample window duration in ms. */
  ms: number;
};

export type SpeedResult = {
  /** Average download speed in Mbps. */
  downloadMbps: number;
  /** Peak (max) sample speed in Mbps. */
  peakMbps: number;
  /** Valley (min non-zero) sample speed in Mbps. */
  valleyMbps: number;
  /** Total bytes downloaded. */
  bytes: number;
  /** Duration in ms. */
  durationMs: number;
  /** Per-window samples (used for live charts). */
  samples: SpeedSample[];
};

/**
 * 把字节速率格式化为 B/s / KB/s / MB/s 可读字符串。
 *
 * @param bytesPerSec - 每秒字节数（非有限数按 0 处理）。
 * @returns 形如 `"1.25 MB/s"` 的字符串。O(1)。
 */
export function formatByteRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "0 B/s";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** W-167 速率显示选项（经典网速工具式，全局设置，settings-store extra）。 */
export type RateStyle = {
  /** B/b 单位切换：按 bit 计（值 ×8，单位 bps/Kbps/Mbps）。 */
  bits?: boolean;
  /** 简洁模式：单位缩写去空格、少一位小数（如 `1.2M/s`）。 */
  compact?: boolean;
  /** 隐藏单位（仅数字）。 */
  hideUnit?: boolean;
};

const KIB = 1024;
const MIB = 1024 * 1024;

/**
 * 按全局显示选项格式化速率（W-167）：在 {@link formatByteRate} 基础上支持
 * bit 计、简洁模式与隐藏单位。非有限/负值一律按 0 处理。O(1)。
 *
 * @param bytesPerSec - 每秒字节数。
 * @param style - 显示选项（缺省为字节 + 完整单位）。
 * @returns 形如 `"1.2 MB/s"` / `"9.6Mbps"` / `"1.2M/s"` 的字符串。
 *
 * @example
 * ```ts
 * formatRateStyled(1024 * 1024, { compact: true }); // "1.0M/s"
 * formatRateStyled(1024, { bits: true });           // "8.2 Kbps"
 * ```
 */
export function formatRateStyled(bytesPerSec: number, style: RateStyle = {}): string {
  const raw = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0;
  const value = style.bits ? raw * 8 : raw;
  const compact = style.compact === true;
  const unitBase = style.bits ? "bps" : "B/s";
  let num: number;
  let tier: "K" | "M" | "";
  if (value >= MIB) {
    num = value / MIB;
    tier = "M";
  } else if (value >= KIB) {
    num = value / KIB;
    tier = "K";
  } else {
    num = value;
    tier = "";
  }
  // 基础档（未换算）恒为整数；换算档简洁模式 1 位、常规模式 MB 2 位其余 1 位。
  const digits = tier === "" ? 0 : compact ? 1 : value >= MIB ? 2 : 1;
  const text = num.toFixed(digits);
  if (style.hideUnit === true) return text;
  if (compact) {
    // 简洁模式：单位缩为档位字母、无空格、省略 /s —— 1.0M / 2.0K / 512B(b)。
    return `${text}${tier || (style.bits ? "b" : "B")}`;
  }
  // 常规模式：数字 + 空格 + 档位 + 单位 —— 1.00 MB/s / 512 B/s / 8.2 Kbps。
  return `${text} ${tier ? `${tier}${unitBase}` : unitBase}`;
}

/**
 * 把字节总量格式化为 B/KB/MB/GB 可读字符串（W-153 流量统计展示用）。
 *
 * @param bytes - 累计字节数（非有限/负值按 0 处理）。
 * @returns 形如 `"1.25 GB"` 的字符串。O(1)。
 */
export function formatBytesTotal(bytes: number): string {
  const v = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (v >= MIB) return `${(v / MIB).toFixed(1)} MB`;
  if (v >= KIB) return `${(v / KIB).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}

/** Converts a Mbps value to bytes-per-second. */
export function mbpsToBps(mbps: number): number {
  return (mbps * 1_000_000) / 8;
}

/**
 * Measures download bandwidth by streaming a known-size payload and sampling
 * the speed every ~150ms, so we can report peak / valley / average alongside
 * the total.
 *
 * 测不出结果的旧根因：只试 Cloudflare 单一测速源，且在 webview 里 fetch，
 * 被 CORS / 企业代理 / 证书拦截时直接失败。现在：
 *  1. 依次尝试多个公开测速源（Cloudflare / jsDelivr / CacheFly，均带开放 CORS）；
 *  2. 全部失败且在 Tauri 环境时，改走 Rust 侧 net_speed_probe 直连下载
 *     （无 CORS 概念），保证"设置 → 连接 → 测网速"总能给出结果。
 */
const SPEED_URLS = [
  "https://speed.cloudflare.com/__down?bytes=8000000",
  "https://cdn.jsdelivr.net/npm/typescript@5.5.4/lib/typescript.js",
  "https://cachefly.cachefly.net/10mb.test"
];

/** 由字节/毫秒组装 SpeedResult（单窗口采样时峰谷=均值）。 */
function buildSpeedResult(totalBytes: number, durationMs: number, samples: SpeedSample[]): SpeedResult {
  const toMbps = (bytes: number, ms: number) => (bytes * 8) / (ms / 1000) / 1_000_000;
  const avgMbps = toMbps(totalBytes, Math.max(1, durationMs));
  const rates = samples.map((s) => toMbps(s.bytes, s.ms)).filter((v) => v > 0);
  const peakMbps = rates.length ? Math.max(...rates) : avgMbps;
  const valleyMbps = rates.length ? Math.min(...rates) : avgMbps;
  return {
    downloadMbps: Math.round(avgMbps * 100) / 100,
    peakMbps: Math.round(peakMbps * 100) / 100,
    valleyMbps: Math.round(valleyMbps * 100) / 100,
    bytes: totalBytes,
    durationMs: Math.round(durationMs),
    samples
  };
}

/**
 * 实测下行带宽：依次尝试多个开放 CORS 测速源流式下载（~150ms 采样窗口
 * 记录峰/谷/均值）；webview 内被 CORS/企业代理拦截时桌面端回退 Rust
 * `net_speed_probe` 直连下载，保证「测网速」总能给出结果。
 *
 * @returns {@link SpeedResult}：均值/峰值/谷值 Mbps、总字节、耗时与采样序列。
 * @throws 无——所有源都失败时返回全零结果（由 Rust 兜底路径保证基本可用）。
 *
 * @example
 * ```ts
 * const r = await measureDownloadSpeed();
 * show(`${r.downloadMbps} Mbps`);
 * ```
 */
export async function measureDownloadSpeed(): Promise<SpeedResult> {
  const started = performance.now();
  let totalBytes = 0;
  let lastError: unknown;
  const samples: SpeedSample[] = [];
  let windowBytes = 0;
  let windowStart = performance.now();
  const SAMPLE_MS = 150;

  const flush = () => {
    const now = performance.now();
    const ms = now - windowStart;
    if (ms > 0 && windowBytes > 0) samples.push({ bytes: windowBytes, ms });
    windowBytes = 0;
    windowStart = now;
  };

  for (const url of SPEED_URLS) {
    // P1（审计修复）：fetchWithTimeout 的超时计时器在响应头到达时即被清除，
    // 之后 reader.read() 循环没有任何 deadline——body 中途停滞会让 Promise
    // 永不 resolve（"测网速"永久转圈），已收部分字节后停滞则静默返回失真
    // 结果。为读循环建立独立的整体 deadline，超时 abort 并计入失败换下一源。
    const readController = new AbortController();
    const READ_DEADLINE_MS = Math.max(currentTimeoutMs() * 2, 30_000);
    let readTimedOut = false;
    const readTimer = window.setTimeout(() => {
      readTimedOut = true;
      readController.abort();
    }, READ_DEADLINE_MS);
    try {
      const res = await fetchWithTimeout(url, { signal: readController.signal });
      if (!res.ok || !res.body) continue;
      // 审计修复：字节计数逐源隔离——失败源已收的部分字节不得与下一源的
      // 完整下载合并（否则结果失真且误跳过 Rust 兜底）。
      totalBytes = 0;
      samples.length = 0;
      windowBytes = 0;
      windowStart = performance.now();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          windowBytes += value.byteLength;
          if (performance.now() - windowStart >= SAMPLE_MS) flush();
        }
      }
      flush();
      break;
    } catch (e) {
      lastError = e;
      // 读循环超时：该源视为失败，重置计数后尝试下一源 / Rust 兜底。
      if (readTimedOut) {
        totalBytes = 0;
        samples.length = 0;
        windowBytes = 0;
      }
      continue;
    } finally {
      window.clearTimeout(readTimer);
    }
  }

  // webview 内全部源失败：Rust 直连兜底（无 CORS/代理拦截问题）。
  // maxBytes 取 2MB：30s 整体超时下 ≥0.5Mbps 即可完成，慢网兜底才真正可用。
  if (totalBytes === 0 && isTauri()) {
    for (const url of SPEED_URLS) {
      try {
        const [bytes, ms] = await invoke<[number, number]>("net_speed_probe", { url, maxBytes: 2_000_000 });
        if (bytes > 0 && ms >= 0) {
          return buildSpeedResult(bytes, Math.max(1, ms), [{ bytes, ms }]);
        }
      } catch (e) {
        lastError = e;
      }
    }
  }

  const durationMs = performance.now() - started;
  if (totalBytes === 0) {
    throw lastError ?? new Error("speed test failed");
  }
  return buildSpeedResult(totalBytes, durationMs, samples);
}
