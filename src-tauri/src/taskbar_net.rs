//! 任务栏网速条（经典网速工具的招牌形态，干净实现）。
//!
//! 经典网速工具的任务栏窗口实际是 `SetParent` 挂进 Shell_TrayWnd 的子窗；
//! 本模块刻意不做跨进程 SetParent（把 WebView2 全功能 HWND 挂进 explorer 的
//! 输入/DPI 语义风险高），改用等效的独立覆盖窗方案：
//! - 置顶带（builder `always_on_top` + 每次显示前重设 `HWND_TOPMOST`）——
//!   任务栏自身也在置顶带，explorer 重建后会排到旧置顶窗之上，不重设会被
//! 它盖住（这是本窗「常态不可见」的根因）。
//! - 全时点击穿透（`set_ignore_cursor_events`）——条只读不交互，绝不吞
//! 任务栏按钮的点击（穿透后 hover 不再到达，前端 hudGiveWay 悬停
//!   避让在本窗随之退役，设置仍服务全屏 HUD）。
//! - 找任务栏（Shell_TrayWnd，仅主屏；副屏 Shell_SecondaryTrayWnd 不贴，
//!   与 经典网速工具 默认行为一致）与托盘通知区（TrayNotifyWnd），在通知
//!   区左侧贴靠；独立线程自适应轮询（1s→3s 封顶）重贴：任务栏移动/分辨率/
//!   DPI 变化最坏 3s 内跟上；任务栏不可见（explorer 重启中/全屏应用压住）
//!   时隐藏自身，回来后自动恢复。
//!
//! 前端存活账本：建窗后前端首跳心跳的宽限期内，空窗因透明+穿透
//! 而无害；超龄未心跳即判死，关窗重建（有界预算），杜绝「内容死了还常态
//! 压在任务栏上」的死角。内容宽度由前端按格式化档位实测上报（消除
//! 硬编码截断数字）。
//!
//! 与 taskbar_tap（注入改外观）互不相干：本窗口是独立 HWND，不触碰
//! 任务栏可视化树，任何失败只表现为「网速条不见了」，不可能连累 shell。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const WINDOW_LABEL: &str = "taskbar-net";
/// 开关的持久化键（settings 表；与应用其余设置同库同表）。
const SETTING_KEY: &str = "taskbar_net_enabled";
/// 前端上报前的初始内容宽度（逻辑像素；高度=任务栏高度，由贴靠线程设定）。
/// 上报后以实测为准——旧值 104 在默认显示档位（"1023.9 KB/s" 级
/// 两位数+单位）下必然截断。
const STRIP_LOGICAL_WIDTH: f64 = 160.0;
/// 上报宽度的钳制范围：过窄容不下一行数字，过宽盖满半条任务栏。
const STRIP_MIN_LOGICAL_WIDTH: f64 = 60.0;
const STRIP_MAX_LOGICAL_WIDTH: f64 = 320.0;
/// 贴靠轮询基准周期。
const DOCK_POLL_MS: u64 = 1000;
/// 稳态自适应上限——连续无变化时轮询间隔逐级翻倍至此（1s→2s→
/// 3s）。：原 10s 与「任务栏变化秒级跟上」的产品预期冲突（最坏悬空
/// 错位 10s），压到 3s；事件化（WinEvent/TaskbarCreated）与注入状态机
/// 耦合而本模块刻意独立于注入，故仍取自适应轮询路线。
const DOCK_POLL_MAX_MS: u64 = 3_000;
/// 建窗持续失败时的重试间隔（拍数；×DOCK_POLL_MS ≈ 30s）。
const CREATE_RETRY_TICKS: u32 = 30;
/// 建窗后等待前端首跳心跳的宽限（WebView2 冷启动/磁盘紧张）。
const LOAD_GRACE_MS: u64 = 20_000;
/// 心跳超龄判死阈值（前端 5s 一跳，容忍 6 拍丢失）。
const ALIVE_STALE_MS: u64 = 30_000;
/// 页面判死后重建窗口的预算（WebView2 永久损坏时防无限重建）。
const MAX_FRONTEND_RELOADS: u32 = 3;

