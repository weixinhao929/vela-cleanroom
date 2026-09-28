//! [SUPER-PANEL]（ZTools 借鉴 #11）超级面板：长按右键取词操作面板。
//!
//! uTools/ZTools 的招牌交互——按住右键（默认 500ms，可配 300–1000）触发：
//! 记录光标位置 → 模拟 Ctrl+C 取词 → 序号等待剪贴板变化（ZTools
//! waitForNextCopiedContent 同款，超时 1200ms）→ 在光标旁弹出操作面板，
//! 动作按剪贴板内容类型路由（文本 → 搜索/存便签/打开网址；文件 → 打开/
//! 复制路径/…）。面板动作复用 #1 的粘贴态动作构建器（前端 palette-payload）。
//!
//! 基础设施复用：
//!  - WH_MOUSE_LL 钩子模式抄 global_input.rs（事件驱动、开关翻 AtomicBool、
//!    进程内常驻）。长按计时**不用 SetTimer**：钩子线程本来就在泵消息 +
//!    20ms 步进轮询（取词触发通道），同一循环顺手检查「按住时长」即可；
//!  - Ctrl+C 注入复用 sys_actions::send_chord；
//!  - 序号等待 = GetClipboardSequenceNumber 轮询（30ms 步进，1200ms 超时）；
//!  - 读内容复用 clipboard::read_text_now / read_hdrop_list（取词路径不入
//!    历史；模拟复制产生的真实剪贴板变化会由正常采集线程按去重规则处理）。
//!
//! 安全边界：默认关（设置镜像 general.superPanel，长按右键有误触争议）；
//! 前台是本进程时不触发（自取自无意义）；钩子永不拦截事件（恒透传，
//! 右键正常语义不受影响——长按判定只是旁路观察）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};

/// 面板内容事件：载荷 SuperPanelPayload（emit_to 面板窗）。
pub const EVENT_CONTENT: &str = "super-panel:content";
/// 长按移动取消阈值（px）。
const MOVE_CANCEL_PX: i32 = 10;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// 总开关（设置镜像 general.superPanel.enabled，配置线程 2s 刷新）。
static ENABLED: AtomicBool = AtomicBool::new(false);
/// 长按时长毫秒（钳 300–1000，默认 500）。
static DURATION_MS: Mutex<u32> = Mutex::new(500);
/// 钩子线程句柄（Some = 已安装）。装卸都走这把锁，杜绝双钩竞态（D-8）。
static HOOK_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

/// 进程启动时预埋 AppHandle + 起配置刷新线程（lib.rs setup 调用）。
/// D-8：鼠标钩子随开关装卸——首次 enabled=true 才安装，持续关闭后卸载
/// （默认关的功能不该常驻系统鼠标钩子）。
pub fn init(app: AppHandle) {
    let _ = APP.set(app.clone());
    std::thread::Builder::new()
        .name("super-panel-config".into())
        .spawn(move || {
            let mut disabled_ticks: u32 = 0;
            loop {
                let (enabled, ms) = read_config(&app);
                ENABLED.store(enabled, Ordering::SeqCst);
                *DURATION_MS.lock().unwrap_or_else(|p| p.into_inner()) = ms;
                if enabled {
                    install_hook_once();
                    disabled_ticks = 0;
                } else {
                    disabled_ticks = disabled_ticks.saturating_add(1);
                    if disabled_ticks >= 5 {
                        request_unhook();
                        disabled_ticks = 0;
                    }
                }
                // B-2：变更即醒；禁用态 2s 兜底（驱动卸钩计时）、启用态 30s 兜底。
                let fallback = if enabled { 30_000 } else { 2_000 };
                crate::settings_mirror::wait_for_change(Duration::from_millis(fallback));
            }
        })
        .ok();
}

/// 长按时长钳制（300–1000ms；设置层前端已钳，这里兜底）。纯函数，单测覆盖。
pub fn clamp_duration_ms(ms: i64) -> u32 {
    ms.clamp(300, 1000) as u32
}

