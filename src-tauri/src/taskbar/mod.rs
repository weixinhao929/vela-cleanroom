//! 任务栏自定义（系统任务栏增强形态）· 契约地基。
//!
//! 本模块是任务栏定制各侧（注入 DLL / 状态检测 / 注入与管道 / 设置页）共享的**契约单一来源**，按区段组织：
//!
//! - `CONFIG`：配置线协议（serde 结构 + 容错解析），字段名与前端
//!   `settings-store.ts` 的 `general.taskbar` 完全同构（camelCase）。
//! - `STATE`：状态机纯函数 [`resolve_active_state`]（优先级见 STATE 区说明）与规则匹配 [`rule_matches`]。
//! - `COMMANDS`：四个 Tauri 命令空壳（trusted_window 门控 + spawn_blocking）。
//! - `EVENTS`：`taskbar:*` 事件名常量、emit 助手与负载类型 re-export。
//! - [`protocol`]：与注入 DLL 的管道线协议（冻结）。
//! - [`detect`]：任务栏类型探测（XAML/Mixed/Classic）与能力上报。
//! - [`win_watcher`]：消息窗线程骨架（TaskbarCreated / WM_DISPLAYCHANGE /
//!   WM_POWERBROADCAST → [`win_watcher::SystemEventCallback`]）。
//!
//! 本会话只交付纯函数与空壳：**不启动线程、不做注入、不产生任何任务栏
//! 视觉效果**。`start`/`restore_all` 由 lib.rs 挂载，运行时行为由
//! 由注入与状态检测两侧填充。

/// 任务栏类型探测与能力上报（`detect_taskbar_type` / `capabilities_for` /
/// `probe_capabilities` / `os_build`）。
pub mod detect;
/// 注入与恢复引擎：解包→注入→管道→四条恢复线→降级→
/// 状态机；`mod.rs` 的命令/事件层消费本模块。
pub mod injector;
/// 注入管道主进程侧服务端：`PipeListener` / `Pipe` /
/// `LineDecoder`、握手与带超时读写、断连判死。
pub mod pipe;
/// 注入 DLL 管道线协议（冻结）：`TapMessage` / `TapAccent` / `pipe_name` /
/// `encode` / `decode` / `pack_abgr`。
pub mod protocol;
/// 系统消息窗线程骨架：`SystemEventCallback` / `register_callback` / `start` /
/// `stop` / `watcher_hwnd`。
pub mod win_watcher;

// 各会话按子模块路径引用（taskbar::protocol::TapMessage 等），此处只
// re-export models.rs 事件负载需要的两项；私有父模块下未被本 crate 引用
// 的 `pub use` 会触发 unused_imports，子模块内的 pub 项则不会。
pub use detect::TaskbarType;
pub use protocol::PROTOCOL_VERSION;

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use ts_rs::TS;

use protocol::TapAccent;

/* ================================================================== *
 * CONFIG 区：配置线协议（与前端 settings-store.ts general.taskbar 同构）。
 * 字段名即线协议：camelCase；改名必须两侧同步（同
 * clipboard.rs parse_clip_config 的既有约定）。
 * ------------------------------------------------------------------ */

/// 防御上限：单状态规则数 / 单组忽略列表条数 / 显示器覆盖条数。
/// 前端 normalizeTaskbar 使用同值常量，两侧语义一致。
pub const MAX_RULES_PER_STATE: usize = 64;
pub const MAX_IGNORED_PER_KIND: usize = 200;
pub const MAX_MONITOR_OVERRIDES: usize = 16;

/// accent 五值（§1.1 表）。`normal` = 恢复系统默认外观。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum TaskbarAccent {
    Normal,
    Opaque,
    #[default]
    Clear,
    Blur,
    Acrylic,
}

impl From<TaskbarAccent> for TapAccent {
    fn from(a: TaskbarAccent) -> Self {
        match a {
            TaskbarAccent::Normal => TapAccent::Normal,
            TaskbarAccent::Opaque => TapAccent::Opaque,
            TaskbarAccent::Clear => TapAccent::Clear,
            TaskbarAccent::Blur => TapAccent::Blur,
            TaskbarAccent::Acrylic => TapAccent::Acrylic,
        }
    }
}

/// 单套外观（§4 TaskbarAppearance）。颜色统一 `#rrggbbaa` 存储（3/4/6 位
/// 输入由 [`normalize_hex_color`] 归一，坏值回默认）；`blur_radius` 0–750，
/// 越界回默认 30（回退而非钳制，与前端 numOr 语义一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarAppearance {
    #[serde(default = "default_accent")]
    pub accent: TaskbarAccent,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub show_peek: bool,
    #[serde(default)]
    pub show_line: bool,
    #[serde(default = "default_blur_radius")]
    pub blur_radius: u32,
}

fn default_accent() -> TaskbarAccent {
    TaskbarAccent::Clear
}
fn default_color() -> String {
    "#00000000".to_string()
}
fn default_blur_radius() -> u32 {
    30
}

impl Default for TaskbarAppearance {
    fn default() -> Self {
        Self {
            accent: default_accent(),
            color: default_color(),
            show_peek: false,
            show_line: false,
            blur_radius: default_blur_radius(),
        }
    }
}

impl TaskbarAppearance {
    /// 线协议颜色（ABGR u32，见 [`protocol::pack_abgr`]）。颜色经归一后恒为
    /// 8 位 hex；解析失败（不应发生）按全零处理。
    pub fn color_abgr(&self) -> u32 {
        match parse_rgba_hex(&self.color) {
            Some((r, g, b, a)) => protocol::pack_abgr(r, g, b, a),
            None => 0,
        }
    }
}

/// 规则匹配语义：
/// `Class` 精确（大小写敏感）/ `Process` 可执行文件名大小写不敏感精确 /
/// `Title` 子串包含（大小写敏感）。**空 pattern 恒不匹配**——空
/// title pattern 若命中一切，属脚本事故面，此处收紧并两侧一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum TaskbarMatchType {
    Class,
    Title,
    Process,
}

/// 一条窗口规则。`inactive_appearance` 仅在命中窗口
/// 非前台时使用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarRule {
    pub id: String,
    pub match_type: TaskbarMatchType,
    #[serde(default)]
    pub pattern: String,
    pub appearance: TaskbarAppearance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inactive_appearance: Option<TaskbarAppearance>,
}

/// 七态键（§4 TaskbarStateKey）。事件负载中的 `activeState` 即此类型。
/// 定义收敛于 models.rs（类型单一来源），此处 re-export 维持路径。
pub use crate::models::TaskbarStateKey;

/// 单态配置：一套外观 + 可选启用开关。`enabled: None` 仅出现在 desktop
/// （无开关）；六可选态经容错解析后恒为 `Some(_)`，缺省值 false。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarStateAppearance {
    #[serde(flatten)]
    #[ts(flatten)]
    pub appearance: TaskbarAppearance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
}

impl TaskbarStateAppearance {
    /// 该态当前是否参与求值：desktop（None）恒 true；可选态按开关。
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
}

/// 七态配置表（§4 `states: Record<TaskbarStateKey, ...>` 的结构化形式，
/// 线协议形状一致：键 camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarStates {
    pub desktop: TaskbarStateAppearance,
    pub visible_window: TaskbarStateAppearance,
    pub maximized_window: TaskbarStateAppearance,
    pub start_opened: TaskbarStateAppearance,
    pub search_opened: TaskbarStateAppearance,
    pub task_view_opened: TaskbarStateAppearance,
    pub battery_saver: TaskbarStateAppearance,
}

impl TaskbarStates {
    pub fn get(&self, key: TaskbarStateKey) -> &TaskbarStateAppearance {
        match key {
            TaskbarStateKey::Desktop => &self.desktop,
            TaskbarStateKey::VisibleWindow => &self.visible_window,
            TaskbarStateKey::MaximizedWindow => &self.maximized_window,
            TaskbarStateKey::StartOpened => &self.start_opened,
            TaskbarStateKey::SearchOpened => &self.search_opened,
            TaskbarStateKey::TaskViewOpened => &self.task_view_opened,
            TaskbarStateKey::BatterySaver => &self.battery_saver,
        }
    }

    pub fn set(&mut self, key: TaskbarStateKey, value: TaskbarStateAppearance) {
        match key {
            TaskbarStateKey::Desktop => self.desktop = value,
            TaskbarStateKey::VisibleWindow => self.visible_window = value,
            TaskbarStateKey::MaximizedWindow => self.maximized_window = value,
            TaskbarStateKey::StartOpened => self.start_opened = value,
            TaskbarStateKey::SearchOpened => self.search_opened = value,
            TaskbarStateKey::TaskViewOpened => self.task_view_opened = value,
            TaskbarStateKey::BatterySaver => self.battery_saver = value,
        }
    }
}

/// 可带规则的两个状态各自的规则表（§4 rules）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarRules {
    #[serde(default)]
    pub visible_window: Vec<TaskbarRule>,
    #[serde(default)]
    pub maximized_window: Vec<TaskbarRule>,
}

/// 忽略窗口三组列表（§4 ignoredWindows；IsFiltered 语义）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarIgnoredWindows {
    #[serde(default)]
    pub classes: Vec<String>,
    #[serde(default)]
    pub titles: Vec<String>,
    #[serde(default)]
    pub processes: Vec<String>,
}

/// 单显示器覆盖（§4 `Partial<TaskbarSettings>`：仅顶层可选，值为整体
/// 替换，不深合并）。由设置页消费。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub states: Option<TaskbarStates>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rules: Option<TaskbarRules>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ignored_windows: Option<TaskbarIgnoredWindows>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub per_monitor: Option<bool>,
}

/// 任务栏配置根（§4 TaskbarSettings）。`Deserialize` 为**容错实现**
/// （[`TaskbarSettings::from_json_value`]）：缺字段 / 坏颜色 / 越界半径 /
/// 未知枚举一律回默认，解析永不失败（仿 parse_clip_config 防御风格）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarSettings {
    /// 总开关（默认 false，新功能默认关）。
    #[serde(default)]
    pub enabled: bool,
    pub states: TaskbarStates,
    #[serde(default)]
    pub rules: TaskbarRules,
    pub ignored_windows: TaskbarIgnoredWindows,
    /// 逐显示器独立配置（默认 false）。
    #[serde(default)]
    pub per_monitor: bool,
    #[serde(default)]
    pub monitor_overrides: HashMap<String, TaskbarOverride>,
}

impl Default for TaskbarSettings {
    fn default() -> Self {
        TaskbarSettings {
            enabled: false,
            states: default_states(),
            rules: TaskbarRules::default(),
            ignored_windows: default_ignored_windows(),
            per_monitor: false,
            monitor_overrides: HashMap::new(),
        }
    }
}

/// 七态出厂默认（taskView 默认**关**；blurRadius 统一取 30）。
fn default_states() -> TaskbarStates {
    let mk = |accent, peek, line, enabled: Option<bool>| TaskbarStateAppearance {
        appearance: TaskbarAppearance {
            accent,
            color: "#00000000".to_string(),
            show_peek: peek,
            show_line: line,
            blur_radius: 30,
        },
        enabled,
    };
    TaskbarStates {
        // clear, #00000000, peek=false, line=false；恒启用。
        desktop: mk(TaskbarAccent::Clear, false, false, None),
        // 默认关 + clear + peek=true + line=false。
        visible_window: mk(TaskbarAccent::Clear, true, false, Some(false)),
        // 默认关 + acrylic + peek=true + line=true。
        maximized_window: mk(TaskbarAccent::Acrylic, true, true, Some(false)),
        // Win11：默认关 + normal + peek=true + line=true。
        start_opened: mk(TaskbarAccent::Normal, true, true, Some(false)),
        search_opened: mk(TaskbarAccent::Normal, true, true, Some(false)),
        // taskView 默认关（有意收紧）。
        task_view_opened: mk(TaskbarAccent::Normal, false, true, Some(false)),
        // 默认关 + opaque(GRADIENT) + peek=true + line=false。
        battery_saver: mk(TaskbarAccent::Opaque, true, false, Some(false)),
    }
}

/// 出厂忽略列表含 Vela 自身（防自身窗口污染可见/最大化判定）：
/// - `Tauri Window`：tauri-runtime-wry 在 Windows 上给所有窗口的注册类名
///   （tauri-runtime-wry lib.rs `window_classname("Tauri Window")`），覆盖
///   设置窗与全部 widget 窗；
/// - `Vela.exe`：发布版进程名（productName）；
/// - `focus-desk.exe`：开发 / CI 运行时的 cargo 包名进程名。
pub fn default_ignored_windows() -> TaskbarIgnoredWindows {
    TaskbarIgnoredWindows {
        classes: vec!["Tauri Window".to_string()],
        titles: Vec::new(),
        processes: vec!["Vela.exe".to_string(), "focus-desk.exe".to_string()],
    }
}

/// 归一十六进制颜色：`#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA` →
/// 小写 `#rrggbbaa`（短位逐通道翻倍；6 位补 `ff`）。其余一律 `None`
/// （调用方回默认色）。前后空白宽容。
pub fn normalize_hex_color(s: &str) -> Option<String> {
    let t = s.trim();
    let hex = t.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let c: Vec<char> = hex.to_ascii_lowercase().chars().collect();
            Some(format!("#{0}{0}{1}{1}{2}{2}ff", c[0], c[1], c[2]))
        }
        4 => {
            let c: Vec<char> = hex.to_ascii_lowercase().chars().collect();
            Some(format!("#{0}{0}{1}{1}{2}{2}{3}{3}", c[0], c[1], c[2], c[3]))
        }
        6 => Some(format!("#{}ff", hex.to_ascii_lowercase())),
        8 => Some(format!("#{}", hex.to_ascii_lowercase())),
        _ => None,
    }
}

/// `#rrggbbaa` → (r, g, b, a)。非 8 位 hex（未归一的输入）返回 None。
pub fn parse_rgba_hex(s: &str) -> Option<(u8, u8, u8, u8)> {
    let hex = s.strip_prefix('#')?;
    if hex.len() != 8 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some((byte(0)?, byte(2)?, byte(4)?, byte(6)?))
}

/* ------------------------- 容错解析（CONFIG 区） ------------------------- */

fn jbool(v: Option<&serde_json::Value>, fallback: bool) -> bool {
    v.and_then(serde_json::Value::as_bool).unwrap_or(fallback)
}

fn jstr(v: Option<&serde_json::Value>, fallback: &str) -> String {
    v.and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

/// 字符串数组清洗：只留非空白字符串（保留原串不裁剪——title 语义允许
/// 有意的首尾空格），上限 `cap`。
fn jstring_list(v: Option<&serde_json::Value>, cap: usize) -> Vec<String> {
    v.and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .take(cap)
                .collect()
        })
        .unwrap_or_default()
}

