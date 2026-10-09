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

/// 对齐：列表/去重路径的 created_at 从文件 mtime 推导（UTC+Z）。
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
/// is released (the JSON can still reach several MB once sessions accumulate,
/// even compact-serialized).
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
    // （备份体积治理）：紧凑序列化取代 to_string_pretty。sessions 累积后
    // 单份全量备份曾达数十 MB × KEEP=30，pretty 的缩进/换行占其中约 30-40%
    // 纯空白字节。无损性：仍以 '}' 结尾（looks_complete 的尾字节判定不受
    // 影响），恢复端 serde / JSON.parse 对空白格式无感；today_backup /
    // prune 只比较文件名，同样不受影响。压缩/分卷需产品决策，暂不做。
    let json = serde_json::to_string(&data)
        .map_err(|e| DbError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
    // 先写临时文件再原子改名。直接 fs::write 目标时进程中途被杀
    // 会留下截断 JSON，today_backup 按日期去重会把当天判为"已备份"，导致
    // 自动备份静默丢失；坏文件还会混进恢复列表。
    let tmp_path = dir.join(format!("{name}.tmp"));
    // 先写临时文件再原子改名。直接 fs::write 目标时进程中途被杀
    // 会留下截断 JSON，today_backup 按日期去重会把当天判为"已备份"，导致
    // 自动备份静默丢失；坏文件还会混进恢复列表。
    // tmp 落盘必须 fsync——fs::write + rename 之间数据可能仍躺在 OS
    // 缓冲里，掉电 / 崩溃会留下「已改名但内容截断」的正式备份。File::create
    // → write_all → sync_all → drop 保证字节先于改名落盘。
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
    }
    // 清理历史版本/被杀进程留下的陈旧残件，避免它们永久滞留目录。
    // 清理条件与 is_backup_name 的双前缀口径对齐——
    // 旧版本写的 `focus-desk-*.json.tmp` 残件同样要清，否则升级后它们在
    // 备份目录里永久滞留（不匹配 vela- 前缀永不命中此分支）。
    clean_stale_tmp_files(&dir, &format!("{name}.tmp"));
    fs::rename(&tmp_path, &path)?;
    log::info!("created backup {}", name);

    prune(&dir)?;
    Ok(BackupInfo {
        name,
        path: path.to_string_lossy().to_string(),
        // metadata timestamp must be UTC+Z to match repositories.rs, so
        // frontend date parsing never mixes timezone bases.
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

/// 清掉目录里**陈旧**的写盘残件（双前缀 `.json.tmp`，
/// 与 is_backup_name 的品牌前缀口径一致——legacy `focus-desk-*` 残件在只认
/// `vela-` 前缀的旧实现里永久滞留）。`keep` 是本轮正在写的 tmp 文件名，
/// 不在清理之列（rename 紧随其后）。
fn clean_stale_tmp_files(dir: &Path, keep: &str) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let n = entry.file_name().to_string_lossy().to_string();
            let is_stale_tmp = (n.starts_with("vela-") || n.starts_with("focus-desk-"))
                && n.ends_with(".json.tmp")
                && n != keep;
            if is_stale_tmp {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// 廉价完整性探测——JSON 备份以 '}' 结尾。只读末尾 1 字节，
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
            // 截断的旧备份（历史版本非原子写入遗留）不能当作
            // "今天已备份"的证据，否则当天自动备份会被静默跳过。
            && looks_complete(&entry.path())
            && latest
                .as_ref()
                .is_none_or(|l| cmp_backup_names(&name, &l.name) == std::cmp::Ordering::Greater)
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

/// 从备份文件名解析内嵌时间戳段（`%Y%m%d-%H%M%S`，如
/// "vela-20260813-120000.json" → "20260813-120000"）。品牌前缀（vela- /
/// focus-desk-）不同时字符串序会误判新旧，排序与同日比较必须用时间戳本身；
/// 段形如 8 位数字 + '-' + 6 位数字才算解析成功。
fn backup_timestamp(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".json")?;
    // 先剥品牌前缀再取时间戳段（"focus-desk-" 自身含 '-'，不能取首个 '-'）。
    let rest = stem
        .strip_prefix("vela-")
        .or_else(|| stem.strip_prefix("focus-desk-"))?;
    let (date, time) = rest.split_once('-')?;
    let ok = date.len() == 8
        && time.len() == 6
        && date.bytes().all(|b| b.is_ascii_digit())
        && time.bytes().all(|b| b.is_ascii_digit());
    ok.then(|| rest.to_string())
}

/// 备份文件名比较——两侧都能解析出时间戳时按时间戳比，否则回退
/// 文件名字符串序（与旧行为一致，保证全序确定）。
fn cmp_backup_names(a: &str, b: &str) -> std::cmp::Ordering {
    match (backup_timestamp(a), backup_timestamp(b)) {
        (Some(ta), Some(tb)) => ta.cmp(&tb),
        _ => a.cmp(b),
    }
}

fn file_name_of(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string()
}

fn prune(dir: &Path) -> DbResult<()> {
    // 只清理本应用自己写的备份：目录里用户误放或其它工具产生的 .json
    // 不属于滚动备份，静默删除等于破坏用户数据。
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| is_backup_name(&file_name_of(p)))
        .collect();
    // 截断/不完整的残件（历史版本非原子写遗留）既不能恢复，也不该
    // 占用滚动保留配额（挤掉真实备份）——但 looks_complete 只是「末字节是
    // '}'」的廉价探测，用户手工编辑过的合法备份（截尾空白/无收尾换行等）
    // 可能被误判「不完整」，直接删除等于误删用户数据。改为追加 `.incomplete`
    // 后缀隔离：隔离件不以 .json 结尾、不再匹配 is_backup_name，既不进恢复
    // 列表也不占配额，用户可手工去后缀找回。list_backups 的 looks_complete
    // 过滤维持不变（两边列举语义保持一致）。rename 失败仅留痕（文件可能被
    // 独占），此时它仍以原名残留、下轮 prune 重试。
    files.retain(|p| {
        if looks_complete(p) {
            true
        } else {
            let mut quarantined = p.clone().into_os_string();
            quarantined.push(".incomplete");
            if let Err(e) = fs::rename(p, &quarantined) {
                log::warn!(
                    "prune: failed to quarantine incomplete {}: {e}",
                    p.display()
                );
            }
            false
        }
    });
    // 按文件名内嵌时间戳排序（跨品牌前缀时字符串序会误删新备份）。
    files.sort_by(|a, b| cmp_backup_names(&file_name_of(a), &file_name_of(b)));
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
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_backup_name(&name) {
            continue;
        }
        // 截断/不完整的文件不进恢复列表（looks_complete 与 prune /
        // today_backup 同口径），避免用户选中坏文件恢复失败。
        if !looks_complete(&entry.path()) {
            continue;
        }
        infos.push(BackupInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            created_at: backup_created_at(&entry.path()),
        });
    }
    // 新→旧按文件名内嵌时间戳排（跨品牌前缀时字符串序会误排）。
    infos.sort_by(|a, b| cmp_backup_names(&b.name, &a.name));
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

    /// 文件名比较用内嵌时间戳，跨品牌前缀不再被字符串序误导。
    #[test]
    fn cmp_uses_embedded_timestamp_across_prefixes() {
        // 字符串序 "focus-desk-…" < "vela-…"，但时间戳 150000 > 120000。
        assert_eq!(
            cmp_backup_names(
                "focus-desk-20260813-150000.json",
                "vela-20260813-120000.json"
            ),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            cmp_backup_names("vela-20260813-120000.json", "vela-20260813-120001.json"),
            std::cmp::Ordering::Less
        );
        // 解析失败（段形不合法）回退字符串序，保证全序确定。
        assert_eq!(
            cmp_backup_names("vela-weird.json", "vela-20260813-120000.json"),
            "vela-weird.json".cmp("vela-20260813-120000.json")
        );
    }

    /// 同日去重取时间戳最新者，而非字符串序最大者。
    #[test]
    fn today_backup_prefers_newest_timestamp_across_prefixes() {
        let dir = std::env::temp_dir().join(format!("fd-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vela-20260813-120000.json"), "{}").unwrap();
        fs::write(dir.join("focus-desk-20260813-150000.json"), "{}").unwrap();
        let found = today_backup(&dir, "20260813")
            .unwrap()
            .expect("应命中当日备份");
        // 字符串序会误选 vela-120000；时间戳序应选 focus-desk-150000。
        assert_eq!(found.name, "focus-desk-20260813-150000.json");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 截断残件不占滚动保留配额，但也不再直接删除——looks_complete
    /// 是廉价探测（末字节 '}'），用户手工编辑过的备份可能被误判，误删不可
    /// 逆；改为改名隔离（`.incomplete` 后缀），可手工找回。
    #[test]
    fn prune_quarantines_incomplete_files_instead_of_deleting() {
        let dir = std::env::temp_dir().join(format!("fd-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // KEEP 份完整 + 1 份最旧的截断残件。
        for i in 0..KEEP {
            fs::write(
                dir.join(format!(
                    "vela-202609{:02}-{:02}0000.json",
                    1 + i / 24,
                    i % 24
                )),
                "{}",
            )
            .unwrap();
        }
        let truncated = dir.join("focus-desk-20260101-000000.json");
        fs::write(&truncated, "{\"tasks\":[1,2,").unwrap(); // 不以 '}' 结尾
        prune(&dir).unwrap();
        // 原名消失（不占配额、不进恢复列表）……
        assert!(!truncated.exists(), "残件应离开滚动备份命名空间");
        // ……但内容被隔离保留（追加 .incomplete 后缀，可手工找回），而非删除。
        let quarantined = dir.join("focus-desk-20260101-000000.json.incomplete");
        assert!(quarantined.exists(), "残件应被改名隔离而非删除");
        assert_eq!(
            fs::read_to_string(&quarantined).unwrap(),
            "{\"tasks\":[1,2,"
        );
        // 目录 = KEEP 份完整 + 1 份隔离件；隔离件不匹配 is_backup_name，
        // 下轮 prune / list_backups 都不再触碰它。
        let remaining = fs::read_dir(&dir).unwrap().count();
        assert_eq!(remaining, KEEP + 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 隔离件（.incomplete 后缀）不再匹配 is_backup_name——
    /// today_backup / list_backups / prune 三条列举路径都天然排除。
    #[test]
    fn quarantined_files_leave_the_backup_namespace() {
        let dir = std::env::temp_dir().join(format!("fd-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let name = "focus-desk-20260101-000000.json";
        fs::write(dir.join(name), "truncated").unwrap();
        prune(&dir).unwrap();
        let quarantined = format!("{name}.incomplete");
        // 隔离后：今日去重不命中、再跑 prune 不会二次处理。
        assert!(today_backup(&dir, "20260101").unwrap().is_none());
        assert!(!is_backup_name(&quarantined));
        assert!(is_backup_name(name));
        prune(&dir).unwrap();
        assert!(dir.join(&quarantined).exists(), "隔离件稳定保留");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 写盘残件清理认双品牌前缀——legacy
    /// `focus-desk-*.json.tmp` 与 `vela-*.json.tmp` 都要清；本轮正在写的
    /// tmp（keep）与非 tmp 文件不动。
    #[test]
    fn stale_tmp_cleanup_covers_both_brand_prefixes() {
        let dir = std::env::temp_dir().join(format!("fd-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let keep = "vela-20260813-120000.json.tmp";
        let legacy_tmp = "focus-desk-20260101-000000.json.tmp";
        let current_tmp = "vela-20260812-000000.json.tmp";
        let real_backup = "vela-20260811-000000.json";
        let foreign = "user-notes.json.tmp"; // 非本应用前缀：不属于清理面
        for f in [keep, legacy_tmp, current_tmp, real_backup, foreign] {
            fs::write(dir.join(f), "{}").unwrap();
        }
        clean_stale_tmp_files(&dir, keep);
        assert!(dir.join(keep).exists(), "本轮 tmp 不清（rename 在后）");
        assert!(
            !dir.join(legacy_tmp).exists(),
            "legacy focus-desk- 残件必须被清（P3-7）"
        );
        assert!(!dir.join(current_tmp).exists(), "vela- 残件照旧被清");
        assert!(dir.join(real_backup).exists(), "正式备份不动");
        assert!(
            dir.join(foreign).exists(),
            "非本应用文件不碰（防误删用户数据）"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
