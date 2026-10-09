/**
 * ISLAND-CORE 接管层单测（useDockTakeover，纯 DOM 路径——Tauri 事件与
 * media:snapshot 走跨窗口 / 后端，另由 e2e 与 Shell 测试覆盖）：
 *  - 仲裁：优先级抢占（pomodoro > volume > notification）、同级最新者胜、
 *    enabledKinds 关闭的 kind 丢弃（验证面）；
 *  - 到期回落：durationMs 生效（可调 3–15s，重构后到期唯一真源
 *    是 untilRef——state 已剥离 until）；
 *  - 同内容续提案自重排（二.2）：音量连按只顺延 untilRef，旧定时器到期时
 *    复核最新时刻再排——接管条不过期（此前 的回归锁）；
 *  - 通知去重（LRU 集合）：同 id 重复丢弃；双路交错（B 先到、A 迟到）
 *    时较旧的 A 不再顶掉较新的 B。
 *
 * jsdom 无 PointerEvent 依赖；isTauri() mock 为 false 使 hook 只装 DOM 监听。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {})
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => false, invoke: vi.fn(async () => null) };
});

import { useDockTakeover } from "./DockTakeover";
import { NOTIFICATION_RECORDED_EVENT } from "../../lib/notifications";
import { OSD_EVENT, type OsdPayload } from "../../lib/osd-events";
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";
import { useWidgetStore } from "../widget-store";

const tr = (s: string) => s;
const allKinds = {
  pomodoro: true,
  media: true,
  notification: true,
  brightness: true,
  volume: true,
  link: true
};

/** DOM 路径发一条通知留档。 */
const fireRecord = (r: Partial<NotificationRecord> & { id: string; title: string }) => {
  window.dispatchEvent(
    new CustomEvent<NotificationRecord>(NOTIFICATION_RECORDED_EVENT, {
      detail: { kind: "app", body: "", recordedAt: new Date().toISOString(), ...r } as NotificationRecord
    })
  );
};
/** 应用内 OSD（音量 / 亮度）路径。 */
const fireOsd = (d: OsdPayload) => {
  window.dispatchEvent(new CustomEvent<OsdPayload>(OSD_EVENT, { detail: d }));
};

