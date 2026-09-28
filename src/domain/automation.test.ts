import { describe, expect, it } from "vitest";
import {
  emitPomodoroEvent,
  evalCondition,
  normalizeAutomationRules,
  onPomodoroEvent,
  parseCondition,
  validateCondition,
  type PomodoroEventContext
} from "./automation";
import { DEFAULT_CONFIG, createInitialState, isFocusCompleted, pomodoroReducer } from "./pomodoro";

const ctx = (over: Partial<PomodoroEventContext> = {}): PomodoroEventContext => ({
  mode: "focus",
  isRunning: true,
  isPaused: false,
  elapsedSeconds: 600,
  remainingSeconds: 900,
  plannedSeconds: 1500,
  completedToday: 3,
  ...over
});

describe("条件 DSL", () => {
  it("求值比较与逻辑组合（免引号枚举字面量）", () => {
    const ast = parseCondition('state == focus || state == "shortBreak"');
    expect(evalCondition(ast, ctx())).toBe(true);
    expect(evalCondition(ast, ctx({ mode: "longBreak" }))).toBe(false);
    expect(evalCondition(parseCondition("remaining <= 300 && isRunning"), ctx())).toBe(false);
    expect(evalCondition(parseCondition("elapsed > 60 && completedToday >= 2"), ctx())).toBe(true);
    expect(evalCondition(parseCondition("!isPaused"), ctx())).toBe(true);
    expect(evalCondition(parseCondition("!(state == focus)"), ctx({ mode: "stopped" }))).toBe(true);
  });

  it("未知标识符按字符串字面量、括号嵌套与比较运算", () => {
    expect(evalCondition(parseCondition("state == stopped"), ctx({ mode: "stopped" }))).toBe(true);
    expect(evalCondition(parseCondition("(elapsed >= 300 || remaining < 60) && isRunning"), ctx())).toBe(true);
    expect(evalCondition(parseCondition("planned != 0"), ctx())).toBe(true);
  });

  it("语法错误被 validateCondition 捕获", () => {
    expect(validateCondition("remaining <=")).toBe("条件意外结束");
    expect(validateCondition("state == focus &&")).not.toBeNull();
    expect(validateCondition("state == focus && (remaining < 60")).not.toBeNull();
    expect(validateCondition("state == focus")).toBeNull();
  });
});

describe("规则归一 normalizeAutomationRules", () => {
  it("丢弃非法动作/空事件/坏条件，保留合法规则", () => {
    const rules = normalizeAutomationRules([
      {
        id: "r1",
        name: "正常规则",
        enabled: true,
        trigger: { type: "events", events: ["focus-start", "bogus"] },
        actions: [{ kind: "notify", title: "开跑", body: "" }]
      },
      { id: "r2", trigger: { type: "events", events: [] }, actions: [{ kind: "notify" }] },
      { id: "r3", trigger: { type: "condition", condition: "state ==" }, actions: [{ kind: "notify" }] },
      { id: "r4", trigger: { type: "events", events: ["stop"] }, actions: [{ kind: "hack", target: "x" }] },
      { id: "r5", trigger: { type: "condition", condition: "state == focus" }, actions: [{ kind: "toggle-layer" }] }
    ]);
    expect(rules.map((r) => r.id)).toEqual(["r1", "r5"]);
    expect(rules[0].trigger.type === "events" && rules[0].trigger.events).toEqual(["focus-start"]);
    expect(rules[1].trigger.type).toBe("condition");
  });

  it("条件模式保留 exitActions，open 无目标被丢弃", () => {
    const rules = normalizeAutomationRules([
      {
        id: "a",
        trigger: { type: "condition", condition: "state == focus" },
        actions: [{ kind: "open", target: "https://example.com" }],
        exitActions: [{ kind: "lock" }, { kind: "open" }]
      }
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].exitActions).toEqual([{ kind: "lock" }]);
  });
});

describe("事件总线", () => {
  it("emit 逐个通知订阅者；单个订阅者异常不影响其余；退订生效", () => {
    const seen: string[] = [];
    const offA = onPomodoroEvent((name) => seen.push(`${name}:a`));
    const offBoom = onPomodoroEvent(() => {
      throw new Error("boom");
    });
    const offB = onPomodoroEvent((name) => seen.push(`${name}:b`));
    expect(() => emitPomodoroEvent("focus-start", ctx())).not.toThrow();
    expect(seen).toContain("focus-start:a");
    expect(seen).toContain("focus-start:b");
    offA();
    offBoom();
    seen.length = 0;
    emitPomodoroEvent("stop", ctx());
    expect(seen).toEqual(["stop:b"]);
    offB();
    seen.length = 0;
    emitPomodoroEvent("stop", ctx());
    expect(seen).toEqual([]);
  });
});

