//! Desktop file browsing for the File Browser widget.
//!
//! Exposes commands that list a directory (defaulting to the user's Desktop),
//! returning each entry's name, path, kind, size and modified time, and that
//! open a file/folder in the system.

use serde::Serialize;
use std::fs;
use tauri::Manager;

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Size in bytes for files, `None` for directories.
    pub size: Option<u64>,
    /// Human-friendly modified time, e.g. "2026-08-13 14:00".
    pub modified: Option<String>,
}

fn fmt_modified(secs: Option<std::time::SystemTime>) -> Option<String> {
    let secs = secs?;
    let dt: chrono::DateTime<chrono::Local> = secs.into();
    // C-11: emit RFC3339 with an explicit local offset instead of the ambiguous
    // "YYYY-MM-DD HH:mm" (space-separated, no zone) which `new Date()` parses as
    // implementation-defined behavior across engines.
    Some(dt.to_rfc3339())
}

/* ------------------------------------------------------------------ */
/* 图库本地图片：复制进 app data 的 gallery 目录，前端经 asset 协议     */
/* 直接显示文件 —— 图片字节不再经过 localStorage（5MB 配额 + 常驻内   */
/* 存 + 同步序列化卡顿三重问题一并消除）。                            */
/* ------------------------------------------------------------------ */

pub(crate) fn gallery_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::vela_data_dir(app)
        .map_err(|e| format!("无法获取数据目录: {e}"))?
        .join("gallery");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建图库目录: {e}"))?;
    Ok(dir)
}

/// 缩略图目录：`gallery/thumbs`。与原图同级便于整体删除/迁移。
fn thumbs_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = gallery_dir(app)?.join("thumbs");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建缩略图目录: {e}"))?;
    Ok(dir)
}

/// 缩略图长边像素。3 列网格在 2x DPI 下单格约 140 逻辑像素，320 足够清晰，
/// 又能把 4000×3000 的手机照片从 ~5MB 压到 ~30KB。
const THUMB_MAX_EDGE: u32 = 320;

/// 允许导入的扩展名。`avif` 在列表内但不参与缩略图生成（未启用解码 feature）。
const GALLERY_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

/// 单张图片的导入结果。
#[derive(Serialize)]
pub struct GalleryImport {
    /// 原图在 app data 内的绝对路径。
    pub path: String,
    /// 缩略图绝对路径；解码失败或无需缩放时为 `None`，前端回退用原图。
    pub thumb: Option<String>,
}

/// 生成缩略图，返回缩略图路径。任何失败都返回 `None`（降级为使用原图），
/// 因为缩略图只是性能优化，不该让导入本身失败。
fn make_thumb(src: &std::path::Path, thumbs: &std::path::Path) -> Option<std::path::PathBuf> {
    // 解码前先看文件体积：高压缩比"图片炸弹"解压后可达数 GB，image::open
    // 会全量解码进内存再返回，先按文件大小挡掉异常输入。
    if std::fs::metadata(src)
        .ok()
        .is_none_or(|m| m.len() > 128 * 1024 * 1024)
    {
        return None;
    }
    // 扩展名可能伪装（JPEG 字节存成 .png），`image::open` 按扩展名选解码器
    // 会失败；与 wallpaper::compute_info 一致按魔数嗅探，嗅探不出再按扩展名兜底。
    let img = image::ImageReader::open(src)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    // 解码后校验像素总量（内存占用 ≈ w*h*4 字节），32k×32k 也会 OOM。
    const MAX_PIXELS: u64 = 8192 * 8192;
    if img.width() as u64 * img.height() as u64 > MAX_PIXELS {
        return None;
    }
    // 原图已经比缩略图还小，再生成一份纯属浪费磁盘。
    if img.width() <= THUMB_MAX_EDGE && img.height() <= THUMB_MAX_EDGE {
        return None;
    }
    // thumbnail 使用近邻+三角混合，比 resize(Lanczos3) 快数倍，
    // 在 320px 目标尺寸下肉眼差异可忽略。
    let small = img.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    let stem = src.file_stem()?.to_string_lossy().into_owned();
    // 统一存 PNG：无需按源格式分支，且始终无损、始终可解码。
    let dest = thumbs.join(format!("{stem}.png"));
    small
        .save_with_format(&dest, image::ImageFormat::Png)
        .ok()?;
    Some(dest)
}

#[tauri::command]
pub async fn gallery_import_file(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: String,
) -> Result<GalleryImport, String> {
    // S1（审计）：src 为任意路径，无闸门时不可信页面可把磁盘任意图片拷入
    // gallery 再经 asset 协议读出（本地图片外泄通道）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let src = std::path::Path::new(&path);
        if !src.is_file() {
            return Err(format!("不是有效文件: {path}"));
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !GALLERY_EXTS.contains(&ext.as_str()) {
            return Err(format!("不支持的图片格式: .{ext}"));
        }
        // E-4：导入前按原文件体积拦截，避免扩展名伪装的超大文件被完整复制进
        // app data 后才在缩略图阶段被拒（与 read_image_data_url 上限对齐）。
        const GALLERY_MAX_BYTES: u64 = 50 * 1024 * 1024;
        let size = fs::metadata(src)
            .map_err(|e| format!("读取文件信息失败: {e}"))?
            .len();
        if size > GALLERY_MAX_BYTES {
            return Err("图片超过 50MB 上限，请先压缩后再导入".to_string());
        }
        let dir = gallery_dir(&app)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // 进程 id + 亚秒纳秒做唯一后缀，免引 rand 依赖。
        let suffix = format!(
            "{:x}{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        );
        let dest = dir.join(format!("img-{stamp}-{suffix}.{ext}"));
        fs::copy(src, &dest).map_err(|e| format!("复制图片失败: {e}"))?;

        // 缩略图在这条 blocking 线程上顺带生成：解码 + 缩放是 CPU 密集操作，
        // 绝不能放主线程（会冻结所有 webview 窗口）。
        let thumb = thumbs_dir(&app)
            .ok()
            .and_then(|t| make_thumb(&dest, &t))
            .map(|p| p.to_string_lossy().into_owned());

        Ok(GalleryImport {
            path: dest.to_string_lossy().into_owned(),
            thumb,
        })
    })
    .await
    .map_err(|e| format!("图片导入任务失败: {e}"))?
}

/// [PASTE]（ZTools 借鉴 #1）粘贴图片 blob 入图库：与 gallery_import_file 同一
/// 套校验（扩展名白名单按 name 后缀、50MB 上限）与落盘/缩略图流程，只是
/// 数据来自内存字节（WebView 粘贴板拿不到磁盘路径）。返回导入结果。
#[tauri::command]
pub async fn gallery_import_bytes(
    window: tauri::Window,
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    name: String,
) -> Result<GalleryImport, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        const GALLERY_MAX_BYTES: usize = 50 * 1024 * 1024;
        if bytes.is_empty() || bytes.len() > GALLERY_MAX_BYTES {
            return Err("图片为空或超过 50MB 上限".to_string());
        }
        let ext = std::path::Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_else(|| "png".to_string());
        if !GALLERY_EXTS.contains(&ext.as_str()) {
            return Err(format!("不支持的图片格式: .{ext}"));
        }
        let dir = gallery_dir(&app)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let suffix = format!(
            "{:x}{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        );
        let dest = dir.join(format!("paste-{stamp}-{suffix}.{ext}"));
        fs::write(&dest, &bytes).map_err(|e| format!("写入图片失败: {e}"))?;
        let thumb = thumbs_dir(&app)
            .ok()
            .and_then(|t| make_thumb(&dest, &t))
            .map(|p| p.to_string_lossy().into_owned());
        Ok(GalleryImport {
            path: dest.to_string_lossy().into_owned(),
            thumb,
        })
    })
    .await
    .map_err(|e| format!("图片导入任务失败: {e}"))?
}

