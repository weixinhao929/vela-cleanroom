import { describe, expect, it } from "vitest";
import { getHoliday, getLunarInfo } from "./lunar";

/**
 * 农历/节日换算回归：断言值均为真实历法事实（春节、中秋、端午、清明、闰月、
 * 母亲节/父亲节的「第 N 个周日」规则），实现若改坏查表或节气公式立刻暴露。
 * 远程节假日表（holiday-update）在 jsdom 下无缓存，不参与判定。
 */
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe("getLunarInfo", () => {
  it("初一显示月名，其余显示日名", () => {
    expect(getLunarInfo(d(2025, 1, 29))).toEqual({ lunar: "正月" }); // 2025 春节
    expect(getLunarInfo(d(2024, 9, 17))).toEqual({ lunar: "十五" }); // 2024 中秋
    expect(getLunarInfo(d(2024, 1, 1)).lunar).toBe("二十");
  });

  it("闰月带「闰」前缀", () => {
    expect(getLunarInfo(d(2023, 3, 22))).toEqual({ lunar: "闰二月" }); // 2023 闰二月初一
  });

  it("恰逢节气时附带 term", () => {
    expect(getLunarInfo(d(2024, 2, 4)).term).toBe("立春");
    expect(getLunarInfo(d(2024, 4, 4)).term).toBe("清明");
    expect(getLunarInfo(d(2024, 3, 15)).term).toBeUndefined();
  });
});

describe("getHoliday", () => {
  it("农历节日优先于固定公历节日", () => {
    expect(getHoliday(d(2025, 1, 29))).toEqual({ name: "春节", mark: "休" });
    expect(getHoliday(d(2024, 6, 10))).toEqual({ name: "端午节", mark: "休" });
    expect(getHoliday(d(2024, 9, 17))).toEqual({ name: "中秋节", mark: "休" });
  });

  it("清明按节气而非固定日期", () => {
    expect(getHoliday(d(2024, 4, 4))).toEqual({ name: "清明节", mark: "休" });
  });

  it("固定公历节日", () => {
    expect(getHoliday(d(2024, 1, 1))).toEqual({ name: "元旦", mark: "假" });
    expect(getHoliday(d(2024, 10, 1))).toEqual({ name: "国庆节", mark: "休" });
  });

  it("母亲节 = 5 月第 2 个周日，父亲节 = 6 月第 3 个周日", () => {
    expect(getHoliday(d(2024, 5, 12))).toEqual({ name: "母亲节", mark: "纪念" });
    expect(getHoliday(d(2024, 5, 5))?.name).not.toBe("母亲节"); // 第 1 个周日
    expect(getHoliday(d(2024, 6, 16))).toEqual({ name: "父亲节", mark: "纪念" });
  });

  it("普通日期返回 undefined", () => {
    expect(getHoliday(d(2024, 3, 15))).toBeUndefined();
  });
});
