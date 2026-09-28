/**
 * 农历 / 节气 / 放假 / 纪念日 计算工具
 *
 * - 农历换算：基于 1900-2100 农历数据表（lunarInfo）的标准算法。
 * - 24 节气：使用近似算法（sTermInfo 常数表）。
 * - 放假 / 纪念日：内置中国法定节假日与常见纪念日数据，按日期匹配。
 */

import { remoteHoliday } from "./holiday-update";

export interface LunarInfo {
  /** 农历显示文本，如 "初一"、"十五"；初一显示月份名如 "正月"。 */
  lunar: string;
  /** 当天节气名，如 "立春"；非节气日不返回。 */
  term?: string;
}

export interface HolidayInfo {
  name: string;
  /** 小标记：如 "休" / "假" / "纪念"。 */
  mark: string;
}

/* ------------------------------------------------------------------ */
/* 农历换算                                                           */
/* ------------------------------------------------------------------ */

/** 1900-2100 年农历数据表（每项 16 进制编码闰月与大小月）。 */
const lunarInfo = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, 0x04ae0, 0x0a5b6, 0x0a4d0,
  0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, 0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54,
  0x02b60, 0x09570, 0x052f2, 0x04970, 0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7,
  0x0c950, 0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, 0x06ca0, 0x0b550,
  0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, 0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570,
  0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, 0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540,
  0x0b6a0, 0x195a6, 0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, 0x04af5,
  0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, 0x0c960, 0x0d954, 0x0d4a0, 0x0da50,
  0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, 0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0,
  0x15176, 0x052b0, 0x0a930, 0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, 0x0b5a0, 0x056d0, 0x055b2,
  0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, 0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6,
  0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, 0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0,
  0x055d4, 0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, 0x0b273, 0x06930,
  0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, 0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0,
  0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, 0x0d520
];

const lunarMonthNames = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const lunarDayNames = [
  "初一",
  "初二",
  "初三",
  "初四",
  "初五",
  "初六",
  "初七",
  "初八",
  "初九",
  "初十",
  "十一",
  "十二",
  "十三",
  "十四",
  "十五",
  "十六",
  "十七",
  "十八",
  "十九",
  "二十",
  "廿一",
  "廿二",
  "廿三",
  "廿四",
  "廿五",
  "廿六",
  "廿七",
  "廿八",
  "廿九",
  "三十"
];

function leapMonth(y: number): number {
  return lunarInfo[y - 1900] & 0xf;
}

function leapDays(y: number): number {
  if (leapMonth(y)) return lunarInfo[y - 1900] & 0x10000 ? 30 : 29;
  return 0;
}

function monthDays(y: number, m: number): number {
  return lunarInfo[y - 1900] & (0x10000 >> m) ? 30 : 29;
}

function lYearDays(y: number): number {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += lunarInfo[y - 1900] & i ? 1 : 0;
  return sum + leapDays(y);
}

interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

/** 公历转农历（支持 1900-2100）。 */
function solar2lunar(date: Date): LunarDate {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();

  let offset = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);

  let i = 1900;
  let temp = 0;
  for (; i < 2101 && offset > 0; i++) {
    temp = lYearDays(i);
    offset -= temp;
  }
  if (offset < 0) {
    offset += temp;
    i--;
  }

  const year = i;
  const leap = leapMonth(i);
  let isLeap = false;

  let j = 1;
  for (; j < 13 && offset > 0; j++) {
    if (leap > 0 && j === leap + 1 && !isLeap) {
      --j;
      isLeap = true;
      temp = leapDays(year);
    } else {
      temp = monthDays(year, j);
    }
    if (isLeap && j === leap + 1) isLeap = false;
    offset -= temp;
  }

  if (offset === 0 && leap > 0 && j === leap + 1) {
    if (isLeap) isLeap = false;
    else {
      isLeap = true;
      --j;
    }
  }
  if (offset < 0) {
    offset += temp;
    --j;
  }

  return { year, month: j, day: offset + 1, isLeap };
}

/* ------------------------------------------------------------------ */
/* 24 节气（近似算法）                                                 */
/* ------------------------------------------------------------------ */

const termNames = [
  "小寒",
  "大寒",
  "立春",
  "雨水",
  "惊蛰",
  "春分",
  "清明",
  "谷雨",
  "立夏",
  "小满",
  "芒种",
  "夏至",
  "小暑",
  "大暑",
  "立秋",
  "处暑",
  "白露",
  "秋分",
  "寒露",
  "霜降",
  "立冬",
  "小雪",
  "大雪",
  "冬至"
];

const sTermInfo = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693, 263343, 285989, 308563, 331033,
  353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758
];

/** 返回某年某个节气（n: 0-23）落在当月的几号。 */
function termDay(year: number, n: number): number {
  const ms = 31556925974.7 * (year - 1900) + sTermInfo[n] * 60000 + Date.UTC(1900, 0, 6, 2, 5);
  return new Date(ms).getUTCDate();
}

