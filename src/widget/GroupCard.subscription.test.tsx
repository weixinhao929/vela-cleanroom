/**
 * 回归：GroupCard 此前整订 instances 数组——任一实例
 * 变化（拖拽提交/改任意一张卡/置顶）都换数组引用，全部组卡重渲。修复后：
 *  - 成员走 useShallow 过滤订阅：无关实例变化浅相等不重渲；
 *  - 标签自动序号走「同类型成员签名」订阅（WidgetCard.instanceIndex 同范式），
 *    渲染输出与整订全表时逐字节一致（跨组/自由实例同样计入序号）。
 */
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { GroupCard } from "./GroupCard";
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
  pulseIds: useWidgetStore.getState().pulseIds,
  exitingIds: useWidgetStore.getState().exitingIds
};

describe("GroupCard 订阅纪律（Q-22）", () => {
  beforeEach(() => {
    useWidgetStore.setState({
      instances: [
        mkInst("a", { groupId: "g1" }),
        mkInst("b", { groupId: "g1", z: 2 }),
        // 无关实例：非本组成员、类型也与成员不同（notes 仅为占位类型）。
        mkInst("free1", { type: "notes", z: 3 })
      ],
      groups: [mkGroup()],
      editMode: false,
      selectedId: null,
      selectedIds: [],
      enteringIds: [],
      pulseIds: [],
      exitingIds: []
    });
  });
  afterEach(() => {
    useWidgetStore.setState(prev);
  });

  /** 挂载后等懒加载内容沉淀，返回「重置后的提交计数器」。 */
  async function mountWithCounter() {
    let commits = 0;
    const utils = render(
      <Profiler id="g1" onRender={() => (commits += 1)}>
        <GroupCard group={mkGroup()} />
      </Profiler>
    );
    await screen.findAllByRole("tab");
    // Suspense 内容 chunk 与入场定时器沉淀（act 内等待，防 suspended 警告）。
    await act(async () => {
      await new Promise((res) => setTimeout(res, 80));
    });
    return {
      utils,
      count: () => commits,
      reset: () => (commits = 0)
    };
  }

  it("无关实例编辑不重渲全组卡；成员编辑仍重渲", async () => {
    const h = await mountWithCounter();
    h.reset();
    // 无关实例（非成员、非同类型）换引用：浅相等 → 不重渲。
    act(() =>
      useWidgetStore.setState((s) => ({
        instances: s.instances.map((i) => (i.id === "free1" ? { ...i, x: 999 } : i))
      }))
    );
    expect(h.count()).toBe(0);
    // 成员被编辑（引用变化）→ 重渲（几何/透明度等渲染输入）。
    act(() =>
      useWidgetStore.setState((s) => ({
        instances: s.instances.map((i) => (i.id === "a" ? { ...i, x: 40 } : i))
      }))
    );
    expect(h.count()).toBeGreaterThan(0);
    h.utils.unmount();
  });

  it("同类型成员签名：全表新增同类型实例时标签自动序号即时跟进（输出与整订全表一致）", async () => {
    const h = await mountWithCounter();
    const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent ?? "");
    // 初始：两个同类型成员 → 时钟1 / 时钟2。
    expect(tabs()[0]).toContain("时钟1");
    expect(tabs()[1]).toContain("时钟2");
    // 表头新增一个自由 clock（跨组的同类实例同样计入序号）：a/b 顺位后移。
    act(() =>
      useWidgetStore.setState((s) => ({
        instances: [mkInst("c", { z: 9 }), ...s.instances]
      }))
    );
    await screen.findAllByRole("tab");
    expect(tabs()[0]).toContain("时钟2");
    expect(tabs()[1]).toContain("时钟3");
    h.utils.unmount();
  });

  it("成员增删照常重渲（成员集合/空态行为与整订时一致）", async () => {
    const h = await mountWithCounter();
    h.reset();
    // 成员 b 移出编组：成员集合变化 → 重渲。
    act(() =>
      useWidgetStore.setState((s) => ({
        instances: s.instances.map((i) => (i.id === "b" ? { ...i, groupId: undefined } : i))
      }))
    );
    expect(h.count()).toBeGreaterThan(0);
    // 只剩 a 一个成员：标签仍渲染（组未解散，成员照常显示）。
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    h.utils.unmount();
  });
});
