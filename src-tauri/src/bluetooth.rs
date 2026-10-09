//! Bluetooth device enumeration backed by the Win32 SetupAPI.
//!
//! We enumerate the "Bluetooth" PnP device class (GUID
//! `{E0CBF06C-CD8B-4647-BB8A-263B43F0F974}`), which — unlike the classic
//! `BluetoothFindFirstDevice` API (classic only) — also surfaces Bluetooth LE
//! devices (mice / keyboards / earbuds). We keep only the real device nodes
//! (`BTHENUM\DEV_…` for classic, `BTHLE\DEV_…` for LE), read the friendly name
//! and battery level, and mark a device as connected via
//! DEVPKEY_Device_IsConnected (with the classic radio API as fallback).

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use windows::core::GUID;
use windows::Win32::Devices::Bluetooth::*;
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::Devices::Properties::{DEVPROPTYPE, DEVPROP_TYPE_BOOLEAN, DEVPROP_TYPE_BYTE};
use windows::Win32::Foundation::*;

#[derive(Serialize)]
pub struct BluetoothDevice {
    pub name: String,
    pub connected: bool,
    pub device_type: String,
    pub battery: Option<i32>,
}

/// DEVPKEY_Device_FriendlyName = {A45C254E-DF1C-4EFD-8020-67D146A850E0}, 14
const DEVPKEY_DEVICE_FRIENDLY_NAME: DEVPROPKEY = DEVPROPKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

/// 蓝牙电量属性（BYTE，0–100）。主键 `{104EA319-6EE2-4701--8DDBF425BBE5}, 2`
/// 在本机 Win11 实测有效（BLE 设备的 `BTHLE\DEV_…` 节点直接带此属性：929=26、
/// EWEADN=83，与系统设置一致）；社区常见的 `{104EA319-…-8DBF425BBE5A}, 1` 在
/// 本机全部为空，作为次键保留兼容其他 Windows 版本。
fn battery_propkeys() -> [DEVPROPKEY; 2] {
    [
        DEVPROPKEY {
            fmtid: GUID::from_u128(0x104ea319_6ee2_4701_bd47_8ddbf425bbe5),
            pid: 2,
        },
        DEVPROPKEY {
            fmtid: GUID::from_u128(0x104ea319_6ee2_4701_bd47_8dbf425bbe5a),
            pid: 1,
        },
    ]
}

/// DEVPKEY_Device_Parent = {4340A635-93A1-4B49-982B-171A83A1965F}, 10（备查）：
/// 服务子节点（`BTHENUM\{service-guid}_…`）的父设备实例 id。实测经
/// SetupDiGetDevicePropertyW 查不到（返回空），子节点归并改走 CM_Get_Parent。
#[allow(dead_code)]
fn parent_propkey() -> DEVPROPKEY {
    DEVPROPKEY {
        fmtid: GUID::from_u128(0x4340a635_93a1_4b49_982b_171a83a1965f),
        pid: 10,
    }
}

/// DEVPKEY_Device_IsConnected = {83DA6326-97A6-4088-9453-A1923F573B29}, 15
///
/// The authoritative connection signal, verified empirically: it is false for
/// paired-but-disconnected devices and true for actively connected ones, for
/// BOTH classic (`BTHENUM`) and LE (`BTHLE`) nodes. The naive heuristic of
/// "node present + started + problem-free" is useless here — paired-but-
/// disconnected devices keep present/started/OK nodes, which made idle
/// devices show up as connected.
fn is_connected_propkey() -> DEVPROPKEY {
    DEVPROPKEY {
        fmtid: GUID::from_u128(0x83da6326_97a6_4088_9453_a1923f573b29),
        pid: 15,
    }
}

