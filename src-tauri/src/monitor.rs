//! Multi-monitor support: enumerate the available monitors, create one widget
//! window per display, and keep the window set in sync when displays are
//! hot-plugged / unplugged or change resolution.

use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tauri::{Emitter, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

/// D-审计修复：持久化「物理显示器 → 稳定槽位」映射的 settings 键。
/// `widget-<slot>` 窗口与前端 `#screen=<slot>` 布局分区都以槽位为键；
/// 没有这层映射时，热插拔/重启导致的枚举顺序变化会让两屏布局互换。
const MONITOR_SLOT_KEY: &str = "monitor:slots";

#[derive(Serialize)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// DPI 缩放比（1.0 = 100%）。设置页显示器卡片展示；物理分辨率与逻辑
    /// 分辨率的换算依据。
    pub scale: f64,
    pub is_primary: bool,
}

/// Returns the list of connected monitors with their virtual-screen positions.
/// `id` 是稳定槽位（跨重启/换序指向同一物理屏），不是本次枚举下标。
///
/// async + spawn_blocking：`resolve_monitor_slots` 会读写 SQLite 槽位表，
/// 同步命令在主线程上等锁会在备份/导入持锁期间冻结所有窗口（规则）。
#[tauri::command]
pub async fn list_monitors(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Vec<MonitorInfo>, String> {
    // 显示器拓扑属硬件枚举面，与 M3 族同标准收 enum 名单。
    if !crate::enum_system_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || list_monitors_blocking(&app))
        .await
        .map_err(|e| format!("显示器枚举任务失败：{e}"))?
}

fn list_monitors_blocking(app: &tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("无法枚举显示器: {e}"))?;
    let slotted = resolve_monitor_slots(app, &monitors);

    // 主屏判定按几何（位置+尺寸）比对而非按名字——两台同型号显示器
    // 的 EDID 名字可能重复，按名比较会把副屏也标成主屏（「复制主屏布局」
    // 的显隐随之错乱）。拓扑内两块屏不可能同位同尺寸，几何即唯一。
    let primary = app.primary_monitor().ok().flatten();

    let mut out = Vec::with_capacity(slotted.len());
    for (slot, monitor) in &slotted {
        let pos = monitor.position();
        let size = monitor.size();
        let name = monitor
            .name()
            .cloned()
            .unwrap_or_else(|| format!("显示器 {}", slot + 1));
        let is_primary = primary
            .as_ref()
            .map(|p| p.position() == pos && p.size() == size)
            .unwrap_or(false);
        out.push(MonitorInfo {
            id: *slot as u32,
            is_primary,
            name,
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            scale: monitor.scale_factor().max(1.0),
        });
    }

    Ok(out)
}

/// Loads the persisted {physical-name -> slot} map. Any failure (state not yet
/// managed, DB locked/poisoned, corrupt JSON) degrades to an empty map, i.e.
/// legacy enumeration-order behaviour for this one pass.
fn load_slot_map(app: &tauri::AppHandle) -> HashMap<String, usize> {
    let state = match app.try_state::<crate::AppState>() {
        Some(s) => s,
        None => return HashMap::new(),
    };
    // 读走 WAL 读连接：本函数经显示器热插拔的主线程拓扑同步调用，而写连接
    // 可能被备份/导入的整库长事务持锁——读者不阻塞，主线程不会冻结（冻结
    // 会让全部 webview 卡死、WH_MOUSE_LL 低级钩子因不泵消息被系统摘除）。
    let guard = match state.read_db.acquire() {
        Ok(g) => g,
        Err(_) => return HashMap::new(),
    };
    match crate::repositories::SettingsRepo::get(&guard, MONITOR_SLOT_KEY) {
        Ok(Some(raw)) => serde_json::from_str::<HashMap<String, usize>>(&raw).unwrap_or_default(),
        _ => HashMap::new(),
    }
}

