//! System monitoring commands (CPU, memory, disk, network, battery) backed by
//! `sysinfo`. GPU usage/VRAM are read from real Windows performance counters
//! (see `crate::gpu`); nothing here is estimated or synthesized.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessesToUpdate, RefreshKind, System,
};
use tauri::{Emitter, Manager};
use ts_rs::TS;

pub struct SystemSampler {
    sys: Mutex<System>,
    disks: Mutex<Disks>,
    networks: Mutex<Networks>,
    /// Calls since the last full disk re-enumeration. A full `refresh(true)`
    /// walks every volume and can block for seconds on a dead network drive;
    /// usage-only refresh is cheap, so the expensive pass is throttled.
    disk_full_refresh_calls: AtomicU32,
    /// Calls since the last process-list refresh (W-149). Enumerating all
    /// processes every second is wasteful; a 10s cadence is plenty for a count.
    process_refresh_calls: AtomicU32,
    /// Last known process count (W-149), refreshed on the throttled cadence.
    process_count: AtomicU32,
    /// Instant of the previous `sample_networks` refresh. `sysinfo` counters
    /// (`received()`/`transmitted()`) report bytes transferred SINCE the last
    /// refresh — a window delta, not a rate. Dividing by the measured window
    /// converts it to true bytes/second; without it the displayed speed was
    /// inflated by the sampling interval (2–3× at the default cadence).
    last_network_sample: Mutex<Option<std::time::Instant>>,
    /// W-145/W-153 每网卡绝对计数器快照（开机以来累计字节）。速率由本进程
    /// 自己对绝对计数器做 checked 差分得出：计数器回落（网卡禁用/驱动重置/
    /// 系统重置计数）时差分安全归 0，天然免疫 sysinfo 内部 wrapping 减法
    /// 产生的假尖峰（经典网速工具同款四重防护的回绕分支）。
    network_totals: Mutex<HashMap<String, NetIfaceBaseline>>,
    /// W-153 采样帧序号：与 `network_totals` 的 last_seen 配合识别「缺席帧」
    /// （sysinfo 会把断开的网卡从列表剔除）与「采样间隙」（presence 暂停/
    /// 睡眠唤醒后 first_seen 断档 → 本帧速率归 0 重建基线）。
    net_frame: AtomicU64,
}

/// 单网卡的差分基线：上次绝对计数 + 上次出现的帧号。
#[derive(Clone, Copy)]
struct NetIfaceBaseline {
    total_rx: u64,
    total_tx: u64,
    last_seen: u64,
}

/// W-145/W-153 断开网卡的「幽灵行」保留帧数：超过后不再上报（约 10 分钟
/// @1s 采样）。sysinfo 只列已连接网卡，幽灵行让 UI 能显示「未连接」而不是
/// 静默消失，同时不至于永久堆积。
const NET_GHOST_FRAMES: u64 = 600;

impl SystemSampler {
    pub fn new() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        // First refresh primes CPU usage baselines.
        sys.refresh_cpu_usage();
        Self {
            sys: Mutex::new(sys),
            disks: Mutex::new(Disks::new_with_refreshed_list()),
            networks: Mutex::new(Networks::new_with_refreshed_list()),
            disk_full_refresh_calls: AtomicU32::new(0),
            process_refresh_calls: AtomicU32::new(0),
            process_count: AtomicU32::new(0),
            last_network_sample: Mutex::new(None),
            network_totals: Mutex::new(HashMap::new()),
            net_frame: AtomicU64::new(0),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct SystemStats {
    pub cpu_usage: f32,
    pub mem_used_gb: f32,
    pub mem_total_gb: f32,
    pub mem_percent: f32,
    pub cores: usize,
    pub gpu_usage: f32,
    pub gpu_mem_used_gb: f32,
    pub gpu_mem_total_gb: f32,
    /// True when real GPU performance counters were found. The widgets use this
    /// (not VRAM) to decide whether to show the GPU section.
    pub gpu_present: bool,
    /// BUG-1（审计）：每块显卡一条记录（名称来自 DXGI 枚举），多卡全部可见；
    /// 旧标量字段保留为"最忙一块"，供 SystemWidget/SystemBarWidget 兼容消费。
    pub gpus: Vec<GpuInfo>,
    /// W-146 每核占用率数组（与 cores 等长，任务管理器小格子形态）。
    pub cpu_per_core: Vec<f32>,
    /// W-149 开机时长（秒）。
    pub uptime_secs: u64,
    /// W-149 进程数（10s 节流刷新）。
    pub process_count: u32,
}

/// BUG-1（审计）：单块显卡的运行时信息。
#[derive(Serialize, Clone)]
pub struct GpuInfo {
    pub model: String,
    pub usage: f32,
    pub mem_used_gb: f32,
    pub mem_total_gb: f32,
}

/// F-3：静态硬件信息（CPU/GPU 型号），进程内只算一次。已从每帧 `sys:stats`
/// 载荷中拆出，走低频一次的 `sys:hardware` 事件投递，消除 String 每帧克隆。
#[derive(Serialize, Clone)]
pub struct HardwareInfo {
    pub cpu_model: String,
    pub gpu_model: String,
}

/// 一次性采集静态硬件型号。写入 `sys:hardware` 事件供前端合并显示。
pub fn sample_hardware() -> HardwareInfo {
    let (cpu_model, gpu_model) = static_hardware();
    HardwareInfo {
        cpu_model,
        gpu_model,
    }
}

/// W-148 静态硬件信息：CPU 型号（sysinfo brand，一次性全量刷新）+
/// GPU 型号（HKLM 显卡类 DriverDesc，第一个非空项）。进程内只算一次。
fn static_hardware() -> (String, String) {
    static CACHE: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let cpu_model = System::new_with_specifics(
                RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
            )
            .cpus()
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();

            let gpu_model = read_gpu_model_from_registry().unwrap_or_default();
            (cpu_model, gpu_model)
        })
        .clone()
}

