import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 镜像备份层测试。
 *
 * 关注两件事：
 *  1. 收集范围正确（focus-desk.* 前缀、排除瞬态键）。
 *  2. 防抖合批语义（P5）：窗口内 N 次请求只落一次整表写入；flush 立即落盘。
 */

// isTauri 必须为 true，否则防抖入口会直接短路返回。
vi.mock("./tauri", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => (mockInvoke as unknown as (...a: unknown[]) => unknown)(...args)
}));

const mockInvoke = vi.fn(() => Promise.resolve());

async function loadModule() {
  vi.resetModules();
  return await import("./local-backup");
}

describe("collectLocalStorageEntries", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockClear();
  });

  it("只收集 focus-desk.* 前缀且排除瞬态键", async () => {
    localStorage.setItem("focus-desk.notes.a", "[]");
    localStorage.setItem("focus-desk.habits.b", "[]");
    localStorage.setItem("other.app.key", "x");
    localStorage.setItem("focus-desk.pending-nav", "general");
    localStorage.setItem("focus-desk.crash-log.v1", "[]");

    const { collectLocalStorageEntries } = await loadModule();
    const keys = collectLocalStorageEntries()
      .map((e) => e.key)
      .sort();
    expect(keys).toEqual(["focus-desk.habits.b", "focus-desk.notes.a"]);
  });
});

describe("镜像同步防抖合批", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mockInvoke.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("防抖窗口内的多次请求只触发一次整表写入", async () => {
    const { scheduleMirrorSync } = await loadModule();
    localStorage.setItem("focus-desk.notes.a", "[]");

    scheduleMirrorSync();
    scheduleMirrorSync();
    scheduleMirrorSync();
    // 窗口未到期：还没有任何 IPC。
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("mirror_local_storage", {
      entries: [{ key: "focus-desk.notes.a", value: "[]" }]
    });
  });

  it("落盘的是窗口内最后一次的快照", async () => {
    const { scheduleMirrorSync } = await loadModule();
    localStorage.setItem("focus-desk.notes.a", "v1");
    scheduleMirrorSync();
    localStorage.setItem("focus-desk.notes.a", "v2");
    scheduleMirrorSync();

    await vi.advanceTimersByTimeAsync(600);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const call = mockInvoke.mock.calls[0] as unknown as [string, { entries: Array<{ value: string }> }];
    expect(call[1].entries[0].value).toBe("v2");
  });

  it("flushMirrorSync 立即落盘并吞掉待处理的定时任务", async () => {
    const { scheduleMirrorSync, flushMirrorSync } = await loadModule();
    localStorage.setItem("focus-desk.notes.a", "[]");

    scheduleMirrorSync();
    await flushMirrorSync();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // 定时器已被取消，推进时间不应产生第二次写入。
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("persistMirrored 写入成功并请求防抖同步", async () => {
    const { persistMirrored } = await loadModule();
    expect(persistMirrored("focus-desk.notes.a", "hello")).toBe(true);
    expect(localStorage.getItem("focus-desk.notes.a")).toBe("hello");
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("IPC 失败不抛出，后续同步仍可继续", async () => {
    const { scheduleMirrorSync } = await loadModule();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce(new Error("ipc down") as never);

    scheduleMirrorSync();
    await vi.advanceTimersByTimeAsync(600);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    scheduleMirrorSync();
    await vi.advanceTimersByTimeAsync(600);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
