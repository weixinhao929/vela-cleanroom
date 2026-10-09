//! 窗口辅助：widget 层窗口枚举、设置窗口唤起、全局速记窗口、命令面板全局呼出编排。
//! 从 lib.rs 拆出，供托盘、全局快捷键与 setup 共用。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{Listener, Manager};

/// All widget-layer windows (one transparent full-screen window per monitor).
/// The settings window ("settings") is excluded.
pub fn all_widget_windows(app: &tauri::AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("widget-"))
        .map(|(_, w)| w)
        .collect()
}

/// 显示/隐藏小组件层：任一桌面窗口可见则全部隐藏，否则全部显示。
/// Ctrl+Alt+D 全局快捷键与 `--toggle-layer` 命令面共用同一行为。
///
/// 显隐编排（层显隐淡入淡出）：隐藏前向每个桌面 WebView 发 `layer:fade-out`
/// （前端挂 `.layer-vanishing` 播 ~180ms 淡出，见 `src/lib/layer-fade.ts`），
/// 到点无条件 hide——WebView 无响应时只是退化为原有瞬时隐藏；显示时先 show
/// 再发 `layer:fade-in`，此刻呈现的正是隐藏前的透明末帧，前端播 keyframes
/// 淡入还原。reduce-motion 由前端全局 0.001s 压缩兜底，无需 Rust 感知。
pub fn toggle_widget_layer(app: &tauri::AppHandle) {
    let windows = all_widget_windows(app);
    let any_visible = windows.iter().any(|w| w.is_visible().unwrap_or(false));
    if !any_visible {
        for w in &windows {
            let _ = w.show();
        }
        // 显隐翻转即重采几何——隐藏窗口不参与命中（widget.rs 的 visible
        // 标记），重显必须当场恢复点击命中，不能等 30s 兜底。toggle 的全部
        // 调用方（快捷键/CLI/命令/双击确认的 run_on_main_thread）都在主线程。
        crate::widget::refresh_geometry_all(app);
        for w in &windows {
            let _ = tauri::Emitter::emit_to(app, w.label(), "layer:fade-in", ());
        }
        return;
    }
    for w in &windows {
        let _ = tauri::Emitter::emit_to(app, w.label(), "layer:fade-out", ());
    }
    // spawn 前 bump 代际，淡出线程到点校验——快速连按显隐热键时，
    // 旧 fade 线程不再把「刚 show 回来的层」再 hide 掉。
    let gen = LAYER_FADE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(layer_fade_hide_after_ms()));
        if LAYER_FADE_GENERATION.load(std::sync::atomic::Ordering::Acquire) != gen {
            return; // 已有更新的 toggle：本次 hide 作废。
        }
        for w in all_widget_windows(&handle) {
            let _ = w.hide();
        }
        // 淡出线程上的 hide 完成后重采几何（隐藏窗口不参与命中）。本线程
        // 不是主线程，投递执行。
        let tick = handle.clone();
        let _ = handle.run_on_main_thread(move || crate::widget::refresh_geometry_all(&tick));
    });
}

/// 层显隐编排代际：每次 toggle_widget_layer 递增，旧淡出线程据此自杀。
static LAYER_FADE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 淡出播完再 hide 的保底等待时间：略长于前端标准档淡出（--dur-fx 200ms），
/// 留出事件分发与首帧余量。此前裸 hide() 是整层一帧瞬隐/瞬现，观感突兀。
const LAYER_FADE_HIDE_AFTER_MS: u64 = 240;

