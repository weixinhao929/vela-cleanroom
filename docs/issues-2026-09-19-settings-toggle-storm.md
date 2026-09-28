# 问题记录 · 2026-09-19：设置里快速切换后无限来回切换（跨窗口同步风暴）

## 现象

在设置窗口的切换条 / 切换胶囊（主题模式等分段控件）上**快速来回切换几次后，
界面开始自己无限地来回切换**：所有窗口（设置窗 / 各屏小组件窗 / 任务栏网速窗）
的主题以 ~10Hz 持续翻转，永不停止。实测 90 秒内产生 4641 次主题属性翻转，
伴随：

- 三个 WebView 全部被打满（DevTools 协议失去响应）；
- Rust 侧 Win32 消息队列被事件洪流打满（`PostMessage failed ... 0x80070718
配额不足`）——系统级资源耗尽，不只是视觉 bug。

复现配方（CDP 实证）：设置窗（默认管理分区 0）+ 一个挂在分区 0 的 widget 窗
（真实多屏 / 窗口启动时序错位时等价出现）+ 任务栏网速窗，在主题模式分段控件
上以 ~170ms 间隔连点 6 次。

## 根因（三层叠加）

1. **键序伪分歧（根因）**：`cross-window.ts` 的叶子级三方合并用
   `JSON.stringify` 原样比较值。同一份 `extra.weatherCities` /
   `notifications.sources` 在不同窗口持有**不同键序**（本地 sanitize 的
   字面量序 vs 载荷线序 vs 持久化序），于是每次交换都被判为「远端有变更」、
   每次采纳又被 `sanitizeSettings` 重排成另一种序——**永不收敛的乒乓**。
   CDP 抓包实证：三个窗口互发的载荷除 `ts` 外完全一致，却持续互相回播。
2. **回播放大器**：分歧回播（`diverged → emitSettings()`）是**立即重发**，
   且发射时把「保留的本地值」的编辑时间戳**重盖为现在**——陈旧值永远赢过
   对端真正更新的值，两端互不相让，10Hz 乒乓。
3. **隐性写者**：`hydrateSettingsFromDb` 的晚到写入（慢盘 / 4s 启动安全网
   放行渲染后才落地）被同步订阅当作本地编辑，把陈旧 DB 快照盖上新鲜时间戳
   广播出去，成为风暴的第一块多米诺。

## 修复（六层，src/lib/cross-window.ts 为主）

| #   | 修复                                                                                                                                                          | 位置                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | **规范化序列化**：`jsonOf` 递归按键字典序输出（数组保序）——叶子/行比对与键序无关，伪分歧从根上消失                                                            | `cross-window.ts`（`canonicalize`/`jsonOf`）                          |
| 2   | **回播指数退避**：分歧回播 0/50/100/…ms 至 2s 封顶，已调度则去重；静默 3s 复位。用户编辑的 80ms 防抖不受影响                                                  | `cross-window.ts`（`nextReplayDelayMs`/`replaySettings`/`replayApp`） |
| 3   | **回播不重盖时间戳**：`syncLeafBase`/`syncRowBase` 增 `isReplay`——回播只对齐基线、不把保留值刷成「现在」，陈旧值不再永远赢                                    | `cross-window.ts`                                                     |
| 4   | **水合静默**：新增 `lib/sync-gate.ts`（`withRemoteApply` 门闩），`hydrateSettingsFromDb` 的最终 setState + applySettings 在门内执行，订阅不再把水合当本地编辑 | `sync-gate.ts`、`settings-store.ts`、`cross-window.ts` 订阅处         |
| 5   | **去重短路基准刷新**：采纳远端后同步 `lastSettingsJson`/`lastAppJson`（此前采纳不更新，后续等值编辑会被漏播）                                                 | `cross-window.ts`                                                     |
| 6   | **墨过渡兜底**：`onCovered` 1.8s 未触发则取消 defer 立即上色，防 defer 标志泄漏吞掉后续主题应用                                                               | `StylePage.tsx`                                                       |

顺带修复（切换家族健壮性）：**幽灵视图守卫**——对端「新建视图并立即切换」时
`sync:view-switch` 即时事件可能先于携带新视图列表的 80ms 快照到达，接收端直接
切会落进空布局闪空窗；现在未知视图暂存 `pendingRemoteView`，views 列表随
`sync:widgets` 跟进后补切。

## 验证

- 单测：`cross-window.test.tsx` 新增 5 条回归（退避有界、回播不重盖、sync-gate
  静默、门闩异常复位、幽灵视图守卫），全量 97 文件 / 917 用例绿。
- 真实应用（tauri dev + CDP 复现配方）：修复前 6 次点击 → 三窗 47~63 次翻转 /
  5s 且 90s+ 不止；修复后 6 次点击 → 恰好 6 个广播包（全来自设置窗）、接收窗
  零回播、静置 8s 零自持事件、末态与点击一致。

## 遗留观察

- widgets / dock / habits 通道走 per-sender rev + 整包采纳，无「分歧回播」语义，
  不受本次风暴机制影响；若未来引入行级合并，需复用 `jsonOf` 规范化。
- `cargo clippy` 顺带清了 2 条 manual_saturating_arithmetic（net_history.rs 测试）。
