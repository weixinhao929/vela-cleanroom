/**
 * 日历事件提醒（主窗单驱动）：提醒扫描此前挂在 CalendarWidget 组件的
 * useEffect 上——删除小组件/所在视图未挂载即全员停摆（设置提醒的事件静默
 * 不响）。参照 habit-reminders 的「仅主窗口调度」模式收敛到 App 级，
 * 组件只负责展示与编辑。
 *
 * 补发语义：到点窗口为 [开始−提醒, 开始+15 分钟]。睡眠/晚启动错过到点时刻
 * 仍在窗口内时补发一次；免打扰期内不发送也**不标记**（markReminded 留待
 * DND 结束后的下一轮），避免提醒被吞后永久丢失。
 */
import { sourceNotify } from "../lib/notifications";
import { dndSuppressing } from "../lib/dnd";
import { markReminded } from "../lib/remind-dedupe";
import { t } from "../i18n-lite";
import { calendarDateKey, hhmmToMin, listCalendarEventsOnDayAcrossInstances } from "./widgets/calendar-shared";

/** 扫描间隔（沿用组件期 30s 粒度）。 */
export const CALENDAR_REMINDER_SCAN_MS = 30_000;

/** 事件开始后仍允许补发的窗口（分钟）。 */
export const CALENDAR_REMINDER_GRACE_MIN = 15;

/** 单轮扫描：当天带提醒的事件到点推送一次（跨实例；去重键按天）。返回发出条数（测试用）。 */
export function scanCalendarReminders(now = new Date()): number {
  const key = calendarDateKey(now.getFullYear(), now.getMonth(), now.getDate());
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let sent = 0;
  for (const { instanceId, event } of listCalendarEventsOnDayAcrossInstances(now)) {
    if (!event.time || event.remind <= 0) continue;
    const startMin = hhmmToMin(event.time);
    if (startMin == null) continue;
    const fireAt = Math.max(0, startMin - event.remind);
    // 窗口 [fireAt, 开始+宽限]：早于 fireAt 未到点；晚于宽限线视为已错过放弃。
    if (nowMin < fireAt || nowMin > startMin + CALENDAR_REMINDER_GRACE_MIN) continue;
    // DND：不发送也不标记，下一轮（≤30s）在 DND 结束后补发。
    if (dndSuppressing()) break;
    const dedupeKey = `focus-desk.cal-remind.${instanceId}.${event.id}.${key}`;
    if (!markReminded(dedupeKey, "focus-desk.cal-remind.", key)) continue;
    const body = event.time + " " + event.text + (event.location ? ` · ${event.location}` : "");
    void sourceNotify("calendar", t("日历提醒"), body);
    sent++;
  }
  return sent;
}

/**
 * 启动周期扫描（仅主窗口调用一次，单驱动原则）。文档隐藏时跳过当轮
 * （回来首轮立即补上），返回停止函数。
 */
export function startCalendarReminderScheduler(): () => void {
  const timer = window.setInterval(() => {
    if (document.hidden) return;
    scanCalendarReminders();
  }, CALENDAR_REMINDER_SCAN_MS);
  return () => window.clearInterval(timer);
}
