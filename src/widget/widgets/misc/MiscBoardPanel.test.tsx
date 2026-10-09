/**
 * 「杂项」面板组件测试（registry 用假表：时钟 2×2、待办 1×1、杂项自身）：
 *  - 空态提示；「+」打开类型选择器，挑类型 → 按 gridSizeFor 占格放进第一个空位并写入
 *    tile.config.items（setDockTileConfig → store）；「杂项」自身在选择器里禁用；
 *  - 条目按格位算 px 内联定位（jsdom 量不到宽度 → 回退 160px/格）；
 *  - 拖把手条：拖动中出现占位框与 is-dragging，松手按吸附格定稿、被压住的条目下推，
 *    并做 FLIP 落格（行内过渡只挂 transform 的 dockQ 弹簧，结束清内联）；落格未完
 *    再次抓起会取消挂起的 FLIP（行内过渡清空，不拖影）。
 *  - × 移除后其余条目压实。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("../../registry", async () => {
  const React = await import("react");
  const { Circle } = await import("lucide-react");
  type Meta = {
    type: string;
    name: string;
    desc: string;
    category: "focus" | "tools" | "system" | "online";
    icon: typeof Circle;
    defaultSize: { w: number; h: number };
    minSize: { w: number; h: number };
    component: ComponentType<{ instanceId: string }>;
    dockOnly?: boolean;
  };
  const Full = ({ instanceId }: { instanceId: string }) =>
    React.createElement("div", { "data-testid": "misc-full", "data-instance": instanceId }, instanceId);
  const METAS: Record<string, Meta> = {
    clock: {
      type: "clock",
      name: "时钟",
      desc: "时钟",
      category: "tools",
      icon: Circle,
      defaultSize: { w: 320, h: 200 },
      minSize: { w: 200, h: 140 },
      component: Full
    },
    todo: {
      type: "todo",
      name: "待办",
      desc: "待办",
      category: "tools",
      icon: Circle,
      defaultSize: { w: 160, h: 100 },
      minSize: { w: 120, h: 80 },
      component: Full
    },
    misc: {
      type: "misc",
      name: "杂项",
      desc: "杂项",
      category: "tools",
      icon: Circle,
      defaultSize: { w: 320, h: 200 },
      minSize: { w: 200, h: 140 },
      component: Full,
      dockOnly: true
    }
  };
  const names = { focus: "专注", tools: "工具", system: "系统", online: "在线" };
  return {
    getWidgetMeta: (type: string): Meta | undefined => METAS[type],
    WIDGET_REGISTRY: Object.values(METAS),
    CATEGORY_NAMES: names,
    useCategoryNames: () => names
  };
});

import { MiscBoardPanel } from "./MiscBoardPanel";
import { useWidgetStore, type DockTile } from "../../widget-store";
import type { MiscItem } from "./misc-layout";

const TILE_ID = "t-misc";
const tileItems = () =>
  (
    (useWidgetStore.getState().dock.tiles.find((t) => t.id === TILE_ID)?.config?.items as MiscItem[] | undefined) ?? []
  ).map((i) => ({ type: i.type, x: i.x, y: i.y, w: i.w, h: i.h }));

/** 面板读 tile prop：这里从 store 取最新的 tile 传下去（真实场景由 DockShell 传）。 */
function Harness() {
  const tile = useWidgetStore((s) => s.dock.tiles.find((t) => t.id === TILE_ID)) as DockTile;
  return <MiscBoardPanel tile={tile} active />;
}

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
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
  if (typeof window.requestAnimationFrame !== "function") {
    window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
  }
});

const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
const item = (type: string) => document.querySelector<HTMLElement>(`.misc-item[data-item-type="${type}"]`)!;
const px = (v: string) => Number.parseFloat(v);

function seed(items: MiscItem[]) {
  const d = useWidgetStore.getState().dock;
  useWidgetStore.setState({
    dock: { ...d, enabled: true, tiles: [{ id: TILE_ID, type: "misc", config: { items } }] }
  });
}

