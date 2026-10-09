/**
 * ISLAND-SORT 组件测试（pointer 事件路径，入口 b / ）：
 * 编辑模式直拖排序落盘、拖出 ≥48px 移除 + toast 撤销原位恢复、非编辑模式长按
 * 300ms 起拖且不展开 / 单击仍展开、Esc 原位放回、Ctrl+→ 与 Delete 键盘路径、
 * 「+」选计算器追加通用磁贴、>8 枚横向可滚、让位 / 竖条 / 距离纯函数。
 *
 * jsdom 25 没有 PointerEvent 与 setPointerCapture：补最小 polyfill 让
 * fireEvent.pointer* 带上 clientX / pointerId。几何用 getBoundingClientRect 桩：
 * 磁贴 i 占 [100+64i, 160+64i) × [10, 42)（宽 60 间距 4），岛矩形外扩 4px。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastHost } from "../../components/ToastHost";
import { useWidgetStore, type DockTile } from "../widget-store";
import {
  DockTiles,
  LONG_PRESS_MS,
  REMOVE_DISTANCE_PX,
  distanceToRect,
  insertionBarX,
  reorderShifts
} from "./DockTiles";

class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}
if (typeof window.PointerEvent === "undefined") {
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

const TILE_W = 60;
const PITCH = 64;
const LEFT = 100;
const TOP = 10;
const TILE_H = 32;
const DOCK_KEY = "focus-desk.screen.0.dock.v1";

function rect(x: number, y: number, w: number, h: number): DOMRect {
  return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
}

/** 几何桩：按 DOM 兄弟序给磁贴排位；容器 / 岛矩形随磁贴数伸缩。 */
function mockRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const tilesOf = (root: Element) => Array.from(root.children).filter((c) => c.classList.contains("dock-tile"));
    if (this.classList.contains("dock-tile")) {
      const i = this.parentElement ? Math.max(0, tilesOf(this.parentElement).indexOf(this)) : 0;
      return rect(LEFT + i * PITCH, TOP, TILE_W, TILE_H);
    }
    if (this.classList.contains("dock-tiles")) return rect(LEFT, TOP, tilesOf(this).length * PITCH - 4, TILE_H);
    if (this.classList.contains("dock")) {
      const n = this.querySelectorAll(".dock-tile").length;
      return rect(LEFT - 4, TOP - 4, n * PITCH + 4, TILE_H + 8);
    }
    return rect(0, 0, 0, 0);
  });
}

/* 三枚通用磁贴（不在 首批 12 个富形态清单内：无 MiniComponent，渲染同步、
   不拉懒加载 chunk，aria-label 就是类型名，不受 MINI 会话并行登记影响）。 */
const TILES: DockTile[] = [
  { id: "t-a", type: "notes" },
  { id: "t-b", type: "bookmarks" },
  { id: "t-c", type: "sketch" }
];
const NAME_A = "便签";
const NAME_B = "书签";
const NAME_C = "涂鸦板";

function seed(editMode: boolean, tiles: DockTile[] = TILES) {
  localStorage.clear();
  useWidgetStore.setState({
    editMode,
    dockDrag: null,
    dock: { ...useWidgetStore.getState().dock, enabled: true, tiles: tiles.map((t) => ({ ...t })) }
  });
}

const ids = () => useWidgetStore.getState().dock.tiles.map((t) => t.id);
const persistedIds = () => (JSON.parse(localStorage.getItem(DOCK_KEY) ?? "{}").tiles as DockTile[]).map((t) => t.id);

/** 与 DockShell 同构的最小宿主：订阅 tiles，外层 .dock 提供岛矩形。 */
function Harness({ onTileOpen, takeover = false }: { onTileOpen: (t: DockTile) => void; takeover?: boolean }) {
  const tiles = useWidgetStore((s) => s.dock.tiles);
  return (
    <div className="dock">
      <DockTiles tiles={tiles} takeoverActive={takeover} registerTileRef={() => {}} onTileOpen={onTileOpen} />
    </div>
  );
}

/** 按类型名前缀取磁贴按钮（aria-label 可能带「· 摘要」后缀）。 */
const tile = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const ghost = () => document.querySelector<HTMLElement>(".dock-drag-ghost");

