import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { shallow } from "zustand/shallow";
import { jsonBackupService } from "../domain/backup";
import { parseDeadlinesCsv, parseTasksCsv } from "../domain/csv";
import {
  createInitialState,
  pomodoroReducer,
  DEFAULT_CONFIG,
  normalizeConfig,
  buildSessionRecord,
  buildInterruption,
  plannedSecondsFor,
  isFocusCompleted,
  type InterruptionReason,
  type PomodoroConfig,
  type PomodoroInterruption,
  type PomodoroSessionRecord,
  type PomodoroState,
  type PomodoroTimerMode
} from "../domain/pomodoro";
import { emitPomodoroEvent, type PomodoroEventContext } from "../domain/automation";
import { flags } from "../domain/flags";
import { t } from "../i18n-lite";
import { pomodoroNotification } from "../lib/notifications";
import type { AppState, Deadline, PomodoroMode, Task } from "../domain/schemas";
import {
  resolvePersistenceAdapter,
  localStorageAdapter,
  sqliteRepo,
  type PersistenceAdapter
} from "../lib/persistence";
import { migrateLocalStorageToSqlite, waitForMigration } from "../lib/persistence/migration";
import { isPrimaryWidgetWindow, invoke } from "../lib/tauri";
import { flushMirrorSync } from "../lib/local-backup";
import { reportPersistError } from "../lib/persist-error";

/**
 * 应用核心状态 store（zustand + subscribeWithSelector）。
 *
 * 职责：待办 / 截止 / 番茄钟（状态机 + 会话/打断记录）三大领域的唯一
 * 内存事实来源。写路径统一走 writeThrough「persist-first」协议——先等
 * SQLite/localStorage 落盘成功再更新内存，失败则内存不变并上报
 * （杜绝"UI 成功、重启回档"）；番茄钟 tick 由 Rust 心跳驱动（A-tick），
 * 唤醒后按墙钟幂等补齐。会话与打断记录有 500/300 条截断上限防膨胀。
 */

const CONFIG_KEY = "focus-desk.config.v1";
const LOG_KEY = "focus-desk.log.v1"; // persisted sessions + interruptions (browser mode)

/** 从 localStorage 读取番茄钟配置；损坏/缺省回退 DEFAULT_CONFIG。 */
function loadConfig(): PomodoroConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 持久化番茄钟配置到 localStorage（best-effort，不阻断主流程）。 */
function saveConfig(config: PomodoroConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // best-effort; never block the authoring flow
  }
}

const defaults: AppState & {
  sessions: PomodoroSessionRecord[];
  interruptions: PomodoroInterruption[];
  pomodoroConfig: PomodoroConfig;
  /** 完成序号：仅在 tickPomodoro 的「倒计时走完」分支自增（见 Store 注释）。 */
  pomodoroCompletedSeq: number;
  /** 刚完成的阶段（focus / 短休 / 长休），配合 pomodoroCompletedSeq 使用。 */
  pomodoroLastCompletedMode: PomodoroMode | null;
} = (() => {
  // 只读一次 localStorage：此前 loadConfig() 被调用两遍，两次求值之间若
  // localStorage 变化（其他窗口写入），initialState 与 config 会不一致。
  const config = loadConfig();
  return {
    tasks: [],
    deadlines: [],
    pomodoro: createInitialState(config),
    sessions: [],
    interruptions: [],
    pomodoroConfig: config,
    pomodoroCompletedSeq: 0,
    pomodoroLastCompletedMode: null
  };
})();

type Actions = {
  /** W-043：extra 携带截止/优先级/标签（均可选）。 */
  addTask(title: string, extra?: { dueAt?: string; priority?: number; tags?: string[] }): void;
  toggleTask(id: string): void;
  deleteTask(id: string): void;
  clearCompletedTasks(): void;
  /** W-044 行内编辑：局部更新任务字段。 */
  updateTask(id: string, patch: { title?: string; dueAt?: string; priority?: number; tags?: string[] }): void;
  /** W-045 手动排序：按展示顺序覆写 sortOrder。 */
  reorderTasks(orderedIds: string[]): void;
  addDeadline(title: string, dueAt: string, repeat?: Deadline["repeat"]): void;
  /** W-049：周期 DDL 勾完成时自动滚动到下一期而非标记完成。 */
  toggleDeadline(id: string): void;
  deleteDeadline(id: string): void;
  markDeadlineNotified(id: string): void;
  /** W-044 行内编辑 DDL：局部更新标题/截止/周期。 */
  updateDeadline(id: string, patch: { title?: string; dueAt?: string; repeat?: Deadline["repeat"] }): void;
  /** W-046 多档提醒：覆写已发送档位集合。返回的 Promise 在持久化成功时
   *  resolve、失败时 reject（失败已回滚乐观置位），供调用方做 in-flight 防重
   *  与重试上限（A-14）。 */
  setDeadlineTiers(id: string, tiers: string[]): Promise<void>;
  setPomodoroMode(mode: PomodoroMode): void;
  setPomodoroTimerMode(timerMode: PomodoroTimerMode): void;
  /** Select a focus event (task id or custom label) without disturbing a running break. */
  selectPomodoroEvent(taskId: string | null, label: string | null): void;
  setPomodoroConfig(config: Partial<PomodoroConfig>): void;
  /** Toggle the timer. Returns false when a focus start was blocked because no
   *  event is selected (enforced across all entry points: panel, tray, shortcut). */
  togglePomodoro(): boolean;
  resetPomodoro(): void;
  tickPomodoro(): void;
  interruptPomodoro(reason: InterruptionReason): void;
  /** FocusTimer 借鉴：运行中加时/回拨（±N 秒；倒计时剩余保底 10s）。
   *  @returns 是否生效（未运行 / 零变化为 false）。 */
  adjustPomodoro(delta: number): boolean;
  /** 清除 wait-activity 等待标记（presence 启动失败 / 手动接管时兜底）。 */
  clearAwaitingActivity(): void;
  /** Stop a running countup focus segment and record it as a completed session. */
  stopCountupFocus(): void;
  importData(raw: string): Promise<boolean>;
  importTasksCsv(raw: string): Promise<boolean>;
  importDeadlinesCsv(raw: string): Promise<boolean>;
};

type Store = (AppState & {
  sessions: PomodoroSessionRecord[];
  interruptions: PomodoroInterruption[];
  pomodoroConfig: PomodoroConfig;
  /** 完成通知的唯一权威信号：tickPomodoro 走完倒计时时 seq+1 并记录
   *  lastCompletedMode。此前 App.tsx 用「remaining 跳回满额」推断换段，与
   *  中断/重置（同样重置满额 + isRunning:false）不可区分，放弃专注会被
   *  误报「阶段完成」；autoCycle 关闭时 focus→focus 又没有 mode 变化可依
   *  赖——只有这个显式信号在各分支下都准确。 */
  pomodoroCompletedSeq: number;
  pomodoroLastCompletedMode: PomodoroMode | null;
}) &
  Actions;
const uid = () => crypto.randomUUID();

