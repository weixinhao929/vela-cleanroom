/**
 * 通知中心磁贴配置字段（灵动岛 → 通知中心）组件测试：
 *  - 只列「现在添加好的」会发通知的小组件（画布实例 + 岛磁贴 + 杂项面板条目，
 *    按类型去重），未添加的来源不出现在页面里；
 *  - 逐行开关写入全局 settings.notifications（sources 逐源 / todo / pomodoro）；
 *  - 待办清单与截止日期共用 todoEnabled，合成一行、按实际添加动态取名；
 *  - 免打扰开关走 lib/dnd（localStorage 权威）；
 *  - 一个可通知的小组件都没有时显示占位说明而非留白。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NotificationCenterConfig } from "./notification-center";
import {
  DEFAULT_NOTIFICATION_SOURCES,
  useSettingsStore,
  type NotificationSettings
} from "../../../store/settings-store";
import { parseDockConfig, useWidgetStore, type WidgetInstance } from "../../../widget/widget-store";
import { MISC_TYPE } from "../../../widget/widgets/misc/MiscBoardPanel";
import { dndEnabled, setDnd } from "../../../lib/dnd";

const freshNotifications = (): NotificationSettings => ({
  pomodoroEnabled: true,
  pomodoroSound: true,
  pomodoroToast: true,
  pomodoroModeSwitch: true,
  pomodoroFocusEndSound: "soft",
  pomodoroFocusEndVolume: 80,
  pomodoroBreakEndSound: "bell",
  pomodoroBreakEndVolume: 100,
  pomodoroTickSound: "none",
  pomodoroTickVolume: 50,
  todoEnabled: true,
  todoSound: true,
  todoToast: true,
  todoOverdue: true,
  sources: { ...DEFAULT_NOTIFICATION_SOURCES },
  systemListener: true,
  pushEnabled: false,
  pushPort: 47310
});

function instance(id: string, type: string): WidgetInstance {
  return { id, type, x: 0, y: 0, w: 2, h: 2, z: 0 };
}

/** 重置两 store：画布实例 + 岛磁贴（含杂项面板 items）按入参装配。 */
function seed(instances: WidgetInstance[], tiles: { id: string; type: string; config?: Record<string, unknown> }[]) {
  const dock = parseDockConfig(null);
  useWidgetStore.setState({
    instances,
    dock: { ...dock, tiles: tiles.map((t) => ({ ...t })) },
    dockDrag: null
  });
  useSettingsStore.setState({ notifications: freshNotifications() });
  setDnd(false);
}

describe("NotificationCenterConfig · 已添加小组件逐个开关通知", () => {
  beforeEach(() => {
    localStorage.clear();
    seed([], [{ id: "t-notif", type: "notifications" }]);
  });

  it("只列已添加的通知源：画布习惯实例 + 岛上课程表磁贴出现，未添加的不出现", () => {
    seed(
      [instance("inst-habit", "habit")],
      [
        { id: "t-notif", type: "notifications" },
        { id: "t-timetable", type: "timetable" }
      ]
    );
    render(<NotificationCenterConfig />);
    expect(screen.getByRole("switch", { name: "习惯打卡提醒" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "课程表上课提醒" })).toBeInTheDocument();
    // 未添加的小组件不渲染其来源行。
    expect(screen.queryByRole("switch", { name: "倒计时结束" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "新邮件" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "番茄钟提醒" })).toBeNull();
  });

  it("杂项面板条目也算「已添加」：面板里有倒计时组件 → 出现倒计时来源行", () => {
    seed(
      [],
      [
        { id: "t-notif", type: "notifications" },
        { id: "t-misc", type: MISC_TYPE, config: { items: [{ id: "m1", type: "countdown", x: 0, y: 0, w: 1, h: 1 }] } }
      ]
    );
    render(<NotificationCenterConfig />);
    expect(screen.getByRole("switch", { name: "倒计时结束" })).toBeInTheDocument();
  });

  it("来源开关写入全局 sources（同一份数据与待办配置页互通）", async () => {
    const user = userEvent.setup();
    seed([instance("inst-habit", "habit")], [{ id: "t-notif", type: "notifications" }]);
    render(<NotificationCenterConfig />);
    await user.click(screen.getByRole("switch", { name: "习惯打卡提醒" }));
    expect(useSettingsStore.getState().notifications.sources.habit).toBe(false);
    await user.click(screen.getByRole("switch", { name: "习惯打卡提醒" }));
    expect(useSettingsStore.getState().notifications.sources.habit).toBe(true);
  });

  it("待办与截止共用一行 todoEnabled：两者都添加时标题合并，切换只动 todoEnabled", async () => {
    const user = userEvent.setup();
    seed(
      [instance("inst-todo", "todo"), instance("inst-ddl", "deadlines")],
      [{ id: "t-notif", type: "notifications" }]
    );
    render(<NotificationCenterConfig />);
    const sw = screen.getByRole("switch", { name: "待办清单 / 截止日期提醒" });
    await user.click(sw);
    expect(useSettingsStore.getState().notifications.todoEnabled).toBe(false);
    // 共用开关：sources 不受影响。
    expect(useSettingsStore.getState().notifications.sources.app).toBe(true);
  });

  it("只添加截止日期时行名为「截止日期提醒」，仍指向 todoEnabled", async () => {
    const user = userEvent.setup();
    seed([instance("inst-ddl", "deadlines")], [{ id: "t-notif", type: "notifications" }]);
    render(<NotificationCenterConfig />);
    await user.click(screen.getByRole("switch", { name: "截止日期提醒" }));
    expect(useSettingsStore.getState().notifications.todoEnabled).toBe(false);
  });

  it("默认岛磁贴（pomodoro）出现番茄钟行；开关写 pomodoroEnabled", async () => {
    const user = userEvent.setup();
    seed(
      [],
      parseDockConfig(null).tiles.map((t) => ({ ...t }))
    );
    render(<NotificationCenterConfig />);
    await user.click(screen.getByRole("switch", { name: "番茄钟提醒" }));
    expect(useSettingsStore.getState().notifications.pomodoroEnabled).toBe(false);
  });

  it("免打扰开关写 lib/dnd，开启与关闭即时生效", async () => {
    const user = userEvent.setup();
    render(<NotificationCenterConfig />);
    expect(dndEnabled()).toBe(false);
    await user.click(screen.getByRole("switch", { name: "免打扰" }));
    expect(dndEnabled()).toBe(true);
    await user.click(screen.getByRole("switch", { name: "免打扰" }));
    expect(dndEnabled()).toBe(false);
  });

  it("没有可通知的小组件时显示占位说明而非留白", () => {
    seed(
      [],
      [
        { id: "t-notif", type: "notifications" },
        { id: "t-clock", type: "clock" }
      ]
    );
    render(<NotificationCenterConfig />);
    expect(screen.getByText("还没有会发通知的小组件")).toBeInTheDocument();
    // 时钟不发通知：不产生任何来源行。
    expect(screen.queryByRole("switch", { name: "番茄钟提醒" })).toBeNull();
  });
});
