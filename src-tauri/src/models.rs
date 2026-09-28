//! IPC 线协议模型：与前端 sqlite.ts 对应的请求/响应结构。
//! 经 ts-rs 导出 TS 绑定到 src/types/bindings/（cargo test 刷新）。
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// IPC/备份跨语言类型的单一来源：改这里的字段后跑 `cargo test`
/// 重新生成 src/types/bindings/*.ts，前端 sqlite.ts 直接引用，
/// 不再手写第二份 snake_case 映射（此前 RustTask 等手写接口已开始漂移）。
fn default_empty() -> String {
    String::new()
}

fn default_zero() -> i64 {
    0
}

fn default_tags() -> String {
    "[]".to_string()
}

fn default_repeat() -> String {
    "none".to_string()
}

fn default_kind() -> String {
    "info".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub completed: bool,
    pub created_at: String,
    /// W-043 截止时间（ISO 字符串；空 = 无截止）。旧备份缺省为空。
    #[serde(default = "default_empty")]
    pub due_at: String,
    /// W-043 优先级：0 无 / 1 低 / 2 中 / 3 高。
    #[serde(default = "default_zero")]
    #[ts(type = "number")]
    pub priority: i64,
    /// W-043 标签（JSON 数组字符串，如 `["工作"]`）。
    #[serde(default = "default_tags")]
    pub tags: String,
    /// W-045 手动排序权重（小的在前）。
    #[serde(default = "default_zero")]
    #[ts(type = "number")]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct Deadline {
    pub id: String,
    pub title: String,
    pub due_at: String,
    pub notified: bool,
    pub completed: bool,
    /// W-046 已发送提醒档位（JSON 数组字符串，如 `["24h","1h"]`）。
    #[serde(default = "default_tags")]
    pub notified_tiers: String,
    /// W-049 周期规则：none/daily/weekly/monthly/yearly。
    #[serde(default = "default_repeat")]
    pub repeat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct PomodoroSession {
    pub id: String,
    pub session_type: String,
    pub mode: String,
    pub started_at: String,
    pub ended_at: String,
    #[ts(type = "number")]
    pub planned_seconds: i64,
    pub completed: bool,
    /// W-051 任务用时归集：关联的待办 id / 自定义事件名（老数据为 NULL）。
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub event_label: Option<String>,
}

/// A-4：SQLite 聚合口径的按日专注统计。由 `aggregate_sessions` 命令返回，
/// 让前端在超大数据集（>500 段会话）下仍能得到全量累计/年度热图，而不受内存
/// SESSIONS_CAP 截断影响。`date` 为本地日历日（YYYY-MM-DD），与前端 `toDateKey`
/// 的本地口径一致；`focus_seconds` 为该日专注秒数合计，`focus_count` 为轮数。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct DailyFocusStat {
    pub date: String,
    #[ts(type = "number")]
    pub focus_seconds: i64,
    #[ts(type = "number")]
    pub focus_count: i64,
}

/// A-4：`aggregate_sessions` 的返回体，全量专注历史按本地日历日聚合。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct FocusAggregate {
    pub daily: Vec<DailyFocusStat>,
}

/// FocusTimer 借鉴：24 小时时段分布的一格。`hour` 为本地小时（0-23），
/// `focus_seconds` 为该小时分摊到的专注秒数（跨小时段按墙钟占比切分），
/// `focus_count` 为结束时刻落在本小时的会话数（含未完成段）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct HourlyFocusStat {
    #[ts(type = "number")]
    pub hour: i64,
    #[ts(type = "number")]
    pub focus_seconds: i64,
    #[ts(type = "number")]
    pub focus_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct PomodoroInterruption {
    pub id: String,
    pub started_at: String,
    pub ended_at: String,
    pub reason: String,
    pub mode: String,
    #[ts(type = "number")]
    pub elapsed_seconds: i64,
}

/// A single key/value row from the settings table (included in full backups so
/// widget layouts, app prefs and the localStorage mirror survive restores).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct SettingKV {
    pub key: String,
    pub value: String,
}

/// 当前备份结构版本，必须与前端 `BACKUP_SCHEMA_VERSION` 保持一致。
pub const BACKUP_SCHEMA_VERSION: u32 = 2;

