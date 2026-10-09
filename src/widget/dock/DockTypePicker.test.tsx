/**
 * DockTypePicker（入口 b）组件测试：分组列出全部 registry 类型 + 迷你形态标记、
 * 搜索（名称 / 拼音首字母 / 类型 id）、回车选首条、点选 onPick、Esc / 外点 / × 的
 * 关闭原因、↑/↓ 焦点移动、groupPickerItems 纯函数。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { WIDGET_REGISTRY } from "../registry";
import { DockTypePicker, groupPickerItems } from "./DockTypePicker";

const ANCHOR = { x: 400, y: 10, w: 32, h: 32 };
const identity = (zh: string) => zh;

describe("groupPickerItems", () => {
  it("空查询：四组按 registry 顺序覆盖全部类型", () => {
    const groups = groupPickerItems(WIDGET_REGISTRY, "", identity);
    expect(groups.map((g) => g.category)).toEqual(["focus", "tools", "system", "online"]);
    const all = groups.flatMap((g) => g.items.map((m) => m.type));
    expect(all.sort()).toEqual(WIDGET_REGISTRY.map((m) => m.type).sort());
    const tools = groups.find((g) => g.category === "tools")!.items.map((m) => m.type);
    expect(tools).toEqual(WIDGET_REGISTRY.filter((m) => m.category === "tools").map((m) => m.type));
  });

  it("拼音首字母「jsq」命中计算器且排首位；类型 id「calc」命中；无命中 → 空", () => {
    const byPinyin = groupPickerItems(WIDGET_REGISTRY, "jsq", identity).flatMap((g) => g.items);
    expect(byPinyin[0]?.type).toBe("calculator");
    const byId = groupPickerItems(WIDGET_REGISTRY, "calc", identity).flatMap((g) => g.items);
    expect(byId.map((m) => m.type)).toContain("calculator");
    expect(groupPickerItems(WIDGET_REGISTRY, "zzzzzz", identity)).toEqual([]);
  });

  it("名称命中的分数高于描述命中：搜「时钟」时钟排在含「时钟」描述的类型之前", () => {
    const hits = groupPickerItems(WIDGET_REGISTRY, "时钟", identity).flatMap((g) => g.items);
    expect(hits[0]?.type).toBe("clock");
  });

  it("P1-1 跨类搜索：组间按组内最高分降序——tools 强匹配不被 focus 弱匹配劫持", () => {
    /* 「时」同时命中 clock / stopwatch（tools，名称强匹配）与 countdown /
       pomodoro / deadlines（focus，描述弱匹配）——修复前组序固定
       focus>tools，flatMap 首项是 focus 的弱匹配；修复后全局最佳（clock）
       第一。 */
    const flat = groupPickerItems(WIDGET_REGISTRY, "时", identity).flatMap((g) => g.items);
    expect(flat.length).toBeGreaterThan(2);
    expect(flat[0]?.type).toBe("clock");
    // tools 的次强匹配也在 focus 弱匹配之前（组间 + 组内双降序的拉平序）。
    const types = flat.map((m) => m.type);
    expect(types.indexOf("stopwatch")).toBeLessThan(types.indexOf("countdown"));
    // 单一强匹配查询：组间排序不影响结果（回归保护）。
    const solo = groupPickerItems(WIDGET_REGISTRY, "jsq", identity);
    expect(solo.map((g) => g.category)).toEqual(["tools"]);
  });

  it("P1-1 空查询保持固定分类序（组间排序只在有 query 时生效）", () => {
    const groups = groupPickerItems(WIDGET_REGISTRY, "  ", identity);
    expect(groups.map((g) => g.category)).toEqual(["focus", "tools", "system", "online"]);
  });
});

