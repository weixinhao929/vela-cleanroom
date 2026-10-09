//! [PROC-WATCH]进程事件触发器：按前端自动化规则
//! 下发的模式列表（支持 `*`/`?` 通配，大小写不敏感）监视进程启动 / 退出，
//! 变化即向 widget-0 emit `process-event`。
//!
//! 轮询纪律（后端轮询治理）：
//!  - 懒启停：`set_process_watch(空列表)` 即停——线程在 Condvar 上真挂起，
//!    没有进程规则的机器零开销；
//!  - 5s 一拍 Toolhelp32Snapshot 全量快照 + 内存比对增量；
//!  - 逐拍 catch_unwind 兜 panic（presence/monitor 同款），watcher 永不因
//!    单拍异常死亡。
//!
//! 事件载荷 [`ProcessEvent`]：pattern（触发的规则模式原文，前端按它匹配规则）
//! + name（具体进程名）+ kind（"start" | "exit"）。

use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex};

use serde::Serialize;
use tauri::Emitter;
use ts_rs::TS;

/// 轮询间隔（秒）：进程级事件无亚秒级需求，5s 对「构建完成」类通知绰绰有余。
const POLL_SECS: u64 = 5;

/// `process-event` 事件载荷（emit 至 widget-0）。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ProcessEvent {
    /// 触发的规则模式原文（前端规则匹配键）。
    pub pattern: String,
    /// 具体进程名（如 cargo.exe）。
    pub name: String,
    /// "start" | "exit"。
    pub kind: String,
}

/// 当前监视模式（None/空 = 停）；变更经 Condvar 唤醒线程。
static PATTERNS: Mutex<Option<Vec<String>>> = Mutex::new(None);
static WAKE: Condvar = Condvar::new();

/// 通配匹配（`*` 任意串 / `?` 单字符，大小写不敏感；纯函数，单测覆盖）。
pub fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    // 经典双指针 + 回溯（无递归，模式长度无上限担忧）。
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ni;
            pi += 1;
        } else if star != usize::MAX {
            // 回溯：星号多吃一个字符。
            pi = star + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// 从两个快照集合算事件（纯函数，单测覆盖）：进入 = start，离开 = exit。
/// 返回按 (pattern, kind, name) 排序的事件列表（输出稳定，便于测试）。
pub fn diff_snapshots(
    patterns: &[String],
    prev: &BTreeMap<String, Vec<String>>,
    cur: &BTreeMap<String, Vec<String>>,
) -> Vec<ProcessEvent> {
    let mut out = Vec::new();
    for pattern in patterns {
        let empty = Vec::new();
        let before = prev.get(pattern).unwrap_or(&empty);
        let after = cur.get(pattern).unwrap_or(&empty);
        for name in after {
            if !before.contains(name) {
                out.push(ProcessEvent {
                    pattern: pattern.clone(),
                    name: name.clone(),
                    kind: "start".to_string(),
                });
            }
        }
        for name in before {
            if !after.contains(name) {
                out.push(ProcessEvent {
                    pattern: pattern.clone(),
                    name: name.clone(),
                    kind: "exit".to_string(),
                });
            }
        }
    }
    out
}

/// 枚举当前全部进程名（去重）。快照失败返回 `None`（调用方跳过本拍、
/// 保留基线——此前失败返回空集，diff 会把全部已匹配进程判成「exit」，
/// 向自动化规则发假退出事件误触发锁屏/通知）。
#[cfg(windows)]
fn snapshot_processes() -> Option<Vec<String>> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: 快照句柄与条目结构按 API 约定使用；句柄泄漏防护用 drop。
    let snap = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(h) => h,
        Err(e) => {
            log::warn!("process_watch: snapshot failed: {e}");
            return None;
        }
    };
    let mut names: Vec<String> = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snap, &mut entry) }.is_ok();
    while ok {
        let end = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
        ok = unsafe { Process32NextW(snap, &mut entry) }.is_ok();
    }
    // SAFETY: 句柄成对关闭（快照句柄无需 Invalidate）。
    let _ = unsafe { windows::Win32::Foundation::CloseHandle(snap) };
    Some(names)
}

