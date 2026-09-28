//! 搜索（含 FindInStart）与任务视图状态源（F-3；标杆 CreateSearchManager
//! :850-911 / CreateTaskViewManager :949-971）。
//!
//! Win11 通道：`RoGetActivationFactory("WindowsUdk.UI.Shell.
//! ShellViewCoordinator")` 拿 `IShellViewCoordinatorFactory`，`CreateInstance(
//! ShellView::Search=1 / FindInStart=25 / TaskView=3)` 拿协调器，订阅
//! `VisibilityChanged` 事件并查询 `Visibility()`。接口定义照标杆
//! WindowsUdk\ShellViewCoordinator.idl 手写 vtable（IShellViewCoordinator
//! 槽位：IUnknown 3 + IInspectable 3 + 方法 10，`add_VisibilityChanged`
//! = 槽 13，`Visibility` = 槽 15）。Win10 通道（Cortana 事件）不实现，
//! 由 detect 能力上报「不可用」（§5.5 降级）。
//!
//! **调用方契约（真机 26200 实证）**：本模块的全部调用必须发生在
//! **已 CoInitialize(STA) 且跑消息泵的线程**（本会话的 tb-shell-sources
//! 线程）。MTA 下 `add_VisibilityChanged` 在 windowsudk.shellcommon.dll
//! 内部访问冲突（传 NULL handler 同样崩，证明与 sink 实现无关）；STA
//! 下订阅返回 S_OK，事件经消息泵送达 sink。`Visibility()` 轮询在两种
//! apartment 下都可用（事件链失效时的诊断回退路径）。
//!
//! delegate QI 策略：`TypedEventHandler<…>` 实例化 IID 无公开元数据
//! （WindowsUdk 不随 SDK 发布）。实测订阅路径不会 QI sink 的 delegate
//! IID；QI 接受 IUnknown 与 IAgileObject（无方法槽的敏捷标记，安全），
//! 其余 E_NOINTERFACE 并 debug 记录被询问的 GUID，便于后续补白名单。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Sender;

use windows::core::{IInspectable_Vtbl, IUnknown, IUnknown_Vtbl, Interface, GUID, HRESULT};

/// ShellView 枚举值（IDL :35-84，Vela 用到的三个）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellViewKind {
    Search = 1,
    TaskView = 3,
    FindInStart = 25,
}

impl ShellViewKind {
    fn label(self) -> &'static str {
        match self {
            ShellViewKind::Search => "Search",
            ShellViewKind::TaskView => "TaskView",
            ShellViewKind::FindInStart => "FindInStart",
        }
    }
}

/// ViewVisibility（IDL :86-91）：Visible = 0。
const VIEW_VISIBILITY_VISIBLE: i32 = 0;

/// `Windows.Foundation.EventRegistrationToken`（i64）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct EventRegistrationToken(pub i64);

/* ---------------- IShellViewCoordinatorFactory（IDL :186-192） ---------------- */

/// {BB8446E1-05D0-5510-80DD-96E9EBD9E006}
const IID_SHELLVIEWCOORDINATOR_FACTORY: GUID =
    GUID::from_u128(0xbb8446e1_05d0_5510_80dd_96e9ebd9e006);

#[repr(C)]
struct CoordinatorFactoryVtbl {
    base: IInspectable_Vtbl,
    /// HRESULT CreateInstance(ShellView view, ShellViewCoordinator** value)
    create_instance: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        i32,
        *mut *mut core::ffi::c_void,
    ) -> HRESULT,
}

#[repr(transparent)]
#[derive(Clone)]
struct CoordinatorFactory(*mut core::ffi::c_void);

impl Drop for CoordinatorFactory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: repr(transparent) 包装的 COM 指针，vtable 前三槽必为
            // IUnknown。
            unsafe { raw_release(self.0) };
        }
    }
}

// COM 接口指针跨线程传给 agile 对象是安全约定（对象自身声明 agile）。
unsafe impl Send for CoordinatorFactory {}
unsafe impl Sync for CoordinatorFactory {}
unsafe impl Interface for CoordinatorFactory {
    type Vtable = CoordinatorFactoryVtbl;
    const IID: GUID = IID_SHELLVIEWCOORDINATOR_FACTORY;
}