// Resolve synchronously at module load: the 4s boot fallback can render the UI
// before hydrateApp() reassigns this, and any store action fired in that window
// would write user data to the legacy localStorage key and then be dropped when
// the SQLite hydration overwrites the state.
let persistence: PersistenceAdapter = resolvePersistenceAdapter();
// 当前专注/休息段的墙钟开始时间（ISO 字符串），用于会话落库的 startedAt。
let segmentStartedAt: string | null = null;
// A-1 墙钟校正：当前「运行中」片段的锚点时间戳，以及锚定时刻的
// remaining/elapsed 基准值。每次 tick 都从真实墙钟反推 remaining，系统
// 睡眠 / 后台节流导致 tick 停摆后，唤醒即刻把倒计时拉回正确值。锚点在
// (重新)开始时重设、暂停时清除，从而暂停时间不被计入。
let segmentAnchorMs: number | null = null;
let segmentBaseSeconds = 0;
// 当前倒计时片段在「首次开始」时刻的 planned 时长（跨暂停保持不变）。
// 中断时长据它扣除墙钟剩余而来，因此不受运行中修改专注时长的影响（A-7）。
let segmentPlannedAtStart = 0;
// FocusTimer 借鉴（extend/rewind）：当前段累计的手动加时秒数（负数为回拨）。
// 段落落库时并入 plannedSeconds，中断已过时长据「计划+加时-剩余」计算。
let segmentAdjustSeconds = 0;
// FocusTimer 借鉴（会话过期）：暂停发生时刻。恢复时若已暂停超过
// SESSION_EXPIRY_MS，旧段按放弃结算（补录未完成会话）并从新段开始，
// 避免「挂了一夜的半截会话」跨日污染统计。
let pausedAtMs: number | null = null;
const SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000;
// A-5：hydrateApp 是长异步链，期间 UI 已可交互。若用户在 hydration 完成前
// 删除/编辑任务或 DDL，加载的快照（读于操作之前）会在合并时原样覆盖回去。
// 用 tombstone 集合记录 hydration 窗口内的删除，并在合并时让「内存（较新）」
// 在 id 冲突时获胜，杜绝删除复活与旧值回滚。
let hydrating = false;
const hydrationTombstones = { tasks: new Set<string>(), deadlines: new Set<string>() };

function clearSegmentAnchor() {
  segmentAnchorMs = null;
}

function rebaseSegmentAnchor(remainingSeconds: number) {
  segmentAnchorMs = Date.now();
  segmentBaseSeconds = remainingSeconds;
}

/** 运行中片段的墙钟真实值：倒计时返回剩余、正计时返回已过秒数；无锚点时
 *  回退到存储值（片段未运行）。 */
function wallRemaining(prev: PomodoroState): number {
  if (segmentAnchorMs == null) return prev.remainingSeconds;
  const elapsed = Math.floor((Date.now() - segmentAnchorMs) / 1000);
  return prev.timerMode === "countup" ? segmentBaseSeconds + elapsed : Math.max(0, segmentBaseSeconds - elapsed);
}

/**
 * 接收窗口的本地走秒（P-perf 三轮）：`sync:pomodoro` 锚点广播降频到 5s 后，
 * 接收窗口用本地锚点（applyRemotePomodoroSnapshot 已写入，各窗口独立副本）
 * 自行推进显示值——与 primary tick 同走 wallRemaining 同源同算，不引入漂移。
 * 只写 remainingSeconds 供显示；完成递进、落库、通知等副作用仍只属于 primary。
 *
 * @returns 无；未运行时 no-op（由调用方负责停止走秒定时器）。
 */
export function walkPomodoroDisplay(): void {
  const p = useAppStore.getState().pomodoro;
  if (!p.isRunning) return;
  const remaining = wallRemaining(p);
  if (remaining !== p.remainingSeconds) {
    useAppStore.setState({ pomodoro: { ...p, remainingSeconds: remaining } });
  }
}

/** 倒计时片段的已过秒数（含手动加时修正；正计时直接取累计值）。 */
function segmentElapsedSeconds(p: PomodoroState): number {
  if (p.timerMode === "countup") return wallRemaining(p);
  const planned =
    segmentPlannedAtStart > 0
      ? segmentPlannedAtStart + segmentAdjustSeconds
      : plannedSecondsFor(p.mode, useAppStore.getState().pomodoroConfig);
  return Math.max(0, planned - wallRemaining(p));
}

/** 事件上下文快照（emitPomodoroEvent 用）：自动化引擎 / 媒体联动的只读输入。 */
function buildEventContext(): PomodoroEventContext {
  const s = useAppStore.getState();
  const p = s.pomodoro;
  const hasSegment = p.isRunning || segmentStartedAt != null;
  const todayKey = new Date().toDateString();
  return {
    mode: hasSegment ? p.mode : "stopped",
    isRunning: p.isRunning,
    isPaused: !p.isRunning && hasSegment && !isFreshFocus(p, s.pomodoroConfig),
    elapsedSeconds: hasSegment ? segmentElapsedSeconds(p) : 0,
    remainingSeconds: p.timerMode === "countdown" && hasSegment ? wallRemaining(p) : 0,
    plannedSeconds: hasSegment
      ? segmentPlannedAtStart > 0
        ? segmentPlannedAtStart + segmentAdjustSeconds
        : plannedSecondsFor(p.mode, s.pomodoroConfig)
      : 0,
    completedToday: s.sessions.filter(
      (rec) => rec.type === "focus" && rec.completed && new Date(rec.endedAt).toDateString() === todayKey
    ).length
  };
}

/** 供自动化引擎在事件之外（tick 节拍）求值条件用的公开快照（与 emit 载荷同构）。 */
export function getPomodoroEventContext(): PomodoroEventContext {
  return buildEventContext();
}

/**
 * D-1 跨窗口番茄钟快照：番茄钟命令（开始/暂停/选任务/重置）可来自任一
 * 窗口，而 tick 只在 primary 窗口跑。同步载荷不仅要带 pomodoro 状态，还要
 * 带墙钟锚点（segmentAnchorMs/segmentBaseSeconds）与片段开始元数据，否则
 * 接收方直接 setState 后锚点为 null，wallRemaining 退回存储值、倒计时不再
 * 走秒。
 */
export interface PomodoroSyncSnapshot {
  pomodoro: PomodoroState;
  segmentAnchorMs: number | null;
  segmentBaseSeconds: number;
  segmentStartedAt: string | null;
  segmentPlannedAtStart: number;
}

/**
 * 导出当前番茄钟运行态快照（跨窗口同步载荷）。
 *
 * @returns 含状态与走秒锚点元数据的完整快照。
 */
export function getPomodoroSyncSnapshot(): PomodoroSyncSnapshot {
  return {
    pomodoro: useAppStore.getState().pomodoro,
    segmentAnchorMs,
    segmentBaseSeconds,
    segmentStartedAt,
    segmentPlannedAtStart
  };
}

/**
 * 应用远端番茄钟快照（跨窗口接收侧）。带字段级类型守卫：旧版本载荷缺
 * 锚点字段时不把 undefined 写进基准（否则本地走秒 NaN、计时器假死）。
 *
 * @param snap - 远端 {@link PomodoroSyncSnapshot}。
 * @returns 无；非法载荷静默忽略。
 */
export function applyRemotePomodoroSnapshot(snap: PomodoroSyncSnapshot) {
  if (!snap || typeof snap.segmentBaseSeconds !== "number") return;
  // 守卫用 `!== undefined` 而不是 typeof：远端暂停/重置/中断时这些字段是合法
  // 的 null（载荷经 JSON 序列化，显式 null 保留、缺失键才是 undefined）。
  // 此前 `typeof === "number"/"string"` 会把 null 当"字段缺失"跳过，接收窗口
  // 保留陈旧锚点——另一屏暂停后本窗口结束专注会把暂停时长计入落库；重置后
  // 再开始时 startedAt 早于真实开始（A-7 口径失真）。
  if (snap.segmentAnchorMs !== undefined) segmentAnchorMs = snap.segmentAnchorMs;
  if (snap.segmentStartedAt !== undefined) segmentStartedAt = snap.segmentStartedAt;
  if (snap.segmentPlannedAtStart !== undefined) segmentPlannedAtStart = snap.segmentPlannedAtStart;
  segmentBaseSeconds = snap.segmentBaseSeconds;
  useAppStore.setState({ pomodoro: { ...useAppStore.getState().pomodoro, ...snap.pomodoro } });
}

