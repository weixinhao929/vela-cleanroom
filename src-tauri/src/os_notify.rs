//! OS 通知点击回调基建：tauri-plugin-notification 的桌面实现走 notify-rust
//! 的 fire-and-forget `show()`，toast 激活（点击）没有进程内回调——JS 侧的
//! `onAction` 监听在 Windows 上永远等不到事件。这里直连同一底层 crate
//! `tauri-winrt-notification`（notify-rust 4.18 本就依赖它，不引入新依赖树），
//! 用它的 `on_activated` TypedEventHandler 拿到进程内点击回调：
//!
//! - 展示行为与现状完全一致：同一 `Toast::POWERSHELL_APP_ID`（未安装应用无
//!   自有 AUMID 快捷键时的既定回落），标题/正文/默认提示音；
//! - 点击 toast（或其按钮）→ WinRT 线程里把激活载荷 `os-notify:activated`
//!   广播到全部窗口，同时把小组件层窗口 show 出来（用户可能用托盘「隐藏
//!   小组件」藏了层——回调里前端可能不存在/不可见，由 Rust 兜底亮层）；
//! - 前端（App.tsx 的 OsNotifyActivationHandler）按 source/instance_id 落地
//!   定位到来源组件。
//!
//! 失败语义：命令返回 Err，前端回落旧的插件路径——Windows 7 等无 WinRT
//! toast 的环境行为不劣化。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_winrt_notification::Toast;

/// `os-notify:activated` 事件载荷：source 与发通知时的来源一致，
/// instance_id 为可选的精确实例定位，action 为按钮参数（无按钮/纯正文
/// 点击时为 None）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OsNotifyActivation {
    pub source: String,
    pub instance_id: Option<String>,
    pub action: Option<String>,
}

/// 发送带点击回调的 Windows toast。窗口闸门：系统 toast 是钓鱼面
/// （注入的 web-preview 页可伪造任意标题正文），与 sourceNotify 的来源
/// 门控双保险——此处按窗口再拦一道。
#[tauri::command]
pub fn send_os_notification(
    app: AppHandle,
    window: tauri::Window,
    title: String,
    body: String,
    source: Option<String>,
    instance_id: Option<String>,
) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let activation = OsNotifyActivation {
        source: source.unwrap_or_else(|| "app".to_string()),
        instance_id,
        action: None,
    };
    let handle = app.clone();
    let toast = Toast::new(Toast::POWERSHELL_APP_ID)
        .title(&title)
        .text2(&body)
        .on_activated(move |action| {
            let mut payload = activation.clone();
            payload.action = action;
            // 用户点通知意味着想看应用：先把小组件层亮出来（托盘「隐藏小组件」
            // 时前端可能整个不可见，不能只指望前端自己处理）。
            for (label, w) in handle.webview_windows() {
                if label.starts_with("widget-") {
                    let _ = w.show();
                }
            }
            let _ = handle.emit("os-notify:activated", &payload);
            Ok(())
        });
    toast.show().map_err(|e| e.to_string())
}

/// Rust 侧直发系统 Toast（无点击回调；快捷动作的结果反馈用，如系统代理
/// 切换）。失败静默——反馈性通知不应让动作本身报错。
pub fn notify_internal(title: &str, body: &str) {
    let _ = Toast::new(Toast::POWERSHELL_APP_ID)
        .title(title)
        .text2(body)
        .show();
}
