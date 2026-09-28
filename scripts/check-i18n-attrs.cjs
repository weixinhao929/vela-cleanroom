#!/usr/bin/env node
/**
 * i18n 属性字面量守护（lint:i18n 的补充）：check-i18n.cjs 只抓 t("…")/tr("…")
 * 调用；但 SettingToggleRow/SettingRow 的 title/desc、Segmented/Dropdown 选项的
 * label、Stepper 的 suffix、settings-search 的 title 都是「传字面量、组件内部再
 * tr()」——字典缺键时英文模式直接显示中文，静态调用扫描抓不到。
 *
 * 扫描范围：src/ 下 .ts/.tsx（不含测试与 i18n.ts）中
 *   - JSX 属性 title= / desc= / label= / suffix= / placeholder= / ariaLabel= 的中文字面量
 *   - 对象字面量属性 title: / label: / suffix: / desc: 的中文字面量
 * 缺失则列出 key 与位置并以非零退出。
 *
 * 用法：node scripts/check-i18n-attrs.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const I18N = path.join(SRC, "i18n.ts");

function loadDefinedKeys() {
  const src = fs.readFileSync(I18N, "utf8");
  const m = src.match(/const ZH_TO_EN: Record<string, string> = \{([\s\S]*?)\n\};/);
  if (!m) {
    console.error("check-i18n-attrs: 在 src/i18n.ts 中未找到 ZH_TO_EN 映射表");
    process.exit(2);
  }
  const keys = new Set();
  const quoted = /^\s*"((?:[^"\\]|\\.)*)"\s*:/;
  const bare = /^\s*([^\s"'`/[{}][^:]*?)\s*:/;
  for (const line of m[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    const q = quoted.exec(line);
    if (q) {
      keys.add(q[1]);
      continue;
    }
    const b = bare.exec(line);
    if (b) keys.add(b[1]);
  }
  return keys;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && p !== I18N) out.push(p);
  }
  return out;
}

const defined = loadDefinedKeys();
const files = walk(SRC, []);
const JSX_ATTR = /\b(title|desc|label|suffix|placeholder|ariaLabel)=(?:"((?:[^"\\]|\\.)*)"|\{"((?:[^"\\]|\\.)*)"\})/g;
const OBJ_PROP = /\b(title|label|suffix|desc)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const missing = new Map();

function record(s, f, index, src) {
  if (!/[\u4e00-\u9fff]/.test(s)) return;
  if (defined.has(s)) return;
  const line = src.slice(0, index).split("\n").length;
  const loc = path.relative(ROOT, f).replace(/\\/g, "/") + ":" + line;
  if (!missing.has(s)) missing.set(s, []);
  missing.get(s).push(loc);
}

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let mm;
  while ((mm = JSX_ATTR.exec(src))) record(mm[2] ?? mm[3], f, mm.index, src);
  while ((mm = OBJ_PROP.exec(src))) record(mm[2], f, mm.index, src);
}

if (missing.size === 0) {
  console.log("check-i18n-attrs: OK，属性字面量无缺失翻译");
  process.exit(0);
}
console.error(`check-i18n-attrs: 缺失翻译 ${missing.size} 个：`);
for (const [k, locs] of missing) console.error(`  MISSING: ${k}  <=  ${locs.slice(0, 3).join(", ")}`);
process.exit(1);
