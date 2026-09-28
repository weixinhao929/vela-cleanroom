/**
 * W-016 ICS 日历订阅（只读）。
 *
 * 支持 Google Calendar / Outlook 导出的 .ics 订阅链接：
 *  - VEVENT 的 SUMMARY / DTSTART / DTEND / LOCATION；
 *  - 全天事件（DTSTART;VALUE=DATE）与定时事件（浮动本地时间，桌面场景
 *    与本机同时区一致即可）；
 *  - 简单 RRULE（DAILY/WEEKLY/MONTHLY/YEARLY，含 INTERVAL/UNTIL/COUNT）
 *    在展开窗口内实例化；BYDAY 等复杂规则按基础频率近似展开。
 * 时区（VTIMEZONE）不解析 —— 绝大多数订阅源的浮动时间即为本地时间。
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
};

/** ICS 折行（CRLF + 空格续行）展开为逻辑行。 */
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

/** NAME;PARAM=a:b → { name, value }（参数丢弃，值里的冒号保留）。 */
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

/** 解析 DTSTART/DTEND：DATE（全天）或浮动本地时间；带 Z 的按本地时区换算。 */
function parseStamp(params: string, value: string): { date: Date; allDay: boolean } | null {
  if (/VALUE=DATE/i.test(params) || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
    if (!m) return null;
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (m[7] === "Z") {
    return { date: new Date(d.getTime() - d.getTimezoneOffset() * 60000), allDay: false };
  }
  return { date: d, allDay: false };
}

const hhmm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

type RawEvent = {
  uid: string;
  summary: string;
  location: string;
  start: { date: Date; allDay: boolean } | null;
  end: { date: Date; allDay: boolean } | null;
  rrule: string;
};

/** 单次推进一个重复实例（月/年按日历语义：1月31日月推 → 2月28日）。 */
function advance(base: Date, freq: string, interval: number, step: number): Date {
  const d = new Date(base);
  if (freq === "DAILY") d.setDate(d.getDate() + interval * step);
  else if (freq === "WEEKLY") d.setDate(d.getDate() + 7 * interval * step);
  else if (freq === "MONTHLY") d.setMonth(d.getMonth() + interval * step);
  else d.setFullYear(d.getFullYear() + interval * step);
  return d;
}

/**
 * 解析 ICS 文本，展开时间窗口内的全部事件实例（含 RRULE 重复）。
 * 支持 DAILY/WEEKLY/MONTHLY/YEARLY × INTERVAL、DATE 全天与浮动本地时间；
 * 跨天事件按天铺开；畸形源（DTSTART 早于窗口数年）通过起点钳制 + 铺开
 * 上限防御（P1 审计修复）。复杂度 O(events × 窗口内实例数)。
 *
 * @param text - ICS 原文（VCALENDAR/VEVENT 结构）。
 * @param windowStart - 窗口起点（含）。
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
  for (const line of unfold(text)) {
    const prop = splitProp(line);
    if (!prop) continue;
    const { name, params, value } = prop;
    if (name === "BEGIN" && value.trim().toUpperCase() === "VEVENT") {
      cur = { uid: "", summary: "", location: "", start: null, end: null, rrule: "" };
    } else if (name === "END" && value.trim().toUpperCase() === "VEVENT") {
      if (cur && cur.start) events.push(cur);
      cur = null;
    } else if (cur) {
      if (name === "UID") cur.uid = value.trim();
      else if (name === "SUMMARY") cur.summary = unescapeText(value);
      else if (name === "LOCATION") cur.location = unescapeText(value);
      else if (name === "DTSTART") cur.start = parseStamp(params, value);
      else if (name === "DTEND") cur.end = parseStamp(params, value);
      else if (name === "RRULE") cur.rrule = value.trim();
    }
  }

  const out: IcsEvent[] = [];
  for (const ev of events) {
    if (!ev.start) continue;
    const durMs = ev.end ? ev.end.date.getTime() - ev.start.date.getTime() : 0;

    // 无重复：按日期判断是否落在窗口内（跨天事件按天铺开）。
    // P1（审计修复）：此前循环从 DTSTART 起逐天推进且 `d >= windowStart ||
    // dayEnd >= windowStart` 恒真（只要事件结束于窗口开始之后），2020 年开始
    // 的长事件会展开出数千条灌进日历，畸形订阅源可用 DTSTART:19700101 制造
    // 数万次迭代。修复：把起点直接钳制到窗口内（保留跨入窗口首日的铺开），
    // 并对单事件铺开天数设上限。
    if (!ev.rrule) {
      const dayEnd = new Date(ev.end?.date ?? ev.start.date);
      // RFC 5545：全天事件的 DTEND 是排他的（Google 导出的单日全天事件即
      // DTSTART=当天、DTEND=次日），按含端点铺开会让每个全天事件多显示一天。
      if (ev.end?.allDay && ev.end.date > ev.start.date) dayEnd.setDate(dayEnd.getDate() - 1);
      const firstDay = ev.start.date > windowStart ? new Date(ev.start.date) : new Date(windowStart);
      let spread = 0;
      for (let d = firstDay; d <= dayEnd && d <= windowEnd && spread < 400; d.setDate(d.getDate() + 1)) {
        const isStart = d.toDateString() === ev.start.date.toDateString();
        out.push(toIcs(ev, d, isStart ? ev.start : null, durMs));
        spread++;
      }
      continue;
    }

    // RRULE：FREQ / INTERVAL / UNTIL / COUNT。UNTIL 为日期戳或时间戳。
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
      if (parsed) until = parsed.date;
    }
    const hardEnd = until && until < windowEnd ? until : windowEnd;

    const first = ev.start.date;
    // 从 DTSTART 起按间隔推进；为覆盖窗口起点，最多回看 500 个实例。
    let step = 0;
    let hit = 0;
    while (step < 500 + hit) {
      const inst = step === 0 ? first : advance(first, freq, interval, step);
      if (inst > hardEnd) break;
      if (inst >= windowStart && inst <= hardEnd) {
        out.push(toIcs(ev, inst, ev.start, durMs));
      }
      step++;
      hit++;
      if (hit >= count) break;
    }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function toIcs(ev: RawEvent, date: Date, timed: { date: Date; allDay: boolean } | null, durMs: number): IcsEvent {
  const end = durMs > 0 ? new Date(date.getTime() + durMs) : null;
  return {
    uid: `${ev.uid}:${iso(date)}`,
    title: ev.summary || "（无标题）",
    location: ev.location,
    date: iso(date),
    time: timed && !timed.allDay ? hhmm(timed.date) : "",
    endTime: end && durMs < 24 * 3600 * 1000 && timed && !timed.allDay ? hhmm(end) : ""
  };
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
