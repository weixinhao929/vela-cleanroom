# 模板文档（前端视图与数据字典）

本项目前端为 React 19 组件树，无服务端模板。本文面向渲染/交互开发者，说明每个页面形态与小组件的**数据来源、变量（含类型与默认值）、处理逻辑**。类型以 TypeScript 为准，全部可在代码中静态追溯。

## 1. 全局数据源（所有页面共享）

| Hook / Store                  | 关键字段                                                                                                                                | 类型                                                                              | 说明                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `useSettingsStore`            | `preset` `themeMode`                                                                                                                    | `"default"\|"retro"\|"custom"` × `"system"\|"dark"\|"light"`                      | 外观；变更即写 CSS 变量（旧值 midnight/daylight/glass/terminal/paper 经迁移表归一；`"custom"` 配色由 `customTheme` 承载） |
|                               | `zoom` `fontSize`                                                                                                                       | `number`（100 基准，60–160 / 80–140）                                             | 界面缩放与字号百分比                                                                                                      |
|                               | `general.language`                                                                                                                      | `"简体中文" \| "English"`                                                         | 切换 i18n                                                                                                                 |
|                               | `extra.focusMode`                                                                                                                       | `"off"\|"light"\|"medium"\|"deep"`                                                | 专注静音档位                                                                                                              |
|                               | `notifications.sources`                                                                                                                 | `Record<NotificationSource, boolean>`                                             | 逐来源通知开关                                                                                                            |
| `useAppStore`                 | `tasks: Task[]` `deadlines: Deadline[]`                                                                                                 | 见 `domain/schemas.ts`                                                            | 任务/DDL 数据                                                                                                             |
|                               | `pomodoro: PomodoroState`                                                                                                               | `{ mode, remainingSeconds, isRunning, completedFocusSessions, currentTaskId, … }` | 番茄钟运行态                                                                                                              |
|                               | `pomodoroConfig: PomodoroConfig`                                                                                                        | 各时长/目标字段                                                                   | 配置（经 normalizeConfig 钳制）                                                                                           |
| `useWidgetStore`              | `instances: WidgetInstance[]`                                                                                                           | `{ id, type, x, y, w, h, z, opacity?, clickThrough?, ctBadge?, groupId? }[]`      | 当前视图布局（`ctBadge` 穿透角标开关、`groupId` 所属编组）                                                                |
|                               | `views: ViewDef[]` `activeView: string` `trash: TrashWidget[]` `groups: WidgetGroup[]` `templates: LayoutTemplate[]` `dock: DockConfig` | —                                                                                 | 多视图、回收站、编组、命名布局模板（§5.1）与本屏灵动岛配置                                                                |
| `useHabitsStore`              | `habits: Habit[]`                                                                                                                       | `{ id, name, done: Record<dateKey, boolean>, pinned?, remindAt?, … }[]`           | 习惯数据                                                                                                                  |
| `useWidgetConfig(instanceId)` | `config: WidgetConfig` + `update(patch)`                                                                                                | 见 §3 各组件变量表                                                                | 每实例独立配置                                                                                                            |

通用工具：`t(zh)/useT()` 翻译；`useNow(intervalMs)` 共享时钟；`useTauriEvent(event, handler)` 订阅 IPC 事件。

## 2. 页面形态（App 按 hash 分派）

### 2.1 桌面小组件层（默认入口）

- **结构**：`WidgetCanvas` → 逐实例 `WidgetCard` → registry 解析的组件。
- **变量**：布局来自 `instances`（x/y/w/h/z 定位）；编辑态由 `editMode: boolean` 控制。
- **交互逻辑**：拖拽/缩放经 rAF 写瞬态 `dragPreview`，pointerup 提交 store；对齐参考线由 `alignGuides` 渲染；框选矩形命中 `instances` 后批量置选。
- **布局工具**：编辑模式工具栏提供「布局模板」「布局历史」面板（同一锚位互斥打开）；画布挂载时 `initLayoutTimeline()` 接管 Ctrl+Z / Ctrl+Shift+Z。详见 §5。

### 2.2 设置窗口（`#/settings`）

