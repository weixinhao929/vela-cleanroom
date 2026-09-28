//! wallpaper：壁纸跟随主题的系统侧（§4.4，Material You / matugen 思想内置实现）。
//!
//! 职责：
//!  1. 定位当前壁纸文件——`SystemParametersInfoW(SPI_GETDESKWALLPAPER)`。注意
//!     Windows 对「填充 / 适应」壁纸会转码，SPI 返回的可能是
//!     `%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper`（无扩展名的 JPEG），
//!     SPI 为空 / 文件不存在时也回退到该转码副本；解码一律按内容嗅探格式而非扩展名。
//!  2. 解码 + 取色——复用 palette.rs 公共 Oklab 管线，输出主 / 次 / 中性三色候选。
//!  3. `path + mtime` 缓存去抖：同一壁纸（含幻灯片同图重放）不重复解码；命令与
//!     监听线程共享同一缓存。
//!  4. 变化监听——隐藏顶层窗口接收 `WM_SETTINGCHANGE("Wallpaper")` 广播（message-only
//!     窗口收不到广播，故必须是真实顶层窗口，只是永不 Show），400ms 合并抖动后重算，
//!     缓存键变化才 emit `wallpaper:changed`；另每 30s 轮询一次兜底（部分换壁纸工具
//!     不广播，幻灯片切图也走此路）。
//!
//! 前端（lib/wallpaper-theme.ts）在挂载时 `get_wallpaper_palette` 取一次，之后只吃事件。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use tauri::AppHandle;

use crate::models::{WallpaperPalette, WallpaperPaletteInfo};
use crate::palette;

/// 壁纸变化事件名（载荷 [`WallpaperPaletteInfo`]）。
pub const WALLPAPER_CHANGED_EVENT: &str = "wallpaper:changed";

/// 解码上限：壁纸超过 64MB 极不正常（多半不是图片），直接放弃。
const MAX_WALLPAPER_BYTES: usize = 64 * 1024 * 1024;

/// 缓存键：路径 + 修改时间（毫秒）。幻灯片切到同一张图 mtime 不变即命中。
#[derive(Clone, Debug, PartialEq, Eq)]
struct CacheKey {
    path: PathBuf,
    mtime_ms: u64,
}

struct Cached {
    key: CacheKey,
    info: WallpaperPaletteInfo,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
/// 解码串行化：命令与监听线程同时到达时只解一次，第二个进来直接命中缓存。
static COMPUTE_GATE: Mutex<()> = Mutex::new(());

fn mtime_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let m = meta.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// 缓存判定（纯函数，供单测）：键相同直接复用；否则 `compute` 并回填。
/// `compute` 失败（None）时保留旧缓存不动——下一次调用会再试。
fn resolve_cached<F>(
    slot: &mut Option<Cached>,
    key: CacheKey,
    compute: F,
) -> Option<WallpaperPaletteInfo>
where
    F: FnOnce() -> Option<WallpaperPaletteInfo>,
{
    if let Some(c) = slot.as_ref() {
        if c.key == key {
            return Some(c.info.clone());
        }
    }
    let info = compute()?;
    *slot = Some(Cached {
        key,
        info: info.clone(),
    });
    Some(info)
}

/// 读文件 → 按内容嗅探格式解码 → 公共管线取色。
fn compute_info(path: &Path, mtime_ms: u64) -> Option<WallpaperPaletteInfo> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("wallpaper read failed {}: {e}", path.display());
            return None;
        }
    };
    if bytes.is_empty() || bytes.len() > MAX_WALLPAPER_BYTES {
        log::warn!(
            "wallpaper size out of range ({} bytes): {}",
            bytes.len(),
            path.display()
        );
        return None;
    }
    // TranscodedWallpaper 没有扩展名，`image::open` 会因猜不到格式失败；
    // 一律走 with_guessed_format 按魔数识别。
    let img = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .map_err(|e| log::warn!("wallpaper decode failed {}: {e}", path.display()))
        .ok()?;
    let p = palette::extract_palette(&img);
    Some(WallpaperPaletteInfo {
        path: path.to_string_lossy().into_owned(),
        mtime_ms,
        palette: WallpaperPalette {
            primary: p.primary.hex(),
            secondary: p.secondary.map(|c| c.hex()),
            neutral: p.neutral.hex(),
        },
    })
}