/// 从注册表显示适配器类读显卡名（`...\Class\{4d36e968-…}\0000\DriverDesc`）。
/// 多显卡时取第一个非空 DriverDesc；失败返回 None（前端显示占位符）。
#[cfg(windows)]
fn read_gpu_model_from_registry() -> Option<String> {
    const DISPLAY_CLASS: &str =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let root = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
    let class = root.open_subkey(DISPLAY_CLASS).ok()?;
    for idx in 0..8 {
        let sub = class.open_subkey(format!("{idx:04}")).ok()?;
        if let Ok(desc) = sub.get_value::<String, _>("DriverDesc") {
            let trimmed = desc.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn read_gpu_model_from_registry() -> Option<String> {
    None
}

#[derive(Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct DiskInfo {
    pub name: String,
    pub mount: String,
    pub total_gb: f32,
    pub used_gb: f32,
    pub percent: f32,
}

#[derive(Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct NetworkInfo {
    pub name: String,
    /// Bytes per second (raw `sysinfo` counter). The frontend formats to
    /// B/s / KB/s / MB/s; it must NOT be misread as kbit/s.
    pub rx_bps: f32,
    pub tx_bps: f32,
    /// W-153 开机以来累计收发字节（sysinfo 绝对计数器，跨采样帧单调递增；
    /// 网卡重置时归零重来，前端仅作展示不作差分）。
    #[ts(type = "number")]
    pub total_received: u64,
    #[ts(type = "number")]
    pub total_transmitted: u64,
    /// W-145 连接状态：true = 本帧在 sysinfo 列表中（sysinfo 会过滤掉媒体
    /// 断开的网卡）；false = 刚断开的幽灵行（保留 `NET_GHOST_FRAMES` 帧）。
    pub up: bool,
}

#[derive(Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct BatteryInfo {
    pub present: bool,
    pub percent: f32,
    pub charging: bool,
}

// Sampling helpers shared by the polled commands and the broadcast thread.
fn sample_stats(state: &SystemSampler) -> SystemStats {
    // R7：临界区收窄——CPU/内存/每核占用取完即放锁。GPU 采样（PDH collect）
    // 与进程全量枚举（几百进程的机器上几十~上百 ms）此前都在 sys 锁内，
    // 期间并发的 get_system_stats / get_disk_info 命令只能排队。
    let (cpu_usage, mem_used, mem_total, cpu_per_core, cores) = {
        let mut sys = state.sys.lock().unwrap_or_else(|p| p.into_inner());
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        (
            sys.global_cpu_usage(),
            sys.used_memory(),
            sys.total_memory(),
            sys.cpus()
                .iter()
                .map(|c| c.cpu_usage())
                .collect::<Vec<f32>>(),
            sys.cpus().len(),
        )
    };
    let mem_percent = if mem_total > 0 {
        (mem_used as f32 / mem_total as f32) * 100.0
    } else {
        0.0
    };

    // Real GPU utilization & VRAM via Windows performance counters. When the
    // host exposes no GPU counters, report 0s (frontend hides the GPU section)
    // instead of fabricating a number from the CPU load.
    let gpus: Vec<GpuInfo> = crate::gpu::imp::read_all_gpus()
        .unwrap_or_default()
        .iter()
        .map(|s| GpuInfo {
            model: crate::gpu::imp::model_for_luid(&s.luid),
            usage: s.usage,
            mem_used_gb: s.mem_used_gb,
            mem_total_gb: s.mem_total_gb,
        })
        .collect();
    // 标量兼容口径（最忙的一块）直接复用本帧样本。此前再调一次 read_gpu()
    // 会对同一 PDH 查询背靠背 collect 第二次：速率计数器的采样窗口≈0ms，
    // 读数在 0/100 间跳变，失败计数还会被推满触发无谓的查询重建。
    let best = gpus.iter().max_by(|a, b| a.usage.total_cmp(&b.usage));
    let gpu_present = best.is_some();
    let gpu_usage = best.map(|g| g.usage).unwrap_or(0.0);
    let gpu_mem_total_gb = best.map(|g| g.mem_total_gb).unwrap_or(0.0);
    let gpu_mem_used_gb = best.map(|g| g.mem_used_gb).unwrap_or(0.0);

    // W-149 开机时长（0.33 起为关联函数，无需实例刷新）。
    let uptime_secs = System::uptime();

    // W-149 进程数：10s 节流全量刷新，其余帧读缓存值。独立 System 实例做
    // PID 级枚举（R7：不占共享 sys 锁；丢实例无状态代价）。
    let calls = state.process_refresh_calls.fetch_add(1, Ordering::Relaxed);
    if calls.is_multiple_of(10) {
        let mut counter = System::new();
        let count = counter.refresh_processes(ProcessesToUpdate::All, true) as u32;
        state.process_count.store(count, Ordering::Relaxed);
    }
    let process_count = state.process_count.load(Ordering::Relaxed);

    SystemStats {
        cpu_usage,
        // `sysinfo` reports memory in BYTES; dividing once gives KiB (mislabeled
        // as "GB"), so a 16 GB machine showed ~16,000,000 GB. Divide by 1024³.
        mem_used_gb: mem_used as f32 / 1024.0 / 1024.0 / 1024.0,
        mem_total_gb: mem_total as f32 / 1024.0 / 1024.0 / 1024.0,
        mem_percent,
        cores,
        gpu_usage,
        gpu_mem_used_gb,
        gpu_mem_total_gb,
        gpu_present,
        gpus,
        cpu_per_core,
        uptime_secs,
        process_count,
    }
}

