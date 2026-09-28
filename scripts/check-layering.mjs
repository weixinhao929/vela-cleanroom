#!/usr/bin/env node
// A-1：前端分层门禁（修订版规则的自研固化）。lib 的定位按 ARCHITECTURE.md
// 修订口径是双层——基础设施工具 + 应用中介者（cross-window/theme-engine/
// notifications 等合法 import store）——门禁不追求「lib 不进 store」的旧
// 理想态，只钉住今天成立的硬边界：
//  R1 domain 纯度：src/domain/** 不得直接 import store/features/widget/
//    app/components/lib/persistence（领域层只依赖 zod 与自身）。
//  R2 持久化纯净：src/lib/persistence/** 不得 import store/features/widget/
//    app（SQLite/LocalStorage 适配器不得感知应用状态层）。
//  R3 lib 不进 features：src/lib/**（persistence 除外）不得 import
//    features/**——features 是 UI 消费方，lib 反向依赖它会让任何 features
//    重构都波及基础设施（唯一历史违例 lib/commands.ts 的设置搜索已改注入）。
//  R4 widget 不进 features/settings：小组件层为借设置页控件反向 import
//    features/settings 是目录级双向耦合的源头（A-2 已把 M3Slider/Segmented/
//    Stepper/Toggle 上移 components/ui）；features/analytics 等面板被组件
//    包装属合法组合（widget 渲染 feature 面板），不在此列。
// 违例即非零退出；新增合法例外须在本文件 ALLOW 显式登记并写明理由。
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");
const IMP_RE =
  /(?:import|export)[^"']*from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

/** 已知且接受的例外（规则号 → 说明），新条目必须附理由。 */
const ALLOW = new Map([
  // R2：local-storage 的落盘失败提示复用 ToastHost 的模块级队列（队列本来
  // 就不在组件树里）；拆出去收益低于扰动，登记在案。
  [
    "src/lib/persistence/local-storage.ts -> ../../components/ToastHost",
    "R2: 落盘失败提示复用 toast 队列（见 ARCHITECTURE.md 分层注）"
  ]
]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\./.test(ent.name)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(SRC, p).replace(/\\/g, "/");
/** 把相对导入解析成从 src 起算的规范路径（不支持别名的直白工程足够）。 */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare specifier（三方包）
  const target = path.resolve(path.dirname(fromFile), spec);
  return path.relative(SRC, target).replace(/\\/g, "/");
}

function ruleOf(fromRel) {
  if (fromRel.startsWith("domain/"))
    return { id: "R1", bans: ["store/", "features/", "widget/", "app/", "components/", "lib/persistence/"] };
  if (fromRel.startsWith("lib/persistence/")) return { id: "R2", bans: ["store/", "features/", "widget/", "app/"] };
  if (fromRel.startsWith("lib/")) return { id: "R3", bans: ["features/"] };
  if (fromRel.startsWith("widget/")) return { id: "R4", bans: ["features/settings/"] };
  return null;
}

const violations = [];
for (const f of walk(SRC)) {
  const fromRel = rel(f);
  const rule = ruleOf(fromRel);
  if (!rule) continue;
  const src = fs.readFileSync(f, "utf8");
  let m;
  IMP_RE.lastIndex = 0;
  while ((m = IMP_RE.exec(src)) !== null) {
    const spec = m[1] || m[2] || m[3];
    const target = resolveImport(f, spec);
    if (!target) continue;
    const hit = rule.bans.find((b) => target === b.slice(0, -1) || target.startsWith(b));
    if (!hit) continue;
    const key = `${fromRel} -> ${spec}`;
    if (ALLOW.has(key)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    violations.push(`  [${rule.id}] ${fromRel}:${line}  ->  ${target}`);
  }
}

if (violations.length > 0) {
  console.error("check-layering: 分层违例（规则见 scripts/check-layering.mjs 头注）：");
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("check-layering: 通过（domain 纯度 / persistence 纯净 / lib 不进 features / widget 不进 settings）");
