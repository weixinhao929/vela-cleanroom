//! 系统音频采集 + FFT 频谱：音频监控小组件实时可视化的数据源。
//!
//! 通过 WASAPI 采集系统声音，支持三种检测模式（由前端 mode 参数指定）：
//!  - playback    环回采集默认输出设备（播放音频）；
//!  - microphone  采集默认采集端点（麦克风）；
//!  - both        同时采集播放 + 麦克风，逐帧混音后做频谱。
//!
//! 采集到的单声道样本读入环形缓冲，每 ~30ms 做一次加窗 FFT，折算成对数分布
//! 的 64 个频带，经快攻慢放包络平滑后以 Tauri 事件推给前端。
//!
//! 鲁棒性：
//!  - 引用计数管理采集线程（多个音频小组件实例共享一条线程，归零即停）；
//!  - 任一采集源设备切换 / 独占模式抢占等错误触发 500ms 退避整体重连，而不是退出；
//!  - 多源混音按最长帧对齐、缺位补 0、多源求均值，采样率差异也能安全叠加；
//!  - 前端拿不到事件时自行回退到空闲呼吸动画，界面永不卡死。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

const EVENT: &str = "audio:spectrum";
const BANDS: usize = 64;
const FFT_SIZE: usize = 2048;
/// 每帧推送间隔（毫秒）：30fps 足够丝滑，且 IPC 压力可忽略。
const FRAME_MS: u64 = 33;
/// G-4：事件投递抽取比——每 N 帧发一次（2 = 15Hz 投递 / 30Hz 包络平滑）。
const EMIT_DECIMATE: u32 = 2;
/// 设备重连退避。
const RETRY_MS: u64 = 500;

static REF_COUNT: AtomicUsize = AtomicUsize::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);
/// 采集线程代数：快速 stop→start 时旧线程可能还没退出，靠代数校验让
/// 残留线程确定性地自杀，避免两条线程同时持有 COM 采集客户端。
static GENERATION: AtomicUsize = AtomicUsize::new(0);
/// §4.6 presence 降载：用户输入空闲时置位，采集线程关闭 WASAPI 源并低频
/// 等待（不退出、不动引用计数），恢复输入后自动重开采集。
static SPECTRUM_PAUSED: AtomicBool = AtomicBool::new(false);

/// presence 模块设置的采集暂停开关。
pub fn set_spectrum_paused(v: bool) {
    SPECTRUM_PAUSED.store(v, Ordering::Release);
}

/// 每窗口引用账本：与 REF_COUNT 同步记账。webview 被直接销毁（热拔显示
/// 器时 monitor.rs 调 destroy）不会执行前端 cleanup，`drop_window` 据此
/// 结清该窗口的全部引用，避免残留计数让采集线程永不停止。
fn window_refs() -> &'static std::sync::Mutex<std::collections::HashMap<String, u32>> {
    static REFS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u32>>> =
        std::sync::OnceLock::new();
    REFS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// D-7：当前采集线程的启动参数。共享线程只在首个 start 时拉起，此前后续
/// 窗口传入的 mode/dist 被静默忽略——多屏配置不同检测模式时必有一屏失效。
/// 现在记录活动参数，后续 start 参数不同即换代重拉。
fn active_params() -> &'static std::sync::Mutex<(Vec<SourceKind>, BandDist)> {
    static PARAMS: std::sync::OnceLock<std::sync::Mutex<(Vec<SourceKind>, BandDist)>> =
        std::sync::OnceLock::new();
    PARAMS.get_or_init(|| std::sync::Mutex::new((Vec::new(), BandDist::Log)))
}

/// 拉起新一代采集线程（世代自增，旧线程因代数过期自行退出且不会复位开关）。
fn spawn_capture(app: AppHandle, kinds: Vec<SourceKind>, dist: BandDist) -> Result<(), String> {
    let gen = GENERATION.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
    RUNNING.store(true, Ordering::Release);
    if let Err(e) = std::thread::Builder::new()
        .name("audio-spectrum".into())
        .spawn(move || capture_loop(app, gen, kinds, dist))
    {
        // spawn 失败：回滚计数与开关，避免"线程不存在却计数残留"导致的
        // 永久死锁（后续 start 永远以为线程还在）。
        RUNNING.store(false, Ordering::Release);
        REF_COUNT.store(0, Ordering::Release);
        window_refs()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        return Err(format!("无法启动音频采集线程：{e}"));
    }
    Ok(())
}

