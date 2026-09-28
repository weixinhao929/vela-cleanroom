import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySettings,
  cancelDeferNextThemeApply,
  DEFAULT_TASKBAR,
  deferNextThemeApply,
  defaultTaskbarSettings,
  defaultTaskbarStates,
  normalizeTaskbar,
  normalizeTaskbarColor,
  sanitizeSettings,
  useSettingsStore,
  type TaskbarSettings,
  type TaskbarStateKey
} from "./settings-store";
import type { TaskbarSettings as TaskbarSettingsBinding } from "../types/bindings/TaskbarSettings";
import type { TaskbarStateChanged } from "../types/bindings/TaskbarStateChanged";
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS } from "../lib/shortcuts";

/** 迁移兼容：引擎要求显式传动效环境；此处读实时 store 状态，与迁移前
 *  applySettings 内部 getState() 反读的取值时机一致。 */
function apply(s: Parameters<typeof applySettings>[0]) {
  const st = useSettingsStore.getState();
  return applySettings(s, st.extra, st.general.reduceEffects);
}

/**
 * 验证「设置一定要能设置上去」的完整链路：
 *  1. applySettings 会把外观设置写入 <html> 的 CSS 变量（驱动悬浮窗/设置页渲染）
 *  2. 主题模式（system/light/dark）会正确切换 data-theme 与明暗 token
 *  3. 主色 / 圆角 / 间距 / 模糊 / 不透明度等设置项逐一生效
 *  4. 设置项持久化到 localStorage，重新加载后可恢复
 */
