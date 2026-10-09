/**
 * （组合根瘦身）：仅主窗口（widget-0）驱动的周期调度——便签提醒扫描与
 * 更新检查。原为 App.tsx 内的两个 useEffect，收敛成组件后 App 的组合根
 * 只剩一行挂载。
 */
import { useEffect } from "react";
import { startNoteReminderScheduler } from "../../widget/notes-reminders";
import { startHabitReminderScheduler } from "../../widget/habit-reminders";
import { startCalendarReminderScheduler } from "../../widget/calendar-reminders";
import { purgeExpiredNotesTrash } from "../../widget/notes-store";
import { startUpdateScheduler } from "../../lib/update-scheduler";

/**
 * 调度挂载点（仅 primary 渲染）：
 * - 便签定时提醒扫描（30s 一轮；首轮扫描承担错过补发）；
 *   同一时机执行一轮便签回收站 30 天过期清理（幂等）。
 * - ：习惯打卡提醒扫描（20s 一轮）——此前挂在 HabitWidget 组件上，删组件
 *   即全员停摆；收敛到主窗单驱动（与便签提醒同模式，DND 期不再丢提醒）。
 * - 日历事件提醒扫描（30s 一轮）——同因从 CalendarWidget 上移：小组件不在
 *   画布上时提醒静默丢失；DND 期不标记留待补发。
 * - 更新检查调度（启动即查 + 按间隔周期；与前台检查/
 *   下载共用 CAS 门，发现新版本 toast 直达更新页）。
 */
export function PrimarySchedulers() {
  useEffect(() => {
    purgeExpiredNotesTrash();
    const stopNotes = startNoteReminderScheduler();
    const stopHabits = startHabitReminderScheduler();
    const stopCalendar = startCalendarReminderScheduler();
    return () => {
      stopNotes();
      stopHabits();
      stopCalendar();
    };
  }, []);
  useEffect(() => startUpdateScheduler(), []);
  return null;
}