fn sample_disks(state: &SystemSampler) -> Vec<DiskInfo> {
    let mut disks = state.disks.lock().unwrap_or_else(|p| p.into_inner());
    // Full list re-enumeration every ~30 samples (1s cadence → every 30s); in
    // between, refresh usage of the known volumes only.
    let calls = state
        .disk_full_refresh_calls
        .fetch_add(1, Ordering::Relaxed);
    disks.refresh(calls.is_multiple_of(30));
    disks
        .iter()
        .map(|d| {
            let total = d.total_space();
            let avail = d.available_space();
            let used = total.saturating_sub(avail);
            let percent = if total > 0 {
                (used as f32 / total as f32) * 100.0
            } else {
                0.0
            };
            DiskInfo {
                name: d.name().to_string_lossy().into_owned(),
                mount: d.mount_point().to_string_lossy().into_owned(),
                total_gb: total as f32 / 1024.0 / 1024.0 / 1024.0,
                used_gb: used as f32 / 1024.0 / 1024.0 / 1024.0,
                percent,
            }
        })
        .collect()
}

fn sample_networks(state: &SystemSampler) -> Vec<NetworkInfo> {
    let mut networks = state.networks.lock().unwrap_or_else(|p| p.into_inner());
    let mut last = state
        .last_network_sample
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    // Window length since the previous refresh; the very first sample has no
    // baseline, so it reports 0 instead of leaking the entire boot counter.
    let elapsed_secs = last.map(|prev| prev.elapsed().as_secs_f32()).unwrap_or(0.0);
    networks.refresh(true);
    *last = Some(std::time::Instant::now());
    let frame = state.net_frame.fetch_add(1, Ordering::SeqCst);
    let mut baselines = state
        .network_totals
        .lock()
        .unwrap_or_else(|p| p.into_inner());

    // 鲁棒性（对照经典网速工具的速率四重防护）：
    //  1. 速率一律由本进程对「绝对计数器」做 checked_sub 差分——计数器回落
    //     （网卡禁用/驱动重置）差分安全归 0，绝不产生假尖峰；
    //  2. 首帧 / 采样间隙（presence 暂停、睡眠唤醒 → last_seen 断档）→ 本帧
    //     速率归 0，只重建基线，避免把长间隔的累计字节摊成失真速率。
    let mut out: Vec<NetworkInfo> = Vec::new();
    for (name, data) in networks.iter() {
        let total_rx = data.total_received();
        let total_tx = data.total_transmitted();
        let (rx_bps, tx_bps) = match baselines.get(name) {
            Some(prev) if elapsed_secs > 0.0 && prev.last_seen + 1 == frame => {
                let dr = total_rx.saturating_sub(prev.total_rx);
                let dt = total_tx.saturating_sub(prev.total_tx);
                (dr as f32 / elapsed_secs, dt as f32 / elapsed_secs)
            }
            _ => (0.0, 0.0),
        };
        baselines.insert(
            name.clone(),
            NetIfaceBaseline {
                total_rx,
                total_tx,
                last_seen: frame,
            },
        );
        out.push(NetworkInfo {
            name: name.clone(),
            rx_bps,
            tx_bps,
            total_received: total_rx,
            total_transmitted: total_tx,
            up: true,
        });
    }
    // 幽灵行：本帧缺席（= sysinfo 判定媒体断开）的上一帧网卡，以 up=false、
    // 速率 0 上报一段宽限期，UI 显示「未连接」；超过宽限期则从基线中清除。
    let ghosts: Vec<(String, NetIfaceBaseline)> = baselines
        .iter()
        .filter(|(_, b)| b.last_seen < frame)
        .map(|(n, b)| (n.clone(), *b))
        .collect();
    for (name, b) in ghosts {
        if frame - b.last_seen <= NET_GHOST_FRAMES {
            out.push(NetworkInfo {
                name,
                rx_bps: 0.0,
                tx_bps: 0.0,
                total_received: b.total_rx,
                total_transmitted: b.total_tx,
                up: false,
            });
        } else {
            baselines.remove(&name);
        }
    }
    // 稳定顺序：网卡名排序，避免 HashMap 迭代序随机导致 UI 行跳动。
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn read_battery() -> BatteryInfo {
    #[cfg(windows)]
    {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut status = SYSTEM_POWER_STATUS::default();
        // SAFETY: passing a valid pointer to a stack buffer.
        let ok = unsafe { GetSystemPowerStatus(&mut status) }.is_ok();
        if !ok {
            return BatteryInfo {
                present: false,
                percent: 0.0,
                charging: false,
            };
        }
        let ac = status.ACLineStatus;
        let percent = status.BatteryLifePercent;
        BatteryInfo {
            present: percent <= 100,
            percent: percent as f32,
            charging: ac == 1,
        }
    }
    #[cfg(not(windows))]
    {
        BatteryInfo {
            present: false,
            percent: 0.0,
            charging: false,
        }
    }
}

/// One broadcast frame: everything the monitor widgets need in a single event.
#[derive(Serialize, Clone)]
pub struct SystemBroadcast {
    pub stats: SystemStats,
    pub disks: Vec<DiskInfo>,
    pub networks: Vec<NetworkInfo>,
    pub battery: BatteryInfo,
}

/// Drives a single Rust-side sampling thread that broadcasts `sys:stats` to
/// every subscribed webview. This replaces per-widget IPC polling: N monitor
/// widgets used to fire N × 3 invoke() calls per tick; now the work happens
/// once per tick no matter how many widgets display it.
pub struct StatsBroadcaster {
    subscribers: AtomicU32,
    /// Per-window subscription ledger: label -> (count, smallest interval the
    /// window asked for). Two problems this fixes:
    ///  1. Interval only ever went *down* (global `min`); once a fast
    ///     subscriber left, the survivors stayed at its cadence forever.
    ///     Recomputing from the ledger lets the cadence recover.
    ///  2. A destroyed webview (monitor unplug calls `destroy()` directly)
    ///     never runs its JS cleanup, leaking subscribers and keeping the
    ///     broadcast thread sampling into the void forever. The ledger gives
    ///     `RunEvent::WindowEvent::Destroyed` a way to settle the account.
    per_window: std::sync::Mutex<std::collections::HashMap<String, (u32, u64)>>,
    /// Sampling cadence in ms — always the minimum across the live ledger.
    interval_ms: AtomicU64,
    /// Bumped each time a new thread is (re)started; an exiting thread compares
    /// its captured generation and steps aside instead of double-emitting.
    generation: AtomicU64,
    running: AtomicBool,
    /// §4.6 presence 降载：用户输入空闲（锁屏/挂机）时置位，采样线程跳过
    /// 采样帧（不退出——订阅账本原样保留，恢复输入立即续采）。与前端可见性
    /// 门控互补：可见性管"窗口隐藏"，这里管"窗口可见但人不在"。
    paused: AtomicBool,
}

impl StatsBroadcaster {
    pub fn new() -> Self {
        Self {
            subscribers: AtomicU32::new(0),
            per_window: std::sync::Mutex::new(std::collections::HashMap::new()),
            interval_ms: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            running: AtomicBool::new(false),
            paused: AtomicBool::new(false),
        }
    }

    /// presence 模块设置的采样暂停开关（空闲暂停 / 恢复输入续采）。
    pub fn set_paused(&self, v: bool) {
        self.paused.store(v, Ordering::SeqCst);
    }

    fn add_subscription(&self, label: &str, iv: u64) {
        let mut map = self.per_window.lock().unwrap_or_else(|p| p.into_inner());
        let entry = map.entry(label.to_string()).or_insert((0, iv));
        entry.0 += 1;
        entry.1 = entry.1.min(iv);
        self.subscribers.fetch_add(1, Ordering::SeqCst);
        self.recalc_interval(&map);
    }

    /// Saturating decrement: the JS side always sends unsubscribe on cleanup,
    /// even when the matching subscribe never landed (StrictMode double-mount /
    /// fast widget add-remove). A plain fetch_sub at zero would wrap to
    /// u32::MAX and the broadcast loop would never observe zero subscribers.
    fn remove_subscription(&self, label: &str) {
        let mut map = self.per_window.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = map.get_mut(label) {
            if entry.0 > 0 {
                entry.0 -= 1;
                let mut cur = self.subscribers.load(Ordering::SeqCst);
                while cur > 0 {
                    match self.subscribers.compare_exchange_weak(
                        cur,
                        cur - 1,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    ) {
                        Ok(_) => break,
                        Err(actual) => cur = actual,
                    }
                }
            }
            if entry.0 == 0 {
                map.remove(label);
            }
        }
        self.recalc_interval(&map);
    }

    /// Settle a destroyed window's subscriptions (its JS cleanup may never
    /// run — e.g. `monitor.rs` destroys webviews directly on monitor unplug).
    pub fn drop_window(&self, label: &str) {
        let mut map = self.per_window.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((count, _)) = map.remove(label) {
            let mut cur = self.subscribers.load(Ordering::SeqCst);
            while cur > 0 {
                let target = cur.saturating_sub(count);
                match self.subscribers.compare_exchange_weak(
                    cur,
                    target,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(actual) => cur = actual,
                }
            }
        }
        self.recalc_interval(&map);
    }

    fn recalc_interval(&self, map: &std::collections::HashMap<String, (u32, u64)>) {
        let want = map.values().map(|(_, iv)| *iv).min().unwrap_or(0);
        self.interval_ms.store(want, Ordering::SeqCst);
    }
}

fn broadcast_loop(app: tauri::AppHandle, my_generation: u64) {
    use tauri::Emitter;
    loop {
        let bc = app.state::<StatsBroadcaster>();
        if bc.subscribers.load(Ordering::SeqCst) == 0
            || bc.generation.load(Ordering::SeqCst) != my_generation
        {
            bc.running.store(false, Ordering::SeqCst);
            // Exit race: a subscribe that landed between the load above and this
            // store saw running=true and spawned nothing. Re-check; if subscribers
            // appeared, respawn here so a live subscriber never ends up without a
            // sampler thread (widgets would freeze on "loading" until the next
            // subscribe). If running flipped back to true meanwhile, a concurrent
            // subscribe already spawned the replacement — step aside.
            let subs = bc.subscribers.load(Ordering::SeqCst);
            if subs == 0 {
                bc.interval_ms.store(0, Ordering::SeqCst);
                return;
            }
            if bc.generation.load(Ordering::SeqCst) == my_generation
                && !bc.running.swap(true, Ordering::SeqCst)
            {
                let gen = bc.generation.fetch_add(1, Ordering::SeqCst) + 1;
                std::thread::spawn(move || broadcast_loop(app, gen));
            }
            return;
        }
        let iv = bc.interval_ms.load(Ordering::SeqCst).clamp(500, 30_000);
        // §4.6 空闲降载：presence 置位 paused 时跳过采样与广播，仅低频轮询
        // 开关（1s），订阅者与代数守卫照常生效，恢复输入后下一拍即续采。
        if bc.paused.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_secs(1));
            continue;
        }
        // Absolute-deadline scheduling: heavy frames (process/disk full
        // refreshes, dead network drives blocking for seconds) used to stretch
        // the frame period to `sampling + iv`, making every full-refresh frame
        // a visible stutter in the widgets. Anchoring to the frame start keeps
        // the average cadence at iv; a new interval applies from the next frame.
        let frame_start = std::time::Instant::now();
        // 采样内部含 unsafe FFI（PDH/GDI）与可越界的驱动数据：一旦 panic，
        // 本线程直接 unwind 退出而 running 仍为 true → 之后任何 subscribe 都
        // 看到 running=true 而不重启线程，sys:stats 从此永久冻结。catch_unwind
        // 兜住后复位 running，让下一次 subscribe 重新拉起采样线程。
        let payload = {
            let sampler = app.state::<SystemSampler>();
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| SystemBroadcast {
                    stats: sample_stats(&sampler),
                    disks: sample_disks(&sampler),
                    networks: sample_networks(&sampler),
                    battery: read_battery(),
                }));
            match result {
                Ok(payload) => payload,
                Err(panic) => {
                    let msg = panic
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "unknown".into());
                    log::error!("sys:stats 采样 panic，5 秒后重试: {msg}");
                    // 不能只复位 running 就退出：已订阅的窗口不会再发 subscribe，
                    // 那样会永久冻结。退避 5 秒后重试本帧（持续 panic 也只会有
                    // 每 5 秒一次的错误日志，不会风暴）。
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    continue;
                }
            }
        };
        // F-3：改用 emit_filter——载荷只序列化一次，且只投递给 per_window 账本里
        // 实际订阅了的窗口，不再向无监听窗口（如 quick-note / 设置窗口）广播。
        let subscribed: std::collections::HashSet<String> = {
            let map = bc.per_window.lock().unwrap_or_else(|p| p.into_inner());
            map.keys().cloned().collect()
        };
        let _ = app.emit_filter("sys:stats", payload, move |win| match win {
            tauri::EventTarget::WebviewWindow { label }
            | tauri::EventTarget::Webview { label }
            | tauri::EventTarget::Window { label }
            | tauri::EventTarget::AnyLabel { label } => subscribed.contains(label),
            _ => false,
        });
        let elapsed = frame_start.elapsed();
        let budget = std::time::Duration::from_millis(iv);
        if elapsed < budget {
            std::thread::sleep(budget - elapsed);
        }
    }
}

