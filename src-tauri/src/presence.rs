//! presence：用户在场状态统一感知（§4.6，输入空闲感知统一收敛）。
//!
//! 单条 1s 轮询线程合并两类信号：
//!  - 前台全屏检测（原 game.rs 独立线程，全屏游戏/演示接管屏幕）；
//!  - 输入空闲检测（`GetLastInputInfo`，无键鼠输入的持续秒数）。
//!
//! 输出三态 `PresenceState`：`Fullscreen`（优先级最高，含手柄游戏这类
//! 键鼠无输入的场景）> `Idle`（空闲 ≥ [`IDLE_SECS_SAMPLING_PAUSE`，供降载]
//! ）> `Active`。
//!
//! 事件面：
//!  - `presence:state`：状态翻转时发出 [`PresenceSnapshot`]；停留在 Idle 期间
//!    每 30s 补发一次（idle_secs 持续增长，前端可按自己的阈值决策且天然
//!    自愈——错过一次事件下一拍会重估）。Active/Fullscreen 稳态不重发。
//!  - `focus:game-paused-entered/exited`：原 game.rs 兼容事件原样保留
//!    （GlobalGamePause / CountdownWidget / WidgetCanvas 既有消费者）。
//!
//! 降载钩子（Rust 侧直接生效，不经前端）：空闲越过阈值时暂停 sys:stats
//! 采样线程与音频频谱采集，恢复输入后续采；与 §4.1 前端可见性门控互补
//! （可见性管"窗口隐藏"，presence 管"窗口可见但人不在"——锁屏/挂机）。

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

fn presence_rank(state: PresenceState) -> u8 {
    match state {
        PresenceState::Active => 0,
        PresenceState::Idle => 1,
        PresenceState::Fullscreen => 2,
    }
}

/// Tauri command: 拉取当前在场状态快照（与 `presence:state` 事件载荷同构；
/// process_name/window_title 恒空——该命令只回答「人在不在」，不做隐私枚举）。
#[tauri::command]
pub fn get_presence_state() -> PresenceSnapshot {
    let state = match LAST_PRESENCE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => PresenceState::Idle,
        2 => PresenceState::Fullscreen,
        _ => PresenceState::Active,
    };
    let idle = idle_secs();
    let fullscreen = state == PresenceState::Fullscreen;
    PresenceSnapshot {
        state,
        idle_secs: idle,
        fullscreen,
        process_name: String::new(),
        window_title: String::new(),
    }
}

/// `presence:state` 载荷。
#[derive(Clone, Debug, Serialize)]
pub struct PresenceSnapshot {
    pub state: PresenceState,
    /// 距最近一次键鼠输入的秒数（全屏手柄游戏下会持续增长，属预期）。
    pub idle_secs: u64,
    /// 前台窗口是否全屏（即接管屏幕）。
    pub fullscreen: bool,
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
            let state = if fullscreen {
                PresenceState::Fullscreen
            } else if idle >= IDLE_SECS_SAMPLING_PAUSE {
                PresenceState::Idle
            } else {
                PresenceState::Active
            };
            // 每拍记录最新状态：get_presence_state 拉取时无需跨线程通道。
            LAST_PRESENCE.store(presence_rank(state), std::sync::atomic::Ordering::Relaxed);

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

            // 状态翻转必发；Idle 稳态每 30s 补发一次（idle_secs 更新）。
            let mut should_emit = state != last_state;
            if state == PresenceState::Idle && state == last_state {
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
                let _ = handle.emit(
                    "presence:state",
                    PresenceSnapshot {
                        state,
                        idle_secs: idle,
                        fullscreen,
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
            process_name: String::new(),
            window_title: String::new(),
        };
        let json = serde_json::to_string(&snap).expect("serialize");
        assert!(json.contains("\"state\":\"idle\""), "{json}");
        assert!(json.contains("\"idle_secs\":200"), "{json}");
    }
}
