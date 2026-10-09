import { describe, expect, it } from "vitest";
import { buildCalendarIcs, parseIcs } from "./ics";

/**
 * ICS 解析回归：折行/转义、全天与定时、UTC 戳换算、跨天铺开（DTEND 排他）、
 * 窗口钳制、RRULE 展开（COUNT/INTERVAL/UNTIL）与排序。
 */
const win = (from: [number, number, number], to: [number, number, number]) => ({
  start: new Date(from[0], from[1] - 1, from[2]),
  end: new Date(to[0], to[1] - 1, to[2], 23, 59, 59)
});

function vcal(...events: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
}
function vevent(lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

describe("parseIcs · 基本字段", () => {
  it("定时事件：日期/起止时间/标题/地点/uid 按日期后缀", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    const out = parseIcs(
      vcal(vevent(["UID:abc", "SUMMARY:组会", "LOCATION:教1-101", "DTSTART:20260914T090000", "DTEND:20260914T103000"])),
      start,
      end
    );
    expect(out).toEqual([
      {
        uid: "abc:2026-09-14",
        title: "组会",
        location: "教1-101",
        date: "2026-09-14",
        time: "09:00",
        endTime: "10:30",
        remind: 0,
        repeat: "none",
        repeatEvery: 1,
        repeatUntil: ""
      }
    ]);
  });

  it("全天事件：time/endTime 为空", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    const out = parseIcs(
      vcal(vevent(["UID:d", "SUMMARY:假期", "DTSTART;VALUE=DATE:20260915", "DTEND;VALUE=DATE:20260916"])),
      start,
      end
    );
    expect(out).toEqual([
      {
        uid: "d:2026-09-15",
        title: "假期",
        location: "",
        date: "2026-09-15",
        time: "",
        endTime: "",
        remind: 0,
        repeat: "none",
        repeatEvery: 1,
        repeatUntil: ""
      }
    ]);
  });

  it("折行续接与转义序列还原；缺 SUMMARY 用占位标题", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:f",
      "SUMMARY:很长的标题\\, 带逗号",
      " 以及续行",
      "DTSTART:20260914T080000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:g",
      "DTSTART:20260914T090000",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    const out = parseIcs(text, start, end);
    expect(out.map((e) => e.title)).toEqual(["很长的标题, 带逗号以及续行", "（无标题）"]);
  });

  it("带 Z 的 UTC 时间戳换算成本地时间", () => {
    const { start, end } = win([2026, 9, 10], [2026, 9, 20]);
    const out = parseIcs(vcal(vevent(["UID:z", "SUMMARY:远程会", "DTSTART:20260914T010000Z"])), start, end);
    const local = new Date(Date.UTC(2026, 8, 14, 1, 0, 0));
    const hh = String(local.getHours()).padStart(2, "0");
    const mm = String(local.getMinutes()).padStart(2, "0");
    expect(out).toHaveLength(1);
    expect(out[0].time).toBe(`${hh}:${mm}`);
  });

  it("没有 DTSTART 的事件被跳过；无 VEVENT 返回空", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    expect(parseIcs(vcal(vevent(["UID:x", "SUMMARY:坏事件"])), start, end)).toEqual([]);
    expect(parseIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR", start, end)).toEqual([]);
  });
});

