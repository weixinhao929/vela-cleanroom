//! 主进程死亡监视——恢复线 2（被 kill 时的唯一恢复保障）。
//!
//! 管道每次握手成功后 [`retarget`]：经 `GetNamedPipeServerProcessId` 取主进程
//! PID → `OpenProcess(SYNCHRONIZE)` → 独立线程 `WaitForSingleObject(INFINITE)`。
//! 死亡回调：恢复全部任务栏原 Fill（对齐 taskbarappearanceservice.cpp:168-197
//! 与 OnProcessDied :326-338），然后**保持待命**——管道线程按协议「断连 → 恢复
//! 默认并等重连」无限重连（pipe_client.rs），主进程在同一 explorer 会话内重启
//! 时直接复用本副本，不需要也不允许二次注入（注入器侧同哈希即"唤醒"）。
//!
//! 曾有的「800ms 后 FreeLibraryAndExitThread 自卸载 + abort 兜底」已整体删除：
//! 1. 本 DLL 被 XAML Diagnostics pin 住（`DllCanUnloadNow` 恒 S_FALSE），自卸载
//!    只会让服务线程退出、把模块留成"回调活着、服务面死了"的僵尸，主进程重启后
//!    握手 35s 超时 → Failed，直到重启资源管理器；
//! 2. 已入队的 `DispatcherQueueHandler` 是本 DLL 内的 COM 对象，explorer UI
//!    线程繁忙时若模块引用先归零，回调将跳进已卸载代码；
//! 3. `abort()` 运行在 explorer 进程内，等于直接杀死资源管理器。
//!
//! 主进程重启（PID 变化）时以 generation 号让旧等待线程退役，避免
//! CloseHandle 与等待线程的竞争——句柄所有权归等待线程，退役时自释放。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, PROCESS_SYNCHRONIZE};

use crate::protocol::TapMessage;

static GENERATION: AtomicU64 = AtomicU64::new(0);

struct WatchState {
    pid: u32,
    /// 0 = 无活动线程。
    generation: u64,
}

static WATCH: Mutex<WatchState> = Mutex::new(WatchState {
    pid: 0,
    generation: 0,
});

/// 管道握手成功后调用：监视/切换目标主进程。
pub fn retarget(server_pid: u32) {
    if server_pid == 0 || server_pid == unsafe { GetCurrentProcessId() } {
        return;
    }
    let Ok(mut watch) = WATCH.lock() else {
        return;
    };
    if watch.pid == server_pid && watch.generation != 0 {
        return; // 已在监视同一进程。
    }
    let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, server_pid) } {
        Ok(h) => h,
        Err(e) => {
            crate::vlog!("parent_watch: OpenProcess({server_pid}) failed: {e}");
            return;
        }
    };
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    watch.pid = server_pid;
    watch.generation = generation;
    crate::vlog!("parent_watch: watching main pid {server_pid} (gen {generation})");

    let raw = handle; // HANDLE: Copy——失败分支仍可关闭
    let handle = crate::util::SendCell(handle);
    let spawned = std::thread::Builder::new()
        .stack_size(64 * 1024)
        .spawn(move || {
            // 守望线程静默死亡 = 主进程死后任务栏不再自恢复。
            crate::util::run_guarded("parent-watch", move || {
                watch_thread_main(handle, server_pid, generation)
            })
        });
    if spawned.is_err() {
        // 线程起不来：释放句柄，放弃监视（管道断连路径仍能恢复）。
        let _ = unsafe { CloseHandle(raw) };
        watch.generation = 0;
    }
}

/// 线程入口（函数边界阻断闭包对句柄字段的精确捕获）。
fn watch_thread_main(handle: crate::util::SendCell<HANDLE>, pid: u32, generation: u64) {
    wait_and_restore(handle.0, pid, generation)
}

fn wait_and_restore(handle: HANDLE, pid: u32, generation: u64) {
    use windows::Win32::System::Threading::WaitForSingleObject;
    let waited = unsafe { WaitForSingleObject(handle, u32::MAX) };
    // INFINITE = u32::MAX；返回即死亡（或错误）。
    let _ = waited;
    let _ = unsafe { CloseHandle(handle) };

    // 退役判定：generation 已被更新的 retarget 顶掉 → 静默退出。
    let Ok(mut watch) = WATCH.lock() else {
        return;
    };
    if watch.generation != generation {
        return;
    }
    // 目标已死：清空监视位，让下一次握手（同 PID 复用极罕见，但新 PID 一定
    // 会）重新 retarget。
    watch.generation = 0;
    watch.pid = 0;
    drop(watch);

    crate::vlog!("parent_watch: main process {pid} died, restoring all taskbars and standing by");
    let _ = crate::util::guarded("death restore", || {
        // Dispatcher 投递（每任务栏各自 UI 线程）。管道读线程几乎同时感知
        // 断连并再投一次 RestoreAll——幂等无害，这里是即时兜底。
        crate::appearance::dispatch(TapMessage::RestoreAll);
        Ok(())
    });
    // 不停服、不自卸载（见模块文档）：管道线程继续等新主进程建同名管道。
}
