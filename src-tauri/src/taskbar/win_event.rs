//! WinEvent 钩子线程（TB-STATE 感知层的事件入口，标杆
//! taskbarattributeworker.cpp:1239-1270 钩子清单的 Rust 对应物）。
//!
//! 独立线程跑 `GetMessageW` 循环（`WINEVENT_OUTOFCONTEXT` 的交付要求），
//! 挂九段 `SetWinEventHook`：PEEK(0x21/0x22)、CLOAK/UNCLOAK、
//! MINIMIZESTART/END、SHOW/HIDE、CREATE/DESTROY、FOREGROUND、REORDER、
//! LOCATIONCHANGE、NAMECHANGE（标杆另挂 PARENTCHANGE，Vela 检测面未用，
//! 不挂）。回调只处理 `idObject==OBJID_WINDOW && idChild==CHILDID_SELF`，
//! 经 std mpsc（无界、send 不阻塞）投给状态机线程——**回调内绝不泵消息、
//! 绝不加锁后再调 Win32 查询**。
//!
//! Shell_TrayWnd / Shell_SecondaryTrayWnd 的 CREATE/DESTROY 转发：
//! 标杆 OnWindowCreateDestroy :97-135 据此 ResetState。win_watcher.rs 归
//! CORE 冻结（`SystemEventCallback` 只有 `on_taskbar_created` 一个任务栏
//! 生命周期口），故此处提供同款风格的独立注册表
//! [`register_tray_window_callback`]，INJECT 一行注册即可吃到 WinEvent 侧
//! 的建/毁事件；本会话自身消费 TrayCreated/TrayDestroyed 做全量重建。

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::{mpsc::Sender, Arc, Mutex};

/// Shell 任务栏窗口类名（主任务栏）。
pub const TRAY_CLASS: &str = "Shell_TrayWnd";
/// 副显示器任务栏窗口类名。
pub const SECONDARY_TRAY_CLASS: &str = "Shell_SecondaryTrayWnd";

/// 未公开事件常量（Common\undoc\winuser.hpp）。
pub const EVENT_SYSTEM_PEEKSTART: u32 = 0x0021;
pub const EVENT_SYSTEM_PEEKEND: u32 = 0x0022;

/// WinEvent → 状态机线程的消息（原始事件语义，不含任何 Win32 查询结果；
/// 查询在状态机线程做，保证回调轻）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinEventMsg {
    /// 窗口应重新判定归属（SHOW/UNCLOAK/MINIMIZEEND/REORDER/
    /// LOCATIONCHANGE/NAMECHANGE/非任务栏 CREATE）。
    Insert(isize),
    /// 窗口应移出全部集合（HIDE/CLOAK/MINIMIZESTART/DESTROY）。
    Remove(isize),
    /// 前台窗口变化。
    Foreground(isize),
    /// Aero Peek 进入/退出（直接置 peek_active）。
    Peek(bool),
    /// 任务栏窗口创建（explorer（重）启动 / 新副屏任务栏）。
    TrayCreated(isize),
    /// 任务栏窗口销毁。
    TrayDestroyed(isize),
}

/// 任务栏窗口生命周期回调（Shell_TrayWnd/Shell_SecondaryTrayWnd 的
/// CREATE/DESTROY 转发；默认空实现，INJECT 消费）。回调在状态机线程
/// 执行且被 `catch_unwind` 隔离：不得阻塞、不得 panic 外溢。
pub trait TrayWindowEventCallback: Send + Sync + 'static {
    fn on_tray_window_created(&self, hwnd: isize) {
        let _ = hwnd;
    }
    fn on_tray_window_destroyed(&self, hwnd: isize) {
        let _ = hwnd;
    }
}

static TRAY_CALLBACKS: Mutex<Vec<Arc<dyn TrayWindowEventCallback>>> = Mutex::new(Vec::new());

/// 注册任务栏窗口生命周期回调（任意时刻）。
pub fn register_tray_window_callback(cb: Arc<dyn TrayWindowEventCallback>) {
    TRAY_CALLBACKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(cb);
}

