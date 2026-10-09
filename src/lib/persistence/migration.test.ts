import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("../tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true
}));

import { migrateLocalStorageToSqlite } from "./migration";

const LEGACY_KEY = "focus-desk.state.v1";
const LOG_KEY = "focus-desk.log.v1";
const MIGRATION_FLAG = "focus-desk.migrated.v1";

/**
 * （迁移重设计）：迁移收口为「解析 legacy → 单次 invoke import_core_data_merge」。
 * 断言重点是形状而非 Rust 合并结果（后者由 repositories.rs 的合并测试覆盖）：
 *  - 无行数启发式的前置读库（不再 list_tasks/list_deadlines/list_sessions）；
 *  - 恰好一次 IPC，载荷 = legacy 三表全量；
 *  - flag 语义不变：成功/无快照/损坏隔离三种路径置位，失败保持未置位待重试。
 */
describe("migrateLocalStorageToSqlite（G1 迁移重设计）", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ tasks: 1, deadlines: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedLegacy() {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        tasks: [
          {
            id: "t1",
            title: "浏览器时代的任务",
            completed: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            dueAt: "",
            priority: 0,
            tags: [],
            sortOrder: 0
          }
        ],
        deadlines: []
      })
    );
  }

  it("合法快照：恰好一次 import_core_data_merge（含 LOG_KEY 会话），成功置位 flag", async () => {
    seedLegacy();
    localStorage.setItem(
      LOG_KEY,
      JSON.stringify({
        sessions: [
          {
            id: "s1",
            type: "focus",
            mode: "focus",
            startedAt: "2026-01-01T01:00:00.000Z",
            endedAt: "2026-01-01T01:25:00.000Z",
            plannedSeconds: 1500,
            completed: true,
            taskId: null,
            eventLabel: null
          }
        ]
      })
    );

    const r = await migrateLocalStorageToSqlite();

    expect(r).toEqual({ migrated: true, tasks: 1, deadlines: 0 });
    // 单次 IPC：行数启发式与 list_sessions 快照读都已废除（合并全在 Rust 事务内）。
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("import_core_data_merge");
    expect(payload.data.tasks).toEqual([
      {
        id: "t1",
        title: "浏览器时代的任务",
        completed: false,
        created_at: "2026-01-01T00:00:00.000Z",
        due_at: "",
        priority: 0,
        tags: "[]",
        sort_order: 0
      }
    ]);
    expect(payload.data.sessions).toEqual([
      {
        id: "s1",
        session_type: "focus",
        mode: "focus",
        started_at: "2026-01-01T01:00:00.000Z",
        ended_at: "2026-01-01T01:25:00.000Z",
        planned_seconds: 1500,
        completed: true,
        task_id: null,
        event_label: null
      }
    ]);
    // 合并模式不携带设置/中断：Rust 侧对两者整体忽略。
    expect(payload.data.settings).toBeUndefined();
    expect(payload.data.interruptions).toBeUndefined();
    expect(localStorage.getItem(MIGRATION_FLAG)).toBe("1");
    // localStorage 原文保留作回滚备份。
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it("flag 已置位：直接跳过，不发起任何 IPC（startOver 约束：语义不动）", async () => {
    localStorage.setItem(MIGRATION_FLAG, "1");
    seedLegacy();
    const r = await migrateLocalStorageToSqlite();
    expect(r).toEqual({ migrated: false, tasks: 0, deadlines: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("无 legacy 快照：置位 flag、不迁移", async () => {
    const r = await migrateLocalStorageToSqlite();
    expect(r).toEqual({ migrated: false, tasks: 0, deadlines: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(MIGRATION_FLAG)).toBe("1");
  });

  it("库非空场景同样单次合并 invoke：行数启发式（legacy 不多于库则放弃）已废除", async () => {
    // 旧实现此处会先 list_tasks/list_deadlines 做行数比较，legacy 10 任务
    // 0 DDL vs 库 5 任务 6 DDL 时 legacy 被永久放弃；现在无条件交给 Rust
    // 按 id 并集（库中行胜 + legacy 独有行插入）。
    seedLegacy();
    const r = await migrateLocalStorageToSqlite();
    expect(r.migrated).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("import_core_data_merge");
  });

  it("损坏快照：隔离为 .corrupt- 副本并置位 flag，不触碰库", async () => {
    localStorage.setItem(LEGACY_KEY, "{not valid json");
    const r = await migrateLocalStorageToSqlite();
    expect(r).toEqual({ migrated: false, tasks: 0, deadlines: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(MIGRATION_FLAG)).toBe("1");
    const corruptKeys = Object.keys(localStorage).filter((k) => k.startsWith(`${LEGACY_KEY}.corrupt-`));
    expect(corruptKeys).toHaveLength(1);
    expect(localStorage.getItem(corruptKeys[0])).toBe("{not valid json");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("invoke 失败：不置位 flag（下次启动重试），报错记日志", async () => {
    seedLegacy();
    invokeMock.mockRejectedValue(new Error("untrusted window"));
    const r = await migrateLocalStorageToSqlite();
    expect(r).toEqual({ migrated: false, tasks: 0, deadlines: 0 });
    expect(localStorage.getItem(MIGRATION_FLAG)).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});