#[tauri::command]
pub async fn subscribe_system_stats(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    bc: tauri::State<'_, StatsBroadcaster>,
    interval_ms: u64,
) -> Result<(), String> {
    // A-5 扫描发现补闸：硬件型号/占用率/电池属本机信息面（net_history M3
    // 同口径），不给 web-preview 远程页订阅。WebviewWindow 无 require_trusted
    // 重载，内联谓词但走 canonical 文案。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let iv = interval_ms.clamp(500, 30_000);
    bc.add_subscription(window.label(), iv);
    // F-3：静态硬件型号低频投递一次（订阅即发），前端合并进每帧 stats。
    let _ = window.emit("sys:hardware", sample_hardware());
    if !bc.running.swap(true, Ordering::SeqCst) {
        let gen = bc.generation.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || broadcast_loop(app, gen));
    }
    Ok(())
}

#[tauri::command]
pub async fn unsubscribe_system_stats(
    window: tauri::WebviewWindow,
    bc: tauri::State<'_, StatsBroadcaster>,
) -> Result<(), String> {
    // gate: none needed（label 仅作订阅账本键移除自己，无特权访问面）
    bc.remove_subscription(window.label());
    Ok(())
}

// These commands are polled every second by the monitor widgets. Sampling is
// real blocking work (sysinfo refresh, PDH collect, dead network drives can
// hang `networks.refresh(true)` for seconds) — running it bare on an async
// worker starves the whole runtime's other IPC, so each is wrapped in
// spawn_blocking (State borrows can't cross the closure; use app.state inside).
#[tauri::command]
pub async fn get_system_stats(app: tauri::AppHandle) -> Result<SystemStats, String> {
    // Poison-safe: if a prior panic poisoned the lock, hand out the inner value
    // rather than panicking the (polled every second) IPC handler.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SystemSampler>();
        sample_stats(&state)
    })
    .await
    .map_err(|e| format!("采样任务失败：{e}"))
}

