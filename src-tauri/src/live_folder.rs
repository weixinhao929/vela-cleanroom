//! 实时文件夹：files 组件把「当前显示的目录」登记到
//! Rust 侧统一 watch，目录内任何变更（创建/修改/删除/重命名）在 300ms
//! 静默期后合并成一条 `live-folder:change { instanceId, path }` 广播；前端
//! 收到后**全量重拉目录**——事件只当脏标记，真相在磁盘。
//!
//! watcher 生命周期：按实例 id upsert（未提及的实例保持不动，多实例互不
//! 踩踏），路径哈希未变跳过拆建；路径清空 = 移除该实例的监视。绑定时先过
//! `validate_live_path`：拒绝网络盘 / 盘根 / 系统目录 / 回收站 / symlink
//! （防递归环与误绑高危位置），校验失败原样返回给前端回退轮询。
//!
//! 静默期用 `recv_timeout(QUIET_MS)` 实现 trailing 去抖：事件持续涌入时一直
//! 合并，静默 300ms 才发一条；但自首个脏事件起最迟 `MAX_LATENCY`（2s）强制
//! 冲刷一条——持续写入的目录（构建产物/网盘同步）否则会把静默期无限推后，
//! 实时视图永远停在旧数据。watcher 被 drop（配置移除）时冲刷最后一批后随
//! channel 断连退出。
//!
//! 目录自愈：被监视目录被删除后 notify 句柄仍挂在旧目录对象上，重建后的
//! 同名目录事件永远收不到——接收线程探测到目录消失即转入等待重现（周期
//! 探测，channel 断连即退），重现后原地重建 watcher（注册表哈希一致才替换）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Event, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

/// 静默期：事件停止涌入该时长后才发一条变更（爆发合并成一次重拉）。
const QUIET_MS: u64 = 300;
/// 最大延迟：自首个脏事件起最迟该时长必须发一条（持续写入目录的保底）。
const MAX_LATENCY_MS: u64 = 2_000;
/// 目录消失后等待重现的探测周期。
const RESURRECT_POLL_MS: u64 = 1_000;

/// 系统目录黑名单：从环境变量解析（系统装在 D 盘等非 C 盘机器同样命中；
/// 此前硬编码 `c:\` 前缀在那些机器上全失效），归一为「小写 + 反斜杠」。
fn blocked_prefixes() -> Vec<String> {
    [
        std::env::var_os("SystemRoot"),
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("ProgramData"),
    ]
    .into_iter()
    .flatten()
    .map(|v| norm_path(&v.to_string_lossy()))
    .collect()
}