/**
 * Whether the pomodoro currently has a valid focus event selected. A task id
 * only counts when the task still exists (deleted tasks no longer count), and
 * a custom event label always counts. Used to enforce "select an event before
 * starting a focus" across every entry point.
 */
function hasFocusEvent(state: { pomodoro: PomodoroState; tasks: Task[] }): boolean {
  const p = state.pomodoro;
  if (p.currentEventLabel) return true;
  if (p.currentTaskId) return state.tasks.some((t) => t.id === p.currentTaskId);
  return false;
}

/**
 * Whether the focus segment is "fresh" (never started): countdown at its full
 * planned duration, or countup at zero. Used to decide when the "select an
 * event before starting" rule applies — resuming a paused session must always
 * work even if its event was later deleted.
 */
function isFreshFocus(p: PomodoroState, config: PomodoroConfig): boolean {
  if (p.mode !== "focus") return false;
  if (p.timerMode === "countup") return p.remainingSeconds === 0;
  return p.remainingSeconds === plannedSecondsFor("focus", config);
}

function persistState(state: AppState) {
  if (persistence.kind === "localStorage") {
    localStorageAdapter.save(state);
    jsonBackupService.createBackup(state);
  }
}

/** 会话/中断内存与 localStorage 记录上限（SQLite 模式落库保留全量，
 *  截断只影响内存统计窗口与浏览器模式的本地日志，防止多年运行后
 *  localStorage 写入串越来越大、每次变更全量 JSON.stringify 开销线性增长）。 */
const SESSIONS_CAP = 500;
const INTERRUPTIONS_CAP = 300;
/* focustimer 借鉴 #5：专注结束前的预告阈值（秒）。 */
const POMODORO_PRE_NOTICE_S = 30;

function tail<T>(arr: T[], cap: number): T[] {
  return arr.length <= cap ? arr : arr.slice(arr.length - cap);
}

/**
 * Persists a completed pomodoro segment. In the Tauri runtime this writes to
 * the SQLite `pomodoro_sessions` table; browser mode keeps the in-memory
 * counter only (no durable session log).
 */
function recordCompletedSession(prev: PomodoroState) {
  const startedAt = segmentStartedAt ?? new Date().toISOString();
  segmentStartedAt = null;
  clearSegmentAnchor();
  // W-051 任务用时归集：把当前专注事件随会话落库，供统计按任务聚合。
  const { currentTaskId, currentEventLabel } = useAppStore.getState().pomodoro;
  // 运行中 ±N 秒的加时并入计划时长（FocusTimer extend 语义：加时即延长的计划）。
  const planned =
    prev.timerMode !== "countup" && segmentPlannedAtStart > 0
      ? Math.max(1, segmentPlannedAtStart + segmentAdjustSeconds)
      : plannedSecondsFor(prev.mode, useAppStore.getState().pomodoroConfig);
  const record = buildSessionRecord({
    id: crypto.randomUUID(),
    mode: prev.mode,
    startedAt,
    endedAt: new Date().toISOString(),
    plannedSeconds: planned,
    completed: true,
    taskId: currentTaskId,
    eventLabel: currentEventLabel
  });
  useAppStore.setState((s) => ({ sessions: tail([...s.sessions, record], SESSIONS_CAP) }));
  if (persistence.kind === "sqlite") {
    sqliteRepo.addSession(record).catch(reportPersistError("addSession"));
  }
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/**
 * 周期 DDL 滚动到下一期（W-049）。从原截止时间按周期步进直到落在当前
 * 时间之后（连漏多期一步滚回未来），保持时分秒；月/年周期做月末钳制
 * 防溢出漂移（A-8：31 日 → 2/28 → 3/31）。
 *
 * @param dueAt - 原 ISO 截止时间。
 * @param repeat - 周期规则（daily/weekly/monthly/yearly）。
 * @returns 新的 ISO 截止时间；解析失败或 repeat=none 原样返回。
 *
 * @example
 * ```ts
 * advanceRepeatDue("2026-01-31T10:00:00Z", "monthly"); // "2026-02-28T…"
 * ```
 */
export function advanceRepeatDue(dueAt: string, repeat: NonNullable<Deadline["repeat"]>): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return dueAt;
  const now = Date.now();
  let guard = 0;
  while (d.getTime() <= now && guard++ < 10000) {
    switch (repeat) {
      case "daily":
        d.setDate(d.getDate() + 1);
        break;
      case "weekly":
        d.setDate(d.getDate() + 7);
        break;
      // A-8：月末溢出漂移（1/31 → 2/31 → 3/3）会影响周期 DDL 的稳定日。
      // 先落到目标月的 1 号，再按「原日 clamped 到该月最后一天」复原，
      // 保持「原日 + 时分秒」语义（31 日 → 2/28 → 3/31 → 4/30 …）。
      case "monthly": {
        const day = d.getDate();
        const targetMonth = d.getMonth() + 1;
        d.setMonth(targetMonth, 1);
        d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
        break;
      }
      case "yearly": {
        const day = d.getDate();
        const month = d.getMonth();
        d.setFullYear(d.getFullYear() + 1, month, 1);
        d.setDate(Math.min(day, daysInMonth(d.getFullYear(), month)));
        break;
      }
      default:
        return dueAt;
    }
  }
  return d.toISOString();
}