/// Best-effort persist; a failed write only costs mapping continuity.
/// 写入挪后台线程：调用方（热插拔拓扑同步）在主线程上，写锁可能被
/// 备份/导入长事务持有，同步等待会冻结 UI（与 load 的读连接理由成对）。
fn save_slot_map(app: &tauri::AppHandle, map: &HashMap<String, usize>) {
    let app = app.clone();
    let map = map.clone();
    std::thread::spawn(move || {
        if let Some(state) = app.try_state::<crate::AppState>() {
            if let Ok(guard) = crate::db::lock_db(&state.db) {
                if let Ok(json) = serde_json::to_string(&map) {
                    if let Err(e) =
                        crate::repositories::SettingsRepo::set(&guard, MONITOR_SLOT_KEY, &json)
                    {
                        log::warn!("persisting monitor slot map failed: {e}");
                    }
                }
            }
        }
    });
}

/// Physical identity key for a monitor. Tauri exposes the display device name
/// on Windows/macOS; nameless adapters fall back to a geometry-derived tag so
/// they at least stay stable within a session.
fn monitor_key(m: &Monitor) -> String {
    match m.name() {
        Some(n) if !n.trim().is_empty() => n.clone(),
        _ => {
            let p = m.position();
            let s = m.size();
            format!("anon:{}x{}@{},{}", s.width, s.height, p.x, p.y)
        }
    }
}

/// Resolves the CURRENT enumeration into stable per-display slots:
/// known physical names keep their persisted slot, unseen displays take the
/// lowest free slot, stale entries are retained so re-plugging restores the
/// original assignment. Output is sorted by slot and pairs each slot with its
/// live Monitor handle.
pub fn resolve_monitor_slots(
    app: &tauri::AppHandle,
    monitors: &[Monitor],
) -> Vec<(usize, Monitor)> {
    let keys: Vec<String> = monitors.iter().map(monitor_key).collect();
    // Deduplicate pathological duplicate names by suffixing (#2, #3 …).
    let mut seen = HashMap::new();
    let unique_keys: Vec<String> = keys
        .into_iter()
        .map(|k| {
            let n = seen.entry(k.clone()).or_insert(0);
            *n += 1;
            if *n == 1 {
                k
            } else {
                format!("{k}#{}", *n - 1)
            }
        })
        .collect();

    let mut saved = load_slot_map(app);
    // Prune unbounded growth: drop stale entries beyond a sane display count.
    if saved.len() > 16 {
        saved.retain(|k, _| unique_keys.contains(k));
    }
    let saved_before = saved.clone();

    let by_key: HashMap<&String, &Monitor> = unique_keys.iter().zip(monitors.iter()).collect();
    let mut claimed: Vec<(usize, Monitor)> = assign_slots(&saved, &unique_keys)
        .into_iter()
        .map(|(k, slot)| (slot, by_key[k].clone()))
        .collect();
    claimed.sort_by_key(|(s, _)| *s);

    // Persist the full merged map (stale entries survive for future re-plugs).
    // reconcile 每次都走这里，拓扑没变时不再空写 SQLite（save 线程 +
    // WAL 写全免）。
    for (slot, m) in &claimed {
        saved.insert(monitor_key(m), *slot);
    }
    if saved != saved_before {
        save_slot_map(app, &saved);
    }
    claimed
}

/// 抽出的槽位分配纯函数（显示器增删同步状态机的核心，无持久化/句柄）：
///  - 已保存且该槽未被本轮占用 → 保住原槽（重插拔恢复原分配）；
///  - 其余（新屏，或保存表里两条撞同一槽的损坏态）→ 最低空闲槽；
///  - 输入 saved 只读：陈旧条目原样保留在调用方的持久化表里。
fn assign_slots<'a>(
    saved: &HashMap<String, usize>,
    keys: &'a [String],
) -> Vec<(&'a String, usize)> {
    let mut claimed: Vec<(&String, usize)> = Vec::new();
    let mut pending: Vec<&String> = Vec::new();
    for key in keys {
        match saved.get(key) {
            Some(&slot) if !claimed.iter().any(|(_, s)| *s == slot) => claimed.push((key, slot)),
            _ => pending.push(key),
        }
    }
    // Lowest free slot per unseen display.
    for key in pending {
        let mut slot = 0;
        while claimed.iter().any(|(_, s)| *s == slot) {
            slot += 1;
        }
        claimed.push((key, slot));
    }
    claimed
}

