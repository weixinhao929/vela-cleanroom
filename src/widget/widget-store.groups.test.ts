import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROUP_MIN_SIZE } from "./widget-groups";

/**
 * 编组对等修复批的 store 侧回归：
 *  - z 极值统一取实例∪组（重启后置顶平局 / 组置底 / 置顶守卫）；
 *  - updateGroup 提交钳回视口（组不可被拖出屏幕丢失）；
 *  - disbandGroup 返回快照 + restoreGroup 撤销重建；
 *  - removeGroup 组壳先播退场再延迟删除；
 *  - importLayout 整表替换后清洗悬空编组。
 *
 * 沿用 hydrate.test 的加载模式：非 Tauri 环境（无 SQLite 镜像路径），
 * 每次 loadModule 重建模块级 zCounter / 防抖缓冲。
 */

vi.mock("../lib/tauri", () => ({
  isTauri: () => false,
  invoke: async () => null
}));

async function loadModule() {
  vi.resetModules();
  return await import("./widget-store");
}

const LAYOUT_KEY = "focus-desk.screen.0.widgets.home.v1";
const GROUPS_KEY = "focus-desk.screen.0.groups.home.v1";

const inst = (id: string, z = 1, groupId?: string) => ({
  id,
  type: "clock",
  x: 0,
  y: 0,
  w: 200,
  h: 100,
  z,
  ...(groupId ? { groupId } : {})
});
const group = (id: string, z: number, memberIds: string[], activeId?: string) => ({
  id,
  x: 0,
  y: 0,
  w: 400,
  h: 200,
  z,
  memberIds,
  activeId: activeId ?? memberIds[0]
});

/** 布局 + 编组落盘后按真实路径 hydrate（组 z 一并喂进计数器的入口）。
 *  夹具在模块加载**之后**写入：loadModule 的 await 间隙里，前一个测试模块
 *  遗留的真实 300ms 防抖落盘会把旧布局写回同一 localStorage 键（跨模块实例
 *  的串扰），先写夹具再 await 会被它覆盖——hydrate 读到 3 个实例/空组就是
 *  这个竞态。写入与 hydrate 的同步前缀放在同一同步块，窗口归零。 */
async function bootWith(instances: unknown[], groups: unknown[] = []) {
  const { useWidgetStore } = await loadModule();
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(instances));
  if (groups.length) localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
  useWidgetStore.setState({ activeView: "home" });
  await useWidgetStore.getState().hydrate();
  return useWidgetStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("z 序极值统一（实例∪组）", () => {
  it("重启后卡片置顶严格高于组（回归：此前只看实例，newZ 与组平级被 DOM 序盖住）", async () => {
    // 组 z=3 高于全部实例；hydrate 只把实例 z 喂计数器时 zCounter=3，
    // bringToFront 会算出 newZ=3 与组平级。
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
    store.getState().bringToFront("a");
    const st = store.getState();
    const a = st.instances.find((i) => i.id === "a")!;
    const g = st.groups.find((x) => x.id === "g1")!;
    expect(a.z).toBeGreaterThan(g.z);
  });

  it("bringGroupToFront 已是唯一顶层时 no-op（写放大守卫：状态引用不变）", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
    const before = store.getState().groups;
    store.getState().bringGroupToFront("g1");
    expect(store.getState().groups).toBe(before);
  });

  it("bringGroupToFront 抬到高于卡片的层", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 9)], [group("g1", 3, ["a", "b"])]);
    store.getState().bringGroupToFront("g1");
    const st = store.getState();
    const g = st.groups.find((x) => x.id === "g1")!;
    const maxInst = Math.max(...st.instances.map((i) => i.z));
    expect(g.z).toBeGreaterThan(maxInst);
  });

  it("卡片置底严格低于组（此前只看实例，可能与组平级）", async () => {
    const store = await bootWith([inst("a", 5, "g1"), inst("b", 6, "g1"), inst("c", 2)], [group("g1", 1, ["a", "b"])]);
    store.getState().sendToBack("c");
    const st = store.getState();
    const c = st.instances.find((i) => i.id === "c")!;
    const g = st.groups.find((x) => x.id === "g1")!;
    expect(c.z).toBeLessThan(g.z);
  });

  it("sendGroupToBack：组严格低于全部卡片", async () => {
    const store = await bootWith([inst("a", 5, "g1"), inst("b", 6, "g1"), inst("c", 2)], [group("g1", 9, ["a", "b"])]);
    store.getState().sendGroupToBack("g1");
    const st = store.getState();
    const g = st.groups.find((x) => x.id === "g1")!;
    const minInst = Math.min(...st.instances.map((i) => i.z));
    expect(g.z).toBeLessThan(minInst);
  });
});

