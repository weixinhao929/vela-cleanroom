/**
 * 组件编组（DeskOrder 借鉴 #12）测试：纯函数 + store 动作。
 * jsdom 下直接驱动 useWidgetStore（localStorage 权威，不 mock）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGroupFromAnchor,
  buildGroupFromMembers,
  sanitizeGroups,
  stripGroupId,
  isValidGroup
} from "./widget-groups";
import { useWidgetStore, loadGroups, flushWidgetLayoutSync } from "./widget-store";
import type { WidgetInstance } from "./widget-store";

/* sqliteRepo 镜像写是异步 fire-and-forget：jsdom 无 Tauri 时 isTauri()=false，
   不会触达；广播 emit 同理。 */
vi.mock("../lib/local-backup", () => ({ persistMirrored: () => true }));

const inst = (id: string, over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "clock",
  x: 20,
  y: 20,
  w: 200,
  h: 160,
  z: 1,
  ...over
});

const NOW = 5;

beforeEach(() => {
  localStorage.clear();
  useWidgetStore.setState({
    instances: [],
    groups: [],
    selectedIds: [],
    selectedId: null,
    activeView: "home",
    views: [{ id: "home", name: "Home" }],
    trash: []
  });
});
afterEach(() => {
  localStorage.clear();
});

describe("buildGroupFromMembers", () => {
  it("包围盒成组、成员坐标原样保留仅挂 groupId（BentoDesk 借鉴 #2：编组是渲染态）", () => {
    const built = buildGroupFromMembers(
      [inst("a", { x: 20, y: 40 }), inst("b", { x: 260, y: 100 }), inst("c", { x: 100, y: 320 })],
      () => "g1",
      () => NOW
    )!;
    expect(built.group).toMatchObject({ id: "g1", x: 20, y: 40, z: NOW, memberIds: ["a", "b", "c"], activeId: "a" });
    // 包围盒：x[20,460) y[40,480)。
    expect(built.group.w).toBe(440);
    expect(built.group.h).toBe(440);
    expect(built.members.every((m) => m.groupId === "g1")).toBe(true);
    // 坐标不被改写——解散即回编组前原位。
    expect(built.members[0]).toMatchObject({ x: 20, y: 40 });
    expect(built.members[1]).toMatchObject({ x: 260, y: 100 });
    expect(built.members[2]).toMatchObject({ x: 100, y: 320 });
  });

  it("少于 2 人或含已编组成员返回 null", () => {
    expect(
      buildGroupFromMembers(
        [inst("a")],
        () => "g",
        () => 1
      )
    ).toBeNull();
    expect(
      buildGroupFromMembers(
        [inst("a"), inst("b", { groupId: "other" })],
        () => "g",
        () => 1
      )
    ).toBeNull();
  });
});

describe("buildGroupFromAnchor", () => {
  it("拖拽合并：组几何取 anchor 矩形，成员含 anchor 与被拖者、坐标不动", () => {
    const built = buildGroupFromAnchor(
      inst("b", { x: 300, y: 200, w: 240, h: 200 }),
      [inst("a", { x: 20, y: 40 })],
      () => "g9",
      () => NOW
    )!;
    expect(built.group).toMatchObject({
      id: "g9",
      x: 300,
      y: 200,
      w: 240,
      h: 200,
      memberIds: ["b", "a"],
      activeId: "b"
    });
    expect(built.members.map((m) => m.id)).toEqual(["b", "a"]);
    expect(built.members.every((m) => m.groupId === "g9")).toBe(true);
    expect(built.members.find((m) => m.id === "a")!).toMatchObject({ x: 20, y: 40 });
  });

  it("anchor 已编组或无被拖者返回 null", () => {
    expect(
      buildGroupFromAnchor(
        inst("b", { groupId: "g" }),
        [inst("a")],
        () => "g",
        () => 1
      )
    ).toBeNull();
    expect(
      buildGroupFromAnchor(
        inst("b"),
        [],
        () => "g",
        () => 1
      )
    ).toBeNull();
  });
});

