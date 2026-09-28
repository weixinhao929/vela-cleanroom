//! E15 删除可撤销（行为规格：删除前私有备份，可一键恢复）。
//!
//! 参考实现 的 `RecyclePathWithUndoBackup`：删除前先把目标**完整复制进
//! 应用私有目录**，再送系统回收站；撤销从私有备份恢复——不依赖回收站
//! （回收站可能被用户清空或被存储感知策略自动清理，而「撤销」承诺必须
//! 在删除后的短时间内绝对可信）。
//!
//! 备份生命周期与撤销栈绑定：
//! - 撤销成功 → 备份随恢复移动而消失；
//! - 栈超过上限（100）挤出最旧条目 → 其备份文件一并删除，不越用越占磁盘；
//! - 崩溃残留的孤儿备份（不在本会话注册表里）按目录修改时间清理（>7 天）。
//!
//! 恢复冲突：原路径已被同名新文件
//! 占用时，恢复为 `名称 (2).ext`、`(3)`……而不是失败。
//!
//! 体积护栏：超 256MB 的目标不做备份（复制开销与磁盘占用都不合理），
//! 直接走普通回收站删除并在返回值里标注 `undoable=false`。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::files::{destructive_path_denied, move_to_recycle_bin};

/// 撤销栈上限：超出即释放最旧条目的物理备份。
const MAX_UNDO_ENTRIES: usize = 100;
/// 孤儿备份（崩溃残留）的保留期。
const ORPHAN_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
/// 单目标备份体积上限：超过则放弃备份（undoable=false），仍执行删除。
const MAX_BACKUP_BYTES: u64 = 256 * 1024 * 1024;
/// 复制递归深度保险（防符号链接环；Windows junction 极少见但防御性保留）。
const MAX_COPY_DEPTH: usize = 32;

/** 删除命令返回：ticket = None 表示未做备份（超大或复制失败），不可撤销。 */
#[derive(Serialize)]
pub struct DeleteWithUndoResult {
    pub ticket: Option<String>,
    pub undoable: bool,
}

struct UndoEntry {
    ticket: String,
    original_path: String,
    backup_path: PathBuf,
}

/** 本会话撤销栈（Mutex<Option<…>> 与 auto_organize 的 WATCHERS 同款 poisoned 恢复）。 */
static UNDO_STACK: Mutex<Option<Vec<UndoEntry>>> = Mutex::new(None);
/** 票号单调计数：进程内唯一即可。 */
static TICKET_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn with_stack<T>(f: impl FnOnce(&mut Vec<UndoEntry>) -> T) -> T {
    let mut guard = UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(Vec::new))
}

fn operations_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::vela_data_dir(app)
        .map_err(|e| format!("无法获取数据目录: {e}"))?
        .join("operations");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建撤销目录: {e}"))?;
    Ok(dir)
}

/// 目录体积（尽力而为：读不到的条目按 0 计）。
fn tree_size(p: &Path) -> u64 {
    let md = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if md.is_file() {
        return md.len();
    }
    if !md.is_dir() {
        return 0;
    }
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            total += tree_size(&e.path());
        }
    }
    total
}

/// 递归复制（文件或目录树）。体积上限在调用方预先判定，这里按总量双保险。
fn copy_tree(src: &Path, dst: &Path, budget: &mut u64, depth: usize) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err("目录层级过深".into());
    }
    let md = std::fs::symlink_metadata(src).map_err(|e| format!("读取源失败: {e}"))?;
    if md.is_file() {
        if md.len() > *budget {
            return Err("超出备份体积上限".into());
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::copy(src, dst).map_err(|e| format!("复制文件失败: {e}"))?;
        *budget -= md.len();
        return Ok(());
    }
    if md.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
        let rd = std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))?;
        for e in rd.flatten() {
            copy_tree(&e.path(), &dst.join(e.file_name()), budget, depth + 1)?;
        }
        return Ok(());
    }
    Err("不支持的文件类型（符号链接等）".into())
}

