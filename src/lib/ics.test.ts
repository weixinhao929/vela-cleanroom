import { describe, expect, it } from "vitest";
import { parseIcs } from "./ics";

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
      { uid: "abc:2026-09-14", title: "组会", location: "教1-101", date: "2026-09-14", time: "09:00", endTime: "10:30" }
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
      { uid: "d:2026-09-15", title: "假期", location: "", date: "2026-09-15", time: "", endTime: "" }
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
