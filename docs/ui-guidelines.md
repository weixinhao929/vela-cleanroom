# UI 规范（ui-guidelines）

> 本文件收录跨组件的 UI 交互规范。每条规范给出：规则正文、理由、落地参照。
> 新增交互面必须遵守既有条目；修订需在 PR/提交说明中说明动机。

---

## 1. 等待指示：一律覆盖层，不占布局、不引起跳动

**规则**：任何「加载 / 刷新 / 恢复中」等待指示都必须以**覆盖层（overlay）**呈现——
绝对定位悬浮在内容之上，不得挤占布局空间，不得让加载前后发生任何尺寸或位置跳动。

细则：

1. **不占布局**：等待指示不得插入文档流（不得用骨架行、行内「加载中…」文本、
   撑高的占位块去顶开内容）。加载前后，容器与兄弟元素的几何保持不变。
2. **已有内容 → 原地保留**：刷新已有数据时，旧内容原地不动（可加轻微降透明），
   指示器贴在动作源上（如刷新按钮旋转），绝不清空内容再加载。
3. **无内容（首拉取）→ 覆盖层**：用绝对定位 veil（轻背景 + spinner + 简短文案）
   盖在内容区上，容器高度由内容本身或固定尺寸决定，veil 不参与布局。
4. **可中断布局的全页操作（恢复备份等）→ 全页遮罩**：阻断误操作，spinner + 文案居中。
5. **可达性**：veil 用 `role="status"` + `aria-label`，加载文案走 i18n；
   `pointer-events: none` 保证遮罩下的可交互元素（如重试按钮）仍可命中。
6. **动效纪律**：veil 入场 ≤0.25s 淡入；spinner 0.8s linear（审计豁免档）；
   `data-reduce-motion` 下入场动画关停、spinner 静止为环。

**理由**：桌面常驻场景中，加载引起的布局跳动是「桌面在抖」观感的主要来源；
骨架行在列表场景还会与真实内容高度不一致造成二次跳动。

**落地参照**：

- 全页遮罩（参照实现）：`src/features/settings/DataPanel.tsx` 的
  `.data-restore-overlay`（settings.css）——备份恢复期间覆盖整个设置窗。
- 首拉取 veil：`src/widget/widgets/WeatherWidget.tsx` 与 `EmailWidget.tsx` 的
  `.widget-busy-veil`（widget.css 末段 [POLISH] 块）。
- 已有内容原地刷新：天气 / 邮件的刷新按钮旋转（`.spin`），内容不动。

---

## 2. Touch target：最小命中区 ≥48px

**规则**：所有可点击 / 可拖拽控件的**命中区**（hit area）不小于 48×48 逻辑像素
（桌面鼠标场景 44px 可接受）；视觉尺寸可以更小，命中区通过下面两种方式之一扩展：

1. **真实盒子**（首选）：交互元素本身做成 ≥48px（padding / min-height / 透明 wrap），
   视觉元素在盒内居中。适用于任何表面，尤其是**桌面层直接暴露的控件**——
   `useClickThrough` 只上报元素包围盒给 Rust 命中测试，伪元素外扩的区域不在其中，
   会形成「看得见点不中」的空洞。
2. **伪元素外扩**（受限）：`::before/::after` 负 inset 只允许用在**普通窗口**
   （设置窗）或**overlay 模式表面**（就地弹层 / 图库 / 面板打开期间整窗可交互，
   见 `useClickThrough.OVERLAY_SELECTOR`）里的控件。桌面层非 overlay 状态下禁用。

细则：

- 滑条的命中区 = 整条轨道容器（`M3Slider`：44px 高容器，原生 range 铺满）。
- 开关：48×48 透明 wrap 按钮承载点击 / 键盘 / aria，轨道视觉为子元素（`Toggle`）；
  就地弹层紧凑变体收到 40×30（overlay 模式）。
- 步进按钮 / 分段项：视觉不变，`::after` / `::before` 外扩到 48px（仅设置窗加载的
  settings.css 中定义，天然满足第 2 条的表面限制）。
- 图库卡片、设置行等大目标自然满足（图库卡片显式 `min-height: 48px`）。
- `data-interactive` 上报与命中区同源：桌面层非 overlay 状态下命中区不得大于上报包围盒。

**落地参照**：`M3Slider`（feature-polish.css `.tm-slider-track`）、`Toggle`
（feature-polish.css `.tm-toggle-wrap`）、`Stepper` / `Segmented`（settings.css
[POLISH] 伪元素外扩）、`WidgetGallery` 卡片（widget.css 图库区段）。

---

## 3. 按压反馈：几何形变优先于纯缩放

