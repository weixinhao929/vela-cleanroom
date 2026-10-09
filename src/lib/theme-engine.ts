import type { ThemePreset, ThemeMode, CustomThemeColors, CustomThemePair } from "../store/settings-store";
import { hexToRgba, withAlpha, luminance, deriveAccent2, mixHex, mixRgb, type Rgb } from "./color";
import { toCubicBezierCss, type BezierPoints } from "./bezier";
import { invoke, isTauri } from "./tauri";

/**
 * 主题引擎：预设 token 表 + 「把外观设置渲染为 <html> CSS 变量」的唯一实现。
 * 自 settings-store 原样迁出；与 store 的耦合仅剩两个 type-only 导入（运行时擦除），
 * 以及由调用方显式传入的动效环境参数（extra / reduceEffects），不再反向读取全局 store。
 */

/* ══════════════════════════════════════════════════════════════════
   色彩层级求解（alpha 混合的逆运算，数学本身属公有领域）
   ──────────────────────────────────────────────────────────────────
   目标：半透明表面在任意不透明度下保持层阶对比。给定底色 base、期望
   视觉色 target、叠加不透明度 α，反解实际涂色，使「α 混合成 base」之后
   的视觉结果尽量等于 target。α 越低反解出的通道越极端（钳到 [0,1]），
   即「涂层物理上还能做的最大对比」——层阶方向在任何 α 下都不会反转。

   L0–L4 海拔梯度结构：
     L0 卡片底（玻璃色本体） → L1 卡内抬升面 → L2 弹层/下拉
     → L3 右键菜单 → L4 模态/最高层；每层对「下一层的设计底色」求解，
   并派生 On / Hover（8% 混 On）/ Active（15% 混 On）变体。
   ══════════════════════════════════════════════════════════════════ */

export type { Rgb };

/** 解析 #rgb / #rrggbb / rgb() / rgba() 为 {rgb, a}；无法解析返回 null。 */
function parseCssColor(input: string): { rgb: Rgb; a: number } | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  let m = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(s);
  if (m) {
    return {
      rgb: {
        r: parseInt(m[1] + m[1], 16),
        g: parseInt(m[2] + m[2], 16),
        b: parseInt(m[3] + m[3], 16)
      },
      a: 1
    };
  }
  m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(s);
  if (m) {
    return { rgb: { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }, a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/i.exec(s);
  if (m) {
    const pct = (v: string) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v));
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: { r: pct(m[1]), g: pct(m[2]), b: pct(m[3]) }, a: Math.min(1, Math.max(0, a)) };
  }
  return null;
}

/* 线性混色已并入 lib/color 的共享 mixRgb（t 为向 b 的比例）；本文件原实现
   的 t 方向相反（t·a + (1−t)·b），下列调用点统一以交换实参适配，数值不变。 */

/** fg 以自身 alpha 合成到不透明底 bg 上（消去透明度）。 */
function compositeOver(fg: { rgb: Rgb; a: number }, bg: Rgb): Rgb {
  return mixRgb(bg, fg.rgb, fg.a);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * 反解叠加色（alpha 混合的逆运算）：
 * `solved = clamp((target − base × (1 − α)) / α)`，返回携带 α 的 rgba。
 * α ≤ 0 时返回全透明的 target（涂层不参与视觉）。
 * @example
 * ```ts
 * invertAlphaBlend({r:10,g:10,b:10}, {r:40,g:40,b:40}, 0.5); // ≈ rgba(70,70,70,0.5)
 * ```
 */
export function invertAlphaBlend(base: Rgb, target: Rgb, alpha: number): { rgb: Rgb; a: number } {
  const a = clamp01(alpha);
  if (a <= 0) return { rgb: { ...target }, a: 0 };
  const inv = 1 - a;
  const clamp255 = (v: number) => Math.max(0, Math.min(255, v));
  return {
    rgb: {
      r: clamp255((target.r - base.r * inv) / a),
      g: clamp255((target.g - base.g * inv) / a),
      b: clamp255((target.b - base.b * inv) / a)
    },
    a
  };
}

/** 状态层参数（抬升面档）：hover 混入 8% On 色、active 混入 15%。 */
const STATE_MIX = { hover: 0.08, active: 0.15 } as const;

/** 深浅两档的海拔步长：L1–L4 向 ink 方向的混色比例（L0 为本体）。 */
const ELEVATION_STEPS = {
  dark: [0, 0.055, 0.11, 0.165, 0.21],
  light: [0, 0.04, 0.08, 0.12, 0.16]
} as const;

export interface LayerTokens {
  /** 按当前小组件不透明度求解的表面色（rgba，带 α）。 */
  bg: string;
  /** α=1 的设计目标色（#rrggbb）：设置窗 / 右键菜单等实底 chrome 表面用。 */
  solid: string;
  /** 该层内容色。 */
  on: string;
  /** 求解后的 hover / active 表面色（8% / 15% 混 On）。 */
  hover: string;
  active: string;
}

/** rgba 字符串（通道取整；alpha 保留 3 位）。 */
function rgbaCss(c: Rgb, a: number): string {
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Number(a.toFixed(3))})`;
}

/** #rrggbb 字符串。 */
function hexCss(c: Rgb): string {
  return `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

/**
 * 计算五层表面栈（L0 卡片底 → L4 最高弹层）。
 * @param deskBase   假定桌面底色（生效 token 的 bg）——L0 的求解底。
 * @param glassColor 小组件玻璃色（可为 rgba；先合成到 deskBase 消去透明度）。
 * @param ink        内容色（On 色 / hover-active 混入色）。
 * @param alpha      小组件不透明度（widgetOpacity/100）。
 * @param isLight    明暗档（决定海拔步长方向与幅度）。
 */