/// 判断某屏桌面层是否有内容，作为“空屏不建 widget 窗”的依据。数据源
/// 是前端 localStorage 权威源的 SQLite 镜像（每次布局/dock 落盘都同步镜像，
/// 见 widget-store 的 writeInstancesNow / saveDock）：
/// - `widget:layout:<N>:*`：任一布局数组非空 → 有内容（按前缀直接扫，
///   不依赖 `widget:views:<N>` 索引——views 镜像只在用户编辑视图清单时写，
///   布局镜像是每次布局落盘都写的更强信号；views 缺键时走索引会把
///   “有小组件的屏”误判成空屏，关灵动岛即触发误销毁，见 2026-10-03 案例）；
/// - `widget:dock:<N>`：灵动岛 `enabled` 且 `tiles` 非空 → 有内容。
///
/// 读走只读连接池（与 load_slot_map 同理：不阻塞写连接，也不被备份/导入
/// 长事务卡住）。镜像陈旧（localStorage 被清后未触发回写）时最多误建一个
/// 空窗：该窗 hydrate 后前端发 reconcile 对账销毁，自愈收敛。
fn screen_has_content(app: &tauri::AppHandle, slot: usize) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else {
        // 状态不可用（理论不可达：setup 先 manage 再建窗）宁可保持旧行为。
        return true;
    };
    let Ok(conn) = state.read_db.acquire() else {
        return true;
    };
    let get = |key: &str| {
        crate::repositories::SettingsRepo::get(&conn, key)
            .ok()
            .flatten()
    };

    if let Some(raw) = get(&format!("widget:dock:{slot}")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            let enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
            let has_tiles = v
                .get("tiles")
                .and_then(|x| x.as_array())
                .is_some_and(|a| !a.is_empty());
            if enabled && has_tiles {
                return true;
            }
        }
    }

    // 布局镜像按前缀直扫（不经过 views 索引）：键形如 `widget:layout:<slot>:<viewId>`，
    // 前缀末位的 `:` 保证不会匹配到 slot 12 一类更长槽位号。
    match crate::repositories::SettingsRepo::list_by_prefix(
        &conn,
        &format!("widget:layout:{slot}:"),
    ) {
        Ok(rows) => {
            for (_, raw) in rows {
                if let Ok(serde_json::Value::Array(items)) =
                    serde_json::from_str::<serde_json::Value>(&raw)
                {
                    if !items.is_empty() {
                        return true;
                    }
                }
            }
        }
        Err(e) => {
            // 扫描失败宁可误判“有内容”（多养一个空窗，前端 hydrate 后自愈），
            // 不能反向误销毁用户正在用的桌面层窗口。
            log::warn!("screen_has_content: layout prefix scan failed for slot {slot}: {e}");
            return true;
        }
    }
    false
}

/// 空屏对账：按当前拓扑 + 各屏内容，创建缺失的“有内容”屏窗口、销毁
/// “无内容”的副屏窗口。widget-0 例外：番茄钟主时钟 / 通知 / 便签提醒 /
/// 命令面板 / 更新调度都挂在 primary 上，永不销毁且始终确保存在。
/// 启动建窗、热插拔 sync 与前端落盘后的 reconcile 命令共用本函数。
/// 必须在主线程调用（建窗/销毁）。
pub fn reconcile_widget_windows_blocking(app: &tauri::AppHandle) {
    let monitors = app.available_monitors().unwrap_or_default();
    let slotted = resolve_monitor_slots(app, &monitors);
    for (slot, m) in &slotted {
        let label = format!("widget-{slot}");
        let exists = app.get_webview_window(&label).is_some();
        let wanted = *slot == 0 || screen_has_content(app, *slot);
        if wanted && !exists {
            log::info!("creating widget window '{label}'");
            if let Err(e) = create_widget_window(app, *slot, m) {
                log::warn!("widget window for slot {slot} failed to create: {e}");
            }
        } else if !wanted && exists {
            log::info!("destroying widget window '{label}' (screen is empty)");
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        }
    }
    // 建/销后重采几何——销毁走 Destroyed 事件有刷新，但新建/重显不一定
    // 伴随窗口事件（show 不发 Moved/Resized），显式收尾兜住命中缓存。
    crate::widget::refresh_geometry_all(app);
}

