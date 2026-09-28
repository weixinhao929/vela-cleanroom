//! 开始菜单状态源（F-3；标杆 CreateAppVisibility :830-848 /
//! IsStartMenuOpened :1034-1051）。
//!
//! `CoCreateInstance(CLSID_AppVisibility)` + `Advise(IAppVisibilityEvents)`
//! 订阅 Launcher 可见性；初始值 `IsLauncherVisible()`。回调（COM 会在任意
//! RPC 线程上调）只往无界 channel 发 `EngineMsg::Start(bool)`——显示器
//! 归属在状态机线程处理（标杆口径：事件后 Sleep(5) + 前台窗口所在显示
//! 器，GetStartMenuMonitor hpp:236-247，已知不精确的启发式）。
//!
//! 引用计数协议：sink 以引用数 1 出生，该引用的所有权交给
//! `IAppVisibilityEvents::from_raw` 的类型化包装器；[`StartWatch`] 同时
//! 持有包装器与 Unadvise cookie，Drop 时先 Unadvise（COM 侧放手）再让
//! 包装器 Release 归零释放。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Sender;

use windows::core::{IUnknown, IUnknown_Vtbl, Interface, GUID, HRESULT};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::UI::Shell::{IAppVisibility, IAppVisibilityEvents};

use super::EngineMsg;

/// 订阅令牌：Drop 时 Unadvise 并释放 sink。
pub struct StartWatch {
    app_visibility: IAppVisibility,
    cookie: u32,
    /// 持有 sink 的唯一自引用（Drop 即最后一次 Release）。
    _sink: IAppVisibilityEvents,
}

impl Drop for StartWatch {
    fn drop(&mut self) {
        // SAFETY: cookie 来自成功的 Advise。
        unsafe {
            let _ = self.app_visibility.Unadvise(self.cookie);
        }
    }
}

/// 创建订阅。失败返回 Err（一句话原因，不 panic）；成功后立即发送一次
/// 初始 `IsLauncherVisible` 读数。
pub fn watch_start(tx: Sender<EngineMsg>) -> Result<StartWatch, String> {
    // SAFETY: AppVisibility 为文档化 COM 类；调用发生在已 CoInitialize 的
    // 状态机线程（MTA）。
    let app_visibility: IAppVisibility = unsafe {
        CoCreateInstance(&windows::Win32::UI::Shell::AppVisibility, None, CLSCTX_ALL)
            .map_err(|e| format!("CoCreateInstance(AppVisibility) 失败: {e}"))?
    };
    // SAFETY: Box 布局即 COM 对象布局（静态 vtable 指针在前）。
    let sink = unsafe {
        IAppVisibilityEvents::from_raw(Box::into_raw(Box::new(LauncherVisibilitySink::new(
            tx.clone(),
        ))) as *mut core::ffi::c_void)
    };
    // SAFETY: sink 为合法 COM 布局（静态 vtable + 引用计数）。
    let cookie = unsafe {
        app_visibility
            .Advise(&sink)
            .map_err(|e| format!("AppVisibility::Advise 失败: {e}"))?
    };
    // 初始读数（失败按关闭，与标杆 IsStartMenuOpened 失败回 false 一致）。
    let initial = unsafe {
        app_visibility
            .IsLauncherVisible()
            .is_ok_and(|b| b.as_bool())
    };
    let _ = tx.send(EngineMsg::Start(initial));
    log::info!("taskbar start source: advised (initial visible={initial})");
    Ok(StartWatch {
        app_visibility,
        cookie,
        _sink: sink,
    })
}

/* ---------------- IAppVisibilityEvents 手写实现 ---------------- */

/// vtable 布局（windows crate IAppVisibilityEvents_Vtbl：IUnknown 3 槽 +
/// AppVisibilityOnMonitorChanged + LauncherVisibilityChange）。
#[repr(C)]
pub struct LauncherVisibilitySinkVtbl {
    pub base: IUnknown_Vtbl,
    pub app_visibility_on_monitor_changed:
        unsafe extern "system" fn(*mut core::ffi::c_void, isize, i32, i32) -> HRESULT,
    pub launcher_visibility_change:
        unsafe extern "system" fn(*mut core::ffi::c_void, windows::core::BOOL) -> HRESULT,
}

#[repr(C)]
pub struct LauncherVisibilitySink {
    vtbl: *const LauncherVisibilitySinkVtbl,
    refs: AtomicU32,
    tx: Sender<EngineMsg>,
}

static LAUNCHER_SINK_VTBL: LauncherVisibilitySinkVtbl = LauncherVisibilitySinkVtbl {
    base: IUnknown_Vtbl {
        QueryInterface: LauncherVisibilitySink::query_interface,
        AddRef: LauncherVisibilitySink::add_ref,
        Release: LauncherVisibilitySink::release,
    },
    app_visibility_on_monitor_changed: LauncherVisibilitySink::on_monitor_changed,
    launcher_visibility_change: LauncherVisibilitySink::on_visibility_change,
};

