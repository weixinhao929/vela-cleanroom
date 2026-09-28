//! 全局快捷键：插件 handler、启动注册与运行时重注册。从 lib.rs 拆出。
//!
//! §4.5 可配置：组合键不再硬编码，而是「动作 id → 组合键」的运行时配置
//! （[`current_config`]，进程内 RwLock），默认值 = 历史固定组合。前端设置
//! 页录制新组合后经 [`apply_shortcut_config`] 原子替换：先注销旧组合再注册
//! 新组合，逐条失败经 `shortcut:register-failed` 反馈（组合被其他应用占用）。
//! handler 匹配与注册/注销共用同一份配置，避免"注册了但没处理"的漂移。
//!
//! 组合键字符串格式：`Ctrl+Alt+Space` / `Ctrl+Shift+F9` / `Alt+KeyD`……
//! 修饰键在前（大小写不敏感），主键用 `event.code` 名或其简写（`D`/`KeyD`、
//! `1`/`Digit1`），由 global-hotkey 的解析器统一识别。
//!
//! [TB-TRAY]（F-11）**无默认键的动作**：`taskbar:toggle` 出厂不绑定任何组合。
//! 配置集合（[`current_config`] / [`parse_config`] 的返回值）只含**已绑定**的
//! 动作——未绑定即不出现在集合里、不注册、handler 也不会命中；前端以空串
//! 表示未绑定，[`parse_config`] 仅对无默认键的动作接受空串（有默认键的动作
//! 留空仍按配置错误拒绝，既有行为不变）。

use std::collections::HashMap;
use std::sync::RwLock;

use tauri::{Emitter, Listener};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::windows;

/// 可配置的动作 id（前端 settings.shortcuts 的键，顺序即设置页展示顺序）。
pub const ACTIONS: [&str; 12] = [
    "toggle-pomodoro",
    "toggle-layer",
    "toggle-edit",
    "show-settings",
    "new-task",
    "quick-note",
    "toggle-palette",
    "toggle-dock",
    "open-dock-panel",
    // [TB-TRAY] F-11：任务栏总开关（无默认键）/ 重置动态状态（默认
    // Ctrl+Alt+Shift+F1，与常见任务栏增强工具一致）。
    "taskbar:toggle",
    "taskbar:reset-state",
    // [SNIP] 截图（借鉴 ClassSoftwareHub #4）：冻结帧框选 + 标注 + 钉图，
    // 默认键 Ctrl+Alt+X（S 已被设置占用，X 对齐主流截图工具直觉）。
    "screenshot",
];

/// 默认组合（历史固定值）：Space 开始/暂停专注 · D 显隐小组件层 · E 编辑模式 ·
/// S 设置 · N 新建任务 · Q 速记 · K 命令面板（与桌面层窗口内 Ctrl+K 呼应）·
/// I 显隐灵动岛（Island）· O 打开灵动岛面板（Open panel）·
/// Ctrl+Alt+Shift+F1 重置任务栏动态状态（标杆同键）。
///
/// 只列**有默认键**的动作，顺序与 [`ACTIONS`] 一致；`taskbar:toggle` 无默认键，
/// 不在此表（见模块文档）。
pub fn default_config() -> Vec<(&'static str, Shortcut)> {
    let ca = Some(Modifiers::CONTROL | Modifiers::ALT);
    let cas = Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT);
    vec![
        ("toggle-pomodoro", Shortcut::new(ca, Code::Space)),
        ("toggle-layer", Shortcut::new(ca, Code::KeyD)),
        ("toggle-edit", Shortcut::new(ca, Code::KeyE)),
        ("show-settings", Shortcut::new(ca, Code::KeyS)),
        ("new-task", Shortcut::new(ca, Code::KeyN)),
        ("quick-note", Shortcut::new(ca, Code::KeyQ)),
        ("toggle-palette", Shortcut::new(ca, Code::KeyK)),
        ("toggle-dock", Shortcut::new(ca, Code::KeyI)),
        ("open-dock-panel", Shortcut::new(ca, Code::KeyO)),
        ("taskbar:reset-state", Shortcut::new(cas, Code::F1)),
        ("screenshot", Shortcut::new(ca, Code::KeyX)),
    ]
}

