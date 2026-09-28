import { create } from "zustand";
import { applySettings, PRESETS, resolveEffectiveTokens, FX_EFFECT_IDS } from "../lib/theme-engine";
import type { ThemeExtra, FxEffectId } from "../lib/theme-engine";
import { withRemoteApply } from "../lib/sync-gate";
import { DEFAULT_CUSTOM_EASE, sanitizeBezier, type BezierPoints } from "../lib/bezier";
import { normalizeAutomationRules, type AutomationRule } from "../domain/automation";
import type { VirtualMidnightHour } from "../domain/analytics";
import type { EventSoundId, TickSoundId } from "../lib/chimes";
import {
  DEFAULT_APP_SHORTCUTS,
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_UNBOUND,
  hasModifier,
  normalizeAccelerator,
  normalizeAppShortcuts,
  type AppShortcutConfig,
  type AppShortcutId,
  type ShortcutAction,
  type ShortcutConfig
} from "../lib/shortcuts";
import { reportPersistError } from "../lib/persist-error";

/**
 * 设置 store（zustand + subscribeWithSelector）。
 *
 * 职责：外观（2 主题预设 × 明暗模式/主色/圆角/模糊/缩放/字体）、通用行为、动效
 * 环境、通知来源、专注模式等全部用户偏好的唯一事实来源。任何变更经
 * sanitize → applySettings（写 CSS 变量/data-*）→ 350ms 防抖双后端落盘
 * （localStorage + SQLite 镜像）；跨窗口由 cross-window.ts 订阅广播。
 * 持久化闸门挂起期间跳过落盘（恢复备份 ack 协议）。
 */

export {
  applySettings,
  cancelDeferNextThemeApply,
  deferNextThemeApply,
  PRESETS,
  PRESET_NAMES,
  FX_EFFECT_IDS
} from "../lib/theme-engine";
export type { PresetTokens, FxEffectId } from "../lib/theme-engine";

/**
 * 从完整设置态提取主题引擎所需的动效环境。
 * 调用点显式传参，主题引擎不再反读全局 store（依赖注入，便于测试）。
 *
 * @param s - 设置态的 extra/general 切片。
 * @returns {@link ThemeExtra} 快照。O(1)。
 */
export function themeEnvOf(s: Pick<SettingsState, "extra" | "general">): ThemeExtra {
  return {
    enableAnimations: s.extra.enableAnimations,
    animationMode: s.extra.animationMode,
    animationDuration: s.extra.animationDuration,
    animationSpeed: s.extra.animationSpeed,
    fxToggles: s.extra.fxToggles,
    widgetEntrance: s.extra.widgetEntrance,
    viewTransition: s.extra.viewTransition,
    customEase: s.extra.customEase,
    customEaseEnabled: s.extra.customEaseEnabled
  };
}

/**
 * §4.4 用当前设置态重新跑一遍主题引擎（壁纸派生 token 注入 / 更新后调用）。
 * 设置本身没变，故不落盘、不广播；纯 CSS 变量重写，幂等。
 */
export function reapplyTheme(): void {
  const st = useSettingsStore.getState();
  applySettings(st, themeEnvOf(st), st.general.reduceEffects);
}
import { subscribeWithSelector } from "zustand/middleware";
import { isTauri } from "../lib/tauri";
import { isPersistSuspended } from "../lib/persist-gate";
import { sqliteRepo } from "../lib/persistence/sqlite";
import { pushAppToast } from "../components/ToastHost";
import { t } from "../i18n-lite";

/** P2（审计修复）：设置落盘配额错误的首报锁存（成功后复位，见 saveSettings）。 */
let quotaToastShown = false;

const SETTINGS_KEY = "focus-desk.settings.v1";
/** SQLite mirror key for the same settings snapshot. */
const SETTINGS_DB_KEY = "app:settings:v1";

export type ThemePreset = "default" | "retro" | "custom";
export type ThemeMode = "system" | "dark" | "light";

/** 自定义主题的单档配色：底色 + 文字色（其余 token 由引擎派生）。 */
export interface CustomThemePair {
  bg: string;
  ink: string;
}
/** 自定义主题的深 / 浅两档配色。 */
export interface CustomThemeColors {
  dark: CustomThemePair;
  light: CustomThemePair;
}

/**
 * 旧版预设 → 现主题的迁移表：午夜 / 日光 / 玻璃 → 默认（暗档取午夜、
 * 亮档取日光），终端 / 纸张 → retro（显示名「终端」：暗档荧光终端、亮档暖纸陶土）。
 * 旧快照 / DB 镜像里的 preset 字段在 sanitize 时无损映射，主色与玻璃色保留。
 * （自定义已重新成为一等预设：preset = "custom" 直接命中 PRESETS，不再迁移。）
 */
const PRESET_MIGRATION: Record<string, ThemePreset> = {
  default: "default",
  midnight: "default",
  daylight: "default",
  glass: "default",
  retro: "retro",
  terminal: "retro",
  paper: "retro"
};

/** 壁纸「最近使用」缓存条数（对齐 Windows 个性化背景的 5 张最近图像）。 */
export const RECENT_WALLPAPERS_MAX = 5;

/** 自定义主题的出厂配色（取 PRESETS.custom 种子色板；用户改色后存 customColors）。 */
export const DEFAULT_CUSTOM_COLORS: CustomThemeColors = {
  dark: { bg: PRESETS.custom.dark.bg, ink: PRESETS.custom.dark.ink },
  light: { bg: PRESETS.custom.light.bg, ink: PRESETS.custom.light.ink }
};

/** 合法 hex 颜色（ColorRow 的 input type=color 产出 #rrggbb）。 */
const isHexColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** 自定义主题配色清洗：非 hex 字段回退出厂值，形状缺省补齐。 */
function sanitizeCustomColors(v: unknown): CustomThemeColors {
  const pair = (p: unknown, fb: CustomThemePair): CustomThemePair => {
    const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
    return {
      bg: isHexColor(o.bg) ? o.bg : fb.bg,
      ink: isHexColor(o.ink) ? o.ink : fb.ink
    };
  };
  const c = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  return {
    dark: pair(c.dark, DEFAULT_CUSTOM_COLORS.dark),
    light: pair(c.light, DEFAULT_CUSTOM_COLORS.light)
  };
}

/** §4.10 剪贴板历史隐私开关（GeneralPage 隐私区）。Rust 监听线程每次捕获前
 *  从 SQLite 镜像 `app:settings:v1` 读 `general.clipboard`，因此字段名即
 *  线协议：改名必须同步 clipboard.rs 的 parse_clip_config。 */
export type ClipboardPrivacySettings = {
  /** 总开关：关闭后不再记录任何剪贴板内容（已有历史保留，可手动清空）。 */
  enabled: boolean;
  /** 记录图片（截图等）：转存本地 clip 目录；关闭后只记文本。 */
  captureImages: boolean;
  /** [FILES]（ZTools 借鉴 #8）记录文件复制（CF_HDROP，默认开）。 */
  captureFiles: boolean;
  /** 记录复制时的来源进程名（默认关，隐私保守项）。 */
  recordSource: boolean;
  /** 一.4 复制纯链接时在灵动岛弹「链接快开」接管条（Rust parse_clip_config
   *  同名字段 linkPopup，默认开）。 */
  linkPopup: boolean;
};

export const DEFAULT_CLIPBOARD_PRIVACY: ClipboardPrivacySettings = {
  enabled: true,
  captureImages: true,
  captureFiles: true,
  recordSource: false,
  linkPopup: true
};

/* ------------------------------------------------------------------ *
 * [TB-CORE] 任务栏自定义切片（需求 §4 数据模型）。字段名即线协议：Rust 侧
 * taskbar/mod.rs CONFIG 区 serde 同构（camelCase），apply_taskbar_config
 * 整包下发 + 设置镜像 `general.taskbar` 由 parse_taskbar_config 读取；
 * 改名必须两侧同步。归一语义（坏值回默认 / 颜色 #rrggbbaa / 半径 0–750
 * 越界回默认 / 规则坏项丢弃 / 空 pattern 恒不匹配）与 Rust 逐条一致。
 * ------------------------------------------------------------------ */

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
  /** 总开关（D1：默认关，F-1）。 */
  enabled: boolean;
  states: Record<TaskbarStateKey, TaskbarStateAppearance>;
  rules: TaskbarRules;
  /** 命中即不参与可见/最大化判定（F-5）；出厂含 Vela 自身。 */
  ignoredWindows: TaskbarIgnoredWindows;
  /** 逐显示器独立配置（P2，F-6）。 */
  perMonitor: boolean;
  /** 显示器稳定槽位 → 顶层字段覆盖（整体替换，不深合并；P2）。 */
  monitorOverrides: Record<string, Partial<TaskbarSettings>>;
};

/** 防御上限（与 Rust MAX_* 常量同值）。 */
export const TASKBAR_MAX_RULES_PER_STATE = 64;
export const TASKBAR_MAX_IGNORED_PER_KIND = 200;
export const TASKBAR_MAX_MONITOR_OVERRIDES = 16;

export const TASKBAR_ACCENTS: readonly TaskbarAccent[] = ["normal", "opaque", "clear", "blur", "acrylic"];
const TASKBAR_MATCH_TYPES: readonly TaskbarMatchType[] = ["class", "title", "process"];

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

