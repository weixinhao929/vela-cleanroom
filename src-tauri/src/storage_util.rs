//! 文本原子写工具（BentoDesk 借鉴 #11）：Rust 侧散落的 JSON 状态写统一
//! 走这里——同目录 `.tmp` → `sync_all` → 原子改名；Windows 上目标已存在时
//! `std::fs::rename` 会报错，改用 `MoveFileExW(REPLACE_EXISTING |
//! WRITE_THROUGH)`（等价 BentoDesk 的 ReplaceFileW → MoveFileExW 降级链，
//! 只是后者顺手产出 .bak，我们的调用点均为可再生文件，不需要 .bk 双保险）。
//!
//! 收益：进程中途被杀时最坏留下一个 `.tmp`（下次写入前清理），主文件永不
//! 截断。backup.rs 的备份写自带同款逻辑与残件清理，保持独立不并轨。

use std::io;
use std::path::Path;

/// 原子写文本文件（UTF-8）：tmp → sync → rename（存在则替换）。
pub fn write_text_atomic(path: &Path, contents: &str) -> io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{stem}.tmp-{}", std::process::id()));
    // 顺手清掉上次被杀进程留下的同前缀残件（best-effort）。
    cleanup_tmp_siblings(path);
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
    }
    let result = (|| -> io::Result<()> {
        if std::fs::rename(&tmp, path).is_ok() {
            return Ok(());
        }
        #[cfg(windows)]
        {
            // Windows：目标存在时 std rename 失败 → MoveFileExW 覆盖式移动。
            win_move_replace(&tmp, path)
        }
        #[cfg(not(windows))]
        {
            // POSIX rename 本身覆盖目标；到这里说明真失败。
            Err(io::Error::new(io::ErrorKind::Other, "rename failed"))
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 写前清理同目录下本进程/陈旧进程留下的同前缀 tmp 残件（best-effort）。
pub fn cleanup_tmp_siblings(path: &Path) {
    let Some(dir) = path.parent() else { return };
    let Some(stem) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let prefix = format!(".{stem}.tmp-");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let n = entry.file_name().to_string_lossy().to_string();
            if n.starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(windows)]
fn win_move_replace(src: &Path, dest: &Path) -> io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::MoveFileExW;
    use windows::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
    use windows::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;

    fn wide(p: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    let ok = unsafe {
        MoveFileExW(
            PCWSTR(wide(src).as_ptr()),
            PCWSTR(wide(dest).as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok.is_ok() {
        Ok(())
    } else {
        let err = io::Error::last_os_error();
        Err(io::Error::new(
            err.kind(),
            format!("MoveFileExW 失败：{err}"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("vela-atomic-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn writes_new_and_replaces_existing() {
        let p = tmp_file("a.json");
        write_text_atomic(&p, "{\"v\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"v\":1}");
        // 覆盖已有目标（Windows 上走 MoveFileExW 分支）。
        write_text_atomic(&p, "{\"v\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"v\":2}");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn cleanup_removes_only_matching_tmp() {
        let dir = std::env::temp_dir().join(format!("vela-atomic-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let main = dir.join("state.json");
        write_text_atomic(&main, "x").unwrap();
        // 手放一个残件 + 一个无关 tmp。
        std::fs::write(dir.join(".state.json.tmp-9999"), b"stale").unwrap();
        std::fs::write(dir.join(".other.json.tmp-1"), b"keep").unwrap();
        cleanup_tmp_siblings(&main);
        assert!(!dir.join(".state.json.tmp-9999").exists());
        assert!(dir.join(".other.json.tmp-1").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
