/**
 * 重命名标签全链路（组件级）：双击标签 → 输入弹窗 → 提交写 instance.label →
 * 标签文本即刻更新；留空提交（allowEmpty）恢复默认名。
 *
 * 回归背景：「重命名不管用」的两个真缺陷——PromptDialog 的空输入守卫把
 * 「留空恢复默认」挡死（提交无反应）；预填自动名又会让原样提交把自动名
 * 固化成 label（视觉零变化）。本文件锁完整交互链。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GroupCard } from "./GroupCard";
import { PromptDialogHost } from "../components/PromptDialog";
import { useWidgetStore, type WidgetGroup, type WidgetInstance } from "./widget-store";

const mkInst = (id: string, over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "clock",
  x: 0,
  y: 0,
  w: 200,
  h: 120,
  z: 1,
  groupId: "g1",
  ...over
});
const mkGroup = (): WidgetGroup => ({
  id: "g1",
  x: 0,
  y: 0,
  w: 400,
  h: 200,
  z: 2,
  memberIds: ["a", "b"],
  activeId: "a"
});

const prev = {
  instances: useWidgetStore.getState().instances,
  groups: useWidgetStore.getState().groups,
  editMode: useWidgetStore.getState().editMode,
  selectedId: useWidgetStore.getState().selectedId,
  selectedIds: useWidgetStore.getState().selectedIds,
  enteringIds: useWidgetStore.getState().enteringIds,
  pulseIds: useWidgetStore.getState().pulseIds
};

const mount = () =>
  render(
    <>
      <PromptDialogHost />
      <GroupCard group={mkGroup()} />
    </>
  );

const dialogInput = () => {
  const dlg = screen.getByRole("dialog");
  return within(dlg).getByRole("textbox");
};

describe("GroupCard 重命名标签（双击 → prompt → store）", () => {
  beforeEach(() => {
    useWidgetStore.setState({
      instances: [mkInst("a"), mkInst("b")],
      groups: [mkGroup()],
      editMode: false,
      selectedId: null,
      selectedIds: [],
      enteringIds: [],
      pulseIds: []
    });
  });

  afterEach(() => {
    useWidgetStore.setState(prev);
  });

  it("双击标签打开弹窗（预填自定义名原值，未命名为空）→ 提交后 label 与标签文本同步", async () => {
    mount();
    fireEvent.doubleClick(screen.getAllByRole("tab")[0]);
    const input = dialogInput();
    // 未命名：预填空串（回归：预填自动名会让原样提交固化自动名）。
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.change(input, { target: { value: "我的时钟" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await waitFor(() => {
      expect(useWidgetStore.getState().instances.find((i) => i.id === "a")!.label).toBe("我的时钟");
    });
    await waitFor(() => {
      expect(screen.getAllByRole("tab")[0].textContent).toContain("我的时钟");
    });
  });

  it("留空提交恢复默认名（allowEmpty 回归：此前空输入被守卫挡死，提交无反应）", async () => {
    useWidgetStore.setState({ instances: [mkInst("a", { label: "旧名字" }), mkInst("b")] });
    mount();
    fireEvent.doubleClick(screen.getAllByRole("tab")[0]);
    const input = dialogInput();
    expect((input as HTMLInputElement).value).toBe("旧名字");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await waitFor(() => {
      expect(useWidgetStore.getState().instances.find((i) => i.id === "a")!.label).toBeUndefined();
    });
    // 标签回落默认名（类型译名，无自定义残留）。
    await waitFor(() => {
      expect(screen.getAllByRole("tab")[0].textContent).not.toContain("旧名字");
    });
  });

  it("取消（Esc）不写入", async () => {
    mount();
    fireEvent.doubleClick(screen.getAllByRole("tab")[0]);
    const input = dialogInput();
    fireEvent.change(input, { target: { value: "不该存在" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(useWidgetStore.getState().instances.find((i) => i.id === "a")!.label).toBeUndefined();
    });
  });

  it("S7：编辑模式选中组按 F2 → 重命名编组弹窗（纯组选中此前无任何键盘路径）", async () => {
    useWidgetStore.setState({ editMode: true, selectedId: "g1", selectedIds: ["g1"] });
    mount();
    fireEvent.keyDown(window, { key: "F2" });
    const dlg = await screen.findByRole("dialog");
    // 组名弹窗：预填组名原值（未命名 = 空）。
    expect(within(dlg).getByRole("textbox")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "桌面常驻" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "重命名" }));
    await waitFor(() => {
      expect(useWidgetStore.getState().groups[0].name).toBe("桌面常驻");
    });
  });

  it("V7：标签 roving tabindex——仅激活标签可 Tab 聚焦，其余 -1（方向键巡览已带焦点随行）", () => {
    mount();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("tabindex", "0"); // activeId = a
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  });

  it("V9：非编辑模式悬停 140ms dwell 自动置顶（对齐卡片行为；提前离开取消）", () => {
    // 抬升要有意义：先放一张更高的散卡压住组。
    useWidgetStore.setState({ instances: [mkInst("a"), mkInst("b"), mkInst("c", { z: 9 })] });
    mount();
    const root = document.querySelector<HTMLElement>(".widget-group")!;
    expect(useWidgetStore.getState().groups[0].z).toBe(2);
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(root);
      vi.advanceTimersByTime(139);
      expect(useWidgetStore.getState().groups[0].z).toBe(2); // 未到 dwell 不抬
      vi.advanceTimersByTime(2);
      expect(useWidgetStore.getState().groups[0].z).toBeGreaterThan(9);
      // 提前离开取消：再次悬停后立刻离开，不再抬升。
      const raised = useWidgetStore.getState().groups[0].z;
      fireEvent.mouseEnter(root);
      fireEvent.mouseLeave(root);
      vi.advanceTimersByTime(200);
      expect(useWidgetStore.getState().groups[0].z).toBe(raised);
    } finally {
      vi.useRealTimers();
    }
  });

  it("V8：组卡卸载时焦点在卡内 → 承接到激活成员卡片；焦点不在卡内则不动", async () => {
    const { unmount } = render(<GroupCard group={mkGroup()} />);
    const tab = screen.getAllByRole("tab")[0]; // activeId = a（tabIndex 0 可聚焦）
    tab.focus();
    expect(document.activeElement).toBe(tab);
    // 卸载语义 = 解散落地（组移除）；成员以 data-widget-id 卡片回归（编辑
    // 模式 tabIndex=0 可聚焦——以同款属性模拟）。
    const card = document.createElement("div");
    card.dataset.widgetId = "a";
    card.tabIndex = 0;
    document.body.appendChild(card);
    unmount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(card);
    card.remove();
    // 焦点本就不在卡内：卸载不动焦点。
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const second = render(<GroupCard group={mkGroup()} />);
    second.unmount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
