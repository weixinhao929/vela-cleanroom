import type { AppState, Deadline, Task } from "../../domain/schemas";
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
import type { BackupInfo } from "../../types/bindings/BackupInfo";
// 既有消费面（DataPanel 等）经本模块取 BackupInfo——绑定替换手写接口后原样再导出。
export type { BackupInfo };

/**
 * SQLite 仓储层（仓储模式 + 写队列）。
 *
 * 职责：把 store 动作层的领域写操作翻译为 Tauri 命令；所有写经
 * {@link enqueueWrite} 串行化（防「整表替换 × 行级写」交错互相覆盖），
 * 单笔挂起超 60s 判死并放行队列（E-5，防 Rust 侧卡死永久堵写）。
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
 * SQLite-backed persistence adapter. Talks to the Rust core over Tauri IPC.
 * Only usable inside the Tauri runtime; browser mode falls back to localStorage.
 */
export const sqliteAdapter: PersistenceAdapter = {
  kind: "sqlite",

  async load() {
    const [tasks, deadlines] = await Promise.all([
      invoke<RustTask[]>("list_tasks"),
      invoke<RustDeadline[]>("list_deadlines")
    ]);
    return { tasks: tasks.map(toTask), deadlines: deadlines.map(toDeadline) };
  },

  async save(state: AppState) {
    // The SQLite adapter persists through per-entity commands. To keep the
    // contract simple and idempotent, we re-sync the full set via export/import
    // only when the store is hydrated; incremental writes go through commands.
    // For now, incremental commands are issued by the store's action layer.
    // P3（审计修复）：静默 no-op 违反 PersistenceAdapter 契约（"Persist the
    // app state"），是给未来调用者的陷阱——至少留痕告警。
    void state;
    console.warn("[persistence] sqliteAdapter.save() is a no-op; use per-entity commands instead");
  },

  async clear() {
    // 陷阱警示（M4）：import_data 自审计加固起是 settings 窗专用命令——从非
    // 设置窗口调用本方法会拿到 Denied。当前无调用方；「恢复备份」请走
    // features/settings/restore-backup.ts 链路（含校验 + ack 协议），不要绕到这里。
    await enqueueWrite(() =>
      invoke("import_data", {
        data: { tasks: [], deadlines: [], sessions: [] }
      })
    );
  }
};

/**
 * 串行化所有写操作。store 动作层里的 IPC 调用都是 fire-and-forget，
 * 并发触发时 Tauri 不保证按发起顺序落库——「整表替换（导入）」与
 * 「行级写（add/toggle）」交错执行会互相覆盖/复活旧行。所有变更挂到
 * 同一条 promise 链上按序执行；读操作不排队（启动/刷新时才读，
 * 与写不竞争）。
 *
 * 超时语义（E-5 + 对账闭环）：单笔挂起超 {@link WRITE_TIMEOUT_MS} 时
 * **只放行队列**，不再向调用方报失败——调用方拿到的是原写操作的真实落定
 * 结果，无论它多晚到。此前超时直接 reject 调用方视图：store 的 persist-first
 * 动作（先落库成功再 set 内存）在 catch 里按失败处理，而 Rust 侧的写此后
 * 迟到成功时内存那一步永远不执行，内存与 DB 就此静默分叉直到重启。现在
 * 迟到成功 → 调用方的 set 照常执行（内存自愈，并经 sync:app 广播给其他窗口）；
 * 迟到失败 → 照常走 reportPersistError；永不落定 → 内存与 DB 都停在写前状态，
 * 两边一致。残余：超时后放行的后续写若与迟到落库的旧写交错，落库顺序仍可能
 * 与发起顺序不同——这需要 Rust 侧 requestId 幂等去重，JS 侧无法闭环，记录在案。
 */
