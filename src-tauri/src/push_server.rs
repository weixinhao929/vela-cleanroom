//! 本地 HTTP 推送入口。
//!
//! 一个极简的回环监听：
//!  - `POST /api/notify` `{ "title": "...", "body": "...", "source": "..." }`：
//!    外部（手机转发工具 / 脚本 / 计划任务 / 局域网 Webhook 桥）推通知，
//!    Rust 校验后 emit `push:received`，前端走与系统通知同一条留档 / 灵动岛
//!    接管链路；
//!  - `POST /api/dispatch` `{ "action": "toggle-palette" | ... }`：远程控制面，
//!    走 shortcuts::dispatch 白名单（与 CLI 命令面同一条分派路径；Stream
//!    Deck / AHK / 自动化脚本的入口）。
//!
//! 安全边界：
//! - 只绑 `127.0.0.1`（不对外网/局域网开放；手机转发工具本机装也走回环）；
//! - **：请求必须携带本进程随机 token**（`Authorization: Bearer
//!   <token>` 或 `X-Push-Token: <token>`）。token 首次启用时生成，写入
//!   `<appdata>/push-token`（用户配置文件目录，本用户可读）。此前任意本机
//!   进程与未强制 PNA 的浏览器页面都能以 Vela 之名投通知/触发白名单动作；
//!   Host/Origin 同时校验（仅接受回环 Host，Origin 存在时必须是回环源，
//!   防浏览器跨站直打）；
//! - 请求头上限 8KB、Body 上限 64KB，超限直接 413 断开；
//! - 任何路径只认 POST，其余 405；未知路径 404；**任何分支都保证回响应**
//!   再关连接。
//!
//! 开关：设置镜像 `notifications.pushEnabled`（默认关）+ `notifications.pushPort`
//! 。监视线程每
//! 2s 重读镜像配置，端口 / 开关变化时关闭旧监听重建（失败只记日志，下一轮
//! 再试）。命令 `set_push_server_config` 供设置页即时生效。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

/// 事件名：收到一条外部推送（载荷 PushReceivedPayload）。
pub const EVENT_PUSH: &str = "push:received";

const DEFAULT_PORT: u16 = 47310;
const HEADER_LIMIT: usize = 8 * 1024;
/** 单条头部行的字节上限：`read_line` 读完整行才返回，无 `\n` 的超长
 *  头可持续分配——用 `take()` 截断单行读取，超限即 431 断开。 */
const MAX_HEADER_LINE: u64 = 4 * 1024;
/** 并发连接线程上限：认证在头部读取之后，无上限的每连接一线程是
 *  未认证本地进程的线程/内存放大面。超限直接 503，不 spawn。 */
