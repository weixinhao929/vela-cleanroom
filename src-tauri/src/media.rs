//! System media transport controls (SMTC) integration. Reads the currently
//! playing track from Windows' global media session (any app that reports to
//! SMTC: Spotify, browsers, media players, ...) and exposes it to the frontend
//! via Tauri commands, along with transport controls (play / pause / next /
//! previous / seek). Falls back to `None` when no media is active.
//!
//! SMTC is a WinRT API; every call must run on a COM-initialized thread, so we
//! wrap each operation in a small helper that co-inits / co-uninits.
//!
//! §4.8 事件化：除保留的拉式命令（`get_system_media_info`）外，常驻
//! [`start_media_event_watcher`] 线程订阅 WinRT
//! MediaPropertiesChanged/TimelinePropertiesChanged/PlaybackInfoChanged/
//! SessionsChanged 事件，仅在**有变化**时 emit `media:snapshot`（含漂移
//! 校准：播放中每 ~5s 比对实际位置与预期推进，偏差 >1s 才发）。位置读取
//! 含 **LastUpdatedTime 插值**（Position 是采样值，播放中真实位置 =
//! Position + now − LastUpdatedTime，同类媒体浮窗同款口径），快照天然
//! 无累计漂移；不写时间戳的播放器（网易云——采样值播放期间是陈旧静态值）
//! 走**单调位置地板**：校准绝不回拽位置，回退只放行 timeline 事件拍
//! （seek/单曲循环）。拉式命令对这类播放器按**位置台账**（看门线程最近
//! 一拍的真实位置锚点）外推，冷挂载首拉不从开播时刻重新计时。封面只在
//! 媒体属性变化（换曲/换封面）的那一拍随载荷下发一次，
//! 其余事件载荷的 thumb 字段为 null（前端沿用）。拉式命令每秒全量（含
//! base64 封面）过 IPC 的旧路径由此退役——前端本地推进进度、按事件校准。
//!
//! 快照还携带 `controls`（传输能力位 + 循环/随机状态）：前端据此置灰会话
//! 不支持的按钮并渲染 shuffle/repeat（对齐同类媒体浮窗）；多会话并存时
//! 自动模式按「前台应用 → 正在播放」选会话。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize)]
pub struct SystemMediaInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    /// Base64 data URL of the album artwork, if the session exposes one.
    pub thumb: Option<String>,
    /// §4.3 封面取色三色板（无封面时为回退色板；拉式命令恒全量）。
    pub palette: Option<MediaPalette>,
    /// 传输控件能力位 + 循环/随机状态（W-130，对齐同类媒体浮窗）。
    pub controls: MediaControls,
    /// 当前会话 AUMID（W-131：前端唤起播放器/调应用音量需要；空串 = 未知）。
    pub aumid: String,
}

/// `media:snapshot` 事件载荷。字段语义与 [`SystemMediaInfo`] 相同，差别在
/// 封面：`thumb_changed = true` 表示本次事件的 `thumb` 是新封面值（`null` =
/// 清除）；`false` 表示未变，前端沿用。封面只在媒体属性变化（换曲/换封面）
/// 的那一拍随载荷下发一次。
///
/// 位置校准口径：`position` 是 Rust 读取时刻的真实位置（含 LastUpdatedTime
/// 插值，见 [`playback_snapshot`]），播放中的两次事件之间由前端按真实流逝
/// 时间推进；本线程播放中每 ~5s 复核一次，偏差 ≤1s 不发。
#[derive(Clone, Debug, Serialize)]
pub struct MediaSnapshot {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    #[serde(rename = "thumbChanged")]
    pub thumb_changed: bool,
    pub thumb: Option<String>,
    /// §4.3 三色板：`Some` = 本次事件是新的取色结果（前端替换）；`None` = 沿用。
    /// 与 thumb_changed 同拍（仅媒体属性/封面变化时重算并比较，值相同不发）。
    pub palette: Option<MediaPalette>,
    /// 传输控件能力位 + 循环/随机状态（PlaybackInfoChanged 那拍变化）。
    pub controls: MediaControls,
    /// 当前会话 AUMID（W-131：前端唤起播放器/调应用音量需要；空串 = 未知）。
    pub aumid: String,
}

/// 传输控件能力位与循环/随机状态（W-130，对齐同类媒体浮窗的 Controls
/// 用法）：前端据此把会话不支持的按钮置灰（浏览器视频页常无上一曲/定位），
/// 并渲染 shuffle/repeat 的当前态。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MediaControls {
    pub play: bool,
    pub pause: bool,
    pub next: bool,
    pub previous: bool,
    /// IsPlaybackPositionEnabled：seek（进度条拖动/歌词行点击）可用。
    pub seek: bool,
    /// IsShuffleEnabled / IsRepeatEnabled：对应按钮是否展示。
    pub shuffle: bool,
    pub repeat: bool,
    #[serde(rename = "shuffleActive")]
    pub shuffle_active: bool,
    /// "off" | "all" | "one"（MediaPlaybackAutoRepeatMode 映射）。
    #[serde(rename = "repeatMode")]
    pub repeat_mode: String,
}

/* ------------------------------------------------------------------ */
/* §4.3 封面取色三色板：palette.rs 公共量化管线 + 媒体端明暗映射      */
/* ------------------------------------------------------------------ */

/// 媒体封面派生的三色板（`#rrggbb`）：primary 卡片主色、on_primary 主色上的
/// 前景（WCAG 对比）、track 进度条轨道低饱和深色。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MediaPalette {
    pub primary: String,
    #[serde(rename = "onPrimary")]
    pub on_primary: String,
    pub track: String,
}

/// Oklch → sRGB（媒体端映射专用；palette.rs 的同名函数目前 cfg(test)，
/// 该文件属并行会话在写，此处私有实现避免互踩，后续可去重合并）。
fn oklch_to_rgb8(l: f64, c: f64, h_deg: f64) -> (u8, u8, u8) {
    let hue = h_deg.to_radians();
    let lab_a = c * hue.cos();
    let lab_b = c * hue.sin();
    let l_ = l + 0.3963377774 * lab_a + 0.2158037573 * lab_b;
    let m_ = l - 0.1055613458 * lab_a - 0.0638541728 * lab_b;
    let s_ = l - 0.0894841775 * lab_a - 1.2914855480 * lab_b;
    let lin = |v: f64| v * v * v;
    let (lr, lg, lb) = (lin(l_), lin(m_), lin(s_));
    let to_srgb = |v: f64| {
        let v = v.clamp(0.0, 1.0);
        let s = if v <= 0.003_130_8 {
            v * 12.92
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        };
        (s * 255.0).round().clamp(0.0, 255.0) as u8
    };
    (
        to_srgb(4.0767416621 * lr - 3.3077115913 * lg + 0.2309699292 * lb),
        to_srgb(-1.2684380046 * lr + 2.6097574011 * lg - 0.3413193965 * lb),
        to_srgb(-0.0041960863 * lr - 0.7034186147 * lg + 1.7076147010 * lb),
    )
}

fn hex8(rgb: (u8, u8, u8)) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb.0, rgb.1, rgb.2)
}

