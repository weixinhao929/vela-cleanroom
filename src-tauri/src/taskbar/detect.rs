//! 任务栏类型探测与能力上报（F-12 / D7）。
//!
//! 探测算法对齐标杆 taskbarattributeworker.cpp:1166-1221：
//! 1. 用 `CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, explorer_pid)` 枚举
//!    explorer 已加载模块，找 `Taskbar.dll` —— 未加载 = **Classic（Win10）**；
//! 2. 已加载则 `EnumChildWindows(Shell_TrayWnd)` 数类名
//!    `Windows.UI.Composition.DesktopWindowContentBridge` 且标题
//!    `DesktopWindowXamlSource` 的子窗口：2 = **Mixed（22000 / 早期 22621）**、
//!    1 = **XAML（22621+，含目标机 26200）**、其他 = Unknown。
//!
//! 全部为只读系统查询，不改任何窗口属性。非 Windows 平台恒 Unknown。

use crate::models::{TaskbarCapabilities, TaskbarPath};

/// 任务栏实现类型（A-3：定义收敛于 models.rs，此处 re-export 维持路径）。
pub use crate::models::TaskbarType;

/// Mixed 任务栏 blur 可用的最低版本：22000.282（标杆 UpgradeBlur 口径）。
pub const MIXED_BLUR_MIN_BUILD: u32 = 22000;
pub const MIXED_BLUR_MIN_UBR: u32 = 282;

/// 纯函数：由任务栏类型 + OS build/UBR 推能力集合（D7 规则）。
///
/// - `Xaml` → `{path:"xaml", blur:true, peek:false, line:true}`（XAML 任务栏
///   无 Win10 式 Peek 按钮结构，开关在 UI 中隐藏，F-7）；
/// - `Mixed` → `path:"swca"`（路径 A，P3 才实现；能力描述路径就位后的
///   可用集），blur 看版本 ≥ 22000.282，line 可（SetWindowRgn 裁 1px）；
/// - `Classic` / `Unknown` → `path:"none"`（首期「此系统版本暂不支持」）。
/// - `supports_battery_state` 与任务栏类型无关（电源通知为 OS 级），仅
///   探测失败（Unknown）时报 false。
pub fn capabilities_for(kind: TaskbarType, build: u32, ubr: u32) -> TaskbarCapabilities {
    let mixed_blur = build > MIXED_BLUR_MIN_BUILD
        || (build == MIXED_BLUR_MIN_BUILD && ubr >= MIXED_BLUR_MIN_UBR);
    let (path, supports_blur, supports_peek, supports_line) = match kind {
        TaskbarType::Xaml => (TaskbarPath::Xaml, true, false, true),
        TaskbarType::Mixed => (TaskbarPath::Swca, mixed_blur, false, true),
        TaskbarType::Classic | TaskbarType::Unknown => (TaskbarPath::None, false, false, false),
    };
    TaskbarCapabilities {
        path,
        supports_blur,
        supports_peek,
        supports_line,
        supports_battery_state: kind != TaskbarType::Unknown,
        os_build: build,
    }
}

/// 探测 + 版本读取一步到位（TB-INJECT 启动 / explorer 重建时调用并
/// `emit_capabilities`）。
pub fn probe_capabilities() -> TaskbarCapabilities {
    let (build, ubr) = os_build();
    capabilities_for(detect_taskbar_type(), build, ubr)
}

/// 当前 OS (build, UBR)，读注册表 `HKLM\...\CurrentVersion`
/// （`CurrentBuildNumber` 字符串 + `UBR` DWORD）；读取失败回 (0, 0)。
#[cfg(windows)]
pub fn os_build() -> (u32, u32) {
    let root = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
    let Ok(key) = root.open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") else {
        return (0, 0);
    };
    let build = key
        .get_value::<String, _>("CurrentBuildNumber")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let ubr = key.get_value::<u32, _>("UBR").unwrap_or(0);
    (build, ubr)
}

#[cfg(not(windows))]
pub fn os_build() -> (u32, u32) {
    (0, 0)
}

#[cfg(windows)]
pub fn detect_taskbar_type() -> TaskbarType {
    win::detect()
}

#[cfg(not(windows))]
pub fn detect_taskbar_type() -> TaskbarType {
    TaskbarType::Unknown
}

