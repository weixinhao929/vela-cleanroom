//! presence：用户在场状态统一感知（§4.6，输入空闲感知统一收敛）。
//!
//! 单条 1s 轮询线程合并三类信号：
//!  - 前台全屏检测（原 game.rs 独立线程，全屏游戏/演示接管屏幕）；
//!  - 前台最大化检测（P-占用②：单屏最大化 = 桌面层被完全遮挡）；
//!  - 输入空闲检测（`GetLastInputInfo`，无键鼠输入的持续秒数）。
//!
//! 输出三态 `PresenceState`：`Fullscreen`（优先级最高，含手柄游戏这类
//! 键鼠无输入的场景）> `Idle`（空闲 ≥ [`IDLE_SECS_SAMPLING_PAUSE`]，供降载
//! ）> `Active`。
//!
//! 事件面：
//!  - `presence:state`：状态或 `covered` 翻转时发出 [`PresenceSnapshot`]；
//!    停留在 Idle 期间每 30s 补发一次（idle_secs 持续增长，前端可按自己的
//!    阈值决策且天然自愈——错过一次事件下一拍会重估）。Active/Fullscreen
//!    稳态不重发（covered 稳态同样不重发）。
//!  - `focus:game-paused-entered/exited`：原 game.rs 兼容事件原样保留
//!    （GlobalGamePause / CountdownWidget / WidgetCanvas 既有消费者）。
//!
//! 降载钩子（Rust 侧直接生效，不经前端）：空闲越过阈值时暂停 sys:stats
//! 采样线程与音频频谱采集，恢复输入后续采；与 §4.1 前端可见性门控互补
//! （可见性管"窗口隐藏"，presence 管"窗口可见但人不在"——锁屏/挂机）。
//!
//! P-占用② covered（被遮挡）：前台全屏，或单屏环境的前台最大化，都意味着
//! 桌面小组件层被 100% 盖住——WebView2 不感知窗口遮挡，玻璃模糊与装饰动画
//! 仍会全速合成（实测被最大化窗口盖住时 GPU 进程烧整核）。快照携带
//! `covered=true` 让前端走与空闲装饰降级同款的 fx-off / 降玻璃 / 时钟降频
//! 路径。进入 covered 需连续 [`COVERED_STABLE_TICKS`] 拍稳定（Alt-Tab /
//! Win+D 造成的秒级 Desktop↔Maximized 抖动不触发降级来回翻），退出即时。
//! 多屏只认全屏（另一块屏的桌面层仍可见）；最大化判定用 IsZoomed 管理
//! 态而非几何推断（自动隐藏任务栏的最大化窗 rect 可能够到整屏）。

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 触发 Idle 态与采样降载的无输入秒数。用户可感知的番茄钟打断阈值
/// 由前端设置（默认 5 分钟，且默认关闭）——本阈值只管"没人看也要停采"。
const IDLE_SECS_SAMPLING_PAUSE: u64 = 180;
/// Idle 稳态下补发 `presence:state` 的间隔（秒）。
const IDLE_REEMIT_SECS: u64 = 30;
/// 工作集修剪的首个触发点（秒）：确认人真离开了才动（比停采样更保守，
/// 修剪后回来交互要付一次软缺页换入）。
const IDLE_SECS_MEM_TRIM: u64 = 600;
/// 长挂机期间的重复修剪间隔（秒）。
const MEM_TRIM_INTERVAL_SECS: u64 = 600;
/// 进入 covered 需要的连续稳定拍数（1s/拍）：压过 Desktop↔Maximized 的
/// 秒级抖动，避免降级/恢复来回翻。
const COVERED_STABLE_TICKS: u32 = 3;

/// 三态在场状态。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceState {
    Active,
    Idle,
    Fullscreen,
}