export const useAppStore = create<Store>()(
  subscribeWithSelector((set, get) => {
    // 统一双后端写路径：SQLite 模式先落库、成功后才提交内存状态，失败时
    // 界面不变并上报；localStorage 模式立即提交内存再整体持久化。各 CRUD
    // action 的两个分支此前为复制粘贴，收敛到此处以便新增后端时只改一处。
    function writeThrough(context: string, local: () => void, sqlite?: () => Promise<void>) {
      if (persistence.kind === "sqlite") {
        if (sqlite) void sqlite().catch(reportPersistError(context));
        return;
      }
      // localStorage 模式只提交内存：落盘交给下方按 tasks/deadlines/sessions/
      // interruptions 变化触发的 400ms 防抖订阅（pagehide/隐藏时冲刷）。此前这里
      // 还同步 persistState 一次，同一次变更全量 stringify + 备份写两遍。
      local();
    }

    return {
      ...defaults,

      addTask: (title, extra) =>
        writeThrough(
          "addTask",
          () => {
            const task: Task = {
              id: uid(),
              title,
              completed: false,
              createdAt: new Date().toISOString(),
              dueAt: extra?.dueAt ?? "",
              priority: extra?.priority ?? 0,
              tags: extra?.tags ?? [],
              sortOrder: 0
            };
            set((s) => ({ tasks: [...s.tasks, task] }));
          },
          async () => {
            const t = await sqliteRepo.addTask(title, extra);
            set((s) => ({ tasks: [...s.tasks, t] }));
          }
        ),

      toggleTask: (id) =>
        writeThrough(
          "toggleTask",
          () =>
            set((s) => ({
              tasks: s.tasks.map((task) => (task.id === id ? { ...task, completed: !task.completed } : task))
            })),
          async () => {
            const t = await sqliteRepo.toggleTask(id);
            if (t) set((s) => ({ tasks: s.tasks.map((x) => (x.id === id ? t : x)) }));
          }
        ),

      deleteTask: (id) => {
        // persist-first：sqlite 路径先落库成功再改内存，失败时界面不变并提示，
        // 不再出现"看着删了、重启又回来"的静默发散。
        if (hydrating) hydrationTombstones.tasks.add(id);
        const applyRemoval = () =>
          set((s) => ({
            tasks: s.tasks.filter((task) => task.id !== id),
            // If the deleted task was the selected focus event, clear it so the
            // user must pick a valid event before the next focus (and stats stay
            // meaningful).
            pomodoro: s.pomodoro.currentTaskId === id ? { ...s.pomodoro, currentTaskId: null } : s.pomodoro
          }));
        writeThrough("deleteTask", applyRemoval, async () => {
          await sqliteRepo.deleteTask(id);
          applyRemoval();
        });
      },

      clearCompletedTasks: () => {
        const { tasks } = get();
        const doneIds = tasks.filter((t) => t.completed).map((t) => t.id);
        if (doneIds.length === 0) return;
        if (hydrating) doneIds.forEach((id) => hydrationTombstones.tasks.add(id));
        const doneSet = new Set(doneIds);
        const applyClear = () =>
          set((s) => ({
            tasks: s.tasks.filter((t) => !doneSet.has(t.id)),
            pomodoro:
              s.pomodoro.currentTaskId && doneSet.has(s.pomodoro.currentTaskId)
                ? { ...s.pomodoro, currentTaskId: null }
                : s.pomodoro
          }));
        writeThrough("clearCompletedTasks", applyClear, async () => {
          await sqliteRepo.deleteTasks(doneIds);
          applyClear();
        });
      },

      updateTask: (id, patch) =>
        writeThrough(
          "updateTask",
          () => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
          async () => {
            const t = await sqliteRepo.updateTask(id, patch);
            if (t) set((s) => ({ tasks: s.tasks.map((x) => (x.id === id ? t : x)) }));
          }
        ),

      reorderTasks: (orderedIds) => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        const applyRank = () =>
          set((s) => ({ tasks: s.tasks.map((t) => (rank.has(t.id) ? { ...t, sortOrder: rank.get(t.id)! } : t)) }));
        writeThrough("reorderTasks", applyRank, async () => {
          await sqliteRepo.reorderTasks(orderedIds.map((id, i) => ({ id, sortOrder: i })));
          applyRank();
        });
      },

      addDeadline: (title, dueAt, repeat) =>
        writeThrough(
          "addDeadline",
          () => {
            const deadline: Deadline = {
              id: uid(),
              title,
              dueAt,
              notified: false,
              completed: false,
              notifiedTiers: [],
              repeat: repeat ?? "none"
            };
            set((s) => ({ deadlines: [...s.deadlines, deadline] }));
          },
          async () => {
            const d = await sqliteRepo.addDeadline(title, dueAt, repeat);
            set((s) => ({ deadlines: [...s.deadlines, d] }));
          }
        ),

      toggleDeadline: (id) => {
        const cur = get().deadlines.find((d) => d.id === id);
        // W-049：未完成的周期 DDL 勾选 = 完成本期，滚动生成下一期（不标记完成）。
        if (cur && !cur.completed && cur.repeat && cur.repeat !== "none") {
          const next = advanceRepeatDue(cur.dueAt, cur.repeat);
          // A-9：未来到期的周期 DDL 勾选时 advanceRepeatDue 原值返回（due>now 不
          // 步进），若仍走 updateDeadline 会因 patch.dueAt!==undefined 触发
          // resetTiers——三档提醒被清空并连环补发，且什么都不完成。这里直接无操作。
          if (next === cur.dueAt) return;
          useAppStore.getState().updateDeadline(id, { dueAt: next });
          return;
        }
        const applyToggle = () =>
          set((s) => ({ deadlines: s.deadlines.map((d) => (d.id === id ? { ...d, completed: !d.completed } : d)) }));
        writeThrough("toggleDeadline", applyToggle, async () => {
          const d = await sqliteRepo.toggleDeadline(id);
          if (d) set((s) => ({ deadlines: s.deadlines.map((x) => (x.id === id ? d : x)) }));
        });
      },

      deleteDeadline: (id) => {
        if (hydrating) hydrationTombstones.deadlines.add(id);
        const applyRemoval = () => set((s) => ({ deadlines: s.deadlines.filter((d) => d.id !== id) }));
        writeThrough("deleteDeadline", applyRemoval, async () => {
          await sqliteRepo.deleteDeadline(id);
          applyRemoval();
        });
      },

      markDeadlineNotified: (id) => {
        const applyMark = () =>
          set((s) => ({ deadlines: s.deadlines.map((d) => (d.id === id ? { ...d, notified: true } : d)) }));
        writeThrough("markDeadlineNotified", applyMark, async () => {
          await sqliteRepo.markDeadlineNotified(id);
          applyMark();
        });
      },

      updateDeadline: (id, patch) => {
        // 截止时间变化后重置提醒档位，重新走多档提醒链。
        const resetTiers = patch.dueAt !== undefined;
        const applyUpdate = () =>
          set((s) => ({
            deadlines: s.deadlines.map((d) =>
              d.id === id ? { ...d, ...patch, ...(resetTiers ? { notifiedTiers: [], notified: false } : {}) } : d
            )
          }));
        writeThrough("updateDeadline", applyUpdate, async () => {
          const d = await sqliteRepo.updateDeadline(id, patch, resetTiers);
          if (d) set((s) => ({ deadlines: s.deadlines.map((x) => (x.id === id ? d : x)) }));
        });
      },

      setDeadlineTiers: (id, tiers) => {
        // A-14：先本地乐观置位，下一轮提醒 effect 立即看到已发档位、不再重复
        // 触发同档；IPC 失败时回滚到旧值并 reject，供调用方做 in-flight 防重与
        // 重试上限，杜绝 30s 无限连发。
        const prev = get().deadlines.find((d) => d.id === id)?.notifiedTiers ?? [];
        set((s) => ({ deadlines: s.deadlines.map((d) => (d.id === id ? { ...d, notifiedTiers: tiers } : d)) }));
        if (persistence.kind !== "sqlite") {
          persistState(get());
          return Promise.resolve();
        }
        return sqliteRepo.setDeadlineNotifiedTiers(id, tiers).catch((err) => {
          const cur = get().deadlines.find((d) => d.id === id)?.notifiedTiers;
          if (cur && cur.join(",") === tiers.join(",")) {
            set((s) => ({ deadlines: s.deadlines.map((d) => (d.id === id ? { ...d, notifiedTiers: prev } : d)) }));
          }
          reportPersistError("setDeadlineTiers")(err);
          throw err;
        }) as Promise<void>;
      },

      setPomodoroMode: (mode) => {
        const wasRunning = useAppStore.getState().pomodoro.isRunning;
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        set((s) => ({ pomodoro: pomodoroReducer(s.pomodoro, { type: "setMode", mode }, s.pomodoroConfig) }));
        // FocusTimer 借鉴：运行中手动切阶段 = skip（放弃当前段跳到下一阶段）。
        if (wasRunning) emitPomodoroEvent("skip", buildEventContext());
      },

      setPomodoroTimerMode: (timerMode) => {
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        set((s) => ({ pomodoro: pomodoroReducer(s.pomodoro, { type: "setTimerMode", timerMode }, s.pomodoroConfig) }));
      },

      selectPomodoroEvent: (taskId, label) => {
        if (!useAppStore.getState().pomodoro.isRunning) {
          segmentStartedAt = null;
          clearSegmentAnchor();
          segmentAdjustSeconds = 0;
          pausedAtMs = null;
        }
        set((s) => ({
          pomodoro: pomodoroReducer(s.pomodoro, { type: "selectEvent", taskId, label }, s.pomodoroConfig)
        }));
      },

      setPomodoroConfig: (config) => {
        const next = normalizeConfig(config);
        saveConfig(next);
        set((s) => {
          // P2: 运行中修改配置不再静默重置停表丢掉当前专注段。若计时在跑，
          // 只更新配置字段，保留当前段与其 segmentStartedAt；新时长（如
          // focusMinutes 改动）在下一段开始时生效。否则（非运行）才按当前
          // 模式重算剩余秒。
          if (s.pomodoro.isRunning) {
            return { pomodoroConfig: next, pomodoro: s.pomodoro };
          }
          segmentStartedAt = null;
          clearSegmentAnchor();
          segmentAdjustSeconds = 0;
          pausedAtMs = null;
          return {
            pomodoroConfig: next,
            pomodoro: pomodoroReducer(s.pomodoro, { type: "setMode", mode: s.pomodoro.mode }, next)
          };
        });
      },

      adjustPomodoro: (delta) => {
        const state = useAppStore.getState();
        const prev = state.pomodoro;
        if (!prev.isRunning) return false;
        const next = pomodoroReducer(prev, { type: "adjust", delta }, state.pomodoroConfig);
        if (next === prev) return false;
        const applied = next.remainingSeconds - prev.remainingSeconds;
        if (applied === 0) return false;
        segmentAdjustSeconds += applied;
        // 墙钟锚点重排到新基准：此后 tick 从锚点反推的剩余/已过与新计划一致。
        rebaseSegmentAnchor(next.remainingSeconds);
        set({ pomodoro: next });
        return true;
      },

      clearAwaitingActivity: () => {
        if (!useAppStore.getState().pomodoro.awaitingActivity) return;
        set((s) => ({ pomodoro: { ...s.pomodoro, awaitingActivity: false } }));
      },

      togglePomodoro: () => {
        const state = useAppStore.getState();
        let prev = state.pomodoro;
        // FocusTimer 借鉴（会话过期）：暂停超过 2 小时的旧段不再恢复——按放弃
        // 结算（有实际时长则补录未完成会话）后回到全新专注段，用户的这次
        // 「开始」从零起算。休息段不落记录，静默作废。
        if (!prev.isRunning && pausedAtMs != null && Date.now() - pausedAtMs > SESSION_EXPIRY_MS && segmentStartedAt) {
          const elapsed = segmentElapsedSeconds(prev);
          const startedAt = segmentStartedAt;
          const expiredAtIso = new Date(pausedAtMs).toISOString();
          segmentStartedAt = null;
          clearSegmentAnchor();
          segmentAdjustSeconds = 0;
          pausedAtMs = null;
          set((s) => ({ pomodoro: pomodoroReducer(s.pomodoro, { type: "setMode", mode: "focus" }, s.pomodoroConfig) }));
          if (prev.mode === "focus" && elapsed > 0) {
            const partial = buildSessionRecord({
              id: crypto.randomUUID(),
              mode: "focus",
              startedAt,
              endedAt: expiredAtIso,
              plannedSeconds: elapsed,
              completed: false,
              taskId: prev.currentTaskId,
              eventLabel: prev.currentEventLabel
            });
            useAppStore.setState((s) => ({ sessions: tail([...s.sessions, partial], SESSIONS_CAP) }));
            if (persistence.kind === "sqlite") {
              sqliteRepo.addSession(partial).catch(reportPersistError("addSession"));
            }
          }
          prev = useAppStore.getState().pomodoro;
        }
        // Enforce "select an event before starting a focus" across ALL entry
        // points (panel button, tray menu, global shortcut) — but only for a
        // FRESH focus start. Resuming a paused session always works, even if its
        // event was later deleted. Pausing/resuming breaks are unaffected.
        if (isFreshFocus(prev, state.pomodoroConfig) && !hasFocusEvent(state)) {
          return false;
        }
        const resumed = !prev.isRunning && segmentStartedAt != null;
        const next = pomodoroReducer(prev, { type: "toggle" }, state.pomodoroConfig);
        if (next.isRunning && !prev.isRunning) {
          // (重新)开始：首次开始才记录墙钟开始时间（暂停后恢复保留原始开始
          // 时刻，供会话落库），并重设墙钟锚点以排除暂停期间的时间。
          if (!segmentStartedAt) {
            segmentStartedAt = new Date().toISOString();
            segmentPlannedAtStart =
              prev.timerMode === "countdown" ? plannedSecondsFor(prev.mode, state.pomodoroConfig) : 0;
            segmentAdjustSeconds = 0;
          }
          rebaseSegmentAnchor(prev.remainingSeconds);
          pausedAtMs = null;
          emitPomodoroEvent(
            resumed ? "resume" : prev.mode === "focus" ? "focus-start" : "break-start",
            buildEventContext()
          );
        } else if (!next.isRunning && prev.isRunning) {
          // 暂停：把剩余时间冻结到墙钟真实值后清除锚点，暂停时长不再计入。
          const paused = { ...next, remainingSeconds: wallRemaining(prev) };
          clearSegmentAnchor();
          pausedAtMs = Date.now();
          set({ pomodoro: paused });
          emitPomodoroEvent("pause", buildEventContext());
          return true;
        }
        set({ pomodoro: next });
        return true;
      },

      resetPomodoro: () => {
        const state = useAppStore.getState();
        const prev = state.pomodoro;
        const hadSegment = prev.isRunning || segmentStartedAt != null;
        // P3: 重置后必须清空 segmentStartedAt，否则「开始→暂停→重置→再开始」
        // 因 !segmentStartedAt 为假而不更新开始时间，新段结束时 recordCompletedSession
        // 会用陈旧 startedAt 录错专注时长（甚至跨多个段）。
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        set((s) => ({ pomodoro: pomodoroReducer(s.pomodoro, { type: "reset" }, s.pomodoroConfig) }));
        if (hadSegment) emitPomodoroEvent("stop", buildEventContext());
      },

      tickPomodoro: () => {
        const state = useAppStore.getState();
        const prev = state.pomodoro;
        if (!prev.isRunning) return;
        const config = state.pomodoroConfig;
        // A-1 墙钟校正：每次 tick 从锚点反推真实剩余/已过秒数，睡眠/后台节流
        // 后唤醒即校正，而非依赖 tick 次数。正计时只累积、永不自动完成。
        const remaining = wallRemaining(prev);
        if (prev.timerMode !== "countdown" || remaining > 0) {
          // focustimer 借鉴 #5（结束前预告）：专注段跨越 30s 阈值时预告一次。
          // 「上次 >30 && 本次 ≤30」的跨越判定天然单发，不受后台丢 tick 影响。
          if (
            prev.mode === "focus" &&
            prev.isRunning &&
            prev.remainingSeconds > POMODORO_PRE_NOTICE_S &&
            remaining <= POMODORO_PRE_NOTICE_S
          ) {
            pomodoroNotification({
              kind: "upcoming",
              title: t("即将完成"),
              body: t("距离本次专注结束还有 30 秒，准备收尾。")
            });
          }
          set({ pomodoro: { ...prev, remainingSeconds: remaining } });
          return;
        }
        // 倒计时到 0：复用纯 reducer 的完成递进分支（模式轮换/autoCycle 语义一致）。
        const next = pomodoroReducer({ ...prev, remainingSeconds: 0 }, { type: "tick" }, config);
        recordCompletedSession(prev);
        // 完成信号（见 Store 注释）：供 App.tsx 的通知器判定，替代「remaining
        // 跳回满额」推断——该推断无法与中断/重置区分。
        set({
          pomodoro: next,
          pomodoroCompletedSeq: state.pomodoroCompletedSeq + 1,
          pomodoroLastCompletedMode: prev.mode
        });
        // FocusTimer 借鉴：阶段完成事件；下一段若已自动开始，紧随其后发
        // 对应的 start 事件（媒体联动/自动化规则依赖这对语义）。
        emitPomodoroEvent(prev.mode === "focus" ? "focus-finish" : "break-finish", buildEventContext());
        // 若下一段自动开始（autoStartNext），立即为其建立新的墙钟锚点。
        if (next.isRunning) {
          segmentStartedAt = new Date().toISOString();
          segmentPlannedAtStart = next.timerMode === "countdown" ? next.remainingSeconds : 0;
          segmentAdjustSeconds = 0;
          rebaseSegmentAnchor(next.remainingSeconds);
          emitPomodoroEvent(next.mode === "focus" ? "focus-start" : "break-start", buildEventContext());
        } else if (next.awaitingActivity) {
          // 推进门 wait-activity：若此刻用户在场（presence active）直接开始，
          // 否则等 GlobalActivityGate 的 presence 翻转事件。
          void invoke<{ state: "active" | "idle" | "fullscreen" }>("get_presence_state")
            .then((snap) => {
              const cur = useAppStore.getState();
              if (snap?.state === "active" && cur.pomodoro.awaitingActivity && !cur.pomodoro.isRunning) {
                cur.togglePomodoro();
              }
            })
            .catch(() => {
              // presence 查询失败保持等待态，由 presence:state 事件兜底
            });
        }
      },

      interruptPomodoro: (reason) => {
        const state = useAppStore.getState();
        const prev = state.pomodoro;
        if (prev.mode !== "focus" || !prev.isRunning) return;
        const startedAt = segmentStartedAt ?? new Date().toISOString();
        const endedAt = new Date().toISOString();
        // A-7：中断已过时长用墙钟锚点计，而非 currentConfig 回算——运行中改了
        // 专注时长不会再把几十秒的中断虚报成几分钟。±N 加时并入计划口径。
        const planned =
          segmentPlannedAtStart > 0
            ? segmentPlannedAtStart + segmentAdjustSeconds
            : plannedSecondsFor("focus", state.pomodoroConfig);
        const elapsed = prev.timerMode === "countup" ? wallRemaining(prev) : Math.max(0, planned - wallRemaining(prev));
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        const interruption = buildInterruption({ startedAt, endedAt, reason, elapsedSeconds: elapsed });
        const next = pomodoroReducer(prev, { type: "interrupt" }, state.pomodoroConfig);
        // FocusTimer 借鉴（75% 完成阈值）：被放弃的专注段若净时长已达标，
        // 按完成结算（completed:true + 计入轮数触发长休判定），不再恒记放弃。
        const thresholdCompleted = prev.timerMode !== "countup" && isFocusCompleted(elapsed, planned);
        const settled: PomodoroState = thresholdCompleted
          ? { ...next, completedFocusSessions: next.completedFocusSessions + 1 }
          : next;
        set({
          pomodoro: settled,
          interruptions: tail([...state.interruptions, interruption], INTERRUPTIONS_CAP)
        });
        // A-16 / A-26：中断且已有实际专注时长时补落一条会话，让「今日放弃」
        // 指标不再恒为 0；达标段 completed:true（分钟数口径不受影响）。
        if (elapsed > 0) {
          const partial = buildSessionRecord({
            id: crypto.randomUUID(),
            mode: "focus",
            startedAt,
            endedAt,
            plannedSeconds: elapsed,
            completed: thresholdCompleted,
            taskId: prev.currentTaskId,
            eventLabel: prev.currentEventLabel
          });
          useAppStore.setState((s) => ({ sessions: tail([...s.sessions, partial], SESSIONS_CAP) }));
          if (persistence.kind === "sqlite") {
            sqliteRepo.addSession(partial).catch(reportPersistError("addSession"));
          }
        }
        if (persistence.kind === "sqlite") {
          sqliteRepo.addInterruption(interruption).catch(reportPersistError("addInterruption"));
        } else {
          persistState(get());
        }
        emitPomodoroEvent("interrupt", buildEventContext());
      },

      stopCountupFocus: () => {
        const state = useAppStore.getState();
        const prev = state.pomodoro;
        // Only a countup focus segment can be "ended" here. Guard against any
        // accidental invocation from other states (no-op instead of toggling).
        if (prev.mode !== "focus" || prev.timerMode !== "countup") return;
        // A-6：已过时长用墙钟锚点（而非 tick 计数的 remainingSeconds），后台
        // 节流丢 tick 后仍记录准确专注秒数。
        const elapsed = wallRemaining(prev);
        // Nothing elapsed yet -> nothing to record (no-op, don't start the timer).
        if (elapsed === 0) return;
        const startedAt = segmentStartedAt ?? new Date().toISOString();
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        const record = buildSessionRecord({
          id: crypto.randomUUID(),
          mode: "focus",
          startedAt,
          endedAt: new Date().toISOString(),
          plannedSeconds: elapsed, // actual elapsed seconds in countup mode
          completed: true,
          taskId: prev.currentTaskId,
          eventLabel: prev.currentEventLabel
        });
        // Ending a countup focus behaves like a completed focus: record the
        // session and advance the counter. The next focus keeps the same event
        // and the countup preference, and the timer resets so a fresh focus
        // starts at 0 — a single-focus pomodoro has no automatic break cycle.
        const completed = prev.completedFocusSessions + 1;
        const next: PomodoroState = {
          mode: "focus",
          timerMode: "countup",
          focusTimerMode: "countup",
          remainingSeconds: 0,
          isRunning: false,
          awaitingActivity: false,
          completedFocusSessions: completed,
          currentTaskId: prev.currentTaskId,
          currentEventLabel: prev.currentEventLabel
        };
        // Tell the user the focus was recorded (the milestone notifier can't catch
        // a manual stop because it only reacts to reducer-driven changes).
        pomodoroNotification({ kind: "complete", title: t("专注完成"), body: t("本次专注已记录。") });
        // 手动结束 = stop 语义（媒体联动恢复音乐、自动化规则消费）。
        emitPomodoroEvent("stop", buildEventContext());
        set({ pomodoro: next, sessions: tail([...state.sessions, record], SESSIONS_CAP) });
        if (persistence.kind === "sqlite") {
          sqliteRepo.addSession(record).catch(reportPersistError("addSession"));
        } else {
          persistState(get());
        }
      },

      importData: async (raw) => {
        try {
          const imported = await jsonBackupService.importJson(raw);
          // persist-first（本文件头注释的协议）：先落盘成功再提交内存。此前的
          // 顺序是 set → fire-and-forget 落库、返回值与持久化结果无关——写链被
          // 60s 超时 / SQLITE_BUSY 卡住时 UI 显示导入成功、重启即回档。
          // 用 replaceCoreDataKeepSessions 保留库中全量会话记录（内存 sessions
          // 被 SESSIONS_CAP 截断，直接回写会误删 >500 条历史）。番茄钟状态不在
          // replaceCoreData 范围内，写一份一次性快照供下次启动恢复。
          // 导出时若番茄钟正在运行，快照里 isRunning 为 true；导入后走秒依赖的
          // 模块级墙钟锚点并未重建——UI 显示"运行中"却永远冻结、也永不完成。
          // 一律以"暂停在导出时刻的剩余"落地，并清掉本窗口可能残留的旧锚点。
          const importedPomodoro = { ...imported.pomodoro, isRunning: false };
          if (persistence.kind === "sqlite") {
            await sqliteRepo.replaceCoreDataKeepSessions({ tasks: imported.tasks, deadlines: imported.deadlines });
            try {
              localStorage.setItem(POMODORO_SNAPSHOT_KEY, JSON.stringify(importedPomodoro));
            } catch {
              // best-effort
            }
          }
          clearSegmentAnchor();
          segmentStartedAt = null;
          set({ tasks: imported.tasks, deadlines: imported.deadlines, pomodoro: importedPomodoro });
          persistState(get());
          return true;
        } catch (err) {
          reportPersistError("importData")(err);
          return false;
        }
      },

      importTasksCsv: async (raw) => {
        try {
          const imported = parseTasksCsv(raw);
          if (imported.length === 0) return false;
          const s = get();
          const existing = new Set(s.tasks.map((t) => t.id));
          const fresh = imported.filter((t) => !existing.has(t.id));
          const tasks = [...s.tasks, ...fresh];
          // persist-first：先整表写回 SQLite 再提交内存（见 importData）。
          if (persistence.kind === "sqlite") {
            await sqliteRepo.replaceCoreDataKeepSessions({ tasks, deadlines: s.deadlines });
          }
          set({ tasks });
          persistState(get());
          return true;
        } catch (err) {
          reportPersistError("importTasksCsv")(err);
          return false;
        }
      },

      importDeadlinesCsv: async (raw) => {
        try {
          const imported = parseDeadlinesCsv(raw);
          if (imported.length === 0) return false;
          const s = get();
          const existing = new Set(s.deadlines.map((d) => d.id));
          const fresh = imported.filter((d) => !existing.has(d.id));
          const deadlines = [...s.deadlines, ...fresh];
          // persist-first：先整表写回 SQLite 再提交内存（见 importData）。
          if (persistence.kind === "sqlite") {
            await sqliteRepo.replaceCoreDataKeepSessions({ tasks: s.tasks, deadlines });
          }
          set({ deadlines });
          persistState(get());
          return true;
        } catch (err) {
          reportPersistError("importDeadlinesCsv")(err);
          return false;
        }
      }
    };
  })
);

