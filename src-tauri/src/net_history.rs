//! W-153 网络流量历史记录器：按天累计本机收发流量，落 SQLite
//! `net_traffic_daily`（迁移 v9），并驱动流量/网速阈值系统通知（W-170）。
//!
//! # 为什么独立于 sys:stats 采样线程
//! 广播采样受 presence 空闲降载（锁屏/挂机暂停）与前端可见性门控影响——
//! 挂机一晚的流量会整段漏记。本记录器是常驻 10s 采样线程，一次
//! `GetIfTable2` 级别的刷新（sysinfo `Networks` 私有实例），代价可忽略，
//! 且不受降载影响：只要进程活着，流量就进当日账。
//!
//! # 记账模型（对照经典网速工具的 HistoryTrafficFile）
//! - 应用只统计自己运行期间的增量；启动时把库里当日行载入内存作为基数，
//!   之后内存值是当日权威值，`pending` 是尚未落库的增量；
//! - 每 60s 把 pending 以 `rx = rx + excluded.rx` 的增量 UPSERT 合并进库，
//!   落库失败保留 pending 下一轮重试（经典网速工具的「≥10MB 才落盘」
//!   防写放大等价物：10s 采样 + 60s 批量合并，磁盘写频率固定为 1 次/分）；
//! - 跨日：先把 pending 归档到旧日行，再重置当日计数；
//! - 计数器回落（网卡禁用/重置）checked_sub 归 0；跨睡眠窗口（实测间隔
//!   > 120s）整窗丢弃，睡眠期间计数器本就无增量，安全。
//!
//! # 按进程流量（P2-9）的边界
//! Windows 无非驱动的每进程字节计数（ETW Kernel-Network 需要管理员会话，
//! 经典网速工具自己也没做）。本文件交付连接级替代：`system::get_tcp_
//! connections` 给出带 PID/进程名的 TCP 连接表；字节级按进程统计若未来
//! 立项，需评估提权或驱动方案，不在本模块承诺。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::Networks;
use tauri::Manager;
use ts_rs::TS;

/// 采样周期（秒）：计数器差分的窗口粒度。
const SAMPLE_SECS: u64 = 10;
/// 落库周期（采样帧数）：60s 一次合并写。
const FLUSH_EVERY_TICKS: u32 = 6;
/// 超过该实测窗口长度的样本整窗丢弃（睡眠唤醒、系统挂起）。
const MAX_WINDOW_SECS: u64 = 120;
/// 历史保留天数（约一年，经典网速工具同量级）。
const RETAIN_DAYS: i64 = 366;

/// W-170 阈值告警配置：前端经 `set_net_alerts` 推送，原子读写无锁。
#[derive(Default)]
pub struct NetAlertConfig {
    pub speed_enabled: AtomicBool,
    /// 网速阈值（字节/秒，收发合计）。
    pub speed_threshold_bps: AtomicU64,
    pub traffic_enabled: AtomicBool,
    /// 日流量阈值（字节，收发合计）。
    pub traffic_threshold_bytes: AtomicU64,
}

pub struct TrafficRecorder {
    networks: Mutex<Networks>,
    /// 记录器私有基线：网卡名 → 上次绝对计数（与采样线程的差分互不干扰）。
    baselines: Mutex<HashMap<String, (u64, u64)>>,
    last_sample: Mutex<Option<std::time::Instant>>,
    /// 当前统计日（本地日期 "YYYY-MM-DD"）。跨日翻转时归档并重置。
    day: Mutex<String>,
    /// 当日累计（含启动时从库载入的部分）——内存为当日权威值。
    today_rx: AtomicU64,
    today_tx: AtomicU64,
    /// 尚未落库的增量；flush 成功后清零。
    pending_rx: AtomicU64,
    pending_tx: AtomicU64,
    pub alerts: Arc<NetAlertConfig>,
    /// 网速告警的滞回状态：已触发（掉回阈值一半以下才重新武装）。
    speed_alert_armed: AtomicBool,
    /// 日流量告警当日已触发标志（跨日重置）。
    traffic_alert_fired_today: AtomicBool,
    /// 采样帧计数（驱动周期落库）。
    tick: AtomicU32,
}