describe("useDockTakeover（DOM 路径）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    useWidgetStore.setState({
      dock: { ...useWidgetStore.getState().dock, takeover: { ...allKinds, durationMs: 3000 } }
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("通知到达 → 接管出现；durationMs（3s）后回落", async () => {
    const { result } = renderHook(() => useDockTakeover(true, tr, allKinds));
    act(() => fireRecord({ id: "n1", title: "提醒", body: "正文" }));
    expect(result.current.takeover?.kind).toBe("notification");
    expect(result.current.takeover?.title).toBe("提醒");
    // state 已剥离 until：展示面形状不含到期字段。
    expect(result.current.takeover && "until" in result.current.takeover).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(result.current.takeover).toBeNull();
  });

  it("OSD 音量 → volume 接管；番茄钟通知抢占；回落后 volume 重新可提案", async () => {
    const { result } = renderHook(() => useDockTakeover(true, tr, allKinds));
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "40%" }));
    expect(result.current.takeover?.kind).toBe("volume");
    // 低优先级通知不抢占。
    act(() => fireRecord({ id: "n1", title: "低" }));
    expect(result.current.takeover?.kind).toBe("volume");
    // 番茄钟响铃抢占（优先级 3 > 2）。
    act(() => fireRecord({ id: "p1", title: "专注结束", kind: "pomodoro" }));
    expect(result.current.takeover?.kind).toBe("pomodoro");
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(result.current.takeover).toBeNull();
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "41%" }));
    expect(result.current.takeover?.kind).toBe("volume");
  });

  it("enabledKinds 关闭的 kind：空槽直接丢弃（null），在场的低优先级候选不打断在位者", async () => {
    const noVolume = { ...allKinds, volume: false };
    const { result } = renderHook(() => useDockTakeover(true, tr, noVolume));
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "40%" }));
    expect(result.current.takeover).toBeNull();
    // 通知（未关）正常接管；此后 volume 仍被关——不抢占也不替换。
    act(() => fireRecord({ id: "n1", title: "通知" }));
    expect(result.current.takeover?.kind).toBe("notification");
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "40%" }));
    expect(result.current.takeover?.kind).toBe("notification");
  });

  it("同内容续提案自重排：到期前续 3 次，旧定时器不消费——接管条顺延存活（回归锁）", async () => {
    const { result } = renderHook(() => useDockTakeover(true, tr, allKinds));
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "40%" }));
    expect(result.current.takeover?.kind).toBe("volume");
    // 每次 2s 续一次（3s 到期）：第 1.9s / 3.9s / 5.9s 各一条新提案，
    // 期间旧到期定时器到点必须按 untilRef 最新时刻自重排而非收起。
    for (let i = 1; i <= 3; i++) {
      act(() => {
        vi.advanceTimersByTime(1900);
        fireOsd({ kind: "volume", title: tr("音量"), sub: `${40 + i}%` });
      });
      expect(result.current.takeover?.kind).toBe("volume");
    }
    // 最后一次提案后 3.1s 才真正回落。
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(result.current.takeover).toBeNull();
  });

  it("通知去重（LRU 集合）：迟到的旧 id 不再顶掉新接管（P1-5 回归锁）", async () => {
    const { result } = renderHook(() => useDockTakeover(true, tr, allKinds));
    // DOM(B) 先到 → 接管 B；迟到的 DOM(A)（更旧）到达时 id 已见过（先发过一次）
    act(() => fireRecord({ id: "a", title: "旧消息A" }));
    act(() => fireRecord({ id: "b", title: "新消息B" }));
    // 同级最新者胜：B 顶掉 A 属正常仲裁；关键是 a 的重复到达不再重新提案。
    expect(result.current.takeover?.title).toBe("新消息B");
    act(() => fireRecord({ id: "a", title: "旧消息A" }));
    expect(result.current.takeover?.title).toBe("新消息B");
    // 超过 LRU 上限后 a 被挤出集合：作为「新」id 重新可见（按到达序提案）。
    for (let i = 0; i < 64; i++) act(() => fireRecord({ id: `flood-${i}`, title: `灌水${i}` }));
    act(() => fireRecord({ id: "a", title: "旧消息A" }));
    expect(result.current.takeover?.title).toBe("旧消息A");
  });

  it("durationMs 走 store 配置：改 15s 后回落推迟（F-8 可调生效）", async () => {
    useWidgetStore.setState({
      dock: { ...useWidgetStore.getState().dock, takeover: { ...allKinds, durationMs: 15000 } }
    });
    const { result } = renderHook(() => useDockTakeover(true, tr, allKinds));
    act(() => fireRecord({ id: "n1", title: "长驻" }));
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(result.current.takeover?.kind).toBe("notification");
    act(() => {
      vi.advanceTimersByTime(12100);
    });
    expect(result.current.takeover).toBeNull();
  });

  it("enabled=false：候选全部丢弃（监听未装 / 早退）", async () => {
    const { result } = renderHook(() => useDockTakeover(false, tr, allKinds));
    act(() => fireRecord({ id: "n1", title: "不应出现" }));
    expect(result.current.takeover).toBeNull();
  });

  it("dismiss：点击路径手动清空", async () => {
    const { result } = renderHook(() => useDockTakeover(true, tr, allKinds));
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "40%" }));
    expect(result.current.takeover?.kind).toBe("volume");
    act(() => result.current.dismiss());
    expect(result.current.takeover).toBeNull();
  });

  it("takeoverContentEqual 语义：同 kind 同文案续提案不换 state 引用（零重渲）", async () => {
    const { result } = renderHook(() => useDockTakeover(true, tr, allKinds));
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "40%" }));
    const first = result.current.takeover;
    expect(first).toBeTruthy();
    act(() => fireOsd({ kind: "volume", title: tr("音量"), sub: "40%" }));
    expect(result.current.takeover).toBe(first); // 同引用：DockShell 不重渲
  });
});
