# 问题记录 · 2026-09-19：全面审查加固（内存安全 / 安全面 / 性能鲁棒性）

> 三路并行深度审查（Rust 33 文件逐行、安全面、前端性能/泄漏）+ 逐项修复。
> 同日的跨窗口同步风暴修复另见 `issues-2026-09-19-settings-toggle-storm.md`。
> 门禁：cargo fmt / clippy(0) / test 277+velatap 22，vitest 917，tsc / eslint(0) / build 全绿。

## 一、Rust 内存安全 / 并发 / 稳定性

审查结论：P0（崩溃/死锁）零；unsafe 面（注入器钩子、管道 overlapped、COM sink、
剪贴板 HGLOBAL、图标句柄、PDH 查询）逐一核对成立。修复：

| #   | 问题                                                                                                                                                                                                    | 修复                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 显示器热插拔拓扑同步在**主线程**抢 `state.db` 写锁——备份/导入持锁期间全窗口冻结、WH_MOUSE_LL 低级钩子被系统摘除（`monitor.rs`）                                                                         | 槽位映射读取改走 WAL 读连接 `read_db`；持久化写入挪后台线程                                                                                                                 |
| R2  | 注入收尾 TOCTOU：`generation_alive` 检查与句柄入库之间无原子性，恰逢停用时钩子/标记事件/DLL 成无主孤儿挂在 explorer（`injector.rs` inject_once / wake_resident）                                        | 在 `with_engine` 锁内复核代际，不匹配则丢弃产物（guard Drop 按序清理）并关管道                                                                                              |
| R3  | `query_battery` 的「双键回退」是死代码——主键查询失败 `?` 直接返回，次键永不尝试（`bluetooth.rs`）                                                                                                       | 失败改 `continue`                                                                                                                                                           |
| R4  | 两个 Win32 结构体引用来自 1 字节对齐的 `Vec<u8>`（适配器表 / TCP 连接表）——对齐不足的引用是 UB（`system.rs`）                                                                                           | 新增 `#[repr(align(8))] AlignedByte`，缓冲分配与 `fetch` 返回类型对齐化                                                                                                     |
| R5  | `SourceStream` 无 Drop——panic 展开路径泄漏 `GetMixFormat` 堆块（`audio.rs`）                                                                                                                            | `close` 幂等化（置空指针）+ 实现 `Drop` 兜底                                                                                                                                |
| R6  | `get_traffic_summary` / `get_traffic_daily` 纯 SELECT 走写连接，与备份/导入无谓互锁（`net_history.rs`）                                                                                                 | 改 `read_db`（C-1 模式补齐）                                                                                                                                                |
| R7  | 注入失败终态不清 `enabled`——explorer 重启即自动重注入，违背「失败绝不自动重试」（`injector.rs`）                                                                                                        | 失败终态同时 `e.enabled = false`                                                                                                                                            |
| R8  | **cargo test harness 加载即死**（STATUS_ENTRYPOINT_NOT_FOUND）：lib 单测二进制不带 tauri 应用清单，而 muda 静态引用 Common-Controls v6 专有入口（TaskDialogIndirect 等）→ 绑定默认 v5 comctl32 入口缺失 | `build.rs` 对全部目标 `/DELAYLOAD:comctl32.dll`：测试不触菜单则不加载；应用二进制自带 v6 清单首次调用照常解析，行为不变。附带 2 条 clippy manual_saturating_arithmetic 清理 |

## 二、安全面（按可利用性）

前提模型：自定义命令不受 capability 门控，任意 webview 可 invoke；低信任窗 =
非 `settings` 且非 `widget-*`（quick-note / taskbar-net）。修复：

