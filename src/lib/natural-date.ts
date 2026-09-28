/**
 * W-047 自然语言日期解析：把「明天下午3点」「下周五 14:30」「8月18日」这类
 * 口语时间解析为具体 Date。规则式实现（无依赖、可单测），供 DDL 表单与任务
 * 截止输入做实时预览。解析失败返回 null，调用方静默回退手工输入。
 */

export type NaturalDate = { date: Date; matched: string };

const WEEKDAY_WORDS = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAY_WORDS_ALT = ["1", "2", "3", "4", "5", "6", "天"];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 日期表达 → 目标日（不含时间）。返回 null 表示未命中。 */
function matchDay(text: string, now: Date): { date: Date; matched: string } | null {
  const today = startOfDay(now);

  let m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : { date: d, matched: m[0] };
  }

  m = text.match(/(?:大)?后天/);
  if (m) {
    const d = new Date(today);
    d.setDate(d.getDate() + (m[0] === "后天" ? 2 : 3));
    return { date: d, matched: m[0] };
  }
  m = text.match(/明[天日]/);
  if (m) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return { date: d, matched: m[0] };
  }
  m = text.match(/今[天日]/);
  if (m) return { date: new Date(today), matched: m[0] };

  m = text.match(/(\d{1,3})\s*天[后後]/);
  if (m) {
    const d = new Date(today);
    d.setDate(d.getDate() + Number(m[1]));
    return { date: d, matched: m[0] };
  }

  m = text.match(/([上下])?(?:周|礼拜|星期)([一二三四五六日天1-6])/);
  if (m) {
    const wIdx = WEEKDAY_WORDS.indexOf(m[2]);
    const idx = wIdx >= 0 ? wIdx : WEEKDAY_WORDS_ALT.indexOf(m[2]);
    if (idx >= 0) {
      const cur = (now.getDay() + 6) % 7; // 0=周一
      // 周X = 最近一次（含今天）；下周X = 下个自然周；上周X = 上个自然周。
      const delta = m[1] === "下" ? 7 - cur + idx : m[1] === "上" ? idx - cur - 7 : (idx - cur + 7) % 7;
      const d = new Date(today);
      d.setDate(d.getDate() + delta);
      return { date: d, matched: m[0] };
    }
  }

  m = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) {
    let d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getTime() < today.getTime()) d = new Date(now.getFullYear() + 1, Number(m[1]) - 1, Number(m[2]));
    return { date: d, matched: m[0] };
  }

  // DeskOrder 借鉴 #5：紧凑纯数字日期。8 位 YYYYMMDD 与 6 位 YYMMDD 无
  // 歧义（不可能是时刻），可安全出现在标题里；4 位 MMDD/HHmm 有歧义
  // （"1430" 是 14:30 还是 1月30日？"预算2000" 会误命中 20:00），刻意
  // 不在标题解析中支持，需要时走日期选择器。
  m = text.match(/(?<!\d)(\d{8})(?!\d)/);
  if (m) {
    const s = m[1];
    const d = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
    if (!Number.isNaN(d.getTime()) && d.getMonth() === Number(s.slice(4, 6)) - 1) {
      return { date: d, matched: m[0] };
    }
  }
  m = text.match(/(?<!\d)(\d{6})(?!\d)/);
  if (m) {
    const s = m[1];
    const d = new Date(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)));
    if (!Number.isNaN(d.getTime()) && d.getMonth() === Number(s.slice(2, 4)) - 1) {
      return { date: d, matched: m[0] };
    }
  }

  m = text.match(/(\d{1,2})[/月.-](\d{1,2})/);
  if (m && !/时|点|:/.test(m[0])) {
    let d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getTime() < today.getTime()) d = new Date(now.getFullYear() + 1, Number(m[1]) - 1, Number(m[2]));
    return { date: d, matched: m[0] };
  }

  return null;
}

