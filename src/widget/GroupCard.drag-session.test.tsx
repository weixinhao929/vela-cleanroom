/**
 * 回归：编辑模式中途跨窗退出（widget:edit-mode(false)）
 * 时，整组拖拽会话必须被终结——只修了 resize 半边，drag 半边的 pointer
 * capture 打在「按下最深元素」（把手是 {editMode && …} 条件挂载）上，随
 * editMode 翻假 capture 静默丢失 → onHeadUp 永不触发 → 会话残留：
 * .dragging 卡死 + setWidgetsSyncSuspended(true) 全局挂起（本窗此后所有
 * 布局编辑不再跨窗广播）。修复后 editMode 翻假即走与 Esc 同一套丢弃路径。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";

const emitMock = vi.fn(async (_name: string, _payload?: unknown) => {});

vi.mock("@tauri-apps/api/event", () => ({
  emit: (name: string, payload?: unknown) => emitMock(name, payload),
  listen: vi.fn(async () => () => {})
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: vi.fn(async () => null) };
});

import { useCrossWindowSync } from "../lib/cross-window";
import { GroupCard } from "./GroupCard";
import { useWidgetStore, type WidgetGroup, type WidgetInstance } from "./widget-store";

/** jsdom 没有 PointerEvent：没有它 fireEvent.pointerDown 只发裸 Event，button / clientX 全丢。 */
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

const mkInst = (id: string): WidgetInstance => ({ id, type: "clock", x: 0, y: 0, w: 200, h: 120, z: 1, groupId: "g1" });
const mkGroup = (): WidgetGroup => ({
  id: "g1",
  x: 0,
  y: 0,
  w: 400,
  h: 200,
  z: 2,
  memberIds: ["a", "b"],
  activeId: "a"
});

const prev = {
  instances: useWidgetStore.getState().instances,
  groups: useWidgetStore.getState().groups,
  editMode: useWidgetStore.getState().editMode,
  selectedId: useWidgetStore.getState().selectedId,
  selectedIds: useWidgetStore.getState().selectedIds,
  enteringIds: useWidgetStore.getState().enteringIds,
  pulseIds: useWidgetStore.getState().pulseIds,
  exitingIds: useWidgetStore.getState().exitingIds
};

const widgetEmits = () => emitMock.mock.calls.filter(([n]) => n === "sync:widgets");

describe("GroupCard 整组拖拽会话的 editMode 翻假终结（Q-2）", () => {
  beforeAll(() => {
    const w = window as unknown as { PointerEvent?: unknown };
    if (!w.PointerEvent) w.PointerEvent = PointerEventPolyfill;
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.setPointerCapture ??= () => {};
    proto.releasePointerCapture ??= () => {};
    proto.hasPointerCapture ??= () => false;
  });
  beforeEach(() => {
    useWidgetStore.setState({
      instances: [mkInst("a"), mkInst("b")],
      groups: [mkGroup()],
      editMode: true,
      selectedId: null,
      selectedIds: [],
      enteringIds: [],
      pulseIds: [],
      exitingIds: []
    });
  });
  afterEach(() => {
    useWidgetStore.setState(prev);
  });

  it("跨窗退出编辑终结会话：托起态解除、跨窗广播挂起复位（此后布局编辑恢复广播）", async () => {
    const sync = renderHook(() => useCrossWindowSync());
    const { container, unmount } = render(<GroupCard group={mkGroup()} />);
    const root = container.querySelector<HTMLElement>('[data-group-id="g1"]')!;
    const tabs = container.querySelector<HTMLElement>(".widget-group-tabs")!;
    // 标签条空白区起拖（onHeadDown → dragRef），越过 3px 阈值进入托起态。
    fireEvent.pointerDown(tabs, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 140, clientY: 100 });
    await waitFor(() => expect(root.className).toContain("dragging"));
    // 模拟跨窗广播退出编辑：把手随 {editMode && …} 卸载、capture 丢失，
    // onHeadUp 永不到来——只能靠 editMode 翻假 effect 收尾。
    act(() => useWidgetStore.setState({ editMode: false }));
    await waitFor(() => expect(root.className).not.toContain("dragging"));
    // 挂起复位证明：排空既有防抖（engaged 时 bringToFront 已排队一次广播）后，
    // 新的本地布局编辑必须能再次触发 sync:widgets——若挂起残留，订阅回调被
    // 抑制、永远没有发射。
    await new Promise((res) => setTimeout(res, 150));
    emitMock.mockClear();
    act(() => useWidgetStore.getState().updateWidget("a", { x: 48, y: 48 }));
    await waitFor(() => expect(widgetEmits().length).toBeGreaterThanOrEqual(1));
    unmount();
    sync.unmount();
  });

  it("「已 set 未 engaged」的按压会话同样被终结，且不影响下一次会话", async () => {
    const { container, unmount } = render(<GroupCard group={mkGroup()} />);
    const root = container.querySelector<HTMLElement>('[data-group-id="g1"]')!;
    const tabs = container.querySelector<HTMLElement>(".widget-group-tabs")!;
    // 按下未过阈值（未 engaged）即退出编辑。
    fireEvent.pointerDown(tabs, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    act(() => useWidgetStore.setState({ editMode: false }));
    expect(root.className).not.toContain("dragging");
    // 重新进入编辑模式可正常开启新会话（dragRef 已清，无残留变量）。
    act(() => useWidgetStore.setState({ editMode: true }));
    fireEvent.pointerDown(tabs, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(root, { pointerId: 2, clientX: 140, clientY: 100 });
    await waitFor(() => expect(root.className).toContain("dragging"));
    // Esc 仍是同一条取消路径（对照，防止修复把 Esc 路径挤掉）。
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(root.className).not.toContain("dragging"));
    unmount();
  });
});
