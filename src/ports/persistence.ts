import type { AppState } from "../domain/schemas";

/**
 * 持久化适配器契约（六边形架构的端口）。
 * app store 维护内存工作副本，按运行时经其中一种适配器持久化：
 * 浏览器开发模式 → localStorage；Tauri 运行时 → SQLite（IPC 命令）。
 */
export interface PersistenceAdapter {
  /** 适配器标识（诊断与分支判断用）。 */
  readonly kind: "localStorage" | "sqlite";
  /** 加载持久化的应用状态；无数据返回 null。损坏数据由实现方隔离并告警。 */
  load(): Promise<Partial<AppState> | null>;
  /** 整体保存应用状态。 */
  save(state: AppState): Promise<void>;
  /** 清空全部持久化数据。 */
  clear(): Promise<void>;
}
