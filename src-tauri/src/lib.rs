mod audio;
mod audio_events;
mod auto_organize;
mod backup;
mod bluetooth;
mod brightness;
mod cli;
mod clipboard;
mod color;
mod commands;
mod db;
/// [DOUBLE-TAP]（ZTools 借鉴 #13）双击修饰键呼出命令面板（默认关）。
mod double_tap;
mod email;
mod excel;
mod file_history;
mod files;
mod game;
/// 全局左键监视（灵动岛展开面的岛外点击收起，二.9）：条件式 WH_MOUSE_LL。
mod global_input;
mod gpu;
mod hashfile;
mod live_folder;
mod logging;
mod media;
mod mem_trim;
mod models;
mod monitor;
mod net_history;
/// OS 通知点击回调基建（tauri-winrt-notification 直发 + 进程内激活回调）。
mod os_notify;
mod palette;
mod presence;
mod preset_package;
/// 本地 HTTP 推送入口（一.3，借鉴 NPS 的 47300 端口）：127.0.0.1 POST → 事件。
mod push_server;
mod repositories;
/// 设置镜像单一读取/变更通知助手（A-4/B-2：六处样板收敛 + 轮询事件化）。
mod settings_mirror;
mod shortcut_watch;
mod shortcuts;
mod snip;
mod storage_util;
/// [SUPER-PANEL]（ZTools 借鉴 #11）长按右键取词操作面板（默认关）。
mod super_panel;
mod sys_actions;
/// 系统 Toast 通知监听（一.1，借鉴 NPS UserNotificationListener 轮询管线）。
mod sysnotify;
mod system;
mod system_integration;
/// 任务栏自定义契约面（TB-CORE）：Wave 1 其余会话按 `taskbar::*` 路径消费，
/// 声明为 pub 使契约项在消费者落地前不被判为 dead_code。
pub mod taskbar;
mod taskbar_net;
mod tray;
mod update_sig;
mod wallpaper;
mod widget;
/// [CTX]（ZTools 借鉴 #2）窗口上下文探针：Explorer 当前路径 / 浏览器地址栏 /
/// 在目录打开终端 / 复制文本。
mod win_context;
mod windows;

pub use db::{DbError, MIGRATIONS};
pub use models::{AppData, Deadline, ImportResult, PomodoroSession, Task};

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{Emitter, Manager};
use widget::InteractiveRect;

/// Set only by the tray "退出" item. The run-loop exit guard blocks every other
/// exit request (so the desktop widget layer never disappears unexpectedly) but
/// must let an explicit user quit through.
pub(crate) static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

/// P3 心跳开关（默认开）：番茄钟运行时 primary 前端置 true，停止/暂停置
/// false。纯内存态，不持久化——重启后由前端挂载时按 isRunning 重新表态。
/// widget-0 销毁时不再关停（见 RunEvent::Destroyed 注释）：failover 广播
/// 让其余窗口继续驱动 tick。
static HEARTBEAT_ENABLED: AtomicBool = AtomicBool::new(true);
static HEARTBEAT_GATE: Mutex<()> = Mutex::new(());
static HEARTBEAT_CV: std::sync::Condvar = std::sync::Condvar::new();

/// A-tick failover 下沉 Rust（二期）：primary（widget-0）前端每收到一次
/// 心跳回一次 ack，Rust 据此判定 primary WebView 是否存活。持续失联超
/// 过该阈值即切换为全 widget 窗口 + 设置窗广播——此前副屏靠隐藏 WebView
/// 里被 Chromium 节流到 ~1 次/分的 JS interval 轮询 localStorage 竞选，
/// 失联检测本身就会晚到分钟级。
const HEARTBEAT_ACK_TIMEOUT_MS: u64 = 5_000;
/// 0 = 从未 ack（启用后 primary 一拍都没应答，视同失联）。启用瞬间在
/// set_heartbeat 里播种为当前时间，给 primary 一个完整的超时窗口。
static HEARTBEAT_LAST_ACK_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// failover 判定（纯函数，便于单测）：primary 距上次 ack 超过阈值即广播。
fn heartbeat_should_failover(now_ms: u64, last_ack_ms: u64) -> bool {
    now_ms.saturating_sub(last_ack_ms) > HEARTBEAT_ACK_TIMEOUT_MS
}

/// 设置心跳开关并唤醒挂起的心跳线程（见 setup 内 A-tick 注释）。启用时
/// 播种 ack 时间戳：新一轮计时从「开启」而非「上次 ack」起算。
fn set_heartbeat(enabled: bool) {
    HEARTBEAT_ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        HEARTBEAT_LAST_ACK_MS.store(now_ms(), Ordering::SeqCst);
    }
    HEARTBEAT_CV.notify_all();
}

