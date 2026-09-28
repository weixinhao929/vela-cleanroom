import { beforeEach, describe, expect, it } from "vitest";
import { ensureNotificationListeners, selectUnreadCount, useNotificationStore } from "./notification-store";
import { NOTIFICATION_RECORDED_EVENT } from "../../lib/notifications";
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";

function rec(id: string, createdAt: string, read = false): NotificationRecord {
  return { id, source: "s", title: id, body: "", kind: "info", read, created_at: createdAt };
}

/**
 * 浏览器模式（jsdom 无 __TAURI_INTERNALS__）：IPC 全部短路，验证内存语义。
 * 覆盖：去重置顶 / 上限裁剪 / 乐观删除 + undo 恢复 / 一键清除 + 整批恢复 /
 * 全部已读 / DOM 事件实时推入。
 */
describe("notification-store（浏览器模式内存语义）", () => {
  beforeEach(() => {
    useNotificationStore.setState({ records: [], hydrated: false, undo: null });
  });

  it("applyRecord 去重（同 id 不重复置顶）并按新→旧排序", () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-09-15T10:00:00Z"));
    s.applyRecord(rec("b", "2026-09-15T11:00:00Z"));
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["b", "a"]);
    s.applyRecord(rec("a", "2026-09-15T10:00:00Z"));
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("deleteRecord 乐观删除并留 undo；restoreDeleted 原样回插", () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-09-15T10:00:00Z"));
    s.applyRecord(rec("b", "2026-09-15T11:00:00Z"));
    s.deleteRecord("a");
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["b"]);
    expect(useNotificationStore.getState().undo?.records.map((r) => r.id)).toEqual(["a"]);
    useNotificationStore.getState().restoreDeleted();
    const ids = useNotificationStore.getState().records.map((r) => r.id);
    expect(ids).toEqual(["b", "a"]);
    expect(useNotificationStore.getState().undo).toBeNull();
  });

  it("clearAll 留整批 undo；恢复后按时间排序回列", () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("old", "2026-09-15T09:00:00Z"));
    s.applyRecord(rec("new", "2026-09-15T12:00:00Z"));
    s.clearAll();
    expect(useNotificationStore.getState().records).toEqual([]);
    useNotificationStore.getState().restoreDeleted();
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("markAllRead 翻转全部 read 且无未读时不写状态", () => {
    const s = useNotificationStore.getState();
    s.applyRecord(rec("a", "2026-09-15T10:00:00Z", true));
    s.applyRecord(rec("b", "2026-09-15T11:00:00Z", false));
    expect(selectUnreadCount(useNotificationStore.getState())).toBe(1);
    useNotificationStore.getState().markAllRead();
    expect(selectUnreadCount(useNotificationStore.getState())).toBe(0);
    const before = useNotificationStore.getState().records;
    useNotificationStore.getState().markAllRead(); // 幂等：引用不变
    expect(useNotificationStore.getState().records).toBe(before);
  });

  it("DOM 事件 vela:notification-recorded 实时推入（安装一次后重复安装安全）", () => {
    ensureNotificationListeners();
    ensureNotificationListeners();
    window.dispatchEvent(new CustomEvent(NOTIFICATION_RECORDED_EVENT, { detail: rec("live", "2026-09-15T13:00:00Z") }));
    expect(useNotificationStore.getState().records.map((r) => r.id)).toEqual(["live"]);
  });

  it("hydrate 浏览器模式直接置 hydrated", async () => {
    await useNotificationStore.getState().hydrate();
    expect(useNotificationStore.getState().hydrated).toBe(true);
  });
});