/** D2：七态出厂默认（需求 §1.1 表 / 标杆 config.hpp:40-46；taskView 默认关，
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

/** D3：出厂忽略列表含 Vela 自身——`Tauri Window` 是 tauri-runtime-wry 给全部
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

export type GeneralSettings = {
  language: string;
  launchOnStartup: boolean;
  showDesktopIcons: boolean;
  pauseDuringGaming: boolean;
  /** DeskOrder 借鉴 #6：双击空白桌面切换小组件层显隐（默认开）。 */
  desktopDoubleClick: boolean;
  /** §4.6 空闲打断：无键鼠输入 ≥5 分钟自动暂停专注，回来自动恢复（默认保守关闭）。 */
  pauseWhenIdle: boolean;
  reduceEffects: boolean;
  /** §4.10 剪贴板历史隐私开关。 */
  clipboard: ClipboardPrivacySettings;
  /** [TB-CORE] 任务栏自定义（线协议同构 Rust taskbar/mod.rs）。 */
  taskbar: TaskbarSettings;
  /** W-131 媒体监控行为（正在播放/SMTC watcher；变更单向推送到 Rust）。 */
  media: MediaBehaviorSettings;
  /** [SUPER-PANEL]（ZTools 借鉴 #11）长按右键取词面板（默认关；字段名即线协议，
   *  Rust super_panel.rs 从设置镜像读取，改名需同步）。 */
  superPanel: { enabled: boolean; durationMs: number };
  /** [DOUBLE-TAP]（ZTools 借鉴 #13）双击修饰键呼出面板（默认关；Rust double_tap.rs
   *  读镜像）。 */
  doubleTapSummon: { enabled: boolean; key: "ctrl" | "alt" };
  /** [WAKE-BL]（ZTools 借鉴 #14）唤醒类热键黑名单（exe 文件名，大小写不敏感；
   *  Rust shortcuts.rs dispatch 读镜像，2s TTL）。 */
  hotkeyBlacklist: string[];
};

/** W-131 媒体监控行为偏好：独占播放 + 会话黑名单（同类媒体浮窗对齐）。
 *  focusPause（FocusTimer MPRIS 借鉴）由前端联动引擎消费，不推送 Rust。 */
export type MediaBehaviorSettings = {
  /** 某播放源开播时自动暂停其余在播播放源（后来者胜）。 */
  pauseOthers: boolean;
  /** 会话黑名单（AUMID 精确匹配）：不参与自动选择、选择器里进「已隐藏」区。 */
  blockedSessions: string[];
  /** FocusTimer 借鉴：专注段自动暂停在播媒体、结束/休息时智能恢复。 */
  focusPause: boolean;
};

export type AnimationSpeed = "slow" | "normal" | "fast";
/** 动效强度：增强（粒子/流光特效）/ 标准 / 减少动态。 */
export type AnimationMode = "enhanced" | "standard" | "reduced";
/** How widgets animate in when they are added / a view loads. */
export type WidgetEntrance = "fade" | "scale" | "none";
/** How the canvas animates when switching between Home / Work / Focus. */
export type ViewTransition = "slide" | "fade" | "none";

/** 清洗特效开关表：只保留已知 id 的布尔值，其余丢弃（防脏数据膨胀）。 */
function normalizeFxToggles(v: unknown): Partial<Record<FxEffectId, boolean>> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const src = v as Record<string, unknown>;
  const out: Partial<Record<FxEffectId, boolean>> = {};
  for (const id of FX_EFFECT_IDS) {
    if (typeof src[id] === "boolean") out[id] = src[id] as boolean;
  }
  return out;
}

/** 专注沉浸模式强度（I5）：off=无 / light=番茄钟卡片沉浸（当前行为）/
 *  medium=隐藏其他小组件 / deep=隐藏+锁定交互。 */
export type FocusMode = "off" | "light" | "medium" | "deep";

/** Appearance-independent animation & connection settings. */
/** 天气附加城市。 */
export type WeatherCity = { name: string; lat: number; lon: number };

export type ExtraSettings = {
  enableAnimations: boolean;
  animationSpeed: AnimationSpeed;
  animationMode: AnimationMode;
  /** Fine-grained animation duration multiplier in percent (50–200). */
  animationDuration: number;
  /** 各特效独立开关（缺省 = 开启；只存显式覆盖项）。 */
  fxToggles: Partial<Record<FxEffectId, boolean>>;
  widgetEntrance: WidgetEntrance;
  viewTransition: ViewTransition;
  /** B3 自定义缓动曲线控制点（始终为合法曲线，见 lib/bezier sanitizeBezier）。 */
  customEase: BezierPoints;
  /** 是否让小组件入场 / 预览卡改走自定义曲线（--ease-entrance → --ease-custom）。 */
  customEaseEnabled: boolean;
  focusMode: FocusMode;
  weatherCity: string;
  weatherLat: number;
  weatherLon: number;
  /** 附加天气城市（主城市之外可切换的城市列表）。 */
  weatherCities: WeatherCity[];
  /** §4.7 天气 IP 自动定位（ipwho.is，城市级）。默认关：隐私 opt-in，开启后才会发请求。 */
  weatherAutoLocate: boolean;
  networkTimeout: number;
  /** W-167 网速显示：按 bit 计（bps/Kbps/Mbps，经典网速工具 B/b 切换）。 */
  netRateBits: boolean;
  /** W-167 网速显示：简洁模式（1.2M/s，单位紧跟数字）。 */
  netRateCompact: boolean;
  /** W-167 网速显示：隐藏单位（仅数字）。 */
  netRateHideUnit: boolean;
  /** W-167 网速显示：上下行交换（↑在前）。 */
  netSwapUpDown: boolean;
  /** W-170 网速阈值告警（收发合计超阈值时系统通知，滞回防抖）。 */
  netSpeedAlert: boolean;
  /** W-170 网速告警阈值（Mbps）。 */
  netSpeedAlertMbps: number;
  /** W-170 日流量阈值告警（当日收发合计超阈值通知一次）。 */
  netTrafficAlert: boolean;
  /** W-170 日流量告警阈值（GB）。 */
  netTrafficAlertGB: number;
  /** A2 空闲淡化：presence Idle ≥60s 时给 widget 窗口
   *  根元素挂 .idle-dim 类，CSS 统一降低卡片透明度（一次类翻转，非逐卡订阅）。 */
  idleDim: boolean;
  /** P2 空闲降玻璃：presence Idle ≥60s 时挂 data-no-glass 总闸（theme-engine
   *  同款全局关闭 backdrop-filter），人不在桌面时 GPU 不再为毛玻璃保留合成
   *  纹理；恢复 active 由 reapplyTheme 重放归位。 */
  idleGlassOff: boolean;
  /** 首次启动引导是否已完成（完成/跳过均置 true；常规页「新手引导」可重置
   *  重看）。设置窗首启自动弹出由 Rust 侧 boot 哨兵键独立控制——那边管
   *  「弹窗」，这边管「引导层」。 */
  onboarded: boolean;
  /** Root folder the file-browser widget browses (empty = Desktop). */
  fileBrowserRoot: string;
  /** W-093 小组件回收站保留天数（7–90，默认 30），到期自动清除。 */
  recycleRetentionDays: number;
  /** 更新源 JSON 地址（空 = 不检查更新）。JSON: { version, notes, url }。 */
  updateEndpoint: string;
  /** DeskOrder 借鉴 #9：GitHub 兜底直链用的安装包文件名（固定名，不带版本）。 */
  updateArtifact: string;
  /** 打开更新页时自动检查更新。 */
  autoCheckUpdates: boolean;
  /** BentoDesk 借鉴 #10：定时检查间隔（小时；24 每日 / 168 每周 / 0 仅手动）。 */
  updateCheckIntervalHours: number;
  /** 上次后台/前台检查的时间戳（ms，0 = 从未）。 */
  updateLastCheckAt: number;
  /** 用户明确跳过的版本（空 = 无；命中则不再提示该版本）。 */
  updateSkipVersion: string;
  /** [UPD-CH]（借鉴 CSH #6）更新通道（stable / insider）。 */
  updateChannel: string;
  /** 用户是否亲手选过通道：false 时通道跟随构建（版本含 -insider 即 Insider）。 */
  updateChannelSetByUser: boolean;
  /** [GALLERY]（借鉴 CSH #9）在线预设画廊源（GitHub 仓库或 manifest 直链，空 = 未配置）。 */
  presetGallerySource: string;
  /** 累计专注统计的起始日期（YYYY-MM-DD），null = 从最早记录起。 */
  analyticsStartDate: string | null;
  /** FocusTimer 借鉴：专注自动化规则（事件/条件触发 → 白名单动作）。 */
  pomodoroAutomation: AutomationRule[];
  /** FocusTimer 借鉴：统计虚拟午夜（0/2/4 点——熬夜的「今天」延续到凌晨）。
   *  Rust 聚合与前端内存口径共用此值。 */
  virtualMidnightHour: VirtualMidnightHour;
};

/** 清洗快捷键表：只留 SHORTCUT_ACTIONS 里的已知动作（含 [HOTKEY] toggle-palette 与
 *  [ISLAND-LINK] toggle-dock / open-dock-panel；旧快照缺键的动作回 DEFAULT_SHORTCUTS，
 *  升级后自动获得 Ctrl+Alt+I / Ctrl+Alt+O 默认值）；逐条要求非空 + 至少一个修饰键 +
 *  互不冲突（等价写法按归一化比较，先到先得），非法/冲突项回退默认值。
 *  默认值之间互不冲突（shortcuts.rs 有同款单测），因此正常数据不会被改写。 */
