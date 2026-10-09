#!/usr/bin/env node
/**
 * lint:hooks —— react-hooks/exhaustive-deps 抑制必须带 `-- 理由` 注释
 *
 * 背景：全仓 70 处 exhaustive-deps 抑制中 56 处长期无理由注释——历轮实锤的
 * 族（陈旧闭包）、族（渲染闭包基底写整节切片）全部可能潜伏
 * 在「无注释抑制」里：审查者无法区分「有意缺席」与「遗漏依赖」。catch
 * 纪律先靠人工、两轮后升级为门禁，本门禁同款
 * 思路：抑制本身多数正当，但理由必须写下来。
 *
 * 扫描形态（src 下 .ts/.tsx，排除 *.test.*；注释先剥离以外的原文匹配）：
 *  - `// eslint-disable-next-line react-hooks/exhaustive-deps -- 理由`
 *  - `// eslint-disable-line react-hooks/exhaustive-deps -- 理由`
 *  - `/* eslint-disable react-hooks/exhaustive-deps -- 理由 * /`（块级）
 *  - 块注释形态的 disable-next-line/disable-line
 *  - 规则表为逗号并列列表时任一命中 exhaustive-deps 即纳入
 * 仅 react-hooks/exhaustive-deps 受检（其他规则的抑制不在本门禁范围；
 * 裸 `eslint-disable`（无规则名）由 eslint 自身管，不入扫描）。
 * `--` 之后必须还有非空文本（理由），否则违规。行注释的理由到行尾为止，
 * 块注释的理由到 `* /` 为止（可跨行）。
 */
import fs from "node:fs";
import path from "node:path";

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".mimosa" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk("src", []);

/* 说明：正则字面量本身不含控制字符，且 scripts 配置已整体关闭 no-control-regex，
   此处无需抑制指令（留着会因 flat config 的无用抑制告警挂掉 --max-warnings 0）。 */
/* 注意：-- 前后的间隔用 [ \t] 而非 \s——\s 跨换行会让无理由的抑制吞到
   后文其他行的 "--" 而误判为已带理由（本门禁首版实测踩中）。块注释分支的
   payload 用 [\s\S]*? 惰性匹配到最近的 * /（块注释不可嵌套，首个 * / 即本
   注释结尾），理由因此允许跨行。 */
/* 第九轮 EN-：正则只负责圈出「disable 指令 + 规则表 + 可选理由」的原文，
   是否受检交由下方 parseRules 按逗号列表判定——正则内联穷举 exhaustive-deps
   的位置（首位/并列）是三盲区的共同根源。 */
const re =
  /(\/\/[ \t]*eslint-disable(?:-(?:next-line|line))?[ \t]+([^\n]*)|\/\*[ \t]*eslint-disable(?:-(?:next-line|line))?[ \t]+([\s\S]*?)\*\/)/g;

/* 规则表与理由以首个 `--` 分隔（eslint 约定规则名不含 `--`，理由文本可含）；
   规则表按逗号拆分、trim 后精确匹配——任一命中 exhaustive-deps 即纳入。 */
function parseSuppression(payload) {
  const sep = payload.indexOf("--");
  const rules = (sep === -1 ? payload : payload.slice(0, sep))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { rules, reason: sep === -1 ? "" : payload.slice(sep + 2) };
}

const violations = [];
let total = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  const lines = raw.split(/\r?\n/);
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(raw)) !== null) {
    /* 捕获组：2=行注释形态的「规则表+可选理由」，3=块注释形态的同款
       （惰性匹配到 * / 为止）——别读 1（首版实测把整段匹配当理由，恒非空）。 */
    const { rules, reason } = parseSuppression((m[2] ?? m[3] ?? "").trim());
    /* 非 exhaustive-deps 的抑制与裸 eslint-disable 不在本门禁范围。 */
    if (!rules.includes("react-hooks/exhaustive-deps")) continue;
    total++;
    if (!reason.trim()) {
      const line = raw.slice(0, m.index).split(/\r?\n/).length;
      violations.push({ file: f, line, raw: (lines[line - 1] ?? "").trim() });
    }
  }
}

const rel = (f) => f.replace(/\\/g, "/");
if (violations.length === 0) {
  console.log(`[hooks] OK：${total} 处 exhaustive-deps 抑制全部带 -- 理由注释`);
  process.exit(0);
}
console.error(
  `[hooks] ${violations.length}/${total} 处 react-hooks/exhaustive-deps 抑制缺 -- 理由注释（无法区分「有意缺席」与「遗漏依赖」，历轮陈旧闭包缺陷的共同温床）：`
);
for (const v of violations) console.error(`  ${rel(v.file)}:${v.line}  ${v.raw.slice(0, 110)}`);
console.error("  修复：行尾追加 ` -- 一句话理由`（说明为什么可以窄依赖/空依赖）");
process.exit(1);
