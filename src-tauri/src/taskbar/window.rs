//! 用户窗口判定与每显示器窗口集合（状态感知层的窗口事实源）。
//!
//! - [`is_user_window`]：七条件——可见 ∧
//!   无 TOOLWINDOW ∧ 未 cloaked(DWMWA_CLOAKED) ∧ 顶层 ∧ 非 NOACTIVATE 或有
//!   APPWINDOW ∧ 在当前虚拟桌面；外加 CoreWindow 排除（前置跳过
//!   Windows.UI.Core.CoreWindow，那是 shell 自身 UI）。
//! - [`WindowTable`]：按 hwnd 维护 maximised/normal 两类归属（集合转移语义），**纯数据结构**，
//!   与 Win32 调用解耦以便单测状态转移表。
//!
//! **重入防御**：`IsWindowOnCurrentVirtualDesktop`
//! 会泵消息。本层约定：[`judge_window`] 先收集窗口快照再逐条判定，虚拟桌面
//! 查询永远放在最后一步；调用方（状态机线程独占持有 [`WindowTable`]）在
//! 判定期间不持任何锁——钩子回调在独立 WinEvent 线程经 channel 投递，不
//! 会重入本线程的数据结构。

use std::collections::HashMap;

use crate::taskbar::WindowInfo;

/// 虚拟桌面管理器类型（Win32 = IVirtualDesktopManager；非 Windows 占位）。
#[cfg(windows)]
pub type DesktopManager = Option<windows::Win32::UI::Shell::IVirtualDesktopManager>;
#[cfg(not(windows))]
pub type DesktopManager = Option<()>;

/// Windows.UI.Core.CoreWindow：shell 自身 UI（开始 / 搜索宿主等）
/// —— 永不算用户窗口。
pub const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

/// 单窗口一次判定的完整快照。`is_user=false` 时其余字段仅供参考。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowJudgment {
    pub is_user: bool,
    pub maximised: bool,
    pub minimised: bool,
    /// 所属显示器（`MonitorFromWindow`，`MONITOR_DEFAULTTONULL` 语义；
    /// 找不到 = None）。
    pub hmonitor: Option<isize>,
    pub info: WindowInfo,
}

/* ---------------- Win32 查询层（仅 Windows） ---------------- */

/// 查询窗口基础信息（类名 / 标题 / 进程名）。窗口失效返回 None。
/// 进程名 = 可执行文件名（含扩展名、不含路径）；打开进程失败按空串
/// （匹配语义为大小写不敏感精确，空串恒不匹配，安全降级）。
#[cfg(windows)]
pub fn window_info(hwnd: isize) -> Option<WindowInfo> {
    win::window_info(hwnd)
}

#[cfg(not(windows))]
pub fn window_info(_hwnd: isize) -> Option<WindowInfo> {
    None
}

/// 窗口是否 cloaked（DWMWA_CLOAKED ≠ 0；UWP 挂起 / 他虚拟桌面窗口）。
#[cfg(windows)]
pub fn window_cloaked(hwnd: isize) -> bool {
    win::window_cloaked(hwnd)
}

/// 七条件判定 + CoreWindow 排除 + 忽略列表过滤（命中忽略列表的
/// 窗口不进集合；[`crate::taskbar::resolve_active_state`] 内部会再过滤一次，
/// 两层过滤幂等）。`vdm` 为懒创建的 IVirtualDesktopManager（None = COM
/// 不可用，虚拟桌面条件按 false 处理）。
///
/// 判定顺序刻意安排：**廉价且不泵消息的检查在前，虚拟桌面查询（会泵）
/// 永远最后**——前六条任一不满足就不碰 COM。
#[cfg(windows)]
pub fn judge_window(
    hwnd: isize,
    ignored: &crate::taskbar::TaskbarIgnoredWindows,
    vdm: &DesktopManager,
) -> WindowJudgment {
    win::judge(hwnd, ignored, vdm)
}

/// 前台窗口句柄（0 = 无）。
#[cfg(windows)]
pub fn foreground_hwnd() -> isize {
    win::foreground_hwnd()
}

