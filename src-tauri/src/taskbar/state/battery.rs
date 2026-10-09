//! 省电模式状态源（OnPowerBroadcast 事件 +
//! 初始 GetSystemPowerStatus）。
//!
//! 事件线：CORE 的 win_watcher 消息窗已
//! `RegisterPowerSettingNotification(GUID_POWER_SAVING_STATUS)`，切换以
//! `WM_POWERBROADCAST/PBT_POWERSETTINGCHANGE` 到达，原始 (event, data)
//! 经 `SystemEventCallback::on_power_broadcast` 透传——本模块只负责解析
//! POWERBROADCAST_SETTING（纯函数，可单测）。初始值：
//! `GetSystemPowerStatus().SystemStatusFlag`（非 0 = 省电开启）。

/// GUID_POWER_SAVING_STATUS {E00958C0--4ACE--FECCED2EEEA5}（与
/// win_watcher.rs 手写常量同值，避免互相依赖）。
pub const GUID_POWER_SAVING_STATUS_U128: u128 = 0xe00958c0_c213_4ace_ac77_fecced2eeea5;

/// PBT_POWERSETTINGCHANGE（winuser.h；windows crate 的常量在
/// Win32_System_Power feature 下重复定义，本地别名保持独立）。
pub const PBT_POWERSETTING_CHANGE: u32 = 0x8013;

/// 初始省电状态（GetSystemPowerStatus；读取失败按关闭——
/// 保持原值等价，原值初始即 false）。
#[cfg(windows)]
pub fn initial_battery_saver() -> bool {
    // SAFETY: 输出结构体按值返回的只读查询。
    unsafe {
        let mut status = windows::Win32::System::Power::SYSTEM_POWER_STATUS::default();
        windows::Win32::System::Power::GetSystemPowerStatus(&mut status).is_ok()
            && status.SystemStatusFlag != 0
    }
}

#[cfg(not(windows))]
pub fn initial_battery_saver() -> bool {
    false
}

/// 解析 `on_power_broadcast(event, data)`：PBT_POWERSETTINGCHANGE 且
/// PowerSetting == GUID_POWER_SAVING_STATUS 且 DataLength == 4 时返回
/// `Some(开启)`，其余 None（不关心 / 坏负载）。纯函数。
///
/// `data` = lParam 原值，指向 POWERBROADCAST_SETTING {
///   PowerSetting: GUID(16B), DataLength: u32, Data: [u8] }。
pub fn parse_power_broadcast(event: u32, data: isize) -> Option<bool> {
    if event != PBT_POWERSETTING_CHANGE || data == 0 {
        return None;
    }
    // SAFETY: WM_POWERBROADCAST 约定 data 指向系统构造的
    // POWERBROADCAST_SETTING；先校验 DataLength==4 再读满 24 字节
    // （GUID + DataLength + 4 字节 DWORD Data）。
    unsafe {
        let p = data as *const u8;
        let setting = std::slice::from_raw_parts(p, 16);
        let expected = GUID_POWER_SAVING_STATUS_U128.to_le_bytes();
        if setting != expected {
            return None;
        }
        let len = u32::from_le_bytes([*p.add(16), *p.add(17), *p.add(18), *p.add(19)]);
        if len != 4 {
            return None;
        }
        // Data 是 DWORD：按 4 字节整体判非零，不只看首字节。
        let value = u32::from_le_bytes([*p.add(20), *p.add(21), *p.add(22), *p.add(23)]);
        Some(value != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在栈上构造 POWERBROADCAST_SETTING 并解析（生命周期覆盖调用期）。
    fn parse_stack(guid: u128, data: &[u8], event: u32) -> Option<bool> {
        let mut buf = [0u8; 24];
        buf[..16].copy_from_slice(&guid.to_le_bytes());
        buf[16..20].copy_from_slice(&(data.len() as u32).to_le_bytes());
        buf[20..20 + data.len()].copy_from_slice(data);
        parse_power_broadcast(event, buf.as_ptr() as isize)
    }

    #[test]
    fn parses_saving_status_change_payloads() {
        assert_eq!(
            parse_stack(
                GUID_POWER_SAVING_STATUS_U128,
                &[1, 0, 0, 0],
                PBT_POWERSETTING_CHANGE
            ),
            Some(true)
        );
        assert_eq!(
            parse_stack(
                GUID_POWER_SAVING_STATUS_U128,
                &[0, 0, 0, 0],
                PBT_POWERSETTING_CHANGE
            ),
            Some(false)
        );
    }

    #[test]
    fn ignores_other_settings_and_events() {
        let other = 0x1234_5678_90ab_cdef_1111_2222_3333_4444;
        assert_eq!(
            parse_stack(other, &[1, 0, 0, 0], PBT_POWERSETTING_CHANGE),
            None
        );
        assert_eq!(
            parse_stack(
                GUID_POWER_SAVING_STATUS_U128,
                &[1, 0, 0],
                PBT_POWERSETTING_CHANGE
            ),
            None,
            "DataLength != 4 忽略"
        );
        assert_eq!(
            parse_stack(GUID_POWER_SAVING_STATUS_U128, &[1, 0, 0, 0], 0x8012),
            None,
            "其他 PBT 事件忽略"
        );
        assert_eq!(parse_power_broadcast(PBT_POWERSETTING_CHANGE, 0), None);
    }
}
