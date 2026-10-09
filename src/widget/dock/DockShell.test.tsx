/**
 * ISLAND-MOVE 组件测试（DockShell，/ QQ 式自动隐藏 / ）：
 *  - 拖动柄沿边拖 300px：拖动期只写 transform、不改 offset；松手 setDockPlacement
 *    一次 commit（snapOffset 口径），落盘为 left 百分比；
 *  - 不再换边：拖到屏幕底部区域也只沿顶边滑动，无幽灵预览，松手 edge 仍为 top；
 *  - resize 后位置比例保持（百分比渲染，不落像素）；start / end 吸附点贴边渲染；
 *  - Ctrl+Shift+←/→ 循环三点吸附；非编辑 / 无修饰键不动作；
 *  - hover 微涨 is-peak（配置 peak + 折叠态）；
 *  - QQ 式自动隐藏：开启即收合（is-tucked），pointer 进入弹出、离开 1.2s 收回；编辑 / 展开面强制弹出。
 *
 * jsdom 没有 PointerEvent / setPointerCapture：测试内补最小 polyfill；所有 rect 为 0，
 * 故拖动几何以「岛中心从 0 出发」推算（中心比例 = 位移 / innerWidth）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const handlers = new Map<string, (e: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  })
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: vi.fn(async () => null) };
});

import { DockShell } from "./DockShell";
import { useWidgetExpand } from "../expand-store";
import { DEFAULT_DOCK, useWidgetStore, type DockConfig } from "../widget-store";
import { OSD_EVENT } from "../../lib/osd-events";

/** 与 DockShell 内部常量同值（贴边留白）。 */
const FLUSH = "8px";

/** 真实 store 动作：个别用例会换成 spy，beforeEach 统一还原（zustand 单例会跨用例泄漏）。 */
const realSetDockPlacement = useWidgetStore.getState().setDockPlacement;

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
  const w = window as unknown as { PointerEvent?: unknown; requestAnimationFrame?: unknown };
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

function seedDock(patch: Partial<DockConfig> = {}, editMode = true) {
  useWidgetStore.setState({
    setDockPlacement: realSetDockPlacement,
    dock: {
      ...DEFAULT_DOCK,
      enabled: true,
      edge: "top",
      offset: 0.5,
      snap: "center",
      tiles: DEFAULT_DOCK.tiles.map((t) => ({ ...t })),
      ...patch
    },
    editMode
  });
}

/** 让 jsdom 的 rAF（16ms）先跑完再继续。 */
const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));

const getDock = () => screen.getByRole("toolbar", { name: "灵动岛" }) as HTMLDivElement;
const getHandle = () => screen.getByRole("button", { name: "拖动灵动岛" });

function pointer(
  el: Element,
  type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel",
  x: number,
  y: number
) {
  fireEvent[type](el, { pointerId: 1, button: 0, clientX: x, clientY: y });
}

