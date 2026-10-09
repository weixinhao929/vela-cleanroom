//! 音频端点事件。
//!
//! 两条职责：
//!
//! 1. **系统音量变化 → `osd:volume` 事件**：订阅默认输出端点的
//!    IAudioEndpointVolume 回调（键盘音量键 / 其它软件调音量 / 静音切换都会
//! 触发），前端灵动岛据此弹「音量」接管条——补齐 只覆盖应用内调整
//!    的缺口（硬件音量键是最高频场景）。本应用自己的 per-app 会话音量
//!    （ISimpleAudioVolume）不触发端点回调，天然无回环。
//! 2. **默认输出设备 epoch**：`OnDefaultDeviceChanged(eRender)` 时递增全局
//!    序号。同类工具 的关键发现：切换默认设备后旧设备的 Loopback 流**还活着、
//!    还在送静音帧**，「流是否健康」永远发现不了切换——必须主动比对/监听
//!    默认端点。audio.rs 的频谱采集线程每帧核对 epoch（一次 AtomicU64
//!    load，近零开销），不一致即重开采集源。
//!
//! epoch 用递增序号而不是 bool 标记：让「读取序号 → 重订阅 → 记录已处理」
//! 之间的竞态不会吞掉变更——中途再来的通知会把序号推得更高，下一轮自然
//! 还会重订阅。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

/// 事件名：系统音量变化（载荷 VolumeChangedPayload）。
pub const EVENT_VOLUME: &str = "osd:volume";

/// 默认输出设备「可能变了」的代数序号：每次 eRender 默认端点变更 +1。
static DEFAULT_RENDER_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 默认**采集**设备（麦克风）的同款序号：audio.rs 的 microphone/both 模式
/// 逐帧比对。与播放侧同一结论——切默认设备后旧 Capture 流还活着、还在送
/// 静音帧，drain 不报错，频谱只会永远归零，必须主动发现。
static DEFAULT_CAPTURE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 音量事件的最小发射间隔：拖动音量滑条会连发回调，节流到 ~20/s。
const VOLUME_EMIT_MIN_GAP: Duration = Duration::from_millis(50);

pub fn default_render_epoch() -> u64 {
    DEFAULT_RENDER_EPOCH.load(Ordering::Acquire)
}

