import { beforeEach, describe, expect, it } from "vitest";
import { loadInstances, localStorageWriteWithBackup, useWidgetStore, type WidgetInstance } from "./widget-store";

function makeInstances(): WidgetInstance[] {
  return [
    { id: "a", type: "clock", x: 0, y: 0, w: 200, h: 100, z: 1 },
    { id: "b", type: "notes", x: 0, y: 200, w: 200, h: 100, z: 2 },
    { id: "c", type: "sysbar", x: 0, y: 400, w: 200, h: 100, z: 3 }
  ];
}

/**
 * 验证 编辑模式批量操作（多选/框选/批量移动/批量删除/对齐与等距）：
 *  1. toggleSelect / setSelected 维护多选集合与主单元
 *  2. moveSelectedBy 整组平移（吸附网格）
 *  3. removeSelected 整组移入回收站并清空选择
 *  4. alignSelected 各对齐模式以主单元为基准
 *  5. alignSelected 水平/垂直等距分布
 */
describe("widget-store batch operations (I3)", () => {
  beforeEach(() => {
    useWidgetStore.setState({
      instances: makeInstances(),
      selectedIds: [],
      selectedId: null,
      trash: [],
      editMode: true
    });
  });

  it("toggleSelect 增删多选并更新主单元", () => {
    const s = useWidgetStore.getState();
    s.toggleSelect("a");
    s.toggleSelect("b");
    expect(useWidgetStore.getState().selectedIds).toEqual(["a", "b"]);
    expect(useWidgetStore.getState().selectedId).toBe("b");
    // 再次 toggle 移除 a → 主单元回到 b
    s.toggleSelect("a");
    expect(useWidgetStore.getState().selectedIds).toEqual(["b"]);
    expect(useWidgetStore.getState().selectedId).toBe("b");
    // 全部移除 → 空选择
    s.toggleSelect("b");
    expect(useWidgetStore.getState().selectedIds).toEqual([]);
    expect(useWidgetStore.getState().selectedId).toBeNull();
  });

  it("setSelected 设置集合并将最后一个作为主单元", () => {
    useWidgetStore.getState().setSelected(["a", "b", "c"]);
    expect(useWidgetStore.getState().selectedIds).toEqual(["a", "b", "c"]);
    expect(useWidgetStore.getState().selectedId).toBe("c");
  });

  it("moveSelectedBy 整组平移并吸附网格", () => {
    useWidgetStore.getState().setSelected(["a", "b"]);
    useWidgetStore.getState().moveSelectedBy(25, 35); // 20px 网格吸附：x=round(25/20)*20=20，y=round(35/20)*20=40
    const inst = useWidgetStore.getState().instances;
    expect(inst.find((i) => i.id === "a")).toMatchObject({ x: 20, y: 40 });
    expect(inst.find((i) => i.id === "b")).toMatchObject({ x: 20, y: 240 });
    // 未选中的 c 不受影响
    expect(inst.find((i) => i.id === "c")).toMatchObject({ x: 0, y: 400 });
  });

  it("removeSelected 整组移入回收站并清空选择", () => {
    useWidgetStore.getState().setSelected(["a", "b"]);
    useWidgetStore.getState().removeSelected();
    const state = useWidgetStore.getState();
    expect(state.instances.map((i) => i.id)).toEqual(["c"]);
    expect(state.selectedIds).toEqual([]);
    expect(state.selectedId).toBeNull();
    expect(state.trash.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  it("clearSelection 清空多选", () => {
    useWidgetStore.getState().setSelected(["a", "b"]);
    useWidgetStore.getState().clearSelection();
    expect(useWidgetStore.getState().selectedIds).toEqual([]);
    expect(useWidgetStore.getState().selectedId).toBeNull();
  });

  it("alignSelected left 以主单元左缘对齐", () => {
    // 主单元 c（x=0），a/b 移到 x=0
    useWidgetStore.getState().setSelected(["a", "b", "c"]);
    // 先把 a 右移，验证被拉回
    useWidgetStore.getState().updateWidget("a", { x: 300 });
    useWidgetStore.getState().alignSelected("left");
    const inst = useWidgetStore.getState().instances;
    expect(inst.find((i) => i.id === "a")?.x).toBe(0);
    expect(inst.find((i) => i.id === "b")?.x).toBe(0);
  });

  it("alignSelected top 以主单元顶缘对齐", () => {
    useWidgetStore.getState().setSelected(["a", "b", "c"]);
    useWidgetStore.getState().updateWidget("b", { y: 120 });
    useWidgetStore.getState().alignSelected("top");
    const inst = useWidgetStore.getState().instances;
    // 主单元 c（y=400）→ 所有 y=400
    expect(inst.find((i) => i.id === "a")?.y).toBe(400);
    expect(inst.find((i) => i.id === "b")?.y).toBe(400);
    expect(inst.find((i) => i.id === "c")?.y).toBe(400);
  });

  it("alignSelected right 以主单元右缘对齐", () => {
    useWidgetStore.getState().setSelected(["a", "b", "c"]);
    useWidgetStore.getState().updateWidget("a", { x: 500 });
    useWidgetStore.getState().alignSelected("right");
    const inst = useWidgetStore.getState().instances;
    // 主单元 c：right = 0+200=200 → a/b 的 x = 200-200 = 0
    expect(inst.find((i) => i.id === "a")?.x).toBe(0);
    expect(inst.find((i) => i.id === "b")?.x).toBe(0);
  });

  it("alignSelected bottom 以主单元底缘对齐", () => {
    useWidgetStore.getState().setSelected(["a", "b", "c"]);
    useWidgetStore.getState().updateWidget("c", { y: 700 });
    useWidgetStore.getState().alignSelected("bottom");
    const inst = useWidgetStore.getState().instances;
    // 主单元 c：bottom = 700+100 = 800 → a/b 的 y = 800-100 = 700
    expect(inst.find((i) => i.id === "a")?.y).toBe(700);
    expect(inst.find((i) => i.id === "b")?.y).toBe(700);
  });

  it("alignSelected center 以主单元水平中线对齐", () => {
    // 主单元 b（最后选中）w=200 → 中线 400；a 需 x = 400 - 200/2 = 300
    useWidgetStore.getState().setSelected(["a", "b"]);
    useWidgetStore.getState().updateWidget("b", { x: 300 });
    useWidgetStore.getState().alignSelected("center");
    expect(useWidgetStore.getState().instances.find((i) => i.id === "a")?.x).toBe(300);
  });

  it("alignSelected hspace 垂直方向保持、水平等距分布", () => {
    // 三个等宽组件，设置不同 x，验证中心点均匀分布
    useWidgetStore.getState().setSelected(["a", "b", "c"]);
    useWidgetStore.getState().updateWidget("a", { x: 0 });
    useWidgetStore.getState().updateWidget("b", { x: 100 });
    useWidgetStore.getState().updateWidget("c", { x: 400 });
    useWidgetStore.getState().alignSelected("hspace");
    const inst = useWidgetStore.getState().instances;
    // 中心点分别 100 / 150 / 500 → 均匀分布后 100 / 300 / 500（间隔 200）
    const ca = inst.find((i) => i.id === "a")!.x + 100;
    const cb = inst.find((i) => i.id === "b")!.x + 100;
    const cc = inst.find((i) => i.id === "c")!.x + 100;
    expect(ca).toBe(100);
    expect(cb).toBe(300);
    expect(cc).toBe(500);
    // 垂直不变
    expect(inst.find((i) => i.id === "a")?.y).toBe(0);
    expect(inst.find((i) => i.id === "b")?.y).toBe(200);
    expect(inst.find((i) => i.id === "c")?.y).toBe(400);
  });

  it("alignSelected vspace 水平方向保持、垂直等距分布", () => {
    useWidgetStore.getState().setSelected(["a", "b", "c"]);
    useWidgetStore.getState().updateWidget("a", { y: 0 });
    useWidgetStore.getState().updateWidget("b", { y: 100 });
    useWidgetStore.getState().updateWidget("c", { y: 400 });
    useWidgetStore.getState().alignSelected("vspace");
    const inst = useWidgetStore.getState().instances;
    // 中心点 y：50 / 150 / 450 → 均匀 50 / 250 / 450（间隔 200）
    const ca = inst.find((i) => i.id === "a")!.y + 50;
    const cb = inst.find((i) => i.id === "b")!.y + 50;
    const cc = inst.find((i) => i.id === "c")!.y + 50;
    expect(ca).toBe(50);
    expect(cb).toBe(250);
    expect(cc).toBe(450);
    // 水平不变
    expect(inst.find((i) => i.id === "a")?.x).toBe(0);
    expect(inst.find((i) => i.id === "c")?.x).toBe(0);
  });

  it("单选 selectWidget 重置多选为单元素", () => {
    useWidgetStore.getState().setSelected(["a", "b"]);
    useWidgetStore.getState().selectWidget("c");
    expect(useWidgetStore.getState().selectedIds).toEqual(["c"]);
    expect(useWidgetStore.getState().selectedId).toBe("c");
  });
});
/**
 * 布局写前备份轮换：
 *  - 写入时内容变化才轮换 `.bak`（同值不写，防抖稳定态不重复 IO）；
 *  - 主键损坏 / 缺失 → loadInstances 退回 `.bak`；
 *  - 主键是合法空数组（用户删光）不算损坏，不用备份顶替（防删除复活）。
 */
describe("widget-store layout backup rotation (E18)", () => {
  const KEY = "focus-desk.screen.0.widgets.home.v1";

  beforeEach(() => {
    localStorage.clear();
  });

  it("写入轮换 .bak：内容变化才更新备份", () => {
    localStorageWriteWithBackup(KEY, "[1]");
    expect(localStorage.getItem(`${KEY}.bak`)).toBeNull(); // 首写无旧值
    localStorageWriteWithBackup(KEY, "[2]");
    expect(localStorage.getItem(`${KEY}.bak`)).toBe("[1]");
    localStorageWriteWithBackup(KEY, "[2]"); // 同值不重复轮换
    expect(localStorage.getItem(`${KEY}.bak`)).toBe("[1]");
    expect(localStorage.getItem(KEY)).toBe("[2]");
  });

  it("主键损坏 → 退回 .bak 布局", () => {
    localStorage.setItem(KEY, "{corrupt!!");
    localStorage.setItem(`${KEY}.bak`, JSON.stringify(makeInstances()));
    const loaded = loadInstances("home");
    expect(loaded.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("主键缺失 → 退回 .bak；两者皆无 → 空数组", () => {
    localStorage.setItem(`${KEY}.bak`, JSON.stringify(makeInstances().slice(0, 1)));
    expect(loadInstances("home").map((i) => i.id)).toEqual(["a"]);
    localStorage.removeItem(`${KEY}.bak`);
    expect(loadInstances("home")).toEqual([]);
  });

  it("主键为合法空数组 → 不用备份顶替（防删除复活）", () => {
    localStorage.setItem(KEY, "[]");
    localStorage.setItem(`${KEY}.bak`, JSON.stringify(makeInstances()));
    expect(loadInstances("home")).toEqual([]);
  });
});

/**
 * 布局读取迁移（编码哈希并入计算器 / 贴图收编为截图钉图专属）：
 *  - encoder 实例原位改为 calculator（位置尺寸保留）；
 *  - 无 config.src 的空贴图剔除，钉出（有 src）的保留。
 */
describe("widget-store instance migration (encoder→calculator / pin 收编)", () => {
  const KEY = "focus-desk.screen.0.widgets.home.v1";

  beforeEach(() => {
    localStorage.clear();
  });

  it("encoder 实例迁移为 calculator，几何字段原样保留", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "e1", type: "encoder", x: 10, y: 20, w: 320, h: 380, z: 4 }]));
    const loaded = loadInstances("home");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: "e1", type: "calculator", x: 10, y: 20, w: 320, h: 380, z: 4 });
  });

  it("空贴图剔除；有 src 的钉出贴图保留", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "p1", type: "pin", x: 0, y: 0, w: 320, h: 240, z: 1 },
        { id: "p2", type: "pin", x: 100, y: 0, w: 200, h: 120, z: 2 }
      ])
    );
    localStorage.setItem("focus-desk.widget-config.p2.v1", JSON.stringify({ src: "C:/snip/xx.png" }));
    expect(loadInstances("home").map((i) => i.id)).toEqual(["p2"]);
  });
});

