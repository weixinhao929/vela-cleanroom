import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V 批store 侧回归：
 *  - V1：removeGroup 的撤销 toast 恢复成员后重建编组（组名/激活标签不丢）；
 *  - V2：applyTimelineState 自增 historyEpoch + 清 exitingIds + sanitize 悬空
 *    groupId；退场窗口内的撤销抢占后，延迟变更回调到点放弃执行；
 *  - V3：applyRemoteWidgets 不复活**已提交删除**的组（墓碑拦截迟到
 *    整包）；退场窗内不再过滤——回调到点正常完成删除，不再半途流产；
 *  - V5：duplicateGroup 整组复制（新 id 池 / GRID 偏移 / 去名 / activeId 映射）；
 *  - ：disbandGroup / removeGroup 到期清理选中残留（死 id 不留在选中集）。
 *
 * 沿用 groups 测试的加载模式：非 Tauri 环境，每次 loadModule 重建模块级
 * zCounter / 防抖缓冲。toast 经 vi.mock 捕获（widget-store 是命名导入，
 * spyOn ESM 命名空间拿不到真实调用）。
 */

const toasts = vi.hoisted(() => [] as unknown[][]);
vi.mock("../components/ToastHost", () => ({
  pushAppToast: (...args: unknown[]) => {
    toasts.push(args);
  }
}));
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

/** 与 groups 测试同款：夹具在模块加载之后写入，写入与 hydrate 同步前缀零窗口。 */
async function bootWith(instances: unknown[], groups: unknown[] = []) {
  const { useWidgetStore } = await loadModule();
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(instances));
  if (groups.length) localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
  useWidgetStore.setState({ activeView: "home" });
  await useWidgetStore.getState().hydrate();
  return useWidgetStore;
}

/** 取最近一条 toast 的撤销动作（V1 验证 toast run 本体，不复刻调用链）。 */
const lastUndo = () => {
  const last = toasts[toasts.length - 1] as [unknown, string, string, { action?: { run?: () => void } }] | undefined;
  return last?.[3]?.action?.run;
};

beforeEach(() => {
  localStorage.clear();
  toasts.length = 0;
});

