/**
 * 番茄钟面板：表盘（倒计时/正计时双模式）、阶段控制、专注事件选择、
 * 中断记录与每日目标进度；状态机为纯 reducer，tick 由全局心跳驱动。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Flag,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Square,
  X
} from "lucide-react";
import { Panel } from "../../components/ui/Panel";
import {
  cumulativeStats,
  cumulativeStatsFromAgg,
  splitSessionsByDay,
  todayInterruptions,
  virtualDayKey
} from "../../domain/analytics";
import { useFocusAggregate } from "../../lib/focus-aggregate";
import { animDurations } from "../../lib/durations";
import {
  INTERRUPTION_REASONS,
  countupGoalSeconds,
  type InterruptionReason,
  type PomodoroDialTheme
} from "../../domain/pomodoro";
import {
  AMBIENCE_KINDS,
  isAmbiencePlaying,
  loadAmbiencePrefs,
  saveAmbiencePrefs,
  setAmbiencePlaying,
  setAmbienceVolume,
  type AmbienceKind,
  type AmbiencePrefs
} from "../../lib/ambience";
import { getSegmentPlannedSeconds, hasFocusSegmentAnchor, useAppStore } from "../../store/app-store";
import { useSettingsStore } from "../../store/settings-store";
import { useWidgetConfig } from "../../widget/widget-config";
import { useT } from "../../i18n-lite";
import { pushAppToast } from "../../components/ToastHost";
import { useDelayedUnmount } from "../../lib/anim";
import { persistMirrored } from "../../lib/local-backup";
import { dayKeyOf, useNow } from "../../lib/use-now";
import { useTransientFlag } from "../../lib/use-transient-flag";
import { useSafeTimeout } from "../../lib/use-safe-timeout";

/** 简洁步进器：− [数字] 分 ＋，可点击、可输入、可回车。 */
function ConfigStepper({
  label,
  value,
  unit,
  min,
  max,
  onChange
}: {
  /** 可选：省略时不渲染标签行（嵌入组合控件时使用）。 */
  label?: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const tr = useT();
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isNaN(n) && text.trim() !== "") onChange(Math.max(min, Math.min(max, Math.round(n))));
    else setText(String(value));
  };
  return (
    <div className="pomodoro-config-field">
      {label && <span className="pomodoro-config-label">{label}</span>}
      <div className="pomodoro-stepper">
        {/* 输入框与按钮带 label 的可访问名称——面板里三组步进器此前
            是 3 个无名输入框 + 6 个无法区分的「减少/增加」。 */}
        <button
          className="pomodoro-stepper-btn"
          onClick={() => onChange(Math.max(min, value - 1))}
          aria-label={label ? `${label} ${tr("减少")}` : tr("减少")}
          type="button"
        >
          <Minus size={13} />
        </button>
        <div className="pomodoro-stepper-input-wrap">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commit();
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label={label}
            inputMode="numeric"
            autoComplete="off"
          />
          {unit && <span className="pomodoro-stepper-unit">{unit}</span>}
        </div>
        <button
          className="pomodoro-stepper-btn"
          onClick={() => onChange(Math.min(max, value + 1))}
          aria-label={label ? `${label} ${tr("增加")}` : tr("增加")}
          type="button"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

/** 专注表盘：柔和光晕 + 精细刻度 + 渐变进度弧 + 光点端点 + 今日轮次圆点，运行中轻呼吸。 */
function FocusDial({
  seconds,
  progress,
  running,
  targetMinutes,
  mode,
  timerMode,
  sessionCount,
  spinRing,
  dialTheme
}: {
  seconds: number;
  progress: number;
  running: boolean;
  targetMinutes: number;
  mode: "focus" | "shortBreak" | "longBreak";
  timerMode: "countdown" | "countup";
  sessionCount: number;
  spinRing: boolean;
  dialTheme: PomodoroDialTheme;
}) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const gradId = useId();
  const secs = Math.floor(seconds % 60);
  const mins = Math.floor((seconds % 3600) / 60);
  const hrs = Math.floor(seconds / 3600);
  const time =
    hrs > 0
      ? `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  const R = 84;
  const C = 2 * Math.PI * R;
  const clamped = Math.max(0, Math.min(1, progress));
  const tipAngle = (clamped * 360 - 90) * (Math.PI / 180);
  const ticks = useMemo(
    () =>
      Array.from({ length: 60 }, (_, i) => {
        const a = ((i * 6 - 90) * Math.PI) / 180;
        const major = i % 5 === 0;
        const r1 = major ? 96 : 98.5;
        return {
          x1: 100 + r1 * Math.cos(a),
          y1: 100 + r1 * Math.sin(a),
          x2: 100 + 100 * Math.cos(a),
          y2: 100 + 100 * Math.sin(a),
          major
        };
      }),
    []
  );
  const isBreak = mode !== "focus";
  const kicker = running
    ? isBreak
      ? tr("休息中")
      : tr("专注中")
    : clamped > 0 && clamped < 1 && seconds > 0
      ? tr("已暂停")
      : isBreak
        ? tr("休息待命")
        : tr("专注待命");
  const phaseLabel = timerMode === "countup" ? tr("正计时") : isBreak ? tr("休息") : tr("专注");
  // 今日专注轮次圆点：最多显示 8 个，超出显示 +N。
  const dots = Array.from({ length: Math.min(8, Math.max(0, sessionCount)) }, (_, i) => i);

  /* 完成庆祝：sessionCount +1 时挂 .celebrate 850ms —— 满环高亮脉冲 + 轻量粒子；
     #100 新 dot：同刻最后一个圆点 scale-in + 光环，+N 轻微跳动（em key 重建驱动）。 */
  const prevCount = useRef(sessionCount);
  const [celebrating, setCelebrating] = useState(false);
  const [freshDot, setFreshDot] = useState(false);
  useEffect(() => {
    if (sessionCount > prevCount.current) {
      prevCount.current = sessionCount;
      setCelebrating(true);
      setFreshDot(true);
      safeTimeout(() => setFreshDot(false), 480);
      safeTimeout(() => setCelebrating(false), 850);
    }
    prevCount.current = sessionCount;
  }, [sessionCount, safeTimeout]);

  /* 结束并记录：正计时秒数骤降归零时，时间数字做一次回卷收缩。 */
  const prevSecs = useRef(seconds);
  const [rewinding, setRewinding] = useState(false);
  useEffect(() => {
    if (timerMode === "countup" && !running && seconds === 0 && prevSecs.current > 5) {
      setRewinding(true);
      safeTimeout(() => setRewinding(false), 440);
      prevSecs.current = seconds;
    }
    prevSecs.current = seconds;
  }, [seconds, timerMode, running, safeTimeout]);

  return (
    <div
      className={`focus-timer${dialTheme !== "accent" ? ` dial-${dialTheme}` : ""}${running ? " running" : ""}${spinRing ? " spin-ticks" : ""}${celebrating ? " celebrate" : ""}`}
    >
      <svg viewBox="0 0 200 200" className="focus-timer-svg" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-2)" />
          </linearGradient>
          <radialGradient id={`${gradId}-glow`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${gradId}-disc`} cx="50%" cy="38%" r="60%">
            <stop offset="0%" stopColor="var(--paper-soft)" stopOpacity="0" />
            <stop offset="100%" stopColor="color-mix(in srgb, var(--accent) 6%, transparent)" />
          </radialGradient>
        </defs>
        <circle className="focus-timer-glow" cx="100" cy="100" r="96" fill={`url(#${gradId}-glow)`} />
        <circle className="focus-timer-disc" cx="100" cy="100" r="86" fill={`url(#${gradId}-disc)`} />
        <g className="focus-timer-ticks">
          {ticks.map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className={t.major ? "major" : ""} />
          ))}
        </g>
        <circle className="focus-timer-track" cx="100" cy="100" r={R} />
        <circle className="focus-timer-guide" cx="100" cy="100" r={R} />
        <circle
          className="focus-timer-progress"
          cx="100"
          cy="100"
          r={R}
          stroke={`url(#${gradId})`}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - clamped)}
          transform="rotate(-90 100 100)"
        />
        {clamped > 0.01 && (
          <circle
            className="focus-timer-tip"
            cx={100 + R * Math.cos(tipAngle)}
            cy={100 + R * Math.sin(tipAngle)}
            r="4.5"
          />
        )}
      </svg>
      {celebrating && (
        /* 轻量庆祝粒子：14 颗 accent 同色系圆点从表盘中心向外飞散，一次播完即卸载。
           （质感升级）：注入角度抖动 / 距离 / 自旋 / 时长的连续随机量——
           此前每次庆祝轨迹完全一致，观感机械。 */
        <span className="ft-confetti" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <i
              key={i}
              style={{
                ["--a" as string]: `${Math.round((i / 14) * 360 + (Math.random() * 24 - 12))}deg`,
                ["--cd" as string]: `${(0.55 + Math.random() * 0.35).toFixed(2)}s`,
                ["--fly" as string]: `${Math.round(86 + Math.random() * 42)}px`,
                ["--spin" as string]: `${Math.round(Math.random() * 520 - 260)}deg`
              }}
            />
          ))}
        </span>
      )}
      <div className="focus-timer-content">
        <span className="focus-timer-kicker">{kicker}</span>
        <strong key={timerMode} className={`focus-timer-time${rewinding ? " rewind" : ""}`}>
          {/* 逐位渲染（CountdownWidget cd-digit / ClockWidget clock-digit 同语言）：
              key 含字符值，仅变化的数位重挂载播 y 轴滑入，每秒不再整串硬跳。 */}
          {time.split("").map((ch, i) =>
            ch === ":" ? (
              <span key={`colon-${i}`}>:</span>
            ) : (
              <span key={`${i}-${ch}`} className="ft-digit">
                {ch}
              </span>
            )
          )}
        </strong>
        <span className="focus-timer-target">
          <b className={running && isBreak ? "phase-break" : ""}>{phaseLabel}</b>
          <span>{tr("目标 {n} 分钟", { n: targetMinutes })}</span>
        </span>
        {/* 轮次圆点全是空 <i>，信息补一份 aria-label（title 键盘/触屏不可达）。 */}
        <span
          className="focus-timer-sessions"
          title={tr("今日已专注 {n} 轮", { n: sessionCount })}
          aria-label={tr("今日已专注 {n} 轮", { n: sessionCount })}
        >
          {dots.map((i) => (
            <i key={i} className={`${i === 0 ? "first" : ""}${freshDot && i === dots.length - 1 ? " fresh" : ""}`} />
          ))}
          {sessionCount > 8 && (
            <em key={sessionCount} className="bump">
              +{sessionCount - 8}
            </em>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * 计时表盘：独立订阅每秒变化的 remainingSeconds，避免整面板每秒重渲染。
 * 其余（模式、时长、事件等）由父组件以稳定 props 传入。
 */
function TimerDial({
  planned,
  targetMinutes,
  mode,
  timerMode,
  sessionCount,
  spinRing,
  onToggle,
  fx,
  dialTheme
}: {
  planned: number;
  targetMinutes: number;
  mode: "focus" | "shortBreak" | "longBreak";
  timerMode: "countdown" | "countup";
  sessionCount: number;
  spinRing: boolean;
  onToggle: () => void;
  fx?: string;
  dialTheme: PomodoroDialTheme;
}) {
  const tr = useT();
  const seconds = useAppStore((s) => s.pomodoro.remainingSeconds);
  const isRunning = useAppStore((s) => s.pomodoro.isRunning);
  const totalSeconds = Math.max(0, seconds);
  const progress =
    timerMode === "countup"
      ? Math.min(1, totalSeconds / planned)
      : Math.max(0, Math.min(1, 1 - totalSeconds / planned));
  return (
    <div
      className={`focus-timer-wrap${fx ? ` ${fx}` : ""}`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-label={isRunning ? tr("暂停专注") : tr("开始专注")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <FocusDial
        seconds={totalSeconds}
        progress={progress}
        running={isRunning}
        targetMinutes={targetMinutes}
        mode={mode}
        timerMode={timerMode}
        sessionCount={sessionCount}
        spinRing={spinRing}
        dialTheme={dialTheme}
      />
    </div>
  );
}

export function PomodoroPanel({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const isRunning = useAppStore((s) => s.pomodoro.isRunning);
  const mode = useAppStore((s) => s.pomodoro.mode);
  const timerMode = useAppStore((s) => s.pomodoro.timerMode);
  const awaitingActivity = useAppStore((s) => s.pomodoro.awaitingActivity);
  const currentTaskId = useAppStore((s) => s.pomodoro.currentTaskId);
  const selectedEventLabel = useAppStore((s) => s.pomodoro.currentEventLabel);
  const hasCountupTime = useAppStore((s) => s.pomodoro.remainingSeconds > 0);
  const config = useAppStore((s) => s.pomodoroConfig);
  const { config: wcfg } = useWidgetConfig(instanceId);
  const spinRing = !!wcfg.spinRing;
  const tasks = useAppStore((s) => s.tasks);
  const sessions = useAppStore((s) => s.sessions);
  const interruptions = useAppStore((s) => s.interruptions);
  const analyticsStartDate = useSettingsStore((s) => s.extra.analyticsStartDate);
  const toggle = useAppStore((s) => s.togglePomodoro);
  const reset = useAppStore((s) => s.resetPomodoro);
  const setMode = useAppStore((s) => s.setPomodoroMode);
  const setTimerMode = useAppStore((s) => s.setPomodoroTimerMode);
  const selectEvent = useAppStore((s) => s.selectPomodoroEvent);
  const setConfig = useAppStore((s) => s.setPomodoroConfig);
  const interruptPomodoro = useAppStore((s) => s.interruptPomodoro);
  const stopCountupFocus = useAppStore((s) => s.stopCountupFocus);
  const adjust = useAppStore((s) => s.adjustPomodoro);
  const [showInterrupt, setShowInterrupt] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [customEvent, setCustomEvent] = useState("");
  const [customEvents, setCustomEvents] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("focus-desk.custom-events.v1");
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
    } catch {
      return [];
    }
  });
  const [focusDraft, setFocusDraft] = useState(config.focusMinutes);
  /* 环境音（#8 的载体）：面板内提供场景/音量/开关；媒体在播时 ambience.ts
     的守卫会淡出实际发声（播放意图保留在 ambiencePlaying，恢复后自动淡入）。 */
  const [ambiencePrefs, setAmbiencePrefs] = useState<AmbiencePrefs>(() => loadAmbiencePrefs());
  const [ambiencePlaying, setAmbiencePlayingState] = useState(() => isAmbiencePlaying());
  const toggleAmbience = () => {
    const next = !ambiencePlaying;
    setAmbiencePlaying(ambiencePrefs.kind, ambiencePrefs.volume, next);
    setAmbiencePlayingState(next);
  };
  const pickAmbience = (kind: AmbienceKind) => {
    const next = { ...ambiencePrefs, kind };
    setAmbiencePrefs(next);
    saveAmbiencePrefs(next);
    if (ambiencePlaying) setAmbiencePlaying(kind, next.volume, true);
  };
  const changeAmbienceVolume = (volume: number) => {
    const next = { ...ambiencePrefs, volume };
    setAmbiencePrefs(next);
    saveAmbiencePrefs(next);
    setAmbienceVolume(volume);
  };
  /* 每日目标：轮数 / 时长两种口径各自记忆，切换方式不丢已设值。 */
  const [goalModeDraft, setGoalModeDraft] = useState<"sessions" | "minutes">(config.dailyGoalMode ?? "sessions");
  const [goalDraft, setGoalDraft] = useState(config.dailyGoalSessions ?? 8);
  const [goalMinutesDraft, setGoalMinutesDraft] = useState(config.dailyGoalMinutes ?? 120);
  const [countupGoalDraft, setCountupGoalDraft] = useState(config.countupGoalMinutes ?? 0);
  const [showNoEventWarning, setShowNoEventWarning] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  /* 事件下拉对称退场（入场有错落，收起此前瞬关）。 */
  const eventVisible = useDelayedUnmount(eventOpen && !isRunning, animDurations().fxFastMs);
  const eventClosing = !eventOpen && eventVisible;
  const [eventQuery, setEventQuery] = useState("");

  /* 启动脉冲：isRunning 变 true 的一刻，表盘整体亮度脉冲一次 */
  const startedPulse = useTransientFlag(isRunning, 620, "rise");

  /* 阶段换色：mode 变化时表盘播一次满环扩散光波（颜色过渡由 CSS 承担） */
  const phaseWave = useTransientFlag(mode, 720);

  /* 结束并记录：点击时刻表盘绿色确认脉冲 + 停止按钮缩放退场 */
  const [stopPulse, setStopPulse] = useState(false);
  const [stopExiting, setStopExiting] = useState(false);
  const handleStopCountup = () => {
    setStopPulse(true);
    setStopExiting(true);
    stopCountupFocus();
    safeTimeout(() => setStopPulse(false), 640);
    safeTimeout(() => setStopExiting(false), 260);
  };
  const timerFx = [startedPulse && "just-started", phaseWave && "phase-wave", stopPulse && "recorded"]
    .filter(Boolean)
    .join(" ");

  /* （草稿被无关操作冲掉）：依赖收敛到草稿真正映射的字段——此前依赖整个
   * config 对象，勾「自动下一轮」/ 切目标方式（都产生新 config 引用）会把
   * 弹层里未提交的草稿静默重置回已存值。 */
  useEffect(() => {
    setFocusDraft(config.focusMinutes);
    setGoalModeDraft(config.dailyGoalMode ?? "sessions");
    setGoalDraft(config.dailyGoalSessions ?? 8);
    setGoalMinutesDraft(config.dailyGoalMinutes ?? 120);
    setCountupGoalDraft(config.countupGoalMinutes ?? 0);
  }, [
    config.focusMinutes,
    config.dailyGoalMode,
    config.dailyGoalSessions,
    config.dailyGoalMinutes,
    config.countupGoalMinutes
  ]);

  // 虚拟午夜口径（0/2/4），与 SQL 聚合共用同一设置值。
  const vmHour = useSettingsStore((s) => s.extra.virtualMidnightHour ?? 0);

  const nowTick = useNow();
  // 统计的「今天」以当前墙钟所属的虚拟日为准。
  // 此前拿 dayKeyToDate(todayKey)=当天零点当 now——vmHour>0 时零点属于昨天
  // 的虚拟日，isSameVirtualDay 把「今日」整体错位成昨天（今天上午的段全部
  // 漏计、昨天 04:00 后的段反而计入）。依赖同样换成虚拟日键：自然日键在
  // 00:00 翻转而虚拟日在 04:00 翻转，否则跨虚拟午夜不会触发重算。
  const todayKey = vmHour > 0 ? virtualDayKey(nowTick, vmHour) : dayKeyOf(nowTick);

  // 累计统计走 SQLite 全量按日聚合（与 AnalyticsPanel 同口径）：内存 sessions
  // 有 SESSIONS_CAP=500 截断，长期用户的「累计专注/天数」会被截掉；聚合加载
  // 失败（浏览器模式/首次未就绪）回退内存口径。（竞态+去重）：改用与统计
  // 面板共享的钩子——写落地信号（dbVersion）补读、双面板单次 IPC、失败回退
  // 新鲜内存而非旧 SQL 快照。
  const focusAgg = useFocusAggregate(vmHour);
  // 内存口径统一先按虚拟午夜切分（#12），与 SQL 聚合归日结果一致。
  const memSessions = useMemo(() => splitSessionsByDay(sessions, vmHour), [sessions, vmHour]);

  const stats = useMemo(() => {
    // now 用真实墙钟（不再是零点代理）——同虚拟日比较在每个时刻都正确，
    // 跨虚拟午夜由 todayKey 依赖变化触发重算。
    const now = new Date();
    // 归日锚点从 endedAt 改为 startedAt 的虚拟日键——
    // 与统计面板 / Rust 聚合「按段起始虚拟日归组」的统一规则一致。此前
    // 两面板一个按结束、一个按起始，跨午夜段在两处算出不同的「今日时长」。
    // 分钟=今日实际净专注时长（含未完成段）；轮数（todayFocusCount）保持
    // 的仅完成口径——「时长」衡量真实投入，「轮数」衡量完整段。
    const todayKey = virtualDayKey(now, vmHour);
    const todayFocus = memSessions.filter((s) => {
      if (s.type !== "focus") return false;
      const started = new Date(s.startedAt);
      return !Number.isNaN(started.getTime()) && virtualDayKey(started, vmHour) === todayKey;
    });
    const cum = focusAgg
      ? cumulativeStatsFromAgg(focusAgg, now, analyticsStartDate)
      : cumulativeStats(memSessions, now, analyticsStartDate, vmHour);
    const todayInterrupt = todayInterruptions(interruptions, now, vmHour);
    const todayFocusCount = todayFocus.filter((s) => s.completed).length;
    const todayFocusMinutes = todayFocus.reduce((acc, s) => acc + s.plannedSeconds, 0) / 60;
    return { cum, todayInterrupt, todayFocusCount, todayFocusMinutes };
    // todayKey 是跨虚拟午夜的重算触发器（useMemo 内的 new Date() 不直接引用它）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memSessions, interruptions, analyticsStartDate, todayKey, focusAgg, vmHour]);

  // 游戏时暂停由 App 层的 GlobalGamePause 统一处理，保证小组件隐藏时
  // 计时器仍会随全屏游戏自动暂停（此处不再重复挂载，避免双重切换）。

  const currentEventLabel = useMemo(() => {
    if (currentTaskId) {
      const task = tasks.find((t) => t.id === currentTaskId);
      if (task) return task.title;
    }
    if (selectedEventLabel) return selectedEventLabel;
    return null;
  }, [currentTaskId, selectedEventLabel, tasks]);

  /* 目标达成时刻：reached 从 false 翻 true 的一瞬，目标行整体 celebrate 一次 */
  /* 每日目标：轮数 / 时长双口径，进度与达成判定跟随当前口径。 */
  const activeGoalMode = config.dailyGoalMode ?? "sessions";
  const goalSessions = config.dailyGoalSessions ?? 0;
  const goalMinutes = config.dailyGoalMinutes ?? 0;
  const goalTarget = activeGoalMode === "minutes" ? goalMinutes : goalSessions;
  const goalDone = activeGoalMode === "minutes" ? Math.round(stats.todayFocusMinutes) : stats.todayFocusCount;
  const goalUnitLabel = activeGoalMode === "minutes" ? tr("分") : tr("轮");
  const goalReached = goalTarget > 0 && goalDone >= goalTarget;
  /* 目标达成时刻：reached 从 false 翻 true 的一瞬，目标行整体 celebrate 一次 */
  const goalHit = useTransientFlag(goalReached, 950, "rise");

  /* 中断弹层退场：关闭/选中后保留 150ms 播缩放淡出；选中原因先高亮再收起 */
  /* （暂停态中断）：store 的 interruptPomodoro 已支持暂停中的段；这里提供
   * 对应的显示条件。布尔 selector 输出稳定（运行中恒 false、暂停中恒 true），
   * 不会随每秒 tick 重渲整面板。启发式：倒计时剩余 < 满额即视为「暂停在有
   * 进度的段」（全新段 remaining === planned，不显示）。 */
  const pausedMidFocus = useAppStore((s) => {
    if (
      s.pomodoro.mode !== "focus" ||
      s.pomodoro.timerMode !== "countdown" ||
      s.pomodoro.isRunning ||
      s.pomodoro.remainingSeconds <= 0
    ) {
      return false;
    }
    // 用**段首计划**（±加时）口径判定「暂停在有进度的段」——此前与
    // 当前配置 focusMinutes 比较，暂停期间热更配置（如调小时长）会让按钮
    // 凭空消失/误现。段首计划在暂停瞬间与冻结剩余一同定格，比较稳定。
    // planned==null 只兼容「暂停段但锚点缺失」的旧快照，无段空闲态
    // 同样返回 null——必须先确认锚点在位，否则空闲态误显死按钮。
    const planned = getSegmentPlannedSeconds();
    return hasFocusSegmentAnchor() && (planned == null || s.pomodoro.remainingSeconds < planned);
  });
  // store 的 interruptPomodoro 只接受 focus 段——休息运行中此前按钮
  // 照常可点但 store no-op（计时继续、无记录、无提示）。
  const canInterrupt = mode === "focus" && (isRunning || pausedMidFocus) && timerMode === "countdown";
  const interruptOpen = showInterrupt && (isRunning || pausedMidFocus);
  const interruptVisible = useDelayedUnmount(interruptOpen, animDurations().fxFastMs);
  const interruptClosing = !interruptOpen && interruptVisible;
  const [pickedReason, setPickedReason] = useState<InterruptionReason | null>(null);
  const pickReason = (reason: InterruptionReason) => {
    if (pickedReason) return;
    setPickedReason(reason);
    safeTimeout(() => {
      interruptPomodoro(reason);
      setShowInterrupt(false);
      setPickedReason(null);
    }, 180);
  };

  const hasEventSelected = currentEventLabel !== null;

  const handleToggle = () => {
    if (!toggle()) {
      setShowNoEventWarning(true);
      safeTimeout(() => setShowNoEventWarning(false), 2500);
    }
  };

  const selectById = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (task) selectEvent(id, null);
    else selectEvent(null, id); // custom event id
  };

  const addCustomEvent = () => {
    const trimmed = customEvent.trim();
    if (!trimmed) return;
    const updated = customEvents.includes(trimmed) ? customEvents : [...customEvents, trimmed];
    setCustomEvents(updated);
    persistMirrored("focus-desk.custom-events.v1", JSON.stringify(updated));
    selectEvent(null, trimmed);
    setCustomEvent("");
  };

  const removeCustomEvent = (ev: string) => {
    const updated = customEvents.filter((e) => e !== ev);
    setCustomEvents(updated);
    persistMirrored("focus-desk.custom-events.v1", JSON.stringify(updated));
    if (selectedEventLabel === ev) selectEvent(null, null);
  };

  // 进度环分母按当前阶段取时长（此前恒为专注时长——25+5 配置下短休
  // 开始瞬间环就显示 ~80%）。与 PomodoroMini 的 plannedSecondsFor 同口径；
  // 正计时（countup）的分母统一为 目标分钟（0 = 跟随专注时长）——
  // 此前主面板用 focusMinutes、迷你环用恒为 0 的 countupGoalMinutes，
  // 同一计时器两处呈现语义不同（迷你环永不填充）。
  const planned = Math.max(
    1,
    mode === "shortBreak"
      ? config.shortBreakMinutes * 60
      : mode === "longBreak"
        ? config.longBreakMinutes * 60
        : timerMode === "countup"
          ? countupGoalSeconds(config)
          : config.focusMinutes * 60
  );
  // 当前阶段的目标时长（分钟）：休息阶段显示对应休息时长；正计时显示
  // 正计时目标（0 = 跟随专注时长），而非固定专注时长。
  const targetMinutes =
    mode === "shortBreak"
      ? config.shortBreakMinutes
      : mode === "longBreak"
        ? config.longBreakMinutes
        : timerMode === "countup"
          ? Math.round(countupGoalSeconds(config) / 60)
          : config.focusMinutes;

  const applyConfig = () => {
    // 运行中应用配置**不会**重置当前段（app-store.setPomodoroConfig：只更新配置
    // 字段，新时长下一段生效）。此前弹"应用配置会重置当前计时"的确认框与实际
    // 行为相反，把用户吓退；改为如实提示。
    setConfig({
      ...config,
      focusMinutes: focusDraft,
      dailyGoalMode: goalModeDraft,
      dailyGoalSessions: goalDraft,
      dailyGoalMinutes: goalMinutesDraft,
      countupGoalMinutes: countupGoalDraft
    });
    setShowConfig(false);
    if (isRunning) {
      pushAppToast(tr("配置已保存"), tr("当前计时不受影响，新时长将在下一段开始时生效"), "ok");
    }
  };

  // 事件池：今日待办 + 自定义事件，统一为一组简洁的圆角标签。
  const selectableEvents = useMemo<{ key: string; label: string; kind: "task" | "custom" }[]>(
    () => [
      ...tasks.map((t) => ({ key: t.id, label: t.completed ? `✓ ${t.title}` : t.title, kind: "task" as const })),
      ...customEvents.map((ev) => ({ key: ev, label: ev, kind: "custom" as const }))
    ],
    [tasks, customEvents]
  );

  const phases = [
    ["focus", tr("专注")],
    ["shortBreak", tr("短休")],
    ["longBreak", tr("长休")]
  ] as const;
  const phaseIndex = Math.max(
    0,
    phases.findIndex(([m]) => m === mode)
  );

  return (
    <Panel
      title={tr("番茄钟")}
      kicker="FOCUS"
      className={`pomodoro-panel${isRunning ? " immersed" : ""}`}
      dataBreak={mode !== "focus"}
      action={
        <button
          type="button"
          className="session-count"
          onClick={() => setShowConfig((v) => !v)}
          aria-expanded={showConfig}
        >
          <Settings size={12} /> {tr("本日 {n} 轮", { n: stats.todayFocusCount })}
        </button>
      }
    >
      {/* 控制栈：阶段分段控件（滑动指示块）+ 计时方式迷你切换，一行收纳 */}
      <div className="pomodoro-control-bar">
        <div className="pomodoro-seg" role="group" aria-label={tr("阶段")}>
          <span
            className="pomodoro-seg-thumb"
            style={{ transform: `translateX(${phaseIndex * 100}%)` }}
            aria-hidden="true"
          />
          {phases.map(([m, label]) => (
            <button
              key={m}
              type="button"
              className={`pomodoro-seg-btn${mode === m ? " active" : ""}`}
              onClick={() => setMode(m)}
              disabled={isRunning || timerMode === "countup"}
              aria-pressed={mode === m}
              title={isRunning ? tr("计时中无法切换") : timerMode === "countup" ? tr("正计时模式下仅支持专注") : label}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="pomodoro-mode-mini" role="group" aria-label={tr("计时方式")}>
          <button
            type="button"
            className={timerMode === "countdown" ? "active" : ""}
            onClick={() => setTimerMode("countdown")}
            disabled={isRunning}
            aria-pressed={timerMode === "countdown"}
            title={isRunning ? tr("计时中无法切换") : tr("倒计时")}
          >
            {tr("倒计时")}
          </button>
          <button
            type="button"
            className={timerMode === "countup" ? "active" : ""}
            onClick={() => setTimerMode("countup")}
            disabled={isRunning}
            aria-pressed={timerMode === "countup"}
            title={isRunning ? tr("计时中无法切换") : tr("正计时")}
          >
            {tr("正计时")}
          </button>
        </div>
      </div>

      {/* 事件区：空闲时是选择器（含下拉），运行中收敛为只读徽标 */}
      {!isRunning ? (
        <>
          {showNoEventWarning && (
            <div className="pomodoro-no-event-warning" role="alert">
              {tr("请先选择或创建一个专注事件再开始")}
            </div>
          )}
          <div className="pomodoro-event-select">
            <button
              className={`pomodoro-event-select-btn${hasEventSelected ? " has" : ""}`}
              onClick={() => setEventOpen((v) => !v)}
              title={tr("选择专注事件")}
              type="button"
              aria-expanded={eventOpen}
              aria-haspopup="listbox"
            >
              <span className="pomodoro-event-select-dot" />
              <span className="pomodoro-event-select-label">{currentEventLabel || tr("选择专注事件")}</span>
              {!hasEventSelected && <span className="required-mark">{tr("必选")}</span>}
              <ChevronDown size={13} className={`pomodoro-event-select-caret${eventOpen ? " open" : ""}`} />
            </button>

            {eventVisible && (
              <div className={`pomodoro-event-dropdown${eventClosing ? " is-closing" : ""}`}>
                <div className="pomodoro-event-search">
                  <Search size={12} />
                  <input
                    value={eventQuery}
                    onChange={(e) => setEventQuery(e.target.value)}
                    placeholder={tr("搜索或新建事件…")}
                    aria-label={tr("搜索或新建事件…")}
                    autoFocus
                    data-interactive
                  />
                </div>

                {/* 方向键在选项间移动焦点（listbox 键盘模式）：渲染
                    上限 60 行 + 「还有 N 项」提示，任务数百条时不再全量建 DOM。 */}
                <div
                  className="pomodoro-event-list"
                  role="listbox"
                  aria-label={tr("选择专注事件")}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                    e.preventDefault();
                    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
                    if (items.length === 0) return;
                    const idx = items.indexOf(document.activeElement as HTMLElement);
                    const next =
                      e.key === "ArrowDown"
                        ? items[(idx + 1 + items.length) % items.length]
                        : items[(idx - 1 + items.length) % items.length];
                    next?.focus();
                  }}
                >
                  {(() => {
                    const EVENT_LIST_CAP = 60;
                    const filtered = selectableEvents.filter((ev) =>
                      ev.label.toLowerCase().includes(eventQuery.trim().toLowerCase())
                    );
                    const hidden = Math.max(0, filtered.length - EVENT_LIST_CAP);
                    const isActiveEv = (ev: { kind: string; key: string }) =>
                      ev.kind === "task" ? currentTaskId === ev.key : selectedEventLabel === ev.key;
                    /* （残留）：roving tabindex——仅当前项（无当前项时首项）
                       进 Tab 序，其余 -1；键盘用户经一个停靠点进入后全程方向键。 */
                    const anyActive = filtered.slice(0, EVENT_LIST_CAP).some(isActiveEv);
                    return (
                      <>
                        {filtered.slice(0, EVENT_LIST_CAP).map((ev, i) => {
                          const active = isActiveEv(ev);
                          const pick = () => {
                            selectById(ev.key);
                            setEventOpen(false);
                            setEventQuery("");
                          };
                          return (
                            <div
                              key={`${ev.kind}-${ev.key}`}
                              role="option"
                              aria-selected={active}
                              tabIndex={active || (!anyActive && i === 0) ? 0 : -1}
                              className={`pomodoro-event-item${active ? " active" : ""}`}
                              onClick={pick}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  pick();
                                }
                              }}
                            >
                              <span className="pomodoro-event-item-check">{active && <Check size={11} />}</span>
                              <span className="pomodoro-event-item-label">{ev.label}</span>
                              {ev.kind === "custom" && (
                                /* 真实按钮：与选项本体平级（button 内不能再嵌 button），
                                   键盘可达，删除不再依赖 role=button 假按钮。 */
                                <button
                                  type="button"
                                  className="pomodoro-chip-x"
                                  aria-label={tr("删除该事件")}
                                  title={tr("删除该事件")}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeCustomEvent(ev.key);
                                  }}
                                >
                                  <X size={10} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                        {hidden > 0 && (
                          <div className="pomodoro-event-empty">{tr("还有 {n} 项未显示", { n: hidden })}</div>
                        )}
                      </>
                    );
                  })()}
                  {selectableEvents.length === 0 && (
                    <div className="pomodoro-event-empty">{tr("还没有事件，在下方新建一个吧。")}</div>
                  )}
                </div>

                <div className="pomodoro-event-add">
                  <Plus size={12} />
                  <input
                    value={customEvent}
                    onChange={(e) => setCustomEvent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        addCustomEvent();
                        setEventOpen(false);
                      }
                    }}
                    placeholder={tr("添加自定义事件，回车确认")}
                    data-interactive
                  />
                  <button
                    onClick={() => {
                      addCustomEvent();
                      setEventOpen(false);
                    }}
                    disabled={!customEvent.trim()}
                    title={tr("添加")}
                    aria-label={tr("添加")}
                    data-interactive
                  >
                    <Check size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        currentEventLabel && (
          <div className="current-task current-task-badge">
            <span className="current-task-dot" />
            <strong>{currentEventLabel}</strong>
          </div>
        )
      )}

      {/* 专注计时环（点击表盘也可开始/暂停） */}
      {awaitingActivity && !isRunning && (
        <div className="pomodoro-await-hint" role="status">
          {tr("休息结束——检测到你回到座位后自动开始")}
        </div>
      )}
      <TimerDial
        planned={planned}
        targetMinutes={targetMinutes}
        mode={mode}
        timerMode={timerMode}
        sessionCount={stats.todayFocusCount}
        spinRing={spinRing}
        onToggle={handleToggle}
        fx={timerFx}
        dialTheme={config.dialTheme}
      />

      {/* 操作 */}
      <div className="timer-actions">
        <button className="icon-button" onClick={reset} aria-label={tr("重置")} title={tr("重置")}>
          <RotateCcw size={16} />
        </button>
        {/* （extend/rewind）：运行中 ±5 分钟（倒计时剩余保底 10s） */}
        {isRunning && (
          <>
            <button
              className="icon-button"
              onClick={() => adjust(-300)}
              aria-label={tr("回拨 5 分钟")}
              title={tr("回拨 5 分钟")}
            >
              <Minus size={16} />
            </button>
            <button
              className="icon-button"
              onClick={() => adjust(300)}
              aria-label={tr("加时 5 分钟")}
              title={tr("加时 5 分钟")}
            >
              <Plus size={16} />
            </button>
          </>
        )}
        <button className="primary-button" onClick={handleToggle}>
          {/* 图标旋转交叉淡切：key 切换触发重建动画 */}
          <span key={isRunning ? "pause" : "play"} className="pb-ico">
            {isRunning ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}
          </span>
          {isRunning ? tr("暂停") : tr("开始专注")}
        </button>
        {timerMode === "countup" && (isRunning || hasCountupTime || stopExiting) && (
          <button
            className={`icon-button${stopExiting ? " stop-exiting" : ""}`}
            onClick={handleStopCountup}
            aria-label={tr("结束并记录")}
            title={tr("结束本次专注并记录")}
          >
            <Square size={16} />
          </button>
        )}
        {canInterrupt && (
          <button
            className={`icon-button${showInterrupt ? " active" : ""}`}
            onClick={() => setShowInterrupt((v) => !v)}
            aria-label={tr("记录中断")}
            title={isRunning ? tr("记录中断原因") : tr("放弃本次专注并记录原因")}
          >
            <Flag size={16} />
          </button>
        )}
      </div>

      {/* 中断原因 */}
      {interruptVisible && (
        <div className={`interrupt-popover${interruptClosing ? " is-closing" : ""}`}>
          <div className="interrupt-popover-title">{tr("这次为什么中断？")}</div>
          <div className="interrupt-options">
            {INTERRUPTION_REASONS.map((r) => (
              <button
                key={r}
                className={`interrupt-option${pickedReason === r ? " picked" : ""}`}
                onClick={() => pickReason(r)}
              >
                {tr(r)}
              </button>
            ))}
          </div>
          <button className="interrupt-dismiss" onClick={() => setShowInterrupt(false)}>
            <X size={12} />
            {tr("取消")}
          </button>
        </div>
      )}

      {/* 配置（可折叠，折叠时仅保留细标题行） */}
      <div className={`pomodoro-config ${showConfig ? "open" : ""}`}>
        <div
          className="pomodoro-config-title"
          role="button"
          tabIndex={0}
          onClick={() => setShowConfig((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setShowConfig((v) => !v);
            }
          }}
        >
          <Settings size={12} />
          <span>{tr("配置")}</span>
          <ChevronDown size={12} className={`pomodoro-config-caret${showConfig ? " open" : ""}`} />
          <span className="pomodoro-config-toggle">{showConfig ? tr("收起") : tr("展开")}</span>
        </div>
        {/* 折叠改常驻挂载 + grid-rows 0fr→1fr（同 范式）：caret 已暗示
            会动，内容硬切是期望违背；inert 保证收起后不可聚焦、对 AT 隐藏。 */}
        <div className={`pomodoro-config-wrap${showConfig ? " open" : ""}`} inert={!showConfig}>
          <div className="pomodoro-config-clip">
            <div className="pomodoro-config-body">
              <ConfigStepper
                label={tr("专注时长")}
                value={focusDraft}
                unit={tr("分")}
                min={1}
                max={180}
                onChange={(v) => setFocusDraft(v)}
              />
              <div className="pomodoro-config-field">
                <span className="pomodoro-config-label">{tr("每日目标")}</span>
                <div className="pomodoro-goal-edit">
                  <div className="pomodoro-mode-mini" role="group" aria-label={tr("目标方式")}>
                    <button
                      type="button"
                      className={goalModeDraft === "sessions" ? "active" : ""}
                      onClick={() => setGoalModeDraft("sessions")}
                      aria-pressed={goalModeDraft === "sessions"}
                    >
                      {tr("轮数")}
                    </button>
                    <button
                      type="button"
                      className={goalModeDraft === "minutes" ? "active" : ""}
                      onClick={() => setGoalModeDraft("minutes")}
                      aria-pressed={goalModeDraft === "minutes"}
                    >
                      {tr("时长")}
                    </button>
                  </div>
                  {goalModeDraft === "sessions" ? (
                    <ConfigStepper
                      label={tr("每日目标")}
                      value={goalDraft}
                      unit={tr("轮")}
                      min={0}
                      max={24}
                      onChange={(v) => setGoalDraft(v)}
                    />
                  ) : (
                    <ConfigStepper
                      label={tr("每日目标")}
                      value={goalMinutesDraft}
                      unit={tr("分")}
                      min={0}
                      max={1440}
                      onChange={(v) => setGoalMinutesDraft(v)}
                    />
                  )}
                </div>
              </div>
              <p className="pomodoro-config-hint">
                {goalModeDraft === "sessions"
                  ? goalDraft > 0
                    ? tr("目标进度会显示在统计区，0 为不设目标")
                    : tr("设为 0 表示不设目标、隐藏进度条")
                  : goalMinutesDraft > 0
                    ? tr("按今日专注时长计，0 为不设目标")
                    : tr("设为 0 表示不设目标、隐藏进度条")}
              </p>
              {/* （救活）：正计时目标此前只有草稿状态、没有任何输入控件，
                  countupGoalMinutes 永远停留在默认值 0（=跟随专注时长），设置形同虚设。 */}
              <ConfigStepper
                label={tr("正计时目标")}
                value={countupGoalDraft}
                unit={tr("分")}
                min={0}
                max={240}
                onChange={(v) => setCountupGoalDraft(v)}
              />
              <p className="pomodoro-config-hint">
                {countupGoalDraft > 0
                  ? tr("正计时每达到该分钟数的整数倍提醒一次")
                  : tr("正计时目标设为 0 表示跟随专注时长")}
              </p>
              <div className="pomodoro-config-actions">
                <label className="pomodoro-config-toggle-inline" title={tr("倒计时结束后自动开始下一轮专注")}>
                  <span>{tr("自动下一轮")}</span>
                  <input
                    type="checkbox"
                    checked={config.autoStartNext !== false}
                    onChange={(e) => setConfig({ ...config, autoStartNext: e.target.checked })}
                  />
                </label>
                <button className="pomodoro-config-apply" onClick={applyConfig}>
                  {tr("应用")}
                </button>
              </div>
              {/* 专注环境音（媒体在播时自动让位，见 ambience.ts） */}
              <div className="pomodoro-config-field">
                <span className="pomodoro-config-label">{tr("环境音")}</span>
                <div className="pomodoro-ambience" role="group" aria-label={tr("环境音")}>
                  {AMBIENCE_KINDS.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      className={`pomodoro-ambience-chip${ambiencePrefs.kind === k.id ? " active" : ""}`}
                      onClick={() => pickAmbience(k.id)}
                    >
                      {tr(k.label)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`pomodoro-ambience-play${ambiencePlaying ? " on" : ""}`}
                    onClick={toggleAmbience}
                    title={ambiencePlaying ? tr("停止环境音") : tr("播放环境音")}
                    aria-label={ambiencePlaying ? tr("停止环境音") : tr("播放环境音")}
                  >
                    {ambiencePlaying ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
                  </button>
                </div>
                <input
                  className="pomodoro-ambience-volume"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(ambiencePrefs.volume * 100)}
                  onChange={(e) => changeAmbienceVolume(Number(e.target.value) / 100)}
                  aria-label={tr("环境音音量")}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 每日目标进度：轮数 / 时长可就地切换（正计时党直接切到时长口径） */}
      {(goalSessions > 0 || goalMinutes > 0) &&
        (() => {
          const goal = goalTarget;
          const done = goalDone;
          const pct = goal > 0 ? Math.min(100, Math.round((done / goal) * 100)) : 0;
          return (
            <div
              className={`pomodoro-goal${goalReached ? " reached" : ""}${goalHit ? " just-reached" : ""}`}
              title={goal > 0 ? `${done} / ${goal} ${goalUnitLabel}` : tr("未设目标")}
            >
              <div className="pomodoro-goal-head">
                <span className="pomodoro-goal-label">
                  {goalReached ? <Check size={11} /> : <Flag size={11} />}
                  {goalReached ? tr("今日目标已达成") : tr("今日目标")}
                </span>
                <div className="pomodoro-goal-switch" role="group" aria-label={tr("目标方式")}>
                  <button
                    type="button"
                    className={activeGoalMode === "sessions" ? "on" : ""}
                    onClick={() => setConfig({ ...config, dailyGoalMode: "sessions" })}
                    title={tr("按专注轮数计")}
                    aria-pressed={activeGoalMode === "sessions"}
                  >
                    {tr("轮数")}
                  </button>
                  <button
                    type="button"
                    className={activeGoalMode === "minutes" ? "on" : ""}
                    onClick={() => setConfig({ ...config, dailyGoalMode: "minutes" })}
                    title={tr("按专注时长计")}
                    aria-pressed={activeGoalMode === "minutes"}
                  >
                    {tr("时长")}
                  </button>
                </div>
                {goal > 0 ? (
                  <span className="pomodoro-goal-count">
                    {done}
                    <em>/</em>
                    {goal}
                    {goalUnitLabel}
                  </span>
                ) : (
                  <span className="pomodoro-goal-count">{tr("未设目标")}</span>
                )}
              </div>
              {goal > 0 && (
                <div
                  className="pomodoro-goal-track"
                  role="progressbar"
                  aria-valuenow={done}
                  aria-valuemin={0}
                  aria-valuemax={goal}
                  aria-label={tr("今日专注目标进度")}
                >
                  <div className="pomodoro-goal-fill" style={{ ["--p" as string]: pct / 100 }} />
                </div>
              )}
            </div>
          );
        })()}

      {/* 统计（#109：key 强制重建触发数值滚动入场） */}
      <div className="pomodoro-stats">
        <div className="pomodoro-stat">
          <span className="pomodoro-stat-label">{tr("今日专注")}</span>
          <strong className="rb-num" key={`c${stats.todayFocusCount}`}>
            {stats.todayFocusCount}
            <em>{tr("轮")}</em>
          </strong>
        </div>
        <div className="pomodoro-stat">
          <span className="pomodoro-stat-label">{tr("今日时长")}</span>
          <strong className="rb-num" key={`m${Math.round(stats.todayFocusMinutes)}`}>
            {fmtDuration(Math.round(stats.todayFocusMinutes), tr)}
          </strong>
        </div>
        <div className="pomodoro-stat">
          <span className="pomodoro-stat-label">{tr("中断")}</span>
          <strong className="rb-num" key={`i${stats.todayInterrupt}`}>
            {stats.todayInterrupt}
            <em>{tr("次")}</em>
          </strong>
        </div>
        <div className="pomodoro-stat">
          <span className="pomodoro-stat-label">{tr("累计时长")}</span>
          <strong className="rb-num" key={`t${Math.round(stats.cum.totalFocusMinutes)}`}>
            {fmtDuration(stats.cum.totalFocusMinutes, tr)}
          </strong>
        </div>
      </div>
    </Panel>
  );
}

function fmtDuration(minutes: number, tr: (s: string) => string): string {
  // 先取整再分支：59.5-59.9 分直接 round 会得「60分」而不是进位「1小时」。
  const r = Math.round(minutes);
  if (r < 60) return `${r}${tr("分")}`;
  const h = Math.floor(r / 60);
  const m = r % 60;
  // 与 Analytics fmtDur 同约定：中文「75小时24分」，en 由 tr 出「h/m」。
  return m ? `${h}${tr("小时")}${m}${tr("分")}` : `${h}${tr("小时")}`;
}