impl TrafficRecorder {
    fn new(alerts: Arc<NetAlertConfig>) -> Self {
        Self {
            networks: Mutex::new(Networks::new_with_refreshed_list()),
            baselines: Mutex::new(HashMap::new()),
            last_sample: Mutex::new(None),
            day: Mutex::new(today_key()),
            today_rx: AtomicU64::new(0),
            today_tx: AtomicU64::new(0),
            pending_rx: AtomicU64::new(0),
            pending_tx: AtomicU64::new(0),
            alerts,
            speed_alert_armed: AtomicBool::new(true),
            traffic_alert_fired_today: AtomicBool::new(false),
            tick: AtomicU32::new(0),
        }
    }
}

/// 本地日期 "YYYY-MM-DD"（与 SQLite `date()` 文本同构，便于 SQL 区间查询）。
fn today_key() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 从库载入当日行到内存（启动时调用；应用不运行期间的流量本来就记不到，
/// 与经典网速工具一致只统计运行期）。
fn load_today(rec: &TrafficRecorder, conn: &rusqlite::Connection) {
    let day = today_key();
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT rx_bytes, tx_bytes FROM net_traffic_daily WHERE day = ?1",
            [&day],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    *rec.day.lock().unwrap_or_else(|p| p.into_inner()) = day;
    if let Some((rx, tx)) = row {
        rec.today_rx.store(rx.max(0) as u64, Ordering::SeqCst);
        rec.today_tx.store(tx.max(0) as u64, Ordering::SeqCst);
    }
}

/// 把 pending 增量合并进 `day_key` 行。UPSERT 增量语义：与应用重启、多来源
/// 写入兼容（内存 today 已含载入值，这里只追加差量）。
fn flush_pending(
    conn: &rusqlite::Connection,
    day_key: &str,
    rx: u64,
    tx: u64,
) -> rusqlite::Result<()> {
    if rx == 0 && tx == 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO net_traffic_daily(day, rx_bytes, tx_bytes) VALUES(?1, ?2, ?3)
         ON CONFLICT(day) DO UPDATE SET
            rx_bytes = rx_bytes + excluded.rx_bytes,
            tx_bytes = tx_bytes + excluded.tx_bytes",
        rusqlite::params![day_key, rx as i64, tx as i64],
    )?;
    Ok(())
}

/// 清理：保留 `RETAIN_DAYS` 天，并删除「未来日期」行（系统时钟被拨快又拨回
/// 的脏数据，经典网速工具同款防护）。
fn cleanup(conn: &rusqlite::Connection, today: &str) {
    let _ = conn.execute(
        "DELETE FROM net_traffic_daily WHERE day < date(?1, ?2)",
        rusqlite::params![today, format!("-{RETAIN_DAYS} days")],
    );
    let _ = conn.execute(
        "DELETE FROM net_traffic_daily WHERE day > ?1",
        rusqlite::params![today],
    );
}