#[tauri::command]
pub async fn get_disk_info(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Vec<DiskInfo>, String> {
    // 隐私闸门（M3）：低信任窗（quick-note / taskbar-net）不应能枚举系统信息。
    // 拒绝走 Err（M2 统一语义），不再返回空表假成功。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SystemSampler>();
        sample_disks(&state)
    })
    .await
    .map_err(|e| format!("采样任务失败：{e}"))
}

#[tauri::command]
pub async fn get_network_info(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Vec<NetworkInfo>, String> {
    // 隐私闸门（M3）：与 get_disk_info / get_network_details 同源，低信任窗
    // 不应能枚举无线网络。拒绝走 Err（M2 统一语义），不再返回空表假成功。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SystemSampler>();
        sample_networks(&state)
    })
    .await
    .map_err(|e| format!("采样任务失败：{e}"))
}

#[tauri::command]
pub async fn get_battery_info() -> BatteryInfo {
    read_battery()
}

/// 速率的人类可读格式（Rust 侧系统通知正文用；前端展示走 lib/network.ts）。
pub fn fmt_rate_human(bps: u64) -> String {
    let v = bps as f64;
    if v >= 1024.0 * 1024.0 {
        format!("{:.1} MB/s", v / 1024.0 / 1024.0)
    } else if v >= 1024.0 {
        format!("{:.1} KB/s", v / 1024.0)
    } else {
        format!("{bps} B/s")
    }
}

/// 字节量的人类可读格式（Rust 侧系统通知正文用）。
pub fn fmt_bytes_human(bytes: u64) -> String {
    let v = bytes as f64;
    if v >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} GB", v / 1024.0 / 1024.0 / 1024.0)
    } else if v >= 1024.0 * 1024.0 {
        format!("{:.1} MB", v / 1024.0 / 1024.0)
    } else if v >= 1024.0 {
        format!("{:.1} KB", v / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

/* ------------------------------------------------------------------ */
/* W-168 网卡连接详情 + W-169 当前 TCP 连接（对照经典网速工具的          */
/* NetworkInfoDlg / 连接列表）。按需命令：MAC/IP 等字符串不进每帧        */
/* `sys:stats` 广播，仅在设置页 / 小组件展开明细时拉取一次。             */
/* ------------------------------------------------------------------ */

/// 单网卡详情（`get_network_details`）。`name` 与 `NetworkInfo.name` 同源
/// （GetAdaptersAddresses 的 FriendlyName == GetIfTable2 的 Alias，sysinfo
/// 两侧都用它作键），前端可按名字精确关联速率与详情。
#[derive(Serialize, Clone)]
pub struct NetworkDetail {
    pub name: String,
    /// 适配器描述（如 "Intel(R) Wi-Fi 6 AX201 160MHz"）。
    pub description: String,
    /// ethernet / wifi / ppp / tunnel / loopback / other（IANA IfType 映射）。
    pub if_type: String,
    /// up / down / dormant / not_present / unknown / …（IF_OPER_STATUS 映射）。
    pub oper_status: String,
    /// 链路速度 Mbps（取收/发链路速度较大者；0 = 未知或已断开）。
    pub link_mbps: f64,
    pub mac: String,
    /// 单播 IP（含 IPv4/IPv6），按适配器链表顺序。
    pub ips: Vec<String>,
    /// 默认网关（取第一条；无为空串）。
    pub gateway: String,
    pub mtu: u32,
    /// 开机以来累计收发字节（一次性 sysinfo 实例，绝对计数器）。
    pub total_received: u64,
    pub total_transmitted: u64,
}

/// IANA IfType（ipifcons.h 常用值）→ 可读名。
fn if_type_name(t: u32) -> &'static str {
    match t {
        6 => "ethernet",
        71 => "wifi",
        53 => "ppp",
        131 => "tunnel",
        24 => "loopback",
        9 => "tokenring",
        37 => "atm",
        144 => "firewire",
        _ => "other",
    }
}

/// IF_OPER_STATUS → 可读名（1..7，其余 unknown）。
fn oper_status_name(v: i32) -> &'static str {
    match v {
        1 => "up",
        2 => "down",
        3 => "testing",
        5 => "dormant",
        6 => "not_present",
        7 => "lower_layer_down",
        _ => "unknown",
    }
}

