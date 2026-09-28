//! 系统 Toast 通知监听（借鉴 NotchPeninsula 的 UserNotificationListener 轮询管线）。
//!
//! 能力：把 Windows 通知中心里**其它应用**发出的 Toast 捕获为 Vela 的事件
//! `sysnotify:captured`（载荷 { id, appName, title, body, aumid }），前端经
//! lib/system-notify 留档进通知历史 → 灵动岛接管条与通知中心磁贴同步亮起。
//! 本应用自己通过 os_notify 发出的 toast 用同一 AUMID，会在 Rust 侧被过滤，
//! 避免「自己发通知 → 自己又监听到 → 再留档一次」的回环。
//!
//! 健壮性设计（全部来自 NPS 踩坑记录，纯函数部分在本文件 #[cfg(test)]）：
//!
//! 1. **2s 快照轮询 + ID 水位线**：WinRT 的 NotificationChanged 事件在非打包
//!    桌面程序上并不可靠（NPS 实测），轮询 GetNotificationsAsync 快照、按
//!    `Id` 单调递增水位线判新是稳妥路径。首帧只建水位线不弹（否则启动时
//!    通知中心里的存量通知会一次性全弹）。
//! 2. **计数器回退护栏**：通知平台的 ID 计数器可能被重置（平台重启 / 数据库
//!    重建），此后新通知 ID 落在水位线以下而「水位线只升不降」会永久吞掉
//!    它们。用有界（512，FIFO 淘汰）「见过 ID」集合区分「回退但见过（正常
//!    重排）」与「回退且从未见过（计数器重置）」，后者重置水位线恢复捕获。
//! 3. **看门狗（自检不放在被检对象身上）**：轮询线程卡死在 WinRT 调用里时
//!    它自己不会留下任何日志，因此由独立的监督线程盯「最近一次发起轮询」
//!    时间戳；超过 30s 无发起即判定停摆，重启一条新轮询线程（代数计数，
//!    旧线程若最终返回会发现代数过期而自弃）。
//! 4. **文本归一化**：通知正文常含 \r\n / \t 等控制符，直接渲染成方块且会
//!    撑坏宽度测量；进岛前统一折叠为单行（控制符与连续空白 → 一个空格）。
//!
//! 开关：设置镜像 `notifications.systemListener`（默认开启）+ 命令
//! `set_sysnotify_enabled` 即时生效（设置页切换时前端调用，镜像持久化负责
//! 下次启动恢复）。权限不足（RequestAccessAsync 非 Allowed）时每 60s 重试，
//! 并 emit `sysnotify:status` 让设置页可以提示去系统设置开权限。

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

/// 事件名：捕获到一条系统通知（载荷 SysNotificationPayload）。
pub const EVENT_CAPTURED: &str = "sysnotify:captured";
/// 事件名：监听权限状态变化（载荷 { "access": "ok" | "denied" }）。
pub const EVENT_STATUS: &str = "sysnotify:status";

// 设置镜像里读取总开关的字段路径：notifications.systemListener。

/// 运行开关（设置镜像启动时播种，命令实时更新）。
static ENABLED: AtomicBool = AtomicBool::new(true);
/// 最近一次**发起**轮询的时刻（epoch ms；0 = 尚未发起过）。看门狗只看它——
/// 「取不到数据」由轮询自己的日志负责，看门狗专治「轮询压根没在跑」。
static LAST_ATTEMPT_MS: AtomicU64 = AtomicU64::new(0);
/// 最近一次成功取到快照的时刻（诊断用，区分调用挂死与快照冻结）。
static LAST_SNAPSHOT_MS: AtomicU64 = AtomicU64::new(0);
/// 轮询线程代数：看门狗重启时 +1，旧线程据此自弃。
static GENERATION: AtomicU64 = AtomicU64::new(0);

const POLL_INTERVAL_MS: u64 = 2_000;
const ACCESS_RETRY_MS: u64 = 60_000;
const WATCHDOG_INTERVAL_MS: u64 = 10_000;
const WATCHDOG_STALE_MS: u64 = 30_000;
/// 看门狗两次重启之间的最小间隔：卡死线程可能永远不返回，限制堆积速度。
const WATCHDOG_RESTART_MIN_GAP_MS: u64 = 120_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_instant() -> std::time::Instant {
    std::time::Instant::now()
}