fn relative_luminance(rgb: (u8, u8, u8)) -> f64 {
    let lin = |c: u8| {
        let v = c as f64 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(rgb.0) + 0.7152 * lin(rgb.1) + 0.0722 * lin(rgb.2)
}

/// 主色上按 WCAG 对比选近黑/白前景。
fn readable_foreground(bg: (u8, u8, u8)) -> String {
    let dark = (0x10u8, 0x14, 0x18);
    let light = (0xffu8, 0xff, 0xff);
    let contrast = |a: (u8, u8, u8)| {
        let (l1, l2) = (relative_luminance(a), relative_luminance(bg));
        let (hi, lo) = if l1 > l2 { (l1, l2) } else { (l2, l1) };
        (hi + 0.05) / (lo + 0.05)
    };
    hex8(if contrast(dark) >= contrast(light) {
        dark
    } else {
        light
    })
}

/// 媒体端映射：候选色 Oklch → primary（L 钳 0.62–0.78、彩度×1.12 钳
/// [0.07, 0.22]）/ track（L 钳 [0.30, 0.42]、彩度×0.42 钳 [0.025, 0.08]）。
fn palette_from_candidate(l: f64, c: f64, h: f64) -> MediaPalette {
    let primary = oklch_to_rgb8(l.clamp(0.62, 0.78), (c * 1.12).clamp(0.070, 0.220), h);
    MediaPalette {
        primary: hex8(primary),
        on_primary: readable_foreground(primary),
        track: hex8(oklch_to_rgb8(
            (l * 0.58).clamp(0.30, 0.42),
            (c * 0.42).clamp(0.025, 0.080),
            h,
        )),
    }
}

/// 回退色板：`#88d0ec` 派生，彩度抬到 ≥0.10 保证有色感。
fn fallback_media_palette() -> MediaPalette {
    let lab = crate::palette::rgb_to_oklab(crate::palette::Rgb8 {
        r: 0x88,
        g: 0xd0,
        b: 0xec,
    });
    let c = lab.chroma().max(0.10);
    palette_from_candidate(lab.l, c, lab.hue_deg())
}

/// 单条目取色缓存（同参数去抖）：key = 曲目元数据 + 封面字节的内容哈希。
/// 事件线程只在属性变化拍调用，拉式命令每秒轮询也复用同一条目——同一封面
/// 不重复解码/量化。
fn palette_cache(key: u64, compute: impl FnOnce() -> MediaPalette) -> MediaPalette {
    static CACHE: std::sync::OnceLock<Mutex<Option<(u64, MediaPalette)>>> =
        std::sync::OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((k, p)) = guard.as_ref() {
        if *k == key {
            return p.clone();
        }
    }
    let p = compute();
    *guard = Some((key, p.clone()));
    p
}

fn palette_key(title: &str, artist: &str, album: &str, thumb: Option<&[u8]>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (title, artist, album).hash(&mut h);
    thumb.map(|b| b.len()).unwrap_or(0).hash(&mut h);
    if let Some(b) = thumb {
        b.hash(&mut h);
    }
    h.finish()
}

/// §4.3 封面取色入口：解码封面 → palette.rs 公共量化/打分管线 → 媒体端
/// 三色映射；解码失败或全灰封面回退 `#88d0ec` 色板。结果按参数缓存。
pub fn media_palette_for(
    title: &str,
    artist: &str,
    album: &str,
    thumb: Option<&[u8]>,
) -> MediaPalette {
    // 与 palette.rs 的 MIN_CHROMA 同值（该常量私有；此处按语义引用，不跨文件耦合）。
    const NEAR_GRAY_CHROMA: f64 = 0.028;
    let key = palette_key(title, artist, album, thumb);
    palette_cache(key, || {
        match thumb.and_then(|b| image::load_from_memory(b).ok()) {
            Some(img) => {
                let extracted = crate::palette::extract_palette(&img);
                let lab = crate::palette::rgb_to_oklab(extracted.primary);
                let chroma = lab.chroma();
                // 无有效候选（primary=全图均值）时 extract_palette 的 primary 是
                // 近灰均值 → 走回退色板，语义一致。
                if chroma < NEAR_GRAY_CHROMA {
                    fallback_media_palette()
                } else {
                    palette_from_candidate(lab.l, chroma, lab.hue_deg())
                }
            }
            None => fallback_media_palette(),
        }
    })
}

/// Runs a closure on a fresh COM-initialized thread scope and returns the
/// result. `None` is returned when COM init fails or the closure returns None.
#[cfg(windows)]
fn with_com<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    // SAFETY: CoInitializeEx on a fresh thread scope.
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    // P2（审计修复）：RPC_E_CHANGED_MODE 不算失败——阻塞池线程会被复用，
    // 此前可能已被其它任务初始化为 MTA。此前按致命错误处理会让媒体轮询
    // "间歇性永久空闲"。与 audio.rs::toggle_system_mute_blocking 一致：
    // S_OK/S_FALSE 都配对 CoUninitialize，仅 CHANGED_MODE 免配对且继续执行。
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        return None;
    }
    // Both S_OK (apartment created) and S_FALSE (apartment already existed)
    // increment this thread's COM refcount and MUST be balanced with a
    // CoUninitialize — skipping it on S_FALSE leaks a COM reference every call
    // on a reused async-runtime worker thread.
    struct ComScope(bool);
    impl Drop for ComScope {
        fn drop(&mut self) {
            // SAFETY: paired with the successful CoInitializeEx above.
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let _com = ComScope(hr.is_ok());
    f()
}

#[cfg(windows)]
fn active_session() -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()?
        .get()
        .ok()?;
    pick_session(&manager)
}

/// 在既有 manager 上解析当前应关注的会话（拉式命令与事件线程共用）：
/// 用户锁定（W-123）优先；自动模式按「前台且正在播放 → 正在播放 → 前台 →
/// 第一个」取（前台优先，同类媒体浮窗同思路，多会话并存时
/// 跟随用户正在交互的应用）。
#[cfg(windows)]
fn pick_session(
    manager: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager,
) -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
    let sessions = manager.GetSessions().ok()?;
    let count = sessions.Size().ok()?;
    if count == 0 {
        return None;
    }

    // 一次性收齐 (session, aumid, playing)：后续各档偏好只做筛选，不再
    // 反复跨 WinRT 取状态。单个异常会话跳过，不拖垮整体。
    let mut entries: Vec<(
        windows::Media::Control::GlobalSystemMediaTransportControlsSession,
        String,
        bool,
    )> = Vec::with_capacity(count as usize);
    for i in 0..count {
        let Ok(session) = sessions.GetAt(i) else {
            continue;
        };
        let aumid = session
            .SourceAppUserModelId()
            .map(|s| s.to_string())
            .unwrap_or_default();
        // W-131 黑名单：被隐藏的应用不参与会话选择（含已失效的锁定项）。
        if is_blocked(&aumid) {
            continue;
        }
        let playing = session
            .GetPlaybackInfo()
            .ok()
            .and_then(|info| info.PlaybackStatus().ok())
            .map(|s| {
                s == windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
            })
            .unwrap_or(false);
        entries.push((session, aumid, playing));
    }
    if entries.is_empty() {
        return None;
    }

    // W-123 会话选择：用户锁定某个应用（Spotify/浏览器/播放器）时只取该会话。
    if let Some(selected) = selected_session_id() {
        if let Some((session, _, _)) = entries
            .iter()
            .find(|(_, aumid, _)| aumid.as_str() == selected.as_str())
        {
            return Some(session.clone());
        }
        // 选中的会话已退出（应用关闭）→ 回落自动模式。
    }

    // 前台进程 exe 名与 AUMID 分段比对（小写）。
    let fg = foreground_process_hint();
    let matches_fg = |aumid: &str| {
        fg.as_deref().is_some_and(|exe| {
            let variants = aumid_variants(aumid);
            variants.iter().any(|v| v == exe)
        })
    };

    // 自动模式四档偏好。
    entries
        .iter()
        .find(|(_, aumid, playing)| *playing && matches_fg(aumid))
        .or_else(|| entries.iter().find(|(_, _, playing)| *playing))
        .or_else(|| entries.iter().find(|(_, aumid, _)| matches_fg(aumid)))
        .or_else(|| entries.first())
        .map(|(session, _, _)| session.clone())
}

/// W-123 当前锁定的媒体会话 id（SourceAppUserModelId）；None = 自动。
static SELECTED_SESSION: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

fn selected_session_id() -> Option<String> {
    SELECTED_SESSION.read().ok().and_then(|g| g.clone())
}

/// W-131 媒体监控行为偏好（前端 settings.general.media 单向推送，重启回默认，
/// 持久化在前端设置层）：
///  - `pause_others`：独占播放——某会话开始播放时，自动暂停其余在播会话
///    （同类媒体浮窗的同名开关）；
///  - `blocked_sessions`：会话黑名单（AUMID 精确匹配）——被隐藏的应用不参与
///    会话选择也不出现在选择器里（同类媒体浮窗的应用过滤，仅黑名单档）。
static PAUSE_OTHERS: AtomicBool = AtomicBool::new(false);
static BLOCKED_SESSIONS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn pause_others_enabled() -> bool {
    PAUSE_OTHERS.load(Ordering::Relaxed)
}

fn blocked_sessions() -> Vec<String> {
    BLOCKED_SESSIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

fn is_blocked(aumid: &str) -> bool {
    BLOCKED_SESSIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .any(|b| b == aumid)
}

/// W-131 一个可选媒体会话（应用）的描述。
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct MediaSessionInfo {
    /// SourceAppUserModelId，选择时回传。
    pub id: String,
    /// 应用名：取 AUMID 最后一段（`SpotifyAB.Spotify…!Spotify` → `Spotify`）。
    pub name: String,
    pub playing: bool,
    /// W-131 已被列入黑名单（选择器里进「已隐藏」区，点击恢复）。
    pub blocked: bool,
}

/// W-131 媒体监控行为偏好快照（前端回显）。
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct MediaBehavior {
    #[serde(rename = "pauseOthers")]
    pub pause_others: bool,
    #[serde(rename = "blockedSessions")]
    pub blocked_sessions: Vec<String>,
}

/// Converts a WinRT `TimeSpan` (100ns units) to seconds.
#[cfg(windows)]
fn timespan_secs(ts: windows::Foundation::TimeSpan) -> f64 {
    ts.Duration as f64 / 10_000_000.0
}

/// 播放位置插值（秒）：SMTC `Position` 是「LastUpdatedTime 时刻」的采样值，
/// 播放中真实位置 = 采样值 + (now − LastUpdatedTime)。部分播放器（网易云
/// 音乐等）从不写 LastUpdatedTime（保持 0），裸相减会把整个 FILETIME（1601
/// 年起，~1.3e10 s）当成偏移加进来，进度显示成 "223914975:34" 这种天量。
/// 因此只在时间戳可信时插值：LastUpdatedTime > 0，且偏移落在 [0, 1 天]
/// （真实偏移不会超过一首歌/一路直播的长度），否则退回采样值本身。
fn interpolated_position_secs(raw_secs: f64, updated_100ns: i64, now_100ns: i64) -> f64 {
    if timestamp_plausible(updated_100ns, now_100ns) {
        raw_secs + (now_100ns - updated_100ns) as f64 / 10_000_000.0
    } else {
        raw_secs
    }
}

/// LastUpdatedTime 是否可信（>0 且偏移在 [0, 1 天]）——与
/// [`interpolated_position_secs`] 的插值前提同一口径。调用方据此区分
/// 「位置精确已知」与「只有陈旧采样可用」（后者见事件线程的单调地板）。
fn timestamp_plausible(updated_100ns: i64, now_100ns: i64) -> bool {
    const MAX_DELTA_100NS: i64 = 86_400 * 10_000_000;
    updated_100ns > 0 && (0..=MAX_DELTA_100NS).contains(&(now_100ns - updated_100ns))
}

/// 单调位置地板：同曲目连续播放中，采样值陈旧（播放器不随播放更新
/// Position，如网易云）时取「锚点 + 预期推进」；采样值自证新鲜（≥ 预期，
/// 播放器自更或时钟略快）时原样采信。绝不因校准把位置往回拽——回退只
/// 允许发生在 timeline 事件拍（seek/单曲循环回零，事件循环里显式放行）。
fn floored_position(prev_position: f64, playing_elapsed: f64, sampled: f64) -> f64 {
    let expected = prev_position + playing_elapsed;
    if sampled < expected {
        expected
    } else {
        sampled
    }
}

/// 当前时刻的 Windows FILETIME（100ns，1601-01-01 起），供 LastUpdatedTime
/// 插值换算（WinRT DateTime.UniversalTime 同一纪元）。
#[cfg(windows)]
fn win_now_100ns() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64 / 100)
        .unwrap_or(0);
    unix + 116_444_736_000_000_000
}

