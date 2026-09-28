//! 系统快捷动作（借鉴 ClassSoftwareHub #10 TeachingActions）：回桌面 / 任务
//! 视图 / 关前台应用 / 关闭全部窗口（两段式确认）。三条铁律同 CSH：
//!  1) 能调 API 就不模拟按键（本模块仅回桌面/任务视图无直接 API 时模拟组合键）；
//!  2) 关窗一律优雅关闭（WM_CLOSE），绝不 TerminateProcess 硬杀；
//!  3) 过滤自进程、TOOLWINDOW、系统壳类名、输入法窗口，防关错。

use serde::Serialize;
use ts_rs::TS;
use windows::core::BOOL;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, PostMessageW, GWL_EXSTYLE, WM_CLOSE,
};

/// 系统壳/输入法类名黑名单（CSH 同款口径：这些窗口绝不关）。
pub const SHELL_CLASSES: [&str; 6] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "ForegroundStaging",
    "Default IME",
];

/// 类名是否在系统壳黑名单内（纯函数，单测覆盖）。
pub fn should_skip_class(class: &str) -> bool {
    SHELL_CLASSES.iter().any(|c| class.eq_ignore_ascii_case(c))
}

/// 组合键四事件序列（修饰键按下 → 主键按下 → 主键抬起 → 修饰键抬起）。
fn chord_inputs(mod_vk: u16, key_vk: u16) -> [INPUT; 4] {
    let mk = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    [
        mk(mod_vk, false),
        mk(key_vk, false),
        mk(key_vk, true),
        mk(mod_vk, true),
    ]
}

const VK_LWIN: u16 = 0x5B;
const VK_D: u16 = 0x44;
const VK_TAB: u16 = 0x09;

fn send_chord(mod_vk: u16, key_vk: u16) {
    let inputs = chord_inputs(mod_vk, key_vk);
    unsafe {
        // SendInput 返回成功注入的事件数；不足即失败（静默——与 CSH 一致不弹错）。
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent != inputs.len() as u32 {
            log::warn!("sys_actions: SendInput 只注入了 {sent}/4 个事件");
        }
    }
}

/// [SUPER-PANEL]（ZTools 借鉴 #11）注入组合键的公开入口：取词流程模拟
/// Ctrl+C 用（mod_vk=0x11, key_vk=0x43）。
pub(crate) fn send_chord_pub(mod_vk: u16, key_vk: u16) {
    send_chord(mod_vk, key_vk);
}

fn window_text(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }
}

fn window_class(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 64];
        let n = windows::Win32::UI::WindowsAndMessaging::GetClassNameW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

fn is_own_process(hwnd: HWND) -> bool {
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == std::process::id()
    }
}

/// 「值得被关」的候选窗口：可见 + 有标题 + 非 TOOLWINDOW + 无属主 +
/// 非自进程 + 非系统壳/输入法类名。
fn closeable_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as usize;
        if ex & WS_EX_TOOLSTYLE != 0 {
            return false;
        }
        let owner = windows::Win32::UI::WindowsAndMessaging::GetWindow(
            hwnd,
            windows::Win32::UI::WindowsAndMessaging::GW_OWNER,
        );
        if matches!(owner, Ok(h) if !h.0.is_null()) {
            return false; // 有属主的对话框随主窗关。
        }
        if window_text(hwnd).trim().is_empty() {
            return false;
        }
        if is_own_process(hwnd) {
            return false;
        }
        !should_skip_class(&window_class(hwnd))
    }
}

// 常量别名（WS_EX_TOOLWINDOW 位）。
const WS_EX_TOOLSTYLE: usize = 0x0000_0080;

struct EnumCtx {
    items: Vec<(HWND, String)>,
}

/// 回桌面核心动作（模拟 Win+D）。托盘菜单在独立线程直接调，命令层
/// spawn_blocking 后调，同一实现。
pub fn send_desktop_blocking() {
    send_chord(VK_LWIN, VK_D);
}

