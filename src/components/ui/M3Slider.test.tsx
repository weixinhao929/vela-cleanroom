/**
 * 滑条（WakeSlider 官方组件集成）契约：M3Slider 是设置行适配层——
 *  - 主题色/尺寸经 props 映射，根元素挂 .tm-slider-row（两窗宽度约束）；
 *  - 26 条轨道、role=slider 按钮（aria-valuenow / valuetext 带后缀）、右侧读数；
 *  - 亮条 data-on 数量随值；键盘（方向键/Home/End）驱动提交；无原生 input；
 *  - jsdom 无布局：pointer 路径不提交也不抛错。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { M3Slider } from "./M3Slider";

afterEach(cleanup);

function mount(value = 40, onChange = vi.fn()) {
  const utils = render(
    <M3Slider label="不透明度" value={value} min={0} max={100} step={5} suffix="%" onChange={onChange} />
  );
  const handle = screen.getByRole("slider", { name: "不透明度" }) as HTMLButtonElement;
  const root = handle.closest(".wake-slider") as HTMLElement;
  return { ...utils, handle, root, onChange };
}

describe("M3Slider · WakeSlider 集成", () => {
  it("26 条轨道 + role=slider + aria 值文本带后缀 + 右侧读数；根挂 .tm-slider-row", () => {
    const { handle, root } = mount(40);
    expect(root.classList.contains("tm-slider-row")).toBe(true);
    expect(root.querySelectorAll(".wake-slider__bar").length).toBe(26);
    expect(root.querySelector("input")).toBeNull();
    expect(handle.getAttribute("aria-valuenow")).toBe("40");
    expect(handle.getAttribute("aria-valuetext")).toBe("40%");
    expect(root.querySelector(".wake-slider__value")?.textContent).toBe("40%");
    // 尺寸映射：height=26 / restHeight=10 → --ws-height:26px、rest=min(10,25)/26≈0.3846
    expect(root.style.getPropertyValue("--ws-height")).toBe("26px");
    expect(Number(root.style.getPropertyValue("--ws-rest"))).toBeCloseTo(10 / 26, 6);
  });

  it("亮条 data-on 数量随值：value 50 → lit 13 → 14 根亮起", () => {
    const { root } = mount(50);
    const on = [...root.querySelectorAll<HTMLElement>(".wake-slider__bar")].filter((b) => b.dataset.on === "true");
    expect(on.length).toBe(14);
  });

  it("键盘：ArrowRight 提交 value+step（45），Home 归 min，End 到 max", () => {
    const { handle, onChange } = mount(40);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(45);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("无关按键不提交；受控值钳到区间", () => {
    const { handle, onChange } = mount(40);
    fireEvent.keyDown(handle, { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
    cleanup();
    const over = mount(140);
    expect(over.handle.getAttribute("aria-valuenow")).toBe("100");
  });

  it("label 缺省时 ariaLabel 回退「数值」（i18n 键，英文界面为 Value）", () => {
    render(<M3Slider value={10} min={0} max={20} onChange={() => undefined} />);
    expect(screen.getByRole("slider", { name: "数值" })).toBeTruthy();
  });

  it("jsdom 无布局 rect：pointerdown 不提交也不抛错", () => {
    const { root, onChange } = mount(40);
    const track = root.querySelector(".wake-slider__track") as HTMLElement;
    expect(() => fireEvent.pointerDown(track, { pointerId: 1, clientX: 50 })).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