/// `SPI_GETDESKWALLPAPER` 返回的路径（可能为空串 = 纯色桌面 / 幻灯片过渡瞬间）。
#[cfg(windows)]
fn spi_wallpaper_path() -> Option<PathBuf> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    // 长路径上限（u16 数量）；SPI 按 uiParam 截断，不会越界。
    let mut buf = [0u16; 32_768];
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            Some(buf.as_mut_ptr() as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    if ok.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    if len == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

/// 转码副本候选（SPI 路径不可用时兜底）。`TranscodedWallpaper` 是当前实际显示的
/// 那一张（含填充 / 适应处理），取色效果反而更贴近用户所见。
fn transcoded_candidates() -> Vec<PathBuf> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let themes = PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Themes");
    vec![
        themes.join("TranscodedWallpaper"),
        themes.join("TranscodedWallpaper.jpg"),
    ]
}

/// 解析出一个确实存在的壁纸文件。
fn resolve_wallpaper_file() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(p) = spi_wallpaper_path() {
            if p.is_file() {
                return Some(p);
            }
            log::debug!(
                "SPI wallpaper path not a file, trying transcoded copies: {}",
                p.display()
            );
        }
    }
    transcoded_candidates().into_iter().find(|p| p.is_file())
}

/// 当前壁纸的取色快照（缓存命中不解码）。取不到壁纸文件 / 解码失败返回 None。
pub fn current_palette() -> Option<WallpaperPaletteInfo> {
    let path = resolve_wallpaper_file()?;
    let mtime = mtime_ms(&path)?;
    let key = CacheKey {
        path: path.clone(),
        mtime_ms: mtime,
    };
    // 快路径：不持解码闸门直接查缓存。
    if let Some(c) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        if c.key == key {
            return Some(c.info.clone());
        }
    }
    let _gate = COMPUTE_GATE.lock().unwrap_or_else(|p| p.into_inner());
    // 进闸后再查一次：等待期间可能已被另一线程算好。
    let mut slot = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    resolve_cached(&mut slot, key, || compute_info(&path, mtime))
}

/// 当前壁纸取色快照（缓存命中不解码；无壁纸 / 解码失败返回 null）。
/// 壁纸是公开桌面属性，任何窗口都可读，不设窗口闸门（速记窗也要跟随主题）。
#[tauri::command]
pub async fn get_wallpaper_palette() -> Result<Option<WallpaperPaletteInfo>, String> {
    tauri::async_runtime::spawn_blocking(current_palette)
        .await
        .map_err(|e| format!("wallpaper palette task failed: {e}"))
}

/// Windows：`SystemParametersInfoW(SPI_SETDESKWALLPAPER)` 把桌面壁纸设为指定
/// 图片。SPIF_UPDATEINIFILE | SPIF_SENDCHANGE 让系统广播 WM_SETTINGCHANGE——
/// 本模块的监听线程据此在防抖后重发 `wallpaper:changed`，样式页的「当前壁纸」
/// 高亮随之刷新，无需前端再主动拉取。
#[cfg(windows)]
fn set_wallpaper_impl(path: &str) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(format!("壁纸文件不存在: {path}"));
    }
    // SPI 需要 UTF-16 且以 NUL 结尾的完整路径。
    let mut wide: Vec<u16> = path.encode_utf16().collect();
    wide.push(0);
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            Some(wide.as_ptr() as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(SPIF_UPDATEINIFILE.0 | SPIF_SENDCHANGE.0),
        )
    };
    ok.map_err(|e| format!("设置壁纸失败: {e}"))
}

#[cfg(not(windows))]
fn set_wallpaper_impl(_path: &str) -> Result<(), String> {
    Err("当前平台不支持设置桌面壁纸".into())
}

/// 把桌面壁纸设为指定图片（样式页「壁纸」区）。仅受信窗口可调用——
/// 更换系统壁纸与 set_desktop_icons 同级，属于可感知的系统状态变更。
#[tauri::command]
pub async fn set_desktop_wallpaper(window: tauri::Window, path: String) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || set_wallpaper_impl(&path))
        .await
        .map_err(|e| format!("set wallpaper task failed: {e}"))?
}

