//! 运行日志分级落盘。
//!
//! 之前 `env_logger` 只写 stderr —— 开发时能看，但打包成 GUI 应用后
//! stderr 无处可去，用户报障时拿不到任何运行信息，只能靠复现。
//!
//! 这里实现一个极小的 `log::Log`：同时输出到 stderr（开发）和
//! `app_data/logs/vela-YYYYMMDD.log`（生产），按天分文件、保留 7 天。
//!
//! 设计取舍：
//! - 不引 `tauri-plugin-log` / `tracing-subscriber`：需求只是"按天写文件 +
//!   清理旧文件"，自己实现约 100 行，避免新增依赖树。
//! - 单个 `Mutex<Option<File>>` 保护写入。日志频率是每秒个位数级别，
//!   锁竞争可忽略；换成无锁通道反而要多一个后台线程。
//! - 日期变更时自动换文件（跨零点运行的场景）。
//! - 任何 IO 失败都静默降级为"只写 stderr"，日志系统本身绝不能让应用崩溃。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 日志文件保留天数。超过的自动删除，避免长期运行占满磁盘。
const RETAIN_DAYS: i64 = 7;

/// 单条日志的最大长度。异常堆栈可能极长，截断避免单行撑爆文件。
const MAX_LINE: usize = 4096;

struct FileSink {
    /// 当前打开的文件与它对应的日期（YYYYMMDD），用于跨零点换文件。
    current: Option<(String, File)>,
    dir: PathBuf,
}

impl FileSink {
    /// 取得当天的文件句柄，日期变化时自动切换。
    fn writer(&mut self, today: &str) -> Option<&mut File> {
        let need_open = match &self.current {
            Some((day, _)) => day != today,
            None => true,
        };
        if need_open {
            let path = self.dir.join(format!("vela-{today}.log"));
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok()?;
            self.current = Some((today.to_string(), file));
        }
        self.current.as_mut().map(|(_, f)| f)
    }
}

pub struct Logger {
    level: log::LevelFilter,
    sink: Mutex<Option<FileSink>>,
}

impl log::Log for Logger {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let now = chrono::Local::now();
        let mut msg = format!(
            "{} {:<5} [{}] {}",
            now.format("%Y-%m-%d %H:%M:%S%.3f"),
            record.level(),
            record.target(),
            record.args()
        );
        if msg.len() > MAX_LINE {
            // 按字符边界截断，避免在多字节 UTF-8 序列中间切断。
            let cut = msg
                .char_indices()
                .take_while(|(i, _)| *i < MAX_LINE)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            msg.truncate(cut);
            msg.push_str(" …[truncated]");
        }

        // stderr：开发期直接可见。
        eprintln!("{msg}");

        // 文件：生产期唯一可回溯的记录。：Mutex 一旦中毒若静默
        // 跳过，文件日志会永久关闭且无任何提示——改为恢复守卫继续写。
        let mut guard = match self.sink.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(sink) = guard.as_mut() {
            let today = now.format("%Y%m%d").to_string();
            if let Some(f) = sink.writer(&today) {
                // 写失败（磁盘满 / 文件被占用）时静默忽略，stderr 仍有输出。
                let _ = writeln!(f, "{msg}");
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(sink) = guard.as_mut() {
                if let Some((_, f)) = sink.current.as_mut() {
                    let _ = f.flush();
                }
            }
        }
    }
}

/// 删除超过保留期的日志文件。返回删除数量（供测试断言）。
pub fn prune_old_logs(dir: &Path, retain_days: i64) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let cutoff = chrono::Local::now().date_naive() - chrono::Duration::days(retain_days);
    let mut removed = 0u32;
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // 只处理自己产生的文件，绝不误删目录里的其他内容。
        let Some(day) = name
            .strip_prefix("vela-")
            .and_then(|s| s.strip_suffix(".log"))
        else {
            continue;
        };
        let Ok(date) = chrono::NaiveDate::parse_from_str(day, "%Y%m%d") else {
            continue;
        };
        if date < cutoff && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 解析日志级别：优先读 `VELA_LOG` / `RUST_LOG` 环境变量，默认 info。
