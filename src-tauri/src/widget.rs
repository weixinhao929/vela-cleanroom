//! Widget window behavior: transparent desktop layer, click-through hit testing,
//! edit mode and always-on-top. Mirrors the "float on wallpaper, never steal
//! focus" model used by desktop-widget apps.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

/// A logical-pixel rectangle reported by the webview marking an interactive
/// element (button, input, draggable handle, ...). The Rust core uses these
/// to decide when to let the window capture mouse events.
///
/// Widget cards additionally carry their `id` and stacking `z` so the core can
/// bring the clicked widget to the front *directly* — even when the
/// click-through race would otherwise swallow the click before it reaches the
/// webview. Non-widget interactive elements leave `id`/`z` as `None`/0.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InteractiveRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub z: i32,
}

#[derive(Clone, Serialize)]
pub struct WidgetState {
    pub edit_mode: bool,
    pub always_on_top: bool,
}

#[tauri::command]
pub fn set_interactive_regions(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    regions: Vec<InteractiveRect>,
) {
    // gate: none needed（按调用方自身 label 键控写入，低信任窗口只能改自己的
    // 命中矩形，够不到其它窗口的键）
    // Keyed by the calling window's label so each screen's widget layer keeps
    // its own hit-test regions (multi-monitor).
    replace_regions(
        &mut state
            .interactive_regions
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
        window.label(),
        regions,
    );
}