**规则**（A4，选配用于高曝光控件）：按压反馈优先用「几何形变」——
激活段外圆角 + 按压加宽、拇指按压涨径、邻块挤压吸收——而非千篇一律的
`scale(0.94)`。形变优先用 transform / 非布局属性实现，遵守 lint:anim 三闸；
在 backdrop-filter 表面的透明窗口子元素上（如桌面层图库面板）**禁用 transform**
（会触发合成层重建导致内容消失），改用 border-radius / 颜色 / 透明度表达形变。

**落地参照**：

- Segmented：双速拉伸胶囊（快层 50ms + 慢层 220ms 取并集）+ 位置感知外圆角
  - 按压气泡 scaleX(1.12)≈+10px（feature-animations.css）。
- Toggle：拇指按压涨径 scale(1.28)（18→23px，feature-animations.css / feature-fx.css）。
- WidgetGallery 卡片：按住卡外圆角 12→20px + 邻卡圆角 8px / 透明 .85（widget.css
  图库区段，JS 类名驱动，无 transform）。

---

## 4. 灵动岛动效规范（F-9 精简版，业界灵动岛基准）

**规则**：灵动岛（`src/styles/feature-dock.css`，`src/widget/dock/**`）的全部动效按
下表取时长与曲线；曲线只引用 A3 token（feature-animations.css），文件内不得出现裸
`cubic-bezier()`；颜色只引用主题 token。新增动效先对号入座，再落代码。

| 场景                                           | 时长 / 曲线                                                                                                                                                                                                                                                                           | 依据                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 展开 / 收回（磁贴 → 面板）                     | 500ms `--ease-spatial` / 360ms `--ease-in`；内容 200ms 交叉淡化                                                                                                                                                                                                                       | 基准 500 / 360；`WidgetExpandOverlay`                                                                 |
| hover 微涨（peak）                             | 宽 +16 / 高 +6 / 圆角 +3，360ms `--ease-fx`（`.dock.is-peak` padding 过渡）                                                                                                                                                                                                           | `HorizontalKeystoneLayout` collapsedHovered                                                           |
| 磁贴增 / 删 / 排序                             | FLIP 经 `pickSpatialEase`：位移 ≤20px 350ms `--ease-spatial-fast`，否则 500ms `--ease-spatial`；新磁贴 scale .8 + opacity 0 弹入 350ms fast；移除 160ms `--ease-in` 收缩                                                                                                              | `KeystoneSurface:655-663` 小增量降档；`lib/anim.ts`                                                   |
| 岛位置拖动 / 吸附 / 换边                       | 拖动只写 transform；松手吸附 360ms `--ease-spatial-fast`；换边 500ms `--ease-spatial`                                                                                                                                                                                                 | 与卡片 `dragPreview → commit` 同范式                                                                  |
| 接管（番茄钟 / 媒体 / 通知）                   | 磁贴层与接管层常驻叠放，200ms `--ease-fx` 交叉淡化；岛宽随内容 spring：`--ease-dock-spring`（dockQ 弹簧 450ms，`linear()` 采样峰值 1.1583，不支持时回退 `--ease-spatial`；`--dur-dock-spring` 随 --anim-dur 派生）、回落 360ms `--ease-in`（`@supports (interpolate-size)` 渐进增强） | dockQ 弹簧 s(t)=1−cos(2π·2.65·t)·e^(−10.8·t)；前代 `--ease-island-expand`（基准样条峰值 1.035）已退役 |
| 全岛面板轮播                                   | 拖动 1:1 跟手，松手 settle 300ms `--ease-spatial-fast`，越界 0.3× 阻尼                                                                                                                                                                                                                | `KeyholeCardCarousel:188-227`                                                                         |
| 状态 / 颜色 / 透明度                           | 150 / 200 / 300ms `--ease-fx`（hover 底色、图标色、进度环）                                                                                                                                                                                                                           | A3 fx 族分工                                                                                          |
| 弹层入退场（类型选择器 / 配置面板 / 拖入预览） | 入场 150–200ms `--ease-out`；退场 160ms `--ease-in`；按压 `--ease-spring`                                                                                                                                                                                                             | D1 三分法                                                                                             |
| 指针跟随指示（插入位竖条）                     | transform 150ms `--ease-out`（不过冲）                                                                                                                                                                                                                                                | 跟手指示不宜回弹                                                                                      |

细则：

