import type { AppState } from "../../domain/schemas";
import type { PomodoroSessionRecord } from "../../domain/pomodoro";
import { isTauri } from "../tauri";
import { pruneCorruptQuarantineCopies } from "../quarantine-prune";
import { sqliteRepo } from "./sqlite";

const LEGACY_KEY = "focus-desk.state.v1";
const LOG_KEY = "focus-desk.log.v1";
const MIGRATION_FLAG = "focus-desk.migrated.v1";

/** 迁移是否已完成（flag 存于各窗口共享的 localStorage）。 */
export function isMigrationDone(): boolean {
  try {
    return localStorage.getItem(MIGRATION_FLAG) === "1";
  } catch {
    return true;
  }
}

/**
 * legacy 快照解析失败（非法 JSON / 不过 schema）：搬到 `.corrupt-<ts>` 键留证
 * 并置位 flag。此前只是 return——既不隔离也不置位，损坏的键让 settings /
 * widget-1..N 每次启动的水合固定空等 1.5s（waitForMigration），且永不自愈；
 * localStorage 持久化模式（local-storage.ts）对同类损坏早已做 `.corrupt-` 隔离。
 */
function quarantineLegacy(
  raw: string,
  why: "json" | "schema"
): { migrated: boolean; tasks: number; deadlines: number } {
  try {
    // 写新副本前清旧隔离副本（与 settings-store/local-storage 同策略）。
    pruneCorruptQuarantineCopies(LEGACY_KEY, 1);
    localStorage.setItem(`${LEGACY_KEY}.corrupt-${Date.now()}`, raw);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.setItem(MIGRATION_FLAG, "1");
  } catch {
    // 配额/不可用：下次启动再试。
  }
  console.warn(`[migration] legacy snapshot unreadable (${why}); quarantined, skipping migration`);
  return { migrated: false, tasks: 0, deadlines: 0 };
}

/**
 * 非主窗口在读库前短暂等主窗口把一次性迁移跑完，避免读到迁移前的空表。
 * 超时（主窗口迁移失败/尚未启动）则放行，最坏退回「先空后补」的旧体验。
 *
 * @param timeoutMs - 等待上限。
 * @returns 是否在超时前看到迁移完成。
 */
export async function waitForMigration(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!isMigrationDone() && Date.now() < deadline) {
    await new Promise((r) => window.setTimeout(r, 60));
  }
  return isMigrationDone();
}

/**
 * 一次性迁移：localStorage（浏览器时代数据）→ SQLite。
 * 仅在 Tauri 运行时执行；经 zod 校验后单次 invoke `import_core_data_merge`
 * Rust 在同一事务内把 legacy 快照与库中现存行按 id 做并集合并（id 冲突
 * 时**库中现存行胜**：库行代表迁移后新建/更新的数据，legacy 浏览器快照更
 * 旧；legacy 独有的行插入），天然幂等，重复运行不产生重复行。
 * localStorage 原文永不删除，作为回滚备份；失败不置位 flag，下次启动重试。
 *
 * （迁移重设计）废除的两条旧路径：
 *  - 行数启发式（legacy 任务+DDL 不多于库中现存则整体放弃）——legacy 10
 *    任务 0 DDL vs 库 5 任务 6 DDL 时 legacy 独有的 5 条任务被永久丢弃；
 *    合并语义下无需「库是否为空」的前置判断。
 *  - 前端「list_sessions 快照 → 按 id 合并 → import_data 整表替换」——
 *    快照与替换两步之间存在跨窗口竞态（轮在 CSV 导入路径修过的同一
 *    模式），且 import_data 是 settings 专用命令，从跑迁移的 widget-0
 *    调用会拿到 Denied。
 *
 * @returns `migrated` 是否实际迁移、`tasks`/`deadlines` 迁移条数
 *          （未迁移时均为 0）。
 * @throws 无（内部捕获迁移错误并记日志）。
 *
 * @example
 * `ts
 * const r = await migrateLocalStorageToSqlite();
 * if (r.migrated) console.log(`已迁移 ${r.tasks} 条任务`);
 * `
 */
