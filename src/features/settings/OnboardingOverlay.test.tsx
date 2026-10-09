/**
 * 首次启动引导（OnboardingOverlay）组件测试：
 *  - extra.onboarded=false 时覆盖层出现（首步「欢迎使用 Vela」+ 4 个步骤点），
 *    true 时完全不渲染；
 *  - 「下一步」逐步推进，末步按钮变「开始使用」，点击后经退场延时写入
 *    extra.onboarded=true 并卸载；
 *  - 「跳过」同样置位（引导永不再次自动弹出）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OnboardingOverlay } from "./OnboardingOverlay";
import { useSettingsStore } from "../../store/settings-store";

const setOnboarded = (v: boolean) => useSettingsStore.setState((s) => ({ extra: { ...s.extra, onboarded: v } }));

beforeEach(() => {
  setOnboarded(false);
});

describe("OnboardingOverlay", () => {
  it("未完成引导时渲染首步与步骤指示", () => {
    render(<OnboardingOverlay />);
    expect(screen.getByRole("dialog", { name: "新手引导" })).toBeTruthy();
    expect(screen.getByText("欢迎使用 Vela")).toBeTruthy();
    // 4 个步骤点（纯指示器，非按钮）。
    expect(document.querySelectorAll(".tm-onb-dot")).toHaveLength(4);
    expect(document.querySelector(".tm-onb-dot.active")).toBeTruthy();
    // 首步没有「上一步」。
    expect(screen.queryByText("上一步")).toBeNull();
  });

  it("已完成引导时不渲染", () => {
    setOnboarded(true);
    render(<OnboardingOverlay />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("已完成引导后按 Esc 不触发持久化、事件不被拦截", async () => {
    // 回归：onboarded=true 后组件仍挂载（return null 但 effect 已跑过），
    // 旧实现的 window 捕获监听常驻——既吞掉设置窗全部 Esc，又每次按键都
    // finish() 触发 setExtra 全量落盘 + 跨窗同步。
    setOnboarded(true);
    const setExtraSpy = vi.spyOn(useSettingsStore.getState(), "setExtra");
    render(<OnboardingOverlay />);
    expect(screen.queryByRole("dialog")).toBeNull();
    // 探针挂在 document（冒泡阶段）：旧实现 stopPropagation 在 window 捕获层
    // 吃掉事件，探针不会响；修复后应正常收到。
    let reachedDocument = false;
    const probe = () => {
      reachedDocument = true;
    };
    document.addEventListener("keydown", probe);
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    document.removeEventListener("keydown", probe);
    expect(reachedDocument).toBe(true);
    // 等过退场动画延时窗口（fxMs+20 ≈ 220ms），确认没有潜伏的 finish() 定时器。
    await new Promise((r) => setTimeout(r, 320));
    expect(setExtraSpy).not.toHaveBeenCalled();
    setExtraSpy.mockRestore();
  });

  it("下一步推进到末步，开始使用后置位并卸载", async () => {
    const user = userEvent.setup();
    render(<OnboardingOverlay />);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("把小组件放上桌面")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("常用快捷键")).toBeTruthy();
    // 第二步起出现「上一步」，可回退。
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByText("把小组件放上桌面")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("专注与通知")).toBeTruthy();
    // 末步按钮文案切换为「开始使用」；点击 → 退场动画延时后置位。
    await user.click(screen.getByRole("button", { name: "开始使用" }));
    await waitFor(() => expect(useSettingsStore.getState().extra.onboarded).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("跳过同样置位（不再自动弹出）", async () => {
    const user = userEvent.setup();
    render(<OnboardingOverlay />);
    await user.click(screen.getByRole("button", { name: "跳过引导" }));
    await waitFor(() => expect(useSettingsStore.getState().extra.onboarded).toBe(true));
  });
});
