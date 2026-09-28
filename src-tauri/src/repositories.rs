//! 行级 SQL 仓储（Repository 模式）：tasks/deadlines/sessions/interruptions
//! 的 CRUD 与聚合查询；写操作在 commands 层包事务。
use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike};
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::db::{DbError, DbResult};
use crate::models::{
    AppData, ClipboardEntry, DailyFocusStat, Deadline, FocusAggregate, HourlyFocusStat,
    ImportResult, NotificationRecord, PomodoroInterruption, PomodoroSession, SettingKV, Task,
};

/// Task repository. Transactions and constraints live here, not in commands.
pub struct TaskRepo;

impl TaskRepo {
    pub fn list(conn: &Connection) -> DbResult<Vec<Task>> {
        let mut stmt = conn.prepare(
            "SELECT id, title, completed, created_at, due_at, priority, tags, sort_order FROM tasks ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                completed: r.get::<_, i64>(2)? != 0,
                created_at: r.get(3)?,
                due_at: r.get(4)?,
                priority: r.get(5)?,
                tags: r.get(6)?,
                sort_order: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn add(
        conn: &Connection,
        title: &str,
        due_at: Option<&str>,
        priority: Option<i64>,
        tags: Option<&str>,
    ) -> DbResult<Task> {
        let id = Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute(
            "INSERT INTO tasks (id, title, completed, created_at, due_at, priority, tags, sort_order) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, 0)",
            params![
                id,
                title,
                created_at,
                due_at.unwrap_or(""),
                priority.unwrap_or(0),
                tags.unwrap_or("[]")
            ],
        )?;
        Ok(Task {
            id,
            title: title.to_string(),
            completed: false,
            created_at,
            due_at: due_at.unwrap_or("").to_string(),
            priority: priority.unwrap_or(0),
            tags: tags.unwrap_or("[]").to_string(),
            sort_order: 0,
        })
    }

    pub fn toggle(conn: &Connection, id: &str) -> DbResult<Option<Task>> {
        conn.execute(
            "UPDATE tasks SET completed = 1 - completed WHERE id = ?1",
            params![id],
        )?;
        Self::get(conn, id)
    }

    pub fn get(conn: &Connection, id: &str) -> DbResult<Option<Task>> {
        let mut stmt = conn.prepare(
            "SELECT id, title, completed, created_at, due_at, priority, tags, sort_order FROM tasks WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                completed: r.get::<_, i64>(2)? != 0,
                created_at: r.get(3)?,
                due_at: r.get(4)?,
                priority: r.get(5)?,
                tags: r.get(6)?,
                sort_order: r.get(7)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    /// W-044 行内编辑 / W-045 拖拽排序：按 id 更新可编辑字段。
    pub fn update(
        conn: &Connection,
        id: &str,
        title: Option<&str>,
        due_at: Option<&str>,
        priority: Option<i64>,
        tags: Option<&str>,
        sort_order: Option<i64>,
    ) -> DbResult<Option<Task>> {
        conn.execute(
            "UPDATE tasks SET
                title = COALESCE(?2, title),
                due_at = COALESCE(?3, due_at),
                priority = COALESCE(?4, priority),
                tags = COALESCE(?5, tags),
                sort_order = COALESCE(?6, sort_order)
             WHERE id = ?1",
            params![id, title, due_at, priority, tags, sort_order],
        )?;
        Self::get(conn, id)
    }

    pub fn delete(conn: &Connection, id: &str) -> DbResult<()> {
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(())
    }
}

/// Deadline repository.
pub struct DeadlineRepo;

impl DeadlineRepo {
    pub fn list(conn: &Connection) -> DbResult<Vec<Deadline>> {
        let mut stmt = conn.prepare(
            "SELECT id, title, due_at, notified, completed, notified_tiers, repeat FROM deadlines ORDER BY due_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Deadline {
                id: r.get(0)?,
                title: r.get(1)?,
                due_at: r.get(2)?,
                notified: r.get::<_, i64>(3)? != 0,
                completed: r.get::<_, i64>(4)? != 0,
                notified_tiers: r.get(5)?,
                repeat: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn add(
        conn: &Connection,
        title: &str,
        due_at: &str,
        repeat: Option<&str>,
    ) -> DbResult<Deadline> {
        let id = Uuid::new_v4().to_string();
        let repeat = repeat.unwrap_or("none");
        let due_at = crate::db::normalize_ts(due_at);
        conn.execute(
            "INSERT INTO deadlines (id, title, due_at, notified, completed, notified_tiers, repeat) VALUES (?1, ?2, ?3, 0, 0, '[]', ?4)",
            params![id, title, due_at, repeat],
        )?;
        Ok(Deadline {
            id,
            title: title.to_string(),
            due_at,
            notified: false,
            completed: false,
            notified_tiers: "[]".to_string(),
            repeat: repeat.to_string(),
        })
    }

    pub fn mark_notified(conn: &Connection, id: &str) -> DbResult<()> {
        conn.execute(
            "UPDATE deadlines SET notified = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// W-046 多档提醒：整体覆写已发送档位集合（JSON 数组字符串）。
    pub fn set_notified_tiers(conn: &Connection, id: &str, tiers: &str) -> DbResult<()> {
        conn.execute(
            "UPDATE deadlines SET notified_tiers = ?2 WHERE id = ?1",
            params![id, tiers],
        )?;
        Ok(())
    }

    /// Toggle the completed flag and return the updated row (None if missing).
    pub fn toggle(conn: &Connection, id: &str) -> DbResult<Option<Deadline>> {
        conn.execute(
            "UPDATE deadlines SET completed = 1 - completed WHERE id = ?1",
            params![id],
        )?;
        Self::get(conn, id)
    }

    pub fn get(conn: &Connection, id: &str) -> DbResult<Option<Deadline>> {
        let mut stmt = conn.prepare(
            "SELECT id, title, due_at, notified, completed, notified_tiers, repeat FROM deadlines WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(Deadline {
                id: r.get(0)?,
                title: r.get(1)?,
                due_at: r.get(2)?,
                notified: r.get::<_, i64>(3)? != 0,
                completed: r.get::<_, i64>(4)? != 0,
                notified_tiers: r.get(5)?,
                repeat: r.get(6)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    /// W-044 行内编辑 / W-049 周期滚动：更新标题/截止/重复规则；reset_tiers
    /// 为 true 时同时清空已提醒档位（周期滚动后重新提醒）。
    pub fn update(
        conn: &Connection,
        id: &str,
        title: Option<&str>,
        due_at: Option<&str>,
        repeat: Option<&str>,
        reset_tiers: bool,
    ) -> DbResult<Option<Deadline>> {
        // 两步 UPDATE 必须原子：第二条失败（磁盘满/约束）时若不回滚，会留下
        // "提醒档位已清空但字段未更新"的中间态，用户丢失提醒且无感知。
        let tx = conn.unchecked_transaction()?;
        if reset_tiers {
            tx.execute(
                "UPDATE deadlines SET notified_tiers = '[]' WHERE id = ?1",
                params![id],
            )?;
        }
        let due_at = due_at.map(crate::db::normalize_ts);
        tx.execute(
            "UPDATE deadlines SET
                title = COALESCE(?2, title),
                due_at = COALESCE(?3, due_at),
                repeat = COALESCE(?4, repeat)
             WHERE id = ?1",
            params![id, title, due_at, repeat],
        )?;
        tx.commit()?;
        Self::get(conn, id)
    }

    pub fn delete(conn: &Connection, id: &str) -> DbResult<()> {
        conn.execute("DELETE FROM deadlines WHERE id = ?1", params![id])?;
        Ok(())
    }
}

/// Session repository.
pub struct SessionRepo;

/// G12：会话保留上限（条数）。add 后按 started_at 保留最新 N 条，更旧的删除。
/// aggregate()/list() 对全表做扫描/物化，多年积累后每次统计轮询的成本随
/// 年头线性膨胀；2000 条 ≈ 数年高强度使用（日均 8 轮 ≈ 2.5 年），对趋势
/// 图足够。与 NotificationRepo 的 cap 裁剪同款语义（见其 cleanup）。
pub const SESSION_RETAIN_CAP: i64 = 2000;

impl SessionRepo {
    pub fn add(conn: &Connection, session: &PomodoroSession) -> DbResult<()> {
        conn.execute(
            "INSERT INTO pomodoro_sessions (id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                session.id,
                session.session_type,
                session.mode,
                session.started_at,
                session.ended_at,
                session.planned_seconds,
                if session.completed { 1 } else { 0 },
                session.task_id,
                session.event_label
            ],
        )?;
        // G12 保留策略：子查询倒序取最新 N 条，删除不在其中的行；cap >= 全表
        // 行数时 NOT IN 子查询覆盖全表，等价于 no-op（导入恢复的超量历史只在
        // 下一次 add 时才裁剪——导入是显式用户意图，不在导入路径上静默丢数据）。
        conn.execute(
            "DELETE FROM pomodoro_sessions WHERE id NOT IN (SELECT id FROM pomodoro_sessions ORDER BY started_at DESC LIMIT ?1)",
            params![SESSION_RETAIN_CAP],
        )?;
        Ok(())
    }

    pub fn list(conn: &Connection) -> DbResult<Vec<PomodoroSession>> {
        Self::list_limited(conn, None)
    }

    /// R5（审计）+ 修复：带上限的会话读取。`limit = Some(n)` 时把 LIMIT
    /// 下推进 SQL（子查询倒序取最近 n 条再正序输出），防止多年积累后每次
    /// 统计页轮询仍做 O(全表) 物化；`None` 保持旧行为（现有调用方全部依赖
    /// 全量口径）。
    pub fn list_limited(conn: &Connection, limit: Option<i64>) -> DbResult<Vec<PomodoroSession>> {
        // SQLite 中 LIMIT 为负数时表示无限制，因此统一走子查询路径。
        let sql = "SELECT id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label FROM (SELECT id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label FROM pomodoro_sessions ORDER BY started_at DESC LIMIT ?1) ORDER BY started_at";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit.unwrap_or(-1)], Self::row_to_session)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn row_to_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<PomodoroSession> {
        Ok(PomodoroSession {
            id: r.get(0)?,
            session_type: r.get(1)?,
            mode: r.get(2)?,
            started_at: r.get(3)?,
            ended_at: r.get(4)?,
            planned_seconds: r.get(5)?,
            completed: r.get::<_, i64>(6)? != 0,
            task_id: r.get(7)?,
            event_label: r.get(8)?,
        })
    }

    /// A-4：单次只读扫描内完成按日聚合（供累计统计与年度热图在 >500 段会话
    /// 时仍取全量，而非前端内存截断的最近 500 条）。
    /// `session_type='focus'` 才算专注；本地日历日口径与前端 `new Date(endedAt)`
    /// 一致。
    /// 口径（与前端 analytics.ts / PomodoroPanel A-36 一致）：**轮数只计
    /// completed=1**——中断放弃的段落有 completed=0 记录，此前 COUNT(*) 把它们
    /// 也算作完成轮数，连续启动-放弃即可"达成每日目标"刷连胜；**分钟数**仍含
    /// 部分时长（planned_seconds 在中断时写的是实际专注秒数）。
    ///
    /// FocusTimer 借鉴（跨午夜切分 + 虚拟午夜）：跨日会话不再整天归入
    /// `ended_at` 所在日，而是在每个虚拟午夜边界（本地日期变更于
    /// `virtual_midnight_hour` 点）切成多片、按墙钟占比分摊秒数；轮数只落在
    /// 结束时刻所属的虚拟日，避免跨日重复计数。
    pub fn aggregate(conn: &Connection, virtual_midnight_hour: i64) -> DbResult<FocusAggregate> {
        let rows = Self::load_focus_rows(conn)?;
        let mut daily: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for (start, end, planned, completed) in rows {
            let boundaries = midnight_boundaries(&start, &end, virtual_midnight_hour);
            let pieces = split_proportional(&start, &end, planned, &boundaries);
            if pieces.is_empty() {
                // 旧版本兼容：零时长行（started_at == ended_at）在旧 SQL 口径下
                // 秒数/轮数整天计入 ended_at 所在日——原样保留其计数。
                let entry = daily
                    .entry(virtual_day_key(end, virtual_midnight_hour))
                    .or_insert((0, 0));
                entry.0 += planned.max(0);
                if completed {
                    entry.1 += 1;
                }
                continue;
            }
            for (piece_start, _piece_end, seconds, last) in pieces {
                let entry = daily
                    .entry(virtual_day_key(piece_start, virtual_midnight_hour))
                    .or_insert((0, 0));
                entry.0 += seconds;
                // 轮数只记一次：落在最后一片（结束时刻所属虚拟日）。
                if last && completed {
                    entry.1 += 1;
                }
            }
        }
        let daily = daily
            .into_iter()
            .map(|(date, (seconds, count))| DailyFocusStat {
                date,
                focus_seconds: seconds,
                focus_count: count,
            })
            .collect();
        Ok(FocusAggregate { daily })
    }

    /// FocusTimer 借鉴：24 小时时段分布。秒数按本地小时边界切分分摊；轮数
    /// 落在会话结束时刻的小时（含未完成段——分布图反映「在几点花过时间」）。
    pub fn hourly_distribution(conn: &Connection) -> DbResult<Vec<HourlyFocusStat>> {
        let rows = Self::load_focus_rows(conn)?;
        let mut buckets: Vec<(i64, i64)> = vec![(0, 0); 24];
        for (start, end, planned, _completed) in rows {
            let boundaries = hour_boundaries(&start, &end);
            let pieces = split_proportional(&start, &end, planned, &boundaries);
            if pieces.is_empty() {
                // 旧版本兼容：零时长行整段记入 ended_at 的小时。
                buckets[end.hour() as usize].0 += planned.max(0);
                buckets[end.hour() as usize].1 += 1;
                continue;
            }
            for (piece_start, _piece_end, seconds, _last) in pieces {
                buckets[piece_start.hour() as usize].0 += seconds;
            }
            buckets[end.hour() as usize].1 += 1;
        }
        Ok(buckets
            .into_iter()
            .enumerate()
            .map(|(hour, (focus_seconds, focus_count))| HourlyFocusStat {
                hour: hour as i64,
                focus_seconds,
                focus_count,
            })
            .collect())
    }

    /// 聚合共用的行加载：专注段 + 有效起止时间（时间解析与切分在内存做，
    /// SQL 侧保持纯扫描——strftime 只能整天归属，无法做边界切分）。
    fn load_focus_rows(conn: &Connection) -> DbResult<Vec<FocusRow>> {
        let mut stmt = conn.prepare(
            "SELECT started_at, ended_at, planned_seconds, completed
             FROM pomodoro_sessions
             WHERE session_type = 'focus'
               AND ended_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)? != 0,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (started_at, ended_at, planned, completed) = row?;
            let Ok(start) = DateTime::parse_from_rfc3339(&started_at) else {
                continue;
            };
            let Ok(end) = DateTime::parse_from_rfc3339(&ended_at) else {
                continue;
            };
            let (start, end) = (start.with_timezone(&Local), end.with_timezone(&Local));
            // 只丢弃时间倒行的脏数据；零时长 / 零秒数是旧版本写入的历史形态，
            // 由调用方的兼容分支按旧 SQL 口径计入（保留轮数、零秒数）。
            if end < start || planned < 0 {
                continue;
            }
            out.push((start, end, planned, completed));
        }
        Ok(out)
    }
}

/* ---------- FocusTimer 借鉴：时间切分纯函数（aggregate / hourly 共用） ---------- */

/// 聚合读出的一行专注会话：(本地开始, 本地结束, 计划秒数, 是否完成)。
type FocusRow = (DateTime<Local>, DateTime<Local>, i64, bool);

/// 「虚拟日」的 YYYY-MM-DD 键：时刻减去 H 小时后取本地日期
/// （H=2 时，凌晨 01:30 属于「昨天」——虚拟日从 02:00 起算）。
fn virtual_day_key<Tz: TimeZone>(t: DateTime<Tz>, hour: i64) -> String {
    let shifted = t - Duration::hours(hour);
    format!(
        "{:04}-{:02}-{:02}",
        shifted.year(),
        shifted.month(),
        shifted.day()
    )
}

/// 收集 (start, end) 开区间内的全部「虚拟午夜」边界（本地 H:00，逐日推进）。
/// DST 歧义时刻（from_local_datetime 返回两解/无解）跳过该日边界。
fn midnight_boundaries<Tz: TimeZone + Clone>(
    start: &DateTime<Tz>,
    end: &DateTime<Tz>,
    hour: i64,
) -> Vec<DateTime<Tz>> {
    let tz = start.timezone();
    let mut out = Vec::new();
    let mut day = start.date_naive();
    let last_day = end.date_naive();
    loop {
        if let Some(b) = tz
            .with_ymd_and_hms(
                day.year(),
                day.month(),
                day.day(),
                hour.clamp(0, 23) as u32,
                0,
                0,
            )
            .single()
        {
            if b > *start && b < *end {
                out.push(b);
            }
        }
        if day >= last_day {
            break;
        }
        day += Duration::days(1);
        if out.len() > 400 {
            break; // 异常超长会话的防御上限（≈13 个月）
        }
    }
    out
}

/// 收集 (start, end) 开区间内的全部整点边界。
fn hour_boundaries<Tz: TimeZone>(start: &DateTime<Tz>, end: &DateTime<Tz>) -> Vec<DateTime<Tz>> {
    let mut out = Vec::new();
    let mut cursor = start
        .with_minute(0)
        .unwrap_or_else(|| start.clone())
        .with_second(0)
        .unwrap_or_else(|| start.clone())
        .with_nanosecond(0)
        .unwrap_or_else(|| start.clone());
    cursor += Duration::hours(1);
    while cursor < *end {
        out.push(cursor.clone());
        cursor += Duration::hours(1);
    }
    out
}

/// 按有序边界把 [start, end) 切成若干片，秒数按墙钟时长占比分摊
/// （末片吸收取整余量，保证 Σseconds == total）。返回 (片起, 片止, 秒, 是否末片)。
fn split_proportional<Tz: TimeZone>(
    start: &DateTime<Tz>,
    end: &DateTime<Tz>,
    total: i64,
    boundaries: &[DateTime<Tz>],
) -> Vec<(DateTime<Tz>, DateTime<Tz>, i64, bool)> {
    let total_ms = (end.clone() - start.clone()).num_milliseconds();
    if total_ms <= 0 || total <= 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(boundaries.len() + 1);
    let mut prev = start.clone();
    let mut allocated: i64 = 0;
    for b in boundaries.iter() {
        if *b <= prev || *b >= *end {
            continue;
        }
        let secs = total * (b.clone() - prev.clone()).num_milliseconds() / total_ms;
        allocated += secs;
        out.push((prev.clone(), b.clone(), secs, false));
        prev = b.clone();
    }
    out.push((prev, end.clone(), (total - allocated).max(0), true));
    out
}

/// Interruption repository (aborted pomodoro focus segments).
pub struct InterruptionRepo;

impl InterruptionRepo {
    pub fn add(conn: &Connection, i: &PomodoroInterruption) -> DbResult<()> {
        conn.execute(
            "INSERT INTO pomodoro_interruptions (id, started_at, ended_at, reason, mode, elapsed_seconds) VALUES (?1,?2,?3,?4,?5,?6)",
            params![i.id, i.started_at, i.ended_at, i.reason, i.mode, i.elapsed_seconds],
        )?;
        Ok(())
    }

    pub fn list(conn: &Connection) -> DbResult<Vec<PomodoroInterruption>> {
        let mut stmt = conn.prepare(
            "SELECT id, started_at, ended_at, reason, mode, elapsed_seconds FROM pomodoro_interruptions ORDER BY started_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PomodoroInterruption {
                id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                reason: r.get(3)?,
                mode: r.get(4)?,
                elapsed_seconds: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

/// DOCK（通知中心）：通知历史仓储。短命数据（默认保留 14 天、最多 500 行），
/// 清理策略是「写入路径顺手打扫」——每次 add/restore 后删除过期行并裁到上限，
/// 避免为低频小表单开后台线程。通知到达频率是每小时个位数，均摊成本可忽略。
pub struct NotificationRepo;

/// 历史行数上限：超出后按 created_at 保留最新的 N 条。
pub const NOTIFICATION_HISTORY_CAP: i64 = 500;
/// 历史保留天数：expires_at = created_at + N 天。
pub const NOTIFICATION_RETENTION_DAYS: i64 = 14;

impl NotificationRepo {
    /// 留档一条新通知：截断超长字段后写入，顺手做过期/超量清理。
    pub fn add(
        conn: &Connection,
        source: &str,
        title: &str,
        body: &str,
        kind: Option<&str>,
    ) -> DbResult<NotificationRecord> {
        let now = chrono::Utc::now();
        let created_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let expires_at = (now + chrono::Duration::days(NOTIFICATION_RETENTION_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let kind = normalize_kind(kind);
        let record = NotificationRecord {
            id: Uuid::new_v4().to_string(),
            source: truncate(source, 64),
            title: truncate(title, 256),
            body: truncate(body, 1024),
            kind: kind.to_string(),
            read: false,
            created_at,
        };
        conn.execute(
            "INSERT INTO notification_history (id, source, title, body, kind, read, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,0,?6,?7)",
            params![record.id, record.source, record.title, record.body, record.kind, record.created_at, expires_at],
        )?;
        Self::cleanup(conn)?;
        Ok(record)
    }

    /// 撤销删除后的原样回插（保留原 id / created_at / read，重新计算过期）。
    pub fn restore(conn: &Connection, record: &NotificationRecord) -> DbResult<()> {
        // 回插的时间戳必须是合法 UTC Z（normalize_ts 对不可解析输入原样放行，
        // 与 DeadlineRepo 的宽松口径一致——前端只会回传自己刚拿到的行）。
        let created_at = crate::db::normalize_ts(&record.created_at);
        let parsed = chrono::DateTime::parse_from_rfc3339(&created_at)
            .unwrap_or_else(|_| chrono::Utc::now().into());
        let expires_at = (parsed + chrono::Duration::days(NOTIFICATION_RETENTION_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let record = NotificationRecord {
            created_at,
            ..record.clone()
        };
        conn.execute(
            "INSERT OR REPLACE INTO notification_history (id, source, title, body, kind, read, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![record.id, truncate(&record.source, 64), truncate(&record.title, 256), truncate(&record.body, 1024), normalize_kind(Some(&record.kind)), if record.read { 1 } else { 0 }, record.created_at, expires_at],
        )?;
        Self::cleanup(conn)?;
        Ok(())
    }

    /// 倒序取最近 n 条（`None` = 全量）。上限 500 行使全量也无伤，但列表
    /// 面板通常只消费最近一两屏。
    pub fn list_limited(
        conn: &Connection,
        limit: Option<i64>,
    ) -> DbResult<Vec<NotificationRecord>> {
        let sql = "SELECT id, source, title, body, kind, read, created_at FROM (SELECT id, source, title, body, kind, read, created_at FROM notification_history ORDER BY created_at DESC LIMIT ?1) ORDER BY created_at DESC";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit.unwrap_or(-1)], Self::row_to_record)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn row_to_record(r: &rusqlite::Row<'_>) -> rusqlite::Result<NotificationRecord> {
        Ok(NotificationRecord {
            id: r.get(0)?,
            source: r.get(1)?,
            title: r.get(2)?,
            body: r.get(3)?,
            kind: r.get(4)?,
            read: r.get::<_, i64>(5)? != 0,
            created_at: r.get(6)?,
        })
    }

    /// 标记单条已读，返回更新后的行（不存在时 None）。
    pub fn mark_read(conn: &Connection, id: &str) -> DbResult<Option<NotificationRecord>> {
        conn.execute(
            "UPDATE notification_history SET read = 1 WHERE id = ?1",
            params![id],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, source, title, body, kind, read, created_at FROM notification_history WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], Self::row_to_record)?;
        Ok(rows.next().transpose()?)
    }

    /// 全部标记已读，返回受影响行数。
    pub fn mark_all_read(conn: &Connection) -> DbResult<usize> {
        Ok(conn.execute(
            "UPDATE notification_history SET read = 1 WHERE read = 0",
            [],
        )?)
    }

    pub fn delete(conn: &Connection, id: &str) -> DbResult<()> {
        conn.execute(
            "DELETE FROM notification_history WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn clear(conn: &Connection) -> DbResult<()> {
        conn.execute("DELETE FROM notification_history", [])?;
        Ok(())
    }

    /// 过期 + 超量清理。上限裁剪保留最新 N 条（子查询倒序取前 N，删除不在
    /// 其中的行）；cap >= 全表行数时 NOT IN 子查询为空集，等价于 no-op。
    /// G-8：跨日翻转也会调（写路径顺手清理之外的兜底），pub(crate)。
    pub(crate) fn cleanup(conn: &Connection) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute(
            "DELETE FROM notification_history WHERE expires_at < ?1",
            params![now],
        )?;
        conn.execute(
            "DELETE FROM notification_history WHERE id NOT IN (SELECT id FROM notification_history ORDER BY created_at DESC LIMIT ?1)",
            params![NOTIFICATION_HISTORY_CAP],
        )?;
        Ok(())
    }
}

/// kind 白名单：未知值一律回落 info（色条兜底），防前端传任意字符串入库。
fn normalize_kind(kind: Option<&str>) -> &'static str {
    match kind {
        Some("pomodoro") => "pomodoro",
        Some("todo") => "todo",
        _ => "info",
    }
}

/// 字段长度截断（按字符数）：通知正文由各小组件拼出，超长串不该原样进库。
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// CLIP（剪贴板历史）：剪贴板留档仓储。与通知历史同一治理模式——短命数据
/// （默认保留 30 天、最多 500 行），清理在写入路径顺手执行；不同点：
///  - **去重置顶**：新内容与**最新一条**（按 created_at）哈希相同时不新增，
///    只刷新其时间戳与过期锚点（复制同一内容 / 从历史回写都命中此路）；
///  - **置顶保护**：pinned 行既不过期也不被 LRU 裁掉；上限只对非置顶行计数；
///  - **图片文件外置**：删行只删 DB 记录，返回被删行引用的文件名，由调用方
///    删文件（仓储不碰文件系统，保持可用内存库单测）。
pub struct ClipboardRepo;

/// 非置顶行数上限：超出后按 created_at 保留最新的 N 条。
pub const CLIPBOARD_HISTORY_CAP: i64 = 500;
/// 保留天数：expires_at = created_at + N 天（置顶行忽略）。
pub const CLIPBOARD_RETENTION_DAYS: i64 = 30;

/// 待入库的剪贴板内容（监听线程组装；不经 IPC）。
#[derive(Debug, Clone)]
pub struct NewClipboardEntry {
    /// "text" | "image" | "files"。
    pub kind: String,
    /// 内容 SHA-256 十六进制（去重键）。
    pub hash: String,
    pub preview: String,
    pub text: Option<String>,
    pub image_file: Option<String>,
    pub image_w: Option<i64>,
    pub image_h: Option<i64>,
    pub image_bytes: i64,
    /// [FILES]（ZTools 借鉴 #8）文件条目的路径列表（JSON 数组字符串）。
    pub files: Option<String>,
    pub source_app: Option<String>,
}

/// `record` 的结果：`inserted=false` 表示命中去重、只刷新了时间戳；
/// `orphaned_images` 是本次顺手清理删掉的行所引用的图片文件名。
#[derive(Debug, Clone)]
pub struct ClipboardRecordOutcome {
    pub entry: ClipboardEntry,
    pub inserted: bool,
    pub orphaned_images: Vec<String>,
}

const CLIP_COLUMNS: &str =
    "id, kind, preview, text, image_file, image_w, image_h, image_bytes, files, source_app, pinned, created_at";

impl ClipboardRepo {
    fn now_pair() -> (String, String) {
        let now = chrono::Utc::now();
        (
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            (now + chrono::Duration::days(CLIPBOARD_RETENTION_DAYS))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )
    }

    fn row_to_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardEntry> {
        Ok(ClipboardEntry {
            id: r.get(0)?,
            kind: r.get(1)?,
            preview: r.get(2)?,
            text: r.get(3)?,
            image_file: r.get(4)?,
            image_w: r.get(5)?,
            image_h: r.get(6)?,
            image_bytes: r.get(7)?,
            files: r.get(8)?,
            source_app: r.get(9)?,
            pinned: r.get::<_, i64>(10)? != 0,
            created_at: r.get(11)?,
        })
    }

    /// 单行读取（不存在为 None）。
    pub fn get(conn: &Connection, id: &str) -> DbResult<Option<ClipboardEntry>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CLIP_COLUMNS} FROM clipboard_history WHERE id = ?1"
        ))?;
        let mut rows = stmt.query_map(params![id], Self::row_to_entry)?;
        Ok(rows.next().transpose()?)
    }

    /// 最新一条（按 created_at 倒序；无关置顶）的 id 与哈希。
    fn newest(conn: &Connection) -> DbResult<Option<(String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT id, hash FROM clipboard_history ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )?;
        let mut rows =
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.next().transpose()?)
    }

    /// 入库一条新捕获：与最新一条哈希相同 → 只刷新时间戳（置顶到最前）；否则
    /// 插入并顺手做过期/超量清理。
    pub fn record(
        conn: &Connection,
        input: &NewClipboardEntry,
    ) -> DbResult<ClipboardRecordOutcome> {
        let kind = normalize_clip_kind(&input.kind);
        if let Some((newest_id, newest_hash)) = Self::newest(conn)? {
            if newest_hash == input.hash {
                let entry = Self::touch(conn, &newest_id)?
                    .ok_or_else(|| DbError::Task("clipboard newest row vanished".into()))?;
                return Ok(ClipboardRecordOutcome {
                    entry,
                    inserted: false,
                    orphaned_images: Vec::new(),
                });
            }
        }
        let (created_at, expires_at) = Self::now_pair();
        let entry = ClipboardEntry {
            id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            preview: truncate(&input.preview, 256),
            text: input.text.clone(),
            image_file: input.image_file.clone(),
            image_w: input.image_w,
            image_h: input.image_h,
            image_bytes: input.image_bytes,
            files: input.files.clone(),
            source_app: input.source_app.as_deref().map(|s| truncate(s, 128)),
            pinned: false,
            created_at,
        };
        conn.execute(
            "INSERT INTO clipboard_history (id, kind, hash, preview, text, image_file, image_w, image_h, image_bytes, files, source_app, pinned, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13)",
            params![
                entry.id,
                entry.kind,
                input.hash,
                entry.preview,
                entry.text,
                entry.image_file,
                entry.image_w,
                entry.image_h,
                entry.image_bytes,
                entry.files,
                entry.source_app,
                entry.created_at,
                expires_at
            ],
        )?;
        let orphaned_images = Self::cleanup(conn)?;
        Ok(ClipboardRecordOutcome {
            entry,
            inserted: true,
            orphaned_images,
        })
    }

    /// 刷新时间戳与过期锚点（去重命中 / 从历史回写剪贴板时把该条顶到最前）。
    pub fn touch(conn: &Connection, id: &str) -> DbResult<Option<ClipboardEntry>> {
        let (created_at, expires_at) = Self::now_pair();
        conn.execute(
            "UPDATE clipboard_history SET created_at = ?1, expires_at = ?2 WHERE id = ?3",
            params![created_at, expires_at, id],
        )?;
        Self::get(conn, id)
    }

    /// 置顶 / 取消置顶。
    pub fn set_pinned(
        conn: &Connection,
        id: &str,
        pinned: bool,
    ) -> DbResult<Option<ClipboardEntry>> {
        conn.execute(
            "UPDATE clipboard_history SET pinned = ?1 WHERE id = ?2",
            params![if pinned { 1 } else { 0 }, id],
        )?;
        Self::get(conn, id)
    }

    /// 列表：置顶在前，其余按时间倒序；`query` 非空时对 preview / 全文做
    /// 大小写不敏感（ASCII）子串匹配，`%`/`_` 按字面转义。
    pub fn list(
        conn: &Connection,
        query: Option<&str>,
        limit: i64,
    ) -> DbResult<Vec<ClipboardEntry>> {
        let limit = if limit <= 0 {
            CLIPBOARD_HISTORY_CAP * 2
        } else {
            limit
        };
        let q = query.map(str::trim).filter(|q| !q.is_empty());
        match q {
            None => {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {CLIP_COLUMNS} FROM clipboard_history ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?1"
                ))?;
                let rows = stmt.query_map(params![limit], Self::row_to_entry)?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            }
            Some(q) => {
                let pattern = format!("%{}%", escape_like(q));
                let mut stmt = conn.prepare(&format!(
                    "SELECT {CLIP_COLUMNS} FROM clipboard_history WHERE preview LIKE ?1 ESCAPE '\\' OR (text IS NOT NULL AND text LIKE ?1 ESCAPE '\\') ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?2"
                ))?;
                let rows = stmt.query_map(params![pattern, limit], Self::row_to_entry)?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            }
        }
    }

    /// 删单条，返回被删行（调用方据 image_file 删文件）；不存在为 None。
    pub fn delete(conn: &Connection, id: &str) -> DbResult<Option<ClipboardEntry>> {
        let existing = Self::get(conn, id)?;
        if existing.is_some() {
            conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])?;
        }
        Ok(existing)
    }

    /// 清空全部，返回所有被删行引用的图片文件名。
    pub fn clear(conn: &Connection) -> DbResult<Vec<String>> {
        let files = Self::image_files_where(conn, "image_file IS NOT NULL", &[])?;
        conn.execute("DELETE FROM clipboard_history", [])?;
        Ok(files)
    }

    /// 全表行数（单测断言用）。
    #[cfg(test)]
    pub fn count(conn: &Connection) -> DbResult<i64> {
        Ok(conn.query_row("SELECT COUNT(*) FROM clipboard_history", [], |r| r.get(0))?)
    }

    fn image_files_where(
        conn: &Connection,
        where_clause: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> DbResult<Vec<String>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT image_file FROM clipboard_history WHERE {where_clause}"
        ))?;
        let rows = stmt.query_map(args, |r| r.get::<_, Option<String>>(0))?;
        Ok(rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// 过期 + 超量清理（均跳过置顶行），返回被清理行引用的图片文件名。
    /// 超量：非置顶行按 created_at 倒序保留前 N 条，其余删除；行数 ≤ N 时子
    /// 查询覆盖全部非置顶行，NOT IN 为空集等价 no-op。
    /// G-8：跨日翻转也会调（写路径顺手清理之外的兜底），pub(crate)。
    pub(crate) fn cleanup(conn: &Connection) -> DbResult<Vec<String>> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut orphaned = Self::image_files_where(
            conn,
            "pinned = 0 AND expires_at < ?1 AND image_file IS NOT NULL",
            &[&now],
        )?;
        conn.execute(
            "DELETE FROM clipboard_history WHERE pinned = 0 AND expires_at < ?1",
            params![now],
        )?;
        let overflow_clause = "pinned = 0 AND id NOT IN (SELECT id FROM clipboard_history WHERE pinned = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?1)";
        orphaned.extend(Self::image_files_where(
            conn,
            &format!("{overflow_clause} AND image_file IS NOT NULL"),
            &[&CLIPBOARD_HISTORY_CAP],
        )?);
        conn.execute(
            &format!("DELETE FROM clipboard_history WHERE {overflow_clause}"),
            params![CLIPBOARD_HISTORY_CAP],
        )?;
        Ok(orphaned)
    }
}