- **结构**：`SettingsView` = 左侧导航（页面 + 小组件配置项）+ 右侧内容。
- **页面**：GeneralPage / StylePage / DisplayPage（含跨屏布局复制入口，§5.4） / AnimationPage / ConnectionPage / DockPage（灵动岛） / TaskbarPage（任务栏） / LicensePage（许可证） / UpdatePage / ViewPages（视图页 + 画布图库 `WidgetGalleryPage`）；DataPanel 内联于 GeneralPage，许可页（LicensePage）内联在 `SettingsView.tsx`；小组件配置项路由 `WidgetConfigPage`，另有灵动岛磁贴配置路由 `DockTileConfigPage` / `MiscItemConfigPage`。
- **交互逻辑**：所有表单直接写 settings-store（即时生效）；导航支持搜索过滤（`settings-search.ts` 索引）。

### 2.3 速记窗（quick-note）

- **结构**：单输入卡。**变量**：`text: string` 本地缓冲。
- **逻辑**：保存写入便签数最多实例的 notes，并 emit `sync:notes` 让桌面便签实时刷新。

## 3. 小组件配置变量字典

每个实例的配置存于独立 KV（`focus-desk.widget-config.<id>.v1`），设置页读写与校验经对应 zod schema 清洗（非法回退默认、缺失补默认）。下表列出各类型可配变量（布尔项均为「显示开关」语义，默认值括注）；无 schema 的类型（recycle / notifications / brightness / clipboard / misc / pin）没有可配变量。

### clock 时钟

`showSeconds`(true) `showDate`(true) `showWeekday`(true) `transparent`(false) `timeZone: string`("auto") `weekdayStyle: "short"|"long"` `hour12`(false) `style: "compact"|"standard"|"loose"` `zones: string[]`(空=本地) `face: "digital"|"analog"` `dateStyle: "auto"|"zh"|"slash"` `fontScale: number 0.6–1.6`(1) `color: string`(""=主题色)

### todo 待办

`showCompleted` `showCount` `showProgressTrack` `showEmptyState` `showFilter` 均(true)；`sortOrder: "newest"|"oldest"|"manual"`；`showDueGrouping`(true)（逾期/今天/即将分组）；`maxItems: 0–50`(0=不限)

### pomodoro 番茄钟

`spinRing`(false) 表盘旋转光效。运行数据不在此——见全局 `pomodoro` 状态。

### deadlines 截止

`showCompleted` `showOverdue` `showUrgency` `showGrouping` `showRelativeTime` `multiTierRemind` 均(true)；`sortOrder: "soonest"|"latest"`；`maxItems: 0–50`

### analytics 专注统计

`days: 3–30`(7) 趋势天数；`showMonthHeatmap`(true)

### notes 便签

`fontSize: "small"|"medium"|"large"`；`sortBy: "newest"|"oldest"|"manual"`；`showDate` `showCount` `showSearch` `showEmptyState` `markdown` `showTagBar` 均(true)。正文数据在 notes-store（非配置）。

### sketch 涂鸦

`defaultBrushSize: 1–20`(3)；`defaultColor: "white"|"gray"|"blue"|"green"`；`bgMode: "transparent"|"grid"|"white"|"dark"`(grid)；`exportQuality: 0.5–1`(0.92)

### system 系统信息

五类显示开关 `showCPU/RAM/GPU/Disk/Network`(true)；`compactMode`(false)；`refreshInterval: 1–30s`(3)；`showTrend`(false)；`showAllDisks`(false)；`thresholdAlert`(true, >80% 变红)；`networkMode: "first"|"all"|"aggregate"|"select"`；`networkSelect: string`（select 模式指定网卡名）；`showCoresGrid`(false)

### hardware 硬件监控

同上五开关 + `showBattery`(true)、`showTrend`(true 趋势曲线)、`refreshInterval: 1–30s`(3)、`showStaticInfo`(true 型号头)、`showUptimeProcess`(true)、`historyLen: 10–120`(40 趋势样本)、`showPeak`(false)

### calendar 日历

`showLunar` `showSolarTerms` `showHolidays` `showRestMarks` `showMemorialMarks` `showEventDots` 均(true)；`compact`(false)；`showWeekNumber`(false)；`firstDayOfWeek: "monday"|"sunday"`；`viewMode: "month"|"week"|"double"`；`showCellEvents`(true)；ICS 订阅：`icsEnabled`(false) + `icsUrl: string`

