//! 注入与恢复引擎：把 TAP 的 DLL、状态流、契约
//! 契约连成闭环——探测 → 解包 → 注入 → 管道 → 下发外观 → 恢复保障。
//!
//! # 生效链路（§5.2 / ）
//! [`apply_config`]（mod.rs `apply_taskbar_config` 调用）：enabled=false →
//! [`restore_all`]（停线程 + 管道 RestoreAll + Idle）；enabled=true →
//! [`ensure_started`]（幂等：已在跑则只下发新外观表，不重复注入）→
//! [`send_appearance`] 按当前求值结果下发 ApplyAppearance /
//! SetBorderVisibility → 返回失败项列表。
//!
//! # 注入序列
//! 探测 XAML（否则 Degraded）→ DLL 解包 `%TEMP%\vela\tap\<hash>\`（哈希
变了落新目录，绕开旧 explorer 占用）→
//! **驻留检查**（explorer 已挂 velatap.dll：同版本只建管道"唤醒"既有副本——
//! DLL 被钉住永不卸载、断连后无限重连，二次注入只会制造多副本；不同版本拒绝
//! 注入并提示重启资源管理器）→ 本进程 LoadLibrary 取 hook 导出 → 建命名标记
//! 事件 → 建管道实例（注入前，无竞态）→ `SetWindowsHookEx(WH_CALLWNDPROC,
//! hook, dll, tid)` → `SendMessageTimeout` 触发加载（CALLWNDPROC 只走**发送**
//! 消息，PostMessage 不会触发；带 2s 超时防 explorer 挂死）→ 等管道握手（整体
//! 35s）→ 版本不匹配即 Failed（不强杀 explorer）。
//!
//! # 与 velatap.dll 的接缝约定（DLL 未交付时按下述约定预留）
//! 1. DLL 须导出 hook 过程 `CallWndProc`（`extern "system" fn(i32, WPARAM,
//!    LPARAM) -> LRESULT`，转发 CallNextHookEx 即可；备用名
//!    `velatap_hook_proc`）；
//! 2. DLL 在 DllMain 检测命名事件 [`marker_event_name`]（注入器注入前创建、
//!    握手完成后关闭）——存在才初始化；主进程因注入需要自加载的那份副本
//!    在事件创建**之前**加载，故保持静默；
//! 3. 加载后作为客户端连接 [`protocol::pipe_name`]（explorer PID 命名），
//!    回 `Ready` 握手、答 `Pong`、执行 ApplyAppearance /
//!    SetBorderVisibility / RestoreAll（协议见 protocol.rs，冻结）。
//!
//! # 四条恢复线
//! - 线 1 正常退出：`RunEvent::Exit` → [`restore_all`]（RestoreAll + 卸钩）。
//! - 线 2 崩溃/panic：logging panic hook 追加 [`restore_all`] best-effort；
//!   强杀（kill -9）依赖 DLL 持主进程句柄自恢复（TAP 侧实现，本侧负责
//!   探测与提示）。
//! - 线 3 explorer 重启：win_watcher `TaskbarCreated` → [`on_taskbar_created`]
//!   全量重建（清状态→重枚举→重注入→重求值），带重入保护；30s 内两次 → 自动停用模块 + 状态 Degraded + 文案
//!   「检测到资源管理器频繁重启，已暂停任务栏自定义」（崩溃循环保护，不弹系统对话框）。
//! - 线 4 升级残留：启动时读 `%TEMP%\vela\tap` 元数据，上次注入的 DLL 哈希
//!   ≠ 当前且 explorer 仍挂着 velatap.dll → 状态条提示重启资源管理器
//! （文案；不强杀）。
//!
//! # 失败纪律
//! 任何注入失败都是**终态 Failed**（带一句话原因），绝不自动重试风暴；
//! 恢复入口只有三个：用户重新应用（apply / 重新应用按钮）、explorer 重启
//! （TaskbarCreated 重建）、应用重启。管道断连是唯一例外：转 Degraded 后
//! 重试**连接**（不重复注入），因为 DLL 侧按协议「断连→恢复默认并等重连」。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::models::{TaskbarCapabilities, TaskbarPhase, TaskbarStatus};
use crate::taskbar::detect::{self, TaskbarType};
use crate::taskbar::protocol::{self, TapMessage};
use crate::taskbar::{self, StateResolution, TaskbarAccent, TaskbarAppearance, TaskbarSettings};

/* ================== 可调参数 ================== */

/// 注入后等管道握手（连接 + Hello/Ready）的整体超时（35s）。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(35);
/// 心跳间隔（§5.2：5s Ping）。
pub const PING_INTERVAL: Duration = Duration::from_secs(5);
/// Pong 过期阈值：两个心跳周期无应答判死（12s）。
pub const PONG_STALE_MS: u64 = 12_000;
/// explorer 重启后等它把任务栏建完再重注入。
pub const REBUILD_SETTLE: Duration = Duration::from_millis(800);
/// 崩溃循环保护窗口（30s）。
pub const CRASH_LOOP_WINDOW_MS: u64 = 30_000;
/// 断连后重连尝试的间隔（连接尝试本身另有超时）。
pub const RECONNECT_RETRY: Duration = Duration::from_secs(2);
/// apply 等待注入就绪的上限（稳态下亚秒；首启注入通常 1-2s）。
pub const APPLY_WAIT_READY: Duration = Duration::from_secs(10);

/// DLL 必须导出的 hook 过程名（按序探测；约定见模块文档）。
/// `VelaTapHookProc` 是 taskbar_tap 实际导出名；`CallWndProc`
/// 为兼容备用名，联调 mock 与未来变体兜底。
pub const HOOK_EXPORT_NAME: &str = "VelaTapHookProc";
pub const HOOK_EXPORT_FALLBACK: &str = "CallWndProc";
pub const HOOK_EXPORT_FALLBACK2: &str = "velatap_hook_proc";

/// 注入标记事件名（Local\ 命名空间 = 当前会话；存在即「本次为注入加载」）。
pub fn marker_event_name(explorer_pid: u32) -> String {
    format!(r"Local\velatap-inject-{explorer_pid}")
}

/// 墙钟毫秒（元数据/状态展示用；测试注入假值）。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 单调毫秒（自进程锚点）：心跳判死 / 崩溃窗口计时用。：
/// 墙钟（SystemTime）在系统睡眠唤醒、NTP 校时、手动改钟下会跳变——睡眠
/// 超过 12s 后唤醒，`now - last_pong` 必超阈值，完全健康的 DLL 会话被误判
/// 死亡（断连 → DLL 按协议 RestoreAll → 外观闪回默认态 → 2~3s 重连重发，
/// 用户每次合盖唤醒都能看到这一闪）。Instant 单调不受校时影响；睡眠期间
/// 是否计时依平台而异，故判死前还有一拍补 Ping 复核（见 spawn_ping_thread）。
fn mono_ms() -> u64 {
    static ANCHOR: OnceLock<std::time::Instant> = OnceLock::new();
    ANCHOR
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

/// 宿主 OS 是否 原生（见 inject_once 的 1.5 步注释）。
#[cfg(windows)]
fn host_is_arm64() -> bool {
    use windows::Win32::System::SystemInformation::{
        GetNativeSystemInfo, PROCESSOR_ARCHITECTURE_ARM64, SYSTEM_INFO,
    };
    let mut info = SYSTEM_INFO::default();
    // SAFETY: 只写本栈帧结构体，无共享状态；GetNativeSystemInfo 全量初始化。
    unsafe { GetNativeSystemInfo(&mut info) };
    // SAFETY: union 读前已由 GetNativeSystemInfo 完整写入。
    let arch = unsafe { info.Anonymous.Anonymous.wProcessorArchitecture };
    arch == PROCESSOR_ARCHITECTURE_ARM64
}

#[cfg(not(windows))]
fn host_is_arm64() -> bool {
    false
}

/* ================== 纯函数（单测锚点） ================== */

/// 64：DLL 内容指纹（仅变化检测用，非安全哈希；避免为此引依赖）。
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// DLL 内容指纹（完整性职责，M2）：SHA-256 前 8 字节。此前解包复用 / 驻留
/// 版本比对用 ——非加密哈希，同会话攻击者可在用户可写的
/// `%TEMP%` 的 `vela/tap/<指纹>/` 下预置一个指纹相同的恶意 PE（PE padding
/// 可自由调哈希），复用分支会把它直接 `LoadLibrary` 进 explorer。SHA-256
/// 前缀使预制碰撞在计算上不可行。
pub fn dll_hash64(bytes: &[u8]) -> u64 {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(bytes);
    // SHA-256 摘要恒为 32 字节，切片不可能越界；仍走安全转换彻底消 panic 面
    //让 dll_hash64 对任意输入都是全函数。
    let eight: Option<[u8; 8]> = d.get(..8).and_then(|b| b.try_into().ok());
    u64::from_be_bytes(eight.unwrap_or([0u8; 8]))
}

/// 崩溃循环判定：30s 窗口内 ≥2 次 TaskbarCreated（「两次 explorer 重启间隔 <30s」收严为事件计数）。
pub fn is_crash_loop(created_ts_ms: &[u64], now: u64) -> bool {
    created_ts_ms
        .iter()
        .filter(|t| now.saturating_sub(**t) < CRASH_LOOP_WINDOW_MS)
        .count()
        >= 2
}

/// 降级路径：blur 不可用时整体转 acrylic。
/// 返回 (外观, 是否降级)。
pub fn degrade_appearance(
    app: &TaskbarAppearance,
    caps: &TaskbarCapabilities,
) -> (TaskbarAppearance, bool) {
    if caps.supports_blur || app.accent != TaskbarAccent::Blur {
        return (app.clone(), false);
    }
    let mut out = app.clone();
    out.accent = TaskbarAccent::Acrylic;
    (out, true)
}

/// 一个 monitor 目标的一组下发消息（ApplyAppearance + SetBorderVisibility，
/// 顺序固定；每屏去重以这组消息整体为键）。
pub fn appearance_messages(monitor: u64, app: &TaskbarAppearance) -> Vec<TapMessage> {
    vec![
        TapMessage::ApplyAppearance {
            monitor,
            accent: app.accent.into(),
            color_abgr: app.color_abgr(),
            blur_radius: app.blur_radius,
        },
        TapMessage::SetBorderVisibility {
            monitor,
            visible: app.show_line,
        },
    ]
}

/// 由当前配置构造下发消息集（每屏）：每个目标 `(slot, monitor 线值)` 一组
/// [`appearance_messages`]。外观来源按优先级：
/// 1. 引擎已上报过该槽位 → 用其**当前状态键 + 命中规则**从（新）配置重取
///    外观（[`taskbar::appearance_for_slot_state`]：apply 时即时基线，不闪桌面态）；
/// 2. 无缓存（刚就绪 / 新屏）→ 该槽位生效配置的桌面态；
/// 3. 无槽位（注册表空 → 单条 monitor=0 广播）→ 基础配置桌面态。
///
/// 引擎随后的精确重求值（`request_reevaluate`）覆盖 1/2 的近似。
/// 返回 (消息集, 降级备注)。
pub fn build_appearance_messages(
    config: &TaskbarSettings,
    caps: &TaskbarCapabilities,
    targets: &[(Option<u32>, u64)],
    cached: &[(u32, StateResolution)],
) -> (Vec<TapMessage>, Vec<String>) {
    let inputs = taskbar::StateInputs::default();
    let mut msgs = Vec::with_capacity(targets.len() * 2);
    let mut degraded_any = false;
    for &(slot, monitor) in targets {
        let appearance = match slot {
            Some(s) => match cached.iter().find(|(k, _)| *k == s) {
                Some((_, res)) => taskbar::appearance_for_slot_state(
                    config,
                    s,
                    res.state,
                    res.matched_rule.as_deref(),
                ),
                None => taskbar::resolve_active_state_for_slot(config, &inputs, 0, s).appearance,
            },
            None => taskbar::resolve_active_state(config, &inputs, 0).appearance,
        };
        let (app, degraded) = degrade_appearance(&appearance, caps);
        degraded_any |= degraded;
        msgs.extend(appearance_messages(monitor, &app));
    }
    let mut notes = Vec::new();
    if degraded_any {
        notes.push("当前系统任务栏不支持 blur，已降级为 acrylic".to_string());
    }
    (msgs, notes)
}

/* ================== 每屏任务栏注册表 ================== */

/// 一台任务栏窗口的登记项。
/// - `hmonitor`：所在显示器（对每台
///   显示器四边 `ABM_GETAUTOHIDEBAREX` 探测，自动隐藏任务栏停靠屏外时
///   `MonitorFromWindow` 会错；探不到回退 `MonitorFromWindow`）。同时是线协议
///   `ApplyAppearance.monitor` 的值（DLL 侧对任务栏 XAML 岛 `MonitorFromWindow`
///   得同值，见 protocol.rs）。
/// - `slot`：该显示器的稳定槽位（[`taskbar::state::monitor_entries`] 与
///   monitor.rs `monitor:slots` 几何对齐；覆盖表键 = [`taskbar::slot_key`]）。
///   None = HMONITOR 不在显示器表里（瞬时拓扑切换），只能收 monitor=0 广播。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskbarEntry {
    pub hwnd: isize,
    pub hmonitor: isize,
    pub slot: Option<u32>,
}

/// 任务栏 `(hwnd, hmonitor)` × 显示器 `(hmonitor, slot)` → 登记项（纯函数）。
/// hwnd 去重；同一槽位只保留先到的任务栏（病理：拓扑切换瞬间新旧并存）；
/// hmonitor=0 / 不在显示器表 → `slot=None`。
pub fn build_registry(taskbars: &[(isize, isize)], monitors: &[(isize, u32)]) -> Vec<TaskbarEntry> {
    let mut out: Vec<TaskbarEntry> = Vec::with_capacity(taskbars.len());
    for &(hwnd, hmonitor) in taskbars {
        if hwnd == 0 || out.iter().any(|e| e.hwnd == hwnd) {
            continue;
        }
        let slot = if hmonitor == 0 {
            None
        } else {
            monitors
                .iter()
                .find(|(m, _)| *m == hmonitor)
                .map(|(_, s)| *s)
        };
        if slot.is_some() && out.iter().any(|e| e.slot == slot) {
            continue;
        }
        out.push(TaskbarEntry {
            hwnd,
            hmonitor,
            slot,
        });
    }
    out
}

