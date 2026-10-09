//! 窗口上下文探针。
//!
//! uTools/同类启动器 的「窗口匹配指令」按前台窗口出专属动作（在资源管理器里
//! 给「复制当前文件夹路径」，在浏览器里给「读取当前页 URL」）。本模块补
//! Vela 缺的两个读取面：
//!  - [`read_explorer_path`]：枚举 Shell 窗口（IShellWindows）找到与前台
//!    句柄一致的资源管理器窗口，读 LocationURL/LocationName；
//!  - [`read_browser_url`]：UI Automation 找前台浏览器窗口的地址栏 Edit
//!    控件，读 Value（Chromium 的「地址和搜索栏」/ Edge 地址栏同构）。
//! 外加 [`open_terminal_at`]
//! 与 [`copy_text_to_clipboard`]（上下文动作「复制」的落点）。
//!
//! COM 线程模型：全部走 `spawn_blocking` + 调用线程 `CoInitializeEx(STA)`、
//! 结束配对 `CoUninitialize`——STA 是 UIA 与 Shell 自动化的要求，不占主线程。
//! VARIANT 读写沿用 brightness.rs 的手工模式（vt 判别 + 字段直取）。
//!
//! 安全：终端打开不经任何 shell 字符串拼接（cmd/powershell 的起始目录用
//! `Command::current_dir` 传递，wt 用独立参数 `-d`），路径中的引号 / `&` /
//! `%` 等字符没有二次解析面。

use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::{VariantClear, VariantInit, VARIANT, VT_BSTR, VT_I4};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_ValueValuePropertyId,
};
use windows::Win32::UI::Shell::{IShellWindows, IWebBrowser2, ShellWindows};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// 前台窗口句柄：优先「呼出前快照」（热键 dispatch 在窗口编排前抓的真正
/// 前台——面板打开后 GetForegroundWindow 只会得到 Vela 自己），无快照回
/// 当前前台（窗口内 Ctrl+K 场景，上下文大概率为空，返回 None 由调用方兜底）。
fn context_hwnd() -> Option<HWND> {
    if let Some(snap) = crate::game::last_summon_snapshot() {
        let h = HWND(snap.hwnd as *mut core::ffi::c_void);
        if !h.0.is_null() {
            return Some(h);
        }
    }
    let cur = unsafe { GetForegroundWindow() };
    if cur.0.is_null() {
        None
    } else {
        Some(cur)
    }
}

/// 构造 VT_I4 VARIANT（UIA 条件参数 / ShellWindows 索引共用）。
fn variant_i4(v: i32) -> VARIANT {
    let mut var = unsafe { VariantInit() };
    unsafe {
        (*var.Anonymous.Anonymous).vt = VT_I4;
        (*var.Anonymous.Anonymous).Anonymous.lVal = v;
    }
    var
}

/// 取 VARIANT 里的 BSTR 文本（非 BSTR / 空文本为 None；调用方负责 VariantClear
/// 之外的清理——本函数只在克隆出的字符串上工作，不移动值的所有权语义）。
fn variant_bstr_string(v: &VARIANT) -> Option<String> {
    unsafe {
        if (*v.Anonymous.Anonymous).vt != VT_BSTR {
            return None;
        }
        let b: &BSTR = &(*v.Anonymous.Anonymous).Anonymous.bstrVal;
        let s = b.to_string();
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    }
}

/* ------------------------- Explorer 当前路径 ------------------------- */

/// file:/// URL → 文件系统路径（资源管理器 LocationURL 的形态）；百分号转义
/// 解码（非法序列按原样保留，纯函数，单测覆盖）。
pub fn url_to_fs_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file:///")?;
    if rest.is_empty() {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// 枚举 Shell 窗口，找与 `target` 一致的资源管理器窗口，返回其当前路径。
/// 优先 LocationURL（file:/// 形态解码为文件系统路径）；虚拟位置（此电脑/
/// 回收站等）URL 为空，回退 LocationName（显示名，让上下文段至少有语义）。
fn explorer_path_for_hwnd(target: HWND) -> Option<String> {
    unsafe {
        let shell_windows: IShellWindows =
            CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ok()?;
        let count = shell_windows.Count().ok()?;
        for i in 0..count {
            let idx = variant_i4(i);
            // Item(VT_I4) 返回该 Explorer 窗口的 IDispatch——IWebBrowser2 是标准面。
            let dispatch: IDispatch = match shell_windows.Item(&idx) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let browser: IWebBrowser2 = match dispatch.cast() {
                Ok(b) => b,
                Err(_) => continue,
            };
            let same = browser
                .HWND()
                .map(|h| h.0 == target.0 as isize)
                .unwrap_or(false);
            if !same {
                continue;
            }
            let url = browser
                .LocationURL()
                .map(|b| b.to_string())
                .unwrap_or_default();
            if let Some(p) = url_to_fs_path(&url) {
                return Some(p);
            }
            let name = browser
                .LocationName()
                .map(|b| b.to_string())
                .unwrap_or_default();
            if !name.trim().is_empty() {
                return Some(name);
            }
            return None;
        }
        None
    }
}

/* --------------------------- 浏览器地址栏 --------------------------- */

/// 前台浏览器窗口的地址栏文本（读不到为 None）。调用方按进程名先判断是
/// 浏览器（chrome/msedge/firefox/opera/brave/vivaldi…）再调本探针。
/// 手法：UIA 在前台窗口后代里找第一个 Edit 控件，读它的 Value——浏览器
/// 工具栏里的 Edit 几乎只有地址栏（Chromium 命名「地址和搜索栏」）。
fn browser_url_for_hwnd(hwnd: HWND) -> Option<String> {
    unsafe {
        let auto: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL).ok()?;
        let root = auto.ElementFromHandle(hwnd).ok()?;
        let cond: IUIAutomationCondition = auto
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &variant_i4(UIA_EditControlTypeId.0),
            )
            .ok()?;
        let first_edit = root.FindFirst(TreeScope_Descendants, &cond).ok()?;
        let mut val = first_edit
            .GetCurrentPropertyValue(UIA_ValueValuePropertyId)
            .ok()?;
        let out = variant_bstr_string(&val);
        let _ = VariantClear(&mut val);
        out
    }
}