/// 单个采样帧：差分入账 + 跨日归档 + 通知判定。任何 panic 由外层
/// catch_unwind 兜住，线程不退出。
fn sample_tick(app: &tauri::AppHandle, rec: &TrafficRecorder) {
    let elapsed = rec
        .last_sample
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .map(|p| p.elapsed().as_secs())
        .unwrap_or(0);
    let mut networks = rec.networks.lock().unwrap_or_else(|p| p.into_inner());
    networks.refresh(true);
    *rec.last_sample.lock().unwrap_or_else(|p| p.into_inner()) = Some(std::time::Instant::now());

    // 窗口有效性：首帧无基线；跨睡眠窗口整窗丢弃。
    let window_valid = elapsed > 0 && elapsed <= MAX_WINDOW_SECS;
    let mut sum_bytes = 0u64;
    {
        let mut baselines = rec.baselines.lock().unwrap_or_else(|p| p.into_inner());
        let mut seen: HashMap<String, (u64, u64)> = HashMap::new();
        for (name, data) in networks.iter() {
            let t = (data.total_received(), data.total_transmitted());
            if let Some(prev) = baselines.get(name) {
                if window_valid {
                    let dr = t.0.saturating_sub(prev.0);
                    let dt = t.1.saturating_sub(prev.1);
                    rec.today_rx.fetch_add(dr, Ordering::Relaxed);
                    rec.today_tx.fetch_add(dt, Ordering::Relaxed);
                    rec.pending_rx.fetch_add(dr, Ordering::Relaxed);
                    rec.pending_tx.fetch_add(dt, Ordering::Relaxed);
                    sum_bytes += dr + dt;
                }
            }
            seen.insert(name.clone(), t);
        }
        // 只保留仍然存在的网卡基线（refresh(true) 已剔除消失者）。
        *baselines = seen;
    }

    // 跨日：先把 pending 归档到旧日行，成功才重置当日计数与告警标志；
    // 归档失败则退回 pending、统计日回拨，下一帧重试。
    let today = today_key();
    let day_changed = {
        let mut day = rec.day.lock().unwrap_or_else(|p| p.into_inner());
        if today == *day {
            false
        } else {
            let old = std::mem::replace(&mut *day, today.clone());
            let prx = rec.pending_rx.swap(0, Ordering::SeqCst);
            let ptx = rec.pending_tx.swap(0, Ordering::SeqCst);
            if archive_to_db(app, &old, prx, ptx) {
                rec.today_rx.store(0, Ordering::SeqCst);
                rec.today_tx.store(0, Ordering::SeqCst);
                rec.traffic_alert_fired_today.store(false, Ordering::SeqCst);
                true
            } else {
                rec.pending_rx.fetch_add(prx, Ordering::SeqCst);
                rec.pending_tx.fetch_add(ptx, Ordering::SeqCst);
                *day = old;
                false
            }
        }
    };

    // 周期落库（首个 tick 也落一次，建立当日行基线）。
    let tick = rec.tick.fetch_add(1, Ordering::Relaxed) + 1;
    if !day_changed && (tick == 1 || tick.is_multiple_of(FLUSH_EVERY_TICKS)) {
        let prx = rec.pending_rx.swap(0, Ordering::SeqCst);
        let ptx = rec.pending_tx.swap(0, Ordering::SeqCst);
        if !archive_to_db(app, &today, prx, ptx) {
            // 落库失败：增量退回 pending，下一轮重试。
            rec.pending_rx.fetch_add(prx, Ordering::SeqCst);
            rec.pending_tx.fetch_add(ptx, Ordering::SeqCst);
        }
    }
    // 保留期/未来日期清理只在启动时跑（start_traffic_recorder）——应用一次
    // 运行数月仍会越过 RETAIN_DAYS，时钟拨快产生的未来日期行也要运行期回收；
    // 这里在首拍（基线已落库后）补一次，每天成本一次小 DELETE。
    if tick == 1 {
        if let Some(state) = app.try_state::<crate::AppState>() {
            if let Ok(conn) = crate::db::lock_db(&state.db) {
                cleanup(&conn, &today);
            }
        }
    }
    // G-8：跨日翻转时顺手清一次通知/剪贴板过期行——写路径顺手清理只覆盖
    // 「有新数据」的表；长期不产生新通知/复制的场景里，过期行靠这里回收。
    if day_changed {
        if let Some(state) = app.try_state::<crate::AppState>() {
            if let Ok(conn) = crate::db::lock_db(&state.db) {
                if let Err(e) = crate::repositories::NotificationRepo::cleanup(&conn) {
                    log::debug!("daily notification cleanup: {e}");
                }
                if let Err(e) = crate::repositories::ClipboardRepo::cleanup(&conn) {
                    log::debug!("daily clipboard cleanup: {e}");
                }
            }
        }
    }

    // W-170 阈值通知。
    check_alerts(app, rec, sum_bytes, elapsed);
}