/**
 * 信任边界收口（z 序污点链）：持久化 JSON 里被篡改的几何 / z 字段（非数字、
 * null、Infinity——NaN/Infinity 经 JSON.stringify 序列化为 null）不得进入
 * store；一旦放行会经 Math.max 毒化 zCounter 为 NaN，沿 renormalizeZ /
 * syncZCounter 的排序扩散成全局层序失效。
 */
describe("widget-store persisted geometry validation", () => {
  const KEY = "focus-desk.screen.0.widgets.home.v1";

  beforeEach(() => {
    localStorage.clear();
  });

  it("非有限 z / 几何的实例在加载时被整体剔除", () => {
    const good = { id: "ok", type: "clock", x: 0, y: 0, w: 200, h: 100, z: 1 };
    const poisoned = [
      { ...good, id: "z-obj", z: {} },
      { ...good, id: "z-str", z: "10" },
      { ...good, id: "z-null", z: null },
      { ...good, id: "z-inf", z: Infinity },
      { ...good, id: "x-nan", x: NaN }
    ];
    localStorage.setItem(KEY, JSON.stringify([good, ...poisoned]));
    const loaded = loadInstances("home");
    expect(loaded.map((i) => i.id)).toEqual(["ok"]);
    expect(loaded.every((i) => [i.x, i.y, i.w, i.h, i.z].every(Number.isFinite))).toBe(true);
  });
});