/* ------------------------------------------------------------------ */
/*  纯逻辑：水位线 / 回退护栏 / 文本归一化 / Toast XML 提取             */
/* ------------------------------------------------------------------ */

/// 「见过 ID」集合容量（FIFO 淘汰最早的；NPS 同款 512）。
pub const SEEN_ID_CAPACITY: usize = 512;

/// 轮询水位线状态（Arc<Mutex> 共享给监督线程做恢复重置）。
#[derive(Debug, Default)]
pub struct NotifSyncState {
    pub bootstrapped: bool,
    pub watermark: u32,
    seen: VecDeque<u32>,
    seen_set: HashSet<u32>,
}

/// 一次快照推进的判定结果。
#[derive(Debug, PartialEq, Eq)]
pub enum AdvanceOutcome {
    /// 快照为空（通知中心本来就没通知）。
    Empty,
    /// 首帧：只建水位线，不弹存量。
    Bootstrap,
    /// 有新通知，载荷为按时间升序的新 ID 列表。
    New(Vec<u32>),
    /// 检测到计数器回退，水位线已重置（本轮不弹）。
    CounterRolledBack,
    /// 无变化（快照里的都是旧通知）。
    NoChange,
}

impl NotifSyncState {
    pub fn new() -> Self {
        Self::default()
    }

    fn remember_seen(&mut self, ids: &[u32]) {
        for &id in ids {
            if self.seen_set.insert(id) {
                self.seen.push_back(id);
            }
        }
        while self.seen.len() > SEEN_ID_CAPACITY {
            if let Some(evict) = self.seen.pop_front() {
                self.seen_set.remove(&evict);
            }
        }
    }

    /// 推进水位线（NPS Toast.cs 的 FetchLatestNotificationAsync 同款规则）。
    pub fn advance(&mut self, snapshot_ids: &[u32]) -> AdvanceOutcome {
        if snapshot_ids.is_empty() {
            return AdvanceOutcome::Empty;
        }
        let max = snapshot_ids.iter().copied().max().unwrap_or(0);
        if max == 0 {
            return AdvanceOutcome::NoChange;
        }
        if !self.bootstrapped {
            self.bootstrapped = true;
            self.watermark = max;
            self.remember_seen(snapshot_ids);
            return AdvanceOutcome::Bootstrap;
        }
        if max > self.watermark {
            let mut fresh: Vec<u32> = snapshot_ids
                .iter()
                .copied()
                .filter(|&id| id > self.watermark)
                .collect();
            fresh.sort_unstable();
            self.watermark = max;
            self.remember_seen(snapshot_ids);
            return AdvanceOutcome::New(fresh);
        }
        if max < self.watermark && !self.seen_set.contains(&max) {
            // 回退且从未见过：平台计数器被重置，重置水位线恢复后续捕获。
            self.watermark = max;
            self.remember_seen(snapshot_ids);
            return AdvanceOutcome::CounterRolledBack;
        }
        self.remember_seen(snapshot_ids);
        AdvanceOutcome::NoChange
    }
}

/// 单行归一化：控制字符（含 \r\n\t）与连续空白一律折叠成一个空格、去首尾空白。
/// emoji 的代理对不受影响（逐 char 追加，顺序不变）。
pub fn normalize_single_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        if c.is_control() || c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    out
}