fn resolve_level() -> log::LevelFilter {
    let raw = std::env::var("VELA_LOG")
        .or_else(|_| std::env::var("RUST_LOG"))
        .unwrap_or_default();
    match raw.trim().to_ascii_lowercase().as_str() {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "warn" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        "off" => log::LevelFilter::Off,
        _ => log::LevelFilter::Info,
    }
}

/// 初始化日志系统。`log_dir` 为 None 时只写 stderr（早于 AppHandle 可用的阶段）。
///
/// 重复调用是安全的：`set_boxed_logger` 第二次会返回 Err，直接忽略。
pub fn init(log_dir: Option<PathBuf>) {
    let level = resolve_level();
    let sink = log_dir.and_then(|dir| {
        fs::create_dir_all(&dir).ok()?;
        // 启动时清理一次即可：应用通常不会连续运行数周。
        prune_old_logs(&dir, RETAIN_DAYS);
        Some(FileSink { current: None, dir })
    });
    let logger = Logger {
        level,
        sink: Mutex::new(sink),
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(level);
    }
}

/* ================================================================== *
 * §4.9 崩溃计数（第一步：只计数，不自重启）。
 *
 * Rust panic（panic hook）与前端异常（crash-log.ts 经 report_frontend_crash
 * 汇聚）统一落到 `<app_data>/crash-log.json`（logs 目录旁）；设置页诊断区
 * 展示「近 7 天崩溃 N 次 + 最近 panic 摘要」。数据先于机制：崩溃频率有
 * 数据支撑后再决定是否做第二步（自重启 + 5 分钟窗口防循环）。
 *
 * 文件是一个 JSON 数组，写入 tmp+rename 原子替换；损坏文件视为空并被
 * 覆盖——崩溃计数丢失可接受，绝不能反过来阻塞启动或在 hook 里再 panic。
 * ------------------------------------------------------------------ */

/// 崩溃记录文件名（放在 `<app_data>` 根，与 `logs/` 目录并列）。
pub const CRASH_FILE_NAME: &str = "crash-log.json";
/// 记录保留天数（统计窗口是 7 天，多留一段供回看趋势）。
const CRASH_RETAIN_DAYS: i64 = 30;
/// 记录条数上限（崩溃循环时防止文件无界增长）。
const CRASH_MAX_ENTRIES: usize = 200;
/// 单条摘要最大字符数。
const CRASH_SUMMARY_MAX: usize = 600;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    /// UTC 毫秒。
    pub ts: i64,
    /// "panic"（Rust）| "frontend"（WebView 错误边界 / 全局异常）。
    pub kind: String,
    /// 来源：`thread:<name>` 或 `<窗口 label>:<小组件实例 / global>`。
    pub source: String,
    /// 一行摘要（payload + 位置），≤ CRASH_SUMMARY_MAX 字符。
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashStats {
    pub count_7d: u32,
    pub total: u32,
    pub latest: Option<CrashRecord>,
    pub latest_panic: Option<CrashRecord>,
    /// 最近若干条（新→旧，含 panic 与 frontend）：诊断区列表展示用——此前
    /// 只给 latest / latestPanic 各一条，排查连续崩溃看不到脉络。
    pub recent: Vec<CrashRecord>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 按字符边界截断（不在多字节 UTF-8 中间切断）。
pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 读取全部记录；文件缺失 / 损坏一律视为空。
pub fn load_crashes(path: &Path) -> Vec<CrashRecord> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<CrashRecord>>(&raw).unwrap_or_default()
}

