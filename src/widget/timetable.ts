/**
 * 课程表数据模型与 Excel 语义解析。
 *
 * 支持两种主流课表形态（参考 WakeUp / SCHEDULE-IMPORT / course-schedule-viewer）：
 *  1. 网格式：表头行含「星期一…星期日」，行标签「第N节-第M节」，单元格文本
 *     形如「ae22652013-电子测量原理[01]4-8周,星期2,第1节-第2节朝阳-实验楼-200」，
 *     一格可含多门课（以 , 分隔）；节次/星期优先取文本内嵌值，缺失回退到
 *     行标签 / 列表头；
 *  2. 清单式：一行一条上课记录，列名同义词映射（课程名称/课程/名称、星期/周几、
 *     开始节次/节次、周次、教室/地点、教师）。
 *
 * 周次语义：`4-8周` `1-16单` `1-16双` `1-3,5-16` `16周` 归一化为绝对周集合。
 * 所有函数均为纯函数，行为由 timetable.test.ts 锁定。
 */

export type TimetableSession = {
  id: string;
  /** 展示名（去课程号/序号后的纯名称）。 */
  name: string;
  /** 教务原始名（含课程号，如 ae22652013-电子测量原理[01]）。 */
  rawName: string;
  /** 1=周一 … 7=周日。 */
  day: number;
  startSection: number;
  endSection: number;
  /** 生效周（绝对周号，1 起）。 */
  weeks: number[];
  /** 周次原文，如「4-8周」。 */
  weeksLabel: string;
  location: string;
  teacher: string;
  /** W-020 手动指定颜色（hex，如 #5b8def）；空 = 按名称哈希取色。 */
  colorOverride?: string;
};

export type TimetableData = {
  /** 第一周周一的 ISO 日期（yyyy-mm-dd）。 */
  semesterStart: string;
  totalWeeks: number;
  sessions: TimetableSession[];
  importedAt: number;
};

/** 默认节次开始时间（常见工科作息，12 节）。 */
export const DEFAULT_SECTION_TIMES = [
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

/** 解析「08:00, 08:55 …」形式的节次时间串（逗号/空格分隔，过滤非法项）。 */
export function parseTimeList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(/[,，\s]+/).filter((t) => /^\d{1,2}:\d{2}$/.test(t));
}

/** 「HH:MM」加 N 分钟（跨日回绕），返回同格式字符串。 */
export function addMinutesToTime(hhmm: string, minutes: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return "";
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* 基础归一化                                                          */
/* ------------------------------------------------------------------ */

const DAY_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  七: 7,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7
};

/**
 * 全角/兼容字符归一（NFKC）：「星期２」「１６单」「第３节」等全角数字形态
 * 在 \d+ 与 DAY_MAP 处全部解析归零。仅在解析入口调用，不影响展示原文。
 */
function nfkc(s: string): string {
  return s.normalize("NFKC");
}

/** 解析星期 token：星期二 / 周二 / 二 / Tue → 2；无法识别返回 null。 */
export function parseDayToken(raw: string): number | null {
  const s = nfkc(raw)
    .trim()
    .toLowerCase()
    .replace(/星期|礼拜|周/, "");
  if (s in DAY_MAP) return DAY_MAP[s];
  const en = /^([a-z]{3})[a-z]*$/.exec(s);
  if (en && en[1] in DAY_MAP) return DAY_MAP[en[1]];
  return null;
}

/**
 * 周次文本 → 绝对周集合。
 * 「4-8周」「1-16单」「1-16双」「1-3,5-16」「16周」「第3周」→ Set 形式的有序数组。
 * maxWeek 用于钳制；非法输入返回空数组。
 * P2（审计修复）：默认上限从 40 提到 60，与 sanitizeTimetableData 允许的
 * totalWeeks ≤ 60 对齐——此前导入 41-60 周的长学期课表时后半学期课程被
 * 静默截掉。
 */
export function parseWeeksLabel(raw: string, maxWeek = 60): number[] {
  const s = nfkc(raw).replace(/\s+/g, "").replace(/第/g, "");
  if (!s) return [];
  const weekSet = new Set<number>();
  for (const part of s.split(/[,，、;；]/)) {
    const m = /^(\d+)(?:[-–—~至](\d+))?(周)?(单|双|odd|even)?$/i.exec(part);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) continue;
    const parity = m[4]?.toLowerCase();
    for (let w = a; w <= Math.min(b, maxWeek); w++) {
      if (parity === "单" || parity === "odd") {
        if (w % 2 === 1) weekSet.add(w);
      } else if (parity === "双" || parity === "even") {
        if (w % 2 === 0) weekSet.add(w);
      } else {
        weekSet.add(w);
      }
    }
  }
  return [...weekSet].sort((x, y) => x - y);
}