/* ---------------- IShellViewCoordinator（IDL :144-159） ---------------- */

/// {BC6FD3A4-3561-5629-ABDD-170AB289EF2F}
const IID_SHELLVIEWCOORDINATOR: GUID = GUID::from_u128(0xbc6fd3a4_3561_5629_abdd_170ab289ef2f);

#[repr(C)]
struct CoordinatorVtbl {
    base: IInspectable_Vtbl,
    add_show_requested: usize,
    remove_show_requested: usize,
    add_dismiss_requested: usize,
    remove_dismiss_requested: usize,
    report_visibility: usize,
    try_show_async: usize,
    try_dismiss_async: usize,
    /// 槽 13：add_VisibilityChanged(handler, *token)。
    add_visibility_changed: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut EventRegistrationToken,
    ) -> HRESULT,
    /// 槽 14：remove_VisibilityChanged(token)。
    remove_visibility_changed:
        unsafe extern "system" fn(*mut core::ffi::c_void, EventRegistrationToken) -> HRESULT,
    /// 槽 15：get_Visibility(*ViewVisibility)。
    get_visibility: unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> HRESULT,
}

#[repr(transparent)]
#[derive(Clone)]
struct CoordinatorRaw(*mut core::ffi::c_void);

impl Drop for CoordinatorRaw {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: 同上。
            unsafe { raw_release(self.0) };
        }
    }
}

unsafe impl Send for CoordinatorRaw {}
unsafe impl Sync for CoordinatorRaw {}
unsafe impl Interface for CoordinatorRaw {
    type Vtable = CoordinatorVtbl;
    const IID: GUID = IID_SHELLVIEWCOORDINATOR;
}

/// IUnknown::Release 的裸调用（自实现 Drop 用）。
unsafe fn raw_release(ptr: *mut core::ffi::c_void) {
    // SAFETY: ptr 指向合法 COM 接口；调用方保证这是自己持有的引用。
    unsafe {
        let vtbl = &*(*(ptr as *mut *mut IUnknown_Vtbl));
        (vtbl.Release)(ptr);
    }
}

/// 读协调器可见性（None = 查询失败）。
unsafe fn read_visibility(coordinator: *mut core::ffi::c_void) -> Option<bool> {
    // SAFETY: coordinator 为合法 IShellViewCoordinator；槽位布局照 IDL。
    unsafe {
        let vtbl = &*(*(coordinator as *mut *mut CoordinatorVtbl));
        let mut value: i32 = -1;
        if (vtbl.get_visibility)(coordinator, &mut value).is_ok() {
            Some(value == VIEW_VISIBILITY_VISIBLE)
        } else {
            None
        }
    }
}

/* ---------------- TypedEventHandler delegate 手写 sink ---------------- */

#[repr(C)]
struct HandlerSinkVtbl {
    base: IUnknown_Vtbl,
    /// TypedEventHandler::Invoke(sender, args)。
    invoke: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> HRESULT,
}

#[repr(C)]
struct HandlerSink {
    vtbl: *const HandlerSinkVtbl,
    refs: AtomicU32,
    /// VisibilityChanged → 哪个引擎事件（Search/FindInStart/TaskView）。
    map: fn(bool) -> super::EngineMsg,
    tx: Sender<super::EngineMsg>,
}

static HANDLER_SINK_VTBL: HandlerSinkVtbl = HandlerSinkVtbl {
    base: IUnknown_Vtbl {
        QueryInterface: HandlerSink::query_interface,
        AddRef: HandlerSink::add_ref,
        Release: HandlerSink::release,
    },
    invoke: HandlerSink::invoke,
};

/// IAgileObject {94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}（无方法槽的敏捷
/// 标记接口，返回 self 安全）。
const IID_IAGILE_OBJECT: GUID = GUID::from_u128(0x94ea2b94_e9cc_49e0_c0ff_ee64ca8f5b90);

impl HandlerSink {
    fn new(map: fn(bool) -> super::EngineMsg, tx: Sender<super::EngineMsg>) -> Self {
        Self {
            vtbl: &HANDLER_SINK_VTBL,
            refs: AtomicU32::new(1),
            map,
            tx,
        }
    }

