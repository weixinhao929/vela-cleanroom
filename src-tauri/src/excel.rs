//! 课程表 Excel 读取：扫描所有工作表，返回"内容最多"的那张表交给前端做语义解析。
//!
//! 为什么解析放前端：网格式 / 清单式两种课表形态、列名同义词、周次单双周
//! 归一化全是纯字符串逻辑，放前端可以用 Vitest 覆盖；Rust 只负责把
//! xlsx/xls/ods（calamine）或 CSV（手写小解析器）可靠地变成 `Vec<Vec<String>>`。
//!
//! 鲁棒性：
//!  - 数值单元格整数化（"2" 而非 "2.0"），避免星期/节次匹配失败；
//!  - 日期/布尔/错误单元格都降级为字符串，任何单元格都不 panic；
//!  - 文件不存在 / 加密 / 非 Excel：返回中文错误，前端提示重新选择。

use std::fs::File;
use std::io::BufReader;

use calamine::{open_workbook_auto, Data, Reader};

/// 读取 Excel 为字符串矩阵（课程表导入）。CSV 文件走简易解析。
///
/// 教务导出的工作簿常把封面 / 说明 / 汇总放在第一张表，真正的课表在后面的
/// 表里。这里扫描**所有**工作表，返回"非空单元格最多"的那一张——这样即使
/// 第一张是空白页也能正确读到课表，不再出现"导入后没识别到课程"。
///
/// calamine 会把全部工作表展开进内存，大文件在同步命令里会卡住主线程
/// （冻结所有 webview），因此 async + spawn_blocking。
///
/// 注：calamine 0.26 不支持 `.xlsb`（二进制工作簿），前端文件过滤器也不含
/// 该扩展；选择其它格式后若仍打不开会返回中文错误提示重新选择。
#[tauri::command]
pub async fn read_excel_sheet(
    window: tauri::Window,
    path: String,
) -> Result<Vec<Vec<String>>, String> {
    crate::require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || read_excel_sheet_blocking(&path))
        .await
        .map_err(|e| format!("读取任务失败：{e}"))?
}

fn read_excel_sheet_blocking(path: &str) -> Result<Vec<Vec<String>>, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") || lower.ends_with(".tsv") {
        return read_csv(path);
    }

    // 体积上限：上百 MB 的工作簿全量展开成字符串矩阵会长时间占满一个
    // blocking worker 并把内存放大数倍；课程表场景不可能需要这么大文件。
    if std::fs::metadata(path)
        .map_err(|e| format!("无法读取文件：{e}"))?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("文件过大（超过 64MB）".to_string());
    }
    let mut workbook = open_workbook_auto(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let sheets = read_all_sheets(&mut workbook);

    // 单元格总量上限：行 × 列展开后的字符串数才是真实内存规模。
    const MAX_CELLS: usize = 500_000;
    let total_cells: usize = sheets
        .iter()
        .map(|rows| rows.iter().map(|r| r.len()).sum::<usize>())
        .sum();
    if total_cells > MAX_CELLS {
        return Err("表格数据量过大（超过 50 万单元格）".to_string());
    }

    sheets
        .into_iter()
        .max_by_key(|rows| rows.iter().flatten().filter(|c| !c.is_empty()).count())
        .filter(|rows| rows.iter().flatten().any(|c| !c.is_empty()))
        .ok_or_else(|| "文件中没有可读取的课表".to_string())
}

/// 遍历工作簿所有工作表，把每张表转成字符串矩阵。单表失败不致命。
fn read_all_sheets(workbook: &mut impl Reader<BufReader<File>>) -> Vec<Vec<Vec<String>>> {
    // 先按表尺寸（行×列）预检、再展开字符串矩阵。教务导出常含
    // 整列引用的超大维度表，64MB 的 xlsx 展开后可达数倍内存直至 OOM——
    // 必须在逐格映射之前拒绝（全局 MAX_CELLS 检查在展开之后，来不及）。
    const MAX_SHEET_CELLS: usize = 2_000_000;
    let names = workbook.sheet_names().to_vec();
    let mut out = Vec::new();
    for name in &names {
        match workbook.worksheet_range(name) {
            Ok(range) => {
                let (h, w) = range.get_size();
                if h.saturating_mul(w) > MAX_SHEET_CELLS {
                    eprintln!(
                        "[excel] sheet `{name}` skipped: {h}x{w} exceeds {MAX_SHEET_CELLS} cells"
                    );
                    continue;
                }
                out.push(
                    range
                        .rows()
                        .map(|row| row.iter().map(cell_to_string).collect())
                        .collect(),
                );
            }
            Err(e) => eprintln!("[excel] sheet `{name}` failed: {e:?}"),
        }
    }
    out
}