/// [SYS] 回桌面：模拟 Win+D（无公开 API；COM ToggleDesktop 在 windows crate
/// 无 dispatch 绑定）。CSH 的 COM 优先路径在其 WPF 栈可用，Rust 侧以按键
/// 模拟达成同一效果。
#[tauri::command]
pub async fn sys_show_desktop(window: tauri::Window) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        send_chord(VK_LWIN, VK_D);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// [SYS] 任务视图：模拟 Win+Tab。
#[tauri::command]
pub async fn sys_task_view(window: tauri::Window) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        send_chord(VK_LWIN, VK_TAB);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// [SYS] 关前台应用：优雅 WM_CLOSE；前台是自身/系统壳时不动作（返回 false）。
#[tauri::command]
pub async fn sys_close_foreground(window: tauri::Window) -> Result<bool, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let fg = unsafe { GetForegroundWindow() };
        if fg.0.is_null() || !closeable_window(fg) {
            return Ok(false);
        }
        // 优雅关闭：让应用走自己的保存/确认流程。
        let ok = unsafe { PostMessageW(Some(fg), WM_CLOSE, WPARAM(0), LPARAM(0)) };
        Ok(ok.is_ok())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 关闭全部窗口 · 第一段：枚举候选并回报数量与标题样本（不执行）。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct CloseAllSummary {
    #[ts(type = "number")]
    pub count: i64,
    /// 最多 5 条标题样本（确认对话框展示用）。
    pub samples: Vec<String>,
    /// 候选窗口句柄（第二段执行时重新校验，防第一段后窗口已自关/换主）。
    #[ts(type = "number[]")]
    pub handles: Vec<isize>,
}

#[tauri::command]
pub async fn sys_close_all_stage1(window: tauri::Window) -> Result<CloseAllSummary, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let mut ctx = Box::new(EnumCtx { items: Vec::new() });
        let ctx_ptr = &mut *ctx as *mut EnumCtx;
        unsafe {
            // EnumWindows 按 z 序回调；collect 到 ctx（闭包返回 TRUE 继续枚举）。
            let _ = EnumWindows(Some(enum_proc), LPARAM(ctx_ptr as isize));
        }
        let samples = ctx.items.iter().take(5).map(|(_, t)| t.clone()).collect();
        Ok(CloseAllSummary {
            count: ctx.items.len() as i64,
            samples,
            handles: ctx.items.iter().map(|(h, _)| h.0 as isize).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumCtx);
    if closeable_window(hwnd) {
        ctx.items.push((hwnd, window_text(hwnd)));
    }
    BOOL(1)
}

