//! [DOUBLE-TAP]（ZTools 借鉴 #13）双击修饰键呼出命令面板。
//!
//! ZTools 支持双击修饰键（如 Ctrl·Ctrl、Alt·Alt）唤起主窗（doubleTapManager，
//! 基于 uiohook）。Vela 落地为 WH_KEYBOARD_LL 键盘钩子（此前只有鼠标 LL 钩子）：
//! 350ms 窗口内**两次独立按下**同一族修饰键（左/右视为同族）且中间没有别的
//! 键 → 分派 toggle-palette（与全局热键同一条 dispatch 路径，含唤醒黑名单）。
//!
//! 防误触三件套：
//!  - 按住不放的自动重复不触发（新一次按下必须前有一次抬起）；
//!  - 窗口内出现任何非该修饰键的按键 → 候选作废（用户在打 Ctrl+C 这类组合）；
//!  - 默认关（设置镜像 general.doubleTapSummon；游戏 / 输入法场景争议大）。
//!
//! 钩子永不拦截事件（恒透传）。开关经配置线程 2s 刷新 AtomicBool，
//! 关闭期回调直接透传，近零成本。

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};

/// 双击判定窗口（ms）。
const DOUBLE_TAP_WINDOW_MS: u64 = 350;
/// 持续关闭这么多个复查周期（2s/次）后真正卸钩（B-1/D-8：默认关的功能
/// 不该常驻系统键盘钩子；短暂抖动不反复装卸）。
const UNHOOK_AFTER_DISABLED_TICKS: u32 = 5;

static APP: OnceLock<AppHandle> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);
/// 触发键族：0 = "ctrl"，1 = "alt"（钩子回调零锁读取，B-1）。
static KEY_KIND: AtomicU8 = AtomicU8::new(0);
/// 钩子线程句柄（Some = 已安装）。装卸都走这把锁，杜绝双钩竞态。
static HOOK_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

/// 键族编码。纯函数。
pub fn key_kind_code(kind: &str) -> u8 {
    if kind.eq_ignore_ascii_case("alt") {
        1
    } else {
        0
    }
}

/// 键族解码（0=ctrl 1=alt）。纯函数。
pub fn key_kind_of(code: u8) -> &'static str {
    if code == 1 {
        "alt"
    } else {
        "ctrl"
    }
}

/// 进程启动时预埋 AppHandle + 配置刷新线程（lib.rs setup 调用）。
/// B-1/D-8：钩子不再无条件安装——首次读到 enabled=true 才装；持续关闭
/// 一段时间后卸载（此前默认关也在启动时装上 WH_KEYBOARD_LL，全系统
/// 每次按键都路过本进程回调）。
pub fn init(app: AppHandle) {
    let _ = APP.set(app.clone());
    std::thread::Builder::new()
        .name("double-tap-config".into())
        .spawn(move || {
            let mut disabled_ticks: u32 = 0;
            loop {
                let (enabled, kind) = read_config(&app);
                ENABLED.store(enabled, Ordering::SeqCst);
                KEY_KIND.store(kind, Ordering::SeqCst);
                if enabled {
                    install_hook_once();
                    disabled_ticks = 0;
                } else {
                    disabled_ticks = disabled_ticks.saturating_add(1);
                    if disabled_ticks >= UNHOOK_AFTER_DISABLED_TICKS {
                        request_unhook();
                        disabled_ticks = 0;
                    }
                }
                // B-2：变更即醒（写路径广播），禁用态 2s 兜底（驱动卸钩计时）、
                // 启用态 30s 兜底——替代每 2s 的 SQLite 轮询。
                let fallback = if enabled { 30_000 } else { 2_000 };
                crate::settings_mirror::wait_for_change(Duration::from_millis(fallback));
            }
        })
        .ok();
}

/// 触发键归一（"ctrl" / "alt"；坏值回 ctrl）。纯函数，单测覆盖。
pub fn normalize_key(kind: &str) -> &'static str {
    if kind.eq_ignore_ascii_case("alt") {
        "alt"
    } else {
        "ctrl"
    }
}

/// 键值是否属于某键族的左右修饰键。纯函数，单测覆盖。
pub fn is_family_modifier(vk: u32, family: &str) -> bool {
    match family {
        "alt" => vk == 0xA4 || vk == 0xA5, // VK_LMENU / VK_RMENU
        _ => vk == 0xA2 || vk == 0xA3,     // VK_LCONTROL / VK_RCONTROL
    }
}

