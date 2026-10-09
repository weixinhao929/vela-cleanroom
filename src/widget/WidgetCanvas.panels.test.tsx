/**
 * 编辑工具栏弹层（布局模板 / 布局历史 / 灵动岛）的开关治理回归：
 *  - 退出编辑模式（含跨窗口 setState 直改 editMode 的路径）必须清掉全部
 *    弹层——此前模板/历史面板漏清，退出编辑后残留在已穿透的画布上关不掉
 *    （用户实测「点开的留在那里」）；
 *  - 同锚位弹层互斥：模板 / 历史 / 灵动岛共用工具栏上方锚点，打开任一收
 *    其余（此前灵动岛可与模板完全重叠）；
 *  - Esc 分层：弹层开着时 Esc 先收面板、不退出编辑；面板全收后再按才退出；
 *  - 外点关闭：按下落在工具栏与面板之外（画布空白）即收起全部弹层；
 *  - 多选批量工具栏与弹层互斥让位：面板打开时批量工具栏隐藏（同锚位重叠），
 *    面板收起后选区保留、批量工具栏回来。
 *
 * 环境要点：jsdom（screen=0）默认视图 home，预写 `focus-desk.screen.0.
 * widgets.home.v1` 布局键——hydrate 同步加载这两个实例且跳过默认种子播种
 * （否则异步播种 9 个组件与用例内的 store 断言互踩）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WidgetCanvas } from "./WidgetCanvas";
import { useWidgetStore, type WidgetInstance } from "./widget-store";

/** jsdom 没有 PointerEvent：没有它 fireEvent.pointerDown 只发裸 Event，button 丢失。 */
class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeAll(() => {
  const w = window as unknown as { PointerEvent?: unknown };
  if (!w.PointerEvent) w.PointerEvent = PointerEventPolyfill;
  if (typeof window.requestAnimationFrame !== "function") {
    window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
  }
});

const LAYOUT_KEY = "focus-desk.screen.0.widgets.home.v1";

const mkInst = (id: string, over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "clock",
  x: 0,
  y: 0,
  w: 200,
  h: 120,
  z: 1,
  ...over
});
const INSTANCES = [mkInst("a"), mkInst("b", { x: 300 })];

/** 模块加载时的 pristine store 快照：逐用例整包回滚（弹层测试改 editMode /
 *  selectedIds，hydrate 改 instances/groups）。 */
const pristine = useWidgetStore.getState();

const editModeNow = () => useWidgetStore.getState().editMode;

const tplPanel = () => screen.queryByRole("dialog", { name: "布局模板" });
const histPanel = () => screen.queryByRole("dialog", { name: "布局历史" });
const dockPanel = () => screen.queryByRole("dialog", { name: "灵动岛" });

/** 等退场延迟窗口（useDelayedUnmount + fxFastMs）走完、元素真正卸载。 */
async function gone(query: () => HTMLElement | null) {
  await waitFor(() => expect(query()).toBeNull(), { timeout: 2000 });
}
async function shown(query: () => HTMLElement | null) {
  await waitFor(() => expect(query()).toBeTruthy(), { timeout: 2000 });
}

/** 挂载画布并进入编辑模式；等工具栏按钮就位（act 外的 store 更新经
 *  findBy 的轮询窗口自然 flush）。 */
async function mountCanvas() {
  const r = render(<WidgetCanvas />);
  useWidgetStore.getState().setEditMode(true);
  await screen.findByRole("button", { name: "布局模板" });
  return r;
}

