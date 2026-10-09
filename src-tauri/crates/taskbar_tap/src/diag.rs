//! XAML Diagnostics 接口层 —— 逐条转写自本机 Windows SDK 的 `um\xamlOM.h`
//! （10.0.26100.0），IID 与 vtable 方法序是该头的权威内容，不可改动。
//!
//! windows-interface 0.59 的 `#[interface]` 宏只支持 `Result<()>` 返回，
//! 因此带出参的方法一律声明为**原始签名**（`*mut` 出参 + `HRESULT` 返回），
//! 再用独立 `impl` 块提供蛇形命名的人体工学包装（`inspectable_from_handle`
//! 等）。包装负责 null 检查与所有权接收。
//!
//! 角色分工：[`IVisualTreeServiceCallback2`] 由本 DLL 实现（watcher.rs）；
//! [`IXamlDiagnostics`] / [`IVisualTreeService`] 由 XAML 引擎实现、我们调用。

use windows::core::PCWSTR;
use windows_core::{interface, GUID};

/// `MIDL_uhyper InstanceHandle`：XAML Diagnostics 侧的元素句柄（仅键值）。
pub type InstanceHandle = u64;

/// enum VisualMutationType。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum VisualMutationType {
    Add = 0,
    Remove = 1,
}

/// struct SourceInfo（BSTR 归回调接收方所有）。
#[repr(C)]
pub struct SourceInfo {
    pub file_name: PCWSTR,
    pub line_number: u32,
    pub column_number: u32,
    pub char_position: u32,
    pub hash: PCWSTR,
}

/// struct ParentChildRelation。
#[repr(C)]
pub struct ParentChildRelation {
    pub parent: InstanceHandle,
    pub child: InstanceHandle,
    pub child_index: u32,
}

/// struct VisualElement（字段序照抄头文件：Handle 在最前）。
///
/// 四个 BSTR 的所有权移交回调接收方（wil::unique_bstr 语义），
/// 返回前必须经
/// [`free_visual_element_strings`] 释放。
#[repr(C)]
pub struct VisualElement {
    pub handle: InstanceHandle,
    pub src_info: SourceInfo,
    /// 元素运行时类名（如 `Taskbar.TaskbarFrame`）。可能为 null。
    pub type_name: PCWSTR,
    /// 元素 x:Name（如 `BackgroundFill`）。可能为 null。
    pub name: PCWSTR,
    pub num_children: u32,
}

/// 释放 [`VisualElement`] 内部四个 BSTR（null 安全）。
pub unsafe fn free_visual_element_strings(element: &VisualElement) {
    unsafe {
        free_bstr(element.type_name);
        free_bstr(element.name);
        free_bstr(element.src_info.file_name);
        free_bstr(element.src_info.hash);
    }
}

/// BSTR = 长度前缀 + null 结尾 UTF-16；null 指针按空串处理。
pub unsafe fn bstr_to_string_lossy(ptr: PCWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { ptr.to_string().unwrap_or_default() }
}

/// 释放回调移交的 BSTR。
///
/// `BSTR::from_raw` **接管所有权**，Drop 恰好 `SysFreeString` 一次——只需
/// drop 它，绝不能再显式 SysFreeString。此前这里两者都做了：每个可视树
/// 回调对 type_name / name / src_info 双重释放，把 explorer 的堆写坏
/// （ntdll c0000374，损坏异步暴露，表现为注入后数秒到数分钟的随机崩溃
/// ——与此前排查记录的崩溃同源）。
unsafe fn free_bstr(ptr: PCWSTR) {
    if !ptr.is_null() {
        drop(unsafe { windows::core::BSTR::from_raw(ptr.as_ptr()) });
    }
}

/// IID `{AA7A8931-80E4-4FEC-8F3B-553F87B4966E}`。
#[interface("AA7A8931-80E4-4FEC-8F3B-553F87B4966E")]
pub unsafe trait IVisualTreeServiceCallback: windows_core::IUnknown {
    pub unsafe fn OnVisualTreeChange(
        &self,
        relation: ParentChildRelation,
        element: VisualElement,
        mutationtype: VisualMutationType,
    ) -> windows_core::Result<()>;
}

/// IID `{BAD9EB88--4397--5FA2DB0A19EA}`；Callback 之上追加
/// OnElementStateChanged（本实现用不到，直通 S_OK）。
#[interface("BAD9EB88-AE77-4397-B948-5FA2DB0A19EA")]
pub unsafe trait IVisualTreeServiceCallback2: IVisualTreeServiceCallback {
    pub unsafe fn OnElementStateChanged(
        &self,
        element: InstanceHandle,
        elementstate: i32,
        context: PCWSTR,
    ) -> windows_core::Result<()>;
}