### weather 天气

`unit: "celsius"|"fahrenheit"`；`showWindHumidity` `showCity` `showForecast` `showHourly` `showSunTimes` `showAqi` `alertNotify` 均(true)；`refreshInterval: 5–120min`(30)；`cityIndex: 0–99`(0 记忆选中城市)

### sysbar 系统栏

`items: string[]`(["fps","lat","gpu","cpu","mem","cores"]) 条目自由组合（可选 fps/lat/gpu/cpu/mem/cores/net/battery）；`refreshInterval: 1–10s`(2)；`fontSize: "xs"|"sm"|"md"`；`separator: "bar"|"dot"|"none"`

### shortcuts 快捷方式

`showTitle`(true)；`titleCompact`(false 紧凑标题)；`showLabels`(true 图标下方名称标签)；`columns: 1–6`(2)；拖动落格与占用者**交换**（互斥，不叠加）；拖入 .lnk/.url 自动解析成目标路径（桌面删除快捷方式后入口仍可用，目标为文件夹时归位 folder）；旧条目挂载自愈迁移——仍指向 .lnk/.url 本体的条目经 classify_path 重解析改存目标路径（解析失败原样保留，幂等零空写）；网格与滚动带（marquee）条目均右键就地菜单（打开/在资源管理器中显示/复制路径/重命名/移除）；`customShortcuts: {id,label,path,kind:url|folder|file,missing?}[]`（`missing` 为「目标暂不存在」标记）；`marquee`(false 滚动带)；`builtinShortcuts: string[]`(空=不预置图标，勾选后存回收站/此电脑等系统位置 id)；`shortcutFolders: {id,label,childIds,sort?: "free"|"name"|"time"}[]` 文件夹磁贴（配 `folderPreview`(true 就地预览小窗) 与 `sfolderOpenMode: "click"|"hover"|"pin"` 弹层打开方式）；`positions: Record<id,{x,y}>` 自由排布格位（缺省按 columns 自动排）；`autoOrganize` 目录监视自动整理（`watchPath`/`extensions`/`nameTokens`/`extEnabled`(true)/`nameEnabled`(false)/`notify`(false)/`olderThanDays: 0–3650`(0 不限)/`olderBy: "modified"|"created"`/`minSizeMb`(0 不限)）；`order: string[]` 展示顺序。（应用启动器 applauncher 已下线并入本组件，旧实例读取布局时剔除。）

### files 文件浏览

`showHidden`(false)；`showFileSize` `showModifiedDate` `showChips` 均(true)；`sortBy: "name"|"size"|"modified"|"type"`；`sortOrder: "asc"|"desc"`；`nameDisplay: "full"|"noext"|"noname"`（完整 / 隐藏扩展名 / 隐藏文件名）；`viewMode: "list"|"preview"`（列表 / 内容预览）；`aliases: Record<path,name>` 显示别名（右键「设置显示名」写入）；`liveSync`(true 目录监视实时刷新，绑定失败回退轮询)；`root: string`(""=全局默认目录)；`rememberPath`(true) + `lastPath: string`

### calculator 计算器

`scientificMode`(false)；`showExpression` `showHistory` 均(true)；`angleMode: "deg"|"rad"`；`mode: "calc"|"encode"|"hash"`(calc 顶部页签：计算 / 编码 / 哈希)

### unitconverter 单位换算

`showExtended`(false)；`rememberCategory`(true)；`showAllUnits` `showHistory` 均(true)

### colorpicker 取色器

`autoCopy`(false)；`showHex` `showRgb` `showHsl` `showHistory` 均(true)；扩展格式 `showHsv` `showCmyk` `showRgba` `showCssVar` 均(false 默认收起)；`historyCap: 4–24`(8)

### stopwatch 秒表

`showCentis`(true 百分秒)；`lapLimit: 3–50`(10 计次保留条数)

### bookmarks 书签

`layout: "list"|"grid"`；`sortBy: "newest"|"name"|"manual"`；`showFavicon` `showSearch` 均(true)

### music 音频可视化 / nowplaying 正在播放（复用同表；后 4 键仅 nowplaying 卡片消费）

