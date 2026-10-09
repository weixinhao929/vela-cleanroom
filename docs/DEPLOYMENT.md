# 部署文档

Vela（Focus Desk）是 **Windows 桌面应用**（Tauri 2 打包），无服务器/网站形态，因此不存在 Nginx/Apache、域名、CDN 等服务端部署项；本文件描述从源码到可分发安装包的完整部署流程、运行环境、数据库结构与运行期配置。

## 1. 代码仓库

- 当前代码位于本机 Git 仓库（分支 `master`）。开发机若通过目录联接（junction）访问仓库，`vitest` 必须从真实盘符路径运行（见 README「本机路径注意」）。
- 尚未配置远程仓库（`git remote` 为空）。团队协作前请推送到私有远端（GitHub Private / 自建 Gitea 均可），并在 CI 中以 tag 触发打包。
- 提交基线要求：`npm run check`、`npm run lint`、`npm test`（2026-10-08：194 文件 / 1837 用例）、`npm run lint:anim`、`npm run lint:layout-anim`、`npm run lint:tokens`、`npm run lint:sizes`、`npm run lint:i18n`、`npm run lint:api`、`npm run lint:layering`、`npm run lint:window-gates`、`npm run format:check`、`cargo test`（476 通过 + 8 ignore）+ `cargo test -p velatap`（19 条）全绿。

## 2. 构建环境（开发/打包机一次性准备）

