//! 全局左键监视（灵动岛展开面的「岛外点击收起」，借鉴 NotchPeninsula 的
//! 岛外点击兜底；NPS 用渲染循环轮询 GetAsyncKeyState，Vela 无渲染循环，
//! 改为条件式 WH_MOUSE_LL 钩子——事件驱动、不轮询、不用时零成本）。
//!
//! 动机：灵动岛展开面（磁贴面板 / 全岛面板）挂在 widget 窗口里，而 widget
//! 窗口对交互矩形之外的区域点击穿透——用户点桌面 / 点别的应用时，点击
//! **永远到不了 webview**，DOM 层的 outside-click 收起无从谈起，面板会一直
//! 挂着直到按 Esc。本模块在「有展开面」期间挂一只低级鼠标钩子：
//!
//! - 只看 WM_LBUTTONDOWN；
//! - 命中点所在根窗口属于**本进程**（我们的 widget / 设置 / 速记窗）→ 视为
//!   「应用内点击」，交给 DOM 自己处理，不发事件；
//! - 其余（桌面 / 画布穿透区 / 其它应用）→ emit `global:left-down`，前端
//!   DockShell 收到后按需收起展开面。
//!
//! 「唤醒点击防误收」（NPS _wakeClickPending）在 Vela 不适用：收合态的岛靠
//! pointerenter 悬停弹出、不存在「点边缘唤醒」手势，天然没有「唤醒点击落
//! 在可见矩形外」的时序问题——审查结论记录在 DockShell 的收起注释里。
//!
//! 生命周期：命令 `set_global_left_click_watch(enabled)` 由前端在展开面
//! 出现 / 全部收起时切换。钩子线程首次启用时安装、进程内常驻；启停只翻
//! AtomicBool（关闭期回调直接透传，近零成本），不反复装卸钩子。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

/// 事件名：一次岛外左键按下（无载荷——前端只关心「点了外面」这一事实）。
pub const EVENT_LEFT_DOWN: &str = "global:left-down";

static APP: OnceLock<AppHandle> = OnceLock::new();
/// 「想看岛外点击」的窗口集合（按 label 记账）：多屏各有一条岛，A 屏展开
/// 时不能被 B 屏的「全部收起」关掉全局开关——ENABLED = 集合非空。
static WANTERS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn wanters() -> &'static Mutex<Option<HashSet<String>>> {
    &WANTERS
}

fn refresh_enabled() {
    let n = wanters()
        .lock()
        .map(|g| g.as_ref().map(|s| !s.is_empty()).unwrap_or(false))
        .unwrap_or(false);
    ENABLED.store(n, Ordering::SeqCst);
}

/// 见模块注释；ENABLED 由 WANTERS 派生（这里保留静态以供钩子回调零锁读取）。
static ENABLED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
mod win {
    use super::*;

    use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetMessageW, GetWindowThreadProcessId,
        SetWindowsHookExW, TranslateMessage, WindowFromPoint, GA_ROOT, HHOOK, MSG, MSLLHOOKSTRUCT,
        WH_MOUSE_LL, WM_APP, WM_LBUTTONDOWN,
    };

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // 钩子回调里只做最廉价的事：开关关着直接透传。
        if !ENABLED.load(Ordering::Acquire) {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        if code >= 0 && wparam.0 as u32 == WM_LBUTTONDOWN {
            let info = lparam.0 as *const MSLLHOOKSTRUCT;
            if !info.is_null() && !click_in_own_process((*info).pt) {
                if let Some(app) = APP.get() {
                    use tauri::Emitter;
                    let _ = app.emit_filter(super::EVENT_LEFT_DOWN, (), |win| match win {
                        tauri::EventTarget::WebviewWindow { label }
                        | tauri::EventTarget::Webview { label }
                        | tauri::EventTarget::Window { label }
                        | tauri::EventTarget::AnyLabel { label } => label.starts_with("widget-"),
                        _ => false,
                    });
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// 命中点所在根窗口是否属于本进程。点击落在 widget 窗口的穿透区时
    /// WindowFromPoint 返回其下的窗口（桌面/别的应用）→ 不算本进程，
    /// 语义正好是「岛外」。
    unsafe fn click_in_own_process(pt: POINT) -> bool {
        let hwnd = WindowFromPoint(pt);
        if hwnd.is_invalid() {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let target = if root.is_invalid() { hwnd } else { root };
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(target, Some(&mut pid as *mut u32));
        pid != 0 && pid == GetCurrentProcessId()
    }

    pub fn hook_thread() {
        unsafe {
            let hook: HHOOK = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("global_input: SetWindowsHookExW(WH_MOUSE_LL) failed: {e}");
                    return;
                }
            };
            log::info!("global_input: WH_MOUSE_LL hook installed");

            // 消息泵：低级钩子回调经由本线程的消息循环派发。WM_APP+1 = 卸载信号
            // （当前常驻不卸，保留结构以备退出期清理）。
            let mut msg = MSG::default();
            loop {
                let r = GetMessageW(&mut msg, None, 0, 0);
                if !r.as_bool() {
                    break;
                }
                if msg.message == WM_APP + 1 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
            log::info!("global_input: hook removed");
        }
    }
}

fn install_hook_once() {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("global-mouse-hook".into())
        .spawn(|| {
            #[cfg(windows)]
            win::hook_thread();
        })
        .ok();
}

/// 前端在「本窗口出现灵动岛展开面」时调 true、「全部收起」时调 false。
/// 按窗口记账（label 为键）：任一窗口还想看，钩子就保持启用。窗口销毁由
/// drop_window 兜底清理（热拔显示器直接 destroy 时前端 cleanup 不会执行）。
#[tauri::command]
pub fn set_global_left_click_watch(window: tauri::Window, enabled: bool) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    if enabled {
        install_hook_once();
    }
    let label = window.label().to_string();
    let mut guard = wanters().lock().unwrap_or_else(|p| p.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    if enabled {
        set.insert(label);
    } else {
        set.remove(&label);
    }
    drop(guard);
    refresh_enabled();
    Ok(())
}

/// 窗口销毁时移除其记账（lib.rs RunEvent::Destroyed 调用）。
pub fn drop_window(label: &str) {
    let mut guard = wanters().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(label);
    }
    drop(guard);
    refresh_enabled();
}

/// 进程启动时预埋 AppHandle（钩子回调 emit 用）。
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}
