import { describe, expect, it } from "vitest";
import type { Task } from "../../domain/schemas";
import { bucketTasks, dueAtForBucket, TASK_BUCKETS } from "./task-overview-shared";

/* 固定「现在」= 2026-09-16 本地 12:00（日界断言全部用本地时区构造，与实现同口径）。 */
const NOW = new Date(2026, 8, 16, 12, 0, 0, 0).getTime();
const local = (y: number, m0: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
  new Date(y, m0, d, h, mi, s, ms).toISOString();

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: over.id ?? `t${seq}`,
    title: over.title ?? `任务 ${seq}`,
    completed: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    dueAt: "",
    priority: 0,
    tags: [],
    sortOrder: 0,
    ...over
  };
}

const ids = (list: Task[]) => list.map((t) => t.id);

describe("bucketTasks · 今日边界", () => {
  it("今天 00:00:00.000 与 23:59:59.999 都落在「今天」列", () => {
    const a = task({ id: "a", dueAt: local(2026, 8, 16, 0, 0, 0, 0) });
    const b = task({ id: "b", dueAt: local(2026, 8, 16, 23, 59, 59, 999) });
    const r = bucketTasks([a, b], NOW);
    expect(ids(r.today)).toEqual(["a", "b"]);
    expect(r.overdue).toHaveLength(0);
    expect(r.later).toHaveLength(0);
  });

  it("恰在「现在」到期的任务算今天（尚未过今日日界）", () => {
    const r = bucketTasks([task({ id: "n", dueAt: new Date(NOW).toISOString() })], NOW);
    expect(ids(r.today)).toEqual(["n"]);
  });
});

describe("bucketTasks · 跨天", () => {
  it("明天 00:00 → 之后；昨天 23:59 → 逾期；下周 → 之后", () => {
    const tomorrow0 = task({ id: "tm", dueAt: local(2026, 8, 17, 0, 0) });
    const yesterday = task({ id: "ys", dueAt: local(2026, 8, 15, 23, 59) });
    const nextWeek = task({ id: "nw", dueAt: local(2026, 8, 23, 9, 0) });
    const r = bucketTasks([tomorrow0, yesterday, nextWeek], NOW);
    expect(ids(r.later)).toEqual(["tm", "nw"]);
    expect(ids(r.overdue)).toEqual(["ys"]);
    expect(r.today).toHaveLength(0);
  });

  it("nowMs 换到次日后，同一任务从「今天」滑入「逾期」", () => {
    const t = task({ id: "x", dueAt: local(2026, 8, 16, 18, 0) });
    expect(ids(bucketTasks([t], NOW).today)).toEqual(["x"]);
    const nextDayNoon = new Date(2026, 8, 17, 12, 0).getTime();
    expect(ids(bucketTasks([t], nextDayNoon).overdue)).toEqual(["x"]);
  });
});

describe("bucketTasks · 无期限", () => {
  it("dueAt 空串与非法字符串都进「无期限」", () => {
    const r = bucketTasks([task({ id: "e", dueAt: "" }), task({ id: "bad", dueAt: "not-a-date" })], NOW);
    expect(ids(r.none)).toEqual(["e", "bad"]);
    expect(r.overdue.length + r.today.length + r.later.length + r.done.length).toBe(0);
  });
});

describe("bucketTasks · 已完成不按日期分列", () => {
  it("已完成任务无论截止是昨天 / 今天 / 无期限，一律进「已完成」", () => {
    const r = bucketTasks(
      [
        task({ id: "d1", completed: true, dueAt: local(2026, 8, 15, 8, 0) }),
        task({ id: "d2", completed: true, dueAt: local(2026, 8, 16, 8, 0) }),
        task({ id: "d3", completed: true, dueAt: "" }),
        task({ id: "open", completed: false, dueAt: local(2026, 8, 15, 8, 0) })
      ],
      NOW
    );
    expect(ids(r.done)).toEqual(["d1", "d2", "d3"]);
    expect(ids(r.overdue)).toEqual(["open"]);
    expect(r.today).toHaveLength(0);
    expect(r.none).toHaveLength(0);
  });
});

describe("bucketTasks · 稳定排序", () => {
  it("列内按 sortOrder 升序；并列保持传入顺序", () => {
    const r = bucketTasks(
      [
        task({ id: "s5", sortOrder: 5 }),
        task({ id: "s0a", sortOrder: 0 }),
        task({ id: "s1", sortOrder: 1 }),
        task({ id: "s0b", sortOrder: 0 })
      ],
      NOW
    );
    expect(ids(r.none)).toEqual(["s0a", "s0b", "s1", "s5"]);
  });

  it("排序只在列内进行，且已完成列同样遵守", () => {
    const r = bucketTasks(
      [
        task({ id: "done9", completed: true, sortOrder: 9 }),
        task({ id: "today3", sortOrder: 3, dueAt: local(2026, 8, 16, 10, 0) }),
        task({ id: "done1", completed: true, sortOrder: 1 }),
        task({ id: "today0", sortOrder: 0, dueAt: local(2026, 8, 16, 20, 0) })
      ],
      NOW
    );
    expect(ids(r.done)).toEqual(["done1", "done9"]);
    expect(ids(r.today)).toEqual(["today0", "today3"]);
  });

  it("五列顺序常量即展示顺序", () => {
    expect(TASK_BUCKETS).toEqual(["overdue", "today", "later", "none", "done"]);
  });
});

describe("dueAtForBucket · 拖放到日期列", () => {
  const parts = (iso: string) => {
    const d = new Date(iso);
    return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  };

  it("拖到「无期限」清空截止", () => {
    expect(dueAtForBucket("none", local(2026, 8, 15, 8, 0), NOW)).toBe("");
  });

  it("无原截止拖到「今天」→ 今天 23:59；拖到「之后」→ 明天 23:59", () => {
    expect(parts(dueAtForBucket("today", "", NOW))).toEqual([2026, 8, 16, 23, 59, 0]);
    expect(parts(dueAtForBucket("later", "", NOW))).toEqual([2026, 8, 17, 23, 59, 0]);
  });

  it("有原截止时保留时分秒，只换日期", () => {
    const prev = local(2026, 8, 10, 9, 30, 15);
    expect(parts(dueAtForBucket("today", prev, NOW))).toEqual([2026, 8, 16, 9, 30, 15]);
    expect(parts(dueAtForBucket("later", prev, NOW))).toEqual([2026, 8, 17, 9, 30, 15]);
  });

  it("结果回灌 bucketTasks 必落在目标列（today / later 闭环）", () => {
    const t = task({ id: "rt", dueAt: local(2026, 8, 1, 8, 0) });
    const toToday = { ...t, dueAt: dueAtForBucket("today", t.dueAt, NOW) };
    const toLater = { ...t, dueAt: dueAtForBucket("later", t.dueAt, NOW) };
    expect(ids(bucketTasks([toToday], NOW).today)).toEqual(["rt"]);
    expect(ids(bucketTasks([toLater], NOW).later)).toEqual(["rt"]);
  });
});