    unsafe extern "system" fn query_interface(
        this: *mut core::ffi::c_void,
        iid: *const GUID,
        out: *mut *mut core::ffi::c_void,
    ) -> HRESULT {
        // SAFETY: COM QI 约定；iid 只读，out 调用前无效。
        unsafe {
            if out.is_null() || iid.is_null() {
                return HRESULT(0x8000_0003u32 as i32); // E_POINTER
            }
            let iid = &*iid;
            if iid == &IUnknown::IID || iid == &IID_IAGILE_OBJECT {
                *out = this;
                HandlerSink::add_ref(this);
                HRESULT(0)
            } else {
                // 探测日志：若 shell 询问 delegate 实例化 IID，把该 GUID
                // 补进上面的分支（真机验证步骤见会话汇报）。
                log::debug!("taskbar shellview: sink QI refused {:x}", iid.to_u128());
                *out = core::ptr::null_mut();
                HRESULT(0x8000_4002u32 as i32) // E_NOINTERFACE
            }
        }
    }

    unsafe extern "system" fn add_ref(this: *mut core::ffi::c_void) -> u32 {
        // SAFETY: this 指向引用计数字段布局固定的对象。
        unsafe {
            let sink = &*(this as *mut HandlerSink);
            sink.refs.fetch_add(1, Ordering::Relaxed) + 1
        }
    }

    unsafe extern "system" fn release(this: *mut core::ffi::c_void) -> u32 {
        // SAFETY: 归零时 this 是 Box::into_raw 的原指针，还原为 Box 释放。
        unsafe {
            let sink = &*(this as *mut HandlerSink);
            let remaining = sink.refs.fetch_sub(1, Ordering::Release);
            if remaining == 1 {
                drop(Box::from_raw(this as *mut HandlerSink));
                return 0;
            }
            remaining - 1
        }
    }

    unsafe extern "system" fn invoke(
        this: *mut core::ffi::c_void,
        sender: *mut core::ffi::c_void,
        _args: *mut core::ffi::c_void,
    ) -> HRESULT {
        // SAFETY: this 为 add_VisibilityChanged 时传入的 sink；sender 为
        // 协调器默认接口的借用指针（不 AddRef，仅本次调用内使用）。
        unsafe {
            let sink = &*(this as *mut HandlerSink);
            let visible = if sender.is_null() {
                false
            } else {
                read_visibility(sender).unwrap_or(false)
            };
            let _ = sink.tx.send((sink.map)(visible));
        }
        HRESULT(0)
    }
}

/* ---------------- 订阅入口 ---------------- */

/// 订阅令牌：Drop 时 remove_VisibilityChanged 并释放 sink / 协调器。
pub struct ShellViewWatch {
    coordinator: CoordinatorRaw,
    token: EventRegistrationToken,
    /// sink 裸指针（出生引用在 Drop 时 Release 归零）。
    sink: *mut HandlerSink,
}

impl Drop for ShellViewWatch {
    fn drop(&mut self) {
        // SAFETY: token 来自成功的 add_VisibilityChanged；对象存活期内有效。
        unsafe {
            let vtbl = &*(*(self.coordinator.0 as *mut *mut CoordinatorVtbl));
            let _ = (vtbl.remove_visibility_changed)(self.coordinator.0, self.token);
            raw_release(self.sink as *mut core::ffi::c_void);
        }
    }
}

