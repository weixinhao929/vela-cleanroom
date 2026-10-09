import { z } from "zod";
import type { WidgetConfig } from "./widget-config";

/**
 * 组件配置的 zod schema 唯一来源。
 *
 * 之前每个小组件的配置字段散落在设置页（SettingsView 的 `<Type>Config` 组件）
 * 里，用 `config.showX !== false` / `(config.x as number) || 3` 这类临时写法
 * 读取默认值，类型与下界/上界无法复用，损坏数据也没有统一校验。
 *
 * 这里把「哪些字段可配、默认值、取值范围、枚举项」抽成 schema，设置页展示与
 * 数据校验共用同一份定义：
 *  - 设置页读取时用 `sanitizeWidgetConfig` 洗掉类型错误、补上缺失字段；
 *  - 新增/校验配置时用 `validateWidgetConfig` 判定合法性。
 *
 * 约定与设置页一致：多数开关默认开启（`!== false`），少数默认关闭
 * （`!!cfg.x` / `=== true`）。将这些默认值显式写进 schema，二者不再漂移。
 */

/** 布尔开关：默认值 d，非法值回退到 d。 */
const bool = (d: boolean) => z.boolean().default(d).catch(d);
/** 整数步进值：在 [min,max] 内，越界/非数字回退到 d。 */
const num = (d: number, min: number, max: number) => z.number().int().min(min).max(max).default(d).catch(d);
/** 浮点滑杆值（step < 1）：同 num 但允许小数。num 的 .int() 会把 0.7 这类
 * 滑杆值静默重置为默认值，导致增益/平滑度/导出质量/字号滑杆完全无效。 */
const fnum = (d: number, min: number, max: number) => z.number().min(min).max(max).default(d).catch(d);
/** 单选枚举：从白名单里取值，非法回退到 d。 */
function en<T extends readonly string[]>(d: T[number], opts: T) {
  return z.enum(opts).default(d).catch(d);
}

/** 快捷方式（shortcuts）的条目：id/label/path/kind。missing 为 同类桌面整理工具
 * file_missing 标记（目标暂不存在；optional 避免给每条都写入 false）。 */
const shortcutItem = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  kind: z.enum(["url", "folder", "file"]).default("url"),
  missing: z.boolean().optional()
});

/** 自定义快捷方式列表：逐条校验、丢弃损坏条目。数组级 `.catch([])` 会在任何
 * 一条记录损坏时把整张列表清空（用户的所有自定义快捷方式一损俱损）。 */
const shortcutList = z
  .array(z.unknown())
  .default([])
  .catch([])
  .transform((arr) =>
    arr.flatMap((it) => {
      const r = shortcutItem.safeParse(it);
      return r.success ? [r.data] : [];
    })
  );

/** 快捷方式文件夹（类手机桌面）：id/label/childIds，同样逐条校验丢弃损坏条目。
 *  sort 为弹层展示排序（free 自由 / name 名称 / time 时间），optional 旧数据兼容。 */
const shortcutFolderItem = z.object({
  id: z.string(),
  label: z.string(),
  childIds: z.array(z.string()).default([]).catch([]),
  sort: z.enum(["free", "name", "time"]).optional()
});
const shortcutFolderList = z
  .array(z.unknown())
  .default([])
  .catch([])
  .transform((arr) =>
    arr.flatMap((it) => {
      const r = shortcutFolderItem.safeParse(it);
      return r.success ? [r.data] : [];
    })
  );

export const clockConfigSchema = z.object({
  showSeconds: bool(true),
  showDate: bool(true),
  showWeekday: bool(true),
  transparent: bool(false),
  timeZone: z.string().default("auto").catch("auto"),
  weekdayStyle: en("long", ["short", "long"]),
  hour12: bool(false),
  style: en("standard", ["compact", "standard", "loose"]),
  /* 世界时钟：zones 非空时按城市多列并列显示。 */
  zones: z.array(z.string()).default([]).catch([]),
  /* 模拟表盘皮肤。 */
  face: en("digital", ["digital", "analog"]),
  /* 日期格式。 */
  dateStyle: en("auto", ["auto", "zh", "slash"]),
  /* 字号缩放与文字颜色。fontScale 滑杆 step 0.05，必须允许小数。 */
  fontScale: fnum(1, 0.6, 1.6),
  color: z.string().default("").catch("")
});