/// 前端布局/dock 持久化后的窗口对账入口：widget-store 每次落盘
/// （防抖后）调用，Rust 按镜像内容建/销副屏窗口。命令级门控与命令族一致。
#[tauri::command]
pub fn reconcile_widget_windows(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    crate::require_trusted(&window)?;
    // 建窗/销窗必须在主线程；run_on_main_thread 即时派发不阻塞命令返回。
    let app2 = app.clone();
    app.run_on_main_thread(move || reconcile_widget_windows_blocking(&app2))
        .map_err(|e| format!("窗口对账调度失败: {e}"))
}

/// With one widget window per monitor, this brings the widget layer for the
/// given monitor to the foreground (a "show this screen's widgets" action).
/// 命令面补 require_trusted 闸门（自定义命令不受 capability 门控，任意
/// webview 都能 invoke——show/set_focus 的窗口编排不该开放给 web-preview
/// 一类低信任窗）；托盘"显示器"菜单在原生侧直接调 [`set_monitor_impl`]
///（天然受信，且没有 Window 形参可验）。
#[tauri::command]
pub fn set_monitor(window: tauri::Window, app: tauri::AppHandle, id: u32) -> Result<(), String> {
    crate::require_trusted(&window)?;
    set_monitor_impl(&app, id)
}

/// set_monitor 的实现体（托盘菜单与命令面共用）。
pub(crate) fn set_monitor_impl(app: &tauri::AppHandle, id: u32) -> Result<(), String> {
    let label = format!("widget-{id}");
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("显示器 {id} 不存在"))?;
    let _ = window.show();
    let _ = window.set_focus();
    // show 后立即重采几何——隐藏窗口不参与命中（widget.rs 的 visible
    // 标记），不重采的话该屏要等 30s 兜底刷新才恢复点击命中。托盘回调在
    // 主线程，直调安全。
    crate::widget::refresh_geometry_all(app);
    Ok(())
}

