//! IMAP 邮件检查：TLS 直连拉取未读数与最近邮件列表，凭据存系统凭据库。
use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::db::lock_db;
use crate::AppState;

/// 单次 socket 读/写上限。IMAP 服务器不响应（网络半开、防火墙静默丢包）
/// 时让 read 挂起会永久吃死一个 async worker，本应用的小组件又按分钟级
/// 轮询邮箱，必须让每一步都能失败返回。
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 每账户进程内缓存的"最近 cap 封 UID"快照。首次拉全量 SEARCH 取尾
/// cap，之后每轮只 SEARCH 新增 UID（`UID <last+1>:*`）并与缓存合并，避免
/// 大邮箱（数万封）分钟级轮询每次都做 O(n) 全量 UID 列表传输与解析。
#[derive(Clone, Default)]
struct MailboxSnapshot {
    /// 最近 cap 封邮件的 UID（升序）；其末位即增量 SEARCH 的起点。
    recent_uids: Vec<u32>,
    /// SELECT 返回的 UIDVALIDITY。邮箱重建/迁移后 UID 会整体重排，此时缓存的
    /// 大 UID 会把真正的新邮件挤出尾窗且增量起点失效——值变化即丢弃缓存重拉。
    uid_validity: Option<u32>,
}

fn mailbox_cache() -> &'static Mutex<HashMap<(String, String), MailboxSnapshot>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), MailboxSnapshot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 日志用邮箱脱敏——保留首字符与域名（`a***@example.com`），滚动
/// 日志不再留档完整 PII。仅用于 log；返回给用户的错误文案不脱敏（用户
/// 自己输入的地址）。
fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((user, domain)) if !user.is_empty() => {
            format!("{}***@{}", user.chars().next().unwrap_or('*'), domain)
        }
        _ => "***".to_string(),
    }
}

/// 进程内（非持久）缓存读写；锁中毒时回退为空快照，最坏退化为全量 SEARCH。
fn read_snapshot(key: &(String, String)) -> MailboxSnapshot {
    mailbox_cache()
        .lock()
        .map(|m| m.get(key).cloned().unwrap_or_default())
        .unwrap_or_default()
}

