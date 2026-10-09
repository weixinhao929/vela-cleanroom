import { mondayOf, parseISODate, toISODate, type TimetableData, type TimetableSession } from "./timetable";

/* ------------------------------------------------------------------ */
/* 极小 xlsx 生成器（STORED zip + CRC32，无任何第三方依赖）             */
/* ------------------------------------------------------------------ */

const DAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

/** 标准 CRC32（IEEE 802.3）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

/** 组装 zip 中央目录与 end-of-central-directory。 */
function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + nameBuf.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, e.data.length, true);
    dv.setUint32(22, e.data.length, true);
    dv.setUint16(26, nameBuf.length, true);
    local.set(nameBuf, 30);
    parts.push(local, e.data);

    const cd = new Uint8Array(46 + nameBuf.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central directory signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0x0800, true); // bit flag
    cdv.setUint16(10, 0, true); // method
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x21, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, e.data.length, true);
    cdv.setUint32(24, e.data.length, true);
    cdv.setUint16(28, nameBuf.length, true);
    cdv.setUint32(42, offset, true); // local header offset
    cd.set(nameBuf, 46);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const centralStart = offset;
  const centralBlob = concat(central);
  const count = entries.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralBlob.length, true);
  ev.setUint32(16, centralStart, true);
  return concat([...parts, centralBlob, eocd]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "&#10;");

/* ------------------------------------------------------------------ */
/* 课表 → xlsx 工作簿组装                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成海绵式课表工作簿：Sheet「课程列表」为清单（每行一门课），
 * Sheet「周视图」为星期×节次的网格（当前周，跨节课程合并单元格），
 * Sheet「汇总」为学期与冲突统计。这三个 sheet 足够 Excel/WPS 打开。
 */
export function buildTimetableXlsx(data: TimetableData, sectionTimes: string[], viewWeek: number): Uint8Array {
  const sessions = data.sessions;
  const sorted = [...sessions].sort((a, b) => a.day - b.day || a.startSection - b.startSection);
  const conflicts = findConflictPairs(sessions);
  const maxSection = Math.min(30, Math.max(6, ...sessions.map((s) => s.endSection)));
  const start = parseISODate(data.semesterStart);
  const base = start ? mondayOf(start) : null;

  // ---- Sheet 1: 课程列表 ----
  const listRows: string[][] = [
    ["课程", "星期", "节次", "周次", "地点", "教师"],
    ...sorted.map((s) => [
      s.name,
      `星期${DAY_NAMES[s.day - 1]}`,
      s.startSection === s.endSection ? String(s.startSection) : `${s.startSection}-${s.endSection}`,
      s.weeksLabel || `1-${data.totalWeeks}周`,
      s.location || "",
      s.teacher || ""
    ])
  ];

  // ---- Sheet 2: 周视图（当前周网格） ----
  const grid: string[][] = [];
  const head = ["节次"];
  for (let d = 0; d < 7; d++) {
    let label = `星期${DAY_NAMES[d]}`;
    if (base) {
      const day = new Date(base);
      day.setDate(base.getDate() + (viewWeek - 1) * 7 + d);
      label += `\n${day.getMonth() + 1}/${day.getDate()}`;
    }
    head.push(label);
  }
  grid.push(head);
  for (let sec = 1; sec <= maxSection; sec++) {
    const row = [sectionTimes[sec - 1] ? `第${sec}节 ${sectionTimes[sec - 1]}` : `第${sec}节`];
    for (let d = 1; d <= 7; d++) {
      const cell = sessions
        // 审计修复：周视图必须过滤当前查看周——单双周互斥课（weeks 不相交）
        // 否则会被拼进同一格；空 weeks 视为每周都上（与 sessionsInWeek 同口径）。
        .filter((s) => s.day === d && s.startSection === sec && (s.weeks.length === 0 || s.weeks.includes(viewWeek)))
        .map((s) => s.name + (s.location ? ` (${s.location})` : ""))
        .join("\n");
      row.push(cell);
    }
    grid.push(row);
  }

  // ---- Sheet 3: 汇总 ----
  const summary: string[][] = [
    ["学期第一周周一", data.semesterStart],
    ["总周数", String(data.totalWeeks)],
    ["课程数", String(sessions.length)],
    ["冲突数量", String(conflicts.length)],
    ["导出时间", new Date().toLocaleString("zh-CN", { hour12: false })]
  ];
  if (conflicts.length) {
    summary.push([""], ["冲突课程对"]);
    for (const c of conflicts.slice(0, 20)) {
      summary.push([`星期${DAY_NAMES[c.day - 1]}`, `${c.a.name} ↔ ${c.b.name}`]);
    }
  }

  const sheetXml = (id: number, rows: string[][]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            const isNum = v !== "" && /^-?\d+(\.\d+)?$/.test(v);
            return v === ""
              ? `<c r="${ref}"/>`
              : `<c r="${ref}"${isNum ? "" : ` t="inlineStr"`}>${
                  isNum ? `<v>${v}</v>` : `<is><t xml:space="preserve">${xmlEscape(v)}</t></is>`
                }</c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("")}</sheetData></worksheet>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    `<sheet name="课程列表" sheetId="1" r:id="rId1"/>` +
    `<sheet name="周视图" sheetId="2" r:id="rId2"/>` +
    `<sheet name="汇总" sheetId="3" r:id="rId3"/>` +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>` +
    `</Relationships>`;

  const zipData = buildZip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml(1, listRows)) },
    { name: "xl/worksheets/sheet2.xml", data: enc.encode(sheetXml(2, grid)) },
    { name: "xl/worksheets/sheet3.xml", data: enc.encode(sheetXml(3, summary)) }
  ]);
  return zipData;
}

/** 列名：A, B, …, Z, AA, …（最多 26*26 列足够）。 */
function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 全表两两冲突对（与 timetable-extras 的 findConflicts 语义一致，避免循环依赖）。 */
function findConflictPairs(sessions: TimetableSession[]): { a: TimetableSession; b: TimetableSession; day: number }[] {
  const out: { a: TimetableSession; b: TimetableSession; day: number }[] = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (a.day !== b.day) continue;
      if (a.startSection > b.endSection || b.startSection > a.endSection) continue;
      // 空周次 = 每周都上（与 timetable.weekMatches 同口径）：任一方为空即交叠。
      const bothNonEmpty = a.weeks.length > 0 && b.weeks.length > 0;
      const weeks = bothNonEmpty ? a.weeks.filter((w) => b.weeks.includes(w)) : a.weeks.length ? a.weeks : b.weeks;
      if (weeks.length || !bothNonEmpty) out.push({ a, b, day: a.day });
    }
  }
  return out;
}

/** 触发浏览器下载 .xlsx。 */
export function downloadTimetableXlsx(
  data: TimetableData,
  sectionTimes: string[],
  viewWeek: number,
  filename = `timetable-${toISODate(new Date())}.xlsx`
): void {
  const bytes = buildTimetableXlsx(data, sectionTimes, viewWeek);
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
