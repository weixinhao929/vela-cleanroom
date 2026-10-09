//! 系统托盘：菜单构建、事件处理与倒计时项挂载。从 lib.rs 拆出。
//!
//! 「任务栏外观」子菜单：勾选项「自定义任务栏外观」+「重置动态
//! 状态」。开关的托盘视角真源是 [`TASKBAR_ENABLED`]（启动时按模式 C 从设置镜像
//! `general.taskbar.enabled` 读入）。翻转链路（托盘点击与全局快捷键
//! `taskbar:toggle` 共用 [`toggle_taskbar_enabled`]）：
//! 勾选态即时翻转 → emit [`TRAY_TASKBAR_ENABLED_EVENT`]（设置窗 tray-events.ts
//! `setTaskbar({ enabled })`：落盘 localStorage 权威源 + 走既有 `sync:settings`
//! 跨窗口同步）→ 后台线程回写 SQLite 镜像 + 调 taskbar 引擎 apply（等就绪
//! ≤10s，故不能在主线程）。反向：设置页翻转 → 前端广播 `sync:settings`（快照含
//! `general.taskbar`）→ 这里 `listen_any` 回填勾选态，两侧 ≤1s 收敛。

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager,
};

use crate::repositories::SettingsRepo;
use crate::windows;
use crate::{monitor, AppState, ALLOW_EXIT};

/// 设置镜像键（settings-store 写入的 SQLite 快照；clipboard.rs / injector.rs 各自
/// 私有声明同值常量，此处同样本地声明）。
const SETTINGS_MIRROR_KEY: &str = "app:settings:v1";
/// 前端跨窗口设置同步事件（cross-window.ts `SYNC_EVENTS.settings`），载荷为设置
/// 快照（`general` 在根上）——托盘据此跟随设置页的总开关翻转。
const SYNC_SETTINGS_EVENT: &str = "sync:settings";
/// 托盘 / 快捷键翻转任务栏总开关后广播给设置窗（tray-events.ts 在设置窗
/// `setTaskbar({ enabled })` 落盘并触发既有跨窗口同步）。载荷：新开关值（bool）。
pub const TRAY_TASKBAR_ENABLED_EVENT: &str = "tray:taskbar-enabled";

/// 「自定义任务栏外观」勾选项句柄（翻转 / sync 回填时 set_checked）。
static TASKBAR_CHECK: Mutex<Option<CheckMenuItem<tauri::Wry>>> = Mutex::new(None);
/// 托盘视角的任务栏总开关（最近一次已知值）。翻转以它为基准而非再读镜像：镜像
/// 回写在后台线程，连续两次翻转之间可能尚未落盘。None = 尚未从镜像初始化。
static TASKBAR_ENABLED: Mutex<Option<bool>> = Mutex::new(None);
/// 串行化后台的「镜像回写 + 引擎 apply / reset」：连续操作按先后顺序生效，避免
/// 起注入与恢复两个 apply 交错。
static TASKBAR_APPLY_LOCK: Mutex<()> = Mutex::new(());

/// [ANTICAPTURE]「防屏幕捕获」勾选项句柄与最近已知
/// 开关。翻转走「emit 事件由 widget-0 前端 setExtra 全链落盘」——widget-0 按
/// 永远存在，设置窗关着也能落到 localStorage 权威源 + SQLite 镜像（比任务
///栏开关的「仅设置窗消费」路径更稳），Rust 侧 anticapture watcher 随镜像变更
/// 对全部窗口重放 display affinity。
static ANTICAPTURE_CHECK: Mutex<Option<CheckMenuItem<tauri::Wry>>> = Mutex::new(None);
static ANTICAPTURE_ENABLED: Mutex<Option<bool>> = Mutex::new(None);
/// 托盘翻转防捕获后广播（tray-events.ts 在 widget-0 消费 → setExtra）。
pub const TRAY_ANTICAPTURE_EVENT: &str = "tray:anticapture";

