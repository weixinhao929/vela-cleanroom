import { describe, expect, it } from "vitest";
import {
  buildIcs,
  draftConflicts,
  findConflicts,
  holidayKind,
  sessionsOnDate,
  weekHolidayMarks
} from "./timetable-extras";
import type { TimetableData, TimetableSession } from "./timetable";

const mk = (over: Partial<TimetableSession>): TimetableSession => ({
  id: over.id ?? crypto.randomUUID(),
  name: over.name ?? "测试课",
  rawName: over.rawName ?? over.name ?? "测试课",
  day: over.day ?? 1,
  startSection: over.startSection ?? 1,
  endSection: over.endSection ?? 2,
  weeks: over.weeks ?? [1, 2, 3],
  weeksLabel: over.weeksLabel ?? "1-3周",
  location: over.location ?? "",
  teacher: over.teacher ?? ""
});

describe("findConflicts", () => {
  it("detects same-day overlapping sections in shared weeks", () => {
    const a = mk({ name: "A", day: 1, startSection: 1, endSection: 2, weeks: [1, 2, 3] });
    const b = mk({ name: "B", day: 1, startSection: 2, endSection: 4, weeks: [2, 3, 4] });
    const conflicts = findConflicts([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].weeks).toEqual([2, 3]);
  });

  it("ignores same slot in disjoint weeks", () => {
    const a = mk({ day: 2, weeks: [1, 3, 5] });
    const b = mk({ day: 2, weeks: [2, 4] });
    expect(findConflicts([a, b])).toHaveLength(0);
  });

  it("ignores different days", () => {
    const a = mk({ day: 1 });
    const b = mk({ day: 2 });
    expect(findConflicts([a, b])).toHaveLength(0);
  });
});

describe("draftConflicts", () => {
  it("excludes the editing session itself", () => {
    const a = mk({ id: "keep", name: "A", day: 3, startSection: 1, endSection: 2, weeks: [1] });
    const b = mk({ id: "other", name: "B", day: 3, startSection: 2, endSection: 3, weeks: [1] });
    const clashes = draftConflicts(a, [a, b], "keep");
    expect(clashes.map((c) => c.id)).toEqual(["other"]);
  });
});

describe("sessionsOnDate", () => {
  const data: TimetableData = {
    // 2026-03-02 是周一。
    semesterStart: "2026-03-02",
    totalWeeks: 2,
    sessions: [
      mk({ id: "mon-early", name: "早课", day: 1, startSection: 1, endSection: 2, weeks: [1, 2], location: "教1-101" }),
      mk({ id: "mon-late", name: "晚课", day: 1, startSection: 11, endSection: 12, weeks: [1] }),
      mk({ id: "tue", name: "周二课", day: 2, startSection: 3, endSection: 4, weeks: [1, 2] })
    ],
    importedAt: 0
  };
  const starts = [
    "08:00",
    "08:55",
    "10:00",
    "10:55",
    "12:10",
    "13:05",
    "14:00",
    "14:55",
    "16:00",
    "16:55",
    "19:00",
    "19:55"
  ];
  const ends = [
    "08:45",
    "09:40",
    "10:45",
    "11:40",
    "12:55",
    "13:50",
    "14:45",
    "15:40",
    "16:45",
    "17:40",
    "19:45",
    "20:40"
  ];

  it("derives events with real clock times, sorted by start", () => {
    // 2026-03-02 周一第 1 周。
    const evts = sessionsOnDate(data, new Date(2026, 2, 2), starts, ends);
    expect(evts.map((e) => e.id)).toEqual(["mon-early:1", "mon-late:1"]);
    expect(evts[0]).toMatchObject({ start: "08:00", end: "09:40", location: "教1-101" });
    expect(evts[1].start).toBe("19:00");
  });

  it("matches day-of-week and week number", () => {
    // 2026-03-03 周二第 1 周 → 只有周二课；第 2 周（03-10）晚课已结课。
    expect(sessionsOnDate(data, new Date(2026, 2, 3), starts, ends).map((e) => e.id)).toEqual(["tue:1"]);
    const nextMon = sessionsOnDate(data, new Date(2026, 2, 9), starts, ends);
    expect(nextMon.map((e) => e.id)).toEqual(["mon-early:2"]);
  });

  it("rejects dates before the semester and beyond totalWeeks", () => {
    expect(sessionsOnDate(data, new Date(2026, 1, 23), starts, ends)).toEqual([]);
    expect(sessionsOnDate(data, new Date(2026, 2, 16), starts, ends)).toEqual([]);
  });

  it("falls back to start+45min end time when no end list is given", () => {
    const evts = sessionsOnDate(data, new Date(2026, 2, 3), ["", "", "10:00", "10:55"], []);
    expect(evts[0]).toMatchObject({ start: "10:00", end: "11:40" });
  });
});

describe("holidayKind", () => {
  it("knows 2026 holidays and makeup workdays", () => {
    expect(holidayKind("2026-01-01")).toBe("rest");
    expect(holidayKind("2026-10-01")).toBe("rest");
    expect(holidayKind("2026-02-28")).toBe("work");
    expect(holidayKind("2026-03-03")).toBeNull();
  });

  it("marks a normal teaching week as all null", () => {
    // semesterStart 2026-03-02 是周一；第 1 周无节假日。
    const marks = weekHolidayMarks("2026-03-02", 1);
    expect(marks).toHaveLength(7);
    expect(marks.every((m) => m === null)).toBe(true);
  });
});

describe("buildIcs", () => {
  it("emits one VEVENT per session-week with escaped text", () => {
    const data = {
      semesterStart: "2026-03-02",
      totalWeeks: 2,
      sessions: [
        mk({ name: "高数;习题课", day: 1, startSection: 1, endSection: 2, weeks: [1, 2], location: "教1-101" })
      ],
      importedAt: 0
    };
    const ics = buildIcs(data, ["08:00", "08:55", "10:00", "10:55"]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:高数\\;习题课@教1-101");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART:20260302T080000");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("skips weeks beyond totalWeeks", () => {
    const data = {
      semesterStart: "2026-03-02",
      totalWeeks: 1,
      sessions: [mk({ weeks: [1, 2, 3] })],
      importedAt: 0
    };
    expect(buildIcs(data, ["08:00", "08:55"]).match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
});