function normalizeShortcuts(v: unknown): ShortcutConfig {
  const src = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: ShortcutConfig = { ...DEFAULT_SHORTCUTS };
  const taken = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const raw = typeof src[action] === "string" ? (src[action] as string).trim() : "";
    const candidate = raw && hasModifier(raw) ? raw : DEFAULT_SHORTCUTS[action];
    const norm = normalizeAccelerator(candidate);
    if (norm && !taken.has(norm)) {
      out[action] = candidate;
      taken.add(norm);
      continue;
    }
    // 候选冲突（用户/导入/远端载荷把别的动作改成了本动作的默认值，绕过了
    // 录制器查重）：回退默认前必须再查重——默认也已被前面的动作占用时置为
    // 未绑定，否则两个动作同键，整表下发 Rust 会注册重复热键。
    const def = DEFAULT_SHORTCUTS[action];
    const defNorm = normalizeAccelerator(def);
    if (defNorm && !taken.has(defNorm)) {
      out[action] = def;
      taken.add(defNorm);
    } else {
      out[action] = SHORTCUT_UNBOUND;
    }
  }
  return out;
}

/** 业务通知来源（F-来源门控）：小组件直连通知的逐源开关键，与
 *  lib/notifications 的 sourceNotify/sourceEnabled 配套。 */
export type NotificationSource =
  "habit" | "calendar" | "timetable" | "countdown" | "email" | "weather" | "bluetooth" | "note" | "app";

export const DEFAULT_NOTIFICATION_SOURCES: Record<NotificationSource, boolean> = {
  habit: true,
  calendar: true,
  timetable: true,
  countdown: true,
  email: true,
  weather: true,
  bluetooth: true,
  note: true,
  app: true
};

/** Notification-area preferences for the pomodoro and todo widgets. */
export type NotificationSettings = {
  pomodoroEnabled: boolean;
  pomodoroSound: boolean;
  pomodoroToast: boolean;
  pomodoroModeSwitch: boolean;
  /** FocusTimer 借鉴：事件级音效。专注/休息结束各配独立音色与音量；
   *  tick 为专注进行中的循环滴答（挂钟/节拍器），默认关。 */
  pomodoroFocusEndSound: EventSoundId;
  pomodoroFocusEndVolume: number;
  pomodoroBreakEndSound: EventSoundId;
  pomodoroBreakEndVolume: number;
  pomodoroTickSound: TickSoundId;
  pomodoroTickVolume: number;
  todoEnabled: boolean;
  todoSound: boolean;
  todoToast: boolean;
  todoOverdue: boolean;
  /** F-通知来源门控：小组件直连通知逐源开关（缺省 true，向后兼容）。 */
  sources: Record<NotificationSource, boolean>;
  /** 一.1 系统 Toast 监听（Rust sysnotify.rs 同名字段，线协议）：开启后其它
   *  应用的通知镜像进通知历史 + 灵动岛接管。默认开（NPS 同款；首次授权弹窗
   *  由系统在 RequestAccessAsync 时给出）。 */
  systemListener: boolean;
  /** 一.3 本地 HTTP 推送入口（push_server.rs 同名字段）：默认关，开启后监听
   *  127.0.0.1:pushPort 的 POST /api/notify。 */
  pushEnabled: boolean;
  /** 推送端口（1–65535，默认 47310，避开 NPS 常用的 47300）。 */
  pushPort: number;
};

export const DEFAULT_PUSH_PORT = 47310;

/** pushPort 的钳制口径（与 Rust sanitize_port 一致）。 */
export function normalizePushPort(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 65535 ? Math.floor(v) : DEFAULT_PUSH_PORT;
}

export type SettingsState = {
  preset: ThemePreset;
  themeMode: ThemeMode;
  /** [SPLIT-THEME]（借鉴 CSH #13）浮窗（设置窗 / 速记窗）独立明暗档：
   *  follow = 跟随全局；light / dark = 以该档重放主题引擎（仅本窗口）。 */
  floatingThemeMode: "follow" | "light" | "dark";
  primaryColor: string;
  /** 自定义主题（preset = "custom"）的深 / 浅两档底色与文字色，其余 token 引擎派生。 */
  customColors: CustomThemeColors;
  zoom: number;
  font: string;
  fontSize: number;
  widgetBackground: string;
  widgetOpacity: number;
  cornerRadius: number;
  spacing: number;
  blur: number;
  /** 设置大窗口自身的不透明度（默认 100 完全实心，降低可看到桌面背景）。 */
  settingsWindowOpacity: number;
  /** 壁纸挑选文件夹（样式页「壁纸」区从中列出图片；空 = 未选择）。 */
  wallpaperFolder: string;
  /** 最近应用过的桌面壁纸路径（最新在前，最多 RECENT_WALLPAPERS_MAX 条）。 */
  recentWallpapers: string[];
  settingsOpen: boolean;
  /** The settings sub-page to open (e.g. "widget-config-<id>"). Defaults to "style". */
  settingsPage: string;
  general: GeneralSettings;
  extra: ExtraSettings;
  notifications: NotificationSettings;
  /** §4.5 全局快捷键（动作 → 组合键字符串，见 lib/shortcuts.ts）。 */
  shortcuts: ShortcutConfig;
  /** 应用内快捷键（窗口 keydown：切视图 / 命令面板 / 设置搜索 / 退出编辑），有无 + 键位皆可配。 */
  appShortcuts: AppShortcutConfig;
  setPreset(p: ThemePreset): void;
  setThemeMode(m: ThemeMode): void;
  setFloatingThemeMode(m: "follow" | "light" | "dark"): void;
  /** 更新自定义主题配色（深 / 浅档局部 patch，浅合并）。 */
  setCustomColors(patch: { dark?: Partial<CustomThemePair>; light?: Partial<CustomThemePair> }): void;
  /** 记录壁纸挑选文件夹（空串清除）。 */
  setWallpaperFolder(path: string): void;
  /** 应用壁纸成功后登记「最近使用」：去重置顶，超出上限裁剪。 */
  pushRecentWallpaper(path: string): void;
  setPrimaryColor(c: string): void;
  setZoom(z: number): void;
  setFont(f: string): void;
  setFontSize(s: number): void;
  setWidgetBackground(c: string): void;
  setWidgetOpacity(o: number): void;
  setCornerRadius(v: number): void;
  setSpacing(v: number): void;
  setBlur(v: number): void;
  setSettingsWindowOpacity(o: number): void;
  setSettingsOpen(open: boolean): void;
  setSettingsPage(page: string): void;
  setGeneral(patch: Partial<GeneralSettings>): void;
  /** [TB-UI] 任务栏切片 patch：顶层字段浅合并 → sanitize → 350ms 尾随防抖落盘
   *  （外观编辑器的透明度 / 半径滑条高频触发，与 setExtraDebounced 同策略）。 */
  setTaskbar(patch: Partial<TaskbarSettings>): void;
  /** [TB-MONITOR] F-6：只写 `general.taskbar.monitorOverrides[slot]`（见
   *  withTaskbarOverride；null 删除该槽位覆盖），同 setTaskbar 的 sanitize + 防抖落盘。 */
  setTaskbarOverride(slot: string, patch: TaskbarOverridePatch | null): void;
  setExtra(patch: Partial<ExtraSettings>): void;
  setExtraDebounced(patch: Partial<ExtraSettings>): void;
  setNotifications(patch: Partial<NotificationSettings>): void;
  /** §4.5 录制单个动作的新组合（已过查重/修饰键门槛），落盘并同步。 */
  setShortcut(action: ShortcutAction, accel: string): void;
  /** §4.5 批量替换（导入设置用）。 */
  setShortcuts(patch: Partial<ShortcutConfig>): void;
  /** 应用内快捷键：enabled / accel 逐条 patch，落盘（不经 Rust 注册）。 */
  setAppShortcut(id: AppShortcutId, patch: Partial<AppShortcutConfig[AppShortcutId]>): void;
  resetPrimaryColor(): void;
  resetWidgetBackground(): void;
};

function loadSettings(): Partial<SettingsState> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return sanitizeSettings(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** Coerce a number field to a finite number within [min,max], else fallback.
 *  Out-of-range values fall back to the default (not clamped) so genuinely
 *  corrupt data resets instead of pinning to an arbitrary boundary value. */
function numOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n >= min && n <= max ? n : fallback;
}

/** Coerce a boolean-ish field to a real boolean, else fallback. */
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Coerce to a string, else fallback. */
function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Coerce a number|string to a raw number if finite, else fallback. */
function numOrNull(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 清洗剪贴板隐私开关：逐项布尔归一，缺失 / 类型错回默认（开/开/关）。 */
function normalizeClipboardPrivacy(v: unknown): ClipboardPrivacySettings {
  const src = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    enabled: boolOr(src.enabled, DEFAULT_CLIPBOARD_PRIVACY.enabled),
    captureImages: boolOr(src.captureImages, DEFAULT_CLIPBOARD_PRIVACY.captureImages),
    captureFiles: boolOr(src.captureFiles, DEFAULT_CLIPBOARD_PRIVACY.captureFiles),
    recordSource: boolOr(src.recordSource, DEFAULT_CLIPBOARD_PRIVACY.recordSource),
    linkPopup: boolOr(src.linkPopup, DEFAULT_CLIPBOARD_PRIVACY.linkPopup)
  };
}

/** [SUPER-PANEL]（ZTools #11）清洗：布尔归一 + 时长真钳制到 300–1000
 *  （与 Rust clamp_duration_ms 同语义：越界钳到边界而非回默认）。 */
function normalizeSuperPanel(v: unknown): { enabled: boolean; durationMs: number } {
  const src = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const raw = typeof src.durationMs === "number" && Number.isFinite(src.durationMs) ? src.durationMs : 500;
  return {
    enabled: boolOr(src.enabled, false),
    durationMs: Math.min(1000, Math.max(300, Math.round(raw)))
  };
}