/** 周集合 → 紧凑展示文本：[4,5,6,7,8] →「4-8周」，[4,8] →「4,8周」。 */
export function formatWeeks(weeks: number[]): string {
  if (!weeks.length) return "";
  const parts: string[] = [];
  let start = weeks[0];
  let prev = weeks[0];
  for (let i = 1; i <= weeks.length; i++) {
    const cur = weeks[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur;
    prev = cur;
  }
  return `${parts.join(",")}周`;
}

/**
 * 课程名清洗：`ae22652013-电子测量原理[01]` → `电子测量原理`。
 * 只剥离「拉丁字母数字前缀-」与「尾缀[数字/序号]」，中文名原样保留。
 */
export function cleanCourseName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^[A-Za-z][A-Za-z0-9]*[-_]\s*/, "");
  s = s.replace(/\s*\[[\w\u4e00-\u9fa5-]*\]\s*$/, "");
  return s.trim();
}

/* ------------------------------------------------------------------ */
/* 单元格 / 单行解析                                                    */
/* ------------------------------------------------------------------ */

/** 课时段正则：[周次 +] 星期 + 节次区间，如「4-8周,星期2,第1节-第2节」。周次可缺省。
 *  周次组前有边界断言：前一个字符不能是字母/数字/CJK/连字符，否则教室编号
 *  「教1-101」里的数字会被当成周次吞掉；唯一例外是「第」（第16周 形态）。 */
const SEGMENT_RE =
  /(?:(?:(?<![0-9A-Za-z\u4e00-\u9fa5-])|(?<=第))(\d+(?:\s*[-–—~至]\s*\d+)?(?:\s*[,，、]\s*\d+(?:\s*[-–—~至]\s*\d+)?)*\s*周)\s*[,，;；]?\s*)?(?:星期|周|礼拜)\s*([1-7一二三四五六日天])\s*[,，;；]?\s*第\s*(\d+)\s*(?:节)?\s*(?:[-–—~至]\s*第\s*(\d+)\s*节)?/g;

/** 从纯文本里抓周次 token（「高等数学 1-16周」→ 名字 + 周次）。 */
const WEEKS_TOKEN_RE = /\d+(?:\s*[-–—~至]\s*\d+)?(?:\s*[,，、]\s*\d+(?:\s*[-–—~至]\s*\d+)?)*\s*周/g;

export type ParsedSegment = {
  name: string;
  rawName: string;
  day: number | null;
  startSection: number | null;
  endSection: number | null;
  weeksLabel: string;
  location: string;
};

/**
 * 解析一个网格单元格 / 复合字符串中的全部课时段。
 * 单元格文本形如「课程名A 时段1 地点1 , 课程名B 时段2 地点2」（富文本运行
 * 拼接后分隔符可能是换行、逗号或直接相连）。相邻两个时段之间的间隔文本
 * 同时包含「前一时段的地点」与「后一时段的课程名」，按分隔符拆开后：
 * 首段 = 地点，末段 = 课程名；只有一段时视为地点（名字回退沿用上一门课，
 * 覆盖「同名课程拆多时段」的常见导出）。
 * 缺失星期/节次时回退 fallbackDay（网格列）/ fallbackSection（行标签）。
 */