/// IID `{A593B11A-D17F-48BB-8F66-83910731C8A5}`。
///
/// 真实 vtable 共 14 个方法；这里只声明前缀（Advise / Unadvise），
/// 调用更靠前的槽位在 ABI 上合法。AdviseVisualTreeChange 由独立线程调用
/// （避免 UI 线程挂起）。
#[interface("A593B11A-D17F-48BB-8F66-83910731C8A5")]
pub unsafe trait IVisualTreeService: windows_core::IUnknown {
    pub unsafe fn AdviseVisualTreeChange(
        &self,
        pcallback: windows_core::Ref<IVisualTreeServiceCallback>,
    ) -> windows_core::Result<()>;
    pub unsafe fn UnadviseVisualTreeChange(
        &self,
        pcallback: windows_core::Ref<IVisualTreeServiceCallback>,
    ) -> windows_core::Result<()>;
}

/// IID `{18C9E2B6-3F43-4116-9F2B-FF935D7770D2}`——方法序照抄头文件：
/// GetDispatcher / GetUiLayer / GetApplication / GetIInspectableFromHandle /
/// GetHandleFromIInspectable / HitTest / RegisterInstance /
/// GetInitializationData。只用中间两个转换方法。
#[interface("18C9E2B6-3F43-4116-9F2B-FF935D7770D2")]
pub unsafe trait IXamlDiagnostics: windows_core::IUnknown {
    pub unsafe fn GetDispatcher(
        &self,
        ppdispatcher: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
    pub unsafe fn GetUiLayer(&self, pplayer: *mut *mut core::ffi::c_void) -> windows_core::HRESULT;
    pub unsafe fn GetApplication(
        &self,
        ppapplication: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
    pub unsafe fn GetIInspectableFromHandle(
        &self,
        instancehandle: InstanceHandle,
        ppinstance: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
    pub unsafe fn GetHandleFromIInspectable(
        &self,
        pinstance: *mut core::ffi::c_void,
        phandle: *mut InstanceHandle,
    ) -> windows_core::HRESULT;
    pub unsafe fn HitTest(
        &self,
        rect: windows::Win32::Foundation::RECT,
        pcount: *mut u32,
        ppinstancehandles: *mut *mut InstanceHandle,
    ) -> windows_core::HRESULT;
    pub unsafe fn RegisterInstance(
        &self,
        pinstance: *mut core::ffi::c_void,
        pinstancehandle: *mut InstanceHandle,
    ) -> windows_core::HRESULT;
    pub unsafe fn GetInitializationData(
        &self,
        pinitializationdata: *mut windows::core::BSTR,
    ) -> windows_core::HRESULT;
}

/// Callback2 → Callback 的接口层级换参（Param 借用需要，windows-rs 生成物
/// 的等价 CanInto）。
impl windows_core::imp::CanInto<IVisualTreeServiceCallback> for IVisualTreeServiceCallback2 {}

impl IXamlDiagnostics {
    /// 句柄 → IInspectable（所有权归调用方）。
    pub unsafe fn inspectable_from_handle(
        &self,
        handle: InstanceHandle,
    ) -> windows_core::Result<windows_core::IInspectable> {
        let mut out: *mut core::ffi::c_void = core::ptr::null_mut();
        unsafe { self.GetIInspectableFromHandle(handle, &mut out) }.ok()?;
        if out.is_null() {
            return Err(windows_core::Error::from_hresult(windows_core::HRESULT(
                0x8000_4003_u32 as i32,
            )));
        }
        Ok(unsafe { <windows_core::IInspectable as windows_core::Interface>::from_raw(out) })
    }

    /// IInspectable → 句柄（诊断树内的稳定键；不在树里则 Err）。
    pub unsafe fn handle_from_inspectable(
        &self,
        instance: &windows_core::IInspectable,
    ) -> windows_core::Result<InstanceHandle> {
        let mut handle = InstanceHandle::default();
        unsafe {
            self.GetHandleFromIInspectable(
                <windows_core::IInspectable as windows_core::Interface>::as_raw(instance),
                &mut handle,
            )
        }
        .ok()?;
        Ok(handle)
    }
}

/// 本 DLL 在 XAML Diagnostics 里的站点 CLSID。任意但必须稳定
/// （注入器 / InitializeXamlDiagnosticsEx / DllGetClassObject 三方共用）。
pub const CLSID_VELATAP_SITE: GUID = GUID::from_u128(0x5af1a90e_8f24_4c6d_9b7e_2a3d80c4f5b1);
