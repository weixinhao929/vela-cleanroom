import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 对齐测试：widget/trash hydrate 以 localStorage 为权威源，
 * SQLite 只是镜像——读库 IPC 失败或镜像落后都不得反过来覆盖新鲜状态，并在发现
 * 分叉时把 localStorage 内容回写 DB 自愈；仅缺键/损坏时才采纳 DB 副本并回填镜像。
 *
 * 沿用 local-backup.test.ts 的模式：只 mock ../lib/tauri（isTauri→true + invoke
 * 按命令名分发），真实 sqliteRepo 参与运行。
 */

const mockInvoke = vi.fn(async (cmd: string, args?: { key?: string; value?: string }): Promise<unknown> => {
  if (cmd === "get_setting") return dbRows.get(args?.key ?? "") ?? null;
  if (cmd === "set_setting") {
    setCalls.push([args?.key ?? "", args?.value ?? ""]);
    return undefined;
  }
  return null;
});

/** 模拟的 SQLite settings 表；setCalls 记录全部回写。 */
const dbRows = new Map<string, string>();
let setCalls: [string, string][] = [];

vi.mock("../lib/tauri", () => ({
  isTauri: () => true,
  invoke: (...a: unknown[]) => (mockInvoke as unknown as (...x: unknown[]) => unknown)(...(a as [string]))
}));

async function loadModule() {
  vi.resetModules();
  return await import("./widget-store");
}

const LAYOUT_KEY = "focus-desk.screen.0.widgets.home.v1";
const DB_LAYOUT_KEY = "widget:layout:0:home";
const LEGACY_DB_LAYOUT_KEY = "widget:layout:home";
const TRASH_KEY = "focus-desk.screen.0.widgets.trash.v1";
const DB_TRASH_KEY = "widget:trash:0";
const LEGACY_DB_TRASH_KEY = "widget:trash";

const inst = (id: string, z = 1) => ({ id, type: "clock", x: 0, y: 0, w: 200, h: 100, z });
const trashItem = (id: string) => ({
  id,
  type: "notes",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 1,
  view: "home",
  deletedAt: new Date().toISOString()
});