impl TaskbarAppearance {
    /// 从任意 JSON 值容错提取：非法 accent / 坏颜色 / 越界半径 / 类型错
    /// 均逐字段回 `default`（parse_clip_config 防御风格）。
    fn from_json_value(v: Option<&serde_json::Value>, default: &TaskbarAppearance) -> Self {
        let obj = v.and_then(serde_json::Value::as_object);
        let g = |k: &str| obj.and_then(|o| o.get(k));
        let accent = match g("accent").and_then(serde_json::Value::as_str) {
            Some("normal") => TaskbarAccent::Normal,
            Some("opaque") => TaskbarAccent::Opaque,
            Some("clear") => TaskbarAccent::Clear,
            Some("blur") => TaskbarAccent::Blur,
            Some("acrylic") => TaskbarAccent::Acrylic,
            _ => default.accent,
        };
        TaskbarAppearance {
            accent,
            color: g("color")
                .and_then(serde_json::Value::as_str)
                .and_then(normalize_hex_color)
                .unwrap_or_else(|| default.color.clone()),
            show_peek: jbool(g("showPeek"), default.show_peek),
            show_line: jbool(g("showLine"), default.show_line),
            blur_radius: g("blurRadius")
                .and_then(serde_json::Value::as_u64)
                .filter(|r| (0..=750).contains(r))
                .map(|r| r as u32)
                .unwrap_or(default.blur_radius),
        }
    }
}

impl TaskbarRule {
    /// 容错提取单条规则；非对象 / id 缺失或空白 / matchType 非法 → 丢弃
    /// （None）。pattern 缺失按空串保留（恒不匹配，UI 可继续编辑）。
    fn from_json_value(v: &serde_json::Value) -> Option<Self> {
        let obj = v.as_object()?;
        let id = obj.get("id").and_then(serde_json::Value::as_str)?;
        if id.trim().is_empty() {
            return None;
        }
        let match_type = match obj.get("matchType").and_then(serde_json::Value::as_str) {
            Some("class") => TaskbarMatchType::Class,
            Some("title") => TaskbarMatchType::Title,
            Some("process") => TaskbarMatchType::Process,
            _ => return None,
        };
        Some(TaskbarRule {
            id: id.to_string(),
            match_type,
            pattern: jstr(obj.get("pattern"), ""),
            appearance: TaskbarAppearance::from_json_value(
                obj.get("appearance"),
                &TaskbarAppearance::default(),
            ),
            inactive_appearance: obj
                .get("inactiveAppearance")
                .filter(|v| v.as_object().is_some())
                .map(|v| {
                    TaskbarAppearance::from_json_value(Some(v), &TaskbarAppearance::default())
                }),
        })
    }
}

impl TaskbarStateAppearance {
    /// 容错提取单态配置。`desktop=true` 时忽略输入的 enabled（恒 None）。
    fn from_json_value(
        v: Option<&serde_json::Value>,
        default: &TaskbarStateAppearance,
        desktop: bool,
    ) -> Self {
        let appearance = TaskbarAppearance::from_json_value(v, &default.appearance);
        let enabled = if desktop {
            None
        } else {
            Some(jbool(
                v.and_then(serde_json::Value::as_object)
                    .and_then(|o| o.get("enabled")),
                default.enabled.unwrap_or(false),
            ))
        };
        Self {
            appearance,
            enabled,
        }
    }
}

fn rules_from_json_value(
    v: Option<&serde_json::Value>,
    default: &[TaskbarRule],
) -> Vec<TaskbarRule> {
    v.and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(TaskbarRule::from_json_value)
                .take(MAX_RULES_PER_STATE)
                .collect()
        })
        .unwrap_or_else(|| default.to_vec())
}

fn states_from_json_value(
    v: Option<&serde_json::Value>,
    defaults: &TaskbarStates,
) -> TaskbarStates {
    let obj = v.and_then(serde_json::Value::as_object);
    let g = |k: &str| obj.and_then(|o| o.get(k));
    TaskbarStates {
        desktop: TaskbarStateAppearance::from_json_value(g("desktop"), &defaults.desktop, true),
        visible_window: TaskbarStateAppearance::from_json_value(
            g("visibleWindow"),
            &defaults.visible_window,
            false,
        ),
        maximized_window: TaskbarStateAppearance::from_json_value(
            g("maximizedWindow"),
            &defaults.maximized_window,
            false,
        ),
        start_opened: TaskbarStateAppearance::from_json_value(
            g("startOpened"),
            &defaults.start_opened,
            false,
        ),
        search_opened: TaskbarStateAppearance::from_json_value(
            g("searchOpened"),
            &defaults.search_opened,
            false,
        ),
        task_view_opened: TaskbarStateAppearance::from_json_value(
            g("taskViewOpened"),
            &defaults.task_view_opened,
            false,
        ),
        battery_saver: TaskbarStateAppearance::from_json_value(
            g("batterySaver"),
            &defaults.battery_saver,
            false,
        ),
    }
}

fn ignored_from_json_value(
    v: Option<&serde_json::Value>,
    default: &TaskbarIgnoredWindows,
) -> TaskbarIgnoredWindows {
    let obj = v.and_then(serde_json::Value::as_object);
    let g = |k: &str| obj.and_then(|o| o.get(k));
    // 三组键都缺失 / 整体非对象 → 保留默认（出厂含 Vela 自身过滤）；
    // 只要出现任一键，就按「显式配置」口径整体重建（缺席组 = 空）。
    if g("classes").is_none() && g("titles").is_none() && g("processes").is_none() {
        return default.clone();
    }
    TaskbarIgnoredWindows {
        classes: jstring_list(g("classes"), MAX_IGNORED_PER_KIND),
        titles: jstring_list(g("titles"), MAX_IGNORED_PER_KIND),
        processes: jstring_list(g("processes"), MAX_IGNORED_PER_KIND),
    }
}

impl TaskbarOverride {
    fn from_json_value(v: &serde_json::Value) -> Option<Self> {
        let obj = v.as_object()?;
        let mut o = TaskbarOverride::default();
        if let Some(b) = obj.get("enabled").and_then(serde_json::Value::as_bool) {
            o.enabled = Some(b);
        }
        if obj.get("states").is_some_and(|v| v.as_object().is_some()) {
            o.states = Some(states_from_json_value(obj.get("states"), &default_states()));
        }
        if obj.get("rules").is_some_and(|v| v.as_object().is_some()) {
            let empty = TaskbarRules::default();
            o.rules = Some(TaskbarRules {
                visible_window: rules_from_json_value(
                    obj.get("rules").and_then(|r| r.get("visibleWindow")),
                    &empty.visible_window,
                ),
                maximized_window: rules_from_json_value(
                    obj.get("rules").and_then(|r| r.get("maximizedWindow")),
                    &empty.maximized_window,
                ),
            });
        }
        if obj
            .get("ignoredWindows")
            .is_some_and(|v| v.as_object().is_some())
        {
            o.ignored_windows = Some(ignored_from_json_value(
                obj.get("ignoredWindows"),
                &TaskbarIgnoredWindows::default(),
            ));
        }
        if let Some(b) = obj.get("perMonitor").and_then(serde_json::Value::as_bool) {
            o.per_monitor = Some(b);
        }
        Some(o)
    }
}

impl TaskbarSettings {
    /// 从「taskbar 对象本身」容错构建（IPC 参数与设置镜像共用同一条归一
    /// 路径，解析永不失败）。
    pub fn from_json_value(v: &serde_json::Value) -> Self {
        let d = TaskbarSettings::default();
        let Some(obj) = v.as_object() else {
            return d;
        };
        let mut out = TaskbarSettings {
            enabled: jbool(obj.get("enabled"), d.enabled),
            states: states_from_json_value(obj.get("states"), &d.states),
            rules: TaskbarRules {
                visible_window: rules_from_json_value(
                    obj.get("rules").and_then(|r| r.get("visibleWindow")),
                    &d.rules.visible_window,
                ),
                maximized_window: rules_from_json_value(
                    obj.get("rules").and_then(|r| r.get("maximizedWindow")),
                    &d.rules.maximized_window,
                ),
            },
            ignored_windows: ignored_from_json_value(obj.get("ignoredWindows"), &d.ignored_windows),
            per_monitor: jbool(obj.get("perMonitor"), d.per_monitor),
            monitor_overrides: HashMap::new(),
        };
        if let Some(map) = obj
            .get("monitorOverrides")
            .and_then(serde_json::Value::as_object)
        {
            for (slot, ov) in map {
                if slot.trim().is_empty() || out.monitor_overrides.len() >= MAX_MONITOR_OVERRIDES {
                    continue;
                }
                if let Some(parsed) = TaskbarOverride::from_json_value(ov) {
                    out.monitor_overrides.insert(slot.clone(), parsed);
                }
            }
        }
        out
    }

    /// 按显示器稳定槽位求「生效配置」——`per_monitor=false` 时
    /// 返回基础配置；否则用该槽位覆盖做**顶层整体替换**（不深合并）。
    pub fn effective_for_slot(&self, slot: Option<&str>) -> TaskbarSettings {
        let mut out = self.clone();
        if !self.per_monitor {
            out.monitor_overrides.clear();
            return out;
        }
        if let Some(ov) = slot.and_then(|s| self.monitor_overrides.get(s)) {
            if let Some(enabled) = ov.enabled {
                out.enabled = enabled;
            }
            if let Some(states) = &ov.states {
                out.states = states.clone();
            }
            if let Some(rules) = &ov.rules {
                out.rules = rules.clone();
            }
            if let Some(ignored) = &ov.ignored_windows {
                out.ignored_windows = ignored.clone();
            }
            if let Some(per_monitor) = ov.per_monitor {
                out.per_monitor = per_monitor;
            }
        }
        out.monitor_overrides.clear();
        out
    }
}

impl<'de> Deserialize<'de> for TaskbarSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(deserializer)?;
        Ok(TaskbarSettings::from_json_value(&v))
    }
}

/// 从设置镜像 JSON（`app:settings:v1` 快照）容错读取任务栏配置：定位
/// `general.taskbar`，任何缺失 / 类型错 / 解析失败都回默认（模式 C 读取
/// 口径，仿 clipboard.rs parse_clip_config:338-356）。
pub fn parse_taskbar_config(json: &str) -> TaskbarSettings {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return TaskbarSettings::default();
    };
    parse_taskbar_value(&v)
}

/// 同 [`parse_taskbar_config`]，但接受已解析的 JSON 值（
/// settings_mirror::read_json 已产出 Value，避免再走一遍字符串）。
pub fn parse_taskbar_value(v: &serde_json::Value) -> TaskbarSettings {
    match v
        .get("general")
        .and_then(|g| g.get("taskbar"))
        .filter(|t| t.as_object().is_some())
    {
        Some(t) => TaskbarSettings::from_json_value(t),
        None => TaskbarSettings::default(),
    }
}

/* ================================================================== *
 * STATE 区：状态机纯函数（优先级见下方列表）。
 * ------------------------------------------------------------------ */

/// 参与求值的窗口快照（由 WinEvent 层维护并喂入）。
/// `hwnd` 用 `isize` 承载 Win32 HWND 句柄值（前台等值比较键）；
/// `process` = 可执行文件名（含扩展名、不含路径，如 `Notepad.exe`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub class: String,
    pub title: String,
    pub process: String,
}

impl WindowInfo {
    pub fn new(hwnd: isize, class: &str, title: &str, process: &str) -> Self {
        Self {
            hwnd,
            class: class.to_string(),
            title: title.to_string(),
            process: process.to_string(),
        }
    }
}

/// 单显示器的实时状态输入。
///
/// 契约（状态检测层负责维护）：
/// - `maximised` / `normal` 已剔除不可见 / TOOLWINDOW / cloaked 等非用户
///   窗口；**`maximised` 按 Z 序自顶向下排列（index 0 = 最顶层最大化）**；
/// - `foreground` = 前台窗口**且位于本显示器**，在其他屏时为 None；
/// - 忽略列表过滤在 [`resolve_active_state`] 内部进行，可传原始集合。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorInputs {
    pub maximised: Vec<WindowInfo>,
    pub normal: Vec<WindowInfo>,
    pub foreground: Option<WindowInfo>,
    pub start_opened: bool,
    pub search_opened: bool,
}

/// 全局状态输入（每显示器 + 三个全局布尔）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StateInputs {
    pub monitors: Vec<MonitorInputs>,
    /// 任务视图打开（全局，Win11 ShellViewCoordinator）。
    pub task_view: bool,
    /// 系统省电模式（全局，GUID_POWER_SAVING_STATUS）。
    pub battery_saver: bool,
    /// Aero Peek 进行中（EVENT_SYSTEM_PEEKSTART/END，未公开事件 0x21/0x22）。
    pub peek_active: bool,
}

/// 单显示器一次求值的结果。`matched_rule` 为命中规则的 id（前端徽标
/// tooltip 用，如 `maximized/rule:xxx`），仅规则命中时非空。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateResolution {
    pub state: TaskbarStateKey,
    pub appearance: TaskbarAppearance,
    pub matched_rule: Option<String>,
}

/// 单条规则是否命中某窗口（三语义见 [`TaskbarMatchType`]；空 pattern 恒不匹配）。
pub fn rule_matches(rule: &TaskbarRule, win: &WindowInfo) -> bool {
    if rule.pattern.is_empty() {
        return false;
    }
    match rule.match_type {
        TaskbarMatchType::Class => win.class == rule.pattern,
        TaskbarMatchType::Title => win.title.contains(&rule.pattern),
        TaskbarMatchType::Process => process_eq(&win.process, &rule.pattern),
    }
}

/// 进程名比较：文件名大小写不敏感精确（Unicode 折叠到小写再比）。
fn process_eq(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// 忽略列表命中判定（三组任一命中
/// 即忽略；空 pattern 不参与匹配）。命中忽略列表的窗口不计入可见/最大化
/// 判断，也不作为前台参与规则匹配（不影响开始/搜索等非窗口状态）。
pub fn is_ignored(ignored: &TaskbarIgnoredWindows, win: &WindowInfo) -> bool {
    ignored
        .classes
        .iter()
        .any(|c| !c.is_empty() && *c == win.class)
        || ignored
            .processes
            .iter()
            .any(|p| !p.is_empty() && process_eq(p, &win.process))
        || ignored
            .titles
            .iter()
            .any(|t| !t.is_empty() && win.title.contains(t.as_str()))
}

/// 在规则表里找第一条命中（规则是**有序列表，先到先得**——
/// 用户排序即真源）。
fn find_rule<'a>(rules: &'a [TaskbarRule], win: &WindowInfo) -> Option<&'a TaskbarRule> {
    rules.iter().find(|r| rule_matches(r, win))
}

