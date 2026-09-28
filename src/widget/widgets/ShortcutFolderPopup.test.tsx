/**
 * 快捷方式文件夹弹层拖拽回归（jsdom）：
 *  - 拖拽幽灵经 Portal 挂 body、fixed 定身——条目 DOM 在 .sfolder-pages-track
 *    （恒有 transform 位移）内，旧实现把 fixed 条目留在原地，transformed 祖先
 *    劫持包含块导致冻结视口坐标错位、被 overflow:hidden 裁掉（「一拖就消失」）；
 *  - 指针事件挂 window：条目 DOM 被移除（跨页懒挂载重建的等价场景）后
 *    pointerup 仍能收尾，拖拽态不卡死；
 *  - 自由排序下松手提交 onReorder；无位移的纯点击仍走打开。
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ShortcutFolderPopup } from "./ShortcutFolderPopup";
import type { CustomShortcut, ShortcutFolder } from "../shortcuts-shared";

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => false };
});

/* jsdom 无 PointerEvent：fireEvent.pointerDown 退化成普通 Event，button 等
 * 初始化全部丢失，组件的 `e.button !== 0` 守卫会早退。补一个最小实现
 * （继承 MouseEvent），让按下事件成为真正的指针事件。 */
if (typeof window.PointerEvent !== "function") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: { pointerId?: number } & MouseEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}

const ITEMS: CustomShortcut[] = [
  { id: "a", label: "阿文档", path: "C:/a.txt", kind: "file" },
  { id: "b", label: "必应用", path: "C:/b.lnk", kind: "file" },
  { id: "c", label: "西表格", path: "C:/c.xlsx", kind: "file" }
];

const FOLDER: ShortcutFolder = { id: "f1", label: "资料夹", childIds: ["a", "b", "c"] };

const anchor = { x: 100, y: 100, w: 60, h: 80 };

type PopupProps = Parameters<typeof ShortcutFolderPopup>[0];

function renderPopup(overrides: Partial<PopupProps> = {}) {
  const props: PopupProps = {
    folder: FOLDER,
    items: ITEMS,
    anchor,
    icons: {},
    openMode: "click",
    sort: "free",
    onSortChange: vi.fn(),
    onClose: vi.fn(),
    onOpenItem: vi.fn(),
    onMoveOut: vi.fn(),
    onRemoveItem: vi.fn(),
    onRevealItem: vi.fn(),
    onCopyItemPath: vi.fn(),
    onRenameItem: vi.fn(),
    onRelocateItem: vi.fn(),
    onReorder: vi.fn(),
    onDropOutside: vi.fn(),
    onDropTargetMove: vi.fn(),
    hitTestOutside: vi.fn(() => null),
    onHoverEnter: vi.fn(),
    onHoverLeave: vi.fn(),
    ...overrides
  };
  return { ...render(<ShortcutFolderPopup {...props} />), props };
}

/** jsdom 无布局：统一把元素矩形撑成大视口，弹层内命中判定才可走 inside 分支。 */
function stubRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    x: 0,
    y: 0
  } as DOMRect);
}

/**
 * window 级移动/松开分发：手写 PointerEvent + act 包裹（window 监听不在
 * React 事件通道上，不包 act 的话 setDrag 的渲染要到微任务后才可见）。
 */
function fireWindowPointer(
  type: "pointermove" | "pointerup" | "pointercancel",
  coords: { clientX?: number; clientY?: number } = {}
) {
  act(() => {
    window.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, ...coords }));
  });
}

/** elementFromPoint → 指向条目 sfId 的伪命中（jsdom 无此 API，直接赋值桩）。 */
function stubHitTarget(sfId: string) {
  const hit = { dataset: { sfId } };
  (document as unknown as Record<string, unknown>).elementFromPoint = () =>
    ({
      closest: () => hit
    }) as unknown as Element;
}

const ghostInBody = () => document.body.querySelector(":scope > .sfolder-popup-item.is-dragging");

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).elementFromPoint;
  vi.restoreAllMocks();
});

describe("ShortcutFolderPopup 弹层内拖拽", () => {
  it("拖动时幽灵 Portal 到 body、本体 display:none 收拢；松手提交重排且幽灵移除", () => {
    stubRects();
    stubHitTarget("a");
    const { props } = renderPopup();

    // 按下条目 c → window pointermove（位移 ≥4px，落在弹层内、命中 a 之前）。
    fireEvent.pointerDown(screen.getByLabelText("西表格"), {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10
    });
    fireWindowPointer("pointermove", { clientX: 10, clientY: 30 });

    // 幽灵在 body 直下（Portal），本体隐身但仍在网格里（节点保持挂载）。
    expect(ghostInBody()).not.toBeNull();
    expect(ghostInBody()).toHaveTextContent("西表格");
    expect(screen.getByLabelText("西表格")).toHaveStyle({ display: "none" });

    // 松手：提交 childIds 全序（c 插到 a 之前），幽灵随之移除。
    fireWindowPointer("pointerup");
    expect(props.onReorder).toHaveBeenCalledWith(["c", "a", "b"]);
    expect(ghostInBody()).toBeNull();
  });

  it("条目 DOM 被移除（跨页重建等价）后 pointerup 仍收尾：不提交、不抛错、幽灵复位", () => {
    stubRects();
    stubHitTarget("a");
    const { rerender, props } = renderPopup();

    fireEvent.pointerDown(screen.getByLabelText("西表格"), {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10
    });
    fireWindowPointer("pointermove", { clientX: 10, clientY: 30 });
    expect(ghostInBody()).not.toBeNull();

    // 被拖条目被并发移除（重挂载等价场景）→ 拖拽态复位、监听解绑。
    rerender(
      <ShortcutFolderPopup
        {...props}
        items={ITEMS.filter((i) => i.id !== "c")}
        folder={{ ...FOLDER, childIds: ["a", "b"] }}
      />
    );
    expect(ghostInBody()).toBeNull();

    // 随后的 pointerup 不得触发提交或外部落点（监听已解绑 / dragRef 已清）。
    fireWindowPointer("pointerup");
    expect(props.onReorder).not.toHaveBeenCalled();
    expect(props.onDropOutside).not.toHaveBeenCalled();
  });

  it("无位移的按下-松开是纯点击：不进拖拽、onClick 打开条目", () => {
    const { props } = renderPopup();
    const item = screen.getByLabelText("必应用");
    fireEvent.pointerDown(item, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireWindowPointer("pointerup");
    fireEvent.click(item);
    expect(props.onOpenItem).toHaveBeenCalledWith(ITEMS[1]);
    expect(item).not.toHaveStyle({ display: "none" });
  });
});
