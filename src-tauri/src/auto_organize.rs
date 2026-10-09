//! 目录监视自动整理：
//!
//! - **自动整理（#1）**：每个快捷方式组件实例可配置一个监视目录 + 匹配规则
//!   （扩展名 / 文件名关键字，双启用取 AND）。新文件 Created/Renamed 事件经
//!   500ms 按路径去抖、`matches` 纯函数命中后广播 `auto-organize:add`
//!   { instanceId, path }，前端走 classify_path 入列（与手动拖入同一条路）。
//!   整理动作 = 添加引用，**不移动/不复制文件**。
//! - **配置三态**：extEnabled/nameEnabled 关掉时
//!   规则保留、仅不参与匹配；watchPath 清空 = 停止监视该实例。
//! - **失效引用清理（#2）**：`check_paths_exist` 供前端挂载时校验条目，
//!   失效的自动移除（条目只是路径引用，文件本体从不动）。
//!
//! watcher 生命周期：`apply_auto_organize` 按实例 id upsert 配置（未提及的
//! 实例保持不动，多实例互不踩踏），配置哈希未变的实例跳过拆建（高频重放
//! 无副作用）；每个 watcher 独立 channel + 接收线程（notify 事件不携带
//! 用户数据，靠线程闭包记住 instanceId）。监视错误只 log：目录被删/权限
//! 变化不应拖垮命令。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Deserialize;
use tauri::Emitter;

/** 同路径去抖窗口。 */
const DEBOUNCE_MS: u64 = 500;

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoOrganizeConfig {
    pub instance_id: String,
    /** 监视目录（空 = 该实例不监视）。 */
    #[serde(default)]
    pub watch_path: String,
    /** 扩展名规则（小写含点，如 ".pdf"）。 */
    #[serde(default)]
    pub extensions: Vec<String>,
    /** 文件名关键字规则。 */
    #[serde(default)]
    pub name_tokens: Vec<String>,
    #[serde(default = "default_true")]
    pub ext_enabled: bool,
    #[serde(default)]
    pub name_enabled: bool,
    /// 通知动作（命中交互/提示类通知动作）：命中时除
    /// 入列外，前端额外发一条系统通知（新文件名 + 来源目录）。事件载荷携带。
    #[serde(default)]
    pub notify: bool,
    /// 文件年龄下限（天，0 = 不限）。
    #[serde(default)]
    pub older_than_days: u32,
    /// 年龄依据（默认修改时间）。
    #[serde(default)]
    pub older_by: OlderBy,
    /// 最小体积（MB，0 = 不限）。
    #[serde(default)]
    pub min_size_mb: u64,
}

/// 文件年龄依据。
#[derive(Clone, Copy, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum OlderBy {
    #[default]
    Modified,
    Created,
}

fn default_true() -> bool {
    true
}

/// 配置指纹：watchPath/extensions/nameTokens/两个子开关。instanceId 是键，
/// 不参与哈希。
fn config_hash(c: &AutoOrganizeConfig) -> u64 {
    let mut s = String::with_capacity(128);
    s.push_str(&c.watch_path);
    s.push('\u{1}');
    for e in &c.extensions {
        s.push_str(e);
        s.push('\u{2}');
    }
    s.push('\u{1}');
    for t in &c.name_tokens {
        s.push_str(t);
        s.push('\u{2}');
    }
    s.push('\u{1}');
    s.push(if c.ext_enabled { '1' } else { '0' });
    s.push(if c.name_enabled { '1' } else { '0' });
    s.push(if c.notify { '1' } else { '0' });
    s.push_str(&c.older_than_days.to_string());
    s.push(match c.older_by {
        OlderBy::Modified => 'm',
        OlderBy::Created => 'c',
    });
    s.push_str(&c.min_size_mb.to_string());
    // FxHash 级别的稳定性即可（只在本进程内比较是否变化）。
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 扩展名归一：小写、确保带前导点。
fn norm_ext(e: &str) -> String {
    let e = e.trim().to_ascii_lowercase();
    if e.starts_with('.') {
        e
    } else {
        format!(".{e}")
    }
}

/// 匹配（时间注入，可单测）：只匹配文件路径；双规则启用取 AND，只启用一类则
/// 只看该类；两类都没启用或没有任何规则项 = 不命中（空条件不空真）。
/// 的两个附加 AND 叶子：olderThanDays（年龄下限，依据
/// olderBy 修改/创建时间）与 minSizeMb（最小体积），0 = 该条件不参与。
pub fn matches(c: &AutoOrganizeConfig, path: &str) -> bool {
    matches_at(c, path, std::time::SystemTime::now())
}

pub fn matches_at(c: &AutoOrganizeConfig, path: &str, now: std::time::SystemTime) -> bool {
    if c.watch_path.is_empty() {
        return false;
    }
    let p = Path::new(path);
    if !p.is_file() {
        return false;
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()));
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_lowercase);

    let (ext, name) = match (ext, name) {
        (Some(e), Some(n)) => (e, n),
        _ => return false,
    };

    let ext_hit = if c.ext_enabled {
        !c.extensions.is_empty() && c.extensions.iter().any(|x| norm_ext(x) == ext)
    } else {
        true
    };
    let name_hit = if c.name_enabled {
        !c.name_tokens.is_empty()
            && c.name_tokens
                .iter()
                .any(|t| name.contains(&t.to_lowercase()))
    } else {
        true
    };
    // 两类都启用 → AND（matches 全 true 才算）；只启用一类 → 该类必须命中
    // （上面未启用侧恒 true 即可）；都没启用 → 无规则可依，不命中。
    if !c.ext_enabled && !c.name_enabled {
        return false;
    }
    if !(ext_hit && name_hit) {
        return false;
    }
    // 附加 AND 叶子。
    if c.older_than_days > 0 {
        let Ok(meta) = std::fs::metadata(p) else {
            return false;
        };
        let stamped = match c.older_by {
            OlderBy::Modified => meta.modified(),
            OlderBy::Created => meta.created().or_else(|_| meta.modified()),
        };
        let Ok(t) = stamped else {
            return false;
        };
        let age_days = now
            .duration_since(t)
            .map(|d| d.as_secs() / 86_400)
            .unwrap_or(0);
        if age_days < c.older_than_days as u64 {
            return false;
        }
    }
    if c.min_size_mb > 0 {
        let Ok(meta) = std::fs::metadata(p) else {
            return false;
        };
        if meta.len() < c.min_size_mb * 1024 * 1024 {
            return false;
        }
    }
    true
}

