//! 本地 HTTP 推送入口（借鉴 NotchPeninsula 的 47300 端口 /api/activities；
//! ZTools 借鉴 #15 扩展 /api/dispatch 控制面）。
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
//! - **D-2（审查修复）：请求必须携带本进程随机 token**（`Authorization: Bearer
//!   <token>` 或 `X-Push-Token: <token>`）。token 首次启用时生成，写入
//!   `<appdata>/push-token`（用户配置文件目录，本用户可读）。此前任意本机
//!   进程与未强制 PNA 的浏览器页面都能以 Vela 之名投通知/触发白名单动作；
//!   Host/Origin 同时校验（仅接受回环 Host，Origin 存在时必须是回环源，
//!   防浏览器跨站直打）；
//! - 请求头上限 8KB、Body 上限 64KB，超限直接 413 断开；
//! - 任何路径只认 POST，其余 405；未知路径 404；**任何分支都保证回响应**
//!   再关连接（NPS 教训：出错路径不写响应会让客户端挂到超时，keep-alive
//!   下还连累后续请求）。
//!
//! 开关：设置镜像 `notifications.pushEnabled`（默认关）+ `notifications.pushPort`
//! （默认 47310，避开 NPS 常用的 47300，两软件共存不抢端口）。监视线程每
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
const BODY_LIMIT: usize = 64 * 1024;
const CONFIG_RECHECK_MS: u64 = 2_000;

#[derive(Clone, Debug, Serialize)]
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
/// settings-store 的 notifications 切片。A-4：读取收敛到 settings_mirror。
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

/// 处理单连接：读请求行 + 头 + 体，解析 JSON，emit 事件，回响应。
fn handle_conn(app: &AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // 头部：读到空行；总字节上限 HEADER_LIMIT。同时收集认证/来源头（D-2）。
    let mut content_length: Option<usize> = None;
    let mut auth_header = String::new();
    let mut host_header = String::new();
    let mut origin_header = String::new();
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).unwrap_or(0);
        if n == 0 {
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

    // D-2：token 与来源校验先于一切业务分支（未认证请求不给任何业务信息）。
    if !host_is_loopback(&host_header) {
        respond(
            &mut stream,
            403,
            "Forbidden",
            "{\"ok\":false,\"error\":\"host\"}",
        );
        return;
    }
    if !origin_header.is_empty() && !origin_allowed(&origin_header) {
        respond(
            &mut stream,
            403,
            "Forbidden",
            "{\"ok\":false,\"error\":\"origin\"}",
        );
        return;
    }
    let expected_token = format!("Bearer {}", push_token(app));
    if auth_header != expected_token {
        respond(
            &mut stream,
            401,
            "Unauthorized",
            "{\"ok\":false,\"error\":\"token（见 <appdata>/push-token）\"}",
        );
        return;
    }

    if method != "POST" {
        respond(&mut stream, 405, "Method Not Allowed", "{\"ok\":false}");
        return;
    }
    // [DISPATCH]（ZTools 借鉴 #15）远程控制面：POST /api/dispatch {"action": "..."}
    // 走 shortcuts::dispatch 白名单（与 CLI 命令面同一条分派路径）。
    if !path.starts_with("/api/notify") && !path.starts_with("/api/dispatch") {
        respond(&mut stream, 404, "Not Found", "{\"ok\":false}");
        return;
    }
    let len = content_length.unwrap_or(0);
    if len > BODY_LIMIT {
        respond(&mut stream, 413, "Payload Too Large", "{\"ok\":false}");
        return;
    }
    let mut body_bytes = vec![0u8; len];
    if reader.read_exact(&mut body_bytes).is_err() {
        respond(&mut stream, 400, "Bad Request", "{\"ok\":false}");
        return;
    }

    let parsed: Result<serde_json::Value, _> = serde_json::from_slice(&body_bytes);

    // [DISPATCH]（ZTools 借鉴 #15）动作白名单：只放「无参数、幂等、本地可见」
    // 的唤起/开关类动作（电源、截图等不在此列——那是本地键盘的事）。
    if path.starts_with("/api/dispatch") {
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
            respond(
                &mut stream,
                400,
                "Bad Request",
                "{\"ok\":false,\"error\":\"unknown action\"}",
            );
            return;
        }
        log::info!("push_server: dispatch [{action}]");
        crate::shortcuts::dispatch(app, action);
        respond(&mut stream, 200, "OK", "{\"ok\":true}");
        return;
    }

    let payload = match parsed {
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
                respond(
                    &mut stream,
                    400,
                    "Bad Request",
                    "{\"ok\":false,\"error\":\"empty\"}",
                );
                return;
            }
            PushReceivedPayload {
                title,
                body,
                source,
            }
        }
        Err(_) => {
            respond(
                &mut stream,
                400,
                "Bad Request",
                "{\"ok\":false,\"error\":\"bad json\"}",
            );
            return;
        }
    };

    log::info!(
        "push_server: received [{}] {}",
        payload.source,
        payload.title
    );
    emit_push(app, &payload);
    respond(&mut stream, 200, "OK", "{\"ok\":true}");
}

pub fn start_push_server(app: AppHandle) {
    std::thread::Builder::new()
        .name("push-server".into())
        .spawn(move || {
            let mut current: Option<(u16, TcpListener)> = None;
            let mut last_config = PushConfig::default();
            let mut next_recheck = std::time::Instant::now();
            loop {
                // 配置复查（SQLite 读）每 2s 一次；窗口内只做轻量 accept 轮询。
                if std::time::Instant::now() >= next_recheck {
                    next_recheck =
                        std::time::Instant::now() + Duration::from_millis(CONFIG_RECHECK_MS);
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
                                log::info!(
                                    "push_server: listening on 127.0.0.1:{}",
                                    last_config.port
                                );
                            }
                            Err(e) => {
                                // 绑定失败（端口被占等）：退避到下一轮配置复查再试。
                                log::warn!(
                                    "push_server: bind 127.0.0.1:{} failed: {e}",
                                    last_config.port
                                );
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
                                let app2 = app.clone();
                                std::thread::spawn(move || handle_conn(&app2, stream));
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
                // B-4：禁用态不再 100ms 空醒——等镜像变更即醒（2s 兜底），
                // 醒来立即复查配置；启用态维持 100ms accept 轮询。
                if last_config.enabled {
                    std::thread::sleep(Duration::from_millis(100));
                } else {
                    crate::settings_mirror::wait_for_change(Duration::from_millis(
                        CONFIG_RECHECK_MS,
                    ));
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

    /// D-2：来源校验语义——只认回环 Host 与回环 Origin。
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
}
