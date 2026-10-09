/**
 * 全岛面板组件测试：卡片顺序 = dock.tiles、只有当前卡 active、
 * 轮播切卡（←/→ / 圆点 / 滚轮 / 拖动 settle）、网格模式布局 + 点标题进单磁贴展开、
 * 空态文案、与其他展开面互斥、Esc 收回、重开不重建（挂载数不变）、
 * 无实例磁贴的临时配置源落种；settleIndex / dampOverscroll 纯函数。
 *
 * registry 整体 mock 成三种类型（甲 / 乙有 ExpandedComponent，丙只有完整组件），
 * 探针组件把 instanceId / active 写到 data-* 并计数挂载 / 卸载。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

const probe = vi.hoisted(() => {
  const mounts: Record<string, number> = {};
  const unmounts: Record<string, number> = {};
  const reset = () => {
    for (const k of Object.keys(mounts)) delete mounts[k];
    for (const k of Object.keys(unmounts)) delete unmounts[k];
  };
  return { mounts, unmounts, reset };
});

vi.mock("../registry", async () => {
  const React = await import("react");
  const { Circle } = await import("lucide-react");
  type Meta = {
    type: string;
    name: string;
    icon: typeof Circle;
    component: ComponentType<{ instanceId: string }>;
    ExpandedComponent?: ComponentType<{ instanceId: string; active: boolean }>;
  };
  const useMountProbe = (instanceId: string) => {
    React.useEffect(() => {
      probe.mounts[instanceId] = (probe.mounts[instanceId] ?? 0) + 1;
      return () => {
        probe.unmounts[instanceId] = (probe.unmounts[instanceId] ?? 0) + 1;
      };
    }, [instanceId]);
  };
  const Expanded = ({ instanceId, active }: { instanceId: string; active: boolean }) => {
    useMountProbe(instanceId);
    return React.createElement(
      "div",
      { "data-testid": "dp-expanded", "data-instance": instanceId, "data-active": String(active) },
      instanceId,
      React.createElement("button", { type: "button", "data-testid": "inner-btn" }, "inner")
    );
  };
  const Full = ({ instanceId }: { instanceId: string }) => {
    useMountProbe(instanceId);
    return React.createElement("div", { "data-testid": "dp-full", "data-instance": instanceId }, instanceId);
  };
  const METAS: Record<string, Meta> = {
    alpha: { type: "alpha", name: "甲卡", icon: Circle, component: Full, ExpandedComponent: Expanded },
    beta: { type: "beta", name: "乙卡", icon: Circle, component: Full, ExpandedComponent: Expanded },
    gamma: { type: "gamma", name: "丙卡", icon: Circle, component: Full }
  };
  return { getWidgetMeta: (type: string): Meta | undefined => METAS[type], WIDGET_REGISTRY: Object.values(METAS) };
});

import { DockPanel, PANEL_FLING_MIN_VELOCITY, dampOverscroll, dockTileInstanceId, settleIndex } from "./DockPanel";
import { useWidgetExpand } from "../expand-store";
import { CHANGE_EVENT } from "../widget-config";
import { DEFAULT_DOCK, useWidgetStore, type DockTile } from "../widget-store";
import { DOCK_PANEL_EXPAND_ID, dockTileExpandId } from "./dock-logic";

const TILES: DockTile[] = [
  { id: "t-a", type: "alpha" },
  { id: "t-b", type: "beta", instanceId: "w-9" },
  { id: "t-c", type: "gamma" }
];

function seedDock(tiles: DockTile[], mode: "carousel" | "grid" = "carousel") {
  useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, enabled: true, panel: { mode }, tiles } });
}

function openPanel() {
  act(() => useWidgetExpand.getState().expand(DOCK_PANEL_EXPAND_ID));
}

function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".dp-card"));
}

function activeIds(): string[] {
  return cards()
    .filter((c) => c.dataset.active === "true")
    .map((c) => c.dataset.tileId ?? "");
}

const viewport = () => document.querySelector<HTMLElement>(".dp-viewport")!;
const strip = () => document.querySelector<HTMLElement>(".dp-strip")!;

/* jsdom 无 PointerEvent：fireEvent.pointer* 会退化成不带 button / pointerId / clientX 的
   Event，这里按 MouseEvent 补一个最小 polyfill（与 DockDropZone.test 同法）。 */
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
});

beforeEach(() => {
  localStorage.clear();
  probe.reset();
  useWidgetExpand.setState({ expandedId: null, mountedIds: [] });
});

