import { beforeEach, describe, expect, it } from "vitest";
import { copyInstanceData } from "./instance-data";

/**
 * 实例数据桶迁移：套用布局模板 / 复制实例都会重分配实例 id，
 * 便签/书签/日历/涂鸦的按实例分键数据必须跟着搬家，否则
 * 「布局回来了、内容没了」。gallery 键型故意不在迁移范围
 * （元数据引用磁盘文件副本，复制会共享磁盘生命周期）。
 */
describe("copyInstanceData", () => {
  beforeEach(() => localStorage.clear());

  it("四类数据桶 + 便签回收站一并复制，源不动", () => {
    localStorage.setItem("focus-desk.notes.src", JSON.stringify([{ id: "n1" }]));
    localStorage.setItem("focus-desk.notes.src.trash", JSON.stringify([{ id: "t1" }]));
    localStorage.setItem("focus-desk.bookmarks.src", JSON.stringify([{ id: "b1" }]));
    localStorage.setItem("focus-desk.calendar.src.v1", JSON.stringify({ "2026-09-24": [{ id: "e1" }] }));
    localStorage.setItem("focus-desk.sketch.src", "data:image/png;base64,xxx");

    expect(copyInstanceData("src", "dst")).toBe(5);
    expect(localStorage.getItem("focus-desk.notes.dst")).toBe(JSON.stringify([{ id: "n1" }]));
    expect(localStorage.getItem("focus-desk.notes.dst.trash")).toBe(JSON.stringify([{ id: "t1" }]));
    expect(localStorage.getItem("focus-desk.bookmarks.dst")).toBe(JSON.stringify([{ id: "b1" }]));
    expect(localStorage.getItem("focus-desk.calendar.dst.v1")).toBe(JSON.stringify({ "2026-09-24": [{ id: "e1" }] }));
    expect(localStorage.getItem("focus-desk.sketch.dst")).toBe("data:image/png;base64,xxx");
    // 源桶保留（复制语义，非移动）。
    expect(localStorage.getItem("focus-desk.notes.src")).toBeTruthy();
  });

  it("源键缺失的桶跳过；无任何数据返回 0", () => {
    localStorage.setItem("focus-desk.bookmarks.src", "[]");
    expect(copyInstanceData("src", "dst")).toBe(1);
    expect(copyInstanceData("other", "dst2")).toBe(0);
  });

  it("同 id / 空 id 为 no-op，不产生自覆盖", () => {
    localStorage.setItem("focus-desk.notes.a", "[]");
    expect(copyInstanceData("a", "a")).toBe(0);
    expect(copyInstanceData("", "b")).toBe(0);
    expect(copyInstanceData("a", "")).toBe(0);
  });

  it("gallery 键型不在迁移范围（磁盘文件归属原实例）", () => {
    localStorage.setItem("focus-desk.gallery.src", JSON.stringify([{ id: "g1" }]));
    expect(copyInstanceData("src", "dst")).toBe(0);
    expect(localStorage.getItem("focus-desk.gallery.dst")).toBeNull();
  });
});
