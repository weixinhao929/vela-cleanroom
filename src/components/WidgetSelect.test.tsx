/**
 * WidgetSelect（glide 下拉）测试（jsdom）：
 *  - 打开：listbox 渲染、选中行 aria-selected、触发钮 aria-expanded +
 *    aria-activedescendant 指向高亮行、药丸元素存在；
 *  - 键盘：ArrowDown 移动高亮（首跳瞬移到选中行再 +1）、Enter 选中、Esc 关闭；
 *  - 指针：pointerover 移动高亮、点击换值触发 onChange + 根节点 data-swap
 *    模糊交换标记（animationend 后摘除）；
 *  - 外点 pointerdown 关闭（is-closing 收起相位后卸载）。
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