/// 派发任务栏窗口生命周期事件到已注册回调（状态机线程在完成自身重建后
/// 调用；panic 隔离）。
pub(crate) fn dispatch_tray_event(created: bool, hwnd: isize) {
    let callbacks = TRAY_CALLBACKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    for cb in callbacks {
        let f = || {
            if created {
                cb.on_tray_window_created(hwnd);
            } else {
                cb.on_tray_window_destroyed(hwnd);
            }
        };
        if catch_unwind(AssertUnwindSafe(f)).is_err() {
            log::error!("taskbar win_event: tray callback panicked");
        }
    }
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static THREAD_ID: AtomicU32 = AtomicU32::new(0);
static OUT: Mutex<Option<Sender<WinEventMsg>>> = Mutex::new(None);
/// 发送端换绑纪元：每次 start()（首次绑定或旧线程在跑时换绑到新一代）递增。
/// 与 QUIT_GEN 配合解决 stop → 紧接 start 的竞态：退出令牌（WM_QUIT）投出后
/// 若又发生换绑，钩子线程已归新一代所有，收到该令牌时吞掉继续服务而不退出。
static BIND_GEN: AtomicU64 = AtomicU64::new(0);
/// 最近一次 stop() 投递 WM_QUIT 时的换绑纪元。
static QUIT_GEN: AtomicU64 = AtomicU64::new(0);
/// 已知任务栏窗口名单（CREATE 时按类名登记）。DESTROY 事件里窗口可能已
/// 失效、无法查类名，靠这份名单转成 TrayDestroyed；名单不播种——先于本
/// 进程存在的任务栏窗口直到 explorer 重启 / 拔屏才会有生命周期事件，
/// 前者由新 CREATE 触发、后者由 WM_DISPLAYCHANGE 兜底，均能到达重建。
static KNOWN_TRAY: Mutex<Vec<isize>> = Mutex::new(Vec::new());

/// 启动 WinEvent 钩子线程；已启动返回 false。`tx` 为状态机线程的接收端
/// 对应发送端（状态机线程 owns 接收端）。非 Windows 恒 false。
pub fn start(tx: Sender<WinEventMsg>) -> bool {
    imp::start(tx)
}

/// 请求钩子线程退出（向其投递 WM_QUIT；钩子随线程销毁自动摘除）。
pub fn stop() {
    imp::stop();
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::Sender;

    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetClassNameW, GetMessageW, PostThreadMessageW, TranslateMessage,
        CHILDID_SELF, EVENT_OBJECT_CLOAKED, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY,
        EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_NAMECHANGE,
        EVENT_OBJECT_REORDER, EVENT_OBJECT_SHOW, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, MSG, OBJID_WINDOW,
        WINEVENT_OUTOFCONTEXT, WM_QUIT,
    };

    use super::{
        WinEventMsg, BIND_GEN, EVENT_SYSTEM_PEEKEND, EVENT_SYSTEM_PEEKSTART, KNOWN_TRAY, OUT,
        QUIT_GEN, RUNNING, SECONDARY_TRAY_CLASS, THREAD_ID, TRAY_CLASS,
    };

    pub fn start(tx: Sender<WinEventMsg>) -> bool {
        if RUNNING.swap(true, Ordering::SeqCst) {
            // 已有钩子线程在跑（旧代引擎尚未退出，或旧 stop 的 WM_QUIT 还没被处理）：
            // 不另起线程，只把发送端换绑到新一代，事件立即流向新引擎；换绑纪元
            // 递增，run 循环据此把此前投出的退出令牌视为已被顶替（见 run）。
            *OUT.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
            BIND_GEN.fetch_add(1, Ordering::SeqCst);
            log::info!("taskbar win_event: rebound to a new engine generation");
            return true;
        }
        if let Err(e) = std::thread::Builder::new()
            .name("tb-winevent".into())
            .spawn(move || run(tx))
        {
            // spawn 失败要把 RUNNING 让回去，否则以后永远"已在运行"却没有线程。
            log::error!("taskbar: spawn tb-winevent failed: {e}");
            RUNNING.store(false, Ordering::SeqCst);
            return false;
        }
        true
    }

    pub fn stop() {
        let tid = THREAD_ID.load(Ordering::SeqCst);
        if tid != 0 {
            // 记下退出令牌对应的换绑纪元：之后若又有 start() 换绑，run 循环收到
            // 该令牌时发现纪元已前进 → 线程已归新一代，吞掉令牌继续服务。
            QUIT_GEN.store(BIND_GEN.load(Ordering::SeqCst), Ordering::SeqCst);
            // SAFETY: 向本进程自己创建的线程投递退出消息。
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }

    fn send(msg: WinEventMsg) {
        // 无界通道 send 不阻塞；不持锁做任何 Win32 调用。
        if let Some(tx) = OUT.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let _ = tx.send(msg);
        }
    }

    /// 钩子回调（本线程消息循环内派发）。只做分类与轻查询（类名读取），
    /// 查询窗口状态的工作全部交给状态机线程。
    unsafe extern "system" fn win_event_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if id_object != OBJID_WINDOW.0 || id_child != CHILDID_SELF as i32 {
            return;
        }
        let raw = hwnd.0 as isize;
        match event {
            EVENT_SYSTEM_PEEKSTART => send(WinEventMsg::Peek(true)),
            EVENT_SYSTEM_PEEKEND => send(WinEventMsg::Peek(false)),
            EVENT_OBJECT_CLOAKED | EVENT_OBJECT_HIDE | EVENT_SYSTEM_MINIMIZESTART => {
                send(WinEventMsg::Remove(raw))
            }
            EVENT_OBJECT_UNCLOAKED
            | EVENT_OBJECT_SHOW
            | EVENT_SYSTEM_MINIMIZEEND
            | EVENT_OBJECT_REORDER
            | EVENT_OBJECT_LOCATIONCHANGE
            | EVENT_OBJECT_NAMECHANGE => send(WinEventMsg::Insert(raw)),
            EVENT_SYSTEM_FOREGROUND => send(WinEventMsg::Foreground(raw)),
            EVENT_OBJECT_CREATE => {
                // 任务栏窗口创建 → 全量重建 + 转发；其余按普通窗口判定。
                if is_tray_class(hwnd) {
                    KNOWN_TRAY
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(raw);
                    send(WinEventMsg::TrayCreated(raw));
                } else {
                    send(WinEventMsg::Insert(raw));
                }
            }
            EVENT_OBJECT_DESTROY => {
                // 事件异步：窗口可能已失效，绝不查询，只按句柄处理；
                // 在名单中 = 任务栏窗口销毁（转发 + 全量重建），否则普通移除。
                let was_tray = {
                    let mut known = KNOWN_TRAY.lock().unwrap_or_else(|p| p.into_inner());
                    match known.iter().position(|&h| h == raw) {
                        Some(i) => {
                            known.swap_remove(i);
                            true
                        }
                        None => false,
                    }
                };
                if was_tray {
                    send(WinEventMsg::TrayDestroyed(raw));
                } else {
                    send(WinEventMsg::Remove(raw));
                }
            }
            _ => {}
        }
    }

    /// 类名是否任务栏窗口（GetClassNameW 不发消息，回调内安全）。
    fn is_tray_class(hwnd: HWND) -> bool {
        let mut buf = [0u16; 64];
        // SAFETY: 只读类名（全局原子表/desktop heap），不向窗口发消息。
        let n = unsafe { GetClassNameW(hwnd, &mut buf) };
        if n <= 0 {
            return false;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let class = String::from_utf16_lossy(&buf[..end]);
        class == TRAY_CLASS || class == SECONDARY_TRAY_CLASS
    }

    /// 挂一段钩子；失败记警告不致命（对应事件面失明，其余仍工作）。
    fn hook_range(min: u32, max: u32, name: &str) {
        // SAFETY: 回调为纯静态函数；WINEVENT_OUTOFCONTEXT 常驻本线程。
        let hook = unsafe {
            SetWinEventHook(
                min,
                max,
                None,
                Some(win_event_proc),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.is_invalid() {
            log::warn!("taskbar win_event: SetWinEventHook({name}) failed");
        }
        // 钩子句柄存活到线程退出（不 UnhookWinEventHook：线程销毁时
        // 系统自动清理；句柄保活无需显式持有——返回值仅用于失败检测）。
    }

    fn run(tx: Sender<WinEventMsg>) {
        *OUT.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
        BIND_GEN.fetch_add(1, Ordering::SeqCst);
        // SAFETY: 查询本线程 id（纯查询）。
        THREAD_ID.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
        // SAFETY: 本线程自有消息循环；钩子与循环同生命周期。
        unsafe {
            hook_range(EVENT_SYSTEM_PEEKSTART, EVENT_SYSTEM_PEEKEND, "PEEK");
            hook_range(
                EVENT_OBJECT_CLOAKED,
                EVENT_OBJECT_UNCLOAKED,
                "CLOAK/UNCLOAK",
            );
            hook_range(
                EVENT_SYSTEM_MINIMIZESTART,
                EVENT_SYSTEM_MINIMIZEEND,
                "MINIMIZE START/END",
            );
            hook_range(EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE, "SHOW/HIDE");
            hook_range(EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, "CREATE/DESTROY");
            hook_range(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                "FOREGROUND",
            );
            hook_range(EVENT_OBJECT_REORDER, EVENT_OBJECT_REORDER, "REORDER");
            hook_range(
                EVENT_OBJECT_LOCATIONCHANGE,
                EVENT_OBJECT_NAMECHANGE,
                "LOCATIONCHANGE/NAMECHANGE",
            );
            log::info!("taskbar win_event: hooks installed");
            loop {
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                // 收到 WM_QUIT。若该退出令牌投出之后又发生过换绑（stop → 紧接
                // start：新一代已把发送端换成自己的），本线程已归新一代所有——
                // 吞掉令牌继续泵消息，钩子仍在，无需重装。
                if BIND_GEN.load(Ordering::SeqCst) != QUIT_GEN.load(Ordering::SeqCst) {
                    log::info!("taskbar win_event: quit superseded by rebind; keep serving");
                    continue;
                }
                break;
            }
        }
        *OUT.lock().unwrap_or_else(|p| p.into_inner()) = None;
        KNOWN_TRAY.lock().unwrap_or_else(|p| p.into_inner()).clear();
        THREAD_ID.store(0, Ordering::SeqCst);
        RUNNING.store(false, Ordering::SeqCst);
        log::info!("taskbar win_event: thread exited");
    }
}

#[cfg(not(windows))]
mod imp {
    use std::sync::mpsc::Sender;

    use super::WinEventMsg;

    pub fn start(_tx: Sender<WinEventMsg>) -> bool {
        log::info!("taskbar win_event: unsupported platform, skipped");
        false
    }

    pub fn stop() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TrayCounter {
        created: AtomicUsize,
        destroyed: AtomicUsize,
    }

    impl TrayWindowEventCallback for TrayCounter {
        fn on_tray_window_created(&self, _hwnd: isize) {
            self.created.fetch_add(1, Ordering::SeqCst);
        }
        fn on_tray_window_destroyed(&self, _hwnd: isize) {
            self.destroyed.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn tray_callbacks_dispatch_with_panic_isolation() {
        struct Panicky;
        impl TrayWindowEventCallback for Panicky {
            fn on_tray_window_created(&self, _: isize) {
                panic!("boom");
            }
        }
        let counter = Arc::new(TrayCounter {
            created: AtomicUsize::new(0),
            destroyed: AtomicUsize::new(0),
        });
        register_tray_window_callback(Arc::new(Panicky));
        register_tray_window_callback(counter.clone());
        dispatch_tray_event(true, 0x1234);
        dispatch_tray_event(false, 0x1234);
        assert_eq!(counter.created.load(Ordering::SeqCst), 1);
        assert_eq!(counter.destroyed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn peek_constants_match_undoc_winuser() {
        assert_eq!(EVENT_SYSTEM_PEEKSTART, 0x0021);
        assert_eq!(EVENT_SYSTEM_PEEKEND, 0x0022);
    }

    #[test]
    fn tray_class_names_match_benchmark() {
        assert_eq!(TRAY_CLASS, "Shell_TrayWnd");
        assert_eq!(SECONDARY_TRAY_CLASS, "Shell_SecondaryTrayWnd");
    }
}
