import { describe, expect, it, vi, afterEach } from "vitest";
import { armThemeInk, consumeThemeInkArm, peekThemeInkArmed, playThemeInk } from "./theme-ink";

/**
 * 主题水墨过渡（滴墨晕开）的非画布契约：武装 → 消费的一次性与时效、
 * 以及 canvas 不可用环境（jsdom 无 2d 上下文）下 playThemeInk 返回 false
 * 的兜底约定 —— 调用方据此取消 defer 并立即上色。
 */
describe("theme-ink arm/consume", () => {
  afterEach(() => {
    vi.useRealTimers();
    // 冲掉残留武装，避免用例间串扰。
    consumeThemeInkArm();
  });

  it("arm 后可窥视；consume 一次性取走，之后窥视为 false", () => {
    armThemeInk();
    expect(peekThemeInkArmed()).toBe(true);
    const origin = consumeThemeInkArm();
    expect(origin).not.toBeNull();
    expect(peekThemeInkArmed()).toBe(false);
    expect(consumeThemeInkArm()).toBeNull();
  });

  it("武装超过 2.5s 过期：消费返回 null，陈旧落点不会渲染到无关主题变化上", () => {
    vi.useFakeTimers();
    armThemeInk();
    vi.advanceTimersByTime(2501);
    expect(peekThemeInkArmed()).toBe(false);
    expect(consumeThemeInkArm()).toBeNull();
  });

  it("canvas 不可用（jsdom）时 playThemeInk 返回 false（调用方兜底立即上色）", () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);
    let covered = 0;
    const started = playThemeInk({
      container,
      origin: { x: 100, y: 100 },
      colors: { bg: "#0a0a0a", ink: "#fafafa", accent: "#3a81f6" },
      onCovered: () => {
        covered += 1;
      }
    });
    expect(started).toBe(false);
    expect(covered).toBe(0);
    container.remove();
  });
});
