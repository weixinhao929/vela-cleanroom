//! Win32 剪贴板：按需读写 + 历史监听（CLIP，§4.10）。
//!
//! 读方向：WebView2 里 `navigator.clipboard.readText()` 需要 clipboard-read
//! 权限，Tauri 默认不授予（会静默失败或弹浏览器权限条），因此由后端直接读
//! CF_UNICODETEXT。写方向（复制/剪切）仍走 `document.execCommand`，它对
//! 页面内编辑控件可靠且保留撤销栈，无需后端参与。
//!
//! 另含 W-102 涂鸦复制：把 PNG dataURL 以 CF_DIBV5（带 alpha）+ CF_DIB
//! （白底合成）双格式写入系统剪贴板，兼容从 Paint 到微信的各类粘贴方。
//!
//! §4.10 剪贴板历史：`AddClipboardFormatListener` 隐藏窗口监听变化 → 文本
//! （CF_UNICODETEXT）与图片（PNG 注册格式 / CF_DIBV5 / CF_DIB，统一转 PNG）
//! 入 SQLite（db v8）；隐私优先——密码管理器的
//! `ExcludeClipboardContentFromMonitorProcessing` 标记与
//! `CanIncludeInClipboardHistory=0` 一律不入库，采集开关从设置镜像实时读取。

/// CF_UNICODETEXT（标准剪贴板格式常量，避免引入 Ole feature）。
const CF_UNICODETEXT: u32 = 13;

#[tauri::command]
pub fn read_clipboard_text(window: tauri::Window) -> Result<String, String> {
    // 剪贴板可能装着口令等敏感文本：只有受信窗口可读。Window 由 Tauri 注入，
    // 前端 invoke 参数不变。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::DataExchange::{
            CloseClipboard, GetClipboardData, OpenClipboard,
        };
        use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

        unsafe {
            // 打开失败通常意味着另一进程正占用剪贴板，直接报错让前端静默跳过。
            OpenClipboard(None).map_err(|_| "剪贴板被占用".to_string())?;

            let read = || -> Result<String, String> {
                let handle =
                    GetClipboardData(CF_UNICODETEXT).map_err(|_| "剪贴板中没有文本".to_string())?;
                if handle.is_invalid() {
                    return Err("剪贴板中没有文本".to_string());
                }
                let global = HGLOBAL(handle.0);
                let ptr = GlobalLock(global) as *const u16;
                if ptr.is_null() {
                    return Err("无法锁定剪贴板内存".to_string());
                }
                // GlobalSize 是分配字节数；按 UTF-16 扫到首个 NUL 即字符串结束。
                // 上限 1M 个 u16（2MB）：异常/恶意的剪贴板把 GlobalSize 声明成
                // 数百 MB 时不至于一次性分配巨型缓冲。
                let cap = (GlobalSize(global) / 2).min(1024 * 1024);
                let mut units: Vec<u16> = Vec::with_capacity(cap);
                for i in 0..cap {
                    let ch = *ptr.add(i);
                    if ch == 0 {
                        break;
                    }
                    units.push(ch);
                }
                let _ = GlobalUnlock(global);
                Ok(String::from_utf16_lossy(&units))
            };

            let result = read();
            // 无论成败都必须关闭剪贴板，否则其它应用无法访问。
            let _ = CloseClipboard();
            result
        }
    }
    #[cfg(not(windows))]
    {
        Err("剪贴板读取仅支持 Windows".to_string())
    }
}

/* ------------------------------------------------------------------ */
/* W-102 涂鸦画布 → 系统剪贴板（图片）                                */
/* ------------------------------------------------------------------ */

const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

/// 以小端序把一个字段追加进 DIB 头部缓冲（手写序列化，避免引 winapi 结构体）。
trait LePush {
    fn push_u16(&mut self, v: u16);
    fn push_u32(&mut self, v: u32);
    fn push_i32(&mut self, v: i32);
}
impl LePush for Vec<u8> {
    fn push_u16(&mut self, v: u16) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn push_u32(&mut self, v: u32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn push_i32(&mut self, v: i32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
}

/// BITMAPV5HEADER（124 字节）：BI_BITFIELDS + alpha 掩码，保留透明度。
fn bitmap_v5_header(w: i32, h: i32, size_image: u32) -> Vec<u8> {
    let mut b = Vec::with_capacity(124);
    b.push_u32(124); // bV5Size
    b.push_i32(w);
    b.push_i32(h); // 正值 = 自底向上
    b.push_u16(1); // planes
    b.push_u16(32); // bpp
    b.push_u32(3); // BI_BITFIELDS
    b.push_u32(size_image);
    b.push_i32(3780); // 96 DPI
    b.push_i32(3780);
    b.push_u32(0); // clrUsed
    b.push_u32(0); // clrImportant
    b.push_u32(0x00FF_0000); // red mask
    b.push_u32(0x0000_FF00); // green mask
    b.push_u32(0x0000_00FF); // blue mask
    b.push_u32(0xFF00_0000); // alpha mask
    b.push_u32(0x7352_4742); // 'sRGB'
    b.extend_from_slice(&[0u8; 36]); // endpoints
    b.push_u32(0);
    b.push_u32(0);
    b.push_u32(0); // gamma
    b.push_u32(4); // LCS_GM_IMAGES
    b.push_u32(0);
    b.push_u32(0); // profile data/size
    b.push_u32(0); // reserved
    b
}

/// BGRA 像素行（4 字节自然对齐，32bpp 无需额外 padding），自底向上排列。
/// `over_white` = true 时把 alpha 合成到白底并把 alpha 置 0（CF_DIB 兼容版）。
fn rgba_to_bgra_rows(rgba: &image::RgbaImage, over_white: bool) -> Vec<u8> {
    let (w, h) = rgba.dimensions();
    let stride = w as usize * 4;
    let mut out = vec![0u8; stride * h as usize];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let px = rgba.get_pixel(x as u32, (h as usize - 1 - y) as u32).0;
            let o = y * stride + x * 4;
            if over_white {
                let a = px[3] as u16;
                out[o] = (px[2] as u16 * a / 255 + 255 * (255 - a) / 255) as u8;
                out[o + 1] = (px[1] as u16 * a / 255 + 255 * (255 - a) / 255) as u8;
                out[o + 2] = (px[0] as u16 * a / 255 + 255 * (255 - a) / 255) as u8;
                out[o + 3] = 0;
            } else {
                out[o] = px[2];
                out[o + 1] = px[1];
                out[o + 2] = px[0];
                out[o + 3] = px[3];
            }
        }
    }
    out
}

/// 把一段字节以指定剪贴板格式写入（GMEM_MOVEABLE + SetClipboardData）。
/// 成功后句柄所有权移交系统；任一失败路径都必须 GlobalFree——分配成功
/// 却没交给系统的块（GlobalLock 失败 / SetClipboardData 拒收）否则按
/// 图片大小泄漏内存。
unsafe fn set_clipboard_bytes(format: u32, bytes: &[u8]) -> Result<(), String> {
    use windows::Win32::Foundation::GlobalFree;
    use windows::Win32::System::DataExchange::SetClipboardData;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let global =
        GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| format!("分配剪贴板内存失败: {e}"))?;
    let ptr = GlobalLock(global) as *mut u8;
    if ptr.is_null() {
        let _ = GlobalFree(Some(global));
        return Err("无法锁定剪贴板内存".to_string());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
    let _ = GlobalUnlock(global);
    // SetClipboardData 需要的是 HGLOBAL 句柄本身，不是 GlobalLock 返回的数据
    // 指针（GMEM_MOVEABLE 的锁指针 ≠ 句柄；把数据地址当句柄交给系统会被当
    // 作无效/悬挂句柄处理）。成功后句柄所有权移交系统，不可再 GlobalFree。
    let handle = windows::Win32::Foundation::HANDLE(global.0);
    if let Err(e) = SetClipboardData(format, Some(handle)) {
        let _ = GlobalFree(Some(global));
        return Err(format!("写入剪贴板失败: {e}"));
    }
    Ok(())
}

