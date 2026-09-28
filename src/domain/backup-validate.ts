/**
 * 完整备份文件的前置校验与版本迁移（S2）。
 *
 * 为什么必须有：恢复流程原先只检查 `Array.isArray(data.tasks)`，随后就
 * 把整个对象灌进 `import_data` 并**清空覆盖** localStorage。一旦文件是
 * 别的应用的 JSON、被截断的半个文件、或未来版本的新结构，用户的现有
 * 数据已经被覆盖、而新数据是残缺的 —— 这是不可逆的数据丢失。
 *
 * 因此恢复必须遵守「先全量校验，再落地」：任何一条不通过就整体拒绝，
 * 绝不做部分导入。
 *
 * 版本策略：
 *  - 备份文件带 `schemaVersion`（当前 2）。
 *  - 无该字段的旧文件视为 v1，走迁移链补齐字段。
 *  - 高于当前版本的文件拒绝导入（旧客户端读不懂新结构，强行导入会丢字段）。
 */

/** 当前备份结构版本。新增不兼容字段时 +1 并补一条迁移。 */
export const BACKUP_SCHEMA_VERSION = 2;

/** 校验通过的备份负载。字段与 `import_data` 命令的入参一一对应。
    `sessions` / `interruptions` 可选：缺失 = 旧备份没带该字段，恢复时不触碰
    库中现有记录（Rust 侧 `None` = 不 DELETE）；显式空数组才是"清空"。 */
export interface BackupPayload {
  schemaVersion: number;
  tasks: unknown[];
  deadlines: unknown[];
  sessions?: unknown[];
  settings: unknown[];
  interruptions?: unknown[];
}

/** 校验结果：要么给出可安全导入的负载，要么给出可读的拒绝原因。 */
export type ValidateResult = { ok: true; payload: BackupPayload; warnings: string[] } | { ok: false; reason: string };

/** 顶层必须是普通对象（不是数组、不是 null）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 数组字段校验：允许缺失（视为空数组），但存在时必须是数组。
 * 返回 `null` 表示类型错误。
 */
function readArray(obj: Record<string, unknown>, key: string): unknown[] | null {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : null;
}

/** 每条记录都应是对象；混入字符串/数字说明文件已损坏。 */
function allObjects(list: unknown[]): boolean {
  return list.every((x) => isPlainObject(x));
}

/**
 * v1 → v2 迁移。
 *
 * v1 备份没有 `schemaVersion`，且 `sessions` / `settings` 可能整体缺失
 * （早期版本只导出 tasks 与 deadlines）。迁移只做补齐，不改动已有数据。
 * `settings` 走 UPSERT，补成 `[]` 无副作用；`sessions` **不能**补 `[]`——
 * Rust 侧对 `Some([])` 是"先 DELETE 再插入 0 条"，恢复一份合法的 v1 备份
 * 会把用户全部专注历史清空。缺失就保持缺失（= 保留现有记录）。
 */
function migrateV1ToV2(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    ...obj,
    schemaVersion: 2,
    settings: Array.isArray(obj.settings) ? obj.settings : []
  };
}

/** 迁移链：索引即"从该版本升到下一版本"的函数。 */
const MIGRATIONS: Array<(o: Record<string, unknown>) => Record<string, unknown>> = [
  migrateV1ToV2 // 1 → 2
];

/**
 * 校验并（必要时）迁移一个已 `JSON.parse` 的备份对象。
 *
 * 只做结构与类型层面的校验；单条记录的字段级校验交给 Rust 侧
 * `import_data`（它有权威的表结构定义）。这里的目标是挡住"根本不是
 * 备份文件"和"版本读不懂"这两类会造成数据丢失的情况。
 */