// For browser (localStorage) mode: persist sessions and interruptions to a separate
// localStorage key because they're not part of the AppStateSchema (which is only
// tasks + deadlines + pomodoro state). This keeps the schema stable while the
// log grows incrementally (full export in backups/imports).
//
// 写入带 400ms 尾随防抖：拖拽排序 / CSV 导入 / 连续勾选会在短时间内触发
// 若干次变更，逐次全量 JSON.stringify + localStorage.setItem + 建份 JSON
// 备份是同步阻塞主线程的；合并成静默期后的一次写入。页面隐藏或关闭时
// 立即冲刷，保证最后一批变更不丢。
const PERSIST_DEBOUNCE_MS = 400;
let persistTimer = 0;

function flushPersistNow() {
  if (persistTimer) {
    window.clearTimeout(persistTimer);
    persistTimer = 0;
  }
  if (persistence.kind !== "localStorage") return;
  // Read the FULL current state — the selector only decides WHEN this runs.
  const full = useAppStore.getState();
  localStorageAdapter.save(full);
  try {
    localStorage.setItem(
      LOG_KEY,
      JSON.stringify({
        sessions: full.sessions,
        interruptions: full.interruptions
      })
    );
  } catch {
    // best-effort
  }
  jsonBackupService.createBackup(full);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersistNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistNow();
  });
}