describe("DockPanel · 卡片显示名（S4 口径统一）", () => {
  const withLabel = (label?: string) => [
    { id: "w-9", type: "beta", x: 0, y: 0, w: 100, h: 100, z: 1, ...(label ? { label } : {}) }
  ];

  it("网格卡标题 / 轮播头部当前卡名 / 圆点 aria-label 跟随实例显示名，重命名即时同步", () => {
    seedDock(TILES, "grid");
    act(() => useWidgetStore.setState({ instances: withLabel("我的乙") }));
    const grid = render(<DockPanel />);
    openPanel();
    expect(
      cards()
        .find((c) => c.dataset.tileId === "t-b")!
        .querySelector(".dp-card-title-text")?.textContent
    ).toBe("我的乙");
    // 无实例磁贴维持类型名。
    expect(
      cards()
        .find((c) => c.dataset.tileId === "t-a")!
        .querySelector(".dp-card-title-text")?.textContent
    ).toBe("甲卡");
    // 重命名实时跟随（DockPanel 订阅 instances，title 是原始值进 memo 比对）。
    act(() => useWidgetStore.setState({ instances: withLabel("改名乙") }));
    expect(
      cards()
        .find((c) => c.dataset.tileId === "t-b")!
        .querySelector(".dp-card-title-text")?.textContent
    ).toBe("改名乙");
    grid.unmount();

    seedDock(TILES, "carousel");
    const carousel = render(<DockPanel />);
    openPanel();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("改名乙", { selector: ".dp-cardname" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换到 改名乙" })).toBeTruthy();
    carousel.unmount();
    act(() => useWidgetStore.setState({ instances: [] }));
  });
});

describe("DockPanel 渲染", () => {
  it("3 枚磁贴 → 3 卡，顺序 = tiles；ExpandedComponent 优先，否则完整组件；仅首卡 active", () => {
    seedDock(TILES);
    render(<DockPanel />);
    // 从未展开过：不挂载（mountedIds 为空）
    expect(document.querySelector(".dp-card")).toBeNull();
    openPanel();
    expect(screen.getByRole("dialog", { name: "灵动岛面板" })).toBeTruthy();
    expect(cards().map((c) => c.dataset.tileId)).toEqual(["t-a", "t-b", "t-c"]);
    expect(cards()[0].querySelector("[data-testid='dp-expanded']")).toBeTruthy();
    expect(cards()[1].querySelector("[data-testid='dp-expanded']")).toBeTruthy();
    // Full 兜底只在当前卡挂载（非当前卡不渲染——常驻挂载会让约 20 个无
    // ExpandedComponent 的类型在 display:none 下永久轮询）；切到丙卡才出现。
    expect(cards()[2].querySelector("[data-testid='dp-full']")).toBeNull();
    expect(activeIds()).toEqual(["t-a"]);
    // instanceId：绑定实例的用实例 id，无实例的合成 dock-tile-<id>
    expect(cards()[0].querySelector("[data-instance]")?.getAttribute("data-instance")).toBe("dock-tile-t-a");
    expect(cards()[1].querySelector("[data-instance]")?.getAttribute("data-instance")).toBe("w-9");
    // 头部：「灵动岛 · 当前卡名」；圆点 3 枚，首枚 current
    expect(screen.getByText("灵动岛")).toBeTruthy();
    expect(screen.getByText("甲卡")).toBeTruthy();
    expect(document.querySelectorAll(".dp-dot").length).toBe(3);
    expect(screen.getByRole("button", { name: "切换到 甲卡" }).getAttribute("aria-current")).toBe("true");
    // 轮播卡带：状态位只写 transform
    expect(strip().style.transform).toBe("translateX(0%)");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "切换到 丙卡" }));
    });
    expect(cards()[2].querySelector("[data-testid='dp-full']")).toBeTruthy();
  });

  it("空态：岛内无磁贴时显示提示，无视口 / 无模式切换钮", () => {
    seedDock([]);
    render(<DockPanel />);
    openPanel();
    expect(screen.getByText("拖一张卡片到灵动岛，或按 + 添加")).toBeTruthy();
    expect(document.querySelector(".dp-viewport")).toBeNull();
    expect(screen.queryByRole("button", { name: "切换到网格视图" })).toBeNull();
  });

  it("未知类型的磁贴仍占一张卡（不打断顺序）", () => {
    seedDock([
      { id: "t-a", type: "alpha" },
      { id: "t-z", type: "no-such-type" }
    ]);
    render(<DockPanel />);
    openPanel();
    expect(cards().map((c) => c.dataset.tileId)).toEqual(["t-a", "t-z"]);
    expect(cards()[1].querySelector(".dp-card-unknown")?.textContent).toBe("no-such-type");
  });
});