describe("推进门（advanceGate）reducer 语义", () => {
  it("auto：休息结束自动开始下一轮专注（现状不变）", () => {
    const cfg = { ...DEFAULT_CONFIG, autoCycle: true, autoStartNext: true, advanceGate: "auto" as const };
    let s = pomodoroReducer(createInitialState(cfg), { type: "toggle" }, cfg);
    for (let i = 0; i < 1500; i++) s = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(s.mode).toBe("shortBreak");
    expect(s.isRunning).toBe(true);
    for (let i = 0; i < 300; i++) s = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(s.mode).toBe("focus");
    expect(s.isRunning).toBe(true);
    expect(s.awaitingActivity).toBe(false);
  });

  it("confirm：每段结束就位但不自动开始", () => {
    const cfg = { ...DEFAULT_CONFIG, autoCycle: true, autoStartNext: true, advanceGate: "confirm" as const };
    let s = pomodoroReducer(createInitialState(cfg), { type: "toggle" }, cfg);
    for (let i = 0; i < 1500; i++) s = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(s.mode).toBe("shortBreak");
    expect(s.isRunning).toBe(false);
    expect(s.awaitingActivity).toBe(false);
  });

  it("wait-activity：仅对「下一段是专注」置 awaitingActivity", () => {
    const cfg = { ...DEFAULT_CONFIG, autoCycle: true, autoStartNext: true, advanceGate: "wait-activity" as const };
    let s = pomodoroReducer(createInitialState(cfg), { type: "toggle" }, cfg);
    for (let i = 0; i < 1500; i++) s = pomodoroReducer(s, { type: "tick" }, cfg);
    // 专注结束 → 下一段休息照常自动开始
    expect(s.mode).toBe("shortBreak");
    expect(s.isRunning).toBe(true);
    expect(s.awaitingActivity).toBe(false);
    for (let i = 0; i < 300; i++) s = pomodoroReducer(s, { type: "tick" }, cfg);
    // 休息结束 → 下一段专注就位等回座
    expect(s.mode).toBe("focus");
    expect(s.isRunning).toBe(false);
    expect(s.awaitingActivity).toBe(true);
    // 手动开始即清除等待标记
    const started = pomodoroReducer(s, { type: "toggle" }, cfg);
    expect(started.awaitingActivity).toBe(false);
  });

  it("autoStartNext=false 时门不生效（保持单段语义）", () => {
    const cfg = { ...DEFAULT_CONFIG, autoCycle: true, autoStartNext: false, advanceGate: "wait-activity" as const };
    let s = pomodoroReducer(createInitialState(cfg), { type: "toggle" }, cfg);
    for (let i = 0; i < 1500; i++) s = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(s.mode).toBe("shortBreak");
    expect(s.isRunning).toBe(false);
    expect(s.awaitingActivity).toBe(false);
  });
});

describe("75% 完成阈值与加时", () => {
  it("isFocusCompleted 边界（25 分钟的 75% = 1125 秒）", () => {
    expect(isFocusCompleted(1125, 1500)).toBe(true);
    expect(isFocusCompleted(1124, 1500)).toBe(false);
    expect(isFocusCompleted(500, 0)).toBe(false);
  });

  it("adjust：运行中 ±N，倒计时剩余保底 10s，正计时保底 0；未运行无效", () => {
    const cfg = DEFAULT_CONFIG;
    let s = pomodoroReducer(createInitialState(cfg), { type: "toggle" }, cfg);
    for (let i = 0; i < 100; i++) s = pomodoroReducer(s, { type: "tick" }, cfg);
    expect(s.remainingSeconds).toBe(1400);
    s = pomodoroReducer(s, { type: "adjust", delta: 300 }, cfg);
    expect(s.remainingSeconds).toBe(1700);
    s = pomodoroReducer(s, { type: "adjust", delta: -5000 }, cfg);
    expect(s.remainingSeconds).toBe(10);
    const stopped = pomodoroReducer(s, { type: "toggle" }, cfg);
    expect(pomodoroReducer(stopped, { type: "adjust", delta: 60 }, cfg)).toBe(stopped);
    // 正计时：累计秒数可增可减，保底 0
    let c = pomodoroReducer(createInitialState(cfg), { type: "setTimerMode", timerMode: "countup" }, cfg);
    c = pomodoroReducer(c, { type: "toggle" }, cfg);
    for (let i = 0; i < 120; i++) c = pomodoroReducer(c, { type: "tick" }, cfg);
    expect(c.remainingSeconds).toBe(120);
    c = pomodoroReducer(c, { type: "adjust", delta: -500 }, cfg);
    expect(c.remainingSeconds).toBe(0);
  });
});
