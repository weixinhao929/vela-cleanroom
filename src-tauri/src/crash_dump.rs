//! [CRASH-DUMP]原生层崩溃转储 + 崩溃自恢复提示。
//!
//! 此前覆盖面：Rust panic（logging::install_panic_hook → crash-log.json）与前端
//! 异常（ErrorBoundary → report_frontend_crash）；缺的是 SEH 未处理异常（WebView2/
//! GDI/驱动交互等原生路径）的现场。本模块补两件事：
//!  1. [`install_exception_filter`]：`SetUnhandledExceptionFilter` → dbghelp
//!     `MiniDumpWriteDump` 落 `<data>/crashlog/vela-<ts>.dmp`（MiniDumpNormal，
//!     小体积）+ 旁车 `.txt`（异常码 / 异常地址 / 崩溃模块与基址 / 版本——
//!     符号化脚本的输入）。写完返回 CONTINUE_SEARCH 交回系统默认处理（WER
//!     照常出现），不吞异常。同类工具 从 v0.2d 起同款做法。
//!  2. [`check_last_shutdown` / [`write_clean_marker`]]：clean-exit 标记
//!     （`<data>/shutdown.clean`）。正常退出写、启动即读删；启动时标记缺失
//!     且崩溃记录非空 → 系统 Toast「上次异常退出」附日志目录。
//!
//! 崩溃路径纪律：过滤器回调在崩溃线程上执行，只做最少量工作（拼路径、
//! CreateFile、MiniDumpWriteDump、写旁车）；所有用户无关文案（版本/时间戳）
//! 才进 format!——崩溃路径无用户文本，无格式串注入面。

use std::path::{Path, PathBuf};

/// 崩溃转储目录名（`<app_data>/crashlog`，与日志目录平级）。
pub const CRASHLOG_DIR: &str = "crashlog";
/// clean-exit 标记文件名（`<app_data>/shutdown.clean`）。
pub const CLEAN_MARKER: &str = "shutdown.clean";