/** [DOUBLE-TAP]（ZTools #13）清洗：布尔归一 + 键族白名单（坏值回 ctrl）。 */
function normalizeDoubleTap(v: unknown): { enabled: boolean; key: "ctrl" | "alt" } {
  const src = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    enabled: boolOr(src.enabled, false),
    key: src.key === "alt" ? "alt" : "ctrl"
  };
}

/** [WAKE-BL]（ZTools #14）清洗：非空字符串去重（trim，上限 64 项）。 */
function normalizeBlacklist(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v as unknown[]) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 64) break;
  }
  return out;
}

/** W-131 清洗媒体监控行为：布尔归一 + 黑名单去非空字符串（AUMID 精确匹配用）。 */
function normalizeMediaBehavior(v: unknown): MediaBehaviorSettings {
  const src = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    pauseOthers: boolOr(src.pauseOthers, false),
    blockedSessions: Array.isArray(src.blockedSessions)
      ? (src.blockedSessions as unknown[]).filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : [],
    focusPause: boolOr(src.focusPause, false)
  };
}

/** FocusTimer 借鉴：事件级音效字段清洗（音色白名单 + 音量 0–100）。 */
const EVENT_SOUND_IDS: readonly EventSoundId[] = ["soft", "bell", "digital", "marimba", "none"];
const TICK_SOUND_IDS: readonly TickSoundId[] = ["none", "clock", "metronome"];

function normalizeEventSoundId(v: unknown, fallback: EventSoundId): EventSoundId {
  return EVENT_SOUND_IDS.includes(v as EventSoundId) ? (v as EventSoundId) : fallback;
}

function normalizeTickSoundId(v: unknown): TickSoundId {
  return TICK_SOUND_IDS.includes(v as TickSoundId) ? (v as TickSoundId) : "none";
}

function normalizeVolume(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(100, Math.max(0, n));
}

/* ---------------- [TB-CORE] 任务栏切片归一（与 Rust from_json_value 同语义） ---------------- */

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA` → 小写 `#rrggbbaa`；其余 null
 *  （调用方回默认色）。与 Rust normalize_hex_color 一致，前后空白宽容。 */
export function normalizeTaskbarColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t.startsWith("#")) return null;
  const hex = t.slice(1).toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  switch (hex.length) {
    case 3:
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}ff`;
    case 4:
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    case 6:
      return `#${hex}ff`;
    case 8:
      return `#${hex}`;
    default:
      return null;
  }
}

function normalizeTaskbarAppearance(v: unknown, def: TaskbarAppearance): TaskbarAppearance {
  const src = asRecord(v) ?? {};
  const radius = typeof src.blurRadius === "number" ? src.blurRadius : Number(src.blurRadius);
  return {
    accent: TASKBAR_ACCENTS.includes(src.accent as TaskbarAccent) ? (src.accent as TaskbarAccent) : def.accent,
    color: normalizeTaskbarColor(src.color) ?? def.color,
    showPeek: boolOr(src.showPeek, def.showPeek),
    showLine: boolOr(src.showLine, def.showLine),
    // 越界 / 非整数回默认而非钳制（同 numOr 语义与 Rust as_u64 过滤）。
    blurRadius: Number.isInteger(radius) && radius >= 0 && radius <= 750 ? radius : def.blurRadius
  };
}

function normalizeTaskbarState(v: unknown, def: TaskbarStateAppearance, desktop: boolean): TaskbarStateAppearance {
  const appearance = normalizeTaskbarAppearance(v, def);
  if (desktop) return appearance;
  const src = asRecord(v) ?? {};
  return { ...appearance, enabled: boolOr(src.enabled, def.enabled ?? false) };
}

function normalizeTaskbarStates(v: unknown, defs: Record<TaskbarStateKey, TaskbarStateAppearance>) {
  const src = asRecord(v) ?? {};
  const out = {} as Record<TaskbarStateKey, TaskbarStateAppearance>;
  for (const key of TASKBAR_STATE_KEYS) {
    out[key] = normalizeTaskbarState(src[key], defs[key], key === "desktop");
  }
  return out;
}

/** 单条规则：非对象 / id 空白 / matchType 非法 → 丢弃（null）；pattern 缺失
 *  按空串保留（恒不匹配，UI 可继续编辑）。 */
function normalizeTaskbarRule(v: unknown): TaskbarRule | null {
  const src = asRecord(v);
  if (!src) return null;
  const id = typeof src.id === "string" ? src.id : "";
  if (!id.trim()) return null;
  if (!TASKBAR_MATCH_TYPES.includes(src.matchType as TaskbarMatchType)) return null;
  const inactive = asRecord(src.inactiveAppearance);
  const rule: TaskbarRule = {
    id,
    matchType: src.matchType as TaskbarMatchType,
    pattern: strOr(src.pattern, ""),
    appearance: normalizeTaskbarAppearance(src.appearance, DEFAULT_TASKBAR_APPEARANCE)
  };
  if (inactive) rule.inactiveAppearance = normalizeTaskbarAppearance(inactive, DEFAULT_TASKBAR_APPEARANCE);
  return rule;
}

function normalizeTaskbarRuleList(v: unknown): TaskbarRule[] {
  if (!Array.isArray(v)) return [];
  const out: TaskbarRule[] = [];
  for (const item of v) {
    const rule = normalizeTaskbarRule(item);
    if (rule) out.push(rule);
    if (out.length >= TASKBAR_MAX_RULES_PER_STATE) break;
  }
  return out;
}

function normalizeTaskbarRules(v: unknown): TaskbarRules {
  const src = asRecord(v) ?? {};
  return {
    visibleWindow: normalizeTaskbarRuleList(src.visibleWindow),
    maximizedWindow: normalizeTaskbarRuleList(src.maximizedWindow)
  };
}

/** 字符串数组：只留非空白字符串（不裁剪，title 允许有意的首尾空格），上限 cap。 */
function normalizeStringList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim()) out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** 三组键都缺失 / 非对象 → 保留默认（含 Vela 自身过滤）；出现任一键即按
 *  「显式配置」整体重建（缺席组 = 空）。 */
function normalizeTaskbarIgnored(v: unknown, def: TaskbarIgnoredWindows): TaskbarIgnoredWindows {
  const src = asRecord(v);
  if (!src || (src.classes === undefined && src.titles === undefined && src.processes === undefined)) {
    return { classes: [...def.classes], titles: [...def.titles], processes: [...def.processes] };
  }
  return {
    classes: normalizeStringList(src.classes, TASKBAR_MAX_IGNORED_PER_KIND),
    titles: normalizeStringList(src.titles, TASKBAR_MAX_IGNORED_PER_KIND),
    processes: normalizeStringList(src.processes, TASKBAR_MAX_IGNORED_PER_KIND)
  };
}

/** 显示器覆盖：仅顶层字段、只收合法且在场的键；不递归 monitorOverrides。 */
function normalizeTaskbarOverride(v: unknown): Partial<TaskbarSettings> | null {
  const src = asRecord(v);
  if (!src) return null;
  const out: Partial<TaskbarSettings> = {};
  if (typeof src.enabled === "boolean") out.enabled = src.enabled;
  if (asRecord(src.states)) out.states = normalizeTaskbarStates(src.states, defaultTaskbarStates());
  if (asRecord(src.rules)) out.rules = normalizeTaskbarRules(src.rules);
  if (asRecord(src.ignoredWindows)) {
    out.ignoredWindows = normalizeTaskbarIgnored(src.ignoredWindows, { classes: [], titles: [], processes: [] });
  }
  if (typeof src.perMonitor === "boolean") out.perMonitor = src.perMonitor;
  return out;
}

/* ---------------- [TB-MONITOR] F-6 显示器覆盖：槽位键 / 编辑视图 / 只写 monitorOverrides[slot] ---------------- */

/** 覆盖表键 = 显示器稳定槽位（`list_monitors` 的 `id`，monitor.rs `monitor:slots`）
 *  的十进制字串，与 Rust `taskbar::slot_key` 同口径；不用 HMONITOR（重排会变）。 */
export function taskbarSlotKey(slot: number): string {
  return String(slot);
}

/** 覆盖可携带的顶层字段（覆盖 = 顶层整体替换，不深合并；perMonitor 不进覆盖）。 */
export const TASKBAR_OVERRIDE_KEYS = ["enabled", "states", "rules", "ignoredWindows"] as const;
export type TaskbarOverrideKey = (typeof TASKBAR_OVERRIDE_KEYS)[number];
export type TaskbarOverridePatch = Partial<Pick<TaskbarSettings, TaskbarOverrideKey>>;

/** 某槽位的编辑视图：统一配置被该槽位覆盖**浅合并**后的结果（states / rules /
 *  ignoredWindows 各自整体替换，与 Rust `effective_for_slot` 同语义）。不看
 *  perMonitor——编辑视图始终展示覆盖内容，是否生效由页面提示。返回新对象，
 *  `monitorOverrides` 保留原表（页面仍需知道哪些槽位有覆盖）。 */
export function taskbarViewForSlot(taskbar: TaskbarSettings, slot: string): TaskbarSettings {
  const ov = taskbar.monitorOverrides[slot];
  if (!ov) return taskbar;
  return {
    ...taskbar,
    enabled: typeof ov.enabled === "boolean" ? ov.enabled : taskbar.enabled,
    states: ov.states ?? taskbar.states,
    rules: ov.rules ?? taskbar.rules,
    ignoredWindows: ov.ignoredWindows ?? taskbar.ignoredWindows
  };
}

/** 只写 `monitorOverrides[slot]`：patch 内出现的字段各自**整体**写入该槽位覆盖
 *  （其余覆盖字段与统一配置不动）；`patch === null` 删除该槽位覆盖。写入时顺带
 *  `perMonitor = true`（否则覆盖不生效，用户会以为改了没反应）；覆盖条数受
 *  TASKBAR_MAX_MONITOR_OVERRIDES 限制——已满且是新槽位时原样返回。 */
