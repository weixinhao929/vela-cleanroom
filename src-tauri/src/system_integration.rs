//! System-level integration commands: startup autostart, update checks, and
//! desktop-icon visibility. Windows-only behavior is guarded behind `#[cfg]`.

use serde::Serialize;
use tauri::{Emitter, Manager};
use ts_rs::TS;

const AUTOSTART_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_NAME: &str = "Vela";
/// Prior to the "Vela" rename the Run entry was registered as "Focus Desk";
/// those stale entries point at an uninstalled exe and must be cleaned up.
const LEGACY_AUTOSTART_NAMES: [&str; 1] = ["Focus Desk"];
/// Explorer mirrors the desktop "Show desktop icons" toggle here (1 = hidden).
/// The value is absent on a fresh profile, which means icons are shown.
const DESKTOP_ICONS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
const DESKTOP_ICONS_HIDDEN_VALUE: &str = "HideIcons";

/// 进程级复用的 HTTP 客户端（无自动重定向）。
///
/// 默认 Client 的重定向策略会自动跟随最多 10 跳且只对初始
/// URL 做过校验——公网 URL 可 302 到 127.0.0.1 击穿 reject_private_target
/// （SSRF），更新下载可被重定向到任意主机击穿同域校验（SHA-256 校验形同虚设，
/// 构成 RCE 链）。因此所有网络命令统一走 `send_guarded`：禁用自动重定向 +
/// 每一跳重新执行守卫校验。
fn guarded_client() -> &'static reqwest::blocking::Client {
    static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // [UPD-CH]GitHub API 拒绝无
            // User-Agent 的请求（403）；版本列表 / latest 探测都走本客户端。
            .user_agent(concat!("Vela/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|e| {
                // 兜底不能用 `Client::new()`——默认
                // 客户端自动跟随最多 10 跳重定向，只对初始 URL 做守卫校验，
                // builder 失败这条路径会静默击穿 send_guarded 的逐跳守卫
                // （SSRF / 跨域下载全数复活）。改为显式带 `Policy::none()`
                // 的再构建：任何路径下自动重定向都必须是关闭的。
                log::error!(
                    "guarded_client: builder failed ({e}); rebuilding with redirects disabled"
                );
                reqwest::blocking::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap_or_else(|e2| {
                        // 两次构建都失败意味着 TLS/运行时子系统整体不可用
                        // （`Client::new()` 在同一场合本身就是 panic）——此时
                        // 不存在任何可用客户端，更不存在安全的降级客户端；
                        // 显式 fail-fast 好过静默换回会跟随重定向的默认端。
                        panic!(
                            "guarded_client: cannot build a no-redirect HTTP client ({e} / {e2})"
                        );
                    })
            })
    })
}

/// 重定向上限：正常更新源/日历订阅最多一两跳。
const MAX_REDIRECTS: usize = 5;

/// 手动跟随重定向的请求发送器。每一跳（含初始 URL）都执行
/// `guard` 校验，任一跳被拒立即终止；超过 MAX_REDIRECTS 视为循环重定向拒绝。
fn send_guarded(
    url: &str,
    timeout: std::time::Duration,
    guard: &dyn Fn(&str) -> Result<(), String>,
) -> Result<reqwest::blocking::Response, String> {
    let client = guarded_client();
    let mut current = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        guard(&current)?;
        let resp = client
            .get(&current)
            .timeout(timeout)
            .send()
            .map_err(|e| format!("请求失败：{e}"))?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| format!("HTTP {}", resp.status()))?;
            let base = url::Url::parse(&current).map_err(|_| "无效 URL".to_string())?;
            current = base
                .join(loc)
                .map_err(|_| "重定向地址无效".to_string())?
                .to_string();
            continue;
        }
        return Ok(resp);
    }
    Err("重定向次数过多，已中止".to_string())
}

/// 返回用户配置的更新源（`extra.updateEndpoint`）的 host 小写形式。
/// 下载地址必须与该 host 同域（或为其子域），否则拒绝 —— 把一个"任意 URL
/// 下载 + 静默执行"的原语收口为"只能从用户已信任的更新源取包"。
fn configured_update_host(app: &tauri::AppHandle) -> Option<String> {
    let state = app.try_state::<crate::AppState>()?;
    let conn = crate::db::lock_db(&state.db).ok()?;
    let json: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'app:settings:v1'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let endpoint = value.get("extra")?.get("updateEndpoint")?.as_str()?;
    host_of(endpoint)
}

fn host_of(raw: &str) -> Option<String> {
    url::Url::parse(raw).ok()?.host_str().map(str::to_lowercase)
}

/// host 等于 allowed，或是其子域（`x.allowed`）。端口不参与比较（host_str 已去端口）。
fn host_allowed(host: &str, allowed: &str) -> bool {
    host == allowed || host.ends_with(&format!(".{allowed}"))
}

/// GitHub Releases 资产下载固定 302 到官方 CDN
/// （objects.githubusercontent.com，2024 年起新仓库逐步切到
/// release-assets.githubusercontent.com）。仅当用户配置的更新源就是
/// github.com 时放行这两个官方域；其它更新源维持严格同域（收口
/// 不放松——这两个域只服务 GitHub Release 资产，信任随 github.com 走）。
fn is_github_official_host(host: &str) -> bool {
    host == "github.com"
        || host == "objects.githubusercontent.com"
        || host == "release-assets.githubusercontent.com"
}

/// 安装包下载到用户「下载」文件夹（KNOWNFOLDER API，
/// 兼容 OneDrive 重定向），而不是临时目录——自动安装失败时用户可以找到
/// 安装包手动运行。取不到时回退 %USERPROFILE%\Downloads，再回退临时目录。
/// 子目录固定名 Vela-update，下载前清理旧包（目录内只保留最新一份）。
fn update_stage_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{
            FOLDERID_Downloads, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG,
        };
        // SAFETY: 只读查询已知文件夹路径；PWSTR 指向 shell 分配的 NUL 结尾
        // 宽字符串，as_wide 内部按 NUL 定界读取，CoTaskMemFree 释放分配。
        if let Ok(wide) =
            unsafe { SHGetKnownFolderPath(&FOLDERID_Downloads, KNOWN_FOLDER_FLAG(0), None) }
        {
            let path = unsafe { String::from_utf16_lossy(wide.as_wide()) };
            unsafe { CoTaskMemFree(Some(wide.as_ptr() as *const core::ffi::c_void)) };
            if !path.is_empty() {
                return std::path::PathBuf::from(path).join("Vela-update");
            }
        }
    }
    std::env::var_os("USERPROFILE")
        .map(|p| {
            std::path::PathBuf::from(p)
                .join("Downloads")
                .join("Vela-update")
        })
        .unwrap_or_else(|| std::env::temp_dir().join("vela-update"))
}

/// GitHub API 匿名配额（60 次/小时）用尽时的兜底——
/// 请求 `<repo>/releases/latest`，读取 302 Location 中的
/// `/releases/tag/<tag>` 提取最新版本 tag。只做第一跳、不跟随（Location
/// 本身就是答案），内网目标照常拒绝。
#[tauri::command]
pub async fn resolve_latest_tag(
    window: tauri::Window,
    url: String,
) -> Result<Option<String>, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    reject_private_target(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = guarded_client();
        let resp = client
            .get(&url)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .map_err(|e| format!("请求失败：{e}"))?;
        if !resp.status().is_redirection() {
            // 非 302（仓库无 Release / 页面改版 / 已是最终响应）：不算错误，
            // 返回 None 让前端回落到原错误展示。
            return Ok(None);
        }
        let loc = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("HTTP {}", resp.status()))?
            .to_string();
        Ok(extract_release_tag(&loc))
    })
    .await
    .map_err(|e| format!("网络任务失败：{e}"))?
}