/// 规则命中时取哪套外观：窗口是前台 → active；非前台且有 inactive 配置
/// → inactive；非前台且无 inactive → active。
fn rule_appearance(rule: &TaskbarRule, active: bool) -> TaskbarAppearance {
    if !active {
        if let Some(inactive) = &rule.inactive_appearance {
            return inactive.clone();
        }
    }
    rule.appearance.clone()
}

/// 状态机主纯函数：对第 `monitor` 台显示器求当前生效状态与外观。
///
/// 优先级：
/// **省电 > 任务视图 > Peek 进行中（强制桌面态）> 开始菜单 > 搜索 >
/// 最大化（含规则，按 Z 序只看最顶层最大化窗口）> 可见窗口（含规则，
/// 仅当无最大化窗口时对前台窗口匹配）> 桌面**。
///
/// - 各可选态需 `enabled` 且输入为真才命中；Peek 无视 enabled 直接走桌面
///   （任务视图被 Peek 忽略，但省电/任务视图优先于 Peek）。
/// - 搜索仅在开始菜单**未**打开时判定（Win11 开始与搜索同时上报的口径
///   在喂入前归一）。
/// - 可见态的触发条件含「存在最大化窗口」（即使最大化态被
///   禁用，有最大化窗口仍算「有用户窗口」）。
/// - `monitor` 越界按空显示器处理（回落桌面态），不 panic。
pub fn resolve_active_state(
    settings: &TaskbarSettings,
    input: &StateInputs,
    monitor: usize,
) -> StateResolution {
    let empty = MonitorInputs::default();
    let m = input.monitors.get(monitor).unwrap_or(&empty);
    let ignored = &settings.ignored_windows;
    let maximised: Vec<&WindowInfo> = m
        .maximised
        .iter()
        .filter(|w| !is_ignored(ignored, w))
        .collect();
    let has_normal = m.normal.iter().any(|w| !is_ignored(ignored, w));
    let fg = m
        .foreground
        .as_ref()
        .filter(|w| !is_ignored(ignored, w))
        .map(|w| (w.hwnd, w));
    let plain = |state, appearance, matched_rule| StateResolution {
        state,
        appearance,
        matched_rule,
    };
    let states = &settings.states;

    // 1. 省电（全局）。
    if states.battery_saver.is_enabled() && input.battery_saver {
        return plain(
            TaskbarStateKey::BatterySaver,
            states.battery_saver.appearance.clone(),
            None,
        );
    }
    // 2. 任务视图（全局）。
    if states.task_view_opened.is_enabled() && input.task_view {
        return plain(
            TaskbarStateKey::TaskViewOpened,
            states.task_view_opened.appearance.clone(),
            None,
        );
    }
    // 3. Peek 进行中 → 强制桌面态（无需 enabled）。
    if input.peek_active {
        return plain(
            TaskbarStateKey::Desktop,
            states.desktop.appearance.clone(),
            None,
        );
    }
    // 4. 开始菜单（本显示器）。
    if states.start_opened.is_enabled() && m.start_opened {
        return plain(
            TaskbarStateKey::StartOpened,
            states.start_opened.appearance.clone(),
            None,
        );
    }
    // 5. 搜索（本显示器；开始打开时不判搜索——Win11 两者同开归并为开始）。
    if states.search_opened.is_enabled() && !m.start_opened && m.search_opened {
        return plain(
            TaskbarStateKey::SearchOpened,
            states.search_opened.appearance.clone(),
            None,
        );
    }
    // 6. 最大化：Z 序最顶层最大化窗口（index 0）命中规则则用规则外观
    //    （active/inactive 按该窗口是否前台），否则用默认最大化外观。
    //    只看最顶层一张（不向下继续找规则）。
    if states.maximized_window.is_enabled() && !maximised.is_empty() {
        if let Some(rule) = find_rule(&settings.rules.maximized_window, maximised[0]) {
            let active = fg.map(|(h, _)| h == maximised[0].hwnd).unwrap_or(false);
            return plain(
                TaskbarStateKey::MaximizedWindow,
                rule_appearance(rule, active),
                Some(rule.id.clone()),
            );
        }
        return plain(
            TaskbarStateKey::MaximizedWindow,
            states.maximized_window.appearance.clone(),
            None,
        );
    }
    // 7. 可见窗口：存在（未被忽略的）最大化或普通窗口即命中。规则仅当
    //    本屏无最大化窗口且前台在本屏时，对前台窗口匹配。
    if states.visible_window.is_enabled() && (!maximised.is_empty() || has_normal) {
        if maximised.is_empty() {
            if let Some((_, fgw)) = fg {
                if let Some(rule) = find_rule(&settings.rules.visible_window, fgw) {
                    // 前台窗口自身命中：恒 active。
                    return plain(
                        TaskbarStateKey::VisibleWindow,
                        rule.appearance.clone(),
                        Some(rule.id.clone()),
                    );
                }
            }
        }
        return plain(
            TaskbarStateKey::VisibleWindow,
            states.visible_window.appearance.clone(),
            None,
        );
    }
    // 8. 桌面。
    plain(
        TaskbarStateKey::Desktop,
        states.desktop.appearance.clone(),
        None,
    )
}

/* ---------------- STATE 区段 · 状态检测运行时（检测层接线） ---------------- */

/// 状态检测运行时：start/search/taskview/battery 四源 + 状态机线程
/// （150ms 合并防抖 → resolve_active_state → taskbar:state-changed）。
pub mod state;
/// WinEvent 钩子线程：九段 SetWinEventHook + PEEK + 任务栏窗口生命周期
/// 转发（TrayWindowEventCallback 注册表）。
pub mod win_event;
/// 用户窗口判定（七条件）与每显示器窗口集合（纯数据表 + Z 序）。
pub mod window;

/// 启动状态检测（幂等）：apply_taskbar_config 链路在模块开启时调用
/// （注入引擎接线后生效；当前可由手测 / 测试入口直接驱动）。
pub use state::{start_state_detection, stop_state_detection};

/* ---------------- STATE 区段 · 每屏入口 ---------------- */

/// 覆盖表键（`monitorOverrides` 的 Record 键）：显示器**稳定槽位**的十进制
/// 字串（monitor.rs `monitor:slots`，与 `list_monitors` 的 `id` / widget-N 同号），
/// 前端以 `String(monitor.id)` 写入同键。不用 HMONITOR——重排 / 热插拔会变。
pub fn slot_key(slot: u32) -> String {
    slot.to_string()
}

/// 某屏「本屏停用」（覆盖 `enabled=false`）时下发的外观：accent normal
/// （DLL 还原原 Fill）+ 顶线可见 = 该屏任务栏回系统默认，其余屏不受影响。
pub fn disabled_appearance() -> TaskbarAppearance {
    TaskbarAppearance {
        accent: TaskbarAccent::Normal,
        color: default_color(),
        show_peek: true,
        show_line: true,
        blur_radius: default_blur_radius(),
    }
}

/// 每屏求值入口：对第 `monitor` 台显示器（稳定槽位 `slot`）按其**生效
/// 配置**求值——`per_monitor=false` 即基础配置；否则用该槽位覆盖做顶层浅合并
/// （[`TaskbarSettings::effective_for_slot`]：states / rules / ignoredWindows
/// 各自整体替换，未覆盖字段沿用统一配置）。该屏覆盖 `enabled=false` →
/// 桌面态 + [`disabled_appearance`]。状态引擎逐屏调用本函数（忽略列表
/// 过滤在 [`resolve_active_state`] 内按生效列表进行，表层不预先剔窗）。
pub fn resolve_active_state_for_slot(
    settings: &TaskbarSettings,
    input: &StateInputs,
    monitor: usize,
    slot: u32,
) -> StateResolution {
    let eff = settings.effective_for_slot(Some(&slot_key(slot)));
    if !eff.enabled {
        return StateResolution {
            state: TaskbarStateKey::Desktop,
            appearance: disabled_appearance(),
            matched_rule: None,
        };
    }
    resolve_active_state(&eff, input, monitor)
}

/// 每屏入口 · 外观重取：已知某屏**当前**状态键与命中规则 id，从（新）
/// 生效配置取同源外观——配置变更后、引擎按新配置重求值前的即时基线
/// （避免 apply 时先闪一帧桌面态）。规则在生效配置里不存在（覆盖删掉了）→
/// 该态默认外观；规则窗口是否前台未知按前台取 active 外观（随后的精确
/// 重求值纠正 inactive）。状态未变时结果与引擎一致。
pub fn appearance_for_slot_state(
    settings: &TaskbarSettings,
    slot: u32,
    state: TaskbarStateKey,
    matched_rule: Option<&str>,
) -> TaskbarAppearance {
    let eff = settings.effective_for_slot(Some(&slot_key(slot)));
    if !eff.enabled {
        return disabled_appearance();
    }
    let rules = match state {
        TaskbarStateKey::VisibleWindow => Some(&eff.rules.visible_window),
        TaskbarStateKey::MaximizedWindow => Some(&eff.rules.maximized_window),
        _ => None,
    };
    if let (Some(rules), Some(id)) = (rules, matched_rule) {
        if let Some(rule) = rules.iter().find(|r| r.id == id) {
            return rule.appearance.clone();
        }
    }
    eff.states.get(state).appearance.clone()
}

/* ================================================================== *
 * COMMANDS 区：Tauri 命令（trusted_window 门控 + spawn_blocking，
 * 样板对齐 brightness.rs:872-900）。当前为空壳：模块未实现注入，
 * apply 返回可预期 Err；注入引擎就绪后填真实实现，命令名与参数
 * 不再变（新增 Rust 侧注入参数不影响前端 invoke 载荷）。
 * ------------------------------------------------------------------ */

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

static CURRENT_CONFIG: std::sync::Mutex<Option<TaskbarSettings>> = std::sync::Mutex::new(None);

fn app_handle() -> Option<&'static tauri::AppHandle> {
    APP.get()
}

/// lib.rs setup 尾部挂载：缓存 AppHandle（`taskbar:*` 事件 emit 用）→
/// 探测能力 + 升级残留检测 + 读设置镜像 `general.taskbar.enabled`（模式 C）
/// 决定是否自动起注入（[`injector::start_enabled`]）。
pub fn start(app: tauri::AppHandle) {
    let _ = APP.set(app.clone());
    log::info!("taskbar: module registered (injector wiring)");
    injector::start_enabled(&app);
}

/// RunEvent::Exit 挂点（恢复线 1）：正常退出时恢复全部任务栏为系统
/// 默认——管道 [`TapMessage::RestoreAll`] + 卸钩 + 停线程 + Idle（幂等）。
pub fn restore_all() {
    injector::restore_all();
}

pub(crate) fn current_config() -> TaskbarSettings {
    CURRENT_CONFIG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_default()
}

/// 配置存底（injector::apply_config 与命令层双写）：重建/重连后的自动
/// 重发以此为准，保证直接调引擎的入口（托盘/测试）行为与命令一致。
pub(crate) fn store_config(cfg: &TaskbarSettings) {
    *CURRENT_CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg.clone());
}

/// 注入尚未就绪时收到的配置：不能直接存底（存底语义是"已生效"，会让设置窗
/// 对账恒相等、失败后永不重试），但也不能丢——`apply_config` 已向用户承诺
/// "完成后将自动应用当前外观"。挂在这里，`on_ready` 优先取走应用并在成功后
/// 存底；后续又来新配置则覆盖旧的待生效项。
static PENDING_CONFIG: std::sync::Mutex<Option<TaskbarSettings>> = std::sync::Mutex::new(None);

pub(crate) fn store_pending_config(cfg: &TaskbarSettings) {
    *PENDING_CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg.clone());
}

pub(crate) fn take_pending_config() -> Option<TaskbarSettings> {
    PENDING_CONFIG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
}

/// 当前配置读数（设置窗启动对账用，模式 B）：最近一次 apply 成功的配置，
/// 从未 apply 过则返回出厂默认。
#[tauri::command]
pub async fn get_taskbar_config(window: tauri::Window) -> Result<TaskbarSettings, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(current_config)
        .await
        .map_err(|e| format!("任务栏配置读取任务失败: {e}"))
}

/// 整包应用任务栏配置（模式 B，原子：停旧→起新；签名与空壳一致）。返回
/// 非致命失败项清单（空 = 全部生效，含 blur→acrylic 降级备注）；致命
/// 错误走 Err（注入失败 / 版本不匹配 / 系统不支持）。
/// enabled=false：停线程 + 管道 RestoreAll + 状态 Idle；enabled=true：起/
/// 重起（幂等：已在跑则只下发新外观表，不重复注入）→ 按当前求值结果
/// （STATE 未合入时恒 desktop 态）下发 ApplyAppearance / SetBorderVisibility。
/// 配置存底由 [`injector::apply_config`] 在**生效成功后**统一写入——此处若
/// 提前写，失败后对账恒相等、设置窗永不重试。
#[tauri::command]
pub async fn apply_taskbar_config(
    window: tauri::Window,
    config: TaskbarSettings,
) -> Result<Vec<String>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        // 真实 apply 即预览终点（重新 apply = 取消预览）。
        preview_end_silently();
        injector::apply_config(&config)
    })
    .await
    .map_err(|e| format!("任务栏配置应用任务失败: {e}"))?
}

/// 运行状态快照（状态条）：注入状态机 phase + 失败/降级原因 + 任务栏
/// 类型 + 协议版本；迁移时经 `taskbar:status` 事件同型推送。
#[tauri::command]
pub async fn get_taskbar_status(
    window: tauri::Window,
) -> Result<crate::models::TaskbarStatus, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(injector::status)
        .await
        .map_err(|e| format!("任务栏状态读取任务失败: {e}"))
}

/// 重启资源管理器（DLL 升级残留的闭环动作：已加载的 DLL 无法安全卸载，
/// 重启 shell 是完成升级的唯一手段）。边界：只在用户点按钮或开启
/// 「升级后自动重启」时由前端调用，应用绝不擅自结束 shell。
#[tauri::command]
pub async fn restart_explorer(window: tauri::Window) -> Result<(), String> {
    // 杀掉 explorer 是全桌面级影响（shell 消失数秒的钓鱼窗口期），
    // 调用入口只在设置页（状态条按钮 / 升级闭环），收口到 settings-only。
    crate::require_settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(injector::restart_explorer)
        .await
        .map_err(|e| format!("资源管理器重启任务失败: {e}"))?
}