/// 设置监视模式（前端引擎在规则集变化时全量下发）。空列表即停。
#[tauri::command]
pub fn set_process_watch(window: tauri::Window, patterns: Vec<String>) -> Result<(), String> {
    crate::require_trusted(&window)?;
    // 归一：去空白、去重、保序；全空即视为停。
    let cleaned: Vec<String> = {
        let mut seen = std::collections::BTreeSet::new();
        patterns
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty() && seen.insert(p.to_lowercase()))
            .collect()
    };
    {
        let mut guard = PATTERNS.lock().unwrap_or_else(|p| p.into_inner());
        *guard = if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        };
    }
    WAKE.notify_all();
    Ok(())
}

/// 常驻 watcher 线程（setup 启动一次）：有模式时每 5s 快照比对 emit；
/// 无模式时在 Condvar 上真挂起（零唤醒）。
pub fn start_process_watcher(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("vela-process-watch".to_string())
        .spawn(move || {
            // pattern（小写归一键）→ 上一拍匹配到的进程名集合。
            let mut prev: BTreeMap<String, Vec<String>> = BTreeMap::new();
            // prev 基线对应的模式集 + 是否已对该模式集
            // 建过基线。模式被 set_process_watch 替换（或停后再启）后，旧基线对
            // 新规则无意义——此前直接拿旧 prev 对新 patterns 做 diff，新规则把
            // 所有已在跑进程当 "start" 事件误发。现在模式集变化（或经停启等待
            // 醒来）即清空基线并只重建不发事件，兑现「新规则的进程已在跑不算
            // start」的注释承诺（首拍同理：只建基线）。
            let mut prev_patterns: Option<Vec<String>> = None;
            let mut baseline_ready = false;
            loop {
                let (patterns, resumed_after_wait) = {
                    let mut guard = PATTERNS.lock().unwrap_or_else(|p| p.into_inner());
                    let mut waited = false;
                    loop {
                        match guard.as_ref() {
                            Some(p) if !p.is_empty() => break,
                            _ => {
                                waited = true;
                                guard = WAKE.wait(guard).unwrap_or_else(|p| p.into_inner());
                            }
                        }
                    }
                    (guard.clone().expect("checked non-empty above"), waited)
                };
                if baseline_invalidated(&prev_patterns, resumed_after_wait, &patterns) {
                    prev.clear();
                    baseline_ready = false;
                }
                prev_patterns = Some(patterns.clone());
                // catch_unwind 的 Ok(panic) → None：快照失败同样跳拍保基线。
                let names = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                    snapshot_processes,
                ))
                .unwrap_or_default()
                {
                    Some(n) => n,
                    None => {
                        // 快照瞬时失败——保留 prev 基线跳过本拍（空集 diff
                        // = N 条假 exit）；仍睡满一个周期防失败自旋。
                        log::warn!("process_watch: snapshot unavailable, keep baseline");
                        nap(&patterns);
                        continue;
                    }
                };
                let cur: BTreeMap<String, Vec<String>> = patterns
                    .iter()
                    .map(|p| {
                        let lower = p.to_lowercase();
                        let matched: Vec<String> = names
                            .iter()
                            .filter(|n| wildcard_match(p, n))
                            .cloned()
                            .collect();
                        (lower, matched)
                    })
                    .collect();
                // 基线未建好（刚清空的这一拍）只记 cur 不发事件：进程已在跑
                // 不算 start，同类工具 同语义；下一拍起正常 diff。
                if baseline_ready {
                    // 事件按原始 pattern 匹配（diff_snapshots 用 patterns 遍历，
                    // 而 prev/cur 键是小写归一键——以小写键查询）。
                    let lower_patterns: Vec<String> =
                        patterns.iter().map(|p| p.to_lowercase()).collect();
                    let events = diff_snapshots(&lower_patterns, &prev, &cur);
                    for e in events {
                        log::info!(
                            "process_watch: {} {} (pattern {})",
                            e.kind,
                            e.name,
                            e.pattern
                        );
                        let _ = app.emit_to("widget-0", "process-event", &e);
                    }
                }
                prev = cur;
                baseline_ready = true;
                // 睡一个轮询周期；模式被清空或替换时提前醒来（醒来即按
                // 清基线重建，新规则的进程已在跑不算 start）。
                nap(&patterns);
            }
        });
    //spawn 失败不再 expect 崩掉整个启动——线程配额耗尽属极端
    // 环境，功能降级（进程监视缺席）优于应用起不来；set_process_watch
    // 的下一次调用不会重启线程，此处记 error 留诊断线索。
    if let Err(e) = spawned {
        log::error!("process_watch: spawn watcher failed: {e}");
    }
}

