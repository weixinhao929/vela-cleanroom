//! §4.12 亮度控制（实验性）：内置屏 `WmiMonitorBrightness(Methods)` +
//! 外接屏 DDC/CI（dxva2 `GetPhysicalMonitorsFromHMONITOR` + VCP 0x10）。
//!
//! 设计要点（服务模式分层设计）：
//! - **300ms 重启式防抖**：外接屏 DDC/CI 写入普遍有 50–200ms 时滞且部分
//!   显示器连续写入会丢帧，拖动滑条期间的每一次 `set_brightness` 只刷新
//!   该屏的写入截止时刻，停顿 300ms 后才真正写一次（值 = 最后一次）。
//! - **失败降级不崩**：任何一层失败（无物理监视器句柄 / DDC 不响应 /
//!   WMI 无权限）都收敛为「该屏 supported=false」或干脆不出现该条目，
//!   绝不向调用方抛 panic；写入失败经 `brightness:write-failed` 事件让
//!   前端把对应屏标记为不支持。
//! - **多屏各自控制**：物理屏标识复用 monitor.rs 的「物理名 → 稳定槽位」
//!   映射，widget-N 与亮度条目一一对应。
//! - WMI 的 COM 会话每次命令现建现拆（`root\wmi` 查询毫秒级），无常驻
//!   线程、无跨命令 COM 状态。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::Emitter;

/// DDC/CI 写入防抖窗口（重启式）：最后一次拖动后静默 300ms 才写。
const DEBOUNCE_DELAY: Duration = Duration::from_millis(300);
/// VCP 0x10（亮度）码。
const VCP_LUMINANCE: u8 = 0x10;

/// 一台显示器的亮度控制条目。
#[derive(Clone, Serialize)]
pub struct BrightnessMonitor {
    /// 稳定写入口标识：`wmi:<InstanceName>`（内置屏）或 `ddc:<\\.\DISPLAYN>#<物理监视器序号>`（外接屏）。
    pub key: String,
    /// widget 槽位（复用 monitor.rs 物理名映射；映射失败时 None）。
    pub slot: Option<u32>,
    /// 人读名称（显示器描述），空则由前端回退「显示器 N」。
    pub label: String,
    /// "internal"（WMI，笔记本内置屏）| "ddc"（DDC/CI，外接屏）。
    pub kind: String,
    /// 探测是否成功；false = 该屏显示「不支持」。
    pub supported: bool,
    /// 当前亮度 0–100（读不到时 None）。
    pub current: Option<u32>,
}

/* ================================================================== *
 * 防抖：纯状态机（注入时钟，可测）+ 常驻写入线程（condvar）。
 * ------------------------------------------------------------------ */

/// 重启式防抖核心。`set` 每次都把该 key 的截止时刻推到 `now + delay`，
/// 只有连续写入之间出现 ≥delay 的静默期，`pop_due` 才会弹出一项。
pub(crate) struct DebounceState {
    delay: Duration,
    pending: HashMap<String, (u32, Instant)>,
}

impl DebounceState {
    pub(crate) fn new(delay: Duration) -> Self {
        Self {
            delay,
            pending: HashMap::new(),
        }
    }

    pub(crate) fn set(&mut self, key: &str, value: u32, now: Instant) {
        self.pending
            .insert(key.to_string(), (value, now + self.delay));
    }

    /// 弹出全部已到期项 (key, 最后写入值)。
    pub(crate) fn pop_due(&mut self, now: Instant) -> Vec<(String, u32)> {
        let due: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, (_, dl))| *dl <= now)
            .map(|(k, _)| k.clone())
            .collect();
        due.into_iter()
            .filter_map(|k| self.pending.remove(&k).map(|(v, _)| (k, v)))
            .collect()
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|(_, dl)| *dl).min()
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

struct DebounceShared {
    queue: Mutex<DebounceState>,
    signal: Condvar,
}

/// 进程级防抖队列（含写入线程）。首次 set/list 时惰性启动。
static SHARED: std::sync::OnceLock<Arc<DebounceShared>> = std::sync::OnceLock::new();

fn shared(app: &tauri::AppHandle) -> Arc<DebounceShared> {
    SHARED
        .get_or_init(|| {
            let s = Arc::new(DebounceShared {
                queue: Mutex::new(DebounceState::new(DEBOUNCE_DELAY)),
                signal: Condvar::new(),
            });
            let writer = s.clone();
            let app2 = app.clone();
            // 写入线程常驻：等待到期项 → 逐个真正落硬件。DDC 单次写
            // 50–200ms，在线程里做不阻塞命令路径。
            let _ = std::thread::Builder::new()
                .name("brightness-debounce".to_string())
                .spawn(move || debounce_loop(writer, app2));
            s
        })
        .clone()
}

