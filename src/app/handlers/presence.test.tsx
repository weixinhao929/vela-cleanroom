import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/**
 * （handlers 契约测试）：presence 域全局 handler 的事件载荷 → DOM 效应
 * 映射。handlers 是所有 Tauri 事件的分发枢纽，此前整目录零测试。这里把
 * @tauri-apps/api/event 的 listen 换成进程内注册表，按真实载荷形状派发
 * presence:state 快照，断言三件套（淡化/降玻璃/装饰降级）的根属性翻转与
 * 阈值边界——Rust 侧 PresenceSnapshot 字段一旦改名/改语义，这里第一时间红。
 */
const handlers = new Map<string, Array<(p: unknown) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    const wrapper = (p: unknown) => cb({ payload: p });
    const list = handlers.get(event) ?? [];
    list.push(wrapper);
    handlers.set(event, list);
    return () => {
      const cur = (handlers.get(event) ?? []).filter((f) => f !== wrapper);
      handlers.set(event, cur);
    };
  }),
  emit: vi.fn(async () => {})
}));
vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true };
});
vi.mock("../../store/settings-store", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../store/settings-store")>();
  return { ...mod, reapplyTheme: vi.fn() };
});

import { GlobalIdleDecor, GlobalIdleDim, GlobalIdleGlass } from "./presence";
import { useSettingsStore, reapplyTheme } from "../../store/settings-store";
import { isIdleDecor } from "../../lib/idle-decor";

type Snap = {
  state: "active" | "idle" | "fullscreen";
  idle_secs: number;
  fullscreen?: boolean;
  covered?: boolean;
};
const snap = (state: Snap["state"], idle_secs: number): Snap => ({ state, idle_secs, fullscreen: false });
function emitPresence(p: Snap): void {
  for (const fn of handlers.get("presence:state") ?? []) fn(p);
}

let unmountAll: () => void = () => {};
function mountAll(): void {
  const { unmount } = render(
    <>
      <GlobalIdleDim />
      <GlobalIdleGlass />
      <GlobalIdleDecor />
    </>
  );
  unmountAll = unmount;
}

beforeEach(() => {
  handlers.clear();
  vi.mocked(reapplyTheme).mockClear();
  useSettingsStore.setState({ extra: { ...useSettingsStore.getState().extra, idleDim: true, idleGlassOff: true } });
  mountAll();
});
afterEach(() => {
  unmountAll();
  cleanup();
  emitPresence(snap("active", 0));
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-no-glass");
  document.documentElement.removeAttribute("data-fx-off");
});

