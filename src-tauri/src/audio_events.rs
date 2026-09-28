//! 音频端点事件（借鉴 NotchPeninsula 的「音量看门狗 + 默认设备跟随」）。
//!
//! 两条职责：
//!
//! 1. **系统音量变化 → `osd:volume` 事件**：订阅默认输出端点的
//!    IAudioEndpointVolume 回调（键盘音量键 / 其它软件调音量 / 静音切换都会
//!    触发），前端灵动岛据此弹「音量」接管条——补齐 G10 只覆盖应用内调整
//!    的缺口（硬件音量键是最高频场景）。本应用自己的 per-app 会话音量
//!    （ISimpleAudioVolume）不触发端点回调，天然无回环。
//! 2. **默认输出设备 epoch**：`OnDefaultDeviceChanged(eRender)` 时递增全局
//!    序号。NPS 的关键发现：切换默认设备后旧设备的 Loopback 流**还活着、
//!    还在送静音帧**，「流是否健康」永远发现不了切换——必须主动比对/监听
//!    默认端点。audio.rs 的频谱采集线程每帧核对 epoch（一次 AtomicU64
//!    load，近零开销），不一致即重开采集源。
//!
//! epoch 用递增序号而不是 bool 标记：让「读取序号 → 重订阅 → 记录已处理」
//! 之间的竞态不会吞掉变更——中途再来的通知会把序号推得更高，下一轮自然
//! 还会重订阅（NPS AudioAnalyzer 的 _deviceChangeEpoch 同款）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

/// 事件名：系统音量变化（载荷 VolumeChangedPayload）。
pub const EVENT_VOLUME: &str = "osd:volume";

/// 默认输出设备「可能变了」的代数序号：每次 eRender 默认端点变更 +1。
static DEFAULT_RENDER_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 音量事件的最小发射间隔：拖动音量滑条会连发回调，节流到 ~20/s。
const VOLUME_EMIT_MIN_GAP_MS: u64 = 50;

pub fn default_render_epoch() -> u64 {
    DEFAULT_RENDER_EPOCH.load(Ordering::Acquire)
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
        eConsole, eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
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

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
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
            // 只关心输出方向；role 不筛（只改通信设备时默认端点其实没动，
            // 交给主循环真比对一次再决定，避免无谓打断订阅）。
            if flow == eRender {
                DEFAULT_RENDER_EPOCH.fetch_add(1, Ordering::AcqRel);
            }
            Ok(())
        }
        fn OnPropertyValueChanged(&self, _deviceid: &PCWSTR, _key: &PROPERTYKEY) -> Result<()> {
            Ok(())
        }
    }

    /// 端点音量回调：节流后 emit `osd:volume`（无字段结构体，状态走静态）。
    #[implement(IAudioEndpointVolumeCallback)]
    struct VolumeNotify;

    static VOLUME_LAST_EMIT_MS: AtomicU64 = AtomicU64::new(0);

    impl IAudioEndpointVolumeCallback_Impl for VolumeNotify_Impl {
        fn OnNotify(&self, notify: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
            if notify.is_null() {
                return Ok(());
            }
            let Some(app) = stored_app() else {
                return Ok(());
            };
            let data = unsafe { &*notify };
            let now = now_ms();
            let last = VOLUME_LAST_EMIT_MS.load(Ordering::Acquire);
            if now.saturating_sub(last) < VOLUME_EMIT_MIN_GAP_MS {
                return Ok(()); // 节流：事件携带的是绝对值，丢中间帧无害。
            }
            VOLUME_LAST_EMIT_MS.store(now, Ordering::Release);
            let payload = VolumeChangedPayload {
                level: data.fMasterVolume.clamp(0.0, 1.0),
                muted: data.bMuted.as_bool(),
            };
            use tauri::Emitter;
            let _ = app.emit_filter(super::EVENT_VOLUME, payload, |win| match win {
                tauri::EventTarget::WebviewWindow { label }
                | tauri::EventTarget::Webview { label }
                | tauri::EventTarget::Window { label }
                | tauri::EventTarget::AnyLabel { label } => {
                    label == "settings" || label.starts_with("widget-")
                }
                _ => false,
            });
            Ok(())
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

    fn subscribe_volume(enumerator: &IMMDeviceEnumerator) -> Option<VolumeSubscription> {
        unsafe {
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let endpoint: IAudioEndpointVolume = device.cast().ok()?;
            let callback: IAudioEndpointVolumeCallback = VolumeNotify.into();
            endpoint.RegisterControlChangeNotify(&callback).ok()?;
            Some(VolumeSubscription { endpoint, callback })
        }
    }

    pub fn watcher_loop(app: AppHandle) {
        set_app_handle(app.clone());

        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            log::error!("audio_events: COM init failed: {}", hr.0);
            return;
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
                Err(e) => {
                    log::warn!("audio_events: MMDeviceEnumerator unavailable: {e}");
                    return;
                }
            };

        let notifier: IMMNotificationClient = DeviceNotifier.into();
        if let Err(e) = unsafe { enumerator.RegisterEndpointNotificationCallback(&notifier) } {
            // 拿不到默认设备变更通知：epoch 恒为 0，下面 10s 兜底轮询仍能发现切换。
            log::warn!("audio_events: RegisterEndpointNotificationCallback failed: {e}");
        }

        let mut subscription: Option<VolumeSubscription> = None;
        let mut subscribed_epoch = u64::MAX;
        // 兜底轮询：默认设备变更通知收不到时（订阅失败/驱动不上报），
        // 每 10s 主动强制复核一次（NPS DeviceProbeIntervalMs 同款思想）。
        let probe_every = Duration::from_secs(10);
        let mut next_probe = Instant::now();

        loop {
            let epoch = DEFAULT_RENDER_EPOCH.load(Ordering::Acquire);
            let probe_due = Instant::now() >= next_probe;
            if probe_due {
                next_probe = Instant::now() + probe_every;
                DEFAULT_RENDER_EPOCH.fetch_add(1, Ordering::AcqRel);
            }
            if epoch != subscribed_epoch || probe_due {
                // 先退订旧端点再重订阅：旧回调不摘会在已消失的端点上留一份订阅。
                if let Some(sub) = subscription.take() {
                    sub.detach();
                }
                match subscribe_volume(&enumerator) {
                    Some(sub) => {
                        subscription = Some(sub);
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
            // B-3：watcher_loop 含 COM 调用，panic 会静默带走线程（音量键 OSD
            // 永久失效且无看门狗）。套 media.rs 同款 catch_unwind + 退避重试。
            let mut backoff_secs = 5u64;
            loop {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    #[cfg(windows)]
                    win::watcher_loop(app.clone());
                    #[cfg(not(windows))]
                    let _ = &app;
                }));
                if result.is_ok() {
                    // watcher_loop 仅在 panic 时异常返回（正常路径不退出）。
                    return;
                }
                log::error!("audio_events: watcher loop panicked, retrying in {backoff_secs}s");
                std::thread::sleep(Duration::from_secs(backoff_secs));
                backoff_secs = (backoff_secs * 2).min(60);
            }
        })
        .ok();
}