/// 前端上报的当前速度档层淡出时长（--dur-fx 毫秒；0 = 未上报）。
/// 设置→动效速度档变化时由 theme-engine.applySettings 推送（set_layer_fade_ms）。
static LAYER_FADE_FX_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 实际 hide 等待 = max(保底 240, 前端淡出 + 40ms 余量)：速度档调慢后 --dur-fx
/// 变长，恒定 240ms 会把淡出从中间掐断；保底下限不变——WebView 无响应时仍
/// 退化为瞬时隐藏，绝不会藏不掉。
fn layer_fade_hide_after_ms() -> u64 {
    use std::sync::atomic::Ordering;
    let fx = LAYER_FADE_FX_MS.load(Ordering::Relaxed);
    if fx == 0 {
        LAYER_FADE_HIDE_AFTER_MS
    } else {
        LAYER_FADE_HIDE_AFTER_MS.max(fx + 40)
    }
}

/// 前端（theme-engine）在速度档应用后上报当前 --dur-fx 毫秒数。
/// 挂受信窗口闸门 + 钳 0..=2000——此前无闸门且 u64 未钳制，被注入的
/// 远程页可上报 u64::MAX 让层隐藏近乎无限延迟。
#[tauri::command]
pub fn set_layer_fade_ms(window: tauri::Window, ms: u64) -> Result<(), String> {
    crate::require_trusted(&window)?;
    use std::sync::atomic::Ordering;
    LAYER_FADE_FX_MS.store(ms.min(2000), Ordering::Relaxed);
    Ok(())
}

/// 确保小组件层可见：隐藏则全部显示；已可见不动，从不隐藏（与 toggle 语义区分）。
pub fn show_widget_layer(app: &tauri::AppHandle) {
    for w in all_widget_windows(app) {
        if !w.is_visible().unwrap_or(false) {
            let _ = w.show();
        }
    }
    // 有窗口从隐藏翻显（或不确定）就重采几何——同 toggle_widget_layer
    // 的理由，重显后立即恢复点击命中。调用方（快捷键 handler/命令面板编排）
    // 都在主线程。
    crate::widget::refresh_geometry_all(app);
}

/// 全局呼出命令面板期间对主窗口做的临时编排，面板关闭时按此撤销。
struct PaletteSummon {
    /// 呼出前的前台窗口原生句柄：面板关闭后把前台还给它（Spotlight 语义）。
    prev_foreground: isize,
    /// 是否把 widget-0 从沉底临时改成了置顶（用户本就开着置顶时不动 z 序）。
    raised: bool,
}

static PALETTE_SUMMON: Mutex<Option<PaletteSummon>> = Mutex::new(None);

/// 全局呼出命令面板（Ctrl+Alt+K / `--toggle-palette`）前的窗口编排：
/// 1. 隐藏的层先全部显示；
/// 2. 主窗口 widget-0 临时置顶——层窗口默认 always_on_bottom，tao 在每次
///    WM_WINDOWPOSCHANGING 都把它压回 HWND_BOTTOM，仅 set_focus 只拿到键盘焦点、
///    z 序不变，面板会被前台应用整个挡住；置顶与沉底两个标志在 tao 里不互斥，
///    必须先清沉底再置顶；
/// 3. 聚焦 widget-0——层建窗时 `focused(false)`，其他应用在前台时面板输入框
///    打不进字、Esc 也落到别的窗口。
///
/// 面板已开时再按一次（切换关闭）不重复记录，撤销以第一次呼出时的状态为准。
pub fn summon_palette_window(app: &tauri::AppHandle) {
    show_widget_layer(app);
    let Some(primary) = app.get_webview_window("widget-0") else {
        return;
    };
    {
        let mut guard = PALETTE_SUMMON.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            let prefers_top = app
                .try_state::<crate::AppState>()
                .map(|s| s.always_on_top_enabled())
                .unwrap_or(false);
            if !prefers_top {
                let _ = primary.set_always_on_bottom(false);
                let _ = primary.set_always_on_top(true);
            }
            *guard = Some(PaletteSummon {
                prev_foreground: foreground_window_handle(),
                raised: !prefers_top,
            });
        }
    }
    let _ = primary.set_focus();
}