/// 保留策略：丢弃超过保留天数的记录，按时间排序，超量时丢最旧。
pub fn prune_crashes(mut all: Vec<CrashRecord>, now: i64) -> Vec<CrashRecord> {
    let cutoff = now - CRASH_RETAIN_DAYS * DAY_MS;
    all.retain(|r| r.ts >= cutoff);
    all.sort_by_key(|r| r.ts);
    if all.len() > CRASH_MAX_ENTRIES {
        let excess = all.len() - CRASH_MAX_ENTRIES;
        all.drain(..excess);
    }
    all
}

/// 崩溃记录的进程级写锁：panic hook（任意线程直达）与前端崩溃上报
/// （spawn_blocking）可能并发进入 record_crash 的读-改-写；无锁时两路读到
/// 同一基线各丢一条，且共写固定名 tmp 再竞速 rename 会拼出损坏的 JSON。
static CRASH_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 追加一条记录并按保留策略修剪后原子写回。
pub fn record_crash(path: &Path, rec: CrashRecord, now: i64) -> Result<(), String> {
    let _guard = CRASH_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut all = load_crashes(path);
    all.push(rec);
    let all = prune_crashes(all, now);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建崩溃记录目录失败: {e}"))?;
    }
    let json = serde_json::to_string(&all).map_err(|e| format!("序列化崩溃记录失败: {e}"))?;
    // tmp 名带 pid + 单调计数：同进程多路写也不会互踩 tmp（rename 对象被
    // 对方写一半的文件）。锁内理论上串行，双保险防未来新增调用点。
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{}.tmp", std::process::id(), seq));
    // 对齐 storage_util::write_text_atomic 的 create→write→sync→
    // rename 链（与 backup.rs 的 同款）——fs::write + rename 之间字节
    // 可能仍躺在 OS 缓冲，掉电/崩溃会留下「已改名但内容截断」的崩溃日志。
    // tmp 命名不并轨 write_text_atomic 的 `.stem.tmp-pid`：这里保留 pid+seq
    // （上方并发双保险），write_text_atomic 的 cleanup_tmp_siblings 也就
    // 不会误删我们的 tmp。
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| format!("写入崩溃记录失败: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("写入崩溃记录失败: {e}"))?;
        f.sync_all().map_err(|e| format!("写入崩溃记录失败: {e}"))?;
    }
    let renamed = fs::rename(&tmp, path);
    if renamed.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    renamed.map_err(|e| format!("替换崩溃记录失败: {e}"))
}

/// 诊断区统计：近 7 天次数 / 累计 / 最近一条 / 最近一次 panic / 最近数条。
pub fn crash_stats(records: &[CrashRecord], now: i64) -> CrashStats {
    let cutoff = now - 7 * DAY_MS;
    let count_7d = records.iter().filter(|r| r.ts >= cutoff).count() as u32;
    let latest = records.iter().max_by_key(|r| r.ts).cloned();
    let latest_panic = records
        .iter()
        .filter(|r| r.kind == "panic")
        .max_by_key(|r| r.ts)
        .cloned();
    let mut recent: Vec<CrashRecord> = records.to_vec();
    recent.sort_by_key(|b| std::cmp::Reverse(b.ts));
    recent.truncate(5);
    CrashStats {
        count_7d,
        total: records.len() as u32,
        latest,
        latest_panic,
        recent,
    }
}

/// 清空崩溃记录（诊断区「清空」入口）：写回空数组。与 record_crash 同锁，
/// 防止与 panic hook / 前端上报的读-改-写交错把清掉的记录又写回来。
/// 单次小写入，中断最坏留下截断文件——load_crashes 解析失败视为空，等效。
pub fn clear_crashes(path: &Path) -> Result<(), String> {
    let _guard = CRASH_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    fs::write(path, b"[]").map_err(|e| format!("清空崩溃记录失败: {e}"))
}