export function computeLayerStack(
  deskBase: string,
  glassColor: string,
  ink: string,
  alpha: number,
  isLight: boolean
): LayerTokens[] {
  const desk = parseCssColor(deskBase);
  const glass = parseCssColor(glassColor);
  const inkC = parseCssColor(ink);
  if (!desk || !glass || !inkC) return [];
  const a = clamp01(alpha);

  // L0 的不透明设计底 = 玻璃色合成到假定桌面底上。
  const base0 = compositeOver(glass, desk.rgb);
  const steps = isLight ? ELEVATION_STEPS.light : ELEVATION_STEPS.dark;
  /** 自 base0 向 ink 方向混入 step 比例（海拔梯度的设计目标色）。 */
  const towardInk = (step: number) => mixRgb(base0, inkC.rgb, step);
  const layers: LayerTokens[] = [];
  for (let n = 0; n <= 4; n++) {
    // 每层对「下一层的设计底」做 alpha 逆混合（invertAlphaBlend）。
    const solveBase = n === 0 ? desk.rgb : towardInk(steps[n - 1]);
    const target = n === 0 ? base0 : towardInk(steps[n]);
    const solved = invertAlphaBlend(solveBase, target, a);
    const hoverT = invertAlphaBlend(solveBase, mixRgb(target, inkC.rgb, STATE_MIX.hover), a);
    const activeT = invertAlphaBlend(solveBase, mixRgb(target, inkC.rgb, STATE_MIX.active), a);
    layers.push({
      bg: rgbaCss(solved.rgb, a),
      solid: hexCss(target),
      on: ink,
      hover: rgbaCss(hoverT.rgb, a),
      active: rgbaCss(activeT.rgb, a)
    });
  }
  return layers;
}

/** 外观相关字段的最小结构（store 的 SettingsState 结构性满足）。 */
export interface AppearanceLike {
  preset: ThemePreset;
  themeMode: ThemeMode;
  primaryColor: string;
  /** preset = "custom" 时的底色 / 文字色（深浅两档）；其余档位忽略。 */
  customColors?: CustomThemeColors | null;
  zoom: number;
  font: string;
  fontSize: number;
  widgetBackground: string;
  widgetOpacity: number;
  cornerRadius: number;
  spacing: number;
  blur: number;
  settingsWindowOpacity: number;
}
export interface ThemeExtra {
  enableAnimations: boolean;
  animationMode: string;
  animationDuration?: number;
  animationSpeed?: string;
  fxToggles: Partial<Record<FxEffectId, boolean>>;
  widgetEntrance: string;
  viewTransition: string;
  /** 自定义缓动曲线（可选：旧调用方不传则不写 --ease-custom）。 */
  customEase?: BezierPoints;
  customEaseEnabled?: boolean;
}
/* 主题切换过渡（lib/theme-ink.ts 水墨晕开）的接管钩子：StylePage 在点击
   发起的主题切换 commit 后调 deferNextThemeApply()，随后 SettingsSync 的
   applySettings 命中此处 —— 本次调用被吞掉（token 尚未写入），待墨层覆盖
   满整窗后由 onCovered 回放 applySettings 完成真正换肤。非点击路径（跨窗
   同步、系统明暗跟随）不设标记，主题即时生效。
   lastThemeKey 记录上次生效主题键：变化检测现在仅供接管分支判断
   「这确实是主题切换」，同时保持首次水合（null）不触发。 */
let lastThemeKey: string | null = null;
let inkDeferOnce = false;

/**
 * 吞掉下一次「主题键发生变化」的 applySettings（水墨过渡接管上色时机）。
 * 必须与 cancelDeferNextThemeApply 成对使用：墨层起不来时取消并立即上色。
 */
export function deferNextThemeApply(): void {
  inkDeferOnce = true;
}

/** 取消未消费的接管标记（墨层启动失败的兜底路径用）。 */
export function cancelDeferNextThemeApply(): void {
  inkDeferOnce = false;
}

/* （浮窗深浅接入水墨）：FloatingThemeSync 在本窗口对主题键变化独立重放
   applySettings（分体主题覆盖写），它发生在 SettingsSync 的全局写之后——
   上述 inkDeferOnce 只拦得住前者，拦不住后者，浮窗深浅档一变就是先行硬切。
   这是第二枚一次性标记：StylePage 的水墨接管流程在 arm 时一并挂上，
   FloatingThemeSync 重放前消费；覆盖满后由 onCovered 携带分体快照统一上色。 */
let floatingInkDeferOnce = false;

/** 吞掉下一次 FloatingThemeSync 的覆盖重放（与 deferNextThemeApply 成对使用）。 */
export function deferNextFloatingThemeApply(): void {
  floatingInkDeferOnce = true;
}

/** 取消未消费的浮窗重放接管标记（墨层起不来的兜底路径用）。 */
export function cancelDeferNextFloatingThemeApply(): void {
  floatingInkDeferOnce = false;
}

/** FloatingThemeSync 重放前调用：命中挂起标记则吞掉本次并返回 true。 */
export function consumeFloatingThemeApplyDeferral(): boolean {
  if (!floatingInkDeferOnce) return false;
  floatingInkDeferOnce = false;
  return true;
}

/* 动效模式/特效开关切换时抑制整页入场动画重播：data-fx / data-fx-off 翻转
   会让 .tm-setting-row 等重新匹配 fx-list-in 选择器，全部行带错落延迟重滑
   一遍，视觉上就是"点一下闪一下屏"。挂 .fx-switching 1s 内禁用这些入场
   动画（首次水合 lastFxKey 为 null 不抑制，页面首载入场照常播放）。 */
let lastFxKey: string | null = null;
let fxSwitchTimer: number | undefined;

/* 主色平滑（非 ink 路径）：上次写入的主色 / 生效明暗档 / 预设快照。
   只有「主色单独变化」才挂 theme-crossfade-accent 走 @property --accent
   token 过渡；预设或明暗档变化仍即时呈现（换肤是整屏语义，插值反而拖泥带水）。 */
let prevPrimaryColor: string | null = null;
let prevIsLight: boolean | null = null;
let prevPreset: string | null = null;
let accentFadeTimer: number | undefined;

