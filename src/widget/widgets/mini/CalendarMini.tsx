/**
 * 日历迷你磁贴（ISLAND-MINI）：日期数字 + 星期 + 下一事件（时间 + 标题）。
 * 复用 calendar-shared 的 loadCalendarEvents/calendarEventsOnDay（归一化 +
 * 重复展开 + 单次例外同口径——此前这里裸 JSON.parse 并复制了一份
 * repeatMatches，主组件改规则时会静默分裂）。「下一事件」= 今天尚未开始的
 * 最早定时事件，否则今天首个全天事件。时间由 lib/use-now 共享节拍器（30s）
 * 驱动，无自建定时器；无绑定实例只显日期。
 */
import { useMemo } from "react";
import { useAppLocale } from "../../../i18n-lite";
import { useNow } from "../../../lib/use-now";
import { calendarEventsOnDay, loadCalendarEvents } from "../calendar-shared";
import type { MiniComponentProps } from "../../registry";

function nextEventTitle(instanceId: string, now: Date): string | null {
  const list = calendarEventsOnDay(loadCalendarEvents(instanceId), now);
  if (list.length === 0) return null;
  const nowHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // 定时事件取尚未开始的最早一个；否则回退首个全天事件。
  const timed = list.filter((ev) => ev.time && ev.time >= nowHM).sort((a, b) => a.time.localeCompare(b.time));
  const hit = timed[0] ?? list.find((ev) => !ev.time);
  if (!hit) return null;
  return hit.time ? `${hit.time} ${hit.text}` : hit.text;
}

export function CalendarMini({ instanceId }: MiniComponentProps) {
  const now = useNow();
  const locale = useAppLocale();
  const next = useMemo(() => (instanceId ? nextEventTitle(instanceId, now) : null), [instanceId, now]);
  return (
    <span className="dock-mini dock-mini-calendar">
      <b className="dock-mini-cal-day">{now.getDate()}</b>
      <span className="dock-mini-cal-wd">{now.toLocaleDateString(locale, { weekday: "short" })}</span>
      {next && <span className="dock-mini-text">{next}</span>}
    </span>
  );
}