| #   | 等级 | 问题                                                                                                                                                          | 修复                                                                                                                                 |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | 高   | `import_data` 无闸门：低信任窗可写 `app:settings:v1` 篡改 `extra.updateEndpoint`（更新链同域校验基点）→ 配合「下载并安装」构成静默 RCE 链                     | 收口 `require_settings_window`（恢复入口的 read_text_file 闸门只挡读文件，这里挡导入本身）                                           |
| S2  | 中   | `mirror_local_storage` 无闸门：低信任窗可整体覆写 localStorage 镜像（恢复/补齐时注入受信窗口持久态）                                                          | 分级：受信窗全量；quick-note 仅允许 `focus-desk.notes.*`（其便签耐久化依赖本命令）；其余拒绝                                         |
| S3  | 中   | velatap.dll 完整性用 FNV-1a（非加密）——`%TEMP%` 下预置同指纹恶意 PE 即可被 LoadLibrary 进 explorer                                                            | `dll_hash64` = SHA-256 前 8 字节，解包复用 / 驻留版本比对 / 元数据全部换用（签名校验列为后续项）                                     |
| S4  | 中   | 系统信息类命令无闸门：低信任窗可持续枚举 TCP 连接表 / 网卡详情 / 磁盘 / 前台应用时间线 / 媒体会话 / 蓝牙设备（隐私外传面）                                    | `get_tcp_connections` / `get_network_details` / `get_disk_info` / `get_bluetooth_devices` / `get_foreground_app` 挂 `trusted_window` |
| S5  | 中   | `fetch_emails` 的 server 字段任意指定（受信 widget 窗仍可借 IMAP 连接错误做内网端口探测侧信道）                                                               | server host 复用 `reject_private_target` 结构化判定（数字 IP / IPv6 / localhost / 内网段）                                           |
| S6  | 低   | `pick_folder` / `pick_file` / `gallery_delete_file` / `save_sketch_image` / `read_sketch_image` / `delete_sketch_image` 无窗口闸门（对话框钓鱼 / 目录内写删） | 补 `trusted_window`（路径限定保留，纵深防御）                                                                                        |
| S7  | 低   | `reveal_in_explorer` 的 `/select,"{path}"` 单参数拼接——路径内嵌引号可拆出额外 explorer 参数                                                                   | 拆为 `.arg("/select").arg(path)` 两个独立 argv                                                                                       |
| S8  | 低   | `restart_explorer` 闸门为 trusted——任一 widget 窗可杀整个 shell（桌面消失数秒）                                                                               | 收紧 `settings_only_window`（按钮本就只在设置页）                                                                                    |
| S9  | 低   | 书签 `href` 无协议校验——`.url` 导入可携带 `javascript:`，中键/右键原生导航绕过 onClick 拦截（前端）                                                           | `safeHref` 仅放行 http(s)，`openBookmark` 同判                                                                                       |

未修（记录评估）：管道 L3（同用户会话内抢注 / 伪冒服务端，仅 DoS 与视觉消息，
无提权——加固需 SECURITY_ATTRIBUTES + 握手密钥，列为后续）；IMAP `use_tls=false`
明文模式保留（自建服务器场景）但 UI 已有显著警告语义可再加。

## 三、前端性能 / 稳定性

| #   | 问题                                                                                                              | 修复                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| F1  | 设置侧栏渲染期对每视图 `loadInstances`（全量 JSON.parse）——searchQ 每键重渲都重复解析全部布局；且计数不随增删刷新 | `useMemo` 缓存计数+实例表，以 `instances` 引用作失效键（计数即时刷新）                     |
| F2  | 灵动岛磁贴无单磁贴错误边界——任一迷你形态抛错整岛静默消失（外层 fallback=null 无重试入口）                         | 每格磁贴包 `WidgetErrorBoundary`，只灰化该磁贴                                             |
| F3  | ToastHost 退场定时器条目不回收——timers Map 缓慢单调增长                                                           | 两处 t2 回调首行 `timers.delete(id)`                                                       |
| F4  | WidgetCard 渲染期全量 instances filter——拖拽期 O(N²)/帧                                                           | 单遍扫描取序号的 `useMemo`（instances 引用失效键）                                         |
| F5  | TodayOverview 兜底天气请求不回写共享槽——与天气磁贴对同坐标重复请求                                                | 成功后 `writeCurrentWeatherSlot` 回写                                                      |
| F6  | 取色器 150ms 轮询在指针静止时照发 IPC（约 6.6 IPC/s）                                                             | 指针位置未变且已采样过即跳过                                                               |
| F7  | 「正在播放」卡与音乐沉浸页各自 3s 轮询媒体会话（2 IPC/3s/实例，沉浸页展开时翻倍，多实例再乘）                     | 新增 `lib/media-sessions.ts` 引用计数共享轮询器（隐藏跳拍 + 内容不变保引用），两消费方切换 |

## 审查确认无需修改的重点（避免复查重复劳动）

unsafe 面（`SetWindowsHookEx`/transmute HOOKPROC 同源 DLL 契约、管道 overlapped
超时先 cancel_and_drain、COM sink 引用计数配对、剪贴板所有权移交、图标句柄全早退
路径释放）；panic 路径（无 static mut、业务 unwrap 仅测试、Mutex 一律 into_inner
恢复）；主线程阻塞（重 IO 全部 spawn_blocking）；内存修剪（历史/缓存全部有上限）；
路径遍历（gallery canonicalize、sketch 白名单、更新包 SHA+目录限定、备份纯 JSON
无 zip-slip 面）；命令注入（外部进程全部 `Command::arg` 单参数）；凭据（DPAPI +
TLS 证书校验 + 双侧过滤 email 键）；前端 XSS（无 dangerouslySetInnerHTML，
mini-md 纯 React 元素 + safeHref，计算器 Function 前有标识符白名单）。
