/**
 * 设置页「视图」（ViewPage）回归：列表每一行整行可点——点任意位置 = 切换到该视图并收起
 * 设置窗（与行内「切换」按钮、下方「切换到 X」同一动作）；行内删除按钮不触发切换；
 * 键盘 Enter / 空格同样切换。此前行点击是跳该视图的管理页，用户看到的只是「闪一下」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { ViewPage } from "./ViewPages";
import { useWidgetStore } from "../../../widget/widget-store";
import { useSettingsStore } from "../../../store/settings-store";

const VIEWS = [
  { id: "home", name: "Home" },
  { id: "work", name: "Work" },
  { id: "focus", name: "Focus" }
];
const active = () => useWidgetStore.getState().activeView;
const settingsOpen = () => useSettingsStore.getState().settingsOpen;

describe("ViewPage · 整行点击切换视图", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ settingsOpen: true });
    useWidgetStore.setState({ views: VIEWS, activeView: "focus", instances: [] });
  });

  it("点行的任意位置（这里点名称）→ 切换到该视图并收起设置窗；不再跳该视图的管理页", () => {
    const onNavigate = vi.fn();
    render(<ViewPage view="focus" onNavigate={onNavigate} />);
    const homeRow = screen.getByTitle("切换到 Home");
    expect(homeRow).toHaveAttribute("role", "button");
    fireEvent.click(within(homeRow).getByText("Home"));
    expect(active()).toBe("home");
    expect(settingsOpen()).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("行内「切换」按钮与整行同一动作；行内删除按钮不切换；键盘 Enter 切换", () => {
    render(<ViewPage view="focus" onNavigate={() => {}} />);
    const workRow = screen.getByTitle("切换到 Work");
    fireEvent.click(within(workRow).getByRole("button", { name: "删除视图 Work" }));
    expect(active()).toBe("focus"); // 删除只弹确认框
    expect(settingsOpen()).toBe(true);

    fireEvent.keyDown(workRow, { key: "Enter" });
    expect(active()).toBe("work");
    expect(settingsOpen()).toBe(false);

    useSettingsStore.setState({ settingsOpen: true });
    const homeRow = screen.getByTitle("切换到 Home");
    fireEvent.click(within(homeRow).getByRole("button", { name: "切换" }));
    expect(active()).toBe("home");
    expect(settingsOpen()).toBe(false);
  });

  it("已启用的那一行也可点：动作等同下方「切换到 X」——保持活动视图不变、收起设置窗去看桌面", () => {
    render(<ViewPage view="focus" onNavigate={() => {}} />);
    const focusRow = screen.getByTitle("切换到 Focus");
    expect(within(focusRow).getByText("已启用")).toBeInTheDocument();
    expect(within(focusRow).queryByRole("button", { name: "切换" })).toBeNull();
    fireEvent.click(focusRow);
    expect(active()).toBe("focus");
    expect(settingsOpen()).toBe(false);
  });
});