/* ------------------------------ 命令面 ------------------------------ */

/// 在 STA 上跑一段 UIA/Shell 代码（配对初始化/反初始化；S_FALSE 也配对）。
fn with_sta<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return None;
        }
        let r = f();
        CoUninitialize();
        r
    }
}

/// [CTX] 前台是资源管理器时的当前文件夹路径（file:/// 解码为文件系统路径；
/// 虚拟位置回显示名；读不到为 None——前端据此不出上下文段）。
#[tauri::command]
pub async fn read_explorer_path(window: tauri::Window) -> Result<Option<String>, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(|| with_sta(|| explorer_path_for_hwnd(context_hwnd()?)))
        .await
        .map_err(|e| e.to_string())
}

/// [CTX] 前台浏览器的地址栏 URL（非浏览器前台 / 读不到为 None）。
#[tauri::command]
pub async fn read_browser_url(window: tauri::Window) -> Result<Option<String>, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(|| with_sta(|| browser_url_for_hwnd(context_hwnd()?)))
        .await
        .map_err(|e| e.to_string())
}

/// 终端白名单（命令参数；单测覆盖）。
pub const TERMINAL_KINDS: [&str; 3] = ["wt", "powershell", "cmd"];

/// [CTX] 在指定目录打开终端窗口。目录不存在
/// 或 kind 未知直接拒绝。起始目录经 `current_dir` 传递（无 shell 拼接面）；
/// 子进程 detach（drop 句柄，系统收尸）。
#[tauri::command]
pub async fn open_terminal_at(
    window: tauri::Window,
    path: String,
    kind: Option<String>,
) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let kind = kind.unwrap_or_else(|| "wt".to_string());
    if !TERMINAL_KINDS.contains(&kind.as_str()) {
        return Err(format!("未知终端类型：{kind}"));
    }
    tauri::async_runtime::spawn_blocking(move || open_terminal_blocking(&path, &kind))
        .await
        .map_err(|e| e.to_string())?
}

fn open_terminal_blocking(path: &str, kind: &str) -> Result<(), String> {
    let p = std::path::PathBuf::from(path);
    if !p.is_dir() {
        return Err(format!("不是文件夹：{path}"));
    }
    // 三种终端都以「进程工作目录 = 目标目录」落地：cmd / powershell 用
    // current_dir（继承起始目录，配合 /K、-NoExit 保持窗口），wt 显式 -d
    //（wt 对继承启动目录的语义不稳定）。
    let spawn = |mut cmd: std::process::Command| -> Result<(), String> {
        cmd.spawn()
            .map(|child| {
                // RUST-4（范式，lib.rs open_log_dir 同款）：后台线程 wait
                // 回收子进程句柄——常驻桌面进程长期运行，每次打开终端泄漏一个
                // 未 join 的句柄直到进程退出。
                std::thread::spawn(move || {
                    let mut child = child;
                    let _ = child.wait();
                });
            })
            .map_err(|e| format!("打开终端失败: {e}"))
    };
    match kind {
        "wt" => {
            let mut c = std::process::Command::new("wt");
            c.arg("-d").arg(path);
            spawn(c)
        }
        "powershell" => {
            let mut c = std::process::Command::new("powershell");
            c.arg("-NoExit").current_dir(path);
            spawn(c)
        }
        _ => {
            let mut c = std::process::Command::new("cmd");
            c.arg("/K").current_dir(path);
            spawn(c)
        }
    }
}

/// [CTX] 把一段文本写入系统剪贴板（上下文动作「复制当前路径 / 复制 URL」的
/// 落点；复用 clipboard.rs 的写入实现）。仅 Windows 生效。
#[tauri::command]
pub async fn copy_text_to_clipboard(window: tauri::Window, text: String) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || unsafe {
            crate::clipboard::write_text_pub(&text)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, text);
        Err("仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_to_fs_path_decodes_file_urls() {
        assert_eq!(
            url_to_fs_path("file:///C:/Users/%E6%B5%8B%E8%AF%95"),
            Some("C:/Users/测试".to_string())
        );
        assert_eq!(
            url_to_fs_path("file:///D:/Docs"),
            Some("D:/Docs".to_string())
        );
        assert_eq!(url_to_fs_path("file:///"), None);
        assert_eq!(url_to_fs_path("https://example.com"), None);
        // 非法百分号序列按原样保留而不是失败。
        assert_eq!(url_to_fs_path("file:///C:/a%2"), Some("C:/a%2".to_string()));
    }

    #[test]
    fn terminal_whitelist_and_missing_dir_rejected() {
        assert_eq!(TERMINAL_KINDS.len(), 3);
        assert!(TERMINAL_KINDS.contains(&"wt"));
        assert!(open_terminal_blocking("Z:\\definitely\\missing", "wt")
            .unwrap_err()
            .contains("不是文件夹"));
    }
}
