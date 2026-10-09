/**
 * 设置搜索索引：把散落在各设置页里的设置项收敛成可检索的平铺列表。
 * 词条全部用中文 key（与 i18n 约定一致），keywords 供模糊匹配。
 */
import { t } from "../../i18n-lite";

export type SettingsSearchEntry = {
  /** 目标页面 id（Page 为 string：静态页、`view-<id>`、`widget-config-<id>` 等）。 */
  page: string;
  /** 页面分组标题（用于结果分组显示）。 */
  group: string;
  /** 结果标题：页面名或具体设置项名。 */
  title: string;
  /** 额外匹配关键词（小写比较）。 */
  keywords?: string[];
};

/** 静态索引：按页面分块维护，新增设置项时在对应块里补一行即可。 */
const INDEX: SettingsSearchEntry[] = [
  // 常规
  { page: "general", group: "常规", title: "开机启动", keywords: ["autostart", "自启", "boot"] },
  { page: "general", group: "常规", title: "显示桌面图标", keywords: ["desktop icons", "图标"] },
  { page: "general", group: "常规", title: "游戏时暂停", keywords: ["game", "全屏", "暂停"] },
  { page: "general", group: "常规", title: "应用显示语言", keywords: ["language", "english", "中文"] },
  /* 索引补全：常规页后加的设置项此前搜不到——含整个「快捷键」分区。 */
  {
    page: "general",
    group: "常规",
    title: "双击桌面切换显示",
    keywords: ["double click", "desktop", "双击", "桌面", "显隐"]
  },
  {
    page: "general",
    group: "常规",
    title: "减少特效",
    keywords: ["reduce effects", "blur", "特效", "毛玻璃", "性能"]
  },
  { page: "general", group: "常规", title: "新手引导", keywords: ["onboarding", "guide", "引导", "教程", "重看"] },
  {
    page: "general",
    group: "常规",
    title: "超级面板",
    keywords: ["super panel", "取词", "右键", "长按", "面板"]
  },
  { page: "general", group: "常规", title: "长按时长", keywords: ["duration", "长按", "时长", "延迟"] },
  {
    page: "general",
    group: "常规",
    title: "双击修饰键呼出面板",
    keywords: ["double tap", "ctrl", "alt", "修饰键", "呼出"]
  },
  {
    page: "general",
    group: "常规",
    title: "热键唤醒黑名单",
    keywords: ["blacklist", "hotkey", "黑名单", "热键", "排除", "游戏"]
  },
  /* 全局媒体行为此前只挂在「正在播放」实例配置页——删掉全部媒体
     小组件后搜也搜不到、关也关不掉，补常规页词条。 */
  {
    page: "general",
    group: "常规",
    title: "媒体行为",
    keywords: ["media", "music", "audio", "媒体", "音乐", "播放", "独占"]
  },
  {
    page: "general",
    group: "常规",
    title: "独占播放",
    keywords: ["exclusive", "pause others", "独占", "自动暂停"]
  },
  {
    page: "general",
    group: "常规",
    title: "专注时暂停音乐",
    keywords: ["focus", "pomodoro", "专注", "番茄", "暂停", "音乐"]
  },
  {
    page: "general",
    group: "常规",
    title: "隐藏播放源",
    keywords: ["hide", "block", "blacklist", "隐藏", "黑名单", "播放源", "会话"]
  },
  {
    page: "general",
    group: "常规",
    title: "快捷键",
    keywords: ["shortcut", "hotkey", "keybinding", "快捷键", "键位", "热键", "组合键", "录制"]
  },
  {
    page: "general",
    group: "常规",
    title: "崩溃统计",
    keywords: ["crash", "stats", "崩溃", "统计", "panic"]
  },
  {
    page: "general",
    group: "常规",
    title: "启动耗时",
    keywords: ["boot", "startup", "performance", "启动", "耗时", "首帧"]
  },
  { page: "general", group: "常规", title: "运行日志", keywords: ["log", "日志", "诊断"] },
  { page: "widgets", group: "小组件", title: "累计专注起始日期", keywords: ["analytics", "统计", "起始", "专注统计"] },
  /* 编组/重命名的可达性——设置搜索此前搜「编组/组名」无结果。 */
  { page: "widgets", group: "小组件", title: "编组管理", keywords: ["group", "编组", "组名", "成员", "解散", "标签"] },
  { page: "widgets", group: "小组件", title: "重命名小组件", keywords: ["rename", "名称", "改名", "标签名"] },
  {
    page: "widgets",
    group: "小组件",
    title: "每日目标方式",
    keywords: ["pomodoro", "goal", "番茄钟", "目标", "轮数", "时长"]
  },
  {
    page: "widgets",
    group: "小组件",
    title: "每日专注目标",
    keywords: ["pomodoro", "goal", "番茄钟", "目标", "轮", "分钟"]
  },
  { page: "general", group: "常规", title: "数据存储", keywords: ["storage", "sqlite", "路径"] },
  { page: "general", group: "常规", title: "崩溃日志", keywords: ["crash", "diagnostic", "诊断", "错误"] },
  { page: "general", group: "常规", title: "重置 Vela", keywords: ["reset", "恢复出厂"] },
  /* 索引补全：剪贴板隐私五开关 + 清空 / 目录在常规页「剪贴板历史」区，
     此前搜「剪贴板 / clipboard / 隐私」全部无结果。 */
  {
    page: "general",
    group: "常规",
    title: "剪贴板历史",
    keywords: ["clipboard", "clip", "paste", "剪贴板", "复制", "粘贴", "历史", "隐私", "记录"]
  },
  { page: "general", group: "常规", title: "记录图片", keywords: ["clipboard", "截图", "图片", "screenshot"] },
  { page: "general", group: "常规", title: "记录文件", keywords: ["clipboard", "文件", "files", "explorer"] },
  { page: "general", group: "常规", title: "记录来源进程", keywords: ["clipboard", "来源", "进程", "source", "app"] },
  { page: "general", group: "常规", title: "复制链接快捷打开", keywords: ["clipboard", "链接", "快开", "link", "url"] },
  { page: "general", group: "常规", title: "清空剪贴板历史", keywords: ["clipboard", "清空", "删除", "clear"] },
  // [ANTICAPTURE]
  {
    page: "display",
    group: "隐私",
    title: "在屏幕共享/录屏中隐藏桌面层",
    keywords: ["capture", "screen", "record", "share", "录屏", "共享", "截图", "防捕获"]
  },
  // [CLICK-SHIELD]/[HUD-GIVEWAY]
  {
    page: "general",
    group: "常规",
    title: "弹窗关闭后屏蔽误连点",
    keywords: ["click shield", "misclick", "连点", "穿透", "防误触"]
  },
  {
    page: "general",
    group: "常规",
    title: "鼠标悬停时 HUD 淡出避让",
    keywords: ["giveway", "hover", "fade", "hud", "淡出", "避让"]
  },
  // [DOCK-COVER]
  { page: "dock", group: "背景", title: "音乐封面背景", keywords: ["cover", "music", "album", "封面", "背景"] },
  {
    page: "dock",
    group: "背景",
    title: "专注背景文件夹",
    keywords: ["focus", "folder", "background", "专注", "背景", "文件夹"]
  },
  // 样式
  {
    page: "style",
    group: "样式",
    title: "主题预设",
    keywords: ["preset", "theme", "主题", "默认", "终端", "午夜", "日光", "纸张", "retro"]
  },
  { page: "style", group: "样式", title: "主题模式", keywords: ["theme", "dark", "light", "深色", "浅色", "系统"] },
  {
    page: "style",
    group: "样式",
    title: "浮窗深浅",
    keywords: ["floating", "浮窗", "设置窗", "速记窗", "独立明暗", "split theme"]
  },
  {
    page: "style",
    group: "样式",
    title: "自定义配色",
    keywords: ["custom colors", "自定义主题", "底色", "文字色", "强调色"]
  },
  { page: "style", group: "样式", title: "壁纸", keywords: ["wallpaper", "壁纸", "背景", "桌面", "更换"] },
  {
    page: "style",
    group: "样式",
    title: "壁纸文件夹",
    keywords: ["wallpaper folder", "最近使用", "recent", "浏览照片"]
  },
  {
    page: "style",
    group: "样式",
    title: "从图片提取色板",
    keywords: ["palette", "色板", "取色", "extract", "设为主色"]
  },
  {
    page: "style",
    group: "样式",
    title: "在线预设画廊",
    keywords: ["gallery", "画廊", "预设包", "下载", "install", "preset"]
  },
  {
    page: "style",
    group: "样式",
    title: "主题切换动效",
    keywords: ["ink", "水墨", "切换动画", "transition", "动效时长", "晕开"]
  },
  { page: "style", group: "样式", title: "主色", keywords: ["accent", "颜色", "color"] },
  { page: "style", group: "样式", title: "字体", keywords: ["font"] },
  { page: "style", group: "样式", title: "字号", keywords: ["font size", "文字大小"] },
  { page: "style", group: "样式", title: "圆角", keywords: ["radius", "corner"] },
  { page: "style", group: "样式", title: "间距", keywords: ["spacing", "padding"] },
  { page: "style", group: "样式", title: "不透明度", keywords: ["opacity", "透明"] },
  { page: "style", group: "样式", title: "毛玻璃模糊", keywords: ["blur", "glass", "玻璃"] },
  { page: "style", group: "样式", title: "界面缩放", keywords: ["zoom", "scale", "缩放"] },
  { page: "style", group: "样式", title: "设置窗口不透明度", keywords: ["settings opacity"] },
  // 动画
  {
    page: "animation",
    group: "动画",
    title: "启用动画",
    keywords: ["animation", "enable", "开关", "总开关", "transition", "过渡"]
  },
  {
    page: "animation",
    group: "动画",
    title: "动效模式",
    keywords: ["fx", "effects", "特效", "增强", "标准", "减少动态", "reduced"]
  },
  { page: "animation", group: "动画", title: "动画速度", keywords: ["speed", "duration", "快", "慢"] },
  { page: "animation", group: "动画", title: "动画时长微调", keywords: ["duration fine tune", "时长", "百分比"] },
  { page: "animation", group: "动画", title: "小组件出现", keywords: ["widget enter", "入场", "entrance"] },
  { page: "animation", group: "动画", title: "视图切换", keywords: ["view switch", "滑动", "slide"] },
  {
    page: "animation",
    group: "动画",
    title: "自定义曲线",
    keywords: ["bezier", "curve", "缓动", "曲线", "easing", "贝塞尔"]
  },
  {
    page: "animation",
    group: "动画",
    title: "动画预览",
    keywords: ["preview", "预览", "播放"]
  },
  {
    page: "animation",
    group: "动画",
    title: "空闲时淡化卡片",
    keywords: ["idle", "dim", "空闲", "淡化", "透明"]
  },
  {
    page: "animation",
    group: "动画",
    title: "空闲时降级玻璃",
    keywords: ["idle", "glass", "空闲", "玻璃", "省电", "battery"]
  },
  {
    page: "animation",
    group: "动画",
    title: "特效管理",
    keywords: ["fx", "effects", "特效", "单独", "逐项", "开关"]
  },
  {
    page: "animation",
    group: "动画",
    title: "指针跟随",
    keywords: ["pointer", "spotlight", "聚光", "光斑", "磁性", "磁吸", "指针跟随"]
  },
  { page: "animation", group: "动画", title: "流光边框", keywords: ["star border", "流光", "边框"] },
  { page: "animation", group: "动画", title: "标题扫光", keywords: ["shiny", "扫光", "标题"] },
  { page: "animation", group: "动画", title: "文字动效", keywords: ["text", "逐字", "乱码", "解密", "滚动"] },
  { page: "animation", group: "动画", title: "错落入场", keywords: ["stagger", "错落", "依次"] },
  { page: "animation", group: "动画", title: "常驻氛围", keywords: ["ambient", "光带", "分隔线", "下划线"] },
  { page: "animation", group: "动画", title: "常驻动效", keywords: ["ambient motion", "漂移", "跑马", "画廊"] },
  { page: "animation", group: "动画", title: "悬停辉光", keywords: ["hover", "glow", "辉光", "光环"] },
  { page: "animation", group: "动画", title: "弹性反馈", keywords: ["elastic", "弹性", "橡胶", "尾迹"] },
  { page: "animation", group: "动画", title: "弹簧勾选", keywords: ["spring", "check", "勾选", "对勾", "删除线"] },
  { page: "animation", group: "动画", title: "选中高光框", keywords: ["specular", "高亮框", "圆周高光"] },
  { page: "animation", group: "动画", title: "像素涟漪", keywords: ["pixel", "涟漪", "波纹"] },
  { page: "animation", group: "动画", title: "粒子文字", keywords: ["particle", "粒子", "vela"] },
  { page: "animation", group: "动画", title: "悬浮窗卡片", keywords: ["card hover", "悬浮", "描边", "呼吸"] },
  // 连接
  {
    page: "connection",
    group: "连接",
    title: "网络状态",
    keywords: ["network", "status", "online", "连通", "延迟", "ping", "测速", "speed", "网速", "上传", "upload"]
  },
  { page: "connection", group: "连接", title: "网络超时", keywords: ["timeout", "超时"] },
  {
    page: "connection",
    group: "连接",
    title: "流量统计记录",
    keywords: ["traffic", "流量", "统计", "记录", "告警", "alert", "阈值", "网速"]
  },
  {
    page: "connection",
    group: "连接",
    title: "任务栏网速条",
    keywords: ["taskbar", "net", "网速条", "任务栏", "netspeed"]
  },
  {
    page: "connection",
    group: "连接",
    title: "网卡",
    keywords: ["adapter", "网卡", "dns", "mac", "ip", "网关", "gateway", "地址", "当前连接", "tcp", "connections"]
  },
  { page: "connection", group: "连接", title: "天气城市", keywords: ["weather", "city", "天气"] },
  { page: "connection", group: "连接", title: "附加城市", keywords: ["weather", "cities", "多城市"] },
  {
    page: "connection",
    group: "连接",
    title: "自动定位（IP）",
    keywords: ["ip", "locate", "定位", "geolocation", "公网", "isp"]
  },
  // 显示器（page id 为 "display"，路由同时接受 display-<slot>）
  {
    page: "display",
    group: "显示器",
    title: "显示器信息",
    keywords: [
      "monitor",
      "resolution",
      "分辨率",
      "多屏",
      "外接",
      "manage",
      "复制布局",
      "copy layout",
      "缩放",
      "scale",
      "dpi",
      "刷新",
      "refresh",
      "隐私",
      "防截屏",
      "privacy",
      "截屏",
      "录屏",
      "共享",
      "隐藏桌面",
      "hide",
      "capture"
    ]
  },
  // 灵动岛（ISLAND-CFG · 岛级设置页）
  {
    page: "dock",
    group: "灵动岛",
    title: "启用灵动岛",
    keywords: ["dock", "island", "dynamic island", "聚合条", "磁贴"]
  },
  { page: "dock", group: "灵动岛", title: "位置吸附", keywords: ["snap", "offset", "吸附", "偏移", "位置", "贴边"] },
  {
    page: "dock",
    group: "灵动岛",
    title: "外形",
    keywords: ["style", "pill", "bangs", "胶囊", "刘海", "视图切换按钮", "arrows"]
  },
  {
    page: "dock",
    group: "灵动岛",
    title: "鼠标动作",
    keywords: ["mouse", "hover", "悬停", "微涨", "中键", "滚轮", "点击空白", "全岛面板"]
  },
  {
    page: "dock",
    group: "灵动岛",
    title: "接管",
    keywords: ["takeover", "番茄钟", "媒体", "切歌", "通知", "展示时长"]
  },
  {
    page: "dock",
    group: "灵动岛",
    title: "自动隐藏",
    keywords: ["auto hide", "qq", "收起", "弹出", "靠近", "贴边隐藏"]
  },
  {
    page: "dock",
    group: "灵动岛",
    title: "密度与面板",
    keywords: ["density", "panel", "inset", "磁贴高度", "轮播", "网格", "面板形态", "顶部内边距"]
  },
  // 任务栏（TB-UI · ～）
  {
    page: "taskbar",
    group: "任务栏",
    title: "自定义任务栏外观",
    keywords: ["taskbar", "transparent", "透明", "模糊", "亚克力", "acrylic", "blur", "任务栏"]
  },
  {
    page: "taskbar",
    group: "任务栏",
    title: "动态外观",
    keywords: ["dynamic", "桌面", "可见窗口", "最大化", "开始菜单", "搜索", "任务视图", "省电", "状态"]
  },
  {
    page: "taskbar",
    group: "任务栏",
    title: "窗口规则",
    keywords: ["rule", "窗口类", "窗口标题", "进程名", "规则", "非前台"]
  },
  { page: "taskbar", group: "任务栏", title: "忽略的窗口", keywords: ["ignore", "ignored windows", "忽略", "排除"] },
  // 通知设置已并入番茄钟 / 待办小组件配置的「通知」栏（侧栏独立页已移除）。
  // 数据 / 更新（备份/恢复是数据安全的入口词，单独成词条：只挂 export/import
  // 时搜「备份」「恢复」零结果，而这是用户找这块功能时最常用的词）。
  {
    page: "general",
    group: "常规",
    title: "备份与恢复",
    keywords: ["backup", "restore", "备份", "恢复", "导出", "导入", "数据", "json", "export", "import"]
  },
  { page: "general", group: "常规", title: "导出设置", keywords: ["export"] },
  { page: "general", group: "常规", title: "导入设置", keywords: ["import"] },
  { page: "update", group: "更新", title: "检查更新", keywords: ["update", "version", "版本", "升级"] },
  { page: "update", group: "更新", title: "更新源地址", keywords: ["endpoint", "源", "update"] },
  { page: "update", group: "更新", title: "自动检查更新", keywords: ["auto check", "自动更新"] },
  // 小组件 / 视图
  {
    page: "gallery",
    group: "小组件",
    title: "添加小组件",
    keywords: ["add widget", "gallery", "画廊", "search", "搜索"]
  },
  {
    page: "widgets",
    group: "视图",
    title: "小组件管理",
    keywords: [
      "widget",
      "组件",
      "回收站",
      "删除",
      "邮件",
      "蓝牙",
      "配置",
      "穿透",
      "角标",
      "click-through",
      "视图",
      "view",
      "切换视图",
      "添加视图",
      "重命名视图",
      "删除视图",
      "复制视图",
      "排序",
      "清空视图"
    ]
  }
];

