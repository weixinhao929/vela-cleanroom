import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * 跨窗口同步 hook 回归（mock 掉 Tauri 事件层，其余 store 真实参与）：
 *  - 挂载即注册全部同步通道监听；
 *  - 小组件布局变化 → 80ms 防抖后广播，载荷带 instanceId + 单调 rev；
 *  - 编辑会话挂起期间不广播，解除时只补发一次最终快照（拖拽/缩放压缩）；
 *  - 接收端：自己的回声与陈旧 rev 一律拒收；
 *  - 视图切换走独立的 sync:view-switch 即时通道：接收端真正切换本地视图，
 *    而整包快照里 activeView 不同仍只吸收元数据（编辑另一视图不打扰桌面）；
 *  - 恢复/重置的 pause-ack 协议：pause 置位闸门并以 **字符串** instanceId 回 ack
 *    （此前发 Date.now() 数字，发起方只认 string，ack 永远计不到）。
 */

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const emitMock = vi.fn(async (_name: string, _payload?: unknown) => {});

vi.mock("@tauri-apps/api/event", () => ({
  emit: (name: string, payload?: unknown) => emitMock(name, payload),
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  })
}));

vi.mock("./tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./tauri")>();
  return { ...mod, isTauri: () => true, invoke: vi.fn(async () => null) };
});

import {
  SYNC_EVENTS,
  flattenLeaves,
  mergeLeaves,
  mergeRows,
  setWidgetsSyncSuspended,
  useCrossWindowSync,
  resetReplayBackoffForTests,
  type AppSyncPayload,
  type LeafMem
} from "./cross-window";
import { isRemoteApplying, withRemoteApply } from "./sync-gate";
import { currentScreenId, useWidgetStore, type DockConfig, type WidgetInstance } from "../widget/widget-store";
import { useHabitsStore, type Habit } from "../store/habits-store";
import { useSettingsStore } from "../store/settings-store";
import { useAppStore } from "../store/app-store";
import type { Task } from "../domain/schemas";
import { isPersistSuspended, resumePersistence } from "./persist-gate";

const inst = (id: string): WidgetInstance => ({ id, type: "clock", x: 0, y: 0, w: 320, h: 200, z: 1 });
const habit = (id: string): Habit => ({ id, name: `习惯${id}`, done: {} });

function widgetEmits() {
  return emitMock.mock.calls.filter(([name]) => name === SYNC_EVENTS.widgets);
}

async function mountSync() {
  const r = renderHook(() => useCrossWindowSync());
  await vi.waitFor(() => expect(handlers.has(SYNC_EVENTS.widgets)).toBe(true));
  return r;
}

