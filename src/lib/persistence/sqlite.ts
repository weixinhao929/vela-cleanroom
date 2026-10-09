import type { Deadline, Task } from "../../domain/schemas";
import type { PomodoroInterruption, PomodoroMode, PomodoroSessionRecord } from "../../domain/pomodoro";
import type { FocusAggregate } from "../../domain/analytics";
import { invoke } from "../tauri";
import type { PersistenceAdapter } from "../../ports/persistence";
// IPC 线协议的单一来源：Rust models.rs 经 ts-rs 生成（cargo test export 刷新）。
// 不再手写 snake_case 接口 —— 此前的 RustTask/RustDeadline/RustSession 手写
// 映射已出现"老后端缺字段"式漂移，字段增减以 Rust 侧为准自动同步。
import type { Task as RustTask } from "../../types/bindings/Task";
import type { Deadline as RustDeadline } from "../../types/bindings/Deadline";
import type { PomodoroSession as RustSession } from "../../types/bindings/PomodoroSession";
import type { PomodoroInterruption as RustInterruption } from "../../types/bindings/PomodoroInterruption";
import type { AppData } from "../../types/bindings/AppData";
import type { FocusAggregate as RustFocusAggregate } from "../../types/bindings/FocusAggregate";
import type { HourlyFocusStat } from "../../types/bindings/HourlyFocusStat";
import type { ReasonCount } from "../../types/bindings/ReasonCount";
import type { TaskFocusStat } from "../../types/bindings/TaskFocusStat";
import type { BackupInfo } from "../../types/bindings/BackupInfo";
import { bumpDbVersion } from "../db-signal";
import { createSerialChain } from "../serial-chain";
// 既有消费面（DataPanel 等）经本模块取 BackupInfo——绑定替换手写接口后原样再导出。
export type { BackupInfo };

/** （时间串归一化）：入库前把任意可解析的 ISO 串统一成 UTC-Z 毫秒形态
 *  （与前端 toISOString 同形）。库内保留裁剪 / 聚合前缀比较都按字符串
 *  字典序进行——`+08:00` 偏移或秒精度串会破坏排序与比较（迁移 v6 只
 *  覆盖导入路径；JSON 导入循环走本包装同样被归一化）。不可解析的串原样
 *  透传，由 Rust 侧 解析失败跳过的既有口径兜底。 */
function toNormIso(raw: string): string {
  const t = new Date(raw).getTime();
  // toISOString 对 >9999 年产出 `+010000-…` 扩展年格式——`+` 码位小于
  // 数字，会破坏 ORDER BY started_at 的字典序（retention 把它当最旧优先
  // 裁掉），chrono 也拒绝解析。年份越界（<0000 / >9999）按不可解析口径
  // 原样透传，交给 Rust 侧 解析失败跳过的既有兜底。
  const inRange = !Number.isNaN(t) && t <= 253402300799999 && t >= -62135596800000;
  return inRange ? new Date(t).toISOString() : raw;
}

/**
 * SQLite 仓储层（仓储模式 + 写队列）。
 *
 * 职责：把 store 动作层的领域写操作翻译为 Tauri 命令；所有写经
 * {@link enqueueWrite} 串行化（防「整表替换 × 行级写」交错互相覆盖），
 * 单笔挂起超 60s 判死并放行队列（防 Rust 侧卡死永久堵写）。
 * 线协议类型由 Rust models.rs 经 ts-rs 生成（types/bindings/），字段
 * 增减以 Rust 侧为准自动同步。读操作不排队（与写不竞争）。
 */

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseTiers(raw: string | undefined): string[] {
  return parseTags(raw);
}

function parseRepeat(raw: string | undefined): Deadline["repeat"] {
  return raw === "daily" || raw === "weekly" || raw === "monthly" || raw === "yearly" ? raw : "none";
}

function toTask(t: RustTask): Task {
  return {
    id: t.id,
    title: t.title,
    completed: t.completed,
    createdAt: t.created_at,
    dueAt: t.due_at ?? "",
    priority: Math.max(0, Math.min(3, t.priority ?? 0)),
    tags: parseTags(t.tags),
    sortOrder: t.sort_order ?? 0
  };
}

