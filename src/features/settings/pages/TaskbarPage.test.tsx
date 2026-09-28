/**
 * 设置页「任务栏」（TB-UI）组件测试：
 * - settings-store.setTaskbar：patch 经 sanitize 入 state（3/4/6 位颜色归一到 8 位、坏值回默认），
 *   350ms 防抖后落盘快照含 general.taskbar 且可 normalizeTaskbar 往返；
 * - 外观编辑器：accent 切到 blur 才出现「模糊半径」滑条；取色器 #rrggbb + 透明度滑条合成 #rrggbbaa；
 * - 能力渲染（D7）：无 taskbar:capabilities 不渲染 showPeek，supportsPeek 到达后出现，supportsLine=false 隐藏顶线；
 * - 状态条（F-10）：无事件「模块未就绪」/ 回读 idle「未启用」/ 开启仍 idle「模块未就绪」/ ready「运行中」/ failed 带原因；
 * - 徽标（F-14）：无 state-changed 事件每卡「—」，事件到达后命中卡「当前生效」+ 高亮；
 * - 规则 / 忽略列表增删改排序；「恢复默认」重置整切片；搜索索引命中本页；
 * - TaskbarConfigSync（F-1 模式 B）：与 Rust 等价只 get 不 apply、不同才 apply、防抖内多次改动只一次、
 *   apply Err / 失败项 toast、非设置窗不发 IPC。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** WakeSlider 无原生 input：键盘驱动提交（从当前 aria-valuenow 按方向键到目标）。 */
function keySlider(label: string, value: number) {
  const s = screen.getByRole("slider", { name: label });
  s.focus();
  const cur = Number(s.getAttribute("aria-valuenow") ?? "0");
  const key = value >= cur ? "ArrowRight" : "ArrowLeft";
  for (let i = 0; i < Math.abs(value - cur); i++) fireEvent.keyDown(s, { key });
}

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
  return {
    ...mod,
    isTauri: () => tauriOn,
    invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
    // 包装内部引用的是模块内原始 invoke（mock 替换不到），按同一载荷形状改道到 invokeMock；
    // 包装自身的参数映射由 src/lib/tauri.test.ts 覆盖。
    previewTaskbarState: (state: unknown, overrides?: unknown) =>
      invokeMock("preview_taskbar_state", { state, overrides: overrides ?? null })
  };
});

vi.mock("../../../components/ToastHost", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../components/ToastHost")>();
  return { ...mod, showToast: (text: string, kind?: string) => toastMock(text, kind) };
});

import {
  TASKBAR_APPLY_DEBOUNCE_MS,
  TASKBAR_PREVIEW_HOLD_MS,
  TASKBAR_PREVIEW_SETTLE_GRACE_MS,
  TaskbarConfigSync,
  TaskbarPage
} from "./TaskbarPage";
import { searchSettings } from "../settings-search";
import {
  DEFAULT_TASKBAR,
  defaultTaskbarSettings,
  defaultTaskbarStates,
  normalizeTaskbar,
  useSettingsStore,
  type TaskbarSettings
} from "../../../store/settings-store";

const SETTINGS_KEY = "focus-desk.settings.v1";
const taskbar = () => useSettingsStore.getState().general.taskbar;
const setTaskbar = (patch: Partial<TaskbarSettings>) => act(() => useSettingsStore.getState().setTaskbar(patch));
const emit = (event: string, payload: unknown) => act(() => eventHandlers.get(event)?.(payload));
/** 只看任务栏两条命令：设置落盘镜像（set_setting）与之共用同一个 invoke mock。 */
const taskbarCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd.endsWith("_taskbar_config"));
const desktopCard = () => screen.getByRole("group", { name: "桌面" });