export const todoConfigSchema = z.object({
  showCompleted: bool(true),
  showCount: bool(true),
  showProgressTrack: bool(true),
  showEmptyState: bool(true),
  showFilter: bool(true),
  // "manual"：TodayTasksPanel 的手动拖拽排序。此前枚举漏掉该值，
  // sanitize 的 .catch("newest") 会把用户选的手动排序静默洗回默认。
  sortOrder: en("newest", ["newest", "oldest", "manual"]),
  // 逾期/今天/即将到期分组（SettingsView 写、TodayTasksPanel 读）。
  showDueGrouping: bool(true),
  maxItems: num(0, 0, 50)
});

export const pomodoroConfigSchema = z.object({
  spinRing: bool(false)
});

export const deadlinesConfigSchema = z.object({
  showCompleted: bool(true),
  showOverdue: bool(true),
  showUrgency: bool(true),
  showGrouping: bool(true),
  showRelativeTime: bool(true),
  sortOrder: en("soonest", ["soonest", "latest"]),
  maxItems: num(0, 0, 50),
  // 多档提醒（到期前 24h/1h/10min）：SettingsView 写、DeadlinePanel 读。
  multiTierRemind: bool(true)
});

export const analyticsConfigSchema = z.object({
  days: num(7, 3, 30),
  showMonthHeatmap: bool(true)
});

export const notesConfigSchema = z.object({
  fontSize: en("medium", ["small", "medium", "large"]),
  // "manual"：NotesWidget 的 manualSort 拖拽排序。同 todo，枚举此前漏掉。
  sortBy: en("newest", ["newest", "oldest", "manual"]),
  showDate: bool(true),
  showCount: bool(true),
  showSearch: bool(true),
  showEmptyState: bool(true),
  markdown: bool(true),
  showTagBar: bool(true)
});

export const sketchConfigSchema = z.object({
  defaultBrushSize: num(3, 1, 20),
  defaultColor: en("white", ["white", "gray", "blue", "green"]),
  /** 画布背景：透明（棋盘格）/ 网格 / 白底 / 深色。 */
  bgMode: en("grid", ["transparent", "grid", "white", "dark"]),
  /** JPEG 导出质量（0.5–1）。滑杆 step 0.02，必须允许小数。 */
  exportQuality: fnum(0.92, 0.5, 1)
});

export const systemConfigSchema = z.object({
  showCPU: bool(true),
  showRAM: bool(true),
  showGPU: bool(true),
  showDisk: bool(true),
  showNetwork: bool(true),
  compactMode: bool(false),
  refreshInterval: num(3, 1, 30),
  /** 每行末尾的迷你趋势曲线。 */
  showTrend: bool(false),
  /** 显示全部磁盘（默认只显示第一块）。 */
  showAllDisks: bool(false),
  /** 阈值告警：高于 alertThreshold（默认 80）时进度条与数值变红。 */
  thresholdAlert: bool(true),
  /** 告警阈值（%）：开启 thresholdAlert 后生效（默认 80）。 */
  alertThreshold: num(80, 10, 100),
  /** 网卡显示：first 第一块(自动选最活跃) / all 全部 / aggregate 聚合 / select 指定网卡。 */
  networkMode: en("first", ["first", "all", "aggregate", "select"]),
  /** select 模式下指定的网卡名（FriendlyName，与后端同名）。 */
  networkSelect: z.string().default("").catch(""),
  /** CPU 每核小格子（任务管理器形态）。 */
  showCoresGrid: bool(false)
});

export const hardwareConfigSchema = z.object({
  showCPU: bool(true),
  showRAM: bool(true),
  showGPU: bool(true),
  showDisk: bool(true),
  showNetwork: bool(true),
  showBattery: bool(true),
  showTrend: bool(true),
  refreshInterval: num(3, 1, 30),
  /** 静态硬件信息头（CPU/GPU 型号 + 总内存）。 */
  showStaticInfo: bool(true),
  /** 开机时长 + 进程数。 */
  showUptimeProcess: bool(true),
  /** 趋势窗口样本数（刷新间隔 × N ≈ 时间范围）。 */
  historyLen: num(40, 10, 120),
  /** 曲线上叠加峰值虚线。 */
  showPeak: bool(false)
});

