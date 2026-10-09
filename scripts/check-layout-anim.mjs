// 布局/重绘属性动画审计（独立于 check-transitions.mjs 的告警集，默认只告警）。
//
// 背景：check-transitions.mjs 的 LAYOUT_PROPS 只有 8 个短名（width/height/top/
// left/right/bottom/margin/padding），正则 `(^|;|\s)(名)\s*:` 抓不到 margin-left /
// padding-top / max-height / grid-template-rows / gap 等长名，而且只在 :hover/:active/
// :focus 规则体里查、从不看 transition 的值本身——本仓库真实模式是「基规则声明
// transition: width/top/… + 类切换改属性」，全部静默过审；实测该层命中数为 0。
//
// 本脚本以 **transition 的值** 与 **@keyframes 帧内声明** 为扫描源，按代价分层：
//   Tier 1 布局（每帧 reflow）：告警；--strict 下非零退出
//   Tier 2 重绘（每帧 repaint，不 reflow）：低级别计数
//   合成器属性（transform/translate/rotate/scale/opacity）与 SVG 描笔类：忽略
// 行内豁免：声明同一行或紧邻上一行写 `/* layout-anim: ok <理由> */`（有意的、有
// @supports 门槛的离散动画，如灵动岛宽度 spring）。
//
// 用法：node scripts/check-layout-anim.mjs [--strict] [--inventory]
//   --strict     Tier 1 未豁免命中 → exit 1（接入门禁时使用）
//   --inventory  额外打印全库「被动画的属性」清单（按出现次数）
import fs from "node:fs";
import path from "node:path";

const strict = process.argv.includes("--strict");
const inventory = process.argv.includes("--inventory");

/** Tier 1：改动即触发布局（reflow）。含四向长名与 min/max 变体。 */
const LAYOUT = new Set([
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "top",
  "left",
  "right",
  "bottom",
  "inset",
  "inset-inline",
  "inset-block",
  "inset-inline-start",
  "inset-inline-end",
  "inset-block-start",
  "inset-block-end",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-inline",
  "margin-block",
  "margin-inline-start",
  "margin-inline-end",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-inline",
  "padding-block",
  "padding-inline-start",
  "padding-inline-end",
  "gap",
  "row-gap",
  "column-gap",
  "flex",
  "flex-basis",
  "flex-grow",
  "flex-shrink",
  "grid-template-rows",
  "grid-template-columns",
  "grid-row",
  "grid-column",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left"
]);
/** Tier 2：只重绘不布局。量大（box-shadow 100+）单独低级别输出，避免淹没 Tier 1。 */
const PAINT = new Set([
  "box-shadow",
  "filter",
  "backdrop-filter",
  "border-radius",
  "clip-path",
  "mask",
  "mask-image",
  "outline",
  "outline-width",
  "outline-offset",
  "background-position",
  "background-size",
  "text-decoration",
  "text-shadow"
]);
/** 合成器可独立处理的属性；颜色类只重绘但极便宜，也不计。 */
const IGNORE = new Set([
  "transform",
  "translate",
  "rotate",
  "scale",
  "opacity",
  "perspective",
  "offset-distance",
  "color",
  "background",
  "background-color",
  "border-color",
  "outline-color",
  "fill",
  "stroke",
  "stop-color",
  "stroke-dashoffset",
  "stroke-dasharray",
  "stroke-width",
  "cx",
  "cy",
  "r",
  "visibility",
  "none",
  "all-compositor"
]);

/** 剥注释但保留换行（行号不漂移）；同时保留豁免标记的位置信息由原文另查。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
/** 顶层逗号切分（cubic-bezier(…, …) / var(--a, b) 内的逗号不切）。 */
function splitTopLevelCommas(value) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** 声明所在行或上一行是否有豁免标记。 */
function exempted(rawLines, line) {
  const here = rawLines[line - 1] ?? "";
  const prev = rawLines[line - 2] ?? "";
  return /layout-anim:\s*ok/.test(here) || /layout-anim:\s*ok/.test(prev);
}
function classify(prop) {
  if (prop === "all") return "all";
  if (LAYOUT.has(prop)) return "layout";
  if (PAINT.has(prop)) return "paint";
  if (IGNORE.has(prop) || prop.startsWith("--")) return "ignore";
  if (prop.startsWith("var(")) return "unknown";
  return "other";
}

const findings = { layout: [], paint: [], all: [], unknown: [] };
const counts = new Map();
const bump = (prop) => counts.set(prop, (counts.get(prop) ?? 0) + 1);

/* M2 扩域：此前只扫 src/styles 平铺目录——src/components/*.css 与 TSX 内联
   transition 字符串（style 对象 / p.style.transition）完全无护栏。递归收
   src 下全部 .css，外加 .ts/.tsx 的内联 transition 值扫描（keyframes 声明
   在 TS 里不存在，不扫）。显示名统一为仓库相对路径。 */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk("src", []).sort();