/// 从（绝对或相对的）Location 值中提取 `releases/tag/<name>` 的 tag；
/// `<name>` 截到下一个 `/`、`?` 或 `#`，空串视为无效。
fn extract_release_tag(loc: &str) -> Option<String> {
    let pos = loc.find("/releases/tag/")?;
    let rest = &loc[pos + "/releases/tag/".len()..];
    let tag = rest.split(['/', '?', '#']).next()?.trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

/// 计算字节串的 SHA-256 十六进制摘要（64 个小写字母数字）。仅测试使用
/// （生产路径已全部改为流式 hasher）。
#[cfg(test)]
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    digest_hex(&Sha256::digest(bytes))
}

/// 十六进制摘要格式化（供流式 hasher 复用）。
fn digest_hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub notes: String,
}

/// velatap.dll 完整性诊断——分发 DLL 与已解包副本的 SHA-256，供设置页
/// 诊断区展示并与发布侧 SHA256SUMS 人工比对（安装包未签名期间的用户侧
/// 校验通道）。运行时注入链另有 §5.4 的解包哈希校验，此处只读不判定。
#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct VelatapDigest {
    pub bundled_path: Option<String>,
    pub bundled_sha256: Option<String>,
    pub unpacked_path: Option<String>,
    pub unpacked_sha256: Option<String>,
    pub unpacked_matches_bundled: bool,
}

#[tauri::command]
pub async fn get_velatap_digest(window: tauri::Window) -> Result<VelatapDigest, String> {
    // 安装路径 + 文件哈希属敏感面，仅设置窗可读（口径）。
    crate::require_settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        use sha2::{Digest, Sha256};
        let sha256_hex = |p: &std::path::Path| -> Option<String> {
            let bytes = std::fs::read(p).ok()?;
            let digest = Sha256::digest(&bytes);
            Some(digest.iter().map(|b| format!("{b:02x}")).collect())
        };
        let show = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let bundled = crate::taskbar::injector::locate_dll();
        let (bundled_path, bundled_sha256) = match &bundled {
            Some(p) => (Some(show(p)), sha256_hex(p)),
            None => (None, None),
        };
        // 已解包副本：tap 根下最新的 <hash>/velatap.dll（可能多版本并存，
        // 取修改时间最新一份——旧 explorer 进程占用的旧目录无诊断意义）。
        let mut unpacked: Option<(std::path::PathBuf, String)> = None;
        if let Ok(entries) = std::fs::read_dir(crate::taskbar::injector::tap_root()) {
            for e in entries.flatten() {
                let dll = e.path().join("velatap.dll");
                let Ok(meta) = std::fs::metadata(&dll) else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let mtime = meta.modified().ok();
                let better = unpacked
                    .as_ref()
                    .and_then(|(p, _)| std::fs::metadata(p).and_then(|m| m.modified()).ok())
                    .is_none_or(|prev| mtime.is_some_and(|t| t > prev));
                if better {
                    if let Some(hex) = sha256_hex(&dll) {
                        unpacked = Some((dll, hex));
                    }
                }
            }
        }
        let (unpacked_path, unpacked_sha256) = match unpacked {
            Some((p, hex)) => (Some(show(&p)), Some(hex)),
            None => (None, None),
        };
        let unpacked_matches_bundled = match (&bundled_sha256, &unpacked_sha256) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
        Ok(VelatapDigest {
            bundled_path,
            bundled_sha256,
            unpacked_path,
            unpacked_sha256,
            unpacked_matches_bundled,
        })
    })
    .await
    .map_err(|e| format!("诊断任务失败: {e}"))?
}

/// Controls whether the app auto-starts at Windows login by writing / removing
/// an entry under the HKCU `Run` registry key.
#[tauri::command]
pub fn set_autostart(window: tauri::Window, enabled: bool) -> Result<(), String> {
    // 写注册表 Run 键属高危副作用：与全库其它高危命令一致挂窗口闸门（quick-note
    // 等非受信窗口不得触达）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let run = hkcu
            .open_subkey_with_flags(
                AUTOSTART_KEY,
                winreg::enums::KEY_SET_VALUE | winreg::enums::KEY_READ,
            )
            .map_err(|e| e.to_string())?;
        // Stale "Focus Desk" entries (pointing at the uninstalled old exe)
        // are removed regardless of the requested state so the Run key stays clean.
        for legacy in LEGACY_AUTOSTART_NAMES {
            let _ = run.delete_value(legacy);
        }
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            run.set_value(AUTOSTART_NAME, &format!("\"{}\"", exe.display()))
                .map_err(|e| e.to_string())?;
        } else {
            let _ = run.delete_value(AUTOSTART_NAME);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Auto-start is only supported on Windows".to_string())
    }
}

/// Reports whether auto-start is currently enabled.
#[tauri::command]
pub fn get_autostart(window: tauri::Window) -> Result<bool, String> {
    // 读 HKCU Run 并与 current_exe 比对——泄露安装路径，收 settings-only。
    crate::require_settings_window(&window)?;
    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        if let Ok(run) = hkcu.open_subkey(AUTOSTART_KEY) {
            if let Ok(val) = run.get_value::<String, _>(AUTOSTART_NAME) {
                // 键值存在但指向别的 exe（应用搬过目录 / 更新器换了安装位置）
                // 时自启实际已失效：如实报 false（设置页显示关），用户重新打开
                // 时 set_autostart 会以当前 exe 覆写完成自愈——不能只看键是否
                // 存在，否则「显示为开、开机不自启」无从察觉。
                return match std::env::current_exe() {
                    // 拿不到当前路径时不误判，维持「键存在即开」的旧口径。
                    Err(_) => Ok(true),
                    Ok(cur) => Ok(run_value_matches_exe(&val, &cur)),
                };
            }
        }
        Ok(false)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// Run 值与当前 exe 是否指向同一文件：容忍 set_autostart 写入的成对引号与
/// 正/反斜杠差异（Windows 路径大小写不敏感，比较前统一小写）。
#[cfg(windows)]
fn run_value_matches_exe(val: &str, cur: &std::path::Path) -> bool {
    let stripped = val.trim().trim_matches('"');
    let norm = |p: &str| p.replace('/', "\\").to_lowercase();
    norm(stripped) == norm(&cur.to_string_lossy())
}

/// 本地版本状态快照（原 check_updates，改名：占位实现不联网，旧名暗示
/// 「检查更新」会误导调用方/读者以为发生了网络查询）。真实部署后此命令查询
/// release 端点并驱动 `tauri-plugin-updater`；当前返回打包版本与「已是最新」，
/// 让设置页有一个可用的实时视图。网络链路由 update-flow 的
/// resolve_latest_tag/download_update 承担。
#[tauri::command]
pub fn get_update_info(window: tauri::Window) -> Result<UpdateInfo, String> {
    crate::require_trusted(&window)?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    Ok(UpdateInfo {
        current_version: current.clone(),
        latest_version: current,
        has_update: false,
        notes: "已是最新版本".to_string(),
    })
}

/// Locates the desktop `SHELLDLL_DefView` window. Depending on wallpaper mode
/// Windows parents it either directly under `Progman` or under a `WorkerW`
/// sibling spawned after wallpaper-type changes, so all known layouts are
/// probed before giving up.
#[cfg(windows)]
fn find_shell_view() -> windows::Win32::Foundation::HWND {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW};

    let view_class = HSTRING::from("SHELLDLL_DefView");
    // SAFETY: read-only system window handle queries.
    unsafe {
        let progman = FindWindowW(&HSTRING::from("Progman"), None).unwrap_or_default();
        if !progman.0.is_null() {
            let view = FindWindowExW(Some(progman), None, &view_class, None).unwrap_or_default();
            if !view.0.is_null() {
                return view;
            }
        }
        // Dozens of unrelated top-level `WorkerW` windows exist at any time and
        // `FindWindowW` only yields the z-order-first one, so walk them all.
        let workerw_class = HSTRING::from("WorkerW");
        let mut after: Option<HWND> = None;
        loop {
            let workerw = FindWindowExW(None, after, &workerw_class, None).unwrap_or_default();
            if workerw.0.is_null() {
                break;
            }
            let view = FindWindowExW(Some(workerw), None, &view_class, None).unwrap_or_default();
            if !view.0.is_null() {
                return view;
            }
            after = Some(workerw);
        }
        // Some shell builds expose the view as a top-level window.
        FindWindowW(&view_class, None).unwrap_or_default()
    }
}

