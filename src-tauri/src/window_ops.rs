//! [WIN-OPS]前台窗口快捷操作：置顶切换 / 透明度
//! 调节 / 居中 / 半屏分贴。全部 Win32 直调、只操作前台第三方窗口，不注入
//! 任何进程。
//!
//! 结构：同步核心 `*_blocking`（快捷键 dispatch 线程与 Tauri 命令面共用）
//! + 异步命令壳（spawn_blocking）。
//!
//! 透明度记账：`SetLayeredWindowAttributes` 要求窗口有 `WS_EX_LAYERED`——
//! 前台窗口默认没有。首次调低透明度时记下原 exstyle 并补上 LAYERED 位；
//! 回到 100% 时若原样式本无 LAYERED 则还原（避免给别人的窗口留下永久的
//! 分层属性，可能改变其渲染路径）。会话级 HashMap 记账，条目在还原时移除。

use std::collections::HashMap;
use std::sync::Mutex;

/// 透明度步进（百分点；快捷键每按一次 ±10%）。
pub const OPACITY_STEP: i32 = 10;
/// 透明度下限（20%——更低基本不可见，视为误操作区）。
const OPACITY_MIN: i32 = 20;

#[cfg(windows)]
const WS_EX_LAYERED_BIT: usize = 0x0008_0000;
#[cfg(windows)]
const WS_EX_TOPMOST_BIT: usize = 0x0000_0008;
#[cfg(windows)]
const SWP_NOSIZE: u32 = 0x0001;
#[cfg(windows)]
const SWP_NOMOVE: u32 = 0x0002;
#[cfg(windows)]
const SWP_NOACTIVATE: u32 = 0x0010;

/// 首次改动透明度时的原 exstyle 记账（hwnd → 原 exstyle）。
static ORIG_EXSTYLES: Mutex<Option<HashMap<isize, usize>>> = Mutex::new(None);

/* ---------------- 纯函数（单测覆盖） ---------------- */

/// 0–100 百分比步进与钳制。
pub fn next_percent(cur: i32, step: i32) -> i32 {
    (cur + step).clamp(OPACITY_MIN, 100)
}

/// 百分比 → SetLayeredWindowAttributes 的 alpha（0–255）。
pub fn percent_to_alpha(percent: i32) -> u8 {
    (percent.clamp(0, 100) * 255 / 100) as u8
}

/// 工作区矩形内的居中位置（保持尺寸；返回 left/top 物理像素）。
pub fn centered_in(work: (i32, i32, i32, i32), rect: (i32, i32, i32, i32)) -> (i32, i32) {
    let (wx, wy, ww, wh) = work;
    let (rw, rh) = (rect.2 - rect.0, rect.3 - rect.1);
    (wx + (ww - rw) / 2, wy + (wh - rh) / 2)
}

/// 工作区半屏矩形（side: "left"/"right"；x/y/w/h 物理像素）。
pub fn half_work_rect(
    work: (i32, i32, i32, i32),
    side: &str,
) -> Result<(i32, i32, i32, i32), String> {
    let (wx, wy, ww, wh) = work;
    match side {
        // 奇数宽无缝平分：左半 ww/2 向下取整，右半从 wx + ww/2 起占满余量。
        "left" => Ok((wx, wy, ww / 2, wh)),
        "right" => Ok((wx + ww / 2, wy, ww - ww / 2, wh)),
        _ => Err(format!("未知分贴方向：{side}")),
    }
}

/* ---------------- Win32 小工具 ---------------- */

#[cfg(windows)]
fn foreground_hwnd() -> Option<windows::Win32::Foundation::HWND> {
    // SAFETY: GetForegroundWindow 只读查询。
    let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    (!hwnd.0.is_null()).then_some(hwnd)
}

#[cfg(windows)]
fn window_rect(hwnd: windows::Win32::Foundation::HWND) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    let mut rc = RECT::default();
    // SAFETY: 出参结构体按约定传入。
    unsafe {
        if !windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rc).is_ok() {
            return None;
        }
    }
    Some((rc.left, rc.top, rc.right, rc.bottom))
}

#[cfg(windows)]
fn monitor_work_rect(hwnd: windows::Win32::Foundation::HWND) -> (i32, i32, i32, i32) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    // SAFETY: 结构体按 cbSize 约定传入/传出。
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut mi as *mut MONITORINFO).as_bool() {
            // 取不到显示器信息（理论不可达）：回退主屏全屏。
            let (w, h) = (
                windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                    windows::Win32::UI::WindowsAndMessaging::SM_CXSCREEN,
                ),
                windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                    windows::Win32::UI::WindowsAndMessaging::SM_CYSCREEN,
                ),
            );
            return (0, 0, w, h);
        }
        let r: RECT = mi.rcWork;
        (r.left, r.top, r.right, r.bottom)
    }
}