export const calendarConfigSchema = z.object({
  showLunar: bool(true),
  showSolarTerms: bool(true),
  showHolidays: bool(true),
  showRestMarks: bool(true),
  showMemorialMarks: bool(true),
  showEventDots: bool(true),
  compact: bool(false),
  showWeekNumber: bool(false),
  firstDayOfWeek: en("monday", ["monday", "sunday"]),
  /* 视图粒度：月 / 周 / 双月。 */
  viewMode: en("month", ["month", "week", "double"]),
  /* 月格内事件摘要。 */
  showCellEvents: bool(true),
  /* ICS 订阅（Google/Outlook 只读日历）。 */
  icsEnabled: bool(false),
  icsUrl: z.string().default("").catch("")
});

export const weatherConfigSchema = z.object({
  unit: en("celsius", ["celsius", "fahrenheit"]),
  showWindHumidity: bool(true),
  showCity: bool(true),
  showForecast: bool(true),
  showHourly: bool(true),
  showSunTimes: bool(true),
  refreshInterval: num(30, 5, 120),
  /* 空气质量 + 紫外线。 */
  showAqi: bool(true),
  /* 记住选中城市。 */
  cityIndex: num(0, 0, 99),
  /* 新预警系统通知。 */
  alertNotify: bool(true)
});

export const sysbarConfigSchema = z.object({
  refreshInterval: num(2, 1, 10),
  /** 显示项自定义：条目自由组合（顺序即渲染顺序）。
   * 可选值：fps / lat / gpu / cpu / mem / cores / net / battery。
   * （旧 showGPU / showCores 开关已移除登记：组件只读 items；存量键由
   * sanitizeWidgetConfig 的 input 展开原样保留，不再参与解析/补默认。） */
  items: z
    .array(z.string())
    .default(["fps", "lat", "gpu", "cpu", "mem", "cores"])
    .catch(["fps", "lat", "gpu", "cpu", "mem", "cores"]),
  /** 字号：xs / sm / md。 */
  fontSize: en("sm", ["xs", "sm", "md"]),
  /** 分隔符样式：竖线 / 圆点 / 无。 */
  separator: en("bar", ["bar", "dot", "none"]),
  /** 无底板：去掉卡片背景/边框/投影/毛玻璃，只留文字条（时钟/音乐 transparent 同款）。 */
  transparent: bool(false),
  /** 告警阈值（%）：CPU/内存高于此值数值变红（默认 80）。 */
  alertThreshold: num(80, 10, 100),
  /** 电池低电阈值（%）：低于此值数值变红（默认 20）。 */
  battLowThreshold: num(20, 5, 50)
});

export const shortcutsConfigSchema = z.object({
  showTitle: bool(true),
  /** SHORTCUTS 标题紧凑高度（压低标题行占高）。 */
  titleCompact: bool(false),
  /** 每枚图标下方的名称标签（隐藏后仅显示图标，悬停 title 仍可见全名）。 */
  showLabels: bool(true),
  columns: num(2, 1, 6),
  customShortcuts: shortcutList,
  /** 类手机桌面的快捷方式文件夹：可展开磁贴，聚合若干自定义条目。 */
  shortcutFolders: shortcutFolderList,
  /** 内置位置可选：勾选显示哪些系统位置（回收站/此电脑/文档…）。
   *  默认为空 —— 图标来自桌面拖入的真实快捷方式，不再预置通用图标。 */
  builtinShortcuts: z.array(z.string()).default([]).catch([]),
  /** 自由排布：id → 内容区格位（列/行）。缺省按 columns 自动排。 */
  positions: z
    .record(z.string(), z.object({ x: num(0, 0, 63), y: num(0, 0, 255) }))
    .default({})
    .catch({}),
  /** 展示顺序（内置 id + 自定义 id 混排；自动排布用）。 */
  order: z.array(z.string()).default([]).catch([]),
  /** 文件夹预览小窗：文件夹条目单击弹就地图标网格，
   *  关闭后退回原行为（直接开资源管理器）。 */
  folderPreview: bool(true),
  /** 文件夹弹层打开方式：单击 / 悬停 / 钉住。 */
  sfolderOpenMode: en("click", ["click", "hover", "pin"]),
  /** 目录监视自动整理（规则与生效分离的三态设计）。
   *   补两个条件叶子：文件年龄（N 天前创建/修改）与
   *  最小体积（MB）；与扩展名/关键字仍是扁平 AND，0 = 不启用该条件。 */
  autoOrganize: z
    .object({
      watchPath: z.string().default("").catch(""),
      extensions: z.array(z.string()).default([]).catch([]),
      nameTokens: z.array(z.string()).default([]).catch([]),
      extEnabled: bool(true),
      nameEnabled: bool(false),
      /** 通知动作：命中入列时额外发系统通知。 */
      notify: bool(false),
      /** 文件年龄下限（天，0 = 不限）。 */
      olderThanDays: num(0, 0, 3650),
      /** 年龄依据：修改时间（默认）或创建时间。 */
      olderBy: en("modified", ["modified", "created"]),
      /** 最小体积（MB，0 = 不限）。 */
      minSizeMb: num(0, 0, 1024 * 16)
    })
    .default({
      watchPath: "",
      extensions: [],
      nameTokens: [],
      extEnabled: true,
      nameEnabled: false,
      notify: false,
      olderThanDays: 0,
      olderBy: "modified",
      minSizeMb: 0
    })
    .catch({
      watchPath: "",
      extensions: [],
      nameTokens: [],
      extEnabled: true,
      nameEnabled: false,
      notify: false,
      olderThanDays: 0,
      olderBy: "modified",
      minSizeMb: 0
    })
});