#[cfg(windows)]
mod win {
    use windows::core::{w, BOOL};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, FindWindowW, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId,
    };

    use super::TaskbarType;

    /// XAML 岛宿主子窗口（标杆 :1144 判定的类名 + 标题）。
    const XAML_ISLAND_CLASS: &str = "Windows.UI.Composition.DesktopWindowContentBridge";
    const XAML_ISLAND_TITLE: &str = "DesktopWindowXamlSource";

    fn wide_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// explorer 是否加载了 Taskbar.dll（模块文件名大小写不敏感比较；标杆
    /// 比全路径 System32\Taskbar.dll，此处按文件名足以区分且免查已知目录）。
    /// `None` = 快照失败（explorer 已死 / 权限）。
    unsafe fn explorer_has_taskbar_dll(pid: u32) -> Option<bool> {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid).ok()?;
        let mut me = MODULEENTRY32W {
            dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        if Module32FirstW(snapshot, &mut me).is_ok() {
            loop {
                if wide_to_string(&me.szModule).eq_ignore_ascii_case("Taskbar.dll") {
                    found = true;
                    break;
                }
                if Module32NextW(snapshot, &mut me).is_err() {
                    break;
                }
            }
        } else {
            let _ = CloseHandle(snapshot);
            return None;
        }
        let _ = CloseHandle(snapshot);
        Some(found)
    }

    unsafe extern "system" fn count_islands(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let counter = &mut *(lparam.0 as *mut u32);
        let mut class = [0u16; 128];
        let n = GetClassNameW(hwnd, &mut class);
        if n > 0 && wide_to_string(&class[..n as usize]) == XAML_ISLAND_CLASS {
            let mut title = [0u16; 128];
            let t = GetWindowTextW(hwnd, &mut title);
            if t > 0 && wide_to_string(&title[..t as usize]) == XAML_ISLAND_TITLE {
                *counter += 1;
            }
        }
        BOOL(1)
    }

    pub fn detect() -> TaskbarType {
        // SAFETY: 只读系统窗口 / 模块查询，不持有跨调用指针。
        unsafe {
            let Ok(tray) = FindWindowW(w!("Shell_TrayWnd"), None) else {
                return TaskbarType::Unknown;
            };
            if tray.0.is_null() {
                return TaskbarType::Unknown;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(tray, Some(&mut pid));
            if pid == 0 {
                return TaskbarType::Unknown;
            }
            match explorer_has_taskbar_dll(pid) {
                None => TaskbarType::Unknown,
                Some(false) => TaskbarType::Classic,
                Some(true) => {
                    let mut islands: u32 = 0;
                    let _ = EnumChildWindows(
                        Some(tray),
                        Some(count_islands),
                        LPARAM(&mut islands as *mut u32 as isize),
                    );
                    match islands {
                        2 => TaskbarType::Mixed,
                        1 => TaskbarType::Xaml,
                        _ => TaskbarType::Unknown,
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xaml_reports_full_tap_capabilities_without_peek() {
        let c = capabilities_for(TaskbarType::Xaml, 26200, 1);
        assert_eq!(c.path, TaskbarPath::Xaml);
        assert!(c.supports_blur && c.supports_line && c.supports_battery_state);
        assert!(!c.supports_peek, "XAML 任务栏无 Peek 按钮结构（F-7）");
        assert_eq!(c.os_build, 26200);
    }

    #[test]
    fn mixed_blur_depends_on_22000_282() {
        assert!(!capabilities_for(TaskbarType::Mixed, 22000, 281).supports_blur);
        assert!(capabilities_for(TaskbarType::Mixed, 22000, 282).supports_blur);
        assert!(capabilities_for(TaskbarType::Mixed, 22621, 0).supports_blur);
        let c = capabilities_for(TaskbarType::Mixed, 22000, 100);
        assert_eq!(c.path, TaskbarPath::Swca);
        assert!(c.supports_line && !c.supports_peek);
    }

    #[test]
    fn classic_and_unknown_are_unsupported_paths() {
        for kind in [TaskbarType::Classic, TaskbarType::Unknown] {
            let c = capabilities_for(kind, 19045, 3000);
            assert_eq!(c.path, TaskbarPath::None, "{kind:?}");
            assert!(
                !c.supports_blur && !c.supports_peek && !c.supports_line,
                "{kind:?}"
            );
        }
        assert!(capabilities_for(TaskbarType::Classic, 19045, 0).supports_battery_state);
        assert!(!capabilities_for(TaskbarType::Unknown, 0, 0).supports_battery_state);
    }

    #[test]
    fn taskbar_type_wire_names_are_lowercase() {
        assert_eq!(
            serde_json::to_string(&TaskbarType::Xaml).unwrap(),
            r#""xaml""#
        );
        assert_eq!(
            serde_json::to_string(&TaskbarType::Mixed).unwrap(),
            r#""mixed""#
        );
        assert_eq!(
            serde_json::to_string(&TaskbarType::Classic).unwrap(),
            r#""classic""#
        );
        assert_eq!(
            serde_json::to_string(&TaskbarType::Unknown).unwrap(),
            r#""unknown""#
        );
    }

    #[cfg(windows)]
    #[test]
    fn detect_does_not_panic_on_this_machine() {
        // 真机 / CI 都不断言具体类型（explorer 可能不在）；只要求不 panic、
        // 版本读取有效。
        let _ = detect_taskbar_type();
        let (build, _ubr) = os_build();
        assert!(
            build == 0 || build >= 7600,
            "CurrentBuildNumber 解析异常: {build}"
        );
    }
}