fn default_schema_version() -> u32 {
    // 没有该字段的历史备份视为 v1，由前端迁移链补齐缺失字段。
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct AppData {
    /// 备份结构版本（S2）。导出时写入当前版本；导入旧文件时默认 1。
    /// camelCase 别名让前端 `schemaVersion` 直接对应。
    #[serde(default = "default_schema_version", rename = "schemaVersion")]
    pub schema_version: u32,
    pub tasks: Vec<Task>,
    pub deadlines: Vec<Deadline>,
    /// 专注记录。`None`（早期 v1 备份只导出 tasks/deadlines，没有此字段）=
    /// 保留库中现有记录不动；`Some` = 整体替换。此前是必填 Vec，前端迁移把缺失
    /// 补成 `[]`，恢复一份合法的旧备份就会把用户全部专注历史清空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<PomodoroSession>>,
    /// Optional so backups written by older builds (without this field) still
    /// import cleanly; absent simply means "restore nothing".
    #[serde(default)]
    pub settings: Vec<SettingKV>,
    /// v2 可选扩展：专注中断记录。`None`（旧备份无此字段）= 保留库中现有
    /// 记录不动；`Some` = 整体替换。避免恢复旧备份时误删现有中断数据。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interruptions: Option<Vec<PomodoroInterruption>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ImportResult {
    pub tasks: usize,
    pub deadlines: usize,
}

/// DOCK（通知中心）：一条已留档的自发通知历史。`kind` 决定通知中心里的
/// 左侧色条（pomodoro / todo / info）。`expires_at` 是行级过期锚点，只存在于
/// DB 内部，不经 IPC 暴露。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct NotificationRecord {
    pub id: String,
    /// 来源标识（settings-store NotificationSource 或 pomodoro/todo 内核事件）。
    pub source: String,
    pub title: String,
    pub body: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub read: bool,
    /// UTC 毫秒精度 Z 字符串（与库内其余时间戳口径一致）。
    pub created_at: String,
}

/// CLIP（剪贴板历史）：一条剪贴板留档。`kind` = "text" | "image"（未知值
/// 回落 text）。`hash`（去重键）与 `expires_at` 只存在于 DB 内部，不经 IPC
/// 暴露；`preview` 由 Rust 侧生成（首个非空行压缩空白后截断），前端列表
/// 直接展示，全文/图片引用按需取用。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ClipboardEntry {
    pub id: String,
    /// "text" | "image" | "files"。
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 单行摘要：文本条目为内容首行；图片条目为空串（前端用本地化文案 +
    /// 像素尺寸渲染）；文件条目为文件名列表（逗号分隔）。
    pub preview: String,
    /// 文本条目的全文（图片条目为 None）。
    #[serde(default)]
    pub text: Option<String>,
    /// 图片条目的文件名（clip 数据目录内，非完整路径；文本条目为 None）。
    #[serde(default)]
    pub image_file: Option<String>,
    /// 图片条目的像素宽（文本条目为 None）。
    #[serde(default)]
    #[ts(type = "number | null")]
    pub image_w: Option<i64>,
    /// 图片条目的像素高（文本条目为 None）。
    #[serde(default)]
    #[ts(type = "number | null")]
    pub image_h: Option<i64>,
    /// 图片条目的 PNG 字节数（文本条目为 0）。
    #[serde(default = "default_zero")]
    #[ts(type = "number")]
    pub image_bytes: i64,
    /// 文件条目的完整路径列表（JSON 数组字符串；v10 迁移列，其余条目 None）。
    /// 前端按 JSON.parse 消费（数组元素为绝对路径字符串）。
    #[serde(default)]
    pub files: Option<String>,
    /// 来源进程名（设置默认关闭；开启后为复制时前台窗口进程的可执行文件名）。
    #[serde(default)]
    pub source_app: Option<String>,
    /// 置顶标记：置顶条目排在列表最前，且不参与 LRU / 过期清理。
    pub pinned: bool,
    /// UTC 毫秒精度 Z 字符串（与库内其余时间戳口径一致）。
    pub created_at: String,
}

/// §4.4 壁纸取色三色（`#rrggbb`）：主色 / 次色（色相与主色差 ≥30°，单色壁纸
/// 无次色）/ 中性基调色（全图均值）。均为原始候选（主题已不从壁纸派生颜色，
/// 该快照用于样式页「壁纸」区展示与当前壁纸标识）。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct WallpaperPalette {
    pub primary: String,
    pub secondary: Option<String>,
    pub neutral: String,
}

/// §4.4 壁纸取色快照：`path` + `mtime_ms` 即缓存键（同键不重算，前端亦可据此
/// 判断"壁纸未变"），随 `get_wallpaper_palette` 返回与 `wallpaper:changed` 事件下发。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct WallpaperPaletteInfo {
    pub path: String,
    #[ts(type = "number")]
    pub mtime_ms: u64,
    pub palette: WallpaperPalette,
}

/* ------------------------------------------------------------------ */
/* 任务栏自定义（TB-CORE 契约）：taskbar:* 事件负载。配置结构见         */
/* taskbar/mod.rs CONFIG 区（同样 TS 导出）；此处只放事件线协议。       */
/* A-3：任务栏线协议基元（实现类型 / 七态键）定义收敛于本模块（models  */
/* 是全后端的类型单一来源），taskbar 侧经 pub use re-export 维持既有   */
/* 路径——依赖方向自此单向（taskbar → models）。唯一例外：              */
/* PROTOCOL_VERSION 定义在 taskbar/protocol.rs（该文件被 velatap 以     */
/* #[path] 直接包含，必须自包含），此处按值引用。                       */
/* ------------------------------------------------------------------ */

use crate::taskbar::protocol::PROTOCOL_VERSION;

