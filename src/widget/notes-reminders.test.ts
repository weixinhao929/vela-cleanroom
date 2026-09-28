/**
 * 便签提醒（DeskOrder 借鉴 #8）测试：
 *  - dueReminderNotes：到点收集（未来/无效/无提醒排除；.trash 键排除）；
 *  - fireNoteReminder：发出后清除 remindAt、其余字段与同实例其他便签保留、
 *    updatedAt 不动（不顶到最近修改排序）；重复发（已清除）幂等 false；
 *  - scanNoteReminders：错过补发语义——停机期间过期的提醒首轮扫描即发出；
 *  - noteSummary：首行摘要、清单语法剥离、40 字符截断。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveNotes } from "./notes-store";
import type { Note } from "./notes-store";
import { dueReminderNotes, fireNoteReminder, scanNoteReminders, noteSummary, noteInstanceIds } from "./notes-reminders";

vi.mock("../lib/notifications", () => ({
  sourceNotify: vi.fn()
}));
import { sourceNotify } from "../lib/notifications";

const n = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  text: `${id} 的内容`,
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(sourceNotify).mockClear();
});
afterEach(() => {
  localStorage.clear();
});

describe("dueReminderNotes", () => {
  it("收集到点未发的便签；未来的、无提醒的、损坏时间串的都排除", () => {
    saveNotes("w-a", [
      n("past", { remindAt: "2026-09-20T08:00:00.000Z" }),
      n("future", { remindAt: "2999-01-01T00:00:00.000Z" }),
      n("plain"),
      n("bad", { remindAt: "not-a-date" })
    ]);
    const due = dueReminderNotes(new Date("2026-09-24T12:00:00.000Z"));
    expect(due.map((d) => d.note.id)).toEqual(["past"]);
    expect(due[0].instanceId).toBe("w-a");
  });

  it("多实例混合；.trash 回收站键不参与", () => {
    saveNotes("w-a", [n("a1", { remindAt: "2026-09-01T00:00:00.000Z" })]);
    saveNotes("w-b", [n("b1", { remindAt: "2999-01-01T00:00:00.000Z" })]);
    localStorage.setItem(
      "focus-desk.notes.w-c.trash",
      JSON.stringify([n("t1", { remindAt: "2026-09-01T00:00:00.000Z" })])
    );
    const due = dueReminderNotes(new Date("2026-09-24T00:00:00.000Z"));
    expect(due.map((d) => `${d.instanceId}:${d.note.id}`)).toEqual(["w-a:a1"]);
    // w-c 只有回收站键（.trash 后缀），不枚举为实例。
    expect(noteInstanceIds().sort()).toEqual(["w-a", "w-b"]);
  });
});

describe("fireNoteReminder", () => {
  it("发出通知并清除 remindAt；其他字段与同实例便签保留，updatedAt 不动", () => {
    saveNotes("w-a", [n("r1", { remindAt: "2026-09-24T01:00:00.000Z", pinned: true }), n("r2")]);
    const ok = fireNoteReminder("w-a", "r1");
    expect(ok).toBe(true);
    expect(sourceNotify).toHaveBeenCalledWith("note", expect.any(String), "r1 的内容");
    const list: Note[] = JSON.parse(localStorage.getItem("focus-desk.notes.w-a")!);
    expect(list[0].remindAt).toBeUndefined();
    expect(list[0].pinned).toBe(true);
    expect(list[0].updatedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(list[1].id).toBe("r2");
  });

  it("重复触发（已清除 / 不存在）幂等返回 false，不再发通知", () => {
    saveNotes("w-a", [n("r1", { remindAt: "2026-09-24T01:00:00.000Z" })]);
    expect(fireNoteReminder("w-a", "r1")).toBe(true);
    expect(fireNoteReminder("w-a", "r1")).toBe(false);
    expect(fireNoteReminder("w-a", "ghost")).toBe(false);
    expect(sourceNotify).toHaveBeenCalledTimes(1);
  });
});

describe("scanNoteReminders（错过补发）", () => {
  it("停机期间过期的提醒在首轮扫描即发出（= 启动补发）", () => {
    saveNotes("w-a", [
      n("missed", { remindAt: "2026-09-23T09:00:00.000Z" }),
      n("soon", { remindAt: "2999-01-01T00:00:00.000Z" })
    ]);
    const fired = scanNoteReminders(new Date("2026-09-24T10:00:00.000Z"));
    expect(fired).toBe(1);
    expect(sourceNotify).toHaveBeenCalledTimes(1);
    // 再扫一轮：无新增（已清除）。
    expect(scanNoteReminders(new Date("2026-09-24T10:00:30.000Z"))).toBe(0);
  });
});

describe("noteSummary", () => {
  it("取首个非空行；任务清单语法剥离；40 字符截断", () => {
    expect(noteSummary("第一行\n第二行")).toBe("第一行");
    expect(noteSummary("- [ ] 买咖啡\n- [x] 交报告")).toBe("买咖啡");
    expect(noteSummary("啊".repeat(50))).toBe(`${"啊".repeat(40)}…`);
    expect(noteSummary("\n\n")).toBe("");
  });
});
