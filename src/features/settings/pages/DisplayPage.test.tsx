/**
 * 设置页 · 显示器页回归（2026-10）：
 *  - set_monitor 失败（空屏无窗口）→ 先对账再重试；仍失败给出错误态 msg；
 *  - DPI 缩放比展示、复制按钮在仅有单屏时隐藏；
 *  - 手动刷新入口回调；
 *  - ：管理此屏小组件 → onManage(slot)。
 * lib/tauri 与 screen-layout-copy 全量 mock，聚焦交互契约。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("../../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...actual,
    isTauri: () => true,
    invoke: (...args: unknown[]) => invokeMock(...args)
  };
});
const copyMock = vi.fn();
vi.mock("../../../widget/screen-layout-copy", () => ({
  copyScreenLayout: (...args: unknown[]) => copyMock(...args)
}));
vi.mock("../../../components/PromptDialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
  choiceDialog: vi.fn().mockResolvedValue(null),
  promptDialog: vi.fn(),
  alertDialog: vi.fn().mockResolvedValue(undefined)
}));

import { DisplayPage, type MonitorInfo } from "./DisplayPage";
import { useWidgetStore } from "../../../widget/widget-store";

const MONITORS: MonitorInfo[] = [
  { id: 0, name: "DELL U2720", x: 0, y: 0, width: 2560, height: 1440, scale: 1.5, is_primary: true },
  { id: 1, name: "LG 27UP", x: 2560, y: 0, width: 1920, height: 1080, is_primary: false }
];

describe("DisplayPage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    copyMock.mockReset();
    useWidgetStore.setState({ screenId: "0" });
  });

  it("管理分区提示指向当前 screenId 对应的显示器名", () => {
    render(<DisplayPage monitors={MONITORS} />);
    expect(screen.getByText("DELL U2720", { selector: ".tm-monitor-managed-hint b" })).toBeInTheDocument();
  });

  it("展示 DPI 缩放比（物理分辨率行带 150%）", () => {
    render(<DisplayPage monitors={MONITORS} />);
    expect(screen.getByText(/150%/)).toBeInTheDocument();
  });

  it("「在此显示器显示」成功后显示成功反馈", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<DisplayPage monitors={MONITORS} />);
    fireEvent.click(screen.getAllByText("在此显示器显示")[1]);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_monitor", { id: 1 }));
    await waitFor(() => expect(screen.getByText(/已切换到/)).toBeInTheDocument());
    // 成功路径不排对账。
    expect(invokeMock).not.toHaveBeenCalledWith("reconcile_widget_windows");
  });

  it("B3：set_monitor 失败（空屏无窗口）→ 先对账再重试一次", async () => {
    let failed = false;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "set_monitor" && !failed) {
        failed = true;
        return Promise.reject("显示器 1 不存在");
      }
      return Promise.resolve(undefined);
    });
    render(<DisplayPage monitors={MONITORS} />);
    fireEvent.click(screen.getAllByText("在此显示器显示")[1]);
    await waitFor(() => expect(screen.getByText(/已切换到/)).toBeInTheDocument());
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    // 对账在前，重试在后。
    expect(calls.indexOf("reconcile_widget_windows")).toBeLessThan(calls.lastIndexOf("set_monitor"));
    expect(calls.filter((c) => c === "set_monitor")).toHaveLength(2);
  });

  it("B3：重试仍失败 → 错误态反馈（is-error）", async () => {
    invokeMock.mockRejectedValue("显示器 1 不存在");
    render(<DisplayPage monitors={MONITORS} />);
    fireEvent.click(screen.getAllByText("在此显示器显示")[1]);
    await waitFor(() => expect(screen.getByText(/切换失败/)).toBeInTheDocument());
    expect(document.querySelector(".tm-monitor-msg.is-error")).not.toBeNull();
  });

  it("C7：手动刷新按钮回调 onRefresh", () => {
    const onRefresh = vi.fn();
    render(<DisplayPage monitors={MONITORS} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByLabelText("刷新显示器列表"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("C2：「管理此屏小组件」带槽位回调 onManage", () => {
    const onManage = vi.fn();
    render(<DisplayPage monitors={MONITORS} onManage={onManage} />);
    fireEvent.click(screen.getByText("管理此屏小组件"));
    expect(onManage).toHaveBeenCalledWith(1);
  });

  it("C6：多屏时每张卡片都有「复制布局到此屏」，单屏时隐藏", () => {
    const { rerender } = render(<DisplayPage monitors={MONITORS} />);
    expect(screen.getAllByText("复制布局到此屏")).toHaveLength(2);
    rerender(<DisplayPage monitors={[MONITORS[0]]} />);
    expect(screen.queryByText("复制布局到此屏")).toBeNull();
  });

  it("复制流程：两屏直达确认（无选择弹窗），确认后按 (源, 目标) 调 copyScreenLayout", async () => {
    copyMock.mockReturnValue({ views: 2, instances: 3 });
    render(<DisplayPage monitors={MONITORS} />);
    fireEvent.click(screen.getAllByText("复制布局到此屏")[1]);
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith("0", "1"));
    await waitFor(() => expect(screen.getByText(/已复制 2 个视图、3 个小组件/)).toBeInTheDocument());
  });

  it("复制流程：源屏无可复制布局时给错误反馈", async () => {
    copyMock.mockReturnValue(null);
    render(<DisplayPage monitors={MONITORS} />);
    fireEvent.click(screen.getAllByText("复制布局到此屏")[1]);
    await waitFor(() => expect(screen.getByText("该显示器还没有可复制的布局")).toBeInTheDocument());
    expect(document.querySelector(".tm-monitor-msg.is-error")).not.toBeNull();
  });
});
