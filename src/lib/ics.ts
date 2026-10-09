/**
 * ICS 日历订阅（只读）+ 本地事件导出。
 *
 * 订阅/导入（Google Calendar / Outlook 导出的 .ics）：
 *  - VEVENT 的 SUMMARY / DTSTART / DTEND / LOCATION；
 *  - 全天事件（DTSTART;VALUE=DATE）与定时事件（浮动本地时间，桌面场景
 *    与本机同时区一致即可）；
 *  - RRULE（DAILY/WEEKLY/MONTHLY/YEARLY，含 INTERVAL/UNTIL/COUNT/BYDAY）；
 *    WEEKLY;BYDAY=MO,WE 精确展开；MONTHLY;BYDAY 支持「第 N 个星期几」（2TU/-1SU），
 *    其余 BYxxx 规则按基础频率近似展开；
 *  - EXDATE 排除单次实例；VALARM TRIGGER 折算为提前提醒分钟数。
 * 时区（VTIMEZONE）不解析 —— 绝大多数订阅源的浮动时间即为本地时间；
 * TZID 参数的源按浮动本地时间解释（无 tz 数据库时的 best effort）。
 *
 * 导出：buildCalendarIcs 把本地日历事件生成为标准 VCALENDAR（RRULE/EXDATE/
 * VALARM 全量映射），供备份与外部日历订阅导入。
 */

import { fetchText } from "./net-fetch";

export type IcsEvent = {
  uid: string;
  title: string;
  location: string;
  /** ISO 日期 yyyy-mm-dd。 */
  date: string;
  /** HH:MM；空为全天。 */
  time: string;
  /** HH:MM；可为空。 */
  endTime: string;
  /** VALARM TRIGGER 折算的提前提醒分钟（0 = 无）。 */
  remind: number;
  /** RRULE 映射的重复语义（导入转本地事件用）。 */
  repeat: "none" | "daily" | "weekly" | "monthly" | "yearly";
  /** RRULE INTERVAL（每 N 个周期）。 */
  repeatEvery: number;
  /** RRULE UNTIL（YYYY-MM-DD，含当日；空 = 永久）。 */
  repeatUntil: string;
};

