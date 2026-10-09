import { z } from "zod";

/**
 * 核心状态的 zod 校验模式（单一事实来源）。
 * 职责：持久化载荷/导入文件进入内存前的结构校验与缺省补全；
 * 类型经 z.infer 派生，保证校验规则与 TS 类型永不脱节。
 */

/** 番茄钟阶段枚举 schema。 */
export const PomodoroModeSchema = z.enum(["focus", "shortBreak", "longBreak"]);

/** 待办任务 schema（含 截止/优先级/标签、排序）。 */
export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  completed: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  /** 截止时间（ISO；空串 = 无截止）。 */
  dueAt: z.string().default(""),
  /** 优先级：0 无 / 1 低 / 2 中 / 3 高。 */
  priority: z.number().int().min(0).max(3).default(0),
  /** 标签。 */
  tags: z.array(z.string()).default([]),
  /** 手动排序权重（小的在前）。 */
  sortOrder: z.number().int().default(0)
});

/** 截止提醒 schema（含 多档提醒、周期规则）。 */
export const DeadlineSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  dueAt: z.string().datetime({ offset: true }),
  notified: z.boolean(),
  completed: z.boolean().default(false),
  /** 已发送提醒档位集合。 */
  notifiedTiers: z.array(z.string()).default([]),
  /** 周期规则。 */
  repeat: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).default("none")
});

/** 番茄钟运行时状态 schema。 */
export const PomodoroStateSchema = z.object({
  mode: PomodoroModeSchema,
  timerMode: z.enum(["countdown", "countup"]).default("countdown"),
  focusTimerMode: z.enum(["countdown", "countup"]).default("countdown"),
  remainingSeconds: z.number().int().min(0),
  isRunning: z.boolean(),
  completedFocusSessions: z.number().int().min(0),
  currentTaskId: z.string().nullable().default(null),
  currentEventLabel: z.string().nullable().default(null),
  /** wait-activity 推进门的「等你回座」标记（备份 JSON 中
   *  可缺省，导入后一律视为 false——等待态跨备份无意义）。 */
  awaitingActivity: z.boolean().default(false)
});

/** 一条已结束阶段的持久化记录 schema（与 SQLite sessions 表同构）。 */
export const PomodoroSessionRecordSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["focus", "break"]),
  mode: PomodoroModeSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  plannedSeconds: z.number().min(0),
  completed: z.boolean(),
  taskId: z.string().nullable().optional(),
  eventLabel: z.string().nullable().optional()
});

/** 专注中断记录 schema。 */
export const PomodoroInterruptionSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string(),
  reason: z.string(),
  mode: PomodoroModeSchema,
  elapsedSeconds: z.number().min(0)
});

/** 应用完整状态 schema（备份 JSON 的顶层结构）。 */
/* （导出→导入往返丢历史）：导出的 JSON 里带 sessions/interruptions，但
 * AppStateSchema 此前不收这两个键——zod 默认剥离未知键，导入后
 * replaceCoreDataKeepSessions 只保留库中现存记录，「导出→重置→导入」把
 * 全部专注历史静默丢掉。补为可选键：旧版备份（无这两个键）仍可导入。 */
export const AppStateSchema = z.object({
  tasks: z.array(TaskSchema),
  deadlines: z.array(DeadlineSchema),
  pomodoro: PomodoroStateSchema,
  sessions: z.array(PomodoroSessionRecordSchema).optional(),
  interruptions: z.array(PomodoroInterruptionSchema).optional()
});

/* 由 schema 派生的类型（单一事实来源；IPC 线协议类型另见 ts-rs 生成的 types/bindings）。 */
export type Task = z.infer<typeof TaskSchema>;
export type Deadline = z.infer<typeof DeadlineSchema>;
export type PomodoroMode = z.infer<typeof PomodoroModeSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
