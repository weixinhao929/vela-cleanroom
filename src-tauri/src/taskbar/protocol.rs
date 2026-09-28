//! 任务栏注入 DLL（velatap）管道线协议 —— ★ 定死后冻结（D4）。
//!
//! 本文件是主进程（taskbar/ 模块）与注入 DLL（crates/taskbar_tap，产物
//! velatap.dll）之间的唯一协议事实来源，Wave 1 的 TB-TAP / TB-INJECT 会话
//! 按此实现，字段与枚举不再变更；需要扩展时只能新增 TapMessage 变体并
//! 同步递增 [`PROTOCOL_VERSION`]。
//!
//! # 管道
//! - 名称：`\\.\pipe\vela-taskbar-<pid>`，`<pid>` = **explorer.exe 的 PID**
//!   （被注入进程）。DLL 侧用 `GetCurrentProcessId()` 即可算出同名，无需
//!   任何带外参数；explorer 重启 → 新 PID → 新管道名，天然隔离代际。
//! - 角色：**主进程是服务端**（注入前先建管道，无竞态），DLL 加载后作为
//!   客户端 `CreateFileW` 连接。DLL 用 `GetNamedPipeServerProcessId` 取
//!   Vela 进程 PID → `OpenProcess(SYNCHRONIZE)` 持句柄，主进程死亡即
//!   自动恢复全部任务栏（F-9 恢复线 2，对齐标杆 taskbarappearanceservice）。
//! - 帧格式：**每条消息一行 UTF-8 JSON，以 `\n` 结尾**（NDJSON）；单条
//!   上限 64 KiB，超限即视为协议破坏断开。
//! - 双向字节流（PIPE_ACCESS_DUPLEX），写入方每次 `WriteFile` 一条完整帧。
//!
//! # 握手与心跳
//! 1. DLL 连接后主进程发 [`TapMessage::Hello`]（携带主进程 [`PROTOCOL_VERSION`]）。
//! 2. DLL 校验：版本一致 → 回 [`TapMessage::Ready`]（携带 DLL 自己的
//!    [`PROTOCOL_VERSION`]）；不一致 → 仍回 `Ready`（带自己的版本）后关闭
//!    管道并不再响应。**主进程比较两侧版本，不匹配即注入流程 Failed**
//!    （`taskbar:status` 事件 phase=failed，文案提示重启资源管理器）。
//! 3. 运行期主进程周期发 [`TapMessage::Ping`]，DLL 必须回 [`TapMessage::Pong`]；
//!    超时未回按连接失效处理（重注入走 explorer 重启 / 重新应用路径）。
//!
//! # 本文件的独立性约束
//! 只依赖 `serde` / `serde_json` 与标准库，**禁止引用本 crate 其他模块**
//! ——velatap crate 通过 `#[path]` 直接包含本文件共享同一份协议定义：
//! ```ignore
//! #[path = "../../../src/taskbar/protocol.rs"]
//! mod protocol;
//! ```

use serde::{Deserialize, Serialize};

/// 管道协议版本。任意一侧改动 TapMessage 语义 / 握手顺序时递增，
/// 版本不匹配即注入 Failed（见模块文档）。
pub const PROTOCOL_VERSION: u32 = 1;

/// 单条消息（含换行符）的字节上限，防御对端发疯撑爆读缓冲。
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// 管道名（`<pid>` = explorer.exe PID，见模块文档）。
pub fn pipe_name(explorer_pid: u32) -> String {
    format!(r"\\.\pipe\vela-taskbar-{explorer_pid}")
}

/// accent 的线协议形式。与前端 `TaskbarAccent` 一一对应，但独立定义：
/// 本文件必须能被 velatap crate 单独包含（见模块文档），换算见
/// taskbar/mod.rs 的 `From<TaskbarAccent>`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TapAccent {
    /// 恢复系统默认外观（DLL 侧还原原始 Fill 画刷）。
    Normal,
    /// 不透明纯色（忽略 alpha）。
    Opaque,
    /// 带 alpha 的纯色（alpha=0 即完全隐藏背景色）。
    Clear,
    /// 高斯模糊（σ = blur_radius / 3，XAML 路径自定义画刷）。
    Blur,
    /// 亚克力（噪声 + 模糊 + 着色）。
    Acrylic,
}

/// 管道消息（NDJSON，serde tag = "type"）。
///
/// 方向：Hello（主→DLL）→ Ready（DLL→主）；ApplyAppearance /
/// SetBorderVisibility / RestoreAll / Ping（主→DLL）；Pong（DLL→主）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TapMessage {
    /// 握手第一步：主进程宣告自己的协议版本。
    Hello { protocol_version: u32 },
    /// 握手应答：DLL 宣告自己的协议版本（无论是否匹配都先回，主进程比对）。
    Ready { protocol_version: u32 },
    /// 对某台显示器的任务栏应用外观。
    /// `monitor` = **HMONITOR 句柄值**（GDI 显示器句柄系统全局、跨进程有效，
    /// DLL 侧对每个任务栏 HWND `MonitorFromWindow` 得到同值；**0 = 全部任务栏**，
    /// perMonitor=false 时主进程用 0 一次下发）。`color_abgr` 见 [`pack_abgr`]。
    /// showPeek 不在协议里：XAML 任务栏无该按钮结构（能力探测恒 false）。
    ApplyAppearance {
        monitor: u64,
        accent: TapAccent,
        color_abgr: u32,
        /// 0–750；仅 accent=Blur 使用，DLL 侧换算 σ = radius / 3。
        blur_radius: u32,
    },
    /// 任务栏顶部 1px 分隔线显隐（XAML 路径 = 顶线 Fill 换透明画刷）。
    /// `monitor` 语义同 [`TapMessage::ApplyAppearance`]（0 = 全部）。
    SetBorderVisibility { monitor: u64, visible: bool },
    /// 恢复全部任务栏为系统默认外观（退出 / 停用 / explorer 重启重建前调用）。
    RestoreAll,
    /// 心跳探测（主→DLL）。
    Ping,
    /// 心跳应答（DLL→主）。
    Pong,
}