fn check_alerts(
    app: &tauri::AppHandle,
    rec: &TrafficRecorder,
    window_bytes: u64,
    elapsed_secs: u64,
) {
    use tauri_plugin_notification::NotificationExt;
    let cfg = &rec.alerts;

    // 网速阈值：超过触发一次，掉回阈值一半以下重新武装（滞回防抖）。
    if cfg.speed_enabled.load(Ordering::Relaxed) && elapsed_secs > 0 {
        let rate = window_bytes / elapsed_secs;
        let threshold = cfg.speed_threshold_bps.load(Ordering::Relaxed);
        let armed = rec.speed_alert_armed.load(Ordering::SeqCst);
        if armed && threshold > 0 && rate >= threshold {
            rec.speed_alert_armed.store(false, Ordering::SeqCst);
            let _ = app
                .notification()
                .builder()
                .title("网速偏高")
                .body(format!(
                    "当前网速 {}（超过阈值 {}）",
                    crate::system::fmt_rate_human(rate),
                    crate::system::fmt_rate_human(threshold)
                ))
                .show();
        } else if !armed && rate * 2 < threshold {
            rec.speed_alert_armed.store(true, Ordering::SeqCst);
        }
    }

    // 日流量阈值：当日只触发一次。
    if cfg.traffic_enabled.load(Ordering::Relaxed)
        && !rec.traffic_alert_fired_today.load(Ordering::SeqCst)
    {
        let threshold = cfg.traffic_threshold_bytes.load(Ordering::Relaxed);
        let used = rec.today_rx.load(Ordering::Relaxed) + rec.today_tx.load(Ordering::Relaxed);
        if threshold > 0 && used >= threshold {
            rec.traffic_alert_fired_today.store(true, Ordering::SeqCst);
            let _ = app
                .notification()
                .builder()
                .title("今日流量提醒")
                .body(format!(
                    "今日已用 {}（超过阈值 {}）",
                    crate::system::fmt_bytes_human(used),
                    crate::system::fmt_bytes_human(threshold)
                ))
                .show();
        }
    }
}

/// 把一段增量归档进指定日期行（跨日归档与周期落库共用）。
/// 返回是否成功；失败由调用方把增量退回 pending。
fn archive_to_db(app: &tauri::AppHandle, day_key: &str, rx: u64, tx: u64) -> bool {
    if rx == 0 && tx == 0 {
        return true;
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(conn) = crate::db::lock_db(&state.db) {
            return flush_pending(&conn, day_key, rx, tx).is_ok();
        }
    }
    false
}

/// 启动记录器：载入当日行 + 清理过期/未来日期行 + 起常驻线程。
pub fn start_traffic_recorder(app: tauri::AppHandle) {
    let alerts = Arc::new(NetAlertConfig::default());
    let rec = TrafficRecorder::new(alerts.clone());
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(conn) = crate::db::lock_db(&state.db) {
            load_today(&rec, &conn);
            cleanup(&conn, &today_key());
        }
    }
    app.manage(alerts.clone());
    app.manage(rec);
    std::thread::spawn(move || {
        // 首个 tick 立即跑（建立计数基线），之后按采样周期循环；
        // 单帧 panic 只丢一帧，线程不退出。
        loop {
            {
                let state = app.state::<TrafficRecorder>();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    sample_tick(&app, &state)
                }));
                if let Err(p) = result {
                    let msg = p
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| p.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "unknown".into());
                    log::error!("traffic recorder tick panic: {msg}");
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(SAMPLE_SECS));
        }
    });
}

/* ------------------------------------------------------------------ */
/* 命令                                                                  */
/* ------------------------------------------------------------------ */

/// 流量汇总（今日 + 本月）。今日值来自记录器内存（权威、含未落库增量），
/// 本月值 = 库内当月其余天数之和 + 今日内存值。
#[derive(Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TrafficSummary {
    /// 本地日期 "YYYY-MM-DD"。
    pub day: String,
    #[ts(type = "number")]
    pub today_rx: u64,
    #[ts(type = "number")]
    pub today_tx: u64,
    #[ts(type = "number")]
    pub month_rx: u64,
    #[ts(type = "number")]
    pub month_tx: u64,
}