fn debounce_loop(shared: Arc<DebounceShared>, app: tauri::AppHandle) {
    loop {
        let mut guard = match shared.queue.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // 等到「最早的截止时刻已过」或「新写入把截止时刻推后」。
        loop {
            let now = Instant::now();
            if guard.next_deadline().is_some_and(|dl| dl <= now) {
                break;
            }
            let wait = guard
                .next_deadline()
                .map(|dl| dl.saturating_duration_since(now))
                .unwrap_or(Duration::from_secs(3600));
            guard = match shared.signal.wait_timeout(guard, wait) {
                Ok((g, _)) => g,
                Err(p) => p.into_inner().0,
            };
        }
        let due = guard.pop_due(Instant::now());
        drop(guard);
        // （慢屏拖累全部）：DDC 写含「枚举 + 写前读 + 写」，一块不响应的外接屏
        // 可挂住数秒——此前串行执行，其它屏的防抖写入全部在队列里干等。改为
        // 每屏一线程并行执行；主循环最多等 2s 收完成信号，慢屏线程在后台自行
        // 收尾（DDD/CI 调用最终会超时返回），不阻塞下一批派发。
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let deadline = Instant::now() + Duration::from_secs(2);
        let total = due.len();
        for (key, value) in due {
            let tx = tx.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = execute_write(&key, value) {
                    log::warn!("brightness write failed for '{key}': {e}");
                    // 写失败（拔线 / HDR / 显示器不响应）→ 前端该屏标记「不支持」。
                    let _ = app.emit(
                        "brightness:write-failed",
                        serde_json::json!({ "key": key, "error": e }),
                    );
                }
                drop(tx); // 完成信号（载荷无关）
            });
        }
        drop(tx);
        let mut remaining = total;
        while remaining > 0 {
            // recv_deadline 尚不稳定（deadline_api）：按剩余时长 recv_timeout。
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(()) => remaining -= 1,
                Err(_) => break, // 全部完成（Disconnected）或到 2s 上限（Timeout）
            }
        }
    }
}

/* ================================================================== *
 * 写入通道：key 反解 → WMI / DDC 执行。
 * ------------------------------------------------------------------ */

#[derive(Debug)]
enum WriteChannel {
    Wmi { instance: String },
    Ddc { gdi: String, index: usize },
}

/// key ↔ 通道的往返编解码（纯函数，供测试锁定格式）。
fn parse_write_key(key: &str) -> Option<WriteChannel> {
    if let Some(instance) = key.strip_prefix("wmi:") {
        return Some(WriteChannel::Wmi {
            instance: instance.to_string(),
        });
    }
    let rest = key.strip_prefix("ddc:")?;
    let (gdi, idx) = rest.rsplit_once('#')?;
    Some(WriteChannel::Ddc {
        gdi: gdi.to_string(),
        index: idx.parse().unwrap_or(0),
    })
}

fn execute_write(key: &str, value: u32) -> Result<(), String> {
    let value = value.clamp(0, 100);
    match parse_write_key(key) {
        Some(WriteChannel::Wmi { instance }) => wmi_set_brightness(&instance, value),
        Some(WriteChannel::Ddc { gdi, index }) => ddc_write(&gdi, index, value),
        None => Err(format!("未知亮度通道: {key}")),
    }
}

/// VCP 值域换算：读取侧归一到 0–100，写回侧按显示器真实 max 放大。
fn vcp_to_percent(cur: u32, max: u32) -> Result<u32, String> {
    if max == 0 {
        return Err("VCP 0x10 值域为 0".to_string());
    }
    Ok((cur.saturating_mul(100) / max).min(100))
}

fn percent_to_vcp(value: u32, max: u32) -> u32 {
    if max == 0 {
        return value;
    }
    // 0% 直写 VCP 0：`.max(1)` 此前把 0% 钳到 1，用户永远无法把外接屏调灭；
    // 仅对非零输入防 0（极小百分比四舍五入为 0 时保底 1，避免误灭屏）。
    if value == 0 {
        return 0;
    }
    (value.min(100).saturating_mul(max) / 100).max(1)
}

/* ================================================================== *
 * DDC/CI（外接屏）：物理监视器句柄现取现写，枚举失败即降级。
 * ------------------------------------------------------------------ */

#[cfg(windows)]
fn utf16_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}

#[cfg(windows)]
fn ddc_probe(hmon: windows::Win32::Graphics::Gdi::HMONITOR) -> Result<(String, u32, u32), String> {
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitor, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply, MC_VCP_CODE_TYPE,
        PHYSICAL_MONITOR,
    };

    unsafe {
        let mut count = 0u32;
        GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count)
            .map_err(|e| format!("无物理监视器句柄: {e}"))?;
        if count == 0 {
            return Err("该屏无物理监视器".to_string());
        }
        let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
        GetPhysicalMonitorsFromHMONITOR(hmon, &mut monitors)
            .map_err(|e| format!("打开物理监视器失败: {e}"))?;
        let result = (|| {
            let m = &monitors[0];
            // PHYSICAL_MONITOR 是 packed 结构：先按值拷出字段再借用（对齐安全）。
            let desc_buf = m.szPhysicalMonitorDescription;
            let desc = utf16_to_string(&desc_buf);
            let mut ty = MC_VCP_CODE_TYPE::default();
            let mut cur = 0u32;
            let mut max = 0u32;
            // dxva2 该族 API 返回裸 i32（非 0 = 成功）。
            if GetVCPFeatureAndVCPFeatureReply(
                m.hPhysicalMonitor,
                VCP_LUMINANCE,
                Some(&mut ty),
                &mut cur,
                Some(&mut max),
            ) == 0
            {
                return Err("DDC/CI 无响应".to_string());
            }
            Ok((desc, vcp_to_percent(cur, max)?, max))
        })();
        for m in &monitors {
            let _ = DestroyPhysicalMonitor(m.hPhysicalMonitor);
        }
        result
    }
}