#[tauri::command]
pub async fn gallery_delete_file(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    // L2：路径已限 gallery 目录，再加窗口闸门作纵深防御。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = gallery_dir(&app)?;
        let target = std::path::Path::new(&path);
        // 只允许删除 gallery 目录内的文件，防止路径注入误删任意文件。
        // 注意：canonicalize 后再比较可挡住 `gallery/../../secret` 之类的穿越。
        let dir_real = dir
            .canonicalize()
            .map_err(|e| format!("无法解析图库目录: {e}"))?;
        let target_real = target
            .canonicalize()
            .map_err(|_| "拒绝删除：目标不存在".to_string())?;
        if !target_real.starts_with(&dir_real) || !target_real.is_file() {
            return Err("拒绝删除：目标不在图库目录内".into());
        }
        // 同名缩略图一并清理，避免 thumbs/ 目录成为孤儿文件坟场。
        if let Some(stem) = target_real.file_stem() {
            let thumb = dir_real
                .join("thumbs")
                .join(format!("{}.png", stem.to_string_lossy()));
            if thumb.is_file() {
                let _ = fs::remove_file(&thumb);
            }
        }
        fs::remove_file(&target_real).map_err(|e| format!("删除图片失败: {e}"))
    })
    .await
    .map_err(|e| format!("图片删除任务失败: {e}"))?
}

/// 清理孤儿缩略图：thumbs/ 里没有对应原图的文件。
/// 历史版本删除原图时不会清理缩略图，升级后调用一次即可回收空间。
#[tauri::command]
pub async fn gallery_clean_thumbs(app: tauri::AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = gallery_dir(&app)?;
        let thumbs = dir.join("thumbs");
        if !thumbs.is_dir() {
            return Ok(0);
        }
        // 先建立原图 stem 集合，再逐个比对，避免 O(n²) 的目录扫描。
        let mut stems: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() {
                    if let Some(s) = p.file_stem() {
                        stems.insert(s.to_string_lossy().into_owned());
                    }
                }
            }
        }
        let mut removed = 0u32;
        let Ok(entries) = fs::read_dir(&thumbs) else {
            return Ok(0);
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let orphan = p
                .file_stem()
                .map(|s| !stems.contains(s.to_string_lossy().as_ref()))
                .unwrap_or(false);
            if orphan && fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| format!("缩略图清理任务失败: {e}"))?
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use std::fs;

    /// 造一棵临时目录树：根下 a-report-2026.txt / report-old.txt / sub/
    /// report-deep.txt + node_modules/report-noise.txt。
    fn fixture(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("fd-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("a-report-2026.txt"), b"x").unwrap();
        fs::write(root.join("report-old.txt"), b"x").unwrap();
        fs::write(root.join("sub").join("report-deep.txt"), b"x").unwrap();
        fs::write(root.join("node_modules").join("report-noise.txt"), b"x").unwrap();
        root
    }

    #[test]
    fn matches_substring_recursively_and_skips_noise() {
        let root = fixture("core");
        let hits = search_roots_core(
            std::slice::from_ref(&root),
            "report",
            50,
            std::time::Instant::now() + std::time::Duration::from_secs(10),
        );
        let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"a-report-2026.txt"));
        assert!(names.contains(&"report-old.txt"));
        assert!(names.contains(&"report-deep.txt"), "子目录命中");
        assert!(!names.contains(&"report-noise.txt"), "node_modules 被跳过");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prefix_hits_rank_before_substring_hits() {
        let root = fixture("rank");
        // "a-report" 前缀命中应排在 "sub/report-deep"（子串命中）前。
        let hits = search_roots_core(
            std::slice::from_ref(&root),
            "a-report",
            50,
            std::time::Instant::now() + std::time::Duration::from_secs(10),
        );
        assert!(!hits.is_empty());
        assert_eq!(hits[0].name, "a-report-2026.txt");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deadline_expires_fast() {
        let root = fixture("dl");
        // 已过期的截止时刻：最多再扫 64 个目录就停（此处树很小，直接为空）。
        let hits = search_roots_core(
            std::slice::from_ref(&root),
            "report",
            50,
            std::time::Instant::now(),
        );
        assert!(hits.is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod gallery_tests {
    use super::*;

    /// 在临时目录里造一张指定尺寸的 PNG。
    fn write_png(dir: &std::path::Path, name: &str, w: u32, h: u32) -> std::path::PathBuf {
        let p = dir.join(name);
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([10, 120, 200, 255]));
        img.save_with_format(&p, image::ImageFormat::Png)
            .expect("写入测试图片");
        p
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("vela-thumb-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("创建临时目录");
        d
    }

    #[test]
    fn make_thumb_downscales_large_image_keeping_aspect_ratio() {
        let root = tmp_dir("large");
        let thumbs = root.join("thumbs");
        fs::create_dir_all(&thumbs).unwrap();
        let src = write_png(&root, "img-big.png", 1600, 800);

        let out = make_thumb(&src, &thumbs).expect("大图应生成缩略图");
        assert!(out.is_file());
        // 命名规则：与原图同 stem，扩展名统一为 png，便于删除时按 stem 定位。
        assert_eq!(out.file_name().unwrap().to_string_lossy(), "img-big.png");

        let thumb = image::open(&out).expect("缩略图应可解码");
        // 长边收敛到 320，短边按比例（1600x800 → 320x160）。
        assert_eq!(thumb.width(), 320);
        assert_eq!(thumb.height(), 160);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn make_thumb_skips_images_already_small() {
        let root = tmp_dir("small");
        let thumbs = root.join("thumbs");
        fs::create_dir_all(&thumbs).unwrap();
        let src = write_png(&root, "img-small.png", 200, 150);

        // 已经比 320 小：不该产生多余文件（前端会回退用原图）。
        assert!(make_thumb(&src, &thumbs).is_none());
        assert_eq!(fs::read_dir(&thumbs).unwrap().count(), 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn make_thumb_returns_none_for_undecodable_file() {
        let root = tmp_dir("bad");
        let thumbs = root.join("thumbs");
        fs::create_dir_all(&thumbs).unwrap();
        let src = root.join("not-an-image.png");
        fs::write(&src, b"definitely not a png").unwrap();

        // 解码失败必须降级为 None，绝不能让整个导入流程失败。
        assert!(make_thumb(&src, &thumbs).is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gallery_extension_whitelist_rejects_non_images() {
        assert!(GALLERY_EXTS.contains(&"png"));
        assert!(GALLERY_EXTS.contains(&"jpeg"));
        // 可执行文件 / 脚本必须被挡在导入之外。
        assert!(!GALLERY_EXTS.contains(&"exe"));
        assert!(!GALLERY_EXTS.contains(&"svg"));
    }
}

/// Reads a small UTF-8 text file (backup JSON) for the restore flow. Capped at
/// 32 MiB and restricted to .json/.txt/.csv so it can't be abused to slurp
/// arbitrary large binaries; the path always comes from the user's own file
/// picker dialog.
/// C-7：恢复备份只发生在设置窗口，加窗口闸门，禁止 widget-*/quick-note 调用。
#[tauri::command]
pub async fn read_text_file(window: tauri::Window, path: String) -> Result<String, String> {
    crate::require_settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.is_file() {
            return Err(format!("不是有效文件: {path}"));
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "json" | "txt" | "csv") {
            return Err("只支持读取 json/txt/csv 文件".into());
        }
        let meta = fs::metadata(p).map_err(|e| format!("无法读取文件信息: {e}"))?;
        const MAX: u64 = 32 * 1024 * 1024;
        if meta.len() > MAX {
            return Err("文件过大（超过 32MB）".into());
        }
        fs::read_to_string(p).map_err(|e| format!("读取文件失败: {e}"))
    })
    .await
    .map_err(|e| format!("读取任务失败: {e}"))?
}

/// B5 文件内容预览：读取文本类文件的
/// 头几个字节供列表卡片渲染前几行。与 `read_text_file`（设置窗专用、整读、
/// 备份恢复用）不同，本命令面向全部受信窗口且只取头部：
/// - 白名单扩展名（代码/文档/配置类纯文本）；
/// - 上限 `max_bytes`（调用方钳制，服务端再钳 64KB 兜底）；
/// - UTF-8 有损解码——BOM/截断的多字节序列不会让预览失败。
#[tauri::command]
pub async fn read_text_preview(
    window: tauri::Window,
    path: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    use std::io::Read;

    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.is_file() {
            return Err(format!("不是有效文件: {path}"));
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(
            ext.as_str(),
            "txt"
                | "md"
                | "json"
                | "csv"
                | "log"
                | "xml"
                | "html"
                | "htm"
                | "css"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "py"
                | "rs"
                | "go"
                | "java"
                | "ini"
                | "yml"
                | "yaml"
                | "toml"
        ) {
            return Err("不支持的预览类型".into());
        }
        // 预览只读头部，大文件不整读——这正是预览的意义。
        let max = max_bytes.unwrap_or(2048).min(64 * 1024) as usize;
        let mut file = fs::File::open(p).map_err(|e| format!("无法读取文件: {e}"))?;
        let mut buf = vec![0u8; max];
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败: {e}"))?;
        buf.truncate(n);
        Ok(String::from_utf8_lossy(&buf).into_owned())
    })
    .await
    .map_err(|e| format!("预览任务失败: {e}"))?
}

/// Lists the given directory, or the user's Desktop when `path` is `None`.
/// Async + spawn_blocking: directory scans must never run on the main thread
/// (a sync command would freeze every webview window).
///
/// `show_hidden` opts in to dot-prefixed entries (W-074 隐藏文件开关接通到
/// 后端；此前 Rust 侧无条件过滤，前端的开关形同虚设)。
#[tauri::command]
pub async fn list_directory(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: Option<String>,
    show_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    // S1（审计）：任意目录列举能力与 open_path 同级，统一收口到受信窗口。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let show_hidden = show_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match path {
            Some(p) => std::path::PathBuf::from(p),
            None => app
                .path()
                .desktop_dir()
                .map_err(|e| format!("无法获取桌面目录: {e}"))?,
        };

        if !dir.is_dir() {
            return Err(format!("不是有效目录: {}", dir.display()));
        }

        let mut entries = Vec::new();
        let read = fs::read_dir(&dir).map_err(|e| format!("无法读取目录: {e}"))?;
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Skip hidden/system files (leading dot) to keep the widget tidy.
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = if is_dir {
                None
            } else {
                meta.as_ref().map(|m| m.len())
            };
            let modified = fmt_modified(meta.as_ref().and_then(|m| m.modified().ok()));
            entries.push(FileEntry {
                name,
                path: entry.path().to_string_lossy().into_owned(),
                is_dir,
                size,
                modified,
            });
        }

        // Directories first, then files; each group sorted by name.
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    })
    .await
    .map_err(|e| format!("目录读取任务失败: {e}"))?
}

/* ================================================================== *
 * G11 命令面板文件搜索：预算式递归扫描（path-like 查询触发）。
 * ------------------------------------------------------------------ */

#[derive(Serialize, Clone)]
pub struct FileHit {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub modified: Option<String>,
}

/// 搜索噪声目录：依赖缓存 / 构建产物 / 系统目录，进去了只会拖预算、出噪声。
const SEARCH_SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "dist",
    "build",
    "out",
    ".cache",
    "$RECYCLE.BIN",
    "System Volume Information",
    "AppData",
];