const MAX_CONN_THREADS: usize = 16;
/** 活跃连接线程计数（到达时 +1 / 线程退出时 -1，含 panic 路径经 Drop）。 */
static ACTIVE_CONNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/** 连接线程配额守卫：确保任何退出路径（含 panic 展开）都归还配额。 */
struct ConnGuard;
impl ConnGuard {
    fn acquire() -> Option<Self> {
        use std::sync::atomic::Ordering;
        // 先读后增的窗口最多让极少数超额线程通过，超限时收紧即可，无需 CAS 循环。
        if ACTIVE_CONNS.load(Ordering::Relaxed) >= MAX_CONN_THREADS {
            return None;
        }
        ACTIVE_CONNS.fetch_add(1, Ordering::Relaxed);
        Some(ConnGuard)
    }
}
impl Drop for ConnGuard {
    fn drop(&mut self) {
        ACTIVE_CONNS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}
const BODY_LIMIT: usize = 64 * 1024;
const CONFIG_RECHECK_MS: u64 = 2_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReceivedPayload {
    pub title: String,
    pub body: String,
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PushConfig {
    enabled: bool,
    port: u16,
}

impl Default for PushConfig {
    fn default() -> Self {
        PushConfig {
            enabled: false,
            port: DEFAULT_PORT,
        }
    }
}

/// 端口钳制：1–65535 之外的值回默认（设置层前端已钳，这里兜底）。
fn sanitize_port(v: Option<i64>) -> u16 {
    match v {
        Some(p) if (1..=65535).contains(&p) => p as u16,
        _ => DEFAULT_PORT,
    }
}

/// 从设置镜像读推送配置（读失败回默认：关）。字段名即线协议，改名需同步
/// settings-store 的 notifications 切片。：读取收敛到 settings_mirror。
fn read_config(app: &AppHandle) -> PushConfig {
    let Some(v) = crate::settings_mirror::read_json(app) else {
        return PushConfig::default();
    };
    let Some(n) = v.get("notifications") else {
        return PushConfig::default();
    };
    PushConfig {
        enabled: n
            .get("pushEnabled")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        port: sanitize_port(n.get("pushPort").and_then(|p| p.as_i64())),
    }
}

// 设置页持久化镜像后，监视线程 ≤2s 内按新配置重建监听（无独立命令面）。
fn emit_push(app: &AppHandle, payload: &PushReceivedPayload) {
    use tauri::Emitter;
    let _ = app.emit_filter(EVENT_PUSH, payload, |win| match win {
        tauri::EventTarget::WebviewWindow { label }
        | tauri::EventTarget::Webview { label }
        | tauri::EventTarget::Window { label }
        | tauri::EventTarget::AnyLabel { label } => {
            label == "settings" || label.starts_with("widget-")
        }
        _ => false,
    });
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// 本进程推送 token（64 hex，两个 v4 UUID 拼接）。进程内单例：首次启用时
/// 生成并落盘到 `<appdata>/push-token`（覆盖写，外部转发工具读该文件取值）。
fn push_token(app: &AppHandle) -> String {
    use std::sync::OnceLock;
    use tauri::Manager;
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("push-token");
                let content = format!(
                    "{token}\n# Vela 本地推送入口 token（D-2）。用法：\n#   curl -H \"Authorization: Bearer {token}\" -d '{{\"title\":\"t\"}}' http://127.0.0.1:{DEFAULT_PORT}/api/notify\n# token 随进程重启轮换，本文件每次启用时重写。\n"
                );
                if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, content)) {
                    log::warn!("push_server: 写 token 文件失败（{}）: {e}", path.display());
                }
            }
            token
        })
        .clone()
}

/// Host 头只接受回环（127.0.0.1 / localhost / [::1]，端口任意）。
fn host_is_loopback(host: &str) -> bool {
    let bare = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    matches!(bare.trim(), "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

/// Origin 存在时必须是回环源（浏览器跨站请求会被Origin暴露）。
fn origin_allowed(origin: &str) -> bool {
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin);
    host_is_loopback(rest)
}

/// 附带收敛：常量时间字符串相等比较。逐字节 XOR 累加、长度差并入
/// 结果，发现差异后仍消费完全部输入——比较耗时只与输入长度相关，与内容
/// 及首个差异位置无关。严格说回环监听下时序侧信道不可利用（本机攻击者
/// 本就能读 token 文件），这里只是顺手把 `!=` 收敛为不泄漏比较进度的实现。
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // 差异累加到 usize：长度异或若截断成 u8 会丢信息（如 0 与 256 恰好
    // 清零）；循环里越界侧取 0，多出的非零字节仍会贡献差异，双保险判等。
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0) as usize;
        let y = b.get(i).copied().unwrap_or(0) as usize;
        diff |= x ^ y;
    }
    diff == 0
}

/// 请求命中的业务路由（authorize_request 全部校验通过后给出）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    /// POST /api/notify：外部推送 → emit `push:received`。
    Notify,
    /// POST /api/dispatch：远程控制面 → shortcuts::dispatch 白名单。
    Dispatch,
}

/// 单请求「校验+路由+解析」的决策结果。handle_conn 只按决策执行
/// IO 副作用（回写响应 / dispatch / emit），纯逻辑全部收敛在
/// authorize_request 与 handle_body 两个可表驱动测试的纯函数里。
#[derive(Debug, PartialEq)]
enum RequestDecision {
    /// 直接回写该状态行与 JSON 体（校验失败 / 载荷非法）。
    Reject(u16, &'static str, &'static str),
    /// /api/dispatch 白名单命中：dispatch(action) 后回 200。
    Dispatch(String),
    /// /api/notify 合法载荷：emit `push:received` 后回 200。
    Notify(PushReceivedPayload),
}

