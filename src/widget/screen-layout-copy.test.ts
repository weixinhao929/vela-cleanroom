import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyScreenLayout } from "./screen-layout-copy";
import { useWidgetStore } from "./widget-store";
import { scheduleWidgetWindowReconcile } from "./window-reconcile";
import {
  isPersistSuspended,
  resetPersistGateForTests,
  resumePersistence,
  suspendPersistence
} from "../lib/persist-gate";

vi.mock("./window-reconcile", () => ({
  scheduleWidgetWindowReconcile: vi.fn()
}));

/* 测试需要走到 isTauri 分支（emit / SQLite 镜像）：默认关闭保持
   原有各用例的浏览器模式语义，单个用例内打开并在 finally 复位。 */
const env = vi.hoisted(() => ({ tauriLike: false, emitMock: vi.fn(async (_name: string, _payload?: unknown) => {}) }));
vi.mock("../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/tauri")>();
  return { ...mod, isTauri: () => env.tauriLike };
});
vi.mock("@tauri-apps/api/event", () => ({
  emit: (name: string, payload?: unknown) => env.emitMock(name, payload),
  listen: vi.fn(async () => () => {})
}));

/**
 * 跨屏布局复制：视图列表 / 每视图实例与编组 / 活动视图整体搬家；
 * dock / 模板 / 回收站不随行；源空 / 同屏返回 null。
 * SQLite 镜像与 sync:widgets 走 isTauri 分支（jsdom 下不触发）。
 */