function toDeadline(d: RustDeadline): Deadline {
  return {
    id: d.id,
    title: d.title,
    dueAt: d.due_at,
    notified: d.notified,
    completed: d.completed,
    notifiedTiers: parseTiers(d.notified_tiers),
    repeat: parseRepeat(d.repeat)
  };
}

function toSession(s: RustSession): PomodoroSessionRecord {
  return {
    id: s.id,
    type: s.session_type === "focus" ? "focus" : "break",
    mode: s.mode as PomodoroMode,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    plannedSeconds: s.planned_seconds,
    completed: s.completed,
    taskId: s.task_id ?? null,
    eventLabel: s.event_label ?? null
  };
}

function toInterruption(i: RustInterruption): PomodoroInterruption {
  return {
    startedAt: i.started_at,
    endedAt: i.ended_at,
    reason: i.reason,
    mode: i.mode as PomodoroMode,
    elapsedSeconds: i.elapsed_seconds
  };
}

/**
 * tasks/deadlines → Rust 线协议载荷（snake_case 字段映射的单一出处）。
 * sessions 由调用方按语义附加：整表替换（import_data）携带映射后的列表，
 * 保留库中现存量（import_core_data_keep_sessions）则完全不传。
 */
function buildCoreDataPayload(state: { tasks: Task[]; deadlines: Deadline[] }): Pick<AppData, "tasks" | "deadlines"> {
  return {
    tasks: state.tasks.map((x) => ({
      id: x.id,
      title: x.title,
      completed: x.completed,
      created_at: x.createdAt,
      due_at: x.dueAt ?? "",
      priority: x.priority ?? 0,
      tags: JSON.stringify(x.tags ?? []),
      sort_order: x.sortOrder ?? 0
    })),
    deadlines: state.deadlines.map((x) => ({
      id: x.id,
      title: x.title,
      due_at: x.dueAt,
      notified: x.notified,
      completed: x.completed,
      notified_tiers: JSON.stringify(x.notifiedTiers ?? []),
      repeat: x.repeat ?? "none"
    }))
  };
}

/** 单条专注记录 → Rust 线协议载荷（snake_case 映射的单一出处，两处导入路径共用）。 */
function buildSessionPayload(r: PomodoroSessionRecord) {
  return {
    id: r.id,
    session_type: r.type,
    mode: r.mode,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    planned_seconds: r.plannedSeconds,
    completed: r.completed,
    task_id: r.taskId ?? null,
    event_label: r.eventLabel ?? null
  };
}

/**
 * SQLite-backed persistence adapter. Talks to the Rust core over Tauri IPC.
 * Only usable inside the Tauri runtime; browser mode falls back to localStorage.
 *
 * 适配器只实现读（load）。此前接口要求 save/clear，
 * SQLite 侧只能给出 console.warn 的假 save 和一个隐式清空 sessions 的
 * clear（且 import_data 是 settings 专用命令，clear 从非设置窗调用只会拿到
 * Denied）——承诺了给不了的语义。写路径的全部真实入口是下方的
 * {@link sqliteRepo} 行级/整表命令；类型上本适配器不再有 save/clear，
 * 误用会在编译期报错。「恢复备份」走 features/settings/restore-backup.ts
 * 链路（含校验 + ack 协议），不要绕到这里。
 */
export const sqliteAdapter: PersistenceAdapter = {
  kind: "sqlite",

  async load() {
    const [tasks, deadlines] = await Promise.all([
      invoke<RustTask[]>("list_tasks"),
      invoke<RustDeadline[]>("list_deadlines")
    ]);
    /* 空值防护：null 形态只出现在测试环境（未 mock 的 invoke 返回 null，
       此前 .map 抛 TypeError 进「[sync] app repull failed」噪音日志）；生产
       侧 list_* 要么数组要么 reject。按空表处理即可，不放大成水合失败。 */
    return { tasks: (tasks ?? []).map(toTask), deadlines: (deadlines ?? []).map(toDeadline) };
  }
};

