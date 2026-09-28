import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("../tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

import { sqliteRepo } from "./sqlite";

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