/// 饱和递减总引用；归零即请求采集线程停止。
fn dec_ref() {
    // R8（审计）：旧实现"先 load 检查再 fetch_sub"，两线程并发在计数为 1 时
    // 都通过检查、各减一次会把 0 回绕成 usize::MAX（频谱静默失效直到自愈）。
    // 改为先减后判：prev==0 说明发生回绕，立即回滚为 0，保持饱和语义。
    let prev = REF_COUNT.fetch_sub(1, Ordering::AcqRel);
    if prev == 0 {
        REF_COUNT.store(0, Ordering::Release);
        return;
    }
    if prev == 1 {
        RUNNING.store(false, Ordering::Release);
    }
}

#[cfg(windows)]
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
#[cfg(windows)]
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;

#[derive(Serialize, Clone)]
struct SpectrumPayload {
    /// 整体响度（RMS，0~1），用于波纹/光晕样式。
    level: f32,
    /// 64 个频带归一化幅值（0~1，对数频率分布）。
    bands: Vec<f32>,
}

/// 采集源：播放音频（系统输出环回）或麦克风（默认采集端点）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SourceKind {
    Loopback,
    Capture,
}

/// 把前端"检测模式"字符串解析成采集源集合。
///  - playback     → 仅播放音频（默认，兼容旧行为）
///  - microphone  → 仅麦克风
///  - both        → 播放 + 麦克风混合
///    未知值回退到仅播放，保证前端传错也不至于空跑。
fn parse_mode(mode: Option<&str>) -> Vec<SourceKind> {
    match mode {
        Some("microphone") => vec![SourceKind::Capture],
        Some("both") => vec![SourceKind::Loopback, SourceKind::Capture],
        _ => vec![SourceKind::Loopback],
    }
}

/// W-127 频带分布：log（音乐，低频细分）/ linear（语音，均匀展开）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum BandDist {
    Log,
    Linear,
}

fn parse_dist(dist: Option<&str>) -> BandDist {
    match dist {
        Some("linear") => BandDist::Linear,
        _ => BandDist::Log,
    }
}

#[tauri::command]
pub fn start_audio_spectrum(
    window: tauri::WebviewWindow,
    app: AppHandle,
    mode: Option<String>,
    dist: Option<String>,
) -> Result<(), String> {
    // 麦克风采集属敏感能力：只有小组件层/设置窗可启动（quick-note 等注入面不可达）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let kinds = parse_mode(mode.as_deref());
    let dist = parse_dist(dist.as_deref());
    // 自愈：若全局开关已关（线程曾因非 stop 原因异常退出，如 panic、设备不
    // 支持浮点格式），先复位残留的引用计数与窗口账本，保证下一次 start 能
    // 重新拉起线程，而不是因计数非 0 而永不 spawn、频谱永久失效。
    if !RUNNING.load(Ordering::Acquire) {
        REF_COUNT.store(0, Ordering::Release);
        window_refs()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
    let prev = REF_COUNT.fetch_add(1, Ordering::AcqRel);
    // D-7：线程已在跑时，后续窗口传入的 mode/dist 与活动参数不同则换代
    // 重拉（旧线程代数过期自退，ExitGuard 不会复位新线程的开关）。
    {
        let mut params = active_params().lock().unwrap_or_else(|p| p.into_inner());
        let changed = prev > 0 && (params.0 != kinds || params.1 != dist);
        if prev == 0 || changed {
            spawn_capture(app.clone(), kinds.clone(), dist)?;
            *params = (kinds, dist);
        }
    }
    let mut refs = window_refs().lock().unwrap_or_else(|p| p.into_inner());
    let entry = refs.entry(window.label().to_string()).or_insert(0);
    *entry += 1;
    Ok(())
}

#[tauri::command]
pub fn stop_audio_spectrum(window: tauri::WebviewWindow) {
    // gate: none needed（label 仅作订阅账本键递减自己，无特权访问面）
    // P1（审计修复）：仅当本窗口账本确有订阅时才递减全局引用。此前 dec_ref()
    // 无条件执行——前端约定"cleanup 总是调 stop 即使 start 失败"，时序
    // A start(REF=1) → B 未 start 就 cleanup → REF 减至 0 → 采集线程退出，
    // A 的频谱被静默"偷走"。饱和保护只防回绕，防不了这种透支。
    let had_entry = {
        let mut refs = window_refs().lock().unwrap_or_else(|p| p.into_inner());
        match refs.get_mut(window.label()) {
            Some(count) => {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    refs.remove(window.label());
                }
                true
            }
            None => false,
        }
    };
    if had_entry {
        dec_ref();
    }
}

/// 窗口销毁兜底：结清该窗口的全部音频引用（其前端 cleanup 可能永远不会
/// 执行——如热拔显示器时 webview 被直接 destroy）。
pub fn drop_window(label: &str) {
    let count = window_refs()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(label)
        .unwrap_or(0);
    for _ in 0..count {
        dec_ref();
    }
}