/// W-102 把 PNG dataURL（`data:image/png;base64,…`）写入系统剪贴板。
/// 同时写 CF_DIBV5（带 alpha，支持透明粘贴进支持的应用）与 CF_DIB
/// （白底合成，保证老应用不出现黑底）。
///
/// base64 解码 + PNG 解码 + 两份 BGRA 行缓冲（上限各 256MB）都是重 CPU/内存
/// 操作，必须 spawn_blocking——同步命令会把主线程冻结数秒。
#[tauri::command]
pub async fn copy_image_to_clipboard(
    window: tauri::Window,
    data_url: String,
) -> Result<(), String> {
    // 覆盖用户剪贴板属副作用能力，同样收口到受信窗口。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || copy_image_to_clipboard_blocking(data_url))
        .await
        .map_err(|e| format!("复制任务失败：{e}"))?
}

fn copy_image_to_clipboard_blocking(data_url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use base64::Engine as _;

        let b64 = data_url
            .split_once(',')
            .map(|(_, b)| b.trim())
            .ok_or_else(|| "无效的图片数据".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Base64 解码失败：{e}"))?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("解码图片失败：{e}"))?
            .to_rgba8();
        let (w, h) = img.dimensions();
        if w == 0 || h == 0 || w > 8192 || h > 8192 {
            return Err("图片尺寸超出范围".to_string());
        }
        unsafe { write_image_to_clipboard(&img) }
    }
    #[cfg(not(windows))]
    {
        let _ = data_url;
        Err("图片剪贴板仅支持 Windows".to_string())
    }
}

/// 把一张 RGBA 图以 CF_DIBV5（带 alpha）+ CF_DIB（白底合成）双格式写入系统
/// 剪贴板。涂鸦复制与剪贴板历史的「回写」共用此入口。
/// 非 Windows 平台由调用方各自报错（历史条目只可能由 Windows 监听产生）。
#[cfg(windows)]
pub(crate) unsafe fn write_image_to_clipboard(img: &image::RgbaImage) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard};

    let (w, h) = img.dimensions();
    let v5_pixels = rgba_to_bgra_rows(img, false);
    let mut v5 = bitmap_v5_header(w as i32, h as i32, v5_pixels.len() as u32);
    v5.extend_from_slice(&v5_pixels);

    let dib_pixels = rgba_to_bgra_rows(img, true);
    let mut dib = Vec::with_capacity(40 + dib_pixels.len());
    {
        dib.push_u32(40); // BITMAPINFOHEADER
        dib.push_i32(w as i32);
        dib.push_i32(h as i32);
        dib.push_u16(1);
        dib.push_u16(32);
        dib.push_u32(0); // BI_RGB
        dib.push_u32(dib_pixels.len() as u32);
        dib.push_i32(3780);
        dib.push_i32(3780);
        dib.push_u32(0);
        dib.push_u32(0);
    }
    dib.extend_from_slice(&dib_pixels);

    OpenClipboard(None).map_err(|_| "剪贴板被占用".to_string())?;
    let result = (|| {
        EmptyClipboard().map_err(|e| format!("清空剪贴板失败：{e}"))?;
        set_clipboard_bytes(CF_DIBV5, &v5)?;
        set_clipboard_bytes(CF_DIB, &dib)?;
        Ok(())
    })();
    // 任一格式失败都已 EmptyClipboard，残留为空剪贴板而非半吊子数据。
    let _ = CloseClipboard();
    result
}

/// 把文本以 CF_UNICODETEXT 写入系统剪贴板（UTF-16 + 结尾 NUL）。
/// 历史条目「点击回写」的文本路径；页面内编辑控件仍走 execCommand。
#[cfg(windows)]
pub(crate) unsafe fn write_text_to_clipboard(text: &str) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard};

    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    let mut bytes = Vec::with_capacity(units.len() * 2);
    for u in &units {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    OpenClipboard(None).map_err(|_| "剪贴板被占用".to_string())?;
    let result = (|| {
        EmptyClipboard().map_err(|e| format!("清空剪贴板失败：{e}"))?;
        set_clipboard_bytes(CF_UNICODETEXT, &bytes)
    })();
    let _ = CloseClipboard();
    result
}

/// [CTX]（ZTools 借鉴 #2）写文本的公开入口：win_context::copy_text_to_clipboard
/// 命令复用（历史回写与上下文动作「复制路径 / 复制 URL」同一条写入路径）。
/// 写入触发 WM_CLIPBOARDUPDATE 后由去重路径兜底（最新一条同哈希 → 刷新而非
/// 新增行），不会把自己写的同内容刷成重复记录。
#[cfg(windows)]
pub unsafe fn write_text_pub(text: &str) -> Result<(), String> {
    write_text_to_clipboard(text)
}

/// [SUPER-PANEL]（ZTools 借鉴 #11）打开剪贴板读一次文本（截断 1MB；空 / 无
/// 文本格式为 None）。取词流程专用，不入历史。
#[cfg(windows)]
pub(crate) unsafe fn read_text_now() -> Option<String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    OpenClipboard(None).ok()?;
    let inner = || {
        let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
        if handle.is_invalid() {
            return None;
        }
        let global = windows::Win32::Foundation::HGLOBAL(handle.0);
        let ptr = GlobalLock(global) as *const u16;
        if ptr.is_null() {
            return None;
        }
        let cap = (GlobalSize(global) / 2).min(512 * 1024);
        let mut units: Vec<u16> = Vec::with_capacity(cap);
        for i in 0..cap {
            let ch = *ptr.add(i);
            if ch == 0 {
                break;
            }
            units.push(ch);
        }
        let _ = GlobalUnlock(global);
        let text = String::from_utf16_lossy(&units);
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    };
    let r = inner();
    let _ = CloseClipboard();
    r
}

/* ------------------------------------------------------------------ */
/* §4.10 剪贴板历史（CLIP）：纯函数核心 + 监听线程 + IPC 命令          */
/* ------------------------------------------------------------------ */

use crate::db::{lock_db, DbError, DbResult};
use crate::models::ClipboardEntry;
use crate::repositories::{ClipboardRepo, NewClipboardEntry, SettingsRepo};

/// 剪贴板内容变化事件（载荷为空，前端收到后重新拉列表）。
pub const CLIPBOARD_CHANGED_EVENT: &str = "clipboard:changed";
/// 复制了纯链接（载荷 { url }）：前端弹「链接快开」接管条（一.4，借鉴
/// NotchPeninsula 的剪贴板链接面板）。仅在采集开启 + linkPopup 开启时发出；
/// 与历史入库互不影响（链接照常入历史）。
pub const CLIPBOARD_URL_EVENT: &str = "clipboard:url";
/// 设置镜像键（settings-store 双后端写入的 SQLite 快照）。
const SETTINGS_MIRROR_KEY: &str = "app:settings:v1";

/// 密码管理器等敏感来源的剪贴板标记格式（存在即不入库）。
pub const EXCLUDE_FROM_MONITOR_PROCESSING: &str = "ExcludeClipboardContentFromMonitorProcessing";
/// Windows 云剪贴板历史的参与开关格式（DWORD 值 0 = 不入历史）。
pub const CAN_INCLUDE_IN_CLIPBOARD_HISTORY: &str = "CanIncludeInClipboardHistory";

/// 采集配置（GeneralPage 隐私区开关；从设置镜像实时读取，改动即时生效）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClipCaptureConfig {
    pub enabled: bool,
    pub images: bool,
    /// [FILES]（ZTools 借鉴 #8）记录文件复制（CF_HDROP，默认开）。
    pub files: bool,
    pub record_source: bool,
    /// 复制纯链接时在灵动岛弹「快开」接管条（默认开；NPS 同款默认）。
    pub link_popup: bool,
}

