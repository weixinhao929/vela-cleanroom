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
import { isSameVirtualDay, virtualDayKey } from "../domain/analytics";
import { flags } from "../domain/flags";
import { t } from "../i18n-lite";
import { pomodoroNotification } from "../lib/notifications";
import { isPersistSuspended } from "../lib/persist-gate";
import { useSettingsStore } from "./settings-store";
import type { AppState, Deadline, PomodoroMode, Task } from "../domain/schemas";
import {
  resolvePersistenceAdapter,
  localStorageAdapter,
  sqliteRepo,
  type PersistenceAdapter
} from "../lib/persistence";
import { migrateLocalStorageToSqlite, waitForMigration } from "../lib/persistence/migration";
import { isPrimaryWidgetWindow, invoke } from "../lib/tauri";
import { withRemoteApply } from "../lib/sync-gate";
import { dayKeyOf } from "../lib/use-now";
import { readPendingPayloads, tryMarkOnce } from "../lib/remind-dedupe";
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
  /* 恢复备份进行中不写共享 LS（/
     writePomodoroLiveSnapshot 同款早退口径）——闸门只挡「写共享 LS」，
     内存态由调用方照常跟进（恢复以 reload 收尾，新内存态接管落盘）。 */
  if (isPersistSuspended()) return;
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
  /** extra 携带截止/优先级/标签（均可选）。 */
  addTask(title: string, extra?: { dueAt?: string; priority?: number; tags?: string[] }): void;
  toggleTask(id: string): void;
  deleteTask(id: string): void;
  clearCompletedTasks(): void;
  /** 行内编辑：局部更新任务字段。 */
  updateTask(id: string, patch: { title?: string; dueAt?: string; priority?: number; tags?: string[] }): void;
  /** 手动排序：按展示顺序覆写 sortOrder。 */
  reorderTasks(orderedIds: string[]): void;
  addDeadline(title: string, dueAt: string, repeat?: Deadline["repeat"]): void;
  /** 周期 DDL 勾完成时自动滚动到下一期而非标记完成。 */
  toggleDeadline(id: string): void;
  deleteDeadline(id: string): void;
  markDeadlineNotified(id: string): void;
  /** 行内编辑 DDL：局部更新标题/截止/周期。 */
  updateDeadline(id: string, patch: { title?: string; dueAt?: string; repeat?: Deadline["repeat"] }): void;
  /** 多档提醒：覆写已发送档位集合。返回的 Promise 在持久化成功时
   *  resolve、失败时 reject（失败已回滚乐观置位），供调用方做 in-flight 防重
   *  与重试上限。 */
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
  /** @param beatMs 心跳拍号（Rust now_ms）：failover 双主时两窗口收到同一拍，
   *  完成段落库按拍号跨窗去重（见 recordCompletedSession）。 */
  tickPomodoro(beatMs?: number): void;
  interruptPomodoro(reason: InterruptionReason): void;
  /** 运行中加时/回拨（±N 秒；倒计时剩余保底 10s）。
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
// 墙钟校正：当前「运行中」片段的锚点时间戳，以及锚定时刻的
// remaining/elapsed 基准值。每次 tick 都从真实墙钟反推 remaining，系统
// 睡眠 / 后台节流导致 tick 停摆后，唤醒即刻把倒计时拉回正确值。锚点在
// (重新)开始时重设、暂停时清除，从而暂停时间不被计入。
let segmentAnchorMs: number | null = null;
let segmentBaseSeconds = 0;
// 当前倒计时片段在「首次开始」时刻的 planned 时长（跨暂停保持不变）。
// 中断时长据它扣除墙钟剩余而来，因此不受运行中修改专注时长的影响。
let segmentPlannedAtStart = 0;
// （extend/rewind）：当前段累计的手动加时秒数（负数为回拨）。
// 段落落库时并入 plannedSeconds，中断已过时长据「计划+加时-剩余」计算。
let segmentAdjustSeconds = 0;
// （会话过期）：暂停发生时刻。恢复时若已暂停超过
// SESSION_EXPIRY_MS，旧段按放弃结算（补录未完成会话）并从新段开始，
// 避免「挂了一夜的半截会话」跨日污染统计。
let pausedAtMs: number | null = null;
const SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000;
/* （暂停回滚竞态）：番茄钟控制纪元。任一窗口执行用户控制动作（开始/
 * 暂停/切换阶段/中断/重置/加时…）时自增，并随每次 sync:pomodoro 广播；
 * 接收方丢弃纪元更旧的包——5s 锚点包的 wallMs 恰好横跨「迷你窗发暂停包」
 * 时，wallMs 仲裁会把两窗一致回滚到运行态，纪元让控制态包无条件获胜。
 * 纪元以启动时刻为基——若从 0 计数，单窗 reload 后归零，长驻老窗口
 * （历史动作累计的旧计数）会永久拒收其一切包，直到老窗口自己再执行一次
 * 动作。基线取墙钟、每次动作抬到 max(+1, now)，最新启动的窗口天然拥有
 * 最高纪元，reload 即交接控制权。 */
let pomodoroControlEpoch = Date.now();
/* 本地最后一次**控制动作**的墙钟（bump 时同步记录）。
 * 锚点包仲裁的第三基准：本地已暂停/开始而自身回声未到的窗口里，早于该
 * 时刻的锚点（发送方尚未收到我们的控制包）不得回滚本地控制态。基线
 * （Date.now() 起步）不抬此值——重载窗口无本地动作时为 0，锚点采纳
 * 不受影响。 */
let lastLocalControlWallMs = 0;
/* 配套：本窗口是否已应用过远端 sync:pomodoro 快照。hydrateApp 的晚到
 * 水合此前无条件用 defaults+restoredSetup 整包替换 pomodoro 字段，会把启动
 * 后已落地的远端运行态顶掉（仅保留 isRunning）。置位后水合跳过 pomodoro 恢复。 */
let remotePomodoroApplied = false;
// hydrateApp 是长异步链，期间 UI 已可交互。若用户在 hydration 完成前
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

/** 控制纪元自增（每个用户控制动作调用一次；订阅广播随包携带，见声明处注释）。 */
function bumpPomodoroControlEpoch(): void {
  pomodoroControlEpoch = Math.max(pomodoroControlEpoch + 1, Date.now());
  lastLocalControlWallMs = Date.now();
}

