/**
 * 回归：widget-config 150ms 广播防抖的冲刷必须发射
 * 「现读 LS 的合并真值」，不再回放 pendingSync 里的旧快照。
 *
 * 回滚链（修复前）：本窗编辑 A（快照入槽）→ 150ms 内对端包到达被采纳
 * （useTauriEvent 只 setConfig、不清槽）→ 到点冲刷把旧快照 A 整包广播 →
 * 对端刚保存的字段被回滚（groups 通道同族）。修复后 saveWidgetConfig
 * 每次同步写共享 LS、对端写也落在同一 LS——冲刷现读 loadWidgetConfig(id)
 * 即两端最后一次写入的真值，回放只会收敛。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitMock = vi.fn(async (_name: string, _payload?: unknown) => {});

vi.mock("@tauri-apps/api/event", () => ({
  emit: (name: string, payload?: unknown) => emitMock(name, payload)
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: vi.fn(async () => null) };
});

import { flushWidgetConfigSync, loadWidgetConfig, saveWidgetConfig } from "./widget-config";

const keyOf = (id: string) => `focus-desk.widget-config.${id}.v1`;
const cfgEmits = () => emitMock.mock.calls.filter(([n]) => n === "sync:widget-config");
const lastCfg = () => cfgEmits().at(-1)![1] as { instanceId: string; config: Record<string, unknown> };

describe("widget-config 150ms 广播冲刷（Q-21：现读 LS，不回放旧快照）", () => {
  beforeEach(() => {
    localStorage.clear();
    emitMock.mockClear();
  });
  afterEach(() => {
    // 清掉本组用过的槽位与定时器，防跨用例串扰（模块级 Map）。
    flushWidgetConfigSync("w1");
    flushWidgetConfigSync("w2");
    flushWidgetConfigSync("w3");
  });

  it("防抖到点发射现读 LS：对端在防抖窗口内写入共享 LS 的字段不被旧快照回滚", async () => {
    saveWidgetConfig("w1", { a: 1 });
    expect(loadWidgetConfig("w1")).toEqual({ a: 1 });
    // 模拟对端（另一窗口）在 150ms 窗口内编辑并写入共享 LS（更晚的写入）。
    localStorage.setItem(keyOf("w1"), JSON.stringify({ a: 1, b: 2 }));
    await vi.waitFor(() => expect(cfgEmits()).toHaveLength(1));
    expect(lastCfg().instanceId).toBe("w1");
    // 修复前这里发射的是入槽旧快照 {a:1}，会把对端的 b:2 回滚掉。
    expect(lastCfg().config).toEqual({ a: 1, b: 2 });
  });

  it("pagehide 冲刷同口径：现读 LS 真值（关窗尾包不回滚对端）", async () => {
    saveWidgetConfig("w2", { x: 9 });
    localStorage.setItem(keyOf("w2"), JSON.stringify({ x: 9, y: 8 }));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(cfgEmits()).toHaveLength(1));
    expect(lastCfg().config).toEqual({ x: 9, y: 8 });
  });

  it("无待发时 flushWidgetConfigSync 为 no-op，不发射噪声包", async () => {
    flushWidgetConfigSync("w3");
    await new Promise((res) => setTimeout(res, 200));
    expect(cfgEmits()).toHaveLength(0);
  });
});
