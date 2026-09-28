#!/usr/bin/env node
/**
 * 字号/圆角全量令牌化 codemod（一次性迁移工具，保留供审计与回溯）。
 *
 * 规则（零视觉变更的机械替换）：
 *  - `font-size: <N>px` → `font-size: var(--fs-<N>)`（小数点写连字符：
 *    12.5px → --fs-12-5）；
 *  - `border-radius` 声明值里的裸 `<N>px` 分量 → 语义令牌（12/16/20/24/28
 *    精确映射 --radius-sm/md/lg/--radius/xl，999 与 9999 映射 --radius-pill）
 *    或数值令牌 `--rad-<N>`；值里含 var()/calc() 的声明整体跳过（var 兜底
 *    参数保持字面量），50%/inherit/0 等非 px 分量原样保留；
 *  - CSS 注释内容不参与替换（先掩码再还原）。
 *
 * 迁移后由 scripts/check-size-tokens.mjs 门禁把守：新增裸 px 即 CI 失败。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RADIUS_SEMANTIC = new Map([
  ["12", "--radius-sm"],
  ["16", "--radius-md"],
  ["20", "--radius-lg"],
  ["24", "--radius"],
  ["28", "--radius-xl"],
  ["999", "--radius-pill"],
  ["9999", "--radius-pill"]
]);

const tokenName = (prefix, px) => `--${prefix}-${px.replace(".", "-")}`;
const radiusToken = (px) => RADIUS_SEMANTIC.get(px) ?? tokenName("rad", px);

const usedTokens = new Map(); // name -> px
const note = (name, px) => {
  if (!usedTokens.has(name)) usedTokens.set(name, px);
};

function maskComments(text) {
  const spans = [];
  const masked = text.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    spans.push(m);
    return `/*C${spans.length - 1}C*/`;
  });
  return { masked, spans };
}

function transformCss(text, file) {
  const { masked, spans } = maskComments(text);
  let fontHits = 0;
  let radiusHits = 0;
  const out = masked
    .replace(/(font-size:\s*)(\d+(?:\.\d+)?)px/g, (_m, head, px) => {
      const name = tokenName("fs", px);
      note(name, px);
      fontHits++;
      return `${head}var(${name})`;
    })
    .replace(/(border-radius:\s*)([^;{}]+);/g, (m, head, value) => {
      if (value.includes("var(") || value.includes("calc(")) return m;
      let touched = false;
      const next = value.replace(/(\d+(?:\.\d+)?)px\b/g, (_mm, px) => {
        const name = radiusToken(px);
        note(name, px);
        touched = true;
        radiusHits++;
        return `var(${name})`;
      });
      return touched ? `${head}${next};` : m;
    });
  const restored = spans.length ? out.replace(/\/\*C(\d+)C\*\//g, (_m, i) => spans[Number(i)]) : out;
  if (fontHits || radiusHits) {
    console.log(`${file}: font-size ×${fontHits}, border-radius ×${radiusHits}`);
  }
  return { text: restored, fontHits, radiusHits };
}

function walkCss(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkCss(p));
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const files = walkCss("src");
let fsTotal = 0;
let radTotal = 0;
for (const f of files) {
  const before = readFileSync(f, "utf8");
  const { text, fontHits, radiusHits } = transformCss(before, f);
  fsTotal += fontHits;
  radTotal += radiusHits;
  if (text !== before) writeFileSync(f, text);
}

const numeric = [...usedTokens.entries()]
  .filter(([name]) => name.startsWith("--fs-") || name.startsWith("--rad-"))
  .sort((a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0]));
console.log(`\nfont-size 替换 ${fsTotal} 处，border-radius 替换 ${radTotal} 处。`);
console.log(`数值令牌 ${numeric.length} 个（语义令牌复用现有 --radius-* / --radius-pill）：`);
for (const [name, px] of numeric) console.log(`  ${name}: ${px}px;`);