/** 当前控制纪元（跨窗接收方在回声到达前即可比对本地值，消除仲裁空窗）。 */
export function getPomodoroControlEpoch(): number {
  return pomodoroControlEpoch;
}

/** 本地最后一次控制动作的墙钟；0 = 本窗口尚未执行过控制动作。 */
export function getLastLocalControlWallMs(): number {
  return lastLocalControlWallMs;
}

/** 当前段的计划秒数（段首计划 ± 加时）；无进行段返回 null。UI 的
 *  「暂停中可中断」启发式此前用当前配置比较暂停时冻结的旧剩余——暂停期间
 *  热更配置（如调小 focusMinutes）会让按钮凭空消失/误现。 */
export function getSegmentPlannedSeconds(): number | null {
  return segmentPlannedAtStart > 0 ? segmentPlannedAtStart + segmentAdjustSeconds : null;
}

/** 是否存在「运行中或暂停中」的段（段锚点在位）。中断入口启发式的
 *  前置条件——空闲态（无锚点）下 planned==null 不能单独作「有进度」判据，
 *  否则「记录中断」按钮在全新启动/正计结束切回时凭空出现且点击 no-op。
 *  R-前端-6（复审）顺序契约：锚点变量（本模块级）不随 store 走、其变化
 *  不触发订阅重算——所有写路径必须「先清/设锚点、后 set store」，selector
 *  重算时才读到一致值；新增路径若先 set 后动锚点，按钮显示会陈旧一拍。 */
export function hasFocusSegmentAnchor(): boolean {
  return segmentStartedAt != null || pausedAtMs != null;
}

/**
 * （会话写入可靠性）：SQLite 写失败重试后再上报。会话/中断写入此前是
 * fire-and-forget——IPC 抖动一次内存已记完成、DB 永久缺行，重启即消失。
 * 瞬时失败重试两次（退避 300ms/1s），仍失败走 reportPersistError（UI 有
 * toast 提示），内存记录保留——统计口径以内存为准直到下次启动，用户可见
 * 且回报，而不是静默丢失。
 */
async function persistWithRetry<T>(op: string, run: () => Promise<T>): Promise<void> {
  const delays = [300, 1000];
  for (let attempt = 0; ; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt >= delays.length) {
        reportPersistError(op)(err);
        return;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
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

/** 今日完成轮数的按引用缓存：Zustand 不可变更新语义下 sessions
 *  数组只在真正变更时换引用；sessions 引用 + 虚拟日键 + vmHour 三者都没变
 *  时直接复用上一轮 filter 结果——自动化引擎随 pomodoro 逐拍求值（运行期
 *  1Hz）不再对最多 500 条记录反复 filter + isSameVirtualDay。墙钟跨过虚拟
 *  午夜（vmHour 点）由虚拟日键变化自然失效。 */
let completedTodayCache: {
  sessions: PomodoroSessionRecord[];
  vmHour: number;
  day: string;
  count: number;
} | null = null;

function completedTodayOf(sessions: PomodoroSessionRecord[], vmHour: number, now: Date): number {
  const day = virtualDayKey(now, vmHour);
  const hit = completedTodayCache;
  if (hit && hit.sessions === sessions && hit.vmHour === vmHour && hit.day === day) return hit.count;
  // 归日锚点用 startedAt——与面板/SQL 统计「按起始虚拟日归组」的统一
  // 口径一致（此前按 endedAt，跨虚拟午夜完成的段在自动化条件与面板相差
  // 1 轮，可能提前/推迟一天触发规则）。
  const count = sessions.filter(
    (rec) => rec.type === "focus" && rec.completed && isSameVirtualDay(new Date(rec.startedAt), now, vmHour)
  ).length;
  completedTodayCache = { sessions, vmHour, day, count };
  return count;
}

/** 事件上下文快照（emitPomodoroEvent 用）：自动化引擎 / 媒体联动的只读输入。 */
function buildEventContext(): PomodoroEventContext {
  const s = useAppStore.getState();
  const p = s.pomodoro;
  const hasSegment = p.isRunning || segmentStartedAt != null;
  // 今日完成轮数按虚拟午夜归日（与面板/SQL 统计同口径），
  // 此前用自然午夜——vmHour=2/4 时凌晨完成的段在自动化条件与统计图里归属
  // 不同天。
  const vmHour = useSettingsStore.getState().extra.virtualMidnightHour ?? 0;
  const now = new Date();
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
    completedToday: completedTodayOf(s.sessions, vmHour, now)
  };
}

/** 供自动化引擎在事件之外（tick 节拍）求值条件用的公开快照（与 emit 载荷同构）。 */
export function getPomodoroEventContext(): PomodoroEventContext {
  return buildEventContext();
}

/**
 * 跨窗口番茄钟快照：番茄钟命令（开始/暂停/选任务/重置）可来自任一
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
  /** 加时累计与暂停时刻随快照走——命令可来自任一窗口，结算口径
   *  （interrupt 的 planned=plannedAtStart+adjust、暂停过期判定）不再漂移。 */
  segmentAdjustSeconds: number;
  pausedAtMs: number | null;
  /** 控制纪元（见 pomodoroControlEpoch 声明处注释）。 */
  controlEpoch: number;
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
    segmentPlannedAtStart,
    segmentAdjustSeconds,
    pausedAtMs,
    controlEpoch: pomodoroControlEpoch
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
  // 再开始时 startedAt 早于真实开始（口径失真）。
  if (snap.segmentAnchorMs !== undefined) segmentAnchorMs = snap.segmentAnchorMs;
  if (snap.segmentStartedAt !== undefined) segmentStartedAt = snap.segmentStartedAt;
  if (snap.segmentPlannedAtStart !== undefined) segmentPlannedAtStart = snap.segmentPlannedAtStart;
  if (snap.segmentAdjustSeconds !== undefined) segmentAdjustSeconds = snap.segmentAdjustSeconds;
  if (snap.pausedAtMs !== undefined) pausedAtMs = snap.pausedAtMs;
  if (typeof snap.controlEpoch === "number" && snap.controlEpoch > pomodoroControlEpoch) {
    pomodoroControlEpoch = snap.controlEpoch;
  }
  remotePomodoroApplied = true;
  segmentBaseSeconds = snap.segmentBaseSeconds;
  useAppStore.setState({ pomodoro: { ...useAppStore.getState().pomodoro, ...snap.pomodoro } });
}

