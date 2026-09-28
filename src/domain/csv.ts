import type { Deadline, Task } from "./schemas";

/**
 * CSV serialization/parsing for tasks and deadlines. Pure and side-effect free
 * so it can be unit tested. Used for lightweight data exchange (Phase 1.2);
 * JSON remains the canonical full-backup format.
 */

function escapeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 导出前缀 UTF-8 BOM：Windows Excel 双击打开无 BOM 的 UTF-8 CSV 会按本地
 *  代码页解码，中文标题全部乱码。解析侧（parseCsv）本就会剥掉 BOM，往返无损。 */
const BOM = "\uFEFF";

/** CSV 里的整数列：`"1.7"` 之类经 Number() 会通过，但 schema 要求 int、Rust 侧
 *  是 i64，反序列化失败会让整批导入 / 下次启动校验整体失败——取整并夹在范围内。 */
function intField(raw: string | undefined, min: number, max: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

/**
 * 任务导出为 CSV（A-10：全字段导出，标签 JSON 编码进单格，往返不丢
 * 截止/优先级/排序）。含引号/逗号/换行的字段按 RFC 4180 转义。
 *
 * @param tasks - 待办数组。
 * @returns CSV 文本（首行为表头，LF 换行）。
 *
 * @example
 * ```ts
 * downloadTextFile("tasks.csv", tasksToCsv(tasks));
 * ```
 */
export function tasksToCsv(tasks: Task[]): string {
  const header = ["id", "title", "completed", "createdAt", "dueAt", "priority", "tags", "sortOrder"];
  const rows = tasks.map((t) => [
    t.id,
    t.title,
    String(t.completed),
    t.createdAt,
    t.dueAt ?? "",
    String(t.priority ?? 0),
    JSON.stringify(t.tags ?? []),
    String(t.sortOrder ?? 0)
  ]);
  return BOM + [header, ...rows].map((r) => r.map(escapeField).join(",")).join("\n");
}

/**
 * 截止提醒导出为 CSV（全字段：多档提醒/周期规则）。
 *
 * @param deadlines - 截止数组。
 * @returns CSV 文本（首行为表头）。
 */
export function deadlinesToCsv(deadlines: Deadline[]): string {
  const header = ["id", "title", "dueAt", "notified", "completed", "notifiedTiers", "repeat"];
  const rows = deadlines.map((d) => [
    d.id,
    d.title,
    d.dueAt,
    String(d.notified),
    String(d.completed),
    JSON.stringify(d.notifiedTiers ?? []),
    d.repeat ?? "none"
  ]);
  return BOM + [header, ...rows].map((r) => r.map(escapeField).join(",")).join("\n");
}

function parseCsv(raw: string): string[][] {
  // P7: Excel 导出的 CSV 常带 UTF-8 BOM（\uFEFF），若不清除会被吞进第一列
  // header（"\uFEFFid"）导致 colIndex 全 -1、整批数据解析出错。
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && raw[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function colIndex(header: string[], name: string): number {
  return header.indexOf(name);
}

/** P7: 校验日期字段是否为合法可解析时间，并归一化为 ISO 8601（UTC + Z 毫秒）。
    斜杠 / 空格分隔等非 ISO 写法也会被 `Date.parse` 接受，必须归一写入，
    否则宽松日期入库后会在下次启动的 schema 校验中整体失败（A-3/E-1）。 */
function validDate(value: string | undefined): string {
  if (!value) return "";
  const t = Date.parse(value);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

/**
 * 解析任务 CSV 为 Task 数组（容错：缺列取默认、无效行跳过、id 缺失自动
 * 生成、日期归一为 ISO）。宽松解析——尽力恢复每一条可用的数据。
 *
 * @param raw - CSV 原文。
 * @returns 解析出的任务数组（title 为空的行被丢弃）。
 *
 * @example
 * ```ts
 * const imported = parseTasksCsv(csvText);
 * ```
 */
export function parseTasksCsv(raw: string): Task[] {
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];
  const [header, ...data] = rows;
  const iId = colIndex(header, "id");
  const iTitle = colIndex(header, "title");
  const iCompleted = colIndex(header, "completed");
  const iCreated = colIndex(header, "createdAt");
  const iDue = colIndex(header, "dueAt");
  const iPriority = colIndex(header, "priority");
  const iTags = colIndex(header, "tags");
  const iSort = colIndex(header, "sortOrder");
  const tasks: Task[] = [];
  for (const r of data) {
    if (r.length === 0) continue;
    const title = (iTitle >= 0 ? r[iTitle] : "") ?? "";
    if (!title.trim()) continue;
    const createdAt = validDate(iCreated >= 0 ? r[iCreated] : "");
    const priority = iPriority >= 0 ? intField(r[iPriority], 0, 3) : 0;
    const sortOrder = iSort >= 0 ? intField(r[iSort], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) : 0;
    const tags = iTags >= 0 && r[iTags] ? parseStringList(r[iTags]) : [];
    tasks.push({
      id: iId >= 0 && r[iId] ? r[iId] : crypto.randomUUID(),
      title,
      completed: iCompleted >= 0 && r[iCompleted] === "true",
      createdAt: createdAt || new Date().toISOString(),
      dueAt: iDue >= 0 ? validDate(r[iDue]) : "",
      priority,
      tags,
      sortOrder
    });
  }
  return tasks;
}

/**
 * 解析截止 CSV 为 Deadline 数组（容错语义同 {@link parseTasksCsv}）。
 *
 * @param raw - CSV 原文。
 * @returns 解析出的截止数组（title 为空的行被丢弃）。
 */
export function parseDeadlinesCsv(raw: string): Deadline[] {
  const rows = parseCsv(raw);
  if (rows.length === 0) return [];
  const [header, ...data] = rows;
  const iId = colIndex(header, "id");
  const iTitle = colIndex(header, "title");
  const iDue = colIndex(header, "dueAt");
  const iNotified = colIndex(header, "notified");
  const iCompleted = colIndex(header, "completed");
  const iTiers = colIndex(header, "notifiedTiers");
  const iRepeat = colIndex(header, "repeat");
  const deadlines: Deadline[] = [];
  for (const r of data) {
    if (r.length === 0) continue;
    const title = (iTitle >= 0 ? r[iTitle] : "") ?? "";
    const dueAt = validDate(iDue >= 0 ? r[iDue] : "");
    if (!title.trim() || !dueAt) continue;
    const repeatRaw = iRepeat >= 0 ? r[iRepeat] : "none";
    const repeat =
      repeatRaw === "daily" || repeatRaw === "weekly" || repeatRaw === "monthly" || repeatRaw === "yearly"
        ? repeatRaw
        : "none";
    deadlines.push({
      id: iId >= 0 && r[iId] ? r[iId] : crypto.randomUUID(),
      title,
      dueAt,
      notified: iNotified >= 0 && r[iNotified] === "true",
      completed: iCompleted >= 0 && r[iCompleted] === "true",
      notifiedTiers: iTiers >= 0 && r[iTiers] ? parseStringList(r[iTiers]) : [],
      repeat
    });
  }
  return deadlines;
}

/** Parse a JSON-encoded string array cell, tolerating malformed/legacy values. */
function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