/// 恢复目标唯一化：`a.txt` → `a (2).txt`、
/// `a (3).txt`…；无扩展名直接追加 ` (2)`。纯函数便于单测。
pub(crate) fn unique_destination(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let (stem, ext) = match name.rfind('.') {
        // 与前端 stripExt 同口径：点开头的文件名（.gitignore）不拆扩展名。
        Some(i) if i > 0 => (name[..i].to_string(), Some(name[i..].to_string())),
        _ => (name.clone(), None),
    };
    for n in 2..100u32 {
        let candidate = match &ext {
            Some(e) => format!("{stem} ({n}){e}"),
            None => format!("{stem} ({n})"),
        };
        let p = parent.join(&candidate);
        if !p.exists() {
            return p;
        }
    }
    // 99 个同名文件：不再枚举，直接时间戳后缀保证唯一。
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    parent.join(format!("{stem}-{ts}{}", ext.unwrap_or_default()))
}

/// 孤儿备份清理：operations/ 下不在本会话注册表里、且目录修改时间超过 TTL
/// 的子目录整树删除（崩溃残留的备份不该永远占盘）。TTL 可注入便于单测。
fn purge_orphans(ops: &Path, ttl: Duration) {
    let keep: Vec<PathBuf> = with_stack(|s| s.iter().map(|e| e.backup_path.clone()).collect());
    let Ok(rd) = std::fs::read_dir(ops) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(ttl);
    for e in rd.flatten() {
        let p = e.path();
        if keep.iter().any(|k| k == &p) {
            continue;
        }
        let expired = cutoff.is_none_or(|c| {
            e.metadata()
                .and_then(|m| m.modified())
                .map(|t| t < c)
                .unwrap_or(true)
        });
        if expired {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

/// E15 删除到回收站（可撤销）：备份 → 回收 → 登记。
/// E16 围栏与 E17 审计沿用 files.rs 的 delete 语义（围栏拒绝/审计成败）。
#[tauri::command]
pub async fn delete_with_undo(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: String,
) -> Result<DeleteWithUndoResult, String> {
    crate::require_trusted(&window)?;
    if let Some(reason) = destructive_path_denied(Path::new(&path)) {
        log::warn!(
            "audit: delete-with-undo DENIED window={} path={path:?} reason={reason}",
            window.label()
        );
        return Err(reason.to_string());
    }
    let label = window.label().to_string();
    let src = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let ops = operations_dir(&app)?;
        purge_orphans(&ops, ORPHAN_TTL);

        // 阶段 1：私有备份（超大/复制失败 → 降级为普通删除，仍可回收站找回）。
        let mut ticket: Option<String> = None;
        if tree_size(&src) <= MAX_BACKUP_BYTES {
            let t = format!(
                "undo-{}-{}",
                std::process::id(),
                TICKET_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let backup = ops.join(&t);
            let mut budget = MAX_BACKUP_BYTES;
            match copy_tree(&src, &backup, &mut budget, 0) {
                Ok(()) => ticket = Some(t),
                Err(e) => {
                    // 备份失败不阻断删除（回收站仍是兜底），清掉半成品。
                    log::warn!("audit: delete-with-undo backup SKIPPED error={e}");
                    let _ = std::fs::remove_dir_all(&backup);
                }
            }
        } else {
            log::info!("audit: delete-with-undo backup SKIPPED (oversize)");
        }

        // 阶段 2：送回收站（既有路径）。失败则撤掉备份回滚——不留"原文件还在
        // 但备份也占着盘"的中间态。
        if let Err(e) = move_to_recycle_bin(&path) {
            if let Some(t) = &ticket {
                let _ = std::fs::remove_dir_all(ops.join(t));
            }
            log::warn!("audit: delete-with-undo FAIL window={label} error={e}");
            return Err(e);
        }

        // 阶段 3：登记撤销条目；栈超限挤出最旧并释放其物理备份。
        let undoable = ticket.is_some();
        let result = DeleteWithUndoResult {
            ticket: ticket.clone(),
            undoable,
        };
        if let Some(t) = ticket {
            let backup = ops.join(&t);
            let evicted = with_stack(|s| {
                s.push(UndoEntry {
                    ticket: t.clone(),
                    original_path: path.clone(),
                    backup_path: backup.clone(),
                });
                if s.len() > MAX_UNDO_ENTRIES {
                    Some(s.remove(0)) // 最旧
                } else {
                    None
                }
            });
            if let Some(old) = evicted {
                let _ = std::fs::remove_dir_all(&old.backup_path);
            }
        }
        log::info!("audit: delete-with-undo OK window={label} undoable={undoable}");
        Ok(result)
    })
    .await
    .map_err(|e| format!("删除任务失败: {e}"))?
}

/// E15 撤销删除：私有备份 → 原路径（被占用则唯一化新名）。
/// 跨卷恢复（备份在 C: 的 APPDATA、原文件在 D:）rename 会失败，回退
/// 复制后删备份。恢复后父目录不存在（连目录一起删过）则重建。
#[tauri::command]
pub async fn undo_delete(window: tauri::Window, ticket: String) -> Result<String, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = with_stack(|s| {
            s.iter()
                .position(|e| e.ticket == ticket)
                .map(|i| s.remove(i))
        });
        let Some(entry) = entry else {
            return Err("撤销记录不存在或已过期".into());
        };
        if !entry.backup_path.exists() {
            return Err("备份已丢失（可能被清理）".into());
        }
        let target = unique_destination(Path::new(&entry.original_path));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("重建目标目录失败: {e}"))?;
        }
        // 同卷：直接 rename（瞬时、原子）；失败（跨卷/权限）→ 复制 + 删备份。
        if std::fs::rename(&entry.backup_path, &target).is_err() {
            let mut budget = u64::MAX;
            copy_tree(&entry.backup_path, &target, &mut budget, 0)
                .map_err(|e| format!("恢复失败: {e}"))?;
            let _ = std::fs::remove_dir_all(&entry.backup_path);
        }
        log::info!("audit: undo-delete OK ticket={ticket}");
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("恢复任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vela-fh-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unique_destination_appends_counter() {
        let d = tmp("uniq");
        let a = d.join("a.txt");
        std::fs::write(&a, b"x").unwrap();
        assert_eq!(unique_destination(&d.join("new.txt")), d.join("new.txt"));
        assert_eq!(unique_destination(&a), d.join("a (2).txt"));
        std::fs::write(d.join("a (2).txt"), b"x").unwrap();
        assert_eq!(unique_destination(&a), d.join("a (3).txt"));
        // 点开头文件名不拆"扩展名"。
        let dot = d.join(".env");
        std::fs::write(&dot, b"x").unwrap();
        assert_eq!(unique_destination(&dot), d.join(".env (2)"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn copy_tree_roundtrip_and_budget() {
        let d = tmp("copy");
        let src = d.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("f1.txt"), b"hello").unwrap();
        std::fs::write(src.join("sub/f2.bin"), vec![0u8; 64]).unwrap();
        let dst = d.join("backup");
        let mut budget = u64::MAX;
        copy_tree(&src, &dst, &mut budget, 0).unwrap();
        assert!(dst.join("f1.txt").is_file());
        assert!(dst.join("sub/f2.bin").is_file());
        // 预算不足：单文件超出预算即失败。
        let small = d.join("tiny");
        std::fs::write(&small, vec![1u8; 32]).unwrap();
        let mut tight = 16u64;
        assert!(copy_tree(&small, &d.join("tiny-copy"), &mut tight, 0).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tree_size_sums_files() {
        let d = tmp("size");
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        std::fs::write(d.join("a/x"), vec![0u8; 10]).unwrap();
        std::fs::write(d.join("a/b/y"), vec![0u8; 5]).unwrap();
        assert_eq!(tree_size(&d), 15);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 孤儿清理：TTL=0 时清掉不在注册表里的目录，注册表内的保留。
    #[test]
    fn purge_orphans_respects_registry_and_ttl() {
        let d = tmp("orphan");
        // 清空注册表状态（测试互斥地持锁）。
        let survivor = d.join("undo-keep");
        let ghost = d.join("undo-ghost");
        std::fs::create_dir_all(&survivor).unwrap();
        std::fs::create_dir_all(&ghost).unwrap();
        with_stack(|s| {
            s.clear();
            s.push(UndoEntry {
                ticket: "keep".into(),
                original_path: String::new(),
                backup_path: survivor.clone(),
            });
        });
        purge_orphans(&d, Duration::ZERO);
        assert!(survivor.exists());
        assert!(!ghost.exists());
        with_stack(|s| s.clear());
        let _ = std::fs::remove_dir_all(&d);
    }
}