/// Shows or hides the native Windows desktop icons from the shell. Reuses the
/// classic `SHELLDLL_DefView` + `WM_COMMAND` toggle so widgets can fully
/// replace the traditional icon stack.
///
/// async + spawn_blocking：`SendMessageTimeoutW(SMTO_NORMAL, 1000)` 最长阻塞
/// 1 秒（shell 挂起时真会发生）；同步命令跑在 Tauri 主线程上会冻结所有窗口。
#[tauri::command]
pub async fn set_desktop_icons(window: tauri::Window, show: bool) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 0x7402 is a toggle: two overlapping calls (a quick off→on flip) could
    // both probe before either lands and cancel each other out.
    static DESKTOP_ICONS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    tauri::async_runtime::spawn_blocking(move || {
        let _serialized = DESKTOP_ICONS_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        set_desktop_icons_blocking(show)
    })
    .await
    .map_err(|e| format!("桌面图标任务失败：{e}"))?
}

fn set_desktop_icons_blocking(show: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        // The 0x7402 command TOGGLES icon visibility, so blindly sending it for
        // the requested state would invert the setting when it already matches
        // (e.g. `set_desktop_icons(false)` with icons already hidden would SHOW
        // them). Query the current state first and only toggle on a difference,
        // which makes the command idempotent.
        if desktop_icons_visible() == show {
            return Ok(());
        }
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, SMTO_NORMAL, WM_COMMAND,
        };

        // SAFETY: FindWindowW/FindWindowExW/SendMessageTimeoutW operate on
        // system window handles.
        let delivered = unsafe {
            let shell_view = find_shell_view();
            if shell_view.0.is_null() {
                return Err("无法定位桌面视图".to_string());
            }
            let mut result = 0usize;
            const TOGGLE_ICONS_ID: usize = 0x7402;
            SendMessageTimeoutW(
                shell_view,
                WM_COMMAND,
                WPARAM(TOGGLE_ICONS_ID),
                LPARAM(0),
                SMTO_NORMAL,
                1000,
                Some(&mut result),
            )
        };
        // Zero means the call failed or timed out, i.e. explorer never ran it.
        if delivered.0 == 0 {
            return Err("桌面图标切换超时".to_string());
        }
        // Explorer mirrors the new state to the registry shortly after handling
        // the message (~100-300ms observed); confirm it landed rather than
        // assuming success.
        for _ in 0..10 {
            if desktop_icons_visible() == show {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Err("桌面图标切换未生效".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = show;
        Err("Desktop icon control is only supported on Windows".to_string())
    }
}

/// 拒绝指向本机/内网的 URL（SSRF 探测面）。
///
/// 改用 url::Url 解析 host（手写解析不识别十进制/十六进制/
/// 八进制 IP 字面量，如 `http://2130706433/` == 127.0.0.1，可绕过判定），
/// 并补齐数字字面量的归一化识别。"域名解析到内网 IP"的 rebinding 不在本次
/// 防线内（需解析后二次校验，成本高且本命令仅受信窗口可达）。
pub(crate) fn reject_private_target(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "仅支持 http/https 链接".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("仅支持 http/https 链接".into());
    }
    // `host_str()` 对 IPv6 返回带方括号的 "[::1]"，`parse::<IpAddr>()` 必然
    // 失败——此前的 IPv6 判定分支因此从未执行，`http://[::1]/` 与
    // `http://[::ffff:127.0.0.1]/` 全部放行。改用结构化 `host()` 判定。
    let Some(host) = parsed.host() else {
        return Err("禁止访问本机地址".into());
    };
    match host {
        url::Host::Ipv4(v4) => {
            if is_private_v4(v4) {
                return Err("禁止访问内网地址".into());
            }
        }
        url::Host::Ipv6(v6) => {
            if is_private_v6(v6) {
                return Err("禁止访问内网地址".into());
            }
        }
        url::Host::Domain(domain) => {
            let lower = domain.to_ascii_lowercase();
            if lower.is_empty() || lower == "localhost" || lower.ends_with(".localhost") {
                return Err("禁止访问本机地址".into());
            }
            // url crate 已把标准数字写法归一为 Host::Ipv4；这里兜底它不识别的
            // 十进制整数 / 0x 前缀 / 八进制段等变体，命中即按 IPv4 判定。
            if let Some(v4) = parse_ipv4_lenient(domain) {
                if is_private_v4(v4) {
                    return Err("禁止访问内网地址".into());
                }
            }
        }
    }
    Ok(())
}

fn is_private_v4(v4: std::net::Ipv4Addr) -> bool {
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
}

/// 回环 / 未指定 / IPv4-mapped 与 IPv4-compatible 内嵌地址 / 链路本地
/// fe80::/10 / ULA fc00::/7 / 组播 ff00::/8 均视为内网目标。
fn is_private_v6(v6: std::net::Ipv6Addr) -> bool {
    if v6.is_loopback() || v6.is_unspecified() {
        return true;
    }
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    if let Some(v4) = v6.to_ipv4() {
        return is_private_v4(v4);
    }
    let first = v6.segments()[0];
    (first & 0xffc0) == 0xfe80 || (first & 0xfe00) == 0xfc00 || (first & 0xff00) == 0xff00
}

/// 解析点分十进制/整数/0x 十六进制/前导零八进制混合写的 IPv4 字面量；
/// 不是 v4 字面量则返回 None（交给后续域名处理）。兼容 `127.1` 这类
/// 省略写法（== 127.0.0.1），与浏览器/系统解析行为对齐。
fn parse_ipv4_lenient(host: &str) -> Option<std::net::Ipv4Addr> {
    if !host.contains('.') {
        let v = parse_u32_radix(host)?;
        return Some(std::net::Ipv4Addr::from(v));
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 4 {
        return None;
    }
    let mut value: u32 = 0;
    for (i, p) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        let n = parse_u32_radix(p)? as u64;
        if last {
            // 最后一段占据剩余低位字段："127.1" 这类 2 段写法占 24 位
            // （== 127.0.0.1），与系统 inet_aton 语义对齐。
            let shift = 8u64 * (5 - parts.len() as u64);
            if shift == 0 || shift > 24 || n >= (1u128 << shift) as u64 {
                return None;
            }
            // 已累计的高位段整体上移，让出低位给最后一段。
            value = (((value as u64) << shift) | n) as u32;
        } else {
            if n > 255 {
                return None;
            }
            value = (((value as u64) << 8) | n) as u32;
        }
    }
    Some(std::net::Ipv4Addr::from(value))
}