- **`--ease-dock-spring`**：dockQ 弹簧 s(t)=1−cos(2π·2.65·t)·e^(−10.8·t) 的 CSS
  `linear()` 采样（17 停靠点，峰值 1.1583 ≈15.8% 过冲 @33%），仅用于岛宽高及几何
  morph；不支持 `linear()` 的引擎回退 `--ease-spatial`。前代 `--ease-island-expand`
  已退役删除。`check-transitions` ease-contract 校验它只定义在 feature-animations.css
  且被 feature-dock.css 消费；裸 cubic-bezier 另有 [bare-ease] 闸（非 token 定义地
  出现曲线字面量需「ease: ok <理由>」行内豁免）。
- **reduce-motion 三重兜底**：global.css `[data-reduce-motion]` / `@media (prefers-reduced-motion)`
  把全部 transition / animation 压到 0.001s；JS `prefersReducedMotion()` 让 FLIP、幽灵退场、
  轮播 settle 直接瞬移；feature-dock.css 文末对本文件几何动效再显式声明一次。音乐跑马用
  `animation: none`（压时长会停在终点裁掉前半段）。
- **颜色**：岛底 `--layer2` / 内容 `--layer2-on`（A1 层级求解，随不透明度与壁纸 token 联动）；
  面板内容 `--layer4-on`；on-accent 文字 `--btn-fg`；投影色 `--dock-shadow` = `--widget-hover-shadow`；
  焦点环 `--ring` = `--accent`（岛表面自定义，小组件窗口没有设置窗的 `--ring`）。
  豁免：`mask-image` 渐变的不透明停靠点 `#000`（只取 alpha）、跑马 `linear`。
- **命中区（§2 在桌面层的补充）**：磁贴 / 「+」/ 拖动柄 / 接管条视觉不变，`::after` 外扩到
  ≥48px（44px 桌面鼠标可接受）。岛本体 `.dock` 整块上报命中矩形，岛内 padding 带被外扩
  完整覆盖；超出岛包围盒的部分在 Tauri 非 overlay 态穿透到桌面——那里没有可见元素，
  属「指到空处」而非「看得见点不中」。要让 48px 在桌面层成为真实盒子，走 F-6 密度 48 档。
  嵌在磁贴内的次级控件（`.dock-mini-btn`）不外扩（会吞掉磁贴自身点击面，WCAG 2.5.8 行内豁免）。
- **门禁**：`lint:anim` 四项（will-change / check-transitions 含 ease-contract / fx-gate）；
  新增 hover / active 改 transform 必有 transition；只动 transform / opacity（例外：hover 微涨
  的 padding 与接管宽度 spring 的 width——离散事件、非常驻，已在文件内注明）。

**落地参照**：`src/styles/feature-dock.css` 文件头「动效规范」段与 `POLISH` 区段；
`src/widget/dock/DockShell.tsx`（吸附 / 换边 FLIP）、`DockTiles.tsx`（排序 FLIP）、
`DockPanel.tsx`（轮播 settle）。

---

## 5. 间距与视觉收口（2026-09-27 建立）

**规则**：

1. **间距阶梯**：新增 `padding / gap / margin` 消费 `--space-N` 阶梯
   （`--space-1..10` = `--spacing` × 0.25..2.5，4px 基，定义于 global.css :root，
   随设置页「间距」滑条整体缩放）。存量约千处裸 px 间距为已登记技术债，
   **随改随迁**（触碰同一规则块时顺手换算），禁止批量机械替换。
2. **模态遮罩**：浓度一律消费 `--scrim`（明暗两档同值 0.32），不得各写 rgba。
3. **浮层阴影**：新增阴影色消费 `var(--shadow-tint)`（明暗分档：浅色档暖棕、
   深色档纯黑）并用 `color-mix(... N%, transparent)` 调浓度；卡片族优先用
   既有 `--widget-rest/hover/drag-shadow`。禁止新增裸 `rgba(0,0,0,…)` 阴影色。
4. **禁用态下限**：禁用/弱化态 `opacity` 不得低于 0.4（0.25 档在暗色档贴底
   近乎消失；WCAG 豁免的是对比度要求，不是「不可见」）。
5. **色块前景**：彩色芯片上的文字/图标用按亮度选择的前景色（参照
   SettingsView `hueChipStyle` 写 `--h-ink`、theme-engine `--btn-fg`），
   禁止写死 `color: #fff`。

**理由**：2026-09-27 UI 审计（§1 白字白底三连、遮罩三处硬编码、散装黑阴影、
禁用态不可见）的系统性收口；token 化让同类问题可被 `lint:tokens`
（未定义 token 引用门禁，已入 CI）兜住。

**落地参照**：global.css `--space-*`/`--scrim`/`--shadow-tint` 定义；
`scripts/check-css-tokens.mjs`（`npm run lint:tokens`）。
