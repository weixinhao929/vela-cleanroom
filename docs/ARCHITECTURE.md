# 架构文档

本文描述 Vela（Focus Desk）当前代码的实际架构，作为开发与评审的基准，是根目录 [ARCHITECTURE.md](../ARCHITECTURE.md)（模块级全量版）的摘要分册。行号级细节以源码内 JSDoc/Rustdoc 为准。

## 1. 进程与窗口模型

单个 Tauri 应用按需创建多个 WebView 窗口，共享同一前端 bundle，以 URL hash 区分形态。全部 8 类窗口均由 Rust 运行时按需创建（`tauri.conf.json` 的 `app.windows` 为空）：

| 窗口 label | 入口 | 形态 |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `widget-0..N` | `index.html#screen=<i>` | 桌面小组件层：无边框、透明、置底、点击穿透；每物理屏一个 |
| `settings` | `index.html#/settings` | 设置窗口（可拖动、非置底） |
| `quick-note` | `index.html#quick-note` | 全局速记小窗（快捷键 Ctrl+Alt+Q 等动态创建） |
| `snip` | `snip.html` | 截图覆盖窗：冻结帧框选 + 标注，无边框置顶铺满目标显示器；vite 多页精简入口，旧 `index.html#snip` 由 main.tsx 重定向 |
| `fullscreen` | `fullscreen.html#fullscreen&kind=xx` | 全屏展示窗（kind = clock / countdown / pomodoro，覆盖光标所在屏，Esc/双击退出）；精简入口，旧 hash 同上重定向 |
| `super-panel` | `super-panel.html` | 长按右键取词的超级面板（光标旁弹出，按剪贴板内容类型路由动作）；精简入口，旧 hash 同上重定向 |
| `taskbar-net` | `taskbar-net.html` | 任务栏网速条：独立 vite 多页精简入口，零交互常驻小窗 |
| `web-preview` | 外部 URL（`WebviewUrl::External`） | 应用内网页浮层：独立 capability（`capabilities/web-preview.json`，仅 close + start-dragging），远程内容不可达自定义命令 IPC |

- 只有 `widget-0` 是 **primary**：唯一驱动番茄钟 tick、系统通知、托盘事件与快捷键 handler（`lib/tauri.ts:isPrimaryWidgetWindow`），避免多屏双写。
- 显示器热插拔由 Rust 侧监听并同步窗口集合；窗口与屏幕的映射按「持久化物理名 → 槽位」稳定重建。
- 后台运行时 tick 由 Rust 心跳驱动并唤醒 WebView（A-tick），规避 Chromium 对后台标签的节流。
- **单实例 + argv 命令面**：`tauri-plugin-single-instance` 保证只有一个进程常驻，第二实例把 argv 转发给首实例后退出；首实例 `cli.rs` 解析 `--toggle-layer / --show-settings / --toggle-pomodoro / --new-task "标题" / --toggle-palette / --toggle-dock / --open-dock-panel` 并复用与全局快捷键相同的 `shortcuts::dispatch` 分派，转发后广播 `app:second-instance`（详见根文档 §3.2）。

## 2. 前端分层

`text
features/ widgets/ UI 层（React 组件、面板、设置页）
   │
store/ 状态层（zustand + subscribeWithSelector）
   │ app-store 任务/DDL/番茄钟（persist-first 写路径）
   │ settings-store 外观/行为/通知（变更即 applySettings + 防抖落盘）
   │ widget-store 布局/视图/z 序/回收站（300ms 防抖双后端）
   │ habits-store 习惯打卡（localStorage + 镜像）
   │
domain/ 领域层（纯函数）：统计聚合、番茄钟 reducer、
   │ CSV、自然语言日期、农历、备份校验、zod schema
   │
ports/ 端口接口（六边形架构）
   │
lib/persistence/ 适配器：localStorage（浏览器）/ sqlite（桌面）
   │
lib/ 基础设施：主题引擎、跨窗口同步、网络、通知…
`

约束：

- 领域层全部纯函数、无时钟依赖（时间由参数注入），可直接单测。
- 组件层禁止直连存储细节，只经 store 与端口。
- React 渲染期零副作用（采样追加、历史记录等一律在 effect 中完成）。

## 3. 数据与持久化

### 双后端适配器

`ports/persistence.ts` 定义端口，`resolvePersistenceAdapter()` 按运行时选择：

- 浏览器开发模式 → localStorage（zod 校验，损坏数据隔离为 `.corrupt-*` 并 toast 告知）。
- Tauri 桌面 → SQLite，经 `commands.rs` 门面 + `repositories.rs` 行级 SQL。

