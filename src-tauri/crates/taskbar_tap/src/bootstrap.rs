//! DLL 引导：标记事件检测 → init 线程 → InitializeXamlDiagnosticsEx 重试。
//!
//! 注入约定（与注入器 / inject_demo 共享）：注入器在注入前创建命名事件
//! `Local\velatap-inject-<explorer_pid>`（存在即可、状态无关），DllMain 检测
//! 到才继续（标记事件语义：仅注入路径加载才初始化）。手动 LoadLibrary 加载本 DLL 的
//! 场景探测不到事件 → 完全休眠。
//!
//! DllMain 铁律：不做 LoadLibrary / COM / 阻塞调用（loader lock），只
//! OpenEvent + CreateThread + 立即返回 TRUE。
//!
//! 生命周期：本 DLL 一旦初始化成功就被 XAML Diagnostics pin 住、**永不卸载**
//! （lib.rs `DllCanUnloadNow` 恒 S_FALSE），服务面（管道线程）也随之常驻——
//! 主进程退出 / 崩溃 / 重启都靠它重连恢复，见 pipe_client.rs / parent_watch.rs。
//! 同一 explorer 里只允许一份：init 线程先做同名模块自检，发现另一路径的
//! velatap.dll 已驻留即拒绝服务（两份副本各挂一套 XAML 回调同时操作同一批
//! BackgroundFill 是已知的崩溃结构）。

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenEventW};

use crate::diag::CLSID_VELATAP_SITE;

/// 标记事件名（`<pid>` = explorer PID = 本进程）。
pub fn inject_marker_event_name(pid: u32) -> String {
    format!(r"Local\velatap-inject-{pid}")
}

/// 防重入：DllMain 可能因 LoadLibrary 多次触发。
static INIT_STARTED: AtomicBool = AtomicBool::new(false);

/// init 线程持有的本模块引用（process_attach 时 +1；见 util::acquire_self_reference）。
static PINNED_MODULE: AtomicIsize = AtomicIsize::new(0);

/// DllMain 的 PROCESS_ATTACH 分支（lib.rs 调入）。返回 false = 加载失败。
pub fn process_attach() -> bool {
    crate::vlog!("process_attach: marker={}", marker_event_exists());
    if !marker_event_exists() {
        // 不是被注入加载：静默休眠（DllMain 仍返回 TRUE，模块可正常卸载）。
        return true;
    }
    if INIT_STARTED.swap(true, Ordering::SeqCst) {
        return true; // 已在初始化（防御理论上的二次注入）。
    }
    // 先给本模块 +1 引用再起 init 线程：在 IXDE 重试窗口（最长 30s）内宿主随时
    // 可能摘钩子（停用 / 退出 / 被强杀 → OS 自动摘钩），摘钩即卸载——没有这个
    // 引用，init 线程会在已解除映射的模块里执行。GetModuleHandleEx 自身引用在
    // DllMain 的 loader lock 内是安全的（模块已加载，只 +1 计数，无新依赖）。
    let pinned = crate::util::acquire_self_reference();
    PINNED_MODULE.store(pinned.map_or(0, |m| m.0 as isize), Ordering::SeqCst);
    if pinned.is_none() {
        crate::vlog!("process_attach: self-reference failed; proceeding unguarded");
    }
    // 原生 CreateThread：DllMain 里避开 std::thread 的分配器/初始化栈。
    let spawned = unsafe {
        windows::Win32::System::Threading::CreateThread(
            None,
            0,
            Some(init_thread_trampoline),
            None,
            windows::Win32::System::Threading::THREAD_CREATION_FLAGS(0),
            None,
        )
    };
    match spawned {
        Ok(thread) => {
            let _ = unsafe { CloseHandle(thread) };
            true
        }
        Err(_) => {
            // 极罕见：线程起不来。此时**不能**返回 false（loader 会按加载失败
            // 卸载模块，而我们持有的 +1 引用不会被释放，映射与计数即告脱节）；
            // 保持 TRUE：模块带一个休眠引用常驻，下次注入走「驻留同版本 → 唤醒」
            // 失败路径，由用户重启 explorer 收敛。
            crate::vlog!("process_attach: init thread spawn failed; module stays dormant");
            true
        }
    }
}

fn pinned_module() -> Option<windows::Win32::Foundation::HMODULE> {
    let raw = PINNED_MODULE.swap(0, Ordering::SeqCst);
    if raw == 0 {
        None
    } else {
        Some(windows::Win32::Foundation::HMODULE(
            raw as *mut core::ffi::c_void,
        ))
    }
}

