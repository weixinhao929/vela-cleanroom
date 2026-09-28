//! 系统托盘：菜单构建、事件处理与倒计时项挂载。从 lib.rs 拆出。
//!
//! [TB-TRAY]（F-11）「任务栏外观」子菜单：勾选项「自定义任务栏外观」+「重置动态
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

/// 构建托盘图标与菜单，并把倒计时菜单项句柄挂到 AppState
/// （供 commands::set_tray_countdown 刷新文本）。
pub fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    // W-030：菜单顶部固定一条禁用项，展示倒计时剩余时间（无计时=隐藏文案）。
    let countdown_item = MenuItem::with_id(app, "countdown", "倒计时 未运行", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示主面板", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏小组件", true, None::<&str>)?;
    let always_top = MenuItem::with_id(app, "always-top", "置顶显示", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let new_task = MenuItem::with_id(app, "new-task", "新建任务", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-pomodoro", "开始/暂停专注", true, None::<&str>)?;
    let backup = MenuItem::with_id(app, "backup", "立即备份", true, None::<&str>)?;
    // [SNIP] 截图（借鉴 ClassSoftwareHub #4）：冻结帧框选 + 标注 + 钉图。
    let screenshot = MenuItem::with_id(app, "screenshot", "截图", true, None::<&str>)?;
    // [SYS]（借鉴 ClassSoftwareHub #10）：回桌面快捷动作。
    let show_desktop = MenuItem::with_id(app, "show-desktop", "显示桌面", true, None::<&str>)?;

    // C-16：显示器子菜单单独构建并挂到 AppState；热插拔时 refresh_monitor_menu
    // 清空重填，避免菜单项指向已销毁的 widget-N。
    let monitor_menu = build_monitor_submenu(app.handle())?;

    // [TB-TRAY] F-11：「任务栏外观」子菜单——总开关勾选项（勾选态按模式 C 从设置
    // 镜像 general.taskbar.enabled 读，与 injector::start_enabled 的自动起注入判定
    // 同源）+ 重置动态状态。句柄挂到模块静态供翻转 / sync 回填。F-17：文案随
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
            }
            "hide" => {
                for w in windows::all_widget_windows(app) {
                    let _ = w.hide();
                }
            }
            id if id.starts_with("monitor-") => {
                if let Ok(index) = id.trim_start_matches("monitor-").parse::<u32>() {
                    let _ = monitor::set_monitor(app.clone(), index);
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
            // [SYS]（借鉴 CSH #10）回桌面：模拟 Win+D。SendInput 不在托盘
            // 事件线程上做（按键注入偶发阻塞会拖住整个菜单分派）。
            "show-desktop" => {
                std::thread::spawn(crate::sys_actions::send_desktop_blocking);
            }
            // [TB-TRAY] 任务栏外观：与快捷键 taskbar:toggle / taskbar:reset-state 同入口。
            "taskbar-enabled" => toggle_taskbar_enabled(app),
            "taskbar-reset-state" => reset_taskbar_state(app),
            "quit" => {
                ALLOW_EXIT.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // W-030：把菜单项句柄挂到 AppState，供 set_tray_countdown 命令刷新文本。
    // C-16：显示器子菜单句柄同理挂载，供 refresh_monitor_menu 热插拔重建。
    // R7（审计）：锁中毒时静默跳过会让句柄永远挂不上、倒计时永不显示，
    // 改为 into_inner 恢复（与全库 lock_db 的 poison 策略一致）。
    if let Some(state) = app.try_state::<AppState>() {
        *state
            .tray_countdown
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(countdown_item);
        *state.monitor_menu.lock().unwrap_or_else(|p| p.into_inner()) = Some(monitor_menu);
    }

    // [TB-TRAY]：勾选项句柄挂到模块静态（AppState 字段属 lib.rs，本会话不改）。
    *TASKBAR_CHECK.lock().unwrap_or_else(|p| p.into_inner()) = Some(taskbar_toggle);
    // 设置页翻转总开关 → 前端 80ms 防抖广播 sync:settings（快照含 general.taskbar）
    // → 回填勾选态。托盘自身翻转经设置窗 setTaskbar 也会绕回一次同值广播，幂等；
    // 载荷缺该字段（旧版本 / 局部快照）时不动状态。
    app.listen_any(SYNC_SETTINGS_EVENT, |event| {
        if let Some(enabled) = taskbar_enabled_in_settings_json(event.payload()) {
            remember_taskbar_enabled(enabled);
        }
    });
    Ok(())
}

/* ------------------------------------------------------------------ *
 * [TB-TRAY] 任务栏外观：总开关翻转 / 重置动态状态（托盘与快捷键共用）。
 * ------------------------------------------------------------------ */

/// 翻转任务栏总开关。勾选态与 [`TASKBAR_ENABLED`] 即时更新；镜像回写与引擎
/// apply 交后台线程（apply 等注入就绪最多 10s）。
///
/// T-17：设置窗同步事件 [`TRAY_TASKBAR_ENABLED_EVENT`] 在**镜像回写 + 配置存底
/// 完成之后**才 emit——先 emit 时设置窗 `TaskbarConfigSync` 可能抢在存底前对账
/// `get_taskbar_config` 读到旧值而二次 apply；apply 虽幂等，顺序上以存底先行
/// 收敛为单次。
pub(crate) fn toggle_taskbar_enabled(app: &tauri::AppHandle) {
    let next = {
        let mut guard = TASKBAR_ENABLED.lock().unwrap_or_else(|p| p.into_inner());
        let next = !guard.unwrap_or_else(|| read_taskbar_enabled(app));
        *guard = Some(next);
        next
    };
    set_taskbar_checked(next);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("vela-taskbar-toggle".to_string())
        .spawn(move || {
            let _serial = TASKBAR_APPLY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let cfg = write_taskbar_enabled_to_mirror(&app, next);
            // 设置窗 setTaskbar：localStorage 权威源落盘（重启 hydrate 以它为准，
            // 见 settings-store P8 语义）+ 350ms 防抖镜像 + 既有 sync:settings 跨窗口
            // 同步。此刻配置存底已完成，对账读到的是新值。
            if let Err(e) = app.emit(TRAY_TASKBAR_ENABLED_EVENT, next) {
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
                Err(e) => log::warn!("taskbar tray: enabled={next} apply failed: {e}"),
            }
        });
    if let Err(e) = spawned {
        log::warn!("taskbar tray: spawn toggle worker failed: {e}");
    }
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

/// 模式 C：从设置镜像读 `general.taskbar.enabled`（任何缺失 / 失败 → false，D1
/// 默认关；解析口径与 injector::start_enabled 同为 `parse_taskbar_config`）。
/// 走 read_db 独立连接：备份 / 导入持写锁期间不阻塞。
fn read_taskbar_enabled(app: &tauri::AppHandle) -> bool {
    read_mirror_json(app)
        .map(|v| crate::taskbar::parse_taskbar_value(&v).enabled)
        .unwrap_or(false)
}

/// 读设置镜像原文（`app:settings:v1`，任何失败 → None）。
/// A-4：读取收敛到 settings_mirror 单一助手（返回已解析 JSON）。
fn read_mirror_json(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    crate::settings_mirror::read_json(app)
}

/// 任务栏子菜单文案（F-17）。
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

/// 镜像回写（模式 C 的反向）：读快照 → 改 `general.taskbar.enabled` → 写回，并把
/// 改写后的任务栏配置存底（`get_taskbar_config` 对账即刻可见）后返回给引擎
/// apply——其余字段（七态 / 规则 / 忽略表 / 多屏覆盖）沿用镜像。走写连接 `db`
/// （备份 / 导入期间可能等锁，故只在后台线程调用）。
fn write_taskbar_enabled_to_mirror(
    app: &tauri::AppHandle,
    enabled: bool,
) -> crate::taskbar::TaskbarSettings {
    let json = match app.try_state::<AppState>() {
        Some(state) => match crate::db::lock_db(&state.db) {
            Ok(conn) => {
                let current = SettingsRepo::get(&conn, SETTINGS_MIRROR_KEY).ok().flatten();
                let next = with_taskbar_enabled(current.as_deref(), enabled);
                if let Err(e) = SettingsRepo::set(&conn, SETTINGS_MIRROR_KEY, &next) {
                    log::warn!("taskbar tray: mirror write failed: {e}");
                }
                next
            }
            Err(e) => {
                log::warn!("taskbar tray: mirror lock failed: {e}");
                with_taskbar_enabled(None, enabled)
            }
        },
        None => with_taskbar_enabled(None, enabled),
    };
    let cfg = crate::taskbar::parse_taskbar_config(&json);
    crate::taskbar::store_config(&cfg);
    cfg
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
/// P1（审计修复）：菜单 id 必须用 resolve_monitor_slots 的稳定槽位而非枚举
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

/// C-16：显示器热插拔后，在既有"显示器"子菜单上清空并按当前 monitors 重填。
/// 必须跑在主线程（monitor 监听线程经 `run_on_main_thread` 调用）。菜单项 id
/// 仍是 `monitor-{i}`，`build_tray` 里注册的 `on_menu_event` 按 id 前缀匹配，
/// 因此新项无需重新绑定即可正常路由。
pub fn refresh_monitor_menu(app: &tauri::AppHandle) {
    let sub = match app.try_state::<AppState>() {
        Some(state) => match state.monitor_menu.lock() {
            Ok(slot) => match slot.as_ref() {
                Some(s) => s.clone(),
                None => return,
            },
            Err(_) => return,
        },
        None => return,
    };
    // 清空现有子项。remove_at(0) 逐个弹出，直到空。
    while let Ok(Some(_)) = sub.remove_at(0) {}
    // P1（审计修复）：与 build_monitor_submenu 一致，按稳定槽位生成菜单 id。
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