describe("useCrossWindowSync", () => {
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    emitMock.mockClear();
    resumePersistence();
    useWidgetStore.setState({ instances: [], selectedId: null, selectedIds: [] });
    useHabitsStore.setState({ habits: [] });
  });
  afterEach(() => {
    setWidgetsSyncSuspended(false);
    resumePersistence();
  });

  it("挂载后注册全部同步通道与 pause-ack 协议监听", async () => {
    const r = await mountSync();
    for (const name of Object.values(SYNC_EVENTS)) expect(handlers.has(name), name).toBe(true);
    expect(handlers.has("sync:persist-pause")).toBe(true);
    expect(handlers.has("sync:persist-resume")).toBe(true);
    r.unmount();
  });

  it("布局变化经防抖广播，载荷带字符串 instanceId 与单调递增 rev", async () => {
    const r = await mountSync();
    act(() => useWidgetStore.getState().addWidget("clock", { w: 320, h: 200 }));
    await vi.waitFor(() => expect(widgetEmits().length).toBeGreaterThanOrEqual(1));
    const first = widgetEmits()[0][1] as { instanceId: string; rev: number; screenId: string; instances: unknown[] };
    expect(typeof first.instanceId).toBe("string");
    expect(first.screenId).toBe(currentScreenId());
    expect(first.instances).toHaveLength(1);

    act(() => useWidgetStore.getState().addWidget("clock", { w: 320, h: 200 }));
    await vi.waitFor(() => expect(widgetEmits().length).toBeGreaterThanOrEqual(2));
    const second = widgetEmits()[1][1] as { rev: number; instances: unknown[] };
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.instances).toHaveLength(2);
    r.unmount();
  });

  it("挂起期间的多次变化在解除时只补发一次最终快照", async () => {
    const r = await mountSync();
    setWidgetsSyncSuspended(true);
    act(() => {
      useWidgetStore.getState().addWidget("clock", { w: 320, h: 200 });
      useWidgetStore.getState().addWidget("clock", { w: 320, h: 200 });
      useWidgetStore.getState().addWidget("clock", { w: 320, h: 200 });
    });
    await new Promise((res) => setTimeout(res, 150));
    expect(widgetEmits()).toHaveLength(0);

    setWidgetsSyncSuspended(false);
    await vi.waitFor(() => expect(widgetEmits()).toHaveLength(1));
    const snap = widgetEmits()[0][1] as { instances: unknown[] };
    expect(snap.instances).toHaveLength(3);
    // 再等一个防抖周期，确认没有第二次补发。
    await new Promise((res) => setTimeout(res, 150));
    expect(widgetEmits()).toHaveLength(1);
    r.unmount();
  });

  it("接收端拒收自己的回声与陈旧 rev，接受更新的 rev", async () => {
    const r = await mountSync();
    act(() => useWidgetStore.getState().addWidget("clock", { w: 320, h: 200 }));
    await vi.waitFor(() => expect(widgetEmits().length).toBeGreaterThanOrEqual(1));
    const me = (widgetEmits()[0][1] as { instanceId: string }).instanceId;
    const { activeView, views } = useWidgetStore.getState();
    const payload = (instanceId: string, rev: number, instances: WidgetInstance[]) => ({
      payload: { instanceId, rev, screenId: currentScreenId(), instances, views, activeView, trash: [] }
    });
    const onWidgets = handlers.get(SYNC_EVENTS.widgets)!;

    act(() => onWidgets(payload(me, 99, [])));
    expect(useWidgetStore.getState().instances).toHaveLength(1); // 回声：不动

    act(() => onWidgets(payload("peer", 5, [inst("a")])));
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["a"]);

    act(() => onWidgets(payload("peer", 3, [])));
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["a"]); // 陈旧：不动

    act(() => onWidgets(payload("peer", 6, [inst("b")])));
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["b"]);
    r.unmount();
  });

  it("persist-pause 置位闸门并以字符串 instanceId 回 ack；resume 复位", async () => {
    const r = await mountSync();
    expect(isPersistSuspended()).toBe(false);
    act(() => handlers.get("sync:persist-pause")!({ payload: undefined }));
    expect(isPersistSuspended()).toBe(true);
    await vi.waitFor(() => expect(emitMock).toHaveBeenCalledWith("sync:persist-acked", expect.any(String)));

    act(() => handlers.get("sync:persist-resume")!({ payload: undefined }));
    expect(isPersistSuspended()).toBe(false);
    r.unmount();
  });

  /* ---- §4.14 习惯打卡通道：与 widgets 同型的单调 rev 抗乱序 ---- */
  const habitEmits = () => emitMock.mock.calls.filter(([name]) => name === SYNC_EVENTS.habits);

  it("习惯变化经防抖广播，载荷带 instanceId 与单调递增 rev", async () => {
    const r = await mountSync();
    act(() => useHabitsStore.setState({ habits: [habit("a")] }));
    await vi.waitFor(() => expect(habitEmits().length).toBeGreaterThanOrEqual(1));
    const first = habitEmits()[0][1] as { instanceId: string; rev: number; habits: Habit[] };
    expect(typeof first.instanceId).toBe("string");
    expect(typeof first.rev).toBe("number");
    expect(first.habits.map((h) => h.id)).toEqual(["a"]);

    act(() => useHabitsStore.setState({ habits: [habit("a"), habit("b")] }));
    await vi.waitFor(() => expect(habitEmits().length).toBeGreaterThanOrEqual(2));
    const second = habitEmits()[1][1] as { rev: number; habits: Habit[] };
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.habits).toHaveLength(2);
    r.unmount();
  });

  it("habits 接收端：回声跳过、陈旧 rev 拒收、更新 rev 接受、rev=0 旧载荷兼容", async () => {
    const r = await mountSync();
    act(() => useHabitsStore.setState({ habits: [habit("local")] }));
    await vi.waitFor(() => expect(habitEmits().length).toBeGreaterThanOrEqual(1));
    const me = (habitEmits()[0][1] as { instanceId: string }).instanceId;
    const onHabits = handlers.get(SYNC_EVENTS.habits)!;
    const ids = () => useHabitsStore.getState().habits.map((h) => h.id);

    act(() => onHabits({ payload: { instanceId: me, rev: 99, habits: [] } }));
    expect(ids()).toEqual(["local"]); // 回声：不动

    act(() => onHabits({ payload: { instanceId: "peer", rev: 5, habits: [habit("a")] } }));
    expect(ids()).toEqual(["a"]);

    act(() => onHabits({ payload: { instanceId: "peer", rev: 3, habits: [] } }));
    expect(ids()).toEqual(["a"]); // 陈旧：不动（此前 last-writer-wins 会清空）

    act(() => onHabits({ payload: { instanceId: "peer", rev: 5, habits: [] } }));
    expect(ids()).toEqual(["a"]); // 重复 rev：不动

    act(() => onHabits({ payload: { instanceId: "peer", rev: 6, habits: [habit("b")] } }));
    expect(ids()).toEqual(["b"]);

    // 旧版本窗口（无 rev 字段）仍按整包采纳，跨版本混跑不静默失联。
    act(() => onHabits({ payload: { instanceId: "old-build", habits: [habit("c")] } }));
    expect(ids()).toEqual(["c"]);
    r.unmount();
  });
});

