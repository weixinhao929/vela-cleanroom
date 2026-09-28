//! 状态机线程（TB-STATE 主装配）：事件合并 → CORE 纯函数求值 → 防抖输出。
//!
//! 数据流：win_event（窗口事件）+ start（IAppVisibility）+ search/taskview
//! （ShellViewCoordinator）+ battery（win_watcher 电源广播）全部经无界
//! std mpsc 汇入本线程；[`Engine`] 独占持有全部状态（**无锁**，天然规避
//! §1.4 的虚拟桌面重入陷阱——会泵消息的查询只发生在本线程，钩子回调在
//! 别的线程），每条消息后走 150ms 合并防抖（F-14），到期对每显示器调
//! CORE 的 [`crate::taskbar::resolve_active_state`]，与上次结果比较
//! （state / appearance / matchedRule 任一变化才算），变化才 emit
//! `taskbar:state-changed` 并触发 apply 回调（本会话默认实现为
//! log::debug；TB-INJECT 合入后接管实际外观下发）。

pub mod battery;
pub mod search;
pub mod start;
pub mod taskview;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::models::TaskbarStateChanged;
use crate::taskbar::win_event::{self, WinEventMsg};
use crate::taskbar::window::{self, DesktopManager, WindowTable};
use crate::taskbar::{
    MonitorInputs, StateInputs, StateResolution, TaskbarAppearance, TaskbarStateKey, WindowInfo,
};

/// 合并防抖窗口（F-14：≤200ms 上限取 150ms；状态切换端到端 ≤300ms 的
/// 预算 = 事件传播 + 150ms + 求值）。
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// 无待处理事件时的唤醒轮询上限（也是 stop() 的退出延迟上界）。
const POLL: Duration = Duration::from_millis(250);

/// 状态机线程的全部输入事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineMsg {
    /// WinEvent 线程转发（窗口集合 / 前台 / Peek / 任务栏窗口生命周期）。
    Win(WinEventMsg),
    /// 开始菜单可见性（IAppVisibility）。
    Start(bool),
    /// 搜索（ShellView Search）可见性。
    Search(bool),
    /// 开始内搜索（ShellView FindInStart）可见性。
    FindInStart(bool),
    /// 任务视图（ShellView TaskView）可见性。
    TaskView(bool),
    /// 省电模式（GUID_POWER_SAVING_STATUS）。
    Battery(bool),
    /// 全量重建（显示器拓扑变化 / explorer 重启 / 任务栏窗口建毁）。
    Rebuild,
    /// 配置变更（apply）：清去重缓存、按当前输入对全部显示器重求值并全量
    /// 重发（F-6：逐屏生效配置变了，各屏状态未变也要重发新外观）。
    Reevaluate,
}

impl EngineMsg {
    /// 搜索源事件映射（search.rs 订阅回调用）。
    pub fn search_event(v: bool) -> EngineMsg {
        EngineMsg::Search(v)
    }
    /// FindInStart 源事件映射。
    pub fn find_in_start_event(v: bool) -> EngineMsg {
        EngineMsg::FindInStart(v)
    }
    /// 任务视图源事件映射（taskview.rs 订阅回调用）。
    pub fn task_view(v: bool) -> EngineMsg {
        EngineMsg::TaskView(v)
    }
}

/* ---------------- 防抖门（纯逻辑，假时钟可测） ---------------- */

/// 事件风暴合并门：事件到来把截止时间推到 `now + debounce`，到期才放行
/// 一次求值；风暴期间反复后延 → 只在最后一次事件后 debounce 输出一回。
#[derive(Debug)]
pub struct DebounceGate {
    debounce: Duration,
    deadline: Option<Instant>,
}

impl DebounceGate {
    pub fn new(debounce: Duration) -> Self {
        Self {
            debounce,
            deadline: None,
        }
    }

    pub fn on_event(&mut self, now: Instant) {
        self.deadline = Some(now + self.debounce);
    }

    pub fn due(&self, now: Instant) -> bool {
        self.deadline.is_some_and(|d| now >= d)
    }

    /// 到期前的剩余等待（None = 无挂起事件）。
    pub fn next_wait(&self, now: Instant) -> Option<Duration> {
        self.deadline.map(|d| d.saturating_duration_since(now))
    }

    pub fn clear(&mut self) {
        self.deadline = None;
    }
}

/* ---------------- 输出面（emit + apply 回调） ---------------- */

/// 求值输出面（生产实现 emit Tauri 事件 + apply 回调；测试实现收集）。
pub trait StateOutput: Send + Sync {
    /// 一台显示器的实际变化（防抖 + 去重后才会到这里）。
    fn on_state_changed(
        &self,
        slot: u32,
        change: &TaskbarStateChanged,
        resolution: &StateResolution,
    );
}

/// 生产输出：emit `taskbar:state-changed`（F-14）+ info 日志（手测脚本
/// 的对照证据）+ apply 回调。
struct EmitterOutput;

impl StateOutput for EmitterOutput {
    fn on_state_changed(&self, slot: u32, change: &TaskbarStateChanged, res: &StateResolution) {
        log::info!(
            "taskbar: state-changed monitor={slot} state={:?} matched_rule={:?} accent={:?}",
            change.active_state,
            change.matched_rule,
            res.appearance.accent
        );
        crate::taskbar::emit_state_changed(change.clone());
        notify_apply(slot, res);
    }
}

/// apply 回调（CORE 契约位：TB-INJECT 接管实际外观下发；本会话默认
/// 实现为 log::debug）。
pub type ApplyCallback = Arc<dyn Fn(u32, &StateResolution) + Send + Sync>;

static APPLY_CALLBACK: Mutex<Option<ApplyCallback>> = Mutex::new(None);

/// 设置 / 清除 apply 回调（INJECT 合入后接线；None 恢复默认 debug 日志）。
pub fn set_apply_callback(cb: Option<ApplyCallback>) {
    *APPLY_CALLBACK.lock().unwrap_or_else(|p| p.into_inner()) = cb;
}

fn notify_apply(slot: u32, res: &StateResolution) {
    let cb = APPLY_CALLBACK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    match cb {
        Some(cb) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(slot, res))).is_err() {
                log::error!("taskbar state: apply callback panicked");
            }
        }
        None => log::debug!(
            "taskbar state: apply slot={slot} state={:?} appearance={:?}",
            res.state,
            res.appearance
        ),
    }
}

/* ---------------- 引擎核心 ---------------- */

