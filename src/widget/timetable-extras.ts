import {
  addMinutesToTime,
  courseColor,
  DEFAULT_SECTION_TIMES,
  mondayOf,
  parseISODate,
  toISODate,
  weekMatches,
  type TimetableData,
  type TimetableSession
} from "./timetable";
import { remoteHoliday } from "../lib/holiday-update";

/* ------------------------------------------------------------------ */
/* 冲突检测                                                            */
/* ------------------------------------------------------------------ */

export type TimetableConflict = {
  a: TimetableSession;
  b: TimetableSession;
  day: number;
  weeks: number[];
};

const overlaps = (a1: number, a2: number, b1: number, b2: number): boolean => a1 <= b2 && b1 <= a2;

/** 两节课在给定周是否节次重叠。空周次 = 每周都上（weekMatches 口径）。 */
function sessionOverlaps(a: TimetableSession, b: TimetableSession): { day: number; weeks: number[] } | null {
  if (a.day !== b.day) return null;
  if (!overlaps(a.startSection, a.endSection, b.startSection, b.endSection)) return null;
  // 任一方空周次（= 每周）时，交叠周取另一方的周次表；双方都空 = 每周重叠
  //（weeks 为空数组仍算冲突，展示层把空数组理解为「每周」）。
  const weeks =
    a.weeks.length === 0 ? b.weeks : b.weeks.length === 0 ? a.weeks : a.weeks.filter((w) => b.weeks.includes(w));
  if (weeks.length === 0 && a.weeks.length > 0 && b.weeks.length > 0) return null;
  return { day: a.day, weeks };
}

/** 全表两两冲突检测（课程数通常 < 100，O(n²) 足够）。 */
export function findConflicts(sessions: TimetableSession[]): TimetableConflict[] {
  const out: TimetableConflict[] = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const hit = sessionOverlaps(sessions[i], sessions[j]);
      if (hit) out.push({ a: sessions[i], b: sessions[j], day: hit.day, weeks: hit.weeks });
    }
  }
  return out;
}

/** 草稿（未入库）与现有课的冲突，编辑时排除自身。 */
export function draftConflicts(
  draft: TimetableSession,
  sessions: TimetableSession[],
  selfId?: string
): TimetableSession[] {
  return sessions.filter((s) => s.id !== selfId && sessionOverlaps(draft, s));
}

/* ------------------------------------------------------------------ */
/* 日历同步派生                                                        */
/* ------------------------------------------------------------------ */

/** 某天的课程事件（含实际上下课时间），日历小组件按此渲染同步课程。 */
export type SyncedCourseEvent = {
  id: string;
  name: string;
  location: string;
  start: string;
  end: string;
  color: string;
};

/**
 * 课表在指定日期的课程事件，按开始时间排序。
 *
 * 注意：不能复用 weekNumberFor —— 它会把学期前/后的日期钳制进
 * [1, totalWeeks]，导致开学前的日期错误显示第 1 周的课。这里显式
 * 计算原始周号并拒绝越界日期。
 */