/// 下发目标（纯函数）：有槽位的登记项 → `(Some(slot), HMONITOR 线值)`，按槽位
/// 升序；一个都没有（注册表空 / 全部无槽位）→ 单条 `(None, 0)` 广播（对齐
/// 协议「0 = 全部任务栏」，逐屏语义退化为统一）。
pub fn send_targets(registry: &[TaskbarEntry]) -> Vec<(Option<u32>, u64)> {
    let mut out: Vec<(Option<u32>, u64)> = registry
        .iter()
        .filter_map(|e| e.slot.map(|s| (Some(s), e.hmonitor as u64)))
        .collect();
    if out.is_empty() {
        out.push((None, 0));
    }
    out.sort_by_key(|(s, _)| *s);
    out
}

static REGISTRY: Mutex<Vec<TaskbarEntry>> = Mutex::new(Vec::new());

/// 当前注册表快照。
pub fn registry_snapshot() -> Vec<TaskbarEntry> {
    REGISTRY.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// 重枚举任务栏窗口并重建 HMONITOR / 槽位映射（注入就绪 / 显示器变化 /
/// 任务栏建毁 / 重置时调用）。**后台线程执行**：含向 explorer 的
/// `SHAppBarMessage` 跨进程调用，不得在消息窗 / 引擎回调线程内直接调。
pub fn refresh_registry() -> Vec<TaskbarEntry> {
    let taskbars = imp::enumerate_taskbars();
    let monitors: Vec<(isize, u32)> = taskbar::state::monitor_entries()
        .into_iter()
        .map(|m| (m.hmonitor, m.slot))
        .collect();
    let reg = build_registry(&taskbars, &monitors);
    log::info!(
        "taskbar: 每屏任务栏注册表 {} 台：{}",
        reg.len(),
        reg.iter()
            .map(|e| format!(
                "hwnd={:#x} monitor={:#x} slot={}",
                e.hwnd,
                e.hmonitor,
                e.slot.map_or("-".to_string(), |s| s.to_string())
            ))
            .collect::<Vec<_>>()
            .join("; ")
    );
    *REGISTRY.lock().unwrap_or_else(|p| p.into_inner()) = reg.clone();
    reg
}

fn hmonitor_for_slot(slot: u32) -> Option<isize> {
    REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|e| e.slot == Some(slot))
        .map(|e| e.hmonitor)
}

/// 每屏上次求值缓存（slot → 分辨率；引擎 apply 回调写入）：apply / 重连 /
/// 注册表刷新时即时基线的来源（[`build_appearance_messages`] 规则 1）。
/// Vec 而非 HashMap：`static` 需 const 构造，显示器 ≤16 台线性查找足够。
static LAST_RESOLUTIONS: Mutex<Vec<(u32, StateResolution)>> = Mutex::new(Vec::new());

fn remember_resolution(slot: u32, res: &StateResolution) {
    let mut cache = LAST_RESOLUTIONS.lock().unwrap_or_else(|p| p.into_inner());
    match cache.iter_mut().find(|(k, _)| *k == slot) {
        Some(entry) => entry.1 = res.clone(),
        None => cache.push((slot, res.clone())),
    }
}