/// 把 RGBA 各 8 位打包成线协议的 ABGR u32（SWCA ACCENT_POLICY 的内存序，
/// XAML 路径 DLL 侧再拆回 A/R/G/B 构造 Windows.UI.Color）。
pub const fn pack_abgr(r: u8, g: u8, b: u8, a: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((g as u32) << 8) | (r as u32)
}

/// [`pack_abgr`] 的逆运算，DLL 侧构造颜色对象用。
pub const fn unpack_abgr(v: u32) -> (u8, u8, u8, u8) {
    (
        (v & 0xff) as u8,
        ((v >> 8) & 0xff) as u8,
        ((v >> 16) & 0xff) as u8,
        ((v >> 24) & 0xff) as u8,
    )
}

/// 编码一条消息为完整帧（JSON + `\n`）。序列化失败仅在结构非法时发生
/// （本类型全部为简单字段，实际不可达）。
pub fn encode(msg: &TapMessage) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_string(msg).map_err(|e| format!("tap encode: {e}"))?;
    line.push('\n');
    Ok(line.into_bytes())
}

/// 解码一行（不含 `\n`）。半帧 / 未知变体 / 字段类型错均返回 Err，
/// 调用方按协议破坏处理（断开重连），不得 panic。
pub fn decode(line: &str) -> Result<TapMessage, String> {
    serde_json::from_str(line).map_err(|e| format!("tap decode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_round_trips() {
        let msgs = [
            TapMessage::Hello {
                protocol_version: 1,
            },
            TapMessage::Ready {
                protocol_version: 1,
            },
            TapMessage::ApplyAppearance {
                monitor: 0,
                accent: TapAccent::Clear,
                color_abgr: 0x00_00_00_00,
                blur_radius: 30,
            },
            TapMessage::ApplyAppearance {
                monitor: 0x1234_5678_9abc,
                accent: TapAccent::Blur,
                color_abgr: u32::MAX,
                blur_radius: 750,
            },
            TapMessage::SetBorderVisibility {
                monitor: 42,
                visible: false,
            },
            TapMessage::RestoreAll,
            TapMessage::Ping,
            TapMessage::Pong,
        ];
        for m in &msgs {
            let frame = encode(m).expect("encode");
            assert_eq!(frame.last(), Some(&b'\n'), "帧必须以换行结尾");
            assert!(frame.len() <= MAX_FRAME_BYTES);
            let back =
                decode(std::str::from_utf8(&frame[..frame.len() - 1]).unwrap()).expect("decode");
            assert_eq!(&back, m);
        }
    }

    #[test]
    fn wire_shape_is_frozen() {
        // tag 命名一旦上线就不可改（DLL 与主进程各自编译仍需逐字节兼容）。
        let json = serde_json::to_string(&TapMessage::ApplyAppearance {
            monitor: 7,
            accent: TapAccent::Acrylic,
            color_abgr: 0xff_00_00_ff,
            blur_radius: 9,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"apply_appearance","monitor":7,"accent":"acrylic","color_abgr":4278190335,"blur_radius":9}"#
        );
        assert_eq!(
            serde_json::to_string(&TapMessage::RestoreAll).unwrap(),
            r#"{"type":"restore_all"}"#
        );
        assert_eq!(
            serde_json::to_string(&TapMessage::Hello {
                protocol_version: PROTOCOL_VERSION
            })
            .unwrap(),
            r#"{"type":"hello","protocol_version":1}"#
        );
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode("not json").is_err());
        assert!(decode(r#"{"type":"no_such_variant"}"#).is_err());
        // 已知变体但字段类型错 / 缺字段 → Err，不 panic。
        assert!(decode(r#"{"type":"hello"}"#).is_err());
        assert!(decode(r#"{"type":"set_border_visibility","monitor":"x","visible":1}"#).is_err());
    }

    #[test]
    fn abgr_packing_is_lossless_and_matches_memory_order() {
        // ABGR 内存序：最低字节 R，最高字节 A。
        assert_eq!(pack_abgr(0x11, 0x22, 0x33, 0x44), 0x44_33_22_11);
        assert_eq!(unpack_abgr(0x44_33_22_11), (0x11, 0x22, 0x33, 0x44));
        assert_eq!(
            unpack_abgr(pack_abgr(0, 0xff, 0x80, 0xfe)),
            (0, 0xff, 0x80, 0xfe)
        );
    }

    #[test]
    fn pipe_name_embeds_explorer_pid() {
        assert_eq!(pipe_name(1234), r"\\.\pipe\vela-taskbar-1234");
    }
}