export function withTaskbarOverride(
  taskbar: TaskbarSettings,
  slot: string,
  patch: TaskbarOverridePatch | null
): TaskbarSettings {
  const key = slot.trim();
  if (!key) return taskbar;
  const overrides = { ...taskbar.monitorOverrides };
  if (patch === null) {
    if (!(key in overrides)) return taskbar;
    delete overrides[key];
    return { ...taskbar, monitorOverrides: overrides };
  }
  const isNew = !(key in overrides);
  if (isNew && Object.keys(overrides).length >= TASKBAR_MAX_MONITOR_OVERRIDES) return taskbar;
  const next: Partial<TaskbarSettings> = { ...(overrides[key] ?? {}) };
  for (const k of TASKBAR_OVERRIDE_KEYS) {
    if (patch[k] !== undefined) (next as Record<string, unknown>)[k] = patch[k];
  }
  overrides[key] = next;
  return { ...taskbar, perMonitor: true, monitorOverrides: overrides };
}

/** 该槽位覆盖里已出现的字段（页面徽标用；无覆盖 → 空数组）。 */
export function taskbarOverriddenKeys(taskbar: TaskbarSettings, slot: string): TaskbarOverrideKey[] {
  const ov = taskbar.monitorOverrides[slot];
  if (!ov) return [];
  return TASKBAR_OVERRIDE_KEYS.filter((k) => ov[k] !== undefined);
}

/** 清洗任务栏切片：任何缺失 / 类型错逐字段回出厂默认（D1/D2/D3），解析永不
 *  抛错；与 Rust TaskbarSettings::from_json_value 输出同构。 */
export function normalizeTaskbar(v: unknown): TaskbarSettings {
  const def = defaultTaskbarSettings();
  const src = asRecord(v);
  if (!src) return def;
  const overrides: Record<string, Partial<TaskbarSettings>> = {};
  const rawOverrides = asRecord(src.monitorOverrides);
  if (rawOverrides) {
    for (const [slot, ov] of Object.entries(rawOverrides)) {
      if (!slot.trim() || Object.keys(overrides).length >= TASKBAR_MAX_MONITOR_OVERRIDES) continue;
      const parsed = normalizeTaskbarOverride(ov);
      if (parsed) overrides[slot] = parsed;
    }
  }
  return {
    enabled: boolOr(src.enabled, def.enabled),
    states: normalizeTaskbarStates(src.states, def.states),
    rules: normalizeTaskbarRules(src.rules),
    ignoredWindows: normalizeTaskbarIgnored(src.ignoredWindows, def.ignoredWindows),
    perMonitor: boolOr(src.perMonitor, def.perMonitor),
    monitorOverrides: overrides
  };
}

