#!/usr/bin/env node
/* 未定义 CSS 自定义属性引用门禁：扫描 src/（+ 根部 html）里全部 var(--x)
   引用，与定义处对账。定义来源四类：CSS `--x:` 声明、@property、TS 侧
   style.setProperty("--x")、TSX style 对象键 "--x":。
   引用未定义 token 会在明暗某档静默落到回退值或整条声明失效——
   --panel/--surface/--fg 三次白字白底事故（2026-09-27 审计 §1）都是这个
   模式，且平时全绿不可见。发现即非零退出；新增 token 请补定义而非回退。

   全仓对账有「定义在别窗、引用在本窗」的
   盲区——vite 多入口不共享 CSS，fullscreen.css 的 var(--ease-out) 靠 main
   入口才加载的 feature-animations.css「被定义」，全仓门禁绿、运行时整条
   animation 简写 unset（实例）。新增第二段：按 vite 入口构建
   「TS import 闭包 → CSS 文件集」，逐入口对账本窗可达性——
     - 本窗不可达且无 fallback → 硬失败（形态，整条声明失效）；
     - 本窗不可达但有 fallback → 告警（降级到回退值，速度档等派生链失效，
       如 形态），不阻断。

   index.html 一个入口在运行时按 hash /
   resolveWindowKind() 分叉成 settings / widget / quick-note 三个互不可达
   的样式加载面（main.tsx 的 windowCssReady 三元分支动态 import 窗口专属
   CSS），此前 entryClosure 把三个分支的动态 import 全部并进一个闭包——
   「定义在 A 分支、引用在 B 分支」的 token 级错位（类级错位的
   形态）在门禁全绿下漏过。现按 INDEX_WINDOW_BRANCHES 显式映射表把
   index.html 拆成三个子闭包分别对账；映射表与 main.tsx 分支一一对应，
   脚本自检「main.tsx 动态 CSS import 集 == 表格并集」（分支 CSS 增删/
   挪动时自检失败，指路回本表维护）。附带修复两处让 段实际空转的
   缺陷：① html 里 script src 是根绝对 URL（/src/main.tsx），直接 resolve
   在 Windows 上落到盘根、existsSync 恒 false，入口被静默跳过而末行仍数
   「5 个入口全部可达」；② 闭包 seen 集把 CSS 文件一并当 TS 节点收集，
   [css, ts] 拼接后 css 引用被重复对账、拆窗型时分支 CSS 经 ts 集泄回。

   归属判定口径：引用按「所在文件出现在哪些闭包」对账，而非全入口查。
   React 树在运行时按窗型分叉，静态 import 图无法判定懒 chunk 渲染在哪个
   窗——因此跨多闭包的共享文件（global.css 等）的引用对「包含它的全部
   闭包的定义并集」对账；只出现在单一闭包的文件（fullscreen.css /
   settings.css / feature-views.css 等）严格按本闭包对账。这样分支专属
   CSS 引用其他分支的定义仍会失败，而共享基础样式里「仅 widget 窗消费」
   的引用（如 global.css 的 w-item-out，消费类只在 widget 窗渲染）不误报。

   @keyframes 同口径对账——「animation:
   名字」引用的定义若在所在文件的闭包集内不可达，动画静默不播（keyframes
   名没有 fallback 概念），一律硬失败。 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

function stripComments(src, isCss) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (!isCss) {
    s = s.replace(/^[ \t]*\/\/[^\n]*$/gm, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
  }
  return s;
}

for (const file of files) {
  let src = readFileSync(file, "utf8");
  const rel = relative(root, file).replace(/\\/g, "/");
  // 剥注释再对账：注释里提到 var(--x)（如「原 var(--panel) 从未定义」的
  // 既有修法注记）不是引用；注释掉的声明也不是定义。
  src = stripComments(src, file.endsWith(".css"));
  for (const m of src.matchAll(defRe)) defined.add(m[1]);
  for (const m of src.matchAll(propRe)) defined.add(m[1]);
  for (const m of src.matchAll(setPropRe)) defined.add(m[1]);
  for (const m of src.matchAll(objKeyRe)) defined.add(m[1]);
  for (const m of src.matchAll(keyAssignRe)) defined.add(m[1]);
  for (const m of src.matchAll(refRe)) {
    // 记录该引用是否带 fallback（var(--x, val)）——入口闭包段降级用。
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
    refs.push({
      token: m[1],
      file: rel,
      line: src.slice(0, m.index).split("\n").length,
      fallback: /^\s*,/.test(after)
    });
  }
}

const missing = refs.filter((r) => !defined.has(r.token));
if (missing.length !== 0) {
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
}

/* ══ 入口闭包可达性对账 ══
   vite.config.ts 的 5 个 html 入口各自打包独立 CSS/TS 图——引用本窗闭包
   里没有的 token / keyframes 时，全仓「有定义」不代表本窗运行时有。
   构建每个入口（index.html 再按窗型细分）的「TS import 闭包 → CSS 文件
   集」，按文件归属闭包集对账。 */