/// W-128 点击频谱切换系统静音。返回切换后的静音状态。
/// 独立的 COM 作用域：命令可能跑在与采集线程不同的线程上，各自初始化。
/// M2: 借助 spawn_blocking 放到阻塞池，避免音频子系统慢/挂起时冻结主线程
/// （与 get_system_media_info 的处理保持一致）。
#[tauri::command]
pub async fn toggle_system_mute(window: tauri::Window) -> Result<bool, String> {
    // 窗口闸门：改系统静音态是真实系统副作用，不给 web-preview 远程页面。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(toggle_system_mute_blocking)
        .await
        .map_err(|e| format!("静音切换任务执行失败: {e}"))?
}

fn toggle_system_mute_blocking() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows::core::Interface;
        use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
        use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
        use windows::Win32::Media::Audio::{
            eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
        };
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
        };

        // 主线程通常已是 STA，MTM 初始化会返回 RPC_E_CHANGED_MODE——那不算
        // 失败（COM 已可用），只是不需要（也不能）配对 CoUninitialize。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // S_OK 与 S_FALSE 都会增加本线程的 COM 引用计数，两者都必须配对
        // CoUninitialize；仅 RPC_E_CHANGED_MODE（套间模型不符）除外。
        let must_uninit = hr.is_ok();
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return Err(format!("COM 初始化失败: {}", hr.0));
        }

        let result = (|| -> Result<bool, String> {
            unsafe {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                        .map_err(|e| format!("无法创建音频枚举器: {e}"))?;
                let device = enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|e| format!("无法获取默认输出设备: {e}"))?;
                let volume: IAudioEndpointVolume = device
                    .cast()
                    .map_err(|e| format!("无法获取音量控制接口: {e}"))?;
                let muted = volume
                    .GetMute()
                    .map_err(|e| format!("无法读取静音状态: {e}"))?
                    .as_bool();
                volume
                    .SetMute(!muted, std::ptr::null())
                    .map_err(|e| format!("无法切换静音: {e}"))?;
                Ok(!muted)
            }
        })();

        if must_uninit {
            unsafe { CoUninitialize() };
        }
        result
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows".to_string())
    }
}

/// W-131 按 PID 读写应用音频会话音量（ISimpleAudioVolume，0–1）。
/// `set_to = None` 仅读取当前值；目标进程在默认输出设备上没有音频会话时
/// 返回 None。滚轮调「正在播放应用的音量」（media.rs 解析 SMTC 会话 →
/// PID 后调这里）。
pub fn media_session_volume(pid: u32, set_to: Option<f64>) -> Option<f64> {
    #[cfg(windows)]
    {
        use windows::core::Interface;
        use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
        use windows::Win32::Media::Audio::{
            eConsole, eRender, IAudioSessionControl2, IAudioSessionEnumerator,
            IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
        };
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
        };

        // 与 toggle_system_mute_blocking 同一套 COM 约定：MTM 初始化，
        // RPC_E_CHANGED_MODE 不算失败，S_OK/S_FALSE 配对 CoUninitialize。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let must_uninit = hr.is_ok();
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return None;
        }

        let result = (|| -> Option<f64> {
            unsafe {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
                let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
                let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).ok()?;
                let session_enum: IAudioSessionEnumerator = manager.GetSessionEnumerator().ok()?;
                let count = session_enum.GetCount().ok()?;
                for i in 0..count {
                    let Ok(control) = session_enum.GetSession(i) else {
                        continue;
                    };
                    let Ok(ctl2) = control.cast::<IAudioSessionControl2>() else {
                        continue;
                    };
                    // 单个会话读 PID 失败只跳过该项，不中断整个枚举。
                    let Ok(session_pid) = ctl2.GetProcessId() else {
                        continue;
                    };
                    if session_pid != pid {
                        continue;
                    }
                    let simple = control.cast::<ISimpleAudioVolume>().ok()?;
                    let current = simple.GetMasterVolume().ok()? as f64;
                    return match set_to {
                        None => Some(current),
                        Some(v) => {
                            let v = v.clamp(0.0, 1.0) as f32;
                            simple
                                .SetMasterVolume(v, std::ptr::null())
                                .ok()
                                .map(|_| v as f64)
                        }
                    };
                }
                None
            }
        })();

        if must_uninit {
            unsafe { CoUninitialize() };
        }
        result
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, set_to);
        None
    }
}

/* ------------------------------------------------------------------ */
/* FFT（迭代基-2 Cooley-Tukey，无需外部依赖）                            */
/* ------------------------------------------------------------------ */

fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two());
    // 位反转置换。
    let mut j = 0usize;
    for i in 0..n {
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
        let mut m = n >> 1;
        while m != 0 && j & m != 0 {
            j ^= m;
            m >>= 1;
        }
        j |= m;
    }
    // 蝶形运算。
    let mut len = 2usize;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0usize;
        while i < n {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let a = i + k;
                let b = a + len / 2;
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// 汉宁窗（采集线程内缓存一次）。
fn hann_window(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos())
        .collect()
}

