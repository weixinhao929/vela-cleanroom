import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * automation-engine · mock-invoke 分发矩阵（补测试）：
 * - 事件规则：命中事件 → executeAction 下发白名单 IPC / 通知；未命中不发；
 * - 条件规则：随订阅签名驱动 enter/exit 动作（引用字段变化才求值）；
 * - 动作 IPC reject：错误记入 crash-log + console.error，且不炸后续分发。
 */
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
const notifyMock = vi.fn(async (_title: string, _body: string, _meta?: unknown): Promise<void> => undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, _handler: unknown) => Promise.resolve(() => {})
}));
vi.mock("./tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./tauri")>();
  return {
    ...mod,
    isTauri: () => true,
    invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args)
  };
});
vi.mock("./notifications", () => ({
  notifyUser: (title: string, body: string, meta?: unknown) => notifyMock(title, body, meta)
}));

import { setupPomodoroAutomation } from "./automation-engine";
import { clearCrashLog, getCrashLog } from "./crash-log";
import { getPomodoroEventContext, useAppStore } from "../store/app-store";
import { useSettingsStore } from "../store/settings-store";
import { emitPomodoroEvent, type AutomationRule } from "../domain/automation";
import { createInitialState } from "../domain/pomodoro";

/** 只统计业务命令，排除 set_process_watch（规则集推送）与 report_frontend_crash
 * （crash-log 上报）这两条引擎自身的基础设施 IPC。 */
const callsOf = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

const setRules = (rules: AutomationRule[]) =>
  useSettingsStore.setState({
    extra: { ...useSettingsStore.getState().extra, pomodoroAutomation: rules }
  });

const setPomodoro = (patch: Partial<ReturnType<typeof createInitialState>>) =>
  useAppStore.setState({
    pomodoro: { ...createInitialState(useAppStore.getState().pomodoroConfig), ...patch }
  });

let cleanup: (() => void) | null = null;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  notifyMock.mockClear();
  clearCrashLog();
  localStorage.clear();
  setRules([]);
  setPomodoro({});
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("事件规则分发", () => {
  it("命中事件：白名单动作逐条下发（toggle-layer IPC + notify 通知）", () => {
    setRules([
      {
        id: "r1",
        name: "专注完成庆祝",
        enabled: true,
        trigger: { type: "events", events: ["focus-finish"] },
        actions: [{ kind: "toggle-layer" }, { kind: "notify", title: "完成", body: "干得好" }]
      }
    ]);
    cleanup = setupPomodoroAutomation();
    emitPomodoroEvent("focus-finish", getPomodoroEventContext());

    expect(callsOf("automation_toggle_layer")).toHaveLength(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith("完成", "干得好", { source: "app" });
  });

  it("未命中事件：不下发任何动作", () => {
    setRules([
      {
        id: "r2",
        name: "暂停提醒",
        enabled: true,
        trigger: { type: "events", events: ["pause"] },
        actions: [{ kind: "toggle-layer" }]
      }
    ]);
    cleanup = setupPomodoroAutomation();
    emitPomodoroEvent("focus-finish", getPomodoroEventContext());

    expect(callsOf("automation_toggle_layer")).toHaveLength(0);
  });

  it("停用规则 / 事件过滤条件不满足：不触发", () => {
    setRules([
      {
        id: "r3",
        name: "仅专注时",
        enabled: false,
        trigger: { type: "events", events: ["focus-finish"] },
        actions: [{ kind: "lock" }]
      }
    ]);
    cleanup = setupPomodoroAutomation();
    emitPomodoroEvent("focus-finish", getPomodoroEventContext());
    expect(callsOf("sys_power_action")).toHaveLength(0);
  });
});

describe("条件规则（签名订阅驱动）", () => {
  it("引用字段翻转：enter 执行 actions、exit 执行 exitActions", () => {
    setRules([
      {
        id: "c1",
        name: "运行时段",
        enabled: true,
        trigger: { type: "condition", condition: "isRunning == true" },
        actions: [{ kind: "toggle-layer" }],
        exitActions: [{ kind: "show-desktop" }]
      }
    ]);
    cleanup = setupPomodoroAutomation();

    // isRunning false → true：进入条件，actions 执行。
    setPomodoro({ isRunning: true, mode: "focus" });
    expect(callsOf("automation_toggle_layer")).toHaveLength(1);
    expect(callsOf("sys_show_desktop")).toHaveLength(0);

    // true → false：退出条件，exitActions 执行。
    setPomodoro({ isRunning: false });
    expect(callsOf("sys_show_desktop")).toHaveLength(1);
    expect(callsOf("automation_toggle_layer")).toHaveLength(1);
  });

  it("剩余秒数跨过条件阈值：remaining 引用字段变化触发求值", () => {
    setRules([
      {
        id: "c2",
        name: "最后十分钟",
        enabled: true,
        trigger: { type: "condition", condition: "remaining <= 600" },
        actions: [{ kind: "task-view" }]
      }
    ]);
    cleanup = setupPomodoroAutomation();
    // 无锚点时 ctx.remaining 回退存储值（wallRemaining 的测试友好路径）。
    setPomodoro({ isRunning: true, mode: "focus", timerMode: "countdown", remainingSeconds: 1500 });
    expect(callsOf("sys_task_view")).toHaveLength(0);

    setPomodoro({ isRunning: true, mode: "focus", timerMode: "countdown", remainingSeconds: 600 });
    expect(callsOf("sys_task_view")).toHaveLength(1);
  });
});

describe("动作失败路径", () => {
  it("executeAction reject：错误记入 crash-log + console.error，循环不炸", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "automation_toggle_layer") throw new Error("layer 模块未就绪");
        return undefined;
      });
      setRules([
        {
          id: "e1",
          name: "专注完成庆祝",
          enabled: true,
          trigger: { type: "events", events: ["focus-finish"] },
          actions: [{ kind: "toggle-layer" }]
        }
      ]);
      cleanup = setupPomodoroAutomation();

      emitPomodoroEvent("focus-finish", getPomodoroEventContext());
      await new Promise((r) => setTimeout(r, 0));

      // 错误被记录（不再纯静默 .catch(() => {})）。
      expect(errSpy).toHaveBeenCalledWith(
        "[automation] action failed:",
        "toggle-layer",
        expect.objectContaining({ message: "layer 模块未就绪" })
      );
      expect(getCrashLog().some((e) => e.source === "automation" && e.detail === "toggle-layer")).toBe(true);

      // 循环未死：同一规则的下一次事件仍会尝试执行动作。
      emitPomodoroEvent("focus-finish", getPomodoroEventContext());
      await new Promise((r) => setTimeout(r, 0));
      expect(callsOf("automation_toggle_layer")).toHaveLength(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
