//! 样式预设包：`.zip` 格式的预设分享——导出把全部
//! 样式预设打包为 `manifest.json + presets.json`；导入经 zip 加固校验后
//! 只把 `presets.json` 文本交给前端合并（前端再过 zod 清洗 + 同名去重）。
//!
//! **加固清单**：
//! - 条目白名单：只接受扁平的 `manifest.json` / `presets.json` 两个名字，
//!   目录、路径分隔符、其它任何条目一律拒绝（zip-slip 无从发生）；
//! - 重复条目名拒绝；条目数 ≤ 8、单条 ≤ 4MB、总量 ≤ 8MB（防压缩炸弹）；
//! - manifest 必须可解析且 `format == "vela-style-presets"`、`version == 1`
//!   （Kind 探测先于载荷消费，坏包在碰 presets 之前就拒绝）；
//! - 导出写用户指定路径（rfd 覆盖确认由对话框承担），包体在内存组装。
//!
//! 校验与组装都是纯函数（`read_package` / `build_package`），测试直接用
//! `build_package` 造正包、手工篡改造坏包驱动。

use std::collections::HashSet;
use std::io::{Read, Write};

const MAX_ENTRIES: usize = 8;
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const ENTRY_MANIFEST: &str = "manifest.json";
const ENTRY_PRESETS: &str = "presets.json";

/// 组装预设包（纯函数）：manifest + presets 两个条目，deflate 压缩。
pub fn build_package(presets_json: &str) -> Result<Vec<u8>, String> {
    let manifest = serde_json::json!({
        "format": "vela-style-presets",
        "version": 1,
        "count": serde_json::from_str::<serde_json::Value>(presets_json)
            .ok()
            .and_then(|v| v.as_array().map(|a| a.len()))
            .unwrap_or(0),
    })
    .to_string();
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(ENTRY_MANIFEST, opts)
            .map_err(|e| format!("写入 manifest 失败：{e}"))?;
        zip.write_all(manifest.as_bytes())
            .map_err(|e| format!("写入 manifest 失败：{e}"))?;
        zip.start_file(ENTRY_PRESETS, opts)
            .map_err(|e| format!("写入预设失败：{e}"))?;
        zip.write_all(presets_json.as_bytes())
            .map_err(|e| format!("写入预设失败：{e}"))?;
        zip.finish().map_err(|e| format!("收尾压缩包失败：{e}"))?;
    }
    Ok(buf.into_inner())
}

/// 读取并校验预设包（纯函数）：通过全部防线后返回 presets.json 文本。
pub fn read_package(bytes: &[u8]) -> Result<String, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("不是有效的压缩包：{e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("条目过多（>{MAX_ENTRIES}）"));
    }
    let mut names: HashSet<String> = HashSet::new();
    let mut total: u64 = 0;
    let mut manifest: Option<String> = None;
    let mut presets: Option<String> = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("读取条目失败：{e}"))?;
        // 白名单：扁平文件名，且只认两个已知条目。
        let name = entry.name().to_string();
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err(format!("拒绝嵌套路径条目：{name}"));
        }
        if name != ENTRY_MANIFEST && name != ENTRY_PRESETS {
            return Err(format!("拒绝未知条目：{name}"));
        }
        if !names.insert(name.clone()) {
            return Err(format!("重复条目：{name}"));
        }
        if entry.is_dir() {
            return Err(format!("拒绝目录条目：{name}"));
        }
        // symlink / reparse point（不解压也拒，纵深防御）。
        #[cfg(unix)]
        if entry
            .unix_mode()
            .map(|m| m & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err(format!("拒绝符号链接条目：{name}"));
        }
        let size = entry.size();
        if size > MAX_ENTRY_BYTES {
            return Err(format!("条目过大：{name}"));
        }
        total += size;
        if total > MAX_TOTAL_BYTES {
            return Err("压缩包总量超限".into());
        }
        let mut text = String::new();
        entry
            .read_to_string(&mut text)
            .map_err(|e| format!("读取 {name} 失败：{e}"))?;
        if name == ENTRY_MANIFEST {
            manifest = Some(text);
        } else {
            presets = Some(text);
        }
    }
    let manifest = manifest.ok_or("缺少 manifest.json")?;
    let presets = presets.ok_or("缺少 presets.json")?;
    // Kind 探测先于载荷消费：格式不对的包在 presets 内容被使用前拒绝。
    let kind: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|e| format!("manifest 无法解析：{e}"))?;
    if kind.get("format").and_then(|v| v.as_str()) != Some("vela-style-presets") {
        return Err("不是 Vela 样式预设包".into());
    }
    if kind.get("version").and_then(|v| v.as_i64()) != Some(1) {
        return Err("预设包版本过新，请升级应用后导入".into());
    }
    Ok(presets)
}

