import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DUR_CARD_REFLOW_MS,
  DUR_ELEMENT_MOVE_MS,
  EASE_CARD_REFLOW,
  EASE_ELEMENT_MOVE,
  SMALL_INCREMENT_PX,
  flipReorder,
  pickSpatialEase
} from "./anim";

/**
 * A3 小增量降档：pickSpatialEase 阈值边界（19 / 20 / 21px）、负值按绝对值、
 * NaN / ±Infinity 回默认档；flipReorder 按每个元素的实际位移量分别选档，
 * reduce-motion 下直接 mutate 不写过渡。
 */
describe("pickSpatialEase（A3 小增量降档）", () => {
  it("阈值常量为 20px，两档别名指向 CSS 语义别名", () => {
    expect(SMALL_INCREMENT_PX).toBe(20);
    expect(EASE_ELEMENT_MOVE).toBe("var(--ease-element-move)");
    expect(EASE_CARD_REFLOW).toBe("var(--ease-card-reflow)");
    expect(DUR_ELEMENT_MOVE_MS).toBe(350);
    expect(DUR_CARD_REFLOW_MS).toBe(500);
  });

  it("19px → elementMove 快档 350ms", () => {
    expect(pickSpatialEase(19)).toEqual({ ease: "var(--ease-element-move)", durMs: 350 });
  });

  it("20px（阈值含等号）→ elementMove 快档", () => {
    expect(pickSpatialEase(20)).toEqual({ ease: "var(--ease-element-move)", durMs: 350 });
  });

  it("21px → cardReflow 默认档 500ms", () => {
    expect(pickSpatialEase(21)).toEqual({ ease: "var(--ease-card-reflow)", durMs: 500 });
  });

  it("负值按绝对值比较：-20 快档、-21 默认档", () => {
    expect(pickSpatialEase(-20).ease).toBe("var(--ease-element-move)");
    expect(pickSpatialEase(-21).ease).toBe("var(--ease-card-reflow)");
  });

  it("0 与小数边界：0 / 19.9 快档，20.01 默认档", () => {
    expect(pickSpatialEase(0).durMs).toBe(350);
    expect(pickSpatialEase(19.9).durMs).toBe(350);
    expect(pickSpatialEase(20.01).durMs).toBe(500);
  });

  it("NaN / ±Infinity 等非有限值回默认档 cardReflow（测量失败不走快档）", () => {
    expect(pickSpatialEase(Number.NaN)).toEqual({ ease: "var(--ease-card-reflow)", durMs: 500 });
    expect(pickSpatialEase(Number.POSITIVE_INFINITY).ease).toBe("var(--ease-card-reflow)");
    expect(pickSpatialEase(Number.NEGATIVE_INFINITY).ease).toBe("var(--ease-card-reflow)");
  });
});

describe("flipReorder 消费 pickSpatialEase", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.documentElement.removeAttribute("data-reduce-motion");
  });

  /** 用可变坐标伪造布局：mutate 改坐标后 Last 测量即读到新值（jsdom 无真实布局）。 */
  function makeRow(container: HTMLElement, pos: { left: number; top: number }) {
    const el = document.createElement("div");
    el.className = "row";
    el.getBoundingClientRect = () =>
      ({
        left: pos.left,
        top: pos.top,
        right: pos.left + 100,
        bottom: pos.top + 20,
        width: 100,
        height: 20,
        x: pos.left,
        y: pos.top,
        toJSON: () => ({})
      }) as DOMRect;
    container.appendChild(el);
    return el;
  }

  it("同一次重排里按各元素位移量分别选档：8px 走快档、120px 走默认档", () => {
    vi.useFakeTimers();
    // 同步 rAF：双 rAF 立即执行，Play 阶段在 flipReorder 返回前完成。
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const container = document.createElement("div");
    const posA = { left: 0, top: 0 };
    const posB = { left: 0, top: 40 };
    const a = makeRow(container, posA);
    const b = makeRow(container, posB);

    flipReorder(container, ".row", () => {
      posA.top = 8; // 小步进
      posB.top = 160; // 大位移
    });

    expect(a.style.transition).toBe("transform 350ms var(--ease-element-move)");
    expect(b.style.transition).toBe("transform 500ms var(--ease-card-reflow)");
    // 清理时序随各自档位：350+60ms 后 a 清空，b 仍在过渡；500+60ms 后全部清空。
    vi.advanceTimersByTime(410);
    expect(a.style.transition).toBe("");
    expect(b.style.transition).toBe("transform 500ms var(--ease-card-reflow)");
    vi.advanceTimersByTime(150);
    expect(b.style.transition).toBe("");
  });

  it("显式 duration 只覆盖时长，曲线仍按位移量选档", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const container = document.createElement("div");
    const pos = { left: 0, top: 0 };
    const el = makeRow(container, pos);
    flipReorder(
      container,
      ".row",
      () => {
        pos.top = 300;
      },
      { duration: 240 }
    );
    expect(el.style.transition).toBe("transform 240ms var(--ease-card-reflow)");
  });

  it("位移 <1px 的元素不写过渡", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const container = document.createElement("div");
    const pos = { left: 0, top: 0 };
    const el = makeRow(container, pos);
    flipReorder(container, ".row", () => {
      pos.top = 0.5;
    });
    expect(el.style.transition).toBe("");
  });

  it("data-reduce-motion=1 时直接执行 mutate，不写任何 transition", () => {
    document.documentElement.setAttribute("data-reduce-motion", "1");
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    const container = document.createElement("div");
    const pos = { left: 0, top: 0 };
    const el = makeRow(container, pos);
    const mutate = vi.fn(() => {
      pos.top = 200;
    });
    flipReorder(container, ".row", mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
    expect(el.style.transition).toBe("");
  });
});