/// 关闭全部窗口 · 第二段：逐个 WM_CLOSE（执行时重新校验每个句柄，静默跳过
/// 失效/新变得不可关的窗口），返回实际下发关闭的数量。
#[tauri::command]
pub async fn sys_close_all_execute(
    window: tauri::Window,
    handles: Vec<isize>,
) -> Result<i64, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut closed = 0i64;
        for h in handles.into_iter().take(64) {
            let hwnd = HWND(h as *mut core::ffi::c_void);
            if hwnd.0.is_null() {
                continue;
            }
            if !unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(hwnd)) }.as_bool() {
                continue;
            }
            if !closeable_window(hwnd) {
                continue; // 第一段之后窗口可能已自关/最小化到托盘。
            }
            let _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
            closed += 1;
        }
        Ok(closed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/* [POWER]（ZTools 借鉴 #4）电源与会话动作：锁屏 / 睡眠 / 注销 / 关机 /    */
/* 重启。破坏性分级：锁屏与睡眠即时执行（可逆 / 系统自身有恢复语义）；     */
/* 关机与重启由前端先弹确认对话框（与 closeAllWindowsFlow 同款两段式）。   */
/* 实现取舍：睡眠走 powrprof SetSuspendState（Win32_System_Power 直调，   */
/* 与 ZTools 的 PowerShell 方案等价但少一次 shell）；锁屏/注销/关机/重启   */
/* 经 shutdown.exe / rundll32（系统自带，语义清晰且不引新 feature）。      */
/* ------------------------------------------------------------------ */

/// 电源动作白名单（命令参数；单测覆盖）。
pub const POWER_ACTIONS: [&str; 5] = ["lock", "sleep", "logoff", "shutdown", "restart"];

/// 在独立线程执行一个电源动作（spawn_blocking 内调用；子进程 detach 收尸）。
fn run_power_action(action: &str) -> Result<(), String> {
    match action {
        // 睡眠：直调 API（Hibernate=FALSE, Force=FALSE——有未保存文档时系统自行弹确认）。
        "sleep" => unsafe {
            if windows::Win32::System::Power::SetSuspendState(false, false, false) {
                Ok(())
            } else {
                Err("进入睡眠失败".to_string())
            }
        },
        // 锁屏：rundll32 直转 user32!LockWorkStation（ZTools 同款）。
        "lock" => std::process::Command::new("rundll32")
            .args(["user32.dll,LockWorkStation"])
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("锁屏失败: {e}")),
        // 注销 / 关机 / 重启：shutdown.exe（/t 0 立即执行；EWX 直调会被本进程
        // 的常驻退出门控干扰，且 shutdown.exe 是系统标准入口）。
        "logoff" => std::process::Command::new("shutdown")
            .args(["/l"])
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("注销失败: {e}")),
        "shutdown" => std::process::Command::new("shutdown")
            .args(["/s", "/t", "0"])
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("关机失败: {e}")),
        "restart" => std::process::Command::new("shutdown")
            .args(["/r", "/t", "0"])
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("重启失败: {e}")),
        _ => Err(format!("未知电源动作：{action}")),
    }
}

/// detach 子进程的收尸句柄（与 files.rs reap_child 同语义：不 wait，交 reap）。
fn reap_child(child: std::process::Child) {
    drop(child);
}

/// [POWER] 电源/会话动作（lock/sleep/logoff/shutdown/restart）。关机与重启
/// 的确认对话框由前端负责（本命令只执行；与 CLI 命令面同门槛的受信窗口）。
#[tauri::command]
pub async fn sys_power_action(window: tauri::Window, action: String) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    if !POWER_ACTIONS.contains(&action.as_str()) {
        return Err(format!("未知电源动作：{action}"));
    }
    tauri::async_runtime::spawn_blocking(move || run_power_action(&action))
        .await
        .map_err(|e| e.to_string())?
}

/// PCWSTR 占位（保持与既有模块一致的空宽串工具；当前未用，留给后续扩展）。
#[allow(dead_code)]
fn _empty_pcwstr() -> PCWSTR {
    PCWSTR(std::ptr::null())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_classes_filtered() {
        assert!(should_skip_class("Progman"));
        assert!(should_skip_class("workerw"));
        assert!(should_skip_class("Default IME"));
        assert!(!should_skip_class("Chrome_WidgetWin_1"));
        assert!(!should_skip_class("Notepad"));
    }

    #[test]
    fn chord_structure_down_up_pairs() {
        let inputs = chord_inputs(VK_LWIN, VK_D);
        assert_eq!(inputs.len(), 4);
        let flags: Vec<bool> = inputs
            .iter()
            .map(|i| unsafe { i.Anonymous.ki.dwFlags } == KEYEVENTF_KEYUP)
            .collect();
        assert_eq!(flags, vec![false, false, true, true]);
        let vks: Vec<u16> = inputs
            .iter()
            .map(|i| unsafe { i.Anonymous.ki.wVk }.0)
            .collect();
        assert_eq!(vks, vec![VK_LWIN, VK_D, VK_D, VK_LWIN]);
    }

    // [POWER] 未知动作在白名单层即被拒绝（真正的执行面在命令门面校验后才会走到）。
    #[test]
    fn power_action_whitelist_rejects_unknown() {
        for known in POWER_ACTIONS {
            assert!(POWER_ACTIONS.contains(&known));
        }
        assert!(run_power_action("hibernate").unwrap_err().contains("未知"));
        assert!(run_power_action("").unwrap_err().contains("未知"));
    }
}