/// 当前是否启用（跨命令与贴靠线程共享；以 settings 表为持久层）。
static ENABLED: AtomicBool = AtomicBool::new(false);

/// 开关生命周期转换的串行锁——enable/disable 原先分属两次
/// spawn_blocking，无顺序保证：disable 的 stop 若晚于 enable 的 start 落地，
/// 会杀掉新线程并关掉新窗，把功能打死到下次手动切换。整段转换（存开关 →
/// 停旧件/起新件）都在本锁下的阻塞池里完成。
static LIFECYCLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 贴靠线程控制块（关闭后线程随开关退出，不再永久 1Hz 空转；下次
/// 开启从干净状态重建。stop 置位后线程在 ≤1 个轮询分片内退出，join 由
/// 阻塞池执行不冻主线程）。
static DOCK_THREAD: std::sync::Mutex<Option<DockThreadHandle>> = std::sync::Mutex::new(None);

/// 前端上报的内容宽度（f64 位模式；0=未上报，用默认）。
static REPORTED_LOGICAL_WIDTH: AtomicU64 = AtomicU64::new(0);
/// 前端最后心跳时刻（epoch ms；0=从未心跳）。
static FRONTEND_ALIVE_MS: AtomicU64 = AtomicU64::new(0);
/// 本轮窗口的创建时刻（epoch ms；判「宽限期内」的基准）。
static WINDOW_BORN_MS: AtomicU64 = AtomicU64::new(0);
/// 本轮启用周期内已用掉的页面重建次数。
static RELOADS: AtomicU32 = AtomicU32::new(0);

struct DockThreadHandle {
    stop: std::sync::Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_enabled_setting(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    // 纯 SELECT 走只读连接池（约定；此前借用写连接）。
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

/// 前端页面是否存活。两种判据：心跳过（看超龄）或从没心跳（看建窗
/// 宽限）。任何一种不满足都视为内容死——绝不能让空窗常态压在任务栏上。
fn frontend_healthy(now: u64) -> bool {
    let alive = FRONTEND_ALIVE_MS.load(Ordering::SeqCst);
    if alive != 0 {
        return now.saturating_sub(alive) <= ALIVE_STALE_MS;
    }
    let born = WINDOW_BORN_MS.load(Ordering::SeqCst);
    born != 0 && now.saturating_sub(born) <= LOAD_GRACE_MS
}

fn strip_logical_width() -> f64 {
    let bits = REPORTED_LOGICAL_WIDTH.load(Ordering::SeqCst);
    if bits == 0 {
        STRIP_LOGICAL_WIDTH
    } else {
        f64::from_bits(bits)
    }
}

/// 覆盖窗标志：置顶 + 全时点击穿透。条是只读覆盖物：既不能
/// 被任务栏盖住，也不能反过来吞任务栏按钮的点击。对已存在的窗口重放
/// （开关再次打开/旧路径建出的窗口补课）。
fn apply_overlay_flags(win: &tauri::WebviewWindow) {
    let _ = win.set_always_on_top(true);
    let _ = win.set_ignore_cursor_events(true);
}

/// 创建（不显示的）网速条窗口；贴靠线程算出位置后再显示——直接可见会在
/// 屏幕原点闪现至至多一个贴靠周期。已存在时只补标志位。返回是否就绪
/// （建窗失败要让命令报错回滚，而不是静默 warn 后 UI 与真实状态
/// 「一致地错」）。
fn ensure_window(app: &tauri::AppHandle) -> bool {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        apply_overlay_flags(&w);
        if WINDOW_BORN_MS.load(Ordering::SeqCst) == 0 {
            WINDOW_BORN_MS.store(now_ms(), Ordering::SeqCst);
        }
        return true;
    }
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
    .always_on_top(true)
    .build();
    match built {
        Err(e) => {
            log::warn!("taskbar-net window create failed: {e}");
            false
        }
        Ok(w) => {
            WINDOW_BORN_MS.store(now_ms(), Ordering::SeqCst);
            apply_overlay_flags(&w);
            crate::anticapture::apply_if_enabled(&w);
            true
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
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetWindowRect, IsWindowVisible,
    };

    let hwnd = unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) }.ok()?;
    // 任务栏被全屏应用压住/系统藏起时不承载显示——视为不可贴（与 explorer
    // 重启中同路径：藏条等它回来），避免置顶条浮在全屏内容之上。
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return None;
    }
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