describe("parseIcs · 跨天与窗口", () => {
  it("全天多日事件按 DTEND 排他铺开（Google 单日全天 = DTSTART 当天 / DTEND 次日）", () => {
    const { start, end } = win([2026, 9, 1], [2026, 9, 30]);
    const out = parseIcs(
      vcal(vevent(["UID:m", "SUMMARY:出差", "DTSTART;VALUE=DATE:20260914", "DTEND;VALUE=DATE:20260917"])),
      start,
      end
    );
    expect(out.map((e) => e.date)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
    expect(out.map((e) => e.uid)).toEqual(["m:2026-09-14", "m:2026-09-15", "m:2026-09-16"]);
  });

  it("定时多日事件：首日带开始时间，后续天不带；超 24h 不显示结束时间", () => {
    const { start, end } = win([2026, 9, 1], [2026, 9, 30]);
    const out = parseIcs(
      vcal(vevent(["UID:t", "SUMMARY:研讨会", "DTSTART:20260914T090000", "DTEND:20260916T170000"])),
      start,
      end
    );
    expect(out.map((e) => [e.date, e.time, e.endTime])).toEqual([
      ["2026-09-14", "09:00", ""],
      ["2026-09-15", "", ""],
      ["2026-09-16", "", ""]
    ]);
  });

  it("早于窗口开始的长事件从窗口起点铺开，窗口外日期不产出", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 16]);
    const out = parseIcs(
      vcal(vevent(["UID:l", "SUMMARY:长期", "DTSTART;VALUE=DATE:20260901", "DTEND;VALUE=DATE:20261001"])),
      start,
      end
    );
    expect(out.map((e) => e.date)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
  });

  it("完全落在窗口外的事件不产出", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    expect(
      parseIcs(vcal(vevent(["UID:o", "SUMMARY:过去", "DTSTART:20260901T090000", "DTEND:20260901T100000"])), start, end)
    ).toEqual([]);
  });
});

describe("parseIcs · RRULE", () => {
  it("WEEKLY + COUNT 展开固定次数", () => {
    const { start, end } = win([2026, 9, 1], [2026, 10, 31]);
    const out = parseIcs(
      vcal(
        vevent([
          "UID:w",
          "SUMMARY:周会",
          "DTSTART:20260914T100000",
          "DTEND:20260914T110000",
          "RRULE:FREQ=WEEKLY;COUNT=3"
        ])
      ),
      start,
      end
    );
    expect(out.map((e) => e.date)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(out.every((e) => e.time === "10:00" && e.endTime === "11:00")).toBe(true);
  });

  it("DAILY + INTERVAL=2 只落在隔天，且不越过 UNTIL", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 30]);
    const out = parseIcs(
      vcal(
        vevent(["UID:dl", "SUMMARY:隔天", "DTSTART;VALUE=DATE:20260914", "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260919"])
      ),
      start,
      end
    );
    expect(out.map((e) => e.date)).toEqual(["2026-09-14", "2026-09-16", "2026-09-18"]);
  });

  it("重复实例只产出落在窗口内的那些（DTSTART 早于窗口时回看推进）", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    const out = parseIcs(
      vcal(vevent(["UID:b", "SUMMARY:每周", "DTSTART:20260601T090000", "RRULE:FREQ=WEEKLY"])),
      start,
      end
    );
    expect(out.map((e) => e.date)).toEqual(["2026-09-14"]); // 6-1 起每周一，窗口内只有 9-14
  });

  it("不支持的 FREQ 整条跳过", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    expect(
      parseIcs(vcal(vevent(["UID:h", "SUMMARY:每小时", "DTSTART:20260914T090000", "RRULE:FREQ=HOURLY"])), start, end)
    ).toEqual([]);
  });
});

describe("parseIcs · 排序", () => {
  it("按日期再按时间升序，全天（空 time）排在当天最前", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    const out = parseIcs(
      vcal(
        vevent(["UID:1", "SUMMARY:晚", "DTSTART:20260915T180000"]),
        vevent(["UID:2", "SUMMARY:早", "DTSTART:20260914T080000"]),
        vevent(["UID:3", "SUMMARY:全天", "DTSTART;VALUE=DATE:20260915"]),
        vevent(["UID:4", "SUMMARY:午", "DTSTART:20260915T120000"])
      ),
      start,
      end
    );
    expect(out.map((e) => e.title)).toEqual(["早", "全天", "午", "晚"]);
  });
});

