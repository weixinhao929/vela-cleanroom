# 设计文档

面向专业读者，论述 Vela 的技术决策依据、软件设计、数据建模与核心技术实现，并给出性能分析。系统总览见 [ARCHITECTURE.md](ARCHITECTURE.md)；本文是其下钻。

## 1. 技术选型论证

| 决策 | 备选 | 选择理由 |
| --------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Tauri 2 而非 Electron | Electron | 安装包约 7.4 MB vs 100+ MB；常驻内存减半以上；需要的能力（低层钩子、SMTC、全局快捷键）Rust 生态均有成熟 crate |
| React 19 + zustand 5 | Vue/Pinia、Redux | 组件模型契合"注册表 34 类异构小组件"；zustand selector 订阅 + shallow 比较满足"单实例变更不牵动全桌布"的粒度要求 |
| SQLite 单库而非多文件 | 纯 localStorage / IndexedDB | 需要事务性整表导入导出、行级并发写与每日备份；localStorage 仅作浏览器模式降级与轻数据镜像 |
| ts-rs 生成 IPC 类型 | 手写 TS 接口 | 线协议字段以 Rust 为单一来源，消除手写映射漂移（历史上已发生一次缺字段事故） |
| zod 校验入口数据 | 只信 TS 类型 | 运行期数据（localStorage/导入文件/远端同步）不可信，schema 与类型同源派生 |

## 2. 软件设计

### 2.1 架构风格

六边形架构：`features/widgets` → `store` → `domain` ← `ports` ← `lib/persistence`。依赖方向单向向内；领域层零 IO、时间注入，保证可测性。

### 2.2 关键模式落点

- **状态机**：番茄钟为纯 reducer（`pomodoroReducer`），tick 恰好推进 1 秒且无时钟依赖；节奏控制（心跳、唤醒补偿）全部在编排层。
- **写队列**：SQLite 写经 promise 链串行（`enqueueWrite`），解决「整表替换 × 行级写」交错竞态；60s 判死防头部阻塞。
- **观察者/中介者**：硬件采样单一广播源（订阅计数 + 最小间隔协商）；跨窗口同步以事件总线为中介，收发双方互不感知。
- **两阶段提交（应用级）**：恢复备份走 pause→ack→import→resume 协议，用应用层确认弥补 localStorage 无法事务化的缺口。
- **注册表**：小组件元数据与懒加载器双表登记（registry.tsx，34 类：画廊可添加 32 + 仅灵动岛 misc（`dockOnly`）+ 截图钉图专属隐藏 pin（`hidden`））；配置 schema 注册表（config-schemas.ts）与之平行。
- **错误分层**：AppError 五子类 + `asAppError` 归一；边界隔离（根 + 每组件）+ 环形崩溃日志构成观测闭环。

### 2.3 并发模型

前端单线程假设下的三类并发被显式建模：① IPC 写顺序（队列化；超时只放行队列，调用方仍拿真实落定结果）；② 多窗口状态传播（事件 + instanceId 抗回声；settings/app 三方合并按 `(ts, json)` 仲裁并发，widgets/dock/habits 按单调 rev 抗乱序）；③ 用户输入 vs 后台任务（编辑会话挂起广播、水合窗口 tombstone 合并）。

## 3. 数据建模

### 3.1 ER 概览

`text
tasks 1───∞ pomodoro_sessions (task_id, 弱关联：任务删除不级联)
deadlines（独立聚合根）
pomodoro_interruptions（独立事实表，按 ended_at 查询）
settings（KV：设置快照 / widget 布局镜像 / lsmirror:*）
tags（预留）
`

设计取向：

- **弱关联**：会话记录 `task_id` 不设外键约束——待办删除后历史统计必须保留，完整性由应用层维护。
- **JSON-in-column**：`tasks.tags`、`deadlines.notified_tiers` 以 JSON 字符串存储。理由：均为整体读写的小数组，无查询需求；换取 schema 演进零成本。
- **时间一律 ISO 8601 TEXT**：SQLite 无日期类型，TEXT 可读、可字典序比较（`firstFocusDate` 的 min 计算依赖此性质）。
- **索引即查询**：三个索引精确对应三条热查询（DDL 按 due_at 排序、会话按 started_at 聚合、打断按 ended_at 过滤今日）。

### 3.2 演进策略

