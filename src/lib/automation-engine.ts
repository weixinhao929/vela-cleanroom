/**
 * （Automation）：专注自动化引擎。
 *
 * 订阅番茄钟事件总线（domain/automation 的 onPomodoroEvent）+ app-store 的
 * pomodoro 状态变化（条件规则逐拍求值），把命中的规则动作经白名单 IPC 执行：
 *  - open：open_path（系统默认处理器打开路径/URL，用户在规则里显式配置）；
 *  - notify：通知中心门面（notifyUser，点击落地到来源组件）；
 *  - toggle-layer：小组件层显隐（Rust 侧同 CLI --toggle-layer 路径）；
 *  - show-desktop / task-view：既有 sys_actions 命令；
 *  - lock：LockWorkStation（sys_lock_screen）。
 *
 * 条件规则的 enter/exit 语义与 ConditionAction 一致：表达式从
 * false 翻 true 执行 actions、从 true 翻 false 执行 exitActions。
 * 仅挂载在 primary widget 窗口，避免多窗重复执行动作。
 */

import { invoke, isTauri } from "./tauri";
import { notifyUser } from "./notifications";
import { logCrash, toCrashFields } from "./crash-log";
import { listen } from "@tauri-apps/api/event";
import {
  evalCondition,
  onPomodoroEvent,
  parseCondition,
  type AutomationAction,
  type Node as ConditionAst,
  type PomodoroEventContext
} from "../domain/automation";
import { getPomodoroEventContext, useAppStore } from "../store/app-store";
import { useSettingsStore } from "../store/settings-store";

/** [PROC-WATCH]process-event 载荷（Rust ProcessEvent）。 */
type ProcessEventPayload = { pattern: string; name: string; kind: string };

/** 动作 IPC 的统一错误出口——此前全部 .catch(() => {}) 纯静默，规则
 *  命中但动作失败（路径打不开 / 命令被闸门拒绝）时用户与诊断面板均无从
 *  得知。失败记 crash-log（设置页诊断区可见）+ console.error；不抛出——
 *  单个动作失败不得打断同一轮的其余动作，更不能炸掉事件回调链。 */
function runActionIPC(label: string, op: () => Promise<unknown>): void {
  void op().catch((err: unknown) => {
    logCrash({ source: "automation", detail: label, ...toCrashFields(err) });
    console.error("[automation] action failed:", label, err);
  });
}

function executeAction(action: AutomationAction, ruleName: string): void {
  switch (action.kind) {
    case "open":
      if (action.target) {
        runActionIPC(`open ${action.target}`, () => invoke("open_path", { path: action.target }));
      }
      break;
    case "notify":
      runActionIPC(`notify ${action.title || ruleName}`, () =>
        notifyUser(action.title || ruleName, action.body || "", { source: "app" })
      );
      break;
    case "toggle-layer":
      runActionIPC("toggle-layer", () => invoke("automation_toggle_layer"));
      break;
    case "show-desktop":
      runActionIPC("show-desktop", () => invoke("sys_show_desktop"));
      break;
    case "task-view":
      runActionIPC("task-view", () => invoke("sys_task_view"));
      break;
    case "lock":
      // 复用既有 sys_power_action("lock")（rundll32 → user32!LockWorkStation）。
      runActionIPC("lock", () => invoke("sys_power_action", { action: "lock" }));
      break;
  }
}

/** 条件解析缓存：同一条件串只 parse 一次（tick 级高频求值）。 */
const astCache = new Map<string, ConditionAst | null>();

function cachedAst(condition: string): ConditionAst | null {
  const hit = astCache.get(condition);
  if (hit !== undefined) return hit;
  let ast: ConditionAst | null = null;
  try {
    ast = parseCondition(condition);
  } catch {
    ast = null;
  }
  // 缓存上限防膨胀（条件串来自已归一的设置，正常不会多）。
  if (astCache.size > 128) astCache.clear();
  astCache.set(condition, ast);
  return ast;
}

/** 当前启用规则的条件求值上下文（store 快照；emit 载荷同构）。 */
function currentContext(): PomodoroEventContext {
  return getPomodoroEventContext();
}

/**
 * 启动专注自动化引擎。
 *
 * @returns 退订函数（App 卸载时清理；幂等）。
 */
