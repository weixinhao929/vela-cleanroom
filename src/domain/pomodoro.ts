/**
 * 番茄钟领域层：配置规范化、状态机 reducer、会话/打断记录构造。
 * 全部纯函数（reducer 模式），可注入固定时间戳单测；持久化记录的结构
 * 与 SQLite 列一一对应（见 app-store / sqlite.ts）。
 */

/** 番茄钟阶段：专注 / 短休 / 长休。 */
export type PomodoroMode = "focus" | "shortBreak" | "longBreak";

/** 每日目标计量方式：按轮数或按时长。 */
export type PomodoroDailyGoalMode = "sessions" | "minutes";

/** How the timer advances: countdown (remaining) or countup (elapsed). */
export type PomodoroTimerMode = "countdown" | "countup";

/** 表盘配色皮肤。 */
export type PomodoroDialTheme = "accent" | "mint" | "sunset" | "ocean" | "violet";

/**
 * 阶段推进门：auto=按 autoStartNext 自动衔接；
 * confirm=每段结束后等手动确认才开始下一段；wait-activity=休息照常自动
 * 开始、但休息结束后的下一段专注等 presence 检测到用户回座才启动
 * （state.awaitingActivity 置位，App 层 presence 监听负责真正启动）。
 */
export type PomodoroAdvanceGate = "auto" | "confirm" | "wait-activity";

export const ADVANCE_GATES: readonly PomodoroAdvanceGate[] = ["auto", "confirm", "wait-activity"];

export interface PomodoroConfig {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakInterval: number; // completed focus sessions after which a long break happens
  autoStartNext: boolean; // auto-start the next focus when a break completes
  /** 每日专注目标（轮）。0 表示不设目标、隐藏进度条。 */
  dailyGoalSessions: number;
  /** 每日目标的计量方式：sessions=轮数 / minutes=专注时长。 */
  dailyGoalMode: PomodoroDailyGoalMode;
  /** 每日专注目标（分钟，dailyGoalMode="minutes" 时生效）。0 = 不设目标。 */
  dailyGoalMinutes: number;
  /** 完整自动循环链：专注结束自动进入休息，休息结束回到专注。 */
  autoCycle: boolean;
  /** 正计时目标提醒（分钟）。0 = 跟随专注时长。 */
  countupGoalMinutes: number;
  /** 表盘配色。 */
  dialTheme: PomodoroDialTheme;
  /** 阶段推进门（默认 auto，完全沿用既有自动衔接）。 */
  advanceGate: PomodoroAdvanceGate;
}

export interface PomodoroState {
  mode: PomodoroMode;
  timerMode: PomodoroTimerMode;
  /** The user's preferred timer mode for focus segments. Breaks always run as
   *  countdown; this field remembers the focus preference across the cycle so
   *  the timer doesn't silently revert to countdown after a break. */
  focusTimerMode: PomodoroTimerMode;
  remainingSeconds: number;
  isRunning: boolean;
  completedFocusSessions: number;
  currentTaskId: string | null;
  /** Custom event label set when the user picks a non-task event. */
  currentEventLabel: string | null;
  /** 休息结束后的下一段专注已就位，等 presence 检测到
   *  用户回座再自动开始（advanceGate="wait-activity" 专用；其余动作清零）。 */
  awaitingActivity: boolean;
}

export type PomodoroAction =
  | { type: "tick" }
  | { type: "toggle" }
  | { type: "reset" }
  | { type: "setMode"; mode: PomodoroMode }
  | { type: "setTimerMode"; timerMode: PomodoroTimerMode }
  | { type: "selectEvent"; taskId: string | null; label: string | null }
  | { type: "interrupt" }
  | { type: "adjust"; delta: number };

/** 净专注时长达到计划时长的该比例即视为「完成」——
 *  中断放弃的段若已专注够久，同样计入轮数并触发长休判定。 */
export const FOCUS_COMPLETION_THRESHOLD = 0.75;