v1→v11 全部为幂等增量迁移，按版本数组顺序执行：v1–v6 为 `ADD COLUMN ... NOT NULL DEFAULT` 或数据规范化改写（v6 重写脏时间戳），v7/v8 新增通知历史与剪贴板历史表，v9 增加按天累计流量表 `net_traffic_daily`，v10 给剪贴板历史补 `files` 列。旧版本文件可直接升级，无需停机迁移脚本。完整 DDL 见 [DEPLOYMENT.md §5](DEPLOYMENT.md#5-数据库结构)。

## 4. 核心技术剖析

### 4.1 点击穿透命中测试

桌面层窗口整体置底 + `WS_EX_TRANSPARENT` 语义穿透，但控件必须可点。方案：前端以 rAF 收集交互元素包围盒（含 hover 扩展区等动态矩形），指纹去重后上报 Rust；Rust 低层鼠标钩子按矩形命中决定放行/吞掉输入。关键权衡：**视口 CSS 像素坐标系两端天然一致**（WebView 已含缩放效果，Rust 光标坐标除 scale_factor 后同坐标系），早期按 zoom 因子反向换算反而造成错位。

### 4.2 跨窗口一致性协议

挑战：多 WebView 无共享内存，事件乱序、回声、并发编辑三重问题。解法组合：载荷携带发送方 instanceId；接收端 applyingRemote 闸门抑制回声；settings / app 走三方合并——以上次交换的快照为共同祖先，本地编辑不动基线，远端相对基线变了才按 `(ts, json)` 与本地当前值仲裁（两端选出同一赢家，不分叉），app 的删除靠显式凭证 + 30s 墓碑而非「缺行即删」，保留了对端没有的本地值时回播收敛；widgets / dock / habits 按单调递增 rev 整包采纳并拒旧；布局按 screenId 分屏隔离且不抢占他窗 activeView；拖拽会话挂起广播、结束补发最终快照。

### 4.3 persist-first 写路径

内存态只在持久化确认后变更：`writeThrough(local, sqlite)` 在 SQLite 分支先 await IPC 再 set()。代价是 UI 延迟一拍 IPC；收益是消灭「UI 显示成功、重启回档」类静默发散。计时类高频写例外处理（fire-and-forget + 失败仅上报），避免通知链路阻塞主流程。

### 4.4 后台时钟诚实性

Chromium 对后台 WebView 节流至 ~1 分钟，直接 interval 走秒必然漂移。方案：Rust 心跳定期唤醒并投递 tick 事件；前端收到后按墙钟差值幂等推进（睡眠 30 分钟醒来只补一条会话记录而非 1800 次 tick）；多屏由 primary 窗口竞选唯一驱动权。

### 4.5 设计令牌与视觉机制

- **主题**：2 套内置预设（默认 / 终端——id 仍为 `retro`）+ 自定义派生档（由 `customColors` 派生，不计入预设数）× system/dark/light，`lib/theme-engine.ts` 的 `applySettings` 是唯一写入方。自定义档由 `customColors`（底色 + 文字色）经 `deriveCustomTokens` 派生全套 token，含文字极性联防：背景亮度极性与当前明暗档相反时自动翻转文字色，任何组合下保证可读。
- **动效令牌**：`--anim-dur[-fast|-slow]` 由 theme-engine 按动效三档写入 `:root`；`src/lib/durations.ts` 是 JS 侧动效时长单一真源——读取这三个 token、按与 `feature-animations.css` 同一组乘数派生 `--dur-fx-*` / `--dur-spatial-*` / `--dur-dock-spring`，JS 动画与 CSS 过渡同源同缩放（收口前两侧各写各的、都不跟随三档）；该约束由 `lint:anim` 链中的 `check-js-anim` 静态守护（motion 弹簧须显式豁免、rAF 自调度循环须带 reduce-motion/visibility 健康信号）。主题切换水墨过渡时长经 `extra.themeInkDurationMs`（300–3000ms，默认 1400）注入 `lib/theme-ink.ts`；hex 颜色统一经 `normalizeHexColor6` 归一（3/4/8 位与 rgb()/rgba() 收敛 #rrggbb，防明暗极性误判）。
- **令牌门禁**：`lint:anim`（will-change / transitions / fx 门控规范 + Tier1 布局属性动画 strict）配 `scripts/anim-token-baseline.json` 基线棘轮——存量违规登记在册、只减不增，升级为阻断级；`lint:sizes`（`check-size-tokens.mjs`）禁 `--fs-*` / `--rad-*` 之外的裸 px 字号与圆角；`lint:tokens`（`check-css-tokens.mjs`）扫描全部 `var(--x)` 引用与四类定义处（CSS 声明 / @property / setProperty / style 对象键）对账，引用未定义 token 即失败——「白字白底」类事故均属此模式且平时全绿不可见。
- **视觉机制**：
  - `ThemeTooltip`（`components/ThemeTooltip.tsx`）：document 级委托接管原生 `title=`——命中后立即摘除（防系统样式白框，mouseout 还原，无障碍语义不变），350ms hover-intent 后以主题令牌浮层渲染；`pointer-events: none` 不破坏桌面层点击穿透，模块级单例幂等安装（设置窗与桌面层多 Host 共用）。
  - `FloatingThemeSync`（`app/FloatingThemeSync.tsx`）：设置/速记浮窗按「浮窗深浅」偏好改写明暗档后在本窗重放 `applySettings`，桌面层窗口不受影响；挂载顺序必须在 SettingsSync 之后，保证本窗覆盖写在其全局写之后落定。
  - `palette-extract`（`domain/palette-extract.ts`）：图片 → 主题色板的纯函数管线（跳过半透明像素 → 中位切分 8 块 → 按频率 × 灰度惩罚 × 过亮过暗惩罚 × 中等饱和度加分选种子色 → 夹进柔和区间 → 生成 7 档明暗梯度），样式页「从图片提取色板」与单测共用。
  - `EmptyState`（`components/ui/EmptyState.tsx`）：统一空状态（图标槽 + 主文案 + 行动提示），收敛此前散落的 bespoke 空态类名；迁移策略为「新代码一律用、存量改到哪迁到哪」。

## 5. 性能分析

### 5.1 渐近改进（本轮审计落地项）

| 热点 | 原 | 现 | 触发频率 |
| ------------------ | --------------------------- | ------------------ | ------------------- |
| 时区校验 | O(z) 次 ICU 构造/s | O(1) 缓存命中 | 每秒 |
| 趋势/热图桶查找 | O(n×d) | O(n+d) | 打开统计面板 |
| 习惯热力图 | O(cells×habits) | O(Σkeys) | 每次打卡 |
| 日历重复展开 | O(cells×anchors) 正则 | O(anchors) 预解析 | 月视图渲染 |
| 课程表列表分桶 | O(7n+Σk·logk)/渲染 | O(n log n) memo 化 | 每 30s tick |
| 批量删/排序 IPC | N 次往返 | 1 次（单事务） | 清空已完成/拖拽排序 |
| 粒子动画 DOM 读 | 3n/帧（≈36 万次/s@2000 粒） | 1/帧 | 动画期 |
| mousemove 布局抖动 | ≤3 次强制 reflow/事件 | ≤1 次 | 指针移动 |

### 5.2 结构性预算

- **采样扇出**：N 个监控组件各自轮询 = N×3 IPC/s；统一广播后全局 1 次采样/s，与组件数解耦。
- **拖拽帧率**：pointermove 直写 store 会触发全画布 reconcile + 持久化；改为 rAF 内更新瞬态 preview（不进 store、不序列化），pointerup 一次 commit + 补发广播。实测拖拽期主线程长任务消除。
- **持久化风暴**：60 次/s 的对齐写经尾沿防抖收敛为 1 次 stringify + 双端复用；镜像同步同理 500ms 合批。
- **渲染纯性**：渲染期副作用（历史追加/日志写入）移入 effect 后，hover 类无关重渲不再产生重复样本与 O(L) 数组拷贝——同时修复趋势曲线失真的正确性问题。

### 5.3 内存

音频可视化 Float32Array 复用 + DPR 缓存；涂鸦撤销栈截断 20 张 PNG dataURL（峰值数十 MB → 受控）；粒子池固定分配；崩溃日志环形上限 50 条、文本截断 2000 字符。会话/打断记录 500/300 条滚动截断，超长期统计走 SQL 聚合（FromAgg 口径）不受截断影响。

## 6. 测试策略

领域纯函数（统计/reducer/CSV/校验）注入固定时间戳直测；store 水合合并语义以命令名 mock 的 invoke + 真实适配器验证；面板冒烟测试守护渲染不抛错；Rust 侧覆盖迁移/仓储/xlsx 解析/任务栏状态引擎。基线：tsc + eslint(0 警告) + vitest（194 个测试文件 · 1837 用例）+ cargo test（主 crate 476 通过 + 8 ignore，`cargo test -p velatap` 另 19 通过；2026-10-08 实测全绿）方可合入；动效规范由 `lint:anim` 静态脚本把关，令牌断链由 `lint:tokens`、字号/圆角裸 px 由 `lint:sizes` 把关，i18n 由 `lint:i18n` 把关。