fn write_snapshot(key: (String, String), snap: MailboxSnapshot) {
    if let Ok(mut m) = mailbox_cache().lock() {
        m.insert(key, snap);
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailAccount {
    pub server: String,
    pub port: u16,
    pub email: String,
    pub password: String,
    pub use_tls: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailMessage {
    /// IMAP UID（字符串化）。UID 在邮箱内稳定，序列号会随 EXPUNGE 重排，
    /// 回写已读/删除必须用 UID 才能命中正确的邮件。
    pub id: String,
    pub from: String,
    pub subject: String,
    pub preview: String,
    pub date: String,
    pub unread: bool,
}

/* ── MIME 解码（此前 subject/from/正文只 from_utf8_lossy，中文邮件是
一片 =?utf-8?B?…?= / ==BD=编码串）。encoding_rs + base64 已是依赖。 ── */

/// RFC 2047 Q 编码：`=_`→空格、`=XX`→字节，`=` 行尾软换行丢弃。
fn decode_qp_bytes(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| -> Option<u8> {
            match c {
                b'0'..=b'9' => Some(c - b'0'),
                b'a'..=b'f' => Some(c - b'a' + 10),
                b'A'..=b'F' => Some(c - b'A' + 10),
                _ => None,
            }
        };
        if b[i] == b'=' && i + 2 < b.len() {
            let hi = b.get(i + 1).copied().and_then(hex);
            let lo = b.get(i + 2).copied().and_then(hex);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
            // 软换行（=\r\n / =\n）或非法序列：跳过 '='，后续字符照常处理。
            if b[i + 1] == b'\r' || b[i + 1] == b'\n' {
                i += if b[i + 1] == b'\r' && b.get(i + 2) == Some(&b'\n') {
                    3
                } else {
                    2
                };
                continue;
            }
            out.push(b[i]);
            i += 1;
        } else if b[i] == b'_' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

fn decode_base64_lenient(s: &str) -> Vec<u8> {
    use base64::Engine;
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .unwrap_or_else(|_| Vec::new())
}

/// 按 charset 标签把字节转成 String；未知/失败按有损 UTF-8 兜底。
fn decode_charset(bytes: &[u8], charset: &str) -> String {
    if let Some(enc) = encoding_rs::Encoding::for_label(charset.as_bytes()) {
        let (cow, _, _) = enc.decode(bytes);
        return cow.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 解码单个 encoded-word `=?charset?B|Q?text?=`；非法返回 None（原样保留）。
fn decode_encoded_word(w: &str) -> Option<String> {
    let inner = w.strip_prefix("=?")?.strip_suffix("?=")?;
    // charset?encoding?text：encoding 单字符；text 里可能含 '?'（稀少），用
    // splitn(3) 保留。
    let mut parts = inner.splitn(3, '?');
    let charset = parts.next()?;
    let enc = parts.next()?;
    let text = parts.next()?;
    if charset.is_empty() || enc.is_empty() {
        return None;
    }
    let bytes = match enc {
        "B" | "b" => decode_base64_lenient(text),
        "Q" | "q" => decode_qp_bytes(text),
        _ => return None,
    };
    Some(decode_charset(&bytes, charset))
}

/// 解码整段 header 值：相邻 encoded-word 之间的线性空白按 RFC 2047 忽略，
/// 普通文本段原样保留（与编码段拼接）。
fn decode_rfc2047(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    let mut last_was_word = false;
    while let Some(start) = rest.find("=?") {
        // 找配对的 "?="；encoded-word 内不允许出现空格（RFC），遇到空白即止。
        let after = &rest[start + 2..];
        let word_end = after
            .char_indices()
            .find(|(_, c)| *c == ' ' || *c == '\t' || *c == '\r' || *c == '\n')
            .map(|(i, _)| start + 2 + i)
            .unwrap_or(rest.len());
        let candidate = &rest[start..word_end.max(start + 2)];
        match decode_encoded_word(candidate) {
            Some(decoded) => {
                let prefix = &rest[..start];
                // 前一段也是 encoded-word 且中间只有空白 → 按规范丢弃该空白。
                if !(last_was_word && prefix.trim().is_empty()) {
                    out.push_str(prefix);
                }
                out.push_str(&decoded);
                rest = &rest[word_end.min(rest.len())..];
                last_was_word = true;
            }
            None => {
                out.push_str(&rest[..word_end.max(start + 2)]);
                rest = &rest[word_end.max(start + 2).min(rest.len())..];
                last_was_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 从 `key: value; a=b; c="d"` 形式的 header 值里取参数（大小写不敏感）。
fn mime_param(value: &str, key: &str) -> Option<String> {
    for seg in value.split(';').skip(1) {
        let mut kv = seg.splitn(2, '=');
        let k = kv.next()?.trim().to_ascii_lowercase();
        if k == key {
            let v = kv.next().unwrap_or("").trim();
            return Some(v.trim_matches('"').to_string());
        }
    }
    None
}

/// 极简 HTML → 文本（预览用）：剥标签、解常见实体、压空白。
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    for (ent, ch) in [
        ("&amp;", '&'),
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&quot;", '"'),
        ("&#39;", '\''),
        ("&nbsp;", ' '),
        ("&mdash;", '—'),
        ("&hellip;", '…'),
    ] {
        out = out.replace(ent, &ch.to_string());
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解码一段 MIME part（已有头块）：按 CTE 解传输编码，再按 charset 转码；
/// text/html 剥标签。头块与正文由调用方切好。
fn decode_part_body(body: &[u8], headers: &[(String, String)]) -> String {
    let header = |name: &str| -> Option<String> {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    };
    let cte = header("Content-Transfer-Encoding")
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    let decoded: Vec<u8> = match cte.as_str() {
        "quoted-printable" => decode_qp_bytes(&String::from_utf8_lossy(body)),
        "base64" => decode_base64_lenient(&String::from_utf8_lossy(body)),
        _ => body.to_vec(),
    };
    let charset = header("Content-Type")
        .and_then(|v| mime_param(&v, "charset"))
        .unwrap_or_else(|| "utf-8".to_string());
    let text = decode_charset(&decoded, &charset);
    let is_html = header("Content-Type")
        .map(|v| v.to_ascii_lowercase().contains("text/html"))
        .unwrap_or(false);
    if is_html {
        strip_html(&text)
    } else {
        text
    }
}

/// 把 BODY[TEXT] 原始字节解码成可读预览：multipart（边界由 TEXT 内嵌 part 头
/// 给出）取第一个 text/plain 叶子（退化 text/html）；单 part 按其头解码；
/// 无头的裸正文原样。最后取前 3 个非空行、共 200 字符。
fn decode_body_preview(raw: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(raw).into_owned();

    // 头块切分：开头连续的 `Key: Value` 行；空行后即正文。返回 None 表示
    // 开头不是头块（裸正文）。
    fn split_headers(text: &str) -> Option<(Vec<(String, String)>, &str)> {
        let mut headers: Vec<(String, String)> = Vec::new();
        let mut consumed = 0usize;
        for line in text.lines() {
            let trimmed = line.trim_end_matches('\r');
            if trimmed.is_empty() {
                let body_start = (consumed + 1).min(text.len());
                if headers.is_empty() {
                    return None;
                }
                return Some((headers, &text[body_start..]));
            }
            let (k, v) = trimmed.split_once(':')?;
            if k.is_empty() || k.chars().any(|c| c.is_whitespace()) {
                return None;
            }
            headers.push((k.trim().to_string(), v.trim().to_string()));
            consumed += trimmed.len() + 1;
        }
        None
    }

    let mut fallback: Option<String> = None; // text/html 退路
    let mut plain: Option<String> = None; // text/plain 首选
    let (top_headers, _) = split_headers(&lossy).unwrap_or_default();
    let boundary = top_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("Content-Type"))
        .and_then(|(_, v)| {
            if v.to_ascii_lowercase().contains("multipart") {
                mime_param(v, "boundary")
            } else {
                None
            }
        });

    if let Some(b) = boundary {
        let delim = format!("--{}", b);
        for section in lossy.split(delim.as_str()) {
            let section = section.trim_start_matches("\r\n").trim_start_matches('\n');
            if section.starts_with("--") || section.is_empty() {
                continue; // 终止边界 / 空段
            }
            if let Some((ph, pb)) = split_headers(section) {
                let ct = ph
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("Content-Type"))
                    .map(|(_, v)| v.to_ascii_lowercase())
                    .unwrap_or_default();
                if ct.starts_with("multipart") {
                    continue; // 嵌套 multipart：浅层处理，取兄弟叶子
                }
                let decoded = decode_part_body(pb.as_bytes(), &ph);
                if ct.is_empty() || ct.starts_with("text/plain") {
                    if plain.is_none() {
                        plain = Some(decoded);
                    }
                } else if ct.starts_with("text/html") && fallback.is_none() {
                    fallback = Some(decoded);
                }
            }
        }
    } else if let Some((ph, pb)) = split_headers(&lossy) {
        let decoded = decode_part_body(pb.as_bytes(), &ph);
        let ct = ph
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("Content-Type"))
            .map(|(_, v)| v.to_ascii_lowercase())
            .unwrap_or_default();
        if ct.starts_with("text/html") {
            fallback = Some(decoded);
        } else {
            plain = Some(decoded);
        }
    }

    let text = plain.or(fallback).unwrap_or_else(|| lossy.clone());
    let clean = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    clean.chars().take(200).collect()
}

/// 打开一个已登录、选中 INBOX 的 IMAP 会话。
///
/// 不用 `ClientBuilder::connect()`：它内部依次做无超时的 `TcpStream::connect`、
/// TLS 握手与 greeting 读取，服务器不响应时整条调用链永久挂起。这里
/// 手工建流（connect_timeout + 读/写超时）再交给 `imap::Client`，让连接
/// 建立阶段也有界。
fn open_session(account: &EmailAccount) -> Result<imap::Session<imap::Connection>, String> {
    open_session_with_validity(account).map(|(s, _)| s)
}

/// 同 open_session，并带回 SELECT INBOX 返回的 UIDVALIDITY（服务器未返回则 None）。
fn open_session_with_validity(
    account: &EmailAccount,
) -> Result<(imap::Session<imap::Connection>, Option<u32>), String> {
    let addrs: Vec<SocketAddr> = (account.server.as_str(), account.port)
        .to_socket_addrs()
        .map_err(|e| format!("解析服务器地址失败: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("无法解析服务器地址".to_string());
    }

    let mut last_err = String::from("IMAP 连接失败: 无可用地址");
    let mut tcp = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last_err = format!("IMAP 连接失败: {e}"),
        }
    }
    let tcp = tcp.ok_or(last_err)?;
    tcp.set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| format!("设置读超时失败: {e}"))?;
    tcp.set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| format!("设置写超时失败: {e}"))?;

    let mut client = if account.use_tls {
        let connector =
            native_tls::TlsConnector::new().map_err(|e| format!("TLS 初始化失败: {e}"))?;
        let stream = connector
            .connect(&account.server, tcp)
            .map_err(|e| format!("IMAP 连接失败: {e}"))?;
        imap::Client::new(Box::new(stream) as imap::Connection)
    } else {
        // 明文 IMAP——口令以明文过网，仅在用户显式关闭 TLS 时到达这里。
        // 升级路径备注：imap 3.0-alpha 的 STARTTLS 只在 ClientBuilder 形态提供
        // （与本处手工建流加超时的封装冲突），待其 API 稳定后迁移实现。
        // 日志不落完整邮箱（PII，随按天滚动日志明文留档）——只留首
        // 字符 + 域名，定位账号足够、脱敏到位。
        log::warn!(
            "email: 账号 {} 走明文 IMAP（use_tls=false）——口令将明文经过网络，仅建议在可信内网使用",
            mask_email(&account.email)
        );
        imap::Client::new(Box::new(tcp) as imap::Connection)
    };
    client
        .read_greeting()
        .map_err(|e| format!("IMAP 连接失败: {e}"))?;

    let mut session = client
        .login(&account.email, &account.password)
        .map_err(|(e, _)| format!("登录失败: {e}"))?;

    let mailbox = session
        .select("INBOX")
        .map_err(|e| format!("无法选择收件箱: {e}"))?;
    Ok((session, mailbox.uid_validity))
}

/// IMAP 连接测试（设置页「测试连接」按钮）：open_session 覆盖 DNS 解析 →
/// TCP 建连 → TLS 握手 → 登录 → SELECT INBOX 全链路，任一阶段失败带回
/// 具体错误文案。用户配完账户当场验证，不用等下一次轮询才发现密码错。
/// 阻塞网络 I/O 下沉 spawn_blocking（同 fetch_emails）。
#[tauri::command]
pub async fn test_email_account(
    window: tauri::Window,
    account: EmailAccount,
) -> Result<String, String> {
    // 闸门同 fetch_emails：server/port 任意指定，仅受信窗口可达（防内网
    // 端口探测侧信道）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = open_session(&account)?;
        // 礼貌退出；logout 失败不影响「连接可用」的判定结论。
        let _ = session.logout();
        Ok("OK".to_string())
    })
    .await
    .map_err(|e| format!("邮件任务失败：{e}"))?
}

/// Fetch recent emails from an IMAP server. Returns up to `limit` (5–50,
/// default 20) recent messages, identified by IMAP UID.
/// 阻塞网络 I/O 必须 spawn_blocking：async 命令体内直接阻塞会占住一个
/// async worker，多个慢 IMAP 源叠加即可饿死整个 async 运行时。
#[tauri::command]
pub async fn fetch_emails(
    window: tauri::Window,
    app: tauri::AppHandle,
    account: EmailAccount,
    limit: Option<u32>,
) -> Result<Vec<EmailMessage>, String> {
    // server/port 由前端任意指定，无闸门时被注入的
    // quick-note 页可让本进程向任意内网 host:port 发起 TCP 连接（错误信息
    // 可区分 DNS/拒绝/超时，构成内网端口扫描时序侧信道）。与 load_email_accounts
    // 一致收口到受信窗口。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // server 字段本身也过内网守卫——受信的 widget 窗被注入时仍可用
    // 任意 host:port 借 IMAP 连接错误做内网探测。把 host 包成 URL 形式复用
    // reject_private_target 的结构化判定（数字 IP / IPv6 / localhost / 内网段）。
    if let Err(e) = reject_private_email_server(&account) {
        return Err(format!("邮件服务器地址被拒绝：{e}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 前端只回传掩码（空）密码，这里按 (email, server) 从密文库找回
        // 真实口令；明文仅在本后端闭包内存在，永不回传 webview。
        let account = resolve_account(&app, &account)?;
        fetch_emails_blocking(account, limit)
    })
    .await
    .map_err(|e| format!("邮件任务失败: {e}"))?
}

/// 内网守卫（fetch/mark/delete 三条连接命令共用，补齐对称性）：把
/// server host 包成 URL 形式复用 reject_private_target 的结构化判定。
fn reject_private_email_server(account: &EmailAccount) -> Result<(), String> {
    let s = account.server.trim();
    /*IPv6 字面量——`[2001:db8::1]:993` 取方括号内为 host；裸 IPv6
    （无方括号、含多个冒号）整体视为 host。进 probe URL 时 IPv6 必须重新
    带上方括号：裸 `http://2001:db8::1/` 解析失败会被误报为
    「仅支持 http/https 链接」，合法公网 IPv6 服务器被无端拒绝。 */
    let host_raw = if let Some(rest) = s.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else if s.matches(':').count() > 1 {
        // 裸 IPv6（多个冒号）整串作 host——此前
        // `split(':').next()` 只取第一段，`fe80::1` 被截成 `fe80`、包成
        // `http://fe80/` 后按数字 IP（0.0.251.128）判为公网放行，链路本地
        // IPv6 服务器绕过了内网拒绝；与注释语义不符。`host:port` 只含一个
        // 冒号，仍走首段提取，不受影响。
        s
    } else {
        s.split(':').next().unwrap_or("")
    };
    let host = if host_raw.contains(':') {
        format!("[{host_raw}]")
    } else {
        host_raw.to_string()
    };
    let probe = format!("http://{host}/");
    crate::system_integration::reject_private_target(&probe)
}

fn fetch_emails_blocking(
    account: EmailAccount,
    limit: Option<u32>,
) -> Result<Vec<EmailMessage>, String> {
    let (mut session, uid_validity) = open_session_with_validity(&account)?;
    let cap = limit.unwrap_or(20).clamp(5, 50) as usize;

    // 增量拉取。首次无缓存时全量 SEARCH 取尾 cap；之后只 SEARCH 上次
    // 最大 UID 之后的增量，再与缓存窗口合并去重，仍取尾 cap。这样既能保持
    // 每轮返回最近 cap 封，又避免大邮箱每轮传输/解析全量 UID 列表。
    let cache_key = (account.email.clone(), account.server.clone());
    let mut snapshot = read_snapshot(&cache_key);
    // UIDVALIDITY 变化（邮箱重建/迁移）意味着 UID 整体重排：缓存的 UID 既不能做
    // 增量起点，也会把真正的新邮件挤出尾窗——丢弃缓存回到全量 SEARCH。
    // 服务器未返回 UIDVALIDITY 时无法校验，沿用缓存（旧行为）。
    if let (Some(cached), Some(now)) = (snapshot.uid_validity, uid_validity) {
        if cached != now {
            snapshot.recent_uids.clear();
        }
    }
    let last_uid = snapshot.recent_uids.last().copied();
    let mut ids: Vec<u32> = snapshot.recent_uids;
    if let Some(last) = last_uid {
        let query = format!("UID {}:*", last.saturating_add(1));
        let extra = session
            .uid_search(&query)
            .map_err(|e| format!("搜索新邮件失败: {e}"))?;
        ids.extend(extra.iter().copied());
    } else {
        let all = session
            .uid_search("ALL")
            .map_err(|e| format!("搜索邮件失败: {e}"))?;
        ids.extend(all.iter().copied());
    }

    // UIDs are an unordered set; sort ascending so the trailing slice really is
    // the most recent messages.
    ids.sort_unstable();
    ids.dedup();
    let start = if ids.len() > cap { ids.len() - cap } else { 0 };
    let recent: Vec<u32> = ids[start..].to_vec();

    if recent.is_empty() {
        session.logout().ok();
        // 空邮箱也记下本轮 UIDVALIDITY，避免下一轮再次误判为"变化"。
        write_snapshot(
            cache_key,
            MailboxSnapshot {
                recent_uids: Vec::new(),
                uid_validity,
            },
        );
        return Ok(Vec::new());
    }

    // Exact comma-joined UID set（而非 min:max 区间）：区间端点超过现存最大
    // UID 时部分服务器会报错，精确列表无此问题。
    let range = recent
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    // PEEK: a plain BODY[...] fetch implicitly sets \Seen on the server, so a
    // read-only widget polling the inbox would mark the newest mail as read
    // for every other device.
    let fetches = session
        .uid_fetch(&range, "(FLAGS ENVELOPE BODY.PEEK[TEXT]<0.200>)")
        .map_err(|e| format!("获取邮件失败: {e}"))?;

    let mut messages: Vec<EmailMessage> = Vec::new();

    for fetch in fetches.iter() {
        let envelope = match fetch.envelope() {
            Some(e) => e,
            None => continue,
        };

        // In imap v3, envelope fields are Cow<'_, [u8]>
        let from = envelope
            .from
            .as_ref()
            .and_then(|addrs| addrs.first())
            .map(|a| {
                // RFC 2047 encoded-word 解码（=?utf-8?B?…?= 的中文显示名）。
                let name = a
                    .name
                    .as_ref()
                    .map(|n| decode_rfc2047(&String::from_utf8_lossy(n)));
                let mailbox = a
                    .mailbox
                    .as_ref()
                    .map(|m| String::from_utf8_lossy(m).into_owned())
                    .unwrap_or_default();
                name.filter(|n| !n.is_empty()).unwrap_or(mailbox)
            })
            .unwrap_or_else(|| "未知".to_string());

        let subject = envelope
            .subject
            .as_ref()
            .map(|s| decode_rfc2047(&String::from_utf8_lossy(s)))
            .unwrap_or_default();
        let subject = if subject.trim().is_empty() {
            "(无主题)".to_string()
        } else {
            subject
        };

        let date = envelope
            .date
            .as_ref()
            .map(|d| String::from_utf8_lossy(d).into_owned())
            .unwrap_or_default();
        let date = if date.is_empty() {
            "未知日期".to_string()
        } else {
            date
        };

        let flags = fetch.flags();
        let unread = !flags.iter().any(|f| f == &imap::types::Flag::Seen);

        let body = fetch
            .body()
            .map(decode_body_preview)
            .unwrap_or_else(|| "(无预览)".to_string());

        messages.push(EmailMessage {
            id: fetch.uid.map(|u| u.to_string()).unwrap_or_default(),
            from,
            subject,
            preview: body,
            date,
            unread,
        });
    }

    session.logout().ok();
    // 成功落盘本轮的"最近 cap 封 UID"窗口，作为下一轮增量 SEARCH 起点。
    write_snapshot(
        cache_key,
        MailboxSnapshot {
            recent_uids: recent,
            uid_validity,
        },
    );
    Ok(messages)
}

/// UID 必须是单个非空 32 位整数，拒绝 `,` `*` `:` 等 sequence-set 注入，
/// 防止被篡改的渲染层把 `1:*` 这类区间送入 UID STORE 误删全邮箱。
fn parse_uid(uid: &str) -> Result<u32, String> {
    if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("无效的邮件 UID: {uid}"));
    }
    uid.parse::<u32>()
        .map_err(|_| format!("无效的邮件 UID: {uid}"))
}

/// 已读回写：服务器侧给邮件打上 \Seen（SILENT 免回包）。
#[tauri::command]
pub async fn mark_email_seen(
    window: tauri::Window,
    app: tauri::AppHandle,
    account: EmailAccount,
    uid: String,
) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 连接前同样过内网守卫，堵住借
    // mark/delete 的连接错误差异做内网探测的侧信道。
    if let Err(e) = reject_private_email_server(&account) {
        return Err(format!("邮件服务器地址被拒绝：{e}"));
    }
    let uid = parse_uid(&uid)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // 同上，明文仅在后端按需解密。
        let account = resolve_account(&app, &account)?;
        let mut session = open_session(&account)?;
        session
            .uid_store(&uid, "+FLAGS.SILENT (\\Seen)")
            .map_err(|e| format!("标记已读失败: {e}"))?;
        session.logout().ok();
        Ok(())
    })
    .await
    .map_err(|e| format!("邮件任务失败: {e}"))?
}

