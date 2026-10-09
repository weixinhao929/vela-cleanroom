/**
 * 事件编辑共享类型与常量：事件结构、色板与提醒档位（编辑器与归一化逻辑共用）。
 * 类型放在这里而不是 CalendarWidget：弹层组件（calendar-event-editor）若反向
 * import 宿主组件，会形成 widget ↔ 弹层的循环依赖。
 */
import type { IcsEvent } from "../../lib/ics";

/** 结构化事件（v2：+每天/间隔/终止/单次例外、结束时间、地点、备注）。 */
export type CalendarEvent = {
  id: string;
  text: string;
  /** HH:MM；空 = 全天事件。 */
  time: string;
  /** HH:MM 结束；空 = 默认时长（展示层按 60 分钟）。 */
  endTime: string;
  /** 主题色（hex；空 = 默认）。 */
  color: string;
  /** 重复规则；none = 仅锚点日。 */
  repeat: "none" | "daily" | "weekly" | "monthly" | "yearly";
  /** 间隔倍数（每 N 个周期；1 = 每）。 */
  repeatEvery: number;
  /** 重复终止日（YYYY-MM-DD，含当日；空 = 永久）。 */
  repeatUntil: string;
  /** 单次删除的例外日期键（重复事件「仅此日」删除；含锚点日）。 */
  excepted: string[];
  /** 提前提醒（分钟；0 = 不提醒）。 */
  remind: number;
  /** 地点；空 = 无。 */
  location: string;
  /** 备注；空 = 无。 */
  note: string;
};

/** 事件主题色板（空 = 跟随主题默认色）。 */
export const EVENT_COLORS = ["", "#5b8def", "#f59e0b", "#34d399", "#fb7185", "#8b7cf8"];

/** 提前提醒档位（分钟；0 = 不提醒）。 */
export const REMIND_CHOICES = [0, 5, 15, 30, 60];

/** 重复间隔上限（每 N 天/周/月/年）。 */
export const MAX_REPEAT_EVERY = 30;

/* ------------------------------------------------------------------ */
/* 存储 / 读取 / 重复展开（领域层：今日概览等聚合方与组件共用；
   键型同步登记在 instance-data.ts 的迁移说明里）。 */
/* ------------------------------------------------------------------ */

/** 事件表：锚点日期键（YYYY-MM-DD）→ 当日事件列表。 */
export type EventMap = Record<string, CalendarEvent[]>;

/** 事件按 instanceId 持久化到 localStorage（兼容旧版纯文本数组）。 */
export function calendarEventsKey(instanceId: string): string {
  return `focus-desk.calendar.${instanceId}.v1`;
}

/** 重复规则白名单。 */
const REPEATS: CalendarEvent["repeat"][] = ["none", "daily", "weekly", "monthly", "yearly"];