/// 按 GDI 设备名（`\\.\DISPLAY1`）写入物理监视器 `index` 的亮度。
/// 写入前重新枚举 + 重新读 max（拓扑可能在 list 之后变化）。
#[cfg(windows)]
fn ddc_write(gdi: &str, index: usize, value: u32) -> Result<(), String> {
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitor, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply, SetVCPFeature,
        MC_VCP_CODE_TYPE, PHYSICAL_MONITOR,
    };

    let hmon = find_hmonitor_by_gdi(gdi).ok_or_else(|| format!("显示器 {gdi} 不存在"))?;
    unsafe {
        let mut count = 0u32;
        GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count)
            .map_err(|e| format!("无物理监视器句柄: {e}"))?;
        if count == 0 || index >= count as usize {
            return Err("该屏无物理监视器".to_string());
        }
        let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
        GetPhysicalMonitorsFromHMONITOR(hmon, &mut monitors)
            .map_err(|e| format!("打开物理监视器失败: {e}"))?;
        let result = (|| {
            let m = &monitors[index];
            let mut ty = MC_VCP_CODE_TYPE::default();
            let mut cur = 0u32;
            let mut max = 0u32;
            if GetVCPFeatureAndVCPFeatureReply(
                m.hPhysicalMonitor,
                VCP_LUMINANCE,
                Some(&mut ty),
                &mut cur,
                Some(&mut max),
            ) == 0
            {
                return Err("DDC/CI 无响应".to_string());
            }
            if max == 0 {
                return Err("VCP 0x10 值域为 0".to_string());
            }
            if SetVCPFeature(
                m.hPhysicalMonitor,
                VCP_LUMINANCE,
                percent_to_vcp(value, max),
            ) == 0
            {
                return Err("写入亮度失败".to_string());
            }
            Ok(())
        })();
        for m in &monitors {
            let _ = DestroyPhysicalMonitor(m.hPhysicalMonitor);
        }
        result
    }
}

/* ================================================================== *
 * GDI 枚举：HMONITOR ↔ GDI 设备名 ↔ 槽位 / 监视器 DeviceID。
 * ------------------------------------------------------------------ */

#[cfg(windows)]
struct GdiEntry {
    hmon: windows::Win32::Graphics::Gdi::HMONITOR,
    gdi: String,
    device_id: String,
    device_string: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[cfg(windows)]
unsafe extern "system" fn enum_monitors_cb(
    hmon: windows::Win32::Graphics::Gdi::HMONITOR,
    _hdc: windows::Win32::Graphics::Gdi::HDC,
    rect: *mut windows::Win32::Foundation::RECT,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    let out =
        &mut *(lparam.0 as *mut Vec<(windows::Win32::Graphics::Gdi::HMONITOR, i32, i32, i32, i32)>);
    let r = *rect;
    out.push((hmon, r.left, r.top, r.right, r.bottom));
    windows::core::BOOL::from(true)
}

#[cfg(windows)]
fn gdi_name_of(hmon: windows::Win32::Graphics::Gdi::HMONITOR) -> String {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO, MONITORINFOEXW};
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    unsafe {
        if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
            utf16_to_string(&info.szDevice)
        } else {
            String::new()
        }
    }
}

/// 枚举当前所有 HMONITOR，附 GDI 设备名、监视器级 DeviceID/DeviceString 与矩形。
#[cfg(windows)]
fn collect_gdi_entries() -> Result<Vec<GdiEntry>, String> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplayMonitors, DISPLAY_DEVICEW, HMONITOR,
    };

    let mut raw: Vec<(HMONITOR, i32, i32, i32, i32)> = Vec::new();
    unsafe {
        if !EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitors_cb),
            LPARAM(&mut raw as *mut _ as isize),
        )
        .as_bool()
        {
            return Err("EnumDisplayMonitors 失败".to_string());
        }
    }

    // 适配器级 + 监视器级 EnumDisplayDevices：DeviceID 取设备接口路径
    // （EDD_GET_DEVICE_INTERFACE_NAME，形如 `\\?\DISPLAY#SHP1574#4&…&UID…#{GUID}`），
    // 归一化后与 WMI InstanceName（`DISPLAY\SHP1574\4&…&UID…_0`）精确相等；
    // 不带该标志拿到的是 `MONITOR\SHP1574\{class GUID}\0001`，与 WMI 无法对应
    // （真机诊断测试抓出）。DeviceString 作人读名。每适配器取首个监视器项。
    let mut adapter_info: HashMap<String, (String, String)> = HashMap::new();
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME;
        let mut adapter = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        let mut i = 0u32;
        while EnumDisplayDevicesW(None, i, &mut adapter, 0).as_bool() {
            let gdi = utf16_to_string(&adapter.DeviceName);
            let mut mon = DISPLAY_DEVICEW {
                cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                ..Default::default()
            };
            if EnumDisplayDevicesW(
                windows::core::PCWSTR(adapter.DeviceName.as_ptr()),
                0,
                &mut mon,
                EDD_GET_DEVICE_INTERFACE_NAME,
            )
            .as_bool()
            {
                adapter_info.entry(gdi).or_insert((
                    utf16_to_string(&mon.DeviceID),
                    utf16_to_string(&mon.DeviceString),
                ));
            }
            i += 1;
        }
    }

    Ok(raw
        .into_iter()
        .map(|(hmon, l, t, r, b)| {
            let gdi = gdi_name_of(hmon);
            let (device_id, device_string) = adapter_info.get(&gdi).cloned().unwrap_or_default();
            GdiEntry {
                hmon,
                gdi,
                device_id,
                device_string,
                x: l,
                y: t,
                w: (r - l).max(0) as u32,
                h: (b - t).max(0) as u32,
            }
        })
        .collect())
}