useAppStore.subscribe(
  // Select only the fields that represent durable business data. Excluding the
  // volatile `pomodoro` object (a fresh reference every 1s tick) means the
  // listener no longer JSON.stringify + localStorage-save + createBackup on
  // every pomodoro second — only when tasks/deadlines/sessions/interruptions
  // actually change. (Sessions/interruptions are the persisted pomodoro record.)
  (state) => ({
    tasks: state.tasks,
    deadlines: state.deadlines,
    sessions: state.sessions,
    interruptions: state.interruptions
  }),
  () => {
    if (persistence.kind !== "localStorage") return;
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(flushPersistNow, PERSIST_DEBOUNCE_MS);
  },
  // Use shallow equality so the listener fires only when the selected fields
  // actually change (not on every 1-second pomodoro tick that only touches
  // `elapsed`/`remaining` — those are outside the selector).
  { equalityFn: shallow }
);

// A-15：仅当用户「设置类」瞬态字段实际变化时（选择任务/事件、切换模式、
// 累积轮次）才写快照，忽略每秒的 remainingSeconds/isRunning 跳动。
useAppStore.subscribe(
  (state) => ({
    mode: state.pomodoro.mode,
    timerMode: state.pomodoro.timerMode,
    focusTimerMode: state.pomodoro.focusTimerMode,
    completedFocusSessions: state.pomodoro.completedFocusSessions,
    currentTaskId: state.pomodoro.currentTaskId,
    currentEventLabel: state.pomodoro.currentEventLabel
  }),
  (snap) => {
    try {
      localStorage.setItem(POMODORO_STATE_KEY, JSON.stringify(snap));
    } catch {
      // best-effort
    }
  },
  { equalityFn: shallow }
);

