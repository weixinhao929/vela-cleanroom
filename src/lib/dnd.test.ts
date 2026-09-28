import { beforeEach, describe, expect, it, vi } from "vitest";
import { inDndSchedule } from "./dnd";

/**
 * 免打扰开关 + 时段计划：模块级状态 + localStorage 持久化。模块态用例
 * 每条 resetModules 重载，验证「启动即读 localStorage」的初始化路径；
 * inDndSchedule 是纯函数，静态导入直测。
 */
describe("lib/dnd", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("默认关闭；setDnd 切换并通知订阅者；重复设置同值不重复通知", async () => {
    const m = await import("./dnd");
    expect(m.dndEnabled()).toBe(false);
    const fn = vi.fn();
    const un = m.subscribeDnd(fn);
    m.setDnd(true);
    m.setDnd(true);
    expect(m.dndEnabled()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    un();
    m.setDnd(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("持久化到 focus-desk.dnd.v1 并在下次加载时恢复；损坏值回落 false", async () => {
    const m = await import("./dnd");
    m.setDnd(true);
    expect(JSON.parse(localStorage.getItem("focus-desk.dnd.v1") ?? "{}")).toEqual({ on: true });

    vi.resetModules();
    const again = await import("./dnd");
    expect(again.dndEnabled()).toBe(true);

    localStorage.setItem("focus-desk.dnd.v1", "{bad json");
    vi.resetModules();
    const broken = await import("./dnd");
    expect(broken.dndEnabled()).toBe(false);
  });

  it("旧载荷 {on:true}（无 sched 字段）向后兼容", async () => {
    localStorage.setItem("focus-desk.dnd.v1", JSON.stringify({ on: true }));
    vi.resetModules();
    const m = await import("./dnd");
    expect(m.dndEnabled()).toBe(true);
    // 无计划 → 默认关闭态（22:00–08:00 模板，enabled=false）。
    expect(m.getDndSchedule()).toEqual({ enabled: false, start: "22:00", end: "08:00" });
    expect(m.dndSuppressing(new Date(2026, 8, 24, 23, 0))).toBe(true); // 手动开
  });

  it("非法 sched 字段逐项回落默认，不炸初始化", async () => {
    localStorage.setItem(
      "focus-desk.dnd.v1",
      JSON.stringify({ on: false, sched: { enabled: "yes", start: "25:99", end: null } })
    );
    vi.resetModules();
    const m = await import("./dnd");
    expect(m.getDndSchedule()).toEqual({ enabled: false, start: "22:00", end: "08:00" });
  });
});

/** inDndSchedule 纯函数：同日 / 跨午夜 / 全天 / 非法输入 / 未启用。 */
describe("inDndSchedule", () => {
  const at = (h: number, mi: number) => new Date(2026, 8, 24, h, mi, 0);
  const sched = (start: string, end: string, enabled = true) => ({ enabled, start, end });

  it("同日时段：含两端", () => {
    const s = sched("12:00", "14:00");
    expect(inDndSchedule(s, at(11, 59))).toBe(false);
    expect(inDndSchedule(s, at(12, 0))).toBe(true);
    expect(inDndSchedule(s, at(13, 30))).toBe(true);
    expect(inDndSchedule(s, at(14, 0))).toBe(true);
    expect(inDndSchedule(s, at(14, 1))).toBe(false);
  });

  it("跨午夜时段：环绕判定", () => {
    const s = sched("22:00", "08:00");
    expect(inDndSchedule(s, at(21, 59))).toBe(false);
    expect(inDndSchedule(s, at(22, 0))).toBe(true);
    expect(inDndSchedule(s, at(23, 59))).toBe(true);
    expect(inDndSchedule(s, at(0, 0))).toBe(true);
    expect(inDndSchedule(s, at(3, 0))).toBe(true);
    expect(inDndSchedule(s, at(8, 0))).toBe(true);
    expect(inDndSchedule(s, at(8, 1))).toBe(false);
  });

  it("起止相同视为全天；未启用 / 非法时间恒 false", () => {
    expect(inDndSchedule(sched("09:00", "09:00"), at(15, 0))).toBe(true);
    expect(inDndSchedule(sched("09:00", "10:00", false), at(9, 30))).toBe(false);
    expect(inDndSchedule(sched("9:0", "10:00"), at(9, 30))).toBe(false);
    expect(inDndSchedule(sched("24:00", "10:00"), at(9, 30))).toBe(false);
    expect(inDndSchedule(sched("09:00", "10:99"), at(9, 30))).toBe(false);
  });
});

/** dndSuppressing 终判：手动开关 ∪ 计划时段。 */
describe("dndSuppressing", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("手动开关与计划时段取并集；sched 随 setDnd 一并保留", async () => {
    const m = await import("./dnd");
    const at = (h: number, mi: number) => new Date(2026, 8, 24, h, mi, 0);
    m.setDndSchedule({ enabled: true, start: "22:00", end: "08:00" });
    expect(m.dndSuppressing(at(23, 0))).toBe(true);
    expect(m.dndSuppressing(at(12, 0))).toBe(false);
    m.setDnd(true);
    expect(m.dndSuppressing(at(12, 0))).toBe(true);
    // setDnd 不清计划（整块 state 更新）。
    expect(m.getDndSchedule().enabled).toBe(true);
    const raw = JSON.parse(localStorage.getItem("focus-desk.dnd.v1") ?? "{}");
    expect(raw).toMatchObject({ on: true, sched: { enabled: true, start: "22:00", end: "08:00" } });
  });
});