#[cfg(windows)]
fn find_hmonitor_by_gdi(gdi: &str) -> Option<windows::Win32::Graphics::Gdi::HMONITOR> {
    collect_gdi_entries()
        .ok()?
        .into_iter()
        .find(|e| e.gdi == gdi)
        .map(|e| e.hmon)
}

/// 设备路径归一化到「设备实例路径」形态并大写，使两侧可精确相等：
/// - 设备接口路径 `\\?\DISPLAY#SHP1574#4&2418e718&0&UID8388688#{e6f07b5f-…}`
///   → 去 `\\?\`、`#`→`\`、砍掉 `\{GUID}` 尾段；
/// - WMI InstanceName `DISPLAY\SHP1574\4&2418e718&0&UID8388688_0`
///   → 砍掉 `_<数字>` 尾缀。
///
/// 两者都收敛为 `DISPLAY\SHP1574\4&2418E718&0&UID8388688`。
fn normalize_device_id(s: &str) -> String {
    let mut n = s.trim().trim_start_matches(r"\\?\").replace('#', "\\");
    if let Some(pos) = n.find("\\{") {
        n.truncate(pos);
    }
    if let Some(pos) = n.rfind('_') {
        if n[pos + 1..].chars().all(|c| c.is_ascii_digit()) && pos + 1 < n.len() {
            n.truncate(pos);
        }
    }
    n.trim_end_matches('\\').to_uppercase()
}

/// WMI InstanceName → GDI 设备名（精确归一化相等，其次互为前缀）。
/// `entries` 为 (gdi 设备名, 监视器 DeviceID) 对。
fn match_wmi_instance(instance: &str, entries: &[(String, String)]) -> Option<String> {
    let n = normalize_device_id(instance);
    if let Some((gdi, _)) = entries.iter().find(|(_, id)| normalize_device_id(id) == n) {
        return Some(gdi.clone());
    }
    entries
        .iter()
        .find(|(_, id)| {
            let i = normalize_device_id(id);
            i.len() >= 8 && n.len() >= 8 && (n.starts_with(&i) || i.starts_with(&n))
        })
        .map(|(gdi, _)| gdi.clone())
}

/* ================================================================== *
 * WMI（内置屏）：`root\wmi` 每次查询现建 COM 会话。
 * ------------------------------------------------------------------ */

/// 本线程 COM 套间守卫：`CoInitializeEx` 成功（含 S_FALSE）则在 Drop 时配对
/// `CoUninitialize`。必须比同线程上所有 WMI 接口对象活得更久——首版在
/// connect 函数返回前就 uninit，随后的 ExecQuery 直接访问冲突（真机诊断
/// 测试抓出）。调用方把守卫声明在最前面，Rust 逆序析构保证接口先释放。
#[cfg(windows)]
struct ComApartment {
    must_uninit: bool,
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.must_uninit {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

#[cfg(windows)]
fn com_init() -> Result<ComApartment, String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    // 与 audio.rs 相同的套间处理：主线程若已是 STA 会得到 RPC_E_CHANGED_MODE，
    // COM 仍可用，只是不需要（也不能）配对 CoUninitialize。
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() && hr != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
        return Err(format!("COM 初始化失败: {}", hr.0));
    }
    Ok(ComApartment {
        must_uninit: hr.is_ok(),
    })
}

/// 连接 `root\wmi`。调用方必须先持有 `com_init()` 守卫。
#[cfg(windows)]
fn wmi_connect() -> Result<windows::Win32::System::Wmi::IWbemServices, String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoSetProxyBlanket, CLSCTX_INPROC_SERVER, EOAC_NONE,
        RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
    };
    use windows::Win32::System::Wmi::{IWbemLocator, IWbemServices, WbemLocator};

    unsafe {
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("无法创建 WbemLocator: {e}"))?;
        let services: IWbemServices = locator
            .ConnectServer(
                &windows::core::BSTR::from("ROOT\\WMI"),
                &windows::core::BSTR::new(),
                &windows::core::BSTR::new(),
                &windows::core::BSTR::new(),
                0,
                &windows::core::BSTR::new(),
                None,
            )
            .map_err(|e| format!("连接 root\\wmi 失败: {e}"))?;
        // WMI 惯例：代理上设置调用级认证 + 模拟，否则部分机器 ExecQuery
        // 返回 E_ACCESSDENIED。RPC_C_AUTHN_WINNT=10 / RPC_C_AUTHZ_NONE=0
        // （常量位于未启用的 Win32_System_Rpc feature，按值写入）。失败不致命。
        let _ = CoSetProxyBlanket(
            &services,
            10,
            0,
            None,
            RPC_C_AUTHN_LEVEL_CALL,
            RPC_C_IMP_LEVEL_IMPERSONATE,
            None,
            EOAC_NONE,
        );
        Ok(services)
    }
}

/// 读对象字符串属性（BSTR；其他类型安全降级 None）。
#[cfg(windows)]
unsafe fn wmi_get_string(
    obj: &windows::Win32::System::Wmi::IWbemClassObject,
    field: &str,
) -> Option<String> {
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_BSTR};

    let name: Vec<u16> = field.encode_utf16().chain([0]).collect();
    let mut val = VARIANT::default();
    if obj
        .Get(
            windows::core::PCWSTR(name.as_ptr()),
            0,
            &mut val,
            None,
            None,
        )
        .is_err()
    {
        return None;
    }
    let out = if (*val.Anonymous.Anonymous).vt == VT_BSTR {
        let b = &*(*val.Anonymous.Anonymous).Anonymous.bstrVal;
        Some(b.to_string())
    } else {
        None
    };
    let _ = VariantClear(&mut val);
    out
}