/// 按前缀解析无符号整数：`0x` 十六进制、前导 `0` 八进制、其余十进制。
fn parse_u32_radix(s: &str) -> Option<u32> {
    let s = s.trim();
    let (radix, digits) = if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        (16u32, h)
    } else if s.len() > 1 && s.starts_with('0') {
        (8u32, &s[1..])
    } else {
        (10u32, s)
    };
    if digits.is_empty() {
        return None;
    }
    u32::from_str_radix(digits, radix).ok()
}

/// [GALLERY]：在线预设画廊的包下载。
/// 与 download_update 的差异：不限定更新源同域（画廊可指向任意公开站点），
/// 但 **sha256 必填**——期望值缺失或校验失败一律删除半成品并报错；
/// 逐跳内网拒绝照旧，先写 .part 校验通过再改名（CSH ContentUpdater 同款）。
#[tauri::command]
pub async fn download_gallery_file(
    window: tauri::Window,
    app: tauri::AppHandle,
    url: String,
    expected_sha256: String,
) -> Result<String, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let want = expected_sha256.trim().to_lowercase();
    if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("画廊清单缺少合法的 sha256 校验值".into());
    }
    reject_private_target(&url)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // 此处有意保留 http://——完整性由必填 sha256（上方 64-hex
        // 校验 + 流式比对、失败删 .part）封死，on-path 篡改最坏只损机密性
        // （预置包是纯读取不解压的样式 JSON，无执行面）；不与更新链同钉
        // https 是为了兼容仅 http 可达的自建源。收紧与否待后续按需评估。
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("仅支持 http/https 链接".into());
        }
        let mut resp = send_guarded(
            &url,
            std::time::Duration::from_secs(60),
            &reject_private_target,
        )?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        const MAX_GALLERY_BYTES: u64 = 32 * 1024 * 1024;
        if let Some(len) = resp.content_length() {
            if len > MAX_GALLERY_BYTES {
                return Err("文件过大（超过 32MB）".into());
            }
        }
        let dir = crate::vela_data_dir(&app)
            .map_err(|e| format!("数据目录不可用：{e}"))?
            .join("gallery-dl");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let final_path = dir.join(format!("preset-{stamp}.velapreset"));
        let part_path = dir.join(format!("preset-{stamp}.part"));

        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        let mut file =
            std::fs::File::create(&part_path).map_err(|e| format!("创建临时文件失败：{e}"))?;
        let mut written: u64 = 0;
        let mut chunk = [0u8; 64 * 1024];
        use std::io::{Read, Write};
        loop {
            let n = resp
                .read(&mut chunk)
                .map_err(|e| format!("读取响应失败：{e}"))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > MAX_GALLERY_BYTES {
                let _ = std::fs::remove_file(&part_path);
                return Err("文件过大（超过 32MB）".into());
            }
            hasher.update(&chunk[..n]);
            file.write_all(&chunk[..n])
                .map_err(|e| format!("写入文件失败：{e}"))?;
        }
        let got = digest_hex(&hasher.finalize());
        if got != want {
            let _ = std::fs::remove_file(&part_path);
            return Err("校验失败（sha256 不匹配），已丢弃下载文件".to_string());
        }
        std::fs::rename(&part_path, &final_path).map_err(|e| format!("落盘失败：{e}"))?;
        Ok(final_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("下载任务失败：{e}"))?
}

/// 通用文本拉取：ICS 日历订阅与节假日 JSON 在 webview 里会被
/// CORS 拦截（Google/Outlook 不发 Access-Control-Allow-Origin），因此由 Rust
/// 侧代理拉取。async + spawn_blocking，避免阻塞 IPC 线程；限制 2MB 与
/// http/https scheme，防止被当作任意文件读取通道。
#[tauri::command]
pub async fn fetch_url_text(window: tauri::Window, url: String) -> Result<String, String> {
    // 代理拉取能力只开放给受信窗口，并拒绝内网目标。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    reject_private_target(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("仅支持 http/https 链接".to_string());
        }
        // 每一跳重定向都重新执行内网拒绝校验。
        let mut resp = send_guarded(
            &url,
            std::time::Duration::from_secs(30),
            &reject_private_target,
        )?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        // 流式读取并边读边限额（此前 `resp.bytes()` 先整包缓冲再检查大小，
        // 指向超大资源即可打爆内存）；与 net_speed_probe 同法。
        const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
        if let Some(len) = resp.content_length() {
            if len > MAX_TEXT_BYTES as u64 {
                return Err("响应过大（超过 2MB）".to_string());
            }
        }
        let mut body: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        use std::io::Read;
        loop {
            let n = resp
                .read(&mut chunk)
                .map_err(|e| format!("读取响应失败：{e}"))?;
            if n == 0 {
                break;
            }
            if body.len() + n > MAX_TEXT_BYTES {
                return Err("响应过大（超过 2MB）".to_string());
            }
            body.extend_from_slice(&chunk[..n]);
        }
        String::from_utf8(body).map_err(|_| "响应不是 UTF-8 文本".to_string())
    })
    .await
    .map_err(|e| format!("网络任务失败：{e}"))?
}

/* ------------------------------------------------------------------ */
/* 歌词引擎受控代理（一.5：项目所有者解除「不碰灰色源」边界后的通道）    */
/* ------------------------------------------------------------------ */

/// QQ 音乐 / 网易云的公开接口不带 CORS 头，webview 直连必被拦。本命令只对
/// 歌词引擎域名单放行，不构成开放代理；UA 固定桌面 Chrome（裸 UA 会被风控
/// 拒答），可选 Referer（QQ 歌词接口要求）与 form POST（网易云搜索）。
/// 刻意**不带** X-Real-IP 伪装头：同类工具 时代用它绕地区限制，2026 实测该头
/// 反而触发网易云的加密反爬响应（返回十六进制密文），裸 UA + Referer 直连
/// 即为当前可用组合。
/// 沿用 reject_private_target 的内网拒绝 + 流式限额读取（1MB，歌词远小于此）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricPage {
    pub status: u16,
    pub body: String,
}

/// 歌词代理 UA：无 UA 的请求会被两家接口直接拒答。
const LYRIC_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
/// 歌词引擎域名白名单（https + 精确主机）：子域伪装 / 明文 http / 内网
/// 一律不在名单内——重定向跳到这些目标时由每跳校验拦下。
fn is_lyric_host(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" {
        return false;
    }
    match u.host_str() {
        Some(h) => h == "c.y.qq.com" || h == "y.qq.com" || h == "music.163.com",
        None => false,
    }
}

