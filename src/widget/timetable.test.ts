import { describe, it, expect } from "vitest";
import {
  cleanCourseName,
  courseColor,
  formatWeeks,
  inferTotalWeeks,
  mondayOf,
  parseCellText,
  parseDayToken,
  parseSectionBand,
  parseTimetableRows,
  parseWeeksLabel,
  rawWeekNumber,
  sanitizeTimetableData,
  sessionsInWeek,
  toISODate,
  weekNumberFor
} from "./timetable";

describe("parseDayToken", () => {
  it("maps Chinese and numeric tokens", () => {
    expect(parseDayToken("星期二")).toBe(2);
    expect(parseDayToken("周三")).toBe(3);
    expect(parseDayToken("礼拜日")).toBe(7);
    expect(parseDayToken("5")).toBe(5);
  });

  it("returns null for unknown tokens", () => {
    expect(parseDayToken("")).toBeNull();
    expect(parseDayToken("节")).toBeNull();
  });
});

describe("全角输入 NFKC 归一化", () => {
  it("parseDayToken 接受全角数字（星期２）", () => {
    expect(parseDayToken("星期２")).toBe(2);
    expect(parseDayToken("周７")).toBe(7);
  });

  it("parseWeeksLabel 接受全角数字与单双后缀", () => {
    expect(parseWeeksLabel("１６周")).toEqual([16]);
    expect(parseWeeksLabel("１-８双")).toEqual([2, 4, 6, 8]);
  });

  it("parseSectionBand 接受全角数字", () => {
    expect(parseSectionBand("第３节")).toEqual({ start: 3, end: 3 });
    expect(parseSectionBand("第１节－第２节")).toEqual({ start: 1, end: 2 });
  });

  it("parseCellText 全角时段文本可解析出完整字段", () => {
    const segs = parseCellText("高等数学 星期２ 第１节-第２节 教1-101");
    expect(segs).toHaveLength(1);
    expect(segs[0].day).toBe(2);
    expect(segs[0].startSection).toBe(1);
    expect(segs[0].endSection).toBe(2);
    expect(segs[0].location).toBe("教1-101");
  });
});

describe("parseWeeksLabel", () => {
  it("expands ranges, lists, and parity", () => {
    expect(parseWeeksLabel("4-8周")).toEqual([4, 5, 6, 7, 8]);
    expect(parseWeeksLabel("1-16单")).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(parseWeeksLabel("1-16双")).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(parseWeeksLabel("1-3,5-6周")).toEqual([1, 2, 3, 5, 6]);
    expect(parseWeeksLabel("16周")).toEqual([16]);
  });

  it("clamps to maxWeek and rejects garbage", () => {
    expect(parseWeeksLabel("1-100周", 20)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20
    ]);
    expect(parseWeeksLabel("abc")).toEqual([]);
    expect(parseWeeksLabel("")).toEqual([]);
  });
});

describe("formatWeeks", () => {
  it("compacts consecutive weeks", () => {
    expect(formatWeeks([4, 5, 6, 7, 8])).toBe("4-8周");
    expect(formatWeeks([1, 3, 5])).toBe("1,3,5周");
    expect(formatWeeks([])).toBe("");
  });
});

describe("cleanCourseName", () => {
  it("strips course codes and section suffixes", () => {
    expect(cleanCourseName("ae22652013-电子测量原理[01]")).toBe("电子测量原理");
    expect(cleanCourseName("高等数学")).toBe("高等数学");
  });
});

describe("parseSectionBand", () => {
  it("parses bands from row labels", () => {
    expect(parseSectionBand("第1节-第2节")).toEqual({ start: 1, end: 2 });
    expect(parseSectionBand("3-4节")).toEqual({ start: 3, end: 4 });
    expect(parseSectionBand("第5节")).toEqual({ start: 5, end: 5 });
    expect(parseSectionBand("午休")).toBeNull();
  });
});