### 写路径（persist-first）

`app-store.writeThrough(context, local, sqlite)`：SQLite 模式先等 IPC 成功再提交内存；失败内存不变并经 `reportPersistError` 弹 toast（5s 节流）。所有 SQLite 写经 `enqueueWrite` **串行队列**（防止整表替换与行级写交错互相覆盖）；单笔挂起超 60s 判死放行队列。

### 批量化

- 布局保存：300ms 尾沿防抖 + 单次 stringify 复用（localStorage 与镜像共用一份 JSON）+ pagehide 强制冲刷。
- localStorage 备份镜像：500ms 防抖合批，`flushMirrorSync()` 提供确定性落盘。
- 任务批量操作：Rust 侧 `delete_tasks` / `reorder_tasks` 单事务批量命令（N 次 IPC → 1 次）。

### 备份体系

- 便签/习惯/书签等 localStorage 数据经 `local-backup.ts` 整表镜像进 SQLite（`lsmirror:` 前缀），消除自动备份盲区。
- 每日滚动备份（Rust 按天去重、清理过期），先冲刷镜像再打包。
- 完整恢复走 **暂停-确认-恢复协议**（`persist-gate.ts`）：广播暂停 → 各窗 ack → 导入 → 广播恢复并 reload，防止并发防抖写覆盖刚恢复的数据。

### 水合语义

启动时 localStorage 为权威源：DB 只是镜像，落后时回写自愈而非反向覆盖；水合窗口内的用户操作通过 id 合并 + tombstone 胜出；慢速水合有 4s 安全网，绝不卡死启动。

## 4. 跨窗口同步

`lib/cross-window.ts` 订阅三个 store，本地变化尾随防抖（设置 80ms / 布局 120ms）后广播；接收侧：

- 回声抑制：载荷携带发送方 instanceId，跳过自身；应用远端时置 `applyingRemote` 抑制订阅回播。
- **三方合并（`sync:settings` 叶子级 / `sync:app` 行级，`mergeLeaves` / `mergeRows`）**：以上次与对端交换（发射 / 采纳）时的快照为共同祖先（基线）；本地编辑只给叶子 / 行盖时间戳、**不动基线**。远端相对基线没变 → 保留本地；变了 → 按 `(ts, json)` 字典序与本地当前值仲裁，两端输入相同必选同一赢家，不会各选各的而永久分叉。发射时把改过的值的时间戳重盖为包 `ts`，同一个值在两端持有相同 ts。
  - 历史：旧实现的「字段级回退保护」在编辑瞬间就把基线同步成本地值，「本地 ≠ 基线」恒假，实际从未生效（任何并发包都整包采纳）；且比较粒度是顶层字段，`general` 等嵌套对象的不同子键并发修改会互相回滚并永久分叉。2026-09-18 重写。
- **删除凭证与墓碑（`sync:app`）**：整表缺行**不再**推断为删除（可能只是对端还没看到新增）；删除凭显式 `removedTasks` / `removedDeadlines`，其时刻取包 `ts` 与本地编辑仲裁（编辑晚于删除则编辑胜）；已删行记 30s TTL 墓碑，陈旧包不能复活它，但对端在删除之后又编辑过的行按仲裁复活采纳。
- **分歧回播**：保留了对端没有的本地值时立即回播一次；合并后本地已与基线一致，对端采纳后不再分歧，不成环。
- 其余通道：`sync:widgets` / `sync:dock` / `sync:habits` 按发送方单调 `rev` 拒绝乱序 / 重复旧快照（整包采纳）；`sync:pomodoro` 按 `wallMs`；`sync:session` / `sync:interruption` 为单条增量通道（接收方按 id / 组合键去重 append，副屏专注统计即时刷新）；布局载荷按 screenId 分屏隔离，不抢占他窗 activeView；`sync:view-switch` 独立即时通道驱动真正切换视图。
- 拖拽/缩放会话期挂起广播（`setWidgetsSyncSuspended`），pointerup 一次性补发最终快照。

## 5. 主题与动效

`lib/theme-engine.ts` 是外观的唯一写入方：2 套内置预设（默认 / 终端——id 仍为 `retro`，曾名「复古」）+ 自定义档（由 `customColors` 底色 + 文字色派生，不计入预设数）× system/dark/light 解析生效 token，一次性写入 CSS 变量与 `data-theme / data-no-glass / data-fx / data-fx-off` 等属性，CSS 侧据此门控。设置/速记浮窗经 `FloatingThemeSync`（`app/FloatingThemeSync.tsx`）按「浮窗深浅」偏好改写明暗档后在本窗重放同一引擎，桌面层不受影响。减少特效时全局关闭 backdrop-filter（低端机主要掉帧源）。动效三档 + 逐特效开关（JS 与 CSS 消费同一份配置）；系统与应用内 reduce-motion 双信号实时生效。

