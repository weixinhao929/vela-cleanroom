/**
 * [TB-CORE] 任务栏自定义线协议（从 settings-store 下沉）：类型族、
 * 出厂默认与防御上限。字段名即线协议——Rust 侧 taskbar/mod.rs CONFIG 区
 * serde 同构（camelCase），apply_taskbar_config 整包下发 + 设置镜像
 * `general.taskbar` 由 parse_taskbar_config 读取；改名必须两侧同步。
 * 归一语义（坏值回默认 / 颜色 #rrggbbaa / 半径 0–750 越界回默认 / 规则
 * 坏项丢弃 / 空 pattern 恒不匹配）与 Rust 逐条一致（normalize 函数仍在
 * settings-store——它们属设置清洗机制并共享其原子助手）。
 */

/** accent 五值（§1.1）：normal = 恢复系统默认外观。 */
export type TaskbarAccent = "normal" | "opaque" | "clear" | "blur" | "acrylic";

export type TaskbarAppearance = {
  accent: TaskbarAccent;
  /** 统一 `#rrggbbaa` 小写存储；3/4/6 位输入在 normalize 时归一。 */
  color: string;
  /** 显示桌面按钮（XAML 任务栏能力不可用时 UI 隐藏，值保留）。 */
  showPeek: boolean;
  /** 任务栏顶部 1px 分隔线。 */
  showLine: boolean;
  /** blur 高斯半径 0–750（仅 accent=blur 用）。 */
  blurRadius: number;
};

/** 单态配置：desktop 无 enabled（恒启用），其余六态带开关。 */
export type TaskbarStateAppearance = TaskbarAppearance & { enabled?: boolean };

/** 规则匹配类型：class 精确 / process 文件名大小写不敏感精确 / title 子串。 */
export type TaskbarMatchType = "class" | "title" | "process";

export type TaskbarRule = {
  id: string;
  matchType: TaskbarMatchType;
  pattern: string;
  appearance: TaskbarAppearance;
  /** 命中窗口非前台时用的外观（缺省沿用 appearance）。 */
  inactiveAppearance?: TaskbarAppearance;
};

export type TaskbarStateKey =
  "desktop" | "visibleWindow" | "maximizedWindow" | "startOpened" | "searchOpened" | "taskViewOpened" | "batterySaver";

/** 七态键，按求值优先级的反序（UI 自上而下 = 桌面 → 省电，与 Rust ALL 同序）。 */
export const TASKBAR_STATE_KEYS: readonly TaskbarStateKey[] = [
  "desktop",
  "visibleWindow",
  "maximizedWindow",
  "startOpened",
  "searchOpened",
  "taskViewOpened",
  "batterySaver"
];

export type TaskbarRules = { visibleWindow: TaskbarRule[]; maximizedWindow: TaskbarRule[] };
export type TaskbarIgnoredWindows = { classes: string[]; titles: string[]; processes: string[] };

export type TaskbarSettings = {
  /** 总开关（默认关）。 */
  enabled: boolean;
  states: Record<TaskbarStateKey, TaskbarStateAppearance>;
  rules: TaskbarRules;
  /** 命中即不参与可见/最大化判定；出厂含 Vela 自身。 */
  ignoredWindows: TaskbarIgnoredWindows;
  /** 逐显示器独立配置。 */
  perMonitor: boolean;
  /** 显示器稳定槽位 → 顶层字段覆盖（整体替换，不深合并；）。 */
  monitorOverrides: Record<string, Partial<TaskbarSettings>>;
};

/** 防御上限（与 Rust MAX_* 常量同值）。 */
export const TASKBAR_MAX_RULES_PER_STATE = 64;
export const TASKBAR_MAX_IGNORED_PER_KIND = 200;
export const TASKBAR_MAX_MONITOR_OVERRIDES = 16;

export const TASKBAR_ACCENTS: readonly TaskbarAccent[] = ["normal", "opaque", "clear", "blur", "acrylic"];
export const TASKBAR_MATCH_TYPES: readonly TaskbarMatchType[] = ["class", "title", "process"];

export const DEFAULT_TASKBAR_APPEARANCE: TaskbarAppearance = {
  accent: "clear",
  color: "#00000000",
  showPeek: false,
  showLine: false,
  blurRadius: 30
};

function taskbarAppearance(accent: TaskbarAccent, showPeek: boolean, showLine: boolean): TaskbarAppearance {
  return { accent, color: "#00000000", showPeek, showLine, blurRadius: 30 };
}

/** 七态出厂默认（需求 §1.1 表 / 标杆 config.hpp:40-46；taskView 默认关，
 *  见需求 §7 开放问题 1 建议）。与 Rust default_states() 逐字段一致。 */
export function defaultTaskbarStates(): Record<TaskbarStateKey, TaskbarStateAppearance> {
  return {
    desktop: taskbarAppearance("clear", false, false),
    visibleWindow: { ...taskbarAppearance("clear", true, false), enabled: false },
    maximizedWindow: { ...taskbarAppearance("acrylic", true, true), enabled: false },
    startOpened: { ...taskbarAppearance("normal", true, true), enabled: false },
    searchOpened: { ...taskbarAppearance("normal", true, true), enabled: false },
    taskViewOpened: { ...taskbarAppearance("normal", false, true), enabled: false },
    batterySaver: { ...taskbarAppearance("opaque", true, false), enabled: false }
  };
}

/** 出厂忽略列表含 Vela 自身——`Tauri Window` 是 tauri-runtime-wry 给全部
 *  窗口的注册类名（设置窗 + widget 窗），`Vela.exe` 发布版 / `focus-desk.exe`
 *  开发版进程名。与 Rust default_ignored_windows() 一致。 */
export function defaultTaskbarIgnoredWindows(): TaskbarIgnoredWindows {
  return { classes: ["Tauri Window"], titles: [], processes: ["Vela.exe", "focus-desk.exe"] };
}

/** 每次调用返回全新对象（嵌套结构不能靠 spread 浅拷贝共享）。 */
export function defaultTaskbarSettings(): TaskbarSettings {
  return {
    enabled: false,
    states: defaultTaskbarStates(),
    rules: { visibleWindow: [], maximizedWindow: [] },
    ignoredWindows: defaultTaskbarIgnoredWindows(),
    perMonitor: false,
    monitorOverrides: {}
  };
}

export const DEFAULT_TASKBAR: TaskbarSettings = defaultTaskbarSettings();
