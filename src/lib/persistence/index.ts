import { isTauri } from "../tauri";
import type { PersistenceAdapter } from "../../ports/persistence";
import { localStorageAdapter } from "./local-storage";
import { sqliteAdapter, sqliteRepo } from "./sqlite";

/**
 * 按运行时选择持久化适配器（策略模式入口）。
 * Tauri 桌面环境 → SQLite 适配器；浏览器开发模式 → localStorage 适配器。
 *
 * @returns 当前环境下应使用的 {@link PersistenceAdapter} 实例。
 *
 * @example
 * ```ts
 * const repo = resolvePersistenceAdapter();
 * await repo.save(state);
 * ```
 */
export function resolvePersistenceAdapter(): PersistenceAdapter {
  return isTauri() ? sqliteAdapter : localStorageAdapter;
}

export { localStorageAdapter, sqliteAdapter, sqliteRepo };
export type { PersistenceAdapter } from "../../ports/persistence";