#[cfg(windows)]
mod win {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONULL};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::IVirtualDesktopManager;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, GA_ROOT,
        GWL_EXSTYLE, WINDOW_EX_STYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    use super::{WindowJudgment, CORE_WINDOW_CLASS};
    use crate::taskbar::{is_ignored, TaskbarIgnoredWindows, WindowInfo};

    fn to_hwnd(hwnd: isize) -> HWND {
        HWND(hwnd as *mut _)
    }

    fn wide_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    pub fn window_info(hwnd: isize) -> Option<WindowInfo> {
        // SAFETY: 只读查询；句柄先验证，失效立即返回。
        unsafe {
            let h = to_hwnd(hwnd);
            if !IsWindow(Some(h)).as_bool() {
                return None;
            }
            let mut class = [0u16; 128];
            let n = GetClassNameW(h, &mut class);
            let class = if n > 0 {
                wide_to_string(&class[..n as usize])
            } else {
                String::new()
            };
            let mut title = [0u16; 256];
            let t = GetWindowTextW(h, &mut title);
            let title = if t > 0 {
                wide_to_string(&title[..t as usize])
            } else {
                String::new()
            };
            Some(WindowInfo::new(hwnd, &class, &title, &process_name(h)))
        }
    }

    /// 进程可执行文件名（无路径）。GetWindowThreadProcessId + OpenProcess +
    /// QueryFullProcessImageNameW；任一步失败回空串（匹配恒不命中，安全）。
    /// OpenProcess 失败（提权窗口/UWP 宿主）时打一次 debug 日志——空串
    /// 会让 process 规则/忽略静默失效，排障时这是唯一线索。
    fn process_name(hwnd: HWND) -> String {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return String::new();
            }
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                log::debug!(
                    "taskbar state: OpenProcess(pid={pid}) 失败（提权窗口？），进程名回空，process 规则/忽略对该窗口不生效"
                );
                return String::new();
            };
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let name = if QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok()
            {
                wide_to_string(&buf[..len as usize])
            } else {
                String::new()
            };
            let _ = windows::Win32::Foundation::CloseHandle(process);
            // 只要文件名：rsplit 一次取尾段。
            name.rsplit(['\\', '/'])
                .next()
                .unwrap_or_default()
                .to_string()
        }
    }

    pub fn window_cloaked(hwnd: isize) -> bool {
        // SAFETY: DWM 只读属性查询，输出 4 字节 u32。
        unsafe {
            let mut cloaked: u32 = 0;
            match DwmGetWindowAttribute(
                to_hwnd(hwnd),
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            ) {
                Ok(()) => cloaked != 0,
                Err(_) => false,
            }
        }
    }

    /// 七条件。顺序：先做不泵消息的检查，
    /// `IsWindowOnCurrentVirtualDesktop` 最后。
    pub fn judge(
        hwnd: isize,
        ignored: &TaskbarIgnoredWindows,
        vdm: &Option<IVirtualDesktopManager>,
    ) -> WindowJudgment {
        // 1. 有效 + 基础信息快照（后续所有判定都基于这份快照，不再重复查询）。
        let Some(info) = window_info(hwnd) else {
            return WindowJudgment {
                is_user: false,
                maximised: false,
                minimised: false,
                hmonitor: None,
                info: WindowInfo::new(hwnd, "", "", ""),
            };
        };
        let maximised;
        let minimised;
        let mut is_user = false;
        // SAFETY: 以下均为只读窗口查询。
        unsafe {
            let h = to_hwnd(hwnd);
            maximised = IsZoomed(h).as_bool();
            minimised = IsIconic(h).as_bool();
            // CoreWindow 是 shell 自身 UI，直接排除。
            if info.class != CORE_WINDOW_CLASS {
                let ex_style = WINDOW_EX_STYLE(GetWindowLongPtrW(h, GWL_EXSTYLE) as u32);
                let is_tool = (ex_style & WS_EX_TOOLWINDOW) == WS_EX_TOOLWINDOW;
                let top_level = GetAncestor(h, GA_ROOT) == h;
                if !is_tool && IsWindowVisible(h).as_bool() && !window_cloaked(hwnd) && top_level {
                    let no_activate = (ex_style & WS_EX_NOACTIVATE) == WS_EX_NOACTIVATE;
                    let app_window = (ex_style & WS_EX_APPWINDOW) == WS_EX_APPWINDOW;
                    if !no_activate || app_window {
                        // 最后一步才是会泵消息的虚拟桌面查询（单次
                        // 失败按 false）。
                        // 该语义针对**单次查询失败**；
                        // 窗口判非用户——visible/maximized 两态永久失效且无提示，
                        // 任务栏恒桌面态。对象缺失按宽松降级（视为在当前桌面），
                        // 单次失败仍严格拒绝。
                        let on_desktop = match vdm {
                            Some(m) => m
                                .IsWindowOnCurrentVirtualDesktop(h)
                                .is_ok_and(|ok| ok.as_bool()),
                            None => true,
                        };
                        is_user = on_desktop;
                    }
                }
            }
        }
        let is_user = is_user && !is_ignored(ignored, &info);
        let hmonitor = {
            // SAFETY: 只读显示器归属查询。
            unsafe {
                let mon = MonitorFromWindow(to_hwnd(hwnd), MONITOR_DEFAULTTONULL);
                if mon.is_invalid() {
                    None
                } else {
                    Some(mon.0 as isize)
                }
            }
        };
        WindowJudgment {
            is_user,
            maximised,
            minimised,
            hmonitor,
            info,
        }
    }

    pub fn foreground_hwnd() -> isize {
        // SAFETY: 只读。
        unsafe { GetForegroundWindow().0 as isize }
    }

    /// 枚举全部顶层窗口（EnumWindows 按 Z 序自顶向下回调）。
    /// 返回 (hwnd, 自顶向下序号)；供全量重建与 Z 序排名共用。
    pub fn enumerate_windows_zorder() -> Vec<isize> {
        // SAFETY: 回调只往调用方 Vec 里 push；EnumWindows 不向目标窗口发消息。
        unsafe {
            let mut out: Vec<isize> = Vec::new();
            let lparam = LPARAM(&mut out as *mut Vec<isize> as isize);
            let _ =
                windows::Win32::UI::WindowsAndMessaging::EnumWindows(Some(enumerate_cb), lparam);
            out
        }
    }

    unsafe extern "system" fn enumerate_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<isize>);
        out.push(hwnd.0 as isize);
        BOOL(1)
    }
}