/// 删除回写：打 \Deleted 标记并 EXPUNGE，真实删除服务器邮件。
#[tauri::command]
pub async fn delete_email(
    window: tauri::Window,
    app: tauri::AppHandle,
    account: EmailAccount,
    uid: String,
) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 同上。
    if let Err(e) = reject_private_email_server(&account) {
        return Err(format!("邮件服务器地址被拒绝：{e}"));
    }
    let uid = parse_uid(&uid)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // 同上，明文仅在后端按需解密。
        let account = resolve_account(&app, &account)?;
        let mut session = open_session(&account)?;
        session
            .uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
            .map_err(|e| format!("标记删除失败: {e}"))?;
        // UID EXPUNGE（RFC 4315 UIDPLUS）只清除本封——无参 expunge() 会
        // 连带永久删除**其它客户端**此前打了 \Deleted 待清理的邮件（手机/网页
        // 端回收站语义被击穿）。服务器不支持 UIDPLUS 时回退为不解删（保留
        // \Deleted 标记，由用户自己的客户端清理）。
        if session.uid_expunge(&uid).is_err() {
            log::warn!("email: UID EXPUNGE unsupported; \\Deleted flag kept for uid {uid}");
        }
        session.logout().ok();
        Ok(())
    })
    .await
    .map_err(|e| format!("邮件任务失败: {e}"))?
}