describe("轮播切卡：仅当前卡 active", () => {
  it("→ / 圆点 / Home / 滚轮切卡，头部名称与圆点跟随，末卡不越界", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(activeIds()).toEqual(["t-b"]);
    expect(screen.getByText("乙卡")).toBeTruthy();
    expect(strip().style.transform).toBe("translateX(-100%)");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "切换到 丙卡" }));
    });
    expect(activeIds()).toEqual(["t-c"]);
    expect(screen.getByRole("button", { name: "切换到 丙卡" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "切换到 甲卡" }).getAttribute("aria-current")).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(activeIds()).toEqual(["t-c"]);

    act(() => {
      fireEvent.keyDown(window, { key: "Home" });
    });
    expect(activeIds()).toEqual(["t-a"]);

    act(() => {
      fireEvent.wheel(viewport(), { deltaY: 120 });
    });
    expect(activeIds()).toEqual(["t-b"]);
    // 非当前卡：aria-hidden + inert，不可聚焦 / 不可命中
    expect(cards()[0].getAttribute("aria-hidden")).toBe("true");
    expect(cards()[1].hasAttribute("aria-hidden")).toBe(false);
  });

  it("焦点在卡片内容里时 ←/→ 不被拦截；面板未展开时全局按键无效", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    const inner = cards()[0].querySelector<HTMLElement>("[data-testid='dp-expanded']")!;
    act(() => {
      fireEvent.keyDown(inner, { key: "ArrowRight" });
    });
    expect(activeIds()).toEqual(["t-a"]);

    act(() => useWidgetExpand.getState().collapse());
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    openPanel();
    expect(activeIds()).toEqual(["t-a"]);
  });
});

describe("轮播拖动（1:1 跟手 → 松手 settle）", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // rAF 合并的跟手写入在测试里同步落地
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(now);
      return 1;
    });
  });

  it("过半松手 → settle 到下一卡（transition 恢复、transform 归位），未过半回弹", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    const vp = viewport();
    Object.defineProperty(vp, "clientWidth", { value: 600, configurable: true });

    fireEvent.pointerDown(vp, { button: 0, isPrimary: true, pointerId: 1, clientX: 500, clientY: 100 });
    // 阈值以内：还没起拖，点击语义保留
    now = 10;
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 497, clientY: 100 });
    expect(vp.classList.contains("is-dragging")).toBe(false);
    // 越过阈值：起拖，transition 关掉，跟手 1:1
    now = 40;
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 104 });
    expect(vp.classList.contains("is-dragging")).toBe(true);
    expect(strip().style.transition).toBe("none");
    expect(strip().style.transform).toBe("translateX(calc(0% + -200px))");
    now = 80;
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 104 });
    expect(strip().style.transform).toBe("translateX(calc(0% + -400px))");
    // 静止后松手（速度≈0）：400/600 过半 → 下一卡
    now = 400;
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 104 });
    expect(vp.classList.contains("is-dragging")).toBe(false);
    expect(strip().style.transition).toBe("");
    expect(strip().style.transform).toBe("translateX(-100%)");
    expect(activeIds()).toEqual(["t-b"]);

    // 未过半：回弹到原卡
    fireEvent.pointerDown(vp, { button: 0, isPrimary: true, pointerId: 2, clientX: 500, clientY: 100 });
    now = 500;
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 400, clientY: 100 });
    expect(strip().style.transform).toBe("translateX(calc(-100% + -100px))");
    now = 900;
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 400, clientY: 100 });
    expect(strip().style.transform).toBe("translateX(-100%)");
    expect(activeIds()).toEqual(["t-b"]);
  });

  it("首卡右拖越界 0.3× 阻尼；pointercancel 回弹；纵向意图不起拖", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    const vp = viewport();
    Object.defineProperty(vp, "clientWidth", { value: 600, configurable: true });

    fireEvent.pointerDown(vp, { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
    now = 30;
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 100 });
    expect(strip().style.transform).toBe("translateX(calc(0% + 30px))");
    now = 60;
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(vp.classList.contains("is-dragging")).toBe(false);
    expect(strip().style.transform).toBe("translateX(0%)");
    expect(activeIds()).toEqual(["t-a"]);

    // 纵向为主的位移：交还给卡片内容，不起拖
    fireEvent.pointerDown(vp, { button: 0, isPrimary: true, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 110, clientY: 160 });
    expect(vp.classList.contains("is-dragging")).toBe(false);
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 110, clientY: 160 });
    expect(strip().style.transform).toBe("translateX(0%)");
  });

  it("起拖排除区：从卡片内的按钮按下不发起轮播拖动", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    const vp = viewport();
    const btn = cards()[0].querySelector<HTMLElement>("[data-testid='inner-btn']")!;
    fireEvent.pointerDown(btn, { button: 0, isPrimary: true, pointerId: 1, clientX: 500, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(vp.classList.contains("is-dragging")).toBe(false);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(activeIds()).toEqual(["t-a"]);
  });
});