unsafe extern "system" fn init_thread_trampoline(_param: *mut core::ffi::c_void) -> u32 {
    let r = crate::util::guarded("init thread", init_thread);
    if r.is_err() {
        // 失败路径：释放 process_attach 持有的模块引用并结束线程。此刻本线程是
        // 模块内唯一活动线程（attempt 线程已 join、管道线程未起），原子地
        // 「减计数 + 退出」后，宿主摘钩即可安全卸载，不留悬空线程。
        if let Some(module) = pinned_module() {
            unsafe {
                windows::Win32::System::LibraryLoader::FreeLibraryAndExitThread(module, 0);
            }
        }
    }
    0
}

fn marker_event_exists() -> bool {
    let name = inject_marker_event_name(unsafe { GetCurrentProcessId() });
    let mut buf: Vec<u16> = name.encode_utf16().collect();
    buf.push(0);
    // SYNCHRONIZE(0x00100000) | EVENT_MODIFY_STATE(0x0002)：只探测存在性。
    let access = windows::Win32::System::Threading::SYNCHRONIZATION_ACCESS_RIGHTS(0x0010_0002);
    match unsafe { OpenEventW(access, false, PCWSTR(buf.as_ptr())) } {
        Ok(event) => {
            let _ = unsafe { CloseHandle(event) };
            true
        }
        Err(_) => false,
    }
}

/// init 线程主体：管道客户端先行（主进程在等握手），再做 XAML 重试。
fn init_thread() -> windows_core::Result<()> {
    // 显式持一个 MTA 引用：RoGetActivationFactory 在未 CoInitialize 的
    // std 线程上走隐式 MTA，这里消除边角环境失败。
    let _mta_cookie = unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() };

    // 拒二次服务自检：同一 explorer 已驻留另一路径的 velatap.dll（升级 / 重编
    // 后的第二副本）→ 本副本完全不初始化（失败 = 静默退出注入）。注入器侧
    // 同样先查驻留，这里是纵深防御，防老版本注入器 / 手工注入。
    let another = another_copy_resident();
    crate::vlog!("init_thread: another_copy_resident={another}");
    if another {
        crate::vlog!("another velatap.dll is already resident in this explorer; refusing to serve");
        return Err(windows_core::Error::from_hresult(windows_core::HRESULT(
            0x8007_04D5_u32 as i32, // ERROR_ALREADY_INITIALIZED
        )));
    }

    // 顺序（TAP_READY_EVENT 时序约定）：**先** InitializeXamlDiagnosticsEx
    // 成功把本 DLL pin 进 explorer，**再**起管道客户端。IXDE 失败（60×500ms
    // 重试后）则完全不起服务——注入器的 35s 等待超时走失败路径。重试窗口内模块
    // 由 process_attach 持有的引用兜住（宿主提前摘钩子不会把正在重试的线程连
    // 模块一起卸掉）；失败后由 trampoline 释放该引用并退出线程，摘钩即卸载。
    initialize_xaml_diagnostics()?;
    crate::vlog!("init_thread: IXDE ok, spawning pipe client");

    std::thread::Builder::new()
        .stack_size(128 * 1024)
        .spawn(move || {
            // 管道客户端是本 DLL 的服务主线程，漏网 panic
            // 原先只会静默死线程——外观永久失效直到 explorer 重启（DLL 侧重连
            // 循环就活在这条线程里）。围栏 + 有界重启（5 次预算、2s 间隔）：
            // 单次 panic 自愈，panic 风暴退避为静默死亡交给宿主恢复线兜底。
            let mut restarts = 0u32;
            loop {
                crate::util::run_guarded("pipe-client", crate::pipe_client::run);
                restarts += 1;
                if restarts > 5 {
                    crate::vlog!("pipe-client: exceeded restart budget, giving up");
                    return;
                }
                crate::vlog!("pipe-client: died, restarting ({restarts}/5)");
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        })
        .map_err(|e| {
            crate::vlog!("pipe thread spawn failed: {e}");
            windows_core::Error::from_hresult(windows_core::HRESULT(0x8000_FFFF_u32 as i32))
        })?;

    Ok(())
}