export const filesConfigSchema = z.object({
  showHidden: bool(false),
  showFileSize: bool(true),
  showModifiedDate: bool(true),
  /** 排序：依据 + 方向（目录始终排在前）。补「类型」（扩展名聚簇）。 */
  sortBy: en("name", ["name", "size", "modified", "type"]),
  sortOrder: en("asc", ["asc", "desc"]),
  /** 名称显示：完整 / 隐藏扩展名 / 隐藏文件名。 */
  nameDisplay: en("full", ["full", "noext", "noname"]),
  /** 视图：列表 / 内容预览。 */
  viewMode: en("list", ["list", "preview"]),
  /** 显示别名（path → 展示名，不碰磁盘）：右键「设置显示名」写入。 */
  aliases: z.record(z.string(), z.string()).default({}).catch({}),
  /** 每实例根目录（空 = 跟随全局默认文件夹）。 */
  root: z.string().default("").catch(""),
  /** 路径记忆：记住本实例最后浏览的目录，重启不回根。 */
  rememberPath: bool(true),
  lastPath: z.string().default("").catch(""),
  /** 锁定根目录：向上/面包屑/快捷 chips 不得跳出本实例根（钳制回根）。 */
  lockToRoot: bool(false),
  /** 根目录快捷 chips（下载/文档/图片…一键直达）。 */
  showChips: bool(true),
  /**  实时同步：当前目录登记 Rust watch，变更即时静默重拉
      （绑定失败自动回退 20s 轮询）。 */
  liveSync: bool(true)
});

export const calculatorConfigSchema = z.object({
  scientificMode: bool(false),
  showExpression: bool(true),
  /** 历史记录纸带（重启保留，逐条可复制/回填）。 */
  showHistory: bool(true),
  /** 三角函数入参角度制（deg）/ 弧度制（rad）。 */
  angleMode: en("deg", ["deg", "rad"]),
  /** 顶部页签（编码哈希并入计算器）：计算 / 编码 / 哈希，卡片内点击即持久化。 */
  mode: en("calc", ["calc", "encode", "hash"])
});

export const unitConverterConfigSchema = z.object({
  showExtended: bool(false),
  rememberCategory: bool(true),
  showAllUnits: bool(true),
  showHistory: bool(true)
});

export const colorPickerConfigSchema = z.object({
  autoCopy: bool(false),
  showHex: bool(true),
  showRgb: bool(true),
  showHsl: bool(true),
  showHistory: bool(true),
  /** 扩展格式行：默认收起，避免小卡片过长。 */
  showHsv: bool(false),
  showCmyk: bool(false),
  showRgba: bool(false),
  showCssVar: bool(false),
  /** 历史容量（固定条目不淘汰）。 */
  historyCap: num(8, 4, 24)
});