export function parseCellText(
  text: string,
  opts: { fallbackDay?: number | null; fallbackStart?: number | null; fallbackEnd?: number | null } = {}
): ParsedSegment[] {
  const out: ParsedSegment[] = [];
  if (!text) return out;
  // 入口 NFKC：全角数字（星期２/第１节/１６单）与全角标点归一后再匹配，
  // 下游所有下标切片都基于归一后的文本，保持一致。
  text = nfkc(text);
  const matches = [...text.matchAll(SEGMENT_RE)];
  if (!matches.length) {
    // 没有时段信息：整格视为纯课程名（部分网格式只写名字），
    // 名字里内嵌的周次 token（「高等数学 1-16周」）剥离为 weeksLabel。
    let nameText = text;
    let weeksLabel = "";
    const weekTokens = text.match(WEEKS_TOKEN_RE);
    if (weekTokens) {
      weeksLabel = weekTokens.join("").replace(/\s+/g, "");
      for (const w of weekTokens) nameText = nameText.replace(w, " ");
    }
    const name = cleanCourseName(nameText);
    if (!name) return out;
    return [
      {
        name,
        rawName: text.trim(),
        day: opts.fallbackDay ?? null,
        startSection: opts.fallbackStart ?? null,
        endSection: opts.fallbackEnd ?? null,
        weeksLabel,
        location: ""
      }
    ];
  }

  let prevName = "";
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];

    // 本段地点：本段结束后到下一段开始（或文本末尾）之间的首段。
    const afterStart = (m.index ?? 0) + m[0].length;
    const afterEnd = next ? (next.index ?? 0) : text.length;
    const afterParts = text
      .slice(afterStart, afterEnd)
      .split(/\s*[,，;；\n\r]\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    const locationPart = afterParts.length ? afterParts[0] : "";

    // 本段课程名：首段取时段前全部文本；其后取「前段与本段之间」的末段。
    const beforeStart = i === 0 ? 0 : (matches[i - 1].index ?? 0) + matches[i - 1][0].length;
    const beforeParts = text
      .slice(beforeStart, m.index ?? 0)
      .split(/\s*[,，;；\n\r]\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    let rawName = "";
    if (i === 0) {
      rawName = text.slice(0, m.index ?? 0);
    } else if (beforeParts.length >= 2) {
      rawName = beforeParts[beforeParts.length - 1];
    }
    // 名字缺失时沿用上一门课（同一课程拆多时段的导出）。
    const effectiveRaw = rawName.trim() || prevName;
    prevName = effectiveRaw;
    const nm = cleanCourseName(effectiveRaw);
    const location = (locationPart && nm && locationPart.includes(nm) ? locationPart.split(nm).join(" ") : locationPart)
      .replace(/\s+/g, " ")
      .trim();

    const day = parseDayToken(m[2]);
    const startSection = m[3] ? parseInt(m[3], 10) : null;
    const endSection = m[4] ? parseInt(m[4], 10) : startSection;
    out.push({
      name: nm || "未命名课程",
      rawName: effectiveRaw || text.trim(),
      day: day ?? opts.fallbackDay ?? null,
      startSection: startSection ?? opts.fallbackStart ?? null,
      endSection: endSection ?? opts.fallbackEnd ?? opts.fallbackStart ?? null,
      weeksLabel: (m[1] || "").trim(),
      location
    });
  }
  return out;
}

/** 行标签「第1节-第2节」「1-2节」「第3节」→ 节次区间。 */
export function parseSectionBand(raw: string): { start: number; end: number } | null {
  const s = nfkc(raw).replace(/\s+/g, "");
  const m = /第?(\d+)\s*节?\s*[-–—~至]?\s*(?:第?(\d+)\s*节?)?/.exec(s);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  if (!Number.isFinite(start) || start < 1 || start > 30) return null;
  const end = m[2] ? parseInt(m[2], 10) : start;
  return { start, end: Math.max(end, start) };
}

/* ------------------------------------------------------------------ */
/* 网格式 / 清单式整表解析                                              */
/* ------------------------------------------------------------------ */

const GRID_DAY_RE = /^ *星期[一二三四五六日天]|^ *周[一二三四五六日天]$/;
const GRID_BAND_RE = /第\s*\d+\s*节/;

/** 网格式：找表头行（≥3 个星期列）与行标签列，逐格解析。 */
function parseGrid(rows: string[][]): TimetableSession[] {
  const sessions: TimetableSession[] = [];
  // 1. 表头行：出现 ≥3 个星期 token 的行。
  let headerRow = -1;
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const dayCols = rows[r].filter((c) => GRID_DAY_RE.test(c)).length;
    if (dayCols >= 3) {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) return sessions;

  // 2. 列 → 星期映射。
  const dayOfCol = new Map<number, number>();
  rows[headerRow].forEach((cell, c) => {
    if (GRID_DAY_RE.test(cell)) {
      const d = parseDayToken(cell);
      if (d) dayOfCol.set(c, d);
    }
  });
  if (dayOfCol.size < 3) return sessions;

  // 3. 数据行：首列（或前两列合并区域）含「第N节」标签的行。
  let seq = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length) continue;
    const labelCell = (row[0] || "") + " " + (row[1] || "");
    if (!GRID_BAND_RE.test(labelCell)) continue;
    const band = parseSectionBand(row[0] || row[1] || "");
    if (!band) continue;
    for (const [c, day] of dayOfCol) {
      const cell = (row[c] || "").trim();
      if (!cell) continue;
      for (const seg of parseCellText(cell, {
        fallbackDay: day,
        fallbackStart: band.start,
        fallbackEnd: band.end
      })) {
        if (seg.day == null || seg.startSection == null) continue;
        sessions.push(toSession(seg, `g${seq++}`));
      }
    }
  }
  return sessions;
}

