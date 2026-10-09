import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClockWidget } from "./ClockWidget";
import { __resetMirrorSyncStateForTests } from "../../lib/local-backup";

/**
 * ClockWidget 内置秒表：
 *  - 表冠切走再切回：running / 计时不清零，隐藏期由 performance.now 单调钟
 *    差值照常累计（此前条件渲染即卸载，切一次表冠会话静默归零）；
 *  - 停止后切走再切回：读数冻结保持（会话三值完整保留在 ClockWidget 层）。
 */

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => false };
});

const ID = "clock-stopwatch-test";

/** 从 .clock-stopwatch-time 文本（mm:ss.cs）解析已计时毫秒数。 */
const readMs = (): number => {
  const text = document.querySelector(".clock-stopwatch-time")?.textContent ?? "";
  const m = text.match(/(\d+):(\d+)\.(\d+)/);
  if (!m) throw new Error(`stopwatch time not rendered: ${JSON.stringify(text)}`);
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) * 10;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => localStorage.clear());
afterEach(() => __resetMirrorSyncStateForTests());

describe("ClockWidget 内置秒表会话（X-22）", () => {
  it("表冠切走再切回：计时连续不丢（隐藏期照常累计）", async () => {
    render(<ClockWidget instanceId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "秒表" }));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await sleep(120);
    const before = readMs();
    expect(before).toBeGreaterThan(0);
    // 切回时钟（秒表视图卸载）——隐藏期继续计时
    fireEvent.click(screen.getByRole("button", { name: "返回时钟" }));
    expect(screen.queryByText("归零")).toBeNull();
    await sleep(150);
    fireEvent.click(screen.getByRole("button", { name: "秒表" }));
    // 重挂首帧读数即含隐藏期（现算 base + now − start，不等下一拍采样）
    const after = readMs();
    expect(after).toBeGreaterThanOrEqual(before + 100);
  });

  it("停止后切走再切回：读数保持冻结", async () => {
    render(<ClockWidget instanceId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "秒表" }));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await sleep(80);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    const frozen = readMs();
    fireEvent.click(screen.getByRole("button", { name: "返回时钟" }));
    await sleep(150);
    fireEvent.click(screen.getByRole("button", { name: "秒表" }));
    expect(readMs()).toBe(frozen);
    // 「开始」从冻结值续跑（分段累计语义不变）
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => expect(readMs()).toBeGreaterThanOrEqual(frozen));
  });
});