/// P3：前端（primary widget-0）按番茄钟 isRunning 调用。无窗口门控——
/// 本命令只能把心跳关小/打开，无敏感面。
#[tauri::command]
fn set_heartbeat_enabled(enabled: bool) {
    set_heartbeat(enabled);
}

/// A-tick failover：primary 对每拍心跳的应答。只认 widget-0 的 ack——
/// failover 广播的接收窗（副屏/设置窗）若也回 ack，primary 真死后就再也
/// 回不到定向模式了。
#[tauri::command]
fn heartbeat_ack(window: tauri::WebviewWindow) {
    if window.label() == "widget-0" {
        HEARTBEAT_LAST_ACK_MS.store(now_ms(), Ordering::SeqCst);
    }
}

/// C-7/C-8/C-19 命令级窗口闸门：自定义 Tauri 命令不受 capability 门控，任何
/// webview 都能调用。桌面小组件层（`widget-*`）合法地需要启动应用、浏览/删除
/// 文件、贴图、读课表，`settings` 拥有恢复备份/读日志/邮件账户管理流；`snip`
/// 截图覆盖窗需要写剪贴板/落盘/钉图。除此之外（`quick-note` 及任何未知窗口）
/// 一律拒绝，作为纵深防御的命令级防线。
pub(crate) fn trusted_window(label: &str) -> bool {
    label == "settings" || label.starts_with("widget-") || label == "snip"
}

/// 仅供设置窗口调用的敏感读命令（恢复备份的 read_text_file、运行日志）。
pub(crate) fn settings_only_window(label: &str) -> bool {
    label == "settings"
}

/// A-5：命令级窗口闸门收口（含统一错误文案）。新命令优先用它而非手写
/// `if !trusted_window(...) { return Err(自拟文案) }`——全仓单一样式可
/// grep；漏写门控的命令由 scripts/check-window-gates.mjs 清单提醒。
/// 历史上同一谓词出现过 5 种中文文案变体，这里统一回 canonical 文案。
pub(crate) fn require_trusted(window: &tauri::Window) -> Result<(), String> {
    if trusted_window(window.label()) {
        Ok(())
    } else {
        Err("untrusted window".into())
    }
}

/// 同 [`require_trusted`]，谓词为 settings_only_window（敏感读命令）。
pub(crate) fn require_settings_window(window: &tauri::Window) -> Result<(), String> {
    if settings_only_window(window.label()) {
        Ok(())
    } else {
        Err("untrusted window".into())
    }
}

/// Managed application state holding the SQLite connection plus the widget
/// layer's interactive-region cache (keyed by window label) and edit-mode flag.
pub struct AppState {
    db: Mutex<Connection>,
    /// C-1：只读命令（list_*/get_setting/export/create_backup 阶段一）用的第二
    /// 条连接。与写连接 = 独立 Mutex，重备份/导入持 `db` 锁期间读路径不阻塞。
    /// R6：只读连接池（原单连接 + Mutex，备份导出期间全部只读命令串行）。
    read_db: crate::db::ReadPool,
    interactive_regions: Mutex<HashMap<String, Vec<InteractiveRect>>>,
    edit_mode: Mutex<bool>,
    always_on_top: Mutex<bool>,
    /// W-030 托盘倒计时：菜单顶部的禁用菜单项句柄，前端周期性刷新其文本。
    tray_countdown: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
    /// C-16 托盘"显示器"子菜单句柄：显示器热插拔后重建其子项（原菜单只在
    /// 启动时按当时 monitors 构建一次，拔线后菜单项仍指向已销毁的 widget-N）。
    monitor_menu: Mutex<Option<tauri::menu::Submenu<tauri::Wry>>>,
}

impl AppState {
    /// Widget 层当前的置顶偏好；monitor.rs 热插拔建新窗口时读取，
    /// 保证新屏幕的层级与已有屏幕一致（否则新窗口沉底而老窗口浮顶）。
    pub fn always_on_top_enabled(&self) -> bool {
        *self.always_on_top.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// BentoDesk 借鉴 #13：数据目录统一解析——debug 构建加 `-dev` 后缀隔离
/// （dev 版建库/备份/剪贴画廊/日志都不污染正式数据；release 与既有目录
/// 一致，无需迁移）。所有 `app_data_dir()` 调用点都应改走这里。
pub fn vela_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    let dir = app.path().app_data_dir()?;
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(format!("{}-dev", dir.to_string_lossy())))
    } else {
        Ok(dir)
    }
}

fn default_db_path(app: &tauri::AppHandle) -> PathBuf {
    // 审计修复：解析失败时不能静默落到当前工作目录（便携/服务方式拉起时
    // 可能是系统目录或网络盘，且数据多副本分散难排查）；退到用户临时目录
    // 并大声告警，与 backup.rs 的 backups_dir 策略一致。
    match vela_data_dir(app) {
        Ok(dir) => dir.join("focus-desk.db"),
        Err(e) => {
            log::error!("app_data_dir resolve failed, falling back to temp dir: {e}");
            std::env::temp_dir()
                .join("com.cleanroom.focusdesk")
                .join("focus-desk.db")
        }
    }
}

