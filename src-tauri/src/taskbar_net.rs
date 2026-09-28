//! W-171 / P2-8 任务栏网速条（经典网速工具的招牌形态，干净实现）。
//!
//! 经典网速工具的任务栏窗口本质是一个贴靠 Shell_TrayWnd 的自建小窗，
//! 不需要注入 explorer。本模块用同一手法：找到任务栏与其托盘通知区
//! （TrayNotifyWnd）子窗，在通知区左侧放一个置顶/无边框/透明的小 Tauri
//! 窗（前端 `index.html#taskbar-net`），独立线程按 1s 周期重新贴靠：
//! 任务栏移动/分辨率变化/DPI 变化下一秒内跟上；explorer 重启导致任务栏
//! 暂时消失时隐藏自身，任务栏回来后自动恢复。
//!
//! 与 taskbar_tap（注入改外观）互不相干：本窗口是独立 HWND，不触碰
//! 任务栏可视化树，任何失败只表现为「网速条不见了」，不可能连累 shell。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const WINDOW_LABEL: &str = "taskbar-net";
/// 开关的持久化键（settings 表；与应用其余设置同库同表）。
const SETTING_KEY: &str = "taskbar_net_enabled";
/// 网速条内容宽度（逻辑像素；高度=任务栏高度，由贴靠线程设定）。
const STRIP_LOGICAL_WIDTH: f64 = 104.0;
/// 贴靠轮询基准周期。
const DOCK_POLL_MS: u64 = 1000;
/// B-7/G-3：稳态自适应上限——连续无变化时轮询间隔逐级翻倍至此（1s→2s→
/// 4s→…→10s），任务栏静止时查询频率降到 0.1Hz；任何变化（矩形变了 /
/// 窗口被藏 / 任务栏消失）立即回到 1s 档。事件化（WinEvent/TaskbarCreated）
/// 与注入状态机耦合而本模块刻意独立于注入，故取自适应轮询路线。
const DOCK_POLL_MAX_MS: u64 = 10_000;
/// 建窗持续失败时的重试间隔（拍数；×DOCK_POLL_MS ≈ 30s）。
const CREATE_RETRY_TICKS: u32 = 30;

/// 当前是否启用（跨命令与贴靠线程共享；以 settings 表为持久层）。
static ENABLED: AtomicBool = AtomicBool::new(false);

/// 贴靠线程控制块（R8：关闭后线程随开关退出，不再永久 1Hz 空转；下次
/// 开启从干净状态重建。stop 置位后线程在 ≤1 个轮询周期内退出，join 由
/// 阻塞池执行不冻主线程）。
static DOCK_THREAD: std::sync::Mutex<Option<DockThreadHandle>> = std::sync::Mutex::new(None);

struct DockThreadHandle {
    stop: std::sync::Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

fn read_enabled_setting(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    // 纯 SELECT 走只读连接池（C-1 约定；此前借用写连接）。
    let Ok(conn) = state.read_db.acquire() else {
        return false;
    };
    crate::repositories::SettingsRepo::get(&conn, SETTING_KEY)
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false)
}

fn write_enabled_setting(app: &tauri::AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(conn) = crate::db::lock_db(&state.db) {
            // 写失败静默会让本次开关在重启后回退（restore 读到旧值且无迹可查），必须留痕。
            if let Err(e) =
                crate::repositories::SettingsRepo::set(&conn, SETTING_KEY, &enabled.to_string())
            {
                log::warn!("taskbar-net setting persist failed: {e}");
            }
        }
    }
}

/// 创建（不显示的）网速条窗口；贴靠线程算出位置后再 show——直接可见会在
/// 屏幕原点闪现至多一个贴靠周期。已存在时只补 show（enable 再次打开）。
fn spawn_window(app: &tauri::AppHandle) {
    match app.get_webview_window(WINDOW_LABEL) {
        Some(w) => {
            let _ = w.show();
        }
        None => {
            let built = WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                // 独立精简入口（vite 多页）：本窗是零交互常驻小窗，不再共用
                // index.html 全量主包（stores/画布/设置窗全家）。前端仍保留
                // index.html#taskbar-net 分支作浏览器开发与旧路径兜底。
                WebviewUrl::App("taskbar-net.html".into()),
            )
            .title("网速")
            .inner_size(STRIP_LOGICAL_WIDTH, 40.0)
            .position(0.0, 0.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .focused(false)
            .visible(false)
            .build();
            if let Err(e) = built {
                log::warn!("taskbar-net window create failed: {e}");
            }
        }
    }
}

/// 任务栏与其托盘通知区的屏幕矩形（物理像素）。
struct BarRects {
    /// (left, top, width, height)。
    bar: (i32, i32, i32, i32),
    /// TrayNotifyWnd 的 left（通知区左边缘）；取不到为 None。
    notify_left: Option<i32>,
}

#[cfg(windows)]
fn taskbar_rects() -> Option<BarRects> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW, GetWindowRect};

    let hwnd = unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) }.ok()?;
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r) }.ok()?;
    let notify_left =
        unsafe { FindWindowExW(Some(hwnd), None, w!("TrayNotifyWnd"), PCWSTR::null()) }
            .ok()
            .and_then(|nh| {
                let mut nr = RECT::default();
                unsafe { GetWindowRect(nh, &mut nr) }.ok()?;
                Some(nr.left)
            });
    Some(BarRects {
        bar: (r.left, r.top, r.right - r.left, r.bottom - r.top),
        notify_left,
    })
}