/**
 * 串行化所有写操作。store 动作层里的 IPC 调用都是 fire-and-forget，
 * 并发触发时 Tauri 不保证按发起顺序落库——「整表替换（导入）」与
 * 「行级写（add/toggle）」交错执行会互相覆盖/复活旧行。所有变更挂到
 * 同一条 promise 链上按序执行；读操作不排队（启动/刷新时才读，
 * 与写不竞争）。
 *
 * 超时语义（+ 对账闭环）：单笔挂起超 {@link WRITE_TIMEOUT_MS} 时
 * **只放行队列**，不再向调用方报失败——调用方拿到的是原写操作的真实落定
 * 结果，无论它多晚到。此前超时直接 reject 调用方视图：store 的 persist-first
 * 动作（先落库成功再 set 内存）在 catch 里按失败处理，而 Rust 侧的写此后
 * 迟到成功时内存那一步永远不执行，内存与 DB 就此静默分叉直到重启。现在
 * 迟到成功 → 调用方的 set 照常执行（内存自愈，并经 sync:app 广播给其他窗口）；
 * 迟到失败 → 照常走 reportPersistError；永不落定 → 内存与 DB 都停在写前状态，
 * 两边一致。残余：超时后放行的后续写若与迟到落库的旧写交错，落库顺序仍可能
 * 与发起顺序不同——这需要 Rust 侧 requestId 幂等去重，JS 侧无法闭环，记录在案。
 *
 * 实现经 lib/serial-chain 的共享串行链（与歌词单飞锁、快捷键对账链同内核）。
 */
const WRITE_TIMEOUT_MS = 60_000;
const writeChain = createSerialChain({
  timeoutMs: WRITE_TIMEOUT_MS,
  onTimeout: () =>
    console.warn(
      "[persistence] a queued write exceeded the timeout; later writes proceed, this one is still awaited by its caller"
    )
});
export function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
  return writeChain.enqueue(op);
}

/**
 * 行级 SQLite 操作集合（store 动作层专用门面）。
 * 写方法全部经 enqueueWrite 串行；P-perf 批量方法 deleteTasks/reorderTasks
 * 把 N 次往返合并为单 IPC + 单事务。
 */
