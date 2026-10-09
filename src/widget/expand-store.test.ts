import { beforeEach, describe, expect, it } from "vitest";
import { useWidgetExpand } from "./expand-store";

/**
 * 展开态状态机：互斥（任一展开其余收起）、常驻挂载（收起不卸载、
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

  it("再次展开曾挂载的实例：不重复登记，且挪到队尾（LRU 新鲜位）", () => {
    useWidgetExpand.getState().expand("music-1");
    useWidgetExpand.getState().expand("weather-2");
    useWidgetExpand.getState().expand("music-1");
    const s = useWidgetExpand.getState();
    expect(s.expandedId).toBe("music-1");
    expect(s.mountedIds).toEqual(["weather-2", "music-1"]);
  });

  it("LRU 上限：超过 MOUNTED_IDS_CAP 时淘汰最久未展开的面板，当前展开面不被踢", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `face-${i}`);
    for (const id of ids) useWidgetExpand.getState().expand(id);
    let s = useWidgetExpand.getState();
    expect(s.mountedIds).toEqual(["face-1", "face-2", "face-3", "face-4", "face-5", "face-6"]);
    expect(s.expandedId).toBe("face-6");
    // 重开队中老面板（face-2）：它挪到队尾保鲜，下一次淘汰落在新的队首 face-3。
    useWidgetExpand.getState().expand("face-2");
    useWidgetExpand.getState().expand("face-7");
    s = useWidgetExpand.getState();
    expect(s.mountedIds).toEqual(["face-3", "face-4", "face-5", "face-6", "face-2", "face-7"]);
    expect(s.expandedId).toBe("face-7");
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
