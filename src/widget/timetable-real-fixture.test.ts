import { describe, it, expect } from "vitest";
import rawRows from "./__fixtures__/my-schedule.json";
import { parseTimetableRows, sanitizeTimetableData, sessionsInWeek } from "./timetable";
import { findConflicts } from "./timetable-extras";

/**
 * 真实教务导出课表端到端回归（对应 __fixtures__/my-schedule.xlsx）。
 *
 * 该文件是最难的一类网格式：
 *  - 表头在第 8 行，前面有标题 / 学期 / 学生 / 「上课时间暂未确定的课程」等噪声行；
 *  - A、B 两列合并为节次标签列，标签行之间夹着 5 行空的合并残留行；
 *  - 单元格文本形如 `ae22652013-电子测量原理[01]\n4-8周,星期2,第1节-第2节朝阳-实验楼-200`；
 *  - 同一格可能有两门课（不同周次），以 `,\n\n` 分隔。
 *
 * 这里锁定「导入后能正确显示」的全部要素：课程数、名称清洗、星期、节次、
 * 周次展开、地点，以及噪声行不被误认成课程。
 */
const rows = rawRows as string[][];

describe("真实课表 xlsx 端到端解析", () => {
  const result = parseTimetableRows(rows);

  it("识别为网格式并解析出全部 13 个课段", () => {
    // 13 = 电子测量原理 2 + 误差理论 2 + 人工智能基础 2 + 专业文献 1
    //      + 传感系统 4（周二/周四各两段不同周次）+ 数据挖掘 2
    expect(result.mode).toBe("grid");
    expect(result.sessions).toHaveLength(13);
  });

  it("课程名已剥离课程代码与班号", () => {
    const names = [...new Set(result.sessions.map((s) => s.name))].sort();
    expect(names).toEqual(
      [
        "人工智能基础及应用",
        "传感系统与检测技术",
        "专业文献阅读与写作",
        "误差理论与数据处理",
        "数据挖掘技术与应用",
        "电子测量原理"
      ].sort()
    );
  });

  it("表头上方的噪声行不产生课程", () => {
    // 「上课时间暂未确定的课程：传感器实验 / 人工智能算法编程实践」在表头之上，
    // 不应被网格解析吸收。
    const names = result.sessions.map((s) => s.name);
    expect(names).not.toContain("传感器实验");
    expect(names).not.toContain("人工智能算法编程实践");
  });

  it("星期 / 节次 / 地点 / 周次均正确", () => {
    const em = result.sessions.filter((s) => s.name === "电子测量原理");
    expect(em).toHaveLength(2);
    expect(em.map((s) => s.day).sort()).toEqual([2, 4]);
    for (const s of em) {
      expect(s.startSection).toBe(1);
      expect(s.endSection).toBe(2);
      expect(s.location).toBe("朝阳-实验楼-200");
      expect(s.weeks).toEqual([4, 5, 6, 7, 8]);
    }
  });

  it("同一单元格内的两门课（不同周次）都被解析", () => {
    // 传感系统与检测技术：周二 7-8 节有 8-11 周 + 4-7 周两段，周四 5-6 节同理。
    const cs = result.sessions.filter((s) => s.name === "传感系统与检测技术");
    expect(cs).toHaveLength(4);
    const tue = cs.filter((s) => s.day === 2);
    expect(tue).toHaveLength(2);
    expect(tue.map((s) => s.weeks.join(","))).toEqual(expect.arrayContaining(["8,9,10,11", "4,5,6,7"]));
    for (const s of tue) {
      expect(s.startSection).toBe(7);
      expect(s.endSection).toBe(8);
    }
  });

  it("跨越晚间节次的课程（第 5-6 / 7-8 节）归位正确", () => {
    const ai = result.sessions.filter((s) => s.name === "人工智能基础及应用");
    expect(ai).toHaveLength(2);
    expect(ai.map((s) => `${s.day}/${s.startSection}-${s.endSection}`).sort()).toEqual(["2/5-6", "4/7-8"]);
    expect(ai[0].weeks).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("sanitize 后数据可直接渲染（周次不越界、id 唯一）", () => {
    const data = sanitizeTimetableData({
      semesterStart: "2026-09-07",
      totalWeeks: 20,
      sessions: result.sessions
    })!;
    expect(data.sessions).toHaveLength(13);
    expect(new Set(data.sessions.map((s) => s.id)).size).toBe(13);
    for (const s of data.sessions) {
      expect(s.day).toBeGreaterThanOrEqual(1);
      expect(s.day).toBeLessThanOrEqual(7);
      expect(Math.max(...s.weeks)).toBeLessThanOrEqual(20);
      expect(s.startSection).toBeLessThanOrEqual(s.endSection);
    }
  });

  it("按周筛选能取到当周课程", () => {
    // 第 5 周：4-8 周与 4-15 周、4-11 周、4-7 周的课都在。
    const w5 = sessionsInWeek(result.sessions, 5);
    expect(w5.length).toBeGreaterThanOrEqual(6);
    // 第 16 周：只剩没有任何课（最大到 15 周）。
    expect(sessionsInWeek(result.sessions, 16)).toHaveLength(0);
    // 第 12 周：仅人工智能基础及应用（4-15 周）与专业文献阅读（11-14 周）。
    const w12names = [...new Set(sessionsInWeek(result.sessions, 12).map((s) => s.name))].sort();
    expect(w12names).toEqual(["人工智能基础及应用", "专业文献阅读与写作"].sort());
  });

  it("该课表本身无时间冲突", () => {
    // 同格两段课周次互斥（4-7 / 8-11），不应被判为冲突。
    expect(findConflicts(result.sessions)).toHaveLength(0);
  });
});
