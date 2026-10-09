import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FX_EFFECT_IDS,
  PRESETS,
  PRESET_NAMES,
  applySettings,
  cancelDeferNextThemeApply,
  computeLayerStack,
  deferNextThemeApply,
  invertAlphaBlend,
  type AppearanceLike,
  type ThemeExtra
} from "./theme-engine";
import { luminance } from "./color";

/**
 * 主题引擎直测（settings-store.test 只覆盖经 store 的链路）：预设表完整性、
 * 明暗解析、减少特效/动效开关到 data-* 与 CSS 变量的映射、圆角等比档位，
 * 以及水墨接管（defer 一次主题切换的 applySettings）与特效翻转的临时类时序
 * （首次水合不挂、翻转后定时移除）。
 */
const root = () => document.documentElement;

const baseAppearance: AppearanceLike = {
  preset: "default",
  themeMode: "dark",
  primaryColor: "#3a81f6",
  zoom: 100,
  font: "系统",
  fontSize: 100,
  widgetBackground: "rgba(23,23,23,.66)",
  widgetOpacity: 55,
  cornerRadius: 24,
  spacing: 16,
  blur: 32,
  settingsWindowOpacity: 100
};

const baseExtra: ThemeExtra = {
  enableAnimations: true,
  animationMode: "normal",
  animationDuration: 100,
  fxToggles: {},
  widgetEntrance: "scale",
  viewTransition: "fade"
};

describe("预设表完整性", () => {
  it("每个主题都带齐深 / 浅两套 token 且全部非空", () => {
    const keys = [
      "bg",
      "bgGlow",
      "ink",
      "muted",
      "paper",
      "paperSolid",
      "line",
      "accent",
      "accent2",
      "glassBlur"
    ] as const;
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const variant of ["dark", "light"] as const) {
        for (const k of keys) {
          expect(typeof preset[variant][k], `${name}.${variant}.${k}`).toBe("string");
          expect(preset[variant][k].length, `${name}.${variant}.${k}`).toBeGreaterThan(0);
        }
      }
      expect(PRESET_NAMES[name as keyof typeof PRESET_NAMES]).toBeTruthy();
    }
  });

  it("特效 id 列表无重复", () => {
    expect(new Set(FX_EFFECT_IDS).size).toBe(FX_EFFECT_IDS.length);
  });

  it("每个主题的 dark 档为深色底、light 档为浅色底（明暗解析的依据）", () => {
    for (const preset of Object.values(PRESETS)) {
      expect(luminance(preset.dark.bg)).toBeLessThan(0.5);
      expect(luminance(preset.light.bg)).toBeGreaterThan(0.5);
    }
  });
});