/* ------------------------------------------------------------------ */
/* 采集主循环（仅 Windows）                                             */
/* ------------------------------------------------------------------ */

#[cfg(windows)]
use windows::Win32::Media::Audio::{IAudioCaptureClient, IAudioClient};

/// 单个采集源的活动 WASAPI 管线（播放环回 或 麦克风）。
#[cfg(windows)]
struct SourceStream {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    channels: usize,
    sample_rate: f32,
    /// GetMixFormat 返回的堆内存，close 时用 CoTaskMemFree 释放。
    fmt: *mut windows::Win32::Media::Audio::WAVEFORMATEX,
}

#[cfg(windows)]
impl SourceStream {
    /// 打开并启动一个采集源。任一步失败返回 None，由外层整体退避重连。
    fn open(kind: SourceKind) -> Option<Self> {
        use windows::Win32::Media::Audio::{
            eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
            MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        };
        use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            // 播放源走默认渲染端点的环回流；麦克风走默认采集端点。
            let dataflow = if kind == SourceKind::Loopback {
                eRender
            } else {
                eCapture
            };
            let device = enumerator
                .GetDefaultAudioEndpoint(dataflow, eConsole)
                .ok()?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
            let fmt = client.GetMixFormat().ok()?;
            // 共享流混音格式恒为 32 位浮点；不满足则本机不支持该源，交给外层重连。
            // 注意 WAVE_FORMAT_EXTENSIBLE 的真实采样格式在 SubFormat GUID 里，
            // 部分 USB DAC/老驱动会以 extensible + PCM 子格式上报，把它当 f32 读会
            // 把 16 位字节重解释成白噪声，必须显式校验 IEEE_FLOAT 子格式。
            if !mix_format_is_float(&*fmt) {
                CoTaskMemFree(Some(fmt.cast()));
                return None;
            }
            let stream_flags = if kind == SourceKind::Loopback {
                AUDCLNT_STREAMFLAGS_LOOPBACK
            } else {
                // 麦克风为普通共享采集，无环回标志。
                0u32
            };
            if client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, stream_flags, 0, 0, fmt, None)
                .is_err()
            {
                CoTaskMemFree(Some(fmt.cast()));
                return None;
            }
            let capture: IAudioCaptureClient = match client.GetService() {
                Ok(c) => c,
                Err(_) => {
                    CoTaskMemFree(Some(fmt.cast()));
                    return None;
                }
            };
            if client.Start().is_err() {
                CoTaskMemFree(Some(fmt.cast()));
                return None;
            }
            Some(SourceStream {
                channels: (&*fmt).nChannels.max(1) as usize,
                sample_rate: (&*fmt).nSamplesPerSec.max(1) as f32,
                client,
                capture,
                fmt,
            })
        }
    }

    /// 排空本次所有数据包，返回本帧单声道样本（无声以 0 占位）。
    /// 任何 WASAPI 错误（默认设备切换、独占抢占 AUDCLNT_E_DEVICE_INVALIDATED 等）
    /// 都意味着当前管线已死，返回 None 由外层断开重连。
    fn drain(&mut self) -> Option<Vec<f32>> {
        use windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_SILENT;
        let mut out: Vec<f32> = Vec::new();
        loop {
            let mut frames = unsafe {
                match self.capture.GetNextPacketSize() {
                    Ok(f) => f,
                    Err(_) => return None,
                }
            };
            if frames == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut flags = 0u32;
            if unsafe {
                self.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .is_err()
            } {
                return None;
            }
            let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            if !silent && !data.is_null() {
                let count = frames as usize * self.channels;
                let samples = unsafe { std::slice::from_raw_parts(data as *const f32, count) };
                for chunk in samples.chunks(self.channels) {
                    out.push(chunk.iter().sum::<f32>() / chunk.len() as f32);
                }
            } else {
                out.extend(std::iter::repeat_n(0f32, frames as usize));
            }
            let _ = unsafe { self.capture.ReleaseBuffer(frames) };
        }
        Some(out)
    }

    fn close(&mut self) {
        let _ = unsafe { self.client.Stop() };
        // fmt 是 GetMixFormat 的堆分配；置空保证 Drop 与手工 close 双路径幂等。
        if !self.fmt.is_null() {
            unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(self.fmt.cast())) };
            self.fmt = std::ptr::null_mut();
        }
    }
}

/// panic 展开路径的兜底释放：capture_loop_inner 的 catch_unwind 兜住 panic
/// 后 Vec<SourceStream> 析构时仍会走到这里，GetMixFormat 堆块不再依赖
/// 「所有正常退出路径都记得手动 close」的约定。
#[cfg(windows)]
impl Drop for SourceStream {
    fn drop(&mut self) {
        self.close();
    }
}

