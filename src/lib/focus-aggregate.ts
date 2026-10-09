import { useEffect, useState } from "react";
import type { FocusAggregate, HourlyFocusBucket } from "../domain/analytics";
import { isTauri } from "./tauri";
import { useDbVersion } from "./db-signal";
import { sqliteRepo } from "./persistence/sqlite";
import { useAppStore } from "../store/app-store";

/** 面板级 SQL 查询行（任务归集）——与 AnalyticsPanel 此前手写的形状一致。 */
export interface TaskBreakdownRow {
  taskId: string | null;
  eventLabel: string | null;
  focusSeconds: number;
  sessions: number;
}

/**
 * （聚合刷新竞态）+ （双面板重复全表扫）：共享的 SQLite 按日聚合钩子。
 *
 * 此前番茄钟面板与统计面板各自维护一份相同的 `aggregateSessions(vmHour)`
 * effect——同一次会话完成触发两次全表扫描/物化，且刷新只挂在内存尾条 id
 * 上（写未落地读先行的竞态窗口）。本钩子：
 *  - 模块级缓存 + 在途去重：并发挂载/同拍刷新只发一次 IPC；
 *  - 刷新键 = 尾条 id（本窗/跨窗新记录）∪ dbVersion（本窗写已落地）∪ vmHour；
 *  - 失败置 null：回退内存口径用的是**新鲜**内存数据，而不是上一次的旧
 *    SQL 快照（此前首查成功后再失败会永远停留旧值）。
 */
/**
 * 刷新键：dbVersion（本窗写已落地）∪ 尾条会话 id（跨窗新记录）。缓存与
 * 在途请求都按「vmHour + 刷新键」记录——同键命中才短路，数据版本一变
 * 即重查（此前只看 vmHour，首个快照被永久固化，今日卡片 +1 而
 * 月度统计纹丝不动）。
 */
function refreshKeyOf(dbVersion: number, lastSessionId: string): string {
  return `${dbVersion}|${lastSessionId}`;
}

let cache: { vmHour: number; refreshKey: string; agg: FocusAggregate } | null = null;
let inflight: { vmHour: number; refreshKey: string; p: Promise<FocusAggregate> } | null = null;

async function fetchAggregate(vmHour: number, refreshKey: string): Promise<FocusAggregate> {
  if (cache?.vmHour === vmHour && cache.refreshKey === refreshKey) return cache.agg;
  // 在途请求同样按 vmHour+刷新键判重——快速切换统计日界（0→4→2）
  // 时不得把旧日界的在途结果派发给新日界的调用方。
  if (inflight && inflight.vmHour === vmHour && inflight.refreshKey === refreshKey) {
    return inflight.p;
  }
  const p = sqliteRepo
    .aggregateSessions(vmHour)
    .then((agg) => {
      cache = { vmHour, refreshKey, agg };
      return agg;
    })
    .finally(() => {
      if (inflight?.p === p) inflight = null;
    });
  inflight = { vmHour, refreshKey, p };
  return p;
}

/** 全量按日专注聚合；非 Tauri / 加载失败返回 null（调用方回退内存口径）。 */
export function useFocusAggregate(vmHour: number): FocusAggregate | null {
  const native = isTauri();
  const dbVersion = useDbVersion();
  const lastSessionId = useAppStore((s) => (s.sessions.length > 0 ? s.sessions[s.sessions.length - 1].id : ""));
  const refreshKey = refreshKeyOf(dbVersion, lastSessionId);
  const [agg, setAgg] = useState<FocusAggregate | null>(() =>
    cache?.vmHour === vmHour && cache.refreshKey === refreshKey ? cache.agg : null
  );
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    fetchAggregate(vmHour, refreshKey)
      .then((next) => {
        if (!cancelled) setAgg(next);
      })
      .catch(() => {
        // 回退内存口径（SESSIONS_CAP 截断），不让统计面板报错；置 null
        // 而非保留旧值，保证回退的是新鲜数据。
        if (!cancelled) setAgg(null);
      });
    return () => {
      cancelled = true;
    };
    // dbVersion：写落地后补读（竞态闭环）；lastSessionId：跨窗同步的
    // 新记录（对端窗的 bump 信号不跨进程传播）。
  }, [native, vmHour, refreshKey]);
  return agg;
}

/* ---------------- ：三条面板级 SQL 查询的共享钩子 ----------------
 * 展开遮罩打开时卡片与展开页两个 AnalyticsPanel 实例并存（遮罩不卸载卡片），
 * 时段分布/任务归集/月度打断此前各自维护 effect 重复发 IPC；`key={openEpoch}`
 * 每次展开重挂载再触发一轮。与聚合同款「键命中短路 + 在途去重 + 失败置
 * null 回退新鲜内存」语义。
 * 缓存键必须并入刷新维度（args.version = 刷新键）——
 * 此前键只含业务参数（hourly/task 恒 null、month 恒 {vmHour,year,month0}），
 * effect 依赖里的刷新键变化只会反复命中首查缓存，三条查询在应用会话内
 * 冻结（同型回归）。调用方把 refreshKey 塞进 args.version，数据版本
 * 一变即重查。 */