describe("网格模式", () => {
  it("右上角按钮切换网格：布局类变化、出现卡片标题、圆点隐藏；不写 dock.panel.mode", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    expect(viewport().classList.contains("is-carousel")).toBe(true);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "切换到网格视图" }));
    });
    expect(viewport().classList.contains("is-grid")).toBe(true);
    expect(viewport().classList.contains("is-carousel")).toBe(false);
    expect(document.querySelectorAll(".dp-card-title").length).toBe(3);
    expect(document.querySelector(".dp-dots")).toBeNull();
    expect(strip().style.transform).toBe("");
    // 网格下卡片全部可见（不再 aria-hidden）：可见卡**全部** active——
    // 此前只有轮播遗留的"当前卡"一张拿 active，其余 Expanded 卡（天气站等
    // `if (!active) return`）在网格里不拉数据、显示骨架。
    expect(cards().every((c) => !c.hasAttribute("aria-hidden"))).toBe(true);
    expect(activeIds()).toEqual(["t-a", "t-b", "t-c"]);
    expect(useWidgetStore.getState().dock.panel.mode).toBe("carousel");
    // 切回
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "切换到轮播视图" }));
    });
    expect(viewport().classList.contains("is-carousel")).toBe(true);
    expect(strip().style.transform).toBe("translateX(0%)");
  });

  it("配置默认 grid（D4 由设置页写）→ 面板直接网格", () => {
    seedDock(TILES, "grid");
    render(<DockPanel />);
    openPanel();
    expect(viewport().classList.contains("is-grid")).toBe(true);
    expect(screen.getByRole("button", { name: "切换到轮播视图" })).toBeTruthy();
  });

  it("点卡片标题 → 该卡单磁贴展开（面板被顶掉、全部卡 active=false）；重开回到配置默认视图", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "切换到网格视图" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "乙卡" }));
    });
    expect(useWidgetExpand.getState().expandedId).toBe(dockTileExpandId("t-b"));
    expect(activeIds()).toEqual([]);
    expect(cards().length).toBe(3); // 仍挂载
    openPanel();
    expect(viewport().classList.contains("is-carousel")).toBe(true);
    expect(activeIds()).toEqual(["t-a"]);
  });
});

describe("互斥 / Esc / 重开不重建", () => {
  it("打开面板顶掉其他展开面；其他面展开时面板卡全部 active=false 但保持挂载", () => {
    seedDock(TILES);
    render(<DockPanel />);
    act(() => useWidgetExpand.getState().expand("canvas-music-1"));
    openPanel();
    expect(useWidgetExpand.getState().expandedId).toBe(DOCK_PANEL_EXPAND_ID);
    expect(useWidgetExpand.getState().mountedIds).toEqual(["canvas-music-1", DOCK_PANEL_EXPAND_ID]);
    expect(probe.mounts["dock-tile-t-a"]).toBe(1);

    act(() => useWidgetExpand.getState().expand("canvas-music-1"));
    expect(activeIds()).toEqual([]);
    expect(cards().length).toBe(3);
    openPanel();
    expect(activeIds()).toEqual(["t-a"]);
  });

  it("Esc 收回（由 WidgetExpandOverlay 处理）；收起不卸载、重开不重建（挂载数不变）", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useWidgetExpand.getState().expandedId).toBeNull();
    expect(document.querySelector(".wexp")!.classList.contains("is-closing")).toBe(true);
    expect(activeIds()).toEqual([]);
    expect(probe.mounts["dock-tile-t-a"]).toBe(1);
    expect(probe.unmounts["dock-tile-t-a"] ?? 0).toBe(0);

    openPanel();
    // Full 兜底（t-c）非当前卡不挂载，挂载/重建断言只覆盖 Expanded 卡
    // （它们才是「常驻叠放不重建」契约的适用面；Full 收起即卸载属预期取舍）。
    expect(probe.mounts).toEqual({ "dock-tile-t-a": 1, "w-9": 1 });
    expect(probe.unmounts).toEqual({});
    expect(activeIds()).toEqual(["t-a"]);
  });

  it("磁贴被移除后当前下标钳制到末卡", () => {
    seedDock(TILES);
    render(<DockPanel />);
    openPanel();
    act(() => {
      fireEvent.keyDown(window, { key: "End" });
    });
    expect(activeIds()).toEqual(["t-c"]);
    act(() => useWidgetStore.getState().removeDockTile("t-c"));
    expect(cards().map((c) => c.dataset.tileId)).toEqual(["t-a", "t-b"]);
    expect(activeIds()).toEqual(["t-b"]);
    expect(probe.unmounts["dock-tile-t-c"]).toBe(1);
  });
});