export function setupPomodoroAutomation(): () => void {
  if (!isTauri()) return () => {};

  const conditionState = new Map<string, boolean>();

  const runEventRules = (name: string, ctx: PomodoroEventContext) => {
    const rules = useSettingsStore.getState().extra.pomodoroAutomation;
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.type !== "events") continue;
      if (!rule.trigger.events.includes(name as never)) continue;
      if (rule.trigger.condition) {
        const ast = cachedAst(rule.trigger.condition);
        if (!ast || !evalCondition(ast, ctx)) continue;
      }
      for (const action of rule.actions) executeAction(action, rule.name);
    }
  };

  const evalConditionRules = () => {
    const rules = useSettingsStore.getState().extra.pomodoroAutomation;
    const ctx = currentContext();
    const activeIds = new Set<string>();
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.type !== "condition") continue;
      activeIds.add(rule.id);
      const ast = cachedAst(rule.trigger.condition);
      if (!ast) continue;
      const now = evalCondition(ast, ctx);
      const prev = conditionState.get(rule.id) ?? false;
      if (now && !prev) {
        for (const action of rule.actions) executeAction(action, rule.name);
      } else if (!now && prev) {
        for (const action of rule.exitActions ?? []) executeAction(action, rule.name);
      }
      conditionState.set(rule.id, now);
    }
    // 清理已删除/停用的规则状态，避免退出动作在意外时机补发。
    for (const id of [...conditionState.keys()]) {
      if (!activeIds.has(id)) conditionState.delete(id);
    }
  };

  const offEvent = onPomodoroEvent((name, ctx) => {
    runEventRules(name, ctx);
    evalConditionRules();
  });

  /* （订阅收敛）：此前订阅整个 s.pomodoro 对象——tick 每秒改
   * remainingSeconds 都触发一次全量求值（buildEventContext 对最多 500 条
   * sessions filter + isSameVirtualDay 再逐条跑 AST），规则里没引用
   * remaining/elapsed 时纯属 1Hz 空转。改为订阅「启用中的条件规则实际引用
   * 的上下文字段」的派生签名字符串：任一 store 写入后重算签名，签名不变
   * （本次变化与任何条件规则无关）则不进求值。elapsed/remaining 类条件在
   * 运行期随 tick 逐秒变签名，行为与旧订阅一致；规则集变化时在下方
   * unsubSettings 回调里刷新字段面。 */
  const VAR_TO_CTX_FIELD: Record<string, keyof PomodoroEventContext> = {
    mode: "mode",
    state: "mode", // DSL 里 state 是 mode 的别名
    isRunning: "isRunning",
    isPaused: "isPaused",
    elapsed: "elapsedSeconds",
    remaining: "remainingSeconds",
    planned: "plannedSeconds",
    completedToday: "completedToday"
  };
  const collectConditionFields = (): (keyof PomodoroEventContext)[] => {
    const rules = useSettingsStore.getState().extra.pomodoroAutomation;
    const used = new Set<keyof PomodoroEventContext>();
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.type !== "condition") continue;
      for (const [ident, field] of Object.entries(VAR_TO_CTX_FIELD)) {
        // 词边界匹配防误命中（elapsedX 不算引用 elapsed）；未知标识符按 DSL
        // 语义是字符串字面量，不构成字段引用（宁可多订阅，不可漏订阅）。
        if (new RegExp(`\\b${ident}\\b`).test(rule.trigger.condition)) used.add(field);
      }
    }
    return [...used];
  };
  let conditionFields = collectConditionFields();
  const conditionSignature = (): string => {
    const ctx = currentContext();
    return conditionFields.map((f) => String(ctx[f])).join("|");
  };
  const unsubStore = useAppStore.subscribe(conditionSignature, () => evalConditionRules());

  /* [PROC-WATCH]：进程启动/退出规则。
   *  - 规则集变化（含启用态）→ 全量下发监视模式（Rust 懒启停：空列表停线程）；
   *  - process-event 载荷 pattern = 规则模式原文（大小写不敏感比对），命中即
   *    执行该规则动作。 */
  const patternsOf = (): string[] => {
    const rules = useSettingsStore.getState().extra.pomodoroAutomation;
    const out: string[] = [];
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.type !== "process") continue;
      if (!out.includes(rule.trigger.process.name)) out.push(rule.trigger.process.name);
    }
    return out;
  };
  const pushWatchPatterns = () => {
    void invoke("set_process_watch", { patterns: patternsOf() }).catch(() => {});
  };
  pushWatchPatterns();
  const unsubSettings = useSettingsStore.subscribe(
    (s) => s.extra.pomodoroAutomation,
    () => {
      // 规则集变化时同步刷新条件引用字段面——新引用的字段从下一拍
      // 进入签名，不再引用的字段退出（无关变化不再触发空转求值）。
      conditionFields = collectConditionFields();
      pushWatchPatterns();
    }
  );

  const offProcessEvent = listen<ProcessEventPayload>("process-event", (e) => {
    const p = e.payload;
    if (!p || typeof p.pattern !== "string") return;
    const rules = useSettingsStore.getState().extra.pomodoroAutomation;
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.type !== "process") continue;
      if (rule.trigger.process.name.toLowerCase() !== p.pattern.toLowerCase()) continue;
      if (rule.trigger.process.event !== p.kind) continue;
      for (const action of rule.actions) {
        executeAction(action, `${rule.name} · ${p.name}`);
      }
    }
  });

  /* （变体）：注册 promise 不 void 直挂 catch 标记已处理；
     cleanup 的 .then 链同样补 catch，两条路径都不留未处理 rejection。 */
  offProcessEvent.catch(() => {});
  return () => {
    offEvent();
    unsubStore();
    unsubSettings();
    void offProcessEvent.then((off) => off()).catch(() => {});
    // 卸载即停（引擎仅 primary 挂载，收窗时释放监视线程）。
    void invoke("set_process_watch", { patterns: [] }).catch(() => {});
  };
}
