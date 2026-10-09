//! 屏幕取色（一期）：读取鼠标当前位置的像素颜色。
//!
//! 全屏覆盖窗 + 放大镜的完整版成本高；一期由前端进入「取色模式」后低频
//! 轮询本命令，实时预览鼠标下像素，确认后写入取色器。GetDC(None) 取整个
//! 虚拟屏幕的 DC，GetPixel 返回 COLORREF（0x00BBGGRR）。

use serde::Serialize;

#[derive(Serialize)]
pub struct ScreenPixel {
    pub x: i32,
    pub y: i32,
    /// 形如 `#RRGGBB`（大写）。
    pub hex: String,
}

#[tauri::command]
pub async fn pick_screen_color(window: tauri::Window) -> Result<ScreenPixel, String> {
    // 读取屏幕像素等价于局部截屏能力：只有受信窗口可调。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 取色模式下前端高频轮询本命令：同步命令会跑在 Tauri 主线程上，每次
    // GetDC/GetPixel 的停顿都会叠加成可感知的整窗卡顿，放 blocking 池。
    tauri::async_runtime::spawn_blocking(pick_screen_color_blocking)
        .await
        .map_err(|e| format!("取色任务失败: {e}"))?
}

fn pick_screen_color_blocking() -> Result<ScreenPixel, String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
        use windows::Win32::UI::HiDpi::{
            SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        unsafe {
            // （GetPixel DPI 失真）：GetCursorPos 与 GetDC(None)+GetPixel 的
            // 坐标系在进程 DPI 上下文自洽（PMv2 下同为物理像素），但混合 DPI
            // 多屏上若本线程被别的初始化路径留在 Per-Monitor V1 / Unaware，
            // 虚拟屏 DC 的映射会与光标物理坐标错位、取到偏移像素。读取段
            // 固定 Per-Monitor V2（audio.rs COM 初始化同款"进入-恢复"模式）。
            let prev_ctx = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let result = (|| {
                let mut pt = POINT::default();
                GetCursorPos(&mut pt).map_err(|_| "无法获取鼠标位置".to_string())?;
                let hdc = GetDC(None);
                // 无屏幕会话/高度受限时 GetDC 返回 null；GetPixel(null,…) 返回
                // CLR_INVALID(0xFFFFFFFF)，按 0xBBGGRR 解析会给出垃圾色 #FFFFFF。
                if hdc.is_invalid() {
                    return Err("无法获取屏幕设备上下文".to_string());
                }
                let c = GetPixel(hdc, pt.x, pt.y).0;
                ReleaseDC(None, hdc);
                if c == 0xFFFF_FFFF {
                    return Err("无法读取该位置的颜色".to_string());
                }
                let r = c & 0xFF;
                let g = (c >> 8) & 0xFF;
                let b = (c >> 16) & 0xFF;
                Ok(ScreenPixel {
                    x: pt.x,
                    y: pt.y,
                    hex: format!("#{r:02X}{g:02X}{b:02X}"),
                })
            })();
            if !prev_ctx.is_invalid() {
                SetThreadDpiAwarenessContext(prev_ctx);
            }
            result
        }
    }
    #[cfg(not(windows))]
    {
        Err("屏幕取色仅支持 Windows".to_string())
    }
}
