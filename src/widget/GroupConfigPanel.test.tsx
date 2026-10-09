/**
 * 编组配置弹层（批补齐能力）的组件锚点测试：
 *  - 添加成员：chips 列出当前视图未编组实例，点击并入（追加 + 激活标签切换）；
 *  - 成员重排：上移/下移与桌面拖标签同一 reorderGroupMembers 写入；
 *  - 组名行：未命名回落「重命名」文案，标题带组名。
 * 拖拽类交互（标签条）在 jsdom 无 PointerEvent，面板路径即设置页/弹层的
 * 等价入口，锁住 store 写入契约即可。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GroupConfigPanel } from "./GroupConfigPanel";
import { useWidgetStore, type WidgetGroup, type WidgetInstance } from "./widget-store";

const mkInst = (id: string, over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "clock",
  x: 0,
  y: 0,
  w: 200,
  h: 120,
  z: 1,
  ...over
});
const mkGroup = (over: Partial<WidgetGroup> = {}): WidgetGroup => ({
  id: "g1",
  x: 0,
  y: 0,
  w: 400,
  h: 200,
  z: 5,
  memberIds: ["a", "b"],
  activeId: "a",
  ...over
});

const prev = {
  instances: useWidgetStore.getState().instances,
  groups: useWidgetStore.getState().groups
};

const mount = () =>
  render(<GroupConfigPanel groupId="g1" anchor={{ x: 0, y: 0, w: 100, h: 100 }} open onClose={() => {}} />);

beforeEach(() => {
  useWidgetStore.setState({
    instances: [mkInst("a", { groupId: "g1" }), mkInst("b", { groupId: "g1" }), mkInst("c", { x: 600 })],
    groups: [mkGroup()]
  });
});

afterEach(() => {
  useWidgetStore.setState(prev);
});

describe("GroupConfigPanel（S2：添加成员 / 成员重排 / 组名）", () => {
  it("添加成员：chips 只列未编组实例，点击并入（追加到末尾 + 激活标签切到新成员）", async () => {
    mount();
    const chips = await waitFor(() => {
      const list = Array.from(document.querySelectorAll<HTMLElement>(".group-cfg-add-chip"));
      expect(list).toHaveLength(1);
      return list;
    });
    fireEvent.click(chips[0]);
    await waitFor(() => {
      expect(useWidgetStore.getState().groups[0].memberIds).toEqual(["a", "b", "c"]);
    });
    expect(useWidgetStore.getState().groups[0].activeId).toBe("c");
    expect(useWidgetStore.getState().instances.find((i) => i.id === "c")!.groupId).toBe("g1");
  });

  it("成员重排：上移与桌面拖标签同一写入；首行禁用", async () => {
    mount();
    const ups = await screen.findAllByRole("button", { name: "上移" });
    expect(ups).toHaveLength(2);
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ups[1]);
    await waitFor(() => {
      expect(useWidgetStore.getState().groups[0].memberIds).toEqual(["b", "a"]);
    });
  });

  it("组名行与标题：未命名标题回落「编组配置」，按钮文案为「重命名」", async () => {
    mount();
    await screen.findByText("编组配置");
    // 组名行按钮（成员行的铅笔按钮 aria-label 是「重命名标签」，不冲突）。
    expect(screen.getByRole("button", { name: "重命名" })).toBeInTheDocument();
  });
});
