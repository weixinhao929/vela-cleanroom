//! inject_demo —— 注入器开发期的 mock 依赖方 + DLL 手测工具。
//!
//! 扮演主进程（protocol.rs 冻结角色：**管道服务端**）：
//! 1. 找主任务栏窗口（Shell_TrayWnd）→ explorer PID + UI 线程 ID；
//! 2. 建标记事件 `Local\velatap-inject-<pid>`（DllMain 靠它确认被注入）；
//! 3. 建管道 `\\.\pipe\vela-taskbar-<pid>`；
//! 4. SetWindowsHookEx(WH_CALLWNDPROC, 本 DLL 的 VelaTapHookProc, tid) 注入
//!    （DLL 被映射进 explorer → DllMain → TAP 起来 → DLL 连管道）；
//! 5. Hello/Ready 握手 + 版本比对，之后进入命令循环。
//!
//! 用法：
//! ```text
//! cargo run -p velatap --example inject_demo [-- --script]
//! cargo run -p velatap --example inject_demo -- --accent opaque --color 255,0,0,255 --hold 10
//! ```
//! 默认交互 REPL：`opaque|r|g|b|a`、`clear|r|g|b|a`、`acrylic|...`、
//! `blur|r|g|b|a|radius`、`normal`、`border on|off`、`ping`、`restore`、`quit`。
//! Ctrl+C / taskkill 直接杀本进程 = 验证 线 2（DLL 自动恢复任务栏）。

use std::io::{BufRead, Write};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, NAMED_PIPE_MODE, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetWindowThreadProcessId, PostMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    HOOKPROC, WH_CALLWNDPROC, WM_NULL,
};

use velatap::protocol::{self, TapAccent, TapMessage, MAX_FRAME_BYTES, PROTOCOL_VERSION};

fn main() {
    if let Err(e) = run() {
        eprintln!("inject_demo: {e}");
        std::process::exit(1);
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // 1. explorer 主任务栏 → pid/tid。
    let taskbar = unsafe { FindWindowW(windows::core::w!("Shell_TrayWnd"), None) }
        .map_err(|_| "Shell_TrayWnd not found".to_string())?;
    let mut pid: u32 = 0;
    let tid = unsafe { GetWindowThreadProcessId(taskbar, Some(&mut pid)) };
    if tid == 0 {
        return Err("GetWindowThreadProcessId failed".into());
    }
    println!("explorer pid={pid} taskbar tid={tid}");

    // 2. 标记事件（先于注入创建）。
    let marker_name = velatap::inject_marker_event_name(pid);
    let marker = unsafe { CreateEventW(None, true, false, PCWSTR(wide(&marker_name).as_ptr())) }
        .map_err(|_| "CreateEventW(marker) failed".to_string())?;

    // 3. 管道服务端。
    let pipe_name = protocol::pipe_name(pid);
    let open_mode =
        FILE_FLAGS_AND_ATTRIBUTES(PIPE_ACCESS_DUPLEX.0 | FILE_FLAG_FIRST_PIPE_INSTANCE.0);
    let pipe_mode = NAMED_PIPE_MODE(PIPE_TYPE_BYTE.0 | PIPE_READMODE_BYTE.0 | PIPE_WAIT.0);
    let pipe = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide(&pipe_name).as_ptr()),
            open_mode,
            pipe_mode,
            1,
            4096,
            4096,
            0,
            None,
        )
    };
    if pipe.is_invalid() {
        let _ = unsafe { CloseHandle(marker) };
        return Err(format!(
            "CreateNamedPipeW({pipe_name}) failed: {}",
            unsafe { windows::Win32::Foundation::GetLastError().0 }
        ));
    }

    // 4. 注入：钩子加载本 DLL 进 explorer。
    let dll_path = resolve_dll_path()?;
    let dll = unsafe { LoadLibraryW(PCWSTR(wide(&dll_path).as_ptr())) }
        .map_err(|e| format!("LoadLibrary({dll_path}) failed: {e}"))?;
    let hook_proc = unsafe { GetProcAddress(dll, windows::core::s!("VelaTapHookProc")) }
        .ok_or("VelaTapHookProc not found in dll".to_string())?;
    let hook: HOOKPROC = Some(unsafe {
        std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            unsafe extern "system" fn(
                i32,
                windows::Win32::Foundation::WPARAM,
                windows::Win32::Foundation::LPARAM,
            ) -> windows::Win32::Foundation::LRESULT,
        >(hook_proc)
    });
    let hook_handle = unsafe { SetWindowsHookExW(WH_CALLWNDPROC, hook, Some(dll.into()), tid) }
        .map_err(|e| format!("SetWindowsHookEx failed: {e}"))?;
    // 触发一次消息让钩子链装载 DLL。
    let _ = unsafe {
        PostMessageW(
            Some(taskbar),
            WM_NULL,
            windows::Win32::Foundation::WPARAM(0),
            windows::Win32::Foundation::LPARAM(0),
        )
    };

    println!("waiting for velatap to connect (35s) ...");
    let connected = wait_client(pipe).inspect_err(|_| {
        let _ = unsafe { UnhookWindowsHookEx(hook_handle) };
    })?;
    if !connected {
        let _ = unsafe { UnhookWindowsHookEx(hook_handle) };
        return Err("velatap did not connect in time".to_string());
    }
    // 钩子使命完成：InitializeXamlDiagnosticsEx 已把 DLL pin 在 explorer 里。
    let _ = unsafe { UnhookWindowsHookEx(hook_handle) };

    // 5. 握手。
    send(
        pipe,
        &TapMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
        },
    )?;
    let first = recv(pipe).ok_or("no Ready from dll")?;
    match first {
        TapMessage::Ready { protocol_version } if protocol_version == PROTOCOL_VERSION => {
            println!("handshake ok (protocol v{protocol_version})");
        }
        TapMessage::Ready { protocol_version } => {
            let _ = unsafe { DisconnectNamedPipe(pipe) };
            let _ = unsafe { CloseHandle(pipe) };
            let _ = unsafe { CloseHandle(marker) };
            return Err(format!(
                "protocol mismatch: main v{PROTOCOL_VERSION} vs dll v{protocol_version} \
                 (F-10: 注入应转 Failed，提示重启资源管理器)"
            ));
        }
        other => {
            let _ = unsafe { DisconnectNamedPipe(pipe) };
            let _ = unsafe { CloseHandle(pipe) };
            let _ = unsafe { CloseHandle(marker) };
            return Err(format!("unexpected first message: {other:?}"));
        }
    }

    if args.iter().any(|a| a == "--script") {
        scripted(pipe, &args)
    } else {
        repl(pipe)
    };

    // 收尾：恢复 + 关管道（进程退出后 DLL 侧还有 parent-watch 兜底）。
    let _ = send(pipe, &TapMessage::RestoreAll);
    let _ = send(pipe, &TapMessage::Ping);
    let _ = recv(pipe); // Pong
    let _ = unsafe { DisconnectNamedPipe(pipe) };
    let _ = unsafe { CloseHandle(pipe) };
    let _ = unsafe { CloseHandle(marker) };
    println!("bye (taskbar restored)");
    Ok(())
}

