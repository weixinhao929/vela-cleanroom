/**
 * 专注自动化域层（借鉴 FocusTimer Automation）：
 *  - 事件总线：app-store 在番茄钟状态流转的各关键点 emitPomodoroEvent，
 *    自动化引擎（lib/automation-engine.ts）与媒体联动（lib/pomodoro-media.ts）
 *    以订阅者身份消费——store 不反向依赖任何消费者。
 *  - 规则模型：事件触发（多选事件 + 可选条件过滤）与条件触发（条件表达式
 *    持续求值，enter/exit 双动作集）两种，动作白名单收敛于
 *    AutomationActionKind（见 normalizeAutomationRules）。
 *  - 条件 DSL：极小表达式语言（标识符变量 + 数字/字符串/布尔字面量、
 *    比较与 &&/||/!、括号），parseCondition 一次解析、evalCondition 逐拍求值。
 *    未知标识符按字符串字面量处理（state == focus 免引号），无函数调用面，
 *    天然无注入。
 */

import type { PomodoroMode } from "./pomodoro";

/* ---------------- 事件 ---------------- */

/** 番茄钟事件名（app-store 发出，语义见各 emit 点注释）。 */
export type PomodoroEventName =
  | "focus-start" // 专注段开始运行（新段，非恢复）
  | "break-start" // 休息段开始运行（新段）
  | "pause" // 手动暂停
  | "resume" // 从暂停恢复
  | "stop" // 手动停止/重置（含正计时「结束并记录」）
  | "focus-finish" // 专注段倒计时自然走完
  | "break-finish" // 休息段倒计时自然走完
  | "interrupt" // 记录中断（专注段被放弃）
  | "skip"; // 运行中手动切换阶段

export const AUTOMATION_EVENT_NAMES: readonly PomodoroEventName[] = [
  "focus-start",
  "break-start",
  "pause",
  "resume",
  "stop",
  "focus-finish",
  "break-finish",
  "interrupt",
  "skip"
];

/** 事件上下文：条件求值与动作可用的只读快照（时间均为秒）。 */
export interface PomodoroEventContext {
  /** 当前阶段；无进行段时为 "stopped"。 */
  mode: PomodoroMode | "stopped";
  isRunning: boolean;
  isPaused: boolean;
  /** 当前段已专注秒数（倒计时按计划-剩余、正计时按累计）。 */
  elapsedSeconds: number;
  /** 当前段剩余秒数（倒计时口径；正计时恒 0）。 */
  remainingSeconds: number;
  /** 当前段计划秒数。 */
  plannedSeconds: number;
  /** 今日已完成专注轮数。 */
  completedToday: number;
}

type EventHandler = (name: PomodoroEventName, ctx: PomodoroEventContext) => void;
const eventHandlers = new Set<EventHandler>();

/**
 * 发出一个番茄钟事件（同步、逐个调用订阅者；单个订阅者异常不影响其余）。
 * 由 app-store 在状态流转点调用。
 */
export function emitPomodoroEvent(name: PomodoroEventName, ctx: PomodoroEventContext): void {
  for (const handler of eventHandlers) {
    try {
      handler(name, ctx);
    } catch {
      // 消费者异常绝不打断计时主流程
    }
  }
}

/**
 * 订阅番茄钟事件。
 *
 * @param handler - 事件回调。
 * @returns 退订函数（幂等，可重复调用）。
 */
export function onPomodoroEvent(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => {
    eventHandlers.delete(handler);
  };
}

/* ---------------- 规则模型 ---------------- */

/** 动作白名单（FocusTimer 的自由 shell 命令在本地应用里收敛为受控动作集）。 */
export type AutomationActionKind = "open" | "notify" | "toggle-layer" | "show-desktop" | "task-view" | "lock";

export const AUTOMATION_ACTION_KINDS: readonly AutomationActionKind[] = [
  "open",
  "notify",
  "toggle-layer",
  "show-desktop",
  "task-view",
  "lock"
];

export interface AutomationAction {
  kind: AutomationActionKind;
  /** open：路径或 URL；notify：不使用。 */
  target?: string;
  /** notify：通知标题（缺省用规则名）。 */
  title?: string;
  /** notify：通知正文。 */
  body?: string;
}

export type AutomationTrigger =
  { type: "events"; events: PomodoroEventName[]; condition?: string } | { type: "condition"; condition: string };

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** 事件模式：命中即执行；条件模式：进入条件时执行。 */
  actions: AutomationAction[];
  /** 条件模式专属：退出条件时执行。 */
  exitActions?: AutomationAction[];
}

/** 规则数量上限（防配置膨胀；settings 落盘前归一时钳制）。 */
export const AUTOMATION_MAX_RULES = 20;
/** 每个动作集的条数上限。 */
export const AUTOMATION_MAX_ACTIONS = 8;

const ACTION_KIND_SET = new Set<string>(AUTOMATION_ACTION_KINDS);
const EVENT_SET = new Set<string>(AUTOMATION_EVENT_NAMES);