/// 导出：全部预设（前端序列化好的 JSON 数组）→ 另存为 .zip。
/// 返回 None = 用户取消；Some(路径) = 已写出。
#[tauri::command]
pub async fn export_preset_package(
    window: tauri::Window,
    presets_json: String,
) -> Result<Option<String>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = crate::files::parented_file_dialog(&window)
            .set_title("导出样式预设包")
            .add_filter("Vela 样式预设包", &["zip", "velapreset"])
            .set_file_name("vela-style-presets.zip")
            .save_file()
        else {
            return Ok(None);
        };
        let bytes = build_package(&presets_json)?;
        std::fs::write(&path, bytes).map_err(|e| format!("写出预设包失败：{e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("导出任务失败：{e}"))?
}

/// 导入：选择 .zip → 加固校验 → 返回 presets.json 文本（前端合并）。
/// 返回 None = 用户取消。
#[tauri::command]
pub async fn import_preset_package(window: tauri::Window) -> Result<Option<String>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = crate::files::parented_file_dialog(&window)
            .set_title("导入样式预设包")
            .add_filter("Vela 样式预设包", &["zip", "velapreset"])
            .pick_file()
        else {
            return Ok(None);
        };
        let presets = read_package_capped(&path)?;
        Ok(Some(presets))
    })
    .await
    .map_err(|e| format!("导入任务失败：{e}"))?
}

/// [GALLERY]从指定路径导入预设包：与文件对话框
/// 版同一条校验链，供在线画廊下载完成后的落盘文件复用（下载文件的 sha256
/// 已在下载时校验，这里照常走 read_package 的 ZIP 结构加固校验）。
#[tauri::command]
pub async fn import_preset_package_from_path(
    window: tauri::Window,
    path: String,
) -> Result<Option<String>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let presets = read_package_capped(std::path::Path::new(&path))?;
        Ok(Some(presets))
    })
    .await
    .map_err(|e| format!("导入任务失败：{e}"))?
}

///读前 metadata 预检（对齐 在 lib.rs 的修复模式）——此前先
/// std::fs::read 整读进内存再比对上限，误选超大文件会有瞬时内存尖峰。
/// TOCTOU 由读后复核兜底（文件在预检与读取之间被换大）。
fn read_package_capped(path: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.len() > MAX_TOTAL_BYTES {
        return Err("文件过大".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
    if bytes.len() as u64 > MAX_TOTAL_BYTES {
        return Err("文件过大".into());
    }
    read_package(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_build_and_read() {
        let json = r#"[{"id":"a","name":"清爽","widgetType":"files","createdAt":1,"config":{}}]"#;
        let bytes = build_package(json).unwrap();
        assert_eq!(read_package(&bytes).unwrap(), json);
    }

    #[test]
    fn rejects_empty_and_garbage() {
        assert!(read_package(b"").is_err());
        assert!(read_package(b"not a zip at all").is_err());
    }

    #[test]
    fn rejects_extra_nested_and_missing_entries() {
        // 正包 + 额外条目 / 嵌套路径条目 → 拒绝。
        let json = "[]";
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file(ENTRY_MANIFEST, opts).unwrap();
            zip.write_all(br#"{"format":"vela-style-presets","version":1}"#)
                .unwrap();
            zip.start_file(ENTRY_PRESETS, opts).unwrap();
            zip.write_all(json.as_bytes()).unwrap();
            zip.start_file("evil.exe", opts).unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        let err = read_package(&buf.into_inner()).unwrap_err();
        assert!(err.contains("未知条目"), "{err}");

        let mut buf2 = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf2);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("../../../evil.exe", opts).unwrap();
            zip.write_all(b"x").unwrap();
            zip.start_file(ENTRY_PRESETS, opts).unwrap();
            zip.write_all(json.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        assert!(read_package(&buf2.into_inner())
            .unwrap_err()
            .contains("嵌套路径"));
    }

    #[test]
    fn rejects_wrong_manifest_kind_and_version() {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file(ENTRY_MANIFEST, opts).unwrap();
            zip.write_all(br#"{"format":"something-else","version":1}"#)
                .unwrap();
            zip.start_file(ENTRY_PRESETS, opts).unwrap();
            zip.write_all(b"[]").unwrap();
            zip.finish().unwrap();
        }
        assert!(read_package(&buf.into_inner())
            .unwrap_err()
            .contains("不是 Vela"));

        let mut buf2 = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf2);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file(ENTRY_MANIFEST, opts).unwrap();
            zip.write_all(br#"{"format":"vela-style-presets","version":99}"#)
                .unwrap();
            zip.start_file(ENTRY_PRESETS, opts).unwrap();
            zip.write_all(b"[]").unwrap();
            zip.finish().unwrap();
        }
        assert!(read_package(&buf2.into_inner())
            .unwrap_err()
            .contains("版本过新"));
    }
}