/// 读对象数值属性（/ UI4；其他类型 None）。
#[cfg(windows)]
unsafe fn wmi_get_u32(
    obj: &windows::Win32::System::Wmi::IWbemClassObject,
    field: &str,
) -> Option<u32> {
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_I4, VT_UI4};

    let name: Vec<u16> = field.encode_utf16().chain([0]).collect();
    let mut val = VARIANT::default();
    if obj
        .Get(
            windows::core::PCWSTR(name.as_ptr()),
            0,
            &mut val,
            None,
            None,
        )
        .is_err()
    {
        return None;
    }
    let vt = (*val.Anonymous.Anonymous).vt;
    let out = if vt == VT_I4 {
        Some((*val.Anonymous.Anonymous).Anonymous.lVal as u32)
    } else if vt == VT_UI4 {
        Some((*val.Anonymous.Anonymous).Anonymous.ulVal)
    } else {
        None
    };
    let _ = VariantClear(&mut val);
    out
}

/// 枚举 `WmiMonitorBrightness` 的 (InstanceName, CurrentBrightness)。
/// 无内置屏 / 无权限 / WMI 服务不可用时返回 Err（调用方静默降级）。
#[cfg(windows)]
fn wmi_list_brightness() -> Result<Vec<(String, u32)>, String> {
    use windows::Win32::System::Wmi::{
        IEnumWbemClassObject, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_INFINITE,
    };

    // 守卫声明最先：所有 WMI 接口对象析构后才 CoUninitialize。
    let _com = com_init()?;
    let services = wmi_connect()?;
    unsafe {
        let enum_: IEnumWbemClassObject = services
            .ExecQuery(
                &windows::core::BSTR::from("WQL"),
                &windows::core::BSTR::from(
                    "SELECT InstanceName, CurrentBrightness FROM WmiMonitorBrightness",
                ),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None,
            )
            .map_err(|e| format!("WmiMonitorBrightness 查询失败: {e}"))?;
        let mut out = Vec::new();
        loop {
            let mut buf: [Option<windows::Win32::System::Wmi::IWbemClassObject>; 1] = [None];
            let mut got = 0u32;
            let hr = enum_.Next(WBEM_INFINITE, &mut buf, &mut got);
            if hr.is_err() || got == 0 {
                break;
            }
            let Some(item) = buf[0].take() else { break };
            if let Some(instance) = wmi_get_string(&item, "InstanceName") {
                out.push((
                    instance,
                    wmi_get_u32(&item, "CurrentBrightness").unwrap_or(100),
                ));
            }
        }
        Ok(out)
    }
}

/// 内置屏写入：枚举 `WmiMonitorBrightnessMethods` 实例（取 `__PATH` 精确
/// 对象路径，避免手拼 WMI 转义），匹配 InstanceName 后 ExecMethod
/// `WmiSetBrightness(Timeout=0, Brightness=value)`。
#[cfg(windows)]
fn wmi_set_brightness(instance: &str, value: u32) -> Result<(), String> {
    use windows::Win32::System::Variant::{VariantClear, VariantInit, VARIANT, VT_I4};
    use windows::Win32::System::Wmi::{
        IEnumWbemClassObject, IWbemClassObject, WBEM_FLAG_FORWARD_ONLY,
        WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_GENERIC_FLAG_TYPE, WBEM_INFINITE,
    };

    // 守卫声明最先：所有 WMI 接口对象析构后才 CoUninitialize。
    let _com = com_init()?;
    let services = wmi_connect()?;
    unsafe {
        let enum_: IEnumWbemClassObject = services
            .ExecQuery(
                &windows::core::BSTR::from("WQL"),
                &windows::core::BSTR::from("SELECT * FROM WmiMonitorBrightnessMethods"),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None,
            )
            .map_err(|e| format!("WmiMonitorBrightnessMethods 查询失败: {e}"))?;
        let mut target: Option<(String, IWbemClassObject)> = None;
        loop {
            let mut buf: [Option<IWbemClassObject>; 1] = [None];
            let mut got = 0u32;
            if enum_.Next(WBEM_INFINITE, &mut buf, &mut got).is_err() || got == 0 {
                break;
            }
            let Some(item) = buf[0].take() else { break };
            if let Some(name) = wmi_get_string(&item, "InstanceName") {
                if name == instance {
                    let path = wmi_get_string(&item, "__PATH")
                        .ok_or_else(|| "无法读取 WMI 对象路径".to_string())?;
                    target = Some((path, item));
                    break;
                }
            }
        }
        let (path, _item) = target.ok_or_else(|| format!("未找到亮度方法实例: {instance}"))?;

        // 方法输入签名必须从「类定义」对象取：对实例调用 GetMethod 会得到
        // WBEM_E_INVALID_METHOD 0x8004101E（真机诊断测试抓出）。
        let mut class_obj: Option<IWbemClassObject> = None;
        services
            .GetObject(
                &windows::core::BSTR::from("WmiMonitorBrightnessMethods"),
                WBEM_GENERIC_FLAG_TYPE(0),
                None,
                Some(&mut class_obj),
                None,
            )
            .map_err(|e| format!("无法取得 WmiMonitorBrightnessMethods 类定义: {e}"))?;
        let class = class_obj.ok_or_else(|| "类定义为空".to_string())?;
        let method_name: Vec<u16> = "WmiSetBrightness".encode_utf16().chain([0]).collect();
        let mut in_sig: Option<IWbemClassObject> = None;
        let mut out_sig: Option<IWbemClassObject> = None;
        class
            .GetMethod(
                windows::core::PCWSTR(method_name.as_ptr()),
                0,
                &mut in_sig,
                &mut out_sig,
            )
            .map_err(|e| format!("无法取得 WmiSetBrightness 签名: {e}"))?;
        let in_params = in_sig
            .and_then(|s| s.SpawnInstance(0).ok())
            .ok_or_else(|| "无法构造方法参数".to_string())?;

        let put_i4 = |obj: &IWbemClassObject, field: &str, v: i32| -> Result<(), String> {
            let name: Vec<u16> = field.encode_utf16().chain([0]).collect();
            let mut val: VARIANT = VariantInit();
            (*val.Anonymous.Anonymous).vt = VT_I4;
            (*val.Anonymous.Anonymous).Anonymous.lVal = v;
            let r = obj.Put(windows::core::PCWSTR(name.as_ptr()), 0, &val, 0);
            let _ = VariantClear(&mut val);
            r.map_err(|e| format!("写入参数 {field} 失败: {e}"))
        };
        put_i4(&in_params, "Timeout", 0)?;
        put_i4(&in_params, "Brightness", value as i32)?;

        services
            .ExecMethod(
                &windows::core::BSTR::from(path),
                &windows::core::BSTR::from("WmiSetBrightness"),
                WBEM_GENERIC_FLAG_TYPE(0),
                None,
                &in_params,
                None,
                None,
            )
            .map_err(|e| format!("WmiSetBrightness 执行失败: {e}"))
    }
}