/// 从 Toast 的 XML 内容里提取 <text> 元素文本（title = 第一个，其余为正文）。
/// 只做轻量扫描 + 基本实体反转义；畸形 XML 返回已解析到的部分。
pub fn extract_toast_texts(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        let after = &rest[start..];
        if let Some(tag_len) = after.find('>') {
            let tag = &after[1..tag_len];
            let inner = &after[tag_len + 1..];
            let is_text = tag.starts_with("text")
                && (tag.len() == 4 || tag.as_bytes()[4] == b' ' || tag.as_bytes()[4] == b'\t');
            if is_text {
                if let Some(end) = inner.find("</text") {
                    out.push(decode_entities(inner[..end].trim()));
                    rest = &inner[end..];
                    continue;
                }
                // 无闭合（自闭合 <text/> 已被 trim 掉属性的场景等）：放弃剩余。
                return out;
            }
            rest = inner;
        } else {
            return out;
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let (decoded, len) = if tail.starts_with("&amp;") {
            (Some('&'), 5)
        } else if tail.starts_with("&lt;") {
            (Some('<'), 4)
        } else if tail.starts_with("&gt;") {
            (Some('>'), 4)
        } else if tail.starts_with("&quot;") {
            (Some('"'), 6)
        } else if tail.starts_with("&apos;") {
            (Some('\''), 6)
        } else {
            (None, 1)
        };
        match decoded {
            Some(c) => out.push(c),
            None => out.push('&'),
        }
        rest = &rest[pos + len..];
    }
    out.push_str(rest);
    out
}

/* ------------------------------------------------------------------ */
/*  事件载荷                                                            */
/* ------------------------------------------------------------------ */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysNotificationPayload {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    pub body: String,
    pub aumid: String,
}

/// 本应用 OS toast 的 AUMID（os_notify.rs 用 tauri-winrt-notification 的
/// PowerShell 身份直发）：监听到它的通知一律丢弃，防止回环。
pub fn is_own_toast_aumid(aumid: &str) -> bool {
    aumid.contains("WindowsPowerShell") && aumid.contains("powershell.exe")
}

/* ------------------------------------------------------------------ */
/*  设置镜像读取                                                        */
/* ------------------------------------------------------------------ */

/// 从设置镜像读 notifications.systemListener（默认 true；读失败回默认）。
/// A-4：镜像读取收敛到 settings_mirror 单一助手。
fn read_enabled_from_mirror(app: &AppHandle) -> bool {
    crate::settings_mirror::read_json(app)
        .and_then(|v| {
            v.get("notifications")
                .and_then(|n| n.get("systemListener"))
                .and_then(|b| b.as_bool())
        })
        .unwrap_or(true)
}

