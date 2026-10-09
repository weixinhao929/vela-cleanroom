/**
 * 视图管理回归（2026-10）：
 *  - 删视图 / 清空视图 = 组件进回收站（30 天可恢复），实例数据不再
 *    当场物理销毁、也不再看不见回收站（两个「清空」语义统一）；
 *  - 彻底删除 / 清空回收站的跨屏引用防线——复制布局保留实例 id 后，
 *    其它屏布局仍引用的 id 数据桶不销毁；无引用才真正清理；
 *  - ：duplicateView（实例重造 id + 数据桶搬家）/ reorderViews。
 * jsdom：isTauri 为 false，SQLite 镜像 / 对账 / 广播分支不触发，断言集中在
 * localStorage 权威源与 store 内存态。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useWidgetStore, applyRemoteWidgets, currentScreenId, loadViews, type WidgetInstance } from "./widget-store";

const inst = (id: string, extra: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "notes",
  x: 0,
  y: 0,
  w: 120,
  h: 120,
  z: 1,
  ...extra
});

const layoutKey = (view: string) => `focus-desk.screen.0.widgets.${view}.v1`;
const notesKey = (id: string) => `focus-desk.notes.${id}`;

describe("widget-store · 视图管理（删除/清空/跨屏防线/复制/排序）", () => {
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({
      screenId: "0",
      views: [
        { id: "v1", name: "默认" },
        { id: "v2", name: "工作" }
      ],
      activeView: "v1",
      instances: [],
      groups: [],
      trash: []
    });
  });

  it("removeView：视图内组件进回收站，数据桶保留（不再当场销毁）", () => {
    const w1 = inst("w1");
    localStorage.setItem(layoutKey("v2"), JSON.stringify([w1]));
    localStorage.setItem(notesKey("w1"), "便签内容");
    useWidgetStore.getState().removeView("v2");
    const st = useWidgetStore.getState();
    expect(st.views.map((v) => v.id)).toEqual(["v1"]);
    expect(st.trash).toHaveLength(1);
    expect(st.trash[0]).toMatchObject({ id: "w1", view: "v2" });
    // 布局键清除、数据桶与回收站键保留。
    expect(localStorage.getItem(layoutKey("v2"))).toBeNull();
    expect(localStorage.getItem(notesKey("w1"))).toBe("便签内容");
    expect(JSON.parse(localStorage.getItem("focus-desk.screen.0.widgets.trash.v1") ?? "[]")).toHaveLength(1);
  });

  it("removeView 删除活动视图时回退到剩余视图", () => {
    localStorage.setItem(layoutKey("v1"), JSON.stringify([inst("w1")]));
    useWidgetStore.setState({ activeView: "v1" });
    useWidgetStore.getState().removeView("v1");
    const st = useWidgetStore.getState();
    expect(st.activeView).toBe("v2");
    expect(st.views.map((v) => v.id)).toEqual(["v2"]);
  });

  it("resetView：组件进回收站（此前不进回收站且数据永久滞留）", () => {
    const w1 = inst("w1");
    localStorage.setItem(layoutKey("v2"), JSON.stringify([w1]));
    localStorage.setItem(notesKey("w1"), "便签内容");
    useWidgetStore.getState().resetView("v2");
    const st = useWidgetStore.getState();
    expect(st.trash).toHaveLength(1);
    expect(st.trash[0]).toMatchObject({ id: "w1", view: "v2" });
    expect(JSON.parse(localStorage.getItem(layoutKey("v2")) ?? "[]")).toHaveLength(0);
    expect(localStorage.getItem(notesKey("w1"))).toBe("便签内容");
  });

  it("P0 防线：其它屏布局仍引用的实例，清空回收站不销毁其数据桶", () => {
    localStorage.setItem(notesKey("w1"), "共享便签");
    // 屏 1 的布局仍引用 w1（copyScreenLayout 保留实例 id 的共享语义）。
    localStorage.setItem("focus-desk.screen.1.widgets.vx.v1", JSON.stringify([inst("w1")]));
    useWidgetStore.setState({
      trash: [{ ...inst("w1"), view: "v1", deletedAt: new Date().toISOString() }]
    });
    useWidgetStore.getState().emptyWidgetTrash();
    expect(useWidgetStore.getState().trash).toHaveLength(0);
    // 数据桶必须存活——屏 1 的组件还在用它。
    expect(localStorage.getItem(notesKey("w1"))).toBe("共享便签");
  });

  it("P0 防线：无任何引用时，彻底删除照常清理数据桶", () => {
    localStorage.setItem(notesKey("w2"), "孤儿数据");
    useWidgetStore.setState({
      trash: [{ ...inst("w2"), view: "v1", deletedAt: new Date().toISOString() }]
    });
    useWidgetStore.getState().purgeWidget("w2");
    expect(useWidgetStore.getState().trash).toHaveLength(0);
    expect(localStorage.getItem(notesKey("w2"))).toBeNull();
  });

  it("P0 防线：同屏其它视图的布局同样算活引用（数据保留）", () => {
    localStorage.setItem(notesKey("w3"), "内容");
    useWidgetStore.setState({
      trash: [{ ...inst("w3"), view: "v1", deletedAt: new Date().toISOString() }]
    });
    // v2 视图的布局里仍引用 w3：无论引用来自哪块屏，活布局即活数据。
    localStorage.setItem(layoutKey("v2"), JSON.stringify([inst("w3")]));
    useWidgetStore.getState().emptyWidgetTrash();
    expect(localStorage.getItem(notesKey("w3"))).toBe("内容");
  });

  it("duplicateView：新视图 + 实例重造 id + 数据桶搬家 + 编组不随行", () => {
    localStorage.setItem(
      layoutKey("v1"),
      JSON.stringify([inst("w1", { groupId: "g1" }), inst("w2", { type: "clock" })])
    );
    localStorage.setItem(notesKey("w1"), "要带走的便签");
    const nid = useWidgetStore.getState().duplicateView("v1", "默认（副本）");
    expect(nid).toBeTruthy();
    const st = useWidgetStore.getState();
    expect(st.views).toHaveLength(3);
    expect(st.views.at(-1)).toMatchObject({ id: nid, name: "默认（副本）" });
    const cloned = JSON.parse(localStorage.getItem(layoutKey(nid)) ?? "[]") as WidgetInstance[];
    expect(cloned).toHaveLength(2);
    // id 全新、groupId 剥离。
    expect(cloned.map((c) => c.id).sort()).not.toContain("w1");
    expect(cloned.every((c) => c.groupId === undefined)).toBe(true);
    // 数据桶随 id 搬家。
    expect(localStorage.getItem(notesKey(cloned[0].id))).toBe("要带走的便签");
    // 源视图不动。
    expect(JSON.parse(localStorage.getItem(layoutKey("v1")) ?? "[]")).toHaveLength(2);
  });

  it("duplicateView：源视图不存在返回空串", () => {
    expect(useWidgetStore.getState().duplicateView("ghost", "x")).toBe("");
  });

  it("reorderViews：移动到目标位置并持久化", () => {
    useWidgetStore.getState().reorderViews("v2", "v1");
    const st = useWidgetStore.getState();
    expect(st.views.map((v) => v.id)).toEqual(["v2", "v1"]);
    expect(
      (JSON.parse(localStorage.getItem("focus-desk.screen.0.widgets.views.v1") ?? "[]") as { id: string }[]).map(
        (v) => v.id
      )
    ).toEqual(["v2", "v1"]);
    // 非法输入 no-op。
    useWidgetStore.getState().reorderViews("ghost", "v1");
    expect(useWidgetStore.getState().views.map((v) => v.id)).toEqual(["v2", "v1"]);
  });
});

describe("views 持久化兜底 + 幽灵活动视图回落", () => {
  const viewsKeyOf = () => "focus-desk.screen.0.widgets.views.v1";

  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({
      screenId: "0",
      views: [
        { id: "v1", name: "默认" },
        { id: "v2", name: "工作" }
      ],
      activeView: "v1",
      instances: [],
      groups: [],
      trash: []
    });
  });

  it("X-1：saveViews 写前 .bak 轮换——内容变化才转存上一份好数据", () => {
    useWidgetStore.getState().addView("专注");
    // 首次保存：主键此前无值，不产生备份。
    expect(JSON.parse(localStorage.getItem(viewsKeyOf())!).length).toBe(3);
    expect(localStorage.getItem(`${viewsKeyOf()}.bak`)).toBeNull();
    useWidgetStore.getState().addView("临时");
    // 第二次保存：上一份（3 视图）转存 .bak，主键为 4 视图。
    const bak = JSON.parse(localStorage.getItem(`${viewsKeyOf()}.bak`)!) as { id: string }[];
    expect(bak.length).toBe(3);
    expect(JSON.parse(localStorage.getItem(viewsKeyOf())!).length).toBe(4);
  });

  it("X-1：主键损坏回退 .bak，并就地自愈主键", () => {
    const good = JSON.stringify([
      { id: "v1", name: "默认" },
      { id: "v2", name: "工作" }
    ]);
    localStorage.setItem(viewsKeyOf(), good);
    localStorage.setItem(`${viewsKeyOf()}.bak`, good);
    // 单键损坏（写一半断电形态）。
    localStorage.setItem(viewsKeyOf(), '{"views":[{"id":"v1","na');
    const views = loadViews();
    expect(views.map((v) => v.id)).toEqual(["v1", "v2"]);
    // 自愈：损坏的主键已被 .bak 好值回写，下一次 viewsHeal/保存即可收敛。
    expect(localStorage.getItem(viewsKeyOf())).toBe(good);
  });

  it("X-1：主备俱坏回落默认表（DB 采纳分支在 jsdom 非 Tauri 环境不触发）", () => {
    localStorage.setItem(viewsKeyOf(), "{corrupted!!");
    localStorage.setItem(`${viewsKeyOf()}.bak`, "]] not json");
    const views = loadViews();
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((v) => typeof v.id === "string" && typeof v.name === "string")).toBe(true);
  });

  it("X-9：applyRemoteWidgets 整替 views 后，幽灵活动视图回落新表首视图", () => {
    // 本窗停在即将消失的视图 ghost；远端（导入）包的 views 不含 ghost，
    // 载荷实例即 v9 的布局（接收侧镜像直写 LS）。
    useWidgetStore.setState({ activeView: "ghost" });
    applyRemoteWidgets({
      screenId: currentScreenId(),
      instances: [inst("w9")],
      views: [{ id: "v9", name: "新表" }],
      activeView: "v9",
      trash: []
    });
    const st = useWidgetStore.getState();
    // 幽灵视图不再驻留：走 setActiveView 完整语义回落 v9 并载入其布局。
    expect(st.activeView).toBe("v9");
    expect(st.instances.map((i) => i.id)).toEqual(["w9"]);
    expect(st.views.map((v) => v.id)).toEqual(["v9"]);
  });
});