/// 预算式 BFS 扫描核心（可单测：roots + 查询 + 截止时刻注入）。
/// 命中收集上限是 limit 的 8 倍——排序（前缀命中 > 子串命中，新改 > 旧）
/// 之后再截断，避免先到者通吃。
fn search_roots_core(
    roots: &[std::path::PathBuf],
    query: &str,
    limit: usize,
    deadline: std::time::Instant,
) -> Vec<FileHit> {
    let q = query.to_lowercase();
    let mut hits: Vec<FileHit> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, u32)> = roots
        .iter()
        .filter(|&r| r.is_dir())
        .map(|r| (r.clone(), 0u32))
        .collect();
    while let Some((dir, depth)) = stack.pop() {
        // 软超时：每个目录出栈查一次（Instant::now() 纳秒级，远低于一次
        // read_dir），到点即停——面板输入逐键触发，扫描让位给 UI。
        if std::time::Instant::now() >= deadline {
            break;
        }
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let is_dir = meta.is_dir();
            if is_dir && depth < 6 && !SEARCH_SKIP_DIRS.contains(&name.as_str()) {
                stack.push((entry.path(), depth + 1));
            }
            if name.to_lowercase().contains(&q) {
                hits.push(FileHit {
                    name,
                    path: entry.path().to_string_lossy().into_owned(),
                    is_dir,
                    modified: fmt_modified(meta.modified().ok()),
                });
                if hits.len() >= limit.saturating_mul(8).max(limit) {
                    return finalize_hits(hits, &q, limit);
                }
            }
        }
    }
    finalize_hits(hits, &q, limit)
}

/// 排序：前缀命中在前，其次按修改时间新→旧；截断到 limit。
/// modified 是带本地偏移的 RFC3339，同偏移下字典序等价时间序。
fn finalize_hits(mut hits: Vec<FileHit>, q: &str, limit: usize) -> Vec<FileHit> {
    hits.sort_by(|a, b| {
        let pa = a.name.to_lowercase().starts_with(q);
        let pb = b.name.to_lowercase().starts_with(q);
        pa.cmp(&pb)
            .then_with(|| b.modified.cmp(&a.modified))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    hits.truncate(limit);
    hits
}

/// G11：在用户常用目录（桌面/文档/下载/图片/音乐/视频）递归按文件名
/// 子串匹配。300ms 软超时 + 深度 ≤6 + 噪声目录跳过；spawn_blocking，
/// 目录遍历不占主线程。query < 2 字符直接回空（不值得扫盘）。
#[tauri::command]
pub async fn search_files(
    window: tauri::Window,
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FileHit>, String> {
    // S1（审计）：与 open_path / list_directory 同级的任意目录读取能力，
    // 统一收口到受信窗口。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let q = query.trim().to_string();
    if q.chars().count() < 2 {
        return Ok(vec![]);
    }
    let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let path = app.path();
        let candidates = [
            path.desktop_dir(),
            path.document_dir(),
            path.download_dir(),
            path.picture_dir(),
            path.audio_dir(),
            path.video_dir(),
        ];
        let mut roots: Vec<std::path::PathBuf> = Vec::new();
        for c in candidates.into_iter().flatten() {
            if !roots.contains(&c) {
                roots.push(c);
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
        Ok(search_roots_core(&roots, &q, limit, deadline))
    })
    .await
    .map_err(|e| format!("文件搜索任务失败: {e}"))?
}

/// C-14：spawn 出的子进程交后台线程 `wait()` 回收。直接 drop `Child` 会让
/// 进程句柄一直挂到 explorer 退出，常驻应用每打开一次文件/链接就累积一个。
/// 与 lib.rs `open_log_dir` 同一做法。
pub(crate) fn reap_child(mut child: std::process::Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// Opens a file with its default app, a folder in Explorer, or a URL in the
/// default browser. `path` may be a filesystem path or a `http(s)://` link.
///
/// Always goes through `explorer.exe` instead of `cmd /C start`: the latter
/// re-parses its command line, so a filename containing `&` or `%` could be
/// interpreted as shell metacharacters (command injection).
fn open_path_impl(path: &str) -> Result<(), String> {
    // A URL (http/https/mailto/…) is opened via the default handler.
    if path.contains("://") {
        return std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("无法打开链接: {e}"));
    }

    // Shell namespace URIs (shell:AppsFolder\… for UWP apps, W-090). These are
    // not filesystem paths, so skip the existence check below.
    if path.starts_with("shell:") {
        return std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("无法打开: {e}"));
    }

    // [MSET]（ZTools 借鉴 #3）系统设置深链 ms-settings:<page>：scheme URI 由
    // Shell 解析（explorer 直接打开设置应用的目标页），同样不走存在性检查。
    if path.starts_with("ms-settings:") {
        return std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("无法打开设置页: {e}"));
    }

    let p = std::path::PathBuf::from(path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }

    // Explorer opens folders, resolves .lnk shortcuts and opens files with
    // their default handler. (It exits with code 1 even on success, so only
    // the spawn result is checked.)
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(reap_child)
        .map_err(|e| format!("无法打开: {e}"))
}

/// spawn_blocking：存在性检查会 stat 磁盘（冷启动/网络盘可挂起数秒），
/// 进程创建本身也要几十毫秒 —— 同步命令跑在主线程，两者都会冻结所有窗口。
#[tauri::command]
pub async fn open_path(window: tauri::Window, path: String) -> Result<(), String> {
    // S1（审计）：open_path 经系统默认处理器可启动任意可执行文件/脚本，
    // 必须限定受信窗口（quick-note 等注入面不可达）。Window 由 Tauri 自动
    // 注入，前端 invoke 参数不变。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || open_path_impl(&path))
        .await
        .map_err(|e| format!("打开任务失败: {e}"))?
}

/// Classifies a dropped / picked path for the shortcuts widget: returns the
/// display label (file name without extension) and kind (`url` / `folder` /
/// `file`). The frontend stores both with the path, then extracts the real
/// icon via `get_app_icon`.
///
/// spawn_blocking：is_dir/existence 会 stat 磁盘（网络盘可挂起），同 open_path。
#[tauri::command]
pub async fn classify_path(
    window: tauri::Window,
    path: String,
) -> Result<crate::models::PathKind, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || classify_path_impl(&path))
        .await
        .map_err(|e| format!("分类任务失败: {e}"))?
}

