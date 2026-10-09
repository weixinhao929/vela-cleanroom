/**
 * 跨窗口同步（Tauri 模式单测）：mock lib/tauri（isTauri=true、固定窗口
 * label）与 @tauri-apps/api/event（listen 捕获处理器、emit 记录调用），验证：
 *  - 删除 / 清空 / 恢复三路在 Tauri 模式广播 app:notification-deleted /
 *    -cleared / -restored（载荷带 origin 与数据）；
 *  - 对端（origin 不同）收到三路事件后本地内存同步应用（不回发 IPC）；
 *  - 自己的回声（origin 相同）被忽略（防回环）；
 *  - 远端清空同时作废本地 undo 槽（DB 已空，恢复槽会把别窗刚清掉的记录复活）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitMock = vi.fn(async (_event: string, _payload?: unknown): Promise<void> => {});
const listeners = new Map<string, (e: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
  emit: emitMock
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...mod,
    isTauri: () => true,
    invoke: vi.fn(async () => null),
    currentWindowLabel: () => "widget-0"
  };
});

import { ensureNotificationListeners, useNotificationStore } from "./notification-store";
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";

function rec(id: string, createdAt: string, read = false): NotificationRecord {
  return { id, source: "s", title: id, body: "", kind: "info", read, created_at: createdAt };
}

/** broadcastSync 走动态 import + then：空转一个宏任务让 emit 落进 mock。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const syncEmits = (): [string, Record<string, unknown>][] =>
  emitMock.mock.calls
    .filter(([ev]) => ev.startsWith("app:notification"))
    .map(([ev, payload]) => [ev, (payload ?? {}) as Record<string, unknown>]);

describe("notification-store · 跨窗口同步（N1，Tauri 模式）", () => {
  beforeEach(() => {
    useNotificationStore.setState({ records: [], hydrated: true, undo: null });
    emitMock.mockClear();
    ensureNotificationListeners();
  });

  it("deleteRecords 广播 app:notification-deleted（origin + ids）", async () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-10-01T10:00:00Z"));
    s.deleteRecord("a");
    await flush();
    const call = syncEmits().find(([ev]) => ev === "app:notification-deleted");
    expect(call).toBeTruthy();
    expect(call![1]).toEqual({ origin: "widget-0", ids: ["a"] });
  });

  it("clearAll 广播 app:notification-cleared；restoreDeleted 广播 -restored（整批记录）", async () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-10-01T10:00:00Z"));
    s.clearAll();
    s.restoreDeleted();
    await flush();
    const cleared = syncEmits().find(([ev]) => ev === "app:notification-cleared");
    expect(cleared![1]).toEqual({ origin: "widget-0" });
    const restored = syncEmits().find(([ev]) => ev === "app:notification-restored");
    expect((restored![1].records as NotificationRecord[]).map((r) => r.id)).toEqual(["a"]);
  });

  it("远端 deleted（origin 不同）→ 本地移除；自己的回声（origin 相同）→ 忽略", () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-10-01T10:00:00Z"));
    s.applyRecord(rec("b", "2026-10-01T11:00:00Z"));
    listeners.get("app:notification-deleted")!({ payload: { origin: "widget-1", ids: ["a"] } });
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["b"]);
    listeners.get("app:notification-deleted")!({ payload: { origin: "widget-0", ids: ["b"] } });
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["b"]);
  });

  it("远端 cleared → 本地清列并作废 undo 槽", () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-10-01T10:00:00Z"));
    s.applyRecord(rec("b", "2026-10-01T11:00:00Z"));
    s.deleteRecord("a"); // 留下 undo
    expect(useNotificationStore.getState().undo).not.toBeNull();
    listeners.get("app:notification-cleared")!({ payload: { origin: "widget-1" } });
    expect(useNotificationStore.getState().records).toEqual([]);
    expect(useNotificationStore.getState().undo).toBeNull();
  });

  it("远端 restored → 按 id 去重回插（重复事件不重复插），排序保持新→旧", () => {
    const handler = listeners.get("app:notification-restored")!;
    handler({
      payload: { origin: "widget-1", records: [rec("old", "2026-10-01T09:00:00Z"), rec("new", "2026-10-01T12:00:00Z")] }
    });
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["new", "old"]);
    handler({ payload: { origin: "widget-1", records: [rec("new", "2026-10-01T12:00:00Z")] } });
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["new", "old"]);
    // 自己的回声不生效。
    handler({ payload: { origin: "widget-0", records: [rec("ghost", "2026-10-01T13:00:00Z")] } });
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("远端 read（既有链路）：本地未读全部翻已读", () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-10-01T10:00:00Z", false));
    listeners.get("app:notification-read")!({ payload: null });
    expect(useNotificationStore.getState().records.every((r) => r.read)).toBe(true);
  });
});
