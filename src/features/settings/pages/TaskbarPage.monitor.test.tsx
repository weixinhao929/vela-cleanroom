/**
 * [TB-MONITOR] 设置页「任务栏」HEADER 显示器选择器组件测试：
 * - 浏览器模式：只有「所有显示器统一」，不发 list_monitors；
 * - Tauri 模式：list_monitors 动态分组（名称 · #槽位 · 主显示器标记），monitors-changed 刷新；
 * - 选中某屏后编辑桌面外观：只写 monitorOverrides[slot]（整套 states）+ perMonitor=true，
 *   统一配置不动；徽标「已覆盖 · 动态外观」；切回统一编辑写统一；
 * - 覆盖视图：选中屏显示覆盖值，未覆盖字段沿用统一；
 * - 「恢复为统一配置」删除该槽位覆盖并 toast；总开关在覆盖模式下仍写统一配置；
 * - perMonitor 关闭时给出「保留但不生效」提示；
 * - 有覆盖但未连接的屏列为「显示器 #N（未连接）」；选中屏拔掉且无覆盖 → 自动回统一；
 * - 「恢复默认」清空覆盖表并回统一。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const eventHandlers = new Map<string, (payload: unknown) => void>();
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
const toastMock = vi.fn();
let tauriOn = false;

vi.mock("../../../lib/use-tauri-event", () => ({
  useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
    eventHandlers.set(event, handler);
  }
}));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return { ...mod, isTauri: () => tauriOn, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

vi.mock("../../../components/ToastHost", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../components/ToastHost")>();
  return { ...mod, showToast: (text: string, kind?: string) => toastMock(text, kind) };
});

import { TaskbarPage } from "./TaskbarPage";
import {
  defaultTaskbarSettings,
  defaultTaskbarStates,
  useSettingsStore,
  withTaskbarOverride
} from "../../../store/settings-store";

const MONITORS = [
  { id: 0, name: "\\\\.\\DISPLAY1", x: 0, y: 0, width: 2560, height: 1440, is_primary: true },
  { id: 1, name: "\\\\.\\DISPLAY2", x: 2560, y: 0, width: 1920, height: 1080, is_primary: false }
];

const taskbar = () => useSettingsStore.getState().general.taskbar;
const emit = (event: string, payload: unknown) => act(() => eventHandlers.get(event)?.(payload));
const selector = () => within(screen.getByRole("group", { name: "正在编辑" })).getByRole("button");
const desktopCard = () => screen.getByRole("group", { name: "桌面" });

/** 打开显示器选择器并选中某项。 */
async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(selector());
  await user.click(screen.getByRole("option", { name: label }));
}

/** 改桌面卡的「效果」为亚克力（写 states 整套）。 */
async function setDesktopAcrylic(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(within(desktopCard()).getByRole("group", { name: "效果" })).getByRole("radio", { name: "亚克力" })
  );
}

