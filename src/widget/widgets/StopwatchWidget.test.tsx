import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StopwatchWidget, fmtStopwatch, lapRows } from "./StopwatchWidget";
import { __resetMirrorSyncStateForTests } from "../../lib/local-backup";

/** 秒表组件测试：格式化纯函数、计次行推导、启停/计次/重置交互与持久化恢复。 */

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => false };
});

const ID = "sw-test";
const KEY = `focus-desk.stopwatch.state.${ID}`;

/** 假时钟推进需包 act 冲刷 interval 触发的渲染。 */
function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

/** 二.1 渲染分层后显示拆为「主体文本 + 百分秒 span」两个节点，按容器聚合断言。 */
function displayText(): string {
  return document.querySelector(".sw-display")?.textContent ?? "";
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-26T10:00:00"));
});

afterEach(() => {
  __resetMirrorSyncStateForTests();
  vi.useRealTimers();
});

describe("fmtStopwatch", () => {
  it("分钟:秒.百分秒", () => {
    expect(fmtStopwatch(0)).toBe("00:00.00");
    expect(fmtStopwatch(6543)).toBe("00:06.54");
    expect(fmtStopwatch(75_400)).toBe("01:15.40");
  });
  it("小时进位与隐藏百分秒", () => {
    expect(fmtStopwatch(3_661_234)).toBe("1:01:01.23");
    expect(fmtStopwatch(6543, false)).toBe("00:06");
  });
});

describe("lapRows", () => {
  it("从新到旧，差值与累计正确", () => {
    const rows = lapRows([1000, 4000, 9000]);
    expect(rows.map((r) => r.index)).toEqual([3, 2, 1]);
    expect(rows[0]).toEqual({ index: 3, delta: 5000, cumulative: 9000 });
    expect(rows[2]).toEqual({ index: 1, delta: 1000, cumulative: 1000 });
  });
});

describe("StopwatchWidget", () => {
  it("开始后数字走动，暂停后停住", () => {
    render(<StopwatchWidget instanceId={ID} />);
    expect(displayText()).toBe("00:00.00");
    fireEvent.click(screen.getByRole("button", { name: /开始/ }));
    advance(3200);
    expect(displayText()).toBe("00:03.20");
    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    const frozen = displayText();
    advance(5000);
    expect(displayText()).toBe(frozen);
    fireEvent.click(screen.getByRole("button", { name: /继续/ }));
    advance(1000);
    /* 百分秒为 rAF 帧直写（不进 React），与 fake 定时器推进边界最多差一帧——
       断言到秒位精度；精确毫秒语义已由计次持久化用例（Date 数学）覆盖。 */
    expect(displayText()).toMatch(/^00:04\.\d{2}$/);
  });

  it("计次：从新到旧展示并持久化，重置清空", () => {
    render(<StopwatchWidget instanceId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: /开始/ }));
    advance(1000);
    fireEvent.click(screen.getByRole("button", { name: /计次/ }));
    advance(2000);
    fireEvent.click(screen.getByRole("button", { name: /计次/ }));
    expect(screen.getAllByText(/第 \d+ 次/)).toHaveLength(2);
    // 顺序：第 2 次在前。
    expect(screen.getByText("第 2 次").closest(".sw-lap")).toHaveTextContent("+00:02.00");
    const saved = JSON.parse(localStorage.getItem(KEY)!);
    expect(saved.laps).toEqual([1000, 3000]);
    fireEvent.click(screen.getByRole("button", { name: /重置/ }));
    // 清空现在带退场动画（useDelayedUnmount 延迟卸载），推进过窗口再断言空态。
    advance(400);
    expect(screen.getByText("无计次记录")).toBeInTheDocument();
    expect(displayText()).toBe("00:00.00");
  });

  it("运行状态跨重启恢复（绝对时间戳换算）", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ running: true, startAt: Date.now() - 2500, accumulated: 5000, laps: [7000] })
    );
    render(<StopwatchWidget instanceId={ID} />);
    expect(displayText()).toBe("00:07.50");
    expect(screen.getByText("第 1 次")).toBeInTheDocument();
  });

  it("隐藏百分秒开关生效", () => {
    localStorage.setItem(`focus-desk.widget-config.${ID}.v1`, JSON.stringify({ showCentis: false }));
    render(<StopwatchWidget instanceId={ID} />);
    expect(displayText()).toBe("00:00");
  });
});