describe("copyScreenLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(scheduleWidgetWindowReconcile).mockClear();
    env.tauriLike = false;
    env.emitMock.mockClear();
    resetPersistGateForTests();
  });

  const seedScreen = (screen: string) => {
    localStorage.setItem(
      `focus-desk.screen.${screen}.widgets.views.v1`,
      JSON.stringify([
        { id: "v1", name: "默认" },
        { id: "v2", name: "工作" }
      ])
    );
    localStorage.setItem(`focus-desk.screen.${screen}.widgets.view.v1`, "v2");
    localStorage.setItem(
      `focus-desk.screen.${screen}.widgets.v1.v1`,
      JSON.stringify([{ id: "a", type: "notes", x: 0, y: 0, w: 100, h: 100, z: 1 }])
    );
    localStorage.setItem(
      `focus-desk.screen.${screen}.widgets.v2.v1`,
      JSON.stringify([
        { id: "b", type: "todo", x: 10, y: 10, w: 100, h: 100, z: 1 },
        { id: "c", type: "clock", x: 20, y: 20, w: 100, h: 100, z: 2 }
      ])
    );
    localStorage.setItem(`focus-desk.screen.${screen}.groups.v2.v1`, JSON.stringify([]));
  };

  it("整组键搬家：视图列表 / 活动视图 / 每视图实例与编组", () => {
    seedScreen("0");
    const result = copyScreenLayout("0", "1");
    expect(result).toEqual({ views: 2, instances: 3 });
    expect(localStorage.getItem("focus-desk.screen.1.widgets.views.v1")).toBe(
      localStorage.getItem("focus-desk.screen.0.widgets.views.v1")
    );
    expect(localStorage.getItem("focus-desk.screen.1.widgets.view.v1")).toBe("v2");
    expect(localStorage.getItem("focus-desk.screen.1.widgets.v1.v1")).toBe(
      localStorage.getItem("focus-desk.screen.0.widgets.v1.v1")
    );
    expect(localStorage.getItem("focus-desk.screen.1.widgets.v2.v1")).toBe(
      localStorage.getItem("focus-desk.screen.0.widgets.v2.v1")
    );
    expect(localStorage.getItem("focus-desk.screen.1.groups.v2.v1")).toBe("[]");
  });

  it("dock / 模板 / 回收站键不随行", () => {
    seedScreen("0");
    localStorage.setItem("focus-desk.screen.0.dock.v1", '{"enabled":true}');
    localStorage.setItem("focus-desk.screen.0.widgets.trash.v1", "[]");
    copyScreenLayout("0", "1");
    expect(localStorage.getItem("focus-desk.screen.1.dock.v1")).toBeNull();
    expect(localStorage.getItem("focus-desk.screen.1.widgets.trash.v1")).toBeNull();
  });

  it("源屏无视图 / 同屏 / 空 id 返回 null", () => {
    seedScreen("0");
    localStorage.removeItem("focus-desk.screen.0.widgets.views.v1");
    expect(copyScreenLayout("0", "1")).toBeNull();
    expect(copyScreenLayout("0", "0")).toBeNull();
    expect(copyScreenLayout("", "1")).toBeNull();
    // 没有发生复制时不排窗口对账（无谓的 Rust 枚举轮）。
    expect(scheduleWidgetWindowReconcile).not.toHaveBeenCalled();
  });

  it("复制成功后排一次窗口对账（P1：空屏目标此前要等重启才建窗）", () => {
    seedScreen("0");
    copyScreenLayout("0", "1");
    expect(scheduleWidgetWindowReconcile).toHaveBeenCalledTimes(1);
  });

  it("设置窗正管理目标屏时刷新内存态（views/activeView/instances）", () => {
    seedScreen("0");
    useWidgetStore.setState({ screenId: "1", views: [], activeView: "x", instances: [] });
    copyScreenLayout("0", "1");
    const st = useWidgetStore.getState();
    expect(st.views).toHaveLength(2);
    expect(st.activeView).toBe("v2");
    expect(st.instances).toHaveLength(2);
  });

  /* 复制广播的 trash 此前硬编码 []，目标屏存活窗口
     经 applyRemoteWidgets 采纳时会无条件覆写 trash（镜像 + setState）——等于
     清空目标屏回收站。修复后随包携带目标屏 trash 原值，接收方写回自己的
     现有回收站，净效应为零；LS trash 键仍不落盘（不复制回收站语义不变）。 */
  it("T-15：sync:widgets 广播携带目标屏回收站原值（不再清空目标屏回收站）", async () => {
    env.tauriLike = true;
    try {
      seedScreen("0");
      const trash1 = [
        { id: "t1", type: "notes", x: 0, y: 0, w: 10, h: 10, z: 1, view: "v2", deletedAt: "2026-08-01T00:00:00.000Z" }
      ];
      localStorage.setItem("focus-desk.screen.1.widgets.trash.v1", JSON.stringify(trash1));
      copyScreenLayout("0", "1");
      // emit 经动态 import 走微任务，waitFor 兜住。
      await vi.waitFor(() => {
        expect(env.emitMock.mock.calls.some(([name]) => name === "sync:widgets")).toBe(true);
      });
      const call = env.emitMock.mock.calls.find(([name]) => name === "sync:widgets")!;
      expect(call[1]).toMatchObject({ screenId: "1", activeView: "v2", trash: trash1 });
      // 目标屏 trash 键不被复制路径落盘（复制只搬布局结构）。
      expect(localStorage.getItem("focus-desk.screen.1.widgets.trash.v1")).toBe(JSON.stringify(trash1));
    } finally {
      env.tauriLike = false;
    }
  });

  /* 整表写挂持久化闸门（口径）——恢复备份
     进行中，迟到的跨屏复制不得把恢复前的布局盖回共享 LS（emit 广播与内存
     态照常，恢复以 reload 收尾）。 */
  it("P3-18：持久化暂停期间整表写被闸门挡下", () => {
    suspendPersistence("self");
    try {
      seedScreen("0");
      const result = copyScreenLayout("0", "1");
      expect(result).toEqual({ views: 2, instances: 3 });
      expect(isPersistSuspended()).toBe(true);
      expect(localStorage.getItem("focus-desk.screen.1.widgets.views.v1")).toBeNull();
      expect(localStorage.getItem("focus-desk.screen.1.widgets.view.v1")).toBeNull();
      expect(localStorage.getItem("focus-desk.screen.1.widgets.v2.v1")).toBeNull();
    } finally {
      resumePersistence("self");
    }
  });
});