/** （迟加入窗口初始拉取）：番茄钟运行态的 localStorage 引导快照键。
 *  sync:pomodoro 只在状态变化/≤5s 锚点时广播——暂停态完全不广播，晚打开
 *  的窗口（全屏窗、新副屏）永远等不到数据。主同步订阅在发射的同时把同一
 *  份快照落到本键（各窗口共享），迟加入窗口引导时读一次：运行态由墙钟
 *  锚点现算，暂停态是精确剩余值。 */
const POMODORO_LIVE_KEY = "focus-desk.pomodoro-live.v1";

/** 引导快照 = 同步快照 + 写入时刻墙钟。 */
export type PomodoroLiveSnapshot = PomodoroSyncSnapshot & { wallMs: number };

/** 落引导快照（best-effort：失败只损失迟加入窗口的初始拉取能力）。 */
export function writePomodoroLiveSnapshot(): void {
  /* 恢复期间不写共享 LS（旧番茄钟快照不得盖回刚导入的数据）。 */
  if (isPersistSuspended()) return;
  try {
    const snap: PomodoroLiveSnapshot = { wallMs: Date.now(), ...getPomodoroSyncSnapshot() };
    localStorage.setItem(POMODORO_LIVE_KEY, JSON.stringify(snap));
  } catch {
    // best-effort
  }
}

