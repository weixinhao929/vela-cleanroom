import { beforeEach, describe, expect, it } from "vitest";
import {
  calendarEventsOnDay,
  calendarDateKey,
  hhmmToMin,
  icsToEventDraft,
  layoutTimeline,
  listCalendarEventsOnDayAcrossInstances,
  loadCalendarEvents,
  mergeImportedEvents,
  minToHHMM,
  nextRepeatAfter,
  normalizeCalendarEvent,
  parseCalendarKey,
  repeatMatches,
  splitRepeatOnce
} from "./calendar-shared";
import type { CalendarEvent } from "./calendar-shared";

/** v2 事件结构构造器：repeatMatches / calendarEventsOnDay 按完整
 *  CalendarEvent 契约读取 repeatEvery/repeatUntil/excepted，旧测试传旧版
 *  字符串/半截对象（repeat 分支返回 undefined、excepted.includes 抛错）。 */
const mkEvent = (p: Partial<CalendarEvent> & Pick<CalendarEvent, "id" | "text">): CalendarEvent => ({
  time: "09:00",
  endTime: "",
  color: "",
  repeat: "none",
  repeatEvery: 1,
  repeatUntil: "",
  excepted: [],
  remind: 0,
  location: "",
  note: "",
  ...p
});

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
    const weekly = mkEvent({ id: "w", text: "每周", repeat: "weekly" });
    expect(repeatMatches(anchor, weekly, new Date(2026, 8, 21))).toBe(true); // 周一
    expect(repeatMatches(anchor, weekly, new Date(2026, 8, 24))).toBe(false); // 周四
    expect(repeatMatches(anchor, mkEvent({ id: "m", text: "每月", repeat: "monthly" }), new Date(2026, 4, 5))).toBe(
      true
    );
    expect(repeatMatches(anchor, mkEvent({ id: "y", text: "每年", repeat: "yearly" }), new Date(2027, 0, 5))).toBe(
      true
    );
    expect(repeatMatches(anchor, weekly, new Date(2025, 11, 30))).toBe(false); // 早于锚点
  });

  it("calendarEventsOnDay：锚点当日 + 重复展开 + 按时间排序", () => {
    const events = {
      "2026-09-21": [mkEvent({ id: "b", text: "晚间复盘", time: "20:00" })],
      "2026-01-05": [mkEvent({ id: "r", text: "每周站会", time: "09:30", repeat: "weekly" })]
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

  it("v2 重复规则：daily / 间隔（每 2 周）/ 终止日", () => {
    const anchor = new Date(2026, 8, 14); // 周一
    const daily = mkEvent({ id: "d", text: "每天", repeat: "daily" });
    expect(repeatMatches(anchor, daily, new Date(2026, 8, 15))).toBe(true);
    expect(repeatMatches(anchor, daily, new Date(2026, 8, 16))).toBe(true);
    const biweekly = mkEvent({ id: "bw", text: "双周", repeat: "weekly", repeatEvery: 2 });
    expect(repeatMatches(anchor, biweekly, new Date(2026, 8, 21))).toBe(false); // 第 1 周
    expect(repeatMatches(anchor, biweekly, new Date(2026, 8, 28))).toBe(true); // 第 2 周
    const until = mkEvent({ id: "u", text: "限时", repeat: "daily", repeatUntil: "2026-09-16" });
    expect(repeatMatches(anchor, until, new Date(2026, 8, 16))).toBe(true); // 终止日当天仍命中
    expect(repeatMatches(anchor, until, new Date(2026, 8, 17))).toBe(false); // 次日不再
  });

  it("v2 单次例外：excepted 日期上的锚点事件与重复命中都被过滤", () => {
    const events = {
      "2026-09-14": [mkEvent({ id: "r", text: "每周会", repeat: "weekly", excepted: ["2026-09-28"] })],
      "2026-09-20": [mkEvent({ id: "o", text: "单次", excepted: ["2026-09-20"] })]
    };
    expect(calendarEventsOnDay(events, new Date(2026, 8, 21)).map((e) => e.id)).toEqual(["r"]); // 普通周照常
    expect(calendarEventsOnDay(events, new Date(2026, 8, 28))).toEqual([]); // 例外日：重复命中被滤
    expect(calendarEventsOnDay(events, new Date(2026, 8, 20))).toEqual([]); // 例外日：锚点本身被滤
  });

  it("normalize：v1 旧数据读取即迁移（新字段补默认），endTime 早于 time 丢弃，时间补前导零", () => {
    const legacy = normalizeCalendarEvent({
      id: "L",
      text: "旧事件",
      time: "9:00",
      color: "",
      repeat: "weekly",
      remind: 15
    });
    expect(legacy).toMatchObject({
      id: "L",
      time: "09:00",
      endTime: "",
      repeat: "weekly",
      repeatEvery: 1,
      repeatUntil: "",
      excepted: [],
      remind: 15,
      location: "",
      note: ""
    });
    expect(normalizeCalendarEvent({ id: "E", text: "倒挂", time: "10:00", endTime: "09:00" })?.endTime).toBe("");
    expect(normalizeCalendarEvent({ id: "N", text: "正常", time: "10:00", endTime: "11:30" })?.endTime).toBe("11:30");
    expect(
      normalizeCalendarEvent({ id: "B", text: "坏repeat", repeat: "hourly" as unknown as CalendarEvent["repeat"] })
        ?.repeat
    ).toBe("none");
    expect(normalizeCalendarEvent({ id: "W", text: "坏until", repeatUntil: "2026/10/01" })?.repeatUntil).toBe("");
  });

  it("hhmmToMin / minToHHMM 往返与非法输入", () => {
    expect(hhmmToMin("09:30")).toBe(570);
    expect(hhmmToMin("9:05")).toBe(545);
    expect(hhmmToMin("24:00")).toBeNull();
    expect(hhmmToMin("abc")).toBeNull();
    expect(minToHHMM(570)).toBe("09:30");
    expect(minToHHMM(1441)).toBe("24:00"); // 钳制到一天末端
  });

  it("layoutTimeline：范围外扩 ±1 小时、重叠贪心分列、组宽回填", () => {
    const items = [
      { id: "a", kind: "event" as const, title: "A", startMin: 9 * 60, endMin: 10 * 60 + 30, color: "", location: "" },
      { id: "b", kind: "event" as const, title: "B", startMin: 10 * 60, endMin: 11 * 60, color: "", location: "" },
      { id: "c", kind: "event" as const, title: "C", startMin: 10 * 60 + 15, endMin: 11 * 60, color: "", location: "" },
      { id: "d", kind: "event" as const, title: "D", startMin: 14 * 60, endMin: 15 * 60, color: "", location: "" }
    ];
    const tl = layoutTimeline(items);
    expect(tl.hourStart).toBe(7); // 默认下界
    expect(tl.hourEnd).toBe(22); // 至少保留默认窗口（稳定轴高），事件外扩不缩小
    const byId = new Map(tl.items.map((it) => [it.id, it]));
    // a/b/c 相互连通重叠（9:00-11:00 链）：a 列 0，b 列 0 与 a 不重叠？b 10:00 vs a 结束 10:30 → 重叠，
    // b 进列 1；c 10:15 与 a(至10:30)/b(至11:00) 都重叠 → 列 2；组宽 3。
    expect(byId.get("a")).toMatchObject({ col: 0, cols: 3 });
    expect(byId.get("b")).toMatchObject({ col: 1, cols: 3 });
    expect(byId.get("c")).toMatchObject({ col: 2, cols: 3 });
    expect(byId.get("d")).toMatchObject({ col: 0, cols: 1 }); // 独立组回填宽度 1
  });

  it("layoutTimeline：空表用默认 7–22 窗口；极早/极晚事件钳到 0–24", () => {
    const empty = layoutTimeline([]);
    expect(empty.hourStart).toBe(7);
    expect(empty.hourEnd).toBe(22);
    const early = layoutTimeline([
      { id: "e", kind: "event" as const, title: "早", startMin: 5 * 60, endMin: 6 * 60, color: "", location: "" },
      { id: "l", kind: "event" as const, title: "晚", startMin: 23 * 60, endMin: 23 * 60 + 30, color: "", location: "" }
    ]);
    expect(early.hourStart).toBe(4);
    expect(early.hourEnd).toBe(24);
  });

  it("icsToEventDraft：提醒吸附最近档位（>60 钳到 60），重复语义直译", () => {
    const d = icsToEventDraft({
      title: "导入会",
      location: "会议室",
      time: "14:00",
      endTime: "15:00",
      remind: 40,
      repeat: "weekly",
      repeatEvery: 2,
      repeatUntil: "2026-12-31"
    });
    expect(d).toMatchObject({
      time: "14:00",
      endTime: "15:00",
      location: "会议室",
      remind: 30,
      repeat: "weekly",
      repeatEvery: 2,
      repeatUntil: "2026-12-31"
    });
    expect(
      icsToEventDraft({
        title: "x",
        location: "",
        time: "",
        endTime: "",
        remind: 90,
        repeat: "none",
        repeatEvery: 1,
        repeatUntil: ""
      }).remind
    ).toBe(60);
  });
});

describe("系列分裂 / 下一命中 / 导入合并（v3）", () => {
  beforeEach(() => localStorage.clear());

  it("nextRepeatAfter：weekly 相位保持；monthly 31 日溢出周期跳过；已终止返回 null", () => {
    const weekly = mkEvent({ id: "w", text: "周会", repeat: "weekly" });
    const anchor = new Date(2026, 8, 14); // 周一
    const next = nextRepeatAfter(anchor, weekly, new Date(2026, 8, 21));
    expect(next && next.getTime()).toBe(new Date(2026, 8, 28).getTime()); // 下周一
    const every2 = mkEvent({ id: "e2", text: "双周", repeat: "weekly", repeatEvery: 2 });
    const next2 = nextRepeatAfter(anchor, every2, new Date(2026, 8, 21));
    expect(next2 && next2.getTime()).toBe(new Date(2026, 8, 28).getTime()); // 9-28 > 9-21 且双周相位命中
    const until = mkEvent({ id: "u", text: "止", repeat: "daily", repeatUntil: "2026-09-16" });
    expect(nextRepeatAfter(new Date(2026, 8, 14), until, new Date(2026, 8, 16))).toBeNull();
    // monthly 31 日：10-31 后的下一命中是 12-31（11 月无 31 日）。
    const m31 = mkEvent({ id: "m31", text: "月31", repeat: "monthly" });
    const nm = nextRepeatAfter(new Date(2026, 9, 31), m31, new Date(2026, 9, 31));
    expect(nm && nm.getTime()).toBe(new Date(2026, 11, 31).getTime());
  });

  it("splitRepeatOnce：原系列止于前日 + 当日单次 + 续系列（新锚点键/相位/未来例外保留）", () => {
    const ev = mkEvent({
      id: "r1",
      text: "每周会",
      repeat: "weekly",
      excepted: ["2026-10-26"]
    });
    const events = { "2026-09-14": [ev] };
    const draft = mkEvent({ id: "r1", text: "每周会（改）", time: "10:00", repeat: "weekly" });
    const next = splitRepeatOnce(events, "2026-09-14", "r1", "2026-10-05", draft);
    // 当日单次：改后的字段、不重复。
    expect(next["2026-10-05"]).toHaveLength(1);
    expect(next["2026-10-05"][0]).toMatchObject({ text: "每周会（改）", time: "10:00", repeat: "none" });
    // 原锚点键：只剩原系列（终止 10-04）。
    expect(next["2026-09-14"]).toHaveLength(1);
    expect(next["2026-09-14"][0]).toMatchObject({ id: "r1", repeatUntil: "2026-10-04" });
    // 续系列：存到新锚点键 10-12（而非原键——否则编辑日前双份显示）。
    const tail = next["2026-10-12"];
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ repeat: "weekly" });
    expect(tail[0].id).not.toBe("r1");
    expect(tail[0].excepted).toEqual(["2026-10-26"]); // 未来例外延续
    // 展开验证：10-12 显示续系列（改前字段），10-26 例外隐藏，9-28 原系列照旧。
    expect(calendarEventsOnDay(next, new Date(2026, 9, 12)).some((e) => e.text === "每周会")).toBe(true);
    expect(calendarEventsOnDay(next, new Date(2026, 9, 26))).toEqual([]);
    expect(calendarEventsOnDay(next, new Date(2026, 8, 28)).some((e) => e.id === "r1")).toBe(true);
  });

  it("splitRepeatOnce：编辑锚点日本身 → 原系列退役（不产生永不显示的死数据）", () => {
    const ev = mkEvent({ id: "r2", text: "每周", repeat: "weekly" });
    const next = splitRepeatOnce({ "2026-09-14": [ev] }, "2026-09-14", "r2", "2026-09-14", {
      ...ev,
      text: "单改"
    });
    expect(next["2026-09-14"]).toHaveLength(1); // 只剩当日的单次新事件
    expect(calendarEventsOnDay(next, new Date(2026, 8, 14)).map((e) => e.text)).toEqual(["单改"]);
    // 续系列在新锚点键 9-21 下，从 9-21 起照常。
    expect(next["2026-09-21"]).toHaveLength(1);
    expect(calendarEventsOnDay(next, new Date(2026, 8, 21)).some((e) => e.text === "每周")).toBe(true);
  });

  it("splitRepeatOnce：非重复事件原样返回（防御）", () => {
    const ev = mkEvent({ id: "n1", text: "单次" });
    const events = { "2026-09-14": [ev] };
    expect(splitRepeatOnce(events, "2026-09-14", "n1", "2026-09-15", ev)).toBe(events);
  });

  it("ZW-1：编辑日已有事件时不得变异输入数组——updater 纯度（StrictMode 双调用）", () => {
    const ev = mkEvent({ id: "r3", text: "周例", repeat: "weekly" });
    const other = mkEvent({ id: "o1", text: "占位", time: "08:00" });
    // 编辑非锚点日 10-05，且该日已有其他事件——变异分支的触发形态。
    const events: Record<string, (typeof ev)[]> = { "2026-09-14": [ev], "2026-10-05": [other] };
    const dayList = events["2026-10-05"];
    const draft = mkEvent({ id: "r3", text: "周例（改）", time: "10:00", repeat: "weekly" });
    const next = splitRepeatOnce(events, "2026-09-14", "r3", "2026-10-05", draft);
    // 输入数组不被原地 push（调用方 state 保持 1 条）。
    expect(dayList).toHaveLength(1);
    expect(events["2026-10-05"]).toHaveLength(1);
    // 结果里当日 = 原事件 + 单次新事件。
    expect(next["2026-10-05"]).toHaveLength(2);
    // StrictMode 双调用模拟：同一 base state 连续两次调用，均不得重复累加。
    const again = splitRepeatOnce(events, "2026-09-14", "r3", "2026-10-05", draft);
    expect(again["2026-10-05"]).toHaveLength(2);
    expect(events["2026-10-05"]).toHaveLength(1);
  });

  it("R-前端-1：「仅此日」分裂后 once 换新 id——与残系列/续系列全表 id 唯一", () => {
    const ev = mkEvent({ id: "r4", text: "每周例", repeat: "weekly" });
    // 编辑器 submit 的 draft 复用原系列 id（editing?.id ?? randomUUID）。
    const draft = mkEvent({ id: "r4", text: "每周例（改）", time: "10:00", repeat: "weekly" });
    const next = splitRepeatOnce({ "2026-09-14": [ev] }, "2026-09-14", "r4", "2026-10-05", draft);
    const allIds = Object.values(next)
      .flat()
      .map((e) => e.id);
    expect(new Set(allIds).size).toBe(allIds.length); // 全表无重复 id
    expect(next["2026-10-05"][0].id).not.toBe("r4"); // once 不复用系列 id
    expect(next["2026-09-14"][0].id).toBe("r4"); // 残系列保有原 id
  });

  it("R-前端-2：锚点远超 500 周期的 daily 系列——续系列不再静默丢失", () => {
    // 锚点 2 年前（730 天 > 旧实现 500 步上限），daily every=1，编辑今日。
    const anchor = new Date(2024, 9, 1);
    const ev = mkEvent({ id: "r5", text: "日报", repeat: "daily" });
    const nextOcc = nextRepeatAfter(anchor, ev, new Date(2026, 9, 8));
    expect(nextOcc).not.toBeNull();
    expect(nextOcc && nextOcc.getTime()).toBe(new Date(2026, 9, 9).getTime());
    // weekly 长寿命（锚点 10 年）同样起跳正确：编辑日后首个同相位日。
    const wAnchor = new Date(2016, 9, 3); // 周一
    const weekly = mkEvent({ id: "r6", text: "周报", repeat: "weekly" });
    const wNext = nextRepeatAfter(wAnchor, weekly, new Date(2026, 9, 8)); // 周四
    expect(wNext && wNext.getTime()).toBe(new Date(2026, 9, 12).getTime()); // 下周一
  });

  it("mergeImportedEvents：锚点级与展开级重复都跳过；批内重复去重", () => {
    const existing = {
      "2026-09-14": [mkEvent({ id: "a", text: "组会", time: "09:00" })],
      "2026-09-07": [mkEvent({ id: "b", text: "周会", time: "10:00", repeat: "weekly" })]
    };
    const draft = (date: string, text: string, time: string) => ({
      date,
      event: mkEvent({ id: `d-${date}-${text}`, text, time })
    });
    const out = mergeImportedEvents(existing, [
      draft("2026-09-14", "组会", "09:00"), // 锚点级重复
      draft("2026-09-21", "周会", "10:00"), // 展开级重复（weekly 命中日）
      draft("2026-09-21", "周会", "10:00"), // 批内重复
      draft("2026-09-22", "新事", "14:00") // 真新增
    ]);
    expect(out.added).toBe(1);
    expect(out.skipped).toBe(3);
    expect(out.events["2026-09-22"]).toHaveLength(1);
    expect(out.events["2026-09-14"]).toHaveLength(1); // 未追加
  });

  it("loadCalendarEvents：终止日早于锚点日读入时置空（防事件静默消失）", () => {
    localStorage.setItem(
      "focus-desk.calendar.g.v1",
      JSON.stringify({
        "2026-09-14": [mkEvent({ id: "bad", text: "坏终止", repeat: "weekly", repeatUntil: "2026-09-01" })]
      })
    );
    const m = loadCalendarEvents("g");
    expect(m["2026-09-14"][0].repeatUntil).toBe("");
  });

  it("WD-3：同 id 双事件（R-前端-1 修复窗口期的存量数据）读入时保留首现、丢弃后续", () => {
    localStorage.setItem(
      "focus-desk.calendar.g.v1",
      JSON.stringify({
        // 修复前的 splitRepeatOnce 曾以同一 id 落「截断残系列 + once」两条。
        "2026-09-14": [
          mkEvent({ id: "dup", text: "残系列", repeat: "weekly", repeatUntil: "2026-09-14" }),
          mkEvent({ id: "dup", text: "当日单次", repeat: "none" })
        ],
        "2026-09-21": [mkEvent({ id: "keep", text: "正常事件" })]
      })
    );
    const m = loadCalendarEvents("g");
    expect(m["2026-09-14"]).toHaveLength(1);
    expect(m["2026-09-14"][0].text).toBe("残系列");
    expect(m["2026-09-21"]).toHaveLength(1);
    expect(m["2026-09-21"][0].id).toBe("keep");
  });
});