describe("updateGroup 视口钳制", () => {
  it("负坐标 / 超视口坐标都被夹回 [0, viewport-40]；对齐离网格值保持原样（P1）", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"], "b")]);
    const { updateGroup } = store.getState();
    updateGroup("g1", { x: -500, y: -30 });
    expect(store.getState().groups[0]).toMatchObject({ x: 0, y: 0 });
    updateGroup("g1", { x: 99999, y: 99999 });
    const g = store.getState().groups[0];
    // jsdom 视口 1024×768：clampFree 上限 = 1024-40 = 984 / 728（只夹取）。
    expect(g.x).toBeLessThanOrEqual(984);
    expect(g.y).toBeLessThanOrEqual(728);
    // 回归：智能对齐的离网格落点（≤8px）不再被 20px 网格吸附吞掉——
    // 此前 clampAxis 会把 101 → 100，参考线承诺的对齐在松手时丢失。
    updateGroup("g1", { x: 101, y: 203 });
    expect(store.getState().groups[0]).toMatchObject({ x: 101, y: 203 });
  });

  it("w/h 防御：低于容器最小尺寸夹起；非有限数整字段丢弃（w 原值保留）", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
    const { updateGroup } = store.getState();
    updateGroup("g1", { w: 50, h: 50 });
    expect(store.getState().groups[0]).toMatchObject({ w: GROUP_MIN_SIZE.w, h: GROUP_MIN_SIZE.h });
    updateGroup("g1", { w: Number.NaN });
    expect(store.getState().groups[0].w).toBe(GROUP_MIN_SIZE.w);
  });
});