describe("让位 / 竖条 / 距离纯函数", () => {
  it("reorderShifts：跨过的磁贴平移一枚，to===from 无位移，outside 时 from 之后全部左移补位", () => {
    expect([...reorderShifts(4, 1, 1, 64, false)]).toEqual([]);
    expect([...reorderShifts(4, 0, 2, 64, false)]).toEqual([
      [1, -64],
      [2, -64]
    ]);
    expect([...reorderShifts(4, 3, 1, 64, false)]).toEqual([
      [1, 64],
      [2, 64]
    ]);
    expect([...reorderShifts(4, 1, 3, 64, true)]).toEqual([
      [2, -64],
      [3, -64]
    ]);
  });

  it("insertionBarX：原位 = 本枚中心；右移 = 被跨过最后一枚右缘回退半宽；左移 = 被跨过第一枚左缘加半宽", () => {
    const rects = [0, 1, 2].map((i) => ({ left: LEFT + i * PITCH, width: TILE_W }));
    expect(insertionBarX(rects, 0, 0)).toBe(130);
    expect(insertionBarX(rects, 0, 2)).toBe(258);
    expect(insertionBarX(rects, 2, 0)).toBe(130);
  });

  it("distanceToRect：矩形内 0、水平 / 垂直 / 对角距离", () => {
    const r = { left: 0, top: 0, right: 100, bottom: 40 };
    expect(distanceToRect(50, 20, r)).toBe(0);
    expect(distanceToRect(148, 20, r)).toBe(48);
    expect(distanceToRect(50, 88, r)).toBe(48);
    expect(distanceToRect(130, 80, r)).toBe(50);
    expect(REMOVE_DISTANCE_PX).toBe(48);
  });
});