/// 设置页即时开关（前端持久化镜像负责下次启动；本命令只翻运行时标志）。
#[tauri::command]
pub fn set_sysnotify_enabled(window: tauri::Window, enabled: bool) -> Result<(), String> {
    // 窗口闸门：开关驱动系统通知轮询，不给 web-preview 远程页面。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        // 重新打开时清掉旧的水位线陈旧计时，看门狗立刻能看出「轮询在跑」。
        LAST_ATTEMPT_MS.store(now_ms(), Ordering::SeqCst);
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/*  轮询线程（Windows）                                                 */
/* ------------------------------------------------------------------ */

/// 投递范围与 media.rs 一致：全部 widget 窗口 + 设置窗（quick-note /
/// taskbar-net 不需要系统通知镜像）。
fn emit_payload(app: &AppHandle, payload: &SysNotificationPayload) {
    use tauri::Emitter;
    let _ = app.emit_filter(EVENT_CAPTURED, payload, |win| match win {
        tauri::EventTarget::WebviewWindow { label }
        | tauri::EventTarget::Webview { label }
        | tauri::EventTarget::Window { label }
        | tauri::EventTarget::AnyLabel { label } => {
            label == "settings" || label.starts_with("widget-")
        }
        _ => false,
    });
}

#[cfg(windows)]
fn poll_thread(app: AppHandle, gen: u64) {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::UI::Notifications::Management::UserNotificationListener;
    use windows::UI::Notifications::NotificationKinds;

    // MTA：GetNotificationsAsync 的快照允许在 MTA 线程调用（NPS 同款）。
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        log::error!("sysnotify: COM init failed: {}", hr.0);
        return;
    }
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let _com = ComGuard(hr.is_ok());

    let state = Arc::new(Mutex::new(NotifSyncState::new()));

    let listener = match UserNotificationListener::Current() {
        Ok(l) => l,
        Err(e) => {
            log::warn!("sysnotify: UserNotificationListener unavailable: {e}");
            return;
        }
    };

    let mut access_ok = false;
    let mut last_access_warn = std::time::Instant::now() - Duration::from_secs(ACCESS_RETRY_MS);
    let mut last_rollback_log = std::time::Instant::now() - Duration::from_secs(600);

    loop {
        if GENERATION.load(Ordering::Acquire) != gen {
            return; // 已被看门狗替换：本线程自弃，避免双轮询。
        }
        if !ENABLED.load(Ordering::SeqCst) {
            // B-5：禁用态不再与启用态同频 2s 空醒——等镜像变更即醒
            // （重新打开监听即时生效），10s 兜底复查。
            crate::settings_mirror::wait_for_change(Duration::from_secs(10));
            continue;
        }
        LAST_ATTEMPT_MS.store(now_ms(), Ordering::SeqCst);

        if !access_ok {
            let access = listener.RequestAccessAsync().map(|op| op.get());
            match access {
                Ok(Ok(windows::UI::Notifications::Management::UserNotificationListenerAccessStatus::Allowed)) => {
                    access_ok = true;
                    log::info!("sysnotify: notification access granted");
                    let _ = tauri::Emitter::emit(&app, EVENT_STATUS, serde_json::json!({ "access": "ok" }));
                }
                _ => {
                    if last_access_warn.elapsed() >= Duration::from_secs(ACCESS_RETRY_MS) {
                        last_access_warn = std::time::Instant::now();
                        let retry_s = ACCESS_RETRY_MS / 1000;
                        log::warn!("sysnotify: access denied (设置 > 隐私和安全性 > 通知)，{retry_s}s 后重试");
                        let _ = tauri::Emitter::emit(&app, EVENT_STATUS, serde_json::json!({ "access": "denied" }));
                    }
                    std::thread::sleep(Duration::from_millis(ACCESS_RETRY_MS.min(POLL_INTERVAL_MS * 8)));
                    continue;
                }
            }
        }

        match listener
            .GetNotificationsAsync(NotificationKinds::Toast)
            .map(|op| op.get())
        {
            Ok(Ok(view)) => {
                LAST_SNAPSHOT_MS.store(now_ms(), Ordering::SeqCst);
                let mut ids = Vec::new();
                let mut notes = Vec::new();
                let size = view.Size().unwrap_or(0);
                for i in 0..size {
                    if let Ok(n) = view.GetAt(i) {
                        if let Ok(id) = n.Id() {
                            ids.push(id);
                        }
                        notes.push(n);
                    }
                }
                let outcome = state
                    .lock()
                    .map(|mut s| s.advance(&ids))
                    .unwrap_or(AdvanceOutcome::Empty);
                match outcome {
                    AdvanceOutcome::New(fresh) => {
                        for n in notes {
                            let Ok(id) = n.Id() else { continue };
                            if !fresh.contains(&id) {
                                continue;
                            }
                            if let Some(p) = extract_payload(&n) {
                                log::debug!(
                                    "sysnotify: captured [{}] {} · {}",
                                    p.id,
                                    p.app_name,
                                    p.title
                                );
                                emit_payload(&app, &p);
                            }
                        }
                    }
                    AdvanceOutcome::CounterRolledBack
                        if last_rollback_log.elapsed() >= Duration::from_secs(600) =>
                    {
                        last_rollback_log = std::time::Instant::now();
                        log::warn!(
                            "sysnotify: notification id counter rolled back; watermark reset"
                        );
                    }
                    _ => {}
                }
            }
            Ok(Err(e)) => {
                // 权限被撤销等：回到重试授权的路径（NPS：静默空列表与异常都要能自愈）。
                log::warn!("sysnotify: GetNotificationsAsync failed: {e}");
                access_ok = false;
            }
            Err(e) => {
                log::warn!("sysnotify: GetNotificationsAsync dispatch failed: {e}");
            }
        }

        // 睡眠切成小片，缩短被替换 / 被关闭时的退出延迟。
        let deadline = now_instant() + Duration::from_millis(POLL_INTERVAL_MS);
        while now_instant() < deadline {
            if GENERATION.load(Ordering::Acquire) != gen || !ENABLED.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

/// 从 UserNotification 提取展示载荷；提取失败（无 Visual / 无文本）返回 None。
#[cfg(windows)]
fn extract_payload(
    n: &windows::UI::Notifications::UserNotification,
) -> Option<SysNotificationPayload> {
    use windows::core::Interface;
    let id = n.Id().unwrap_or(0);
    let (app_name, aumid) = match n.AppInfo() {
        Ok(info) => {
            let aumid = info
                .AppUserModelId()
                .map(|s| s.to_string())
                .unwrap_or_default();
            if is_own_toast_aumid(&aumid) {
                return None; // 本应用自己发的 toast：过滤回环。
            }
            let name = info
                .DisplayInfo()
                .and_then(|d| d.DisplayName().map(|s| s.to_string()))
                .unwrap_or_default();
            (name, aumid)
        }
        Err(_) => (String::new(), String::new()),
    };
    let toast = n
        .Notification()
        .ok()?
        .cast::<windows::UI::Notifications::ToastNotification>()
        .ok()?;
    let xml = toast
        .Content()
        .ok()?
        .GetXml()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let texts = extract_toast_texts(&xml);
    if texts.is_empty() {
        return None;
    }
    let title = normalize_single_line(&texts[0]);
    let body = normalize_single_line(&texts[1..].join(" "));
    if title.is_empty() && body.is_empty() {
        return None;
    }
    Some(SysNotificationPayload {
        id,
        app_name: if app_name.is_empty() {
            "系统通知".into()
        } else {
            app_name
        },
        title,
        body,
        aumid,
    })
}

/* ------------------------------------------------------------------ */
/*  启动入口 + 看门狗监督线程                                           */
/* ------------------------------------------------------------------ */

pub fn start_system_notification_watcher(app: AppHandle) {
    ENABLED.store(read_enabled_from_mirror(&app), Ordering::SeqCst);
    spawn_poll(app.clone());
    std::thread::Builder::new()
        .name("sysnotify-watchdog".into())
        .spawn(move || watchdog_loop(app))
        .ok();
}

fn spawn_poll(app: AppHandle) {
    let gen = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    LAST_ATTEMPT_MS.store(now_ms(), Ordering::SeqCst);
    std::thread::Builder::new()
        .name("sysnotify-poll".into())
        .spawn(move || {
            #[cfg(windows)]
            poll_thread(app, gen);
            #[cfg(not(windows))]
            let _ = (app, gen);
        })
        .ok();
}

/// 监督线程：只盯「最近一次发起轮询」时间戳。轮询线程卡死在 WinRT 调用里时
/// 不会有任何日志，自检必须放在被检对象之外（NPS 2026-09-25 的教训）。
fn watchdog_loop(app: AppHandle) {
    let mut last_restart =
        std::time::Instant::now() - Duration::from_millis(WATCHDOG_RESTART_MIN_GAP_MS);
    let mut last_warn = std::time::Instant::now() - Duration::from_secs(300);
    loop {
        std::thread::sleep(Duration::from_millis(WATCHDOG_INTERVAL_MS));
        if !ENABLED.load(Ordering::SeqCst) {
            continue;
        }
        let attempt = LAST_ATTEMPT_MS.load(Ordering::Acquire);
        if attempt == 0 {
            continue; // 尚未发起过第一轮：交给轮询自己。
        }
        let silent_ms = now_ms().saturating_sub(attempt);
        if silent_ms < WATCHDOG_STALE_MS {
            continue;
        }
        if last_warn.elapsed() >= Duration::from_secs(300) {
            last_warn = std::time::Instant::now();
            let snap = LAST_SNAPSHOT_MS.load(Ordering::Acquire);
            let snap_age = if snap == 0 {
                -1i64
            } else {
                now_ms().saturating_sub(snap) as i64
            };
            log::warn!(
                "sysnotify: watchdog — 轮询已 {silent_ms}ms 没有任何一次发起（上次快照 {snap_age}ms 前），疑似停摆，重启轮询线程"
            );
        }
        if last_restart.elapsed() >= Duration::from_millis(WATCHDOG_RESTART_MIN_GAP_MS) {
            last_restart = std::time::Instant::now();
            spawn_poll(app.clone());
        }
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn extract_payload_stub() {}

/* ------------------------------------------------------------------ */
/*  单元测试（纯逻辑，无 WinRT 依赖）                                   */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_sets_watermark_without_emitting() {
        let mut s = NotifSyncState::new();
        assert_eq!(s.advance(&[5, 9, 7]), AdvanceOutcome::Bootstrap);
        assert_eq!(s.watermark, 9);
        assert_eq!(s.advance(&[9]), AdvanceOutcome::NoChange);
    }

    #[test]
    fn new_ids_above_watermark_emit_sorted() {
        let mut s = NotifSyncState::new();
        s.advance(&[9]);
        assert_eq!(s.advance(&[12, 9, 11]), AdvanceOutcome::New(vec![11, 12]));
        assert_eq!(s.watermark, 12);
    }

    #[test]
    fn counter_rollback_resets_watermark_once() {
        let mut s = NotifSyncState::new();
        s.advance(&[100]);
        s.advance(&[105]);
        // 计数器重置：新快照最大 ID 落到水位线下且从未见过。
        assert_eq!(s.advance(&[3]), AdvanceOutcome::CounterRolledBack);
        assert_eq!(s.watermark, 3);
        // 之后的正常递增恢复捕获。
        assert_eq!(s.advance(&[4]), AdvanceOutcome::New(vec![4]));
    }

    #[test]
    fn seen_ids_below_watermark_do_not_trigger_rollback() {
        let mut s = NotifSyncState::new();
        s.advance(&[10, 11]);
        // 通知中心重排后旧通知（已见过）回到快照里：不算回退。
        assert_eq!(s.advance(&[10]), AdvanceOutcome::NoChange);
        assert_eq!(s.watermark, 11);
    }

    #[test]
    fn seen_capacity_is_bounded() {
        let mut s = NotifSyncState::new();
        let ids: Vec<u32> = (1..=600).collect();
        s.advance(&ids);
        assert!(s.seen.len() <= SEEN_ID_CAPACITY);
        // 淘汰掉的老 ID 再出现时会被当成「从未见过」——但它们低于水位线，
        // 走的是回退护栏分支重置水位线，不会静默。
        assert_eq!(s.advance(&[1]), AdvanceOutcome::CounterRolledBack);
    }

    #[test]
    fn empty_snapshot_is_noop() {
        let mut s = NotifSyncState::new();
        assert_eq!(s.advance(&[]), AdvanceOutcome::Empty);
        assert!(!s.bootstrapped);
    }

    #[test]
    fn normalize_collapses_control_and_whitespace() {
        assert_eq!(
            normalize_single_line("  hello \r\n\t world  "),
            "hello world"
        );
        assert_eq!(normalize_single_line("a\u{0000}b"), "a b");
        assert_eq!(normalize_single_line("emoji 🎵 ok"), "emoji 🎵 ok");
        assert_eq!(normalize_single_line(""), "");
        assert_eq!(normalize_single_line(" \r\n "), "");
    }

    #[test]
    fn toast_xml_extraction_takes_text_elements_in_order() {
        let xml = "<toast><visual><binding template=\"ToastGeneric\">\
                   <text>标题A</text><text>第一行</text><text>第二行</text>\
                   </binding></visual></toast>";
        assert_eq!(extract_toast_texts(xml), vec!["标题A", "第一行", "第二行"]);
    }

    #[test]
    fn toast_xml_decodes_entities() {
        let xml = "<toast><text>A &amp; B &lt;x&gt;</text></toast>";
        assert_eq!(extract_toast_texts(xml), vec!["A & B <x>"]);
    }

    #[test]
    fn toast_xml_without_text_returns_empty() {
        assert!(extract_toast_texts("<toast><visual></visual></toast>").is_empty());
        assert!(extract_toast_texts("").is_empty());
    }

    #[test]
    fn own_toast_aumid_is_filtered() {
        assert!(is_own_toast_aumid(
            "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
        ));
        assert!(!is_own_toast_aumid("com.spotify.Client"));
    }
}