/// 从设置镜像读 (enabled, duration_ms)（容错：任何失败回默认关）。
/// A-4：镜像读取收敛到 settings_mirror 单一助手。
fn read_config(app: &AppHandle) -> (bool, u32) {
    let default = (false, clamp_duration_ms(500));
    let Some(v) = crate::settings_mirror::read_json(app) else {
        return default;
    };
    let sp = v.get("general").and_then(|g| g.get("superPanel"));
    let enabled = sp
        .and_then(|s| s.get("enabled"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let ms = sp
        .and_then(|s| s.get("durationMs"))
        .and_then(|n| n.as_i64())
        .unwrap_or(500);
    (enabled, clamp_duration_ms(ms))
}

/* ------------------------------ 鼠标钩子 ------------------------------ */

/// 长按状态（钩子线程私有，thread_local 无锁）。
struct PressState {
    pt: POINT,
    start: Instant,
}

#[cfg(windows)]
mod win {
    use super::*;

    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage, HHOOK,
        MSG, MSLLHOOKSTRUCT, PM_REMOVE, WH_MOUSE_LL, WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    thread_local! {
        static PRESS: std::cell::RefCell<Option<PressState>> = const { std::cell::RefCell::new(None) };
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if !super::ENABLED.load(Ordering::Acquire) || code < 0 {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        match wparam.0 as u32 {
            WM_RBUTTONDOWN => {
                let info = lparam.0 as *const MSLLHOOKSTRUCT;
                if !info.is_null() {
                    PRESS.with(|p| {
                        *p.borrow_mut() = Some(PressState {
                            pt: (*info).pt,
                            start: Instant::now(),
                        })
                    });
                }
            }
            WM_MOUSEMOVE => {
                let info = lparam.0 as *const MSLLHOOKSTRUCT;
                if !info.is_null() {
                    let pt = (*info).pt;
                    let cancel = PRESS.with(|p| {
                        p.borrow().as_ref().is_some_and(|s| {
                            (pt.x - s.pt.x).abs() > MOVE_CANCEL_PX
                                || (pt.y - s.pt.y).abs() > MOVE_CANCEL_PX
                        })
                    });
                    if cancel {
                        PRESS.with(|p| *p.borrow_mut() = None);
                    }
                }
            }
            WM_RBUTTONUP => {
                // 正常右键：长按未到期就松手 → 取消（不吞事件，恒透传）。
                PRESS.with(|p| *p.borrow_mut() = None);
            }
            _ => {}
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// 泵循环每 20ms 调一次：按住时长已到 → 消费状态并返回锚点。
    pub(super) fn take_fired_press() -> Option<POINT> {
        let duration = super::DURATION_MS.lock().unwrap_or_else(|p| p.into_inner());
        PRESS.with(|p| {
            let mut guard = p.borrow_mut();
            match guard.as_ref() {
                Some(s) if s.start.elapsed().as_millis() as u32 >= *duration => {
                    let pt = s.pt;
                    *guard = None;
                    Some(pt)
                }
                _ => None,
            }
        })
    }

    /// 钩子线程 id（0 = 未安装）：卸钩时向它投递 WM_QUIT 唤醒。
    pub(super) static HOOK_TID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    pub fn hook_thread() {
        unsafe {
            use windows::Win32::System::Threading::GetCurrentThreadId;
            HOOK_TID.store(GetCurrentThreadId(), Ordering::Release);
            let hook: HHOOK = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("super_panel: SetWindowsHookExW(WH_MOUSE_LL) failed: {e}");
                    return;
                }
            };
            log::info!("super_panel: WH_MOUSE_LL hook installed");
            let mut msg = MSG::default();
            'outer: loop {
                // 非阻塞泵消息（SetWindowsHookExW 的 LL 钩子本身不需要消息泵，
                // 但保守泵着无成本，也为未来窗口化计时留路）。
                loop {
                    let r = PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE);
                    if !r.as_bool() {
                        break;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                    if msg.message == 0x0012 {
                        // WM_QUIT
                        break 'outer;
                    }
                }
                if let Some(pt) = take_fired_press() {
                    if let Some(app) = super::APP.get() {
                        let app = app.clone();
                        std::thread::Builder::new()
                            .name("super-panel-fetch".into())
                            .spawn(move || super::fetch_and_show(&app, pt.x, pt.y))
                            .ok();
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
            HOOK_TID.store(0, Ordering::Release);
            log::info!("super_panel: hook removed");
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
        .name("super-panel-mouse-hook".into())
        .spawn(win::hook_thread)
    {
        Ok(h) => *guard = Some(h),
        Err(e) => log::warn!("super_panel: spawn hook thread failed: {e}"),
    }
}

/// 请求卸钩（D-8）：投 WM_QUIT 唤醒 + join 等退出，杜绝双钩窗口。
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
        // 20ms 轮询节律下最迟一拍内退出；join 兜住再启用时的重装时序。
        let _ = handle.join();
        log::info!("super_panel: mouse hook uninstalled (feature disabled)");
    }
}

#[cfg(not(windows))]
fn install_hook_once() {}

#[cfg(not(windows))]
fn request_unhook() {}

/* ------------------------------ 取词流程 ------------------------------ */

/// 取词结果载荷（EVENT_CONTENT；serde camelCase 与前端对齐）。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperPanelPayload {
    /// "text" | "files"。
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    /// 弹出锚点（屏幕物理像素；前端换算 DIP 由窗口定位已在 Rust 完成）。
    pub x: i32,
    pub y: i32,
}

/// 完整取词流程（工作线程）：前台自检 → 序号等待 + 模拟 Ctrl+C → 建面板窗。
pub(crate) fn fetch_and_show(app: &AppHandle, x: i32, y: i32) {
    #[cfg(windows)]
    {
        // 前台是本进程（自己窗口里长按）不触发。
        if foreground_is_self() {
            return;
        }
        let Some((kind, text, files)) = fetch_selection() else {
            return; // 1200ms 内无新内容：安静退出（应用未响应取词）。
        };
        let payload = SuperPanelPayload {
            kind,
            text,
            files,
            x,
            y,
        };
        show_panel_window(app, x, y, &payload);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, x, y);
    }
}

/// 前台是否本进程。
#[cfg(windows)]
fn foreground_is_self() -> bool {
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return true; // 拿不到前台：保守跳过
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        pid == GetCurrentProcessId()
    }
}

/// 序号等待 + 模拟 Ctrl+C + 读回内容。返回 (kind, text, files)。
/// 文件优先于文本（与采集线程同优先序）。
/// D-7：合成复制期间抑制剪贴板历史入库——取词选中的常是敏感明文，
/// 不应随监听器留存 30 天；抑制窗 4s 覆盖最长等待（1.2s）+ 采集抖动。
#[cfg(windows)]
fn fetch_selection() -> Option<(String, Option<String>, Option<Vec<String>>)> {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let seq0 = unsafe { GetClipboardSequenceNumber() };
    // Ctrl+C（VK_CONTROL=0x11, 'C'=0x43；四事件序列给应用留响应窗口）。
    crate::clipboard::suppress_history_for(Duration::from_secs(4));
    crate::sys_actions::send_chord_pub(0x11, 0x43);
    let deadline = Instant::now() + Duration::from_millis(1200);
    loop {
        std::thread::sleep(Duration::from_millis(30));
        if unsafe { GetClipboardSequenceNumber() } != seq0 {
            break;
        }
        if Instant::now() >= deadline {
            return None;
        }
    }
    unsafe {
        if let Some(files) = crate::clipboard::read_hdrop_list() {
            if !files.is_empty() {
                return Some(("files".into(), None, Some(files)));
            }
        }
        if let Some(text) = crate::clipboard::read_text_now() {
            return Some(("text".into(), Some(text), None));
        }
    }
    None
}

/// 建/显面板窗并投递内容（窗口存在则复用：先 hide 复位再定位显示）。
fn show_panel_window(app: &AppHandle, x: i32, y: i32, payload: &SuperPanelPayload) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("super-panel") {
        let _ = w.hide();
        position_window(app, &w, x, y);
        let _ = w.show();
    } else {
        let built = tauri::WebviewWindowBuilder::new(
            app,
            "super-panel",
            // C-10：super-panel.html 精简入口（vite 多页），不再共用 index.html
            // 全量主包；旧 hash 由 main.tsx 重定向兜底。
            tauri::WebviewUrl::App("super-panel.html".into()),
        )
        .title("Vela 超级面板")
        .inner_size(SUPER_PANEL_W, SUPER_PANEL_H)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        // H1 就绪握手同款：首帧前不显示，前端就绪后自行 show（3s 兜底）。
        .visible(false)
        .build();
        match built {
            Ok(w) => {
                position_window(app, &w, x, y);
                crate::windows::spawn_show_fallback(app, "super-panel", 3000);
            }
            Err(e) => {
                log::warn!("super_panel: build window failed: {e}");
                return;
            }
        }
    }
    // 内容事件发到面板窗（前端挂载后监听；晚于窗口创建的 emit 可能早于监听，
    // 前端就绪握手后由 get_super_panel_payload 命令补拉——见命令面）。
    let _ = tauri::Emitter::emit_to(app, "super-panel", EVENT_CONTENT, payload.clone());
    *LAST_PAYLOAD.lock().unwrap_or_else(|p| p.into_inner()) = Some(payload.clone());
}

/// 最近一次取词载荷（前端面板窗就绪握手后补拉，防 emit 早于监听丢事件）。
static LAST_PAYLOAD: Mutex<Option<SuperPanelPayload>> = Mutex::new(None);

/// [SUPER-PANEL] 面板窗就绪后补拉最近载荷（一次性；取走即清，防旧内容闪现）。
#[tauri::command]
pub fn get_super_panel_payload(window: tauri::Window) -> Option<SuperPanelPayload> {
    if window.label() != "super-panel" {
        return None;
    }
    LAST_PAYLOAD
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
}

/// 面板窗逻辑尺寸（position_window 钳制用同款常量）。
const SUPER_PANEL_W: f64 = 320.0;
const SUPER_PANEL_H: f64 = 380.0;

/// 面板落位：锚点右下方 12px，工作区内钳制；物理像素 → DIP 按所在显示器。
fn position_window(app: &AppHandle, w: &tauri::WebviewWindow, x: i32, y: i32) {
    if let Ok(Some(m)) = app.monitor_from_point(x as f64, y as f64) {
        let scale = m.scale_factor();
        let mx = x as f64 / scale;
        let my = y as f64 / scale;
        let size = m.size();
        let pos = m.position();
        let px = pos.x as f64 / scale;
        let py = pos.y as f64 / scale;
        let vw = size.width as f64 / scale;
        let vh = size.height as f64 / scale;
        let fx = (mx + 12.0).min(px + vw - SUPER_PANEL_W - 8.0).max(px + 8.0);
        let fy = (my + 12.0).min(py + vh - SUPER_PANEL_H - 8.0).max(py + 8.0);
        let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            fx, fy,
        )));
        return;
    }
    let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x + 12,
        y + 12,
    )));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_clamped() {
        assert_eq!(clamp_duration_ms(100), 300);
        assert_eq!(clamp_duration_ms(500), 500);
        assert_eq!(clamp_duration_ms(5_000), 1_000);
        assert_eq!(clamp_duration_ms(-1), 300);
    }
}