/// 读体之前的校验与路由（纯函数，从 handle_conn 原样抽出，检查
/// 顺序保持不变：host → origin → token → method → 路由 → Content-Length
/// 上限——token 先于方法/路由，未认证请求不泄漏任何业务分支信息）。
/// Ok = 命中路由、继续读体；Err = 直接回写的 (状态码, reason, JSON 体)。
fn authorize_request(
    method: &str,
    path: &str,
    auth_header: &str,
    host_header: &str,
    origin_header: &str,
    content_length: Option<usize>,
    expected_token: &str,
) -> Result<Route, (u16, &'static str, &'static str)> {
    if !host_is_loopback(host_header) {
        return Err((403, "Forbidden", "{\"ok\":false,\"error\":\"host\"}"));
    }
    if !origin_header.is_empty() && !origin_allowed(origin_header) {
        return Err((403, "Forbidden", "{\"ok\":false,\"error\":\"origin\"}"));
    }
    if !constant_time_eq(auth_header, expected_token) {
        return Err((
            401,
            "Unauthorized",
            "{\"ok\":false,\"error\":\"token（见 <appdata>/push-token）\"}",
        ));
    }
    if method != "POST" {
        return Err((405, "Method Not Allowed", "{\"ok\":false}"));
    }
    // 精确段匹配——`starts_with` 会把 `/api/notifyX` 之类同前缀路径
    // 也放行业务分支；只接受裸路径（可选尾斜杠）。
    let route = match path.trim_end_matches('/') {
        "/api/notify" => Route::Notify,
        "/api/dispatch" => Route::Dispatch,
        _ => return Err((404, "Not Found", "{\"ok\":false}")),
    };
    if content_length.unwrap_or(0) > BODY_LIMIT {
        return Err((413, "Payload Too Large", "{\"ok\":false}"));
    }
    Ok(route)
}

/// 读体之后的解析与业务分支（纯函数，从 handle_conn 原样抽出）：
/// JSON 解析、[DISPATCH] 动作白名单、notify 载荷规范化与空载荷检查。
/// 不做任何 IO——emit / dispatch / 回响应由 handle_conn 按决策执行。
fn handle_body(route: Route, body: &[u8]) -> RequestDecision {
    let parsed: Result<serde_json::Value, _> = serde_json::from_slice(body);

    // [DISPATCH]动作白名单：只放「无参数、幂等、本地可见」
    // 的唤起/开关类动作（电源、截图等不在此列——那是本地键盘的事）。
    if route == Route::Dispatch {
        const DISPATCH_ACTIONS: [&str; 7] = [
            "toggle-pomodoro",
            "toggle-layer",
            "show-settings",
            "new-task",
            "toggle-palette",
            "toggle-dock",
            "open-dock-panel",
        ];
        let action = parsed
            .as_ref()
            .ok()
            .and_then(|v| v.get("action"))
            .and_then(|a| a.as_str())
            .unwrap_or("");
        if !DISPATCH_ACTIONS.contains(&action) {
            return RequestDecision::Reject(
                400,
                "Bad Request",
                "{\"ok\":false,\"error\":\"unknown action\"}",
            );
        }
        return RequestDecision::Dispatch(action.to_string());
    }

    match parsed {
        Ok(v) => {
            let title = v
                .get("title")
                .and_then(|t| t.as_str())
                .map(crate::sysnotify::normalize_single_line)
                .unwrap_or_default();
            let body = v
                .get("body")
                .or_else(|| v.get("subtitle"))
                .and_then(|t| t.as_str())
                .map(crate::sysnotify::normalize_single_line)
                .unwrap_or_default();
            let source = v
                .get("source")
                .or_else(|| v.get("kind"))
                .and_then(|t| t.as_str())
                .map(crate::sysnotify::normalize_single_line)
                .unwrap_or_else(|| "push".to_string());
            if title.is_empty() && body.is_empty() {
                return RequestDecision::Reject(
                    400,
                    "Bad Request",
                    "{\"ok\":false,\"error\":\"empty\"}",
                );
            }
            RequestDecision::Notify(PushReceivedPayload {
                title,
                body,
                source,
            })
        }
        Err(_) => {
            RequestDecision::Reject(400, "Bad Request", "{\"ok\":false,\"error\":\"bad json\"}")
        }
    }
}

