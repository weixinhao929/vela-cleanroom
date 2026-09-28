/**
 * [MSET]（ZTools 借鉴 #3）Windows 设置深链指令表 + 搜索。
 *
 * ZTools 内置 87 个 ms-settings: URI（12 分类）让启动器直达任意设置页；
 * Vela 的命令面板此前只有蓝牙页一个硬编码深链。这里按 Win11 设置应用的
 * 分区整理一份常用子集（名称 / 别名 / 分类），经 open_path 的
 * `ms-settings:` 分支交给 Shell 打开。
 *
 * 匹配三级：中文名子串 > 英文别名子串 > 拼音首字母（pinyinInitials，
 * 与应用搜索同款能力）。全部为纯函数，单测覆盖。
 */
import { pinyinInitials } from "./pinyin";

export type MsSettingEntry = {
  /** 深链页 id（open_path 收 `ms-settings:<page>`）。 */
  page: string;
  /** 中文名（主匹配键，直接展示）。 */
  zh: string;
  /** 英文别名（辅助匹配）。 */
  en: string;
  /** 分类（面板分组显示用）。 */
  cat: string;
};

/** 分类顺序即面板分组顺序（对齐 Win11 设置应用导航）。 */
export const MS_SETTINGS_CATEGORIES = [
  "系统",
  "蓝牙和其他设备",
  "网络和 Internet",
  "个性化",
  "应用",
  "账户",
  "时间和语言",
  "游戏",
  "辅助功能",
  "隐私和安全性",
  "Windows 更新"
] as const;