fn classify_path_impl(path: &str) -> Result<crate::models::PathKind, String> {
    if path.contains("://") {
        let label = path
            .split("://")
            .nth(1)
            .unwrap_or(path)
            .trim_start_matches("www.")
            .trim_matches('/')
            .to_string();
        return Ok(crate::models::PathKind {
            label,
            kind: "url".into(),
            path: None,
        });
    }
    let p = std::path::PathBuf::from(path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    // 盘符根目录（C:\）file_stem 为空，退回完整路径。
    let label = p
        .file_stem()
        .or_else(|| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string());
    // 快捷方式解析成目标：入口存目标路径，桌面上的 .lnk 被删后仍可用；目标
    // 是文件夹时 kind 归位 folder（此前 .lnk 一律按 file 处理）。解析失败
    // （损坏/非标准链接）回退原路径按普通 file 处理。
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if ext.as_deref() == Some("lnk") || ext.as_deref() == Some("url") {
        let target = if ext.as_deref() == Some("lnk") {
            resolve_lnk_target(path)
        } else {
            read_url_target(&p)
        };
        if let Some(target) = target {
            if target.contains("://") {
                return Ok(crate::models::PathKind {
                    label,
                    kind: "url".into(),
                    path: Some(target),
                });
            }
            let kind = if std::path::Path::new(&target).is_dir() {
                "folder"
            } else {
                "file"
            };
            return Ok(crate::models::PathKind {
                label,
                kind: kind.into(),
                path: Some(target),
            });
        }
    }
    let kind = if p.is_dir() { "folder" } else { "file" };
    Ok(crate::models::PathKind {
        label,
        kind: kind.into(),
        path: None,
    })
}

/// `.url`（Internet 快捷方式）的目标：读 INI 风格文本的 `URL=` 行。系统生成的
/// .url 常为 UTF-16 编码，按 BOM 分流解码。
fn read_url_target(p: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let wide: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&wide)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let wide: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&wide)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    for line in text.lines() {
        let t = line.trim();
        if t.len() >= 4 && t.as_bytes()[..4].eq_ignore_ascii_case(b"url=") {
            let v = t[4..].trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// 解析 `.lnk` 快捷方式的目标路径（IShellLinkW + IPersistFile，逐调用初始化
/// COM）。取 RAWPATH：目标本身不存在时也返回原始串——落库的是目标而非 .lnk，
/// 桌面快捷方式被删后入口仍可用。None = 非 .lnk / 解析失败（调用方回退）。
#[cfg(windows)]
fn resolve_lnk_target(path: &str) -> Option<String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

    if !path.to_ascii_lowercase().ends_with(".lnk") {
        return None;
    }
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        // spawn_blocking 线程可能被复用：只有本调用成功初始化 COM 的才配对
        // CoUninitialize（S_FALSE 已初始化也是成功码，同样要配对；其他失败
        // ——含 RPC_E_CHANGED_MODE——沿用现状直接进行）。
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let owns_init = hr.is_ok();
        let result = (|| {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let persist: IPersistFile = link.cast().ok()?;
            persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
            let mut buf = [0u16; 1024];
            link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                .ok()?;
            let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
            let target = String::from_utf16_lossy(&buf[..end]).trim().to_string();
            (!target.is_empty()).then_some(target)
        })();
        if owns_init {
            CoUninitialize();
        }
        result
    }
}

#[cfg(not(windows))]
fn resolve_lnk_target(path: &str) -> Option<String> {
    let _ = path;
    None
}

/// Opens a native folder picker and returns the chosen path (or `None` if the
/// user cancels). Used by the file-browser widget to let the user choose which
/// folder it browses instead of always defaulting to the Desktop.
///
/// The rfd dialog is a blocking modal: running it bare in an async command
/// would park an async-runtime worker for the whole dialog lifetime (it can
/// stay open for minutes), starving the runtime. spawn_blocking is the
/// documented pattern (tauri-plugin-dialog does the same) — it keeps the
/// modal off both the main thread and the async workers.
#[tauri::command]
pub async fn pick_folder(window: tauri::Window) -> Option<String> {
    // L1：低信任窗不应能随时弹出原生目录选择框（UI 诱导钓鱼）。
    if !crate::trusted_window(window.label()) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择文件夹")
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Opens a native file picker and returns the chosen path (or `None` if the
/// user cancels). Used by the shortcuts widget and the timetable importer.
/// Same spawn_blocking rationale as `pick_folder`.
#[tauri::command]
pub async fn pick_file(window: tauri::Window) -> Option<String> {
    // L1：同 pick_folder。
    if !crate::trusted_window(window.label()) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择文件")
            .add_filter("Excel 工作簿", &["xlsx", "xlsm", "xls", "ods"])
            .add_filter("CSV / TSV", &["csv", "tsv"])
            .add_filter("所有文件", &["*"])
            .pick_file()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Shell namespaces for well-known system locations.
const SYSTEM_LOCATIONS: &[(&str, &str)] = &[
    ("recycle", "shell:RecycleBinFolder"),
    ("computer", "shell:MyComputerFolder"),
    ("documents", "shell:Personal"),
    ("downloads", "shell:Downloads"),
    ("pictures", "shell:My Pictures"),
    ("music", "shell:My Music"),
    ("videos", "shell:My Video"),
    ("desktop", "shell:Desktop"),
];

/// Opens a well-known system location (回收站 / 此电脑 / 文档 …) in Explorer.
/// `kind` is one of the SYSTEM_LOCATIONS keys; unknown keys are ignored.
/// spawn_blocking：进程创建在主线程上足以造成可感知的窗口卡顿。
#[tauri::command]
pub async fn open_system_location(kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some((_, shell)) = SYSTEM_LOCATIONS.iter().find(|(k, _)| *k == kind) else {
            return Err(format!("未知位置: {kind}"));
        };
        std::process::Command::new("explorer")
            .arg(shell)
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("无法打开 {kind}: {e}"))
    })
    .await
    .map_err(|e| format!("打开系统位置任务失败: {e}"))?
}

/// Scans the user's Start Menu folders for installed apps (.lnk shortcuts).
/// Returns a deduplicated, alphabetically sorted list of app names and paths.
/// Async + spawn_blocking: recursively statting both Start Menu trees can take
/// hundreds of ms — on the main thread that would stall every window.
#[tauri::command]
pub async fn list_apps() -> Result<Vec<AppInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut apps: Vec<AppInfo> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        let mut roots: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(p) = std::env::var("APPDATA") {
            roots.push(
                std::path::PathBuf::from(p)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs"),
            );
        }
        if let Ok(p) = std::env::var("PROGRAMDATA") {
            roots.push(
                std::path::PathBuf::from(p)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs"),
            );
        }

        for root in roots {
            collect_lnks(&root, &mut apps, &mut seen, 0);
        }

        apps.sort_by_key(|a| a.name.to_lowercase());
        apps.truncate(200);
        Ok(apps)
    })
    .await
    .map_err(|e| format!("应用扫描任务失败: {e}"))?
}