/// 面板关闭后的撤销（前端 primary 窗口发 `command-palette:closed` 驱动）：把
/// widget-0 送回沉底、前台还给呼出前的应用。窗口内 Ctrl+K 打开的面板没有编排
/// 记录，此处 no-op。
pub fn release_palette_window(app: &tauri::AppHandle) {
    let Some(summon) = PALETTE_SUMMON
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    else {
        return;
    };
    if summon.raised {
        if let Some(primary) = app.get_webview_window("widget-0") {
            // 关掉置顶后仍要显式送回沉底，否则窗口停在普通窗口 band 里浮在
            // 桌面上（与 widget.rs::set_always_on_top 同款处理）。
            let _ = primary.set_always_on_top(false);
            let _ = primary.set_always_on_bottom(true);
        }
    }
    restore_foreground_window(summon.prev_foreground);
}

#[cfg(windows)]
fn foreground_window_handle() -> isize {
    // SAFETY: GetForegroundWindow 只读查询，返回当前前台窗口句柄或 null。
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize }
}

#[cfg(not(windows))]
fn foreground_window_handle() -> isize {
    0
}

#[cfg(windows)]
fn restore_foreground_window(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    if hwnd == 0 {
        return;
    }
    let hwnd = HWND(hwnd as *mut std::ffi::c_void);
    // SAFETY: 句柄可能已失效（对方应用已关闭），先 IsWindow 校验；
    // SetForegroundWindow 被拒绝时只是不还前台，无其它副作用。
    unsafe {
        if IsWindow(Some(hwnd)).as_bool() {
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(not(windows))]
fn restore_foreground_window(_hwnd: isize) {}

/// 设置窗的唯一创建路径（原 tauri.conf.json 静态窗口挪成 builder：关窗
/// 即销毁后，重建必须走与首建完全相同的参数，静态配置 + builder 两处定义
/// 会漂移）。所有唤起方（托盘/快捷键/CLI/启动）都经 show_settings_window
/// 到这里，不存在别的创建点。
pub fn create_settings_window(
    app: &tauri::AppHandle,
) -> Result<tauri::WebviewWindow, tauri::Error> {
    let win = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("index.html#/settings".into()),
    )
    .title("Vela")
    .inner_size(1040.0, 720.0)
    .min_inner_size(760.0, 520.0)
    .center()
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .skip_taskbar(false)
    .resizable(true)
    .maximizable(true)
    .visible(false)
    .build()?;
    // [ANTICAPTURE]：开关开启时出生即带防截屏属性。
    crate::anticapture::apply_if_enabled(&win);
    // 关闭 = 销毁（renderer 随之释放，约省一个 WebView2 渲染进程的
    // 常驻内存）。例外：本窗已是最后一个窗口时只隐藏——全部窗口销毁会触发
    // ExitRequested(code=None)，与「注销/关机会话结束」无法区分，prevent_exit
    // 会把应用挂进「阻止关机」名单（见 lib.rs run-loop 注释），保持常驻
    // 语义必须永远留一个活窗口。
    let close_win = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let app = close_win.app_handle();
            let others = app
                .webview_windows()
                .into_iter()
                .filter(|(label, _)| label != "settings")
                .count();
            if others == 0 {
                api.prevent_close();
                let _ = close_win.hide();
                log::info!("settings is the last window; hidden instead of destroyed");
            } else {
                log::info!("settings window closed; destroying webview (P0 lazy recreate)");
                // 不 prevent_close：默认关闭路径即销毁窗口。
            }
        }
    });
    Ok(win)
}

/// -b：仅首次运行弹设置窗。判定用 settings 表的哨兵键（首次落库后永存），
/// 不依赖视图/布局键——它们只在用户编辑后才写，无法区分「新用户」与
/// 「装了但没动过布局的用户」。标记写失败只是下次启动再弹一次，无害。
const BOOT_SETTINGS_SEEN_KEY: &str = "boot:settings-shown";