export function sessionsOnDate(
  data: TimetableData,
  date: Date,
  sectionTimes: string[],
  sectionTimesEnd: string[]
): SyncedCourseEvent[] {
  const start = parseISODate(data.semesterStart);
  if (!start) return [];
  // 与 weekNumberFor 同口径的 DST 修正：本地午夜差在 DST 切换周是 N*86400000
  // ±3600000，floor 会少一天、整周错档（此处此前漏改，仅 weekNumberFor 修过）。
  const days = Math.round((mondayOf(date).getTime() - mondayOf(start).getTime()) / 86400000);
  const week = Math.floor(days / 7) + 1;
  if (week < 1 || week > data.totalWeeks) return [];
  const day = ((date.getDay() + 6) % 7) + 1;
  const starts = sectionTimes.length ? sectionTimes : DEFAULT_SECTION_TIMES;
  const out: SyncedCourseEvent[] = [];
  for (const s of data.sessions) {
    if (s.day !== day || !weekMatches(s.weeks, week)) continue;
    const st = starts[s.startSection - 1] ?? starts[0] ?? "08:00";
    /* 结束时间优先用逐节结束表；缺失时与 ICS 导出同规则：
       最后一节的开始时间 + 45 分钟。 */
    const en = sectionTimesEnd[s.endSection - 1] || addMinutesToTime(starts[s.endSection - 1] ?? st, 45);
    out.push({
      id: `${s.id}:${week}`,
      name: s.name,
      location: s.location ?? "",
      start: st,
      end: en,
      color: courseColor(s.name)[0]
    });
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

/* ------------------------------------------------------------------ */
/* 今日课程时段（提醒 / 实时高亮共用） */
/* ------------------------------------------------------------------ */

export type TodayClassSlot = {
  session: TimetableSession;
  start: string;
  end: string;
  /** 自 00:00 的分钟数。 */
  startMin: number;
  endMin: number;
};

export function hhmmMinutes(t: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** 今天（按学期周次过滤）的全部课程，按开始时间排序；给提醒与实时高亮用。 */
export function todayClassSlots(
  data: TimetableData,
  sectionTimes: string[],
  sectionTimesEnd: string[],
  now: Date
): TodayClassSlot[] {
  const start = parseISODate(data.semesterStart);
  if (!start) return [];
  // 同 sessionsOnDate：round 吸收 DST 时区午夜差的 ±1h。
  const days = Math.round((mondayOf(now).getTime() - mondayOf(start).getTime()) / 86400000);
  const week = Math.floor(days / 7) + 1;
  if (week < 1 || week > data.totalWeeks) return [];
  const day = ((now.getDay() + 6) % 7) + 1;
  const starts = sectionTimes.length ? sectionTimes : DEFAULT_SECTION_TIMES;
  const out: TodayClassSlot[] = [];
  for (const s of data.sessions) {
    if (s.day !== day || !weekMatches(s.weeks, week)) continue;
    const st = starts[s.startSection - 1] ?? starts[0] ?? "08:00";
    const en = sectionTimesEnd[s.endSection - 1] || addMinutesToTime(starts[s.endSection - 1] ?? st, 45);
    out.push({ session: s, start: st, end: en, startMin: hhmmMinutes(st), endMin: hhmmMinutes(en) });
  }
  out.sort((a, b) => a.startMin - b.startMin);
  return out;
}

/* ------------------------------------------------------------------ */
/* 法定节假日（中国大陆，2025–2026）                                  */
/* ------------------------------------------------------------------ */

/** key = ISO 日期；value: rest=放假日，work=调休上班日。 */
const HOLIDAYS: Record<string, "rest" | "work"> = {
  // 2026（国务院 2025-11 发布版）
  "2026-01-01": "rest",
  "2026-01-02": "rest",
  "2026-01-03": "rest",
  "2026-02-15": "rest",
  "2026-02-16": "rest",
  "2026-02-17": "rest",
  "2026-02-18": "rest",
  "2026-02-19": "rest",
  "2026-02-20": "rest",
  "2026-02-21": "rest",
  "2026-02-22": "rest",
  "2026-02-28": "work",
  "2026-04-04": "rest",
  "2026-04-05": "rest",
  "2026-04-06": "rest",
  "2026-05-01": "rest",
  "2026-05-02": "rest",
  "2026-05-03": "rest",
  "2026-05-04": "rest",
  "2026-05-05": "rest",
  "2026-06-19": "rest",
  "2026-06-20": "rest",
  "2026-06-21": "rest",
  "2026-09-25": "rest",
  "2026-09-26": "rest",
  "2026-09-27": "rest",
  "2026-10-01": "rest",
  "2026-10-02": "rest",
  "2026-10-03": "rest",
  "2026-10-04": "rest",
  "2026-10-05": "rest",
  "2026-10-06": "rest",
  "2026-10-07": "rest",
  "2026-10-08": "rest",
  "2026-10-10": "work"
};

export function holidayKind(iso: string): "rest" | "work" | null {
  // 远程数据优先（内置表只到 2026，跨年靠在线更新补齐）。
  const remote = remoteHoliday(iso);
  if (remote) return remote.off ? "rest" : "work";
  return HOLIDAYS[iso] ?? null;
}

/** 某周（viewWeek）7 天的节假日标注：index 0=周一。 */
export function weekHolidayMarks(semesterStart: string, viewWeek: number): ("rest" | "work" | null)[] {
  const start = parseISODate(semesterStart);
  if (!start) return Array.from({ length: 7 }, () => null);
  const base = mondayOf(start);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + (viewWeek - 1) * 7 + i);
    return holidayKind(toISODate(d));
  });
}

