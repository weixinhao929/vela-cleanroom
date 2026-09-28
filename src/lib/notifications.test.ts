import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationRecord } from "../types/bindings/NotificationRecord";

/**
 * 通知派发门控链（DOCK 改造）：门控通过即留档（DOM 事件可观测），免打扰
 * 压制 toast/提示音但不压制留档，双重关闭（toast+sound 全关）不留档。
 * 浏览器模式下 recordHistory 走本地构造记录 + 本窗口广播。
 */

const settingsState: {
  notifications: Record<string, unknown>;
  extra: Record<string, unknown>;
} = {
  notifications: {},
  extra: {}
};

vi.mock("../store/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      notifications: {
        pomodoroEnabled: true,
        pomodoroModeSwitch: true,
        pomodoroToast: true,
        pomodoroSound: true,
        todoEnabled: true,
        todoOverdue: true,
        todoToast: true,
        todoSound: true,
        ...settingsState.notifications
      },
      extra: { focusMode: "off", ...settingsState.extra }
    })
  }
}));

vi.mock("../components/ToastHost", () => ({ pushAppToast: vi.fn() }));

import { pomodoroNotification, sourceNotify, todoNotification, NOTIFICATION_RECORDED_EVENT } from "./notifications";
import { setDnd } from "./dnd";

describe("notifications 入史与免打扰门控", () => {
  const recorded: NotificationRecord[] = [];
  const onRecorded = (e: Event) => recorded.push((e as CustomEvent<NotificationRecord>).detail);

  beforeEach(() => {
    recorded.length = 0;
    settingsState.notifications = {};
    settingsState.extra = { focusMode: "off" };
    setDnd(false);
    window.addEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded);
    return () => window.removeEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded);
  });

  it("sourceNotify：门控通过即留档；来源关闭则完全无痕", () => {
    sourceNotify("habit", "打卡提醒", "今天还没打卡");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].source).toBe("habit");
    expect(recorded[0].kind).toBe("info");

    settingsState.notifications = { sources: { habit: false } };
    sourceNotify("habit", "打卡提醒", "今天还没打卡");
    expect(recorded).toHaveLength(1);
  });

  it("免打扰：留档照常，toast/提示音被压制（响铃通道静默）", () => {
    setDnd(true);
    pomodoroNotification({ kind: "complete", title: "专注完成", body: "休息一下" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].kind).toBe("pomodoro");
    // dnd 下 playChime 静默不抛错（WebAudio 在 jsdom 缺失走 try 包裹）。
  });

  it("toast+sound 全关：无任何通道发射 → 不留档", () => {
    settingsState.notifications = { pomodoroToast: false, pomodoroSound: false };
    pomodoroNotification({ kind: "complete", title: "专注完成", body: "休息" });
    expect(recorded).toHaveLength(0);

    settingsState.notifications = { todoToast: false, todoSound: false };
    todoNotification({ title: "任务逾期", body: "交周报" });
    expect(recorded).toHaveLength(0);
  });

  it("仅响铃开启：仍留档（用户没看到弹窗更需要历史可回看）", () => {
    settingsState.notifications = { pomodoroToast: false, pomodoroSound: true };
    pomodoroNotification({ kind: "mode-switch", title: "进入休息", body: "" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].source).toBe("pomodoro");
  });

  it("专注沉浸静音：sourceNotify / todoNotification 不留档（既有语义不变）", () => {
    settingsState.extra = { focusMode: "deep" };
    sourceNotify("habit", "打卡提醒", "");
    todoNotification({ title: "任务逾期", body: "" });
    expect(recorded).toHaveLength(0);
  });
});