/// 读取 (playing, position, duration, interpolated)，position 含
/// LastUpdatedTime 插值。
///
/// 进度精确口径：SMTC 的 `Position` 只是「LastUpdatedTime
/// 时刻」的采样值，播放期间真实位置 = Position + (now − LastUpdatedTime)，
/// 由系统时间戳兜底，不依赖事件频率，也不会累计漂移。暂停时 LastUpdatedTime
/// 停止前进、偏移无意义，只在 playing 时应用。duration > 0 时钳制到曲长
/// （曲目结束的越界值直接落到末尾，与原生 flyout 一致）。
///
/// 第四个返回值 = LastUpdatedTime 可信且插值已应用。false 时 position 是
/// 裸采样值——对不写时间戳的播放器（网易云）它可能是开播/seek 时刻的陈旧
/// 静态值，调用方不得把它当作实时位置（事件线程按单调地板兜底）。
#[cfg(windows)]
fn playback_snapshot(
    session: &windows::Media::Control::GlobalSystemMediaTransportControlsSession,
) -> (bool, f64, f64, bool) {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus;
    let playing = matches!(
        session.GetPlaybackInfo().map(|info| info.PlaybackStatus()),
        Ok(Ok(
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
        ))
    );
    let Ok(timeline) = session.GetTimelineProperties() else {
        return (false, 0.0, 0.0, false);
    };
    let mut position = timeline.Position().map(timespan_secs).unwrap_or(0.0);
    let mut interpolated = false;
    if playing {
        if let Ok(updated) = timeline.LastUpdatedTime() {
            interpolated = timestamp_plausible(updated.UniversalTime, win_now_100ns());
            if interpolated {
                position =
                    interpolated_position_secs(position, updated.UniversalTime, win_now_100ns());
            }
        }
    }
    let duration = timeline.EndTime().map(timespan_secs).unwrap_or(0.0);
    if duration > 0.0 {
        position = position.min(duration);
    }
    (playing, position, duration, interpolated)
}

/// 读取会话的传输控件能力位与循环/随机状态（读失败的位按 false/关处理，
/// 前端仅用于置灰展示，误灰好过误开）。
#[cfg(windows)]
fn read_controls(
    session: &windows::Media::Control::GlobalSystemMediaTransportControlsSession,
) -> MediaControls {
    use windows::Media::MediaPlaybackAutoRepeatMode;
    let mut c = MediaControls {
        repeat_mode: "off".into(),
        ..MediaControls::default()
    };
    let Ok(info) = session.GetPlaybackInfo() else {
        return c;
    };
    // IsShuffleEnabled/IsRepeatEnabled 挂在 Controls 对象上（WinRT 类型分布
    // 如此），AutoRepeatMode/IsShuffleActive 是可空 IReference，取 .Value()。
    if let Ok(ctl) = info.Controls() {
        c.play = ctl.IsPlayEnabled().unwrap_or(false);
        c.pause = ctl.IsPauseEnabled().unwrap_or(false);
        c.next = ctl.IsNextEnabled().unwrap_or(false);
        c.previous = ctl.IsPreviousEnabled().unwrap_or(false);
        c.seek = ctl.IsPlaybackPositionEnabled().unwrap_or(false);
        c.shuffle = ctl.IsShuffleEnabled().unwrap_or(false);
        c.repeat = ctl.IsRepeatEnabled().unwrap_or(false);
    }
    c.shuffle_active = info
        .IsShuffleActive()
        .ok()
        .and_then(|r| r.Value().ok())
        .unwrap_or(false);
    if let Ok(mode) = info.AutoRepeatMode().and_then(|r| r.Value()) {
        c.repeat_mode = match mode {
            MediaPlaybackAutoRepeatMode::Track => "one".into(),
            MediaPlaybackAutoRepeatMode::List => "all".into(),
            _ => "off".into(),
        };
    }
    c
}

/// 前台窗口进程的 exe 名（去扩展名、小写）。多会话并存时「用户正在交互的
/// 应用」优先（同类媒体浮窗同思路）：chrome 放着暂停的
/// 会话、Spotify 在后台播放，两者都算候选时前台匹配者胜出。
#[cfg(windows)]
fn foreground_process_hint() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid_process_stem(pid)
    }
}

/// AUMID → 候选进程名段（'!' 与 '.' 分段、小写、去 com/github/exe 噪音段；
/// 与同类媒体浮窗的 id 变体清洗同口径）。例：
/// `SpotifyAB.Spotify!Spotify` → ["spotifyab", "spotify"]。
#[cfg(windows)]
fn aumid_variants(aumid: &str) -> Vec<String> {
    aumid
        .split(['!', '.'])
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty() && !matches!(s.as_str(), "com" | "github" | "exe"))
        .collect()
}

