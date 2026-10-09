/**
 * ISLAND-DROP 组件测试：画布卡片拖入灵动岛（入口 a，默认复制 / Alt 移动）
 * + 图库「添加到灵动岛」入口。
 *
 * 岛 DOM 用契约类名（.dock / .dock-tiles > .dock-tile）的假节点，不依赖并行会话
 * 在飞的 DockShell / DockTiles 实现；几何靠逐元素桩掉 getBoundingClientRect。
 * 拖动走真实 WidgetCard 的 pointer 事件链（pointerdown → rAF 节流 pointermove →
 * pointerup），断言落在 widget-store 的 dock.tiles / instances / trash / dockDrag。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ToastHost } from "../../components/ToastHost";
import { WidgetCard } from "../WidgetCard";
import { WidgetGallery } from "../WidgetGallery";
import { DEFAULT_DOCK, useWidgetStore } from "../widget-store";
import { HIT_RECTS_DIRTY_EVENT } from "../useClickThrough";
import {
  DROP_HIT_MARGIN,
  DockDropZone,
  insertionBarX,
  readDropCache,
  resolveDrop,
  type DropCache
} from "./DockDropZone";

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
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
});

/* ---- 几何桩：岛 300×40 @ (800,10)，两枚磁贴各 100 宽 @ 806 / 910 ---- */
const ISLAND = { left: 800, top: 10, width: 300, height: 40 };
const TILE_RECTS = [
  { left: 806, top: 14, width: 100, height: 32 },
  { left: 910, top: 14, width: 100, height: 32 }
];
const CARD = { id: "card-1", type: "todo", x: 100, y: 400, w: 300, h: 200, z: 1 };

function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: r.left,
      y: r.top,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      toJSON: () => ({})
    }) as DOMRect;
}

function Island() {
  return (
    <div className="dock" data-testid="island">
      <div className="dock-tiles">
        <button className="dock-tile dock-tile-clock" type="button" />
        <button className="dock-tile dock-tile-pomodoro" type="button" />
      </div>
    </div>
  );
}

function seedStore() {
  useWidgetStore.setState({
    editMode: true,
    instances: [{ ...CARD }],
    trash: [],
    selectedId: null,
    selectedIds: [],
    dragPreview: {},
    resizePreview: null,
    alignGuides: { xs: [], ys: [] },
    dockDrag: null,
    exitingIds: [],
    enteringIds: [],
    pulseIds: [],
    dock: {
      ...DEFAULT_DOCK,
      enabled: true,
      tiles: [
        { id: "t-clock", type: "clock" },
        { id: "t-pomodoro", type: "pomodoro" }
      ]
    }
  });
}

function mountScene() {
  const utils = render(
    <>
      <Island />
      <DockDropZone />
      <WidgetCard id={CARD.id} type={CARD.type} x={CARD.x} y={CARD.y} w={CARD.w} h={CARD.h} z={CARD.z} />
      <ToastHost />
    </>
  );
  const island = screen.getByTestId("island");
  stubRect(island, ISLAND);
  island.querySelectorAll(".dock-tile").forEach((el, i) => stubRect(el, TILE_RECTS[i]));
  const card = utils.container.querySelector(".widget-card") as HTMLDivElement;
  return { ...utils, card };
}

/** 让 rAF 桩（16ms）跑完并冲刷 React 更新。 */
const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

type PointerKind = "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel";
function pointer(el: Element, type: PointerKind, x: number, y: number, extra: Record<string, unknown> = {}) {
  fireEvent[type](el, { pointerId: 1, button: 0, clientX: x, clientY: y, ...extra });
}

/** 从卡片 (150,450) 抓起，拖到岛内 (950,30)——落在第 1、2 枚磁贴之间（insertIndex 1）。 */
async function dragCardOverIsland(card: Element) {
  pointer(card, "pointerDown", 150, 450);
  // 三轮拖拽阈值：按下不再立即升级拖拽会话，位移过 3px 死区才托起。
  expect(card.classList.contains("dragging")).toBe(false);
  pointer(card, "pointerMove", 950, 30);
  await frame();
  expect(card.classList.contains("dragging")).toBe(true);
}