/// 一台显示器（HMONITOR + 稳定槽位；槽位对齐 monitor.rs `monitor:slots`，
/// 与 widget-N 同号）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorEntry {
    pub hmonitor: isize,
    pub slot: u32,
}

/// 单屏上次求值结果（去重键：state / appearance / matched_rule）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct LastResolution {
    state: TaskbarStateKey,
    appearance: TaskbarAppearance,
    matched_rule: Option<String>,
}

/// 状态引擎：独占线程持有；`handle` 每消息返回是否需要重求值（dirty），
/// `evaluate` 在防抖到期时被调用。
pub struct Engine {
    monitors: Vec<MonitorEntry>,
    table: WindowTable,
    fg: isize,
    peek_active: bool,
    battery_saver: bool,
    task_view: bool,
    /// 开始菜单 / 搜索 / FindInStart 当前所在显示器（None = 关闭）。
    start_monitor: Option<isize>,
    search_monitor: Option<isize>,
    find_in_start_monitor: Option<isize>,
    last: HashMap<u32, LastResolution>,
    output: Arc<dyn StateOutput>,
    vdm: DesktopManager,
}

/// Shell UI（开始 / 搜索类）可见性翻转的公共路径：开 → 归属前台显示器
///（标杆口径）；关 → 清空。返回是否变化。
fn set_ui_slot(visible: bool, slot: &mut Option<isize>) -> bool {
    let new = if visible { shell_ui_monitor() } else { None };
    if new == *slot {
        false
    } else {
        *slot = new;
        true
    }
}

/// Shell UI（开始 / 搜索）所在显示器：标杆口径 = 事件回调后 Sleep(5) +
/// `MonitorFromWindow(GetForegroundWindow())`（hpp:236-247）。**已知不
/// 精确**：开动画未完成时前台可能尚未切到 shell 宿主；关事件时前台往往
/// 已是别的窗口——关侧只用 None 清空，不受影响。
fn shell_ui_monitor() -> Option<isize> {
    win32::shell_ui_monitor()
}

impl Engine {
    fn new(output: Arc<dyn StateOutput>, vdm: DesktopManager) -> Self {
        Self {
            monitors: Vec::new(),
            table: WindowTable::new(),
            fg: 0,
            peek_active: false,
            battery_saver: false,
            task_view: false,
            start_monitor: None,
            search_monitor: None,
            find_in_start_monitor: None,
            last: HashMap::new(),
            output,
            vdm,
        }
    }

    /// 处理一条事件；返回是否需要重求值（dirty）。
    pub fn handle(&mut self, msg: EngineMsg) -> bool {
        match msg {
            EngineMsg::Win(WinEventMsg::Insert(hwnd)) => self.insert_window(hwnd),
            EngineMsg::Win(WinEventMsg::Remove(hwnd)) => self.table.remove(hwnd),
            EngineMsg::Win(WinEventMsg::Foreground(hwnd)) => {
                let valid = if hwnd != 0 && win32::is_window(hwnd) {
                    hwnd
                } else {
                    0
                };
                if valid == self.fg {
                    false
                } else {
                    self.fg = valid;
                    true
                }
            }
            EngineMsg::Win(WinEventMsg::Peek(active)) => flip_flag(active, &mut self.peek_active),
            EngineMsg::Win(WinEventMsg::TrayCreated(hwnd)) => {
                log::info!("taskbar state: tray window created ({hwnd:#x}), rebuilding");
                self.rebuild();
                win_event::dispatch_tray_event(true, hwnd);
                true
            }
            EngineMsg::Win(WinEventMsg::TrayDestroyed(hwnd)) => {
                log::info!("taskbar state: tray window destroyed ({hwnd:#x}), rebuilding");
                self.rebuild();
                win_event::dispatch_tray_event(false, hwnd);
                true
            }
            EngineMsg::Start(visible) => set_ui_slot(visible, &mut self.start_monitor),
            EngineMsg::Search(visible) => set_ui_slot(visible, &mut self.search_monitor),
            EngineMsg::FindInStart(visible) => {
                set_ui_slot(visible, &mut self.find_in_start_monitor)
            }
            EngineMsg::TaskView(active) => flip_flag(active, &mut self.task_view),
            EngineMsg::Battery(on) => flip_flag(on, &mut self.battery_saver),
            EngineMsg::Rebuild => {
                self.rebuild();
                true
            }
            EngineMsg::Reevaluate => {
                self.last.clear();
                true
            }
        }
    }

    /// 单窗口判定入表（judge 内部先快照后判定；虚拟桌面查询最后做）。
    /// F-6：忽略列表**不在表层剔窗**——过滤在逐屏求值
    /// （[`crate::taskbar::resolve_active_state`]）内按该屏生效列表进行，
    /// 否则逐屏覆盖无法解除统一忽略（覆盖 = 整体替换）。
    fn insert_window(&mut self, hwnd: isize) -> bool {
        let no_ignore = crate::taskbar::TaskbarIgnoredWindows::default();
        let judgment = window::judge_window(hwnd, &no_ignore, &self.vdm);
        self.table.insert(hwnd, judgment)
    }

    /// 全量重建（显示器 + 窗口集合；对齐标杆 ResetState 的枚举路径）。
    /// 同时清去重缓存：重建后（explorer 重启 / 热插拔 / 任务栏建毁）DLL 侧
    /// 是新的或显示器集变了，每屏都必须重发一次当前外观。
    fn rebuild(&mut self) {
        self.monitors = win32::monitor_entries();
        self.table.clear();
        self.last.clear();
        // shell 的「打开中」瞬态一并作废：explorer 崩溃重建时旧 shell 进程已死，
        // 它的 Close 事件永不会来（IAppVisibility / ShellViewCoordinator 不会对
        // 已死 shell 补发 false），不清会把该屏永久钉在 StartOpened / SearchOpened
        // 外观。重建后由源线程按新 shell 的真实状态重新置位；省电标志与 shell
        // 无关，保留。
        self.start_monitor = None;
        self.search_monitor = None;
        self.find_in_start_monitor = None;
        self.task_view = false;
        self.peek_active = false;
        // 先收集完整快照再逐个判定（§1.4：绝不边判定边迭代可变集合）。
        for hwnd in window::enumerate_windows_zorder() {
            let _ = self.insert_window(hwnd);
        }
        if self.fg != 0 && !win32::is_window(self.fg) {
            self.fg = 0;
        }
    }

