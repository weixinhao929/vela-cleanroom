import { beforeEach, describe, expect, it } from "vitest";
import { useWidgetExpand } from "./expand-store";

/**
 * C1 展开态状态机：互斥（任一展开其余收起）、常驻挂载（收起不卸载、
 * 重开瞬时）、定向收起与实例清理的语义守护。
 */
describe("expand-store 互斥状态机 (C1)", () => {
  beforeEach(() => {
    useWidgetExpand.setState({ expandedId: null, mountedIds: [] });
  });

  it("expand 登记展开并挂载沉浸层", () => {
    useWidgetExpand.getState().expand("music-1");
    const s = useWidgetExpand.getState();
    expect(s.expandedId).toBe("music-1");
    expect(s.mountedIds).toEqual(["music-1"]);
  });

  it("互斥：B 展开时 A 被收起（expandedId 单值），但 A 保持挂载", () => {
    useWidgetExpand.getState().expand("music-1");
    useWidgetExpand.getState().expand("weather-2");
    const s = useWidgetExpand.getState();
    expect(s.expandedId).toBe("weather-2");
    expect(s.mountedIds).toEqual(["music-1", "weather-2"]);
  });

  it("collapse 清空展开但保留挂载（重开不重建）", () => {
    useWidgetExpand.getState().expand("music-1");
    useWidgetExpand.getState().collapse();
    const s = useWidgetExpand.getState();
    expect(s.expandedId).toBeNull();
    expect(s.mountedIds).toEqual(["music-1"]);
  });

  it("重复 expand 同一实例是幂等的（引用稳定，不重播动画）", () => {
    useWidgetExpand.getState().expand("music-1");
    const before = useWidgetExpand.getState();
    useWidgetExpand.getState().expand("music-1");
    const after = useWidgetExpand.getState();
    expect(after.expandedId).toBe("music-1");
    expect(after.mountedIds).toBe(before.mountedIds); // 同一引用
  });

  it("再次展开曾挂载的实例：只翻转 expandedId，不重复登记", () => {
    useWidgetExpand.getState().expand("music-1");
    useWidgetExpand.getState().expand("weather-2");
    useWidgetExpand.getState().expand("music-1");
    const s = useWidgetExpand.getState();
    expect(s.expandedId).toBe("music-1");
    expect(s.mountedIds).toEqual(["music-1", "weather-2"]);
  });

  it("collapseIf 只收起匹配实例：他卡在展开时是 no-op", () => {
    useWidgetExpand.getState().expand("weather-2");
    useWidgetExpand.getState().collapseIf("music-1");
    expect(useWidgetExpand.getState().expandedId).toBe("weather-2");
    useWidgetExpand.getState().collapseIf("weather-2");
    expect(useWidgetExpand.getState().expandedId).toBeNull();
  });

  it("collapse 空态 no-op（引用稳定）", () => {
    const before = useWidgetExpand.getState();
    useWidgetExpand.getState().collapse();
    expect(useWidgetExpand.getState()).toBe(before);
  });

  it("forget 清除挂载记录，并连带收起若其正展开", () => {
    useWidgetExpand.getState().expand("music-1");
    useWidgetExpand.getState().expand("weather-2");
    useWidgetExpand.getState().forget("weather-2");
    const s = useWidgetExpand.getState();
    expect(s.expandedId).toBeNull();
    expect(s.mountedIds).toEqual(["music-1"]);
    // 未登记过的 id 也是 no-op（引用稳定）
    const before = s;
    useWidgetExpand.getState().forget("ghost");
    expect(useWidgetExpand.getState()).toBe(before);
  });
});