export const bookmarksConfigSchema = z.object({
  layout: en("list", ["list", "grid"]),
  sortBy: en("newest", ["newest", "name", "manual"]),
  showFavicon: bool(true),
  showSearch: bool(true)
});

/** 音频监控小组件（纯音频监听）：可视化 + 检测源配置。旧字段（专辑/进度/控制）
 *  已随组件改版移除，schema 清洗时旧数据里残留的键会被丢弃。 */
export const musicConfigSchema = z.object({
  visualStyle: en("bars", ["bars", "wave", "mirror", "minimal", "radial", "butterfly"]),
  /** 可视化高度：占卡片内容区高度的百分比（10–100），卡片放大频谱跟着变大。 */
  visualHeight: num(64, 10, 100),
  /** 检测源：播放音频 / 麦克风 / 两者。 */
  mode: en("playback", ["playback", "microphone", "both"]),
  /** 布局：纯频谱 / 正在播放卡 / 两者。 */
  layout: en("spectrum", ["spectrum", "nowplaying", "both"]),
  /* ---- 正在播放卡片专属（nowplaying 类型；同类媒体浮窗 媒体浮窗设置对齐）---- */
  /** 标题与歌手居中（同类媒体浮窗 CenterTitleArtist）。 */
  centerTitle: bool(false),
  /** 显示进度条（可点/可拖 seek；会话不支持 seek 时本就置灰）。 */
  showSeekbar: bool(true),
  /** 显示随机/循环按钮（按会话上报能力位出现，与音乐沉浸页同款）。 */
  showModeButtons: bool(true),
  /** 滚轮调节当前播放源的应用音量。 */
  wheelVolume: bool(true),
  /** 配色：跟随主题 / 单色 / 彩虹渐变。 */
  colorMode: en("theme", ["theme", "mono", "rainbow"]),
  /** 灵敏度（0.5–3）：小音量场景把频谱"抬"起来。滑杆 step 0.1。 */
  gain: fnum(1, 0.5, 3),
  /** 平滑度（0–1）：值越高动画越柔和（但响应越慢）。滑杆 step 0.05。 */
  smoothing: fnum(0.5, 0, 1),
  /** 频带数（16–96）：窄卡片用少，宽卡片用多。 */
  bandCount: num(64, 16, 96),
  /** 峰值保持：每根条上方显示缓慢下落的峰值帽线。 */
  peakHold: bool(false),
  /** 频带分布：log（音乐低频细分）/ linear（语音均匀）。 */
  dist: en("log", ["log", "linear"]),
  /** 底部状态文字（监听中/正在发声 + 频谱来源提示行）整体显示开关。 */
  showStatusText: bool(true),
  /** 透明（无底板）：去掉卡片底板/边框/投影/毛玻璃，只留内容（对齐时钟同款）。 */
  transparent: bool(false),
  /* ---- 歌词（沉浸页消费；此前未登记——组件读写正常但预设包 strict
     导入会剥离这两个键，导出→导入往返静默丢失；默认值也只存在于组件的
     硬编码回退里，双源可漂移）---- */
  /** 一.5 歌词延迟微调（秒，-5 ~ +5 步进 0.5；正值 = 歌词推后显示）。 */
  lyricOffsetSec: fnum(0, -5, 5),
  /** 译文双行显示（取到的歌词带译文时）。 */
  lyricTranslation: bool(true)
});

export const bluetoothConfigSchema = z.object({
  showDisconnected: bool(false),
  showDeviceType: bool(true),
  showBatteryLabel: bool(false),
  showName: bool(false),
  layout: en("grid", ["grid", "list"]),
  gap: num(16, 4, 40),
  /** 自动刷新间隔（秒）。0 = 关闭自动刷新。 */
  autoRefreshSeconds: num(30, 0, 300),
  /** 低电量阈值（%）。0 = 关闭低电量提醒。 */
  lowBatteryThreshold: num(20, 0, 50),
  /** 设备类型筛选：all 或具体类型名。 */
  filterType: z.string().default("all").catch("all"),
  /** 排序：default 后端顺序 / battery 电量 / name 名称 / type 类型。 */
  sortBy: en("default", ["default", "battery", "name", "type"])
});