impl Default for ClipCaptureConfig {
    fn default() -> Self {
        // 任务口径：总开关默认开、图片默认开、文件默认开、来源进程默认关（隐私保守项）。
        Self {
            enabled: true,
            images: true,
            files: true,
            record_source: false,
            link_popup: true,
        }
    }
}

/// 从设置镜像 JSON 解析采集配置。容错读取：任何缺失 / 类型错误 / 解析失败
/// 都落到字段默认值，坏数据不会关停或放大采集范围。
pub fn parse_clip_config(json: &str) -> ClipCaptureConfig {
    let mut cfg = ClipCaptureConfig::default();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return cfg;
    };
    let Some(g) = v.get("general").and_then(|g| g.get("clipboard")) else {
        return cfg;
    };
    if let Some(b) = g.get("enabled").and_then(|b| b.as_bool()) {
        cfg.enabled = b;
    }
    if let Some(b) = g.get("captureImages").and_then(|b| b.as_bool()) {
        cfg.images = b;
    }
    if let Some(b) = g.get("captureFiles").and_then(|b| b.as_bool()) {
        cfg.files = b;
    }
    if let Some(b) = g.get("recordSource").and_then(|b| b.as_bool()) {
        cfg.record_source = b;
    }
    if let Some(b) = g.get("linkPopup").and_then(|b| b.as_bool()) {
        cfg.link_popup = b;
    }
    cfg
}

/// 纯链接判定（NPS ClipboardMonitor 同款口径）：整段文本（去首尾空白后）
/// 就是一个 URL —— 以 http:// 、https:// 、ftp:// 或 www. 开头且不含任何
/// 空白。正文里夹半截 URL 不算，避免普通复制误弹面板。
pub fn is_pure_url(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    let lower_prefix = |p: &str| t.len() >= p.len() && t[..p.len()].eq_ignore_ascii_case(p);
    lower_prefix("http://")
        || lower_prefix("https://")
        || lower_prefix("ftp://")
        || lower_prefix("www.")
}

/// 敏感剪贴板判定（纯函数）：含排除监控标记，或云剪贴板参与开关值为 0 →
/// 一律跳过。名称比较大小写不敏感（按 Win32 惯例注册格式名区分大小写，
/// 但防御式放宽）。
pub fn should_skip_capture(format_names: &[&str], can_include: Option<u32>) -> bool {
    format_names
        .iter()
        .any(|n| n.eq_ignore_ascii_case(EXCLUDE_FROM_MONITOR_PROCESSING))
        || can_include == Some(0)
}

/// 文本条目摘要（纯函数）：首个非空行，连续空白压成一个空格，截 200 字符。
/// 列表只展示摘要，全文按需取（text 字段）。
pub fn text_preview(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let mut in_ws = false;
        for ch in line.chars() {
            if ch.is_whitespace() {
                if !in_ws {
                    out.push(' ');
                    in_ws = true;
                }
            } else {
                out.push(ch);
                in_ws = false;
            }
        }
        if !out.trim().is_empty() {
            break;
        }
        out.clear();
    }
    truncate_chars(out.trim(), 200)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 图片入库闸门（纯函数）：非零、单边 ≤8192、总像素 ≤2^24（≈4096×4096，
/// 覆盖 4K 截图；更大的截图不入库，避免解码/转存放大内存）。
pub fn clip_image_size_ok(w: u32, h: u32) -> bool {
    w > 0 && h > 0 && w <= 8192 && h <= 8192 && (w as u64) * (h as u64) <= 1 << 24
}

/// 把 CF_DIB / CF_DIBV5 的 DIB 字节包装成 BMP 文件字节（前置 14 字节
/// BITMAPFILEHEADER），交给 image crate 解码——BI_BITFIELDS 掩码 / 自底向上 /
/// 调色板展开它都处理得比手写稳。像素偏移按头部尺寸 + 位掩码区 + 调色板
/// 推算（V4/V5 头的掩码在头部内部，仅 40 字节头 + BI_BITFIELDS 需要补 12 字节）。
pub fn wrap_dib_as_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let rd_u32 = |off: usize| -> u32 {
        u32::from_le_bytes([dib[off], dib[off + 1], dib[off + 2], dib[off + 3]])
    };
    let rd_u16 = |off: usize| -> u16 { u16::from_le_bytes([dib[off], dib[off + 1]]) };
    let header_size = rd_u32(0) as usize;
    if header_size < 40 || dib.len() < header_size {
        return None;
    }
    let bpp = rd_u16(14) as u32;
    if bpp == 0 || bpp > 32 {
        return None;
    }
    let compression = rd_u32(16);
    let clr_used = rd_u32(32) as usize;
    // 40 字节头 + BI_BITFIELDS(3)：3 个 DWORD 掩码跟在头部之后。
    let masks_extra = if compression == 3 && header_size == 40 {
        12
    } else {
        0
    };
    let palette_entries = if bpp <= 8 {
        if clr_used > 0 {
            clr_used
        } else {
            1usize << bpp
        }
    } else {
        0
    };
    let pixel_offset = 14 + header_size + masks_extra + palette_entries * 4;
    if pixel_offset > dib.len() {
        return None;
    }
    let file_len = 14u32.saturating_add(dib.len() as u32);
    let mut out = Vec::with_capacity(14 + dib.len());
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_len.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(pixel_offset as u32).to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

/// 内容去重哈希：SHA-256(kind ‖ 内容)，十六进制。
fn content_hash(parts: &[&[u8]]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 图片内容哈希（格式无关）：按**解码后的 RGBA 像素**算，而不是原始剪贴板
/// 字节。同一张图以 PNG 直存、DIBV5/DIB 转码、或从历史回写（我们写出
/// DIBV5）后再捕获，像素逐位相同 → 同一哈希；若按字节算，回写重捕的哈希
/// 必然与原 PNG 捕获不同，历史点击回写就会插出重复行。
fn image_pixel_hash(rgba: &image::RgbaImage) -> String {
    content_hash(&[b"image", rgba.as_raw()])
}

/// 剪贴板图片的落盘目录：`<app_data>/clip`。
pub fn clip_data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    crate::vela_data_dir(app).ok().map(|d| d.join("clip"))
}

/// 删除历史行引用的图片文件。文件名只由本模块生成（`<uuid>.png`），仍拒绝
/// 路径分隔符与 `..`，防止任何途径把行内字段变成任意路径删除。
fn remove_clip_files(app: &tauri::AppHandle, files: &[String]) {
    let Some(dir) = clip_data_dir(app) else {
        return;
    };
    for f in files {
        if f.contains(['/', '\\']) || f.contains("..") {
            continue;
        }
        let _ = std::fs::remove_file(dir.join(f));
    }
}

