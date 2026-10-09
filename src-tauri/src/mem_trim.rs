//! 空闲期 WebView2 子进程工作集修剪（内存优化第三阶段）。
//!
//! 问题：任务管理器里 WebView2 各进程的工作集（= 显示的"内存"列）含大量
//! 可丢弃页（堆缓存、合成纹理缓存、解码位图）。系统内存紧张时 Windows
//! 会自行回收，但平时它们一直挂在进程上——桌面挂件层 95% 的时间没人看，
//! 却显示 700MB+，观感与实际资源压力都不划算。
//!
//! 手法：presence 判定用户离开（无键鼠输入 ≥ [`crate::presence`] 的修剪
//! 阈值）时，对本应用名下**全部** msedgewebview2 子进程调用
//! `SetProcessWorkingSetSizeEx(h, -1, -1, 0)`（文档等价 `EmptyWorkingSet`），
//! 把工作集整页交还 OS（页进 pagefile/待机列表，进程再访问时软缺页换回）。
//! 回来操作时无需任何恢复动作——按需换页即可。
//!
//! 边界：
//! - 只修剪**本进程树**的 msedgewebview2（沿父链追溯到 focus-desk.exe），
//!   系统其它 WebView2 宿主（如 SearchHost 小组件）绝不触碰；
//! - 空闲修剪后仍持续空闲则周期性再修（长挂机期间后台心跳/采样都已停，
//!   再累积很慢，10 分钟一拍足够）；
//! - 修剪瞬间下一次交互会有一次软缺页换入（毫秒级，人离开 10 分钟后才
//!   发生，无感知）。

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Memory::{
    SetProcessWorkingSetSizeEx, SETPROCESSWORKINGSETSIZEEX_FLAGS,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
};

/// 单次修剪：枚举本进程树的全部 msedgewebview2.exe 并清空其工作集。
///
/// @returns 释放的兆字节数（修剪前后工作集差值合计；0 = 没有可修的或全
///          部失败——调用方据此决定日志级别，不作为错误）。
#[cfg(windows)]
pub fn trim_webview2_working_sets() -> u64 {
    let mine = std::process::id();
    // 快照 → pid → (name, ppid) 映射；失败只意味着这一拍不修，下次再试。
    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(h) => h,
        Err(e) => {
            log::warn!("mem trim: snapshot failed: {e}");
            return 0;
        }
    };
    let mut map: std::collections::HashMap<u32, (u32, String)> = std::collections::HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: 按 dwSize 约定传入已初始化的结构体，逐条迭代。
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            map.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));
            // SAFETY: 同上。
            if !unsafe { Process32NextW(snapshot, &mut entry) }.is_ok() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };

    // 只保留父链能追溯到本进程的 msedgewebview2（跳过其它宿主的树）。
    let is_ours = |pid: u32| -> bool {
        let mut cur = pid;
        for _ in 0..16 {
            match map.get(&cur) {
                Some(&(ppid, ref name)) => {
                    if ppid == mine && name.eq_ignore_ascii_case("msedgewebview2.exe") {
                        return true;
                    }
                    cur = ppid;
                }
                None => return false,
            }
        }
        false
    };

    let mut freed: u64 = 0;
    let mut trimmed = 0u32;
    for &pid in map.keys() {
        if !is_ours(pid) {
            continue;
        }
        // SAFETY: 按权限打开目标进程；句柄用后即关。
        let Ok(handle) = (unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
        }) else {
            continue;
        };
        let before = working_set_mb(handle);
        // SAFETY: (SIZE_T::MAX, SIZE_T::MAX) 是文档化的 EmptyWorkingSet 等价形式。
        let ok = unsafe {
            SetProcessWorkingSetSizeEx(
                handle,
                usize::MAX,
                usize::MAX,
                SETPROCESSWORKINGSETSIZEEX_FLAGS(0),
            )
        }
        .is_ok();
        if ok {
            let after = working_set_mb(handle);
            freed += before.saturating_sub(after);
            trimmed += 1;
        }
        let _ = unsafe { CloseHandle(handle) };
    }
    if trimmed > 0 {
        log::info!("mem trim: {trimmed} webview2 process(es), ~{freed} MB returned");
    }
    freed
}

/// 进程当前工作集（MB）；查询失败返回 0（差值按 0 计，不误报）。
#[cfg(windows)]
fn working_set_mb(handle: HANDLE) -> u64 {
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    // SAFETY: 传入按 cb 约定初始化的输出缓冲。
    if unsafe { GetProcessMemoryInfo(handle, &mut counters, counters.cb) }.is_ok() {
        counters.WorkingSetSize as u64 / (1024 * 1024)
    } else {
        0
    }
}

#[cfg(not(windows))]
pub fn trim_webview2_working_sets() -> u64 {
    0
}