/// watcher 本体由管理表持有：条目被替换/移除时 drop watcher → 其内部的事件
/// Sender 一并关闭 → 接收线程 recv 出错退出（干净的停止语义，无需额外信号）。
struct WatcherEntry {
    _watcher: notify::RecommendedWatcher,
    hash: u64,
}

static WATCHERS: Mutex<Option<HashMap<String, WatcherEntry>>> = Mutex::new(None);
static DEBOUNCE: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
/** 配置应用代数：测试与诊断用。 */
static APPLY_SEQ: AtomicU64 = AtomicU64::new(0);

/// 闭包式访问（锁的生命周期明确，避免返回借用守卫的引用）。
fn with_watchers<T>(f: impl FnOnce(&mut HashMap<String, WatcherEntry>) -> T) -> T {
    let mut guard = WATCHERS.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// 为一个实例建 watcher + 接收线程。Created/Renamed 之外的 event kind 全部
/// 忽略。
fn spawn_watcher(
    app: &tauri::AppHandle,
    config: &AutoOrganizeConfig,
) -> Result<notify::RecommendedWatcher, String> {
    let instance_id = config.instance_id.clone();
    let watch_cfg = config.clone();
    let app = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher =
        notify::recommended_watcher(tx).map_err(|e| format!("创建监视器失败：{e}"))?;
    watcher
        .watch(Path::new(&config.watch_path), RecursiveMode::Recursive)
        .map_err(|e| format!("监视目录失败（{}）：{e}", config.watch_path))?;
    std::thread::spawn(move || {
        for ev in rx {
            let Ok(ev) = ev else { continue };
            let relevant = matches!(
                ev.kind,
                EventKind::Create(_)
                    | EventKind::Modify(notify::event::ModifyKind::Name(
                        notify::event::RenameMode::Both
                    ))
            );
            if !relevant {
                continue;
            }
            for path in ev.paths {
                let Some(path_str) = path.to_str().map(str::to_string) else {
                    continue;
                };
                if !matches(&watch_cfg, &path_str) {
                    continue;
                }
                // 同路径去抖：500ms 内的重复事件只发一次。
                let now = Instant::now();
                let mut guard = DEBOUNCE.lock().unwrap_or_else(|p| p.into_inner());
                let map = guard.get_or_insert_with(HashMap::new);
                if let Some(t) = map.get(&path_str) {
                    if now.duration_since(*t) < Duration::from_millis(DEBOUNCE_MS) {
                        continue;
                    }
                }
                map.insert(path_str.clone(), now);
                if map.len() > 512 {
                    map.retain(|_, t| now.duration_since(*t) < Duration::from_secs(5));
                }
                drop(guard);
                let _ = app.emit(
                    "auto-organize:add",
                    serde_json::json!({
                        "instanceId": instance_id,
                        "path": path_str,
                        "notify": watch_cfg.notify,
                        "watchPath": watch_cfg.watch_path,
                    }),
                );
            }
        }
    });
    Ok(watcher)
}

/// 按实例 id upsert 自动整理配置（未提及的实例保持不动——调用方只送自己
/// 这一份，多实例互不踩踏）。watchPath 为空 = 移除该实例的监视；配置哈希
/// 未变跳过拆建。返回 (监视中的实例数, 本次变更数)。
#[tauri::command]
pub fn apply_auto_organize(
    window: tauri::Window,
    app: tauri::AppHandle,
    configs: Vec<AutoOrganizeConfig>,
) -> Result<(usize, usize), String> {
    crate::require_trusted(&window)?;
    APPLY_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut changed = 0usize;
    for c in configs {
        let h = config_hash(&c);
        if with_watchers(|m| m.get(&c.instance_id).map(|e| e.hash)) == Some(h) {
            continue; // 配置未变：沿用现有 watcher。
        }
        if c.watch_path.is_empty() {
            // 显式移除：drop watcher（其接收线程随 channel 断连退出）。
            if with_watchers(|m| m.remove(&c.instance_id)).is_some() {
                changed += 1;
            }
            continue;
        }
        let watcher = spawn_watcher(&app, &c)?;
        with_watchers(|m| {
            m.insert(
                c.instance_id.clone(),
                WatcherEntry {
                    _watcher: watcher,
                    hash: h,
                },
            );
        });
        changed += 1;
    }
    let active = with_watchers(|m| m.len());
    Ok((active, changed))
}

/// 一键扫描存量文件（递归）：返回命中的全部文件路径，前端逐个入列。
/// 参数即扫描规则全集（设置页表单一一对应），拆结构体反而隔一层。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn scan_auto_organize(
    window: tauri::Window,
    watch_path: String,
    extensions: Vec<String>,
    name_tokens: Vec<String>,
    ext_enabled: bool,
    name_enabled: bool,
    older_than_days: u32,
    older_by: OlderBy,
    min_size_mb: u64,
) -> Result<Vec<String>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = AutoOrganizeConfig {
            instance_id: String::new(),
            watch_path,
            extensions,
            name_tokens,
            ext_enabled,
            name_enabled,
            notify: false,
            older_than_days,
            older_by,
            min_size_mb,
        };
        let mut out = Vec::new();
        visit_dir(Path::new(&cfg.watch_path), &cfg, &mut out, 0)?;
        Ok(out)
    })
    .await
    .map_err(|e| format!("扫描任务失败：{e}"))?
}

