//! 管道客户端——协议侧 DLL 端点。
//!
//! 角色（protocol.rs 冻结定义）：**主进程是服务端**，本 DLL 是客户端
//! `CreateFileW` 连接 `\\.\pipe\vela-taskbar-<explorer_pid>`。
//!
//! 握手：等服务端 [`TapMessage::Hello`] → 回 [`TapMessage::Ready`]（无论版本
//! 是否匹配都先回，主进程比对）；不匹配则回完即断、置关闭标记、不再响应
//! （F-10：主进程侧转 Failed）。
//!
//! 运行期：ApplyAppearance / SetBorderVisibility / RestoreAll →
//! [`appearance::dispatch`]（投递任务栏 UI 线程）；Ping → 立即 Pong（心跳不
//! 经 UI 线程，永不阻塞）。断连 → 恢复全部任务栏 → 等重连；主进程死亡由
//! parent_watch 独立兜底。
//!
//! 重连**永不放弃**（版本被拒除外）：本 DLL 被 XAML Diagnostics pin 住无法
//! 卸载，同一 explorer 会话内也不允许再注入第二份；主进程正常退出 / 崩溃 /
//! 重启后唯一的恢复路径就是它重建同名管道、本副本连上去。前 60s 按 500ms
//! 节律等首次握手，之后退避到 2s 一次（空转成本可忽略）。

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
use windows::Win32::System::Threading::GetCurrentProcessId;

use crate::appearance;
use crate::protocol::{self, TapMessage, MAX_FRAME_BYTES, PROTOCOL_VERSION};

/// 握手决策。纯函数，单测覆盖。
pub fn handshake_action(remote_version: u32) -> HandshakeAction {
    if remote_version == PROTOCOL_VERSION {
        HandshakeAction::Serve
    } else {
        HandshakeAction::Refuse
    }
}

/// 服务端映像判定（D-3）：管道对端必须是 Vela 宿主进程。管道名可被同用户
/// 进程抢注（服务端侧有 FIRST_PIPE_INSTANCE 防抢注，但重连窗口内仍可能
/// 出现冒充者），冒充服务端可任意操纵任务栏外观。映像路径取末段文件名，
/// 大小写不敏感；非 Vela 宿主一律拒绝本次连接（继续重连等真宿主）。
pub fn server_image_allowed(image_path: &str) -> bool {
    let name = image_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(image_path)
        .to_ascii_lowercase();
    name == "focus-desk.exe" || name == "vela.exe"
}

/// 查询管道服务端进程的完整映像路径（查询失败返回 None，调用方决定策略）。
fn server_image_path(pid: u32) -> Option<String> {
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: 句柄立即使用并关闭；缓冲区按 API 契约传入容量。
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = [0u16; 1024];
    let mut len: u32 = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    }
    .is_ok();
    let _ = unsafe { CloseHandle(handle) };
    ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeAction {
    Serve,
    Refuse,
}

/// 连续连接失败 `failures` 次后的等待。前 120 次（≈60s，正常注入流程里主进程
/// 先建管道再注入，首次握手都在此窗口内）500ms；之后 2s。纯函数，单测覆盖。
pub fn reconnect_delay(failures: u32) -> std::time::Duration {
    if failures <= 120 {
        std::time::Duration::from_millis(500)
    } else {
        std::time::Duration::from_secs(2)
    }
}

/// 握手应答版本：默认 [`PROTOCOL_VERSION`]。
///
/// **仅 debug 构建**接受 DLL 同目录 `velatap.mockver`（内容为一个 u32）覆盖
/// ——TB-INJECT 约定的联调钩子（injector.rs `manual_version_mismatch`：预放
/// mockver=99 → 验证主进程转 Failed +「重启资源管理器」文案，F-10）。解包
/// 目录 `%TEMP%\vela\tap\<hash>\` 用户可写，发布构建若保留该钩子，任何进程
/// 放一个文件就能让注入恒 Failed，故 release 下编译期剔除、代码路径恒为
/// 常量。
fn effective_version() -> u32 {
    #[cfg(debug_assertions)]
    {
        if let Some(dir) = crate::bootstrap::self_dir() {
            let path = dir.join("velatap.mockver");
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(v) = text.trim().parse::<u32>() {
                    crate::vlog!("pipe client: mockver override = {v} (debug build only)");
                    return v;
                }
            }
        }
    }
    PROTOCOL_VERSION
}

/// 管道线程主体（init 线程 spawn）。
pub fn run() {
    let _ = crate::util::guarded("pipe client", pipe_client_main);
}

