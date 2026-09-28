/**
 * 设置页 · 动效页「指针跟随」特效测试：
 *  - 辉光拖尾样式行已移除（样式二选一下线，只保留聚光光斑）；
 *  - 「指针跟随」开关写入 extra.fxToggles，重开删除显式覆盖；
 *  - settings-search 索引命中「指针跟随」「聚光」，不再命中「辉光」。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