describe("删除撤销 / 时间线纪元 / 远端复活 / 整组复制 / 选中清理", () => {
  it("V1：removeGroup 撤销 toast 恢复成员后重建编组（组名/激活标签随撤销回来）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith(
        [inst("a", 1, "g1"), inst("b", 2, "g1")],
        [{ ...group("g1", 3, ["a", "b"], "b"), name: "我的组" }]
      );
      store.getState().removeGroup("g1");
      // 两级退场（组壳 220ms + 成员 220ms）串联后：成员进回收站、toast 落定。
      vi.advanceTimersByTime(600);
      let st = store.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.trash.map((w) => w.id).sort()).toEqual(["a", "b"]);
      const undo = lastUndo();
      expect(undo).toBeTypeOf("function");
      undo!();
      st = store.getState();
      const g = st.groups.find((x) => x.id === "g1")!;
      expect(g).toMatchObject({ name: "我的组", activeId: "b", memberIds: ["a", "b"] });
      expect(
        st.instances
          .filter((i) => i.groupId === "g1")
          .map((i) => i.id)
          .sort()
      ).toEqual(["a", "b"]);
      expect(st.trash).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("V2：退场窗口内的撤销（applyTimelineState）抢占延迟解散——回调到点放弃", async () => {
    vi.useFakeTimers();
    try {
      /* applyTimelineState 是模块级导出（操作模块单例）——必须与 bootWith
         的同一 loadModule 实例配对。 */
      const mod = await loadModule();
      const { useWidgetStore, applyTimelineState } = mod;
      localStorage.setItem(LAYOUT_KEY, JSON.stringify([inst("a", 1, "g1"), inst("b", 2, "g1")]));
      localStorage.setItem(GROUPS_KEY, JSON.stringify([group("g1", 3, ["a", "b"])]));
      useWidgetStore.setState({ activeView: "home" });
      await useWidgetStore.getState().hydrate();
      const origInstances = useWidgetStore.getState().instances;
      const origGroups = useWidgetStore.getState().groups;
      expect(useWidgetStore.getState().disbandGroup("g1")).toBeTruthy();
      expect(useWidgetStore.getState().exitingIds).toContain("g1");
      // 撤销落在退场窗口内：整套旧状态回来 + exitingIds 清空 + 纪元自增。
      applyTimelineState("home", origInstances, origGroups);
      let st = useWidgetStore.getState();
      expect(st.exitingIds).toEqual([]);
      expect(st.historyEpoch).toBe(1);
      // 到期回调发现纪元不符：不再卸载，编组原样保留、成员不入回收站。
      vi.advanceTimersByTime(500);
      st = useWidgetStore.getState();
      expect(st.groups.map((g) => g.id)).toEqual(["g1"]);
      expect(st.instances.every((i) => i.groupId === "g1")).toBe(true);
      expect(st.trash).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("V2：applyTimelineState 套用前清洗悬空 groupId / 治愈 activeId（中间态快照不再产出隐形卡）", async () => {
    const mod = await loadModule();
    const { useWidgetStore, applyTimelineState } = mod;
    useWidgetStore.setState({ activeView: "home" });
    // 中间态快照：组表已删 g1、成员 a 的 groupId 还挂着；g2 有幽灵成员 zz 且
    // activeId 失效（治愈到 ≥2 员保留；若只剩 1 员则整组解散——同落盘口径）。
    applyTimelineState(
      "home",
      [inst("a", 1, "g1"), inst("b", 2), inst("c", 3, "g2"), inst("d", 4, "g2")],
      [group("g2", 5, ["c", "d", "zz"], "zz")]
    );
    const st = useWidgetStore.getState();
    expect(st.instances.find((i) => i.id === "a")!.groupId).toBeUndefined();
    const g2 = st.groups.find((x) => x.id === "g2")!;
    expect(g2.memberIds).toEqual(["c", "d"]);
    expect(g2.activeId).toBe("c");
  });

  it("ZF-3：退场窗内远端整包不再滤组——回调到点正常完成删除（不半途流产）", async () => {
    vi.useFakeTimers();
    try {
      const mod = await loadModule();
      const { useWidgetStore, applyRemoteWidgets } = mod;
      localStorage.setItem(LAYOUT_KEY, JSON.stringify([inst("a", 1), inst("b", 2)]));
      localStorage.setItem(GROUPS_KEY, JSON.stringify([group("g1", 3, ["a", "b"])]));
      useWidgetStore.setState({ activeView: "home" });
      await useWidgetStore.getState().hydrate();
      // 删除第一拍：组壳进入退场（exitingIds），真实删除在 fxMs+20 的回调里。
      useWidgetStore.getState().removeGroup("g1");
      expect(useWidgetStore.getState().exitingIds).toContain("g1");
      // 退场窗内对端整包（仍含该组——删除广播尚未发出）到达：
      applyRemoteWidgets({
        screenId: "0",
        activeView: "home",
        instances: [inst("a", 1, "g1"), inst("b", 2, "g1")] as Parameters<typeof applyRemoteWidgets>[0]["instances"],
        groups: [group("g1", 3, ["a", "b"])],
        views: [{ id: "home", name: "Home" }],
        trash: []
      });
      // 新语义：组壳不被提前滤掉（回调 find 仍能找到组，删除完整走完——
      // 成员进回收站、有撤销 toast、有删除广播）。旧语义在此把壳滤掉，
      // 回调早退 → 成员散落、无回收站、无撤销（的半途流产形态）。
      expect(useWidgetStore.getState().groups.some((g) => g.id === "g1")).toBe(true);
      vi.advanceTimersByTime(600); // 组回调（fxMs+20）+ 成员退场动画余量
      const st = useWidgetStore.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.trash.length).toBe(2); // 两名成员都进了回收站
      expect(toasts.length).toBeGreaterThan(0); // 撤销 toast 出现
    } finally {
      vi.useRealTimers();
    }
  });

  it("ZF-3：删除提交后的迟到旧整包被墓碑拦下（不复活已删组）；撤销清墓碑后恢复采纳", async () => {
    vi.useFakeTimers();
    try {
      const mod = await loadModule();
      const { useWidgetStore, applyRemoteWidgets } = mod;
      localStorage.setItem(LAYOUT_KEY, JSON.stringify([inst("a", 1), inst("b", 2)]));
      localStorage.setItem(GROUPS_KEY, JSON.stringify([group("g1", 3, ["a", "b"])]));
      useWidgetStore.setState({ activeView: "home" });
      await useWidgetStore.getState().hydrate();
      useWidgetStore.getState().removeGroup("g1");
      vi.advanceTimersByTime(600); // 删除已提交，墓碑在位
      expect(useWidgetStore.getState().groups).toHaveLength(0);
      // 对端尚未收到删除广播的迟到整包（V3 的原始威胁场景）：
      applyRemoteWidgets({
        screenId: "0",
        activeView: "home",
        instances: [inst("a", 1, "g1"), inst("b", 2, "g1")] as Parameters<typeof applyRemoteWidgets>[0]["instances"],
        groups: [group("g1", 3, ["a", "b"])],
        views: [{ id: "home", name: "Home" }],
        trash: []
      });
      expect(useWidgetStore.getState().groups).toHaveLength(0); // 不复活
      // 撤销（undo toast 同款序列：先逐个恢复成员，再重建组）清墓碑后，
      // 远端携带该组的包恢复采纳（复审补强：字面再喂一次远端包验证）。
      useWidgetStore.getState().restoreWidget("a");
      useWidgetStore.getState().restoreWidget("b");
      useWidgetStore.getState().restoreGroup(group("g1", 3, ["a", "b"]));
      expect(useWidgetStore.getState().groups.some((g) => g.id === "g1")).toBe(true);
      applyRemoteWidgets({
        screenId: "0",
        activeView: "home",
        instances: [inst("a", 1, "g1"), inst("b", 2, "g1")] as Parameters<typeof applyRemoteWidgets>[0]["instances"],
        groups: [group("g1", 3, ["a", "b"])],
        views: [{ id: "home", name: "Home" }],
        trash: []
      });
      // 墓碑已随撤销清除：远端包不再被滤，组在表（撤销后远端更新可达）。
      expect(useWidgetStore.getState().groups.some((g) => g.id === "g1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("V5：duplicateGroup 整组复制——新 id 池 / GRID 偏移 / 组名与 label 回落 / activeId 映射", async () => {
    const store = await bootWith(
      [inst("a", 1, "g1"), inst("b", 2, "g1")],
      [{ ...group("g1", 3, ["a", "b"], "b"), name: "工作区", opacity: 0.8 }]
    );
    store.getState().updateWidget("a", { label: "我的钟" });
    const before = store.getState();
    const beforeCount = before.instances.length;
    before.duplicateGroup("g1");
    const st = store.getState();
    expect(st.groups).toHaveLength(2);
    const copy = st.groups.find((g) => g.id !== "g1")!;
    // 副本哲学：组名回落默认；几何类属性（opacity）保留。
    expect(copy.name).toBeUndefined();
    expect(copy.opacity).toBe(0.8);
    expect(copy.memberIds).toHaveLength(2);
    expect(copy.memberIds).not.toEqual(["a", "b"]);
    // 源 activeId=b（第 2 员）→ 映射到副本第 2 员。
    expect(copy.activeId).toBe(copy.memberIds[1]);
    expect(st.instances).toHaveLength(beforeCount + 2);
    const copies = st.instances.filter((i) => i.groupId === copy.id);
    expect(copies.map((i) => i.id).sort()).toEqual([...copy.memberIds].sort());
    // 副本：GRID 偏移（20）、label 回落；源侧原样不动。
    expect(copies.every((i) => i.x === 20 && i.y === 20 && i.label === undefined)).toBe(true);
    const srcA = st.instances.find((i) => i.id === "a")!;
    expect(srcA.label).toBe("我的钟");
    expect(srcA.groupId).toBe("g1");
    expect(srcA.x).toBe(0);
    expect(st.groups.find((g) => g.id === "g1")!.x).toBe(0);
    // 副本组壳抬到高于全部实例与源组；入列入场标记。
    expect(copy.z).toBeGreaterThan(Math.max(...st.instances.map((i) => i.z)));
    expect(st.enteringIds).toContain(copy.id);
    // 不存在的组 / 不足两员：no-op。
    store.getState().duplicateGroup("nope");
    expect(store.getState().groups).toHaveLength(2);
  });

  it("V6：disbandGroup 到期清理选中残留（死 id 不留在 selectedIds）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
      store.getState().setSelected(["g1"]);
      expect(store.getState().selectedId).toBe("g1");
      store.getState().disbandGroup("g1");
      vi.advanceTimersByTime(200);
      const st = store.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.selectedIds).toEqual([]);
      expect(st.selectedId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("V6：removeGroup 到期同样清理选中残留", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWith([inst("a", 1, "g9"), inst("b", 2, "g9")], [group("g9", 3, ["a", "b"])]);
      store.getState().setSelected(["g9"]);
      store.getState().removeGroup("g9");
      vi.advanceTimersByTime(250);
      const st = store.getState();
      expect(st.groups).toHaveLength(0);
      expect(st.selectedIds).toEqual([]);
      expect(st.selectedId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
