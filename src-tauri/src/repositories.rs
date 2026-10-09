//! 行级 SQL 仓储（Repository 模式）：tasks/deadlines/sessions/interruptions
//! 的 CRUD 与聚合查询；写操作在 commands 层包事务。
use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike};
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::db::{DbError, DbResult};
use crate::models::{
    AppData, ClipboardEntry, DailyFocusStat, Deadline, FocusAggregate, HourlyFocusStat,
    ImportResult, NotificationRecord, PomodoroInterruption, PomodoroSession, ReasonCount,
    SettingKV, Task, TaskFocusStat,
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
        // 新任务排到手动排序末尾——此前硬编码 0，用户做过一次 reorder 后
        // 每次新增都插队首。取当前最大序号 +1；从未排序时得到 0，语义不变。
        let sort_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks",
            [],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO tasks (id, title, completed, created_at, due_at, priority, tags, sort_order) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                title,
                created_at,
                due_at.unwrap_or(""),
                priority.unwrap_or(0),
                tags.unwrap_or("[]"),
                sort_order
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
            sort_order,
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

    /// 行内编辑 / 拖拽排序：按 id 更新可编辑字段。
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

    /// 多档提醒：整体覆写已发送档位集合（JSON 数组字符串）。
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

    /// 行内编辑 / 周期滚动：更新标题/截止/重复规则；reset_tiers
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

/// 会话保留上限（条数）。add 后按 started_at 保留最新 N 条，更旧的删除。
/// 统计面板以「累计/全量」为承诺（累计时长、年度热图、连胜均出自本表聚合），
/// 上限必须大到实际使用年限内不可见：20000 条 ≈ 日均 8 轮用 7 年。此前
/// 2000 条在两三年高强度使用后就会让最早的日期从「累计」里静默消失。
/// 与 NotificationRepo 的 cap 裁剪同款语义（见其 cleanup）。
pub const SESSION_RETAIN_CAP: i64 = 20000;

///planned_seconds 入库上界（366 天的秒数）——备份导入无范围校验，
/// 极端值（i64::MAX）进库会让统计聚合的乘法（× 时长毫秒）逼近 i64 上限；
/// 三处写入口径统一钳制，正产数据（≤ 数小时）远低于界。
pub const PLANNED_SECONDS_MAX: i64 = 366 * 24 * 3600;

/// 自由文本/枚举字段的入库长度上界——异常 trusted 窗口可借备份/IPC
/// 写入 MB 级字符串；正产值都是短枚举或任务标题，远低于界。
fn trunc_field(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

impl SessionRepo {
    pub fn add(conn: &Connection, session: &PomodoroSession) -> DbResult<()> {
        // 同 InterruptionRepo::add——add 侧也统一
        // normalize_ts（merge/import 已是此口径）。保留策略 ORDER BY started_at
        // 依赖字符串序 == 时间序，这只在单格式列上成立；旧格式行混入会让 cap
        // 裁剪误删新行 / 误留旧行。
        // INSERT OR IGNORE——崩溃窗口补写（hydrate 对账）是所有窗口并发
        // 执行的，同 id 竞态插入时落败方此前吃 UNIQUE 约束错误并弹用户可见
        // toast；主键冲突即「同一记录已在库」，静默幂等胜者已达成语义。正产
        // 路径的重复防护在前端 tryMarkOnce，不受影响。
        conn.execute(
            "INSERT OR IGNORE INTO pomodoro_sessions (id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                session.id,
                trunc_field(&session.session_type, 64),
                trunc_field(&session.mode, 64),
                crate::db::normalize_ts(&session.started_at),
                crate::db::normalize_ts(&session.ended_at),
                session.planned_seconds.clamp(0, PLANNED_SECONDS_MAX),
                if session.completed { 1 } else { 0 },
                session.task_id.as_deref().map(|t| trunc_field(t, 256)),
                session.event_label.as_deref().map(|t| trunc_field(t, 256)),
            ],
        )?;
        // 保留策略：子查询倒序取最新 N 条，删除不在其中的行。：先走
        // 索引计数，低于 cap 直接跳过——此前每次写都付 O(cap) 的子查询物化
        // + NOT IN 反连接，cap 扩到 20000 后写放大随上限线性放大（表远小于
        // cap 时该 DELETE 纯属空转）。
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM pomodoro_sessions", [], |r| r.get(0))?;
        if count > SESSION_RETAIN_CAP {
            conn.execute(
                "DELETE FROM pomodoro_sessions WHERE id NOT IN (SELECT id FROM pomodoro_sessions ORDER BY started_at DESC LIMIT ?1)",
                params![SESSION_RETAIN_CAP],
            )?;
        }
        Ok(())
    }

    /// （备份导入批量合并）：incoming 与库中现存行按 id 做并集——id 冲突时
    /// **库中现存行胜**（与前端逐条导入路径「已存在即跳过」的语义一致），incoming
    /// 独有的行插入。单事务完成「快照 + 补插 + cap 裁剪」三步：
    ///  - 此前前端「先 list_sessions 快照、再逐条 add_session」是 N+1 次串行 IPC
    ///    往返（500 条备份 = 500 次），且快照与插入之间存在跨窗口竞态——两步之间
    ///    其他窗口新写的同 id 行会让 INSERT 撞 UNIQUE 约束炸掉整次导入；
    ///  - 与 BackupRepo::import_core_merge 的 sessions 分支同语义，但只动
    ///    sessions 一张表：导入路径对 tasks/deadlines 走整表替换语义
    ///    （import_core_data_keep_sessions），不能整体套用 merge 命令。
    ///
    /// 时间戳经 normalize_ts 归一（与导入路径其余表同口径）；cap 裁剪整批
    /// 只做一次（逐条 add 的最终态等价：最后一趟裁剪覆盖全部新行）。
    /// 返回实际插入的行数（幂等重放 = 0）。
    pub fn merge(conn: &mut Connection, incoming: &[PomodoroSession]) -> DbResult<usize> {
        let tx = conn.transaction()?;
        let existing: std::collections::HashSet<String> = {
            let mut stmt = tx.prepare("SELECT id FROM pomodoro_sessions")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<std::collections::HashSet<_>, _>>()?
        };
        let mut inserted = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO pomodoro_sessions (id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            )?;
            for s in incoming {
                if existing.contains(&s.id) {
                    continue;
                }
                stmt.execute(params![
                    s.id,
                    trunc_field(&s.session_type, 64),
                    trunc_field(&s.mode, 64),
                    crate::db::normalize_ts(&s.started_at),
                    crate::db::normalize_ts(&s.ended_at),
                    s.planned_seconds.clamp(0, PLANNED_SECONDS_MAX),
                    if s.completed { 1 } else { 0 },
                    s.task_id.as_deref().map(|t| trunc_field(t, 256)),
                    s.event_label.as_deref().map(|t| trunc_field(t, 256)),
                ])?;
                inserted += 1;
            }
        }
        // 保留策略：与 add 同款裁剪（导入是显式用户意图，只在批量合并的
        // 收尾裁一次，不在逐行间丢数据）；计数门同 add。
        let count: i64 =
            tx.query_row("SELECT COUNT(*) FROM pomodoro_sessions", [], |r| r.get(0))?;
        if count > SESSION_RETAIN_CAP {
            tx.execute(
                "DELETE FROM pomodoro_sessions WHERE id NOT IN (SELECT id FROM pomodoro_sessions ORDER BY started_at DESC LIMIT ?1)",
                params![SESSION_RETAIN_CAP],
            )?;
        }
        tx.commit()?;
        Ok(inserted)
    }

    pub fn list(conn: &Connection) -> DbResult<Vec<PomodoroSession>> {
        Self::list_limited(conn, None)
    }

    /// + 修复：带上限的会话读取。`limit = Some(n)` 时把 LIMIT
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

    /// 单次只读扫描内完成按日聚合（供累计统计与年度热图在 >500 段会话
    /// 时仍取全量，而非前端内存截断的最近 500 条）。
    /// `session_type='focus'` 才算专注；本地日历日口径与前端 `new Date(endedAt)`
    /// 一致。
    /// 口径（与前端 analytics.ts / PomodoroPanel 一致）：**轮数只计
    /// completed=1**——中断放弃的段落有 completed=0 记录，此前 COUNT(*) 把它们
    /// 也算作完成轮数，连续启动-放弃即可"达成每日目标"刷连胜；**分钟数**仍含
    /// 部分时长（planned_seconds 在中断时写的是实际专注秒数）。
    ///
    /// （跨午夜切分 + 虚拟午夜）：跨日会话不再整天归入
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
            for (i, piece) in pieces.iter().enumerate() {
                let (piece_start, _piece_end, seconds, _last) = piece;
                let entry = daily
                    .entry(virtual_day_key(*piece_start, virtual_midnight_hour))
                    .or_insert((0, 0));
                entry.0 += *seconds;
                // 轮数只记一次：落在首片（段起始时刻所属虚拟日）——与前端
                // countFocusToday/goalStreakDays 等「按起始虚拟日归组轮数」的
                // 口径一致；此前记在末片会让跨午夜完成段在两个面板分属两天。
                if i == 0 && completed {
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

    /// 24 小时时段分布。秒数按本地小时边界切分分摊；轮数
    /// 落在会话结束时刻的小时（含未完成段——分布图反映「在几点花过时间」）。
    pub fn hourly_distribution(conn: &Connection) -> DbResult<Vec<HourlyFocusStat>> {
        let rows = Self::load_focus_rows(conn)?;
        let mut buckets: Vec<(i64, i64)> = vec![(0, 0); 24];
        for (start, end, planned, _completed) in rows {
            let boundaries = hour_boundaries(&start, &end);
            let pieces = split_proportional(&start, &end, planned, &boundaries);
            if pieces.is_empty() {
                // 旧版本兼容：零时长行整段记入 ended_at 的小时（计次口径与
                // 正常行一致——计数=在该小时结束过的段数，不分 completed）。
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

    /// （任务用时归集 SQL 全量化）：按专注事件（待办 / 自定义事件）聚合
    /// **已完成**专注段的秒数与段数，供统计面板的「专注时长分布」饼图突破
    /// 前端 SESSIONS_CAP=500 的内存截断。：分组键与前端口径一致——
    /// taskId 优先（同一 task 的不同 label 归并为一组），否则 `label:事件名`，
    /// 都没有则「未关联」一组；`LIKE '____-__-__T%'` 形态过滤——
    /// 此前的 `<> ''` 只堵空串，normalize_ts 对不可解析输入原样放行，任意
    /// 非空垃圾串仍会计入饼图却被 load_focus_rows 的 解析跳过（两
    /// 面板对不上）；LIKE 与两侧解析可行的形态对齐并顺带覆盖空串。
    /// （备案）：`'label:'` 前缀编码对 task_id 值域有隐式假设——task_id
    /// 以 `label:` 开头的构造行会被解码为 event_label 归并。现网 task_id 恒
    /// 为 UUID（前端 crypto.randomUUID）不以 `label:` 开头，前端内存路径
    /// （analytics.ts 同款前缀键）两侧口径一致，不可触发；双列分组留待
    /// 写入口重构时顺手。
    /// 跨午夜不需要切分：任务归属与日界无关，整段计入。
    pub fn task_breakdown(conn: &Connection) -> DbResult<Vec<TaskFocusStat>> {
        let mut stmt = conn.prepare(
            "SELECT
               CASE
                 WHEN task_id IS NOT NULL AND task_id <> '' THEN task_id
                 WHEN event_label IS NOT NULL AND event_label <> '' THEN 'label:' || event_label
                 ELSE ''
               END AS grp,
               SUM(planned_seconds), COUNT(*)
             FROM pomodoro_sessions
             WHERE session_type = 'focus' AND completed = 1 AND ended_at LIKE '____-__-__T%'
             GROUP BY grp",
        )?;
        let rows = stmt.query_map([], |r| {
            let grp: String = r.get(0)?;
            let (task_id, event_label) = if grp.is_empty() {
                (None, None)
            } else if let Some(label) = grp.strip_prefix("label:") {
                (None, Some(label.to_string()))
            } else {
                (Some(grp), None)
            };
            Ok(TaskFocusStat {
                task_id,
                event_label,
                focus_seconds: r.get(1)?,
                sessions: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
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

/* ---------- 时间切分纯函数（aggregate / hourly 共用） ---------- */

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
        /*中间积走 i128——total（planned_seconds）随备份导入入库、
        无上界校验，i64 乘法在极端值下 debug 直接 panic / release 回绕出
        垃圾统计；除回后的商有界，i64 as 收回安全。 */
        let secs = ((total as i128) * ((b.clone() - prev.clone()).num_milliseconds() as i128)
            / (total_ms as i128)) as i64;
        allocated = allocated.saturating_add(secs);
        out.push((prev.clone(), b.clone(), secs, false));
        prev = b.clone();
    }
    out.push((
        prev,
        end.clone(),
        total.saturating_sub(allocated).max(0),
        true,
    ));
    out
}

/// Interruption repository (aborted pomodoro focus segments).
pub struct InterruptionRepo;

impl InterruptionRepo {
    /// 中断记录保留上限：低频但无限增长（每次中断/暂停都会落一行），且随
    /// 备份导出/导入整表搬运会放大膨胀——与 sessions 的 保留同款裁剪。
    /// 月度打断统计以此为「全量」数据源，上限与 sessions 同步放大。
    pub const RETENTION_CAP: i64 = 10000;

    pub fn add(conn: &Connection, i: &PomodoroInterruption) -> DbResult<()> {
        // 落库前统一过 normalize_ts——与 merge/import 的
        // (started_at, ended_at, reason) 归一复合键同口径。此前 add 原样落库，
        // 异构格式（旧版 +08:00 偏移 / 秒级精度）的历史行在备份合并时与归一后
        // 的 incoming 键不相等，同一段中断被当作「独有行」重复插行。
        // elapsed_seconds 钳制与 reason/mode 截断——对位 只修了
        // sessions.planned_seconds，此处载荷此前零校验（i64::MAX / MB 级 reason
        // 可直接入库，拖累 monthly_breakdown 的全表扫）。
        // INSERT OR IGNORE——会话侧 add 同款（多窗并发崩溃补写的 UNIQUE
        // 竞态幂等化）。
        conn.execute(
            "INSERT OR IGNORE INTO pomodoro_interruptions (id, started_at, ended_at, reason, mode, elapsed_seconds) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                i.id,
                crate::db::normalize_ts(&i.started_at),
                crate::db::normalize_ts(&i.ended_at),
                trunc_field(&i.reason, 64),
                trunc_field(&i.mode, 64),
                i.elapsed_seconds.clamp(0, PLANNED_SECONDS_MAX),
            ],
        )?;
        // 写入路径顺手打扫（与 NotificationRepo 同策略）：保留最新 N 条。
        // 索引计数门——低于 cap 跳过 O(cap) 的子查询物化 + NOT IN 反连接
        // （ORDER BY started_at 依赖 v11 索引，见 db.rs）。
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM pomodoro_interruptions", [], |r| {
                r.get(0)
            })?;
        if count > Self::RETENTION_CAP {
            conn.execute(
                "DELETE FROM pomodoro_interruptions WHERE id NOT IN (
                    SELECT id FROM pomodoro_interruptions ORDER BY started_at DESC, rowid DESC LIMIT ?1
                )",
                params![Self::RETENTION_CAP],
            )?;
        }
        Ok(())
    }

    pub fn list(conn: &Connection) -> DbResult<Vec<PomodoroInterruption>> {
        Self::list_limited(conn, None)
    }

    /// （limit 下推，对位 SessionRepo::list_limited）：`limit = Some(n)` 时
    /// LIMIT 下推进 SQL（子查询倒序取最近 n 条再正序输出），供水合只拉
    /// INTERRUPTIONS_CAP 条而非整表（retention 扩到 10000 后，整表拉回再
    /// 丢弃 97% 的 IPC 成本随上限线性放大）；`None` 保持全量旧行为。
    pub fn list_limited(
        conn: &Connection,
        limit: Option<i64>,
    ) -> DbResult<Vec<PomodoroInterruption>> {
        // SQLite 中 LIMIT 为负数时表示无限制，因此统一走子查询路径。
        let sql = "SELECT id, started_at, ended_at, reason, mode, elapsed_seconds FROM (
                     SELECT id, started_at, ended_at, reason, mode, elapsed_seconds
                     FROM pomodoro_interruptions ORDER BY started_at DESC, rowid DESC LIMIT ?1
                   ) ORDER BY started_at";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit.unwrap_or(-1)], |r| {
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

    /// ()（备份导入批量合并，的 interruptions 对位）：incoming 与库中
    /// 现存行按 (started_at, ended_at, reason) 复合键做并集——键冲突时库中现存
    /// 行胜，incoming 独有行插入。中断的 id 是各窗口独立生成的随机 UUID（同一段
    /// 中断经跨窗同步与备份导入两路径会有两个 id），id 不具合并语义；复合键与
    /// 前端 sync:interruption 增量包的去重键同口径。单事务完成「快照 + 补插 +
    /// cap 裁剪」，把此前前端「list_interruptions 快照 + 逐条 add_interruption」
    /// 的 N+1 次串行 IPC 与两步间的跨窗口竞态一并收口。返回实际插入行数。
    pub fn merge(conn: &mut Connection, incoming: &[PomodoroInterruption]) -> DbResult<usize> {
        let tx = conn.transaction()?;
        let existing: std::collections::HashSet<(String, String, String)> = {
            let mut stmt =
                tx.prepare("SELECT started_at, ended_at, reason FROM pomodoro_interruptions")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<Result<std::collections::HashSet<_>, _>>()?
        };
        // RUST-2：id 是主键——「同 id、复合键不同」的手工拼接/损坏载荷会让
        // INSERT 撞 PRIMARY KEY、整批导入失败（fail-closed 无损坏，但整事务
        // 回滚打断导入链）。库中已有该 id 即跳过（库中行胜，与 并集语义
        // 一致），与复合键判重双闸并行。
        let mut existing_ids: std::collections::HashSet<String> = {
            let mut stmt = tx.prepare("SELECT id FROM pomodoro_interruptions")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<std::collections::HashSet<_>, _>>()?
        };
        let mut inserted = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO pomodoro_interruptions (id, started_at, ended_at, reason, mode, elapsed_seconds) VALUES (?1,?2,?3,?4,?5,?6)",
            )?;
            for i in incoming {
                // reason 截断必须进**判重键**——add 落库的行已被截到 64
                // 字符，>64 的 reason 经 merge 用原文比对会与库中截断行不相等
                // 而重复插行（键与入库值必须同口径）。
                let key = (
                    crate::db::normalize_ts(&i.started_at),
                    crate::db::normalize_ts(&i.ended_at),
                    trunc_field(&i.reason, 64),
                );
                if existing.contains(&key) || existing_ids.contains(&i.id) {
                    continue;
                }
                stmt.execute(params![
                    i.id,
                    key.0,
                    key.1,
                    key.2,
                    trunc_field(&i.mode, 64),
                    i.elapsed_seconds.clamp(0, PLANNED_SECONDS_MAX)
                ])?;
                // 载荷内部也可能同 id 双行（损坏文件）——登记防第二条撞主键。
                existing_ids.insert(i.id.clone());
                inserted += 1;
            }
        }
        // RETENTION_CAP：与 add 同款裁剪（导入是显式用户意图，只在批量合并
        // 的收尾裁一次）；计数门同 add。
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM pomodoro_interruptions", [], |r| {
            r.get(0)
        })?;
        if count > Self::RETENTION_CAP {
            tx.execute(
                "DELETE FROM pomodoro_interruptions WHERE id NOT IN (
                    SELECT id FROM pomodoro_interruptions ORDER BY started_at DESC, rowid DESC LIMIT ?1
                )",
                params![Self::RETENTION_CAP],
            )?;
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// （打断统计 SQL 全量化）：某虚拟日历月内各中断原因的计数。打断是
    /// 瞬时事件（不跨日切分），按**开始时刻**所属虚拟日归月——与会话侧
    /// 「按起始虚拟日归组」的统一规则一致（跨午夜打断不再记入次日）；
    /// 突破前端 300 条内存截断。结果按次数降序、原因升序稳定排序。
    pub fn monthly_breakdown(
        conn: &Connection,
        virtual_midnight_hour: i64,
        year: i32,
        month0: i32,
    ) -> DbResult<Vec<ReasonCount>> {
        let mut stmt = conn.prepare("SELECT started_at, reason FROM pomodoro_interruptions")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let prefix = format!("{:04}-{:02}", year, month0 + 1);
        let mut map: BTreeMap<String, i64> = BTreeMap::new();
        for row in rows {
            let (started_raw, reason) = row?;
            let Ok(started) = DateTime::parse_from_rfc3339(&started_raw) else {
                continue;
            };
            let key = virtual_day_key(started.with_timezone(&Local), virtual_midnight_hour);
            if !key.starts_with(&prefix) {
                continue;
            }
            *map.entry(reason).or_insert(0) += 1;
        }
        let mut out: Vec<ReasonCount> = map
            .into_iter()
            .map(|(reason, count)| ReasonCount { reason, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));
        Ok(out)
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
    /// （per-source 配额）：单一高频来源（天气循环/告警风暴）可把其它来源
    /// 整段挤出 500 条全局上限——先按来源各留最新 N/5，再裁全局总量。
    /// 跨日翻转也会调（写路径顺手清理之外的兜底），pub(crate)。
    pub(crate) fn cleanup(conn: &Connection) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute(
            "DELETE FROM notification_history WHERE expires_at < ?1",
            params![now],
        )?;
        conn.execute(
            "DELETE FROM notification_history WHERE id IN (
                SELECT id FROM (
                    SELECT id, source,
                        ROW_NUMBER() OVER (PARTITION BY source ORDER BY created_at DESC, rowid DESC) AS rn
                    FROM notification_history
                ) WHERE rn > ?1
            )",
            params![NOTIFICATION_HISTORY_CAP / 5],
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
    /// [FILES]文件条目的路径列表（JSON 数组字符串）。
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

/// 全列（`get` / restore / 删除回读用，含全文）。
const CLIP_COLUMNS: &str =
    "id, kind, preview, text, image_file, image_w, image_h, image_bytes, files, source_app, pinned, created_at";

/// 列表列（`list` / `list_recent` 用）：全文不下发（此前 200+ 条 × 每行
/// 至多 512KB 的 text 随每次复制刷新全量过 IPC，而前端只拿它数行数），第 4
/// 列置 NULL，行数由 SQL 现算补齐（与前端旧 lineCountOf 同口径：\n 计数、
/// 结尾换行不补、空串为 0）。
const CLIP_SUMMARY_COLUMNS: &str = "id, kind, preview, NULL, image_file, image_w, image_h, image_bytes, files, source_app, pinned, created_at, \
    CASE WHEN text IS NULL OR text = '' THEN 0 \
     ELSE LENGTH(text) - LENGTH(REPLACE(text, CHAR(10), '')) \
          + (CASE WHEN SUBSTR(text, -1) = CHAR(10) THEN 0 ELSE 1 END) END";

/// 文本行数（与前端旧 lineCountOf 同口径）：\n 计数 +（结尾非换行时）1；
/// 空串 / None 为 0。`get` 全文路径在 Rust 侧现算（纯函数，单测覆盖）。
fn count_lines(text: Option<&str>) -> i64 {
    let Some(t) = text else { return 0 };
    if t.is_empty() {
        return 0;
    }
    let n = t.matches('\n').count() as i64;
    if t.ends_with('\n') {
        n
    } else {
        n + 1
    }
}

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
        let text: Option<String> = r.get(3)?;
        Ok(ClipboardEntry {
            id: r.get(0)?,
            kind: r.get(1)?,
            preview: r.get(2)?,
            text_lines: count_lines(text.as_deref()),
            text,
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

    /// 列表路径的行映射：text 恒为 None，行数读第 13 列（SQL 现算）。
    fn row_to_entry_summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardEntry> {
        Ok(ClipboardEntry {
            id: r.get(0)?,
            kind: r.get(1)?,
            preview: r.get(2)?,
            text: None,
            text_lines: r.get(12)?,
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

    /// 最近 N 条（按 created_at 倒序；无关置顶）的 id 与哈希——去重不只比对
    /// 最新一条：A→B→A 序列里第三个 A 哈希 ≠ 最新 B，此前再次 INSERT 入史
    /// （A-B-A 重复）。
    fn recent(conn: &Connection, n: i64) -> DbResult<Vec<(String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT id, hash FROM clipboard_history ORDER BY created_at DESC, rowid DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![n], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 入库一条新捕获：与最近若干条哈希相同 → 只刷新时间戳（置顶到最前）；否则
    /// 插入并顺手做过期/超量清理。
    pub fn record(
        conn: &Connection,
        input: &NewClipboardEntry,
    ) -> DbResult<ClipboardRecordOutcome> {
        let kind = normalize_clip_kind(&input.kind);
        for (recent_id, recent_hash) in Self::recent(conn, 50)? {
            if recent_hash == input.hash {
                let entry = Self::touch(conn, &recent_id)?
                    .ok_or_else(|| DbError::Task("clipboard recent row vanished".into()))?;
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
            text_lines: count_lines(input.text.as_deref()),
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
    /// 大小写不敏感（ASCII）子串匹配，`%`/`_` 按字面转义。查询词本身是类型
    /// 词（「图片 / image / 文件 / files …」）时对应 kind 的行也算命中——
    /// 图片行 preview 为空串，不过滤就整类被搜索隐掉。全文只参与 LIKE 匹配，
    /// 不随行列下发（见 CLIP_SUMMARY_COLUMNS）。
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
                    "SELECT {CLIP_SUMMARY_COLUMNS} FROM clipboard_history ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?1"
                ))?;
                let rows = stmt.query_map(params![limit], Self::row_to_entry_summary)?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            }
            Some(q) => {
                let pattern = format!("%{}%", escape_like(q));
                let sql = match search_kind_filter(q) {
                    None => format!(
                        "SELECT {CLIP_SUMMARY_COLUMNS} FROM clipboard_history \
                         WHERE preview LIKE ?1 ESCAPE '\\' OR (text IS NOT NULL AND text LIKE ?1 ESCAPE '\\') \
                         ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?2"
                    ),
                    Some(_) => format!(
                        "SELECT {CLIP_SUMMARY_COLUMNS} FROM clipboard_history \
                         WHERE preview LIKE ?1 ESCAPE '\\' OR (text IS NOT NULL AND text LIKE ?1 ESCAPE '\\') OR kind = ?3 \
                         ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?2"
                    ),
                };
                let mut stmt = conn.prepare(&sql)?;
                let rows = match search_kind_filter(q) {
                    Some(kind) => {
                        stmt.query_map(params![pattern, limit, kind], Self::row_to_entry_summary)?
                    }
                    None => stmt.query_map(params![pattern, limit], Self::row_to_entry_summary)?,
                };
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            }
        }
    }

    /// 最近 N 条（纯 created_at 倒序，置顶不前置）：迷你磁贴的「最近一条」
    /// 视角——置顶是列表浏览语义，不该霸占迷你位。
    pub fn list_recent(conn: &Connection, limit: i64) -> DbResult<Vec<ClipboardEntry>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CLIP_SUMMARY_COLUMNS} FROM clipboard_history ORDER BY created_at DESC, rowid DESC LIMIT ?1"
        ))?;
        let rows = stmt.query_map(params![limit], Self::row_to_entry_summary)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
    /// 跨日翻转也会调（写路径顺手清理之外的兜底），pub(crate)。
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
        // [FILES]文件类条目（CF_HDROP 捕获）。
        "files" => "files",
        _ => "text",
    }
}

/// 搜索词 → 类型过滤（大小写不敏感，中文 / 英文别名）：图片行 preview 为空、
/// 文件行 preview 只有文件名——纯内容匹配搜不到「所有截图」这类意图，查询词
/// 本身是类型词时把整类 kind 拉回来。
fn search_kind_filter(q: &str) -> Option<&'static str> {
    match q.trim().to_lowercase().as_str() {
        "图片" | "image" | "img" | "photo" | "照片" | "截图" | "screenshot" => Some("image"),
        "文件" | "files" | "file" | "文件夹" | "folder" => Some("files"),
        _ => None,
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

    /// 列出键以 `prefix` 开头的全部条目（monitor.rs 的空屏对账按
    /// `widget:layout:<slot>:` 前缀直接扫布局镜像用）。prefix 由调用方拼接，
    /// 恒为应用自控的 `widget:layout:<N>:` 一类字面量；仍按字面转义
    /// （`escape_like` + `ESCAPE '\'`，与 ClipboardRepo::list :952 同款）——
    /// 未来新增调用方传入含 `%`/`_` 的前缀时不会悄悄退化成通配匹配。
    pub fn list_by_prefix(conn: &Connection, prefix: &str) -> DbResult<Vec<(String, String)>> {
        let pattern = format!("{}%", escape_like(prefix));
        let mut stmt =
            conn.prepare("SELECT key, value FROM settings WHERE key LIKE ?1 ESCAPE '\\'")?;
        let rows = stmt.query_map(params![pattern], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
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

/// Replaces the whole localStorage mirror inside one transaction: the final
/// table content always equals "drop all `lsmirror:*` rows, insert the given
/// entries". The frontend calls this right before creating a backup so the
/// snapshot is fresh.
/// 实现改为增量 diff（此前整表 DELETE + 全量重插，写放大随镜像规模
/// 线性涨，而每次自动备份前都会跑一遍）——单事务内 SELECT 现存行，值有
/// 变化或新增的 UPSERT、载荷中消失的 DELETE，语义与整表替换等价。
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
    {
        // 事务内快照现存 (key, value)，作为 diff 基线。
        let mut existing: std::collections::HashMap<String, String> = {
            let mut stmt = tx.prepare("SELECT key, value FROM settings WHERE key LIKE ?1")?;
            let rows = stmt.query_map(params![format!("{LS_MIRROR_PREFIX}%")], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<std::collections::HashMap<_, _>, _>>()?
        };
        {
            let mut upsert = tx.prepare(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?;
            for e in entries {
                // Defensive: strip any smuggled prefix so a crafted key can't
                // clobber real settings rows (e.g. "widget:layout:home").
                // 此前用 replace() 会把 key 中间出现的子串也删掉
                // （如 "notes.lsmirror:x" → "notes.x"），镜像 key 被无声改写。
                // 防走私只需保证开头不是前缀，用 strip_prefix 只剥离开头一次。
                let stripped = e.key.strip_prefix(LS_MIRROR_PREFIX).unwrap_or(&e.key);
                let key = format!("{LS_MIRROR_PREFIX}{stripped}");
                // 值未变化的行零写入（remove 顺带把「载荷仍携带的键」从
                // 消失集中排除；重复键以最后一次为准，与整表替换一致）。
                if existing.remove(&key).as_deref() != Some(e.value.as_str()) {
                    upsert.execute(params![key, e.value])?;
                }
            }
        }
        // 剩余 = 载荷中消失的键 → 删除。
        if !existing.is_empty() {
            let mut del = tx.prepare("DELETE FROM settings WHERE key = ?1")?;
            for key in existing.keys() {
                del.execute(params![key])?;
            }
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
        // 导出与导入的敏感键过滤必须对称。导入侧有
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
            // 导出即打上当前版本号，供恢复时的前置校验判断兼容性。
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
        Self::import_inner(conn, data, ImportMode::ReplaceAll)
    }

    /// 除 sessions 外与 [`import_all`] 语义一致；
    /// sessions 一律以**同一事务内 SELECT 到的库中现存行**充当载荷（前端
    /// 载荷里的 sessions 字段被忽略）。快照与整表替换收口在同一事务里，
    /// 「先 list_sessions 再 import_data」两步之间其他窗口新写的行不再被
    /// 被静默删除。
    pub fn import_core_keep_sessions(
        conn: &mut Connection,
        data: &AppData,
    ) -> DbResult<ImportResult> {
        Self::import_inner(conn, data, ImportMode::KeepExistingSessions)
    }

    /// （迁移重设计）：legacy 浏览器快照与库中现存数据在**同一事务内**按
    /// id 做并集合并——冲突时**库中现存行胜**（库行代表迁移后新建/更新的
    /// 数据，legacy 快照更旧），legacy 独有的行插入。取代前端的
    /// 「list_sessions 快照 → 按 id 合并 → import_data 整表替换」两步路径
    /// （快照与替换之间存在跨窗口竞态，轮在 CSV 导入路径修过的同一模式）
    /// 与行数启发式（legacy 行数不多于库则整体放弃，legacy 独有行被永久
    /// 丢弃）。载荷的 settings / interruptions 一律不生效：迁移只搬
    /// tasks/deadlines/sessions，设置与中断记录保持库中现状（也堵住了
    /// import_data 那条「写 app:settings:v1 → 更新链 RCE」的敏感面，见
    /// commands.rs 的 闸门注释）。
    pub fn import_core_merge(conn: &mut Connection, data: &AppData) -> DbResult<ImportResult> {
        Self::import_inner(conn, data, ImportMode::MergeById)
    }

    /// 导入语义分派（三种命令共用一份替换路径，避免三份复制）：
    /// - [`ImportMode::ReplaceAll`]：全部表按载荷（import_data 既有语义）。
    /// - [`ImportMode::KeepExistingSessions`]：sessions 以事务内库中现存行为准。
    /// - [`ImportMode::MergeById`]：tasks/deadlines/sessions 按id并集，库中行胜。
    fn import_inner(
        conn: &mut Connection,
        data: &AppData,
        mode: ImportMode,
    ) -> DbResult<ImportResult> {
        // 版本号此前只在导出侧打标、导入端不检查。来自
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
        // 按模式求出本次实际落库的三张核心表内容（见 ImportMode 注释）：
        // keep 模式在事务内快照现存 sessions 当载荷；merge 模式对三张表都
        // 做按 id 并集（现存行胜）。随后的 DELETE + INSERT 共享同一段代码。
        let (tasks, deadlines, sessions): (Vec<Task>, Vec<Deadline>, Option<Vec<PomodoroSession>>) =
            match mode {
                ImportMode::ReplaceAll => (
                    data.tasks.clone(),
                    data.deadlines.clone(),
                    data.sessions.clone(),
                ),
                ImportMode::KeepExistingSessions => (
                    data.tasks.clone(),
                    data.deadlines.clone(),
                    Some(SessionRepo::list(&tx)?),
                ),
                ImportMode::MergeById => {
                    let payload_sessions = data.sessions.clone().unwrap_or_default();
                    (
                        merge_rows_by_id(TaskRepo::list(&tx)?, &data.tasks, |t| &t.id),
                        merge_rows_by_id(DeadlineRepo::list(&tx)?, &data.deadlines, |d| &d.id),
                        Some(merge_rows_by_id(
                            SessionRepo::list(&tx)?,
                            &payload_sessions,
                            |s| &s.id,
                        )),
                    )
                }
            };
        tx.execute_batch("DELETE FROM tasks; DELETE FROM deadlines;")?;
        // 导入时间戳归一到 UTC-Z 毫秒（与 DeadlineRepo::add/update、迁移
        // v6 同口径）——旧格式备份（+08:00 / 秒精度）原样入库会让
        // `ORDER BY due_at` 字符串排序错乱、前端 zod .datetime 校验拒收、
        // 导出→导入往返校验失败。normalize_ts 对不可解析输入原样放行；
        // merge 模式下来自库中的行入库时已归一，再过一次幂等无副作用。
        for t in &tasks {
            tx.execute(
                "INSERT INTO tasks (id, title, completed, created_at, due_at, priority, tags, sort_order) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    t.id,
                    t.title,
                    if t.completed { 1 } else { 0 },
                    crate::db::normalize_ts(&t.created_at),
                    crate::db::normalize_ts(&t.due_at),
                    t.priority,
                    t.tags,
                    t.sort_order
                ],
            )?;
        }
        for d in &deadlines {
            tx.execute(
                "INSERT INTO deadlines (id, title, due_at, notified, completed, notified_tiers, repeat) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    d.id,
                    d.title,
                    crate::db::normalize_ts(&d.due_at),
                    if d.notified { 1 } else { 0 },
                    if d.completed { 1 } else { 0 },
                    d.notified_tiers,
                    d.repeat
                ],
            )?;
        }
        // 专注记录与中断记录同款语义：只在备份携带该字段时整体替换；旧备份
        // （None）不触碰现有数据。merge 模式恒为 Some（并集结果）。
        // 备份恢复恰是 点名的威胁向量——本路径此前零截断零钳制，
        // 被动过手脚的备份文件可整表写入 MB 级 reason / i64::MAX；现与
        // SessionRepo::add 同口径（枚举 64 / 自由文本 256 / planned 钳制）。
        if let Some(list) = &sessions {
            tx.execute_batch("DELETE FROM pomodoro_sessions;")?;
            for s in list {
                tx.execute(
                    "INSERT INTO pomodoro_sessions (id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![s.id, trunc_field(&s.session_type, 64), trunc_field(&s.mode, 64), crate::db::normalize_ts(&s.started_at), crate::db::normalize_ts(&s.ended_at), s.planned_seconds.clamp(0, PLANNED_SECONDS_MAX), if s.completed { 1 } else { 0 }, s.task_id.as_deref().map(|t| trunc_field(t, 256)), s.event_label.as_deref().map(|t| trunc_field(t, 256))],
                )?;
            }
        }
        // 中断记录只在备份携带该字段时整体替换；旧备份（None）不触碰现有
        // 数据 —— 与 settings 的"缺省即保留"语义保持一致。merge 模式不进入
        // 本分支（迁移不搬中断记录，库中现状即终态）。：同款截断/钳制。
        if mode != ImportMode::MergeById {
            if let Some(list) = &data.interruptions {
                tx.execute_batch("DELETE FROM pomodoro_interruptions;")?;
                for i in list {
                    tx.execute(
                        "INSERT INTO pomodoro_interruptions (id, started_at, ended_at, reason, mode, elapsed_seconds) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![i.id, crate::db::normalize_ts(&i.started_at), crate::db::normalize_ts(&i.ended_at), trunc_field(&i.reason, 64), trunc_field(&i.mode, 64), i.elapsed_seconds.clamp(0, PLANNED_SECONDS_MAX)],
                    )?;
                }
            }
        }
        // settings 只在 ReplaceAll / KeepExistingSessions 模式经 UPSERT 落库
        // （缺键保留）。merge 模式（迁移专用）不写任何设置行——载荷也不该
        // 携带；万一携带（伪造 / 误用）只留痕丢弃，绝不给「绕过 settings 闸门
        // 写 app:settings:v1」留缝。
        if mode == ImportMode::MergeById {
            if !data.settings.is_empty() {
                log::warn!(
                    "import_core_merge: dropping {} payload setting rows (merge mode never writes settings)",
                    data.settings.len()
                );
            }
        } else {
            let mut stmt = tx.prepare(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?;
            for kv in &data.settings {
                // only restore keys the app legitimately owns. A crafted
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
        // 导入若改写了设置镜像（`app:settings:v1`），落库后必须广播
        // ——否则防截屏 / 双击触发 / 超级面板 / 推送服务等镜像消费者最长
        // 60s 仍用旧配置（与 set_setting 写路径的 广播同款；notify 只碰
        // GENERATION 锁，在 DB 临界区内调用无锁序问题）。merge 模式不写
        // 设置，天然无需广播。
        if mode != ImportMode::MergeById
            && data
                .settings
                .iter()
                .any(|kv| kv.key == crate::settings_mirror::MIRROR_KEY)
        {
            crate::settings_mirror::notify_changed();
        }
        // a full-table replace is exactly the "heavy write" that inflates
        // the WAL; truncate it back so the -wal file can't grow unbounded.
        crate::db::checkpoint(conn);
        Ok(ImportResult {
            tasks: tasks.len(),
            deadlines: deadlines.len(),
        })
    }
}

/// [`BackupRepo::import_inner`] 的语义分派（见其注释）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum ImportMode {
    /// import_data：全部表按载荷整体替换。
    ReplaceAll,
    /// import_core_data_keep_sessions：sessions 以事务内库中现存行为准。
    KeepExistingSessions,
    /// import_core_data_merge：tasks/deadlines/sessions 按 id 并集，库中行胜。
    MergeById,
}

/// （迁移合并）：按 id 做并集——`existing`（库中现存行，较新）在 id 冲突时
/// 胜出，`incoming`（legacy 载荷）独有的行追加。重复运行幂等：上一轮并入的
/// legacy 行已在库中，下一轮以「现存行胜」原样保留。
fn merge_rows_by_id<T: Clone>(
    existing: Vec<T>,
    incoming: &[T],
    id_of: impl Fn(&T) -> &str,
) -> Vec<T> {
    let seen: std::collections::HashSet<String> =
        existing.iter().map(|x| id_of(x).to_string()).collect();
    let mut out = existing;
    out.extend(
        incoming
            .iter()
            .filter(|x| !seen.contains(id_of(x)))
            .cloned(),
    );
    out
}

#[cfg(test)]
mod tests {
    use crate::db::{in_memory, MIGRATIONS};
    use crate::models::{
        AppData, Deadline, PomodoroInterruption, PomodoroSession, SettingKV, Task,
    };
    use crate::repositories::{
        escape_like, BackupRepo, ClipboardRepo, DeadlineRepo, InterruptionRepo, NewClipboardEntry,
        NotificationRepo, SessionRepo, SettingsRepo, TaskRepo, CLIPBOARD_HISTORY_CAP,
        NOTIFICATION_HISTORY_CAP, SESSION_RETAIN_CAP,
    };
    use rusqlite::Connection;

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
        // [FILES]文件条目：入库 kind/files 列、列表取回、
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
    fn clipboard_dedup_compares_against_recent_rows() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // A → B → A：修复后去重窗口是最近 50 条（不再只比对最新一条），
        // 第三个 A 命中历史 A → touch 置顶而非重复入史。
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
        assert!(!a2.inserted, "A-B-A 序列的第三个 A 应回捞旧行而非新增");
        assert_eq!(a2.entry.id, a1.entry.id);
        assert_eq!(ClipboardRepo::count(&conn).unwrap(), 2);
        // 列表：被 touch 的 A 置顶。
        let list = ClipboardRepo::list(&conn, None, 10).unwrap();
        assert_eq!(list[0].id, a1.entry.id);
        assert_eq!(list[1].id, b.entry.id);
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
    fn clipboard_list_omits_fulltext_and_computes_line_count() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let rec = ClipboardRepo::record(&conn, &clip_text("l1\nl2\nl3\n")).unwrap();
        assert_eq!(rec.entry.text_lines, 3, "结尾换行不补行（record 路径）");

        // list：全文不上 IPC，行数由 SQL 现算（与 count_lines 同口径）。
        let listed = ClipboardRepo::list(&conn, None, 10).unwrap();
        assert_eq!(listed[0].text, None, "列表不携带全文");
        assert_eq!(listed[0].text_lines, 3, "SQL 现算行数");
        // get：全文路径带全文 + Rust 侧行数。
        let full = ClipboardRepo::get(&conn, &rec.entry.id).unwrap().unwrap();
        assert_eq!(full.text.as_deref(), Some("l1\nl2\nl3\n"));
        assert_eq!(full.text_lines, 3);
        // 非文本行为 0。
        let img = ClipboardRepo::record(&conn, &clip_image("i.png")).unwrap();
        let img_row = ClipboardRepo::get(&conn, &img.entry.id).unwrap().unwrap();
        assert_eq!(img_row.text_lines, 0);
    }

    #[test]
    fn clipboard_list_kind_filter_matches_type_words() {
        let conn = in_memory(MIGRATIONS).unwrap();
        ClipboardRepo::record(&conn, &clip_text("plain text")).unwrap();
        ClipboardRepo::record(&conn, &clip_image("shot.png")).unwrap();
        ClipboardRepo::record(&conn, &clip_files(&["C:/a/报告.pdf"])).unwrap();

        // 图片行 preview 为空：类型词把整类拉回来（中英文 / 大小写）。
        for q in ["图片", "image", "IMG", "截图", "screenshot"] {
            let hit = ClipboardRepo::list(&conn, Some(q), 10).unwrap();
            assert_eq!(hit.len(), 1, "查询词 {q} 应只命中图片行");
            assert_eq!(hit[0].kind, "image");
        }
        for q in ["文件", "files", "FILE", "文件夹"] {
            let hit = ClipboardRepo::list(&conn, Some(q), 10).unwrap();
            assert_eq!(hit.len(), 1, "查询词 {q} 应只命中文件行");
            assert_eq!(hit[0].kind, "files");
        }
        // 非类型词走原有内容匹配，不被 kind 过滤放大。
        assert_eq!(
            ClipboardRepo::list(&conn, Some("plain"), 10).unwrap().len(),
            1
        );
        assert!(ClipboardRepo::list(&conn, Some("图片x"), 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn clipboard_list_recent_ignores_pinned_priority() {
        let conn = in_memory(MIGRATIONS).unwrap();
        conn.execute(
            "INSERT INTO clipboard_history (id, kind, hash, preview, pinned, created_at, expires_at) VALUES ('old-pin','text','h1','pinned!',1,'2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let fresh = ClipboardRepo::record(&conn, &clip_text("fresh"))
            .unwrap()
            .entry;
        // 列表浏览：置顶在前。
        let list = ClipboardRepo::list(&conn, None, 10).unwrap();
        assert_eq!(list[0].id, "old-pin");
        // 迷你「最近一条」：纯 created_at 序，置顶不霸位。
        let recent = ClipboardRepo::list_recent(&conn, 1).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, fresh.id);
    }

    #[test]
    fn clipboard_count_lines_matches_frontend_semantics() {
        use crate::repositories::count_lines;
        assert_eq!(count_lines(None), 0);
        assert_eq!(count_lines(Some("")), 0);
        assert_eq!(count_lines(Some("单行")), 1);
        assert_eq!(count_lines(Some("a\nb")), 2);
        assert_eq!(count_lines(Some("a\nb\n")), 2, "结尾换行不算新行");
        assert_eq!(count_lines(Some("\n\n")), 2);
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

        // 超量：灌 cap + 20 行（created_at 递增）——其中单来源 's' 灌 120 行
        // （超过 per-source 配额 100），其余行来自来源 'x'。再 add 一条：
        // ① 's' 只留最新 100（per-source 配额，防单来源挤占全局）；
        // ② 全局总量 == cap；③ 保留的是最新的。
        conn.execute("DELETE FROM notification_history", [])
            .unwrap();
        for i in 0..120 {
            conn.execute(
                "INSERT INTO notification_history (id, source, title, body, kind, read, created_at, expires_at) VALUES (?1,'s','t','b','info',0,?2,'2999-01-01T00:00:00.000Z')",
                rusqlite::params![format!("s{i:04}"), format!("2026-01-01T00:00:{:02}.{:03}Z", i / 1000, i % 1000)],
            )
            .unwrap();
        }
        for i in 0..(NOTIFICATION_HISTORY_CAP + 20 - 120) {
            conn.execute(
                "INSERT INTO notification_history (id, source, title, body, kind, read, created_at, expires_at) VALUES (?1,'x','t','b','info',0,?2,'2999-01-01T00:00:00.000Z')",
                rusqlite::params![format!("n{i:04}"), format!("2026-01-02T00:00:{:02}.{:03}Z", i / 1000, i % 1000)],
            )
            .unwrap();
        }
        NotificationRepo::add(&conn, "s", "newest", "", None).unwrap();
        let list = NotificationRepo::list_limited(&conn, None).unwrap();
        // per-source 配额对每个来源生效：'s' 与 'x' 各留最新 100 → 总量 200
        // （全局 500 上限在来源更多时才触顶）。
        assert_eq!(list.len() as i64, 2 * (NOTIFICATION_HISTORY_CAP / 5));
        assert_eq!(list[0].title, "newest");
        let s_rows = list.iter().filter(|r| r.source == "s").count() as i64;
        assert_eq!(
            s_rows,
            NOTIFICATION_HISTORY_CAP / 5,
            "单来源最多保留 per-source 配额"
        );
        let ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        assert!(!ids.contains(&"n0000"), "oldest rows are trimmed first");
        assert!(ids.contains(&"n0399"), "newest pre-existing rows survive");
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

    /// 备份导入的并集补插——库中现存行胜、载荷独有行插入、幂等重放为 0。
    #[test]
    fn session_merge_unions_by_id_with_existing_wins() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let mk = |id: &str, at: &str, completed: bool| PomodoroSession {
            id: id.into(),
            session_type: "focus".into(),
            mode: "focus".into(),
            started_at: at.into(),
            ended_at: at.into(),
            planned_seconds: 1500,
            completed,
            task_id: None,
            event_label: None,
        };
        SessionRepo::add(&conn, &mk("keep", "2026-01-01T00:00:00Z", true)).unwrap();

        let n = SessionRepo::merge(
            &mut conn,
            &[
                // 库中已有同 id：现存行胜（completed 不被载荷覆盖）。
                mk("keep", "2026-01-01T00:00:00Z", false),
                // 载荷独有：插入，时间戳归一为 UTC-Z 毫秒。
                mk("fresh", "2026-01-02T08:00:00+08:00", true),
            ],
        )
        .unwrap();
        assert_eq!(n, 1, "只插入载荷独有的行");

        let list = SessionRepo::list(&conn).unwrap();
        assert_eq!(list.len(), 2);
        let keep = list.iter().find(|s| s.id == "keep").unwrap();
        assert!(keep.completed, "id 冲突时库中现存行胜出");
        let fresh = list.iter().find(|s| s.id == "fresh").unwrap();
        assert_eq!(fresh.started_at, "2026-01-02T00:00:00.000Z");

        // 幂等重放：全部行已在库中，返回 0 且库不变。
        let again = SessionRepo::merge(
            &mut conn,
            &[
                mk("keep", "2026-01-01T00:00:00Z", true),
                mk("fresh", "x", true),
            ],
        )
        .unwrap();
        assert_eq!(again, 0);
        assert_eq!(SessionRepo::list(&conn).unwrap().len(), 2);
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

    /// 聚合口径：轮数只计 completed=1，秒数含中断段的实际专注时长。
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

    /// （跨窗口丢行）：import_core_keep_sessions 一律以库中现存行为准，
    /// 载荷的 sessions 字段（无论携带什么，甚至显式空列表）都不生效。
    #[test]
    fn import_core_keep_sessions_ignores_payload_sessions() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let existing = PomodoroSession {
            id: "s-existing".into(),
            session_type: "focus".into(),
            mode: "focus".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            ended_at: "2026-01-01T00:25:00.000Z".into(),
            planned_seconds: 1500,
            completed: true,
            task_id: None,
            event_label: None,
        };
        SessionRepo::add(&conn, &existing).unwrap();
        let _old = TaskRepo::add(&conn, "旧任务", None, None, None).unwrap();

        // 载荷试图把 sessions 整表替换成另一条（模拟旧行为下会吞掉现存行）。
        let payload = AppData {
            tasks: vec![Task {
                id: "t-new".into(),
                title: "新任务".into(),
                completed: false,
                created_at: "2026-08-13T00:00:00.000Z".into(),
                due_at: String::new(),
                priority: 0,
                tags: "[]".into(),
                sort_order: 0,
            }],
            deadlines: vec![],
            sessions: Some(vec![PomodoroSession {
                id: "s-smuggled".into(),
                session_type: "focus".into(),
                mode: "focus".into(),
                started_at: "2026-08-13T00:00:00.000Z".into(),
                ended_at: "2026-08-13T00:25:00.000Z".into(),
                planned_seconds: 1500,
                completed: true,
                task_id: None,
                event_label: None,
            }]),
            ..AppData::default()
        };
        BackupRepo::import_core_keep_sessions(&mut conn, &payload).unwrap();
        let sessions = SessionRepo::list(&conn).unwrap();
        assert_eq!(sessions.len(), 1, "库中现存行原样保留");
        assert_eq!(sessions[0].id, "s-existing", "载荷 sessions 被忽略");
        let tasks = TaskRepo::list(&conn).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "新任务", "其余表照常整体替换");
    }

    /// （迁移合并重设计）：按 id 并集，库中现存行胜，legacy 独有行入库；
    /// settings / interruptions 不被触碰（迁移只搬三张核心表）。
    #[test]
    fn import_core_merge_unions_by_id_with_existing_rows_winning() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        // 库中现存：t-db（与 legacy 同 id）、d-db、s-db（与 legacy 同 id）。
        conn.execute(
            "INSERT INTO tasks (id, title, completed, created_at, due_at, priority, tags, sort_order) VALUES ('t-db','库里较新的标题',1,'2026-09-01T00:00:00.000Z','',0,'[]',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deadlines (id, title, due_at, notified, completed, notified_tiers, repeat) VALUES ('d-db','库中DDL','2026-09-30T00:00:00.000Z',0,0,'[]','none')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pomodoro_sessions (id, session_type, mode, started_at, ended_at, planned_seconds, completed, task_id, event_label) VALUES ('s-db','focus','focus','2026-09-01T01:00:00.000Z','2026-09-01T01:25:00.000Z',1500,1,NULL,NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pomodoro_interruptions (id, started_at, ended_at, reason, mode, elapsed_seconds) VALUES ('i-db','2026-09-01T01:05:00.000Z','2026-09-01T01:06:00.000Z','猫踩键盘','focus',60)",
            [],
        )
        .unwrap();
        SettingsRepo::set(&conn, "app:settings:v1", r#"{"seed":true}"#).unwrap();

        // legacy 载荷：同 id 的旧行 + 独有行；还夹带了 settings / interruptions
        // （合并模式必须整体忽略，不能经迁移旁路写设置）。
        let payload = AppData {
            tasks: vec![
                Task {
                    id: "t-db".into(),
                    title: "legacy 旧标题".into(),
                    completed: false,
                    created_at: "2026-01-01T00:00:00.000Z".into(),
                    due_at: String::new(),
                    priority: 0,
                    tags: "[]".into(),
                    sort_order: 0,
                },
                Task {
                    id: "t-legacy-only".into(),
                    title: "legacy 独有任务".into(),
                    completed: false,
                    created_at: "2026-01-02T00:00:00.000Z".into(),
                    due_at: String::new(),
                    priority: 0,
                    tags: "[]".into(),
                    sort_order: 0,
                },
            ],
            deadlines: vec![Deadline {
                id: "d-legacy-only".into(),
                title: "legacy 独有 DDL".into(),
                due_at: "2026-02-01T00:00:00.000Z".into(),
                notified: false,
                completed: false,
                notified_tiers: "[]".into(),
                repeat: "none".into(),
            }],
            sessions: Some(vec![
                PomodoroSession {
                    id: "s-db".into(),
                    session_type: "focus".into(),
                    mode: "focus".into(),
                    started_at: "2026-01-01T01:00:00.000Z".into(),
                    ended_at: "2026-01-01T01:25:00.000Z".into(),
                    planned_seconds: 999,
                    completed: false,
                    task_id: None,
                    event_label: None,
                },
                PomodoroSession {
                    id: "s-legacy-only".into(),
                    session_type: "focus".into(),
                    mode: "focus".into(),
                    started_at: "2026-01-03T01:00:00.000Z".into(),
                    ended_at: "2026-01-03T01:25:00.000Z".into(),
                    planned_seconds: 1500,
                    completed: true,
                    task_id: None,
                    event_label: None,
                },
            ]),
            settings: vec![SettingKV {
                key: "app:settings:v1".into(),
                value: r#"{"smuggled":true}"#.into(),
            }],
            interruptions: Some(vec![PomodoroInterruption {
                id: "i-smuggled".into(),
                started_at: "2026-01-01T01:00:00.000Z".into(),
                ended_at: "2026-01-01T01:01:00.000Z".into(),
                reason: "legacy".into(),
                mode: "focus".into(),
                elapsed_seconds: 60,
            }]),
            ..AppData::default()
        };
        let result = BackupRepo::import_core_merge(&mut conn, &payload).unwrap();

        // 并集：tasks 2、deadlines 2、sessions 2；ImportResult 报合并后的终态行数。
        let tasks = TaskRepo::list(&conn).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(result.tasks, 2);
        let t_db = tasks.iter().find(|t| t.id == "t-db").unwrap();
        assert_eq!(t_db.title, "库里较新的标题", "id 冲突时库中现存行胜");
        assert!(t_db.completed, "库行字段完整保留（不被 legacy 覆盖）");
        assert!(
            tasks.iter().any(|t| t.id == "t-legacy-only"),
            "legacy 独有任务入库"
        );

        let deadlines = DeadlineRepo::list(&conn).unwrap();
        assert_eq!(deadlines.len(), 2);
        assert_eq!(result.deadlines, 2);
        assert_eq!(
            deadlines.iter().find(|d| d.id == "d-db").unwrap().title,
            "库中DDL"
        );
        assert!(deadlines.iter().any(|d| d.id == "d-legacy-only"));

        let sessions = SessionRepo::list(&conn).unwrap();
        assert_eq!(sessions.len(), 2);
        let s_db = sessions.iter().find(|s| s.id == "s-db").unwrap();
        assert_eq!(s_db.planned_seconds, 1500, "sessions 同样库中行胜");
        assert!(s_db.completed);
        assert!(sessions.iter().any(|s| s.id == "s-legacy-only"));

        // settings / interruptions 维持库中现状：夹带载荷被整体忽略。
        assert_eq!(
            SettingsRepo::get(&conn, "app:settings:v1")
                .unwrap()
                .as_deref(),
            Some(r#"{"seed":true}"#)
        );
        let interruptions = InterruptionRepo::list(&conn).unwrap();
        assert_eq!(interruptions.len(), 1);
        assert_eq!(interruptions[0].id, "i-db");

        // 幂等：同一载荷再合并一遍，全部行已是「库中现存」，终态不变。
        // （模型不 derive PartialEq，经 serde_json 比较终态快照；list() 带
        // ORDER BY，同数据两次读取顺序确定。）
        let dump = |c: &Connection| {
            (
                serde_json::to_string(&TaskRepo::list(c).unwrap()).unwrap(),
                serde_json::to_string(&DeadlineRepo::list(c).unwrap()).unwrap(),
                serde_json::to_string(&SessionRepo::list(c).unwrap()).unwrap(),
            )
        };
        let before = dump(&conn);
        BackupRepo::import_core_merge(&mut conn, &payload).unwrap();
        assert_eq!(dump(&conn), before, "second merge is a no-op");
    }

    /// （等价性边界）：空库时合并 ≡ 整表导入——legacy 快照全量落地，
    /// 与 import_data 的最终表内容一致（此时没有可冲突的现存行）。
    #[test]
    fn import_core_merge_on_empty_db_matches_import_all() {
        let payload = AppData {
            tasks: vec![Task {
                id: "t1".into(),
                title: "迁移任务".into(),
                completed: false,
                created_at: "2026-01-01T00:00:00.000Z".into(),
                due_at: "2026-01-05T00:00:00.000Z".into(),
                priority: 2,
                tags: r#"["工作"]"#.into(),
                sort_order: 1,
            }],
            deadlines: vec![],
            sessions: Some(vec![PomodoroSession {
                id: "s1".into(),
                session_type: "focus".into(),
                mode: "focus".into(),
                started_at: "2026-01-01T01:00:00.000Z".into(),
                ended_at: "2026-01-01T01:25:00.000Z".into(),
                planned_seconds: 1500,
                completed: true,
                task_id: Some("t1".into()),
                event_label: None,
            }]),
            ..AppData::default()
        };

        let mut merged = in_memory(MIGRATIONS).unwrap();
        BackupRepo::import_core_merge(&mut merged, &payload).unwrap();
        let mut replaced = in_memory(MIGRATIONS).unwrap();
        BackupRepo::import_all(&mut replaced, &payload).unwrap();

        // 模型不 derive PartialEq，经 serde_json 比较终态（list() 带 ORDER BY，
        // 顺序确定）。
        assert_eq!(
            serde_json::to_string(&TaskRepo::list(&merged).unwrap()).unwrap(),
            serde_json::to_string(&TaskRepo::list(&replaced).unwrap()).unwrap()
        );
        assert_eq!(
            serde_json::to_string(&DeadlineRepo::list(&merged).unwrap()).unwrap(),
            serde_json::to_string(&DeadlineRepo::list(&replaced).unwrap()).unwrap()
        );
        assert_eq!(
            serde_json::to_string(&SessionRepo::list(&merged).unwrap()).unwrap(),
            serde_json::to_string(&SessionRepo::list(&replaced).unwrap()).unwrap()
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

    // 导出与导入的敏感键过滤必须对称——DPAPI 凭据密文
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

    // 来自更新版本的备份必须在导入前被拒绝，而不是被
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

    /// 增量 diff 语义等价 + 真零写。值未变的行不产生任何 INSERT /
    /// UPDATE / DELETE（经 TEMP 触发器计数验证）；载荷中消失的键被删除。
    #[test]
    fn local_storage_mirror_incremental_diff_writes_only_changes() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let base = vec![
            SettingKV {
                key: "focus-desk.notes.w1".into(),
                value: r#"[{"id":"n1"}]"#.into(),
            },
            SettingKV {
                key: "focus-desk.habits.w2".into(),
                value: "{}".into(),
            },
        ];
        crate::repositories::replace_local_storage_mirror(&mut conn, &base).unwrap();
        // 触发器计数 settings 表上的全部行级写操作。
        conn.execute_batch(
            "CREATE TEMP TABLE mirror_writes(n);
             CREATE TEMP TRIGGER mirror_ins AFTER INSERT ON settings WHEN new.key LIKE 'lsmirror:%' BEGIN INSERT INTO mirror_writes VALUES('i'); END;
             CREATE TEMP TRIGGER mirror_upd AFTER UPDATE ON settings WHEN new.key LIKE 'lsmirror:%' BEGIN INSERT INTO mirror_writes VALUES('u'); END;
             CREATE TEMP TRIGGER mirror_del AFTER DELETE ON settings WHEN old.key LIKE 'lsmirror:%' BEGIN INSERT INTO mirror_writes VALUES('d'); END;",
        )
        .unwrap();

        // 同一批条目原样再同步（顺序打乱）：应零写入。
        let same = vec![base[1].clone(), base[0].clone()];
        crate::repositories::replace_local_storage_mirror(&mut conn, &same).unwrap();
        let writes: i64 = conn
            .query_row("SELECT COUNT(*) FROM mirror_writes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(writes, 0, "值未变的行不得产生任何写");

        // 一条改值 + 一条新增 + 一条消失：恰好 2 次写（改值 UPSERT + 新增
        // INSERT；消失的 habits 键 DELETE）→ 共 3 次。
        let changed = vec![
            SettingKV {
                key: "focus-desk.notes.w1".into(),
                value: r#"[{"id":"n2"}]"#.into(),
            },
            SettingKV {
                key: "focus-desk.bookmarks.w3".into(),
                value: "[]".into(),
            },
        ];
        crate::repositories::replace_local_storage_mirror(&mut conn, &changed).unwrap();
        let writes: i64 = conn
            .query_row("SELECT COUNT(*) FROM mirror_writes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(writes, 3, "改值 + 新增 + 消失各恰好一次行级写");

        // 最终表内容与整表替换等价。
        let listed = crate::repositories::list_local_storage_mirror(&conn).unwrap();
        let keys: Vec<&str> = listed.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, vec!["focus-desk.bookmarks.w3", "focus-desk.notes.w1"]);
        assert!(listed[1].value.contains("n2"));
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

    /// add 落库统一 normalize_ts——与 merge 的归一
    /// 复合键同口径，异构格式的同一段中断在备份合并时不再被重复插行。
    #[test]
    fn interruption_add_normalizes_timestamps_matching_merge_key() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        // 旧版形态（+08:00 偏移）写入：库里应归一为 UTC-Z 毫秒。
        InterruptionRepo::add(
            &conn,
            &crate::models::PomodoroInterruption {
                id: "i-old".into(),
                started_at: "2026-08-13T09:05:00+08:00".into(),
                ended_at: "2026-08-13T09:06:00+08:00".into(),
                reason: "phone".into(),
                mode: "focus".into(),
                elapsed_seconds: 60,
            },
        )
        .unwrap();
        let rows = InterruptionRepo::list(&conn).unwrap();
        assert_eq!(rows[0].started_at, "2026-08-13T01:05:00.000Z");

        // 备份合并：incoming 是同一段中断的另一种历史形态（秒级 Z）——归一
        // 复合键相等，不得重复插行（修复前 add 原样落库，两键不等 → 插行）。
        let n = InterruptionRepo::merge(
            &mut conn,
            &[crate::models::PomodoroInterruption {
                id: "i-new-uuid".into(),
                started_at: "2026-08-13T01:05:00Z".into(),
                ended_at: "2026-08-13T01:06:00Z".into(),
                reason: "phone".into(),
                mode: "focus".into(),
                elapsed_seconds: 60,
            }],
        )
        .unwrap();
        assert_eq!(n, 0, "同一段中断不得重复插行");
        assert_eq!(InterruptionRepo::list(&conn).unwrap().len(), 1);
    }

    /// RUST-2：merge 对「同 id、复合键不同」的载荷行按库中行胜跳过——
    /// 此前裸 INSERT 撞 PRIMARY KEY，整批导入失败（fail-closed 但事务回滚
    /// 打断导入链）。载荷内部同 id 双行同样不得撞主键。
    #[test]
    fn interruption_merge_same_id_different_content_skips_not_errors() {
        let mut conn = in_memory(MIGRATIONS).unwrap();
        let mk = |id: &str, started: String, reason: &str| PomodoroInterruption {
            id: id.into(),
            started_at: started.clone(),
            ended_at: started,
            reason: reason.into(),
            mode: "focus".into(),
            elapsed_seconds: 60,
        };
        InterruptionRepo::add(&conn, &mk("dup-id", local_iso(2026, 1, 10, 9, 0), "原行")).unwrap();
        // 同 id、不同内容（手工拼接/损坏备份）+ 一条全新行 + 载荷内同 id 双行。
        let n = InterruptionRepo::merge(
            &mut conn,
            &[
                mk("dup-id", local_iso(2026, 1, 11, 9, 0), "篡改内容"),
                mk("dup-id", local_iso(2026, 1, 12, 9, 0), "载荷内第二条同 id"),
                mk("fresh", local_iso(2026, 1, 13, 9, 0), "全新行"),
            ],
        )
        .unwrap();
        assert_eq!(n, 1, "库中已有 id 跳过（库中行胜），仅全新行插入");
        let rows = InterruptionRepo::list(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        // 库中行内容未被载荷覆盖。
        assert!(rows.iter().any(|r| r.id == "dup-id" && r.reason == "原行"));
        assert!(rows.iter().any(|r| r.id == "fresh"));
    }

    /// 会话侧同口径——保留策略 ORDER BY started_at 的字符串序只在
    /// 单格式列上等于时间序，add 必须与 merge 一样归一。
    #[test]
    fn session_add_normalizes_timestamps() {
        let conn = in_memory(MIGRATIONS).unwrap();
        SessionRepo::add(
            &conn,
            &PomodoroSession {
                id: "s1".into(),
                session_type: "focus".into(),
                mode: "focus".into(),
                started_at: "2026-08-13T09:00:00+08:00".into(),
                ended_at: "2026-08-13T09:25:00+08:00".into(),
                planned_seconds: 1500,
                completed: true,
                task_id: None,
                event_label: None,
            },
        )
        .unwrap();
        let list = SessionRepo::list(&conn).unwrap();
        assert_eq!(list[0].started_at, "2026-08-13T01:00:00.000Z");
        assert_eq!(list[0].ended_at, "2026-08-13T01:25:00.000Z");
    }

    // ---- 跨午夜切分 / 虚拟午夜 / 小时分布 ----

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

    /// 用机器本地时区构造 字符串（会话落库即此形态）；日期选 1 月中旬，
    /// 避开主要时区的 DST 切换窗口，期望值在任意时区下均可计算。
    fn local_iso(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> String {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .expect("test date must not be a DST transition")
            .to_rfc3339()
    }

    #[test]
    fn aggregate_counts_round_on_start_day_across_virtual_midnight() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // 本地 01:00 → 03:00（H=2 在 02:00 切开）：首片属虚拟日 01-14，
        // 轮数必须落在 01-14（段起始虚拟日），与前端 countFocusToday 同口径。
        add_focus(
            &conn,
            "s-vm",
            local_iso(2026, 1, 15, 1, 0),
            local_iso(2026, 1, 15, 3, 0),
            7200,
            true,
        );
        let agg = SessionRepo::aggregate(&conn, 2).unwrap();
        assert_eq!(agg.daily.len(), 2);
        assert_eq!(agg.daily[0].date, "2026-01-14");
        assert_eq!(agg.daily[0].focus_count, 1, "轮数记在首片（起始虚拟日）");
        assert_eq!(agg.daily[1].date, "2026-01-15");
        assert_eq!(agg.daily[1].focus_count, 0);
    }

    #[test]
    fn monthly_breakdown_groups_by_started_virtual_day() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let mk = |id: &str, started: String, reason: &str| PomodoroInterruption {
            id: id.into(),
            started_at: started.clone(),
            ended_at: started,
            reason: reason.into(),
            mode: "focus".into(),
            elapsed_seconds: 60,
        };
        // H=2：01-15 01:00 开始的打断属虚拟日 01-14（1 月）。
        InterruptionRepo::add(&conn, &mk("i1", local_iso(2026, 1, 15, 1, 0), "消息")).unwrap();
        InterruptionRepo::add(&conn, &mk("i2", local_iso(2026, 1, 20, 10, 0), "消息")).unwrap();
        InterruptionRepo::add(&conn, &mk("i3", local_iso(2026, 1, 21, 10, 0), "电话")).unwrap();
        // 2 月的行不进 1 月。
        InterruptionRepo::add(&conn, &mk("i4", local_iso(2026, 2, 3, 10, 0), "消息")).unwrap();
        let out = InterruptionRepo::monthly_breakdown(&conn, 2, 2026, 0).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].reason, "消息", "次数降序");
        assert_eq!(out[0].count, 2, "01-15 01:00 的打断按起始虚拟日归 1 月");
        assert_eq!(out[1].reason, "电话");
        assert_eq!(out[1].count, 1);
        // 同次数按原因升序稳定排序。
        let tie = InterruptionRepo::monthly_breakdown(&conn, 0, 2026, 1).unwrap();
        assert_eq!(tie.len(), 1);
        assert_eq!(tie[0].reason, "消息");
    }

    #[test]
    fn monthly_breakdown_sorts_ties_by_reason() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let mk = |id: &str, started: String, reason: &str| PomodoroInterruption {
            id: id.into(),
            started_at: started.clone(),
            ended_at: started,
            reason: reason.into(),
            mode: "focus".into(),
            elapsed_seconds: 60,
        };
        InterruptionRepo::add(&conn, &mk("a", local_iso(2026, 1, 2, 9, 0), "休息")).unwrap();
        InterruptionRepo::add(&conn, &mk("b", local_iso(2026, 1, 3, 9, 0), "电话")).unwrap();
        InterruptionRepo::add(&conn, &mk("c", local_iso(2026, 1, 4, 9, 0), "消息")).unwrap();
        let out = InterruptionRepo::monthly_breakdown(&conn, 0, 2026, 0).unwrap();
        let reasons: Vec<&str> = out.iter().map(|r| r.reason.as_str()).collect();
        // 同次数按原因码点升序：休(U+4F11) < 消(U+6D88) < 电(U+7535)。
        assert_eq!(reasons, vec!["休息", "消息", "电话"], "同次数按原因升序");
    }

    #[test]
    fn task_breakdown_groups_completed_focus_by_event() {
        let conn = in_memory(MIGRATIONS).unwrap();
        let mk = |id: &str,
                  started: String,
                  ended: String,
                  secs: i64,
                  completed: bool,
                  task_id: Option<String>,
                  event_label: Option<String>| PomodoroSession {
            id: id.into(),
            session_type: "focus".into(),
            mode: "focus".into(),
            started_at: started,
            ended_at: ended,
            planned_seconds: secs,
            completed,
            task_id,
            event_label,
        };
        let day = |d: u32| local_iso(2026, 1, d, 9, 0);
        // 任务 A 两段（1800 + 1200）。
        SessionRepo::add(
            &conn,
            &mk("t1", day(2), day(2), 1800, true, Some("taskA".into()), None),
        )
        .unwrap();
        SessionRepo::add(
            &conn,
            &mk("t2", day(3), day(3), 1200, true, Some("taskA".into()), None),
        )
        .unwrap();
        // 自定义事件「写作」一段。
        SessionRepo::add(
            &conn,
            &mk("t3", day(4), day(4), 1500, true, None, Some("写作".into())),
        )
        .unwrap();
        // 未关联完成段 + 未完成段（不计）。
        SessionRepo::add(&conn, &mk("t4", day(5), day(5), 600, true, None, None)).unwrap();
        SessionRepo::add(
            &conn,
            &mk("t5", day(6), day(6), 900, false, Some("taskA".into()), None),
        )
        .unwrap();
        let out = SessionRepo::task_breakdown(&conn).unwrap();
        assert_eq!(out.len(), 3, "未完成段不进聚合");
        let a = out
            .iter()
            .find(|r| r.task_id.as_deref() == Some("taskA"))
            .unwrap();
        assert_eq!(a.focus_seconds, 3000);
        assert_eq!(a.sessions, 2);
        let w = out
            .iter()
            .find(|r| r.event_label.as_deref() == Some("写作"))
            .unwrap();
        assert_eq!(w.focus_seconds, 1500);
        assert_eq!(w.sessions, 1);
        let unlinked = out
            .iter()
            .find(|r| r.task_id.is_none() && r.event_label.is_none())
            .unwrap();
        assert_eq!(unlinked.focus_seconds, 600);
        assert_eq!(unlinked.sessions, 1);

        // 同一 task_id 携不同 event_label（备份/迁移数据可构造）必须归并
        // 为一组——此前 GROUP BY task_id, event_label 拆多行，前端按 taskId 映射
        // 后出现同 key 重复扇区。
        SessionRepo::add(
            &conn,
            &mk(
                "t6",
                day(7),
                day(7),
                300,
                true,
                Some("taskB".into()),
                Some("旧标签".into()),
            ),
        )
        .unwrap();
        SessionRepo::add(
            &conn,
            &mk("t7", day(8), day(8), 420, true, Some("taskB".into()), None),
        )
        .unwrap();
        let out2 = SessionRepo::task_breakdown(&conn).unwrap();
        let b_rows: Vec<_> = out2
            .iter()
            .filter(|r| r.task_id.as_deref() == Some("taskB"))
            .collect();
        assert_eq!(b_rows.len(), 1, "同 task 不同 label 归并为一行");
        assert_eq!(b_rows[0].focus_seconds, 720);
        assert_eq!(b_rows[0].sessions, 2);
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
        // 轮数只记一次：落在首片（段起始时刻所属虚拟日），与前端
        // 「按起始虚拟日归组轮数」的统一口径一致。
        assert_eq!(agg.daily[0].focus_count, 1);
        assert_eq!(agg.daily[1].focus_count, 0);
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
        // 轮数记在首片（段起始虚拟日 01-14），与前端口径一致。
        assert_eq!(virt.daily[0].focus_count, 1);
        assert_eq!(virt.daily[1].focus_count, 0);
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
