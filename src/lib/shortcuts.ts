/**
 * §4.5 全局快捷键配置的前端侧：动作表、录制解析与查重。
 *
 * 组合键字符串与 Rust（global-hotkey 解析器）约定：修饰键在前（大小写不
 * 敏感），主键用 `event.code` 名或简写（`D`/`KeyD`、`1`/`Digit1`、`F9`、
 * `ArrowUp`、`Numpad0`…）。存储/展示用 `Win`，下发 Rust 前换成 `Super`
 * （解析器不识别 `Win` 这个别名）。
 *
 * [TB-TRAY]（F-11）**未绑定**：空串 {@link SHORTCUT_UNBOUND} 表示动作没有组合键
 * （出厂仅 `taskbar:toggle`）。Rust `parse_config` 对无默认键的动作接受空串 =
 * 不注册；`normalizeShortcuts` 的「非空 + 修饰键，否则回默认」对它自然收敛到空串；
 * 查重 / 速查表按空串 = 无键处理。
 */

/** 可配置动作 id（与 shortcuts.rs::ACTIONS 一一对应）。 */
export const SHORTCUT_ACTIONS = [
  "toggle-pomodoro",
  "toggle-layer",
  "toggle-edit",
  "show-settings",
  "new-task",
  "quick-note",
  "toggle-palette",
  "toggle-dock",
  "open-dock-panel",
  "taskbar:toggle",
  "taskbar:reset-state",
  "screenshot"
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export type ShortcutConfig = Record<ShortcutAction, string>;

/** 「未绑定」哨兵：动作没有组合键（不注册全局热键）。 */
export const SHORTCUT_UNBOUND = "";

/** 该组合串是否代表已绑定的组合键（空白 = 未绑定）。 */
export function isShortcutBound(accel: string): boolean {
  return accel.trim() !== SHORTCUT_UNBOUND;
}

/** 默认组合 = 历史固定值（shortcuts.rs::default_config 的前端镜像）。 */
export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  "toggle-pomodoro": "Ctrl+Alt+Space",
  "toggle-layer": "Ctrl+Alt+D",
  "toggle-edit": "Ctrl+Alt+E",
  "show-settings": "Ctrl+Alt+S",
  "new-task": "Ctrl+Alt+N",
  "quick-note": "Ctrl+Alt+Q",
  "toggle-palette": "Ctrl+Alt+K",
  "toggle-dock": "Ctrl+Alt+I",
  "open-dock-panel": "Ctrl+Alt+O",
  // [TB-TRAY] F-11：总开关出厂不绑定；重置动态状态默认 Ctrl+Alt+Shift+F1（与常见任务栏增强工具一致）。
  "taskbar:toggle": SHORTCUT_UNBOUND,
  "taskbar:reset-state": "Ctrl+Alt+Shift+F1",
  // [SNIP] 截图（借鉴 ClassSoftwareHub #4）：冻结帧框选 + 标注 + 钉图。
  screenshot: "Ctrl+Alt+X"
};

/** 设置页展示标签（i18n 键）。 */
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  "toggle-pomodoro": "开始 / 暂停专注",
  "toggle-layer": "显示 / 隐藏小组件",
  "toggle-edit": "切换编辑模式",
  "show-settings": "打开设置",
  "new-task": "新建任务",
  "quick-note": "全局速记",
  // 不叫「命令面板」：速查表有同名分区标题，行标签重名会让按文本定位的
  // 测试/辅助技术命中两处。
  "toggle-palette": "呼出命令面板",
  // 灵动岛（F-10）：标签同样避开「灵动岛」「灵动岛面板」这两个既有 UI 标题。
  "toggle-dock": "显隐灵动岛",
  "open-dock-panel": "打开灵动岛面板",
  // 任务栏（F-11）：避开设置页总开关行标题「自定义任务栏外观」与状态条按钮「重新应用」。
  "taskbar:toggle": "开关任务栏外观",
  "taskbar:reset-state": "重置任务栏状态",
  screenshot: "截图"
};

