/**
 * 设置页 · 动效页测试：
 *  - 辉光拖尾样式行已移除（样式二选一下线，只保留聚光光斑）；
 *  - 「指针跟随」开关写入 extra.fxToggles，重开删除显式覆盖；
 *  - settings-search 索引命中「指针跟随」「聚光」，不再命中「辉光」；
 *  - 预览区：时长微调/入场/视图切换变化重播；视图切换=淡入的预览类与
 *    底部提示一致（修复前 fade 档漏映射，提示有动画而卡不动）；
 *  - 增强档：预览卡挂 .fx-demo 演示流光，特效管理区不弱化；标准档反之；
 *  - 特效批量按钮：全部开启/全部关闭的 disabled 态随 fxToggles 翻转。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { AnimationPage } from "./AnimationPage";
import { searchSettings } from "../settings-search";
import { useSettingsStore } from "../../../store/settings-store";

const extra = () => useSettingsStore.getState().extra;

describe("AnimationPage · 指针跟随特效", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      extra: {
        ...useSettingsStore.getState().extra,
        enableAnimations: true,
        animationMode: "enhanced",
        fxToggles: {}
      }
    });
  });

  it("辉光拖尾样式行已移除：页面不渲染「指针跟随样式」分组", () => {
    render(<AnimationPage />);
    expect(screen.queryByRole("group", { name: "指针跟随样式" })).toBeNull();
    expect(screen.queryByText("辉光拖尾")).toBeNull();
  });

  it("关闭「指针跟随」写入 fxToggles 显式覆盖，重开删除覆盖项", async () => {
    const { userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<AnimationPage />);
    await user.click(screen.getByRole("switch", { name: "指针跟随" }));
    expect(extra().fxToggles.pointerFollow).toBe(false);
    await user.click(screen.getByRole("switch", { name: "指针跟随" }));
    expect(extra().fxToggles.pointerFollow).toBeUndefined();
  });

  it("settings-search：「指针跟随」「聚光」命中 animation 页，「辉光」不再命中", () => {
    expect(searchSettings("指针跟随").some((e) => e.page === "animation")).toBe(true);
    expect(searchSettings("聚光").some((e) => e.page === "animation")).toBe(true);
    expect(searchSettings("辉光").some((e) => e.page === "animation" && e.title === "指针跟随")).toBe(false);
  });
});

describe("AnimationPage · 预览区", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      extra: {
        ...useSettingsStore.getState().extra,
        enableAnimations: true,
        animationMode: "standard",
        animationDuration: 100,
        widgetEntrance: "none",
        viewTransition: "none",
        fxToggles: {}
      }
    });
  });

  it("动画时长微调变化重播预览（卡片节点重建，300ms 尾随防抖）", async () => {
    const { container } = render(<AnimationPage />);
    const before = container.querySelector<HTMLElement>(".tm-preview-card.w1");
    expect(before).not.toBeNull();
    act(() => {
      useSettingsStore.getState().setExtra({ animationDuration: 150 });
    });
    // 时长滑条走 trailing debounce（拖动中不连闪），停手后重播。
    const { waitFor } = await import("@testing-library/react");
    await waitFor(
      () => {
        const after = container.querySelector<HTMLElement>(".tm-preview-card.w1");
        expect(after).not.toBe(before);
      },
      { timeout: 1000 }
    );
    expect(before?.isConnected).toBe(false);
  });

  it("视图切换=淡入且小组件出现=无：预览播淡入，提示不再自相矛盾", () => {
    act(() => {
      useSettingsStore.getState().setExtra({ viewTransition: "fade" });
    });
    const { container } = render(<AnimationPage />);
    const card = container.querySelector<HTMLElement>(".tm-preview-card.w1");
    expect(card?.className).toContain("run-fade");
    expect(screen.getByText(/视图切换 · 当前：/)).toBeTruthy();
  });

  it("增强档：预览卡挂 .fx-demo，特效管理区不弱化；标准档反之", () => {
    const std = render(<AnimationPage />);
    expect(std.container.querySelector(".tm-preview-card.fx-demo")).toBeNull();
    expect(std.container.querySelector(".tm-fx-manage")?.getAttribute("data-fx-inactive")).toBe("1");
    std.unmount();

    act(() => {
      useSettingsStore.getState().setExtra({ animationMode: "enhanced" });
    });
    const enh = render(<AnimationPage />);
    expect(enh.container.querySelector(".tm-preview-card.fx-demo")).not.toBeNull();
    expect(enh.container.querySelector(".tm-fx-manage")?.getAttribute("data-fx-inactive")).toBe("0");
    expect(enh.getByText(/增强档：卡片边缘演示流光边框/)).toBeTruthy();
  });

  it("增强档 + 特效管理单独关闭流光边框：卡片仍挂 fx-demo（CSS 闸熄灭），提示文案随之切换", () => {
    act(() => {
      useSettingsStore.getState().setExtra({ animationMode: "enhanced", fxToggles: { starBorder: false } });
    });
    const view = render(<AnimationPage />);
    expect(view.container.querySelector(".tm-preview-card.fx-demo")).not.toBeNull();
    expect(view.getByText(/流光边框已在特效管理中关闭/)).toBeTruthy();
  });

  it("特效批量按钮：全部开启/全部关闭的 disabled 态随 fxToggles 翻转", () => {
    const { container } = render(<AnimationPage />);
    const bulk = container.querySelector<HTMLElement>(".tm-fx-bulk");
    const allOn = bulk?.querySelectorAll<HTMLButtonElement>("button")[0];
    const allOff = bulk?.querySelectorAll<HTMLButtonElement>("button")[1];
    expect(allOn).toBeTruthy();
    expect(allOff).toBeTruthy();
    // 初始 fxToggles={}（全开态）：「全部开启」禁用，「全部关闭」可用。
    expect(allOn?.disabled).toBe(true);
    expect(allOff?.disabled).toBe(false);

    act(() => {
      useSettingsStore.getState().setExtra({ fxToggles: { starBorder: false } });
    });
    expect(allOn?.disabled).toBe(false);
    expect(allOff?.disabled).toBe(false);

    act(() => {
      useSettingsStore.getState().setExtra({
        fxToggles: Object.fromEntries(
          [
            "starBorder",
            "shinyText",
            "textFx",
            "listStagger",
            "pointerFollow",
            "ambientGlow",
            "hoverGlow",
            "elastic",
            "specular",
            "pixelSwap",
            "particleText",
            "cardHover",
            "springCheck",
            "ambientMotion"
          ].map((id) => [id, false] as const)
        )
      });
    });
    expect(allOn?.disabled).toBe(false);
    expect(allOff?.disabled).toBe(true);
  });

  it("settings-search：总开关 / 曲线 / 空闲 / 特效名均可命中 animation 页", () => {
    for (const kw of ["启用动画", "贝塞尔", "缓动", "空闲时淡化卡片", "流光边框", "粒子文字", "弹性反馈"]) {
      expect(searchSettings(kw).some((e) => e.page === "animation")).toBe(true);
    }
  });
});