fn resolve_dll_path() -> Result<String, String> {
    if let Ok(p) = std::env::var("VELATAP_DLL") {
        return Ok(p);
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // cargo 布局：examples/ 与 velatap.dll 同在 target/release（或 debug）。
    for dir in [
        exe.parent().map(|p| p.to_path_buf()),
        exe.parent()
            .and_then(|p| p.parent().map(|q| q.to_path_buf())),
    ]
    .into_iter()
    .flatten()
    {
        let candidate = dir.join("velatap.dll");
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("velatap.dll not found; set VELATAP_DLL=<path> (build: cargo build -p velatap)".into())
}

fn wait_client(pipe: HANDLE) -> Result<bool, String> {
    let event = unsafe { CreateEventW(None, true, false, None) }
        .map_err(|_| "CreateEventW failed".to_string())?;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event;
    let pending = unsafe { ConnectNamedPipe(pipe, Some(&mut overlapped)) };
    if pending.is_err() {
        let err = windows_core::Error::from_win32();
        // ERROR_PIPE_CONNECTED(535)：客户端已抢先连上 = 成功。
        if err.code() == windows_core::HRESULT(0x8007_0217_u32 as i32) {
            let _ = unsafe { CloseHandle(event) };
            return Ok(true);
        }
        let _ = unsafe { CloseHandle(event) };
        return Err(format!("ConnectNamedPipe: {err}"));
    }
    let waited = unsafe { WaitForSingleObject(event, 35_000) };
    let mut transferred: u32 = 0;
    let ok = unsafe { GetOverlappedResult(pipe, &overlapped, &mut transferred, true) };
    let _ = unsafe { CloseHandle(event) };
    Ok(waited == WAIT_OBJECT_0 && ok.is_ok())
}

// ---------------------------------------------------------------------------
// 管道读写（服务端侧，与 DLL 的客户端实现对称）
// ---------------------------------------------------------------------------

fn send(pipe: HANDLE, msg: &TapMessage) -> Result<(), String> {
    let frame = protocol::encode(msg).map_err(|e| e.to_string())?;
    let mut written: u32 = 0;
    unsafe { WriteFile(pipe, Some(frame.as_slice()), Some(&mut written), None) }
        .map_err(|e| e.to_string())?;
    if written as usize != frame.len() {
        return Err("short write".to_string());
    }
    Ok(())
}

fn recv(pipe: HANDLE) -> Option<TapMessage> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            return protocol::decode(&String::from_utf8_lossy(line)).ok();
        }
        if buf.len() > MAX_FRAME_BYTES {
            return None;
        }
        let mut read: u32 = 0;
        if unsafe { ReadFile(pipe, Some(&mut chunk), Some(&mut read), None) }.is_err() || read == 0
        {
            return None;
        }
        buf.extend_from_slice(&chunk[..read as usize]);
    }
}

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

