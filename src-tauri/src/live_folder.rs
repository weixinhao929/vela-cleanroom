//! 实时文件夹（BentoDesk 借鉴 #4）：files 组件把「当前显示的目录」登记到
//! Rust 侧统一 watch，目录内任何变更（创建/修改/删除/重命名）在 300ms
//! 静默期后合并成一条 `live-folder:change { instanceId, path }` 广播；前端
//! 收到后**全量重拉目录**——事件只当脏标记，真相在磁盘（BentoDesk live
//! folder 的核心决策，前端零增量对账逻辑）。
//!
//! watcher 生命周期：按实例 id upsert（未提及的实例保持不动，多实例互不
//! 踩踏），路径哈希未变跳过拆建；路径清空 = 移除该实例的监视。绑定时先过
//! `validate_live_path`：拒绝网络盘 / 盘根 / 系统目录 / 回收站 / symlink
//! （防递归环与误绑高危位置），校验失败原样返回给前端回退轮询。
//!
//! 静默期用 `recv_timeout(QUIET_MS)` 实现 trailing 去抖：事件持续涌入时一直
//! 合并，静默 300ms 才发一条；watcher 被 drop（配置移除）时冲刷最后一批
//! 后随 channel 断连退出。

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Event, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// 静默期：事件停止涌入该时长后才发一条变更（爆发合并成一次重拉）。
const QUIET_MS: u64 = 300;

/// 系统目录黑名单（小写归一后按前缀比较）。
const BLOCKED_PREFIXES: [&str; 4] = [
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata",
];

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
    let n = norm_path(raw);
    if BLOCKED_PREFIXES
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
struct LiveEntry {
    _watcher: notify::RecommendedWatcher,
    hash: u64,
}

static LIVE_WATCHERS: Mutex<Option<HashMap<String, LiveEntry>>> = Mutex::new(None);

fn with_live<T>(f: impl FnOnce(&mut HashMap<String, LiveEntry>) -> T) -> T {
    let mut guard = LIVE_WATCHERS.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
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
        let mut dirty = false;
        loop {
            match rx.recv_timeout(Duration::from_millis(QUIET_MS)) {
                Ok(_) => dirty = true,
                Err(RecvTimeoutError::Timeout) => {
                    if dirty {
                        dirty = false;
                        let _ = app.emit(
                            "live-folder:change",
                            serde_json::json!({ "instanceId": instance_id, "path": path }),
                        );
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if dirty {
                        let _ = app.emit(
                            "live-folder:change",
                            serde_json::json!({ "instanceId": instance_id, "path": path }),
                        );
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
#[tauri::command]
pub fn apply_live_folders(
    window: tauri::Window,
    app: tauri::AppHandle,
    configs: Vec<LiveFolderConfig>,
) -> Result<Vec<LiveFolderResult>, String> {
    crate::require_trusted(&window)?;
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
        // 黑名单前缀（大小写与斜杠归一后命中）。
        assert!(validate_live_path("C:\\Windows\\System32").is_err());
        assert!(validate_live_path("c:/program files/foo").is_err());
        assert!(validate_live_path("C:\\ProgramData\\x").is_err());
        // 回收站（任意盘、嵌套组件）。
        assert!(validate_live_path("D:\\$RECYCLE.BIN\\S-1-5").is_err());
        // 不存在的路径。
        assert!(validate_live_path("C:\\definitely-not-here-vela").is_err());
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