/// 清空 clip 目录下的全部文件（清空历史 / 重置应用时；目录只归本模块使用）。
fn wipe_clip_dir(app: &tauri::AppHandle) {
    let Some(dir) = clip_data_dir(app) else {
        return;
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_file() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 重置应用数据时联动清空 clip 目录（commands::reset_app_data 调用）。
pub fn reset_clip_storage(app: &tauri::AppHandle) {
    wipe_clip_dir(app);
}

/// 从设置镜像读取采集配置（读连接；失败回默认值）。
fn read_clip_config(app: &tauri::AppHandle) -> ClipCaptureConfig {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let Ok(conn) = state.read_db.acquire() else {
        return ClipCaptureConfig::default();
    };
    SettingsRepo::get(&conn, SETTINGS_MIRROR_KEY)
        .ok()
        .flatten()
        .map(|json| parse_clip_config(&json))
        .unwrap_or_default()
}

/// 监听线程捕获到的内容（剪贴板已关，无句柄残留）。
#[derive(Debug)]
enum CapturedContent {
    Text {
        text: String,
        preview: String,
        hash: String,
        source_app: Option<String>,
    },
    Image {
        /// 已编码的 PNG 字节（PNG 格式直存或 DIB 转码）。
        png: Vec<u8>,
        w: i64,
        h: i64,
        hash: String,
        source_app: Option<String>,
    },
    /// [FILES]（ZTools 借鉴 #8）文件列表（Explorer 复制/剪切）。
    Files {
        files: Vec<String>,
        preview: String,
        hash: String,
        source_app: Option<String>,
    },
}

/// D-7：超级面板模拟 Ctrl+C 取词产生的剪贴板变化不进历史库（敏感明文
/// 可能被选中却不应被留存 30 天）。抑制窗以 unix 毫秒计，取词方在发起
/// 合成复制前后设置/清理。
static SUPPRESS_HISTORY_UNTIL_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// 标记「接下来 duration 内的剪贴板变化不记历史」（超级面板取词用）。
pub fn suppress_history_for(duration: std::time::Duration) {
    let until = now_unix_ms().saturating_add(duration.as_millis() as u64);
    SUPPRESS_HISTORY_UNTIL_MS.store(until, std::sync::atomic::Ordering::Release);
}

fn history_suppressed() -> bool {
    now_unix_ms() < SUPPRESS_HISTORY_UNTIL_MS.load(std::sync::atomic::Ordering::Acquire)
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 处理一次剪贴板变化：配置闸门 → 捕获 → 落盘文件 → 入库 → 清理孤儿图片 →
/// 发事件。任一步失败只记日志，绝不拖垮监听线程。
#[cfg(windows)]
fn process_capture(app: &tauri::AppHandle) {
    use tauri::Manager;
    let config = read_clip_config(app);
    if !config.enabled {
        return;
    }
    if history_suppressed() {
        // D-7：取词窗口内的合成复制——读剪贴板面板用，不落历史库。
        return;
    }
    let Some(captured) = capture_once(config) else {
        return;
    };
    let input = match captured {
        CapturedContent::Text {
            text,
            preview,
            hash,
            source_app,
        } => {
            // 一.4 纯链接快开：复制的就是一个 URL → 通知前端弹「链接快开」
            // 接管条（默认 3s 回落，见 DockTakeover；历史入库照常走下方路径）。
            if config.link_popup && is_pure_url(&text) {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct UrlPayload<'a> {
                    url: &'a str,
                }
                let _ =
                    tauri::Emitter::emit(app, CLIPBOARD_URL_EVENT, UrlPayload { url: text.trim() });
            }
            NewClipboardEntry {
                kind: "text".into(),
                hash,
                preview,
                text: Some(text),
                image_file: None,
                image_w: None,
                image_h: None,
                image_bytes: 0,
                files: None,
                source_app,
            }
        }
        CapturedContent::Files {
            files,
            preview,
            hash,
            source_app,
        } => NewClipboardEntry {
            kind: "files".into(),
            hash,
            preview,
            text: None,
            image_file: None,
            image_w: None,
            image_h: None,
            image_bytes: 0,
            files: serde_json::to_string(&files).ok(),
            source_app,
        },
        CapturedContent::Image {
            png,
            w,
            h,
            hash,
            source_app,
        } => {
            let Some(dir) = clip_data_dir(app) else {
                return;
            };
            if let Err(e) = std::fs::create_dir_all(&dir) {
                log::warn!("clipboard clip dir create failed: {e}");
                return;
            }
            let file = format!("{}.png", uuid::Uuid::new_v4());
            if let Err(e) = std::fs::write(dir.join(&file), &png) {
                log::warn!("clipboard image save failed: {e}");
                return;
            }
            NewClipboardEntry {
                kind: "image".into(),
                hash,
                preview: String::new(),
                text: None,
                image_file: Some(file),
                image_w: Some(w),
                image_h: Some(h),
                image_bytes: png.len() as i64,
                files: None,
                source_app,
            }
        }
    };
    let state = app.state::<crate::AppState>();
    let Ok(conn) = lock_db(&state.db) else { return };
    match ClipboardRepo::record(&conn, &input) {
        Ok(outcome) => {
            log::debug!(
                "clipboard history {}: {} {}",
                if outcome.inserted {
                    "recorded"
                } else {
                    "refreshed"
                },
                outcome.entry.kind,
                outcome.entry.id
            );
            remove_clip_files(app, &outcome.orphaned_images);
            let _ = tauri::Emitter::emit(app, CLIPBOARD_CHANGED_EVENT, ());
        }
        Err(e) => log::warn!("clipboard history record failed: {e}"),
    }
}

/// 读取文本 / 图片上限。
const MAX_TEXT_BYTES: usize = 512 * 1024;
const MAX_CLIP_BYTES: usize = 64 * 1024 * 1024;

/// 打开剪贴板并捕获一次内容（敏感过滤 → 文本 → 图片）。
/// 打开失败重试（写入方可能还持锁）；期间任何失败返回 None。
#[cfg(windows)]
fn capture_once(config: ClipCaptureConfig) -> Option<CapturedContent> {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardFormatNameW,
        OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    unsafe {
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            return None;
        }
        let inner = || -> Option<CapturedContent> {
            // 1. 枚举注册格式：敏感标记判定 + 找 PNG 格式 id。
            let mut names: Vec<String> = Vec::new();
            let mut png_format = None;
            let mut can_include: Option<u32> = None;
            let mut fmt = EnumClipboardFormats(0);
            while fmt != 0 {
                if fmt >= 0xC000 {
                    let mut buf = [0u16; 128];
                    let len = GetClipboardFormatNameW(fmt, &mut buf);
                    if len > 0 {
                        let name = String::from_utf16_lossy(&buf[..len as usize]);
                        if name.eq_ignore_ascii_case(CAN_INCLUDE_IN_CLIPBOARD_HISTORY) {
                            if let Ok(h) = GetClipboardData(fmt) {
                                if !h.is_invalid() {
                                    let global = windows::Win32::Foundation::HGLOBAL(h.0);
                                    let ptr = GlobalLock(global) as *const u8;
                                    if !ptr.is_null() {
                                        let cap = (GlobalSize(global) as usize).min(4);
                                        let mut bytes = [0u8; 4];
                                        std::ptr::copy_nonoverlapping(ptr, bytes.as_mut_ptr(), cap);
                                        can_include = Some(u32::from_le_bytes(bytes));
                                        let _ = GlobalUnlock(global);
                                    }
                                }
                            }
                        } else if name.eq_ignore_ascii_case("PNG") {
                            png_format = Some(fmt);
                            names.push(name);
                        } else {
                            names.push(name);
                        }
                    }
                }
                fmt = EnumClipboardFormats(fmt);
            }
            let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
            if should_skip_capture(&name_refs, can_include) {
                log::debug!("clipboard capture skipped: sensitive marker present");
                return None;
            }
            let source_app = if config.record_source {
                clipboard_owner_process()
            } else {
                None
            };

            // 1.5 [FILES]（ZTools 借鉴 #8）文件列表（CF_HDROP）——优先级高于
            // 文本：浏览器「复制下载链接」等场景文本与文件并存时，用户意图
            // 几乎总是文件本身（ZTools 同款优先序：文件 > 图片 > 文本）。
            if config.files {
                if let Some(list) = read_hdrop_list() {
                    if !list.is_empty() {
                        let preview = files_preview(&list);
                        let joined = list.join("\n");
                        return Some(CapturedContent::Files {
                            hash: content_hash(&[b"files", joined.as_bytes()]),
                            preview,
                            files: list,
                            source_app,
                        });
                    }
                }
            }

            // 2. 文本优先。
            if let Ok(handle) = GetClipboardData(CF_UNICODETEXT) {
                if !handle.is_invalid() {
                    let global = windows::Win32::Foundation::HGLOBAL(handle.0);
                    let ptr = GlobalLock(global) as *const u16;
                    if !ptr.is_null() {
                        let cap = (GlobalSize(global) / 2).min(1024 * 1024);
                        let mut units: Vec<u16> = Vec::with_capacity(cap);
                        for i in 0..cap {
                            let ch = *ptr.add(i);
                            if ch == 0 {
                                break;
                            }
                            units.push(ch);
                        }
                        let _ = GlobalUnlock(global);
                        let text = String::from_utf16_lossy(&units);
                        if text.trim().is_empty() {
                            return None;
                        }
                        if text.len() > MAX_TEXT_BYTES {
                            log::debug!("clipboard capture skipped: text too large");
                            return None;
                        }
                        return Some(CapturedContent::Text {
                            preview: text_preview(&text),
                            hash: content_hash(&[b"text", text.as_bytes()]),
                            text,
                            source_app,
                        });
                    }
                }
            }

            // 3. 图片（需开关开启）：PNG 注册格式直存，否则 DIBV5 / DIB 转 PNG。
            if config.images {
                if let Some(fmt) = png_format {
                    if let Some(bytes) = read_hglobal_bytes(fmt) {
                        if bytes.len() <= MAX_CLIP_BYTES {
                            if let Ok(img) = image::load_from_memory(&bytes) {
                                let rgba = img.to_rgba8();
                                let (w, h) = rgba.dimensions();
                                if clip_image_size_ok(w, h) {
                                    return Some(CapturedContent::Image {
                                        hash: image_pixel_hash(&rgba),
                                        png: bytes,
                                        w: w as i64,
                                        h: h as i64,
                                        source_app,
                                    });
                                }
                            }
                        }
                    }
                }
                for fmt in [CF_DIBV5, CF_DIB] {
                    let Some(bytes) = read_hglobal_bytes(fmt) else {
                        continue;
                    };
                    if bytes.len() > MAX_CLIP_BYTES {
                        continue;
                    }
                    let Some(bmp) = wrap_dib_as_bmp(&bytes) else {
                        continue;
                    };
                    let Ok(img) = image::load_from_memory(&bmp) else {
                        continue;
                    };
                    let rgba = img.to_rgba8();
                    let (w, h) = rgba.dimensions();
                    if !clip_image_size_ok(w, h) {
                        continue;
                    }
                    let hash = image_pixel_hash(&rgba);
                    let mut png: Vec<u8> = Vec::new();
                    if image::DynamicImage::ImageRgba8(rgba)
                        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                        .is_err()
                    {
                        continue;
                    }
                    return Some(CapturedContent::Image {
                        hash,
                        png,
                        w: w as i64,
                        h: h as i64,
                        source_app,
                    });
                }
            }
            None
        };
        let result = inner();
        let _ = CloseClipboard();
        result
    }
}

/// 读取一个 HGLOBAL 型剪贴板格式的原始字节（上限 64MB，防异常超大分配）。
#[cfg(windows)]
unsafe fn read_hglobal_bytes(fmt: u32) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let handle = GetClipboardData(fmt).ok()?;
    if handle.is_invalid() {
        return None;
    }
    let global = HGLOBAL(handle.0);
    let ptr = GlobalLock(global) as *const u8;
    if ptr.is_null() {
        return None;
    }
    let len = GlobalSize(global).min(MAX_CLIP_BYTES);
    let bytes = std::slice::from_raw_parts(ptr, len).to_vec();
    let _ = GlobalUnlock(global);
    Some(bytes)
}

