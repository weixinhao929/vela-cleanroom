import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * + （inflight 不校验 vmHour）的闭环测试：
 * 此前共享聚合钩子只按 vmHour 命中缓存，dbVersion/lastSessionId 刷新键
 * 形同虚设——SQL 统计冻结在首查快照（正是无测试才漏网的回归）。
 * 三条共享查询钩子（hourly/task/monthInt）同型
 * 回归——makeCachedQuery 缓存键漏刷新维度，effect 重跑也只命中旧缓存。
 */
const aggregateMock = vi.fn();
const hourlyMock = vi.fn();
const taskMock = vi.fn();
const monthIntMock = vi.fn();

vi.mock("./tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tauri")>()),
  isTauri: () => true
}));
vi.mock("./persistence/sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./persistence/sqlite")>()),
  sqliteRepo: {
    aggregateSessions: (...a: unknown[]) => aggregateMock(...a),
    hourlyFocusDistribution: (...a: unknown[]) => hourlyMock(...a),
    taskFocusBreakdown: (...a: unknown[]) => taskMock(...a),
    monthlyInterruptionBreakdown: (...a: unknown[]) => monthIntMock(...a)
  }
}));

import { useFocusAggregate, useFocusHourly, useTaskBreakdown, useMonthInterruptions } from "./focus-aggregate";
import { bumpDbVersion } from "./db-signal";
import { useAppStore } from "../store/app-store";

const aggOf = (dates: string[]) => ({ daily: dates.map((date) => ({ date, focusSeconds: 60, focusCount: 1 })) });

describe("useFocusAggregate（共享聚合钩子）", () => {
  beforeEach(() => {
    aggregateMock.mockReset();
    localStorage.clear();
    useAppStore.setState({ sessions: [] });
    // 模块级缓存/dbVersion 计数跨用例存留：抬一次版本让本用例的刷新键与
    // 上一用例遗留的缓存键错开（否则首渲染直接命中旧缓存，不发行 IPC）。
    act(() => bumpDbVersion());
  });

  it("F-1：写入落地（dbVersion bump）后重查，缓存不再冻结首查快照", async () => {
    let version = 0;
    aggregateMock.mockImplementation(async () => {
      version += 1;
      return aggOf([`2026-10-0${version}`]);
    });
    const first = renderHook(() => useFocusAggregate(0));
    await waitFor(() => expect(first.result.current).toEqual(aggOf(["2026-10-01"])));
    expect(aggregateMock).toHaveBeenCalledTimes(1);

    // 同刷新键的重复挂载/重渲：命中缓存，不再发 IPC。
    first.rerender();
    expect(aggregateMock).toHaveBeenCalledTimes(1);

    // 写落地信号：必须绕过缓存重查（回归点——此前命中 vmHour 相同的缓存
    // 直接返回旧引用，统计面板永远停在首查值）。
    act(() => bumpDbVersion());
    await waitFor(() => expect(first.result.current).toEqual(aggOf(["2026-10-02"])));
    expect(aggregateMock).toHaveBeenCalledTimes(2);
    first.unmount();
  });

  it("F-1：跨窗新记录（内存尾条 id 变化）同样触发重查", async () => {
    aggregateMock.mockResolvedValue(aggOf(["2026-10-01"]));
    const r = renderHook(() => useFocusAggregate(0));
    await waitFor(() => expect(r.result.current).toEqual(aggOf(["2026-10-01"])));

    aggregateMock.mockResolvedValue(aggOf(["2026-10-03"]));
    act(() => {
      useAppStore.setState({
        sessions: [
          {
            id: "test-agg-1",
            type: "focus",
            mode: "focus",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            plannedSeconds: 60,
            completed: true
          }
        ]
      });
    });
    await waitFor(() => expect(r.result.current).toEqual(aggOf(["2026-10-03"])));
    expect(aggregateMock).toHaveBeenCalledTimes(2);
    r.unmount();
  });

  it("B-4：快速切换统计日界不得把旧日界的在途结果派发给新日界", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });
    // vmHour=0 的查询挂起；期间切换到 vmHour=4（立即完成）。
    aggregateMock.mockImplementationOnce(() => firstPromise as Promise<never>);
    aggregateMock.mockImplementationOnce(async () => aggOf(["2026-10-04"]));

    const r = renderHook(({ vmHour }) => useFocusAggregate(vmHour), { initialProps: { vmHour: 0 } });
    // 推进到 vmHour=4：不得并入 vmHour=0 的在途请求。
    act(() => resolveFirst(aggOf(["2026-10-00"])));
    r.rerender({ vmHour: 4 });
    await waitFor(() => expect(r.result.current).toEqual(aggOf(["2026-10-04"])));
    expect(aggregateMock).toHaveBeenCalledTimes(2);
    r.unmount();
  });
});