/** ICS 折行（CRLF + 空格/制表续行）展开为逻辑行。 */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** NAME;PARAM=a:b → { name, value }（参数保留原文，值里的冒号保留）。 */
function splitProp(line: string): { name: string; params: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const semi = head.indexOf(";");
  return {
    name: (semi < 0 ? head : head.slice(0, semi)).trim().toUpperCase(),
    params: semi < 0 ? "" : head.slice(semi + 1),
    value: line.slice(colon + 1)
  };
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

const p2 = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const stamp = (d: Date) =>
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

/** 解析 DTSTART/DTEND/UNTIL：DATE（全天）或浮动本地时间；带 Z 的按本地时区换算。
    TZID 参数不解析（按浮动本地时间解释）。 */
function parseStamp(params: string, value: string): { date: Date; allDay: boolean } | null {
  const v = value.trim();
  if (/VALUE=DATE/i.test(params) || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.test(v) ? v.match(/^(\d{4})(\d{2})(\d{2})$/) : null;
    if (!m) return null;
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (m[7] === "Z") {
    return { date: new Date(d.getTime() - d.getTimezoneOffset() * 60000), allDay: false };
  }
  return { date: d, allDay: false };
}

const hhmm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

/** 本地零点副本（窗口/终止比较用，消除带时刻事件与零点窗口的边界误判）。 */
const at0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

type RawEvent = {
  uid: string;
  summary: string;
  location: string;
  start: { date: Date; allDay: boolean } | null;
  end: { date: Date; allDay: boolean } | null;
  rrule: string;
  /** VALARM TRIGGER 提前分钟（0 = 无）。 */
  alarmMin: number;
  /** EXDATE 的 ISO 日期集合（datetime 值取其日期部分）。 */
  exdates: Set<string>;
};

/** TRIGGER（ISO 8601 duration，负值 = 提前）→ 提前分钟；解析失败/正值返回 0。 */
function parseTriggerMinute(v: string): number {
  const m = v
    .trim()
    .toUpperCase()
    .match(/^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, sign, w, d, h, mi] = m;
  const mins = (Number(w ?? 0) * 7 + Number(d ?? 0)) * 1440 + Number(h ?? 0) * 60 + Number(mi ?? 0);
  return sign === "-" ? mins : 0;
}

/** EXDATE 值（逗号分隔多值；DATE 或 DATETIME）→ ISO 日期键数组。 */
function parseExdates(params: string, value: string): string[] {
  const out: string[] = [];
  for (const v of value.split(",")) {
    const parsed = parseStamp(params, v);
    if (parsed) out.push(iso(parsed.date));
  }
  return out;
}

/** BYDAY=MO,TU,-1SU 每项 → { wd（0=周日）, ord（0=无序号）}；非法项跳过。 */
const WD_NAMES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseByDay(v: string): { wd: number; ord: number }[] {
  const out: { wd: number; ord: number }[] = [];
  for (const tok of v.split(",")) {
    const m = tok
      .trim()
      .toUpperCase()
      .match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/);
    if (m) out.push({ wd: WD_NAMES[m[2]], ord: m[1] ? Number(m[1]) : 0 });
  }
  return out;
}

/** 单次推进一个重复周期（月/年按日历语义）。 */
function advance(base: Date, freq: string, interval: number, step: number): Date {
  const d = new Date(base);
  if (freq === "DAILY") d.setDate(d.getDate() + interval * step);
  else if (freq === "WEEKLY") d.setDate(d.getDate() + 7 * interval * step);
  else if (freq === "MONTHLY") d.setMonth(d.getMonth() + interval * step);
  else d.setFullYear(d.getFullYear() + interval * step);
  return d;
}

/** 某月第 ord 个星期 wd（ord<0 从月末数）；ord=0 或越界返回 null。 */
function nthWeekdayOfMonth(year: number, month: number, wd: number, ord: number): Date | null {
  if (ord === 0) return null;
  if (ord > 0) {
    const d = new Date(year, month, 1);
    const shift = (wd - d.getDay() + 7) % 7;
    d.setDate(1 + shift + (ord - 1) * 7);
    return d.getMonth() === month ? d : null;
  }
  const last = new Date(year, month + 1, 0);
  const shift = (last.getDay() - wd + 7) % 7;
  const d = new Date(last);
  d.setDate(last.getDate() - shift + (ord + 1) * 7);
  return d.getMonth() === month ? d : null;
}

/**
 * 解析 ICS 文本，展开时间窗口内的全部事件实例（含 RRULE 重复）。
 * 支持 DAILY/WEEKLY/MONTHLY/YEARLY × INTERVAL、DATE 全天与浮动本地时间、
 * WEEKLY/MONTHLY 的 BYDAY、EXDATE 排除、VALARM 提前提醒折算；跨天事件按天
 * 铺开；畸形源（DTSTART 早于窗口数年）通过起点钳制 + 铺开/周期上限防御。
 * 复杂度 O(events × 周期数 × 每周期实例数)。
 *
 * @param text - ICS 原文（VCALENDAR/VEVENT 结构）。
 * @param windowStart - 窗口起点（含；按本地日期比较）。
 * @param windowEnd - 窗口终点（含）。
 * @returns 窗口内事件数组（start/end 已换算为本地 Date）。
 * @throws 无——文本级损坏按跳过对应事件处理。
 *
 * @example
 * ```ts
 * const events = parseIcs(icsText, weekStart, weekEnd);
 * ```
 */
export function parseIcs(text: string, windowStart: Date, windowEnd: Date): IcsEvent[] {
  const events: RawEvent[] = [];
  let cur: RawEvent | null = null;
  let inValarm = false;
  for (const line of unfold(text)) {
    const prop = splitProp(line);
    if (!prop) continue;
    const { name, params, value } = prop;
    const block = value.trim().toUpperCase();
    if (name === "BEGIN" && block === "VEVENT") {
      cur = { uid: "", summary: "", location: "", start: null, end: null, rrule: "", alarmMin: 0, exdates: new Set() };
      inValarm = false;
    } else if (name === "BEGIN" && block === "VALARM") {
      inValarm = true;
    } else if (name === "END" && block === "VALARM") {
      inValarm = false;
    } else if (name === "END" && block === "VEVENT") {
      if (cur && cur.start) events.push(cur);
      cur = null;
    } else if (cur) {
      if (inValarm) {
        if (name === "TRIGGER") cur.alarmMin = parseTriggerMinute(value);
      } else if (name === "UID") cur.uid = value.trim();
      else if (name === "SUMMARY") cur.summary = unescapeText(value);
      else if (name === "LOCATION") cur.location = unescapeText(value);
      else if (name === "DTSTART") cur.start = parseStamp(params, value);
      else if (name === "DTEND") cur.end = parseStamp(params, value);
      else if (name === "RRULE") cur.rrule = value.trim();
      else if (name === "EXDATE") for (const d of parseExdates(params, value)) cur.exdates.add(d);
    }
  }

  const wStart = at0(windowStart);
  const wEnd = at0(windowEnd);
  const out: IcsEvent[] = [];
  for (const ev of events) {
    if (!ev.start) continue;
    const durMs = ev.end ? ev.end.date.getTime() - ev.start.date.getTime() : 0;

    // 无重复：按日期判断是否落在窗口内（跨天事件按天铺开）。起点钳制到窗口
    // 内 + 单事件 400 天铺开上限（防畸形源海量迭代）。
    if (!ev.rrule) {
      const dayEnd = new Date(ev.end?.date ?? ev.start.date);
      // RFC 5545：全天事件的 DTEND 是排他的（Google 导出的单日全天事件即
      // DTSTART=当天、DTEND=次日），按含端点铺开会让每个全天事件多显示一天。
      if (ev.end?.allDay && ev.end.date > ev.start.date) dayEnd.setDate(dayEnd.getDate() - 1);
      const firstDay = at0(ev.start.date) > wStart ? at0(ev.start.date) : new Date(wStart);
      let spread = 0;
      for (let d = firstDay; d <= dayEnd && d <= wEnd && spread < 400; d.setDate(d.getDate() + 1)) {
        const isStart = d.toDateString() === ev.start.date.toDateString();
        out.push(toIcs(ev, d, isStart ? ev.start : null, durMs, ev.alarmMin, ""));
        spread++;
      }
      continue;
    }

    // ---- RRULE 展开 ----
    const parts: Record<string, string> = {};
    for (const kv of ev.rrule.split(";")) {
      const [k, v] = kv.split("=");
      if (k && v) parts[k.toUpperCase()] = v;
    }
    const freq = (parts.FREQ ?? "").toUpperCase();
    if (!/DAILY|WEEKLY|MONTHLY|YEARLY/.test(freq)) continue;
    const interval = Math.max(1, Number(parts.INTERVAL) || 1);
    const count = parts.COUNT ? Math.max(1, Number(parts.COUNT) || 1) : Infinity;
    let until: Date | null = null;
    if (parts.UNTIL) {
      const parsed = parseStamp("", parts.UNTIL);
      if (parsed) until = at0(parsed.date);
    }
    const hardEnd = until && until < wEnd ? until : wEnd;
    const bydays = parts.BYDAY ? parseByDay(parts.BYDAY) : [];

    const first = ev.start.date;
    let emitted = 0;
    /** COUNT 从 DTSTART 序列起算（窗口外实例也计数）；EXDATE 排除单次实例。 */
    const emit = (inst: Date) => {
      if (emitted >= count) return false;
      emitted++;
      if (at0(inst) >= wStart && at0(inst) <= hardEnd && !ev.exdates.has(iso(inst))) {
        out.push(toIcs(ev, inst, ev.start, durMs, ev.alarmMin, ev.rrule));
      }
      return true;
    };

    // 每周期的实例集合（周期从 DTSTART 起单调推进；周/月锚定 DTSTART 所在周/月）。
    /* （R-前端-2 同型）：600 周期配额是**终止防御**，此前从 DTSTART 起
       数——daily 系列距窗口起点超约 20 个月即在抵达窗口前烧光配额，订阅面
       静默丢失。改为**窗口相对**配额：按「DTSTART→wStart」的周期数下界估计
       预留配额（floor 低估最多差 1~2 个周期，剩余步数由循环自然走完），循
       环仍从 p=0 起步保证 COUNT 从 DTSTART 精确计数（COUNT 语义不变）。
       窗口为 2~3 年，下界最大几千，总迭代上限 = p0 + 600 仍充分有界。 */
    const MS_PER_DAY = 86400000;
    const leadDays = Math.max(0, Math.floor((at0(wStart).getTime() - at0(first).getTime()) / MS_PER_DAY));
    let leadPeriods = 0;
    if (freq === "DAILY") leadPeriods = Math.floor(leadDays / interval);
    else if (freq === "WEEKLY") leadPeriods = Math.floor(leadDays / (7 * interval));
    else if (freq === "MONTHLY") {
      const months = (wStart.getFullYear() - first.getFullYear()) * 12 + (wStart.getMonth() - first.getMonth());
      leadPeriods = Math.max(0, Math.floor(months / interval));
    } else {
      leadPeriods = Math.max(0, Math.floor((wStart.getFullYear() - first.getFullYear()) / interval));
    }
    const MAX_PERIODS = 600 + leadPeriods;
    let stopped = false;
    for (let p = 0; p < MAX_PERIODS && !stopped; p++) {
      const insts: Date[] = [];
      if (freq === "DAILY" || ((freq === "WEEKLY" || freq === "YEARLY") && bydays.length === 0)) {
        insts.push(advance(first, freq, interval, p));
      } else if (freq === "WEEKLY") {
        // 周期 = interval 周；每周展开 BYDAY 的每个星期几（DTSTART 之前不生成）。
        const week0 = at0(first);
        week0.setDate(week0.getDate() - ((week0.getDay() + 6) % 7)); // 周一为界
        for (const { wd } of bydays) {
          const d = new Date(week0);
          d.setDate(week0.getDate() + p * 7 * interval + ((wd + 6) % 7));
          insts.push(d);
        }
      } else if (freq === "MONTHLY") {
        const anchorMonth = new Date(first.getFullYear(), first.getMonth() + interval * p, 1);
        if (bydays.length === 0) {
          const d = new Date(anchorMonth);
          d.setDate(first.getDate());
          if (d.getMonth() === anchorMonth.getMonth()) insts.push(d); // 31 日钝化：无 31 日的月跳过
        } else {
          for (const { wd, ord } of bydays) {
            if (ord !== 0) {
              const d = nthWeekdayOfMonth(anchorMonth.getFullYear(), anchorMonth.getMonth(), wd, ord);
              if (d) insts.push(d);
            } else {
              // 无序号：当月每个该星期几。
              const days = new Date(anchorMonth.getFullYear(), anchorMonth.getMonth() + 1, 0).getDate();
              for (let dd = 1; dd <= days; dd++) {
                const c = new Date(anchorMonth.getFullYear(), anchorMonth.getMonth(), dd);
                if (c.getDay() === wd) insts.push(c);
              }
            }
          }
        }
      }
      insts.sort((a, b) => a.getTime() - b.getTime());
      if (insts.length > 0 && at0(insts[0]) > hardEnd) break;
      for (const inst of insts) {
        if (at0(inst) < at0(first)) continue; // DTSTART 之前不生成
        if (!emit(inst)) {
          stopped = true;
          break;
        }
      }
    }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function toIcs(
  ev: RawEvent,
  date: Date,
  timed: { date: Date; allDay: boolean } | null,
  durMs: number,
  alarmMin: number,
  rrule: string
): IcsEvent {
  // 结束时刻锚定开始时刻（timed 携带 DTSTART 的时分；跨天铺开的非首日
  // timed=null → 无 endTime）。此前锚定铺开日零点，首日 09:00+90min 会算成 01:30。
  const end = durMs > 0 ? new Date((timed ? timed.date : date).getTime() + durMs) : null;
  // RRULE 语义直译供导入（BYDAY/COUNT 无法精确映射时保守回退 none，避免导入后过度重复）。
  let repeat: IcsEvent["repeat"] = "none";
  let repeatEvery = 1;
  let repeatUntil = "";
  if (rrule) {
    const parts: Record<string, string> = {};
    for (const kv of rrule.split(";")) {
      const [k, v] = kv.split("=");
      if (k && v) parts[k.toUpperCase()] = v;
    }
    const freq = (parts.FREQ ?? "").toUpperCase();
    if (/DAILY|WEEKLY|MONTHLY|YEARLY/.test(freq) && !parts.BYDAY && !parts.COUNT) {
      repeat = freq === "DAILY" ? "daily" : freq === "WEEKLY" ? "weekly" : freq === "MONTHLY" ? "monthly" : "yearly";
      repeatEvery = Math.max(1, Number(parts.INTERVAL) || 1);
      if (parts.UNTIL) {
        const u = parseStamp("", parts.UNTIL);
        if (u) repeatUntil = iso(u.date);
      }
    }
  }
  return {
    uid: `${ev.uid}:${iso(date)}`,
    title: ev.summary || "（无标题）",
    location: ev.location,
    date: iso(date),
    time: timed && !timed.allDay ? hhmm(timed.date) : "",
    endTime: end && durMs < 24 * 3600 * 1000 && timed && !timed.allDay ? hhmm(end) : "",
    remind: alarmMin,
    repeat,
    repeatEvery,
    repeatUntil
  };
}

/* ------------------------------------------------------------------ */
/* 导出：本地日历事件 → VCALENDAR                                       */
/* ------------------------------------------------------------------ */

/** buildCalendarIcs 的输入事件（CalendarEvent 的结构化形状；避免反向依赖 widget 层）。 */
export type CalendarIcsSource = {
  id: string;
  text: string;
  /** HH:MM；空 = 全天。 */
  time: string;
  /** HH:MM；空 = 默认 60 分钟。 */
  endTime: string;
  repeat: string;
  repeatEvery: number;
  repeatUntil: string;
  excepted: string[];
  remind: number;
  location: string;
  note: string;
};

function icsEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 折行：每 74 字符续行（首行含属性名，总长 ≤75 octets 的近似）。 */
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const segs: string[] = [];
  for (let i = 0; i < line.length; i += 74) segs.push(line.slice(i, i + 74));
  return segs.join("\r\n ");
}

/** "HH:MM" → "HHMM00"（浮动本地时间戳）；非法返回 null。 */
function hhmmToStamp(v: string): string | null {
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, "0")}${m[2]}00` : null;
}

/** ISO 日期键 "2026-10-06" → "20261006"。 */
const isoKeyToCompact = (k: string) => k.replaceAll("-", "");

/**
 * 本地日历事件导出为标准 ICS（VCALENDAR）：重复 → RRULE（FREQ/INTERVAL/UNTIL）、
 * 单次例外 → EXDATE、提醒 → VALARM、地点/备注 → LOCATION/DESCRIPTION。
 * 全天事件用 VALUE=DATE（DTEND 次日，排他语义）；定时事件为浮动本地时间，
 * 无结束时间按 60 分钟导出。
 *
 * @param events - 锚点日期键 → 事件列表（EventMap 形状即可）。
 * @param calName - 日历名（X-WR-CALNAME）。
 * @returns ICS 文本（CRLF 行尾）。
 *
 * @example
 * ```ts
 * const ics = buildCalendarIcs(events, "我的日历");
 * ```
 */
export function buildCalendarIcs(
  events: Record<string, CalendarIcsSource[]>,
  calName = "Vela FocusDesk Calendar"
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vela FocusDesk//Calendar//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calName)}`
  ];
  const now = stamp(new Date());
  for (const key of Object.keys(events).sort()) {
    for (const ev of events[key] ?? []) {
      const compact = isoKeyToCompact(key);
      const allDay = !ev.time;
      const timePart = hhmmToStamp(ev.time);
      if (!allDay && !timePart) continue; // 非法时间戳不入导出
      lines.push("BEGIN:VEVENT", `UID:${ev.id}@focusdesk-calendar`, `DTSTAMP:${now}`);
      if (allDay) {
        const [y, m, d] = key.split("-").map(Number);
        const endDt = new Date(y, m - 1, d + 1); // 全天 DTEND 排他：次日
        lines.push(
          `DTSTART;VALUE=DATE:${compact}`,
          `DTEND;VALUE=DATE:${endDt.getFullYear()}${p2(endDt.getMonth() + 1)}${p2(endDt.getDate())}`
        );
      } else {
        lines.push(`DTSTART:${compact}T${timePart}`);
        const endPart = ev.endTime && ev.endTime > ev.time ? hhmmToStamp(ev.endTime) : null;
        if (endPart) {
          lines.push(`DTEND:${compact}T${endPart}`);
        } else {
          // 无结束时间：导出 60 分钟默认时长。
          const [hh, mm] = ev.time.split(":").map(Number);
          const endMin = hh * 60 + mm + 60;
          const endSt =
            endMin < 1440
              ? `${String(Math.floor(endMin / 60)).padStart(2, "0")}${String(endMin % 60).padStart(2, "0")}00`
              : null;
          if (endSt) lines.push(`DTEND:${compact}T${endSt}`);
        }
      }
      lines.push(`SUMMARY:${icsEscape(ev.text)}`);
      if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
      if (ev.note) lines.push(`DESCRIPTION:${icsEscape(ev.note)}`);
      if (ev.repeat && ev.repeat !== "none") {
        const freq = ev.repeat.toUpperCase();
        const every = ev.repeatEvery > 1 ? `;INTERVAL=${ev.repeatEvery}` : "";
        const until = ev.repeatUntil ? `;UNTIL=${isoKeyToCompact(ev.repeatUntil)}T235959` : "";
        lines.push(`RRULE:FREQ=${freq}${every}${until}`);
        if (ev.excepted.length > 0) {
          const prefix = allDay ? "" : "T000000";
          lines.push(
            `EXDATE${allDay ? ";VALUE=DATE" : ""}:${ev.excepted.map((d) => isoKeyToCompact(d) + prefix).join(",")}`
          );
        }
      }
      if (ev.remind > 0) {
        lines.push(
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          `TRIGGER:-PT${ev.remind}M`,
          `DESCRIPTION:${icsEscape(ev.text)}`,
          "END:VALARM"
        );
      }
      lines.push("END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  // 全量折行（此前仅 LOCATION/DESCRIPTION 折，长 SUMMARY 会超长）。
  return lines.map(foldLine).join("\r\n");
}

/**
 * 拉取订阅源并解析出窗口内事件。
 * 网络层走 {@link fetchText}（桌面端绕过 CORS）；解析失败向上抛错，
 * 由调用方在 UI 提示（如日历组件的错误角标）。
 *
 * @param url - ICS 订阅源地址（http/https）。
 * @param windowStart - 窗口起点（含）。
 * @param windowEnd - 窗口终点（含）。
 * @returns 窗口内事件数组。
 * @throws 网络/HTTP 错误原样抛出（fetchText 语义）。
 *
 * @example
 * ```ts
 * const events = await fetchIcsEvents(url, monthStart, monthEnd);
 * ```
 */
export async function fetchIcsEvents(url: string, windowStart: Date, windowEnd: Date): Promise<IcsEvent[]> {
  const text = await fetchText(url);
  return parseIcs(text, windowStart, windowEnd);
}
