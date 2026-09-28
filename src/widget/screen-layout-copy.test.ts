import { beforeEach, describe, expect, it } from "vitest";
import { copyScreenLayout } from "./screen-layout-copy";
import { useWidgetStore } from "./widget-store";

/**
 * 跨屏布局复制：视图列表 / 每视图实例与编组 / 活动视图整体搬家；
 * dock / 模板 / 回收站不随行；源空 / 同屏返回 null。
 * SQLite 镜像与 sync:widgets 走 isTauri 分支（jsdom 下不触发）。
 */
describe("copyScreenLayout", () => {
  beforeEach(() => localStorage.clear());

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
});