#[derive(serde::Serialize)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
}

/// Depth cap for the Start Menu walk: real hierarchies are ≤5 levels deep; the
/// cap also guards against junction/reparse-point loops (unbounded recursion
/// would overflow the stack).
const MAX_LNK_DEPTH: u32 = 6;

fn collect_lnks(
    dir: &std::path::Path,
    out: &mut Vec<AppInfo>,
    seen: &mut std::collections::HashSet<String>,
    depth: u32,
) {
    if depth > MAX_LNK_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_lnks(&path, out, seen, depth + 1);
        } else if path.extension().map(|e| e == "lnk").unwrap_or(false) {
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.is_empty() || seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());
            out.push(AppInfo {
                name,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
}

/// Extracts the icon of a file / shortcut (.lnk) as a base64-encoded PNG, so the
/// app launcher can show each installed app's real icon. Returns `None` when the
/// icon cannot be resolved (the frontend then falls back to a colored tile).
/// Async + spawn_blocking: SHGetFileInfoW + GetDIBits + PNG encode is called
/// once per app tile — on the main thread that adds up to visible UI stalls.
/// C-8：任意路径 stat 属读侧门控缺口，收口到可信窗口（settings + widget-*）。
/// BentoDesk 借鉴 #13：走磁盘缓存（icon_cached）——命中免整条提取链，
/// FolderPopup 每次重开不再重复提取同一批图标。
#[tauri::command]
pub async fn get_app_icon(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<String>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || Ok(icon_cached(&app, &path)))
        .await
        .map_err(|e| format!("图标提取任务失败: {e}"))?
}

/** 图标缓存条目上限（按文件数；超限按 mtime 逐最旧清理）。 */
const ICON_CACHE_CAP: usize = 1024;

/// 图标两级缓存的 warm tier：键 = 版本化路径哈希，值 = base64 PNG 文本。
/// 单条失效由 shortcut_watch 的 modified 事件调 `invalidate_icon_cache`；
/// 提取算法/请求尺寸升级时抬 `ICON_CACHE_VERSION` 整体失效（BentoDesk
/// 缓存版本号做法，旧条目由 prune_icon_cache 按最旧逐出）。缓存目录不可用
/// 时优雅降级直提。
fn icon_cached(app: &tauri::AppHandle, path: &str) -> Option<String> {
    let dir = crate::vela_data_dir(app).ok().map(|d| d.join("icon-cache"));
    let Some(dir) = dir else {
        return extract_icon_base64(path);
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return extract_icon_base64(path);
    }
    let file = dir.join(format!("{:016x}.b64", icon_cache_key(path)));
    if let Ok(hit) = std::fs::read_to_string(&file) {
        if !hit.is_empty() {
            return Some(hit);
        }
    }
    let b64 = extract_icon_base64(path)?;
    if crate::storage_util::write_text_atomic(&file, &b64).is_ok() {
        prune_icon_cache(&dir, ICON_CACHE_CAP);
    }
    Some(b64)
}

/// 缓存键版本（BentoDesk 缓存版本号做法）：提取算法或请求尺寸升级时 +1，
/// 旧版本键整体失效（旧文件由 prune_icon_cache 按 mtime 逐出）。
const ICON_CACHE_VERSION: u32 = 2;

/// 缓存键：版本前缀 + 路径归一的 FNV-64——小写 + 正斜杠统一反斜杠
/// （Windows 两种分隔符混用、大小写不敏感，同一文件只占一个缓存槽）。
fn icon_cache_key(path: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let normed = format!(
        "icon-cache-v{}\u{1}{}",
        ICON_CACHE_VERSION,
        path.to_lowercase().replace('/', "\\")
    );
    for b in normed.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 图标缓存失效（BentoDesk 借鉴 #4 的配套：目标内容变更 → 删缓存条目）。
/// shortcut_watch 的 modified 事件调用；下次 get_app_icon 走完整提取链。
pub fn invalidate_icon_cache(app: &tauri::AppHandle, path: &str) {
    let Some(dir) = crate::vela_data_dir(app).ok().map(|d| d.join("icon-cache")) else {
        return;
    };
    let _ = std::fs::remove_file(dir.join(format!("{:016x}.b64", icon_cache_key(path))));
}

/// 单路径修改时间（epoch 秒；不存在/不可读/时间早于纪元 = 0）。可测纯逻辑。
fn mtime_secs(path: &str) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 批量取路径修改时间（epoch 秒，与入参同序，缺失 = 0）。快捷方式文件夹
/// 弹层「按时间排序」用。
#[tauri::command]
pub async fn paths_mtimes(window: tauri::Window, paths: Vec<String>) -> Result<Vec<u64>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || Ok(paths.iter().map(|p| mtime_secs(p)).collect()))
        .await
        .map_err(|e| format!("读取时间戳任务失败：{e}"))?
}

/// 超上限按修改时间逐最旧删除（读 1k 条目目录的代价远小于一次图标提取）。
fn prune_icon_cache(dir: &std::path::Path, cap: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if !m.is_file() {
                return None;
            }
            let t = m.modified().ok()?;
            Some((e.path(), t))
        })
        .collect();
    if files.len() <= cap {
        return;
    }
    // mtime 为主键、路径名为 tiebreaker（文件系统时间粒度粗时保证确定性）。
    files.sort_by_key(|(p, t)| (*t, p.to_string_lossy().to_string()));
    let excess = files.len() - cap;
    for (p, _) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(windows)]
fn extract_icon_base64(path: &str) -> Option<String> {
    use base64::Engine as _;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut sfi: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let ret = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut sfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ret == 0 || sfi.hIcon.0.is_null() {
        return None;
    }
    let hicon = sfi.hIcon;

    let mut ii: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(hicon, &mut ii) }.is_err() {
        unsafe {
            let _ = DestroyIcon(hicon);
        };
        return None;
    }
    let hbm = ii.hbmColor;
    if hbm.0.is_null() {
        // GetIconInfo also returns an owned hbmMask bitmap that must be freed.
        unsafe {
            let _ = DeleteObject(ii.hbmMask.into());
        };
        unsafe {
            let _ = DestroyIcon(hicon);
        };
        return None;
    }

    let mut bmp: BITMAP = unsafe { std::mem::zeroed() };
    let got_obj = unsafe {
        GetObjectW(
            hbm.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        )
    };
    if got_obj == 0 {
        unsafe {
            let _ = DeleteObject(ii.hbmMask.into());
        };
        unsafe {
            let _ = DeleteObject(hbm.into());
        };
        unsafe {
            let _ = DestroyIcon(hicon);
        };
        return None;
    }
    let w = bmp.bmWidth;
    let h = bmp.bmHeight;
    if w <= 0 || h <= 0 {
        unsafe {
            let _ = DeleteObject(ii.hbmMask.into());
        };
        unsafe {
            let _ = DeleteObject(hbm.into());
        };
        unsafe {
            let _ = DestroyIcon(hicon);
        };
        return None;
    }

    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.0.is_null() {
        unsafe {
            let _ = DeleteObject(ii.hbmMask.into());
        };
        unsafe {
            let _ = DeleteObject(hbm.into());
        };
        unsafe {
            let _ = DestroyIcon(hicon);
        };
        return None;
    }
    // NOTE: hbm must NOT be selected into `dc` for GetDIBits (per MSDN the
    // bitmap must not be selected into any DC when calling it) — a compatible
    // DC handle alone is all that's needed.

    let mut bi: BITMAPINFO = unsafe { std::mem::zeroed() };
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h; // top-down rows
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB.0;

    let row_size = w as usize * 4;
    let size = row_size * h as usize;
    let mut buf: Vec<u8> = vec![0u8; size];
    let lines = unsafe {
        GetDIBits(
            dc,
            hbm,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        )
    };

    unsafe {
        let _ = DeleteDC(dc);
    };
    unsafe {
        let _ = DeleteObject(ii.hbmMask.into());
    };
    unsafe {
        let _ = DeleteObject(hbm.into());
    };
    unsafe {
        let _ = DestroyIcon(hicon);
    };

    if lines == 0 {
        return None;
    }

    // BGRA -> RGBA
    let mut rgba = Vec::with_capacity(size);
    for chunk in buf.chunks_exact(4) {
        rgba.push(chunk[2]);
        rgba.push(chunk[1]);
        rgba.push(chunk[0]);
        rgba.push(chunk[3]);
    }

    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)?;
    let mut png: Vec<u8> = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png);
        encoder
            .write_image(
                img.as_raw(),
                w as u32,
                h as u32,
                image::ExtendedColorType::Rgba8,
            )
            .ok()?;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(&png))
}