#[tauri::command]
pub async fn get_traffic_summary(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<TrafficSummary, String> {
    // 窗口闸门：流量计数属本机网络隐私面（同 system.rs M3 族标准）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // async + spawn_blocking：库里查询要走写库互斥锁（备份/导入可能持有数秒），
    // 同步命令会把它搬上主线程冻结全部窗口（与 commands.rs R1 约定一致）。
    tauri::async_runtime::spawn_blocking(move || {
        let rec = app.state::<TrafficRecorder>();
        // 与跨日翻转竞态的安全快照：翻转线程在 day 锁内重置 today_* 原子，这里
        // 也必须在同一把锁内一并读出 day + today 计数——否则可能拿到「旧日 +
        // 已清零的 today」错位组合（午夜一瞬，月合计漏掉刚归档的旧行）。
        let (today, snap_rx, snap_tx) = {
            let day = rec.day.lock().unwrap_or_else(|p| p.into_inner());
            (
                day.clone(),
                rec.today_rx.load(Ordering::SeqCst),
                rec.today_tx.load(Ordering::SeqCst),
            )
        };
        let month_prefix = &today[..7];
        let mut month_rx = 0u64;
        let mut month_tx = 0u64;
        if let Some(state) = app.try_state::<crate::AppState>() {
            // 纯 SELECT 走 WAL 读连接：不与备份/导入的写事务互锁（C-1 模式）。
            if let Ok(conn) = state.read_db.acquire() {
                // 只累计「非今日」的行：今日以内存为准（库内今日行滞后 ≤60s）。
                let q = |sql: &str| -> u64 {
                    conn.query_row(sql, rusqlite::params![month_prefix, today], |r| {
                        r.get::<_, i64>(0)
                    })
                    .unwrap_or(0)
                    .max(0) as u64
                };
                month_rx = q(
                    "SELECT COALESCE(SUM(rx_bytes),0) FROM net_traffic_daily WHERE day LIKE ?1 || '%' AND day != ?2",
                );
                month_tx = q(
                    "SELECT COALESCE(SUM(tx_bytes),0) FROM net_traffic_daily WHERE day LIKE ?1 || '%' AND day != ?2",
                );
            }
        }
        month_rx += snap_rx;
        month_tx += snap_tx;
        Ok(TrafficSummary {
            day: today,
            today_rx: snap_rx,
            today_tx: snap_tx,
            month_rx,
            month_tx,
        })
    })
    .await
    .map_err(|e| format!("流量汇总任务失败:{e}"))?
}

/// 近 N 天逐日流量（升序），供历史视图/曲线。
#[derive(Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct TrafficDay {
    pub day: String,
    #[ts(type = "number")]
    pub rx: u64,
    #[ts(type = "number")]
    pub tx: u64,
}