/// 读取封面原始字节（≤8MB）。取色与 data URL 共用一次读取。
#[cfg(windows)]
fn thumbnail_bytes(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<Vec<u8>> {
    use windows::Storage::Streams::DataReader;

    let reference = props.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(bytes)
}

/// 封面字节 → base64 data URL（按魔数判 MIME）。
fn thumb_data_url(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mime = match bytes.get(0..4) {
        Some([0x89, b'P', b'N', b'G']) => "image/png",
        Some([0xff, 0xd8, 0xff, 0xe0]) | Some([0xff, 0xd8, 0xff, 0xe1]) => "image/jpeg",
        _ => "image/jpeg",
    };
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// Returns a snapshot of the active media session, or `None` when idle.
#[cfg(windows)]
pub fn get_system_media() -> Option<SystemMediaInfo> {
    with_com(|| {
        let session = active_session()?;
        let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
        let album = props
            .AlbumTitle()
            .map(|s| s.to_string())
            .unwrap_or_default();
        // Decode the artwork (best-effort; failure just means no cover shown).
        // §4.3：同一份字节顺带取色（单条目缓存按参数去抖）。
        let thumb_bytes = thumbnail_bytes(&props);
        let thumb = thumb_bytes.as_deref().map(thumb_data_url);
        let palette = media_palette_for(&title, &artist, &album, thumb_bytes.as_deref());
        let (playing, mut position, duration, interpolated) = playback_snapshot(&session);
        let controls = read_controls(&session);
        let aumid = session
            .SourceAppUserModelId()
            .map(|s| s.to_string())
            .unwrap_or_default();
        // 采样不可信（无 LastUpdatedTime 的播放器）时按看门线程台账外推，
        // 冷挂载首拉不从开播时刻的陈旧采样重新计时；台账不匹配（换曲/换
        // 会话/进程刚启动）保持裸采样。
        if !interpolated {
            if let Some(est) = ledger_position_for(&title, &artist, &album, &aumid, playing) {
                if est > position {
                    position = est;
                }
            }
            if duration > 0.0 {
                position = position.min(duration);
            }
        }

        // No meaningful content → treat as "no active media".
        if title.is_empty() && artist.is_empty() {
            return None;
        }
        Some(SystemMediaInfo {
            title,
            artist,
            album,
            playing,
            position,
            duration,
            thumb,
            palette: Some(palette),
            controls,
            aumid,
        })
    })
}

/// Sends a transport command to the active session. Returns `true` when a
/// session was reached (the await is best-effort).
#[cfg(windows)]
fn control_session(kind: MediaControl) -> bool {
    use windows::Media::MediaPlaybackAutoRepeatMode;
    with_com(|| {
        let session = active_session()?;
        let op = match kind {
            MediaControl::Play => session.TryPlayAsync(),
            MediaControl::Pause => session.TryPauseAsync(),
            // 切换式播放/暂停（同类媒体浮窗同款）：不依赖可能过期的 playing
            // 快照，SMTC 侧自行按当前态翻转。
            MediaControl::Toggle => session.TryTogglePlayPauseAsync(),
            MediaControl::Next => session.TrySkipNextAsync(),
            MediaControl::Previous => session.TrySkipPreviousAsync(),
            // SMTC 位置单位为 100ns；TryChangePlaybackPositionAsync 接受 i64。
            MediaControl::Seek(secs) => {
                session.TryChangePlaybackPositionAsync((secs.max(0.0) * 10_000_000.0) as i64)
            }
            // 随机开关：读当前态取反（IsShuffleActive 为可空 IReference）。
            MediaControl::Shuffle => {
                let active = session
                    .GetPlaybackInfo()
                    .ok()
                    .and_then(|info| info.IsShuffleActive().ok())
                    .and_then(|r| r.Value().ok())
                    .unwrap_or(false);
                session.TryChangeShuffleActiveAsync(!active)
            }
            // 循环关→列表→单曲→关。
            MediaControl::Repeat => {
                let current = session
                    .GetPlaybackInfo()
                    .ok()
                    .and_then(|info| info.AutoRepeatMode().ok())
                    .and_then(|r| r.Value().ok())
                    .unwrap_or(MediaPlaybackAutoRepeatMode::None);
                let next = match current {
                    MediaPlaybackAutoRepeatMode::List => MediaPlaybackAutoRepeatMode::Track,
                    MediaPlaybackAutoRepeatMode::Track => MediaPlaybackAutoRepeatMode::None,
                    _ => MediaPlaybackAutoRepeatMode::List,
                };
                session.TryChangeAutoRepeatModeAsync(next)
            }
        };
        op.ok()?.get().ok()?;
        Some(true)
    })
    .unwrap_or(false)
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum MediaControl {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    /// 跳到指定秒（歌词行点击 seek / 进度条拖动用）。
    Seek(f64),
    Shuffle,
    Repeat,
}

#[cfg(not(windows))]
pub fn get_system_media() -> Option<SystemMediaInfo> {
    None
}

#[cfg(not(windows))]
fn control_session(_kind: MediaControl) -> bool {
    false
}

#[cfg(not(windows))]
#[derive(Clone, Copy)]
enum MediaControl {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Seek(f64),
    Shuffle,
    Repeat,
}

/* ------------------------------------------------------------------ */
/* 位置台账：拉式命令对无时间戳播放器的插值兜底                          */
/* ------------------------------------------------------------------ */

/// 看门线程维护的位置台账（最近一次发射/校准拍的同曲目真实位置锚点，
/// position 已过单调地板）。`get_system_media_info` 拉式命令在时间戳不可信
/// （无 LastUpdatedTime 的播放器——网易云等，采样值是开播/seek 时刻的静态
/// 陈值）时按它插值出接近真实的当前位置，组件冷挂载/热重载的首拉不至于
/// 从开播时刻重新计时。进程重启后台账清零，首拉仍可能偏旧（SMTC 对这类
/// 播放器不提供更多信息）。
struct PositionLedger {
    position: f64,
    at: std::time::Instant,
    playing: bool,
    title: String,
    artist: String,
    album: String,
    aumid: String,
}

static POSITION_LEDGER: Mutex<Option<PositionLedger>> = Mutex::new(None);

fn store_position_ledger(ledger: PositionLedger) {
    POSITION_LEDGER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .replace(ledger);
}

fn clear_position_ledger() {
    POSITION_LEDGER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
}

/// 拉式命令的台账匹配与外推：同曲目、同会话且播放态一致才生效——在播按
/// 「锚点 + 流逝时间」外推，暂停冻结在锚点。
fn ledger_position_for(
    title: &str,
    artist: &str,
    album: &str,
    aumid: &str,
    playing: bool,
) -> Option<f64> {
    let guard = POSITION_LEDGER.lock().unwrap_or_else(|p| p.into_inner());
    let l = guard.as_ref()?;
    if l.playing != playing
        || l.title != title
        || l.artist != artist
        || l.album != album
        || (!l.aumid.is_empty() && !aumid.is_empty() && l.aumid != aumid)
    {
        return None;
    }
    Some(if l.playing {
        l.position + l.at.elapsed().as_secs_f64()
    } else {
        l.position
    })
}

/* ------------------------------------------------------------------ */
/* §4.8 SMTC 事件化：常驻事件线程，变化才 emit `media:snapshot`          */
/* ------------------------------------------------------------------ */

/// media:snapshot 只投给小组件层窗口：消费者是共享 useNowPlaying（音乐 /
/// 正在播放 / 沉浸页 / 迷你磁贴）与灵动岛 DockTakeover，全部挂在 widget-*
/// 桌面层。此前全局 emit 让设置窗/quick-note/taskbar-net 也陪着收整份
/// 快照——封面帧（thumb_changed）带整份 base64 data URL，可达数百 KB。
fn emit_snapshot(app: &tauri::AppHandle, payload: Option<MediaSnapshot>) {
    let _ = app.emit_filter("media:snapshot", payload, |win| match win {
        tauri::EventTarget::WebviewWindow { label }
        | tauri::EventTarget::Webview { label }
        | tauri::EventTarget::Window { label }
        | tauri::EventTarget::AnyLabel { label } => label.starts_with("widget-"),
        _ => false,
    });
}

/// 启动媒体事件监视线程（lib.rs setup 调用一次）。线程内自愈：WinRT 错误或
/// panic 后延迟 15s 重试，前端最坏退回事件前的状态（首拉快照冻结），不会
/// 崩溃进程。
pub fn start_media_event_watcher(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("media-events".into())
        .spawn(move || loop {
            #[cfg(windows)]
            {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    media_event_loop(&app)
                }));
                match r {
                    Err(p) => {
                        let msg = p
                            .downcast_ref::<&str>()
                            .map(|s| s.to_string())
                            .or_else(|| p.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "unknown".into());
                        log::error!("media event watcher panicked: {msg}; retry in 15s");
                        std::thread::sleep(Duration::from_secs(15));
                    }
                    Ok(Err(e)) => {
                        log::warn!("media event watcher error: {e}; retry in 15s");
                        std::thread::sleep(Duration::from_secs(15));
                    }
                    Ok(Ok(())) => return,
                }
            }
            #[cfg(not(windows))]
            {
                let _ = &app;
                return;
            }
        })
        .ok();
}