describe("DockTypePicker 组件", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染分组条目：除 hidden 内部类型外全部可见，富形态类型（时钟）带「迷你形态」标记，通用类型（计算器）无标记", () => {
    render(<DockTypePicker anchor={ANCHOR} open onClose={() => {}} onPick={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "添加到灵动岛" });
    // hidden（贴图，截图钉图专属）不进选择器；+1 是关闭按钮。
    expect(within(dialog).getAllByRole("button").length).toBe(WIDGET_REGISTRY.filter((w) => !w.hidden).length + 1);
    expect(within(dialog).getByText("专注")).toBeTruthy();
    expect(within(dialog).getByText("工具")).toBeTruthy();
    expect(within(dialog).getByText("系统")).toBeTruthy();
    expect(within(dialog).getByText("在线")).toBeTruthy();
    const clock = within(dialog).getByRole("button", { name: /时钟/ });
    expect(within(clock).getByText("迷你形态")).toBeTruthy();
    const calc = within(dialog).getByRole("button", { name: /^计算器/ });
    expect(within(calc).queryByText("迷你形态")).toBeNull();
  });

  it("搜索过滤 + 回车选首条；点选条目 onPick(type)", () => {
    const onPick = vi.fn();
    render(<DockTypePicker anchor={ANCHOR} open onClose={() => {}} onPick={onPick} />);
    const input = screen.getByLabelText("搜索小组件类型") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "jsq" } });
    const dialog = screen.getByRole("dialog");
    const items = within(dialog)
      .getAllByRole("button")
      .filter((b) => b.classList.contains("dock-picker-item"));
    expect(items[0].textContent).toContain("计算器");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("calculator");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^书签/ }));
    expect(onPick).toHaveBeenLastCalledWith("bookmarks");

    fireEvent.change(input, { target: { value: "zzzzzz" } });
    expect(within(dialog).getByText("没有匹配的类型")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("isTypeDisabled（入岛去重）：已在岛上的类型禁用 + 「已在灵动岛」徽标、不可点选，回车与 ↑/↓ 都跳过它", () => {
    const onPick = vi.fn();
    render(
      <DockTypePicker
        anchor={ANCHOR}
        open
        onClose={() => {}}
        onPick={onPick}
        isTypeDisabled={(type) => type === "calculator" || type === "clock"}
      />
    );
    const dialog = screen.getByRole("dialog");
    const calc = within(dialog).getByRole("button", { name: /^计算器/ });
    expect(calc).toBeDisabled();
    expect(within(calc).getByText("已在灵动岛")).toBeTruthy();
    const clock = within(dialog).getByRole("button", { name: /时钟/ });
    expect(clock).toBeDisabled();
    expect(within(clock).queryByText("迷你形态")).toBeNull();
    fireEvent.click(calc);
    expect(onPick).not.toHaveBeenCalled();

    // 搜「jsq」只剩计算器（禁用）→ 回车不选。
    const input = screen.getByLabelText("搜索小组件类型") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "jsq" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();

    // 空查询：↓ 从搜索框下来落到第一枚可用条目（跳过禁用的）。
    fireEvent.change(input, { target: { value: "" } });
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const focused = document.activeElement as HTMLButtonElement;
    expect(focused.classList.contains("dock-picker-item")).toBe(true);
    expect(focused.disabled).toBe(false);
  });

  it("Esc / 外点 / × 分别以 escape / outside / button 关闭；弹层内 pointerdown 不关闭", () => {
    const onClose = vi.fn();
    render(<DockTypePicker anchor={ANCHOR} open onClose={onClose} onPick={() => {}} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(dialog, { button: 0 });
    expect(onClose).not.toHaveBeenCalled();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside, { button: 0 });
    expect(onClose).toHaveBeenLastCalledWith("outside");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenLastCalledWith("escape");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenLastCalledWith("button");
    expect(onClose).toHaveBeenCalledTimes(3);
    outside.remove();
  });

  it("↑/↓ 在搜索框与条目间移焦点；按键不冒泡到外层", () => {
    const outerKey = vi.fn();
    render(
      <div onKeyDown={outerKey}>
        <DockTypePicker anchor={ANCHOR} open onClose={() => {}} onPick={() => {}} />
      </div>
    );
    const input = screen.getByLabelText("搜索小组件类型");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const first = document.activeElement as HTMLElement;
    expect(first.classList.contains("dock-picker-item")).toBe(true);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.classList.contains("dock-picker-item")).toBe(true);
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
    expect(outerKey).not.toHaveBeenCalled();
  });

  it("关闭后延迟卸载：open 翻假仍保留 .is-closing 一拍，随后卸载", async () => {
    const { rerender } = render(<DockTypePicker anchor={ANCHOR} open onClose={() => {}} onPick={() => {}} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(<DockTypePicker anchor={ANCHOR} open={false} onClose={() => {}} onPick={() => {}} />);
    expect(screen.getByRole("dialog").classList.contains("is-closing")).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 220)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