beforeEach(() => {
  localStorage.clear();
  seedStore();
});
afterEach(() => {
  cleanup();
  useWidgetStore.getState().clearDockDrag();
});

/* ================================================================== */

describe("DockDropZone 几何纯函数", () => {
  const cache: DropCache = {
    island: ISLAND,
    hit: {
      left: ISLAND.left - DROP_HIT_MARGIN,
      top: ISLAND.top - DROP_HIT_MARGIN,
      right: ISLAND.left + ISLAND.width + DROP_HIT_MARGIN,
      bottom: ISLAND.top + ISLAND.height + DROP_HIT_MARGIN
    },
    tiles: TILE_RECTS.map((r) => ({ left: r.left, width: r.width })),
    type: "todo"
  };

  it("resolveDrop：外扩 24px 内命中，按磁贴中线求插入位；岛外 overIsland=false 且 insertIndex 归 0", () => {
    expect(resolveDrop(cache, { x: 820, y: 30 })).toEqual({ overIsland: true, insertIndex: 0 });
    expect(resolveDrop(cache, { x: 950, y: 30 })).toEqual({ overIsland: true, insertIndex: 1 });
    expect(resolveDrop(cache, { x: 1090, y: 30 })).toEqual({ overIsland: true, insertIndex: 2 });
    // 外扩边界：岛底 50 + 24 = 74 仍命中，75 不命中
    expect(resolveDrop(cache, { x: 950, y: 74 }).overIsland).toBe(true);
    expect(resolveDrop(cache, { x: 950, y: 75 })).toEqual({ overIsland: false, insertIndex: 0 });
    expect(resolveDrop(cache, { x: 775, y: 30 }).overIsland).toBe(false);
  });

  it("insertionBarX：落在相邻磁贴间隙中线；末位取最后一枚右侧；空岛取岛中心", () => {
    expect(insertionBarX(cache, 0)).toBe(806 - 2);
    expect(insertionBarX(cache, 1)).toBe(910 - 2);
    expect(insertionBarX(cache, 2)).toBe(910 + 100 + 2);
    expect(insertionBarX({ ...cache, tiles: [] }, 0)).toBe(800 + 150);
  });

  it("readDropCache：无 .widget-card.dragging（岛内排序等其他写方）或无 .dock（岛未启用）→ null", () => {
    const { container } = render(<Island />);
    stubRect(screen.getByTestId("island"), ISLAND);
    expect(readDropCache()).toBeNull(); // 没有正在拖的画布卡片

    const card = document.createElement("div");
    card.className = "widget-card dragging";
    card.setAttribute("data-widget-type", "weather");
    document.body.appendChild(card);
    const c = readDropCache();
    expect(c).not.toBeNull();
    expect(c!.type).toBe("weather");
    expect(c!.tiles).toHaveLength(2);
    expect(c!.hit).toEqual({ left: 776, top: -14, right: 1124, bottom: 74 });

    container.remove();
    expect(readDropCache()).toBeNull(); // 岛 DOM 消失
    card.remove();
  });
});

