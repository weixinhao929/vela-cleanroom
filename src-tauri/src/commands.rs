//! Tauri 命令层（门面）：前端 invoke 的全部入口。每个命令仅做参数校验与
//! spawn_blocking + 锁库，业务逻辑下沉到 repositories / 各领域模块。
use tauri::{Manager, State};

use crate::backup::{self, BackupInfo};
use crate::db::{lock_db, DbError, DbResult};
use crate::models::{
    AppData, Deadline, FocusAggregate, HourlyFocusStat, ImportResult, NotificationRecord,
    SettingKV, Task,
};
use crate::repositories::{
    list_local_storage_mirror, replace_local_storage_mirror, BackupRepo, DeadlineRepo,
    InterruptionRepo, NotificationRepo, SessionRepo, SettingsRepo, TaskRepo,
};
use crate::AppState;

// R1（审计）：下列读写命令全部改为 async + spawn_blocking。同步命令跑在
// Tauri 主线程上——import/export 持锁期间，前端轮询这些命令会把所有窗口
// 冻结、并可能让低级鼠标钩子超时被系统摘除（点击穿透失灵）。签名从
// State<'_, AppState> 改为 AppHandle（Tauri 自动注入，前端 invoke 不变）。

#[tauri::command]
pub async fn list_tasks(app: tauri::AppHandle) -> DbResult<Vec<Task>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let guard = state.read_db.acquire()?;
        TaskRepo::list(&guard)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// W-043：title 之外的属性（截止/优先级/标签）全部可选，旧调用零改动。
#[tauri::command]
pub async fn add_task(
    app: tauri::AppHandle,
    title: String,
    due_at: Option<String>,
    priority: Option<i64>,
    tags: Option<String>,
) -> DbResult<Task> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        TaskRepo::add(&conn, &title, due_at.as_deref(), priority, tags.as_deref())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// W-044 行内编辑 / W-045 手动排序：只更新传入的字段。
#[tauri::command]
pub async fn update_task(
    app: tauri::AppHandle,
    id: String,
    title: Option<String>,
    due_at: Option<String>,
    priority: Option<i64>,
    tags: Option<String>,
    sort_order: Option<i64>,
) -> DbResult<Option<Task>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        TaskRepo::update(
            &conn,
            &id,
            title.as_deref(),
            due_at.as_deref(),
            priority,
            tags.as_deref(),
            sort_order,
        )
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn toggle_task(app: tauri::AppHandle, id: String) -> DbResult<Option<Task>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        TaskRepo::toggle(&conn, &id)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn delete_task(app: tauri::AppHandle, id: String) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        TaskRepo::delete(&conn, &id)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// P-perf 批量删除：一次 IPC + 单事务完成多行 DELETE（此前前端逐 id 排队
/// 调 delete_task，N 条待办 = N 次往返）。任一行失败整体回滚。
#[tauri::command]
pub async fn delete_tasks(app: tauri::AppHandle, ids: Vec<String>) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        let tx = conn.unchecked_transaction()?;
        for id in &ids {
            TaskRepo::delete(&tx, id)?;
        }
        tx.commit()?;
        Ok(())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// P-perf 批量排序项（camelCase 由显式 rename 保证，与前端线协议一致）。
#[derive(Debug, serde::Deserialize)]
pub struct TaskSortPair {
    pub id: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
}

/// P-perf 批量排序：一次 IPC + 单事务覆写全部 sortOrder（手动排序拖拽
/// 结束时此前逐条 update_task，N 项 = N 次排队往返）。
#[tauri::command]
pub async fn reorder_tasks(app: tauri::AppHandle, pairs: Vec<TaskSortPair>) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        let tx = conn.unchecked_transaction()?;
        for pair in &pairs {
            TaskRepo::update(&tx, &pair.id, None, None, None, None, Some(pair.sort_order))?;
        }
        tx.commit()?;
        Ok(())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn list_deadlines(app: tauri::AppHandle) -> DbResult<Vec<Deadline>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.read_db.acquire()?;
        DeadlineRepo::list(&conn)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// W-049：repeat 可选（none/daily/weekly/monthly/yearly）。