/**
 * 导入后写入、下次启动消费的番茄钟一次性快照。SQLite 的
 * replaceCoreData 不含 pomodoro 状态（计时态本就按会话落库），导入若只
 * 改内存，重启后导入的番茄钟进度即丢失；写一份一次性快照，hydrate 时
 * 读取并清除，避免陈旧状态在后续启动被反复复活。
 */
const POMODORO_SNAPSHOT_KEY = "focus-desk.pomodoro-snapshot.v1";

// A-15：SQLite 模式的 load() 只返回 tasks/deadlines，不返回 pomodoro。重启后
// currentTaskId / 专注事件标签 / 长休轮换计数（completedFocusSessions）等
// 「用户设置好、未随会话落库」的瞬态会回落默认值。这些偏好写入独立
// localStorage 键，hydrate 时恢复；运行中的倒计时（isRunning/remainingSeconds）
// 不恢复——重启后从该模式的新鲜起点开始，避免用不可信的墙钟续跑旧片段。
const POMODORO_STATE_KEY = "focus-desk.pomodoro-state.v1";

type PomodoroSetupSnapshot = Pick<
  PomodoroState,
  "mode" | "timerMode" | "focusTimerMode" | "completedFocusSessions" | "currentTaskId" | "currentEventLabel"
>;

