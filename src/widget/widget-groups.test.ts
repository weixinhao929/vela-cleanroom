/**
 * 组件编组测试：纯函数 + store 动作。
 * jsdom 下直接驱动 useWidgetStore（localStorage 权威，不 mock）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGroupFromAnchor,
  buildGroupFromMembers,
  findMergeTargetAt,
  reorderMemberIds,
  sanitizeGroups,
  stripGroupId,
  isValidGroup
} from "./widget-groups";
import { useWidgetStore, loadGroups, flushWidgetLayoutSync, applyRemoteWidgets } from "./widget-store";
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
  it("包围盒成组、成员坐标原样保留仅挂 groupId", () => {
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

  it("引用稳定契约：无变化的 sanitize 返回原 groups 数组 / 原组对象 / 原实例数组", () => {
    // 跨窗同步/切视图/hydrate 每次都跑 sanitize——无条件新建引用会让全部
    // GroupCard memo 失效重渲（回归：此前 groupsChanged 恒真）。
    const g1 = { id: "g1", x: 0, y: 0, w: 200, h: 160, z: 1, memberIds: ["a", "b"], activeId: "a" };
    const instances = [inst("a", { groupId: "g1" }), inst("b", { groupId: "g1" })];
    const first = sanitizeGroups([g1], instances);
    const second = sanitizeGroups(first.groups, first.instances);
    expect(second.groups).toBe(first.groups);
    expect(second.groups[0]).toBe(first.groups[0]);
    expect(second.instances).toBe(first.instances);
  });

  it("有变化的 sanitize 才换引用：成员缺失时组对象/成员表更新", () => {
    const g1 = { id: "g1", x: 0, y: 0, w: 200, h: 160, z: 1, memberIds: ["a", "b", "c"], activeId: "a" };
    const instances = [inst("a", { groupId: "g1" }), inst("b", { groupId: "g1" }), inst("c", { groupId: "g1" })];
    // 全员在场 → no-op：输入数组/组对象原样返回。
    const intact = sanitizeGroups([g1], instances);
    expect(intact.groups[0]).toBe(g1);
    expect(intact.groups[0].memberIds).toBe(g1.memberIds);
    // 删掉成员 c 再洗：memberIds 收缩 → 换新组对象。
    const fewer = sanitizeGroups(
      intact.groups,
      intact.instances.filter((i) => i.id !== "c")
    );
    expect(fewer.groups[0]).not.toBe(g1);
    expect(fewer.groups[0].memberIds).toEqual(["a", "b"]);
  });
});

describe("findMergeTargetAt", () => {
  const groups = [{ id: "g1", x: 300, y: 200, w: 400, h: 300, z: 5 }];

  it("指针点命中未编组卡 → widget 目标；拖拽中的卡被排除", () => {
    const instances = [inst("a", { x: 0, y: 0, z: 1 }), inst("b", { x: 260, y: 0, z: 2 })];
    expect(findMergeTargetAt(instances, groups, { x: 30, y: 30 }, ["dragged"])).toEqual({
      kind: "widget",
      id: "a"
    });
    // 被拖者自身不作为目标（(30,30) 只在 a 矩形内）。
    expect(findMergeTargetAt(instances, groups, { x: 30, y: 30 }, ["a"])).toBeNull();
  });

  it("组容器矩形命中 → group 目标（已编组成员的存储坐标不参与命中）", () => {
    const instances = [inst("m1", { x: 900, y: 900, groupId: "g1" }), inst("m2", { x: 950, y: 950, groupId: "g1" })];
    // 组矩形内、成员存储矩形外：以组为合并目标（旧实现在这里永远 null）。
    expect(findMergeTargetAt(instances, groups, { x: 660, y: 460 }, [])).toEqual({ kind: "group", id: "g1" });
    // 组矩形外无命中。
    expect(findMergeTargetAt(instances, groups, { x: 299, y: 499 }, [])).toBeNull();
  });

  it("同点命中取 z 最高者；指针未中回退拖拽预览中心", () => {
    const instances = [inst("a", { x: 0, y: 0, w: 400, h: 300, z: 1 }), inst("b", { x: 0, y: 0, z: 7 })];
    expect(findMergeTargetAt(instances, groups, { x: 10, y: 10 }, [])).toEqual({ kind: "widget", id: "b" });
    // 指针 (1000,1000) 无命中，回退点 (250,250) 只在 a 矩形内（b 0..200²、
    // g1 300..700×200..500 之外）→ 命中 a。
    expect(findMergeTargetAt(instances, groups, { x: 1000, y: 1000 }, ["x"], [{ x: 250, y: 250 }])).toEqual({
      kind: "widget",
      id: "a"
    });
    // 全部未中 → null。
    expect(findMergeTargetAt(instances, groups, { x: 1000, y: 1000 }, [], [{ x: 1001, y: 1001 }])).toBeNull();
  });
});

describe("reorderMemberIds（标签拖拽重排）", () => {
  it("移到目标标签之前 / 末尾；命中自身或未知目标原样返回", () => {
    expect(reorderMemberIds(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(reorderMemberIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderMemberIds(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    // 命中被拖者自身（id 已在目标之前 / beforeId=id）→ 顺序不变。
    expect(reorderMemberIds(["a", "b", "c"], "a", "b")).toEqual(["a", "b", "c"]);
    expect(reorderMemberIds(["a", "b", "c"], "a", "a")).toEqual(["a", "b", "c"]);
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

  it("switchGroupTab / removeGroupMember（剩 1 人自动解散）/ disbandGroup", async () => {
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
    // disbandGroup 现为异步退场——先播 ~170ms .is-exiting 动画再移除
    // 组（widget-store.groups.test 同款语义）；本文件用真实定时器，等动画
    // 窗口走完再断言。
    useWidgetStore.setState({ selectedIds: ["a", "b"] });
    useWidgetStore.getState().groupSelected();
    const g2 = useWidgetStore.getState().groups[0];
    useWidgetStore.getState().disbandGroup(g2.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    const merged = st.mergeIntoGroup(["a"], { kind: "widget", id: "b" });
    expect(merged).not.toBeNull();
    let after = useWidgetStore.getState();
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0]).toMatchObject({ x: 300, y: 200, w: 240, h: 200, memberIds: ["b", "a"] });
    expect(after.instances.find((i) => i.id === "a")!.groupId).toBe(merged!.groupId);
    expect(after.instances.find((i) => i.id === "c")!.groupId).toBeUndefined();

    // c 拖到组内成员 b 上 → 追加进既有组。
    useWidgetStore.getState().mergeIntoGroup(["c"], { kind: "widget", id: "b" });
    after = useWidgetStore.getState();
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0].memberIds).toEqual(["b", "a", "c"]);
    expect(after.instances.find((i) => i.id === "c")!.groupId).toBe(merged!.groupId);

    // 无效输入：拖自己、目标不存在。
    expect(useWidgetStore.getState().mergeIntoGroup(["a"], { kind: "widget", id: "a" })).toBeNull();
    expect(useWidgetStore.getState().mergeIntoGroup(["a"], { kind: "widget", id: "ghost" })).toBeNull();
  });

  it("applyRemoteWidgets：载荷缺 groups（旧版本发送方）保留本地组；带 groups 正常跟随", () => {
    useWidgetStore.setState({ instances: [inst("a"), inst("b")] });
    useWidgetStore.setState({ selectedIds: ["a", "b"] });
    useWidgetStore.getState().groupSelected();
    const g = useWidgetStore.getState().groups[0];
    const groupedInstances = useWidgetStore.getState().instances;
    const base = {
      screenId: "0",
      views: [{ id: "home", name: "Home" }],
      activeView: "home",
      trash: []
    };

    // 旧版本/漏发快照（无 groups 字段）：本地组必须原样保留（回归：
    // 「合并后打开设置窗口，编组被无组快照清散」）。
    applyRemoteWidgets({ ...base, instances: groupedInstances });
    expect(useWidgetStore.getState().groups).toHaveLength(1);
    expect(useWidgetStore.getState().groups[0].id).toBe(g.id);

    // 新版本快照（带 groups）：接收端跟随发送方。
    applyRemoteWidgets({
      ...base,
      instances: groupedInstances.map((i) => (i.id === "a" ? { ...i, x: 999 } : i)),
      groups: []
    });
    expect(useWidgetStore.getState().groups).toEqual([]);
  });

  it("updateGroup 支持组级透明度并随组持久化（组 × 成员是上下级）", () => {
    useWidgetStore.setState({ instances: [inst("a"), inst("b")], selectedIds: ["a", "b"] });
    useWidgetStore.getState().groupSelected();
    const g = useWidgetStore.getState().groups[0];
    useWidgetStore.getState().updateGroup(g.id, { opacity: 0.4 });
    const after = useWidgetStore.getState();
    expect(after.groups[0].opacity).toBe(0.4);
    // 成员自身 opacity 不受组级设置影响（下一级独立）。
    expect(after.instances.find((i) => i.id === "a")!.opacity).toBeUndefined();
    flushWidgetLayoutSync();
    expect(loadGroups("home")[0].opacity).toBe(0.4);
  });

  it("reorderGroupMembers：完整重排生效、activeId 保留；缺员/多员/未知 id 拒绝", () => {
    useWidgetStore.setState({ instances: [inst("a"), inst("b"), inst("c")], selectedIds: ["a", "b", "c"] });
    useWidgetStore.getState().groupSelected();
    const g = useWidgetStore.getState().groups[0];
    useWidgetStore.getState().switchGroupTab(g.id, "b");

    useWidgetStore.getState().reorderGroupMembers(g.id, ["c", "b", "a"]);
    const after = useWidgetStore.getState();
    expect(after.groups[0].memberIds).toEqual(["c", "b", "a"]);
    expect(after.groups[0].activeId).toBe("b");

    // 原顺序提交 = no-op。
    useWidgetStore.getState().reorderGroupMembers(g.id, ["c", "b", "a"]);
    expect(useWidgetStore.getState().groups[0].memberIds).toEqual(["c", "b", "a"]);

    // 缺员 / 未知 id → 拒绝（顺序不变）。
    useWidgetStore.getState().reorderGroupMembers(g.id, ["c", "b"]);
    useWidgetStore.getState().reorderGroupMembers(g.id, ["c", "b", "a", "ghost"]);
    expect(useWidgetStore.getState().groups[0].memberIds).toEqual(["c", "b", "a"]);
  });

  it("mergeIntoGroup：kind=group 直接并入该组（拖到编组容器上），拖全编组者返回 null", () => {
    useWidgetStore.setState({
      instances: [inst("m1", { x: 20, y: 20 }), inst("m2", { x: 260, y: 20 }), inst("c", { x: 600, y: 20 })]
    });
    useWidgetStore.setState({ selectedIds: ["m1", "m2"] });
    useWidgetStore.getState().groupSelected();
    const g = useWidgetStore.getState().groups[0];
    expect(g).toBeTruthy();

    const merged = useWidgetStore.getState().mergeIntoGroup(["c"], { kind: "group", id: g.id });
    expect(merged).toEqual({ groupId: g.id, appendedIds: ["c"] });
    const after = useWidgetStore.getState();
    expect(after.groups[0].memberIds).toEqual(["m1", "m2", "c"]);
    expect(after.instances.find((i) => i.id === "c")!.groupId).toBe(g.id);

    // 幽灵组 id → null。
    expect(useWidgetStore.getState().mergeIntoGroup(["c"], { kind: "group", id: "ghost" })).toBeNull();
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

  it("结构校验：几何 / z 非有限数字（NaN / Infinity / 字符串）拒绝——防毒化共享 z 序空间", () => {
    const base = { id: "g", x: 0, y: 0, w: 1, h: 1, z: 1, memberIds: ["a"], activeId: "a" };
    expect(isValidGroup({ ...base, z: NaN })).toBe(false);
    expect(isValidGroup({ ...base, z: Infinity })).toBe(false);
    expect(isValidGroup({ ...base, z: "1" })).toBe(false);
    expect(isValidGroup({ ...base, x: NaN })).toBe(false);
    expect(isValidGroup(base)).toBe(true);
  });

  it("结构校验：opacity 可选，出现即须为有限数字（字符串/NaN 会顺着组壳 CSS calc 与面板滑条静默错乱）", () => {
    const base = { id: "g", x: 0, y: 0, w: 1, h: 1, z: 1, memberIds: ["a"], activeId: "a" };
    expect(isValidGroup({ ...base, opacity: 0.5 })).toBe(true);
    expect(isValidGroup({ ...base, opacity: 1 })).toBe(true);
    expect(isValidGroup({ ...base, opacity: "0.5" })).toBe(false);
    expect(isValidGroup({ ...base, opacity: NaN })).toBe(false);
    expect(isValidGroup(base)).toBe(true);
  });
});