## 6. 性能工程

已固化的机制（详见各文件 P-perf/C-x/F-x 标记注释）：

- **共享时钟**：同间隔 `useNow` 共享一个 interval（引用计数停表）。
- **共享采样**：硬件监控单一 `sys:stats` 广播（Rust 按订阅者最小间隔采样一次），静态型号低频投递；替代 N 组件各自轮询。
- **拖拽**：rAF 节流 + 瞬态 dragPreview（不写 store 不落盘）+ 会话挂起广播。
- **点击穿透**：交互矩形指纹去重上报，无变化不发 IPC。
- **渲染纯性**：历史采样、崩溃记录等副作用全部移入 effect；轮询结果全等时保旧引用避免冗余重渲；隐藏页暂停扫描。
- **算法**：趋势/热图 Map 桶索引 O(n+d)；习惯热力图预聚合；日历重复锚点预解析；时区校验缓存。
- **动画**：Canvas 替代 DOM 层（像素翻牌、粒子文字单 rAF 循环）；reduce-motion 全链路短路。
- **事件化替代轮询**：媒体会话列表经 `media:sessions` 事件推送（`lib/media-sessions.ts` 引用计数单例：初值拉取 + 30s 兜底复核，替代 3s 轮询）；Rust 会话治理每拍一次枚举共享喂选择器/订阅/分页。心跳线程在番茄钟不跑时经 `set_heartbeat_enabled` Condvar 真挂起（零唤醒）。
- CI 辅助：`npm run lint:anim` 静态检查 will-change/transitions/fx 门控规范 + Tier1 布局属性动画 strict 门禁（无豁免即失败），并以 `scripts/anim-token-baseline.json` 基线棘轮阻断裸写时长/缓动（存量只减不增），另含 JS 侧 `check-js-anim`（motion 弹簧须显式豁免 + rAF 循环健康度）；`npm run lint:tokens`（`check-css-tokens.mjs`：全部 `var(--x)` 引用与定义处对账，引用未定义 token 即失败）与 `npm run lint:sizes`（`check-size-tokens.mjs`：字号/圆角禁裸 px）共同守住 token 化——动效时长走 `--dur-*` 族（JS 侧单一真源 `lib/durations.ts`，跟随动效三档缩放），字号/圆角走 `--fs-*` / `--rad-*`。
- UI 交互规范（等待指示覆盖层 / touch target ≥48px / 按压几何形变 / 灵动岛动效对照表）集中在 [ui-guidelines.md](ui-guidelines.md)。

## 7. 可靠性

- 错误分层：`domain/errors.ts`（AppError 五子类 + asAppError 归一）。
- 故障隔离：根 ErrorBoundary + 小组件级 WidgetErrorBoundary（重试即重建子树）。
- 观测性：环形崩溃日志（window.error/unhandledrejection/边界捕获，前端环形缓冲上限 50 条；Rust 侧 `logging.rs` 另有 crash-log.json：上限 200 条 / 保留 30 天 + 近 7 天统计 + 最近 5 条明细 + 一键清空，落库/清空广播 `crash:logged`）+ 启动打点时间轴（boot-profile，主窗口发布跨窗共享时间轴 `focus-desk.boot-profile.shared.v1`，设置页诊断区展示全窗口口径）。
- 网络韧性：统一 fetchWithTimeout（外部 signal 合并非破坏）+ withRetry 指数退避；离线感知跳过注定失败的请求（`navigator.onLine` 仅作可靠否定信号）。

## 8. Rust 侧