| 组件 | 要求 | 说明 |
| ------------------------- | ------------------------------- | ---------------------------------------------- |
| 操作系统 | Windows 10 1809+ / 11 x64 | 目标与构建平台一致 |
| Rust | stable（MSVC toolchain） | `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | 「使用 C++ 的桌面开发」工作负载 | MSVC 链接器与 Windows SDK |
| Node.js | ≥ 18（建议 20 LTS） | 前端构建 |
| WebView2 Runtime | Evergreen 最新版 | Win11 内置；Win10 需确认已装 |

`bash
# 检出后一次性安装依赖
npm ci
`

Rust crate 与前端 npm 依赖均随仓库锁文件（`Cargo.lock` / `package-lock.json`）固定。

## 3. 构建与分发

`bash
npm run tauri:build
`

产物位于 `src-tauri/target/release/bundle/`：

| 文件 | 用途 |
| ------------------------------- | ------------------------------------------------------------------------- |
| `nsis/Vela_0.1.0_x64-setup.exe` | 推荐分发的安装器（约 7.4 MB，2026-09-27 实测 7,756,059 字节） |
| `msi/Vela_0.1.0_x64_en-US.msi` | 企业/组网场景的 MSI 安装包（约 10.0 MB，2026-09-27 实测 10,448,896 字节） |

- 版本号统一维护在 `package.json` 与 `src-tauri/tauri.conf.json`（当前 0.1.0），发布前同步修改。
- 应用标识 `com.cleanroom.focusdesk` 决定数据目录与卸载识别，发布后不可更改。
- `bundle.targets = "all"`：NSIS + MSI 双格式都出；`bundle.windows` 未做定制，语言等均取 Tauri 默认（MSI 文件名里的 `en-US` 即默认 locale，NSIS 界面默认英文）。
- **velatap.dll（任务栏自定义注入 DLL）**：独立 workspace 成员 `src-tauri/crates/taskbar_tap`（cdylib，包名 `velatap`）。**随 `npm run tauri:build` 自动构建并打入安装包**：`tauri.conf.json` 的 `build.beforeBuildCommand` 追加了 `cd src-tauri && cargo build --release -p velatap`，`bundle.resources` 把 `target/release/velatap.dll` 声明为资源（安装后位于主程序 exe 同目录），运行期 `locate_dll` 的 resource 分支从该处定位。注意根目录含 `[package]`，裸 `cargo build` 只构建根包——开发期 `tauri dev` 若要联调任务栏，需手动 `cargo build -p velatap`（产物到 `target/debug/`）。`cargo test` 同理不含该 crate，须 `cargo test -p velatap`。

### 自动更新

更新走**自研链**（`tauri-plugin-updater` 依赖已卸载），检查与下载安装分居两端：

- **检查在前端**（`src/lib/update-flow.ts` 的 `resolveUpdateManifest`，设置 → 更新页与后台调度器共用）：用户配置的更新源（`extra.updateEndpoint`）返回 `{ version, notes?, url? }` JSON，前端做严格校验（版本形态、URL 禁带凭据）；源为 GitHub 仓库地址（`owner/repo`）时，Insider 通道走 Releases API 取通道内最新，失败回退 `releases/latest` 302 探测（Rust 命令 `resolve_latest_tag`）。
- **下载与静默安装在 Rust**（`src-tauri/src/system_integration.rs` 的 `download_update` / `install_update`）：下载地址必须与更新源同域（或为其子域；GitHub 源放行官方资产域）+ 每跳重定向重新执行「内网拒绝 + 同域校验」+ 边下边流式算 SHA-256 并与安装包旁 `<url>.sha256` 比对，安装前再按本地 sidecar 二次复核，最后 `/S` 静默执行 NSIS 安装器并重启，全程不依赖代码签名。
- `check_updates` 命令本身仅占位（返回当前版本供页面展示），真实检查由前端链路驱动。
- 更新页另含**双通道** stable / insider（通道跟随构建类型：版本含 `-insider` 即 Insider，用户可手动覆盖）、**GitHub Releases 回滚列表**（最近 20 条，回滚 = 同一套下载校验与静默安装）与**本机版本历史**（`src/lib/version-history.ts`，版本 + 通道 + 首次/最近运行时间，上限 30 条）。

发布步骤、哈希清单生成与校验、签名缺口与通道发布须知见 [releasing.md](releasing.md)。

## 4. 运行环境与数据目录

目标机器仅需安装安装包（自动确保 WebView2 Runtime）。用户数据全部落在（Rust 侧统一经 `vela_data_dir()` 解析；**debug 构建自动追加 `-dev` 后缀**——2026-09-24 起 dev 版读写 `%APPDATA%\com.cleanroom.focusdesk-dev\`，建库/备份/日志均不污染正式数据）：

`text
%APPDATA%\com.cleanroom.focusdesk\
├─ focus-desk.db SQLite 主库（唯一权威数据）
├─ crash-log.json 前端/桌面层崩溃汇聚计数文件
├─ backups\ 每日滚动备份 JSON（保留最近 N 份）
├─ gallery\ 图库导入的图片与缩略图副本（thumbs\ 子目录）
├─ clip\ 剪贴板图片 <id>.png（库内只存文件名）
├─ snip\ 截图
├─ sketches\ 涂鸦画布像素文件（原 localStorage dataURL 落盘化）
├─ icon-cache\ 快捷方式图标缓存（上限 1024 个，超限按最旧逐出）
├─ crashlog\ 原生 SEH 异常 minidump（vela-<时间戳>.dmp，crash_dump.rs 旁车进程写入；启动检测上次异常退出并附日志路径提示）
├─ operations\ 文件删除可撤销的私有备份（撤销栈上限 100）
└─ logs\ 运行日志
`

浏览器存储（WebView2 的 localStorage）承载便签/习惯/书签等「轻数据」，每次变更防抖镜像进 SQLite（`lsmirror:` 键），因此也进入备份；清理浏览器数据不会丢这些内容。

任务栏自定义开启时还会使用用户临时目录（`taskbar/injector.rs` 解包逻辑）：

`text
%TEMP%\vela\tap\
├─ <指纹16>\velatap.dll # 按 DLL 内容指纹命名的目录（SHA-256 前 8 字节的 16 位十六进制，M2 安全修订——此前的 非加密哈希可被预置碰撞）
└─ metadata.json # 上次成功注入记录（DLL 指纹 + explorer PID）
`

- **解包与复用**：每次启用注入前把安装目录的 `velatap.dll` 解包到 `%TEMP%\vela\tap\<指纹16>\`；同指纹复用已解包副本（复用前重算内容指纹校验，`%TEMP%` 用户可写、防文件被替换），DLL 内容变化（版本升级）则落**新**目录——绕开旧 explorer 进程仍占用旧文件的写锁，旧目录残留无害、可手动清理。
- **升级残留检测**：`metadata.json` 记录上次成功注入的哈希；版本升级后若 explorer 仍挂着旧 `velatap.dll`，应用不强杀 explorer，仅在设置页「任务栏」状态条提示重启资源管理器。
- **正常退出**：应用退出/关闭任务栏自定义时经管道下发 `RestoreAll` 恢复任务栏默认外观并卸钩；强杀进程则依赖 DLL 侧按协议「断连→恢复默认」。

## 5. 数据库结构

SQLite，版本化迁移（启动时按需执行，`db.rs` 中定义，当前 v1–v11（v11 = `idx_interruptions_started_at` 打断表索引）；v10 为 `clipboard_history` 增 `files` 附件列）：

`sql
tasks( -- 待办
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, -- 0/1
  created_at TEXT NOT NULL, -- ISO 时间
  due_at TEXT NOT NULL DEFAULT '', -- ISO，空 = 无截止 (v4)
  priority INTEGER NOT NULL DEFAULT 0, -- 0无/1低/2中/3高 (v4)
  tags TEXT NOT NULL DEFAULT '[]', -- JSON 数组字符串 (v4)
  sort_order INTEGER NOT NULL DEFAULT 0 -- 手动排序权重 (v4)
);