/// kind 白名单：未知值回落 text（列表按文本渲染，最保守）。
fn normalize_clip_kind(kind: &str) -> &'static str {
    match kind {
        "image" => "image",
        // [FILES]（ZTools 借鉴 #8）文件类条目（CF_HDROP 捕获）。
        "files" => "files",
        _ => "text",
    }
}

/// LIKE 模式转义：用户搜索串里的 `%` / `_` / `\` 按字面匹配（配 `ESCAPE '\'`）。
pub(crate) fn escape_like(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for ch in q.chars() {
        if ch == '%' || ch == '_' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Generic key/value settings store (widget layouts, app prefs, etc.).
pub struct SettingsRepo;

impl SettingsRepo {
    pub fn get(conn: &Connection, key: &str) -> DbResult<Option<String>> {
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |r| r.get::<_, String>(0))?;
        Ok(rows.next().transpose()?)
    }

    pub fn set(conn: &Connection, key: &str, value: &str) -> DbResult<()> {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete(conn: &Connection, key: &str) -> DbResult<()> {
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn list_all(conn: &Connection) -> DbResult<Vec<SettingKV>> {
        let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt.query_map([], |r| {
            Ok(SettingKV {
                key: r.get(0)?,
                value: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

/// Prefix used by the localStorage mirror rows (widget configs, notes, habits,
/// bookmarks and everything else the frontend keeps outside SQLite).
pub const LS_MIRROR_PREFIX: &str = "lsmirror:";

/// Replaces the whole localStorage mirror inside one transaction: all existing
/// `lsmirror:*` rows are dropped, then the given entries are inserted. The
/// frontend calls this right before creating a backup so the snapshot is fresh.
pub fn replace_local_storage_mirror(conn: &mut Connection, entries: &[SettingKV]) -> DbResult<()> {
    // B-审计修复：localStorage 被清空/读取失败时前端会推来空集——若照单全收，
    // 镜像表里的唯一幸存副本会被抹掉（备份随之变空壳，恢复无门）。
    // 空集替换一律拒绝并告警；真实清库走显式的 delete 路径而非空集。
    if entries.is_empty() {
        let existing: i64 = conn.query_row(
            "SELECT COUNT(*) FROM settings WHERE key LIKE ?1",
            params![format!("{LS_MIRROR_PREFIX}%")],
            |r| r.get(0),
        )?;
        if existing > 0 {
            log::warn!(
                "replace_local_storage_mirror: empty entry set with {existing} surviving rows — rejected"
            );
            return Err(DbError::Task(
                "拒绝空集镜像替换：本地收集到 0 条但镜像仍有数据（localStorage 可能被清空/受限）"
                    .into(),
            ));
        }
    }
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM settings WHERE key LIKE ?",
        params![format!("{LS_MIRROR_PREFIX}%")],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )?;
        for e in entries {
            // Defensive: strip any smuggled prefix so a crafted key can't
            // clobber real settings rows (e.g. "widget:layout:home").
            // P2（审计修复）：此前用 replace() 会把 key 中间出现的子串也删掉
            // （如 "notes.lsmirror:x" → "notes.x"），镜像 key 被无声改写。
            // 防走私只需保证开头不是前缀，用 strip_prefix 只剥离开头一次。
            let stripped = e.key.strip_prefix(LS_MIRROR_PREFIX).unwrap_or(&e.key);
            let key = format!("{LS_MIRROR_PREFIX}{stripped}");
            stmt.execute(params![key, e.value])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Returns the localStorage mirror rows with the prefix stripped.
pub fn list_local_storage_mirror(conn: &Connection) -> DbResult<Vec<SettingKV>> {
    let pattern = format!("{LS_MIRROR_PREFIX}%");
    let mut stmt =
        conn.prepare("SELECT key, value FROM settings WHERE key LIKE ?1 ORDER BY key")?;
    let rows = stmt.query_map(params![pattern], |r| {
        let key: String = r.get(0)?;
        Ok(SettingKV {
            key: key[LS_MIRROR_PREFIX.len()..].to_string(),
            value: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Settings keys a backup is allowed to restore. Everything else (notably
/// `email:accounts` / `email:account`, which hold DPAPI-protected credentials)
/// is dropped on import so a crafted backup file cannot inject arbitrary keys.
fn is_restorable_setting_key(key: &str) -> bool {
    key == "app:settings:v1" || key.starts_with("widget:") || key.starts_with("lsmirror:")
}

/// Full backup/import/export across the three domains.
pub struct BackupRepo;

impl BackupRepo {
    pub fn export_all(conn: &Connection) -> DbResult<AppData> {
        // 审计修复：四个查询此前各自持有独立 WAL 快照，导出期间并发写入会
        // 撕裂出混合态备份。包一层 deferred 读事务，让全部读走同一快照
        // （只读不阻塞写；unchecked_transaction 免 &mut，调用方签名不变）。
        let tx = conn.unchecked_transaction()?;
        // P1（审计修复）：导出与导入的敏感键过滤必须对称。导入侧有
        // is_restorable_setting_key 白名单，导出侧此前不过滤——DPAPI 加密的
        // 邮箱凭据（email:accounts 等）会随备份落盘并随 30 份滚动备份扩散。
        let settings: Vec<SettingKV> = SettingsRepo::list_all(&tx)?
            .into_iter()
            .filter(|kv| {
                if is_restorable_setting_key(&kv.key) {
                    true
                } else {
                    log::info!(
                        "export_all: excluding non-restorable settings key '{}'",
                        kv.key
                    );
                    false
                }
            })
            .collect();
        let data = AppData {
            // 导出即打上当前版本号，供恢复时的前置校验判断兼容性（S2）。
            schema_version: crate::models::BACKUP_SCHEMA_VERSION,
            tasks: TaskRepo::list(&tx)?,
            deadlines: DeadlineRepo::list(&tx)?,
            sessions: Some(SessionRepo::list(&tx)?),
            settings,
            interruptions: Some(InterruptionRepo::list(&tx)?),
        };
        drop(tx); // 只读事务：提交与否都不产生写入
        Ok(data)
    }

    /// Replaces all data inside one transaction. On failure nothing is written.
    /// Settings rows are UPSERTed (keys absent from the backup are kept) so a
    /// restore never wipes newer mirror rows the backup didn't carry.
    pub fn import_all(conn: &mut Connection, data: &AppData) -> DbResult<ImportResult> {
        // P2（审计修复）：S2 版本号此前只在导出侧打标、导入端不检查。来自
        // 更新版本结构的备份会被旧二进制"部分理解地"导入（未知字段被 serde
        // 丢弃、语义漂移），造成静默数据变形。后端必须自守，不能依赖前端校验。
        if data.schema_version > crate::models::BACKUP_SCHEMA_VERSION {
            return Err(DbError::Task(format!(
                "备份 schema 版本过新：文件 v{} > 当前支持 v{}，请先升级应用",
                data.schema_version,
                crate::models::BACKUP_SCHEMA_VERSION
            )));
        }
        let tx = conn.transaction()?;
        tx.execute_batch("DELETE FROM tasks; DELETE FROM deadlines;")?;
        for t in &data.tasks {
            tx.execute(
                "INSERT INTO tasks (id, title, completed, created_at, due_at, priority, tags, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    t.id,
                    t.title,
                    if t.completed { 1 } else { 0 },
                    t.created_at,
                    t.due_at,
                    t.priority,
                    t.tags,
                    t.sort_order
                ],
            )?;
        }
        for d in &data.deadlines {
            tx.execute(
                "INSERT INTO deadlines (id, title, due_at, notified, completed, notified_tiers, repeat) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    d.id,
                    d.title,
                    d.due_at,
                    if d.notified { 1 } else { 0 },
                    if d.completed { 1 } else { 0 },
                    d.notified_tiers,
                    d.repeat
                ],
            )?;
        }
        // 专注记录与中断记录同款语义：只在备份携带该字段时整体替换；旧备份
        // （None）不触碰现有数据。
        if let Some(list) = &data.sessions {
            tx.execute_batch("DELETE FROM pomodoro_sessions;")?;
            for s in list {
                tx.execute(
                    "INSERT INTO pomodoro_sessions (id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![s.id, s.session_type, s.mode, s.started_at, s.ended_at, s.planned_seconds, if s.completed { 1 } else { 0 }, s.task_id, s.event_label],
                )?;
            }
        }
        // 中断记录只在备份携带该字段时整体替换；旧备份（None）不触碰现有
        // 数据 —— 与 settings 的"缺省即保留"语义保持一致。
        if let Some(list) = &data.interruptions {
            tx.execute_batch("DELETE FROM pomodoro_interruptions;")?;
            for i in list {
                tx.execute(
                    "INSERT INTO pomodoro_interruptions (id, started_at, ended_at, reason, mode, elapsed_seconds) VALUES (?1,?2,?3,?4,?5,?6)",
                    params![i.id, i.started_at, i.ended_at, i.reason, i.mode, i.elapsed_seconds],
                )?;
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?;
            for kv in &data.settings {
                // E-3: only restore keys the app legitimately owns. A crafted
                // backup must not be able to write `email:accounts` (which would
                // retarget the mail widget at an attacker's IMAP server) or any
                // other arbitrary key. `lsmirror:%` is the localStorage mirror,
                // `widget:%` the layout/templates, `app:settings:v1` the app
                // settings blob.
                if !is_restorable_setting_key(&kv.key) {
                    log::warn!(
                        "import_all: dropping non-restorable settings key '{}'",
                        kv.key
                    );
                    continue;
                }
                stmt.execute(params![kv.key, kv.value])?;
            }
        }
        tx.commit()?;
        // E-7: a full-table replace is exactly the "heavy write" that inflates
        // the WAL; truncate it back so the -wal file can't grow unbounded.
        crate::db::checkpoint(conn);
        Ok(ImportResult {
            tasks: data.tasks.len(),
            deadlines: data.deadlines.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::db::{in_memory, MIGRATIONS};
    use crate::models::{AppData, PomodoroSession, SettingKV};
    use crate::repositories::{
        escape_like, BackupRepo, ClipboardRepo, DeadlineRepo, InterruptionRepo, NewClipboardEntry,
        NotificationRepo, SessionRepo, SettingsRepo, TaskRepo, CLIPBOARD_HISTORY_CAP,
        NOTIFICATION_HISTORY_CAP, SESSION_RETAIN_CAP,
    };

    // ---- CLIP：剪贴板历史仓储 ----

    fn clip_text(text: &str) -> NewClipboardEntry {
        NewClipboardEntry {
            kind: "text".into(),
            hash: format!("h:{text}"),
            preview: text.lines().next().unwrap_or("").to_string(),
            text: Some(text.to_string()),
            image_file: None,
            image_w: None,
            image_h: None,
            image_bytes: 0,
            files: None,
            source_app: None,
        }
    }

    fn clip_image(file: &str) -> NewClipboardEntry {
        NewClipboardEntry {
            kind: "image".into(),
            hash: format!("img:{file}"),
            preview: String::new(),
            text: None,
            image_file: Some(file.to_string()),
            image_w: Some(4),
            image_h: Some(2),
            image_bytes: 123,
            files: None,
            source_app: Some("snip.exe".into()),
        }
    }

    fn clip_files(paths: &[&str]) -> NewClipboardEntry {
        NewClipboardEntry {
            kind: "files".into(),
            hash: format!("files:{}", paths.join("|")),
            preview: crate::clipboard::files_preview(
                &paths.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            ),
            text: None,
            image_file: None,
            image_w: None,
            image_h: None,
            image_bytes: 0,
            files: Some(serde_json::to_string(paths).unwrap()),
            source_app: Some("explorer.exe".into()),
        }
    }

    #[test]
    fn clipboard_files_kind_roundtrips_and_searches_by_name() {
        // [FILES]（ZTools 借鉴 #8）文件条目：入库 kind/files 列、列表取回、
        // 摘要按文件名生成并可被搜索命中；与文本/图片条目并存。
        let conn = in_memory(MIGRATIONS).unwrap();
        let rec = ClipboardRepo::record(
            &conn,
            &clip_files(&["C:/Users/me/报告.pdf", "D:/资料/图.png"]),
        )
        .unwrap();
        assert!(rec.inserted);
        assert_eq!(rec.entry.kind, "files");
        assert_eq!(rec.entry.preview, "报告.pdf, 图.png");
        let listed = ClipboardRepo::list(&conn, None, 10).unwrap();
        assert_eq!(listed.len(), 1);
        let files_json = listed[0].files.clone().unwrap();
        let parsed: Vec<String> = serde_json::from_str(&files_json).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], "C:/Users/me/报告.pdf");
        assert_eq!(parsed[1], "D:/资料/图.png");
        let hit = ClipboardRepo::list(&conn, Some("报告"), 10).unwrap();
        assert_eq!(hit.len(), 1);
        let miss = ClipboardRepo::list(&conn, Some("不存在"), 10).unwrap();
        assert!(miss.is_empty());
        // 与文本条目互不干扰（kind 白名单各自归位）。
        let _ = ClipboardRepo::record(&conn, &clip_text("plain")).unwrap();
        let all = ClipboardRepo::list(&conn, None, 10).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|e| e.kind == "files"));
        assert!(all.iter().any(|e| e.kind == "text"));
    }

    #[test]
    fn clipboard_dedup_refreshes_newest_instead_of_inserting() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let first = ClipboardRepo::record(&conn, &clip_text("hello")).unwrap();
        assert!(first.inserted);
        // 人为把首条时间戳推回过去，便于断言刷新确实改写了 created_at / expires_at。
        conn.execute(
            "UPDATE clipboard_history SET created_at = '2026-01-01T00:00:00.000Z', expires_at = '2026-01-31T00:00:00.000Z' WHERE id = ?1",
            rusqlite::params![first.entry.id],
        )
        .unwrap();

        let again = ClipboardRepo::record(&conn, &clip_text("hello")).unwrap();
        assert!(!again.inserted, "与最新一条相同：不新增");
        assert_eq!(again.entry.id, first.entry.id, "刷新的是同一行");
        assert!(again.entry.created_at.as_str() > "2026-01-01T00:00:00.000Z");
        assert_eq!(ClipboardRepo::count(&conn).unwrap(), 1);
        let expires: String = conn
            .query_row(
                "SELECT expires_at FROM clipboard_history WHERE id = ?1",
                rusqlite::params![first.entry.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            expires.as_str() > "2026-01-31T00:00:00.000Z",
            "过期锚点随刷新重算"
        );
    }

    #[test]
    fn clipboard_dedup_only_compares_with_newest_row() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // A → B → A：第三次与最新一条（B）不同，按任务口径应新增而非回捞旧 A。
        let a1 = ClipboardRepo::record(&conn, &clip_text("A")).unwrap();
        conn.execute(
            "UPDATE clipboard_history SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            rusqlite::params![a1.entry.id],
        )
        .unwrap();
        let b = ClipboardRepo::record(&conn, &clip_text("B")).unwrap();
        conn.execute(
            "UPDATE clipboard_history SET created_at = '2026-01-02T00:00:00.000Z' WHERE id = ?1",
            rusqlite::params![b.entry.id],
        )
        .unwrap();
        let a2 = ClipboardRepo::record(&conn, &clip_text("A")).unwrap();
        assert!(a2.inserted);
        assert_ne!(a2.entry.id, a1.entry.id);
        assert_eq!(ClipboardRepo::count(&conn).unwrap(), 3);
        // 列表：最新在前。
        let list = ClipboardRepo::list(&conn, None, 10).unwrap();
        assert_eq!(list[0].id, a2.entry.id);
        assert_eq!(list[1].id, b.entry.id);
        assert_eq!(list[2].id, a1.entry.id);
    }

    #[test]
    fn clipboard_lru_cap_evicts_oldest_unpinned_and_reports_orphaned_images() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 直接灌 cap 行（created_at 递增），其中最早一行是图片：再 record 一条
        // 文本 → 总数仍为 cap，最早的图片行被裁掉且其文件名被回报。
        for i in 0..CLIPBOARD_HISTORY_CAP {
            let (kind, file, hash) = if i == 0 {
                ("image", Some("oldest.png"), "img:oldest")
            } else {
                ("text", None, "")
            };
            conn.execute(
                "INSERT INTO clipboard_history (id, kind, hash, preview, text, image_file, image_bytes, pinned, created_at, expires_at) VALUES (?1,?2,?3,'p',NULL,?4,0,0,?5,'2999-01-01T00:00:00.000Z')",
                rusqlite::params![
                    format!("row{i}"),
                    kind,
                    if hash.is_empty() { format!("h{i}") } else { hash.to_string() },
                    file,
                    format!("2026-01-01T00:00:{:02}.{:03}Z", i / 1000, i % 1000)
                ],
            )
            .unwrap();
        }
        assert_eq!(ClipboardRepo::count(&conn).unwrap(), CLIPBOARD_HISTORY_CAP);

        let out = ClipboardRepo::record(&conn, &clip_text("fresh")).unwrap();
        assert!(out.inserted);
        assert_eq!(ClipboardRepo::count(&conn).unwrap(), CLIPBOARD_HISTORY_CAP);
        assert_eq!(out.orphaned_images, vec!["oldest.png".to_string()]);
        assert!(
            ClipboardRepo::get(&conn, "row0").unwrap().is_none(),
            "最早一行被 LRU 裁掉"
        );
        assert!(ClipboardRepo::get(&conn, "row1").unwrap().is_some());
    }

    #[test]
    fn clipboard_expiry_purges_stale_rows_but_keeps_pinned() {
        let conn = in_memory(MIGRATIONS).unwrap();
        conn.execute(
            "INSERT INTO clipboard_history (id, kind, hash, preview, image_file, pinned, created_at, expires_at) VALUES ('stale','image','h1','','stale.png',0,'2020-01-01T00:00:00.000Z','2020-01-31T00:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO clipboard_history (id, kind, hash, preview, pinned, created_at, expires_at) VALUES ('pinned-stale','text','h2','keep',1,'2020-01-01T00:00:00.000Z','2020-01-31T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let out = ClipboardRepo::record(&conn, &clip_text("new")).unwrap();
        assert_eq!(out.orphaned_images, vec!["stale.png".to_string()]);
        assert!(
            ClipboardRepo::get(&conn, "stale").unwrap().is_none(),
            "过期行被清"
        );
        let kept = ClipboardRepo::get(&conn, "pinned-stale").unwrap();
        assert!(kept.is_some(), "置顶行不过期");
        assert!(kept.unwrap().pinned);
    }

    #[test]
    fn clipboard_pinned_rows_survive_cap_and_sort_first() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 一条很老的置顶行 + cap 行非置顶：再插一条后，置顶行仍在且列表首位。
        conn.execute(
            "INSERT INTO clipboard_history (id, kind, hash, preview, pinned, created_at, expires_at) VALUES ('pin','text','hp','pinned!',1,'2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        for i in 0..CLIPBOARD_HISTORY_CAP {
            conn.execute(
                "INSERT INTO clipboard_history (id, kind, hash, preview, pinned, created_at, expires_at) VALUES (?1,'text',?2,'p',0,?3,'2999-01-01T00:00:00.000Z')",
                rusqlite::params![
                    format!("row{i}"),
                    format!("h{i}"),
                    format!("2026-01-01T00:00:{:02}.{:03}Z", i / 1000, i % 1000)
                ],
            )
            .unwrap();
        }
        ClipboardRepo::record(&conn, &clip_text("fresh")).unwrap();
        assert_eq!(
            ClipboardRepo::count(&conn).unwrap(),
            CLIPBOARD_HISTORY_CAP + 1
        );
        let list = ClipboardRepo::list(&conn, None, 5).unwrap();
        assert_eq!(list[0].id, "pin", "置顶行排最前");
        assert!(list[0].pinned);
        assert_eq!(list[1].preview, "fresh");

        // 取消置顶后它成了最老的非置顶行：下一次清理即被裁掉。
        let unpinned = ClipboardRepo::set_pinned(&conn, "pin", false)
            .unwrap()
            .unwrap();
        assert!(!unpinned.pinned);
        ClipboardRepo::record(&conn, &clip_text("another")).unwrap();
        assert!(ClipboardRepo::get(&conn, "pin").unwrap().is_none());
    }

    #[test]
    fn clipboard_search_matches_preview_and_fulltext_with_literal_wildcards() {
        let conn = in_memory(MIGRATIONS).unwrap();
        ClipboardRepo::record(&conn, &clip_text("first line\nsecond needle line")).unwrap();
        ClipboardRepo::record(&conn, &clip_text("100% done")).unwrap();
        ClipboardRepo::record(&conn, &clip_image("shot.png")).unwrap();

        // 全文命中（needle 只在第二行，preview 不含）。
        let hit = ClipboardRepo::list(&conn, Some("needle"), 10).unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].preview, "first line");
        // 大小写不敏感（ASCII）。
        assert_eq!(
            ClipboardRepo::list(&conn, Some("NEEDLE"), 10)
                .unwrap()
                .len(),
            1
        );
        // `%` 按字面：不是通配符——只命中含 "100%" 的那条。
        let pct = ClipboardRepo::list(&conn, Some("0% d"), 10).unwrap();
        assert_eq!(pct.len(), 1);
        assert_eq!(pct[0].preview, "100% done");
        // `_` 按字面：没有下划线的内容不该被 "_" 命中。
        assert!(ClipboardRepo::list(&conn, Some("_"), 10)
            .unwrap()
            .is_empty());
        // 空白查询 = 全量。
        assert_eq!(
            ClipboardRepo::list(&conn, Some("   "), 10).unwrap().len(),
            3
        );
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }

    #[test]
    fn clipboard_touch_delete_clear_roundtrip() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let a = ClipboardRepo::record(&conn, &clip_text("a")).unwrap().entry;
        conn.execute(
            "UPDATE clipboard_history SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            rusqlite::params![a.id],
        )
        .unwrap();
        let b = ClipboardRepo::record(&conn, &clip_text("b")).unwrap().entry;
        conn.execute(
            "UPDATE clipboard_history SET created_at = '2026-01-02T00:00:00.000Z' WHERE id = ?1",
            rusqlite::params![b.id],
        )
        .unwrap();
        let img = ClipboardRepo::record(&conn, &clip_image("x.png"))
            .unwrap()
            .entry;
        assert_eq!(img.kind, "image");
        assert_eq!(img.source_app.as_deref(), Some("snip.exe"));
        assert_eq!(
            (img.image_w, img.image_h, img.image_bytes),
            (Some(4), Some(2), 123)
        );
        conn.execute(
            "UPDATE clipboard_history SET created_at = '2026-01-03T00:00:00.000Z' WHERE id = ?1",
            rusqlite::params![img.id],
        )
        .unwrap();

        // touch：a 回到最前（回写剪贴板时的置顶语义）。
        let touched = ClipboardRepo::touch(&conn, &a.id).unwrap().unwrap();
        assert!(touched.created_at.as_str() > "2026-01-03T00:00:00.000Z");
        assert_eq!(ClipboardRepo::list(&conn, None, 10).unwrap()[0].id, a.id);
        assert!(ClipboardRepo::touch(&conn, "missing").unwrap().is_none());

        // delete 返回被删行（含图片文件名供调用方删文件）。
        let deleted = ClipboardRepo::delete(&conn, &img.id).unwrap().unwrap();
        assert_eq!(deleted.image_file.as_deref(), Some("x.png"));
        assert!(ClipboardRepo::delete(&conn, &img.id).unwrap().is_none());
        assert_eq!(ClipboardRepo::count(&conn).unwrap(), 2);

        // clear 回报全部图片文件。
        ClipboardRepo::record(&conn, &clip_image("y.png")).unwrap();
        let files = ClipboardRepo::clear(&conn).unwrap();
        assert_eq!(files, vec!["y.png".to_string()]);
        assert_eq!(ClipboardRepo::count(&conn).unwrap(), 0);
    }

    #[test]
    fn clipboard_unknown_kind_falls_back_to_text_and_truncates() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let mut input = clip_text("x");
        input.kind = "evil".into();
        input.preview = "p".repeat(400);
        input.source_app = Some("s".repeat(300));
        let e = ClipboardRepo::record(&conn, &input).unwrap().entry;
        assert_eq!(e.kind, "text");
        assert_eq!(e.preview.chars().count(), 256);
        assert_eq!(e.source_app.unwrap().chars().count(), 128);
    }

    // ---- DOCK：通知历史仓储 ----

    #[test]
    fn notification_add_list_newest_first() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let a = NotificationRepo::add(&conn, "pomodoro", "专注完成", "休息一下", Some("pomodoro"))
            .unwrap();
        // 同毫秒内两次写入 created_at 可能相同；显式回拨第一条保证顺序可断言。
        conn.execute(
            "UPDATE notification_history SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            rusqlite::params![a.id],
        )
        .unwrap();
        let b =
            NotificationRepo::add(&conn, "deadline", "任务逾期", "交周报", Some("todo")).unwrap();
        assert!(!a.read && !b.read);
        assert_eq!(a.kind, "pomodoro");
        assert_eq!(b.kind, "todo");

        let list = NotificationRepo::list_limited(&conn, None).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, b.id, "newest first");
        assert_eq!(list[1].id, a.id);

        let one = NotificationRepo::list_limited(&conn, Some(1)).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].id, b.id);
    }

    #[test]
    fn notification_kind_whitelist_and_truncation() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let long_body: String = "很".repeat(2000);
        let r = NotificationRepo::add(&conn, "habit", "t", &long_body, Some("evil")).unwrap();
        assert_eq!(r.kind, "info", "unknown kind falls back to info");
        assert_eq!(r.body.chars().count(), 1024);
        let none = NotificationRepo::add(&conn, "habit", "t", "b", None).unwrap();
        assert_eq!(none.kind, "info");
    }

    #[test]
    fn notification_read_delete_clear() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let a = NotificationRepo::add(&conn, "s", "a", "", None).unwrap();
        let b = NotificationRepo::add(&conn, "s", "b", "", None).unwrap();

        let read = NotificationRepo::mark_read(&conn, &a.id).unwrap().unwrap();
        assert!(read.read);
        assert!(NotificationRepo::mark_read(&conn, "missing")
            .unwrap()
            .is_none());

        // 全部已读：只剩 b 未读 → 受影响 1 行；再来一次为 0。
        assert_eq!(NotificationRepo::mark_all_read(&conn).unwrap(), 1);
        assert_eq!(NotificationRepo::mark_all_read(&conn).unwrap(), 0);
        assert!(NotificationRepo::list_limited(&conn, None)
            .unwrap()
            .iter()
            .all(|r| r.read));

        NotificationRepo::delete(&conn, &b.id).unwrap();
        assert_eq!(
            NotificationRepo::list_limited(&conn, None).unwrap().len(),
            1
        );
        NotificationRepo::clear(&conn).unwrap();
        assert!(NotificationRepo::list_limited(&conn, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn notification_restore_reinserts_same_row() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let a = NotificationRepo::add(&conn, "s", "a", "body", Some("todo")).unwrap();
        NotificationRepo::delete(&conn, &a.id).unwrap();
        assert!(NotificationRepo::list_limited(&conn, None)
            .unwrap()
            .is_empty());

        // 撤销删除：原 id / created_at / 内容原样回来。
        NotificationRepo::restore(&conn, &a).unwrap();
        let list = NotificationRepo::list_limited(&conn, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, a.id);
        assert_eq!(list[0].created_at, a.created_at);
        assert_eq!(list[0].kind, "todo");
        // 重复 restore 幂等（INSERT OR REPLACE）。
        NotificationRepo::restore(&conn, &a).unwrap();
        assert_eq!(
            NotificationRepo::list_limited(&conn, None).unwrap().len(),
            1
        );
    }

    #[test]
    fn notification_cleanup_trims_cap_and_expired() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 塞一条已过期行（expires_at 在过去）：下一次 add 必须把它清掉。
        conn.execute(
            "INSERT INTO notification_history (id, source, title, body, kind, read, created_at, expires_at) VALUES ('old','s','t','b','info',0,'2020-01-01T00:00:00.000Z','2020-01-15T00:00:00.000Z')",
            [],
        )
        .unwrap();
        NotificationRepo::add(&conn, "s", "fresh", "", None).unwrap();
        let ids: Vec<String> = NotificationRepo::list_limited(&conn, None)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert!(
            !ids.contains(&"old".to_string()),
            "expired row must be purged"
        );

        // 超量：直接灌 cap + 20 行（created_at 递增），再 add 一条 → 总数 == cap，
        // 且保留的是最新的（最早的 21 条被裁掉）。
        conn.execute("DELETE FROM notification_history", [])
            .unwrap();
        for i in 0..(NOTIFICATION_HISTORY_CAP + 20) {
            conn.execute(
                "INSERT INTO notification_history (id, source, title, body, kind, read, created_at, expires_at) VALUES (?1,'s','t','b','info',0,?2,'2999-01-01T00:00:00.000Z')",
                rusqlite::params![format!("n{i:04}"), format!("2026-01-01T00:00:{:02}.{:03}Z", i / 1000, i % 1000)],
            )
            .unwrap();
        }
        NotificationRepo::add(&conn, "s", "newest", "", None).unwrap();
        let list = NotificationRepo::list_limited(&conn, None).unwrap();
        assert_eq!(list.len() as i64, NOTIFICATION_HISTORY_CAP);
        assert_eq!(list[0].title, "newest");
        let ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        assert!(!ids.contains(&"n0000"), "oldest rows are trimmed first");
        assert!(ids.contains(&"n0519"), "newest pre-existing rows survive");
    }

    #[test]
    fn session_retention_prunes_oldest_on_add() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 灌超量历史（直接 SQL 加速测试，started_at 全 distinct 且递增）。
        for i in 0..(SESSION_RETAIN_CAP + 20) {
            conn.execute(
                "INSERT INTO pomodoro_sessions (id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label) VALUES (?1,'focus','focus',?2,?2,1500,1,NULL,NULL)",
                rusqlite::params![
                    format!("s{i:05}"),
                    format!("2026-01-01T{:02}:{:02}:{:02}.000Z", i / 3600, (i % 3600) / 60, i % 60)
                ],
            )
            .unwrap();
        }
        // 再 add 一条最新会话触发剪枝。
        SessionRepo::add(
            &conn,
            &PomodoroSession {
                id: "newest".into(),
                session_type: "focus".into(),
                mode: "focus".into(),
                started_at: "2026-01-02T00:00:00.000Z".into(),
                ended_at: "2026-01-02T00:25:00.000Z".into(),
                planned_seconds: 1500,
                completed: true,
                task_id: None,
                event_label: None,
            },
        )
        .unwrap();
        let list = SessionRepo::list(&conn).unwrap();
        assert_eq!(list.len() as i64, SESSION_RETAIN_CAP);
        assert_eq!(
            list.last().unwrap().id,
            "newest",
            "list 正序输出，最新在末尾"
        );
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert!(!ids.contains(&"s00000"), "oldest rows are trimmed first");
        assert!(
            !ids.contains(&"s00020"),
            "overflow 的 20+1 条最旧行全部被裁"
        );
        assert!(ids.contains(&"s00021"), "紧随其后的行保留");
    }

    #[test]
    fn task_crud_roundtrip() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let t = TaskRepo::add(&conn, "写周报", None, None, None).unwrap();
        assert_eq!(t.title, "写周报");
        assert!(!t.completed);

        let toggled = TaskRepo::toggle(&conn, &t.id).unwrap().unwrap();
        assert!(toggled.completed);

        let list = TaskRepo::list(&conn).unwrap();
        assert_eq!(list.len(), 1);

        TaskRepo::delete(&conn, &t.id).unwrap();
        assert!(TaskRepo::list(&conn).unwrap().is_empty());
    }

    #[test]
    fn toggle_unknown_id_returns_none() {
        let conn = in_memory(MIGRATIONS).unwrap();
        assert!(TaskRepo::toggle(&conn, "missing").unwrap().is_none());
    }

    #[test]
    fn deadline_sort_and_notify() {
        let conn = in_memory(MIGRATIONS).unwrap();
        DeadlineRepo::add(&conn, "later", "2026-09-01T00:00:00Z", None).unwrap();
        DeadlineRepo::add(&conn, "sooner", "2026-08-20T00:00:00Z", None).unwrap();
        let list = DeadlineRepo::list(&conn).unwrap();
        assert_eq!(list[0].title, "sooner");
        assert_eq!(list[1].title, "later");

        DeadlineRepo::mark_notified(&conn, &list[0].id).unwrap();
        let updated = DeadlineRepo::list(&conn).unwrap();
        assert!(updated[0].notified);
    }

    #[test]
    fn backup_export_import_roundtrip() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let _t = TaskRepo::add(&conn, "任务A", None, None, None).unwrap();
        let _d = DeadlineRepo::add(&conn, "DDL", "2026-08-30T00:00:00Z", None).unwrap();
        let session = PomodoroSession {
            id: "s1".into(),
            session_type: "focus".into(),
            mode: "focus".into(),
            started_at: "2026-08-13T01:00:00Z".into(),
            ended_at: "2026-08-13T01:25:00Z".into(),
            planned_seconds: 1500,
            completed: true,
            task_id: Some("任务A".into()),
            event_label: None,
        };
        SessionRepo::add(&conn, &session).unwrap();

        let exported = BackupRepo::export_all(&conn).unwrap();
        assert_eq!(exported.tasks.len(), 1);
        assert_eq!(exported.sessions.as_ref().map(Vec::len), Some(1));

        // Clear then import back.
        conn.execute_batch(
            "DELETE FROM tasks; DELETE FROM deadlines; DELETE FROM pomodoro_sessions;",
        )
        .unwrap();
        let result = BackupRepo::import_all(&mut conn, &exported).unwrap();
        assert_eq!(result.tasks, 1);
        assert_eq!(result.deadlines, 1);
        assert_eq!(TaskRepo::list(&conn).unwrap().len(), 1);
        assert_eq!(SessionRepo::list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn import_replaces_all_data() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let _a = TaskRepo::add(&conn, "旧任务", None, None, None).unwrap();
        let fresh = AppData::default();
        let _r = BackupRepo::import_all(&mut conn, &fresh).unwrap();
        assert!(TaskRepo::list(&conn).unwrap().is_empty());
    }

    /// A-4 聚合口径：轮数只计 completed=1，秒数含中断段的实际专注时长。
    #[test]
    fn aggregate_counts_only_completed_but_sums_all_focus_seconds() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let mk = |id: &str, secs: i64, completed: bool| PomodoroSession {
            id: id.into(),
            session_type: "focus".into(),
            mode: "focus".into(),
            started_at: "2026-03-01T01:00:00.000Z".into(),
            ended_at: "2026-03-01T01:25:00.000Z".into(),
            planned_seconds: secs,
            completed,
            task_id: None,
            event_label: None,
        };
        SessionRepo::add(&conn, &mk("done", 1500, true)).unwrap();
        SessionRepo::add(&conn, &mk("abandoned", 600, false)).unwrap();
        let agg = SessionRepo::aggregate(&conn, 0).unwrap();
        assert_eq!(agg.daily.len(), 1);
        assert_eq!(agg.daily[0].focus_count, 1, "中断放弃的段不计轮数");
        assert_eq!(agg.daily[0].focus_seconds, 2100, "分钟数含部分时长");
    }

    /// v1 旧备份没有 sessions 字段：恢复必须保留库中现有专注记录；显式携带
    /// 空列表才是"清空"语义（与 interruptions 一致）。
    #[test]
    fn import_without_sessions_keeps_existing_sessions() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        SessionRepo::add(
            &conn,
            &PomodoroSession {
                id: "s-keep".into(),
                session_type: "focus".into(),
                mode: "focus".into(),
                started_at: "2026-01-01T00:00:00.000Z".into(),
                ended_at: "2026-01-01T00:25:00.000Z".into(),
                planned_seconds: 1500,
                completed: true,
                task_id: None,
                event_label: None,
            },
        )
        .unwrap();
        assert_eq!(SessionRepo::list(&conn).unwrap().len(), 1);

        // 反序列化一份不带 sessions 的 v1 载荷（前端迁移不再补 []）。
        let legacy: AppData = serde_json::from_str(r#"{"tasks":[],"deadlines":[]}"#).unwrap();
        assert!(legacy.sessions.is_none());
        BackupRepo::import_all(&mut conn, &legacy).unwrap();
        assert_eq!(
            SessionRepo::list(&conn).unwrap().len(),
            1,
            "旧备份不得清空专注记录"
        );

        let wipe = AppData {
            sessions: Some(vec![]),
            ..AppData::default()
        };
        BackupRepo::import_all(&mut conn, &wipe).unwrap();
        assert!(
            SessionRepo::list(&conn).unwrap().is_empty(),
            "显式空列表 = 清空"
        );
    }

    #[test]
    fn import_drops_non_restorable_settings_keys() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let data = AppData {
            settings: vec![
                SettingKV {
                    key: "app:settings:v1".into(),
                    value: "{}".into(),
                },
                SettingKV {
                    key: "widget:layout:home".into(),
                    value: "[]".into(),
                },
                SettingKV {
                    key: "lsmirror:focus-desk.notes".into(),
                    value: "[]".into(),
                },
                SettingKV {
                    key: "email:accounts".into(),
                    value: "[{\"host\":\"evil\"}]".into(),
                },
                SettingKV {
                    key: "email:account".into(),
                    value: "{}".into(),
                },
                SettingKV {
                    key: "evil:key".into(),
                    value: "x".into(),
                },
            ],
            ..Default::default()
        };
        BackupRepo::import_all(&mut conn, &data).unwrap();

        assert!(SettingsRepo::get(&conn, "app:settings:v1")
            .unwrap()
            .is_some());
        assert!(SettingsRepo::get(&conn, "widget:layout:home")
            .unwrap()
            .is_some());
        assert!(SettingsRepo::get(&conn, "lsmirror:focus-desk.notes")
            .unwrap()
            .is_some());
        assert!(SettingsRepo::get(&conn, "email:accounts")
            .unwrap()
            .is_none());
        assert!(SettingsRepo::get(&conn, "email:account").unwrap().is_none());
        assert!(SettingsRepo::get(&conn, "evil:key").unwrap().is_none());
    }

    // P1（审计修复回归）：导出与导入的敏感键过滤必须对称——DPAPI 凭据密文
    // 不得进入备份文件。
    #[test]
    fn export_excludes_non_restorable_settings_keys() {
        let conn = in_memory(MIGRATIONS).unwrap();
        SettingsRepo::set(&conn, "app:settings:v1", r#"{"zoom":1.0}"#).unwrap();
        // 模拟 email.rs 写入的凭据行（真实场景由 save_email_accounts 落库）。
        SettingsRepo::set(&conn, "email:accounts", "[{\"host\":\"imap.x\"}]").unwrap();
        SettingsRepo::set(&conn, "some:arbitrary:key", "v").unwrap();

        let exported = BackupRepo::export_all(&conn).unwrap();
        assert!(exported
            .settings
            .iter()
            .any(|kv| kv.key == "app:settings:v1"));
        assert!(exported
            .settings
            .iter()
            .all(|kv| !kv.key.starts_with("email:")));
        assert!(exported
            .settings
            .iter()
            .all(|kv| kv.key != "some:arbitrary:key"));
    }

    // P2（审计修复回归）：来自更新版本的备份必须在导入前被拒绝，而不是被
    // 旧二进制"部分理解地"静默变形。
    #[test]
    fn import_rejects_future_schema_version() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let data = AppData {
            schema_version: crate::models::BACKUP_SCHEMA_VERSION + 1,
            ..Default::default()
        };
        let err = BackupRepo::import_all(&mut conn, &data).unwrap_err();
        assert!(err.to_string().contains("schema 版本过新"));
        // 拒绝发生在任何写入之前。
        assert!(TaskRepo::list(&conn).unwrap().is_empty());
    }

    #[test]
    fn aggregate_groups_focus_by_local_day_full_history() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let mk = |id: &str, typ: &str, ended_at: &str, seconds: i64| PomodoroSession {
            id: id.into(),
            session_type: typ.into(),
            mode: "focus".into(),
            started_at: ended_at.into(),
            ended_at: ended_at.into(),
            planned_seconds: seconds,
            completed: true,
            task_id: None,
            event_label: None,
        };
        // 两段同一天 + 一段前一天 + 一段休息（应被排除）。
        SessionRepo::add(&conn, &mk("f1", "focus", "2026-08-13T01:00:00Z", 1500)).unwrap();
        SessionRepo::add(&conn, &mk("f2", "focus", "2026-08-13T02:00:00Z", 900)).unwrap();
        SessionRepo::add(&conn, &mk("f3", "focus", "2026-08-12T01:00:00Z", 1800)).unwrap();
        SessionRepo::add(&conn, &mk("b1", "break", "2026-08-13T03:00:00Z", 300)).unwrap();

        let agg = SessionRepo::aggregate(&conn, 0).unwrap();
        let total_seconds: i64 = agg.daily.iter().map(|d| d.focus_seconds).sum();
        let total_count: i64 = agg.daily.iter().map(|d| d.focus_count).sum();
        assert_eq!(total_seconds, 1500 + 900 + 1800);
        assert_eq!(total_count, 3);
        // 两个本地日历日；休息段不计入，故无第三日。
        assert_eq!(agg.daily.len(), 2);
        assert!(agg.daily[0].date < agg.daily[1].date);
        let counts: Vec<i64> = agg.daily.iter().map(|d| d.focus_count).collect();
        assert!(counts.contains(&1) && counts.contains(&2));
        // 同日两段聚合：该日 focus_seconds 为两段之和。
        assert!(agg.daily.iter().any(|d| d.focus_seconds == 1500 + 900));
    }

    #[test]
    fn settings_upsert_and_get() {
        let conn = in_memory(MIGRATIONS).unwrap();
        assert!(SettingsRepo::get(&conn, "widget:layout:home")
            .unwrap()
            .is_none());

        SettingsRepo::set(&conn, "widget:layout:home", r#"[{"id":"a"}]"#).unwrap();
        assert_eq!(
            SettingsRepo::get(&conn, "widget:layout:home")
                .unwrap()
                .as_deref(),
            Some(r#"[{"id":"a"}]"#)
        );

        // Upsert overwrites the existing value.
        SettingsRepo::set(&conn, "widget:layout:home", r#"[{"id":"b"}]"#).unwrap();
        assert_eq!(
            SettingsRepo::get(&conn, "widget:layout:home")
                .unwrap()
                .as_deref(),
            Some(r#"[{"id":"b"}]"#)
        );

        SettingsRepo::delete(&conn, "widget:layout:home").unwrap();
        assert!(SettingsRepo::get(&conn, "widget:layout:home")
            .unwrap()
            .is_none());
    }

    #[test]
    fn local_storage_mirror_replace_and_list() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let entries = vec![
            SettingKV {
                key: "focus-desk.notes.w1".into(),
                value: r#"[{"id":"n1"}]"#.into(),
            },
            SettingKV {
                key: "focus-desk.habits.w2".into(),
                value: "{}".into(),
            },
        ];
        crate::repositories::replace_local_storage_mirror(&mut conn, &entries).unwrap();
        let listed = crate::repositories::list_local_storage_mirror(&conn).unwrap();
        assert_eq!(listed.len(), 2);
        let keys: Vec<&str> = listed.iter().map(|e| e.key.as_str()).collect();
        assert!(keys.contains(&"focus-desk.notes.w1"));
        assert!(keys.contains(&"focus-desk.habits.w2"));

        // A second sync fully replaces (no stale rows from the first batch).
        let next = vec![SettingKV {
            key: "focus-desk.notes.w1".into(),
            value: r#"[{"id":"n2"}]"#.into(),
        }];
        crate::repositories::replace_local_storage_mirror(&mut conn, &next).unwrap();
        let listed = crate::repositories::list_local_storage_mirror(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].value.contains("n2"));

        // Mirror rows must not leak into non-mirror settings keys.
        assert!(SettingsRepo::get(&conn, "widget:layout:home")
            .unwrap()
            .is_none());
    }

    #[test]
    fn mirror_prefix_smuggling_is_neutralized() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        SettingsRepo::set(&conn, "widget:layout:home", r#"[{"id":"real"}]"#).unwrap();
        let evil = vec![SettingKV {
            key: "lsmirror:widget:layout:home".into(),
            value: r#"[{"id":"hacked"}]"#.into(),
        }];
        crate::repositories::replace_local_storage_mirror(&mut conn, &evil).unwrap();
        // The real row survives; the evil value only exists under the mirror prefix.
        assert_eq!(
            SettingsRepo::get(&conn, "widget:layout:home")
                .unwrap()
                .as_deref(),
            Some(r#"[{"id":"real"}]"#)
        );
        let listed = crate::repositories::list_local_storage_mirror(&conn).unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn backup_includes_settings_and_import_upserts() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        SettingsRepo::set(&conn, "app:settings:v1", r#"{"zoom":1.1}"#).unwrap();
        crate::repositories::replace_local_storage_mirror(
            &mut conn,
            &[SettingKV {
                key: "focus-desk.bookmarks.w1".into(),
                value: "[]".into(),
            }],
        )
        .unwrap();

        let exported = BackupRepo::export_all(&conn).unwrap();
        // Settings + the mirror row are both part of the backup payload now.
        assert!(exported
            .settings
            .iter()
            .any(|kv| kv.key == "app:settings:v1"));
        assert!(exported
            .settings
            .iter()
            .any(|kv| kv.key == "lsmirror:focus-desk.bookmarks.w1"));

        // Import into a fresh DB: both rows land.
        let mut fresh = in_memory(MIGRATIONS).unwrap();
        BackupRepo::import_all(&mut fresh, &exported).unwrap();
        assert_eq!(
            SettingsRepo::get(&fresh, "app:settings:v1")
                .unwrap()
                .as_deref(),
            Some(r#"{"zoom":1.1}"#)
        );
        assert_eq!(
            SettingsRepo::get(&fresh, "lsmirror:focus-desk.bookmarks.w1")
                .unwrap()
                .as_deref(),
            Some("[]")
        );

        // Legacy backups without a settings field still import (serde default).
        let legacy = AppData::default();
        BackupRepo::import_all(&mut fresh, &legacy).unwrap();
        // Upsert semantics: legacy restore does NOT wipe existing settings rows.
        assert!(SettingsRepo::get(&fresh, "app:settings:v1")
            .unwrap()
            .is_some());
    }

    #[test]
    fn backup_includes_interruptions_and_legacy_keeps_existing() {
        let conn = in_memory(MIGRATIONS).unwrap();
        InterruptionRepo::add(
            &conn,
            &crate::models::PomodoroInterruption {
                id: "i1".into(),
                started_at: "2026-08-13T01:05:00Z".into(),
                ended_at: "2026-08-13T01:06:00Z".into(),
                reason: "phone".into(),
                mode: "focus".into(),
                elapsed_seconds: 60,
            },
        )
        .unwrap();

        // 导出携带中断记录，恢复到新库后原样回来。
        let exported = BackupRepo::export_all(&conn).unwrap();
        assert_eq!(exported.interruptions.as_ref().unwrap().len(), 1);
        let mut fresh = in_memory(MIGRATIONS).unwrap();
        BackupRepo::import_all(&mut fresh, &exported).unwrap();
        assert_eq!(InterruptionRepo::list(&fresh).unwrap().len(), 1);

        // 旧备份（无 interruptions 字段 → None）：不触碰现有中断数据。
        let legacy = AppData::default();
        BackupRepo::import_all(&mut fresh, &legacy).unwrap();
        assert_eq!(InterruptionRepo::list(&fresh).unwrap().len(), 1);

        // 携带空列表的备份：整体替换为空（显式清空语义）。
        let wipe = AppData {
            interruptions: Some(vec![]),
            ..AppData::default()
        };
        BackupRepo::import_all(&mut fresh, &wipe).unwrap();
        assert!(InterruptionRepo::list(&fresh).unwrap().is_empty());
    }

    // ---- FocusTimer 借鉴：跨午夜切分 / 虚拟午夜 / 小时分布 ----

    use chrono::{Local, TimeZone};

    /// 在测试里构造一段专注会话（ISO 字符串与前端 toISOString 同形）。
    fn add_focus(
        conn: &rusqlite::Connection,
        id: &str,
        started_at: String,
        ended_at: String,
        planned: i64,
        completed: bool,
    ) {
        SessionRepo::add(
            conn,
            &PomodoroSession {
                id: id.into(),
                session_type: "focus".into(),
                mode: "focus".into(),
                started_at,
                ended_at,
                planned_seconds: planned,
                completed,
                task_id: None,
                event_label: None,
            },
        )
        .unwrap();
    }

    /// 用机器本地时区构造 RFC3339 字符串（会话落库即此形态）；日期选 1 月中旬，
    /// 避开主要时区的 DST 切换窗口，期望值在任意时区下均可计算。
    fn local_iso(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> String {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .expect("test date must not be a DST transition")
            .to_rfc3339()
    }

    #[test]
    fn aggregate_splits_cross_midnight_session() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 本地 23:40 → 次日 00:20：40 分钟跨午夜。
        add_focus(
            &conn,
            "s1",
            local_iso(2026, 1, 15, 23, 40),
            local_iso(2026, 1, 16, 0, 20),
            2400,
            true,
        );
        let agg = SessionRepo::aggregate(&conn, 0).unwrap();
        assert_eq!(agg.daily.len(), 2, "跨午夜会话应切分为两天");
        assert_eq!(agg.daily[0].date, "2026-01-15");
        assert_eq!(agg.daily[1].date, "2026-01-16");
        // 按墙钟占比：01-15 得 20 分钟，01-16 得 20 分钟。
        assert_eq!(agg.daily[0].focus_seconds, 1200);
        assert_eq!(agg.daily[1].focus_seconds, 1200);
        // 轮数只落在结束时刻所在日，不重复计数。
        assert_eq!(agg.daily[0].focus_count, 0);
        assert_eq!(agg.daily[1].focus_count, 1);
    }

    #[test]
    fn aggregate_respects_virtual_midnight() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 本地 01:00 → 03:00：自然午夜口径整天归 01-15；虚拟午夜 H=2 在
        // 02:00 切开——01:00-02:00 属于「昨天」（01-14）。
        add_focus(
            &conn,
            "s2",
            local_iso(2026, 1, 15, 1, 0),
            local_iso(2026, 1, 15, 3, 0),
            7200,
            true,
        );
        let natural = SessionRepo::aggregate(&conn, 0).unwrap();
        assert_eq!(natural.daily.len(), 1);
        assert_eq!(natural.daily[0].date, "2026-01-15");

        let virt = SessionRepo::aggregate(&conn, 2).unwrap();
        assert_eq!(virt.daily.len(), 2, "H=2 时 01:00-03:00 应在 02:00 切开");
        assert_eq!(virt.daily[0].date, "2026-01-14");
        assert_eq!(virt.daily[0].focus_seconds, 3600);
        assert_eq!(virt.daily[1].date, "2026-01-15");
        assert_eq!(virt.daily[1].focus_seconds, 3600);
        assert_eq!(virt.daily[1].focus_count, 1);
    }

    #[test]
    fn hourly_distribution_buckets_by_local_hour() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 本地 23:40 → 次日 00:20：40 分钟分摊到 23 点（20 分钟）与 0 点（20 分钟）。
        add_focus(
            &conn,
            "s3",
            local_iso(2026, 1, 15, 23, 40),
            local_iso(2026, 1, 16, 0, 20),
            2400,
            true,
        );
        let hourly = SessionRepo::hourly_distribution(&conn).unwrap();
        assert_eq!(hourly.len(), 24);
        let h23 = hourly.iter().find(|h| h.hour == 23).unwrap();
        let h0 = hourly.iter().find(|h| h.hour == 0).unwrap();
        assert_eq!(h23.focus_seconds, 1200);
        assert_eq!(h0.focus_seconds, 1200);
        // 轮数只落在结束小时（0 点）。
        assert_eq!(h0.focus_count, 1);
        assert_eq!(h23.focus_count, 0);
    }
}