fn cell_to_string(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => {
            // 整数值的浮点表示去掉 ".0"，星期 "2" 才能被正则命中。
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e}"),
    }
}

/// UTF-8 / GB18030 尝试的 CSV 读取（教务系统导出的 CSV 常是 GBK）。
/// 完整 状态机：支持引号包裹、引号转义，以及引号字段内换行
/// （多行单元格在课程表导出中很常见，不能按行切分）。
fn read_csv(path: &str) -> Result<Vec<Vec<String>>, String> {
    // 体积上限：GB 级 CSV 全量进内存会长时间占满 worker 甚至 OOM。
    if std::fs::metadata(path)
        .map_err(|e| format!("无法读取文件：{e}"))?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("文件过大（超过 64MB）".to_string());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取文件：{e}"))?;
    let text = decode_text(&bytes);
    let sep = if path.to_lowercase().ends_with(".tsv") {
        '\t'
    } else {
        ','
    };
    Ok(parse_csv(&text, sep))
}

fn decode_text(bytes: &[u8]) -> String {
    // 去 UTF-8 BOM：否则首个表头单元格带着 \u{FEFF}，列名匹配全部失效。
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    // GB18030（GBK 超集）按标准解码；汉字区位与 Unicode 非线性对应，
    // 必须用 encoding_rs，手写线性映射会解出错误汉字。
    let (cow, _, _) = encoding_rs::GB18030.decode(bytes);
    cow.into_owned()
}

fn parse_csv(text: &str, sep: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut fields: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' => {
                    // "" 是转义的双引号；单独的 " 结束引用字段。
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        cur.push('"');
                    } else {
                        in_quotes = false;
                    }
                }
                '\r' => {}
                _ => cur.push(c),
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == sep {
            fields.push(cur.trim().to_string());
            cur = String::new();
        } else if c == '\n' {
            fields.push(cur.trim().to_string());
            cur = String::new();
            // 空行（不含引号跨行）跳过。
            if fields.len() > 1 || !fields.first().is_some_and(|f| f.is_empty()) {
                rows.push(std::mem::take(&mut fields));
            } else {
                fields.clear();
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.trim().is_empty() || !fields.is_empty() {
        fields.push(cur.trim().to_string());
        if fields.len() > 1 || !fields.first().is_some_and(|f| f.is_empty()) {
            rows.push(fields);
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实教务导出课表（src/widget/__fixtures__/my-schedule.xlsx）读取回归。
    /// 该文件为网格式：表头在第 8 行、A/B 列合并为节次列、单元格内含换行与
    /// 多门课。这里只锁定 Rust 侧「文件 → 字符串矩阵」这一环的关键特征，
    /// 语义解析由前端 timetable.test.ts 覆盖。
    #[test]
    fn reads_real_grid_schedule_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/widget/__fixtures__/my-schedule.xlsx"
        );
        let rows = read_excel_sheet_blocking(path).expect("样例课表应能读取");

        // 表头行：含 ≥3 个「星期X」。
        let header = rows
            .iter()
            .find(|r| r.iter().filter(|c| c.starts_with("星期")).count() >= 3)
            .expect("应存在星期表头行");
        assert!(header.iter().any(|c| c == "星期一"));
        assert!(header.iter().any(|c| c == "星期日"));

        // 节次标签行与课程单元格都应保留（含换行的多行文本不被截断）。
        let flat = rows.join_all();
        assert!(flat.contains("第1节-第2节"), "应保留节次行标签");
        assert!(flat.contains("电子测量原理"), "应保留课程名");
        assert!(flat.contains("4-8周"), "应保留周次信息");
        assert!(flat.contains("朝阳-实验楼-200"), "应保留地点信息");
    }

    /// 便于断言的扁平化辅助。
    trait JoinAll {
        fn join_all(&self) -> String;
    }
    impl JoinAll for Vec<Vec<String>> {
        fn join_all(&self) -> String {
            self.iter()
                .map(|r| r.join("\u{1}"))
                .collect::<Vec<_>>()
                .join("\u{2}")
        }
    }

    #[test]
    fn csv_parser_handles_quotes_and_newlines() {
        let rows = parse_csv("a,\"b,1\",c\n\"multi\nline\",y,z\n", ',');
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["a", "b,1", "c"]);
        assert_eq!(rows[1][0], "multi\nline");
    }

    #[test]
    fn cell_to_string_normalizes_integral_floats() {
        assert_eq!(cell_to_string(&Data::Float(2.0)), "2");
        assert_eq!(cell_to_string(&Data::Float(2.5)), "2.5");
        assert_eq!(cell_to_string(&Data::Empty), "");
    }
}