for (const fileRaw of files) {
  const file = fileRaw.replace(/\\/g, "/");
  const raw = fs.readFileSync(fileRaw, "utf8");
  const rawLines = raw.split(/\r?\n/);
  const css = stripComments(raw);

  if (!file.endsWith(".css")) {
    /* TS/TSX：内联 transition 字符串（style 对象 / 元素样式赋值）。
       此前 inlineRe 只匹配 `transition: "…"` 引号紧跟
       形态——三元形态（`transition: cond ? "left 300ms" : "none"`，真/假分支
       均可能藏布局串）与真假分支中的模板串对门禁完全不可见（现网唯一实例
       WidgetExpandOverlay.tsx:385 = 三元 + 模板 + Tier1 布局属性）。改为取
       赋值行内全部引号段逐一判定；段内属性名之外全为 ${…} 运行时插值的，
       时长/曲线来自变量（animDurations/pickSpatialEase 产物）→ 天然放行，
       纯字面量段（"left 300ms"）照常按 Tier1 分层拦截。 */
    const assignRe = /(transition(?:-property)?)\s*[:=]\s*/g;
    let am;
    while ((am = assignRe.exec(css)) !== null) {
      const line = lineOf(css, am.index);
      const eol = css.indexOf("\n", am.index + am[0].length);
      const rhs = css.slice(am.index + am[0].length, eol < 0 ? css.length : eol);
      const strRe = /["'`]([^"'`\n]+)["'`]/g;
      let sm;
      while ((sm = strRe.exec(rhs)) !== null) {
        const ternary = rhs.slice(0, sm.index).includes("?");
        for (const seg of splitTopLevelCommas(sm[1])) {
          const prop = seg.split(/\s+/)[0].toLowerCase();
          if (!prop) continue;
          bump(prop);
          const kind = classify(prop);
          if (kind === "ignore" || kind === "other") continue;
          // 属性名之外全为 ${…} 插值 → 运行时 token 消费（非字面量布局动画），
          // 不进 findings；`left ${t} 300ms` 混写仍含字面量、照报。
          const rest = seg
            .slice(seg.split(/\s+/)[0].length)
            .replace(/\$\{[^}]*\}/g, " ")
            .trim();
          if (rest.length === 0) continue;
          findings[kind].push({
            file,
            line,
            prop,
            via: `inline-${am[1]}${ternary ? "-ternary" : ""}`,
            exempt: exempted(rawLines, line)
          });
        }
      }
      assignRe.lastIndex = am.index + am[0].length;
    }
    continue;
  }

  // 1) transition / transition-property 的值：每条声明、每个顶层逗号段的首 token 是属性名。
  const declRe = /(?:^|[;{])\s*(transition(?:-property)?)\s*:\s*([^;}]+)/g;
  let m;
  while ((m = declRe.exec(css)) !== null) {
    const line = lineOf(css, m.index + m[0].indexOf(m[1]));
    for (const seg of splitTopLevelCommas(m[2])) {
      const prop = seg.split(/\s+/)[0].toLowerCase();
      if (!prop) continue;
      bump(prop);
      const kind = classify(prop);
      if (kind === "ignore" || kind === "other") continue;
      findings[kind].push({ file, line, prop, via: m[1], exempt: exempted(rawLines, line) });
    }
  }

  // 2) @keyframes 帧内的声明：块内每个 `prop:`。
  const kfRe = /@keyframes\s+([\w-]+)\s*\{/g;
  while ((m = kfRe.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    const block = css.slice(start, i - 1);
    const propRe = /(?:^|[;{])\s*([a-z-]+)\s*:/g;
    let p;
    while ((p = propRe.exec(block)) !== null) {
      const prop = p[1].toLowerCase();
      bump(prop);
      const kind = classify(prop);
      if (kind === "ignore" || kind === "other") continue;
      const line = lineOf(css, start + p.index + p[0].indexOf(prop));
      findings[kind].push({ file, line, prop, via: `@keyframes ${m[1]}`, exempt: exempted(rawLines, line) });
    }
  }
}

const fmt = (f) => `${f.file}:${f.line}  ${f.prop}  (${f.via})${f.exempt ? "  [豁免]" : ""}`;
const layoutHot = findings.layout.filter((f) => !f.exempt);
const allHot = findings.all.filter((f) => !f.exempt);

console.log(
  `[layout-anim] 扫描 ${files.length} 个 CSS：Tier1 布局 ${findings.layout.length}（未豁免 ${layoutHot.length}）、transition: all ${findings.all.length}（未豁免 ${allHot.length}）、Tier2 重绘 ${findings.paint.length}、var() 未知 ${findings.unknown.length}`
);
if (findings.all.length) {
  console.log("\n-- transition: all（一律视为 Tier1，建议列明属性）--");
  for (const f of findings.all) console.log("  " + fmt(f));
}
if (findings.layout.length) {
  console.log("\n-- Tier 1 布局属性动画（每帧 reflow）--");
  for (const f of findings.layout) console.log("  " + fmt(f));
}
if (findings.paint.length) {
  const byProp = new Map();
  for (const f of findings.paint) byProp.set(f.prop, (byProp.get(f.prop) ?? 0) + 1);
  console.log("\n-- Tier 2 重绘属性动画（仅计数）--");
  for (const [prop, n] of [...byProp].sort((a, b) => b[1] - a[1])) console.log(`  ${prop} × ${n}`);
}
if (findings.unknown.length) {
  console.log("\n-- 经 var() 间接指定的 transition（无法静态判定）--");
  for (const f of findings.unknown) console.log("  " + fmt(f));
}
if (inventory) {
  console.log("\n-- 全库被动画/过渡的属性清单 --");
  for (const [prop, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${prop.padEnd(28)} ${n}`);
}

const hot = layoutHot.length + allHot.length;
if (strict && hot > 0) {
  console.error(
    `\n[layout-anim] --strict：${hot} 处未豁免的布局属性动画。改用 transform/opacity，或在声明行/上一行注释 /* layout-anim: ok <理由> */。`
  );
  process.exit(1);
}