#[tauri::command]
pub async fn fetch_lyric_page(
    window: tauri::Window,
    url: String,
    referer: Option<String>,
    post_body: Option<String>,
) -> Result<LyricPage, String> {
    // 同 fetch_url_text —— 受信窗口 + 内网目标拒绝，另加域名白名单。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    if !url.starts_with("https://") {
        return Err("仅支持 https 链接".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 每一跳重定向都重新校验：域名白名单 + 内网拒绝。302 后按浏览器语义
        // 降级为 GET（POST 体不跨跳保留）。
        let mut current = url;
        let mut post = post_body;
        let mut resp = None;
        for _ in 0..=MAX_REDIRECTS {
            if !is_lyric_host(&current) {
                return Err("歌词代理仅放行歌词引擎域名".to_string());
            }
            reject_private_target(&current)?;
            let req = if let Some(body) = post.as_deref() {
                guarded_client()
                    .post(&current)
                    .timeout(std::time::Duration::from_secs(8))
                    .header(reqwest::header::USER_AGENT, LYRIC_UA)
                    .header(
                        reqwest::header::CONTENT_TYPE,
                        "application/x-www-form-urlencoded",
                    )
                    .body(body.to_string())
            } else {
                guarded_client()
                    .get(&current)
                    .timeout(std::time::Duration::from_secs(8))
                    .header(reqwest::header::USER_AGENT, LYRIC_UA)
            };
            let req = match referer.as_deref() {
                Some(r) => req.header(reqwest::header::REFERER, r),
                None => req,
            };
            let r = req.send().map_err(|e| format!("请求失败：{e}"))?;
            if r.status().is_redirection() {
                let loc = r
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| format!("HTTP {}", r.status()))?;
                let base = url::Url::parse(&current).map_err(|_| "无效 URL".to_string())?;
                current = base
                    .join(loc)
                    .map_err(|_| "重定向地址无效".to_string())?
                    .to_string();
                post = None;
                continue;
            }
            resp = Some(r);
            break;
        }
        let mut resp = resp.ok_or("重定向次数超限")?;
        let status = resp.status().as_u16();
        // 流式限额读取（与 fetch_url_text 同法，上限降到 1MB）。
        const MAX_LYRIC_BYTES: usize = 1024 * 1024;
        if let Some(len) = resp.content_length() {
            if len > MAX_LYRIC_BYTES as u64 {
                return Err("响应过大（超过 1MB）".to_string());
            }
        }
        let mut body: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 32 * 1024];
        use std::io::Read;
        loop {
            let n = resp
                .read(&mut chunk)
                .map_err(|e| format!("读取响应失败：{e}"))?;
            if n == 0 {
                break;
            }
            if body.len() + n > MAX_LYRIC_BYTES {
                return Err("响应过大（超过 1MB）".to_string());
            }
            body.extend_from_slice(&chunk[..n]);
        }
        Ok(LyricPage {
            status,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    })
    .await
    .map_err(|e| format!("网络任务失败：{e}"))?
}

/// 网速探测兜底：webview 里测速会被 CORS / 企业代理 / 证书拦截导致"测不出
/// 来"，此命令由 Rust 侧直连流式下载已知负载，返回 (实际字节, 耗时毫秒)。
/// async + spawn_blocking；限制 32MB 与 http/https scheme。
#[tauri::command]
pub async fn net_speed_probe(
    window: tauri::Window,
    url: String,
    max_bytes: u64,
) -> Result<(u64, u64), String> {
    // 同 fetch_url_text —— 受信窗口 + 内网目标拒绝。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    reject_private_target(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("仅支持 http/https 链接".to_string());
        }
        let max_bytes = max_bytes.clamp(1, 32 * 1024 * 1024);
        let started = std::time::Instant::now();
        // 每一跳重定向都重新执行内网拒绝校验。
        let mut resp = send_guarded(
            &url,
            std::time::Duration::from_secs(30),
            &reject_private_target,
        )?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let mut total: u64 = 0;
        let mut buffer = [0u8; 64 * 1024];
        use std::io::Read;
        while total < max_bytes {
            let want = std::cmp::min(buffer.len() as u64, max_bytes - total) as usize;
            match resp.read(&mut buffer[..want]) {
                Ok(0) => break,
                Ok(n) => total += n as u64,
                Err(e) => return Err(format!("读取响应失败：{e}")),
            }
        }
        Ok((total, started.elapsed().as_millis() as u64))
    })
    .await
    .map_err(|e| format!("网络任务失败：{e}"))?
}

/// 网速探测兜底（上行）：webview 里 XHR 上传会被 CORS / 代理拦截导致"测不出
/// 来"，此命令由 Rust 侧直连 POST 不可压缩伪随机体到测速端点，返回
/// (发送字节, 耗时毫秒)。与 net_speed_probe 同一安全约束（受信窗口 +
/// 内网目标拒绝 + 8MB 上限）。耗时含建连与完整请求体送出，是单窗口均值。
#[tauri::command]
pub async fn net_upload_probe(
    window: tauri::Window,
    url: String,
    bytes: u64,
) -> Result<(u64, u64), String> {
    // 同 net_speed_probe —— 受信窗口 + 内网目标拒绝。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    reject_private_target(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("仅支持 http/https 链接".to_string());
        }
        let size = bytes.clamp(1, 8 * 1024 * 1024) as usize;
        // LCG 伪随机体：不可压缩，防中间层透明压缩把负载压小、虚高速率。
        let mut body = Vec::with_capacity(size);
        let mut x: u32 = 0x1234_5678;
        while body.len() < size {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            body.extend_from_slice(&x.to_le_bytes());
        }
        body.truncate(size);
        let started = std::time::Instant::now();
        let client = guarded_client();
        // __up 端点不重定向；guarded_client 已禁自动重定向，若服务端真回 3xx
        // 这里按非成功处理，不跟随（目标 URL 已过 reject_private_target）。
        let resp = client
            .post(&url)
            .timeout(std::time::Duration::from_secs(30))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(body)
            .send()
            .map_err(|e| format!("上传失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        Ok((size as u64, started.elapsed().as_millis() as u64))
    })
    .await
    .map_err(|e| format!("网络任务失败：{e}"))?
}

/// Reports whether the native desktop icons are currently visible.
#[tauri::command]
pub fn get_desktop_icons(window: tauri::Window) -> Result<bool, String> {
    crate::require_settings_window(&window)?;
    Ok(desktop_icons_visible())
}

