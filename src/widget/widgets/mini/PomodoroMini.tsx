/* eslint-disable react-refresh/only-export-components */
/**
 * 番茄钟迷你磁贴（ISLAND-CORE：自 DockContainer.PomodoroTile 迁出，行为不变）：
 * 空闲显 Timer 图标；计时中显进度环 + mm:ss。数据只读 useAppStore（zustand
 * 订阅，无轮询）。PomodoroRing / usePomodoroView 同时供 dock 展开面板复用
 * （组件与派生视图 hook 同文件，故文件级豁免 react-refresh 规则）。
 */
import { Timer } from "lucide-react";
import { countupGoalSeconds, plannedSecondsFor } from "../../../domain/pomodoro";
import { useAppStore } from "../../../store/app-store";
import { formatMMSS, ringProgress } from "../../dock/dock-logic";

/** 番茄钟环：r=(size−stroke)/2 的 SVG 环，进度按 stroke-dashoffset 走（合成器友好）。 */
export function PomodoroRing({
  progress,
  size = 20,
  stroke = 2.4,
  mode
}: {
  progress: number;
  size?: number;
  stroke?: number;
  mode: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={`dock-ring is-${mode}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle className="dock-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
      <circle
        className="dock-ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - progress)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function usePomodoroView() {
  /* 同款标量选择（P-perf 三轮）：此前整对象订阅 s.pomodoro——tick 每秒整体
     替换对象，任何无关字段（中断记录/会话列表等）变化也会连带重渲。逐标量
     订阅后仅显示相关字段变化才重渲；计时走秒本身 1Hz 属显示必要，不受影响。 */
  const remainingSeconds = useAppStore((s) => s.pomodoro.remainingSeconds);
  const isRunning = useAppStore((s) => s.pomodoro.isRunning);
  const mode = useAppStore((s) => s.pomodoro.mode);
  const timerMode = useAppStore((s) => s.pomodoro.timerMode);
  /* （残留）：等待回座态（awaitingActivity）不是空闲——满额待命时
     显示环（Dock 展开面板同款「等你回来」语义），不再回落空闲表图标。 */
  const awaiting = useAppStore((s) => s.pomodoro.awaitingActivity);
  const config = useAppStore((s) => s.pomodoroConfig);
  const planned = plannedSecondsFor(mode, config);
  /* （分母统一）：正计时目标 = 配置（0 = 跟随专注时长）——此前直接
     取 countupGoalMinutes*60，配置为默认 0 时环恒不填充，与主面板口径相反。 */
  const goal = timerMode === "countup" ? countupGoalSeconds(config) : planned;
  const progress = ringProgress(remainingSeconds, goal, timerMode);
  const idle = !isRunning && !awaiting && remainingSeconds === planned && timerMode === "countdown";
  return { remainingSeconds, isRunning, mode, progress, idle, planned };
}

export function PomodoroMini() {
  const { remainingSeconds, isRunning, mode, progress, idle } = usePomodoroView();
  return (
    <span className={`dock-pomo${isRunning ? " is-running" : ""}`}>
      {idle ? <Timer size={14} /> : <PomodoroRing progress={progress} mode={mode} />}
      {!idle && <span className="dock-pomo-time">{formatMMSS(remainingSeconds)}</span>}
    </span>
  );
}
