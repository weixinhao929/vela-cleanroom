//! 设置镜像（`app:settings:v1`）读取与变更通知的单一入口。
//!
//! 此前 super_panel / push_server / double_tap / sysnotify / tray / injector
//! 六处各自复制「acquire read_db → SettingsRepo::get → serde_json 解析 →
//! 容错默认」的样板，默认值与容错各自为政；且配置线程以 2s 周期轮询
//! SQLite 读配置。本模块收敛为：
//!  - [`read_json`]：读镜像并解析为 JSON（失败返回 None，调用方给默认）；
//!  - [`notify_changed`]：写路径（set_setting / 导入 / 重置）落库后调用；
//!  - [`wait_for_change_since`]：Condvar 等待变更（带兜底超时）——镜像线程从
//!    「2s 轮询」变为「变更即醒 + 周期兜底」，生效延迟从最坏 2s 降到即时。

use std::sync::{Condvar, Mutex};
use std::time::Duration;

use tauri::AppHandle;

/// 镜像键（历史线协议；改名需同步 DB 存量行迁移）。
pub const MIRROR_KEY: &str = "app:settings:v1";

/// 变更代数（仅作唤醒用途，不比较值）。
static GENERATION: Mutex<u64> = Mutex::new(0);
static COND: Condvar = Condvar::new();

/// 读镜像并解析为 JSON 值。任何一步失败返回 None（调用方按各自默认容错）。
pub fn read_json(app: &AppHandle) -> Option<serde_json::Value> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let conn = state.read_db.acquire().ok()?;
    let json = crate::repositories::SettingsRepo::get(&conn, MIRROR_KEY).ok()??;
    serde_json::from_str(&json).ok()
}

/// 写路径在镜像落库后调用：唤醒全部等待线程（立即生效）。
/// 中毒锁恢复式获取（与 generation / wait_for_change_since 一致）——
/// 此前 `if let Ok` 在锁中毒时静默跳过，等待线程会睡满兜底周期才重读，
/// 「变更即醒」退化为「最坏兜底超时才醒」。
pub fn notify_changed() {
    let mut g = GENERATION.lock().unwrap_or_else(|p| p.into_inner());
    *g = g.wrapping_add(1);
    COND.notify_all();
}

/// 当前变更代数。等待方的正确顺序：先 `generation()` 取 seen → 读镜像并
/// 处理 → `wait_for_change_since(seen, …)`——变更落在「读取之后、进入等待
/// 之前」的窗口时，等待会因代数已前进而立即返回（missed-wakeup 修复）。
pub fn generation() -> u64 {
    *GENERATION.lock().unwrap_or_else(|p| p.into_inner())
}

/// 等待 `seen` 之后的下一次镜像变更，最多 `timeout`（兜底周期：等待方借此
/// 重读配置，防御漏发通知与外部直写 DB 的情况）。进入时先比对代数：已前进
/// （seen 之后发生过变更）立即返回，不再睡满兜底周期。
pub fn wait_for_change_since(seen: u64, timeout: Duration) {
    let g = GENERATION.lock().unwrap_or_else(|p| p.into_inner());
    if *g != seen {
        return;
    }
    let _ = COND.wait_timeout(g, timeout);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 唤醒语义：notify 后短超时等待立即返回（不睡满）。
    #[test]
    fn notify_wakes_waiter() {
        let start = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let h = std::thread::spawn(move || {
            wait_for_change_since(generation(), Duration::from_secs(10));
            let _ = tx.send(());
        });
        // 给等待线程拿到锁的时间（CI 慢机留 250ms）。
        std::thread::sleep(Duration::from_millis(250));
        notify_changed();
        rx.recv_timeout(Duration::from_secs(2)).expect("应被唤醒");
        h.join().expect("waiter thread");
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    /// missed-wakeup：seen 取走之后、进入等待之前的变更必须立刻可见
    /// （不等兜底超时）。
    #[test]
    fn change_after_seen_returns_immediately() {
        let seen = generation();
        notify_changed();
        let start = std::time::Instant::now();
        wait_for_change_since(seen, Duration::from_secs(10));
        assert!(start.elapsed() < Duration::from_secs(3));
        // 未变更的 seen 则睡满兜底周期（这里用短超时验证阻塞语义）。
        let seen2 = generation();
        let start2 = std::time::Instant::now();
        wait_for_change_since(seen2, Duration::from_millis(150));
        assert!(start2.elapsed() >= Duration::from_millis(140));
    }
}