/// 目标点所在显示器的有效 DPI 缩放。贴靠线程原先用 `win.scale_factor()`
/// ——那是窗口**当前所在屏**的 scale，跨屏移动后的一拍会按旧屏算错宽度。
#[cfg(windows)]
fn dpi_scale_at(x: i32, y: i32) -> Option<f64> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

    let mon = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };
    if mon.is_invalid() {
        return None;
    }
    let mut dpi_x: u32 = 0;
    let mut dpi_y: u32 = 0;
    unsafe { GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) }.ok()?;
    Some(dpi_x as f64 / 96.0)
}

#[cfg(not(windows))]
fn dpi_scale_at(_x: i32, _y: i32) -> Option<f64> {
    None
}

/// 显示并浮到置顶带顶端：`SW_SHOWNOACTIVATE` 不抢焦点（——tao 的
/// `win.show()` 走 SW_SHOW，会激活本窗偷走当前应用焦点一次）；随后重设
/// `HWND_TOPMOST`（——explorer 重建的任务栏会排进置顶带顶端，不重设
/// 会被它盖住）。
fn present(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SW_SHOWNOACTIVATE,
        };
        if let Ok(hwnd) = win.hwnd() {
            // SAFETY: hwnd 来自 Tauri 持有的活窗口；ShowWindow/SetWindowPos 对
            // 自有窗口跨线程调用安全（user32 属性设置类 API，无状态副作用）。
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            return;
        }
    }
    let _ = win.show();
    let _ = win.set_always_on_top(true);
}

