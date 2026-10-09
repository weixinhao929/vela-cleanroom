/**
 * 设置导出/导入的跨屏布局快照（exportScreenLayoutSnapshots /
 * importScreenLayoutSnapshot）回归：
 *  - 导出覆盖全部屏幕分区，编组随布局同出（此前导出丢组、只带当前屏）；
 *  - 导入立即落盘（绕开 saveInstances/saveGroups 单槽防抖——多视图循环里
 *    只有最后一个视图真正落盘的既有缺陷），编组往返存活；
 *  - 视图表缺失/损坏 → 整屏拒绝，不做半吊子覆盖。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  exportScreenLayoutSnapshots,
  importScreenLayoutSnapshot,
  loadGroups,
  loadInstances,
  useWidgetStore
} from "./widget-store";

const GROUP = { id: "g1", x: 0, y: 0, w: 100, h: 100, z: 3, memberIds: ["a", "b"], activeId: "a" };

function inst(id: string, z: number) {
  return { id, type: "clock", x: 0, y: 0, w: 200, h: 100, z, groupId: "g1" };
}

describe("screen layout snapshots (settings export/import)", () => {
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({ views: [{ id: "home", name: "Home" }], instances: [], groups: [], trash: [] });
  });

  it("导出含全部屏幕与编组；清空后按快照恢复（立即落盘，编组存活）", () => {
    localStorage.setItem("focus-desk.screen.0.widgets.views.v1", JSON.stringify([{ id: "home", name: "Home" }]));
    localStorage.setItem("focus-desk.screen.0.widgets.home.v1", JSON.stringify([inst("a", 1), inst("b", 2)]));
    localStorage.setItem("focus-desk.screen.0.groups.home.v1", JSON.stringify([GROUP]));
    localStorage.setItem("focus-desk.screen.1.widgets.views.v1", JSON.stringify([{ id: "work", name: "Work" }]));
    localStorage.setItem("focus-desk.screen.1.widgets.work.v1", JSON.stringify([inst("c", 1)]));
    localStorage.setItem("focus-desk.screen.1.groups.work.v1", JSON.stringify([]));

    const snap = exportScreenLayoutSnapshots();
    expect(Object.keys(snap).sort()).toEqual(["0", "1"]);
    expect(snap["0"].layouts.home).toHaveLength(2);
    expect(snap["0"].groups.home).toHaveLength(1);
    expect(snap["1"].layouts.work).toHaveLength(1);

    localStorage.clear();
    expect(importScreenLayoutSnapshot("0", snap["0"])).toBe(true);
    expect(importScreenLayoutSnapshot("1", snap["1"])).toBe(true);
    expect(loadInstances("home").map((i) => i.id)).toEqual(["a", "b"]);
    expect(loadGroups("home")).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem("focus-desk.screen.1.widgets.work.v1")!).map((i: { id: string }) => i.id)
    ).toEqual(["c"]);
    expect(JSON.parse(localStorage.getItem("focus-desk.screen.1.groups.work.v1")!)).toEqual([]);
  });

  it("多视图导入逐视图落盘（防止单槽防抖只剩最后一个视图）", async () => {
    const ok = importScreenLayoutSnapshot("0", {
      views: [
        { id: "home", name: "Home" },
        { id: "work", name: "Work" }
      ],
      layouts: { home: [inst("a", 1)], work: [inst("b", 1)] },
      groups: {}
    });
    expect(ok).toBe(true);
    // 不等防抖定时器：同步断言两个视图都已在盘上。
    expect(loadInstances("home").map((i) => i.id)).toEqual(["a"]);
    expect(loadInstances("work").map((i) => i.id)).toEqual(["b"]);
  });

  it("成员与组同时导入时编组不散（成员表与 groupId 对得上）", () => {
    const ok = importScreenLayoutSnapshot("0", {
      views: [{ id: "home", name: "Home" }],
      layouts: { home: [inst("a", 1), inst("b", 2)] },
      groups: { home: [GROUP] }
    });
    expect(ok).toBe(true);
    expect(loadGroups("home")).toHaveLength(1);
    expect(loadGroups("home")[0].memberIds).toEqual(["a", "b"]);
    // 成员 groupId 保留（sanitizeGroups 不再拿无关视图的组来剥）。
    expect(loadInstances("home").every((i) => i.groupId === "g1")).toBe(true);
  });

  it("视图表缺失/为空 → 整屏拒绝，现有数据不动", () => {
    localStorage.setItem("focus-desk.screen.0.widgets.views.v1", JSON.stringify([{ id: "home", name: "Home" }]));
    expect(importScreenLayoutSnapshot("0", { layouts: { home: [inst("a", 1)] } })).toBe(false);
    expect(importScreenLayoutSnapshot("0", { views: [], layouts: {} })).toBe(false);
    expect(localStorage.getItem("focus-desk.screen.0.widgets.views.v1")).toContain("home");
    expect(localStorage.getItem("focus-desk.screen.0.widgets.home.v1")).toBeNull();
  });

  it("导入数据过元素级校验：畸形实例/组被剔除（与读取侧同口径）", () => {
    const ok = importScreenLayoutSnapshot("0", {
      views: [{ id: "home", name: "Home" }],
      layouts: {
        home: [inst("a", 1), { id: "bad", type: "clock" }, { id: "z", type: "clock", x: 0, y: 0, w: 1, h: 1, z: "no" }]
      },
      groups: { home: [GROUP, { id: "broken" }] }
    });
    expect(ok).toBe(true);
    // z 非有限 = 损坏条目，整条剔除（不复活读取侧会丢弃的数据）。
    expect(loadInstances("home").map((i) => i.id)).toEqual(["a"]);
    expect(loadInstances("home").every((i) => Number.isFinite(i.z))).toBe(true);
    // broken 组无 memberIds 不入；g1 的成员 b 被剔除后仅剩 1 人 → 解散。
    expect(loadGroups("home")).toHaveLength(0);
  });
});