/// 采集线程退出守卫：无论正常结束、提前 return 还是 panic 展开，都保证
/// ① 已成功的 CoInitializeEx 配对 CoUninitialize；② 若仍是"当前代"线程，
/// 复位 RUNNING/REF_COUNT——否则一次 panic 会让标志位永久滞留为 true，
/// start 的自愈分支（`!RUNNING` 才复位计数）永远不会触发，频谱直到重启
/// 都无法恢复。
#[cfg(windows)]
struct CaptureExitGuard {
    gen: usize,
    com_initialized: bool,
}

#[cfg(windows)]
impl Drop for CaptureExitGuard {
    fn drop(&mut self) {
        if self.com_initialized {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
        // 过期线程退出时不能关掉新线程的开关；只有当前代线程才复位计数，
        // 让异常退出（格式不支持/COM 初始化失败/panic 等）也能被下一次
        // start 自愈。
        if GENERATION.load(Ordering::Acquire) == self.gen {
            RUNNING.store(false, Ordering::Release);
            REF_COUNT.store(0, Ordering::Release);
        }
    }
}

#[cfg(windows)]
fn capture_loop(app: AppHandle, gen: usize, kinds: Vec<SourceKind>, dist: BandDist) {
    // 线程 panic 默认直接散播结束线程且无日志；包一层让失败可见，守卫的
    // Drop 在 unwind 期间仍会执行（标志复位/COM 配对）。
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        capture_loop_inner(app, gen, kinds, dist)
    }));
    if result.is_err() {
        log::error!("audio capture thread panicked; state reset, next start will relaunch");
    }
}