/// Explorer records the toggle in the registry; the window tree cannot answer
/// this because `SHELLDLL_DefView` exists (and reports `IsWindowVisible`) in
/// both states.
fn desktop_icons_visible() -> bool {
    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        hkcu.open_subkey(DESKTOP_ICONS_KEY)
            .and_then(|advanced| advanced.get_value::<u32, _>(DESKTOP_ICONS_HIDDEN_VALUE))
            .map(|hidden| hidden == 0)
            .unwrap_or(true)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// 应用内自动更新：把安装包下载到用户「下载」文件夹的 Vela-update
/// 子目录，返回本地路径。
///
/// 进度通过 `update:progress` 事件上报（已下载字节 / 总字节），前端可据此
/// 渲染进度条。要求更新源返回的 `url` 指向可直接下载的安装包（NSIS .exe）。
/// 下载可达数百 MB，必须 async + spawn_blocking；同步命令会跑在 Tauri
/// 主线程上，把全部窗口（以及依赖主线程泵消息的原生调用）冻结整个下载期。
#[tauri::command]
pub async fn download_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    url: String,
    expected_sha256: Option<String>,
    allow_unsigned_sidecar: Option<bool>,
) -> Result<String, String> {
    // RCE 级命令必须与全库其它高危命令一致地挂窗口闸门
    // （的收口漏网之鱼）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // 无签名清单缺省拒绝（fail-closed）。同源 `.sha256`
    // sidecar 与安装包同源，只防损坏不防「更新源被攻破后连哈希一起换」
    // （见 update_sig.rs 顶部信任模型）——签名机制之前的旧 Release 没有签名
    // 清单，自动安装/自动回滚一律阻断（前端把该错误原样展示给用户，引导
    // 手动下载）。仅当调用方显式传 `allow_unsigned_sidecar=true` 才保留
    // sidecar 兜底——「最后兼容路径」，供确有需要的存量流程显式选择，
    // 缺省（None/false）一律拒绝。在下载开始前拒绝，不白白拉取整包。
    let wants_unsigned_sidecar = allow_unsigned_sidecar.unwrap_or(false);
    let has_expected = expected_sha256
        .as_deref()
        .map(|h| !h.trim().is_empty())
        .unwrap_or(false);
    if !has_expected && !wants_unsigned_sidecar {
        return Err(
            "该版本早于签名机制，出于安全不再提供自动回滚/自动更新（缺少签名校验清单；如需安装请手动下载）"
                .to_string(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 更新链只接受 https——http 源等于把安装包与校验
        // 清单都交给链路上的任何中间人。同源 sidecar 校验对 MITM 无防御力。
        if !url.starts_with("https://") {
            return Err("更新链仅支持 https 链接（D-1：http 源已停用）".to_string());
        }
        // 下载地址的 host 必须与用户配置的更新源同域（或为其子域）。
        // 被注入的 webview 无法再把任意 URL 喂给 download_update + install_update
        // 完成静默 RCE —— 只能从用户已信任的更新域取包。
        // fail-closed：更新源未配置（或读取失败）时直接拒绝，而不是跳过校验。
        // 正常 UI 流程里 manifest 只能来自「已配置 endpoint 的检查结果」，
        // 走到这里却没有配置，说明调用并非来自受信流程。
        let allowed =
            configured_update_host(&app).ok_or_else(|| "未配置更新源，拒绝下载".to_string())?;
        // 每一跳重定向都重新执行"内网拒绝 + 同域校验"，
        // 防止受信更新源上的开放重定向把下载（及 .sha256 清单）引到任意主机。
        let guard = |u: &str| -> Result<(), String> {
            reject_private_target(u)?;
            let h = host_of(u).ok_or_else(|| "下载地址无效".to_string())?;
            if !host_allowed(&h, &allowed)
                && !(allowed == "github.com" && is_github_official_host(&h))
            {
                return Err(format!(
                    "下载地址域名 {h} 不在更新源域 {allowed} 允许范围内"
                ));
            }
            Ok(())
        };
        // 签名证据后端绑定 + 版本下限。此前
        // expected_sha256 由前端单独回传、Rust 侧照单全收——Ed25519 验签
        // (verify_update_manifest) 只是前端独立调用的旁路命令，下载/安装
        // 并不要求签名证据，被注入的受信 webview 可传任意历史旧版安装包的
        // 真实 sha256 实现静默降级，或安装同域任意 .exe。现在带期望哈希的
        // 下载必须命中「本进程内验签通过时登记的资产清单」(url, sha256)
        // 精确匹配（见 update_sig.rs；取走即消费防重放），且清单版本必须
        // 严格高于当前版本（env!("CARGO_PKG_VERSION")，与 get_update_info
        // 同源）——历史旧版清单的真实签名重放与同域任意包都被此拒绝。
        // 消费发生在下载发起前：若本次下载失败（网络中断等），证据已随
        // 匹配消费掉，重试前需重新检查更新（重新验签登记），重放面不扩大。
        // 显式 allow_unsigned_sidecar 的「最后兼容路径」无清单版本可言，
        // 维持 原口径（入口显式 opt-in 才可达）。
        if let Some(h) = expected_sha256.as_deref().map(str::trim) {
            if !h.is_empty() {
                let verified_version = crate::update_sig::take_verified_manifest(&url, h)
                    .ok_or_else(|| {
                        "缺少有效的签名清单证据（未验证、已过期或已被使用），请重新检查更新后再下载"
                            .to_string()
                    })?;
                let current = env!("CARGO_PKG_VERSION");
                if !crate::update_sig::version_gt(&verified_version, current) {
                    return Err(format!(
                        "拒绝降级安装：清单版本 {verified_version} 不高于当前版本 {current}"
                    ));
                }
            }
        }
        let resp = send_guarded(&url, std::time::Duration::from_secs(600), &guard)?;
        if !resp.status().is_success() {
            return Err(format!("下载失败：HTTP {}", resp.status()));
        }

        // 从响应头或 URL 推断文件名，默认升级安装包。
        let raw_name = resp
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| {
                s.split(';')
                    .find_map(|p| p.trim().strip_prefix("filename="))
                    .map(|f| f.trim_matches('"').to_string())
            })
            .unwrap_or_else(|| {
                url.rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Vela-update.exe")
                    .to_string()
            });
        // 服务器返回的 filename 不可信：`..\evil.exe`、绝对路径或带分隔符的
        // 名字都会把文件写到临时目录之外（路径穿越 → 任意位置写入，随后还
        // 会被 install_update 执行）。只保留纯文件名，其余一律回退默认名。
        let filename = std::path::Path::new(&raw_name)
            .file_name()
            .and_then(|f| f.to_str())
            .map(str::trim)
            .filter(|f| !f.is_empty() && *f != "." && *f != "..")
            .unwrap_or("Vela-update.exe")
            .to_string();

        let dir = update_stage_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败：{e}"))?;
        // 临时目录只保留最新一份安装包，下载前清理旧文件，避免多次更新
        // 后数百 MB 的旧安装包无限累积（上次下载的安装包此刻已安装或已失效）。
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        let dest = dir.join(&filename);
        // 双保险：filename 必须是单个普通路径组件（无盘符/根/`..`/分隔符），
        // 这样 join 后一定仍在目标目录内。此前用 canonicalize 后 starts_with
        // 比较：Windows 上已存在的 dir 规范化为 `\\?\C:\...` verbatim 形式，
        // 而刚清空目录后 dest 尚不存在、回退为普通形式，两者的 Prefix 组件
        // 不相等 → starts_with 恒 false → 每次下载都被判"非法文件名"。
        let single_component = {
            use std::path::Component;
            let mut comps = std::path::Path::new(&filename).components();
            matches!(
                (comps.next(), comps.next()),
                (Some(Component::Normal(_)), None)
            )
        };
        if !single_component || dest.parent() != Some(dir.as_path()) {
            return Err("非法的下载文件名".to_string());
        }

        let total = resp.content_length().unwrap_or(0);
        let mut written: u64 = 0;
        let mut out = std::fs::File::create(&dest).map_err(|e| format!("创建文件失败：{e}"))?;
        // + ：SHA-256 改为边下载边流式计算，替代此前
        // "整包读入内存再哈希"（数百 MB 安装包会瞬时占满 RAM 两份）。
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        {
            use std::io::{Read, Write};
            let mut reader = resp;
            let mut buf = [0u8; 64 * 1024];
            // 进度事件节流：64KB 一发 → 200MB 安装包要发 3000+ 次广播事件，
            // 每次都序列化并推给所有 webview，形成事件洪峰。改为整 MB 或
            // 百分比变化才上报，事件量降到百级以内，进度条仍平滑。
            let mut last_emit_mb: u64 = u64::MAX;
            let mut last_emit_percent: u64 = u64::MAX;
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| format!("读取响应失败：{e}"))?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])
                    .map_err(|e| format!("写入失败：{e}"))?;
                hasher.update(&buf[..n]);
                written += n as u64;
                let mb = written / (1024 * 1024);
                let percent = (written * 100).checked_div(total).unwrap_or(0);
                if mb != last_emit_mb || percent != last_emit_percent {
                    last_emit_mb = mb;
                    last_emit_percent = percent;
                    // 仅设置窗口（UpdatePage）消费，定向投递避免广播到所有 widget 窗口。
                    let _ = app.emit_to("settings", "update:progress", (written, total));
                }
            }
        }
        let _ = app.emit_to(
            "settings",
            "update:progress-done",
            dest.to_string_lossy().to_string(),
        );

        // + + + ：下载完成后立刻比对 SHA-256。期望哈希优先取
        // 前端传入的 expected_sha256——后它不再仅凭回传即被信任：能走到
        // 这里必然已命中后端验签登记的资产清单（上方 绑定检查），即哈希
        // 出处是「已通过 Ed25519 签名验证的 manifest」（update_sig.rs，锚定到
        // 离线公钥，源被攻破也无法伪造）。无期望哈希时走「最后兼容路径」：
        // 更新源同目录 `<url>.sha256` sidecar（与安装包同源，仅防损坏不防
        // 投毒）——入口已在上方 门控收口：只有调用方显式传
        // allow_unsigned_sidecar=true 才能到达这里，缺省早已拒绝。比对失败
        // 删除安装包并报错。
        let expected = match expected_sha256.as_deref().map(str::trim) {
            Some(h) if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) => {
                h.to_ascii_lowercase()
            }
            Some(_) => return Err("清单携带的 SHA-256 格式无效".to_string()),
            None => fetch_expected_sha256(&url, &guard)?,
        };
        let actual = digest_hex(&hasher.finalize());
        if !expected.eq_ignore_ascii_case(&actual) {
            let _ = std::fs::remove_file(&dest);
            return Err(format!("SHA-256 校验失败：期望 {expected}，实际 {actual}"));
        }
        // 已校验摘要落盘为 sidecar 文件，install_update 执行前据此二次复核，
        // 防御"下载完成 → 安装执行"之间安装包被替换的时间窗。
        // 原子写（tmp → sync → rename）——直接写目标在
        // 进程中途被杀时会留下截断清单，二次复核读到半截哈希误判失败。
        crate::storage_util::write_text_atomic(
            std::path::Path::new(&format!("{}.sha256", dest.display())),
            &actual,
        )
        .map_err(|e| format!("写入校验清单失败：{e}"))?;

        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("下载任务失败：{e}"))?
}

