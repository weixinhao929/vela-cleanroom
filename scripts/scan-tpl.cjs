// 找 t()/tr() 之外含中文的模板串（反引号）：i18n 漏网的启发式扫描（手动运行，不挂门禁）。
// 与 scan-i18n.cjs 同一套预处理：整文件剥块注释（保留换行）、逐行剥 // 注释、排除测试文件。
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
    // remove tr(`...`) / t(`...`) containing Chinese, and tr("...") embedded in `${}` interpolations
    const stripped = noComment
      .replace(/\b(?:tr|t)\(\s*`[^`]*[\u4e00-\u9fff][^`]*`\s*[,)]/g, "")
      .replace(/\b(?:tr|t)\(\s*"[^"]*"\s*[,)]/g, "");
    if (/[\u4e00-\u9fff]/.test(stripped) && /`/.test(stripped)) {
      hits++;
      console.log(f + ":" + (i + 1) + ": " + line.trim());
    }
  });
}
console.error(`scan-tpl: ${hits} 处疑似裸中文模板串（${files.length} 个文件）`);