/// 多账户：保存账户列表（整体覆盖写，SQLite settings 表）。
///
/// 密码经 DPAPI（CryptProtectData，当前用户 scope）加密后才入库：settings
/// 表会随 export_all 进备份文件，明文密码等于随备份到处复制。加密值带
/// `dpapi:` 前缀（base64），读取时按前缀识别。
#[tauri::command]
pub async fn save_email_accounts(
    window: tauri::Window,
    app: tauri::AppHandle,
    accounts: Vec<EmailAccount>,
) -> Result<(), String> {
    // 凭据写入路径必须受信窗口可达，与 load_email_accounts 对称。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 同步命令在 Tauri 主线程上锁库：备份/导入持锁期间会冻结所有窗口并让
    // 低级鼠标钩子超时被摘（规则），与其余 DB 命令一致下沉到阻塞池。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // 前端对未改动的账户只回传掩码（空）密码；按 (email, server) 找回
        // 已加密的存量密码，避免把空密码覆盖写回导致下次登录失败。
        let stored = read_stored_accounts_encrypted(&state)?;
        let mut password_by_key: HashMap<(String, String), String> = stored
            .into_iter()
            .map(|a| ((a.email, a.server), a.password))
            .collect();

        let mut out = Vec::with_capacity(accounts.len());
        for mut a in accounts {
            if a.password.is_empty() {
                if let Some(enc) = password_by_key.remove(&(a.email.clone(), a.server.clone())) {
                    a.password = enc;
                }
            } else {
                a.password = protect_password(&a.password)?;
            }
            out.push(a);
        }
        let json = serde_json::to_string(&out).map_err(|e| format!("序列化失败: {e}"))?;
        // lock_db recovers from a poisoned mutex; a raw .lock() would permanently
        // kill email save/load after any unrelated panic.
        let db = lock_db(&state.db).map_err(|e| format!("数据库锁定失败: {e}"))?;
        db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('email:accounts', ?1)",
            rusqlite::params![json],
        )
        .map_err(|e| format!("保存失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("邮箱账户任务失败：{e}"))?
}

/// DPAPI 加密（仅 Windows；其它平台原样返回——本项目只发布 Windows 包）。
fn protect_password(plain: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        use base64::Engine as _;
        use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
        let bytes = plain.as_bytes();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        // SAFETY: in/out blob 按 API 契约初始化；LocalFree 由 API 文档要求。
        unsafe {
            CryptProtectData(&in_blob, None, None, None, None, 0, &mut out_blob)
                .map_err(|e| format!("密码加密失败: {e}"))?;
        }
        let enc = unsafe {
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
        };
        unsafe {
            windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                out_blob.pbData as *mut _,
            )));
        }
        Ok(format!(
            "dpapi:{}",
            base64::engine::general_purpose::STANDARD.encode(enc)
        ))
    }
    #[cfg(not(windows))]
    {
        Ok(plain.to_string())
    }
}

