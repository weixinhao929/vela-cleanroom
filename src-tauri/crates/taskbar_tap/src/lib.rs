//! velatap.dll —— 注入 explorer.exe 的 XAML TAP（TB-TAP 会话）。
//!
//! # 职责
//! 被加载进 explorer.exe 后：`InitializeXamlDiagnosticsEx` 挂上 XAML 可视树
//! 监视（TaskbarFrame 的 BackgroundFill/BackgroundStroke 矩形），按主进程经
//! 命名管道下发的 [`protocol::TapMessage`] 替换画刷 / 恢复默认。
//!
//! # 布局
//! - [`bootstrap`]：DllMain 分支、标记事件、XAML Diagnostics 初始化重试；
//! - [`site`]：DllGetClassObject / 类厂 / IObjectWithSite 站点；
//! - [`watcher`]：可视树回调（结构探测）；
//! - [`appearance`]：任务栏登记表 + 五种 accent 的画刷映射与恢复；
//! - [`blur_brush`] + [`effects`]：自定义模糊画刷（组合类聚合 + D2D1 interop）；
//! - [`pipe_client`]：管道客户端（NDJSON 握手 / 心跳 / 分派）；
//! - [`parent_watch`]：主进程死亡自恢复（F-9 线 2）。
//!
//! # 铁律
//! 任何 panic 都可能连累 explorer：每个 COM/FFI 入口包
//! [`util::guarded`]（catch_unwind 折错），extern "system" 非 unwind ABI
//! 兜底；失败 = 静默退出注入，绝不重试风暴。
//!
//! 协议定义与主进程共享同一份源码（见 protocol.rs 头部注释），本 crate 通过
//! `#[path]` 直接包含，**不许在本 crate 内改动该文件**。

#![cfg(windows)]
#![allow(clippy::upper_case_acronyms)] // COM 接口名保持 SDK 原样（IShape 等）
#![allow(non_snake_case)] // COM/WinRT 方法名保持 SDK 原样（put_Fill 等）
#![allow(unused_parens)] // let-else 携 unsafe 块时必须带括号，lint 有误报

#[path = "../../../src/taskbar/protocol.rs"]
pub mod protocol;

mod appearance;
mod blur_brush;
mod bootstrap;
mod diag;
mod effects;
mod parent_watch;
mod pipe_client;
mod site;
mod util;
mod watcher;
mod xaml;

// ---------------------------------------------------------------------------
// DLL 入口与导出
// ---------------------------------------------------------------------------

type HINSTANCE = windows::Win32::Foundation::HMODULE;
const DLL_PROCESS_ATTACH: u32 = 1;
const DLL_THREAD_ATTACH: u32 = 2;
const DLL_THREAD_DETACH: u32 = 3;
const DLL_PROCESS_DETACH: u32 = 0;

/// DllMain：只做标记事件探测 + 原生 CreateThread，立即返回（loader lock
/// 下不碰 LoadLibrary/COM/std 重型初始化）。
#[no_mangle]
pub extern "system" fn DllMain(
    instance: HINSTANCE,
    reason: u32,
    _reserved: *mut core::ffi::c_void,
) -> windows::core::BOOL {
    if reason == DLL_PROCESS_ATTACH {
        // 挂钩加载时 explorer 会带 THREAD_ATTACH；屏蔽线程通知减少噪音。
        let _ =
            unsafe { windows::Win32::System::LibraryLoader::DisableThreadLibraryCalls(instance) };
        if !bootstrap::process_attach() {
            return windows::core::BOOL::from(false);
        }
    }
    let _ = (DLL_THREAD_ATTACH, DLL_THREAD_DETACH, DLL_PROCESS_DETACH);
    windows::core::BOOL::from(true)
}

/// XAML Diagnostics 入口：类厂 → [`site::VelaTapSite`]。
#[no_mangle]
#[allow(clippy::not_unsafe_ptr_arg_deref)] // COM 入口约定：参数即裸指针
pub extern "system" fn DllGetClassObject(
    rclsid: *const windows_core::GUID,
    riid: *const windows_core::GUID,
    ppv: *mut *mut core::ffi::c_void,
) -> windows_core::HRESULT {
    if rclsid.is_null() || riid.is_null() || ppv.is_null() {
        return windows_core::HRESULT(0x8000_4003_u32 as i32); // E_POINTER
    }
    let r = crate::util::guarded("DllGetClassObject", || {
        // 指针已判空；unsafe 仅限解引用动作本身。
        Ok(site::get_class_object(
            unsafe { &*rclsid },
            unsafe { &*riid },
            ppv,
        ))
    });
    match r {
        Ok(hr) => hr,
        Err(_) => windows_core::HRESULT(0x8000_FFFF_u32 as i32),
    }
}

/// 我们被 XAML Diagnostics pin，永不真正卸载。
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> windows_core::HRESULT {
    windows_core::HRESULT(1) // S_FALSE
}

/// WH_CALLWNDPROC 占位钩子：SetWindowsHookEx 为把本 DLL 映进 explorer 而
/// 挂的载体，链式放行即可（对齐标杆 api.cpp:12-16）。
#[no_mangle]
pub extern "system" fn VelaTapHookProc(
    ncode: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe { windows::Win32::UI::WindowsAndMessaging::CallNextHookEx(None, ncode, wparam, lparam) }
}

/// 注入器契约：标记事件名（注入前创建，DllMain 靠它区分“被注入”与
/// “被手动加载”）。给 TB-INJECT / inject_demo 复用。
pub fn inject_marker_event_name(explorer_pid: u32) -> String {
    bootstrap::inject_marker_event_name(explorer_pid)
}