/// 单张缩略图：解码 → 最长边 ≤ `MAX_EDGE` → PNG → base64 data URL。
/// 与 `files::read_image_data_url` 的差异是面向批量小图（列表网格），
/// 上限小得多，单张失败返回 None 不影响整批。
fn thumbnail_data_url(path: &str) -> Option<String> {
    use base64::Engine as _;
    const MAX_EDGE: u32 = 320;
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    if std::fs::metadata(path).ok()?.len() > MAX_BYTES {
        return None;
    }
    // `image::open` 只按扩展名选解码器，网图常见 JPEG 字节存成 .png 的
    // 扩展名错位会解码失败（网格显示破损占位）。与 compute_info 一致：
    // 按魔数嗅探格式，嗅探不出时保留扩展名兜底。
    let img = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let img = if img.width() > MAX_EDGE || img.height() > MAX_EDGE {
        img.thumbnail(MAX_EDGE, MAX_EDGE)
    } else {
        img
    };
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Some(format!("data:image/png;base64,{b64}"))
}

/// 批量读取图片缩略图（样式页壁纸网格）：与请求顺序一一对应，单张失败为 null。
/// 每批上限 32 张、超出部分截断，防止一次 IPC 拉爆内存；仅受信窗口可调用。
#[tauri::command]
pub async fn read_image_thumbnails(
    window: tauri::Window,
    paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .into_iter()
            .take(32)
            .map(|p| thumbnail_data_url(&p))
            .collect())
    })
    .await
    .map_err(|e| format!("thumbnail task failed: {e}"))?
}

/// 启动壁纸变化监听线程（非 Windows 为 no-op）。
pub fn start_wallpaper_watcher(app: AppHandle) {
    #[cfg(windows)]
    win_watcher::start(app);
    #[cfg(not(windows))]
    {
        let _ = app;
        log::info!("wallpaper watcher: unsupported platform, skipped");
    }
}