#[cfg(windows)]
fn media_event_loop(app: &tauri::AppHandle) -> windows::core::Result<()> {
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    // MTA：事件回调由 RPC 线程池派发（无需消息泵），本线程只负责建快照与
    // emit——WinRT 对象非 Send，全部留在本线程，回调里只置脏标志。
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        return Err(windows::core::Error::from_hresult(hr));
    }
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: 与成功的 CoInitializeEx 配对。
                unsafe { CoUninitialize() };
            }
        }
    }
    let _com = ComGuard(hr.is_ok());

    let manager: GlobalSystemMediaTransportControlsSessionManager =
        GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;

    // 事件脏标志：回调（RPC 线程）置位，本线程消费。
    let props_dirty = Arc::new(AtomicBool::new(true));
    let timeline_dirty = Arc::new(AtomicBool::new(true));
    let play_dirty = Arc::new(AtomicBool::new(true));
    let sessions_dirty = Arc::new(AtomicBool::new(true));

    let sd = sessions_dirty.clone();
    let _sessions_token = manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
        sd.store(true, Ordering::Release);
        Ok(())
    }))?;

    /// 已注册事件的活动会话（换会话时用持有的对象注销旧 token）。
    struct Registered {
        session: windows::Media::Control::GlobalSystemMediaTransportControlsSession,
        aumid: String,
        props: i64,
        timeline: i64,
        play: i64,
    }
    let mut registered: Option<Registered> = None;

    // 非选中会话的 PlaybackInfoChanged 订阅（aumid → 会话+token）：后台
    // 会话开播/暂停时立即置 sessions_dirty 唤醒 resolve。只靠 1s 兜底轮询
    // 的话，切换播放源（Spotify ↔ 浏览器）最慢要等满 1s 才被看见。
    let mut extra_subs: std::collections::HashMap<
        String,
        (
            windows::Media::Control::GlobalSystemMediaTransportControlsSession,
            i64,
        ),
    > = std::collections::HashMap::new();

    // 上一轮 resolve 的在播会话集合（独占播放的「新开播」判定基准）。
    let mut prev_playing: Vec<String> = Vec::new();

    // 快照状态：属性缓存（含封面字节/data URL/取色）只在 props 脏时重建。
    let mut cached_title = String::new();
    let mut cached_artist = String::new();
    let mut cached_album = String::new();
    let mut cached_thumb_bytes: Option<Vec<u8>> = None;
    let mut cached_thumb: Option<String> = None;
    let mut last_emit: Option<MediaSnapshot> = None;
    let mut last_emitted_palette: Option<MediaPalette> = None;
    let mut last_emit_at = std::time::Instant::now();
    let mut last_resolve = std::time::Instant::now();
    let mut idle_emitted = false;

    loop {
        std::thread::sleep(Duration::from_millis(200));

        let resolve_due = sessions_dirty.load(Ordering::Acquire)
            || last_resolve.elapsed() >= Duration::from_secs(1);
        if !resolve_due {
            continue;
        }
        last_resolve = std::time::Instant::now();
        let sessions_changed = sessions_dirty.swap(false, Ordering::AcqRel);

        let picked = pick_session(&manager);
        let Some(session) = picked else {
            if let Some(r) = registered.take() {
                // SAFETY: token 来自同一 session 对象的注册。
                let _ = r.session.RemoveMediaPropertiesChanged(r.props);
                let _ = r.session.RemoveTimelinePropertiesChanged(r.timeline);
                let _ = r.session.RemovePlaybackInfoChanged(r.play);
            }
            extra_subs.clear();
            if !idle_emitted {
                idle_emitted = true;
                last_emit = None;
                clear_position_ledger();
                emit_snapshot(app, None);
            }
            // 无会话时降低解析频率：靠 SessionsChanged 事件唤醒。
            std::thread::sleep(Duration::from_secs(2));
            sessions_dirty.store(true, Ordering::Release);
            continue;
        };

        let aumid = session
            .SourceAppUserModelId()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let session_changed = registered
            .as_ref()
            .map(|r| r.aumid != aumid)
            .unwrap_or(true)
            || sessions_changed;
        if session_changed {
            if let Some(r) = registered.take() {
                // SAFETY: token 来自同一 session 对象的注册。
                let _ = r.session.RemoveMediaPropertiesChanged(r.props);
                let _ = r.session.RemoveTimelinePropertiesChanged(r.timeline);
                let _ = r.session.RemovePlaybackInfoChanged(r.play);
            }
            // 三次注册逐项登记到 partial（按事件类型配对反注册方法）：任一
            // 失败即反注册已成功的 token，不在 session 上留孤儿订阅，也不携带
            // 半套状态跳出循环。play 是最后一次注册：失败时无 token，成功后
            // 直接返回，故无需入列。
            enum PendingSub {
                Props(i64),
                Timeline(i64),
            }
            let mut partial: Vec<PendingSub> = Vec::new();
            let reg = (|| -> windows::core::Result<Registered> {
                let pd = props_dirty.clone();
                let props =
                    session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                        pd.store(true, Ordering::Release);
                        Ok(())
                    }))?;
                partial.push(PendingSub::Props(props));
                let td = timeline_dirty.clone();
                let timeline =
                    session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                        td.store(true, Ordering::Release);
                        Ok(())
                    }))?;
                partial.push(PendingSub::Timeline(timeline));
                let pl = play_dirty.clone();
                let play = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                    pl.store(true, Ordering::Release);
                    Ok(())
                }))?;
                Ok(Registered {
                    session: session.clone(),
                    aumid: aumid.clone(),
                    props,
                    timeline,
                    play,
                })
            })();
            match reg {
                Ok(r) => registered = Some(r),
                Err(e) => {
                    for sub in partial {
                        match sub {
                            PendingSub::Props(t) => {
                                let _ = session.RemoveMediaPropertiesChanged(t);
                            }
                            PendingSub::Timeline(t) => {
                                let _ = session.RemoveTimelinePropertiesChanged(t);
                            }
                        }
                    }
                    log::warn!("media session subscribe failed (retry next resolve): {e}");
                    // 下一轮 resolve 重试；期间靠 1s 兜底轮询保持快照可用。
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
            // 新会话：强制全量快照（含封面）。
            props_dirty.store(true, Ordering::Release);
            timeline_dirty.store(true, Ordering::Release);
            play_dirty.store(true, Ordering::Release);
            idle_emitted = false;
        }

        // --- 全会话 PlaybackInfoChanged 订阅同步：多余的注销、缺失的补上；
        // 顺带枚举各会话播放态，供独占播放（W-131）使用 ---
        let mut playing_now: Vec<String> = Vec::new();
        {
            let picked_aumid = registered.as_ref().map(|r| r.aumid.clone());
            let mut wanted: Vec<(
                String,
                windows::Media::Control::GlobalSystemMediaTransportControlsSession,
                bool,
            )> = Vec::new();
            if let Ok(sessions) = manager.GetSessions() {
                if let Ok(size) = sessions.Size() {
                    for i in 0..size {
                        if let Ok(s) = sessions.GetAt(i) {
                            if let Ok(a) = s.SourceAppUserModelId() {
                                let aumid = a.to_string();
                                let playing = s
                                    .GetPlaybackInfo()
                                    .ok()
                                    .and_then(|info| info.PlaybackStatus().ok())
                                    .map(|st| st == windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                                    .unwrap_or(false);
                                if playing && !is_blocked(&aumid) {
                                    playing_now.push(aumid.clone());
                                }
                                wanted.push((aumid, s, playing));
                            }
                        }
                    }
                }
            }
            // 订阅去重按「AUMID + COM 对象身份」双重判断：仅按 AUMID 会让
            // 同应用重启（同一 AUMID、新会话对象）沿用旧对象的死订阅，新会话
            // 永远等不到事件。IUnknown 指针即 WinRT 对象身份。
            fn session_identity(
                s: &windows::Media::Control::GlobalSystemMediaTransportControlsSession,
            ) -> *mut std::ffi::c_void {
                use windows::core::Interface;
                s.cast::<windows::core::IUnknown>()
                    .map(|u| u.as_raw())
                    .unwrap_or(std::ptr::null_mut())
            }
            extra_subs.retain(|k, (old_session, _)| {
                *k != picked_aumid.as_deref().unwrap_or("")
                    && wanted.iter().any(|(a, s, _)| {
                        a == k && session_identity(s) == session_identity(old_session)
                    })
            });
            for (aumid, session, _) in &wanted {
                if Some(aumid) == picked_aumid.as_ref() {
                    continue;
                }
                if let Some((old_session, _)) = extra_subs.get(aumid) {
                    if session_identity(old_session) == session_identity(session) {
                        continue;
                    }
                    // 同 AUMID 的新会话对象：反注册旧订阅后换绑。
                    if let Some((old_session, old_token)) = extra_subs.remove(aumid) {
                        let _ = old_session.RemovePlaybackInfoChanged(old_token);
                    }
                }
                let sd = sessions_dirty.clone();
                if let Ok(token) =
                    session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                        sd.store(true, Ordering::Release);
                        Ok(())
                    }))
                {
                    extra_subs.insert(aumid.clone(), (session.clone(), token));
                }
            }

            // W-131 独占播放：对「本次 resolve 新开播」的会话，暂停其余在播
            // 会话（后来者胜，同类媒体浮窗的同名逻辑同
            // 语义）。取 started 首个避免多个同时开播时互相暂停。
            if pause_others_enabled() {
                let started: Vec<&String> = playing_now
                    .iter()
                    .filter(|a| !prev_playing.iter().any(|p| p == *a))
                    .collect();
                if let Some(survivor) = started.first() {
                    for (a, session, playing) in &wanted {
                        if !playing || a == *survivor {
                            continue;
                        }
                        let _ = session.TryPauseAsync().and_then(|op| op.get());
                    }
                }
            }
            prev_playing = playing_now.clone();
        }

        let props_now = props_dirty.swap(false, Ordering::AcqRel);
        let timeline_now = timeline_dirty.swap(false, Ordering::AcqRel);
        let play_now = play_dirty.swap(false, Ordering::AcqRel);
        // 校准节拍：播放中每 ~5s 复核一次位置漂移；暂停/空闲不校准。
        let playing_before = last_emit.as_ref().map(|s| s.playing).unwrap_or(false);
        let calib_due = playing_before && last_emit_at.elapsed() >= Duration::from_secs(5);
        if !props_now && !timeline_now && !play_now && !calib_due {
            continue;
        }

        // --- 组快照（全部在本线程，WinRT 对象不跨线程） ---
        let mut thumb_changed = false;
        let mut palette_field: Option<MediaPalette> = None;
        if props_now {
            // 属性读取失败（会话恰好被关闭/挂起等瞬时 WinRT 错误）只跳过本帧：
            // props 脏标记已被取走，下一个属性事件或 1s 兜底 resolve 会重读。
            // 此前 `?` 直接把错误抛出循环，整循环拆毁 + 15s 重建，期间快照冻结。
            match session.TryGetMediaPropertiesAsync() {
                Ok(op) => match op.get() {
                    Ok(props) => {
                        let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
                        let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
                        let album = props
                            .AlbumTitle()
                            .map(|s| s.to_string())
                            .unwrap_or_default();
                        let thumb_bytes = thumbnail_bytes(&props);
                        // 同参数去抖：曲目未变且封面字节相同 → 不标记 thumb_changed，
                        // 不重发封面也不重算取色。
                        let track_same = title == cached_title
                            && artist == cached_artist
                            && album == cached_album;
                        let thumb_same = thumb_bytes == cached_thumb_bytes;
                        if !(track_same && thumb_same) {
                            thumb_changed = true;
                            // §4.3 封面取色：仅在此拍重算（缓存按参数去抖），值与上次
                            // 下发相同则不携带（palette_field=None，前端沿用）。
                            let palette =
                                media_palette_for(&title, &artist, &album, thumb_bytes.as_deref());
                            if last_emitted_palette.as_ref() != Some(&palette) {
                                last_emitted_palette = Some(palette.clone());
                                palette_field = Some(palette);
                            }
                            cached_thumb = thumb_bytes.as_deref().map(thumb_data_url);
                        }
                        cached_title = title;
                        cached_artist = artist;
                        cached_album = album;
                        cached_thumb_bytes = thumb_bytes;
                    }
                    Err(e) => log::warn!("media props read failed (skip frame): {e}"),
                },
                Err(e) => log::warn!("media props request failed (skip frame): {e}"),
            }
        }

        // 位置含 LastUpdatedTime 插值（真实实时位置），随 playback 状态变化
        // 都会重读；controls 同步读取，变化并入发射判定。
        let (playing, mut position, duration, interpolated) = playback_snapshot(&session);
        let controls = read_controls(&session);

        // 无有效内容视同空闲。
        if cached_title.is_empty() && cached_artist.is_empty() {
            if !idle_emitted {
                idle_emitted = true;
                last_emit = None;
                clear_position_ledger();
                emit_snapshot(app, None);
            }
            continue;
        }
        idle_emitted = false;

        // --- 单调位置地板（网易云回跳修复）：不写 LastUpdatedTime 的播放
        // 器，采样 Position 在播放期间是陈旧静态值（只在开播/暂停/seek/换曲
        // 那拍更新一次），拿它做 >1s 漂移校准会把前端锚点每 ~5s 拽回旧采样
        // ——进度条表现为「播几秒就回跳重新计时」。同曲目连续播放、且本拍
        // 无 timeline 事件时，位置过单调地板取「锚点 + 预期推进」；timeline
        // 事件拍（seek/单曲循环回零，采样自证新鲜）与换曲拍（元数据/曲长
        // 变化）放行裸采样，合法回退不受影响。时间戳可信（interpolated）的
        // 会话位置精确已知，无需地板。 ---
        if playing && !interpolated && !timeline_now {
            if let Some(prev) = &last_emit {
                let same_track = prev.title == cached_title
                    && prev.artist == cached_artist
                    && prev.album == cached_album
                    && (prev.duration - duration).abs() < 0.5;
                if same_track && prev.playing {
                    position = floored_position(
                        prev.position,
                        last_emit_at.elapsed().as_secs_f64(),
                        position,
                    );
                }
            }
        }

        // --- 发射判定：内容/播放态/能力位/封面变化必发；否则仅漂移 >1s 时校准 ---
        let should_emit = match &last_emit {
            None => true,
            Some(prev) => {
                let meta_changed = prev.title != cached_title
                    || prev.artist != cached_artist
                    || prev.album != cached_album
                    || prev.playing != playing
                    || prev.duration != duration
                    || prev.controls != controls;
                let drift = if prev.playing {
                    (position - (prev.position + last_emit_at.elapsed().as_secs_f64())).abs()
                } else {
                    (position - prev.position).abs()
                };
                meta_changed || thumb_changed || drift > 1.0
            }
        };
        if should_emit {
            let snap = MediaSnapshot {
                title: cached_title.clone(),
                artist: cached_artist.clone(),
                album: cached_album.clone(),
                playing,
                position,
                duration,
                thumb_changed,
                thumb: cached_thumb.clone(),
                palette: palette_field,
                controls: controls.clone(),
                aumid: aumid.clone(),
            };
            last_emit_at = std::time::Instant::now();
            last_emit = Some(snap.clone());
            emit_snapshot(app, Some(snap));
        }
        if calib_due {
            // 只刷新校准基准（不发事件），避免漂移窗口越滚越大。
            last_emit_at = std::time::Instant::now();
            if let Some(prev) = last_emit.as_mut() {
                prev.position = position;
            }
        }
        // 记位置台账（发射拍与校准拍都会走到；position 已过地板，是该拍
        // 模型下的真实位置），供拉式命令对无时间戳播放器做冷挂载插值。
        store_position_ledger(PositionLedger {
            position,
            at: std::time::Instant::now(),
            playing,
            title: cached_title.clone(),
            artist: cached_artist.clone(),
            album: cached_album.clone(),
            aumid: aumid.clone(),
        });
    }
}