describe("画布卡片拖入灵动岛（WidgetCard × DockDropZone）", () => {
  it("拖到岛矩形内：同步回写 overIsland / insertIndex，出现高亮、插入竖条与幽灵芯片", async () => {
    const { card } = mountScene();
    await dragCardOverIsland(card);

    const dd = useWidgetStore.getState().dockDrag;
    expect(dd).toEqual({ pointer: { x: 950, y: 30 }, overIsland: true, insertIndex: 1 });
    const overlay = screen.getByTestId("dock-drop");
    expect(overlay.querySelector(".dock-drop-ring")).toBeTruthy();
    expect(overlay.querySelector(".dock-drop-bar")?.getAttribute("data-insert-index")).toBe("1");
    const ghost = overlay.querySelector(".dock-drop-ghost") as HTMLElement;
    expect(ghost.textContent).toContain("待办清单");
    expect(ghost.textContent).toContain("松手添加 · Alt 移动");
    expect(ghost.style.transform).toContain("scale(1.04)");

    // 指针离开命中区 → 预览清除、插入位归 0；普通拖拽继续（位移直写
    // --drag-dx/--drag-dy CSS 变量，.dragging 的 transform 组合消费它，
    // dragPreview 只在 pointerup 时写入一次供 commitDragMove 消费）
    pointer(card, "pointerMove", 300, 500);
    await frame();
    expect(useWidgetStore.getState().dockDrag).toEqual({
      pointer: { x: 300, y: 500 },
      overIsland: false,
      insertIndex: 0
    });
    expect(screen.queryByTestId("dock-drop")).toBeNull();
    expect(useWidgetStore.getState().dragPreview[CARD.id]).toBeUndefined();
    const draggingStyle = (document.querySelector(`[data-widget-id="${CARD.id}"]`) as HTMLElement).style;
    expect(draggingStyle.getPropertyValue("--drag-dx")).not.toBe("");
    expect(draggingStyle.getPropertyValue("--drag-dy")).not.toBe("");

    pointer(card, "pointerUp", 300, 500);
  });

  it("松手命中岛（D1 默认复制）：tiles +1 绑定本实例、卡片位置不变、不提交拖拽、播回弹", async () => {
    const { card } = mountScene();
    await dragCardOverIsland(card);
    pointer(card, "pointerUp", 950, 30);

    const st = useWidgetStore.getState();
    expect(st.dock.tiles.map((t) => t.type)).toEqual(["clock", "todo", "pomodoro"]);
    const added = st.dock.tiles[1];
    expect(added.instanceId).toBe(CARD.id);
    expect(added.id).not.toBe("");
    // 卡片留在原位，位移未提交，瞬态全部清空
    const inst = st.instances.find((i) => i.id === CARD.id)!;
    expect([inst.x, inst.y]).toEqual([CARD.x, CARD.y]);
    expect(st.dragPreview).toEqual({});
    expect(st.alignGuides).toEqual({ xs: [], ys: [] });
    expect(st.dockDrag).toBeNull();
    expect(st.trash).toHaveLength(0);
    expect(screen.queryByTestId("dock-drop")).toBeNull();
    // 160ms 回弹类挂上，220ms 后摘掉；不是移动语义 → 无 toast
    expect(card.classList.contains("dock-drop-back")).toBe(true);
    expect(card.classList.contains("dragging")).toBe(false);
    expect(screen.queryByText("已移入灵动岛")).toBeNull();
    await sleep(260);
    expect(card.classList.contains("dock-drop-back")).toBe(false);
    // 落盘：dock 配置已写 localStorage
    const saved = Object.keys(localStorage).find((k) => k.includes("dock"));
    expect(saved).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(saved!)!).tiles).toHaveLength(3);
  });

  it("拖到岛外松手：无磁贴变化，走原 commitDragMove 提交位移", async () => {
    const { card } = mountScene();
    pointer(card, "pointerDown", 150, 450);
    pointer(card, "pointerMove", 300, 500);
    await frame();
    expect(useWidgetStore.getState().dockDrag?.overIsland).toBe(false);
    pointer(card, "pointerUp", 300, 500);

    const st = useWidgetStore.getState();
    expect(st.dock.tiles).toHaveLength(2);
    const inst = st.instances.find((i) => i.id === CARD.id)!;
    expect(inst.x).toBeGreaterThan(CARD.x);
    expect(inst.y).toBeGreaterThan(CARD.y);
    expect(st.dragPreview).toEqual({});
    expect(st.dockDrag).toBeNull();
    expect(card.classList.contains("dock-drop-back")).toBe(false);
  });

  it("入岛去重（I-09）：本实例已绑定磁贴时再拖入 → 不加不删，toast「已在灵动岛」，卡片回弹留在画布", async () => {
    /* 岛上已有一枚绑定 CARD.id 的 todo 磁贴（画布卡片此前拖入过）。 */
    useWidgetStore.setState((s) => ({
      dock: { ...s.dock, tiles: [...s.dock.tiles, { id: "t-todo-bound", type: "todo", instanceId: CARD.id }] }
    }));
    const { card } = mountScene();
    await dragCardOverIsland(card);
    pointer(card, "pointerUp", 950, 30);

    const st = useWidgetStore.getState();
    expect(st.dock.tiles.map((t) => t.id)).toEqual(["t-clock", "t-pomodoro", "t-todo-bound"]);
    expect(st.instances.find((i) => i.id === CARD.id)).toBeTruthy(); // Alt 语义也不会触发移除
    expect(st.trash).toHaveLength(0);
    expect(st.dockDrag).toBeNull();
    expect(card.classList.contains("dock-drop-back")).toBe(true);
    expect(screen.getByText("已在灵动岛")).toBeTruthy();
  });

  it("岛内 pointercancel（Alt-Tab / 系统手势接管）不视为投放：无磁贴变化，瞬态清空", async () => {
    const { card } = mountScene();
    await dragCardOverIsland(card);
    pointer(card, "pointerCancel", 950, 30);

    const st = useWidgetStore.getState();
    expect(st.dock.tiles).toHaveLength(2);
    expect(st.dockDrag).toBeNull();
    expect(st.dragPreview).toEqual({});
    expect(screen.queryByTestId("dock-drop")).toBeNull();
  });

  it("其他写方（岛内排序）写 dockDrag 且无画布卡片在拖：不回写、不渲染", async () => {
    mountScene();
    act(() => {
      useWidgetStore.getState().setDockDrag({ pointer: { x: 950, y: 30 }, overIsland: false, insertIndex: 7 });
    });
    await frame();
    expect(useWidgetStore.getState().dockDrag).toEqual({
      pointer: { x: 950, y: 30 },
      overIsland: false,
      insertIndex: 7
    });
    expect(screen.queryByTestId("dock-drop")).toBeNull();
  });

  it("Alt 松手（移动语义）：tiles +1，实例走退场进回收站，toast「已移入灵动岛 · 撤销」可撤销", async () => {
    const { card } = mountScene();
    await dragCardOverIsland(card);
    pointer(card, "pointerUp", 950, 30, { altKey: true });

    let st = useWidgetStore.getState();
    expect(st.dock.tiles.map((t) => t.type)).toEqual(["clock", "todo", "pomodoro"]);
    const tileId = st.dock.tiles[1].id;
    expect(st.dockDrag).toBeNull();
    expect(st.dragPreview).toEqual({});
    // 退场中：还在画布上、带 is-exiting；不播回弹
    expect(st.exitingIds).toContain(CARD.id);
    expect(card.classList.contains("dock-drop-back")).toBe(false);
    // toast 带撤销
    expect(screen.getByText("已移入灵动岛")).toBeTruthy();
    const undo = screen.getByRole("button", { name: "撤销" });

    await sleep(260);
    st = useWidgetStore.getState();
    expect(st.instances.find((i) => i.id === CARD.id)).toBeUndefined();
    const trashed = st.trash.find((t) => t.id === CARD.id)!;
    expect(trashed).toBeTruthy();
    expect([trashed.x, trashed.y]).toEqual([CARD.x, CARD.y]); // 未提交拖拽位移

    fireEvent.click(undo);
    st = useWidgetStore.getState();
    expect(st.instances.find((i) => i.id === CARD.id)).toBeTruthy();
    expect(st.trash.find((t) => t.id === CARD.id)).toBeUndefined();
    expect(st.dock.tiles.some((t) => t.id === tileId)).toBe(false);
    expect(st.dock.tiles.map((t) => t.type)).toEqual(["clock", "pomodoro"]);
  });

  it("拖动中岛几何变化（收合→弹出过渡结束派发 HIT_RECTS_DIRTY_EVENT）→ 会话缓存重读，命中按新几何判定", async () => {
    const { card } = mountScene();
    // 起拖：指针在岛外，会话缓存采到 ISLAND 几何（模拟收合态起拖的陈旧快照）。
    pointer(card, "pointerDown", 150, 450);
    pointer(card, "pointerMove", 300, 500);
    await frame();
    expect(useWidgetStore.getState().dockDrag?.overIsland).toBe(false);

    // 岛「滑到」新位置（屏左上角 300×40），指针随后移进新范围——缓存不重读就永不命中。
    const island = screen.getByTestId("island");
    stubRect(island, { left: 0, top: 0, width: 300, height: 40 });
    island.querySelectorAll(".dock-tile").forEach((el, i) =>
      stubRect(
        el,
        [
          { left: 6, top: 4, width: 100, height: 32 },
          { left: 110, top: 4, width: 100, height: 32 }
        ][i]
      )
    );
    pointer(card, "pointerMove", 150, 20);
    await frame();
    expect(useWidgetStore.getState().dockDrag?.overIsland).toBe(false); // 旧缓存：未命中

    // DockShell 在收合/弹出/吸附过渡结束派发本事件（此处直接模拟）。
    act(() => {
      window.dispatchEvent(new CustomEvent(HIT_RECTS_DIRTY_EVENT));
    });
    expect(useWidgetStore.getState().dockDrag).toMatchObject({ overIsland: true, insertIndex: 1 });

    pointer(card, "pointerUp", 150, 20);
    expect(useWidgetStore.getState().dock.tiles.map((t) => t.type)).toEqual(["clock", "todo", "pomodoro"]);
  });

  it("松手与最后一次移动同帧（快速甩动）：最终指针补写后仍按松手位置判定投放", () => {
    const { card } = mountScene();
    // 抓起 → 位移直接进岛 → 同帧松手，不等 rAF（旧实现 overIsland 停在上一帧甚至为空）。
    pointer(card, "pointerDown", 150, 450);
    pointer(card, "pointerMove", 950, 30);
    pointer(card, "pointerUp", 950, 30);

    const st = useWidgetStore.getState();
    expect(st.dockDrag).toBeNull();
    expect(st.dock.tiles.map((t) => t.type)).toEqual(["clock", "todo", "pomodoro"]);
    expect(st.dock.tiles[1].instanceId).toBe(CARD.id);
    // 投放语义不提交拖拽位移：卡片留在原位。
    expect(st.instances.find((i) => i.id === CARD.id)).toMatchObject({ x: CARD.x, y: CARD.y });
    expect(st.dragPreview).toEqual({});
  });
});

