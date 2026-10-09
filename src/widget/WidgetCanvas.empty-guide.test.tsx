/**
 * 空态引导卡开关回归：「当前视图还没有小组件」引导卡此前无任何
 * 关闭途径。现在桌面空白处右键菜单提供「隐藏 / 显示空视图引导」，持久化
 * 在 settings extra.hideEmptyGuide（全局），关闭后空视图不再渲染引导卡。
 *
 * 环境要点同 WidgetCanvas.panels.test：预写空布局键跳过默认种子播种，
 * hydrate 完成后（bootDone）引导卡出现。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WidgetCanvas } from "./WidgetCanvas";
import { useWidgetStore } from "./widget-store";
import { useSettingsStore } from "../store/settings-store";
import { ContextMenuHost } from "../components/ContextMenu";

const LAYOUT_KEY = "focus-desk.screen.0.widgets.home.v1";

const pristineWidgets = useWidgetStore.getState();
const pristineSettings = useSettingsStore.getState();

const guide = () => screen.queryByText("当前视图还没有小组件");

/** 等引导卡出现 / 消失（bootDone 与 useDelayedUnmount 都是异步窗口）。 */
async function guideShown() {
  await waitFor(() => expect(guide()).toBeTruthy(), { timeout: 2000 });
}
async function guideGone() {
  await waitFor(() => expect(guide()).toBeNull(), { timeout: 2000 });
}

describe("空视图引导卡开关", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([]));
    useWidgetStore.setState({ ...pristineWidgets, editMode: false, selectedIds: [] }, true);
    useSettingsStore.setState({ extra: { ...pristineSettings.extra, hideEmptyGuide: false } });
  });
  afterEach(() => {
    useWidgetStore.setState(pristineWidgets, true);
    useSettingsStore.setState(pristineSettings);
    localStorage.clear();
  });

  /** 画布 + 菜单宿主（ContextMenuHost 挂在 App 层，画布单测需自带）。 */
  const mount = () =>
    render(
      <>
        <WidgetCanvas />
        <ContextMenuHost />
      </>
    );

  it("空视图默认显示引导卡；置 hideEmptyGuide 后即时隐藏，复位后恢复", async () => {
    mount();
    await guideShown();

    useSettingsStore.getState().setExtra({ hideEmptyGuide: true });
    await guideGone();

    useSettingsStore.getState().setExtra({ hideEmptyGuide: false });
    await guideShown();
  });

  it("桌面空白处右键 →「隐藏空视图引导」切换持久化开关，卡随之卸载", async () => {
    const { container } = mount();
    await guideShown();

    const canvas = container.querySelector(".widget-canvas") as HTMLElement;
    expect(canvas).not.toBeNull();
    fireEvent.contextMenu(canvas);

    // 真实 ContextMenu 渲染为 role=menu；按文本点菜单项。
    const item = await screen.findByRole("menuitem", { name: "隐藏空视图引导" });
    fireEvent.click(item);
    expect(useSettingsStore.getState().extra.hideEmptyGuide).toBe(true);
    await guideGone();

    // 关闭后菜单标签翻转为「显示」，可再开回来。
    fireEvent.contextMenu(canvas);
    fireEvent.click(await screen.findByRole("menuitem", { name: "显示空视图引导" }));
    expect(useSettingsStore.getState().extra.hideEmptyGuide).toBe(false);
    await guideShown();
  });

  it("开关关闭时右键菜单的「添加小组件」仍在（添加入口不因隐藏引导而丢失）", async () => {
    useSettingsStore.getState().setExtra({ hideEmptyGuide: true });
    const { container } = mount();
    await guideGone();

    const canvas = container.querySelector(".widget-canvas") as HTMLElement;
    fireEvent.contextMenu(canvas);
    expect(await screen.findByRole("menuitem", { name: "添加小组件" })).toBeInTheDocument();
  });
});
