import { describe, expect, it } from "vitest";
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";
import { friendlyTime, groupNotifications, swipeFollowOffset } from "./notification-model";

function rec(id: string, source: string, createdAt: string, read = false): NotificationRecord {
  return { id, source, title: id, body: "", kind: "info", read, created_at: createdAt };
}

describe("groupNotifications", () => {
  it("按来源分组，组内保持新→旧，组间按最新一条倒序", () => {
    const list = [
      rec("p2", "pomodoro", "2026-09-15T10:05:00.000Z"),
      rec("t1", "todo", "2026-09-15T10:04:00.000Z"),
      rec("p1", "pomodoro", "2026-09-15T10:00:00.000Z"),
      rec("h1", "habit", "2026-09-15T10:06:00.000Z")
    ];
    const groups = groupNotifications(list);
    expect(groups.map((g) => g.source)).toEqual(["habit", "pomodoro", "todo"]);
    expect(groups[1].records.map((r) => r.id)).toEqual(["p2", "p1"]);
  });

  it("空列表返回空数组；非法时间戳按 0 处理不抛错", () => {
    expect(groupNotifications([])).toEqual([]);
    const groups = groupNotifications([rec("x", "a", "not-a-date"), rec("y", "b", "2026-01-01T00:00:00Z")]);
    expect(groups[0].source).toBe("b");
    expect(groups[1].source).toBe("a");
  });
});

describe("friendlyTime", () => {
  const now = new Date("2026-09-15T12:00:00.000Z").getTime();
  it("分档：刚刚 / 分钟 / 小时 / 昨天 / 前天 / 日期", () => {
    expect(friendlyTime(new Date(now - 10_000).toISOString(), now)).toBe("刚刚");
    expect(friendlyTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 分钟前");
    expect(friendlyTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3 小时前");
    expect(friendlyTime(new Date(now - 30 * 3_600_000).toISOString(), now)).toBe("昨天");
    expect(friendlyTime(new Date(now - 60 * 3_600_000).toISOString(), now)).toBe("前天");
    // 10 天前：本年 MM-DD。
    const tenDays = new Date(now - 10 * 86_400_000);
    const md = `${String(tenDays.getMonth() + 1).padStart(2, "0")}-${String(tenDays.getDate()).padStart(2, "0")}`;
    expect(friendlyTime(tenDays.toISOString(), now)).toBe(md);
  });

  it("跨年带年份；非法输入返回空串；翻译回调作用于模板", () => {
    expect(friendlyTime("2024-03-01T00:00:00.000Z", now)).toMatch(/^2024-03-0[12]$/);
    expect(friendlyTime("garbage", now)).toBe("");
    const tr = (s: string) => (s === "{n} 分钟前" ? "{n} min ago" : s);
    expect(friendlyTime(new Date(now - 7 * 60_000).toISOString(), now, tr)).toBe("7 min ago");
  });
});

describe("swipeFollowOffset（邻卡弹性跟随）", () => {
  it("被拖项 1:1；相邻 0.3×；隔一项 0.1×；更远为 0", () => {
    expect(swipeFollowOffset(2, 40, 2)).toBe(40);
    expect(swipeFollowOffset(2, 40, 1)).toBeCloseTo(12);
    expect(swipeFollowOffset(2, 40, 3)).toBeCloseTo(12);
    expect(swipeFollowOffset(2, 40, 0)).toBeCloseTo(4);
    expect(swipeFollowOffset(2, 40, 5)).toBe(0);
  });

  it("越过 70px 阈值后邻卡脱跟为 0，被拖项仍 1:1", () => {
    expect(swipeFollowOffset(0, -90, 0)).toBe(-90);
    expect(swipeFollowOffset(0, -90, 1)).toBe(0);
    expect(swipeFollowOffset(0, 70, 1)).toBeCloseTo(21); // 恰好等于阈值不算越过
    expect(swipeFollowOffset(0, 71, 1)).toBe(0);
  });
});