/**
 * 判断一段净专注时长是否达到完成阈值。
 *
 * @param netElapsedSeconds - 扣除暂停后的实际专注秒数。
 * @param plannedSeconds - 该段计划秒数（≤0 恒不完成）。
 * @returns 净时长 / 计划 ≥ {@link FOCUS_COMPLETION_THRESHOLD}。
 */
export function isFocusCompleted(netElapsedSeconds: number, plannedSeconds: number): boolean {
  return plannedSeconds > 0 && netElapsedSeconds / plannedSeconds >= FOCUS_COMPLETION_THRESHOLD;
}

export const DEFAULT_CONFIG: PomodoroConfig = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakInterval: 4,
  autoStartNext: true,
  dailyGoalSessions: 8,
  dailyGoalMode: "sessions",
  dailyGoalMinutes: 120,
  autoCycle: true,
  countupGoalMinutes: 0,
  dialTheme: "accent",
  advanceGate: "auto"
};

/** 表盘皮肤白名单（normalize 用）。导出供设置页的配色选择器复用。 */
export const DIAL_THEMES: PomodoroDialTheme[] = ["accent", "mint", "sunset", "ocean", "violet"];
const GOAL_MODES: PomodoroDailyGoalMode[] = ["sessions", "minutes"];

/**
 * 把部分配置钳制/取整为合法的完整配置（纯函数）。
 * 使用场景：加载持久化配置、应用用户编辑时的唯一入口，保证越界值
 * （如 0 分钟专注）不会进入状态机。
 *
 * @param input - 可能缺字段或含越界值的原始配置。
 * @returns 补全默认值并逐项钳制后的 {@link PomodoroConfig}。O(1)。
 *
 * @example
 * ```ts
 * normalizeConfig({ focusMinutes: -5 }); // focusMinutes → 1
 * ```
 */
