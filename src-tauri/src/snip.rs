//! 截图套件（借鉴 ClassSoftwareHub #4）：冻结帧框选 + 标注 + 钉图。
//!
//! 流程：`start_snip` 抓光标所在显示器的整屏位图（GDI BitBlt + CAPTUREBLT，
//! 含层叠窗口），存 PNG 到 `<appdata>/snip/frame-*.png`，记录元数据，随后
//! 在该显示器上建一个无边框置顶的 snip 覆盖窗；前端用冻结帧当背景做框选
//! 与标注（覆盖层永远不会拍到自己），导出时走 copy_image_to_clipboard /
//! write_snip_png / pin_snip_image 三个出口。
//!
//! 关键坑（CSH 同款教训）：DIB 的 alpha 通道统一刷 255，否则 PNG 解码器把
//! 整张图当全透明；CAPTUREBLT 必须带，否则截不到层叠窗口（本应用桌面层
//! 就是 layered window）。

use std::sync::Mutex;

use tauri::Manager;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    HGDIOBJ, SRCCOPY,
};

/// 一次待处理的冻结帧元数据（snip 窗口就绪后向前端提供）。
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct SnipFrame {
    /// PNG 落盘路径（<appdata>/snip/ 下）。
    pub path: String,
    /// 物理像素宽高。
    #[ts(type = "number")]
    pub phys_w: u32,
    #[ts(type = "number")]
    pub phys_h: u32,
    /// 显示器缩放（物理 → 逻辑 CSS 像素换算）。
    pub scale: f64,
}

static PENDING_FRAME: Mutex<Option<SnipFrame>> = Mutex::new(None);

fn snip_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::vela_data_dir(app)
        .map_err(|e| format!("数据目录不可用：{e}"))?
        .join("snip");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败：{e}"))?;
    Ok(dir)
}

/// BGRA（内存序 B,G,R,A）转 RGBA；alpha 统一 255（DIB 半透明陷阱）。
pub fn bgra_to_rgba(buf: &[u8], w: u32, h: u32) -> image::RgbaImage {
    let mut out = image::RgbaImage::new(w, h);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = (y * w as usize + x) * 4;
            out.put_pixel(
                x as u32,
                y as u32,
                image::Rgba([buf[i + 2], buf[i + 1], buf[i], 255]),
            );
        }
    }
    out
}