function loadPomodoroSetup(): PomodoroSetupSnapshot | null {
  try {
    const raw = localStorage.getItem(POMODORO_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as PomodoroSetupSnapshot;
  } catch {
    return null;
  }
}

function restorePomodoroSetup(snap: PomodoroSetupSnapshot, config: PomodoroConfig): PomodoroState {
  const mode: PomodoroMode = snap.mode === "shortBreak" || snap.mode === "longBreak" ? snap.mode : "focus";
  const timerMode: PomodoroTimerMode = snap.timerMode === "countup" ? "countup" : "countdown";
  const focusTimerMode: PomodoroTimerMode = snap.focusTimerMode === "countup" ? "countup" : "countdown";
  const completedFocusSessions = Number.isFinite(snap.completedFocusSessions)
    ? Math.max(0, Math.floor(snap.completedFocusSessions as number))
    : 0;
  return {
    mode,
    timerMode,
    focusTimerMode,
    remainingSeconds: timerMode === "countup" ? 0 : plannedSecondsFor(mode, config),
    isRunning: false,
    completedFocusSessions,
    currentTaskId: typeof snap.currentTaskId === "string" ? snap.currentTaskId : null,
    currentEventLabel: typeof snap.currentEventLabel === "string" ? snap.currentEventLabel : null,
    // 等待回座态不跨重启恢复：重启后用户手动开始。
    awaitingActivity: false
  };
}

/**
 * 从活动持久化后端水合 store（启动时调用一次）。
 * Tauri 环境：先跑一次性 localStorage→SQLite 迁移，再读任务/截止/会话/
 * 打断，并触发每日滚动备份（镜像先同步，补齐便签等盲区）。合并语义：
 * 水合窗口内用户操作后的本地状态在 id 冲突时获胜、tombstone 剔除已删
 * （A-5），慢水合期间已启动的计时不被覆盖。
 *
 * @returns 水合完成后 resolve；失败仅记日志（界面以默认状态放行）。
 * @throws 无。
 */
export async function hydrateApp(): Promise<void> {
  hydrating = true;
  hydrationTombstones.tasks.clear();
  hydrationTombstones.deadlines.clear();
  try {
    persistence = resolvePersistenceAdapter();
    let loaded: Partial<AppState> | null = null;
    let sessions: PomodoroSessionRecord[] = [];
    let interruptions: PomodoroInterruption[] = [];
    if (persistence.kind === "sqlite") {
      // 单例职责（与 tick/通知/托盘同一约定）：一次性迁移与每日备份只由主窗口
      // （widget-0）执行。此前 settings / 各屏 widget-N 每个窗口都跑一遍：迁移
      // 并发双跑有重复插入风险，镜像 flush + createBackup 也 ×N。非主窗口在读库
      // 前短暂等迁移 flag（localStorage 各窗口共享），避免读到迁移前的空表。
      const primary = isPrimaryWidgetWindow();
      if (primary) await migrateLocalStorageToSqlite();
      else await waitForMigration(1500);
      // 三路读互不依赖（tasks/deadlines 在 adapter 内部已并行）：此前串行 await
      // 让首帧时间 = 3 个 SQLite 命令 RTT 之和，慢盘/大库时被 4s 安全网兜底的
      // 风险也随串行长度放大。
      [loaded, sessions, interruptions] = await Promise.all([
        persistence.load(),
        sqliteRepo.listSessions().then((rows) => tail(rows, SESSIONS_CAP)),
        sqliteRepo.listInterruptions().then((rows) => tail(rows, INTERRUPTIONS_CAP))
      ]);
      // Daily rolling auto-backup (Rust side dedups per-day and prunes old files).
      // The localStorage mirror is synced FIRST so notes/habits/bookmarks/widget
      // configs ride along in the backup file instead of being a blind spot.
      if (flags.autoBackup && primary) {
        flushMirrorSync()
          // A-31: mirror failure means notes/habits/bookmarks silently miss the
          // backup — surface it instead of swallowing so the user is at least
          // aware the next backup was incomplete.
          .catch(reportPersistError("mirrorSync"))
          .finally(() => sqliteRepo.createBackup().catch(reportPersistError("createBackup")));
      }
    } else {
      loaded = await persistence.load();
      ({ sessions, interruptions } = loadLog());
    }
    // 若用户在慢速 hydration 完成前已手动启动计时，则不覆盖其运行状态，
    // 避免静默取消正在进行的专注会话。
    const current = useAppStore.getState();
    const isRunning = current.pomodoro?.isRunning ?? false;
    // A-5 水合合并：本地（hydration 窗口内用户操作后的较新状态）在 id 冲突时
    // 获胜，库中快照只补齐本地不存在的 id；被 tombstone 标记的 id（窗口内已删）
    // 从库快照中剔除，避免删除复活。默认空列表场景下 local 为空，等价于整包采纳。
    const mergeById = <T extends { id: string }>(local: T[], remote: T[], tombstones: Set<string>): T[] => {
      const localIds = new Set(local.map((x) => x.id));
      const out = local.slice();
      for (const r of remote) {
        if (tombstones.has(r.id) || localIds.has(r.id)) continue;
        out.push(r);
      }
      return out;
    };
    let importedPomodoro: AppState["pomodoro"] | undefined;
    try {
      const snap = localStorage.getItem(POMODORO_SNAPSHOT_KEY);
      if (snap) {
        localStorage.removeItem(POMODORO_SNAPSHOT_KEY);
        const parsed = JSON.parse(snap);
        if (parsed && typeof parsed === "object") importedPomodoro = parsed as AppState["pomodoro"];
      }
    } catch {
      // best-effort
    }
    // A-15：SQLite 模式 load() 不返回 pomodoro；从快照恢复「设置类」瞬态
    // （任务/事件选择、计时模式、长休轮换计数），运行态仍从新鲜起点开始。
    let restoredSetup: PomodoroState | undefined;
    if (persistence.kind === "sqlite") {
      const setup = loadPomodoroSetup();
      if (setup) restoredSetup = restorePomodoroSetup(setup, loadConfig());
    }
    // 字段级合并：只覆写水合真正提供的字段。此前 `...defaults` 整包铺底会把
    // 水合窗口内的其他状态（pomodoroConfig 修改、pomodoroCompletedSeq 完成信号等）
    // 打回模块加载期的默认值——A-5 的 tombstone 只保护了 tasks/deadlines。
    // 注意 current 是本轮 await 之后的最新快照（上方 getState），不是入口时的。
    // 会话/中断记录同理：水合窗口（非主窗口最长可空等 1.5s）内用户完成或中断的
    // 段已 append 进内存，此前被库快照无条件顶掉——SQLite 模式只是本次运行统计
    // 不显示，localStorage 模式随后的防抖落盘会用被覆盖后的列表写回 LOG_KEY，
    // 真正丢失。以库快照为底、补上内存里库中没有的 id，再按上限截尾。
    const mergeLog = <T>(remote: T[], local: T[], cap: number, keyOf: (x: T) => string): T[] => {
      const seen = new Set(remote.map(keyOf));
      const out = remote.slice();
      for (const l of local) if (!seen.has(keyOf(l))) out.push(l);
      return tail(out, cap);
    };
    useAppStore.setState({
      tasks: mergeById(current.tasks, loaded?.tasks ?? [], hydrationTombstones.tasks),
      deadlines: mergeById(current.deadlines, loaded?.deadlines ?? [], hydrationTombstones.deadlines),
      sessions: mergeLog(sessions, current.sessions, SESSIONS_CAP, (s) => s.id),
      // 中断记录的 TS 形状没有 id：按起止时刻作键（同一段中断不可能有两条）。
      interruptions: mergeLog(
        interruptions,
        current.interruptions,
        INTERRUPTIONS_CAP,
        (i) => `${i.startedAt}|${i.endedAt}`
      ),
      pomodoro: { ...defaults.pomodoro, ...restoredSetup, ...importedPomodoro, ...loaded?.pomodoro, isRunning }
    });
  } finally {
    hydrating = false;
  }
}

function loadLog(): { sessions: PomodoroSessionRecord[]; interruptions: PomodoroInterruption[] } {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return { sessions: [], interruptions: [] };
    const parsed = JSON.parse(raw) as { sessions?: PomodoroSessionRecord[]; interruptions?: PomodoroInterruption[] };
    return {
      sessions: tail(Array.isArray(parsed.sessions) ? parsed.sessions : [], SESSIONS_CAP),
      interruptions: tail(Array.isArray(parsed.interruptions) ? parsed.interruptions : [], INTERRUPTIONS_CAP)
    };
  } catch {
    return { sessions: [], interruptions: [] };
  }
}

export type { Task, Deadline, PomodoroState };