describe("编辑工具栏弹层治理", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(INSTANCES));
    useWidgetStore.setState({ ...pristine, editMode: false, selectedIds: [] }, true);
  });
  afterEach(() => {
    useWidgetStore.setState(pristine, true);
    localStorage.clear();
  });

  it("打开布局模板后退出编辑模式：面板必须随退场卸载（不再残留）", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    expect(tplPanel()!.className).not.toContain("is-closing");
    // 模拟任何退出路径（工具栏按钮 / Esc / 跨窗口 widget:edit-mode 事件），
    // 都汇到 editMode 翻转——防御性同步负责收全部浮层。
    useWidgetStore.getState().setEditMode(false);
    await gone(tplPanel);
  });

  it("打开布局历史后退出编辑模式：同样随退场卸载", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局历史" }));
    await shown(histPanel);
    useWidgetStore.getState().setEditMode(false);
    await gone(histPanel);
  });

  it("同锚位弹层互斥：模板→历史→灵动岛，任一时刻至多一个", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    fireEvent.click(screen.getByRole("button", { name: "布局历史" }));
    await gone(tplPanel);
    await shown(histPanel);
    // 灵动岛面板懒加载（动态 import），同样参与互斥。
    fireEvent.click(screen.getByRole("button", { name: "灵动岛" }));
    await gone(histPanel);
    await shown(dockPanel);
    expect(tplPanel()).toBeNull();
  });

  it("Esc 分层：弹层开着时先收面板、不退出编辑；面板全收后再按才退出", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    fireEvent.keyDown(window, { key: "Escape" });
    await gone(tplPanel);
    expect(editModeNow()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(editModeNow()).toBe(false));
  });

  it("外点关闭：画布空白处按下即收起弹层（编辑模式保持）", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    fireEvent.pointerDown(document.querySelector(".widget-canvas")!);
    await gone(tplPanel);
    expect(histPanel()).toBeNull();
    expect(dockPanel()).toBeNull();
    expect(editModeNow()).toBe(true);
  });

  it("多选批量工具栏与弹层互斥让位：面板打开时隐藏，收起后选区保留工具栏回来", async () => {
    await mountCanvas();
    useWidgetStore.setState({ selectedIds: ["a", "b"] });
    await waitFor(() => expect(document.querySelector(".widget-batch-toolbar")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    await waitFor(() => expect(document.querySelector(".widget-batch-toolbar")).toBeNull());
    // Esc 收面板 → 选区未动，批量工具栏自动回来。
    fireEvent.keyDown(window, { key: "Escape" });
    await gone(tplPanel);
    await waitFor(() => expect(document.querySelector(".widget-batch-toolbar")).toBeTruthy());
    expect(useWidgetStore.getState().selectedIds).toEqual(["a", "b"]);
  });

  it("面板锚点跟随工具栏：默认位置时 bottom = bottomInset + 工具栏高 + 间距", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    // jsdom 无任务栏：bottomInset = max(0,52)+16 = 68；工具栏高兜底 38。
    // 此前面板硬编码 bottom:68，与工具栏（bottom:68 起、高约 38）重叠。
    const bottom = Number.parseFloat(tplPanel()!.style.bottom);
    expect(bottom).toBeGreaterThanOrEqual(68 + 38);
  });

  it("工具栏方向键导航（ARIA toolbar 模式）：→ 移动焦点并循环，End 跳末位", async () => {
    await mountCanvas();
    const btns = () => [...document.querySelectorAll<HTMLButtonElement>(".widget-edit-toolbar button")];
    expect(btns().length).toBeGreaterThanOrEqual(8);
    btns()[0].focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(btns()[1]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(btns()[btns().length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(btns()[0]); // 循环回首
  });

  it("键盘守卫：焦点在工具栏按钮上按方向键/Delete，选中组件不动不删", async () => {
    await mountCanvas();
    // 主选中是单数 selectedId（WidgetCard 只在主单元挂全局 keydown）。
    useWidgetStore.setState({ selectedId: "a", selectedIds: ["a"] });
    const before = useWidgetStore.getState().instances.map((i) => ({ id: i.id, x: i.x, y: i.y }));
    const btn = screen.getByRole("button", { name: "布局模板" });
    btn.focus();
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    fireEvent.keyDown(btn, { key: "ArrowUp" });
    fireEvent.keyDown(btn, { key: "Delete" });
    await waitFor(() => {
      const now = useWidgetStore.getState();
      expect(now.instances.map((i) => ({ id: i.id, x: i.x, y: i.y }))).toEqual(before);
    });
    // 对照组：焦点在画布层（body）时方向键正常微移——证明守卫只是排除
    // 编辑铬件，不是把微移整个关掉。
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => {
      const a = useWidgetStore.getState().instances.find((i) => i.id === "a")!;
      expect(a.x).toBe(before[0].x + 20);
    });
  });

  it("模板面板打开即聚焦名称输入框，且输入框有可访问名", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    const input = tplPanel()!.querySelector("input")!;
    expect(input.getAttribute("aria-label")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("模板名称输入：IME 组词期 Enter 不提交，普通 Enter 保存模板", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    const input = tplPanel()!.querySelector("input")!;
    fireEvent.change(input, { target: { value: "工作台" } });
    // 组词期 Enter（拼音选字确认）：不提交（同款守卫）。
    const composed = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(composed, "isComposing", { value: true });
    input.dispatchEvent(composed);
    await waitFor(() => expect(useWidgetStore.getState().templates.length).toBe(0));
    // 普通 Enter：以当前布局保存为模板。
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(useWidgetStore.getState().templates.length).toBe(1));
    expect(useWidgetStore.getState().templates[0].name).toBe("工作台");
  });

  it("模板列表最新在前：后保存的模板排在首行（与布局历史同口径）", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    const input = tplPanel()!.querySelector("input")!;
    for (const name of ["第一个", "第二个"]) {
      fireEvent.change(input, { target: { value: name } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        const names = [...document.querySelectorAll(".widget-template-row-name")].map((n) => n.textContent);
        expect(names).toContain(name);
      });
    }
    const names = [...document.querySelectorAll(".widget-template-row-name")].map((n) => n.textContent);
    expect(names[0]).toBe("第二个");
    expect(names[1]).toBe("第一个");
  });

  it("Esc 收面板后焦点归还触发按钮（键盘闭环）", async () => {
    await mountCanvas();
    fireEvent.click(screen.getByRole("button", { name: "布局模板" }));
    await shown(tplPanel);
    // autoFocus 把焦点放进名称框；Esc 收面板后应归还到「布局模板」按钮。
    await waitFor(() => expect(document.activeElement).toBe(tplPanel()!.querySelector("input")));
    fireEvent.keyDown(window, { key: "Escape" });
    await gone(tplPanel);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "布局模板" })));
  });
});