/// 能力回读：设置窗挂载时补读——事件只在启动 / 探测时 emit 一次，
/// 晚开的设置窗拿不到；已探测则返回缓存（与事件同值），否则现场探测。
#[tauri::command]
pub async fn get_taskbar_capabilities(
    window: tauri::Window,
) -> Result<crate::models::TaskbarCapabilities, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(injector::current_caps)
        .await
        .map_err(|e| format!("任务栏能力读取任务失败: {e}"))
}

/// 重置动态状态（托盘「重置任务栏状态」/快捷键 taskbar:reset-state）：
/// 立即重求值全部显示器状态并重应用（绕过幂等缓存强制重发）。
#[tauri::command]
pub async fn reset_taskbar_state(window: tauri::Window) -> Result<(), String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        // 重置即按真实配置重发：预览会话在此静默结束。
        preview_end_silently();
        injector::reset_state()
    })
    .await
    .map_err(|e| format!("任务栏状态重置任务失败: {e}"))?
}

/* ---------------- COMMANDS 区段 · 实时预览 ---------------- *
 * 两条即时通道共用一个命令：外观编辑器拖动中按 ≤80ms 步进直接下发，状态
 * 卡「预览此状态」临时强制该状态生效；期间挂起状态机输出 60s，取消 = 同
 * 命令带 null / 60s 超时 / 真实 apply·reset。全程不改配置存底、不落盘。
 * 结构仿 brightness.rs DebounceState：纯状态机（注入时钟，可测）+ condvar
 * 常驻工作线程（步进放行 / 超时自动取消），副作用一律锁外执行。
 * ------------------------------------------------------------------------ */

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// 预览步进间隔（「拖动防抖 ≤80ms」）：滑动期最多每 80ms 下发一次；
/// 首笔立即放行（跟手），尾笔最迟一个步进后落定。
pub const PREVIEW_STEP: Duration = Duration::from_millis(80);
/// 预览挂起时长：最后一次预览提交后 60s 自动取消，回到真实求值。
pub const PREVIEW_HOLD: Duration = Duration::from_secs(60);

/// 部分外观覆盖（`overrides`）：全部可选，缺省字段沿用该状态已配置的
/// 外观；前端拖动时整套外观全传，状态卡预览可只传状态键。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarPartialAppearance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accent: Option<TaskbarAccent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_peek: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_line: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blur_radius: Option<u32>,
}

impl TaskbarPartialAppearance {
    /// 合并到基准外观：坏颜色 / 越界半径逐字段回基准（与 CONFIG 区容错解析
    /// 同口径：回退而非钳制）。
    pub fn merge_into(&self, base: &TaskbarAppearance) -> TaskbarAppearance {
        TaskbarAppearance {
            accent: self.accent.unwrap_or(base.accent),
            color: self
                .color
                .as_deref()
                .and_then(normalize_hex_color)
                .unwrap_or_else(|| base.color.clone()),
            show_peek: self.show_peek.unwrap_or(base.show_peek),
            show_line: self.show_line.unwrap_or(base.show_line),
            blur_radius: self
                .blur_radius
                .filter(|r| *r <= 750)
                .unwrap_or(base.blur_radius),
        }
    }
}

/// 一笔预览请求：状态键（取基准外观、日志用）+ 合成后的完整外观。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreviewRequest {
    pub state: TaskbarStateKey,
    pub appearance: TaskbarAppearance,
}

/// 预览步进门：仿 brightness.rs `DebounceState` 的「纯状态机 + 注入时钟」，
/// 但语义按 改为**步进**而非重启式——重启式会把整段拖动憋到静默才写，
/// 预览要的是连续可感知的变化：首笔立即放行，其后每 `step` 放行一次最新
/// 值（待决项的放行时刻在暂存时定死，不被后续提交推迟），拖动停止后最后
/// 一笔最迟一个步进内落定。
pub(crate) struct PreviewGate {
    step: Duration,
    last_sent: Option<Instant>,
    pending: Option<(PreviewRequest, Instant)>,
}

impl PreviewGate {
    pub(crate) fn new(step: Duration) -> Self {
        Self {
            step,
            last_sent: None,
            pending: None,
        }
    }

    /// 提交一笔：距上次放行 ≥step（或首笔）→ 立即放行；否则暂存为待决
    /// （后到覆盖先到）。
    pub(crate) fn submit(&mut self, req: PreviewRequest, now: Instant) -> Option<PreviewRequest> {
        match self.last_sent {
            Some(last) if now < last + self.step => {
                self.pending = Some((req, last + self.step));
                None
            }
            _ => {
                self.last_sent = Some(now);
                self.pending = None;
                Some(req)
            }
        }
    }

    /// 步进到期则放行待决项。
    pub(crate) fn pop_due(&mut self, now: Instant) -> Option<PreviewRequest> {
        if !self.pending.as_ref().is_some_and(|(_, due)| *due <= now) {
            return None;
        }
        let (req, _) = self.pending.take()?;
        self.last_sent = Some(now);
        Some(req)
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.pending.as_ref().map(|(_, due)| *due)
    }

    /// 丢弃待决并重置步进（下一次提交重新算首笔，立即放行）。
    pub(crate) fn clear(&mut self) {
        self.pending = None;
        self.last_sent = None;
    }
}

/// 预览控制器产生的副作用（锁外执行，与 brightness 写入线程同款纪律）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PreviewEffect {
    /// 下发一笔预览外观到全部任务栏。`epoch` 为计算时的会话代际：执行前
    /// 复核仍为当前代才真下发——真实 apply / 取消之后不再补发陈旧预览。
    Push { epoch: u64, request: PreviewRequest },
    /// 预览结束：按真实配置重求值并重发。
    Restore,
}

/// 预览会话（纯逻辑，假时钟可测）：步进门 + 60s 挂起 + 代际。
pub(crate) struct PreviewController {
    gate: PreviewGate,
    hold: Duration,
    /// 会话代际：每次结束（取消 / 超时 / 真实 apply）推进。
    epoch: u64,
    /// 挂起截止（None = 无预览会话）。
    hold_until: Option<Instant>,
    /// 本会话是否真下发过（决定结束时是否需要 Restore）。
    pushed: bool,
}

impl PreviewController {
    pub(crate) fn new(step: Duration, hold: Duration) -> Self {
        Self {
            gate: PreviewGate::new(step),
            hold,
            epoch: 0,
            hold_until: None,
            pushed: false,
        }
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    /// 预览挂起中（状态机 apply 输出应被抑制）。
    pub(crate) fn hold_active(&self, now: Instant) -> bool {
        self.hold_until.is_some_and(|d| now < d)
    }

    /// 提交预览：刷新 60s 挂起；首笔 / 步进到点立即下发，否则待决。
    pub(crate) fn submit(&mut self, req: PreviewRequest, now: Instant) -> Vec<PreviewEffect> {
        self.hold_until = Some(now + self.hold);
        match self.gate.submit(req, now) {
            Some(request) => {
                self.pushed = true;
                vec![PreviewEffect::Push {
                    epoch: self.epoch,
                    request,
                }]
            }
            None => Vec::new(),
        }
    }

    /// 显式取消（命令带 null）：丢弃待决、结束挂起；本会话下发过才 Restore。
    pub(crate) fn cancel(&mut self) -> Vec<PreviewEffect> {
        if self.end() {
            vec![PreviewEffect::Restore]
        } else {
            Vec::new()
        }
    }

    /// 真实 apply / reset 已按真实配置下发：静默结束（不再 Restore）。
    pub(crate) fn end_silently(&mut self) {
        self.end();
    }

    /// 结束会话；返回是否曾真下发（需要恢复）。代际只在确有会话被结束时
    /// 推进（无会话的取消是 no-op，不使在飞副作用失效）。
    fn end(&mut self) -> bool {
        let had_session = self.hold_until.take().is_some();
        let pushed = std::mem::take(&mut self.pushed);
        self.gate.clear();
        if had_session || pushed {
            self.epoch += 1;
        }
        pushed
    }

    /// 到期驱动（工作线程）：挂起超时 → 自动取消（待决不再补发）；步进到期
    /// → 放行待决。
    pub(crate) fn tick(&mut self, now: Instant) -> Vec<PreviewEffect> {
        if self.hold_until.is_some_and(|d| now >= d) {
            return self.cancel();
        }
        match self.gate.pop_due(now) {
            Some(request) => {
                self.pushed = true;
                vec![PreviewEffect::Push {
                    epoch: self.epoch,
                    request,
                }]
            }
            None => Vec::new(),
        }
    }

    /// 最早需要唤醒的时刻（步进放行 / 挂起超时；None = 空闲）。
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        match (self.gate.next_deadline(), self.hold_until) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

/// 预览配置合成（纯函数）：七态外观全部替换为预览外观、清空规则、关闭
/// 每屏覆盖、强制 enabled——无论注入引擎按桌面态还是实时求值下发，结果
/// 都是预览外观（即「强制该状态生效」）。忽略列表等与外观无关的字段原样保留。
pub(crate) fn compose_preview_config(
    real: &TaskbarSettings,
    appearance: &TaskbarAppearance,
) -> TaskbarSettings {
    let mut cfg = real.clone();
    cfg.enabled = true;
    for key in TaskbarStateKey::ALL {
        let mut st = cfg.states.get(key).clone();
        st.appearance = appearance.clone();
        cfg.states.set(key, st);
    }
    cfg.rules = TaskbarRules::default();
    cfg.per_monitor = false;
    cfg.monitor_overrides.clear();
    cfg
}

struct PreviewShared {
    ctl: Mutex<PreviewController>,
    signal: Condvar,
}

/// 预览运行时（首个预览命令惰性启动工作线程，仿 brightness::shared）。
static PREVIEW: OnceLock<Arc<PreviewShared>> = OnceLock::new();

/// 预览下发串行闸：命令路径的首笔与工作线程的步进可能并发，串行化后
/// 「读真实配置 → 合成预览配置 → 直发」成为不可分割的序列。
static PREVIEW_PUSH: Mutex<()> = Mutex::new(());

/// 预览请求序号——`preview_taskbar_state` 每次调用独立
/// spawn_blocking，阻塞池不保证执行序；两次快速点卡时晚到的旧请求会成为
/// gate 的「最后提交者」（UI 钉住 B、任务栏显示 A，直到 60s/用户操作）。取号
/// 在 spawn 之前（命令分派有序），执行时已有更新请求即让位。
static PREVIEW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn preview_shared() -> Arc<PreviewShared> {
    PREVIEW
        .get_or_init(|| {
            let shared = Arc::new(PreviewShared {
                ctl: Mutex::new(PreviewController::new(PREVIEW_STEP, PREVIEW_HOLD)),
                signal: Condvar::new(),
            });
            let worker = Arc::clone(&shared);
            let _ = std::thread::Builder::new()
                .name("taskbar-preview".to_string())
                .spawn(move || preview_loop(worker));
            shared
        })
        .clone()
}

fn lock_preview(shared: &PreviewShared) -> std::sync::MutexGuard<'_, PreviewController> {
    shared.ctl.lock().unwrap_or_else(|p| p.into_inner())
}

/// 工作线程：等到最早截止（步进放行 / 60s 超时）→ tick → 锁外执行副作用。
fn preview_loop(shared: Arc<PreviewShared>) {
    loop {
        let effects = {
            let mut guard = lock_preview(&shared);
            loop {
                let now = Instant::now();
                if guard.next_deadline().is_some_and(|d| d <= now) {
                    break;
                }
                let wait = guard
                    .next_deadline()
                    .map(|d| d.saturating_duration_since(now))
                    .unwrap_or(Duration::from_secs(3600));
                guard = match shared.signal.wait_timeout(guard, wait) {
                    Ok((g, _)) => g,
                    Err(p) => p.into_inner().0,
                };
            }
            guard.tick(Instant::now())
        };
        if let Err(e) = run_preview_effects(&shared, effects) {
            log::info!("taskbar: 预览步进下发失败（{e}）");
        }
    }
}

/// 锁外执行副作用：Push 先复核会话代际（真实 apply / 取消之后的陈旧步进
/// 直接丢弃）；Restore 恒执行。
fn run_preview_effects(shared: &PreviewShared, effects: Vec<PreviewEffect>) -> Result<(), String> {
    for effect in effects {
        match effect {
            PreviewEffect::Push { epoch, request } => {
                if lock_preview(shared).epoch() != epoch {
                    continue;
                }
                push_preview_appearance(&request)?;
            }
            PreviewEffect::Restore => injector::reset_state()?,
        }
    }
    Ok(())
}

/// 直接下发预览外观：借 [`injector::send_appearance`] 的下发通路（只发消息，
/// 不存底、不触发引擎重求值）。**不走** [`injector::apply_config`]——它会先存底
/// 再请引擎全量重求值，预览配置里规则被清空（[`compose_preview_config`]），引擎
/// 会把 matched_rule=None 的分辨结果写进每屏求值缓存，预览结束用缓存重发就会
/// 在下一次精确重求值前短暂错外观。只在 Ready 时下发：未注入 / 注入中 /
/// 故障不因预览触发注入或阻塞等待。
fn push_preview_appearance(req: &PreviewRequest) -> Result<(), String> {
    let _serial = PREVIEW_PUSH.lock().unwrap_or_else(|p| p.into_inner());
    if injector::status().phase != crate::models::TaskbarPhase::Ready {
        return Err("任务栏模块未就绪，无法预览".to_string());
    }
    let preview_cfg = compose_preview_config(&current_config(), &req.appearance);
    injector::send_appearance(&preview_cfg).map(|_notes| ())
}

/// 命令实现体：锁内推进会话，锁外执行副作用（首笔立即下发 = 跟手）。
fn preview_request(
    state: Option<TaskbarStateKey>,
    overrides: Option<TaskbarPartialAppearance>,
) -> Result<(), String> {
    let shared = preview_shared();
    let effects = {
        let mut ctl = lock_preview(&shared);
        match state {
            None => ctl.cancel(),
            Some(key) => {
                let base = current_config().states.get(key).appearance.clone();
                let appearance = overrides.unwrap_or_default().merge_into(&base);
                ctl.submit(
                    PreviewRequest {
                        state: key,
                        appearance,
                    },
                    Instant::now(),
                )
            }
        }
    };
    shared.signal.notify_all();
    run_preview_effects(&shared, effects)
}

/// 真实 apply / reset 即预览终点：静默结束会话（不再补发、不再 Restore）。
fn preview_end_silently() {
    if let Some(shared) = PREVIEW.get() {
        lock_preview(shared).end_silently();
        shared.signal.notify_all();
    }
}

/// 预览挂起中：状态机 apply 输出应被抑制。供状态机 apply 回调接线处
/// （`state::set_apply_callback` 的生产实现，INJECT / POLISH）在下发前查询；
/// 预览取消 / 60s 超时 / 真实 apply 后回到 false。
pub fn preview_hold_active() -> bool {
    PREVIEW
        .get()
        .is_some_and(|shared| lock_preview(shared).hold_active(Instant::now()))
}

/// 实时预览：`state=Some` → 把该状态外观（合并 `overrides`）临时强制到
/// 全部任务栏并挂起状态机输出 60s；`state=None` → 取消预览，回到真实求值。
/// 滑动期高频调用由步进门合并为 ≤80ms 一次下发；60s 无新提交自动取消；
/// `apply_taskbar_config` / `reset_taskbar_state` 亦结束预览。不改配置、不落盘。
#[tauri::command]
pub async fn preview_taskbar_state(
    window: tauri::Window,
    state: Option<TaskbarStateKey>,
    overrides: Option<TaskbarPartialAppearance>,
) -> Result<(), String> {
    crate::require_trusted(&window)?;
    let seq = PREVIEW_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        if PREVIEW_SEQ.load(std::sync::atomic::Ordering::SeqCst) != seq {
            // 已有更新的预览请求（快速连点/紧跟的取消）：本条过期，照执行只会
            // 把 gate 的「最后提交者」翻回旧状态。
            return Ok(());
        }
        preview_request(state, overrides)
    })
    .await
    .map_err(|e| format!("任务栏预览任务失败: {e}"))?
}