describe("disbandGroup / restoreGroup（解散撤销闭环）", () => {
  it("解散返回快照、成员回原位并挂入场动画标记；restoreGroup 按快照重建", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"], "b")]);
      const snap = store.getState().disbandGroup("g1");
      expect(snap).toMatchObject({ id: "g1", activeId: "b", memberIds: ["a", "b"] });
      /* 组壳退场淡出（fx-fast 档 + 尾帧 ≈170ms）后再卸载、成员回场——
         快照同步返回，落表延迟一拍。 */
      vi.advanceTimersByTime(200);
      let st = store.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.instances.every((i) => i.groupId === undefined)).toBe(true);
      expect(st.enteringIds).toEqual(expect.arrayContaining(["a", "b"]));
      // 清理窗 750ms（覆盖 0.7s 落位脉冲全程，此前 550ms 会掐尾）。
      vi.advanceTimersByTime(800);
      expect(store.getState().enteringIds).not.toContain("a");

      store.getState().restoreGroup(snap!);
      st = store.getState();
      expect(st.groups).toHaveLength(1);
      expect(st.groups[0]).toMatchObject({ id: "g1", activeId: "b", memberIds: ["a", "b"] });
      expect(st.instances.find((i) => i.id === "a")!.groupId).toBe("g1");
      // 重建入场动画标记挂在组 id 上。
      expect(st.enteringIds).toContain("g1");
      expect(st.pulseIds).toContain("g1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("解散后成员不足 2 人时 restoreGroup no-op", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
    const snap = store.getState().disbandGroup("g1")!;
    store.getState().removeWidget("a");
    store.getState().restoreGroup(snap);
    expect(store.getState().groups).toHaveLength(0);
  });

  it("不抢已归属成员：解散后成员被编入别组，撤销解散跳过他们且不留幽灵条目", async () => {
    vi.useFakeTimers();
    try {
      // 场景：解散 g1(a,b,c) → a,b 被拖进新组 g2 → 撤销解散 g1。
      // 旧实现直接改写 groupId，g2.memberIds 残留 a/b（渲染不可见但持久化长存）。
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3, "g1")],
        [group("g1", 4, ["a", "b", "c"])]
      );
      const snap = store.getState().disbandGroup("g1")!;
      // 退场淡出窗口后再操作（成员此间仍挂 groupId）。
      vi.advanceTimersByTime(200);
      // a,b 另组新组 g2（拖拽合并路径）。
      store.getState().mergeIntoGroup(["a"], { kind: "widget", id: "b" });
      const g2 = store.getState().groups.find((g) => g.id !== "g1")!;
      expect(g2.memberIds).toEqual(["b", "a"]);

      store.getState().restoreGroup(snap);
      const st = store.getState();
      // g1 不复活（自由成员只剩 c 一人，不足 2 人）。
      expect(st.groups.map((g) => g.id)).toEqual([g2.id]);
      // a,b 仍归 g2：不被抢走、g2.memberIds 不变。
      expect(st.instances.find((i) => i.id === "a")!.groupId).toBe(g2.id);
      expect(st.groups[0].memberIds).toEqual(["b", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("部分成员被占时 restoreGroup 只回收自由成员（≥2 人仍可复活）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3, "g1"), inst("d", 5)],
        [group("g1", 4, ["a", "b", "c"])]
      );
      const snap = store.getState().disbandGroup("g1")!;
      // 退场淡出窗口后再操作。
      vi.advanceTimersByTime(200);
      // 只把 a 拖到自由卡 d 上另组新组；b,c 仍自由。
      const merged = store.getState().mergeIntoGroup(["a"], { kind: "widget", id: "d" });
      expect(merged).toBeTruthy();
      const other = store.getState().groups.find((g) => g.id !== "g1")!;
      expect(other.memberIds).toEqual(["d", "a"]);

      store.getState().restoreGroup(snap);
      const st = store.getState();
      // g1 以自由成员 [b,c] 复活；a 留在新组，两边的成员表都干净。
      const revived = st.groups.find((g) => g.id === "g1")!;
      expect(revived.memberIds).toEqual(["b", "c"]);
      expect(st.instances.find((i) => i.id === "a")!.groupId).toBe(other.id);
      expect(st.groups.find((g) => g.id === other.id)!.memberIds).toEqual(["d", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("removeGroup 组壳退场后延迟删除", () => {
  it("先挂 exitingIds 播退场，220ms 后删组、成员进回收站", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
      store.getState().removeGroup("g1");
      let st = store.getState();
      expect(st.groups).toHaveLength(1);
      expect(st.exitingIds).toContain("g1");
      vi.advanceTimersByTime(230);
      st = store.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.exitingIds).not.toContain("g1");
      // 成员退场（removeWidgetsAnimated 再等 220ms）后进回收站。
      expect(st.instances.map((i) => i.id).sort()).toEqual(["a", "b"]);
      vi.advanceTimersByTime(250);
      st = store.getState();
      expect(st.instances).toHaveLength(0);
      expect(st.trash.map((t) => t.id).sort()).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("退场中重复删除不追加会话", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
      store.getState().removeGroup("g1");
      store.getState().removeGroup("g1");
      expect(store.getState().exitingIds.filter((x) => x === "g1")).toHaveLength(1);
      vi.advanceTimersByTime(500);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mergeIntoGroup 并入反馈与 importLayout 清洗", () => {
  it("拖卡并入既有组：成员挂 groupId、组壳挂 pulse 标记", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 4)],
        [group("g1", 3, ["a", "b"])]
      );
      const out = store.getState().mergeIntoGroup(["c"], { kind: "group", id: "g1" });
      expect(out).toEqual({ groupId: "g1", appendedIds: ["c"] });
      const st = store.getState();
      expect(st.instances.find((i) => i.id === "c")!.groupId).toBe("g1");
      expect(st.groups[0].memberIds).toEqual(["a", "b", "c"]);
      expect(st.pulseIds).toContain("g1");
      vi.advanceTimersByTime(800);
      expect(store.getState().pulseIds).not.toContain("g1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("importLayout 整表替换后悬空编组被解散（成员引用消失）", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
    const json = JSON.stringify({ version: 1, instances: [inst("x", 1), inst("y", 2)] });
    expect(store.getState().importLayout(json)).toBe(true);
    const st = store.getState();
    expect(st.groups).toHaveLength(0);
    expect(st.instances.map((i) => i.id).sort()).toEqual(["x", "y"]);
    expect(st.instances.every((i) => i.groupId === undefined)).toBe(true);
  });
});

describe("loadGroups 损坏回退（E18 与 loadInstances 同口径）", () => {
  it("主键损坏/缺失 → 回退 .bak；主键是合法空数组 → 不用备份顶替（解散复活防护）", async () => {
    const { loadGroups } = await loadModule();
    localStorage.setItem(`${GROUPS_KEY}.bak`, JSON.stringify([group("g1", 3, ["a", "b"])]));
    // 主键损坏（非法 JSON）→ 备份顶上（此前直接返回 []，全部编组静默解散）。
    localStorage.setItem(GROUPS_KEY, "{corrupt");
    expect(loadGroups("home").map((g) => g.id)).toEqual(["g1"]);
    // 主键缺失 → 备份顶上。
    localStorage.removeItem(GROUPS_KEY);
    expect(loadGroups("home").map((g) => g.id)).toEqual(["g1"]);
    // 主键是合法空数组（用户刚解散全部编组）→ 权威，不用备份复活。
    localStorage.setItem(GROUPS_KEY, "[]");
    expect(loadGroups("home")).toEqual([]);
  });
});

describe("AIU 批：反馈闭环 / 组一等公民 / 组×组合并", () => {
  it("U4：并入既有组后 activeId 切到被拖成员（拖入即所见）", async () => {
    const store = await bootWith(
      [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 5)],
      [group("g1", 3, ["a", "b"], "a")]
    );
    const merged = store.getState().mergeIntoGroup(["c"], { kind: "group", id: "g1" });
    expect(merged).toMatchObject({ appendedIds: ["c"] });
    expect(store.getState().groups[0]).toMatchObject({ memberIds: ["a", "b", "c"], activeId: "c" });
  });

  it("U4：拖 A 放到 B 上建组，activeId 是被拖者 A 而非锚 B", async () => {
    const store = await bootWith([inst("a", 1), inst("b", 2)], []);
    store.getState().mergeIntoGroup(["a"], { kind: "widget", id: "b" });
    expect(store.getState().groups[0]).toMatchObject({ memberIds: ["b", "a"], activeId: "a" });
  });

  it("U3：移除成员默认带回场标记；feedback=false 静默；摘到剩 1 人整组解散", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3, "g1")],
        [group("g1", 4, ["a", "b", "c"])]
      );
      store.getState().removeGroupMember("g1", "a");
      let st = store.getState();
      expect(st.groups[0].memberIds).toEqual(["b", "c"]);
      expect(st.enteringIds).toContain("a");
      expect(st.pulseIds).toContain("a");
      vi.advanceTimersByTime(800);
      expect(store.getState().enteringIds).not.toContain("a");

      // 静默路径（拖标签摘出 / 删除成员 / 撤销合并共用）：无回场标记。
      store.getState().removeGroupMember("g1", "b", { feedback: false });
      st = store.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.enteringIds).toEqual([]);
      expect(st.pulseIds).toEqual([]);
      expect(st.instances.every((i) => i.groupId === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I6：mergeGroups 并组返回源快照；撤销链（静默摘回 + restoreGroup）重建源组", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3, "g2"), inst("d", 4, "g2")],
        [group("g1", 5, ["a", "b"], "b"), group("g2", 6, ["c", "d"], "c")]
      );
      const src = store.getState().mergeGroups("g1", "g2");
      expect(src).toMatchObject({ id: "g1", memberIds: ["a", "b"], activeId: "b" });
      /* 源壳退场淡出（≈170ms）后归并才落表、目标才脉冲。 */
      vi.advanceTimersByTime(200);
      let st = store.getState();
      expect(st.groups.map((g) => g.id)).toEqual(["g2"]);
      expect(st.groups[0].memberIds).toEqual(["c", "d", "a", "b"]);
      expect(st.instances.find((i) => i.id === "a")!.groupId).toBe("g2");
      expect(st.pulseIds).toContain("g2");
      // 撤销链（与 GroupCard 投放 toast 的 run 同路径）。
      for (const id of src!.memberIds) store.getState().removeGroupMember("g2", id, { feedback: false });
      store.getState().restoreGroup(src!);
      st = store.getState();
      expect(st.groups.map((g) => g.id).sort()).toEqual(["g1", "g2"]);
      expect(st.groups.find((g) => g.id === "g1")!.memberIds).toEqual(["a", "b"]);
      expect(st.groups.find((g) => g.id === "g2")!.memberIds).toEqual(["c", "d"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I6：mergeGroups 对同 id / 不存在的组返回 null 且无副作用", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
    expect(store.getState().mergeGroups("g1", "g1")).toBeNull();
    expect(store.getState().mergeGroups("g1", "nope")).toBeNull();
    expect(store.getState().groups).toHaveLength(1);
  });

  it("I4：alignSelected 混合对齐（实例 ∪ 组同套矩形数学，组几何走 groups 表）", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 5)], [group("g1", 3, ["a", "b"])]);
    store.getState().updateWidget("c", { x: 100, y: 100 });
    store.getState().setSelected(["g1", "c"]);
    store.getState().alignSelected("left");
    const st = store.getState();
    const g = st.groups[0];
    const c = st.instances.find((i) => i.id === "c")!;
    // 主单元 = 最后选中的 c（selectedId），组左缘吸附到 c 左缘。
    expect(c.x).toBe(100);
    expect(g.x).toBe(c.x);
    expect(st.posAnimIds).toEqual(expect.arrayContaining(["g1", "c"]));
  });

  it("I4：moveSelectedBy 覆盖选中的组（吸附网格）", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
    store.getState().selectWidget("g1");
    store.getState().moveSelectedBy(24, 24);
    expect(store.getState().groups[0]).toMatchObject({ x: 20, y: 20 });
  });

  it("I4：removeSelectionAnimated 分流（组走组删除、实例进回收站，全量可撤销）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 5)],
        [group("g1", 3, ["a", "b"])]
      );
      store.getState().setSelected(["g1", "c"]);
      store.getState().removeSelectionAnimated();
      // 退场窗口内：组壳与实例同时标记 exiting。
      expect(store.getState().exitingIds).toEqual(expect.arrayContaining(["g1", "c"]));
      // 两级退场（组壳 → 成员）串联，600ms 覆盖 220ms×2 + 余量。
      vi.advanceTimersByTime(600);
      const st = store.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.instances).toHaveLength(0);
      expect(st.trash.map((w) => w.id).sort()).toEqual(["a", "b", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("重命名标签（instance.label）", () => {
  it("updateWidget 写 label 并随布局落盘；空名清回落", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith([inst("a", 1), inst("b", 2)], []);
      store.getState().updateWidget("a", { label: "主时钟" });
      expect(store.getState().instances.find((i) => i.id === "a")!.label).toBe("主时钟");
      // 布局落盘是 300ms 尾随防抖：冲刷后可见。
      vi.advanceTimersByTime(400);
      const persisted = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "[]") as { id?: string; label?: string }[];
      expect(persisted.find((i) => i.id === "a")!.label).toBe("主时钟");
      // 清名：label 置 undefined（持久化 JSON 不残留空键）。
      store.getState().updateWidget("a", { label: undefined });
      expect(store.getState().instances.find((i) => i.id === "a")!.label).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("持久化里的非字符串 label 在入口被剔除（isValidInstance 收口）", async () => {
    const poisoned = [{ ...inst("a", 1), label: 123 }, inst("b", 2)];
    const store = await bootWith(poisoned, []);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["b"]);
  });

  it("超长 label（>256）同样被入口剔除（P5：只挡被篡改存储的极端值）", async () => {
    const poisoned = [{ ...inst("a", 1), label: "x".repeat(257) }, inst("b", 2)];
    const store = await bootWith(poisoned, []);
    expect(store.getState().instances.map((i) => i.id)).toEqual(["b"]);
    // 256 以内（UI 层 24 之外的“陈旧但无害”数据）放行。
    const ok = await bootWith([{ ...inst("a", 1), label: "x".repeat(256) }, inst("b", 2)], []);
    expect(ok.getState().instances).toHaveLength(2);
  });

  it("远端 sync 载荷的实例过 isLiveInstance（W6）：毒 label / 非有限坐标不入内存", async () => {
    /* applyRemoteWidgets 是模块级导出（操作模块单例 store）——必须与
       bootWith 的同一 loadModule 实例配对，静态导入会打到初始模块。 */
    const mod = await loadModule();
    const { useWidgetStore, applyRemoteWidgets } = mod;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([inst("a", 1)]));
    useWidgetStore.setState({ activeView: "home" });
    await useWidgetStore.getState().hydrate();
    applyRemoteWidgets({
      screenId: "0",
      activeView: "home",
      /* 毒载荷有意越出线协议类型（label 传数字 / 坐标 NaN）——审查远端包的
         isLiveInstance 清洗，不适用于干净类型；显式断言表达故意。 */
      instances: [
        inst("a", 1),
        { ...inst("b", 2), label: 42 as unknown as string },
        { ...inst("c", 3), x: Number.NaN }
      ] as Parameters<typeof applyRemoteWidgets>[0]["instances"],
      groups: [],
      views: [{ id: "home", name: "Home" }],
      trash: []
    });
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["a"]);
  });

  it("reorderGroupMembers 只接受既有成员的完整重排（拖拽提交的防御口径）", async () => {
    const store = await bootWith(
      [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3, "g1")],
      [group("g1", 4, ["a", "b", "c"])]
    );
    store.getState().reorderGroupMembers("g1", ["c", "a", "b"]);
    expect(store.getState().groups[0].memberIds).toEqual(["c", "a", "b"]);
    // 缺员 / 未知 id：拒绝。
    store.getState().reorderGroupMembers("g1", ["a", "b"]);
    expect(store.getState().groups[0].memberIds).toEqual(["c", "a", "b"]);
    store.getState().reorderGroupMembers("g1", ["a", "b", "zz"]);
    expect(store.getState().groups[0].memberIds).toEqual(["c", "a", "b"]);
  });
});