/// 睡一个轮询周期（POLL_SECS）；期间模式被清空/替换则提前返回。
fn nap(patterns: &[String]) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(POLL_SECS);
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        let guard = PATTERNS.lock().unwrap_or_else(|p| p.into_inner());
        if guard.clone().as_deref() != Some(patterns) {
            break;
        }
        let remaining = deadline - now;
        // wait_timeout 消耗并归还锁；g 在本迭代末尾释放，循环头重新加锁。
        let _ = WAKE
            .wait_timeout(guard, remaining)
            .unwrap_or_else(|p| p.into_inner());
    }
}

/// 基线失效判定（纯函数，单测覆盖）——满足任一条件
/// 即须清空基线重建：
///  1. 当前模式集与基线所属模式集不同（set_process_watch 替换了规则）；
///  2. 本轮模式是经 Condvar 等待醒来的（监视曾停止——即便恢复成同一份模式，
///     停用期间发生的变化不该被追溯成事件，停启视同重启）。
fn baseline_invalidated(
    prev_patterns: &Option<Vec<String>>,
    resumed_after_wait: bool,
    patterns: &[String],
) -> bool {
    resumed_after_wait || prev_patterns.as_deref() != Some(patterns)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect()))
            .collect()
    }

    #[test]
    fn wildcard_basics() {
        assert!(wildcard_match("cargo.exe", "cargo.exe"));
        assert!(wildcard_match("CARGO.EXE", "cargo.exe"));
        assert!(wildcard_match("cargo*", "cargo.exe"));
        assert!(wildcard_match("*.exe", "anything.exe"));
        assert!(wildcard_match("ms?.exe", "msb.exe"));
        assert!(!wildcard_match("ms?.exe", "msbuild.exe"));
        assert!(wildcard_match("*", "whatever"));
        assert!(!wildcard_match("cargo", "cargo.exe"));
        // 多星号回溯。
        assert!(wildcard_match("*b*d", "abcd"));
        assert!(!wildcard_match("*b*e", "abcd"));
        assert!(wildcard_match("a*c*", "abcabc"));
    }

    #[test]
    fn diff_emits_start_and_exit_per_pattern() {
        let patterns = vec!["cargo*.exe".to_string()];
        let prev = m(&[("cargo*.exe", &["cargo.exe"])]);
        let cur = m(&[("cargo*.exe", &["cargo.exe", "cargo-watch.exe"])]);
        let events = diff_snapshots(&patterns, &prev, &cur);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "start");
        assert_eq!(events[0].name, "cargo-watch.exe");
        assert_eq!(events[0].pattern, "cargo*.exe");

        // 再到空集：cargo.exe 与 cargo-watch.exe 双双 exit。
        let events = diff_snapshots(&patterns, &cur, &m(&[]));
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.kind == "exit"));
    }

    #[test]
    fn diff_ignores_patterns_not_watched_and_keeps_others_stable() {
        // patterns 只含 b：a 的集合变化不产生事件（prev/cur 键多余是防御态）。
        let patterns = vec!["b*".to_string()];
        let prev = m(&[("a*", &["a.exe"]), ("b*", &["b.exe"])]);
        let cur = m(&[("a*", &[]), ("b*", &["b.exe", "b2.exe"])]);
        let events = diff_snapshots(&patterns, &prev, &cur);
        assert_eq!(events.len(), 1);
        assert_eq!(
            (events[0].name.as_str(), events[0].kind.as_str()),
            ("b2.exe", "start")
        );
        // 稳态（无变化）零事件。
        assert!(diff_snapshots(&patterns, &cur, &cur).is_empty());
    }

    /// 基线失效判定——模式替换与停启等待都必须触发重建，稳态不重建。
    #[test]
    fn baseline_invalidated_on_pattern_change_or_resume() {
        let a = vec!["cargo*.exe".to_string()];
        let b = vec!["cargo*.exe".to_string(), "msbuild*.exe".to_string()];
        // 首拍（无历史基线）必须重建。
        assert!(baseline_invalidated(&None, false, &a));
        // 稳态：同一份模式连续轮询，不重建（保基线才能发真实 start/exit）。
        assert!(!baseline_invalidated(&Some(a.clone()), false, &a));
        // 模式被替换（增删改任意一项）：重建。
        assert!(baseline_invalidated(&Some(a.clone()), false, &b));
        assert!(baseline_invalidated(&Some(b.clone()), false, &a));
        // 停启等待醒来：即使恢复成同一份模式也重建（停用期间变化不追溯）。
        assert!(baseline_invalidated(&Some(a.clone()), true, &a));
    }
}
