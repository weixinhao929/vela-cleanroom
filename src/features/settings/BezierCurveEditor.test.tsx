/**
 * 贝塞尔曲线编辑器（BezierCurveEditor）行为测试：
 *  - 数值框 Esc：编辑未提交的草稿文本还原为当前曲线值，onChange 不被触发；
 *    越界值（X 超出 0~1）blur/Enter 提交被拒并给出原因，已保存值不变；
 *  - 提交通道：合法手输提交、控制点键盘拖动（slider 方向键）、预设芯片点击
 *    携带的回调载荷都是合法 cubic-bezier（bezierValidity 通过，X ∈ [0,1]）。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BezierCurveEditor } from "./BezierCurveEditor";
import { bezierValidity, type BezierPoints } from "../../lib/bezier";

const VALUE: BezierPoints = [0.4, 0, 0.2, 1];

describe("BezierCurveEditor · 数值输入", () => {
  it("编辑未提交期间 onChange 不触发；blur 提交合法值回调一次", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BezierCurveEditor value={VALUE} onChange={onChange} />);
    const x1 = screen.getByLabelText("x1") as HTMLInputElement;
    await user.clear(x1);
    await user.type(x1, "0.55");
    expect(onChange).not.toHaveBeenCalled();
    await user.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([0.55, 0, 0.2, 1]);
  });

  it("Esc 还原草稿：输入框回到当前曲线值且 onChange 不被触发（不退化成提交）", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BezierCurveEditor value={VALUE} onChange={onChange} />);
    const x1 = screen.getByLabelText("x1") as HTMLInputElement;
    await user.clear(x1);
    await user.type(x1, "0.55");
    // Esc：同步 blur 会带旧闭包触发 onBlur——escapedRef 守卫须拦下这次提交。
    fireEvent.keyDown(x1, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(x1).toHaveValue("0.4");
    // 还原后的下一次正常 blur 仍走提交通道（守卫只拦一次）。
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("越界拒绝：x1 提交 2 → 状态行「X 需在 0~1 之间」，已保存值不变；改回合法值提交成功", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BezierCurveEditor value={VALUE} onChange={onChange} />);
    const x1 = screen.getByLabelText("x1") as HTMLInputElement;
    await user.clear(x1);
    await user.type(x1, "2{enter}");
    expect(screen.getByRole("status")).toHaveTextContent("X 需在 0~1 之间");
    expect(onChange).not.toHaveBeenCalled();

    await user.clear(x1);
    await user.type(x1, "0.5{enter}");
    expect(onChange).toHaveBeenCalledWith([0.5, 0, 0.2, 1]);
    expect(screen.getByRole("status")).toHaveTextContent("曲线合法");
    // CSS 串同步为提交后的合法曲线。
    expect(document.querySelector(".tm-bezier-css")?.textContent).toBe("cubic-bezier(0.5, 0, 0.2, 1)");
  });
});

describe("BezierCurveEditor · 提交通道携带合法 cubic-bezier", () => {
  it("控制点键盘拖动：方向键步进触发的每次回调都合法（X ∈ [0,1]、曲线单调）", async () => {
    const onChange = vi.fn();
    render(<BezierCurveEditor value={VALUE} onChange={onChange} />);
    const c1 = screen.getByRole("slider", { name: "控制点 1" });
    c1.focus();
    fireEvent.keyDown(c1, { key: "ArrowRight" });
    fireEvent.keyDown(c1, { key: "ArrowUp" });
    fireEvent.keyDown(c1, { key: "ArrowUp", shiftKey: true });
    expect(onChange).toHaveBeenCalled();
    for (const call of onChange.mock.calls) {
      const p = call[0] as BezierPoints;
      expect(bezierValidity(p).ok).toBe(true);
      expect(p[0]).toBeGreaterThanOrEqual(0);
      expect(p[0]).toBeLessThanOrEqual(1);
      expect(p[2]).toBeGreaterThanOrEqual(0);
      expect(p[2]).toBeLessThanOrEqual(1);
    }
    // 第一次回调：x1 步进 0.01（0.4 → 0.41）。
    expect((onChange.mock.calls[0][0] as BezierPoints)[0]).toBeCloseTo(0.41, 3);
  });

  it("预设芯片：点「线性」→ onChange 收到 [0,0,1,1]，画板回显该曲线；值回填后重复点击不重复回调", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(<BezierCurveEditor value={VALUE} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "线性" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([0, 0, 1, 1]);
    expect(document.querySelector(".tm-bezier-css")?.textContent).toBe("cubic-bezier(0, 0, 1, 1)");
    // 父组件回填新值后（与草稿一致）：再点同一预设不重复回调（samePoints 守卫）。
    view.rerender(<BezierCurveEditor value={[0, 0, 1, 1]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "线性" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