/// 请求更新源同目录的 `<url>.sha256` 校验清单，返回其中第一个 64 位
/// 十六进制 token（兼容纯哈希与 GNU sha256sum 的 `<hash>  <name>` 两种格式）。
/// 清单请求同样走逐跳守卫——若"包"和"哈希清单"都能被
/// 重定向到攻击者主机，SHA-256 校验就形同虚设。
/// 本函数是「最后兼容路径」——仅 download_update 显式收到
/// allow_unsigned_sidecar=true 时才会被调用；缺省（无签名清单）在入口即被
/// 拒绝，不再作为常规兜底。
fn fetch_expected_sha256(
    url: &str,
    guard: &dyn Fn(&str) -> Result<(), String>,
) -> Result<String, String> {
    let resp = send_guarded(
        &format!("{url}.sha256"),
        std::time::Duration::from_secs(60),
        guard,
    )?;
    if !resp.status().is_success() {
        return Err(format!("更新源未提供校验清单（HTTP {}）", resp.status()));
    }
    let body = resp.text().map_err(|e| format!("读取校验清单失败：{e}"))?;
    let token = body.split_whitespace().next().unwrap_or("");
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("校验清单格式无效".to_string());
    }
    Ok(token.to_ascii_lowercase())
}

/// 静默运行已下载的 NSIS 安装器（/S），随后退出应用。
///
/// 安装器可能运行数分钟；`wait()` 必须 spawn_blocking，否则同步命令会在
/// 主线程上等到安装结束。CREATE_NO_WINDOW 隐藏安装窗口闪烁，完成后请求
/// 退出整个应用，新版本随即启动。
#[tauri::command]
pub async fn install_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    // 与 download_update 同理，静默执行安装器的命令必须挂
    // 窗口闸门（收口的漏网之鱼）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            // path 完全来自 webview 参数：页面一旦被注入即可让本进程以 /S
            // 静默执行任意可执行文件。只接受位于下载暂存目录内、扩展名为
            // .exe 的文件。
            let dir = update_stage_dir();
            let canonical_dir = dir
                .canonicalize()
                .map_err(|_| "更新目录不存在".to_string())?;
            let canonical_path = std::path::Path::new(&path)
                .canonicalize()
                .map_err(|_| "安装包不存在".to_string())?;
            if !canonical_path.starts_with(&canonical_dir) {
                return Err("拒绝执行更新目录之外的文件".to_string());
            }
            if !canonical_path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
            {
                return Err("仅支持 .exe 安装包".to_string());
            }
            // 执行前用下载时落盘的 sidecar 摘要二次复核。路径门控已保证
            // 文件在本目录内，但"下载完成 → 安装执行"之间存在替换时间窗，
            // 这里按下载阶段校验过的 SHA-256 再做一次完整性与来源复核。
            // 改为流式读取哈希，不再把数百 MB 安装包整读进内存。
            let expected = std::fs::read_to_string(format!("{}.sha256", canonical_path.display()))
                .map_err(|_| "缺少校验清单，拒绝安装".to_string())?;
            let expected = expected.trim().to_ascii_lowercase();
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            let mut file =
                std::fs::File::open(&canonical_path).map_err(|e| format!("读取安装包失败：{e}"))?;
            {
                use std::io::Read;
                let mut buf = [0u8; 256 * 1024];
                loop {
                    let n = file
                        .read(&mut buf)
                        .map_err(|e| format!("读取安装包失败：{e}"))?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                }
            }
            let actual = digest_hex(&hasher.finalize());
            if expected != actual {
                return Err(format!(
                    "安装包完整性校验失败：期望 {expected}，实际 {actual}"
                ));
            }
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            // 安装器要覆盖的正是本进程的映像：不能在这里 wait() 等它完成——
            // NSIS 静默模式发现 Vela 仍在运行会直接杀进程，RunEvent::Exit 的
            // 清理（任务栏还原、落盘）全部跳过。正确顺序是启动成功后立即
            // 走正常退出流程把控制权交给安装器。
            std::process::Command::new(&canonical_path)
                .arg("/S")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("启动安装器失败：{e}"))?;
            // 安装器已接管，允许退出并请求关闭整个应用。
            crate::ALLOW_EXIT.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Err("自动安装仅支持 Windows 安装包".to_string())
        }
    })
    .await
    .map_err(|e| format!("安装任务失败：{e}"))?
}

