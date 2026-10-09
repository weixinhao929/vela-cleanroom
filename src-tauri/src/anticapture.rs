//! [ANTICAPTURE]窗口防捕获：
//! `SetWindowDisplayAffinity` + `WDA_EXCLUDEFROMCAPTURE`。窗口本地正常可见，
//! 但在截屏 / 录屏 / 屏幕共享中不可见（Win10 2004+；更旧系统调用失败仅告警，
//! 表现为黑块或无效果）。桌面层上常驻的待办 / DDL / 便签在共享屏幕时不再
//! 裸奔，与 `toggle-layer` 老板键互补（隐藏 = 本地也看不见；防捕获 = 本地
//! 看得见、录制看不见）。
//!
//! 开关单一事实源：设置镜像 `extra.antiCapture`（默认 false）。窗口 affinity
//! 随 HWND 生命周期存续，所以只需两处动作：
//!
//! 1. 各建窗点调 [`apply_if_enabled`]（读最近已知开关，建窗即带属性）；
//! 2. [`start_anticapture_watcher`] 监听镜像变更（Condvar 变更即醒 + 60s 兜底），
//!    翻转时对全部窗口重放应用 / 解除。
//!
//! 托盘勾选项走「翻转 → emit 事件由 widget-0 走前端设置链路落盘」的既有
//! 任务栏开关模式（tray.rs），本模块只消费镜像，不自己写。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

/// 最近一次已知的防捕获开关（启动时同步读镜像播种，之后由 watcher 维护）。
/// 建窗点读它避免每次建窗都打一次 SQLite。
static ANTI_CAPTURE_ON: AtomicBool = AtomicBool::new(false);

/// 防捕获覆盖的窗口 label（纯函数，单测覆盖）。snip 截图覆盖窗一并排除：
/// 录屏中呼出截图工具时选择框不会入镜；其冻结帧抓屏同样会跳过已排除的
/// Vela 窗口（GDI BitBlt 尊重 display affinity），截图本身体现一致隐私语义。
pub fn is_protected_label(label: &str) -> bool {
    label.starts_with("widget-")
        || matches!(
            label,
            "settings"
                | "quick-note"
                | "fullscreen"
                | "super-panel"
                | "web-preview"
                | "taskbar-net"
                | "snip"
        )
}

/// 从设置镜像 JSON（`app:settings:v1` 或 `sync:settings` 载荷同形）提取
/// `extra.antiCapture`；缺失 / 非布尔 / 非 JSON → None（增量回填不得把局部
/// 快照当成「关」，与 tray.rs 的 taskbar_enabled_in_settings_json 同口径）。
pub fn anti_capture_in_settings_json(json: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("extra")?.get("antiCapture")?.as_bool()
}

/// 读镜像取当前开关（任何失败 → false，默认关）。
fn read_enabled(app: &tauri::AppHandle) -> bool {
    crate::settings_mirror::read_json(app)
        .as_ref()
        .and_then(|v| v.get("extra")?.get("antiCapture")?.as_bool())
        .unwrap_or(false)
}

/// 启动时同步播种开关（在首批窗口创建之前调用一次）。
pub fn prime_from_mirror(app: &tauri::AppHandle) {
    let on = read_enabled(app);
    ANTI_CAPTURE_ON.store(on, Ordering::SeqCst);
}

/// 建窗点挂钩：开关开启时对新窗口应用防捕获。幂等（静态量关闭时零成本）。
/// 主线程调用（建窗路径本身在主线程）。
pub fn apply_if_enabled(win: &tauri::WebviewWindow) {
    if !ANTI_CAPTURE_ON.load(Ordering::SeqCst) {
        return;
    }
    apply_to(win, true);
}