describe("R 批：组名 / 回收站显示名 / 副本去名 / 设置页并入", () => {
  it("updateGroup 写 name 随组落盘；undefined 恢复默认（持久化 JSON 不残留）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
      store.getState().updateGroup("g1", { name: "工作台" });
      expect(store.getState().groups[0].name).toBe("工作台");
      vi.advanceTimersByTime(400);
      const persisted = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]") as { name?: string }[];
      expect(persisted[0].name).toBe("工作台");
      // 恢复默认：键存在即覆盖展开，JSON 序列化丢弃 undefined 键。
      store.getState().updateGroup("g1", { name: undefined });
      expect(store.getState().groups[0].name).toBeUndefined();
      vi.advanceTimersByTime(400);
      const cleared = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]") as { name?: string }[];
      expect(cleared[0].name).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("持久化里的非字符串组名在入口剔除整组（isValidGroup 收口，与实例 label 同口径）", async () => {
    const store = await bootWith(
      [inst("a", 1, "g1"), inst("b", 2, "g1")],
      [{ ...group("g1", 3, ["a", "b"]), name: 42 }]
    );
    // 毒组被剔后，成员经 sanitize 摘除 groupId 回到自由态。
    expect(store.getState().groups).toHaveLength(0);
    expect(store.getState().instances.every((i) => !i.groupId)).toBe(true);
  });

  it("duplicateWidget 副本不带走 label（回落自动名 + 序号，避免与源卡完全同名）", async () => {
    const store = await bootWith([inst("a", 1), inst("b", 2)], []);
    store.getState().updateWidget("a", { label: "主时钟" });
    store.getState().duplicateWidget("a");
    const copy = store.getState().instances.find((i) => i.id !== "a" && i.id !== "b");
    expect(copy).toBeDefined();
    expect(copy!.label).toBeUndefined();
  });

  it("removeWidget → 回收站条目带 label 快照；restoreWidget 恢复后名字带回", async () => {
    const store = await bootWith([inst("a", 1), inst("b", 2)], []);
    store.getState().updateWidget("a", { label: "主时钟" });
    store.getState().removeWidget("a");
    const entry = store.getState().trash.find((t) => t.id === "a");
    expect(entry?.label).toBe("主时钟");
    store.getState().restoreWidget("a");
    expect(store.getState().instances.find((i) => i.id === "a")!.label).toBe("主时钟");
  });

  it("mergeIntoGroup(kind:group) 从设置页并入未编组实例：追加成员 + 激活标签切到新成员", async () => {
    const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3)], [group("g1", 4, ["a", "b"])]);
    const merged = store.getState().mergeIntoGroup(["c"], { kind: "group", id: "g1" });
    expect(merged).not.toBeNull();
    const g = store.getState().groups[0];
    expect(g.memberIds).toEqual(["a", "b", "c"]);
    expect(g.activeId).toBe("c");
    expect(store.getState().instances.find((i) => i.id === "c")!.groupId).toBe("g1");
  });

  it("mergeGroups（S5）：目标未命名采纳源组名；目标有名则保留（并入不改名）", async () => {
    vi.useFakeTimers();
    try {
      // 命名源 → 匿名目标：名字跟着走（此前随源组蒸发，只剩「编组 · N」）。
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3, "g2"), inst("d", 4, "g2")],
        [{ ...group("g1", 5, ["a", "b"]), name: "工作台" }, group("g2", 6, ["c", "d"])]
      );
      store.getState().mergeGroups("g1", "g2");
      vi.advanceTimersByTime(200); // 退场淡出后归并落表。
      const target = store.getState().groups.find((g) => g.id === "g2")!;
      expect(target.name).toBe("工作台");
      expect(target.memberIds).toEqual(["c", "d", "a", "b"]);
      // 匿名源 → 命名目标：目标名保留。
      const store2 = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1"), inst("c", 3, "g2"), inst("d", 4, "g2")],
        [group("g1", 5, ["a", "b"]), { ...group("g2", 6, ["c", "d"]), name: "常驻" }]
      );
      store2.getState().mergeGroups("g1", "g2");
      vi.advanceTimersByTime(200);
      const target2 = store2.getState().groups.find((g) => g.id === "g2")!;
      expect(target2.name).toBe("常驻");
      expect(store2.getState().groups.some((g) => g.id === "g1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});
