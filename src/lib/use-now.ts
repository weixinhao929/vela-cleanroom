import { useEffect, useState } from "react";
import { coveredTickGate, subscribeCoveredChange } from "./use-covered";

/* （性能）：同一 interval 值共享一个定时器——AnalyticsPanel / DeadlinePanel /
   TodayTasksPanel / PomodoroPanel 同窗各自 useNow(30s) 时不再重复排 N 个
   interval，卸载后引用计数归零自动停表。 */
const tickerListeners = new Map<number, Set<() => void>>();
const tickerTimers = new Map<number, number>();

/* 二.6 窗口隐藏静默：被遮挡/最小化期间跳过 tick 通知（CSS 动画已有
   data-app-hidden 暂停门，JS 节拍器同步静默——遮挡节流跨平台不一致，显式
   兜底）；恢复可见立即补一拍，时钟不落分钟。模块级安装一次。
   [COVERED]：画布被前台全屏完全遮挡（document 仍
   visible）时同样静默；恢复补拍同款。 */
let visGateInstalled = false;
function fireAllTickers(): void {
  for (const set of tickerListeners.values()) {
    for (const fn of [...set]) fn();
  }
}
function installTickerVisibilityGate(): void {
  if (visGateInstalled || typeof document === "undefined") return;
  visGateInstalled = true;
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) return;
      fireAllTickers();
    },
    { passive: true }
  );
  subscribeCoveredChange((covered) => {
    if (!covered) fireAllTickers();
  });
}

function subscribeTicker(intervalMs: number, cb: () => void): () => void {
  installTickerVisibilityGate();
  let set = tickerListeners.get(intervalMs);
  if (!set) {
    set = new Set();
    tickerListeners.set(intervalMs, set);
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (coveredTickGate()) return;
      for (const fn of tickerListeners.get(intervalMs) ?? []) fn();
    }, intervalMs);
    tickerTimers.set(intervalMs, id);
  }
  set.add(cb);
  return () => {
    const s = tickerListeners.get(intervalMs);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      const t = tickerTimers.get(intervalMs);
      if (t !== undefined) window.clearInterval(t);
      tickerTimers.delete(intervalMs);
      tickerListeners.delete(intervalMs);
    }
  };
}

/**
 * 订阅共享节拍器并返回当前时间（每次 tick 更新一个新 Date）。
 *
 * 模块职责：为所有需要周期性刷新「当前时刻」的面板提供统一时钟源。
 * （性能）：同一 interval 值全局共享一个定时器（观察者模式）——
 * AnalyticsPanel / DeadlinePanel / TodayTasksPanel / PomodoroPanel 同窗
 * 各自 useNow(30s) 时不再重复排 N 个 interval；卸载后引用计数归零自动停表。
 *
 * @param intervalMs - 刷新间隔毫秒数，默认 30000。相同值共享同一定时器。
 * @returns 当前时刻的 Date，每 intervalMs 更新一次（引用变化触发重渲）。
 * @throws 无（纯订阅语义；intervalMs 非法由 setInterval 自行兜底）。
 *
 * @example
 * `tsx
 * const now = useNow(1000); // 秒级时钟组件
 * const now30 = useNow(); // 30s 粒度面板，与其它面板共享节拍器
 * `
 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => subscribeTicker(intervalMs, () => setNow(new Date())), [intervalMs]);
  return now;
}

/**
 * 本地日历日的稳定键（YYYY-MM-DD）。把分钟级时钟归约成「天」粒度：
 * 只关心日期边界的重型 useMemo（今日任务分组 / 番茄统计 / DDL 分组）以它为
 * 依赖，不再随每 30s 的 tick 整面板重算（E-dayKey 化），跨零点翻新语义不变。
 */
export function dayKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 解析 YYYY-MM-DD 键为本地零点的 Date。
 *
 * @param key - 期望形如 `2026-08-24` 的日期键字符串。
 * @returns 对应本地午夜 00:00:00 的 Date；格式不匹配或构成非法日期（如
 *          月份越界）时返回 null。O(1)。
 * @throws 无（所有失败路径都以 null 表达）。
 *
 * @example
 * ```ts
 * dayKeyToDate("2026-08-24"); // Date(2026-07-31T16:00:00Z)
 * dayKeyToDate("bad");        // null
 * ```
 */
export function dayKeyToDate(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  // JS Date 构造器自动归一化越界分量（"2026-13-45" → 2027-02-13），getTime
  // 永不 NaN——回验一次往返，构成非法的键按承诺返回 null 而不是被归一成
  // 另一个日期。
  return dayKeyOf(d) === key ? d : null;
}