let writeChain: Promise<unknown> = Promise.resolve();
export function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
  const run = writeChain.then(op, op);
  // 队列只等到超时为止：挂死的 IPC（Rust 侧死锁 / 锁停顿）不能永久堵住后续写。
  const guarded = withTimeout(run, WRITE_TIMEOUT_MS);
  writeChain = guarded.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const WRITE_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(
        "[persistence] a queued write exceeded the timeout; later writes proceed, this one is still awaited by its caller"
      );
      reject(new Error("write timeout"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * 行级 SQLite 操作集合（store 动作层专用门面）。
 * 写方法全部经 enqueueWrite 串行；P-perf 批量方法 deleteTasks/reorderTasks
 * 把 N 次往返合并为单 IPC + 单事务。
 */
export const sqliteRepo = {
  /** 统计任务+截止总行数（迁移决策用）。 */
  async count(): Promise<number> {
    const [tasks, deadlines] = await Promise.all([
      invoke<RustTask[]>("list_tasks"),
      invoke<RustDeadline[]>("list_deadlines")
    ]);
    return tasks.length + deadlines.length;
  },
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
   * 专注记录。sessions 永不截断地落库，因此这里直接用 listSessions 取全量。
   *
   * A-17：读快照与整表替换必须在同一条写链槽位内完成 —— 若分两步先
   * listSessions 再 replaceCoreData，中间并发入队的 addSession 会被过早
   * 快照吞掉。
   */
  async replaceCoreDataKeepSessions(state: { tasks: Task[]; deadlines: Deadline[] }): Promise<void> {
    await enqueueWrite(async () => {
      const rows = await invoke<RustSession[]>("list_sessions");
      const sessions = rows.map(toSession);
      await this._importCoreData({ tasks: state.tasks, deadlines: state.deadlines, sessions });
    });
  },
  async _importCoreData(state: {
    tasks: Task[];
    deadlines: Deadline[];
    sessions: PomodoroSessionRecord[];
  }): Promise<void> {
    await invoke("import_data", {
      data: {
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
        })),
        sessions: state.sessions.map((r) => ({
          id: r.id,
          session_type: r.type,
          mode: r.mode,
          started_at: r.startedAt,
          ended_at: r.endedAt,
          planned_seconds: r.plannedSeconds,
          completed: r.completed,
          task_id: r.taskId ?? null,
          event_label: r.eventLabel ?? null
        }))
      }
    });
  },
  /**
   * E-2: 恢复完整备份必须与行级写走同一条写链，否则恢复期间恰在飞行的
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
          started_at: record.startedAt,
          ended_at: record.endedAt,
          planned_seconds: record.plannedSeconds,
          completed: record.completed,
          task_id: record.taskId ?? null,
          event_label: record.eventLabel ?? null
        }
      })
    );
  },
  async listSessions(): Promise<PomodoroSessionRecord[]> {
    const rows = await invoke<RustSession[]>("list_sessions");
    return rows.map(toSession);
  },
  /** A-4：SQLite 全量按日聚合（累计统计/年度热图用，不受 SESSIONS_CAP 截断）。
   *  virtualMidnightHour：虚拟午夜小时（0/2/4），跨午夜会话在 Rust 侧按
   *  边界切分后归日（FocusTimer 借鉴）。 */
  async aggregateSessions(virtualMidnightHour = 0): Promise<FocusAggregate> {
    const rows = await invoke<RustFocusAggregate>("aggregate_sessions", { virtualMidnightHour });
    return {
      daily: rows.daily.map((d) => ({ date: d.date, focusSeconds: d.focus_seconds, focusCount: d.focus_count }))
    };
  },
  /** FocusTimer 借鉴：24 小时时段分布（跨午夜/跨小时段按墙钟占比切分）。
   *  小时桶按墙钟小时分桶，与虚拟午夜设置无关——不传参（L1 清理：
   *  原 virtualMidnightHour 在 Rust 侧从未参与计算）。 */
  async hourlyFocusDistribution(): Promise<HourlyFocusStat[]> {
    const rows = await invoke<HourlyFocusStat[]>("hourly_focus_distribution");
    return rows.map((h) => ({ hour: h.hour, focus_seconds: h.focus_seconds, focus_count: h.focus_count }));
  },
  async addInterruption(record: PomodoroInterruption): Promise<void> {
    await enqueueWrite(() =>
      invoke("add_interruption", {
        interruption: {
          id: crypto.randomUUID(),
          started_at: record.startedAt,
          ended_at: record.endedAt,
          reason: record.reason,
          mode: record.mode,
          elapsed_seconds: record.elapsedSeconds
        }
      })
    );
  },
  async listInterruptions(): Promise<PomodoroInterruption[]> {
    const rows = await invoke<RustInterruption[]>("list_interruptions");
    return rows.map(toInterruption);
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
