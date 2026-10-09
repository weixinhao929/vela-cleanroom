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

    // 整表替换改在写锁内构建新 HashMap 后**换新 Arc**——热路径（钩子
    // 回调，高刷下 1000Hz 的 move 事件）只 clone Arc 快照（O(1) 引用计数）
    // 后无锁扫描，不再在临界区里逐矩形比对。
    let mut guard = state
        .interactive_regions
        .write()
        .unwrap_or_else(|p| p.into_inner());
    let mut next: std::collections::HashMap<String, Vec<InteractiveRect>> = (**guard).clone();
    replace_regions(&mut next, window.label(), regions);
    *guard = std::sync::Arc::new(next);
}

/// 抽出的纯函数接缝：按窗口标签**整表替换**命中矩形（不是合并/追加——
/// 前端每轮全量上报，旧矩形必须整体作废，否则消失的控件会留下吃点击的
/// 幽灵区）；空数组等价清空该窗口。抽出来供内联测试锚定语义。
/// 替换时顺带滤掉非法矩形（NaN/非有限/非正宽高）——前端 gBCR 在布局
/// 抖动瞬间可能产出 0 或 NaN 尺寸，0×N 矩形永不命中纯属热路径白扫，NaN
/// 参与比较结果恒 false 更是未定义行为的温床，一律不进命中表。
fn replace_regions(
    map: &mut std::collections::HashMap<String, Vec<InteractiveRect>>,
    label: &str,
    regions: Vec<InteractiveRect>,
) {
    let sanitized: Vec<InteractiveRect> = regions
        .into_iter()
        .filter(|r| r.w.is_finite() && r.h.is_finite() && r.w > 0.0 && r.h > 0.0)
        .collect();
    map.insert(label.to_string(), sanitized);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// set_interactive_regions 的核心语义守卫——整表替换（不是并集）。
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

    /// 非法矩形（NaN/非有限/非正**宽高**）在整表替换时被过滤，不进命中
    /// 表。x/y 为 NaN 不在过滤面内——命中比较对 NaN 恒 false，这类矩形天然
    /// 永不命中（无害），过滤谓词保持最小。
    #[test]
    fn replace_regions_filters_degenerate_rects() {
        let mut map = std::collections::HashMap::new();
        replace_regions(
            &mut map,
            "widget-0",
            vec![
                rect(0.0, 0.0, f64::NAN, 10.0),
                rect(0.0, 0.0, 10.0, f64::NAN),
                rect(0.0, 0.0, 0.0, 10.0),
                rect(0.0, 0.0, 10.0, -1.0),
                rect(0.0, 0.0, f64::INFINITY, 10.0),
                rect(5.0, 5.0, 10.0, 10.0),
            ],
        );
        let list = &map["widget-0"];
        assert_eq!(list.len(), 1, "只剩合法矩形");
        assert_eq!(list[0].x, 5.0);
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
    // Mutex<bool> → AtomicBool——钩子热路径每条鼠标事件都要读它，
    // 无锁 load。独立布尔标志无跨字段顺序约束，Relaxed 足够（与
    // DESKTOP_DCLICK_ENABLED 同款）。
    state
        .edit_mode
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    // The widget layer is always interactive (no click-through) — the webview
    // receives every mouse event, so we only flip the internal flag here.
    let _ = app.emit("widget:edit-mode", enabled);
    Ok(())
}

/// 双击空白桌面切换小组件层显隐的手势开关（默认开）。
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
            if enabled {
                // 置顶与沉底是 tao 的两个独立标志且不互斥——widget 窗口
                // 出厂 always_on_bottom（monitor.rs 建窗），tao 在每次
                // WM_WINDOWPOSCHANGING 都把沉底窗口压回 HWND_BOTTOM，只调
                // set_always_on_top(true) 的话置顶永远不生效。必须先清沉底
                // 再置顶（windows.rs summon_palette_window 的正确示范）。
                let _ = w.set_always_on_bottom(false);
                let _ = w.set_always_on_top(true);
            } else {
                let _ = w.set_always_on_top(false);
                // 置顶与沉底是互斥的 z 序模式：关掉置顶必须把窗口送回桌面层，
                // 否则它停在普通窗口 band 里，既不在顶也不贴壁纸。
                let _ = w.set_always_on_bottom(true);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_widget_state(
    window: tauri::Window,
    state: tauri::State<AppState>,
) -> Result<WidgetState, String> {
    // 编辑模式/置顶等层状态仅本应用窗口可读。
    crate::require_trusted(&window)?;
    Ok(WidgetState {
        // AtomicBool 无锁读（见 set_edit_mode 注释）。
        edit_mode: state.edit_mode.load(std::sync::atomic::Ordering::Relaxed),
        always_on_top: *state
            .always_on_top
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
    })
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
    /// LAST_MOVE 的值类型（见下方注释）。
    type LastMove = (usize, usize, i32, i32, bool);
    thread_local! {
        static HOOK_APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
        static PREV_INTERACTIVE: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
        /// 上次左键按下（GetTickCount64 毫秒 + 物理坐标），
        /// 用于双击判定（500ms / 10px，Windows 默认双击阈值）。
        static LAST_CLICK: RefCell<(u64, i32, i32)> = const { RefCell::new((0, i32::MIN, i32::MIN)) };
        /// move 节流状态（label → (regions 快照 Arc 指针, geometry 快照
        /// Arc 指针, 上次物理坐标, 上次编辑模式)）。两个 Arc 指针同一 = 矩形
        /// 表与窗口几何（含可见性）都没被换过；配合 ≤1px 位移即可断定本次
        /// 命中结论与上次一致（穿透态翻转只取决于区域进出）。
        static LAST_MOVE: RefCell<HashMap<String, LastMove>> = RefCell::new(HashMap::new());
    }

    /// 双击空白桌面的候选通道。钩子回调只做廉价的双击间隔/位移判定
    /// （GetTickCount64 + thread-local），判定为第二次按下时把候选点发到
    /// 这里；跨进程确认（OpenProcess/WriteProcessMemory/
    /// SendMessageTimeoutW 最长 300ms/ReadProcessMemory——explorer 忙时吃满
    /// LowLevelHooksTimeout 量程，Windows 会静默摘钩）全部挪到 start() 创建的
    /// 专用工作线程，确认命中再经 run_on_main_thread 切换小组件层。判定与
    /// 触发语义不变，只有确认动作异步化。
    static DESKTOP_DCLICK_TX: OnceLock<std::sync::mpsc::Sender<(i32, i32)>> = OnceLock::new();

    /// Widget window geometry: (origin_x, origin_y, w, h, scale_factor, visible)。
    /// visible：层收起（toggle/托盘 hide/关闭转隐藏）后窗口虽在，命中
    /// 判定要跳过它——已收起的 regions 不能再吃点击、挡住双击空白桌面手势；
    /// 但 geometry 保留（双击唤回手势靠它定位所在屏，重显路径会重采翻回）。
    type WindowGeometry = (i32, i32, i32, i32, f64, bool);
    /// `RwLock<Arc<HashMap>>` 快照读。钩子热路径不再整表 clone（堆分配），
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
    ///
    /// 采集时顺带 `is_visible()`——隐藏窗口的 geometry 带 visible=false，
    /// apply_event 跳过其命中/置顶（见 WindowGeometry 注释）。regions 的清理
    /// 键按「窗口是否存在」而不是「是否可见」：层收起再重显不伴随 DOM 变化，
    /// 前端不会重报矩形，按可见性清 regions 会让重显后的层永久失去点击命中。
    fn refresh_geometry(app: &AppHandle) {
        let mut fresh: HashMap<String, WindowGeometry> = HashMap::new();
        let mut live: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (label, w) in app.webview_windows() {
            if !label.starts_with("widget-") {
                continue;
            }
            live.insert(label.clone());
            if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
                let scale = w.scale_factor().unwrap_or(1.0);
                // 查询失败按可见处理（保守：宁可多一次无效判定，不漏真实命中）。
                let visible = w.is_visible().unwrap_or(true);
                fresh.insert(
                    label,
                    (p.x, p.y, s.width as i32, s.height as i32, scale, visible),
                );
            }
        }
        let state = app.state::<AppState>();
        {
            // 写侧（本函数 + set_interactive_regions）构建新 HashMap 换新
            // Arc，读侧持旧快照继续无锁扫描。
            let mut guard = state
                .interactive_regions
                .write()
                .unwrap_or_else(|p| p.into_inner());
            if guard.keys().any(|k| !live.contains(k)) {
                let mut next = (**guard).clone();
                next.retain(|k, _| live.contains(k));
                *guard = Arc::new(next);
            }
        }
        *geometry_cache().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(fresh);
    }

    const HEARTBEAT_MS: u32 = 60_000;

    /// 事件驱动的几何刷新入口（monitor.rs 的窗口 Moved/Resized/Destroyed
    /// 回调在主线程上调用）。同线程采集没有跨线程 IPC 往返，代价即三个
    /// getter；30s 兜底轮询照旧覆盖未伴随窗口事件的漂移。
    pub fn refresh_geometry_now(win: &tauri::WebviewWindow) {
        refresh_geometry(win.app_handle());
    }

    /// 主线程重采全部 widget 窗口几何（含可见性标记）。显隐切换路径
    /// （toggle/show/托盘/关闭转隐藏/set_monitor）调用——隐藏窗口不参与
    /// 命中后，重显必须立即恢复命中，不能等 30s 兜底刷新。必须在主线程调
    ///（is_visible 等窗口 getter 的跨线程调用是同步等待）。
    pub fn refresh_geometry_all(app: &AppHandle) {
        refresh_geometry(app);
    }

    pub fn start(app: AppHandle) {
        // Prime the cache on the main thread (cheap, no cross-thread IPC) so
        // the hook has geometry from its very first event.
        refresh_geometry(&app);

        // 双击空白桌面确认工作线程（见 DESKTOP_DCLICK_TX 注释）。进程
        // 生命期常驻；带 panic 防护——确认逻辑炸了只丢这一次候选，线程继续
        // 服务（否则通道断开、手势从此静默失效）。
        let (tx, rx) = std::sync::mpsc::channel::<(i32, i32)>();
        let _ = DESKTOP_DCLICK_TX.set(tx);
        let confirm_app = app.clone();
        std::thread::spawn(move || {
            while let Ok((sx, sy)) = rx.recv() {
                let confirmed = catch_unwind(AssertUnwindSafe(|| click_on_blank_desktop(sx, sy)))
                    .unwrap_or(false);
                if confirmed {
                    let app2 = confirm_app.clone();
                    let _ = confirm_app
                        .run_on_main_thread(move || crate::windows::toggle_widget_layer(&app2));
                }
            }
        });

        // Low-frequency geometry refresher — 起降为 30s 兜底：几何变化的主
        // 通道是 widget 窗口的 Moved/Resized/Destroyed 事件（主线程直采），
        // 拓扑重排也必然伴随窗口 Moved。钩子热路径依旧只读缓存。
        let refresher_app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            // refresh_geometry 直调 outer_position/outer_size/is_visible 是
            // 跨线程同步等待（tao 的 getter 要主线程回包）——主线程被备份/
            // 解析卡住时这里同步排队、节拍漂移。改投递到主线程执行（与
            // Moved/Resized 事件同通道）；投递失败只发生在 app 退出期，退出。
            let tick_app = refresher_app.clone();
            if refresher_app
                .run_on_main_thread(move || {
                    if catch_unwind(AssertUnwindSafe(|| refresh_geometry(&tick_app))).is_err() {
                        log::error!("widget geometry refresher panicked; retrying next tick");
                    }
                })
                .is_err()
            {
                break;
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

                // hWnd=NULL 时 Win32 忽略 nIDEvent 参数、返回**系统分配**
                // 的新 timer id——此前丢弃返回值、拿自拟常量比对 wParam 永不
                // 成立，自愈心跳从未真正触发（死代码）。保存返回值用于
                // WM_TIMER 判定与 KillTimer；0 = SetTimer 失败（极罕见），
                // 跳过心跳判定即可（钩子照常工作，只是失去自愈）。
                let heartbeat_timer: usize = SetTimer(None, 0, HEARTBEAT_MS, None);
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
                    if heartbeat_timer != 0
                        && msg.message == WM_TIMER
                        && msg.wParam.0 == heartbeat_timer
                    {
                        let _ = UnhookWindowsHookEx(hook);
                        match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) {
                            Ok(h) => hook = h,
                            Err(_) => {
                                log::warn!(
                                    "WH_MOUSE_LL reinstall failed; falling back to 10ms cursor polling"
                                );
                                let _ = KillTimer(None, heartbeat_timer);
                                start_poller_fallback(app);
                                break;
                            }
                        }
                        continue; // timer handled; nothing to dispatch
                    }
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                }
                if heartbeat_timer != 0 {
                    let _ = KillTimer(None, heartbeat_timer);
                }
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
        // edit_mode 无锁读（AtomicBool）；geometry / regions 都是
        // RwLock<Arc<…>> 快照 clone（O(1) 引用计数），扫描全部在锁外——此前
        // 每条鼠标事件（高刷下 1000Hz 的 move）锁两把 Mutex 且在临界区内
        // 整表扫描。
        let edit_mode = state.edit_mode.load(std::sync::atomic::Ordering::Relaxed);
        let geometry = geometry_cache()
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let geometry_ptr = Arc::as_ptr(&geometry) as usize;
        let regions = state
            .interactive_regions
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let regions_ptr = Arc::as_ptr(&regions) as usize;
        let is_press = msg == Some(WM_LBUTTONDOWN);
        for (label, &(ox, oy, w, h, scale, visible)) in geometry.iter() {
            // Skip screens the cursor isn't currently over; keep their state
            // as-is (they will be re-evaluated once the cursor enters).
            if sx < ox || sx >= ox + w || sy < oy || sy >= oy + h {
                continue;
            }

            // 隐藏窗口不参与命中——不翻转穿透态、不做矩形命中与置顶
            //（层已收起，它的 regions 此刻不能再吃点击、挡双击）。但双击空白
            // 桌面手势仍要识别：隐藏窗口不拦截任何输入，落在其屏幕区域的
            // 空白处同样直达桌面，这正是层收起后的唤回路径。
            if !visible {
                if is_press && !edit_mode {
                    record_desktop_double_click(sx, sy);
                }
                LAST_MOVE.with(|c| {
                    c.borrow_mut().insert(
                        label.clone(),
                        (regions_ptr, geometry_ptr, sx, sy, edit_mode),
                    );
                });
                continue;
            }

            // 纯 move 节流。穿透态翻转只取决于「点在不在矩形里」；矩形
            // 表（regions Arc 指针）与窗口几何/可见性（geometry Arc 指针）都
            // 没换、编辑模式没翻且位移 ≤1px 时，命中结论必然与上次一致（唯一
            // 分歧在恰好跨矩形边界的亚像素位移，下一次移动即纠正），直接短路
            // 整轮扫描。按下事件从不节流——置顶与双击判定都挂在它上。
            if !is_press
                && LAST_MOVE.with(|c| {
                    c.borrow()
                        .get(label.as_str())
                        .is_some_and(|&(r, g, x, y, edit)| {
                            r == regions_ptr
                                && g == geometry_ptr
                                && edit == edit_mode
                                && (sx - x).abs() <= 1
                                && (sy - y).abs() <= 1
                        })
                })
            {
                continue;
            }

            let px = (sx as f64 - ox as f64) / scale;
            let py = (sy as f64 - oy as f64) / scale;
            let rects: &[InteractiveRect] = regions
                .get(label.as_str())
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let hit = edit_mode || cursor_in_regions(rects, px, py);
            let top = if is_press && !edit_mode && hit {
                widget_under_point(rects, px, py)
            } else {
                None
            };
            LAST_MOVE.with(|c| {
                c.borrow_mut().insert(
                    label.clone(),
                    (regions_ptr, geometry_ptr, sx, sy, edit_mode),
                );
            });

            let prev = PREV_INTERACTIVE.with(|c| c.borrow().get(label.as_str()).copied());
            if prev != Some(hit) {
                PREV_INTERACTIVE.with(|c| {
                    c.borrow_mut().insert(label.clone(), hit);
                });
                if let Some(window) = app.get_webview_window(label.as_str()) {
                    // Fire-and-forget: run_on_main_thread only posts the closure
                    // to the main event loop; calling set_ignore_cursor_events
                    // synchronously here would block the hook on a main-thread
                    // round-trip (the exact stall LowLevelHooksTimeout punishes).
                    let _ = app.run_on_main_thread(move || {
                        let _ = window.set_ignore_cursor_events(!hit);
                    });
                }
            }

            if let Some(id) = top {
                // 置顶事件定向到所在屏的 webview——循环里已有 label，广播
                // 会让每条屏都为别人的点击白解析一遍载荷。
                let _ = app.emit_to(label.as_str(), "widget:bring-to-front", id);
            }

            // 左键按下且该点不属于任何交互区（点击将直达
            // 桌面）时记录双击候选；确认线程核实「空白桌面」后经主线程切换
            // 小组件层显隐（跨进程确认的重活不在钩子回调里做，判定
            // 阈值与触发条件不变）。编辑模式下画布接管全部输入，不参与。
            if is_press && !edit_mode && !hit {
                record_desktop_double_click(sx, sy);
            }
        }
    }

    /// 双击判定（廉价：GetTickCount64 + thread-local 位移比对，进程内零重活，
    /// 可安全留在钩子回调里）。判定为第二次按下时把候选点发给确认线程
    /// （DESKTOP_DCLICK_TX），确认结果驱动的 toggle 见 start() 里的工作线程。
    fn record_desktop_double_click(sx: i32, sy: i32) {
        if !super::DESKTOP_DCLICK_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let now = unsafe { windows::Win32::System::SystemInformation::GetTickCount64() };
        let (t0, x0, y0) = LAST_CLICK.with(|c| *c.borrow());
        let is_double =
            now.saturating_sub(t0) <= 500 && (sx - x0).abs() <= 10 && (sy - y0).abs() <= 10;
        LAST_CLICK.with(|c| *c.borrow_mut() = (now, sx, sy));
        if is_double {
            if let Some(tx) = DESKTOP_DCLICK_TX.get() {
                let _ = tx.send((sx, sy));
            }
        }
    }

    /// 点击位置是否落在「空白桌面」上：
    /// 1) 点位下的顶层窗口必须是桌面（Progman / WorkerW）——排除一切普通
    ///    应用窗口（我们的层此刻在该点处于穿透态，WindowFromPoint 会跳过它）；
    /// 2) 桌面图标列表（SysListView32 属 explorer 进程）跨进程 LVM_HITTEST
    ///    排除点到图标的情况。
    ///
    /// 本函数（含 desktop_icon_at 的跨进程调用链）只在专用确认线程上
    /// 执行，绝不回到钩子回调。
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
    /// cursor poller so click-through still works. ：10ms 无限轮询
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

        /// 命中测试边界语义——闭区间（含四条边），紧邻矩形外一点不命中。
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

/// 事件驱动几何刷新（见 low_level_hook 内 注释）；主线程窗口事件回调里调用。
#[cfg(windows)]
pub fn refresh_geometry_now(win: &tauri::WebviewWindow) {
    low_level_hook::refresh_geometry_now(win);
}

/// 事件驱动几何刷新的非 Windows 桩（见 windows 侧 注释）。
#[cfg(not(windows))]
pub fn refresh_geometry_now(_win: &tauri::WebviewWindow) {}

/// 显隐切换路径的主线程全量重采（含可见性标记，见 low_level_hook 内
/// refresh_geometry 注释）——隐藏窗口不参与命中后，重显必须立即恢复命中。
#[cfg(windows)]
pub fn refresh_geometry_all(app: &AppHandle) {
    low_level_hook::refresh_geometry_all(app);
}

/// refresh_geometry_all 的非 Windows 桩（见 windows 侧注释）。
#[cfg(not(windows))]
pub fn refresh_geometry_all(_app: &AppHandle) {}

/// Install the click-through handler. On Windows this uses an event-driven
/// low-level mouse hook (no polling); elsewhere it is a no-op.
pub fn start_click_through_poller(app: AppHandle) {
    low_level_hook::start(app);
}