#[cfg(not(windows))]
fn extract_icon_base64(_path: &str) -> Option<String> {
    None
}

/* ------------------------------------------------------------------ */
/* W-074…097 文件浏览 / 快捷方式 / 启动器增强的后端支撑                */
/* ------------------------------------------------------------------ */

/// W-078 根目录快捷 chips：返回常用系统目录的绝对路径（下载/文档/图片/音乐/
/// 视频/桌面），供文件浏览组件一键直达。目录缺失的键不出现在返回值里。
#[tauri::command]
pub fn known_dirs(
    app: tauri::AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
    use std::collections::HashMap;
    let mut m: HashMap<String, String> = HashMap::new();
    let mut insert = |key: &str, p: Result<std::path::PathBuf, tauri::Error>| {
        if let Ok(p) = p {
            m.insert(key.to_string(), p.to_string_lossy().into_owned());
        }
    };
    insert("downloads", app.path().download_dir());
    insert("documents", app.path().document_dir());
    insert("pictures", app.path().picture_dir());
    insert("music", app.path().audio_dir());
    insert("videos", app.path().video_dir());
    insert("desktop", app.path().desktop_dir());
    Ok(m)
}

/// W-077 在资源管理器中定位文件/文件夹（/select 高亮目标而非打开父目录）。
/// explorer 自己解析整条命令行，必须把 `/select,"path"` 拼成单个参数。
/// spawn_blocking：存在性 stat + 进程创建都不能占主线程。
#[tauri::command]
pub async fn reveal_in_explorer(window: tauri::Window, path: String) -> Result<(), String> {
    // 审计修复：任意路径可启动 explorer /select，与 open_path 同级收口到受信窗口
    // （调用方 FileBrowserWidget/ShortcutsWidget 均在 widget-*，行为不变）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err(format!("路径不存在: {path}"));
        }
        std::process::Command::new("explorer")
            // L4：此前 `/select,"{path}"` 单参数拼接——路径含内嵌引号时可被
            // explorer 二次解析拆出额外参数。拆成两个独立 argv 转义不可达。
            .arg("/select")
            .arg(&path)
            .spawn()
            .map(reap_child)
            .map_err(|e| format!("无法打开资源管理器: {e}"))
    })
    .await
    .map_err(|e| format!("资源管理器定位任务失败: {e}"))?
}

/// E16 破坏性操作围栏（服务端等价实现）：删除类命令的服务端最后一道闸——
/// 拒绝明显超出「用户在文件组件里删一个条目」预期范围的目标：
/// - 盘根 / 无普通名称组件的路径（`C:\`、`\`）；
/// - 系统关键目录本体（Windows / Program Files / 用户根 / System32 等）。
///
/// 不尝试枚举一切危险路径（不可能完备）；目标只是拦住「路径拼接错误 /
/// 状态串台把裸根送进删除命令」这类事故。普通文件与用户子目录不受影响。
pub(crate) fn destructive_path_denied(p: &std::path::Path) -> Option<&'static str> {
    use std::path::Component;

    // 只要有 Normal 组件即可继续（`C:\` 只有 Prefix+RootDir；UNC 根同理）。
    let has_normal = p.components().any(|c| matches!(c, Component::Normal(_)));
    if !has_normal {
        return Some("拒绝删除盘根或根目录");
    }
    let lower = p.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    let t = lower.trim_end_matches('\\');
    const CRITICAL: &[&str] = &[
        "\\windows",
        "\\windows\\system32",
        "\\windows\\syswow64",
        "\\program files",
        "\\program files (x86)",
        "\\programdata",
        "\\users\\all users",
    ];
    for c in CRITICAL {
        if t == *c || t.ends_with(&format!(":{c}")) {
            return Some("拒绝删除系统关键目录");
        }
    }
    None
}

/// W-077 删除到系统回收站（Shell 文件操作 + FOF_ALLOWUNDO）。
/// C-7：高危命令加窗口闸门（settings + widget-*）。
/// E16：destructive_path_denied 围栏（拦裸根 / 系统目录）。
/// E17：破坏性命令审计——成败都写日志且日志
/// 永不影响操作结果（log 宏不抛错，天然满足）。
#[tauri::command]
pub async fn delete_to_recycle_bin(window: tauri::Window, path: String) -> Result<(), String> {
    crate::require_trusted(&window)?;
    if let Some(reason) = destructive_path_denied(std::path::Path::new(&path)) {
        log::warn!(
            "audit: delete DENIED window={} path={path:?} reason={reason}",
            window.label()
        );
        return Err(reason.to_string());
    }
    let label = window.label().to_string();
    let result = tauri::async_runtime::spawn_blocking(move || move_to_recycle_bin(&path))
        .await
        .map_err(|e| format!("删除任务失败: {e}"));
    match &result {
        Ok(Ok(())) => log::info!("audit: delete OK window={label}"),
        Ok(Err(e)) => log::warn!("audit: delete FAIL window={label} error={e}"),
        Err(e) => log::warn!("audit: delete JOIN-FAIL window={label} error={e}"),
    }
    // 审计不改变结果：路径已在闭包内消费，日志只记窗口与结论，不回显完整
    // 路径（日志保留 7 天，文件名也属敏感信息；拒绝分支才记路径）。
    result?
}

#[cfg(windows)]
pub(crate) fn move_to_recycle_bin(path: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    // SHFileOperationW 要求 pFrom 以双 NUL 结尾。
    let mut wide: Vec<u16> = path
        .encode_utf16()
        .chain(std::iter::repeat_n(0, 2))
        .collect();
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = PCWSTR(wide.as_mut_ptr());
    op.fFlags = (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0) as u16;
    let ret = unsafe { SHFileOperationW(&mut op) };
    if ret != 0 {
        return Err(format!("无法删除到回收站（错误码 {ret}）"));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("操作已取消".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn move_to_recycle_bin(_path: &str) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

/// W-077 重命名（仅同目录，拒绝借道移动到任意位置）。
/// C-7：高危命令加窗口闸门（settings + widget-*）。
#[tauri::command]
pub async fn rename_path(
    window: tauri::Window,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let old = std::path::Path::new(&old_path);
        let new = std::path::Path::new(&new_path);
        if !old.exists() {
            return Err(format!("路径不存在: {old_path}"));
        }
        if new.exists() {
            return Err("目标名称已存在".into());
        }
        if old.parent() != new.parent() {
            return Err("仅支持同目录重命名".into());
        }
        fs::rename(old, new).map_err(|e| format!("重命名失败: {e}"))
    })
    .await
    .map_err(|e| format!("重命名任务失败: {e}"))?
}

/// DeskOrder 借鉴 #3：在指定目录下新建空文件 / 文件夹。
/// C-7：写文件系统属高危命令，挂窗口闸门；名字只接受单个普通路径组件
/// （拒绝分隔符/盘符/..，防借道在目录树任意位置创建）。
#[tauri::command]
pub async fn create_entry(
    window: tauri::Window,
    dir: String,
    name: String,
    is_dir: bool,
) -> Result<String, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.trim();
        if name.is_empty() || name == "." || name == ".." {
            return Err("名称无效".into());
        }
        use std::path::Component;
        let mut comps = std::path::Path::new(name).components();
        if !matches!(
            (comps.next(), comps.next()),
            (Some(Component::Normal(_)), None)
        ) {
            return Err("名称不能包含路径分隔符".into());
        }
        let dir_path = std::path::Path::new(&dir);
        if !dir_path.is_dir() {
            return Err(format!("目录不存在: {dir}"));
        }
        let dest = dir_path.join(name);
        if dest.exists() {
            return Err("同名项已存在".into());
        }
        if is_dir {
            fs::create_dir_all(&dest).map_err(|e| format!("创建文件夹失败: {e}"))?;
        } else {
            fs::File::create(&dest).map_err(|e| format!("创建文件失败: {e}"))?;
        }
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("创建任务失败: {e}"))?
}