/// 最近一拍 presence 状态（0=Active 1=Idle 2=Fullscreen），供
/// `get_presence_state` 拉取（番茄钟 wait-activity 推进门在事件之外
/// 也需要「此刻是否在场」的一次性判定）。
static LAST_PRESENCE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
/// 最近一拍 covered（P-占用②），供 `get_presence_state` 拉取。
static LAST_COVERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// covered 的纯判定（去抖计数在轮询循环里做）：前台全屏恒遮挡；前台
/// 最大化仅在单屏时等价于全遮挡——多屏另一块屏的桌面层仍可见，不能降。
fn raw_covered(fullscreen: bool, fg_maximized: bool, monitor_count: i32) -> bool {
    fullscreen || (fg_maximized && monitor_count <= 1)
}

/// 显示器数量（SM_CMONITORS）。1s 一拍的廉价查询，不必缓存。
#[cfg(windows)]
fn monitor_count() -> i32 {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CMONITORS};
    // SAFETY: 简单查询。
    unsafe { GetSystemMetrics(SM_CMONITORS) }
}

#[cfg(not(windows))]
fn monitor_count() -> i32 {
    1
}

fn presence_rank(state: PresenceState) -> u8 {
    match state {
        PresenceState::Active => 0,
        PresenceState::Idle => 1,
        PresenceState::Fullscreen => 2,
    }
}

/// Tauri command: 拉取当前在场状态快照（与 `presence:state` 事件载荷同构；
/// process_name/window_title 恒空——该命令只回答「人在不在」，不做隐私枚举）。
/// 补窗口闸门：调用方 app-store 的番茄钟逻辑跑在 widget-* / settings
/// （失败有 catch，闸门不破坏功能）；idle 秒数/遮挡态对低信任窗（web-preview
/// 远程页）属可被滥用的在场探针。
#[tauri::command]
pub fn get_presence_state(window: tauri::Window) -> Result<PresenceSnapshot, String> {
    crate::require_trusted(&window)?;
    let state = match LAST_PRESENCE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => PresenceState::Idle,
        2 => PresenceState::Fullscreen,
        _ => PresenceState::Active,
    };
    let idle = idle_secs();
    let fullscreen = state == PresenceState::Fullscreen;
    Ok(PresenceSnapshot {
        state,
        idle_secs: idle,
        fullscreen,
        covered: LAST_COVERED.load(std::sync::atomic::Ordering::Relaxed),
        process_name: String::new(),
        window_title: String::new(),
    })
}

/// `presence:state` 载荷。
#[derive(Clone, Debug, Serialize)]
pub struct PresenceSnapshot {
    pub state: PresenceState,
    /// 距最近一次键鼠输入的秒数（全屏手柄游戏下会持续增长，属预期）。
    pub idle_secs: u64,
    /// 前台窗口是否全屏（即接管屏幕）。
    pub fullscreen: bool,
    /// 桌面层是否被完全遮挡（P-占用②）：前台全屏，或单屏下的前台最大化
    /// （连续 3 拍稳定后置位，退出即时）。前端据此走空闲装饰降级同款路径。
    pub covered: bool,
    /// 前台进程名（如 game.exe）；取不到为空串。
    pub process_name: String,
    /// 前台窗口标题；取不到为空串。
    pub window_title: String,
}

/// 距最近一次键鼠/其它输入事件的秒数（`GetLastInputInfo`）。
/// 两个计数都是开机毫秒（u32，约 49 天回绕一次），用 wrapping_sub 天然回绕安全。
#[cfg(windows)]
fn idle_secs() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: 传入合法输出缓冲。
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return 0;
    }
    // SAFETY: 简单查询。
    let now = unsafe { GetTickCount() };
    now.wrapping_sub(info.dwTime) as u64 / 1000
}

#[cfg(not(windows))]
fn idle_secs() -> u64 {
    0
}