    /// 组装全局输入并逐屏求值输出（仅变化屏 emit）。
    fn evaluate(&mut self) {
        let config = crate::taskbar::current_config();
        if !config.enabled {
            // 模块关闭：不输出；清空去重缓存，重开时重新对账。
            self.last.clear();
            return;
        }
        let fg_info = if self.fg != 0 {
            window::window_info(self.fg)
        } else {
            None
        };
        let fg_monitor = if self.fg != 0 {
            win32::monitor_from_window(self.fg)
        } else {
            None
        };
        let snap = EngineSnapshot {
            monitors: self.monitors.clone(),
            table: self.table.clone(),
            zorder: window::enumerate_windows_zorder(),
            fg_info,
            fg_monitor,
            start_monitor: self.start_monitor,
            search_monitor: self.search_monitor,
            find_in_start_monitor: self.find_in_start_monitor,
            task_view: self.task_view,
            battery_saver: self.battery_saver,
            peek_active: self.peek_active,
        };
        let inputs = assemble_inputs(&snap);
        for (index, entry) in self.monitors.iter().enumerate() {
            // F-6 每屏入口：按该屏稳定槽位的生效配置（统一 / 覆盖）求值。
            let res =
                crate::taskbar::resolve_active_state_for_slot(&config, &inputs, index, entry.slot);
            let key = LastResolution {
                state: res.state,
                appearance: res.appearance.clone(),
                matched_rule: res.matched_rule.clone(),
            };
            if self.last.get(&entry.slot) != Some(&key) {
                self.last.insert(entry.slot, key);
                let change = TaskbarStateChanged {
                    active_state: res.state,
                    monitor: entry.slot,
                    matched_rule: res.matched_rule.clone(),
                };
                self.output.on_state_changed(entry.slot, &change, &res);
            }
        }
    }
}

/// 量位翻转的公共判定（值未变不 dirty）。
fn flip_flag(new: bool, current: &mut bool) -> bool {
    if new == *current {
        false
    } else {
        *current = new;
        true
    }
}

/// 求值时刻的引擎只读快照（[`assemble_inputs`] 的输入包：字段即 CORE
/// `StateInputs` 的原始事实，聚合以避免长参数列）。
#[derive(Debug, Clone)]
pub struct EngineSnapshot {
    pub monitors: Vec<MonitorEntry>,
    pub table: WindowTable,
    /// Z 序快照（自顶向下）。
    pub zorder: Vec<isize>,
    /// 前台窗口信息 + 所在显示器（None = 无前台 / 已失效）。
    pub fg_info: Option<WindowInfo>,
    pub fg_monitor: Option<isize>,
    /// 开始 / 搜索 / FindInStart 当前所在显示器（None = 关闭）。
    pub start_monitor: Option<isize>,
    pub search_monitor: Option<isize>,
    pub find_in_start_monitor: Option<isize>,
    pub task_view: bool,
    pub battery_saver: bool,
    pub peek_active: bool,
}

/// 快照 → StateInputs 组装（纯函数，可单测）：每屏 maximised / normal /
/// 前台归属（前台在其他屏时该屏为 None）+ 开始 / 搜索归属 + 全局三布尔。
pub fn assemble_inputs(snap: &EngineSnapshot) -> StateInputs {
    let zrank = window::z_ranks(&snap.zorder);
    StateInputs {
        monitors: snap
            .monitors
            .iter()
            .map(|m| {
                let (maximised, normal) = snap.table.monitor_sets(m.hmonitor, &zrank);
                MonitorInputs {
                    maximised,
                    normal,
                    foreground: match snap.fg_monitor {
                        Some(fmon) if fmon == m.hmonitor => snap.fg_info.clone(),
                        _ => None,
                    },
                    start_opened: snap.start_monitor == Some(m.hmonitor),
                    search_opened: snap.search_monitor == Some(m.hmonitor)
                        || snap.find_in_start_monitor == Some(m.hmonitor),
                }
            })
            .collect(),
        task_view: snap.task_view,
        battery_saver: snap.battery_saver,
        peek_active: snap.peek_active,
    }
}

/* ---------------- Win32 胶水（cfg windows） ---------------- */

#[cfg(windows)]
mod win32 {
    use std::collections::HashSet;
    use std::time::Duration;

    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, MonitorFromWindow, HDC, HMONITOR, MONITOR_DEFAULTTONULL,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Shell::IVirtualDesktopManager;
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    use super::MonitorEntry;
    use crate::taskbar::window::DesktopManager;

    /// CLSID_VirtualDesktopManager {AA509086-5CA9-4C25-8F95-589D3C07B48A}
    ///（shobjidl_core.h；windows crate 未带该常量，手写）。
    const CLSID_VIRTUAL_DESKTOP_MANAGER: windows::core::GUID =
        windows::core::GUID::from_u128(0xaa509086_5ca9_4c25_8f95_589d3c07b48a);

    pub fn is_window(hwnd: isize) -> bool {
        // SAFETY: 只读。
        unsafe { IsWindow(Some(HWND(hwnd as *mut _))).as_bool() }
    }

    pub fn monitor_from_window(hwnd: isize) -> Option<isize> {
        // SAFETY: 只读。
        unsafe {
            let mon = MonitorFromWindow(HWND(hwnd as *mut _), MONITOR_DEFAULTTONULL);
            if mon.is_invalid() {
                None
            } else {
                Some(mon.0 as isize)
            }
        }
    }

    /// Shell UI 显示器归属（标杆 Sleep(5) 口径，见上层注释）。
    pub fn shell_ui_monitor() -> Option<isize> {
        std::thread::sleep(Duration::from_millis(5));
        let fg = crate::taskbar::window::foreground_hwnd();
        if fg == 0 {
            None
        } else {
            monitor_from_window(fg)
        }
    }

