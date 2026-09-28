import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "../../../domain/schemas";
import { useAppStore } from "../../../store/app-store";
import { TodoMini } from "./TodoMini";

/**
 * TodoMini 回归：「今日剩余 N」= 未完成且（无截止 | 截止 ≤ 今天）的任务数，
 * 未来到期不计；全部完成显 ✓ +「全部完成」。数据只读 useAppStore.tasks。
 */
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  completed: false,
  createdAt: "2026-09-16T00:00:00.000Z",
  dueAt: "",
  priority: 0,
  tags: [],
  sortOrder: 0,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 16, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  useAppStore.setState({ tasks: [] });
});

describe("TodoMini", () => {
  it("计数：无截止 + 今天到期 + 逾期 = 3，未来到期与已完成不计", () => {
    useAppStore.setState({
      tasks: [
        task("noDue"),
        task("today", { dueAt: new Date(2026, 8, 16, 18, 0).toISOString() }),
        task("overdue", { dueAt: new Date(2026, 8, 10, 9, 0).toISOString() }),
        task("future", { dueAt: new Date(2026, 8, 20, 9, 0).toISOString() }),
        task("done", { completed: true })
      ]
    });
    render(<TodoMini />);
    expect(screen.getByText("今日剩余 3")).toBeInTheDocument();
    expect(document.querySelector(".dock-mini-todo")).not.toHaveClass("is-done");
  });

  it("全部完成：显示「全部完成」并挂 .is-done", () => {
    useAppStore.setState({
      tasks: [task("a", { completed: true }), task("future", { dueAt: new Date(2026, 8, 20).toISOString() })]
    });
    render(<TodoMini />);
    expect(screen.getByText("全部完成")).toBeInTheDocument();
    expect(document.querySelector(".dock-mini-todo")).toHaveClass("is-done");
  });
});
