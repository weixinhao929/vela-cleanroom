#!/usr/bin/env node
/* 未定义 CSS 自定义属性引用门禁：扫描 src/（+ 根部 html）里全部 var(--x)
   引用，与定义处对账。定义来源四类：CSS `--x:` 声明、@property、TS 侧
   style.setProperty("--x")、TSX style 对象键 "--x":。
   引用未定义 token 会在明暗某档静默落到回退值或整条声明失效——
   --panel/--surface/--fg 三次白字白底事故（2026-09-27 审计 §1）都是这个
   模式，且平时全绿不可见。发现即非零退出；新增 token 请补定义而非回退。 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(css|tsx?|html)$/.test(name)) files.push(p);
  }
})(join(root, "src"));
for (const f of ["index.html", "taskbar-net.html"]) files.push(join(root, f));

const defined = new Set();
const refs = []; // { token, file, line }
const defRe = /(--[a-zA-Z][\w-]*)\s*:/g;
const propRe = /@property\s+(--[\w-]+)/g;
const setPropRe = /setProperty\(\s*[`'"](--[\w-]+)/g;
/* TSX style 对象键两种形态：{ "--x": v } 与 { ["--x" as string]: v }（项目里
   这两种并存），以及 Record 赋值形态 record["--x"] = v（DockShell 岛内边距）。 */
const objKeyRe = /[`'"](--[\w-]+)[`'"](?:\s+as\s+[\w|]+)?\s*:/g;
const keyAssignRe = /\[[`'"](--[\w-]+)[`'"](?:\s+as\s+[\w|]+)?\]\s*[=:]/g;
const refRe = /var\(\s*(--[a-zA-Z][\w-]*)/g;

for (const file of files) {
  let src = readFileSync(file, "utf8");
  const rel = relative(root, file).replace(/\\/g, "/");
  // 剥注释再对账：注释里提到 var(--x)（如「原 var(--panel) 从未定义」的
  // 既有修法注记）不是引用；注释掉的声明也不是定义。
  src = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (!file.endsWith(".css")) {
    src = src.replace(/^[ \t]*\/\/[^\n]*$/gm, " ");
    src = src.replace(/<!--[\s\S]*?-->/g, " ");
  }
  const lineAt = (idx) => src.slice(0, idx).split("\n").length;
  for (const m of src.matchAll(defRe)) defined.add(m[1]);
  for (const m of src.matchAll(propRe)) defined.add(m[1]);
  for (const m of src.matchAll(setPropRe)) defined.add(m[1]);
  for (const m of src.matchAll(objKeyRe)) defined.add(m[1]);
  for (const m of src.matchAll(keyAssignRe)) defined.add(m[1]);
  for (const m of src.matchAll(refRe)) refs.push({ token: m[1], file: rel, line: lineAt(m.index) });
}

const missing = refs.filter((r) => !defined.has(r.token));
if (missing.length === 0) {
  console.log(`check-css-tokens 通过：${refs.length} 处 var() 引用全部有定义（token ${defined.size} 个）。`);
  process.exit(0);
}
const byToken = new Map();
for (const r of missing) {
  if (!byToken.has(r.token)) byToken.set(r.token, []);
  byToken.get(r.token).push(`  ${r.file}:${r.line}`);
}
console.error(`check-css-tokens：${missing.length} 处引用了未定义 token（${byToken.size} 个）：`);
for (const [token, spots] of byToken) {
  console.error(`  ${token}`);
  for (const s of spots) console.error(s);
}
process.exit(1);
