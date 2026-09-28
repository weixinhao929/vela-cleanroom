import { z } from "zod";

/**
 * 核心状态的 zod 校验模式（单一事实来源）。
 * 职责：持久化载荷/导入文件进入内存前的结构校验与缺省补全；
 * 类型经 z.infer 派生，保证校验规则与 TS 类型永不脱节。
 */

/** 番茄钟阶段枚举 schema。 */
export const PomodoroModeSchema = z.enum(["focus", "shortBreak", "longBreak"]);

/** 待办任务 schema（含 W-043 截止/优先级/标签、W-045 排序）。 */
export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  completed: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  /** W-043 截止时间（ISO；空串 = 无截止）。 */
  dueAt: z.string().default(""),
  /** W-043 优先级：0 无 / 1 低 / 2 中 / 3 高。 */
  priority: z.number().int().min(0).max(3).default(0),
  /** W-043 标签。 */
  tags: z.array(z.string()).default([]),
  /** W-045 手动排序权重（小的在前）。 */
  sortOrder: z.number().int().default(0)
});

/** 截止提醒 schema（含 W-046 多档提醒、W-049 周期规则）。 */
export const DeadlineSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  dueAt: z.string().datetime({ offset: true }),
  notified: z.boolean(),
  completed: z.boolean().default(false),
  /** W-046 已发送提醒档位集合。 */
  notifiedTiers: z.array(z.string()).default([]),
  /** W-049 周期规则。 */
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
  /** FocusTimer 借鉴：wait-activity 推进门的「等你回座」标记（备份 JSON 中
   *  可缺省，导入后一律视为 false——等待态跨备份无意义）。 */
  awaitingActivity: z.boolean().default(false)
});

/** 应用完整状态 schema（备份 JSON 的顶层结构）。 */
export const AppStateSchema = z.object({
  tasks: z.array(TaskSchema),
  deadlines: z.array(DeadlineSchema),
  pomodoro: PomodoroStateSchema
});

/* 由 schema 派生的类型（单一事实来源；IPC 线协议类型另见 ts-rs 生成的 types/bindings）。 */
export type Task = z.infer<typeof TaskSchema>;
export type Deadline = z.infer<typeof DeadlineSchema>;
export type PomodoroMode = z.infer<typeof PomodoroModeSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