#[cfg(windows)]
static DATA_DIR: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// 安装 SEH 未处理异常过滤器（run() 早期、logging::init 之后调用一次）。
pub fn install_exception_filter(data_dir: &Path) {
    #[cfg(windows)]
    {
        *DATA_DIR.lock().unwrap_or_else(|p| p.into_inner()) = Some(data_dir.to_path_buf());
        // SAFETY: 过滤器为进程级一次性安装；回调内只做受限 IO。
        unsafe {
            windows::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter(Some(
                unhandled_filter,
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
    }
}

#[cfg(windows)]
unsafe extern "system" fn unhandled_filter(
    info: *const windows::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
) -> i32 {
    // 崩溃路径：不 panic、不递归日志；任何失败静默（默认处理兜底）。
    let dir = DATA_DIR
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(dir.join(CRASHLOG_DIR));
    let ts = chrono::Utc::now().format("%Y%m%d%H%M%S");
    let dump_path = dir.join(CRASHLOG_DIR).join(format!("vela-{ts}.dmp"));
    let sidecar_path = dir.join(CRASHLOG_DIR).join(format!("vela-{ts}.txt"));

    let mut code = 0u32;
    let mut addr = 0usize;
    let mut module = String::new();
    let mut module_base = 0usize;
    if !info.is_null() {
        let rec = (*info).ExceptionRecord;
        if !rec.is_null() {
            code = (*rec).ExceptionCode.0 as u32;
            addr = (*rec).ExceptionAddress as usize;
            // 解析崩溃地址所属模块（FROM_ADDRESS + UNCHANGED_REFCOUNT：不加
            // 引用、不动模块表；LibraryLoader 而非 WindowsAndMessaging）。
            use windows::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleExW};
            use windows::Win32::System::LibraryLoader::{
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            };
            let mut hmod = windows::Win32::Foundation::HMODULE::default();
            let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
            if GetModuleHandleExW(flags, windows::core::PCWSTR(addr as *const u16), &mut hmod)
                .is_ok()
                && !hmod.is_invalid()
            {
                module_base = hmod.0 as usize;
                let mut buf = [0u16; 512];
                let n = GetModuleFileNameW(Some(hmod), &mut buf);
                if n > 0 {
                    module = String::from_utf16_lossy(&buf[..n as usize]);
                }
            }
        }
    }

    // 旁车先写（比 dmp 便宜；dmp 失败时至少留下定位线索）。
    let rva = addr.saturating_sub(module_base);
    let sidecar = format!(
        "Vela native crash {ts}\nversion={}\nexception_code=0x{code:08X}\nexception_addr=0x{addr:X}\nmodule={module}\nmodule_base=0x{module_base:X}\nrva=0x{rva:X}\n",
        env!("CARGO_PKG_VERSION")
    );
    let _ = std::fs::write(&sidecar_path, sidecar);

    let _ = write_minidump(&dump_path, info as *mut _);
    /*这里不再调用 log::error!——若崩溃恰发生在持有 logger sink
    Mutex 的临界区内（writeln! 期间），过滤器内的 log 调用对非重入锁二次
    加锁会挂死崩溃处理器，dmp/旁车都可能写不出（与上方「不递归日志」的
    纪律注释保持一致）。旁车文件已含同一信息，诊断不缺证据。 */
    // EXCEPTION_CONTINUE_SEARCH：交回系统默认处理链（此前安装的过滤器 / WER）。
    0
}

#[cfg(windows)]
unsafe fn write_minidump(
    dump_path: &Path,
    info: *mut windows::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
) -> Result<(), String> {
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, OPEN_ALWAYS,
    };
    use windows::Win32::System::Diagnostics::Debug::{
        MiniDumpNormal, MiniDumpWriteDump, MINIDUMP_EXCEPTION_INFORMATION,
    };

    // 非 ASCII 路径必须走 OsStr→UTF-16 原生转换（to_string_lossy 会在用户名
    // 含不可映射字符时产出错误路径）。
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = dump_path.as_os_str().encode_wide().collect();
    wide.push(0);
    // SAFETY: 崩溃路径上的受限文件创建（本应用数据目录；GENERIC_WRITE=0x4000_0000）。
    let handle = CreateFileW(
        windows::core::PCWSTR(wide.as_ptr()),
        0x4000_0000,
        FILE_SHARE_READ,
        None,
        OPEN_ALWAYS,
        FILE_FLAGS_AND_ATTRIBUTES(0),
        None,
    )
    .map_err(|e| format!("CreateFileW failed: {e}"))?;
    let mei = MINIDUMP_EXCEPTION_INFORMATION {
        ThreadId: current_thread_id(),
        ExceptionPointers: info,
        ClientPointers: windows::core::BOOL::from(false),
    };
    // SAFETY: 进程伪句柄（-1 = 自身）+ 自身崩溃上下文（ClientPointers=FALSE）。
    let result = MiniDumpWriteDump(
        windows::Win32::Foundation::HANDLE(-1isize as *mut core::ffi::c_void),
        std::process::id(),
        handle,
        MiniDumpNormal,
        Some(&mei as *const _),
        None,
        None,
    );
    // SAFETY: 成对关闭。
    let _ = windows::Win32::Foundation::CloseHandle(handle);
    result.map_err(|e| format!("MiniDumpWriteDump failed: {e}"))
}

#[cfg(windows)]
fn current_thread_id() -> u32 {
    // SAFETY: 纯查询当前线程 id。
    unsafe { windows::Win32::System::Threading::GetCurrentThreadId() }
}

/* ------------------------------------------------------------------ */
/* 崩溃自恢复：clean-exit 标记 + 启动检测。                             */
/* ------------------------------------------------------------------ */

/// 启动时调用：读并删除标记。返回 Some(dir) 表示「上次异常退出」（标记缺失
/// 且崩溃记录非空；首次运行崩溃记录为空 → 不打扰）。dir = 日志目录（提示里
/// 附上路径）。
pub fn check_last_shutdown(data_dir: &Path) -> Option<PathBuf> {
    let marker = data_dir.join(CLEAN_MARKER);
    if marker.exists() {
        // 上次正常退出：吃掉标记（本次运行内再崩 = 下次启动时标记缺失）。
        let _ = std::fs::remove_file(&marker);
        return None;
    }
    // 标记缺失：首次运行（从未写过）或异常退出。有崩溃记录才算异常退出。
    let crash_file = data_dir.join(crate::logging::CRASH_FILE_NAME);
    let has_records = !crate::logging::load_crashes(&crash_file).is_empty();
    has_records.then(|| data_dir.to_path_buf())
}

/// 正常退出时调用（RunEvent::Exit）：写 clean 标记。
pub fn write_clean_marker(data_dir: &Path) {
    if let Some(parent) = data_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(data_dir.join(CLEAN_MARKER), b"clean");
}

/* ------------------------------------------------------------------ */
/* 崩溃转储保留策略：崩溃循环 + 常驻数月会无限累积 .dmp/.txt。 */
/* ------------------------------------------------------------------ */

/// 每份转储保留的最大条数（vela-<ts>.dmp/.txt 成对算一份）。
const KEEP_MAX: usize = 10;
/// 超龄删除阈值（天）。
const KEEP_DAYS: i64 = 30;

/// 启动时清理崩溃转储目录：保留最近 [`KEEP_MAX`] 份；任一文件超过
/// [`KEEP_DAYS`] 天即删（按文件修改时间，.dmp 与 .txt 同时间戳成对消失）。
/// 与日志/剪贴板/通知/snip 的清理同口径——此前全仓唯此目录只增不减。
pub fn prune_crashlogs(data_dir: &Path) {
    let dir = data_dir.join(CRASHLOG_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let now = chrono::Utc::now();
    // (mtime, path)：非 vela-* 文件不动（用户可能手工放东西）。
    let mut dumps: Vec<(chrono::DateTime<chrono::Utc>, PathBuf)> = Vec::new();
    let mut stale: Vec<PathBuf> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.starts_with("vela-") || !(name.ends_with(".dmp") || name.ends_with(".txt")) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let mtime: chrono::DateTime<chrono::Utc> = modified.into();
        if now.signed_duration_since(mtime).num_days() >= KEEP_DAYS {
            stale.push(p);
        } else {
            dumps.push((mtime, p));
        }
    }
    // 超龄直接删；未超龄的按新→旧保留前 KEEP_MAX 对（=2*KEEP_MAX 个文件）。
    dumps.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
    for (_, p) in dumps.iter().skip(KEEP_MAX * 2) {
        stale.push(p.clone());
    }
    if stale.is_empty() {
        return;
    }
    let n = stale.len();
    for p in &stale {
        let _ = std::fs::remove_file(p);
    }
    log::info!(
        "crash_dump: pruned {n} stale crash log files in {}",
        dir.display()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标记状态机：正常退出 → 下次启动吃掉标记不打扰；异常退出（无标记 +
    /// 有崩溃记录）→ 报告；首次运行（无标记 + 无记录）→ 不打扰。
    #[test]
    fn marker_semantics() {
        let tmp = std::env::temp_dir().join(format!("vela-crash-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // 首次运行：无标记、无崩溃记录 → None。
        assert!(check_last_shutdown(&tmp).is_none());

        // 正常退出写标记 → 下次启动：吃掉标记，None。
        write_clean_marker(&tmp);
        assert!(check_last_shutdown(&tmp).is_none());
        // 标记已被吃掉：此刻起「异常退出」（模拟：直接查，无标记）。
        // 再造一份崩溃记录 → 报告 Some(dir)。
        let rec = crate::logging::CrashRecord {
            ts: crate::logging::now_ms(),
            kind: "panic".to_string(),
            source: "test".to_string(),
            summary: "boom".to_string(),
        };
        crate::logging::record_crash(
            &tmp.join(crate::logging::CRASH_FILE_NAME),
            rec,
            crate::logging::now_ms(),
        )
        .unwrap();
        assert!(check_last_shutdown(&tmp).is_some());
        // 正常退出再次写标记后又不打扰。
        write_clean_marker(&tmp);
        assert!(check_last_shutdown(&tmp).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