describe("DockShell · 岛本体位置拖动（F-4）", () => {
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    useWidgetExpand.setState({ expandedId: null, mountedIds: [] });
    seedDock();
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
  });

  it("拖动柄只在编辑模式出现：可聚焦按钮、aria-label「拖动灵动岛」、data-interactive", () => {
    render(<DockShell bottomInset={0} />);
    const handle = getHandle();
    expect(handle.tagName).toBe("BUTTON");
    expect(handle).toHaveAttribute("data-interactive");
    expect(handle.getAttribute("aria-keyshortcuts")).toContain("Control+Shift+ArrowLeft");
    act(() => useWidgetStore.setState({ editMode: false }));
    expect(screen.queryByRole("button", { name: "拖动灵动岛" })).toBeNull();
  });

  it("拖动柄位移 300px 松手 → 拖动期只写 transform，松手 setDockPlacement 一次 commit 且 offset 变化", async () => {
    const calls: unknown[] = [];
    const real = useWidgetStore.getState().setDockPlacement;
    useWidgetStore.setState({
      setDockPlacement: (p) => {
        calls.push(p);
        real(p);
      }
    });
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    const handle = getHandle();
    expect(dock.style.left).toBe("50%");
    expect(dock.getAttribute("data-snap")).toBe("center");

    pointer(handle, "pointerDown", 512, 12);
    expect(dock.classList.contains("is-dragging")).toBe(true);
    expect(dock).toHaveAttribute("data-interactive");
    expect(handle).toHaveAttribute("data-interactive");
    expect(dock.style.transition).toBe("none");

    pointer(handle, "pointerMove", 812, 12);
    await frame();
    // 跟手只写 transform；offset 状态与 left 不动，未 commit。
    expect(dock.style.transform).toBe("translate(calc(-50% + 300px), 0px)");
    expect(dock.style.left).toBe("50%");
    expect(useWidgetStore.getState().dock.offset).toBe(0.5);
    expect(calls).toHaveLength(0);
    expect(document.querySelector(".dock-ghost")).toBeNull();

    pointer(handle, "pointerUp", 812, 12);
    expect(calls).toHaveLength(1);
    const d = useWidgetStore.getState().dock;
    expect(d.offset).not.toBe(0.5);
    expect(d.offset).toBeCloseTo(300 / 1024, 6);
    expect(d.snap).toBe("free");
    expect(d.edge).toBe("top");
    expect(calls[0]).toEqual({ edge: "top", offset: d.offset, snap: "free" });
    // 落盘为 left 百分比（resize 自动按比例）；吸附动画 360ms --ease-spatial-fast 只动 transform。
    expect(dock.style.left).toBe(`${(300 / 1024) * 100}%`);
    expect(dock.style.transition).toBe("transform 450ms var(--ease-dock-spring)");
    expect(dock.style.transform).toBe("translateX(-50%)");
    expect(dock.classList.contains("is-dragging")).toBe(false);
  });

  it("松手位置离 center 吸附点 < 32px → 吸到 center（offset 0.5 / snap center）", async () => {
    seedDock({ offset: 0.2, snap: "free" });
    render(<DockShell bottomInset={0} />);
    const handle = getHandle();
    // jsdom 中心从 0 出发：拖到 512 - 20 = 492 → 距 center 20px < 32 → 吸附。
    pointer(handle, "pointerDown", 100, 12);
    pointer(handle, "pointerMove", 592, 12);
    await frame();
    pointer(handle, "pointerUp", 592, 12);
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0.5, snap: "center", edge: "top" });
    expect(getDock().style.left).toBe("50%");
  });

  it("拖到贴边 → 比例归到 0 → start 吸附点，渲染为贴边留白 + transform:none 静止态（data-snap）", async () => {
    render(<DockShell bottomInset={0} />);
    const handle = getHandle();
    pointer(handle, "pointerDown", 512, 12);
    pointer(handle, "pointerMove", 300, 12); // 中心钳到 0（jsdom 岛宽 0）→ 贴左边
    await frame();
    pointer(handle, "pointerUp", 300, 12);
    const dock = getDock();
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0, snap: "start" });
    expect(dock.getAttribute("data-snap")).toBe("start");
    expect(dock.style.left).toBe(FLUSH);
    expect(dock.style.right).toBe("");
    expect(dock.style.transform).toBe("translate(0px, 0px)");
  });

  it("从 start / end 贴边态起拖：位移叠在 transform:none 基线上（不带 -50%，首帧不跳半个岛宽）", async () => {
    seedDock({ offset: 0, snap: "start" });
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    const handle = getHandle();
    pointer(handle, "pointerDown", 20, 12);
    pointer(handle, "pointerMove", 220, 12);
    await frame();
    expect(dock.style.transform).toBe("translate(200px, 0px)");
    pointer(handle, "pointerUp", 220, 12);
    // 200 / 1024 ≈ 0.195：离三点都 > 32px → free，回到百分比 + -50% 基线
    expect(useWidgetStore.getState().dock).toMatchObject({ snap: "free" });
    expect(useWidgetStore.getState().dock.offset).toBeCloseTo(200 / 1024, 6);
    expect(dock.style.transform).toBe("translateX(-50%)");
  });

  it("未移动就松手（点一下柄）→ 不 commit、不改状态", async () => {
    const spy = vi.fn();
    useWidgetStore.setState({ setDockPlacement: spy });
    render(<DockShell bottomInset={0} />);
    const handle = getHandle();
    pointer(handle, "pointerDown", 512, 12);
    pointer(handle, "pointerMove", 513, 12);
    await frame();
    pointer(handle, "pointerUp", 513, 12);
    expect(spy).not.toHaveBeenCalled();
    expect(getDock().style.transform).toBe("");
  });

  it("不再换边：拖到屏幕底部区域也只沿顶边滑动（无幽灵预览），松手 edge 仍为 top、按吸附规则落位", async () => {
    render(<DockShell bottomInset={30} />);
    const dock = getDock();
    const handle = getHandle();
    expect(dock.style.top).toBe("10px");

    pointer(handle, "pointerDown", 512, 12);
    pointer(handle, "pointerMove", 812, 700); // 早先这里会进入底部 25% 带并预览换边
    await frame();
    expect(document.querySelector(".dock-ghost")).toBeNull();
    // Y 分量恒 0，岛本体不离顶边。
    expect(dock.style.transform).toBe("translate(calc(-50% + 300px), 0px)");

    pointer(handle, "pointerUp", 812, 700);
    const d = useWidgetStore.getState().dock;
    expect(d.edge).toBe("top");
    expect(d.offset).toBeCloseTo(300 / 1024, 6);
    expect(dock.style.top).toBe("10px");
    expect(dock.style.bottom).toBe("");
    expect(dock.style.transition).toBe("transform 450ms var(--ease-dock-spring)");
  });

  it("pointercancel → 不 commit，岛动画回到原落点", async () => {
    const spy = vi.fn();
    useWidgetStore.setState({ setDockPlacement: spy });
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    const handle = getHandle();
    pointer(handle, "pointerDown", 512, 12);
    pointer(handle, "pointerMove", 812, 12);
    await frame();
    pointer(handle, "pointerCancel", 812, 12);
    expect(spy).not.toHaveBeenCalled();
    expect(dock.style.left).toBe("50%");
    expect(dock.style.transition).toBe("transform 450ms var(--ease-dock-spring)");
    expect(dock.classList.contains("is-dragging")).toBe(false);
  });

  it("resize 后位置比例保持：free 位置以 left 百分比渲染，屏宽变化不落像素", async () => {
    seedDock({ offset: 0.3, snap: "free" });
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    expect(dock.style.left).toBe("30%");
    Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true, writable: true });
    fireEvent(window, new Event("resize"));
    await frame();
    // 触发一次无关重渲染（编辑态翻转），确认没有任何像素化改写。
    act(() => useWidgetStore.setState({ editMode: false }));
    act(() => useWidgetStore.setState({ editMode: true }));
    expect(dock.style.left).toBe("30%");
    expect(useWidgetStore.getState().dock.offset).toBe(0.3);
  });

  it("start / end 吸附点渲染：贴边留白 + data-snap；顶边避让读 dock.topInset（缺省 10）；bangs 贴屏顶边", () => {
    seedDock({ offset: 1, snap: "end" });
    let r = render(<DockShell bottomInset={0} />);
    let dock = getDock();
    expect(dock.style.right).toBe(FLUSH);
    // 基础样式 left:50% 必须被 auto 压掉，否则 fixed 元素左右双约束会把岛拉宽。
    expect(dock.style.left).toBe("auto");
    expect(dock.getAttribute("data-snap")).toBe("end");
    expect(dock.style.top).toBe("10px");
    r.unmount();

    seedDock({ offset: 0, snap: "start", topInset: 24 });
    r = render(<DockShell bottomInset={0} />);
    dock = getDock();
    expect(dock.style.left).toBe(FLUSH);
    expect(dock.style.top).toBe("24px");
    r.unmount();

    // bangs 外形贴屏（top:0 与 CSS 的 top:0 !important 一致，FLIP 基准同源）。
    seedDock({ offset: 0, snap: "start", style: "bangs" });
    r = render(<DockShell bottomInset={0} />);
    dock = getDock();
    expect(dock.classList.contains("is-bangs")).toBe(true);
    expect(dock.style.top).toBe("0px");
    r.unmount();
  });

  it("Ctrl+Shift+→ / ← 沿边循环三点吸附（center → end → start → end → center）", () => {
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    const key = (k: "ArrowLeft" | "ArrowRight", init: Partial<KeyboardEventInit> = { ctrlKey: true, shiftKey: true }) =>
      fireEvent.keyDown(dock, { key: k, ...init });

    key("ArrowRight");
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 1, snap: "end" });
    expect(dock.style.right).toBe(FLUSH);
    expect(dock.style.transition).toBe("transform 450ms var(--ease-dock-spring)");

    key("ArrowRight");
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0, snap: "start" });
    expect(dock.style.left).toBe(FLUSH);

    key("ArrowLeft");
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 1, snap: "end" });
    key("ArrowLeft");
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0.5, snap: "center" });
    expect(dock.style.left).toBe("50%");

    // 无 Ctrl+Shift 不动作
    key("ArrowRight", { ctrlKey: true });
    key("ArrowRight", { shiftKey: true });
    key("ArrowRight", {});
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0.5, snap: "center" });

    // 非编辑模式不动作
    act(() => useWidgetStore.setState({ editMode: false }));
    key("ArrowRight");
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0.5, snap: "center" });
  });

  it("free 位置按键 → 就近进位到下一 / 上一吸附点", () => {
    seedDock({ offset: 0.3, snap: "free" });
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    fireEvent.keyDown(dock, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0.5, snap: "center" });
    act(() => seedDock({ offset: 0.7, snap: "free" }));
    fireEvent.keyDown(dock, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(useWidgetStore.getState().dock).toMatchObject({ offset: 0.5, snap: "center" });
  });
});