/// 从 `SOCKET_ADDRESS` 裸指针解析 IPv4/IPv6 文本。字段偏移按 Win32 ABI 固定：
/// sockaddr_in 的地址在 +4，sockaddr_in6 的地址在 +8。
/// SAFETY: 调用方保证 `sa` 指向 `iSockaddrLength ≥ 16` 的合法 sockaddr。
#[cfg(windows)]
unsafe fn sockaddr_to_ip(
    sa: *const windows::Win32::Networking::WinSock::SOCKADDR,
) -> Option<String> {
    use std::net::{Ipv4Addr, Ipv6Addr};
    if sa.is_null() {
        return None;
    }
    let family = (*sa).sa_family.0;
    let base = sa.cast::<u8>();
    match family {
        2 => {
            let b = std::slice::from_raw_parts(base.add(4), 4);
            Some(Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string())
        }
        23 => {
            let b = std::slice::from_raw_parts(base.add(8), 16);
            let arr: [u8; 16] = b.try_into().ok()?;
            Some(Ipv6Addr::from(arr).to_string())
        }
        _ => None,
    }
}

/// 枚举全部网卡详情（GetAdaptersAddresses， FriendlyName 与 sysinfo 键精确
/// 同名），并用一次性 sysinfo 实例合并开机以来累计字节。
#[cfg(windows)]
fn collect_network_details() -> Vec<NetworkDetail> {
    use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::Networking::WinSock::{AF_UNSPEC, SOCKET_ADDRESS};

    // 累计字节：一次性 Networks 实例（total_received 为开机以来绝对计数），
    // 不触碰共享采样器的差分基线。
    let totals: HashMap<String, (u64, u64)> = Networks::new_with_refreshed_list()
        .iter()
        .map(|(n, d)| (n.clone(), (d.total_received(), d.total_transmitted())))
        .collect();

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_SKIP_MULTICAST;
    let mut size: u32 = 16 * 1024;
    // 两轮缓冲增长循环足够：一次正常成功，一次 overflow 后按需大小重试。
    for _ in 0..2 {
        // SAFETY 前置：IP_ADAPTER_ADDRESSES_LH 含指针字段需 8 字节对齐；`Vec<u8>`
        // 只保证 1 字节对齐，据此转引用在对齐不足时是 UB。AlignedByte 以
        // repr(align(8)) 分配，保证缓冲基址满足对齐契约。
        let buf = vec![AlignedByte(0); size as usize];
        let adapters = buf.as_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        let rc = unsafe {
            GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(adapters), &mut size)
        };
        if rc == ERROR_BUFFER_OVERFLOW.0 {
            continue;
        }
        if rc != 0 {
            // ERROR_SUCCESS 之外失败（如 NO_DATA）：没有可枚举适配器。
            return Vec::new();
        }
        let mut out: Vec<NetworkDetail> = Vec::new();
        let mut cur = adapters;
        while !cur.is_null() {
            let a = unsafe { &*cur };
            cur = a.Next;
            let name = unsafe { a.FriendlyName.to_string().ok() }.unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let description = unsafe { a.Description.to_string().ok() }.unwrap_or_default();
            let mac = a.PhysicalAddress[..(a.PhysicalAddressLength as usize).min(8)]
                .iter()
                .map(|b| format!("{b:02X}"))
                .collect::<Vec<_>>()
                .join("-");
            let mut ips = Vec::new();
            let mut ua = a.FirstUnicastAddress;
            while !ua.is_null() {
                let sa = unsafe { &*ua }.Address;
                // SAFETY: sockaddr_to_ip 按契约只读 lpSockaddr 指向的合法 sockaddr。
                if let Some(ip) = unsafe { sockaddr_to_ip(sa.lpSockaddr) } {
                    ips.push(ip);
                }
                ua = unsafe { &*ua }.Next;
            }
            let mut gateway = String::new();
            let mut ga = a.FirstGatewayAddress;
            while !ga.is_null() {
                let sa: SOCKET_ADDRESS = unsafe { &*ga }.Address;
                // SAFETY: 同上。
                if let Some(ip) = unsafe { sockaddr_to_ip(sa.lpSockaddr) } {
                    gateway = ip;
                    break;
                }
                ga = unsafe { &*ga }.Next;
            }
            let (total_received, total_transmitted) = totals.get(&name).copied().unwrap_or((0, 0));
            out.push(NetworkDetail {
                name,
                description,
                if_type: if_type_name(a.IfType).to_string(),
                oper_status: oper_status_name(a.OperStatus.0).to_string(),
                link_mbps: (a.TransmitLinkSpeed.max(a.ReceiveLinkSpeed) as f64) / 1_000_000.0,
                mac,
                ips,
                gateway,
                mtu: a.Mtu,
                total_received,
                total_transmitted,
            });
        }
        out.sort_by(|x, y| x.name.cmp(&y.name));
        return out;
    }
    Vec::new()
}

