import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileDragStore } from "./file-drag-store";

describe("useFileDragStore", () => {
  beforeEach(() => {
    useFileDragStore.setState({ active: false });
  });

  it("置位/复位 active", () => {
    useFileDragStore.getState().setFileDragActive(true);
    expect(useFileDragStore.getState().active).toBe(true);
    useFileDragStore.getState().setFileDragActive(false);
    expect(useFileDragStore.getState().active).toBe(false);
  });

  it("幂等写入不触发订阅者", () => {
    const listener = vi.fn();
    const unsub = useFileDragStore.subscribe((s) => listener(s.active));
    useFileDragStore.getState().setFileDragActive(false); // 同值：不通知
    expect(listener).not.toHaveBeenCalled();
    useFileDragStore.getState().setFileDragActive(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);
    unsub();
  });
});