beforeEach(() => {
  localStorage.clear();
  eventHandlers.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => null);
  toastMock.mockReset();
  tauriOn = false;
  window.location.hash = "";
  useSettingsStore.setState((s) => ({ general: { ...s.general, taskbar: defaultTaskbarSettings() } }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settings-store.setTaskbar", () => {
  it("patch 经 sanitize 入 state：3 位颜色归一为 8 位小写；越界半径 / 非法 accent 回默认；防抖落盘后快照可往返", () => {
    vi.useFakeTimers();
    act(() =>
      useSettingsStore.getState().setTaskbar({
        enabled: true,
        states: {
          ...defaultTaskbarStates(),
          desktop: { accent: "blur", color: "#ABC", showPeek: false, showLine: true, blurRadius: 120 }
        }
      })
    );
    expect(taskbar().enabled).toBe(true);
    expect(taskbar().states.desktop).toEqual({
      accent: "blur",
      color: "#aabbccff",
      showPeek: false,
      showLine: true,
      blurRadius: 120
    });
    // 其余六态未动
    expect(taskbar().states.maximizedWindow).toEqual(defaultTaskbarStates().maximizedWindow);

    act(() =>
      useSettingsStore.getState().setTaskbar({
        states: {
          ...taskbar().states,
          desktop: { ...taskbar().states.desktop, blurRadius: 9999, accent: "neon" as never }
        }
      })
    );
    expect(taskbar().states.desktop.blurRadius).toBe(30);
    expect(taskbar().states.desktop.accent).toBe("clear");
    expect(taskbar().states.desktop.color).toBe("#aabbccff");

    // 防抖：350ms 内未落盘，到期后快照含 general.taskbar 且归一后与内存一致
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    const snapshot = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as { general?: { taskbar?: unknown } };
    expect(snapshot.general?.taskbar).toEqual(taskbar());
    expect(normalizeTaskbar(snapshot.general?.taskbar)).toEqual(taskbar());
  });
});

describe("TaskbarPage · 外观编辑器", () => {
  it("accent 切到「模糊」出现「模糊半径」滑条（0–750），切回「透明」消失", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    expect(within(desktopCard()).queryByRole("slider", { name: "模糊半径" })).toBeNull();
    const effect = () => within(within(desktopCard()).getByRole("group", { name: "效果" }));
    await user.click(effect().getByRole("radio", { name: "模糊" }));
    expect(taskbar().states.desktop.accent).toBe("blur");
    const radius = within(desktopCard()).getByRole("slider", { name: "模糊半径" });
    expect(radius).toHaveAttribute("aria-valuemax", "750");
    // 300 距初始 30 太远（270 次步进会超时）：Home 归零后 PageUp 大步长（+10）。
    radius.focus();
    fireEvent.keyDown(radius, { key: "Home" });
    for (let i = 0; i < 30; i++) fireEvent.keyDown(radius, { key: "PageUp" });
    expect(taskbar().states.desktop.blurRadius).toBe(300);
    await user.click(effect().getByRole("radio", { name: "透明" }));
    expect(taskbar().states.desktop.accent).toBe("clear");
    expect(within(desktopCard()).queryByRole("slider", { name: "模糊半径" })).toBeNull();
    // 半径值保留在切片里（切回 blur 不丢）
    expect(taskbar().states.desktop.blurRadius).toBe(300);
  });

  it("颜色：取色器 #rrggbb 与透明度滑条合成 #rrggbbaa 存储；重置回该态默认色", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    const picker = within(desktopCard()).getByLabelText("选择颜色") as HTMLInputElement;
    expect(picker.value).toBe("#000000");
    fireEvent.change(picker, { target: { value: "#ff8800" } });
    expect(taskbar().states.desktop.color).toBe("#ff880000");
    keySlider("透明度", 50);
    expect(taskbar().states.desktop.color).toBe("#ff880080");
    expect((within(desktopCard()).getByLabelText("选择颜色") as HTMLInputElement).value).toBe("#ff8800");
    expect(within(desktopCard()).getByRole("slider", { name: "透明度" })).toHaveAttribute("aria-valuenow", "50");
    await user.click(within(desktopCard()).getByRole("button", { name: "重置" }));
    expect(taskbar().states.desktop.color).toBe("#00000000");
  });

  it("能力渲染（D7）：无 capabilities 不渲染「显示桌面按钮」；supportsPeek 到达后出现；supportsLine=false 隐藏顶线；XAML 目标机再次隐藏 Peek", () => {
    tauriOn = true;
    render(<TaskbarPage />);
    expect(within(desktopCard()).queryByRole("switch", { name: "显示桌面按钮" })).toBeNull();
    expect(within(desktopCard()).getByRole("switch", { name: "顶部分隔线" })).toBeInTheDocument();
    expect(within(desktopCard()).getByRole("radio", { name: "模糊" })).toBeInTheDocument();

    emit("taskbar:capabilities", {
      path: "swca",
      supportsBlur: false,
      supportsPeek: true,
      supportsLine: false,
      supportsBatteryState: false,
      osBuild: 19045
    });
    expect(within(desktopCard()).getByRole("switch", { name: "显示桌面按钮" })).toBeInTheDocument();
    expect(within(desktopCard()).queryByRole("switch", { name: "顶部分隔线" })).toBeNull();
    // blur 不可用且当前非 blur → 选项隐藏；省电态卡随 supportsBatteryState=false 隐藏
    expect(within(desktopCard()).queryByRole("radio", { name: "模糊" })).toBeNull();
    expect(screen.queryByRole("group", { name: "省电模式" })).toBeNull();

    emit("taskbar:capabilities", {
      path: "xaml",
      supportsBlur: true,
      supportsPeek: false,
      supportsLine: true,
      supportsBatteryState: true,
      osBuild: 26200
    });
    expect(within(desktopCard()).queryByRole("switch", { name: "显示桌面按钮" })).toBeNull();
    expect(within(desktopCard()).getByRole("switch", { name: "顶部分隔线" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "省电模式" })).toBeInTheDocument();
    expect(screen.getByText("Build 26200")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("XAML (TAP)");
  });

  it("能力回读（F-12 收口）：设置窗晚开也能挂载回读 get_taskbar_capabilities——SWCA 机器 Peek 开关可见，不再依赖启动事件的时序", async () => {
    tauriOn = true;
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "get_taskbar_capabilities"
        ? {
            path: "swca",
            supportsBlur: true,
            supportsPeek: true,
            supportsLine: true,
            supportsBatteryState: true,
            osBuild: 22000
          }
        : null
    );
    render(<TaskbarPage />);
    // caps=null 的兜底渲染里 Peek 恒隐藏；回读值到达后出现（SWCA 分支）
    expect(await within(desktopCard()).findByRole("switch", { name: "显示桌面按钮" })).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "get_taskbar_capabilities")).toBe(true);
    expect(screen.getByText("Build 22000")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("SWCA");
  });
});