/** 按下这些键本身不构成组合（等待主键）。 */
const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "Dead"
]);

/** event.code → 组合键主键名（可读且 Rust 解析器可识别）。 */
export function keyNameFromCode(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  return code; // Space/F1/ArrowUp/Numpad0/Minus… 解析器按原名识别
}

/**
 * 从 keydown 事件构造组合键字符串（如 `Ctrl+Alt+D`）。
 * 纯修饰键（含左右修饰键的 code）与无 code 的按键返回 null——录制器继续
 * 等待主键；Escape/取消由调用方在调用前自行处理。
 */
export function acceleratorFromEvent(e: {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (!e.code || MODIFIER_KEYS.has(e.key)) return null;
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)$/.test(e.code)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");
  return [...mods, keyNameFromCode(e.code)].join("+");
}

/** 修饰键别名归一（解析器同义词折叠到同一写法）。 */
function normalizeMod(mod: string): string {
  const up = mod.toUpperCase();
  if (up === "CONTROL" || up === "CTRL") return "CTRL";
  if (up === "OPTION") return "ALT";
  if (up === "SUPER" || up === "META" || up === "CMD" || up === "COMMAND" || up === "WIN") return "WIN";
  if (up === "SHIFT") return "SHIFT";
  return up;
}

/**
 * 规范化比较键：修饰键排序折叠同义词、主键取 code 简写大写。
 * `Ctrl+Alt+D` ≡ `control+alt+KeyD` ≡ `ALT+CTRL+KeyD`。
 */
export function normalizeAccelerator(accel: string): string {
  const parts = accel
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const key = keyNameFromCode(parts[parts.length - 1]).toUpperCase();
  const mods = parts.slice(0, -1).map(normalizeMod).sort();
  return [...mods, key].join("+");
}

/** 是否带至少一个修饰键（无修饰的全局热键会系统级吞键，Rust 侧也拒绝）。 */
export function hasModifier(accel: string): boolean {
  return accel.split("+").filter((p) => p.trim()).length >= 2;
}

/** 在整表内查重：返回与 accel 等价的其他动作 id（含自身则跳过），无则 null。 */
export function findDuplicate(shortcuts: Record<string, string>, action: string, accel: string): string | null {
  const target = normalizeAccelerator(accel);
  if (!target) return null;
  for (const [a, v] of Object.entries(shortcuts)) {
    if (a !== action && normalizeAccelerator(v) === target) return a;
  }
  return null;
}

/** 下发 Rust 前的别名转换：存储用 `Win`，解析器只认 `Super`。 */
export function toRustAccelerator(accel: string): string {
  return accel
    .split("+")
    .map((p) => (p.trim() === "Win" ? "Super" : p.trim()))
    .join("+");
}

/* ------------------------------------------------------------------ *
 * 应用内快捷键（窗口内 keydown，不经 Rust 全局注册）：
 * 与全局动作一样「有无（enabled）+ 键位（accel）」皆可配；不要求修饰键
 * （Esc 这类单键在窗口内是安全的，不会系统级吞键）。
 * ------------------------------------------------------------------ */

export type AppShortcutId = "view-1" | "view-2" | "view-3" | "palette" | "settings-search" | "exit-edit";

/** 稳定的 id 迭代顺序（UI 行序）。 */
export const APP_SHORTCUT_IDS = ["view-1", "view-2", "view-3", "palette", "settings-search", "exit-edit"] as const;

export type AppShortcutEntry = { enabled: boolean; accel: string };
export type AppShortcutConfig = Record<AppShortcutId, AppShortcutEntry>;

