// 审计 will-change 使用方向：禁止「常驻」 will-change。
//
// will-change 会让 WebView2 为元素长期保留合成层（显存/内存开销），
// 正确用法只有两种：
//   1. 交互作用域内：选择器带 :hover / :focus / :focus-within / :active，
//      浏览器只在交互期间提升合成层（如 .widget-note:hover）；
//   2. 持续动画：元素有 infinite 动画（如 36s 旋转的刻度环），
//      必须在声明同一行或紧邻上方两行内注释 `keep-will-change: <原因>` 显式豁免。
//
// 其余常驻声明一律视为违规，CI 以非零退出码拦截。
// 历史教训：本仓库曾用相反方向的脚本（给基础规则"补" will-change），
// 导致 54 处常驻声明，26 个桌面小组件常年占用合成层。
import fs from "node:fs";
import path from "node:path";

/** 递归收集 src/**\/*.css——修复目录逃逸盲区：此前只平铺扫 src/styles，
 *  src/components、src/features 等目录的 .css（wake-slider / super-panel /
 *  snip / fullscreen）完全不受本审计约束。 */
function walkCss(dirPath, out = []) {
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkCss(p, out);
    else if (ent.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const files = walkCss("src");

function parseRules(css) {
  const rules = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    const body = m[2].trim();
    if (selector && body) rules.push({ selector, body });
  }
  return rules;
}

/**
 * 在原文中定位「以该选择器开头的规则块」里 will-change 声明所在行（0 基）。
 * 旧实现要求选择器与声明在**同一行**（findIndex 同时 includes 两者），多行规则
 * 必得 -1 → 豁免注释永远找不到（假违规）；重复选择器时又可能吃到别处的豁免。
 * 这里按块定位：逐个选择器出现位置 → 其 `{…}` 块 → 块内首个 will-change。
 */
function locateDeclarationLine(raw, selector) {
  let from = 0;
  for (;;) {
    const s = raw.indexOf(selector, from);
    if (s < 0) return -1;
    const open = raw.indexOf("{", s + selector.length);
    const close = open < 0 ? -1 : raw.indexOf("}", open);
    if (open < 0 || close < 0) return -1;
    const wc = raw.indexOf("will-change", open);
    if (wc >= 0 && wc < close) return raw.slice(0, wc).split("\n").length - 1;
    from = s + selector.length;
  }
}

let violations = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  // 保留原始行用于 keep-will-change 行内注释豁免。
  const lines = raw.split("\n");
  const rules = parseRules(raw);
  for (const r of rules) {
    if (!/will-change\s*:/.test(r.body)) continue;
    // 交互作用域（hover/focus/active）是正确用法。
    if (/:hover|:focus|:focus-within|:active/.test(r.selector)) continue;
    // 定位声明行，检查同一行或紧邻上方两行内的豁免注释。
    const idx = locateDeclarationLine(raw, r.selector);
    const window = idx >= 0 ? lines.slice(Math.max(0, idx - 2), idx + 1) : [];
    if (window.some((l) => /keep-will-change/.test(l))) continue;
    // @keyframes 块不会出现 will-change；其余视为常驻违规。
    const where = idx >= 0 ? `:${idx + 1}` : "";
    console.log(`${file}${where}: ${r.selector} -> 常驻 ${r.body.match(/will-change\s*:[^;]+/)[0].trim()}（违规）`);
    violations++;
  }
}

if (violations > 0) {
  console.error(
    `\n发现 ${violations} 处常驻 will-change。要么删除，要么交互作用域化，要么加 keep-will-change 注释豁免。`
  );
  process.exit(1);
}
console.log("will-change 审计通过：无常驻声明。");
