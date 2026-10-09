//! 注入管道——主进程侧服务端。
//!
//! 角色按 [`crate::taskbar::protocol`] 冻结契约：**主进程是服务端**，注入
//! 前先建管道实例（无竞态），DLL 加载后作为客户端 `CreateFileW` 连接。
//! 本文件实现：
//!
//! - [`PipeListener`]：`CreateNamedPipeW` 建实例 → overlapped
//!   `ConnectNamedPipe` 带超时等客户端（超时即弃实例：先 `CancelIoEx` 并等
//!   挂起 IO 真正完成，再关闭句柄——OVERLAPPED 在完成前必须保持有效）。
//! ：接受连接后用 `GetNamedPipeClientProcessId` 校验客户端进程就是
//!   注入时记录的 explorer PID（对端方向对称校验，见 DLL 侧 pipe_client.rs
//! 的 `GetNamedPipeServerProcessId`）——管道名可预测（只含 explorer
//!   PID），同用户恶意进程可抢先 `CreateFileW` 连上并回一个版本匹配的
//!   `Ready`（协议明文 JSON、版本号公开），冒充 DLL 骗取外观下发。身份
//!   不符即 `DisconnectNamedPipe` 断开、同一实例继续等真 DLL；
//! - [`Pipe`]：已连接会话。[`Pipe::send`] 写一整帧（互斥串行化 + 2s 超时，
//! 「对 explorer 的跨进程调用一律带超时」；超时视为连接失效，整个
//!   会话拆除）；[`Pipe::spawn_reader`] 起读线程逐行解码（NDJSON，单帧 ≤
//!   [`protocol::MAX_FRAME_BYTES`]）回调上层；[`Pipe::shutdown`] 关句柄令
//!   所有挂起 IO 立即失败、线程自然退出。
//! - [`Pipe::handshake`]：连接后主进程发 [`TapMessage::Hello`]（带本侧
//!   [`protocol::PROTOCOL_VERSION`]），对端回 `Ready`（带对端版本）——
//! 比对两侧版本（TAP_API_VERSION 校验）。
//!
//! # kernel32 动态绑定说明
//! `CreateNamedPipeW` / `ConnectNamedPipe` / `GetOverlappedResult` /
//! `ReadFile` / `WriteFile`（overlapped 形态）/ `CancelIoEx` 在 windows crate 里按
//! `Win32_System_Pipes` / `Win32_System_IO` feature 门控，而主 crate 的
//! features 清单由 CORE 定死后其余会话不再改 Cargo.toml——因此这些
//! kernel32 导出经 `GetProcAddress` 动态取（加载一次缓存于 [`imp::api`]），
//! 签名手写对齐 Win32 ABI；`OVERLAPPED` 布局是稳定 ABI（`Internal` /
//! `InternalHigh` / `Offset` / `OffsetHigh` / `hEvent`），同样手写。其余
//! （事件 / 等待 / 句柄）走已启用 feature 的 typed API。追加的
//! `GetNamedPipeClientProcessId` / `DisconnectNamedPipe` 同属 `Win32_System_Pipes`
//! 门控，同样动态绑定。
//!
//! 非 Windows 平台：[`Pipe`] 为不可用桩（模块整体在该平台恒 Degraded）。

use std::sync::Arc;
use std::time::Duration;

use super::protocol::{self, TapMessage};

/// 写超时（§5.2「管道写入带超时」）。
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
/// 等客户端连接的默认超时（注入期握手整体 35s 由调用方给足；断连重连
/// 等待用本短超时，超时弃实例再重建——不重复注入）。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 握手失败分类。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeError {
    /// 对端 `Ready` 回的版本与本侧不一致（注入 Failed，文案提示
    /// 重启资源管理器：不强杀 explorer）。
    VersionMismatch { ours: u32, theirs: u32 },
    /// IO / 超时 / 帧损坏等，message 已面向用户。
    Io(String),
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::VersionMismatch { ours, theirs } => write!(
                f,
                "协议版本不匹配（DLL v{theirs} / 主进程 v{ours}），需要重启资源管理器后重试"
            ),
            HandshakeError::Io(m) => f.write_str(m),
        }
    }
}

/// 行解码累积器：喂字节、吐完整行（不含 `\n`）；单条超过
/// [`protocol::MAX_FRAME_BYTES`] 即判协议破坏（溢出标志），调用方断开。
#[derive(Debug, Default)]
pub struct LineDecoder {
    buf: Vec<u8>,
}