/// Creates the transparent full-screen widget window for stable slot `slot`
/// (label `widget-<slot>`, URL hash `#screen=<slot>`). Shared by the
/// initial setup and the hot-plug watcher, so both produce identical windows.
pub fn create_widget_window(
    app: &tauri::AppHandle,
    slot: usize,
    m: &Monitor,
) -> Result<tauri::WebviewWindow, tauri::Error> {
    let label = format!("widget-{slot}");
    // `Monitor::position()`/`size()` are in PHYSICAL pixels, but
    // `WebviewWindowBuilder::position()`/`inner_size()` take LOGICAL pixels.
    // Failing to divide by the scale factor made each widget window
    // scale-factor× too large and offset on non-100% DPI monitors.
    let sf = m.scale_factor().max(1.0);
    let pos = m.position();
    let size = m.size();
    // 新窗口必须继承当前的置顶偏好：默认沉底，但用户已把 widget 层切到
    // 置顶时，热插拔出来的窗口若仍沉底，会出现「老屏幕浮顶、新屏幕沉底」
    // 的层级分裂（应用启动时 state 尚未 manage，回落 false 即默认沉底）。
    let on_top = app
        .try_state::<crate::AppState>()
        .map(|s| s.always_on_top_enabled())
        .unwrap_or(false);
    let mut builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html#screen={slot}").into()),
    )
    .title("Vela Widgets")
    // builder 的 position/inner_size 是逻辑单位，tao
    // 创建期按【主屏】scale 回乘物理坐标——混合 DPI（主屏 100% + 副屏 150%）
    // 下「除以目标屏 scale」的坐标会被主屏 scale 错误换算，副屏 widget 窗出
    // 生即错位错尺寸（≈1.5×，同 DPI 双屏两套 scale 相等故历轮未暴露）。对齐
    // snip.rs / windows.rs（quick-note）已两次验证的范式：builder 只给中立
    // 位置，建窗后（visible(false) 期间）用【物理】坐标精确落位（见 build 之
    // 后的 set_position/set_size）。单屏与同 DPI 下物理落位结果与旧逻辑的
    // 回乘结果完全一致，行为不变。
    .inner_size(size.width as f64 / sf, size.height as f64 / sf)
    .position(0.0, 0.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .focused(false)
    // （续）：先隐藏创建，物理落位后再 show——窗口从不以错误几何可见，
    // 正常路径下用户不会看到「先出现在 (0,0) 再跳位」；三条建窗链（启动
    // reconcile / 热插拔 sync / 前端落盘 reconcile）的最终可见性语义与修
    // 复前一致（建成即显示）。
    .visible(false);
    builder = if on_top {
        builder.always_on_top(true)
    } else {
        builder.always_on_bottom(true)
    };
    let win = builder.build()?;
    // 物理精确落位——`Monitor::position()`/`size()` 本
    // 就是物理像素，直接落到窗口，不经过任何按屏换算（换算基准的坑见上方
    // builder 注释）。落位与显示之间的顺序保证：set_position/set_size 在
    // visible(false) 期间同步完成，show() 之后的首帧几何已正确。
    let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
    let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
    // [ANTICAPTURE]：开关开启时新窗口出生即带防截屏属性（窗口 affinity 随
    // HWND 存续，几何重放 / show 不影响，无需在 sync 路径重复应用）。
    // （续）：affinity 在 show 之前应用——比旧 visible(true) 路径更严，
    // 窗口从不以「无防截屏属性」的状态可见。
    crate::anticapture::apply_if_enabled(&win);
    // （续）：visible(false) 创建的对偶收尾——物理落位完成后恢复原「建
    // 窗即显示」语义（focused(false) 的 WS_EX_NOACTIVATE 随 HWND 存续，
    // show 不激活窗口，与旧行为一致）。
    let _ = win.show();
    // The widget layer must never close: hiding it on close keeps the desktop
    // widgets available and the app resident in the tray.
    let close_handler_win = win.clone();
    // 窗口移动/缩放（拓扑重排、DPI 变化）即时刷新几何缓存——事件在
    // 主线程回调里直接采集（同线程无跨线程 IPC），取代 1.5s 轮询的常态开销。
    let geometry_win = win.clone();
    win.clone().on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = close_handler_win.hide();
                // 隐藏不影响几何，但销毁（拔屏）需要清缓存——Destroyed 覆盖。
                // 隐藏即刻重采——隐藏窗口不参与命中（widget.rs 的 visible
                // 标记），显式翻状态不等 30s 兜底。
                crate::widget::refresh_geometry_all(close_handler_win.app_handle());
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                crate::widget::refresh_geometry_now(&geometry_win);
            }
            tauri::WindowEvent::Destroyed => {
                crate::widget::refresh_geometry_now(&geometry_win);
            }
            _ => {}
        }
    });
    Ok(win)
}

/// Geometry + identity signature for topology change detection. Sorted by
/// physical name so a pure REORDER of the enumeration does not trigger churn —
/// slot mapping already keeps windows on their physical displays; only
/// arrival/removal/move/resolution changes need a resync.
fn monitor_signature(monitors: &[Monitor]) -> Vec<(String, i32, i32, u32, u32)> {
    let mut sig: Vec<_> = monitors
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (
                m.name().cloned().unwrap_or_default(),
                p.x,
                p.y,
                s.width,
                s.height,
            )
        })
        .collect();
    sig.sort();
    sig
}

