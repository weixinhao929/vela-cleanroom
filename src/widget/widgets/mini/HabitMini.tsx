/**
 * 习惯打卡迷你磁贴（ISLAND-MINI）：今日打卡 x/y 小环。
 * 数据只读 habits-store（zustand 订阅，无轮询）；「今日」键由 lib/use-now 共享
 * 节拍器的 dayKeyOf 驱动，跨零点自动翻新。环复用 PomodoroMini.PomodoroRing
 * （stroke-dashoffset 合成器动画）；全部完成时 .is-complete 切 success 配色。
 */
import { dayKeyOf, useNow } from "../../../lib/use-now";
import { useHabitsStore } from "../../../store/habits-store";
import { PomodoroRing } from "./PomodoroMini";

export function HabitMini() {
  const habits = useHabitsStore((s) => s.habits);
  const today = dayKeyOf(useNow());
  const total = habits.length;
  const done = habits.reduce((n, h) => n + (h.done[today] ? 1 : 0), 0);
  const complete = total > 0 && done === total;
  return (
    <span className={`dock-mini dock-mini-habit${complete ? " is-complete" : ""}`}>
      <PomodoroRing progress={total ? done / total : 0} size={16} stroke={2.4} mode="habit" />
      <span className="dock-mini-num">
        {done}/{total}
      </span>
    </span>
  );
}