/** 通用缓存查询：键 = 参数 JSON（含 version 刷新维度）；同键命中返回缓存，在途同键并入。 */
function makeCachedQuery<Args, T>(fetcher: (args: Args) => Promise<T>): (args: Args) => Promise<T> {
  let cache: { key: string; value: T } | null = null;
  let inflight: { key: string; p: Promise<T> } | null = null;
  return async (args: Args) => {
    const key = JSON.stringify(args);
    if (cache?.key === key) return cache.value;
    if (inflight?.key === key) return inflight.p;
    const p = fetcher(args)
      .then((value) => {
        cache = { key, value };
        return value;
      })
      .finally(() => {
        if (inflight?.p === p) inflight = null;
      });
    inflight = { key, p };
    return p;
  };
}

/** 通用订阅：deps 变化重查；fetch 为 null（非 Tauri）不动现有值；失败置
 *  null（调用方回退新鲜内存口径，而非停留在旧 SQL 快照）。 */
function useCachedQuery<T>(deps: unknown[], fetch: (() => Promise<T>) | null): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!fetch) return;
    let cancelled = false;
    fetch()
      .then((next) => {
        if (!cancelled) setValue(next);
      })
      .catch(() => {
        if (!cancelled) setValue(null);
      });
    return () => {
      cancelled = true;
    };
    // deps 由调用方拼接（含刷新键）；fetch 闭包随 deps 重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** 面板订阅刷新键（与聚合钩子同源：尾条会话 id ∪ 写落地版本）。 */
function useSessionRefreshKey(): string {
  const dbVersion = useDbVersion();
  const lastSessionId = useAppStore((s) => (s.sessions.length > 0 ? s.sessions[s.sessions.length - 1].id : ""));
  return `${dbVersion}|${lastSessionId}`;
}

const fetchHourly = makeCachedQuery(async (_: { version: string }): Promise<HourlyFocusBucket[]> => {
  const rows = await sqliteRepo.hourlyFocusDistribution();
  return rows.map((r) => ({ hour: r.hour, focusSeconds: r.focus_seconds, focusCount: r.focus_count }));
});

/** 24 小时时段分布（全历史，SQL 全量口径）；非 Tauri / 失败返回 null。 */
export function useFocusHourly(): HourlyFocusBucket[] | null {
  const native = isTauri();
  const refreshKey = useSessionRefreshKey();
  return useCachedQuery<HourlyFocusBucket[]>(
    [native, "hourly", refreshKey],
    native ? () => fetchHourly({ version: refreshKey }) : null
  );
}

const fetchTaskBreakdown = makeCachedQuery(async (_: { version: string }): Promise<TaskBreakdownRow[]> => {
  return sqliteRepo.taskFocusBreakdown();
});

/** 按专注事件聚合的已完成段秒数/段数（全量口径）；非 Tauri / 失败返回 null。 */
export function useTaskBreakdown(): TaskBreakdownRow[] | null {
  const native = isTauri();
  const refreshKey = useSessionRefreshKey();
  return useCachedQuery<TaskBreakdownRow[]>(
    [native, "task", refreshKey],
    native ? () => fetchTaskBreakdown({ version: refreshKey }) : null
  );
}

const fetchMonthInterruptions = makeCachedQuery(
  async (args: {
    vmHour: number;
    year: number;
    month0: number;
    version: string;
  }): Promise<{ reason: string; count: number }[]> => {
    return sqliteRepo.monthlyInterruptionBreakdown(args.vmHour, args.year, args.month0);
  }
);

/** 某虚拟日历月各中断原因的计数（全量口径）；非 Tauri / 失败返回 null。
 *  刷新键额外挂打断尾条（elapsed==0 的打断不产生会话记录）。 */
export function useMonthInterruptions(
  vmHour: number,
  year: number,
  month0: number
): { reason: string; count: number }[] | null {
  const native = isTauri();
  const dbVersion = useDbVersion();
  const lastSessionId = useAppStore((s) => (s.sessions.length > 0 ? s.sessions[s.sessions.length - 1].id : ""));
  const lastInterruption = useAppStore((s) => {
    const last = s.interruptions[s.interruptions.length - 1];
    return last ? `${last.startedAt}|${last.endedAt}|${last.reason}` : "";
  });
  return useCachedQuery<{ reason: string; count: number }[]>(
    [native, "month-int", vmHour, year, month0, `${dbVersion}|${lastSessionId}|${lastInterruption}`],
    native
      ? () =>
          fetchMonthInterruptions({
            vmHour,
            year,
            month0,
            version: `${dbVersion}|${lastSessionId}|${lastInterruption}`
          })
      : null
  );
}