/// CF_HDROP 格式 id（windows crate 常量在 DataExchange 里也可用，这里显式
/// 写死避免 feature 漂移；Winuser.h 的 CF_HDROP = 15）。
const CF_HDROP_FMT: u32 = 15;
/// 文件列表上限：超过按普通「不识别」处理（ZTools 同款保守闸门，防异常
/// 超大 DROP 结构拖垮采集线程）。
const MAX_HDROP_FILES: usize = 64;

/// [FILES]（ZTools 借鉴 #8）读 CF_HDROP 的文件路径列表（DragQueryFileW）。
/// 剪贴板须已打开；任何失败 / 空列表 / 超上限返回 None。
/// [SUPER-PANEL]（ZTools 借鉴 #11）取词流程复用：pub(crate)。
#[cfg(windows)]
pub(crate) unsafe fn read_hdrop_list() -> Option<Vec<String>> {
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    let handle = GetClipboardData(CF_HDROP_FMT).ok()?;
    if handle.is_invalid() {
        return None;
    }
    let hdrop = HDROP(handle.0);
    let count = DragQueryFileW(hdrop, u32::MAX, None);
    if count == 0 || count as usize > MAX_HDROP_FILES {
        return None;
    }
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        // 先探长度（含 NUL），再取内容。
        let len = DragQueryFileW(hdrop, i, None);
        if len == 0 {
            continue;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let got = DragQueryFileW(hdrop, i, Some(buf.as_mut_slice()));
        if got == 0 {
            continue;
        }
        let s = String::from_utf16_lossy(&buf[..got as usize]);
        if !s.is_empty() {
            out.push(s);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 文件条目摘要：文件名（去目录）逗号连接，超长截断（纯函数，单测覆盖）。
pub fn files_preview(paths: &[String]) -> String {
    let names: Vec<String> = paths
        .iter()
        .map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p).to_string())
        .collect();
    truncate_chars(&names.join(", "), 200)
}

/// [FILES] 把路径列表打包成 CF_HDROP 全局内存字节（DROPFILES 头 20 字节 +
/// 双 NUL 结尾的宽字符串序列；fWide=TRUE）。上限 1MB，超出返回 None
/// （纯函数，单测覆盖：头布局 + 双终止符）。
pub fn build_hdrop_bytes(paths: &[String]) -> Option<Vec<u8>> {
    const MAX_HDROP_BYTES: usize = 1024 * 1024;
    if paths.is_empty() {
        return None;
    }
    let mut wide: Vec<u16> = Vec::new();
    for p in paths {
        wide.extend(p.encode_utf16());
        wide.push(0);
    }
    wide.push(0); // 列表整体双 NUL 终止
    let total = 20 + wide.len() * 2;
    if total > MAX_HDROP_BYTES {
        return None;
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&20u32.to_le_bytes()); // pFiles = sizeof(DROPFILES)
    out.extend_from_slice(&[0u8; 8]); // pt (POINT, 8 字节, 未用)
    out.extend_from_slice(&0i32.to_le_bytes()); // fNC = FALSE
    out.extend_from_slice(&1i32.to_le_bytes()); // fWide = TRUE
    for u in wide {
        out.extend_from_slice(&u.to_le_bytes());
    }
    Some(out)
}

/// [FILES] 从 CF_HDROP 字节里解回路径列表（build_hdrop_bytes 的逆；容错：
/// 头不足 / 非 wide / 无终止符 → None）。供单测往返与诊断使用（非测试构建
/// 无运行时调用点，显式豁免 dead_code）。
#[allow(dead_code)]
pub fn parse_hdrop_bytes(bytes: &[u8]) -> Option<Vec<String>> {
    if bytes.len() < 20 {
        return None;
    }
    let p_files = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let f_wide = i32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) != 0;
    if !f_wide || p_files < 20 || p_files > bytes.len() {
        return None;
    }
    let body = &bytes[p_files..];
    if !body.len().is_multiple_of(2) {
        return None;
    }
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let mut out = Vec::new();
    let mut cur = Vec::new();
    for u in units {
        if u == 0 {
            if cur.is_empty() {
                break; // 双 NUL：列表结束
            }
            out.push(String::from_utf16_lossy(&cur));
            cur.clear();
        } else {
            cur.push(u);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 剪贴板属主窗口的进程可执行文件名（复制来源）。拿不到 / 是本进程自己
/// （历史回写触发）→ None。
#[cfg(windows)]
unsafe fn clipboard_owner_process() -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::DataExchange::GetClipboardOwner;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let owner = GetClipboardOwner().ok()?;
    if owner.0.is_null() {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(owner, Some(&mut pid));
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 512];
    let mut len = buf.len() as u32;
    // PROCESS_NAME_FORMAT(0) = 常规 Win32 路径（非 NT 设备路径）。
    let ok = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_FORMAT(0),
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut len,
    );
    let _ = CloseHandle(process);
    if ok.is_err() || len == 0 {
        return None;
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    Some(full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string())
}

/// 启动剪贴板历史监听（非 Windows 为 no-op）。
pub fn start_clipboard_watcher(app: tauri::AppHandle) {
    #[cfg(windows)]
    win_history::start(app);
    #[cfg(not(windows))]
    {
        let _ = app;
        log::info!("clipboard watcher: unsupported platform, skipped");
    }
}

/// 隐藏窗口监听 + 单工作线程：消息线程只发 tick（ wnd_proc 里不做任何重活），
/// 工作线程串行处理并合并抖动（快速连发只捕获最终状态）。
#[cfg(windows)]
mod win_history {
    use std::cell::RefCell;
    use std::sync::mpsc::{self, Sender};

    use windows::core::w;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, RemoveClipboardFormatListener,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
        RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WM_CLIPBOARDUPDATE,
        WM_DESTROY, WNDCLASSW, WS_OVERLAPPED,
    };

    // 窗口过程是 extern "system" 无法捕获环境：发送端放消息线程 TLS。
    thread_local! {
        static TICK_TX: RefCell<Option<Sender<()>>> = const { RefCell::new(None) };
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CLIPBOARDUPDATE => {
                // 只投 tick：枚举格式/解码图片留给工作线程，消息循环不卡顿。
                TICK_TX.with(|t| {
                    if let Some(tx) = t.borrow().as_ref() {
                        let _ = tx.send(());
                    }
                });
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn start(app: tauri::AppHandle) {
        let (tx, rx) = mpsc::channel::<()>();
        // 消息线程：message-only 窗口 + 格式监听 + GetMessage 循环。
        std::thread::spawn(move || unsafe {
            TICK_TX.with(|t| *t.borrow_mut() = Some(tx));
            let hinstance: HINSTANCE = match GetModuleHandleW(None) {
                Ok(h) => HINSTANCE(h.0),
                Err(e) => {
                    log::warn!("clipboard watcher: GetModuleHandleW failed: {e}");
                    return;
                }
            };
            let class_name = w!("VelaClipboardListener");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinstance,
                lpszClassName: class_name,
                ..Default::default()
            };
            if RegisterClassW(&wc) == 0 {
                log::warn!("clipboard watcher: RegisterClassW failed");
                return;
            }
            // message-only 窗口：WM_CLIPBOARDUPDATE 是定向投递而非广播，
            // HWND_MESSAGE 收得到，且不出现在任务栏 / Alt-Tab / 枚举里。
            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                w!("Vela Clipboard Listener"),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(hinstance),
                None,
            ) {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("clipboard watcher: CreateWindowExW failed: {e}");
                    return;
                }
            };
            if let Err(e) = AddClipboardFormatListener(hwnd) {
                log::warn!("clipboard watcher: AddClipboardFormatListener failed: {e}");
                return;
            }
            log::info!("clipboard watcher started");
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = RemoveClipboardFormatListener(hwnd);
        });
        // 工作线程：串行处理 tick，抖动合并（只关心最终剪贴板状态）。
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                while rx.try_recv().is_ok() {}
                let app = app.clone();
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    super::process_capture(&app)
                }));
                if r.is_err() {
                    log::error!("clipboard capture panicked");
                }
            }
        });
    }
}