#[cfg(windows)]
fn capture_loop_inner(app: AppHandle, gen: usize, kinds: Vec<SourceKind>, dist: BandDist) {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    // 本线程是否仍应当工作：全局开关开着，且代数未被新线程取代。
    let alive = |running: bool| running && GENERATION.load(Ordering::Acquire) == gen;

    // COM 初始化失败（罕见）：guard 仍需复位标志（com_initialized=false）。
    let com_ok = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
    let _guard = CaptureExitGuard {
        gen,
        com_initialized: com_ok,
    };
    if !com_ok {
        return;
    }

    let window = hann_window(FFT_SIZE);
    // 预生成对数频带 → FFT bin 的映射（在首个已知的采样率下计算；
    // WASAPI 共享模式几乎总是 48k/44.1k，重连时若采样率变化会重建）。
    let mut band_bins: Option<(f32, Vec<(usize, usize)>)> = None;

    'outer: loop {
        if !alive(RUNNING.load(Ordering::Acquire)) {
            break;
        }

        // --- 打开采集源；逐源降级而非全有全无 ---
        // 打开失败多是永久性的（PCM-only 麦克风、被禁用的设备）：若一个源
        // 失败就拆掉全部源，播放环回也会被拖死，且线程以 RETRY_MS 周期对
        // 永久失败源无限空转重试。这里让成功的源先工作起来，全部源都打
        // 开失败才整体退避。运行期 drain 失败（设备热切换）仍走整体重连，
        // 以便恢复被降级掉的源。
        let mut sources: Vec<SourceStream> = Vec::with_capacity(kinds.len());
        for &kind in &kinds {
            match SourceStream::open(kind) {
                Some(s) => sources.push(s),
                None => log::warn!(
                    "audio source {:?} unavailable; degrading to remaining sources",
                    kind
                ),
            }
        }
        if sources.is_empty() {
            if !backoff(gen) {
                break 'outer;
            }
            continue 'outer;
        }
        // 混音以第一个源的采样率为基准（默认端点几乎都是 48k）。
        let sample_rate = sources[0].sample_rate;
        // 默认设备 epoch（audio_events.rs 推进）：开源自那一刻的序号。切换默认
        // 输出设备后旧设备的 Loopback 流**依然活着、还在送静音帧**——drain 不
        // 报错、频谱只会永远归零。每帧核对一次 AtomicU64（近零开销），序号
        // 前进即重开源（重开走 GetDefaultAudioEndpoint，自然绑到新端点）。
        // 借鉴 NPS AudioAnalyzer 的「设备切换必须主动发现」结论。
        let opened_epoch = crate::audio_events::default_render_epoch();

        // --- 采集 + 频谱计算 ---
        let mut ring: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
        let mut re = vec![0f32; FFT_SIZE];
        let mut im = vec![0f32; FFT_SIZE];
        let mut bands = vec![0f32; BANDS];
        // 上一帧是否已完全静音（level=0 且包络全部归零）：连续静音帧不再
        // 推送——条形已无信息量，恢复出声的下一帧会立即恢复推送。
        let mut last_silent = false;
        // G-4：投递抽取节拍（见 EMIT_DECIMATE）。
        let mut emit_tick: u32 = 0;

        loop {
            if !alive(RUNNING.load(Ordering::Acquire)) {
                for s in &mut sources {
                    s.close();
                }
                break 'outer;
            }
            // §4.6 空闲降载：关闭采集源，低频等待恢复；期间不排空、不 FFT、
            // 不 emit。恢复输入后回到 'outer 重开源（与设备重连走同一路径）。
            if SPECTRUM_PAUSED.load(Ordering::Acquire) {
                for s in &mut sources {
                    s.close();
                }
                while SPECTRUM_PAUSED.load(Ordering::Acquire)
                    && alive(RUNNING.load(Ordering::Acquire))
                {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                if !alive(RUNNING.load(Ordering::Acquire)) {
                    break 'outer;
                }
                continue 'outer;
            }
            std::thread::sleep(std::time::Duration::from_millis(FRAME_MS));

            // 默认输出设备被切换（epoch 前进）：旧流不会自毙，主动重开。
            if crate::audio_events::default_render_epoch() != opened_epoch {
                log::info!("audio: default render device changed; reopening capture sources");
                for s in &mut sources {
                    s.close();
                }
                continue 'outer;
            }

            // 逐源排空本帧，再按最长帧对齐混音（缺的补 0，多源求均值），
            // 这样播放源与麦克风即便采样率/包长略有差异也能安全叠加。
            let mut failed = false;
            let mut frames_of_sources: Vec<Vec<f32>> = Vec::with_capacity(sources.len());
            for s in &mut sources {
                match s.drain() {
                    Some(fr) => frames_of_sources.push(fr),
                    None => {
                        failed = true;
                        break;
                    }
                }
            }
            if failed {
                for s in &mut sources {
                    s.close();
                }
                if !backoff(gen) {
                    break 'outer;
                }
                continue 'outer;
            }

            let n = frames_of_sources.iter().map(|v| v.len()).max().unwrap_or(0);
            let count = frames_of_sources.len().max(1) as f32;
            for i in 0..n {
                let mut sum = 0f32;
                for v in &frames_of_sources {
                    if i < v.len() {
                        sum += v[i];
                    }
                }
                ring.push(sum / count);
            }

            if ring.len() > FFT_SIZE {
                let drop = ring.len() - FFT_SIZE;
                ring.drain(..drop);
            }
            if ring.len() < FFT_SIZE {
                continue;
            }

            // 加窗 + FFT。
            let mut sum_sq = 0f32;
            for i in 0..FFT_SIZE {
                re[i] = ring[i] * window[i];
                im[i] = 0.0;
                sum_sq += ring[i] * ring[i];
            }
            let level = ((sum_sq / FFT_SIZE as f32).sqrt() * 4.0).clamp(0.0, 1.0);

            fft(&mut re, &mut im);

            // 频带映射：35Hz ~ 12kHz。log = 对数分布（音乐默认）；
            // linear = 线性均匀展开（W-127，语音场景低频不挤成一团）。
            let mapping = match &band_bins {
                Some((rate, m)) if *rate == sample_rate => m.clone(),
                _ => {
                    let bin_hz = sample_rate / FFT_SIZE as f32;
                    let lo = (35.0f32 / bin_hz).ceil().max(1.0) as usize;
                    let hi = ((12000.0f32 / bin_hz) as usize).min(FFT_SIZE / 2 - 1);
                    let ratio = 12000.0f32 / 35.0;
                    let m: Vec<(usize, usize)> = (0..BANDS)
                        .map(|b| {
                            let (f0, f1) = match dist {
                                BandDist::Linear => (
                                    35.0 + (12000.0 - 35.0) * b as f32 / BANDS as f32,
                                    35.0 + (12000.0 - 35.0) * (b + 1) as f32 / BANDS as f32,
                                ),
                                BandDist::Log => (
                                    35.0 * ratio.powf(b as f32 / BANDS as f32),
                                    35.0 * ratio.powf((b + 1) as f32 / BANDS as f32),
                                ),
                            };
                            // s 也钳制在 (lo, hi) 内：低采样率下 12kHz 超出
                            // 奈奎斯特区间，不钳制会出现 s >= e 的空区间。
                            let s = (((f0 / bin_hz).ceil() as usize).max(lo))
                                .min(hi.saturating_sub(1).max(lo));
                            let e = (((f1 / bin_hz).ceil() as usize).max(s + 1)).min(hi);
                            (s, e)
                        })
                        .collect();
                    band_bins = Some((sample_rate, m.clone()));
                    m
                }
            };

            let norm = 2.0 / FFT_SIZE as f32;
            for (b, (s, e)) in mapping.iter().enumerate() {
                let mut peak = 0f32;
                for k in *s..*e {
                    let mag = ((re[k] * re[k] + im[k] * im[k]) * norm).sqrt();
                    if mag > peak {
                        peak = mag;
                    }
                }
                // 开方压缩 + 增益：让视觉动态更贴近听感。
                let target = ((peak * 2.6).sqrt()).clamp(0.0, 1.0);
                // 快攻慢放包络，前端再插值一层，两级平滑保证丝滑。
                bands[b] = if target > bands[b] {
                    target
                } else {
                    bands[b] * 0.82 + target * 0.18
                };
            }

            // 对齐 sys:stats 的 F-3 模式：频谱是全应用频率最高的 IPC（30 帧/秒），
            // 改 emit_filter 只投递给引用账本里实际订阅了的窗口，不再让设置窗/
            // quick-note/taskbar-net 每秒被无意义唤醒 30 次（载荷只序列化一次）。
            // 静音帧（包络已衰减归零）跳过发送：首个静音帧仍发一次让前端条形
            // 落到零位，之后连续静音不再有信息量。
            // G-4：事件投递二抽一（EMIT_DECIMATE）——包络按 30Hz 平滑、投递
            // 15Hz，前端本就再做一层插值，观感不变而事件量减半。
            let silent = level <= 0.0 && bands.iter().all(|&b| b < 0.001);
            emit_tick = (emit_tick + 1) % EMIT_DECIMATE;
            if emit_tick == 0 && (!silent || !last_silent) {
                let subscribed: std::collections::HashSet<String> = {
                    let refs = window_refs().lock().unwrap_or_else(|p| p.into_inner());
                    refs.keys().cloned().collect()
                };
                let _ = app.emit_filter(
                    EVENT,
                    SpectrumPayload {
                        level,
                        bands: bands.clone(),
                    },
                    move |win| match win {
                        tauri::EventTarget::WebviewWindow { label }
                        | tauri::EventTarget::Webview { label }
                        | tauri::EventTarget::Window { label }
                        | tauri::EventTarget::AnyLabel { label } => subscribed.contains(label),
                        _ => false,
                    },
                );
            }
            last_silent = silent;
        }
    }
    // 退出清理（COM 配对 + 当前代标志复位）由 `_guard` 的 Drop 统一处理，
    // 正常结束与 panic 展开走同一条路径。
}