/// panic 摘要：payload + `@ file:line:col`，截断到上限。
pub fn format_panic_summary(payload: &str, location: Option<&str>) -> String {
    let mut s = payload.trim().to_string();
    if s.is_empty() {
        s.push_str("(no message)");
    }
    if let Some(loc) = location {
        s.push_str(" @ ");
        s.push_str(loc);
    }
    truncate_chars(&s, CRASH_SUMMARY_MAX)
}

/// 安装 panic hook：先记录（日志 + 崩溃文件），再链式调用原 hook（保留
/// 默认 stderr 输出与 backtrace）。`crash_file` 为 None 时只写日志。
///
/// hook 内绝不能再 panic（panic-in-hook 直接 abort），因此整段包在
/// catch_unwind 里，IO 失败只 eprintln。
pub fn install_panic_hook(crash_file: Option<PathBuf>) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_string());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
            let thread = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let summary = format_panic_summary(&payload, location.as_deref());
            log::error!("panic in thread '{thread}': {summary}");
            // 崩溃记录先落盘：后面的任务栏还原可能被锁阻塞（见下），不能让
            // 它挡住最关键的一笔。
            if let Some(path) = &crash_file {
                let rec = CrashRecord {
                    ts: now_ms(),
                    kind: "panic".to_string(),
                    source: format!("thread:{thread}"),
                    summary,
                };
                if let Err(e) = record_crash(path, rec, now_ms()) {
                    eprintln!("crash record write failed: {e}");
                }
            }
            // 恢复线 2：best-effort 通知 DLL 恢复任务栏——但只在主线程
            // panic 时做。panic hook 在 unwind 之前触发，catch_unwind 拦不住它：
            // 后台采样/FFI 线程里那些被兜住、进程照常运行的 panic 也会走到这里，
            // 若无条件 restore_all() 就会把用户开启的任务栏定制静默拆掉（终态，
            // 无自动恢复）。只有主线程 panic 会带走整个进程，此时才值得还原。
            // 另起线程 + 限时等待：restore_all 内部要拿引擎锁，若 panic 恰发生在
            // 持锁临界区，同线程再加锁会把 panic 变成永久挂死。超时或强杀场景
            // 由注入 DLL 的主进程句柄监视线程（parent_watch）兜底。
            if thread == "main" {
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                let spawned = std::thread::Builder::new()
                    .name("vela-panic-restore".to_string())
                    .spawn(move || {
                        // 恢复动作经依赖注入（set_panic_restore 注册），
                        // logging 保持零业务依赖；未注册则无事可做。
                        if let Some(cb) = PANIC_RESTORE
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .take()
                        {
                            cb();
                        }
                        let _ = tx.send(());
                    });
                if spawned.is_ok() {
                    let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
                }
            }
        }));
        prev(info);
    }));
}

/// 主线程 panic 时的任务栏还原回调（依赖注入：由 lib.rs setup 注册
/// taskbar::restore_all，logging 自身不再反向依赖业务模块）。只执行一次
/// （take）——进程马上就要终止。
static PANIC_RESTORE: std::sync::Mutex<Option<fn()>> = std::sync::Mutex::new(None);