/// GDI 整屏抓取：物理坐标 (sx, sy) 起 w×h 区域 → RgbaImage。
unsafe fn capture_region(sx: i32, sy: i32, w: u32, h: u32) -> Result<image::RgbaImage, String> {
    let hdc_screen = GetDC(None);
    if hdc_screen.is_invalid() {
        return Err("获取屏幕 DC 失败".into());
    }
    let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            // 负高 = top-down 行序（省一次垂直翻转）。
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
    let hbmp = CreateDIBSection(Some(hdc_mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
        .map_err(|_| "创建 DIB 截面失败".to_string())?;
    if bits.is_null() {
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(None, hdc_screen);
        return Err("DIB 像素缓冲为空".into());
    }
    let old = SelectObject(hdc_mem, HGDIOBJ(hbmp.0));
    let blit = BitBlt(
        hdc_mem,
        0,
        0,
        w as i32,
        h as i32,
        Some(hdc_screen),
        sx,
        sy,
        SRCCOPY | CAPTUREBLT,
    );
    if blit.is_ok() {
        // 让 GDI 把像素真正落进 DIB（部分驱动下显式 GdiFlush 更稳）。
        let _ = GdiFlush();
    }
    let buf = blit.ok().map(|_| {
        let len = (w as usize) * (h as usize) * 4;
        std::slice::from_raw_parts(bits as *const u8, len).to_vec()
    });
    let _ = SelectObject(hdc_mem, old);
    let _ = DeleteObject(HGDIOBJ(hbmp.0));
    let _ = DeleteDC(hdc_mem);
    let _ = ReleaseDC(None, hdc_screen);
    match buf {
        Some(bytes) => Ok(bgra_to_rgba(&bytes, w, h)),
        None => Err("BitBlt 抓屏失败".into()),
    }
}

/// 抓光标所在显示器 → 落盘 → 建 snip 覆盖窗。托盘 / 快捷键 / 命令面板共用。
pub fn start_snip_internal(app: &tauri::AppHandle) {
    // 已有 snip 窗在跑：先关掉重来（连续触发的逃生门）。
    if let Some(w) = app.get_webview_window("snip") {
        let _ = w.close();
    }
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|pos| app.monitor_from_point(pos.x, pos.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else {
        log::warn!("snip: no monitor available");
        return;
    };
    let scale = m.scale_factor();
    let phys = m.size();
    let pos = m.position();
    // 物理尺寸裁到 GDI 可承受范围（防畸形显示器上报溢出）。
    let w = phys.width.min(16_384);
    let h = phys.height.min(16_384);
    let img = match unsafe { capture_region(pos.x, pos.y, w, h) } {
        Ok(img) => img,
        Err(e) => {
            log::warn!("snip: capture failed: {e}");
            return;
        }
    };
    let dir = match snip_dir(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("snip: {e}");
            return;
        }
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("frame-{stamp}.png"));
    if let Err(e) = img.save_with_format(&path, image::ImageFormat::Png) {
        log::warn!("snip: save frame failed: {e}");
        return;
    }
    // 清掉 3 天前的旧帧（截图目录只是中转站，钉图/保存有自己的副本）。
    cleanup_old_frames(&dir);
    let frame = SnipFrame {
        path: path.to_string_lossy().into_owned(),
        phys_w: w,
        phys_h: h,
        scale,
    };
    if let Ok(mut g) = PENDING_FRAME.lock() {
        *g = Some(frame);
    }
    show_snip_window(app, pos.x, pos.y, w, h, scale);
}

fn cleanup_old_frames(dir: &std::path::Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(3 * 24 * 3600);
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("png") {
                continue;
            }
            let stale = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|age| age > MAX_AGE)
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// 无边框置顶覆盖窗：铺满目标显示器（逻辑坐标换算），就绪握手 + 3s 兜底。
fn show_snip_window(app: &tauri::AppHandle, mx: i32, my: i32, pw: u32, ph: u32, scale: f64) {
    let built = tauri::WebviewWindowBuilder::new(
        app,
        "snip",
        // C-10：snip.html 精简入口（vite 多页）——不再共用 index.html 全量
        // 主包（3.5 万行 CSS 大头 + 双 store 水合）；旧 hash 由 main.tsx
        // 重定向兜底。
        tauri::WebviewUrl::App("snip.html".into()),
    )
    .title("Vela 截图")
    .position(mx as f64 / scale, my as f64 / scale)
    .inner_size(pw as f64 / scale, ph as f64 / scale)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .build();
    match built {
        Ok(_) => crate::windows::spawn_show_fallback(app, "snip", 3000),
        Err(e) => log::warn!("snip: build window failed: {e}"),
    }
}

#[tauri::command]
pub async fn start_snip(window: tauri::Window) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 命令面板等桌面层入口：直接在主线程外的执行器里跑（抓屏本身很快，
    // 但落盘有 IO；spawn 避免阻塞调用方 webview）。
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || start_snip_internal(&app))
        .await
        .map_err(|e| e.to_string())
}

/// snip 覆盖窗就绪后取冻结帧元数据（取走即清空，防陈旧帧复用）。
/// D-9：截图帧路径 + 屏幕物理尺寸只放行给 snip 覆盖窗——低信任窗口
/// （含 web-preview 远程页）没有理由读待处理的截图。
#[tauri::command]
pub fn get_snip_frame(window: tauri::Window) -> Option<SnipFrame> {
    if window.label() != "snip" {
        return None;
    }
    PENDING_FRAME.lock().ok().and_then(|mut g| g.take())
}