describe("MiscBoardPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    seed([]);
  });

  it("空态提示；「+」挑类型 → 按默认尺寸占格放进第一个空位并写入 tile.config.items；「杂项」自身禁用", async () => {
    render(<Harness />);
    expect(screen.getByText("这里还没有小组件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加小组件" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^杂项/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: /^时钟/ }));
    expect(tileItems()).toEqual([{ type: "clock", x: 0, y: 0, w: 2, h: 2 }]);
    expect(screen.queryByText("这里还没有小组件")).toBeNull();
    // 再加一枚 1×1 的待办：落到第一行右侧空位 (2,0)。
    fireEvent.click(screen.getByRole("button", { name: "添加小组件" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^待办/ }));
    expect(tileItems()).toEqual([
      { type: "clock", x: 0, y: 0, w: 2, h: 2 },
      { type: "todo", x: 2, y: 0, w: 1, h: 1 }
    ]);
    // 内嵌小组件 instanceId = <tileId>:<itemId>，两枚各自独立。
    const instances = Array.from(document.querySelectorAll("[data-testid='misc-full']")).map((e) =>
      e.getAttribute("data-instance")
    );
    expect(instances).toHaveLength(2);
    expect(instances.every((s) => s?.startsWith(`${TILE_ID}:`))).toBe(true);
  });

  it("条目按格位内联定位（回退 160px/格、行高 104、间距 10）", () => {
    seed([
      { id: "a", type: "clock", x: 0, y: 0, w: 2, h: 2 },
      { id: "b", type: "todo", x: 2, y: 0, w: 1, h: 1 }
    ]);
    render(<Harness />);
    const a = item("clock").style;
    expect([px(a.left), px(a.top), px(a.width), px(a.height)]).toEqual([0, 0, 330, 218]);
    const b = item("todo").style;
    expect([px(b.left), px(b.top), px(b.width), px(b.height)]).toEqual([340, 0, 160, 104]);
  });

  it("拖把手条到被占的格：拖动中有占位框，松手吸附定稿、原占位者下推并落盘；× 移除后压实", async () => {
    seed([
      { id: "a", type: "clock", x: 0, y: 0, w: 2, h: 2 },
      { id: "b", type: "todo", x: 2, y: 0, w: 1, h: 1 }
    ]);
    render(<Harness />);
    const bar = item("todo").querySelector<HTMLElement>(".misc-item-bar")!;
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 400, clientY: 10 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 60, clientY: 10 }); // dx = -340 → 格 (0,0)
    await frame();
    expect(item("todo").classList.contains("is-dragging")).toBe(true);
    const ph = document.querySelector<HTMLElement>(".misc-placeholder")!;
    expect(ph).toBeTruthy();
    expect([px(ph.style.left), px(ph.style.top)]).toEqual([0, 0]);
    // 预演：时钟被推到第 2 行（top = 104 + 10）。
    expect(px(item("clock").style.top)).toBe(114);
    // 拖动中的条目跟手（transform 平移），不吸格。
    expect(item("todo").style.transform).toBe("translate(-340px, 0px)");

    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 60, clientY: 10 });
    expect(document.querySelector(".misc-placeholder")).toBeNull();
    expect(tileItems()).toEqual([
      { type: "clock", x: 0, y: 1, w: 2, h: 2 },
      { type: "todo", x: 0, y: 0, w: 1, h: 1 }
    ]);
    // 松手落格 FLIP：条目置顶层，行内过渡只挂 transform（dockQ 弹簧）+ 拖动投影淡出，
    // 静止 transform 为 0——「弹一下」由 --ease-dock-spring 的过冲负责。
    const dropped = item("todo");
    expect(dropped.style.zIndex).toBe("5");
    expect(dropped.style.transition).toContain("transform 450ms var(--ease-dock-spring)");
    expect(dropped.style.transition).toContain("box-shadow var(--dur-fx) var(--ease-fx)");
    expect(dropped.style.transform).toBe("translate(0px, 0px)");
    const ended = new Event("transitionend");
    Object.defineProperty(ended, "propertyName", { value: "transform" });
    dropped.dispatchEvent(ended);
    expect(dropped.style.transition).toBe("");
    expect(dropped.style.transform).toBe("");
    expect(dropped.style.zIndex).toBe("");

    // 落格未完再次抓起：行内 transition 必须先清——否则压过 is-dragging 的
    // transition:none，条目会拖着 450ms 弹簧跟手。
    fireEvent.pointerDown(dropped.querySelector<HTMLElement>(".misc-item-bar")!, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    expect(item("todo").classList.contains("is-dragging")).toBe(true);
    expect(item("todo").style.transition).toBe("");
    fireEvent.pointerCancel(item("todo").querySelector<HTMLElement>(".misc-item-bar")!, { pointerId: 1 });
    expect(item("todo").classList.contains("is-dragging")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "移除 待办" }));
    expect(tileItems()).toEqual([{ type: "clock", x: 0, y: 0, w: 2, h: 2 }]);
  });
});

/* ---- 单磁贴展开的滚动高度链（防漂移契约）----
   jsdom 不做布局，无法直接断言滚动行为；杂项板「放多了滚轮滚不动、只能放大
   面板」的根因是百分比高度链在 .dock-expand-surface 断成 auto（见
   feature-dock.css 该规则注释）。这里锁住链条的三个关键环节，任一被改回
   auto / 移除 overflow 即红。 */
describe("MiscBoardPanel · 展开面板滚动高度链（CSS 契约）", () => {
  const ruleOf = (css: string, sel: string): string => {
    const m = css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return m?.[1] ?? "";
  };
  const readCss = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it(".dock-expand-surface 铺满高度 → .widget-error-host / .dock-panel 的 100% 能逐级解析", () => {
    const dock = readCss("../../../styles/feature-dock.css");
    const surface = ruleOf(dock, ".dock-expand-surface");
    expect(surface).toContain("height: 100%");
    expect(surface).toContain("min-height: 0");
    const panel = ruleOf(dock, ".dock-panel");
    expect(panel).toContain("height: 100%");
    const widget = readCss("../../../styles/widget.css");
    expect(ruleOf(widget, ".widget-error-host")).toContain("height: 100%");
  });

  it(".misc-scroll 保持可滚（flex:1 + min-height:0 + overflow-y:auto）", () => {
    const dock = readCss("../../../styles/feature-dock.css");
    const scroll = ruleOf(dock, ".misc-scroll");
    expect(scroll).toContain("flex: 1");
    expect(scroll).toContain("min-height: 0");
    expect(scroll).toMatch(/overflow:\s*hidden auto/);
  });
});