/** "9:5"/"09:05" → 545；非法返回 null。 */
export function hhmmToMin(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 分钟数 → "HH:MM"。 */
export function minToHHMM(min: number): string {
  const m = Math.max(0, Math.min(24 * 60, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 归一化单条事件载荷（字符串视为无时间的一天事件；非法返回 null）。
    v2 字段缺失时补默认值——旧数据（v1：无 endTime/repeatEvery/…）读取即迁移。 */
export function normalizeCalendarEvent(raw: unknown): CalendarEvent | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t
      ? {
          id: crypto.randomUUID(),
          text: t,
          time: "",
          endTime: "",
          color: "",
          repeat: "none",
          repeatEvery: 1,
          repeatUntil: "",
          excepted: [],
          remind: 0,
          location: "",
          note: ""
        }
      : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  if (!text) return null;
  const rawTime = typeof e.time === "string" && /^\d{1,2}:\d{2}$/.test(e.time) ? e.time.padStart(5, "0") : "";
  const rawEnd = typeof e.endTime === "string" && /^\d{1,2}:\d{2}$/.test(e.endTime) ? e.endTime.padStart(5, "0") : "";
  // 结束时间早于开始时间视为未设置（展示层回退默认时长）。
  const endTime = rawTime && rawEnd && rawEnd > rawTime ? rawEnd : "";
  const remind = Number(e.remind);
  const every = Number(e.repeatEvery);
  return {
    id: typeof e.id === "string" && e.id ? e.id : crypto.randomUUID(),
    text,
    time: rawTime,
    endTime,
    color: typeof e.color === "string" && /^#[0-9a-fA-F]{6}$/.test(e.color) ? e.color : "",
    repeat: REPEATS.includes(e.repeat as CalendarEvent["repeat"]) ? (e.repeat as CalendarEvent["repeat"]) : "none",
    repeatEvery: Number.isFinite(every) && every >= 1 && every <= MAX_REPEAT_EVERY ? Math.floor(every) : 1,
    repeatUntil: typeof e.repeatUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.repeatUntil) ? e.repeatUntil : "",
    excepted: Array.isArray(e.excepted)
      ? [...new Set(e.excepted.filter((k): k is string => typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k)))]
      : [],
    remind: Number.isFinite(remind) && REMIND_CHOICES.includes(remind) ? remind : 0,
    location: typeof e.location === "string" ? e.location.trim().slice(0, 120) : "",
    note: typeof e.note === "string" ? e.note.trim().slice(0, 500) : ""
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
      const events = list
        .map(normalizeCalendarEvent)
        .filter((e): e is CalendarEvent => e !== null)
        // 防护：终止日早于锚点日会让事件在所有日期静默消失（编辑器日期
        // 选错/外部数据都可能造成），读入时视为未设置终止。
        .map((e) => (e.repeatUntil && e.repeatUntil < key ? { ...e, repeatUntil: "" } : e))
        // （R-前端-1 存量自愈）：修复窗口期写入的「同 id 双事件」数据——
        // 重复 id 会让锚点键映射按插入顺序命中错误对象（点 A 删的是 B），
        // 读入时保留首现、丢弃后续（事件表按日小列表，O(n²) 无碍）。
        .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);
      if (events.length) out[key] = events;
    }
    return out;
  } catch {
    return {};
  }
}

/** 重复事件是否落在 date（anchor = 事件锚点日期）。
    纯周期判断：例外日（excepted）与终止日（repeatUntil）由 calendarEventsOnDay 统一过滤。 */
export function repeatMatches(anchor: Date, ev: CalendarEvent, date: Date): boolean {
  if (ev.repeat === "none") return false;
  if (date < anchor) return false;
  if (ev.repeatUntil && calendarDateKey(date.getFullYear(), date.getMonth(), date.getDate()) > ev.repeatUntil) {
    return false;
  }
  const every = ev.repeatEvery >= 1 ? Math.floor(ev.repeatEvery) : 1;
  // 零点差比较（DST 周 23/25h 用 round 归整到天数/周数）。
  const aZero = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()).getTime();
  const dZero = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  switch (ev.repeat) {
    case "daily":
      return Math.round((dZero - aZero) / 86_400_000) % every === 0;
    case "weekly": {
      if (anchor.getDay() !== date.getDay()) return false;
      return Math.round((dZero - aZero) / 604_800_000) % every === 0;
    }
    case "monthly": {
      if (anchor.getDate() !== date.getDate()) return false;
      const months = (date.getFullYear() - anchor.getFullYear()) * 12 + (date.getMonth() - anchor.getMonth());
      return months % every === 0;
    }
    case "yearly": {
      if (anchor.getMonth() !== date.getMonth() || anchor.getDate() !== date.getDate()) return false;
      return (date.getFullYear() - anchor.getFullYear()) % every === 0;
    }
  }
}

/** Date → YYYY-MM-DD 键。 */
export function calendarDateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 「仅此日」编辑的系列分裂（纯函数，便于单测）：
 *  原系列终止到 dayKey 前一天（编辑锚点日本身则原系列整体退役）+
 *  dayKey 落一条不重复的单次事件 + 从 dayKey 之后的首个命中日起续系列
 *  （续系列存到新命中日的键下——相位由原锚点决定；等于/早于新锚点的
 *  旧例外清理，晚于的保留）。返回新事件表。 */