/// 任务栏实现类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum TaskbarType {
    /// Win10 经典任务栏（explorer 未加载 Taskbar.dll）。
    Classic,
    /// Win11 22000 / 早期 22621：两座 XAML 岛（部分 Win32 + 部分 XAML）。
    Mixed,
    /// Win11 22621+：单座 XAML 岛，整条任务栏为 XAML（TAP 路径唯一有效）。
    Xaml,
    /// 探测失败（explorer 未运行 / 结构不识别）。
    Unknown,
}

/// 七态键（§4 TaskbarStateKey）。事件负载中的 `activeState` 即此类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum TaskbarStateKey {
    Desktop,
    VisibleWindow,
    MaximizedWindow,
    StartOpened,
    SearchOpened,
    TaskViewOpened,
    BatterySaver,
}

impl TaskbarStateKey {
    /// 全部七键（states Record 的补全顺序，与前端同序）。
    pub const ALL: [TaskbarStateKey; 7] = [
        TaskbarStateKey::Desktop,
        TaskbarStateKey::VisibleWindow,
        TaskbarStateKey::MaximizedWindow,
        TaskbarStateKey::StartOpened,
        TaskbarStateKey::SearchOpened,
        TaskbarStateKey::TaskViewOpened,
        TaskbarStateKey::BatterySaver,
    ];

    /// 该态是否受 `enabled` 开关控制（desktop 恒启用，§4）。
    pub const fn optional(self) -> bool {
        !matches!(self, TaskbarStateKey::Desktop)
    }
}

/// 注入状态机 phase（F-10）：`Idle → Injecting → Ready / Failed / Degraded`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum TaskbarPhase {
    /// 模块未启用 / 未开始注入。
    Idle,
    /// 正在探测任务栏 + 注入 DLL + 握手。
    Injecting,
    /// 管道就绪，外观已可下发。
    Ready,
    /// 注入失败（协议版本不匹配 / 注入被拒 / 握手超时），`reason` 给一句话原因。
    Failed,
    /// 部分能力不可用但仍在运行（如 XAML 结构探测失败退到纯色）。
    Degraded,
}

/// 实现路径（F-12）：`xaml` = TAP 注入（22621+）；`swca` = 路径 A（Mixed，
/// P3）；`none` = 此系统版本暂不支持。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum TaskbarPath {
    Xaml,
    Swca,
    None,
}

/// `taskbar:status` 负载 / `get_taskbar_status` 返回体（F-10 状态条）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarStatus {
    pub phase: TaskbarPhase,
    /// Failed / Degraded 时的一句话原因与建议（如「需要重启资源管理器」）。
    #[serde(default)]
    pub reason: Option<String>,
    /// 稳定机器码（不随文案变化），前端据此挂接专属动作（如
    /// `stale_dll_resident` → 一键 / 自动重启资源管理器完成 DLL 升级）。
    #[serde(default)]
    pub code: Option<String>,
    pub taskbar_type: TaskbarType,
    /// 主进程管道协议版本（protocol.rs PROTOCOL_VERSION），诊断信息用。
    pub protocol_version: u32,
}

impl TaskbarStatus {
    /// 空壳阶段 / 模块未启用时的状态：Idle + Unknown。
    pub fn shell_default() -> Self {
        Self {
            phase: TaskbarPhase::Idle,
            reason: None,
            code: None,
            taskbar_type: TaskbarType::Unknown,
            protocol_version: PROTOCOL_VERSION,
        }
    }
}

/// `taskbar:capabilities` 负载（F-12 / D7）。前端按能力渲染：不可用能力
/// 在 UI 中不出现而非点击报错（如 XAML 下隐藏 showPeek 开关）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarCapabilities {
    pub path: TaskbarPath,
    pub supports_blur: bool,
    pub supports_peek: bool,
    pub supports_line: bool,
    pub supports_battery_state: bool,
    /// OS build 号（如 26200）；读取失败为 0。
    pub os_build: u32,
}

/// `taskbar:state-changed` 负载（F-14）：某显示器当前生效状态变化，
/// 仅变化时 emit（Rust 侧合并防抖 ≤200ms）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TaskbarStateChanged {
    pub active_state: TaskbarStateKey,
    /// 显示器稳定槽位（monitor.rs `monitor:slots`，与 widget-N 同号）。
    pub monitor: u32,
    /// 命中规则 id（仅 visibleWindow / maximizedWindow 走规则时非空）。
    #[serde(default)]
    pub matched_rule: Option<String>,
}

/// `files:classify_path` 返回（快捷方式小组件拖入识别）：显示名（去扩展名）
/// 与类别（url / folder / file）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct PathKind {
    pub label: String,
    pub kind: String,
    /// `.lnk`/`.url` 解析出的目标路径（非快捷方式为 None）。前端应存它而非
    /// 原路径——桌面上的快捷方式被删后，入口指向的目标仍然可用。
    #[serde(default)]
    #[ts(optional)]
    pub path: Option<String>,
}
