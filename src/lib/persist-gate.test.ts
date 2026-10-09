import { afterEach, describe, expect, it, vi } from "vitest";
/**
 * persist-gate 单元：
 *  - 按所有者计数的闸门——并发握手互不干扰、重复 pause 去重；
 *  - pauseOtherWindowsPersistence 握手——ack 按窗口去重计数、自回声排除、
 *    超时兜底放行、listen/emit 抛错先复位再上抛（退出契约）。
 */
import {
  isPersistSuspended,
  pauseOtherWindowsPersistence,
  resetPersistGateForTests,
  resumePersistence,
  suspendPersistence
} from "./persist-gate";

const emitMock = vi.fn(async (_name: string, _payload?: unknown) => {});

vi.mock("@tauri-apps/api/event", () => ({
  emit: (name: string, payload?: unknown) => emitMock(name, payload),
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const g = globalThis as { __gateHandlers?: Record<string, (e: { payload: unknown }) => void> };
    g.__gateHandlers ||= {};
    g.__gateHandlers[name] = cb;
    return () => {};
  })
}));

const fakeWindows = { list: [{ label: "settings" }, { label: "widget-0" }, { label: "snip" }] };
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "settings" }),
  WebviewWindow: { getAll: async () => fakeWindows.list }
}));

function fireAck(label: string) {
  const h = (globalThis as { __gateHandlers?: Record<string, (e: { payload: unknown }) => void> }).__gateHandlers;
  h?.["sync:persist-acked"]?.({ payload: label });
}

afterEach(() => {
  resetPersistGateForTests();
  emitMock.mockClear();
});

describe("persist-gate 闸门计数（F-18）", () => {
  it("多所有者：任一 resume 不解除其他所有者的暂停；清空才放行", () => {
    expect(isPersistSuspended()).toBe(false);
    suspendPersistence("remote:widget-0");
    suspendPersistence("remote:snip");
    expect(isPersistSuspended()).toBe(true);
    resumePersistence("remote:widget-0");
    expect(isPersistSuspended()).toBe(true); // snip 仍持有
    resumePersistence("remote:snip");
    expect(isPersistSuspended()).toBe(false);
  });

  it("同一所有者重复 pause 幂等（集合去重，不 inflate 计数）", () => {
    suspendPersistence("remote:widget-0");
    suspendPersistence("remote:widget-0");
    resumePersistence("remote:widget-0");
    expect(isPersistSuspended()).toBe(false);
  });

  it("默认所有者 self 与远端所有者互不干扰", () => {
    suspendPersistence(); // self
    suspendPersistence("remote:widget-0");
    resumePersistence(); // 只放 self
    expect(isPersistSuspended()).toBe(true);
    resumePersistence("remote:widget-0");
    expect(isPersistSuspended()).toBe(false);
  });
});

describe("pauseOtherWindowsPersistence 握手（F-17）", () => {
  it("收齐非自身窗口的 ack 才放行；pause 载荷带发起方 label", async () => {
    const p = pauseOtherWindowsPersistence(5_000);
    // 动态 import 的 mock 模块需数个微任务解析，等待握手进入轮询期。
    await vi.waitFor(() => expect(isPersistSuspended()).toBe(true));
    // 自回声（settings 自己的 ack）不得计入 expected=2。
    fireAck("settings");
    expect(isPersistSuspended()).toBe(true);
    fireAck("widget-0");
    fireAck("snip");
    const release = await p;
    expect(isPersistSuspended()).toBe(true); // release 尚未调用
    expect(emitMock).toHaveBeenCalledWith("sync:persist-pause", "settings");
    release();
    expect(isPersistSuspended()).toBe(false);
  });

  it("超时兜底：等不满 ack 也放行返回 release（闸门仍置位直到 release）", async () => {
    vi.useFakeTimers();
    try {
      const p = pauseOtherWindowsPersistence(1200);
      fireAck("widget-0"); // 只回 1/2
      const settling = p.then((release) => {
        release();
        expect(isPersistSuspended()).toBe(false);
      });
      await vi.advanceTimersByTimeAsync(1300);
      await settling;
    } finally {
      vi.useRealTimers();
    }
  });
});
