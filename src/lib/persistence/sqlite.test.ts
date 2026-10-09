import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("../tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

import { sqliteRepo } from "./sqlite";
import { useDbVersion } from "../db-signal";
import { renderHook } from "@testing-library/react";

describe("sqliteRepo.addSession / addInterruption（时间串归一化 + 写落地信号）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("addSession 把偏移时区/秒精度串归一化为 UTC-Z 毫秒形态（字典序保留裁剪的前提）", async () => {
    invokeMock.mockResolvedValue(null);
    await sqliteRepo.addSession({
      id: "s1",
      type: "focus",
      mode: "focus",
      startedAt: "2026-08-16T09:00:00+08:00",
      endedAt: "2026-08-16T09:25:00.000+08:00",
      plannedSeconds: 1500,
      completed: true,
      taskId: null,
      eventLabel: null
    });
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("add_session");
    expect(payload.session.started_at).toBe("2026-08-16T01:00:00.000Z");
    expect(payload.session.ended_at).toBe("2026-08-16T01:25:00.000Z");
  });

  it("addSession 成功后 bump 写落地信号（统计面板读不排队竞态的补读触发器）", async () => {
    const before = renderHook(() => useDbVersion()).result.current;
    invokeMock.mockResolvedValue(null);
    await sqliteRepo.addSession({
      id: "s2",
      type: "focus",
      mode: "focus",
      startedAt: "2026-08-16T01:00:00.000Z",
      endedAt: "2026-08-16T01:25:00.000Z",
      plannedSeconds: 1500,
      completed: true,
      taskId: null,
      eventLabel: null
    });
    const after = renderHook(() => useDbVersion()).result.current;
    expect(after).toBeGreaterThan(before);
  });

  it("addInterruption 同样归一化时间串并 bump 信号", async () => {
    const before = renderHook(() => useDbVersion()).result.current;
    invokeMock.mockResolvedValue(null);
    await sqliteRepo.addInterruption({
      startedAt: "2026-08-16T09:00:00+08:00",
      endedAt: "2026-08-16T09:05:00+08:00",
      reason: "电话",
      mode: "focus",
      elapsedSeconds: 300
    });
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("add_interruption");
    expect(payload.interruption.started_at).toBe("2026-08-16T01:00:00.000Z");
    expect(payload.interruption.ended_at).toBe("2026-08-16T01:05:00.000Z");
    const after = renderHook(() => useDbVersion()).result.current;
    expect(after).toBeGreaterThan(before);
  });

  it("C-6：>9999 年的可解析串按不可解析口径原样透传（扩展年格式会破坏字典序）", async () => {
    invokeMock.mockResolvedValue(null);
    await sqliteRepo.addSession({
      id: "s3",
      type: "focus",
      mode: "focus",
      startedAt: "+010000-01-01T00:00:00.000Z",
      endedAt: "2026-08-16T01:25:00.000Z",
      plannedSeconds: 1500,
      completed: true,
      taskId: null,
      eventLabel: null
    });
    const [, payload] = invokeMock.mock.calls[0];
    // toISOString 对 >9999 年会产出 "+010000-…"（`+` 码位小于数字，ORDER BY
    // 字典序把它当最旧裁掉）——年份越界不归一，交给 Rust 解析失败跳过的兜底。
    expect(payload.session.started_at).toBe("+010000-01-01T00:00:00.000Z");
  });
});