`visualStyle: "bars"|"wave"|"mirror"|"minimal"|"radial"|"butterfly"`；`visualHeight: 10–100`（占卡片内容区高度的百分比，卡片放大频谱跟着变大）(64)；`mode: "playback"|"microphone"|"both"`；`layout: "spectrum"|"nowplaying"|"both"`；`colorMode: "theme"|"mono"|"rainbow"`；`gain: 0.5–3`(1)；`smoothing: 0–1`(0.5)；`bandCount: 16–96`(64)；`peakHold`(false)；`dist: "log"|"linear"`；`showStatusText`(true 底部状态文字)；`transparent`(false 无底板透明)；nowplaying 专属：`centerTitle`(false 标题与歌手居中)；`showSeekbar`(true)；`showModeButtons`(true 随机/循环按钮，按会话能力位出现)；`wheelVolume`(true 滚轮调应用音量)

### bluetooth 蓝牙

`showDisconnected`(false)；`showDeviceType`(true)；`showBatteryLabel` `showName`(false)；`layout: "grid"|"list"`；`gap: 4–40`(16)；`autoRefreshSeconds: 0–300`(30, 0=关闭)；`lowBatteryThreshold: 0–50%`(20, 0=关闭)；`filterType: string`("all")；`sortBy: "default"|"battery"|"name"|"type"`

### gallery 图库

`columns: 2–6`(3)；`gap: 2–24`(8)；`thumbShape: "square"|"rounded"|"circle"`；`showTags`(true)；`driftWall`(false 漂移墙模式)

### habit 习惯

`showCompleted` `showStreak` `showCount` 均(true)

### countdown 倒计时

`defaultPreset: 1–120min`(25)；`loopAfterComplete`(false)；`notifyOnEnd` `showSeconds` `showPresets` 均(true)

### email 邮件

`refreshInterval: 1–60min`(5)；`showPreview` `showTime` 均(true)；`maxItems: 5–50`(20)；`showUnreadOnly`(false)；`notifyNewMail`(true)；`doNotDisturbHour: -1|0–23`(-1 定时免打扰)

### timetable 课程表

`showLocation` `showWeeksBadge` `showTimes` 均(true)；`compact`(false)；`sectionTimes/sectionTimesEnd: string` 节次时间表；`totalSections: 0–30`(0 自动)；`cellHeight: 28–96px`；`cellWidth: 0–120px`(0 自适应)；`calendarSync`(false 同步到日历)；`profiles: unknown[]` + `activeProfile: string`（多方案，由导入流程写入）；`classReminder`(true 上课提醒)；`showAllWeeks`(false 总览)；`layout: "grid"|"list"`

### todayoverview 今日概览

七类区块开关均(true)：`showTasks/showDeadlines/showWeather/showTimetable/showGreeting/showFocus/showEvents`（`showEvents` 今日日程，跨实例日历聚合）；`greeting: string` 自定义问候语；`maxTasks: 1–12`(5)、`maxCourses: 1–12`(6)、`maxDeadlines: 1–12`(5)、`maxEvents: 1–12`(5)

## 4. 处理逻辑约定

1. **读取路径**：组件内一律 `const { config } = useWidgetConfig(instanceId)`；设置页保存前经 `sanitizeWidgetConfig(type, config)` 清洗，保证渲染期读到的字段恒合法。
2. **未知字段保留**：清洗会拼回 schema 未覆盖的键，历史数据渐进迁移不丢字段。
3. **默认值唯一来源**：`defaultWidgetConfig(type)` 由 schema `parse({})` 推导，新增字段自动出现在设置页与新建实例中。
4. **事件驱动刷新**：跨窗口配置变更经 `sync:widget-config` 推送，接收端校验失败回退本地权威副本。

## 5. 布局模板、布局历史与预设

### 5.1 命名布局模板（I2）

- **数据**：`LayoutTemplate { id, name, createdAt, instances }`，存于 widget-store 的 `templates`；持久化键 `focus-desk.screen.<N>.widgets.templates.v1`（localStorage + SQLite `widget:templates:<N>` 镜像，随完整备份走）。只存布局字段，不存实例配置。
- **动作**（`widget-store.ts`）：`saveTemplate(name)` 保存当前视图全部实例（剥离 groupId，重名返回 false）；`applyTemplate(id)` 用模板整表替换当前视图——实例 id 全部重发，便签/书签/日历/涂鸦的数据桶随 `copyInstanceData` 搬家（模板带回内容，见 §5.2）；`deleteTemplate(id)` 删除。入口：编辑模式工具栏「布局模板」面板；套用前原布局自动存入时间线（§5.3）。