/// DPAPI 解密：仅解密带 `dpapi:` 前缀的值。
/// () 文档更正：**非** dpapi 值不会「原样返回」——安全决策是 Windows
/// 上丢弃旧版明文返回空串（防篡改恢复包夹带明文口令直通），与下方实现一致。
/// 解密失败也返回空串；空口令随后在 resolve_account 被「未配置密码」明确
/// 拒绝，不再以空密码静默登录。旧版明文存量用户需重输一次密码。
fn unprotect_password(stored: &str) -> String {
    #[cfg(windows)]
    if let Some(b64) = stored.strip_prefix("dpapi:") {
        use base64::Engine as _;
        use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        let Ok(enc) = base64::engine::general_purpose::STANDARD.decode(b64) else {
            log::error!("email password: invalid dpapi base64");
            return String::new();
        };
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: enc.len() as u32,
            pbData: enc.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        // SAFETY: 同 protect_password。
        unsafe {
            if CryptUnprotectData(&in_blob, None, None, None, None, 0, &mut out_blob).is_err() {
                log::error!("email password: dpapi decrypt failed");
                return String::new();
            }
        }
        let plain = unsafe {
            let slice =
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
            windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                out_blob.pbData as *mut _,
            )));
            slice
        };
        return String::from_utf8_lossy(&plain).into_owned();
    }
    #[cfg(not(windows))]
    {
        // Non-Windows builds store plaintext (protect_password is a no-op), so
        // round-trip it unchanged.
        return stored.to_string();
    }
    // on Windows, any non-`dpapi:` value is legacy plaintext. A tampered
    // restore could smuggle a plaintext password into `email:accounts` and have
    // it silently accepted here — do not hand it back to the webview.
    log::warn!("email password: non-dpapi value ignored (legacy plaintext unsupported)");
    String::new()
}

/// 读取 `email:accounts`（仍为 DPAPI 密文），不解密。用于校验已有
/// 账户与按索引找回真实密码 —— 明文只在后端按需解密、永不下发 webview。
fn read_stored_accounts_encrypted(state: &AppState) -> Result<Vec<EmailAccount>, String> {
    let db = lock_db(&state.db).map_err(|e| format!("数据库锁定失败: {e}"))?;
    read_stored_accounts_from_db(&db)
}

/// 按已持锁连接读账户列表（供 load_email_accounts 在同一锁内完成
/// 「读列表 + 探测新键行是否存在」，避免二次加锁）。
fn read_stored_accounts_from_db(db: &rusqlite::Connection) -> Result<Vec<EmailAccount>, String> {
    let result: Result<String, _> = db.query_row(
        "SELECT value FROM settings WHERE key = 'email:accounts'",
        [],
        |row| row.get(0),
    );
    match result {
        Ok(json) => serde_json::from_str(&json).map_err(|e| format!("反序列化失败: {e}")),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Vec::new()),
        Err(e) => Err(format!("加载失败: {e}")),
    }
}

/// 前端只持有掩码（空）密码；按 (email, server) 从密文库找回真实
/// 解密密码填回账户。前端传入的账户密码为空时表示「沿用已存密码」。
fn resolve_account(app: &tauri::AppHandle, account: &EmailAccount) -> Result<EmailAccount, String> {
    if !account.password.is_empty() {
        return Ok(account.clone());
    }
    let state = app.state::<AppState>();
    let stored = read_stored_accounts_encrypted(&state)?;
    for s in &stored {
        if s.email == account.email && s.server == account.server {
            let mut resolved = account.clone();
            resolved.password = unprotect_password(&s.password);
            //存储密文解不出（DPAPI 失败 / 旧明文被 丢弃）时空
            // 口令并入「未配置密码」明确报错——原样放行会以空密码登录 IMAP，
            // 得到晦涩的服务器报错且无从排查。
            if resolved.password.is_empty() {
                return Err(format!(
                    "账户 {} 的已存密码无法解密（旧版本明文或异机恢复数据），请在设置中重新填写",
                    account.email
                ));
            }
            return Ok(resolved);
        }
    }
    // （空密码静默登录）：新账户/键不匹配时原样放行空口令，IMAP 登录只会
    // 给出晦涩的服务器报错——明确指出未配置密码。
    Err(format!(
        "账户 {} 未配置密码，请先在设置中填写",
        account.email
    ))
}

