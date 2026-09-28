/**
 * 崩溃日志：内存环形缓冲 + localStorage 持久化（best-effort）。
 *
 * 记录渲染错误（小组件错误边界）与全局未捕获异常（window.error /
 * unhandledrejection），供设置页「诊断」区查看。只保留最近 50 条，
 * 避免无界增长；单条 message/stack 截断防止异常字符串撑爆配额。
 *
 * §4.9 崩溃计数：桌面端每条记录同时上报 Rust（report_frontend_crash），
 * 与 panic hook 落同一个 crash-log.json，诊断区据此统计「近 7 天崩溃 N 次」。
 * 上报是 fire-and-forget；同一 source+message 2s 内只报一次，防止错误
 * 边界重渲循环把计数文件刷爆。
 */
import { invoke, isTauri } from "./tauri";

const CRASH_KEY = "focus-desk.crash-log.v1";
const MAX_ENTRIES = 50;
const MAX_TEXT = 2000;
/** 同键上报节流窗口（毫秒）。 */
const REPORT_THROTTLE_MS = 2000;

export type CrashEntry = {
  ts: string;
  /** 来源标识：小组件实例 id、窗口 hash 或 "global"。 */
  source: string;
  /** 附加信息：小组件类型或错误类型。 */
  detail?: string;
  message: string;
  stack?: string;
};

function truncate(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

let buffer: CrashEntry[] = load();

function load(): CrashEntry[] {
  try {
    const raw = localStorage.getItem(CRASH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.message === "string") : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(CRASH_KEY, JSON.stringify(buffer));
  } catch {
    // best-effort：配额满时丢弃持久化，内存缓冲仍可用
  }
}

let lastReportKey = "";
let lastReportAt = 0;

/**
 * 上报到 Rust 崩溃计数文件（仅桌面端）。节流：同一 source+message 在
 * 2s 内只报一次；失败静默——诊断通道本身绝不能再抛错。
 */
function reportToBackend(entry: CrashEntry): void {
  if (!isTauri()) return;
  const key = `${entry.source}\u0000${entry.message}`;
  const now = Date.now();
  if (key === lastReportKey && now - lastReportAt < REPORT_THROTTLE_MS) return;
  lastReportKey = key;
  lastReportAt = now;
  void invoke("report_frontend_crash", {
    source: entry.source,
    detail: entry.detail ?? null,
    message: entry.message
  }).catch(() => {});
}

/**
 * 记录一条崩溃信息（环形缓冲，新条目在最前，上限 50 条）。
 * message/detail/stack 各截断至 2000 字符；localStorage 写失败静默降级。
 *
 * @param entry - 崩溃条目；`ts` 可省略（默认当前时间），`source` 为来源
 *                标识（小组件实例 id / 窗口 hash / "global"）。
 * @returns 无。
 * @throws 无。
 *
 * @example
 * ```ts
 * logCrash({ source: instanceId, detail: "weather", ...toCrashFields(err) });
 * ```
 */
export function logCrash(entry: Omit<CrashEntry, "ts"> & { ts?: string }): void {
  const record: CrashEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    source: entry.source || "unknown",
    detail: entry.detail ? truncate(entry.detail) : undefined,
    message: truncate(entry.message) ?? "(no message)",
    stack: truncate(entry.stack)
  };
  buffer = [record, ...buffer].slice(0, MAX_ENTRIES);
  persist();
  reportToBackend(record);
}

/**
 * 读取崩溃日志（新→旧）。
 *
 * @returns 条目数组的副本（防止外部直接改写内部缓冲）。O(n)。
 * @throws 无。
 */
export function getCrashLog(): CrashEntry[] {
  return [...buffer];
}

/** 清空崩溃日志并持久化。无返回值、不抛错。 */
export function clearCrashLog(): void {
  buffer = [];
  persist();
}

/**
 * 从错误对象提取 message + stack（对非 Error 抛出值安全）。
 *
 * @param err - catch 到的任意抛出值。
 * @returns Error 取 message/stack；字符串原样；其余 JSON 序列化，
 *          序列化失败再退 String()。
 * @throws 无。
 *
 * @example
 * ```ts
 * window.onerror = (msg) => logCrash({ source: "global", ...toCrashFields(msg) });
 * ```
 */
export function toCrashFields(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  if (typeof err === "string") return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}
