/**
 * Segmented 胶囊指示条回归测试（快速连点乱跳修复）：
 * 激活项带 fx-seg-pop 弹入缩放（scale 0.9→1.04→1），旧实现用
 * getBoundingClientRect 测胶囊几何 —— rect 含 transform，点击瞬间测到
 * 动画中间值，快速连点时胶囊乱跳。新实现读 offsetLeft/offsetWidth
 * （纯布局值，不受 transform/入场动画影响）。
 *
 * jsdom 无布局引擎，getBoundingClientRect 恒为 0：给激活项注入
 * offsetLeft/offsetWidth 后断言胶囊采用注入值 —— 旧实现在此用例下必得 0，
 * 可精确区分修复前后行为。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { Segmented } from "./shared";

function Harness() {
  const [v, setV] = useState("a");
  return (
    <Segmented
      value={v}
      onChange={setV}
      options={[
        { id: "a", label: "甲" },
        { id: "b", label: "乙" },
        { id: "c", label: "丙" }
      ]}
    />
  );
}

/** 在元素实例上注入 offsetLeft/offsetWidth（遮蔽原型上的 jsdom 恒 0 实现）。 */
function injectOffset(el: Element, left: number, width: number) {
  Object.defineProperty(el, "offsetLeft", { value: left, configurable: true });
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
}

describe("Segmented · 胶囊指示条测量", () => {
  it("胶囊几何取 offsetLeft/offsetWidth（布局值），而非被弹入动画污染的 rect", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const items = screen.getAllByRole("radio");
    injectOffset(items[1], 120, 80);

    await user.click(items[1]);
    const pills = document.querySelectorAll<HTMLElement>(".tm-segmented-pill");
    expect(pills.length).toBe(2); // 双速两层（fast/slow）
    for (const pill of pills) {
      expect(pill.style.transform).toBe("translateX(120px)");
      expect(pill.style.width).toBe("80px");
    }
  });

  it("value 未变化的其余项不测量：切到丙后胶囊更新为丙的注入几何", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const items = screen.getAllByRole("radio");
    injectOffset(items[1], 120, 80);
    injectOffset(items[2], 210, 70);

    await user.click(items[2]);
    const pill = document.querySelector<HTMLElement>(".tm-segmented-pill.pill-fast");
    expect(pill?.style.transform).toBe("translateX(210px)");
    expect(pill?.style.width).toBe("70px");
  });

  it("首次挂载不播放橡胶动画（无 is-rubber / 无注入变量）", () => {
    render(<Harness />);
    expect(document.querySelector(".tm-segmented-pill.is-rubber")).toBeNull();
  });

  it("rubber：位移时注入方向与拉伸量（随距离钳制），反向移动时方向翻转", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const items = screen.getAllByRole("radio");
    injectOffset(items[1], 120, 80);

    // 甲 → 乙：向右 120px → dir=1，拉伸量 120/200=0.6 钳到上限 0.5
    await user.click(items[1]);
    const stretched = document.querySelectorAll<HTMLElement>(".tm-segmented-pill.is-rubber");
    expect(stretched.length).toBe(2); // 快慢两层都播
    for (const span of stretched) {
      expect(span.style.getPropertyValue("--seg-dir")).toBe("1");
      expect(span.style.getPropertyValue("--seg-stretch")).toBe("0.5");
      // 动画重放信号：内层气泡以 seq 为 key 重挂载
      expect(span.querySelector(".tm-segmented-pill-b")).not.toBeNull();
    }

    // 乙 → 甲：向左 → dir=-1
    await user.click(items[0]);
    for (const span of document.querySelectorAll<HTMLElement>(".tm-segmented-pill")) {
      expect(span.style.getPropertyValue("--seg-dir")).toBe("-1");
    }
  });

  it("rubber：短距离位移拉伸量取下限（30/200 → 钳到 0.15）", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const items = screen.getAllByRole("radio");
    // 首次挂载测得甲在 x=0（jsdom 无布局），乙注入 x=30 → dx=30。
    injectOffset(items[1], 30, 60);
    await user.click(items[1]);
    const span = document.querySelector<HTMLElement>(".tm-segmented-pill.is-rubber");
    expect(span?.style.getPropertyValue("--seg-stretch")).toBe("0.15");
  });
});