/// Brings the set of `widget-<slot>` windows in line with the currently connected
/// monitors: creates windows for new displays, destroys windows for removed
/// displays, and repositions/resizes windows whose monitor moved or changed
/// resolution. Slots come from the persisted physical-name mapping, so each
/// window always tracks the same PHYSICAL display. Must run on the main thread.
pub fn sync_widget_windows(app: &tauri::AppHandle) {
    let monitors = app.available_monitors().unwrap_or_default();
    let slotted = resolve_monitor_slots(app, &monitors);

    // Destroy windows whose stable slot no longer exists (unplugged).
    let existing: Vec<(String, tauri::WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("widget-"))
        .collect();
    for (label, w) in existing {
        let slot = label
            .strip_prefix("widget-")
            .and_then(|s| s.parse::<usize>().ok());
        match slot.and_then(|s| slotted.iter().find(|(ms, _)| *ms == s)) {
            Some((_, m)) => {
                // Still present: sync geometry in case it moved / changed res.
                // 新建路径已在 create_widget_window 内
                // 物理落位（本循环跑在新建循环之前，管不到当轮新建窗）；本循
                // 环只作用于已存在窗口，保留作拓扑变化（移动/改分辨率）时的
                // 纠偏——两层数学一致，不冲突。set_size 用 Logical 是安全的：
                // 前一行 set_position(Physical) 已把窗口移到目标屏原点，逻辑
                // 尺寸的回乘基准（窗口所在屏）即目标屏 scale。
                let sf = m.scale_factor().max(1.0);
                let pos = m.position();
                let size = m.size();
                let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                let _ = w.set_size(tauri::LogicalSize::new(
                    size.width as f64 / sf,
                    size.height as f64 / sf,
                ));
                // 只 show 本来就可见的窗口。用户「关闭」桌面层 = 隐藏
                //（CloseRequested → hide），任何其它屏的热插拔/改分辨率不该
                // 把它强制复活；几何照常同步（隐藏窗参与重定位，恢复时就在
                // 新位置）。查询失败时保守沿旧行为（show）。
                if w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                }
            }
            None => {
                log::info!("destroying widget window '{label}' (display removed)");
                let _ = w.destroy();
            }
        }
    }

    // Create windows for displays that don't have one yet. ：副屏只有
    // 持久化布局/灵动岛有内容才建窗；widget-0 无条件建（全局职责）。
    for (slot, m) in &slotted {
        let label = format!("widget-{slot}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        if *slot != 0 && !screen_has_content(app, *slot) {
            log::info!("skipping widget window '{label}' for hot-plugged display (screen empty)");
            continue;
        }
        log::info!("creating widget window '{label}' for hot-plugged display");
        if let Err(e) = create_widget_window(app, *slot, m) {
            log::warn!("failed to create widget window '{label}': {e}");
        }
    }

    // 同步收尾重采几何（同 reconcile_widget_windows_blocking 的理由：
    // show/新建不伴随窗口事件，命中缓存不能等 30s 兜底）。
    crate::widget::refresh_geometry_all(app);
}

/// 拓扑事件唤醒通道（WM_DISPLAYCHANGE → wallpaper 监听窗 → 本 watcher）。
/// 3s 轮询事件化后，waker 让热插拔仍即时可见，轮询只留 30s 低频兜底
/// （事件通道可能丢播：投屏驱动抖动、会话切换等场景）。
static TOPOLOGY_WAKE: std::sync::OnceLock<std::sync::mpsc::Sender<()>> = std::sync::OnceLock::new();

/// 通知拓扑 watcher 立即重查一次（幂等，可并发调用）。
pub fn wake_monitor_watcher() {
    if let Some(tx) = TOPOLOGY_WAKE.get() {
        let _ = tx.send(());
    }
}

