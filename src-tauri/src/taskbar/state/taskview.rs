//! 任务视图状态源。Win11：
//! ShellViewCoordinator(TaskView) 的 VisibilityChanged（全局布尔，不分
//! 显示器）。Win10 通道（注入 DLL 内 IMultitaskingViewVisibilityService）
//! 不实现，能力上报不可用。

use std::sync::mpsc::Sender;

use super::search::{watch_shell_view, ShellViewKind, ShellViewWatch};
use super::EngineMsg;

/// 订阅任务视图可见性（映射到 [`EngineMsg::TaskView`]）。
pub fn watch_task_view(tx: Sender<EngineMsg>) -> Result<ShellViewWatch, String> {
    watch_shell_view(ShellViewKind::TaskView, EngineMsg::task_view, tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_visibility_to_taskview_event() {
        assert_eq!(EngineMsg::task_view(true), EngineMsg::TaskView(true));
        assert_eq!(EngineMsg::task_view(false), EngineMsg::TaskView(false));
    }
}
