//! 删除可撤销（行为规格：删除前私有备份，可一键恢复）。
//!
//! 的 `RecyclePathWithUndoBackup`：删除前先把目标**完整复制进
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

#[derive(Clone)]
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

/// 目录体积（尽力而为：读不到的条目按 0 计）。深度保险对齐 copy_tree 的
/// MAX_COPY_DEPTH——病态深树（环/junction 链虽被 symlink 判定挡住，极端
/// 嵌套仍可栈溢出），超深子树按 0 计。
fn tree_size(p: &Path) -> u64 {
    tree_size_depth(p, 0)
}

fn tree_size_depth(p: &Path, depth: usize) -> u64 {
    if depth > MAX_COPY_DEPTH {
        return 0;
    }
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
            total += tree_size_depth(&e.path(), depth + 1);
        }
    }
    total
}

/// 递归复制（文件或目录树）。体积上限在调用方预先判定，这里按总量双保险。
/// pub(crate)：files.rs 的 transfer_into_dir（拖放复制 / Ctrl+V 粘贴）复用。
pub(crate) fn copy_tree(
    src: &Path,
    dst: &Path,
    budget: &mut u64,
    depth: usize,
) -> Result<(), String> {
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

/// 删除文件或目录（备份两者皆可）：remove_dir_all 对普通文件返回 Err——
/// 单文件删除的备份就是 operations/ 下的一个**文件**，此前孤儿清理/撤销
/// 收尾对它永远失败且 `let _ =` 吞错，崩溃残留的文件型备份随时间累积占盘。
fn remove_any(p: &Path) {
    let ok = match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).is_ok(),
        Ok(_) => std::fs::remove_file(p).is_ok(),
        Err(_) => false, // 已不存在：视为清理完成
    };
    if !ok {
        log::debug!("备份清理失败: {}", p.display());
    }
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
            remove_any(&p);
        }
    }
}

/// 删除到回收站（可撤销）单条核心（单删 / 批量共用）：
/// 备份 → 回收 → 登记（含栈超限挤出）。返回 Some(ticket) = 可撤销。
fn delete_one_with_undo(ops: &Path, path: &str) -> Result<Option<String>, String> {
    if let Some(reason) = destructive_path_denied(Path::new(path)) {
        return Err(reason.to_string());
    }
    let src = PathBuf::from(path);

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
                remove_any(&backup);
            }
        }
    } else {
        log::info!("audit: delete-with-undo backup SKIPPED (oversize)");
    }

    // 阶段 2：送回收站。失败则撤掉备份回滚——不留"原文件还在但备份也占着
    // 盘"的中间态。
    if let Err(e) = move_to_recycle_bin(path) {
        if let Some(t) = &ticket {
            remove_any(&ops.join(t));
        }
        return Err(e);
    }

    // 阶段 3：登记撤销条目；栈超限挤出最旧并释放其物理备份。
    let registered = ticket.clone();
    if let Some(t) = registered {
        let backup = ops.join(&t);
        let evicted = with_stack(|s| {
            s.push(UndoEntry {
                ticket: t.clone(),
                original_path: path.to_string(),
                backup_path: backup.clone(),
            });
            if s.len() > MAX_UNDO_ENTRIES {
                Some(s.remove(0)) // 最旧
            } else {
                None
            }
        });
        if let Some(old) = evicted {
            remove_any(&old.backup_path);
        }
    }
    Ok(ticket)
}

