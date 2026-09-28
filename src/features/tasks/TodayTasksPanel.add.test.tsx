/**
 * 今日待办添加链路回归（用户反馈「今日待办添加不上」）：
 *  - 表单回车 / 点「+」→ 任务入列、输入框清空、列表可见；
 *  - 自然语言截止（"明天下午3点交物业费"）→ 入列并带 dueAt；
 *  - 今日概览的快捷添加同样入列。
 * jsdom 走 localStorage 持久化（resolvePersistenceAdapter 特性检测）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TodayTasksPanel } from "./TodayTasksPanel";
import { TodayOverviewWidget } from "../../widget/widgets/TodayOverviewWidget";
import { useAppStore } from "../../store/app-store";

const ID = "w-todo";

describe("TodayTasksPanel 快捷添加", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ tasks: [] });
  });

  it("回车提交：任务入列、输入框清空、列表渲染新行", () => {
    render(<TodayTasksPanel instanceId={ID} />);
    const input = screen.getByLabelText("待办标题") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "写周报" } });
    fireEvent.submit(input.closest("form")!);
    expect(useAppStore.getState().tasks.map((t) => t.title)).toContain("写周报");
    expect(input.value).toBe("");
    expect(screen.getByText("写周报")).toBeTruthy();
  });

  it("点「+」按钮提交：同样入列", () => {
    render(<TodayTasksPanel instanceId={ID} />);
    const input = screen.getByLabelText("待办标题") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "买牛奶" } });
    fireEvent.click(screen.getByLabelText("添加待办"));
    expect(useAppStore.getState().tasks.map((t) => t.title)).toContain("买牛奶");
    expect(screen.getByText("买牛奶")).toBeTruthy();
  });

  it("自然语言截止：入列并写入明天 15:00 的 dueAt", () => {
    render(<TodayTasksPanel instanceId={ID} />);
    const input = screen.getByLabelText("待办标题") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "明天下午3点交物业费" } });
    fireEvent.submit(input.closest("form")!);
    const task = useAppStore.getState().tasks.find((t) => t.title === "交物业费");
    expect(task).toBeTruthy();
    expect(task!.dueAt).not.toBe("");
    expect(new Date(task!.dueAt).getHours()).toBe(15);
  });

  it("纯空白输入不入列（防抖动空行）", () => {
    render(<TodayTasksPanel instanceId={ID} />);
    const input = screen.getByLabelText("待办标题") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(useAppStore.getState().tasks).toHaveLength(0);
  });
});

describe("TodayOverviewWidget 快捷添加", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ tasks: [] });
  });

  it("概览底部输入框回车：任务入列（今日待办区块计数联动）", () => {
    render(<TodayOverviewWidget instanceId={ID} />);
    const input = screen.getByPlaceholderText("快速添加待办…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "预约牙医" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useAppStore.getState().tasks.map((t) => t.title)).toContain("预约牙医");
    expect(input.value).toBe("");
    expect(screen.getByText("预约牙医")).toBeTruthy();
  });
});