export function splitRepeatOnce(
  events: EventMap,
  key: string,
  id: string,
  dayKey: string,
  draft: CalendarEvent
): EventMap {
  const list = events[key] ?? [];
  const target = list.find((e) => e.id === id);
  const anchor = parseCalendarKey(key);
  const day = parseCalendarKey(dayKey);
  if (!target || !anchor || !day || target.repeat === "none") return events;

  // R-前端-1（复审）：once 必须换新 id——编辑器 submit 的 draft.id 复用了
  // 原系列 id，截断后的残系列（out.push({...target})) 保有同一 id，同 id
  // 双事件会让 anchorKeyById 的 id→键映射按插入顺序漂移，编辑/删除命中
  // 错误对象（点 A 删的是 B）。续系列早已换新 id（下方 crypto），此处对齐。
  const once: CalendarEvent = {
    ...draft,
    id: crypto.randomUUID(),
    repeat: "none",
    repeatEvery: 1,
    repeatUntil: "",
    excepted: []
  };
  const out: CalendarEvent[] = list.filter((e) => e.id !== id);

  // 原系列：编辑日之后不再出现（锚点日被编辑时前移到锚点前 = 永不显示，剔除）。
  const prevDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
  const prevKey = calendarDateKey(prevDay.getFullYear(), prevDay.getMonth(), prevDay.getDate());
  if (prevKey >= key) {
    out.push({ ...target, repeatUntil: prevKey });
  }

  const next: EventMap = { ...events };
  if (out.length > 0) next[key] = out;
  else delete next[key];
  // push 目标一律复制——next 是浅拷贝，dayKey 已有事件时 next[dayKey]
  // 与调用方 state 数组同引用，原地 push 会变异 React 当前 state（本函数
  // 在 setState updater 内调用，StrictMode 双调用即产出重复事件）。
  next[dayKey] = [...(next[dayKey] ?? []), once];

  // 续系列：dayKey 后首个命中日为新锚点（相位保持：同星期/同日推进），
  // 存到新锚点键下（存原键会让编辑日前的日期双份显示）。
  const nextOcc = nextRepeatAfter(anchor, target, day);
  if (nextOcc) {
    const nextKey = calendarDateKey(nextOcc.getFullYear(), nextOcc.getMonth(), nextOcc.getDate());
    next[nextKey] = [
      ...(next[nextKey] ?? []),
      {
        ...target,
        id: crypto.randomUUID(),
        // 早于新锚点的旧例外已无意义；等于/晚于的保留——等于新锚点日 =
        // 该天曾被单独删除过，隐藏语义延续到续系列。
        excepted: target.excepted.filter((k) => k >= nextKey)
      }
    ];
  }
  return next;
}

/** 重复规则在 after（不含）之后的下一个命中日；系列已终止/推尽返回 null。
 *  相位由锚点决定（monthly 31 日溢出的周期自然跳过）。
 *  R-前端-2（复审）：步进起点按「锚点→after 的周期数」解析计算，不从
 *  step=1 空转——daily every=1 的系列锚点距今超过 500 天时，旧实现的前
 *  500 步全部落在 after 之前被 continue 吃掉，循环耗尽 return null，续系列
 *  静默丢失（原系列已被 splitRepeatOnce 截断，编辑日之后整段消失）。
 *  起点留 1 周期余量（DST/月末溢出的日期差近似），落 in-after 的步照旧
 *  被跳过，命中/终止语义不变。 */