/** 简易匹配：大小写不敏感的子串匹配（标题 / 分组 / 翻译后标题 / 关键词任一命中）。
 *  界面语言为 English 时标题与分组按翻译后文本参与匹配（词典未收录回退中文
 *  key，两种语言都能命中）；keywords 是中文为主的中英混合补充。 */
function matches(entry: SettingsSearchEntry, q: string, tr: (zh: string) => string): boolean {
  if (entry.title.toLowerCase().includes(q)) return true;
  if (entry.group.toLowerCase().includes(q)) return true;
  if (tr(entry.title).toLowerCase().includes(q)) return true;
  if (tr(entry.group).toLowerCase().includes(q)) return true;
  return (entry.keywords ?? []).some((k) => k.toLowerCase().includes(q));
}

/**
 * 搜索设置项，最多返回 `limit` 条（默认 12）。
 * query 为空或去掉空白后长度为 0 时返回 []。
 *
 * `extra`：调用方追加的动态词条（如按当前视图列表逐视图生成的 `view-<id>`
 * 词条），排在静态索引**之前**参与匹配——用户按视图名搜索时目标页应当
 * 置顶，而不是被 12 条静态命中挤出结果。静态索引无法表达动态页面 id，
 * 视图名搜索此前没有入口。
 *
 * `translate`：标题/分组的翻译函数。组件里传 useT() 的 tr——其引用随语言
 * 切换变化，调用方 memo 以 tr 为依赖即可获得语言响应（此前以 language 作
 * 失效键 + eslint-disable 的绕法不再需要）；纯函数场景缺省用全局 t()。
 */
export function searchSettings(
  query: string,
  limit = 12,
  extra: SettingsSearchEntry[] = [],
  translate: (zh: string) => string = t
): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SettingsSearchEntry[] = [];
  for (const e of [...extra, ...INDEX]) {
    if (matches(e, q, translate)) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}
