//! 全局左键监视。
//!
//! 动机：灵动岛展开面（磁贴面板 / 全岛面板）挂在 widget 窗口里，而 widget
//! 窗口对交互矩形之外的区域点击穿透——用户点桌面 / 点别的应用时，点击
//! **永远到不了 webview**，DOM 层的 outside-click 收起无从谈起，面板会一直
//! 挂着直到按 Esc。本模块在「有展开面」期间挂一只低级鼠标钩子：
//!
//! - 只看 WM_LBUTTONDOWN；
//! - 命中点所在根窗口属于**本进程且是「正在记账监视」的窗口**（开着
//!   left-click watch 的那条岛）→ 视为「岛内点击」，交给该窗口 DOM 自己
//!   处理，不发事件；命中根窗口非本进程（桌面 / 画布穿透区 / 其它应用）
//! → 岛外；命中根窗口属本进程但**不是**记账窗口（多屏时另一条岛 /
//!   设置窗 / 速记窗）→ 同样算岛外——A 屏展开的岛对 B 屏的点击也是
//!   「点在别处」，要发事件让记账窗口各自收起；
//! - 岛外 → emit `global:left-down`（广播给全部 widget-N，前端各 DockShell
//!   自己按屏过滤），收起展开面。
//!
//! 「唤醒点击防误收」在 Vela 不适用：收合态的岛靠
//! pointerenter 悬停弹出、不存在「点边缘唤醒」手势，天然没有「唤醒点击落
//! 在可见矩形外」的时序问题——审查结论记录在 DockShell 的收起注释里。
//!
//! 生命周期：命令 `set_global_left_click_watch(enabled, seq)` 由前端在展开面
//! 出现 / 全部收起时切换（seq 为前端单调序号，乱序到达的旧值被丢弃）。
//! 钩子线程首次启用时安装、进程内常驻；启停只翻
//! AtomicBool（关闭期回调直接透传，近零成本），不反复装卸钩子。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

/// 事件名：一次岛外左键按下（无载荷——前端只关心「点了外面」这一事实）。
pub const EVENT_LEFT_DOWN: &str = "global:left-down";

static APP: OnceLock<AppHandle> = OnceLock::new();

/// 某窗口对全局左键监视的最新意图：want = 想看，seq = 发出该意图的前端
/// 单调序号（毫秒级收起→再展开时开/关两条 fire-and-forget IPC 可能乱序
/// 到达，晚发的 false 先落地、后到的旧 true 会把钩子错关——按窗口只采纳
/// 最新 seq 的意图，乱序旧值被丢弃）。
#[derive(Clone, Copy)]
struct WatchIntent {
    want: bool,
    seq: u64,
    /// 注册窗口的原生句柄（Windows 上为 HWND 值；其它平台恒 0）。：钩子
    /// 回调判定「本进程但非记账窗口」时按 HWND 集合比对——label → 窗口对象
    /// 的反查（webview_windows）在回调里是额外锁 + 分配，注册时一次解析存好。
    hwnd: isize,
}

/// 「想看岛外点击」的窗口记账（label → 最新意图）：多屏各有一条岛，A 屏
/// 展开时不能被 B 屏的「全部收起」关掉全局开关——ENABLED = 任一 want。
static WANTERS: Mutex<Option<HashMap<String, WatchIntent>>> = Mutex::new(None);

/// 钩子线程登记：Some = 钩子线程存活期内（含其内部的重试循环）。
/// 装卸都走这把锁，杜绝双钩竞态——参照 double_tap.rs 的 HOOK_THREAD 范式。
/// 此前用 `HOOK_TRIED` AtomicBool：钩子线程在「SetWindowsHookExW 失败 →
/// 复位 TRIED → 退避 sleep → 重试」的循环里，复位后 IPC 侧 install_hook_once
/// 会再 spawn 一只线程，醒来的旧线程继续重试 SetWindowsHookExW——两只
/// WH_MOUSE_LL 同时在链上（重复回调 / 重复卸载交错）。改为线程句柄登记：
/// 线程**整个生命周期**（含重试）占位，只有真正退出前才自摘除，install 期间
/// 恒见 Some，同一时刻至多一只钩子。无人 join 本句柄（常驻模块），线程退出
/// 时自摘除拿锁无死锁面。
static HOOK_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

fn wanters() -> &'static Mutex<Option<HashMap<String, WatchIntent>>> {
    &WANTERS
}

fn refresh_enabled() {
    // poisoned lock 按「全仓惯例」取回内部数据继续——poison 只代表某次
    // 持锁中途 panic，记账 map 本身仍完整可用，不该让开关从此冻结。
    let guard = wanters().lock().unwrap_or_else(|p| p.into_inner());
    let n = guard
        .as_ref()
        .map(|m| m.values().any(|i| i.want))
        .unwrap_or(false);
    drop(guard);
    ENABLED.store(n, Ordering::SeqCst);
}