export function nextRepeatAfter(anchor: Date, ev: CalendarEvent, after: Date): Date | null {
  if (ev.repeat === "none") return null;
  const every = ev.repeatEvery >= 1 ? Math.floor(ev.repeatEvery) : 1;
  // 周期数下界：各形态用日历粗差近似（宁可低估起点多走几步，不可高估跳过命中）。
  let startStep = 1;
  if (ev.repeat === "daily") {
    startStep = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / 86_400_000 / every) - 1);
  } else if (ev.repeat === "weekly") {
    startStep = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / (7 * 86_400_000) / every) - 1);
  } else if (ev.repeat === "monthly") {
    const months = (after.getFullYear() - anchor.getFullYear()) * 12 + (after.getMonth() - anchor.getMonth());
    startStep = Math.max(1, Math.floor(months / every) - 1);
  } else {
    startStep = Math.max(1, Math.floor((after.getFullYear() - anchor.getFullYear()) / every) - 1);
  }
  for (let step = startStep; step <= startStep + 500; step++) {
    const d = new Date(anchor);
    if (ev.repeat === "daily") d.setDate(d.getDate() + every * step);
    else if (ev.repeat === "weekly") d.setDate(d.getDate() + 7 * every * step);
    else if (ev.repeat === "monthly") d.setMonth(d.getMonth() + every * step);
    else d.setFullYear(d.getFullYear() + every * step);
    if (d <= after) continue;
    if (repeatMatches(anchor, ev, d)) return d;
    // 已越过终止日仍未命中（溢出周期）→ 系列实际已终结。
    if (ev.repeatUntil && calendarDateKey(d.getFullYear(), d.getMonth(), d.getDate()) > ev.repeatUntil) return null;
  }
  return null;
}

/** ICS 导入合并（去重，纯函数便于单测）：与既有事件「同日 + 同时 + 同标题」
 *  （锚点级或重复展开级命中均算）或与本次导入中前条重复的草稿跳过。
 *  返回新表与 {added, skipped} 统计。 */
export function mergeImportedEvents(
  existing: EventMap,
  drafts: { date: string; event: CalendarEvent }[]
): { events: EventMap; added: number; skipped: number } {
  const seen = new Set<string>();
  for (const [key, list] of Object.entries(existing)) {
    for (const ev of list) seen.add(`${key}|${ev.time}|${ev.text}`);
  }
  const next: EventMap = { ...existing };
  let added = 0;
  let skipped = 0;
  for (const { date, event } of drafts) {
    const sig = `${date}|${event.time}|${event.text}`;
    if (seen.has(sig)) {
      skipped++;
      continue;
    }
    // 重复展开级：既有系列的命中日上也撞款才算重复。
    const day = parseCalendarKey(date);
    const expandedHit =
      day && calendarEventsOnDay(existing, day).some((ev) => ev.time === event.time && ev.text === event.text);
    if (expandedHit) {
      skipped++;
      continue;
    }
    // 同款复制语义——next 与 existing 共享数组引用，原地 push 变异
    // 调用方 state（调用点在 setState updater 内重放，必须纯函数）。
    next[date] = [...(next[date] ?? []), event];
    seen.add(sig);
    added++;
  }
  return { events: next, added, skipped };
}