export type PresetTokens = {
  bg: string;
  bgGlow: string;
  ink: string;
  muted: string;
  paper: string;
  paperSolid: string;
  line: string;
  accent: string;
  accent2: string;
  glassBlur: string;
};

/** 一个主题预设的完整定义：同一主题在深色 / 浅色「主题模式」下的两套 token。 */
export type ThemePresetTokens = { dark: PresetTokens; light: PresetTokens };

/**
 * The appearance presets. 每个主题自带深 / 浅两套完整 token（「主题模式」
 * 亮档 / 暗档各取其一，system 跟随系统明暗），应用于 <html> 的 CSS 变量。
 * 配色沿袭原参考体系：
 *  - 默认：暗 = Vercel 极简黑白（原「午夜」），亮 = Apple HIG iOS 蓝（原「日光」）；
 *  - 终端：暗 = 荧光终端，亮 = 暖纸陶土（曾名「复古」，preset id 仍为 retro）；
 *  - 自定义：种子色板（石墨夜 / 暖纸）仅作卡片预览与未定制时的缺省，
 *    实际生效色由 settings.customColors（底色 + 文字色）经 deriveCustomTokens 派生。
 */
export const PRESETS: Record<ThemePreset, ThemePresetTokens> = {
  default: {
    dark: {
      bg: "#0a0a0a",
      bgGlow: "#171717",
      ink: "#fafafa",
      muted: "rgba(250,250,250,.55)",
      paper: "rgba(23,23,23,.66)",
      paperSolid: "rgba(23,23,23,.9)",
      line: "rgba(255,255,255,.1)",
      accent: "#3a81f6",
      accent2: "#2563ef",
      glassBlur: "8px"
    },
    light: {
      bg: "#f2f2f7",
      bgGlow: "#ffffff",
      ink: "#1d1d1f",
      muted: "rgba(60,60,67,.78)",
      paper: "rgba(255,255,255,.68)",
      paperSolid: "rgba(255,255,255,.92)",
      line: "rgba(60,60,67,.12)",
      accent: "#007aff",
      accent2: "#2e8bff",
      glassBlur: "24px"
    }
  },
  retro: {
    dark: {
      bg: "#0a0a0a",
      bgGlow: "#141414",
      ink: "#e5e5e5",
      muted: "rgba(255,255,255,.5)",
      paper: "rgba(10,10,10,.6)",
      paperSolid: "rgba(0,0,0,.75)",
      line: "rgba(74,222,128,.14)",
      accent: "#4ade80",
      accent2: "#22c55e",
      glassBlur: "0px"
    },
    light: {
      bg: "#faf9f5",
      bgGlow: "#f5f4ef",
      ink: "#3d3929",
      muted: "rgba(61,57,41,.8)",
      paper: "rgba(252,251,247,.78)",
      paperSolid: "rgba(252,251,247,.95)",
      line: "rgba(61,57,41,.14)",
      accent: "#c96442",
      accent2: "#d97757",
      glassBlur: "10px"
    }
  },
  custom: {
    dark: {
      bg: "#12141c",
      bgGlow: "#171a24",
      ink: "#e8eaf2",
      muted: "rgba(232,234,242,.55)",
      paper: "rgba(22,25,35,.66)",
      paperSolid: "rgba(22,25,35,.9)",
      line: "rgba(232,234,242,.1)",
      accent: "#7c9cff",
      accent2: "#93afff",
      glassBlur: "8px"
    },
    light: {
      bg: "#f5f3ee",
      bgGlow: "#fbfaf7",
      ink: "#33302a",
      muted: "rgba(51,48,42,.8)",
      paper: "rgba(252,251,248,.78)",
      paperSolid: "rgba(252,251,248,.95)",
      line: "rgba(51,48,42,.12)",
      accent: "#8a6d3b",
      accent2: "#a3824a",
      glassBlur: "24px"
    }
  }
};

export const PRESET_NAMES: Record<ThemePreset, string> = {
  default: "默认",
  retro: "终端",
  custom: "自定义"
};

/** 各预设的玻璃质感档位：暗档偏通透（低不透明度），亮 / 哑光主题更实。 */
export const PRESET_DEFAULT_OPACITY: Record<ThemePreset, number> = {
  default: 55,
  retro: 85,
  custom: 70
};

/**
 * 可独立开关的特效清单（动画设置 → 特效管理）。
 * - CSS 侧：applySettings 把关闭的 id 写入 html[data-fx-off="id1 id2 …"]，
 *   feature-fx.css / rb.css 的 data-fx 规则带 :not([data-fx-off~="id"]) 门控
 *   （check-fx-gate.mjs 对 src/**\/*.css 递归强制，规则缺失即 lint 失败）。
 * - JS 侧：useFxEffectEnabled(id)（lib/fx.tsx）读取同一份开关。
 * 默认全部开启（fxToggles 只存显式关闭/开启的项，缺省 = 开）。
 */
export type FxEffectId =
  | "starBorder" // 流光边框：侧栏激活项 / 分段控件 / 主按钮描边光点
  | "shinyText" // 标题扫光：标题栏文字周期性高光扫过
  | "textFx" // 文字动效：逐字入场 / 乱码解密 / 数值滚动
  | "listStagger" // 错落入场：设置行与侧栏项依次滑入
  | "pointerFollow" // 指针跟随：聚光光斑 / Bento 磁吸平移 / 磁性按钮
  | "ambientGlow" // 常驻氛围：侧栏光带 / 液态分隔线 / 章节下划线光带
  | "hoverGlow" // 悬停辉光：按钮光环 / 卡片扫光 / 输入聚焦光环
  | "elastic" // 弹性反馈：开关弹性 / 分段弹入 / 右键菜单入场
  | "specular" // 选中高光框：分段与预设卡片选中态的圆周高光
  | "pixelSwap" // 像素涟漪：切换样式预设时荡开的像素格波纹
  | "particleText" // 粒子文字：许可证页 Vela 粒子聚合
  | "ambientMotion" // 常驻动效：画廊漂移墙 / 岛内音乐跑马
  | "cardHover" // 悬浮窗卡片：悬停放大 / 双色描边 / 视图切换器呼吸晕
  | "springCheck"; // 弹簧勾选：待办完成的弹性填充 / 对勾描边 / 删除线滞后

