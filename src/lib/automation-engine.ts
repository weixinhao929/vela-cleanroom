/**
 * FocusTimer 借鉴（Automation）：专注自动化引擎。
 *
 * 订阅番茄钟事件总线（domain/automation 的 onPomodoroEvent）+ app-store 的
 * pomodoro 状态变化（条件规则逐拍求值），把命中的规则动作经白名单 IPC 执行：
 *  - open：open_path（系统默认处理器打开路径/URL，用户在规则里显式配置）；
 *  - notify：通知中心门面（notifyUser，点击落地到来源组件）；
 *  - toggle-layer：小组件层显隐（Rust 侧同 CLI --toggle-layer 路径）；
 *  - show-desktop / task-view：既有 sys_actions 命令；
 *  - lock：LockWorkStation（sys_lock_screen）。
 *
 * 条件规则的 enter/exit 语义与 FocusTimer ConditionAction 一致：表达式从
 * false 翻 true 执行 actions、从 true 翻 false 执行 exitActions。
 * 仅挂载在 primary widget 窗口（D-1），避免多窗重复执行动作。
 */

import { invoke, isTauri } from "./tauri";
import { notifyUser } from "./notifications";
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

function executeAction(action: AutomationAction, ruleName: string): void {
  switch (action.kind) {
    case "open":
      if (action.target) {
        void invoke("open_path", { path: action.target }).catch(() => {});
      }
      break;
    case "notify":
      void notifyUser(action.title || ruleName, action.body || "", { source: "app" });
      break;
    case "toggle-layer":
      void invoke("automation_toggle_layer").catch(() => {});
      break;
    case "show-desktop":
      void invoke("sys_show_desktop").catch(() => {});
      break;
    case "task-view":
      void invoke("sys_task_view").catch(() => {});
      break;
    case "lock":
      // 复用既有 sys_power_action("lock")（rundll32 → user32!LockWorkStation）。
      void invoke("sys_power_action", { action: "lock" }).catch(() => {});
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
  // 条件规则随 pomodoro 状态逐拍求值（tick 1Hz 改 remaining → 触发订阅）。
  const unsubStore = useAppStore.subscribe(
    (s) => s.pomodoro,
    () => evalConditionRules()
  );

  return () => {
    offEvent();
    unsubStore();
  };
}