/// 启动贴靠线程（幂等；stop_dock_thread 后可重建）。
fn start_dock_thread(app: tauri::AppHandle) {
    let mut guard = DOCK_THREAD.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        return;
    }
    // 每次开启重置存活账本与重建预算——新页面重新走建窗宽限期。
    FRONTEND_ALIVE_MS.store(0, Ordering::SeqCst);
    WINDOW_BORN_MS.store(0, Ordering::SeqCst);
    RELOADS.store(0, Ordering::SeqCst);
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let handle = std::thread::spawn(move || {
        // 上次成功贴靠的矩形（x, y, w, h）：任务栏静止时跳过 set_size/set_position/
        // show，避免每秒给 WebView2 灌一轮冗余窗口消息（WM_SIZE → 前端 resize 抖动）。
        let mut last: Option<(i32, i32, u32, u32)> = None;
        // 建窗连续失败计数：持续失败（如 WebView2 运行时损坏）时降频重试，
        // 避免 1Hz 刷告警日志。每 CREATE_RETRY_TICKS 拍重试一次。
        let mut create_fails: u32 = 0;
        // 当前实际采用的轮询间隔（自适应：无变化翻倍至上限，有变化归 1s）。
        // 先干活后睡——开启/恢复后首拍立即可见，不再白等 1s。
        let mut poll_ms = DOCK_POLL_MS;
        loop {
            if ENABLED.load(Ordering::SeqCst) {
                match app.get_webview_window(WINDOW_LABEL) {
                    None => {
                        // 窗口被外部销毁（任务管理器/崩溃/判死重建）：按开关重建（带退避）。
                        last = None;
                        if create_fails.is_multiple_of(CREATE_RETRY_TICKS) {
                            ensure_window(&app);
                        }
                        create_fails = create_fails.saturating_add(1);
                        poll_ms = DOCK_POLL_MS;
                    }
                    Some(win) => {
                        create_fails = 0;
                        let now = now_ms();
                        if !frontend_healthy(now) {
                            // 页面没起来/死掉。穿透已保证不吞点击，这里保证
                            // 不占显示：藏窗，预算内关窗重建，超预算低频再探。
                            last = None;
                            let _ = win.hide();
                            let reloads = RELOADS.load(Ordering::SeqCst);
                            if reloads < MAX_FRONTEND_RELOADS {
                                RELOADS.store(reloads + 1, Ordering::SeqCst);
                                log::warn!(
                                    "taskbar-net frontend dead (alive={} born={} now={}), reload {}/{}",
                                    FRONTEND_ALIVE_MS.load(Ordering::SeqCst),
                                    WINDOW_BORN_MS.load(Ordering::SeqCst),
                                    now,
                                    reloads + 1,
                                    MAX_FRONTEND_RELOADS
                                );
                                // 归零后新窗口重新走建窗宽限；born 由 ensure_window 重置。
                                FRONTEND_ALIVE_MS.store(0, Ordering::SeqCst);
                                let _ = win.close();
                                poll_ms = DOCK_POLL_MS;
                            } else {
                                poll_ms = DOCK_POLL_MAX_MS;
                            }
                        } else if let Some(rects) = taskbar_rects() {
                            let (bx, by, bw, bh) = rects.bar;
                            if bh > bw {
                                // 竖排任务栏（屏幕左/右缘）没有可贴的横向条位——
                                // 硬贴会生成「条宽×整屏高」的挡板横跨全部图标区。藏窗
                                // 等用户转回横排。
                                last = None;
                                let _ = win.hide();
                                poll_ms = DOCK_POLL_MS;
                            } else {
                                // 按任务栏所在屏取 DPI（窗口自报 scale 跨屏滞后）。
                                let scale = dpi_scale_at(bx + bw / 2, by + bh / 2)
                                    .or_else(|| win.scale_factor().ok())
                                    .unwrap_or(1.0);
                                let strip_w = (strip_logical_width() * scale).round() as i32;
                                // 贴靠位置：托盘通知区左侧（通知区未知时退化为任务栏左端）。
                                // 钳回任务栏左缘——左侧竖排任务栏的 notify_left 可能小于
                                // 条宽，负数坐标会叠到托盘上。
                                let x = (rects.notify_left.unwrap_or(bx) - strip_w).max(bx);
                                let y = by;
                                let size = (strip_w.max(1) as u32, bh.max(1) as u32);
                                if last != Some((x, y, size.0, size.1)) {
                                    let _ = win.set_size(tauri::PhysicalSize::new(size.0, size.1));
                                    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                                    present(&win);
                                    last = Some((x, y, size.0, size.1));
                                    poll_ms = DOCK_POLL_MS;
                                } else if !win.is_visible().unwrap_or(true) {
                                    // 位置未变但窗口被外部隐藏（如 explorer 恢复后系统藏起）→ 补显示。
                                    present(&win);
                                    poll_ms = DOCK_POLL_MS;
                                } else {
                                    // 稳态对账实际矩形——被外力（壳层级联/第三方
                                    // 窗口管理器）挪动后立即重贴，不等任务栏自身变化。
                                    let drifted = match (win.outer_position(), win.outer_size()) {
                                        (Ok(p), Ok(s)) => {
                                            last != Some((p.x, p.y, s.width, s.height))
                                        }
                                        _ => true,
                                    };
                                    if drifted {
                                        let _ =
                                            win.set_size(tauri::PhysicalSize::new(size.0, size.1));
                                        let _ =
                                            win.set_position(tauri::PhysicalPosition::new(x, y));
                                        present(&win);
                                        poll_ms = DOCK_POLL_MS;
                                    } else {
                                        // 稳态：任务栏静止，间隔逐级翻倍。
                                        poll_ms = (poll_ms * 2).min(DOCK_POLL_MAX_MS);
                                    }
                                }
                            }
                        } else {
                            // explorer 重启中/全屏应用：任务栏暂不可见，先藏起来等它回来。
                            last = None;
                            let _ = win.hide();
                            poll_ms = DOCK_POLL_MS;
                        }
                    }
                }
            }
            // 分片睡眠（250ms）：稳态退避到 3s 时停止仍能在 ≤250ms 内退出——
            // 整段 sleep 让关闭开关的 join 最长等一个完整周期，网速条在
            // 任务栏上残留过久（4 次/s 空醒可忽略）。
            let mut left = poll_ms;
            while left > 0 {
                let chunk = left.min(250);
                std::thread::sleep(std::time::Duration::from_millis(chunk));
                if stop_flag.load(Ordering::Relaxed) {
                    return;
                }
                left -= chunk;
            }
        }
    });
    *guard = Some(DockThreadHandle {
        stop,
        handle: Some(handle),
    });
}