/// 构建托盘图标与菜单，并把倒计时菜单项句柄挂到 AppState
/// （供 commands::set_tray_countdown 刷新文本）。
pub fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    // 菜单顶部固定一条禁用项，展示倒计时剩余时间（无计时=隐藏文案）。
    let countdown_item = MenuItem::with_id(app, "countdown", "倒计时 未运行", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示主面板", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏小组件", true, None::<&str>)?;
    let always_top = MenuItem::with_id(app, "always-top", "置顶显示", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let new_task = MenuItem::with_id(app, "new-task", "新建任务", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-pomodoro", "开始/暂停专注", true, None::<&str>)?;
    let backup = MenuItem::with_id(app, "backup", "立即备份", true, None::<&str>)?;
    // [SNIP] 截图：冻结帧框选 + 标注 + 钉图。
    let screenshot = MenuItem::with_id(app, "screenshot", "截图", true, None::<&str>)?;
    // [SYS]：回桌面快捷动作。
    let show_desktop = MenuItem::with_id(app, "show-desktop", "显示桌面", true, None::<&str>)?;

    // 显示器子菜单单独构建并挂到 AppState；热插拔时 refresh_monitor_menu
    // 清空重填，避免菜单项指向已销毁的 widget-N。
    let monitor_menu = build_monitor_submenu(app.handle())?;

    // 「任务栏外观」子菜单——总开关勾选项（勾选态按模式 C 从设置
    // 镜像 general.taskbar.enabled 读，与 injector::start_enabled 的自动起注入判定
    // 同源）+ 重置动态状态。句柄挂到模块静态供翻转 / sync 回填。：文案随
    // 镜像 general.language（构建时定稿，语言切换后下次启动生效——托盘菜单无
    // 热重建机制，与既有菜单项口径一致）。
    let labels = taskbar_menu_text(app.handle());
    let taskbar_enabled = read_taskbar_enabled(app.handle());
    *TASKBAR_ENABLED.lock().unwrap_or_else(|p| p.into_inner()) = Some(taskbar_enabled);
    let taskbar_toggle = CheckMenuItem::with_id(
        app,
        "taskbar-enabled",
        labels.toggle,
        true,
        taskbar_enabled,
        None::<&str>,
    )?;
    let taskbar_reset =
        MenuItem::with_id(app, "taskbar-reset-state", labels.reset, true, None::<&str>)?;
    let taskbar_menu = Submenu::with_items(
        app,
        labels.submenu,
        true,
        &[&taskbar_toggle, &taskbar_reset],
    )?;

    // [ANTICAPTURE]：防屏幕捕获勾选项（初始态从设置镜像 extra.antiCapture 读，
    // 默认关）。文案随语言（同款：构建时定稿）。
    let english = language_is_english_value(read_mirror_json(app.handle()).as_ref());
    let anticapture_on = read_anticapture_enabled(app.handle());
    *ANTICAPTURE_ENABLED
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(anticapture_on);
    let anticapture_toggle = CheckMenuItem::with_id(
        app,
        "anticapture",
        if english {
            "Anti screen capture"
        } else {
            "防屏幕捕获"
        },
        true,
        anticapture_on,
        None::<&str>,
    )?;

    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &countdown_item,
            &show,
            &hide,
            &always_top,
            &monitor_menu,
            &taskbar_menu,
            &anticapture_toggle,
            &settings,
            &new_task,
            &toggle,
            &backup,
            &screenshot,
            &show_desktop,
            &quit,
        ],
    )?;
    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        // 托盘图标使用应用自身的图标（bundle 编译进二进制的默认窗口图标），
        // 此前未设置导致托盘显示 Tauri 默认图标。
        .tooltip("Vela");
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }
    tray_builder
        .on_tray_icon_event(|tray, event| {
            // 左键单击托盘：呼出设置窗口（与任务栏按钮行为一致）。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                windows::show_settings_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                for w in windows::all_widget_windows(app) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                // 显隐翻转即重采几何（隐藏窗口不参与命中，见 widget.rs），
                // 重显后立即恢复点击命中，不等 30s 兜底。
                crate::widget::refresh_geometry_all(app);
            }
            "hide" => {
                for w in windows::all_widget_windows(app) {
                    let _ = w.hide();
                }
                crate::widget::refresh_geometry_all(app);
            }
            id if id.starts_with("monitor-") => {
                if let Ok(index) = id.trim_start_matches("monitor-").parse::<u32>() {
                    // 命令面加了 require_trusted 闸门后，托盘（原生侧、
                    // 天然受信）直调实现体。
                    let _ = monitor::set_monitor_impl(app, index);
                }
            }
            "always-top" => {
                let top = windows::all_widget_windows(app)
                    .first()
                    .and_then(|w| w.is_always_on_top().ok())
                    .unwrap_or(false);
                let next = !top;
                // 托盘切换也要写回 AppState：否则 get_widget_state 与
                // 之后热插拔新建的窗口都会用旧偏好，层级不一致。
                if let Some(state) = app.try_state::<AppState>() {
                    *state
                        .always_on_top
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = next;
                }
                for w in windows::all_widget_windows(app) {
                    if next {
                        // 与 widget.rs set_always_on_top 同款修复——widget
                        // 窗口出厂沉底，tao 每次窗口位置变化都把沉底窗口压回
                        // HWND_BOTTOM；不清 always_on_bottom 直接置顶永不生效
                        //（windows.rs summon_palette_window 的正确顺序）。
                        let _ = w.set_always_on_bottom(false);
                    }
                    let _ = w.set_always_on_top(next);
                    // 关闭置顶时把窗口送回桌面层（出生时的层级），
                    // 而不是让它停在普通窗口 band 里浮在桌面上。
                    if !next {
                        let _ = w.set_always_on_bottom(true);
                    }
                }
            }
            "settings" => {
                windows::show_settings_window(app);
            }
            "new-task" => {
                let _ = app.emit("tray:new-task", ());
            }
            "toggle-pomodoro" => {
                let _ = app.emit("tray:toggle-pomodoro", ());
            }
            "backup" => {
                let _ = app.emit("tray:backup", ());
            }
            // [SNIP] 抓光标所在显示器并弹覆盖窗（同快捷键 screenshot 动作）。
            "screenshot" => crate::snip::start_snip_internal(app),
            // [SYS]回桌面：模拟 Win+D。SendInput 不在托盘
            // 事件线程上做（按键注入偶发阻塞会拖住整个菜单分派）。
            "show-desktop" => {
                std::thread::spawn(crate::sys_actions::send_desktop_blocking);
            }
            // 任务栏外观：与快捷键 taskbar:toggle / taskbar:reset-state 同入口。
            "taskbar-enabled" => toggle_taskbar_enabled(app),
            "taskbar-reset-state" => reset_taskbar_state(app),
            // [ANTICAPTURE]：翻转勾选态并广播，落盘链路由 widget-0 前端完成。
            "anticapture" => toggle_anticapture_enabled(app),
            "quit" => {
                ALLOW_EXIT.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // 把菜单项句柄挂到 AppState，供 set_tray_countdown 命令刷新文本。
    // 显示器子菜单句柄同理挂载，供 refresh_monitor_menu 热插拔重建。
    // 锁中毒时静默跳过会让句柄永远挂不上、倒计时永不显示，
    // 改为 into_inner 恢复（与全库 lock_db 的 poison 策略一致）。
    if let Some(state) = app.try_state::<AppState>() {
        *state
            .tray_countdown
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(countdown_item);
        *state.monitor_menu.lock().unwrap_or_else(|p| p.into_inner()) = Some(monitor_menu);
    }

    // 勾选项句柄挂到模块静态（AppState 字段属 lib.rs，此处不改）。
    *TASKBAR_CHECK.lock().unwrap_or_else(|p| p.into_inner()) = Some(taskbar_toggle);
    // [ANTICAPTURE]：勾选项句柄同理挂模块静态。
    *ANTICAPTURE_CHECK.lock().unwrap_or_else(|p| p.into_inner()) = Some(anticapture_toggle);
    // 设置页翻转总开关 → 前端 80ms 防抖广播 sync:settings（快照含 general.taskbar）
    // → 回填勾选态。托盘自身翻转经设置窗 setTaskbar 也会绕回一次同值广播，幂等；
    // 载荷缺该字段（旧版本 / 局部快照）时不动状态。
    app.listen_any(SYNC_SETTINGS_EVENT, |event| {
        if let Some(enabled) = taskbar_enabled_in_settings_json(event.payload()) {
            remember_taskbar_enabled(enabled);
        }
        if let Some(enabled) = crate::anticapture::anti_capture_in_settings_json(event.payload()) {
            remember_anticapture_enabled(enabled);
        }
    });
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 任务栏外观：总开关翻转 / 重置动态状态（托盘与快捷键共用）。
 * ------------------------------------------------------------------ */

/// 翻转任务栏总开关。勾选态与 [`TASKBAR_ENABLED`] 即时更新；镜像回写与引擎
/// apply 交后台线程（apply 等注入就绪最多 10s）。
///
/// 原实现「先 `store_config` 存底、后 apply」违反命令层的
/// 不变量（存底=已生效）——apply 失败时 `CURRENT_CONFIG` 已是新值，
/// 设置窗对账 `get == 本地` 恒相等，失败态永远不会重试。现改为：镜像只改
/// JSON（不碰存底），apply 的存底交给 `apply_config` 成功路径自己完成。
///
/// 同步事件 [`TRAY_TASKBAR_ENABLED_EVENT`] 在镜像 JSON 回写之后 emit——
/// 先 emit 时设置窗 `TaskbarConfigSync` 可能抢在对账前读到旧镜像。消费者是
/// widget-0（此前只有设置窗消费，而设置窗「关闭即销毁」，托盘翻转发生
/// 在设置窗不在时 localStorage 权威源不更新，重启后被 reconcile 用陈旧 LS
/// 反向覆盖镜像——用户操作被静默撤销）。apply 失败时设置窗对账 get(旧) vs
/// LS(新) 不等会自动补一次 apply，正是需要的重试路径。
pub(crate) fn toggle_taskbar_enabled(app: &tauri::AppHandle) {
    let next = {
        let mut guard = TASKBAR_ENABLED.lock().unwrap_or_else(|p| p.into_inner());
        let next = !guard.unwrap_or_else(|| read_taskbar_enabled(app));
        *guard = Some(next);
        next
    };
    set_taskbar_checked(next);
    // ②：worker 用克隆，原始引用保留给 spawn 失败分支的回滚（此前直接
    // 遮蔽外层 `app`，spawn 失败时引用已被 move 进闭包而不可用）。
    let app_worker = app.clone();
    let spawned = std::thread::Builder::new()
        .name("vela-taskbar-toggle".to_string())
        .spawn(move || {
            let _serial = TASKBAR_APPLY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            // 翻转基底优先取镜像（自启与设置页同源）；镜像不可用（备份/
            // 导入持写锁、首启未落盘）时退回引擎当前生效配置——绝不再从出厂
            // 默认起建，否则一次镜像锁超时就会把七态/规则/忽略表全部顶掉。
            let mut cfg = toggle_base_config(&app_worker);
            cfg.enabled = next;
            // widget-0 setTaskbar：localStorage 权威源落盘（重启 hydrate 以它为准，
            // 见 settings-store 语义）+ 350ms 防抖镜像 + 既有 sync:settings
            // 跨窗口同步。存底未先行——见上 说明。
            write_taskbar_enabled_to_mirror(&app_worker, next);
            if let Err(e) = app_worker.emit(TRAY_TASKBAR_ENABLED_EVENT, next) {
                log::warn!("taskbar tray: emit {TRAY_TASKBAR_ENABLED_EVENT} failed: {e}");
            }
            match crate::taskbar::injector::apply_config(&cfg) {
                Ok(notes) if notes.is_empty() => {
                    log::info!("taskbar tray: enabled={next} applied");
                }
                Ok(notes) => log::info!(
                    "taskbar tray: enabled={next} applied with notes: {}",
                    notes.join("；")
                ),
                Err(e) => {
                    log::warn!("taskbar tray: enabled={next} apply failed: {e}");
                    // apply 失败回滚乐观翻转（内存开关 / 托盘勾选 / 镜像 /
                    // 事件）——否则勾选态与真实状态错位到下一次翻转；设置窗对账
                    // 也以回滚后的镜像为准，不再依赖「不等即重试」的错位态。
                    let prev = !next;
                    {
                        let mut guard = TASKBAR_ENABLED.lock().unwrap_or_else(|p| p.into_inner());
                        *guard = Some(prev);
                    }
                    set_taskbar_checked(prev);
                    write_taskbar_enabled_to_mirror(&app_worker, prev);
                    if let Err(ee) = app_worker.emit(TRAY_TASKBAR_ENABLED_EVENT, prev) {
                        log::warn!(
                            "taskbar tray: emit rollback {TRAY_TASKBAR_ENABLED_EVENT} failed: {ee}"
                        );
                    }
                }
            }
        });
    if let Err(e) = spawned {
        // ②：spawn 失败同 口径回滚乐观翻转（内存开关/托盘勾选/镜像/
        // 事件）——上方三步在 spawn 前已执行，不回滚则勾选态与真实状态错位到
        // 下一次翻转且无任何 apply/重试发生。
        log::warn!("taskbar tray: spawn toggle worker failed: {e}; rolling back optimistic flip");
        let prev = !next;
        {
            let mut guard = TASKBAR_ENABLED.lock().unwrap_or_else(|p| p.into_inner());
            *guard = Some(prev);
        }
        set_taskbar_checked(prev);
        write_taskbar_enabled_to_mirror(app, prev);
        if let Err(ee) = app.emit(TRAY_TASKBAR_ENABLED_EVENT, prev) {
            log::warn!("taskbar tray: emit rollback {TRAY_TASKBAR_ENABLED_EVENT} failed: {ee}");
        }
    }
}

/// 翻转的基底配置：镜像 JSON 可读且非空 → 与自启/设置页同源的解析；
/// 否则退回引擎当前生效配置（`current_config`，从未 apply 过时为默认值）。
/// 两条路径都拿不到完整配置时也只是「默认值 + 开关」，不再出现「镜像锁
/// 超时 → 近默认配置直接 apply 覆盖用户外观」的路径。
fn toggle_base_config(app: &tauri::AppHandle) -> crate::taskbar::TaskbarSettings {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(conn) = crate::db::lock_db(&state.db) {
            if let Some(json) = SettingsRepo::get(&conn, SETTINGS_MIRROR_KEY).ok().flatten() {
                if !json.trim().is_empty() {
                    return crate::taskbar::parse_taskbar_config(&json);
                }
            }
        }
    }
    crate::taskbar::current_config()
}

/// 重置任务栏动态状态：立即重求值全部显示器并重下发（引擎 `reset_state`，含带
/// 超时的管道写，故后台线程；与翻转共用串行锁，避免与在飞 apply 交错）。
pub(crate) fn reset_taskbar_state(_app: &tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("vela-taskbar-reset".to_string())
        .spawn(|| {
            let _serial = TASKBAR_APPLY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            match crate::taskbar::injector::reset_state() {
                Ok(()) => log::info!("taskbar tray: reset_state ok"),
                Err(e) => log::warn!("taskbar tray: reset_state failed: {e}"),
            }
        });
    if let Err(e) = spawned {
        log::warn!("taskbar tray: spawn reset worker failed: {e}");
    }
}

/// 记住设置页广播来的开关值并回填勾选态（`sync:settings` 监听）。
fn remember_taskbar_enabled(enabled: bool) {
    *TASKBAR_ENABLED.lock().unwrap_or_else(|p| p.into_inner()) = Some(enabled);
    set_taskbar_checked(enabled);
}

/* ------------------------------------------------------------------ *
 * [ANTICAPTURE] 防屏幕捕获：托盘翻转（勾选态即时翻转 → widget-0 落盘链）。
 * ------------------------------------------------------------------ */

/// 翻转防捕获开关：勾选态即时更新并广播 [`TRAY_ANTICAPTURE_EVENT`]，由
/// widget-0 的 tray-events.ts `setExtra({ antiCapture })` 完成 localStorage
/// 权威源 + SQLite 镜像落盘；Rust 侧 anticapture watcher 随镜像变更对全部
/// 窗口重放 / 解除 display affinity（无需在此直接写镜像）。
fn toggle_anticapture_enabled(app: &tauri::AppHandle) {
    let next = {
        let mut guard = ANTICAPTURE_ENABLED
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let next = !guard.unwrap_or_else(|| read_anticapture_enabled(app));
        *guard = Some(next);
        next
    };
    set_anticapture_checked(next);
    if let Err(e) = app.emit(TRAY_ANTICAPTURE_EVENT, next) {
        log::warn!("anticapture tray: emit {TRAY_ANTICAPTURE_EVENT} failed: {e}");
    }
}

/// 设置页广播回填（`sync:settings` 载荷含 `extra.antiCapture` 时）。
fn remember_anticapture_enabled(enabled: bool) {
    *ANTICAPTURE_ENABLED
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(enabled);
    set_anticapture_checked(enabled);
}

/// 勾选项 set_checked（句柄先克隆出锁外，与 set_taskbar_checked 同款）。
fn set_anticapture_checked(enabled: bool) {
    let item = ANTICAPTURE_CHECK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(item) = item {
        if let Err(e) = item.set_checked(enabled) {
            log::warn!("anticapture tray: set_checked({enabled}) failed: {e}");
        }
    }
}

/// 从设置镜像读 `extra.antiCapture`（缺失 / 失败 → false，默认关）。
fn read_anticapture_enabled(app: &tauri::AppHandle) -> bool {
    read_mirror_json(app)
        .as_ref()
        .and_then(|v| v.get("extra")?.get("antiCapture")?.as_bool())
        .unwrap_or(false)
}

/// 勾选项 set_checked（句柄先克隆出锁外：set_checked 可能派发到主线程等待）。
fn set_taskbar_checked(enabled: bool) {
    let item = TASKBAR_CHECK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(item) = item {
        if let Err(e) = item.set_checked(enabled) {
            log::warn!("taskbar tray: set_checked({enabled}) failed: {e}");
        }
    }
}

/// 模式 C：从设置镜像读 `general.taskbar.enabled`（任何缺失 / 失败 → false，
/// 默认关；解析口径与 injector::start_enabled 同为 `parse_taskbar_config`）。
/// 走 read_db 独立连接：备份 / 导入持写锁期间不阻塞。
fn read_taskbar_enabled(app: &tauri::AppHandle) -> bool {
    read_mirror_json(app)
        .map(|v| crate::taskbar::parse_taskbar_value(&v).enabled)
        .unwrap_or(false)
}

/// 读设置镜像原文（`app:settings:v1`，任何失败 → None）。
/// 读取收敛到 settings_mirror 单一助手（返回已解析 JSON）。
fn read_mirror_json(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    crate::settings_mirror::read_json(app)
}

/// 任务栏子菜单文案。
struct TaskbarMenuText {
    submenu: &'static str,
    toggle: &'static str,
    reset: &'static str,
}

const TASKBAR_MENU_ZH: TaskbarMenuText = TaskbarMenuText {
    submenu: "任务栏外观",
    toggle: "自定义任务栏外观",
    reset: "重置动态状态",
};

const TASKBAR_MENU_EN: TaskbarMenuText = TaskbarMenuText {
    submenu: "Taskbar appearance",
    toggle: "Customize taskbar appearance",
    reset: "Reset dynamic state",
};

/// 镜像快照 JSON 里的 `general.language` 是否为 English（纯函数；
/// 缺失 / 非 JSON / 其他值 → false，默认简体中文）。
pub(crate) fn language_is_english_value(value: Option<&serde_json::Value>) -> bool {
    let null = serde_json::Value::Null;
    value
        .unwrap_or(&null)
        .get("general")
        .and_then(|g| g.get("language"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|s| s == "English")
}

/// 字符串形态包装（单测用：测试构造 JSON 文本比构造 Value 简洁）。
#[cfg(test)]
fn language_is_english(mirror_json: Option<&str>) -> bool {
    let value = mirror_json
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .unwrap_or(serde_json::Value::Null);
    language_is_english_value(Some(&value))
}

fn taskbar_menu_text(app: &tauri::AppHandle) -> TaskbarMenuText {
    if language_is_english_value(read_mirror_json(app).as_ref()) {
        TASKBAR_MENU_EN
    } else {
        TASKBAR_MENU_ZH
    }
}

/// 镜像 JSON 回写（模式 C 的反向）：读快照 → 改 `general.taskbar.enabled` →
/// 写回。：**只改 JSON**——配置存底（`get_taskbar_config` 对账读的那份）由
/// `injector::apply_config` 的成功路径完成（「存底=已生效」）；此处提前
/// store_config 会让 apply 失败也留下「对账恒等」的假成功。走写连接 `db`
/// （备份 / 导入期间可能等锁，故只在后台线程调用）。
fn write_taskbar_enabled_to_mirror(app: &tauri::AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(conn) = crate::db::lock_db(&state.db) {
            let current = SettingsRepo::get(&conn, SETTINGS_MIRROR_KEY).ok().flatten();
            let next = with_taskbar_enabled(current.as_deref(), enabled);
            if let Err(e) = SettingsRepo::set(&conn, SETTINGS_MIRROR_KEY, &next) {
                log::warn!("taskbar tray: mirror write failed: {e}");
            }
        } else {
            log::warn!("taskbar tray: mirror lock failed");
        }
    }
}

/// 从设置快照 JSON（镜像 `app:settings:v1` 或 `sync:settings` 载荷，`general` 均在
/// 根上）提取 `general.taskbar.enabled`；缺失 / 非布尔 / 非 JSON → None（调用方
/// 不动状态，与 `parse_taskbar_config` 的「缺失回默认 false」口径不同：这里是
/// 增量回填，不能把局部快照当成「关」）。
pub(crate) fn taskbar_enabled_in_settings_json(json: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("general")?.get("taskbar")?.get("enabled")?.as_bool()
}

/// 在设置快照 JSON 上改写 `general.taskbar.enabled`，其余字段原样保留；快照缺失 /
/// 非 JSON / 非对象时从空对象起建（前端 sanitize 会把残缺的 taskbar 补齐为默认 +
/// 该开关，hydrate 时 localStorage 仍是权威源）。
pub(crate) fn with_taskbar_enabled(json: Option<&str>, enabled: bool) -> String {
    let mut root = json
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();
    ensure_object(ensure_object(&mut root, "general"), "taskbar")
        .insert("enabled".to_string(), serde_json::Value::Bool(enabled));
    serde_json::Value::Object(root).to_string()
}

/// 取 `parent[key]` 为对象（缺失 / 非对象则置为空对象）并返回其可变引用。
fn ensure_object<'a>(
    parent: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    let slot = parent
        .entry(key)
        .or_insert_with(|| serde_json::Value::Object(Default::default()));
    if !slot.is_object() {
        *slot = serde_json::Value::Object(Default::default());
    }
    slot.as_object_mut()
        .expect("slot was just ensured to be an object")
}