/// 处理单连接：读请求行 + 头 + 体，解析 JSON，emit 事件，回响应。
fn handle_conn(app: &AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    // 请求行同样经 take() 封顶——只封了头部行，`read_line` 要读到
    // \n 才返回，未认证的本机进程可在 5s 读超时窗口内无换行持续灌入，String
    // 无界增长（回环带宽下单连接可达数百 MB），×16 线程封顶放大为内存 DoS。
    // 超限回 431 断开，复用头部单行的判定语义。
    let mut request_line = String::new();
    let rl_n = reader
        .by_ref()
        .take(MAX_HEADER_LINE)
        .read_line(&mut request_line)
        .unwrap_or(0);
    if rl_n == 0 {
        return;
    }
    if rl_n as u64 >= MAX_HEADER_LINE && !request_line.ends_with('\n') {
        respond(
            &mut stream,
            431,
            "Request Header Fields Too Large",
            "{\"ok\":false}",
        );
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // 头部：读到空行；总字节上限 HEADER_LIMIT，单行经 take() 截断。
    // 同时收集认证/来源头。
    let mut content_length: Option<usize> = None;
    let mut auth_header = String::new();
    let mut host_header = String::new();
    let mut origin_header = String::new();
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let n = reader
            .by_ref()
            .take(MAX_HEADER_LINE)
            .read_line(&mut line)
            .unwrap_or(0);
        if n == 0 {
            return;
        }
        // take() 截断（读满上限且行未终结）= 单行超限，直接 431 断开。
        if n as u64 >= MAX_HEADER_LINE && !line.ends_with('\n') {
            respond(
                &mut stream,
                431,
                "Request Header Fields Too Large",
                "{\"ok\":false}",
            );
            return;
        }
        header_bytes += n;
        if header_bytes > HEADER_LIMIT {
            respond(
                &mut stream,
                431,
                "Request Header Fields Too Large",
                "{\"ok\":false}",
            );
            return;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let k = k.trim();
            let v = v.trim();
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.parse::<usize>().ok();
            } else if k.eq_ignore_ascii_case("authorization") {
                auth_header = v.to_string();
            } else if k.eq_ignore_ascii_case("x-push-token") {
                auth_header = format!("Bearer {v}");
            } else if k.eq_ignore_ascii_case("host") {
                host_header = v.to_string();
            } else if k.eq_ignore_ascii_case("origin") {
                origin_header = v.to_string();
            }
        }
    }

    // 读体前的校验+路由收敛到 authorize_request（检查顺序与原
    // 内联实现一致），handle_conn 只保留 IO。token 在此提前取用：原实现
    // 在 host/origin 之后才首次生成，但 push_token 是进程级 OnceLock，任何
    // 本机进程都能伪造回环 Host 头先行触发，生成时机不构成可观测差异。
    let expected_token = format!("Bearer {}", push_token(app));
    let route = match authorize_request(
        method,
        path,
        &auth_header,
        &host_header,
        &origin_header,
        content_length,
        &expected_token,
    ) {
        Ok(route) => route,
        Err((status, reason, body)) => {
            respond(&mut stream, status, reason, body);
            return;
        }
    };

    let len = content_length.unwrap_or(0);
    let mut body_bytes = vec![0u8; len];
    if reader.read_exact(&mut body_bytes).is_err() {
        respond(&mut stream, 400, "Bad Request", "{\"ok\":false}");
        return;
    }

    // 读体后的解析/白名单/载荷规范化同样收敛到纯函数 handle_body；
    // [DISPATCH]远程控制面走 shortcuts::dispatch 白名单
    // （与 CLI 命令面同一条分派路径）。
    match handle_body(route, &body_bytes) {
        RequestDecision::Dispatch(action) => {
            log::info!("push_server: dispatch [{action}]");
            crate::shortcuts::dispatch(app, &action);
            respond(&mut stream, 200, "OK", "{\"ok\":true}");
        }
        RequestDecision::Notify(payload) => {
            log::info!(
                "push_server: received [{}] {}",
                payload.source,
                payload.title
            );
            emit_push(app, &payload);
            respond(&mut stream, 200, "OK", "{\"ok\":true}");
        }
        RequestDecision::Reject(status, reason, body) => {
            respond(&mut stream, status, reason, body);
        }
    }
}