export const galleryConfigSchema = z.object({
  columns: num(3, 2, 6),
  gap: num(8, 2, 24),
  thumbShape: en("rounded", ["square", "rounded", "circle"]),
  showTags: bool(true),
  /** Drift Wall 漂移墙：以多列错速漂移的 3D 墙呈现图片（风格）。 */
  driftWall: bool(false)
});

export const habitConfigSchema = z.object({
  showCompleted: bool(true),
  showStreak: bool(true),
  showCount: bool(true)
});

export const countdownConfigSchema = z.object({
  defaultPreset: num(25, 1, 120),
  loopAfterComplete: bool(false),
  notifyOnEnd: bool(true),
  showSeconds: bool(true),
  showPresets: bool(true),
  // 组件实际消费但此前未登记的键：缺失会让 defaultWidgetConfig（schema.parse({})）
  // 拿不到默认值，快速配置 fallback / 恢复默认 / 预设包校验侧都读不到它们。
  endSound: bool(true),
  linkPomodoro: bool(false),
  trayTime: bool(true),
  mode: z.enum(["timer", "days"]).catch("timer"),
  presets: z.array(z.number()).catch([]),
  targets: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      })
    )
    .catch([])
});

export const emailConfigSchema = z.object({
  refreshInterval: num(5, 1, 60),
  showPreview: bool(true),
  showTime: bool(true),
  /** 列表最大条数（5–50，每账户）。 */
  maxItems: num(20, 5, 50),
  /** 仅显示未读邮件。 */
  showUnreadOnly: bool(false),
  /** 新邮件系统通知。 */
  notifyNewMail: bool(true),
  /** 定时免打扰（小时 0–23）：该小时内不自动检查、不通知；-1 关闭。 */
  doNotDisturbHour: num(-1, -1, 23)
});

/** 课程表（timetable）：`data`/`profiles` 由导入与编辑流程写入，schema 管展示开关。 */
export const timetableConfigSchema = z.object({
  showLocation: bool(true),
  showWeeksBadge: bool(true),
  showTimes: bool(true),
  compact: bool(false),
  sectionTimes: z.string().default("").catch(""),
  sectionTimesEnd: z.string().default("").catch(""),
  /** 每日固定节次（如 12）；0 = 跟随课表数据自动。 */
  totalSections: num(0, 0, 30),
  /** 课程格最小行高（px）；28 为默认自适应。 */
  cellHeight: num(28, 28, 96),
  /** 星期列最小宽度（px）；0 = 跟随窗口自适应。 */
  cellWidth: num(0, 0, 120),
  /** 同步课程到日历小组件（按实际上课时间显示）；关闭即取消同步。 */
  calendarSync: bool(false),
  /* 多方案。 */
  profiles: z.array(z.unknown()).default([]).catch([]),
  activeProfile: z.string().default("").catch(""),
  /* 上课前提醒（下节课开始前 10 分钟推送）。 */
  classReminder: bool(true),
  /* 总览模式：不按周次过滤，显示全部课程（含单双周）。 */
  showAllWeeks: bool(false),
  /* 列表视图。 */
  layout: en("grid", ["grid", "list"]),
  /* 仅显示周一至周五（隐藏周末列，窄尺寸省空间）。 */
  hideWeekday: bool(false),
  /* 法定节假日当天的课程弱化显示（可能停课）。 */
  dimRestDay: bool(true)
});

/** 今日概览：聚合区块的显示开关。 */
export const todayOverviewConfigSchema = z.object({
  showTasks: bool(true),
  showDeadlines: bool(true),
  showWeather: bool(true),
  showTimetable: bool(true),
  /* 以下字段此前由设置页写入、组件读取但不在 schema 中，靠未知字段保留机制
   * 才未丢失。显式入表，默认值与 TodayOverviewWidget 的回退值一致。 */
  showGreeting: bool(true),
  showFocus: bool(true),
  greeting: z.string().default("").catch(""),
  maxTasks: num(5, 1, 12),
  maxCourses: num(6, 1, 12),
  maxDeadlines: num(5, 1, 12),
  /* 今日日程（跨实例日历聚合）。 */
  showEvents: bool(true),
  maxEvents: num(5, 1, 12)
});

/** 秒表：百分秒显示与计次保留条数。 */
export const stopwatchConfigSchema = z.object({
  showCentis: bool(true),
  lapLimit: num(10, 3, 50)
});