/// 默认采集端点（麦克风）的变更序号，语义同 [`default_render_epoch`]。
pub fn default_capture_epoch() -> u64 {
    DEFAULT_CAPTURE_EPOCH.load(Ordering::Acquire)
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeChangedPayload {
    /// 0.0 – 1.0。
    pub level: f32,
    pub muted: bool,
}

#[cfg(windows)]
mod win {
    use super::*;

    use windows::core::implement;
    use windows::core::{Interface, Result, PCWSTR};
    use windows::Win32::Foundation::{PROPERTYKEY, RPC_E_CHANGED_MODE};
    use windows::Win32::Media::Audio::Endpoints::{
        IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
    };
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
        IMMNotificationClient_Impl, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA,
        DEVICE_STATE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// 回调侧持有的 AppHandle（同一时刻只有一份订阅，模块级 OnceLock 即可）。
    static APP: OnceLock<AppHandle> = OnceLock::new();

    fn set_app_handle(app: AppHandle) {
        let _ = APP.set(app);
    }

    fn stored_app() -> Option<&'static AppHandle> {
        APP.get()
    }

    /// 默认渲染端点的设备 id（CoTaskMemFree 语义的 wstring）：兜底探测比对用。
    fn default_render_id(enumerator: &IMMDeviceEnumerator) -> Option<String> {
        unsafe {
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let pw = device.GetId().ok()?;
            let mut len = 0usize;
            while *pw.0.add(len) != 0 {
                len += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(pw.0, len));
            windows::Win32::System::Com::CoTaskMemFree(Some(pw.0.cast()));
            Some(s)
        }
    }

    /// 默认渲染端点变更通知：只推进 epoch（真去重订阅交给主循环比对序号）。
    #[implement(IMMNotificationClient)]
    struct DeviceNotifier;

    impl IMMNotificationClient_Impl for DeviceNotifier_Impl {
        fn OnDeviceStateChanged(&self, _deviceid: &PCWSTR, _newstate: DEVICE_STATE) -> Result<()> {
            Ok(())
        }
        fn OnDeviceAdded(&self, _deviceid: &PCWSTR) -> Result<()> {
            Ok(())
        }
        fn OnDeviceRemoved(&self, _deviceid: &PCWSTR) -> Result<()> {
            // 设备拔掉不直接动 epoch：默认端点若被系统切走，OnDefaultDeviceChanged
            // 会另行通知；这里贸然 +1 只会在「拔的是非默认设备」时白折腾一次重订阅。
            Ok(())
        }
        fn OnDefaultDeviceChanged(
            &self,
            flow: EDataFlow,
            _role: ERole,
            _defaultdeviceid: &PCWSTR,
        ) -> Result<()> {
            // 输出/采集两个方向各自推进序号；role 不筛（只改通信设备时默认端点
            // 其实没动，交给主循环真比对一次再决定，避免无谓打断订阅）。
            if flow == eRender {
                DEFAULT_RENDER_EPOCH.fetch_add(1, Ordering::AcqRel);
            } else if flow == eCapture {
                DEFAULT_CAPTURE_EPOCH.fetch_add(1, Ordering::AcqRel);
            }
            Ok(())
        }
        fn OnPropertyValueChanged(&self, _deviceid: &PCWSTR, _key: &PROPERTYKEY) -> Result<()> {
            Ok(())
        }
    }

    /// 端点音量回调：只把最新帧交给发射闸（改造：纯 leading 节流会丢尾帧
    /// ——拖音量滑条松手后 OSD 停在中间值；且 SystemTime 回拨会让
    /// saturating_sub 恒 0、发射被长时间压制）。发射节奏由 volume_emit_loop
    /// 统一把控：leading 立即发 + 间隙结束补发最新帧（trailing），时钟用
    /// Instant（单调，不受系统时间回拨影响）。
    #[implement(IAudioEndpointVolumeCallback)]
    struct VolumeNotify;

    struct VolumeGate {
        pending: Option<VolumeChangedPayload>,
        last_emit: Option<Instant>,
    }
    static VOLUME_GATE: Mutex<VolumeGate> = Mutex::new(VolumeGate {
        pending: None,
        last_emit: None,
    });
    static VOLUME_GATE_CV: Condvar = Condvar::new();

    impl IAudioEndpointVolumeCallback_Impl for VolumeNotify_Impl {
        fn OnNotify(&self, notify: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
            if notify.is_null() {
                return Ok(());
            }
            let data = unsafe { &*notify };
            let payload = VolumeChangedPayload {
                level: data.fMasterVolume.clamp(0.0, 1.0),
                muted: data.bMuted.as_bool(),
            };
            let mut g = VOLUME_GATE.lock().unwrap_or_else(|p| p.into_inner());
            g.pending = Some(payload); // 只留最新帧：间隙内的中间帧本来就无需逐帧发出
            drop(g);
            VOLUME_GATE_CV.notify_all();
            Ok(())
        }
    }

    /// 音量帧发射线程（start_audio_endpoint_watcher 拉起，后位于重试
    /// 循环之外）：pending 有帧且距上次发射 ≥ 间隙就发（leading），否则等到
    /// 点补发最新帧（trailing）；无帧时挂起等回调唤醒。emit 在锁外执行。
    pub(super) fn volume_emit_loop() {
        loop {
            let frame;
            {
                let mut g = VOLUME_GATE.lock().unwrap_or_else(|p| p.into_inner());
                loop {
                    let Some(f) = g.pending else {
                        g = VOLUME_GATE_CV.wait(g).unwrap_or_else(|p| p.into_inner());
                        continue;
                    };
                    match g.last_emit.map(|t| t.elapsed()) {
                        Some(elapsed) if elapsed < VOLUME_EMIT_MIN_GAP => {
                            let (ng, _) = VOLUME_GATE_CV
                                .wait_timeout(g, VOLUME_EMIT_MIN_GAP - elapsed)
                                .unwrap_or_else(|p| p.into_inner());
                            g = ng;
                        }
                        _ => {
                            g.pending = None;
                            g.last_emit = Some(Instant::now());
                            frame = f;
                            break;
                        }
                    }
                }
            }
            if let Some(app) = stored_app() {
                use tauri::Emitter;
                let _ = app.emit_filter(super::EVENT_VOLUME, frame, |win| match win {
                    tauri::EventTarget::WebviewWindow { label }
                    | tauri::EventTarget::Webview { label }
                    | tauri::EventTarget::Window { label }
                    | tauri::EventTarget::AnyLabel { label } => {
                        label == "settings" || label.starts_with("widget-")
                    }
                    _ => false,
                });
            }
        }
    }

    /// 订阅期持有的对象集：detach 时先反注册再放引用。
    struct VolumeSubscription {
        endpoint: IAudioEndpointVolume,
        callback: IAudioEndpointVolumeCallback,
    }

    impl VolumeSubscription {
        fn detach(self) {
            unsafe {
                let _ = self.endpoint.UnregisterControlChangeNotify(&self.callback);
            }
            // 字段随 self 的 drop 自然 Release——先反注册再放引用，顺序不可反。
        }
    }

    fn subscribe_volume(enumerator: &IMMDeviceEnumerator) -> Option<(VolumeSubscription, String)> {
        unsafe {
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let id = default_render_id(enumerator)?;
            let endpoint: IAudioEndpointVolume = device.cast().ok()?;
            let callback: IAudioEndpointVolumeCallback = VolumeNotify.into();
            endpoint.RegisterControlChangeNotify(&callback).ok()?;
            Some((VolumeSubscription { endpoint, callback }, id))
        }
    }

    // std::result::Result 显式路径：mod win 内 `Result` 被 windows::core 的
    // 单参别名遮蔽。
    pub fn watcher_loop(app: AppHandle) -> std::result::Result<(), String> {
        set_app_handle(app.clone());

        // 音量帧发射线程的 spawn 已上移到 start_audio_endpoint_watcher
        // （重试循环之外）——watcher_loop 每次被 panic 重入都会重新 spawn 一条
        // 无退出条件的 volume_emit_loop，N 次 panic 累积 N 条常驻线程；发射
        // 线程消费的是静态 VOLUME_GATE，不依赖本函数任何局部状态，一次即够。

        // RUST-1：两条早退路径改返回 Err（由外层 循环退避重试）——此前
        // 正常 return 会绕过重试：Windows Audio / AudioEndpointBuilder 服务
        // 崩溃自动重启、声卡驱动安装期间 COM 类创建短暂失败是现实可达的
        // 瞬态，一旦命中，音量键 OSD 与默认设备变更 epoch 静默失效直到应用
        // 重启。panic 重入的 notifier 注册随 enumerator（局部变量）在 unwind
        // 中被 COM 释放而拆解，不累积。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return Err(format!("COM init failed: {}", hr.0));
        }
        struct ComGuard(bool);
        impl Drop for ComGuard {
            fn drop(&mut self) {
                if self.0 {
                    unsafe { CoUninitialize() };
                }
            }
        }
        let _com = ComGuard(hr.is_ok());

        let enumerator: IMMDeviceEnumerator =
            match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
                Ok(e) => e,
                Err(e) => return Err(format!("MMDeviceEnumerator unavailable: {e}")),
            };

        let notifier: IMMNotificationClient = DeviceNotifier.into();
        if let Err(e) = unsafe { enumerator.RegisterEndpointNotificationCallback(&notifier) } {
            // 拿不到默认设备变更通知：epoch 恒为 0，下面 10s 兜底轮询仍能发现切换。
            log::warn!("audio_events: RegisterEndpointNotificationCallback failed: {e}");
        }

        let mut subscription: Option<(VolumeSubscription, String)> = None;
        let mut subscribed_epoch = u64::MAX;
        // 兜底轮询：默认设备变更通知收不到时（订阅失败/驱动不上报），每 10s
        // 主动复核一次。：复核改为
        // 比对默认端点 id，真换了才重订——此前到点无条件 detach+resubscribe，
        // 每 10s 制造一个事件死窗与一轮 COM 对象 churn。
        let probe_every = Duration::from_secs(10);
        let mut next_probe = Instant::now();

        loop {
            let epoch = DEFAULT_RENDER_EPOCH.load(Ordering::Acquire);
            let probe_due = Instant::now() >= next_probe;
            if probe_due {
                next_probe = Instant::now() + probe_every;
            }
            let need_resub = if subscription.is_none() || epoch != subscribed_epoch {
                true
            } else if probe_due {
                // 只在「确知默认端点变了」时重订：探测读不到（COM 瞬断等）就
                // 保持现有订阅，不折腾。
                match default_render_id(&enumerator) {
                    Some(cur) => subscription.as_ref().is_none_or(|(_, id)| *id != cur),
                    None => false,
                }
            } else {
                false
            };
            if need_resub {
                // 先退订旧端点再重订阅：旧回调不摘会在已消失的端点上留一份订阅。
                if let Some((sub, _)) = subscription.take() {
                    sub.detach();
                }
                match subscribe_volume(&enumerator) {
                    Some((sub, id)) => {
                        subscription = Some((sub, id));
                        subscribed_epoch = DEFAULT_RENDER_EPOCH.load(Ordering::Acquire);
                    }
                    None => {
                        // 无输出设备 / 端点失效：短暂退避后重试。
                        subscribed_epoch = u64::MAX;
                        std::thread::sleep(Duration::from_secs(2));
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

pub fn start_audio_endpoint_watcher(app: AppHandle) {
    std::thread::Builder::new()
        .name("audio-endpoint-events".into())
        .spawn(move || {
            // 音量帧发射线程（节奏闸，见 VolumeNotify 注释）。：spawn
            // 置于重试循环之外——进程内单例（消费静态 VOLUME_GATE），watcher
            // 反复 panic 重入也不累积。
            #[cfg(windows)]
            {
                std::thread::Builder::new()
                    .name("audio-volume-emit".into())
                    .spawn(win::volume_emit_loop)
                    .map_err(|e| {
                        log::error!("audio_events: failed to spawn volume emit thread: {e}")
                    })
                    .ok();
            }

            // watcher_loop 含 COM 调用，panic 会静默带走线程（音量键 OSD
            // 永久失效且无看门狗）。套 media.rs 同款 catch_unwind + 退避重试。
            let mut backoff_secs = 5u64;
            loop {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    #[cfg(windows)]
                    {
                        win::watcher_loop(app.clone())
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = &app;
                        Ok::<(), String>(())
                    }
                }));
                // RUST-1：Err（COM init / 枚举器创建失败的瞬态早退）与 panic
                // 同样进退避重试；Ok(()) 才是「主循环正常退出」的终态。
                match result {
                    Ok(Ok(())) => return,
                    Ok(Err(e)) => {
                        log::warn!("audio_events: watcher error: {e}; retry in {backoff_secs}s")
                    }
                    Err(_) => {
                        log::error!(
                            "audio_events: watcher loop panicked, retrying in {backoff_secs}s"
                        )
                    }
                }
                std::thread::sleep(Duration::from_secs(backoff_secs));
                backoff_secs = (backoff_secs * 2).min(60);
            }
        })
        // spawn 失败此前被 .ok() 静默吞掉——线程资源耗尽时音量键 OSD/
        // 设备切换事件永久失效且无痕。至少留一条 error 日志。
        .map_err(|e| log::error!("audio_events: failed to spawn watcher thread: {e}"))
        .ok();
}