/// 订阅一个 ShellView 协调器的 VisibilityChanged。`map` 把可见性映射为
/// 引擎事件（Search / FindInStart / TaskView）。失败返回 Err 不 panic。
/// 成功后立即发送一次初始 `Visibility()` 读数。
pub fn watch_shell_view(
    kind: ShellViewKind,
    map: fn(bool) -> super::EngineMsg,
    tx: Sender<super::EngineMsg>,
) -> Result<ShellViewWatch, String> {
    use windows::Win32::System::WinRT::RoGetActivationFactory;
    // SAFETY: 状态机线程已 CoInitialize(MTA)；factory 为 agile 对象。
    let factory: CoordinatorFactory = unsafe {
        RoGetActivationFactory(&windows::core::HSTRING::from_wide(
            windows::core::w!("WindowsUdk.UI.Shell.ShellViewCoordinator").as_wide(),
        ))
        .map_err(|e| format!("RoGetActivationFactory(ShellViewCoordinator) 失败: {e}"))?
    };
    let mut coordinator_raw: *mut core::ffi::c_void = core::ptr::null_mut();
    // SAFETY: 工厂 vtable 槽位照 IDL；view 参数为枚举整型值。
    unsafe {
        let vtbl = &*(*(factory.as_raw() as *mut *mut CoordinatorFactoryVtbl));
        let hr = (vtbl.create_instance)(factory.as_raw(), kind as i32, &mut coordinator_raw);
        if hr.is_err() || coordinator_raw.is_null() {
            return Err(format!(
                "ShellViewCoordinator::CreateInstance({}) 失败: {hr:?}",
                kind.label()
            ));
        }
    }
    let coordinator = CoordinatorRaw(coordinator_raw);
    let sink = Box::into_raw(Box::new(HandlerSink::new(map, tx.clone())));
    let mut token = EventRegistrationToken(0);
    // SAFETY: sink 为合法 delegate 布局；token 出参。
    unsafe {
        let vtbl = &*(*(coordinator.0 as *mut *mut CoordinatorVtbl));
        let hr = (vtbl.add_visibility_changed)(
            coordinator.0,
            sink as *mut core::ffi::c_void,
            &mut token,
        );
        if hr.is_err() {
            // 事件订阅失败：释放 sink 出生引用，仍保留协调器供初始轮询？——
            // 无事件源即不可用，整体报错。
            raw_release(sink as *mut core::ffi::c_void);
            return Err(format!(
                "add_VisibilityChanged({}) 失败: {hr:?}",
                kind.label()
            ));
        }
    }
    // 初始读数（失败按关闭；引擎据此起步）。
    // SAFETY: 协调器存活。
    let initial = unsafe { read_visibility(coordinator.0) }.unwrap_or(false);
    let _ = tx.send(map(initial));
    log::info!(
        "taskbar shellview source: {} subscribed (initial visible={initial})",
        kind.label()
    );
    Ok(ShellViewWatch {
        coordinator,
        token,
        sink,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_view_enum_values_match_idl() {
        assert_eq!(ShellViewKind::Search as i32, 1);
        assert_eq!(ShellViewKind::TaskView as i32, 3);
        assert_eq!(ShellViewKind::FindInStart as i32, 25);
    }

    #[test]
    fn interface_iids_match_idl() {
        assert_eq!(
            IID_SHELLVIEWCOORDINATOR_FACTORY,
            GUID::from_u128(0xbb8446e1_05d0_5510_80dd_96e9ebd9e006)
        );
        assert_eq!(
            IID_SHELLVIEWCOORDINATOR,
            GUID::from_u128(0xbc6fd3a4_3561_5629_abdd_170ab289ef2f)
        );
    }

    /// sink 生命周期与 QI 策略（IUnknown/IAgileObject 收，未知拒）。
    #[test]
    fn handler_sink_qi_and_lifecycle() {
        fn map_search(_b: bool) -> super::super::EngineMsg {
            super::super::EngineMsg::Search(false)
        }
        let (tx, _rx) = std::sync::mpsc::channel();
        let raw = Box::into_raw(Box::new(HandlerSink::new(map_search, tx)));
        let this = raw as *mut core::ffi::c_void;
        // SAFETY: 测试对象即 COM 布局。
        unsafe {
            let mut out = core::ptr::null_mut();
            assert!(HandlerSink::query_interface(this, &IUnknown::IID, &mut out).is_ok());
            assert_eq!(out, this);
            out = core::ptr::null_mut();
            assert!(
                HandlerSink::query_interface(this, &IID_IAGILE_OBJECT, &mut out).is_ok(),
                "IAgileObject 标记接口应接受"
            );
            let random = GUID::from_u128(0xdead_beef_cafe_babe_0000_1234_5678_9abc);
            assert!(HandlerSink::query_interface(this, &random, &mut out).is_err());
            assert!(out.is_null());
            HandlerSink::release(this); // QI×2
            HandlerSink::release(this);
            HandlerSink::release(this); // 出生引用 → 释放
        }
    }
}