describe("sqliteRepo 统计读包装（参数与字段映射）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("taskFocusBreakdown 映射 Rust 行并保留未关联 NULL 组", async () => {
    invokeMock.mockResolvedValue([
      { task_id: "t1", event_label: null, focus_seconds: 3000, sessions: 2 },
      { task_id: null, event_label: "写作", focus_seconds: 1500, sessions: 1 },
      { task_id: null, event_label: null, focus_seconds: 600, sessions: 1 }
    ]);
    const rows = await sqliteRepo.taskFocusBreakdown();
    expect(invokeMock.mock.calls[0][0]).toBe("task_focus_breakdown");
    expect(rows).toEqual([
      { taskId: "t1", eventLabel: null, focusSeconds: 3000, sessions: 2 },
      { taskId: null, eventLabel: "写作", focusSeconds: 1500, sessions: 1 },
      { taskId: null, eventLabel: null, focusSeconds: 600, sessions: 1 }
    ]);
  });

  it("monthlyInterruptionBreakdown 携带虚拟午夜/年/0 起月参数并映射 ReasonCount", async () => {
    invokeMock.mockResolvedValue([{ reason: "电话", count: 3 }]);
    const rows = await sqliteRepo.monthlyInterruptionBreakdown(4, 2026, 9);
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("monthly_interruption_breakdown");
    expect(payload).toEqual({ virtualMidnightHour: 4, year: 2026, month0: 9 });
    expect(rows).toEqual([{ reason: "电话", count: 3 }]);
  });

  it("aggregateSessions 透传 virtualMidnightHour 并映射 daily 行", async () => {
    invokeMock.mockResolvedValue({
      daily: [{ date: "2026-08-16", focus_seconds: 1500, focus_count: 1 }]
    });
    const agg = await sqliteRepo.aggregateSessions(2);
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("aggregate_sessions");
    expect(payload).toEqual({ virtualMidnightHour: 2 });
    expect(agg.daily).toEqual([{ date: "2026-08-16", focusSeconds: 1500, focusCount: 1 }]);
  });

  it("F-4：listSessions/listInterruptions 透传 limit（水合只拉最近 N 条）", async () => {
    invokeMock.mockResolvedValue([]);
    await sqliteRepo.listSessions(500);
    expect(invokeMock.mock.calls[0]).toEqual(["list_sessions", { limit: 500 }]);
    await sqliteRepo.listSessions();
    expect(invokeMock.mock.calls[1]).toEqual(["list_sessions", { limit: null }]);
    await sqliteRepo.listInterruptions(300);
    expect(invokeMock.mock.calls[2]).toEqual(["list_interruptions", { limit: 300 }]);
    await sqliteRepo.listInterruptions();
    expect(invokeMock.mock.calls[3]).toEqual(["list_interruptions", { limit: null }]);
  });
});

describe("sqliteRepo.replaceCoreData（JSON/CSV 导入落库）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("把内存态整表写回 import_data，字段映射为 Rust 侧 snake_case", async () => {
    invokeMock.mockResolvedValue({ tasks: 2, deadlines: 1 });
    await sqliteRepo.replaceCoreData({
      tasks: [
        {
          id: "t1",
          title: "写周报",
          completed: false,
          createdAt: "2026-08-16T01:00:00Z",
          dueAt: "",
          priority: 0,
          tags: [],
          sortOrder: 0
        },
        {
          id: "t2",
          title: "复习",
          completed: true,
          createdAt: "2026-08-16T02:00:00Z",
          dueAt: "",
          priority: 0,
          tags: [],
          sortOrder: 0
        }
      ],
      deadlines: [
        {
          id: "d1",
          title: "答辩",
          dueAt: "2026-08-30T00:00:00Z",
          notified: false,
          completed: false,
          notifiedTiers: [],
          repeat: "none"
        }
      ],
      sessions: [
        {
          id: "s1",
          type: "focus",
          mode: "focus",
          startedAt: "2026-08-16T01:00:00Z",
          endedAt: "2026-08-16T01:25:00Z",
          plannedSeconds: 1500,
          completed: true,
          taskId: "t1",
          eventLabel: null
        }
      ]
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("import_data");
    expect(payload.data.tasks).toEqual([
      {
        id: "t1",
        title: "写周报",
        completed: false,
        created_at: "2026-08-16T01:00:00Z",
        due_at: "",
        priority: 0,
        tags: "[]",
        sort_order: 0
      },
      {
        id: "t2",
        title: "复习",
        completed: true,
        created_at: "2026-08-16T02:00:00Z",
        due_at: "",
        priority: 0,
        tags: "[]",
        sort_order: 0
      }
    ]);
    expect(payload.data.deadlines).toEqual([
      {
        id: "d1",
        title: "答辩",
        due_at: "2026-08-30T00:00:00Z",
        notified: false,
        completed: false,
        notified_tiers: "[]",
        repeat: "none"
      }
    ]);
    expect(payload.data.sessions).toEqual([
      {
        id: "s1",
        session_type: "focus",
        mode: "focus",
        started_at: "2026-08-16T01:00:00Z",
        ended_at: "2026-08-16T01:25:00Z",
        planned_seconds: 1500,
        completed: true,
        task_id: "t1",
        event_label: null
      }
    ]);
    // 不触碰设置与中断记录：缺省字段即"保留库中现有数据"。
    expect(payload.data.settings).toBeUndefined();
    expect(payload.data.interruptions).toBeUndefined();
  });
});