/// Fallback type inference from the friendly name (device nodes don't always
/// expose a class-of-device code through SetupAPI).
/// 扩充：手柄 / 打印机 / 手机 / 触控笔不再落进「其他」。
fn device_type_from_name(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("mouse") || n.contains("鼠标") {
        return "鼠标";
    }
    if n.contains("keyboard") || n.contains("键盘") {
        return "键盘";
    }
    if n.contains("earphone")
        || n.contains("headphone")
        || n.contains("headset")
        || n.contains("earbuds")
        || n.contains("tws")
        || n.contains("mic")
        || n.contains("耳机")
        || n.contains("耳麦")
        || n.contains("麦克风")
        || n.contains("airpods")
        || n.contains("buds")
        || n.contains("speaker")
        || n.contains("音箱")
        || n.contains("sound")
    {
        return "音频";
    }
    if n.contains("watch") || n.contains("手表") {
        return "手表";
    }
    if n.contains("gamepad")
        || n.contains("controller")
        || n.contains("xbox")
        || n.contains("dualsense")
        || n.contains("手柄")
    {
        return "手柄";
    }
    if n.contains("printer") || n.contains("打印") {
        return "打印机";
    }
    if n.contains("phone") || n.contains("手机") {
        return "手机";
    }
    if (n.contains("pen") && !n.contains("open")) || n.contains("stylus") || n.contains("触控笔")
    {
        return "触控笔";
    }
    "其他"
}

/// 打开系统「蓝牙和其他设备」设置页（ms-settings:bluetooth）。
#[tauri::command]
pub fn open_bluetooth_settings(window: tauri::Window) -> Result<(), String> {
    #[cfg(windows)]
    {
        // 窗口闸门：拉起系统设置页是真实系统副作用，与连断/枚举同标准。
        if !crate::trusted_window(window.label()) {
            return Err("untrusted window".into());
        }
        std::process::Command::new("explorer")
            .arg("ms-settings:bluetooth")
            .spawn()
            .map(crate::files::reap_child)
            .map_err(|e| format!("无法打开蓝牙设置: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("仅支持 Windows".to_string())
    }
}

/// 快速连接/断开：classic 蓝牙走 `BluetoothSetServiceState` 启停服务，
/// 触发系统真正建立/断开链路。LE 设备（AirPods 等）的配对 API 复杂且不
/// 稳定，本命令按 classic 实现；前端在命令失败时回落到打开系统设置页。
///
/// 建链/断链是真实无线操作，可阻塞数秒；同步命令会冻结主线程，必须
/// spawn_blocking。
#[tauri::command]
pub async fn bluetooth_toggle_connection(
    window: tauri::Window,
    name: String,
    connect: bool,
) -> Result<bool, String> {
    // 与 get_bluetooth_devices 的隐私闸门同源：真实无线连断不该由远程
    // 页面（web-preview）驱动。拒绝走 Err（M2 统一语义）。
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        bluetooth_toggle_connection_blocking(name, connect)
    })
    .await
    .map_err(|e| format!("蓝牙操作任务失败: {e}"))?
}