export function validateBackup(parsed: unknown): ValidateResult {
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "备份文件的顶层结构不是对象" };
  }

  // 版本判定：缺失即 v1（历史文件）。
  const rawVersion = parsed.schemaVersion;
  let version: number;
  if (rawVersion === undefined || rawVersion === null) {
    version = 1;
  } else if (typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 1) {
    version = rawVersion;
  } else {
    return { ok: false, reason: "备份文件的版本号无效" };
  }

  if (version > BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `备份文件版本（v${version}）高于当前应用支持的版本（v${BACKUP_SCHEMA_VERSION}），请先更新应用`
    };
  }

  // tasks 是备份的必需字段：完全没有它基本可以断定不是本应用的备份。
  if (!Array.isArray(parsed.tasks)) {
    return { ok: false, reason: "备份文件缺少任务数据（tasks）" };
  }

  // 逐版本迁移到当前版本。
  let obj: Record<string, unknown> = parsed;
  const warnings: string[] = [];
  while (version < BACKUP_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version - 1];
    if (!migrate) {
      return { ok: false, reason: `缺少 v${version} 到 v${version + 1} 的迁移路径` };
    }
    obj = migrate(obj);
    warnings.push(`已从 v${version} 迁移到 v${version + 1}`);
    version += 1;
  }

  // 三个必带数组字段的类型校验。任一不通过即整体拒绝。
  const tasks = readArray(obj, "tasks");
  const deadlines = readArray(obj, "deadlines");
  const settings = readArray(obj, "settings");
  const fields: Array<[string, unknown[] | null]> = [
    ["tasks", tasks],
    ["deadlines", deadlines],
    ["settings", settings]
  ];
  for (const [name, list] of fields) {
    if (list === null) return { ok: false, reason: `备份文件的 ${name} 字段不是数组` };
    if (!allObjects(list)) return { ok: false, reason: `备份文件的 ${name} 中存在损坏的记录` };
  }

  // sessions / interruptions 是可选字段：缺失/为 null = 不带（旧备份，恢复时
  // 保留现有记录）；存在则必须是全对象的数组。
  const readOptional = (key: string): { ok: true; list: unknown[] | undefined } | { ok: false; reason: string } => {
    const raw = obj[key];
    if (raw === undefined || raw === null) return { ok: true, list: undefined };
    if (!Array.isArray(raw)) return { ok: false, reason: `备份文件的 ${key} 字段不是数组` };
    if (!allObjects(raw)) return { ok: false, reason: `备份文件的 ${key} 中存在损坏的记录` };
    return { ok: true, list: raw };
  };
  const sessionsRead = readOptional("sessions");
  if (!sessionsRead.ok) return sessionsRead;
  const sessions = sessionsRead.list;
  const interruptionsRead = readOptional("interruptions");
  if (!interruptionsRead.ok) return interruptionsRead;
  const interruptions = interruptionsRead.list;

  // 全空文件几乎肯定是误选或导出失败的产物，恢复它等于清空所有数据。
  const totalRecords =
    tasks!.length + deadlines!.length + (sessions?.length ?? 0) + settings!.length + (interruptions?.length ?? 0);
  if (totalRecords === 0) {
    return { ok: false, reason: "备份文件不包含任何记录，恢复会清空现有数据" };
  }

  return {
    ok: true,
    warnings,
    payload: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      tasks: tasks!,
      deadlines: deadlines!,
      settings: settings!,
      ...(sessions !== undefined ? { sessions } : {}),
      ...(interruptions !== undefined ? { interruptions } : {})
    }
  };
}

/**
 * 解析原始备份文本并校验（JSON 语法错误也归一为可读 reason）。
 *
 * @param raw - 备份文件原文。
 * @returns `{ok:true, payload, warnings}` 或 `{ok:false, reason}`。
 * @throws 无。
 *
 * @example
 * ```ts
 * const r = parseAndValidateBackup(fileText);
 * if (!r.ok) showError(r.reason);
 * ```
 */
export function parseAndValidateBackup(raw: string): ValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "文件不是有效的 JSON，可能已损坏或被截断" };
  }
  return validateBackup(parsed);
}

/**
 * 生成备份摘要文本（恢复前确认框用，告知将导入多少数据）。
 *
 * @param p - 校验通过的备份载荷。
 * @returns 形如 `"任务 12 · DDL 3 · 专注记录 240 · 设置项 86"` 的单行文本。
 */
export function describeBackup(p: BackupPayload): string {
  const parts = [
    `任务 ${p.tasks.length}`,
    `DDL ${p.deadlines.length}`,
    p.sessions !== undefined ? `专注记录 ${p.sessions.length}` : "专注记录 保留现有",
    `设置项 ${p.settings.length}`
  ];
  if (p.interruptions !== undefined) parts.push(`中断记录 ${p.interruptions.length}`);
  return parts.join(" · ");
}