export function normalizeConfig(input: Partial<PomodoroConfig>): PomodoroConfig {
  const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  const bool = (value: boolean | undefined, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  return {
    focusMinutes: clamp(input.focusMinutes, 1, 180, DEFAULT_CONFIG.focusMinutes),
    shortBreakMinutes: clamp(input.shortBreakMinutes, 1, 60, DEFAULT_CONFIG.shortBreakMinutes),
    longBreakMinutes: clamp(input.longBreakMinutes, 1, 120, DEFAULT_CONFIG.longBreakMinutes),
    longBreakInterval: clamp(input.longBreakInterval, 1, 12, DEFAULT_CONFIG.longBreakInterval),
    autoStartNext: bool(input.autoStartNext, DEFAULT_CONFIG.autoStartNext),
    dailyGoalSessions: clamp(input.dailyGoalSessions, 0, 24, DEFAULT_CONFIG.dailyGoalSessions),
    dailyGoalMode: GOAL_MODES.includes(input.dailyGoalMode as PomodoroDailyGoalMode)
      ? (input.dailyGoalMode as PomodoroDailyGoalMode)
      : DEFAULT_CONFIG.dailyGoalMode,
    dailyGoalMinutes: clamp(input.dailyGoalMinutes, 0, 1440, DEFAULT_CONFIG.dailyGoalMinutes),
    autoCycle: bool(input.autoCycle, DEFAULT_CONFIG.autoCycle),
    countupGoalMinutes: clamp(input.countupGoalMinutes, 0, 240, DEFAULT_CONFIG.countupGoalMinutes),
    dialTheme: DIAL_THEMES.includes(input.dialTheme as PomodoroDialTheme)
      ? (input.dialTheme as PomodoroDialTheme)
      : DEFAULT_CONFIG.dialTheme,
    advanceGate: ADVANCE_GATES.includes(input.advanceGate as PomodoroAdvanceGate)
      ? (input.advanceGate as PomodoroAdvanceGate)
      : DEFAULT_CONFIG.advanceGate
  };
}

/**
 * 构造番茄钟初始状态（未运行、专注段、剩余 = 计划时长）。
 *
 * @param config - 配置，默认 {@link DEFAULT_CONFIG}。
 * @returns {@link PomodoroState} 初始值。O(1)。
 */
export function createInitialState(config: PomodoroConfig = DEFAULT_CONFIG): PomodoroState {
  return {
    mode: "focus",
    timerMode: "countdown",
    focusTimerMode: "countdown",
    remainingSeconds: config.focusMinutes * 60,
    isRunning: false,
    completedFocusSessions: 0,
    currentTaskId: null,
    currentEventLabel: null,
    awaitingActivity: false
  };
}

function durationSeconds(mode: PomodoroMode, config: PomodoroConfig): number {
  switch (mode) {
    case "focus":
      return config.focusMinutes * 60;
    case "shortBreak":
      return config.shortBreakMinutes * 60;
    case "longBreak":
      return config.longBreakMinutes * 60;
  }
}

/**
 * Seconds a segment should show after (re)starting. Countdown resets to the
 * planned duration; countup starts from zero and accumulates elapsed time.
 */
function resetSeconds(mode: PomodoroMode, timerMode: PomodoroTimerMode, config: PomodoroConfig): number {
  return timerMode === "countup" ? 0 : durationSeconds(mode, config);
}

/**
 * 指定阶段的计划时长（秒），默认配置口径。
 *
 * @param mode - 目标阶段。
 * @param config - 配置，默认 {@link DEFAULT_CONFIG}。
 * @returns 该阶段计划秒数。O(1)。
 */
export function plannedSecondsFor(mode: PomodoroMode, config: PomodoroConfig = DEFAULT_CONFIG): number {
  return durationSeconds(mode, config);
}

/**
 * 正计时（countup）的目标秒数：可配目标为 0 时跟随专注时长。
 * （分母统一）：主面板进度环 / 目标文案 / 迷你环此前各用各的分母
 * （focusMinutes、countupGoalMinutes、恒 0），同一计时器三处呈现不一致；
 * 统一为本函数，下限 60s 防除零。
 */
export function countupGoalSeconds(config: PomodoroConfig): number {
  const minutes = config.countupGoalMinutes > 0 ? config.countupGoalMinutes : config.focusMinutes;
  return Math.max(60, minutes * 60);
}

/**
 * 专注完成后的下一个休息阶段。
 *
 * @param completed - 已完成专注轮数（含刚完成的这一轮）。
 * @param config - 配置（读取 longBreakInterval）。
 * @returns 达到长休间隔为 "longBreak"，否则 "shortBreak"。O(1)。
 */
export function nextModeAfterFocus(completed: number, config: PomodoroConfig): PomodoroMode {
  return completed > 0 && completed % config.longBreakInterval === 0 ? "longBreak" : "shortBreak";
}

/**
 * 番茄钟状态机纯 reducer。
 * 无副作用、不依赖真实时钟："tick" 恰好推进 1 秒；tick 的节奏控制
 * （interval、唤醒补偿等）由调用方负责。切换阶段时休息段强制倒计时，
 * 专注段保留用户偏好（防止 countup 泄漏进休息段）。
 *
 * @param state - 当前状态。
 * @param action - {@link PomodoroAction} 派发动作。
 * @param config - 配置，默认 {@link DEFAULT_CONFIG}。
 * @returns 新状态（不可变更新）。
 *
 * @example
 * ```ts
 * const next = pomodoroReducer(state, { type: "setMode", mode: "focus" }, config);
 * ```
 */
export function pomodoroReducer(
  state: PomodoroState,
  action: PomodoroAction,
  config: PomodoroConfig = DEFAULT_CONFIG
): PomodoroState {
  switch (action.type) {
    case "toggle":
      return { ...state, isRunning: !state.isRunning, awaitingActivity: false };

    case "reset":
      return {
        ...state,
        remainingSeconds: resetSeconds(state.mode, state.timerMode, config),
        isRunning: false,
        awaitingActivity: false
      };

    case "setMode": {
      // Breaks always run as countdown; focus uses the user's preferred focus
      // timer mode. This prevents a countup focus from leaking into a break
      // (which would otherwise count up from zero instead of counting down),
      // and keeps the focus preference intact when returning to focus.
      const timerMode = action.mode === "focus" ? state.focusTimerMode : "countdown";
      return {
        ...state,
        mode: action.mode,
        timerMode,
        remainingSeconds: resetSeconds(action.mode, timerMode, config),
        isRunning: false,
        awaitingActivity: false
      };
    }

    case "setTimerMode":
      return {
        ...state,
        timerMode: action.timerMode,
        focusTimerMode: action.timerMode,
        remainingSeconds: resetSeconds(state.mode, action.timerMode, config),
        isRunning: false,
        awaitingActivity: false
      };

    case "selectEvent": {
      // Unified event selection for both tasks and custom labels. If a segment
      // is currently running (focus or break), remember the event for the next
      // focus WITHOUT disturbing the running timer. Otherwise reset to a fresh
      // focus with the chosen event (the user presses "开始" to begin).
      if (state.isRunning) {
        return { ...state, currentTaskId: action.taskId, currentEventLabel: action.label };
      }
      return {
        ...state,
        currentTaskId: action.taskId,
        currentEventLabel: action.label,
        mode: "focus",
        timerMode: state.focusTimerMode,
        remainingSeconds: resetSeconds("focus", state.focusTimerMode, config),
        isRunning: false,
        awaitingActivity: false
      };
    }

    case "interrupt": {
      // Abort a running focus segment early (records elapsed time for the
      // caller). The reducer only resets the timer; analytics is the caller's job.
      if (state.mode !== "focus" || !state.isRunning) return state;
      return {
        ...state,
        mode: "focus",
        remainingSeconds: resetSeconds("focus", state.timerMode, config),
        isRunning: false,
        awaitingActivity: false
      };
    }

    case "adjust": {
      // （extend / rewind）：运行中 ±N 秒。倒计时剩余保底
      // 10s（MIN_REMAINING 同款语义，避免拨到 0 立即完成）；正计时已过
      // 秒数保底 0。只在运行中有意义。
      if (!state.isRunning) return state;
      if (!Number.isFinite(action.delta) || action.delta === 0) return state;
      if (state.timerMode === "countup") {
        return { ...state, remainingSeconds: Math.max(0, state.remainingSeconds + Math.round(action.delta)) };
      }
      return { ...state, remainingSeconds: Math.max(10, state.remainingSeconds + Math.round(action.delta)) };
    }

    case "tick": {
      if (!state.isRunning) return state;
      // Countup mode only accumulates elapsed focus time; it never auto-switches.
      if (state.timerMode === "countup") {
        return { ...state, remainingSeconds: state.remainingSeconds + 1 };
      }
      if (state.remainingSeconds > 1) {
        return { ...state, remainingSeconds: state.remainingSeconds - 1 };
      }
      const event = { currentTaskId: state.currentTaskId, currentEventLabel: state.currentEventLabel };
      // Only a completed FOCUS counts toward the cycle counter — a finished
      // break must never inflate completedFocusSessions.
      const completed = state.mode === "focus" ? state.completedFocusSessions + 1 : state.completedFocusSessions;
      // 推进门。confirm=下一段等手动开始；wait-activity=仅
      // 对「下一段是专注」生效——下一段就位（isRunning=false）并置
      // awaitingActivity，由 App 层 presence 监听在用户回座时真正启动。
      const gate = config.advanceGate ?? "auto";
      const holdConfirm = config.autoStartNext && gate === "confirm";
      const holdActivity = config.autoStartNext && gate === "wait-activity";

      // 完整自动循环链：专注结束按 longBreakInterval 轮换长短休，
      // 休息结束回到专注（沿用用户偏好的专注计时方式）。autoStartNext
      // 同时控制休息与下一轮专注是否自动开始。
      if (config.autoCycle) {
        const nextMode: PomodoroMode = state.mode === "focus" ? nextModeAfterFocus(completed, config) : "focus";
        const timerMode = nextMode === "focus" ? state.focusTimerMode : "countdown";
        const hold = holdConfirm || (holdActivity && nextMode === "focus");
        return {
          ...state,
          mode: nextMode,
          timerMode,
          focusTimerMode: state.focusTimerMode,
          remainingSeconds: resetSeconds(nextMode, timerMode, config),
          isRunning: config.autoStartNext && !hold,
          awaitingActivity: holdActivity && nextMode === "focus",
          completedFocusSessions: completed,
          ...event
        };
      }

      // 单段模式（autoCycle 关闭）：专注结束回到新专注段，保持旧行为。
      return {
        mode: "focus",
        timerMode: state.focusTimerMode,
        focusTimerMode: state.focusTimerMode,
        remainingSeconds: resetSeconds("focus", state.focusTimerMode, config),
        isRunning: config.autoStartNext && !holdConfirm && !holdActivity,
        awaitingActivity: holdActivity,
        completedFocusSessions: completed,
        ...event
      };
    }
  }
}

/** 一条专注段中断记录（用于打断原因统计）。 */
export interface PomodoroInterruption {
  startedAt: string;
  endedAt: string;
  reason: string;
  mode: PomodoroMode;
  elapsedSeconds: number;
}

/** 专注「记录中断」选择器的常用原因。
 *  保存**中文键**：入库/统计分组都按这份稳定键，展示时再 tr()。此前在模块
 *  加载期 `.map(t)`：启动语言为英文时常量变成 "Phone"…，中断原因随语言落库，
 *  同一原因在统计里按语言分裂成两桶；运行期切回中文后弹层仍显示英文。 */
export const INTERRUPTION_REASONS = ["电话", "消息", "网页", "休息", "其他"] as const;
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number];