/// Tauri command: return the system-wide now-playing track, if any.
/// The MusicWidget polls this every second; every WinRT call here blocks on
/// `.get()` (up to seconds when the owning app is suspended), so the work is
/// spawned to the blocking pool instead of squatting on an async worker.
#[tauri::command]
pub async fn get_system_media_info() -> Option<SystemMediaInfo> {
    tauri::async_runtime::spawn_blocking(get_system_media)
        .await
        .ok()
        .flatten()
}

/// Tauri command: send a transport control (play/pause/toggle/next/previous/
/// seek/shuffle/repeat)。`seek` 需带 `position`（秒）；`shuffle`/`repeat` 是
/// 开关式动作（读当前态取反/循环），其余动作忽略该参数。
#[tauri::command]
pub async fn control_system_media(
    window: tauri::Window,
    action: String,
    position: Option<f64>,
) -> Result<bool, String> {
    // 窗口闸门：传输控制是真实系统副作用，与 pomodoro_media_* 同标准；
    // 拒绝走 Err（M2 统一语义）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let kind = match action.as_str() {
        "play" => MediaControl::Play,
        "pause" => MediaControl::Pause,
        "toggle" => MediaControl::Toggle,
        "next" => MediaControl::Next,
        "previous" => MediaControl::Previous,
        "seek" => MediaControl::Seek(position.unwrap_or(0.0)),
        "shuffle" => MediaControl::Shuffle,
        "repeat" => MediaControl::Repeat,
        _ => return Ok(false),
    };
    Ok(
        tauri::async_runtime::spawn_blocking(move || control_session(kind))
            .await
            .unwrap_or(false),
    )
}

/// AUMID → 用户可读的应用名（进程内缓存）。
///
/// 对齐同类媒体浮窗的展示目标：会话选择器里显示「网易云音乐」
/// 而不是 `NetEase.CloudMusic...!xxx`。取名顺序：
/// 1. 注册表 `HKCU\Software\Classes\AppUserModelId\<aumid>` 的 DisplayName
///    （Win32 注册方：网易云/QQ 音乐等，值即本地化应用名）；
/// 2. UWP（AUMID 含 '!'）：包 fullName 去掉版本/架构后缀、去 `Microsoft.`
///    前缀（`Microsoft.ZuneMusic_8wekyb3d8bbwe!…` → `ZuneMusic`）；
/// 3. 兜底沿用旧口径：'!' 后段。
#[cfg(windows)]
fn friendly_session_name(aumid: &str) -> String {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(name) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(aumid) {
        return name.clone();
    }

    let resolved = (|| -> Option<String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let display = hkcu
            .open_subkey(format!(r"Software\Classes\AppUserModelId\{aumid}"))
            .and_then(|k| k.get_value::<String, _>("DisplayName"))
            .ok()
            .filter(|s| !s.trim().is_empty());
        if display.is_some() {
            return display;
        }
        let (pkg, _app) = aumid.split_once('!')?;
        let base = pkg.split('_').next()?.trim();
        if base.is_empty() {
            return None;
        }
        let stripped = base.strip_prefix("Microsoft.").unwrap_or(base);
        Some(stripped.to_string())
    })()
    .unwrap_or_else(|| aumid.rsplit('!').next().unwrap_or(aumid).to_string());

    cache
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(aumid.to_string(), resolved.clone());
    resolved
}

#[cfg(windows)]
fn list_sessions() -> Vec<MediaSessionInfo> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    with_com(|| {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()?
            .get()
            .ok()?;
        let sessions = manager.GetSessions().ok()?;
        let count = sessions.Size().ok()?;
        let mut out = Vec::new();
        for i in 0..count {
            // P2（审计修复）：逐项跳过——此前 `.ok()?` 让单个异常会话把整个
            // 会话列表清空（设置页"锁定应用"下拉变空）。
            let Ok(session) = sessions.GetAt(i) else {
                continue;
            };
            let Ok(aumid) = session.SourceAppUserModelId() else {
                continue;
            };
            let id = aumid.to_string();
            if id.is_empty() {
                continue;
            }
            let name = friendly_session_name(&id);
            let playing = session
                .GetPlaybackInfo()
                .ok()
                .and_then(|info| info.PlaybackStatus().ok())
                .map(|s| s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                .unwrap_or(false);
            let blocked = is_blocked(&id);
            out.push(MediaSessionInfo {
                id,
                name,
                playing,
                blocked,
            });
        }
        Some(out)
    })
    .unwrap_or_default()
}

#[cfg(not(windows))]
fn list_sessions() -> Vec<MediaSessionInfo> {
    Vec::new()
}

/// Tauri command: W-123 枚举当前可用的媒体会话（应用）。
#[tauri::command]
pub async fn list_media_sessions(window: tauri::Window) -> Vec<MediaSessionInfo> {
    // 隐私闸门（S4）：媒体会话名（正在听什么 / 用什么应用）属敏感枚举面。
    if !crate::trusted_window(window.label()) {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(list_sessions)
        .await
        .unwrap_or_default()
}

/// Tauri command: W-123 锁定/解锁媒体会话。`id = None` 恢复自动模式。
#[tauri::command]
pub fn select_media_session(window: tauri::Window, id: Option<String>) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    // R7（审计）：写锁中毒时静默丢弃选择会让"锁定会话"永远不生效。
    let mut guard = SELECTED_SESSION.write().unwrap_or_else(|p| p.into_inner());
    *guard = id.filter(|s| !s.is_empty());
    Ok(())
}

/// Tauri command: W-123 当前锁定的会话 id（前端勾选态用）。
#[tauri::command]
pub fn get_selected_media_session() -> Option<String> {
    selected_session_id()
}

/// 合并载荷：会话列表 + 当前锁定 id（前端 3s 轮询单命令单往返）。
#[derive(Clone, Debug, Serialize)]
pub struct MediaSessionsPage {
    pub sessions: Vec<MediaSessionInfo>,
    pub selected_id: Option<String>,
}

/// Tauri command: 一次往返返回会话列表与锁定 id——此前前端轮询器每 3s 发
/// list_media_sessions + get_selected_media_session 两条 IPC。
#[tauri::command]
pub async fn get_media_sessions_page(window: tauri::Window) -> MediaSessionsPage {
    // gate: none needed（闸门在 list_media_sessions 内：非受信窗口拿到空列表
    // + 本就公开的 selected_id，与拆两条命令时的口径一致）
    MediaSessionsPage {
        sessions: list_media_sessions(window).await,
        selected_id: selected_session_id(),
    }
}

/// Tauri command: W-131 写入媒体监控行为偏好（前端 settings.general.media
/// 变更时推送；持久化在前端设置层，Rust 只保存运行期副本）。
#[tauri::command]
pub fn set_media_behavior(
    window: tauri::Window,
    pause_others: bool,
    blocked_sessions: Vec<String>,
) -> Result<(), String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    PAUSE_OTHERS.store(pause_others, Ordering::Relaxed);
    let mut guard = BLOCKED_SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    *guard = blocked_sessions
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    Ok(())
}