impl LineDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 返回 `(完整行, 溢出标志)`。溢出时内部缓冲已清空，上层应断开连接。
    pub fn feed(&mut self, bytes: &[u8]) -> (Vec<String>, bool) {
        let mut lines = Vec::new();
        for &b in bytes {
            if b == b'\n' {
                let line = String::from_utf8_lossy(&self.buf).into_owned();
                self.buf.clear();
                lines.push(line);
            } else {
                self.buf.push(b);
                if self.buf.len() > protocol::MAX_FRAME_BYTES {
                    self.buf.clear();
                    return (lines, true);
                }
            }
        }
        (lines, false)
    }
}

#[cfg(windows)]
mod imp {
    //! 真管道实现（kernel32 动态绑定见父模块文档）。

    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use windows::core::{s, w, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    use super::super::protocol::{self, TapMessage};
    use super::LineDecoder;

    /* ---------------- kernel32 动态绑定 ---------------- */

    /// Win32 `OVERLAPPED`（x64/x86 布局一致：两个指针宽 + 两个 DWORD +
    /// 句柄，Rust 自动补齐到指针对齐）。
    #[derive(Clone, Copy)]
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: HANDLE,
    }

    impl Overlapped {
        fn zeroed(event: HANDLE) -> Self {
            Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                h_event: event,
            }
        }
    }

    type FnCreateNamedPipeW = unsafe extern "system" fn(
        PCWSTR,
        u32,           // dwOpenMode
        u32,           // dwPipeMode
        u32,           // nMaxInstances
        u32,           // nOutBufferSize
        u32,           // nInBufferSize
        u32,           // nDefaultTimeOut
        *const c_void, // lpSecurityAttributes
    ) -> *mut c_void; // HANDLE；失败 INVALID_HANDLE_VALUE
    type FnConnectNamedPipe = unsafe extern "system" fn(*mut c_void, *mut Overlapped) -> i32;
    type FnGetOverlappedResult =
        unsafe extern "system" fn(*mut c_void, *mut Overlapped, *mut u32, i32) -> i32;
    type FnReadFile =
        unsafe extern "system" fn(*mut c_void, *mut u8, u32, *mut u32, *mut Overlapped) -> i32;
    type FnWriteFile =
        unsafe extern "system" fn(*mut c_void, *const u8, u32, *mut u32, *mut Overlapped) -> i32;
    type FnCancelIoEx = unsafe extern "system" fn(*mut c_void, *mut Overlapped) -> i32;
    /// BOOL GetNamedPipeClientProcessId(HANDLE, PULONG)——客户端身份校验。
    type FnGetNamedPipeClientProcessId = unsafe extern "system" fn(*mut c_void, *mut u32) -> i32;
    /// BOOL DisconnectNamedPipe(HANDLE)——拒绝冒充客户端后断开、实例复用。
    type FnDisconnectNamedPipe = unsafe extern "system" fn(*mut c_void) -> i32;

    struct Api {
        create_named_pipe: FnCreateNamedPipeW,
        connect_named_pipe: FnConnectNamedPipe,
        get_overlapped_result: FnGetOverlappedResult,
        read_file: FnReadFile,
        write_file: FnWriteFile,
        cancel_io_ex: FnCancelIoEx,
        get_named_pipe_client_pid: FnGetNamedPipeClientProcessId,
        disconnect_named_pipe: FnDisconnectNamedPipe,
    }

    static API: OnceLock<Option<Api>> = OnceLock::new();

    fn api() -> Option<&'static Api> {
        API.get_or_init(|| {
            // SAFETY: kernel32 模块句柄进程级有效；GetProcAddress 仅查导出表。
            unsafe {
                let k32 = GetModuleHandleW(w!("kernel32.dll")).ok()?;
                let p = |name: windows::core::PCSTR| {
                    GetProcAddress(k32, name).map(|f| f as *const c_void)
                };
                Some(Api {
                    // SAFETY: 导出签名与上方手写类型一致（Win32 ABI 冻结）。
                    create_named_pipe: std::mem::transmute::<*const c_void, FnCreateNamedPipeW>(p(
                        s!("CreateNamedPipeW"),
                    )?),
                    connect_named_pipe: std::mem::transmute::<*const c_void, FnConnectNamedPipe>(
                        p(s!("ConnectNamedPipe"))?,
                    ),
                    get_overlapped_result: std::mem::transmute::<
                        *const c_void,
                        FnGetOverlappedResult,
                    >(p(s!("GetOverlappedResult"))?),
                    read_file: std::mem::transmute::<*const c_void, FnReadFile>(p(s!("ReadFile"))?),
                    write_file: std::mem::transmute::<*const c_void, FnWriteFile>(p(s!(
                        "WriteFile"
                    ))?),
                    cancel_io_ex: std::mem::transmute::<*const c_void, FnCancelIoEx>(p(s!(
                        "CancelIoEx"
                    ))?),
                    // SAFETY: 同上（kernel32 稳定导出，签名对齐 Win32 ABI）。
                    get_named_pipe_client_pid: std::mem::transmute::<
                        *const c_void,
                        FnGetNamedPipeClientProcessId,
                    >(p(s!(
                        "GetNamedPipeClientProcessId"
                    ))?),
                    disconnect_named_pipe: std::mem::transmute::<
                        *const c_void,
                        FnDisconnectNamedPipe,
                    >(p(s!("DisconnectNamedPipe"))?),
                })
            }
        })
        .as_ref()
    }

    /// 超时后收尾挂起的 overlapped IO：显式取消，并等到内核真正完成（写回
    /// `over` 的状态块、置事件）之后才允许调用方释放 `over` 与用户缓冲。
    /// MSDN 要求 OVERLAPPED 与缓冲在操作完成前保持有效；仅靠"关句柄即取消"
    /// 的隐式时序，在句柄由另一线程关闭时会让完成通知写入已释放的栈/堆。
    /// 等待有上限：取消后完成通知必到，兜底只为防御异常内核状态。
    fn cancel_and_drain(api: &Api, raw: *mut c_void, over: &mut Overlapped) {
        // SAFETY: raw/over 是本次 IO 使用中的同一对；取消失败（已完成/已关）
        // 也照样等一次，事件在任一情况下都会被置位。
        unsafe {
            let _ = (api.cancel_io_ex)(raw, over);
            let _ = WaitForSingleObject(over.h_event, 5_000);
            let mut n = 0u32;
            let _ = (api.get_overlapped_result)(raw, over, &mut n, 0);
        }
    }

    /* ---------------- 常量（数值见 winbase.h / winuser.h） ---------------- */

    const INVALID_HANDLE: *mut c_void = (-1isize) as *mut c_void;
    /// PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE。
    /// 管道名只含 explorer PID、可预测：加 FIRST_PIPE_INSTANCE 后若同用户其它
    /// 进程已抢注同名管道，CreateNamedPipeW 直接 ERROR_ACCESS_DENIED 而不是
    /// 静默成为第二实例（DLL 可能连到冒充者）。重连期旧实例尚未释放时同样
    /// 会失败——调用方按重试循环处理。
    const OPEN_MODE_DUPLEX_OVERLAPPED: u32 = 0x0000_0003 | 0x4000_0000 | 0x0008_0000;
    /// PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT（全零默认）。
    const PIPE_MODE_BYTE: u32 = 0;
    /// PIPE_UNLIMITED_INSTANCES。
    const MAX_INSTANCES: u32 = 255;
    const IO_BUFFER: u32 = 64 * 1024;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_PIPE_CONNECTED: u32 = 535;
    const WAIT_OBJECT_0: u32 = 0;

    fn last_error() -> u32 {
        // SAFETY: GetLastError 无副作用。
        unsafe { windows::Win32::Foundation::GetLastError().0 as u32 }
    }

    /* ---------------- 句柄与 IO 槽 ---------------- */

    /// 管道句柄守卫：Drop 关闭；`take` 转移所有权（shutdown 用）。
    struct RawPipe(*mut c_void);

    impl Drop for RawPipe {
        fn drop(&mut self) {
            if self.0 != INVALID_HANDLE && !self.0.is_null() {
                // SAFETY: 独占所有权；重复关闭由所有权转移保证不发生。
                unsafe {
                    let _ = CloseHandle(HANDLE(self.0));
                }
            }
        }
    }

    /// 一个（事件 + OVERLAPPED）槽位：同一时刻至多一个挂起 IO；超时后
    /// 会话整体拆除，槽位不再复用（见父模块文档）。
    struct IoSlot {
        event: HANDLE,
        over: Mutex<Overlapped>,
    }

    impl IoSlot {
        fn new() -> Option<Self> {
            // SAFETY: 未命名 auto-reset 事件；失败返 None 由调用方报错。
            let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()).ok()? };
            Some(IoSlot {
                event,
                over: Mutex::new(Overlapped::zeroed(event)),
            })
        }
    }

    impl Drop for IoSlot {
        fn drop(&mut self) {
            // SAFETY: 事件句柄独占。
            unsafe {
                let _ = CloseHandle(self.event);
            }
        }
    }

    /* ---------------- Listener：建实例 + 等客户端 ---------------- */

    pub struct Listener {
        handle: RawPipe,
        /// 期望的客户端 PID（注入目标 explorer）。[`Listener::wait_client`]
        /// 对每个连接校验，不符即断开继续等。
        expected_client_pid: u32,
    }

    // SAFETY: 裸句柄按值移动、独占使用（create → wait_client 单向移交，
    // 无别名无并发），真实路径即注入线程建、泵线程等；测试也跨线程移交。
    unsafe impl Send for Listener {}

    impl Listener {
        /// 创建服务端首实例。名字见 [`protocol::pipe_name`]；`expected_client_pid`
        /// 为注入目标 explorer 的 PID（injector 的 find_tray / 重连时的引擎记录），
        /// 用于客户端身份校验。
        ///
        /// 【残余风险，有意接受】此处的 SECURITY_ATTRIBUTES 传 null（默认
        /// DACL = 同用户可连）：本进程与 explorer 同用户，无法用「调用方用户
        /// SID」区分；限定到 explorer 进程 SID 需要 BuildExplicitAccess +
        /// 每次注入解析 explorer 令牌，而协议本身冻结为颜色/布尔/心跳（无执行
        /// 原语、不 Impersonate）。防线三件套：FILE_FLAG_FIRST_PIPE_INSTANCE
        /// 防抢注（见 create 的调用方）+ DLL 侧对服务端映像的校验
        /// （pipe_client.rs ）+ 本侧 wait_client 的客户端 PID 校验（
        /// 抢注之外的「抢先连接冒充 DLL」也被拒之门外）。
        pub fn create(pipe_name: &str, expected_client_pid: u32) -> Result<Self, String> {
            let Some(api) = api() else {
                return Err("kernel32 管道导出缺失（不支持的 Windows）".to_string());
            };
            let name = windows::core::HSTRING::from(pipe_name);
            // SAFETY: name 生存期覆盖调用；返回句柄被 RawPipe 接管。
            let raw = unsafe {
                (api.create_named_pipe)(
                    PCWSTR(name.as_ptr()),
                    OPEN_MODE_DUPLEX_OVERLAPPED,
                    PIPE_MODE_BYTE,
                    MAX_INSTANCES,
                    IO_BUFFER,
                    IO_BUFFER,
                    0,
                    std::ptr::null(),
                )
            };
            if raw == INVALID_HANDLE || raw.is_null() {
                let err = last_error();
                if err == ERROR_ACCESS_DENIED {
                    return Err(format!(
                        "管道实例已被占用（{pipe_name}；同名管道已存在——上一会话尚未释放或被其它进程抢注）"
                    ));
                }
                return Err(format!("CreateNamedPipeW 失败（错误码 {err}）"));
            }
            Ok(Listener {
                handle: RawPipe(raw),
                expected_client_pid,
            })
        }

        /// 等客户端连接（带超时），并对连接方做身份校验。成功消费 self
        /// 返回会话；失败/超时关闭句柄（挂起的 ConnectNamedPipe 随句柄关闭而
        /// 取消）。身份不符的连接被 `DisconnectNamedPipe` 断开，同一管道实例
        /// 继续等下一个连接直到超时——服务端实例在客户端断开后可重新
        /// `ConnectNamedPipe`（命名管道的串行复用语义）。
        pub fn wait_client(self, timeout: Duration) -> Result<Session, String> {
            let Some(api) = api() else {
                return Err("kernel32 管道导出缺失".to_string());
            };
            let deadline = std::time::Instant::now() + timeout;
            loop {
                let remain = deadline.saturating_duration_since(std::time::Instant::now());
                if remain.is_zero() {
                    return Err(format!("等待 DLL 连接管道超时（{timeout:?}）"));
                }
                let slot = IoSlot::new().ok_or_else(|| "创建管道 IO 事件失败".to_string())?;
                let mut over = Overlapped::zeroed(slot.event);
                // SAFETY: handle 有效；over 仅本轮使用。
                let ok = unsafe { (api.connect_named_pipe)(self.handle.0, &mut over) };
                if ok == 0 {
                    let err = last_error();
                    if err != ERROR_IO_PENDING && err != ERROR_PIPE_CONNECTED {
                        return Err(format!("ConnectNamedPipe 失败（错误码 {err}）"));
                    }
                    if err == ERROR_IO_PENDING {
                        // SAFETY: 事件属本槽位。
                        let wait = unsafe {
                            WaitForSingleObject(
                                slot.event,
                                remain.as_millis().min(u32::MAX as u128) as u32,
                            )
                        };
                        if wait.0 != WAIT_OBJECT_0 {
                            // 超时：ConnectNamedPipe 仍挂起，等它真正完成再让
                            // over/slot 出栈。
                            cancel_and_drain(api, self.handle.0, &mut over);
                            return Err(format!("等待 DLL 连接管道超时（{timeout:?}）"));
                        }
                    }
                    // ERROR_PIPE_CONNECTED：客户端已抢先连上——同样进身份校验。
                }
                // 服务端→DLL 方向的身份校验。管道名只含 explorer PID、
                // 可预测且对同用户进程无连接门槛：恶意进程抢先 CreateFileW
                // 连上、回一个版本匹配的 Ready（协议明文、版本号公开）即可
                // 冒充 DLL 骗取外观下发。对齐 DLL 侧 pipe_client.rs 对服务端
                // 映像校验的口径（查询失败同样按不可信处理），只认注入时记录
                // 的 explorer PID。
                let mut client_pid = 0u32;
                // SAFETY: handle 处于已连接态；出参指针有效。
                let pid_ok =
                    unsafe { (api.get_named_pipe_client_pid)(self.handle.0, &mut client_pid) };
                if pid_ok == 0 || client_pid != self.expected_client_pid {
                    log::warn!(
                        "taskbar pipe: 拒绝管道客户端（pid={client_pid}，期望 explorer pid={}，查询{}），断开后继续等待",
                        self.expected_client_pid,
                        if pid_ok == 0 { "失败" } else { "成功" }
                    );
                    // SAFETY: 本服务端实例对当前客户端独占；断开后实例可复用。
                    unsafe {
                        let _ = (api.disconnect_named_pipe)(self.handle.0);
                    }
                    continue;
                }
                return Session::new(self.handle);
            }
        }
    }

    /* ---------------- Session：双向会话 ---------------- */

    pub struct Session {
        handle: Mutex<Option<RawPipe>>,
        write_lock: Mutex<()>,
        write_slot: IoSlot,
        read_slot: IoSlot,
        alive: Arc<AtomicBool>,
    }

    // SAFETY: 裸句柄全部由锁互斥——写路径 write_lock + write_slot 串行；
    // 读路径在 spawn_reader 前仅握手线程、之后仅读线程（read_slot 交接，
    // 不并发）；句柄关闭由 handle Mutex 的所有权转移唯一执行。跨线程
    // 共享 Arc<Session> 的每个 IO 入口先经锁或线程交接，无数据竞争。
    unsafe impl Send for Session {}
    unsafe impl Sync for Session {}

    impl Session {
        fn new(handle: RawPipe) -> Result<Self, String> {
            let write_slot = IoSlot::new().ok_or_else(|| "创建管道写事件失败".to_string())?;
            let read_slot = IoSlot::new().ok_or_else(|| "创建管道读事件失败".to_string())?;
            Ok(Session {
                handle: Mutex::new(Some(handle)),
                write_lock: Mutex::new(()),
                write_slot,
                read_slot,
                alive: Arc::new(AtomicBool::new(true)),
            })
        }

        fn raw(&self) -> Result<*mut c_void, String> {
            self.handle
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .map(|h| h.0)
                .ok_or_else(|| "管道已关闭".to_string())
        }

        /// 关闭句柄并判死；之后所有 IO 立即失败。
        pub fn shutdown(&self) {
            // take 出所有权 → RawPipe::drop 关句柄。
            let _ = self.handle.lock().unwrap_or_else(|p| p.into_inner()).take();
            self.alive.store(false, Ordering::SeqCst);
        }

        pub fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
                && self
                    .handle
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_some()
        }

        /// 整帧写入，超时即拆除会话（Err）。
        pub fn write_all(&self, bytes: &[u8], timeout: Duration) -> Result<(), String> {
            let _guard = self.write_lock.lock().unwrap_or_else(|p| p.into_inner());
            let Some(api) = api() else {
                return Err("kernel32 管道导出缺失".to_string());
            };
            let raw = self.raw()?;
            let mut over = {
                let mut g = self
                    .write_slot
                    .over
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                *g = Overlapped::zeroed(self.write_slot.event);
                *g
            };
            // SAFETY: raw 有效；over 为写槽当前副本；事件互斥（write_lock）。
            let ok = unsafe {
                (api.write_file)(
                    raw,
                    bytes.as_ptr(),
                    bytes.len().min(u32::MAX as usize) as u32,
                    std::ptr::null_mut(),
                    &mut over,
                )
            };
            if ok == 0 && last_error() != ERROR_IO_PENDING {
                let e = format!("管道写入失败（错误码 {}）", last_error());
                self.shutdown();
                return Err(e);
            }
            if ok == 0 {
                // SAFETY: 写槽事件。
                let wait = unsafe {
                    WaitForSingleObject(
                        self.write_slot.event,
                        timeout.as_millis().min(u32::MAX as u128) as u32,
                    )
                };
                if wait.0 != WAIT_OBJECT_0 {
                    // 超时：WriteFile 仍挂起，先等它完成再关句柄/返回（bytes 是
                    // 调用方的缓冲，返回后即失效）。
                    cancel_and_drain(api, raw, &mut over);
                    self.shutdown();
                    return Err(format!("管道写入超时（{timeout:?}）"));
                }
                let mut written = 0u32;
                // SAFETY: over 已完成；bWait=FALSE 只取字节数。
                let done = unsafe { (api.get_overlapped_result)(raw, &mut over, &mut written, 0) };
                if done == 0 || written as usize != bytes.len() {
                    self.shutdown();
                    return Err("管道写入不完整".to_string());
                }
            }
            Ok(())
        }

        /// 读一段字节（至多缓冲大小），阻塞上限 `timeout`；超时/断开即
        /// 拆除会话并 Err（调用方走 Degraded 重连）。
        pub fn read_some(&self, timeout: Duration) -> Result<Vec<u8>, String> {
            let Some(api) = api() else {
                return Err("kernel32 管道导出缺失".to_string());
            };
            let raw = self.raw()?;
            let mut buf = vec![0u8; 8 * 1024];
            let event = self.read_slot.event;
            let mut over = {
                let mut g = self
                    .read_slot
                    .over
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                *g = Overlapped::zeroed(event);
                *g
            };
            // SAFETY: raw 有效；over 为读槽当前副本（读线程独占或握手期
            // 独占——spawn_reader 前后不并发）。
            let ok = unsafe {
                (api.read_file)(
                    raw,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    std::ptr::null_mut(),
                    &mut over,
                )
            };
            if ok == 0 && last_error() != ERROR_IO_PENDING {
                let e = format!("管道读取失败（错误码 {}）", last_error());
                self.shutdown();
                return Err(e);
            }
            if ok == 0 {
                // SAFETY: 读槽事件。
                let wait = unsafe {
                    WaitForSingleObject(event, timeout.as_millis().min(u32::MAX as u128) as u32)
                };
                if wait.0 != WAIT_OBJECT_0 {
                    // 超时：ReadFile 仍挂起且目标是本函数的 buf，必须等完成再释放。
                    cancel_and_drain(api, raw, &mut over);
                    // 超时不再 shutdown——空闲读超时≠对端死亡
                    // （DLL 无事不主动发消息，1h 无流量是正常稳态），原实现会拆掉
                    // 健康会话造成无谓的断连重建（外观闪一帧默认态）。判死交给
                    // 心跳线程（PING_EPOCH 已防其失守）。握手路径对 Err 自行
                    // shutdown，不受影响。
                    return Err(format!("管道读取超时（{timeout:?}）"));
                }
                let mut n = 0u32;
                // SAFETY: over 已完成。
                let done = unsafe { (api.get_overlapped_result)(raw, &mut over, &mut n, 0) };
                if done == 0 {
                    self.shutdown();
                    return Err(format!("管道读取失败（错误码 {}）", last_error()));
                }
                buf.truncate(n as usize);
            }
            Ok(buf)
        }

        /// 读线程：阻塞读（INFINITE）→ 逐行解码回调；断开时判死并回调
        /// `on_disconnect`。`shutdown` 后残留读立即失败，线程自然退出。
        pub fn spawn_reader(
            self: &Arc<Self>,
            on_message: Arc<dyn Fn(TapMessage) + Send + Sync + 'static>,
            on_disconnect: Arc<dyn Fn() + Send + Sync + 'static>,
        ) {
            let session = Arc::clone(self);
            std::thread::Builder::new()
                .name("vela-tap-reader".to_string())
                .spawn(move || {
                    let mut decoder = LineDecoder::new();
                    while session.is_alive() {
                        match session.read_some(Duration::from_secs(3600)) {
                            Ok(chunk) => {
                                let (lines, overflow) = decoder.feed(&chunk);
                                if overflow {
                                    log::warn!("taskbar pipe: 帧超限，断开连接");
                                    break;
                                }
                                for line in lines {
                                    match protocol::decode(&line) {
                                        Ok(msg) => on_message(msg),
                                        Err(e) => {
                                            log::warn!("taskbar pipe: 丢一条坏帧: {e}");
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                // 空闲读超时≠对端死亡——DLL 无事
                                // 不主动发消息，一小时无流量是正常稳态；原实现超时
                                // 即 shutdown 判死，健康会话被无谓断连重建（外观闪
                                // 一帧默认态）。只记日志继续等，判死交给心跳线程
                                // （PING_EPOCH 防其失守的补丁已在位）。
                                if e.contains("读取超时") {
                                    log::debug!(
                                        "taskbar pipe: 空闲读超时（1h 无流量，正常），继续等待"
                                    );
                                    continue;
                                }
                                if session.is_alive() || !e.contains("已关闭") {
                                    log::info!("taskbar pipe: 读线程退出（{e}）");
                                }
                                break;
                            }
                        }
                    }
                    session.alive.store(false, Ordering::SeqCst);
                    on_disconnect();
                })
                .ok();
        }
    }
}

#[cfg(windows)]
pub use imp::{Listener as PipeListener, Session as PipeSession};

/// 已连接的管道会话句柄（克隆共享同一底层连接；写已互斥串行化）。
#[derive(Clone)]
pub struct Pipe {
    #[cfg(windows)]
    inner: Arc<imp::Session>,
}

impl Pipe {
    /// 由已连接会话构造共享句柄（injector 专用）。
    #[cfg(windows)]
    pub fn from_session(session: PipeSession) -> Self {
        Pipe {
            inner: Arc::new(session),
        }
    }

    /// 在既有连接上完成协议握手：发 `Hello` → 等 `Ready`（整体 `timeout`，
    /// 就绪等待上限 35s）；返回对端宣告的协议版本（等于本侧才 Ok，
    /// 否则 [`HandshakeError::VersionMismatch`]）。约定在
    /// [`Pipe::spawn_reader`] 之前调用（握手期用同步读写独占连接）。
    #[cfg(windows)]
    pub fn handshake(&self, timeout: Duration) -> Result<u32, HandshakeError> {
        let io_err = |m: &str| HandshakeError::Io(m.to_string());
        let hello = protocol::encode(&TapMessage::Hello {
            protocol_version: protocol::PROTOCOL_VERSION,
        })
        .map_err(|e| io_err(&e))?;
        self.inner
            .write_all(&hello, timeout)
            .map_err(|e| io_err(&e))?;
        let deadline = std::time::Instant::now() + timeout;
        let mut decoder = LineDecoder::new();
        loop {
            let remain = deadline.saturating_duration_since(std::time::Instant::now());
            if remain.is_zero() {
                self.shutdown();
                return Err(io_err("等待 DLL 就绪（Ready）超时"));
            }
            match self.inner.read_some(remain) {
                Ok(chunk) => {
                    let (lines, overflow) = decoder.feed(&chunk);
                    if overflow {
                        self.shutdown();
                        return Err(io_err("管道帧超过上限，视为协议破坏断开"));
                    }
                    for line in lines {
                        let msg = protocol::decode(&line).map_err(HandshakeError::Io)?;
                        if let TapMessage::Ready { protocol_version } = msg {
                            if protocol_version == protocol::PROTOCOL_VERSION {
                                return Ok(protocol_version);
                            }
                            return Err(HandshakeError::VersionMismatch {
                                ours: protocol::PROTOCOL_VERSION,
                                theirs: protocol_version,
                            });
                        }
                        // 握手期只认 Ready；其他消息（如 Pong）跳过继续等。
                    }
                }
                Err(e) => {
                    self.shutdown();
                    return Err(io_err(&e));
                }
            }
        }
    }

    /// 发送一条消息（编码 + 整帧写入，2s 超时；超时/断开即 Err 且本会话
    /// 已被拆除，调用方应转 Degraded 走重连）。
    #[cfg(windows)]
    pub fn send(&self, msg: &TapMessage) -> Result<(), String> {
        let frame = protocol::encode(msg)?;
        self.inner
            .write_all(&frame, WRITE_TIMEOUT)
            .map_err(|e| format!("管道写入失败: {e}"))
    }

    /// 启动读线程：逐行解码回调 `on_message`；断开（或 [`Pipe::shutdown`]
    /// 后的残留读失败）时回调 `on_disconnect` 后线程退出。
    #[cfg(windows)]
    pub fn spawn_reader(
        &self,
        on_message: Arc<dyn Fn(TapMessage) + Send + Sync + 'static>,
        on_disconnect: Arc<dyn Fn() + Send + Sync + 'static>,
    ) {
        self.inner.spawn_reader(on_message, on_disconnect);
    }

    /// 主动断开：关句柄，挂起 IO 全部立即失败；之后的 `send` 恒 Err。
    pub fn shutdown(&self) {
        #[cfg(windows)]
        self.inner.shutdown();
    }

    /// 连接是否仍存活（尚未 shutdown 且未观察到断开）。
    pub fn is_alive(&self) -> bool {
        #[cfg(windows)]
        {
            self.inner.is_alive()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
}

#[cfg(not(windows))]
impl Pipe {
    /// 非 Windows 无管道：调用方（injector）在该平台整体 Degraded。
    pub fn send(&self, _msg: &TapMessage) -> Result<(), String> {
        Err("命名管道仅支持 Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_decoder_splits_frames_and_handles_partial() {
        let mut d = LineDecoder::new();
        let (lines, over) = d.feed(b"{\"type\":\"ping\"}\n{\"type\":");
        assert!(!over);
        assert_eq!(lines, ["{\"type\":\"ping\"}"]);
        let (lines, over) = d.feed(b"\"pong\"}\n");
        assert!(!over);
        assert_eq!(lines, ["{\"type\":\"pong\"}"]);
    }

    #[test]
    fn line_decoder_flags_oversized_frame() {
        let mut d = LineDecoder::new();
        let (lines, over) = d.feed(&vec![b'x'; protocol::MAX_FRAME_BYTES + 2]);
        assert!(over, "超 64KiB 帧必须判协议破坏");
        assert!(lines.is_empty());
        // 溢出后缓冲已清空（上层应已断开，此处仅验证不 panic）。
        let (lines, over) = d.feed(b"{}\n");
        assert!(!over);
        assert_eq!(lines, ["{}"]);
    }

    #[test]
    fn line_decoder_tolerates_utf8_lossy() {
        let mut d = LineDecoder::new();
        let (lines, over) = d.feed("中文帧\n".as_bytes());
        assert!(!over);
        assert_eq!(lines.len(), 1);
    }
}

/// 身份校验的真管道往返测试（Windows 专项）：服务端只接纳期望 PID 的
/// 客户端，冒充连接被断开后服务端继续等（而非把它当 DLL 交上层握手）。
#[cfg(all(test, windows))]
mod client_gate_tests {
    use super::PipeListener;
    use std::time::{Duration, Instant};

    fn unique_pipe_name(tag: &str) -> String {
        // 名字掺测试进程 PID + 标签：并行测试用例之间互不抢注
        // （FILE_FLAG_FIRST_PIPE_INSTANCE 对同名第二实例直接拒绝）。
        format!(r"\\.\pipe\vela-pipe-gate-test-{}-{tag}", std::process::id())
    }

    /// 同步字节模式客户端（std::fs 直接打开命名管道）。
    fn open_client(name: &str) -> std::fs::File {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)
            .expect("客户端应能打开命名管道")
    }

    #[test]
    fn wait_client_rejects_mismatched_pid_and_keeps_waiting() {
        let name = unique_pipe_name("reject");
        // 期望 PID=4（System 进程，不会来连管道）→ 本测试进程这个「冒充者」
        // 必须被拒。wait_client 消费 listener，在服务端线程里跑。
        let listener = PipeListener::create(&name, 4).expect("建管道实例");
        let server = std::thread::spawn(move || {
            let started = Instant::now();
            let outcome = listener.wait_client(Duration::from_millis(900));
            (outcome.map(|_session| ()), started.elapsed())
        });
        // 给服务端一点时间进 ConnectNamedPipe，再以错误身份连上。
        std::thread::sleep(Duration::from_millis(100));
        let impostor = open_client(&name);
        let (outcome, elapsed) = server.join().expect("服务端线程正常退出");
        drop(impostor);
        assert!(outcome.is_err(), "冒充客户端（PID 不符）必须被拒绝");
        assert!(
            elapsed >= Duration::from_millis(400),
            "拒绝后应继续等真客户端直到超时（实际耗时 {elapsed:?}），而不是立刻失败"
        );
    }

    #[test]
    fn wait_client_accepts_expected_pid() {
        let name = unique_pipe_name("accept");
        // 期望 PID=本测试进程：客户端线程（同进程）连上应立即被接纳。
        let expected = std::process::id();
        let listener = PipeListener::create(&name, expected).expect("建管道实例");
        let server = std::thread::spawn(move || listener.wait_client(Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(100));
        let client = open_client(&name);
        let outcome = server.join().expect("服务端线程正常退出");
        // Session（Ok 载荷）drop 即关句柄；客户端随后关闭。
        drop(outcome);
        drop(client);
    }
}
