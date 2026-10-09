import { afterEach, describe, expect, it } from "vitest";
import { isIdleDecor, setIdleDecor, useIdleDecor } from "./idle-decor";
import { act, renderHook } from "@testing-library/react";

/**
 * 空闲装饰降级事实源的行为守卫：属性翻转 / 订阅通知 / 幂等。
 */
describe("idle-decor（G-9）", () => {
  afterEach(() => {
    setIdleDecor(false);
    document.documentElement.removeAttribute("data-idle");
  });

  it("置真挂 html[data-idle=1]，置 False 摘除", () => {
    setIdleDecor(true);
    expect(isIdleDecor()).toBe(true);
    expect(document.documentElement.getAttribute("data-idle")).toBe("1");
    setIdleDecor(false);
    expect(isIdleDecor()).toBe(false);
    expect(document.documentElement.hasAttribute("data-idle")).toBe(false);
  });

  it("重复写同值幂等：不重复通知订阅方", () => {
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders += 1;
      return useIdleDecor();
    });
    expect(result.current).toBe(false);
    const base = renders;
    act(() => setIdleDecor(true));
    expect(renders).toBe(base + 1);
    // 同值二次写：订阅方不被打扰。
    act(() => setIdleDecor(true));
    expect(renders).toBe(base + 1);
    act(() => setIdleDecor(false));
    expect(renders).toBe(base + 2);
    unmount();
  });

  it("useIdleDecor 随翻转重渲", async () => {
    const { result } = renderHook(() => useIdleDecor());
    expect(result.current).toBe(false);
    act(() => setIdleDecor(true));
    expect(result.current).toBe(true);
    act(() => setIdleDecor(false));
    expect(result.current).toBe(false);
  });
});