pub fn start_push_server(app: AppHandle) {
    std::thread::Builder::new()
        .name("push-server".into())
        .spawn(move || {
            let mut current: Option<(u16, TcpListener)> = None;
            let mut last_config = PushConfig::default();
            let mut next_recheck = std::time::Instant::now();
            //bind 失败去重——同 (端口, 错误串) 只 warn 一次，端口被
            // 长期占用时不随 2s 复查刷屏（此前 ≈4.3 万行/天淹没有效日志）。
            let mut last_bind_err: Option<(u16, String)> = None;
            // （missed-wakeup）：代数取于 read_config 之前并在每次复查时
            // 刷新——变更若落在「读取之后、进入等待之前」，wait_for_change_since
            // 因代数已前进而立即返回，不再睡满 CONFIG_RECHECK_MS。
            let mut mirror_seen = crate::settings_mirror::generation();
            loop {
                // 配置复查（SQLite 读）每 2s 一次；窗口内只做轻量 accept 轮询。
                if std::time::Instant::now() >= next_recheck {
                    next_recheck =
                        std::time::Instant::now() + Duration::from_millis(CONFIG_RECHECK_MS);
                    mirror_seen = crate::settings_mirror::generation();
                    let cfg = read_config(&app);
                    if cfg != last_config {
                        log::info!(
                            "push_server: config -> enabled={} port={}",
                            cfg.enabled,
                            cfg.port
                        );
                        last_config = cfg;
                        current = None; // 关旧监听（drop），下面按需重建。
                    }
                    if !last_config.enabled {
                        current = None;
                        continue;
                    }
                    if current.is_none()
                        || current
                            .as_ref()
                            .map(|(p, _)| *p != last_config.port)
                            .unwrap_or(false)
                    {
                        match TcpListener::bind(("127.0.0.1", last_config.port)) {
                            Ok(l) => {
                                let _ = l.set_nonblocking(true);
                                current = Some((last_config.port, l));
                                last_bind_err = None;
                                log::info!(
                                    "push_server: listening on 127.0.0.1:{}",
                                    last_config.port
                                );
                            }
                            Err(e) => {
                                // 绑定失败（端口被占等）：退避到下一轮配置复查再试。
                                let sig = (last_config.port, e.to_string());
                                if last_bind_err.as_ref() != Some(&sig) {
                                    log::warn!(
                                        "push_server: bind 127.0.0.1:{} failed: {e}",
                                        last_config.port
                                    );
                                    last_bind_err = Some(sig);
                                }
                                current = None;
                                continue;
                            }
                        }
                    }
                }
                // 非阻塞 accept：批量收割就绪连接（每连接独立线程处理）。
                if let Some((_, listener)) = &current {
                    loop {
                        match listener.accept() {
                            Ok((stream, _addr)) => {
                                // 并发连接线程封顶——认证在头部读取之后，
                                // 无上限 spawn 是未认证本地进程的线程放大面。
                                let Some(guard) = ConnGuard::acquire() else {
                                    let mut s = stream;
                                    respond(&mut s, 503, "Service Unavailable", "{\"ok\":false}");
                                    continue;
                                };
                                let app2 = app.clone();
                                std::thread::spawn(move || {
                                    let _quota = guard;
                                    handle_conn(&app2, stream);
                                });
                            }
                            Err(e)
                                if e.kind() == std::io::ErrorKind::WouldBlock
                                    || e.kind() == std::io::ErrorKind::Interrupted =>
                            {
                                break;
                            }
                            Err(e) => {
                                log::warn!("push_server: accept failed: {e}");
                                current = None; // 监听已坏：下一轮重建。
                                break;
                            }
                        }
                    }
                }
                // 禁用态不再 100ms 空醒——等镜像变更即醒（2s 兜底），
                // 醒来立即复查配置；启用态维持 100ms accept 轮询。
                // 评估：启用态的 100ms 轮询保留（10 次/秒的空 accept 是
                // 微秒级 syscall）——改阻塞 accept 需要把 listener 移交独立
                // 线程并跨线程关闭唤醒，Windows 上没有安全的 std 途径，复杂度
                // 不成比例；真正的放大面已由连接线程封顶（MAX_CONN_THREADS）收口。
                if last_config.enabled {
                    std::thread::sleep(Duration::from_millis(100));
                } else {
                    crate::settings_mirror::wait_for_change_since(
                        mirror_seen,
                        Duration::from_millis(CONFIG_RECHECK_MS),
                    );
                    next_recheck = std::time::Instant::now();
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_off() {
        let c = PushConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.port, DEFAULT_PORT);
    }

    #[test]
    fn port_sanitizer_rejects_out_of_range() {
        assert_eq!(sanitize_port(Some(8080)), 8080);
        assert_eq!(sanitize_port(Some(0)), DEFAULT_PORT);
        assert_eq!(sanitize_port(Some(70000)), DEFAULT_PORT);
        assert_eq!(sanitize_port(None), DEFAULT_PORT);
        assert_eq!(sanitize_port(Some(1)), 1);
        assert_eq!(sanitize_port(Some(65535)), 65535);
    }

    /// 来源校验语义——只认回环 Host 与回环 Origin。
    #[test]
    fn loopback_guards() {
        for h in [
            "127.0.0.1",
            "127.0.0.1:47310",
            "localhost",
            "localhost:47310",
            "[::1]:47310",
        ] {
            assert!(host_is_loopback(h), "{h} 应放行");
        }
        for h in [
            "example.com",
            "example.com:80",
            "192.168.1.4",
            "[::ffff:1.2.3.4]",
            "",
        ] {
            assert!(!host_is_loopback(h), "{h} 应拒绝");
        }
        for o in ["http://127.0.0.1:5173", "http://localhost:3000", "null"] {
            // "null" Origin（沙箱 iframe）按 bare 串处理：不匹配回环 → 拒绝
            assert_eq!(origin_allowed(o), o != "null", "{o}");
        }
        assert!(!origin_allowed("https://evil.example"));
        assert!(!origin_allowed("http://192.168.1.4:8080"));
    }

    // ---- ：请求主干（authorize_request / handle_body 纯函数） ----

    /// 测试用期望 token（与真实 64-hex token 同构）。
    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// 读体前校验+路由的表驱动覆盖：合法放行 / 401 / 403 / 405 / 404（
    /// 前缀路径回归）/ 413，以及「token 校验先于方法与路由」的顺序锁定。
    #[test]
    fn authorize_request_table() {
        let bearer = format!("Bearer {TEST_TOKEN}");
        // (method, path, auth, host, origin, content_length, 期望 Ok(路由)|Err(状态码))
        type Case<'a> = (
            &'a str,
            &'a str,
            &'a str,
            &'a str,
            &'a str,
            Option<usize>,
            Result<Route, u16>,
        );
        let cases: Vec<Case> = vec![
            (
                "POST",
                "/api/notify",
                &bearer,
                "127.0.0.1:47310",
                "",
                Some(2),
                Ok(Route::Notify),
            ),
            (
                "POST",
                "/api/dispatch",
                &bearer,
                "localhost",
                "",
                None,
                Ok(Route::Dispatch),
            ),
            // 尾斜杠归一（trim_end_matches 语义）：裸路径或带尾斜杠都命中。
            (
                "POST",
                "/api/notify/",
                &bearer,
                "127.0.0.1",
                "",
                Some(0),
                Ok(Route::Notify),
            ),
            (
                "POST",
                "/api/dispatch//",
                &bearer,
                "127.0.0.1",
                "",
                None,
                Ok(Route::Dispatch),
            ),
            // 回环 Origin（本地开发服务器页面）放行。
            (
                "POST",
                "/api/notify",
                &bearer,
                "127.0.0.1",
                "http://127.0.0.1:5173",
                Some(0),
                Ok(Route::Notify),
            ),
            (
                "POST",
                "/api/notify",
                &bearer,
                "[::1]:47310",
                "http://localhost:3000",
                None,
                Ok(Route::Notify),
            ),
            // token 错误 / 缺失 → 401。
            (
                "POST",
                "/api/notify",
                "Bearer wrong-token",
                "127.0.0.1",
                "",
                None,
                Err(401),
            ),
            ("POST", "/api/notify", "", "127.0.0.1", "", None, Err(401)),
            // 非回环 / 缺失 Host → 403（host 分支）。
            (
                "POST",
                "/api/notify",
                &bearer,
                "example.com",
                "",
                None,
                Err(403),
            ),
            ("POST", "/api/notify", &bearer, "", "", None, Err(403)),
            (
                "POST",
                "/api/notify",
                &bearer,
                "192.168.1.4:8080",
                "",
                None,
                Err(403),
            ),
            // 非法 Origin → 403（origin 分支）。
            (
                "POST",
                "/api/notify",
                &bearer,
                "127.0.0.1",
                "https://evil.example",
                None,
                Err(403),
            ),
            // 顺序锁定：token 先于方法——错 token 的 GET 是 401 而非 405。
            (
                "GET",
                "/api/notify",
                "Bearer wrong-token",
                "127.0.0.1",
                "",
                None,
                Err(401),
            ),
            // 方法非 POST → 405。
            (
                "GET",
                "/api/notify",
                &bearer,
                "127.0.0.1",
                "",
                None,
                Err(405),
            ),
            (
                "PUT",
                "/api/notify",
                &bearer,
                "127.0.0.1",
                "",
                None,
                Err(405),
            ),
            // 回归：同前缀路径不放行（精确段匹配）。
            (
                "POST",
                "/api/notifyX",
                &bearer,
                "127.0.0.1",
                "",
                None,
                Err(404),
            ),
            (
                "POST",
                "/api/dispatch2",
                &bearer,
                "127.0.0.1",
                "",
                None,
                Err(404),
            ),
            ("POST", "/", &bearer, "127.0.0.1", "", None, Err(404)),
            // Content-Length 超 BODY_LIMIT → 413（读体之前按头拒绝）。
            (
                "POST",
                "/api/notify",
                &bearer,
                "127.0.0.1",
                "",
                Some(BODY_LIMIT + 1),
                Err(413),
            ),
            (
                "POST",
                "/api/notify",
                &bearer,
                "127.0.0.1",
                "",
                Some(BODY_LIMIT),
                Ok(Route::Notify),
            ),
        ];
        for (i, (m, p, a, h, o, len, want)) in cases.into_iter().enumerate() {
            let got = authorize_request(m, p, a, h, o, len, &bearer).map_err(|(s, _, _)| s);
            assert_eq!(
                got, want,
                "case #{i}: {m} {p} host={h:?} origin={o:?} len={len:?}"
            );
        }
    }

    /// /api/dispatch 分支：7 个白名单动作放行；未知/缺失/非字符串 action、
    /// 非 JSON 一律 400（与 CLI 命令面同一条白名单，不 panic）。
    #[test]
    fn handle_body_dispatch_whitelist() {
        for a in [
            "toggle-pomodoro",
            "toggle-layer",
            "show-settings",
            "new-task",
            "toggle-palette",
            "toggle-dock",
            "open-dock-panel",
        ] {
            let body = format!("{{\"action\":\"{a}\"}}");
            assert_eq!(
                handle_body(Route::Dispatch, body.as_bytes()),
                RequestDecision::Dispatch(a.to_string()),
                "{a} 应在白名单内"
            );
        }
        let unknown = RequestDecision::Reject(
            400,
            "Bad Request",
            "{\"ok\":false,\"error\":\"unknown action\"}",
        );
        assert_eq!(
            handle_body(Route::Dispatch, br#"{"action":"rm -rf /"}"#),
            unknown
        );
        assert_eq!(handle_body(Route::Dispatch, b"not json"), unknown);
        assert_eq!(handle_body(Route::Dispatch, br#"{}"#), unknown);
        assert_eq!(handle_body(Route::Dispatch, br#"{"action":123}"#), unknown);
        assert_eq!(handle_body(Route::Dispatch, b""), unknown);
    }

    /// /api/notify 分支：载荷规范化（normalize_single_line 折叠控制字符/
    /// 空白）、subtitle/kind 别名、source 缺省 "push"、空载荷 400、坏 JSON
    /// 400（均不 panic）。
    #[test]
    fn handle_body_notify_normalizes_payload() {
        // 给定：合法 JSON（subtitle/kind 别名 + 控制字符与首尾空白混合）；
        // 当：走 notify 分支；then：三个字段都单行规范化。
        assert_eq!(
            handle_body(
                Route::Notify,
                r#"{"title":"  会议\r\n通知 ","subtitle":"今晚\r\n8点","kind":"calendar"}"#
                    .as_bytes()
            ),
            RequestDecision::Notify(PushReceivedPayload {
                title: "会议 通知".into(),
                body: "今晚 8点".into(),
                source: "calendar".into(),
            })
        );
        // source/body 缺省：source → "push"，body → 空；title 独非空即放行。
        assert_eq!(
            handle_body(Route::Notify, br#"{"title":"t"}"#),
            RequestDecision::Notify(PushReceivedPayload {
                title: "t".into(),
                body: String::new(),
                source: "push".into(),
            })
        );
        let empty =
            RequestDecision::Reject(400, "Bad Request", "{\"ok\":false,\"error\":\"empty\"}");
        assert_eq!(
            handle_body(Route::Notify, br#"{"title":"","body":""}"#),
            empty
        );
        assert_eq!(handle_body(Route::Notify, br#"{}"#), empty);
        // 坏 JSON → 400 bad json。
        assert_eq!(
            handle_body(Route::Notify, b"{oops"),
            RequestDecision::Reject(400, "Bad Request", "{\"ok\":false,\"error\":\"bad json\"}")
        );
    }

    /// 请求主干端到端（纯函数级）：token 正确 + POST /api/notify + 合法
    /// JSON → 200 对应的 Notify 决策，载荷逐字段断言。
    #[test]
    fn request_pipeline_notify_ok() {
        let bearer = format!("Bearer {TEST_TOKEN}");
        let body = r#"{"title":"会议提醒","body":"10:00 开始","source":"phone"}"#.as_bytes();
        let route = authorize_request(
            "POST",
            "/api/notify",
            &bearer,
            "127.0.0.1",
            "",
            Some(body.len()),
            &bearer,
        )
        .expect("合法请求应通过校验");
        assert_eq!(route, Route::Notify);
        assert_eq!(
            handle_body(route, body),
            RequestDecision::Notify(PushReceivedPayload {
                title: "会议提醒".into(),
                body: "10:00 开始".into(),
                source: "phone".into(),
            })
        );
    }

    /// 附带收敛：常量时间比较与 `==` 等值语义等价（含边界与长度差）。
    #[test]
    fn constant_time_eq_equivalence() {
        let a = format!("Bearer {TEST_TOKEN}");
        assert!(constant_time_eq(&a, &a));
        assert!(constant_time_eq("", ""));
        assert!(constant_time_eq("中文 token", "中文 token"));
        for (x, y) in [
            ("abcdef", "abcdeX"),  // 尾部差异
            ("abcdef", "Xbcdef"),  // 首部差异
            ("abcdef", "abXdef"),  // 中部差异
            ("abcdef", "abcdef0"), // 前缀关系（长度不同）
            ("", "x"),
            ("Bearer abc", "Bearer:abc"),
            (TEST_TOKEN, "Bearer x"),
        ] {
            assert_eq!(constant_time_eq(x, y), x == y, "{x:?} vs {y:?}");
            assert_eq!(constant_time_eq(y, x), y == x, "对称性: {x:?} vs {y:?}");
        }
        // 长度差恰为 256 的病态样本：长度异或若截断成 u8 恰好清零，
        // 越界侧补 0 的循环兜底必须仍判不等。
        assert!(!constant_time_eq(&"\0".repeat(256), ""));
    }
}
