import type { Task } from "../../domain/schemas";

/**
 * 任务全览（看板沉浸页）的列派生纯函数。
 *
 * 五列 = 「逾期 / 今天 / 之后 / 无期限 / 已完成」，完全由既有字段派生
 * （completed + dueAt），不新增任何存储字段：
 *  - 已完成恒进 done 列（不按日期分列）；
 *  - dueAt 空串或解析失败 → 无期限；
 *  - 早于本地今日 00:00 → 逾期；落在今日（< 明日 00:00，含 23:59:59.999）
 *    → 今天；其余 → 之后。日界用本地时区（与 TodayTasksPanel 的分组同口径），
 *    跨夏令时安全（明日 00:00 经 Date 构造器归一化，不假设 24h 天）。
 *
 * 列内排序：sortOrder 升序（手动权重，小的在前），并列按传入顺序
 * （显式下标 tie-break，不依赖引擎 sort 稳定性）。
 */

/** 看板列标识（展示顺序即 TASK_BUCKETS 顺序）。 */
export type TaskBucket = "overdue" | "today" | "later" | "none" | "done";

/** 五列展示顺序：逾期 → 今天 → 之后 → 无期限 → 已完成。 */
export const TASK_BUCKETS: readonly TaskBucket[] = ["overdue", "today", "later", "none", "done"];

/** 分桶结果：每列一个任务数组（已按列内序排好）。 */
export type BucketedTasks = Record<TaskBucket, Task[]>;

/** 本地时区某时刻所在日的 00:00 毫秒时间戳。 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 解析 dueAt 为毫秒时间戳；空串 / 非法字符串返回 null（= 无期限）。 */
function parseDue(dueAt: string): number | null {
  if (!dueAt) return null;
  const t = new Date(dueAt).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * 把任务列表派生成五列看板。
 *
 * @param tasks - store 中的全量任务（任意顺序）。
 * @param nowMs - 「现在」的毫秒时间戳（本地时区取日界；测试注入固定值）。
 * @returns 每列的任务数组，列内按 sortOrder 升序、并列保持传入顺序。
 */
export function bucketTasks(tasks: Task[], nowMs: number): BucketedTasks {
  const out: BucketedTasks = { overdue: [], today: [], later: [], none: [], done: [] };
  const today0 = startOfDay(nowMs);
  const tomorrow0 = startOfDay(nowMs + 86_400_000);
  for (const t of tasks) {
    if (t.completed) {
      out.done.push(t);
      continue;
    }
    const due = parseDue(t.dueAt);
    if (due == null) out.none.push(t);
    else if (due < today0) out.overdue.push(t);
    else if (due < tomorrow0) out.today.push(t);
    else out.later.push(t);
  }
  /* 列内排序：sortOrder 升序 + 传入顺序 tie-break（显式下标，稳定可测）。 */
  const pos = new Map(tasks.map((t, i) => [t.id, i]));
  const byOrder = (a: Task, b: Task) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0);
  for (const b of TASK_BUCKETS) out[b].sort(byOrder);
  return out;
}

/**
 * 拖放到日期列时的新 dueAt 值（本地时区构造后转 ISO）。
 *
 * - none → ""（清除截止）；
 * - today / later → 目标日（今天 / 明天）+ 原截止的时分秒（无原截止或
 *   非法时回退 23:59，让「今天」的任务整天都算今天到期）。
 * 逾期列不是可指派目标（过去的时间无意义），不接受该 bucket。
 *
 * @param bucket - 目标列（today / later / none）。
 * @param prevDueAt - 被拖任务的原截止（可为空 / 非法）。
 * @param nowMs - 当前毫秒时间戳。
 * @returns 新的 ISO 截止字符串（none 列返回 ""）。
 */
export function dueAtForBucket(bucket: "today" | "later" | "none", prevDueAt: string, nowMs: number): string {
  if (bucket === "none") return "";
  const now = new Date(nowMs);
  const prev = prevDueAt ? new Date(prevDueAt) : null;
  const hasTime = prev != null && !Number.isNaN(prev.getTime());
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (bucket === "later" ? 1 : 0),
    hasTime ? prev!.getHours() : 23,
    hasTime ? prev!.getMinutes() : 59,
    hasTime ? prev!.getSeconds() : 0,
    0
  );
  return next.toISOString();
}