/* ================================================================== *
 * 枚举组装（spawn_blocking 内执行）。
 * ------------------------------------------------------------------ */

fn enumerate_blocking(app: &tauri::AppHandle) -> Result<Vec<BrightnessMonitor>, String> {
    // 槽位映射：物理矩形/名称 → slot（复用 monitor.rs 持久化映射）。
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("无法枚举显示器: {e}"))?;
    let slotted = crate::monitor::resolve_monitor_slots(app, &monitors);
    let mut rect_to_slot: HashMap<(i32, i32, u32, u32), u32> = HashMap::new();
    let mut name_to_slot: HashMap<String, u32> = HashMap::new();
    for (slot, m) in &slotted {
        let p = m.position();
        let s = m.size();
        rect_to_slot.insert((p.x, p.y, s.width, s.height), *slot as u32);
        if let Some(n) = m.name() {
            name_to_slot.entry(n.clone()).or_insert(*slot as u32);
        }
    }

    let gdi_entries = collect_gdi_entries()?;
    // WMI 内置屏（失败静默：台式机/无权限机器正常为空）。
    let wmi = if cfg!(windows) {
        wmi_list_brightness().unwrap_or_default()
    } else {
        Vec::new()
    };
    // 每个 WMI 实例先解析它挂在哪块 GDI 设备上。
    let all_ids: Vec<(String, String)> = gdi_entries
        .iter()
        .map(|e| (e.gdi.clone(), e.device_id.clone()))
        .collect();
    let wmi_gdi: Vec<Option<String>> = wmi
        .iter()
        .map(|(inst, _)| match_wmi_instance(inst, &all_ids))
        .collect();

    let mut out: Vec<BrightnessMonitor> = Vec::new();
    let mut consumed_wmi: Vec<usize> = Vec::new();

    for (idx, e) in gdi_entries.iter().enumerate() {
        let slot = rect_to_slot
            .get(&(e.x, e.y, e.w, e.h))
            .or_else(|| name_to_slot.get(&e.gdi))
            .copied();
        let fallback_label = if e.device_string.is_empty() {
            format!("显示器 {}", slot.map(|s| s + 1).unwrap_or(idx as u32 + 1))
        } else {
            e.device_string.clone()
        };

        // 内置屏：WMI InstanceName 匹配到本 GDI 设备 → 优先 internal 通道。
        if let Some(wi) = wmi_gdi
            .iter()
            .position(|g| g.as_deref() == Some(e.gdi.as_str()))
        {
            if !consumed_wmi.contains(&wi) {
                consumed_wmi.push(wi);
                out.push(BrightnessMonitor {
                    key: format!("wmi:{}", wmi[wi].0),
                    slot,
                    label: fallback_label,
                    kind: "internal".to_string(),
                    supported: true,
                    current: Some(wmi[wi].1),
                });
                continue;
            }
        }

        // 外接屏：DDC/CI 探测（失败 → supported=false，不崩）。
        let probe = if cfg!(windows) {
            ddc_probe(e.hmon)
        } else {
            Err("非 Windows 平台".to_string())
        };
        let (supported, current, label) = match probe {
            Ok((desc, percent, _max)) => (
                true,
                Some(percent),
                if desc.is_empty() {
                    fallback_label
                } else {
                    desc
                },
            ),
            Err(_) => (false, None, fallback_label),
        };
        out.push(BrightnessMonitor {
            key: format!("ddc:{}#0", e.gdi),
            slot,
            label,
            kind: "ddc".to_string(),
            supported,
            current,
        });
    }

    // 未匹配到任何 GDI 设备的 WMI 实例（映射罕见的边角）→ 仍列出，slot None。
    for (wi, (inst, level)) in wmi.iter().enumerate() {
        if !consumed_wmi.contains(&wi) && wmi_gdi[wi].is_none() {
            out.push(BrightnessMonitor {
                key: format!("wmi:{inst}"),
                slot: None,
                label: "内置显示屏".to_string(),
                kind: "internal".to_string(),
                supported: true,
                current: Some(*level),
            });
        }
    }

    out.sort_by_key(|m| (m.slot.unwrap_or(u32::MAX), m.label.clone()));
    Ok(out)
}