describe("settings-store apply chain", () => {
  // 用户显示偏好（不透明度 / 字体 / 界面缩放 / 字号）不随主题预设切换重置：
  // 此前 setPreset 每次都把 widgetOpacity 打回预设默认，用户切个主题就得重调。
  it("setPreset 保留不透明度 / 字体 / 缩放等用户自设值，只换主题身份色", () => {
    const st = useSettingsStore.getState();
    useSettingsStore.setState({
      widgetOpacity: 80,
      font: "Serif",
      zoom: 130,
      fontSize: 115,
      cornerRadius: 12
    });
    st.setPreset("retro");
    const after = useSettingsStore.getState();
    expect(after.preset).toBe("retro");
    // 主题身份色跟随预设（强调色 / 玻璃色由预设档给出）；用户的显示偏好原样保留。
    expect(after.widgetOpacity).toBe(80);
    expect(after.font).toBe("Serif");
    expect(after.zoom).toBe(130);
    expect(after.fontSize).toBe(115);
    expect(after.cornerRadius).toBe(12);
  });

  beforeEach(() => {
    /* 冲掉上一用例遗留的 350ms 防抖落盘（reloadStoreModule 出来的每个模块实例各有一份
       计时器，且都监听 pagehide 立即冲刷）：否则它可能在下一用例「写种子 → 动态 import」
       之间触发，用旧态覆盖种子——全量并行跑时的随机失败根因。 */
    window.dispatchEvent(new Event("pagehide"));
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    // 清掉上次测试写入的内联样式，避免污染断言。
    for (const prop of Array.from(document.documentElement.style)) {
      document.documentElement.style.removeProperty(prop);
    }
  });

  it("applySettings 将主色写入 --accent / --btn-bg", () => {
    apply({
      preset: "default",
      themeMode: "system",
      primaryColor: "#ff5500",
      zoom: 100,
      font: "系统",
      fontSize: 100,
      widgetBackground: "rgba(255,255,255,.08)",
      widgetOpacity: 55,
      cornerRadius: 24,
      spacing: 16,
      blur: 32,
      settingsWindowOpacity: 100
    });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ff5500");
    expect(document.documentElement.style.getPropertyValue("--btn-bg")).toBe("#ff5500");
  });

  /** 临时替换 matchMedia，模拟操作系统的明暗偏好（「system」主题档消费）。 */
  function withSystemDark<T>(dark: boolean, fn: () => T): T {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: dark && /prefers-color-scheme:\s*dark/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
    try {
      return fn();
    } finally {
      window.matchMedia = original;
    }
  }

  it("system 主题跟随操作系统明暗：系统深色 → glass，系统浅色 → light", () => {
    const appearance = {
      preset: "default" as const,
      themeMode: "system" as const,
      primaryColor: "#81d4fa",
      zoom: 100,
      font: "系统",
      fontSize: 100,
      widgetBackground: "rgba(23,23,23,.66)",
      widgetOpacity: 55,
      cornerRadius: 24,
      spacing: 16,
      blur: 32,
      settingsWindowOpacity: 100
    };
    withSystemDark(true, () => {
      apply({ ...appearance });
      expect(document.documentElement.getAttribute("data-theme")).toBe("glass");
    });
    withSystemDark(false, () => {
      apply({ ...appearance });
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  it("主题模式选档取对应 token：default 深档 = 原午夜配色、浅档 = 原日光配色", () => {
    apply({
      preset: "default",
      themeMode: "dark",
      primaryColor: "#81d4fa",
      zoom: 100,
      font: "系统",
      fontSize: 100,
      widgetBackground: "rgba(23,23,23,.66)",
      widgetOpacity: 55,
      cornerRadius: 24,
      spacing: 16,
      blur: 32,
      settingsWindowOpacity: 100
    });
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#0a0a0a");
    apply({
      preset: "default",
      themeMode: "light",
      primaryColor: "#81d4fa",
      zoom: 100,
      font: "系统",
      fontSize: 100,
      widgetBackground: "rgba(255,255,255,.68)",
      widgetOpacity: 55,
      cornerRadius: 24,
      spacing: 16,
      blur: 32,
      settingsWindowOpacity: 100
    });
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#f2f2f7");
  });

  it("主题模式强制 light → data-theme=light 且文字色为浅色档深墨", () => {
    apply({
      preset: "default",
      themeMode: "light",
      primaryColor: "#81d4fa",
      zoom: 100,
      font: "系统",
      fontSize: 100,
      widgetBackground: "rgba(255,255,255,.68)",
      widgetOpacity: 55,
      cornerRadius: 24,
      spacing: 16,
      blur: 32,
      settingsWindowOpacity: 100
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--ink")).toContain("1d1d1f");
  });

  it("圆角 / 间距 / 模糊 / 不透明度逐项生效", () => {
    apply({
      preset: "default",
      themeMode: "system",
      primaryColor: "#81d4fa",
      zoom: 100,
      font: "系统",
      fontSize: 100,
      widgetBackground: "rgba(255,255,255,.08)",
      widgetOpacity: 55,
      cornerRadius: 12,
      spacing: 8,
      blur: 40,
      settingsWindowOpacity: 80
    });
    const st = document.documentElement.style;
    expect(st.getPropertyValue("--radius")).toBe("12px");
    expect(st.getPropertyValue("--spacing")).toBe("8px");
    expect(st.getPropertyValue("--blur")).toBe("40px");
    expect(st.getPropertyValue("--settings-window-opacity")).toBe("0.8");
  });

  it("设置项持久化到 localStorage，可恢复", () => {
    const s = useSettingsStore.getState();
    s.setPrimaryColor("#123456");
    s.setCornerRadius(18);
    s.setSpacing(12);
    s.setThemeMode("dark");
    const raw = localStorage.getItem("focus-desk.settings.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.primaryColor).toBe("#123456");
    expect(parsed.cornerRadius).toBe(18);
    expect(parsed.spacing).toBe(12);
    expect(parsed.themeMode).toBe("dark");
  });

  it("setWidgetOpacity 支持完整 0–100 区间并钳制越界值", () => {
    const s = useSettingsStore.getState();
    s.setWidgetOpacity(0);
    expect(useSettingsStore.getState().widgetOpacity).toBe(0);
    s.setWidgetOpacity(100);
    expect(useSettingsStore.getState().widgetOpacity).toBe(100);
    s.setWidgetOpacity(37);
    expect(useSettingsStore.getState().widgetOpacity).toBe(37);
    s.setWidgetOpacity(-10);
    expect(useSettingsStore.getState().widgetOpacity).toBe(0);
    s.setWidgetOpacity(150);
    expect(useSettingsStore.getState().widgetOpacity).toBe(100);
  });

  /* 下面两例走真实启动路径：store 在模块加载时 `const loaded = loadSettings()`
     读 localStorage 并与默认值合并。用 vi.resetModules() + 动态 import 让
     模块在「损坏数据已写入」之后重新初始化（原先经无调用者的 hydrate() 动作
     间接覆盖，该动作已随死代码清理移除）。 */
  async function reloadStoreModule() {
    vi.resetModules();
    return await import("./settings-store");
  }

  it("损坏的 localStorage 设置在启动时被 sanitizeSettings 归一化", async () => {
    // 写入损坏数据：嵌套字段类型错误、数值越界、缺失字段
    localStorage.setItem(
      "focus-desk.settings.v1",
      JSON.stringify({
        preset: "nonexistent",
        themeMode: "unknown",
        zoom: "abc",
        general: { language: 123, launchOnStartup: "yes" },
        extra: { weatherLat: "not-a-number", animationDuration: 999, widgetEntrance: "invalid" },
        notifications: null
      })
    );
    const mod = await reloadStoreModule();
    const state = mod.useSettingsStore.getState();
    // 非法 preset 保持默认（default）
    expect(state.preset).toBe("default");
    // 非法 themeMode 保持默认（system）
    expect(state.themeMode).toBe("system");
    // zoom 应为默认值 100（100 制，非 0.5–2 区间）
    expect(state.zoom).toBe(100);
    // general 嵌套字段回退
    expect(state.general.language).toBe("简体中文");
    expect(state.general.launchOnStartup).toBe(false);
    // extra 嵌套字段回退
    expect(state.extra.weatherLat).toBe(39.9042);
    expect(state.extra.animationDuration).toBe(100);
    // 非法枚举回退到默认
    expect(state.extra.widgetEntrance).toBe("scale");
    // notifications 为 null → 全默认
    expect(state.notifications.pomodoroEnabled).toBe(true);
    expect(state.notifications.todoEnabled).toBe(true);
  });

  it("损坏的颜色/字体字段（数字）不会在启动/applySettings 时崩溃", async () => {
    // primaryColor/widgetBackground/font 曾未校验直接透传；若为数字，
    // applySettings 里的 hex.trim() 会抛错导致启动崩溃。
    localStorage.setItem(
      "focus-desk.settings.v1",
      JSON.stringify({
        preset: "default",
        primaryColor: 123,
        widgetBackground: 456,
        font: 789
      })
    );
    const mod = await reloadStoreModule();
    const state = mod.useSettingsStore.getState();
    expect(() => mod.applySettings(state, mod.themeEnvOf(state), state.general.reduceEffects)).not.toThrow();
    // 回退到字符串默认值（default 主题的主色 / 纸面 / 系统字体；旧 glass 预设迁移为 default）
    expect(state.preset).toBe("default");
    expect(state.primaryColor).toBe("#3a81f6");
    expect(state.widgetBackground).toBe("rgba(23,23,23,.66)");
    expect(state.font).toBe("系统");
  });

  it("[POLISH] B3 自定义曲线：非法控制点回退默认、合法通过、applySettings 写 --ease-custom", async () => {
    /* 前序用例的 setter 会留下 350ms 防抖落盘计时（每个 reload 出来的模块实例各一份），
       若在「写种子 → 动态 import 求值」之间触发就会用旧态覆盖种子。所有实例都监听
       pagehide 立即冲刷，先派发一次把在飞落盘清空，再写种子。 */
    const drainPendingSaves = () => {
      window.dispatchEvent(new Event("pagehide"));
      localStorage.clear();
    };
    // 非法：x 越界（曲线回头）——store 只接收合法曲线，损坏数据回退 Spatial 默认档
    drainPendingSaves();
    localStorage.setItem(
      "focus-desk.settings.v1",
      JSON.stringify({ preset: "glass", extra: { customEase: [1.5, 0.2, 0.2, 1], customEaseEnabled: true } })
    );
    let mod = await reloadStoreModule();
    let state = mod.useSettingsStore.getState();
    expect(state.extra.customEase).toEqual([0.38, 1.21, 0.22, 1]);
    expect(state.extra.customEaseEnabled).toBe(true);

    // 合法：原样保留，启用时 --ease-entrance 指向 --ease-custom
    drainPendingSaves();
    localStorage.setItem(
      "focus-desk.settings.v1",
      JSON.stringify({ preset: "glass", extra: { customEase: [0.2, 0.9, 0.3, 1], customEaseEnabled: true } })
    );
    mod = await reloadStoreModule();
    state = mod.useSettingsStore.getState();
    expect(state.extra.customEase).toEqual([0.2, 0.9, 0.3, 1]);
    mod.applySettings(state, mod.themeEnvOf(state), state.general.reduceEffects);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--ease-custom")).toBe("cubic-bezier(0.2, 0.9, 0.3, 1)");
    expect(root.style.getPropertyValue("--ease-entrance")).toBe("var(--ease-custom)");

    // 关闭开关：--ease-custom 仍可用作 token，入场别名回退 CSS 缺省
    mod.useSettingsStore.getState().setExtra({ customEaseEnabled: false });
    state = mod.useSettingsStore.getState();
    mod.applySettings(state, mod.themeEnvOf(state), state.general.reduceEffects);
    expect(root.style.getPropertyValue("--ease-custom")).toBe("cubic-bezier(0.2, 0.9, 0.3, 1)");
    expect(root.style.getPropertyValue("--ease-entrance")).toBe("");

    // setExtra 收到非法曲线：sanitize 拒绝，回退默认档而非写入损坏值
    mod.useSettingsStore.getState().setExtra({ customEase: [0.3, 0, 2, 1] as never });
    expect(mod.useSettingsStore.getState().extra.customEase).toEqual([0.38, 1.21, 0.22, 1]);
  });

  it("sanitizeSettings 对 primaryColor 数字直接回退默认值", () => {
    const out = sanitizeSettings({ primaryColor: 999, widgetBackground: null, font: true });
    expect(out.primaryColor).toBe("#3a81f6");
    expect(out.widgetBackground).toBe("rgba(23,23,23,.66)");
    expect(out.font).toBe("系统");
  });

  it("rgba 预设背景的 alpha 派生生效：不透明度 100% 时 --paper-opaque 真正不透明", () => {
    // 回归：hexToRgba 此前只认 #rrggbb，rgba(...) 输入原样返回，
    // 导致 --paper-soft/--paper-opaque 等五级派生全部失效。
    apply({
      preset: "default",
      themeMode: "system",
      primaryColor: "#81d4fa",
      zoom: 100,
      font: "系统",
      fontSize: 100,
      widgetBackground: "rgba(255,255,255,.08)",
      widgetOpacity: 100,
      cornerRadius: 24,
      spacing: 16,
      blur: 32,
      settingsWindowOpacity: 100
    });
    const st = document.documentElement.style;
    expect(st.getPropertyValue("--paper")).toBe("rgba(255,255,255,0.50)");
    expect(st.getPropertyValue("--paper-solid")).toBe("rgba(255,255,255,0.85)");
    expect(st.getPropertyValue("--paper-soft")).toBe("rgba(255,255,255,0.30)");
    expect(st.getPropertyValue("--popover-bg")).toBe("rgba(255,255,255,0.92)");
    expect(st.getPropertyValue("--paper-opaque")).toBe("rgba(255,255,255,1.00)");
  });

  it("[CLIP] 剪贴板隐私开关：缺省 开/开/关，坏值回默认，setGeneral 落盘的快照含 general.clipboard（Rust 线协议）", () => {
    // 旧快照没有 clipboard 字段 → 全默认（总开关开、图片开、来源进程关）。
    const legacy = sanitizeSettings({ general: { language: "简体中文" } });
    expect(legacy.general?.clipboard).toEqual({
      enabled: true,
      captureImages: true,
      captureFiles: true,
      recordSource: false,
      linkPopup: true
    });
    // 类型错误逐项回默认，合法布尔保留。
    const mixed = sanitizeSettings({
      general: { clipboard: { enabled: false, captureImages: "yes", recordSource: true } }
    });
    expect(mixed.general?.clipboard).toEqual({
      enabled: false,
      captureImages: true,
      captureFiles: true,
      recordSource: true,
      linkPopup: true
    });
    // 非对象整体回默认。
    expect(sanitizeSettings({ general: { clipboard: [] } }).general?.clipboard).toEqual({
      enabled: true,
      captureImages: true,
      captureFiles: true,
      recordSource: false,
      linkPopup: true
    });

    // [SUPER-PANEL]/[DOUBLE-TAP]/[WAKE-BL]（ZTools #11/#13/#14）新切片：缺省
    // 关 + 时长钳制 + 键族白名单；黑名单只留非空去重字符串。
    const fresh = sanitizeSettings({ general: { language: "简体中文" } });
    expect(fresh.general?.superPanel).toEqual({ enabled: false, durationMs: 500 });
    expect(fresh.general?.doubleTapSummon).toEqual({ enabled: false, key: "ctrl" });
    expect(fresh.general?.hotkeyBlacklist).toEqual([]);
    const weird = sanitizeSettings({
      general: {
        superPanel: { enabled: true, durationMs: 9999 },
        doubleTapSummon: { enabled: "yes", key: "weird" },
        hotkeyBlacklist: ["a.exe", "a.exe", " ", 42, "b.exe"]
      }
    });
    expect(weird.general?.superPanel).toEqual({ enabled: true, durationMs: 1000 });
    expect(weird.general?.doubleTapSummon).toEqual({ enabled: false, key: "ctrl" });
    expect(weird.general?.hotkeyBlacklist).toEqual(["a.exe", "b.exe"]);

    // 端到端：setGeneral 写入后 localStorage 快照携带 general.clipboard，
    // 字段名与 clipboard.rs parse_clip_config 读取的路径一致。
    const store = useSettingsStore.getState();
    store.setGeneral({
      clipboard: { enabled: false, captureImages: false, captureFiles: false, recordSource: true, linkPopup: true }
    });
    expect(useSettingsStore.getState().general.clipboard).toEqual({
      enabled: false,
      captureImages: false,
      captureFiles: false,
      recordSource: true,
      linkPopup: true
    });
    const raw = JSON.parse(localStorage.getItem("focus-desk.settings.v1") ?? "{}");
    expect(raw.general.clipboard).toEqual({
      enabled: false,
      captureImages: false,
      captureFiles: false,
      recordSource: true,
      linkPopup: true
    });
    // 还原，避免污染后续用例。
    store.setGeneral({
      clipboard: { enabled: true, captureImages: true, captureFiles: true, recordSource: false, linkPopup: true }
    });
  });
});

/**
 * theme-engine 安全网：水墨接管（defer 一次主题切换的 applySettings，主题
 * 过渡已由 lib/theme-ink.ts 水墨晕开取代交叉淡化）与特效切换抑制
 * （.fx-switching 1000ms）的时序。原 .theme-transitioning 契约已删除。
 */
describe("theme transition / fx switching timing", () => {
  const root = document.documentElement;
  const base = {
    preset: "default",
    themeMode: "system",
    primaryColor: "#81d4fa",
    zoom: 100,
    font: "系统",
    fontSize: 100,
    widgetBackground: "rgba(255,255,255,.08)",
    widgetOpacity: 55,
    cornerRadius: 24,
    spacing: 16,
    blur: 32,
    settingsWindowOpacity: 100
  } as const;

  beforeEach(() => {
    localStorage.clear();
    root.className = "";
  });

  it("水墨接管：defer 后主题切换的那次 apply 被吞，回放（再次 apply）才生效", () => {
    apply({ ...base, themeMode: "dark" });
    const bgBefore = root.style.getPropertyValue("--bg");
    deferNextThemeApply();
    apply({ ...base, themeMode: "light" });
    expect(root.style.getPropertyValue("--bg")).toBe(bgBefore);
    apply({ ...base, themeMode: "light" });
    expect(root.style.getPropertyValue("--bg")).not.toBe(bgBefore);
    cancelDeferNextThemeApply();
  });

  it("主题切换不再挂 .theme-transitioning（交叉淡化已移除，即时/接管均无过渡类）", () => {
    apply({ ...base, themeMode: "dark" });
    apply({ ...base, themeMode: "light" });
    expect(root.classList.contains("theme-transitioning")).toBe(false);
    deferNextThemeApply();
    apply({ ...base, themeMode: "dark" });
    expect(root.classList.contains("theme-transitioning")).toBe(false);
    cancelDeferNextThemeApply();
  });

  it("特效键翻转 → 挂 .fx-switching 1000ms；data-fx-off 同步写入/移除", () => {
    vi.useFakeTimers();
    try {
      useSettingsStore.setState({
        extra: { ...useSettingsStore.getState().extra, enableAnimations: true, animationMode: "enhanced" }
      });
      apply({ ...base });
      vi.advanceTimersByTime(2000);
      root.classList.remove("fx-switching");
      expect(root.getAttribute("data-fx-off")).toBe(null);
      // 关闭一个特效 id → fx 键变化 → 挂类 + data-fx-off 出现该 id。
      useSettingsStore.setState({
        extra: {
          ...useSettingsStore.getState().extra,
          fxToggles: { ...useSettingsStore.getState().extra.fxToggles, particleText: false }
        }
      });
      apply({ ...base, primaryColor: "#82d5fb" });
      expect(root.classList.contains("fx-switching")).toBe(true);
      expect(root.getAttribute("data-fx-off")).toContain("particleText");
      vi.advanceTimersByTime(999);
      expect(root.classList.contains("fx-switching")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(root.classList.contains("fx-switching")).toBe(false);
      // 恢复后 data-fx-off 移除（即使仍在 1s 抑制窗内）。
      useSettingsStore.setState({
        extra: {
          ...useSettingsStore.getState().extra,
          fxToggles: { ...useSettingsStore.getState().extra.fxToggles, particleText: true }
        }
      });
      apply({ ...base, primaryColor: "#83d6fc" });
      expect(root.getAttribute("data-fx-off")).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * [TB-CORE] 任务栏切片契约：D1/D2/D3 出厂默认、normalizeTaskbar 往返与坏值
 * 逐字段回退（语义与 Rust taskbar/mod.rs from_json_value 单测一一对应）、
 * 落盘快照携带 general.taskbar（Rust parse_taskbar_config 读取路径）。
 */
describe("[TB-CORE] taskbar slice", () => {
  beforeEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    localStorage.clear();
  });

  /* 编译期同构断言：settings-store 类型与 ts-rs 生成的 Rust 绑定双向可赋值。
     任一侧改字段名 / 类型，`npm run check` 即失败（true 不再可赋给 false）——
     这就是「字段名即线协议」的门禁。纯类型层，无运行时代价。 */
  type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const _iso: [
    MutuallyAssignable<TaskbarSettings, TaskbarSettingsBinding>,
    MutuallyAssignable<TaskbarStateKey, TaskbarStateChanged["activeState"]>
  ] = [true, true];
  const _bindingAccepts: TaskbarSettingsBinding = DEFAULT_TASKBAR;
  void _iso;
  void _bindingAccepts;

  it("D1/D2/D3 出厂默认：总开关关、六可选态全关且外观对齐 §1.1 表、忽略列表含 Vela 自身", () => {
    const d = defaultTaskbarSettings();
    expect(d.enabled).toBe(false);
    expect(d.perMonitor).toBe(false);
    expect(d.monitorOverrides).toEqual({});
    expect(d.rules).toEqual({ visibleWindow: [], maximizedWindow: [] });
    // desktop 无 enabled 键；clear + 全透明 + 无 peek/line。
    expect("enabled" in d.states.desktop).toBe(false);
    expect(d.states.desktop).toEqual({
      accent: "clear",
      color: "#00000000",
      showPeek: false,
      showLine: false,
      blurRadius: 30
    });
    const table: Array<[TaskbarStateKey, string, boolean, boolean]> = [
      ["visibleWindow", "clear", true, false],
      ["maximizedWindow", "acrylic", true, true],
      ["startOpened", "normal", true, true],
      ["searchOpened", "normal", true, true],
      ["taskViewOpened", "normal", false, true],
      ["batterySaver", "opaque", true, false]
    ];
    for (const [key, accent, peek, line] of table) {
      const st = d.states[key];
      expect(st.enabled, key).toBe(false);
      expect(st.accent, key).toBe(accent);
      expect(st.showPeek, key).toBe(peek);
      expect(st.showLine, key).toBe(line);
      expect(st.blurRadius, key).toBe(30);
      expect(st.color, key).toBe("#00000000");
    }
    expect(d.ignoredWindows.classes).toEqual(["Tauri Window"]);
    expect(d.ignoredWindows.processes).toEqual(expect.arrayContaining(["Vela.exe", "focus-desk.exe"]));
    // 工厂每次返回新对象，不与 DEFAULT_TASKBAR 共享嵌套引用。
    expect(d).toEqual(DEFAULT_TASKBAR);
    expect(d.states).not.toBe(DEFAULT_TASKBAR.states);
  });

  it("normalizeTaskbar 往返：默认值幂等；完整自定义配置逐字段保留（含 inactive / 覆盖表）", () => {
    expect(normalizeTaskbar(DEFAULT_TASKBAR)).toEqual(DEFAULT_TASKBAR);
    expect(normalizeTaskbar(JSON.parse(JSON.stringify(DEFAULT_TASKBAR)))).toEqual(DEFAULT_TASKBAR);

    const custom: TaskbarSettings = {
      ...defaultTaskbarSettings(),
      enabled: true,
      perMonitor: true,
      states: {
        ...defaultTaskbarStates(),
        desktop: { accent: "blur", color: "#10203040", showPeek: false, showLine: true, blurRadius: 750 },
        maximizedWindow: {
          accent: "opaque",
          color: "#ff0000ff",
          showPeek: false,
          showLine: false,
          blurRadius: 0,
          enabled: true
        }
      },
      rules: {
        visibleWindow: [
          {
            id: "r1",
            matchType: "title",
            pattern: " - 记事本",
            appearance: { accent: "acrylic", color: "#00000080", showPeek: false, showLine: true, blurRadius: 30 },
            inactiveAppearance: {
              accent: "clear",
              color: "#00000000",
              showPeek: false,
              showLine: false,
              blurRadius: 30
            }
          }
        ],
        maximizedWindow: [
          {
            id: "r2",
            matchType: "process",
            pattern: "Notepad.exe",
            appearance: { accent: "normal", color: "#00000000", showPeek: true, showLine: true, blurRadius: 30 }
          }
        ]
      },
      ignoredWindows: { classes: ["Tauri Window"], titles: ["  padded "], processes: ["Vela.exe"] },
      monitorOverrides: {
        "slot-1": { enabled: false, ignoredWindows: { classes: [], titles: [], processes: ["Only.exe"] } }
      }
    };
    expect(normalizeTaskbar(custom)).toEqual(custom);
    // 经 JSON 序列化（落盘 / IPC 形态）再归一仍等价。
    expect(normalizeTaskbar(JSON.parse(JSON.stringify(custom)))).toEqual(custom);
  });

  it("坏值逐字段回默认：布尔 / accent / 颜色 / 半径 / 规则坏项 / 忽略列表 / 覆盖表（对应 Rust parse_taskbar_config_bad_values 用例）", () => {
    const s = normalizeTaskbar({
      enabled: "yes",
      states: {
        desktop: { accent: "neon", color: "#zz", blurRadius: 9999, showPeek: 1, enabled: true },
        visibleWindow: { enabled: true, accent: "blur", color: "#08c", blurRadius: 120 }
      },
      rules: {
        visibleWindow: [
          { id: "", matchType: "class", pattern: "x" },
          { id: "ok", matchType: "weird", pattern: "x" },
          { id: "r1", matchType: "process", pattern: "a.EXE" },
          7
        ],
        maximizedWindow: "nope"
      },
      ignoredWindows: { classes: "x", titles: ["ok", "", 3], processes: ["P.exe"] },
      perMonitor: "on",
      monitorOverrides: { "slot-a": { enabled: false, states: 5 }, "": { enabled: true } }
    });
    expect(s.enabled).toBe(false);
    expect(s.states.desktop).toEqual({
      accent: "clear",
      color: "#00000000",
      showPeek: false,
      showLine: false,
      blurRadius: 30
    });
    expect("enabled" in s.states.desktop).toBe(false);
    expect(s.states.visibleWindow).toEqual({
      accent: "blur",
      color: "#0088ccff",
      showPeek: true,
      showLine: false,
      blurRadius: 120,
      enabled: true
    });
    expect(s.states.taskViewOpened.enabled).toBe(false);
    expect(s.rules.visibleWindow).toEqual([
      {
        id: "r1",
        matchType: "process",
        pattern: "a.EXE",
        appearance: { accent: "clear", color: "#00000000", showPeek: false, showLine: false, blurRadius: 30 }
      }
    ]);
    expect(s.rules.maximizedWindow).toEqual([]);
    expect(s.ignoredWindows).toEqual({ classes: [], titles: ["ok"], processes: ["P.exe"] });
    expect(s.perMonitor).toBe(false);
    expect(Object.keys(s.monitorOverrides)).toEqual(["slot-a"]);
    expect(s.monitorOverrides["slot-a"]).toEqual({ enabled: false });
    // 半径：非整数 / 负数回默认，字符串数字接受；边界 0 与 750 保留，751 回默认。
    const r = (blurRadius: unknown) =>
      normalizeTaskbar({ states: { desktop: { blurRadius } } }).states.desktop.blurRadius;
    expect(r(30.5)).toBe(30);
    expect(r(-1)).toBe(30);
    expect(r("120")).toBe(120);
    expect(r(0)).toBe(0);
    expect(r(750)).toBe(750);
    expect(r(751)).toBe(30);
  });

  it("旧快照无 taskbar / 非对象 → 全默认；ignoredWindows 空对象保留默认，显式空数组才清空", () => {
    expect(sanitizeSettings({ general: { language: "简体中文" } }).general?.taskbar).toEqual(DEFAULT_TASKBAR);
    expect(normalizeTaskbar(null)).toEqual(DEFAULT_TASKBAR);
    expect(normalizeTaskbar([])).toEqual(DEFAULT_TASKBAR);
    expect(normalizeTaskbar({ ignoredWindows: {} }).ignoredWindows).toEqual(DEFAULT_TASKBAR.ignoredWindows);
    expect(normalizeTaskbar({ ignoredWindows: { classes: [], titles: [], processes: [] } }).ignoredWindows).toEqual({
      classes: [],
      titles: [],
      processes: []
    });
  });

  it("normalizeTaskbarColor：3/4/6/8 位归一为小写 #rrggbbaa，其余 null（与 Rust normalize_hex_color 同表）", () => {
    expect(normalizeTaskbarColor("#fff")).toBe("#ffffffff");
    expect(normalizeTaskbarColor("#FFFF")).toBe("#ffffffff");
    expect(normalizeTaskbarColor("#AbCdEf")).toBe("#abcdefff");
    expect(normalizeTaskbarColor("#AABBCCDD")).toBe("#aabbccdd");
    expect(normalizeTaskbarColor("  #aabbccdd  ")).toBe("#aabbccdd");
    expect(normalizeTaskbarColor("#12345")).toBeNull();
    expect(normalizeTaskbarColor("aabbccdd")).toBeNull();
    expect(normalizeTaskbarColor("#gggggg")).toBeNull();
    expect(normalizeTaskbarColor("")).toBeNull();
    expect(normalizeTaskbarColor(0xffffff)).toBeNull();
  });

  it("setGeneral 落盘快照携带 general.taskbar（Rust parse_taskbar_config 读取路径），坏 patch 经 sanitize 归一", () => {
    const store = useSettingsStore.getState();
    store.setGeneral({
      taskbar: {
        ...defaultTaskbarSettings(),
        enabled: true,
        states: {
          ...defaultTaskbarStates(),
          desktop: { accent: "acrylic", color: "#08c", showPeek: false, showLine: true, blurRadius: 9999 }
        }
      }
    });
    const live = useSettingsStore.getState().general.taskbar;
    expect(live.enabled).toBe(true);
    expect(live.states.desktop).toEqual({
      accent: "acrylic",
      color: "#0088ccff",
      showPeek: false,
      showLine: true,
      blurRadius: 30
    });
    const raw = JSON.parse(localStorage.getItem("focus-desk.settings.v1") ?? "{}");
    expect(raw.general.taskbar.enabled).toBe(true);
    expect(raw.general.taskbar.states.desktop.color).toBe("#0088ccff");
    expect(raw.general.taskbar.ignoredWindows.processes).toContain("Vela.exe");
    // 还原，避免污染后续用例。
    store.setGeneral({ taskbar: defaultTaskbarSettings() });
    expect(useSettingsStore.getState().general.taskbar).toEqual(DEFAULT_TASKBAR);
  });
});

/** [TB-TRAY] F-11：快捷键切片对新增动作的补默认 / 未绑定语义（normalizeShortcuts 经 sanitizeSettings 暴露）。 */
describe("[TB-TRAY] shortcuts slice", () => {
  const LEGACY_NINE = {
    "toggle-pomodoro": "Ctrl+Alt+Space",
    "toggle-layer": "Ctrl+Alt+D",
    "toggle-edit": "Ctrl+Alt+E",
    "show-settings": "Ctrl+Alt+S",
    "new-task": "Ctrl+Alt+N",
    "quick-note": "Ctrl+Alt+Q",
    "toggle-palette": "Ctrl+Alt+K",
    "toggle-dock": "Ctrl+Alt+I",
    "open-dock-panel": "Ctrl+Alt+O"
  };

  it("旧的 9 键配置缺失新动作时补默认：reset-state 得 Ctrl+Alt+Shift+F1，toggle 保持未绑定", () => {
    const out = sanitizeSettings({ shortcuts: LEGACY_NINE }).shortcuts!;
    expect(out["taskbar:reset-state"]).toBe("Ctrl+Alt+Shift+F1");
    expect(out["taskbar:toggle"]).toBe("");
    for (const [k, v] of Object.entries(LEGACY_NINE)) expect(out[k as keyof typeof out]).toBe(v);
    expect(Object.keys(out).sort()).toEqual([...SHORTCUT_ACTIONS].sort());
    expect(out).toEqual({ ...DEFAULT_SHORTCUTS, ...LEGACY_NINE });
  });

  it("用户录制的 taskbar:toggle 组合保留；空串 / 无修饰键回到未绑定；有默认键的动作留空回默认", () => {
    expect(
      sanitizeSettings({ shortcuts: { ...LEGACY_NINE, "taskbar:toggle": "Ctrl+Alt+T" } }).shortcuts!["taskbar:toggle"]
    ).toBe("Ctrl+Alt+T");
    expect(sanitizeSettings({ shortcuts: { "taskbar:toggle": "" } }).shortcuts!["taskbar:toggle"]).toBe("");
    expect(sanitizeSettings({ shortcuts: { "taskbar:toggle": "T" } }).shortcuts!["taskbar:toggle"]).toBe("");
    expect(sanitizeSettings({ shortcuts: { "taskbar:reset-state": "" } }).shortcuts!["taskbar:reset-state"]).toBe(
      "Ctrl+Alt+Shift+F1"
    );
    expect(
      sanitizeSettings({ shortcuts: { "taskbar:reset-state": "Ctrl+Shift+F12" } }).shortcuts!["taskbar:reset-state"]
    ).toBe("Ctrl+Shift+F12");
    // 空对象 / 非对象快照 → 整表默认（含两项新动作）。
    expect(sanitizeSettings({ shortcuts: {} }).shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(sanitizeSettings({ shortcuts: 42 }).shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });

  it("冲突回退默认时默认已被占用 → 置未绑定，整表绝不出现两个动作同键", () => {
    // toggle-pomodoro 抢了 toggle-layer 的默认 Ctrl+Alt+D；toggle-layer 的候选
    // （也是 Ctrl+Alt+D）冲突 → 回退默认仍冲突 → 必须置空而非保留重复键。
    const out = sanitizeSettings({ shortcuts: { ...LEGACY_NINE, "toggle-pomodoro": "Ctrl+Alt+D" } }).shortcuts!;
    expect(out["toggle-pomodoro"]).toBe("Ctrl+Alt+D");
    expect(out["toggle-layer"]).toBe("");
    const bound = Object.values(out).filter((v) => v !== "");
    expect(new Set(bound).size).toBe(bound.length);
  });

  it("setShortcut 落盘快照含新动作键（ShortcutConfigSync 整表下发 Rust 的数据源）", () => {
    const store = useSettingsStore.getState();
    store.setShortcut("taskbar:toggle", "Ctrl+Alt+T");
    const raw = JSON.parse(localStorage.getItem("focus-desk.settings.v1") ?? "{}");
    expect(raw.shortcuts["taskbar:toggle"]).toBe("Ctrl+Alt+T");
    expect(raw.shortcuts["taskbar:reset-state"]).toBe("Ctrl+Alt+Shift+F1");
    // 「恢复默认」= 回到未绑定并落盘为空串（Rust parse_config 对无默认键动作接受空串）。
    store.setShortcut("taskbar:toggle", DEFAULT_SHORTCUTS["taskbar:toggle"]);
    expect(useSettingsStore.getState().shortcuts["taskbar:toggle"]).toBe("");
    expect(JSON.parse(localStorage.getItem("focus-desk.settings.v1") ?? "{}").shortcuts["taskbar:toggle"]).toBe("");
  });
});