/** YYYY-MM-DD 键 → Date（非法返回 null，本地零点）。 */
export function parseCalendarKey(key: string): Date | null {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** 某事件表在指定日期的全部事件（锚点当日 + 重复规则命中 − 单次例外），按时间排序。
 *  与 CalendarWidget 的 eventsOnDay memo 是同口径双
 *  实现（本份为 CalendarMini 等消费的通用版）——单侧改规则必须同步另一侧。 */
export function calendarEventsOnDay(events: EventMap, date: Date): CalendarEvent[] {
  const key = calendarDateKey(date.getFullYear(), date.getMonth(), date.getDate());
  const out: CalendarEvent[] = [];
  for (const [anchorKey, list] of Object.entries(events)) {
    const anchor = parseCalendarKey(anchorKey);
    if (!anchor) continue;
    for (const ev of list) {
      if (anchorKey === key || repeatMatches(anchor, ev, date)) {
        if (!ev.excepted.includes(key)) out.push(ev);
      }
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

/* ------------------------------------------------------------------ */
/* 时间线日视图（纯函数，组件与测试共用）                                */
/* ------------------------------------------------------------------ */

/** 时间线上的一条安排（自有事件 / 同步课程 / ICS 订阅）。 */
export type TimelineItem = {
  id: string;
  kind: "event" | "course" | "sub";
  title: string;
  /** 相对 0 点的分钟（0–1440）。 */
  startMin: number;
  /** 含；endMin > startMin。 */
  endMin: number;
  color: string;
  location: string;
  /** 自有事件（可编辑/删除）；课程与订阅只读。 */
  ev?: CalendarEvent;
};

/** 布局结果：事件块已分列（重叠并排）。 */
export type TimelineLayout = {
  /** 轴范围（含 hourEnd；6→22 渲染 6:00..21:59 的块，高度 16 格）。 */
  hourStart: number;
  hourEnd: number;
  items: (TimelineItem & { col: number; cols: number })[];
};

/** 时间轴默认范围与外扩边界。 */
const TL_MIN_HOUR = 0;
const TL_MAX_HOUR = 24;
const TL_DEFAULT_START = 7;
const TL_DEFAULT_END = 22;

/**
 * 时间线布局：范围取事件覆盖 ±1 小时（钳到 [0,24]，默认 7–22），
 * 重叠事件贪心分列、连通重叠组内均分宽度（col 从 0 起，cols 为组宽）。
 * 纯函数，供详情面板与单测共用。
 */
export function layoutTimeline(items: TimelineItem[]): TimelineLayout {
  const timed = items
    .map((it) => ({
      ...it,
      startMin: Math.max(0, Math.min(24 * 60 - 1, Math.round(it.startMin))),
      endMin: Math.max(it.startMin + 5, Math.min(24 * 60, Math.round(it.endMin)))
    }))
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // 范围：有事件时按最早/最晚 ±1 小时外扩，留至少默认窗口的视野。
  let hourStart = TL_DEFAULT_START;
  let hourEnd = TL_DEFAULT_END;
  if (timed.length > 0) {
    hourStart = Math.max(TL_MIN_HOUR, Math.min(hourStart, Math.floor(timed[0].startMin / 60) - 1));
    const lastEnd = timed[timed.length - 1].endMin;
    hourEnd = Math.min(TL_MAX_HOUR, Math.max(hourEnd, Math.ceil(lastEnd / 60) + 1));
  }

  // 贪心分列：每列记录当前占用末尾，找第一个空列。
  const colEnds: number[] = [];
  for (const it of timed) {
    let col = colEnds.findIndex((end) => end <= it.startMin);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(it.endMin);
    } else {
      colEnds[col] = it.endMin;
    }
    (it as TimelineItem & { col: number }).col = col;
  }

  // 连通重叠组（后项 startMin < 组内 running maxEnd 即同组）：组宽 = 组内
  // 最大列数 + 1，组内所有块均分宽度——一遍扫描边界、组闭合时统一回填。
  type Laid = TimelineItem & { col: number; cols: number };
  const laid = timed as Laid[];
  let i = 0;
  while (i < laid.length) {
    let j = i;
    let maxEnd = laid[i].endMin;
    let maxCol = 0;
    while (j < laid.length && laid[j].startMin < maxEnd) {
      maxCol = Math.max(maxCol, laid[j].col);
      maxEnd = Math.max(maxEnd, laid[j].endMin);
      j++;
    }
    for (let k = i; k < j; k++) laid[k].cols = maxCol + 1;
    i = j;
  }

  return { hourStart, hourEnd, items: laid };
}

/* ------------------------------------------------------------------ */
/* ICS 导入转换（本地 .ics → 本实例事件草稿）                           */
/* ------------------------------------------------------------------ */

/** 导入的 ICS 提醒分钟数吸附到最近档位（>60 钳到 60）。 */
function snapRemind(min: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (const c of REMIND_CHOICES) {
    const d = Math.abs(c - min);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** ICS 解析事件 → 本地事件草稿（重复/提醒/地点尽力映射，COUNT 语义丢弃）。 */
export function icsToEventDraft(
  src: Pick<IcsEvent, "title" | "location" | "time" | "endTime" | "remind" | "repeat" | "repeatEvery" | "repeatUntil">
): CalendarEvent {
  return {
    id: crypto.randomUUID(),
    text: src.title || "（无标题）",
    time: src.time,
    endTime: src.endTime,
    color: "",
    repeat: src.repeat,
    repeatEvery: src.repeatEvery,
    repeatUntil: src.repeatUntil,
    excepted: [],
    remind: snapRemind(src.remind ?? 0),
    location: src.location,
    note: ""
  };
}