/// 见模块注释；ENABLED 由 WANTERS 派生（这里保留静态以供钩子回调零锁读取）。
static ENABLED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
mod win {
    use super::*;

    use std::panic::{catch_unwind, AssertUnwindSafe};

    use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetMessageW, GetWindowThreadProcessId,
        SetWindowsHookExW, TranslateMessage, WindowFromPoint, GA_ROOT, HHOOK, MSG, MSLLHOOKSTRUCT,
        WH_MOUSE_LL, WM_APP, WM_LBUTTONDOWN,
    };

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // 钩子回调里只做最廉价的事：开关关着直接透传。
        if !ENABLED.load(Ordering::Acquire) {
            return CallNextHookEx(None, code, wparam, lparam);
        }
        if code >= 0 && wparam.0 as u32 == WM_LBUTTONDOWN {
            // panic 穿越 extern "system" 回调是 UB，对齐 widget.rs hook_proc
            // 的防护——整个处理逻辑包 catch_unwind，任何一处炸都不拖垮系统
            // 输入管线（摘钩 = 全应用的岛外收起一起失效）。
            let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
                let info = lparam.0 as *const MSLLHOOKSTRUCT;
                if !info.is_null() && click_counts_outside((*info).pt) {
                    if let Some(app) = APP.get() {
                        use tauri::Emitter;
                        let _ = app.emit_filter(super::EVENT_LEFT_DOWN, (), |win| match win {
                            tauri::EventTarget::WebviewWindow { label }
                            | tauri::EventTarget::Webview { label }
                            | tauri::EventTarget::Window { label }
                            | tauri::EventTarget::AnyLabel { label } => {
                                label.starts_with("widget-")
                            }
                            _ => false,
                        });
                    }
                }
            }));
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// 本次左键按下对「记账窗口」而言是否算**岛外**（见模块注释的判定表）：
    /// 命中点根窗口非本进程 → 岛外；属本进程但不在记账集合（多屏另一条
    /// 岛 / 设置窗等）→ 同样岛外（对记账窗口而言那次点击也落在「别的窗口」
    /// 上，其 DOM 不会收到任何事件）；只有点在记账窗口本体上才算岛内。
    /// 点击落在 widget 窗口的穿透区时 WindowFromPoint 返回其下的窗口（桌面/
    /// 别的应用）→ 不算记账窗口，语义正好是「岛外」。
    unsafe fn click_counts_outside(pt: POINT) -> bool {
        let hwnd = WindowFromPoint(pt);
        if hwnd.is_invalid() {
            return true;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let target = if root.is_invalid() { hwnd } else { root };
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(target, Some(&mut pid as *mut u32));
        if pid != 0 && pid == GetCurrentProcessId() {
            !wanters_contain_hwnd(target.0 as isize)
        } else {
            true
        }
    }

    /// 命中句柄是否为当前开启左键监视（want=true）的记账窗口之一。锁只在
    /// 按钮按下时拿一次，且记账集合最多显示器条数那么大，量级无害。
    fn wanters_contain_hwnd(hwnd: isize) -> bool {
        wanters()
            .lock()
            .map(|g| {
                g.as_ref()
                    .map(|m| m.values().any(|i| i.want && i.hwnd == hwnd))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// 记账集合里是否仍有窗口想要岛外点击监听（钩子线程退出/安装失败
    /// 时的「内部重建还是真正结束」判据）。
    fn wanters_active() -> bool {
        wanters()
            .lock()
            .map(|g| {
                g.as_ref()
                    .map(|m| m.values().any(|i| i.want))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    pub fn hook_thread() {
        unsafe {
            //泵意外退出（GetMessageW -1）后的内部重建——面板保持展开
            // 时前端不会再发新的 enabled=true，此前恢复依赖用户手动收起再展开。
            // 退出/安装失败时若记账集合仍有需求（任一窗口 want=true），带退避
            // 重装；WM_APP+1 卸载信号或无人需要时才真正结束线程。：重试
            // 全程线程自身占住 HOOK_THREAD 登记位（见该静态的注释），不再通过
            // 复位标志给外部 spawn 让路——那是双钩子的根源。
            let mut backoff = std::time::Duration::from_secs(2);
            loop {
                let hook: HHOOK = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
                    Ok(h) => {
                        backoff = std::time::Duration::from_secs(2);
                        h
                    }
                    Err(e) => {
                        log::warn!("global_input: SetWindowsHookExW(WH_MOUSE_LL) failed: {e}");
                        if !wanters_active() {
                            return;
                        }
                        std::thread::sleep(backoff);
                        backoff = (backoff * 2).min(std::time::Duration::from_secs(60));
                        continue;
                    }
                };
                log::info!("global_input: WH_MOUSE_LL hook installed");

                // 消息泵：低级钩子回调经由本线程的消息循环派发。WM_APP+1 = 卸载信号
                // （当前常驻不卸，保留结构以备退出期清理）。
                let mut msg = MSG::default();
                let mut unload_signalled = false;
                loop {
                    let r = GetMessageW(&mut msg, None, 0, 0);
                    // GetMessageW 出错返回 -1——`!as_bool()` 只拦 0（WM_QUIT），
                    // -1 时 as_bool() 为真，旧判定会拿旧 msg 无限重复派发。对齐
                    // widget.rs 的消息泵：0（退出）与 -1（错误）都跳出循环。
                    if r.0 == 0 || r.0 == -1 {
                        if r.0 == -1 {
                            log::warn!(
                                "global_input: GetMessageW returned -1; hook pump rebuilding"
                            );
                        }
                        break;
                    }
                    if msg.message == WM_APP + 1 {
                        unload_signalled = true;
                        break;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
                log::info!("global_input: hook removed");
                if unload_signalled || !wanters_active() {
                    // 卸载信号 / 无人需要：真正结束线程（退出后由 install 闭包
                    // 自摘除登记，下一次 enabled=true 的 IPC 可重新装）。
                    return;
                }
                // 仍有窗口在等岛外点击：小睡后重装（-1 多为瞬时 pump 故障）。
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
    }
}

fn install_hook_once() {
    // 持锁判位 + spawn 登记（对齐 double_tap::install_hook_once）。
    // 线程在整个生命周期（含失败重试循环）内占位；真正退出前由 spawn 闭包
    // 自摘除，下一次 enabled=true 的 IPC 自然重装——原先「HOOK_TRIED 标志 +
    // 线程中途复位」的组合在复位与重试的窗口里能 spawn 出第二只线程。
    let mut guard = HOOK_THREAD.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        return;
    }
    match std::thread::Builder::new()
        .name("global-mouse-hook".into())
        .spawn(|| {
            #[cfg(windows)]
            win::hook_thread();
            // 线程体结束 = 钩子生命周期结束：从登记表摘除自己，放行下一次
            // 安装。install_hook_once 不做 join（常驻模块、无人请求卸载），
            // 此处拿锁只与瞬时的 install 判位互斥，无死锁面。
            *HOOK_THREAD.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }) {
        Ok(h) => *guard = Some(h),
        Err(e) => log::error!("global_input: failed to spawn hook thread: {e}"),
    }
}

/// 前端在「本窗口出现灵动岛展开面」时调 true、「全部收起」时调 false。
/// 按窗口记账（label → 最新意图，附前端单调 seq 抗 IPC 乱序）：任一窗口
/// 还想看，钩子就保持启用。窗口销毁由 drop_window 兜底清理（热拔显示器
/// 直接 destroy 时前端 cleanup 不会执行）。
#[tauri::command]
pub fn set_global_left_click_watch(
    window: tauri::Window,
    enabled: bool,
    seq: u64,
) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    if enabled {
        // 上次尝试失败（线程已退出并自摘登记）→ install_hook_once 直接
        // 重新 spawn 重试；成功存活的线程幂等跳过。原先在此处复位
        // HOOK_TRIED 的补偿逻辑随该标志一并退役（见 HOOK_THREAD 注释）。
        install_hook_once();
    }
    let label = window.label().to_string();
    // 记账附窗口原生句柄，钩子回调按 HWND 集合判定「本进程但非记账
    // 窗口」（见 WatchIntent.hwnd 注释）。解析失败存 0——恒不匹配任何真实
    // 句柄，退化为「本进程一律算岛内」的旧行为，不会误收起。
    #[cfg(windows)]
    let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let hwnd = 0;
    let mut guard = wanters().lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let stale = map.get(&label).is_some_and(|i| seq < i.seq);
    if !stale {
        map.insert(
            label,
            WatchIntent {
                want: enabled,
                seq,
                hwnd,
            },
        );
    }
    drop(guard);
    refresh_enabled();
    Ok(())
}

/// 窗口销毁时移除其记账（lib.rs RunEvent::Destroyed 调用）。
pub fn drop_window(label: &str) {
    let mut guard = wanters().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(label);
    }
    drop(guard);
    refresh_enabled();
}

/// 进程启动时预埋 AppHandle（钩子回调 emit 用）。
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}