/// 对单个窗口应用 / 解除 display affinity。非 Vela 自有 label 不碰。
fn apply_to(win: &tauri::WebviewWindow, enabled: bool) {
    if !is_protected_label(win.label()) {
        return;
    }
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
        };
        let Ok(hwnd) = win.hwnd() else {
            return;
        };
        let affinity = if enabled {
            WDA_EXCLUDEFROMCAPTURE
        } else {
            WDA_NONE
        };
        // SAFETY: hwnd 来自 Tauri 持有的活窗口；SetWindowDisplayAffinity 对
        // 自有进程窗口跨线程调用安全（user32 属性设置类 API）。
        let result = unsafe { SetWindowDisplayAffinity(hwnd, affinity) };
        if result.is_err() {
            // 旧版 Win10（<2004）不支持 0x11：降级为无效果，仅记录告警。
            log::warn!(
                "anticapture: set affinity {} on '{}' failed: {:?}",
                if enabled { "exclude" } else { "none" },
                win.label(),
                result
            );
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (win, enabled);
    }
}

/// 对当前全部 Vela 窗口重放应用 / 解除（开关翻转时用）。
fn apply_all(app: &tauri::AppHandle, enabled: bool) {
    for (_, win) in app.webview_windows() {
        apply_to(&win, enabled);
    }
}

/// 镜像变更监视线程：变更即醒（settings_mirror Condvar）+ 60s 兜底重读。
/// 值未变时不动窗口（省 user32 调用；display affinity 无需周期重放，窗口
/// 重建由建窗点挂钩覆盖）。
pub fn start_anticapture_watcher(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("vela-anticapture".to_string())
        .spawn(move || loop {
            // （missed-wakeup）：代数先于镜像读取——变更若落在「读取之后、
            // 进入等待之前」，wait_for_change_since 因代数已前进而立即返回，
            // 防截屏开关不再等 60s 兜底。
            let seen = crate::settings_mirror::generation();
            let on = read_enabled(&app);
            let prev = ANTI_CAPTURE_ON.swap(on, Ordering::SeqCst);
            if on != prev {
                log::info!("anticapture: {} -> applying to all windows", on);
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || apply_all(&app2, on));
            }
            crate::settings_mirror::wait_for_change_since(seen, std::time::Duration::from_secs(60));
        })
        .expect("spawn anticapture watcher");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_labels_cover_all_vela_windows() {
        // 画布层（全部槽位）与所有辅助窗都受保护。
        for label in [
            "widget-0",
            "widget-3",
            "settings",
            "quick-note",
            "fullscreen",
            "super-panel",
            "web-preview",
            "taskbar-net",
            "snip",
        ] {
            assert!(is_protected_label(label), "{label} 应受防捕获保护");
        }
    }

    #[test]
    fn unknown_labels_are_untouched() {
        // 未知 label（未来窗口 / 拼写错误）不碰，宁可漏保护也不误伤第三方。
        for label in ["", "unknown", "widgetify", "settings2", "main"] {
            assert!(!is_protected_label(label), "{label} 不应被保护");
        }
    }

    #[test]
    fn anti_capture_extracts_only_explicit_bool() {
        // 镜像快照 / sync:settings 载荷同形。
        assert_eq!(
            anti_capture_in_settings_json(r#"{"extra":{"antiCapture":true}}"#),
            Some(true)
        );
        assert_eq!(
            anti_capture_in_settings_json(
                r#"{"instanceId":"w1","extra":{"antiCapture":false},"general":{}}"#
            ),
            Some(false)
        );
        // 缺字段 / 类型错 / 非 JSON → None（增量回填不动状态）。
        assert_eq!(anti_capture_in_settings_json(r#"{"extra":{}}"#), None);
        assert_eq!(
            anti_capture_in_settings_json(r#"{"extra":{"antiCapture":"yes"}}"#),
            None
        );
        assert_eq!(anti_capture_in_settings_json(r#"{"general":{}}"#), None);
        assert_eq!(anti_capture_in_settings_json("{oops"), None);
        assert_eq!(anti_capture_in_settings_json(""), None);
        assert_eq!(anti_capture_in_settings_json("[]"), None);
    }
}