/// 注册主线程 panic 的恢复动作（进程生命期一次）。
pub fn set_panic_restore(cb: fn()) {
    *PANIC_RESTORE.lock().unwrap_or_else(|p| p.into_inner()) = Some(cb);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vela-log-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn prune_removes_only_expired_vela_logs() {
        let dir = tmp_dir("prune");
        let today = chrono::Local::now().date_naive();
        let old = (today - chrono::Duration::days(30))
            .format("%Y%m%d")
            .to_string();
        let recent = (today - chrono::Duration::days(2))
            .format("%Y%m%d")
            .to_string();

        fs::write(dir.join(format!("vela-{old}.log")), b"old").unwrap();
        fs::write(dir.join(format!("vela-{recent}.log")), b"recent").unwrap();
        // 非本系统产生的文件必须保留。
        fs::write(dir.join("important.txt"), b"keep me").unwrap();
        fs::write(dir.join("vela-notadate.log"), b"keep me too").unwrap();

        let removed = prune_old_logs(&dir, 7);
        assert_eq!(removed, 1, "只应删除 30 天前的那一个");
        assert!(!dir.join(format!("vela-{old}.log")).exists());
        assert!(dir.join(format!("vela-{recent}.log")).exists());
        assert!(dir.join("important.txt").exists());
        assert!(dir.join("vela-notadate.log").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_on_missing_dir_is_noop() {
        // 目录不存在时不该 panic。
        assert_eq!(prune_old_logs(Path::new("Z:/definitely/not/here"), 7), 0);
    }

    #[test]
    fn file_sink_writes_and_rotates_by_date() {
        let dir = tmp_dir("rotate");
        let mut sink = FileSink {
            current: None,
            dir: dir.clone(),
        };

        writeln!(sink.writer("20260101").unwrap(), "day one").unwrap();
        writeln!(sink.writer("20260101").unwrap(), "day one again").unwrap();
        writeln!(sink.writer("20260102").unwrap(), "day two").unwrap();
        sink.current.as_mut().unwrap().1.flush().unwrap();

        let d1 = fs::read_to_string(dir.join("vela-20260101.log")).unwrap();
        let d2 = fs::read_to_string(dir.join("vela-20260102.log")).unwrap();
        // 同一天追加进同一文件，跨天自动换新文件。
        assert!(d1.contains("day one") && d1.contains("day one again"));
        assert!(d2.contains("day two"));
        assert!(!d2.contains("day one"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_level_defaults_to_info() {
        // 未设置环境变量时（CI 常态）应为 info。
        if std::env::var("VELA_LOG").is_err() && std::env::var("RUST_LOG").is_err() {
            assert_eq!(resolve_level(), log::LevelFilter::Info);
        }
    }

    /* ---- §4.9 崩溃计数 ---- */

    fn rec(ts: i64, kind: &str, summary: &str) -> CrashRecord {
        CrashRecord {
            ts,
            kind: kind.to_string(),
            source: "test".to_string(),
            summary: summary.to_string(),
        }
    }

    #[test]
    fn crash_record_roundtrip_prunes_by_age_and_cap() {
        let dir = tmp_dir("crash-rt");
        let path = dir.join(CRASH_FILE_NAME);
        let now = 100 * DAY_MS;
        // 40 天前的记录写入即被修剪；近期两条保留且按 ts 排序。
        record_crash(&path, rec(now - 40 * DAY_MS, "panic", "ancient"), now).unwrap();
        record_crash(&path, rec(now - 2 * DAY_MS, "frontend", "two days"), now).unwrap();
        record_crash(&path, rec(now - 10 * DAY_MS, "panic", "ten days"), now).unwrap();
        let all = load_crashes(&path);
        assert_eq!(
            all.iter().map(|r| r.summary.as_str()).collect::<Vec<_>>(),
            vec!["ten days", "two days"]
        );
        // 条数上限：塞 210 条只留最新 200 条。
        let mut many: Vec<CrashRecord> = (0..210).map(|i| rec(now - i, "frontend", "x")).collect();
        many.reverse();
        let pruned = prune_crashes(many, now);
        assert_eq!(pruned.len(), CRASH_MAX_ENTRIES);
        assert_eq!(pruned.last().unwrap().ts, now, "保留的是最新的");
        assert_eq!(pruned.first().unwrap().ts, now - 199);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_stats_counts_seven_day_window_and_latest_panic() {
        let now = 100 * DAY_MS;
        let recs = vec![
            rec(now - 20 * DAY_MS, "panic", "old panic"),
            rec(now - 6 * DAY_MS, "frontend", "recent fe"),
            rec(now - DAY_MS, "panic", "recent panic"),
            rec(now - 1000, "frontend", "newest fe"),
        ];
        let s = crash_stats(&recs, now);
        assert_eq!(s.count_7d, 3);
        assert_eq!(s.total, 4);
        assert_eq!(s.latest.unwrap().summary, "newest fe");
        assert_eq!(s.latest_panic.unwrap().summary, "recent panic");
        // recent 新→旧、混合 panic / frontend。
        assert_eq!(
            s.recent
                .iter()
                .map(|r| r.summary.as_str())
                .collect::<Vec<_>>(),
            vec!["newest fe", "recent panic", "recent fe", "old panic"]
        );
        // 无 panic 时 latest_panic 为 None。
        let s2 = crash_stats(&[rec(now, "frontend", "fe")], now);
        assert!(s2.latest_panic.is_none());
        assert_eq!(s2.count_7d, 1);
        // 空表全零。
        let s3 = crash_stats(&[], now);
        assert_eq!((s3.count_7d, s3.total), (0, 0));
        assert!(s3.latest.is_none());
        assert!(s3.recent.is_empty());
        // recent 截断到 5 条（最旧的丢）。
        let many: Vec<CrashRecord> = (0..8)
            .map(|i| rec(now - i, "frontend", format!("r{i}").as_str()))
            .collect();
        assert_eq!(crash_stats(&many, now).recent.len(), 5);
        assert_eq!(crash_stats(&many, now).recent[0].summary, "r0");
        assert_eq!(crash_stats(&many, now).recent[4].summary, "r4");
    }

    #[test]
    fn clear_crashes_empties_file_and_returns_empty_stats() {
        let dir = tmp_dir("crash-clear");
        let path = dir.join(CRASH_FILE_NAME);
        let now = 100 * DAY_MS;
        record_crash(&path, rec(now, "panic", "a"), now).unwrap();
        record_crash(&path, rec(now - 1, "frontend", "b"), now).unwrap();
        clear_crashes(&path).unwrap();
        assert!(load_crashes(&path).is_empty());
        // 清空后文件仍在（内容为空数组），后续 record 正常追加。
        record_crash(&path, rec(now, "panic", "c"), now).unwrap();
        let all = load_crashes(&path);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].summary, "c");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_crash_file_is_treated_as_empty_and_overwritten() {
        let dir = tmp_dir("crash-corrupt");
        let path = dir.join(CRASH_FILE_NAME);
        fs::write(&path, b"{ not json").unwrap();
        assert!(load_crashes(&path).is_empty());
        record_crash(&path, rec(5, "panic", "after corrupt"), 10).unwrap();
        let all = load_crashes(&path);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].summary, "after corrupt");
        // 缺失文件同样为空、不报错。
        assert!(load_crashes(&dir.join("missing.json")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn panic_summary_formats_and_truncates() {
        assert_eq!(
            format_panic_summary("boom", Some("src/x.rs:1:2")),
            "boom @ src/x.rs:1:2"
        );
        assert_eq!(format_panic_summary("   ", None), "(no message)");
        let long = "é".repeat(CRASH_SUMMARY_MAX + 50);
        let out = format_panic_summary(&long, None);
        assert_eq!(out.chars().count(), CRASH_SUMMARY_MAX + 1, "上限 + 省略号");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn panic_hook_records_panic_and_chains_previous() {
        let dir = tmp_dir("crash-hook");
        let path = dir.join(CRASH_FILE_NAME);
        install_panic_hook(Some(path.clone()));
        let marker = format!("vela-test-panic-{}", std::process::id());
        let m2 = marker.clone();
        let r = std::panic::catch_unwind(move || panic!("{m2}"));
        assert!(r.is_err());
        let all = load_crashes(&path);
        let hit = all
            .iter()
            .find(|r| r.kind == "panic" && r.summary.contains(&marker))
            .expect("panic 应被记录到崩溃文件");
        assert!(
            hit.summary.contains("logging.rs"),
            "摘要应带位置: {}",
            hit.summary
        );
        assert!(hit.source.starts_with("thread:"));
        let _ = fs::remove_dir_all(&dir);
    }
}