/* ================================================================== *
 * EVENTS 区：事件名常量 + 负载类型 re-export + emit 助手。
 * 负载定义在 models.rs（#[derive(TS)] 导出，npm run gen:types 刷新
 * src/types/bindings/）。emit 助手统一走 start() 缓存的 AppHandle，
 * start 之前调用为安全 no-op。
 * ------------------------------------------------------------------ */

/// 注入状态机变化（状态条驱动）。负载 [`crate::models::TaskbarStatus`]。
pub const TASKBAR_STATUS_EVENT: &str = "taskbar:status";
/// 能力探测结果（启动 / 探测完成时发一次）。负载
/// [`crate::models::TaskbarCapabilities`]。
pub const TASKBAR_CAPABILITIES_EVENT: &str = "taskbar:capabilities";
/// 当前生效状态变化（徽标；仅变化时 emit，防抖 ≤200ms）。负载
/// [`crate::models::TaskbarStateChanged`]。
pub const TASKBAR_STATE_CHANGED_EVENT: &str = "taskbar:state-changed";

pub use crate::models::{TaskbarCapabilities, TaskbarStateChanged, TaskbarStatus};

fn emit_payload<T: Serialize + Clone>(event: &str, payload: T) {
    if let Some(app) = app_handle() {
        if let Err(e) = app.emit(event, payload) {
            log::warn!("taskbar: emit {event} failed: {e}");
        }
    }
}

/// 推送注入状态（注入引擎调用）。
pub fn emit_status(status: TaskbarStatus) {
    emit_payload(TASKBAR_STATUS_EVENT, status);
}

/// 推送能力探测结果（启动 / explorer 重建后调用）。
pub fn emit_capabilities(caps: TaskbarCapabilities) {
    emit_payload(TASKBAR_CAPABILITIES_EVENT, caps);
}

/// 推送某显示器当前生效状态（仅变化时；状态引擎调用）。
pub fn emit_state_changed(change: TaskbarStateChanged) {
    emit_payload(TASKBAR_STATE_CHANGED_EVENT, change);
}