/** 附加天气城市列表清洗：丢弃字段不全或坐标非法的项，最多 8 个。 */
function normalizeWeatherCities(v: unknown): WeatherCity[] {
  if (!Array.isArray(v)) return [];
  const out: WeatherCity[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    const lat = Number(c.lat);
    const lon = Number(c.lon);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    out.push({ name, lat, lon });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 校验/规范化嵌套设置子对象，保证损坏类型不会把 NaN/undefined 泄漏进
 * CSS 变量或组件读取。回退值跟随解析后的预设（而非硬编码），数值统一
 * 钳制（区间须与 store setter 一致）。
 *
 * @param obj - 任意来源（localStorage/DB/远端同步）的原始设置对象。
 * @returns 补全默认并逐项钳制后的部分设置态。O(字段数)。
 *
 * @example
 * ```ts
 * const safe = sanitizeSettings(JSON.parse(raw));
 * ```
 */
export function sanitizeSettings(obj: Record<string, unknown>): Partial<SettingsState> {
  const preset = obj.preset;
  const themeMode = obj.themeMode;

  const g =
    typeof obj.general === "object" && obj.general !== null && !Array.isArray(obj.general)
      ? (obj.general as Record<string, unknown>)
      : {};
  const e =
    typeof obj.extra === "object" && obj.extra !== null && !Array.isArray(obj.extra)
      ? (obj.extra as Record<string, unknown>)
      : {};
  const n =
    typeof obj.notifications === "object" && obj.notifications !== null && !Array.isArray(obj.notifications)
      ? (obj.notifications as Record<string, unknown>)
      : {};

  const resolvedPreset: ThemePreset =
    typeof preset === "string" && preset in PRESETS
      ? (preset as ThemePreset)
      : typeof preset === "string" && preset in PRESET_MIGRATION
        ? PRESET_MIGRATION[preset]
        : "default";

  // 顶层 spread 会把快照里的任意键塞进 store：DB/JSON 里若出现与 action 同名的
  // 数据键（写坏 / 篡改 / 未来版本字段撞名，如 `setZoom: 5`），setState 会把
  // action 函数覆盖成数字，调用即 TypeError。按 store 当前的函数键剔除。
  // 模块初始化期（loadSettings 先于 create）store 尚未存在：输入来自本地快照，
  // 此时跳过剔除（下面的字段级清洗仍生效）。
  const base: Record<string, unknown> = { ...obj };
  try {
    for (const [k, v] of Object.entries(useSettingsStore.getState() as unknown as Record<string, unknown>)) {
      if (typeof v === "function") delete base[k];
    }
  } catch {
    // store not created yet
  }

  return {
    ...(base as Partial<SettingsState>),
    preset: resolvedPreset,
    themeMode:
      themeMode === "system" || themeMode === "dark" || themeMode === "light" ? (themeMode as ThemeMode) : "system",
    // 自定义主题配色（preset = "custom" 时由引擎派生次级 token）。
    customColors: sanitizeCustomColors(obj.customColors),
    floatingThemeMode:
      obj.floatingThemeMode === "light" || obj.floatingThemeMode === "dark" ? obj.floatingThemeMode : "follow",
    // 壁纸挑选偏好：文件夹路径串 + 最近使用路径表（只留非空字符串，上限内）。
    wallpaperFolder: strOr(obj.wallpaperFolder, ""),
    recentWallpapers: normalizeStringList(obj.recentWallpapers, RECENT_WALLPAPERS_MAX),
    // §4.5 快捷键表（normalizeShortcuts 保证形状与互斥）。
    shortcuts: normalizeShortcuts(obj.shortcuts),
    // 应用内快捷键（逐条归一，允许单键如 Escape）。
    appShortcuts: normalizeAppShortcuts(obj.appShortcuts),
    // 回退值跟随解析后的预设（此前硬编码 glass：浅色预设损坏时会得到
    // 「浅色桌面 + 9% 白玻璃卡片」近乎不可见的组合）。
    primaryColor: strOr(obj.primaryColor, PRESETS[resolvedPreset].dark.accent),
    font: strOr(obj.font, "系统"),
    widgetBackground: strOr(obj.widgetBackground, PRESETS[resolvedPreset].dark.paper),
    // NOTE: these ranges must match the store's setters (100-based zoom/fontSize,
    // 0–100 widgetOpacity / settingsWindowOpacity). Mismatched units here
    // used to corrupt legitimate stored values on every load.
    zoom: numOr(obj.zoom, 100, 60, 160),
    fontSize: numOr(obj.fontSize, 100, 80, 140),
    widgetOpacity: numOr(obj.widgetOpacity, 55, 0, 100),
    settingsWindowOpacity: numOr(obj.settingsWindowOpacity, 100, 0, 100),
    cornerRadius: numOr(obj.cornerRadius, 24, 0, 40),
    spacing: numOr(obj.spacing, 16, 4, 48),
    blur: numOr(obj.blur, 32, 0, 60),
    general: {
      language: strOr(g.language, DEFAULT_GENERAL.language),
      launchOnStartup: boolOr(g.launchOnStartup, DEFAULT_GENERAL.launchOnStartup),
      showDesktopIcons: boolOr(g.showDesktopIcons, DEFAULT_GENERAL.showDesktopIcons),
      pauseDuringGaming: boolOr(g.pauseDuringGaming, DEFAULT_GENERAL.pauseDuringGaming),
      desktopDoubleClick: boolOr(g.desktopDoubleClick, DEFAULT_GENERAL.desktopDoubleClick),
      pauseWhenIdle: boolOr(g.pauseWhenIdle, DEFAULT_GENERAL.pauseWhenIdle),
      reduceEffects: boolOr(g.reduceEffects, DEFAULT_GENERAL.reduceEffects),
      clipboard: normalizeClipboardPrivacy(g.clipboard),
      taskbar: normalizeTaskbar(g.taskbar),
      media: normalizeMediaBehavior(g.media),
      superPanel: normalizeSuperPanel(g.superPanel),
      doubleTapSummon: normalizeDoubleTap(g.doubleTapSummon),
      hotkeyBlacklist: normalizeBlacklist(g.hotkeyBlacklist)
    },
    extra: {
      enableAnimations: boolOr(e.enableAnimations, DEFAULT_EXTRA.enableAnimations),
      animationSpeed:
        e.animationSpeed === "slow" || e.animationSpeed === "normal" || e.animationSpeed === "fast"
          ? e.animationSpeed
          : DEFAULT_EXTRA.animationSpeed,
      // 旧版本把特效模式存为独立的 fxMode 布尔；迁移：开启过特效的用户直接
      // 落到「增强」档，其余按已存的 animationMode（非法值回退默认）。
      animationMode:
        e.animationMode === "enhanced" || e.animationMode === "standard" || e.animationMode === "reduced"
          ? e.animationMode
          : boolOr((e as { fxMode?: unknown }).fxMode, false)
            ? "enhanced"
            : DEFAULT_EXTRA.animationMode,
      animationDuration: numOr(e.animationDuration, DEFAULT_EXTRA.animationDuration, 50, 200),
      fxToggles: normalizeFxToggles(e.fxToggles),
      widgetEntrance:
        e.widgetEntrance === "fade" || e.widgetEntrance === "scale" || e.widgetEntrance === "none"
          ? e.widgetEntrance
          : DEFAULT_EXTRA.widgetEntrance,
      viewTransition:
        e.viewTransition === "slide" || e.viewTransition === "fade" || e.viewTransition === "none"
          ? e.viewTransition
          : DEFAULT_EXTRA.viewTransition,
      customEase: sanitizeBezier(e.customEase) ?? DEFAULT_EXTRA.customEase,
      customEaseEnabled: boolOr(e.customEaseEnabled, DEFAULT_EXTRA.customEaseEnabled),
      focusMode:
        e.focusMode === "off" || e.focusMode === "light" || e.focusMode === "medium" || e.focusMode === "deep"
          ? e.focusMode
          : DEFAULT_EXTRA.focusMode,
      weatherCity: strOr(e.weatherCity, DEFAULT_EXTRA.weatherCity),
      weatherLat: numOrNull(e.weatherLat, DEFAULT_EXTRA.weatherLat),
      weatherLon: numOrNull(e.weatherLon, DEFAULT_EXTRA.weatherLon),
      weatherCities: normalizeWeatherCities(e.weatherCities),
      weatherAutoLocate: boolOr(e.weatherAutoLocate, DEFAULT_EXTRA.weatherAutoLocate),
      networkTimeout: numOr(e.networkTimeout, DEFAULT_EXTRA.networkTimeout, 1, 60),
      netRateBits: boolOr(e.netRateBits, DEFAULT_EXTRA.netRateBits),
      netRateCompact: boolOr(e.netRateCompact, DEFAULT_EXTRA.netRateCompact),
      netRateHideUnit: boolOr(e.netRateHideUnit, DEFAULT_EXTRA.netRateHideUnit),
      netSwapUpDown: boolOr(e.netSwapUpDown, DEFAULT_EXTRA.netSwapUpDown),
      netSpeedAlert: boolOr(e.netSpeedAlert, DEFAULT_EXTRA.netSpeedAlert),
      netSpeedAlertMbps: numOr(e.netSpeedAlertMbps, DEFAULT_EXTRA.netSpeedAlertMbps, 0.1, 10000),
      netTrafficAlert: boolOr(e.netTrafficAlert, DEFAULT_EXTRA.netTrafficAlert),
      netTrafficAlertGB: numOr(e.netTrafficAlertGB, DEFAULT_EXTRA.netTrafficAlertGB, 0.1, 10000),
      idleDim: boolOr(e.idleDim, DEFAULT_EXTRA.idleDim),
      idleGlassOff: boolOr(e.idleGlassOff, DEFAULT_EXTRA.idleGlassOff),
      onboarded: boolOr(e.onboarded, DEFAULT_EXTRA.onboarded),
      fileBrowserRoot: strOr(e.fileBrowserRoot, DEFAULT_EXTRA.fileBrowserRoot),
      recycleRetentionDays: numOr(e.recycleRetentionDays, DEFAULT_EXTRA.recycleRetentionDays, 7, 90),
      updateEndpoint: strOr(e.updateEndpoint, DEFAULT_EXTRA.updateEndpoint),
      updateArtifact: strOr(e.updateArtifact, DEFAULT_EXTRA.updateArtifact),
      autoCheckUpdates: boolOr(e.autoCheckUpdates, DEFAULT_EXTRA.autoCheckUpdates),
      // BentoDesk 借鉴 #10：定时检查调度（启动即查 + 周期可选）与跳过版本。
      updateCheckIntervalHours: numOr(e.updateCheckIntervalHours, DEFAULT_EXTRA.updateCheckIntervalHours, 0, 24 * 30),
      updateLastCheckAt: numOr(e.updateLastCheckAt, DEFAULT_EXTRA.updateLastCheckAt, 0, Number.MAX_SAFE_INTEGER),
      updateSkipVersion: strOr(e.updateSkipVersion, DEFAULT_EXTRA.updateSkipVersion),
      presetGallerySource: strOr(e.presetGallerySource, DEFAULT_EXTRA.presetGallerySource),
      // [UPD-CH] 通道白名单清洗：非法值回默认 stable。
      updateChannel: e.updateChannel === "insider" ? "insider" : "stable",
      updateChannelSetByUser: boolOr(e.updateChannelSetByUser, DEFAULT_EXTRA.updateChannelSetByUser),
      analyticsStartDate:
        typeof e.analyticsStartDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.analyticsStartDate)
          ? e.analyticsStartDate
          : null,
      pomodoroAutomation: normalizeAutomationRules(e.pomodoroAutomation),
      virtualMidnightHour: e.virtualMidnightHour === 2 || e.virtualMidnightHour === 4 ? e.virtualMidnightHour : 0
    },
    notifications: {
      pomodoroEnabled: boolOr(n.pomodoroEnabled, DEFAULT_NOTIFICATIONS.pomodoroEnabled),
      pomodoroSound: boolOr(n.pomodoroSound, DEFAULT_NOTIFICATIONS.pomodoroSound),
      pomodoroToast: boolOr(n.pomodoroToast, DEFAULT_NOTIFICATIONS.pomodoroToast),
      pomodoroModeSwitch: boolOr(n.pomodoroModeSwitch, DEFAULT_NOTIFICATIONS.pomodoroModeSwitch),
      pomodoroFocusEndSound: normalizeEventSoundId(
        n.pomodoroFocusEndSound,
        DEFAULT_NOTIFICATIONS.pomodoroFocusEndSound
      ),
      pomodoroFocusEndVolume: normalizeVolume(n.pomodoroFocusEndVolume, DEFAULT_NOTIFICATIONS.pomodoroFocusEndVolume),
      pomodoroBreakEndSound: normalizeEventSoundId(
        n.pomodoroBreakEndSound,
        DEFAULT_NOTIFICATIONS.pomodoroBreakEndSound
      ),
      pomodoroBreakEndVolume: normalizeVolume(n.pomodoroBreakEndVolume, DEFAULT_NOTIFICATIONS.pomodoroBreakEndVolume),
      pomodoroTickSound: normalizeTickSoundId(n.pomodoroTickSound),
      pomodoroTickVolume: normalizeVolume(n.pomodoroTickVolume, DEFAULT_NOTIFICATIONS.pomodoroTickVolume),
      todoEnabled: boolOr(n.todoEnabled, DEFAULT_NOTIFICATIONS.todoEnabled),
      todoSound: boolOr(n.todoSound, DEFAULT_NOTIFICATIONS.todoSound),
      todoToast: boolOr(n.todoToast, DEFAULT_NOTIFICATIONS.todoToast),
      todoOverdue: boolOr(n.todoOverdue, DEFAULT_NOTIFICATIONS.todoOverdue),
      // F-来源门控：逐源布尔归一；旧快照缺 sources 时整体回退默认（全开）。
      sources: Object.fromEntries(
        (Object.keys(DEFAULT_NOTIFICATION_SOURCES) as NotificationSource[]).map((k) => [
          k,
          boolOr((n.sources as Partial<Record<NotificationSource, unknown>> | undefined)?.[k], true)
        ])
      ) as Record<NotificationSource, boolean>,
      systemListener: boolOr(n.systemListener, DEFAULT_NOTIFICATIONS.systemListener),
      pushEnabled: boolOr(n.pushEnabled, DEFAULT_NOTIFICATIONS.pushEnabled),
      pushPort: normalizePushPort(n.pushPort)
    }
  };
}

function saveSettings(s: SettingsState) {
  const snapshot = snapshotFor(s);
  // Always write to localStorage (fast, synchronous).
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
    quotaToastShown = false;
  } catch {
    // P2（审计修复）：主题/外观设置是最高频写入路径，此前配额错误静默吞掉
    // ——用户调的所有滑块重启即回档且零提示。与 local-storage.ts 同策略：
    // 首次弹 toast 上报，成功后复位锁存。
    console.error("[settings] localStorage write failed (quota?)");
    if (!quotaToastShown) {
      quotaToastShown = true;
      try {
        pushAppToast(t("设置保存失败"), t("浏览器存储空间不足或受限，外观设置可能未保留。"), "error");
      } catch {
        // best-effort
      }
    }
  }
  // Mirror to SQLite so the Tauri app survives localStorage clears / first run.
  if (isTauri()) {
    const json = JSON.stringify(snapshot);
    sqliteRepo
      .setSetting(SETTINGS_DB_KEY, json)
      // P0：最高频写路径此前纯 console.warn 静默——SQLite 写失败（锁/盘满）时
      // 外观改动「看着生效、重启即回档」。接 reportPersistError（自带防轰炸
      // 锁存），与全项目「持久化失败不留盲区」的口径对齐。
      .catch(reportPersistError("settingsMirror"));
  }
}

/** 构造持久化/DB 镜像用的设置快照（只含需要落盘的字段）。 */
function snapshotFor(s: SettingsState) {
  return {
    preset: s.preset,
    themeMode: s.themeMode,
    floatingThemeMode: s.floatingThemeMode,
    primaryColor: s.primaryColor,
    customColors: s.customColors,
    zoom: s.zoom,
    font: s.font,
    fontSize: s.fontSize,
    widgetBackground: s.widgetBackground,
    widgetOpacity: s.widgetOpacity,
    settingsWindowOpacity: s.settingsWindowOpacity,
    wallpaperFolder: s.wallpaperFolder,
    recentWallpapers: s.recentWallpapers,
    cornerRadius: s.cornerRadius,
    spacing: s.spacing,
    blur: s.blur,
    general: s.general,
    extra: s.extra,
    notifications: s.notifications,
    shortcuts: s.shortcuts,
    appShortcuts: s.appShortcuts
  };
}

