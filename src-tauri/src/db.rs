//! SQLite 连接管理：打开/迁移（版本化 migration 表）、读写连接拆分、
//! Mutex 守卫与错误类型（DbError/DbResult）。
use rusqlite::Connection;
use serde::ser::{SerializeStruct, Serializer};
use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database mutex poisoned: {0}")]
    Lock(String),
    #[error("background task failed: {0}")]
    Task(String),
    #[error("untrusted window: {0}")]
    Denied(String),
}

/// Locks the app DB mutex, recovering from a poisoned lock (a prior panic
/// while the guard was held). `rusqlite::Connection` stays usable after a
/// panic between statements; refusing the lock would turn one unrelated bug
/// into "every DB command fails until restart". Any half-open transaction is
/// rolled back before the guard is handed out.
pub fn lock_db<'a>(lock: &'a Mutex<Connection>) -> DbResult<MutexGuard<'a, Connection>> {
    match lock.lock() {
        Ok(g) => Ok(g),
        Err(poisoned) => {
            let g = poisoned.into_inner();
            let _ = g.execute_batch("ROLLBACK");
            Ok(g)
        }
    }
}

impl Serialize for DbError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut s = serializer.serialize_struct("DbError", 1)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type DbResult<T> = Result<T, DbError>;

const USER_VERSION_KEY: &str = "PRAGMA user_version";

/// A single forward-only migration. `apply` runs inside a transaction.
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub apply: fn(&Connection) -> rusqlite::Result<()>,
}

/// Opens (or creates) the database and applies all pending migrations.
pub fn open_and_migrate(db_path: &Path, migrations: &[Migration]) -> DbResult<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // WAL improves crash safety and concurrent read/write.
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // E-7: cap WAL growth so a large import/reset can't leave a multi-hundred-MB
    // `-wal` file behind. SQLite auto-checkpoints once the WAL exceeds this.
    conn.pragma_update(None, "journal_size_limit", 8_000_000)?;
    // 审计修复：写连接此前保持 rusqlite 默认 0ms busy_timeout。Windows 上
    // 杀毒/索引器/云同步/第二实例短暂持有文件时，所有写命令与启动迁移会立即
    // 收到 SQLITE_BUSY 直接报错给前端。与读连接（open_read_connection）一致，
    // 给 5s 等待窗口。
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    migrate(&conn, migrations)?;
    Ok(conn)
}

/// Truncate the WAL back to disk after a heavy write so the `-wal`/`-shm`
/// files don't stay inflated until the next auto-checkpoint.
pub fn checkpoint(conn: &Connection) {
    if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)") {
        log::warn!("wal_checkpoint failed: {e}");
    }
}

/// C-1：为只读命令打开第二条独立连接。与写连接共享同一 WAL 库 —— WAL 模式下
/// 读者与写者互不阻塞（checkpoint 短暂互斥除外），因此 list_*/get_setting/export
/// 走此连接后，即便重备份/导入长时间持有写连接的 Mutex，也只冻结主线程的写路径，
/// 不再冻结所有窗口的事件泵。
pub fn open_read_connection(db_path: &Path) -> DbResult<Connection> {
    let conn = Connection::open(db_path)?;
    // 读连接面对 checkpoint 的短暂排他窗口时等待而非立即 SQLITE_BUSY。
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// 只读连接池容量：并发读者超过此数时超出连接用完即弃（不归还），避免
/// 罕见风暴路径留下永久连接堆积；常态并发（≤4 个只读命令同飞）全部命中池。
const READ_POOL_CAP: usize = 4;

/// R6：只读连接池（C-1 单连接的升级）。此前全部只读命令共享一条读连接 +
/// Mutex——备份导出整库期间持锁，其余 list_*/get_setting 全部排队。WAL 本就
/// 支持任意多读者，这里改成池化借还：借出即用即还（RAII），耗尽时新开一条，
/// 用后超出容量的直接关闭。写连接（AppState.db）语义不变。
pub struct ReadPool {
    path: std::path::PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl ReadPool {
    /// 打开首条读连接建池（顺带校验路径可打开）。
    pub fn new(db_path: &Path) -> DbResult<Self> {
        let first = open_read_connection(db_path)?;
        Ok(Self {
            path: db_path.to_path_buf(),
            idle: Mutex::new(vec![first]),
        })
    }

    /// 借出一条读连接；Drop 时自动归还（池满则关闭）。
    pub fn acquire(&self) -> DbResult<ReadGuard<'_>> {
        let conn = {
            let mut idle = self.idle.lock().unwrap_or_else(|p| p.into_inner());
            idle.pop()
        };
        let conn = match conn {
            Some(c) => c,
            None => open_read_connection(&self.path)?,
        };
        Ok(ReadGuard {
            pool: self,
            conn: Some(conn),
        })
    }

    fn return_conn(&self, conn: Connection) {
        let mut idle = self.idle.lock().unwrap_or_else(|p| p.into_inner());
        if idle.len() < READ_POOL_CAP {
            idle.push(conn);
        }
        // 超容量：Drop 自然关闭。
    }
}

/// 池借出的读连接守卫：Deref 到 Connection，Drop 归还。
pub struct ReadGuard<'a> {
    pool: &'a ReadPool,
    conn: Option<Connection>,
}

