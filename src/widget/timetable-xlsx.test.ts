import { describe, it, expect } from "vitest";
import { buildTimetableXlsx } from "./timetable-xlsx";
import type { TimetableData } from "./timetable";

const SAMPLE: TimetableData = {
  semesterStart: "2026-09-01",
  totalWeeks: 16,
  importedAt: Date.now(),
  sessions: [
    {
      id: "a",
      name: "高等数学",
      rawName: "高等数学",
      day: 1,
      startSection: 1,
      endSection: 2,
      weeks: [1, 2, 3, 4, 5],
      weeksLabel: "1-5周",
      location: "教2-101",
      teacher: "张老师"
    },
    {
      id: "b",
      name: "大学英语",
      rawName: "大学英语",
      day: 3,
      startSection: 3,
      endSection: 3,
      weeks: [1, 2, 3, 4, 5],
      weeksLabel: "1-5周",
      location: "教3-205",
      teacher: "李老师"
    }
  ]
};

/** 解析 STORED zip：返回条目的本地文件头 + 数据，用于断言内容。 */
function parseStoredZip(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; data: Uint8Array }[] = [];
  let p = 0;
  // 顺序读取本地文件头（STORED 无压缩，紧凑相邻）。
  while (p + 30 <= bytes.length) {
    const sig = dv.getUint32(p, true);
    if (sig !== 0x04034b50) break;
    const method = dv.getUint16(p + 8, true);
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.slice(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    out.push({ name, data: bytes.slice(dataStart, dataStart + compSize) });
    p = dataStart + compSize;
    void method;
  }
  return out;
}

describe("timetable-xlsx (F4)", () => {
  it("生成有效的 xlsx zip 结构（含必填部件）", () => {
    const bytes = buildTimetableXlsx(SAMPLE, ["08:00", "08:55"], 1);
    // xlsx 必须以 PK 头开始（zip 魔数）。
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const entries = parseStoredZip(bytes);
    const names = entries.map((e) => e.name);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/worksheets/sheet1.xml");
    expect(names).toContain("xl/worksheets/sheet2.xml");
  });

  it("「课程列表」工作表包含课程名与地点", () => {
    const bytes = buildTimetableXlsx(SAMPLE, ["08:00", "08:55"], 1);
    const entries = parseStoredZip(bytes);
    const sheet = entries.find((e) => e.name === "xl/worksheets/sheet1.xml")!;
    const xml = new TextDecoder().decode(sheet.data);
    expect(xml).toContain("高等数学");
    expect(xml).toContain("教2-101");
    expect(xml).toContain("星期三");
  });

  it("「周视图」工作表按当前周生成网格并含日期", () => {
    const bytes = buildTimetableXlsx(SAMPLE, ["08:00", "08:55"], 1);
    const entries = parseStoredZip(bytes);
    const sheet = entries.find((e) => e.name === "xl/worksheets/sheet2.xml")!;
    const xml = new TextDecoder().decode(sheet.data);
    // 第 1 周周一 = 2026-09-01 → 表头含 9/1。
    expect(xml).toContain("9/1");
    // 课程单元格应出现在周视图。
    expect(xml).toContain("高等数学");
  });

  it("「汇总」工作表包含学期与课程数", () => {
    const bytes = buildTimetableXlsx(SAMPLE, ["08:00", "08:55"], 1);
    const entries = parseStoredZip(bytes);
    const sheet = entries.find((e) => e.name === "xl/worksheets/sheet3.xml")!;
    const xml = new TextDecoder().decode(sheet.data);
    expect(xml).toContain("2026-09-01");
    expect(xml).toContain("16");
  });

  it("空课表也能生成（不抛异常）", () => {
    const empty: TimetableData = { semesterStart: "2026-09-01", totalWeeks: 16, importedAt: 0, sessions: [] };
    const bytes = buildTimetableXlsx(empty, ["08:00"], 1);
    expect(bytes.length).toBeGreaterThan(0);
    const entries = parseStoredZip(bytes);
    expect(entries.length).toBe(7);
  });
});
