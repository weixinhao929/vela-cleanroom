#!/usr/bin/env node
/**
 * 字号/圆角令牌门禁（严格）：src 下全部 CSS 里不允许再出现裸 px 的
 * font-size / border-radius（含 font: 简写内的字号分量）。
 *
 * 规则：
 *  - `font-size: <N>px` 与 `font:` 简写内的 `<N>px/` 分量必须走 var(--fs-*)；
 *  - border-radius 声明值里不允许裸 `<N>px` 分量（var()/calc() 包装内、
 *    50%/inherit/0 等非 px 分量不在此列）；
 *  - 额外校验：样式里引用的 --fs 系/--rad 系令牌必须在 global.css 有定义
 *    （防 codemod 手抖拼错令牌名导致整条字号失效回落继承）。
 *
 * 允许例外：ALLOWED 数组按「文件路径 → 行号」精确豁免并注明理由。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** 精确豁免表：relative 路径 → { 行号: 理由 }。当前为空——保持零裸 px。 */
const ALLOWED = {};

const TOKEN_DEF_FILE = join("src", "styles", "global.css");

function walkCss(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkCss(p));
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

/** 掩码 CSS 注释，避免注释中的示例 px 误报。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const errors = [];

// --fs-*/--rad-* 定义收集（global.css）。
const defined = new Set();
for (const m of stripComments(readFileSync(TOKEN_DEF_FILE, "utf8")).matchAll(/(--(?:fs|rad)-[\w-]+)\s*:/g)) {
  defined.add(m[1]);
}

for (const file of walkCss("src")) {
  const rel = relative(".", file).replaceAll("\\", "/");
  const raw = readFileSync(file, "utf8");
  const text = stripComments(raw);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const ln = i + 1;
    const exempt = ALLOWED[rel]?.[ln];
    if (exempt === true) return;
    const barePx = (re) => {
      const m = line.match(re);
      if (m && !exempt) {
        errors.push(`${rel}:${ln}: 裸 px（${m[0].trim()}）— 应改用 var(--fs-*/--rad-*) 令牌`);
      }
    };
    // font-size 声明与 font: 简写内的字号分量。
    barePx(/font-size:\s*\d+(?:\.\d+)?px/);
    barePx(/font:[^;]*\b\d+(?:\.\d+)?px\//);
    // border-radius 值内裸 px（剥掉 var()/calc() 包装后剩余的才算）。
    const br = line.match(/border-radius:\s*([^;]+);/);
    if (br && !exempt) {
      const stripped = br[1].replace(/var\([^()]*\)/g, "").replace(/calc\([^()]*\)/g, "");
      const hit = stripped.match(/\d+(?:\.\d+)?px/);
      if (hit) {
        errors.push(`${rel}:${ln}: border-radius 裸 px（${hit[0]}）— 应改用 var(--rad-*/--radius-*) 令牌`);
      }
    }
  });
  // 引用的数值令牌必须有定义（跨行声明按全文扫，行号取匹配处）。
  const rawNoCmt = stripComments(raw);
  rawNoCmt.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/var\((--(?:fs|rad)-[\w-]+)/g)) {
      if (!defined.has(m[1])) {
        errors.push(`${rel}:${i + 1}: 引用了未定义令牌 ${m[1]}（需在 global.css :root 补定义）`);
      }
    }
  });
}

if (errors.length) {
  console.error(`check-size-tokens: ${errors.length} 处违规`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log("check-size-tokens: OK（字号/圆角零裸 px，令牌引用全部有定义）");
