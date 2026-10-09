/**
 * quick 配置字段表（自 config-schemas.ts 拆出）：纯 UI 元数据（字段 key /
 * 呈现方式 / 标签），零 zod 依赖。拆分原因：主 chunk 的 DockTile 只需要
 * 「该类型有无 quick 字段」这一判定，不应为它静态连带构建 32 个 zod schema；
 * 字段默认值/合法范围仍以 config-schemas 为单一事实来源，一致性由
 * quick-config-fields.test.ts 守卫（枚举项可解析、滑杆边界在范围内、
 * 默认值类型匹配），二者不会漂移。
 */

export type QuickFieldDef =
  | { kind: "toggle"; key: string; label: string }
  | { kind: "segment"; key: string; label: string; options: { id: string; label: string }[] }
  | { kind: "slider" | "stepper"; key: string; label: string; min: number; max: number; step?: number; suffix?: string }
  | { kind: "color"; key: string; label: string }
  /** 时钟世界时钟时区列表编辑器（数组字段的专用控件）。 */
  | { kind: "zones"; key: string; label: string };

export const QUICK_CONFIG_FIELDS: Record<string, QuickFieldDef[]> = {
  clock: [
    {
      kind: "segment",
      key: "face",
      label: "表盘样式",
      options: [
        { id: "digital", label: "数字" },
        { id: "analog", label: "模拟表盘" }
      ]
    },
    { kind: "toggle", key: "showSeconds", label: "显示秒" },
    { kind: "toggle", key: "hour12", label: "12 小时制" },
    {
      kind: "segment",
      key: "style",
      label: "样式",
      options: [
        { id: "compact", label: "紧凑" },
        { id: "standard", label: "标准" },
        { id: "loose", label: "宽松" }
      ]
    },
    {
      kind: "segment",
      key: "dateStyle",
      label: "日期格式",
      options: [
        { id: "auto", label: "自动" },
        { id: "zh", label: "中文" },
        { id: "slash", label: "yyyy/MM/dd" }
      ]
    },
    { kind: "slider", key: "fontScale", label: "字号", min: 0.6, max: 1.6, step: 0.05, suffix: "×" },
    { kind: "color", key: "color", label: "文字颜色" },
    { kind: "zones", key: "zones", label: "世界时钟" }
  ],
  todo: [
    { kind: "toggle", key: "showCompleted", label: "显示已完成" },
    { kind: "toggle", key: "showCount", label: "显示完成计数" },
    { kind: "toggle", key: "showFilter", label: "显示筛选栏" },
    {
      kind: "segment",
      key: "sortOrder",
      label: "排序",
      options: [
        { id: "newest", label: "最新在前" },
        { id: "oldest", label: "最旧在前" },
        { id: "manual", label: "手动" }
      ]
    }
  ],
  pomodoro: [{ kind: "toggle", key: "spinRing", label: "旋转外圈刻度" }],
  deadlines: [
    { kind: "toggle", key: "showCompleted", label: "显示已完成" },
    { kind: "toggle", key: "showOverdue", label: "显示逾期高亮" },
    { kind: "toggle", key: "showUrgency", label: "显示紧急程度" },
    {
      kind: "segment",
      key: "sortOrder",
      label: "排序",
      options: [
        { id: "soonest", label: "最近到期" },
        { id: "latest", label: "最晚到期" }
      ]
    }
  ],
  analytics: [
    { kind: "slider", key: "days", label: "显示天数", min: 3, max: 30, step: 1, suffix: "天" },
    { kind: "toggle", key: "showMonthHeatmap", label: "显示专注热力图" }
  ],
  notes: [
    { kind: "toggle", key: "showSearch", label: "显示搜索框" },
    { kind: "toggle", key: "showCount", label: "显示便签计数" },
    { kind: "toggle", key: "markdown", label: "Markdown 渲染" },
    {
      kind: "segment",
      key: "sortBy",
      label: "排序",
      options: [
        { id: "newest", label: "最新" },
        { id: "oldest", label: "最旧" },
        { id: "manual", label: "手动" }
      ]
    }
  ],
  sketch: [
    { kind: "slider", key: "defaultBrushSize", label: "默认画笔粗细", min: 1, max: 20, step: 1, suffix: "px" },
    {
      kind: "segment",
      key: "bgMode",
      label: "画布背景",
      options: [
        { id: "grid", label: "网格" },
        { id: "transparent", label: "透明" },
        { id: "white", label: "白底" },
        { id: "dark", label: "深色" }
      ]
    },
    {
      kind: "segment",
      key: "defaultColor",
      label: "默认颜色",
      options: [
        { id: "white", label: "白色" },
        { id: "gray", label: "灰色" },
        { id: "blue", label: "蓝色" },
        { id: "green", label: "绿色" }
      ]
    }
  ],
  system: [
    { kind: "toggle", key: "compactMode", label: "紧凑模式" },
    { kind: "toggle", key: "showTrend", label: "趋势曲线" },
    {
      kind: "segment",
      key: "networkMode",
      label: "网卡显示",
      // 「指定」需要配套的网卡选择器，快速面板没有（选了落到空串=自动）——
      // 从快速配置移除；完整设置页（ambient）保留全部四档。
      options: [
        { id: "first", label: "自动" },
        { id: "all", label: "全部" },
        { id: "aggregate", label: "聚合" }
      ]
    },
    { kind: "slider", key: "alertThreshold", label: "告警阈值", min: 10, max: 100, step: 5, suffix: "%" },
    { kind: "slider", key: "refreshInterval", label: "刷新间隔", min: 1, max: 30, step: 1, suffix: "秒" }
  ],
  hardware: [
    { kind: "toggle", key: "showTrend", label: "显示趋势图" },
    { kind: "toggle", key: "showStaticInfo", label: "静态信息头" },
    { kind: "toggle", key: "showUptimeProcess", label: "开机时长与进程数" },
    { kind: "slider", key: "refreshInterval", label: "刷新间隔", min: 1, max: 30, step: 1, suffix: "秒" }
  ],
  calendar: [
    {
      kind: "segment",
      key: "viewMode",
      label: "视图",
      options: [
        { id: "month", label: "月" },
        { id: "week", label: "周" },
        { id: "double", label: "双月" }
      ]
    },
    { kind: "toggle", key: "showLunar", label: "显示农历" },
    {
      kind: "segment",
      key: "firstDayOfWeek",
      label: "每周起始",
      options: [
        { id: "monday", label: "星期一" },
        { id: "sunday", label: "星期日" }
      ]
    },
    { kind: "toggle", key: "compact", label: "紧凑模式" }
  ],
  weather: [
    {
      kind: "segment",
      key: "unit",
      label: "温度单位",
      options: [
        { id: "celsius", label: "°C" },
        { id: "fahrenheit", label: "°F" }
      ]
    },
    { kind: "toggle", key: "showForecast", label: "显示未来预报" },
    { kind: "toggle", key: "showHourly", label: "显示逐时预报" },
    { kind: "slider", key: "refreshInterval", label: "刷新间隔", min: 5, max: 120, step: 5, suffix: "分钟" }
  ],
  sysbar: [
    {
      kind: "segment",
      key: "fontSize",
      label: "字号",
      options: [
        { id: "sm", label: "SM" },
        { id: "xs", label: "XS" },
        { id: "md", label: "MD" }
      ]
    },
    {
      kind: "segment",
      key: "separator",
      label: "分隔符",
      options: [
        { id: "bar", label: "竖线" },
        { id: "dot", label: "圆点" },
        { id: "none", label: "无" }
      ]
    },
    { kind: "toggle", key: "transparent", label: "透明（无底板）" },
    { kind: "stepper", key: "refreshInterval", label: "刷新间隔", min: 1, max: 10, suffix: "秒" }
  ],
  shortcuts: [
    { kind: "toggle", key: "showTitle", label: "显示标题" },
    { kind: "toggle", key: "showLabels", label: "显示名称标签" },
    { kind: "toggle", key: "folderPreview", label: "文件夹点击预览" },
    { kind: "stepper", key: "columns", label: "列数", min: 1, max: 6, suffix: "列" }
  ],
  files: [
    { kind: "toggle", key: "showHidden", label: "显示隐藏文件" },
    {
      kind: "segment",
      key: "sortBy",
      label: "排序依据",
      options: [
        { id: "name", label: "名称" },
        { id: "size", label: "大小" },
        { id: "modified", label: "修改时间" },
        { id: "type", label: "类型" }
      ]
    },
    {
      kind: "segment",
      key: "sortOrder",
      label: "排序方向",
      options: [
        { id: "asc", label: "升序" },
        { id: "desc", label: "降序" }
      ]
    },
    {
      kind: "segment",
      key: "nameDisplay",
      label: "名称显示",
      options: [
        { id: "full", label: "完整" },
        { id: "noext", label: "无扩展名" },
        { id: "noname", label: "仅图标" }
      ]
    },
    {
      kind: "segment",
      key: "viewMode",
      label: "视图",
      options: [
        { id: "list", label: "列表" },
        { id: "preview", label: "预览" }
      ]
    }
  ],
  calculator: [
    { kind: "toggle", key: "scientificMode", label: "切换科学模式" },
    { kind: "toggle", key: "showHistory", label: "历史记录纸带" },
    {
      kind: "segment",
      key: "angleMode",
      label: "角度模式",
      options: [
        { id: "deg", label: "DEG" },
        { id: "rad", label: "RAD" }
      ]
    }
  ],
  unitconverter: [
    { kind: "toggle", key: "showExtended", label: "显示更多单位" },
    { kind: "toggle", key: "showHistory", label: "显示换算历史" },
    { kind: "toggle", key: "rememberCategory", label: "记住上次使用的类别" }
  ],
  colorpicker: [
    { kind: "toggle", key: "autoCopy", label: "自动复制" },
    { kind: "toggle", key: "showHistory", label: "显示历史颜色" },
    { kind: "stepper", key: "historyCap", label: "历史容量", min: 4, max: 24, suffix: "个" }
  ],
  bookmarks: [
    {
      kind: "segment",
      key: "layout",
      label: "布局",
      options: [
        { id: "list", label: "列表" },
        { id: "grid", label: "网格" }
      ]
    },
    {
      kind: "segment",
      key: "sortBy",
      label: "排序",
      options: [
        { id: "newest", label: "最新" },
        { id: "name", label: "名称" },
        { id: "manual", label: "手动" }
      ]
    },
    { kind: "toggle", key: "showFavicon", label: "显示网站图标" }
  ],
  music: [
    {
      kind: "segment",
      key: "layout",
      label: "布局方式",
      options: [
        { id: "spectrum", label: "频谱" },
        { id: "nowplaying", label: "正在播放" },
        { id: "both", label: "两者" }
      ]
    },
    {
      kind: "segment",
      key: "mode",
      label: "检测源",
      options: [
        { id: "playback", label: "播放音频" },
        { id: "microphone", label: "麦克风" },
        { id: "both", label: "两者" }
      ]
    },
    {
      kind: "segment",
      key: "visualStyle",
      label: "可视化样式",
      options: [
        { id: "bars", label: "频谱条" },
        { id: "wave", label: "波形" },
        { id: "mirror", label: "镜像" },
        { id: "minimal", label: "极简" },
        { id: "radial", label: "环形" },
        { id: "butterfly", label: "蝴蝶" }
      ]
    },
    {
      kind: "segment",
      key: "colorMode",
      label: "配色",
      options: [
        { id: "theme", label: "主题色" },
        { id: "mono", label: "单色" },
        { id: "rainbow", label: "彩虹" }
      ]
    },
    { kind: "toggle", key: "showStatusText", label: "显示状态文字" }
  ],
  /** 「正在播放」卡片专属开关（布局被组件锁定，频谱字段不适用）；
      完整说明 + 独占播放入口在设置窗的正在播放专段。 */
  nowplaying: [
    { kind: "toggle", key: "showSeekbar", label: "显示进度条" },
    { kind: "toggle", key: "centerTitle", label: "标题与歌手居中" },
    { kind: "toggle", key: "showModeButtons", label: "显示随机/循环按钮" },
    { kind: "toggle", key: "wheelVolume", label: "滚轮调节应用音量" }
  ],
  bluetooth: [
    {
      kind: "segment",
      key: "layout",
      label: "布局",
      options: [
        { id: "grid", label: "网格" },
        { id: "list", label: "列表" }
      ]
    },
    { kind: "toggle", key: "showDisconnected", label: "显示已断开设备" },
    { kind: "stepper", key: "autoRefreshSeconds", label: "自动刷新", min: 0, max: 300, suffix: "秒" }
  ],
  gallery: [
    { kind: "stepper", key: "columns", label: "列数", min: 2, max: 6, suffix: "列" },
    {
      kind: "segment",
      key: "thumbShape",
      label: "缩略图形状",
      options: [
        { id: "rounded", label: "圆角" },
        { id: "square", label: "直角" },
        { id: "circle", label: "圆形" }
      ]
    },
    { kind: "toggle", key: "driftWall", label: "漂移墙" }
  ],
  habit: [
    { kind: "toggle", key: "showCompleted", label: "显示已完成" },
    { kind: "toggle", key: "showStreak", label: "显示连续天数" },
    { kind: "toggle", key: "showCount", label: "显示完成计数" }
  ],
  countdown: [
    { kind: "stepper", key: "defaultPreset", label: "默认时长", min: 1, max: 120, suffix: "分钟" },
    { kind: "toggle", key: "loopAfterComplete", label: "完成后自动循环" },
    { kind: "toggle", key: "notifyOnEnd", label: "结束时通知" }
  ],
  email: [
    { kind: "toggle", key: "showUnreadOnly", label: "仅显示未读" },
    { kind: "toggle", key: "notifyNewMail", label: "新邮件通知" },
    { kind: "slider", key: "refreshInterval", label: "刷新间隔", min: 1, max: 60, step: 1, suffix: "分钟" }
  ],
  timetable: [
    {
      kind: "segment",
      key: "layout",
      label: "布局",
      options: [
        { id: "grid", label: "网格" },
        { id: "list", label: "列表" }
      ]
    },
    { kind: "toggle", key: "compact", label: "紧凑模式" },
    { kind: "toggle", key: "showLocation", label: "显示上课地点" }
  ],
  todayoverview: [
    { kind: "toggle", key: "showTasks", label: "显示今日待办" },
    { kind: "toggle", key: "showWeather", label: "显示天气" },
    { kind: "toggle", key: "showGreeting", label: "显示问候语" },
    { kind: "toggle", key: "showEvents", label: "显示今日日程" },
    { kind: "stepper", key: "maxTasks", label: "待办条数上限", min: 1, max: 12, suffix: "条" }
  ],
  stopwatch: [
    { kind: "toggle", key: "showCentis", label: "显示百分秒" },
    { kind: "stepper", key: "lapLimit", label: "计次保留", min: 3, max: 50, suffix: "次" }
  ]
};