#[cfg(not(windows))]
mod win_noop {
    use super::{DesktopManager, WindowJudgment};
    use crate::taskbar::WindowInfo;

    pub fn enumerate_windows_zorder() -> Vec<isize> {
        Vec::new()
    }

    pub fn judge(hwnd: isize) -> WindowJudgment {
        WindowJudgment {
            is_user: false,
            maximised: false,
            minimised: false,
            hmonitor: None,
            info: WindowInfo::new(hwnd, "", "", ""),
        }
    }

    pub fn _type_anchor(_vdm: &DesktopManager) {}
    pub fn _unused(_ignored: &crate::taskbar::TaskbarIgnoredWindows) -> WindowInfo {
        WindowInfo::new(0, "", "", "")
    }
}

/// 枚举全部顶层窗口（EnumWindows，Z 序自顶向下）。非 Windows 返回空。
#[cfg(windows)]
pub fn enumerate_windows_zorder() -> Vec<isize> {
    win::enumerate_windows_zorder()
}

#[cfg(not(windows))]
pub fn enumerate_windows_zorder() -> Vec<isize> {
    win_noop::enumerate_windows_zorder()
}

#[cfg(not(windows))]
pub fn judge_window(
    hwnd: isize,
    _ignored: &crate::taskbar::TaskbarIgnoredWindows,
    _vdm: &DesktopManager,
) -> WindowJudgment {
    win_noop::judge(hwnd)
}

#[cfg(not(windows))]
pub fn foreground_hwnd() -> isize {
    0
}

/// Z 序排名表：hwnd → 自顶向下序号（0 = 最顶层）。由
/// [`enumerate_windows_zorder`] 的一次快照构建。
pub fn z_ranks(hwnds: &[isize]) -> HashMap<isize, usize> {
    hwnds.iter().enumerate().map(|(i, &h)| (h, i)).collect()
}

/* ---------------- 窗口集合表（纯数据，可单测） ---------------- */

/// 单窗口在集合表中的归属记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowEntry {
    pub info: WindowInfo,
    pub hmonitor: isize,
    /// 计入 maximised 集合。
    pub maximised: bool,
    /// 计入 normal（可见非最大化非最小化）集合。
    pub normal: bool,
}