pub fn show_settings_on_first_boot(app: &tauri::AppHandle) {
    let first_run = match app.try_state::<crate::AppState>() {
        Some(state) => match state.read_db.acquire() {
            Ok(conn) => crate::repositories::SettingsRepo::get(&conn, BOOT_SETTINGS_SEEN_KEY)
                .ok()
                .flatten()
                .is_none(),
            Err(_) => true,
        },
        None => true,
    };
    if !first_run {
        log::info!("boot: not first run — starting in tray + widget layer only");
        return;
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(conn) = crate::db::lock_db(&state.db) {
            if let Err(e) =
                crate::repositories::SettingsRepo::set(&conn, BOOT_SETTINGS_SEEN_KEY, "1")
            {
                log::warn!("persisting boot-seen flag failed: {e}");
            }
        }
    }
    show_settings_window(app);
}

/// 超时兜底（就绪握手）：设置/速记窗 visible(false) 创建后由前端首帧
/// 自行显示（main.tsx 握手）；前端崩溃或事件路径失效时窗口会永不出现——
/// 这里在超时后检查仍未可见则强制显示。窗口已销毁则 no-op。
pub(crate) fn spawn_show_fallback(app: &tauri::AppHandle, label: &str, timeout_ms: u64) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(timeout_ms));
        if let Some(w) = app.get_webview_window(&label) {
            if !w.is_visible().unwrap_or(true) {
                log::warn!("window {label} not ready in {timeout_ms}ms; forcing show");
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    });
}