deadlines( -- 截止提醒
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0, -- (v3)
  notified_tiers TEXT NOT NULL DEFAULT '[]', -- 已发档位 ["24h","1h","10m"] (v4)
  repeat TEXT NOT NULL DEFAULT 'none' -- none/daily/weekly/monthly/yearly (v4)
);

pomodoro_sessions( -- 番茄钟会话
  id TEXT PRIMARY KEY,
  session_type TEXT NOT NULL, -- focus | break
  mode TEXT NOT NULL, -- focus/shortBreak/longBreak
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
  planned_seconds INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  task_id TEXT, -- 关联待办 (v5)
  event_label TEXT -- 自定义事件名 (v5)
);

pomodoro_interruptions( -- 打断记录 (v2)
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
  reason TEXT NOT NULL, mode TEXT NOT NULL,
  elapsed_seconds INTEGER NOT NULL
);

settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); -- KV：设置快照/widget 布局镜像/lsmirror 等
tags(id TEXT PRIMARY KEY, name TEXT NOT NULL);

notification_history( -- 通知中心历史 (v7)；30 天行级过期 + 上限，写入路径顺手清理，不进备份
  id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info', read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

clipboard_history( -- 剪贴板历史 (v8)；文本入库、图片落 %APPDATA%/clip/<id>.png 只存文件名；
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'text', hash TEXT NOT NULL, -- 500 行上限 + 30 天过期，
  preview TEXT NOT NULL DEFAULT '', text TEXT, image_file TEXT, -- 置顶行不清理，不进备份
  image_w INTEGER, image_h INTEGER, image_bytes INTEGER NOT NULL DEFAULT 0,
  source_app TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

CREATE INDEX idx_deadlines_due_at ON deadlines(due_at);
CREATE INDEX idx_sessions_started_at ON pomodoro_sessions(started_at);
CREATE INDEX idx_interruptions_ended_at ON pomodoro_interruptions(ended_at);
CREATE INDEX idx_notification_history_created_at ON notification_history(created_at); -- (v7)
CREATE INDEX idx_notification_history_source ON notification_history(source); -- (v7)
CREATE INDEX idx_clipboard_history_created_at ON clipboard_history(created_at); -- (v8)
CREATE INDEX idx_interruptions_started_at ON pomodoro_interruptions(started_at); -- (v11)

net_traffic_daily( -- 按天网络流量 (v9)；TrafficRecorder 常驻线程 10s 采样 / 60s 增量 UPSERT，
  day TEXT PRIMARY KEY, -- 本地日期 YYYY-MM-DD；保留 366 天 + 清理未来日期脏数据
  rx_bytes INTEGER NOT NULL DEFAULT 0,
  tx_bytes INTEGER NOT NULL DEFAULT 0
);
`

迁移策略：`MIGRATIONS` 数组按版本顺序应用，`schema_migrations` 计数保证幂等；字段演进一律 `ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT`，不做破坏性改写。

## 6. 计划任务 / 后台任务

无需操作系统级 cron/计划任务，以下后台节拍由应用内置（Rust 侧驱动，不受 WebView 后台节流影响）：

| 任务 | 触发 | 说明 |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 番茄钟心跳 | 运行期常驻 | Rust 心跳唤醒前端走秒；系统睡眠唤醒后按墙钟补齐；番茄钟不跑时 Condvar 真挂起（`set_heartbeat_enabled`） |
| 每日滚动备份 | 每日首次满足条件时 | 写 `backups/` JSON 快照并清理过期份数 |
| 系统采样广播 | 有订阅窗口时 | 按订阅者最小间隔采样 CPU/GPU/内存/磁盘/网络 |
| 媒体事件线程 | 运行期常驻（Windows） | SMTC 会话/播放态/封面变化推送 `media:snapshot` / `media:sessions`（会话治理：每拍一次枚举共享，黑名单/独占播放从设置镜像预载） |
| 流量记录器 | 用户开启时（设置 → 连接「流量统计记录」，默认关） | 10s 采样 / 60s 增量 UPSERT `net_traffic_daily`；未开启时无常驻采样线程、无周期落库（告警依赖采样线程，一并隐藏） |
| 节假日数据刷新 | 启动 + 7 天缓存过期 | 拉取 holiday-cn 当年/次年 JSON，失败静默回退内置表 |
| 开机自启 | 用户设置开启时 | 写入注册表 Run 键（设置页可开关） |

## 7. 网络、HTTPS 与 CDN

桌面直连形态下不涉及自建反向代理/CDN。应用仅出站访问以下 HTTPS 端点（已固化进 CSP `connect-src` 白名单，新增域名需同步修改 `tauri.conf.json`）：

- Open-Meteo（天气/空气质量/地理编码/历史归档：`api.` / `geocoding-api.` / `air-quality-api.` / `archive-api.open-meteo.com`）
- `lrclib.net`（音乐小组件歌词）
- `open.er-api.com` / `api.frankfurter.app`（单位换算的汇率源，主备）
- `ipwho.is`（天气「自动定位（IP）」主源，隐私 opt-in，24h 缓存）/ `api.ip.sb`（IP 定位备源，主源失败时兜底）
- GitHub（`raw.githubusercontent.com` 拉 holiday-cn 节假日；`api.github.com` Releases API 与 `github.com` 做更新检查/回滚列表——均经 Rust 命令 `fetch_url_text` / `resolve_latest_tag` 出站以绕过 webview CORS，故不在 CSP 白名单内）
- 连通性探测与测速（gstatic / msftconnecttest / miui / Cloudflare / jsDelivr / CacheFly）
- IMAP 邮件（用户自配账户，TLS 直连 993；Rust 侧）

所有请求强制 HTTPS；离线或被防火墙拦截时各组件降级为缓存/内置表，不阻塞使用。

唯一的**入站监听**是可选的本机推送服务 push_server（`src-tauri/src/push_server.rs`，默认关）：通知中心小组件的配置页开启后仅绑定回环 `127.0.0.1`（端口 `notifications.pushPort`，默认 47310），供本机其他程序 `POST /api/notify`（推送通知）与 `POST /api/dispatch`（白名单动作）调用；不对外网开放，无需配置防火墙入站规则。

## 8. 注意事项

1. **杀软误报**：两层风险——① 未签名安装包可能被 SmartScreen 拦截；② 任务栏自定义需要把 `velatap.dll` 经 `SetWindowsHookEx` 注入资源管理器（explorer）进程修改 XAML 任务栏外观，「向系统进程注入 DLL + 常驻命名管道」的行为模式与部分恶意软件同形，即使本体无害也可能触发杀软/EDR 告警、静默拦截或隔离解包出的 DLL（表现为注入 Failed）。误报处置：把 Vela 安装目录与 `%TEMP%\vela\tap\` 加入白名单后重新应用；关闭「自定义任务栏外观」即停止注入并恢复默认。正式分发建议购买代码签名证书，对主程序与 `velatap.dll` **均**签名（未签名的注入 DLL 几乎必然被拦截），并考虑向主流杀软厂商提交白名单申诉。
2. **多显示器**：每个物理屏一个 `widget-<i>` 窗口，布局按屏幕独立持久化；拔插显示器由应用自动重建窗口，无需人工干预。
3. **点击穿透**：依赖低层鼠标钩子做命中测试；某些远程桌面/录屏软件全屏注入时穿透行为可能异常，退出即可恢复。
4. **全局快捷键冲突**：默认组合（22 个可配置动作，其中 11 个出厂带默认键，含 `Ctrl+Alt+Shift+` 重置任务栏动态状态；win-ops 六项 / 虚拟桌面移动 / 系统代理 / 高对比度出厂无默认键，可录制绑定）若被他处占用，注册失败会 toast 提示且不影响其余功能。
5. **数据备份**：升级/迁移机器只需拷贝 `%APPDATA%\com.cleanroom.focusdesk\` 整目录；应用内「设置 → 数据」亦可导出完整 JSON 备份。
6. **卸载残留**：NSIS/MSI 卸载默认保留用户数据目录，便于重装恢复；彻底清除请手动删除该目录。
