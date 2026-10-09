import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "./app-store";
import { createInitialState, DEFAULT_CONFIG } from "../domain/pomodoro";
import { onPomodoroEvent } from "../domain/automation";

/**
 * 墙钟锚点：计时进度由 (Date.now() - segmentAnchorMs) 反推，而非 tick
 * 次数。系统睡眠 / 后台节流导致 tick 停摆后，唤醒后的第一次 tick 即可把
 * remaining 拉回墙钟真实值。本组用 fake timers 推进系统时间模拟「tick 完全
 * 停摆、墙钟继续走」的场景。
 */
describe("番茄钟墙钟锚点（A-1）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 0));
    localStorage.clear();
    useAppStore.setState({
      pomodoro: createInitialState(useAppStore.getState().pomodoroConfig),
      sessions: [],
      interruptions: []
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const startFocus = () => {
    const s = useAppStore.getState();
    s.selectPomodoroEvent(null, "测试专注");
    expect(s.togglePomodoro()).toBe(true);
    const p = useAppStore.getState().pomodoro;
    expect(p.isRunning).toBe(true);
    expect(p.remainingSeconds).toBe(25 * 60);
  };

  it("tick 停摆 100 秒后唤醒：一次 tick 即按墙钟差缩短 100 秒", () => {
    startFocus();
    // 模拟系统睡眠：墙钟前进 100 秒，期间没有任何 tick。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 1, 40));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 100);
  });

  it("连续 tick 与墙钟同步：每秒一次 tick 时 remaining 逐秒递减", () => {
    startFocus();
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(new Date(2026, 7, 18, 10, 0, i));
      useAppStore.getState().tickPomodoro();
      expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - i);
    }
  });

  it("暂停冻结墙钟值并清除锚点：暂停期间墙钟前进不影响恢复后的倒计时", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 60));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 60);

    // 暂停：remaining 冻结在墙钟真实值。
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    expect(useAppStore.getState().pomodoro.isRunning).toBe(false);
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 60);

    // 暂停 5 分钟：恢复后锚点重设，remaining 从冻结值继续。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 6, 0));
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 60);

    // 恢复 30 秒后的一次 tick：只扣 30 秒，暂停的 5 分钟不计入。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 6, 30));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60 - 90);
  });

  it("resetPomodoro 清锚点：重置后不运行的 tick 无副作用", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 10));
    useAppStore.getState().resetPomodoro();
    const after = useAppStore.getState().pomodoro;
    expect(after.isRunning).toBe(false);
    expect(after.remainingSeconds).toBe(25 * 60);
    // 重置后（未运行）tick 不改变状态。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 5, 0));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().pomodoro.remainingSeconds).toBe(25 * 60);
  });
});

/**
 * 75% 完成阈值的三条路径（运行中中断 / 暂停中中断 /
 * 暂停超 2h 过期结算）口径必须一致；正计 60s 整轮规则；start 事件时序。
 */