    /// 线程 COM 初始化（MTA）。失败（含已初始化为其他模式的
    /// RPC_E_CHANGED_MODE）仅记日志——源对象创建会随之失败并逐项降级。
    pub fn co_init_mta() -> bool {
        // SAFETY: 每线程一次；配对 CoUninitialize 由调用方在线程退出时调。
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_ok() {
                true
            } else {
                log::warn!("taskbar state: CoInitializeEx(MTA) failed: {hr}");
                false
            }
        }
    }

    pub fn co_uninit() {
        // SAFETY: 与成功的 CoInitializeEx 配对。
        unsafe { CoUninitialize() };
    }

    pub fn create_vdm() -> DesktopManager {
        // SAFETY: 只读 COM 创建。
        unsafe {
            let created: windows::core::Result<IVirtualDesktopManager> =
                CoCreateInstance(&CLSID_VIRTUAL_DESKTOP_MANAGER, None, CLSCTX_ALL);
            match created {
                Ok(m) => Some(m),
                Err(e) => {
                    log::warn!("taskbar state: VirtualDesktopManager unavailable: {e}");
                    None
                }
            }
        }
    }

    unsafe extern "system" fn enum_monitors_cb(
        hmonitor: HMONITOR,
        _hdc: HDC,
        rect: *mut RECT,
        lparam: LPARAM,
    ) -> windows::core::BOOL {
        // SAFETY: EnumDisplayMonitors 回调约定：rect 指向只读矩形；
        // lparam 指向调用方集合。
        unsafe {
            let out = &mut *(lparam.0 as *mut Vec<(isize, i32, i32, i32, i32)>);
            let r = &*rect;
            out.push((hmonitor.0 as isize, r.left, r.top, r.right, r.bottom));
            windows::core::BOOL(1)
        }
    }

    /// 枚举显示器 + 稳定槽位（几何匹配 monitor.rs 的 tauri 枚举；
    /// 匹配失败回退按 (top, left) 排序补位）。
    pub fn monitor_entries() -> Vec<MonitorEntry> {
        // SAFETY: 回调只 push；无跨调用可变状态。
        let mut raw: Vec<(isize, i32, i32, i32, i32)> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_monitors_cb),
                LPARAM(&mut raw as *mut _ as isize),
            );
        }
        slot_by_geometry(raw)
    }

    /// 几何 → 槽位（纯函数，可测）：先把 (hmonitor, 几何) 与 tauri 枚举
    /// （monitor.rs resolve_monitor_slots 的 (slot, 位置, 尺寸)）对齐；
    /// tauri 不可用 / 未命中的按 (top, left) 排序补位。
    fn slot_by_geometry(raw: Vec<(isize, i32, i32, i32, i32)>) -> Vec<MonitorEntry> {
        let tauri_slots: Vec<(u32, i32, i32, u32, u32)> =
            std::panic::catch_unwind(tauri_monitor_geometry).unwrap_or_default();
        let mut entries: Vec<MonitorEntry> = Vec::with_capacity(raw.len());
        let mut unmatched: Vec<(isize, i32, i32)> = Vec::new();
        for (hmon, l, t, r, b) in raw {
            let (w, h) = (r - l, b - t);
            match tauri_slots
                .iter()
                .find(|(_, x, y, tw, th)| *x == l && *y == t && *tw as i32 == w && *th as i32 == h)
            {
                Some((slot, ..)) => entries.push(MonitorEntry {
                    hmonitor: hmon,
                    slot: *slot,
                }),
                None => unmatched.push((hmon, t, l)),
            }
        }
        if !unmatched.is_empty() {
            unmatched.sort_by_key(|e| (e.1, e.2));
            let start = entries.iter().map(|e| e.slot).max().map_or(0, |s| s + 1);
            for (i, (hmon, _, _)) in unmatched.into_iter().enumerate() {
                entries.push(MonitorEntry {
                    hmonitor: hmon,
                    slot: start + i as u32,
                });
            }
        }
        entries.sort_by_key(|e| e.slot);
        if entries.windows(2).any(|w| w[0].slot == w[1].slot) {
            // 病理重复（同几何双屏同名）：去重保槽位唯一，后续按序生效。
            let mut seen = HashSet::new();
            entries.retain(|e| seen.insert(e.slot));
        }
        entries
    }

    /// tauri 显示器枚举 + monitor.rs 稳定槽位 → (slot, x, y, w, h)。
    fn tauri_monitor_geometry() -> Vec<(u32, i32, i32, u32, u32)> {
        let Some(app) = crate::taskbar::app_handle() else {
            return Vec::new();
        };
        let monitors = app.available_monitors().unwrap_or_default();
        crate::monitor::resolve_monitor_slots(app, &monitors)
            .into_iter()
            .map(|(slot, m)| {
                let pos = m.position();
                let size = m.size();
                (slot as u32, pos.x, pos.y, size.width, size.height)
            })
            .collect()
    }
}

#[cfg(not(windows))]
mod win32 {
    use super::MonitorEntry;
    use crate::taskbar::window::DesktopManager;

    pub fn is_window(_hwnd: isize) -> bool {
        false
    }

    pub fn monitor_from_window(_hwnd: isize) -> Option<isize> {
        None
    }

    pub fn shell_ui_monitor() -> Option<isize> {
        None
    }

    pub fn co_init_mta() -> bool {
        false
    }

    pub fn co_uninit() {}

    pub fn create_vdm() -> DesktopManager {
        None
    }

    pub fn monitor_entries() -> Vec<MonitorEntry> {
        Vec::new()
    }
}

/* ---------------- win_watcher 桥（电源 / 显示器 / explorer 重启） ---------------- */

/// 把 CORE win_watcher 的三类系统事件转成引擎消息。注意 win_watcher 的
/// 注册表是只增的（CORE 冻结契约）：本桥随检测启动注册一次，线程退出后
/// 残留的 Sender send 失败被静默忽略（通道关闭即丢，无泄漏）。
struct WatcherBridge {
    tx: Sender<EngineMsg>,
}

impl crate::taskbar::win_watcher::SystemEventCallback for WatcherBridge {
    fn on_taskbar_created(&self) {
        let _ = self.tx.send(EngineMsg::Rebuild);
    }

    fn on_display_change(&self) {
        let _ = self.tx.send(EngineMsg::Rebuild);
    }

    fn on_power_broadcast(&self, event: u32, data: isize) {
        if let Some(on) = battery::parse_power_broadcast(event, data) {
            let _ = self.tx.send(EngineMsg::Battery(on));
        }
    }
}

/* ---------------- 线程生命周期 ---------------- */

/// 活动引擎代际（0 = 未运行）：start 抢占递增；stop 置 0；引擎线程退出时仅当
/// 自己仍是活动代际才清 0（compare_exchange）。只有单个 RUNNING 布尔时存在
/// 停启竞态：stop → 紧接 start 立起新引擎后，旧引擎退出路径的无条件
/// `RUNNING.store(false)` 会打掉新引擎的运行标志、迟到的 WM_QUIT 会误杀新的
/// 源线程（T-10）。代际让两件事都只作用于"自己那一代"。
static ACTIVE_GEN: AtomicU64 = AtomicU64::new(0);
/// 代际发生器（每次 start 尝试递增；与 ACTIVE_GEN 分开，避免 CAS 竞争交织）。
static NEXT_GEN: AtomicU64 = AtomicU64::new(0);
/// STA 源线程登记（代际 + 线程 id；tid 0 = 未启动）。stop 的 WM_QUIT 只投给
/// 与被停代际同代的源线程。
static SOURCES_THREAD: Mutex<(u64, u32)> = Mutex::new((0, 0));

