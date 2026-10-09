/**
 * 习惯打卡提醒（主窗单驱动）：提醒扫描此前挂在 HabitWidget 组件的
 * useEffect 上——删除组件/所在视图未挂载即全员停摆；免打扰期内先标记
 * remindedOn 再 sourceNotify（被 DND 静默吞掉），提醒永久丢失。参照
 * notes-reminders 的「仅主窗口调度」模式：App 级单驱动，组件只做展示。
 */
import { useHabitsStore } from "../store/habits-store";
import { sourceNotify } from "../lib/notifications";
import { dndSuppressing } from "../lib/dnd";
import { t } from "../i18n-lite";

/** 扫描间隔（沿用组件期 20s 粒度）。 */
export const HABIT_REMINDER_SCAN_MS = 20_000;

const dayKeyOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 单轮扫描：到点未打卡的习惯发一次提醒（当天只发一次）。返回发出条数（测试用）。 */
export function scanHabitReminders(now = new Date()): number {
  const tk = dayKeyOf(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  const habits = useHabitsStore.getState().habits;
  const due = habits.filter((h) => {
    if (!h.remindAt || h.done[tk] || h.remindedOn === tk) return false;
    const [hh, mm] = h.remindAt.split(":").map(Number);
    return !Number.isNaN(hh) && !Number.isNaN(mm) && mins >= hh * 60 + mm;
  });
  if (due.length === 0) return 0;
  // 免打扰：不发送也**不标记**——此前先 mark 再发，DND 把通知吞掉后该提醒
  // 被记成"已发"而永久丢失；留待 DND 结束后的下一轮补发（≤20s 延迟）。
  if (dndSuppressing()) return 0;
  const ids = [...new Set(due.map((h) => h.id))];
  useHabitsStore.getState().markHabitsReminded(ids, tk);
  void sourceNotify("habit", t("习惯打卡提醒"), `${due.map((h) => h.name).join("、")} ${t("今天还没打卡")}`);
  return due.length;
}

/**
 * 启动周期扫描（仅主窗口调用一次，单驱动原则）。文档隐藏时跳过当轮
 * （回来首轮立即补上），返回停止函数。
 */
export function startHabitReminderScheduler(): () => void {
  const timer = window.setInterval(() => {
    if (document.hidden) return;
    scanHabitReminders();
  }, HABIT_REMINDER_SCAN_MS);
  return () => window.clearInterval(timer);
}