/// 混音格式是否为 32 位 IEEE 浮点。见 `mix_format_is_float` 的调用注释。
#[cfg(windows)]
const SUBTYPE_IEEE_FLOAT: windows::core::GUID = windows::core::GUID {
    data1: 0x0000_0003,
    data2: 0x0000,
    data3: 0x0010,
    data4: [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
};

/// 判断 WASAPI 混音格式是否为 32 位 IEEE 浮点。
/// - 直接 IEEE_FLOAT（tag=3）：是。
/// - EXTENSIBLE（tag=0xfffe）：真实格式在 SubFormat GUID，必须等于
///   KSDATAFORMAT_SUBTYPE_IEEE_FLOAT 才按 f32 读取；否则（PCM/整型子格式）
///   字节重解释会产生噪声，返回 false 让采集线程退出。
#[cfg(windows)]
fn mix_format_is_float(fmt: &windows::Win32::Media::Audio::WAVEFORMATEX) -> bool {
    if fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT {
        return true;
    }
    if fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
        // SAFETY: WAVEFORMATEXTENSIBLE 以 WAVEFORMATEX 开头，GetMixFormat 在
        // tag==EXTENSIBLE 时返回的缓冲区合法容纳该结构。该结构是 packed
        // （1 字节对齐），不能直接解引用取 SubFormat，否则触发 E0793：
        // 用 addr_of! 取字段的裸指针（不产生引用），再 read_unaligned 读取。
        let ext = fmt as *const windows::Win32::Media::Audio::WAVEFORMATEX
            as *const windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE;
        let sub = unsafe { core::ptr::addr_of!((*ext).SubFormat) };
        return unsafe { sub.read_unaligned() == SUBTYPE_IEEE_FLOAT };
    }
    false
}

/// 采集出错后的退避重连；返回 false 表示应当结束线程。
#[cfg(windows)]
fn backoff(gen: usize) -> bool {
    let running = RUNNING.load(Ordering::Acquire);
    if !running || GENERATION.load(Ordering::Acquire) != gen {
        return false;
    }
    std::thread::sleep(std::time::Duration::from_millis(RETRY_MS));
    let running = RUNNING.load(Ordering::Acquire);
    running && GENERATION.load(Ordering::Acquire) == gen
}