/// 启动 presence 感知线程（替代 game.rs 的独立全屏 watcher）。
pub fn start_presence_watcher(handle: AppHandle) {
    std::thread::spawn(move || {
        let mut last_state = PresenceState::Active;
        let mut last_fullscreen = false;
        let mut sampling_paused = false;
        let mut idle_reemit_left = IDLE_REEMIT_SECS;
        // 上次修剪时的 idle 秒数（None = 本轮空闲还没修过）。
        let mut last_trim_at: Option<u64> = None;
        // covered 去抖（P-占用②）：连续遮挡拍数与上次发事件的 covered 值。
        let mut covered_stable: u32 = 0;
        let mut last_covered = false;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            // foreground_app / idle_secs 内部是 unsafe FFI；一次 panic 不应杀死
            // 整个感知线程（与原 game watcher 同策略：逐拍兜住，按缺数据处理）。
            let fg =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(crate::game::foreground_app))
                    .unwrap_or_else(|p| {
                        log::error!("presence watcher foreground panic: {}", panic_msg(&p));
                        None
                    });
            let idle = std::panic::catch_unwind(idle_secs).unwrap_or_else(|p| {
                log::error!("presence watcher idle probe panic: {}", panic_msg(&p));
                0
            });
            let fullscreen = fg.as_ref().map(|f| f.is_fullscreen).unwrap_or(false);
            let fg_maximized = fg.as_ref().map(|f| f.is_maximized).unwrap_or(false);
            let state = if fullscreen {
                PresenceState::Fullscreen
            } else if idle >= IDLE_SECS_SAMPLING_PAUSE {
                PresenceState::Idle
            } else {
                PresenceState::Active
            };
            // 每拍记录最新状态：get_presence_state 拉取时无需跨线程通道。
            LAST_PRESENCE.store(presence_rank(state), std::sync::atomic::Ordering::Relaxed);

            // covered（P-占用②）：进入需连续稳定，退出即时；翻转时发事件。
            let want_covered = raw_covered(fullscreen, fg_maximized, monitor_count());
            if want_covered {
                covered_stable = covered_stable.saturating_add(1);
            } else {
                covered_stable = 0;
            }
            let covered = covered_stable >= COVERED_STABLE_TICKS;
            LAST_COVERED.store(covered, std::sync::atomic::Ordering::Relaxed);

            // 兼容事件：全屏进入/退出（原 game.rs 消费者不动）。
            if fullscreen != last_fullscreen {
                last_fullscreen = fullscreen;
                if fullscreen {
                    let _ = handle.emit("focus:game-paused-entered", fg.clone());
                } else {
                    let _ = handle.emit("focus:game-paused-exited", ());
                }
            }

            // 降载钩子：空闲越线暂停 sys:stats / 音频采样；恢复输入立即续采。
            // 全屏不降载（人在用，只是被接管）。
            let want_pause = idle >= IDLE_SECS_SAMPLING_PAUSE && !fullscreen;
            if want_pause != sampling_paused {
                sampling_paused = want_pause;
                if let Some(bc) = handle.try_state::<crate::system::StatsBroadcaster>() {
                    bc.set_paused(want_pause);
                }
                crate::audio::set_spectrum_paused(want_pause);
                log::info!(
                    "presence: {} sampling (idle={idle}s)",
                    if want_pause { "pause" } else { "resume" }
                );
            }

            // 内存钩子（mem_trim.rs）：空闲 ≥10 分钟修剪本进程树 WebView2 的
            // 工作集（任务管理器数字的主要来源），长挂机期间周期性再修。
            // 恢复输入后 `last_trim_at` 复位；换回页由软缺页按需完成，无恢复
            // 动作。修剪枚举/FFI 出错只影响这一拍（函数内部已兜日志）。
            if want_pause {
                let due = match last_trim_at {
                    None => idle >= IDLE_SECS_MEM_TRIM,
                    Some(t) => idle >= t.saturating_add(MEM_TRIM_INTERVAL_SECS),
                };
                if due {
                    last_trim_at = Some(idle);
                    let freed = crate::mem_trim::trim_webview2_working_sets();
                    log::info!("presence: idle working-set trim (~{freed} MB, idle={idle}s)");
                }
            } else {
                last_trim_at = None;
            }

            // 状态或 covered 翻转必发；Idle 稳态每 30s 补发一次（idle_secs 更新）。
            let mut should_emit = state != last_state || covered != last_covered;
            if state == PresenceState::Idle && state == last_state && covered == last_covered {
                idle_reemit_left = idle_reemit_left.saturating_sub(1);
                if idle_reemit_left == 0 {
                    idle_reemit_left = IDLE_REEMIT_SECS;
                    should_emit = true;
                }
            } else {
                idle_reemit_left = IDLE_REEMIT_SECS;
            }
            if should_emit {
                last_state = state;
                last_covered = covered;
                let _ = handle.emit(
                    "presence:state",
                    PresenceSnapshot {
                        state,
                        idle_secs: idle,
                        fullscreen,
                        covered,
                        process_name: fg
                            .as_ref()
                            .map(|f| f.process_name.clone())
                            .unwrap_or_default(),
                        window_title: fg
                            .as_ref()
                            .map(|f| f.window_title.clone())
                            .unwrap_or_default(),
                    },
                );
            }
        }
    });
}

