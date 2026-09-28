# 问题记录 · 2026-09-09：多显示器设置链路 + DDL 日期输入框不透明

> 状态：A / B 均已修复（同日）。修复要点见文末「修复记录」。

## A. 多显示器下无法设置小组件（设置窗口只绑定主屏分区）

现象：

- 外接显示器的小组件点「配置」会跳到独立设置窗口，且目标组件不在列表里。
- 设置侧栏「显示器」分组永远只显示「显示器 1（主显示器）」，接多块屏也不变。
- 设置窗口内添加视图/小组件永远落到主屏，外接屏的布局无法从设置窗口管理。

根因（三层叠加）：

1. **设置窗口的小组件存储固定绑定 screen 0。**
   `src/widget/widget-store.ts` 的 `getScreenId()` 从 URL hash 解析 `#screen=N`；
   设置窗口 URL 是 `index.html#/settings`，无 `#screen` → 永远返回 `"0"`。
   视图/布局/回收站等所有 key（`focus-desk.screen.0.*`、`widget:views:0`…）
   均按该分区派生，设置侧栏「视图/小组件」、各小组件配置页因此只读写主屏数据。
   跨窗口同步还会丢弃其他屏的载荷（`applyRemoteWidgets`：
   `p.screenId !== SCREEN_ID` 直接 return），设置窗口连"显示"外接屏状态都做不到。

2. **「跳到设置窗口且空白」的直接机制。**
   `src/widget/WidgetCard.tsx` 的 `openConfig()` 发送 `app:navigate-settings`
   载荷 `{ page: widget-config-<id> }` 并呼出独立设置窗口（tauri.conf.json 中
   `center: true`，落在主屏）。外接屏组件的实例 id 不在设置窗口的 screen-0
   store 里，`widget-configs.tsx` 中 `if (!inst) onNavigate("widgets")` 弹回
   screen 0 的「当前视图小组件」列表 → 用户看到的就是截图里的页面。

3. **侧栏「显示器」分组硬编码。**
   `src/features/settings/SettingsView.tsx` 的 `SIDEBAR` 常量写死唯一一项
   `{ id: "display1", name: "显示器 1（主显示器）" }`；路由只认 `display1`。
   DisplayPage 虽然会 `list_monitors` 列出真实显示器，但「在此显示器显示」
   按钮只调用 `set_monitor`（show+focus 那块屏的小组件窗口），不会把设置
   界面切到该屏的小组件分区。

修复方案：

- `widget-store`：设置窗口的分区改为可切换（store 增加 `settingsScreen`，
  切换时按目标屏的 key 重新 hydrate；桌面层窗口保持 URL hash 绑定不变）。
- 设置侧栏：「显示器」分组改为 `list_monitors` 动态生成 `display-<slot>` 页，
  选中某块屏即把设置窗口管理的分区切到该屏。
- `openConfig`：`app:navigate-settings` 载荷加入来源 `screenId`，设置窗口
  收到后先切分区再进 `widget-config-<id>`。

## B. DDL 提醒小组件的日期输入框完全不透明

现象：`DDL 提醒`组件的添加行里，日期输入框（占位符 `yyyy/mm`，右侧日历图标）
渲染成纯黑完全不透明，与周围半透明亚克力风格脱节。

根因：原生 `<input type="date">`（含 `-webkit-calendar-picker-indicator`）
在 WebView2 深色模式下使用默认表单控件背景，未跟随应用的半透明
color-mix 背景；其余自定义样式输入框正常。

要求：改为半透明，比常规背景略实一点即可（不要完全挡住壁纸）。

## C. 小组件内其余输入类控件「完全不透明」（第二轮 · 同日）

现象（用户截图）：DDL 的事项文本框、课表的「默认课表」下拉框、倒计时倒数日
的日期框等呈纯黑不透明色块。

排查（像素实测）：DDL 输入框取样 RGB(18,24,27)、课表下拉框 RGB(14,20,26)，
背后是能透出壁纸的卡片玻璃——控件底色完全不透光。重复周期按钮组、课表
星期表头经取样与 CSS 核对均为透明（旧安装包 8/14 的样式与当前代码不同，
截图观感差异来自旧版）。绿色「+ 添加 / 第 1 周 / 不重复」为主题强调色
（--btn-bg = accent），属设计语言，不改。