/* ================================================================== *
 * 测试：状态机优先级矩阵 / 匹配语义边界 / 容错解析 / 颜色与 ABGR。
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn win(hwnd: isize, class: &str, title: &str, process: &str) -> WindowInfo {
        WindowInfo::new(hwnd, class, title, process)
    }

    fn rule(id: &str, mt: TaskbarMatchType, pattern: &str) -> TaskbarRule {
        TaskbarRule {
            id: id.to_string(),
            match_type: mt,
            pattern: pattern.to_string(),
            appearance: TaskbarAppearance {
                accent: TaskbarAccent::Opaque,
                color: "#11223344".to_string(),
                ..TaskbarAppearance::default()
            },
            inactive_appearance: None,
        }
    }

    /// 全部可选态开启的设置（在 默认之上），便于逐级测优先级。
    fn settings_all_enabled() -> TaskbarSettings {
        let mut s = TaskbarSettings::default();
        for key in TaskbarStateKey::ALL {
            if key.optional() {
                let mut st = s.states.get(key).clone();
                st.enabled = Some(true);
                s.states.set(key, st);
            }
        }
        s
    }

    fn disable(mut s: TaskbarSettings, key: TaskbarStateKey) -> TaskbarSettings {
        let mut st = s.states.get(key).clone();
        st.enabled = Some(false);
        s.states.set(key, st);
        s
    }

    /// 单显示器输入便捷构造。
    fn inputs(
        maximised: Vec<WindowInfo>,
        normal: Vec<WindowInfo>,
        foreground: Option<WindowInfo>,
    ) -> StateInputs {
        StateInputs {
            monitors: vec![MonitorInputs {
                maximised,
                normal,
                foreground,
                start_opened: false,
                search_opened: false,
            }],
            task_view: false,
            battery_saver: false,
            peek_active: false,
        }
    }

    #[test]
    fn d2_defaults_match_spec_table() {
        let s = TaskbarSettings::default();
        assert!(!s.enabled, "D1: 总开关默认关");
        let d = &s.states.desktop;
        assert_eq!(d.enabled, None, "desktop 无 enabled");
        assert_eq!(d.appearance.accent, TaskbarAccent::Clear);
        assert_eq!(d.appearance.color, "#00000000");
        assert!(!d.appearance.show_peek && !d.appearance.show_line);
        let expect = [
            (
                TaskbarStateKey::VisibleWindow,
                TaskbarAccent::Clear,
                true,
                false,
            ),
            (
                TaskbarStateKey::MaximizedWindow,
                TaskbarAccent::Acrylic,
                true,
                true,
            ),
            (
                TaskbarStateKey::StartOpened,
                TaskbarAccent::Normal,
                true,
                true,
            ),
            (
                TaskbarStateKey::SearchOpened,
                TaskbarAccent::Normal,
                true,
                true,
            ),
            (
                TaskbarStateKey::TaskViewOpened,
                TaskbarAccent::Normal,
                false,
                true,
            ),
            (
                TaskbarStateKey::BatterySaver,
                TaskbarAccent::Opaque,
                true,
                false,
            ),
        ];
        for (key, accent, peek, line) in expect {
            let st = s.states.get(key);
            assert_eq!(st.enabled, Some(false), "{key:?} D2 默认关");
            assert_eq!(st.appearance.accent, accent, "{key:?}");
            assert_eq!(st.appearance.show_peek, peek, "{key:?}");
            assert_eq!(st.appearance.show_line, line, "{key:?}");
            assert_eq!(st.appearance.blur_radius, 30, "{key:?} §4 默认半径");
        }
        // 出厂忽略列表含 Vela 自身（窗口类 + 发布/开发进程名）。
        assert_eq!(s.ignored_windows.classes, ["Tauri Window"]);
        assert!(s
            .ignored_windows
            .processes
            .contains(&"Vela.exe".to_string()));
        assert!(s
            .ignored_windows
            .processes
            .contains(&"focus-desk.exe".to_string()));
    }

    #[test]
    fn desktop_state_when_nothing_happening() {
        let s = settings_all_enabled();
        let r = resolve_active_state(&s, &inputs(vec![], vec![], None), 0);
        assert_eq!(r.state, TaskbarStateKey::Desktop);
        assert_eq!(r.matched_rule, None);
    }

    #[test]
    fn battery_saver_beats_everything() {
        let mut s = settings_all_enabled();
        let input = StateInputs {
            monitors: vec![MonitorInputs {
                maximised: vec![win(1, "Notepad", "x", "Notepad.exe")],
                normal: vec![],
                foreground: Some(win(1, "Notepad", "x", "Notepad.exe")),
                start_opened: true,
                search_opened: true,
            }],
            task_view: true,
            battery_saver: true,
            peek_active: true,
        };
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::BatterySaver
        );
        // 省电开关关掉 → 落到下一级（任务视图）。
        s = disable(s, TaskbarStateKey::BatterySaver);
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::TaskViewOpened
        );
    }

    #[test]
    fn task_view_beats_peek_start_search_maximized() {
        let s = settings_all_enabled();
        let mut input = inputs(
            vec![win(1, "Notepad", "x", "Notepad.exe")],
            vec![],
            Some(win(1, "Notepad", "x", "Notepad.exe")),
        );
        input.monitors[0].start_opened = true;
        input.monitors[0].search_opened = true;
        input.peek_active = true;
        input.task_view = true;
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::TaskViewOpened
        );
    }

    #[test]
    fn peek_forces_desktop_above_start_and_maximized() {
        let s = settings_all_enabled();
        let mut input = inputs(
            vec![win(1, "Notepad", "x", "Notepad.exe")],
            vec![],
            Some(win(1, "Notepad", "x", "Notepad.exe")),
        );
        input.monitors[0].start_opened = true;
        input.peek_active = true;
        // Peek 高于开始菜单与最大化（仅低于省电/任务视图）。
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::Desktop
        );
    }

    #[test]
    fn peek_applies_even_when_all_states_disabled() {
        // 默认配置（可选态全关）+ Peek：仍强制桌面态（Peek 不看 enabled）。
        let s = TaskbarSettings::default();
        let mut input = inputs(vec![win(1, "Notepad", "x", "Notepad.exe")], vec![], None);
        input.peek_active = true;
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::Desktop
        );
    }

    #[test]
    fn start_beats_search_and_maximized() {
        let s = settings_all_enabled();
        let mut input = inputs(
            vec![win(1, "Notepad", "x", "Notepad.exe")],
            vec![],
            Some(win(1, "Notepad", "x", "Notepad.exe")),
        );
        input.monitors[0].start_opened = true;
        input.monitors[0].search_opened = true;
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::StartOpened
        );
    }

    #[test]
    fn search_only_when_start_closed() {
        let s = settings_all_enabled();
        let mut input = inputs(vec![], vec![], None);
        input.monitors[0].search_opened = true;
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::SearchOpened
        );
        // 开始同开 → 开始优先（Win11 口径：两者同开归并到开始）。
        input.monitors[0].start_opened = true;
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::StartOpened
        );
    }

    #[test]
    fn start_and_search_are_per_monitor() {
        let s = settings_all_enabled();
        let mut input = inputs(vec![], vec![], None);
        input.monitors.push(MonitorInputs {
            maximised: vec![],
            normal: vec![],
            foreground: None,
            start_opened: false,
            search_opened: true,
        });
        assert_eq!(
            resolve_active_state(&s, &input, 1).state,
            TaskbarStateKey::SearchOpened
        );
        // 0 号屏不受 1 号屏搜索影响。
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::Desktop
        );
    }

    #[test]
    fn maximized_beats_visible() {
        let s = settings_all_enabled();
        let input = inputs(
            vec![win(1, "Notepad", "x", "Notepad.exe")],
            vec![win(2, "CabinetWClass", "folder", "explorer.exe")],
            Some(win(2, "CabinetWClass", "folder", "explorer.exe")),
        );
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::MaximizedWindow);
        assert_eq!(r.matched_rule, None);
    }

    #[test]
    fn maximized_rule_on_topmost_z_order_window() {
        let mut s = settings_all_enabled();
        s.rules.maximized_window = vec![
            rule("r-low", TaskbarMatchType::Class, "Chrome"),
            rule("r-top", TaskbarMatchType::Class, "Notepad"),
        ];
        // Z 序：Notepad 在上（index 0），Chrome 在下。顶层命中 r-top；即使
        // r-low 也能匹配下层窗口，也不该被用（只看最顶层最大化窗口）。
        let input = inputs(
            vec![
                win(10, "Notepad", "a", "Notepad.exe"),
                win(11, "Chrome", "b", "Chrome.exe"),
            ],
            vec![],
            Some(win(10, "Notepad", "a", "Notepad.exe")),
        );
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::MaximizedWindow);
        assert_eq!(r.matched_rule.as_deref(), Some("r-top"));
        assert_eq!(r.appearance.color, "#11223344");
    }

    #[test]
    fn maximized_rule_no_match_uses_default_not_lower_windows() {
        let mut s = settings_all_enabled();
        s.rules.maximized_window = vec![rule("r-chrome", TaskbarMatchType::Class, "Chrome")];
        // 顶层 Notepad 不命中 → 默认最大化外观（不继续看下层 Chrome）。
        let input = inputs(
            vec![
                win(10, "Notepad", "a", "Notepad.exe"),
                win(11, "Chrome", "b", "Chrome.exe"),
            ],
            vec![],
            Some(win(10, "Notepad", "a", "Notepad.exe")),
        );
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::MaximizedWindow);
        assert_eq!(r.matched_rule, None);
        assert_eq!(
            r.appearance.accent,
            s.states.maximized_window.appearance.accent
        );
    }

    #[test]
    fn maximized_rule_inactive_appearance_when_not_foreground() {
        let mut s = settings_all_enabled();
        let mut r0 = rule("r", TaskbarMatchType::Class, "Notepad");
        r0.inactive_appearance = Some(TaskbarAppearance {
            accent: TaskbarAccent::Blur,
            color: "#00ff00ff".to_string(),
            ..TaskbarAppearance::default()
        });
        s.rules.maximized_window = vec![r0];
        // 前台在别处（本屏 fg=None）→ inactive。
        let input = inputs(vec![win(10, "Notepad", "a", "Notepad.exe")], vec![], None);
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.appearance.accent, TaskbarAccent::Blur);
        assert_eq!(r.matched_rule.as_deref(), Some("r"));
        // 前台即该窗口 → active。
        let input2 = inputs(
            vec![win(10, "Notepad", "a", "Notepad.exe")],
            vec![],
            Some(win(10, "Notepad", "a", "Notepad.exe")),
        );
        let r2 = resolve_active_state(&s, &input2, 0);
        assert_eq!(r2.appearance.accent, TaskbarAccent::Opaque);
        assert_eq!(r2.matched_rule.as_deref(), Some("r"));
    }

    #[test]
    fn inactive_without_config_falls_back_to_active() {
        let mut s = settings_all_enabled();
        s.rules.maximized_window = vec![rule("r", TaskbarMatchType::Class, "Notepad")];
        let input = inputs(vec![win(10, "Notepad", "a", "Notepad.exe")], vec![], None);
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(
            r.appearance.accent,
            TaskbarAccent::Opaque,
            "无 inactive 配置回 active"
        );
    }

    #[test]
    fn visible_rule_matches_foreground_only_without_maximized() {
        let mut s = settings_all_enabled();
        s.rules.visible_window = vec![rule("r-note", TaskbarMatchType::Title, "备忘")];
        let input = inputs(
            vec![],
            vec![win(5, "Notepad", "工作备忘录", "Notepad.exe")],
            Some(win(5, "Notepad", "工作备忘录", "Notepad.exe")),
        );
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::VisibleWindow);
        assert_eq!(r.matched_rule.as_deref(), Some("r-note"));
    }

    #[test]
    fn visible_rule_not_matched_when_foreground_elsewhere() {
        let mut s = settings_all_enabled();
        s.rules.visible_window = vec![rule("r-note", TaskbarMatchType::Title, "备忘")];
        // 本屏有普通窗口但前台为 None（在别的屏）→ 不走规则。
        let input = inputs(
            vec![],
            vec![win(5, "Notepad", "工作备忘录", "Notepad.exe")],
            None,
        );
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::VisibleWindow);
        assert_eq!(r.matched_rule, None);
    }

    #[test]
    fn visible_rules_skipped_when_maximized_present() {
        let mut s = settings_all_enabled();
        s.rules.visible_window = vec![rule("r-note", TaskbarMatchType::Title, "备忘")];
        let input = inputs(
            vec![win(9, "Chrome", "g", "Chrome.exe")],
            vec![win(5, "Notepad", "工作备忘录", "Notepad.exe")],
            Some(win(5, "Notepad", "工作备忘录", "Notepad.exe")),
        );
        // 有最大化窗口 → 直接最大化态（可见规则不参与）。
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::MaximizedWindow);
        assert_eq!(r.matched_rule, None);
    }

    #[test]
    fn visible_no_rule_uses_default_appearance() {
        let s = settings_all_enabled();
        let input = inputs(vec![], vec![win(5, "Notepad", "x", "Notepad.exe")], None);
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::VisibleWindow);
        assert_eq!(r.matched_rule, None);
        assert_eq!(
            r.appearance.accent,
            s.states.visible_window.appearance.accent
        );
    }

    #[test]
    fn disabled_states_fall_through_to_desktop() {
        // 默认配置（全关）下任何窗口状态都回落桌面态。
        let s = TaskbarSettings::default();
        let mut input = inputs(
            vec![win(1, "Notepad", "x", "Notepad.exe")],
            vec![win(2, "A", "b", "a.exe")],
            Some(win(1, "Notepad", "x", "Notepad.exe")),
        );
        input.monitors[0].start_opened = true;
        input.monitors[0].search_opened = true;
        input.task_view = true;
        input.battery_saver = true;
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::Desktop
        );
    }

    #[test]
    fn visible_triggered_by_maximized_when_maximized_state_disabled() {
        // 可见态的触发条件含「存在最大化窗口」；最大化态被
        // 禁用时仍应落到可见态而非桌面。
        let s = disable(settings_all_enabled(), TaskbarStateKey::MaximizedWindow);
        let input = inputs(vec![win(1, "Notepad", "x", "Notepad.exe")], vec![], None);
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::VisibleWindow
        );
    }

    #[test]
    fn ignored_windows_never_trigger_states_or_rules() {
        let mut s = settings_all_enabled();
        s.rules.maximized_window = vec![rule("r", TaskbarMatchType::Class, "Notepad")];
        s.ignored_windows.classes.push("Notepad".to_string());
        // 唯一最大化窗口被忽略 → 可见层也空（normal 为空）→ 桌面。
        let input = inputs(
            vec![win(10, "Notepad", "a", "Notepad.exe")],
            vec![],
            Some(win(10, "Notepad", "a", "Notepad.exe")),
        );
        assert_eq!(
            resolve_active_state(&s, &input, 0).state,
            TaskbarStateKey::Desktop
        );
        // 被忽略的普通窗口同样不计入可见。
        let input2 = inputs(vec![], vec![win(10, "Notepad", "a", "Notepad.exe")], None);
        assert_eq!(
            resolve_active_state(&s, &input2, 0).state,
            TaskbarStateKey::Desktop
        );
        // 未被忽略的窗口正常触发最大化。
        let input3 = inputs(vec![win(11, "Word", "a", "WINWORD.EXE")], vec![], None);
        assert_eq!(
            resolve_active_state(&s, &input3, 0).state,
            TaskbarStateKey::MaximizedWindow
        );
    }

    #[test]
    fn ignored_foreground_treated_as_absent_for_rules() {
        let mut s = settings_all_enabled();
        s.rules.visible_window = vec![rule("r", TaskbarMatchType::Title, "备忘")];
        s.ignored_windows.processes.push("Notepad.exe".to_string());
        let input = inputs(
            vec![],
            vec![
                win(5, "Notepad", "工作备忘录", "Notepad.exe"),
                win(6, "Word", "d", "WINWORD.EXE"),
            ],
            Some(win(5, "Notepad", "工作备忘录", "Notepad.exe")),
        );
        // 前台（被忽略）不参与规则匹配 → 默认可见外观。
        let r = resolve_active_state(&s, &input, 0);
        assert_eq!(r.state, TaskbarStateKey::VisibleWindow);
        assert_eq!(r.matched_rule, None);
    }

    #[test]
    fn out_of_range_monitor_index_falls_back_to_desktop() {
        let s = settings_all_enabled();
        let input = inputs(vec![win(1, "Notepad", "x", "Notepad.exe")], vec![], None);
        assert_eq!(
            resolve_active_state(&s, &input, 9).state,
            TaskbarStateKey::Desktop
        );
    }

    /* ---------------- 匹配语义边界 ---------------- */

    #[test]
    fn match_semantics_class_exact_case_sensitive() {
        let w = win(1, "Notepad", "t", "p.exe");
        assert!(rule_matches(
            &rule("r", TaskbarMatchType::Class, "Notepad"),
            &w
        ));
        assert!(
            !rule_matches(&rule("r", TaskbarMatchType::Class, "notepad"), &w),
            "class 大小写敏感"
        );
        assert!(
            !rule_matches(&rule("r", TaskbarMatchType::Class, "Note"), &w),
            "class 不做子串"
        );
    }

    #[test]
    fn match_semantics_process_case_insensitive_exact() {
        let w = win(1, "c", "t", "NOTEPAD.EXE");
        assert!(rule_matches(
            &rule("r", TaskbarMatchType::Process, "notepad.exe"),
            &w
        ));
        assert!(rule_matches(
            &rule("r", TaskbarMatchType::Process, "Notepad.exe"),
            &w
        ));
        assert!(
            !rule_matches(&rule("r", TaskbarMatchType::Process, "notepad"), &w),
            "须含扩展名精确"
        );
        assert!(
            !rule_matches(
                &rule("r", TaskbarMatchType::Process, "C:\\x\\notepad.exe"),
                &w
            ),
            "不含路径"
        );
    }

    #[test]
    fn match_semantics_title_substring_case_sensitive() {
        let w = win(1, "c", "工作 - 记事本", "p.exe");
        assert!(rule_matches(
            &rule("r", TaskbarMatchType::Title, "记事本"),
            &w
        ));
        assert!(
            rule_matches(&rule("r", TaskbarMatchType::Title, "工作 - "), &w),
            "前缀也是子串"
        );
        assert!(!rule_matches(
            &rule("r", TaskbarMatchType::Title, "记事本 "),
            &w
        ));
        // 子串匹配大小写敏感。
        let w2 = win(1, "c", "My Report", "p.exe");
        assert!(rule_matches(
            &rule("r", TaskbarMatchType::Title, "Report"),
            &w2
        ));
        assert!(!rule_matches(
            &rule("r", TaskbarMatchType::Title, "report"),
            &w2
        ));
    }

    #[test]
    fn empty_pattern_never_matches() {
        let w = win(1, "", "", "");
        for mt in [
            TaskbarMatchType::Class,
            TaskbarMatchType::Title,
            TaskbarMatchType::Process,
        ] {
            assert!(
                !rule_matches(&rule("r", mt, ""), &w),
                "{mt:?} 空 pattern 不命中"
            );
        }
        // 忽略列表的空条目同理不吞掉所有窗口。
        let ignored = TaskbarIgnoredWindows {
            classes: vec![String::new()],
            titles: vec![String::new()],
            processes: vec![String::new()],
        };
        assert!(!is_ignored(&ignored, &win(1, "Any", "Any", "Any.exe")));
    }

    #[test]
    fn rule_list_order_decides_winner() {
        let w = win(1, "Chrome", "Chrome", "Chrome.exe");
        let rules = vec![
            rule("r-title", TaskbarMatchType::Title, "Chrome"),
            rule("r-class", TaskbarMatchType::Class, "Chrome"),
        ];
        // Vela 契约：有序列表先到先得（用户排序是真源）。
        assert_eq!(find_rule(&rules, &w).unwrap().id, "r-title");
    }

    /* ---------------- 容错解析 ---------------- */

    #[test]
    fn parse_taskbar_config_tolerates_missing_and_bad_fields() {
        // 空 JSON / 非 JSON / 缺 general.taskbar / taskbar 非对象 → 全默认。
        assert_eq!(parse_taskbar_config(""), TaskbarSettings::default());
        assert_eq!(parse_taskbar_config("{oops"), TaskbarSettings::default());
        assert_eq!(
            parse_taskbar_config(r#"{"general":{}}"#),
            TaskbarSettings::default()
        );
        assert_eq!(
            parse_taskbar_config(r#"{"general":{"taskbar":42}}"#),
            TaskbarSettings::default()
        );
    }

    #[test]
    fn parse_taskbar_config_bad_values_fall_back_per_field() {
        let json = r##"{"general":{"taskbar":{
            "enabled":"yes",
            "states":{"desktop":{"accent":"neon","color":"#zz","blurRadius":9999,"showPeek":1},
                      "visibleWindow":{"enabled":true,"accent":"blur","color":"#08c","blurRadius":120}},
            "rules":{"visibleWindow":[{"id":"","matchType":"class","pattern":"x"},
                                      {"id":"ok","matchType":"weird","pattern":"x"},
                                      {"id":"r1","matchType":"process","pattern":"a.EXE"},
                                      7],
                     "maximizedWindow":"nope"},
            "ignoredWindows":{"classes":"x","titles":["ok","",3],"processes":["P.exe"]},
            "perMonitor":"on",
            "monitorOverrides":{"slot-a":{"enabled":false,"states":5},"":{"enabled":true}}
        }}}"##;
        let s = parse_taskbar_config(json);
        assert!(!s.enabled, "布尔类型错回默认 false");
        // desktop 坏值全回默认（accent neon→clear、坏色→#00000000、半径越界→30）。
        let d = &s.states.desktop;
        assert_eq!(d.appearance.accent, TaskbarAccent::Clear);
        assert_eq!(d.appearance.color, "#00000000");
        assert_eq!(d.appearance.blur_radius, 30);
        assert!(!d.appearance.show_peek);
        assert_eq!(d.enabled, None, "desktop 恒无 enabled");
        // 合法字段保留：4 位色归一 #0088ccff；半径 120 在界内。
        let v = &s.states.visible_window;
        assert_eq!(v.enabled, Some(true));
        assert_eq!(v.appearance.accent, TaskbarAccent::Blur);
        assert_eq!(v.appearance.color, "#0088ccff");
        assert_eq!(v.appearance.blur_radius, 120);
        // 未提及的可选态回默认（Some(false)）。
        assert_eq!(s.states.task_view_opened.enabled, Some(false));
        // 规则：空 id / 坏 matchType / 非对象元素丢弃，合法项保留。
        assert_eq!(s.rules.visible_window.len(), 1);
        assert_eq!(s.rules.visible_window[0].id, "r1");
        assert_eq!(s.rules.visible_window[0].pattern, "a.EXE");
        assert!(s.rules.maximized_window.is_empty(), "非数组回默认空");
        // 忽略列表：非数组组丢弃；字符串数组去空串与非字符串项。
        assert!(s.ignored_windows.classes.is_empty());
        assert_eq!(s.ignored_windows.titles, ["ok"]);
        assert_eq!(s.ignored_windows.processes, ["P.exe"]);
        assert!(!s.per_monitor);
        // 覆盖表：合法槽位保留（states 坏值忽略该键）；空槽位丢弃。
        assert_eq!(s.monitor_overrides.len(), 1);
        let ov = &s.monitor_overrides["slot-a"];
        assert_eq!(ov.enabled, Some(false));
        assert!(ov.states.is_none());
    }

    #[test]
    fn parse_taskbar_config_round_trips_serialized_form() {
        // Serialize → from_json_value 幂等（线协议自洽）。
        for s in [settings_all_enabled(), TaskbarSettings::default()] {
            let json = serde_json::to_string(&s).unwrap();
            let back = TaskbarSettings::from_json_value(
                &serde_json::from_str::<serde_json::Value>(&json).unwrap(),
            );
            assert_eq!(back, s);
        }
    }

    #[test]
    fn deserialize_impl_is_tolerant_for_ipc_params() {
        // apply_taskbar_config 的 IPC 参数反序列化走同一条容错路径：垃圾
        // 字段不会让 invoke 整体失败（回默认）。
        let s: TaskbarSettings =
            serde_json::from_str(r#"{"enabled":true,"states":{"desktop":{"accent":"acrylic"}}}"#)
                .unwrap();
        assert!(s.enabled);
        assert_eq!(s.states.desktop.appearance.accent, TaskbarAccent::Acrylic);
        let fallback: TaskbarSettings = serde_json::from_str("[]").unwrap();
        assert_eq!(fallback, TaskbarSettings::default());
    }

    #[test]
    fn effective_for_slot_applies_top_level_override_only() {
        let ov = TaskbarOverride {
            enabled: Some(true),
            ignored_windows: Some(TaskbarIgnoredWindows {
                processes: vec!["Only.exe".to_string()],
                ..TaskbarIgnoredWindows::default()
            }),
            ..TaskbarOverride::default()
        };
        let mut s = TaskbarSettings {
            per_monitor: true,
            ..TaskbarSettings::default()
        };
        s.monitor_overrides.insert("slot-1".to_string(), ov);
        let eff = s.effective_for_slot(Some("slot-1"));
        assert!(eff.enabled);
        assert_eq!(eff.ignored_windows.processes, ["Only.exe"]);
        // 未覆盖字段沿用基础配置；未命中的槽位 = 基础配置。
        assert_eq!(eff.states, s.states);
        let eff2 = s.effective_for_slot(Some("slot-404"));
        assert!(!eff2.enabled);
        // perMonitor=false 时忽略一切覆盖。
        s.per_monitor = false;
        assert_eq!(
            s.effective_for_slot(Some("slot-1")).ignored_windows,
            s.ignored_windows
        );
    }

    /* ---------------- 覆盖合并边界（空覆盖 / 部分覆盖 / 坏 slot） ---------------- */

    /// 基础配置：per_monitor 开、可选态全开、desktop 蓝色、一条最大化规则。
    fn per_monitor_base() -> TaskbarSettings {
        let mut s = settings_all_enabled();
        s.enabled = true;
        s.per_monitor = true;
        s.states.desktop.appearance.color = "#0000ffff".to_string();
        s.rules.maximized_window = vec![rule("r-note", TaskbarMatchType::Class, "Notepad")];
        s
    }

    #[test]
    fn effective_for_slot_empty_override_is_identity() {
        // 空覆盖（全字段 None）= 基础配置（覆盖表清空后逐字段相等）。
        let mut s = per_monitor_base();
        s.monitor_overrides
            .insert("1".to_string(), TaskbarOverride::default());
        let eff = s.effective_for_slot(Some("1"));
        let mut expect = s.clone();
        expect.monitor_overrides.clear();
        assert_eq!(eff, expect);
        // 与「无覆盖」槽位结果一致。
        assert_eq!(eff, s.effective_for_slot(Some("7")));
    }

    #[test]
    fn effective_for_slot_partial_override_is_shallow_field_replacement() {
        // 部分覆盖：只给 states → states 整体替换（覆盖内未改的 desktop 也
        // 取覆盖 states 的值，不与基础深合并），rules / ignored 沿用基础。
        let mut s = per_monitor_base();
        let mut ov_states = default_states();
        ov_states.maximized_window.appearance.accent = TaskbarAccent::Opaque;
        ov_states.maximized_window.enabled = Some(true);
        s.monitor_overrides.insert(
            "1".to_string(),
            TaskbarOverride {
                states: Some(ov_states.clone()),
                ..TaskbarOverride::default()
            },
        );
        let eff = s.effective_for_slot(Some("1"));
        assert_eq!(eff.states, ov_states, "states 整体替换");
        assert_eq!(
            eff.states.desktop.appearance.color, "#00000000",
            "覆盖 states 的 desktop 是出厂色，不回落到基础的蓝色（浅合并）"
        );
        assert_eq!(eff.rules, s.rules, "未覆盖 rules 沿用基础");
        assert_eq!(eff.ignored_windows, s.ignored_windows);
        assert!(eff.enabled && eff.per_monitor);
        assert!(eff.monitor_overrides.is_empty(), "生效配置不再携带覆盖表");
        // 只给 rules：空规则表也算「显式覆盖」→ 基础规则被清空。
        let mut s2 = per_monitor_base();
        s2.monitor_overrides.insert(
            "1".to_string(),
            TaskbarOverride {
                rules: Some(TaskbarRules::default()),
                ..TaskbarOverride::default()
            },
        );
        assert!(s2
            .effective_for_slot(Some("1"))
            .rules
            .maximized_window
            .is_empty());
        assert_eq!(s2.effective_for_slot(Some("1")).states, s2.states);
    }

    #[test]
    fn effective_for_slot_bad_slot_falls_back_to_base() {
        let mut s = per_monitor_base();
        s.monitor_overrides.insert(
            "1".to_string(),
            TaskbarOverride {
                enabled: Some(false),
                ..TaskbarOverride::default()
            },
        );
        let mut base = s.clone();
        base.monitor_overrides.clear();
        // 未知槽位 / 空串 / 空白 / None / 大小写或前后空白不同的键 → 基础配置。
        for bad in [
            Some("404"),
            Some(""),
            Some("  "),
            Some(" 1"),
            Some("1 "),
            None,
        ] {
            assert_eq!(s.effective_for_slot(bad), base, "坏 slot {bad:?}");
        }
        // 解析层：空白槽位键直接丢弃，不进入覆盖表。
        let parsed = TaskbarSettings::from_json_value(&serde_json::json!({
            "perMonitor": true,
            "monitorOverrides": { " ": {"enabled": false}, "": {"enabled": false}, "2": {"enabled": false} }
        }));
        assert_eq!(parsed.monitor_overrides.len(), 1);
        assert!(parsed.monitor_overrides.contains_key("2"));
    }

    #[test]
    fn slot_key_is_decimal_slot() {
        assert_eq!(slot_key(0), "0");
        assert_eq!(slot_key(3), "3");
    }

    #[test]
    fn resolve_for_slot_unified_ignores_overrides() {
        let mut s = per_monitor_base();
        s.per_monitor = false;
        let mut ov_states = default_states();
        ov_states.desktop.appearance.color = "#ff0000ff".to_string();
        s.monitor_overrides.insert(
            "1".to_string(),
            TaskbarOverride {
                states: Some(ov_states),
                ..TaskbarOverride::default()
            },
        );
        let input = inputs(vec![], vec![], None);
        // 统一模式：两屏同为基础桌面色。
        for slot in [0, 1] {
            let r = resolve_active_state_for_slot(&s, &input, 0, slot);
            assert_eq!(r.state, TaskbarStateKey::Desktop);
            assert_eq!(r.appearance.color, "#0000ffff", "slot {slot}");
        }
    }

    #[test]
    fn resolve_for_slot_applies_override_states_rules_and_ignored() {
        let mut s = per_monitor_base();
        // 槽位 1：桌面红色 + 忽略 Notepad + 清空规则。
        let mut ov_states = default_states();
        ov_states.desktop.appearance.color = "#ff0000ff".to_string();
        ov_states.maximized_window.enabled = Some(true);
        s.monitor_overrides.insert(
            "1".to_string(),
            TaskbarOverride {
                states: Some(ov_states),
                rules: Some(TaskbarRules::default()),
                ignored_windows: Some(TaskbarIgnoredWindows {
                    classes: vec!["Notepad".to_string()],
                    ..TaskbarIgnoredWindows::default()
                }),
                ..TaskbarOverride::default()
            },
        );
        // 两屏输入：0 号屏桌面，1 号屏 Notepad 最大化。
        let mut input = inputs(vec![], vec![], None);
        input.monitors.push(MonitorInputs {
            maximised: vec![win(1, "Notepad", "x", "Notepad.exe")],
            ..MonitorInputs::default()
        });
        // 「逐屏覆盖后两屏桌面态不同」：0 号屏基础蓝、1 号屏覆盖红。
        let r0 = resolve_active_state_for_slot(&s, &input, 0, 0);
        assert_eq!(r0.state, TaskbarStateKey::Desktop);
        assert_eq!(r0.appearance.color, "#0000ffff");
        let r1 = resolve_active_state_for_slot(&s, &input, 1, 1);
        // 1 号屏：Notepad 在覆盖忽略列表 → 不算最大化 → 桌面态（覆盖红）。
        assert_eq!(r1.state, TaskbarStateKey::Desktop);
        assert_eq!(r1.appearance.color, "#ff0000ff");
        // 同一输入按 0 号屏配置（无忽略、有规则）求 1 号显示器 → 命中规则。
        let r1_base = resolve_active_state_for_slot(&s, &input, 1, 0);
        assert_eq!(r1_base.state, TaskbarStateKey::MaximizedWindow);
        assert_eq!(r1_base.matched_rule.as_deref(), Some("r-note"));
        // 覆盖把规则清空但不忽略 → 默认最大化外观（无规则）。
        s.monitor_overrides.get_mut("1").unwrap().ignored_windows = None;
        let r1_norule = resolve_active_state_for_slot(&s, &input, 1, 1);
        assert_eq!(r1_norule.state, TaskbarStateKey::MaximizedWindow);
        assert_eq!(r1_norule.matched_rule, None);
    }

    #[test]
    fn resolve_for_slot_disabled_override_restores_that_monitor_only() {
        let mut s = per_monitor_base();
        s.monitor_overrides.insert(
            "1".to_string(),
            TaskbarOverride {
                enabled: Some(false),
                ..TaskbarOverride::default()
            },
        );
        let input = inputs(vec![win(1, "Notepad", "x", "Notepad.exe")], vec![], None);
        let r1 = resolve_active_state_for_slot(&s, &input, 0, 1);
        assert_eq!(r1.state, TaskbarStateKey::Desktop);
        assert_eq!(r1.appearance, disabled_appearance());
        assert_eq!(
            r1.appearance.accent,
            TaskbarAccent::Normal,
            "normal = 回系统默认"
        );
        assert!(r1.appearance.show_line, "顶线回可见");
        // 其余屏照常求值。
        let r0 = resolve_active_state_for_slot(&s, &input, 0, 0);
        assert_eq!(r0.state, TaskbarStateKey::MaximizedWindow);
    }

    #[test]
    fn appearance_for_slot_state_re_derives_from_effective_config() {
        let mut s = per_monitor_base();
        let mut ov_states = default_states();
        ov_states.maximized_window.appearance.accent = TaskbarAccent::Blur;
        s.monitor_overrides.insert(
            "1".to_string(),
            TaskbarOverride {
                states: Some(ov_states),
                rules: Some(TaskbarRules::default()),
                ..TaskbarOverride::default()
            },
        );
        // 0 号屏（基础）：最大化 + 命中 r-note → 规则外观（opaque #11223344）。
        let a0 = appearance_for_slot_state(&s, 0, TaskbarStateKey::MaximizedWindow, Some("r-note"));
        assert_eq!(a0.accent, TaskbarAccent::Opaque);
        assert_eq!(a0.color, "#11223344");
        // 1 号屏覆盖删掉了规则 → 该态默认外观（覆盖 states 的 blur）。
        let a1 = appearance_for_slot_state(&s, 1, TaskbarStateKey::MaximizedWindow, Some("r-note"));
        assert_eq!(a1.accent, TaskbarAccent::Blur);
        // 无规则 id：取该态外观；桌面态取桌面外观（基础蓝）。
        assert_eq!(
            appearance_for_slot_state(&s, 0, TaskbarStateKey::Desktop, None).color,
            "#0000ffff"
        );
        // 非规则态传入规则 id 也只取该态外观（规则仅 visible / maximized 有效）。
        assert_eq!(
            appearance_for_slot_state(&s, 0, TaskbarStateKey::StartOpened, Some("r-note")),
            s.states.start_opened.appearance
        );
        // 本屏停用 → disabled 外观。
        s.monitor_overrides.get_mut("1").unwrap().enabled = Some(false);
        assert_eq!(
            appearance_for_slot_state(&s, 1, TaskbarStateKey::MaximizedWindow, None),
            disabled_appearance()
        );
    }

    /* ---------------- 颜色 / ABGR ---------------- */

    #[test]
    fn color_normalization_forms() {
        let n = |s: &str| normalize_hex_color(s);
        assert_eq!(n("#fff").as_deref(), Some("#ffffffff"));
        assert_eq!(n("#FFFF").as_deref(), Some("#ffffffff"));
        assert_eq!(n("#AbCdEf").as_deref(), Some("#abcdefff"));
        assert_eq!(n("#AABBCCDD").as_deref(), Some("#aabbccdd"));
        assert_eq!(
            n("  #aabbccdd  ").as_deref(),
            Some("#aabbccdd"),
            "前后空白宽容"
        );
        assert_eq!(n("#12345"), None);
        assert_eq!(n("aabbccdd"), None, "缺 # 前缀");
        assert_eq!(n("#gggggg"), None);
        assert_eq!(n(""), None);
    }

    #[test]
    fn color_abgr_packing() {
        let mut a = TaskbarAppearance {
            color: "#8040c0ff".to_string(), // r=80 g=40 b=c0 a=ff
            ..TaskbarAppearance::default()
        };
        assert_eq!(a.color_abgr(), protocol::pack_abgr(0x80, 0x40, 0xc0, 0xff));
        a.color = "bad".to_string();
        assert_eq!(a.color_abgr(), 0, "坏色按全零");
    }
}

