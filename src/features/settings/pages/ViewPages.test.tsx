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

  it("B2：视图不存在时自动重定向到剩余第一个视图，并渲染空态而非空白页", () => {
    const onNavigate = vi.fn();
    render(<ViewPage view="ghost" onNavigate={onNavigate} />);
    expect(onNavigate).toHaveBeenCalledWith("view-home");
    expect(screen.getByText("该视图不存在或已被删除。")).toBeInTheDocument();
  });

  it("C3：下移按钮把视图移到目标位置（store + 持久化同步）", () => {
    render(<ViewPage view="home" onNavigate={() => {}} />);
    const homeRow = screen.getByTitle("切换到 Home");
    fireEvent.click(within(homeRow).getByRole("button", { name: "下移" }));
    expect(useWidgetStore.getState().views.map((v) => v.id)).toEqual(["work", "home", "focus"]);
    const persisted = JSON.parse(localStorage.getItem("focus-desk.screen.0.widgets.views.v1") ?? "[]") as {
      id: string;
    }[];
    expect(persisted.map((v) => v.id)).toEqual(["work", "home", "focus"]);
    // 重排后行首（work）的上移禁用。
    const firstRow = screen.getByTitle("切换到 Work");
    expect(within(firstRow).getByRole("button", { name: "上移" })).toBeDisabled();
    expect(within(firstRow).getByRole("button", { name: "下移" })).toBeEnabled();
  });

  it("C3：「复制视图」克隆当前视图（名称带副本后缀并避开重名）", () => {
    localStorage.setItem(
      "focus-desk.screen.0.widgets.focus.v1",
      JSON.stringify([{ id: "w1", type: "notes", x: 0, y: 0, w: 50, h: 50, z: 1 }])
    );
    localStorage.setItem("focus-desk.notes.w1", "内容");
    const onNavigate = vi.fn();
    render(<ViewPage view="focus" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("复制视图"));
    const st = useWidgetStore.getState();
    expect(st.views).toHaveLength(4);
    const added = st.views.at(-1)!;
    expect(added.name).toContain("副本");
    expect(onNavigate).toHaveBeenCalledWith(`view-${added.id}`);
    // 克隆布局落盘、实例 id 重造、数据桶搬家。
    const cloned = JSON.parse(localStorage.getItem(`focus-desk.screen.0.widgets.${added.id}.v1`) ?? "[]") as {
      id: string;
    }[];
    expect(cloned).toHaveLength(1);
    expect(cloned[0].id).not.toBe("w1");
    expect(localStorage.getItem(`focus-desk.notes.${cloned[0].id}`)).toBe("内容");
  });

  it("C1：多屏时标题旁显示「作用于」徽标（点击跳显示器页），单屏不显示", () => {
    const monitors = [
      { id: 0, name: "主屏", x: 0, y: 0, width: 1920, height: 1080, is_primary: true },
      { id: 1, name: "副屏", x: 1920, y: 0, width: 1920, height: 1080, is_primary: false }
    ];
    const onNavigate = vi.fn();
    const { rerender } = render(<ViewPage view="home" onNavigate={onNavigate} monitors={monitors} />);
    const chip = screen.getByTitle(/视图与小组件的添加、配置作用于：/);
    expect(chip.textContent).toContain("作用于：主屏");
    fireEvent.click(chip);
    expect(onNavigate).toHaveBeenCalledWith("display");
    rerender(<ViewPage view="home" onNavigate={onNavigate} />);
    expect(screen.queryByTitle(/视图与小组件的添加、配置作用于：/)).toBeNull();
  });
});