fn bluetooth_toggle_connection_blocking(name: String, connect: bool) -> Result<bool, String> {
    // 服务启停顺序尝试：HID 覆盖鼠标/键盘/手柄，AudioSink/Headset 覆盖耳机。
    // 连接时启用第一个成功的服务即可；断开时对全部已知服务执行停用，
    // 最后一个服务停用后 Windows 会自动断开链路。
    const SERVICE_GUIDS: [GUID; 3] = [
        // HumanInterfaceDeviceServiceClassID
        GUID::from_u128(0x00001124_0000_1000_8000_00805f9b34fb),
        // AudioSinkServiceClassID (A2DP)
        GUID::from_u128(0x0000110b_0000_1000_8000_00805f9b34fb),
        // HeadsetAudioGatewayServiceClassID (HSP/HFP)
        GUID::from_u128(0x0000111f_0000_1000_8000_00805f9b34fb),
    ];
    const BLUETOOTH_SERVICE_DISABLE: u32 = 0x00;
    const BLUETOOTH_SERVICE_ENABLE: u32 = 0x01;

    unsafe {
        // 1. 拿到本机蓝牙无线电句柄（取第一台）。
        let mut radio = HANDLE::default();
        let find_params = BLUETOOTH_FIND_RADIO_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
        };
        let radio_find = BluetoothFindFirstRadio(&find_params, &mut radio)
            .map_err(|_| "未找到蓝牙适配器".to_string())?;

        // 2. 在 classic 设备列表中按名称定位目标。
        let search = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: true.into(),
            fReturnRemembered: true.into(),
            fReturnUnknown: false.into(),
            fReturnConnected: true.into(),
            fIssueInquiry: false.into(),
            cTimeoutMultiplier: 0,
            hRadio: radio,
        };
        let mut info = BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            ..Default::default()
        };
        let target = name.to_ascii_lowercase();
        let mut found: Option<BLUETOOTH_DEVICE_INFO> = None;
        // 设备枚举句柄与无线电句柄是两个不同的 find 句柄，各自关闭。
        if let Ok(dev_find) = BluetoothFindFirstDevice(&search, &mut info) {
            loop {
                let dev_name = String::from_utf16_lossy(&info.szName)
                    .trim_end_matches('\0')
                    .to_ascii_lowercase();
                if !dev_name.is_empty() && dev_name == target {
                    found = Some(info);
                    break;
                }
                if BluetoothFindNextDevice(dev_find, &mut info).is_err() {
                    break;
                }
            }
            let _ = BluetoothFindDeviceClose(dev_find);
        }
        let _ = BluetoothFindRadioClose(radio_find);

        let Some(info) = found else {
            let _ = windows::Win32::Foundation::CloseHandle(radio);
            return Err(
                "未在 classic 设备列表中找到该设备（LE 设备请在系统设置中操作）".to_string(),
            );
        };

        // 3. 启停服务。返回值非 ERROR_SUCCESS(0) 视为该服务不可用，逐个尝试。
        let mut any_success = false;
        for guid in &SERVICE_GUIDS {
            let flags = if connect {
                BLUETOOTH_SERVICE_ENABLE
            } else {
                BLUETOOTH_SERVICE_DISABLE
            };
            // BluetoothSetServiceState 直接吃 BLUETOOTH_DEVICE_INFO 指针，
            // 地址取自其内部的 Address 联合体。
            let rc = BluetoothSetServiceState(Some(radio), &info, guid, flags);
            if rc == 0 {
                any_success = true;
                // 连接：一个服务成功即可建立链路，避免对耳机误启 HID。
                if connect {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(radio);

        if any_success {
            Ok(true)
        } else {
            Err(if connect {
                "无法连接该设备（可能为 LE 设备，请在系统设置中连接）".to_string()
            } else {
                "无法断开该设备（可能为 LE 设备，请在系统设置中断开）".to_string()
            })
        }
    }
}

/// Reads a `DEVPROPKEY` string property. A fixed buffer is used instead of a
/// two-pass size query — the size-query pattern fails for these nodes.
fn query_property_string(
    dev_info: HDEVINFO,
    dev_data: &SP_DEVINFO_DATA,
    key: &DEVPROPKEY,
) -> Option<String> {
    let mut prop_type = DEVPROPTYPE(0);
    let mut buf = vec![0u8; 1024];
    let mut size = buf.len() as u32;
    unsafe {
        SetupDiGetDevicePropertyW(
            dev_info,
            dev_data,
            key,
            &mut prop_type,
            Some(&mut buf),
            Some(&mut size),
            0,
        )
    }
    .ok()?;
    let s = String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(
            buf.as_ptr() as *const u16,
            (size as usize).min(buf.len()) / 2,
        )
    })
    .trim_end_matches('\0')
    .trim()
    .to_string();
    (!s.is_empty()).then_some(s)
}

/// Reads the device instance id (e.g. `BTHLE\DEV_AABBCCDDEF...`).
fn query_instance_id(dev_info: HDEVINFO, dev_data: &SP_DEVINFO_DATA) -> Option<String> {
    let mut buf = vec![0u16; 512];
    // `SetupDiGetDeviceInstanceIdW`'s size argument is in CHARACTERS (wchar),
    // not bytes. Passing `len * 2` told the API the buffer held 1024 wchar when
    // it only holds 512 — a latent heap overflow on a long instance id. The
    // sibling helpers (`query_property_string`, `query_instance_name_from_desc`)
    // correctly pass `buf.len()`; this one was the outlier.
    let mut size = buf.len() as u32;
    unsafe { SetupDiGetDeviceInstanceIdW(dev_info, dev_data, Some(&mut buf), Some(&mut size)) }
        .ok()?;
    let s = String::from_utf16_lossy(&buf)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    (!s.is_empty()).then_some(s)
}

