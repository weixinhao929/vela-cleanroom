import { describe, expect, it, beforeEach, vi } from "vitest";
import { localStorageAdapter } from "./local-storage";

const STORAGE_KEY = "focus-desk.state.v1";

describe("localStorageAdapter.load 损坏保全（A-3）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("schema 不符的载荷：返回 null、原 key 移除、corrupt 副本保留原始内容", async () => {
    // 非 ISO 日期（CSV 宽松导入的典型脏数据）会让 AppStateSchema 校验失败。
    const corrupt = JSON.stringify({
      tasks: [
        {
          id: "t1",
          title: "写周报",
          completed: false,
          createdAt: "2026/08/18 10:00",
          dueAt: "",
          priority: 0,
          tags: [],
          sortOrder: 0
        }
      ]
    });
    localStorage.setItem(STORAGE_KEY, corrupt);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await localStorageAdapter.load();

    expect(loaded).toBeNull();
    // 原 key 已移除：后续防抖覆写不会再碰到它，但原始数据已被保全。
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    const corruptKeys = Object.keys(localStorage).filter((k) => k.startsWith(`${STORAGE_KEY}.corrupt-`));
    expect(corruptKeys).toHaveLength(1);
    expect(localStorage.getItem(corruptKeys[0])).toBe(corrupt);
    expect(warn).toHaveBeenCalled();
  });

  it("非法 JSON 载荷：同样保全后返回 null", async () => {
    const raw = "{not valid json";
    localStorage.setItem(STORAGE_KEY, raw);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await localStorageAdapter.load()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    const corruptKeys = Object.keys(localStorage).filter((k) => k.startsWith(`${STORAGE_KEY}.corrupt-`));
    expect(corruptKeys).toHaveLength(1);
    expect(localStorage.getItem(corruptKeys[0])).toBe(raw);
  });

  it("合法载荷正常返回且不产生 corrupt 副本", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks: [], deadlines: [] }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await localStorageAdapter.load();
    expect(loaded).toEqual({ tasks: [], deadlines: [] });
    expect(Object.keys(localStorage).some((k) => k.includes(".corrupt-"))).toBe(false);
  });

  it("无载荷时返回 null 且不动 localStorage", async () => {
    expect(await localStorageAdapter.load()).toBeNull();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});