describe("DockShell · hover 微涨（F-9）与 QQ 式自动隐藏", () => {
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    useWidgetExpand.setState({ expandedId: null, mountedIds: [] });
    seedDock({}, false);
  });

  it("mouse.hover=peak：折叠态 pointer 进入挂 is-peak，离开移除；编辑模式 / 展开面板期间不挂", () => {
    seedDock({ mouse: { ...DEFAULT_DOCK.mouse, hover: "peak" } }, false);
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    fireEvent.pointerOver(dock);
    expect(dock.classList.contains("is-peak")).toBe(true);
    fireEvent.pointerOut(dock);
    expect(dock.classList.contains("is-peak")).toBe(false);

    act(() => useWidgetStore.setState({ editMode: true }));
    fireEvent.pointerOver(dock);
    expect(dock.classList.contains("is-peak")).toBe(false);
    fireEvent.pointerOut(dock);
    act(() => useWidgetStore.setState({ editMode: false }));

    act(() => useWidgetExpand.getState().expand("dock:panel"));
    fireEvent.pointerOver(dock);
    expect(dock.classList.contains("is-peak")).toBe(false);
  });

  it("mouse.hover=none（默认）：pointer 进入不挂 is-peak", () => {
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    fireEvent.pointerOver(dock);
    expect(dock.classList.contains("is-peak")).toBe(false);
  });

  it("autoHide=false（默认）：从不挂 is-tucked，pointer 进出也不变", () => {
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    expect(dock.classList.contains("is-tucked")).toBe(false);
    fireEvent.pointerOver(dock);
    fireEvent.pointerOut(dock);
    expect(dock.classList.contains("is-tucked")).toBe(false);
  });

  it("autoHide=true（QQ 式）：平时收合 is-tucked + aria-hidden；pointer 进入弹出；离开 1.2s 后收回；期间再进入取消收回", () => {
    vi.useFakeTimers();
    try {
      seedDock({ autoHide: true }, false);
      render(<DockShell bottomInset={0} />);
      // 收合态挂了 aria-hidden，getByRole 默认查不到，按类取。
      const dock = document.querySelector<HTMLDivElement>(".dock")!;
      expect(dock.classList.contains("is-tucked")).toBe(true);
      expect(dock.getAttribute("aria-hidden")).toBe("true");
      // 收合期不 display:none：留在屏内的那一条要能感应指针。
      expect(dock.style.display).toBe("");

      fireEvent.pointerOver(dock);
      expect(dock.classList.contains("is-tucked")).toBe(false);
      expect(dock.hasAttribute("aria-hidden")).toBe(false);

      fireEvent.pointerOut(dock);
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(dock.classList.contains("is-tucked")).toBe(false); // 未到 1.2s
      fireEvent.pointerOver(dock); // 指针回来 → 取消待收回
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(dock.classList.contains("is-tucked")).toBe(false);

      fireEvent.pointerOut(dock);
      act(() => {
        vi.advanceTimersByTime(1300);
      });
      expect(dock.classList.contains("is-tucked")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("autoHide=true：编辑模式 / 有展开面期间强制弹出，退出后恢复收合；关掉开关立即弹出", () => {
    seedDock({ autoHide: true }, false);
    render(<DockShell bottomInset={0} />);
    const dock = document.querySelector<HTMLDivElement>(".dock")!;
    expect(dock.classList.contains("is-tucked")).toBe(true);

    act(() => useWidgetStore.setState({ editMode: true }));
    expect(dock.classList.contains("is-tucked")).toBe(false);
    act(() => useWidgetStore.setState({ editMode: false }));
    expect(dock.classList.contains("is-tucked")).toBe(true);

    act(() => useWidgetExpand.getState().expand("dock:panel"));
    expect(dock.classList.contains("is-tucked")).toBe(false);
    act(() => useWidgetExpand.getState().collapse());
    expect(dock.classList.contains("is-tucked")).toBe(true);

    act(() => useWidgetStore.getState().setDock({ autoHide: false }));
    expect(dock.classList.contains("is-tucked")).toBe(false);
  });
});

describe("DockShell · 鼠标动作（F-6 / I-03）", () => {
  /** fireEvent 无 auxClick 别名：auxclick 是原生 DOM 事件，直接构造。 */
  const auxClick = (el: Element, button: number) =>
    fireEvent(el, new MouseEvent("auxclick", { button, bubbles: true, cancelable: true }));

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    useWidgetExpand.setState({ expandedId: null, mountedIds: [] });
    seedDock({}, false);
  });

  it("middle=collapse（默认）：中键收起岛上正在展开的面；画布实例的展开不受影响", () => {
    seedDock({}, false);
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    act(() => {
      useWidgetExpand.getState().expand("dock:panel");
    });
    auxClick(dock, 1);
    expect(useWidgetExpand.getState().expandedId).toBeNull();

    act(() => {
      useWidgetExpand.getState().expand("widget-9");
    });
    auxClick(dock, 1);
    expect(useWidgetExpand.getState().expandedId).toBe("widget-9"); // 非 dock 前缀：不收
    auxClick(dock, 0);
    expect(useWidgetExpand.getState().expandedId).toBe("widget-9"); // 非中键：不动作
  });

  it("middle=panel：中键打开全岛面板", () => {
    seedDock({ mouse: { ...DEFAULT_DOCK.mouse, middle: "panel" } }, false);
    render(<DockShell bottomInset={0} />);
    auxClick(getDock(), 1);
    expect(useWidgetExpand.getState().expandedId).toBe("dock:panel");
  });

  it("wheel=cycle：向下滚展开首磁贴 → 节流窗口内连滚不动 → 过窗后滚到下一枚 → 向上滚回上一枚；默认 none 不动作", async () => {
    seedDock({ mouse: { ...DEFAULT_DOCK.mouse, wheel: "cycle" } }, false);
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    const ids = useWidgetStore.getState().dock.tiles.map((t) => `dock:${t.id}`);
    fireEvent.wheel(dock, { deltaY: 120 });
    expect(useWidgetExpand.getState().expandedId).toBe(ids[0]);
    // 同一次滚动手势的后续事件（200ms 内）不步进。
    fireEvent.wheel(dock, { deltaY: 120 });
    expect(useWidgetExpand.getState().expandedId).toBe(ids[0]);
    await act(() => new Promise<void>((r) => setTimeout(r, 220)));
    fireEvent.wheel(dock, { deltaY: 120 });
    expect(useWidgetExpand.getState().expandedId).toBe(ids[1]);
    await act(() => new Promise<void>((r) => setTimeout(r, 220)));
    fireEvent.wheel(dock, { deltaY: -120 });
    expect(useWidgetExpand.getState().expandedId).toBe(ids[0]);
  });

  it("wheel=none（默认）：滚动不动作；编辑模式下 wheel=cycle 也不动作", async () => {
    seedDock({}, false);
    render(<DockShell bottomInset={0} />);
    fireEvent.wheel(getDock(), { deltaY: 120 });
    expect(useWidgetExpand.getState().expandedId).toBeNull();

    act(() => {
      seedDock({ mouse: { ...DEFAULT_DOCK.mouse, wheel: "cycle" } }, true);
    });
    fireEvent.wheel(getDock(), { deltaY: 120 });
    expect(useWidgetExpand.getState().expandedId).toBeNull();
  });

  it("hover=expand-first：停留 300ms 展开首磁贴；提前离开取消；编辑模式不动作；hover=peak 不展开", async () => {
    seedDock({ mouse: { ...DEFAULT_DOCK.mouse, hover: "expand-first" } }, false);
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    const first = `dock:${useWidgetStore.getState().dock.tiles[0].id}`;
    fireEvent.pointerOver(dock);
    expect(useWidgetExpand.getState().expandedId).toBeNull(); // 未满停留门槛
    await act(() => new Promise<void>((r) => setTimeout(r, 320)));
    expect(useWidgetExpand.getState().expandedId).toBe(first);

    // 离开清计时器：短暂掠过不展开。
    act(() => useWidgetExpand.getState().collapse());
    fireEvent.pointerOver(dock);
    await act(() => new Promise<void>((r) => setTimeout(r, 120)));
    fireEvent.pointerOut(dock);
    await act(() => new Promise<void>((r) => setTimeout(r, 240)));
    expect(useWidgetExpand.getState().expandedId).toBeNull();

    // 编辑模式：停留也不展开。
    act(() => {
      seedDock({ mouse: { ...DEFAULT_DOCK.mouse, hover: "expand-first" } }, true);
    });
    fireEvent.pointerOver(dock);
    await act(() => new Promise<void>((r) => setTimeout(r, 320)));
    expect(useWidgetExpand.getState().expandedId).toBeNull();
    fireEvent.pointerOut(dock);

    // peak 是微涨语义（is-peak），不展开面板。
    act(() => {
      seedDock({ mouse: { ...DEFAULT_DOCK.mouse, hover: "peak" } }, false);
    });
    fireEvent.pointerOver(dock);
    await act(() => new Promise<void>((r) => setTimeout(r, 320)));
    expect(useWidgetExpand.getState().expandedId).toBeNull();
    expect(dock.classList.contains("is-peak")).toBe(true);
  });

  it("接管期间 hover=expand-first / wheel=cycle / middle=panel 让位：不从隐形磁贴层展开面板", async () => {
    seedDock({ mouse: { ...DEFAULT_DOCK.mouse, hover: "expand-first", wheel: "cycle", middle: "panel" } }, false);
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    // OSD 路径伪造一条音量接管（useDockTakeover 监听 focus-desk:osd 事件）。
    act(() => {
      fireEvent(window, new CustomEvent(OSD_EVENT, { detail: { kind: "volume", title: "音量", sub: "50%" } }));
    });
    expect(dock.classList.contains("has-takeover")).toBe(true);

    // 滚轮：跨过节流窗口连滚也不展开（旧实现会从 opacity:0 的磁贴层弹出面板）。
    fireEvent.wheel(dock, { deltaY: 120 });
    await act(() => new Promise<void>((r) => setTimeout(r, 220)));
    fireEvent.wheel(dock, { deltaY: 120 });
    expect(useWidgetExpand.getState().expandedId).toBeNull();

    // 中键 = panel：接管期让位。
    auxClick(dock, 1);
    expect(useWidgetExpand.getState().expandedId).toBeNull();

    // 悬停 300ms 停留（expand-first）：接管期不展开、也不挂 peak 微涨。
    fireEvent.pointerOver(dock);
    await act(() => new Promise<void>((r) => setTimeout(r, 320)));
    expect(useWidgetExpand.getState().expandedId).toBeNull();
    expect(dock.classList.contains("is-peak")).toBe(false);
    fireEvent.pointerOut(dock);
  });

  it("接管结束后（点击接管条消除）hover=expand-first 恢复展开——守卫只让位不吞配置语义", async () => {
    seedDock({ mouse: { ...DEFAULT_DOCK.mouse, hover: "expand-first" } }, false);
    render(<DockShell bottomInset={0} />);
    const dock = getDock();
    act(() => {
      fireEvent(window, new CustomEvent(OSD_EVENT, { detail: { kind: "volume", title: "音量", sub: "50%" } }));
    });
    fireEvent.pointerOver(dock);
    await act(() => new Promise<void>((r) => setTimeout(r, 320)));
    expect(useWidgetExpand.getState().expandedId).toBeNull();
    // 点击接管条 = dismiss（音量类无磁贴落点，走 onTakeoverClick 的兜底消除）。
    fireEvent.click(screen.getByRole("button", { name: /音量/ }));
    expect(dock.classList.contains("has-takeover")).toBe(false);
    fireEvent.pointerOut(dock);
    fireEvent.pointerOver(dock);
    await act(() => new Promise<void>((r) => setTimeout(r, 320)));
    expect(useWidgetExpand.getState().expandedId).toBe(`dock:${useWidgetStore.getState().dock.tiles[0].id}`);
  });
});

