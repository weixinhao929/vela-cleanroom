import { useSyncExternalStore } from "react";

/**
 * （聚合刷新竞态）：「写已落库」的进程内信号。
 *
 * 统计面板的 SQL 聚合此前由**内存**追加触发重查，而 addSession 还在
 * enqueueWrite 队列里飞行（读操作按设计不排队，走独立 WAL 读连接）——
 * 读可以在写提交之前完成快照，累计/热图滞后一条会话且无后续补读触发。
 * sqliteRepo 的会话/打断写入成功返回时 bumpDbVersion()，订阅方
 * （useFocusAggregate 等）据此在**写落地之后**再查一次，闭环竞态与
 * 「重试成功后不重读」两个缺口。
 *
 * 进程内信号即可：跨窗口的新记录由 sync:session / sync:interruption
 * 同步到内存，尾条 id 变化本来就会触发各窗自己的重查。
 */

let version = 0;
const listeners = new Set<() => void>();

/** 写操作成功落地后调用；通知所有 useDbVersion 订阅者。 */
export function bumpDbVersion(): void {
  version += 1;
  for (const fn of listeners) fn();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** 当前信号版本（每次 bump +1）；组件用它做 effect 依赖。 */
export function useDbVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