fn pipe_client_main() -> windows_core::Result<()> {
    let name = protocol::pipe_name(unsafe { GetCurrentProcessId() });
    let mut connect_failures: u32 = 0;

    loop {
        if appearance::is_shutdown() {
            return Ok(());
        }
        let Some(pipe) = connect(&name) else {
            connect_failures = connect_failures.saturating_add(1);
            if connect_failures == 121 {
                crate::vlog!("pipe client: no server for 60s, backing off to 2s polling");
            }
            std::thread::sleep(reconnect_delay(connect_failures));
            continue;
        };
        connect_failures = 0;
        crate::vlog!("pipe: connected to server");

        match serve(pipe) {
            ServeOutcome::Refused => {
                crate::vlog!("pipe client: protocol version mismatch, shutting down service");
                appearance::dispatch(TapMessage::RestoreAll);
                appearance::mark_shutdown();
                return Ok(());
            }
            ServeOutcome::Disconnected => {
                // 主进程断连（退出 / 崩溃 / 重启）：恢复默认外观后等重连。
                crate::vlog!("pipe client: disconnected, restoring then waiting");
                appearance::dispatch(TapMessage::RestoreAll);
            }
        }
    }
}

enum ServeOutcome {
    Refused,
    Disconnected,
}

fn connect(name: &str) -> Option<HANDLE> {
    let mut buf: Vec<u16> = name.encode_utf16().collect();
    buf.push(0);
    let open = || {
        unsafe {
            CreateFileW(
                PCWSTR(buf.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0), // 阻塞字节模式
                None,
            )
        }
    };
    match open() {
        Ok(h) => Some(h),
        // HRESULT_FROM_WIN32(ERROR_PIPE_BUSY=231)：实例被占 → 等一轮再抢。
        Err(e) if e.code() == windows_core::HRESULT(0x8007_00E7_u32 as i32) => {
            if unsafe { WaitNamedPipeW(PCWSTR(buf.as_ptr()), 2000) }.as_bool() {
                open().ok()
            } else {
                None
            }
        }
        Err(_) => None, // ERROR_FILE_NOT_FOUND 等：上层按 500ms 节律重试。
    }
}

fn serve(pipe: HANDLE) -> ServeOutcome {
    let outcome = serve_inner(pipe);
    let _ = unsafe { CloseHandle(pipe) };
    outcome
}

fn serve_inner(pipe: HANDLE) -> ServeOutcome {
    let mut reader = LineAssembler::default();

    // --- 握手：Hello → Ready ---
    let Some(first_line) = read_line(pipe, &mut reader) else {
        return ServeOutcome::Disconnected;
    };
    let Ok(TapMessage::Hello { protocol_version }) = protocol::decode(&first_line) else {
        return ServeOutcome::Disconnected;
    };

    let ready = TapMessage::Ready {
        protocol_version: effective_version(),
    };
    crate::vlog!("pipe: got Hello v{protocol_version}, replying Ready");
    if write_message(pipe, &ready).is_err() {
        return ServeOutcome::Disconnected;
    }
    let action = handshake_action(protocol_version);
    if action == HandshakeAction::Refuse {
        return ServeOutcome::Refused;
    }

    // --- 记录服务端身份 → 主进程死亡监视 ---
    let mut server_pid: u32 = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe, &mut server_pid) }.is_ok() {
        // D-3：先验服务端映像——explorer 内以 PROCESS_QUERY_LIMITED_INFORMATION
        // 查询宿主进程映像通常允许；查不到时维持现状服务（冒充者还需同时伪造
        // 协议版本号，收益极低）。查到且非 Vela 宿主：按断连处理（恢复默认外
        // 观后继续重连等真宿主），不置永久停机标记——冒充者可能是临时的。
        if let Some(path) = server_image_path(server_pid) {
            if !server_image_allowed(&path) {
                crate::vlog!("pipe client: server image is not Vela host ({path}), reconnecting");
                return ServeOutcome::Disconnected;
            }
        }
        crate::parent_watch::retarget(server_pid);
    }
    crate::vlog!("pipe client: serving main pid {server_pid}");

    // --- 运行期循环 ---
    while !appearance::is_shutdown() {
        let Some(line) = read_line(pipe, &mut reader) else {
            return ServeOutcome::Disconnected;
        };
        let msg = match protocol::decode(&line) {
            Ok(m) => m,
            Err(e) => {
                // 协议破坏：按协议文档断开重连，不 panic。
                crate::vlog!("pipe client: decode error ({e}), reconnecting");
                return ServeOutcome::Disconnected;
            }
        };
        match msg {
            TapMessage::ApplyAppearance { .. }
            | TapMessage::SetBorderVisibility { .. }
            | TapMessage::RestoreAll => appearance::dispatch(msg),
            TapMessage::Ping => {
                if write_message(pipe, &TapMessage::Pong).is_err() {
                    return ServeOutcome::Disconnected;
                }
            }
            TapMessage::Hello { .. } | TapMessage::Ready { .. } | TapMessage::Pong => {
                // 重复握手 / 杂音：忽略（保持连接）。
            }
        }
    }
    ServeOutcome::Disconnected
}

/// 阻塞读一行（含 `\n` 剥离）。None = 断连 / EOF / 超限。
fn read_line(pipe: HANDLE, reader: &mut LineAssembler) -> Option<String> {
    loop {
        if let Some(line) = reader.take_line() {
            return Some(line);
        }
        let mut chunk = [0u8; 4096];
        let mut read = 0u32;
        let ok = unsafe { ReadFile(pipe, Some(&mut chunk), Some(&mut read), None) };
        if !ok.is_ok() || read == 0 {
            return None;
        }
        if !reader.push(&chunk[..read as usize]) {
            crate::vlog!(
                "pipe client: frame over {} bytes, dropping",
                MAX_FRAME_BYTES
            );
            return None; // 单帧超限 = 协议破坏。
        }
    }
}