/* ================================================================== *
 * 测试 · 实时预览：步进门假时钟 / 会话（预览→取消→
 * 恢复的副作用序列，mock 下发面）/ 60s 超时 / 代际复核 / overrides 合并
 * 容错 / 预览配置合成不触碰真实配置。
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod preview_tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn req(state: TaskbarStateKey, color: &str) -> PreviewRequest {
        PreviewRequest {
            state,
            appearance: TaskbarAppearance {
                color: color.to_string(),
                ..TaskbarAppearance::default()
            },
        }
    }

    /// mock 下发面：按 [`run_preview_effects`] 同款纪律执行副作用（Push 复核
    /// 代际、Restore 恒执行），只记录序列不碰注入引擎。
    #[derive(Default)]
    struct MockSink {
        log: Vec<String>,
    }

    impl MockSink {
        fn run(&mut self, current_epoch: u64, effects: Vec<PreviewEffect>) {
            for effect in effects {
                match effect {
                    PreviewEffect::Push { epoch, request } => {
                        if epoch != current_epoch {
                            self.log.push("skip-stale".to_string());
                            continue;
                        }
                        self.log.push(format!(
                            "push {:?} {}",
                            request.state, request.appearance.color
                        ));
                    }
                    PreviewEffect::Restore => self.log.push("restore".to_string()),
                }
            }
        }
    }

    /// 驱动一步：先在控制器上计算副作用（锁内），再按当前代际执行（锁外）
    /// ——与命令路径 / 工作线程的先后一致。
    fn drive(
        sink: &mut MockSink,
        ctl: &mut PreviewController,
        step: impl FnOnce(&mut PreviewController) -> Vec<PreviewEffect>,
    ) {
        let effects = step(ctl);
        sink.run(ctl.epoch(), effects);
    }

    /* ---------------- 步进门（假时钟） ---------------- */

    #[test]
    fn preview_gate_first_submit_immediate_then_80ms_steps() {
        let mut gate = PreviewGate::new(ms(80));
        let t0 = Instant::now();
        // 首笔立即放行（跟手）。
        assert!(gate
            .submit(req(TaskbarStateKey::Desktop, "#1"), t0)
            .is_some());
        assert_eq!(gate.next_deadline(), None);
        // 滑动风暴：16ms 一笔，全部暂存，后到覆盖先到；放行时刻固定为 t0+80。
        for i in 1..=4 {
            let now = t0 + ms(16 * i);
            assert!(
                gate.submit(req(TaskbarStateKey::Desktop, &format!("#{i}")), now)
                    .is_none(),
                "第 {i} 笔在步进窗内应暂存"
            );
            assert_eq!(
                gate.next_deadline(),
                Some(t0 + ms(80)),
                "放行时刻不被后续提交推迟"
            );
        }
        assert!(gate.pop_due(t0 + ms(79)).is_none(), "未到步进不放行");
        let popped = gate.pop_due(t0 + ms(80)).expect("步进到点放行");
        assert_eq!(popped.appearance.color, "#4", "放行的是最后一笔");
        assert_eq!(gate.next_deadline(), None);
        // 下一个步进窗从放行时刻起算：t0+81 暂存，t0+160 放行。
        assert!(gate
            .submit(req(TaskbarStateKey::Desktop, "#5"), t0 + ms(81))
            .is_none());
        assert_eq!(gate.next_deadline(), Some(t0 + ms(160)));
        assert!(gate.pop_due(t0 + ms(159)).is_none());
        assert_eq!(
            gate.pop_due(t0 + ms(160)).unwrap().appearance.color,
            "#5",
            "拖动停止后最后一笔最迟一个步进内落定"
        );
        // 静默足够久后再来一笔 → 立即放行。
        assert!(gate
            .submit(req(TaskbarStateKey::Desktop, "#6"), t0 + ms(1000))
            .is_some());
    }

    #[test]
    fn preview_gate_clear_drops_pending_and_resets_leading_edge() {
        let mut gate = PreviewGate::new(ms(80));
        let t0 = Instant::now();
        assert!(gate
            .submit(req(TaskbarStateKey::Desktop, "#a"), t0)
            .is_some());
        assert!(gate
            .submit(req(TaskbarStateKey::Desktop, "#b"), t0 + ms(10))
            .is_none());
        gate.clear();
        assert_eq!(gate.next_deadline(), None, "待决被丢弃");
        assert!(gate.pop_due(t0 + ms(80)).is_none());
        // 清空后下一笔重新算首笔：即便仍在原步进窗内也立即放行。
        assert!(gate
            .submit(req(TaskbarStateKey::Desktop, "#c"), t0 + ms(20))
            .is_some());
    }

    /* ---------------- 会话：预览 → 取消 → 恢复（mock 下发面） ---------------- */

    #[test]
    fn preview_session_sequence_preview_steps_cancel_restore() {
        let mut ctl = PreviewController::new(ms(80), PREVIEW_HOLD);
        let mut sink = MockSink::default();
        let t0 = Instant::now();
        assert!(!ctl.hold_active(t0), "无会话不挂起");
        assert_eq!(ctl.next_deadline(), None);

        // 首笔立即下发并进入 60s 挂起。
        drive(&mut sink, &mut ctl, |c| {
            c.submit(req(TaskbarStateKey::MaximizedWindow, "#ff0000ff"), t0)
        });
        assert!(ctl.hold_active(t0 + ms(1)));
        assert_eq!(
            ctl.next_deadline(),
            Some(t0 + PREVIEW_HOLD),
            "空闲时只等超时"
        );

        // 步进窗内两笔暂存（后到覆盖）；到点由 tick 放行最后一笔。
        drive(&mut sink, &mut ctl, |c| {
            c.submit(
                req(TaskbarStateKey::MaximizedWindow, "#00ff00ff"),
                t0 + ms(16),
            )
        });
        drive(&mut sink, &mut ctl, |c| {
            c.submit(
                req(TaskbarStateKey::MaximizedWindow, "#0000ffff"),
                t0 + ms(32),
            )
        });
        assert_eq!(
            ctl.next_deadline(),
            Some(t0 + ms(80)),
            "步进截止早于挂起截止"
        );
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(79)));
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(80)));

        // 再来一笔暂存后显式取消：待决丢弃、Restore 一次、挂起结束。
        drive(&mut sink, &mut ctl, |c| {
            c.submit(
                req(TaskbarStateKey::MaximizedWindow, "#ffffffff"),
                t0 + ms(100),
            )
        });
        let cancel = ctl.cancel();
        assert_eq!(cancel, vec![PreviewEffect::Restore]);
        sink.run(ctl.epoch(), cancel);
        assert!(!ctl.hold_active(t0 + ms(101)));
        assert_eq!(ctl.next_deadline(), None);
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(160)));
        // 重复取消不重复恢复。
        assert!(ctl.cancel().is_empty());

        assert_eq!(
            sink.log,
            vec![
                "push MaximizedWindow #ff0000ff",
                "push MaximizedWindow #0000ffff",
                "restore",
            ]
        );
    }

    #[test]
    fn preview_session_times_out_after_hold_and_restores_once() {
        let mut ctl = PreviewController::new(ms(80), ms(60_000));
        let mut sink = MockSink::default();
        let t0 = Instant::now();
        drive(&mut sink, &mut ctl, |c| {
            c.submit(req(TaskbarStateKey::Desktop, "#1"), t0)
        });
        // 期间再提交会刷新挂起截止。
        drive(&mut sink, &mut ctl, |c| {
            c.submit(req(TaskbarStateKey::Desktop, "#2"), t0 + ms(10_000))
        });
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(60_000)));
        assert!(ctl.hold_active(t0 + ms(69_999)), "截止随最后一次提交后延");
        assert_eq!(ctl.next_deadline(), Some(t0 + ms(70_000)));
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(69_999)));
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(70_000)));
        assert!(!ctl.hold_active(t0 + ms(70_000)));
        assert_eq!(ctl.next_deadline(), None);
        // 超时后继续 tick / cancel 都不再产生副作用。
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(80_000)));
        assert!(ctl.cancel().is_empty());
        assert_eq!(
            sink.log,
            vec!["push Desktop #1", "push Desktop #2", "restore"]
        );
    }

    #[test]
    fn preview_session_timeout_drops_pending_step_instead_of_pushing_it() {
        // 挂起截止早于步进到期：超时优先，待决不补发，直接回真实。
        let mut ctl = PreviewController::new(ms(80), ms(40));
        let mut sink = MockSink::default();
        let t0 = Instant::now();
        drive(&mut sink, &mut ctl, |c| {
            c.submit(req(TaskbarStateKey::Desktop, "#1"), t0)
        });
        // 第二笔待决（步进 t0+80），同时把挂起截止刷到 t0+50 → 挂起先到。
        drive(&mut sink, &mut ctl, |c| {
            c.submit(req(TaskbarStateKey::Desktop, "#2"), t0 + ms(10))
        });
        assert_eq!(ctl.next_deadline(), Some(t0 + ms(50)));
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(50)));
        assert_eq!(ctl.next_deadline(), None, "待决随会话一并丢弃");
        drive(&mut sink, &mut ctl, |c| c.tick(t0 + ms(80)));
        assert_eq!(sink.log, vec!["push Desktop #1", "restore"]);
    }

    #[test]
    fn preview_cancel_without_any_push_is_a_noop() {
        let mut ctl = PreviewController::new(ms(80), PREVIEW_HOLD);
        assert!(ctl.cancel().is_empty(), "从未预览过 → 无需恢复");
        ctl.end_silently();
        assert!(ctl.cancel().is_empty());
    }

    #[test]
    fn real_apply_ends_session_silently_and_stale_push_is_skipped() {
        let mut ctl = PreviewController::new(ms(80), PREVIEW_HOLD);
        let mut sink = MockSink::default();
        let t0 = Instant::now();
        let first = ctl.submit(req(TaskbarStateKey::Desktop, "#a"), t0);
        assert!(matches!(first[0], PreviewEffect::Push { epoch: 0, .. }));
        // 副作用尚未执行时真实 apply 到来：静默结束（无 Restore），代际推进。
        ctl.end_silently();
        assert_eq!(ctl.epoch(), 1);
        assert!(!ctl.hold_active(t0 + ms(1)));
        sink.run(ctl.epoch(), first);
        assert_eq!(sink.log, vec!["skip-stale"], "陈旧预览不再补发");
        // 之后再取消无事可做（会话已被真实 apply 终结）。
        assert!(ctl.cancel().is_empty());
        // 新会话从首笔重新开始：立即放行且带新代际。
        let second = ctl.submit(req(TaskbarStateKey::Desktop, "#b"), t0 + ms(1));
        assert!(matches!(second[0], PreviewEffect::Push { epoch: 1, .. }));
        sink.run(ctl.epoch(), second);
        assert_eq!(sink.log, vec!["skip-stale", "push Desktop #b"]);
    }

    /* ---------------- overrides 合并 / 线协议形状 ---------------- */

    #[test]
    fn partial_appearance_merge_is_field_wise_and_tolerant() {
        let base = TaskbarAppearance {
            accent: TaskbarAccent::Acrylic,
            color: "#11223344".to_string(),
            show_peek: true,
            show_line: false,
            blur_radius: 42,
        };
        // 空覆盖 = 基准。
        assert_eq!(TaskbarPartialAppearance::default().merge_into(&base), base);
        // 合法字段覆盖并归一：#abc → #aabbccff；半径界内保留。
        let good = TaskbarPartialAppearance {
            color: Some("#abc".to_string()),
            blur_radius: Some(750),
            show_line: Some(true),
            ..TaskbarPartialAppearance::default()
        };
        let merged = good.merge_into(&base);
        assert_eq!(merged.color, "#aabbccff");
        assert_eq!(merged.blur_radius, 750);
        assert!(merged.show_line && merged.show_peek);
        assert_eq!(merged.accent, TaskbarAccent::Acrylic, "未覆盖字段沿用基准");
        // 坏颜色 / 越界半径逐字段回基准（回退而非钳制）。
        let bad = TaskbarPartialAppearance {
            color: Some("#zz".to_string()),
            blur_radius: Some(751),
            accent: Some(TaskbarAccent::Blur),
            ..TaskbarPartialAppearance::default()
        };
        let merged = bad.merge_into(&base);
        assert_eq!(merged.color, base.color);
        assert_eq!(merged.blur_radius, 42);
        assert_eq!(merged.accent, TaskbarAccent::Blur);
    }

    #[test]
    fn partial_appearance_wire_shape_is_camel_case_with_all_optional() {
        // 前端 invoke 载荷：只传部分字段 / 整套外观 / 空对象都可解析。
        let p: TaskbarPartialAppearance =
            serde_json::from_str(r##"{"color":"#ff000080","blurRadius":12}"##).unwrap();
        assert_eq!(p.color.as_deref(), Some("#ff000080"));
        assert_eq!(p.blur_radius, Some(12));
        assert_eq!(p.accent, None);
        let empty: TaskbarPartialAppearance = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, TaskbarPartialAppearance::default());
        let full: TaskbarPartialAppearance = serde_json::from_str(
            r##"{"accent":"blur","color":"#0088ccff","showPeek":true,"showLine":false,"blurRadius":30}"##,
        )
        .unwrap();
        assert_eq!(full.accent, Some(TaskbarAccent::Blur));
        assert_eq!(full.show_peek, Some(true));
        assert_eq!(full.show_line, Some(false));
        // 序列化跳过 None（与 inactiveAppearance 的 skip_serializing_if 同约定）。
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r##"{"color":"#ff000080","blurRadius":12}"##
        );
        // state 键与前端 TaskbarStateKey 同拼写。
        let key: Option<TaskbarStateKey> = serde_json::from_str(r#""taskViewOpened""#).unwrap();
        assert_eq!(key, Some(TaskbarStateKey::TaskViewOpened));
        let none: Option<TaskbarStateKey> = serde_json::from_str("null").unwrap();
        assert_eq!(none, None, "state=null 即取消预览");
    }

    /* ---------------- 预览配置合成：强制生效 + 不触碰真实配置 ---------------- */

    #[test]
    fn compose_preview_config_forces_every_state_and_leaves_real_config_untouched() {
        let mut real = TaskbarSettings {
            enabled: false,
            per_monitor: true,
            ..TaskbarSettings::default()
        };
        real.rules.maximized_window.push(TaskbarRule {
            id: "r".to_string(),
            match_type: TaskbarMatchType::Class,
            pattern: "Notepad".to_string(),
            appearance: TaskbarAppearance::default(),
            inactive_appearance: None,
        });
        real.monitor_overrides
            .insert("slot-1".to_string(), TaskbarOverride::default());
        real.ignored_windows.titles.push("keep".to_string());
        let before = real.clone();
        let stored_before = current_config();

        let preview = TaskbarAppearance {
            accent: TaskbarAccent::Opaque,
            color: "#12345678".to_string(),
            show_peek: false,
            show_line: true,
            blur_radius: 7,
        };
        let cfg = compose_preview_config(&real, &preview);

        assert!(
            cfg.enabled,
            "预览借道 apply 必须 enabled，否则会触发 restore_all"
        );
        for key in TaskbarStateKey::ALL {
            assert_eq!(
                cfg.states.get(key).appearance,
                preview,
                "{key:?} 外观被强制为预览外观"
            );
        }
        // 开关位保留（desktop 恒 None；可选态沿用真实配置的 enabled），
        // 但因七态外观相同，无论求值命中哪一态结果都是预览外观。
        assert_eq!(cfg.states.desktop.enabled, None);
        assert_eq!(cfg.states.maximized_window.enabled, Some(false));
        assert!(cfg.rules.maximized_window.is_empty() && cfg.rules.visible_window.is_empty());
        assert!(!cfg.per_monitor && cfg.monitor_overrides.is_empty());
        assert_eq!(
            cfg.ignored_windows.titles,
            ["keep"],
            "与外观无关字段原样保留"
        );
        // 任一输入求值都得到预览外观（含把可选态全开的极端情形）。
        let mut all_on = cfg.clone();
        for key in TaskbarStateKey::ALL {
            if key.optional() {
                let mut st = all_on.states.get(key).clone();
                st.enabled = Some(true);
                all_on.states.set(key, st);
            }
        }
        let busy = StateInputs {
            monitors: vec![MonitorInputs {
                maximised: vec![WindowInfo::new(1, "Notepad", "x", "Notepad.exe")],
                normal: vec![],
                foreground: None,
                start_opened: true,
                search_opened: true,
            }],
            task_view: true,
            battery_saver: true,
            peek_active: false,
        };
        assert_eq!(resolve_active_state(&all_on, &busy, 0).appearance, preview);
        assert_eq!(
            resolve_active_state(&cfg, &StateInputs::default(), 0).appearance,
            preview
        );
        // 纯函数：真实配置与配置存底都未被触碰（预览不改配置、不落盘）。
        assert_eq!(real, before);
        assert_eq!(current_config(), stored_before);
    }

    #[test]
    fn preview_runtime_hooks_are_safe_before_first_preview() {
        // 尚未有任何预览命令：挂起谓词为 false、静默结束为 no-op（不启动线程）。
        assert!(!preview_hold_active());
        preview_end_silently();
        assert!(!preview_hold_active());
        assert!(PREVIEW.get().is_none(), "只读入口不得惰性拉起工作线程");
    }
}