/** 滑动条拖动时每秒触发几十次 setter，逐次全量 JSON 序列化 + localStorage
 *  写 + SQLite IPC 既浪费又与跨窗口 80ms 防抖广播叠加。连续数值类 setter
 *  改走 350ms 尾随防抖；页面隐藏/关闭时立即冲刷，最后一位不丢。离散操作
 *  （选预设、切语言等）仍即时落盘。 */
let saveDebounceTimer: number | undefined;

function scheduleSave() {
  window.clearTimeout(saveDebounceTimer);
  saveDebounceTimer = window.setTimeout(() => {
    saveDebounceTimer = undefined;
    // B-恢复 ack 协议：备份整表替换期间丢弃在飞落盘（旧态覆盖新恢复数据）。
    if (isPersistSuspended()) return;
    saveSettings(useSettingsStore.getState());
  }, 350);
}

function flushSettingsSave() {
  if (saveDebounceTimer !== undefined) {
    window.clearTimeout(saveDebounceTimer);
    saveDebounceTimer = undefined;
    if (isPersistSuspended()) return;
    saveSettings(useSettingsStore.getState());
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushSettingsSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSettingsSave();
  });
}

/** Tries to load settings from SQLite first (Tauri), falling back to localStorage. */
async function loadSettingsFromDb(): Promise<Partial<SettingsState> | null> {
  if (!isTauri()) return null;
  try {
    const raw = await sqliteRepo.getSetting(SETTINGS_DB_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return sanitizeSettings(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

const DEFAULT_GENERAL: GeneralSettings = {
  language: "简体中文",
  launchOnStartup: false,
  showDesktopIcons: true,
  pauseDuringGaming: false,
  desktopDoubleClick: true,
  pauseWhenIdle: false,
  reduceEffects: false,
  clipboard: { ...DEFAULT_CLIPBOARD_PRIVACY },
  taskbar: defaultTaskbarSettings(),
  media: { pauseOthers: false, blockedSessions: [], focusPause: false },
  superPanel: { enabled: false, durationMs: 500 },
  doubleTapSummon: { enabled: false, key: "ctrl" },
  hotkeyBlacklist: []
};

const DEFAULT_EXTRA: ExtraSettings = {
  enableAnimations: true,
  animationSpeed: "normal",
  animationMode: "standard",
  animationDuration: 100,
  fxToggles: {},
  widgetEntrance: "scale",
  /* #61 视图切换默认启用 fade：旧组 fade-out 与新组 fade-in 交叉 150ms，
     已显式保存过 "none" 的用户不受影响（持久化值优先）。 */
  viewTransition: "fade",
  customEase: DEFAULT_CUSTOM_EASE,
  customEaseEnabled: false,
  focusMode: "light",
  weatherCity: "北京",
  weatherLat: 39.9042,
  weatherLon: 116.4074,
  weatherCities: [],
  weatherAutoLocate: false,
  networkTimeout: 10,
  netRateBits: false,
  netRateCompact: false,
  netRateHideUnit: false,
  netSwapUpDown: false,
  netSpeedAlert: false,
  netSpeedAlertMbps: 10,
  netTrafficAlert: false,
  netTrafficAlertGB: 5,
  idleDim: false,
  idleGlassOff: false,
  onboarded: false,
  fileBrowserRoot: "",
  recycleRetentionDays: 30,
  updateEndpoint: "",
  updateArtifact: "Vela-win-Setup.exe",
  autoCheckUpdates: true,
  updateCheckIntervalHours: 24,
  updateLastCheckAt: 0,
  updateSkipVersion: "",
  updateChannel: "stable",
  updateChannelSetByUser: false,
  presetGallerySource: "",
  analyticsStartDate: null,
  pomodoroAutomation: [],
  virtualMidnightHour: 0
};

const DEFAULT_NOTIFICATIONS: NotificationSettings = {
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
  pushPort: DEFAULT_PUSH_PORT
};

const loaded = loadSettings();

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector((set, get) => ({
    preset: loaded.preset ?? "default",
    themeMode: loaded.themeMode ?? "system",
    floatingThemeMode: loaded.floatingThemeMode ?? "follow",
    primaryColor: loaded.primaryColor ?? PRESETS.default.dark.accent,
    customColors: loaded.customColors ?? DEFAULT_CUSTOM_COLORS,
    zoom: loaded.zoom ?? 100,
    font: loaded.font ?? "系统",
    fontSize: loaded.fontSize ?? 100,
    widgetBackground: loaded.widgetBackground ?? PRESETS.default.dark.paper,
    widgetOpacity: loaded.widgetOpacity ?? 55,
    settingsWindowOpacity: loaded.settingsWindowOpacity ?? 100,
    wallpaperFolder: loaded.wallpaperFolder ?? "",
    recentWallpapers: loaded.recentWallpapers ?? [],
    cornerRadius: loaded.cornerRadius ?? 24,
    spacing: loaded.spacing ?? 16,
    blur: loaded.blur ?? 32,
    settingsOpen: false,
    settingsPage: "style",
    general: { ...DEFAULT_GENERAL, ...(loaded.general ?? {}) },
    extra: { ...DEFAULT_EXTRA, ...(loaded.extra ?? {}) },
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      ...(loaded.notifications ?? {}),
      sources: { ...DEFAULT_NOTIFICATION_SOURCES, ...(loaded.notifications?.sources ?? {}) }
    },
    shortcuts: { ...DEFAULT_SHORTCUTS, ...(loaded.shortcuts ?? {}) },
    appShortcuts: normalizeAppShortcuts(loaded.appShortcuts ?? DEFAULT_APP_SHORTCUTS),

    setPreset: (p) => {
      if (!(p in PRESETS)) return;
      if (p === "custom") {
        // 自定义：底色 / 文字由 customColors 提供，主色沿用当前值不强改
        //（主色行本来就是自定义强调色的入口）。
        set({ preset: "custom" });
        saveSettings(get());
        return;
      }
      // 按当前主题模式取对应档的强调色 / 玻璃色，卡片预览与实际生效一致。
      const mode = get().themeMode;
      const t =
        mode === "light"
          ? PRESETS[p].light
          : mode === "dark"
            ? PRESETS[p].dark
            : resolveEffectiveTokens(p, mode, get().customColors);
      set({
        preset: p,
        primaryColor: t.accent,
        widgetBackground: t.paper
        // widgetOpacity / zoom / 字体等显示偏好是用户自设值，不随预设切换重置
        // （此前 opacity 每次切主题都被打回预设默认，用户得反复重调）。
      });
      saveSettings(get());
    },
    setThemeMode: (m) => {
      if (m !== "system" && m !== "dark" && m !== "light") return;
      set({ themeMode: m });
      saveSettings(get());
    },
    setFloatingThemeMode: (m) => {
      if (m !== "follow" && m !== "dark" && m !== "light") return;
      set({ floatingThemeMode: m });
      saveSettings(get());
    },
    setCustomColors: (patch) => {
      const cur = get().customColors;
      set({
        customColors: {
          dark: { ...cur.dark, ...(patch.dark ?? {}) },
          light: { ...cur.light, ...(patch.light ?? {}) }
        }
      });
      scheduleSave();
    },
    setWallpaperFolder: (path) => {
      set({ wallpaperFolder: typeof path === "string" ? path : "" });
      saveSettings(get());
    },
    pushRecentWallpaper: (path) => {
      if (typeof path !== "string" || !path) return;
      const next = [path, ...get().recentWallpapers.filter((p) => p !== path)].slice(0, RECENT_WALLPAPERS_MAX);
      set({ recentWallpapers: next });
      saveSettings(get());
    },
    setPrimaryColor: (c) => {
      if (typeof c !== "string" || !c) return;
      set({ primaryColor: c });
      scheduleSave();
    },
    setZoom: (z) => {
      set({ zoom: Math.max(60, Math.min(160, z)) });
      scheduleSave();
    },
    setFont: (f) => {
      if (typeof f !== "string" || !f) return;
      set({ font: f });
      saveSettings(get());
    },
    setFontSize: (s) => {
      set({ fontSize: Math.max(80, Math.min(140, s)) });
      scheduleSave();
    },
    setWidgetBackground: (c) => {
      if (typeof c !== "string" || !c) return;
      set({ widgetBackground: c });
      scheduleSave();
    },
    setWidgetOpacity: (o) => {
      set({ widgetOpacity: Math.max(0, Math.min(100, o)) });
      scheduleSave();
    },
    setCornerRadius: (v) => {
      set({ cornerRadius: Math.max(0, Math.min(40, v)) });
      scheduleSave();
    },
    setSpacing: (v) => {
      set({ spacing: Math.max(4, Math.min(48, v)) });
      scheduleSave();
    },
    setBlur: (v) => {
      set({ blur: Math.max(0, Math.min(60, v)) });
      scheduleSave();
    },
    setSettingsWindowOpacity: (o) => {
      set({ settingsWindowOpacity: Math.max(0, Math.min(100, o)) });
      scheduleSave();
    },
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setSettingsPage: (page) => set({ settingsPage: page }),
    setGeneral: (patch) => {
      // 经过 sanitize 再入 state：跨窗口同步 / 旧版本数据带入的非法枚举值
      // 不会进入内存（此前只有 load 时清洗，运行期 patch 可绕过）。
      const merged = sanitizeSettings({ general: { ...get().general, ...patch } });
      set({ general: merged.general });
      saveSettings(get());
    },
    setTaskbar: (patch) => {
      const general = get().general;
      const merged = sanitizeSettings({ general: { ...general, taskbar: { ...general.taskbar, ...patch } } });
      set({ general: merged.general });
      scheduleSave();
    },
    setTaskbarOverride: (slot, patch) => {
      const general = get().general;
      const taskbar = withTaskbarOverride(general.taskbar, slot, patch);
      if (taskbar === general.taskbar) return;
      const merged = sanitizeSettings({ general: { ...general, taskbar } });
      set({ general: merged.general });
      scheduleSave();
    },
    setExtra: (patch) => {
      const merged = sanitizeSettings({ extra: { ...get().extra, ...patch } });
      set({ extra: merged.extra });
      saveSettings(get());
      pushNetAlertsIfTouched(patch, merged.extra ?? get().extra);
    },
    /** 连续数值类 extra 字段（动画时长倍率等）拖动高频触发，走 350ms 尾随
     *  防抖落盘，避免逐次全量持久化 + 60 条 CSS 变量重写导致卡顿。 */
    setExtraDebounced: (patch) => {
      const merged = sanitizeSettings({ extra: { ...get().extra, ...patch } });
      set({ extra: merged.extra });
      scheduleSave();
      pushNetAlertsIfTouched(patch, merged.extra ?? get().extra);
    },
    setNotifications: (patch) => {
      const merged = sanitizeSettings({ notifications: { ...get().notifications, ...patch } });
      set({ notifications: merged.notifications });
      saveSettings(get());
    },
    /* §4.5：快捷键写入必经 sanitize（互斥/修饰键门槛），查重由录制器在保存前
       拦截；对 Rust 的重注册由设置窗的 ShortcutConfigSync/保存回调驱动。 */
    setShortcut: (action, accel) => {
      const merged = sanitizeSettings({ shortcuts: { ...get().shortcuts, [action]: accel } });
      set({ shortcuts: merged.shortcuts ?? get().shortcuts });
      saveSettings(get());
    },
    setShortcuts: (patch) => {
      const merged = sanitizeSettings({ shortcuts: { ...get().shortcuts, ...patch } });
      set({ shortcuts: merged.shortcuts ?? get().shortcuts });
      saveSettings(get());
    },
    /* 应用内快捷键：enabled / accel 逐条 patch；窗口内按键无系统级副作用，
       无需修饰键门槛，也不与全局表查重（作用域不同）。 */
    setAppShortcut: (id, patch) => {
      const merged = normalizeAppShortcuts({ ...get().appShortcuts, [id]: { ...get().appShortcuts[id], ...patch } });
      set({ appShortcuts: merged });
      saveSettings(get());
    },
    resetPrimaryColor: () => {
      const st = get();
      set({ primaryColor: resolveEffectiveTokens(st.preset, st.themeMode, st.customColors).accent });
      saveSettings(get());
    },
    resetWidgetBackground: () => {
      const st = get();
      set({ widgetBackground: resolveEffectiveTokens(st.preset, st.themeMode, st.customColors).paper });
      saveSettings(get());
    }
  }))
);

/* ------------------------------------------------------------------ */
/* W-170 网络告警阈值 → Rust 记录器同步                                   */
/* ------------------------------------------------------------------ */

/** patch 是否触及网络告警配置（命中才向 Rust 推送，避免每次开关都跑 IPC）。 */
function touchesNetAlerts(patch: Partial<ExtraSettings>): boolean {
  const keys: (keyof ExtraSettings)[] = ["netSpeedAlert", "netSpeedAlertMbps", "netTrafficAlert", "netTrafficAlertGB"];
  return keys.some((k) => k in patch);
}

/**
 * 把网速/日流量告警阈值推给 Rust `TrafficRecorder`（W-170 的判定在记录器
 * 线程，即使没有任何小组件订阅 sys:stats 也会生效）。幂等、fire-and-forget；
 * 应用启动水合（hydrateSettingsFromDb）与设置变更两个入口各推一次。
 */
export function pushNetAlerts(extra: ExtraSettings): void {
  if (!isTauri()) return;
  void import("../lib/tauri").then(({ invoke }) =>
    invoke("set_net_alerts", {
      speedEnabled: extra.netSpeedAlert,
      speedMbps: extra.netSpeedAlertMbps,
      trafficEnabled: extra.netTrafficAlert,
      trafficGb: extra.netTrafficAlertGB
    }).catch(() => {})
  );
}

function pushNetAlertsIfTouched(patch: Partial<ExtraSettings>, merged: ExtraSettings): void {
  if (touchesNetAlerts(patch)) pushNetAlerts(merged);
}

/**
 * 启动时从 SQLite 镜像加载设置并与 store 合并（与 hydrateApp 配套调用）。
 * P8 语义：localStorage 有内容时它是权威源（更快、每次变更同步写），DB 落后
 * 时不得反向覆盖；localStorage 为空（profile 清理/换机）时反转——DB 镜像是
 * 唯一幸存副本，整包采纳，否则默认值会在下一次 saveSettings 时永久覆盖它。
 * 整包经 sanitize 后单次非持久化写入（不走各 setter，避免中间态落盘与
 * 陈旧快照反向覆盖在飞编辑），最后一次性 applySettings 应用主题。
 *
 * @returns 完成后 resolve；无 DB 快照时 no-op。
 * @throws 无（DB 读取失败按无快照处理）。
 */
export async function hydrateSettingsFromDb(): Promise<void> {
  const db = await loadSettingsFromDb();
  if (!db) return;
  const current = useSettingsStore.getState();
  // P8: localStorage 有内容时它是权威源（更快、每次变更都同步写入），DB 只是
  // 镜像——若某次 setSetting 失败导致 DB 落后，重启时不能反过来把陈旧 DB
  // 盖掉新设置，合并顺序让 current 覆盖 db 并写回 DB 自愈镜像分叉。
  // 但 localStorage 为空（WebView2 profile 被清理/重建、只迁移 SQLite 换机）
  // 时，current 是全默认值的完整对象（store 初始化把每个字段都 ?? 默认），
  // 若仍让 current 胜出，DB 里的真实设置会被默认值整包盖掉，且用户下一次
  // 动任何滑块时 saveSettings 就把默认值快照写回两处——镜像「抵御
  // localStorage 清空」的目的完全落空。因此该方向反转：DB 为权威。
  let lsPresent = false;
  try {
    lsPresent = localStorage.getItem(SETTINGS_KEY) !== null;
  } catch {
    lsPresent = false;
  }
  const overlay = <T extends object>(base: T, mid: Partial<T> | undefined, top: Partial<T> | undefined): T => ({
    ...base,
    ...(mid ?? {}),
    ...(top ?? {})
  });
  const merged = {
    ...current,
    ...(lsPresent ? {} : db),
    general: overlay(
      DEFAULT_GENERAL,
      lsPresent ? db.general : current.general,
      lsPresent ? current.general : db.general
    ),
    extra: overlay(DEFAULT_EXTRA, lsPresent ? db.extra : current.extra, lsPresent ? current.extra : db.extra),
    notifications: {
      ...overlay(
        DEFAULT_NOTIFICATIONS,
        lsPresent ? db.notifications : current.notifications,
        lsPresent ? current.notifications : db.notifications
      ),
      // P8 合并后 sources 逐键深合并，避免旧镜像整包覆盖新开关。
      sources: overlay(
        DEFAULT_NOTIFICATION_SOURCES,
        lsPresent ? db.notifications?.sources : current.notifications?.sources,
        lsPresent ? current.notifications?.sources : db.notifications?.sources
      )
    },
    shortcuts: overlay(
      DEFAULT_SHORTCUTS,
      lsPresent ? db.shortcuts : current.shortcuts,
      lsPresent ? current.shortcuts : db.shortcuts
    )
  };
  const sanitized = sanitizeSettings(merged as unknown as Record<string, unknown>) as never;
  // 晚到的水合写入必须对跨窗口同步静默：水合是「读库补齐」而非用户编辑，
  // 若被 sync:settings 订阅当作本地编辑，会盖上新鲜时间戳广播——慢盘 /
  // 4s 启动安全网放行渲染后水合才落地时，一份陈旧 DB 快照就变成「全网
  // 最新值」，是快速切换后互踢风暴的引信之一（见 sync-gate）。
  withRemoteApply(() => {
    useSettingsStore.setState(sanitized);
    const hydrated = useSettingsStore.getState();
    applySettings(hydrated, themeEnvOf(hydrated), hydrated.general.reduceEffects);
    // W-170：水合出的告警阈值推给 Rust 记录器（每个窗口启动各推一次，幂等）。
    pushNetAlerts(hydrated.extra);
  });
  // P8 自愈：若 localStorage 确有其内容（说明用户曾真实保存过设置），把以它
  // 为准的合并结果写回 DB，修复此前某次 setSetting 失败造成的镜像分叉。
  if (isTauri()) {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      sqliteRepo
        .setSetting(SETTINGS_DB_KEY, JSON.stringify(snapshotFor(useSettingsStore.getState())))
        .catch((err) => console.warn("[settings] self-heal mirror write failed:", SETTINGS_DB_KEY, err));
    }
  }
}

/** 清空 SQLite 侧设置镜像，使「重置」在 Tauri 模式下也能真正清除设置。 */
export function clearSettingsMirror() {
  if (isTauri()) {
    sqliteRepo.setSetting(SETTINGS_DB_KEY, "").catch((err) => console.warn("[settings] clear mirror failed:", err));
  }
}