fn last_resolutions() -> Vec<(u32, StateResolution)> {
    LAST_RESOLUTIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

fn clear_resolutions() {
    LAST_RESOLUTIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
}

/// STATE 引擎 apply 回调（引擎线程；防抖 + 去重后每屏**变化**才到这里，分辨率
/// 已按该屏生效配置求得）：缓存 → 查注册表取该槽位 HMONITOR → 下发。未就绪 /
/// 槽位未登记只缓存——就绪或注册表刷新后的重应用补发。
fn on_state_resolved(slot: u32, res: &StateResolution) {
    remember_resolution(slot, res);
    // 预览挂起：预览会话期间状态机的实时输出不下发，
    // 否则预览期间切一次窗口就会把预览外观顶掉（预览与真实状态切换打架）。
    // 缓存照常更新——预览结束（Restore 按真实配置强制重发）后回到正确状态。
    if crate::taskbar::preview_hold_active() {
        return;
    }
    let cell = phase_cell();
    if cell.phase != TaskbarPhase::Ready {
        return;
    }
    let Some(caps) = cell.caps else {
        return;
    };
    let Some(hmon) = hmonitor_for_slot(slot) else {
        log::debug!("taskbar: 槽位 {slot} 尚无任务栏登记，待注册表刷新后补发");
        return;
    };
    let Some(pipe) = with_engine(|e| e.pipe.clone()) else {
        return;
    };
    let (app, _) = degrade_appearance(&res.appearance, &caps);
    let monitor = hmon as u64;
    match send_to_monitor(&pipe, monitor, appearance_messages(monitor, &app)) {
        Ok(true) => log::info!(
            "taskbar: 下发 slot={slot} monitor={monitor:#x} state={:?} accent={:?}",
            res.state,
            app.accent
        ),
        Ok(false) => {}
        Err(e) => log::warn!("taskbar: slot={slot} 下发失败: {e}"),
    }
}

/// 向单个 monitor 目标下发一组消息（幂等：与该目标上次成功下发的同组消息相同
/// 则跳过）。Ok(true)=已发送 / Ok(false)=去重跳过；Err=发送失败（会话已拆除，
/// 读线程 on_disconnect 接管 Degraded + 重连）。
fn send_to_monitor(
    pipe: &crate::taskbar::pipe::Pipe,
    monitor: u64,
    msgs: Vec<TapMessage>,
) -> Result<bool, String> {
    if with_engine(|e| e.last_sent.get(&monitor) == Some(&msgs)) {
        return Ok(false);
    }
    for msg in &msgs {
        pipe.send(msg)
            .map_err(|e| format!("任务栏外观下发失败: {e}"))?;
    }
    with_engine(|e| {
        e.last_sent.insert(monitor, msgs);
    });
    Ok(true)
}

static STATE_BRIDGE_INSTALLED: AtomicBool = AtomicBool::new(false);

/// 一次性接线（首次就绪时）：引擎 apply 回调 → 每屏下发；任务栏窗口建毁 →
/// 注册表重同步；启动状态检测。检测线程**进程生命周期内常驻**：模块关闭时
/// 引擎 evaluate 按 `enabled=false` 自行静默，不走 stop/start（避免 RUNNING
/// 闸的停启竞态）。
fn install_state_bridge_once() {
    if STATE_BRIDGE_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    taskbar::state::set_apply_callback(Some(Arc::new(on_state_resolved)));
    struct TrayLifecycle;
    impl taskbar::win_event::TrayWindowEventCallback for TrayLifecycle {
        fn on_tray_window_created(&self, _hwnd: isize) {
            schedule_resync("任务栏窗口创建", REGISTRY_SETTLE);
        }
        fn on_tray_window_destroyed(&self, _hwnd: isize) {
            schedule_resync("任务栏窗口销毁", REGISTRY_SETTLE);
        }
    }
    taskbar::win_event::register_tray_window_callback(Arc::new(TrayLifecycle));
    taskbar::start_state_detection();
}

/// 注入 / 重连就绪后的每屏接线：刷新注册表 → 一次性装桥 → 清每屏去重 →
/// 即时基线（缓存 / 桌面）→ 请引擎全量重求值（精确状态覆盖基线）。
fn on_ready() {
    refresh_registry();
    with_engine(|e| e.last_sent.clear());
    install_state_bridge_once();
    let _ = apply_current_config();
    taskbar::state::request_reevaluate();
}

/// 任务栏窗口建毁后等 explorer 建完再重枚举（比 explorer 整体重启的
/// [`REBUILD_SETTLE`] 短）。
pub const REGISTRY_SETTLE: Duration = Duration::from_millis(400);

/// 重同步进行中闸（settle 期间的重复请求合并为一轮）。
static RESYNCING: AtomicBool = AtomicBool::new(false);

/// 注册表重同步（热插拔：显示器拓扑变化 / 任务栏窗口建毁）：settle →
/// 重枚举映射 → 清每屏去重 → 按缓存 / 桌面基线重应用 → 请引擎全量重求值
/// （新屏按其生效配置——统一或覆盖——拿到精确状态）。后台线程执行，回调
/// 线程不阻塞；模块未启用直接忽略。
fn schedule_resync(reason: &'static str, settle: Duration) {
    if !with_engine(|e| e.enabled && e.active) {
        return;
    }
    if RESYNCING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("vela-tap-resync".to_string())
        .spawn(move || {
            std::thread::sleep(settle);
            RESYNCING.store(false, Ordering::SeqCst);
            log::info!("taskbar: {reason}，重同步每屏任务栏注册表");
            refresh_registry();
            with_engine(|e| e.last_sent.clear());
            if phase_cell().phase == TaskbarPhase::Ready {
                let _ = apply_current_config();
                taskbar::state::request_reevaluate();
            }
        })
        .is_ok();
    if !spawned {
        RESYNCING.store(false, Ordering::SeqCst);
    }
}

/// win_watcher `WM_DISPLAYCHANGE` 挂点（热插拔；消息窗线程调用，只排后台
/// 重同步）。STATE 引擎同时收到同一事件做自己的显示器重建。
pub fn on_display_change() {
    schedule_resync("显示器拓扑变化", REBUILD_SETTLE);
}

/* ================== DLL 定位与解包（§1.4） ================== */

/// 附加搜索根（tauri resource 目录，start 时注入）。
static EXTRA_DLL_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 定位随应用分发的 velatap.dll：exe 同目录（dev：target/debug；bundle 布局
/// 随安装包布局定）→ deps 上一级（cargo test 进程在 target/debug/deps）
/// → resource 目录。找不到返回 None（DLL 未交付时注入报 Failed）。
pub fn locate_dll() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("velatap.dll"));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("velatap.dll"));
            }
        }
    }
    if let Some(Some(res)) = EXTRA_DLL_DIR.get() {
        candidates.push(res.join("velatap.dll"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// 解包根：`%TEMP%\vela\tap`。
pub fn tap_root() -> PathBuf {
    std::env::temp_dir().join("vela").join("tap")
}

/// DLL 解包：`%TEMP%\vela\tap\<sha256 前 8 字节 hex>\velatap.dll`（注释
/// 修正：目录名一直是 SHA-256 前缀，早年注释误写 fnv1a16）。同哈希复用（内容
/// 未变不复制），但复用前**重算内容哈希**——目录在用户可写的 `%TEMP%`，文件可能
/// 被替换 / 损坏，不校验就会原样注入 explorer（§5.4 哈希校验）；不符则删除
/// 重拷。哈希变了落新目录——旧 explorer 仍占用旧目录也不影响新版本（规避
/// SHARING_VIOLATION 占用冲突）。
pub fn unpack_dll(src: &Path, hash: u64) -> Result<PathBuf, String> {
    let dir = tap_root().join(format!("{hash:016x}"));
    let dst = dir.join("velatap.dll");
    if dst.is_file() {
        let intact = std::fs::read(&dst)
            .map(|bytes| dll_hash64(&bytes) == hash)
            .unwrap_or(false);
        if intact {
            return Ok(dst);
        }
        log::warn!(
            "taskbar: 已解包的 velatap.dll 哈希不符（{}），重新复制",
            dst.display()
        );
        if let Err(e) = std::fs::remove_file(&dst) {
            return Err(format!(
                "已解包的 velatap.dll 校验失败且无法替换（{e}），请重启资源管理器后重试"
            ));
        }
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 DLL 解包目录失败（{}）: {e}", dir.display()))?;
    std::fs::copy(src, &dst)
        .map_err(|e| format!("复制 velatap.dll 到 {} 失败: {e}", dst.display()))?;
    Ok(dst)
}

/* ================== 注入元数据（恢复线 4 / ） ================== */

/// 上次成功注入的记录（`%TEMP%\vela\tap\metadata.json`）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectMetadata {
    pub dll_hash: u64,
    pub protocol_version: u32,
    pub explorer_pid: u32,
    pub ts_ms: u64,
}

pub fn metadata_path() -> PathBuf {
    tap_root().join("metadata.json")
}

/// 容错读取（坏 JSON / 缺文件 → None）。
pub fn read_metadata() -> Option<InjectMetadata> {
    let text = std::fs::read_to_string(metadata_path()).ok()?;
    serde_json::from_str(&text).ok()
}

/// best-effort 写入（失败只记日志——元数据仅用于升级提示，不做正确性依赖）。
pub fn write_metadata(meta: &InjectMetadata) {
    let write = || -> Result<(), String> {
        std::fs::create_dir_all(tap_root()).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
        std::fs::write(metadata_path(), text).map_err(|e| e.to_string())
    };
    if let Err(e) = write() {
        log::warn!("taskbar: 写入注入元数据失败: {e}");
    }
}

/// 升级残留提示（恢复线 4）：上次注入的 DLL 哈希 ≠ 当前、且 explorer 仍
/// 挂着 velatap.dll → 提示重启资源管理器（不主动杀）。当前 DLL 缺失
/// （DLL 未交付）时静默跳过。
pub fn residual_hint(
    recorded: Option<InjectMetadata>,
    current_dll: Option<&Path>,
) -> Option<String> {
    let meta = recorded?;
    let src = current_dll?;
    let cur_hash = dll_hash64(&std::fs::read(src).ok()?);
    if cur_hash == meta.dll_hash {
        return None;
    }
    #[cfg(windows)]
    {
        if !imp::explorer_has_velatap() {
            return None; // 旧进程已不在（explorer 已重启过），无需提示。
        }
    }
    Some(STALE_RESIDENT_HINT.to_string())
}

/// 旧版本 DLL 仍驻留 explorer 时的统一文案（启动提示与注入拒绝共用）。
pub const STALE_RESIDENT_HINT: &str =
    "检测到旧版本的任务栏 DLL 仍在资源管理器中，建议重启资源管理器以完成升级";

/// 崩溃循环保护触发时的统一文案（on_taskbar_created 与 set_phase 机器码推导
/// 共用——该 reason 原先没有稳定 code，前端只能比对中文文案）。
pub const CRASH_LOOP_HINT: &str = "检测到资源管理器频繁重启，已暂停任务栏自定义";

/// 驻留副本是否与当前 DLL 同版本（纯函数，单测覆盖）：优先比内容哈希（文件仍
/// 在且可读）；读不到（目录被清理）则退而比解包目录名——
/// `%TEMP%\vela\tap\<fnv1a64 hex>\velatap.dll` 的目录名就是哈希。
pub fn resident_same_version(resident: &Path, hash: u64) -> bool {
    if let Ok(bytes) = std::fs::read(resident) {
        return dll_hash64(&bytes) == hash;
    }
    resident
        .parent()
        .and_then(|d| d.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(&format!("{hash:016x}")))
}

/* ================== 引擎状态（PHASE + ENGINE） ================== */

/// 状态机：Idle→Injecting→Ready/Failed(reason)/Degraded(reason)；
/// 迁移即 emit `taskbar:status`（经 mod.rs EVENTS 区）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct PhaseCell {
    phase: TaskbarPhase,
    reason: Option<String>,
    /// 与 reason 配对的稳定机器码（见 set_phase 内的推导），前端据此挂动作。
    code: Option<String>,
    taskbar_type: TaskbarType,
    caps: Option<TaskbarCapabilities>,
}

impl PhaseCell {
    fn initial() -> Self {
        PhaseCell {
            phase: TaskbarPhase::Idle,
            reason: None,
            code: None,
            taskbar_type: TaskbarType::Unknown,
            caps: None,
        }
    }
}

static PHASE: Mutex<Option<PhaseCell>> = Mutex::new(None);

fn phase_cell() -> PhaseCell {
    PHASE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(PhaseCell::initial)
}

/// 状态迁移 + 变化即 emit。emit 走 mod.rs `emit_status`（start 之前为
/// 安全 no-op）。reason 同时推导稳定机器码 `code`（不随文案/i18n 变化），
/// 前端据此挂专属动作（`stale_dll_resident` → 一键/自动重启资源管理器），
/// 而不是比对中文文案。
fn set_phase(phase: TaskbarPhase, reason: Option<String>) {
    let code = match reason.as_deref() {
        Some(STALE_RESIDENT_HINT) => Some("stale_dll_resident".to_string()),
        Some(CRASH_LOOP_HINT) => Some("explorer_crash_loop".to_string()),
        _ => None,
    };
    let mut guard = PHASE.lock().unwrap_or_else(|p| p.into_inner());
    let cell = guard.get_or_insert_with(PhaseCell::initial);
    if cell.phase != phase || cell.reason != reason || cell.code != code {
        cell.phase = phase;
        cell.reason = reason.clone();
        cell.code = code;
        log::info!("taskbar: phase → {phase:?} reason={reason:?}");
        let status = status_snapshot_locked(cell);
        drop(guard);
        taskbar::emit_status(status);
    }
}

fn set_caps(caps: TaskbarCapabilities, taskbar_type: TaskbarType) {
    {
        let mut guard = PHASE.lock().unwrap_or_else(|p| p.into_inner());
        let cell = guard.get_or_insert_with(PhaseCell::initial);
        cell.caps = Some(caps.clone());
        cell.taskbar_type = taskbar_type;
    }
    taskbar::emit_capabilities(caps);
}

fn status_snapshot_locked(cell: &PhaseCell) -> TaskbarStatus {
    TaskbarStatus {
        phase: cell.phase,
        reason: cell.reason.clone(),
        code: cell.code.clone(),
        taskbar_type: cell.taskbar_type,
        protocol_version: protocol::PROTOCOL_VERSION,
    }
}

/// 引擎共享态：单锁小临界区（锁内不做任何 Win32/IO 调用，取值后放锁再动）。
struct EngineShared {
    /// 模块启用（用户开关；崩溃循环保护会置 false）。
    enabled: bool,
    /// 注入代际（重建/拆除时递增；worker/心跳/重连据此判 stale）。
    generation: u64,
    /// 注入管线在飞（ensure_started 幂等闸）。
    active: bool,
    /// 当前注入目标（explorer PID；重连复用，重建后更新）。
    explorer_pid: u32,
    pipe: Option<crate::taskbar::pipe::Pipe>,
    /// 每 monitor 目标（线值；0 = 广播）上次成功下发的消息组（幂等去重）。
    last_sent: HashMap<u64, Vec<TapMessage>>,
    #[cfg(windows)]
    hook: Option<windows::Win32::UI::WindowsAndMessaging::HHOOK>,
    #[cfg(windows)]
    marker_event: Option<windows::Win32::Foundation::HANDLE>,
    #[cfg(windows)]
    hook_dll: Option<windows::Win32::Foundation::HMODULE>,
}

impl EngineShared {
    fn new() -> Self {
        EngineShared {
            enabled: false,
            generation: 0,
            active: false,
            explorer_pid: 0,
            pipe: None,
            last_sent: HashMap::new(),
            #[cfg(windows)]
            hook: None,
            #[cfg(windows)]
            marker_event: None,
            #[cfg(windows)]
            hook_dll: None,
        }
    }
}

// SAFETY: EngineShared 的裸句柄（钩子/事件/DLL）只在锁内取值、锁外按
// 独占语义清理（卸钩→关事件→卸库），跨线程无别名使用。
unsafe impl Send for EngineShared {}
unsafe impl Sync for EngineShared {}

static ENGINE: Mutex<Option<EngineShared>> = Mutex::new(None);

fn with_engine<T>(f: impl FnOnce(&mut EngineShared) -> T) -> T {
    let mut guard = ENGINE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(EngineShared::new))
}

/// 当前代是否仍有效（worker/心跳/重连的 stale 判定）。
fn generation_alive(gen: u64) -> bool {
    with_engine(|e| e.enabled && e.active && e.generation == gen)
}

/// 全量重建重入保护。
static REBUILDING: AtomicBool = AtomicBool::new(false);
/// TaskbarCreated 时间戳（崩溃循环窗口判定）。
static CREATED_TS: Mutex<Vec<u64>> = Mutex::new(Vec::new());

/// 计划内 explorer 重启的豁免计数。restart_explorer 是本
/// 应用的正规路径（升级残留闭环 / 设置页按钮 / 升级自动重启），其后的
/// TaskbarCreated 是「我们安排的重启」而非崩溃——原实现对所有事件无差别
/// 计数，用户 30s 内点两次按钮就被崩溃循环保护误停用，与刚做的主动操作直接
/// 矛盾。每次登记豁免随后的 2 个 TaskbarCreated（主屏 + 可能的副屏任务栏
/// 都会广播该消息），仅跳过计数、正常走重建。
///
/// 豁免带登记时刻（`mono_ms`），过期作废——单屏环境一次计划重启
/// 登记 2 个、实际只消耗 1 个，残留的那 1 个此前永不过期，会让下一次
/// （哪怕数周后的）真实 explorer 崩溃被静默跳过一次计数，崩溃循环保护
/// 从「30s 内两次」退化成「三次」。
static PLANNED_RESTARTS: Mutex<(u32, u64)> = Mutex::new((0, 0));

/// 豁免有效窗口。主副屏任务栏的 TaskbarCreated 都在 explorer 启动
/// 后数秒内广播完，30s（对齐 CRASH_LOOP_WINDOW_MS 的量级）足够覆盖，
/// 又不给「计划重启之后很久才发生的真实崩溃」留漏计数的口子。
pub const PLANNED_RESTART_WINDOW_MS: u64 = 30_000;

/// 登记计划内重启豁免（每次 2 个：主屏 + 可能的副屏）。
fn grant_planned_restarts(now_mono: u64) {
    *PLANNED_RESTARTS.lock().unwrap_or_else(|p| p.into_inner()) = (2, now_mono);
}

/// 消耗一个计划内豁免；过期残留整体作废。纯逻辑封装，单测覆盖。
fn take_planned_exemption(now_mono: u64) -> bool {
    let mut guard = PLANNED_RESTARTS.lock().unwrap_or_else(|p| p.into_inner());
    if guard.0 == 0 {
        return false;
    }
    if now_mono.saturating_sub(guard.1) > PLANNED_RESTART_WINDOW_MS {
        guard.0 = 0;
        return false;
    }
    guard.0 -= 1;
    true
}
/// 心跳线程代数：每起一个新心跳线程 +1，旧线程发现代数变化即自行退出。
/// 用代数而非引用计数——计数在任一退出路径漏减就会永久拒绝新线程（曾导致
/// 第一次关/开任务栏后心跳永久消失，DLL 挂死再也判不出来）。
static PING_EPOCH: AtomicU64 = AtomicU64::new(0);

/* ================== 平台实现入口 ================== */

#[cfg(windows)]
mod imp {
    //! Windows 注入实现：序列见父模块文档。

    use std::ffi::CString;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use windows::core::{w, BOOL, PCSTR};
    use windows::Win32::Foundation::{
        CloseHandle, FreeLibrary, HANDLE, HINSTANCE, HMODULE, HWND, LPARAM, RECT, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, MonitorFromWindow, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    };
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::Threading::CreateEventW;
    use windows::Win32::UI::Shell::{
        SHAppBarMessage, ShellExecuteW, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP,
        ABM_GETAUTOHIDEBAREX, APPBARDATA,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowW, GetClassNameW, GetWindowThreadProcessId, SendMessageTimeoutW,
        SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, SEND_MESSAGE_TIMEOUT_FLAGS, SW_SHOWNORMAL,
        WH_CALLWNDPROC,
    };

    use crate::models::TaskbarPhase;
    use crate::taskbar::pipe::{self, Pipe, PipeListener};
    use crate::taskbar::win_watcher::{self, SystemEventCallback};
    use crate::taskbar::TaskbarType;

    use super::{
        cleanup_artifacts, generation_alive, host_is_arm64, is_crash_loop, mono_ms, now_ms,
        set_caps, set_phase, take_planned_exemption, with_engine, TapHookFn, CRASH_LOOP_HINT,
        CRASH_LOOP_WINDOW_MS, CREATED_TS, HANDSHAKE_TIMEOUT, HOOK_EXPORT_FALLBACK,
        HOOK_EXPORT_NAME, PING_EPOCH, PING_INTERVAL, PONG_STALE_MS, REBUILDING, REBUILD_SETTLE,
        RECONNECT_RETRY,
    };

    /* ---------------- 幂等闸 + 注入 worker ---------------- */

    pub fn ensure_started() {
        register_recovery_callback_once();
        win_watcher::start();
        let spawn = with_engine(|e| {
            if e.active {
                false
            } else {
                e.enabled = true;
                e.active = true;
                e.generation += 1;
                true
            }
        });
        if !spawn {
            return; // 已在跑：幂等（apply 同配置只下发外观，不重复注入）。
        }
        let gen = with_engine(|e| e.generation);
        set_phase(TaskbarPhase::Injecting, None);
        let spawned = std::thread::Builder::new()
            .name("vela-tap-inject".to_string())
            .spawn(move || run_injection(gen))
            .is_ok();
        if !spawned {
            with_engine(|e| {
                if e.generation == gen {
                    e.active = false;
                    e.enabled = false;
                }
            });
            set_phase(TaskbarPhase::Failed, Some("启动注入线程失败".to_string()));
        }
    }

    fn run_injection(gen: u64) {
        match inject_once(gen) {
            Ok(()) => {}
            Err(reason) => {
                let stale = !generation_alive(gen);
                with_engine(|e| {
                    if e.generation == gen {
                        e.active = false; // 终态：不自动重试。
                                          // enabled 一并复位：否则 explorer 重启（TaskbarCreated）
                                          // 会按「模块启用」走 teardown + 重新 ensure_started，
                                          // 绕过「注入失败是终态、绝不自动重试」的承诺。
                        e.enabled = false;
                    }
                });
                if !stale {
                    log::error!("taskbar: 注入失败: {reason}");
                    set_phase(TaskbarPhase::Failed, Some(reason));
                }
            }
        }
    }

    /// 一次完整注入。失败时自清理（[`InjectGuard`] Drop），成功时句柄移交
    /// ENGINE。
    fn inject_once(gen: u64) -> Result<(), String> {
        // 1. 探测：仅 XAML 继续（其余类型不可用走 Failed 终态）。
        let caps = crate::taskbar::detect::probe_capabilities();
        let kind = crate::taskbar::detect::detect_taskbar_type();
        set_caps(caps, kind);
        if kind != TaskbarType::Xaml {
            return Err(format!(
                "此系统的任务栏类型为 {kind:?}，任务栏自定义仅支持 Windows 11 XAML 任务栏（22621+）"
            ));
        }
        // 1.5 ：x64-only DLL 对 原生 explorer 的定向预检。
        // 模拟 x64 进程内的 LoadLibrary 预检探不出目标架构不匹配（加载方自己
        // 也是 x64），注入后只会 35s 握手超时给一串泛化文案。GetNativeSystemInfo
        // 给的是宿主 OS 架构（即使本进程跑在模拟层），据此直接给出定向结论。
        if host_is_arm64() {
            return Err(
                "此设备为 ARM64 Windows：任务栏外观自定义需要 ARM64 版组件，当前仅交付 x64"
                    .to_string(),
            );
        }
        if !generation_alive(gen) {
            return Ok(()); // 期间被拆除：静默退出。
        }

        // 2. 任务栏窗口 → explorer pid/tid。
        let (tray, pid, tid) = find_tray()?;

        // 3. DLL 定位 + 解包（哈希目录绕开旧占用）。
        let src = super::locate_dll()
            .ok_or_else(|| "未找到 velatap.dll（注入 DLL 未随应用交付）".to_string())?;
        let bytes = std::fs::read(&src).map_err(|e| format!("读取 velatap.dll 失败: {e}"))?;
        let hash = super::dll_hash64(&bytes);
        let dll_path = super::unpack_dll(&src, hash)?;

        // 3.5 驻留检查：同一 explorer 会话内**不允许二次注入**。DLL 被 XAML
        //     Diagnostics pin 住永不卸载，且主进程退出 / 崩溃后其管道线程仍在
        //     无限重连——同版本副本直接建管道"唤醒"即可；不同版本（升级 /
        //     重编）若再注入会出现两套 XAML 回调同时操作同一批 BackgroundFill
        // （已知崩溃结构），拒绝并提示重启资源管理器（不强杀）。
        if let Some(resident) = resident_velatap_path() {
            if super::resident_same_version(&resident, hash) {
                log::info!(
                    "taskbar: explorer 已驻留同版本 velatap.dll（{}），唤醒既有副本而不重复注入",
                    resident.display()
                );
                return wake_resident(gen, pid, hash);
            }
            log::warn!(
                "taskbar: explorer 驻留的是旧版本 velatap.dll（{}），拒绝注入第二副本",
                resident.display()
            );
            return Err(super::STALE_RESIDENT_HINT.to_string());
        }

        // 4. 本进程先加载 DLL 取 hook 导出——**必须先于标记事件**：本副本
        //    看不到事件而保持静默，只有 explorer 侧的拷贝会初始化。
        // 解包时的哈希校验与 LoadLibrary 之间存在替换窗口（%TEMP%
        //    用户可写）——加载前重算复核，哈希承诺落空即中止本次注入。
        let on_disk = std::fs::read(&dll_path)
            .map_err(|e| format!("读取 velatap.dll 失败（{}）: {e}", dll_path.display()))?;
        if super::dll_hash64(&on_disk) != hash {
            return Err(format!(
                "velatap.dll 加载前哈希复核不符（{}），疑似被替换，已拒绝注入",
                dll_path.display()
            ));
        }
        let hmod = load_library(&dll_path)?;
        let mut guard = InjectGuard {
            hmod: Some(hmod),
            marker: None,
            hook: None,
        };
        let proc = hook_proc(hmod).ok_or_else(|| {
            format!("velatap.dll 缺少 {HOOK_EXPORT_NAME} 导出（DLL 与注入器不配套）")
        })?;
        if !generation_alive(gen) {
            return Ok(());
        }

        // 5. 管道实例先于注入建好（无竞态，protocol.rs）。：把注入目标
        //    explorer 的 pid 交给 Listener——wait_client 据此校验连接方身份，
        //    拒绝同用户恶意进程抢连冒充 DLL（回个版本匹配的 Ready 骗取下发）。
        let listener = PipeListener::create(&crate::taskbar::protocol::pipe_name(pid), pid)?;

        // 6. 命名标记事件（DLL DllMain 检测存在才初始化）。
        let marker_name = windows::core::HSTRING::from(super::marker_event_name(pid));
        // SAFETY: 命名事件仅存在性语义（auto-reset）。
        let marker = unsafe { CreateEventW(None, false, false, &marker_name) }
            .map_err(|e| format!("创建注入标记事件失败: {e}"))?;
        guard.marker = Some(marker);

        // 7. 线程级钩子 → explorer 加载同一 DLL。
        // SAFETY: proc/hmod 同源；tid 来自任务栏窗口。
        let hook =
            unsafe { SetWindowsHookExW(WH_CALLWNDPROC, Some(proc), Some(HINSTANCE(hmod.0)), tid) }
                .map_err(|e| format!("SetWindowsHookEx 失败（{e}）——可能被安全软件拦截"))?;
        guard.hook = Some(hook);

        // 8. 触发加载：WH_CALLWNDPROC 只对**发送**消息生效（PostMessage 无
        //    效）；WM_NULL + 2s 超时防 explorer 挂死；失败不致命——explorer
        //    的环境消息流量也会触发钩子。
        // SAFETY: 空消息只读语义。
        let _ = unsafe {
            SendMessageTimeoutW(
                tray,
                0, // WM_NULL
                WPARAM(0),
                LPARAM(0),
                SEND_MESSAGE_TIMEOUT_FLAGS(2), // SMTO_ABORTIFHUNG
                2000,
                None,
            )
        };

        // 9. 等管道连接 + 握手（整体 35s 超时）。
        let started = Instant::now();
        let remain = |start: Instant| {
            HANDSHAKE_TIMEOUT
                .saturating_sub(start.elapsed())
                .max(Duration::from_millis(1))
        };
        let session = listener
            .wait_client(remain(started))
            .map_err(|e| format!("等待 DLL 连接管道失败: {e}"))?;
        let pipe = Pipe::from_session(session);
        pipe.handshake(remain(started)).map_err(|e| e.to_string())?;
        if !generation_alive(gen) {
            pipe.shutdown();
            return Ok(());
        }

        // 10. 成功：元数据 + 登记 + 读线程/心跳 + 应用当前外观。
        super::write_metadata(&super::InjectMetadata {
            dll_hash: hash,
            protocol_version: crate::taskbar::protocol::PROTOCOL_VERSION,
            explorer_pid: pid,
            ts_ms: now_ms(),
        });
        // TOCTOU 复核：上方 generation_alive 检查与入库之间无原子性——恰在此
        // 间隙停用模块（teardown 已清空 ENGINE 并 bump generation）时，把钩子/
        // 标记事件/库句柄存进去就成了挂在 explorer 里的无主孤儿（直到下次
        // teardown 才被清），且 phase 会被翻回 Ready。改为在 ENGINE 锁内复核
        // 代际，不匹配则丢弃产物（guard Drop 负责按序清理）。
        let mut stale = false;
        with_engine(|e| {
            if e.enabled && e.active && e.generation == gen {
                e.pipe = Some(pipe.clone());
                e.last_sent.clear();
                e.explorer_pid = pid;
                e.hook = guard.hook.take();
                e.marker_event = guard.marker.take();
                e.hook_dll = guard.hmod.take();
            } else {
                stale = true;
            }
        });
        if stale {
            pipe.shutdown();
            log::info!("taskbar: 注入完成时模块已被停用，丢弃注入产物");
            return Ok(());
        }
        let last_pong = attach_reader(gen, &pipe);
        set_phase(TaskbarPhase::Ready, None);
        // 注册表 → 状态检测桥 → 每屏基线 → 引擎精确重求值。
        super::on_ready();
        spawn_ping_thread(gen, pipe, last_pong);
        log::info!("taskbar: 注入成功（explorer pid={pid}，dll 哈希 {hash:016x}）");
        Ok(())
    }

    /// 唤醒 explorer 内已驻留的同版本副本：只建管道等它连上（DLL 侧断连后按
    /// 500ms / 2s 节律无限重连），握手成功即 Ready——不加载 DLL、不挂钩子、不
    /// 建标记事件，因此无任何拆除产物。握手超时 = 驻留副本的服务面已死
    /// （只可能是协议版本被拒后的自我停服），只能重启资源管理器。
    fn wake_resident(gen: u64, pid: u32, hash: u64) -> Result<(), String> {
        // 唤醒路径同样限定只接受目标 explorer 的连接（见 inject_once 步骤 5）。
        let listener = PipeListener::create(&crate::taskbar::protocol::pipe_name(pid), pid)?;
        let started = Instant::now();
        let remain = |start: Instant| {
            HANDSHAKE_TIMEOUT
                .saturating_sub(start.elapsed())
                .max(Duration::from_millis(1))
        };
        let session = listener
            .wait_client(remain(started))
            .map_err(|e| format!("已驻留的任务栏 DLL 未重新连接（{e}），请重启资源管理器后再试"))?;
        let pipe = Pipe::from_session(session);
        pipe.handshake(remain(started))
            .map_err(|e| format!("与已驻留的任务栏 DLL 握手失败（{e}），请重启资源管理器后再试"))?;
        if !generation_alive(gen) {
            pipe.shutdown();
            return Ok(());
        }
        super::write_metadata(&super::InjectMetadata {
            dll_hash: hash,
            protocol_version: crate::taskbar::protocol::PROTOCOL_VERSION,
            explorer_pid: pid,
            ts_ms: now_ms(),
        });
        // 同 inject_once 的 TOCTOU 复核：锁内确认代际仍存活才登记。
        let mut stale = false;
        with_engine(|e| {
            if !(e.enabled && e.active && e.generation == gen) {
                stale = true;
                return;
            }
            e.pipe = Some(pipe.clone());
            e.last_sent.clear();
            e.explorer_pid = pid;
            e.hook = None;
            e.marker_event = None;
            e.hook_dll = None;
        });
        if stale {
            pipe.shutdown();
            log::info!("taskbar: 唤醒完成时模块已被停用，丢弃会话");
            return Ok(());
        }
        let last_pong = attach_reader(gen, &pipe);
        set_phase(TaskbarPhase::Ready, None);
        super::on_ready();
        spawn_ping_thread(gen, pipe, last_pong);
        log::info!("taskbar: 已唤醒驻留副本（explorer pid={pid}，dll 哈希 {hash:016x}）");
        Ok(())
    }

    /// 已连接会话的读线程装配：Pong 记账（返回给心跳线程）+ 断连回调。
    /// 记账用单调钟（见 mono_ms）。
    fn attach_reader(gen: u64, pipe: &Pipe) -> Arc<AtomicU64> {
        let last_pong = Arc::new(AtomicU64::new(mono_ms()));
        let lp = Arc::clone(&last_pong);
        pipe.spawn_reader(
            Arc::new(move |msg: crate::taskbar::protocol::TapMessage| {
                if matches!(msg, crate::taskbar::protocol::TapMessage::Pong) {
                    lp.store(mono_ms(), Ordering::SeqCst);
                }
            }),
            Arc::new(move || on_pipe_disconnected(gen)),
        );
        last_pong
    }

    /// 心跳线程：5s Ping；Pong 12s 不到判死（读线程 on_disconnect 接管
    /// Degraded + 重连）。同一时刻只有最新一代线程在跑：起新线程即让旧线程
    /// 在下一拍退出，所以重连/重建时可以放心重复调用。
    /// 判死前补一拍 Ping 复核——单调钟在部分平台的睡眠
    /// 期间仍会计时（唤醒后 last_pong 看起来超龄），而 DLL 与管道其实健康；
    /// 直接判死就是每次唤醒闪一帧默认外观。复核窗口（2s）内拿到新 Pong 即
    /// 继续正常节奏，仍无应答才真正断开。
    fn spawn_ping_thread(gen: u64, pipe: Pipe, last_pong: Arc<AtomicU64>) {
        let my_epoch = PING_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = std::thread::Builder::new()
            .name("vela-tap-ping".to_string())
            .spawn(move || loop {
                std::thread::sleep(PING_INTERVAL);
                if PING_EPOCH.load(Ordering::SeqCst) != my_epoch || !generation_alive(gen) {
                    break;
                }
                if mono_ms().saturating_sub(last_pong.load(Ordering::SeqCst)) > PONG_STALE_MS {
                    // 复核：先记账「复核起点」，发一拍 Ping，给 2s 应答窗口。
                    let probe_at = mono_ms();
                    if let Err(e) = pipe.send(&crate::taskbar::protocol::TapMessage::Ping) {
                        log::info!("taskbar: Ping 发送失败（{e}），心跳线程退出");
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                    if PING_EPOCH.load(Ordering::SeqCst) != my_epoch || !generation_alive(gen) {
                        break;
                    }
                    // 复核通过的唯一标准：复核起点之后拿到过新 Pong。
                    if last_pong.load(Ordering::SeqCst) > probe_at {
                        continue;
                    }
                    log::warn!(
                        "taskbar: DLL 心跳超时（复核后仍无 Pong，>{PONG_STALE_MS}ms），断开"
                    );
                    pipe.shutdown();
                    break;
                }
                if let Err(e) = pipe.send(&crate::taskbar::protocol::TapMessage::Ping) {
                    log::info!("taskbar: Ping 发送失败（{e}），心跳线程退出");
                    break;
                }
            });
    }

    /// 断连处理：Degraded + 重试**连接**（不重复注入——DLL 按协议断连后
    /// 恢复默认并等重连）。explorer 已死则 TaskbarCreated 重建路径接管
    /// （gen 失配后本线程自行退出）。
    fn on_pipe_disconnected(gen: u64) {
        if !generation_alive(gen) {
            return; // 主动拆除（restore/重建/换代）产生的断开。
        }
        set_phase(
            TaskbarPhase::Degraded,
            Some("与任务栏 DLL 的连接断开，正在等待重连".to_string()),
        );
        with_engine(|e| {
            e.pipe = None;
            e.last_sent.clear(); // 重连成功后必须重发外观。
        });
        let _ = std::thread::Builder::new()
            .name("vela-tap-reconnect".to_string())
            .spawn(move || loop {
                std::thread::sleep(RECONNECT_RETRY);
                if !generation_alive(gen) {
                    return;
                }
                let pid = with_engine(|e| e.explorer_pid);
                // 重连路径同样只接受记录的 explorer PID 连接。
                let listener =
                    match PipeListener::create(&crate::taskbar::protocol::pipe_name(pid), pid) {
                        Ok(l) => l,
                        Err(e) => {
                            // 抢注 / 旧实例未释放都走这里；不能静默，否则被占用时
                            // 只看到"一直在重连"。
                            log::warn!("taskbar: 重连建管道失败（{e}），下轮再试");
                            continue;
                        }
                    };
                match listener.wait_client(pipe::CONNECT_TIMEOUT) {
                    Err(_) => continue, // DLL 尚未回来；下轮再试。
                    Ok(session) => {
                        let pipe = Pipe::from_session(session);
                        match pipe.handshake(Duration::from_secs(8)) {
                            Ok(_) => {
                                if generation_alive(gen) {
                                    with_engine(|e| e.pipe = Some(pipe.clone()));
                                    let last_pong = attach_reader(gen, &pipe);
                                    set_phase(TaskbarPhase::Ready, None);
                                    super::on_ready();
                                    // 旧心跳线程绑的是已断的旧管道，会在下一拍退出；
                                    // 新管道必须重新起心跳，否则 DLL 再挂死无人判死。
                                    spawn_ping_thread(gen, pipe, last_pong);
                                    log::info!("taskbar: 管道重连成功");
                                } else {
                                    pipe.shutdown();
                                }
                                return;
                            }
                            Err(e @ pipe::HandshakeError::VersionMismatch { .. }) => {
                                log::error!("taskbar: 重连握手失败: {e}");
                                let artifacts = teardown();
                                cleanup_artifacts(artifacts);
                                set_phase(TaskbarPhase::Failed, Some(e.to_string()));
                                return;
                            }
                            Err(_) => continue, // IO 抖动，下轮再试。
                        }
                    }
                }
            });
    }

    /* ---------------- TaskbarCreated：全量重建（恢复线 3） ---------------- */

    pub fn on_taskbar_created() {
        // 先查启用再计数：模块关闭时 explorer 重启与我们无关（没有注入就没有
        // 因注入引发的崩溃循环），不该进 teardown + Degraded 迁移，也不污染
        // 崩溃时间窗（否则下次真正启用时可能被旧时间戳误判为循环崩溃）。
        let enabled = with_engine(|e| e.enabled);
        if !enabled {
            log::info!("taskbar: explorer（重）启动但模块未启用，跳过重建");
            return;
        }
        let now = mono_ms();
        // 计划内重启豁免——见 PLANNED_RESTARTS 注释。仅跳过崩溃计数，
        // 重建照常（注入的会话必须重新建立）。：豁免带 30s 时间戳，
        // 残留（单屏只消耗 1 个）过期作废，不再拖累未来的真实崩溃计数。
        if take_planned_exemption(now) {
            log::info!("taskbar: 计划内 explorer 重启的 TaskbarCreated，跳过崩溃计数");
        } else {
            let crashed = {
                let mut ts = CREATED_TS.lock().unwrap_or_else(|p| p.into_inner());
                ts.push(now);
                ts.retain(|t| now.saturating_sub(*t) < CRASH_LOOP_WINDOW_MS * 2);
                is_crash_loop(&ts, now)
            };
            if crashed {
                // 崩溃循环保护（不弹系统对话框，用状态事件）。
                CREATED_TS.lock().unwrap_or_else(|p| p.into_inner()).clear();
                log::error!("taskbar: 30s 内 explorer 两次重启——自动停用任务栏模块");
                let artifacts = teardown();
                cleanup_artifacts(artifacts);
                set_phase(TaskbarPhase::Degraded, Some(CRASH_LOOP_HINT.to_string()));
                return;
            }
        }
        if REBUILDING.swap(true, Ordering::SeqCst) {
            log::info!("taskbar: 重建进行中，跳过重入（m_ResettingState 语义）");
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("vela-tap-rebuild".to_string())
            .spawn(|| {
                // 等 explorer 把任务栏窗口/可视树建完再重注入。
                std::thread::sleep(REBUILD_SETTLE);
                // settle 窗口（800ms）内用户可能已停用模块（apply_config(false) →
                // restore_all）：此时必须取消重注入，否则刚停用的模块会被本线程
                // 无条件 ensure_started “复活”。
                if !with_engine(|e| e.enabled) {
                    log::info!("taskbar: settle 后模块已停用，取消重建重注入");
                    REBUILDING.store(false, Ordering::SeqCst);
                    return;
                }
                log::info!("taskbar: explorer 重启，全量重建（清状态→重枚举→重注入→重求值）");
                let artifacts = teardown();
                cleanup_artifacts(artifacts);
                // STATE 重置接缝：STATE 未合入时求值输入恒默认（desktop）；
                // 合入后此处应调 state 模块重置入口（见会话汇报）。
                ensure_started();
                REBUILDING.store(false, Ordering::SeqCst);
            })
            .is_ok();
        if !spawned {
            REBUILDING.store(false, Ordering::SeqCst);
        }
    }

    /* ---------------- 拆除 ---------------- */

    pub fn teardown() -> super::TeardownArtifacts {
        with_engine(|e| {
            e.enabled = false;
            e.active = false;
            e.generation += 1; // 所有 worker/心跳/重连判 stale。
        });
        let (pipe, hook, marker, dll) = with_engine(|e| {
            (
                e.pipe.take(),
                e.hook.take(),
                e.marker_event.take(),
                e.hook_dll.take(),
            )
        });
        super::TeardownArtifacts {
            pipe,
            hook,
            marker_event: marker,
            hook_dll: dll,
        }
    }

    /* ---------------- 工具 ---------------- */

    /// Shell_TrayWnd → (HWND, pid, tid)。
    fn find_tray() -> Result<(HWND, u32, u32), String> {
        // SAFETY: 只读窗口查询。
        unsafe {
            let tray = FindWindowW(w!("Shell_TrayWnd"), None)
                .map_err(|_| "未找到任务栏窗口（资源管理器可能未运行）".to_string())?;
            let mut pid = 0u32;
            let tid = GetWindowThreadProcessId(tray, Some(&mut pid));
            if pid == 0 || tid == 0 {
                return Err("任务栏窗口归属异常".to_string());
            }
            Ok((tray, pid, tid))
        }
    }

    fn load_library(path: &std::path::Path) -> Result<HMODULE, String> {
        let p = windows::core::HSTRING::from(path.as_os_str());
        // SAFETY: 本进程内加载；句柄由 InjectGuard 接管。
        unsafe {
            LoadLibraryW(&p)
                .map_err(|e| format!("加载 velatap.dll 失败（位数不符或文件损坏）: {e}"))
        }
    }

    /// 取 hook 导出（`VelaTapHookProc` / `CallWndProc` / `velatap_hook_proc`
    /// 按序探测；见父模块约定）。
    fn hook_proc(hmod: HMODULE) -> Option<TapHookFn> {
        for name in [
            HOOK_EXPORT_NAME,
            HOOK_EXPORT_FALLBACK,
            super::HOOK_EXPORT_FALLBACK2,
        ] {
            let Ok(cname) = CString::new(name) else {
                continue;
            };
            // SAFETY: hmod 有效；PCSTR 指向 NUL 结尾的 C 字符串。
            let far = unsafe { GetProcAddress(hmod, PCSTR::from_raw(cname.as_ptr() as *const u8)) };
            if let Some(f) = far {
                // SAFETY: DLL 导出的 HOOKPROC 兼容签名（父模块文档约定）。
                return Some(unsafe {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, TapHookFn>(f)
                });
            }
        }
        None
    }

    /// explorer 是否仍挂着 velatap.dll（升级残留检测，恢复线 4）。
    pub fn explorer_has_velatap() -> bool {
        resident_velatap_path().is_some()
    }

    /// 本进程内是否仍有 explorer.exe（shell 重启轮询用）。
    /// 本会话 shell 是否就位。：原实现全进程扫描名字匹配，
    /// 会命中**任意会话**的 explorer.exe——快速用户切换/多会话下另一会话的
    /// explorer 让「重启确认」提前假成功，而本会话桌面仍无 shell。改为查本
    /// 会话的 Shell_TrayWnd（每输入会话一个；taskkill /F 后立刻消失，新
    /// explorer 建完任务栏后出现），与 restart_explorer 的等待语义精确对齐。
    fn explorer_running() -> bool {
        // SAFETY: 只读窗口查找。
        unsafe { FindWindowW(w!("Shell_TrayWnd"), None).is_ok() }
    }

    ///本会话 explorer（Shell_TrayWnd 属主）的 PID。taskkill 按它
    /// 精确命中——此前 `/IM explorer.exe` 按映像名全局匹配，快速用户切换/
    /// 多会话（且本进程提权）时会误杀其他会话的 shell。None = 找不到任务栏
    /// 窗口（explorer 未运行，走拉起路径）。
    fn tray_explorer_pid() -> Option<u32> {
        // SAFETY: 只读窗口查找 + PID 查询。
        unsafe {
            let tray = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
            let mut pid = 0u32;
            GetWindowThreadProcessId(tray, Some(&mut pid));
            (pid != 0).then_some(pid)
        }
    }

    /// 重启资源管理器以完成 DLL 升级（升级残留的唯一闭环手段：已加载的
    /// DLL 无法安全卸载——见 DLL 侧「永不卸载」契约）。约束（的边界）：
    /// 只在用户显式点按钮或开启「升级后自动重启」时走到这里，应用绝不擅自
    /// 结束 shell。流程：taskkill /F（不留半死的 shell）→ 轮询 4s 等 Win11
    /// 自动重生 → 没有则 ShellExecuteW 拉起（实测可靠；DETACHED_PROCESS 起
    /// 的 explorer 无法接管 shell 角色）→ 再轮询确认。
    pub fn restart_explorer() -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        use std::time::Duration;
        // CREATE_NO_WINDOW：不让 taskkill 的控制台闪黑框。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // 登记计划内重启——随后的 TaskbarCreated 不计崩溃循环（每次
        // 登记 2 个豁免：主屏 + 可能的副屏任务栏都广播该消息：带
        // 时间戳，30s 后残留作废）。
        super::grant_planned_restarts(mono_ms());
        //按 PID 精确命中本会话 shell（见 tray_explorer_pid 注释）；
        // 找不到任务栏窗口（explorer 未运行）跳过 taskkill 直接走拉起路径。
        if let Some(pid) = tray_explorer_pid() {
            let status = std::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("taskkill 启动失败: {e}"))?;
            if !status.status.success() {
                // 竞态：窗口还在、进程已退（少见）：继续走等待/拉起路径。
                log::info!("taskbar: taskkill /PID {pid} 非零退出（可能已退出）");
            }
        } else {
            log::info!("taskbar: Shell_TrayWnd 不在，跳过 taskkill 直接拉起 explorer");
        }
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(200));
            if explorer_running() {
                return Ok(());
            }
        }
        // SAFETY: ShellExecuteW 打开 explorer.exe，系统自行处理参数。
        unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                w!("explorer.exe"),
                None,
                None,
                SW_SHOWNORMAL,
            );
        }
        for _ in 0..25 {
            std::thread::sleep(Duration::from_millis(200));
            if explorer_running() {
                return Ok(());
            }
        }
        Err("explorer.exe 未能重启（请手动从任务管理器启动）".to_string())
    }

    /// explorer 内已驻留的 velatap.dll 完整路径（None = 未驻留）。路径落在
    /// `%TEMP%\vela\tap\<hash>\`，目录名即该副本的内容哈希——同一 explorer
    /// 会话内的"二次注入"据此判定是同版本（唤醒）还是旧版本（拒绝）。
    pub fn resident_velatap_path() -> Option<std::path::PathBuf> {
        // SAFETY: 只读快照。
        unsafe {
            let tray = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
            let mut pid = 0u32;
            GetWindowThreadProcessId(tray, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid).ok()?;
            let mut me = MODULEENTRY32W {
                dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
                ..Default::default()
            };
            let mut found = None;
            if Module32FirstW(snapshot, &mut me).is_ok() {
                loop {
                    if utf16_z(&me.szModule).eq_ignore_ascii_case("velatap.dll") {
                        found = Some(std::path::PathBuf::from(utf16_z(&me.szExePath)));
                        break;
                    }
                    if Module32NextW(snapshot, &mut me).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
            found
        }
    }

    fn utf16_z(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// 注入资源守卫：任何失败路径 Drop 时按序清理（卸钩 → 关事件 → 卸库）。
    struct InjectGuard {
        hmod: Option<HMODULE>,
        marker: Option<HANDLE>,
        hook: Option<HHOOK>,
    }

    impl InjectGuard {}

    impl Drop for InjectGuard {
        fn drop(&mut self) {
            if let Some(h) = self.hook.take() {
                // SAFETY: 本进程安装的钩子。
                unsafe {
                    let _ = UnhookWindowsHookEx(h);
                }
            }
            if let Some(e) = self.marker.take() {
                // SAFETY: 本进程创建的事件。
                unsafe {
                    let _ = CloseHandle(e);
                }
            }
            if let Some(m) = self.hmod.take() {
                // SAFETY: 卸钩之后释放库引用安全（钩子已不存在）。
                unsafe {
                    let _ = FreeLibrary(m);
                }
            }
        }
    }

    /* ---------------- 恢复回调（win_watcher → 本模块） ---------------- */

    static CALLBACK_REGISTERED: AtomicBool = AtomicBool::new(false);

    fn register_recovery_callback_once() {
        if CALLBACK_REGISTERED.swap(true, Ordering::SeqCst) {
            return;
        }
        struct Recovery;
        impl SystemEventCallback for Recovery {
            fn on_taskbar_created(&self) {
                // 消息窗线程内：本函数只做记账与转后台线程（回调不得阻塞）。
                crate::taskbar::injector::on_taskbar_created();
            }
            fn on_display_change(&self) {
                // 热插拔：只排后台重同步（settle → 重枚举 → 重应用）。
                crate::taskbar::injector::on_display_change();
            }
        }
        win_watcher::register_callback(Arc::new(Recovery));
    }

    /* ---------------- 每屏任务栏枚举（注册表段的 Win32 侧） ---------------- */

    /// 枚举全部任务栏窗口 → `(hwnd, hmonitor)`：`Shell_TrayWnd` 主 +
    /// `EnumWindows` 找 `Shell_SecondaryTrayWnd` 副（副屏任务栏是独立顶层
    /// 窗口）。
    pub fn enumerate_taskbars() -> Vec<(isize, isize)> {
        let mut hwnds: Vec<isize> = Vec::new();
        // SAFETY: 只读窗口枚举；回调只向本地 Vec push。
        unsafe {
            if let Ok(tray) = FindWindowW(w!("Shell_TrayWnd"), None) {
                hwnds.push(tray.0 as isize);
            }
            let _ = EnumWindows(
                Some(enum_secondary_tray_cb),
                LPARAM(&mut hwnds as *mut Vec<isize> as isize),
            );
        }
        let rects = monitor_rects();
        hwnds
            .into_iter()
            .map(|h| (h, taskbar_monitor(h, &rects)))
            .collect()
    }

    unsafe extern "system" fn enum_secondary_tray_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam 指向 enumerate_taskbars 栈上的 Vec；GetClassNameW 不发消息。
        unsafe {
            let out = &mut *(lparam.0 as *mut Vec<isize>);
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut buf);
            if n > 0 {
                let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                if String::from_utf16_lossy(&buf[..end])
                    == crate::taskbar::win_event::SECONDARY_TRAY_CLASS
                {
                    let raw = hwnd.0 as isize;
                    if !out.contains(&raw) {
                        out.push(raw);
                    }
                }
            }
        }
        BOOL(1)
    }

    unsafe extern "system" fn enum_monitor_rects_cb(
        hmonitor: HMONITOR,
        _hdc: HDC,
        rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        // SAFETY: EnumDisplayMonitors 回调约定：rect 只读；lparam 指向调用方 Vec。
        unsafe {
            let out = &mut *(lparam.0 as *mut Vec<(HMONITOR, RECT)>);
            out.push((hmonitor, *rect));
        }
        BOOL(1)
    }

    /// 显示器 → 屏幕矩形表（边探测的 `APPBARDATA.rc` 输入）。
    fn monitor_rects() -> Vec<(HMONITOR, RECT)> {
        let mut out: Vec<(HMONITOR, RECT)> = Vec::new();
        // SAFETY: 回调只 push；无跨调用可变状态。
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_monitor_rects_cb),
                LPARAM(&mut out as *mut Vec<(HMONITOR, RECT)> as isize),
            );
        }
        out
    }

    /// 任务栏所在显示器：对每台显示器
    /// 四边 `SHAppBarMessage(ABM_GETAUTOHIDEBAREX)`，返回的自动隐藏栏就是本
    /// 任务栏 → 该显示器（自动隐藏任务栏停靠屏外时 `MonitorFromWindow` 不可
    /// 靠）；都探不到（非自动隐藏 / 探测失败）→ 回退 `MonitorFromWindow`
    /// （NEAREST：任务栏总在某屏边上）。
    fn taskbar_monitor(hwnd: isize, rects: &[(HMONITOR, RECT)]) -> isize {
        // SAFETY: SHAppBarMessage 只读查询（向 explorer 发送，后台线程调用）；
        // APPBARDATA 按 cbSize 初始化。
        unsafe {
            for (hmon, rc) in rects {
                for edge in [ABE_LEFT, ABE_TOP, ABE_RIGHT, ABE_BOTTOM] {
                    let mut abd = APPBARDATA {
                        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                        uEdge: edge,
                        rc: *rc,
                        ..Default::default()
                    };
                    let bar = SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut abd);
                    if bar != 0 && bar as isize == hwnd {
                        return hmon.0 as isize;
                    }
                }
            }
            MonitorFromWindow(HWND(hwnd as *mut _), MONITOR_DEFAULTTONEAREST).0 as isize
        }
    }
}