/* ---- 灵动岛配置通道（sync:dock）：设置窗改动即时到桌面层，桌面层不再用陈旧内存覆盖 ---- */
describe("useCrossWindowSync · sync:dock", () => {
  const dockEmits = () => emitMock.mock.calls.filter(([name]) => name === SYNC_EVENTS.dock);
  const KEY = "focus-desk.screen.0.dock.v1";
  const dock = () => useWidgetStore.getState().dock;

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    emitMock.mockClear();
    useWidgetStore.setState({ instances: [], selectedId: null, selectedIds: [] });
  });
  afterEach(() => {
    setWidgetsSyncSuspended(false);
    resumePersistence();
  });

  it("dock 变化经防抖广播，载荷带 instanceId / 单调 rev / screenId 与整份配置", async () => {
    const r = await mountSync();
    act(() => useWidgetStore.getState().setDock({ enabled: true }));
    await vi.waitFor(() => expect(dockEmits().length).toBeGreaterThanOrEqual(1));
    const first = dockEmits()[0][1] as { instanceId: string; rev: number; screenId: string; dock: DockConfig };
    expect(typeof first.instanceId).toBe("string");
    expect(first.screenId).toBe(currentScreenId());
    expect(first.dock.enabled).toBe(true);
    // dockDrag 等瞬态不触发广播。
    act(() => useWidgetStore.getState().setDockDrag({ pointer: { x: 1, y: 1 }, overIsland: false, insertIndex: 0 }));
    await new Promise((res) => setTimeout(res, 150));
    expect(dockEmits()).toHaveLength(1);
    act(() => useWidgetStore.getState().setDock({ density: 48 }));
    await vi.waitFor(() => expect(dockEmits().length).toBeGreaterThanOrEqual(2));
    const second = dockEmits()[1][1] as { rev: number; dock: DockConfig };
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.dock.density).toBe(48);
    r.unmount();
  });

  it("接收端：回声跳过、陈旧 rev 拒收、更新 rev 接受（内存 + localStorage 镜像），跨屏载荷不采纳", async () => {
    const r = await mountSync();
    act(() => useWidgetStore.getState().setDock({ enabled: true }));
    await vi.waitFor(() => expect(dockEmits().length).toBeGreaterThanOrEqual(1));
    const me = (dockEmits()[0][1] as { instanceId: string }).instanceId;
    const onDock = handlers.get(SYNC_EVENTS.dock)!;
    const payload = (instanceId: string, rev: number, patch: Partial<DockConfig>, screenId = currentScreenId()) => ({
      payload: { instanceId, rev, screenId, dock: { ...dock(), ...patch } }
    });

    act(() => onDock(payload(me, 99, { edge: "bottom" })));
    expect(dock().edge).toBe("top"); // 回声：不动

    act(() => onDock(payload("peer", 5, { style: "bangs", topInset: 32 })));
    expect(dock().style).toBe("bangs");
    expect(dock().topInset).toBe(32);
    expect(JSON.parse(localStorage.getItem(KEY)!).style).toBe("bangs");

    act(() => onDock(payload("peer", 3, { edge: "bottom" })));
    expect(dock().edge).toBe("top"); // 陈旧：不动

    act(() => onDock(payload("peer", 6, { edge: "bottom" }, "1")));
    expect(dock().edge).toBe("top"); // 跨屏：不采纳
    r.unmount();
  });

  it("应用远端 dock 期间不回播（applyingRemote 抑制）", async () => {
    const r = await mountSync();
    await vi.waitFor(() => expect(dockEmits().length).toBeGreaterThanOrEqual(0));
    const onDock = handlers.get(SYNC_EVENTS.dock)!;
    const before = dockEmits().length;
    act(() =>
      onDock({ payload: { instanceId: "peer", rev: 1, screenId: currentScreenId(), dock: { ...dock(), density: 36 } } })
    );
    expect(dock().density).toBe(36);
    await new Promise((res) => setTimeout(res, 150));
    expect(dockEmits()).toHaveLength(before); // 无回声广播
    r.unmount();
  });
});

/* ---- 视图切换通道（sync:view-switch）：设置窗「视图」页点「切换」→ 桌面层真正跟着换视图 ----
   此前只有整包快照通道，而快照接收端对「activeView 与本地不同」的载荷故意不切换
   （编辑另一视图时不能拽走桌面），于是设置里点「切换」桌面纹丝不动。 */