/// 多账户：读取账户列表；旧版单账户键（email:account）自动迁移为
/// 单元素列表，读后不删旧键（保留回滚能力，保存时写新键）。
///
/// 返回前一律把密码掩码为空串 —— DPAPI 解密后的明文绝不回传任何
/// webview（含 widget-* / quick-note），凭据仅在 fetch/mark/delete 时由后端
/// 按需解密。
/// 账户元数据（邮箱/服务器/IMAP 配置）仍属敏感信息，加窗口闸门，
/// 仅设置窗口与桌面小组件层（EmailWidget 在 widget-*）可读。
#[tauri::command]
pub async fn load_email_accounts(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Vec<EmailAccount>, String> {
    crate::require_trusted(&window)?;
    // 与 save_email_accounts 同理：不在主线程上锁库。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let db = lock_db(&state.db).map_err(|e| format!("数据库锁定失败: {e}"))?;
        let mut accounts = read_stored_accounts_from_db(&db)?;
        /* 迁移触发条件 = 新键「行不存在」，而非「列表为空」——用户把
        账户清空保存后新键值为 "[]"（save 对空列表照写），按空列表触发会让
        每次加载都从旧键重新搬回密文，被显式删除的账户复活并自动拉信。
        首次迁移成功与用户主动清空之后，新键行始终存在，旧键路径不再
        进入（旧键本身保留，回滚能力不变）。 */
        let new_row_exists = db
            .query_row(
                "SELECT 1 FROM settings WHERE key = 'email:accounts'",
                [],
                |_| Ok(()),
            )
            .is_ok();
        if new_row_exists {
            for a in accounts.iter_mut() {
                a.password = String::new();
            }
            return Ok(accounts);
        }

        // 旧版迁移：单账户 → 单元素列表。：此处只展示不落新键会让
        // resolve_account（只查 email:accounts）永远找不到旧密文，fetch/
        // mark/delete 全部报「未配置密码」——改为幂等搬运：把旧键里的
        // DPAPI 密文原样写入新键，旧键保留（回滚能力不变）。
        let old: Result<String, _> = db.query_row(
            "SELECT value FROM settings WHERE key = 'email:account'",
            [],
            |row| row.get(0),
        );
        match old {
            Ok(json) => {
                let mut account: EmailAccount =
                    serde_json::from_str(&json).map_err(|e| format!("旧账户迁移失败: {e}"))?;
                let migrated = vec![account.clone()];
                let new_json =
                    serde_json::to_string(&migrated).map_err(|e| format!("序列化失败: {e}"))?;
                db.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('email:accounts', ?1)",
                    rusqlite::params![new_json],
                )
                .map_err(|e| format!("旧账户迁移落库失败: {e}"))?;
                account.password = String::new();
                Ok(vec![account])
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Vec::new()),
            Err(e) => Err(format!("加载失败: {e}")),
        }
    })
    .await
    .map_err(|e| format!("邮箱账户任务失败：{e}"))?
}