describe("TaskbarPage · 状态条与徽标", () => {
  it("状态条（F-10）：浏览器模式无事件「模块未就绪」；回读 idle 且未启用「未启用」；开启仍 idle「模块未就绪」；ready「运行中」；failed 带原因", async () => {
    const first = render(<TaskbarPage />);
    expect(screen.getByRole("status")).toHaveTextContent("模块未就绪");
    expect(invokeMock).not.toHaveBeenCalled();
    first.unmount();

    tauriOn = true;
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "get_taskbar_status" ? { phase: "idle", reason: null, taskbarType: "unknown", protocolVersion: 1 } : null
    );
    render(<TaskbarPage />);
    await screen.findByText("未启用");
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "get_taskbar_status")).toBe(true);

    setTaskbar({ enabled: true });
    expect(screen.getByRole("status")).toHaveTextContent("模块未就绪");
    expect(screen.getByRole("status")).toHaveTextContent("已开启，等待任务栏模块响应");

    emit("taskbar:status", { phase: "injecting", reason: null, taskbarType: "xaml", protocolVersion: 1 });
    expect(screen.getByRole("status")).toHaveTextContent("正在注入");
    emit("taskbar:status", { phase: "ready", reason: null, taskbarType: "xaml", protocolVersion: 1 });
    expect(screen.getByRole("status")).toHaveTextContent("运行中");
    expect(screen.getByRole("status")).toHaveTextContent("任务栏类型：XAML");
    emit("taskbar:status", { phase: "failed", reason: "需要重启资源管理器", taskbarType: "xaml", protocolVersion: 1 });
    expect(screen.getByRole("status")).toHaveTextContent("故障");
    expect(screen.getByRole("status")).toHaveTextContent("需要重启资源管理器");
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "err");
  });

  it("徽标（F-14）：无 state-changed 事件七卡皆「—」；事件到达后命中卡「当前生效」+ 高亮，其余卡无徽标；多屏各自命中", () => {
    render(<TaskbarPage />);
    expect(screen.getAllByLabelText("当前生效状态未知")).toHaveLength(7);

    emit("taskbar:state-changed", { activeState: "maximizedWindow", monitor: 0, matchedRule: "r1" });
    expect(screen.queryAllByLabelText("当前生效状态未知")).toHaveLength(0);
    const max = screen.getByRole("group", { name: "最大化窗口" });
    expect(within(max).getByText("当前生效")).toHaveAttribute("title", "显示器 0 · 规则 r1");
    expect(max).toHaveClass("is-active");
    expect(within(desktopCard()).queryByText("当前生效")).toBeNull();
    expect(desktopCard()).not.toHaveClass("is-active");

    emit("taskbar:state-changed", { activeState: "desktop", monitor: 1, matchedRule: null });
    expect(desktopCard()).toHaveClass("is-active");
    expect(max).toHaveClass("is-active");
    // 显示器 0 切回桌面 → 最大化卡失去高亮，桌面卡两屏命中
    emit("taskbar:state-changed", { activeState: "desktop", monitor: 0, matchedRule: null });
    expect(screen.getByRole("group", { name: "最大化窗口" })).not.toHaveClass("is-active");
    expect(within(desktopCard()).getByText(/当前生效/)).toHaveTextContent("当前生效 ×2");
  });
});