/// 动作的默认组合；无默认键的动作（`taskbar:toggle`）返回 None。
pub fn default_for(action: &str) -> Option<Shortcut> {
    default_config()
        .into_iter()
        .find(|(a, _)| *a == action)
        .map(|(_, sc)| sc)
}

/// 当前生效配置（动作 id → 组合键）。启动时 = 默认；apply 后被整体替换。
fn config_cell() -> &'static RwLock<Vec<(&'static str, Shortcut)>> {
    static CELL: std::sync::OnceLock<RwLock<Vec<(&'static str, Shortcut)>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| RwLock::new(default_config()))
}

/// 当前配置快照（克隆，不持锁）。
pub fn current_config() -> Vec<(&'static str, Shortcut)> {
    config_cell()
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// 把前端的 `{action: "Ctrl+Alt+Space"}` 映射校验为配置：未知动作、无法解析、
/// 缺动作（补默认）、组合键重复都会拒绝，保证注册面永远是一致的完整集合。
///
/// [TB-TRAY] 无默认键的动作：值为空串或缺席 → 不绑定（不进结果集合）；有默认键
/// 的动作留空仍报错（既有行为）。
pub fn parse_config(
    map: &HashMap<String, String>,
) -> Result<Vec<(&'static str, Shortcut)>, String> {
    for key in map.keys() {
        if !ACTIONS.contains(&key.as_str()) {
            return Err(format!("未知快捷键动作：{key}"));
        }
    }
    let mut out = Vec::with_capacity(ACTIONS.len());
    for action in ACTIONS {
        let default_sc = default_for(action);
        let sc = match map.get(action) {
            Some(raw) => {
                let raw = raw.trim();
                if raw.is_empty() {
                    if default_sc.is_none() {
                        continue;
                    }
                    return Err(format!("快捷键 {action} 为空"));
                }
                Shortcut::try_from(raw)
                    .map_err(|e| format!("无法解析快捷键 {action}=\"{raw}\"：{e}"))?
            }
            None => match default_sc {
                Some(sc) => sc,
                None => continue,
            },
        };
        // 无修饰键的全局热键会在系统范围内吞掉该按键（如把 A 注册为全局键后
        // 任何窗口都打不出 A），一律拒绝。
        if sc.mods.is_empty() {
            return Err(format!(
                "快捷键 {action} 至少需要一个修饰键（Ctrl/Alt/Shift/Win）"
            ));
        }
        if let Some((dup, _)) = out.iter().find(|(_, s): &&(&str, Shortcut)| *s == sc) {
            return Err(format!("快捷键冲突：{action} 与 {dup} 都是 {sc}"));
        }
        out.push((action, sc));
    }
    Ok(out)
}

/// [WAKE-BL]（ZTools 借鉴 #14）唤醒黑名单：设置镜像 `general.hotkeyBlacklist`
///（exe 文件名数组，大小写不敏感）。命中即跳过「唤起类」动作（toggle-palette /
/// quick-note）——指定应用（游戏、全屏播放器）前台时热键不打扰。读取走 2s
/// TTL 缓存：热键路径每次查库太重，设置改动最迟 2s 生效。
/// [DOUBLE-TAP]（ZTools #13）双击修饰键分派同用此判定。
pub(crate) fn wake_blacklisted(app: &tauri::AppHandle) -> bool {
    use std::sync::Mutex;
    use std::time::Instant;
    use tauri::Manager;

    static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
    let list: Vec<String> = {
        let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
        let fresh = guard
            .as_ref()
            .is_some_and(|(t, _)| t.elapsed().as_secs() < 2);
        if fresh {
            guard.as_ref().map(|(_, l)| l.clone()).unwrap_or_default()
        } else {
            let list = app
                .try_state::<crate::AppState>()
                .and_then(|state| {
                    state.read_db.acquire().ok().and_then(|conn| {
                        crate::repositories::SettingsRepo::get(&conn, "app:settings:v1")
                            .ok()
                            .flatten()
                    })
                })
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .and_then(|v| {
                    v.get("general")
                        .and_then(|g| g.get("hotkeyBlacklist"))
                        .cloned()
                })
                .and_then(|arr| serde_json::from_value::<Vec<String>>(arr).ok())
                .map(|raw| {
                    raw.iter()
                        .map(|s| s.trim().to_ascii_lowercase())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            *guard = Some((Instant::now(), list.clone()));
            list
        }
    };
    if list.is_empty() {
        return false;
    }
    match crate::game::last_summon_snapshot() {
        Some(snap) => list.contains(&snap.app.process_name.to_ascii_lowercase()),
        None => false,
    }
}

/// 按动作 id 分发（handler 与 cli.rs 命令面共用）。
pub(crate) fn dispatch(app: &tauri::AppHandle, action: &str) {
    match action {
        "toggle-pomodoro" => {
            let _ = app.emit("shortcut:toggle-pomodoro", ());
        }
        // 显示/隐藏小组件层（与 --toggle-layer 命令面共用）
        "toggle-layer" => windows::toggle_widget_layer(app),
        // 切换编辑模式（前端 store 负责状态与跨窗口同步）
        "toggle-edit" => {
            let _ = app.emit("shortcut:toggle-edit-mode", ());
        }
        "show-settings" => windows::show_settings_window(app),
        // 新建任务（复用托盘新建任务的前端处理；空载荷 = 打开输入框）
        "new-task" => {
            let _ = app.emit("tray:new-task", ());
        }
        // W-067 全局快捷速记。[WAKE-BL]：先抓前台快照（黑名单判定 + 上下文
        // 探针都要「呼出前」的前台），黑名单命中即跳过。
        "quick-note" => {
            crate::game::capture_foreground_snapshot();
            if wake_blacklisted(app) {
                log::debug!("quick-note suppressed by wake blacklist");
                return;
            }
            windows::show_or_create_quick_note(app);
        }
        // 全局呼出命令面板：先做窗口编排（显示隐藏的层 → widget-0 临时置顶 →
        // 聚焦，见 windows.rs），再广播给前端——CommandPaletteHost 只在 primary
        // （widget-0）窗口响应切换；面板关闭时前端回发 command-palette:closed 撤销编排。
        // [CTX]/[WAKE-BL]：快照必须在编排前抓（否则前台已是 Vela 自己）。
        "toggle-palette" => {
            crate::game::capture_foreground_snapshot();
            if wake_blacklisted(app) {
                log::debug!("toggle-palette suppressed by wake blacklist");
                return;
            }
            windows::summon_palette_window(app);
            let _ = app.emit("shortcut:toggle-palette", ());
        }
        // 灵动岛（F-10）：显隐岛只广播——dock 配置按屏独立持久化、不跨窗口同步，
        // 由前端 DockShortcuts 在 primary（widget-0）窗口翻转本屏 dock.enabled。
        "toggle-dock" => {
            let _ = app.emit("shortcut:toggle-dock", ());
        }
        // 打开全岛面板：层隐藏时面板无处可显，先确保层可见（与 toggle-palette
        // 同款，但不做置顶 / 聚焦编排——面板不需要键盘焦点，也就无需关闭时撤销）。
        "open-dock-panel" => {
            windows::show_widget_layer(app);
            let _ = app.emit("shortcut:open-dock-panel", ());
        }
        // [TB-TRAY] 任务栏（F-11）：总开关翻转 / 重置动态状态与托盘菜单共用
        // tray.rs 的实现（勾选态、镜像回写、设置窗同步、引擎调用都在那一处）。
        "taskbar:toggle" => crate::tray::toggle_taskbar_enabled(app),
        "taskbar:reset-state" => crate::tray::reset_taskbar_state(app),
        // [SNIP] 截图（#4）：抓光标所在显示器 → snip 覆盖窗。
        "screenshot" => crate::snip::start_snip_internal(app),
        _ => {}
    }
}

/// global-shortcut 插件（含按键 handler）。
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            // 按当前配置反查动作：apply 期间旧组合已注销，不会误触。
            let action = current_config()
                .into_iter()
                .find(|(_, sc)| sc == shortcut)
                .map(|(a, _)| a);
            if let Some(action) = action {
                dispatch(app, action);
            }
        })
        .build()
}

/// 注册一组组合键；失败仅告警（组合键可能已被其他应用占用），不影响其余。
/// 每条失败向前端广播一次 `shortcut:register-failed`，返回失败的组合键字符串。
fn register_set<M: tauri::Manager<tauri::Wry> + Emitter<tauri::Wry>>(
    app: &M,
    set: &[(&'static str, Shortcut)],
) -> Vec<String> {
    let mut failed = Vec::new();
    for (action, sc) in set {
        if let Err(e) = app.global_shortcut().register(*sc) {
            log::warn!("failed to register global shortcut {action}={sc}: {e}");
            let _ = app.emit("shortcut:register-failed", sc.to_string());
            failed.push(sc.to_string());
        }
    }
    failed
}

/// 启动注册（当前配置 = 默认；前端水合后若用户改过会再 apply 一次）。
/// 同时挂上命令面板关闭事件的监听：全局呼出时做的临时置顶 / 前台编排由
/// 前端 primary 窗口在面板关闭时回发 `command-palette:closed` 撤销。
pub fn register_all(app: &tauri::App) {
    let _ = register_set(app, &current_config());
    let handle = app.handle().clone();
    app.listen_any("command-palette:closed", move |_| {
        windows::release_palette_window(&handle);
    });
}

/// 退出前统一注销全部快捷键，避免热键在进程存续期残留（配合 lib.rs 的退出路径）。
pub fn unregister_all(app: &tauri::AppHandle) {
    let gs = app.global_shortcut();
    for (_, sc) in current_config() {
        let _ = gs.unregister(sc);
    }
}

/// 原子替换配置并重注册：注销旧集合 → 写入新配置 → 注册新集合。
/// 返回注册失败的组合键（前端据此提示"被占用"）。
fn reregister(app: &tauri::AppHandle, next: Vec<(&'static str, Shortcut)>) -> Vec<String> {
    let gs = app.global_shortcut();
    // 先注销全部旧组合（含与新配置相同的——重复注册会报错）。
    for (_, sc) in current_config() {
        let _ = gs.unregister(sc);
    }
    {
        let mut guard = config_cell().write().unwrap_or_else(|p| p.into_inner());
        *guard = next;
    }
    let cfg = current_config();
    let failed = register_set(app, &cfg);
    log::info!(
        "shortcuts reregistered: {} ok, {} failed",
        cfg.len() - failed.len(),
        failed.len()
    );
    failed
}

/// Tauri 命令：应用前端传来的快捷键配置并重注册。
/// 参数 `config`：`{ "toggle-pomodoro": "Ctrl+Alt+Space", ... }`（缺项补默认）。
/// 成功返回注册失败的组合键列表（空 = 全部成功）；配置本身非法（解析失败/
/// 重复/无修饰键）返回 Err，此时不做任何注销/注册，旧配置继续生效。
#[tauri::command]
pub fn apply_shortcut_config(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    config: HashMap<String, String>,
) -> Result<Vec<String>, String> {
    // WebviewWindow 形参走不进 require_trusted(&Window) 重载，保持内联但
    // 文案归一（A-5：全仓唯一 canonical 拒绝语，可 grep）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let next = parse_config(&config)?;
    Ok(reregister(&app, next))
}

/// Tauri 命令：当前生效配置（动作 id → 规范化组合键字符串，如 `control+alt+Space`）。
/// 供前端启动对账（配置与 Rust 不一致时才 apply）与诊断。未绑定的动作（如出厂的
/// `taskbar:toggle`）不出现在表里，前端按「缺键 = 空串」对账。
#[tauri::command]
pub fn get_shortcut_config() -> HashMap<String, String> {
    current_config()
        .into_iter()
        .map(|(a, sc)| (a.to_string(), sc.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn defaults_cover_all_actions_without_duplicates() {
        let d = default_config();
        // [TB-TRAY]：默认表只含有默认键的动作；唯一的无默认键动作是 taskbar:toggle。
        let unbound: Vec<&str> = ACTIONS
            .iter()
            .copied()
            .filter(|a| default_for(a).is_none())
            .collect();
        assert_eq!(unbound, ["taskbar:toggle"]);
        assert_eq!(d.len(), ACTIONS.len() - unbound.len());
        // 默认表按 ACTIONS 顺序出行（设置页/速查表按此顺序展示），互不重复。
        let mut cursor = 0;
        for (i, (a, sc)) in d.iter().enumerate() {
            let pos = ACTIONS[cursor..]
                .iter()
                .position(|x| x == a)
                .unwrap_or_else(|| panic!("default {a} not in ACTIONS (after index {cursor})"));
            cursor += pos + 1;
            assert!(
                !d[..i].iter().any(|(_, s)| s == sc),
                "duplicate default {sc}"
            );
        }
        // [HOTKEY] 第 7 项：全局呼出命令面板也在默认表内（设置页/速查表按此表出行）。
        assert!(d.iter().any(|(a, _)| *a == "toggle-palette"));
        // [ISLAND-LINK] 第 8/9 项：灵动岛显隐 / 全岛面板同在默认表内，互不冲突。
        assert!(d.iter().any(|(a, _)| *a == "toggle-dock"));
        assert!(d.iter().any(|(a, _)| *a == "open-dock-panel"));
        // [TB-TRAY] 第 11 项：重置任务栏动态状态有默认键；总开关无默认键。
        assert!(d.iter().any(|(a, _)| *a == "taskbar:reset-state"));
        assert!(!d.iter().any(|(a, _)| *a == "taskbar:toggle"));
        // [SNIP] 第 12 项：截图默认 Ctrl+Alt+X。共 11 条默认。
        assert!(d.iter().any(|(a, _)| *a == "screenshot"));
        assert_eq!(d.len(), 11);
        assert_eq!(ACTIONS.len(), 12);
    }

    #[test]
    fn taskbar_reset_defaults_to_ctrl_alt_shift_f1_and_is_rebindable() {
        let cas = Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT);
        let by = |cfg: &[(&str, Shortcut)], a: &str| cfg.iter().find(|(k, _)| *k == a).unwrap().1;
        // 默认 Ctrl+Alt+Shift+F1（§1.1 热键）。
        let cfg = parse_config(&map(&[])).expect("defaults");
        assert_eq!(
            by(&cfg, "taskbar:reset-state"),
            Shortcut::new(cas, Code::F1)
        );
        // 前端 acceleratorFromEvent 的写法（Ctrl+Alt+Shift+F1）解析等价。
        let cfg =
            parse_config(&map(&[("taskbar:reset-state", "Ctrl+Alt+Shift+F1")])).expect("same");
        assert_eq!(
            by(&cfg, "taskbar:reset-state"),
            Shortcut::new(cas, Code::F1)
        );
        // 可录制改键，其余动作保持默认。
        let cfg = parse_config(&map(&[("taskbar:reset-state", "Ctrl+Shift+F12")])).expect("rebind");
        assert_eq!(
            by(&cfg, "taskbar:reset-state"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F12)
        );
        assert_eq!(
            by(&cfg, "toggle-dock"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyI)
        );
        // 与其他动作撞键按整表查重拒绝（双向）。
        let err = parse_config(&map(&[("new-task", "Ctrl+Alt+Shift+F1")])).unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("taskbar:reset-state"),
            "{err}"
        );
        let err = parse_config(&map(&[("taskbar:reset-state", "Ctrl+Alt+K")])).unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("toggle-palette"),
            "{err}"
        );
        // 有默认键的动作留空仍是配置错误（既有行为不因「无默认键」语义而放宽）。
        assert!(parse_config(&map(&[("taskbar:reset-state", "")]))
            .unwrap_err()
            .contains("为空"));
    }

    #[test]
    fn taskbar_toggle_is_unbound_by_default_and_bindable() {
        let by =
            |cfg: &[(&str, Shortcut)], a: &str| cfg.iter().find(|(k, _)| *k == a).map(|(_, s)| *s);
        // 出厂不绑定：缺席与空串都表示未绑定，结果集合里没有它（不注册、handler 不命中）。
        assert_eq!(default_for("taskbar:toggle"), None);
        let cfg = parse_config(&map(&[])).expect("defaults");
        assert_eq!(by(&cfg, "taskbar:toggle"), None);
        let cfg = parse_config(&map(&[("taskbar:toggle", "")])).expect("empty = unbound");
        assert_eq!(by(&cfg, "taskbar:toggle"), None);
        let cfg = parse_config(&map(&[("taskbar:toggle", "   ")])).expect("blank = unbound");
        assert_eq!(by(&cfg, "taskbar:toggle"), None);
        // 用户录制后即注册；查重仍覆盖它（双向）。
        let cfg = parse_config(&map(&[("taskbar:toggle", "Ctrl+Alt+T")])).expect("bind");
        assert_eq!(
            by(&cfg, "taskbar:toggle"),
            Some(Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT),
                Code::KeyT
            ))
        );
        assert_eq!(cfg.len(), default_config().len() + 1);
        let err = parse_config(&map(&[("taskbar:toggle", "Ctrl+Alt+Shift+F1")])).unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("taskbar:reset-state"),
            "{err}"
        );
        let err = parse_config(&map(&[
            ("taskbar:toggle", "Ctrl+Alt+T"),
            ("quick-note", "control+alt+KeyT"),
        ]))
        .unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("taskbar:toggle"),
            "{err}"
        );
        // 无修饰键 / 无法解析同样拒绝。
        assert!(parse_config(&map(&[("taskbar:toggle", "KeyT")]))
            .unwrap_err()
            .contains("修饰键"));
        assert!(
            parse_config(&map(&[("taskbar:toggle", "Ctrl+Alt+NotAKey")]))
                .unwrap_err()
                .contains("无法解析")
        );
    }

    #[test]
    fn legacy_config_without_taskbar_actions_gets_defaults_filled() {
        // 升级前的 9 项旧配置（前端 normalizeShortcuts 同款语义）：缺席的新动作按默认
        // 补齐——reset-state 得到 Ctrl+Alt+Shift+F1，toggle 保持未绑定。
        let legacy = map(&[
            ("toggle-pomodoro", "Ctrl+Alt+Space"),
            ("toggle-layer", "Ctrl+Alt+D"),
            ("toggle-edit", "Ctrl+Alt+E"),
            ("show-settings", "Ctrl+Alt+S"),
            ("new-task", "Ctrl+Alt+N"),
            ("quick-note", "Ctrl+Alt+Q"),
            ("toggle-palette", "Ctrl+Alt+K"),
            ("toggle-dock", "Ctrl+Alt+I"),
            ("open-dock-panel", "Ctrl+Alt+O"),
        ]);
        let cfg = parse_config(&legacy).expect("legacy config");
        assert_eq!(cfg, default_config());
    }

    #[test]
    fn action_registry_roundtrips_through_string_map() {
        // 动作注册表往返：get_shortcut_config 形态（动作 → 规范串）→ parse_config →
        // 与源配置逐项相等；未绑定动作缺席于表中且往返后仍未绑定。
        let src = default_config();
        let as_map: HashMap<String, String> = src
            .iter()
            .map(|(a, sc)| (a.to_string(), sc.to_string()))
            .collect();
        assert!(!as_map.contains_key("taskbar:toggle"));
        // [SNIP] 第 12 项 screenshot 默认 Ctrl+Alt+X：共 11 条默认。
        assert_eq!(as_map.len(), 11);
        let back = parse_config(&as_map).expect("roundtrip");
        assert_eq!(back, src);
        // 绑定 toggle 后的表同样往返无损。
        let mut bound = as_map.clone();
        bound.insert("taskbar:toggle".into(), "Ctrl+Alt+T".into());
        let cfg = parse_config(&bound).expect("bound");
        let again: HashMap<String, String> = cfg
            .iter()
            .map(|(a, sc)| (a.to_string(), sc.to_string()))
            .collect();
        assert_eq!(parse_config(&again).expect("roundtrip 2"), cfg);
        // 前端下发的全表（未绑定动作为空串）同样被接受。
        let mut full = as_map;
        full.insert("taskbar:toggle".into(), String::new());
        assert_eq!(parse_config(&full).expect("full table"), src);
    }

    #[test]
    fn dock_actions_default_to_ctrl_alt_i_and_o_and_are_rebindable() {
        let ca = Some(Modifiers::CONTROL | Modifiers::ALT);
        let by = |cfg: &[(&str, Shortcut)], a: &str| cfg.iter().find(|(k, _)| *k == a).unwrap().1;
        let cfg = parse_config(&map(&[])).expect("defaults");
        assert_eq!(by(&cfg, "toggle-dock"), Shortcut::new(ca, Code::KeyI));
        assert_eq!(by(&cfg, "open-dock-panel"), Shortcut::new(ca, Code::KeyO));
        // 可录制改键，其余动作保持默认。
        let cfg = parse_config(&map(&[
            ("toggle-dock", "Ctrl+Shift+I"),
            ("open-dock-panel", "Alt+F10"),
        ]))
        .expect("rebind");
        assert_eq!(
            by(&cfg, "toggle-dock"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyI)
        );
        assert_eq!(
            by(&cfg, "open-dock-panel"),
            Shortcut::new(Some(Modifiers::ALT), Code::F10)
        );
        assert_eq!(by(&cfg, "toggle-palette"), Shortcut::new(ca, Code::KeyK));
        // 与其他动作撞键按整表查重拒绝（双向），两个新动作之间也不能互撞。
        let err = parse_config(&map(&[("toggle-dock", "Ctrl+Alt+K")])).unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("toggle-palette"),
            "{err}"
        );
        let err = parse_config(&map(&[("new-task", "control+alt+KeyO")])).unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("open-dock-panel"),
            "{err}"
        );
        let err = parse_config(&map(&[("open-dock-panel", "Ctrl+Alt+I")])).unwrap_err();
        assert!(err.contains("冲突") && err.contains("toggle-dock"), "{err}");
    }

    #[test]
    fn toggle_palette_defaults_to_ctrl_alt_k_and_is_rebindable() {
        let ca = Some(Modifiers::CONTROL | Modifiers::ALT);
        let by = |cfg: &[(&str, Shortcut)], a: &str| cfg.iter().find(|(k, _)| *k == a).unwrap().1;
        // 默认 Ctrl+Alt+K：与桌面层窗口内 Ctrl+K 呼应，但多一个 Alt 才是全局组合。
        let cfg = parse_config(&map(&[])).expect("defaults");
        assert_eq!(by(&cfg, "toggle-palette"), Shortcut::new(ca, Code::KeyK));
        // 可录制改键，其余动作保持默认。
        let cfg = parse_config(&map(&[("toggle-palette", "Ctrl+Shift+P")])).expect("rebind");
        assert_eq!(
            by(&cfg, "toggle-palette"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP)
        );
        assert_eq!(by(&cfg, "quick-note"), Shortcut::new(ca, Code::KeyQ));
        // 与其他动作撞键按整表查重拒绝（双向：改它撞别人 / 改别人撞它）。
        let err = parse_config(&map(&[("toggle-palette", "Ctrl+Alt+Q")])).unwrap_err();
        assert!(err.contains("冲突") && err.contains("quick-note"), "{err}");
        let err = parse_config(&map(&[("new-task", "control+alt+KeyK")])).unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("toggle-palette"),
            "{err}"
        );
    }

    #[test]
    fn empty_map_yields_defaults() {
        let cfg = parse_config(&map(&[])).expect("defaults");
        assert_eq!(cfg, default_config());
    }

    #[test]
    fn parses_friendly_and_code_style_accelerators() {
        let cfg = parse_config(&map(&[
            ("toggle-layer", "ctrl+shift+KeyD"),
            ("show-settings", "Alt+F9"),
            ("quick-note", "Ctrl+Alt+Digit1"),
        ]))
        .expect("parse");
        let by = |a: &str| cfg.iter().find(|(k, _)| *k == a).unwrap().1;
        assert_eq!(
            by("toggle-layer"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD)
        );
        assert_eq!(
            by("show-settings"),
            Shortcut::new(Some(Modifiers::ALT), Code::F9)
        );
        assert_eq!(
            by("quick-note"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Digit1)
        );
        // 未提供的动作保持默认。
        assert_eq!(
            by("toggle-pomodoro"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
        );
    }

    #[test]
    fn rejects_unknown_action_bad_key_no_modifier_and_duplicates() {
        assert!(parse_config(&map(&[("nope", "Ctrl+A")]))
            .unwrap_err()
            .contains("未知"));
        assert!(parse_config(&map(&[("new-task", "Ctrl+Alt+NotAKey")]))
            .unwrap_err()
            .contains("无法解析"));
        assert!(parse_config(&map(&[("new-task", "")]))
            .unwrap_err()
            .contains("为空"));
        assert!(parse_config(&map(&[("new-task", "KeyA")]))
            .unwrap_err()
            .contains("修饰键"));
        // 与另一动作的默认值撞车也算冲突（等价组合按解析后比较，不看写法）。
        let err = parse_config(&map(&[("new-task", "control+alt+KeyD")])).unwrap_err();
        assert!(
            err.contains("冲突") && err.contains("toggle-layer"),
            "{err}"
        );
    }

    #[test]
    fn canonical_string_roundtrips_through_parser() {
        // get_shortcut_config 输出的规范串必须能被 apply 原样接受（启动对账依赖）。
        for (_, sc) in default_config() {
            let s = sc.to_string();
            assert_eq!(Shortcut::try_from(s.as_str()).unwrap(), sc, "{s}");
        }
    }
}