fn write_message(pipe: HANDLE, msg: &TapMessage) -> windows_core::Result<()> {
    let frame = protocol::encode(msg).map_err(|_| {
        windows_core::Error::from_hresult(windows_core::HRESULT(0x8000_4005_u32 as i32))
    })?;
    let mut written = 0u32;
    unsafe { WriteFile(pipe, Some(frame.as_slice()), Some(&mut written), None) }?;
    if written as usize != frame.len() {
        return Err(windows_core::Error::from_hresult(
            windows_core::HRESULT(0x8007_0277_u32 as i32), // 短写近似
        ));
    }
    Ok(())
}

/// NDJSON 半帧拼装器（纯逻辑，单测覆盖 64KiB 上限与跨块切分）。
#[derive(Default)]
struct LineAssembler {
    buf: Vec<u8>,
}

impl LineAssembler {
    /// 追加一块字节；超限返回 false（协议破坏）。
    fn push(&mut self, chunk: &[u8]) -> bool {
        if self.buf.len() + chunk.len() > MAX_FRAME_BYTES {
            return false;
        }
        self.buf.extend_from_slice(chunk);
        true
    }

    /// 取出一条完整行（若无则 None）。
    fn take_line(&mut self) -> Option<String> {
        let pos = self.buf.iter().position(|&b| b == b'\n')?;
        let line: Vec<u8> = self.buf.drain(..=pos).collect();
        let line = &line[..line.len() - 1]; // 去 \n
        Some(String::from_utf8_lossy(line).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_matches_only_same_version() {
        assert_eq!(handshake_action(PROTOCOL_VERSION), HandshakeAction::Serve);
        assert_eq!(
            handshake_action(PROTOCOL_VERSION + 1),
            HandshakeAction::Refuse
        );
        assert_eq!(handshake_action(0), HandshakeAction::Refuse);
    }

    /// D-3：服务端映像判定——只认 Vela 宿主（开发 focus-desk.exe / 发布 Vela.exe）。
    #[test]
    fn server_image_gate() {
        assert!(server_image_allowed(
            r"C:\proj\target\release\focus-desk.exe"
        ));
        assert!(server_image_allowed(r"C:\Program Files\Vela\Vela.exe"));
        assert!(server_image_allowed("VELA.EXE"));
        assert!(!server_image_allowed(r"C:\Windows\System32\evil.exe"));
        assert!(!server_image_allowed(r"C:\x\focus-desk.exe.bak"));
        assert!(!server_image_allowed(""));
        assert!(!server_image_allowed("C:\\tools\\some-host\\"));
    }

    #[test]
    fn reconnect_never_gives_up_and_backs_off_after_a_minute() {
        use std::time::Duration;
        assert_eq!(reconnect_delay(1), Duration::from_millis(500));
        assert_eq!(reconnect_delay(120), Duration::from_millis(500));
        assert_eq!(reconnect_delay(121), Duration::from_secs(2));
        // 饱和加法后仍是有限等待：永不放弃、永不 panic。
        assert_eq!(reconnect_delay(u32::MAX), Duration::from_secs(2));
    }

    #[test]
    fn assembler_handles_split_and_multiple_lines() {
        let mut a = LineAssembler::default();
        assert!(a.push(b"{\"type\":\"he"));
        assert!(a.push(b"llo\",\"protocol_version\":1}\n{\"type\":\"pi"));
        assert_eq!(
            a.take_line().unwrap(),
            r#"{"type":"hello","protocol_version":1}"#
        );
        assert_eq!(a.take_line(), None);
        assert!(a.push(b"ng\"}\n"));
        assert_eq!(a.take_line().unwrap(), r#"{"type":"ping"}"#);
        assert_eq!(a.take_line(), None);
    }

    #[test]
    fn assembler_enforces_frame_cap() {
        let mut a = LineAssembler::default();
        // 上限含换行：MAX-1 内容 + 1 换行 = MAX 恰好合法。
        assert!(a.push(&vec![b'x'; MAX_FRAME_BYTES - 1]));
        assert!(a.push(
            b"
"
        ));
        assert!(!a.push(b"y")); // 再多一个字节即拒。
    }

    #[test]
    fn round_trip_via_protocol_module() {
        // 协议 include 与编码链在本 crate 内可用。
        let msg = TapMessage::ApplyAppearance {
            monitor: 0,
            accent: crate::protocol::TapAccent::Opaque,
            color_abgr: crate::protocol::pack_abgr(1, 2, 3, 0xFF),
            blur_radius: 30,
        };
        let frame = protocol::encode(&msg).unwrap();
        let line = std::str::from_utf8(&frame[..frame.len() - 1]).unwrap();
        assert_eq!(protocol::decode(line).unwrap(), msg);
    }
}