#[cfg(not(windows))]
mod imp {
    //! 非 Windows：注入管线不可用，模块恒 Degraded（隐藏而非崩溃）。

    use super::*;

    pub fn ensure_started() {
        set_phase(
            TaskbarPhase::Degraded,
            Some("非 Windows 平台不支持任务栏自定义".to_string()),
        );
    }

    pub fn teardown() -> TeardownArtifacts {
        with_engine(|e| {
            e.enabled = false;
            e.active = false;
            e.generation += 1;
            e.pipe = None;
            e.last_sent.clear();
        });
        TeardownArtifacts::default()
    }

    pub fn on_taskbar_created() {}

    pub fn enumerate_taskbars() -> Vec<(isize, isize)> {
        Vec::new()
    }

    pub fn restart_explorer() -> Result<(), String> {
        Err("非 Windows 平台不支持任务栏自定义".to_string())
    }
}

/// 幂等闸 + 派发平台实现（`apply_config` / `start_enabled` 消费）。
pub fn ensure_started() {
    imp::ensure_started();
}

/// 重启资源管理器（DLL 升级残留的闭环动作；边界见 imp 内注释）。
pub fn restart_explorer() -> Result<(), String> {
    imp::restart_explorer()
}

/// 拆除当前代：句柄取走（调用方锁外清理），引擎转停用态。
fn teardown() -> TeardownArtifacts {
    imp::teardown()
}