describe("useCrossWindowSync · sync:view-switch", () => {
  const viewEmits = () => emitMock.mock.calls.filter(([name]) => name === SYNC_EVENTS.viewSwitch);
  const layoutKey = (view: string) => `focus-desk.screen.0.widgets.${view}.v1`;
  const st = () => useWidgetStore.getState();

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    emitMock.mockClear();
    useWidgetStore.setState({ instances: [], selectedId: null, selectedIds: [], activeView: "home" });
  });
  afterEach(() => {
    setWidgetsSyncSuspended(false);
    resumePersistence();
    useWidgetStore.setState({ instances: [], activeView: "home" });
  });

  it("本地切换视图即时广播，载荷带 instanceId / screenId / 目标视图", async () => {
    const r = await mountSync();
    act(() => st().setActiveView("work"));
    await vi.waitFor(() => expect(viewEmits()).toHaveLength(1));
    const p = viewEmits()[0][1] as { instanceId: string; screenId: string; view: string };
    expect(typeof p.instanceId).toBe("string");
    expect(p.screenId).toBe(currentScreenId());
    expect(p.view).toBe("work");
    r.unmount();
  });

  it("接收端跟随远端切换：换成目标视图并载入其布局，切走前当前视图布局已落盘；回声 / 跨屏不采纳", async () => {
    const r = await mountSync();
    // 目标视图的布局此前已同步到本地存储（另一窗口编辑过它）。
    localStorage.setItem(layoutKey("work"), JSON.stringify([inst("w1")]));
    act(() => st().addWidget("clock", { w: 320, h: 200 }));
    await vi.waitFor(() => expect(widgetEmits().length).toBeGreaterThanOrEqual(1));
    const me = (widgetEmits()[0][1] as { instanceId: string }).instanceId;
    const onView = handlers.get(SYNC_EVENTS.viewSwitch)!;

    act(() => onView({ payload: { instanceId: me, screenId: currentScreenId(), view: "work" } }));
    expect(st().activeView).toBe("home"); // 回声：不动

    act(() => onView({ payload: { instanceId: "peer", screenId: "1", view: "work" } }));
    expect(st().activeView).toBe("home"); // 跨屏：不采纳

    act(() => onView({ payload: { instanceId: "peer", screenId: currentScreenId(), view: "work" } }));
    expect(st().activeView).toBe("work");
    expect(st().instances.map((i) => i.id)).toEqual(["w1"]);
    expect(JSON.parse(localStorage.getItem(layoutKey("home"))!)).toHaveLength(1);
    expect(localStorage.getItem("focus-desk.screen.0.widgets.view.v1")).toBe("work");
    r.unmount();
  });

  it("应用远端切换期间不回播（两窗口不会互切成环）", async () => {
    const r = await mountSync();
    const onView = handlers.get(SYNC_EVENTS.viewSwitch)!;
    act(() => onView({ payload: { instanceId: "peer", screenId: currentScreenId(), view: "focus" } }));
    expect(st().activeView).toBe("focus");
    await new Promise((res) => setTimeout(res, 150));
    expect(viewEmits()).toHaveLength(0);
    r.unmount();
  });

  it("整包快照里 activeView 不同仍不拽动本地视图，只把该视图布局镜像到它自己的键", async () => {
    const r = await mountSync();
    const onWidgets = handlers.get(SYNC_EVENTS.widgets)!;
    act(() =>
      onWidgets({
        payload: {
          instanceId: "peer",
          rev: 1,
          screenId: currentScreenId(),
          instances: [inst("x")],
          views: st().views,
          activeView: "work",
          trash: []
        }
      })
    );
    expect(st().activeView).toBe("home");
    expect(st().instances).toEqual([]);
    expect(JSON.parse(localStorage.getItem(layoutKey("work"))!).map((i: WidgetInstance) => i.id)).toEqual(["x"]);
    r.unmount();
  });

  it("幽灵视图守卫：未知视图的切换暂存不闪空窗，views 列表跟进后补切", async () => {
    const r = await mountSync();
    const onView = handlers.get(SYNC_EVENTS.viewSwitch)!;
    const onWidgets = handlers.get(SYNC_EVENTS.widgets)!;
    // 对端「新建视图并立即切换」：即时事件先到，本地 views 还没有 ghost-view。
    act(() => onView({ payload: { instanceId: "peer", screenId: currentScreenId(), view: "ghost-view" } }));
    expect(st().activeView).toBe("home");
    // 80ms 后的整包快照带来了新 views 列表 + 目标视图布局 → 补切生效。
    localStorage.setItem(layoutKey("ghost-view"), JSON.stringify([inst("g1")]));
    act(() =>
      onWidgets({
        payload: {
          instanceId: "peer",
          rev: 2,
          screenId: currentScreenId(),
          instances: [inst("g1")],
          views: [...st().views, { id: "ghost-view", name: "Ghost" }],
          activeView: "ghost-view",
          trash: []
        }
      })
    );
    expect(st().activeView).toBe("ghost-view");
    expect(st().instances.map((i) => i.id)).toEqual(["g1"]);
    r.unmount();
  });
});