#[cfg(windows)]
fn set_window_pos_raw(
    hwnd: windows::Win32::Foundation::HWND,
    insert_after: Option<windows::Win32::Foundation::HWND>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    flags: u32,
) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SET_WINDOW_POS_FLAGS};
    // SAFETY: 位置/尺寸按值传入；SetWindowPos 对第三方窗口跨线程安全
    // （属性设置类 API）。不动几何的维度由 flags（NOMOVE/NOSIZE）声明。
    unsafe { SetWindowPos(hwnd, insert_after, x, y, w, h, SET_WINDOW_POS_FLAGS(flags)).is_ok() }
}

/* ---------------- 同步核心（dispatch / 命令共用） ---------------- */

/// 前台窗口置顶切换。返回切换后的置顶态。
pub fn toggle_topmost_blocking() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE};
        let Some(hwnd) = foreground_hwnd() else {
            return Err("当前没有前台窗口".to_string());
        };
        // SAFETY: GWL_EXSTYLE 只读查询，跨线程安全。
        let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as usize;
        let topmost = ex & WS_EX_TOPMOST_BIT != 0;
        let insert_after = if topmost {
            HWND(-2isize as *mut core::ffi::c_void) // HWND_NOTOPMOST
        } else {
            HWND(-1isize as *mut core::ffi::c_void) // HWND_TOPMOST
        };
        if !set_window_pos_raw(
            hwnd,
            Some(insert_after),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        ) {
            return Err("置顶切换失败".to_string());
        }
        Ok(!topmost)
    }
    #[cfg(not(windows))]
    Err("仅支持 Windows".to_string())
}

/// 前台窗口透明度调节（step：百分点，正数调浓、负数调淡）。返回新百分比。
pub fn adjust_opacity_blocking(step: i32) -> Result<i32, String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetLayeredWindowAttributes, GetWindowLongPtrW, SetLayeredWindowAttributes,
            SetWindowLongPtrW, GWL_EXSTYLE,
        };
        let Some(hwnd) = foreground_hwnd() else {
            return Err("当前没有前台窗口".to_string());
        };
        // SAFETY: exstyle/alpha 读写针对第三方前台窗口——属性类 API 跨线程安全。
        let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as usize;
        let mut cur_percent = 100i32;
        if ex & WS_EX_LAYERED_BIT != 0 {
            let mut alpha: u8 = 0;
            if unsafe { GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), None) }.is_ok() {
                cur_percent = alpha as i32 * 100 / 255;
            }
        }
        let next = next_percent(cur_percent, step);
        if next >= 100 && cur_percent >= 100 {
            // 已是不透明：无需动窗口（幂等）。
            return Ok(100);
        }
        if next >= 100 {
            // 回到 100%：alpha 满值；若 LAYERED 是我们补的则一并还原。
            unsafe {
                let _ = SetLayeredWindowAttributes(
                    hwnd,
                    windows::Win32::Foundation::COLORREF(0),
                    255,
                    windows::Win32::UI::WindowsAndMessaging::LWA_ALPHA,
                );
            }
            restore_layered_if_added(hwnd);
            return Ok(100);
        }
        // 调低：首次补 LAYERED 位并记账原样式。
        if ex & WS_EX_LAYERED_BIT == 0 {
            remember_orig_exstyle(hwnd.0 as isize, ex);
            unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_LAYERED_BIT) as isize) };
        }
        let ok = unsafe {
            SetLayeredWindowAttributes(
                hwnd,
                windows::Win32::Foundation::COLORREF(0),
                percent_to_alpha(next),
                windows::Win32::UI::WindowsAndMessaging::LWA_ALPHA,
            )
        }
        .is_ok();
        if !ok {
            return Err("调节透明度失败".to_string());
        }
        Ok(next)
    }
    #[cfg(not(windows))]
    {
        let _ = step;
        Err("仅支持 Windows".to_string())
    }
}

/// 前台窗口透明度还原（100% + 还原补加的 LAYERED 位）。
pub fn reset_opacity_blocking() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::SetLayeredWindowAttributes;
        let Some(hwnd) = foreground_hwnd() else {
            return Err("当前没有前台窗口".to_string());
        };
        // SAFETY: 同 adjust_opacity_blocking。
        unsafe {
            let _ = SetLayeredWindowAttributes(
                hwnd,
                windows::Win32::Foundation::COLORREF(0),
                255,
                windows::Win32::UI::WindowsAndMessaging::LWA_ALPHA,
            );
            restore_layered_if_added(hwnd);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("仅支持 Windows".to_string())
}

