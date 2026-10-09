//! ：DLL 端「管道服务端白名单」的单一来源。
//!
//! `server_image_allowed`（DLL 侧 防冒充链路）原先把宿主进程名硬编码在
//! pipe_client.rs——与产物名单手工同步：发布产物改名 / dev 用别的 bin 名联调
//! 时 DLL 永远拒绝服务端、无限重连，症状只有「等待重连」，极难排障。名单收
//! 编到本 crate 后，两侧改版本/改产物名只需要动这一处（改动 PROTOCOL_VERSION
//! 语义时同理，见 protocol.rs）。
//!
//! 名单成员：
//! - `focus-desk.exe`：宿主 crate 的 cargo bin（dev 与 release 同名）；
//! - `vela.exe`：正式发布产物名（tauri bundle 重命名后的宿主）。

/// 允许充当管道服务端的宿主进程映像名（小写比较）。
pub const ALLOWED_SERVERS: &[&str] = &["focus-desk.exe", "vela.exe"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_never_empty() {
        assert!(!ALLOWED_SERVERS.is_empty());
        assert!(ALLOWED_SERVERS.iter().all(|s| {
            let ok = s.ends_with(".exe") && !s.contains('\\') && !s.contains('/');
            assert!(ok, "名单必须是纯文件名且带 .exe 后缀: {s}");
            ok
        }));
    }
}