/// 停止贴靠线程（阻塞 join ≤1 个轮询分片；在阻塞池调用，不冻主线程）。
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
/// 窗口期把全部窗口冻住（commands.rs 同款约束，见 net_history 两查询命令）。
/// 整个生命周期转换（写库 + 停旧线程/关旧窗 或 建新窗/起新线程）在
/// `LIFECYCLE_LOCK` 下的同一次 spawn_blocking 里串行完成——快开快关不再有
/// 交错执行把功能打死的窗口。建窗失败即回滚开关并报错，让设置页
/// 走既有 toast 分支，而不是静默「一致地错」。
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
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _serial = LIFECYCLE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        ENABLED.store(enabled, Ordering::SeqCst);
        write_enabled_setting(&app, enabled);
        if enabled {
            if !ensure_window(&app) {
                ENABLED.store(false, Ordering::SeqCst);
                write_enabled_setting(&app, false);
                return Err("网速条窗口创建失败（WebView2 运行时异常或系统资源不足）".into());
            }
            start_dock_thread(app.clone());
        } else {
            // 关闭时顺带停掉贴靠线程（join ≤1 个分片周期，在阻塞池里等），
            // 下一次开启由 start_dock_thread 从干净状态重建。
            stop_dock_thread_blocking();
            if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
                let _ = win.close();
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("taskbar-net lifecycle failed: {e}"))?
}

/// 查询当前开关（设置页渲染用；以内存态为准，启动时由 restore 同步）。
#[tauri::command]
pub fn get_taskbar_net_enabled(window: tauri::Window) -> Result<bool, String> {
    crate::require_trusted(&window)?;
    Ok(ENABLED.load(Ordering::SeqCst))
}

/// 前端页面存活心跳。taskbar-net 页面加载完成后周期上报（5s 一跳），
/// 贴靠线程据此判内容死活；仅接受本窗口调用。
#[tauri::command]
pub fn taskbar_net_heartbeat(window: tauri::Window) {
    // gate: 仅本窗口（字面量与 WINDOW_LABEL 同值，check-window-gates 可识别）。
    if window.label() != "taskbar-net" {
        return;
    }
    FRONTEND_ALIVE_MS.store(now_ms(), Ordering::SeqCst);
}

/// 前端实测内容宽度上报（逻辑像素）。TaskbarNetView 按当前格式化
/// 档位量出实际需要的宽度，贴靠线程据此定窗宽，消除硬编码截断；仅接受
/// 本窗口调用。
#[tauri::command]
pub fn set_taskbar_net_width(window: tauri::Window, width: f64) {
    // gate: 仅本窗口（字面量与 WINDOW_LABEL 同值，check-window-gates 可识别）。
    if window.label() != "taskbar-net" {
        return;
    }
    if !width.is_finite() {
        return;
    }
    let clamped = width.clamp(STRIP_MIN_LOGICAL_WIDTH, STRIP_MAX_LOGICAL_WIDTH);
    REPORTED_LOGICAL_WIDTH.store(clamped.to_bits(), Ordering::SeqCst);
}

/// 应用启动时恢复：上次退出时开着 → 重建窗口 + 贴靠线程。
pub fn restore(app: &tauri::AppHandle) {
    if read_enabled_setting(app) {
        let _serial = LIFECYCLE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        ENABLED.store(true, Ordering::SeqCst);
        // 建窗失败不回滚开关（restore 无调用方可报错）：贴靠线程按 30s 退避
        // 持续重试，系统恢复后自动出现。
        ensure_window(app);
        start_dock_thread(app.clone());
    }
}