describe("sanitizeGroups", () => {
  it("成员缺失到 <2 → 解散；activeId 失效回落；孤儿 groupId 清理", () => {
    const g1 = { id: "g1", x: 0, y: 0, w: 200, h: 160, z: 1, memberIds: ["a", "b", "ghost"], activeId: "ghost" };
    const g2 = { id: "g2", x: 0, y: 0, w: 200, h: 160, z: 2, memberIds: ["c", "d"], activeId: "c" };
    const instances = [inst("a"), inst("b"), inst("c"), inst("d"), inst("e", { groupId: "gone" })];
    const out = sanitizeGroups([g1, g2], instances);
    // g1 过滤掉幽灵成员后仍有 a/b 两人 → 保留（不解散）。
    expect(out.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    // g1 剩 2 个真实成员仍保留？memberIds 过滤后 a,b 仍在（≥2）→ 应保留而非解散。
    expect(out.groups[0].memberIds).toEqual(["a", "b"]);
    expect(out.groups[0].activeId).toBe("a");
    // 孤儿 groupId 清理。
    expect(out.instances.find((i) => i.id === "e")!.groupId).toBeUndefined();
  });

  it("组只剩 1 个真实成员 → 整组解散", () => {
    const g = { id: "g1", x: 0, y: 0, w: 200, h: 160, z: 1, memberIds: ["a", "ghost"], activeId: "a" };
    const out = sanitizeGroups([g], [inst("a", { groupId: "g1" })]);
    expect(out.groups).toEqual([]);
    expect(out.instances.find((i) => i.id === "a")!.groupId).toBeUndefined();
  });
});

describe("store 编组动作", () => {
  it("groupSelected → 组建立、成员移出画布渲染集（groupId 标记）、持久化可读回", () => {
    const st = useWidgetStore.getState();
    useWidgetStore.setState({
      instances: [inst("a", { x: 20, y: 20 }), inst("b", { x: 260, y: 20 }), inst("solo", { x: 500, y: 20 })],
      selectedIds: ["a", "b"]
    });
    st.groupSelected();
    const after = useWidgetStore.getState();
    expect(after.groups).toHaveLength(1);
    const g = after.groups[0];
    expect(g.memberIds).toEqual(["a", "b"]);
    expect(after.instances.find((i) => i.id === "a")!.groupId).toBe(g.id);
    expect(after.instances.find((i) => i.id === "solo")!.groupId).toBeUndefined();
    expect(after.selectedIds).toEqual([]);
    // 防抖落盘前 flushWidgetLayoutSync；直接调 loadGroups 前手动冲刷。
    flushWidgetLayoutSync();
    expect(loadGroups("home").map((x) => x.id)).toEqual([g.id]);
  });

  it("switchGroupTab / removeGroupMember（剩 1 人自动解散）/ disbandGroup", () => {
    useWidgetStore.setState({
      instances: [inst("a"), inst("b"), inst("c")],
      selectedIds: ["a", "b", "c"]
    });
    useWidgetStore.getState().groupSelected();
    const g = useWidgetStore.getState().groups[0];
    expect(g.activeId).toBe("a");

    useWidgetStore.getState().switchGroupTab(g.id, "b");
    expect(useWidgetStore.getState().groups[0].activeId).toBe("b");

    useWidgetStore.getState().removeGroupMember(g.id, "b");
    let st = useWidgetStore.getState();
    expect(st.instances.find((i) => i.id === "b")!.groupId).toBeUndefined();
    expect(st.groups[0].memberIds).toEqual(["a", "c"]);

    // 再摘一个 → 只剩 1 人 → 整组解散。
    useWidgetStore.getState().removeGroupMember(st.groups[0].id, "c");
    st = useWidgetStore.getState();
    expect(st.groups).toEqual([]);
    expect(st.instances.every((i) => !i.groupId)).toBe(true);

    // 重新编组后解散：成员回到编组前原位（坐标从未被改写）。
    useWidgetStore.setState({ selectedIds: ["a", "b"] });
    useWidgetStore.getState().groupSelected();
    const g2 = useWidgetStore.getState().groups[0];
    useWidgetStore.getState().disbandGroup(g2.id);
    st = useWidgetStore.getState();
    expect(st.groups).toEqual([]);
    expect(st.instances.find((i) => i.id === "a")!).toMatchObject({ x: 20, y: 20 });
    expect(st.instances.find((i) => i.id === "b")!).toMatchObject({ x: 20, y: 20 });
    expect(st.instances.every((i) => !i.groupId)).toBe(true);
  });

  it("mergeIntoGroup：目标未编组 → 以目标矩形建组；追加到已有组 → 成员并入", () => {
    useWidgetStore.setState({
      instances: [
        inst("a", { x: 20, y: 20 }),
        inst("b", { x: 300, y: 200, w: 240, h: 200 }),
        inst("c", { x: 600, y: 20 })
      ]
    });
    const st = useWidgetStore.getState();
    const merged = st.mergeIntoGroup(["a"], "b");
    expect(merged).not.toBeNull();
    let after = useWidgetStore.getState();
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0]).toMatchObject({ x: 300, y: 200, w: 240, h: 200, memberIds: ["b", "a"] });
    expect(after.instances.find((i) => i.id === "a")!.groupId).toBe(merged!.groupId);
    expect(after.instances.find((i) => i.id === "c")!.groupId).toBeUndefined();

    // c 拖到组内成员 b 上 → 追加进既有组。
    useWidgetStore.getState().mergeIntoGroup(["c"], "b");
    after = useWidgetStore.getState();
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0].memberIds).toEqual(["b", "a", "c"]);
    expect(after.instances.find((i) => i.id === "c")!.groupId).toBe(merged!.groupId);

    // 无效输入：拖自己、目标不存在。
    expect(useWidgetStore.getState().mergeIntoGroup(["a"], "a")).toBeNull();
    expect(useWidgetStore.getState().mergeIntoGroup(["a"], "ghost")).toBeNull();
  });
});

describe("stripGroupId / isValidGroup", () => {
  it("剥离 groupId（模板/导出快照不携带编组）", () => {
    const out = stripGroupId([inst("a", { groupId: "g" }), inst("b")]);
    expect(out.every((i) => i.groupId === undefined)).toBe(true);
  });

  it("结构校验", () => {
    expect(isValidGroup({ id: "g", x: 0, y: 0, w: 1, h: 1, z: 1, memberIds: ["a"], activeId: "a" })).toBe(true);
    expect(isValidGroup(null)).toBe(false);
    expect(isValidGroup({ id: "g", memberIds: "a" })).toBe(false);
  });
});
