//! 单实例 + argv 命令控制面（单实例 argv 转发命令面，§4.2）。
//!
//! `tauri-plugin-single-instance` 保证只有一个 Vela 实例常驻：第二实例在
//! 插件 setup 阶段（早于建窗/托盘/数据库）把 argv 经 WM_COPYDATA 转发到
//! 首实例后直接退出——不会出现双托盘、双心跳、双桌面层。
//!
//! 本模块在**首实例**内解析第二实例的 argv，提供轻量命令面供
//! 快捷方式 / 脚本 / E2E 驱动应用：
//!   vela.exe --toggle-layer       显示/隐藏小组件层（同 Ctrl+Alt+D）
//!   vela.exe --show-settings      呼出设置窗口
//!   vela.exe --toggle-pomodoro    开始/暂停专注（同 Ctrl+Alt+Space）
//!   vela.exe --new-task "买咖啡"  直接创建任务；无文本参数则打开新建输入
//!   vela.exe --toggle-palette     全局呼出/收起命令面板（同 Ctrl+Alt+K，层隐藏时先显示）
//!   vela.exe --toggle-dock        显示/隐藏灵动岛（同 Ctrl+Alt+I，仅主屏窗口响应）
//!   vela.exe --open-dock-panel    打开灵动岛全岛面板（同 Ctrl+Alt+O，层隐藏时先显示）

use tauri::Emitter;

/// 命令面的一条已识别指令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliCommand {
    ToggleLayer,
    ShowSettings,
    TogglePomodoro,
    /// 任务标题；空串表示"打开新建任务输入框"（与托盘菜单行为一致）。
    NewTask(String),
    TogglePalette,
    ToggleDock,
    OpenDockPanel,
}

/// 纯解析：从 argv（含 argv[0]）提取已识别指令，保持出现顺序；未知参数忽略。
/// `--new-task` 后紧跟的非开关 token 被消费为任务标题。
pub fn parse_cli(argv: &[String]) -> Vec<CliCommand> {
    let mut out = Vec::new();
    let mut i = 1; // argv[0] 是程序自身路径
    while i < argv.len() {
        match argv[i].as_str() {
            "--toggle-layer" => out.push(CliCommand::ToggleLayer),
            "--show-settings" => out.push(CliCommand::ShowSettings),
            "--toggle-pomodoro" => out.push(CliCommand::TogglePomodoro),
            "--toggle-palette" => out.push(CliCommand::TogglePalette),
            "--toggle-dock" => out.push(CliCommand::ToggleDock),
            "--open-dock-panel" => out.push(CliCommand::OpenDockPanel),
            "--new-task" => {
                let text = argv
                    .get(i + 1)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty() && !s.starts_with('-'))
                    .unwrap_or_default();
                if !text.is_empty() {
                    i += 1;
                }
                out.push(CliCommand::NewTask(text));
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// 在首实例内执行第二实例转发来的 argv。
pub fn handle_second_instance(app: &tauri::AppHandle, argv: &[String], cwd: &str) {
    let cmds = parse_cli(argv);
    for cmd in &cmds {
        match cmd {
            CliCommand::ToggleLayer => crate::windows::toggle_widget_layer(app),
            CliCommand::ShowSettings => crate::windows::show_settings_window(app),
            // 复用 Ctrl+Alt+Space 的既有事件通道（primary 窗口统一处理）。
            CliCommand::TogglePomodoro => {
                let _ = app.emit("shortcut:toggle-pomodoro", ());
            }
            // 有文本 → 载荷即任务标题（前端直接建任务）；空串 → 前端按托盘
            // "新建任务"原行为打开输入框。
            CliCommand::NewTask(text) => {
                let _ = app.emit("tray:new-task", text.clone());
            }
            // 与 Ctrl+Alt+K 走同一条分派（显示层 → 置前 → 广播），不另写一份。
            CliCommand::TogglePalette => crate::shortcuts::dispatch(app, "toggle-palette"),
            // 灵动岛两开关同样复用热键分派（--open-dock-panel 含「层隐藏先显示」）。
            CliCommand::ToggleDock => crate::shortcuts::dispatch(app, "toggle-dock"),
            CliCommand::OpenDockPanel => crate::shortcuts::dispatch(app, "open-dock-panel"),
        }
    }
    // 可观测性 + E2E 钩子：无论是否识别，广播一次第二实例的完整 argv。
    let _ = app.emit("app:second-instance", argv);
    if cmds.is_empty() {
        log::info!("second instance argv ignored (cwd={cwd}): {argv:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        std::iter::once("vela.exe")
            .chain(parts.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn parses_known_switches_in_order() {
        let cmds = parse_cli(&argv(&[
            "--show-settings",
            "--toggle-layer",
            "--toggle-pomodoro",
            "--toggle-palette",
            "--toggle-dock",
            "--open-dock-panel",
        ]));
        assert_eq!(
            cmds,
            vec![
                CliCommand::ShowSettings,
                CliCommand::ToggleLayer,
                CliCommand::TogglePomodoro,
                CliCommand::TogglePalette,
                CliCommand::ToggleDock,
                CliCommand::OpenDockPanel,
            ]
        );
    }

    #[test]
    fn new_task_consumes_following_text() {
        let cmds = parse_cli(&argv(&["--new-task", "  买咖啡 ", "--toggle-layer"]));
        assert_eq!(
            cmds,
            vec![
                CliCommand::NewTask("买咖啡".into()),
                CliCommand::ToggleLayer
            ]
        );
    }

    #[test]
    fn new_task_without_text_yields_empty_title() {
        // 下一个 token 是开关 → 不消费，按"打开输入框"处理。
        let cmds = parse_cli(&argv(&["--new-task", "--toggle-layer"]));
        assert_eq!(
            cmds,
            vec![CliCommand::NewTask(String::new()), CliCommand::ToggleLayer]
        );
        // 末尾无参数同理。
        assert_eq!(
            parse_cli(&argv(&["--new-task"])),
            vec![CliCommand::NewTask(String::new())]
        );
    }

    #[test]
    fn unknown_args_and_bare_launch_are_ignored() {
        assert!(parse_cli(&argv(&[])).is_empty());
        assert!(parse_cli(&argv(&["--restarted", "foo"])).is_empty());
        assert!(parse_cli(&[]).is_empty());
    }
}