describe("presence handlers 契约（presence:state → DOM）", () => {
  it("GlobalIdleDim：Idle≥60s 挂 .idle-dim，59s 不挂，active 摘除", () => {
    emitPresence(snap("idle", 59));
    expect(document.documentElement.classList.contains("idle-dim")).toBe(false);
    emitPresence(snap("idle", 60));
    expect(document.documentElement.classList.contains("idle-dim")).toBe(true);
    emitPresence(snap("active", 0));
    expect(document.documentElement.classList.contains("idle-dim")).toBe(false);
  });

  it("GlobalIdleGlass：Idle≥60s 挂 data-no-glass，active 委托 reapplyTheme 恢复", () => {
    emitPresence(snap("idle", 60));
    expect(document.documentElement.getAttribute("data-no-glass")).toBe("1");
    emitPresence(snap("active", 0));
    // 属性的摘除由 reapplyTheme（theme-engine 重放）负责——本单元契约是
    // 「恢复路径必须调用它」，不在此断言属性移除（那是 reapplyTheme 的职责）。
    expect(reapplyTheme).toHaveBeenCalled();
  });

  it("GlobalIdleDecor：Idle≥30s 挂 data-idle + ambientMotion 入闸且保留用户既有 fx-off token", () => {
    // 预置用户已关闭的特效 token：空闲追加不得清掉它。
    document.documentElement.setAttribute("data-fx-off", "pointerFollow");
    emitPresence(snap("idle", 29));
    expect(isIdleDecor()).toBe(false);
    emitPresence(snap("idle", 30));
    expect(isIdleDecor()).toBe(true);
    expect(document.documentElement.getAttribute("data-idle")).toBe("1");
    expect(document.documentElement.getAttribute("data-fx-off")).toBe("pointerFollow ambientMotion");
    emitPresence(snap("active", 0));
    expect(isIdleDecor()).toBe(false);
    expect(document.documentElement.hasAttribute("data-idle")).toBe(false);
    expect(reapplyTheme).toHaveBeenCalled();
  });

  it("GlobalIdleDecor：空闲期间改动画设置（applySettings 重写 data-fx-off）后立即补挂 ambientMotion", () => {
    emitPresence(snap("idle", 30));
    expect(document.documentElement.getAttribute("data-fx-off")).toContain("ambientMotion");
    // 模拟 applySettings 按 fxToggles 重写 data-fx-off：空闲闸被抹掉。
    document.documentElement.setAttribute("data-fx-off", "pointerFollow");
    expect(document.documentElement.getAttribute("data-fx-off")).not.toContain("ambientMotion");
    // 任何 extra 写入（sanitize 新建 fxToggles 引用）触发订阅 effect 补挂。
    act(() => {
      useSettingsStore.setState({
        extra: { ...useSettingsStore.getState().extra, fxToggles: { ...useSettingsStore.getState().extra.fxToggles } }
      });
    });
    expect(document.documentElement.getAttribute("data-fx-off")).toBe("pointerFollow ambientMotion");
    // 活跃态不补挂（applySettings 的重写即最终态）。
    emitPresence(snap("active", 0));
    document.documentElement.setAttribute("data-fx-off", "pointerFollow");
    act(() => {
      useSettingsStore.setState({
        extra: { ...useSettingsStore.getState().extra, fxToggles: { ...useSettingsStore.getState().extra.fxToggles } }
      });
    });
    expect(document.documentElement.getAttribute("data-fx-off")).toBe("pointerFollow");
  });

  it("fullscreen 态不触发任何空闲降级（投影/全屏是活跃使用）", () => {
    emitPresence(snap("fullscreen", 120));
    expect(document.documentElement.classList.contains("idle-dim")).toBe(false);
    expect(document.documentElement.getAttribute("data-no-glass")).toBeNull();
    expect(isIdleDecor()).toBe(false);
  });

  it("P-占用②：covered=true（active 态被最大化盖住）触发装饰降级与降玻璃，退出即时恢复", () => {
    emitPresence({ state: "active", idle_secs: 0, fullscreen: false, covered: true });
    // 装饰降级与时钟降频同空闲路径；淡化（视觉态）不参与。
    expect(isIdleDecor()).toBe(true);
    expect(document.documentElement.getAttribute("data-fx-off")).toContain("ambientMotion");
    expect(document.documentElement.getAttribute("data-no-glass")).toBe("1");
    expect(document.documentElement.classList.contains("idle-dim")).toBe(false);
    emitPresence({ state: "active", idle_secs: 0, fullscreen: false, covered: false });
    expect(isIdleDecor()).toBe(false);
    expect(reapplyTheme).toHaveBeenCalled();
  });

  it("P-占用②：covered 字段缺省（旧载荷）按无遮挡处理，行为与改动前一致", () => {
    emitPresence({ state: "active", idle_secs: 0, fullscreen: false });
    expect(isIdleDecor()).toBe(false);
    expect(document.documentElement.getAttribute("data-no-glass")).toBeNull();
  });

  it("畸形载荷（null/缺字段）不抛异常不翻转状态", () => {
    emitPresence(null as unknown as Snap);
    expect(() => emitPresence({ state: "idle" } as unknown as Snap)).not.toThrow();
    expect(isIdleDecor()).toBe(false);
    expect(document.documentElement.classList.contains("idle-dim")).toBe(false);
  });
});