function cleanString(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // 去控制字符，防止把换行/零宽字符藏进条件或目标路径（逐字符过滤，
  // eslint no-control-regex 不允许字面量控制字符区间正则）。
  return Array.from(v)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return (code >= 0x20 && code !== 0x7f) || code > 0x9f;
    })
    .join("")
    .trim()
    .slice(0, max);
}

function normalizeActions(v: unknown): AutomationAction[] {
  if (!Array.isArray(v)) return [];
  const out: AutomationAction[] = [];
  for (const item of v) {
    if (out.length >= AUTOMATION_MAX_ACTIONS) break;
    const src =
      typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!src) continue;
    const kind = src.kind;
    if (typeof kind !== "string" || !ACTION_KIND_SET.has(kind)) continue;
    const action: AutomationAction = { kind: kind as AutomationActionKind };
    if (kind === "open") {
      const target = cleanString(src.target, 2048);
      if (!target) continue; // open 无目标 = 恒失败动作，不入库
      action.target = target;
    } else if (kind === "notify") {
      action.title = cleanString(src.title, 120);
      action.body = cleanString(src.body, 200);
    }
    out.push(action);
  }
  return out;
}

function normalizeCondition(v: unknown): string | undefined {
  const src = cleanString(v, 500);
  // 只在能解析时保留：坏条件静默丢弃比带病落库好（引擎侧同样校验，双保险）。
  if (!src) return undefined;
  try {
    parseCondition(src);
    return src;
  } catch {
    return undefined;
  }
}

/**
 * 归一自动化规则列表（settings 落盘/加载的唯一入口）：丢弃非法项、钳制
 * 数量与长度、条件不可解析时按字段缺失处理（事件模式退化为无条件过滤）。
 *
 * @param v - 任意来源（持久化/导入）的原始值。
 * @returns 合法规则数组（最多 {@link AUTOMATION_MAX_RULES} 条）。
 */
export function normalizeAutomationRules(v: unknown): AutomationRule[] {
  if (!Array.isArray(v)) return [];
  const out: AutomationRule[] = [];
  const seenIds = new Set<string>();
  for (const item of v) {
    if (out.length >= AUTOMATION_MAX_RULES) break;
    const src =
      typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!src) continue;
    const id = cleanString(src.id, 64);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const triggerSrc =
      typeof src.trigger === "object" && src.trigger !== null && !Array.isArray(src.trigger)
        ? (src.trigger as Record<string, unknown>)
        : null;
    const condition = normalizeCondition(triggerSrc?.condition);
    let trigger: AutomationTrigger;
    if (triggerSrc?.type === "condition" && condition) {
      trigger = { type: "condition", condition };
    } else if (triggerSrc?.type === "condition") {
      continue; // 条件模式必须有可解析条件
    } else {
      const events = Array.isArray(triggerSrc?.events)
        ? (triggerSrc.events as unknown[]).filter(
            (e): e is PomodoroEventName => typeof e === "string" && EVENT_SET.has(e)
          )
        : [];
      if (events.length === 0) continue;
      const deduped = [...new Set(events)];
      trigger = { type: "events", events: deduped };
      if (condition) trigger.condition = condition;
    }
    const actions = normalizeActions(src.actions);
    const exitActions = normalizeActions(src.exitActions);
    if (actions.length === 0) continue;
    const rule: AutomationRule = {
      id,
      name: cleanString(src.name, 40) || id,
      enabled: src.enabled !== false,
      trigger,
      actions
    };
    if (trigger.type === "condition" && exitActions.length > 0) rule.exitActions = exitActions;
    out.push(rule);
  }
  return out;
}

/* ---------------- 条件 DSL ---------------- */

/** 条件求值可用的变量（与 PomodoroEventContext 同源；state 为 mode 的别名）。 */
export const CONDITION_VARIABLES = [
  "mode",
  "state",
  "isRunning",
  "isPaused",
  "elapsed",
  "remaining",
  "planned",
  "completedToday"
] as const;

export type ConditionValue = number | string | boolean;

type Token = { t: "num"; v: number } | { t: "str"; v: string } | { t: "ident"; v: string } | { t: "op"; v: string };

/** 条件表达式 AST 节点（parseCondition 的产出，evalCondition 的输入）。 */
export type Node =
  | { k: "lit"; v: ConditionValue }
  | { k: "var"; name: string }
  | { k: "un"; op: "!"; a: Node }
  | { k: "cmp"; op: string; a: Node; b: Node }
  | { k: "logic"; op: "&&" | "||"; a: Node; b: Node };

const TWO_CHAR_OPS = ["==", "!=", "<=", ">=", "&&", "||"];
const ONE_CHAR_OPS = ["(", ")", "!", "<", ">"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new Error("字符串未闭合");
      tokens.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new Error(`非法数字：${src.slice(i, j)}`);
      tokens.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j++;
      tokens.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new Error(`无法识别的字符：${ch}`);
  }
  return tokens;
}

