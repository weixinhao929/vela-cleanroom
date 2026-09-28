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

const WHITELIST = [
  // 主开关根规则本身（点亮特效作用域），无需逐效开关。
  /^html\[data-fx="1"\]\s*\{?$/,
  // 滚动条基础美化：跟随主开关，无独立特效项。
  /-webkit-scrollbar/,
  // reduce-motion 兜底块：本就是"全部关停"语义，不参与逐效开关。
  /data-reduce-motion/,
  // @media (prefers-reduced-motion) 块内的通配关停行（prelude 不在本行）。
  /^html\[data-fx="1"\] \*(::before)?,?$/,
  /^html\[data-fx="1"\] \*::after \{$/
];

const issues = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  text.split("\n").forEach((rawLine, idx) => {
    const line = rawLine;
    if (!line.includes('html[data-fx="1"]')) return;
    const trimmed = line.trim();
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) return; // 注释行
    if (line.includes("data-fx-off")) return; // 已带逐效开关
    if (WHITELIST.some((re) => re.test(trimmed))) return;
    issues.push(`${path.relative(process.cwd(), file).replace(/\\/g, "/")}:${idx + 1}: ${trimmed}`);
  });
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
    "features/settings/pages/AnimationPage.tsx"
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