#[tauri::command]
pub async fn add_deadline(
    app: tauri::AppHandle,
    title: String,
    due_at: String,
    repeat: Option<String>,
) -> DbResult<Deadline> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        DeadlineRepo::add(&conn, &title, &due_at, repeat.as_deref())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// W-044 行内编辑 / W-049 周期滚动：reset_tiers 同时清空已提醒档位。
#[tauri::command]
pub async fn update_deadline(
    app: tauri::AppHandle,
    id: String,
    title: Option<String>,
    due_at: Option<String>,
    repeat: Option<String>,
    reset_tiers: Option<bool>,
) -> DbResult<Option<Deadline>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        DeadlineRepo::update(
            &conn,
            &id,
            title.as_deref(),
            due_at.as_deref(),
            repeat.as_deref(),
            reset_tiers.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn delete_deadline(app: tauri::AppHandle, id: String) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        DeadlineRepo::delete(&conn, &id)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn mark_deadline_notified(app: tauri::AppHandle, id: String) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        DeadlineRepo::mark_notified(&conn, &id)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// W-046 多档提醒：覆写某条 DDL 的已提醒档位集合。
#[tauri::command]
pub async fn set_deadline_notified_tiers(
    app: tauri::AppHandle,
    id: String,
    tiers: Vec<String>,
) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        let encoded = serde_json::to_string(&tiers).unwrap_or_else(|_| "[]".to_string());
        DeadlineRepo::set_notified_tiers(&conn, &id, &encoded)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn toggle_deadline(app: tauri::AppHandle, id: String) -> DbResult<Option<Deadline>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        DeadlineRepo::toggle(&conn, &id)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// W-030 托盘倒计时：前端倒计时运行时每 30s 刷新菜单项文本；
/// text 为 None 时恢复「倒计时 未运行」。
#[tauri::command]
pub fn set_tray_countdown(state: State<'_, AppState>, text: Option<String>) -> Result<(), String> {
    // 与 lock_db 一致：中毒锁恢复而非让托盘倒计时永久失效（#C-15）。
    let guard = state
        .tray_countdown
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(item) = guard.as_ref() {
        let label = text
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "倒计时 未运行".to_string());
        item.set_text(label).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// R5（审计）：可选上限（取最近 n 条）。省略 = 全量，现有调用方不变。
#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    limit: Option<i64>,
) -> DbResult<Vec<crate::models::PomodoroSession>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.read_db.acquire()?;
        SessionRepo::list_limited(&conn, limit)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// A-4：只读聚合命令 —— 累计统计/年度热图改走 SQLite 全量聚合，突破前端
/// SESSIONS_CAP=500 的内存截断（内存仅保留最近 500 条用于列表/今日统计）。
/// `virtual_midnight_hour`（FocusTimer 借鉴）：0/2/4 —— 跨午夜会话在该点
/// 切分归日；缺省 0（自然午夜）。
#[tauri::command]
pub async fn aggregate_sessions(
    app: tauri::AppHandle,
    virtual_midnight_hour: Option<i64>,
) -> DbResult<FocusAggregate> {
    let hour = virtual_midnight_hour.unwrap_or(0).clamp(0, 23);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // C-1：纯读，走 read_db。
        let conn = state.read_db.acquire()?;
        SessionRepo::aggregate(&conn, hour)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// FocusTimer 借鉴：24 小时时段分布（跨小时段按墙钟占比切分；轮数落在
/// 结束小时）。小时桶按墙钟小时分桶，与虚拟午夜设置无关（原
/// `virtual_midnight_hour` 形参从未参与计算，L1 清理移除——IPC 契约不留死参）。
#[tauri::command]
pub async fn hourly_focus_distribution(app: tauri::AppHandle) -> DbResult<Vec<HourlyFocusStat>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.read_db.acquire()?;
        SessionRepo::hourly_distribution(&conn)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// FocusTimer 借鉴（自动化白名单动作）：切换小组件层显隐。与 CLI
/// --toggle-layer / Ctrl+Alt+D 同一条 Rust 路径；信任窗口闸门防任意
/// WebView 页面驱动桌面层。
#[tauri::command]
pub fn automation_toggle_layer(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    // 拒绝走 Err（M2 统一语义）：调用方（automation-engine）能区分「被拒」
    // 与「动作成功」，不留静默假成功。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    crate::windows::toggle_widget_layer(&app);
    Ok(())
}

#[tauri::command]
pub async fn add_session(
    app: tauri::AppHandle,
    session: crate::models::PomodoroSession,
) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        SessionRepo::add(&conn, &session)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn list_interruptions(
    app: tauri::AppHandle,
) -> DbResult<Vec<crate::models::PomodoroInterruption>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.read_db.acquire()?;
        InterruptionRepo::list(&conn)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn add_interruption(
    app: tauri::AppHandle,
    interruption: crate::models::PomodoroInterruption,
) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        InterruptionRepo::add(&conn, &interruption)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

// ---------------------------------------------------------------------------
// DOCK：通知历史（通知中心小组件的数据面）。与任务/截止命令同一口径：不做
// 窗口闸门（内容非敏感，且任何白名单窗口本就能读写任务表）。
// ---------------------------------------------------------------------------

/// 倒序取最近 n 条通知历史（`limit` 省略 = 全量，表本身有 500 行上限）。
#[tauri::command]
pub async fn list_notifications(
    app: tauri::AppHandle,
    limit: Option<i64>,
) -> DbResult<Vec<NotificationRecord>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.read_db.acquire()?;
        NotificationRepo::list_limited(&conn, limit)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 留档一条自发通知。`kind` 可选（pomodoro/todo/info，未知回落 info）；
/// source/title 为空视为无效调用直接拒绝，不入库。
#[tauri::command]
pub async fn add_notification(
    app: tauri::AppHandle,
    source: String,
    title: String,
    body: String,
    kind: Option<String>,
) -> DbResult<NotificationRecord> {
    if source.trim().is_empty() || title.trim().is_empty() {
        return Err(DbError::Task(
            "notification source/title must not be empty".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        NotificationRepo::add(
            &conn,
            source.trim(),
            title.trim(),
            body.trim(),
            kind.as_deref(),
        )
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 撤销删除：把前端仍持有的整行原样回插。
#[tauri::command]
pub async fn restore_notification(
    app: tauri::AppHandle,
    record: NotificationRecord,
) -> DbResult<()> {
    if record.id.trim().is_empty() {
        return Err(DbError::Task("notification id must not be empty".into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        NotificationRepo::restore(&conn, &record)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn read_notification(
    app: tauri::AppHandle,
    id: String,
) -> DbResult<Option<NotificationRecord>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        NotificationRepo::mark_read(&conn, &id)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// 全部标已读，返回受影响行数（0 = 本就没有未读，前端可据此跳过刷新）。
#[tauri::command]
pub async fn read_all_notifications(app: tauri::AppHandle) -> DbResult<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        NotificationRepo::mark_all_read(&conn)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn delete_notification(app: tauri::AppHandle, id: String) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        NotificationRepo::delete(&conn, &id)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn clear_notifications(app: tauri::AppHandle) -> DbResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        NotificationRepo::clear(&conn)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

// ---------------------------------------------------------------------------
// Heavy commands below run via spawn_blocking. Sync (non-async) commands
// execute on the Tauri main thread: a multi-second export/import/backup would
// freeze every webview and stall any main-thread IPC the low-level mouse hook
// depends on. Async + spawn_blocking keeps the UI pipeline alive.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn export_data(app: tauri::AppHandle) -> DbResult<AppData> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // C-1：导出是纯读，走 read_db，不阻塞（也不被）写路径。
        let conn = state.read_db.acquire()?;
        BackupRepo::export_all(&conn)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn import_data(
    window: tauri::Window,
    app: tauri::AppHandle,
    data: AppData,
) -> DbResult<ImportResult> {
    // 闸门（H1）：导入可写 `app:settings:v1`（含 extra.updateEndpoint——更新
    // 下载链的同域校验基点）。低信任窗（quick-note / taskbar-net）被注入时
    // 若能直接 invoke 导入，即可把更新指向攻击者域，配合后续「下载并安装」
    // 构成静默 RCE 链。整库替换只允许从设置窗发起（恢复入口的 read_text_file
    // 闸门只挡住了读文件，这里挡导入本身）。
    require_settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut conn = lock_db(&state.db)?;
        BackupRepo::import_all(&mut conn, &data)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn create_backup(app: tauri::AppHandle) -> DbResult<BackupInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        // Phase 1 (read only, on the read connection): export only.
        let data = {
            let state = app.state::<AppState>();
            // C-1：备份阶段一只读导出，走 read_db 避免与写路径互锁。
            let conn = state.read_db.acquire()?;
            BackupRepo::export_all(&conn)?
        };
        // Phase 2 (lock released): pretty-printing + writing a JSON that can
        // reach tens of MB must not extend the DB lock or block the main thread.
        backup::write_backup(&app, &data)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn list_backups(app: tauri::AppHandle) -> DbResult<Vec<BackupInfo>> {
    tauri::async_runtime::spawn_blocking(move || backup::list_backups(&app))
        .await
        .map_err(|e| DbError::Task(e.to_string()))?
}

/// 自动备份目录（只读返回路径，供恢复文件对话框 defaultPath 定位——
/// 用户手动恢复时不需要知道备份文件藏在哪个目录）。路径属本机文件系统
/// 信息，不回传给低信任窗（与读路径闸门同源）。
#[tauri::command]
pub async fn get_backups_dir(window: tauri::Window, app: tauri::AppHandle) -> DbResult<String> {
    require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::backup::backups_dir(&app)
            .to_string_lossy()
            .to_string()
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))
}

/// settings 表读写的命令级窗口闸门（C-7/C-8 同款）：`quick-note` 及未知标签
/// 一律拒绝。写路径保护 `app:settings:v1` 里的 updateEndpoint（更新下载链的
/// 同域校验基点）与 `email:accounts`；读路径避免镜像笔记 / DPAPI 密文回传到
/// 最低信任级 webview。速记窗口的便签持久化走 `mirror_local_storage`，
/// 不经这里。
fn require_trusted(window: &tauri::Window) -> DbResult<()> {
    if crate::trusted_window(window.label()) {
        Ok(())
    } else {
        Err(DbError::Denied(window.label().to_string()))
    }
}

fn require_settings_window(window: &tauri::Window) -> DbResult<()> {
    if crate::settings_only_window(window.label()) {
        Ok(())
    } else {
        Err(DbError::Denied(window.label().to_string()))
    }
}

#[tauri::command]
pub async fn get_setting(
    window: tauri::Window,
    app: tauri::AppHandle,
    key: String,
) -> DbResult<Option<String>> {
    require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.read_db.acquire()?;
        SettingsRepo::get(&conn, &key)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// D-5：从 settings 镜像 JSON 里取 `extra.updateEndpoint`（解析失败返回
/// None——新旧任一侧解析不出都视为「变化」，fail-closed）。
fn endpoint_of(value: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(value)
        .ok()?
        .get("extra")?
        .get("updateEndpoint")?
        .as_str()
        .map(str::to_string)
}

#[tauri::command]
pub async fn set_setting(
    window: tauri::Window,
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> DbResult<()> {
    require_trusted(&window)?;
    // D-5（审查修复）：`extra.updateEndpoint` 是更新链同域校验的信任基点——
    // 被攻破的 widget 渲染层若能改它，就能把 D-1 加固后的下载域指向攻击者
    // 域。它的变更（含解析失败导致的疑似变更）只认设置窗，与 import_data
    // 的 settings-only 收口对齐；其余字段的合法跨窗持久化不受影响。
    if key == "app:settings:v1" {
        let old = {
            let state = app.state::<AppState>();
            let conn = state.read_db.acquire()?;
            SettingsRepo::get(&conn, &key)
                .unwrap_or(None)
                .unwrap_or_default()
        };
        if endpoint_of(&old) != endpoint_of(&value) {
            require_settings_window(&window)?;
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        SettingsRepo::set(&conn, &key, &value)?;
        // B-2：设置镜像写路径广播——double_tap/super_panel/push_server/
        // sysnotify 等镜像线程即时醒来，替代 2s 轮询。
        if key == crate::settings_mirror::MIRROR_KEY {
            crate::settings_mirror::notify_changed();
        }
        Ok::<(), DbError>(())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// Replaces the durable localStorage mirror (one row per `focus-desk.*` key).
/// Called by the frontend right before `create_backup` / `export_data` so the
/// snapshot carries notes, habits, bookmarks, widget configs, etc.
#[tauri::command]
pub async fn mirror_local_storage(
    window: tauri::Window,
    app: tauri::AppHandle,
    entries: Vec<SettingKV>,
) -> DbResult<()> {
    // 闸门（M1）：镜像会在恢复 / 重置 / 新机补齐时整表写回所有受信窗口的
    // localStorage（书签、小组件配置、便签），低信任窗不应能整体覆写它。
    require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut conn = lock_db(&state.db)?;
        replace_local_storage_mirror(&mut conn, &entries)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// Reads the localStorage mirror back (prefix stripped), used by restores.
#[tauri::command]
pub async fn get_local_storage_mirror(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> DbResult<Vec<SettingKV>> {
    // 与写路径 mirror_local_storage 的 M1 闸门同源：镜像整表读出（便签、
    // 书签、小组件配置）不该回传给最低信任级 webview。恢复入口只有设置窗
    // （restore-backup.ts），故用 settings 级闸门。
    require_settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // C-1：纯读，走 read_db。
        let conn = state.read_db.acquire()?;
        list_local_storage_mirror(&conn)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[tauri::command]
pub async fn delete_setting(
    window: tauri::Window,
    app: tauri::AppHandle,
    key: String,
) -> DbResult<()> {
    require_trusted(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_db(&state.db)?;
        SettingsRepo::delete(&conn, &key)
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

/// Full factory reset: wipes tasks, deadlines, focus history and the durable
/// mirrors of settings + widget layouts (every `widget:*` key, all screens) in
/// one transaction. The frontend clears localStorage on top, so the app comes
/// back to its first-run state after reload. Without this, hydrate() would
/// re-adopt the old SQLite layout and silently undo the reset.
#[tauri::command]
pub async fn reset_app_data(window: tauri::Window, app: tauri::AppHandle) -> DbResult<()> {
    // 破坏力最大的命令只允许设置窗口（唯一的调用方 GeneralPage.resetVela）发起。
    require_settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut conn = lock_db(&state.db)?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            r#"
        DELETE FROM tasks;
        DELETE FROM deadlines;
        DELETE FROM pomodoro_sessions;
        DELETE FROM pomodoro_interruptions;
        DELETE FROM notification_history;
        DELETE FROM clipboard_history;
        DELETE FROM settings WHERE key = 'app:settings:v1' OR key LIKE 'widget:%' OR key = 'email:account' OR key = 'email:accounts' OR key LIKE 'lsmirror:%';
        "#,
        )?;
        tx.commit()?;
        // 剪贴板历史的图片文件在库外（%APPDATA%/clip），随重置一并清掉。
        crate::clipboard::reset_clip_storage(&app);
        Ok(())
    })
    .await
    .map_err(|e| DbError::Task(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::endpoint_of;

    /// D-5：updateEndpoint 提取语义——字段变化/疑似变化（解析失败）都必须
    /// 能被 set_setting 的设置窗收口捕获。
    #[test]
    fn endpoint_extraction() {
        assert_eq!(
            endpoint_of(r#"{"extra":{"updateEndpoint":"https://a.example/x.json"}}"#).as_deref(),
            Some("https://a.example/x.json")
        );
        // 空串也是合法值（未配置更新源）
        assert_eq!(
            endpoint_of(r#"{"extra":{"updateEndpoint":""}}"#).as_deref(),
            Some("")
        );
        // 缺字段 / 缺 extra / 非 JSON → None（视为与任何旧值不同，fail-closed）
        assert_eq!(endpoint_of(r#"{"extra":{}}"#), None);
        assert_eq!(endpoint_of(r#"{"general":{"x":1}}"#), None);
        assert_eq!(endpoint_of("not json"), None);
        assert_eq!(endpoint_of(""), None);
    }
}
