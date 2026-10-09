import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 镜像备份层测试。
 *
 * 关注两件事：
 *  1. 收集范围正确（focus-desk.* 前缀、排除瞬态键）。
 *  2. 防抖合批语义：窗口内 N 次请求只落一次整表写入；flush 立即落盘。
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

describe("applyLocalStorageMirror（P2-1：overwrite 整包替换）", () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([] as never);
  });

  it("overwrite=true 删除备份中不存在的镜像键（复活防线）", async () => {
    // 备份里只有 notes.a；本地多出 stale.bookmarks（备份前已删除的数据）。
    mockInvoke.mockResolvedValue([{ key: "focus-desk.notes.a", value: "[]" }] as never);
    localStorage.setItem("focus-desk.notes.a", "旧值");
    localStorage.setItem("focus-desk.stale.bookmarks", '[{"id":"gone"}]');

    const { applyLocalStorageMirror } = await loadModule();
    const written = await applyLocalStorageMirror(true);

    expect(written).toBe(1);
    expect(localStorage.getItem("focus-desk.notes.a")).toBe("[]");
    // 只写不清会让备份前删掉的书签复活，违背「整包替换」承诺。
    expect(localStorage.getItem("focus-desk.stale.bookmarks")).toBeNull();
  });

  it("清理严格限定镜像命名空间：TRANSIENT 与 .corrupt- 保留、非镜像前缀键不动", async () => {
    mockInvoke.mockResolvedValue([{ key: "focus-desk.notes.a", value: "[]" }] as never);
    localStorage.setItem("focus-desk.notes.a", "旧值");
    // TRANSIENT_KEYS：本机瞬态，从不进备份，删了会破坏导航/迁移/回滚语义。
    localStorage.setItem("focus-desk.pending-nav", "general");
    localStorage.setItem("focus-desk.migrated.v1", "1");
    localStorage.setItem("focus-desk.state.v1", "legacy 快照");
    // .corrupt-：损坏抢救存证（B-审计：不随镜像/备份携带，也不得被清理）。
    localStorage.setItem("focus-desk.notes.corrupt-20260101", "抢救快照");
    // 非镜像前缀：其他应用共享的 localStorage 键，绝不能碰。
    localStorage.setItem("other.app.key", "x");
    localStorage.setItem("vela.unrelated", "y");

    const { applyLocalStorageMirror } = await loadModule();
    await applyLocalStorageMirror(true);

    expect(localStorage.getItem("focus-desk.pending-nav")).toBe("general");
    expect(localStorage.getItem("focus-desk.migrated.v1")).toBe("1");
    expect(localStorage.getItem("focus-desk.state.v1")).toBe("legacy 快照");
    expect(localStorage.getItem("focus-desk.notes.corrupt-20260101")).toBe("抢救快照");
    expect(localStorage.getItem("other.app.key")).toBe("x");
    expect(localStorage.getItem("vela.unrelated")).toBe("y");
  });

  it("备份含多个键时全部保留，仅清多余键", async () => {
    mockInvoke.mockResolvedValue([
      { key: "focus-desk.notes.a", value: "1" },
      { key: "focus-desk.habits.b", value: "2" }
    ] as never);
    localStorage.setItem("focus-desk.habits.b", "旧");
    localStorage.setItem("focus-desk.gone.c", "3");

    const { applyLocalStorageMirror } = await loadModule();
    const written = await applyLocalStorageMirror(true);

    expect(written).toBe(2);
    expect(localStorage.getItem("focus-desk.notes.a")).toBe("1");
    expect(localStorage.getItem("focus-desk.habits.b")).toBe("2");
    expect(localStorage.getItem("focus-desk.gone.c")).toBeNull();
    expect(localStorage.length).toBe(2);
  });

  it("overwrite=false 只补缺失键、不清多余键（安全合并语义不回归）", async () => {
    mockInvoke.mockResolvedValue([{ key: "focus-desk.notes.a", value: "[]" }] as never);
    localStorage.setItem("focus-desk.notes.a", "本地较新");
    localStorage.setItem("focus-desk.local.extra", "保留");

    const { applyLocalStorageMirror } = await loadModule();
    const written = await applyLocalStorageMirror(false);

    expect(written).toBe(0);
    expect(localStorage.getItem("focus-desk.notes.a")).toBe("本地较新");
    expect(localStorage.getItem("focus-desk.local.extra")).toBe("保留");
  });

  it("overwrite 且 IPC 失败仍上抛（P1-7 语义不回归）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValue(new Error("ipc down") as never);

    const { applyLocalStorageMirror } = await loadModule();
    await expect(applyLocalStorageMirror(true)).rejects.toThrow("ipc down");
    spy.mockRestore();
  });
});
