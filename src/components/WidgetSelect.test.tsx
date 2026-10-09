/**
 * WidgetSelect（glide 下拉）测试（jsdom）：
 *  - 打开：listbox 渲染、选中行 aria-selected、触发钮 aria-expanded +
 *    aria-activedescendant 指向高亮行、药丸元素存在；
 *  - 键盘：ArrowDown 移动高亮（首跳瞬移到选中行再 +1）、Enter 选中、Esc 关闭；
 *  - 指针：pointerover 移动高亮、点击换值触发 onChange + 根节点 data-swap
 *    模糊交换标记（animationend 后摘除）；
 *  - 外点 pointerdown 关闭（is-closing 收起相位后卸载）；
 *  - 回归：弹层 portal 到 document.body + fixed 内联
 *    left/top/min-width（定位完成前 visibility:hidden），卡片内滚动即收起
 *    （与 DatePicker 同口径）。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WidgetSelect } from "./WidgetSelect";

const opts = [
  { value: "m", label: "米" },
  { value: "f", label: "英尺" },
  { value: "km", label: "千米" }
];

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
if (!window.PointerEvent) window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;

const openMenu = () => {
  fireEvent.click(screen.getByRole("combobox", { name: "单位" }));
  return screen.getByRole("listbox", { name: "单位" });
};

describe("WidgetSelect glide 行为", () => {
  it("打开：药丸存在，选中行静息高亮，activedescendant 指向选中行", () => {
    render(<WidgetSelect value="f" onChange={() => {}} options={opts} ariaLabel="单位" />);
    const list = openMenu();
    expect(list.querySelector(".wsel-pill")).toBeTruthy();
    const rows = list.querySelectorAll("[role='option']");
    expect(rows.length).toBe(3);
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].className).toContain("is-selected");
    const trigger = screen.getByRole("combobox", { name: "单位" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(rows[1].id);
  });

  it("键盘：ArrowDown 移动高亮，Enter 选中并收起", () => {
    const onChange = vi.fn();
    render(<WidgetSelect value="f" onChange={onChange} options={opts} ariaLabel="单位" />);
    const trigger = screen.getByRole("combobox", { name: "单位" });
    openMenu();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const rows = document.querySelectorAll("[role='option']");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(rows[2].id);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("km");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Esc 直接关闭；再开时选中行恢复静息高亮", () => {
    render(<WidgetSelect value="m" onChange={() => {}} options={opts} ariaLabel="单位" />);
    const trigger = screen.getByRole("combobox", { name: "单位" });
    openMenu();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    openMenu();
    const rows = document.querySelectorAll("[role='option']");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(rows[0].id);
  });

  it("指针悬停移动高亮，点击换值触发 onChange + data-swap 标记", () => {
    const onChange = vi.fn();
    const { container } = render(<WidgetSelect value="m" onChange={onChange} options={opts} ariaLabel="单位" />);
    openMenu();
    const list = screen.getByRole("listbox", { name: "单位" });
    const third = list.querySelectorAll("[role='option']")[2];
    fireEvent.pointerOver(third);
    const trigger = screen.getByRole("combobox", { name: "单位" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(third.id);
    fireEvent.click(third);
    expect(onChange).toHaveBeenCalledWith("km");
    expect(container.querySelector(".wsel")!.hasAttribute("data-swap")).toBe(true);
    // animationend 摘标记（animationName 过滤；jsdom 需手动带上该属性）
    const end = new Event("animationend", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: "wsel-swap" });
    fireEvent(container.querySelector(".wsel")!, end);
    expect(container.querySelector(".wsel")!.hasAttribute("data-swap")).toBe(false);
  });

  it("外点 pointerdown：先进入 is-closing 收起相位再卸载", async () => {
    render(<WidgetSelect value="m" onChange={() => {}} options={opts} ariaLabel="单位" />);
    openMenu();
    fireEvent.pointerDown(document.body, { bubbles: true });
    expect(document.querySelector(".wsel-pop.is-closing")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull(), { timeout: 300 });
  });

  it("选同值不触发 onChange，菜单仍收起", () => {
    const onChange = vi.fn();
    render(<WidgetSelect value="m" onChange={onChange} options={opts} ariaLabel="单位" />);
    openMenu();
    const rows = document.querySelectorAll("[role='option']");
    fireEvent.click(rows[0]);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("WidgetSelect 弹层 portal 化（X-2）", () => {
  it("打开后弹层挂载在 document.body 下（portal 生效，不在 .wsel 容器内）", () => {
    const { container } = render(<WidgetSelect value="m" onChange={() => {}} options={opts} ariaLabel="单位" />);
    openMenu();
    const pop = document.querySelector(".wsel-pop");
    expect(pop).toBeTruthy();
    // portal：直接父节点是 body，而不是 .wsel wrap（container 内）
    expect(pop!.parentElement).toBe(document.body);
    expect(container.contains(pop)).toBe(false);
  });

  it("渲染后写入内联 left/top/min-width（fixed 定位完成），定位前不可见", () => {
    render(<WidgetSelect value="m" onChange={() => {}} options={opts} ariaLabel="单位" />);
    openMenu();
    const pop = document.querySelector(".wsel-pop") as HTMLElement;
    expect(pop.style.left).toMatch(/^-?\d+(\.\d+)?px$/);
    expect(pop.style.top).toMatch(/^-?\d+(\.\d+)?px$/);
    // jsdom gBCR 全 0 → minWidth 为 0（React 对 0 不缀 px 单位），只断言已内联写入
    expect(pop.style.minWidth).toMatch(/^-?\d+(\.\d+)?(px)?$/);
    // 定位完成后不再处于隐藏态（hidden 只存在于首帧定位前）
    expect(pop.style.visibility).not.toBe("hidden");
  });

  it("卡片内滚动（capture scroll）即收起弹层（is-closing 后卸载）", async () => {
    render(<WidgetSelect value="m" onChange={() => {}} options={opts} ariaLabel="单位" />);
    openMenu();
    fireEvent.scroll(window);
    expect(document.querySelector(".wsel-pop.is-closing")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull(), { timeout: 300 });
  });

  it("菜单列表自身的滚动不收起（wsel-list 内 overflow 滚动豁免）", () => {
    render(<WidgetSelect value="m" onChange={() => {}} options={opts} ariaLabel="单位" />);
    const list = openMenu();
    fireEvent.scroll(list);
    expect(document.querySelector(".wsel-pop.is-closing")).toBeNull();
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });
});