describe("番茄钟中断/过期结算口径", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 0));
    localStorage.clear();
    useAppStore.setState({
      pomodoro: createInitialState(useAppStore.getState().pomodoroConfig),
      sessions: [],
      interruptions: []
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const startFocus = () => {
    const s = useAppStore.getState();
    s.selectPomodoroEvent(null, "测试专注");
    expect(s.togglePomodoro()).toBe(true);
  };

  it("运行中中断：净专注 ≥75% 计划时长 → completed:true 且计入轮数", () => {
    startFocus();
    // 25 分钟计划，专注满 20 分钟（80%）后中断。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 20, 0));
    useAppStore.getState().interruptPomodoro("电话");
    const st = useAppStore.getState();
    const rec = st.sessions.at(-1);
    expect(rec?.completed).toBe(true);
    expect(rec?.plannedSeconds).toBe(20 * 60);
    expect(st.pomodoro.completedFocusSessions).toBe(1);
    expect(st.interruptions).toHaveLength(1);
    expect(st.interruptions[0].elapsedSeconds).toBe(20 * 60);
  });

  it("P1：暂停中也可记录中断——已有进度按同款 75% 阈值结算", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 20, 0));
    useAppStore.getState().togglePomodoro(); // 暂停（80% 处）
    expect(useAppStore.getState().pomodoro.isRunning).toBe(false);
    // 暂停态直接记录中断（此前该入口不存在，只能重置且不落记录）。
    vi.setSystemTime(new Date(2026, 7, 18, 11, 0, 0));
    useAppStore.getState().interruptPomodoro("消息");
    const st = useAppStore.getState();
    const rec = st.sessions.at(-1);
    // elapsed 按暂停冻结值结算（暂停时长不计），20 分钟 ≥75% → 完成口径。
    expect(rec?.completed).toBe(true);
    expect(rec?.plannedSeconds).toBe(20 * 60);
    expect(st.interruptions[0].elapsedSeconds).toBe(20 * 60);
    expect(st.pomodoro.isRunning).toBe(false);
  });

  it("P1：暂停超 2h 过期结算同样走 75% 阈值（不再恒记放弃）", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 20, 0));
    useAppStore.getState().togglePomodoro(); // 80% 处暂停
    // 暂停超过 2 小时后再点开始：旧段按放弃结算，达标则记完成。
    vi.setSystemTime(new Date(2026, 7, 18, 13, 0, 0));
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    const st = useAppStore.getState();
    const rec = st.sessions.at(-1);
    expect(rec?.completed).toBe(true);
    expect(rec?.plannedSeconds).toBe(20 * 60);
    expect(st.pomodoro.completedFocusSessions).toBeGreaterThanOrEqual(1);
  });

  it("正计时「结束并记录」：<60s 不计轮数，≥60s 计一轮", () => {
    const s = useAppStore.getState();
    s.setPomodoroTimerMode("countup");
    s.selectPomodoroEvent(null, "正计测试");
    s.togglePomodoro();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 30));
    useAppStore.getState().stopCountupFocus();
    const short = useAppStore.getState().sessions.at(-1);
    expect(short?.completed).toBe(false);
    expect(useAppStore.getState().pomodoro.completedFocusSessions).toBe(0);

    // 再来一段 2 分钟的：计一轮。
    s.togglePomodoro();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 3, 0));
    useAppStore.getState().stopCountupFocus();
    const full = useAppStore.getState().sessions.at(-1);
    expect(full?.completed).toBe(true);
    // 第二段从 10:00:30 重新开始到 10:03:00，净时长 150s。
    expect(full?.plannedSeconds).toBe(150);
    expect(useAppStore.getState().pomodoro.completedFocusSessions).toBe(1);
  });

  it("P1（emit 时序）：focus-start 事件的上下文 isRunning 必须为 true", () => {
    const seen: boolean[] = [];
    const un = onPomodoroEvent((name, ctx) => {
      if (name === "focus-start") seen.push(ctx.isRunning);
    });
    startFocus();
    un();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((v) => v === true)).toBe(true);
  });
});

/**
 * 2026-10-08 审查批次回归：（等待回座期间编辑配置/计时方式不清
 * awaitingActivity）、、（暂停落在倒计时最后一秒改走完成结算，不冻结 00:00）。
 */
