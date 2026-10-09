/**
 * 回归：删除/解散的退场动画定时器（≈220ms）到期时
 * 用户已 Ctrl+数字切走视图——回调此前在新视图的内存实例表 find 不到目标 →
 * 静默 return → 旧视图组件「删了又复活」。修复后闭包捕获删除发生时的视图，
 * 到期视图不符则对捕获视图的持久层定向生效（loadInstances/loadGroups 过滤
 * + writeInstancesNow/writeGroupsNow 立即落盘；trash 凭证 view=捕获视图）。
 *
 * 语义不变量：删除必须作用于「删除发生时组件所在的视图」，与新活动视图无关。
 *
 * 沿用 groups.test 的加载模式：非 Tauri 环境（无 SQLite 镜像路径），每次
 * loadModule 重建模块级 zCounter / 防抖缓冲，防跨模块实例串扰。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({
  isTauri: () => false,
  invoke: async () => null
}));

async function loadModule() {
  vi.resetModules();
  return await import("./widget-store");
}

const HOME_LAYOUT = "focus-desk.screen.0.widgets.home.v1";
const HOME_GROUPS = "focus-desk.screen.0.groups.home.v1";
const WORK_LAYOUT = "focus-desk.screen.0.widgets.work.v1";

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

/** home 视图带夹具启动；work 视图预置一条实例（切走后内存属另一张表）。 */
async function bootWithHome(instances: unknown[], groups: unknown[] = []) {
  const { useWidgetStore } = await loadModule();
  localStorage.setItem(HOME_LAYOUT, JSON.stringify(instances));
  if (groups.length) localStorage.setItem(HOME_GROUPS, JSON.stringify(groups));
  localStorage.setItem(WORK_LAYOUT, JSON.stringify([inst("w1", 9)]));
  useWidgetStore.setState({ activeView: "home" });
  await useWidgetStore.getState().hydrate();
  return useWidgetStore;
}

const homePersisted = () => JSON.parse(localStorage.getItem(HOME_LAYOUT) ?? "[]") as { id: string; groupId?: string }[];
const homeGroupsPersisted = () => JSON.parse(localStorage.getItem(HOME_GROUPS) ?? "null") as { id: string }[] | null;

beforeEach(() => {
  localStorage.clear();
});

describe("Q-19：退场窗口内切视图——删除对捕获视图定向生效", () => {
  it("removeWidgetsAnimated：到期时已切走 → 捕获视图持久层删除、trash 凭证记原视图、新视图内存不受扰", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWithHome([inst("a"), inst("b")]);
      store.getState().removeWidgetsAnimated(["a"]);
      // 退场窗口内切走（真实路径：冲刷旧视图 + 载入新视图）。
      store.getState().setActiveView("work");
      vi.advanceTimersByTime(260);
      // 内存（work）不受定向删除影响。
      expect(store.getState().instances.map((i) => i.id)).toEqual(["w1"]);
      // 捕获视图持久层：a 已删、b 保留（修复前 a 「删了又复活」）。
      expect(homePersisted().map((i) => i.id)).toEqual(["b"]);
      // trash 凭证指向捕获视图（undo 跨视图恢复回原视图）。
      const trash = store.getState().trash;
      expect(trash.map((t) => t.id)).toEqual(["a"]);
      expect(trash[0].view).toBe("home");
      // 切回即见删除生效（不复活）。
      store.getState().setActiveView("home");
      expect(store.getState().instances.map((i) => i.id)).toEqual(["b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removeWidgetsAnimated：不切视图的原路径不受影响（对照）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWithHome([inst("a"), inst("b")]);
      store.getState().removeWidgetsAnimated(["a"]);
      vi.advanceTimersByTime(260);
      expect(store.getState().instances.map((i) => i.id)).toEqual(["b"]);
      expect(store.getState().trash.map((t) => t.id)).toEqual(["a"]);
      expect(store.getState().trash[0].view).toBe("home");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removeGroup：到期时已切走 → 组与成员从捕获视图删除、成员进回收站（view=原视图）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWithHome([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
      store.getState().removeGroup("g1");
      store.getState().setActiveView("work");
      vi.advanceTimersByTime(260);
      // 新视图内存：组表为空、实例仍是 w1。
      expect(store.getState().groups).toHaveLength(0);
      expect(store.getState().instances.map((i) => i.id)).toEqual(["w1"]);
      // 捕获视图持久层：组删、成员删。
      expect(homeGroupsPersisted()).toEqual([]);
      expect(homePersisted()).toEqual([]);
      const trash = store
        .getState()
        .trash.map((t) => t.id)
        .sort();
      expect(trash).toEqual(["a", "b"]);
      expect(store.getState().trash.every((t) => t.view === "home")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disbandGroup：到期时已切走 → 捕获视图组删、成员解绑原位保留（不进回收站）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWithHome([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
      store.getState().disbandGroup("g1");
      store.getState().setActiveView("work");
      vi.advanceTimersByTime(260);
      expect(homeGroupsPersisted()).toEqual([]);
      const persisted = homePersisted();
      expect(persisted.map((i) => i.id).sort()).toEqual(["a", "b"]);
      expect(persisted.every((i) => i.groupId === undefined)).toBe(true);
      expect(store.getState().trash).toHaveLength(0);
      // 切回：两成员自由回场、组不复活。
      store.getState().setActiveView("home");
      expect(store.getState().groups).toHaveLength(0);
      expect(
        store
          .getState()
          .instances.map((i) => i.id)
          .sort()
      ).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removeWidgetsAnimated 定向删除编组成员：剩余不足 2 人时整组解散、幸存者解绑（removeGroupMember 同语义）", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWithHome([inst("a", 1, "g1"), inst("b", 2, "g1")], [group("g1", 3, ["a", "b"])]);
      store.getState().removeWidgetsAnimated(["a"]);
      store.getState().setActiveView("work");
      vi.advanceTimersByTime(260);
      expect(homeGroupsPersisted()).toEqual([]);
      const persisted = homePersisted();
      expect(persisted.map((i) => i.id)).toEqual(["b"]);
      expect(persisted[0].groupId).toBeUndefined();
      expect(store.getState().trash.map((t) => t.id)).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("退场窗口内切走再切回：到期时视图与捕获值一致 → 走原内存路径，删除照常生效", async () => {
    vi.useFakeTimers();
    try {
      const store = await bootWithHome([inst("a"), inst("b")]);
      store.getState().removeWidgetsAnimated(["a"]);
      store.getState().setActiveView("work");
      store.getState().setActiveView("home");
      vi.advanceTimersByTime(260);
      expect(store.getState().instances.map((i) => i.id)).toEqual(["b"]);
      // 内存路径走 saveInstances 的 300ms 防抖落盘，补等一个防抖周期。
      vi.advanceTimersByTime(320);
      expect(homePersisted().map((i) => i.id)).toEqual(["b"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