/// 日志目录（S1）：`<app_data>/logs`。
///
/// 在 `run()` 早期 AppHandle 还不存在，因此按平台约定直接推导；
/// identifier 必须与 `tauri.conf.json` 的 `identifier` 保持一致，否则
/// 日志会写到与数据库不同的目录里。
fn early_log_dir() -> Option<PathBuf> {
    // 必须与 tauri.conf.json 的 identifier 完全一致。
    const IDENTIFIER: &str = "com.cleanroom.focusdesk";
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base =
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| {
        let root = b.join(IDENTIFIER);
        // 与 vela_data_dir 同款：debug 构建落 `-dev` 目录，日志不混流。
        if cfg!(debug_assertions) {
            PathBuf::from(format!("{}-dev", root.to_string_lossy()))
        } else {
            root
        }
        .join("logs")
    })
}

/// §4.9 崩溃记录文件：`<app_data>/crash-log.json`（logs 目录旁）。
fn early_crash_file() -> Option<PathBuf> {
    early_log_dir().and_then(|d| d.parent().map(|p| p.join(logging::CRASH_FILE_NAME)))
}

/// §4.9 前端崩溃汇聚：crash-log.ts 每记录一条（小组件错误边界 / 全局
/// 未捕获异常）就上报一次，与 Rust panic 落同一个计数文件。桌面层与
/// 设置窗都可能崩，故走 trusted_window 而非 settings_only。
#[tauri::command]
async fn report_frontend_crash(
    window: tauri::Window,
    source: String,
    detail: Option<String>,
    message: String,
) -> Result<(), String> {
    require_trusted(&window)?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let path = early_crash_file().ok_or_else(|| "无法定位崩溃记录文件".to_string())?;
        let summary = match detail.as_deref() {
            Some(d) if !d.trim().is_empty() => format!("{message} ({d})"),
            _ => message,
        };
        let rec = logging::CrashRecord {
            ts: logging::now_ms(),
            kind: "frontend".to_string(),
            source: logging::truncate_chars(&format!("{label}:{source}"), 120),
            summary: logging::truncate_chars(&summary, 600),
        };
        logging::record_crash(&path, rec, logging::now_ms())
    })
    .await
    .map_err(|e| format!("崩溃记录任务失败: {e}"))?
}

/// §4.9 诊断区读取：近 7 天崩溃次数 + 最近 panic 摘要。仅设置窗口。
#[tauri::command]
async fn get_crash_stats(window: tauri::Window) -> Result<logging::CrashStats, String> {
    require_settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        let path = early_crash_file().ok_or_else(|| "无法定位崩溃记录文件".to_string())?;
        let records = logging::load_crashes(&path);
        Ok(logging::crash_stats(&records, logging::now_ms()))
    })
    .await
    .map_err(|e| format!("崩溃统计任务失败: {e}"))?
}

/// 打开日志目录（供设置页"查看运行日志"按钮使用）。
#[tauri::command]
fn open_log_dir() -> Result<(), String> {
    let dir = early_log_dir().ok_or_else(|| "无法定位日志目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建日志目录: {e}"))?;
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&dir).spawn();
    // explorer.exe 成功打开时也可能返回非零退出码，只要 spawn 成功即视为成功。
    // C-14：spawn 后交后台线程 wait() 回收子进程，避免长期运行累积僵尸句柄。
    r.map(|mut child| {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    })
    .map_err(|e| format!("无法打开日志目录: {e}"))
}