/// Tauri command: W-131 当前媒体监控行为偏好（前端回显/对账）。
#[tauri::command]
pub fn get_media_behavior(window: tauri::Window) -> Result<MediaBehavior, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    Ok(MediaBehavior {
        pause_others: pause_others_enabled(),
        blocked_sessions: blocked_sessions(),
    })
}

/// AUMID → 播放器进程 PID（W-131）。sysinfo 枚举进程，exe 文件名（去扩展
/// 名、小写）与 AUMID 分段比对——与 pick_session 的前台匹配同一套变体口径。
/// 结果缓存 2s：滚轮调音量/唤起是高频动作，进程全量枚举不能每次都跑。
#[cfg(windows)]
fn resolve_media_pid(aumid: &str) -> Option<u32> {
    use std::time::Instant;
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    static CACHE: std::sync::OnceLock<Mutex<(System, Instant)>> = std::sync::OnceLock::new();
    let cell = CACHE.get_or_init(|| {
        Mutex::new((
            System::new(),
            Instant::now() - std::time::Duration::from_secs(3600),
        ))
    });
    let mut guard = cell.lock().unwrap_or_else(|p| p.into_inner());
    if guard.1.elapsed() >= std::time::Duration::from_secs(2) {
        guard.0.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
        );
        guard.1 = Instant::now();
    }
    let variants = aumid_variants(aumid);
    if variants.is_empty() {
        return None;
    }
    guard
        .0
        .processes()
        .values()
        .find(|p| {
            p.exe()
                .and_then(|path| path.file_stem())
                .map(|stem| {
                    let stem = stem.to_string_lossy().to_ascii_lowercase();
                    variants.iter().any(|v| v == &stem)
                })
                .unwrap_or(false)
        })
        .map(|p| p.pid().as_u32())
}

/// Tauri command: W-131 唤起播放器窗口（同类媒体浮窗同目的）。优先选「窗口标题含正在播放曲目」的窗口（浏览器多窗口时定位
/// 到播放那个），回退该应用任一可见窗口；最小化则先还原。
#[tauri::command]
pub async fn open_media_player(
    window: tauri::Window,
    aumid: String,
    title: Option<String>,
) -> Result<bool, String> {
    // 窗口闸门：唤起第三方应用窗口是真实系统副作用（与传输控制同标准）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    Ok(tauri::async_runtime::spawn_blocking(move || {
        open_media_player_blocking(&aumid, title.as_deref())
    })
    .await
    .unwrap_or(false))
}

/// Tauri command: W-131 读取当前媒体应用的会话音量（0–1）。该应用在默认
/// 输出设备上没有音频会话时为 None（前端据此不显示滚轮音量提示）。
#[tauri::command]
pub async fn get_media_app_volume(aumid: String) -> Option<f64> {
    tauri::async_runtime::spawn_blocking(move || {
        let pid = resolve_media_pid(&aumid)?;
        crate::audio::media_session_volume(pid, None)
    })
    .await
    .ok()
    .flatten()
}

/// Tauri command: W-131 相对调整当前媒体应用的会话音量（`delta` 叠加在当前
/// 值上，结果钳 0–1），返回调整后的音量；会话不存在时 None。
#[tauri::command]
pub async fn adjust_media_app_volume(
    window: tauri::Window,
    aumid: String,
    delta: f64,
) -> Result<Option<f64>, String> {
    // 窗口闸门：改系统音频会话音量是真实系统副作用（与传输控制同标准）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let pid = resolve_media_pid(&aumid)?;
        let current = crate::audio::media_session_volume(pid, None)?;
        crate::audio::media_session_volume(pid, Some(current + delta))
    })
    .await
    .ok()
    .flatten())
}

/* ------------------------------------------------------------------ */
/* FocusTimer 借鉴：专注期媒体联动（pause_all / smart resume 的 Rust 侧） */
/* ------------------------------------------------------------------ */

/// 暂停全部在播媒体会话（黑名单除外），返回实际被我们暂停的 AUMID 列表
/// （前端记为 auto_paused 集合，供恢复与「别顶掉用户手动播放」检查）。
#[cfg(windows)]
fn pause_all_playing_sessions() -> Vec<String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    with_com(|| {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()?
            .get()
            .ok()?;
        let sessions = manager.GetSessions().ok()?;
        let count = sessions.Size().ok()?;
        let mut paused = Vec::new();
        for i in 0..count {
            let Ok(session) = sessions.GetAt(i) else {
                continue;
            };
            let Ok(aumid) = session.SourceAppUserModelId() else {
                continue;
            };
            let id = aumid.to_string();
            if id.is_empty() || is_blocked(&id) {
                continue;
            }
            let playing = session
                .GetPlaybackInfo()
                .ok()
                .and_then(|info| info.PlaybackStatus().ok())
                .map(|s| s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                .unwrap_or(false);
            if !playing {
                continue;
            }
            // TryPauseAsync 成功才记账：失败（应用已挂起等）不留幽灵条目。
            if session
                .TryPauseAsync()
                .ok()
                .and_then(|op| op.get().ok())
                .is_some()
            {
                paused.push(id);
            }
        }
        Some(paused)
    })
    .unwrap_or_default()
}

#[cfg(not(windows))]
fn pause_all_playing_sessions() -> Vec<String> {
    Vec::new()
}

/// 恢复指定 AUMID 的会话（仅当其状态为 Paused——Playing 的跳过，避免双重
/// 播放指令），返回实际恢复的 AUMID。
#[cfg(windows)]
fn resume_media_sessions(aumids: &[String]) -> Vec<String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    if aumids.is_empty() {
        return Vec::new();
    }
    with_com(|| {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()?
            .get()
            .ok()?;
        let sessions = manager.GetSessions().ok()?;
        let count = sessions.Size().ok()?;
        let mut resumed = Vec::new();
        for i in 0..count {
            let Ok(session) = sessions.GetAt(i) else {
                continue;
            };
            let Ok(aumid) = session.SourceAppUserModelId() else {
                continue;
            };
            let id = aumid.to_string();
            if !aumids.iter().any(|a| a == &id) {
                continue;
            }
            let paused = session
                .GetPlaybackInfo()
                .ok()
                .and_then(|info| info.PlaybackStatus().ok())
                .map(|s| s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused)
                .unwrap_or(false);
            if !paused {
                continue;
            }
            if session
                .TryPlayAsync()
                .ok()
                .and_then(|op| op.get().ok())
                .is_some()
            {
                resumed.push(id);
            }
        }
        Some(resumed)
    })
    .unwrap_or_default()
}

#[cfg(not(windows))]
fn resume_media_sessions(_aumids: &[String]) -> Vec<String> {
    Vec::new()
}

/// Tauri command: FocusTimer 借鉴 —— 专注开始时暂停全部在播媒体（黑名单
/// 除外），返回被暂停的 AUMID 列表（前端 auto_paused 账本）。
#[tauri::command]
pub async fn pomodoro_media_pause_all(window: tauri::Window) -> Result<Vec<String>, String> {
    // 拒绝走 Err（M2 统一语义）：空表与「闸门拒绝」对前端不再不可分。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    Ok(
        tauri::async_runtime::spawn_blocking(pause_all_playing_sessions)
            .await
            .unwrap_or_default(),
    )
}

/// Tauri command: FocusTimer 借鉴 —— 专注结束/休息开始时恢复此前被我们
/// 暂停的媒体会话（是否恢复由前端的「有别处在播」检查决定）。
#[tauri::command]
pub async fn pomodoro_media_resume(
    window: tauri::Window,
    aumids: Vec<String>,
) -> Result<Vec<String>, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    Ok(
        tauri::async_runtime::spawn_blocking(move || resume_media_sessions(&aumids))
            .await
            .unwrap_or_default(),
    )
}

/// 进程映像文件的 exe 名（去扩展名、小写）。OpenProcess 失败（权限/退出）
/// 返回 None。前台匹配（[`foreground_process_hint`]）与窗口枚举共用。
#[cfg(windows)]
fn pid_process_stem(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let stem = std::path::Path::new(&path)
            .file_stem()?
            .to_string_lossy()
            .to_ascii_lowercase();
        if stem.is_empty() {
            None
        } else {
            Some(stem)
        }
    }
}