describe("番茄钟状态机口径（2026-10-08）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 0));
    localStorage.clear();
    // 本组测试会改配置（调 focusMinutes），连配置一起重置防跨用例污染。
    useAppStore.setState({
      pomodoro: createInitialState(DEFAULT_CONFIG),
      pomodoroConfig: { ...DEFAULT_CONFIG },
      sessions: [],
      interruptions: []
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const startFocus = () => {
    const s = useAppStore.getState();
    s.selectPomodoroEvent(null, "测试专注");
    expect(s.togglePomodoro()).toBe(true);
  };

  it("F-6：awaitingActivity 期间编辑配置 / 切换计时方式不清等待标记", () => {
    useAppStore.setState((s) => ({ pomodoro: { ...s.pomodoro, awaitingActivity: true, isRunning: false } }));
    const s = useAppStore.getState();
    s.setPomodoroConfig({ ...s.pomodoroConfig, focusMinutes: 30 });
    expect(useAppStore.getState().pomodoroConfig.focusMinutes).toBe(30);
    expect(useAppStore.getState().pomodoro.awaitingActivity).toBe(true);

    useAppStore.getState().setPomodoroTimerMode("countup");
    expect(useAppStore.getState().pomodoro.timerMode).toBe("countup");
    expect(useAppStore.getState().pomodoro.awaitingActivity).toBe(true);
  });

  it("F-7：暂停中的专注段被阶段切换结算——<75% 记 partial，不再蒸发", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 10, 0));
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    const before = useAppStore.getState().sessions.length;

    useAppStore.getState().setPomodoroMode("shortBreak");
    const sessions = useAppStore.getState().sessions;
    expect(sessions.length).toBe(before + 1);
    expect(sessions.at(-1)?.completed).toBe(false); // 10/25 分钟 < 75%
    expect(sessions.at(-1)?.plannedSeconds).toBe(10 * 60);
    expect(useAppStore.getState().pomodoro.mode).toBe("shortBreak");
  });

  it("F-7：≥75% 的暂停段被计时方式切换结算——记完成并计轮", () => {
    startFocus();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 20, 0)); // 20/25 分钟 = 80%
    useAppStore.getState().tickPomodoro();
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    const roundsBefore = useAppStore.getState().pomodoro.completedFocusSessions;

    useAppStore.getState().setPomodoroTimerMode("countup");
    const sessions = useAppStore.getState().sessions;
    expect(sessions.at(-1)?.completed).toBe(true);
    expect(sessions.at(-1)?.plannedSeconds).toBe(20 * 60);
    expect(useAppStore.getState().pomodoro.completedFocusSessions).toBe(roundsBefore + 1);
  });

  it("A-1：暂停落在倒计时最后一秒 → 改走完成结算（不冻结 00:00）", () => {
    startFocus();
    // 墙钟推到 25 分钟整（remaining=0）但本拍心跳尚未结算——此刻点暂停。
    vi.setSystemTime(new Date(2026, 7, 18, 10, 25, 0));
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    const p = useAppStore.getState().pomodoro;
    // 默认 autoStartNext/autoCycle：完成结算后自动进入短休运行，而非冻结在
    // 00:00 的专注暂停态。
    expect(p.isRunning).toBe(true);
    expect(p.mode).toBe("shortBreak");
    const rec = useAppStore.getState().sessions.at(-1);
    expect(rec?.completed).toBe(true);
    expect(rec?.plannedSeconds).toBe(25 * 60);
  });
});

/**
 * 2026-10-09 回归：暂停超 2h 过期结算补发终态
 * 事件，自动化规则不再失联。
 */
describe("番茄钟过期结算补发终态（2026-10-09）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 10, 0, 0));
    localStorage.clear();
    useAppStore.setState({
      pomodoro: createInitialState(useAppStore.getState().pomodoroConfig),
      sessions: [],
      interruptions: []
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("FS-1：暂停中切换专注事件 → 在途段按中断口径结算（会话落库 + stop 事件），不再蒸发", () => {
    const s = useAppStore.getState();
    s.selectPomodoroEvent(null, "事件A");
    expect(s.togglePomodoro()).toBe(true);
    vi.setSystemTime(new Date(2026, 7, 18, 10, 20, 0));
    useAppStore.getState().togglePomodoro(); // 80% 处暂停
    const events: string[] = [];
    const un = onPomodoroEvent((name) => events.push(name));
    useAppStore.getState().selectPomodoroEvent(null, "事件B");
    un();
    const st = useAppStore.getState();
    const rec = st.sessions.at(-1);
    // 20 分钟 ≥75% → 完成口径结算 + 同款 stop 事件。
    expect(rec?.completed).toBe(true);
    expect(rec?.plannedSeconds).toBe(20 * 60);
    expect(rec?.eventLabel).toBe("事件A");
    expect(st.pomodoro.currentEventLabel).toBe("事件B");
    expect(events).toContain("stop");
  });

  it("FS-1 边界：无在途段时切换事件不结算（settle 守卫自然跳过）", () => {
    const s = useAppStore.getState();
    s.selectPomodoroEvent(null, "事件A"); // 未开始，无段
    const before = useAppStore.getState().sessions.length;
    useAppStore.getState().selectPomodoroEvent(null, "事件B");
    expect(useAppStore.getState().sessions.length).toBe(before);
  });

  it("FS-2：暂停超 2h 过期结算补发终态事件（此前会话有、事件无）", () => {
    const s = useAppStore.getState();
    s.selectPomodoroEvent(null, "测试专注");
    expect(s.togglePomodoro()).toBe(true);
    vi.setSystemTime(new Date(2026, 7, 18, 10, 20, 0));
    useAppStore.getState().togglePomodoro(); // 80% 处暂停
    const events: string[] = [];
    const un = onPomodoroEvent((name) => events.push(name));
    vi.setSystemTime(new Date(2026, 7, 18, 13, 0, 0));
    expect(useAppStore.getState().togglePomodoro()).toBe(true);
    un();
    // 过期段 20min ≥75% → stop（补发）；紧随的 fresh-start 另发 focus-start。
    expect(events).toContain("stop");
  });
});