/// 读取最近的日志文本（尾部 N 行），供设置页内联查看。
/// C-19：运行日志属敏感信息，仅设置窗口可读。
#[tauri::command]
async fn read_recent_log(window: tauri::Window, lines: Option<usize>) -> Result<String, String> {
    require_settings_window(&window)?;
    let want = lines.unwrap_or(200).min(2000);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = early_log_dir().ok_or_else(|| "无法定位日志目录".to_string())?;
        let today = chrono::Local::now().format("%Y%m%d").to_string();
        let path = dir.join(format!("vela-{today}.log"));
        let meta = std::fs::metadata(&path).map_err(|e| format!("读取日志失败: {e}"))?;
        if !meta.is_file() {
            return Ok(String::new());
        }
        use std::io::{BufReader, Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(&path).map_err(|e| format!("读取日志失败: {e}"))?;
        // 只从尾部读：日志可增长到数 MB，read_to_string 会全量读盘+分配，
        // 而 99% 的内容马上被丢弃。按"行数上限 × 平均行长"倒推起点，不足
        // 再从头读。
        let avg_line = 160usize;
        let tail_bytes = want.saturating_mul(avg_line).saturating_add(4096) as u64;
        let size = meta.len();
        let start = size.saturating_sub(tail_bytes);
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("读取日志失败: {e}"))?;
        let mut reader = BufReader::new(file);
        let mut raw = String::new();
        reader
            .read_to_string(&mut raw)
            .map_err(|e| format!("读取日志失败: {e}"))?;
        // 起点若落在行中间，首行是半截，丢弃。
        let body = if start > 0 && raw.contains('\n') {
            raw.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
        } else {
            raw.as_str()
        };
        let all: Vec<&str> = body.lines().collect();
        let begin = all.len().saturating_sub(want);
        Ok(all[begin..].join("\n"))
    })
    .await
    .map_err(|e| format!("日志读取任务失败: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 日志目录需要 AppHandle 才能解析，而 `run()` 早于 `setup()`。
    // 这里先用平台标准路径直接推导（与 Tauri 的 app_data_dir 一致），
    // 从而让启动最早期的日志也能落盘 —— 启动失败恰恰是最需要日志的场景。
    logging::init(early_log_dir());
    log::info!("Vela starting");
    // §4.9 崩溃计数第一步：panic 先记日志 + 崩溃文件，再交默认 hook 打印。
    // 自重启（第二步）待诊断区数据支撑后再决定，此处只计数。
    logging::install_panic_hook(early_crash_file());
    // A-8：主线程 panic 的任务栏还原动作注入（logging 保持零业务依赖）。
    logging::set_panic_restore(taskbar::restore_all);

    tauri::Builder::default()
        // 单实例必须是第一个插件：其 setup 在其余插件与本 app setup（建窗/托盘/
        // 数据库）之前运行，第二实例在此处把 argv 转发给首实例后立即
        // process::exit——不进 run 循环，故不与 ALLOW_EXIT 退出门控交互。
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            log::info!("second instance forwarded argv: {argv:?}");
            cli::handle_second_instance(app, &argv, &cwd);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(shortcuts::plugin())
        .setup(|app| {
            let db_path = default_db_path(app.handle());
            // E-9: a migration failure must not silently crash the app before any
            // window exists. Preserve the offending DB (plus WAL sidecars) aside,
            // then rebuild a fresh one; the preserved file stays available for
            // manual recovery. Only if a fresh DB *also* fails do we surface the
            // error (the `.expect` below) — by then the log carries full context.
            //
            // 审计修复：归档重建是"库损坏"的最后手段，不应把瞬时性错误
            // （SQLITE_BUSY / IO 占用）也误判为损坏——那会让应用以空库静默
            // 启动、用户看到全部数据"消失"，且当日自动备份会把空快照固化。
            // 因此先做短重试；仅当重试后仍失败才走归档路径。归档 rename
            // 失败也必须留痕，不能 `let _` 吞掉。
            let conn = {
                let mut last_err: Option<crate::db::DbError> = None;
                let mut opened: Option<rusqlite::Connection> = None;
                for attempt in 0..3u32 {
                    match db::open_and_migrate(&db_path, MIGRATIONS) {
                        Ok(c) => {
                            opened = Some(c);
                            break;
                        }
                        Err(e) => {
                            log::warn!("database open/migrate failed (attempt {}): {e}", attempt + 1);
                            last_err = Some(e);
                            if attempt + 1 < 3 {
                                std::thread::sleep(std::time::Duration::from_millis(
                                    250 * (attempt as u64 + 1),
                                ));
                            }
                        }
                    }
                }
                match opened {
                    Some(c) => c,
                    None => {
                        let e = last_err.unwrap_or_else(|| {
                            crate::db::DbError::Task("database open failed".into())
                        });
                        log::error!("database open/migrate failed after retries ({e}); preserving DB and rebuilding");
                        let ts = chrono::Utc::now().format("%Y%m%d%H%M%S");
                        let archive = PathBuf::from(format!("{}.corrupt-{}", db_path.display(), ts));
                        if let Err(re) = std::fs::rename(&db_path, &archive) {
                            log::error!("archiving corrupt DB failed: {re}");
                        }
                        if let Err(re) = std::fs::rename(
                            format!("{}-wal", db_path.display()),
                            format!("{}-wal", archive.display()),
                        ) {
                            log::warn!("archiving WAL sidecar failed: {re}");
                        }
                        if let Err(re) = std::fs::rename(
                            format!("{}-shm", db_path.display()),
                            format!("{}-shm", archive.display()),
                        ) {
                            log::warn!("archiving SHM sidecar failed: {re}");
                        }
                        db::open_and_migrate(&db_path, MIGRATIONS).map_err(|e2| {
                            log::error!("fresh database rebuild also failed: {e2}");
                            format!("database unrecoverable: {e2}")
                        })?
                    }
                }
            };
            let read_pool = db::ReadPool::new(&db_path)
                .map_err(|e| format!("open read pool failed: {e}"))?;
            app.manage(AppState {
                db: Mutex::new(conn),
                read_db: read_pool,
                interactive_regions: Mutex::new(HashMap::new()),
                edit_mode: Mutex::new(false),
                always_on_top: Mutex::new(false),
                tray_countdown: Mutex::new(None),
                monitor_menu: Mutex::new(None),
            });
            app.manage(system::SystemSampler::new());
            app.manage(system::StatsBroadcaster::new());
            log::info!("opened database at {:?}", db_path);

            // W-153 网络流量记录器：常驻线程 10s 采样 / 60s 增量落库
            // （不受 presence 空闲降载影响——挂机期间的流量也进当日账），
            // 并承载 W-170 网速/日流量阈值系统通知。
            net_history::start_traffic_recorder(app.handle().clone());
            // P2-8 任务栏网速条：按持久化开关恢复（贴靠 Shell_TrayWnd）。
            taskbar_net::restore(app.handle());

            // Widget layer: one transparent full-screen window per connected
            // monitor so widgets can live on every display simultaneously
            // (Rainmeter-style). Each window is labeled `widget-<i>` and encodes
            // its screen index in the URL hash (`#screen=<i>`) so the frontend
            // can partition the widget store by screen. No window-level acrylic
            // — the wallpaper shows through and only the widget cards render
            // their own glass background.
            //
            // D-审计修复：按持久化「物理名 → 槽位」映射建窗，widget-N 始终
            // 落在同一物理屏，重启/热插拔换序不再互换两屏布局。
            //
            // P1：建窗按各屏持久化内容过滤——widget-0 无条件建（番茄钟主
            // 时钟/通知/便签提醒/命令面板等 D-1 全局职责挂它身上），副屏只有
            // 布局/灵动岛镜像有内容才建：空屏不再白养一个 WebView2 渲染进程
            // （约 120–170MB/屏）。R3 容错（单屏建窗失败不拖垮启动）在
            // reconcile_widget_windows_blocking 内。
            log::info!("reconciling initial widget windows");
            monitor::reconcile_widget_windows_blocking(app.handle());
            // Hot-plug: keep the widget-window set in sync when displays are
            // connected / disconnected or change resolution.
            monitor::start_monitor_watcher(app.handle().clone());
            widget::start_click_through_poller(app.handle().clone());
            // §4.6 presence：前台全屏 + 输入空闲统一感知线程（原 game.rs 全屏
            // watcher 并入），空闲时暂停 sys:stats / 音频采样。
            presence::start_presence_watcher(app.handle().clone());
            // §4.4 壁纸跟随主题：WM_SETTINGCHANGE 监听 + 30s 轮询兜底，壁纸换了
            // 才 emit wallpaper:changed（path+mtime 缓存，同图不重算）。
            wallpaper::start_wallpaper_watcher(app.handle().clone());
            // §4.8 SMTC 事件化：WinRT 事件 → media:snapshot，变化才发。
            media::start_media_event_watcher(app.handle().clone());
            // §4.10 剪贴板历史：AddClipboardFormatListener 消息线程 → 单工作
            // 线程捕获入库（采集开关从设置镜像实时读取）。
            clipboard::start_clipboard_watcher(app.handle().clone());
            // 一.1 系统 Toast 监听（水位线 + 回退护栏 + 自愈 + 看门狗）。
            sysnotify::start_system_notification_watcher(app.handle().clone());
            // 一.2 音频端点事件（硬件音量键 → osd:volume）+ 默认设备 epoch。
            audio_events::start_audio_endpoint_watcher(app.handle().clone());
            // 一.3 本地 HTTP 推送入口（默认关，设置镜像控制端口与开关）。
            push_server::start_push_server(app.handle().clone());
            // 二.9 全局左键监视：预埋 AppHandle（钩子在首次启用时惰性安装）。
            global_input::init(app.handle().clone());
            // [SUPER-PANEL]（ZTools 借鉴 #11）长按右键取词面板（默认关；钩子
            // 惰性安装在配置线程里，开关只翻 AtomicBool）。
            super_panel::init(app.handle().clone());
            // [DOUBLE-TAP]（ZTools 借鉴 #13）双击修饰键呼出面板（默认关）。
            double_tap::init(app.handle().clone());

            // A-tick failover：番茄钟主时钟下沉 Rust。隐藏 WebView 的 1s 定时器
            // 会被 Chromium 节流到 ~1次/分（副屏倒计时分钟级跳动），widget-0
            // 建窗失败则整体停摆。原生线程每秒广播 app:heartbeat，事件派发
            // 不受 webview 节流；primary 前端据此驱动 tickPomodoro（幂等）。
            //
            // failover 下沉（二期）：定向投递 widget-0，primary 每拍回
            // heartbeat_ack；失联超过 5s（WebView 崩溃/被杀/僵死）或 widget-0
            // 不存在（拔主屏）时切换为全 widget 窗口 + 设置窗广播——副屏不再
            // 依赖自身被节流的 JS interval 轮询 localStorage 竞选，接管检测在
            // 原生线程内 5s 必达。primary 恢复应答的下一拍自动回到定向模式。
            // 副屏/设置窗的候补消费是事件驱动的：收不到心跳就天然不 tick，
            // 无需让位协议。tickPomodoro 幂等（墙钟锚点），短暂双主无副作用。
            //
            // P3：番茄钟没在跑时心跳是纯空转（tick 幂等 no-op）。前端 primary
            // 在 isRunning 翻转时调 set_heartbeat_enabled；停用时线程在 Condvar
            // 上真挂起（零唤醒）。默认开启：前端尚未表态（旧包/挂载失败）时
            // 保持旧行为。
            {
                let heartbeat_handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    if HEARTBEAT_ENABLED.load(Ordering::SeqCst) {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        let now_ms = now_ms();
                        let payload = now_ms;
                        if heartbeat_should_failover(
                            now_ms,
                            HEARTBEAT_LAST_ACK_MS.load(Ordering::SeqCst),
                        ) {
                            for (label, _win) in heartbeat_handle.webview_windows() {
                                // quick-note / taskbar-net 不参与：速记窗无番茄钟
                                // UI，任务栏网速条必须保持零交互低占用。
                                if !(label == "settings" || label.starts_with("widget-")) {
                                    continue;
                                }
                                let _ = tauri::Emitter::emit_to(
                                    &heartbeat_handle,
                                    label,
                                    "app:heartbeat",
                                    payload,
                                );
                            }
                        } else {
                            let _ = tauri::Emitter::emit_to(
                                &heartbeat_handle,
                                "widget-0",
                                "app:heartbeat",
                                payload,
                            );
                        }
                    } else {
                        // 挂起直到重新启用；谓词循环防虚假唤醒，store 先于
                        // notify 完成无丢失唤醒窗口。
                        let mut guard = HEARTBEAT_GATE
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        while !HEARTBEAT_ENABLED.load(Ordering::SeqCst) {
                            guard = HEARTBEAT_CV
                                .wait(guard)
                                .unwrap_or_else(|p| p.into_inner());
                        }
                    }
                });
            }

            // P0-b：仅首次运行弹设置窗（新用户需要落地页）；之后开机直接进
            // 托盘 + 桌面挂件层——设置窗 renderer 不再开机常驻（约 110–185MB），
            // 需要时托盘左键 / Ctrl+Alt+S 唤起（销毁→重建语义，见 windows.rs）。
            windows::show_settings_on_first_boot(app.handle());

            // Global shortcuts: registration failures are logged but non-fatal
            // (e.g. another app already owns the combo).
            shortcuts::register_all(app);

            // System tray (menu + click handlers + countdown item handle).
            tray::build_tray(app)?;

            // P0：设置窗关闭即销毁（renderer 随之释放）；关闭策略与重建都
            // 在 windows::create_settings_window / show_settings_window 里，
            // 不再在此挂最小化拦截。应用仍常驻托盘。
            // 任务栏自定义（TB-CORE 契约地基）：start 只缓存 AppHandle 供
            // taskbar:* 事件 emit；探测/注入/监听在用户开启后由
            // apply_taskbar_config 链路（TB-INJECT / TB-STATE）驱动。
            taskbar::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::add_task,
            commands::update_task,
            commands::toggle_task,
            commands::delete_task,
            commands::delete_tasks,
            commands::reorder_tasks,
            commands::list_deadlines,
            commands::add_deadline,
            commands::update_deadline,
            commands::delete_deadline,
            commands::mark_deadline_notified,
            commands::set_deadline_notified_tiers,
            commands::toggle_deadline,
            commands::set_tray_countdown,
            commands::list_sessions,
            commands::add_session,
            commands::aggregate_sessions,
            commands::hourly_focus_distribution,
            commands::automation_toggle_layer,
            commands::list_interruptions,
            commands::add_interruption,
            commands::list_notifications,
            commands::add_notification,
            commands::restore_notification,
            commands::read_notification,
            commands::read_all_notifications,
            commands::delete_notification,
            commands::clear_notifications,
            commands::export_data,
            commands::import_data,
            commands::create_backup,
            commands::list_backups,
            commands::get_backups_dir,
            commands::get_setting,
            commands::set_setting,
            commands::mirror_local_storage,
            commands::get_local_storage_mirror,
            commands::delete_setting,
            commands::reset_app_data,
            hashfile::hash_file,
            snip::start_snip,
            sys_actions::sys_show_desktop,
            sys_actions::sys_task_view,
            sys_actions::sys_close_foreground,
            sys_actions::sys_close_all_stage1,
            sys_actions::sys_close_all_execute,
            // [POWER]（ZTools 借鉴 #4）电源与会话动作。
            sys_actions::sys_power_action,
            // [CTX]（ZTools 借鉴 #2）窗口上下文探针。
            win_context::read_explorer_path,
            win_context::read_browser_url,
            win_context::open_terminal_at,
            win_context::copy_text_to_clipboard,
            // [SUPER-PANEL]（ZTools 借鉴 #11）面板窗就绪补拉。
            super_panel::get_super_panel_payload,
            windows::show_fullscreen,
            windows::open_web_preview,
            windows::set_layer_fade_ms,
            snip::get_snip_frame,
            snip::write_snip_png,
            snip::pin_snip_image,
            files::list_directory,
            files::search_files,
            files::open_path,
            files::classify_path,
            files::read_text_file,
            files::read_text_preview,
            files::pick_folder,
            files::pick_file,
            files::list_apps,
            files::get_app_icon,
            files::paths_mtimes,
            files::open_system_location,
            files::known_dirs,
            files::reveal_in_explorer,
            files::delete_to_recycle_bin,
            file_history::delete_with_undo,
            file_history::undo_delete,
            files::rename_path,
            files::create_entry,
            auto_organize::apply_auto_organize,
            auto_organize::scan_auto_organize,
            auto_organize::check_paths_exist,
            shortcut_watch::apply_shortcut_watch,
            live_folder::apply_live_folders,
            preset_package::export_preset_package,
            preset_package::import_preset_package,
            preset_package::import_preset_package_from_path,
            system_integration::download_gallery_file,
            files::launch_app,
            files::list_uwp_apps,
            files::recycle_bin_count,
            files::gallery_import_file,
            files::gallery_import_bytes,
            files::gallery_delete_file,
            files::gallery_clean_thumbs,
            files::save_sketch_image,
            files::read_sketch_image,
            files::delete_sketch_image,
            files::read_image_data_url,
            open_log_dir,
            read_recent_log,
            report_frontend_crash,
            get_crash_stats,
            excel::read_excel_sheet,
            monitor::list_monitors,
            os_notify::send_os_notification,
            monitor::set_monitor,
            monitor::reconcile_widget_windows,
            set_heartbeat_enabled,
            heartbeat_ack,
            brightness::list_brightness_monitors,
            brightness::set_brightness,
            system::get_system_stats,
            system::get_disk_info,
            system::get_network_info,
            system::get_network_details,
            system::get_tcp_connections,
            system::get_battery_info,
            system::subscribe_system_stats,
            system::unsubscribe_system_stats,
            net_history::get_traffic_summary,
            net_history::get_traffic_daily,
            net_history::set_net_alerts,
            taskbar_net::set_taskbar_net_enabled,
            taskbar_net::get_taskbar_net_enabled,
            bluetooth::get_bluetooth_devices,
            bluetooth::open_bluetooth_settings,
            bluetooth::bluetooth_toggle_connection,
            clipboard::read_clipboard_text,
            clipboard::copy_image_to_clipboard,
            clipboard::list_clipboard_history,
            clipboard::restore_clipboard_entry,
            clipboard::toggle_clipboard_pin,
            clipboard::delete_clipboard_entry,
            clipboard::clear_clipboard_history,
            clipboard::get_clipboard_thumbnail,
            clipboard::open_clipboard_dir,
            sysnotify::set_sysnotify_enabled,
            global_input::set_global_left_click_watch,
            color::pick_screen_color,
            wallpaper::get_wallpaper_palette,
            wallpaper::set_desktop_wallpaper,
            wallpaper::read_image_thumbnails,
            audio::start_audio_spectrum,
            audio::stop_audio_spectrum,
            audio::toggle_system_mute,
            widget::set_interactive_regions,
            widget::set_edit_mode,
            widget::set_desktop_double_click,
            widget::set_always_on_top,
            widget::get_widget_state,
            system_integration::set_autostart,
            system_integration::get_autostart,
            system_integration::check_updates,
            system_integration::resolve_latest_tag,
            system_integration::download_update,
            system_integration::install_update,
            system_integration::set_desktop_icons,
            system_integration::get_desktop_icons,
            system_integration::fetch_url_text,
            system_integration::fetch_lyric_page,
            system_integration::net_speed_probe,
            game::get_foreground_app,
            game::get_summon_foreground,
            presence::get_presence_state,
            shortcuts::apply_shortcut_config,
            shortcuts::get_shortcut_config,
            taskbar::get_taskbar_config,
            taskbar::apply_taskbar_config,
            taskbar::get_taskbar_status,
            taskbar::get_taskbar_capabilities,
            taskbar::reset_taskbar_state,
            taskbar::preview_taskbar_state,
            taskbar::restart_explorer,
            media::get_system_media_info,
            media::control_system_media,
            media::pomodoro_media_pause_all,
            media::pomodoro_media_resume,
            media::list_media_sessions,
            media::select_media_session,
            media::get_selected_media_session,
            media::get_media_sessions_page,
            media::set_media_behavior,
            media::get_media_behavior,
            media::open_media_player,
            media::get_media_app_volume,
            media::adjust_media_app_volume,
            email::fetch_emails,
            email::mark_email_seen,
            email::delete_email,
            email::save_email_accounts,
            email::load_email_accounts,
            update_sig::verify_update_manifest,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Vela")
        // Keep the app resident: log and block any exit request that didn't
        // come from the tray "退出" item, so the widget layer never disappears.
        .run(|app_handle, event| {
            match &event {
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if ALLOW_EXIT.load(Ordering::SeqCst) {
                        log::info!("RunEvent::ExitRequested (code={code:?}) — explicit quit, allowing exit");
                        return;
                    }
                    // code == None：不是 app.exit() 发起的退出。本应用的常驻
                    // 窗口（settings 拦截关闭、widget 层常驻）在运行期不会
                    // 全部销毁，所以这条路径实际只会来自 Windows 注销/关机
                    // 的会话结束——prevent_exit 会把本应用列入"阻止关机"。
                    if code.is_none() {
                        log::info!("RunEvent::ExitRequested without code (session end) — allowing exit");
                        return;
                    }
                    log::warn!("RunEvent::ExitRequested (code={code:?}) — preventing exit");
                    api.prevent_exit();
                    let _ = app_handle.emit("app:exit-blocked", code);
                }
                tauri::RunEvent::Exit => {
                    log::warn!("RunEvent::Exit — app exiting");
                    // F-9 恢复线 1：先把任务栏还原成系统默认，再注销其余资源。
                    taskbar::restore_all();
                    shortcuts::unregister_all(app_handle);
                }
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                    // 集中清理窗口级资源：被销毁的 webview 不会再执行
                    // 前端 cleanup（monitor.rs 热拔显示器直接 destroy），
                    // 残留订阅会让广播/采集线程永久空转、regions 留下
                    // 过期的点击命中数据。
                    log::info!("window '{label}' destroyed; releasing per-window resources");
                    // A-tick failover（二期）：主小组件窗销毁（拔主屏/空屏对账/
                    // WebView 崩溃）不再关停心跳——番茄钟若还在跑，其余窗口要
                    // 靠广播接管 tick。把 ack 时间戳清零让下一拍立即进入 failover
                    // 广播（不必等 5s 超时）；重建后新 widget-0 挂载并恢复应答，
                    // 自动回到定向模式。
                    if label == "widget-0" {
                        HEARTBEAT_LAST_ACK_MS.store(0, Ordering::SeqCst);
                    }
                    if let Some(bc) = app_handle.try_state::<system::StatsBroadcaster>() {
                        bc.drop_window(label);
                    }
                    audio::drop_window(label);
                    global_input::drop_window(label);
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        state
                            .interactive_regions
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(label);
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod heartbeat_tests {
    use super::{heartbeat_should_failover, HEARTBEAT_ACK_TIMEOUT_MS};

    #[test]
    fn fresh_ack_stays_targeted() {
        // 刚 ack 过（含启用瞬间播种）绝不能误判失联——否则每轮启动都闪一拍广播。
        assert!(!heartbeat_should_failover(1_000_000, 1_000_000));
        assert!(!heartbeat_should_failover(
            1_000_000 + HEARTBEAT_ACK_TIMEOUT_MS,
            1_000_000
        ));
    }

    #[test]
    fn stale_ack_triggers_failover() {
        assert!(heartbeat_should_failover(
            1_000_000 + HEARTBEAT_ACK_TIMEOUT_MS + 1,
            1_000_000
        ));
    }

    #[test]
    fn never_acked_is_failover() {
        // 0 = 从未应答（widget-0 建窗失败 / 销毁时清零）：超时窗口按启用时刻起算
        // 已由 set_heartbeat 播种覆盖，此处兜底任意迟到读数直接广播。
        assert!(heartbeat_should_failover(HEARTBEAT_ACK_TIMEOUT_MS * 10, 0));
    }

    #[test]
    fn clock_skew_is_clamped() {
        // ack 时间戳来自 SystemTime，NTP 回拨不应产生巨大差值导致误广播；
        // saturating_sub 保证最坏差 0（不 failover）。
        assert!(!heartbeat_should_failover(500, 100_000));
    }
}