/// 唤起设置窗口：托盘左键、托盘菜单、Ctrl+Alt+S、CLI `--settings` 与启动
/// 共用同一行为。后设置窗不再常驻：关闭即销毁，唤起时约 1s 冷启动重建。
/// 冷启动：窗口 visible(false) 创建，等前端首帧就绪握手（main.tsx
/// 自行 show）后再出现——此前 build() 返回即 show()，WebView 尚未加载，
/// 透明+阴影窗口先以一块空影出现再闪进闪屏。热路径（窗口仍在）立即显示。
pub fn show_settings_window(app: &tauri::AppHandle) {
    let window = match app.get_webview_window("settings") {
        Some(w) => w,
        None => match create_settings_window(app) {
            Ok(_) => {
                spawn_show_fallback(app, "settings", 3000);
                return;
            }
            Err(e) => {
                log::error!("recreating settings window failed: {e}");
                return;
            }
        },
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 全局速记：已存在则置前，否则创建一个无边框置顶小窗（前端
/// index.html#quick-note）。
///
/// 落屏跟随鼠标：多屏用户在副屏工作时 `Ctrl+Alt+Q` 应弹在当前屏，而不是
/// 固定主屏（屏坐标跨屏距离可能很远）。取光标所在显示器，失败回主屏；
/// 再失败回固定坐标。
pub fn show_or_create_quick_note(app: &tauri::AppHandle) {
    match app.get_webview_window("quick-note") {
        Some(w) => {
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => {
            let (w, h) = (380.0, 230.0);
            let monitor = app
                .cursor_position()
                .ok()
                .and_then(|pos| app.monitor_from_point(pos.x, pos.y).ok().flatten())
                .or_else(|| app.primary_monitor().ok().flatten());
            // 混合 DPI 下逻辑坐标会被创建期的主屏 scale 错误回乘——
            // 先算物理居中点，建窗后（visible(false) 期间）用物理坐标精确落位。
            let phys_center = monitor.as_ref().map(|m| {
                let size = m.size();
                let pos = m.position();
                (
                    pos.x as f64 + size.width as f64 / 2.0,
                    pos.y as f64 + size.height as f64 / 2.0,
                )
            });
            let (x, y) = phys_center.unwrap_or((430.0, 430.0));
            let built = tauri::WebviewWindowBuilder::new(
                app,
                "quick-note",
                tauri::WebviewUrl::App("index.html#quick-note".into()),
            )
            .title("速记")
            .inner_size(w, h)
            .position(240.0, 240.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            // 就绪握手：首帧前不显示（此前瞬现），前端就绪后自行 show +
            // 入场动画；超时由 spawn_show_fallback 兜底。
            .visible(false)
            .build();
            // 物理落位：逻辑尺寸 (w,h) × 目标屏 scale = 物理尺寸，中心对齐。
            if let Ok(win) = &built {
                if let Some(m) = &monitor {
                    let scale = m.scale_factor();
                    let px = x - w * scale / 2.0;
                    let py = y - h * scale / 2.0 - 80.0 * scale;
                    let _ = win.set_position(tauri::PhysicalPosition::new(
                        px.round() as i32,
                        py.round() as i32,
                    ));
                    let _ = win.set_size(tauri::PhysicalSize::new(
                        (w * scale).round() as u32,
                        (h * scale).round() as u32,
                    ));
                }
            }
            if let Err(e) = built {
                log::warn!("failed to open quick-note window: {e}");
            } else {
                if let Ok(w) = &built {
                    crate::anticapture::apply_if_enabled(w);
                }
                spawn_show_fallback(app, "quick-note", 3000);
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* [FULLSCREEN] 全屏展示窗：投影/课堂用大字   */
/* 时钟、倒计时、番茄钟。覆盖光标所在显示器，真全屏无边框；已存在则先关     */
/* 重建（换显示器 / 换模式都走同一条路径）。Esc / 双击退出由前端处理。     */
/* ------------------------------------------------------------------ */

/// 全屏展示支持的模式（命令参数白名单，单测覆盖）。 */
pub const FULLSCREEN_KINDS: [&str; 3] = ["clock", "countdown", "pomodoro"];

/* ------------------ ：全屏窗就绪看门狗 ------------------
 * 全屏专注窗的退出完全依赖前端 JS（FullscreenView 的 Esc/双击监听）：WebView
 * 假死 / chunk 加载失败时，3s 兜底（spawn_show_fallback）只会把这扇无装饰真
 * 全屏窗强制显示出来，用户被困（唯一系统级出口 Alt+）。这里在建窗点武装
 * 看门狗：12s 内未收到该代窗口的前端 ready ack → 判定 WebView 不可用 → 关闭
 * 全屏窗并 log warn（用户回到桌面而不是被困）；收到 ack 即失效。正常加载的
 * 窗口在首帧握手时回 ack，完全无感。
 *
 * 代数（generation）设计：每次建窗自增武装代数并注入 URL，前端 ack 原样回
 * 传。复用路径（关旧窗立即重建）下两个竞态都被代数消解——旧窗迟到的 ack 因
 * 代数更小永远追不上新武装；旧看门狗触发时发现武装代数已被替换即自行退役
 * （新窗有自己的看门狗），不会误杀新窗。
 * -------------------------------------------------------------------------- */

/// 前端就绪 ack 事件名（FullscreenView 首帧握手 emit；命名对齐
/// command-palette:closed 的 kebab+冒号惯例）。payload = 建窗代数（数字）。
pub const FULLSCREEN_READY_EVENT: &str = "fullscreen:ready";

/// 看门狗武装代数：每次创建全屏窗自增（从 1 起；0 永不被武装，前端解析失败
/// 回传 0 时等同未 ack，看门狗保持戒备——保守正确）。
static FULLSCREEN_ARM_GEN: AtomicU64 = AtomicU64::new(0);
/// 最近一次 ack 覆盖到的代数（fetch_max 只增不减）。
static FULLSCREEN_ACK_GEN: AtomicU64 = AtomicU64::new(0);

/// ack 记账：取最大代数——迟到的旧代 ack 无法回退新代的覆盖状态。
fn record_fullscreen_ack(acked: &AtomicU64, gen: u64) {
    acked.fetch_max(gen, Ordering::AcqRel);
}

/// 看门狗触发时的判定：武装代数是否已被 ack 覆盖（≥ 语义）。
fn fullscreen_ack_covers(acked: &AtomicU64, gen: u64) -> bool {
    acked.load(Ordering::Acquire) >= gen
}

/// lib.rs setup 挂接的前端 ack 监听（照 shortcuts.rs 对
/// command-palette:closed 的 listen_any 范式）。event.payload() 是 JSON 序列
/// 化文本（数字 ack 形如 "7"）。
pub fn listen_fullscreen_ready(app: &tauri::AppHandle) {
    app.listen_any(FULLSCREEN_READY_EVENT, |event| {
        if let Ok(gen) = serde_json::from_str::<u64>(event.payload()) {
            record_fullscreen_ack(&FULLSCREEN_ACK_GEN, gen);
        }
    });
}

/// 武装看门狗：12s 后 ack 仍未覆盖本代 → 关闭全屏窗。窗口已被用户正常退出
/// （Esc → close）时 get_webview_window 返回 None，自然 no-op。
fn arm_fullscreen_watchdog(app: &tauri::AppHandle, gen: u64) {
    /// WebView 冷启动（含 vite 分包 chunk 拉取）正常路径 ~1-2s 内完成首帧
    /// 握手；12s 留足慢机器余量，又远短于「被困且无出口」的体验底线。
    const FULLSCREEN_WATCHDOG_MS: u64 = 12_000;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(FULLSCREEN_WATCHDOG_MS));
        if FULLSCREEN_ARM_GEN.load(Ordering::Acquire) != gen {
            // 已有更新一代的全屏窗接管：本看门狗退役（新窗建窗时已武装自己
            // 的看门狗），不误杀新窗。
            return;
        }
        if fullscreen_ack_covers(&FULLSCREEN_ACK_GEN, gen) {
            return; // 前端已就绪：正常路径，无感。
        }
        if let Some(w) = app.get_webview_window("fullscreen") {
            // 判定与销毁之间的二次校验——ack 恰在上方
            // fullscreen_ack_covers 返回 false 之后、destroy 生效之前到达
            // （get_webview_window / 日志的微秒级窗口）时，已就绪的窗口会被
            // 误销毁（用户感知「全屏窗刚出现就自动关闭」，重开即恢复）。
            // destroy 前再查一次，把竞态窗口压缩到单条原子 load 级。
            if fullscreen_ack_covers(&FULLSCREEN_ACK_GEN, gen) {
                return;
            }
            log::warn!(
                "fullscreen: webview not ready in {FULLSCREEN_WATCHDOG_MS}ms; closing window to untrap user (Q-36 watchdog)"
            );
            let _ = w.destroy();
        }
    });
}

pub fn show_fullscreen_display(app: &tauri::AppHandle, kind: &str) {
    if !FULLSCREEN_KINDS.contains(&kind) {
        log::warn!("fullscreen: unknown kind {kind}");
        return;
    }
    if let Some(w) = app.get_webview_window("fullscreen") {
        let _ = w.close();
    }
    // 武装代数先于建窗自增并注入 URL hash——前端
    // ack 原样回传该代数（防复用路径下旧 ack 让新看门狗失效，见上方机制
    // 注释）。parseFullscreenKind 用 URLSearchParams 按 key 取参，追加的
    // gen 参数不影响其解析；main.tsx 的旧路径重定向整段保留 hash。
    let gen = FULLSCREEN_ARM_GEN.fetch_add(1, Ordering::AcqRel) + 1;
    // fullscreen(true) 由系统放到当前虚拟屏，无需手动解析目标显示器。
    let built = tauri::WebviewWindowBuilder::new(
        app,
        "fullscreen",
        // fullscreen.html 精简入口（vite 多页），不再共用 index.html
        // 全量主包；hash 段保持 #fullscreen&kind=xx 原样（FullscreenView
        // 靠它解析模式），旧 index.html#fullscreen 路径由 main.tsx 重定向兜底。
        tauri::WebviewUrl::App(format!("fullscreen.html#fullscreen&kind={kind}&gen={gen}").into()),
    )
    .title("Vela 全屏展示")
    .decorations(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(true)
    .shadow(false)
    .fullscreen(true)
    .visible(false)
    .build();
    if let Err(e) = built {
        log::warn!("fullscreen: build window failed: {e}");
    } else {
        if let Ok(w) = &built {
            crate::anticapture::apply_if_enabled(w);
        }
        spawn_show_fallback(app, "fullscreen", 3000);
        // WebView 就绪看门狗（必须在每次建窗时随新代数重新武装）。
        arm_fullscreen_watchdog(app, gen);
    }
}

#[tauri::command]
pub async fn show_fullscreen(window: tauri::Window, kind: String) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    if !FULLSCREEN_KINDS.contains(&kind.as_str()) {
        return Err("未知的全屏展示模式".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || show_fullscreen_display(&app, &kind))
        .await
        .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* [WEB-PREVIEW] 应用内网页浮层：外部 URL     */
/* 直接以独立 WebView 窗口打开（查个文档就回来的路径不断）。远程页面只授     */
/* 最小窗口权限（capabilities/web-preview.json：close + start-dragging）。   */
/* 注意：Tauri 2 的 ACL 只门控插件命令——自定义命令 IPC 对远程内容同样        */
/* 可达（见 lib.rs trusted_window 注释），敏感命令必须逐个挂命令级窗口闸门。  */
/* ------------------------------------------------------------------ */

/// 校验并打开网页浮层：仅 http(s) 且拒绝内网目标（与 fetch_url_text 同门槛）。
pub fn show_web_preview(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "无效 URL".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("仅支持 http/https 链接".into());
    }
    crate::system_integration::reject_private_target_pub(url)?;
    if let Some(w) = app.get_webview_window("web-preview") {
        let _ = w.close();
    }
    let built =
        tauri::WebviewWindowBuilder::new(app, "web-preview", tauri::WebviewUrl::External(parsed))
            .title("Vela 网页预览")
            .inner_size(960.0, 660.0)
            .min_inner_size(420.0, 320.0)
            .center()
            .resizable(true)
            .skip_taskbar(false)
            .build();
    if let Err(e) = built {
        log::warn!("web-preview: build window failed: {e}");
        return Err(format!("打开网页浮层失败：{e}"));
    }
    if let Ok(w) = &built {
        crate::anticapture::apply_if_enabled(w);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_web_preview(window: tauri::Window, url: String) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || show_web_preview(&app, &url))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ack 状态机：代数只增不减——
    /// ① 未 ack 的武装代数不被覆盖（看门狗保持戒备）；
    /// ② 旧窗迟到的 ack（代数 ≤ 当前覆盖值）不能撤销对新代的覆盖状态
    ///   （防复用路径下旧 ack 让新看门狗失效）；
    /// ③ 覆盖是 ≥ 语义：新 ack 天然覆盖一切更早的武装代数。
    #[test]
    fn fullscreen_ack_generation_is_monotonic() {
        let acked = AtomicU64::new(0);
        assert!(!fullscreen_ack_covers(&acked, 1), "武装后未 ack：不覆盖");

        record_fullscreen_ack(&acked, 1);
        assert!(fullscreen_ack_covers(&acked, 1), "同代 ack：覆盖");

        // 旧代（第 1 代）的 ack 迟到落在第 2 代武装之后：不得回退覆盖状态。
        record_fullscreen_ack(&acked, 1);
        assert!(fullscreen_ack_covers(&acked, 1));
        assert!(!fullscreen_ack_covers(&acked, 2), "第 2 代未 ack：仍戒备");

        record_fullscreen_ack(&acked, 2);
        assert!(fullscreen_ack_covers(&acked, 2));
        assert!(fullscreen_ack_covers(&acked, 1), "≥ 语义：旧代天然满足");

        // 前端解析失败回传 0（武装代数从 1 起）：等同未 ack，不构成覆盖。
        record_fullscreen_ack(&acked, 0);
        assert!(!fullscreen_ack_covers(&acked, 3), "0 代 ack 无效");
    }
}