/** 清单式列名同义词映射（course-schedule-viewer 的容错思路）。 */
const LIST_COLUMN_SYNONYMS: Record<string, string[]> = {
  name: ["课程名称", "课程", "课程名", "科目", "名称", "subject", "course", "name"],
  day: ["星期", "周几", "星期几", "day", "weekday"],
  startSection: ["开始节次", "起始节次", "开始节", "节次开始", "startsection"],
  endSection: ["结束节次", "结束节", "节次结束", "endsection"],
  sections: ["节次", "节", "sections"],
  weeks: ["周次", "上课周次", "周数", "weeks"],
  location: ["教室", "地点", "上课地点", "位置", "room", "location"],
  teacher: ["教师", "老师", "授课教师", "teacher"]
};

function normKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s/()（）]/g, "");
}

function parseList(rows: string[][]): TimetableSession[] {
  if (!rows.length) return [];
  // 1. 找表头行：前 10 行里命中 name + (day|sections|weeks) 的行。
  let header = -1;
  const colMap = new Map<string, number>();
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = new Map<string, number>();
    rows[r].forEach((cell, c) => {
      const k = normKey(cell);
      if (!k) return;
      for (const [field, syns] of Object.entries(LIST_COLUMN_SYNONYMS)) {
        if (syns.some((syn) => k === normKey(syn)) && !map.has(field)) {
          map.set(field, c);
        }
      }
    });
    if (map.has("name") && (map.has("day") || map.has("sections") || map.has("weeks"))) {
      header = r;
      for (const [k, v] of map) colMap.set(k, v);
      break;
    }
  }
  if (header < 0) return [];

  const sessions: TimetableSession[] = [];
  let seq = 0;
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r];
    const at = (field: string) => (colMap.has(field) ? (row[colMap.get(field)!] || "").trim() : "");
    const nameRaw = at("name");
    if (!nameRaw || normKey(nameRaw) === normKey(rows[header][colMap.get("name")!] || "")) continue;
    const day = parseDayToken(at("day"));
    const weeksLabel = at("weeks");
    if (!day && !weeksLabel) continue;

    // 节次：优先 开始/结束列；否则「节次」列文本（1-2 / 第1-2节 / 3）。
    let startSection: number | null = null;
    let endSection: number | null = null;
    const s1 = parseInt(at("startSection"), 10);
    const s2 = parseInt(at("endSection"), 10);
    if (Number.isFinite(s1) && s1 > 0) {
      startSection = s1;
      endSection = Number.isFinite(s2) && s2 >= s1 ? s2 : s1;
    } else {
      const band = parseSectionBand(at("sections"));
      if (band) {
        startSection = band.start;
        endSection = band.end;
      }
    }
    if (day == null || startSection == null) continue;

    // 时间列若存在复合串（如「4-8周 星期2 第1-2节」）则优先取其解析结果。
    const segs = parseCellText(
      `${nameRaw} ${weeksLabel} 星期${day} 第${startSection}节-第${endSection}节 ${at("location")}`
    );
    const seg = segs[0];
    sessions.push({
      id: `l${seq++}`,
      name: seg?.name || cleanCourseName(nameRaw),
      rawName: nameRaw,
      day,
      startSection,
      endSection: endSection ?? startSection,
      weeks: parseWeeksLabel(weeksLabel),
      weeksLabel,
      location: seg?.location || at("location") || "",
      teacher: at("teacher") || ""
    });
  }
  return sessions;
}