/// E-1 抽出的纯函数接缝：按窗口标签**整表替换**命中矩形（不是合并/追加——
/// 前端每轮全量上报，旧矩形必须整体作废，否则消失的控件会留下吃点击的
/// 幽灵区）；空数组等价清空该窗口。抽出来供内联测试锚定语义。
fn replace_regions(
    map: &mut std::collections::HashMap<String, Vec<InteractiveRect>>,
    label: &str,
    regions: Vec<InteractiveRect>,
) {
    map.insert(label.to_string(), regions);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// E-1：set_interactive_regions 的核心语义守卫——整表替换（不是并集）。
    /// 前端 useClickThrough 按内容指纹全量上报，若这里误做成 append/merge，
    /// 消失的控件会在 Rust 侧留下永久幽灵命中区（点击穿透失效的最隐蔽
    /// 形态），而前端签名去重机制会掩盖这个错误。
    #[test]
    fn replace_regions_replaces_not_merges() {
        let mut map = std::collections::HashMap::new();
        replace_regions(&mut map, "widget-0", vec![rect(0.0, 0.0, 10.0, 10.0)]);
        replace_regions(&mut map, "widget-0", vec![rect(20.0, 20.0, 5.0, 5.0)]);
        let list = map.get("widget-0").expect("窗口键存在");
        assert_eq!(list.len(), 1, "整表替换：旧矩形必须作废");
        assert_eq!(list[0].x, 20.0);
    }

    /// 多显示器键隔离：widget-0/widget-1 各持自己的矩形集，互不覆盖。
    #[test]
    fn replace_regions_keys_by_window_label() {
        let mut map = std::collections::HashMap::new();
        replace_regions(&mut map, "widget-0", vec![rect(0.0, 0.0, 1.0, 1.0)]);
        replace_regions(&mut map, "widget-1", vec![rect(9.0, 9.0, 1.0, 1.0)]);
        assert_eq!(map.len(), 2);
        assert_eq!(map["widget-0"][0].x, 0.0);
        assert_eq!(map["widget-1"][0].x, 9.0);
    }

    /// 空数组 = 清空该窗口（画布清空/窗口重建路径），不是删除键也不是保留旧值。
    #[test]
    fn replace_regions_empty_vec_clears() {
        let mut map = std::collections::HashMap::new();
        replace_regions(&mut map, "widget-0", vec![rect(0.0, 0.0, 1.0, 1.0)]);
        replace_regions(&mut map, "widget-0", vec![]);
        assert!(map["widget-0"].is_empty());
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> InteractiveRect {
        InteractiveRect {
            x,
            y,
            w,
            h,
            id: None,
            z: 0,
        }
    }
}

#[tauri::command]
pub fn set_edit_mode(
    window: tauri::Window,
    app: AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    // 窗口闸门：编辑模式是全局运行时状态，不给 web-preview 远程页面翻转。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    *state.edit_mode.lock().unwrap_or_else(|p| p.into_inner()) = enabled;
    // The widget layer is always interactive (no click-through) — the webview
    // receives every mouse event, so we only flip the internal flag here.
    let _ = app.emit("widget:edit-mode", enabled);
    Ok(())
}

/// DeskOrder 借鉴 #6：双击空白桌面切换小组件层显隐的手势开关（默认开）。
/// 钩子线程只读这个原子，前端在设置变化与启动时写入。
pub(crate) static DESKTOP_DCLICK_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

#[tauri::command]
pub fn set_desktop_double_click(window: tauri::Window, enabled: bool) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    DESKTOP_DCLICK_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn set_always_on_top(
    window: tauri::Window,
    app: AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    *state
        .always_on_top
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = enabled;
    for (label, w) in app.webview_windows() {
        if label.starts_with("widget-") {
            let _ = w.set_always_on_top(enabled);
            // 置顶与沉底是互斥的 z 序模式：关掉置顶必须把窗口送回桌面层，
            // 否则它停在普通窗口 band 里，既不在顶也不贴壁纸。
            if !enabled {
                let _ = w.set_always_on_bottom(true);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_widget_state(state: tauri::State<AppState>) -> WidgetState {
    WidgetState {
        edit_mode: *state.edit_mode.lock().unwrap_or_else(|p| p.into_inner()),
        always_on_top: *state
            .always_on_top
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
    }
}

// ---------------------------------------------------------------------------
// Click-through implementation
//
// The widget layer floats full-screen on the wallpaper but must only capture
// mouse input over interactive elements (widget cards, their controls, floating
// toolbars); everywhere else clicks fall through to the desktop so icons stay
// selectable and rubber-band selection works.
//
// The original implementation polled the cursor every 10ms. That left a race
// window: when the cursor moved onto a just-appeared interactive element (e.g.
// the quick-action bar), the layer could still be click-through for up to one
// poll interval, and the very first click was swallowed by the desktop.
//
// We now install a global low-level mouse hook (WH_MOUSE_LL). The hook fires
// on *every* mouse move/button event system-wide, event-driven, so the layer
// transitions click-through -> interactive in the same event that moves the
// cursor onto a control — eliminating the first-click-loss race entirely.
// Crucially the hook is independent of our window, so it keeps firing even
// while the layer is click-through (that is exactly when we need to detect the
// cursor entering a control).
//
// The hook also watches for WM_LBUTTONDOWN and emits `widget:bring-to-front`
// so the clicked widget is raised from the native side (race-proof).
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod low_level_hook {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::{Arc, OnceLock, RwLock};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, KillTimer, SetTimer,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT,
        WH_MOUSE_LL, WM_LBUTTONDOWN, WM_TIMER,
    };

    use super::InteractiveRect;
    use crate::AppState;

    // The hook proc is a plain `extern "system"` fn and cannot capture, so the
    // app handle + per-window previous-state tracking live in thread-local
    // storage on the thread that owns the message loop (the thread that
    // installed the hook).
    thread_local! {
        static HOOK_APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
        static PREV_INTERACTIVE: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
        /// DeskOrder 借鉴 #6：上次左键按下（GetTickCount64 毫秒 + 物理坐标），
        /// 用于双击判定（500ms / 10px，Windows 默认双击阈值）。
        static LAST_CLICK: RefCell<(u64, i32, i32)> = const { RefCell::new((0, i32::MIN, i32::MIN)) };
    }

    /// Widget window geometry: (origin_x, origin_y, w, h, scale_factor)。
    type WindowGeometry = (i32, i32, i32, i32, f64);
    /// F-4：`RwLock<Arc<HashMap>>` 快照读。钩子热路径不再整表 clone（堆分配），
    /// 改为读锁 + Arc 引用计数 +1（O(1)）拿一致快照；写侧每次换新 Arc。
    type GeometryCache = RwLock<Arc<HashMap<String, WindowGeometry>>>;

    /// Widget window geometry cache: label -> (origin_x, origin_y, w, h, scale).
    ///
    /// `outer_position()` / `outer_size()` / `scale_factor()` called from a
    /// non-main thread are synchronous round-trips to the main thread. Doing
    /// that inside the hook proc puts a blocking IPC on the system-wide mouse
    /// input path: any main-thread stall (backup, excel parse, clipboard
    /// image decode...) would lag the whole cursor, and repeated stalls make
    /// Windows silently remove the hook (LowLevelHooksTimeout). The hook
    /// therefore only reads this cache; a dedicated refresher thread (and the
    /// initial main-thread fill) keeps it current.
    fn geometry_cache() -> &'static GeometryCache {
        static CACHE: OnceLock<GeometryCache> = OnceLock::new();
        CACHE.get_or_init(|| RwLock::new(Arc::new(HashMap::new())))
    }

    /// Rebuild the geometry cache from live windows. Also drops interactive
    /// regions of widget windows that no longer exist, so destroyed screens
    /// (monitor unplug) don't leave stale hit-test data behind.
    fn refresh_geometry(app: &AppHandle) {
        let mut fresh: HashMap<String, WindowGeometry> = HashMap::new();
        for (label, w) in app.webview_windows() {
            if !label.starts_with("widget-") {
                continue;
            }
            if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
                let scale = w.scale_factor().unwrap_or(1.0);
                fresh.insert(label, (p.x, p.y, s.width as i32, s.height as i32, scale));
            }
        }
        let state = app.state::<AppState>();
        state
            .interactive_regions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|k, _| fresh.contains_key(k));
        *geometry_cache().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(fresh);
    }

    const HEARTBEAT_TIMER_ID: usize = 0x57504854; // "WPHT"
    const HEARTBEAT_MS: u32 = 60_000;

    /// R5：事件驱动的几何刷新入口（monitor.rs 的窗口 Moved/Resized/Destroyed
    /// 回调在主线程上调用）。同线程采集没有跨线程 IPC 往返，代价即三个
    /// getter；30s 兜底轮询照旧覆盖未伴随窗口事件的漂移。
    pub fn refresh_geometry_now(win: &tauri::WebviewWindow) {
        refresh_geometry(win.app_handle());
    }

    pub fn start(app: AppHandle) {
        // Prime the cache on the main thread (cheap, no cross-thread IPC) so
        // the hook has geometry from its very first event.
        refresh_geometry(&app);

        // Low-frequency geometry refresher — R5 起降为 30s 兜底：几何变化的主
        // 通道是 widget 窗口的 Moved/Resized/Destroyed 事件（主线程直采），
        // 拓扑重排也必然伴随窗口 Moved。钩子热路径依旧只读缓存。
        let refresher_app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            if catch_unwind(AssertUnwindSafe(|| refresh_geometry(&refresher_app))).is_err() {
                log::error!("widget geometry refresher panicked; retrying next tick");
            }
        });

        std::thread::spawn(move || {
            // The hook proc and the message loop run on *this* thread. `thread_local!`
            // is per-thread, so HOOK_APP must be set here (not on the caller's thread)
            // or hook_proc would read None forever and click-through would freeze.
            HOOK_APP.with(|c| *c.borrow_mut() = Some(app.clone()));
            unsafe {
                let mut hook: HHOOK = match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0)
                {
                    Ok(h) => h,
                    Err(_) => {
                        log::warn!(
                            "WH_MOUSE_LL install failed; falling back to 10ms cursor polling"
                        );
                        start_poller_fallback(app);
                        return;
                    }
                };
                // Periodic self-heal: Windows silently unhooks a low-level hook
                // whose proc exceeds LowLevelHooksTimeout, leaving click-through
                // stuck in its last state. A timer on this thread's message loop
                // lets us reinstall the hook before that becomes user-visible.
                let _ = SetTimer(None, HEARTBEAT_TIMER_ID, HEARTBEAT_MS, None);
                // Apply the initial interactive state from the current cursor
                // position so the layer isn't stuck interactive/click-through
                // before the first mouse event arrives.
                let mut pt: POINT = std::mem::zeroed();
                if GetCursorPos(&mut pt).is_ok() {
                    apply_event(&app, None, pt.x, pt.y);
                }
                let mut msg: MSG = std::mem::zeroed();
                loop {
                    let ret = GetMessageW(&mut msg, None, 0, 0);
                    if ret.0 == 0 || ret.0 == -1 {
                        break; // WM_QUIT or error
                    }
                    if msg.message == WM_TIMER && msg.wParam.0 == HEARTBEAT_TIMER_ID {
                        let _ = UnhookWindowsHookEx(hook);
                        match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) {
                            Ok(h) => hook = h,
                            Err(_) => {
                                log::warn!(
                                    "WH_MOUSE_LL reinstall failed; falling back to 10ms cursor polling"
                                );
                                let _ = KillTimer(None, HEARTBEAT_TIMER_ID);
                                start_poller_fallback(app);
                                break;
                            }
                        }
                        continue; // timer handled; nothing to dispatch
                    }
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                }
                let _ = KillTimer(None, HEARTBEAT_TIMER_ID);
                let _ = UnhookWindowsHookEx(hook);
            }
        });
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            if let Some(app) = HOOK_APP.with(|c| c.borrow().clone()) {
                // A panic unwinding through extern "system" is UB; keep the
                // input pipeline alive no matter what apply_event hits.
                let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
                    let msll = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                    apply_event(&app, Some(wparam.0 as u32), msll.pt.x, msll.pt.y);
                }));
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// Recompute whether each screen's widget layer should accept mouse input at
    /// screen `(sx, sy)` and toggle `ignore_cursor_events` only when it changes.
    /// `msg` is `Some` for an actual WM_LBUTTONDOWN, used to raise the clicked
    /// widget. Windows tile the virtual desktop (one per monitor), so at most one
    /// widget window contains the cursor per event.
    ///
    /// Runs on the hook thread: reads only in-memory state (geometry cache,
    /// region lock) and dispatches window mutations to the main thread without
    /// waiting — never blocks the mouse input path.
    fn apply_event(app: &AppHandle, msg: Option<u32>, sx: i32, sy: i32) {
        let state = app.state::<AppState>();
        let edit_mode = *state.edit_mode.lock().unwrap_or_else(|p| p.into_inner());
        let geometry = geometry_cache()
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        for (label, &(ox, oy, w, h, scale)) in geometry.iter() {
            // Skip screens the cursor isn't currently over; keep their state
            // as-is (they will be re-evaluated once the cursor enters).
            if sx < ox || sx >= ox + w || sy < oy || sy >= oy + h {
                continue;
            }
            let px = (sx as f64 - ox as f64) / scale;
            let py = (sy as f64 - oy as f64) / scale;

            let (interactive, top_id) = {
                let regions = state
                    .interactive_regions
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let rects: &[InteractiveRect] = regions
                    .get(label.as_str())
                    .map(|v| v.as_slice())
                    .unwrap_or(&[]);
                let hit = edit_mode || cursor_in_regions(rects, px, py);
                let top = if msg == Some(WM_LBUTTONDOWN) && !edit_mode && hit {
                    widget_under_point(rects, px, py)
                } else {
                    None
                };
                (hit, top)
            };

            let prev = PREV_INTERACTIVE.with(|c| c.borrow().get(label.as_str()).copied());
            if prev != Some(interactive) {
                PREV_INTERACTIVE.with(|c| {
                    c.borrow_mut().insert(label.clone(), interactive);
                });
                if let Some(window) = app.get_webview_window(label.as_str()) {
                    // Fire-and-forget: run_on_main_thread only posts the closure
                    // to the main event loop; calling set_ignore_cursor_events
                    // synchronously here would block the hook on a main-thread
                    // round-trip (the exact stall LowLevelHooksTimeout punishes).
                    let _ = app.run_on_main_thread(move || {
                        let _ = window.set_ignore_cursor_events(!interactive);
                    });
                }
            }

            if let Some(id) = top_id {
                let _ = app.emit("widget:bring-to-front", id);
            }

            // DeskOrder 借鉴 #6：左键按下且该点不属于任何交互区（点击将直达
            // 桌面）时做双击判定；确认命中空白桌面（非图标、非其它应用窗口）
            // 后切换小组件层显隐。编辑模式下画布接管全部输入，不参与。
            if msg == Some(WM_LBUTTONDOWN)
                && !edit_mode
                && !interactive
                && maybe_desktop_double_click(sx, sy)
            {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || crate::windows::toggle_widget_layer(&app2));
            }
        }
    }

    /// 双击判定 + 空白桌面确认。每次左键按下都会调用，但重活（窗口类名、
    /// 跨进程命中测试）只在双击间隔内才执行；确认后清空上次按下，连点
    /// 三下只切换一次。
    fn maybe_desktop_double_click(sx: i32, sy: i32) -> bool {
        if !super::DESKTOP_DCLICK_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        let now = unsafe { windows::Win32::System::SystemInformation::GetTickCount64() };
        let (t0, x0, y0) = LAST_CLICK.with(|c| *c.borrow());
        let is_double =
            now.saturating_sub(t0) <= 500 && (sx - x0).abs() <= 10 && (sy - y0).abs() <= 10;
        LAST_CLICK.with(|c| *c.borrow_mut() = (now, sx, sy));
        is_double && click_on_blank_desktop(sx, sy)
    }

    /// 点击位置是否落在「空白桌面」上：
    /// 1) 点位下的顶层窗口必须是桌面（Progman / WorkerW）——排除一切普通
    ///    应用窗口（我们的层此刻在该点处于穿透态，WindowFromPoint 会跳过它）；
    /// 2) 桌面图标列表（SysListView32 属 explorer 进程）跨进程 LVM_HITTEST
    ///    排除点到图标的情况（DeskOrder 同款做法）。
    fn click_on_blank_desktop(sx: i32, sy: i32) -> bool {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::{
            FindWindowExW, GetAncestor, GetClassNameW, WindowFromPoint, GA_ROOT,
        };
        let pt = POINT { x: sx, y: sy };
        let under = unsafe { WindowFromPoint(pt) };
        if under.0.is_null() {
            return false;
        }
        let root = unsafe { GetAncestor(under, GA_ROOT) };
        if root.0.is_null() {
            return false;
        }
        let mut buf = [0u16; 16];
        let n = unsafe { GetClassNameW(root, &mut buf) } as usize;
        let class = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
        if class != "Progman" && class != "WorkerW" {
            return false;
        }
        // 图标列表：Progman/WorkerW → SHELLDLL_DefView → SysListView32。
        // 找不到（用户隐藏了桌面图标）视为空白。
        let defview_class = HSTRING::from("SHELLDLL_DefView");
        let list_class = HSTRING::from("SysListView32");
        let defview =
            unsafe { FindWindowExW(Some(root), None, &defview_class, None) }.unwrap_or_default();
        if defview.0.is_null() {
            return true;
        }
        let list =
            unsafe { FindWindowExW(Some(defview), None, &list_class, None) }.unwrap_or_default();
        if list.0.is_null() {
            return true;
        }
        !desktop_icon_at(list, pt)
    }

    /// 跨进程 LVM_HITTEST：SysListView32 属 explorer.exe，POINT/结果结构必须
    /// 写进对方进程再 SendMessageTimeout（ABORTIFHUNG：explorer 挂起时不能
    /// 拖死系统级鼠标钩子）。返回 true = 点到了某个图标上。
    fn desktop_icon_at(
        list: windows::Win32::Foundation::HWND,
        pt: windows::Win32::Foundation::POINT,
    ) -> bool {
        use windows::Win32::Foundation::{CloseHandle, LPARAM, WPARAM};
        use windows::Win32::System::Diagnostics::Debug::{ReadProcessMemory, WriteProcessMemory};
        use windows::Win32::System::Memory::{
            VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, PAGE_READWRITE,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowThreadProcessId, SendMessageTimeoutW, SMTO_ABORTIFHUNG,
        };

        /// 与 Win32 LVHITTESTINFO 二进制布局一致（x64 共 32 字节：pt 8、
        /// flags 4、iItem 4、iSubItem 4、填充 4、lParam 8）。手写定义避免
        /// 再开 Win32_UI_Controls feature。
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct LvHitTestInfo {
            x: i32,
            y: i32,
            flags: u32,
            i_item: i32,
            i_sub_item: i32,
            l_param: isize,
        }

        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(list, Some(&mut pid));
            if pid == 0 {
                return false;
            }
            let Ok(proc) = OpenProcess(
                PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE,
                false,
                pid,
            ) else {
                return false;
            };
            let remote = VirtualAllocEx(
                proc,
                None,
                std::mem::size_of::<LvHitTestInfo>(),
                MEM_COMMIT,
                PAGE_READWRITE,
            );
            if remote.is_null() {
                let _ = CloseHandle(proc);
                return false;
            }
            let info = LvHitTestInfo {
                x: pt.x,
                y: pt.y,
                flags: 0,
                i_item: -1,
                i_sub_item: 0,
                l_param: 0,
            };
            let mut written: usize = 0;
            let _ = WriteProcessMemory(
                proc,
                remote,
                &info as *const LvHitTestInfo as *const core::ffi::c_void,
                std::mem::size_of::<LvHitTestInfo>(),
                Some(&mut written),
            );
            // LVM_HITTEST = LVM_FIRST(0x1000) + 18。
            const LVM_HITTEST: u32 = 0x1000 + 18;
            let mut res: usize = 0;
            SendMessageTimeoutW(
                list,
                LVM_HITTEST,
                WPARAM(0),
                LPARAM(remote as isize),
                SMTO_ABORTIFHUNG,
                300,
                Some(&mut res),
            );
            let mut back = info;
            let mut read: usize = 0;
            let _ = ReadProcessMemory(
                proc,
                remote,
                &mut back as *mut LvHitTestInfo as *mut core::ffi::c_void,
                std::mem::size_of::<LvHitTestInfo>(),
                Some(&mut read),
            );
            let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
            let _ = CloseHandle(proc);
            back.i_item >= 0
        }
    }

    fn cursor_in_regions(regions: &[InteractiveRect], px: f64, py: f64) -> bool {
        regions
            .iter()
            .any(|r| px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)
    }

    /// Id of the topmost widget card under the point, if any.
    fn widget_under_point(regions: &[InteractiveRect], px: f64, py: f64) -> Option<String> {
        regions
            .iter()
            .filter(|r| r.id.is_some())
            .filter(|r| px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)
            .max_by_key(|r| r.z)
            .and_then(|r| r.id.clone())
    }

    /// Fallback used only if the low-level hook cannot be installed: keep a
    /// cursor poller so click-through still works. R6（审计）：10ms 无限轮询
    /// 持续吃 CPU/电，放宽到 50ms（几何兜底本就有 1.5s 刷新，感知差异极小）。
    fn start_poller_fallback(app: AppHandle) {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(50));
            unsafe {
                let mut pt: POINT = std::mem::zeroed();
                if GetCursorPos(&mut pt).is_ok() {
                    apply_event(&app, None, pt.x, pt.y);
                }
            }
        });
    }

    #[cfg(test)]
    mod hit_tests {
        use super::super::InteractiveRect;

        fn rect(x: f64, y: f64, w: f64, h: f64, id: Option<&str>, z: i32) -> InteractiveRect {
            InteractiveRect {
                x,
                y,
                w,
                h,
                id: id.map(|s| s.to_string()),
                z,
            }
        }

        /// E-1：命中测试边界语义——闭区间（含四条边），紧邻矩形外一点不命中。
        /// 钩子按物理坐标/缩放折算成视口 CSS 像素后与前端 gBCR 矩形比对，
        /// 边界必须同侧闭合，否则控件边缘 1px 悬空区点击穿透。
        #[test]
        fn cursor_in_regions_is_inclusive_on_edges() {
            let regions = vec![rect(10.0, 10.0, 20.0, 20.0, None, 0)];
            assert!(super::cursor_in_regions(&regions, 10.0, 10.0), "左上角含");
            assert!(super::cursor_in_regions(&regions, 30.0, 30.0), "右下角含");
            assert!(super::cursor_in_regions(&regions, 20.0, 15.0), "内部含");
            assert!(
                !super::cursor_in_regions(&regions, 9.999, 15.0),
                "左侧外不含"
            );
            assert!(
                !super::cursor_in_regions(&regions, 30.001, 15.0),
                "右侧外不含"
            );
            assert!(
                !super::cursor_in_regions(&regions, 20.0, 30.001),
                "下方外不含"
            );
            assert!(!super::cursor_in_regions(&[], 0.0, 0.0), "空集恒不命中");
        }

        /// 置顶语义：同点重叠多张卡时取 z 最大者（无 id 的普通控件矩形
        /// 不参与置顶竞争）；同 z 时任一即可（前端 z 单调，同 z 重叠属异常态）。
        #[test]
        fn widget_under_point_picks_topmost_z() {
            let regions = vec![
                rect(0.0, 0.0, 100.0, 100.0, Some("bottom"), 1),
                rect(0.0, 0.0, 100.0, 100.0, Some("top"), 42),
                rect(0.0, 0.0, 100.0, 100.0, None, 99),
            ];
            assert_eq!(
                super::widget_under_point(&regions, 50.0, 50.0).as_deref(),
                Some("top")
            );
            // 点在卡外：无置顶目标。
            assert_eq!(super::widget_under_point(&regions, 200.0, 50.0), None);
            // 只有无 id 控件命中：无置顶目标（穿透切换照常，只是不带卡）。
            let only_controls = vec![rect(0.0, 0.0, 10.0, 10.0, None, 5)];
            assert_eq!(super::widget_under_point(&only_controls, 5.0, 5.0), None);
        }
    }
}

#[cfg(not(windows))]
mod low_level_hook {
    use tauri::AppHandle;
    pub fn start(_app: AppHandle) {}
}

/// 事件驱动几何刷新（见 low_level_hook 内 R5 注释）；主线程窗口事件回调里调用。
#[cfg(windows)]
pub fn refresh_geometry_now(win: &tauri::WebviewWindow) {
    low_level_hook::refresh_geometry_now(win);
}

/// 事件驱动几何刷新的非 Windows 桩（见 windows 侧 R5 注释）。
#[cfg(not(windows))]
pub fn refresh_geometry_now(_win: &tauri::WebviewWindow) {}

/// Install the click-through handler. On Windows this uses an event-driven
/// low-level mouse hook (no polling); elsewhere it is a no-op.
pub fn start_click_through_poller(app: AppHandle) {
    low_level_hook::start(app);
}