/// 8 字节对齐的字节单元：Win32 API 回填的结构体（适配器表 / TCP 连接表）
/// 含指针与 usize 字段，缓冲必须满足其自然对齐；`Vec<u8>` 只保证 1 字节。
#[repr(C, align(8))]
#[derive(Clone, Copy)]
struct AlignedByte(pub u8);

#[cfg(not(windows))]
fn collect_network_details() -> Vec<NetworkDetail> {
    Vec::new()
}

#[tauri::command]
pub async fn get_network_details(window: tauri::Window) -> Result<Vec<NetworkDetail>, String> {
    // 隐私闸门（M3）：低信任窗（quick-note / taskbar-net）不应能枚举系统信息。
    if !crate::trusted_window(window.label()) {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(collect_network_details)
        .await
        .map_err(|e| format!("采样任务失败:{e}"))
}

/// 当前 TCP 连接（W-169，P2 按进程流量的连接级交付）。来自
/// `GetExtendedTcpTable(TCP_TABLE_OWNER_MODULE_ALL)`，含归属 PID；
/// 进程名经 sysinfo 一次解析（未退出/短命进程显示 PID）。IPv4/IPv6 合并，
/// 上限 400 条防 UI 卡顿。
#[derive(Serialize, Clone)]
pub struct TcpConnectionInfo {
    pub local: String,
    pub remote: String,
    /// LISTEN / ESTABLISHED / TIME_WAIT / …（MIB_TCP_STATE 映射）。
    pub state: String,
    pub pid: u32,
    pub process: String,
}

fn tcp_state_name(s: u32) -> &'static str {
    match s {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT1",
        7 => "FIN_WAIT2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "UNKNOWN",
    }
}

/// `dwLocalPort`/`dwRemotePort` 是网络序的高 16 位（MSDN：DWORD 内以
/// 大端存放端口号）→ 直接取高字节重组。
fn row_port(port_be: u32) -> u16 {
    ((port_be & 0xFF) << 8 | (port_be >> 8) & 0xFF) as u16
}

/// IPv4 的 dwAddr 为网络序：字段内存字节即地址字节，小端机器读出的 u32
/// 需按 LE 拆回字节（等价 ntohl 后的 bytes）。`to_be_bytes` 会把八位组
/// 整体反转（127.0.0.1 → 1.0.0.127），历史 bug。
fn row_ipv4(addr: u32, port: u16) -> String {
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
    let ip = Ipv4Addr::from(addr.to_le_bytes());
    SocketAddr::V4(SocketAddrV4::new(ip, port)).to_string()
}

#[cfg(test)]
mod tcp_table_tests {
    use super::{fmt_bytes_human, fmt_rate_human, row_ipv4, row_port};

    #[test]
    fn row_port_matches_ntohs_of_low_u16() {
        // 端口 80 网络序字节 {0x00,0x50} → LE u32 0x00005000；443 {0x01,0xBB} → 0x0000BB01。
        assert_eq!(row_port(0x0000_5000), 80);
        assert_eq!(row_port(0x0000_BB01), 443);
        assert_eq!(row_port(0x0000_0000), 0);
        assert_eq!(row_port(0x0000_FFFF), u16::MAX);
    }

    #[test]
    fn row_ipv4_decodes_network_order_address() {
        // 127.0.0.1 网络序内存字节 {0x7F,0,0,1} → LE u32 0x0100_007F。
        assert_eq!(row_ipv4(0x0100_007F, 80), "127.0.0.1:80");
        assert_eq!(row_ipv4(0x0501_A8C0, 443), "192.168.1.5:443");
        assert_eq!(row_ipv4(0, 0), "0.0.0.0:0");
    }

    #[test]
    fn human_formats_use_binary_units() {
        assert_eq!(fmt_rate_human(512), "512 B/s");
        assert_eq!(fmt_rate_human(2048), "2.0 KB/s");
        assert_eq!(fmt_bytes_human(1024), "1.0 KB");
        assert_eq!(fmt_bytes_human(3 * 1024 * 1024 * 1024), "3.00 GB");
    }
}

#[cfg(windows)]
fn collect_tcp_connections() -> Vec<TcpConnectionInfo> {
    use std::net::Ipv6Addr;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_MODULE, MIB_TCPTABLE_OWNER_MODULE,
        TCP_TABLE_OWNER_MODULE_ALL,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    /// 一次调用拉一张表；缓冲按 MSDN 惯例先给 16KB，不足时按返回的所需
    /// 大小重试一次。成功返回原始字节缓冲。
    fn fetch(family: u32) -> Option<Vec<AlignedByte>> {
        let mut size: u32 = 16 * 1024;
        for _ in 0..2 {
            // 同 collect_network_details：表结构含指针字段，用对齐单元分配。
            let mut buf = vec![AlignedByte(0); size as usize];
            let rc = unsafe {
                GetExtendedTcpTable(
                    Some(buf.as_mut_ptr().cast()),
                    &mut size,
                    false,
                    family,
                    TCP_TABLE_OWNER_MODULE_ALL,
                    0,
                )
            };
            if rc == 0 {
                return Some(buf);
            }
            // ERROR_INSUFFICIENT_BUFFER(122)：size 已被更新为所需大小，重试。
            if rc != 122 {
                // 含 ERROR_NO_DATA(232)：该族当前无连接。
                return None;
            }
        }
        None
    }

    let mut out: Vec<TcpConnectionInfo> = Vec::new();

    // IPv4：MIB_TCPTABLE_OWNER_MODULE，地址为网络序 u32。
    if let Some(buf) = fetch(AF_INET.0 as u32) {
        let table = unsafe { &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_MODULE) };
        let rows = unsafe {
            std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize)
        };
        for r in rows {
            out.push(TcpConnectionInfo {
                local: row_ipv4(r.dwLocalAddr, row_port(r.dwLocalPort)),
                remote: row_ipv4(r.dwRemoteAddr, row_port(r.dwRemotePort)),
                state: tcp_state_name(r.dwState).to_string(),
                pid: r.dwOwningPid,
                process: String::new(),
            });
        }
    }

    // IPv6：MIB_TCP6TABLE_OWNER_MODULE（行结构含 16 字节地址 + ScopeId，
    // 与 v4 行不可混用）。
    if let Some(buf) = fetch(AF_INET6.0 as u32) {
        let table = unsafe { &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_MODULE) };
        let rows = unsafe {
            std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize)
        };
        for r in rows {
            let local = format!(
                "[{}]:{}",
                Ipv6Addr::from(r.ucLocalAddr),
                row_port(r.dwLocalPort)
            );
            let remote = format!(
                "[{}]:{}",
                Ipv6Addr::from(r.ucRemoteAddr),
                row_port(r.dwRemotePort)
            );
            out.push(TcpConnectionInfo {
                local,
                remote,
                state: tcp_state_name(r.dwState).to_string(),
                pid: r.dwOwningPid,
                process: String::new(),
            });
        }
    }
    out
}