export const FX_EFFECT_IDS: readonly FxEffectId[] = [
  "starBorder",
  "shinyText",
  "textFx",
  "listStagger",
  "pointerFollow",
  "ambientGlow",
  "hoverGlow",
  "elastic",
  "specular",
  "pixelSwap",
  "particleText",
  "cardHover",
  "springCheck",
  "ambientMotion"
];

/**
 * 界面字体的 CSS 回退栈：字体下拉的可选项 → font-family 值。裸字体名在
 * 字体缺失时（Windows 选「苹方」、未装 JetBrains Mono / Noto Sans SC 等）
 * 会一路回落到浏览器默认衬线，中文观感骤降；按「所选字体 → 同形制替身 →
 * 系统栈」给每一档配链。未知字体值（历史快照 / 手改存储）也兜进系统栈，
 * 字体名内的引号剥除（font-family 单值注入面收口）。
 */
export const UI_FONT_STACKS: Record<string, string> = {
  系统: "'Segoe UI','Microsoft YaHei',system-ui,sans-serif",
  "Segoe UI": "'Segoe UI','Microsoft YaHei',system-ui,sans-serif",
  "Microsoft YaHei": "'Microsoft YaHei','Segoe UI',system-ui,sans-serif",
  "PingFang SC": "'PingFang SC','Microsoft YaHei','Noto Sans SC',system-ui,sans-serif",
  "Noto Sans SC": "'Noto Sans SC','Microsoft YaHei','PingFang SC',system-ui,sans-serif",
  Outfit: "'Outfit','Segoe UI','Microsoft YaHei',sans-serif",
  "JetBrains Mono": "'JetBrains Mono','Geist Mono',Consolas,'Microsoft YaHei',monospace"
};