/// 登记本代源线程 id（源线程自报；覆盖上一代残留）。
fn register_sources_thread(gen: u64, tid: u32) {
    *SOURCES_THREAD.lock().unwrap_or_else(|p| p.into_inner()) = (gen, tid);
}

/// 源线程退出：清掉自己的登记（新一代已登记则不动）。
fn unregister_sources_thread(tid: u32) {
    let mut guard = SOURCES_THREAD.lock().unwrap_or_else(|p| p.into_inner());
    if guard.1 == tid {
        *guard = (0, 0);
    }
}
/// 引擎线程收件箱的发送端（引擎存活期内有效）：INJECT 在配置变更后经
/// [`request_reevaluate`] 触发全量重求值（F-6 每屏入口的外部触发点）。
/// 带代际标签：旧代退出只清属于自己的那份——stop → 紧接 start 时新一代已
/// 登记新 Sender，旧代无条件置 None 会把它抹掉，此后 request_reevaluate 恒 false。
static ENGINE_TX: Mutex<Option<(u64, Sender<EngineMsg>)>> = Mutex::new(None);

/// 请求引擎清去重缓存并按当前输入重求值全部显示器（配置 apply / 重连 /
/// 注册表刷新后调用）。引擎未运行返回 false（调用方的即时基线已覆盖）。
pub fn request_reevaluate() -> bool {
    ENGINE_TX
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .is_some_and(|(_, tx)| tx.send(EngineMsg::Reevaluate).is_ok())
}

/// 当前显示器 → 稳定槽位表（EnumDisplayMonitors + monitor.rs 几何对齐；
/// INJECT 的每屏任务栏注册表用同一份映射，保证槽位口径唯一）。
pub fn monitor_entries() -> Vec<MonitorEntry> {
    win32::monitor_entries()
}

/// 四个状态源的订阅令牌：STA 源线程存活期内持有（Drop = Unadvise /
/// remove_VisibilityChanged，在该线程的消息循环退出后、CoUninitialize
/// 之前释放）。
struct SourceGuards {
    _start: Option<start::StartWatch>,
    _search: Option<search::ShellViewWatch>,
    _find_in_start: Option<search::ShellViewWatch>,
    _task_view: Option<search::ShellViewWatch>,
}

/// STA 源线程：持有全部 COM/WinRT 状态源对象并跑 `GetMessageW` 泵。
///
/// **为什么必须 STA + 泵**（真机 26200 实证，见会话汇报）：WindowsUdk
/// `IShellViewCoordinator::add_VisibilityChanged` 在 MTA 注册时
/// windowsudk.shellcommon.dll 内部访问冲突（NULL handler 同样崩 → 与
/// sink 实现无关）；STA 线程内订阅返回 S_OK。事件回调经 STA 消息泵
/// 送达 sink → 无界 channel → 引擎线程。AppVisibility 的 Advise 同样
/// 挂在此线程（对齐标杆 worker 线程单 STA 模型）。
fn spawn_sources_thread(tx: Sender<EngineMsg>, gen: u64) {
    // 线程耗尽时 spawn 失败：此前 expect 直接在引擎线程 panic（连锁触发 panic
    // hook）。降级为记日志——没有 shell 源线程只是状态探测不到，不应拖垮引擎。
    if let Err(e) = std::thread::Builder::new()
        .name("tb-shell-sources".into())
        .spawn(move || run_sources(tx, gen))
    {
        log::error!("taskbar: spawn tb-shell-sources failed: {e}");
    }
}

#[cfg(windows)]
fn run_sources(tx: Sender<EngineMsg>, gen: u64) {
    use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, TranslateMessage, MSG,
    };
    // SAFETY: 本线程 COM 初始化与消息循环配对；guards Drop 在循环退出后。
    unsafe {
        let hr = windows::Win32::System::Com::CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() {
            log::warn!("taskbar state sources: CoInitializeEx(STA) failed: {hr}");
            return;
        }
        let guards = SourceGuards {
            _start: start::watch_start(tx.clone()).map_err(warn_source).ok(),
            _search: search::watch_shell_view(
                search::ShellViewKind::Search,
                EngineMsg::search_event,
                tx.clone(),
            )
            .map_err(warn_source)
            .ok(),
            _find_in_start: search::watch_shell_view(
                search::ShellViewKind::FindInStart,
                EngineMsg::find_in_start_event,
                tx.clone(),
            )
            .map_err(warn_source)
            .ok(),
            _task_view: taskview::watch_task_view(tx.clone())
                .map_err(warn_source)
                .ok(),
        };
        register_sources_thread(gen, windows::Win32::System::Threading::GetCurrentThreadId());
        log::info!("taskbar state sources: STA thread pumping (gen {gen})");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        unregister_sources_thread(windows::Win32::System::Threading::GetCurrentThreadId());
        drop(guards);
        windows::Win32::System::Com::CoUninitialize();
        log::info!("taskbar state sources: STA thread exited");
    }
}

#[cfg(not(windows))]
fn run_sources(_tx: Sender<EngineMsg>, _gen: u64) {
    log::info!("taskbar state sources: unsupported platform, skipped");
}

/// 启动状态检测（幂等；由 apply_taskbar_config 链路在模块开启时调用——
/// CORE 空壳阶段可由 INJECT / 手测直接调用）。副作用：顺带幂等拉起
/// win_watcher 消息窗（省电事件的载体；INJECT 合入后其为第一属主）。
pub fn start_state_detection() -> bool {
    start_state_detection_with_output(Arc::new(EmitterOutput))
}

/// 带自定义输出面的启动（手测冒烟用打印型输出；生产恒 [`EmitterOutput`]）。
pub fn start_state_detection_with_output(output: Arc<dyn StateOutput>) -> bool {
    loop {
        if ACTIVE_GEN.load(Ordering::SeqCst) != 0 {
            return false; // 已在跑。
        }
        let gen = NEXT_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        match ACTIVE_GEN.compare_exchange(0, gen, Ordering::SeqCst, Ordering::SeqCst) {
            // 拿到 0→gen 的交换权：本代由我们启动（并发 start 里恰有一个成功）。
            Ok(_) => {
                match std::thread::Builder::new()
                    .name("tb-state".into())
                    .spawn(move || run_engine(output, gen))
                {
                    Ok(_) => return true,
                    Err(e) => {
                        // 引擎线程起不来：把代数位让出去（否则永远"看起来在跑"），
                        // 返回 false 让调用方按未启动处理，而不是 panic。
                        log::error!("taskbar: spawn tb-state failed: {e}");
                        let _ =
                            ACTIVE_GEN.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst);
                        return false;
                    }
                }
            }
            // 已被并发者占位：重读再试（它可能已停，重新抢）。
            Err(_) => continue,
        }
    }
}