/// 枚举顶层窗口找播放器（W-131，同类媒体浮窗同目的）：
/// AUMID 属性精确/包族前缀，或进程名与 AUMID 分段匹配；带曲目标题时优先
/// 「标题含曲目」的窗口（浏览器窗口标题 = 活动标签页标题，多窗口时定位到
/// 播放那个）。命中后最小化先还原，再拉到前台。
#[cfg(windows)]
fn open_media_player_blocking(aumid: &str, title: Option<&str>) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetPropW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    /// GetPropW 的属性名（UTF-16 常量）。
    const PROP_AUMID: PCWSTR = windows::core::w!("AppUserModelId");

    // SAFETY: 回调只往调用方 Vec 里 push；EnumWindows 不向目标窗口发消息。
    unsafe fn collect_visible_windows() -> Vec<HWND> {
        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
            let out = &mut *(lparam.0 as *mut Vec<HWND>);
            out.push(hwnd);
            windows::core::BOOL(1)
        }
        let mut out: Vec<HWND> = Vec::new();
        let lparam = LPARAM(&mut out as *mut Vec<HWND> as isize);
        unsafe {
            let _ = EnumWindows(Some(cb), lparam);
        }
        out
    }

    // SAFETY: 只读窗口查询，缓冲区按返回长度分配。
    unsafe fn window_title(hwnd: HWND) -> String {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    let mut hits: Vec<HWND> = Vec::new();
    let mut title_hits: Vec<HWND> = Vec::new();
    let family = aumid.split_once('!').map(|(f, _)| f.to_string());
    let variants = aumid_variants(aumid);
    let needle = title
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty());

    for hwnd in unsafe { collect_visible_windows() } {
        // SAFETY: 只读窗口查询。
        if unsafe { !IsWindowVisible(hwnd).as_bool() } {
            continue;
        }
        let mut pid = 0u32;
        // SAFETY: 只读。
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let stem = pid_process_stem(pid);

        // 匹配：shell AppUserModelId 属性精确 / 包族前缀（UWP），或 exe 名分段。
        let mut matched = false;
        {
            // SAFETY: GetPropW 只读；属性字符串由 shell 管理，读取不转移所有权。
            let prop = unsafe { GetPropW(hwnd, PROP_AUMID) };
            // 过滤 atom / 小整数属性：SetPropW 允许存任意 HANDLE（GlobalAddAtom
            // 的 atom 落在 0xC000-0xFFFF），当指针解引用会直接 AV 崩掉本进程；
            // shell 写入的 AppUserModelId 是堆字符串指针，恒高于 64K。
            if !prop.is_invalid() && prop.0 as usize > 0x10000 {
                // SAFETY: 属性是 NUL 结尾的 UTF-16 串；逐字读取、遇 NUL 即停、
                // 上限 512 字符（AUMID 实际远短于此）。
                let mut chars = Vec::with_capacity(64);
                let mut p = prop.0 as *const u16;
                for _ in 0..512 {
                    let c = unsafe { p.read_unaligned() };
                    if c == 0 {
                        break;
                    }
                    chars.push(c);
                    p = unsafe { p.add(1) };
                }
                let prop_id = String::from_utf16_lossy(&chars);
                matched =
                    prop_id == aumid || family.as_deref().is_some_and(|f| prop_id.starts_with(f));
            }
        }
        if !matched {
            matched = stem
                .as_deref()
                .is_some_and(|s| variants.iter().any(|v| v == s));
        }
        if !matched {
            continue;
        }

        // 曲目标题匹配优先单独收集（Z 序在前者优先）。
        if needle.as_deref().is_some_and(|n| {
            // SAFETY: 只读。
            let wt = unsafe { window_title(hwnd) };
            !wt.is_empty() && wt.to_lowercase().contains(n)
        }) {
            title_hits.push(hwnd);
        } else {
            hits.push(hwnd);
        }
    }

    let winner = title_hits
        .into_iter()
        .next()
        .or_else(|| hits.into_iter().next());
    let Some(hwnd) = winner else {
        return false;
    };

    // 最小化先还原，再拉前台（从我们的窗口点击发起时本进程是前台进程，
    // SetForegroundWindow 的焦点窃取限制通常不生效）。
    // SAFETY: 窗口管理调用。
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd).as_bool()
    }
}

#[cfg(test)]
mod playback_tests {
    //! 位置插值守卫：不写 LastUpdatedTime 的播放器（网易云）不得把整个
    //! FILETIME 当偏移加进进度（回归 "223914975:34" 显示）。
    use super::*;

    const DAY_100NS: i64 = 86_400 * 10_000_000;

    #[test]
    fn interpolates_when_timestamp_plausible() {
        // LastUpdatedTime 比 now 旧 5s：真实位置 = 采样值 + 5。
        let pos = interpolated_position_secs(
            120.0,
            1_000_000_000_000,
            1_000_000_000_000 + 5 * 10_000_000,
        );
        assert!((pos - 125.0).abs() < 1e-9);
        // 零偏移（恰在采样时刻）保持采样值。
        let pos = interpolated_position_secs(120.0, 1_000_000_000_000, 1_000_000_000_000);
        assert!((pos - 120.0).abs() < 1e-9);
    }

    #[test]
    fn missing_timestamp_returns_raw_position() {
        // LastUpdatedTime = 0：直接退回采样值，绝不能加 FILETIME。
        let pos = interpolated_position_secs(120.0, 0, 13_434_898_534 * 10_000_000);
        assert_eq!(pos, 120.0);
    }

    #[test]
    fn absurd_delta_falls_back_to_raw() {
        // 时间戳在未来（负偏移）或偏移超过一天：视为不可信，退回采样值。
        let future = interpolated_position_secs(120.0, 2_000_000_000_000, 1_000_000_000_000);
        assert_eq!(future, 120.0);
        let stale =
            interpolated_position_secs(120.0, 1_000_000_000_000, 1_000_000_000_000 + DAY_100NS + 1);
        assert_eq!(stale, 120.0);
    }

    #[test]
    fn stale_sample_floors_to_expected_advance() {
        // 网易云回跳回归：采样值播放期间不推进（恒为开播值），校准拍必须
        // 取「锚点 + 预期推进」，绝不回拽。
        assert_eq!(floored_position(30.0, 5.0, 30.0), 35.0);
        assert_eq!(floored_position(30.0, 12.5, 0.0), 42.5);
    }

    #[test]
    fn fresh_sample_wins_over_expected() {
        // 播放器自更采样且略快于锚点推进：采信采样值（含 jitter 容差）。
        assert_eq!(floored_position(30.0, 5.0, 35.4), 35.4);
        // 恰好相等：两者等价。
        assert_eq!(floored_position(30.0, 5.0, 35.0), 35.0);
    }
}

#[cfg(test)]
mod palette_tests {
    //! §4.3 媒体封面取色：合成 PNG 走完整链路（解码 → palette.rs 量化 →
    //! 媒体端三色映射），锁定色相域 / 回退 / 去抖缓存语义。
    use super::*;

    fn solid_png(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([rgb[0], rgb[1], rgb[2], 255]));
        let mut cur = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut cur, image::ImageFormat::Png)
            .expect("encode png");
        cur.into_inner()
    }

    fn oklch_of_hex(hex: &str) -> (f64, f64, f64) {
        let s = hex.trim_start_matches('#');
        let r = u8::from_str_radix(&s[0..2], 16).unwrap();
        let g = u8::from_str_radix(&s[2..4], 16).unwrap();
        let b = u8::from_str_radix(&s[4..6], 16).unwrap();
        let lab = crate::palette::rgb_to_oklab(crate::palette::Rgb8 { r, g, b });
        (lab.l, lab.chroma(), lab.hue_deg())
    }

    fn valid_hexes(p: &MediaPalette) {
        for c in [&p.primary, &p.on_primary, &p.track] {
            assert_eq!(c.len(), 7, "{c}");
            assert!(c.starts_with('#'), "{c}");
        }
    }

    #[test]
    fn saturated_cover_yields_hue_matched_palette() {
        let png = solid_png(300, 300, [20, 60, 235]); // 饱和蓝
        let p = media_palette_for("T", "A", "AL", Some(&png));
        valid_hexes(&p);
        let (l, _c, h) = oklch_of_hex(&p.primary);
        assert!(
            (220.0..=300.0).contains(&h),
            "primary hue {h:.1} 应在蓝色域"
        );
        assert!(
            (0.60..=0.80).contains(&l),
            "primary L 应被钳进 0.62–0.78 附近: {l:.2}"
        );
        // track 比 primary 暗（进度轨道是低饱和深色）。
        let (tl, tc, _) = oklch_of_hex(&p.track);
        assert!(tl < l, "track L {tl:.2} 应暗于 primary {l:.2}");
        assert!(tc < 0.10, "track 彩度应低: {tc:.3}");
        // 前景必为近黑/白之一。
        assert!(p.on_primary == "#ffffff" || p.on_primary == "#101418");
    }

    #[test]
    fn red_cover_hue_domain() {
        let p = media_palette_for("T", "A", "AL", Some(&solid_png(120, 120, [205, 40, 35])));
        let (_, _, h) = oklch_of_hex(&p.primary);
        assert!((10.0..=45.0).contains(&h), "hue {h:.1}");
    }

    #[test]
    fn gray_cover_falls_back_to_skyblue() {
        // 纯灰封面无有效候选 → 回退色板（#88d0ec 派生）。
        let p = media_palette_for("T", "A", "AL", Some(&solid_png(100, 100, [128, 128, 128])));
        let (l, _, h) = oklch_of_hex(&p.primary);
        assert!((180.0..=280.0).contains(&h), "hue {h:.1} 应为回退天蓝");
        assert!((0.60..=0.80).contains(&l), "L {l:.2}");
    }

    #[test]
    fn no_artwork_decodes_to_fallback_and_cache_dedupes() {
        let a = media_palette_for("T1", "A", "AL", None);
        let (l, _, h) = oklch_of_hex(&a.primary);
        assert!((180.0..=280.0).contains(&h) && (0.60..=0.80).contains(&l));
        // 同参数再次取色：命中缓存，值一致。
        let b = media_palette_for("T1", "A", "AL", None);
        assert_eq!(a, b);
        // 垃圾字节（解码失败）同样回退，不 panic。
        let c = media_palette_for("T2", "A", "AL", Some(&[0x89, b'P', b'N', b'G', 0x00]));
        assert_eq!(c, a, "解码失败与无封面同走回退色板");
    }

    #[test]
    fn different_covers_may_yield_different_palettes() {
        let blue = media_palette_for("TB", "A", "AL", Some(&solid_png(80, 80, [30, 100, 230])));
        let yellow = media_palette_for("TY", "A", "AL", Some(&solid_png(80, 80, [235, 200, 40])));
        assert_ne!(blue.primary, yellow.primary);
    }
}
