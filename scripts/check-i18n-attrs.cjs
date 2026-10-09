#!/usr/bin/env node
/**
 * i18n 属性字面量守护（lint:i18n 的补充）：check-i18n.cjs 只抓 t("…")/tr("…")
 * 调用；但 SettingToggleRow/SettingRow 的 title/desc、Segmented/Dropdown 选项的
 * label、Stepper 的 suffix、settings-search 的 title 都是「传字面量、组件内部再
 * tr()」——字典缺键时英文模式直接显示中文，静态调用扫描抓不到。
 *
 * 扫描范围：src/ 下 .ts/.tsx（不含测试与 i18n.ts）中
 *   - JSX 属性 title= / desc= / label= / suffix= / placeholder= / ariaLabel= 的中文字面量
 *   - 对象字面量属性 title: / label: / suffix: / desc: / placeholder: 的中文字面量
 *   - 对象字面量属性 name: 的中文字面量——仅当所在文件存在 tr(x.name) 形态的
 *     动态翻译时才检查。Segmented（controls.tsx 的 tr(o.label)）与设置侧栏
 *     （SettingsView 的 tr(item.name)）这类「选项数组先存字面量、渲染时再 tr()」
 *     是静态调用扫描的盲区；而 name 同时也是大量原始数据字段（书签名、课表
 *     方案名、节日表等渲染时不过 tr()），无条件扫描会把这些误报成缺翻译，
 *     故用「同文件出现 tr(*.name)」作为该文件 name 字面量确属用户可见的信号。
 * 缺失则列出 key 与位置并以非零退出。
 *
 * 扫描前剥离注释（JSDoc @example 里的 `name: "上海"` 之类会误报）；注释替换
 * 为等长空白，行号不受影响。字符串里的 "//" 可能连带剥掉该行剩余内容——
 * 只可能造成漏报，不会误报。
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
  /* 锚定真正的 `export const ZH_TO_EN` 声明（与 check-i18n.cjs 同步：
     头部文档注释里引用了声明文本，全文正则会先在注释处命中）。 */
  const anchor = src.indexOf("export const ZH_TO_EN");
  const start = anchor < 0 ? -1 : src.indexOf("{", anchor);
  const end = start < 0 ? -1 : src.indexOf("\n};", start);
  if (anchor < 0 || start < 0 || end < 0) {
    console.error("check-i18n-attrs: 在 src/i18n.ts 中未找到 ZH_TO_EN 映射表");
    process.exit(2);
  }
  const body = src.slice(start + 1, end);
  const keys = new Set();
  const quoted = /^\s*"((?:[^"\\]|\\.)*)"\s*:/;
  const bare = /^\s*([^\s"'`/[{}][^:]*?)\s*:/;
  for (const line of body.split("\n")) {
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
/* 补 React DOM 惯用的连字符形态 aria-label=（此前只认
   camelCase 的 ariaLabel=，DOM 元素上的中文 aria-label 字面量完全在扫描面
   外）；对象分支同样补 ariaLabel 键。 */
const JSX_ATTR =
  /\b(title|desc|label|suffix|placeholder|ariaLabel|aria-label)=(?:"((?:[^"\\]|\\.)*)"|\{"((?:[^"\\]|\\.)*)"\})/g;
const OBJ_PROP = /\b(title|label|suffix|desc|placeholder|ariaLabel)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const NAME_PROP = /\bname\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const DYNAMIC_NAME_TR = /\btr\(\s*[\w$]+(?:\.[\w$]+)*\.name\s*\)/;
const missing = new Map();

function record(s, f, index, src) {
  if (!/[\u4e00-\u9fff]/.test(s)) return;
  if (defined.has(s)) return;
  const line = src.slice(0, index).split("\n").length;
  const loc = path.relative(ROOT, f).replace(/\\/g, "/") + ":" + line;
  if (!missing.has(s)) missing.set(s, []);
  missing.get(s).push(loc);
}

/* 注释剥成等长空白：JSDoc/行注释里的属性形态不算数，行号保持不变。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

for (const f of files) {
  const src = stripComments(fs.readFileSync(f, "utf8"));
  let mm;
  while ((mm = JSX_ATTR.exec(src))) record(mm[2] ?? mm[3], f, mm.index, src);
  while ((mm = OBJ_PROP.exec(src))) record(mm[2], f, mm.index, src);
  if (DYNAMIC_NAME_TR.test(src)) {
    while ((mm = NAME_PROP.exec(src))) record(mm[1], f, mm.index, src);
  }
}

if (missing.size === 0) {
  console.log("check-i18n-attrs: OK，属性字面量无缺失翻译");
  process.exit(0);
}
console.error(`check-i18n-attrs: 缺失翻译 ${missing.size} 个：`);
for (const [k, locs] of missing) console.error(`  MISSING: ${k}  <=  ${locs.slice(0, 3).join(", ")}`);
process.exit(1);