#[cfg(not(windows))]
fn taskbar_rects() -> Option<BarRects> {
    None
}

/// 启动贴靠线程（幂等；stop_dock_thread 后可重建）。
fn start_dock_thread(app: tauri::AppHandle) {
    let mut guard = DOCK_THREAD.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        return;
    }
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let handle = std::thread::spawn(move || {
        // 上次成功贴靠的矩形（x, y, w, h）：任务栏静止时跳过 set_size/set_position/
        // show，避免每秒给 WebView2 灌一轮冗余窗口消息（WM_SIZE → 前端 resize 抖动）。
        let mut last: Option<(i32, i32, u32, u32)> = None;
        // 建窗连续失败计数：持续失败（如 WebView2 运行时损坏）时降频重试，
        // 避免 1Hz 刷告警日志。每 CREATE_RETRY_TICKS 拍重试一次。
        let mut create_fails: u32 = 0;
        // B-7：当前实际采用的轮询间隔（自适应：无变化翻倍至上限，有变化归 1s）。
        let mut poll_ms = DOCK_POLL_MS;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(poll_ms));
            if stop_flag.load(Ordering::Relaxed) {
                return;
            }
            if !ENABLED.load(Ordering::SeqCst) {
                continue;
            }
            let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
                // 窗口被外部销毁（任务管理器/崩溃）：按开关重建（带退避）。
                last = None;
                if create_fails.is_multiple_of(CREATE_RETRY_TICKS) {
                    spawn_window(&app);
                }
                create_fails = create_fails.saturating_add(1);
                poll_ms = DOCK_POLL_MS;
                continue;
            };
            create_fails = 0;
            let Some(rects) = taskbar_rects() else {
                // explorer 重启中：先藏起来，等任务栏回来。
                last = None;
                let _ = win.hide();
                poll_ms = DOCK_POLL_MS;
                continue;
            };
            let scale = win.scale_factor().unwrap_or(1.0);
            let (_bx, by, _bw, bh) = rects.bar;
            let strip_w = (STRIP_LOGICAL_WIDTH * scale).round() as i32;
            // 贴靠位置：托盘通知区左侧（通知区未知时退化为任务栏左端）。钳回任务栏
            // 左缘——左侧竖排任务栏的 notify_left 可能小于条宽，负数坐标会叠到托盘上。
            let x = (rects.notify_left.unwrap_or(rects.bar.0) - strip_w).max(rects.bar.0);
            let y = by;
            let size = (strip_w.max(1) as u32, bh.max(1) as u32);
            if last != Some((x, y, size.0, size.1)) {
                let _ = win.set_size(tauri::PhysicalSize::new(size.0, size.1));
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                let _ = win.show();
                last = Some((x, y, size.0, size.1));
                poll_ms = DOCK_POLL_MS;
            } else if !win.is_visible().unwrap_or(true) {
                // 位置未变但窗口被外部隐藏（如 explorer 恢复后系统藏起）→ 补 show。
                let _ = win.show();
                poll_ms = DOCK_POLL_MS;
            } else {
                // 稳态：任务栏静止，间隔逐级翻倍（B-7）。
                poll_ms = (poll_ms * 2).min(DOCK_POLL_MAX_MS);
            }
        }
    });
    *guard = Some(DockThreadHandle {
        stop,
        handle: Some(handle),
    });
}

/// 停止贴靠线程（阻塞 join ≤1 个轮询周期；在阻塞池调用，不冻主线程）。
fn stop_dock_thread_blocking() {
    let taken = DOCK_THREAD.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(mut st) = taken {
        st.stop.store(true, Ordering::Relaxed);
        if let Some(h) = st.handle.take() {
            let _ = h.join();
        }
    }
}

/// 前端设置开关。写库 + 同步窗口生命周期。
///
/// async：本命令由主线程分派，写库若同步做，会撞上备份/导入持有写锁数秒的
/// 窗口期把全部窗口冻住（commands.rs R1 同款约束，见 net_history 两查询命令）。
/// DB 写挪 spawn_blocking；窗口生命周期操作（建窗/关窗）不持锁，留在命令体。
#[tauri::command]
pub async fn set_taskbar_net_enabled(
    window: tauri::Window,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    // 窗口闸门：建/关贴靠小窗是真实系统副作用，只允许受信窗口（设置页）
    // 驱动，不给 web-preview 远程页面。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    ENABLED.store(enabled, Ordering::SeqCst);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_enabled_setting(&app2, enabled);
        // R8：关闭时顺带停掉贴靠线程（join ≤1s，在阻塞池里等），下一次开启
        // 由 start_dock_thread 从干净状态重建——线程不再于关闭后永久 1Hz 空醒。
        if !enabled {
            stop_dock_thread_blocking();
        }
    })
    .await
    .map_err(|e| format!("taskbar-net setting write failed: {e}"))?;
    if enabled {
        spawn_window(&app);
        start_dock_thread(app.clone());
    } else if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.close();
    }
    Ok(())
}

/// 查询当前开关（设置页渲染用；以内存态为准，启动时由 restore 同步）。
#[tauri::command]
pub fn get_taskbar_net_enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// 应用启动时恢复：上次退出时开着 → 重建窗口 + 贴靠线程。
pub fn restore(app: &tauri::AppHandle) {
    if read_enabled_setting(app) {
        ENABLED.store(true, Ordering::SeqCst);
        spawn_window(app);
        start_dock_thread(app.clone());
    }
}