/** 让 enqueueWrite 的微任务写链与 fire-and-forget 自愈写跑完。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  dbRows.clear();
  setCalls = [];
});

describe("loadInstancesFromDb P8 语义", () => {
  it("LS 键存在时陈旧 DB 不覆盖新鲜布局，并回写自愈", async () => {
    const fresh = JSON.stringify([inst("fresh-1")]);
    localStorage.setItem(LAYOUT_KEY, fresh);
    dbRows.set(DB_LAYOUT_KEY, JSON.stringify([inst("stale-1", 9)]));

    const { loadInstancesFromDb } = await loadModule();
    const out = await loadInstancesFromDb("home");
    await flush();

    expect(out.map((i) => i.id)).toEqual(["fresh-1"]);
    expect(setCalls).toEqual([[DB_LAYOUT_KEY, fresh]]);
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(fresh);
  });

  it("LS 刻意清空的空布局压过 DB 非空副本（防复活）且不触发回写", async () => {
    localStorage.setItem(LAYOUT_KEY, "[]");
    dbRows.set(DB_LAYOUT_KEY, JSON.stringify([inst("stale-1", 9)]));

    const { loadInstancesFromDb } = await loadModule();
    const out = await loadInstancesFromDb("home");
    await flush();

    expect(out).toEqual([]);
    expect(setCalls).toEqual([]);
    expect(localStorage.getItem(LAYOUT_KEY)).toBe("[]");
  });

  it("LS 缺键时采纳 DB 副本并回填 localStorage 镜像，不回写 DB", async () => {
    const dbJson = JSON.stringify([inst("db-1", 3)]);
    dbRows.set(DB_LAYOUT_KEY, dbJson);

    const { loadInstancesFromDb } = await loadModule();
    const out = await loadInstancesFromDb("home");
    await flush();

    expect(out.map((i) => i.id)).toEqual(["db-1"]);
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(dbJson);
    expect(setCalls).toEqual([]);
  });

  it("LS 缺键且主键为空时回退 legacy DB 键（旧版迁移）", async () => {
    const legacyJson = JSON.stringify([inst("legacy-1")]);
    dbRows.set(LEGACY_DB_LAYOUT_KEY, legacyJson);

    const { loadInstancesFromDb } = await loadModule();
    const out = await loadInstancesFromDb("home");
    await flush();

    expect(out.map((i) => i.id)).toEqual(["legacy-1"]);
    // 回填的是 LS 镜像；DB 侧不写 legacy 键、也无分叉可愈
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(legacyJson);
    expect(setCalls).toEqual([]);
  });

  it("读库 IPC 失败时保持 localStorage 权威：不抛错、不回退、不回写", async () => {
    const fresh = JSON.stringify([inst("fresh-1")]);
    localStorage.setItem(LAYOUT_KEY, fresh);
    mockInvoke.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));

    const { loadInstancesFromDb } = await loadModule();
    const out = await loadInstancesFromDb("home");
    await flush();

    expect(out.map((i) => i.id)).toEqual(["fresh-1"]);
    expect(setCalls).toEqual([]);
  });
});

describe("hydrate() / repullWidgetsFromDb() P8 语义", () => {
  it("布局与回收站均不被陈旧 DB 倒灌，且双双自愈回写", async () => {
    const freshLayout = JSON.stringify([inst("fresh-1"), inst("fresh-2", 2)]);
    const freshTrash = JSON.stringify([trashItem("t1")]);
    localStorage.setItem(LAYOUT_KEY, freshLayout);
    localStorage.setItem(TRASH_KEY, freshTrash);
    dbRows.set(DB_LAYOUT_KEY, JSON.stringify([inst("stale-1", 9)]));
    dbRows.set(DB_TRASH_KEY, JSON.stringify([]));

    const { useWidgetStore } = await loadModule();
    useWidgetStore.setState({ activeView: "home" });
    await useWidgetStore.getState().hydrate();
    await flush();

    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["fresh-1", "fresh-2"]);
    expect(useWidgetStore.getState().trash.map((t) => t.id)).toEqual(["t1"]);
    const healedKeys = setCalls.map(([k]) => k).sort();
    expect(healedKeys).toEqual([DB_LAYOUT_KEY, DB_TRASH_KEY].sort());
    expect(Object.fromEntries(setCalls)[DB_TRASH_KEY]).toBe(freshTrash);
  });

  it("TRASH_KEY 缺失时采纳 DB 副本（主键空则回退 legacy 键）", async () => {
    const dbTrash = JSON.stringify([trashItem("t-db")]);
    dbRows.set(LEGACY_DB_TRASH_KEY, dbTrash);

    const { useWidgetStore } = await loadModule();
    useWidgetStore.setState({ activeView: "home" });
    await useWidgetStore.getState().hydrate();

    expect(useWidgetStore.getState().trash.map((t) => t.id)).toEqual(["t-db"]);
    expect(setCalls).toEqual([]);
  });

  it("repullWidgetsFromDb：LS 权威不被 DB 覆盖，分叉自愈回写", async () => {
    const fresh = JSON.stringify([inst("fresh-1")]);
    localStorage.setItem(LAYOUT_KEY, fresh);
    dbRows.set(DB_LAYOUT_KEY, JSON.stringify([inst("stale-1", 9)]));

    const { useWidgetStore, repullWidgetsFromDb } = await loadModule();
    useWidgetStore.setState({ activeView: "home" });
    await repullWidgetsFromDb();
    await flush();

    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["fresh-1"]);
    expect(setCalls).toContainEqual([DB_LAYOUT_KEY, fresh]);
  });

  it("hydrate 同步加载编组（回归：此前只载实例，重启后编组整组消失）", async () => {
    // 两个成员挂 groupId + 组键完整；第三个实例引用已不存在的组（孤儿）。
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify([
        { ...inst("a"), groupId: "g1" },
        { ...inst("b"), groupId: "g1" },
        { ...inst("c"), groupId: "gone" }
      ])
    );
    const GROUPS_KEY = "focus-desk.screen.0.groups.home.v1";
    localStorage.setItem(
      GROUPS_KEY,
      JSON.stringify([
        { id: "g1", x: 0, y: 0, w: 400, h: 200, z: 3, opacity: 0.5, memberIds: ["a", "b"], activeId: "a" }
      ])
    );

    const { useWidgetStore } = await loadModule();
    useWidgetStore.setState({ activeView: "home" });
    await useWidgetStore.getState().hydrate();
    await flush();

    const st = useWidgetStore.getState();
    expect(st.groups).toHaveLength(1);
    expect(st.groups[0]).toMatchObject({ id: "g1", memberIds: ["a", "b"], opacity: 0.5 });
    // 孤儿 groupId 清理；组员保留标记（渲染由 GroupCard 承担）。
    expect(st.instances.find((i) => i.id === "c")!.groupId).toBeUndefined();
    expect(st.instances.find((i) => i.id === "a")!.groupId).toBe("g1");
  });
});