/// W-088 带参数启动应用（exe/lnk/UWP 皆可）。ShellExecuteW 会解析 .lnk 并
/// 把参数传给目标；比 explorer 中转更可控。返回值 >32 视为成功。
/// spawn_blocking：存在性 stat + ShellExecuteW（会解析 .lnk，可能碰盘）
/// 都不该占主线程。
fn launch_app_impl(path: &str, args: Option<&str>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        if path.starts_with("shell:") || path.contains("://") {
            return open_path_impl(path);
        }
        let p = std::path::Path::new(path);
        if !p.exists() {
            return Err(format!("路径不存在: {path}"));
        }
        let file: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let params: Vec<u16> = match args.map(str::trim) {
            Some(a) if !a.is_empty() => a.encode_utf16().chain(std::iter::once(0)).collect(),
            _ => Vec::new(),
        };
        let ret = unsafe {
            ShellExecuteW(
                None,
                PCWSTR::null(),
                PCWSTR(file.as_ptr()),
                if params.is_empty() {
                    PCWSTR::null()
                } else {
                    PCWSTR(params.as_ptr())
                },
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if ret.0 as isize <= 32 {
            return Err(format!("无法启动: {path}"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (path, args);
        Err("仅支持 Windows".into())
    }
}

#[tauri::command]
pub async fn launch_app(
    window: tauri::Window,
    path: String,
    args: Option<String>,
) -> Result<(), String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || launch_app_impl(&path, args.as_deref()))
        .await
        .map_err(|e| format!("启动任务失败: {e}"))?
}

/// W-090 UWP / 商店应用：Get-StartApps 里 AppID 带 `!` 的是打包应用，启动
/// 走 `shell:AppsFolder\<AppID>`。PowerShell 输出强制 UTF-8，避免中文应用名
/// 按 OEM 代码页解码成乱码；CREATE_NO_WINDOW 防止 GUI 进程闪控制台黑框。
#[tauri::command]
pub async fn list_uwp_apps() -> Result<Vec<AppInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
                          Get-StartApps | Where-Object { $_.AppID -like '*!*' } | \
                          ForEach-Object { '{0}|{1}' -f $_.Name, $_.AppID }";
            // spawn + 截止时间等待：PowerShell 偶发被 AV 扫描/受限环境拖住，
            // 无超时的 output() 会把线程和命令 future 永久挂死（重试再挂一个）。
            const UWP_SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
            let mut child = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("无法启动 PowerShell: {e}"))?;
            let deadline = std::time::Instant::now() + UWP_SCAN_TIMEOUT;
            let mut finished = false;
            while !finished {
                if child
                    .try_wait()
                    .map_err(|e| format!("等待 PowerShell 失败: {e}"))?
                    .is_some()
                {
                    finished = true;
                } else if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("UWP 应用扫描超时（PowerShell 20s 无响应）".into());
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
            // 输出只有几 KB，不会在轮询期间塞满管道；wait_with_output 收尾读取并回收。
            let out = child
                .wait_with_output()
                .map_err(|e| format!("读取 PowerShell 输出失败: {e}"))?;
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            Ok(text
                .lines()
                .filter_map(|line| {
                    let line = line.trim();
                    if line.is_empty() {
                        return None;
                    }
                    let (name, appid) = line.split_once('|')?;
                    let (name, appid) = (name.trim(), appid.trim());
                    if name.is_empty() || appid.is_empty() {
                        return None;
                    }
                    Some(AppInfo {
                        name: name.to_string(),
                        path: format!("shell:AppsFolder\\{appid}"),
                    })
                })
                .collect())
        }
        #[cfg(not(windows))]
        {
            Ok(Vec::<AppInfo>::new())
        }
    })
    .await
    .map_err(|e| format!("UWP 扫描任务失败: {e}"))?
}

/// W-082 系统回收站真实角标：统计各盘 `$Recycle.Bin` 下可读 SID 目录中的
/// `$R*` 条目（即回收的项目数；其它用户的 SID 目录无权限读取会被跳过，
/// 恰好只统计到自己的）。
/// 回收站计数缓存：每次调用都要顺序扫 C:→Z: 全部盘符下 $Recycle.Bin 的
/// 各 SID 目录，秒级轮询下等于每拍全盘 IO。30 秒 TTL 缓存把稳态成本降为
/// 一次目录枚举；清理回收站后用户手动刷新最多等 30 秒。
fn cached_recycle_bin_count() -> u64 {
    use std::sync::Mutex;
    static CACHE: std::sync::OnceLock<Mutex<(std::time::Instant, u64)>> =
        std::sync::OnceLock::new();
    const TTL: std::time::Duration = std::time::Duration::from_secs(30);
    let lock = CACHE.get_or_init(|| Mutex::new((std::time::Instant::now() - TTL, 0)));
    let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if guard.0.elapsed() < TTL {
        return guard.1;
    }
    let mut count: u64 = 0;
    for d in b'C'..=b'Z' {
        let root = format!("{}:\\$Recycle.Bin", d as char);
        let Ok(sids) = fs::read_dir(&root) else {
            continue;
        };
        for sid in sids.flatten() {
            if let Ok(items) = fs::read_dir(sid.path()) {
                for item in items.flatten() {
                    if item.file_name().to_string_lossy().starts_with("$R") {
                        count += 1;
                    }
                }
            }
        }
    }
    *guard = (std::time::Instant::now(), count);
    count
}

#[tauri::command]
pub async fn recycle_bin_count() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(cached_recycle_bin_count)
        .await
        .map_err(|e| format!("回收站统计任务失败: {e}"))
}

/* ------------------------------------------------------------------ */
/* W-103 涂鸦存储升级：PNG 存 app data 文件，localStorage 只留标记。   */
/* 原先整张 dataURL 塞 localStorage，一笔一存且受 5MB 配额限制，画几  */
/* 张就爆 quota。像素进文件后 key 里只剩 `file` 标记（随镜像进备份，  */
/* 体积极小）。                                                        */
/* ------------------------------------------------------------------ */

fn sketches_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::vela_data_dir(app)
        .map_err(|e| format!("无法获取数据目录: {e}"))?
        .join("sketches");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建涂鸦目录: {e}"))?;
    Ok(dir)
}

/// instanceId 直接拼文件名，只放行字母数字与 `-_`，防路径穿越。
fn safe_sketch_name(instance_id: &str) -> Result<String, String> {
    if instance_id.is_empty()
        || !instance_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("非法的实例标识".to_string());
    }
    Ok(format!("{instance_id}.png"))
}