/** 字体设置值 → 完整 font-family 栈（未知值剥离引号后配系统栈兜底）。 */
export function uiFontStack(font: string): string {
  const known = UI_FONT_STACKS[font];
  if (known) return known;
  const safe = font.replace(/["']/g, "").trim();
  if (!safe) return UI_FONT_STACKS["系统"];
  return `'${safe}','Segoe UI','Microsoft YaHei',system-ui,sans-serif`;
}

/**
 * Applies the current settings to the CSS variables on <html>. Called on
 * hydration and whenever a setting changes. Only the appearance-relevant
 * fields are read, so a Partial is accepted.
 */
/** 系统明暗偏好（「主题模式 = 系统」档消费）；SSR / 无 matchMedia 环境按深色。 */
export function systemPrefersDark(): boolean {
  try {
    return (
      typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return true;
  }
}

/**
 * 由自定义主题的「底色 + 文字色」派生完整 token 集（preset = "custom"）。
 * 次级 token 的派生口径与内置预设一致：
 *  - bgGlow / paper：底色向「提亮方向」（深色档向文字色、浅色档向白）微混，
 *    保证悬浮层恒比底色抬升；
 *  - muted / line：文字色按档位 alpha 淡化；
 *  - accent / accent2：取种子色板值（主色仍由 settings.primaryColor 单源覆盖，
 *    引擎按 deriveAccent2 派生 --accent-2）。
 *
 * @param pair - 自定义档的底色 / 文字色（sanitize 后必为合法 hex）。
 * @returns 可直接写入 CSS 变量的完整 token 集。
 */
export function deriveCustomTokens(pair: CustomThemePair): PresetTokens {
  const isLight = luminance(pair.bg) > 0.5;
  const lift = isLight ? "#ffffff" : pair.ink;
  const paperBase = mixHex(pair.bg, lift, isLight ? 0.55 : 0.08);
  const seed = isLight ? PRESETS.custom.light : PRESETS.custom.dark;
  return {
    bg: pair.bg,
    bgGlow: mixHex(pair.bg, lift, isLight ? 0.45 : 0.05),
    ink: pair.ink,
    muted: hexToRgba(pair.ink, 0.55),
    paper: hexToRgba(paperBase, 0.66),
    paperSolid: hexToRgba(paperBase, 0.9),
    line: hexToRgba(pair.ink, 0.1),
    accent: seed.accent,
    accent2: deriveAccent2(seed.accent, isLight),
    glassBlur: seed.glassBlur
  };
}

/**
 * 解析「当前生效」的 token 集合。主题预设自带深 / 浅两套完整 token：
 *  - dark / light：直接取该预设对应档；
 *  - system：跟随操作系统明暗偏好（matchMedia，实时反映系统切换）。
 * preset = "custom" 时由 customColors（缺省回退种子色板）派生。
 * 主题模式的深浅语义因此对所有预设一致——同一主题在两种模式下都是它自己
 * （默认暗档即原「午夜」、亮档即原「日光」），文字对比度天然成立。
 *
 * [POLISH] 导出供 PresetCard 实时预览层计算「切到这张卡会得到什么」的
 * 真实中性 token（accent 由调用方按 primaryColor 叠加，与 applySettings 同口径）。
 */
export function resolveEffectiveTokens(
  preset: ThemePreset,
  themeMode: ThemeMode,
  custom?: CustomThemeColors | null
): PresetTokens {
  if (preset === "custom") {
    const fallback: CustomThemePair =
      themeMode === "light"
        ? PRESETS.custom.light
        : themeMode === "dark"
          ? PRESETS.custom.dark
          : systemPrefersDark()
            ? PRESETS.custom.dark
            : PRESETS.custom.light;
    const pair: CustomThemePair =
      themeMode === "light"
        ? (custom?.light ?? fallback)
        : themeMode === "dark"
          ? (custom?.dark ?? fallback)
          : systemPrefersDark()
            ? (custom?.dark ?? fallback)
            : (custom?.light ?? fallback);
    return deriveCustomTokens(pair);
  }
  const t = PRESETS[preset] ?? PRESETS.default;
  if (themeMode === "light") return t.light;
  if (themeMode === "dark") return t.dark;
  return systemPrefersDark() ? t.dark : t.light;
}

/**
 * 把外观与动效设置一次性应用到文档根（主题引擎主入口）。
 *
 * 职责：解析生效 token（预设 × 明暗模式）→ 写入全部 CSS 变量与
 * data-* 属性（data-theme / data-no-glass / data-fx / data-fx-off /
 * data-widget-entrance 等，CSS 侧据此门控）。仅在设置变更/初始化时调用
 * （事件驱动低频），含水墨接管分支与特效开关重播抑制（lastThemeKey/
 * lastFxKey 翻转检测）。
 *
 * @param s - 外观快照（预设/明暗/主色/圆角/模糊/缩放/字体等）。
 * @param extra - 动效环境（开关/模式/时长微调/逐特效开关）。
 * @param reduceEffects - 「减少特效」总开关：true 时玻璃模糊归零、
 *        全局 backdrop-filter 一键关闭（低端机主要掉帧源）。
 * @returns 无。
 *
 * @example
 * ```ts
 * applySettings(merged, themeEnvOf(merged), merged.general.reduceEffects);
 * ```
 */
export function applySettings(s: AppearanceLike, extra: ThemeExtra, reduceEffects: boolean) {
  const root = document.documentElement;
  // 主题模式决定生效的明暗方案：dark/light 取预设对应档，system 跟随系统明暗；
  // 自定义档由 customColors 派生。文字对比度始终跟随最终生效的背景亮度，
  // 保证任何组合下都可读。
  const t = resolveEffectiveTokens(s.preset, s.themeMode, s.customColors);
  const isLight = luminance(t.bg) > 0.5;

  /* 生效小组件背景（自下方卡片区段上移）：背景若仍是预设默认玻璃色（深 / 浅
     任一档的 paper），跟随当前生效档的 paper——「主题模式」切换时玻璃色自动
     换到对应档；用户自定义过的背景原样保留，任何组合下都可读。上移是因为
     文字极性联防（inkTokens）要在 ink 族写入前算出 effectiveBg。 */
  const presetTokens = PRESETS[s.preset] ?? PRESETS.default;
  const usingPresetBg =
    s.widgetBackground === presetTokens.dark.paper || s.widgetBackground === presetTokens.light.paper;
  const effectiveBg = usingPresetBg ? t.paper : s.widgetBackground;
  /* 文字极性联防：自定义背景的亮度极性与当前明暗档相反（暗色档选了浅背景、
     浅色档选了深背景）时，ink 族文字/发丝线翻到对档——用户可任意选色，
     可读性不能依赖选色审美。翻转值写 *-wl 镜像族，由 global.css 在
     body.tm-widget-layer（小组件层窗口）下整体换用；设置窗/速记窗有独立
     明暗档（FloatingThemeSync 重放同一引擎），必须保持基准 token 不被桌面
     背景色牵着走。预设背景不翻（两档 paper 与文字本成对；luminance 只认
     hex，对 rgba 的 paper 恒 0.5，正好被 !usingPresetBg 短路）。 */
  const inkFlip = !usingPresetBg && luminance(effectiveBg) > 0.5 !== isLight;
  const inkTokens = inkFlip ? (isLight ? presetTokens.dark : presetTokens.light) : t;
  const inkLight = isLight !== inkFlip;

  /* 主题键：预设 × 明暗模式 × 主色（+ 生效明暗档）。变化即「主题切换」。
     水墨接管分支：吞掉本次调用（见 inkDeferOnce 处注释），token 由墨层
     覆盖满后回放本函数时写入。原 #77 交叉淡化（.theme-transitioning
     350ms）已由水墨晕开取代移除。 */
  const themeKey = `${s.preset}|${s.themeMode}|${s.primaryColor}|${isLight ? "light" : "dark"}`;
  if (inkDeferOnce && lastThemeKey !== null && lastThemeKey !== themeKey) {
    inkDeferOnce = false;
    lastThemeKey = themeKey;
    return;
  }
  lastThemeKey = themeKey;

  // 主题的唯一来源：根据有效明暗状态设置 data-theme，驱动 global.css 中
  // [data-theme="glass"] 的 color-scheme 与回退变量。此前由遗留 app-store
  // 的 theme 控制，与 7 个预设脱节，导致浅色预设下原生控件仍渲染为深色。
  root.setAttribute("data-theme", isLight ? "light" : "glass");

  // "减少特效" disables the frosted-glass blur entirely (0px) for a flat look.
  // 同步挂全局属性，CSS 侧据此一键关闭所有 backdrop-filter
  // （56 处散布各样式文件，逐条改造不现实；透明窗口多层模糊在低端机/
  // 电池模式下是主要掉帧源，reduceEffects 时统一切纯色半透明底）。
  root.setAttribute("data-no-glass", reduceEffects ? "1" : "0");
  const blurPx = reduceEffects ? 0 : s.blur;

  // Animation speed mapping (seconds for a standard --anim-dur unit).
  const durFactor = (extra.animationDuration ?? 100) / 100;
  const animDur = !extra.enableAnimations
    ? 0
    : durFactor * (extra.animationSpeed === "slow" ? 0.5 : extra.animationSpeed === "fast" ? 0.12 : 0.25);
  /* 上限 0.5s：slow + 200% 的极端组合原值 1.0s（--anim-dur-slow 达 2s），入场类
     动画超过 800ms 体验线等得烦躁；0.5 封顶后 slow 变体最长 1.0s、fast 变体不受影响。 */
  const animDurCapped = Math.min(0.5, animDur);
  const animDurFast = Math.max(0.04, animDurCapped * 0.5);
  root.style.setProperty("--anim-dur", `${animDurCapped}s`);
  root.style.setProperty("--anim-dur-fast", `${animDurFast}s`);
  root.style.setProperty("--anim-dur-slow", `${Math.max(0.1, animDurCapped * 2)}s`);
  /* 层显隐淡出随速度档联动：把当前 --dur-fx（×0.8，与 feature-animations.css
     派生式同源）毫秒数推给 Rust，toggle 层显隐的 hide 等待取
     max(240, fx+40)——速度档调慢后淡出不再被恒定 240ms 从中间掐断。
     动效全关（animDurCapped=0）时上报 0，Rust 侧维持保底 240ms。 */
  if (isTauri()) {
    void invoke("set_layer_fade_ms", { ms: Math.round(animDurCapped * 0.8 * 1000) }).catch(() => {});
  }
  // 「减少动态」总门控（应用内开关 OR 动画关闭）：CSS 侧全部消费
  // [data-reduce-motion] 属性选择器（global.css / feature-fx.css），JS 侧由
  // lib/anim prefersReducedMotion() 读同一属性——不写 --reduce-motion 变量
  // （曾长期零消费者的死变量，已删）。
  root.setAttribute("data-reduce-motion", !extra.enableAnimations || extra.animationMode === "reduced" ? "1" : "0");
  // 增强动效：动效模式选「增强」时生效（feature-fx.css 消费）。
  const nextFx = extra.enableAnimations && extra.animationMode === "enhanced" ? "1" : "0";
  // 特效独立开关：关闭的 id 汇总写入 data-fx-off（CSS 组用 ~=
  // 词匹配门控）；--fx-scale 让「动画时长微调」同步作用于增强特效的
  // keyframes 时长（feature-fx.css 以 calc(Xs * var(--fx-scale)) 消费）。
  const fxOff = FX_EFFECT_IDS.filter((id) => extra.fxToggles[id] === false);
  // 入场重播抑制：仅在实际翻转时挂类（见 lastFxKey 处注释）。
  const nextFxKey = `${nextFx}|${fxOff.join(",")}`;
  if (lastFxKey !== null && lastFxKey !== nextFxKey) {
    root.classList.add("fx-switching");
    window.clearTimeout(fxSwitchTimer);
    fxSwitchTimer = window.setTimeout(() => root.classList.remove("fx-switching"), 1000);
  }
  lastFxKey = nextFxKey;
  root.setAttribute("data-fx", nextFx);
  if (fxOff.length > 0) root.setAttribute("data-fx-off", fxOff.join(" "));
  else root.removeAttribute("data-fx-off");
  /* --fx-scale 纳入速度三档（此前只有「动画时长」百分比生效，慢/快档对
     增强特效无效）：在百分比上再乘「速度档 / 标准档」比值（slow 2× /
     标准 1× / fast 0.48×）。上限 2×：极端组合（200% + slow）下 fx 流光类
     单循环可到 2s+，封顶防拖沓；feature-fx.css 以 calc(Xs * var(--fx-scale)) 消费。 */
  const speedMultiplier = extra.animationSpeed === "slow" ? 2 : extra.animationSpeed === "fast" ? 0.48 : 1;
  const fxScale = Math.min(2, durFactor * speedMultiplier);
  root.style.setProperty("--fx-scale", `${fxScale}`);

  // Widget entrance + view transition selectors drive the CSS keyframe rules.
  root.setAttribute("data-widget-entrance", extra.enableAnimations ? extra.widgetEntrance : "none");
  root.setAttribute("data-view-transition", extra.enableAnimations ? extra.viewTransition : "none");
  // 自定义曲线：编辑器产出写入 --ease-custom（与 两族 token 同一
  // 命名空间，供任何样式消费）；启用时让入场语义别名 --ease-entrance 指向它，
  // 小组件入场与动画页预览卡同源同曲线。未启用则移除内联值，回退
  // feature-animations.css 的缺省（--ease-out）。
  if (extra.customEase) root.style.setProperty("--ease-custom", toCubicBezierCss(extra.customEase));
  else root.style.removeProperty("--ease-custom");
  if (extra.customEase && extra.customEaseEnabled) root.style.setProperty("--ease-entrance", "var(--ease-custom)");
  else root.style.removeProperty("--ease-entrance");

  // Base palette from the preset.
  root.style.setProperty("--bg", t.bg);
  root.style.setProperty("--bg-glow", t.bgGlow);
  root.style.setProperty("--ink", t.ink);
  root.style.setProperty("--muted", t.muted);
  root.style.setProperty("--line", t.line);
  /* 极性镜像族（*-wl）：无翻转时与基准同值（inkFlip=false ⇒ inkTokens===t），
     CSS 侧可无条件引用；消费入口见 global.css 的 body.tm-widget-layer 块。 */
  root.style.setProperty("--ink-wl", inkTokens.ink);
  root.style.setProperty("--muted-wl", inkTokens.muted);
  root.style.setProperty("--line-wl", inkTokens.line);
  root.style.setProperty("--glass-blur", `${blurPx}px`);
  // 对比度：--muted-2 深色档 .4 白在纸面上仅 ≈3.5:1（WCAG FAIL），提至 .52；
  // 浅色档同步微调，保证弱化层级文本在任意预设底色上 ≥4.5:1。
  root.style.setProperty("--muted-2", isLight ? "rgba(0,0,0,.58)" : "rgba(255,255,255,.52)");
  root.style.setProperty("--muted-2-wl", inkLight ? "rgba(0,0,0,.58)" : "rgba(255,255,255,.52)");
  root.style.setProperty("--radius", `${s.cornerRadius}px`);
  // iOS 风格：各级圆角随 cornerRadius 等比缩放，小元素圆角更小、大面板更大，
  // 避免小按钮套用过大圆角或大面板圆角不足，整体观感统一圆润。
  root.style.setProperty("--radius-sm", `${Math.max(6, Math.round(s.cornerRadius * 0.5))}px`);
  root.style.setProperty("--radius-md", `${Math.max(8, Math.round(s.cornerRadius * 0.66))}px`);
  root.style.setProperty("--radius-lg", `${Math.max(10, Math.round(s.cornerRadius * 0.83))}px`);
  root.style.setProperty("--radius-xl", `${Math.max(12, Math.round(s.cornerRadius * 1.16))}px`);
  // F：内部控件圆角档（默认 cornerRadius=24 → 8px，与历史硬编码值一致）。
  root.style.setProperty("--radius-ctl", `${Math.max(4, Math.round(s.cornerRadius / 3))}px`);
  root.style.setProperty("--spacing", `${s.spacing}px`);
  root.style.setProperty("--blur", `${blurPx}px`);
  root.style.setProperty("--settings-window-opacity", `${s.settingsWindowOpacity / 100}`);
  root.style.setProperty("--line-strong", isLight ? "rgba(0,0,0,.15)" : "rgba(255,255,255,.15)");
  root.style.setProperty("--line-soft", isLight ? "rgba(0,0,0,.07)" : "rgba(255,255,255,.07)");
  root.style.setProperty("--surface-soft", isLight ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.08)");
  root.style.setProperty("--surface-hover", isLight ? "rgba(0,0,0,.05)" : "rgba(255,255,255,.12)");
  root.style.setProperty("--track", isLight ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.12)");
  root.style.setProperty("--line-strong-wl", inkLight ? "rgba(0,0,0,.15)" : "rgba(255,255,255,.15)");
  root.style.setProperty("--line-soft-wl", inkLight ? "rgba(0,0,0,.07)" : "rgba(255,255,255,.07)");
  root.style.setProperty("--surface-soft-wl", inkLight ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.08)");
  root.style.setProperty("--surface-hover-wl", inkLight ? "rgba(0,0,0,.05)" : "rgba(255,255,255,.12)");
  root.style.setProperty("--track-wl", inkLight ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.12)");

  // 补齐此前缺失的变量：深色模式下这些必须跟随明暗切换，否则会回退到
  // 浅色主题的默认值（如米色 surface-active、深红 danger），导致主题与
  // 悬浮窗不匹配。
  root.style.setProperty("--muted-3", isLight ? "rgba(0,0,0,.75)" : "rgba(255,255,255,.85)");
  root.style.setProperty("--surface-active", isLight ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.16)");
  root.style.setProperty("--check-border", isLight ? "rgba(0,0,0,.28)" : "rgba(255,255,255,.3)");
  root.style.setProperty("--muted-3-wl", inkLight ? "rgba(0,0,0,.75)" : "rgba(255,255,255,.85)");
  root.style.setProperty("--surface-active-wl", inkLight ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.16)");
  root.style.setProperty("--check-border-wl", inkLight ? "rgba(0,0,0,.28)" : "rgba(255,255,255,.3)");
  root.style.setProperty("--shadow", isLight ? "0 14px 35px rgba(67,55,35,.055)" : "0 8px 32px rgba(0,0,0,.5)");

  // 语义色：成功 / 警告（此前被蓝牙、设置页等引用但从未定义，导致回退到
  // 硬编码色，无法随主题切换）。浅色档取设置审计（2026-08-24 共性#1/#3）
  // 达标值：#15803d/#dc2626 在白底 ≥4.5:1（#4ade80 曾仅 1.74:1）。
  root.style.setProperty("--success", isLight ? "#15803d" : "#4ade80");
  root.style.setProperty("--success-soft", isLight ? "rgba(21,128,61,.12)" : "rgba(74,222,128,.16)");
  root.style.setProperty("--warn", isLight ? "#b45309" : "#f59e0b");
  root.style.setProperty("--warn-soft", isLight ? "rgba(180,83,9,.14)" : "rgba(245,158,11,.16)");
  // 琥珀（DDL 紧迫态等）与 --warn 同源，随明暗切换保持一致。
  root.style.setProperty("--amber", isLight ? "#b45309" : "#f59e0b");
  // 单源化：设置窗原作用域覆盖的徽标语义色（审计共性#1）提升为全局
  // 明暗双档——设置窗与右键菜单不再各自维护第二/第三套取值。
  root.style.setProperty("--amber-ink", isLight ? "#b45309" : "#fbbf24");
  root.style.setProperty("--amber-soft", isLight ? "rgba(180,83,9,.12)" : "rgba(251,191,36,.14)");
  root.style.setProperty("--sky-ink", isLight ? "#0369a1" : "#38bdf8");
  root.style.setProperty("--sky-soft", isLight ? "rgba(3,105,161,.1)" : "rgba(56,189,248,.14)");
  // 危险色浅色档同步审计值（#dc2626 / ink #b91c1c，白底 4.5:1+）。
  root.style.setProperty("--danger", isLight ? "#dc2626" : "#ef4444");
  root.style.setProperty("--danger-soft", isLight ? "rgba(220,38,38,.1)" : "rgba(239,68,68,.18)");
  root.style.setProperty("--danger-ink", isLight ? "#b91c1c" : "#f87171");

  // 文件浏览器 / 快捷方式使用的图标色（此前仅以硬编码回退值存在）。
  root.style.setProperty("--tm-folder", isLight ? "#b8860b" : "#fbbf24");
  // 文件类型图标色：文件浏览器按扩展名着色，深浅主题各取一档以保证辨识度。
  root.style.setProperty("--tm-image", isLight ? "#0284c7" : "#38bdf8");
  root.style.setProperty("--tm-video", isLight ? "#7c3aed" : "#a78bfa");
  root.style.setProperty("--tm-audio", isLight ? "#db2777" : "#f472b6");
  root.style.setProperty("--tm-archive", isLight ? "#b45309" : "#f59e0b");
  root.style.setProperty("--tm-code", isLight ? "#059669" : "#34d399");
  root.style.setProperty("--tm-sheet", isLight ? "#16a34a" : "#4ade80");
  root.style.setProperty("--tm-doc", isLight ? "#2563eb" : "#60a5fa");

  // Accent (primary color) with an override.
  // 主色平滑：仅主色变化（预设/明暗档未变）且动效开启时，短暂挂
  // theme-crossfade-accent，@property --accent token 过渡接管换色，
  // 非 ink 路径（跨窗同步、跟随事件改色）不再瞬跳。
  const accentOnlyChanged =
    prevPrimaryColor !== null &&
    prevPrimaryColor !== s.primaryColor &&
    prevIsLight === isLight &&
    prevPreset === s.preset;
  prevPrimaryColor = s.primaryColor;
  prevIsLight = isLight;
  prevPreset = s.preset;
  const accentSmooth = accentOnlyChanged && extra.enableAnimations && extra.animationMode !== "reduced";
  window.clearTimeout(accentFadeTimer);
  if (accentSmooth) {
    root.classList.add("theme-crossfade-accent");
    accentFadeTimer = window.setTimeout(() => root.classList.remove("theme-crossfade-accent"), 450);
  } else {
    root.classList.remove("theme-crossfade-accent");
  }
  root.style.setProperty("--tm-accent", s.primaryColor);
  root.style.setProperty("--accent", s.primaryColor);
  // 渐变副色：根据主色亮度自动派生一个更亮/更暗的变体，避免渐变退化为纯色。
  root.style.setProperty("--accent-2", deriveAccent2(s.primaryColor, isLight));
  root.style.setProperty("--btn-bg", s.primaryColor);
  // 按钮前景色：根据主色亮度自动选择深/浅文字，保证对比度（纸张主题的深棕
  // 主色下应使用浅色文字）。
  const btnFg = luminance(s.primaryColor) > 0.55 ? "#0a0e1a" : "#ffffff";
  root.style.setProperty("--btn-fg", btnFg);
  root.style.setProperty("--brand-bg", s.primaryColor);
  root.style.setProperty("--brand-fg", btnFg);

  // Widget card background + opacity.
  // 背景玻璃色度固定（不随不透明度变化）：整窗不透明度由 WidgetCard 上的
  // --widget-opacity 统一控制（全局 widgetOpacity × 每窗 opacity），避免
  // 背景与整窗双重透明导致过度穿透桌面。usingPresetBg / effectiveBg 的
  // 判定与「文字极性联防」同源，已在函数开头算出（见 inkFlip 处注释）。
  if (usingPresetBg) {
    // 生效 token 的 paper 是 rgba，直接采用它给出的、匹配当前明暗档的玻璃色。
    root.style.setProperty("--paper", t.paper);
    root.style.setProperty("--paper-solid", t.paperSolid);
    root.style.setProperty("--paper-soft", withAlpha(t.paperSolid, 0.3));
    root.style.setProperty("--popover-bg", withAlpha(t.paperSolid, 0.92));
    // 完全不透明版本（不透明度滑到 100% 时小组件背景用）：
    // 深色底取 bg 本色；浅色底把纸色 alpha 提满。
    root.style.setProperty("--paper-opaque", isLight ? withAlpha(t.paperSolid, 1) : t.bg);
  } else {
    const base = effectiveBg;
    root.style.setProperty("--paper", hexToRgba(base, 0.5));
    root.style.setProperty("--paper-solid", hexToRgba(base, 0.85));
    root.style.setProperty("--paper-soft", hexToRgba(base, 0.3));
    // 弹窗/下拉使用比卡片更实一点的背景，避免半透明下拉透过底层内容。
    root.style.setProperty("--popover-bg", hexToRgba(base, 0.92));
    // alpha=1 的本色：保证「不透明度 100%」时背景真正不透明（而非 0.85 的
    // paper-solid），滑块数值与实际透明度一一对应。
    root.style.setProperty("--paper-opaque", hexToRgba(base, 1));
  }

  // Zoom + font size.
  root.style.setProperty("--ui-zoom", `${s.zoom / 100}`);
  root.style.setProperty("--font-scale", `${s.fontSize / 100}`);
  // 字体写完整回退栈（uiFontStack）：字体缺失时回落同形制替身而非浏览器
  // 默认衬线；此前裸写字体名，Windows 上选「苹方」等未装字体观感受损。
  root.style.setProperty("--ui-font", uiFontStack(s.font));

  /* 色彩层级求解：按当前小组件不透明度把 L0–L4 五层表面 + 每层
     On/Hover/Active 写入 CSS 变量。求解保证「层 N 以 α 合成回层 的
     设计底」≈ 层 N 的设计目标色——透明度滑条拉低时各层通道被反解到
     极致补偿，层阶方向不反转（弹层对卡片始终抬升、明暗档方向一致）。
       --layer{n} 求解表面色（随 widgetOpacity，卡片族表面用）
       --layer{n}-solid α=1 设计目标（设置窗/右键菜单等实底 chrome 用）
       --layer{n}-on/-hover/-active 内容色与状态变体（8%/15% 混 On） */
  // 层阶「On/Hover/Active」文字色按 inkTokens（极性联防后）求解：自定义浅
  // 背景 + 暗色档时，卡片/弹层上的层阶文字与 --ink 同步翻深，不再白字白底。
  const layers = computeLayerStack(t.bg, effectiveBg, inkTokens.ink, s.widgetOpacity / 100, isLight);
  layers.forEach((l, n) => {
    root.style.setProperty(`--layer${n}`, l.bg);
    root.style.setProperty(`--layer${n}-solid`, l.solid);
    root.style.setProperty(`--layer${n}-on`, l.on);
    root.style.setProperty(`--layer${n}-hover`, l.hover);
    root.style.setProperty(`--layer${n}-active`, l.active);
  });
  // 弹层/下拉背景的求解版（新 token，--popover-bg 的 0.92 固定 alpha 契约原样
  // 保留给存量消费者）：L3 对卡片保持抬升关系并随不透明度滑条联动；α 设
  // 0.85 下限——菜单浮在卡片文字之上，跟随过低会透出底层内容伤可读性
  // （审计 Dropdown 项不回退），下限内仍按求解补偿通道。
  const popStack = computeLayerStack(t.bg, effectiveBg, t.ink, Math.max(s.widgetOpacity / 100, 0.85), isLight);
  if (popStack.length === 5) {
    root.style.setProperty("--popover-layer", popStack[3].bg);
  }
}
