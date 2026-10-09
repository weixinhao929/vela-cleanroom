# Focus Desk E2E（WebDriver + WebView2）

对核心链路（应用启动渲染、设置窗口可达、跨窗口主题同步）与新功能冒烟
做自动化回归。使用
[WebdriverIO](https://webdriver.io/) + [tauri-driver](https://tauri.app/develop/tests/webdriver/)
把 Tauri 的 WebView2 暴露为标准 WebDriver 会话。

> 穿透命中（click-through）是原生层（`src-tauri/src/widget.rs` 的低层鼠标钩子
> 与命中矩形）行为，WebDriver 无法代理 OS 级命中测试，故不在本套件覆盖。
> Rust 侧现状（纠正）：`widget.rs` 内联单测覆盖**命中矩形纯函数语义**
> （`replace_regions` 整表替换/按窗口键隔离/空数组清空 + `cursor_in_regions`
> 闭区间边界 + `widget_under_point` 置顶竞争）；钩子线程安装/卸载、WH_MOUSE_LL
> 回调与跨进程 FFI（ReadProcessMemory 桌面图标探测）仍是**无自动化覆盖**的
> 手工验证面——不要假设它们有单测守护。

## 前置条件（一次性）

1. **安装 tauri-driver**
   `sh
   cargo install tauri-driver --registry crates-io
   # 若 cargo 未配置 crates.io（示例中为 rsproxy），加上 --registry crates-io
   `
2. **安装 WebView2 驱动（msedgedriver）**：版本必须与本机 WebView2 Runtime **同主版本**，
   不匹配的症状是会话在连接阶段**挂起**而不是报错。核对 Runtime 版本（它不是 Appx 包，
   `Get-AppxPackage` 查不到）：
   `powershell
   (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv
   `
   到 [Edge WebDriver 下载页](https://developer.microsoft.com/microsoft-edge/tools/webdriver/)
   取同主版本的 `msedgedriver.exe`，放到 PATH；或不改 PATH、启动时显式指定：
   `tauri-driver --native-driver <msedgedriver.exe 路径>`。
3. **构建应用**（tauri-driver 需要可执行二进制）：
   `sh
   cd .. && npm run tauri:build # 产出 src-tauri/target/release/Vela.exe
   # 调试期：npm run tauri:build -- --debug（更快；产出 target/debug/）
   `
   `wdio.conf.ts` 按 release → debug 顺序自动定位 `Vela.exe` / `focus-desk.exe`；也可用
   环境变量 `VELA_E2E_APP=<exe 路径>` 指定（相对 `e2e/` 解析）。
4. **退出本机常驻的 Vela**。应用启用 single-instance：若已有实例在跑，tauri-driver 拉起的
   新实例会把参数转发给老实例后立刻退出，会话连不上或连到错误实例。配置会在启动前检查
   并快速失败；设 `VELA_E2E_KILL=1` 才允许自动结束常驻实例（会丢未落盘的防抖状态）。

## 运行

`sh
npm install # e2e/ 目录：安装 webdriverio 等
npx tauri-driver # 终端 1：启动 WebDriver 服务（默认 4444）
npm run test # 终端 2：运行 E2E（等价于仓库根 `npm run test:e2e`）
`

### 本机实跑备忘（2026-10-07 已备齐）

- 本机 WebView2 Runtime = **154.0.4258.62**；`~/.cargo/bin/msedgedriver.exe` 是过期的
  151（主版本不匹配 → 会话挂起）。匹配版已备在
  `%LOCALAPPDATA%\Vela-e2e\msedgedriver-154\msedgedriver.exe`，
  启动 tauri-driver 前把该目录**前置**到 PATH 即可（tauri-driver 按PATH找驱动）：

  `powershell
  # 终端 1（pwsh）：PATH 前置 154 驱动后启动服务
  $env:Path = "$env:LOCALAPPDATA\Vela-e2e\msedgedriver-154;" + $env:Path
  npx tauri-driver
  `

  `sh
  # git-bash 等价
  PATH="$LOCALAPPDATA/Vela-e2e/msedgedriver-154:$PATH" npx tauri-driver
  `

- 跑之前先退出常驻 Vela（见上第 4 条；配置的常驻实例守卫会快速失败提醒）。

## 覆盖场景

| 用例 | 说明 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用启动渲染主 widget 层 | 验证没有启动崩溃、`.widget-canvas` 节点存在 |
| 设置窗口可达 | 验证 settings 窗口可作为独立 WebDriver 目标切换 |
| 跨窗口同步 | 设置窗口先切「深色」再切「浅色」→ 主窗口 `data-theme` 依次为 `glass` / `light`；结束后恢复原值。双向切换 + 精确值，不依赖上次运行留下的持久化主题 |

**新增功能冒烟**（存在性容错，见下方「注意」）：

| 用例 | 说明 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 回收站小组件空态 | 画布上有回收站实例时，`.recycle-empty` 可见 |
| 今日概览可挂载 | `.today-overview` 存在时，日期标题区块可见 |
| 课表导出入口 | `.tt-mini-btn[title*="xlsx"]` 存在时，title 含 `xlsx`（裸 `.tt-mini-btn` 取到的是「重命名方案」按钮） |
| 更新页下载安装入口 | 检测到新版本时，`.tm-update-dl` 文案含「下载并安装」 |

## 窗口定位

widget 窗口每显示器一个，label 为 `widget-{slot}`，title 统一为 `"Vela Widgets"`
（`src-tauri/src/monitor.rs` `create_widget_window`）。`browser.switchWindow()` 按
title/URL 匹配，故用例与 `wdio.conf.ts` 的 `beforeTest` 均以 `"Vela Widgets"` 切换；
多显示器环境下命中第一个匹配窗口。设置窗 URL 为 `index.html#/settings`，用
`switchToWindow(/settings/)` 定位（widget 窗 URL 为 `#screen=N`，不会误配）。

## 注意

- 用例依赖真实 Tauri 运行时（`isTauri()` 守卫），浏览器模式无法运行。
- 改动了设置页 DOM 选择器后，需同步更新 `specs/core-flows.e2e.ts` 里的选择器。
- **已接入 CI**（2026-10-07）：ci.yml 的 e2e job 走 nightly 定时
  （UTC 20:00）+ workflow_dispatch 手动触发，job 内自动完成驱动链前置
  （cargo install tauri-driver → 按注册表读 WebView2 Runtime 版本下载同版本
  msedgedriver → 4444 后台服务），结果 continue-on-error（实验性，待驱动链
  稳定后转硬门禁）。push/PR 不触发（前置构建太重）。本地手跑入口不变：
  仓库根 `npm run test:e2e`。
- 测试实例与本机安装版共用 identifier（`com.cleanroom.focusdesk`）→ 共用 `%APPDATA%`、
  localStorage 与 SQLite。主题用例会切换并恢复主题，其余用例不写状态；仍建议不要在
  有重要本地数据的机器上跑。
- **已知局限**：第二组 4 例用 `if (await el.isExisting())` 做存在性容错——画布上
  没有对应小组件实例时用例直接通过（空断言）。要让它们真正守护回归，需要在
  启动前预置含这些小组件的布局夹具（fixture），目前尚未落地。
- 2026-09-14 修正了窗口 title（原 `"main"`，实际无此窗口）与画布选择器
  （原 `#widget-canvas`，实际为 className）。
- 2026-09-18 修正：`tauri:options` 由 v1 时代的 `applicationId` 改为 tauri-driver 2.x
  识别的 `application`（可执行文件路径）——旧键会被静默忽略，拉起的是 Edge 浏览器本体；
  主题用例改双向切换 + 精确值（旧写法第二次运行必然失败）；删除 v9 已不读取的
  `autoCompileOpts` 与打包会话无意义的 `baseUrl`；增加常驻实例守卫。本机无 tauri-driver
  与匹配的 msedgedriver，改动为静态核对，待人工实跑验证。
- 2026-09-27 复核（静态核对，未实跑）：套件仍仅 `specs/core-flows.e2e.ts` 一个 spec
  （`wdio.conf.ts` 以 `./specs/**/*.e2e.ts` 匹配）；`VELA_E2E_APP`（相对 `e2e/` 解析）、
  `VELA_E2E_KILL=1` 常驻实例守卫、release → debug 二进制定位、窗口 title/URL 定位、
  覆盖场景断言（含冒烟组 4 例的存在性容错写法）均与 `wdio.conf.ts` /
  `core-flows.e2e.ts` 当前实现一致；`.github/workflows/ci.yml` 的 e2e job
  （nightly + dispatch，批接入）尚未在真实 runner 上跑通首轮——驱动链
  步骤按本文档前置条件编写，待首次 nightly 验证。
