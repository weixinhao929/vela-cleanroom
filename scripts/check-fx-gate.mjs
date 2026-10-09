// Asserts that every effect rule scoped by html[data-fx="1"] in src/**\/*.css
// also carries a per-effect opt-out :not([data-fx-off~="<fx>"]).
//
// Why: each enhanced effect must be individually disable-able from settings.
// A new rule that only checks the master switch silently escapes its per-effect
// toggle — this check makes that a lint failure instead of a silent gap.
//
// Whitelist: selectors that are intentionally master-switch-only (the root
// toggle rule itself, base scrollbar styling) or reduce-motion kill switches.
//
// 盲区修复：此前硬编码只扫 feature-fx.css，rb.css 等文件里的 data-fx 规则
// （Magic Bento 光束/光斑）从不进检查——逐效开关在那些文件里整体缺失。

import fs from "node:fs";
import path from "node:path";

/** 递归收集 src/**\/*.css（与 check-transitions / check-will-change 同一口径）。 */
function walkCss(dirPath, out = []) {
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkCss(p, out);
    else if (ent.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const files = walkCss("src");

/** 按括号深度 0 的逗号拆选择器列表（:is()/:not() 等函数内的逗号不拆）。 */
function splitSelectors(prelude) {
  const out = [];
  let seg = "";
  let depth = 0;
  for (const ch of prelude) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(seg);
      seg = "";
    } else seg += ch;
  }
  out.push(seg);
  return out;
}

const WHITELIST = [
  // 主开关根规则本身（点亮特效作用域），无需逐效开关。
  /^html\[data-fx="1"\]\s*\{?$/,
  // 滚动条基础美化：跟随主开关，无独立特效项。
  /-webkit-scrollbar/,
  // reduce-motion 兜底块：本就是"全部关停"语义，不参与逐效开关。
  /data-reduce-motion/,
  // @media (prefers-reduced-motion) 块内的通配关停行（改为逐选择器
  // 判定后按段匹配，合并 ::before/::after 两种段形态，不再依赖整行 { 。
  /^html\[data-fx="1"\] \*(?:::before|::after)?,?$/
];

const issues = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  /*行级 includes('html[data-fx="1"]') 有三类形态旁路——单引号
     data-fx='1'、:root[data-fx="1"] 前缀、逗号折行后字面量落在续行。改为
     规则级状态机：剥注释后逐字符累积「选择器前导」，遇 { 判定一次（@media
     等前导自身无 data-fx 不受影响，其嵌套规则逐条判定）。命中形态放宽为
     任意引号的 [data-fx="1"]。白名单仍按前导内逐行匹配（沿用原行级语义）。 */
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const GATE_RE = /\[data-fx=['"]1['"]\]/;
  let prelude = "";
  let preludeStartLine = 1;
  let line = 1;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "\n") line++;
    if (ch === "{") {
      const sel = prelude.trim();
      if (sel && !/^@(?:media|supports|keyframes|layer|property)/.test(sel)) {
        /* 逗号选择器列表逐段判定——此前整条 prelude
           任一分支带 data-fx-off 就整条放行（「一段豁免、其余段裸奔」的
           形态旁路）。按括号深度 0 的逗号拆段（:is(a, b) 等函数内逗号不算
           选择器分隔），每段自身携带 data-fx-off 或命中白名单才算过。 */
        for (const segment of splitSelectors(sel)) {
          const s = segment.trim();
          if (!s || !GATE_RE.test(s) || s.includes("data-fx-off")) continue;
          const whitelisted = s
            .split("\n")
            .map((l) => l.trim())
            .some((l) => WHITELIST.some((re) => re.test(l)));
          if (!whitelisted)
            issues.push(
              `${path.relative(process.cwd(), file).replace(/\\/g, "/")}:${preludeStartLine}: ${s.replace(/\s+/g, " ").slice(0, 110)}`
            );
        }
      }
      prelude = "";
      preludeStartLine = line + 1;
    } else if (ch === "}") {
      prelude = "";
      preludeStartLine = line + 1;
    } else {
      prelude += ch;
    }
  }
}

if (issues.length > 0) {
  console.error(
    `[check-fx-gate] ${issues.length} selector(s) use html[data-fx="1"] without a ` +
      `per-effect :not([data-fx-off~="..."]) opt-out (or add to WHITELIST with a reason):\n` +
      issues.map((s) => "  " + s).join("\n")
  );
  process.exit(1);
}
console.log("[check-fx-gate] OK");

/* ══ fxToggles 直连检查（阻断级，2026-09-27）══
   逐效开关必须经 lib/fx.tsx 的 useFxEffectEnabled（CSS data-fx-off 口径的唯一
   生产者）。JS 特效绕开它直读 settings-store.fxToggles 会让 CSS/JS 两套开关
   口径分裂且无人拦截。白名单 = 管道本身（store/同步/设置页/主题引擎）。 */
{
  const WHITELIST = [
    "lib/fx.tsx",
    "lib/theme-engine.ts",
    "lib/cross-window.ts",
    "store/settings-store.ts",
    "app/SettingsSync.tsx",
    "features/settings/pages/AnimationPage.tsx",
    /* 管道语义的直读（不产生第二套开关口径）：
     * - appearance-fields：SettingsSync 的 selector 字段清单（同步管道本体）；
     * - FloatingThemeSync：把 store 的 extra 原样透传 applySettings（重放管道）；
     * - presence：订阅 fxToggles 引用变化补挂 data-fx-off 的 ambientMotion 闸
     *   （与 CSS 闸同一属性同一口径，读的是 sanitize 的新引用而非开关值）。 */
    "lib/appearance-fields.ts",
    "app/FloatingThemeSync.tsx",
    "app/handlers/presence.tsx"
  ];
  const direct = [];
  const walkTs = (dirPath, out = []) => {
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const p2 = path.join(dirPath, e.name);
      if (e.isDirectory()) walkTs(p2, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) out.push(p2);
    }
    return out;
  };
  for (const f of walkTs("src")) {
    if (!fs.readFileSync(f, "utf8").includes("fxToggles")) continue;
    const rel = path.relative("src", f).split(path.sep).join("/");
    if (WHITELIST.includes(rel)) continue;
    direct.push("  " + rel);
  }
  if (direct.length > 0) {
    const NL = String.fromCharCode(10);
    console.error(
      "[fx-toggles] 以下文件直读 fxToggles（应经 lib/fx.tsx 的 useFxEffectEnabled，" +
        "保证 CSS data-fx-off 与 JS 开关同口径）：" +
        NL +
        direct.join(NL)
    );
    process.exit(1);
  }
  console.log("[fx-toggles] fxToggles 直连检查通过（仅管道白名单文件触碰）。");
}
