//! 小工具：ODS 日志、panic 围栏、WinRT 激活助手。

use windows_core::Interface;

/// 激活工厂薄封装（0.61 的泛型 RoGetActivationFactory 直供）。
pub fn activation_factory<I: Interface>(class_name: &str) -> windows_core::Result<I> {
    let name = windows::core::HSTRING::from(class_name);
    unsafe { windows::Win32::System::WinRT::RoGetActivationFactory(&name) }
}

/// 前缀化 OutputDebugStringA 日志（DebugView 可见；explorer 内无控制台）。
/// 同时追加到 `%TEMP%\vela\velatap.log`（诊断期临时通道；每行即写即刷，
/// 供崩溃后定位最后一步—— explorer 内 panic/崩溃不会有任何输出留存）。
pub fn log(args: std::fmt::Arguments<'_>) {
    use std::fmt::Write as _;
    let mut buf = String::with_capacity(192);
    let _ = write!(buf, "[velatap] {args}\0");
    // 含非 ASCII 时降级为逐字节写（ODS 接受任意 C 串；丢精度不丢信息）。
    unsafe {
        windows::Win32::System::Diagnostics::Debug::OutputDebugStringA(
            windows::core::PCSTR::from_raw(buf.as_ptr().cast()),
        );
    }
    let mut line = String::with_capacity(160);
    let _ = writeln!(
        line,
        "{}.{:03} {:?} {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() / 1000)
            .unwrap_or(0),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() % 1000)
            .unwrap_or(0),
        std::thread::current().id(),
        args
    );
    let path = std::env::temp_dir().join("vela").join("velatap.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write as _;
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

#[macro_export]
macro_rules! vlog {
    ($($arg:tt)*) => { $crate::util::log(format_args!($($arg)*)) };
}

/// 在 FFI 边界内执行 `f`，任何 panic 都被吞掉并折成 `Err`。
/// 铁律（需求 R1）：panic 绝不穿过 COM 边界进入 explorer。
pub fn guarded<T, F: FnOnce() -> windows_core::Result<T> + std::panic::UnwindSafe>(
    what: &str,
    f: F,
) -> windows_core::Result<T> {
    match std::panic::catch_unwind(f) {
        Ok(r) => r,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic>".into());
            vlog!("panic in {what}: {msg}");
            Err(windows_core::Error::from_hresult(windows_core::HRESULT(
                0x8000_FFFF_u32 as i32, // E_UNEXPECTED
            )))
        }
    }
}

/// 本 DLL 模块句柄（自卸载用；UNCHANGED_REFCOUNT 不偷引用计数）。
pub fn self_module() -> Option<windows::Win32::Foundation::HMODULE> {
    let mut module = windows::Win32::Foundation::HMODULE::default();
    let flags = windows::Win32::System::LibraryLoader::GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
        | windows::Win32::System::LibraryLoader::GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
    let ok = unsafe {
        windows::Win32::System::LibraryLoader::GetModuleHandleExW(
            flags,
            windows::core::PCWSTR(log as *const () as *const u16),
            &mut module,
        )
    };
    ok.ok().map(|()| module)
}

/// 为 init 线程持有本模块的一个**真实引用**（FROM_ADDRESS 且不带
/// UNCHANGED_REFCOUNT：引用计数 +1，等同 LoadLibrary 自身）。init 线程在
/// IXDE 重试窗口（最长 30s）内，DLL 在 explorer 里的唯一引用是宿主的
/// WH_CALLWNDPROC 钩子；宿主停用 / 退出 / 被强杀一摘钩子，loader 立即卸载
/// 本模块，而 init 线程与 attempt 线程还活着——这就是卸载竞态（explorer
/// 崩溃强嫌疑）。持引用后模块在重试窗口内不可被卸载；成功路径保持「永不
/// 卸载」语义，失败路径由 trampoline `FreeLibraryAndExitThread` 释放。
pub fn acquire_self_reference() -> Option<windows::Win32::Foundation::HMODULE> {
    let mut module = windows::Win32::Foundation::HMODULE::default();
    let flags = windows::Win32::System::LibraryLoader::GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS;
    let ok = unsafe {
        windows::Win32::System::LibraryLoader::GetModuleHandleExW(
            flags,
            windows::core::PCWSTR(log as *const () as *const u16),
            &mut module,
        )
    };
    ok.ok().map(|()| module)
}

/// 跨线程移动 COM/内核句柄的载体（调用仍限目标线程；仅转移所有权）。
pub struct SendCell<T>(pub T);
unsafe impl<T> Send for SendCell<T> {}