fn read_config(app: &AppHandle) -> (bool, u8) {
    // A-4：镜像读取收敛到 settings_mirror 单一助手。
    let Some(v) = crate::settings_mirror::read_json(app) else {
        return (false, 0);
    };
    let dt = v.get("general").and_then(|g| g.get("doubleTapSummon"));
    let enabled = dt
        .and_then(|s| s.get("enabled"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let kind = dt
        .and_then(|s| s.get("key"))
        .and_then(|k| k.as_str())
        .map(|k| key_kind_code(normalize_key(k)))
        .unwrap_or(0);
    (enabled, kind)
}

/* ------------------------------ 键盘钩子 ------------------------------ */

/// 双击候选（钩子线程私有，thread_local）。
struct TapState {
    last_press: Instant,
    /// 上一次该族事件是抬起（防自动重复）。
    last_was_up: bool,
}

#[cfg(windows)]
mod win {
    use super::*;

    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, HHOOK,
        KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    thread_local! {
        static TAP: std::cell::RefCell<Option<TapState>> = const { std::cell::RefCell::new(None) };
    }

    unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if !super::ENABLED.load(Ordering::Acquire) || code < 0 {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        let msg = wparam.0 as u32;
        if matches!(msg, WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP) {
            let info = lparam.0 as *const KBDLLHOOKSTRUCT;
            if !info.is_null() {
                let vk = (*info).vkCode;
                let down = matches!(msg, WM_KEYDOWN | WM_SYSKEYDOWN);
                // B-1：钩子回调内零锁——键族经 AtomicU8 缓存读取。
                let family = super::key_kind_of(super::KEY_KIND.load(Ordering::Relaxed));
                if is_family_modifier(vk, family) {
                    handle_family_event(down);
                } else {
                    // 任何其它键打断候选。
                    TAP.with(|t| *t.borrow_mut() = None);
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    fn handle_family_event(down: bool) {
        let now = Instant::now();
        TAP.with(|t| {
            let mut guard = t.borrow_mut();
            match (&mut *guard, down) {
                (Some(state), true) => {
                    if state.last_was_up
                        && now.duration_since(state.last_press).as_millis() as u64
                            <= DOUBLE_TAP_WINDOW_MS
                    {
                        // 双击成立：清候选 + 分派（重活丢线程，钩子回调不阻塞）。
                        *guard = None;
                        if let Some(app) = super::APP.get() {
                            let app = app.clone();
                            std::thread::Builder::new()
                                .name("double-tap-dispatch".into())
                                .spawn(move || {
                                    crate::game::capture_foreground_snapshot();
                                    if crate::shortcuts::wake_blacklisted(&app) {
                                        return;
                                    }
                                    crate::shortcuts::dispatch(&app, "toggle-palette");
                                })
                                .ok();
                        }
                    } else {
                        state.last_press = now;
                        state.last_was_up = false;
                    }
                }
                (Some(state), false) => {
                    state.last_was_up = true;
                }
                (None, true) => {
                    *guard = Some(TapState {
                        last_press: now,
                        last_was_up: false,
                    });
                }
                (None, false) => {}
            }
        });
    }

    /// 钩子线程 id（0 = 未安装）：卸钩时向它投递 WM_QUIT。
    pub(super) static HOOK_TID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    pub fn hook_thread() {
        unsafe {
            use windows::Win32::System::Threading::GetCurrentThreadId;
            HOOK_TID.store(GetCurrentThreadId(), Ordering::Release);
            let hook: HHOOK = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("double_tap: SetWindowsHookExW(WH_KEYBOARD_LL) failed: {e}");
                    return;
                }
            };
            log::info!("double_tap: WH_KEYBOARD_LL hook installed");
            let mut msg = MSG::default();
            loop {
                let r = GetMessageW(&mut msg, None, 0, 0);
                if !r.as_bool() {
                    break;
                }
                if msg.message == 0x0012 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
            HOOK_TID.store(0, Ordering::Release);
            log::info!("double_tap: hook removed");
        }
    }
}

#[cfg(windows)]
fn install_hook_once() {
    let mut guard = HOOK_THREAD.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        return;
    }
    match std::thread::Builder::new()
        .name("double-tap-kbd-hook".into())
        .spawn(win::hook_thread)
    {
        Ok(h) => *guard = Some(h),
        Err(e) => log::warn!("double_tap: spawn hook thread failed: {e}"),
    }
}

/// 请求卸钩：向钩子线程投 WM_QUIT 并等它退出（持锁期间完成，杜绝
/// 「旧钩未拆新钩已装」的双回调窗口）。
#[cfg(windows)]
fn request_unhook() {
    let mut guard = HOOK_THREAD.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(handle) = guard.take() {
        let tid = win::HOOK_TID.load(Ordering::Acquire);
        if tid != 0 {
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
                let _ = PostThreadMessageW(tid, 0x0012, WPARAM(0), LPARAM(0));
            }
        }
        let _ = handle.join();
        log::info!("double_tap: keyboard hook uninstalled (feature disabled)");
    }
}

#[cfg(not(windows))]
fn install_hook_once() {}

#[cfg(not(windows))]
fn request_unhook() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_families() {
        assert!(is_family_modifier(0xA2, "ctrl"));
        assert!(is_family_modifier(0xA3, "ctrl"));
        assert!(!is_family_modifier(0xA4, "ctrl"));
        assert!(is_family_modifier(0xA4, "alt"));
        assert!(is_family_modifier(0xA5, "alt"));
        assert!(!is_family_modifier(0xA2, "alt"));
        assert!(!is_family_modifier(0x41, "ctrl"));
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_key("alt"), "alt");
        assert_eq!(normalize_key("ALT"), "alt");
        assert_eq!(normalize_key("ctrl"), "ctrl");
        assert_eq!(normalize_key("junk"), "ctrl");
    }
}