#[cfg(not(windows))]
fn collect_tcp_connections() -> Vec<TcpConnectionInfo> {
    Vec::new()
}

#[tauri::command]
pub async fn get_tcp_connections(window: tauri::Window) -> Result<Vec<TcpConnectionInfo>, String> {
    // 隐私闸门（M3）：低信任窗（quick-note / taskbar-net）不应能枚举系统信息。
    if !crate::trusted_window(window.label()) {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let mut conns = collect_tcp_connections();
        // PID → 进程名：一次性 sysinfo 实例（只刷进程名，开销一次性命令可承受）。
        if !conns.is_empty() {
            let mut sys = System::new();
            let pids: Vec<sysinfo::Pid> = conns
                .iter()
                .map(|c| sysinfo::Pid::from_u32(c.pid))
                .collect();
            sys.refresh_processes(ProcessesToUpdate::Some(&pids), false);
            for c in &mut conns {
                c.process = sys
                    .process(sysinfo::Pid::from_u32(c.pid))
                    .map(|p| p.name().to_string_lossy().into_owned())
                    .unwrap_or_default();
            }
        }
        conns.truncate(400);
        conns
    })
    .await
    .map_err(|e| format!("采样任务失败:{e}"))
}

/* ------------------------------------------------------------------ */
/* 真实采集验证：实机读取并打印，供与 Windows 自身报告（任务管理器 /     */
/* PowerShell WMI）交叉比对。任何值看起来是随机/合成/死值都会被标记。     */
/* ------------------------------------------------------------------ */
#[cfg(all(test, windows))]
mod verify {
    use super::*;

    #[test]
    fn prints_real_system_metrics() {
        let sampler = SystemSampler::new();
        let mut sys = sampler.sys.lock().unwrap();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let cpu = sys.global_cpu_usage();
        let used = sys.used_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
        let total = sys.total_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
        let cores = sys.cpus().len();
        // 断言：CPU 在 [0,100]、内存总量>0、used<=total，杜绝负值/死值。
        assert!(cpu.is_finite() && (0.0..=100.0).contains(&cpu));
        assert!(total > 0.0 && used >= 0.0 && used <= total + 0.5);
        eprintln!(
            "[verify] CPU={:.1}%  MEM used={:.2}GB / total={:.2}GB  cores={}",
            cpu, used, total, cores
        );
    }

    #[test]
    fn prints_real_disk_metrics() {
        let sampler = SystemSampler::new();
        let mut disks = sampler.disks.lock().unwrap();
        disks.refresh(true);
        for d in disks.iter() {
            let total = d.total_space();
            let avail = d.available_space();
            let used = total.saturating_sub(avail);
            let pct = if total > 0 {
                used as f32 / total as f32 * 100.0
            } else {
                0.0
            };
            eprintln!(
                "[verify-disk] {} {:?} total={:.1}GB used={:.1}GB pct={:.0}%",
                d.name().to_string_lossy(),
                d.mount_point(),
                total as f32 / 1024.0 / 1024.0 / 1024.0,
                used as f32 / 1024.0 / 1024.0 / 1024.0,
                pct
            );
        }
    }

    #[test]
    fn prints_real_network_metrics() {
        let sampler = SystemSampler::new();
        let mut nets = sampler.networks.lock().unwrap();
        // sysinfo 计数器首读无基线（恒为 0）；先 refresh 一次建立基线，短睡后再
        // 读一次即为真实速率。widget 每秒轮询，同样能拿到非零真实值。
        nets.refresh(true);
        std::thread::sleep(std::time::Duration::from_millis(250));
        nets.refresh(true);
        let mut found = 0;
        for (name, data) in nets.iter() {
            let rx = data.received() as f32;
            let tx = data.transmitted() as f32;
            eprintln!("[verify-net] {} rx_bps={:.1} tx_bps={:.1}", name, rx, tx);
            found += 1;
        }
        assert!(found > 0, "should enumerate at least one network interface");
    }

    #[test]
    fn prints_real_battery_metrics() {
        let b = block_complete(super::get_battery_info());
        eprintln!(
            "[verify-batt] present={} percent={} charging={}",
            b.present, b.percent, b.charging
        );
    }

    /// 无环境 exec 的最小 block_on：所调命令内部无 await 点，一次 poll 即 Ready。
    fn block_complete<T>(fut: impl std::future::Future<Output = T>) -> T {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn raw_waker() -> RawWaker {
            fn clone(_: *const ()) -> RawWaker {
                raw_waker()
            }
            fn wake(_: *const ()) {}
            fn wake_ref(_: *const ()) {}
            fn drop(_: *const ()) {}
            static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake_ref, drop);
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        let waker = unsafe { Waker::from_raw(raw_waker()) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = std::pin::pin!(fut);
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("command has no awaits; must not block"),
        }
    }
}