/* ------------------------------------------------------------------ */
/* ICS 导出                                                            */
/* ------------------------------------------------------------------ */

const icsEscape = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const toIcsStamp = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}T` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}00`;

/** "HH:MM" → 自 00:00 的分钟数。 */
const hhmmToMin = (t: string): number => {
  const [h, m] = t.split(":").map((v) => Number(v));
  return (h || 0) * 60 + (m || 0);
};

export type IcsOptions = {
  /** 每节课的时长（分钟，默认 45）；节次时间表缺失节号时兜底。 */
  defaultDurationMin?: number;
};

/**
 * 课表 → .ics 文本。每节课按周展开为带 RRULE 之外的独立 VEVENT（学期
 * 周次常含单双周/区间，独立事件最直观，且量级 < 千级，日历可承受）。
 * 自定义节次结束时间（sectionTimesEnd）优先：末节结束时刻直接取表值，
 * 缺失才回退「末节开始 + 默认时长」。
 */
export function buildIcs(
  data: TimetableData,
  sectionTimes: string[],
  sectionTimesEnd: string[] = [],
  options: IcsOptions = {}
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vela FocusDesk//Timetable//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];
  const start = parseISODate(data.semesterStart);
  if (start) {
    const base = mondayOf(start);
    const duration = options.defaultDurationMin ?? 45;
    for (const s of data.sessions) {
      const startMin = sectionTimes[s.startSection - 1] ? hhmmToMin(sectionTimes[s.startSection - 1]) : 8 * 60;
      const endIdx = Math.min(s.endSection, sectionTimes.length) - 1;
      const customEnd = sectionTimesEnd[endIdx];
      const endMin = customEnd
        ? hhmmToMin(customEnd)
        : sectionTimes[endIdx] !== undefined
          ? hhmmToMin(sectionTimes[endIdx]) + duration
          : startMin + duration * (s.endSection - s.startSection + 1);
      // 审计修复：weeks=[] 的 UI 语义是"每周都上"（sessionsInWeek 同口径），
      // 手动加课允许留空周次——导出 ICS 必须展开为全部周，否则课程整体消失。
      const weekList = s.weeks.length ? s.weeks : Array.from({ length: data.totalWeeks }, (_, i) => i + 1);
      for (const w of weekList) {
        if (w < 1 || w > data.totalWeeks) continue;
        const day = new Date(base);
        day.setDate(base.getDate() + (w - 1) * 7 + (s.day - 1));
        const begin = new Date(day);
        begin.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
        const end = new Date(day);
        end.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
        const summary = s.name + (s.location ? `@${s.location}` : "");
        lines.push(
          "BEGIN:VEVENT",
          `UID:${s.id}-w${w}@vela-focusdesk`,
          `DTSTAMP:${toIcsStamp(new Date())}`,
          `DTSTART:${toIcsStamp(begin)}`,
          `DTEND:${toIcsStamp(end)}`,
          `SUMMARY:${icsEscape(summary)}`,
          s.location ? `LOCATION:${icsEscape(s.location)}` : "",
          s.teacher ? `DESCRIPTION:${icsEscape(`教师: ${s.teacher} 第${w}周`)}` : "",
          "END:VEVENT"
        );
      }
    }
  }
  lines.push("END:VCALENDAR");
  // CRLF 换行 + 去掉空行（条件字段为空字符串时）。
  return lines.filter((l) => l !== "").join("\r\n") + "\r\n";
}

/** 触发浏览器下载 .ics。 */
export function downloadIcs(data: TimetableData, sectionTimes: string[], sectionTimesEnd: string[] = []): void {
  const blob = new Blob([buildIcs(data, sectionTimes, sectionTimesEnd)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `timetable-${data.semesterStart}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}