/** 时间表达 → 时/分。返回 null 表示未指定时间（调用方给日末默认值）。 */
function matchTime(text: string): { h: number; m: number; matched: string } | null {
  // DeskOrder 借鉴 #5：am/pm 后缀式（2:30pm / 9am / 11 am）。放在 HH:mm
  // 规则之前——后者会先咬掉 "2:30" 丢掉 pm 语义。
  let m = text.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])/i);
  if (m) {
    let h = Number(m[1]);
    if (m[3].toLowerCase() === "p") {
      if (h < 12) h += 12;
    } else if (h === 12) {
      h = 0;
    }
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 23 || min > 59) return null;
    return { h, m: min, matched: m[0] };
  }

  m = text.match(/(\d{1,2}):(\d{2})/);
  if (m) return { h: Number(m[1]), m: Number(m[2]), matched: m[0] };

  m = text.match(
    /(凌晨|清晨|早上|上午|中午|午后|下午|傍晚|晚上|夜里|今晚)?\s*(\d{1,2})\s*[点时](半|\s*(\d{1,2})\s*分?)?/
  );
  if (m) {
    let h = Number(m[2]);
    const part = m[1] ?? "";
    if (part === "中午" || part === "午后" || part === "下午") {
      if (h < 12) h += 12;
    } else if (part === "晚上" || part === "夜里" || part === "今晚") {
      if (h < 12) h += 12;
    }
    const min = m[3] === "半" ? 30 : m[4] ? Number(m[4]) : 0;
    if (h > 23 || min > 59) return null;
    return { h, m: min, matched: m[0] };
  }

  m = text.match(/(\d{1,2})\s*个?小时[后後]/);
  if (m) return { h: -1 - Number(m[1]), m: 0, matched: m[0] };

  m = text.match(/(\d{1,3})\s*分钟[后後]/);
  if (m) return { h: -100 - Number(m[1]), m: 0, matched: m[0] };

  return null;
}

/**
 * 解析文本中的自然语言日期时间（规则式，无依赖、可单测）。
 *
 * 组合规则：日期+时间 → 精确时刻；仅日期 → 当天 23:59（DDL 语义）；
 * 仅时间 → 今天该时刻（已过则顺延明天）；相对时长（N小时后/N分钟后）
 * 直接从 `now` 起算并忽略日期词。供 DDL 表单与任务截止输入做实时预览。
 *
 * @param text - 用户输入文本（如「明天下午3点交周报」）。
 * @param now - 参考当前时间，默认 new Date()（测试可注入固定值）。
 * @returns {@link NaturalDate}；未命中返回 null，调用方回退手工输入。
 * @throws 无（非法数值组合按未命中处理）。
 *
 * @example
 * ```ts
 * parseNaturalDateTime("下周五 14:30"); // { date: …, matched: "下周五 14:30" }
 * parseNaturalDateTime("3小时后");      // 相对时长
 * parseNaturalDateTime("hello");        // null
 * ```
 */
export function parseNaturalDateTime(text: string, now = new Date()): NaturalDate | null {
  if (!text) return null;
  const day = matchDay(text, now);
  const time = matchTime(text);

  if (day && time) {
    // 相对时长（N小时后 / N分钟后）忽略日期词，直接从 now 起算。
    if (time.h < 0) {
      const d = new Date(now);
      if (time.h <= -100) d.setMinutes(d.getMinutes() + (-time.h - 100));
      else d.setHours(d.getHours() + (-1 - time.h));
      return { date: d, matched: time.matched };
    }
    const d = new Date(day.date);
    d.setHours(time.h, time.m, 0, 0);
    return { date: d, matched: `${day.matched} ${time.matched}`.trim() };
  }
  if (day) {
    const d = new Date(day.date);
    d.setHours(23, 59, 0, 0);
    return { date: d, matched: day.matched };
  }
  if (time) {
    const d = startOfDay(now);
    if (time.h < 0) {
      const x = new Date(now);
      if (time.h <= -100) x.setMinutes(x.getMinutes() + (-time.h - 100));
      else x.setHours(x.getHours() + (-1 - time.h));
      return { date: x, matched: time.matched };
    }
    d.setHours(time.h, time.m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return { date: d, matched: time.matched };
  }
  return null;
}

/**
 * 从标题中移除已命中的时间短语，剩下的作为纯标题。
 * matched 可能是「日期 时间」拼接且两段在原文未必相邻，故逐段移除。
 *
 * @param title - 原始标题文本。
 * @param matched - {@link parseNaturalDateTime} 返回的 matched 片段。
 * @returns 清理后的标题（压缩多余空白、去首尾空格）。
 * @throws 无。
 *
 * @example
 * ```ts
 * stripMatchedDate("交周报 明天下午3点", "明天 下午3点"); // "交周报"
 * ```
 */
export function stripMatchedDate(title: string, matched: string): string {
  // matched 可能是「日期 时间」的拼接（两段未必在原文相邻），逐段移除。
  return matched
    .split(" ")
    .filter(Boolean)
    .reduce((acc, part) => acc.replace(part, ""), title)
    .replace(/\s{2,}/g, " ")
    .trim();
}