/// 规范化归一（比较用）：canonicalize 解析 `..`、8.3 短名（PROGRA~1）与
/// `\\?\` 设备前缀——纯字符串前缀比较可被这些等价写法绕过，把高频变更的
/// 系统目录绑成 watch 源。失败（路径不存在等）回退字符串归一：后续
/// symlink_metadata 自会给出「目录不存在」。
fn canonical_norm(raw: &str) -> String {
    match std::fs::canonicalize(raw) {
        Ok(p) => p
            .to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
            .trim_start_matches(r"\\?\")
            .to_string(),
        Err(_) => norm_path(raw),
    }
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveFolderConfig {
    pub instance_id: String,
    /// 要实时同步的目录（空 = 移除该实例的监视）。
    #[serde(default)]
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveFolderResult {
    pub instance_id: String,
    /// None = 绑定成功；Some(原因) = 校验/监视失败（前端回退轮询）。
    pub error: Option<String>,
}

/// 路径归一（比较用）：正斜杠统一反斜杠 + 小写。
fn norm_path(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

fn path_hash(path: &str) -> u64 {
    // FxHash 级别即可（只在本进程内比较是否变化）。
    let mut h: u64 = 0xcbf29ce484222325;
    for b in norm_path(path).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 绑定校验（纯函数 + 文件系统探测，可单测）：见模块注释的拒绝清单。
fn validate_live_path(raw: &str) -> Result<(), String> {
    if raw.trim().is_empty() {
        return Err("路径为空".into());
    }
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return Err("不支持网络路径".into());
    }
    if Path::new(raw).parent().is_none() {
        return Err("不支持盘根目录".into());
    }
    // 黑名单/回收站比对走规范化路径（见 canonical_norm）：`..`、8.3 短名、
    // `\\?\` 前缀等等价写法不再能绕过前缀匹配。
    let n = canonical_norm(raw);
    if blocked_prefixes()
        .iter()
        .any(|b| n == *b || n.starts_with(&format!("{b}\\")))
    {
        return Err("系统目录不可绑定".into());
    }
    if n.contains("\\$recycle.bin") {
        return Err("回收站不可绑定".into());
    }
    let meta = std::fs::symlink_metadata(raw).map_err(|_| "目录不存在".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("不支持符号链接目录".into());
    }
    if !meta.is_dir() {
        return Err("不是目录".into());
    }
    Ok(())
}

/// watcher 本体由管理表持有：条目被替换/移除时 drop watcher → 事件 Sender
/// 关闭 → 接收线程断连退出（与 auto_organize 相同的干净停止语义）。
/// window 记录注册来源窗口：窗口销毁时集中回收其名下条目（前端 cleanup
/// 不会跑的崩溃/强销场景，防止 watcher 与接收线程按实例 id 永久残留）。
struct LiveEntry {
    _watcher: notify::RecommendedWatcher,
    hash: u64,
    window: String,
}

static LIVE_WATCHERS: Mutex<Option<HashMap<String, LiveEntry>>> = Mutex::new(None);

fn with_live<T>(f: impl FnOnce(&mut HashMap<String, LiveEntry>) -> T) -> T {
    let mut guard = LIVE_WATCHERS.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// 窗口销毁时回收其名下的全部 watcher（lib.rs 的 RunEvent::Destroyed 钩子）。
pub fn drop_window(label: &str) {
    with_live(|m| {
        m.retain(|_, e| e.window != label);
    });
}

/// 广播一条变更事件。：走 `emit_filter` 限定
/// 受信窗口——全局 `emit` 会把用户正在浏览的目录路径投给任意可 listen 的
/// WebView（含 web-preview 远程页）。
fn emit_live_change(app: &tauri::AppHandle, instance_id: &str, path: &str) {
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        instance_id: &'a str,
        path: &'a str,
    }
    let _ = tauri::Emitter::emit_filter(
        app,
        "live-folder:change",
        Payload { instance_id, path },
        |win| match win {
            tauri::EventTarget::WebviewWindow { label }
            | tauri::EventTarget::Webview { label }
            | tauri::EventTarget::Window { label }
            | tauri::EventTarget::AnyLabel { label } => crate::trusted_window(label),
            _ => false,
        },
    );
}

/// 目录本体消失后的等待重现（接收线程内调用）：notify 句柄挂在已删除的
/// 目录对象上，之后重建的同名目录事件永远收不到。周期探测目录是否重现，
/// 重现即重建 watcher 并按哈希一致性替换注册表条目——旧 Sender 随旧
/// watcher 被 drop，调用方的外层 recv 随即 Disconnected 自然退出。channel
/// 断连（注销/窗口销毁/条目已换绑）立即返回。
fn await_dir_resurrect(
    app: &tauri::AppHandle,
    rx: &std::sync::mpsc::Receiver<notify::Result<Event>>,
    instance_id: &str,
    path: &str,
) {
    loop {
        match rx.recv_timeout(Duration::from_millis(RESURRECT_POLL_MS)) {
            Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                if !Path::new(path).is_dir() {
                    continue;
                }
                match spawn_live_watcher(app, instance_id, path) {
                    Ok(w) => {
                        let h = path_hash(path);
                        with_live(|m| {
                            // 哈希一致才替换：期间用户换绑了别的目录（或已
                            // 注销）时不覆盖新状态；未命中则丢弃新 watcher
                            // （其线程随 Sender drop 退出）。
                            if let Some(e) = m.get_mut(instance_id) {
                                if e.hash == h {
                                    e._watcher = w;
                                }
                            }
                        });
                    }
                    Err(_) => { /* 重建失败（校验不过等）：下轮探测再试 */ }
                }
                return;
            }
            Ok(_) => { /* 旧句柄的残留事件：忽略 */ }
        }
    }
}

/// 为一个实例建 watcher + 接收线程。所有 event kind 都算脏（对目录列表而
/// 言创建/删除/改名/修改都可能改变展示），不去分辨具体种类。
fn spawn_live_watcher(
    app: &tauri::AppHandle,
    instance_id: &str,
    path: &str,
) -> Result<notify::RecommendedWatcher, String> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher =
        notify::recommended_watcher(tx).map_err(|e| format!("创建监视器失败：{e}"))?;
    watcher
        .watch(Path::new(path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("监视目录失败（{path}）：{e}"))?;
    let app = app.clone();
    let instance_id = instance_id.to_string();
    let path = path.to_string();
    std::thread::spawn(move || {
        // 首个脏事件的时间戳：None = 干净。等待时长取「静默期」与「距最大
        // 延迟的剩余时间」的较小者——持续写入的目录最迟 MAX_LATENCY 冲刷。
        let mut dirty_since: Option<std::time::Instant> = None;
        loop {
            let timeout = match dirty_since {
                Some(t0) => {
                    let remain_ms = MAX_LATENCY_MS.saturating_sub(t0.elapsed().as_millis() as u64);
                    Duration::from_millis(QUIET_MS.min(remain_ms))
                }
                None => Duration::from_millis(QUIET_MS),
            };
            match rx.recv_timeout(timeout) {
                Ok(_) => {
                    if dirty_since.is_none() {
                        dirty_since = Some(std::time::Instant::now());
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    // 目录本体仍在？部分文件系统不为目录自删派发事件——句柄
                    // 挂在旧目录对象上，重建后的同名目录事件永远收不到，须
                    // 主动探测转入自愈等待（见 await_dir_resurrect）。
                    if !Path::new(&path).is_dir() {
                        if dirty_since.take().is_some() {
                            emit_live_change(&app, &instance_id, &path);
                        }
                        await_dir_resurrect(&app, &rx, &instance_id, &path);
                        continue;
                    }
                    if dirty_since.take().is_some() {
                        emit_live_change(&app, &instance_id, &path);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if dirty_since.take().is_some() {
                        emit_live_change(&app, &instance_id, &path);
                    }
                    break;
                }
            }
        }
    });
    Ok(watcher)
}

/// 按实例 id upsert 实时文件夹绑定：路径未变跳过拆建；路径空 = 移除；
/// 未提及的实例保持不动（多实例互不踩踏）。逐条返回校验结果。
/// （主线程冻结）：`validate_live_path` 的 symlink_metadata 与
/// `watcher.watch()` 都会碰盘——映射盘符（Z:\foo 指向断连的网络共享）不被
/// UNC 前缀拦截，stat 可阻塞数秒；同步命令跑在主线程会冻结所有窗口
/// （同 files.rs open_path 的口径），本体挪 spawn_blocking。
#[tauri::command]
pub async fn apply_live_folders(
    window: tauri::Window,
    app: tauri::AppHandle,
    configs: Vec<LiveFolderConfig>,
) -> Result<Vec<LiveFolderResult>, String> {
    crate::require_trusted(&window)?;
    let window_label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        apply_live_folders_impl(app, configs, window_label)
    })
    .await
    .map_err(|e| format!("实时文件夹任务失败: {e}"))?
}

fn apply_live_folders_impl(
    app: tauri::AppHandle,
    configs: Vec<LiveFolderConfig>,
    window_label: String,
) -> Result<Vec<LiveFolderResult>, String> {
    let mut results = Vec::with_capacity(configs.len());
    for c in configs {
        let h = path_hash(&c.path);
        if c.path.is_empty() {
            with_live(|m| {
                m.remove(&c.instance_id);
            });
            results.push(LiveFolderResult {
                instance_id: c.instance_id,
                error: None,
            });
            continue;
        }
        let unchanged = with_live(|m| m.get(&c.instance_id).map(|e| e.hash)) == Some(h);
        if unchanged {
            results.push(LiveFolderResult {
                instance_id: c.instance_id,
                error: None,
            });
            continue;
        }
        let spawned = validate_live_path(&c.path)
            .and_then(|()| spawn_live_watcher(&app, &c.instance_id, &c.path));
        match spawned {
            Ok(watcher) => {
                with_live(|m| {
                    m.insert(
                        c.instance_id.clone(),
                        LiveEntry {
                            _watcher: watcher,
                            hash: h,
                            window: window_label.clone(),
                        },
                    );
                });
                results.push(LiveFolderResult {
                    instance_id: c.instance_id,
                    error: None,
                });
            }
            Err(e) => {
                // 绑定失败不留半开条目：该实例维持无监视，前端按返回值回退轮询。
                with_live(|m| {
                    m.remove(&c.instance_id);
                });
                results.push(LiveFolderResult {
                    instance_id: c.instance_id,
                    error: Some(e),
                });
            }
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_unc_root_blacklist_and_missing() {
        assert!(validate_live_path("").is_err());
        assert!(validate_live_path("   ").is_err());
        assert!(validate_live_path("\\\\server\\share").is_err());
        assert!(validate_live_path("//server/share").is_err());
        // 盘根（parent 为 None）。
        assert!(validate_live_path("C:\\").is_err());
        assert!(validate_live_path("C:").is_err());
        // 黑名单来自环境变量（系统不在 C 盘同样命中）。
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let progfiles =
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        assert!(validate_live_path(&format!("{sysroot}\\System32")).is_err());
        assert!(validate_live_path(&format!("{progfiles}/foo")).is_err());
        // 回收站（任意盘、嵌套组件）。
        assert!(validate_live_path("D:\\$RECYCLE.BIN\\S-1-5").is_err());
        // 不存在的路径。
        assert!(validate_live_path("C:\\definitely-not-here-vela").is_err());
    }

    #[test]
    fn validate_resolves_equivalent_writings_before_blacklist() {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        // `..` 回环写法：字符串前缀比较不命中，canonicalize 后等于系统目录
        // 本体 → 拒绝。
        let via_dotdot = format!("{sysroot}\\..\\Windows");
        assert!(validate_live_path(&via_dotdot).is_err());
        // canonicalize 产出的 \\?\ 设备前缀已被剥除，与归一环境变量可比。
        assert_eq!(
            canonical_norm(&format!("{sysroot}\\..\\Windows")),
            norm_path(&sysroot)
        );
    }

    #[test]
    fn validate_accepts_normal_dir() {
        let p = std::env::temp_dir().join(format!("vela-live-test-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        assert!(validate_live_path(p.to_str().unwrap()).is_ok());
        // 前缀只是字符串黑名单，不是子串误伤：普通目录含 "windows" 字样也放行。
        let w = std::env::temp_dir().join(format!(
            "vela-live-test-{}/windows-notes",
            std::process::id()
        ));
        std::fs::create_dir_all(&w).unwrap();
        assert!(validate_live_path(w.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn validate_rejects_files_and_path_hash_normalizes() {
        let f = std::env::temp_dir().join(format!("vela-live-file-{}", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        assert!(validate_live_path(f.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(&f);
        // 哈希对大小写/斜杠归一：同一路径两种写法不触发拆建。
        assert_eq!(
            path_hash("C:\\Users\\x\\Desktop"),
            path_hash("c:/users/x/desktop")
        );
        assert_ne!(path_hash("C:\\a"), path_hash("C:\\b"));
    }
}
