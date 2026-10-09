//! 任务栏模块系统消息窗线程骨架（完整沿用 wallpaper.rs:206-376 win_watcher
//! 的写法：真实顶层窗口 + RegisterClassW + GetMessageW 循环）。
//!
//! 监听并分发三类系统事件到 [`SystemEventCallback`]（注入与状态检测两侧
//! 各自 `register_callback` 挂载，互不感知）：
//! - `TaskbarCreated`（`RegisterWindowMessageW` 注册消息）：explorer 重启 →
//! 全量重建（重找任务栏 → 重注入 → 重求值，恢复线 3）；
//! - `WM_DISPLAYCHANGE`：显示器拓扑 / 分辨率变化 → 每屏任务栏重建；
//! - `WM_POWERBROADCAST`：本窗口已 `RegisterPowerSettingNotification(
//!   GUID_POWER_SAVING_STATUS)`，省电模式切换以 `PBT_POWERSETTINGCHANGE`
//!   到达，原始 wParam/lParam 透传给回调（状态层自解 POWERBROADCAST_SETTING）。
//!
//! **本模块不自行启动该线程**（`start()` 由注入引擎在用户开启模块时调用）；
//! 只保证骨架可编译、回调注册可用、panic 隔离。非 Windows 平台全部 no-op。

use std::sync::Arc;

/// 系统事件回调。默认实现全部空，实现方只覆盖关心的事件。回调在消息窗
/// 线程执行且被 `catch_unwind` 隔离：**不得阻塞**（重活丢给自己的线程 /
/// channel），panic 只记日志不拖垮消息循环。
pub trait SystemEventCallback: Send + Sync + 'static {
    /// explorer（重）启动完成，任务栏窗口已重建。
    fn on_taskbar_created(&self) {}
    /// 显示器数量 / 分辩率 / 排布变化。
    fn on_display_change(&self) {}
    /// `WM_POWERBROADCAST`：`event` = wParam（PBT_*），`data` = lParam 原值
    /// （PBT_POWERSETTINGCHANGE 时指向 POWERBROADCAST_SETTING）。
    fn on_power_broadcast(&self, event: u32, data: isize) {
        let _ = (event, data);
    }
}

/// 注册回调（任意时刻、任意线程；`start()` 之前注册也生效）。
pub fn register_callback(cb: Arc<dyn SystemEventCallback>) {
    imp::register_callback(cb);
}

/// 启动消息窗线程；已启动则返回 false。非 Windows 恒 false。
pub fn start() -> bool {
    imp::start()
}

/// 请求消息窗线程退出（best-effort：向窗口投递 WM_CLOSE）。
pub fn stop() {
    imp::stop();
}

/// 消息窗 HWND 值（0 = 未启动）。状态层可据此挂更多窗口级通知。
pub fn watcher_hwnd() -> isize {
    imp::watcher_hwnd()
}