export const sqliteRepo = {
  /** 用内存中的任务/DDL/专注记录整表替换 SQLite（JSON / CSV 导入后落库）。
      settings 不传 = 不触碰设置行；sessions 传当前内存值 = 原样保留；
      interruptions 不传 = 保留库中现有记录。 */
  async replaceCoreData(state: {
    tasks: Task[];
    deadlines: Deadline[];
    sessions: PomodoroSessionRecord[];
  }): Promise<void> {
    await enqueueWrite(() => this._importCoreData(state));
  },
  /**
   * CSV / JSON 导入专用：只替换 tasks + deadlines，sessions 保留库中全量，
   * 避免把内存（SESSIONS_CAP=500 截断后）的 sessions 整表回写而误删历史
   * 专注记录。
   *
   * 快照与整表替换收口为 Rust 单事务命令
   * `import_core_data_keep_sessions`——此前「先 list_sessions 再
   * import_data」分两步，JS 写链只在单 WebView 内有效，两步之间其他窗口
   * 新写入的专注记录会被整表替换静默删除。载荷不携带 sessions（Rust 在
   * 同一事务内以库中现存行为准）；闸门与 import_data 同为设置窗专用，
   * 现有调用方（设置窗 DataPanel 导入链路）可达性不变。
   */
  async replaceCoreDataKeepSessions(state: { tasks: Task[]; deadlines: Deadline[] }): Promise<void> {
    await enqueueWrite(() => invoke("import_core_data_keep_sessions", { data: buildCoreDataPayload(state) }));
  },
  /**
   * （迁移重设计）：一次性 localStorage→SQLite 迁移专用。把 legacy 浏览器
   * 快照交给 Rust 在**单事务内**与库中现存行按 id 做并集合并——id 冲突时
   * 库中现存行胜（库行代表迁移后新建/更新的数据，legacy 快照更旧），legacy
   * 独有的行插入。废除的两条旧路径：
   *  1) 行数启发式（legacy 行数不多于库则整体放弃）——legacy 10 任务 0 DDL
   *     vs 库 5 任务 6 DDL 时 legacy 独有的 5 条被永久丢弃；
   *  2) 前端「list_sessions 快照 → 按 id 合并 → import_data 整表替换」——
   *     快照与替换两步之间存在跨窗口竞态（轮在 CSV 导入路径修过的同一
   *     模式），现与 CSV 路径同款收口进 Rust 单事务。
   * 闸门：Rust 侧仅放行 widget-0（迁移的唯一执行窗，见 app-store hydrateApp
   * 的 primary 分支；settings 闸门会砍断迁移，require_trusted 又宽于唯一
   * 合法调用方）。载荷不携带 settings/interruptions：合并模式不触碰两者。
   */
  async mergeCoreData(state: {
    tasks: Task[];
    deadlines: Deadline[];
    sessions: PomodoroSessionRecord[];
  }): Promise<void> {
    await enqueueWrite(() =>
      invoke("import_core_data_merge", {
        data: {
          ...buildCoreDataPayload(state),
          sessions: state.sessions.map(buildSessionPayload)
        }
      })
    );
  },
  async _importCoreData(state: {
    tasks: Task[];
    deadlines: Deadline[];
    sessions: PomodoroSessionRecord[];
  }): Promise<void> {
    await invoke("import_data", {
      data: {
        ...buildCoreDataPayload(state),
        sessions: state.sessions.map(buildSessionPayload)
      }
    });
  },
  /**
   * 恢复完整备份必须与行级写走同一条写链，否则恢复期间恰在飞行的
   * addSession/toggle 会与整表导入交错，产生"新会话被覆盖 / 旧数据复活"。
   * data 是已通过 backup-validate 校验的 AppData 线协议对象。
   */
  async restoreFullBackup(data: AppData): Promise<void> {
    await enqueueWrite(() => invoke("import_data", { data }));
  },
  async addTask(title: string, extra?: { dueAt?: string; priority?: number; tags?: string[] }): Promise<Task> {
    const t = await enqueueWrite(() =>
      invoke<RustTask>("add_task", {
        title,
        dueAt: extra?.dueAt ?? "",
        priority: extra?.priority ?? 0,
        tags: JSON.stringify(extra?.tags ?? [])
      })
    );
    return toTask(t);
  },
  async toggleTask(id: string): Promise<Task | null> {
    const t = await enqueueWrite(() => invoke<RustTask | null>("toggle_task", { id }));
    return t ? toTask(t) : null;
  },
  async deleteTask(id: string): Promise<void> {
    await enqueueWrite(() => invoke("delete_task", { id }));
  },
  /** P-perf 批量删除：单次 IPC + 单事务（此前逐 id 排队 N 次往返）。 */
  async deleteTasks(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (ids.length === 1) return this.deleteTask(ids[0]);
    await enqueueWrite(() => invoke("delete_tasks", { ids }));
  },
  /** P-perf 批量排序：单次 IPC + 单事务覆写 sortOrder。 */
  async reorderTasks(pairs: { id: string; sortOrder: number }[]): Promise<void> {
    if (pairs.length === 0) return;
    if (pairs.length === 1) {
      await enqueueWrite(() =>
        invoke<RustTask | null>("update_task", {
          id: pairs[0].id,
          title: null,
          dueAt: null,
          priority: null,
          tags: null,
          sortOrder: pairs[0].sortOrder
        })
      );
      return;
    }
    await enqueueWrite(() => invoke("reorder_tasks", { pairs }));
  },
  async updateTask(
    id: string,
    patch: { title?: string; dueAt?: string; priority?: number; tags?: string[]; sortOrder?: number }
  ): Promise<Task | null> {
    const t = await enqueueWrite(() =>
      invoke<RustTask | null>("update_task", {
        id,
        title: patch.title ?? null,
        dueAt: patch.dueAt ?? null,
        priority: patch.priority ?? null,
        tags: patch.tags ? JSON.stringify(patch.tags) : null,
        sortOrder: patch.sortOrder ?? null
      })
    );
    return t ? toTask(t) : null;
  },
  async addDeadline(title: string, dueAt: string, repeat?: Deadline["repeat"]): Promise<Deadline> {
    const d = await enqueueWrite(() =>
      invoke<RustDeadline>("add_deadline", { title, dueAt, repeat: repeat ?? "none" })
    );
    return toDeadline(d);
  },
  async deleteDeadline(id: string): Promise<void> {
    await enqueueWrite(() => invoke("delete_deadline", { id }));
  },
  async toggleDeadline(id: string): Promise<Deadline | null> {
    const d = await enqueueWrite(() => invoke<RustDeadline | null>("toggle_deadline", { id }));
    return d ? toDeadline(d) : null;
  },
  async markDeadlineNotified(id: string): Promise<void> {
    await enqueueWrite(() => invoke("mark_deadline_notified", { id }));
  },
  async setDeadlineNotifiedTiers(id: string, tiers: string[]): Promise<void> {
    await enqueueWrite(() => invoke("set_deadline_notified_tiers", { id, tiers }));
  },
  async updateDeadline(
    id: string,
    patch: { title?: string; dueAt?: string; repeat?: Deadline["repeat"] },
    resetTiers: boolean
  ): Promise<Deadline | null> {
    const d = await enqueueWrite(() =>
      invoke<RustDeadline | null>("update_deadline", {
        id,
        title: patch.title ?? null,
        dueAt: patch.dueAt ?? null,
        repeat: patch.repeat ?? null,
        resetTiers
      })
    );
    return d ? toDeadline(d) : null;
  },
  async addSession(record: PomodoroSessionRecord): Promise<void> {
    await enqueueWrite(() =>
      invoke("add_session", {
        session: {
          id: record.id,
          session_type: record.type,
          mode: record.mode,
          started_at: toNormIso(record.startedAt),
          ended_at: toNormIso(record.endedAt),
          planned_seconds: record.plannedSeconds,
          completed: record.completed,
          task_id: record.taskId ?? null,
          event_label: record.eventLabel ?? null
        }
      })
    );
    // 写已提交：通知统计面板在「读不排队」的竞态窗口之后补一次聚合查询。
    bumpDbVersion();
  },
  /** （备份导入单事务并集补插）：把备份里的专注记录按 id「库中现存行胜、
   *  载荷独有行插入」合并进 sessions 表——单次 IPC + Rust 单事务完成，替代
   *  导入路径此前「listSessions 快照 + 逐条 addSession」的 N+1 次串行往返
   *  （500 条备份 = 500 次）；快照与补插之间其他窗口新写的行在同事务内
   *  可见，不再存在竞态窗口。时间戳归一由 Rust 侧 normalize_ts 完成
   *  （与 import_core_data_merge 的 sessions 分支同口径）。 */
  async mergeSessions(sessions: PomodoroSessionRecord[]): Promise<void> {
    if (sessions.length === 0) return;
    await enqueueWrite(() => invoke("merge_sessions", { sessions: sessions.map(buildSessionPayload) }));
    // 写已提交：统计面板补一次聚合查询（与 addSession 同口径）。
    bumpDbVersion();
  },
  async listSessions(limit?: number): Promise<PomodoroSessionRecord[]> {
    /* limit 下推——水合只拉最近 N 条（ORDER BY started_at 倒序子查询取
     * 最近 N 再正序输出，与全量序一致），不再整表拉回后丢弃 97.5%。 */
    const rows = await invoke<RustSession[]>("list_sessions", { limit: limit ?? null });
    /* 空值防护同 sqliteAdapter.load（测试环境未 mock 的 invoke 返回 null）。 */
    return (rows ?? []).map(toSession);
  },
  /** SQLite 全量按日聚合（累计统计/年度热图用，不受 SESSIONS_CAP 截断）。
   *  virtualMidnightHour：虚拟午夜小时（0/2/4），跨午夜会话在 Rust 侧按
   *  边界切分后归日。 */
  async aggregateSessions(virtualMidnightHour = 0): Promise<FocusAggregate> {
    const rows = await invoke<RustFocusAggregate>("aggregate_sessions", { virtualMidnightHour });
    return {
      daily: rows.daily.map((d) => ({ date: d.date, focusSeconds: d.focus_seconds, focusCount: d.focus_count }))
    };
  },
  /** 24 小时时段分布（跨午夜/跨小时段按墙钟占比切分）。
   *  小时桶按墙钟小时分桶，与虚拟午夜设置无关——不传参（L1 清理：
   *  原 virtualMidnightHour 在 Rust 侧从未参与计算）。 */
  async hourlyFocusDistribution(): Promise<HourlyFocusStat[]> {
    const rows = await invoke<HourlyFocusStat[]>("hourly_focus_distribution");
    return rows.map((h) => ({ hour: h.hour, focus_seconds: h.focus_seconds, focus_count: h.focus_count }));
  },
  /** （打断统计 SQL 全量化）：某虚拟日历月各中断原因的计数（全量口径，
   *  突破前端 300 条内存截断）。与 domain 层 monthlyInterruptionBreakdown
   *  的内存口径一致：按打断**开始时刻**的虚拟日归属月（与会话侧「按起始
   *  归日」的统一规则一致）、次数降序。 */
  async monthlyInterruptionBreakdown(
    virtualMidnightHour: number,
    year: number,
    month0: number
  ): Promise<{ reason: string; count: number }[]> {
    const rows = await invoke<ReasonCount[]>("monthly_interruption_breakdown", {
      virtualMidnightHour,
      year,
      month0
    });
    return rows.map((r) => ({ reason: r.reason, count: r.count }));
  },
  /** （任务用时归集 SQL 全量化）：按专注事件聚合的已完成段秒数与段数
   *  （全量口径，突破内存 SESSIONS_CAP=500 截断）。task_id / event_label
   *  均为 null 的行即「未关联」组；秒数出口一次取整由消费方负责。 */
  async taskFocusBreakdown(): Promise<
    { taskId: string | null; eventLabel: string | null; focusSeconds: number; sessions: number }[]
  > {
    const rows = await invoke<TaskFocusStat[]>("task_focus_breakdown");
    return rows.map((r) => ({
      taskId: r.task_id,
      eventLabel: r.event_label,
      focusSeconds: r.focus_seconds,
      sessions: r.sessions
    }));
  },
  async addInterruption(record: PomodoroInterruption): Promise<void> {
    await enqueueWrite(() =>
      invoke("add_interruption", {
        interruption: {
          id: crypto.randomUUID(),
          started_at: toNormIso(record.startedAt),
          ended_at: toNormIso(record.endedAt),
          reason: record.reason,
          mode: record.mode,
          elapsed_seconds: record.elapsedSeconds
        }
      })
    );
    bumpDbVersion();
  },
  /** ()（备份导入批量合并，mergeSessions 的 interruptions 对位）：
   *  Rust 单事务按 (started_at, ended_at, reason) 复合键并集补插（库中现存
   *  行胜），替代此前「listInterruptions 快照 + 逐条 addInterruption」的
   *  N+1 次串行往返与两步间竞态。id 各窗口独立生成、不具合并语义，这里
   *  逐条现生成（仅作主键，不参与去重）。 */
  async mergeInterruptions(records: PomodoroInterruption[]): Promise<void> {
    if (records.length === 0) return;
    await enqueueWrite(() =>
      invoke("merge_interruptions", {
        interruptions: records.map((r) => ({
          id: crypto.randomUUID(),
          started_at: toNormIso(r.startedAt),
          ended_at: toNormIso(r.endedAt),
          reason: r.reason,
          mode: r.mode,
          elapsed_seconds: r.elapsedSeconds
        }))
      })
    );
    bumpDbVersion();
  },
  async listInterruptions(limit?: number): Promise<PomodoroInterruption[]> {
    /* limit 下推（对位 listSessions）——水合只拉最近 N 条。 */
    const rows = await invoke<RustInterruption[]>("list_interruptions", { limit: limit ?? null });
    /* 空值防护同上（测试环境 null 形态）。 */
    return (rows ?? []).map(toInterruption);
  },
  async createBackup(): Promise<BackupInfo> {
    return invoke<BackupInfo>("create_backup");
  },
  async listBackups(): Promise<BackupInfo[]> {
    return invoke<BackupInfo[]>("list_backups");
  },
  async getSetting(key: string): Promise<string | null> {
    return invoke<string | null>("get_setting", { key });
  },
  async setSetting(key: string, value: string): Promise<void> {
    await enqueueWrite(() => invoke("set_setting", { key, value }));
  }
};