/// 「保存」出口：把前端合成的 PNG dataURL 写到用户指定路径。
/// D-4：任意路径 + 任意内容的文件写原语不允许暴露给全部 trusted 窗口
/// （widget 层渲染歌词/邮件主题等不可信内容）——收窄到 snip 覆盖窗，
/// 且载荷必须是真 PNG（魔数校验，防把任意字节写进 .png 名下）。
#[tauri::command]
pub async fn write_snip_png(
    window: tauri::Window,
    data_url: String,
    path: String,
) -> Result<(), String> {
    if window.label() != "snip" {
        return Err("untrusted window".into());
    }
    if path.trim().is_empty() {
        return Err("保存路径为空".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bytes = decode_png_data_url(&data_url)?;
        let p = std::path::PathBuf::from(&path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        std::fs::write(&p, &bytes).map_err(|e| format!("写入文件失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 「钉图」出口：合成图落盘 gallery 目录（asset scope 已覆盖），返回路径
/// 与自然尺寸，前端事件让 primary 窗把贴图组件放上画布。
#[tauri::command]
pub async fn pin_snip_image(
    window: tauri::Window,
    app: tauri::AppHandle,
    data_url: String,
) -> Result<SnipPinResult, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<SnipPinResult, String> {
        let bytes = decode_png_data_url(&data_url)?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("解码图片失败：{e}"))?;
        let (w, h) = (img.width(), img.height());
        let dir = crate::files::gallery_dir(&app)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = dir.join(format!("snip-{stamp}.png"));
        std::fs::write(&path, &bytes).map_err(|e| format!("写入钉图失败：{e}"))?;
        Ok(SnipPinResult {
            path: path.to_string_lossy().into_owned(),
            #[allow(clippy::unnecessary_cast)]
            w: w as i64,
            h: h as i64,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct SnipPinResult {
    pub path: String,
    #[ts(type = "number")]
    pub w: i64,
    #[ts(type = "number")]
    pub h: i64,
}

/// dataURL（data:image/png;base64,…）→ PNG 字节。前缀宽松校验 + D-4 魔数
/// 校验：解码结果必须以 PNG 8 字节签名开头，防「PNG 前缀的 dataURL 里裹
/// 任意字节」绕过写原语的内容约束。
fn decode_png_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    let comma = data_url.find(',').ok_or("dataURL 格式错误")?;
    let (meta, b64) = data_url.split_at(comma);
    if !meta.starts_with("data:image/png;base64") {
        return Err("仅支持 PNG dataURL".into());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&b64[1..])
        .map_err(|e| format!("base64 解码失败：{e}"))?;
    if !bytes.starts_with(&PNG_MAGIC) {
        return Err("内容不是有效的 PNG".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_to_rgba_swaps_channels_and_forces_opaque() {
        // BGRA 内存序：B=10 G=20 R=30 A=0（半透明陷阱值）。
        let buf = [10u8, 20, 30, 0];
        let img = bgra_to_rgba(&buf, 1, 1);
        assert_eq!(img.get_pixel(0, 0).0, [30u8, 20, 10, 255]);
    }

    #[test]
    fn bgra_to_rgba_row_order_top_down() {
        // 两行各一像素：top-down DIB 第一行在前。
        let buf = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let img = bgra_to_rgba(&buf, 1, 2);
        assert_eq!(img.get_pixel(0, 0)[0], 3);
        assert_eq!(img.get_pixel(0, 1)[0], 7);
    }

    #[test]
    fn decode_png_data_url_rejects_non_png() {
        assert!(decode_png_data_url("data:image/jpeg;base64,AAAA").is_err());
        assert!(decode_png_data_url("not-a-data-url").is_err());
    }

    #[test]
    fn decode_png_data_url_roundtrip() {
        let png_header_only = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(png_header_only);
        let url = format!("data:image/png;base64,{b64}");
        assert_eq!(decode_png_data_url(&url).unwrap(), png_header_only);
    }
}