/// 按 hwnd 维护的窗口集合表（maximised/normal 两类合并形态）。
/// 纯数据结构，由状态机线程独占。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WindowTable {
    entries: HashMap<isize, WindowEntry>,
}

impl WindowTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// 按判定结果落位（含"移出"分支）。
    /// 返回集合是否发生变化（驱动防抖重求值）。
    pub fn insert(&mut self, hwnd: isize, j: WindowJudgment) -> bool {
        if !j.is_user || j.hmonitor.is_none() {
            return self.remove(hwnd);
        }
        let (maximised, normal) = if j.maximised {
            (true, false)
        } else if !j.minimised {
            (false, true)
        } else {
            // 最小化（且非最大化）= 不属于任何集合。
            return self.remove(hwnd);
        };
        let entry = WindowEntry {
            info: j.info,
            hmonitor: j.hmonitor.unwrap_or(0),
            maximised,
            normal,
        };
        match self.entries.get(&hwnd) {
            Some(old) if *old == entry => false,
            _ => {
                self.entries.insert(hwnd, entry);
                true
            }
        }
    }

    /// 从所有集合移除（DESTROY/HIDE/CLOAK/
    /// MINIMIZESTART 共用）。返回是否发生变化。
    pub fn remove(&mut self, hwnd: isize) -> bool {
        self.entries.remove(&hwnd).is_some()
    }

    /// 前台窗口信息（审计修复）：表层只收用户窗口（insert 的 is_user
    /// 门槛），命中即「前台是用户窗口」且直接复用已采快照；缺席（桌面
    /// Progman/WorkerW 等非用户窗口，或 Insert 未到的乱序瞬态）返回 None
    /// ——非用户前台不该驱动 Title/Class 规则匹配。
    pub fn user_window_info(&self, hwnd: isize) -> Option<WindowInfo> {
        self.entries.get(&hwnd).map(|e| e.info.clone())
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, hwnd: isize) -> bool {
        self.entries.contains_key(&hwnd)
    }

    pub fn entry(&self, hwnd: isize) -> Option<&WindowEntry> {
        self.entries.get(&hwnd)
    }

    /// 组装某显示器的两个集合。`maximised` 按 Z 序自顶向下排列
    /// （CORE 契约：index 0 = 最顶层最大化；排名缺失的窗口排最后，
    /// 按 hwnd 值稳定排序）。`normal` 同序（CORE 仅用其非空性）。
    pub fn monitor_sets(
        &self,
        hmonitor: isize,
        zrank: &HashMap<isize, usize>,
    ) -> (Vec<WindowInfo>, Vec<WindowInfo>) {
        let mut maximised: Vec<&WindowEntry> = self
            .entries
            .values()
            .filter(|e| e.hmonitor == hmonitor && e.maximised)
            .collect();
        let mut normal: Vec<&WindowEntry> = self
            .entries
            .values()
            .filter(|e| e.hmonitor == hmonitor && e.normal)
            .collect();
        let by_z = |a: &&WindowEntry, b: &&WindowEntry| {
            let ra = zrank.get(&a.info.hwnd).copied().unwrap_or(usize::MAX);
            let rb = zrank.get(&b.info.hwnd).copied().unwrap_or(usize::MAX);
            ra.cmp(&rb).then(a.info.hwnd.cmp(&b.info.hwnd))
        };
        maximised.sort_by(by_z);
        normal.sort_by(by_z);
        (
            maximised.into_iter().map(|e| e.info.clone()).collect(),
            normal.into_iter().map(|e| e.info.clone()).collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taskbar::{TaskbarIgnoredWindows, WindowInfo};

    fn j(hwnd: isize, class: &str, process: &str, mon: isize, m: bool, _n: bool) -> WindowJudgment {
        WindowJudgment {
            is_user: true,
            maximised: m,
            minimised: false,
            hmonitor: Some(mon),
            info: WindowInfo::new(hwnd, class, "t", process),
        }
    }

    fn info(hwnd: isize, class: &str) -> WindowInfo {
        WindowInfo::new(hwnd, class, "t", "p.exe")
    }

    #[test]
    fn transition_table_show_minimize_restore_hide_cloak_destroy() {
        let mut t = WindowTable::new();
        // SHOW → normal 集合。
        assert!(t.insert(1, j(1, "A", "a.exe", 10, false, true)));
        assert!(t.contains(1) && t.entry(1).unwrap().normal && !t.entry(1).unwrap().maximised);
        // 重复同态事件幂等（不触发重求值）。
        assert!(!t.insert(1, j(1, "A", "a.exe", 10, false, true)));
        // LOCATIONCHANGE 报告最大化 → maximised 集合（normal 撤出：
        // 先 erase(normal) 再 insert(maximised)）。
        assert!(t.insert(1, j(1, "A", "a.exe", 10, true, false)));
        assert!(t.entry(1).unwrap().maximised && !t.entry(1).unwrap().normal);
        // MINIMIZESTART（judgment minimised 且非 maximised）→ 移出全部。
        let mut min = j(1, "A", "a.exe", 10, false, false);
        min.minimised = true;
        min.maximised = false;
        assert!(t.insert(1, min));
        assert!(!t.contains(1));
        // MINIMIZEEND 恢复 normal。
        assert!(t.insert(1, j(1, "A", "a.exe", 10, false, true)));
        // HIDE → 移除。
        assert!(t.remove(1));
        assert!(!t.remove(1), "重复 DESTROY 幂等");
        // CLOAK（is_user=false）走移除分支。
        t.insert(2, j(2, "B", "b.exe", 10, false, true));
        let mut cloak = j(2, "B", "b.exe", 10, false, true);
        cloak.is_user = false;
        assert!(t.insert(2, cloak));
        assert!(!t.contains(2));
    }

    #[test]
    fn non_user_or_monitorless_never_enter() {
        let mut t = WindowTable::new();
        let mut nu = j(3, "C", "c.exe", 10, false, true);
        nu.is_user = false;
        assert!(!t.insert(3, nu));
        let mut nomon = j(4, "D", "d.exe", 10, false, true);
        nomon.hmonitor = None;
        assert!(!t.insert(4, nomon));
        assert!(t.is_empty());
    }

    #[test]
    fn monitor_sets_split_and_z_order() {
        let mut t = WindowTable::new();
        t.insert(10, j(10, "Chrome", "c.exe", 7, true, false));
        t.insert(11, j(11, "Note", "n.exe", 7, false, true));
        t.insert(12, j(12, "Word", "w.exe", 7, true, false));
        t.insert(13, j(13, "Other", "o.exe", 9, true, false));
        // Z 序：12 最顶，10 其下。
        let rank = z_ranks(&[99, 12, 11, 10]);
        let (max, norm) = t.monitor_sets(7, &rank);
        assert_eq!(max.iter().map(|w| w.hwnd).collect::<Vec<_>>(), [12, 10]);
        assert_eq!(norm.iter().map(|w| w.hwnd).collect::<Vec<_>>(), [11]);
        // 排名缺失 → 按(hwnd 值)排最后且稳定。
        let (max2, _) = t.monitor_sets(7, &HashMap::new());
        assert_eq!(max2.iter().map(|w| w.hwnd).collect::<Vec<_>>(), [10, 12]);
        // 其他显示器不受影响。
        let (max9, norm9) = t.monitor_sets(9, &rank);
        assert_eq!(max9.iter().map(|w| w.hwnd).collect::<Vec<_>>(), [13]);
        assert!(norm9.is_empty());
    }

    #[test]
    fn z_ranks_maps_top_to_bottom() {
        let r = z_ranks(&[5, 6, 7]);
        assert_eq!(r[&5], 0, "第一个 = 最顶层");
        assert_eq!(r[&7], 2);
    }

    #[test]
    fn core_window_constant_matches_benchmark() {
        assert_eq!(CORE_WINDOW_CLASS, "Windows.UI.Core.CoreWindow");
    }

    /// 忽略列表过滤在 judge 之外由 WindowTable 消费方传入判定；这里验证
    /// CORE 的 is_ignored 语义（空 pattern 不吞窗口）与本表无耦合冲突。
    #[test]
    fn ignored_filtering_stays_external() {
        let ignored = TaskbarIgnoredWindows {
            classes: vec![String::new()],
            ..TaskbarIgnoredWindows::default()
        };
        assert!(!crate::taskbar::is_ignored(&ignored, &info(1, "Any")));
    }
}