describe("DockTiles 岛内交互", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-reduce-motion");
  });
  afterEach(() => {
    document.querySelectorAll(".dock-drag-ghost").forEach((g) => g.remove());
    vi.useRealTimers();
  });

  it("编辑模式：拖第 1 枚到第 3 枚位置 → 其余让位 + 竖条预览，松手顺序变且落盘，紧随的 click 不展开", () => {
    seed(true);
    mockRects();
    const onTileOpen = vi.fn();
    render(<Harness onTileOpen={onTileOpen} />);
    const a = tile(NAME_A);
    fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: 130, clientY: 26 });
    expect(ghost()).toBeNull();
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 140, clientY: 26 });
    expect(ghost()).toBeTruthy();
    expect(a.classList.contains("is-drag-source")).toBe(true);
    expect(useWidgetStore.getState().dockDrag).toMatchObject({ overIsland: true, insertIndex: 0 });

    // others = 书签 [164,224) 中线 194、涂鸦板 [228,288) 中线 258；x=270 → 插到最后
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 270, clientY: 26 });
    expect(useWidgetStore.getState().dockDrag).toMatchObject({
      overIsland: true,
      insertIndex: 2,
      pointer: { x: 270, y: 26 }
    });
    expect(tile(NAME_B).style.transform).toBe("translate3d(-64px, 0, 0)");
    expect(tile(NAME_C).style.transform).toBe("translate3d(-64px, 0, 0)");
    expect(ghost()!.style.transform).toBe("translate3d(140px, 0px, 0) scale(1.04)");
    // 竖条落在空槽中心：insertionBarX = 258，容器原点 100，再减竖条半宽 1
    expect(document.querySelector<HTMLElement>(".dock-insert-bar")!.style.transform).toBe("translate3d(157px, 0, 0)");

    fireEvent.pointerUp(a, { pointerId: 1, clientX: 270, clientY: 26 });
    expect(ids()).toEqual(["t-b", "t-c", "t-a"]);
    expect(persistedIds()).toEqual(["t-b", "t-c", "t-a"]);
    expect(ghost()).toBeNull();
    expect(useWidgetStore.getState().dockDrag).toBeNull();
    expect(a.classList.contains("is-drag-source")).toBe(false);
    expect(document.querySelector(".dock-insert-bar")).toBeNull();

    fireEvent.click(a);
    expect(onTileOpen).not.toHaveBeenCalled();
  });

  it("拖出岛 ≥48px：幽灵拟移除、其余补位，松手移除 + toast「撤销」恢复原位", () => {
    seed(true);
    mockRects();
    render(
      <>
        <Harness onTileOpen={vi.fn()} />
        <ToastHost />
      </>
    );
    const b = tile(NAME_B);
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 190, clientY: 26 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 200, clientY: 26 });
    // 岛矩形 y ∈ [6, 46]；y=120 距底缘 74 ≥ 48 → 拟移除
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 200, clientY: 120 });
    expect(useWidgetStore.getState().dockDrag?.overIsland).toBe(false);
    expect(ghost()!.classList.contains("is-removing")).toBe(true);
    expect(tile(NAME_C).style.transform).toBe("translate3d(-64px, 0, 0)");
    expect(tile(NAME_A).style.transform).toBe("");
    // 距底缘 40 < 48 → 回到岛内语义
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 200, clientY: 86 });
    expect(useWidgetStore.getState().dockDrag?.overIsland).toBe(true);
    expect(ghost()!.classList.contains("is-removing")).toBe(false);
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 200, clientY: 120 });

    fireEvent.pointerUp(b, { pointerId: 1, clientX: 200, clientY: 120 });
    expect(ids()).toEqual(["t-a", "t-c"]);
    expect(persistedIds()).toEqual(["t-a", "t-c"]);
    expect(screen.getByText("已从灵动岛移除")).toBeTruthy();
    expect(within(document.querySelector<HTMLElement>(".app-toast-stack")!).getByText(NAME_B)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "撤销" }).at(-1)!);
    expect(ids()).toEqual(["t-a", "t-b", "t-c"]);
    expect(persistedIds()).toEqual(["t-a", "t-b", "t-c"]);
    // 恢复的磁贴播入场动画
    expect(tile(NAME_B).classList.contains("is-growing")).toBe(true);
  });

  it("非编辑模式：长按 300ms 起拖且不展开；普通单击仍展开；长按前移动 >10px 取消长按", () => {
    vi.useFakeTimers();
    seed(false);
    mockRects();
    const onTileOpen = vi.fn();
    render(<Harness onTileOpen={onTileOpen} />);
    const a = tile(NAME_A);
    fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: 130, clientY: 26 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    });
    expect(ghost()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(ghost()).toBeTruthy();
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 270, clientY: 26 });
    fireEvent.pointerUp(a, { pointerId: 1, clientX: 270, clientY: 26 });
    fireEvent.click(a);
    expect(onTileOpen).not.toHaveBeenCalled();
    expect(ids()).toEqual(["t-b", "t-c", "t-a"]);

    // 普通单击（未到 300ms 即松手）→ 放行 DockTile 的 onClick 展开
    const b = tile(NAME_B);
    fireEvent.pointerDown(b, { button: 0, pointerId: 2, clientX: 190, clientY: 26 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerUp(b, { pointerId: 2, clientX: 190, clientY: 26 });
    fireEvent.click(b);
    expect(onTileOpen).toHaveBeenCalledTimes(1);
    expect(onTileOpen.mock.calls[0][0].id).toBe("t-b");
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(ghost()).toBeNull();

    // 长按等待期内移动 >10px：取消长按，不起拖
    fireEvent.pointerDown(b, { button: 0, pointerId: 3, clientX: 190, clientY: 26 });
    fireEvent.pointerMove(b, { pointerId: 3, clientX: 210, clientY: 26 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    });
    expect(ghost()).toBeNull();
    fireEvent.pointerUp(b, { pointerId: 3, clientX: 210, clientY: 26 });
    expect(ids()).toEqual(["t-b", "t-c", "t-a"]);
  });

  it("拖动中 Esc 原位放回：顺序不变、幽灵与让位清空、dockDrag 归零", () => {
    seed(true);
    mockRects();
    render(<Harness onTileOpen={vi.fn()} />);
    const a = tile(NAME_A);
    fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: 130, clientY: 26 });
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 270, clientY: 26 });
    expect(tile(NAME_B).style.transform).toBe("translate3d(-64px, 0, 0)");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ghost()).toBeNull();
    expect(useWidgetStore.getState().dockDrag).toBeNull();
    expect(ids()).toEqual(["t-a", "t-b", "t-c"]);
    expect(tile(NAME_B).style.transform).toBe("");
    // 松手不再提交
    fireEvent.pointerUp(a, { pointerId: 1, clientX: 270, clientY: 26 });
    expect(ids()).toEqual(["t-a", "t-b", "t-c"]);
  });

  it("data-reduce-motion：让位瞬移（transition none）、FLIP 直接落位", () => {
    document.documentElement.setAttribute("data-reduce-motion", "1");
    seed(true);
    mockRects();
    render(<Harness onTileOpen={vi.fn()} />);
    const a = tile(NAME_A);
    fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: 130, clientY: 26 });
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 270, clientY: 26 });
    expect(tile(NAME_B).style.transition).toBe("none");
    fireEvent.pointerUp(a, { pointerId: 1, clientX: 270, clientY: 26 });
    expect(ids()).toEqual(["t-b", "t-c", "t-a"]);
    expect(a.style.transform).toBe("");
  });

  it("键盘：←/→ 移焦点，Ctrl+→ 移位并落盘（焦点跟随），Delete 移除可撤销；消费的按键不冒泡到 window", () => {
    seed(true);
    mockRects();
    render(
      <>
        <Harness onTileOpen={vi.fn()} />
        <ToastHost />
      </>
    );
    // 编辑模式下 WidgetCard 在 window 上监听 ←/→/Delete 操作画布选中卡片：岛内消费后不得到达。
    const windowKey = vi.fn();
    window.addEventListener("keydown", windowKey);
    const a = tile(NAME_A);
    const b = tile(NAME_B);
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "End" });
    expect(document.activeElement).toBe(tile("添加磁贴"));
    b.focus();

    fireEvent.keyDown(b, { key: "ArrowRight", ctrlKey: true });
    expect(ids()).toEqual(["t-a", "t-c", "t-b"]);
    expect(persistedIds()).toEqual(["t-a", "t-c", "t-b"]);
    expect(document.activeElement).toBe(b);
    // 已在末位再按 Ctrl+→ 无变化
    fireEvent.keyDown(b, { key: "ArrowRight", ctrlKey: true });
    expect(ids()).toEqual(["t-a", "t-c", "t-b"]);
    fireEvent.keyDown(b, { key: "ArrowLeft", ctrlKey: true });
    expect(ids()).toEqual(["t-a", "t-b", "t-c"]);

    fireEvent.keyDown(b, { key: "Delete" });
    expect(ids()).toEqual(["t-a", "t-c"]);
    expect(persistedIds()).toEqual(["t-a", "t-c"]);
    expect(windowKey).not.toHaveBeenCalled();
    // 未消费的键（Enter 走按钮原生点击展开）照常冒泡
    fireEvent.keyDown(a, { key: "Enter" });
    expect(windowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", windowKey);

    fireEvent.click(screen.getAllByRole("button", { name: "撤销" }).at(-1)!);
    expect(ids()).toEqual(["t-a", "t-b", "t-c"]);
  });

  it("P0-6：Ctrl+Shift+←/→ 让位冒泡（DockShell 吸附点快捷键），不触发磁贴排序", () => {
    seed(true);
    mockRects();
    render(
      <>
        <Harness onTileOpen={vi.fn()} />
        <ToastHost />
      </>
    );
    const a = tile(NAME_A);
    a.focus();
    const windowKey = vi.fn();
    window.addEventListener("keydown", windowKey);
    // 修复前：箭头分支无条件 consume()（stopPropagation），Ctrl+Shift 被当
    // Ctrl+← 执行排序且 Shell 的 onDockKeyDown 永远收不到。
    fireEvent.keyDown(a, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(ids()).toEqual(["t-a", "t-b", "t-c"]); // 未排序
    expect(windowKey).toHaveBeenCalledTimes(1); // 已冒泡出磁贴层
    // 纯 Shift+方向无 Shell 语义：仍走本层焦点移动（不冒泡）。
    fireEvent.keyDown(a, { key: "ArrowRight", shiftKey: true });
    expect(document.activeElement).toBe(tile(NAME_B));
    expect(windowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", windowKey);
  });

  it("「+」只在编辑模式显示；选「计算器」→ 追加通用磁贴并关闭弹层", async () => {
    seed(false);
    mockRects();
    render(<Harness onTileOpen={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "添加磁贴" })).toBeNull();
    act(() => useWidgetStore.getState().setEditMode(true));
    const add = tile("添加磁贴");
    expect(add.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(add);
    const dialog = await screen.findByRole("dialog", { name: "添加到灵动岛" });
    expect(add.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: /^计算器/ }));
    const tiles = useWidgetStore.getState().dock.tiles;
    expect(tiles).toHaveLength(4);
    expect(tiles[3].type).toBe("calculator");
    expect(tiles[3].id).not.toBe("");
    expect(persistedIds()).toEqual(tiles.map((t) => t.id));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const added = tile("计算器");
    expect(added.classList.contains("is-generic")).toBe(true);
    expect(added.classList.contains("is-growing")).toBe(true);
    // 退出编辑模式：「+」消失
    act(() => useWidgetStore.getState().setEditMode(false));
    expect(screen.queryByRole("button", { name: "添加磁贴" })).toBeNull();
  });

  it("接管期间不起拖；>8 枚进入横向可滚模式", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, type: "notes" }));
    seed(true, many);
    mockRects();
    const { container, rerender } = render(<Harness onTileOpen={vi.fn()} takeover />);
    const layer = container.querySelector(".dock-tiles")!;
    expect(layer.classList.contains("is-overflow")).toBe(true);
    const first = screen.getAllByRole("button", { name: /^便签/, hidden: true })[0];
    fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 130, clientY: 26 });
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 200, clientY: 26 });
    expect(ghost()).toBeNull();
    fireEvent.pointerUp(first, { pointerId: 1, clientX: 200, clientY: 26 });

    rerender(<Harness onTileOpen={vi.fn()} />);
    act(() => useWidgetStore.getState().removeDockTile("m8"));
    expect(layer.classList.contains("is-overflow")).toBe(false);
  });
});
