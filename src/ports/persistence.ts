import type { AppState } from "../domain/schemas";

/**
 * 持久化适配器契约（六边形架构的端口）。
 * app store 维护内存工作副本，按运行时经其中一种适配器持久化：
 * 浏览器开发模式 → localStorage；Tauri 运行时 → SQLite（IPC 命令）。
 *
 * 端口只承诺两种适配器都真实具备的「读」。此前接口
 * 还要求 save/clear（"整体保存应用状态"），但 SQLite 模式的写是行级命令
 * （addTask/toggleTask/…经 sqliteRepo），只能给出一个 console.warn 的假
 * save 和一个隐式清 sessions 的 clear——接口承诺了实现方给不了的语义。
 * 现在写能力收敛到仅 localStorage 实现的 {@link LocalStorageExtras}；
 * 在 sqlite 适配器上调用 save/clear 会得到编译错误而不是运行时 warn。
 */
export interface PersistenceAdapter {
  /** 适配器标识（诊断与分支判断用）。 */
  readonly kind: "localStorage" | "sqlite";
  /** 加载持久化的应用状态；无数据返回 null。损坏数据由实现方隔离并告警。 */
  load(): Promise<Partial<AppState> | null>;
}

/**
 * 「整体保存/清空」的完整快照语义只有 localStorage 降级适配器具备——浏览器
 * 模式没有行级命令，全量落盘是唯一写法。SQLite 模式的持久化由 store 动作层
 * 经 sqliteRepo 的行级命令完成，不经适配器。调用方需先以
 * `persistence.kind === "localStorage"` 收窄（或直接引用 localStorageAdapter）
 * 再调用 save/clear；类型上 SQLite 适配器不实现本接口。
 */
export interface LocalStorageExtras {
  /** 整体保存应用状态（仅 localStorage 模式支持）。 */
  save(state: AppState): Promise<void>;
  /** 清空全部持久化数据（仅 localStorage 模式支持）。 */
  clear(): Promise<void>;
}