beforeEach(() => {
  localStorage.clear();
  eventHandlers.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "list_monitors" ? MONITORS : null));
  toastMock.mockReset();
  tauriOn = true;
  window.location.hash = "";
  useSettingsStore.setState((s) => ({ general: { ...s.general, taskbar: defaultTaskbarSettings() } }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskbarPage · HEADER 显示器选择器（F-6）", () => {
  it("浏览器模式：只有「所有显示器统一」，不发 list_monitors", async () => {
    tauriOn = false;
    const user = userEvent.setup();
    render(<TaskbarPage />);
    expect(selector()).toHaveTextContent("所有显示器统一");
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "list_monitors")).toBe(false);
    await user.click(selector());
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByTestId("tb-override-status")).toBeNull();
  });

  it("Tauri 模式：list_monitors 动态分组（名称 · #槽位 · 主显示器），monitors-changed 刷新列表", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "list_monitors")).toHaveLength(1));
    await user.click(selector());
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["所有显示器统一", "\\\\.\\DISPLAY1 · #0（主显示器）", "\\\\.\\DISPLAY2 · #1"]);
    await user.keyboard("{Escape}");
    // 热插拔：monitors-changed → 重新拉取 → 只剩主屏。
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "list_monitors" ? [MONITORS[0]] : null));
    emit("monitors-changed", 1);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "list_monitors")).toHaveLength(2));
    await user.click(selector());
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
  });

  it("选中某屏编辑桌面外观：只写 monitorOverrides[slot] + perMonitor=true，统一配置不动；徽标「已覆盖 · 动态外观」；切回统一后编辑写统一", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    await waitFor(() => expect(invokeMock.mock.calls.some(([cmd]) => cmd === "list_monitors")).toBe(true));
    await pick(user, "\\\\.\\DISPLAY2 · #1");
    expect(selector()).toHaveTextContent("\\\\.\\DISPLAY2 · #1");
    const status = () => screen.getByTestId("tb-override-status");
    expect(status()).toHaveTextContent("尚未覆盖");
    expect(taskbar().perMonitor).toBe(false);

    await setDesktopAcrylic(user);
    const tb = taskbar();
    expect(tb.perMonitor).toBe(true);
    expect(Object.keys(tb.monitorOverrides)).toEqual(["1"]);
    expect(tb.monitorOverrides["1"].states?.desktop.accent).toBe("acrylic");
    // 覆盖 = 整套 states（未改的六态照抄当时的统一值），不含 rules / ignoredWindows。
    expect(tb.monitorOverrides["1"].states?.visibleWindow).toEqual(defaultTaskbarStates().visibleWindow);
    expect(tb.monitorOverrides["1"].rules).toBeUndefined();
    expect(tb.monitorOverrides["1"].ignoredWindows).toBeUndefined();
    // 统一配置不动。
    expect(tb.states.desktop.accent).toBe("clear");
    expect(status()).toHaveTextContent("已覆盖");
    expect(status()).toHaveTextContent("动态外观");
    expect(within(status()).getByRole("button", { name: "恢复为统一配置" })).toBeInTheDocument();
    // 编辑器展示覆盖视图：亚克力已选中。
    expect(
      within(within(desktopCard()).getByRole("group", { name: "效果" })).getByRole("radio", { name: "亚克力" })
    ).toHaveAttribute("aria-checked", "true");

    // 切回统一：编辑器显示统一值（透明），再改写的是统一配置，覆盖不动。
    await pick(user, "所有显示器统一");
    expect(screen.queryByTestId("tb-override-status")).toBeNull();
    expect(
      within(within(desktopCard()).getByRole("group", { name: "效果" })).getByRole("radio", { name: "透明" })
    ).toHaveAttribute("aria-checked", "true");
    await user.click(
      within(within(desktopCard()).getByRole("group", { name: "效果" })).getByRole("radio", { name: "模糊" })
    );
    expect(taskbar().states.desktop.accent).toBe("blur");
    expect(taskbar().monitorOverrides["1"].states?.desktop.accent).toBe("acrylic");
  });

  it("覆盖视图：覆盖字段整体替换、未覆盖字段沿用统一；忽略列表在覆盖模式下只写该屏", async () => {
    const user = userEvent.setup();
    const t = defaultTaskbarSettings();
    t.states.desktop.color = "#0000ffff";
    t.ignoredWindows.processes = ["Base.exe"];
    const ov = withTaskbarOverride(t, "0", { rules: { visibleWindow: [], maximizedWindow: [] } });
    useSettingsStore.setState((s) => ({ general: { ...s.general, taskbar: ov } }));
    render(<TaskbarPage />);
    await waitFor(() => expect(invokeMock.mock.calls.some(([cmd]) => cmd === "list_monitors")).toBe(true));
    await pick(user, "\\\\.\\DISPLAY1 · #0（主显示器）");
    // 未覆盖的 ignoredWindows 沿用统一 → 页面显示 Base.exe。
    expect(screen.getByText("Base.exe")).toBeInTheDocument();
    // 删除该芯片 → 写入覆盖的 ignoredWindows，统一不动。
    await user.click(screen.getByRole("button", { name: "删除Base.exe" }));
    expect(taskbar().ignoredWindows.processes).toEqual(["Base.exe"]);
    expect(taskbar().monitorOverrides["0"].ignoredWindows?.processes).toEqual([]);
    expect(taskbar().monitorOverrides["0"].rules).toEqual({ visibleWindow: [], maximizedWindow: [] });
    const status = screen.getByTestId("tb-override-status");
    expect(status).toHaveTextContent("窗口规则");
    expect(status).toHaveTextContent("忽略的窗口");
  });

  it("「恢复为统一配置」删除该槽位覆盖并 toast；总开关与「逐显示器独立配置」在覆盖模式下仍写统一配置", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    await waitFor(() => expect(invokeMock.mock.calls.some(([cmd]) => cmd === "list_monitors")).toBe(true));
    await pick(user, "\\\\.\\DISPLAY2 · #1");
    await setDesktopAcrylic(user);
    expect(taskbar().monitorOverrides["1"]).toBeDefined();

    await user.click(screen.getByRole("switch", { name: "自定义任务栏外观" }));
    expect(taskbar().enabled).toBe(true);
    expect(taskbar().monitorOverrides["1"].enabled).toBeUndefined();

    await user.click(within(screen.getByTestId("tb-override-status")).getByRole("button", { name: "恢复为统一配置" }));
    expect(taskbar().monitorOverrides).toEqual({});
    expect(toastMock).toHaveBeenCalledWith("已删除此显示器的覆盖，恢复为统一配置", "ok");
    // 仍停留在该屏（在线），显示「尚未覆盖」。
    expect(screen.getByTestId("tb-override-status")).toHaveTextContent("尚未覆盖");

    // perMonitor 关闭 → 提示保留但不生效。
    await user.click(screen.getByRole("switch", { name: "逐显示器独立配置" }));
    expect(taskbar().perMonitor).toBe(false);
    expect(screen.getByTestId("tb-override-status")).toHaveTextContent("逐显示器独立配置已关闭");
  });

  it("有覆盖但未连接的屏列为「显示器 #N（未连接）」；选中屏拔掉且无覆盖 → 自动回统一；「恢复默认」清空覆盖表", async () => {
    const user = userEvent.setup();
    const t = withTaskbarOverride(defaultTaskbarSettings(), "7", { enabled: false });
    useSettingsStore.setState((s) => ({ general: { ...s.general, taskbar: t } }));
    render(<TaskbarPage />);
    await waitFor(() => expect(invokeMock.mock.calls.some(([cmd]) => cmd === "list_monitors")).toBe(true));
    await user.click(selector());
    expect(screen.getByRole("option", { name: "显示器 #7（未连接）" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "\\\\.\\DISPLAY2 · #1" }));
    expect(selector()).toHaveTextContent("\\\\.\\DISPLAY2 · #1");

    // 拔掉 #1（无覆盖）→ 回统一。
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "list_monitors" ? [MONITORS[0]] : null));
    emit("monitors-changed", 1);
    await waitFor(() => expect(selector()).toHaveTextContent("所有显示器统一"));

    // 未连接但有覆盖的 #7 仍可选中查看（本屏开关徽标）。
    await pick(user, "显示器 #7（未连接）");
    expect(screen.getByTestId("tb-override-status")).toHaveTextContent("本屏开关");

    // 恢复默认：整切片重置（覆盖表清空）+ 回统一。
    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(taskbar()).toEqual(defaultTaskbarSettings());
    expect(selector()).toHaveTextContent("所有显示器统一");
  });

  it("D4（审计修复）：monitors 瞬时空（枚举失败/热插拔刷新窗口）不把「选中且无覆盖」的屏误弹回统一", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    await waitFor(() => expect(invokeMock.mock.calls.some(([cmd]) => cmd === "list_monitors")).toBe(true));
    await pick(user, "\\\\.\\DISPLAY2 · #1");

    // 统一配置的桌面外观基线（断言编辑没有误写进统一切片用）。
    const unifiedDesktopBefore = { ...taskbar().states.desktop };

    // 枚举瞬时空：monitors-changed → list_monitors 返回 []。守卫生效时 editSlot
    // 不回退；随后的编辑仍写 #1 的覆盖（若被误弹回统一，这里会写进统一配置）。
    // 注：空列表下下拉显示退化为裸槽位号属瞬态外观，断言只看写入目标。
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "list_monitors" ? [] : null));
    emit("monitors-changed", 1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await setDesktopAcrylic(user);
    expect(taskbar().monitorOverrides["1"]).toBeDefined();
    expect(taskbar().states.desktop).toEqual(unifiedDesktopBefore);
  });
});