describe("图库入口「添加到灵动岛」（卡片悬停「岛」钮）", () => {
  const cardByName = (name: string) =>
    screen.getByText(name, { selector: ".widget-gallery-card-name" }).closest('[role="button"]') as HTMLElement;

  it("未入岛类型可添加（无实例磁贴、追加末尾）；已在岛上的类型显示禁用态「已在灵动岛」", () => {
    render(<WidgetGallery onClose={() => {}} />);

    // 时钟磁贴已在岛上：卡片「岛」钮呈禁用态（每张卡各一枚，用 within 限定）
    const disabled = within(cardByName("时钟")).getByRole("button", { name: "已在灵动岛" }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);

    const add = within(cardByName("天气")).getByRole("button", { name: "添加到灵动岛" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);

    const tiles = useWidgetStore.getState().dock.tiles;
    expect(tiles.map((t) => t.type)).toEqual(["clock", "pomodoro", "weather"]);
    expect(tiles[2].instanceId).toBeUndefined();
    // 同类型第二次：按钮即刻翻成禁用态
    expect((within(cardByName("天气")).getByRole("button", { name: "已在灵动岛" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    // 入岛不加画布实例
    expect(useWidgetStore.getState().instances).toHaveLength(1);
  });

  it("单击卡片即入画布并打勾反馈；图库保持打开可连续添加", () => {
    const onClose = vi.fn();
    render(<WidgetGallery onClose={onClose} />);

    fireEvent.click(cardByName("天气"));
    expect(useWidgetStore.getState().instances.map((i) => i.type)).toEqual(["todo", "weather"]);
    expect(cardByName("天气").className).toContain("just-added");
    // 图库不自动关闭（旧版双击添加即关）：连续添加，退出走遮罩 / 返回 / Esc
    expect(screen.getByText("专注", { selector: ".widget-gallery-cat-label" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
