// 找 t()/tr() 之外的裸中文（双引号串）：i18n 漏网的启发式扫描（手动运行，不挂门禁）。
// 只看代码：整文件先剥块注释（保留换行以维持行号），再逐行剥 // 行注释（不剥
// 协议串里的 "://"），排除测试文件——此前不剥块注释、不排测试，输出上万行全是误报。
const fs = require("fs");
const path = require("path");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "test") walk(p, out);
    } else if (/\.(tsx|ts)$/.test(e.name) && e.name !== "i18n.ts" && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}
/** 剥块注释但保留其中的换行，行号不漂移。 */
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
}
const files = walk("src");
let hits = 0;
for (const f of files) {
  const src = stripBlockComments(fs.readFileSync(f, "utf8"));
  // 按 \r?\n 切行：CRLF 文件行尾残留的 \r 会让下面的 `.*$` 永远失配（原脚本误报主因之一）。
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/[\u4e00-\u9fff]/.test(line)) return;
    const noComment = line.replace(/(^|[^:])\/\/.*$/, "$1");
    if (!/[\u4e00-\u9fff]/.test(noComment)) return;
    // remove tr("...") and t("...") patterns containing Chinese
    const stripped = noComment.replace(/\b(?:tr|t)\(\s*"[^"]*[\u4e00-\u9fff][^"]*"\s*[,)]/g, "");
    if (/[\u4e00-\u9fff]/.test(stripped)) {
      hits++;
      console.log(f + ":" + (i + 1) + ": " + line.trim());
    }
  });
}
console.error(`scan-i18n: ${hits} 处疑似裸中文（${files.length} 个文件）`);
