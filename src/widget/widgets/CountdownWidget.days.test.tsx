import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CountdownWidget } from "./CountdownWidget";
import { __resetMirrorSyncStateForTests } from "../../lib/local-backup";

/**
 * 倒数日条目删除改二段确认（useConfirmAction，与
 * Habit/Gallery 同款）——首次点击进入待决态（图标换 ✓、aria-label 变
 * 「再次点击确认删除」），再点才真正落删。锁定此前「单击即永久删除」
 * 的交互规范单点漏网不再回归。
 */

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => false };
});

const ID = "cd-confirm-test";
const key = `focus-desk.widget-config.${ID}.v1`;
const targets = [{ id: "t1", label: "生日", date: "2026-12-01" }];

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(key, JSON.stringify({ mode: "days", targets }));
});
afterEach(() => {
  vi.useRealTimers();
  __resetMirrorSyncStateForTests();
});

function openDaysMode() {
  // 配置已带 mode: "days"，直接渲染倒数日列表。
  render(<CountdownWidget instanceId={ID} />);
}

describe("CountdownWidget 倒数日删除二段确认（WC-1）", () => {
  it("首次点击只进入待决态，不删除；再点确认才落删", async () => {
    openDaysMode();
    const persisted = () => JSON.parse(localStorage.getItem(key) || "{}").targets ?? [];

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    // 待决态：同一按钮的 aria-label 切到确认语义，条目与持久化都还在。
    expect(screen.getByRole("button", { name: "再次点击确认删除" })).toBeInTheDocument();
    expect(screen.getByText("生日")).toBeInTheDocument();
    expect(persisted()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "再次点击确认删除" }));
    // 退场动画（is-closing 200ms）后真正落删并写回配置。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.queryByText("生日")).not.toBeInTheDocument();
    expect(persisted()).toHaveLength(0);
  });

  it("待决 2s 超时后自动复位，再点从待决重新开始", async () => {
    openDaysMode();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    // 超时复位：回到「删除」语义；此时单击仍只进入待决态。
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("button", { name: "再次点击确认删除" })).toBeInTheDocument();
    expect(screen.getByText("生日")).toBeInTheDocument();
  });
});