function getSolarTerm(date: Date): string | undefined {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const base = (m - 1) * 2;
  for (let k = 0; k < 2; k++) {
    if (termDay(y, base + k) === d) return termNames[base + k];
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 放假 / 纪念日                                                       */
/* ------------------------------------------------------------------ */

/** 固定公历日期节日。 */
const FIXED_HOLIDAYS: Record<string, HolidayInfo> = {
  "1-1": { name: "元旦", mark: "假" },
  "2-14": { name: "情人节", mark: "纪念" },
  "3-8": { name: "妇女节", mark: "纪念" },
  "3-12": { name: "植树节", mark: "纪念" },
  "4-1": { name: "愚人节", mark: "纪念" },
  "5-1": { name: "劳动节", mark: "休" },
  "5-4": { name: "青年节", mark: "纪念" },
  "6-1": { name: "儿童节", mark: "纪念" },
  "7-1": { name: "建党节", mark: "纪念" },
  "8-1": { name: "建军节", mark: "纪念" },
  "9-10": { name: "教师节", mark: "纪念" },
  "10-1": { name: "国庆节", mark: "休" },
  "12-24": { name: "平安夜", mark: "纪念" },
  "12-25": { name: "圣诞节", mark: "纪念" }
};

/** 农历日期节日（键为 农历月-日）。 */
const LUNAR_HOLIDAYS: Record<string, HolidayInfo> = {
  "1-1": { name: "春节", mark: "休" },
  "1-15": { name: "元宵节", mark: "纪念" },
  "5-5": { name: "端午节", mark: "休" },
  "7-7": { name: "七夕", mark: "纪念" },
  "8-15": { name: "中秋节", mark: "休" },
  "9-9": { name: "重阳节", mark: "纪念" },
  "12-8": { name: "腊八节", mark: "纪念" }
};

/** 母亲节（5 月第 2 个周日）、父亲节（6 月第 3 个周日）。 */
function getSpecialDay(date: Date): HolidayInfo | undefined {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const dow = date.getDay();
  if (m === 5 && dow === 0 && Math.ceil(d / 7) === 2) {
    return { name: "母亲节", mark: "纪念" };
  }
  if (m === 6 && dow === 0 && Math.ceil(d / 7) === 3) {
    return { name: "父亲节", mark: "纪念" };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 获取某天的农历信息（农历日/月文本 + 可选节气名）。
 *
 * @param date - 公历日期（支持 1900-2100 年）。
 * @returns {@link LunarInfo}：`lunar` 为「初一」显示月名、其余显示日名；
 *          恰逢节气时附带 `term`。O(1)（查表）。
 * @throws 无；超出支持年份的结果未定义。
 *
 * @example
 * ```ts
 * getLunarInfo(new Date(2026, 1, 17)); // { lunar: "正月初一", term: "雨水" } 之类
 * ```
 */
export function getLunarInfo(date: Date): LunarInfo {
  const lunar = solar2lunar(date);
  const lunarText =
    lunar.day === 1 ? `${lunar.isLeap ? "闰" : ""}${lunarMonthNames[lunar.month - 1]}月` : lunarDayNames[lunar.day - 1];
  const term = getSolarTerm(date);
  return term ? { lunar: lunarText, term } : { lunar: lunarText };
}

/**
 * 获取某天的放假 / 纪念日信息。
 * 查找顺序：固定公历节日 → 农历节日 → 母亲节/父亲节（第 N 个周日）→
 * 远程节假日表（holiday-update）。O(1)。
 *
 * @param date - 公历日期。
 * @returns `{ name, mark }`；mark 取值 "休"|"班"|"假"|"纪念"；无命中返回 undefined。
 * @throws 无。
 *
 * @example
 * ```ts
 * getHoliday(new Date(2026, 9, 1)); // { name: "国庆节", mark: "休" }
 * ```
 */
export function getHoliday(date: Date): HolidayInfo | undefined {
  // W-018 远程节假日优先：在线更新的放假日覆盖内置表（跨年不发版可更新）。
  // 只覆盖放假日（mark=休）；调休上班日的「班」标记由课表侧 remote 数据渲染。
  const remote = remoteHoliday(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  );
  if (remote?.off) return { name: remote.name || "法定节假日", mark: "休" };

  const lunar = solar2lunar(date);
  const lunarHoliday = LUNAR_HOLIDAYS[`${lunar.month}-${lunar.day}`];
  if (lunarHoliday) return lunarHoliday;

  const term = getSolarTerm(date);
  if (term === "清明") return { name: "清明节", mark: "休" };

  const fixed = FIXED_HOLIDAYS[`${date.getMonth() + 1}-${date.getDate()}`];
  if (fixed) return fixed;

  return getSpecialDay(date);
}
