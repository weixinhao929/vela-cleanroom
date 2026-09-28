/**
 * W-013 事件编辑共享类型与常量：事件结构、色板与提醒档位（编辑器与归一化逻辑共用）。
 * 类型放在这里而不是 CalendarWidget：弹层组件（calendar-event-editor）若反向
 * import 宿主组件，会形成 widget ↔ 弹层的循环依赖。
 */

/** W-013 结构化事件。 */
export type CalendarEvent = {
  id: string;
  text: string;
  /** HH:MM；空 = 全天事件。 */
  time: string;
  /** 主题色（hex；空 = 默认）。 */
  color: string;
  /** 重复规则；none = 仅当天。 */
  repeat: "none" | "weekly" | "monthly" | "yearly";
  /** 提前提醒（分钟；0 = 不提醒）。 */
  remind: number;
};

/** W-013 事件主题色板（空 = 跟随主题默认色）。 */
export const EVENT_COLORS = ["", "#5b8def", "#f59e0b", "#34d399", "#fb7185", "#8b7cf8"];

/** W-013 提前提醒档位（分钟；0 = 不提醒）。 */
export const REMIND_CHOICES = [0, 5, 15, 30, 60];

/* ------------------------------------------------------------------ */
/* 存储 / 读取 / 重复展开（W-013 领域层：今日概览等聚合方与组件共用；
   键型同步登记在 instance-data.ts 的迁移说明里）。 */
/* ------------------------------------------------------------------ */

/** 事件表：锚点日期键（YYYY-MM-DD）→ 当日事件列表。 */
export type EventMap = Record<string, CalendarEvent[]>;

/** 事件按 instanceId 持久化到 localStorage（兼容旧版纯文本数组）。 */
export function calendarEventsKey(instanceId: string): string {
  return `focus-desk.calendar.${instanceId}.v1`;
}

/** 归一化单条事件载荷（字符串视为无时间的一天事件；非法返回 null）。 */
export function normalizeCalendarEvent(raw: unknown): CalendarEvent | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t ? { id: crypto.randomUUID(), text: t, time: "", color: "", repeat: "none", remind: 0 } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  if (!text) return null;
  const time = typeof e.time === "string" && /^\d{1,2}:\d{2}$/.test(e.time) ? e.time : "";
  const repeat = e.repeat === "weekly" || e.repeat === "monthly" || e.repeat === "yearly" ? e.repeat : "none";
  const remind = Number(e.remind);
  return {
    id: typeof e.id === "string" && e.id ? e.id : crypto.randomUUID(),
    text,
    time,
    color: typeof e.color === "string" && /^#[0-9a-fA-F]{6}$/.test(e.color) ? e.color : "",
    repeat,
    remind: Number.isFinite(remind) && REMIND_CHOICES.includes(remind) ? remind : 0
  };
}

/** 读取某实例的事件表；缺失/损坏返回空表。 */
export function loadCalendarEvents(instanceId: string): EventMap {
  try {
    const raw = localStorage.getItem(calendarEventsKey(instanceId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: EventMap = {};
    for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const events = list.map(normalizeCalendarEvent).filter((e): e is CalendarEvent => e !== null);
      if (events.length) out[key] = events;
    }
    return out;
  } catch {
    return {};
  }
}

/** 重复事件是否落在 date（anchor = 事件锚点日期）。 */
export function repeatMatches(anchor: Date, repeat: CalendarEvent["repeat"], date: Date): boolean {
  if (date < anchor) return false;
  if (repeat === "weekly") return anchor.getDay() === date.getDay();
  if (repeat === "monthly") return anchor.getDate() === date.getDate();
  return anchor.getMonth() === date.getMonth() && anchor.getDate() === date.getDate();
}

/** Date → YYYY-MM-DD 键。 */
export function calendarDateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** YYYY-MM-DD 键 → Date（非法返回 null，本地零点）。 */
export function parseCalendarKey(key: string): Date | null {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** 某事件表在指定日期的全部事件（锚点当日 + 重复规则命中），按时间排序。 */
export function calendarEventsOnDay(events: EventMap, date: Date): CalendarEvent[] {
  const key = calendarDateKey(date.getFullYear(), date.getMonth(), date.getDate());
  const out = [...(events[key] ?? [])];
  for (const [anchorKey, list] of Object.entries(events)) {
    if (anchorKey === key) continue;
    const anchor = parseCalendarKey(anchorKey);
    if (!anchor) continue;
    for (const ev of list) {
      if (ev.repeat !== "none" && repeatMatches(anchor, ev.repeat, date)) out.push(ev);
    }
  }
  out.sort((a, b) => a.time.localeCompare(b.time) || a.text.localeCompare(b.text));
  return out;
}

/**
 * 跨实例聚合某日事件（今日概览用）：扫描全部 focus-desk.calendar.* 键，
 * 展开重复规则，返回 {实例, 事件} 平铺列表（按时间排序）。日历事件按实例
 * 分键，此前概览只能聚合全局数据（待办/DDL/习惯），日历进不了「今天」。
 */
export function listCalendarEventsOnDayAcrossInstances(date: Date): { instanceId: string; event: CalendarEvent }[] {
  const out: { instanceId: string; event: CalendarEvent }[] = [];
  const prefix = "focus-desk.calendar.";
  const suffix = ".v1";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const instanceId = key.slice(prefix.length, key.length - suffix.length);
    if (!instanceId) continue;
    for (const event of calendarEventsOnDay(loadCalendarEvents(instanceId), date)) {
      out.push({ instanceId, event });
    }
  }
  out.sort((a, b) => a.event.time.localeCompare(b.event.time) || a.event.text.localeCompare(b.event.text));
  return out;
}