describe("parseIcs · BYDAY / EXDATE / VALARM", () => {
  it("WEEKLY + BYDAY=MO,WE 每周展开两个星期几（DTSTART 之前不生成）", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 27]);
    const out = parseIcs(
      vcal(vevent(["UID:bd", "SUMMARY:双日课", "DTSTART:20260916T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"])),
      start,
      end
    );
    // DTSTART 周三 9-16；所在周周一 9-14 早于 DTSTART 不生成。
    expect(out.map((e) => e.date)).toEqual(["2026-09-16", "2026-09-21", "2026-09-23"]);
  });

  it("MONTHLY + BYDAY=2TU 展开每月第二个周二", () => {
    const { start, end } = win([2026, 9, 1], [2026, 10, 31]);
    const out = parseIcs(
      vcal(vevent(["UID:m2", "SUMMARY:月度会", "DTSTART:20260908T090000", "RRULE:FREQ=MONTHLY;BYDAY=2TU"])),
      start,
      end
    );
    expect(out.map((e) => e.date)).toEqual(["2026-09-08", "2026-10-13"]); // 9 月第 2 个周二=8 日，10 月=13 日
  });

  it("EXDATE 排除单次实例（DATE 与 DATETIME 两种写法）", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 30]);
    const out = parseIcs(
      vcal(
        vevent([
          "UID:ex",
          "SUMMARY:周课",
          "DTSTART:20260914T080000",
          "RRULE:FREQ=WEEKLY;COUNT=3",
          "EXDATE;VALUE=DATE:20260921",
          "EXDATE:20260928T080000"
        ])
      ),
      start,
      end
    );
    expect(out.map((e) => e.date)).toEqual(["2026-09-14"]); // 后两场都被排除
  });

  it("VALARM TRIGGER 折算提前提醒分钟（正值/畸形视为无）", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 20]);
    const out = parseIcs(
      vcal(
        vevent([
          "UID:va",
          "SUMMARY:带提醒",
          "DTSTART:20260915T090000",
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          "TRIGGER:-PT30M",
          "END:VALARM"
        ]),
        vevent(["UID:vb", "SUMMARY:坏提醒", "DTSTART:20260915T100000", "BEGIN:VALARM", "TRIGGER:PT15M", "END:VALARM"]),
        vevent(["UID:vc", "SUMMARY:天级提醒", "DTSTART:20260915T110000", "BEGIN:VALARM", "TRIGGER:-P1D", "END:VALARM"])
      ),
      start,
      end
    );
    expect(out.find((e) => e.uid.startsWith("va"))?.remind).toBe(30);
    expect(out.find((e) => e.uid.startsWith("vb"))?.remind).toBe(0);
    expect(out.find((e) => e.uid.startsWith("vc"))?.remind).toBe(1440);
  });

  it("RRULE 语义直译：无 BYDAY/COUNT 时映射 repeat/interval/until", () => {
    const { start, end } = win([2026, 9, 14], [2026, 9, 30]);
    const out = parseIcs(
      vcal(
        vevent(["UID:tr", "SUMMARY:双周", "DTSTART:20260914T090000", "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261001"])
      ),
      start,
      end
    );
    expect(out[0]).toMatchObject({ repeat: "weekly", repeatEvery: 2, repeatUntil: "2026-10-01" });
    // 带 BYDAY 的规则导入语义保守回退 none（避免导入后过度重复）。
    const byday = parseIcs(
      vcal(vevent(["UID:tb", "SUMMARY:BYDAY", "DTSTART:20260916T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"])),
      start,
      end
    );
    expect(byday[0].repeat).toBe("none");
  });
});

