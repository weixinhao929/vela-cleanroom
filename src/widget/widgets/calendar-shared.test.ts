import { beforeEach, describe, expect, it } from "vitest";
import {
  calendarEventsOnDay,
  calendarDateKey,
  listCalendarEventsOnDayAcrossInstances,
  loadCalendarEvents,
  parseCalendarKey,
  repeatMatches
} from "./calendar-shared";

/**
 * 日历领域层（calendar-shared）：重复展开 / 键解析 / 跨实例聚合。
 * 今日概览的「今日日程」依赖跨实例聚合——按实例分键的事件此前进不了
 * 「今天的事」口径。
 */
describe("calendar-shared 领域函数", () => {
  beforeEach(() => localStorage.clear());

  it("dateKey / parseKey 往返；非法键返回 null", () => {
    const d = new Date(2026, 8, 24);
    expect(parseCalendarKey(calendarDateKey(2026, 8, 24))).toEqual(d);
    expect(parseCalendarKey("2026-9-31")).toBeNull(); // 9 月没有 31 日
    expect(parseCalendarKey("abc")).toBeNull();
  });

  it("repeatMatches：weekly 按星期 / monthly 按日 / yearly 按月日；早于锚点不命中", () => {
    const anchor = new Date(2026, 0, 5); // 周一
    expect(repeatMatches(anchor, "weekly", new Date(2026, 8, 21))).toBe(true); // 周一
    expect(repeatMatches(anchor, "weekly", new Date(2026, 8, 24))).toBe(false); // 周四
    expect(repeatMatches(anchor, "monthly", new Date(2026, 4, 5))).toBe(true);
    expect(repeatMatches(anchor, "yearly", new Date(2027, 0, 5))).toBe(true);
    expect(repeatMatches(anchor, "weekly", new Date(2025, 11, 30))).toBe(false); // 早于锚点
  });

  it("calendarEventsOnDay：锚点当日 + 重复展开 + 按时间排序", () => {
    const events = {
      "2026-09-21": [{ id: "b", text: "晚间复盘", time: "20:00", color: "", repeat: "none" as const, remind: 0 }],
      "2026-01-05": [{ id: "r", text: "每周站会", time: "09:30", color: "", repeat: "weekly" as const, remind: 0 }]
    };
    const out = calendarEventsOnDay(events, new Date(2026, 8, 21)); // 周一：锚点日 + weekly 命中
    expect(out.map((e) => e.id)).toEqual(["r", "b"]); // 09:30 在 20:00 前
  });

  it("loadCalendarEvents 容错：损坏/旧字符串数组", () => {
    localStorage.setItem("focus-desk.calendar.x.v1", "{bad");
    expect(loadCalendarEvents("x")).toEqual({});
    localStorage.setItem("focus-desk.calendar.y.v1", JSON.stringify({ "2026-09-24": ["旧版纯文本"] }));
    const m = loadCalendarEvents("y");
    expect(m["2026-09-24"]).toHaveLength(1);
    expect(m["2026-09-24"][0].text).toBe("旧版纯文本");
    expect(m["2026-09-24"][0].repeat).toBe("none");
  });

  it("跨实例聚合：平铺全部实例的当日事件并按时间排序", () => {
    localStorage.setItem(
      "focus-desk.calendar.a.v1",
      JSON.stringify({
        "2026-09-24": [{ id: "a1", text: "下午同步", time: "14:00", color: "", repeat: "none" as const, remind: 0 }]
      })
    );
    localStorage.setItem(
      "focus-desk.calendar.b.v1",
      JSON.stringify({
        "2026-09-24": [{ id: "b1", text: "早晨体检", time: "08:00", color: "", repeat: "none" as const, remind: 0 }]
      })
    );
    localStorage.setItem("focus-desk.notes.trash", "[]"); // 干扰键
    const out = listCalendarEventsOnDayAcrossInstances(new Date(2026, 8, 24));
    expect(out.map((x) => x.event.id)).toEqual(["b1", "a1"]);
    expect(out.map((x) => x.instanceId)).toEqual(["b", "a"]);
  });
});
