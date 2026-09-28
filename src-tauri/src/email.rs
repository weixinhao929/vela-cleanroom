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

/// C-20：每账户进程内缓存的"最近 cap 封 UID"快照。首次拉全量 SEARCH 取尾
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
        // D-11：明文 IMAP——口令以明文过网，仅在用户显式关闭 TLS 时到达这里。
        // 升级路径备注：imap 3.0-alpha 的 STARTTLS 只在 ClientBuilder 形态提供
        // （与本处手工建流加超时的封装冲突），待其 API 稳定后迁移实现。
        log::warn!(
            "email: 账号 {} 走明文 IMAP（use_tls=false）——口令将明文经过网络，仅建议在可信内网使用",
            account.email
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
    // P1（审计修复）：server/port 由前端任意指定，无闸门时被注入的
    // quick-note 页可让本进程向任意内网 host:port 发起 TCP 连接（错误信息
    // 可区分 DNS/拒绝/超时，构成内网端口扫描时序侧信道）。与 load_email_accounts
    // 一致收口到受信窗口。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // M4：server 字段本身也过内网守卫——受信的 widget 窗被注入时仍可用
    // 任意 host:port 借 IMAP 连接错误做内网探测。把 host 包成 URL 形式复用
    // reject_private_target 的结构化判定（数字 IP / IPv6 / localhost / 内网段）。
    {
        let host = account
            .server
            .split(':')
            .next()
            .unwrap_or("")
            .trim_matches(['[', ']']);
        let probe = format!("http://{host}/");
        if let Err(e) = crate::system_integration::reject_private_target(&probe) {
            return Err(format!("邮件服务器地址被拒绝：{e}"));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        // C-5：前端只回传掩码（空）密码，这里按 (email, server) 从密文库找回
        // 真实口令；明文仅在本后端闭包内存在，永不回传 webview。
        let account = resolve_account(&app, &account)?;
        fetch_emails_blocking(account, limit)
    })
    .await
    .map_err(|e| format!("邮件任务失败: {e}"))?
}

fn fetch_emails_blocking(
    account: EmailAccount,
    limit: Option<u32>,
) -> Result<Vec<EmailMessage>, String> {
    let (mut session, uid_validity) = open_session_with_validity(&account)?;
    let cap = limit.unwrap_or(20).clamp(5, 50) as usize;

    // C-20：增量拉取。首次无缓存时全量 SEARCH 取尾 cap；之后只 SEARCH 上次
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
                let name = a
                    .name
                    .as_ref()
                    .map(|n| String::from_utf8_lossy(n).into_owned());
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
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();
        let subject = if subject.is_empty() {
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
            .map(|b| {
                let text = String::from_utf8_lossy(b);
                let clean = text
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" ");
                clean.chars().take(200).collect()
            })
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
    // C-20：成功落盘本轮的"最近 cap 封 UID"窗口，作为下一轮增量 SEARCH 起点。
    write_snapshot(
        cache_key,
        MailboxSnapshot {
            recent_uids: recent,
            uid_validity,
        },
    );
    Ok(messages)
}

/// C-4：UID 必须是单个非空 32 位整数，拒绝 `,` `*` `:` 等 sequence-set 注入，
/// 防止被篡改的渲染层把 `1:*` 这类区间送入 UID STORE 误删全邮箱。
fn parse_uid(uid: &str) -> Result<u32, String> {
    if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("无效的邮件 UID: {uid}"));
    }
    uid.parse::<u32>()
        .map_err(|_| format!("无效的邮件 UID: {uid}"))
}

/// W-135 已读回写：服务器侧给邮件打上 \Seen（SILENT 免回包）。
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
    let uid = parse_uid(&uid)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // C-5：同上，明文仅在后端按需解密。
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

/// W-135 删除回写：打 \Deleted 标记并 EXPUNGE，真实删除服务器邮件。
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
    let uid = parse_uid(&uid)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // C-5：同上，明文仅在后端按需解密。
        let account = resolve_account(&app, &account)?;
        let mut session = open_session(&account)?;
        session
            .uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
            .map_err(|e| format!("标记删除失败: {e}"))?;
        session
            .expunge()
            .map_err(|e| format!("删除邮件失败: {e}"))?;
        session.logout().ok();
        Ok(())
    })
    .await
    .map_err(|e| format!("邮件任务失败: {e}"))?
}

/// W-134 多账户：保存账户列表（整体覆盖写，SQLite settings 表）。
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
    // P1（审计修复）：凭据写入路径必须受信窗口可达，与 load_email_accounts 对称。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 同步命令在 Tauri 主线程上锁库：备份/导入持锁期间会冻结所有窗口并让
    // 低级鼠标钩子超时被摘（R1 规则），与其余 DB 命令一致下沉到阻塞池。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // C-5：前端对未改动的账户只回传掩码（空）密码；按 (email, server) 找回
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

/// DPAPI 解密；带 `dpapi:` 前缀的解密，否则视为旧版明文原样返回（向后
/// 兼容已存的明文账户，保存一次后即自动升级为密文）。
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
    // E-3: on Windows, any non-`dpapi:` value is legacy plaintext. A tampered
    // restore could smuggle a plaintext password into `email:accounts` and have
    // it silently accepted here — do not hand it back to the webview.
    log::warn!("email password: non-dpapi value ignored (legacy plaintext unsupported)");
    String::new()
}

/// C-5：读取 `email:accounts`（仍为 DPAPI 密文），不解密。用于校验已有
/// 账户与按索引找回真实密码 —— 明文只在后端按需解密、永不下发 webview。
fn read_stored_accounts_encrypted(state: &AppState) -> Result<Vec<EmailAccount>, String> {
    let db = lock_db(&state.db).map_err(|e| format!("数据库锁定失败: {e}"))?;
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

/// C-5：前端只持有掩码（空）密码；按 (email, server) 从密文库找回真实
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
            return Ok(resolved);
        }
    }
    Ok(account.clone())
}

/// W-134 多账户：读取账户列表；旧版单账户键（email:account）自动迁移为
/// 单元素列表，读后不删旧键（保留回滚能力，保存时写新键）。
///
/// C-5：返回前一律把密码掩码为空串 —— DPAPI 解密后的明文绝不回传任何
/// webview（含 widget-* / quick-note），凭据仅在 fetch/mark/delete 时由后端
/// 按需解密。
/// C-19：账户元数据（邮箱/服务器/IMAP 配置）仍属敏感信息，加窗口闸门，
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
        let mut accounts = read_stored_accounts_encrypted(&state)?;
        if !accounts.is_empty() {
            for a in accounts.iter_mut() {
                a.password = String::new();
            }
            return Ok(accounts);
        }

        // 旧版迁移：单账户 → 单元素列表（同样掩码密码，永不明文回传）。
        let db = lock_db(&state.db).map_err(|e| format!("数据库锁定失败: {e}"))?;
        let old: Result<String, _> = db.query_row(
            "SELECT value FROM settings WHERE key = 'email:account'",
            [],
            |row| row.get(0),
        );
        match old {
            Ok(json) => {
                let mut account: EmailAccount =
                    serde_json::from_str(&json).map_err(|e| format!("旧账户迁移失败: {e}"))?;
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
