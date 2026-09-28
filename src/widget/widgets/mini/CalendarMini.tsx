/**
 * 日历迷你磁贴（ISLAND-MINI）：日期数字 + 星期 + 下一事件标题（有则显示）。
 * 事件只读 CalendarWidget 落盘的 localStorage（focus-desk.calendar.<instanceId>.v1，
 * anchorKey → CalendarEvent[]），重复规则按 CalendarWidget.repeatMatches 同口径
 * 展开；「下一事件」= 今天尚未开始的最早定时事件，否则今天首个全天事件。
 * 时间由 lib/use-now 共享节拍器（30s）驱动，无自建定时器；无绑定实例只显日期。
 */
import { useMemo } from "react";
import { useAppLocale } from "../../../i18n-lite";
import { dayKeyOf, dayKeyToDate, useNow } from "../../../lib/use-now";
import type { CalendarEvent } from "../calendar-shared";
import type { MiniComponentProps } from "../../registry";

function repeatMatches(anchor: Date, repeat: CalendarEvent["repeat"], date: Date): boolean {
  if (date < anchor) return false;
  if (repeat === "weekly") return anchor.getDay() === date.getDay();
  if (repeat === "monthly") return anchor.getDate() === date.getDate();
  return anchor.getMonth() === date.getMonth() && anchor.getDate() === date.getDate();
}

function nextEventTitle(instanceId: string, now: Date): string | null {
  let map: unknown;
  try {
    map = JSON.parse(localStorage.getItem(`focus-desk.calendar.${instanceId}.v1`) ?? "{}");
  } catch {
    return null;
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const todayKey = dayKeyOf(now);
  const today = dayKeyToDate(todayKey)!;
  const nowHM = now.toTimeString().slice(0, 5);
  const hits: { text: string; time: string }[] = [];
  for (const [key, list] of Object.entries(map as Record<string, unknown>)) {
    const anchor = dayKeyToDate(key);
    if (!Array.isArray(list) || !anchor) continue;
    for (const raw of list as Partial<CalendarEvent>[]) {
      const text = typeof raw?.text === "string" ? raw.text.trim() : "";
      const time = typeof raw?.time === "string" && /^\d{1,2}:\d{2}$/.test(raw.time) ? raw.time.padStart(5, "0") : "";
      const repeat =
        raw?.repeat === "weekly" || raw?.repeat === "monthly" || raw?.repeat === "yearly" ? raw.repeat : "none";
      const onToday = key === todayKey || (repeat !== "none" && repeatMatches(anchor, repeat, today));
      if (text && onToday && (!time || time >= nowHM)) hits.push({ text, time });
    }
  }
  hits.sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  return hits[0]?.text ?? null;
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
