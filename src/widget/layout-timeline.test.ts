/**
 * 布局时间线测试：纯函数 + 订阅捕获/撤销/重做闭环。
 * jsdom 下驱动真实 widget-store（localStorage 权威，不 mock）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isSignificant,
  pushCapped,
  undoLayout,
  redoLayout,
  __resetTimelineForTests,
  initLayoutTimeline,
  deltaOf,
  getTimelineEntries,
  pinSnapshot,
  restoreSnapshot,
  clearTimeline
} from "./layout-timeline";
import { useWidgetStore } from "./widget-store";
import type { WidgetInstance, WidgetGroup } from "./widget-store";

vi.mock("../lib/local-backup", () => ({ persistMirrored: () => true }));

const inst = (id: string, over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "clock",
  x: 20,
  y: 20,
  w: 200,
  h: 160,
  z: 1,
  ...over
});

const grp = (id: string, members: string[]): WidgetGroup => ({
  id,
  x: 0,
  y: 0,
  w: 200,
  h: 160,
  z: 1,
  memberIds: members,
  activeId: members[0]
});

const snap = (id: string, ids: string[], groups: WidgetGroup[] = []) =>
  ({
    id,
    view: "home",
    capturedAt: 1,
    instances: ids.map((x) => inst(x)),
    groups
  }) as import("./layout-timeline").LayoutSnapshot;

beforeEach(() => {
  localStorage.clear();
  __resetTimelineForTests();
  useWidgetStore.setState({
    instances: [],
    groups: [],
    selectedIds: [],
    selectedId: null,
    activeView: "home",
    views: [{ id: "home", name: "Home" }],
    trash: []
  });
});
afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe("isSignificant（显著性阈值）", () => {
  it("实例/组增删才算显著；移动/改配置不算", () => {
    const prev = snap("s0", ["a", "b"]);
    // 移动 + 改尺寸：id 集合不变 → 不显著。
    expect(isSignificant(prev, [inst("a", { x: 999, w: 42 }), inst("b", { type: "todo" })], [])).toBe(false);
    // 增 / 删实例 → 显著。
    expect(isSignificant(prev, [inst("a"), inst("b"), inst("c")], [])).toBe(true);
    expect(isSignificant(prev, [inst("a")], [])).toBe(true);
    // 组增删 → 显著。
    expect(isSignificant(prev, prev.instances, [grp("g1", ["a", "b"])])).toBe(true);
    const withGroup = snap("s1", ["a", "b"], [grp("g1", ["a", "b"])]);
    expect(isSignificant(withGroup, withGroup.instances, [])).toBe(true);
  });

  it("空 → 空不落第一份（初始化噪音）；空 → 非空落", () => {
    expect(isSignificant(null, [], [])).toBe(false);
    expect(isSignificant(null, [inst("a")], [])).toBe(true);
  });

  it("编组成员表变化也显著（撤销盲区修复）：并入/摘出/重排落快照，成员不变不落", () => {
    const prev = snap("s0", ["a", "b", "c"], [grp("g1", ["a", "b"])]);
    const same = [inst("a", { groupId: "g1" }), inst("b", { groupId: "g1" }), inst("c")];
    // 同成员、仅移动/改组几何 → 不显著。
    expect(isSignificant(prev, same, [{ ...grp("g1", ["a", "b"]), x: 999 }])).toBe(false);
    // 并入成员 c → 显著。
    expect(isSignificant(prev, same, [grp("g1", ["a", "b", "c"])])).toBe(true);
    // 摘出成员 b → 显著。
    expect(isSignificant(prev, same, [grp("g1", ["a"])])).toBe(true);
    // 重排标签顺序 → 显著（顺序敏感）。
    expect(isSignificant(prev, same, [grp("g1", ["b", "a"])])).toBe(true);
  });

  it("deltaOf 汇报 membersMoved（既有组成员表变化数）；新增/解散的组不计入", () => {
    const prev = snap("s0", ["a", "b", "c"], [grp("g1", ["a", "b"]), grp("g2", ["c"])]);
    const next = snap("s1", ["a", "b", "c"], [grp("g1", ["a", "b", "c"]), grp("g3", ["c"])]);
    const d = deltaOf(prev, next);
    expect(d.membersMoved).toBe(1); // g1 成员表变化
    expect(d.groupsAdded).toBe(1); // g3
    expect(d.groupsRemoved).toBe(1); // g2
    // 无成员变化的对照。
    const same = deltaOf(prev, snap("s2", ["a", "b", "c"], [grp("g1", ["a", "b"]), grp("g2", ["c"])]));
    expect(same.membersMoved).toBe(0);
  });
});

describe("pushCapped（有界历史）", () => {
  it("超上限逐最旧", () => {
    let list: import("./layout-timeline").LayoutSnapshot[] = [];
    for (let i = 0; i < 5; i++) list = pushCapped(list, snap(`s${i}`, [`w${i}`]), 3);
    expect(list.map((s) => s.id)).toEqual(["s2", "s3", "s4"]);
  });

  it("pinned 条目不参与容量淘汰（v2）", () => {
    let list: import("./layout-timeline").LayoutSnapshot[] = [];
    for (let i = 0; i < 3; i++) list = pushCapped(list, snap(`s${i}`, [`w${i}`]), 3);
    // 淘汰发生前固定 s0，再压 2 条：s0 存活、非 pinned 逐最旧淘汰。
    list = list.map((s) => (s.id === "s0" ? { ...s, pinned: true } : s));
    list = pushCapped(list, snap("s3", ["w3"]), 3);
    list = pushCapped(list, snap("s4", ["w4"]), 3);
    expect(list.map((s) => s.id)).toEqual(["s0", "s2", "s3", "s4"]);
    expect(list[0].pinned).toBe(true);
  });
});

describe("deltaOf（结构差摘要）", () => {
  it("统计实例/组的增删", () => {
    const a = snap("a", ["x", "y"], [grp("g1", ["x", "y"])]);
    const b = snap("b", ["y", "z"], []);
    const d = deltaOf(a, b);
    expect(d).toMatchObject({ added: 1, removed: 1, groupsAdded: 0, groupsRemoved: 1 });
    // prev 为 null（首条）：全部记为 added。
    expect(deltaOf(null, a)).toMatchObject({ added: 2, removed: 0, groupsAdded: 1 });
  });
});

describe("订阅捕获 + 撤销/重做闭环", () => {
  it("结构变更落快照；Ctrl+Z 语义恢复；重做前进；新变更截断 redo 分支", () => {
    vi.useFakeTimers();
    initLayoutTimeline();
    // 初始布局 a+b。
    useWidgetStore.setState({ instances: [inst("a"), inst("b")] });
    vi.advanceTimersByTime(600);
    // 删除 b（结构变更）。
    useWidgetStore.setState({ instances: [inst("a")] });
    vi.advanceTimersByTime(600);
    // 只移动 a：不产生新历史。
    useWidgetStore.setState({ instances: [inst("a", { x: 500 })] });
    vi.advanceTimersByTime(600);

    // 撤销 → 回到 a+b。
    expect(undoLayout()).toBe(true);
    expect(
      useWidgetStore
        .getState()
        .instances.map((i) => i.id)
        .sort()
    ).toEqual(["a", "b"]);
    // 重做 → 回到只剩 a（且带着撤销前的坐标——移动不进历史，坐标以快照为准）。
    expect(redoLayout()).toBe(true);
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["a"]);

    // 撤销后再做**新**结构变更（加 c）→ redo 分支被截断。
    expect(undoLayout()).toBe(true);
    useWidgetStore.setState({ instances: [inst("a"), inst("b"), inst("c")] });
    vi.advanceTimersByTime(600);
    expect(redoLayout()).toBe(false);
    expect(
      useWidgetStore
        .getState()
        .instances.map((i) => i.id)
        .sort()
    ).toEqual(["a", "b", "c"]);
  });

  it("撤销前冲刷 pending（pre_restore）：未落盘的删除先补快照再跳转", () => {
    vi.useFakeTimers();
    initLayoutTimeline();
    useWidgetStore.setState({ instances: [inst("a"), inst("b")] });
    vi.advanceTimersByTime(600);
    // 删除 b 但**不**推进计时器（快照仍 pending）→ 直接 undo。
    useWidgetStore.setState({ instances: [inst("a")] });
    expect(undoLayout()).toBe(true);
    expect(
      useWidgetStore
        .getState()
        .instances.map((i) => i.id)
        .sort()
    ).toEqual(["a", "b"]);
    // redo 应回到删除后状态（pending 被冲刷成快照了）。
    expect(redoLayout()).toBe(true);
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["a"]);
  });

  it("恢复动作本身不进历史（挂起自动捕获）", () => {
    vi.useFakeTimers();
    initLayoutTimeline();
    useWidgetStore.setState({ instances: [inst("a"), inst("b")] });
    vi.advanceTimersByTime(600);
    useWidgetStore.setState({ instances: [inst("a")] });
    vi.advanceTimersByTime(600);
    const before = JSON.parse(localStorage.getItem("focus-desk.screen.0.timeline.home.v1")!) as unknown[];
    undoLayout();
    vi.advanceTimersByTime(600);
    const after = JSON.parse(localStorage.getItem("focus-desk.screen.0.timeline.home.v1")!) as unknown[];
    expect(after.length).toBe(before.length);
  });

  it("无历史时 undo/redo 返回 false（空视图不误报）", () => {
    initLayoutTimeline();
    expect(undoLayout()).toBe(false);
    expect(redoLayout()).toBe(false);
  });

  it("跨视图背靠背标脏——切视图后新视图的首笔结构变更不再丢历史", () => {
    vi.useFakeTimers();
    initLayoutTimeline();
    useWidgetStore.setState({
      views: [
        { id: "home", name: "Home" },
        { id: "work", name: "Work" }
      ],
      activeView: "home",
      instances: [inst("a"), inst("b")]
    });
    vi.advanceTimersByTime(600);
    // home 结构变更（删 b），500ms 窗口内 pending 未冲刷。
    useWidgetStore.setState({ instances: [inst("a")] });
    // 生产路径里这笔删除由 saveInstances 防抖落盘；flushPendingTimeline 对非
    // 活动视图走 loadInstances（读 LS），手动同步 LS 模拟已落盘。
    localStorage.setItem("focus-desk.screen.0.widgets.home.v1", JSON.stringify([inst("a")]));
    // 立即切到 work（touch 捕获到视图变化）并做 work 的首笔结构变更。
    useWidgetStore.setState({ activeView: "work", instances: [inst("c")] });
    vi.advanceTimersByTime(600);
    useWidgetStore.setState({ instances: [inst("c"), inst("d")] });
    vi.advanceTimersByTime(600);
    // work：两笔历史齐全，undo 回到 [c]——修复前 dirtyView 卡在 home，work
    // 的首笔结构变更从未被捕获（随 home 的非显著位移一起被丢弃）。
    expect(undoLayout()).toBe(true);
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["c"]);
    // home：切视图时已就地冲刷、各自完成历史——切回后 undo 回到 a+b。
    useWidgetStore.setState({ activeView: "home", instances: [inst("a")] });
    vi.advanceTimersByTime(600);
    expect(undoLayout()).toBe(true);
    expect(
      useWidgetStore
        .getState()
        .instances.map((i) => i.id)
        .sort()
    ).toEqual(["a", "b"]);
  });

  it("v2 面板 API：列表新→旧 / pin 持久化 / 任意点恢复 / 清空", () => {
    vi.useFakeTimers();
    initLayoutTimeline();
    useWidgetStore.setState({ instances: [inst("a"), inst("b")] });
    vi.advanceTimersByTime(600);
    useWidgetStore.setState({ instances: [inst("a")] });
    vi.advanceTimersByTime(600);
    useWidgetStore.setState({ instances: [inst("a"), inst("b"), inst("c")] });
    vi.advanceTimersByTime(600);

    const entries = getTimelineEntries("home");
    expect(entries.length).toBeGreaterThanOrEqual(3);
    // 新→旧：最新一条含 c。
    expect(entries[0].instances.map((i) => i.id)).toContain("c");

    // pin 最旧一条 → 持久化可读回。
    const oldest = entries[entries.length - 1];
    pinSnapshot("home", oldest.id, true);
    expect(getTimelineEntries("home").find((s) => s.id === oldest.id)?.pinned).toBe(true);
    pinSnapshot("home", oldest.id, false);
    expect(getTimelineEntries("home").find((s) => s.id === oldest.id)?.pinned).toBeUndefined();

    // 任意点恢复：恢复到只有 a 的时点。
    const target = getTimelineEntries("home").find((s) => s.instances.length === 1 && s.instances[0].id === "a")!;
    expect(restoreSnapshot("home", target.id)).toBe(true);
    expect(useWidgetStore.getState().instances.map((i) => i.id)).toEqual(["a"]);
    // 恢复后再做新变更 → redo 分支截断（cursor 语义在 seek 后仍正确）。
    useWidgetStore.setState({ instances: [inst("a"), inst("b")] });
    vi.advanceTimersByTime(600);
    expect(redoLayout()).toBe(false);
    expect(
      useWidgetStore
        .getState()
        .instances.map((i) => i.id)
        .sort()
    ).toEqual(["a", "b"]);

    // 清空。
    clearTimeline("home");
    expect(getTimelineEntries("home")).toEqual([]);
    expect(undoLayout()).toBe(false);
  });
});