describe("sqliteRepo.replaceCoreDataKeepSessions（CSV/JSON 导入落库）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("单次 invoke import_core_data_keep_sessions，载荷不携带 sessions（Rust 事务内保留库中现存量）", async () => {
    // （跨窗口丢行）：此前「先 list_sessions 快照再 import_data 整表替换」
    // 分两步，JS 写链只在单 WebView 有效——两步之间其他窗口新写的专注记录会被
    // 静默删除。现在收口为 Rust 单事务命令。
    invokeMock.mockResolvedValue({ tasks: 1, deadlines: 0 });
    await sqliteRepo.replaceCoreDataKeepSessions({
      tasks: [
        {
          id: "t1",
          title: "复习",
          completed: false,
          createdAt: "2026-08-16T01:00:00Z",
          dueAt: "",
          priority: 2,
          tags: ["考试"],
          sortOrder: 3
        }
      ],
      deadlines: []
    });

    // 恰好一次 IPC，且不再先读 list_sessions 快照。
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("import_core_data_keep_sessions");
    expect(payload.data.tasks).toEqual([
      {
        id: "t1",
        title: "复习",
        completed: false,
        created_at: "2026-08-16T01:00:00Z",
        due_at: "",
        priority: 2,
        tags: '["考试"]',
        sort_order: 3
      }
    ]);
    expect(payload.data.deadlines).toEqual([]);
    // sessions 由 Rust 在同一事务内以库中现存行为准，载荷不传。
    expect(payload.data.sessions).toBeUndefined();
  });
});

describe("sqliteRepo.mergeCoreData（G1：一次性迁移合并落库）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("单次 invoke import_core_data_merge：携带 legacy 全量三表，无前置读库、不碰 settings/interruptions", async () => {
    // （迁移重设计）：合并语义（按 id 并集、库中行胜）收口进 Rust 单事务。
    // 前端不再有行数启发式的 count 读，也不再有 list_sessions 快照读。
    invokeMock.mockResolvedValue({ tasks: 1, deadlines: 1 });
    await sqliteRepo.mergeCoreData({
      tasks: [
        {
          id: "t-legacy",
          title: "浏览器时代的任务",
          completed: true,
          createdAt: "2026-01-01T00:00:00Z",
          dueAt: "",
          priority: 1,
          tags: ["旧"],
          sortOrder: 0
        }
      ],
      deadlines: [
        {
          id: "d-legacy",
          title: "旧 DDL",
          dueAt: "2026-02-01T00:00:00Z",
          notified: false,
          completed: false,
          notifiedTiers: [],
          repeat: "none"
        }
      ],
      sessions: [
        {
          id: "s-legacy",
          type: "focus",
          mode: "focus",
          startedAt: "2026-01-01T01:00:00Z",
          endedAt: "2026-01-01T01:25:00Z",
          plannedSeconds: 1500,
          completed: true,
          taskId: "t-legacy",
          eventLabel: null
        }
      ]
    });

    // 恰好一次 IPC：合并前的库快照与合并写库都在 Rust 同一事务内。
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, payload] = invokeMock.mock.calls[0];
    expect(cmd).toBe("import_core_data_merge");
    expect(payload.data.tasks).toEqual([
      {
        id: "t-legacy",
        title: "浏览器时代的任务",
        completed: true,
        created_at: "2026-01-01T00:00:00Z",
        due_at: "",
        priority: 1,
        tags: '["旧"]',
        sort_order: 0
      }
    ]);
    expect(payload.data.deadlines).toEqual([
      {
        id: "d-legacy",
        title: "旧 DDL",
        due_at: "2026-02-01T00:00:00Z",
        notified: false,
        completed: false,
        notified_tiers: "[]",
        repeat: "none"
      }
    ]);
    expect(payload.data.sessions).toEqual([
      {
        id: "s-legacy",
        session_type: "focus",
        mode: "focus",
        started_at: "2026-01-01T01:00:00Z",
        ended_at: "2026-01-01T01:25:00Z",
        planned_seconds: 1500,
        completed: true,
        task_id: "t-legacy",
        event_label: null
      }
    ]);
    // 合并模式不触碰设置与中断记录：载荷不携带（Rust 侧也整体忽略）。
    expect(payload.data.settings).toBeUndefined();
    expect(payload.data.interruptions).toBeUndefined();
  });
});