impl std::ops::Deref for ReadGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("ReadGuard conn dropped early")
    }
}

impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.pool.return_conn(conn);
        }
    }
}

fn current_version(conn: &Connection) -> DbResult<i64> {
    let v: i64 = conn.query_row(USER_VERSION_KEY, [], |row| row.get(0))?;
    Ok(v)
}

pub fn migrate(conn: &Connection, migrations: &[Migration]) -> DbResult<()> {
    let mut version = current_version(conn)?;
    for m in migrations {
        if m.version <= version {
            continue;
        }
        conn.execute_batch("BEGIN")?;
        // Apply the migration AND bump user_version inside one result so a
        // failure in either path always falls through to ROLLBACK (the old
        // `?` on pragma_update could leave a transaction open if it failed).
        let result: DbResult<()> = (m.apply)(conn).map_err(DbError::Sql).and_then(|_| {
            conn.pragma_update(None, "user_version", m.version)
                .map_err(DbError::Sql)
        });
        match result {
            Ok(_) => {
                // If COMMIT itself fails (disk full / I/O error) the transaction
                // would stay open on the shared connection and every later
                // command would silently run inside the ghost transaction.
                if let Err(e) = conn.execute_batch("COMMIT") {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(DbError::Sql(e));
                }
                log::info!("applied migration {}: {}", m.version, m.name);
                version = m.version;
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Migration v1: initial schema for tasks, deadlines, sessions, settings, tags.
pub fn migration_v1(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS tasks (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            completed  INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deadlines (
            id       TEXT PRIMARY KEY,
            title    TEXT NOT NULL,
            due_at   TEXT NOT NULL,
            notified INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS pomodoro_sessions (
            id             TEXT PRIMARY KEY,
            session_type   TEXT NOT NULL,
            mode           TEXT NOT NULL,
            started_at     TEXT NOT NULL,
            ended_at       TEXT NOT NULL,
            planned_seconds INTEGER NOT NULL,
            completed      INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id   TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_deadlines_due_at ON deadlines(due_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON pomodoro_sessions(started_at);
        "#,
    )?;
    Ok(())
}

/// Migration v2: interruption log for aborted pomodoro focus segments.
pub fn migration_v2(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS pomodoro_interruptions (
            id              TEXT PRIMARY KEY,
            started_at      TEXT NOT NULL,
            ended_at        TEXT NOT NULL,
            reason          TEXT NOT NULL,
            mode            TEXT NOT NULL,
            elapsed_seconds INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_interruptions_ended_at ON pomodoro_interruptions(ended_at);
        "#,
    )?;
    Ok(())
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        apply: migration_v1,
    },
    Migration {
        version: 2,
        name: "interruption_log",
        apply: migration_v2,
    },
    Migration {
        version: 3,
        name: "deadline_completed",
        apply: migration_v3,
    },
    Migration {
        version: 4,
        name: "task_fields_and_deadline_repeat",
        apply: migration_v4,
    },
    Migration {
        version: 5,
        name: "session_event_attribution",
        apply: migration_v5,
    },
    Migration {
        version: 6,
        name: "normalize_timestamps_to_utc_z",
        apply: migration_v6,
    },
    Migration {
        version: 7,
        name: "notification_history",
        apply: migration_v7,
    },
    Migration {
        version: 8,
        name: "clipboard_history",
        apply: migration_v8,
    },
    Migration {
        version: 9,
        name: "net_traffic_daily",
        apply: migration_v9,
    },
    Migration {
        version: 10,
        name: "clipboard_files",
        apply: migration_v10,
    },
];

/// Migration v3: add the `completed` flag to deadlines so a DDL can be marked
/// done and moved to the bottom of the list.
pub fn migration_v3(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        ALTER TABLE deadlines ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
        "#,
    )?;
    Ok(())
}

/// Migration v4 (W-043/045/046/049): tasks gain due/priority/tags/sort_order
/// so the todo list can absorb DDL-style scenarios; deadlines gain the
/// multi-tier reminder ledger (`notified_tiers`, JSON array) and a `repeat`
/// rule for recurring deadlines.
pub fn migration_v4(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        ALTER TABLE tasks ADD COLUMN due_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE deadlines ADD COLUMN notified_tiers TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE deadlines ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none';
        "#,
    )?;
    Ok(())
}

/// Migration v5 (W-051): sessions gain the focus-event attribution columns so
/// analytics can aggregate focus time per task / custom event.
pub fn migration_v5(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        ALTER TABLE pomodoro_sessions ADD COLUMN task_id TEXT;
        ALTER TABLE pomodoro_sessions ADD COLUMN event_label TEXT;
        "#,
    )?;
    Ok(())
}

/// Migration v6 (E-1): normalize every stored timestamp to UTC `Z` at
/// millisecond precision. Older rows were produced by `DateTime::to_rfc3339()`
/// which emitted `+00:00` with nanoseconds — a form the frontend's Zod
/// `.datetime()` rejected by default, breaking the export→import round-trip.
///
/// Also applied on every deadline write (`DeadlineRepo::add/update`): the
/// `ORDER BY due_at` string sort only equals time order while the column is
/// single-format, so new rows must not reintroduce `+08:00`/second-precision
/// variants. Unparseable input is stored verbatim (never rejected here).
pub(crate) fn normalize_ts(raw: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(raw) {
        Ok(dt) => dt
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        Err(_) => raw.to_string(),
    }
}

pub fn migration_v6(conn: &Connection) -> rusqlite::Result<()> {
    let rewrite = |table: &str, col: &str| -> rusqlite::Result<()> {
        let mut stmt = conn.prepare(&format!("SELECT rowid, {col} FROM {table}"))?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        for (rowid, value) in rows {
            conn.execute(
                &format!("UPDATE {table} SET {col} = ?1 WHERE rowid = ?2"),
                rusqlite::params![normalize_ts(&value), rowid],
            )?;
        }
        Ok(())
    };

    rewrite("tasks", "created_at")?;
    rewrite("tasks", "due_at")?;
    rewrite("deadlines", "due_at")?;
    rewrite("pomodoro_sessions", "started_at")?;
    rewrite("pomodoro_sessions", "ended_at")?;
    rewrite("pomodoro_interruptions", "started_at")?;
    rewrite("pomodoro_interruptions", "ended_at")?;
    Ok(())
}

/// Migration v7 (DOCK)：通知历史表——Vela 自发通知的留档，供通知中心小组件
/// 回看。`expires_at` 为行级过期锚点（写入时 = created_at + 保留期），与行数
/// 上限一起由 NotificationRepo 在写入路径上顺手清理（见 repositories.rs）。
/// 不进 AppData 备份：14 天保留期的短命数据，恢复旧备份不应复活已过期历史。
pub fn migration_v7(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS notification_history (
            id         TEXT PRIMARY KEY,
            source     TEXT NOT NULL,
            title      TEXT NOT NULL,
            body       TEXT NOT NULL,
            kind       TEXT NOT NULL DEFAULT 'info',
            read       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notification_history_created_at ON notification_history(created_at);
        CREATE INDEX IF NOT EXISTS idx_notification_history_source ON notification_history(source);
        "#,
    )?;
    Ok(())
}

/// Migration v8 (CLIP)：剪贴板历史表——`AddClipboardFormatListener` 监听入库
/// 的文本/图片条目。`hash` 是内容 SHA-256（仅用于与最新一条比对去重，不做
/// 唯一约束：复制 A→B→A 产生三行是预期行为）；`expires_at` 行级过期锚点
/// （写入时 = created_at + 30 天，刷新时间戳时重算），与 500 行上限一起由
/// ClipboardRepo 在写入路径顺手清理（沿用通知历史 v7 的模式）；置顶行
/// （pinned=1）不参与两种清理。图片内容不入库，落 `%APPDATA%/clip/<id>.png`，
/// 行内只存文件名——清表/删行时由调用方同步删文件。与通知历史同理不进
/// AppData 备份：30 天保留期的短命数据，恢复旧备份不应复活已删历史。
pub fn migration_v8(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS clipboard_history (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL DEFAULT 'text',
            hash        TEXT NOT NULL,
            preview     TEXT NOT NULL DEFAULT '',
            text        TEXT,
            image_file  TEXT,
            image_w     INTEGER,
            image_h     INTEGER,
            image_bytes INTEGER NOT NULL DEFAULT 0,
            source_app  TEXT,
            pinned      INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            expires_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_clipboard_history_created_at ON clipboard_history(created_at);
        "#,
    )?;
    Ok(())
}

/// Migration v9 (W-153 网络流量历史持久化)：按天累计的本机收发流量表。
/// `day` 为本地日期 `YYYY-MM-DD`（主键，一天一行）；`rx/tx_bytes` 为该日
/// 累计字节数。写入方是 `net_history::TrafficRecorder`（独立线程增量 UPSERT，
/// 与任务/番茄钟等业务数据不同源）。流量统计是用户主动回看的长期数据，
/// 随库备份/导出（保留 366 天，见 TrafficRecorder 清理逻辑）。
pub fn migration_v9(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS net_traffic_daily (
            day       TEXT PRIMARY KEY,
            rx_bytes  INTEGER NOT NULL DEFAULT 0,
            tx_bytes  INTEGER NOT NULL DEFAULT 0
        );
        "#,
    )?;
    Ok(())
}

/// Migration v10（ZTools 借鉴 #8 文件类捕获）：`clipboard_history` 加
/// `files` 列（TEXT，JSON 数组字符串；文本/图片行为 NULL）。Explorer 等
/// 复制文件（CF_HDROP）时以此落库，回写时重建 CF_HDROP。旧行 NULL 语义
/// 即「无文件列表」，与既有 kind 判定兼容。
pub fn migration_v10(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        ALTER TABLE clipboard_history ADD COLUMN files TEXT;
        "#,
    )?;
    Ok(())
}

/// Convenience helper for tests.
#[cfg(test)]
pub fn in_memory(migrations: &[Migration]) -> DbResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn, migrations)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn applies_migrations_and_records_version() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // v10 = [FILES]（ZTools 借鉴 #8）clipboard_history.files 列。
        assert_eq!(current_version(&conn).unwrap(), 10);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(count >= 5, "expected at least 5 tables, got {count}");
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = in_memory(MIGRATIONS).unwrap();
        // Re-running should be a no-op.
        migrate(&conn, MIGRATIONS).unwrap();
        assert_eq!(current_version(&conn).unwrap(), 10);
    }

    #[test]
    fn settings_roundtrip() {
        let conn = in_memory(MIGRATIONS).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            params!["theme", "dark"],
        )
        .unwrap();
        let v: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                params!["theme"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "dark");
    }
}