### 5.2 实例数据桶（`instance-data.ts`）

便签/书签/日历/涂鸦的数据存放在「实例 id 寻址」的 localStorage 键里（`focus-desk.notes.<id>` 与 `.trash`、`focus-desk.bookmarks.<id>`、`focus-desk.calendar.<id>.v1`、`focus-desk.sketch.<id>`）。复制实例与套用布局模板都会重新分配实例 id，`copyInstanceData(fromId, toId)` 把源实例名下的数据桶复制到新 id 名下（源不动，镜像进备份；源键缺失的桶跳过）。gallery 有意不参与：其元数据引用磁盘文件副本，复制会让两个实例共享磁盘生命周期、互删文件——副本回到空库是更安全的降级。

### 5.3 布局时间线（`layout-timeline.ts`）

- **捕获**：订阅 widget-store（零侵入），实例/编组引用变化即标脏；500ms 尾沿防抖 + 2s 强制冲刷窗；显著性阈值——只有实例/组的**增删**才落快照（移动/缩放/改配置不产生历史噪音）；每 (screen, view) 键独立，auto 快照上限 20 条逐最旧，`pinned: true` 的手动固定快照永不驱逐。持久化 `focus-desk.screen.<N>.timeline.<view>.v1` + SQLite 镜像。
- **入口**：Ctrl+Z 撤销 / Ctrl+Shift+Z（Ctrl+Y）重做（文本输入焦点时不接管）；编辑模式工具栏「布局历史」面板可固定（pin）、恢复到任意快照、清空（两步确认）。恢复统一走 `applyTimelineState`：先冲刷未落盘快照（恢复本身可再撤销）、清除与复活实例同 id 的回收站条目（防「回收站里还躺着一份」）、恢复期间挂起自动捕获。

### 5.4 跨屏布局复制（`screen-layout-copy.ts`）

设置 → 显示页入口：把源屏的视图列表、每视图实例与编组、活动视图整体复制到目标屏（localStorage 权威 + SQLite 同键型镜像落盘；目标屏窗口存活时 emit `sync:widgets` 即时采纳，冷启动 hydrate 也能读到）。**实例 id 保留**——两屏实例共用同一数据桶（「同一块便签放两块屏」即预期语义）；需要独立副本时用布局模板（`applyTemplate` 会重造 id 并搬数据）。不复制 dock（岛配置按屏独立）、模板与回收站。

### 5.5 样式预设包与在线预设画廊

- **样式预设包**（`src-tauri/src/preset_package.rs` + `src/lib/style-presets.ts`）：`.zip` 格式的样式预设分享，包内仅 `manifest.json` + `presets.json` 两个条目（`format: "vela-style-presets"` / `version: 1`）；导出打包全部样式预设，导入过 Rust 侧加固校验——条目白名单（拒绝目录/嵌套路径/未知条目）、拒绝重复条目、条目数 ≤ 8、单条 ≤ 4MB、总量 ≤ 8MB（防压缩炸弹）——之后只把 `presets.json` 文本交前端：`sanitizeWidgetConfigStrict` 严格清洗（只留 schema 已知键）+ 按（widgetType + name）同名去重合并。
- **在线预设画廊**（`src/lib/preset-gallery.ts`，StylePage 消费）：画廊源为 GitHub 仓库地址（映射到 raw.githubusercontent 的 `gallery-manifest.json`，main 分支）或 manifest 直链，存于 `extra.presetGallerySource`；manifest 条目 `{ id, name, desc, file, sha256, size }` 逐条校验（坏条目跳过）；下载经 Rust `download_gallery_file` 做 sha256 强校验 + `.part` 原子落盘，再走预设包导入链（`import_preset_package_from_path` + `importPresetsFromPackage`）。零服务器：manifest 与 zip 放公开仓库即可。

**组件数量口径**：注册表共 34 类；画廊/设置页可添加 32 类（不含仅灵动岛的 `misc`（dockOnly）与截图钉图专属的 `pin`（hidden，只由「钉到桌面」流程创建，无 src 的空贴图实例读取布局时剔除））。