/**
 * 视图操作的中层约束（2026-10 视图审计）：
 *  - 命名：addView/duplicateView 撞名自动加序号、超长按码点截断；
 *    renameView 撞名拒绝（静默 no-op——UI 的 promptViewName 负责提示）；
 *  - 排序：reorderViews 移动列表位置并持久化（Ctrl+1/2/3 与 Dock 箭头按此序）；
 *  - 复制：duplicateView 重造实例 id、数据桶搬家、布局即刻落盘、编组剥离。
 */
describe("widget-store 视图操作（命名约束 / 排序 / 复制）", () => {
  const VIEWS_KEY = "focus-desk.screen.0.widgets.views.v1";
  const SRC_LAYOUT_KEY = "focus-desk.screen.0.widgets.v1.v1";

  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({
      views: [
        { id: "home", name: "主页" },
        { id: "v1", name: "Work" },
        { id: "focus", name: "专注" }
      ],
      activeView: "home",
      instances: [],
      groups: [],
      trash: []
    });
  });

  it("addView 撞名自动加序号；再次撞名递增", () => {
    const id1 = useWidgetStore.getState().addView("Work");
    expect(useWidgetStore.getState().views.map((v) => v.name)).toEqual(["主页", "Work", "专注", "Work 2"]);
    const id2 = useWidgetStore.getState().addView("Work");
    expect(useWidgetStore.getState().views.at(-1)?.name).toBe("Work 3");
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("addView 超长按码点截断（emoji 代理对不劈半）并持久化视图表", () => {
    const long = "🚀".repeat(30);
    const id = useWidgetStore.getState().addView(long);
    const name = useWidgetStore.getState().views.find((v) => v.id === id)?.name ?? "";
    expect(Array.from(name).length).toBeLessThanOrEqual(24);
    expect([...name].at(-1)).toBe("🚀"); // 截断不产生半个代理对
    const persisted = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "[]");
    expect(persisted).toHaveLength(4);
  });

  it("renameView 撞其它视图同名时拒绝（no-op），正常改名则写入并持久化", () => {
    const s = useWidgetStore.getState();
    s.renameView("home", "Work");
    expect(useWidgetStore.getState().views.find((v) => v.id === "home")?.name).toBe("主页");
    s.renameView("home", "  学习  ");
    expect(useWidgetStore.getState().views.find((v) => v.id === "home")?.name).toBe("学习");
    expect(JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "[]")[0]).toMatchObject({ id: "home", name: "学习" });
  });

  it("reorderViews 把视图移动到目标位置并持久化（Ctrl+1/2/3 按此序映射）", () => {
    useWidgetStore.getState().reorderViews("focus", "home");
    expect(useWidgetStore.getState().views.map((v) => v.id)).toEqual(["focus", "home", "v1"]);
    expect(JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "[]").map((v: { id: string }) => v.id)).toEqual([
      "focus",
      "home",
      "v1"
    ]);
  });

  it("duplicateView 克隆布局：实例 id 全部换新、原布局保留、目标视图即刻落盘、名称撞名自动去重", () => {
    localStorage.setItem(
      SRC_LAYOUT_KEY,
      JSON.stringify([
        { id: "i1", type: "clock", x: 0, y: 0, w: 320, h: 200, z: 1 },
        { id: "i2", type: "notes", x: 0, y: 220, w: 280, h: 240, z: 2, groupId: "g1" }
      ])
    );
    const nid = useWidgetStore.getState().duplicateView("v1", "Work");
    expect(nid).toBeTruthy();
    const views = useWidgetStore.getState().views;
    expect(views.map((v) => v.name)).toContain("Work 2");
    // 源视图布局原样保留
    expect(loadInstances("v1").map((i) => i.id)).toEqual(["i1", "i2"]);
    // 新视图布局落盘：id 换新、几何保留、groupId 剥离（旧组引用必然悬空）
    const cloned = loadInstances(nid);
    expect(cloned).toHaveLength(2);
    expect(cloned.map((i) => i.id)).not.toContain("i1");
    expect(cloned.every((i) => i.groupId === undefined)).toBe(true);
    expect(cloned.find((i) => i.type === "clock")).toMatchObject({ x: 0, y: 0, w: 320, h: 200 });
  });

  it("duplicateView 源视图不存在返回空串（防御直调）", () => {
    expect(useWidgetStore.getState().duplicateView("nope", "X")).toBe("");
  });
});