/// W-103 保存涂鸦：解析 `data:image/png;base64,…` 写入 sketches/<id>.png。
/// 异步 + spawn_blocking：PNG 编码/写盘在数据量大时会卡主线程。
#[tauri::command]
pub async fn save_sketch_image(
    window: tauri::Window,
    app: tauri::AppHandle,
    instance_id: String,
    data_url: String,
) -> Result<(), String> {
    use base64::Engine as _;

    // L2：文件名已白名单，再加窗口闸门作纵深防御（低信任窗不应能写盘）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }

    let name = safe_sketch_name(&instance_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let b64 = data_url
            .split_once(',')
            .map(|(_, b)| b.trim())
            .ok_or_else(|| "无效的图片数据".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Base64 解码失败: {e}"))?;
        let path = sketches_dir(&app)?.join(&name);
        // 先写临时文件再原子改名，避免进程中途被杀留下半个 PNG。
        let tmp = path.with_extension("png.tmp");
        fs::write(&tmp, &bytes).map_err(|e| format!("写入涂鸦失败: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("保存涂鸦失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("涂鸦保存任务失败: {e}"))?
}

/// W-103 读取涂鸦：返回 dataURL；没有存档时返回 `None`（前端回退空白画布）。
#[tauri::command]
pub async fn read_sketch_image(
    window: tauri::Window,
    app: tauri::AppHandle,
    instance_id: String,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    // L2：同 save_sketch_image。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }

    let name = safe_sketch_name(&instance_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = sketches_dir(&app)?.join(&name);
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(Some(format!("data:image/png;base64,{b64}")))
    })
    .await
    .map_err(|e| format!("涂鸦读取任务失败: {e}"))?
}

/// W-103 清空涂鸦：删除存档文件（前端同时清掉 localStorage 标记）。
#[tauri::command]
pub async fn delete_sketch_image(
    window: tauri::Window,
    app: tauri::AppHandle,
    instance_id: String,
) -> Result<(), String> {
    // L2：同 save_sketch_image。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let name = safe_sketch_name(&instance_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = sketches_dir(&app)?.join(&name);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("删除涂鸦失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("涂鸦删除任务失败: {e}"))?
}

/// W-104 置入图片标注：读取本地图片并转成 PNG dataURL 供 canvas 贴图。
/// 超过 2048px 长边的图先缩到 2048（涂鸦画布本身远小于此，保真足够，
/// 又能避免几十 MB 的照片撑爆 dataURL 与 canvas 内存）。
/// C-8：任意路径图片→base64 属读侧门控缺口，收口到可信窗口。
#[tauri::command]
pub async fn read_image_data_url(window: tauri::Window, path: String) -> Result<String, String> {
    use base64::Engine as _;

    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        // 解码前体积上限 + 解码后像素总量上限：防"图片炸弹"在缩放前就把
        // 数 GB 解压进内存（thumbnail 发生在全量解码之后，挡不住）。
        if std::fs::metadata(&path)
            .map_err(|e| format!("无法读取图片: {e}"))?
            .len()
            > 128 * 1024 * 1024
        {
            return Err("图片过大（超过 128MB）".to_string());
        }
        // 扩展名可能伪装（JPEG 字节存成 .png），按魔数嗅探格式而非扩展名。
        let img = image::ImageReader::open(&path)
            .map_err(|e| format!("无法读取图片: {e}"))?
            .with_guessed_format()
            .map_err(|e| format!("无法读取图片: {e}"))?
            .decode()
            .map_err(|e| format!("无法读取图片: {e}"))?;
        const MAX_EDGE: u32 = 2048;
        const MAX_PIXELS: u64 = 8192 * 8192;
        if img.width() as u64 * img.height() as u64 > MAX_PIXELS {
            return Err("图片尺寸超出范围".to_string());
        }
        let img = if img.width() > MAX_EDGE || img.height() > MAX_EDGE {
            img.thumbnail(MAX_EDGE, MAX_EDGE)
        } else {
            img
        };
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png)
            .map_err(|e| format!("编码 PNG 失败: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        Ok(format!("data:image/png;base64,{b64}"))
    })
    .await
    .map_err(|e| format!("图片读取任务失败: {e}"))?
}

#[cfg(test)]
mod classify_tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("vela-classify-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("创建临时目录");
        d
    }

    #[test]
    fn classifies_folder_and_plain_file() {
        let root = tmp_dir("kinds");
        let dir = root.join("相册");
        fs::create_dir_all(&dir).unwrap();
        let file = root.join("note.txt");
        fs::write(&file, "hi").unwrap();

        let r = classify_path_impl(dir.to_str().unwrap()).unwrap();
        assert_eq!(r.kind, "folder");
        assert_eq!(r.path, None);
        let r = classify_path_impl(file.to_str().unwrap()).unwrap();
        assert_eq!(r.kind, "file");
        assert_eq!(r.label, "note");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_url_target_from_utf8_and_utf16_files() {
        let root = tmp_dir("url");
        // UTF-8 无 BOM
        let a = root.join("a.url");
        fs::write(
            &a,
            "[InternetShortcut]\r\nURL=https://example.com/x\r\nIconIndex=0\r\n",
        )
        .unwrap();
        assert_eq!(
            read_url_target(&a).as_deref(),
            Some("https://example.com/x")
        );
        // UTF-16LE BOM（系统生成形态），键名小写 url= 也能识别
        let b = root.join("b.url");
        let mut wide: Vec<u8> = vec![0xFF, 0xFE];
        for u in "[InternetShortcut]\r\nurl=https://案例.cn/".encode_utf16() {
            wide.extend_from_slice(&u.to_le_bytes());
        }
        fs::write(&b, &wide).unwrap();
        assert_eq!(read_url_target(&b).as_deref(), Some("https://案例.cn/"));
        // 无 URL 行 → None
        let c = root.join("c.url");
        fs::write(&c, "[InternetShortcut]\r\nIconIndex=0").unwrap();
        assert_eq!(read_url_target(&c), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn url_shortcut_file_resolves_to_url_kind() {
        let root = tmp_dir("urlfile");
        let f = root.join("站点.url");
        fs::write(&f, "[InternetShortcut]\r\nURL=https://example.com/").unwrap();
        let r = classify_path_impl(f.to_str().unwrap()).unwrap();
        assert_eq!(r.kind, "url");
        assert_eq!(r.path.as_deref(), Some("https://example.com/"));
        assert_eq!(r.label, "站点");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn non_lnk_input_short_circuits_resolution() {
        assert_eq!(resolve_lnk_target("C:/not-a-link.txt"), None);
    }

    /// E16 破坏性围栏：裸根与系统关键目录拒绝；普通条目与深层系统目录内的
    /// 具体文件放行（围栏只拦「目录本体」级事故，不做全路径黑名单）。
    #[test]
    fn destructive_fence_denies_roots_and_critical_dirs() {
        for root in ["C:\\", "c:/", "\\\\.\\C:\\", "C:", "D:\\"] {
            let denied = destructive_path_denied(std::path::Path::new(root));
            assert!(denied.is_some(), "应拒绝盘根/根: {root} -> {denied:?}");
        }
        for crit in [
            "C:\\Windows",
            "C:\\windows\\system32\\",
            "C:\\Program Files",
            "C:\\Program Files (x86)",
        ] {
            let denied = destructive_path_denied(std::path::Path::new(crit));
            assert!(denied.is_some(), "应拒绝系统目录本体: {crit} -> {denied:?}");
        }
        // 普通条目（文件 / 用户目录 / 系统目录内的具体项）不受影响。
        for ok in [
            "C:\\Users\\me\\Desktop\\a.txt",
            "C:\\Users\\me",
            "D:\\资料",
            "C:\\Windows\\System32\\drivers\\etc\\hosts",
        ] {
            assert!(
                destructive_path_denied(std::path::Path::new(ok)).is_none(),
                "不应拦截普通路径: {ok}"
            );
        }
        assert!(destructive_path_denied(std::path::Path::new("")).is_some());
    }
}

#[cfg(test)]
mod icon_cache_tests {
    use super::*;

    #[test]
    fn cache_key_normalizes_case_and_distinguishes_paths() {
        assert_eq!(icon_cache_key("C:\\A\\B.PDF"), icon_cache_key("c:/a/b.pdf"));
        assert_ne!(
            icon_cache_key("C:\\a\\x.pdf"),
            icon_cache_key("C:\\b\\x.pdf")
        );
    }

    #[test]
    fn mtime_secs_missing_is_zero_and_file_is_positive() {
        assert_eq!(mtime_secs("C:/vela-definitely-not-exist.bin"), 0);
        let p = std::env::temp_dir().join(format!("vela-mtime-test-{}", std::process::id()));
        std::fs::write(&p, b"x").unwrap();
        assert!(mtime_secs(&p.to_string_lossy()) > 0);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn prune_enforces_cap() {
        let dir = std::env::temp_dir().join(format!("vela-icon-cache-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("{i}.b64")), "x").unwrap();
        }
        // 5 个文件、容量 3 → 恰好剩 3 个（mtime 同刻时按路径名确定性淘汰）。
        prune_icon_cache(&dir, 3);
        let left = fs::read_dir(&dir).unwrap().flatten().count();
        assert_eq!(left, 3);
        // 未超限时不动。
        prune_icon_cache(&dir, 3);
        assert_eq!(fs::read_dir(&dir).unwrap().flatten().count(), 3);
        let _ = fs::remove_dir_all(&dir);
    }
}