/// Reads the battery level (0–100) of a device instance, if reported.
/// 双键回退：主键为本机实测有效键，次键兼容其他 Windows 版本的变体。
fn query_battery(dev_info: HDEVINFO, dev_data: &SP_DEVINFO_DATA) -> Option<i32> {
    for key in battery_propkeys() {
        let mut prop_type = DEVPROPTYPE(0);
        let mut buffer = [0u8; 4];
        let mut required = 0u32;
        let fetched = unsafe {
            SetupDiGetDevicePropertyW(
                dev_info,
                dev_data,
                &key,
                &mut prop_type,
                Some(&mut buffer),
                Some(&mut required),
                0,
            )
        };
        // 该键上无属性（设备不报告电量，最常见情形）时换次键再试——此前 `.ok()?`
        // 会从整个函数提前返回，注释声明的「双键回退」从未真正执行过。
        if fetched.is_err() {
            continue;
        }
        if prop_type == DEVPROP_TYPE_BYTE {
            return Some(buffer[0] as i32);
        }
    }
    None
}

/// 从服务子节点的实例 id 提取设备 MAC（12 位十六进制串）。
///
/// 服务子节点（无 `DEV_` 前缀）的实例 id 内嵌设备 MAC，实测两种命名：
///  - `BTHENUM\{guid}_VID&…\7&2642B9EE&0&C4ADE8F93295_C00000000`（&0&<MAC>_）
///  - `BTHLEDEVICE\{guid}_<MAC>\8&28FE34A7&0&000F`（_MAC）
///
/// 无法走 CM_Get_Parent：Avrcp/HFP 子节点的 CM 父是蓝牙总线（`BTH\MS_BTHBRB`）而非
/// DEV 节点（实测）。滑动窗口取 12 位连续 hex，跳过蓝牙 SIG 基址保留段
/// `00805F9B34FB`（服务 GUID 固定后缀），且匹配必须贴非 hex 边界（`_`/`&`/`\`）。
fn mac_from_child_instance(instance: &str) -> Option<[u8; 6]> {
    let upper = instance.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    let is_hex = |b: u8| b.is_ascii_hexdigit();
    let mut best: Option<[u8; 6]> = None;
    for i in 0..bytes.len() {
        if i + 12 > bytes.len() {
            break;
        }
        let win = &upper[i..i + 12];
        if win == "00805F9B34FB" {
            continue;
        }
        // 12 位全是 hex，且左右边界（若存在）不是 hex —— 保证取到完整段。
        if !win.bytes().all(is_hex) {
            continue;
        }
        let left_ok = i == 0 || !is_hex(bytes[i - 1]);
        let right_ok = i + 12 == bytes.len() || !is_hex(bytes[i + 12]);
        if !left_ok || !right_ok {
            continue;
        }
        let mut mac = [0u8; 6];
        for (j, b) in mac.iter_mut().enumerate() {
            *b = u8::from_str_radix(&upper[i + j * 2..i + j * 2 + 2], 16).ok()?;
        }
        best = Some(mac);
    }
    best
}

/// Reads a boolean device property (e.g. DEVPKEY_Device_IsPresent).
fn query_bool_property(
    dev_info: HDEVINFO,
    dev_data: &SP_DEVINFO_DATA,
    key: &DEVPROPKEY,
) -> Option<bool> {
    let mut prop_type = DEVPROPTYPE(0);
    let mut buffer = [0u8; 4];
    let mut required = 0u32;
    unsafe {
        SetupDiGetDevicePropertyW(
            dev_info,
            dev_data,
            key,
            &mut prop_type,
            Some(&mut buffer),
            Some(&mut required),
            0,
        )
    }
    .ok()?;
    if prop_type == DEVPROP_TYPE_BOOLEAN {
        Some(buffer[0] != 0)
    } else {
        None
    }
}