/* ---- 回播风暴阻尼（sync:settings）：「快速切换后一直来回切换」的回归。
   旧实现里分歧回播是立即重发 + 重盖新鲜时间戳：对端每来一个包就回一个包，
   两个互不相让的窗口能以 ~10Hz 无限乒乓（实测打满 Rust 消息队列）。修复后：
   回播按指数退避（0/50/100/200/…ms，2s 封顶）且已调度则去重——连续 N 个
   分歧包在时间窗内的回播总数是对数级有界的。 */
describe("useCrossWindowSync · 回播风暴阻尼", () => {
  const settingsEmits = () => emitMock.mock.calls.filter(([name]) => name === SYNC_EVENTS.settings);
  const remote = (ts: number, themeMode: string) =>
    act(() =>
      handlers.get(SYNC_EVENTS.settings)!({
        payload: { instanceId: "peer", ts, themeMode, preset: "default", zoom: 100 }
      })
    );

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    emitMock.mockClear();
    vi.useRealTimers();
    resetReplayBackoffForTests();
    useSettingsStore.setState({ themeMode: "system" });
  });

  it("本地编辑后连续 12 个陈旧分歧包：回播总数按退避有界，本地值不被翻转", async () => {
    const r = await mountSync();
    // 本地编辑（比远端包新）。
    act(() => useSettingsStore.getState().setThemeMode("dark"));
    await vi.waitFor(() => expect(settingsEmits().length).toBe(1));
    const baseline = settingsEmits().length;
    const localEditTs = Date.now();
    // 12 个「陈旧 ts + 相异值」的远端包：每个都会触发 保留本地 → 分歧 → 回播。
    for (let i = 0; i < 12; i++) remote(localEditTs - 5000, "light");
    // 退避阶梯 0/50/100/200/400/800/1600…：1.3s 内至多 6 次回播（旧实现为 12 次立即）。
    await new Promise((res) => setTimeout(res, 1300));
    const replays = settingsEmits().length - baseline;
    expect(replays).toBeGreaterThan(0); // 收敛意图仍在：至少回播一次
    expect(replays).toBeLessThanOrEqual(6); // 但被退避压成对数级
    expect(useSettingsStore.getState().themeMode).toBe("dark"); // 本地新值不被陈旧包翻回
    r.unmount();
  });

  it("回播不重盖编辑时间戳：陈旧值的回播包赢不过对端真正更新的值", async () => {
    const r = await mountSync();
    // 对端先带来一个「更新」的值并被本地采纳。
    const t0 = Date.now() + 10;
    remote(t0, "light");
    expect(useSettingsStore.getState().themeMode).toBe("light");
    await new Promise((res) => setTimeout(res, 150));
    // 此后陈旧包（ts 更旧、值不同）到来：本地保留 light 并回播——回播载荷
    // 里的值必须是本地当前值，且不再刷新为「现在」的时间戳（否则陈旧值
    // 会在对端仲裁里反过来压过 t0 的新值，形成互踢）。
    remote(t0 - 3000, "dark");
    await vi.waitFor(() => expect(settingsEmits().length).toBeGreaterThanOrEqual(1));
    const last = settingsEmits().at(-1)![1] as { themeMode: string };
    expect(last.themeMode).toBe("light");
    expect(useSettingsStore.getState().themeMode).toBe("light");
    r.unmount();
  });

  it("sync-gate：withRemoteApply 内的 store 写入不被当作本地编辑广播", async () => {
    const r = await mountSync();
    // 等一个静默期，确保没有在飞的防抖。
    await new Promise((res) => setTimeout(res, 150));
    const baseline = settingsEmits().length;
    expect(isRemoteApplying()).toBe(false);
    withRemoteApply(() => {
      useSettingsStore.getState().setThemeMode("dark");
    });
    expect(isRemoteApplying()).toBe(false); // finally 已复位
    expect(useSettingsStore.getState().themeMode).toBe("dark");
    await new Promise((res) => setTimeout(res, 300));
    expect(settingsEmits().length).toBe(baseline); // 静默：无广播
    r.unmount();
  });

  it("withRemoteApply 异常路径也复位门闩", () => {
    expect(() =>
      withRemoteApply(() => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(isRemoteApplying()).toBe(false);
  });
});

