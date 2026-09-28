//! 滚动备份：每日一份完整 SQLite 快照（JSON 线协议经 import_data 落库），
//! Rust 侧按天去重并清理过期文件；由托盘/启动路径调用。
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;
use ts_rs::TS;

use crate::db::{DbError, DbResult};

/// Number of rolling backups to keep on disk.
const KEEP: usize = 30;

/// Backup file names carry the app brand. Old installs wrote "focus-desk-…";
/// both prefixes are recognized so existing snapshots stay listable/restorable.
/// 必须以 .json 结尾：进程在写 tmp 与 rename 之间被杀会留下 "vela-….json.tmp"，
/// 若只按前缀判定，残件会混进恢复列表并被 prune 计入保留配额，挤掉真实备份。
fn is_backup_name(name: &str) -> bool {
    (name.starts_with("vela-") || name.starts_with("focus-desk-")) && name.ends_with(".json")
}

/// E-10 对齐：列表/去重路径的 created_at 从文件 mtime 推导（UTC+Z）。
/// mtime 不可得（文件被并发删除等极端情况）返回 epoch-0 而非空串——空串
/// 会被前端 `new Date("")` 解析成 Invalid Date。
fn backup_created_at(path: &Path) -> String {
    path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            chrono::DateTime::<chrono::Utc>::from(t)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|| {
            chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0)
                .unwrap_or_default()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct BackupInfo {
    pub name: String,
    pub path: String,
    pub created_at: String,
}

pub fn backups_dir(app: &tauri::AppHandle) -> PathBuf {
    // 解析失败时不能静默落到当前工作目录（便携/服务方式拉起时可能是系统
    // 目录或网络盘，且多副本分散难排查）；退到用户临时目录并大声告警。
    match crate::vela_data_dir(app) {
        Ok(dir) => dir.join("backups"),
        Err(e) => {
            log::error!("app_data_dir resolve failed, falling back to temp dir: {e}");
            std::env::temp_dir()
                .join("com.cleanroom.focusdesk")
                .join("backups")
        }
    }
}

/// Creates a daily rolling backup. The DB lock is only held by the caller for
/// the read-only export; serialization + disk write happen here after the lock
/// is released (the JSON can reach tens of MB once sessions accumulate).
pub fn write_backup(app: &tauri::AppHandle, data: &crate::models::AppData) -> DbResult<BackupInfo> {
    let dir = backups_dir(app);
    fs::create_dir_all(&dir)?;

    let now = Local::now();
    let date_prefix = now.format("%Y%m%d").to_string();
    if let Some(existing) = today_backup(&dir, &date_prefix)? {
        return Ok(existing);
    }

    let name = format!("vela-{}.json", now.format("%Y%m%d-%H%M%S"));
    let path = dir.join(&name);
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| DbError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
    // R2（审计）：先写临时文件再原子改名。直接 fs::write 目标时进程中途被杀
    // 会留下截断 JSON，today_backup 按日期去重会把当天判为"已备份"，导致
    // 自动备份静默丢失；坏文件还会混进恢复列表。
    let tmp_path = dir.join(format!("{name}.tmp"));
    fs::write(&tmp_path, &json)?;
    // 清理历史版本/被杀进程留下的陈旧残件，避免它们永久滞留目录。
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let n = entry.file_name().to_string_lossy().to_string();
            if n.starts_with("vela-") && n.ends_with(".json.tmp") && n != format!("{name}.tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    fs::rename(&tmp_path, &path)?;
    log::info!("created backup {}", name);

    prune(&dir)?;
    Ok(BackupInfo {
        name,
        path: path.to_string_lossy().to_string(),
        // E-10: metadata timestamp must be UTC+Z to match repositories.rs, so
        // frontend date parsing never mixes timezone bases.
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

/// R2（审计）：廉价完整性探测——JSON 备份以 '}' 结尾。只读末尾 1 字节，
/// 用于把历史版本留下的截断文件排除出"当日已备份"判定。
fn looks_complete(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    if f.seek(SeekFrom::End(-1)).is_err() {
        return false;
    }
    let mut buf = [0u8; 1];
    f.read_exact(&mut buf).is_ok() && buf[0] == b'}'
}

/// 同日已存在完整备份时返回其中文件名时间戳最新的一份（去重依据）。
fn today_backup(dir: &Path, date_prefix: &str) -> DbResult<Option<BackupInfo>> {
    // 同日多份时必须取文件名时间戳最大者；read_dir 顺序不定，"最后读到"
    // 不保证是最新，会把旧备份当作"今天已备份"而跳过写入。
    let mut latest: Option<BackupInfo> = None;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_backup_name(&name)
            && name.contains(date_prefix)
            // R2（审计）：截断的旧备份（历史版本非原子写入遗留）不能当作
            // "今天已备份"的证据，否则当天自动备份会被静默跳过。
            && looks_complete(&entry.path())
            && latest.as_ref().is_none_or(|l| name > l.name)
        {
            latest = Some(BackupInfo {
                name,
                path: entry.path().to_string_lossy().to_string(),
                created_at: backup_created_at(&entry.path()),
            });
        }
    }
    Ok(latest)
}

fn prune(dir: &Path) -> DbResult<()> {
    // 只清理本应用自己写的备份：目录里用户误放或其它工具产生的 .json
    // 不属于滚动备份，静默删除等于破坏用户数据。
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(is_backup_name)
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    while files.len() > KEEP {
        let oldest = files.remove(0);
        if let Err(e) = fs::remove_file(&oldest) {
            // 文件被占用等场景：静默吞掉会导致每天重试永不收敛，必须留痕。
            log::warn!("prune: failed to remove {}: {e}", oldest.display());
        }
    }
    Ok(())
}

/// Lists existing backups, newest first.
pub fn list_backups(app: &tauri::AppHandle) -> DbResult<Vec<BackupInfo>> {
    let dir = backups_dir(app);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut infos = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_backup_name(&name) {
            continue;
        }
        infos.push(BackupInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            created_at: backup_created_at(&entry.path()),
        });
    }
    infos.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(infos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_newest_files() {
        let dir = std::env::temp_dir().join(format!("fd-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for i in 0..40 {
            fs::write(
                dir.join(format!("focus-desk-20260101-{:02}0000.json", i)),
                "{}",
            )
            .unwrap();
        }
        prune(&dir).unwrap();
        let remaining = fs::read_dir(&dir).unwrap().count();
        assert_eq!(remaining, KEEP);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn today_backup_matches_date_prefix() {
        let dir = std::env::temp_dir().join(format!("fd-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vela-20260813-120000.json"), "{}").unwrap();
        let found = today_backup(&dir, "20260813").unwrap();
        assert!(found.is_some());
        let missing = today_backup(&dir, "20260812").unwrap();
        assert!(missing.is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_prefix_backups_still_recognized() {
        let dir = std::env::temp_dir().join(format!("fd-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("focus-desk-20260813-090000.json"), "{}").unwrap();
        let found = today_backup(&dir, "20260813").unwrap();
        assert!(found.is_some());
        fs::remove_dir_all(&dir).unwrap();
    }
}
