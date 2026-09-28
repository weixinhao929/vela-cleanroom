import type { AppState } from "../../domain/schemas";
import type { PomodoroSessionRecord } from "../../domain/pomodoro";
import { isTauri } from "../tauri";
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
 * 仅在 Tauri 运行时执行；经 zod 校验后走事务性 replaceCoreData（含任务/
 * 截止/专注日志全字段）。行数比较决定是否重迁（legacy 更多则整体替换）；
 * localStorage 原文永不删除，作为回滚备份；失败不置位 flag，下次启动重试。
 *
 * @returns `migrated` 是否实际迁移、`tasks`/`deadlines` 迁移条数
 *          （未迁移时均为 0）。
 * @throws 无（内部捕获迁移错误并记日志）。
 *
 * @example
 * ```ts
 * const r = await migrateLocalStorageToSqlite();
 * if (r.migrated) console.log(`已迁移 ${r.tasks} 条任务`);
 * ```
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

  // Only migrate if SQLite is currently empty (avoid duplicates on re-run).
  // P2（审计修复）：此前"非空即跳过并置位 flag"会永久放弃更新的 legacy 数据
  // ——若上次迁移半途留下部分行，或用户从备份恢复了另一台机器的数据，本地
  // 更完整的 legacy 快照被静默丢弃。改为行数比较：legacy 更多时仍执行整体
  // 替换（replaceCoreData 是事务性的，不会留下混合态）。
  const existing = await sqliteRepo.count();
  if (existing > 0 && tasks.length + deadlines.length <= existing) {
    localStorage.setItem(MIGRATION_FLAG, "1");
    return { migrated: false, tasks: 0, deadlines: 0 };
  }

  // A-2: also migrate the browser-era focus log (sessions), which was never
  // carried over before, so a switch to desktop no longer zeroes focus history.
  let sessions: PomodoroSessionRecord[] = [];
  try {
    const logRaw = localStorage.getItem(LOG_KEY);
    if (logRaw) {
      const parsed = JSON.parse(logRaw) as { sessions?: PomodoroSessionRecord[] };
      sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    }
  } catch {
    sessions = [];
  }

  try {
    // A-2: route through the serialized write chain (replaceCoreData) instead of
    // a raw invoke("import_data"), so an in-flight row write can't interleave
    // with the whole-table import. Tasks/deadlines carry their full field set
    // (due/priority/tags/sortOrder + completed/tiers/repeat) — no more drops.
    await sqliteRepo.replaceCoreData({ tasks, deadlines, sessions });
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