根因：这些控件的底色沿用 `--paper-solid`——即 widgetBackground 的
**85% 不透明版**（theme-engine 注入 `hexToRgba(base, 0.85)`）。浅色壁纸下
无感，深色壁纸+深色组件背景时视觉上就是纯色块。同类控件共约 25 处
（DDL 表单、课表下拉、倒计时日期、习惯打卡、今日概览、单位换算、
书签、文件、便签、图库、回收站过滤、时钟时区等全部 widget 卡片内
input/select/textarea）。

修复（global.css，紧随 B 的日期框修复）：深色主题（`data-theme="glass"`）
下，`.widget-card` 内全部 `input`（排除 checkbox/radio/range/color）、
`select`、`textarea`，以及 Portal 到 body 的课程编辑对话框 `.tt-field select`
（UA 默认黑底的裸 select），统一改为 `rgba(255,255,255,0.16)`——比卡片
玻璃（0.08–0.11）略实一档，即用户要求的「比正常的不透明度高一点」。
浅色主题保持原样（浅色卡片上的纸白控件观感正常）。

---

## 修复记录（2026-09-09）

### A. 多显示器设置链路

- `src/widget/widget-store.ts`：模块级 `SCREEN_ID` 常量改为可变的 `currentScreen`
  （桌面层窗口仍由 URL hash 一次性绑定，终身不变）；全部持久化 key 改为
  调用时按当前分区派生的函数；新增 store 字段 `screenId` 与动作
  `switchScreen(screen)`——先按旧 key 冲刷防抖落盘，再切换分区并按目标屏
  已存数据整体重建（视图/布局/回收站/模板），随后异步合并 SQLite 镜像。
  `applyRemoteWidgets` 的分区过滤同步改用 `currentScreenId()`。
- `src/lib/cross-window.ts`：sync:widgets 载荷的 screenId 改用
  `currentScreenId()`，设置窗口编辑哪个分区就同步哪个分区。
- `src/features/settings/SettingsView.tsx`：侧栏「显示器」分组改为
  `list_monitors` 动态生成（`display-<slot>` 页，随 monitors-changed 热插拔
  刷新）；点击某屏 = 切换管理分区 + 进入该屏页面；accent 圆点标出当前
  管理屏；`app:navigate-settings` 与 `focus-desk.pending-nav`（localStorage
  兜底）均支持 `{ page, screenId }`，切换分区后再导航。
- `src/features/settings/pages/DisplayPage.tsx`：顶部提示当前「视图/小组件」
  作用于哪块屏；每张显示器卡新增「管理此屏小组件 / 正在管理」。
- `src/app/App.tsx`：设置窗口挂载时恢复上次管理的屏幕分区
  （`focus-desk.settings.screen`）。
- `src/features/settings/settings-search.ts`、`src/i18n.ts`、
  `src/styles/settings.css`：搜索条目页 id、新词条、新样式（圆点/按钮组/
  提示行）。

### B. DDL 日期输入框不透明

- `src/styles/global.css`：`.widget-card` 内所有 `input[type="date"]` /
  `input[type="datetime-local"]` 的 UA 内部伪元素（`::-webkit-datetime-edit*`
  各段、`::-webkit-calendar-picker-indicator`）背景逐层恢复透明；
  glass 主题下控件本体给 `rgba(255,255,255,0.16)`（普通输入框 0.11 略实）。
  同时覆盖 DDL 添加行、行内编辑框与倒计时组件的日期框。

### 验证

- `tsc -b --noEmit` 通过；`eslint`（改动文件）无告警；`vite build` 通过。
- `vitest run` 全量 312 用例 / 28 文件通过。
  （注意：开发机上仓库经 junction 访问时，vitest 需从真实盘符路径运行，
  否则会因 realpath 解析失败找不到 `src/test/setup.ts`，属环境既有问题，
  与本修复无关。）
