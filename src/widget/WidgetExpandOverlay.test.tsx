/**
 * WidgetExpandOverlay 调整大小回归：
 *  - 展开后面板四边四角各一枚拖动柄；默认矩形 min(720, 90vw) × min(600, 86vh)；
 *  - 拖右下角：宽高跟手、松手按 sizeKey 落盘（focus-desk.screen.0.expand-size.v1）；
 *  - 拖左边：x 与 w 一起变，对边不动；缩到下限 320×240 停住；
 *  - 重新展开用记住的尺寸；双击任一柄恢复默认并清掉记录；
 *  - 不给 sizeKey：可拖但不落盘。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WidgetExpandOverlay } from "./WidgetExpandOverlay";
import { expandSizeKey, loadExpandSize } from "./expand-size";

const ORIGIN = { x: 100, y: 100, w: 48, h: 34 };

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

const panel = () => screen.getByRole("dialog", { name: "测试面板" }) as HTMLDivElement;
const grip = (id: string) => document.querySelector<HTMLDivElement>(`.wexp-grip[data-grip="${id}"]`)!;
const px = (v: string) => Number.parseFloat(v);

function drag(el: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
}

async function mount(sizeKey?: string) {
  const r = render(
    <WidgetExpandOverlay active origin={ORIGIN} title="测试面板" onClose={() => {}} sizeKey={sizeKey}>
      <div>内容</div>
    </WidgetExpandOverlay>
  );
  // 等双 rAF 把相位推到 open（并行跑全量时定时器可能被拖慢，不能靠固定等待）。
  await waitFor(() => expect(document.querySelector(".wexp.is-open")).toBeTruthy());
  return r;
}

describe("WidgetExpandOverlay · 调整大小", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("展开后有 8 枚拖动柄；默认矩形 720×600（1024×768 视口），钳到 12px 安全边", async () => {
    const r = await mount("dock:test");
    expect(document.querySelectorAll(".wexp-grip")).toHaveLength(8);
    for (const id of ["nw", "ne", "se", "sw", "n", "s", "w", "e"]) expect(grip(id)).toBeTruthy();
    // F3（焦点圈配套）：柄是纯指针控件，对 AT 隐藏（键盘缩放走卡片 Shift+方向键），
    // 不再暴露「读得到却进不去」的 aria-label。
    expect(grip("se").getAttribute("aria-hidden")).toBe("true");
    expect(grip("se").getAttribute("aria-label")).toBeNull();
    const s = panel().style;
    expect([px(s.left), px(s.top), px(s.width), px(s.height)]).toEqual([12, 12, 720, 600]);
    r.unmount();
  });

  it("拖右下角：宽高跟手、左上不动，松手按 sizeKey 落盘；拖动中内联 transition:none", async () => {
    const r = await mount("dock:test");
    const se = grip("se");
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 732, clientY: 612 });
    expect(document.querySelector(".wexp")!.classList.contains("is-resizing")).toBe(true);
    expect(panel().style.transition).toBe("none");
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 812, clientY: 652 });
    await waitFor(() => expect([px(panel().style.width), px(panel().style.height)]).toEqual([800, 640]));
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 812, clientY: 652 });
    const s = panel().style;
    expect([px(s.left), px(s.top), px(s.width), px(s.height)]).toEqual([12, 12, 800, 640]);
    expect(document.querySelector(".wexp")!.classList.contains("is-resizing")).toBe(false);
    expect(s.transition).not.toBe("none");
    expect(loadExpandSize("dock:test")).toEqual({ w: 800, h: 640 });
    expect(JSON.parse(localStorage.getItem(expandSizeKey())!)).toEqual({ "dock:test": { w: 800, h: 640 } });
    r.unmount();
  });

  it("拖左边：x 与 w 一起变、右边不动；缩过下限停在 320 宽（右边 = 左边 + 320）", async () => {
    const r = await mount("dock:test");
    drag(grip("w"), [12, 300], [112, 300]);
    let s = panel().style;
    expect([px(s.left), px(s.width), px(s.left) + px(s.width)]).toEqual([112, 620, 732]);
    // 再往右拖 1000px：宽度钳在 320，左边 = 732 - 320。
    drag(grip("w"), [112, 300], [1112, 300]);
    s = panel().style;
    expect([px(s.left), px(s.width)]).toEqual([412, 320]);
    expect(loadExpandSize("dock:test")).toEqual({ w: 320, h: 600 });
    r.unmount();
  });

  it("重新展开用记住的尺寸（钳进视口）；双击任一柄恢复默认并清掉记录", async () => {
    let r = await mount("dock:test");
    drag(grip("se"), [732, 612], [812, 652]);
    r.unmount();

    r = await mount("dock:test");
    let s = panel().style;
    expect([px(s.width), px(s.height)]).toEqual([800, 640]);

    fireEvent.doubleClick(grip("n"));
    s = panel().style;
    expect([px(s.width), px(s.height)]).toEqual([720, 600]);
    expect(loadExpandSize("dock:test")).toBeNull();
    r.unmount();
  });

  it("不给 sizeKey：仍可拖，但不落盘", async () => {
    const r = await mount();
    drag(grip("se"), [732, 612], [812, 652]);
    expect(px(panel().style.width)).toBe(800);
    expect(localStorage.getItem(expandSizeKey())).toBeNull();
    r.unmount();
  });
});
