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

/**
 * 按括号深度配平剥离函数包裹段（var/calc/clamp/min/max 任意嵌套）。
 * 名字前必须是边界（非 [-\w]），防 admin( 之类误命中；不配平的残缺段原样
 * 保留（交给裸值检测如实报告），不静默吞掉。
 */
function stripWrapped(value, names) {
  let s = value;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const name of names) {
      const needle = name + "(";
      let from = 0;
      let idx;
      while ((idx = s.indexOf(needle, from)) !== -1) {
        const prev = idx === 0 ? "" : s[idx - 1];
        if (/[-\w]/.test(prev)) {
          from = idx + needle.length;
          continue;
        }
        let depth = 0;
        let end = -1;
        for (let i = idx + needle.length - 1; i < s.length; i++) {
          if (s[i] === "(") depth++;
          else if (s[i] === ")") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (end === -1) {
          from = idx + needle.length;
          continue;
        }
        s = s.slice(0, idx) + " " + s.slice(end + 1);
        progressed = true;
        from = idx;
      }
    }
  }
  return s;
}

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
  /* 三属性统一**声明级**扫描（属性名到 `;`，跨行）。
   *  此前 font-size/border-radius 只有按行正则（Prettier 折行的声明整条不可见），
   *  多行 font: 补扫的行号恒报 :1: 且与按行正则对单行形态双报；另补「裸
   *  令牌」检测——值位出现未包 var() 的 --fs-xx 或 --rad-xx 名不是合法长度，
   *  整条声明会在解析期被丢弃（的 9 处 font 简写失效即是此形态）。 */
  const lineOf = (idx) => text.slice(0, idx).split("\n").length;
  const declRe = /(^|[{;])(\s*)(font-size|border-radius|font)\s*:([^;]*);/g;
  for (const m of text.matchAll(declRe)) {
    const prop = m[3];
    const value = m[4];
    const ln = lineOf(m.index);
    const exempt = ALLOWED[rel]?.[ln];
    if (exempt) continue;
    /* var()/calc()/clamp()/min()/max() 包装内的 px 视为有意计算（流式排版的
       clamp 界值、缩放乘数等），只拦**直接裸字面量**——与 border-radius 分支
       既有剥离口径一致（附带：旧按行正则只匹配 font-size: 紧随其后的
       字面量，calc/clamp 内的 px 本就不在拦截面）。
       R-工程-3（复审）：var 剥离用嵌套容错形态（同 check-transitions 的
       VAR_TOKEN_RE）——回退值含括号时（var(--fs-20, calc(14px+1vw))）单层
       剥离会失败，残留的 --fs-20 被裸令牌检测误伤。 */
    /* 剥离改括号深度配平——单层容错正则对两层嵌套回退
       （var(--fs-x, calc(max(14px, 1vw)))）剥离失败，残留 --fs-x 触发裸令牌
       假阳性阻断（R-工程-3 修的是单层，此处收口任意层数）。 */
    const stripped = stripWrapped(value, ["var", "calc", "clamp", "min", "max"]);
    if (prop === "font-size") {
      const hit = stripped.match(/\d+(?:\.\d+)?px/);
      if (hit) errors.push(`${rel}:${ln}: 裸 px（${hit[0]}）— 应改用 var(--fs-*) 令牌`);
    } else if (prop === "font") {
      const hit = stripped.match(/\b\d+(?:\.\d+)?px\s*\//);
      if (hit) errors.push(`${rel}:${ln}: font: 简写内裸 px（${hit[0].trim()}）— 应改用 var(--fs-*) 令牌`);
    } else {
      const hit = stripped.match(/\d+(?:\.\d+)?px/);
      if (hit) errors.push(`${rel}:${ln}: border-radius 裸 px（${hit[0]}）— 应改用 var(--rad-*/--radius-*) 令牌`);
    }
    const bareTok = stripped.match(/--(?:fs|rad)-[\w-]+/);
    if (bareTok) {
      errors.push(`${rel}:${ln}: 裸令牌 ${bareTok[0]}（未包 var()，整条声明会解析失效）`);
    }
  }
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