/// 停止状态检测（幂等；引擎线程 ≤250ms、源线程随 WM_QUIT 退出）。WM_QUIT 只
/// 投给与被停代际同代的源线程——stop 与紧接的 start 竞态下，新一代的消息泵
/// 不被误杀（T-10）。
pub fn stop_state_detection() {
    let stopped_gen = ACTIVE_GEN.swap(0, Ordering::SeqCst);
    if stopped_gen == 0 {
        return; // 本就没在跑（幂等）。
    }
    win_event::stop();
    let tid = {
        let guard = SOURCES_THREAD.lock().unwrap_or_else(|p| p.into_inner());
        if guard.0 == stopped_gen {
            guard.1
        } else {
            0 // 源线程已换代：不投（新泵不归我们停）。
        }
    };
    if tid != 0 {
        // SAFETY: 向本进程自己创建的线程投递退出消息。
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                tid,
                windows::Win32::UI::WindowsAndMessaging::WM_QUIT,
                windows::Win32::Foundation::WPARAM(0),
                windows::Win32::Foundation::LPARAM(0),
            );
        }
    }
}

fn run_engine(output: Arc<dyn StateOutput>, gen: u64) {
    let co_init = win32::co_init_mta();
    let (tx, rx) = channel::<EngineMsg>();
    *ENGINE_TX.lock().unwrap_or_else(|p| p.into_inner()) = Some((gen, tx.clone()));

    // 四个状态源：STA 源线程（单项失败逐项降级，事件不来即恒 false）；
    // 省电初始值直接投递（事件线由 win_watcher 桥接）。
    spawn_sources_thread(tx.clone(), gen);
    let _ = tx.send(EngineMsg::Battery(battery::initial_battery_saver()));

    // win_watcher（幂等；已由 INJECT 拉起则 no-op）+ 系统事件桥。
    crate::taskbar::win_watcher::start();
    crate::taskbar::win_watcher::register_callback(Arc::new(WatcherBridge { tx: tx.clone() }));

    // WinEvent 线程（WinEventMsg → EngineMsg::Win 的转发小线程）。旧代引擎尚未
    // 退出时 start 会把钩子线程的发送端换绑到本代（不另起线程）；只有线程起不来
    // 才返回 false——此时窗口事件到不了本代，状态只靠轮询源更新，降级不 panic。
    let (win_tx, win_rx) = channel::<WinEventMsg>();
    if !win_event::start(win_tx) {
        log::warn!("taskbar state: win_event start failed; window events degraded (gen {gen})");
    }
    let fwd_tx = tx;
    if let Err(e) = std::thread::Builder::new()
        .name("tb-winevent-fwd".into())
        .spawn(move || {
            while let Ok(msg) = win_rx.recv() {
                if fwd_tx.send(EngineMsg::Win(msg)).is_err() {
                    break;
                }
            }
        })
    {
        // 转发线程起不来：窗口事件到不了引擎（状态只靠轮询源更新），降级不 panic。
        log::error!("taskbar: spawn tb-winevent-fwd failed: {e}");
    }

    let mut engine = Engine::new(output, win32::create_vdm());
    engine.rebuild();
    // 初始态立即输出（不经防抖；后续变化走防抖）。
    engine.evaluate();

    let mut gate = DebounceGate::new(DEBOUNCE);
    log::info!(
        "taskbar state: engine running (monitors={})",
        engine.monitors.len()
    );
    loop {
        if ACTIVE_GEN.load(Ordering::SeqCst) != gen {
            break; // 本代被停（或被新一代顶替）。
        }
        let now = Instant::now();
        let wait = gate.next_wait(now).map(|d| d.min(POLL)).unwrap_or(POLL);
        match rx.recv_timeout(wait) {
            Ok(msg) => {
                if engine.handle(msg) {
                    gate.on_event(Instant::now());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if gate.due(Instant::now()) {
            gate.clear();
            engine.evaluate();
        }
    }
    // 引擎侧 COM（虚拟桌面管理器）先于 CoUninitialize 释放。
    // 只清属于本代的收件箱：新一代已登记自己的 Sender 时不得抹掉。
    {
        let mut guard = ENGINE_TX.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(&*guard, Some((g, _)) if *g == gen) {
            *guard = None;
        }
    }
    drop(engine);
    // 钩子线程的归属：新一代已起（ACTIVE_GEN 已换成新值）时，它经 start() 换绑
    // 归新一代所有，本代退出不得再投 WM_QUIT 误杀（T-10 同型的第三处竞态）。
    // 显式 stop_state_detection 已自行投递 WM_QUIT，此处 ACTIVE_GEN 为 0 亦跳过。
    if ACTIVE_GEN.load(Ordering::SeqCst) == gen {
        win_event::stop();
    }
    if co_init {
        win32::co_uninit();
    }
    // 只清自己持有的代际：stop → 紧接 start 已立起新一代时，运行标志归新一代
    //（T-10：无条件清 0 会把新引擎在下一轮循环就打下线）。
    let _ = ACTIVE_GEN.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst);
    log::info!("taskbar state: engine stopped (gen {gen})");
}

fn warn_source(err: String) -> String {
    log::warn!("taskbar state source unavailable: {err}");
    err
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taskbar::win_event::WinEventMsg;
    use crate::taskbar::window::WindowJudgment;
    use std::sync::mpsc;
    use std::sync::Mutex as StdMutex;

    /* -------- 防抖假时钟 -------- */

    #[test]
    fn debounce_gate_merges_storm_and_fires_once() {
        let mut gate = DebounceGate::new(Duration::from_millis(150));
        let t0 = Instant::now();
        // 无事件不到期。
        assert!(!gate.due(t0));
        assert_eq!(gate.next_wait(t0), None);
        // 风暴：t0 起 10ms 间隔连发 20 个事件（模拟批量开关 20 窗口）。
        for i in 0..20 {
            let now = t0 + Duration::from_millis(10 * i);
            gate.on_event(now);
            // 截止被不断后延，期间从不到期。
            assert!(!gate.due(now), "第 {i} 个事件后不应立即到期");
            assert_eq!(gate.next_wait(now), Some(Duration::from_millis(150)));
        }
        // 最后事件在 t0+190ms，截止 = t0+340ms。
        assert!(!gate.due(t0 + Duration::from_millis(339)));
        assert!(
            gate.due(t0 + Duration::from_millis(340)),
            "最后事件 +150ms 后恰好到期"
        );
        gate.clear();
        assert!(!gate.due(t0 + Duration::from_secs(10)));
    }

    #[test]
    fn debounce_gate_single_event_fires_after_window() {
        let mut gate = DebounceGate::new(Duration::from_millis(150));
        let t0 = Instant::now();
        gate.on_event(t0);
        assert!(!gate.due(t0 + Duration::from_millis(149)));
        assert!(gate.due(t0 + Duration::from_millis(150)));
        // 到期后新事件重新起窗。
        gate.clear();
        let t1 = t0 + Duration::from_secs(2);
        gate.on_event(t1);
        assert!(!gate.due(t1 + Duration::from_millis(149)));
        assert!(gate.due(t1 + Duration::from_millis(150)));
    }

    /* -------- 集合 → StateInputs 组装 -------- */

    fn info(hwnd: isize, class: &str) -> WindowInfo {
        WindowInfo::new(hwnd, class, "t", "p.exe")
    }

    #[test]
    fn assemble_inputs_splits_per_monitor_and_attributions() {
        let mut table = WindowTable::new();
        let j = |hwnd: isize, mon: isize, m: bool, _n: bool| WindowJudgment {
            is_user: true,
            maximised: m,
            minimised: false,
            hmonitor: Some(mon),
            info: info(hwnd, "C"),
        };
        table.insert(1, j(1, 10, true, false));
        table.insert(2, j(2, 10, false, true));
        table.insert(3, j(3, 20, true, false));
        // Z 序：3 > 1 > 2。
        let snap = EngineSnapshot {
            monitors: vec![
                MonitorEntry {
                    hmonitor: 10,
                    slot: 0,
                },
                MonitorEntry {
                    hmonitor: 20,
                    slot: 3,
                },
            ],
            table,
            zorder: vec![3isize, 1, 2, 99],
            fg_info: Some(info(2, "Fg")),
            fg_monitor: Some(10),
            start_monitor: Some(10),
            search_monitor: Some(20),
            find_in_start_monitor: None,
            task_view: true,
            battery_saver: false,
            peek_active: false,
        };
        let inputs = assemble_inputs(&snap);
        assert_eq!(inputs.monitors.len(), 2);
        let m0 = &inputs.monitors[0];
        assert_eq!(m0.maximised.iter().map(|w| w.hwnd).collect::<Vec<_>>(), [1]);
        assert_eq!(m0.normal.iter().map(|w| w.hwnd).collect::<Vec<_>>(), [2]);
        assert_eq!(m0.foreground.as_ref().unwrap().hwnd, 2, "前台在 0 号屏");
        assert!(m0.start_opened && !m0.search_opened);
        let m3 = &inputs.monitors[1];
        assert_eq!(m3.maximised.iter().map(|w| w.hwnd).collect::<Vec<_>>(), [3]);
        assert!(m3.foreground.is_none(), "前台不在 3 号屏 → None");
        assert!(!m3.start_opened && m3.search_opened);
        assert!(inputs.task_view && !inputs.battery_saver && !inputs.peek_active);
    }

    #[test]
    fn assemble_inputs_find_in_start_counts_as_search() {
        let snap = EngineSnapshot {
            monitors: vec![MonitorEntry {
                hmonitor: 7,
                slot: 0,
            }],
            table: WindowTable::new(),
            zorder: vec![],
            fg_info: None,
            fg_monitor: None,
            start_monitor: None,
            search_monitor: None,
            find_in_start_monitor: Some(7),
            task_view: false,
            battery_saver: false,
            peek_active: false,
        };
        let inputs = assemble_inputs(&snap);
        assert!(inputs.monitors[0].search_opened, "FindInStart 也算搜索打开");
    }

    #[test]
    fn assemble_inputs_empty_monitors_is_empty() {
        let inputs = assemble_inputs(&EngineSnapshot {
            monitors: vec![],
            table: WindowTable::new(),
            zorder: vec![],
            fg_info: None,
            fg_monitor: None,
            start_monitor: None,
            search_monitor: None,
            find_in_start_monitor: None,
            task_view: false,
            battery_saver: false,
            peek_active: false,
        });
        assert!(inputs.monitors.is_empty());
        assert_eq!(inputs, StateInputs::default());
    }

    /* -------- 状态源量位翻转（mock：直接驱动 EngineMsg） -------- */

    /// 收集型输出面（mock：直接驱动 EngineMsg 的量位翻转测试用）。
    struct Spy(Arc<StdMutex<Vec<(u32, TaskbarStateKey)>>>);

    impl StateOutput for Spy {
        fn on_state_changed(
            &self,
            slot: u32,
            change: &TaskbarStateChanged,
            _res: &StateResolution,
        ) {
            self.0.lock().unwrap().push((slot, change.active_state));
        }
    }

    /// 测试 spy 记录型（槽位 → 状态键）。
    type SpyLog = StdMutex<Vec<(u32, TaskbarStateKey)>>;

    fn engine_with_spy() -> (Engine, Arc<SpyLog>) {
        let collected = Arc::new(SpyLog::default());
        (
            Engine::new(Arc::new(Spy(collected.clone())), None),
            collected,
        )
    }

    /// 四个状态源量位翻转 + Peek 的去重行为（重复事件不重触发 dirty；
    /// Shell UI 归属查询走真实前台——非 Windows 恒 None，语义一致）。
    #[test]
    fn source_flags_flip_once_and_dedup() {
        let (mut engine, _spy) = engine_with_spy();
        let cases: Vec<(EngineMsg, bool)> = vec![
            (EngineMsg::Battery(true), true),
            (EngineMsg::Battery(true), false),
            (EngineMsg::Battery(false), true),
            (EngineMsg::TaskView(true), true),
            (EngineMsg::TaskView(false), true),
            (EngineMsg::Win(WinEventMsg::Peek(true)), true),
            (EngineMsg::Win(WinEventMsg::Peek(true)), false),
            (EngineMsg::Win(WinEventMsg::Peek(false)), true),
            (EngineMsg::Start(true), true),
            (EngineMsg::Start(true), false),
            (EngineMsg::Search(true), true),
            (EngineMsg::FindInStart(true), true),
            (EngineMsg::FindInStart(false), true),
            (EngineMsg::Rebuild, true),
            (EngineMsg::Reevaluate, true),
        ];
        for (msg, expect_dirty) in cases {
            assert_eq!(engine.handle(msg), expect_dirty, "{msg:?} 的 dirty 判定");
        }
    }

    /// F-6：引擎未运行时 request_reevaluate 安全返回 false（调用方即时基线
    /// 已覆盖，不 panic 不阻塞）。
    #[test]
    fn request_reevaluate_without_engine_is_false() {
        assert!(!request_reevaluate());
    }

    /// 默认配置 enabled=false：evaluate 不输出且清空去重缓存（重开后
    /// 重新对账）。enabled=true 的端到端 emit 由手测脚本覆盖（见汇报）。
    #[test]
    fn evaluate_no_emit_when_disabled() {
        let (mut engine, spy) = engine_with_spy();
        engine.handle(EngineMsg::Battery(true));
        engine.evaluate();
        assert!(spy.lock().unwrap().is_empty(), "关闭时不产生事件");
    }

    /* -------- 事件风暴合并（≤1 次放行 → 每屏至多一条事件） -------- */

    #[test]
    fn storm_of_window_events_yields_single_gate_fire() {
        // 20 个窗口批量开关 = 40 条事件挤进同一防抖窗 → 门只放行一次
        // evaluate → 每屏至多一条 state-changed（验收：≤5 条）。
        let (tx, rx) = mpsc::channel::<EngineMsg>();
        for i in 0..20 {
            let _ = tx.send(EngineMsg::Win(WinEventMsg::Insert(i)));
            let _ = tx.send(EngineMsg::Win(WinEventMsg::Remove(i)));
        }
        let mut gate = DebounceGate::new(DEBOUNCE);
        let t0 = Instant::now();
        let mut handled = 0usize;
        // 真实循环语义：排空队列（风暴全部 on_event 推迟截止）再查到期。
        while let Ok(msg) = rx.try_recv() {
            let _ = msg; // engine.handle 在真实线程执行
            handled += 1;
            gate.on_event(t0);
        }
        assert_eq!(handled, 40);
        assert!(!gate.due(t0), "风暴刚结束不到期");
        assert!(gate.due(t0 + DEBOUNCE), "一个防抖窗后放行一次");
        gate.clear();
        assert!(!gate.due(t0 + DEBOUNCE + Duration::from_secs(1)));
    }

    /* -------- 输出面 trait 约束 -------- */

    #[test]
    fn state_output_is_object_safe_and_callbacks_replaceable() {
        struct Nop;
        impl StateOutput for Nop {
            fn on_state_changed(&self, _slot: u32, _c: &TaskbarStateChanged, _r: &StateResolution) {
            }
        }
        let _o: Arc<dyn StateOutput> = Arc::new(Nop);
        // apply 回调可替换、可清除、默认路径不 panic。
        set_apply_callback(Some(Arc::new(|slot, _res| {
            assert_eq!(slot, 0);
        })));
        notify_apply(
            0,
            &StateResolution {
                state: TaskbarStateKey::Desktop,
                appearance: TaskbarAppearance::default(),
                matched_rule: None,
            },
        );
        set_apply_callback(None);
        notify_apply(
            0,
            &StateResolution {
                state: TaskbarStateKey::Desktop,
                appearance: TaskbarAppearance::default(),
                matched_rule: None,
            },
        );
    }
}

#[cfg(test)]
mod manual_smoke {
    //! 手测冒烟入口（`cargo test --lib manual_smoke -- --ignored --nocapture`）。
    //! 运行后按手测脚本操作（Win / Win+S / Win+Tab / 最大化…），观察
    //! stdout 的 state-changed 行。默认跑 45 秒。
    use super::*;
    use std::sync::Mutex as StdMutex;

    struct PrintOutput(StdMutex<Vec<String>>);

    impl StateOutput for PrintOutput {
        fn on_state_changed(&self, slot: u32, change: &TaskbarStateChanged, res: &StateResolution) {
            let line = format!(
                "[SMOKE] state-changed monitor={slot} state={:?} matched_rule={:?} accent={:?}",
                change.active_state, change.matched_rule, res.appearance.accent
            );
            println!("{line}");
            self.0.lock().unwrap().push(line);
        }
    }

    /// 测试日志器：taskbar 线程日志打到 stdout（源订阅失败/降级可见）。
    struct SmokeLogger;

    impl log::Log for SmokeLogger {
        fn enabled(&self, metadata: &log::Metadata) -> bool {
            metadata.target().contains("taskbar")
        }
        fn log(&self, record: &log::Record) {
            if self.enabled(record.metadata()) {
                println!("[LOG:{}] {}", record.level(), record.args());
            }
        }
        fn flush(&self) {}
    }

    #[test]
    #[ignore = "手动冒烟：需要真人操作键盘触发状态变化"]
    fn taskbar_state_manual_smoke() {
        let _ = log::set_boxed_logger(Box::new(SmokeLogger));
        log::set_max_level(log::LevelFilter::Info);
        // 全部状态开启的配置直接写入 CORE 的 CURRENT_CONFIG（绕过空壳
        // apply 命令；测试结束恢复为 None）。
        let mut cfg = crate::taskbar::TaskbarSettings {
            enabled: true,
            ..Default::default()
        };
        for key in crate::taskbar::TaskbarStateKey::ALL {
            if key.optional() {
                let mut st = cfg.states.get(key).clone();
                st.enabled = Some(true);
                cfg.states.set(key, st);
            }
        }
        *crate::taskbar::CURRENT_CONFIG
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(cfg);

        let spy = Arc::new(PrintOutput(StdMutex::new(Vec::new())));
        assert!(start_state_detection_with_output(spy.clone()));
        println!("[SMOKE] 检测已启动（45s）：按 Win 开/关开始菜单、Win+S 搜索、Win+Tab 任务视图、最大化/还原一个窗口……");
        std::thread::sleep(Duration::from_secs(45));
        stop_state_detection();
        std::thread::sleep(Duration::from_millis(400));
        let events = spy.0.lock().unwrap().len();
        println!("[SMOKE] 结束：共 {events} 条 state-changed");
        *crate::taskbar::CURRENT_CONFIG
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        assert!(events >= 1, "至少应有一条初始状态变化事件");
    }
}