#[cfg(windows)]
mod win_watcher {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use tauri::{AppHandle, Emitter};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, KillTimer, PostQuitMessage,
        RegisterClassW, SetTimer, TranslateMessage, MSG, WINDOW_EX_STYLE, WM_DESTROY,
        WM_DISPLAYCHANGE, WM_SETTINGCHANGE, WM_TIMER, WNDCLASSW, WS_OVERLAPPED,
    };

    use super::WALLPAPER_CHANGED_EVENT;

    // 窗口过程是 `extern "system"` 无法捕获环境：AppHandle 放在消息循环线程的 TLS。
    thread_local! {
        static WATCH_APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
    }

    /// 上次已 emit 的缓存键（path, mtime_ms）；相同则不重复下发。
    static LAST_EMITTED: Mutex<Option<(String, u64)>> = Mutex::new(None);
    /// 解码工作线程在飞标志：抖动期内不叠加解码，轮询兜底会补上。
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

    const DEBOUNCE_TIMER_ID: usize = 0x5750_4c31; // "WPL1"
    const POLL_TIMER_ID: usize = 0x5750_4c32; // "WPL2"
    const DEBOUNCE_MS: u32 = 400;
    const POLL_MS: u32 = 30_000;
    /// `SPI_SETDESKWALLPAPER`：部分调用方以 wParam 传 SPI 动作而 lParam 为空。
    const SPI_SETDESKWALLPAPER_RAW: usize = 0x0014;

    /// 在工作线程重算；缓存键变化才 emit。`prime=true` 只预热缓存与 LAST_EMITTED
    /// （启动时前端会主动拉一次，此处不发事件，避免首帧双重应用）。
    fn refresh(prime: bool) {
        let Some(app) = WATCH_APP.with(|c| c.borrow().clone()) else {
            return;
        };
        if IN_FLIGHT.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(super::current_palette);
            IN_FLIGHT.store(false, Ordering::SeqCst);
            let info = match result {
                Ok(Some(i)) => i,
                Ok(None) => return,
                Err(_) => {
                    log::error!("wallpaper palette computation panicked");
                    return;
                }
            };
            let key = (info.path.clone(), info.mtime_ms);
            let mut last = LAST_EMITTED.lock().unwrap_or_else(|p| p.into_inner());
            if last.as_ref() == Some(&key) {
                return;
            }
            *last = Some(key);
            drop(last);
            if prime {
                return;
            }
            log::info!("wallpaper changed: {} (mtime {})", info.path, info.mtime_ms);
            if let Err(e) = app.emit(WALLPAPER_CHANGED_EVENT, info) {
                log::warn!("emit {WALLPAPER_CHANGED_EVENT} failed: {e}");
            }
        });
    }

    /// WM_SETTINGCHANGE 的 lParam 是否指向 "Wallpaper"（或为空：泛化 SPI 变更，
    /// 重算成本只是一次 stat，放行）。"Policy"/"Environment"/"intl" 等明确不相关的直接忽略。
    unsafe fn is_wallpaper_change(wparam: WPARAM, lparam: LPARAM) -> bool {
        if lparam.0 == 0 {
            return true;
        }
        if wparam.0 == SPI_SETDESKWALLPAPER_RAW {
            return true;
        }
        match PCWSTR(lparam.0 as *const u16).to_string() {
            Ok(s) => s.eq_ignore_ascii_case("Wallpaper"),
            Err(_) => false,
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_SETTINGCHANGE => {
                if is_wallpaper_change(wparam, lparam) {
                    // 重置式防抖：连续广播（设置页拖动预览、幻灯片过渡）只在静默 400ms 后重算一次。
                    let _ = SetTimer(Some(hwnd), DEBOUNCE_TIMER_ID, DEBOUNCE_MS, None);
                }
                LRESULT(0)
            }
            // R4：显示器拓扑变化（热插拔/分辨率/DPI/主屏切换）系统会向全部
            // 顶层窗口广播 WM_DISPLAYCHANGE——本窗口顺带转发给 monitor watcher
            // （事件化，取代其 3s 轮询；watcher 侧仍有 30s 兜底轮询）。
            WM_DISPLAYCHANGE => {
                crate::monitor::wake_monitor_watcher();
                // 拓扑变化后壁纸可能跟随重排（每屏壁纸），也重算一次。
                let _ = SetTimer(Some(hwnd), DEBOUNCE_TIMER_ID, DEBOUNCE_MS, None);
                LRESULT(0)
            }
            WM_TIMER => {
                if wparam.0 == DEBOUNCE_TIMER_ID {
                    let _ = KillTimer(Some(hwnd), DEBOUNCE_TIMER_ID);
                    refresh(false);
                } else if wparam.0 == POLL_TIMER_ID {
                    refresh(false);
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn start(app: AppHandle) {
        std::thread::spawn(move || {
            WATCH_APP.with(|c| *c.borrow_mut() = Some(app));
            unsafe {
                let hinstance: HINSTANCE = match GetModuleHandleW(None) {
                    Ok(h) => HINSTANCE(h.0),
                    Err(e) => {
                        log::warn!("wallpaper watcher: GetModuleHandleW failed: {e}");
                        return;
                    }
                };
                let class_name = w!("VelaWallpaperListener");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: hinstance,
                    lpszClassName: class_name,
                    ..Default::default()
                };
                if RegisterClassW(&wc) == 0 {
                    log::warn!("wallpaper watcher: RegisterClassW failed; wallpaper changes will not be tracked");
                    return;
                }
                // 真实顶层窗口（非 HWND_MESSAGE）才在 WM_SETTINGCHANGE 广播名单里；
                // 不带 WS_VISIBLE、零尺寸、不 Show，任务栏 / Alt-Tab 均不可见。
                let hwnd = match CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    class_name,
                    w!("Vela Wallpaper Listener"),
                    WS_OVERLAPPED,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(hinstance),
                    None,
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        log::warn!("wallpaper watcher: CreateWindowExW failed: {e}");
                        return;
                    }
                };
                let _ = SetTimer(Some(hwnd), POLL_TIMER_ID, POLL_MS, None);
                // 预热：缓存当前壁纸并记下键，启动后首次轮询不会误报"变化"。
                refresh(true);
                log::info!("wallpaper watcher started");
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = KillTimer(Some(hwnd), POLL_TIMER_ID);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn info(path: &str, mtime: u64, primary: &str) -> WallpaperPaletteInfo {
        WallpaperPaletteInfo {
            path: path.to_string(),
            mtime_ms: mtime,
            palette: WallpaperPalette {
                primary: primary.to_string(),
                secondary: None,
                neutral: "#808080".to_string(),
            },
        }
    }

    #[test]
    fn same_key_hits_cache_without_recompute() {
        let mut slot: Option<Cached> = None;
        let calls = Cell::new(0);
        let key = CacheKey {
            path: PathBuf::from("C:/wp/a.jpg"),
            mtime_ms: 1000,
        };
        let a = resolve_cached(&mut slot, key.clone(), || {
            calls.set(calls.get() + 1);
            Some(info("C:/wp/a.jpg", 1000, "#112233"))
        });
        let b = resolve_cached(&mut slot, key, || {
            calls.set(calls.get() + 1);
            Some(info("C:/wp/a.jpg", 1000, "#ffffff"))
        });
        assert_eq!(calls.get(), 1, "同键第二次不应重算");
        assert_eq!(a.unwrap().palette.primary, "#112233");
        assert_eq!(
            b.unwrap().palette.primary,
            "#112233",
            "应返回缓存结果而非新算值"
        );
    }

    #[test]
    fn mtime_change_forces_recompute_even_for_same_path() {
        let mut slot: Option<Cached> = None;
        let calls = Cell::new(0);
        let _ = resolve_cached(
            &mut slot,
            CacheKey {
                path: PathBuf::from("C:/wp/a.jpg"),
                mtime_ms: 1000,
            },
            || {
                calls.set(calls.get() + 1);
                Some(info("C:/wp/a.jpg", 1000, "#112233"))
            },
        );
        let r = resolve_cached(
            &mut slot,
            CacheKey {
                path: PathBuf::from("C:/wp/a.jpg"),
                mtime_ms: 2000,
            },
            || {
                calls.set(calls.get() + 1);
                Some(info("C:/wp/a.jpg", 2000, "#445566"))
            },
        );
        assert_eq!(calls.get(), 2);
        assert_eq!(r.unwrap().palette.primary, "#445566");
    }

    #[test]
    fn failed_compute_keeps_previous_cache() {
        let mut slot: Option<Cached> = None;
        let old_key = CacheKey {
            path: PathBuf::from("C:/wp/a.jpg"),
            mtime_ms: 1000,
        };
        let _ = resolve_cached(&mut slot, old_key.clone(), || {
            Some(info("C:/wp/a.jpg", 1000, "#112233"))
        });
        let r = resolve_cached(
            &mut slot,
            CacheKey {
                path: PathBuf::from("C:/wp/broken.bin"),
                mtime_ms: 5,
            },
            || None,
        );
        assert!(r.is_none());
        // 旧缓存仍在：老键再来直接命中。
        let again = resolve_cached(&mut slot, old_key, || panic!("不应重算"));
        assert_eq!(again.unwrap().palette.primary, "#112233");
    }

    #[test]
    fn compute_info_decodes_extensionless_image_by_content() {
        // 模拟 TranscodedWallpaper：无扩展名文件，内容为 PNG。
        let dir = std::env::temp_dir().join(format!("vela-wp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("TranscodedWallpaper");
        let img = image::RgbaImage::from_pixel(40, 30, image::Rgba([30, 110, 220, 255]));
        let mut bytes: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let info = compute_info(&path, 42).expect("应能按内容解码");
        assert_eq!(info.mtime_ms, 42);
        assert_eq!(info.palette.primary, "#1e6edc");
        assert_eq!(info.palette.neutral, "#1e6edc");
        assert!(info.palette.secondary.is_none());
        assert!(info.path.ends_with("TranscodedWallpaper"));

        // 非图片内容：安全返回 None。
        std::fs::write(&path, b"not an image at all").unwrap();
        assert!(compute_info(&path, 43).is_none());
        // 空文件同样 None。
        std::fs::write(&path, b"").unwrap();
        assert!(compute_info(&path, 44).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mtime_ms_rejects_missing_and_directories() {
        assert!(mtime_ms(Path::new("C:/definitely/not/here.jpg")).is_none());
        assert!(
            mtime_ms(&std::env::temp_dir()).is_none(),
            "目录不是壁纸文件"
        );
    }

    #[test]
    fn thumbnail_decodes_mismatched_extension_by_content() {
        // 网图常见错位：JPEG 字节存成 .png 扩展名。缩略图必须按内容嗅探
        // 而非扩展名选解码器，否则网格里只剩破损占位图。
        let dir = std::env::temp_dir().join(format!("vela-thumb-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            40,
            30,
            image::Rgb([220, 110, 30]),
        ));
        let mut jpeg: Vec<u8> = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
        let fake_png = dir.join("fake.png");
        std::fs::write(&fake_png, &jpeg).unwrap();
        assert!(fake_png.to_string_lossy().ends_with(".png"));

        let url = thumbnail_data_url(fake_png.to_string_lossy().as_ref())
            .expect("JPEG 内容的 .png 应能出缩略图");
        assert!(url.starts_with("data:image/png;base64,"));

        // 真 PNG 与非图片内容两条基线路径不受影响。
        let mut png: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let real_png = dir.join("real.png");
        std::fs::write(&real_png, &png).unwrap();
        assert!(thumbnail_data_url(real_png.to_string_lossy().as_ref()).is_some());
        let junk = dir.join("junk.png");
        std::fs::write(&junk, b"not an image").unwrap();
        assert!(thumbnail_data_url(junk.to_string_lossy().as_ref()).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