fn scripted(pipe: HANDLE, args: &[String]) {
    // --accent/--color/--radius/--hold 单发模式。
    let hold: u64 = value_of(args, "--hold")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if let Some(accent) = value_of(args, "--accent") {
        let (r, g, b, a) = color_of(args).unwrap_or((255, 0, 0, 255));
        let radius: u32 = value_of(args, "--radius")
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);
        apply(pipe, accent, r, g, b, a, radius);
        std::thread::sleep(std::time::Duration::from_secs(hold.max(1)));
        return;
    }
    // 无参 --script：走完整演示序列。
    println!("== scripted demo: opaque red 4s ==");
    apply(pipe, "opaque", 255, 0, 0, 255, 30);
    std::thread::sleep(std::time::Duration::from_secs(4));
    println!("== acrylic 4s ==");
    apply(pipe, "acrylic", 0x30, 0x60, 0xA0, 0xB0, 30);
    std::thread::sleep(std::time::Duration::from_secs(4));
    println!("== blur 4s ==");
    apply(pipe, "blur", 0, 0, 0, 0x60, 30);
    std::thread::sleep(std::time::Duration::from_secs(4));
    println!("== clear (fully transparent) 4s ==");
    apply(pipe, "clear", 0, 0, 0, 0, 30);
    std::thread::sleep(std::time::Duration::from_secs(4));
    println!("== normal ==");
    apply(pipe, "normal", 0, 0, 0, 0, 30);
}

fn value_of<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == key {
            return it.next().map(|s| s.as_str());
        }
    }
    None
}

fn color_of(args: &[String]) -> Option<(u8, u8, u8, u8)> {
    let v = value_of(args, "--color")?;
    let parts: Vec<u16> = v.split(',').filter_map(|p| p.parse().ok()).collect();
    match parts.len() {
        3 => Some((parts[0] as u8, parts[1] as u8, parts[2] as u8, 255)),
        4 => Some((
            parts[0] as u8,
            parts[1] as u8,
            parts[2] as u8,
            parts[3] as u8,
        )),
        _ => None,
    }
}

fn repl(pipe: HANDLE) {
    println!(
        "REPL: `opaque|r,g,b[,a]` `clear|...` `acrylic|...` `blur|r,g,b,a,radius` \
         `normal` `border on|off` `ping` `restore` `quit`"
    );
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(cmd) = parts.next() else { continue };
        match cmd {
            "quit" | "exit" | "q" => break,
            "ping" => {
                if send(pipe, &TapMessage::Ping).is_ok() {
                    match recv(pipe) {
                        Some(TapMessage::Pong) => println!("pong"),
                        _ => {
                            println!("no pong (dll gone?)");
                            break;
                        }
                    }
                }
            }
            "restore" => {
                let _ = send(pipe, &TapMessage::RestoreAll);
                println!("restore_all sent");
            }
            "border" => {
                let visible = parts.next().map(|v| v != "off").unwrap_or(true);
                let _ = send(
                    pipe,
                    &TapMessage::SetBorderVisibility {
                        monitor: 0,
                        visible,
                    },
                );
                println!("border visible={visible} sent");
            }
            "opaque" | "clear" | "acrylic" | "blur" | "normal" => {
                let rgba: Vec<u8> = parts
                    .next()
                    .map(|c| {
                        c.split(',')
                            .filter_map(|p| p.parse().ok())
                            .collect::<Vec<u8>>()
                    })
                    .unwrap_or_default();
                let r = rgba.first().copied().unwrap_or(255);
                let g = rgba.get(1).copied().unwrap_or(0);
                let b = rgba.get(2).copied().unwrap_or(0);
                let a = rgba.get(3).copied().unwrap_or(255);
                let radius = rgba.get(4).copied().unwrap_or(30) as u32;
                apply(pipe, cmd, r, g, b, a, radius);
            }
            other => println!("unknown: {other}"),
        }
    }
}

fn apply(pipe: HANDLE, accent: &str, r: u8, g: u8, b: u8, a: u8, radius: u32) {
    let accent = match accent {
        "opaque" => TapAccent::Opaque,
        "clear" => TapAccent::Clear,
        "acrylic" => TapAccent::Acrylic,
        "blur" => TapAccent::Blur,
        _ => TapAccent::Normal,
    };
    let msg = TapMessage::ApplyAppearance {
        monitor: 0,
        accent,
        color_abgr: protocol::pack_abgr(r, g, b, a),
        blur_radius: radius,
    };
    match send(pipe, &msg) {
        Ok(()) => println!("sent: {msg:?}"),
        Err(e) => println!("send failed: {e}"),
    }
    let _ = std::io::stdout().flush();
}
