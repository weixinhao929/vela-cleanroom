import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { dayKeyOf } from "../../../lib/use-now";
import { useHabitsStore, type Habit } from "../../../store/habits-store";
import { HabitMini } from "./HabitMini";

/**
 * HabitMini 回归：今日打卡 x/y 小环，数据只读 habits-store；全部完成挂 .is-complete。
 */
const habit = (id: string, done: Record<string, boolean> = {}): Habit => ({ id, name: id, done });

afterEach(() => {
  useHabitsStore.setState({ habits: [] });
});

describe("HabitMini", () => {
  it("x/y 计数：只算今天键为 true 的习惯；环进度 = x/y", () => {
    const today = dayKeyOf(new Date());
    useHabitsStore.setState({
      habits: [habit("a", { [today]: true }), habit("b", { "2000-01-01": true }), habit("c", { [today]: false })]
    });
    const { container } = render(<HabitMini />);
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(container.querySelector(".dock-ring")).not.toBeNull();
    expect(container.querySelector(".dock-mini-habit")).not.toHaveClass("is-complete");
  });

  it("全部完成：挂 .is-complete；无习惯显示 0/0 不挂", () => {
    const today = dayKeyOf(new Date());
    useHabitsStore.setState({ habits: [habit("a", { [today]: true }), habit("b", { [today]: true })] });
    const { container, unmount } = render(<HabitMini />);
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(container.querySelector(".dock-mini-habit")).toHaveClass("is-complete");
    unmount();

    useHabitsStore.setState({ habits: [] });
    const { container: empty } = render(<HabitMini />);
    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(empty.querySelector(".dock-mini-habit")).not.toHaveClass("is-complete");
  });
});
