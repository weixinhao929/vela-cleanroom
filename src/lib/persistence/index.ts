import { isTauri } from "../tauri";
import type { PersistenceAdapter } from "../../ports/persistence";
import { localStorageAdapter } from "./local-storage";
import { sqliteAdapter, sqliteRepo } from "./sqlite";

/**
 * 按运行时选择持久化适配器（策略模式入口）。
 * Tauri 桌面环境 → SQLite 适配器；浏览器开发模式 → localStorage 适配器。
 *
 * 端口只承诺读（load + kind）。「整体保存/清空」的
 * 快照语义仅浏览器降级模式具备（LocalStorageExtras，localStorageAdapter
 * 独有实现）；SQLite 模式的写走 sqliteRepo 的行级/整表命令（store 动作层
 * 调用），不经本端口。需要 save/clear 的调用方必须先以
 * `persistence.kind === "localStorage"` 收窄。
 *
 * @returns 当前环境下应使用的 {@link PersistenceAdapter} 实例。
 *
 * @example
 * `ts
 * const repo = resolvePersistenceAdapter();
 * const loaded = await repo.load();
 * if (repo.kind === "localStorage") {
 *   // 浏览器降级模式才有的整体快照写。
 *   await localStorageAdapter.save(state);
 * }
 * `
 */
export function resolvePersistenceAdapter(): PersistenceAdapter {
  return isTauri() ? sqliteAdapter : localStorageAdapter;
}

export { localStorageAdapter, sqliteAdapter, sqliteRepo };
export type { PersistenceAdapter, LocalStorageExtras } from "../../ports/persistence";