/** 读引导快照；缺失/损坏/超过 24h（段必然已过期或完成）返回 null。 */
export function readPomodoroLiveSnapshot(): PomodoroLiveSnapshot | null {
  try {
    const raw = localStorage.getItem(POMODORO_LIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PomodoroLiveSnapshot> | null;
    if (
      !parsed ||
      typeof parsed.wallMs !== "number" ||
      !parsed.pomodoro ||
      typeof parsed.segmentBaseSeconds !== "number" ||
      typeof parsed.pomodoro.isRunning !== "boolean"
    ) {
      return null;
    }
    if (Date.now() - parsed.wallMs > 24 * 3_600_000) return null;
    return parsed as PomodoroLiveSnapshot;
  } catch {
    return null;
  }
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
// （心跳双主双写）：failover 短暂双主时，两个窗口的心跳 tick 同拍看到
// remaining→0，各自 recordCompletedSession → SQLite 双会话。去重键用段起始
// 时刻（sync:pomodoro 快照携带 segmentStartedAt，双主两窗对同一段持有相同
// 值）+ 段模式——同一完成跨窗同键，两次合法完成起始时刻必然不同。
// 此前键里用心跳拍号，primary 的 JS 兜底 interval 用本地 Date.now()、
// 副窗用 Rust 广播拍号，双主时同段两键，tryMarkOnce 判重失效出重复行。
function recordCompletedSession(prev: PomodoroState) {
  const startedAt = segmentStartedAt ?? new Date().toISOString();
  segmentStartedAt = null;
  clearSegmentAnchor();
  // 任务用时归集：把当前专注事件随会话落库，供统计按任务聚合。
  const { currentTaskId, currentEventLabel } = useAppStore.getState().pomodoro;
  // 运行中 ±N 秒的加时并入计划时长（ extend 语义：加时即延长的计划）。
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
  {
    const day = dayKeyOf(new Date());
    // tryMarkOnce 区分「真重复」与「写入失败」——markReminded 的统一
    // false 语义会让 localStorage 配额失败时整段会话静默消失（连内存 append
    // 一起跳过）。数据去重的正确默认值是宁可重复，失败照常落库。
    // （崩溃窗口恢复）：record 作为负载随标记一并暂存——「标记先行、写
    // 入未行」之间崩溃时，启动对账（hydrateApp）按 id 补写，丢段变可恢复。
    // 键格式约束：尾部必须是 YYYY-MM-DD（remind-dedupe 的日期清扫按最后
    // 一个 `.` 切分，startedAt ISO 中间的 `.` 不影响）。
    if (
      tryMarkOnce(
        `focus-desk.pomo-seg-done.${prev.mode}.${startedAt}.${day}`,
        "focus-desk.pomo-seg-done.",
        day,
        record
      ) === "duplicate"
    ) {
      return;
    }
  }
  useAppStore.setState((s) => ({ sessions: tail([...s.sessions, record], SESSIONS_CAP) }));
  if (persistence.kind === "sqlite") {
    void persistWithRetry("addSession", () => sqliteRepo.addSession(record));
  }
}

/**
 * 暂停中的进行段被「阶段切换 / 计时方式切换」放弃时，按中断路径的
 * 结算口径落一条会话——倒计时 ≥75% 达标记 completed 并计轮（isFocusCompleted），
 * 正计 ≥60s 计轮（与 stopCountupFocus 同口径），否则 partial。此前这两个
 * setter 直接清 segmentStartedAt，净专注时长既无会话也无中断记录地蒸发，
 * 与旗标中断（有结算）/重置（明确放弃）两条路径口径分裂。
 * 仅在「有进行段且未运行（暂停态）且 focus 段」时结算；运行中的切换是显式
 * skip 语义（有通知与自动化事件），awaitingActivity/休息段无进行段，均跳过。
 */
function settlePausedFocusSegment(): void {
  const state = useAppStore.getState();
  const prev = state.pomodoro;
  if (prev.isRunning || segmentStartedAt == null || prev.mode !== "focus") return;
  const startedAt = segmentStartedAt;
  const endedAt = new Date().toISOString();
  // 与 interruptPomodoro 同款：段首计划 ± 加时，锚点已随暂停清除，
  // wallRemaining 回退到冻结的 remainingSeconds。
  const planned =
    segmentPlannedAtStart > 0
      ? segmentPlannedAtStart + segmentAdjustSeconds
      : plannedSecondsFor("focus", state.pomodoroConfig);
  const elapsed = prev.timerMode === "countup" ? wallRemaining(prev) : Math.max(0, planned - wallRemaining(prev));
  segmentStartedAt = null;
  clearSegmentAnchor();
  segmentAdjustSeconds = 0;
  pausedAtMs = null;
  if (elapsed <= 0) return;
  const settledCompleted = prev.timerMode === "countup" ? elapsed >= 60 : isFocusCompleted(elapsed, planned);
  const partial = buildSessionRecord({
    id: crypto.randomUUID(),
    mode: "focus",
    startedAt,
    endedAt,
    plannedSeconds: elapsed,
    completed: settledCompleted,
    taskId: prev.currentTaskId,
    eventLabel: prev.currentEventLabel
  });
  useAppStore.setState((s) => ({
    sessions: tail([...s.sessions, partial], SESSIONS_CAP),
    pomodoro: settledCompleted
      ? { ...s.pomodoro, completedFocusSessions: s.pomodoro.completedFocusSessions + 1 }
      : s.pomodoro
  }));
  if (persistence.kind === "sqlite") {
    void persistWithRetry("addSession", () => sqliteRepo.addSession(partial));
  }
  /* 同为「放弃进行段」的兄弟路径都有事件（interrupt→interrupt、
     reset/stopCountup→stop）——依赖 focus 生命周期的自动化规则与媒体/
     环境音联动（如「停止专注恢复音乐」）此前在该路径失联。 */
  emitPomodoroEvent(settledCompleted ? "stop" : "interrupt", buildEventContext());
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/**
 * 周期 DDL 滚动到下一期。从原截止时间按周期步进直到落在当前
 * 时间之后（连漏多期一步滚回未来），保持时分秒；月/年周期做月末钳制
 * 防溢出漂移（31 日 → 2/28 → 3/31）。
 *
 * @param dueAt - 原 ISO 截止时间。
 * @param repeat - 周期规则（daily/weekly/monthly/yearly）。
 * @returns 新的 ISO 截止时间；解析失败或 repeat=none 原样返回。
 *
 * @example
 * `ts
 * advanceRepeatDue("2026-01-31T10:00:00Z", "monthly"); // "2026-02-28T…"
 * `
 */
export function advanceRepeatDue(dueAt: string, repeat: NonNullable<Deadline["repeat"]>): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return dueAt;
  // 循环外记住「锚点日/月」——月末溢出钳制后 d.getDate() 已是被钳值，
  // 每轮重读会让 31 日周期永久漂移到 28（注释承诺的 31→2/28→3/31 不成立）。
  const anchorDay = d.getDate();
  const anchorMonth = d.getMonth();
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
      // 月末溢出漂移（1/31 → 2/31 → 3/3）会影响周期 DDL 的稳定日。
      // 先落到目标月的 1 号，再按「锚点日 clamped 到该月最后一天」复原，
      // 保持「原日 + 时分秒」语义（31 日 → 2/28 → 3/31 → 4/30 …）。
      case "monthly": {
        d.setMonth(d.getMonth() + 1, 1);
        d.setDate(Math.min(anchorDay, daysInMonth(d.getFullYear(), d.getMonth())));
        break;
      }
      case "yearly": {
        d.setFullYear(d.getFullYear() + 1, anchorMonth, 1);
        d.setDate(Math.min(anchorDay, daysInMonth(d.getFullYear(), anchorMonth)));
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
            // 新任务排到手动排序末尾（与 Rust TaskRepo::add 同语义）——
            // 此前硬编码 0，用户 reorder 过一次后新增任务恒插队首。
            const nextOrder =
              get().tasks.reduce((m, t) => Math.max(m, typeof t.sortOrder === "number" ? t.sortOrder : -1), -1) + 1;
            const task: Task = {
              id: uid(),
              title,
              completed: false,
              createdAt: new Date().toISOString(),
              dueAt: extra?.dueAt ?? "",
              priority: extra?.priority ?? 0,
              tags: extra?.tags ?? [],
              sortOrder: nextOrder
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
        // 未参与排序的隐藏任务（筛选/截断下不可见）排到可见段之后，按原相对
        // 顺序续编号：此前它们保留旧 sortOrder，与可见段新编的 0..n-1 交错甚至
        // 并列，取消筛选后手动顺序错乱。
        const fullOrder = (tasks: Task[]) => {
          const hidden = tasks.filter((t) => !rank.has(t.id)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          const hiddenRank = new Map(hidden.map((t, i) => [t.id, orderedIds.length + i]));
          return tasks.map((t) => ({ id: t.id, sortOrder: rank.get(t.id) ?? hiddenRank.get(t.id) ?? 0 }));
        };
        const applyRank = () => {
          const order = new Map(fullOrder(useAppStore.getState().tasks).map((x) => [x.id, x.sortOrder]));
          set((s) => ({ tasks: s.tasks.map((t) => ({ ...t, sortOrder: order.get(t.id) ?? t.sortOrder ?? 0 })) }));
        };
        writeThrough("reorderTasks", applyRank, async () => {
          await sqliteRepo.reorderTasks(fullOrder(useAppStore.getState().tasks));
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
        // 未完成的周期 DDL 勾选 = 完成本期，滚动生成下一期（不标记完成）。
        if (cur && !cur.completed && cur.repeat && cur.repeat !== "none") {
          const next = advanceRepeatDue(cur.dueAt, cur.repeat);
          // 未来到期的周期 DDL 勾选时 advanceRepeatDue 原值返回（due>now 不
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
        // 先本地乐观置位，下一轮提醒 effect 立即看到已发档位、不再重复
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
        const cur = useAppStore.getState().pomodoro;
        const wasRunning = cur.isRunning;
        bumpPomodoroControlEpoch();
        // 暂停中的进行段不得静默蒸发——按中断路径的结算口径落一条
        // 会话（倒计时 ≥75% 记 completed 计轮、正计 ≥60s 计轮），此前切换
        // 直接清 segmentStartedAt，几十分钟净专注无任何记录消失。运行中的
        // 切换仍是显式 skip 语义（有通知/自动化事件），维持原状。
        settlePausedFocusSegment();
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        set((s) => ({ pomodoro: pomodoroReducer(s.pomodoro, { type: "setMode", mode }, s.pomodoroConfig) }));
        // 运行中手动切阶段 = skip（放弃当前段跳到下一阶段）。
        if (wasRunning) emitPomodoroEvent("skip", buildEventContext());
      },

      setPomodoroTimerMode: (timerMode) => {
        const wasAwaiting = useAppStore.getState().pomodoro.awaitingActivity;
        bumpPomodoroControlEpoch();
        // 同 setPomodoroMode——暂停中的进行段先按中断口径结算。
        settlePausedFocusSegment();
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        set((s) => {
          const next = pomodoroReducer(s.pomodoro, { type: "setTimerMode", timerMode }, s.pomodoroConfig);
          // 等待回座自动开始期间切换计时方式只改方式偏好，不清等待
          // 标记（setTimerMode reducer 恒置 awaitingActivity:false）。
          return { pomodoro: wasAwaiting ? { ...next, awaitingActivity: true } : next };
        });
      },

      selectPomodoroEvent: (taskId, label) => {
        bumpPomodoroControlEpoch();
        if (!useAppStore.getState().pomodoro.isRunning) {
          /* （兄弟路径）：暂停中的进行段换事件 = 放弃该段——
             与阶段/计时方式切换同口径先结算（守卫恰好匹配：非运行 + 有段 +
             focus 段），结算自带 事件。此前直接清锚点，几十分钟净专注
             无会话、无中断记录地蒸发，且跨窗采纳的暂停段同样走此分支。
             settle 后残值清空幂等；顺序满足 R-前端-6 契约。 */
          settlePausedFocusSegment();
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
        bumpPomodoroControlEpoch();
        set((s) => {
          // 修改配置不得静默重置停表丢掉当前专注段。运行中**或暂停中**
          // （segmentStartedAt/pausedAtMs 在途）都只更新配置字段，保留当前段；
          // 新时长在下一段开始时生效。此前守卫只查 isRunning——暂停 15 分钟
          // 后点一次「应用」就把剩余时间重置满额、已专注时长无记录消失。
          // 完全空闲（无在途段）才按当前模式重算剩余秒。
          // awaitingActivity（wait-activity 推进门）三态全空也必须守——
          // idle 分支重放 setMode 会清掉等待标记，「等你回来自动开始」的
          // 承诺被任何一次无关配置编辑静默打破（且该状态变化不广播，多窗
          // 还会分叉）。
          if (s.pomodoro.isRunning || segmentStartedAt !== null || pausedAtMs !== null || s.pomodoro.awaitingActivity) {
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
        bumpPomodoroControlEpoch();
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
        bumpPomodoroControlEpoch();
        set((s) => ({ pomodoro: { ...s.pomodoro, awaitingActivity: false } }));
      },

      togglePomodoro: () => {
        const state = useAppStore.getState();
        let prev = state.pomodoro;
        bumpPomodoroControlEpoch();
        // （会话过期）：暂停超过 2 小时的旧段不再恢复——按放弃
        // 结算（有实际时长则补录未完成会话）后回到全新专注段，用户的这次
        // 「开始」从零起算。休息段不落记录，静默作废。
        if (!prev.isRunning && pausedAtMs != null && Date.now() - pausedAtMs > SESSION_EXPIRY_MS && segmentStartedAt) {
          const elapsed = segmentElapsedSeconds(prev);
          const startedAt = segmentStartedAt;
          const expiredAtIso = new Date(pausedAtMs).toISOString();
          // 与 interruptPomodoro 同款 75% 阈值——暂停超时放弃的
          // 专注段若净时长已达标，同样按完成结算（completed:true + 计入轮数触发
          // 长休判定）；此前恒记放弃，同样专注 80% 的段两种放弃方式结论相反。
          const plannedAtExpiry =
            segmentPlannedAtStart > 0
              ? segmentPlannedAtStart + segmentAdjustSeconds
              : plannedSecondsFor("focus", state.pomodoroConfig);
          segmentStartedAt = null;
          clearSegmentAnchor();
          segmentAdjustSeconds = 0;
          pausedAtMs = null;
          set((s) => ({ pomodoro: pomodoroReducer(s.pomodoro, { type: "setMode", mode: "focus" }, s.pomodoroConfig) }));
          if (prev.mode === "focus" && elapsed > 0) {
            // 正计用 60s 下限（与中断/手动结束路径同口径），倒计时 75%。
            const thresholdCompleted =
              prev.timerMode === "countup" ? elapsed >= 60 : isFocusCompleted(elapsed, plannedAtExpiry);
            const partial = buildSessionRecord({
              id: crypto.randomUUID(),
              mode: "focus",
              startedAt,
              endedAt: expiredAtIso,
              plannedSeconds: elapsed,
              completed: thresholdCompleted,
              taskId: prev.currentTaskId,
              eventLabel: prev.currentEventLabel
            });
            useAppStore.setState((s) => ({ sessions: tail([...s.sessions, partial], SESSIONS_CAP) }));
            if (persistence.kind === "sqlite") {
              void persistWithRetry("addSession", () => sqliteRepo.addSession(partial));
            }
            if (thresholdCompleted) {
              useAppStore.setState((s) => ({
                pomodoro: { ...s.pomodoro, completedFocusSessions: s.pomodoro.completedFocusSessions + 1 }
              }));
            }
            /* （兄弟路径）：过期结算是内联实现、未走 settle——
               此前无任何终态事件，键控 stop/interrupt 的自动化规则在该路径
               失联。此刻锚点已清、新段未建，ctx 与 reset/interrupt 口径一致。 */
            emitPomodoroEvent(thresholdCompleted ? "stop" : "interrupt", buildEventContext());
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
          // （emit 时序）：先 set 再 emit——事件上下文必须描述动作后的新
          // 状态。此前 start 类事件在 set 之前 emit，规则条件 focus-start &&
          // isRunning 永不命中（tickPomodoro 的 finish 事件早修过同型问题）。
          set({ pomodoro: next });
          emitPomodoroEvent(
            resumed ? "resume" : prev.mode === "focus" ? "focus-start" : "break-start",
            buildEventContext()
          );
          return true;
        } else if (!next.isRunning && prev.isRunning) {
          // 暂停落在倒计时最后 1 秒内（墙钟已到 0 但本拍心跳尚未结算）
          // 时，暂停会把段冻结在 00:00——此后 tick 对 !isRunning 早退，既不
          // 完成也不落库（自动暂停路径是时间驱动，可能恰好命中）。此刻改走
          // 完成结算，语义与自然到点一致。
          if (prev.timerMode === "countdown" && wallRemaining(prev) <= 0) {
            get().tickPomodoro();
            return true;
          }
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
        bumpPomodoroControlEpoch();
        // 重置后必须清空 segmentStartedAt，否则「开始→暂停→重置→再开始」
        // 因 !segmentStartedAt 为假而不更新开始时间，新段结束时 recordCompletedSession
        // 会用陈旧 startedAt 录错专注时长（甚至跨多个段）。
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        set((s) => ({ pomodoro: pomodoroReducer(s.pomodoro, { type: "reset" }, s.pomodoroConfig) }));
        if (hadSegment) emitPomodoroEvent("stop", buildEventContext());
      },

      tickPomodoro: (beatMs?: number) => {
        const state = useAppStore.getState();
        const prev = state.pomodoro;
        if (!prev.isRunning) return;
        void beatMs; // 拍号不再参与完成去重键（改用段起始时刻），保留形参兼容调用方
        const config = state.pomodoroConfig;
        // 墙钟校正：每次 tick 从锚点反推真实剩余/已过秒数，睡眠/后台节流
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
        // 完成事件的上下文必须描述**刚结束的段**（prev，运行态）——下方
        // set 落库后 getState 已换到下一段，事后取上下文会让规则里的 mode
        // 条件语义颠倒（"focus-finish 且 mode==focus" 永不命中）。
        const finishCtx = buildEventContext();
        // 完成信号（见 Store 注释）：供 App.tsx 的通知器判定，替代「remaining
        // 跳回满额」推断——该推断无法与中断/重置区分。
        set({
          pomodoro: next,
          pomodoroCompletedSeq: state.pomodoroCompletedSeq + 1,
          pomodoroLastCompletedMode: prev.mode
        });
        // 阶段完成事件；下一段若已自动开始，紧随其后发
        // 对应的 start 事件（媒体联动/自动化规则依赖这对语义）。
        emitPomodoroEvent(prev.mode === "focus" ? "focus-finish" : "break-finish", finishCtx);
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
                // 启动失败（如未选事件被 toggle 拒绝）时清等待标记——
                // 否则面板继续承诺「回来自动开始」，而用户持续在场时不再有
                // presence 翻转事件兜底补救（GlobalActivityGate 同款处理）。
                if (!cur.togglePomodoro()) cur.clearAwaitingActivity();
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
        // （暂停态中断）：此前仅运行中可记录中断——暂停后想放弃只能重置，
        // 而重置不落任何记录，「今日放弃」统计漏掉这条路径。暂停中只要段仍在
        // 途（segmentStartedAt 非空）同样允许按中断结算。
        if (prev.mode !== "focus") return;
        if (!prev.isRunning && segmentStartedAt == null) return;
        bumpPomodoroControlEpoch();
        const startedAt = segmentStartedAt ?? new Date().toISOString();
        const endedAt = new Date().toISOString();
        // 中断已过时长用墙钟锚点计，而非 currentConfig 回算——运行中改了
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
        // 暂停态不走 reducer 的 interrupt 分支（其守卫要求 isRunning），等价地
        // 手工重置到新段起点；运行态仍复用纯 reducer 保持口径。
        const next = prev.isRunning
          ? pomodoroReducer(prev, { type: "interrupt" }, state.pomodoroConfig)
          : {
              ...prev,
              remainingSeconds: prev.timerMode === "countup" ? 0 : plannedSecondsFor("focus", state.pomodoroConfig),
              isRunning: false,
              awaitingActivity: false
            };
        // （75% 完成阈值）：被放弃的专注段若净时长已达标，
        // 按完成结算（completed:true + 计入轮数触发长休判定），不再恒记放弃。
        // 正计时段无计划时长，用 60s 下限（与 stopCountupFocus 的手动
        // 结束同口径）——此前中断路径恒 completed:false，2 小时正计因退出方式
        // 不同 1 轮/0 轮两种结论。
        const thresholdCompleted = prev.timerMode === "countup" ? elapsed >= 60 : isFocusCompleted(elapsed, planned);
        const settled: PomodoroState = thresholdCompleted
          ? { ...next, completedFocusSessions: next.completedFocusSessions + 1 }
          : next;
        set({
          pomodoro: settled,
          interruptions: tail([...state.interruptions, interruption], INTERRUPTIONS_CAP)
        });
        // 中断且已有实际专注时长时补落一条会话，让「今日放弃」
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
            void persistWithRetry("addSession", () => sqliteRepo.addSession(partial));
          }
        }
        if (persistence.kind === "sqlite") {
          // 中断写入与会话侧同款崩溃窗口保护——标记先行 + 负载暂存，
          // 「内存 append 之后、addInterruption 落库之前」崩溃时，启动对账
          // （hydrateApp）按 (startedAt, endedAt, reason) 补写。中断只有发起
          // 窗口落库（跨窗同步只进内存），标记仅作恢复用途，返回值无需判重。
          const day = dayKeyOf(new Date(startedAt));
          tryMarkOnce(
            `focus-desk.pomo-int-log.${new Date(startedAt).getTime()}.${day}`,
            "focus-desk.pomo-int-log.",
            day,
            interruption
          );
          void persistWithRetry("addInterruption", () => sqliteRepo.addInterruption(interruption));
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
        // 已过时长用墙钟锚点（而非 tick 计数的 remainingSeconds），后台
        // 节流丢 tick 后仍记录准确专注秒数。
        const elapsed = wallRemaining(prev);
        // Nothing elapsed yet -> nothing to record (no-op, don't start the timer).
        if (elapsed === 0) return;
        const startedAt = segmentStartedAt ?? new Date().toISOString();
        segmentStartedAt = null;
        clearSegmentAnchor();
        segmentAdjustSeconds = 0;
        pausedAtMs = null;
        // 几秒钟即手动结束的专注按部分记录（completed:
        // false、不计轮数），否则「今日 N 轮」被误触一下就 +1——对照中断路径
        // 的 75% 达标口径，正计无计划时长，用 60s 下限代替。
        const fullRound = elapsed >= 60;
        const record = buildSessionRecord({
          id: crypto.randomUUID(),
          mode: "focus",
          startedAt,
          endedAt: new Date().toISOString(),
          plannedSeconds: elapsed, // actual elapsed seconds in countup mode
          completed: fullRound,
          taskId: prev.currentTaskId,
          eventLabel: prev.currentEventLabel
        });
        // Ending a countup focus behaves like a completed focus: record the
        // session and advance the counter. The next focus keeps the same event
        // and the countup preference, and the timer resets so a fresh focus
        // starts at 0 — a single-focus pomodoro has no automatic break cycle.
        const completed = fullRound ? prev.completedFocusSessions + 1 : prev.completedFocusSessions;
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
        // （emit 时序）：先 set 再 notify/emit——stop 事件的上下文描述结束后的
        // 新状态（此前先 emit，ctx.isRunning 恒 true，与 resetPomodoro 的 stop
        // 路径语义相反）。
        bumpPomodoroControlEpoch();
        set({ pomodoro: next, sessions: tail([...state.sessions, record], SESSIONS_CAP) });
        pomodoroNotification({ kind: "complete", title: t("专注完成"), body: t("本次专注已记录。") });
        // 手动结束 = stop 语义（媒体联动恢复音乐、自动化规则消费）。
        emitPomodoroEvent("stop", buildEventContext());
        if (persistence.kind === "sqlite") {
          void persistWithRetry("addSession", () => sqliteRepo.addSession(record));
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
            // （导出→导入往返丢历史）：备份 JSON 里的专注/打断记录按 id（打断
            // 按起止时刻）**并集补插**——只插库中不存在的行，既恢复「重置后导入」
            // 的历史，也不删除库中已有记录（整表替换会误删导出后新产生的段）。
            // sessions 侧收口为 mergeSessions 单事务命令（Rust 在同一事务内
            // 「按 id 补插 + cap 裁剪」），不再逐条 addSession——500 条备份此前
            // 是 501 次串行 IPC 往返，且「先 listSessions 快照再逐条插入」两步
            // 之间其他窗口的新写有竞态。
            if (imported.sessions && imported.sessions.length > 0) {
              await sqliteRepo.mergeSessions(imported.sessions);
            }
            if (imported.interruptions && imported.interruptions.length > 0) {
              //interruptions 侧收口为 mergeInterruptions 单事务命令
              // （Rust 按 started|ended|reason 复合键并集补插），对齐 sessions
              // 的 口径——此前 list 快照 + 逐条 add 是 N+1 次串行 IPC。
              await sqliteRepo.mergeInterruptions(imported.interruptions);
            }
            /* 恢复/导入暂停期间不写一次性快照键
               （口径：旧番茄钟快照不得盖回刚导入的数据）。 */
            if (!isPersistSuspended()) {
              try {
                localStorage.setItem(POMODORO_SNAPSHOT_KEY, JSON.stringify(importedPomodoro));
              } catch {
                // best-effort
              }
            }
          }
          clearSegmentAnchor();
          segmentStartedAt = null;
          // 内存同样并集合并（键与库一致），截断上限照旧。
          const mergedSessions = (() => {
            if (!imported.sessions || imported.sessions.length === 0) return get().sessions;
            const seen = new Set(get().sessions.map((s) => s.id));
            const fresh = imported.sessions.filter((s) => !seen.has(s.id));
            return tail([...get().sessions, ...fresh], SESSIONS_CAP);
          })();
          const mergedInterruptions = (() => {
            if (!imported.interruptions || imported.interruptions.length === 0) return get().interruptions;
            // 键与库一致（started|ended|reason 三元组，此前缺 reason）。
            const keyOf = (i: PomodoroInterruption) => `${i.startedAt}|${i.endedAt}|${i.reason}`;
            const seen = new Set(get().interruptions.map(keyOf));
            const fresh = imported.interruptions.filter((i) => !seen.has(keyOf(i)));
            return tail([...get().interruptions, ...fresh], INTERRUPTIONS_CAP);
          })();
          set({
            tasks: imported.tasks,
            deadlines: imported.deadlines,
            pomodoro: importedPomodoro,
            sessions: mergedSessions,
            interruptions: mergedInterruptions
          });
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

// 仅当用户「设置类」瞬态字段实际变化时（选择任务/事件、切换模式、
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
    /* 闸门只挡「写共享 LS」——快照值已随 store 的
       set 进入内存（writePomodoroLiveSnapshot 同款早退口径），恢复备份进行
       中跳过落盘（恢复以 reload 收尾，新内存态接管）。 */
    if (isPersistSuspended()) return;
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

// SQLite 模式的 load() 只返回 tasks/deadlines，不返回 pomodoro。重启后
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
 * 慢水合期间已启动的计时不被覆盖。
 *
 * @returns 水合完成后 resolve；失败仅记日志（界面以默认状态放行）。
 * @throws 无。
 */
/** 每窗口水合一次的门——main.tsx 启动一次、cross-window 监听就绪的
 *  启动期兜底再一次，幂等但双倍 IPC/IO（全量重读 + 主窗重复
 *  flushMirrorSync+createBackup）。失败时复位允许兜底路径重试。 */
let hydratedOnce = false;

export async function hydrateApp(): Promise<void> {
  if (hydratedOnce) return;
  hydratedOnce = true;
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
      // 风险也随串行长度放大。：limit 下推——只拉内存口径所需的最近 N 条
      // （此前整表拉回再丢弃 97.5%/97%，retention 扩容后 IPC 成本随上限线性
      // 放大 ×N 个窗口）；tail 保留作双保险。
      [loaded, sessions, interruptions] = await Promise.all([
        persistence.load(),
        sqliteRepo.listSessions(SESSIONS_CAP).then((rows) => tail(rows, SESSIONS_CAP)),
        sqliteRepo.listInterruptions(INTERRUPTIONS_CAP).then((rows) => tail(rows, INTERRUPTIONS_CAP))
      ]);
      // Daily rolling auto-backup (Rust side dedups per-day and prunes old files).
      // The localStorage mirror is synced FIRST so notes/habits/bookmarks/widget
      // configs ride along in the backup file instead of being a blind spot.
      if (flags.autoBackup && primary) {
        // mirror 失败不备份——.finally 链序下
        // createBackup 无论如何都会执行，产出缺便签/习惯/书签的「盲区备份」
        // 且用户毫无感知。改为成功路径才续 backup；失败走 reportPersistError。
        flushMirrorSync()
          .then(() => sqliteRepo.createBackup())
          .catch(reportPersistError("autoBackup"));
      }
    } else {
      loaded = await persistence.load();
      ({ sessions, interruptions } = loadLog());
    }
    // （崩溃窗口恢复）：完成段去重标记**先于**写入落地——「标记已写、
    // 记录未落库」之间崩溃会让该段永久消失（标记存活着，重放也只会被判
    // 重复）。启动时按暂存负载对账：库里没有对应 id 的标记负载补写回
    // （mergeLog 以 id 去重，与内存/后续同步的重复无害；标记保留继续挡
    // 跨窗重复）。
    {
      const pending = readPendingPayloads<PomodoroSessionRecord>("focus-desk.pomo-seg-done.");
      if (pending.length > 0) {
        const known = new Set(sessions.map((s) => s.id));
        for (const { payload } of pending) {
          if (!payload || typeof payload.id !== "string" || known.has(payload.id)) continue;
          if (persistence.kind === "sqlite") {
            void persistWithRetry("addSession", () => sqliteRepo.addSession(payload));
          }
          sessions = [...sessions, payload];
        }
      }
    }
    // 中断记录的崩溃窗口对账（会话侧 readPendingPayloads 的对位）——
    // 「标记先行、addInterruption 未行」之间崩溃的记录按三元组键补写；
    // 已落库的（水合快照含同键行）跳过，标记保留继续防重放。
    // （备案）：「已在库」判定受 300 条水合截尾窗限制——标记存活期内
    // 库中同键行需滑出最近 300 条（同日再产生 300+ 条更新中断）才会误判
    // 补写重复行，自愈于下次水合可见双行后跳过；触发概率可忽略，改定向
    // SQL 存在性查询的收益不抵 hydrate 热路径复杂度。会话侧（500 窗）同款。
    if (persistence.kind === "sqlite") {
      const pendingInterruptions = readPendingPayloads<PomodoroInterruption>("focus-desk.pomo-int-log.");
      for (const { payload } of pendingInterruptions) {
        if (!payload || typeof payload.startedAt !== "string" || typeof payload.reason !== "string") continue;
        const key3 = (i: PomodoroInterruption) => `${i.startedAt}|${i.endedAt}|${i.reason}`;
        if (interruptions.some((x) => key3(x) === key3(payload))) continue;
        void persistWithRetry("addInterruption", () => sqliteRepo.addInterruption(payload));
        interruptions = [...interruptions, payload];
      }
    }
    // 若用户在慢速 hydration 完成前已手动启动计时，则不覆盖其运行状态，
    // 避免静默取消正在进行的专注会话。
    const current = useAppStore.getState();
    const isRunning = current.pomodoro?.isRunning ?? false;
    // 水合合并：本地（hydration 窗口内用户操作后的较新状态）在 id 冲突时
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
    // SQLite 模式 load() 不返回 pomodoro；从快照恢复「设置类」瞬态
    // （任务/事件选择、计时模式、长休轮换计数），运行态仍从新鲜起点开始。
    let restoredSetup: PomodoroState | undefined;
    if (persistence.kind === "sqlite") {
      const setup = loadPomodoroSetup();
      if (setup) restoredSetup = restorePomodoroSetup(setup, loadConfig());
    }
    // 字段级合并：只覆写水合真正提供的字段。此前 `...defaults` 整包铺底会把
    // 水合窗口内的其他状态（pomodoroConfig 修改、pomodoroCompletedSeq 完成信号等）
    // 打回模块加载期的默认值——的 tombstone 只保护了 tasks/deadlines。
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
    // sync-gate 门控（与 hydrateSettingsFromDb 同口径）：晚到水合是「远端数据
    // 落地」，不过闸会被 sync:app 订阅当成本地编辑——stampRowEdits 整表盖新
    // 时间戳后广播，其他已水合窗口按 ts 仲裁把陈旧行当最新值采纳（回滚）。
    withRemoteApply(() => {
      // 配套：pomodoro 通道此前没有 isRemoteApplying 门闩，水合重建的
      // pomodoro 对象会被订阅当「本地控制变更」广播出去（详见 cross-window）；
      // 同时水合本身也不得整包替换**已落地的远端快照**（此前仅保留 isRunning，
      // mode/remaining/锚点全被 LS 旧值顶掉）。显式导入快照仍最高优先。
      const hydratedPomodoro = importedPomodoro
        ? { ...importedPomodoro, isRunning: false }
        : remotePomodoroApplied
          ? current.pomodoro
          : { ...defaults.pomodoro, ...restoredSetup, ...loaded?.pomodoro, isRunning };
      useAppStore.setState({
        tasks: mergeById(current.tasks, loaded?.tasks ?? [], hydrationTombstones.tasks),
        deadlines: mergeById(current.deadlines, loaded?.deadlines ?? [], hydrationTombstones.deadlines),
        sessions: mergeLog(sessions, current.sessions, SESSIONS_CAP, (s) => s.id),
        // 中断记录的 TS 形状没有 id：按 (startedAt, endedAt, reason) 三元组作键
        // ——与 importData、sync:interruption（u9）及 Rust merge 三处一致；
        // 此前缺 reason，同刻不同原因的两条（备份/迁移数据可构造）会被
        // 误判重复丢弃。
        interruptions: mergeLog(
          interruptions,
          current.interruptions,
          INTERRUPTIONS_CAP,
          (i) => `${i.startedAt}|${i.endedAt}|${i.reason}`
        ),
        pomodoro: hydratedPomodoro
      });
    });
  } catch (err) {
    // 异常路径复位水合门，允许 cross-window 监听就绪的兜底路径重试。
    hydratedOnce = false;
    throw err;
  } finally {
    hydrating = false;
  }
}

/** 测试隔离——重置每窗口一次的水合门（仅测试使用）。 */
export function resetHydrateOnceGateForTests(): void {
  hydratedOnce = false;
}

/** 水合窗口内到达的远端删除凭证并入本地水合墓碑。窗口 B 启动水合
 *  期间，本窗内存尚无被删行——mergeRows 对不存在的行不立墓碑，随后落地的
 *  陈旧 DB 快照会把其他窗口已删除的行 merge 回内存且抑制再广播（滞留到
 *  重启）。把删除凭证提前登记进 hydrationTombstones，hydrateApp 的
 *  mergeById 即从快照中剔除这些 id。仅 cross-window 在 hydrating 期调用，
 *  非水合期调用为 no-op。
 *
 *  返回本次调用是否实际生效（处于水合窗口）。调用方
 *  （cross-window）据此把凭证同步镜像进跨窗墓碑表——水合墓碑只保护本次
 *  水合的快照合并，水合结束后持有旧内存的窗口发来的陈旧整包仍需墓碑拦截。
 *
 * @returns true 表示处于水合窗口、凭证已并入（调用方可据此镜像跨窗墓碑）。 */
export function noteHydrationRemoteRemovals(tasks?: string[], deadlines?: string[]): boolean {
  if (!hydrating) return false;
  if (Array.isArray(tasks)) for (const id of tasks) hydrationTombstones.tasks.add(id);
  if (Array.isArray(deadlines)) for (const id of deadlines) hydrationTombstones.deadlines.add(id);
  return true;
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
