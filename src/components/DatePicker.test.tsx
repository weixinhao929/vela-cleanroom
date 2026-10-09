/**
 * DatePicker / DateTimePicker 测试：
 *  - portal 生效：打开后弹层 .tm-dp-pop 挂载在 document.body 直下（而非
 *    .tm-dp 容器内）——此前内联渲染被卡片 overflow:auto 裁剪；
 *  - fixed 定位：渲染后按 placePopover 计算出内联 left/top（数值），
 *    定位完成前不可见（visibility:hidden 防闪现）；
 *  - 交互保持：点「今天」触发 onChange 并关闭（useDelayedUnmount 退场后卸载）；
 *  - 滚动关闭：fixed 弹层不随卡片滚动，capture scroll 即请求关闭。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DatePicker, DateTimePicker } from "./DatePicker";

const openPopover = () => {
  fireEvent.click(screen.getByRole("button", { name: "选择日期" }));
  return document.querySelector(".tm-dp-pop") as HTMLElement;
};

describe("DatePicker 弹层 portal 化（Q-3）", () => {
  it("打开后弹层挂载在 document.body 下（portal 生效，不在 .tm-dp 容器内）", () => {
    const { container } = render(<DatePicker value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "选择日期" }));
    const pop = document.querySelector(".tm-dp-pop");
    expect(pop).toBeTruthy();
    // portal：直接父节点是 body，而不是 .tm-dp wrap（container 内）
    expect(pop!.parentElement).toBe(document.body);
    expect(container.contains(pop)).toBe(false);
  });

  it("渲染后写入内联 left/top（fixed 定位完成），不再用 CSS 的 top/right 偏移", () => {
    render(<DatePicker value="" onChange={() => {}} />);
    const pop = openPopover();
    expect(pop.style.left).toMatch(/^-?\d+(\.\d+)?px$/);
    expect(pop.style.top).toMatch(/^-?\d+(\.\d+)?px$/);
  });

  it("点「今天」触发 onChange 并关闭（退场窗口后卸载）", async () => {
    const onChange = vi.fn();
    render(<DatePicker value="" onChange={onChange} />);
    openPopover();
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 500 });
  });

  it("窗口滚动（capture）即关闭弹层", async () => {
    render(<DatePicker value="" onChange={() => {}} />);
    openPopover();
    fireEvent.scroll(window);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 500 });
  });

  it("DateTimePicker 弹层同样 portal 到 body 且带时间行", () => {
    render(<DateTimePicker value="2026-10-08T09:30" onChange={() => {}} />);
    // 有值时触发钮的可访问名是显示值（占位符只在空值时出现）
    fireEvent.click(screen.getByRole("button", { name: /2026-10-08/ }));
    const pop = document.querySelector(".tm-dp-pop");
    expect(pop).toBeTruthy();
    expect(pop!.parentElement).toBe(document.body);
    expect(pop!.querySelector(".tm-dp-time")).toBeTruthy();
  });
});