describe("buildCalendarIcs · 导出", () => {
  const ev = (p: Partial<Parameters<typeof buildCalendarIcs>[0][string][number]>) => ({
    id: "x",
    text: "事件",
    time: "09:00",
    endTime: "",
    repeat: "none",
    repeatEvery: 1,
    repeatUntil: "",
    excepted: [],
    remind: 0,
    location: "",
    note: "",
    ...p
  });

  it("定时事件：DTSTART/DTEND 浮动时间；全天：VALUE=DATE 且 DTEND 次日", () => {
    const ics = buildCalendarIcs({
      "2026-09-14": [ev({ id: "t1", text: "定时", time: "09:00", endTime: "10:30" })],
      "2026-09-15": [ev({ id: "a1", text: "全天", time: "" })]
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20260914T090000");
    expect(ics).toContain("DTEND:20260914T103000");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260915");
    expect(ics).toContain("DTEND;VALUE=DATE:20260916"); // 排他次日
    expect(ics).toContain("SUMMARY:定时");
    expect(ics).toContain("SUMMARY:全天");
  });

  it("重复/例外/提醒全量映射：RRULE + EXDATE + VALARM", () => {
    const ics = buildCalendarIcs({
      "2026-09-14": [
        ev({
          id: "r1",
          text: "双周会",
          time: "14:00",
          endTime: "15:00",
          repeat: "weekly",
          repeatEvery: 2,
          repeatUntil: "2026-12-31",
          excepted: ["2026-09-28"],
          remind: 15,
          location: "A 栋",
          note: "带\\;分号"
        })
      ]
    });
    expect(ics).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T235959");
    expect(ics).toContain("EXDATE:20260928T000000");
    expect(ics).toContain("TRIGGER:-PT15M");
    expect(ics).toContain("LOCATION:A 栋");
    expect(ics).toContain("DESCRIPTION:带\\\\\\;分号"); // 源 `\;`（1 反斜杠）→ 转义后 `\\` + `\;`（3 反斜杠）
  });

  it("导出 → parseIcs 往返：重复/例外/提醒语义保留", () => {
    const ics = buildCalendarIcs({
      "2026-09-14": [ev({ id: "rt", text: "每周", time: "10:00", endTime: "11:00", repeat: "weekly", remind: 30 })]
    });
    const back = parseIcs(ics, new Date(2026, 8, 14), new Date(2026, 8, 27));
    expect(back.map((e) => e.date)).toEqual(["2026-09-14", "2026-09-21"]);
    expect(back[0]).toMatchObject({ time: "10:00", endTime: "11:00", remind: 30, repeat: "weekly" });
  });

  it("长行折行（≤74 字符续行）与 CRLF 行尾", () => {
    const ics = buildCalendarIcs({
      "2026-09-14": [ev({ id: "long", text: "很长的标题".repeat(30) })]
    });
    const lines = ics.split("\r\n");
    expect(lines.every((l) => l.length <= 75)).toBe(true);
    expect(ics).toContain("\r\n ");
  });
});

/**
 * （R-前端-2 同型）：RRULE 展开的 600 周期配额此前从 DTSTART 起数——
 * daily 系列距窗口起点超约 20 个月即在抵达窗口前烧光配额，订阅面静默丢失。
 * 修复后配额窗口相对（p0 + 600），且 COUNT 仍从 DTSTART 精确计数。
 */
describe("parseIcs · WD-2 周期配额窗口相对化", () => {
  it("DTSTART 早于窗口起点约 2 年的 daily 系列：窗口内实例正常展开（不再静默丢失）", () => {
    const { start, end } = win([2026, 10, 1], [2026, 10, 31]);
    const out = parseIcs(
      vcal(vevent(["UID:old-daily", "SUMMARY:每日打卡", "DTSTART:20240101T090000", "RRULE:FREQ=DAILY"])),
      start,
      end
    );
    // 2024-01-01 → 窗口起点约 33 个月 > 600 天：修复前此处为空数组。
    expect(out.length).toBe(31);
    expect(out[0]).toMatchObject({ date: "2026-10-01", time: "09:00" });
    expect(out[30]).toMatchObject({ date: "2026-10-31" });
  });

  it("COUNT 从 DTSTART 精确计数（预跳不改变 COUNT 语义）：早期 COUNT=3 系列不进窗口", () => {
    const { start, end } = win([2026, 10, 1], [2026, 10, 31]);
    const out = parseIcs(
      vcal(vevent(["UID:cnt", "SUMMARY:三次课", "DTSTART:20240101T090000", "RRULE:FREQ=DAILY;COUNT=3"])),
      start,
      end
    );
    expect(out).toEqual([]);
  });

  it("weekly 长龄系列同样覆盖（600 周 ≈ 11.5 年，正常路径不回归）", () => {
    const { start, end } = win([2026, 10, 1], [2026, 10, 31]);
    const out = parseIcs(
      vcal(vevent(["UID:old-weekly", "SUMMARY:周会", "DTSTART:20100104T090000", "RRULE:FREQ=WEEKLY"])),
      start,
      end
    );
    // 2010 年起的每周一：2026 年 10 月有 4 个周一（5/12/19/26）。
    expect(out.length).toBe(4);
    expect(out.every((o) => new Date(o.date).getDay() === 1)).toBe(true);
  });
});