/* ---- sync:app 行级三方合并：整包 LWW 曾让 80ms 防抖窗口内两窗口分别改不同行时互相回滚 ---- */
describe("useCrossWindowSync · sync:app 行级三方合并", () => {
  const appEmits = () => emitMock.mock.calls.filter(([name]) => name === SYNC_EVENTS.app);
  const lastApp = () => appEmits().at(-1)![1] as AppSyncPayload;
  const task = (id: string, title = id, extra: Partial<Task> = {}): Task => ({
    id,
    title,
    completed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    dueAt: "",
    priority: 0,
    tags: [],
    sortOrder: 0,
    ...extra
  });
  const titles = () => Object.fromEntries(useAppStore.getState().tasks.map((t) => [t.id, t.title]));
  const setTasks = (t: Task[]) => act(() => useAppStore.setState({ tasks: t }));
  const remote = (ts: number, tasks: Task[], extra: Partial<AppSyncPayload> = {}) =>
    act(() =>
      handlers.get(SYNC_EVENTS.app)!({
        payload: {
          instanceId: "peer",
          ts,
          tasks,
          deadlines: [],
          pomodoroConfig: useAppStore.getState().pomodoroConfig,
          ...extra
        } satisfies AppSyncPayload
      })
    );

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    emitMock.mockClear();
    resetReplayBackoffForTests();
    useAppStore.setState({ tasks: [], deadlines: [] });
  });
  afterEach(() => {
    resumePersistence();
    useAppStore.setState({ tasks: [], deadlines: [] });
  });

  it("防抖窗口内两窗口分别改不同行：两处编辑都保留并回播（不再互相回滚）", async () => {
    const r = await mountSync();
    setTasks([task("a1", "X0"), task("a2", "Y0")]);
    await vi.waitFor(() => expect(appEmits()).toHaveLength(1));
    // 本窗口改 X（防抖未到点，尚未发出）。
    setTasks([task("a1", "X1"), task("a2", "Y0")]);
    // 对端在同一窗口期改了 Y，其整表快照里 X 仍是旧值——旧实现整包覆盖会把 X1 回滚。
    remote(Date.now() + 5, [task("a1", "X0"), task("a2", "Y1")]);
    expect(titles()).toEqual({ a1: "X1", a2: "Y1" });
    // 保留了对端没有的 X1 → 立即回播，回播载荷同时含双方的改动。
    await vi.waitFor(() => expect(appEmits()).toHaveLength(2));
    expect(lastApp().tasks!.map((t) => t.title)).toEqual(["X1", "Y1"]);
    r.unmount();
  });

  it("远端删除凭证删行并记墓碑；此后无凭证的陈旧包不复活；表里缺行而无凭证不视为删除", async () => {
    const r = await mountSync();
    setTasks([task("b1"), task("b2")]);
    await vi.waitFor(() => expect(appEmits()).toHaveLength(1));
    const t0 = Date.now() + 10;
    remote(t0, [task("b1")], { removedTasks: ["b2"] });
    expect(Object.keys(titles())).toEqual(["b1"]);
    // 第三个窗口迟到的旧整表仍带着 b2：墓碑在效 → 拒收。
    remote(t0 + 1, [task("b1"), task("b2")]);
    expect(Object.keys(titles())).toEqual(["b1"]);
    // 对端整表缺 b1 但没有删除凭证（它还没看到这行）→ 保留，不再推断为删除。
    remote(t0 + 2, []);
    expect(Object.keys(titles())).toEqual(["b1"]);
    r.unmount();
  });

  it("本地删除后对端陈旧包仍带该行：不复活；删除凭证随下一包发出", async () => {
    const r = await mountSync();
    setTasks([task("c1"), task("c2")]);
    await vi.waitFor(() => expect(appEmits()).toHaveLength(1));
    setTasks([task("c1")]);
    remote(Date.now() + 5, [task("c1"), task("c2")]);
    expect(Object.keys(titles())).toEqual(["c1"]);
    await vi.waitFor(() => expect(appEmits()).toHaveLength(2));
    expect(lastApp().removedTasks).toEqual(["c2"]);
    expect(lastApp().tasks!.map((t) => t.id)).toEqual(["c1"]);
    r.unmount();
  });

  it("远端新增行采纳、回声与陈旧 ts 拒收、无变化不重放", async () => {
    const r = await mountSync();
    setTasks([task("d1")]);
    await vi.waitFor(() => expect(appEmits()).toHaveLength(1));
    const me = lastApp().instanceId!;
    const t0 = Date.now() + 10;
    remote(t0, [task("d1"), task("d2")]);
    expect(Object.keys(titles())).toEqual(["d1", "d2"]);
    // 陈旧 ts 直接拒收。
    remote(t0 - 1, []);
    expect(Object.keys(titles())).toEqual(["d1", "d2"]);
    // 自己的回声不动。
    act(() => handlers.get(SYNC_EVENTS.app)!({ payload: { instanceId: me, ts: t0 + 100, tasks: [] } }));
    expect(Object.keys(titles())).toEqual(["d1", "d2"]);
    await new Promise((res) => setTimeout(res, 120));
    expect(appEmits()).toHaveLength(1); // 采纳远端不回播
    r.unmount();
  });
});