export const MS_SETTINGS: readonly MsSettingEntry[] = [
  // ── 系统 ──
  { page: "display", zh: "屏幕显示", en: "display", cat: "系统" },
  { page: "sound", zh: "声音", en: "sound volume", cat: "系统" },
  { page: "notifications", zh: "通知", en: "notifications", cat: "系统" },
  { page: "focusassist", zh: "勿扰专注助手", en: "focus assist", cat: "系统" },
  { page: "powersleep", zh: "电源和电池", en: "power battery sleep", cat: "系统" },
  { page: "storage", zh: "存储", en: "storage sense disk", cat: "系统" },
  { page: "about", zh: "系统信息关于", en: "about pc info", cat: "系统" },
  { page: "multitasking", zh: "多任务Snap布局", en: "multitasking snap", cat: "系统" },
  { page: "remotedesktop", zh: "远程桌面", en: "remote desktop", cat: "系统" },
  { page: "clipboard", zh: "剪贴板", en: "clipboard", cat: "系统" },
  { page: "nightlight", zh: "夜间模式", en: "night light", cat: "系统" },
  { page: "projection", zh: "投影", en: "project wireless display", cat: "系统" },
  { page: "taskbar", zh: "任务栏", en: "taskbar", cat: "个性化" },
  // ── 蓝牙和其他设备 ──
  { page: "bluetooth", zh: "蓝牙", en: "bluetooth", cat: "蓝牙和其他设备" },
  { page: "devices", zh: "设备管理器", en: "device manager", cat: "蓝牙和其他设备" },
  { page: "printers", zh: "打印机和扫描仪", en: "printers scanners", cat: "蓝牙和其他设备" },
  { page: "mousetouchpad", zh: "鼠标和触摸板", en: "mouse touchpad", cat: "蓝牙和其他设备" },
  { page: "typing", zh: "输入", en: "typing input", cat: "蓝牙和其他设备" },
  { page: "autoplay", zh: "自动播放", en: "autoplay", cat: "蓝牙和其他设备" },
  { page: "usb", zh: "USB", en: "usb", cat: "蓝牙和其他设备" },
  // ── 网络和 Internet ──
  { page: "network", zh: "网络状态", en: "network status", cat: "网络和 Internet" },
  { page: "network-status", zh: "网络连接状态", en: "connection status", cat: "网络和 Internet" },
  { page: "ethernet", zh: "以太网", en: "ethernet", cat: "网络和 Internet" },
  { page: "wifi", zh: "Wi-Fi 无线网", en: "wifi wlan", cat: "网络和 Internet" },
  { page: "vpn", zh: "VPN", en: "vpn", cat: "网络和 Internet" },
  { page: "proxy", zh: "代理", en: "proxy", cat: "网络和 Internet" },
  { page: "airplane-mode", zh: "飞行模式", en: "airplane mode", cat: "网络和 Internet" },
  { page: "mobilehotspot", zh: "移动热点", en: "mobile hotspot", cat: "网络和 Internet" },
  { page: "datausage", zh: "数据使用量", en: "data usage", cat: "网络和 Internet" },
  { page: "advanced-network-settings", zh: "高级网络设置", en: "advanced network", cat: "网络和 Internet" },
  // ── 个性化 ──
  { page: "personalization-background", zh: "桌面背景壁纸", en: "background wallpaper", cat: "个性化" },
  { page: "colors", zh: "颜色主题色", en: "colors accent", cat: "个性化" },
  { page: "lockscreen", zh: "锁屏界面", en: "lock screen", cat: "个性化" },
  { page: "themes", zh: "主题", en: "themes", cat: "个性化" },
  { page: "fonts", zh: "字体", en: "fonts", cat: "个性化" },
  { page: "start", zh: "开始菜单", en: "start menu", cat: "个性化" },
  { page: "personalization-start-places", zh: "开始固定文件夹", en: "start folders", cat: "个性化" },
  // ── 应用 ──
  { page: "appsfeatures", zh: "已安装应用", en: "installed apps features", cat: "应用" },
  { page: "defaultapps", zh: "默认应用", en: "default apps", cat: "应用" },
  { page: "appsfeatures-web", zh: "网页应用PWA", en: "web apps", cat: "应用" },
  { page: "startupapps", zh: "开机启动项", en: "startup apps", cat: "应用" },
  { page: "advanced-apps", zh: "应用高级设置", en: "advanced apps", cat: "应用" },
  { page: "maps", zh: "离线地图", en: "offline maps", cat: "应用" },
  // ── 账户 ──
  { page: "yourinfo", zh: "账户信息", en: "account info", cat: "账户" },
  { page: "signinoptions", zh: "登录选项", en: "sign in options", cat: "账户" },
  { page: "emailandaccounts", zh: "电子邮件和账户", en: "email accounts", cat: "账户" },
  { page: "family-group", zh: "家庭组", en: "family group", cat: "账户" },
  { page: "otherusers", zh: "其他用户", en: "other users", cat: "账户" },
  // ── 时间和语言 ──
  { page: "dateandtime", zh: "日期和时间", en: "date time", cat: "时间和语言" },
  { page: "regionformatting", zh: "区域格式", en: "region format", cat: "时间和语言" },
  { page: "keyboard", zh: "键盘语言", en: "keyboard language", cat: "时间和语言" },
  { page: "language", zh: "语言添加", en: "language add", cat: "时间和语言" },
  { page: "speech", zh: "语音", en: "speech tts", cat: "时间和语言" },
  { page: "typing-suggestions", zh: "输入建议", en: "typing suggestions", cat: "时间和语言" },
  // ── 游戏 ──
  { page: "gaming-gamebar", zh: "游戏栏Xbox Game Bar", en: "game bar xbox", cat: "游戏" },
  { page: "gaming-captures", zh: "游戏录制截屏", en: "game dvr captures", cat: "游戏" },
  { page: "gaming-gamemode", zh: "游戏模式", en: "game mode", cat: "游戏" },
  { page: "gaming-xboxnetworking", zh: "Xbox 网络", en: "xbox networking", cat: "游戏" },
  // ── 辅助功能 ──
  { page: "easeofaccess-display", zh: "辅助显示放大镜", en: "accessibility display magnifier", cat: "辅助功能" },
  { page: "easeofaccess-audio", zh: "辅助音频旁白", en: "accessibility audio narrator", cat: "辅助功能" },
  { page: "easeofaccess-keyboard", zh: "辅助键盘粘滞键", en: "accessibility keyboard sticky", cat: "辅助功能" },
  { page: "easeofaccess-mouse", zh: "辅助鼠标指针大小", en: "accessibility mouse pointer", cat: "辅助功能" },
  { page: "easeofaccess-narrator", zh: "讲述人", en: "narrator screen reader", cat: "辅助功能" },
  { page: "easeofaccess-colorfilter", zh: "颜色滤镜色盲", en: "color filter", cat: "辅助功能" },
  { page: "easeofaccess-textsize", zh: "文本大小", en: "text size", cat: "辅助功能" },
  { page: "easeofaccess-contrast", zh: "对比度主题", en: "high contrast", cat: "辅助功能" },
  // ── 隐私和安全性 ──
  { page: "privacy", zh: "隐私概览", en: "privacy", cat: "隐私和安全性" },
  { page: "privacy-location", zh: "位置权限", en: "location", cat: "隐私和安全性" },
  { page: "privacy-camera", zh: "相机权限", en: "camera", cat: "隐私和安全性" },
  { page: "privacy-microphone", zh: "麦克风权限", en: "microphone", cat: "隐私和安全性" },
  { page: "privacy-notifications", zh: "通知权限", en: "notifications permission", cat: "隐私和安全性" },
  { page: "privacy-speech", zh: "语音识别权限", en: "speech recognition", cat: "隐私和安全性" },
  { page: "privacy-backgroundapps", zh: "后台应用权限", en: "background apps", cat: "隐私和安全性" },
  { page: "privacy-activityhistory", zh: "活动历史记录", en: "activity history timeline", cat: "隐私和安全性" },
  { page: "windowsdefender", zh: "Windows 安全中心", en: "windows security defender", cat: "隐私和安全性" },
  { page: "findmydevice", zh: "查找我的设备", en: "find my device", cat: "隐私和安全性" },
  { page: "backup", zh: "Windows 备份", en: "backup sync", cat: "隐私和安全性" },
  // ── Windows 更新 ──
  { page: "windowsupdate", zh: "Windows 更新", en: "windows update", cat: "Windows 更新" },
  { page: "windowsupdate-options", zh: "更新高级选项", en: "update options", cat: "Windows 更新" },
  { page: "windowsupdate-history", zh: "更新历史记录", en: "update history", cat: "Windows 更新" },
  { page: "windowsupdate-optionalupdates", zh: "可选更新", en: "optional updates", cat: "Windows 更新" },
  { page: "recovery", zh: "恢复重置", en: "recovery reset", cat: "Windows 更新" },
  { page: "activation", zh: "激活", en: "activation license", cat: "Windows 更新" },
  { page: "troubleshoot", zh: "疑难解答", en: "troubleshoot", cat: "Windows 更新" },
  { page: "deviceusage", zh: "设备使用情况", en: "device usage", cat: "Windows 更新" }
];

/** 预计算拼音首字母（模块加载一次；表是常量）。 */
const PINYIN_BY_PAGE = new Map<string, string>(MS_SETTINGS.map((e) => [e.page, pinyinInitials(e.zh)]));

/** 单条匹配：中文子串 > 英文别名子串 > 拼音首字母子串（大小写不敏感）。 */
export function msSettingMatches(entry: MsSettingEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (entry.zh.toLowerCase().includes(q)) return true;
  if (entry.en.toLowerCase().includes(q)) return true;
  const py = PINYIN_BY_PAGE.get(entry.page) ?? pinyinInitials(entry.zh);
  return py.includes(q);
}

/** 按查询词过滤设置页（分组顺序内按表序；limit 防撑爆面板）。 */
export function searchMsSettings(query: string, limit = 12): MsSettingEntry[] {
  const q = query.trim();
  if (!q) return [];
  const out: MsSettingEntry[] = [];
  for (const e of MS_SETTINGS) {
    if (msSettingMatches(e, q)) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}