/// 前台窗口居中到其所在显示器工作区（保持尺寸）。
pub fn center_foreground_blocking() -> Result<(), String> {
    #[cfg(windows)]
    {
        let Some(hwnd) = foreground_hwnd() else {
            return Err("当前没有前台窗口".to_string());
        };
        let Some(rect) = window_rect(hwnd) else {
            return Err("读取窗口位置失败".to_string());
        };
        let work = monitor_work_rect(hwnd);
        let (x, y) = centered_in(work, rect);
        if !set_window_pos_raw(hwnd, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE) {
            return Err("居中失败".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("仅支持 Windows".to_string())
}

/// 前台窗口半屏分贴（side: "left"/"right"）。
pub fn snap_foreground_blocking(side: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let Some(hwnd) = foreground_hwnd() else {
            return Err("当前没有前台窗口".to_string());
        };
        let work = monitor_work_rect(hwnd);
        let (x, y, w, h) = half_work_rect(work, side)?;
        if !set_window_pos_raw(hwnd, None, x, y, w, h, SWP_NOACTIVATE) {
            return Err("分贴失败".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = side;
        Err("仅支持 Windows".to_string())
    }
}

/* ---------------- 记账 ---------------- */

/// 还原补加的 WS_EX_LAYERED（仅当记账显示原样式没有该位）。
#[cfg(windows)]
fn restore_layered_if_added(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWL_EXSTYLE};
    if let Some(orig) = take_orig_exstyle(hwnd.0 as isize) {
        if orig & WS_EX_LAYERED_BIT == 0 {
            // SAFETY: 记账值来自本模块此前的只读查询。
            unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, orig as isize) };
        }
    }
}

fn remember_orig_exstyle(hwnd: isize, ex: usize) {
    let mut guard = ORIG_EXSTYLES.lock().unwrap_or_else(|p| p.into_inner());
    guard.get_or_insert_with(HashMap::new).insert(hwnd, ex);
}

fn take_orig_exstyle(hwnd: isize) -> Option<usize> {
    let mut guard = ORIG_EXSTYLES.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_mut()?.remove(&hwnd)
}

/* ---------------- Tauri 命令 ----------------
 * 虽然只操作第三方前台窗口，但 web-preview 远程页同样可调——把用户
 * 正在输密码的前台窗口透明度压到 20% / 反复置顶分贴是视觉欺骗与干扰面，
 * 与 sys_* 同标准挂 require_trusted。 */

/// 前台窗口置顶切换。返回切换后的置顶态。
#[tauri::command]
pub async fn win_toggle_topmost(window: tauri::Window) -> Result<bool, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(toggle_topmost_blocking)
        .await
        .map_err(|e| e.to_string())?
}

/// 前台窗口透明度调节（step：百分点）。返回当前透明度百分比（0–100）。
#[tauri::command]
pub async fn win_adjust_opacity(window: tauri::Window, step: i32) -> Result<i32, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || adjust_opacity_blocking(step))
        .await
        .map_err(|e| e.to_string())?
}

/// 前台窗口透明度还原。
#[tauri::command]
pub async fn win_reset_opacity(window: tauri::Window) -> Result<(), String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(reset_opacity_blocking)
        .await
        .map_err(|e| e.to_string())?
}

/// 前台窗口居中。
#[tauri::command]
pub async fn win_center_foreground(window: tauri::Window) -> Result<(), String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(center_foreground_blocking)
        .await
        .map_err(|e| e.to_string())?
}

/// 前台窗口半屏分贴（side: "left"/"right"）。
#[tauri::command]
pub async fn win_snap_foreground(window: tauri::Window, side: String) -> Result<(), String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || snap_foreground_blocking(&side))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_steps_clamped() {
        assert_eq!(next_percent(100, -OPACITY_STEP), 90);
        assert_eq!(next_percent(90, OPACITY_STEP), 100);
        // 下限 20，不越过不可见区。
        assert_eq!(next_percent(25, -OPACITY_STEP), 20);
        assert_eq!(next_percent(20, -OPACITY_STEP), 20);
        // 上限 100。
        assert_eq!(next_percent(95, OPACITY_STEP), 100);
    }

    #[test]
    fn percent_alpha_roundtrip() {
        assert_eq!(percent_to_alpha(100), 255);
        assert_eq!(percent_to_alpha(0), 0);
        assert_eq!(percent_to_alpha(50), 127);
        // 越界输入按 0–100 钳制。
        assert_eq!(percent_to_alpha(120), 255);
        assert_eq!(percent_to_alpha(-5), 0);
    }

    #[test]
    fn centered_keeps_size_within_work_area() {
        let work = (0, 0, 1920, 1040);
        let rect = (100, 100, 960, 540);
        let (x, y) = centered_in(work, rect);
        assert_eq!((x, y), ((1920 - 860) / 2, (1040 - 440) / 2));
        // 大窗口也不出负坐标。
        let (x2, y2) = centered_in(work, (0, 0, 2000, 1100));
        assert_eq!((x2, y2), (-40, -30));
    }

    #[test]
    fn half_work_rect_splits_exactly() {
        let work = (0, 0, 1920, 1040);
        assert_eq!(half_work_rect(work, "left").unwrap(), (0, 0, 960, 1040));
        assert_eq!(half_work_rect(work, "right").unwrap(), (960, 0, 960, 1040));
        // 奇数宽：左半向下取整，右半从右边缘回推，无缝且不溢出。
        let odd = (0, 0, 1921, 1040);
        let (lx, _, lw, _) = half_work_rect(odd, "left").unwrap();
        let (rx, _, rw, _) = half_work_rect(odd, "right").unwrap();
        assert_eq!(lw + rw, 1921);
        assert_eq!(lx + lw, rx);
        assert!(half_work_rect(work, "up").unwrap_err().contains("未知"));
    }
}