/* ---- sync:settings 叶子级三方合并：旧实现按顶层字段整对象比较，且基线在编辑瞬间同步成
   本地值使 keepLocal 恒假——两窗口改 general 的不同子键会互相回滚并永久分叉 ---- */
describe("useCrossWindowSync · sync:settings 叶子级三方合并", () => {
  const settingsEmits = () => emitMock.mock.calls.filter(([name]) => name === SYNC_EVENTS.settings);
  const general = () => useSettingsStore.getState().general;
  const remote = (ts: number, patch: Record<string, unknown>) =>
    act(() => handlers.get(SYNC_EVENTS.settings)!({ payload: { instanceId: "peer", ts, ...patch } }));
  let g0: ReturnType<typeof general>;

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    emitMock.mockClear();
    resetReplayBackoffForTests();
    g0 = general();
  });
  afterEach(() => {
    resumePersistence();
    act(() => useSettingsStore.setState({ general: g0 }));
  });

  it("两窗口并发改同一嵌套对象的不同子键：两个子键都生效并回播", async () => {
    const r = await mountSync();
    const lang = g0.language === "en" ? "zh" : "en";
    act(() => useSettingsStore.setState({ general: { ...g0, language: lang } }));
    // 对端基于旧 general 改了 reduceEffects，其快照里 language 仍是旧值。
    remote(Date.now() + 5, { general: { ...g0, reduceEffects: !g0.reduceEffects } });
    expect(general().language).toBe(lang);
    expect(general().reduceEffects).toBe(!g0.reduceEffects);
    await vi.waitFor(() => expect(settingsEmits().length).toBeGreaterThanOrEqual(1));
    const replay = settingsEmits().at(-1)![1] as { general: typeof g0 };
    expect(replay.general.language).toBe(lang);
    expect(replay.general.reduceEffects).toBe(!g0.reduceEffects);
    r.unmount();
  });

  it("远端只改一处、本地无编辑：直接采纳且不回播；陈旧包不回滚已采纳的新值并回播纠正", async () => {
    const r = await mountSync();
    const t0 = Date.now() + 10;
    remote(t0, { general: { ...g0, reduceEffects: !g0.reduceEffects } });
    expect(general().reduceEffects).toBe(!g0.reduceEffects);
    await new Promise((res) => setTimeout(res, 120));
    expect(settingsEmits()).toHaveLength(0);
    // 第三个窗口迟到的旧快照（ts 更旧）带着旧值：不采纳，并回播让它收敛。
    remote(t0 - 1000, { general: { ...g0 } });
    expect(general().reduceEffects).toBe(!g0.reduceEffects);
    await vi.waitFor(() => expect(settingsEmits()).toHaveLength(1));
    r.unmount();
  });
});