fn visit_dir(
    dir: &Path,
    cfg: &AutoOrganizeConfig,
    out: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 6 {
        return Ok(()); // 深度保险：映射整盘时避免无界遍历
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            visit_dir(&p, cfg, out, depth + 1)?;
        } else if let Some(s) = p.to_str() {
            if matches(cfg, s) {
                out.push(s.to_string());
            }
        }
    }
    Ok(())
}

/// 失效引用清理：批量检查路径是否仍存在。
/// 返回与入参同长的布尔数组（false = 已消失）。
/// 补窗口闸门——无闸门时 quick-note / web-preview 远程页可批量探测
/// 任意文件系统路径存在性（1Password.kdbx、公司共享盘等用户身份侧信道）；
/// 现仅受信窗口（widget-*/settings 等）可达，且单次批量封顶防批量枚举。
#[tauri::command]
pub async fn check_paths_exist(
    window: tauri::Window,
    paths: Vec<String>,
) -> Result<Vec<bool>, String> {
    crate::require_trusted(&window)?;
    /// 单次探测上限：正常失效检查（快捷方式目标复检）远低于此。
    const MAX_PATHS_PER_CALL: usize = 500;
    if paths.len() > MAX_PATHS_PER_CALL {
        return Err(format!("路径数超上限（{MAX_PATHS_PER_CALL}）"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .iter()
            .map(|p| !p.is_empty() && Path::new(p).exists())
            .collect())
    })
    .await
    .map_err(|e| format!("检查任务失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(
        watch: &str,
        exts: &[&str],
        tokens: &[&str],
        ext_on: bool,
        name_on: bool,
    ) -> AutoOrganizeConfig {
        AutoOrganizeConfig {
            instance_id: "w".into(),
            watch_path: watch.into(),
            extensions: exts.iter().map(|s| s.to_string()).collect(),
            name_tokens: tokens.iter().map(|s| s.to_string()).collect(),
            ext_enabled: ext_on,
            name_enabled: name_on,
            notify: false,
            older_than_days: 0,
            older_by: OlderBy::Modified,
            min_size_mb: 0,
        }
    }

    /// matches 按真实文件判定（is_file）：测试用临时文件驱动，返回其路径。
    fn temp_file(name: &str) -> String {
        let p = std::env::temp_dir().join(format!("vela-ao-test-{}-{name}", std::process::id()));
        std::fs::write(&p, b"x").unwrap();
        p.to_string_lossy().to_string()
    }

    #[test]
    fn matches_extension_rule() {
        let c = cfg("C:/dl", &[".PDF", "png"], &[], true, false);
        assert!(matches(&c, &temp_file("report.PDF")));
        assert!(matches(&c, &temp_file("a.png")));
        assert!(!matches(&c, &temp_file("a.jpg")));
        // 无前导点的规则项也归一。
        let c2 = cfg("C:/dl", &["mp4"], &[], true, false);
        assert!(matches(&c2, &temp_file("movie.MP4")));
    }

    #[test]
    fn matches_name_rule_and_combined_and() {
        let name_only = cfg("C:/dl", &[], &["发票", "invoice"], false, true);
        assert!(matches(&name_only, &temp_file("2026发票.pdf")));
        assert!(matches(&name_only, &temp_file("Invoice_Q1.pdf")));
        assert!(!matches(&name_only, &temp_file("报告.pdf")));
        // 双启用 = AND。
        let both = cfg("C:/dl", &[".pdf"], &["发票"], true, true);
        assert!(matches(&both, &temp_file("6月发票.pdf")));
        assert!(!matches(&both, &temp_file("发票.docx")));
        assert!(!matches(&both, &temp_file("报告.pdf")));
        // 双关闭 / 目录为空 = 不命中。
        assert!(!matches(
            &cfg("C:/dl", &[".pdf"], &["x"], false, false),
            &temp_file("a.pdf")
        ));
        assert!(!matches(
            &cfg("", &[".pdf"], &[], true, false),
            &temp_file("b.pdf")
        ));
    }

    #[test]
    fn matches_ignores_missing_paths_and_directories() {
        let c = cfg("C:/dl", &[".pdf"], &[], true, false);
        // 不存在的路径（is_file=false）：目录与幽灵文件都不命中。
        assert!(!matches(&c, "C:/dl/not-exist-dir.pdf"));
        // 真实目录即使带 .pdf 后缀也不命中。
        let dir = std::env::temp_dir().join(format!("vela-ao-test-dir-{}.pdf", std::process::id()));
        let _ = std::fs::create_dir(&dir);
        assert!(!matches(&c, &dir.to_string_lossy()));
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn matches_older_than_and_min_size_leaves() {
        // 年龄：新文件 + 需要 1 天前 → 不命中；now 推到 2 天后 → 命中（时间注入）。
        let mut c = cfg("C:/dl", &[".pdf"], &[], true, false);
        c.older_than_days = 1;
        let f = temp_file("age.pdf");
        assert!(!matches_at(&c, &f, std::time::SystemTime::now()));
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(86_400 * 2);
        assert!(matches_at(&c, &f, future));
        // 0 = 不参与：新文件也命中。
        c.older_than_days = 0;
        assert!(matches_at(&c, &f, std::time::SystemTime::now()));
        // 体积：1MB 阈值，临时小文件不命中；0 = 不参与。
        let mut s = cfg("C:/dl", &[".pdf"], &[], true, false);
        s.min_size_mb = 1;
        assert!(!matches(&s, &f));
        s.min_size_mb = 0;
        assert!(matches(&s, &f));
        // 附加条件是 AND：基础规则不命中时年龄/体积放宽也不命中。
        let mut a = cfg("C:/dl", &[".png"], &[], true, false);
        a.min_size_mb = 0;
        assert!(!matches(&a, &f));
    }

    #[test]
    fn config_hash_distinguishes_fields_and_ignores_instance() {
        let a = cfg("C:/dl", &[".pdf"], &["x"], true, false);
        let b = cfg("C:/dl", &[".pdf"], &["x"], true, false);
        let c = cfg("C:/other", &[".pdf"], &["x"], true, false);
        let d = cfg("C:/dl", &[".pdf"], &["x"], false, false);
        assert_eq!(config_hash(&a), config_hash(&b));
        assert_ne!(config_hash(&a), config_hash(&c));
        assert_ne!(config_hash(&a), config_hash(&d));
        // instanceId 不参与哈希（同配置换实例 = 等价 watcher）。
        let mut e = a.clone();
        e.instance_id = "other".into();
        assert_eq!(config_hash(&a), config_hash(&e));
        // notify 参与哈希（开关变化要拆建 watcher 才能把新载荷带出去）。
        let mut n = a.clone();
        n.notify = true;
        assert_ne!(config_hash(&a), config_hash(&n));
        // 新条件叶子参与哈希。
        let mut o = a.clone();
        o.older_than_days = 3;
        assert_ne!(config_hash(&a), config_hash(&o));
        let mut m = a.clone();
        m.min_size_mb = 2;
        assert_ne!(config_hash(&a), config_hash(&m));
    }
}