describe("parseCellText", () => {
  it("parses the composite Wakeup-style cell", () => {
    const segs = parseCellText("ae22652013-电子测量原理[01] 4-8周,星期2,第1节-第2节 朝阳-实验楼-200");
    expect(segs).toHaveLength(1);
    expect(segs[0].name).toBe("电子测量原理");
    expect(segs[0].day).toBe(2);
    expect(segs[0].startSection).toBe(1);
    expect(segs[0].endSection).toBe(2);
    expect(segs[0].weeksLabel).toBe("4-8周");
    expect(segs[0].location).toContain("实验楼");
  });

  it("splits two segments in one cell and reuses the course name", () => {
    const segs = parseCellText("大学物理 1-8周,星期1,第1节-第2节 教1-101, 9-16周,星期1,第1节-第2节 教1-202");
    expect(segs).toHaveLength(2);
    expect(segs[0].name).toBe("大学物理");
    expect(segs[1].name).toBe("大学物理");
    expect(segs[0].location).toBe("教1-101");
    expect(segs[1].location).toBe("教1-202");
  });

  it("falls back to grid coordinates when the cell only has a name", () => {
    const segs = parseCellText("大学英语", { fallbackDay: 3, fallbackStart: 5, fallbackEnd: 6 });
    expect(segs).toHaveLength(1);
    expect(segs[0].day).toBe(3);
    expect(segs[0].startSection).toBe(5);
    expect(segs[0].endSection).toBe(6);
  });

  it("returns empty for blank text", () => {
    expect(parseCellText("")).toEqual([]);
    expect(parseCellText("  ")).toEqual([]);
  });
});