export async function migrateLocalStorageToSqlite(): Promise<{ migrated: boolean; tasks: number; deadlines: number }> {
  if (!isTauri()) {
    return { migrated: false, tasks: 0, deadlines: 0 };
  }
  // Already migrated in a previous launch.
  if (localStorage.getItem(MIGRATION_FLAG) === "1") {
    return { migrated: false, tasks: 0, deadlines: 0 };
  }

  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATION_FLAG, "1");
    return { migrated: false, tasks: 0, deadlines: 0 };
  }

  let legacy: Partial<AppState>;
  try {
    // zod 校验走动态 import：schemas 连带 zod 只在 legacy 迁移这一条冷路径
    // 上需要，静态引入会让整个 zod（约 69KB 未压缩）打进首屏主包。
    const { AppStateSchema } = await import("../../domain/schemas");
    const parsed = AppStateSchema.partial().safeParse(JSON.parse(raw));
    if (!parsed.success) return quarantineLegacy(raw, "schema");
    legacy = parsed.data as Partial<AppState>;
  } catch {
    return quarantineLegacy(raw, "json");
  }

  const tasks = legacy.tasks ?? [];
  const deadlines = legacy.deadlines ?? [];

  // also migrate the browser-era focus log (sessions), which was never
  // carried over before, so a switch to desktop no longer zeroes focus history.
  // 逐条形状过滤——Rust PomodoroSession 无 serde 默认值，此前只查
  // Array.isArray，一条畸形旧日志（缺字段/类型错）会让整个 mergeCoreData
  // 反序列化失败 → 迁移 flag 不置位 → 每次启动重试、tasks/deadlines 也一
  // 并搬不过去。丢弃坏行并 warn，不让单行炸掉整次合并。
  let sessions: PomodoroSessionRecord[] = [];
  try {
    const logRaw = localStorage.getItem(LOG_KEY);
    if (logRaw) {
      const parsed = JSON.parse(logRaw) as { sessions?: unknown[] };
      if (Array.isArray(parsed.sessions)) {
        const shapeOk = (r: unknown): r is PomodoroSessionRecord =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as PomodoroSessionRecord).id === "string" &&
          typeof (r as PomodoroSessionRecord).type === "string" &&
          typeof (r as PomodoroSessionRecord).mode === "string" &&
          typeof (r as PomodoroSessionRecord).startedAt === "string" &&
          typeof (r as PomodoroSessionRecord).endedAt === "string" &&
          typeof (r as PomodoroSessionRecord).plannedSeconds === "number" &&
          typeof (r as PomodoroSessionRecord).completed === "boolean";
        const rows = parsed.sessions;
        sessions = rows.filter(shapeOk);
        const dropped = rows.length - sessions.length;
        if (dropped > 0) {
          console.warn(`[migration] dropped ${dropped} malformed legacy session row(s)`);
        }
      }
    }
  } catch {
    sessions = [];
  }

  try {
    // （迁移重设计）：单次 invoke 走 Rust 单事务合并（库中行胜 + legacy
    // 独有行插入），不再做前端快照/行数比较——幂等且无跨窗口竞态。经
    // 写链排队，防与启动期在飞的行级写交错。PomodoroSession 的唯一性判定
    // 字段就是 id（前端 crypto.randomUUID 生成，Rust 表主键同字段）。
    await sqliteRepo.mergeCoreData({ tasks, deadlines, sessions });
  } catch (err) {
    // Failure must not be silent or half-marked: keep localStorage, log, and
    // retry on the next launch (flag is intentionally left unset).
    console.error("[migration] localStorage→SQLite migration failed, will retry:", err);
    return { migrated: false, tasks: 0, deadlines: 0 };
  }

  // Mark migrated. localStorage is intentionally kept as a rollback backup.
  localStorage.setItem(MIGRATION_FLAG, "1");
  return { migrated: true, tasks: tasks.length, deadlines: deadlines.length };
}