/// 删除到回收站（可撤销）：备份 → 回收 → 登记。
/// 围栏与 审计沿用 files.rs 的 delete 语义（围栏拒绝/审计成败）。
#[tauri::command]
pub async fn delete_with_undo(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: String,
) -> Result<DeleteWithUndoResult, String> {
    crate::require_trusted(&window)?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let ops = operations_dir(&app)?;
        purge_orphans(&ops, ORPHAN_TTL);
        match delete_one_with_undo(&ops, &path) {
            Ok(ticket) => {
                let undoable = ticket.is_some();
                log::info!("audit: delete-with-undo OK window={label} undoable={undoable}");
                Ok(DeleteWithUndoResult { ticket, undoable })
            }
            Err(e) => {
                log::warn!("audit: delete-with-undo FAIL window={label} error={e}");
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("删除任务失败: {e}"))?
}

/// 批量删除进度事件载荷（files:delete-batch-progress，emit_filter 受信窗口）。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BatchProgress<'a> {
    done: usize,
    total: usize,
    current: &'a str,
    cancelled: bool,
}

fn emit_batch_progress(app: &tauri::AppHandle, p: BatchProgress<'_>) {
    // 进度含被删文件名，全局 emit
    // 会投给任意 WebView（含 web-preview 远程页）——emit_filter 限定受信窗口。
    let _ = tauri::Emitter::emit_filter(app, "files:delete-batch-progress", p, |win| match win {
        tauri::EventTarget::WebviewWindow { label }
        | tauri::EventTarget::Webview { label }
        | tauri::EventTarget::Window { label }
        | tauri::EventTarget::AnyLabel { label } => crate::trusted_window(label),
        _ => false,
    });
}

/// 批量删除的单条结果：ticket = 可撤销；cancelled = 用户中止后跳过；两者
/// 皆空且 error 有值 = 该条失败。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBatchOutcome {
    pub path: String,
    pub ticket: Option<String>,
    pub error: Option<String>,
    pub cancelled: bool,
}

/// 批量删除取消标志（cancel_delete_batch 置位；每批开始时复位）。
static BATCH_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 取消进行中的批量删除（停止发起后续删除，已完成的保留）。
#[tauri::command]
pub async fn cancel_delete_batch(window: tauri::Window) -> Result<(), String> {
    crate::require_trusted(&window)?;
    BATCH_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 批量删除（单 IPC）：此前前端逐条 invoke——N 次 IPC 往返 + 每条重复
/// operations_dir/purge_orphans 开销。顺序执行（批量传输语义不变），逐条
/// 广播进度；取消由 cancel_delete_batch 协作式生效。
#[tauri::command]
pub async fn delete_batch_with_undo(
    window: tauri::Window,
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<DeleteBatchOutcome>, String> {
    crate::require_trusted(&window)?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        use std::sync::atomic::Ordering::Relaxed;
        BATCH_CANCEL.store(false, Relaxed);
        let ops = operations_dir(&app)?;
        purge_orphans(&ops, ORPHAN_TTL);
        let total = paths.len();
        let mut out = Vec::with_capacity(total);
        let mut done = 0usize;
        for p in paths {
            let current = p.rsplit(['\\', '/']).next().unwrap_or("").to_string();
            let cancelled = BATCH_CANCEL.load(Relaxed);
            emit_batch_progress(
                &app,
                BatchProgress {
                    done,
                    total,
                    current: &current,
                    cancelled,
                },
            );
            if cancelled {
                out.push(DeleteBatchOutcome {
                    path: p,
                    ticket: None,
                    error: None,
                    cancelled: true,
                });
                continue;
            }
            match delete_one_with_undo(&ops, &p) {
                Ok(ticket) => {
                    if ticket.is_some() {
                        done += 1;
                    }
                    out.push(DeleteBatchOutcome {
                        path: p,
                        ticket,
                        error: None,
                        cancelled: false,
                    });
                }
                Err(e) => out.push(DeleteBatchOutcome {
                    path: p,
                    ticket: None,
                    error: Some(e),
                    cancelled: false,
                }),
            }
        }
        emit_batch_progress(
            &app,
            BatchProgress {
                done,
                total,
                current: "",
                cancelled: BATCH_CANCEL.load(Relaxed),
            },
        );
        log::info!("audit: delete-batch window={label} total={total} done={done}");
        Ok(out)
    })
    .await
    .map_err(|e| format!("批量删除任务失败: {e}"))?
}