/**
 * 构造一条被中止专注段的中断记录（纯函数）。
 *
 * @param input - 起点/终点 ISO 时间、原因、已进行秒数。
 * @returns {@link PomodoroInterruption}（mode 恒为 "focus"，秒数下限 0）。
 */
export function buildInterruption(input: {
  startedAt: string;
  endedAt: string;
  reason: InterruptionReason;
  elapsedSeconds: number;
}): PomodoroInterruption {
  return {
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    reason: input.reason,
    mode: "focus",
    elapsedSeconds: Math.max(0, input.elapsedSeconds)
  };
}

/** 一条已结束阶段的持久化记录（与 SQLite sessions 表同构）。 */
export interface PomodoroSessionRecord {
  id: string;
  type: "focus" | "break";
  mode: PomodoroMode;
  startedAt: string;
  endedAt: string;
  plannedSeconds: number;
  completed: boolean;
  /** 任务用时归集：该段专注关联的待办 / 自定义事件。 */
  taskId?: string | null;
  eventLabel?: string | null;
}

/**
 * 构造一条已完成阶段的会话记录（纯函数，可单测）。
 * id 与时间戳由调用方提供——领域层不感知时钟与 uuid 生成。
 *
 * @param input - 记录字段（id/阶段/起止/计划秒数/是否完成/关联事件）。
 * @returns {@link PomodoroSessionRecord}。
 */
export function buildSessionRecord(input: {
  id: string;
  mode: PomodoroMode;
  startedAt: string;
  endedAt: string;
  plannedSeconds: number;
  completed: boolean;
  taskId?: string | null;
  eventLabel?: string | null;
}): PomodoroSessionRecord {
  return {
    id: input.id,
    type: input.mode === "focus" ? "focus" : "break",
    mode: input.mode,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    plannedSeconds: input.plannedSeconds,
    completed: input.completed,
    taskId: input.taskId ?? null,
    eventLabel: input.eventLabel ?? null
  };
}