`text
lib.rs 编排：单实例插件（首个）、插件装配、多屏窗口生命周期、托盘、启动流程
cli.rs 单实例 argv 命令面：--toggle-layer / --show-settings / --toggle-pomodoro / --new-task / --toggle-palette / --toggle-dock / --open-dock-panel
commands.rs 命令门面（spawn_blocking + lock_db，逻辑下沉仓储层）
db.rs 连接池化 Mutex、版本化迁移（11 版（v11 = 打断表 started_at 索引）：v9 net_traffic_daily 流量表、v10 剪贴板 files 列）、DbError/DbResult
models.rs IPC 线协议模型 —— ts-rs 单一来源（gen:types 刷新绑定）
repositories.rs 行级 SQL（tasks/deadlines/sessions/interruptions/notifications/clipboard/settings/backup，8 仓储）
monitor.rs gpu.rs 硬件采样（CPU/内存/磁盘/网络/DXGI GPU）
media.rs audio.rs SMTC 媒体会话（事件线程 media:snapshot + 会话治理：锁定/黑名单/独占播放，media:sessions 会话列表事件化（签名去抖）+ get_media_sessions_page 初值口径 + 封面取色）、音频 loopback 采样（audio:spectrum + audio:status 管线健康态 + get_audio_status）
palette.rs wallpaper.rs brightness.rs Oklab 取色管线 / 壁纸跟随主题（wallpaper:changed）/ 亮度控制（WMI + DDC/CI）
presence.rs game.rs 在场感知（输入空闲 + 前台全屏 → presence:state，兼容 focus:game-paused-*）/ 前台窗口探针
system.rs files.rs system_integration.rs 系统/文件/深度集成
email.rs bluetooth.rs excel.rs IMAP/蓝牙/xlsx
audio_events.rs double_tap.rs global_input.rs super_panel.rs 硬件音量键→osd:volume（含默认设备 epoch）/ 双击修饰键呼出命令面板（默认关）/ 条件式全局左键监视（岛外点击收起）/ 长按右键取词超级面板
snip.rs win_context.rs sys_actions.rs sysnotify.rs os_notify.rs 截图套件（冻结帧框选+标注+钉图）/ Explorer 路径·浏览器 URL 探针 / 系统快捷动作（6 命令）/ 系统 Toast 监听（sysnotify:captured）/ WinRT Toast 直发（点击回调 os-notify:activated）
push_server.rs shortcut_watch.rs mem_trim.rs hashfile.rs 本地回环 HTTP 推送（127.0.0.1:47310，默认关）/ 快捷方式条目父目录监听 / 空闲修剪 WebView 工作集 / 文件流式哈希（MD5/SHA-1/SHA-256/SHA-512）
logging.rs net_history.rs taskbar_net.rs 按天双写运行日志 + 崩溃记录（recent/清空）/ 按天流量记录（用户可关，起停采样线程）/ 任务栏网速条（贴靠线程 + 页面心跳看门狗）
update_sig.rs settings_mirror.rs storage_util.rs 更新清单 Ed25519 验签（公钥离线内嵌）/ Rust 侧设置镜像单一入口（Condvar 变更即醒）/ 原子写工具
anticapture.rs crash_dump.rs process_watch.rs window_ops.rs file_history.rs 防屏幕捕获 / 崩溃 minidump 旁车 / 进程事件触发器 / 前台窗口直调 / 删除可撤销
backup.rs tray.rs shortcuts.rs windows.rs widget.rs clipboard.rs color.rs …（shortcuts 为可配置 22 动作：9 个默认绑定 + taskbar 两项 / screenshot（Ctrl+Alt+X）/ win-ops 六项 / 虚拟桌面移动两项 / 系统代理与高对比度——第 13–22 项出厂无默认键，可录制绑定）
`

## 9. 类型与契约

- Rust `models.rs` 经 ts-rs 导出到 `src/types/bindings/`（`npm run gen:types` = `cargo test export`），消灭手写 snake_case 映射漂移。
- zod schema（`domain/schemas.ts`）与 TS 类型同源派生；导入/加载的数据必须过校验。
- i18n 以中文原文为键，缺失映射回退原文；语言三档（简体中文 / English / 跟随系统，`i18n-lite.ts` `effectiveLang` 按 OS locale 解析）；`npm run lint:i18n`（`check-i18n.cjs` 调用串 + attrs + `--dead` 死键扫描，已挂 CI）守护字典一致性。

## 10. 测试

- Vitest + Testing Library（jsdom）：领域纯函数、store 水合合并语义、持久化镜像、面板冒烟等 194 个测试文件 · 1837 用例（2026-10-08 实测全绿）。Tauri API 以命令名分发 mock，真实适配器参与运行。注意：本机经目录联接访问仓库时须从真实盘符路径运行（junction 路径下 Vite 解析不到 `src/test/setup.ts`，见 docs/issues-2026-09-09）。
- cargo test：SQLite 迁移/仓储、xlsx 解析、任务栏状态引擎等（2026-10-08 实测：主 crate 476 通过 + 8 个 `#[ignore]` 真机诊断探针），兼作 ts-rs 绑定导出钩子。任务栏 TAP DLL 为独立 workspace 成员，`cargo test -p velatap` 另 19 通过；workspace 还含 taskbar_common（注入线协议共享）与 vela-symbolize（崩溃符号化）。
- 基线要求：`npm run check`、`npm run lint`（0 警告）、`npm test`、`cargo test` 全绿方可提交。
