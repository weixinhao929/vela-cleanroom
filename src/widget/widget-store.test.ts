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
 * 验证 I3 编辑模式批量操作（多选/框选/批量移动/批量删除/对齐与等距）：
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
 * E18 布局写前备份轮换：
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