/* ---- 「‹ ›」视图切换按钮（dock.viewArrows）：桌面层不再有常驻切换器，岛两端的这两枚是唯一入口 ---- */
describe("DockShell · 视图切换按钮（dock.viewArrows）", () => {
  const views = () => [
    { id: "home", name: "Home" },
    { id: "work", name: "Work" },
    { id: "focus", name: "Focus" }
  ];
  const active = () => useWidgetStore.getState().activeView;

  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    useWidgetExpand.setState({ expandedId: null, mountedIds: [] });
    useWidgetStore.setState({ views: views(), activeView: "home", instances: [] });
    seedDock({}, false);
  });

  it("默认开启：岛两端各一枚窄按钮（prev 在首、next 在尾），名字带目标视图；点击切换且首尾循环", () => {
    render(<DockShell bottomInset={0} />);
    const prev = screen.getByRole("button", { name: "上一视图：Focus" });
    const next = screen.getByRole("button", { name: "下一视图：Work" });
    expect(prev).toHaveAttribute("data-interactive");
    expect(prev.classList.contains("is-prev")).toBe(true);
    expect(next.classList.contains("is-next")).toBe(true);
    const dock = getDock();
    expect(dock.firstElementChild).toBe(prev);
    expect(dock.lastElementChild).toBe(next);

    fireEvent.click(next);
    expect(active()).toBe("work");
    fireEvent.click(screen.getByRole("button", { name: "下一视图：Focus" }));
    expect(active()).toBe("focus");
    fireEvent.click(screen.getByRole("button", { name: "下一视图：Home" }));
    expect(active()).toBe("home"); // 末尾 → 首个
    fireEvent.click(screen.getByRole("button", { name: "上一视图：Focus" }));
    expect(active()).toBe("focus"); // 首个 → 末尾
  });

  it("viewArrows=false 或只剩一个视图时不渲染；点按钮不算「点岛空白」（不开全岛面板）", () => {
    seedDock({ mouse: { ...DEFAULT_DOCK.mouse, blank: "panel" } }, false);
    render(<DockShell bottomInset={0} />);
    fireEvent.click(screen.getByRole("button", { name: "下一视图：Work" }));
    expect(active()).toBe("work");
    expect(useWidgetExpand.getState().expandedId).toBeNull();

    act(() => useWidgetStore.getState().setDock({ viewArrows: false }));
    expect(screen.queryByRole("button", { name: /上一视图/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /下一视图/ })).toBeNull();

    act(() => useWidgetStore.getState().setDock({ viewArrows: true }));
    expect(screen.getByRole("button", { name: /上一视图/ })).toBeTruthy();
    act(() => useWidgetStore.setState({ views: [{ id: "work", name: "Work" }] }));
    expect(screen.queryByRole("button", { name: /上一视图/ })).toBeNull();
  });
});