/// velatap.dll 须导出的 hook 过程签名（HOOKPROC 兼容；约定见模块文档）。
#[cfg(windows)]
pub(crate) type TapHookFn = unsafe extern "system" fn(
    i32,
    windows::Win32::Foundation::WPARAM,
    windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT;

/// 对当前配置求值并 best-effort 下发（注入/重连就绪后自调用）。
fn apply_current_config() -> Result<Vec<String>, String> {
    // 注入期间用户改过配置（apply_config 的 StillInjecting 分支）→ 就绪后
    // 优先应用那份，成功才存底；否则回放上次生效的配置。
    if let Some(pending) = taskbar::take_pending_config() {
        let notes = send_appearance(&pending);
        if notes.is_ok() {
            taskbar::store_config(&pending);
            return notes;
        }
        log::warn!("taskbar: 待生效配置应用失败，回退到存底配置");
    }
    send_appearance(&taskbar::current_config())
}

/// 锁外清理拆除产物（卸钩 → 关标记事件 → 卸 DLL 引用；管道由调用方
/// 先行 RestoreAll + shutdown）。幂等。
#[cfg(windows)]
fn cleanup_artifacts(artifacts: TeardownArtifacts) {
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx;
    if let Some(pipe) = artifacts.pipe {
        pipe.shutdown();
    }
    // SAFETY: 句柄均由本引擎创建/安装，取走即独占。
    unsafe {
        if let Some(hook) = artifacts.hook {
            let _ = UnhookWindowsHookEx(hook);
        }
        if let Some(event) = artifacts.marker_event {
            let _ = windows::Win32::Foundation::CloseHandle(event);
        }
        if let Some(dll) = artifacts.hook_dll {
            // 卸钩之后释放库引用安全（钩子已不存在）。
            let _ = FreeLibrary(dll);
        }
    }
}

#[cfg(not(windows))]
fn cleanup_artifacts(_artifacts: TeardownArtifacts) {}

/// win_watcher TaskbarCreated 挂点（恢复线 3；win_watcher 回调线程调用）。
pub fn on_taskbar_created() {
    imp::on_taskbar_created();
}

/// 拆除产物（锁外执行清理的载荷）。
#[derive(Default)]
struct TeardownArtifacts {
    pipe: Option<crate::taskbar::pipe::Pipe>,
    #[cfg(windows)]
    hook: Option<windows::Win32::UI::WindowsAndMessaging::HHOOK>,
    #[cfg(windows)]
    marker_event: Option<windows::Win32::Foundation::HANDLE>,
    #[cfg(windows)]
    hook_dll: Option<windows::Win32::Foundation::HMODULE>,
}

/* ================== 对外入口（mod.rs 消费） ================== */

/// 启动入口（mod.rs `start` 调用）：探测能力并 emit（无论开关，供 UI）→
/// 升级残留检测（恢复线 4）→ 读设置镜像 `general.taskbar.enabled`（模式 C，
/// 对齐 clipboard.rs read_clip_config）决定是否自动起。
pub fn start_enabled(app: &tauri::AppHandle) {
    use tauri::Manager;
    #[cfg(windows)]
    if let Ok(res) = app.path().resource_dir() {
        let _ = EXTRA_DLL_DIR.set(Some(res));
    }

    // 探测在后台做（枚举 explorer 模块虽快，但启动路径不冒险）。
    std::thread::Builder::new()
        .name("vela-tap-probe".to_string())
        .spawn(|| {
            let caps = detect::probe_capabilities();
            let kind = detect::detect_taskbar_type();
            set_caps(caps, kind);
            // 升级残留：Idle 附带 reason 提示（不改变 phase 语义，状态条
            // 展示文案；）。code 供前端挂一键/自动重启动作。
            if let Some(hint) = residual_hint(read_metadata(), locate_dll().as_deref()) {
                let mut guard = PHASE.lock().unwrap_or_else(|p| p.into_inner());
                let cell = guard.get_or_insert_with(PhaseCell::initial);
                if cell.phase == TaskbarPhase::Idle {
                    cell.reason = Some(hint.clone());
                    cell.code = Some("stale_dll_resident".to_string());
                    let status = status_snapshot_locked(cell);
                    drop(guard);
                    taskbar::emit_status(status);
                }
            }
        })
        .ok();

    if let Some(cfg) = read_taskbar_from_mirror(app) {
        // 整份存底（不只 .enabled）：注入自动启动路径的 on_ready 下发、引擎求值、
        // get_taskbar_config 对账都以它为准——否则启动期 Ready 了但引擎读到的是
        // 出厂默认（enabled=false 静默），要等设置窗加载完对账才下发真实外观。
        taskbar::store_config(&cfg);
        if cfg.enabled {
            log::info!("taskbar: 镜像开关为开，自动启动注入");
            ensure_started();
        }
    }
}

/// 设置镜像读取（模式 C）：`app:settings:v1` → `general.taskbar` 整份配置，
/// 任何失败回 None（默认关）。：读取收敛到 settings_mirror 助手。
fn read_taskbar_from_mirror(app: &tauri::AppHandle) -> Option<TaskbarSettings> {
    crate::settings_mirror::read_json(app).map(|v| taskbar::parse_taskbar_value(&v))
}

/// 应用配置（`apply_taskbar_config` 的实现体）。返回非致命失败项；致命
/// 错误 Err（对齐 shortcuts.rs reregister 的返回风格）。
///
/// 配置存底**只在生效成功后进行**（enabled=false 的恢复视为成功）：注入失败 /
/// 握手超时时若先把失败配置存底，`get_taskbar_config` 对账会恒相等、设置窗
/// 永远不再重试，故障态就只剩"关总开关再开"一条路。失败时存底保持旧值，
/// 对账发现不等 → 下一次改动自动重试；「重新应用」按钮（走 apply 全链路）
/// 也是显式重试入口。
pub fn apply_config(config: &TaskbarSettings) -> Result<Vec<String>, String> {
    // 任何一次新的 apply 都取代之前挂着的待生效配置。
    let _ = taskbar::take_pending_config();
    if !config.enabled {
        restore_all();
        taskbar::store_config(config); // 关闭 = 恢复系统默认（幂等 best-effort），即刻存底
        return Ok(Vec::new());
    }
    ensure_started();
    match wait_ready(APPLY_WAIT_READY) {
        ReadyWait::Ready => {
            // 即时基线（各屏按当前状态从新配置重取外观）→ 引擎按新配置精确重求值。
            let notes = send_appearance(config);
            let _ = taskbar::state::request_reevaluate();
            if notes.is_ok() {
                taskbar::store_config(config);
            }
            notes
        }
        ReadyWait::Failed(reason) | ReadyWait::Degraded(reason) => Err(reason),
        ReadyWait::StillInjecting => {
            // 注入可能超过等待上限（DLL 侧 IXDE 初始化有 60×500ms 重试）。这里
            // 承诺"完成后自动应用"，就必须把这份配置挂起来交给 on_ready——此前
            // 什么都不存，就绪后回放的是上一次存底（常常是 enabled=false 的
            // 默认），用户打开开关后任务栏毫无变化。
            taskbar::store_pending_config(config);
            Ok(vec![
                "正在注入任务栏模块，完成后将自动应用当前外观".to_string()
            ])
        }
        ReadyWait::Idle => Err("任务栏模块未能启动".to_string()),
    }
}

/// 重置动态状态（托盘/快捷键/预览结束）：重枚举任务栏 + 重求值 + 重下发（绕过
/// 幂等缓存）。故障 / 降级 / 空闲且存底配置为开 → 先重新拉起注入（的
/// 恢复路径：注入失败是终态，用户显式重置即显式重试）。
pub fn reset_state() -> Result<(), String> {
    if phase_cell().phase != TaskbarPhase::Ready {
        if !taskbar::current_config().enabled {
            log::info!("taskbar: reset_state（模块未启用，无需重发）");
            return Ok(());
        }
        log::info!("taskbar: reset_state：模块未就绪，按存底配置重新拉起注入");
        ensure_started();
        match wait_ready(APPLY_WAIT_READY) {
            ReadyWait::Ready => {}
            ReadyWait::StillInjecting => return Ok(()), // 注入线程就绪后 on_ready 自动下发
            ReadyWait::Failed(reason) | ReadyWait::Degraded(reason) => return Err(reason),
            ReadyWait::Idle => return Err("任务栏模块未能启动".to_string()),
        }
    }
    refresh_registry();
    with_engine(|e| e.last_sent.clear());
    let failures = send_appearance(&taskbar::current_config())?;
    taskbar::state::request_reevaluate();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

/// 恢复线 1/2：停线程 + 管道 RestoreAll + 卸钩 + Idle（幂等；Exit/panic/
/// 停用共用）。每屏求值缓存一并清空（重开后以新一轮求值为准）。
pub fn restore_all() {
    let mut artifacts = teardown();
    clear_resolutions();
    if let Some(pipe) = artifacts.pipe.take() {
        // best-effort：DLL 收到即恢复原 Fill；失败（断连）时 DLL 侧本就
        // 处于「断连即恢复默认」状态。
        if let Err(e) = pipe.send(&TapMessage::RestoreAll) {
            log::info!("taskbar: restore_all 下发失败（{e}；DLL 侧断连自愈兜底）");
        }
        pipe.shutdown();
    }
    cleanup_artifacts(artifacts);
    set_phase(TaskbarPhase::Idle, None);
    log::info!("taskbar: restore_all 完成");
}

/// 当前状态快照（get_taskbar_status）。
pub fn status() -> TaskbarStatus {
    status_snapshot_locked(&phase_cell())
}

/// 当前能力（回读，get_taskbar_capabilities）：模块已探测过则返回缓存
/// （与 `taskbar:capabilities` 事件同值）；尚未探测（模块未启用 / 应用刚启动
/// 未 start）则现场探测一次并登记 + emit——设置窗晚于启动事件打开时不再
/// 拿不到能力（旧设置页遗留的收口）。
pub fn current_caps() -> TaskbarCapabilities {
    if let Some(caps) = phase_cell().caps {
        return caps;
    }
    let kind = detect::detect_taskbar_type();
    let (build, ubr) = detect::os_build();
    let caps = detect::capabilities_for(kind, build, ubr);
    set_caps(caps.clone(), kind);
    caps
}

/* ================== 就绪等待与外观下发 ================== */

enum ReadyWait {
    Ready,
    Failed(String),
    Degraded(String),
    StillInjecting,
    Idle,
}

fn wait_ready(timeout: Duration) -> ReadyWait {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let cell = phase_cell();
        match cell.phase {
            TaskbarPhase::Ready => return ReadyWait::Ready,
            TaskbarPhase::Failed => {
                return ReadyWait::Failed(cell.reason.unwrap_or_else(|| "注入失败".into()))
            }
            TaskbarPhase::Degraded => {
                return ReadyWait::Degraded(cell.reason.unwrap_or_else(|| "模块降级".into()))
            }
            TaskbarPhase::Idle => return ReadyWait::Idle,
            TaskbarPhase::Injecting => {}
        }
        if std::time::Instant::now() >= deadline {
            return ReadyWait::StillInjecting;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 按当前配置对注册表内每个目标求基线并下发（每屏幂等：与该目标上次成功
/// 下发相同则跳过）。返回失败项（空 = 全部生效）。
///
/// 预览通道（mod.rs `push_preview_appearance`）也直接走这里：只下发、不存底、
/// 不触发引擎重求值。
pub(crate) fn send_appearance(config: &TaskbarSettings) -> Result<Vec<String>, String> {
    let cell = phase_cell();
    let Some(caps) = cell.caps else {
        return Err("任务栏能力尚未探测完成，请稍后重试".to_string());
    };
    let targets = send_targets(&registry_snapshot());
    let (msgs, notes) = build_appearance_messages(config, &caps, &targets, &last_resolutions());
    let Some(pipe) = with_engine(|e| e.pipe.clone()) else {
        return Ok(notes); // phase=Ready 保证连接存在；瞬时缺失由重连路径补发。
    };
    // 按"连续同 monitor 段"显式分组下发（不依赖 appearance_messages 恒发两条
    // 的隐式不变量——将来若按能力省略 SetBorderVisibility，分组仍正确）。
    let mut idx = 0;
    while idx < msgs.len() {
        let Some(monitor) = message_monitor(&msgs[idx]) else {
            log::debug!("taskbar: 跳过不带 monitor 目标的消息 {:?}", msgs[idx]);
            idx += 1;
            continue;
        };
        let mut end = idx + 1;
        while end < msgs.len() && message_monitor(&msgs[end]) == Some(monitor) {
            end += 1;
        }
        if let Err(e) = send_to_monitor(&pipe, monitor, msgs[idx..end].to_vec()) {
            // send 失败改走 Err——apply_config 的存底前提是
            // 「已生效」（不变量），折成 notes 仍返回 Ok 会让失败配置被
            // 存底、对账恒等、故障态永不重试。send 失败即会话拆除：读线程
            // on_disconnect 负责 Degraded + 重连，重连成功后 on_ready 重发存底
            // 配置；设置窗对账（LS≠get）与托盘的下一次操作是显式重试入口。
            log::warn!("taskbar: 下发 monitor={monitor:#x} 失败: {e}");
            return Err(e);
        }
        idx = end;
    }
    Ok(notes)
}

/// 消息的 monitor 目标（仅 ApplyAppearance / SetBorderVisibility 携带）。
fn message_monitor(msg: &TapMessage) -> Option<u64> {
    match msg {
        TapMessage::ApplyAppearance { monitor, .. }
        | TapMessage::SetBorderVisibility { monitor, .. } => Some(*monitor),
        _ => None,
    }
}

/* ================== 单测 ================== */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TaskbarPath;

    fn caps(blur: bool) -> TaskbarCapabilities {
        TaskbarCapabilities {
            path: TaskbarPath::Xaml,
            supports_blur: blur,
            supports_peek: false,
            supports_line: true,
            supports_battery_state: true,
            os_build: 26200,
        }
    }

    #[test]
    fn crash_loop_needs_two_restarts_within_window() {
        let now = 1_000_000u64;
        assert!(!is_crash_loop(&[now - 100], now), "单次重启不触发");
        assert!(
            is_crash_loop(&[now - 100, now - 5_000], now),
            "30s 内两次触发"
        );
        assert!(
            !is_crash_loop(&[now - 40_000, now - 100], now),
            "第一次超出 30s 窗口不触发"
        );
        assert!(!is_crash_loop(&[], now), "无记录不触发");
    }

    /// 豁免带时间戳，残留（单屏只消耗 1 个）30s 后作废——此前的
    /// 永久豁免会让下一次真实崩溃跳过一次崩溃计数。
    #[test]
    fn planned_restart_exemptions_expire_after_window() {
        grant_planned_restarts(1_000);
        assert!(take_planned_exemption(1_500), "窗口内第 1 个豁免生效");
        // 单屏场景：第二个豁免无人消耗。30s 窗口过后它必须作废，真实崩溃
        // （哪怕数周后）不再被它跳过。
        assert!(
            !take_planned_exemption(1_000 + PLANNED_RESTART_WINDOW_MS + 1),
            "残留豁免过期后必须作废"
        );
        // 作废是终态：之后即使时间戳回退（测试注入）也无豁免可用。
        assert!(!take_planned_exemption(1_600), "作废后不再放行");
        // 双屏场景：窗口内两个豁免（主屏 + 副屏）都可用，第 3 个没有。
        grant_planned_restarts(10_000);
        assert!(take_planned_exemption(10_100));
        assert!(take_planned_exemption(10_200));
        assert!(!take_planned_exemption(10_300), "超额无豁免");
    }

    #[test]
    fn blur_degrades_to_acrylic_only_when_unsupported() {
        let app = TaskbarAppearance {
            accent: TaskbarAccent::Blur,
            ..TaskbarAppearance::default()
        };
        let (d, yes) = degrade_appearance(&app, &caps(false));
        assert!(yes);
        assert_eq!(d.accent, TaskbarAccent::Acrylic);
        let (_, yes2) = degrade_appearance(&app, &caps(true));
        assert!(!yes2, "支持 blur 时原样下发");
        let (_, yes3) = degrade_appearance(&TaskbarAppearance::default(), &caps(false));
        assert!(!yes3, "非 blur 不降级");
    }

    #[test]
    fn build_messages_uses_desktop_resolution_and_monitor_zero() {
        // 注册表空 → 单条广播目标 (None, 0)：基础配置桌面态（默认 clear +
        // 全透明 + 无顶线）。
        let (msgs, notes) =
            build_appearance_messages(&TaskbarSettings::default(), &caps(true), &[(None, 0)], &[]);
        assert!(notes.is_empty());
        assert_eq!(msgs.len(), 2);
        assert_eq!(
            msgs[0],
            TapMessage::ApplyAppearance {
                monitor: 0,
                accent: protocol::TapAccent::Clear,
                color_abgr: 0,
                blur_radius: 30,
            }
        );
        assert_eq!(
            msgs[1],
            TapMessage::SetBorderVisibility {
                monitor: 0,
                visible: false
            }
        );
    }

    #[test]
    fn build_messages_reports_blur_degradation_note() {
        let mut cfg = TaskbarSettings {
            enabled: true,
            ..TaskbarSettings::default()
        };
        cfg.states.desktop.appearance.accent = TaskbarAccent::Blur;
        cfg.states.desktop.appearance.blur_radius = 240;
        let (msgs, notes) = build_appearance_messages(&cfg, &caps(false), &[(None, 0)], &[]);
        assert_eq!(notes.len(), 1, "D7：blur→acrylic 需回报告知");
        assert!(matches!(
            msgs[0],
            TapMessage::ApplyAppearance {
                accent: protocol::TapAccent::Acrylic,
                blur_radius: 240,
                ..
            }
        ));
        // 多目标同时降级只报一条备注。
        let (_, notes2) =
            build_appearance_messages(&cfg, &caps(false), &[(Some(0), 0x10), (Some(1), 0x20)], &[]);
        assert_eq!(notes2.len(), 1);
    }

    /* ---------------- 每屏注册表 / 目标 / 基线 ---------------- */

    #[test]
    fn build_registry_maps_taskbars_to_slots_and_dedups() {
        let monitors = [(0x10isize, 0u32), (0x20, 3)];
        let reg = build_registry(
            &[
                (0xA, 0x10), // 主任务栏 → 槽 0
                (0xB, 0x20), // 副任务栏 → 槽 3
                (0xB, 0x20), // 重复 hwnd 丢弃
                (0xC, 0x20), // 同屏第二台（瞬时并存）丢弃
                (0xD, 0x30), // 显示器表里没有 → slot None
                (0xE, 0),    // HMONITOR 无效 → slot None
                (0, 0x10),   // 空 hwnd 丢弃
            ],
            &monitors,
        );
        assert_eq!(
            reg,
            vec![
                TaskbarEntry {
                    hwnd: 0xA,
                    hmonitor: 0x10,
                    slot: Some(0)
                },
                TaskbarEntry {
                    hwnd: 0xB,
                    hmonitor: 0x20,
                    slot: Some(3)
                },
                TaskbarEntry {
                    hwnd: 0xD,
                    hmonitor: 0x30,
                    slot: None
                },
                TaskbarEntry {
                    hwnd: 0xE,
                    hmonitor: 0,
                    slot: None
                },
            ]
        );
        assert!(build_registry(&[], &monitors).is_empty());
    }

    #[test]
    fn send_targets_per_slot_or_broadcast_fallback() {
        let reg = vec![
            TaskbarEntry {
                hwnd: 0xB,
                hmonitor: 0x20,
                slot: Some(3),
            },
            TaskbarEntry {
                hwnd: 0xA,
                hmonitor: 0x10,
                slot: Some(0),
            },
            TaskbarEntry {
                hwnd: 0xD,
                hmonitor: 0x30,
                slot: None,
            },
        ];
        // 有槽位的按槽位升序；无槽位的不下发（避免误伤别的屏）。
        assert_eq!(send_targets(&reg), vec![(Some(0), 0x10), (Some(3), 0x20)]);
        // 空注册表 / 全部无槽位 → 单条广播 (None, 0)。
        assert_eq!(send_targets(&[]), vec![(None, 0)]);
        assert_eq!(send_targets(&reg[2..]), vec![(None, 0)]);
    }

    #[test]
    fn build_messages_per_slot_uses_override_and_cached_state() {
        // 基础桌面蓝；槽 1 覆盖桌面红 + 最大化 opaque；per_monitor 开。
        let mut cfg = TaskbarSettings {
            enabled: true,
            per_monitor: true,
            ..TaskbarSettings::default()
        };
        cfg.states.desktop.appearance.color = "#0000ffff".to_string();
        cfg.states.maximized_window.enabled = Some(true);
        let mut ov_states = cfg.states.clone();
        ov_states.desktop.appearance.color = "#ff0000ff".to_string();
        ov_states.maximized_window.appearance.accent = TaskbarAccent::Opaque;
        ov_states.maximized_window.appearance.color = "#00ff00ff".to_string();
        cfg.monitor_overrides.insert(
            "1".to_string(),
            taskbar::TaskbarOverride {
                states: Some(ov_states),
                ..taskbar::TaskbarOverride::default()
            },
        );
        let targets = [(Some(0u32), 0x10u64), (Some(1), 0x20)];
        // 无缓存：两屏各自生效配置的桌面态 → 「逐屏覆盖后两屏桌面态不同」。
        let (msgs, _) = build_appearance_messages(&cfg, &caps(true), &targets, &[]);
        assert_eq!(msgs.len(), 4);
        assert_eq!(
            msgs[0],
            TapMessage::ApplyAppearance {
                monitor: 0x10,
                accent: protocol::TapAccent::Clear,
                color_abgr: protocol::pack_abgr(0, 0, 0xff, 0xff),
                blur_radius: 30,
            }
        );
        assert_eq!(
            msgs[2],
            TapMessage::ApplyAppearance {
                monitor: 0x20,
                accent: protocol::TapAccent::Clear,
                color_abgr: protocol::pack_abgr(0xff, 0, 0, 0xff),
                blur_radius: 30,
            }
        );
        // 有缓存：槽 1 当前最大化态 → 从（新）覆盖配置重取最大化外观，不闪桌面。
        let cached = [(
            1u32,
            StateResolution {
                state: taskbar::TaskbarStateKey::MaximizedWindow,
                appearance: TaskbarAppearance::default(), // 旧外观不参与，只看状态键
                matched_rule: None,
            },
        )];
        let (msgs2, _) = build_appearance_messages(&cfg, &caps(true), &targets, &cached);
        assert_eq!(
            msgs2[2],
            TapMessage::ApplyAppearance {
                monitor: 0x20,
                accent: protocol::TapAccent::Opaque,
                color_abgr: protocol::pack_abgr(0, 0xff, 0, 0xff),
                blur_radius: 30,
            }
        );
        assert!(matches!(
            msgs2[3],
            TapMessage::SetBorderVisibility {
                monitor: 0x20,
                visible: true
            }
        ));
        // 统一模式（per_monitor=false）：两屏同为基础桌面蓝。
        cfg.per_monitor = false;
        let (msgs3, _) = build_appearance_messages(&cfg, &caps(true), &targets, &[]);
        assert_eq!(msgs3[0], with_monitor(msgs3[2].clone(), 0x10));
    }

    /// 测试助手：同一消息换 monitor 目标比较。（TapMessage 移入共享
    /// crate 后测试不能再写固有 impl，改为自由函数。）
    fn with_monitor(msg: TapMessage, m: u64) -> TapMessage {
        match msg {
            TapMessage::ApplyAppearance {
                accent,
                color_abgr,
                blur_radius,
                ..
            } => TapMessage::ApplyAppearance {
                monitor: m,
                accent,
                color_abgr,
                blur_radius,
            },
            TapMessage::SetBorderVisibility { visible, .. } => TapMessage::SetBorderVisibility {
                monitor: m,
                visible,
            },
            other => other,
        }
    }

    #[test]
    fn build_messages_disabled_slot_restores_only_that_monitor() {
        let mut cfg = TaskbarSettings {
            enabled: true,
            per_monitor: true,
            ..TaskbarSettings::default()
        };
        cfg.states.desktop.appearance.accent = TaskbarAccent::Acrylic;
        cfg.monitor_overrides.insert(
            "1".to_string(),
            taskbar::TaskbarOverride {
                enabled: Some(false),
                ..taskbar::TaskbarOverride::default()
            },
        );
        let (msgs, _) =
            build_appearance_messages(&cfg, &caps(true), &[(Some(0), 0x10), (Some(1), 0x20)], &[]);
        // 槽 0 照常 acrylic；槽 1 本屏停用 → normal（DLL 还原）+ 顶线可见。
        assert!(matches!(
            msgs[0],
            TapMessage::ApplyAppearance {
                monitor: 0x10,
                accent: protocol::TapAccent::Acrylic,
                ..
            }
        ));
        assert!(matches!(
            msgs[2],
            TapMessage::ApplyAppearance {
                monitor: 0x20,
                accent: protocol::TapAccent::Normal,
                ..
            }
        ));
        assert_eq!(
            msgs[3],
            TapMessage::SetBorderVisibility {
                monitor: 0x20,
                visible: true
            }
        );
    }

    #[test]
    fn message_monitor_extracts_target_only_for_appearance_messages() {
        assert_eq!(
            message_monitor(&TapMessage::SetBorderVisibility {
                monitor: 7,
                visible: true
            }),
            Some(7)
        );
        assert_eq!(message_monitor(&TapMessage::Ping), None);
        assert_eq!(message_monitor(&TapMessage::RestoreAll), None);
    }

    #[test]
    fn resolution_cache_upserts_per_slot() {
        clear_resolutions();
        let res = |c: &str| StateResolution {
            state: taskbar::TaskbarStateKey::Desktop,
            appearance: TaskbarAppearance {
                color: c.to_string(),
                ..TaskbarAppearance::default()
            },
            matched_rule: None,
        };
        remember_resolution(0, &res("#00000000"));
        remember_resolution(1, &res("#11111111"));
        remember_resolution(0, &res("#22222222"));
        let cache = last_resolutions();
        assert_eq!(cache.len(), 2);
        assert_eq!(cache[0].1.appearance.color, "#22222222", "同槽位覆写");
        assert_eq!(cache[1].1.appearance.color, "#11111111");
        clear_resolutions();
        assert!(last_resolutions().is_empty());
    }

    #[test]
    fn fnv1a_is_stable_and_separates_content() {
        assert_eq!(fnv1a64(b"velatap"), fnv1a64(b"velatap"));
        assert_ne!(fnv1a64(b"velatap"), fnv1a64(b"velatap2"));
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    }

    #[test]
    fn metadata_parses_tolerantly() {
        let m = InjectMetadata {
            dll_hash: 42,
            protocol_version: 1,
            explorer_pid: 1234,
            ts_ms: 99,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(serde_json::from_str::<InjectMetadata>(&json).unwrap(), m);
        assert!(serde_json::from_str::<InjectMetadata>("nope").is_err());
    }

    #[test]
    fn residual_hint_requires_different_hash_and_dll() {
        let tmp = std::env::temp_dir().join(format!("vela-tap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let dll_a = tmp.join("a.dll");
        std::fs::write(&dll_a, b"content-a").unwrap();
        let dll_b = tmp.join("b.dll");
        std::fs::write(&dll_b, b"content-b").unwrap();
        let meta = InjectMetadata {
            dll_hash: dll_hash64(b"content-a"),
            protocol_version: 1,
            explorer_pid: 1,
            ts_ms: 0,
        };
        // 同哈希 → 无提示。
        assert!(residual_hint(Some(meta.clone()), Some(&dll_a)).is_none());
        // 无记录 / 无当前 DLL → 无提示（静默）。
        assert!(residual_hint(None, Some(&dll_a)).is_none());
        assert!(
            residual_hint(
                Some(InjectMetadata {
                    dll_hash: 1,
                    protocol_version: 1,
                    explorer_pid: 1,
                    ts_ms: 0,
                }),
                None
            )
            .is_none(),
            "当前 DLL 缺失（未交付）静默跳过"
        );
        // 不同哈希：Windows 下还需 explorer 真挂着 velatap.dll 才提示——
        // 本机测试环境不满足（None）；仅验证不 panic 且语义分支存在。
        let _ = residual_hint(Some(meta), Some(&dll_b));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unpack_dll_reuses_same_hash_dir() {
        let tmp = tap_root();
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("test-src-velatap.dll");
        std::fs::write(&src, b"dummy").unwrap();
        let h = fnv1a64(b"dummy");
        let p1 = unpack_dll(&src, h).unwrap();
        assert!(p1.starts_with(tap_root().join(format!("{h:016x}"))));
        // 第二次同哈希：复用（同一路径，不报错）。
        let p2 = unpack_dll(&src, h).unwrap();
        assert_eq!(p1, p2);
        // 复用前重校验：文件被替换 / 损坏 → 删除重拷。
        std::fs::write(&p1, b"tampered").unwrap();
        let p3 = unpack_dll(&src, h).unwrap();
        assert_eq!(p1, p3);
        assert_eq!(
            std::fs::read(&p3).unwrap(),
            b"dummy",
            "被篡改的解包副本必须被修复"
        );
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_dir_all(tap_root().join(format!("{h:016x}")));
    }

    #[test]
    fn resident_same_version_by_content_then_dir_name() {
        let tmp = std::env::temp_dir().join(format!("vela-tap-resident-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let h = dll_hash64(b"resident-dll");
        let dir = tmp.join(format!("{h:016x}"));
        std::fs::create_dir_all(&dir).unwrap();
        let same = dir.join("velatap.dll");
        std::fs::write(&same, b"resident-dll").unwrap();
        // 内容哈希一致 → 同版本。
        assert!(resident_same_version(&same, h));
        // 内容被改但目录名即哈希（文件读得到时以内容为准）→ 不同版本。
        std::fs::write(&same, b"mutated").unwrap();
        assert!(!resident_same_version(&same, h));
        // 文件读不到（被清理）→ 退回目录名判定。
        let _ = std::fs::remove_file(&same);
        assert!(resident_same_version(&same, h));
        // 目录名也对不上 → 不同版本。
        assert!(!resident_same_version(
            &tmp.join("nope").join("velatap.dll"),
            h
        ));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn marker_event_name_embeds_pid() {
        assert_eq!(marker_event_name(77), r"Local\velatap-inject-77");
    }

    /* ---------------- 手测驱动（真实注入 explorer；--ignored 逐个执行）
     * 前置：mock/真实 velatap.dll 已放在测试 exe 同目录
     * （target/debug/deps/velatap.dll）。日志证据：%TEMP%\vela\mock-tap.log
     * （mock DLL 侧）+ cargo test --nocapture（引擎侧）。
     * ---------------- */

    #[cfg(windows)]
    mod manual {
        use super::*;
        use crate::models::TaskbarPhase;

        fn mock_log() -> String {
            std::fs::read_to_string(std::env::temp_dir().join("vela").join("mock-tap.log"))
                .unwrap_or_default()
        }

        /// 轮询 mock 日志直到包含期望片段（send 成功 ≠ DLL 已异步记账，
        /// 必须等对端写日志）。
        fn wait_log(timeout: Duration, pred: impl Fn(&str) -> bool) -> String {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                let log = mock_log();
                if pred(&log) {
                    return log;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "mock 日志未出现期望内容
--- mock log ---
{log}"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        fn reset_engine() {
            let artifacts = teardown();
            cleanup_artifacts(artifacts);
            *PHASE.lock().unwrap_or_else(|p| p.into_inner()) = None;
            CREATED_TS.lock().unwrap_or_else(|p| p.into_inner()).clear();
        }

        fn wait_phase(timeout: Duration, pred: impl Fn(&PhaseCell) -> bool) -> PhaseCell {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                let cell = phase_cell();
                if pred(&cell) {
                    return cell;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "等 phase 超时（当前 {:?} reason={:?}）\n--- mock log ---\n{}",
                    cell.phase,
                    cell.reason,
                    mock_log()
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        fn red_config() -> TaskbarSettings {
            let mut cfg = TaskbarSettings {
                enabled: true,
                ..TaskbarSettings::default()
            };
            cfg.states.desktop.appearance.accent = TaskbarAccent::Opaque;
            cfg.states.desktop.appearance.color = "#ff0000ff".to_string();
            cfg
        }

        /// 负路径：DLL 缺 CallWndProc 导出（空壳/不配套版本）→ 终态
        /// Failed + 明确文案，explorer 不受影响、不重试。
        /// 前置：target/debug/deps/velatap.dll 为**无** CallWndProc 导出的
        /// 版本（如无导出的空壳 DLL）。
        #[test]
        #[ignore = "真实注入 explorer：需无 CallWndProc 导出的空壳 velatap.dll"]
        fn manual_negative_missing_export() {
            reset_engine();
            let cfg = red_config();
            let r = apply_config(&cfg);
            println!("[manual] apply 返回: {r:?}");
            let cell = wait_phase(Duration::from_secs(45), |c| c.phase == TaskbarPhase::Failed);
            let reason = cell.reason.unwrap_or_default();
            assert!(
                reason.contains("CallWndProc") || reason.contains("velatap.dll"),
                "负路径文案异常: {reason}"
            );
            println!("[manual] 负路径通过：{reason}");
        }

        /// M1 链路 + 开关往返 + 幂等 + 断连重连（不重复注入）。
        #[test]
        #[ignore = "真实注入 explorer：需 mock velatap.dll 在 target/debug/deps"]
        fn manual_engine_cycle() {
            reset_engine();
            let log_path = std::env::temp_dir().join("vela").join("mock-tap.log");
            let _ = std::fs::remove_file(&log_path);

            // —— 开：注入 → Ready → 自动应用（STATE 未合入 → desktop 求值）。
            let cfg = red_config();
            let notes = apply_config(&cfg).expect("apply enabled");
            println!("[manual] apply notes: {notes:?}");
            wait_phase(Duration::from_secs(40), |c| c.phase == TaskbarPhase::Ready);
            let log = wait_log(Duration::from_secs(5), |l| {
                l.contains("已回 Ready")
                    && l.contains("APPLY: monitor=0 accent=Opaque color=0xff0000ff")
            });
            println!(
                "[manual] 注入+红屏外观送达（见 mock 日志，共 {} 行）",
                log.lines().count()
            );

            // —— 幂等：同配置第二次 apply 不重复注入（generation 不变）。
            let gen = with_engine(|e| e.generation);
            let ready_before = mock_log().matches("已回 Ready").count();
            let notes2 = apply_config(&cfg).expect("apply idempotent");
            assert_eq!(gen, with_engine(|e| e.generation), "重复注入了！");
            assert!(notes2.is_empty(), "{notes2:?}");
            std::thread::sleep(Duration::from_millis(600));
            assert_eq!(
                mock_log().matches("已回 Ready").count(),
                ready_before,
                "DLL 被二次握手"
            );

            // —— 断连重连：服务端主动断开 → Degraded → 不重复注入地重连成功。
            let pipe = with_engine(|e| e.pipe.clone()).expect("pipe");
            pipe.shutdown();
            wait_phase(Duration::from_secs(30), |c| {
                c.phase == TaskbarPhase::Degraded
            });
            let gen2 = with_engine(|e| e.generation);
            wait_phase(Duration::from_secs(30), |c| c.phase == TaskbarPhase::Ready);
            assert_eq!(gen2, with_engine(|e| e.generation), "重连走了重复注入");
            let log = wait_log(Duration::from_secs(5), |l| {
                l.contains("DISCONNECTED") && l.contains("恢复默认")
            });
            println!("[manual] 断连→DLL 恢复默认→重连（mock 日志尾部 3 行）");
            let tail: Vec<&str> = log.lines().collect();
            for line in tail.iter().rev().take(3).rev() {
                println!("    {line}");
            }

            // —— 关：RestoreAll + Idle。
            let mut off = cfg.clone();
            off.enabled = false;
            apply_config(&off).expect("apply disabled");
            wait_phase(Duration::from_secs(10), |c| c.phase == TaskbarPhase::Idle);
            wait_log(Duration::from_secs(5), |l| l.contains("RESTORE-ALL"));
            println!("[manual] 开关往返 + 幂等 + 断连重连 全部通过");
        }

        /// 版本不匹配路径：预放 mockver=99 → DLL 回 Ready{99} →
        /// Failed + 「重启资源管理器」文案。前置：explorer 内无旧 velatap
        /// 拷贝（旧拷贝会抢先应答——那本身是升级残留场景，另行观察）。
        #[test]
        #[ignore = "真实注入 explorer：需 mock velatap.dll 且干净的 explorer"]
        fn manual_version_mismatch() {
            reset_engine();
            // 预先算出解包目录并放 mockver（dll 内容 → 哈希 → 目录）。
            let src = locate_dll().expect("velatap.dll");
            let hash = fnv1a64(&std::fs::read(&src).unwrap());
            let dir = tap_root().join(format!("{hash:016x}"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("velatap.mockver"), "99").unwrap();
            println!(
                "[manual] mockver=99 → {}",
                dir.join("velatap.mockver").display()
            );

            ensure_started();
            let cell = wait_phase(Duration::from_secs(45), |c| c.phase == TaskbarPhase::Failed);
            let reason = cell.reason.unwrap_or_default();
            assert!(reason.contains("协议版本不匹配"), "{reason}");
            assert!(reason.contains("重启资源管理器"), "{reason}");
            let _ = std::fs::remove_file(dir.join("velatap.mockver"));
            println!("[manual] 版本不匹配路径通过：{reason}");
        }

        /// 真 velatap DLL 全链路（出口判据驱动）：注入握手 + 幂等 +
        /// 开关往返。视觉变色由外部截图留证（mock 日志断言不适用）。
        #[test]
        #[ignore = "真实 velatap DLL 注入 explorer：视觉验证用"]
        fn manual_real_tap_cycle() {
            reset_engine();
            let cfg = red_config();
            let r = apply_config(&cfg);
            println!("[manual] apply(红) → {r:?}");
            let cell = wait_phase(Duration::from_secs(45), |c| {
                c.phase == TaskbarPhase::Ready || c.phase == TaskbarPhase::Failed
            });
            assert_eq!(
                cell.phase,
                TaskbarPhase::Ready,
                "注入未就绪: {:?}",
                cell.reason
            );
            let gen = with_engine(|e| e.generation);
            let r2 = apply_config(&cfg);
            assert_eq!(gen, with_engine(|e| e.generation), "重复注入");
            println!("[manual] 二次 apply 幂等 OK → {r2:?}");
            // 持有 8s 供外部截图，然后关闭恢复。
            std::thread::sleep(Duration::from_secs(8));
            let mut off = cfg;
            off.enabled = false;
            apply_config(&off).expect("disable");
            wait_phase(Duration::from_secs(10), |c| c.phase == TaskbarPhase::Idle);
            println!("[manual] 已关闭并恢复默认");
        }

        /// 强杀/长持驱动（bash 侧 taskkill /F 本进程后查 mock 日志的
        /// PARENT-DEAD 行；或 explorer 重启后查重建）。
        #[test]
        #[ignore = "长持进程：注入后 sleep 供外部 taskkill / explorer 重启"]
        fn manual_hold() {
            reset_engine();
            let cfg = red_config();
            apply_config(&cfg).expect("apply");
            wait_phase(Duration::from_secs(40), |c| c.phase == TaskbarPhase::Ready);
            println!(
                "[manual] READY，进程 {} 持有注入，等待外部操作…",
                std::process::id()
            );
            for _ in 0..600 {
                std::thread::sleep(Duration::from_secs(1));
            }
        }

        /// 真机注册表枚举（不注入、不改任务栏）：Shell_TrayWnd 主 +
        /// EnumWindows 副屏任务栏 → HMONITOR（边探测 / 回退）→ 槽位；与
        /// EnumDisplayMonitors 的显示器数对账。双屏机上应见 2 台任务栏各归
        /// 一屏、槽位不同；开启「自动隐藏任务栏」后再跑一次验证边探测路径。
        #[test]
        #[ignore = "真机枚举：读取本机任务栏窗口与显示器（只读，无副作用）"]
        fn manual_registry_enumeration() {
            let reg = refresh_registry();
            let monitors = crate::taskbar::state::monitor_entries();
            println!("[manual] 显示器 {} 台：{monitors:?}", monitors.len());
            for e in &reg {
                println!(
                    "[manual] 任务栏 hwnd={:#x} monitor={:#x} slot={:?}",
                    e.hwnd, e.hmonitor, e.slot
                );
            }
            let targets = send_targets(&reg);
            println!("[manual] 下发目标：{targets:?}");
            assert!(!reg.is_empty(), "至少应找到 Shell_TrayWnd");
            assert!(
                reg.iter().all(|e| e.hmonitor != 0),
                "每台任务栏都应映射到有效 HMONITOR"
            );
            assert!(
                reg.iter().all(|e| e.slot.is_some()),
                "每台任务栏都应落到稳定槽位"
            );
            let slots: std::collections::HashSet<_> = reg.iter().map(|e| e.slot).collect();
            assert_eq!(slots.len(), reg.len(), "槽位互不相同");
            assert!(reg.len() <= monitors.len(), "任务栏数不应超过显示器数");
        }
    }
}