describe("无实例磁贴的临时配置源", () => {
  it("DockTile.config 落种到合成 instanceId 的 widget-config 键；变更时重种并广播；带实例的不落种", () => {
    seedDock([
      { id: "t-x", type: "alpha", config: { city: 1 } },
      { id: "t-y", type: "beta", instanceId: "w-1", config: { a: 1 } }
    ]);
    render(<DockPanel />);
    openPanel();
    const key = "focus-desk.widget-config.dock-tile-t-x.v1";
    expect(localStorage.getItem(key)).toBe('{"city":1}');
    expect(localStorage.getItem("focus-desk.widget-config.w-1.v1")).toBeNull();

    const seen: string[] = [];
    const onChange = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(CHANGE_EVENT, onChange);
    act(() => useWidgetStore.getState().setDockTileConfig("t-x", { city: 2 }));
    window.removeEventListener(CHANGE_EVENT, onChange);
    expect(localStorage.getItem(key)).toBe('{"city":2}');
    expect(seen).toContain("dock-tile-t-x");
  });

  it("dockTileInstanceId：有实例用实例 id，无实例合成 dock-tile-<id>", () => {
    expect(dockTileInstanceId({ id: "x", type: "clock" })).toBe("dock-tile-x");
    expect(dockTileInstanceId({ id: "x", type: "clock", instanceId: "w" })).toBe("w");
  });
});

describe("settleIndex / dampOverscroll 纯函数", () => {
  it("过半 → 相邻卡；未过半 → 回弹；两个方向对称", () => {
    expect(settleIndex(0, -400, 0, 600, 3)).toBe(1);
    expect(settleIndex(0, -200, 0, 600, 3)).toBe(0);
    expect(settleIndex(2, 400, 0, 600, 3)).toBe(1);
    expect(settleIndex(1, 100, 0, 600, 3)).toBe(1);
  });

  it("甩动：速度达阈值即至少朝该方向翻一卡；投影更远时按投影；末卡钳制", () => {
    expect(settleIndex(0, -80, -PANEL_FLING_MIN_VELOCITY, 600, 3)).toBe(1);
    expect(settleIndex(1, 80, PANEL_FLING_MIN_VELOCITY, 600, 3)).toBe(0);
    expect(settleIndex(0, -80, -0.3, 600, 3)).toBe(0);
    expect(settleIndex(0, -100, -5, 600, 3)).toBe(2);
    expect(settleIndex(2, -300, -3, 600, 3)).toBe(2);
    expect(settleIndex(1, 0, Number.NaN, 600, 3)).toBe(1);
  });

  it("宽度非正 / 卡数为 0 / 下标越界的兜底", () => {
    expect(settleIndex(1, -400, 0, 0, 3)).toBe(1);
    expect(settleIndex(5, 0, 0, 600, 3)).toBe(2);
    expect(settleIndex(0, 0, 0, 600, 0)).toBe(0);
  });

  it("越界阻尼 0.3×，非越界 1:1；单卡两侧皆越界", () => {
    expect(dampOverscroll(100, 0, 3)).toBeCloseTo(30);
    expect(dampOverscroll(-100, 2, 3)).toBeCloseTo(-30);
    expect(dampOverscroll(-100, 0, 3)).toBe(-100);
    expect(dampOverscroll(100, 1, 3)).toBe(100);
    expect(dampOverscroll(50, 0, 1)).toBeCloseTo(15);
    expect(dampOverscroll(-50, 0, 1)).toBeCloseTo(-15);
  });
});