/// Polls the monitor topology and resyncs the widget windows when it changes
/// (hot-plug, unplug, resolution change, monitor reorder).
/// The frontend also gets a `monitors-changed` event to refresh its displays.
///
/// 拓扑变化以事件为主（wallpaper.rs 监听窗收 WM_DISPLAYCHANGE 后调
/// wake_monitor_watcher），轮询降为 30s 兜底——此前常驻 0.33Hz 的
/// available_monitors FFI 枚举 + 签名比对纯属空转。
pub fn start_monitor_watcher(app: tauri::AppHandle) {
    let initial = app.available_monitors().unwrap_or_default();
    let mut last_sig = monitor_signature(&initial);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let _ = TOPOLOGY_WAKE.set(tx);
    std::thread::spawn(move || loop {
        // 事件唤醒即时返回；超时即兜底轮询节拍。
        let _ = rx.recv_timeout(Duration::from_secs(30));
        // available_monitors 内部走 unsafe FFI；一次 panic 就会杀死本 watcher
        // 线程，之后显示器热插拔永远不再重建窗口。逐拍兜住 panic 并继续。
        let monitors = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            app.available_monitors()
        })) {
            Ok(Ok(m)) => m,
            Ok(Err(_)) => continue,
            Err(p) => {
                log::error!("monitor watcher panic: {:?}", panic_msg(&p));
                continue;
            }
        };
        let sig = monitor_signature(&monitors);
        if sig == last_sig {
            continue;
        }
        last_sig = sig;
        log::info!("monitor topology changed ({} display(s))", monitors.len());
        let app2 = app.clone();
        let res = app.run_on_main_thread(move || {
            sync_widget_windows(&app2);
            // 窗口集同步后重建托盘"显示器"子菜单，避免其子项指向已销毁的 widget-N。
            crate::tray::refresh_monitor_menu(&app2);
        });
        if res.is_ok() {
            // 仅设置窗口（DisplayPage）消费此事件，定向投递避免对无监听窗口的无效序列化。
            let _ = app.emit_to("settings", "monitors-changed", monitors.len());
        }
    });
}

fn panic_msg(p: &Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::assign_slots;
    use std::collections::HashMap;

    fn map(pairs: &[(&str, usize)]) -> HashMap<String, usize> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn slots_of(out: &[(&String, usize)], key: &str) -> Vec<usize> {
        out.iter()
            .filter(|(k, _)| k.as_str() == key)
            .map(|(_, s)| *s)
            .collect()
    }

    /// 显示器增删同步状态机核心语义——已知屏保住持久化槽位（重插拔
    /// 恢复原分配），新屏拿最低空闲槽。
    #[test]
    fn known_monitors_keep_slots_and_new_take_lowest_free() {
        let saved = map(&[("DELL-27", 0), ("LG-34", 2)]);
        // LG 拔掉了，新插了一块未知屏：DELL 保 0，未知屏拿最低空闲 1
        // （2 是 LG 的历史槽，保留给重插拔）。
        let cur = keys(&["DELL-27", "AOC-新屏"]);
        let out = assign_slots(&saved, &cur);
        assert_eq!(slots_of(&out, "DELL-27"), vec![0]);
        assert_eq!(slots_of(&out, "AOC-新屏"), vec![1]);
    }

    /// 全新装机（保存表为空）：按顺序拿 0,1,2…，无冲突。
    #[test]
    fn empty_saved_assigns_sequential_slots() {
        let cur = keys(&["A", "B", "C"]);
        let out = assign_slots(&HashMap::new(), &cur);
        let mut slots: Vec<usize> = out.iter().map(|(_, s)| *s).collect();
        slots.sort();
        assert_eq!(slots, vec![0, 1, 2]);
    }

    /// 损坏态：保存表里两条记录撞同一槽（手工改库/历史 bug）——先到者保槽，
    /// 后到者重分配到最低空闲，绝不产生两个 widget-{N} 同槽窗口。
    #[test]
    fn corrupt_saved_with_duplicate_slots_reassigns_latter() {
        let saved = map(&[("A", 0), ("B", 0)]);
        let cur = keys(&["A", "B"]);
        let out = assign_slots(&saved, &cur);
        assert_eq!(slots_of(&out, "A"), vec![0]);
        assert_eq!(slots_of(&out, "B"), vec![1]);
    }

    /// 保存表是纯函数输入：陈旧条目（当前枚举里不存在的屏）不被修改/删除，
    /// 调用方据此做「保留以备重插拔」的持久化合并。
    #[test]
    fn stale_entries_in_saved_are_untouched() {
        let saved = map(&[("A", 0), ("拔掉的屏", 3)]);
        let before = saved.clone();
        let cur = keys(&["A"]);
        let out = assign_slots(&saved, &cur);
        assert_eq!(slots_of(&out, "A"), vec![0]);
        assert_eq!(saved, before, "纯函数：输入表原样");
    }

    /// 空枚举（理论边界）：无分配。
    #[test]
    fn no_monitors_yields_no_slots() {
        let saved = map(&[("A", 0)]);
        assert!(assign_slots(&saved, &[]).is_empty());
    }
}