/// 本进程内是否已有**另一路径**的 velatap.dll（同路径 = 同一模块，Windows 不会
/// 重复映射；不同路径 = 不同哈希目录 = 另一个版本的副本）。Toolhelp 快照在
/// init 线程上调用（不在 DllMain 的 loader lock 内）。
fn another_copy_resident() -> bool {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    };
    let Some(self_path) = self_path() else {
        return false;
    };
    let self_path = String::from_utf16_lossy(&self_path).to_ascii_lowercase();
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, 0) }) else {
        return false;
    };
    let mut entry = MODULEENTRY32W {
        dwSize: core::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = false;
    if unsafe { Module32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let name = utf16_z(&entry.szModule);
            if name.eq_ignore_ascii_case("velatap.dll") {
                let path = utf16_z(&entry.szExePath).to_ascii_lowercase();
                if path != self_path {
                    crate::vlog!("resident copy at {path} (self: {self_path})");
                    found = true;
                    break;
                }
            }
            if unsafe { Module32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };
    found
}

fn utf16_z(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 本 DLL 所在目录（debug 构建的 mockver 联调钩子用，见 pipe_client.rs）。
#[cfg(debug_assertions)]
pub fn self_dir() -> Option<std::path::PathBuf> {
    let path = std::path::PathBuf::from(String::from_utf16_lossy(&self_path()?));
    path.parent().map(std::path::Path::to_path_buf)
}

/// 本 DLL 自身路径（XAML Diagnostics 的 TAP DLL 参数）。
fn self_path() -> Option<Vec<u16>> {
    let module = crate::util::self_module()?;
    let mut buf = vec![0u16; 1024];
    let len = unsafe {
        windows::Win32::System::LibraryLoader::GetModuleFileNameW(Some(module), &mut buf)
    };
    if len == 0 || len as usize >= buf.len() {
        None
    } else {
        buf.truncate(len as usize);
        Some(buf)
    }
}

type InitializeXamlDiagnosticsEx = unsafe extern "system" fn(
    endpoint_name: PCWSTR,
    process_id: u32,
    xaml_diagnostics_path: PCWSTR,
    tap_dll_path: PCWSTR,
    tap_clsid: *const windows_core::GUID,
    initialization_data: PCWSTR,
) -> windows_core::HRESULT;

/// LoadLibrary("Windows.UI.Xaml.dll") → 取
/// `InitializeXamlDiagnosticsEx("VisualDiagConnectionN", pid, null, 本DLL,
/// CLSID_VELATAP_SITE, null)`，失败重试 60×500ms。
///
/// 每次 attempt 都在**新线程**上调（XAML Diagnostics 每线程只能初始化一次，
/// 重试即返回假成功——对齐 tapsite.cpp:44-64 的 std::thread(...).join()）。
fn initialize_xaml_diagnostics() -> windows_core::Result<()> {
    let wux = unsafe {
        LoadLibraryExW(
            windows::core::w!("Windows.UI.Xaml.dll"),
            None,
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    let wux = wux.map_err(|e| {
        crate::vlog!("LoadLibraryExW(Windows.UI.Xaml.dll) failed: {e}");
        e
    })?;
    let ixde: InitializeXamlDiagnosticsEx = unsafe {
        match GetProcAddress(wux, windows::core::s!("InitializeXamlDiagnosticsEx")) {
            Some(p) => core::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                InitializeXamlDiagnosticsEx,
            >(p),
            None => return Err(windows_core::Error::from_win32()),
        }
    };
    let Some(mut dll_path) = self_path() else {
        return Err(windows_core::Error::from_hresult(
            windows_core::HRESULT(0x8007_0002_u32 as i32), // ERROR_FILE_NOT_FOUND
        ));
    };
    dll_path.push(0);
    let pid = unsafe { GetCurrentProcessId() };

    let mut attempts: u32 = 0;
    loop {
        attempts += 1;
        let conn: Vec<u16> = format!("VisualDiagConnection{attempts}")
            .encode_utf16()
            .chain(core::iter::once(0))
            .collect();
        let dll_path = dll_path.clone();
        let conn = conn.clone();

        let attempt = std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(move || unsafe {
                ixde(
                    PCWSTR(conn.as_ptr()),
                    pid,
                    PCWSTR::null(),
                    PCWSTR(dll_path.as_ptr()),
                    &CLSID_VELATAP_SITE,
                    PCWSTR::null(),
                )
            })
            .map_err(|_| {
                windows_core::Error::from_hresult(windows_core::HRESULT(0x8000_FFFF_u32 as i32))
            })?;
        let hr = attempt
            .join()
            .unwrap_or(windows_core::HRESULT(0x8000_FFFF_u32 as i32));

        if hr.is_ok() {
            crate::vlog!("InitializeXamlDiagnosticsEx ok after {attempts} attempt(s)");
            return Ok(());
        }
        if attempts >= 60 {
            crate::vlog!("InitializeXamlDiagnosticsEx giving up: {:#010x}", hr.0);
            return Err(windows_core::Error::from_hresult(hr));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
