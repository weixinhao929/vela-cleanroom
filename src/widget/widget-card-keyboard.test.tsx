/**
 * 键盘选中无障碍测试：编辑模式下卡片壳层可 Tab 聚焦（tabIndex=0），
 * 聚焦即选中（与指针按下同语义），随后方向键微移 / Shift+方向键缩放 /
 * Delete 删除的既有监听随之可用；非编辑模式卡片不进 Tab 序。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { WidgetCard } from "./WidgetCard";
import { useWidgetStore, GRID, type WidgetInstance } from "./widget-store";

const instance = (over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id: "w-key",
  type: "clock",
  x: 100,
  y: 100,
  w: 320,
  h: 200,
  z: 1,
  ...over
});

const prev = {
  instances: useWidgetStore.getState().instances,
  selectedId: null as string | null,
  selectedIds: [] as string[],
  editMode: useWidgetStore.getState().editMode
};

const cardEl = () => document.querySelector<HTMLElement>('[data-widget-id="w-key"]')!;

describe("WidgetCard 键盘选中（G13）", () => {
  beforeEach(() => {
    useWidgetStore.setState({ instances: [instance()], editMode: true, selectedId: null, selectedIds: [] });
  });

  afterEach(() => {
    useWidgetStore.setState({
      ...prev,
      exitingIds: [],
      enteringIds: [],
      pulseIds: [],
      posAnimIds: [],
      dragPreview: {},
      resizePreview: null
    });
  });

  it("编辑模式：卡片进 Tab 序，聚焦壳层即选中", () => {
    render(<WidgetCard {...instance()} />);
    const el = cardEl();
    expect(el.tabIndex).toBe(0);
    expect(useWidgetStore.getState().selectedId).toBeNull();
    fireEvent.focus(el);
    expect(useWidgetStore.getState().selectedId).toBe("w-key");
    expect(useWidgetStore.getState().selectedIds).toContain("w-key");
  });

  it("选中后方向键微移、Shift+方向键缩放、Delete 删除", () => {
    render(<WidgetCard {...instance()} />);
    fireEvent.focus(cardEl());
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useWidgetStore.getState().instances[0].x).toBe(100 + GRID);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(useWidgetStore.getState().instances[0].w).toBe(320 + GRID);
    fireEvent.keyDown(window, { key: "Delete" });
    // removeWidgetsAnimated 先记 exitingIds 再延迟移除，两个阶段都算通过。
    expect(
      useWidgetStore.getState().exitingIds.includes("w-key") ||
        !useWidgetStore.getState().instances.some((i) => i.id === "w-key")
    ).toBe(true);
  });

  it("聚焦内部控件不劫持选中（e.target 校验）", () => {
    render(<WidgetCard {...instance()} />);
    // 编辑模式底部工具栏的删除按钮在 React 树内，其 focus 事件冒泡到壳层。
    const inner = cardEl().querySelector<HTMLElement>("button.widget-del");
    expect(inner, "编辑栏删除按钮存在").toBeTruthy();
    fireEvent.focus(inner!);
    expect(useWidgetStore.getState().selectedId).toBeNull();
  });

  it("非编辑模式：卡片不进 Tab 序（tabIndex 未设置）", () => {
    useWidgetStore.setState({ editMode: false });
    render(<WidgetCard {...instance()} />);
    // DOM 属性未设置时 tabIndex getter 返回 -1。
    expect(cardEl().tabIndex).toBe(-1);
  });
});