describe("ZF-1：B-8 三条共享查询钩子的刷新闭环", () => {
  beforeEach(() => {
    hourlyMock.mockReset();
    taskMock.mockReset();
    monthIntMock.mockReset();
    localStorage.clear();
    useAppStore.setState({ sessions: [], interruptions: [] });
    act(() => bumpDbVersion());
  });

  it("useFocusHourly：dbVersion bump 后重查，不冻结首查快照", async () => {
    // 钩子内部把 Rust 绑定的 snake_case 行映射为 camelCase，mock 喂原生前形态。
    hourlyMock.mockResolvedValueOnce([{ hour: 10, focus_seconds: 60, focus_count: 1 }]);
    const r = renderHook(() => useFocusHourly());
    await waitFor(() => expect(r.result.current).toEqual([{ hour: 10, focusSeconds: 60, focusCount: 1 }]));
    expect(hourlyMock).toHaveBeenCalledTimes(1);

    hourlyMock.mockResolvedValueOnce([{ hour: 11, focus_seconds: 120, focus_count: 2 }]);
    act(() => bumpDbVersion());
    // 回归点：此前键只含参数（恒 null），刷新键变化后仍命中模块级缓存。
    await waitFor(() => expect(r.result.current).toEqual([{ hour: 11, focusSeconds: 120, focusCount: 2 }]));
    expect(hourlyMock).toHaveBeenCalledTimes(2);
    r.unmount();
  });

  it("useTaskBreakdown：dbVersion bump 后重查", async () => {
    taskMock.mockResolvedValueOnce([{ taskId: "t1", eventLabel: null, focusSeconds: 60, sessions: 1 }]);
    const r = renderHook(() => useTaskBreakdown());
    await waitFor(() =>
      expect(r.result.current).toEqual([{ taskId: "t1", eventLabel: null, focusSeconds: 60, sessions: 1 }])
    );

    taskMock.mockResolvedValueOnce([{ taskId: "t2", eventLabel: null, focusSeconds: 90, sessions: 2 }]);
    act(() => bumpDbVersion());
    await waitFor(() =>
      expect(r.result.current).toEqual([{ taskId: "t2", eventLabel: null, focusSeconds: 90, sessions: 2 }])
    );
    expect(taskMock).toHaveBeenCalledTimes(2);
    r.unmount();
  });

  it("useMonthInterruptions：打断尾条变化后重查（刷新键含三元组）", async () => {
    monthIntMock.mockResolvedValueOnce([{ reason: "电话", count: 1 }]);
    const r = renderHook(() => useMonthInterruptions(0, 2026, 9));
    await waitFor(() => expect(r.result.current).toEqual([{ reason: "电话", count: 1 }]));
    expect(monthIntMock).toHaveBeenCalledTimes(1);

    monthIntMock.mockResolvedValueOnce([{ reason: "消息", count: 3 }]);
    act(() => {
      useAppStore.setState({
        interruptions: [
          {
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            reason: "消息",
            mode: "focus",
            elapsedSeconds: 30
          }
        ]
      });
    });
    await waitFor(() => expect(r.result.current).toEqual([{ reason: "消息", count: 3 }]));
    expect(monthIntMock).toHaveBeenCalledTimes(2);
    r.unmount();
  });
});
