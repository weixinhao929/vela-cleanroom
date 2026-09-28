/**
 * 统一重试工具：指数退避 + 抖动，用于网络请求和偶发失败的 Tauri 命令。
 *
 * 规则：
 * - 默认重试 2 次（共 3 次尝试），首次退避 800ms，指数增长，上限 8s。
 * - 4xx 类错误（客户端问题）不重试，立即抛出；5xx / 网络错误 / 超时可重试。
 * - AbortSignal 中止等待并立即失败（页面卸载/组件销毁时不留尾巴）。
 */

/** HTTP 非 2xx 状态错误（携带状态码供重试判定）。 */
export class HttpError extends Error {
  /** 响应状态码（如 500、429）。 */
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status}: ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export type RetryOptions = {
  /** 首次失败后的最大重试次数（默认 2，即最多 3 次尝试）。 */
  retries?: number;
  /** 首次退避毫秒数（默认 800）。 */
  baseMs?: number;
  /** 退避上限（默认 8000）。 */
  maxMs?: number;
  /** 外部中止信号：触发后不再等待、不再重试。 */
  signal?: AbortSignal;
  /** 自定义可重试判定；返回 false 立即抛出。 */
  isRetryable?: (err: unknown, attempt: number) => boolean;
};

/**
 * 判断错误是否来自 AbortController 的主动中止。
 * 主动取消不应被视为失败进入重试循环；兼容跨 realm / jsdom / undici 实现
 * （非 DOMException 时按 name 兜底判定）。
 *
 * @param err - 待判定的未知错误。
 * @returns true 表示主动中止。O(1)。
 * @example
 * ```ts
 * catch (e) { if (isAbortError(e)) return; /* 静默 *\/ }
 * ```
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  // 跨 realm / 非 DOMException 实现（jsdom、Node undici）兜底按 name 判定。
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/**
 * 默认判定：4xx 客户端错误不重试，主动取消不重试，
 * 其余（网络错误/超时/5xx/429）可重试。
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  return true;
}

/**
 * 可中断的 sleep。
 *
 * @param ms - 等待毫秒数。
 * @param signal - 可选中止信号；触发后立即 reject，不留悬挂定时器。
 * @returns 到时 resolve 的 Promise。
 * @throws signal 已中止或等待中被中止时抛 `DOMException("Aborted","AbortError")`。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 带指数退避 + ±30% 抖动的重试执行器（重试模式 / 断路前置）。
 *
 * 规则：默认重试 2 次（共 3 次尝试）；退避 800ms 起指数增长、上限 8s；
 * `isRetryable` 判 false 或 signal 中止时立即抛出。
 *
 * @typeParam T - fn 的成功结果类型。
 * @param fn - 单次尝试；入参为从 0 计的尝试序号（可用于日志/降级）。
 * @param opts - {@link RetryOptions} 重试参数，全部可省略。
 * @returns 首次成功的 fn 结果。
 * @throws 重试耗尽抛最后一次错误；主动中止抛 AbortError（不再重试）。
 *
 * @example
 * ```ts
 * const body = await withRetry(
 *   () => fetch(url, { signal }).then(ensureOk),
 *   { signal, retries: 3 }
 * );
 * ```
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 2);
  const baseMs = opts.baseMs ?? 800;
  const maxMs = opts.maxMs ?? 8000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryable(err, attempt)) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const jitter = backoff * (0.7 + Math.random() * 0.6); // ±30% 抖动防雷鸣
      await sleep(jitter, opts.signal);
    }
  }
  throw lastErr;
}