/// 撤销删除：私有备份 → 原路径（被占用则唯一化新名）。
/// 跨卷恢复（备份在 C: 的 APPDATA、原文件在 D:）rename 会失败，回退
/// 复制后删备份。恢复后父目录不存在（连目录一起删过）则重建。
#[tauri::command]
pub async fn undo_delete(window: tauri::Window, ticket: String) -> Result<String, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        // （并发认领）：票据先从栈里原子移除再恢复——此前「克隆→成功后才
        // 弹出」在双击撤销/批量回放与手动撤销并发时，两路都能拿到同一票据，
        // 交错对同一目标 rename/copy 会写坏恢复结果。认领后失败则原样放回，
        // 重试仍有据可依；崩溃丢失的票据由孤儿备份 TTL（7 天）兜底。
        let entry = with_stack(|s| {
            s.iter()
                .position(|e| e.ticket == ticket)
                .map(|i| s.remove(i))
        });
        let Some(entry) = entry else {
            return Err("撤销记录不存在或已在恢复中".into());
        };
        if !entry.backup_path.exists() {
            // 备份已丢失：票据无意义（认领即弃），报错。
            return Err("备份已丢失（可能被清理）".into());
        }
        let target = unique_destination(Path::new(&entry.original_path));
        if let Some(parent) = target.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                with_stack(|s| s.push(entry));
                return Err(format!("重建目标目录失败: {e}"));
            }
        }
        // 同卷：直接 rename（瞬时、原子）；失败（跨卷/权限）→ 复制 + 删备份。
        let outcome = (|| -> Result<(), String> {
            if std::fs::rename(&entry.backup_path, &target).is_ok() {
                return Ok(());
            }
            let mut budget = u64::MAX;
            if let Err(e) = copy_tree(&entry.backup_path, &target, &mut budget, 0) {
                // 半恢复残留清理：复制中断会在目标留半棵树——回到「删除后」
                // 的干净状态，而不是留一个看似恢复完成的残缺文件。
                remove_any(&target);
                return Err(format!("恢复失败: {e}"));
            }
            remove_any(&entry.backup_path);
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                log::info!("audit: undo-delete OK ticket={ticket}");
                Ok(target.to_string_lossy().into_owned())
            }
            Err(e) => {
                // 恢复失败回滚票据：备份未动，用户重试仍可撤销。
                with_stack(|s| s.push(entry));
                Err(e)
            }
        }
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

    /// 孤儿清理：TTL=0 时清掉不在注册表里的目录**与文件**（单文件删除的
    /// 备份是文件，remove_dir_all 对它无效），注册表内的保留。
    #[test]
    fn purge_orphans_respects_registry_and_ttl() {
        let d = tmp("orphan");
        // 清空注册表状态（测试互斥地持锁）。
        let survivor = d.join("undo-keep");
        let ghost_dir = d.join("undo-ghost-dir");
        let ghost_file = d.join("undo-ghost-file");
        std::fs::create_dir_all(&survivor).unwrap();
        std::fs::create_dir_all(&ghost_dir).unwrap();
        std::fs::write(&ghost_file, b"x").unwrap();
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
        assert!(!ghost_dir.exists());
        assert!(!ghost_file.exists());
        with_stack(|s| s.clear());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// remove_any：文件与目录都能删；不存在的路径不报错。
    #[test]
    fn remove_any_handles_file_dir_and_missing() {
        let d = tmp("rmany");
        let f = d.join("file-backup");
        let dir = d.join("dir-backup");
        std::fs::write(&f, b"x").unwrap();
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        std::fs::write(dir.join("inner/x"), b"x").unwrap();
        remove_any(&f);
        remove_any(&dir);
        remove_any(&d.join("never-existed"));
        assert!(!f.exists());
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
