// JS 侧动效健康度门禁（2026-09-27 新增，补 CSS-only 文本扫描的盲区）：
//   1. [阻断] motion 弹簧豁免：import "motion"/"framer-motion" 的文件必须带
//      「spring: ok <理由>」行内豁免——motion 的 stiffness/damping 物理弹簧
//      不消费 --dur-*/--ease-* token，速度三档对它无效，属体系外动效，
//      必须显式声明豁免理由才允许存在。
//   2. [告警] rAF 自调度循环健康度：自调度循环（回调里再次 rAF 引用自身）
//      体内应出现 prefersReducedMotion / document.hidden / visibilitychange
//      任一健康信号（C11 实时性），或行内「raf: ok <理由>」豁免（计时数据、
//      一次性 FLIP 等非动画循环）。启发式有误报可能，故为告警级不阻断。
import fs from "node:fs";
import path from "node:path";

function walkSrc(dirPath, out = []) {
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkSrc(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const files = walkSrc("src");

/* ═══ 1. motion 弹簧豁免（阻断级）═══ */
{
  const offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    if (!/from\s+["'](motion|framer-motion)(\/[\w-]+)?["']/.test(raw)) continue;
    if (/spring:\s*ok\b/.test(raw)) continue;
    offenders.push(`  ${path.relative("src", f).replace(/\\/g, "/")}`);
  }
  if (offenders.length > 0) {
    console.error(
      "[motion-spring] 以下文件引入 motion/framer-motion（物理弹簧不消费 --dur-*/--ease-* token，速度档无效），需在文件内加「spring: ok <理由>」豁免注记或改用 token 体系："
    );
    console.error(offenders.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[motion-spring] motion 引入面检查通过（豁免注记齐备，bundle 隔离不受影响）。");
  }
}

/* ═══ 2. rAF 自调度循环健康度（告警级启发式）═══ */
/* 提取「顶层函数声明 + 后续配平大括号」的函数体文本。 */
function extractBody(lines, startIdx) {
  const open = lines[startIdx].indexOf("{");
  if (open === -1) return null;
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (let j = i === startIdx ? open : 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === "{" || ch === "(") {
        depth++;
        started = true;
      } else if (ch === "}" || ch === ")") {
        depth--;
        if (started && depth === 0) return lines.slice(startIdx, i + 1).join("\n");
      }
    }
  }
  return null;
}

const HEALTHY_RE = /prefersReducedMotion|document\.hidden|visibilitychange/;

/* rAF 参数段扫描：从每个 requestAnimationFrame( 起做括号配平，段内出现 name
   即视为自调度（直传函数名或箭头回指）。 */
function rafArgMentions(body, name) {
  const re = /requestAnimationFrame\s*\(\s*/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < body.length && i - m.index < 4000; i++) {
      const ch = body[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
      if (body.startsWith(name, i)) return true;
    }
  }
  return false;
}

const warnings = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const rel = path.relative("src", f).replace(/\\/g, "/");
  // 候选循环函数：`function NAME(` 或 `const NAME = (`
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?function\s+(\w+)\s*\(|^\s*const\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/.exec(lines[i]);
    const name = m?.[1] ?? m?.[2];
    if (!name) continue;
    // 快速预筛：函数声明到下一个顶层声明之间出现过 rAF 才展开大括号配平。
    const body = extractBody(lines, i);
    if (!body || !body.includes("requestAnimationFrame(")) continue;
    // 自调度：rAF 参数段（括号配平范围内）出现本函数名——直传（rAF(loop)）
    // 或箭头回指（rAF((t) => loop(t))）都命中；组件体内嵌套他人循环不误报。
    if (!rafArgMentions(body, name)) continue;
    // 豁免：函数体或其上方 3 行内「raf: ok <理由>」。
    let allowed = /raf:\s*ok\b/.test(body);
    for (let back = 1; back <= 3 && !allowed && i - back >= 0; back++) allowed = /raf:\s*ok\b/.test(lines[i - back]);
    if (allowed) continue;
    if (HEALTHY_RE.test(body)) continue;
    warnings.push(`  ${rel}:${i + 1} ${name}() 自调度 rAF 循环体内无 reduce-motion/hidden 健康信号`);
  }
}
if (warnings.length > 0) {
  console.warn(
    `[raf-health] ${warnings.length} 处自调度 rAF 循环缺健康信号（告警级；确属计时数据/一次性循环请加「raf: ok <理由>」行内豁免）：`
  );
  console.warn(warnings.join("\n"));
} else {
  console.log("[raf-health] rAF 自调度循环健康度检查通过。");
}