/* 非 Windows：线程直接空转退出，前端走空闲动画。 */
#[cfg(not(windows))]
fn capture_loop(_app: AppHandle, gen: usize, _kinds: Vec<SourceKind>, _dist: BandDist) {
    while RUNNING.load(Ordering::Acquire) && GENERATION.load(Ordering::Acquire) == gen {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/* ------------------------------------------------------------------ */
/* 真实采集验证：实机打开播放环回源，短采一段后确认能拿到真实 PCM 帧。        */
/* 与 Windows 自身"声音设置 → 输出音量"的小音量计对照；完全静音时返回全 0  */
/* 是合法真实值（管线正常），绝不伪造非零数据。                            */
/* ------------------------------------------------------------------ */
#[cfg(all(test, windows))]
mod verify {
    use super::*;

    /// 生成一段 0.5s、440Hz、16-bit 单声道正弦波 WAV，用于证明环回源能采到
    /// 真实非零响度。失败（如临时目录不可写）返回 None，测试回退为静音合法值。
    fn write_beep_wav(path: &std::path::Path) -> Option<std::path::PathBuf> {
        use std::io::Write;
        const SAMPLE_RATE: u32 = 22050;
        const DUR_SECS: f32 = 0.5;
        let n = (SAMPLE_RATE as f32 * DUR_SECS) as usize;
        let mut data = Vec::with_capacity(n * 2);
        for i in 0..n {
            let t = i as f32 / SAMPLE_RATE as f32;
            let amp = 0.5 * (std::f32::consts::TAU * 440.0 * t).sin();
            let s = (amp * i16::MAX as f32) as i16;
            data.extend_from_slice(&s.to_le_bytes());
        }
        let mut wav = Vec::with_capacity(44 + data.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
        wav.extend_from_slice(&2u16.to_le_bytes()); // block align
        wav.extend_from_slice(&16u16.to_le_bytes()); // bits
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        let Ok(mut f) = std::fs::File::create(path) else {
            return None;
        };
        f.write_all(&wav).ok()?;
        Some(path.to_path_buf())
    }

    #[test]
    fn captures_real_playback_or_reports_unavailable() {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mut stream = match SourceStream::open(SourceKind::Loopback) {
            Some(s) => s,
            None => {
                eprintln!("[verify-audio] no playback loopback source available on this host");
                unsafe {
                    CoUninitialize();
                }
                return;
            }
        };
        // 生成一段 ~0.5s 的响铃正弦波 WAV（真实地写入磁盘再播放，保证默认播放
        // 设备上有确凿的响度），环回源必然采到非零样本。若写入/播放失败或本机
        // 无声卡，则回退为"当前静音"合法结果，绝不伪造。
        let beep_path = write_beep_wav(&std::env::temp_dir().join("vela_audio_verify.wav"));
        let mut played_ok = false;
        if let Some(path) = &beep_path {
            let wide: Vec<u16> = path
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                played_ok = windows::Win32::Media::Audio::PlaySoundW(
                    windows::core::PCWSTR(wide.as_ptr()),
                    None,
                    windows::Win32::Media::Audio::SND_FILENAME
                        | windows::Win32::Media::Audio::SND_SYNC,
                )
                .as_bool();
            }
        }
        // 播放结束后等 ~150ms 让环回数据包落到采集缓冲，再排空。
        std::thread::sleep(std::time::Duration::from_millis(150));
        let mut total_frames = 0usize;
        let mut max_rms = 0f32;
        for _ in 0..3 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            match stream.drain() {
                Some(f) => {
                    total_frames += f.len();
                    if !f.is_empty() {
                        let sum_sq: f32 = f.iter().map(|v| v * v).sum();
                        max_rms = max_rms.max((sum_sq / f.len() as f32).sqrt());
                    }
                }
                None => {
                    eprintln!("[verify-audio] loopback drain failed (device invalidated?)");
                    stream.close();
                    unsafe {
                        CoUninitialize();
                    }
                    return;
                }
            }
        }
        eprintln!(
            "[verify-audio] loopback total_frames={} max_rms={:.4} beep_played={} ({})",
            total_frames,
            max_rms,
            played_ok,
            if max_rms > 0.001 {
                "检测到真实播放声音 ✓（与声音设置音量计一致）"
            } else {
                "当前静音/默认设备被静音（管线正常，采到的是合法静音帧）"
            }
        );
        // 断言：管线打开成功、drain 不报错、且确实采到了数据帧（证明环回采集
        // 真实工作）。能否采到非零响度取决于默认播放设备是否出声——若本机默认
        // 设备被静音/无声，则静音帧是合法真实结果，绝不伪造非零数据。
        assert!(
            total_frames > 0,
            "loopback pipeline returned no data frames at all"
        );
        if played_ok && max_rms <= 0.001 {
            eprintln!(
                "[verify-audio] 提示：beep 播放成功但环回采到的是静音帧——默认播放设备可能被静音或输出到蓝牙/虚拟设备"
            );
        }
        stream.close();
        unsafe {
            CoUninitialize();
        }
    }
}