/** 默认键位 = 历史硬编码值（改动前用户已习惯的组合）。 */
export const DEFAULT_APP_SHORTCUTS: AppShortcutConfig = {
  "view-1": { enabled: true, accel: "Ctrl+1" },
  "view-2": { enabled: true, accel: "Ctrl+2" },
  "view-3": { enabled: true, accel: "Ctrl+3" },
  palette: { enabled: true, accel: "Ctrl+K" },
  "settings-search": { enabled: true, accel: "Ctrl+K" },
  "exit-edit": { enabled: true, accel: "Escape" }
};

/** 应用内快捷键展示标签（i18n 键）。 */
export const APP_SHORTCUT_LABELS: Record<AppShortcutId, string> = {
  "view-1": "切换到视图 1",
  "view-2": "切换到视图 2",
  "view-3": "切换到视图 3",
  palette: "呼出命令面板",
  "settings-search": "聚焦设置搜索",
  "exit-edit": "退出编辑模式"
};

/**
 * 快捷键生效的窗口作用域：查重只在同作用域内进行——palette（主窗口）与
 * settings-search（设置窗口）默认同为 Ctrl+K，但永不在同一个窗口里触发，不算冲突。
 */
export const APP_SHORTCUT_SCOPES: Record<AppShortcutId, "main" | "settings"> = {
  "view-1": "main",
  "view-2": "main",
  "view-3": "main",
  palette: "main",
  "settings-search": "settings",
  "exit-edit": "main"
};

/** 应用内快捷键的一句话说明（i18n 键）。 */
export const APP_SHORTCUT_DESCS: Record<AppShortcutId, string> = {
  "view-1": "主窗口内切到第一个视图",
  "view-2": "主窗口内切到第二个视图",
  "view-3": "主窗口内切到第三个视图",
  /* J-3：两键默认同为 Ctrl+K 但分属两个窗口——用户在设置页看到「呼出命令
     面板: Ctrl+K」却在设置窗内按出搜索框，误以为文案失实。描述里把
     「另一窗口内同键干什么」写明，归属可预测。 */
  palette: "桌面小组件层呼出 / 收起命令面板；设置窗口内同一按键改为聚焦设置搜索",
  "settings-search": "设置窗口内聚焦搜索框；桌面小组件层同一按键改为呼出命令面板",
  "exit-edit": "编辑模式下的兜底退出"
};

/** 逐条归一：id 齐全、enabled 布尔、accel 非空字符串（窗口内允许单键，如 Escape）。 */
export function normalizeAppShortcuts(v: unknown): AppShortcutConfig {
  const src = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out = {} as AppShortcutConfig;
  for (const id of Object.keys(DEFAULT_APP_SHORTCUTS) as AppShortcutId[]) {
    const raw = src[id];
    const def = DEFAULT_APP_SHORTCUTS[id];
    out[id] =
      typeof raw === "object" && raw !== null
        ? {
            enabled:
              typeof (raw as AppShortcutEntry).enabled === "boolean" ? (raw as AppShortcutEntry).enabled : def.enabled,
            accel:
              typeof (raw as AppShortcutEntry).accel === "string" && (raw as AppShortcutEntry).accel.trim() !== ""
                ? (raw as AppShortcutEntry).accel.trim()
                : def.accel
          }
        : { ...def };
  }
  return out;
}

/**
 * keydown 事件是否命中应用内组合键（如 `Ctrl+K` / `Escape`）。
 * 修饰键按「严格相等」比较（Ctrl+K 不命中 Ctrl+Alt+K），主键同时比对
 * event.code 派生名与 event.key（数字 / 字母 / 命名键都覆盖）。
 */
export function appAccelMatches(
  accel: string,
  e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
): boolean {
  const norm = normalizeAccelerator(accel);
  if (!norm) return false;
  const parts = norm.split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  if (mods.has("CTRL") !== e.ctrlKey) return false;
  if (mods.has("ALT") !== e.altKey) return false;
  if (mods.has("SHIFT") !== e.shiftKey) return false;
  if (mods.has("WIN") !== e.metaKey) return false;
  return keyNameFromCode(e.code).toUpperCase() === key || e.key.toUpperCase() === key;
}