#[cfg(windows)]
mod imp {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    use windows::core::{w, GUID};
    use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::RegisterPowerSettingNotification;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
        PostQuitMessage, RegisterClassW, RegisterWindowMessageW, TranslateMessage,
        DEVICE_NOTIFY_WINDOW_HANDLE, MSG, WINDOW_EX_STYLE, WM_CLOSE, WM_DESTROY, WM_DISPLAYCHANGE,
        WM_POWERBROADCAST, WNDCLASSW, WS_OVERLAPPED,
    };

    use super::SystemEventCallback;

    /// GUID_POWER_SAVING_STATUS {E00958C0--4ACE--FECCED2EEEA5}
    /// （windows crate 放在 Win32_System_SystemServices feature 下，此处
    /// 手写常量免拉整组 feature；值与 winnt.h 一致）。
    const GUID_POWER_SAVING_STATUS: GUID = GUID::from_u128(0xe00958c0_c213_4ace_ac77_fecced2eeea5);

    static CALLBACKS: Mutex<Vec<Arc<dyn SystemEventCallback>>> = Mutex::new(Vec::new());
    static STARTED: AtomicBool = AtomicBool::new(false);
    static WATCHER_HWND: AtomicIsize = AtomicIsize::new(0);
    /// RegisterWindowMessageW("TaskbarCreated") 的消息 id（0 = 未注册）。
    static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);

    pub fn register_callback(cb: Arc<dyn SystemEventCallback>) {
        CALLBACKS.lock().unwrap_or_else(|p| p.into_inner()).push(cb);
    }

    pub fn watcher_hwnd() -> isize {
        WATCHER_HWND.load(Ordering::SeqCst)
    }

    fn snapshot_callbacks() -> Vec<Arc<dyn SystemEventCallback>> {
        CALLBACKS.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// 逐个回调派发；单个回调 panic 只记日志，不影响其余回调与消息循环。
    fn dispatch(name: &str, f: impl Fn(&dyn SystemEventCallback)) {
        for cb in snapshot_callbacks() {
            if catch_unwind(AssertUnwindSafe(|| f(cb.as_ref()))).is_err() {
                log::error!("taskbar watcher: callback panicked in {name}");
            }
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let taskbar_created = TASKBAR_CREATED_MSG.load(Ordering::SeqCst);
        if taskbar_created != 0 && msg == taskbar_created {
            log::info!("taskbar watcher: TaskbarCreated received (explorer restarted)");
            dispatch("on_taskbar_created", |cb| cb.on_taskbar_created());
            return LRESULT(0);
        }
        match msg {
            WM_DISPLAYCHANGE => {
                dispatch("on_display_change", |cb| cb.on_display_change());
                LRESULT(0)
            }
            WM_POWERBROADCAST => {
                let event = wparam.0 as u32;
                let data = lparam.0;
                dispatch("on_power_broadcast", |cb| {
                    cb.on_power_broadcast(event, data)
                });
                // 电源广播约定返回 TRUE。
                LRESULT(1)
            }
            WM_DESTROY => {
                WATCHER_HWND.store(0, Ordering::SeqCst);
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn start() -> bool {
        if STARTED.swap(true, Ordering::SeqCst) {
            return false;
        }
        std::thread::spawn(|| {
            unsafe {
                let hinstance: HINSTANCE = match GetModuleHandleW(None) {
                    Ok(h) => HINSTANCE(h.0),
                    Err(e) => {
                        log::warn!("taskbar watcher: GetModuleHandleW failed: {e}");
                        STARTED.store(false, Ordering::SeqCst);
                        return;
                    }
                };
                // 注册消息 id 跨进程一致；先于建窗，保证首条 TaskbarCreated 不漏。
                let created = RegisterWindowMessageW(w!("TaskbarCreated"));
                if created == 0 {
                    log::warn!("taskbar watcher: RegisterWindowMessageW(TaskbarCreated) failed");
                }
                TASKBAR_CREATED_MSG.store(created, Ordering::SeqCst);

                let class_name = w!("VelaTaskbarListener");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: hinstance,
                    lpszClassName: class_name,
                    ..Default::default()
                };
                if RegisterClassW(&wc) == 0 {
                    // 泵线程退出后 STARTED 复位，下次 enable 重进本函数——
                    // 类是进程级注册且从无 UnregisterClassW，二次注册必得
                    // ERROR_CLASS_ALREADY_EXISTS。该错误继续建窗（否则重启路径
                    // 永远失败，TaskbarCreated/WM_DISPLAYCHANGE/省电广播永久失明）；
                    // 其余错误才按原逻辑放弃。
                    let err = windows::Win32::Foundation::GetLastError();
                    if err != windows::Win32::Foundation::ERROR_CLASS_ALREADY_EXISTS {
                        log::warn!(
                            "taskbar watcher: RegisterClassW failed ({}); system events will not be tracked",
                            err.0
                        );
                        STARTED.store(false, Ordering::SeqCst);
                        return;
                    }
                }
                // 真实顶层窗口（非 HWND_MESSAGE）才在 TaskbarCreated /
                // WM_DISPLAYCHANGE 广播名单里；不带 WS_VISIBLE、零尺寸、不 Show，
                // 任务栏 / Alt-Tab 均不可见。
                let hwnd = match CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    class_name,
                    w!("Vela Taskbar Listener"),
                    WS_OVERLAPPED,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(hinstance),
                    None,
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        log::warn!("taskbar watcher: CreateWindowExW failed: {e}");
                        STARTED.store(false, Ordering::SeqCst);
                        return;
                    }
                };
                WATCHER_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
                // 省电模式切换以 WM_POWERBROADCAST/PBT_POWERSETTINGCHANGE 到达本窗口。
                if let Err(e) = RegisterPowerSettingNotification(
                    HANDLE(hwnd.0),
                    &GUID_POWER_SAVING_STATUS,
                    DEVICE_NOTIFY_WINDOW_HANDLE,
                ) {
                    log::warn!("taskbar watcher: RegisterPowerSettingNotification failed: {e}");
                }
                log::info!("taskbar watcher started");
                let mut msg = MSG::default();
                // GetMessageW 出错返回 -1：as_bool() 对 -1 为真会拿旧 msg 无限
                // 重复派发（TaskbarCreated/电源事件全丢）。0 与 -1 都退出泵。
                while {
                    let r = GetMessageW(&mut msg, None, 0, 0);
                    r.0 != 0 && r.0 != -1
                } {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                WATCHER_HWND.store(0, Ordering::SeqCst);
                STARTED.store(false, Ordering::SeqCst);
                log::info!("taskbar watcher stopped");
            }
        });
        true
    }

    pub fn stop() {
        let hwnd = WATCHER_HWND.load(Ordering::SeqCst);
        if hwnd != 0 {
            // SAFETY: 向本进程自己创建的窗口投递消息。
            unsafe {
                let _ = PostMessageW(Some(HWND(hwnd as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::sync::Arc;

    use super::SystemEventCallback;

    pub fn register_callback(_cb: Arc<dyn SystemEventCallback>) {}

    pub fn start() -> bool {
        log::info!("taskbar watcher: unsupported platform, skipped");
        false
    }

    pub fn stop() {}

    pub fn watcher_hwnd() -> isize {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counter(AtomicUsize);

    impl SystemEventCallback for Counter {
        fn on_taskbar_created(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn callback_trait_has_noop_defaults_and_is_object_safe() {
        let c: Arc<dyn SystemEventCallback> = Arc::new(Counter(AtomicUsize::new(0)));
        // 默认实现可调用且无副作用（对象安全：可放进 Arc<dyn>）。
        c.on_display_change();
        c.on_power_broadcast(0x8013, 0);
        c.on_taskbar_created();
        // 注册在未启动线程时也是安全 no-op（不 panic）。
        register_callback(c);
        assert_eq!(watcher_hwnd(), 0, "本会话不启动消息窗线程");
    }
}
