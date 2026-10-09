/**
 * [TB-TRAY] 回归：`tray:taskbar-enabled` 的消费者从设置窗移到
 * widget-0（主小组件窗）。此前事件只在设置窗监听（isSettingsWindow 门控），而
 * 设置窗「关闭即销毁」——托盘/快捷键翻转总开关发生在设置窗不在时，localStorage
 * 权威源不更新，重启后还被 reconcile 用陈旧 LS 反向覆盖镜像（用户操作被静默
 * 撤销）。与 tray:anticapture 同款 widget-0 模式。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";

const listeners = new Map<string, (e: { payload: unknown }) => void>();
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
let primary = true;
/** 测试用：指定事件名的 listen 注册直接 reject（其余照常）。 */
let rejectOn: string | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    if (event === rejectOn) return Promise.reject(new Error("ipc down"));
    listeners.set(event, handler);
    return Promise.resolve(() => listeners.delete(event));
  }
}));

vi.mock("./tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./tauri")>();
  return {
    ...mod,
    isTauri: () => true,
    isPrimaryWidgetWindow: () => primary,
    openSettingsWindow: async () => {},
    invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args)
  };
});

vi.mock("./notifications", () => ({ notifyUser: async () => {} }));
vi.mock("./local-backup", () => ({ flushMirrorSync: async () => {} }));
vi.mock("./persist-error", () => ({ reportPersistError: () => async () => {} }));
vi.mock("./persistence/sqlite", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./persistence/sqlite")>();
  return {
    ...mod,
    sqliteRepo: {
      ...mod.sqliteRepo,
      getSetting: async () => null,
      setSetting: async () => {},
      createBackup: async () => {}
    }
  };
});
vi.mock("../components/ToastHost", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../components/ToastHost")>();
  return { ...mod, showToast: () => {} };
});

import { useTrayEvents } from "./tray-events";
import { useSettingsStore } from "../store/settings-store";

function Probe() {
  useTrayEvents();
  return null;
}

const emit = (event: string, payload: unknown) =>
  act(async () => {
    listeners.get(event)?.({ payload });
  });

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  invokeMock.mockReset();
  primary = true;
  rejectOn = null;
});

describe("tray-events · tray:taskbar-enabled 消费者（B1）", () => {
  it("widget-0（primary）消费事件：setTaskbar 落 localStorage 权威源", async () => {
    useSettingsStore.setState((s) => ({
      general: { ...s.general, taskbar: { ...s.general.taskbar, enabled: false } }
    }));
    const { render } = await import("@testing-library/react");
    render(<Probe />);
    // 订阅是异步建立的。
    await act(async () => {
      await Promise.resolve();
    });
    expect(listeners.has("tray:taskbar-enabled")).toBe(true);

    await emit("tray:taskbar-enabled", true);
    expect(useSettingsStore.getState().general.taskbar.enabled).toBe(true);

    await emit("tray:taskbar-enabled", false);
    expect(useSettingsStore.getState().general.taskbar.enabled).toBe(false);

    // 非布尔载荷忽略。
    await emit("tray:taskbar-enabled", "yes");
    expect(useSettingsStore.getState().general.taskbar.enabled).toBe(false);
  });

  it("非 primary 窗口不注册任务栏开关监听（单消费者纪律，D-1/D-2）", async () => {
    primary = false;
    const { render } = await import("@testing-library/react");
    render(<Probe />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(listeners.has("tray:taskbar-enabled")).toBe(false);
    expect(listeners.has("tray:anticapture")).toBe(false);
  });

  /* 旧实现 Promise.all(jobs) 任一 reject 时整组
     unlisten 丢失且 IIFE 无 .catch（unhandledrejection），已注册的托盘/快捷键
     监听泄漏到 reload。修复后逐个注册入列，失败先拆已注册者再上报。 */
  it("T-13：注册链中途 reject 时已注册监听被拆除并上报（不再泄漏）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rejectOn = "shortcut:toggle-pomodoro"; // 第 4 个注册：前 3 个已入列
    try {
      const { render } = await import("@testing-library/react");
      render(<Probe />);
      // 以失败上报为完成信号（listeners 初始为空，「尚未注册」不能当拆除证据）。
      await vi.waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith("[tray-events] listen chain interrupted:", expect.any(Error))
      );
      // 失败点之前已注册的（tray:toggle-pomodoro / tray:backup / tray:new-task）
      // 已被 catch 拆除；失败点之后的从未注册。
      expect(listeners.has("tray:toggle-pomodoro")).toBe(false);
      expect(listeners.has("tray:taskbar-enabled")).toBe(false);
    } finally {
      rejectOn = null;
      errSpy.mockRestore();
    }
  });
});