/* ── ①：RFC 2047 解码族测试。这些函数解析完全不可信的邮件头（任意
服务器 / 任意转发链都可能塞进畸形 encoded-word），核心断言是「坏输入不
panic、兜底行为可预期」。样本中的 base64/QP 串优先用依赖库在测试内构造
（往返自验证），少量手写经典样本（=?utf-8?B?5L2g5aW9?=）双重锁定。 ── */
#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    /// 测试内构造样本用：字节 → standard base64。
    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// 测试内构造样本用：字符串 → RFC 2047 Q 编码（=XX / `_` 空格）。
    fn q_encode(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b' ' => "_".to_string(),
                b'=' | b'?' | b'_' => format!("={b:02X}"),
                0x21..=0x7e => (b as char).to_string(),
                _ => format!("={b:02X}"),
            })
            .collect()
    }

    #[test]
    fn decode_qp_bytes_table() {
        // (输入, 期望字节, 说明)
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("Hello_World", b"Hello World".to_vec(), "Q 编码 `_` → 空格"),
            ("=E4=BD=A0", vec![0xE4, 0xBD, 0xA0], "=XX 大写十六进制"),
            ("=e4=bd=a0", vec![0xE4, 0xBD, 0xA0], "=xx 小写同样接受"),
            ("a=\r\nb", b"ab".to_vec(), "软换行 =\\r\\n 丢弃"),
            ("a=\nb", b"ab".to_vec(), "软换行 =\\n 丢弃"),
            ("=ZZ", b"=ZZ".to_vec(), "非法 = 序列原样保留（不 panic）"),
            ("=4", b"=4".to_vec(), "行尾孤立 =4 原样保留"),
            ("A?B_C", b"A?B C".to_vec(), "其余字符原样"),
        ];
        for (raw, want, why) in cases {
            assert_eq!(decode_qp_bytes(raw), want, "{why}: {raw:?}");
        }
    }

    #[test]
    fn decode_base64_lenient_variants() {
        // 标准字母表 + 内嵌空白剔除。
        assert_eq!(decode_base64_lenient("5L2g"), "你".as_bytes().to_vec());
        assert_eq!(
            decode_base64_lenient("5L2g\r\n5aW9"),
            "你好".as_bytes().to_vec()
        );
        // 坏 base64 → 空字节兜底（不 panic、不返回半截数据）。
        assert!(decode_base64_lenient("####").is_empty());
        assert!(decode_base64_lenient("").is_empty());
        // URL-safe 字母表（-/_）不属于 STANDARD 引擎 → 空兜底。
        assert!(decode_base64_lenient("-__-").is_empty());
    }

    #[test]
    fn decode_charset_known_labels_and_lossy_fallback() {
        let utf8 = "你好".as_bytes();
        assert_eq!(decode_charset(utf8, "utf-8"), "你好");
        // WHATWG label 别名（大小写 / 连字符变体）都应命中 encoding_rs。
        assert_eq!(decode_charset(utf8, "UTF8"), "你好");
        let (gbk, _, _) = encoding_rs::GBK.encode("你好");
        assert_eq!(decode_charset(gbk.as_ref(), "gbk"), "你好");
        assert_eq!(
            decode_charset(gbk.as_ref(), "gb2312"),
            "你好",
            "gb2312 是 gbk 的别名 label"
        );
        // 未知 charset：有损 UTF-8 兜底（出现替换符但不 panic）。
        let out = decode_charset(gbk.as_ref(), "x-no-such-charset");
        assert!(out.contains('\u{FFFD}'), "未知 charset 应有损兜底: {out:?}");
    }

    #[test]
    fn decode_encoded_word_valid_and_illegal() {
        assert_eq!(
            decode_encoded_word("=?utf-8?B?5L2g5aW9?="),
            Some("你好".to_string())
        );
        // 大小写编码字母都接受（RFC 2047 语义）。
        assert_eq!(
            decode_encoded_word("=?utf-8?b?5L2g5aW9?="),
            Some("你好".to_string())
        );
        assert_eq!(
            decode_encoded_word("=?utf-8?Q?=E4=BD=A0?="),
            Some("你".to_string())
        );
        // 非法输入一律 None（由上层决定兜底），绝不 panic。
        assert_eq!(decode_encoded_word("plain"), None, "无 =? 前缀");
        assert_eq!(decode_encoded_word("=?utf-8?B?abc"), None, "未闭合 ?=");
        assert_eq!(decode_encoded_word("=?utf-8?Z?abc?="), None, "未知编码字母");
        assert_eq!(decode_encoded_word("=??B?abc?="), None, "空 charset");
        assert_eq!(decode_encoded_word("=?B?abc?="), None, "缺 charset 段");
    }

    /// 整头解码主入口的表驱动覆盖：标准词 / 多段拼接空白消除 / 折叠长头 /
    /// 非法兜底 / GBK 真实样本。GBK 段在测试内用依赖库构造（自验证）。
    #[test]
    fn decode_rfc2047_table() {
        let gbk_nihao = b64(encoding_rs::GBK.encode("你好").0.as_ref());
        let gbk_ni = b64(encoding_rs::GBK.encode("你").0.as_ref());
        let gbk_zhangsan = b64(encoding_rs::GBK.encode("张三").0.as_ref());
        // (输入, 期望, 说明)
        let cases: Vec<(String, &str, &str)> = vec![
            // ① 标准 B/Q 编码词
            (
                "=?utf-8?B?5L2g5aW9?=".into(),
                "你好",
                "B 编码 UTF-8（经典手写样本）",
            ),
            (
                format!("=?gbk?B?{gbk_nihao}?="),
                "你好",
                "B 编码 GBK charset",
            ),
            (
                "=?utf-8?Q?Hello_World?=".into(),
                "Hello World",
                "Q 编码 `_` → 空格",
            ),
            (
                "=?utf-8?Q?=E4=BD=A0=E5=A5=BD?=".into(),
                "你好",
                "Q 编码 =XX 中文",
            ),
            (
                "=?utf-8?q?hello_world?=".into(),
                "hello world",
                "小写 q 同样生效",
            ),
            // ② 多段拼接：相邻 encoded-word 之间的空白按 RFC 2047 消除
            (
                "=?utf-8?B?5L2g?= =?utf-8?B?5aW9?=".into(),
                "你好",
                "相邻两段：中间空格消除",
            ),
            (
                "=?utf-8?B?5L2g?=\r\n =?utf-8?B?5aW9?=".into(),
                "你好",
                "折叠长头（CRLF+空格）unfolding 后仍消除",
            ),
            (
                "=?utf-8?B?5L2g?=\r\n\t=?utf-8?B?5aW9?=".into(),
                "你好",
                "折叠（CRLF+TAB）",
            ),
            (
                "Re: =?utf-8?B?5L2g?= =?utf-8?B?5aW9?=".into(),
                "Re: 你好",
                "普通文本前缀保留",
            ),
            (
                "=?utf-8?B?5L2g?= 与 =?utf-8?B?5aW9?=".into(),
                "你 与 好",
                "两段之间夹非空白文本 → 保留",
            ),
            (
                format!("=?gbk?B?{gbk_ni}?= =?utf-8?Q?=E5=A5=BD?="),
                "你好",
                "跨 charset / 跨 B-Q 编码的相邻拼接",
            ),
            // ③ 非法输入兜底（重点：不 panic，行为可预期）
            (
                "=?utf-8?B?!!!!?=".into(),
                "",
                "坏 base64 → lenient 空字节 → 空串",
            ),
            (
                "=?utf-8?B?5L2g".into(),
                "=?utf-8?B?5L2g",
                "未闭合 ?= → 原样保留",
            ),
            (
                "=?utf-8?X?5L2g?=".into(),
                "=?utf-8?X?5L2g?=",
                "未知编码字母 → 原样保留",
            ),
            ("=??B?5L2g?=".into(), "=??B?5L2g?=", "空 charset → 原样保留"),
            ("a=?x".into(), "a=?x", "裸 =? 疑似词 → 原样保留"),
            (
                "=?utf-8?B?5L2g?=尾缀".into(),
                "=?utf-8?B?5L2g?=尾缀",
                "无空白分隔的尾缀使整词不闭合 → 原样",
            ),
            (
                "=?x-nonexistent?B?5L2g5aW9?=".into(),
                "你好",
                "未知 charset → 有损 UTF-8 兜底（字节恰为合法 UTF-8）",
            ),
            // ⑤ 真实样本形态（发件人显示名 + 地址）
            (
                format!("=?gbk?B?{gbk_zhangsan}?= <zhangsan@example.com>"),
                "张三 <zhangsan@example.com>",
                "中文显示名 + 裸地址段保留",
            ),
            // 纯文本直通
            ("plain subject".into(), "plain subject", "无编码词直通"),
        ];
        for (raw, want, why) in cases {
            assert_eq!(decode_rfc2047(&raw), want, "{why}: {raw:?}");
        }
    }

    /// ⑤ 中文主题/发件人的真实样本往返：测试内编码 → decode_rfc2047 还原。
    #[test]
    fn decode_rfc2047_roundtrip_real_samples() {
        let samples = [
            "会议纪要：Q3 复盘",
            "【系统通知】服务器将于 00:00-06:00 维护",
            "关于《2026 年度预算方案（修订版）》的确认",
            "张三",
            "Re: 你好世界 Hello",
        ];
        for s in samples {
            let b = b64(s.as_bytes());
            assert_eq!(
                decode_rfc2047(&format!("=?utf-8?B?{b}?=")),
                s,
                "B 往返: {s}"
            );
            let q = q_encode(s);
            assert_eq!(
                decode_rfc2047(&format!("=?utf-8?Q?{q}?=")),
                s,
                "Q 往返: {s}"
            );
            // 长头按 RFC 2047 规范在**字符边界**对半切成两段相邻 encoded-word
            // （规范禁止把多字节字符切进两个词——词各自按 charset 独立解码，
            // 切坏边界只能有损兜底），unfolding 后拼回原文。
            let chars: Vec<char> = s.chars().collect();
            let mid = chars.len() / 2;
            let (l, r) = (
                chars[..mid].iter().collect::<String>(),
                chars[mid..].iter().collect::<String>(),
            );
            let folded = format!(
                "=?utf-8?B?{}?= =?utf-8?B?{}?=",
                b64(l.as_bytes()),
                b64(r.as_bytes())
            );
            assert_eq!(decode_rfc2047(&folded), s, "折叠两段往返: {s}");
        }
    }

    /// 头参数解析：`Key: value; a="b"; c=d` 形式，键大小写不敏感。
    #[test]
    fn mime_param_extracts_quoted_and_bare() {
        assert_eq!(
            mime_param("text/plain; charset=\"gbk\"", "charset"),
            Some("gbk".to_string())
        );
        assert_eq!(
            mime_param("multipart/mixed; boundary=abc123", "boundary"),
            Some("abc123".to_string())
        );
        assert_eq!(
            mime_param("text/html; CHARSET=utf-8", "charset"),
            Some("utf-8".to_string()),
            "键大小写不敏感"
        );
        assert_eq!(mime_param("text/plain", "charset"), None, "无参数");
        assert_eq!(
            mime_param("text/plain; name=x", "charset"),
            None,
            "键不存在"
        );
    }

    /// 预览用 HTML 剥离：标签、常见实体、空白压缩。
    #[test]
    fn strip_html_strips_tags_and_entities() {
        assert_eq!(strip_html("<p>Hello <b>World</b></p>"), "Hello World");
        assert_eq!(strip_html("&lt;a&amp;b&gt;"), "<a&b>");
        // 实体替换后无真实空格可压：`&nbsp;` 已是空格，`—` `…` 直接相邻。
        assert_eq!(strip_html("a&nbsp;&mdash;&hellip;b"), "a —…b");
        assert_eq!(strip_html("a\n\n  b\tc"), "a b c");
        assert_eq!(strip_html("<"), "", "未闭合标签不 panic");
    }

    /// 单 part 正文两级解码（CTE → charset）；HTML part 再剥标签。
    #[test]
    fn decode_part_body_cte_then_charset() {
        // QP + GBK：===BA=→ GBK 字节 → 你好
        let headers = vec![
            (
                "Content-Transfer-Encoding".to_string(),
                "quoted-printable".to_string(),
            ),
            (
                "Content-Type".to_string(),
                "text/plain; charset=gbk".to_string(),
            ),
        ];
        assert_eq!(decode_part_body(b"=C4=E3=BA=C3", &headers), "你好");
        // base64 + UTF-8 + HTML：解传输编码后剥标签
        let headers = vec![
            (
                "Content-Transfer-Encoding".to_string(),
                "base64".to_string(),
            ),
            (
                "Content-Type".to_string(),
                "text/html; charset=utf-8".to_string(),
            ),
        ];
        let body = b64("<p>你好</p>".as_bytes());
        assert_eq!(decode_part_body(body.as_bytes(), &headers), "你好");
        // 无 CTE 头：按原文 + 默认 utf-8
        let headers = vec![];
        assert_eq!(decode_part_body("原文".as_bytes(), &headers), "原文");
    }

    /// 正文预览：multipart 优先 text/plain 叶子（html 只做退路）、裸正文直通、
    /// 非空行取前 3 行。
    #[test]
    fn decode_body_preview_prefers_plain_part() {
        let raw = concat!(
            "Content-Type: multipart/alternative; boundary=\"XYZ\"\r\n",
            "\r\n",
            "--XYZ\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n",
            "\r\n",
            "第一行\r\n",
            "第二行\r\n",
            "第三行\r\n",
            "--XYZ\r\n",
            "Content-Type: text/html; charset=utf-8\r\n",
            "\r\n",
            "<p>HTML 分支</p>\r\n",
            "--XYZ--\r\n",
        );
        assert_eq!(decode_body_preview(raw.as_bytes()), "第一行 第二行 第三行");

        // 裸正文（无头块）直通，行数裁剪。
        assert_eq!(decode_body_preview("裸正文".as_bytes()), "裸正文");
        let five_lines = "1\n2\n3\n4\n5";
        assert_eq!(
            decode_body_preview(five_lines.as_bytes()),
            "1 2 3",
            "只取前 3 个非空行"
        );
    }

    /// UID 必须是单个非空 32 位整数，拒绝 sequence-set 注入。
    #[test]
    fn parse_uid_rejects_injection() {
        assert_eq!(parse_uid("1234"), Ok(1234));
        for bad in ["", "1:*", "1,2", "abc", "-1", "4294967296"] {
            assert!(parse_uid(bad).is_err(), "{bad:?} 应被拒绝");
        }
    }

    /// server host 的 IPv6 提取——裸 IPv6（无方括号、
    /// 多冒号）整串作 host 进 probe；`host:port` / 方括号形态不受影响。
    #[test]
    fn email_server_guard_bare_ipv6_is_whole_host() {
        let acc = |server: &str| EmailAccount {
            server: server.into(),
            port: 993,
            email: "a@b.c".into(),
            password: String::new(),
            use_tls: true,
        };
        // 公网目标照常放行：域名 / 域名+端口 / 方括号 IPv6 / 裸 IPv6。
        assert!(reject_private_email_server(&acc("imap.example.com")).is_ok());
        assert!(reject_private_email_server(&acc("imap.example.com:993")).is_ok());
        assert!(
            reject_private_email_server(&acc("[2001:4860:4860::8888]")).is_ok(),
            "方括号公网 IPv6 应放行"
        );
        assert!(
            reject_private_email_server(&acc("2001:4860:4860::8888")).is_ok(),
            "裸公网 IPv6 应放行（整串作 host 重包方括号）"
        );
        // 内网目标一律拒绝——修复点：裸 IPv6 此前被 split(':') 截成
        // 首段（如 "fe80"），按数字 IP 误判公网放行。
        for bad in [
            "::1",
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "127.0.0.1",
            "192.168.1.2:993",
            "10.0.0.5",
            "localhost",
        ] {
            assert!(
                reject_private_email_server(&acc(bad)).is_err(),
                "应拒绝内网目标：{bad}"
            );
        }
    }
}