/* ---- 合并核心纯函数：并发仲裁的确定性与删除/编辑仲裁 ---- */
describe("mergeRows / mergeLeaves", () => {
  type Row = { id: string; v: string };
  const mem = (json: string, ts: number): LeafMem => ({ json, ts });
  const base = (rows: Row[], ts = 0) => new Map(rows.map((r) => [r.id, mem(JSON.stringify(r), ts)]));

  it("同一行并发编辑：交换本地/远端角色得到同一个赢家", () => {
    const b = base([{ id: "x", v: "0" }]);
    const a = { id: "x", v: "a" };
    const c = { id: "x", v: "c" };
    const fromA = mergeRows([a], [c], [], b, new Map([["x", 100]]), new Map(), 200);
    const fromC = mergeRows([c], [a], [], b, new Map([["x", 200]]), new Map(), 100);
    expect(fromA.merged).toEqual([c]);
    expect(fromC.merged).toEqual([c]);
    expect(fromA.diverged).toBe(false);
    expect(fromC.diverged).toBe(true); // C 保留了 A 没有的值 → 回播
  });

  it("删除凭证 vs 本地编辑：编辑晚于删除则保留并回播，否则删除并记墓碑", () => {
    const b = base([{ id: "x", v: "0" }]);
    const edited = { id: "x", v: "1" };
    const keep = mergeRows([edited], [], ["x"], b, new Map([["x", 300]]), new Map(), 200);
    expect(keep.merged).toEqual([edited]);
    expect(keep.diverged).toBe(true);
    expect(keep.tombstoned).toEqual([]);
    const drop = mergeRows([edited], [], ["x"], b, new Map([["x", 100]]), new Map(), 200);
    expect(drop.merged).toEqual([]);
    expect(drop.tombstoned).toEqual(["x"]);
    expect(drop.changed).toBe(true);
  });

  it("墓碑：陈旧包中的已删行拒收；对端在删除之后又编辑则复活采纳", () => {
    const b = base([{ id: "x", v: "0" }]);
    const tomb = new Map([["x", 500]]);
    const stale = mergeRows<Row>([], [{ id: "x", v: "0" }], [], b, new Map(), tomb, 600);
    expect(stale.merged).toEqual([]);
    expect(stale.revived).toEqual([]);
    const revived = mergeRows<Row>([], [{ id: "x", v: "2" }], [], b, new Map(), tomb, 600);
    expect(revived.merged).toEqual([{ id: "x", v: "2" }]);
    expect(revived.revived).toEqual(["x"]);
    const older = mergeRows<Row>([], [{ id: "x", v: "2" }], [], b, new Map(), tomb, 400);
    expect(older.merged).toEqual([]);
  });

  it("叶子级：嵌套对象的不同子键各取所变，未触及的子树引用不变", () => {
    const local = { general: { a: 5, b: 2, nested: { k: 1 } }, zoom: 1 };
    const b = new Map<string, LeafMem>([
      ["general.a", mem("1", 0)],
      ["general.b", mem("2", 0)],
      ["general.nested.k", mem("1", 0)],
      ["zoom", mem("1", 0)]
    ]);
    const res = mergeLeaves(
      local,
      { general: { a: 1, b: 3, nested: { k: 1 } }, zoom: 1 },
      b,
      new Map([["general.a", 50]]),
      100
    );
    expect(res.next).toEqual({ general: { a: 5, b: 3, nested: { k: 1 } }, zoom: 1 });
    expect((res.next.general as { nested: unknown }).nested).toBe(local.general.nested);
    expect(res.changed).toBe(true);
    expect(res.diverged).toBe(true);
    expect(res.base.get("general.b")).toEqual(mem("3", 100));
    expect(res.base.get("general.a")).toEqual(mem("5", 50));
  });

  it("叶子级：远端缺字段保留本地且无变化；远端相对基线没变时不采纳", () => {
    const local = { general: { a: 5 }, zoom: 2 };
    const b = new Map<string, LeafMem>([
      ["general.a", mem("1", 0)],
      ["zoom", mem("1", 0)]
    ]);
    const res = mergeLeaves(
      local,
      { general: { a: 1 } },
      b,
      new Map([
        ["general.a", 50],
        ["zoom", 60]
      ]),
      100
    );
    expect(res.next).toBe(local);
    expect(res.changed).toBe(false);
    expect(res.diverged).toBe(true); // 远端的 a 是旧值 → 需回播
  });

  it("原子叶子：fxToggles / notifications.sources 整体成一个叶子，不再摊平成逐键", () => {
    const m = flattenLeaves({
      extra: { animationDuration: 100, fxToggles: { starBorder: false } },
      notifications: { sources: { app: true } }
    });
    expect([...m.keys()].sort()).toEqual(["extra.animationDuration", "extra.fxToggles", "notifications.sources"]);
  });

  it("原子叶子（fx 开关缺陷回归）：「全部开启」= fxToggles {} 能作为叶子传播，不被对端旧键打回关闭", () => {
    // 基线：上次交换时全部关闭（逐特效 false）。设置窗点「全部开启」→ 本地 {}，
    // 桌面层还持有全关表：合并必须采纳本地的空表（删键 = 开启），而非回滚。
    const allOff = { starBorder: false, hoverGlow: false };
    const b = new Map<string, LeafMem>([["extra.fxToggles", mem(JSON.stringify(allOff), 50)]]);
    const localTs = new Map<string, number>([["extra.fxToggles", 100]]);
    // 本地（设置窗）编辑更晚：远端相对基线没变 → 保留本地 {}。
    const keep = mergeLeaves({ extra: { fxToggles: {} } }, { extra: { fxToggles: allOff } }, b, localTs, 90);
    expect((keep.next.extra as { fxToggles: unknown }).fxToggles).toEqual({});
    expect(keep.changed).toBe(false);
    // 本地无编辑（ts 同基线）：远端全开包（{}）相对基线变了 → 采纳为 {}。
    const take = mergeLeaves({ extra: { fxToggles: allOff } }, { extra: { fxToggles: {} } }, b, new Map(), 120);
    expect((take.next.extra as { fxToggles: unknown }).fxToggles).toEqual({});
    expect(take.changed).toBe(true);
  });
});