/* ------------------------------------------------------------------ */
/* IPC 命令面（CLIP）：列表 / 搜索 / 置顶 / 回写 / 删除 / 清空 / 缩略图 */
/* ------------------------------------------------------------------ */

fn untrusted() -> DbError {
    DbError::Denied("untrusted window".into())
}

/// 倒序列表：置顶在前；`query` 非空时对摘要/全文做子串搜索。
/// 剪贴板内容高度敏感（口令、截图都可能有），仅受信窗口可读。
#[tauri::command]
pub async fn list_clipboard_history(
    window: tauri::Window,
    app: tauri::AppHandle,
    query: Option<String>,
    limit: Option<i64>,
) -> DbResult<Vec<ClipboardEntry>> {
    if !crate::trusted_window(window.label()) {
        return Err(untrusted());
    }
    let query = query
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty());
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let conn = state.read_db.acquire()?;
        ClipboardRepo::list(&conn, query.as_deref(), limit)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 点击条目回写系统剪贴板（文本 = CF_UNICODETEXT；图片 = DIBV5+DIB 双格式）。
/// 先 touch 置顶再写剪贴板：随后 WM_CLIPBOARDUPDATE 捕获到同内容时会命中
/// 「与最新一条相同 → 刷新」去重路径，不产生重复行。
#[tauri::command]
pub async fn restore_clipboard_entry(
    window: tauri::Window,
    app: tauri::AppHandle,
    id: String,
) -> DbResult<Option<ClipboardEntry>> {
    if !crate::trusted_window(window.label()) {
        return Err(untrusted());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let entry = {
            let conn = lock_db(&state.db)?;
            let Some(entry) = ClipboardRepo::get(&conn, &id)? else {
                return Ok(None);
            };
            ClipboardRepo::touch(&conn, &entry.id)?
                .ok_or_else(|| DbError::Task("clipboard entry vanished".into()))?
        };
        let write = match entry.kind.as_str() {
            #[cfg(windows)]
            "image" => {
                let file = entry.image_file.clone().unwrap_or_default();
                if file.contains(['/', '\\']) || file.contains("..") {
                    Err("invalid image reference".to_string())
                } else {
                    (|| -> Result<(), String> {
                        let dir = clip_data_dir(&app)
                            .ok_or_else(|| "clip dir unavailable".to_string())?;
                        let bytes = std::fs::read(dir.join(&file))
                            .map_err(|e| format!("读取历史图片失败: {e}"))?;
                        let img = image::load_from_memory(&bytes)
                            .map_err(|e| format!("解码历史图片失败: {e}"))?
                            .to_rgba8();
                        unsafe { write_image_to_clipboard(&img) }
                    })()
                }
            }
            // [FILES]（ZTools 借鉴 #8）重建 CF_HDROP：files 列（JSON 数组）→
            // 存在性过滤（失效路径跳过，全部失效则失败）→ DROPFILES 字节。
            #[cfg(windows)]
            "files" => {
                let raw = entry.files.clone().unwrap_or_default();
                let paths: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
                let live: Vec<String> = paths
                    .into_iter()
                    .filter(|p| std::path::Path::new(p).exists())
                    .collect();
                if live.is_empty() {
                    Err("文件已不存在".to_string())
                } else {
                    (|| -> Result<(), String> {
                        let bytes =
                            build_hdrop_bytes(&live).ok_or_else(|| "文件列表过长".to_string())?;
                        unsafe { set_clipboard_bytes(CF_HDROP_FMT, &bytes) }
                    })()
                }
            }
            _ => {
                let text = entry.text.clone().unwrap_or_default();
                #[cfg(windows)]
                {
                    unsafe { write_text_to_clipboard(&text) }
                }
                #[cfg(not(windows))]
                {
                    let _ = text;
                    Err("剪贴板回写仅支持 Windows".to_string())
                }
            }
        };
        if let Err(e) = write {
            return Err(DbError::Task(format!("回写剪贴板失败: {e}")));
        }
        let _ = tauri::Emitter::emit(&app, CLIPBOARD_CHANGED_EVENT, ());
        Ok(Some(entry))
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 置顶 / 取消置顶。
#[tauri::command]
pub async fn toggle_clipboard_pin(
    window: tauri::Window,
    app: tauri::AppHandle,
    id: String,
    pinned: bool,
) -> DbResult<Option<ClipboardEntry>> {
    if !crate::trusted_window(window.label()) {
        return Err(untrusted());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let conn = lock_db(&state.db)?;
        let out = ClipboardRepo::set_pinned(&conn, &id, pinned)?;
        let _ = tauri::Emitter::emit(&app, CLIPBOARD_CHANGED_EVENT, ());
        Ok(out)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 删单条（含其引用的图片文件）。
#[tauri::command]
pub async fn delete_clipboard_entry(
    window: tauri::Window,
    app: tauri::AppHandle,
    id: String,
) -> DbResult<()> {
    if !crate::trusted_window(window.label()) {
        return Err(untrusted());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let deleted = {
            let conn = lock_db(&state.db)?;
            ClipboardRepo::delete(&conn, &id)?
        };
        if let Some(entry) = &deleted {
            if let Some(file) = entry.image_file.as_deref() {
                remove_clip_files(&app, &[file.to_string()]);
            }
        }
        let _ = tauri::Emitter::emit(&app, CLIPBOARD_CHANGED_EVENT, ());
        Ok(())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 清空全部历史（行 + clip 目录文件）。
#[tauri::command]
pub async fn clear_clipboard_history(window: tauri::Window, app: tauri::AppHandle) -> DbResult<()> {
    if !crate::trusted_window(window.label()) {
        return Err(untrusted());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        {
            let conn = lock_db(&state.db)?;
            ClipboardRepo::clear(&conn)?;
        }
        wipe_clip_dir(&app);
        let _ = tauri::Emitter::emit(&app, CLIPBOARD_CHANGED_EVENT, ());
        Ok(())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 图片条目缩略图（≤256px，PNG dataURL）。条目不可变，前端按 id 缓存即可。
#[tauri::command]
pub async fn get_clipboard_thumbnail(
    window: tauri::Window,
    app: tauri::AppHandle,
    id: String,
) -> DbResult<Option<String>> {
    if !crate::trusted_window(window.label()) {
        return Err(untrusted());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let entry = {
            let conn = state.read_db.acquire()?;
            ClipboardRepo::get(&conn, &id)?
        };
        let Some(entry) = entry else { return Ok(None) };
        if entry.kind != "image" {
            return Ok(None);
        }
        let file = entry.image_file.clone().unwrap_or_default();
        if file.contains(['/', '\\']) || file.contains("..") {
            return Ok(None);
        }
        let Some(dir) = clip_data_dir(&app) else {
            return Ok(None);
        };
        let bytes = match std::fs::read(dir.join(&file)) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let img = match image::load_from_memory(&bytes) {
            Ok(i) => i,
            Err(_) => return Ok(None),
        };
        let thumb = img.thumbnail(256, 256);
        let mut png: Vec<u8> = Vec::new();
        if thumb
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .is_err()
        {
            return Ok(None);
        }
        use base64::Engine as _;
        Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )))
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 打开剪贴板数据目录（设置页隐私区入口；与 open_log_dir 同策略不设闸门）。
#[tauri::command]
pub fn open_clipboard_dir(app: tauri::AppHandle) -> Result<(), String> {
    let Some(dir) = clip_data_dir(&app) else {
        return Err("无法定位剪贴板数据目录".to_string());
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建剪贴板数据目录: {e}"))?;
    #[cfg(windows)]
    let r = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&dir).spawn();
    // explorer.exe 成功打开时也可能返回非零退出码，spawn 成功即视为成功；
    // 子进程句柄交后台线程回收（C-14）。
    r.map(|mut child| {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    })
    .map_err(|e| format!("无法打开剪贴板数据目录: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- [FILES]（ZTools 借鉴 #8）HDROP 构造/解析 ----

    #[test]
    fn hdrop_bytes_roundtrip() {
        let paths = vec![
            "C:/Users/me/报告.pdf".to_string(),
            "D:/资料 图.png".to_string(),
        ];
        let bytes = build_hdrop_bytes(&paths).unwrap();
        // DROPFILES 头：pFiles=20、fWide=TRUE（16..20 字节小端 1）。
        assert_eq!(
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            20
        );
        assert_eq!(
            i32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
            1
        );
        assert_eq!(parse_hdrop_bytes(&bytes).unwrap(), paths);
        // 空列表拒绝；截断头拒绝；非 wide 拒绝。
        assert!(build_hdrop_bytes(&[]).is_none());
        assert!(parse_hdrop_bytes(&bytes[..10]).is_none());
        let mut narrow = bytes.clone();
        narrow[16..20].copy_from_slice(&0i32.to_le_bytes());
        assert!(parse_hdrop_bytes(&narrow).is_none());
    }

    #[test]
    fn files_preview_joins_names_and_truncates() {
        // 反斜杠路径名（运行时构造，避免源码转义噪声）。
        let bs = char::from(0x5C);
        let win = format!("C:{bs}a{bs}b.txt");
        assert_eq!(
            files_preview(&[win, "/data/c.mp4".to_string()]),
            "b.txt, c.mp4"
        );
        let many: Vec<String> = (0..40).map(|i| format!("C:/dir/file{i}.bin")).collect();
        assert!(files_preview(&many).chars().count() <= 200);
    }

    #[test]
    fn parse_clip_config_reads_capture_files_flag() {
        // 缺省开；显式 false 关（GeneralPage 隐私区开关）。
        assert!(parse_clip_config("{}").files);
        let json = r#"{"general":{"clipboard":{"captureFiles":false}}}"#;
        assert!(!parse_clip_config(json).files);
    }

    // ---- 敏感格式跳过 ----

    #[test]
    fn skips_capture_when_exclude_marker_present() {
        assert!(should_skip_capture(
            &["HTML Format", EXCLUDE_FROM_MONITOR_PROCESSING],
            None
        ));
        // 大小写不敏感（防御式）。
        assert!(should_skip_capture(
            &["excludeclipboardcontentfrommonitorprocessing"],
            None
        ));
    }

    #[test]
    fn skips_capture_when_cloud_history_opt_out_is_zero() {
        assert!(should_skip_capture(&[], Some(0)));
        // 值非 0 = 允许入历史；无该格式 = 允许。
        assert!(!should_skip_capture(&[], Some(1)));
        assert!(!should_skip_capture(&["HTML Format", "PNG"], None));
    }

    // ---- 采集配置解析（设置镜像 JSON）----

    #[test]
    fn parse_clip_config_defaults_and_overrides() {
        let d = ClipCaptureConfig::default();
        assert!(d.enabled && d.images && !d.record_source && d.link_popup);

        assert_eq!(parse_clip_config(""), d);
        assert_eq!(parse_clip_config("not json"), d);
        assert_eq!(parse_clip_config(r#"{"general":{}}"#), d);
        // 类型错误的字段忽略，其余按值。
        let c = parse_clip_config(
            r#"{"general":{"clipboard":{"enabled":false,"captureImages":"yes","recordSource":true,"linkPopup":false}}}"#,
        );
        assert_eq!(
            c,
            ClipCaptureConfig {
                enabled: false,
                images: true,
                files: true,
                record_source: true,
                link_popup: false
            }
        );
    }

    #[test]
    fn pure_url_detection_follows_nps_semantics() {
        // 整段文本就是一个链接才算。
        assert!(is_pure_url("https://example.com/a?b=1"));
        assert!(is_pure_url("http://example.com"));
        assert!(is_pure_url("ftp://files.example.com/pub"));
        assert!(is_pure_url("www.example.com/path"));
        assert!(is_pure_url("  https://example.com  ")); // 首尾空白容忍
        assert!(is_pure_url("HTTPS://EXAMPLE.COM")); // 大小写不敏感
                                                     // 正文里夹 URL / 多行 / 空格都不算。
        assert!(!is_pure_url("看这个 https://example.com 很有趣"));
        assert!(!is_pure_url("https://example.com 第二行"));
        assert!(!is_pure_url("example.com")); // 无协议头也不在 www. 白名单
        assert!(!is_pure_url(""));
        assert!(!is_pure_url("   "));
    }

    // ---- 摘要与尺寸闸门 ----

    #[test]
    fn text_preview_takes_first_non_empty_line_collapses_whitespace_and_truncates() {
        assert_eq!(
            text_preview("\n   \n  hello   wide\tworld  \nsecond"),
            "hello wide world"
        );
        assert_eq!(text_preview("   "), "");
        let long = "x".repeat(500);
        assert_eq!(text_preview(&long).chars().count(), 200);
        // 多字节字符按字符数截断，不会切在字节中间。
        let cjk = "汉".repeat(300);
        assert_eq!(text_preview(&cjk).chars().count(), 200);
    }

    #[test]
    fn image_size_gate() {
        assert!(clip_image_size_ok(1, 1));
        assert!(clip_image_size_ok(3840, 2160));
        assert!(clip_image_size_ok(4096, 4096));
        assert!(!clip_image_size_ok(0, 10));
        assert!(!clip_image_size_ok(8193, 1));
        assert!(!clip_image_size_ok(8192, 8192), "总像素超 2^24");
    }

    #[test]
    fn content_hash_is_stable_and_kind_scoped() {
        let a = content_hash(&[b"text", b"abc"]);
        let b = content_hash(&[b"text", b"abc"]);
        let c = content_hash(&[b"image", b"abc"]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn image_hash_is_format_independent_across_png_capture_and_v5_rewrite() {
        // 回归：历史点击回写曾插出重复行——原条目按 PNG 字节捕获，回写后
        // 我们写出 DIBV5、监听重捕拿到 DIB 字节，字节哈希不同就插了新行。
        // 现在哈希按解码后的 RGBA 像素算：两条捕获路径必须得到同一哈希。
        let img = image::RgbaImage::from_fn(5, 3, |x, y| {
            image::Rgba([x as u8 * 17, y as u8 * 31, 128, 255])
        });
        // 原始捕获：来源应用以 PNG 格式上剪贴板。
        let mut png: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let from_png = image::load_from_memory(&png).unwrap().to_rgba8();
        // 回写后重捕：restore 写出 DIBV5，监听读回 DIBV5 字节解码。
        let pixels = rgba_to_bgra_rows(&img, false);
        let mut v5 = bitmap_v5_header(5, 3, pixels.len() as u32);
        v5.extend_from_slice(&pixels);
        let bmp = wrap_dib_as_bmp(&v5).unwrap();
        let from_dib = image::load_from_memory(&bmp).unwrap().to_rgba8();
        assert_eq!(image_pixel_hash(&from_png), image_pixel_hash(&from_dib));
        // 哈希仍区分不同内容。
        let other = image::RgbaImage::from_fn(5, 3, |x, y| {
            image::Rgba([x as u8 * 17, y as u8 * 31, 129, 255])
        });
        assert_ne!(image_pixel_hash(&from_png), image_pixel_hash(&other));
    }

    // ---- DIB → BMP 包装（交 image crate 解码）----

    /// 手工构造一张 2×2 32bpp BI_RGB 自底向上 DIB：
    /// 底行 = (红, 绿)，顶行 = (蓝, 白)。
    fn sample_dib_32bpp() -> Vec<u8> {
        let mut b: Vec<u8> = Vec::new();
        b.push_u32(40);
        b.push_i32(2);
        b.push_i32(2);
        b.push_u16(1);
        b.push_u16(32);
        b.push_u32(0); // BI_RGB
        b.push_u32(16);
        b.push_i32(3780);
        b.push_i32(3780);
        b.push_u32(0);
        b.push_u32(0);
        // 像素行自底向上，BGRA。
        b.extend_from_slice(&[0, 0, 255, 255, 0, 255, 0, 255]); // 底行：红、绿
        b.extend_from_slice(&[255, 0, 0, 255, 255, 255, 255, 255]); // 顶行：蓝、白
        b
    }

    #[test]
    fn wrap_dib_as_bmp_decodes_to_expected_pixels() {
        let dib = sample_dib_32bpp();
        let bmp = wrap_dib_as_bmp(&dib).expect("应能包装");
        assert_eq!(&bmp[..2], b"BM");
        // 像素偏移 = 14 + 40（无掩码区、无调色板）。
        assert_eq!(u32::from_le_bytes([bmp[10], bmp[11], bmp[12], bmp[13]]), 54);
        let img = image::load_from_memory(&bmp)
            .expect("image crate 应能解码")
            .to_rgba8();
        assert_eq!(img.dimensions(), (2, 2));
        let px = |x: u32, y: u32| img.get_pixel(x, y).0;
        assert_eq!(px(0, 0)[..3], [0, 0, 255], "顶行左 = 蓝");
        assert_eq!(px(1, 0)[..3], [255, 255, 255], "顶行右 = 白");
        assert_eq!(px(0, 1)[..3], [255, 0, 0], "底行左 = 红");
        assert_eq!(px(1, 1)[..3], [0, 255, 0], "底行右 = 绿");
    }

    #[test]
    fn wrap_dib_as_bmp_rejects_garbage_and_computes_bitfields_offset() {
        assert!(wrap_dib_as_bmp(&[]).is_none());
        assert!(wrap_dib_as_bmp(&[0u8; 20]).is_none());
        // 头部声称 40 字节 + BI_BITFIELDS：像素偏移需多算 12 字节掩码区。
        let mut dib = sample_dib_32bpp();
        dib[16..20].copy_from_slice(&3u32.to_le_bytes());
        // 补上 3 个掩码 DWORD（放在头部之后、像素之前）。
        let mut with_masks = dib[..40].to_vec();
        with_masks.extend_from_slice(&0x00FF_0000u32.to_le_bytes());
        with_masks.extend_from_slice(&0x0000_FF00u32.to_le_bytes());
        with_masks.extend_from_slice(&0x0000_00FFu32.to_le_bytes());
        with_masks.extend_from_slice(&dib[40..]);
        let bmp = wrap_dib_as_bmp(&with_masks).unwrap();
        assert_eq!(
            u32::from_le_bytes([bmp[10], bmp[11], bmp[12], bmp[13]]),
            14 + 40 + 12
        );
        let img = image::load_from_memory(&bmp).unwrap().to_rgba8();
        assert_eq!(img.get_pixel(0, 1).0[..3], [255, 0, 0]);
        // 头部声称 124 字节但整块数据只有 56 字节：拒绝。
        let mut short = sample_dib_32bpp();
        short[0..4].copy_from_slice(&124u32.to_le_bytes());
        assert!(wrap_dib_as_bmp(&short).is_none());
    }

    #[test]
    fn wrap_dib_as_bmp_roundtrips_our_own_v5_writer_layout() {
        // 复用写方向的 V5 头 + BGRA 行序列化，验证读方向按同一布局解回来。
        let img = image::RgbaImage::from_fn(3, 2, |x, y| {
            image::Rgba([x as u8 * 40, y as u8 * 90, 200, 255])
        });
        let pixels = rgba_to_bgra_rows(&img, false);
        let mut v5 = bitmap_v5_header(3, 2, pixels.len() as u32);
        v5.extend_from_slice(&pixels);
        let bmp = wrap_dib_as_bmp(&v5).unwrap();
        let back = image::load_from_memory(&bmp).unwrap().to_rgba8();
        assert_eq!(back.dimensions(), (3, 2));
        for (x, y, p) in img.enumerate_pixels() {
            assert_eq!(back.get_pixel(x, y).0[..3], p.0[..3], "({x},{y})");
        }
    }
}
