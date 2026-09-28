#!/usr/bin/env node
/**
 * i18n 守护（npm run lint:i18n）：扫描 src/ 下所有 t("…") / tr("…") 调用里的中文串，
 * 核对 src/i18n.ts 的 ZH_TO_EN 映射是否都有对应键；有缺失则列出 file:line 并以非零退出。
 *
 * - 映射键既可能带引号（"导入 / 导出": "…"）也可能不带（常规: "…"）：Prettier 的
 *   quoteProps: as-needed 只在必要时保留引号，两种写法都要识别。
 * - 只匹配独立标识符 t / tr（\b 边界），避免 it("…") / wait("…") / split("…") 误判。
 * - 跳过 *.test.ts(x) 与 i18n.ts 本身。
 * - 小组件注册表（src/widget/registry.tsx）的 name / desc 在运行时经 tr(meta.name) 动态
 *   翻译，静态 t("…") 扫描抓不到，这里单独把这两个字段的字面量当作已用键。
 *
 * 用法：node scripts/check-i18n.cjs [file ...]
 *   不传参数扫描整个 src/；传文件路径（相对仓库根）则只检查这些文件。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const I18N = path.join(SRC, "i18n.ts");
const REGISTRY = path.join(SRC, "widget", "registry.tsx");

function loadDefinedKeys() {
  const src = fs.readFileSync(I18N, "utf8");
  const m = src.match(/const ZH_TO_EN: Record<string, string> = \{([\s\S]*?)\n\};/);
  if (!m) {
    console.error("check-i18n: 在 src/i18n.ts 中未找到 ZH_TO_EN 映射表");
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

const argFiles = process.argv.slice(2);
const files = argFiles.length ? argFiles.map((f) => path.resolve(ROOT, f)) : walk(SRC, []);
const defined = loadDefinedKeys();

const callRe = /\b(?:tr|t)\(\s*"((?:[^"\\]|\\.)*)"/g;
const used = new Set();
const missing = new Map(); // key -> [file:line]

function record(s, f, index, src) {
  if (!/[\u4e00-\u9fff]/.test(s)) return;
  used.add(s);
  if (defined.has(s)) return;
  const line = src.slice(0, index).split("\n").length;
  const loc = path.relative(ROOT, f).replace(/\\/g, "/") + ":" + line;
  if (!missing.has(s)) missing.set(s, []);
  missing.get(s).push(loc);
}

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let mm;
  while ((mm = callRe.exec(src))) record(mm[1], f, mm.index, src);
}

/* JSX 裸文本节点扫描：>中文< 形态。此前只扫 t()/tr() 调用，不走翻译函数
   的裸文案会整体漏检（2026-09 通知中心配置页在英文模式整段中文就是这么漏的）。
   - 只查「纯文本节点」（不含 {} 表达式与引号），含表达式的节点留待人工；
   - 扫描前剥离注释（块注释 + 行注释）。行注释剥到行尾，字符串里的 // 会
     连带剥掉该行剩余内容——只可能造成漏报，不会误报；
   - 白名单：有意保留中文、不参与翻译的文本（品牌 / 署名）。 */
const JSX_TEXT_ALLOWLIST = new Set(["浩浩浩"]);
const jsxTextRe = />\s*([^<>{}"'`\n]*[\u4e00-\u9fff][^<>{}"'`\n]*?)\s*</g;

function stripCommentsForJsxScan(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

for (const f of files) {
  if (!f.endsWith(".tsx")) continue;
  const src = fs.readFileSync(f, "utf8");
  const stripped = stripCommentsForJsxScan(src);
  let mm;
  while ((mm = jsxTextRe.exec(stripped))) {
    const text = mm[1].trim();
    if (!text || JSX_TEXT_ALLOWLIST.has(text)) continue;
    // 文本必须作为整键存在于词典（节点内多段空格折叠后比对）。
    record(text.replace(/\s+/g, " "), f, mm.index, src);
  }
}

// 注册表 name / desc：仅全量扫描时检查（传文件参数属局部核对，不混入）。
if (!argFiles.length && fs.existsSync(REGISTRY)) {
  const src = fs.readFileSync(REGISTRY, "utf8");
  const metaRe = /^\s*(?:name|desc):\s*"((?:[^"\\]|\\.)*)"/gm;
  let mm;
  while ((mm = metaRe.exec(src))) record(mm[1], REGISTRY, mm.index, src);
}

console.log(
  `check-i18n: 映射键 ${defined.size} 个，扫描 ${files.length} 个文件，中文调用串 ${used.size} 个（含 JSX 裸文本）`
);
if (missing.size === 0) {
  console.log("check-i18n: OK，无缺失翻译");
  process.exit(0);
}
console.log(`check-i18n: 缺失翻译 ${missing.size} 个：`);
for (const key of [...missing.keys()].sort()) {
  const locs = missing.get(key);
  console.log(
    `  MISSING: ${key}  <=  ${locs.slice(0, 3).join(", ")}${locs.length > 3 ? ` (+${locs.length - 3})` : ""}`
  );
}
process.exit(1);