function toSession(seg: ParsedSegment, id: string): TimetableSession {
  return {
    id,
    name: seg.name,
    rawName: seg.rawName,
    day: seg.day ?? 1,
    startSection: seg.startSection ?? 1,
    endSection: seg.endSection ?? seg.startSection ?? 1,
    weeks: parseWeeksLabel(seg.weeksLabel),
    weeksLabel: seg.weeksLabel,
    location: seg.location,
    teacher: ""
  };
}

export type ImportResult = {
  sessions: TimetableSession[];
  /** 解析形态，用于预览提示。 */
  mode: "grid" | "list";
};

/** 整表解析：先试网格式，无果再试清单式；都失败返回空结果。 */
export function parseTimetableRows(rows: string[][]): ImportResult {
  const grid = parseGrid(rows);
  if (grid.length) return { sessions: dedupe(grid), mode: "grid" };
  const list = parseList(rows);
  if (list.length) return { sessions: dedupe(list), mode: "list" };
  return { sessions: [], mode: "grid" };
}

/** 同格重复粘贴 / 合并单元格导致的全等重复去除。 */
function dedupe(sessions: TimetableSession[]): TimetableSession[] {
  const seen = new Set<string>();
  return sessions.filter((s) => {
    const key = `${s.rawName}|${s.day}|${s.startSection}-${s.endSection}|${s.weeksLabel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* 学期 / 周次计算                                                      */
/* ------------------------------------------------------------------ */

export function parseISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) ? d : null;
}

export function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 指定日期所在周的周一。 */
export function mondayOf(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (r.getDay() + 6) % 7; // 0=Mon..6=Sun
  r.setDate(r.getDate() - dow);
  return r;
}

/** 距学期开始的周号（1 起）；越界钳制到 [1, totalWeeks]。 */
export function weekNumberFor(date: Date, semesterStart: string, totalWeeks: number): number {
  const start = parseISODate(semesterStart);
  if (!start || totalWeeks < 1) return 1;
  const days = Math.floor((mondayOf(date).getTime() - mondayOf(start).getTime()) / 86400000);
  return Math.min(totalWeeks, Math.max(1, Math.floor(days / 7) + 1));
}

/** 预估总周数 = 数据中最大周号（导入时给设置页一个合理默认值）。 */
export function inferTotalWeeks(sessions: TimetableSession[]): number {
  let max = 0;
  for (const s of sessions) for (const w of s.weeks) if (w > max) max = w;
  return Math.max(max, 16);
}

/** 某周生效的课程（week ∈ weeks；无周次数据的课程恒显示）。 */
export function sessionsInWeek(sessions: TimetableSession[], week: number): TimetableSession[] {
  return sessions.filter((s) => !s.weeks.length || s.weeks.includes(week));
}

/** 数据校验/补全：剔除非法行，供加载与导入共用。 */
export function sanitizeTimetableData(raw: unknown): TimetableData | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const start = typeof obj.semesterStart === "string" ? obj.semesterStart : "";
  const total =
    typeof obj.totalWeeks === "number" && obj.totalWeeks > 0 ? Math.min(Math.round(obj.totalWeeks), 60) : 20;
  const list = Array.isArray(obj.sessions) ? obj.sessions : [];
  const sessions: TimetableSession[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    const rawName = typeof s.rawName === "string" ? s.rawName.trim() : "";
    // 连名字都没有的行没有展示价值，视为脏数据丢弃。
    if (!name && !rawName) continue;
    const day = Number(s.day);
    const startSection = Number(s.startSection);
    const endSection = Number(s.endSection);
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    if (!Number.isInteger(startSection) || startSection < 1 || startSection > 30) continue;
    sessions.push({
      id: typeof s.id === "string" ? s.id : Math.random().toString(36).slice(2),
      name: name || cleanCourseName(rawName) || "未命名课程",
      rawName,
      day,
      startSection,
      endSection: Number.isInteger(endSection) && endSection >= startSection ? Math.min(endSection, 30) : startSection,
      weeks: Array.isArray(s.weeks) ? s.weeks.map(Number).filter((w) => Number.isInteger(w) && w >= 1 && w <= 60) : [],
      weeksLabel: typeof s.weeksLabel === "string" ? s.weeksLabel : "",
      location: typeof s.location === "string" ? s.location : "",
      teacher: typeof s.teacher === "string" ? s.teacher : "",
      colorOverride:
        typeof s.colorOverride === "string" && /^#[0-9a-fA-F]{6}$/.test(s.colorOverride) ? s.colorOverride : undefined
    });
  }
  if (!sessions.length) return null;
  return {
    semesterStart: parseISODate(start) ? start : toISODate(mondayOf(new Date())),
    totalWeeks: total,
    sessions,
    importedAt: typeof obj.importedAt === "number" ? obj.importedAt : Date.now()
  };
}

/** 课程配色：按名称 hash 从调色板取色（同一门课跨格同色，Wakeup 风格）。 */
export const TT_PALETTE: [string, string][] = [
  ["#5b8def", "#3f6fe0"],
  ["#38bdf8", "#0ea5e9"],
  ["#8b7cf8", "#6d5ce0"],
  ["#34d399", "#10b981"],
  ["#fbbf24", "#f59e0b"],
  ["#fb7185", "#f43f5e"],
  ["#a78bfa", "#8b5cf6"],
  ["#4dd0b1", "#14b8a6"]
];

export function courseColor(name: string): [string, string] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TT_PALETTE[h % TT_PALETTE.length];
}

/** W-020 课程取色：优先 colorOverride；覆盖色做轻微明暗推导出渐变第二色。 */
export function sessionColors(s: Pick<TimetableSession, "name" | "colorOverride">): [string, string] {
  if (s.colorOverride && /^#[0-9a-fA-F]{6}$/.test(s.colorOverride)) {
    return [s.colorOverride, shade(s.colorOverride, -0.18)];
  }
  return courseColor(s.name);
}

/** hex 颜色按比例调亮（k>0）/调暗（k<0）。 */
export function shade(hex: string, k: number): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return hex;
  const ch = Number(`0x${m[1]}`),
    cs = Number(`0x${m[2]}`),
    cl = Number(`0x${m[3]}`);
  const f = (v: number) => Math.round(Math.min(255, Math.max(0, k >= 0 ? v + (255 - v) * k : v * (1 + k))));
  return `#${[f(ch), f(cs), f(cl)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/* ------------------------------------------------------------------ */
/* W-019 多课表方案（profiles）                                         */
/* ------------------------------------------------------------------ */

export type TimetableProfile = {
  id: string;
  name: string;
  data: TimetableData;
};

/** 小组件配置里 profiles 字段的宽松形状（未 sanitize 的原始数据）。 */
export type RawProfiles = { id: string; name: string; data: unknown }[];

/**
 * 从小组件配置归一化出多方案列表。
 *
 * 兼容两代存储：
 *  - 旧版：`config.data`（单套课表）→ 包装成单方案「默认课表」；
 *  - 新版：`config.profiles` + `config.activeProfile`。
 * `config.data` 始终镜像当前激活方案，保证所有旧读取方（日历同步、
 * 设置页、导出）无需改动即正确。
 */
export function loadProfiles(cfg: Record<string, unknown>): TimetableProfile[] {
  const out: TimetableProfile[] = [];
  const rawList = Array.isArray(cfg.profiles) ? (cfg.profiles as RawProfiles) : [];
  for (const p of rawList) {
    if (!p || typeof p !== "object") continue;
    const data = sanitizeTimetableData(p.data);
    if (!data) continue;
    out.push({
      id: typeof p.id === "string" && p.id ? p.id : crypto.randomUUID(),
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "课表",
      data
    });
  }
  if (!out.length) {
    const legacy = sanitizeTimetableData(cfg.data);
    if (legacy) out.push({ id: "default", name: "默认课表", data: legacy });
  }
  return out;
}

/** 当前激活方案 id（无配置时取第一个；空列表返回空串）。 */
export function activeProfileIdOf(cfg: Record<string, unknown>, profiles: TimetableProfile[]): string {
  const want = typeof cfg.activeProfile === "string" ? cfg.activeProfile : "";
  if (want && profiles.some((p) => p.id === want)) return want;
  return profiles[0]?.id ?? "";
}

/**
 * 构造切换/编辑方案后的完整配置补丁：profiles + activeProfile + 镜像 data。
 * 所有方案写入都应经过这里，防止 data 与 profiles 失配。
 */
export function profilesPatch(
  profiles: TimetableProfile[],
  activeId: string
): { profiles: unknown; activeProfile: string; data: unknown } {
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];
  return {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, data: p.data })),
    activeProfile: active?.id ?? "",
    data: active?.data ?? null
  };
}