impl LauncherVisibilitySink {
    fn new(tx: Sender<EngineMsg>) -> Self {
        Self {
            vtbl: &LAUNCHER_SINK_VTBL,
            refs: AtomicU32::new(1),
            tx,
        }
    }

    /// QI：IUnknown / IAppVisibilityEvents 精确命中；其余 E_NOINTERFACE。
    unsafe extern "system" fn query_interface(
        this: *mut core::ffi::c_void,
        iid: *const GUID,
        out: *mut *mut core::ffi::c_void,
    ) -> HRESULT {
        // SAFETY: COM 约定 out 调用前无效；iid 指向只读 GUID。
        unsafe {
            if out.is_null() || iid.is_null() {
                return HRESULT(0x8000_0003u32 as i32); // E_POINTER
            }
            let iid = &*iid;
            if iid == &IUnknown::IID || iid == &IAppVisibilityEvents::IID {
                *out = this;
                LauncherVisibilitySink::add_ref(this);
                HRESULT(0)
            } else {
                *out = core::ptr::null_mut();
                HRESULT(0x8000_4002u32 as i32) // E_NOINTERFACE
            }
        }
    }

    unsafe extern "system" fn add_ref(this: *mut core::ffi::c_void) -> u32 {
        // SAFETY: this 指向引用计数字段布局固定的对象。
        unsafe {
            let sink = &*(this as *mut LauncherVisibilitySink);
            sink.refs.fetch_add(1, Ordering::Relaxed) + 1
        }
    }

    unsafe extern "system" fn release(this: *mut core::ffi::c_void) -> u32 {
        // SAFETY: 归零时 this 是 Box::into_raw 的原指针，还原为 Box 释放。
        unsafe {
            let sink = &*(this as *mut LauncherVisibilitySink);
            let remaining = sink.refs.fetch_sub(1, Ordering::Release);
            if remaining == 1 {
                drop(Box::from_raw(this as *mut LauncherVisibilitySink));
                return 0;
            }
            remaining - 1
        }
    }

    unsafe extern "system" fn on_monitor_changed(
        _this: *mut core::ffi::c_void,
        _hmonitor: isize,
        _old: i32,
        _new: i32,
    ) -> HRESULT {
        HRESULT(0) // 全屏应用可见性变化，与开始菜单状态无关。
    }

    unsafe extern "system" fn on_visibility_change(
        this: *mut core::ffi::c_void,
        visible: windows::core::BOOL,
    ) -> HRESULT {
        // SAFETY: this 为 Advise 时传入的 sink。
        unsafe {
            let sink = &*(this as *mut LauncherVisibilitySink);
            let _ = sink.tx.send(EngineMsg::Start(visible.as_bool()));
        }
        HRESULT(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn sink_com_lifecycle_qi_addref_release() {
        let (tx, _rx) = mpsc::channel();
        let raw = Box::into_raw(Box::new(LauncherVisibilitySink::new(tx)));
        let this = raw as *mut core::ffi::c_void;
        // SAFETY: 测试对象布局即 COM 布局。
        unsafe {
            let mut out = core::ptr::null_mut();
            let hr =
                LauncherVisibilitySink::query_interface(this, &IAppVisibilityEvents::IID, &mut out);
            assert!(hr.is_ok());
            assert_eq!(out, this, "QI 同接口必须返回同指针（COM 身份规则）");
            let random = GUID::from_u128(0x11223344_5566_7788_99aa_bbccddeeff00);
            let hr2 = LauncherVisibilitySink::query_interface(this, &random, &mut out);
            assert!(hr2.is_err(), "未知 IID 拒绝");
            assert!(out.is_null());
            LauncherVisibilitySink::release(this); // QI 借的引用
            LauncherVisibilitySink::release(this); // 出生引用 → 释放
        }
    }

    #[test]
    fn visibility_event_roundtrip() {
        let (tx, rx) = mpsc::channel();
        let raw = Box::into_raw(Box::new(LauncherVisibilitySink::new(tx)));
        // SAFETY: 同上。
        unsafe {
            let _ =
                LauncherVisibilitySink::on_visibility_change(raw as *mut _, windows::core::BOOL(1));
            let _ =
                LauncherVisibilitySink::on_visibility_change(raw as *mut _, windows::core::BOOL(0));
        }
        assert_eq!(rx.recv(), Ok(EngineMsg::Start(true)));
        assert_eq!(rx.recv(), Ok(EngineMsg::Start(false)));
        // SAFETY: 出生引用归零释放。
        unsafe { LauncherVisibilitySink::release(raw as *mut _) };
    }
}
