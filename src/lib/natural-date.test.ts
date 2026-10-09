import { describe, expect, it } from "vitest";
import { parseNaturalDateTime, stripMatchedDate } from "./natural-date";

/** 固定基准：2026-08-17（周一）14:00。 */
const NOW = new Date(2026, 7, 17, 14, 0, 0);

describe("parseNaturalDateTime", () => {
  it("明天 + 时段点数", () => {
    const r = parseNaturalDateTime("交论文 明天下午3点", NOW);
    expect(r).not.toBeNull();
    expect(r!.date.getFullYear()).toBe(2026);
    expect(r!.date.getMonth()).toBe(7);
    expect(r!.date.getDate()).toBe(18);
    expect(r!.date.getHours()).toBe(15);
  });

  it("今晚 → 当天晚上", () => {
    const r = parseNaturalDateTime("今晚8点开黑", NOW);
    expect(r!.date.getDate()).toBe(17);
    expect(r!.date.getHours()).toBe(20);
  });

  it("后天不带时间 → 日末 23:59", () => {
    const r = parseNaturalDateTime("后天", NOW);
    expect(r!.date.getDate()).toBe(19);
    expect(r!.date.getHours()).toBe(23);
    expect(r!.date.getMinutes()).toBe(59);
  });

  it("下周三 → 下个自然周", () => {
    const r = parseNaturalDateTime("下周三 14:30", NOW);
    // 周一(17) → 下周一 24 → 周三 26。
    expect(r!.date.getDate()).toBe(26);
    expect(r!.date.getHours()).toBe(14);
    expect(r!.date.getMinutes()).toBe(30);
  });

  it("周五（本周内，含今天）", () => {
    const r = parseNaturalDateTime("周五提交", NOW);
    expect(r!.date.getDate()).toBe(21);
  });

  it("月日跨年顺延", () => {
    const r = parseNaturalDateTime("1月2日", NOW);
    expect(r!.date.getFullYear()).toBe(2027);
  });

  it("N天后 / N小时后 / N分钟后", () => {
    expect(parseNaturalDateTime("3天后", NOW)!.date.getDate()).toBe(20);
    expect(parseNaturalDateTime("2小时后", NOW)!.date.getHours()).toBe(16);
    expect(parseNaturalDateTime("90分钟后", NOW)!.date.getHours()).toBe(15);
    expect(parseNaturalDateTime("90分钟后", NOW)!.date.getMinutes()).toBe(30);
  });

  it("只有时间且已过 → 明天", () => {
    const r = parseNaturalDateTime("上午9点", NOW);
    expect(r!.date.getDate()).toBe(18);
    expect(r!.date.getHours()).toBe(9);
  });

  it("X点半与X点X分", () => {
    expect(parseNaturalDateTime("明天9点半", NOW)!.date.getMinutes()).toBe(30);
    expect(parseNaturalDateTime("明天9点20分", NOW)!.date.getMinutes()).toBe(20);
  });

  it("带年份的完整日期", () => {
    const r = parseNaturalDateTime("2027年3月1日上午10点", NOW);
    expect(r!.date.getFullYear()).toBe(2027);
    expect(r!.date.getMonth()).toBe(2);
    expect(r!.date.getHours()).toBe(10);
  });

  it("无法解析返回 null", () => {
    expect(parseNaturalDateTime("买牛奶", NOW)).toBeNull();
    expect(parseNaturalDateTime("", NOW)).toBeNull();
  });
});

describe("紧凑日期与 am/pm", () => {
  it("8 位 YYYYMMDD / 6 位 YYMMDD", () => {
    const r8 = parseNaturalDateTime("交报告 20260822", NOW);
    expect(r8!.date.getMonth()).toBe(7);
    expect(r8!.date.getDate()).toBe(22);
    expect(r8!.date.getHours()).toBe(23); // 仅日期 → 日末
    const r6 = parseNaturalDateTime("260822", NOW);
    expect(r6!.date.getFullYear()).toBe(2026);
    expect(r6!.date.getDate()).toBe(22);
  });

  it("非法紧凑串不命中（月 13 / 日 32）", () => {
    expect(parseNaturalDateTime("20261301", NOW)).toBeNull();
    expect(parseNaturalDateTime("260132", NOW)).toBeNull();
  });

  it("夹在长数字中的段不命中（前后还有数字）", () => {
    expect(parseNaturalDateTime("订单202608221", NOW)).toBeNull();
  });

  it("2:30pm / 9am / 12am", () => {
    const pm = parseNaturalDateTime("2:30pm 提交", NOW);
    expect(pm!.date.getDate()).toBe(17);
    expect(pm!.date.getHours()).toBe(14);
    expect(pm!.date.getMinutes()).toBe(30);
    const am = parseNaturalDateTime("9am 站会", NOW);
    // 9:00 已过（NOW=14:00）→ 顺延明天
    expect(am!.date.getDate()).toBe(18);
    expect(am!.date.getHours()).toBe(9);
    expect(parseNaturalDateTime("12am", NOW)!.date.getHours()).toBe(0);
  });

  it("4 位紧凑数字刻意不支持（歧义：1430 / 预算2000）", () => {
    expect(parseNaturalDateTime("1430", NOW)).toBeNull();
    expect(parseNaturalDateTime("预算2000元", NOW)).toBeNull();
  });
});

describe("stripMatchedDate", () => {
  it("移除命中的时间短语", () => {
    const r = parseNaturalDateTime("交论文 明天下午3点", NOW)!;
    expect(stripMatchedDate("交论文 明天下午3点", r.matched)).toBe("交论文");
  });
});