describe("TaskbarPage · 规则 / 忽略列表 / 恢复默认 / 搜索", () => {
  it("规则（F-4）：启用「可见窗口」后添加、改匹配类型与匹配值、开启非前台外观、下移与删除", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    // 禁用态不渲染编辑器与规则
    expect(within(screen.getByRole("group", { name: "可见窗口" })).queryByText("窗口规则")).toBeNull();
    await user.click(screen.getByRole("switch", { name: "启用 可见窗口" }));
    expect(taskbar().states.visibleWindow.enabled).toBe(true);
    const card = () => screen.getByRole("group", { name: "可见窗口" });
    expect(within(card()).getByText("窗口规则")).toBeInTheDocument();

    await user.click(within(card()).getByRole("button", { name: "添加规则" }));
    await user.click(within(card()).getByRole("button", { name: "添加规则" }));
    expect(taskbar().rules.visibleWindow).toHaveLength(2);
    expect(taskbar().rules.maximizedWindow).toHaveLength(0);
    const [a, b] = taskbar().rules.visibleWindow;
    expect(a.id).not.toBe(b.id);
    expect(a.matchType).toBe("process");

    const rule1 = () => within(card()).getByRole("group", { name: "规则 1" });
    await user.type(within(rule1()).getByRole("textbox", { name: "匹配值" }), "notepad.exe");
    expect(taskbar().rules.visibleWindow[0].pattern).toBe("notepad.exe");

    await user.click(within(within(rule1()).getByRole("group", { name: "匹配类型" })).getByRole("button"));
    await user.click(screen.getByRole("option", { name: "窗口标题" }));
    expect(taskbar().rules.visibleWindow[0].matchType).toBe("title");

    // 规则内外观编辑器独立于状态默认外观
    await user.click(
      within(within(rule1()).getByRole("group", { name: "效果" })).getByRole("radio", { name: "亚克力" })
    );
    expect(taskbar().rules.visibleWindow[0].appearance.accent).toBe("acrylic");
    expect(taskbar().states.visibleWindow.accent).toBe("clear");

    await user.click(within(rule1()).getByRole("switch", { name: "非前台时使用不同外观" }));
    expect(taskbar().rules.visibleWindow[0].inactiveAppearance).toEqual(taskbar().rules.visibleWindow[0].appearance);
    expect(within(rule1()).getByRole("group", { name: "非前台外观" })).toBeInTheDocument();
    await user.click(within(rule1()).getByRole("switch", { name: "非前台时使用不同外观" }));
    expect(taskbar().rules.visibleWindow[0].inactiveAppearance).toBeUndefined();

    expect(within(rule1()).getByRole("button", { name: "上移" })).toBeDisabled();
    await user.click(within(rule1()).getByRole("button", { name: "下移" }));
    expect(taskbar().rules.visibleWindow.map((r) => r.id)).toEqual([b.id, a.id]);

    await user.click(
      within(within(card()).getByRole("group", { name: "规则 1" })).getByRole("button", { name: "删除规则" })
    );
    expect(taskbar().rules.visibleWindow.map((r) => r.id)).toEqual([a.id]);
  });

  it("忽略列表（F-5 / D3）：出厂含 Vela 自身且可删；回车添加（裁剪空白、去重、清空输入）", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    expect(taskbar().ignoredWindows).toEqual({
      classes: ["Tauri Window"],
      titles: [],
      processes: ["Vela.exe", "focus-desk.exe"]
    });
    expect(screen.getByText("Tauri Window")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除Vela.exe" }));
    expect(taskbar().ignoredWindows.processes).toEqual(["focus-desk.exe"]);

    const input = screen.getByRole("textbox", { name: "进程名" }) as HTMLInputElement;
    await user.type(input, "  notepad.exe  {Enter}");
    expect(taskbar().ignoredWindows.processes).toEqual(["focus-desk.exe", "notepad.exe"]);
    expect(input.value).toBe("");
    await user.type(input, "notepad.exe{Enter}");
    expect(taskbar().ignoredWindows.processes).toEqual(["focus-desk.exe", "notepad.exe"]);

    await user.type(screen.getByRole("textbox", { name: "窗口标题" }), "任务管理器");
    await user.click(screen.getAllByRole("button", { name: "添加" })[1]);
    expect(taskbar().ignoredWindows.titles).toEqual(["任务管理器"]);
    expect(taskbar().ignoredWindows.classes).toEqual(["Tauri Window"]);
  });

  it("「恢复默认」重置整个切片（含总开关与忽略列表）并 toast；搜索「任务栏」/「acrylic」命中本页", async () => {
    const user = userEvent.setup();
    setTaskbar({ enabled: true, ignoredWindows: { classes: [], titles: ["x"], processes: [] } });
    render(<TaskbarPage />);
    expect(screen.getByRole("switch", { name: "自定义任务栏外观" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(taskbar()).toEqual(DEFAULT_TASKBAR);
    expect(screen.getByRole("switch", { name: "自定义任务栏外观" })).toHaveAttribute("aria-checked", "false");
    expect(toastMock).toHaveBeenCalledWith("已恢复任务栏默认配置", "ok");

    expect(searchSettings("任务栏").some((r) => r.page === "taskbar")).toBe(true);
    expect(searchSettings("acrylic").some((r) => r.page === "taskbar")).toBe(true);
    expect(searchSettings("忽略").some((r) => r.page === "taskbar" && r.title === "忽略的窗口")).toBe(true);
  });

  it("浏览器模式：「重新应用」只提示仅桌面端可用，不发 IPC；总开关可切换", async () => {
    const user = userEvent.setup();
    render(<TaskbarPage />);
    await user.click(screen.getByRole("button", { name: "重新应用" }));
    expect(toastMock).toHaveBeenCalledWith("该操作仅在桌面端可用", "info");
    expect(invokeMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("switch", { name: "自定义任务栏外观" }));
    expect(taskbar().enabled).toBe(true);
  });
});

describe("TaskbarConfigSync（F-1 模式 B 对账）", () => {
  const flush = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKBAR_APPLY_DEBOUNCE_MS + 10);
    });
  };

  beforeEach(() => {
    tauriOn = true;
    window.location.hash = "#/settings";
    vi.useFakeTimers();
  });

  it("Rust 配置与本地等价（键序 / inactiveAppearance:null 等序列化差异）→ 只 get 不 apply", async () => {
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "get_taskbar_config"
        ? {
            monitorOverrides: {},
            perMonitor: false,
            ignoredWindows: { processes: ["Vela.exe", "focus-desk.exe"], titles: [], classes: ["Tauri Window"] },
            rules: { maximizedWindow: [], visibleWindow: [] },
            states: JSON.parse(JSON.stringify(defaultTaskbarStates())),
            enabled: false
          }
        : null
    );
    render(<TaskbarConfigSync />);
    await flush();
    expect(taskbarCalls().map(([cmd]) => cmd)).toEqual(["get_taskbar_config"]);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("不同才 apply：整包下发本地配置；防抖窗口内连续 3 次改动只触发一次 get + apply", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_taskbar_config") return defaultTaskbarSettings();
      if (cmd === "apply_taskbar_config") return [];
      return null;
    });
    render(<TaskbarConfigSync />);
    await flush();
    expect(taskbarCalls().map(([cmd]) => cmd)).toEqual(["get_taskbar_config"]);
    invokeMock.mockClear();

    setTaskbar({ enabled: true });
    setTaskbar({ states: { ...taskbar().states, desktop: { ...taskbar().states.desktop, blurRadius: 100 } } });
    setTaskbar({ states: { ...taskbar().states, desktop: { ...taskbar().states.desktop, blurRadius: 200 } } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASKBAR_APPLY_DEBOUNCE_MS - 50);
    });
    expect(taskbarCalls()).toHaveLength(0);
    await flush();
    expect(taskbarCalls().map(([cmd]) => cmd)).toEqual(["get_taskbar_config", "apply_taskbar_config"]);
    const args = taskbarCalls()[1][1] as { config: TaskbarSettings };
    expect(args.config).toEqual(taskbar());
    expect(args.config.enabled).toBe(true);
    expect(args.config.states.desktop.blurRadius).toBe(200);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("apply Err（CORE 空壳 not initialized）→ error toast，组件存活并在下次改动继续对账；返回失败项列表同样 toast", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_taskbar_config") return defaultTaskbarSettings();
      if (cmd === "apply_taskbar_config") throw "taskbar: not initialized";
      return null;
    });
    render(<TaskbarConfigSync />);
    setTaskbar({ enabled: true });
    await flush();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toContain("任务栏配置应用失败");
    expect(toastMock.mock.calls[0][0]).toContain("taskbar: not initialized");
    expect(toastMock.mock.calls[0][1]).toBe("error");

    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_taskbar_config") return defaultTaskbarSettings();
      if (cmd === "apply_taskbar_config") return ["monitor:1 pipe timeout"];
      return null;
    });
    setTaskbar({ perMonitor: true });
    await flush();
    expect(toastMock).toHaveBeenCalledTimes(2);
    expect(toastMock.mock.calls[1][0]).toContain("任务栏配置部分未生效");
    expect(toastMock.mock.calls[1][0]).toContain("monitor:1 pipe timeout");
    expect(toastMock.mock.calls[1][1]).toBe("error");
  });

  it("非设置窗（hash 不为 #/settings）不发任何任务栏 IPC；卸载后清掉在飞防抖", async () => {
    window.location.hash = "";
    const view = render(<TaskbarConfigSync />);
    setTaskbar({ enabled: true });
    await flush();
    expect(taskbarCalls()).toHaveLength(0);
    view.unmount();

    window.location.hash = "#/settings";
    const view2 = render(<TaskbarConfigSync />);
    setTaskbar({ enabled: false });
    view2.unmount();
    await flush();
    expect(taskbarCalls()).toHaveLength(0);
  });
});