/// 按当前连接的显示器构建"显示器"子菜单（每个显示器一个 monitor-* 项）。
/// `build_tray` 启动时调用一次；热插拔时 `refresh_monitor_menu` 在既有子菜单上
/// 原地清空重填，保证父菜单持有的是同一个 Submenu 句柄。
///
/// 菜单 id 必须用 resolve_monitor_slots 的稳定槽位而非枚举
/// 下标——widget 窗口按持久化的稳定槽位创建（widget-<slot>），显示器枚举
/// 顺序与槽位不一致时（重启换序/热插拔后极常见），点击"显示器 2"会聚焦
/// 另一块屏的 widget 层或直接报"不存在"。
fn build_monitor_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let slots = monitor::resolve_monitor_slots(app, &app.available_monitors().unwrap_or_default());
    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::with_capacity(slots.len());
    for (slot, m) in &slots {
        let name = m
            .name()
            .cloned()
            .unwrap_or_else(|| format!("显示器 {}", slot + 1));
        let item = MenuItem::with_id(app, format!("monitor-{slot}"), name, true, None::<&str>)?;
        items.push(item);
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    Submenu::with_items(app, "显示器", true, &refs)
}

/// 显示器热插拔后，在既有"显示器"子菜单上清空并按当前 monitors 重填。
/// 必须跑在主线程（monitor 监听线程经 `run_on_main_thread` 调用）。菜单项 id
/// 仍是 `monitor-{i}`，`build_tray` 里注册的 `on_menu_event` 按 id 前缀匹配，
/// 因此新项无需重新绑定即可正常路由。
pub fn refresh_monitor_menu(app: &tauri::AppHandle) {
    let sub = match app.try_state::<AppState>() {
        // RUST-3：中毒锁恢复（全仓范式：set_tray_countdown / db.rs lock_db
        // 同款）——此前的 `Err(_) => return` 会让显示器热插拔后的托盘子菜单
        // 从此不再刷新且无痕（静默放弃与全仓恢复范式单点不一致）。
        Some(state) => {
            let slot = state
                .monitor_menu
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match slot.as_ref() {
                Some(s) => s.clone(),
                None => return,
            }
        }
        None => return,
    };
    // 清空现有子项。remove_at(0) 逐个弹出，直到空。
    while let Ok(Some(_)) = sub.remove_at(0) {}
    // 与 build_monitor_submenu 一致，按稳定槽位生成菜单 id。
    let slots = monitor::resolve_monitor_slots(app, &app.available_monitors().unwrap_or_default());
    for (slot, m) in &slots {
        let name = m
            .name()
            .cloned()
            .unwrap_or_else(|| format!("显示器 {}", slot + 1));
        let item = match MenuItem::with_id(app, format!("monitor-{slot}"), name, true, None::<&str>)
        {
            Ok(item) => item,
            Err(e) => {
                log::warn!("build monitor menu item failed: {e}");
                continue;
            }
        };
        if let Err(e) = sub.append(&item) {
            log::warn!("append monitor menu item failed: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_is_english_only_for_explicit_english() {
        assert!(language_is_english(Some(
            r#"{"general":{"language":"English","taskbar":{"enabled":true}}}"#
        )));
        assert!(!language_is_english(Some(
            r#"{"general":{"language":"简体中文"}}"#
        )));
        // 缺字段 / 类型错 / 非 JSON / None → 默认中文。
        assert!(!language_is_english(Some(r#"{"general":{}}"#)));
        assert!(!language_is_english(Some(
            r#"{"general":{"language":"en"}}"#
        )));
        assert!(!language_is_english(Some(r#"{"general":{"language":1}}"#)));
        assert!(!language_is_english(Some("{oops")));
        assert!(!language_is_english(None));
    }

    #[test]
    fn taskbar_enabled_extracts_only_explicit_bool() {
        // 镜像快照 / sync:settings 载荷（多一个 instanceId）同形，都能读到开关。
        let mirror = r#"{"preset":"glass","general":{"language":"简体中文","taskbar":{"enabled":true,"perMonitor":false}}}"#;
        assert_eq!(taskbar_enabled_in_settings_json(mirror), Some(true));
        let sync =
            r#"{"instanceId":"win-1","general":{"taskbar":{"enabled":false}},"shortcuts":{}}"#;
        assert_eq!(taskbar_enabled_in_settings_json(sync), Some(false));
        // 缺字段 / 类型错 / 非 JSON → None（增量回填不得把局部快照当「关」）。
        assert_eq!(taskbar_enabled_in_settings_json(r#"{"general":{}}"#), None);
        assert_eq!(
            taskbar_enabled_in_settings_json(r#"{"general":{"taskbar":{}}}"#),
            None
        );
        assert_eq!(
            taskbar_enabled_in_settings_json(r#"{"general":{"taskbar":{"enabled":"yes"}}}"#),
            None
        );
        assert_eq!(
            taskbar_enabled_in_settings_json(r#"{"preset":"glass"}"#),
            None
        );
        assert_eq!(taskbar_enabled_in_settings_json("{oops"), None);
        assert_eq!(taskbar_enabled_in_settings_json(""), None);
        assert_eq!(taskbar_enabled_in_settings_json("[]"), None);
    }

    #[test]
    fn with_taskbar_enabled_flips_flag_and_keeps_everything_else() {
        let mirror = r##"{"preset":"glass","zoom":1.2,"general":{"language":"English","clipboard":{"enabled":true},
            "taskbar":{"enabled":false,"perMonitor":true,"states":{"desktop":{"accent":"acrylic","color":"#08c"}},
            "ignoredWindows":{"classes":["X"],"titles":[],"processes":["a.exe"]}}},"shortcuts":{"new-task":"Ctrl+Alt+N"}}"##;
        let out = with_taskbar_enabled(Some(mirror), true);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // 目标字段翻转。
        assert_eq!(v["general"]["taskbar"]["enabled"], serde_json::json!(true));
        assert_eq!(taskbar_enabled_in_settings_json(&out), Some(true));
        // 兄弟字段 / 上层字段 / 任务栏其余字段全部保留。
        assert_eq!(v["preset"], "glass");
        assert_eq!(v["zoom"], 1.2);
        assert_eq!(v["general"]["language"], "English");
        assert_eq!(v["general"]["clipboard"]["enabled"], true);
        assert_eq!(v["general"]["taskbar"]["perMonitor"], true);
        assert_eq!(
            v["general"]["taskbar"]["states"]["desktop"]["accent"],
            "acrylic"
        );
        assert_eq!(
            v["general"]["taskbar"]["ignoredWindows"]["processes"][0],
            "a.exe"
        );
        assert_eq!(v["shortcuts"]["new-task"], "Ctrl+Alt+N");
        // 改写后的快照可被引擎侧同一条容错解析读回：开关生效，其余沿用镜像。
        let cfg = crate::taskbar::parse_taskbar_config(&out);
        assert!(cfg.enabled);
        assert!(cfg.per_monitor);
        assert_eq!(
            cfg.states.desktop.appearance.accent,
            crate::taskbar::TaskbarAccent::Acrylic
        );
        assert_eq!(cfg.ignored_windows.classes, ["X"]);
        // 再翻回去幂等。
        let back = with_taskbar_enabled(Some(&out), false);
        assert_eq!(taskbar_enabled_in_settings_json(&back), Some(false));
        assert!(!crate::taskbar::parse_taskbar_config(&back).enabled);
    }

    #[test]
    fn with_taskbar_enabled_builds_missing_path_and_repairs_bad_types() {
        // 镜像尚不存在（首次运行未保存过设置）→ 最小快照。
        let out = with_taskbar_enabled(None, true);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&out).unwrap(),
            serde_json::json!({"general":{"taskbar":{"enabled":true}}})
        );
        assert!(crate::taskbar::parse_taskbar_config(&out).enabled);
        // 非 JSON / 非对象根 → 同样从空对象起建，不 panic。
        for bad in ["", "{oops", "[]", "42", "\"str\""] {
            assert_eq!(
                taskbar_enabled_in_settings_json(&with_taskbar_enabled(Some(bad), true)),
                Some(true),
                "{bad:?}"
            );
        }
        // 缺 general / 缺 taskbar / general 或 taskbar 类型错 → 补建为对象，兄弟字段保留。
        let out = with_taskbar_enabled(Some(r#"{"preset":"glass"}"#), false);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["preset"], "glass");
        assert_eq!(v["general"]["taskbar"]["enabled"], false);
        let out = with_taskbar_enabled(Some(r#"{"general":{"language":"English"}}"#), true);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["general"]["language"], "English");
        assert_eq!(v["general"]["taskbar"]["enabled"], true);
        let out = with_taskbar_enabled(Some(r#"{"general":7}"#), true);
        assert_eq!(taskbar_enabled_in_settings_json(&out), Some(true));
        let out = with_taskbar_enabled(Some(r#"{"general":{"taskbar":"nope"}}"#), true);
        assert_eq!(taskbar_enabled_in_settings_json(&out), Some(true));
    }
}
