//! TAP 站点与类厂。
//!
//! XAML Diagnostics 初始化时会 `LoadLibrary(本DLL)` + `DllGetClassObject`
//! 拿 [`CLSID_VELATAP_SITE`] 的类厂，`CreateInstance` 出站点对象并
//! `IObjectWithSite::SetSite(IXamlDiagnostics*)`。我们在 SetSite 里：
//!
//! 1. 装[`appearance`] 全局注册表（diag 接口来自 site）；
//! 2. 起 VisualTreeWatcher；
//! 3. 在**独立线程**上 `AdviseVisualTreeChange`（从独立线程调
//!    用可避免某些挂起）。

use std::sync::OnceLock;

use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::System::Ole::{IObjectWithSite, IObjectWithSite_Impl};
use windows_core::{implement, Interface, Result};

use crate::appearance;
use crate::diag::{
    IVisualTreeService, IVisualTreeServiceCallback2, IXamlDiagnostics, CLSID_VELATAP_SITE,
};
use crate::watcher::VisualTreeWatcher;

/// 唯一 watcher（weak_ref + 非法重入检查的简化版：
/// OnceLock 兜住二次 SetSite）。
/// COM 指针本身不跨线程使用（回调只在任务栏 UI 线程），仅静态存放。
struct WatcherCell(#[allow(dead_code)] windows_core::IUnknown);
unsafe impl Send for WatcherCell {}
unsafe impl Sync for WatcherCell {}

static WATCHER: OnceLock<WatcherCell> = OnceLock::new();

/// TAP 站点。
#[implement(IObjectWithSite)]
pub(crate) struct VelaTapSite {
    /// 站点（IXamlDiagnostics）；SetSite(null) 时清空。
    site: std::sync::Mutex<Option<windows_core::IUnknown>>,
}

impl VelaTapSite {
    pub(crate) fn new() -> Self {
        Self {
            site: std::sync::Mutex::new(None),
        }
    }
}

impl IObjectWithSite_Impl for VelaTapSite_Impl {
    fn SetSite(&self, punksite: windows_core::Ref<'_, windows_core::IUnknown>) -> Result<()> {
        crate::util::guarded("SetSite", move || {
            let new_site = punksite.cloned();
            let mut guard = self.site.lock().map_err(|_| {
                windows_core::Error::from_hresult(windows_core::HRESULT(0x8000_FFFF_u32 as i32))
            })?;
            *guard = new_site.clone();

            let Some(site) = guard.clone() else {
                return Ok(()); // 卸站点：注册表留置（explorer 退出场景无意义）
            };

            // 一次性：装注册表 + 起 watcher + 独立线程 Advise。
            if WATCHER.get().is_some() {
                crate::vlog!("SetSite: watcher already installed, tolerate");
                return Ok(()); // 已在监听（重复 SetSite 容忍）。
            }
            crate::vlog!("SetSite: installing registry + watcher");
            let diag: IXamlDiagnostics = site.cast()?;
            if !appearance::install_registry(diag) {
                // 注册表没装上（重复注入等）——保持 watcher 也不装。
                return Ok(());
            }

            let watcher: IVisualTreeServiceCallback2 = VisualTreeWatcher.into();
            // COM 指针仅移动进新线程使用（Advise 调用本身线程无关）。
            let advise_watcher = crate::util::SendCell(watcher.clone());
            let advise_site = crate::util::SendCell(site.clone());
            match std::thread::Builder::new()
                .stack_size(256 * 1024)
                .spawn(move || {
                    // Advise 线程静默死亡 = 可视树事件永远收不到。
                    crate::util::run_guarded("advise", move || {
                        advise_thread_main(advise_site, advise_watcher)
                    })
                }) {
                Ok(_joined) => {}
                Err(e) => {
                    crate::vlog!("failed to spawn advise thread: {e}");
                    return Err(windows_core::Error::from_hresult(windows_core::HRESULT(
                        0x8000_FFFF_u32 as i32,
                    )));
                }
            }

            let _ = WATCHER.set(WatcherCell(watcher.into()));
            crate::vlog!("visual tree watcher advised");
            Ok(())
        })
    }

    fn GetSite(
        &self,
        riid: *const windows_core::GUID,
        ppvsite: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        let guard = self.site.lock().map_err(|_| {
            windows_core::Error::from_hresult(windows_core::HRESULT(0x8000_FFFF_u32 as i32))
        })?;
        let Some(site) = guard.as_ref() else {
            return Err(windows_core::Error::from_hresult(
                windows_core::HRESULT(0x8000_4001_u32 as i32), // E_FAIL
            ));
        };
        unsafe { site.query(riid, ppvsite) }.ok()?;
        Ok(())
    }
}

/// Advise 线程入口（函数边界阻断闭包精确捕获）。
fn advise_thread_main(
    site: crate::util::SendCell<windows_core::IUnknown>,
    watcher: crate::util::SendCell<IVisualTreeServiceCallback2>,
) {
    let r = crate::util::guarded("AdviseVisualTreeChange", move || {
        let service: IVisualTreeService = site.0.cast()?;
        unsafe { service.AdviseVisualTreeChange(&watcher.0) }?;
        Ok(())
    });
    if let Err(e) = r {
        crate::vlog!("AdviseVisualTreeChange failed: {e}");
    }
}

/// 简单类厂（CreateInstance 恒新站点；聚合不支持）。
#[implement(IClassFactory)]
pub(crate) struct TapClassFactory;

impl IClassFactory_Impl for TapClassFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: windows_core::Ref<'_, windows_core::IUnknown>,
        riid: *const windows_core::GUID,
        ppvobject: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        if !punkouter.is_null() {
            return Err(windows_core::Error::from_hresult(
                windows_core::HRESULT(0x8004_0110_u32 as i32), // CLASS_E_NOAGGREGATION
            ));
        }
        if ppvobject.is_null() {
            return Err(windows_core::Error::from_hresult(windows_core::HRESULT(
                0x8000_4003_u32 as i32,
            )));
        }
        unsafe { *ppvobject = core::ptr::null_mut() };
        let site: IObjectWithSite = VelaTapSite::new().into();
        let unknown: windows_core::IUnknown = site.into();
        unsafe { unknown.query(riid, ppvobject) }.ok()?;
        Ok(())
    }

    fn LockServer(&self, _flock: windows_core::BOOL) -> Result<()> {
        Ok(())
    }
}

/// `DllGetClassObject`（lib.rs 的 #[no_mangle] 包装转发到这里）。
pub fn get_class_object(
    rclsid: &windows_core::GUID,
    riid: &windows_core::GUID,
    ppv: *mut *mut core::ffi::c_void,
) -> windows_core::HRESULT {
    if ppv.is_null() {
        return windows_core::HRESULT(0x8000_4003_u32 as i32);
    }
    unsafe { *ppv = core::ptr::null_mut() };
    if *rclsid != CLSID_VELATAP_SITE {
        return windows_core::HRESULT(0x8004_0111_u32 as i32); // CLASS_E_CLASSNOTAVAILABLE
    }
    let factory: IClassFactory = TapClassFactory.into();
    let unknown: windows_core::IUnknown = factory.into();
    match unsafe { unknown.query(riid, ppv) }.ok() {
        Ok(()) => windows_core::HRESULT(0),
        Err(e) => e.code(),
    }
}
