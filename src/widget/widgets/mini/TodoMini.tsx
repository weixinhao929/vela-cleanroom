/**
 * 待办迷你磁贴（ISLAND-MINI）：「今日剩余 N」；全部完成显 ✓。
 * 数据只读 useAppStore.tasks（zustand 订阅，无轮询）。「今日剩余」= 未完成且
 * 截止在今天结束前（含逾期）或无截止的任务——与 TodayTasksPanel 分组里的
 * 逾期 / 今天到期 / 无截止同口径，未来到期的不计。日界由 lib/use-now 共享
 * 节拍器的 dayKey 驱动，跨零点自动翻新。
 */
import { useMemo } from "react";
import { Check } from "lucide-react";
import { useT } from "../../../i18n-lite";
import { dayKeyOf, dayKeyToDate, useNow } from "../../../lib/use-now";
import { useAppStore } from "../../../store/app-store";

export function TodoMini() {
  const tr = useT();
  const tasks = useAppStore((s) => s.tasks);
  const todayKey = dayKeyOf(useNow());
  const remaining = useMemo(() => {
    const dayEnd = (dayKeyToDate(todayKey)?.getTime() ?? 0) + 86_400_000;
    return tasks.filter((t) => {
      if (t.completed) return false;
      if (!t.dueAt) return true;
      const due = new Date(t.dueAt).getTime();
      return Number.isNaN(due) || due < dayEnd;
    }).length;
  }, [tasks, todayKey]);
  const done = remaining === 0;

  return (
    <span className={`dock-mini dock-mini-todo${done ? " is-done" : ""}`}>
      {done && <Check size={13} className="dock-mini-ico" aria-hidden="true" />}
      <span className="dock-mini-num">
        {done ? tr("全部完成") : tr("今日剩余 {n}").replace("{n}", String(remaining))}
      </span>
    </span>
  );
}
