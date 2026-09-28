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
    pub is_primary: bool,
}

/// Returns the list of connected monitors with their virtual-screen positions.
/// `id` 是稳定槽位（跨重启/换序指向同一物理屏），不是本次枚举下标。
///
/// async + spawn_blocking：`resolve_monitor_slots` 会读写 SQLite 槽位表，
/// 同步命令在主线程上等锁会在备份/导入持锁期间冻结所有窗口（R1 规则）。
#[tauri::command]
pub async fn list_monitors(app: tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_monitors_blocking(&app))
        .await
        .map_err(|e| format!("显示器枚举任务失败：{e}"))?
}

fn list_monitors_blocking(app: &tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("无法枚举显示器: {e}"))?;
    let slotted = resolve_monitor_slots(app, &monitors);

    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned());

    let mut out = Vec::with_capacity(slotted.len());
    for (slot, monitor) in &slotted {
        let pos = monitor.position();
        let size = monitor.size();
        let name = monitor
            .name()
            .cloned()
            .unwrap_or_else(|| format!("显示器 {}", slot + 1));
        out.push(MonitorInfo {
            id: *slot as u32,
            is_primary: Some(name.clone()) == primary,
            name,
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
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
    // P1：reconcile 每次都走这里，拓扑没变时不再空写 SQLite（save 线程 +
    // WAL 写全免）。
    for (slot, m) in &claimed {
        saved.insert(monitor_key(m), *slot);
    }
    if saved != saved_before {
        save_slot_map(app, &saved);
    }
    claimed
}

/// E-5 抽出的槽位分配纯函数（显示器增删同步状态机的核心，无持久化/句柄）：
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

/// P1：判断某屏桌面层是否有内容，作为“空屏不建 widget 窗”的依据。数据源
/// 是前端 localStorage 权威源的 SQLite 镜像（每次布局/dock 落盘都同步镜像，
/// 见 widget-store 的 writeInstancesNow / saveDock）：
/// - `widget:views:<N>`：视图清单 `[{id, name}]`；
/// - `widget:layout:<N>:<view>`：任一视图布局数组非空 → 有内容；
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

    if let Some(raw) = get(&format!("widget:views:{slot}")) {
        if let Ok(serde_json::Value::Array(views)) = serde_json::from_str::<serde_json::Value>(&raw)
        {
            for v in &views {
                let Some(id) = v.get("id").and_then(|x| x.as_str()) else {
                    continue;
                };
                let Some(layout) = get(&format!("widget:layout:{slot}:{id}")) else {
                    continue;
                };
                if let Ok(serde_json::Value::Array(items)) =
                    serde_json::from_str::<serde_json::Value>(&layout)
                {
                    if !items.is_empty() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// P1 空屏对账：按当前拓扑 + 各屏内容，创建缺失的“有内容”屏窗口、销毁
/// “无内容”的副屏窗口。widget-0 例外：番茄钟主时钟 / 通知 / 便签提醒 /
/// 命令面板 / 更新调度都挂在 primary 上（D-1），永不销毁且始终确保存在。
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
}

/// 前端布局/dock 持久化后的窗口对账入口（P1）：widget-store 每次落盘
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
#[tauri::command]
pub fn set_monitor(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let label = format!("widget-{id}");
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("显示器 {id} 不存在"))?;
    let _ = window.show();
    let _ = window.set_focus();
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
    .inner_size(size.width as f64 / sf, size.height as f64 / sf)
    .position(pos.x as f64 / sf, pos.y as f64 / sf)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .focused(false)
    .visible(true);
    builder = if on_top {
        builder.always_on_top(true)
    } else {
        builder.always_on_bottom(true)
    };
    let win = builder.build()?;
    // The widget layer must never close: hiding it on close keeps the desktop
    // widgets available and the app resident in the tray.
    let close_handler_win = win.clone();
    // R5：窗口移动/缩放（拓扑重排、DPI 变化）即时刷新几何缓存——事件在
    // 主线程回调里直接采集（同线程无跨线程 IPC），取代 1.5s 轮询的常态开销。
    let geometry_win = win.clone();
    win.clone().on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = close_handler_win.hide();
                // 隐藏不影响几何，但销毁（拔屏）需要清缓存——Destroyed 覆盖。
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
                let sf = m.scale_factor().max(1.0);
                let pos = m.position();
                let size = m.size();
                let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                let _ = w.set_size(tauri::LogicalSize::new(
                    size.width as f64 / sf,
                    size.height as f64 / sf,
                ));
                let _ = w.show();
            }
            None => {
                log::info!("destroying widget window '{label}' (display removed)");
                let _ = w.destroy();
            }
        }
    }

    // Create windows for displays that don't have one yet. P1：副屏只有
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
}

/// 拓扑事件唤醒通道（WM_DISPLAYCHANGE → wallpaper 监听窗 → 本 watcher）。
/// R4：3s 轮询事件化后，waker 让热插拔仍即时可见，轮询只留 30s 低频兜底
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
/// R4：拓扑变化以事件为主（wallpaper.rs 监听窗收 WM_DISPLAYCHANGE 后调
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
            // C-16：窗口集同步后重建托盘"显示器"子菜单，避免其子项指向已销毁的 widget-N。
            crate::tray::refresh_monitor_menu(&app2);
        });
        if res.is_ok() {
            // D-6：仅设置窗口（DisplayPage）消费此事件，定向投递避免对无监听窗口的无效序列化。
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

    /// E-5：显示器增删同步状态机核心语义——已知屏保住持久化槽位（重插拔
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