/** 各小组件类型 → 其配置 schema。没有可配置字段的类型不在此表。 */
export const WIDGET_CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  clock: clockConfigSchema,
  todo: todoConfigSchema,
  pomodoro: pomodoroConfigSchema,
  deadlines: deadlinesConfigSchema,
  analytics: analyticsConfigSchema,
  notes: notesConfigSchema,
  sketch: sketchConfigSchema,
  system: systemConfigSchema,
  hardware: hardwareConfigSchema,
  calendar: calendarConfigSchema,
  weather: weatherConfigSchema,
  sysbar: sysbarConfigSchema,
  shortcuts: shortcutsConfigSchema,
  files: filesConfigSchema,
  calculator: calculatorConfigSchema,
  unitconverter: unitConverterConfigSchema,
  colorpicker: colorPickerConfigSchema,
  bookmarks: bookmarksConfigSchema,
  music: musicConfigSchema,
  /** 「正在播放」独立类型：与音频监控共用配置 schema（布局被组件锁定为卡片）。 */
  nowplaying: musicConfigSchema,
  bluetooth: bluetoothConfigSchema,
  gallery: galleryConfigSchema,
  habit: habitConfigSchema,
  countdown: countdownConfigSchema,
  stopwatch: stopwatchConfigSchema,
  email: emailConfigSchema,
  timetable: timetableConfigSchema,
  todayoverview: todayOverviewConfigSchema
};

/* ------------------------------------------------------------------ */
/*  就地配置弹层：quick 字段标记 */
/* ------------------------------------------------------------------ */

/** 返回某类型小组件的默认配置（无 schema 的类型返回空对象）。 */
export function defaultWidgetConfig(type: string): WidgetConfig {
  const schema = WIDGET_CONFIG_SCHEMAS[type];
  if (!schema) return {};
  return schema.parse({}) as WidgetConfig;
}

/**
 * 清洗并补全一份配置：类型错误字段回退到默认、缺失字段补默认值、未知字段
 * 保留。用于加载时保证设置页与校验读到的都是合法数据。
 */
export function sanitizeWidgetConfig(type: string, config: unknown): WidgetConfig {
  const schema = WIDGET_CONFIG_SCHEMAS[type];
  if (!schema) return (config && typeof config === "object" ? config : {}) as WidgetConfig;
  const input = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const { data } = schema.safeParse(input);
  // zodiac 默认丢弃未知字段；这里把 schema 未覆盖的键拼回来，避免合法数据被清除。
  return { ...input, ...(data as Record<string, unknown>) } as WidgetConfig;
}

/**
 * 严格清洗：只保留 schema 已知的键，
 * 未登记类型返回空配置。与 sanitizeWidgetConfig 的差异：外部包是纯外部
 * 输入，未知键没有「新版本写入的合法数据」前向兼容豁免——一律剔除
 * （纵深防御，配合 Rust 侧 preset_package 的包级校验）。
 */
export function sanitizeWidgetConfigStrict(type: string, config: unknown): WidgetConfig {
  const schema = WIDGET_CONFIG_SCHEMAS[type];
  if (!schema) return {};
  const input = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const { data } = schema.safeParse(input);
  return (data ?? {}) as Record<string, unknown> as WidgetConfig;
}

/**
 * 校验配置是否合法。返回与原值等价的解析结果与其 schema 上下文，供设置页
 * 在保存前做校验。因所有 schema 均带 `.default()`/`.catch()`，解析恒成功，
 * 返回类型固定为 `{ success: true; data: WidgetConfig }`。
 */
export function validateWidgetConfig(type: string, config: unknown): { success: true; data: WidgetConfig } {
  if (!WIDGET_CONFIG_SCHEMAS[type]) {
    return { success: true, data: (config && typeof config === "object" ? config : {}) as WidgetConfig };
  }
  // 非对象输入（字符串/数字/数组）直接落空对象：顶层裸 z.object 无 .catch()，
  // safeParse 失败时 data 为 undefined，强转会把 undefined 当合法配置外泄。
  const input = config && typeof config === "object" ? config : {};
  const parsed = WIDGET_CONFIG_SCHEMAS[type].safeParse(input);
  return { success: true, data: parsed.data as WidgetConfig };
}