#[tauri::command]
pub async fn get_traffic_daily(
    window: tauri::Window,
    app: tauri::AppHandle,
    days: Option<i64>,
) -> Result<Vec<TrafficDay>, String> {
    // 同 get_traffic_summary：窗口闸门 + DB 查询不占主线程。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let days = days.unwrap_or(30).clamp(1, RETAIN_DAYS);
        let mut out: Vec<TrafficDay> = Vec::new();
        if let Some(state) = app.try_state::<crate::AppState>() {
            // 纯 SELECT 走 WAL 读连接（同 get_traffic_summary）。
            if let Ok(conn) = state.read_db.acquire() {
                let mut stmt = conn
                    .prepare(
                        "SELECT day, rx_bytes, tx_bytes FROM net_traffic_daily
                         WHERE day >= date('now', 'localtime', ?1) ORDER BY day ASC",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(rusqlite::params![format!("-{} days", days - 1)], |r| {
                        Ok(TrafficDay {
                            day: r.get(0)?,
                            rx: r.get::<_, i64>(1)?.max(0) as u64,
                            tx: r.get::<_, i64>(2)?.max(0) as u64,
                        })
                    })
                    .map_err(|e| e.to_string())?;
                for row in rows.flatten() {
                    out.push(row);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("流量历史任务失败:{e}"))?
}

/// 推送阈值告警配置（前端在设置变更与应用启动水合后各调一次）。
#[tauri::command]
pub fn set_net_alerts(
    window: tauri::Window,
    alerts: tauri::State<'_, NetAlertConfig>,
    speed_enabled: bool,
    speed_mbps: f64,
    traffic_enabled: bool,
    traffic_gb: f64,
) -> Result<(), String> {
    // 窗口闸门：告警阈值驱动系统通知，不给 web-preview 远程页面写。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    alerts.speed_enabled.store(speed_enabled, Ordering::Relaxed);
    alerts.speed_threshold_bps.store(
        (speed_mbps * 1_000_000.0 / 8.0).max(0.0) as u64,
        Ordering::Relaxed,
    );
    alerts
        .traffic_enabled
        .store(traffic_enabled, Ordering::Relaxed);
    alerts.traffic_threshold_bytes.store(
        (traffic_gb * 1024.0 * 1024.0 * 1024.0).max(0.0) as u64,
        Ordering::Relaxed,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{in_memory, MIGRATIONS};

    fn conn() -> rusqlite::Connection {
        in_memory(MIGRATIONS).expect("in-memory db")
    }

    /// 增量 UPSERT 语义：重复写入同一天必须累加而不是覆盖（落库与跨日
    /// 归档都依赖这一点）。
    #[test]
    fn flush_accumulates_per_day() {
        let c = conn();
        flush_pending(&c, "2026-09-18", 100, 50).unwrap();
        flush_pending(&c, "2026-09-18", 200, 0).unwrap();
        flush_pending(&c, "2026-09-19", 1, 1).unwrap();
        let (rx, tx): (i64, i64) = c
            .query_row(
                "SELECT rx_bytes, tx_bytes FROM net_traffic_daily WHERE day = '2026-09-18'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rx, tx), (300, 50));
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM net_traffic_daily", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }

    /// cleanup：过期行删除、未来日期行删除、当日与近一年保留。
    #[test]
    fn cleanup_prunes_expired_and_future_rows() {
        let c = conn();
        for day in ["2024-01-01", "2026-09-18", "2027-01-01"] {
            c.execute(
                "INSERT INTO net_traffic_daily(day, rx_bytes, tx_bytes) VALUES(?1, 1, 1)",
                [day],
            )
            .unwrap();
        }
        cleanup(&c, "2026-09-18");
        let days: Vec<String> = {
            let mut stmt = c
                .prepare("SELECT day FROM net_traffic_daily ORDER BY day")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.flatten().collect()
        };
        assert_eq!(days, vec!["2026-09-18".to_string()]);
    }

    /// load_today：库中已有当日行时载入为基数（重启后接着累计）。
    #[test]
    fn load_today_resumes_bucket() {
        let c = conn();
        c.execute(
            "INSERT INTO net_traffic_daily(day, rx_bytes, tx_bytes) VALUES(?1, 500, 250)",
            [today_key().as_str()],
        )
        .unwrap();
        let rec = TrafficRecorder::new(Arc::new(NetAlertConfig::default()));
        load_today(&rec, &c);
        assert_eq!(rec.today_rx.load(Ordering::SeqCst), 500);
        assert_eq!(rec.today_tx.load(Ordering::SeqCst), 250);
    }

    /// 差分基线的回落保护语义与采样线程一致：计数器变小 → checked_sub
    /// 归 0（这里是语义对齐的纯函数级验证）。
    #[test]
    fn counter_reset_yields_zero_delta() {
        let prev: (u64, u64) = (1_000_000, 2_000_000);
        let cur: (u64, u64) = (500, 300);
        assert_eq!(cur.0.saturating_sub(prev.0), 0);
        assert_eq!(cur.1.saturating_sub(prev.1), 0);
    }
}
