/**
 * 设置搜索索引：把散落在各设置页里的设置项收敛成可检索的平铺列表。
 * 词条全部用中文 key（与 i18n 约定一致），keywords 供模糊匹配。
 */

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
  { page: "widgets", group: "小组件", title: "累计专注起始日期", keywords: ["analytics", "统计", "起始", "专注统计"] },
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
  // 样式
  {
    page: "style",
    group: "样式",
    title: "主题预设",
    keywords: ["preset", "theme", "主题", "默认", "终端", "午夜", "日光", "纸张", "retro"]
  },
  { page: "style", group: "样式", title: "主题模式", keywords: ["theme", "dark", "light", "深色", "浅色", "系统"] },
  { page: "style", group: "样式", title: "壁纸", keywords: ["wallpaper", "壁纸", "背景", "桌面", "更换"] },
  {
    page: "style",
    group: "样式",
    title: "壁纸文件夹",
    keywords: ["wallpaper folder", "最近使用", "recent", "浏览照片"]
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
  { page: "animation", group: "动画", title: "动效模式", keywords: ["fx", "effects", "特效"] },
  { page: "animation", group: "动画", title: "动画速度", keywords: ["speed", "duration"] },
  { page: "animation", group: "动画", title: "动画时长微调", keywords: ["duration fine tune"] },
  { page: "animation", group: "动画", title: "小组件出现", keywords: ["widget enter", "入场"] },
  { page: "animation", group: "动画", title: "视图切换", keywords: ["view switch"] },
  {
    page: "animation",
    group: "动画",
    title: "指针跟随",
    keywords: ["pointer", "spotlight", "聚光", "光斑", "磁性", "磁吸", "指针跟随"]
  },
  // 连接
  { page: "connection", group: "连接", title: "网络超时", keywords: ["timeout", "超时"] },
  { page: "connection", group: "连接", title: "天气城市", keywords: ["weather", "city", "天气"] },
  { page: "connection", group: "连接", title: "附加城市", keywords: ["weather", "cities", "多城市"] },
  // 显示器（page id 为 "display"，路由同时接受 display-<slot>）
  {
    page: "display",
    group: "显示器",
    title: "显示器信息",
    keywords: ["monitor", "resolution", "分辨率", "多屏", "外接", "manage"]
  },
  // 灵动岛（ISLAND-CFG · F-6 岛级设置页）
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
  // 任务栏（TB-UI · F-1～F-5 / F-13）
  {
    page: "taskbar",
    group: "任务栏",
    title: "自定义任务栏外观",
    keywords: ["taskbar", "透明", "模糊", "亚克力", "acrylic", "blur", "任务栏"]
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
  { page: "gallery", group: "小组件", title: "添加小组件", keywords: ["add widget", "gallery", "画廊"] },
  {
    page: "widgets",
    group: "视图",
    title: "小组件管理",
    keywords: ["widget", "组件", "回收站", "删除", "邮件", "蓝牙", "配置", "穿透", "角标", "click-through"]
  }
];

/** 简易匹配：大小写不敏感的子串匹配（标题 / 分组 / 关键词任一命中）。 */
function matches(entry: SettingsSearchEntry, q: string): boolean {
  if (entry.title.toLowerCase().includes(q)) return true;
  if (entry.group.toLowerCase().includes(q)) return true;
  return (entry.keywords ?? []).some((k) => k.toLowerCase().includes(q));
}

/**
 * 搜索设置项，最多返回 `limit` 条（默认 12）。
 * query 为空或去掉空白后长度为 0 时返回 []。
 */
export function searchSettings(query: string, limit = 12): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SettingsSearchEntry[] = [];
  for (const e of INDEX) {
    if (matches(e, q)) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}