/// Extracts the device MAC bytes (network order, matching the instance id hex)
/// from a Bluetooth node such as `BTHLE\DEV_001122334455\...` or
/// `BTHENUM\DEV_001122334455\...`.
fn mac_bytes_from_instance(instance: &str) -> Option<[u8; 6]> {
    let idx = instance.find("DEV_")?;
    let hex = instance.get(idx + 4..idx + 16)?;
    let mut out = [0u8; 6];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// 经典蓝牙 radio 枚举快照（`BluetoothFindFirstDevice` 一轮同时供两处消费）：
///  - `connected`：当前连接的设备 MAC 集（连接状态的兜底信号，经典设备专属）；
///  - `by_name`：小写设备名 → (任一记录连接, Class of Device)——名字推断不出
/// 类型时用 CoD 主类兜底（如「iKF-Pro」→ 音频）。
struct ClassicSnapshot {
    connected: HashSet<[u8; 6]>,
    by_name: HashMap<String, (bool, u32)>,
}

/// CoD 主类（bits 8–12）→ 显示类型（仅补名字推断的「其他」）。
fn device_type_from_cod(cod: u32) -> &'static str {
    match (cod >> 8) & 0x1F {
        0x02 => "手机",
        0x04 => "音频",
        0x05 => "外设",
        0x07 => "穿戴",
        _ => "其他",
    }
}

fn classic_radio_snapshot() -> ClassicSnapshot {
    let mut snap = ClassicSnapshot {
        connected: HashSet::new(),
        by_name: HashMap::new(),
    };
    let search = BLUETOOTH_DEVICE_SEARCH_PARAMS {
        dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
        fReturnAuthenticated: true.into(),
        fReturnRemembered: true.into(),
        fReturnUnknown: true.into(),
        fReturnConnected: true.into(),
        fIssueInquiry: false.into(),
        cTimeoutMultiplier: 0,
        hRadio: HANDLE::default(),
    };
    let mut info = BLUETOOTH_DEVICE_INFO {
        dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
        ..Default::default()
    };
    let find = match unsafe { BluetoothFindFirstDevice(&search, &mut info) } {
        Ok(f) => f,
        Err(_) => return snap,
    };
    let mut include = |info: &BLUETOOTH_DEVICE_INFO| {
        if info.fConnected.as_bool() {
            // `Address` is a union; the low 6 bytes of `ullLong` (little-endian)
            // hold the address LSB-first, i.e. `rgBytes[5]` is the most-significant
            // octet. The instance-id hex (DEV_…) is in display/big-endian order, so
            // we reverse to match `mac_bytes_from_instance`. (rgBytes[6..8] pad.)
            let b = unsafe { info.Address.Anonymous.ullLong }.to_le_bytes();
            let mac: [u8; 6] = [b[5], b[4], b[3], b[2], b[1], b[0]];
            snap.connected.insert(mac);
        }
        let name = String::from_utf16_lossy(&info.szName)
            .trim_end_matches('\0')
            .trim()
            .to_ascii_lowercase();
        if !name.is_empty() {
            let entry = snap.by_name.entry(name).or_insert((false, 0));
            entry.0 |= info.fConnected.as_bool();
            if entry.1 == 0 {
                entry.1 = info.ulClassofDevice;
            }
        }
    };
    include(&info);
    while unsafe { BluetoothFindNextDevice(find, &mut info) }.is_ok() {
        include(&info);
    }
    let _ = unsafe { BluetoothFindDeviceClose(find) };
    snap
}

