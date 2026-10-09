import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTES_CAP,
  NOTES_TRASH_RETENTION_DAYS,
  loadNotes,
  loadTrash,
  purgeExpiredNotesTrash,
  saveNotes
} from "./notes-store";

/**
 * 便签存储增长治理：回收站 30 天过期自动清理 + 每实例条数上限（溢出按
 * 最旧非置顶转回收站，可恢复、置顶豁免）。
 */

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const note = (id: string, atDays: number, pinned = false) => ({
  id,
  text: `note-${id}`,
  updatedAt: iso(atDays),
  ...(pinned ? { pinned: true } : {})
});

describe("便签回收站过期清理", () => {
  beforeEach(() => localStorage.clear());

  it("软删除超过保留期的条目被清除，30 天内的保留", () => {
    localStorage.setItem(
      "focus-desk.notes.n1.trash",
      JSON.stringify([
        { id: "old", text: "x", updatedAt: iso(-40), deletedAt: iso(-(NOTES_TRASH_RETENTION_DAYS + 1)) },
        { id: "fresh", text: "y", updatedAt: iso(-3), deletedAt: iso(-2) }
      ])
    );
    const purged = purgeExpiredNotesTrash();
    expect(purged).toBe(1);
    expect(loadTrash("n1").map((t) => t.id)).toEqual(["fresh"]);
  });

  it("恰好到达保留期边界（= cutoff）算未过期（闭区间保留）", () => {
    // +50ms 余量：purge 内部会用**更新一刻**的 Date.now() 算 cutoff，高负载
    // 并行下本用例与 purge 之间可能跨过 1ms——严格等边界会让闭区间断言
    // 随机翻转（全量套件偶发红的根源）。余量内仍是「紧贴边界」语义。
    const boundary = new Date(Date.now() - NOTES_TRASH_RETENTION_DAYS * DAY + 50).toISOString();
    localStorage.setItem(
      "focus-desk.notes.n2.trash",
      JSON.stringify([{ id: "edge", text: "x", updatedAt: boundary, deletedAt: boundary }])
    );
    expect(purgeExpiredNotesTrash()).toBe(0);
    expect(loadTrash("n2")).toHaveLength(1);
  });

  it("无回收站数据 / 非 trash 键不受影响；返回清理计数", () => {
    localStorage.setItem("focus-desk.notes.n3", JSON.stringify([note("a", 0)]));
    expect(purgeExpiredNotesTrash()).toBe(0);
    expect(loadNotes("n3")).toHaveLength(1);
  });

  it("损坏的 deletedAt（非法字符串）视为最旧被清理，不抛异常", () => {
    localStorage.setItem(
      "focus-desk.notes.n4.trash",
      JSON.stringify([{ id: "bad", text: "x", updatedAt: iso(-1), deletedAt: "not-a-date" }])
    );
    expect(purgeExpiredNotesTrash()).toBe(1);
    expect(loadTrash("n4")).toHaveLength(0);
  });
});

describe("便签条数上限（溢出转回收站）", () => {
  beforeEach(() => localStorage.clear());

  it("超过上限时最旧的非置顶便签转入回收站，其余保留", () => {
    // 长度 CAP+3 → 下标 0..502；n0 最新，下标越大越旧 → 溢出三条 = n502/n501/n500。
    const many = Array.from({ length: NOTES_CAP + 3 }, (_, i) => note(`n${i}`, -i));
    saveNotes("cap1", many);
    const kept = loadNotes("cap1");
    expect(kept).toHaveLength(NOTES_CAP);
    expect(kept.map((n) => n.id)).not.toContain("n502"); // 最旧三条出列
    expect(kept.map((n) => n.id)).not.toContain("n501");
    expect(kept.map((n) => n.id)).not.toContain("n500");
    expect(kept.map((n) => n.id)).toContain("n0");
    const trash = loadTrash("cap1");
    expect(trash.map((t) => t.id).sort()).toEqual(["n500", "n501", "n502"]);
    expect(trash[0].deletedAt).toBeTruthy();
  });

  it("置顶便签豁免：即使最旧也不出列，改由次旧的非置顶补位", () => {
    const many = [
      note("pinned-old", -999, true),
      ...Array.from({ length: NOTES_CAP + 1 }, (_, i) => note(`m${i}`, -i))
    ];
    saveNotes("cap2", many);
    const kept = loadNotes("cap2");
    expect(kept).toHaveLength(NOTES_CAP);
    expect(kept.map((n) => n.id)).toContain("pinned-old");
    // 溢出 = 2 条，出列的是 m499/m500（非置顶中最旧），不是 pinned-old
    expect(
      loadTrash("cap2")
        .map((t) => t.id)
        .sort()
    ).toEqual(["m499", "m500"]);
  });

  it("未超上限时不写回收站（无副作用）", () => {
    saveNotes("cap3", [note("a", 0), note("b", -1)]);
    expect(loadNotes("cap3")).toHaveLength(2);
    expect(loadTrash("cap3")).toHaveLength(0);
  });
});
