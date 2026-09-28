import { describe, expect, it } from "vitest";
import { deadlinesToCsv, parseDeadlinesCsv, parseTasksCsv, tasksToCsv } from "./csv";
import type { Deadline, Task } from "./schemas";

describe("tasksToCsv / parseTasksCsv", () => {
  it("round-trips tasks", () => {
    const tasks: Task[] = [
      {
        id: "t1",
        title: "写周报",
        completed: false,
        createdAt: "2026-08-13T01:00:00.000Z",
        dueAt: "",
        priority: 0,
        tags: [],
        sortOrder: 0
      },
      {
        id: "t2",
        title: "买牛奶, 鸡蛋",
        completed: true,
        createdAt: "2026-08-12T01:00:00.000Z",
        dueAt: "",
        priority: 0,
        tags: [],
        sortOrder: 0
      }
    ];
    const csv = tasksToCsv(tasks);
    const parsed = parseTasksCsv(csv);
    expect(parsed).toEqual(tasks);
  });

  it("escapes commas and quotes in titles", () => {
    const tasks: Task[] = [
      {
        id: "t1",
        title: '说 "你好", 世界',
        completed: false,
        createdAt: "x",
        dueAt: "",
        priority: 0,
        tags: [],
        sortOrder: 0
      }
    ];
    const csv = tasksToCsv(tasks);
    expect(csv).toContain('"说 ""你好"", 世界"');
    expect(parseTasksCsv(csv)[0].title).toBe('说 "你好", 世界');
  });

  it("skips blank title rows", () => {
    const parsed = parseTasksCsv("id,title,completed,createdAt\nx,,false,y");
    expect(parsed).toHaveLength(0);
  });

  it("P7: strips UTF-8 BOM so header/ids parse correctly", () => {
    const parsed = parseTasksCsv("\uFEFFid,title,completed,createdAt\nfixed-id,任务A,false,2026-08-13T01:00:00Z");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("fixed-id");
    expect(parsed[0].title).toBe("任务A");
    expect(parsed[0].completed).toBe(false);
  });

  it("导出带 UTF-8 BOM（Excel 直接打开中文不乱码），且往返无损", () => {
    const tasks: Task[] = [
      {
        id: "t1",
        title: "中文标题",
        completed: false,
        createdAt: "2026-08-13T01:00:00.000Z",
        dueAt: "",
        priority: 1,
        tags: ["a"],
        sortOrder: 2
      }
    ];
    const csv = tasksToCsv(tasks);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).startsWith("id,title")).toBe(true);
    expect(parseTasksCsv(csv)).toEqual(tasks);
    expect(deadlinesToCsv([]).charCodeAt(0)).toBe(0xfeff);
  });

  it("整数列取整并夹范围：priority 1.7→2、9→3、-1→0；sortOrder 2.4→2、非数→0", () => {
    const parsed = parseTasksCsv(
      "id,title,completed,createdAt,priority,sortOrder\na,x,false,2026-08-13T01:00:00Z,1.7,2.4\nb,y,false,2026-08-13T01:00:00Z,9,abc\nc,z,false,2026-08-13T01:00:00Z,-1,3"
    );
    expect(parsed.map((t) => [t.priority, t.sortOrder])).toEqual([
      [2, 2],
      [3, 0],
      [0, 3]
    ]);
  });

  it("P7: falls back to now for illegal createdAt", () => {
    const parsed = parseTasksCsv("id,title,completed,createdAt\nx,任务B,false,not-a-date");
    expect(parsed).toHaveLength(1);
    expect(Number.isNaN(Date.parse(parsed[0].createdAt))).toBe(false);
  });
});

describe("deadlinesToCsv / parseDeadlinesCsv", () => {
  it("round-trips deadlines", () => {
    const deadlines: Deadline[] = [
      {
        id: "d1",
        title: "交作业",
        dueAt: "2026-08-15T00:00:00.000Z",
        notified: false,
        completed: false,
        notifiedTiers: [],
        repeat: "none"
      }
    ];
    const csv = deadlinesToCsv(deadlines);
    expect(parseDeadlinesCsv(csv)).toEqual(deadlines);
  });

  it("skips rows missing a due date", () => {
    const parsed = parseDeadlinesCsv("id,title,dueAt,notified\nx,任务,,false");
    expect(parsed).toHaveLength(0);
  });

  it("P7: parses BOM-prefixed deadline CSV with a valid due date", () => {
    const parsed = parseDeadlinesCsv("\uFEFFid,title,dueAt,notified\nd-id,交作业,2026-08-15T00:00:00Z,false");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("d-id");
    expect(parsed[0].dueAt).toBe("2026-08-15T00:00:00.000Z");
  });

  it("P7: skips rows with an illegal due date", () => {
    const parsed = parseDeadlinesCsv("id,title,dueAt,notified\nx,坏日期,not-a-date,false");
    expect(parsed).toHaveLength(0);
  });
});

describe("date normalization (A-3/E-1)", () => {
  it("normalizes slash/space dates to ISO on task import", () => {
    const parsed = parseTasksCsv("id,title,completed,createdAt\nx,任务C,false,2026/08/18 10:00");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("normalizes a +00:00 offset timestamp to Z", () => {
    const parsed = parseTasksCsv("id,title,completed,createdAt\nx,任务D,false,2026-08-13T01:00:00.123456789+00:00");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].createdAt).toBe("2026-08-13T01:00:00.123Z");
  });
});

describe("full-field round-trip (A-10)", () => {
  it("preserves task dueAt/priority/tags/sortOrder through CSV", () => {
    const tasks: Task[] = [
      {
        id: "t-full",
        title: "带扩展字段的任务",
        completed: false,
        createdAt: "2026-08-13T01:00:00.000Z",
        dueAt: "2026-08-20T00:00:00.000Z",
        priority: 2,
        tags: ["紧急", "工作"],
        sortOrder: 3
      }
    ];
    expect(parseTasksCsv(tasksToCsv(tasks))).toEqual(tasks);
  });

  it("preserves deadline completed/notifiedTiers/repeat through CSV", () => {
    const deadlines: Deadline[] = [
      {
        id: "d-full",
        title: "周期节点",
        dueAt: "2026-08-15T00:00:00.000Z",
        notified: true,
        completed: true,
        notifiedTiers: ["10min", "1h"],
        repeat: "weekly"
      }
    ];
    expect(parseDeadlinesCsv(deadlinesToCsv(deadlines))).toEqual(deadlines);
  });

  it("still parses legacy minimal CSV headers (missing new columns)", () => {
    const parsed = parseTasksCsv("id,title,completed,createdAt\nold-id,旧任务,false,2026-08-13T01:00:00Z");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "old-id", dueAt: "", priority: 0, tags: [], sortOrder: 0 });
  });
});