/// Returns the real paired Bluetooth (classic + LE) devices of this PC,
/// including paired-but-disconnected ones. The full SetupAPI enumeration is
/// blocking work — spawned to the blocking pool so it neither freezes the
/// main thread nor squats on an async runtime worker (this command is
/// polled by the bluetooth widget).
#[tauri::command]
pub async fn get_bluetooth_devices(window: tauri::Window) -> Vec<BluetoothDevice> {
    // 隐私闸门（M3）：低信任窗不应能枚举蓝牙设备。
    if !crate::trusted_window(window.label()) {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(get_bluetooth_devices_blocking)
        .await
        .unwrap_or_default()
}

fn get_bluetooth_devices_blocking() -> Vec<BluetoothDevice> {
    let mut devices: Vec<BluetoothDevice> = Vec::new();
    /// One dedup bucket per display name: a stored entry plus how it was seen.
    struct Seen {
        idx: usize,
        is_le: bool,
        mac: [u8; 6],
        /// Already merged with its dual-mode counterpart; reject further merges
        /// so a genuinely distinct same-named device creates its own entry.
        dual_merged: bool,
    }
    let mut by_name: HashMap<String, Vec<Seen>> = HashMap::new();
    // 经典 radio 快照：连接兜底集 + 名字→(连接, CoD) 类型推断表。
    let classic = classic_radio_snapshot();
    let connected = classic.connected;
    // 服务子节点贡献（按父设备 MAC 归并）：电量取首个非空读数；任一子节点
    // 报 IsConnected 即视为连接（同一设备的 HID/A2DP 子节点分别反映链路）。
    let mut child_battery: HashMap<[u8; 6], i32> = HashMap::new();
    let mut child_connected: HashSet<[u8; 6]> = HashSet::new();
    // 与 devices 平行的 MAC 表：循环结束后据此归并子节点贡献。
    let mut macs: Vec<Option<[u8; 6]>> = Vec::new();

    // No DIGCF_PRESENT: present-only enumeration dropped the DEV_ node of every
    // disconnected device, so paired devices simply vanished from the list.
    // Enumerating all nodes (including phantom ones) keeps them visible as
    // paired-but-disconnected.

    // 全类枚举（实测必要）：iKF 等经典音频设备的 AVRCP 电量写在 HFP
    // `111E` HCIBYPASS 子节点上，而该节点属于 **System** 类；1101 串行子节点属
    // Ports 类——服务子节点横跨多个设备类，按类过滤必然漏。全类枚举一次覆盖
    // （全系统设备节点数百个，instance_id 查询代价可忽略）；非蓝牙节点在子
    // 节点分支里被 `BTH` 前缀守卫直接跳过。
    let Ok(dev_info) = (unsafe {
        SetupDiGetClassDevsW(
            None,
            None,
            None,
            SETUP_DI_GET_CLASS_DEVS_FLAGS(DIGCF_ALLCLASSES.0),
        )
    }) else {
        return devices;
    };

    {
        let mut index = 0u32;
        loop {
            let mut dev_data = SP_DEVINFO_DATA {
                cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if unsafe { SetupDiEnumDeviceInfo(dev_info, index, &mut dev_data) }.is_err() {
                break;
            }
            index += 1;

            let Some(instance) = query_instance_id(dev_info, &dev_data) else {
                continue;
            };
            // Real device nodes (classic `BTHENUM\DEV_…`, LE `BTHLE\DEV_…`) become
            // entries below. Everything else in the class is a SERVICE-LEVEL CHILD
            // (`BTHENUM\{service-guid}_…` / `BTHLE\{service-guid}_…`) — these carry
            // the battery / connection signals on classic devices but have no DEV_
            // prefix (the old comment claiming they did was wrong): attribute them
            // to their parent device via DEVPKEY_Device_Parent.
            let is_le = instance.starts_with("BTHLE\\DEV_");
            let is_classic = instance.starts_with("BTHENUM\\DEV_");
            if !is_le && !is_classic {
                // 服务子节点：从实例 id 内嵌 MAC 归并电量/连接到所属设备。
                // 全类枚举会扫到海量非蓝牙节点，BTH 前缀守卫先行挡掉。
                if !instance.to_ascii_uppercase().starts_with("BTH") {
                    continue;
                }
                if let Some(mac) = mac_from_child_instance(&instance) {
                    if let Some(b) = query_battery(dev_info, &dev_data) {
                        child_battery.entry(mac).or_insert(b);
                    }
                    if query_bool_property(dev_info, &dev_data, &is_connected_propkey())
                        .unwrap_or(false)
                    {
                        child_connected.insert(mac);
                    }
                }
                continue;
            }
            let Some(name) =
                query_property_string(dev_info, &dev_data, &DEVPKEY_DEVICE_FRIENDLY_NAME)
                    .or_else(|| query_instance_name_from_desc(dev_info, &dev_data))
            else {
                continue;
            };

            let battery = query_battery(dev_info, &dev_data);
            // Connection state, two independent signals:
            //  1. DEVPKEY_Device_IsConnected — authoritative for classic AND LE.
            //  2. Classic radio API (`fConnected`) — fallback for nodes that don't
            //     expose the property; only ever reports classic devices.
            let node_connected =
                query_bool_property(dev_info, &dev_data, &is_connected_propkey()).unwrap_or(false);
            let mac = mac_bytes_from_instance(&instance);
            let classic_connected = mac.map(|m| connected.contains(&m)).unwrap_or(false);
            let node_connected = node_connected || classic_connected;

            let key = name.to_ascii_lowercase();
            let bucket = by_name.entry(key).or_default();

            // 1. Same MAC (e.g. a service-level child node of a connected device):
            //    same physical node family — merge signals, never a new entry.
            if let Some(seen) = mac.and_then(|m| bucket.iter_mut().find(|s| s.mac == m)) {
                let entry = &mut devices[seen.idx];
                entry.connected |= node_connected;
                if entry.battery.is_none() {
                    entry.battery = battery;
                }
                continue;
            }

            // 2. Dual-mode counterpart: same name, other transport, different MAC
            //    (LE identity differs from classic identity). Merge — a device
            //    connected via either link must show as connected.
            if let Some(seen) = bucket
                .iter_mut()
                .find(|s| s.is_le != is_le && !s.dual_merged)
            {
                let entry = &mut devices[seen.idx];
                entry.connected |= node_connected;
                // The LE side carries the GATT battery level; prefer it.
                if is_le {
                    entry.battery = battery.or(entry.battery);
                } else if entry.battery.is_none() {
                    entry.battery = battery;
                }
                seen.dual_merged = true;
                continue;
            }

            // 3. A genuinely distinct device (including two devices sharing a name,
            //    e.g. a same-model keyboard + mouse pair): its own entry.
            bucket.push(Seen {
                idx: devices.len(),
                is_le,
                mac: mac.unwrap_or([0; 6]),
                dual_merged: false,
            });
            macs.push(mac);
            // 类型：名字推断优先；「其他」时用经典 radio 的 CoD 主类兜底
            // （iKF / 品牌耳机等名字不含通用词的音频设备不再落「其他」）。
            let mut device_type = device_type_from_name(&name).to_string();
            if device_type == "其他" {
                if let Some((_, cod)) = classic.by_name.get(&name.to_ascii_lowercase()) {
                    if *cod != 0 {
                        device_type = device_type_from_cod(*cod).to_string();
                    }
                }
            }
            devices.push(BluetoothDevice {
                name: name.clone(),
                connected: node_connected,
                device_type,
                battery,
            });
        }
    }
    let _ = unsafe { SetupDiDestroyDeviceInfoList(dev_info) };

    // 子节点归并：电量（DEV/LE 节点自身没有读数时）与连接信号。
    for (i, d) in devices.iter_mut().enumerate() {
        let Some(Some(mac)) = macs.get(i).copied() else {
            continue;
        };
        if d.battery.is_none() {
            if let Some(b) = child_battery.get(&mac) {
                d.battery = Some(*b);
            }
        }
        if child_connected.contains(&mac) {
            d.connected = true;
        }
    }
    devices
}

/// Fallback: derive a display name from the device description when the friendly
/// name property is missing on a node.
fn query_instance_name_from_desc(dev_info: HDEVINFO, dev_data: &SP_DEVINFO_DATA) -> Option<String> {
    let mut buf = vec![0u8; 1024];
    let mut size = buf.len() as u32;
    unsafe {
        SetupDiGetDeviceRegistryPropertyW(
            dev_info,
            dev_data,
            SPDRP_DEVICEDESC,
            None,
            Some(&mut buf),
            Some(&mut size),
        )
    }
    .ok()?;
    let s = String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(
            buf.as_ptr() as *const u16,
            (size as usize).min(buf.len()) / 2,
        )
    })
    .trim_end_matches('\0')
    .trim()
    .to_string();
    (!s.is_empty()).then_some(s)
}

/* ------------------------------------------------------------------ */
/* 真实采集验证：实机枚举并打印蓝牙设备，与 Windows 设置里的蓝牙列表核对。 */
/* 无蓝牙硬件的机器允许空列表，但绝不能返回伪造/空白/失控设备。           */
/* ------------------------------------------------------------------ */
#[cfg(test)]
mod verify {
    use super::get_bluetooth_devices_blocking;

    #[test]
    fn prints_real_bluetooth_devices() {
        let devices = get_bluetooth_devices_blocking();
        for d in &devices {
            eprintln!(
                "[verify-bt] name={} type={} connected={} battery={:?}",
                d.name, d.device_type, d.connected, d.battery
            );
        }
        // 关键：不能出现空白/失控设备名；空列表（无蓝牙）合法。
        let weird = devices.iter().filter(|d| d.name.trim().is_empty()).count();
        assert_eq!(weird, 0, "bluetooth device names must not be blank");
    }
}
