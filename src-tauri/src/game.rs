//! Fullscreen/game detection helpers. The 1s polling watcher itself moved to
//! `presence.rs` (§4.6: foreground fullscreen + input idle merged into one
//! presence thread); this module keeps the foreground-window probe shared by
//! the presence watcher and the diagnostics command below, plus the legacy
//! event names documented for consumers.

use serde::Serialize;
use std::sync::Mutex;

/// Snapshot of the foreground window state.
#[derive(Clone, Debug, Serialize)]
pub struct ForegroundApp {
    pub process_name: String,
    pub window_title: String,
    pub is_fullscreen: bool,
}

/// [CTX]/[WAKE-BL]（ZTools 借鉴 #2/#14）「呼出前前台」快照：全局热键 dispatch
/// 在做任何窗口编排（置前 / 聚焦）**之前**抓一次前台，供面板上下文探针
/// （read_explorer_path / read_browser_url）与唤醒黑名单消费——事后再取
/// GetForegroundWindow 只会得到 Vela 自己。
#[derive(Clone, Debug)]
pub(crate) struct ForegroundSnapshot {
    /// 前台窗口句柄（isize 以便跨线程静态存放）。
    pub hwnd: isize,
    pub app: ForegroundApp,
}

pub(crate) static LAST_SUMMON_FG: Mutex<Option<ForegroundSnapshot>> = Mutex::new(None);

/// 抓当前前台快照并写入静态（窗口编排前调用）。
pub(crate) fn capture_foreground_snapshot() {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return;
        }
        if let Some(app) = foreground_app() {
            let mut guard = LAST_SUMMON_FG.lock().unwrap_or_else(|p| p.into_inner());
            *guard = Some(ForegroundSnapshot {
                hwnd: hwnd.0 as isize,
                app,
            });
        }
    }
}

/// 取最近一次快照（不消费；isize 句柄 + 进程信息）。
pub(crate) fn last_summon_snapshot() -> Option<ForegroundSnapshot> {
    LAST_SUMMON_FG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Returns the currently focused window's process name and whether it covers
/// the entire primary screen (i.e. a fullscreen game / app).
#[cfg(windows)]
pub(crate) fn foreground_app() -> Option<ForegroundApp> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, SM_CXSCREEN, SM_CYSCREEN,
    };

    // SAFETY: GetForegroundWindow returns a valid foreground hwnd or null.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }

    // True if the window rect matches the primary screen working bounds.
    let mut rect = windows::Win32::Foundation::RECT::default();
    // SAFETY: output buffer.
    let _ = unsafe { GetWindowRect(hwnd, &mut rect) };
    // SAFETY: GetSystemMetrics is a simple query.
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    let is_fullscreen = screen_w > 0 && screen_h > 0 && w >= screen_w && h >= screen_h;

    // Resolve the process image name via the window's owning PID.
    let mut pid: u32 = 0;
    // SAFETY: pid buffer.
    let _ = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let mut process_name = String::new();
    if pid != 0 {
        // SAFETY: QUERY_LIMITED_INFORMATION succeeds even for elevated /
        // protected processes where full QUERY_INFORMATION is denied.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
        if let Ok(handle) = handle {
            let mut buf = [0u16; 260];
            // GetProcessImageFileNameW returns the full DOS path; take the file name stem.
            // SAFETY: buffer is valid.
            let len = unsafe { GetProcessImageFileNameW(handle, &mut buf) };
            if len > 0 {
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                if let Some(name) = path.rsplit('\\').next() {
                    process_name = name.to_string();
                }
            }
            // SAFETY: closing an owned handle.
            unsafe {
                let _ = CloseHandle(handle);
            }
        }
    }

    // Window title (best-effort).
    let mut title = [0u16; 256];
    // SAFETY: buffer is valid.
    let tlen = unsafe { GetWindowTextW(hwnd, &mut title) };
    let window_title = if tlen > 0 {
        String::from_utf16_lossy(&title[..tlen as usize])
    } else {
        String::new()
    };

    Some(ForegroundApp {
        process_name,
        window_title,
        is_fullscreen,
    })
}

#[cfg(not(windows))]
pub(crate) fn foreground_app() -> Option<ForegroundApp> {
    None
}

/// Tauri command: query the current foreground app state (for the settings
/// page / diagnostics).
/// 隐私闸门（S4）：前台应用时间线属敏感枚举面，低信任窗拒绝。
#[tauri::command]
pub fn get_foreground_app(window: tauri::Window) -> Option<ForegroundApp> {
    if !crate::trusted_window(window.label()) {
        return None;
    }
    foreground_app()
}

/// [CTX]（ZTools 借鉴 #2）最近一次「呼出前前台」快照的进程信息（热键 dispatch
/// 在窗口编排前抓取；面板上下文探针据此判断 Explorer / 浏览器）。
#[tauri::command]
pub fn get_summon_foreground(window: tauri::Window) -> Option<ForegroundApp> {
    if !crate::trusted_window(window.label()) {
        return None;
    }
    last_summon_snapshot().map(|s| s.app)
}