/* ================================================================== *
 * Tauri 命令（trusted_window 门控）。
 * ------------------------------------------------------------------ */

/// 枚举每台显示器的亮度控制通道与当前值。写入侧的防抖线程也随之惰性启动。
#[tauri::command]
pub async fn list_brightness_monitors(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Vec<BrightnessMonitor>, String> {
    crate::require_trusted(&window)?;
    shared(&app); // 确保防抖线程在首次使用时就绪
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || enumerate_blocking(&app2))
        .await
        .map_err(|e| format!("亮度枚举任务失败: {e}"))?
}

/// 防抖写入某屏亮度（0–100）。立即返回；真正落硬件在停顿 300ms 后。
#[tauri::command]
pub fn set_brightness(
    app: tauri::AppHandle,
    window: tauri::Window,
    key: String,
    value: u8,
) -> Result<(), String> {
    crate::require_trusted(&window)?;
    if parse_write_key(&key).is_none() {
        return Err(format!("未知亮度通道: {key}"));
    }
    let sh = shared(&app);
    let mut guard = match sh.queue.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    guard.set(&key, value.min(100) as u32, Instant::now());
    drop(guard);
    sh.signal.notify_all();
    Ok(())
}

/* ================================================================== *
 * 测试：防抖时序（注入时钟 + 真实时钟冒烟）、key 往返、值域换算、
 * 降级路径（无句柄 / 不支持 → 不 panic）。
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn debounce_burst_writes_once_after_quiet_period() {
        let mut st = DebounceState::new(ms(300));
        let t0 = Instant::now();
        // 连续拖动：5 次 set，间隔 40ms（模拟拖动帧）。
        for i in 0..5u32 {
            st.set("ddc:DISPLAY1#0", 20 + i, t0 + ms(u64::from(i) * 40));
        }
        // 静默不足 300ms：不写。
        assert!(st.pop_due(t0 + ms(160 + 299)).is_empty());
        // 最后一次 set 在 t=160，截止 t=460：此刻恰好到期，且只有一项、值=最后值。
        let due = st.pop_due(t0 + ms(460));
        assert_eq!(due, vec![("ddc:DISPLAY1#0".to_string(), 24u32)]);
        assert!(st.is_empty());
    }

    #[test]
    fn debounce_deadline_restarts_on_each_set() {
        let mut st = DebounceState::new(ms(300));
        let t0 = Instant::now();
        st.set("k", 10, t0);
        st.set("k", 20, t0 + ms(100));
        st.set("k", 30, t0 + ms(200));
        // 若是「首次启动」式防抖，t=300 就会写；重启式必须等到 t=500。
        assert!(st.pop_due(t0 + ms(499)).is_empty());
        assert_eq!(st.pop_due(t0 + ms(500)), vec![("k".to_string(), 30u32)]);
    }

    #[test]
    fn debounce_keys_are_independent() {
        let mut st = DebounceState::new(ms(300));
        let t0 = Instant::now();
        st.set("a", 1, t0);
        st.set("b", 2, t0 + ms(200));
        assert_eq!(st.pop_due(t0 + ms(301)), vec![("a".to_string(), 1u32)]);
        assert_eq!(st.pop_due(t0 + ms(501)), vec![("b".to_string(), 2u32)]);
        assert!(st.is_empty());
    }

    #[test]
    fn debounce_real_clock_smoke() {
        // 真实时钟冒烟：模拟拖动结束后 300ms 防抖窗口收敛。
        let mut st = DebounceState::new(ms(120));
        for i in 0..6u32 {
            st.set("x", 30 + i, Instant::now());
            std::thread::sleep(ms(20));
        }
        assert!(st.pop_due(Instant::now()).is_empty(), "拖动中不应写出");
        std::thread::sleep(ms(160));
        let due = st.pop_due(Instant::now());
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1, 35, "写出最后一次值");
    }

    #[test]
    fn write_key_roundtrip() {
        match parse_write_key("wmi:DISPLAY\\BOE0960\\5&2b2f6e0b&0&UID257") {
            Some(WriteChannel::Wmi { instance }) => {
                assert_eq!(instance, "DISPLAY\\BOE0960\\5&2b2f6e0b&0&UID257");
            }
            other => panic!("wmi key 解析失败: {other:?}"),
        }
        match parse_write_key("ddc:\\\\.\\DISPLAY3#0") {
            Some(WriteChannel::Ddc { gdi, index }) => {
                assert_eq!(gdi, "\\\\.\\DISPLAY3");
                assert_eq!(index, 0);
            }
            other => panic!("ddc key 解析失败: {other:?}"),
        }
        assert!(parse_write_key("garbage").is_none());
        assert!(parse_write_key("ddc:no-index").is_none());
    }

    #[test]
    fn execute_write_rejects_unknown_key() {
        assert!(execute_write("garbage", 50).is_err());
        // 已知通道但屏不存在：走降级 Err，不 panic。
        let e = execute_write("ddc:\\\\.\\DISPLAY99#0", 50).unwrap_err();
        assert!(e.contains("不存在") || e.contains("物理监视器") || e.contains("失败"));
    }

    #[test]
    fn vcp_scaling_roundtrip() {
        // 标准 max=100：恒等。
        assert_eq!(vcp_to_percent(73, 100).unwrap(), 73);
        assert_eq!(percent_to_vcp(73, 100), 73);
        // 非 100 值域（部分显示器 max=255）：
        assert_eq!(vcp_to_percent(128, 255).unwrap(), 50);
        let scaled = percent_to_vcp(50, 255);
        assert!((scaled as i32 - 128).abs() <= 1, "scaled={scaled}");
        // max=0 → 错误（值域异常，调用方降级）。
        assert!(vcp_to_percent(10, 0).is_err());
        // 越界钳制。
        assert_eq!(percent_to_vcp(120, 100), 100);
        // 0% 直写 0（不再被 .max(1) 钳成 1）；非零小值保底 1。
        assert_eq!(percent_to_vcp(0, 255), 0);
        assert_eq!(percent_to_vcp(0, 100), 0);
        assert!(percent_to_vcp(1, 255) >= 1);
    }

    #[cfg(windows)]
    #[test]
    fn ddc_probe_with_null_handle_degrades() {
        // 无效 HMONITOR（空句柄）：必须 Err 降级，绝不 panic。
        let r = ddc_probe(windows::Win32::Graphics::Gdi::HMONITOR::default());
        assert!(r.is_err());
    }

    #[cfg(windows)]
    #[test]
    fn collect_gdi_entries_never_panics() {
        // 真机枚举：任何结果（含空）都不 panic；GDI 名形态自洽。
        if let Ok(entries) = collect_gdi_entries() {
            for e in &entries {
                assert!(e.gdi.starts_with("\\\\.\\DISPLAY") || e.gdi.is_empty());
            }
        }
    }

    /// 真机诊断（默认忽略）：`cargo test brightness -- --ignored --nocapture`
    /// 打印本机每块屏的 GDI 名 / DeviceID / DDC 探测结果与 WMI 内置屏实例，
    /// 排查「为什么某屏显示不支持」时用；只读不写。
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_machine_probe_report() {
        let entries = collect_gdi_entries().expect("GDI 枚举");
        for e in &entries {
            let probe = ddc_probe(e.hmon);
            println!(
                "GDI {:<14} id={:?} str={:?} rect={}x{}@{},{} ddc={:?}",
                e.gdi, e.device_id, e.device_string, e.w, e.h, e.x, e.y, probe
            );
        }
        let ids: Vec<(String, String)> = entries
            .iter()
            .map(|e| (e.gdi.clone(), e.device_id.clone()))
            .collect();
        match wmi_list_brightness() {
            Ok(list) => {
                for (inst, level) in &list {
                    println!(
                        "WMI {inst} = {level}% -> gdi {:?}",
                        match_wmi_instance(inst, &ids)
                    );
                    // 写路径冒烟：把当前值原样写回（无可见变化），验证
                    // GetMethod / SpawnInstance / Put / ExecMethod 整条链。
                    println!(
                        "WMI write-back {level}% -> {:?}",
                        wmi_set_brightness(inst, *level)
                    );
                }
                if list.is_empty() {
                    println!("WMI: 无 WmiMonitorBrightness 实例（台式机 / 无内置屏正常）");
                }
            }
            Err(e) => println!("WMI 不可用（降级为无内置屏）: {e}"),
        }
    }

    #[test]
    fn wmi_instance_matching() {
        // 真机采样：EnumDisplayDevices(EDD_GET_DEVICE_INTERFACE_NAME) 接口路径 vs
        // WmiMonitorBrightness.InstanceName（带 `_0` 尾缀）。
        let entries = vec![(
            "\\\\.\\DISPLAY1".to_string(),
            "\\\\?\\DISPLAY#SHP1574#4&2418e718&0&UID8388688#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"
                .to_string(),
        )];
        assert_eq!(
            normalize_device_id("\\\\?\\DISPLAY#SHP1574#4&2418e718&0&UID8388688#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"),
            "DISPLAY\\SHP1574\\4&2418E718&0&UID8388688"
        );
        assert_eq!(
            normalize_device_id("DISPLAY\\SHP1574\\4&2418e718&0&UID8388688_0"),
            "DISPLAY\\SHP1574\\4&2418E718&0&UID8388688"
        );
        assert_eq!(
            match_wmi_instance("DISPLAY\\SHP1574\\4&2418e718&0&UID8388688_0", &entries),
            Some("\\\\.\\DISPLAY1".to_string())
        );
        // 旧格式 DeviceID（无接口名标志）与 WMI 不同构 → 不匹配也不误匹配。
        let legacy = vec![(
            "\\\\.\\DISPLAY1".to_string(),
            "MONITOR\\SHP1574\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\0001".to_string(),
        )];
        assert_eq!(
            match_wmi_instance("DISPLAY\\SHP1574\\4&2418e718&0&UID8388688_0", &legacy),
            None
        );
        // 大小写归一后精确匹配；不相干实例 → None。
        let plain = vec![(
            "\\\\.\\DISPLAY2".to_string(),
            "display\\boe0960\\5&2b2f6e0b&0&UID257".to_string(),
        )];
        assert_eq!(
            match_wmi_instance("DISPLAY\\BOE0960\\5&2b2f6e0b&0&UID257_0", &plain),
            Some("\\\\.\\DISPLAY2".to_string())
        );
        assert_eq!(match_wmi_instance("DISPLAY\\OTHER\\12345678", &plain), None);
    }
}