/** 相对 import 的模块解析（仅仓库内相对路径；node_modules 跳过）。 */
function resolveImport(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const cands = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.css`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.tsx")
  ];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const importEdgeRe = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;

/** 收集 entry 起点的 TS/TSX 闭包与其中的 CSS 文件。
   ts 集只含脚本文件——CSS 文件只进 css 集（复查修正：此前 seen 把
   css 也一并收进 ts 集，三窗共用 full.ts 时分支 CSS 会经 ts 集泄回每个
   子闭包，拆分形同虚设；且 [css, ts] 拼接会让 css 引用被重复对账）。 */
function entryClosure(entryMain) {
  const seen = new Set([entryMain]);
  const queue = [entryMain];
  const css = new Set();
  while (queue.length > 0) {
    const f = queue.pop();
    const src = stripComments(readFileSync(f, "utf8"), false);
    for (const m of src.matchAll(importEdgeRe)) {
      const r = resolveImport(f, m[1]);
      if (!r || seen.has(r)) continue;
      seen.add(r);
      if (r.endsWith(".css")) css.add(r);
      else if (/\.(tsx?|js|mjs)$/.test(r)) queue.push(r);
    }
  }
  const ts = new Set([...seen].filter((f) => /\.(tsx?|js|mjs)$/.test(f)));
  return { ts, css };
}

/* index.html 窗型 → main.tsx windowCssReady 分支的显式映射表。
   维护口径：kind/条件描述与 main.tsx 三元分支一一对应；css 列表 = 该分支
   动态 import 的样式文件（写成 main.tsx 里的原始 specifier，脚本自检会
   校验「main.tsx 动态 CSS import 集 == 本表并集」——分支改动而不更新本表
   会直接失败，按报错指路回这里增删）。 */
const INDEX_WINDOW_BRANCHES = [
  {
    kind: "settings",
    cond: 'window.location.hash === "#/settings"',
    css: ["./styles/settings.css", "./styles/feature-views.css"] // feature-views 随设置窗加载
  },
  {
    kind: "widget",
    cond: 'resolveWindowKind() === "widget"',
    css: [
      "./styles/feature-task-complete.css",
      "./styles/feature-calendar.css",
      "./styles/feature-widget-interaction.css",
      "./styles/feature-pomodoro.css",
      "./styles/feature-analytics.css"
    ]
  },
  {
    kind: "quick-note",
    cond: "兜底分支（hash 非 #/settings 且窗型非 widget，如 #quick-note 速记窗）——无窗口专属样式",
    css: []
  }
];

const htmlEntries = readdirSync(root).filter((n) => n.endsWith(".html"));
const closures = []; // { label, css:Set(abs), ts:Set(abs) }
let indexMain = null;
for (const html of htmlEntries) {
  const src = readFileSync(join(root, html), "utf8");
  const m = /<script[^>]+src=["']([^"']+)["']/.exec(src);
  if (!m) continue;
  /* html 里的 script src 是 vite 形态的根绝对 URL（/src/main.tsx）——直接
     resolve 会被当文件系统绝对路径（Windows 上落到当前盘根 E:\src\…），
     existsSync 恒 false，入口被静默跳过（复查时发现：段在
     Windows 上从未真实跑过，末行「5 个入口全部可达」数的是跳过前的清单
     长度）。先剥前导斜杠按仓库根 join。 */
  const mainSpec = m[1].replace(/^\//, "");
  const main = join(root, mainSpec);
  if (!existsSync(main)) continue; // vite 无关的占位 html（如 fullscreen 调试用）跳过
  if (html === "index.html") {
    indexMain = main;
    continue; // index.html 按窗型拆分，见下方
  }
  const { ts, css } = entryClosure(main);
  closures.push({ label: html, ts, css });
}
if (indexMain !== null) {
  /* index.html 子闭包：共享面 = 完整闭包减去三窗分支专属 CSS
     （含全部懒 chunk 自带的组件 CSS——rb.css / feature-dock.css 等，它们
     随组件 chunk 在运行时按窗加载，静态图无法归属，按共享处理）；分支面
     = 映射表 css。TS 闭包三窗共用完整图（React 树运行时分叉，懒 chunk
     无法静态归属——TS 侧引用实际按三窗并集对账，收紧面是分支 CSS）。 */
  const full = entryClosure(indexMain);
  const branchSpecs = new Set(INDEX_WINDOW_BRANCHES.flatMap((b) => b.css));
  const mainSrc = stripComments(readFileSync(indexMain, "utf8"), false);
  const dynamicCss = new Set([...mainSrc.matchAll(/import\(\s*(["'])(\.[^"']*\.css)\1\s*\)/g)].map((m) => m[2]));
  const drift = [...dynamicCss].filter((s) => !branchSpecs.has(s));
  const stale = [...branchSpecs].filter((s) => !dynamicCss.has(s));
  if (drift.length > 0 || stale.length > 0) {
    console.error(
      `check-css-tokens[entry]: INDEX_WINDOW_BRANCHES 映射表与 main.tsx 的动态 CSS import 漂移——` +
        `main.tsx 新增了 ${JSON.stringify(drift)} / 表格残留 ${JSON.stringify(stale)}。` +
        `请同步 scripts/check-css-tokens.mjs 的 INDEX_WINDOW_BRANCHES（口径见该表头注）。`
    );
    process.exit(1);
  }
  const branchAbs = new Set();
  for (const spec of branchSpecs) {
    const abs = resolveImport(indexMain, spec);
    if (!abs) {
      console.error(`check-css-tokens[entry]: INDEX_WINDOW_BRANCHES 条目解析失败：${spec}`);
      process.exit(1);
    }
    branchAbs.add(abs);
  }
  const sharedCss = [...full.css].filter((f) => !branchAbs.has(f));
  for (const b of INDEX_WINDOW_BRANCHES) {
    closures.push({
      label: `index.html[${b.kind}]`,
      ts: full.ts,
      css: new Set([...sharedCss, ...b.css.map((s) => resolveImport(indexMain, s))])
    });
  }
}

/* 逐闭包收集 token / keyframes 定义集（闭包标签 → Set）。 */
const kfDefRe = /@keyframes\s+([\w-]+)/g;
const closureTokenDefs = new Map();
const closureKfDefs = new Map();
for (const c of closures) {
  const tdefs = new Set();
  const kdefs = new Set();
  for (const f of c.css) {
    const s = stripComments(readFileSync(f, "utf8"), true);
    for (const m of s.matchAll(defRe)) tdefs.add(m[1]);
    for (const m of s.matchAll(propRe)) tdefs.add(m[1]);
    for (const m of s.matchAll(kfDefRe)) kdefs.add(m[1]);
  }
  for (const f of c.ts) {
    const s = stripComments(readFileSync(f, "utf8"), false);
    for (const m of s.matchAll(setPropRe)) tdefs.add(m[1]);
    for (const m of s.matchAll(objKeyRe)) tdefs.add(m[1]);
    for (const m of s.matchAll(keyAssignRe)) tdefs.add(m[1]);
  }
  closureTokenDefs.set(c.label, tdefs);
  closureKfDefs.set(c.label, kdefs);
}

/* 文件（相对路径）→ 出现于哪些闭包（归属集），并集对账的查表底座。 */
const fileClosures = new Map();
const relOf = (abs) => relative(root, abs).replace(/\\/g, "/");
for (const c of closures) {
  for (const f of [...c.css, ...c.ts]) {
    const rel = relOf(f);
    if (!fileClosures.has(rel)) fileClosures.set(rel, new Set());
    fileClosures.get(rel).add(c.label);
  }
}

/* ── token 可达性对账（按文件归属闭包集的并集）── */
let hardFail = 0;
const softWarn = [];
for (const r of refs) {
  const labels = fileClosures.get(r.file);
  if (!labels) continue; // 不在任何入口闭包里的文件（孤立/仅测试用）无从判窗
  const reachable = [...labels].some((l) => closureTokenDefs.get(l).has(r.token));
  if (reachable || !defined.has(r.token)) continue; // 全局缺失第一段已拦
  const msg = `${r.file}:${r.line} var(${r.token}) —— 归属闭包 [${[...labels].join("、")}] 内不可达`;
  if (r.fallback) softWarn.push(`${msg}（带 fallback，恒吃回退值——若属动效令牌，速度档对本窗失效）`);
  else {
    console.error(`check-css-tokens[entry]: ${msg}，整条声明运行时 unset（N-6 形态）`);
    hardFail++;
  }
}

/* ── ：@keyframes 引用可达性对账 ──
   animation 简写 / animation-name 的值按「括号深度 0 的逗号与空白」切词，
   滤掉时长/缓动/方向/次数/填充/状态关键字与含括号的 var()/calc() 片段
   （静态不可解析，视作无名引用跳过），剩下的自定义标识即动画名。TS 侧
   仅字符串字面量形态（style 对象 animation: "x 1s …"）可静态解析，同口径。 */
const ANIM_KEYWORDS = new Set([
  "none",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "infinite",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "linear",
  "step-start",
  "step-end",
  "initial",
  "inherit",
  "unset",
  "revert"
]);
function animNames(value) {
  const names = [];
  let part = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (part) names.push(part);
      part = "";
    } else part += ch;
  }
  if (part) names.push(part);
  return names.filter((t) => /^[A-Za-z_][\w-]*$/.test(t) && !ANIM_KEYWORDS.has(t));
}
const kfRefs = []; // { name, file, line }
const animDeclRe = /(?<![\w-])animation(?:-name)?\s*:\s*([^;}]+)/g;
for (const file of files) {
  const isCss = file.endsWith(".css");
  const src = stripComments(readFileSync(file, "utf8"), isCss);
  for (const m of src.matchAll(animDeclRe)) {
    // TS 侧只认引号字符串字面量（style 对象值）；其余（变量、拼接）静态不可解析，跳过。
    const value = isCss ? m[1] : (/["']([^"']*)["']/.exec(m[1]) || [])[1];
    if (value === undefined) continue;
    for (const name of animNames(value)) {
      kfRefs.push({ name, file: relOf(file), line: src.slice(0, m.index).split("\n").length });
    }
  }
}
for (const r of kfRefs) {
  const labels = fileClosures.get(r.file);
  if (!labels) continue;
  const reachable = [...labels].some((l) => closureKfDefs.get(l).has(r.name));
  if (reachable) continue;
  console.error(
    `check-css-tokens[keyframes]: ${r.file}:${r.line} animation: ${r.name} —— 归属闭包 [${[...labels].join("、")}] 内无 @keyframes 定义，动画静默不播（P3-24）`
  );
  hardFail++;
}

/* ══ ：类名死代码对账 ══
   背景：时钟自绘弹层 / applauncher / 日历旧版等 ~500 行死 CSS（组件已删或
   退役）在此前 8 道样式门禁下绿灯存活多轮——既有门禁只对账 token /
   keyframes / 过渡基线，不管类名死活。口径：
   - 定义收集：全仓 CSS（排除 node_modules/dist/coverage/scripts/target/.git/
     .mimosa 与点开头目录）选择器位置的 .class 标记。CSS 内的出现一律不视为
     「消费」——CSS 不能给元素挂类，:is() 列表成员 / 复合选择器同样是样式
     书写侧；消费语料 = ts / tsx / html / rs（剥注释，防组件里「已删除」
     类名注记把死类误保活）。
   - 判死：类名 C 在语料中以完整类名出现 0 次（边界 = 相邻字符均非
     [\w-]，故 deadline-list 不会被 deadline-list-item 的使用保活），且不
     存在 C 的任意连字符前缀 P 使语料含 `P-${`（模板字符串动态构造器——
     如 BluetoothWidget 的 `bt-${layout}` 之于 .bt-ring-* 族、fx.tsx 的
     `fx-${mode}` 之于 .fx-* 族；宁可漏报不可误报）。
     ①②：构造器豁免有两个漏报面收口——
     ① 前缀遮蔽：命中构造器会静默豁免同前缀的全部类，死类混入其中不可见
       （实证：bt-${layout} 使已死的 .bt-refresh 族逃过对账）——现降级输出
       年审清单（console.warn，不阻断）；
     ② 子串无左边界：corpus.includes(`P-${`) 会命中更长标识符的尾巴
       （tm-thumb-${id} 含 b-${，会误豁免 .b-* 族）——现要求构造器首字符
       前不得是 [\w-]。
   - 取舍声明（③，不改变行为）：对账基于纯文本语料，通用词类名
     （.done / .active / .selected 等）会被 TS 侧同名标识符（const done
     = …、字段 active: …）误判为消费——与构造器豁免同为「宁可漏报不可
     误报」方向的已知取舍，此类死类靠年审清单人工核对，不在本门禁收口。
   - ALLOWLIST：确需豁免的类在此登记并写明理由；「待查」表示疑似死但
     证据不足，留待后续人工复核。 */
const CSS_CLASS_ALLOWLIST = {
  // "类名": "豁免理由（或：待查——何种疑似动态构造/外部消费）",
};

/* z-index ≥1000 的数值字面量必须走 var(--z-*)
   令牌——9000+ 梯队已全量令牌化（本轮审查机械基线越界清单为空），此规则
   防回归：新增裸值大 z-index 会静默游离在层级令牌体系外，破坏跨窗层级表。 */

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "coverage", "scripts", "target", ".git", ".mimosa"]);
const gateCssFiles = []; // 全仓 CSS（类定义 + z-index 扫描面）
const corpusFiles = []; // ts/tsx/html/rs 消费语料
(function walkRepo(dir) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRepo(p);
    else if (name.endsWith(".css")) gateCssFiles.push(p);
    else if (/\.(tsx?|html|rs)$/.test(name)) corpusFiles.push(p);
  }
})(root);

/* 类名提取：剥注释、剥 url(...) 内容（防字体/图标文件名 `xxx.woff2` 被
   `\.字母` 误捕），再匹配选择器位置的 .class 标记。 */
const classDefRe = /\.([a-zA-Z_][\w-]*)/g;
const classDefs = new Map(); // 类名 → 首个定义位置 "file:line"
const zIndexRaw = []; // { file, line, value }
const zRe = /z-index\s*:\s*(\d+)/g;
for (const f of gateCssFiles) {
  const stripped = stripComments(readFileSync(f, "utf8"), true).replace(/url\([^)]*\)/g, "url()");
  for (const m of stripped.matchAll(classDefRe)) {
    if (!classDefs.has(m[1])) {
      classDefs.set(m[1], `${relOf(f)}:${stripped.slice(0, m.index).split("\n").length}`);
    }
  }
  for (const m of stripped.matchAll(zRe)) {
    zIndexRaw.push({ file: relOf(f), line: stripped.slice(0, m.index).split("\n").length, value: parseInt(m[1], 10) });
  }
}

let corpus = "";
for (const f of corpusFiles) corpus += stripComments(readFileSync(f, "utf8"), f.endsWith(".css")) + "\n";

/** 语料中是否存在该类名的「完整类名」出现（相邻字符均非 [\w-]）。 */
function classUsedInCorpus(name) {
  return new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(corpus);
}

/** 语料中是否存在 `前缀-${` 动态构造器（返回命中的前缀，未命中返回 null）。
    ②：前缀匹配加左边界——构造器首字符前不得是 [\w-]，否则更长标识符
    的尾巴也算命中（tm-thumb-${id} 含 b-${，会误豁免 .b-* 族）。类名字符集
    [\w-] 在正则中无元字符，前缀可直接拼接；lookbehind 与上文 animDeclRe
    同一用法（Node 18+）。 */
function dynamicClassCtor(name) {
  for (let i = name.indexOf("-"); i > 0; i = name.indexOf("-", i + 1)) {
    const prefix = name.slice(0, i);
    if (new RegExp(`(?<![\\w-])${prefix}-\\$\\{`).test(corpus)) return prefix;
  }
  return null;
}

const deadClasses = [];
/* ①：仅因构造器豁免而未判死的类——前缀遮蔽的年审清单（不阻断）。 */
const ctorShadowedClasses = [];
for (const [name, spot] of classDefs) {
  if (name in CSS_CLASS_ALLOWLIST) continue;
  if (classUsedInCorpus(name)) continue;
  const ctor = dynamicClassCtor(name);
  if (ctor !== null) {
    ctorShadowedClasses.push(`${name}（定义于 ${spot}，被 \`${ctor}-\${\` 遮蔽）`);
    continue;
  }
  deadClasses.push(`${name}（定义于 ${spot}）`);
}
const zViolations = zIndexRaw.filter((z) => z.value >= 1000).map((z) => `${z.file}:${z.line} z-index:${z.value}`);

let classGateFail = false;
if (deadClasses.length > 0) {
  console.error(
    `check-css-tokens[classes]: ${deadClasses.length} 个类名在全仓 ts/tsx/html/rs 语料（含「前缀-\${」动态构造器）中 0 消费——` +
      `疑似死 CSS（Q-26a）。确认后删除，或确有外部消费/动态构造则登记 CSS_CLASS_ALLOWLIST 并写明理由：`
  );
  for (const d of deadClasses) console.error(`  ${d}`);
  classGateFail = true;
}
if (zViolations.length > 0) {
  console.error(
    `check-css-tokens[z-index]: ${zViolations.length} 处数值 z-index ≥1000 未走 var(--z-*) 令牌（Q-26b，防回归）：`
  );
  for (const z of zViolations) console.error(`  ${z}`);
  classGateFail = true;
}
/* ①：前缀遮蔽年审清单——这些类名 0 直接消费，仅因同前缀构造器被豁免
   （构造器会遮蔽同前缀的全部类，死类混入其中静态不可分）。不阻断；年审时
   逐个人工核对是否真被动态构造。 */
if (ctorShadowedClasses.length > 0) {
  console.warn(
    `check-css-tokens[classes]: ${ctorShadowedClasses.length} 个类名仅因「前缀-\${」动态构造器豁免而未判死（Q-26a 年审清单，X-20①，不阻断）：`
  );
  for (const c of ctorShadowedClasses) console.warn(`  ${c}`);
}
if (classGateFail) process.exit(1);

/* ── 汇总输出：逐闭包对账行 + 终态 ── */
console.log(
  `check-css-tokens[entry]: ${closures.length} 个入口闭包对账（index.html 拆 ${INDEX_WINDOW_BRANCHES.length} 窗型）：`
);
for (const c of closures) {
  const cssExclusive = [...c.css].filter((f) => fileClosures.get(relOf(f)).size === 1).length;
  const refCount = refs.filter((r) => fileClosures.get(r.file)?.has(c.label)).length;
  const kfCount = kfRefs.filter((r) => fileClosures.get(r.file)?.has(c.label)).length;
  console.log(
    `  ${c.label}：css ${c.css.size} 个（分支独占 ${cssExclusive}）、var() 引用 ${refCount} 处、@keyframes 引用 ${kfCount} 处`
  );
}
if (softWarn.length > 0) {
  console.warn(
    `check-css-tokens[entry]: ${softWarn.length} 处「归属闭包不可达但带 fallback」的降级引用（不阻断；多为有意兜底）：`
  );
  for (const s of softWarn) console.warn(`  ${s}`);
}
if (hardFail > 0) {
  console.error(
    `check-css-tokens[entry]: ${hardFail} 处闭包不可达的硬失败（把定义文件加入该入口加载面，或补 fallback；keyframes 则需挪定义或挪引用）`
  );
  process.exit(1);
}

console.log(
  `check-css-tokens 通过：${refs.length} 处 var() 引用全部有定义（token ${defined.size} 个）；` +
    `入口闭包对账 ${closures.length} 个（含 index.html 拆窗型）全部可达，@keyframes 引用 ${kfRefs.length} 处全部本闭包可达` +
    `${softWarn.length > 0 ? `（另有 ${softWarn.length} 处带 fallback 的降级引用已告警）` : ""}；` +
    `类名死代码对账 ${classDefs.size} 个定义全部有消费或命中动态构造器/ALLOWLIST（Q-26a）` +
    `${ctorShadowedClasses.length > 0 ? `，其中 ${ctorShadowedClasses.length} 个被构造器遮蔽已列年审清单（X-20①）` : ""}；` +
    `数值 z-index ≥1000 为 0 处（Q-26b）。`
);