/// 从 catch_unwind 的 payload 里提取可读消息（与 system.rs/game.rs 同款）。
fn panic_msg(p: &Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 状态优先级是纯函数逻辑的核心：全屏 > 空闲 > 活跃。
    #[test]
    fn state_priority_fullscreen_over_idle() {
        let classify = |fullscreen: bool, idle: u64| {
            if fullscreen {
                PresenceState::Fullscreen
            } else if idle >= IDLE_SECS_SAMPLING_PAUSE {
                PresenceState::Idle
            } else {
                PresenceState::Active
            }
        };
        assert_eq!(classify(false, 0), PresenceState::Active);
        assert_eq!(
            classify(false, IDLE_SECS_SAMPLING_PAUSE - 1),
            PresenceState::Active
        );
        assert_eq!(
            classify(false, IDLE_SECS_SAMPLING_PAUSE),
            PresenceState::Idle
        );
        // 手柄游戏：全屏且键鼠无输入 → Fullscreen（不能被误判为 Idle 而停采/打断）。
        assert_eq!(classify(true, 3600), PresenceState::Fullscreen);
    }

    /// 序列化名（前端按字符串判断）：lowercase 枚举名锁定协议。
    #[test]
    fn snapshot_serializes_lowercase_state() {
        let snap = PresenceSnapshot {
            state: PresenceState::Idle,
            idle_secs: 200,
            fullscreen: false,
            covered: false,
            process_name: String::new(),
            window_title: String::new(),
        };
        let json = serde_json::to_string(&snap).expect("serialize");
        assert!(json.contains("\"state\":\"idle\""), "{json}");
        assert!(json.contains("\"idle_secs\":200"), "{json}");
        assert!(json.contains("\"covered\":false"), "{json}");
    }

    /// covered 纯判定（P-占用②）：全屏恒遮挡；最大化仅单屏算遮挡。
    #[test]
    fn covered_single_screen_maximized_or_fullscreen() {
        // 全屏在任何屏数下都遮挡（多屏全屏沿用既有 game-pause 全局语义）。
        assert!(raw_covered(true, false, 1));
        assert!(raw_covered(true, false, 3));
        assert!(raw_covered(true, true, 1));
        // 单屏最大化 = 工作区 + 任务栏把桌面层盖满。
        assert!(raw_covered(false, true, 1));
        assert!(raw_covered(false, true, 0)); // 探测失败的保守值同样按单屏
                                              // 多屏最大化：另一块屏的桌面层仍可见，不能降。
        assert!(!raw_covered(false, true, 2));
        assert!(!raw_covered(false, true, 3));
        // 普通前台不遮挡。
        assert!(!raw_covered(false, false, 1));
        assert!(!raw_covered(false, false, 2));
    }
}