/** 解析条件表达式；语法错误抛 Error（消息为中文，可直接展示在设置页）。 */
export function parseCondition(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];
  const expectOp = (op: string): void => {
    const tk = next();
    if (!tk || tk.t !== "op" || tk.v !== op) throw new Error(`缺少「${op}」`);
  };

  function parsePrimary(): Node {
    const tk = next();
    if (!tk) throw new Error("条件意外结束");
    if (tk.t === "num") return { k: "lit", v: tk.v };
    if (tk.t === "str") return { k: "lit", v: tk.v };
    if (tk.t === "ident") {
      if (tk.v === "true") return { k: "lit", v: true };
      if (tk.v === "false") return { k: "lit", v: false };
      return { k: "var", name: tk.v };
    }
    if (tk.t === "op" && tk.v === "(") {
      const inner = parseOr();
      expectOp(")");
      return inner;
    }
    if (tk.t === "op" && tk.v === "!") return { k: "un", op: "!", a: parsePrimary() };
    throw new Error(`意外的内容：${JSON.stringify(tk)}`);
  }

  function parseCmp(): Node {
    const a = parsePrimary();
    const tk = peek();
    if (tk && tk.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(tk.v)) {
      next();
      const b = parsePrimary();
      return { k: "cmp", op: tk.v, a, b };
    }
    return a;
  }

  function parseAnd(): Node {
    let a = parseCmp();
    while (peek()?.t === "op" && (peek() as { v: string }).v === "&&") {
      next();
      const b = parseCmp();
      a = { k: "logic", op: "&&", a, b };
    }
    return a;
  }

  function parseOr(): Node {
    let a = parseAnd();
    while (peek()?.t === "op" && (peek() as { v: string }).v === "||") {
      next();
      const b = parseAnd();
      a = { k: "logic", op: "||", a, b };
    }
    return a;
  }

  const root = parseOr();
  if (pos !== tokens.length) throw new Error("条件末尾有多余内容");
  return root;
}

function variableValue(name: string, ctx: PomodoroEventContext): ConditionValue {
  switch (name) {
    case "mode":
    case "state":
      return ctx.mode;
    case "isRunning":
      return ctx.isRunning;
    case "isPaused":
      return ctx.isPaused;
    case "elapsed":
      return ctx.elapsedSeconds;
    case "remaining":
      return ctx.remainingSeconds;
    case "planned":
      return ctx.plannedSeconds;
    case "completedToday":
      return ctx.completedToday;
    default:
      // 未知标识符按其名字作为字符串字面量（state == focus 免引号）。
      return name;
  }
}

function truthy(v: ConditionValue): boolean {
  return v !== false && v !== 0 && v !== "" && v !== null && v !== undefined;
}

function compare(op: string, a: ConditionValue, b: ConditionValue): boolean {
  const bothNum = typeof a === "number" && typeof b === "number";
  const bothBool = typeof a === "boolean" && typeof b === "boolean";
  switch (op) {
    case "==":
      return bothNum || bothBool || typeof a === typeof b ? a === b : String(a) === String(b);
    case "!=":
      return !compare("==", a, b);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (bothNum) {
        const x = a as number;
        const y = b as number;
        return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
      }
      const x = String(a);
      const y = String(b);
      return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
    }
    default:
      return false;
  }
}

/**
 * 对已解析的条件求值。
 *
 * @param node - {@link parseCondition} 的返回值。
 * @param ctx - 事件上下文（变量来源）。
 * @returns 条件是否成立。
 */
export function evalCondition(node: Node, ctx: PomodoroEventContext): boolean {
  switch (node.k) {
    case "lit":
      return truthy(node.v);
    case "var":
      return truthy(variableValue(node.name, ctx));
    case "un":
      return !truthy(evalAsValue(node.a, ctx));
    case "cmp":
      return compare(node.op, evalAsValue(node.a, ctx), evalAsValue(node.b, ctx));
    case "logic": {
      const a = truthy(evalAsValue(node.a, ctx));
      if (node.op === "&&") return a && truthy(evalAsValue(node.b, ctx));
      return a || truthy(evalAsValue(node.b, ctx));
    }
  }
}

/** 中间求值（保留原始值类型，供比较/取反使用；导出仅为测试与复用）。 */
export function evalAsValue(node: Node, ctx: PomodoroEventContext): ConditionValue {
  switch (node.k) {
    case "lit":
      return node.v;
    case "var":
      return variableValue(node.name, ctx);
    case "un":
      return !truthy(evalAsValue(node.a, ctx));
    case "cmp":
      return compare(node.op, evalAsValue(node.a, ctx), evalAsValue(node.b, ctx));
    case "logic": {
      const a = truthy(evalAsValue(node.a, ctx));
      if (node.op === "&&") return a && truthy(evalAsValue(node.b, ctx));
      return a || truthy(evalAsValue(node.b, ctx));
    }
  }
}

/**
 * 校验条件文案（设置页输入反馈用）。
 *
 * @param src - 条件字符串。
 * @returns null 表示合法；否则返回错误消息。
 */
export function validateCondition(src: string): string | null {
  if (!src.trim()) return "条件不能为空";
  try {
    parseCondition(src);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