describe("parseTimetableRows", () => {
  it("parses a grid timetable with header row and section labels", () => {
    const rows = [
      ["2026 春季课表", "", "", "", "", "", "", ""],
      ["节次", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"],
      ["第1节-第2节", "高等数学 1-16周", "", "大学英语", "", "", "", ""],
      ["第3节-第4节", "", "C语言 1-8周, 星期2, 第3节-第4节 实验楼301", "", "", "", "", ""]
    ];
    const { sessions, mode } = parseTimetableRows(rows);
    expect(mode).toBe("grid");
    expect(sessions).toHaveLength(3);
    const math = sessions.find((s) => s.name === "高等数学")!;
    expect(math.day).toBe(1);
    expect(math.startSection).toBe(1);
    expect(math.endSection).toBe(2);
    expect(math.weeks).toEqual(parseWeeksLabel("1-16周"));
    const c = sessions.find((s) => s.name === "C语言")!;
    expect(c.day).toBe(2);
    expect(c.location).toBe("实验楼301");
  });

  it("parses a list timetable via column synonyms", () => {
    const rows = [
      ["课程名称", "星期", "开始节次", "结束节次", "周次", "教室", "教师"],
      ["数据结构", "周一", "3", "4", "1-16周", "A-201", "张老师"],
      ["操作系统", "周三", "1", "2", "1-8,10-16周", "B-105", "李老师"],
      ["", "", "", "", "", "", ""]
    ];
    const { sessions, mode } = parseTimetableRows(rows);
    expect(mode).toBe("list");
    expect(sessions).toHaveLength(2);
    expect(sessions[0].name).toBe("数据结构");
    expect(sessions[0].day).toBe(1);
    expect(sessions[0].startSection).toBe(3);
    expect(sessions[0].endSection).toBe(4);
    expect(sessions[0].teacher).toBe("张老师");
    expect(sessions[1].location).toBe("B-105");
  });

  it("returns empty for unrelated tables", () => {
    expect(parseTimetableRows([["hello", "world"]]).sessions).toEqual([]);
    expect(parseTimetableRows([]).sessions).toEqual([]);
  });

  it("dedupes identical rows from merged-cell duplication", () => {
    const rows = [
      ["节次", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"],
      ["第1节", "体育", "体育", "体育", "体育", "体育", "", ""]
    ];
    // 同名同格数据保留一次；跨列是不同 day 不算重复。
    const { sessions } = parseTimetableRows(rows);
    expect(sessions).toHaveLength(5);
  });

  it("parses the real user timetable (rich-text grid, merged cells)", () => {
    // 与 calamine 对真实 xlsx 的输出逐字一致：第1列=节次标签，随后各列=周一到周日。
    const rows = [
      ["我的课程表", "", "", "", "", "", "", "", ""],
      ["2026-2027学年第1学期", "学生：测试同学(00000000)", "", "", "", "", "", "", ""],
      [
        "上课时间暂未确定的课程：",
        "传感器实验 [ae22653010] 上课周次 11-14周 上课教师 测试教师",
        "",
        "",
        "",
        "",
        "",
        "",
        ""
      ],
      ["人工智能算法编程实践 [ae22653042] 上课周次 16周 上课教师 测试教师", "", "", "", "", "", "", "", ""],
      ["调课信息：", "", "", "", "", "", "", "", ""],
      ["节次/星期", "", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"],
      [
        "第1节-第2节",
        "",
        "",
        "ae22652013-电子测量原理[01]\n4-8周,星期2,第1节-第2节朝阳-实验楼-200",
        "",
        "ae22652013-电子测量原理[01]\n4-8周,星期4,第1节-第2节朝阳-实验楼-200",
        "",
        "",
        "",
        ""
      ],
      ["", "", "", "", "", "", "", "", ""],
      [
        "第3节-第4节",
        "",
        "ae22652012-误差理论与数据处理[02]\n4-8周,星期1,第3节-第4节朝阳-实验楼-200",
        "",
        "ae22652012-误差理论与数据处理[02]\n4-8周,星期3,第3节-第4节朝阳-实验楼-200",
        "",
        "",
        "",
        ""
      ],
      ["", "", "", "", "", "", "", "", ""],
      [
        "第5节-第6节",
        "",
        "",
        "ae22651015-人工智能基础及应用[01]\n4-15周,星期2,第5节-第6节朝阳-实验楼-401",
        "ae22651024-专业文献阅读与写作[01]\n11-14周,星期3,第5节-第6节朝阳-实验楼-200",
        "ae22651041-传感系统与检测技术[01]\n8-11周,星期4,第5节-第6节朝阳-实验楼-200,\n\nae22651041-传感系统与检测技术[01]\n4-7周,星期4,第5节-第6节朝阳-实验楼-200",
        "ae22651047-数据挖掘技术与应用[01]\n4-11周,星期5,第5节-第6节朝阳-实验楼-201",
        "",
        "",
        ""
      ],
      ["", "", "", "", "", "", "", "", ""],
      [
        "第7节-第8节",
        "",
        "",
        "ae22651041-传感系统与检测技术[01]\n8-11周,星期2,第7节-第8节朝阳-实验楼-200,\n\nae22651041-传感系统与检测技术[01]\n4-7周,星期2,第7节-第8节朝阳-实验楼-200",
        "ae22651047-数据挖掘技术与应用[01]\n4-11周,星期3,第7节-第8节朝阳-实验楼-201",
        "ae22651015-人工智能基础及应用[01]\n4-15周,星期4,第7节-第8节朝阳-实验楼-401",
        "",
        "",
        "",
        ""
      ],
      ["第9节-第10节", "", "", "", "", "", "", "", ""],
      ["第11节-第12节", "", "", "", "", "", "", "", ""]
    ];
    const { sessions, mode } = parseTimetableRows(rows);
    expect(mode).toBe("grid");
    // 6 门课 × 时段拆分：电子测量原理(2)、误差理论(2)、人工智能基础(2)、
    // 专业文献(1)、传感系统(4，含同格两时段)、数据挖掘(2) = 13 个时段。
    expect(sessions).toHaveLength(13);
    // 课程名清洗：去课程号前缀与 [序号] 尾缀。
    const names = new Set(sessions.map((s) => s.name));
    expect(names).toEqual(
      new Set([
        "电子测量原理",
        "误差理论与数据处理",
        "人工智能基础及应用",
        "专业文献阅读与写作",
        "传感系统与检测技术",
        "数据挖掘技术与应用"
      ])
    );
    // 地点解析：紧跟节次、无分隔符的「朝阳-实验楼-200」应完整保留。
    const dm_1_2 = sessions.find((s) => s.day === 2 && s.startSection === 1)!;
    expect(dm_1_2.location).toBe("朝阳-实验楼-200");
    expect(dm_1_2.weeksLabel).toBe("4-8周");
    expect(dm_1_2.weeks).toEqual([4, 5, 6, 7, 8]);
    // 传感系统周4 第5-6节：同格两个时段（8-11周 + 4-7周）应拆成两条。
    const cs = sessions.filter((s) => s.name === "传感系统与检测技术" && s.day === 4 && s.startSection === 5);
    expect(cs).toHaveLength(2);
    expect(cs.some((s) => s.weeksLabel === "8-11周")).toBe(true);
    expect(cs.some((s) => s.weeksLabel === "4-7周")).toBe(true);
    // 周次带「11-14周」正常展开。
    const doc = sessions.find((s) => s.name === "专业文献阅读与写作")!;
    expect(doc.weeks).toEqual([11, 12, 13, 14]);
    // 总周数预估：数据最大周 15，但 inferTotalWeeks 下限为 16。
    expect(inferTotalWeeks(sessions)).toBe(16);
  });
});

describe("semester math", () => {
  it("computes monday and week numbers", () => {
    // 2026-08-12 is a Wednesday; its week starts 2026-08-10.
    expect(toISODate(mondayOf(new Date(2026, 7, 12)))).toBe("2026-08-10");
    expect(weekNumberFor(new Date(2026, 7, 12), "2026-08-10", 20)).toBe(1);
    expect(weekNumberFor(new Date(2026, 7, 19), "2026-08-10", 20)).toBe(2);
    // 越界钳制
    expect(weekNumberFor(new Date(2027, 0, 1), "2026-08-10", 20)).toBe(20);
    expect(weekNumberFor(new Date(2026, 7, 1), "2026-08-10", 20)).toBe(1);
  });

  it("filters sessions by effective weeks", () => {
    const sessions = parseTimetableRows([
      ["课程", "星期", "节次", "周次"],
      ["A课", "周一", "1-2", "1-8周"],
      ["B课", "周二", "3", ""]
    ]).sessions;
    expect(sessionsInWeek(sessions, 9).map((s) => s.name)).toEqual(["B课"]);
    expect(
      sessionsInWeek(sessions, 3)
        .map((s) => s.name)
        .sort()
    ).toEqual(["A课", "B课"]);
  });

  it("infers total weeks from data", () => {
    const sessions = parseTimetableRows([
      ["课程", "星期", "节次", "周次"],
      ["A", "周一", "1", "1-18周"]
    ]).sessions;
    expect(inferTotalWeeks(sessions)).toBe(18);
  });
});

describe("sanitizeTimetableData", () => {
  const valid = {
    semesterStart: "2026-08-10",
    totalWeeks: 18,
    importedAt: 1,
    sessions: [
      {
        id: "a",
        name: "高数",
        rawName: "高数",
        day: 1,
        startSection: 1,
        endSection: 2,
        weeks: [1, 2],
        weeksLabel: "1-2周",
        location: "",
        teacher: ""
      },
      {
        id: "b",
        name: "坏行",
        day: 9,
        startSection: 1,
        endSection: 1,
        weeks: [],
        weeksLabel: "",
        location: "",
        teacher: ""
      }
    ]
  };

  it("drops invalid rows and keeps valid ones", () => {
    const out = sanitizeTimetableData(valid)!;
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0].name).toBe("高数");
  });

  it("repairs broken envelope fields", () => {
    const out = sanitizeTimetableData({ ...valid, totalWeeks: -5, semesterStart: "oops" })!;
    expect(out.totalWeeks).toBe(20);
    expect(parseWeeksLabel(out.semesterStart).length + out.semesterStart.length).toBeGreaterThan(0);
    expect(out.semesterStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null for empty or malformed input", () => {
    expect(sanitizeTimetableData(null)).toBeNull();
    expect(sanitizeTimetableData("x")).toBeNull();
    expect(sanitizeTimetableData({ sessions: [] })).toBeNull();
    expect(sanitizeTimetableData({ sessions: [{ day: 1, startSection: 1 }] })).toBeNull();
  });
});

describe("courseColor", () => {
  it("is stable per name and bounded to the palette", () => {
    const a = courseColor("高等数学");
    expect(courseColor("高等数学")).toEqual(a);
    expect(courseColor("大学物理")).toBeDefined();
    const b = courseColor("线性代数");
    expect(a).not.toEqual(b);
  });
});

describe("周次括号 / 单双缺「周」形态（导入容错）", () => {
  it("parseWeeksLabel 接受括号包裹的单双标记", () => {
    expect(parseWeeksLabel("1-16周(单)")).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(parseWeeksLabel("1-16（双）")).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(parseWeeksLabel("1-8周（单）")).toEqual([1, 3, 5, 7]);
  });

  it("parseCellText 单元格文本里的括号单双周不丢失", () => {
    const segs = parseCellText("大学英语 1-16周(单) 星期三 第3节-第4节 外语楼-302");
    expect(segs).toHaveLength(1);
    expect(segs[0].weeksLabel).toBe("1-16周(单)");
    expect(parseWeeksLabel(segs[0].weeksLabel)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
  });

  it("parseCellText 接受缺「周」字的单双标记（1-16双,星期2,…）", () => {
    const segs = parseCellText("高数 1-16双,星期2,第1节-第2节 教1-101");
    expect(segs).toHaveLength(1);
    expect(segs[0].weeksLabel.replace(/\s/g, "")).toBe("1-16双");
    expect(parseWeeksLabel(segs[0].weeksLabel)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it("纯数字仍不得当作周次（教室编号保护）", () => {
    const segs = parseCellText("高数 星期2,第1节-第2节 教1-101");
    expect(segs).toHaveLength(1);
    expect(segs[0].weeksLabel).toBe("");
  });
});

describe("rawWeekNumber（假期门控）", () => {
  it("返回未钳制的原始周号", () => {
    // 开学前（2026-07-01 在 2026-08-10 学期开始前五周）
    expect(rawWeekNumber(new Date(2026, 6, 1), "2026-08-10")).toBe(-5);
    // 学期第 1 / 2 周
    expect(rawWeekNumber(new Date(2026, 7, 12), "2026-08-10")).toBe(1);
    expect(rawWeekNumber(new Date(2026, 7, 19), "2026-08-10")).toBe(2);
    // 学期结束后（20 周学期 = 到 2026-12-27 那周）
    expect(rawWeekNumber(new Date(2027, 0, 1), "2026-08-10")).toBeGreaterThan(20);
  });

  it("非法 semesterStart 返回 null", () => {
    expect(rawWeekNumber(new Date(), "oops")).toBeNull();
  });
});

describe("网格式分列行标签（第1节 | 第2节 两列）", () => {
  it("合并解析出完整节次区间", () => {
    const rows = [
      ["节次", "", "星期一", "星期二", "星期三", "星期四", "星期五"],
      ["第1节", "第2节", "高数 1-16周 教1-101", "", "", "", ""],
      ["第3节", "第4节", "", "大物 1-8周 物理-201", "", "", ""]
    ];
    const { sessions } = parseTimetableRows(rows);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].startSection).toBe(1);
    expect(sessions[0].endSection).toBe(2);
    expect(sessions[1].startSection).toBe(3);
    expect(sessions[1].endSection).toBe(4);
  });

  it("首列为「上午/下午」时行标签取自次列", () => {
    const rows = [
      ["时段", "节次", "星期一", "星期二", "星期三"],
      ["上午", "第1节-第2节", "高数 1-16周", "", ""],
      ["下午", "第5节", "", "英语 1-16周", ""]
    ];
    const { sessions } = parseTimetableRows(rows);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].startSection).toBe(1);
    expect(sessions[0].endSection).toBe(2);
    expect(sessions[1].startSection).toBe(5);
    expect(sessions[1].endSection).toBe(5);
  });
});