/* ══════════════════════════════ F-8 实时预览（TB-PREVIEW） ══════════════════════════════ */

describe("TaskbarPage · 实时预览（F-8）", () => {
  type PreviewArgs = { state: string | null; overrides: Record<string, unknown> | null };
  const previewCalls = () =>
    invokeMock.mock.calls.filter(([cmd]) => cmd === "preview_taskbar_state").map(([, args]) => args as PreviewArgs);
  const lastPreview = () => previewCalls().at(-1);
  const persistCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "set_setting");
  const card = (name: string) => screen.getByRole("group", { name });
  const previewBtn = (name: string) => within(card(name)).getByRole("button", { name: "预览此状态" });
  const stopBtn = (name: string) => within(card(name)).getByRole("button", { name: "停止预览" });
  /** 切片单态 → 预览载荷（五个外观字段，无 enabled）。 */
  const appearanceOf = (key: keyof ReturnType<typeof defaultTaskbarStates>) => {
    const { accent, color, showPeek, showLine, blurRadius } = taskbar().states[key];
    return { accent, color, showPeek, showLine, blurRadius };
  };
  const SETTLE_MS = TASKBAR_APPLY_DEBOUNCE_MS + TASKBAR_PREVIEW_SETTLE_GRACE_MS;
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  /** 桌面端 + 总开关开 + 假时钟；把开关落盘的 set_setting 先冲掉，之后的 invoke 序列才干净。 */
  const mountDesktopEnabled = async () => {
    tauriOn = true;
    vi.useFakeTimers();
    setTaskbar({ enabled: true });
    await tick(400);
    const view = render(<TaskbarPage />);
    await tick(0);
    invokeMock.mockClear();
    return view;
  };

  it("拖动透明度：每次输入立即走预览通道（不等 350ms）、载荷为该状态整套外观；落定后取消预览；期间不 set_setting、不 apply", async () => {
    await mountDesktopEnabled();
    keySlider("透明度", 25);
    const callsAt25 = previewCalls().length;
    expect(callsAt25).toBeGreaterThan(0); // 每次步进输入都立即走预览通道
    expect(lastPreview()).toEqual({
      state: "desktop",
      overrides: { accent: "clear", color: "#00000040", showPeek: false, showLine: false, blurRadius: 30 }
    });
    keySlider("透明度", 50);
    keySlider("透明度", 75);
    expect(previewCalls().length).toBeGreaterThan(callsAt25);
    expect(lastPreview()?.overrides?.color).toBe("#000000bf");
    // 拖动期间：切片已更新（UI 跟手）但未落盘、未整包 apply、未取消预览。
    expect(taskbar().states.desktop.color).toBe("#000000bf");
    expect(persistCalls()).toHaveLength(0);
    expect(taskbarCalls()).toHaveLength(0);
    await tick(TASKBAR_APPLY_DEBOUNCE_MS - 50);
    expect(persistCalls()).toHaveLength(0);
    const callsAfterDrag = previewCalls().length;
    expect(callsAfterDrag).toBeGreaterThan(callsAt25);
    // 松手落定：350ms 切片落盘（set_setting，正常持久化路径），350ms + 余量后取消拖动预览。
    await tick(50);
    expect(persistCalls()).toHaveLength(1);
    expect(previewCalls().length).toBe(callsAfterDrag);
    await tick(SETTLE_MS - TASKBAR_APPLY_DEBOUNCE_MS);
    expect(previewCalls().length).toBe(callsAfterDrag + 1);
    expect(lastPreview()).toEqual({ state: null, overrides: null });
    // 落盘快照可往返：刷新页面后保持 75%。
    const snapshot = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as { general?: { taskbar?: unknown } };
    expect(normalizeTaskbar(snapshot.general?.taskbar).states.desktop.color).toBe("#000000bf");
  });

  it("与 TaskbarConfigSync 同挂：拖动 → 预览步进 → 350ms 真实 apply 整包 → 随后才取消预览（真实 apply 已结束 Rust 侧会话，取消是 no-op 兜底）", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_taskbar_config") return defaultTaskbarSettings();
      if (cmd === "apply_taskbar_config") return [];
      return null;
    });
    window.location.hash = "#/settings";
    await mountDesktopEnabled();
    render(<TaskbarConfigSync />);
    await tick(400);
    invokeMock.mockClear();

    keySlider("透明度", 40);
    keySlider("透明度", 60);
    await tick(SETTLE_MS + 10);
    const order = invokeMock.mock.calls
      .map(([cmd, args]) => (cmd === "preview_taskbar_state" ? `preview:${(args as PreviewArgs).state}` : cmd))
      .filter((c) => c.startsWith("preview:") || c.endsWith("_taskbar_config"));
    // 键盘驱动 = 多次步进输入 → 多次 preview:desktop，但整体次序不变：
    // 先预览、350ms 后真实 apply 整包、最后取消预览（preview:null）。
    expect(order[0]).toBe("preview:desktop");
    expect(order.filter((c) => c === "preview:desktop").length).toBeGreaterThan(1);
    expect(order.indexOf("get_taskbar_config")).toBeGreaterThan(0);
    expect(order.indexOf("apply_taskbar_config")).toBeGreaterThan(order.indexOf("get_taskbar_config"));
    expect(order[order.length - 1]).toBe("preview:null");
    const applied = invokeMock.mock.calls.find(([cmd]) => cmd === "apply_taskbar_config")?.[1] as {
      config: TaskbarSettings;
    };
    expect(applied.config.states.desktop.color).toBe("#00000099");
  });

  it("总开关关闭：预览按钮禁用（带提示）且拖动不发预览；开启后按钮可用", async () => {
    tauriOn = true;
    vi.useFakeTimers();
    render(<TaskbarPage />);
    const btn = previewBtn("桌面");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "请先开启「自定义任务栏外观」");
    keySlider("透明度", 30);
    await tick(SETTLE_MS + 10);
    expect(previewCalls()).toHaveLength(0);
    setTaskbar({ enabled: true });
    expect(previewBtn("桌面")).toBeEnabled();
    expect(previewBtn("桌面")).toHaveAttribute("title", "预览此状态");
  });

  it("「预览此状态」：按下钉住（aria-pressed + 「预览中」徽标 + 整套外观载荷）；点他卡直接切换不经取消；再按解除 → preview(null)；全程不写切片、不 set_setting、不 apply", async () => {
    await mountDesktopEnabled();
    const before = JSON.stringify(taskbar());

    fireEvent.click(previewBtn("桌面"));
    expect(previewCalls()).toEqual([{ state: "desktop", overrides: appearanceOf("desktop") }]);
    expect(stopBtn("桌面")).toHaveAttribute("aria-pressed", "true");
    expect(within(desktopCard()).getByText("预览中")).toBeInTheDocument();
    // 禁用态的状态卡（无编辑器）同样可预览：载荷取切片里该态外观，不含 enabled。
    fireEvent.click(previewBtn("最大化窗口"));
    expect(previewCalls()).toHaveLength(2);
    expect(lastPreview()).toEqual({ state: "maximizedWindow", overrides: appearanceOf("maximizedWindow") });
    expect(lastPreview()?.overrides).not.toHaveProperty("enabled");
    expect(within(desktopCard()).queryByText("预览中")).toBeNull();
    expect(previewBtn("桌面")).toHaveAttribute("aria-pressed", "false");
    expect(stopBtn("最大化窗口")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(stopBtn("最大化窗口"));
    expect(previewCalls()).toHaveLength(3);
    expect(lastPreview()).toEqual({ state: null, overrides: null });
    expect(screen.queryByText("预览中")).toBeNull();
    expect(screen.queryByRole("button", { name: "停止预览" })).toBeNull();

    await tick(1000);
    expect(taskbar()).toEqual(JSON.parse(before));
    expect(persistCalls()).toHaveLength(0);
    expect(taskbarCalls()).toHaveLength(0);
    expect(invokeMock.mock.calls.every(([cmd]) => cmd === "preview_taskbar_state")).toBe(true);
  });

  it("钉住 60s 自动解除：到点发 preview(null) 并取消按下态；切换他卡从头计时", async () => {
    await mountDesktopEnabled();
    fireEvent.click(previewBtn("桌面"));
    await tick(TASKBAR_PREVIEW_HOLD_MS - 1);
    expect(stopBtn("桌面")).toHaveAttribute("aria-pressed", "true");
    expect(previewCalls()).toHaveLength(1);
    await tick(1);
    expect(previewBtn("桌面")).toHaveAttribute("aria-pressed", "false");
    expect(lastPreview()).toEqual({ state: null, overrides: null });

    invokeMock.mockClear();
    fireEvent.click(previewBtn("桌面"));
    await tick(TASKBAR_PREVIEW_HOLD_MS - 1000);
    fireEvent.click(previewBtn("最大化窗口"));
    await tick(1000);
    expect(stopBtn("最大化窗口")).toHaveAttribute("aria-pressed", "true");
    expect(previewCalls().map((c) => c.state)).toEqual(["desktop", "maximizedWindow"]);
    await tick(TASKBAR_PREVIEW_HOLD_MS - 1000);
    expect(previewCalls().map((c) => c.state)).toEqual(["desktop", "maximizedWindow", null]);
  });

  it("有钉住的卡时拖动别的卡：拖动中预览被拖的状态，落定后切回钉住的卡（而非取消）", async () => {
    await mountDesktopEnabled();
    fireEvent.click(previewBtn("最大化窗口"));
    keySlider("透明度", 20);
    // 键盘驱动 = 多次步进输入，拖动期间每次都预览被拖的状态（desktop）。
    const states = previewCalls().map((c) => c.state);
    expect(states[0]).toBe("maximizedWindow");
    expect(new Set(states.slice(1))).toEqual(new Set(["desktop"]));
    await tick(SETTLE_MS + 10);
    expect(previewCalls().map((c) => c.state)).toEqual([...states, "maximizedWindow"]);
    expect(lastPreview()?.overrides).toEqual(appearanceOf("maximizedWindow"));
    expect(stopBtn("最大化窗口")).toHaveAttribute("aria-pressed", "true");
  });

  it("离开页面：卸载时取消在飞预览；无预览时卸载不发 IPC；总开关关闭时本地收起钉住态而不再发取消（Rust 侧 apply 已结束预览）", async () => {
    const view = await mountDesktopEnabled();
    view.unmount();
    expect(previewCalls()).toHaveLength(0);

    const view2 = render(<TaskbarPage />);
    await tick(0);
    invokeMock.mockClear();
    fireEvent.click(previewBtn("桌面"));
    view2.unmount();
    expect(previewCalls().map((c) => c.state)).toEqual(["desktop", null]);

    invokeMock.mockClear();
    render(<TaskbarPage />);
    await tick(0);
    fireEvent.click(previewBtn("桌面"));
    setTaskbar({ enabled: false });
    expect(previewBtn("桌面")).toBeDisabled();
    expect(previewBtn("桌面")).toHaveAttribute("aria-pressed", "false");
    expect(previewCalls().map((c) => c.state)).toEqual(["desktop"]);
  });

  it("浏览器模式：按钮只提示仅桌面端可用、不发 IPC；拖动也不发", async () => {
    setTaskbar({ enabled: true });
    render(<TaskbarPage />);
    fireEvent.click(previewBtn("桌面"));
    expect(toastMock).toHaveBeenCalledWith("该操作仅在桌面端可用", "info");
    expect(previewBtn("桌面")).toHaveAttribute("aria-pressed", "false");
    keySlider("透明度", 30);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "preview_taskbar_state")).toBe(false);
  });

  it("预览 IPC 失败：按钮路径 toast 并回退钉住态；拖动路径静默不 toast", async () => {
    tauriOn = true;
    setTaskbar({ enabled: true });
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "preview_taskbar_state") throw "任务栏模块未就绪，无法预览";
      return null;
    });
    render(<TaskbarPage />);
    fireEvent.click(previewBtn("桌面"));
    await within(desktopCard()).findByRole("button", { name: "预览此状态", pressed: false }, { timeout: 2000 });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toContain("预览失败");
    expect(toastMock.mock.calls[0][0]).toContain("任务栏模块未就绪，无法预览");
    expect(toastMock.mock.calls[0][1]).toBe("error");
    expect(within(desktopCard()).queryByText("预览中")).toBeNull();

    toastMock.mockClear();
    keySlider("透明度", 30);
    await act(async () => {
      await Promise.resolve();
    });
    expect(previewCalls().length).toBeGreaterThanOrEqual(2);
    expect(toastMock).not.toHaveBeenCalled();
  });
});