describe("applySettings · 属性与变量映射", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    root().removeAttribute("style");
    root().className = "";
  });

  it("themeMode 显式选档：dark → data-theme=glass（深）、light → data-theme=light", () => {
    applySettings({ ...baseAppearance, preset: "default", themeMode: "light" }, baseExtra, false);
    expect(root().getAttribute("data-theme")).toBe("light");
    applySettings({ ...baseAppearance, preset: "default", themeMode: "dark" }, baseExtra, false);
    expect(root().getAttribute("data-theme")).toBe("glass");
    applySettings({ ...baseAppearance, preset: "retro", themeMode: "light" }, baseExtra, false);
    expect(root().getAttribute("data-theme")).toBe("light");
    applySettings({ ...baseAppearance, preset: "retro", themeMode: "dark" }, baseExtra, false);
    expect(root().getAttribute("data-theme")).toBe("glass");
  });

  it("生效 token 随主题模式切换为对应档（主色保留用户自定值）", () => {
    applySettings({ ...baseAppearance, preset: "retro", themeMode: "dark", primaryColor: "#123456" }, baseExtra, false);
    expect(root().style.getPropertyValue("--bg")).toBe(PRESETS.retro.dark.bg);
    applySettings(
      { ...baseAppearance, preset: "retro", themeMode: "light", primaryColor: "#123456" },
      baseExtra,
      false
    );
    expect(root().style.getPropertyValue("--bg")).toBe(PRESETS.retro.light.bg);
    expect(root().style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("reduceEffects 归零玻璃模糊并挂 data-no-glass", () => {
    applySettings(baseAppearance, baseExtra, true);
    expect(root().getAttribute("data-no-glass")).toBe("1");
    expect(root().style.getPropertyValue("--glass-blur")).toBe("0px");
    expect(root().style.getPropertyValue("--blur")).toBe("0px");
    applySettings(baseAppearance, baseExtra, false);
    expect(root().getAttribute("data-no-glass")).toBe("0");
    expect(root().style.getPropertyValue("--glass-blur")).toBe("32px");
  });

  it("关闭动画：时长归零、reduce-motion 置位、入场/视图切换为 none、增强特效关", () => {
    applySettings(baseAppearance, { ...baseExtra, enableAnimations: false, animationMode: "enhanced" }, false);
    expect(root().style.getPropertyValue("--anim-dur")).toBe("0s");
    expect(root().getAttribute("data-reduce-motion")).toBe("1");
    expect(root().getAttribute("data-widget-entrance")).toBe("none");
    expect(root().getAttribute("data-view-transition")).toBe("none");
    expect(root().getAttribute("data-fx")).toBe("0");
  });

  it("增强模式打开 data-fx；关闭的特效汇总进 data-fx-off，全开时移除该属性", () => {
    applySettings(
      baseAppearance,
      { ...baseExtra, animationMode: "enhanced", fxToggles: { particleText: false, hoverGlow: false } },
      false
    );
    expect(root().getAttribute("data-fx")).toBe("1");
    const off = (root().getAttribute("data-fx-off") ?? "").split(" ");
    expect(off).toContain("particleText");
    expect(off).toContain("hoverGlow");
    applySettings(baseAppearance, { ...baseExtra, animationMode: "enhanced", fxToggles: {} }, false);
    expect(root().hasAttribute("data-fx-off")).toBe(false);
  });

  it("动画时长微调与速度档共同决定 --anim-dur，--fx-scale 随两者乘积（速度三档纳入）", () => {
    applySettings(baseAppearance, { ...baseExtra, animationDuration: 200, animationSpeed: "fast" }, false);
    expect(root().style.getPropertyValue("--anim-dur")).toBe("0.24s"); // 2 × 0.12
    expect(root().style.getPropertyValue("--fx-scale")).toBe("0.96"); // 2 × 0.48（fast 档）
    applySettings(baseAppearance, { ...baseExtra, animationDuration: 100, animationSpeed: "slow" }, false);
    expect(root().style.getPropertyValue("--fx-scale")).toBe("2"); // 1 × 2（slow 档）
  });

  it("圆角各档随 cornerRadius 等比缩放并有下限", () => {
    applySettings({ ...baseAppearance, cornerRadius: 24 }, baseExtra, false);
    expect(root().style.getPropertyValue("--radius")).toBe("24px");
    expect(root().style.getPropertyValue("--radius-sm")).toBe("12px");
    expect(root().style.getPropertyValue("--radius-ctl")).toBe("8px");
    applySettings({ ...baseAppearance, cornerRadius: 4 }, baseExtra, false);
    expect(root().style.getPropertyValue("--radius-sm")).toBe("6px"); // 下限 6
    expect(root().style.getPropertyValue("--radius-ctl")).toBe("4px"); // 下限 4
  });

  it("水墨接管：defer 后主题切换的那次 applySettings 被吞掉，再次应用才生效", () => {
    applySettings({ ...baseAppearance, themeMode: "dark" }, baseExtra, false);
    const bgBefore = root().style.getPropertyValue("--bg");
    deferNextThemeApply();
    // 主题键变化 + defer 标记 → 本次调用被吞：token 保持旧值。
    applySettings({ ...baseAppearance, themeMode: "light" }, baseExtra, false);
    expect(root().style.getPropertyValue("--bg")).toBe(bgBefore);
    // 墨层覆盖满后的回放（无 defer）→ 新 token 真正写入。
    applySettings({ ...baseAppearance, themeMode: "light" }, baseExtra, false);
    expect(root().style.getPropertyValue("--bg")).not.toBe(bgBefore);
    // 清理：不残留标记影响后续用例。
    cancelDeferNextThemeApply();
  });

  it("水墨接管：主题键未变的 applySettings 不被吞；取消后恢复即时上色", () => {
    applySettings({ ...baseAppearance, themeMode: "dark" }, baseExtra, false);
    deferNextThemeApply();
    // 同主题键（如拖动缩放等非主题项）→ 不吞，正常应用。
    applySettings({ ...baseAppearance, themeMode: "dark", zoom: 120 }, baseExtra, false);
    expect(root().style.getPropertyValue("--ui-zoom")).toBe("1.2");
    cancelDeferNextThemeApply();
    // 取消后再切主题 → 即时上色（墨层起不来的兜底路径）。
    applySettings({ ...baseAppearance, themeMode: "light" }, baseExtra, false);
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("主题切换不再挂 .theme-transitioning（#77 交叉淡化已由水墨晕开移除）", () => {
    applySettings({ ...baseAppearance, themeMode: "dark" }, baseExtra, false);
    applySettings({ ...baseAppearance, themeMode: "light" }, baseExtra, false);
    expect(root().classList.contains("theme-transitioning")).toBe(false);
  });

  it("特效模式翻转挂 fx-switching 抑制入场重播，1s 后移除；同参数重复应用不挂", () => {
    applySettings(baseAppearance, { ...baseExtra, animationMode: "normal" }, false);
    root().classList.remove("fx-switching");
    applySettings(baseAppearance, { ...baseExtra, animationMode: "normal" }, false);
    expect(root().classList.contains("fx-switching")).toBe(false);
    applySettings(baseAppearance, { ...baseExtra, animationMode: "enhanced" }, false);
    expect(root().classList.contains("fx-switching")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(root().classList.contains("fx-switching")).toBe(false);
  });

  it("--ui-font 写完整回退栈：已知字体带替身链，未知/含引号字体兜底系统栈", () => {
    applySettings({ ...baseAppearance, font: "PingFang SC" }, baseExtra, false);
    // 苹方（Windows 常缺失）→ 雅黑替身在前，缺字不再回落浏览器衬线。
    expect(root().style.getPropertyValue("--ui-font")).toBe(
      "'PingFang SC','Microsoft YaHei','Noto Sans SC',system-ui,sans-serif"
    );
    applySettings({ ...baseAppearance, font: "JetBrains Mono" }, baseExtra, false);
    expect(root().style.getPropertyValue("--ui-font")).toBe(
      "'JetBrains Mono','Geist Mono',Consolas,'Microsoft YaHei',monospace"
    );
    // 未知字体值（历史快照）：引号剥除 + 系统栈兜底，字体名单值注入面收口。
    applySettings({ ...baseAppearance, font: "My'Font\" X" }, baseExtra, false);
    expect(root().style.getPropertyValue("--ui-font")).toBe(
      "'MyFont X','Segoe UI','Microsoft YaHei',system-ui,sans-serif"
    );
    applySettings({ ...baseAppearance, font: "" }, baseExtra, false);
    expect(root().style.getPropertyValue("--ui-font")).toBe("'Segoe UI','Microsoft YaHei',system-ui,sans-serif");
  });
});

/* ══════════════════ 色彩层级求解 ══════════════════ */

/** rgba() 字符串 → [r,g,b,a]（供层阶断言解析）。 */
function parseRgba(s: string): [number, number, number, number] {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/.exec(s);
  if (!m) throw new Error(`bad rgba: ${s}`);
  return [+m[1], +m[2], +m[3], +m[4]];
}
/** 相对亮度的快速近似（通道线性均值足够做层阶方向断言）。 */
const lumOf = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
/** solved 以自身 α 合成回 base 后的视觉亮度（验证反解恒等式）。 */
const compositeLum = (solved: string, base: [number, number, number]) => {
  const [r, g, b, a] = parseRgba(solved);
  return lumOf(a * r + (1 - a) * base[0], a * g + (1 - a) * base[1], a * b + (1 - a) * base[2]);
};

describe("A1 · invertAlphaBlend 数学", () => {
  it("α=1 时还原 target；合成恒等式在通道未钳制时成立", () => {
    const s = invertAlphaBlend({ r: 10, g: 10, b: 10 }, { r: 40, g: 60, b: 80 }, 1);
    expect([s.rgb.r, s.rgb.g, s.rgb.b]).toEqual([40, 60, 80]);
    // (target − base×(1−α))/α 涂在 base 上应还原 target
    const h = invertAlphaBlend({ r: 10, g: 10, b: 10 }, { r: 40, g: 60, b: 80 }, 0.5);
    for (const [solved, target] of [
      [h.rgb.r, 40],
      [h.rgb.g, 60],
      [h.rgb.b, 80]
    ] as const) {
      expect(solved * 0.5 + 10 * 0.5).toBeCloseTo(target, 5);
    }
  });

  it("α ≤ 0 返回全透明；通道始终钳制在 [0,255]", () => {
    const t = invertAlphaBlend({ r: 0, g: 0, b: 0 }, { r: 255, g: 128, b: 0 }, 0);
    expect(t.a).toBe(0);
    // 极端目标 + 极低 α：反解钳到 255，不产生越界值
    const e = invertAlphaBlend({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.01);
    expect(e.rgb.r).toBeLessThanOrEqual(255);
    expect(e.rgb.b).toBeGreaterThanOrEqual(0);
    expect(e.a).toBeCloseTo(0.01);
  });
});

describe("A1 · 层阶对比在任意透明度下成立（2 主题 × 明暗 × 预设）", () => {
  const CASES: { preset: keyof typeof PRESETS; mode: "system" | "light" | "dark"; light: boolean }[] = [
    { preset: "default", mode: "dark", light: false },
    { preset: "default", mode: "light", light: true },
    { preset: "retro", mode: "dark", light: false },
    { preset: "retro", mode: "light", light: true }
  ];
  const ALPHAS = [0.15, 0.45, 0.75, 1];

  it.each(CASES.map((c) => [c.preset, c.mode, c.light] as const))(
    "%s × %s（light=%s）：五层写入 + 亮度单调抬升 + On 对比达标",
    (preset, mode, wantLight) => {
      const wantBg = wantLight ? PRESETS[preset].light.paper : PRESETS[preset].dark.paper;
      for (const alpha of ALPHAS) {
        applySettings(
          {
            ...baseAppearance,
            preset,
            themeMode: mode,
            widgetBackground: wantBg,
            widgetOpacity: Math.round(alpha * 100)
          },
          baseExtra,
          false
        );
        const bgs = [0, 1, 2, 3, 4].map((n) => root().style.getPropertyValue(`--layer${n}`));
        const solids = [0, 1, 2, 3, 4].map((n) => root().style.getPropertyValue(`--layer${n}-solid`));
        expect(bgs.every((v) => v.startsWith("rgba("))).toBe(true);
        expect(solids.every((v) => v.startsWith("#") && v.length === 7)).toBe(true);
        // 每层求解色携带当前 α（L0 亦然）
        for (const bg of bgs) expect(parseRgba(bg)[3]).toBeCloseTo(alpha, 2);

        // 层阶方向：合成回「下一层设计底」后，亮度必须向 ink 方向单调抬升，
        // 且相邻层差 ≥ 0.004（深色向亮、浅色向暗——即始终向 ink 混合方向）。
        let prev = lumOf(
          parseInt(solids[0].slice(1, 3), 16),
          parseInt(solids[0].slice(3, 5), 16),
          parseInt(solids[0].slice(5, 7), 16)
        );
        for (let n = 1; n <= 4; n++) {
          const baseN = [
            parseInt(solids[n - 1].slice(1, 3), 16),
            parseInt(solids[n - 1].slice(3, 5), 16),
            parseInt(solids[n - 1].slice(5, 7), 16)
          ] as [number, number, number];
          const cur = compositeLum(bgs[n], baseN);
          const delta = wantLight ? prev - cur : cur - prev;
          expect(delta, `${preset}/${mode}/α=${alpha} L${n}`).toBeGreaterThan(0.004);
          prev = cur;
        }

        // On 色（生效 token 的 ink）对每层实底设计的 WCAG 对比 ≥ 4.5:1（浅底深字/深底浅字）
        const ink = (wantLight ? PRESETS[preset].light.ink : PRESETS[preset].dark.ink).trim();
        const inkLum = luminance(ink);
        for (let n = 0; n <= 4; n++) {
          const l = luminance(solids[n]);
          const ratio = (Math.max(l, inkLum) + 0.05) / (Math.min(l, inkLum) + 0.05);
          expect(ratio, `${preset}/${mode}/α=${alpha} on L${n}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  );

  it("hover/active 变体在求解底上比本体更接近 On 色（8%/15% 混入）", () => {
    const stack = computeLayerStack("#06080f", "rgba(255,255,255,.09)", "#ffffff", 0.6, false);
    expect(stack.length).toBe(5);
    const brightness = (a: string) => {
      const [r, g, b] = parseRgba(a);
      return r + g + b; // 深色档 On 为白：越大越接近 On
    };
    for (let n = 1; n <= 4; n++) {
      expect(brightness(stack[n].hover)).toBeGreaterThan(brightness(stack[n].bg));
      expect(brightness(stack[n].active)).toBeGreaterThan(brightness(stack[n].hover));
    }
  });

  it("弹层 --popover-layer：alpha 设 0.85 下限，且随求解补偿通道", () => {
    applySettings({ ...baseAppearance, widgetOpacity: 20 }, baseExtra, false);
    const pop = root().style.getPropertyValue("--popover-layer");
    expect(parseRgba(pop)[3]).toBeCloseTo(0.85, 2);
    applySettings({ ...baseAppearance, widgetOpacity: 100 }, baseExtra, false);
    expect(parseRgba(root().style.getPropertyValue("--popover-layer"))[3]).toBeCloseTo(1, 2);
    // 旧 --popover-bg 契约不受影响（0.92 固定 alpha；此处跟随 default 深档 paperSolid）
    expect(root().style.getPropertyValue("--popover-bg")).toBe("rgba(23,23,23,0.92)");
  });

  it("无法解析的输入返回空栈（安全降级，不写层变量）", () => {
    expect(computeLayerStack("nonsense", "also-bad", "#fff", 0.5, false)).toEqual([]);
  });
});