/// [WEB-PREVIEW] 内网拒绝校验的公开包装（windows.rs 网页浮层复用同一门槛）。
pub(crate) fn reject_private_target_pub(url: &str) -> Result<(), String> {
    reject_private_target(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_value_matches_exe_tolerates_quotes_case_and_slashes() {
        let cur = std::path::Path::new(r"C:\Program Files\Vela\vela.exe");
        // set_autostart 的写入形态（成对引号）。
        assert!(run_value_matches_exe(
            r#""C:\Program Files\Vela\vela.exe""#,
            cur
        ));
        // 大小写与正反斜杠差异不算指向别的文件。
        assert!(run_value_matches_exe(
            r"c:\program files\vela\VELA.EXE",
            cur
        ));
        assert!(run_value_matches_exe(
            r"C:/Program Files/Vela/vela.exe",
            cur
        ));
        // 指向别的路径（应用搬目录后的陈旧项）必须判失配。
        assert!(!run_value_matches_exe(r#""D:\Old\Vela\vela.exe""#, cur));
        assert!(!run_value_matches_exe(
            r"C:\Program Files\Vela\other.exe",
            cur
        ));
    }

    #[test]
    fn lyric_proxy_allowlists_only_lyric_engine_hosts() {
        // 白名单：QQ（搜索 / 歌词）与网易云（搜索 / 歌词）的四个接口域。
        for ok in [
            "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=x",
            "https://y.qq.com/",
            "https://music.163.com/api/search/get/web",
            "https://music.163.com/api/song/lyric?id=1",
        ] {
            assert!(is_lyric_host(ok), "应放行：{ok}");
        }
        // 其余域名（含子域伪装、http 明文、内网、畸形）一律拒绝——代理不是开放面。
        for bad in [
            "https://evil.example.com/",
            "https://c.y.qq.com.evil.example.com/",
            "http://music.163.com/",
            "https://127.0.0.1/api",
            "not a url",
        ] {
            assert!(!is_lyric_host(bad), "应拒绝：{bad}");
        }
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // sha256("abc") == ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn host_of_parses_host_and_lowercases() {
        assert_eq!(
            host_of("https://Vela.Example.com/a/b.exe"),
            Some("vela.example.com".into())
        );
        // 端口应被 host_str 剥离。
        assert_eq!(
            host_of("https://example.com:8443/x"),
            Some("example.com".into())
        );
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn host_allowed_accepts_self_and_subdomains_only() {
        assert!(host_allowed("vela.example.com", "vela.example.com"));
        assert!(host_allowed("cdn.vela.example.com", "vela.example.com"));
        assert!(host_allowed("a.b.vela.example.com", "vela.example.com"));
        assert!(!host_allowed("evil-vela.example.com", "vela.example.com"));
        assert!(!host_allowed("example.com.attacker.com", "example.com"));
        assert!(!host_allowed("example.com", "evil.com"));
    }

    // GitHub 官方 CDN 只在更新源为 github.com 时放行，
    // 且清单里只有这三个域——伪装子域与其它 CDN 不在名单内。
    #[test]
    fn github_official_host_list_is_closed() {
        assert!(is_github_official_host("github.com"));
        assert!(is_github_official_host("objects.githubusercontent.com"));
        assert!(is_github_official_host(
            "release-assets.githubusercontent.com"
        ));
        assert!(!is_github_official_host("evil.github.com.attacker.com"));
        assert!(!is_github_official_host(
            "objects.githubusercontent.com.evil.io"
        ));
        assert!(!is_github_official_host("codeload.github.com"));
    }

    #[test]
    fn extract_release_tag_parses_location_forms() {
        // 绝对地址（GitHub 实际返回形态）。
        assert_eq!(
            extract_release_tag("https://github.com/user/vela/releases/tag/v0.2.0"),
            Some("v0.2.0".into())
        );
        // 相对地址。
        assert_eq!(
            extract_release_tag("/user/vela/releases/tag/1.2.3"),
            Some("1.2.3".into())
        );
        // tag 后带查询串 / 锚点 / 多余路径段。
        assert_eq!(
            extract_release_tag("https://github.com/u/r/releases/tag/v1.0.0?foo=1"),
            Some("v1.0.0".into())
        );
        assert_eq!(
            extract_release_tag("https://github.com/u/r/releases/tag/v1.0.0#anchor"),
            Some("v1.0.0".into())
        );
        // 无 tag 段 / 空 tag → None。
        assert_eq!(extract_release_tag("https://github.com/u/r/releases"), None);
        assert_eq!(
            extract_release_tag("https://github.com/u/r/releases/tag/"),
            None
        );
        assert_eq!(extract_release_tag("https://example.com/other"), None);
    }

    // 手写字符串解析识别不了的数字 IP 字面量必须被拒绝。
    #[test]
    fn reject_private_target_blocks_numeric_ip_forms() {
        // 十进制整数形式（此前可绕过）。
        assert!(reject_private_target("http://2130706433/x").is_err()); // 127.0.0.1
        assert!(reject_private_target("http://0x7f000001/").is_err());
        assert!(reject_private_target("http://0177.0.0.1/").is_err());
        // 省略写法。
        assert!(reject_private_target("http://127.1/").is_err());
        // 常规内网形态保持拦截。
        assert!(reject_private_target("http://127.0.0.1:8080/").is_err());
        assert!(reject_private_target("http://10.0.0.1/").is_err());
        assert!(reject_private_target("http://192.168.1.1/").is_err());
        assert!(reject_private_target("http://169.254.1.1/").is_err());
        assert!(reject_private_target("http://localhost/").is_err());
        assert!(reject_private_target("ftp://example.com/").is_err());
        assert!(reject_private_target("not a url").is_err());
        // 公网地址不受影响。
        assert!(reject_private_target("https://api.open-meteo.com/v1/x").is_ok());
        assert!(reject_private_target("http://8.8.8.8/").is_ok());
    }

    // 回归：`host_str()` 对 IPv6 带方括号，旧实现的 IPv6 分支从未执行过。
    #[test]
    fn reject_private_target_blocks_ipv6_forms() {
        assert!(reject_private_target("http://[::1]/").is_err());
        assert!(reject_private_target("http://[::]/").is_err());
        // IPv4-mapped / IPv4-compatible 内嵌形式。
        assert!(reject_private_target("http://[::ffff:127.0.0.1]/").is_err());
        assert!(reject_private_target("http://[::ffff:10.0.0.5]:8080/").is_err());
        assert!(reject_private_target("http://[::ffff:7f00:1]/").is_err());
        assert!(reject_private_target("http://[::127.0.0.1]/").is_err());
        // 链路本地 / ULA / 组播。
        assert!(reject_private_target("http://[fe80::1]/").is_err());
        assert!(reject_private_target("http://[fd00::1]/").is_err());
        assert!(reject_private_target("http://[fc00::1]/").is_err());
        assert!(reject_private_target("http://[ff02::1]/").is_err());
        // 带 zone id 的写法解析失败即拒绝（fail closed）。
        assert!(reject_private_target("http://[fe80::1%2512]/").is_err());
        // 公网 IPv6 不受影响。
        assert!(reject_private_target("http://[2001:4860:4860::8888]/").is_ok());
        assert!(reject_private_target("https://[2606:4700:4700::1111]/dns-query").is_ok());
    }

    #[test]
    fn parse_ipv4_lenient_matches_inet_aton() {
        assert_eq!(
            parse_ipv4_lenient("2130706433"),
            Some(std::net::Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            parse_ipv4_lenient("127.1"),
            Some(std::net::Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            parse_ipv4_lenient("0x7f.0x0.0x0.0x1"),
            Some(std::net::Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            parse_ipv4_lenient("192.168.1.10"),
            Some(std::net::Ipv4Addr::new(192, 168, 1, 10))
        );
        // 非 v4 字面量（域名 / 越界段）返回 None。
        assert_eq!(parse_ipv4_lenient("example.com"), None);
        assert_eq!(parse_ipv4_lenient("256.1.1.1"), None);
        assert_eq!(parse_ipv4_lenient("1.2.3.4.5"), None);
        assert_eq!(parse_ipv4_lenient(""), None);
    }
}
