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
 * 死键模式（--dead）：词典键在 src 全部 .ts/.tsx（含测试、排除 i18n.ts 自身）
 * 的原文里完全无出现即判死。判定刻意保守——不限于 t()/tr() 调用，字符串
 * 字面量、对象/数组、甚至注释里以子串形式出现都算活，只有「全仓零出现」
 * 才删。运行时动态拼出的键（如 tr(`${n} 分钟前`)）天然零字面量出现，疑似
 * 动态或 src 之外（如导出模板）使用的键放进允许清单不报警：
 *   scripts/i18n-dead-allowlist.txt（可用 --dead-allowlist <file> 指定其他文件）。
 *
 * 用法：node scripts/check-i18n.cjs [file ...]        缺失键检查
 *       node scripts/check-i18n.cjs --dead            死键检查（可加 --dead-allowlist）
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
  /* 锚定真正的 `export const ZH_TO_EN` 声明（文件头部的文档注释里也引用了
     这段声明文本，直接全文正则会在注释处先命中，把 `export const ZH_TO_EN`
     当成键混进来）。形态契约不变：仍是 export const ZH_TO_EN + {...} + \n};。 */
  const anchor = src.indexOf("export const ZH_TO_EN");
  const start = anchor < 0 ? -1 : src.indexOf("{", anchor);
  const end = start < 0 ? -1 : src.indexOf("\n};", start);
  if (anchor < 0 || start < 0 || end < 0) {
    console.error("check-i18n: 在 src/i18n.ts 中未找到 ZH_TO_EN 映射表");
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

const argv = process.argv.slice(2);
const deadMode = argv.includes("--dead");
const allowFlagIdx = argv.indexOf("--dead-allowlist");
if (allowFlagIdx >= 0 && (allowFlagIdx + 1 >= argv.length || argv[allowFlagIdx + 1].startsWith("--"))) {
  console.error("check-i18n: --dead-allowlist 需要一个文件路径参数");
  process.exit(2);
}
const allowlistPath =
  allowFlagIdx >= 0 ? path.resolve(ROOT, argv[allowFlagIdx + 1]) : path.join(__dirname, "i18n-dead-allowlist.txt");
/* 顺手修：allowFlagIdx 为 -1 时 `i !== allowFlagIdx + 1`
 * 恒排除 argv[0]——首个位置参数（单文件核对模式）从未生效，全程退化为全量扫。 */
const argFiles = argv.filter(
  (a, i) => a !== "--dead" && a !== "--dead-allowlist" && !(allowFlagIdx >= 0 && i === allowFlagIdx + 1)
);

const defined = loadDefinedKeys();

/* ── 死键检查（--dead）────────────────────────────────────────── */
function loadAllowlist() {
  const allow = new Set();
  if (!fs.existsSync(allowlistPath)) return allow;
  for (const line of fs.readFileSync(allowlistPath, "utf8").split("\n")) {
    const s = line.replace(/\r$/, ""); // 只去 CRLF，保留键内空白（个别键带尾随空格）
    if (!s || s.startsWith("#")) continue;
    allow.add(s);
  }
  return allow;
}

function runDeadCheck() {
  // 死键活性判定包含测试文件——测试里引用（t()/tr() 或夹具字符串）也算活；
  // 与缺失检查用的 walk() 不同，这里不过滤 *.test.*。
  const all = [];
  (function walkAll(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkAll(p);
      else if (/\.(ts|tsx)$/.test(e.name) && p !== I18N) all.push(p);
    }
  })(SRC);
  const big = all.map((f) => fs.readFileSync(f, "utf8")).join("\x00"); // \x00 防跨文件拼出假命中
  const allow = loadAllowlist();
  const dead = [...defined].filter((k) => !big.includes(k) && !allow.has(k)).sort();
  console.log(
    `check-i18n --dead: 映射键 ${defined.size} 个，扫描 ${all.length} 个文件（含测试）` +
      (allow.size ? `，allowlist ${allow.size} 个` : "")
  );
  if (dead.length === 0) {
    console.log("check-i18n --dead: OK，无死键");
    process.exit(0);
  }
  console.error(`check-i18n --dead: 死键 ${dead.length} 个（词典有映射、src 全仓零出现）：`);
  for (const k of dead) console.error(`  DEAD: ${JSON.stringify(k)}  <=  src/i18n.ts`);
  process.exit(1);
}

if (deadMode) runDeadCheck();

/* ── 缺失键检查（默认模式）───────────────────────────────────── */
const files = argFiles.length ? argFiles.map((f) => path.resolve(ROOT, f)) : walk(SRC, []);

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

/* 动态键登记——tr(<非字面量>) 的实参在运行时才确定
   （数组常量 / 函数返回值 / DB 字段），字面量扫描天然漏网（问候语 4 键与
   「剩余 {n} 项」即由此漏过、门禁却全绿）。已知动态键源在此登记字面量：
   源码改名而词典未跟随时，此处会报缺失。新增动态键源时同步登记本表，
   并在源码处以注释指回此处。 */
const DYNAMIC_USED_KEYS = [
  // TodayOverviewWidget greetingByHour（tr(fn()) 按时段问候）
  "早上好",
  "中午好",
  "下午好",
  "晚上好",
  "夜深了",
  // TodayOverviewWidget WEEKDAY_CN（周标签数组）
  "周日",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  // domain/pomodoro INTERRUPTION_REASONS（tr(r.reason)，含 DB 值回显）
  "电话",
  "消息",
  "网页",
  "休息",
  "其他",
  // lib/ambience AMBIENCE_KINDS（环境音种类 label）
  "雨声",
  "咖啡厅",
  "篝火",
  "白噪",
  // settings/OnboardingOverlay STEPS（tr(body)/tr(title) 经数组常量动态消费，
  // 第三步 body 曾因此漏出词典——英文模式整段中文）
  "欢迎使用 Vela",
  "桌面效率工作台：小组件常驻桌面，专注、待办、日程一屏可见，所有数据都保存在本地。",
  "把小组件放上桌面",
  "在桌面空白处右键选择「添加小组件」进入图库，双击卡片即可添加。组件可拖动、缩放，右键能编辑与配置；顶部灵动岛随时收纳常用功能。",
  "常用快捷键",
  "{settings} 打开设置、{note} 全局速记、{palette} 呼出命令面板、{layer} 显示 / 隐藏小组件。完整列表可在快捷键速查表（{cheat}）查看。",
  "专注与通知",
  "番茄钟计时、截止与待办提醒都会进入通知中心；点击系统通知可直达对应组件。需要安静时，打开勿打扰即可静音全部提醒。"
];
for (const k of DYNAMIC_USED_KEYS) {
  used.add(k);
  if (defined.has(k)) continue;
  if (!missing.has(k)) missing.set(k, []);
  missing.get(k).push("scripts/check-i18n.cjs 动态键登记表");
}

/* ── ：i18n 盲区扫描 ──────────────────────
   a) JSX 表达式容器之间的裸中文片段：`{expr}月{expr}日` 形态。jsxTextRe
      只匹配不含花括号的纯文本节点，容器之间的裸 CJK 片段（无法原地套
      tr()，英文模式原样显示中文）此前完全不可见（实例
      TodayOverviewWidget.tsx:355 即此）。保守行级实现：剥注释后逐行把
      单行字符串/模板串内容清空（等长、行号不漂移）再匹配——字符串、
      模板、注释里的同形态一律不算，只有真正的 JSX 文本区会留下痕迹。
   b) 模板字符串中文直拼：反引号串剔除 ${...}（括号感知：插值内嵌套
      花括号/字符串不再提前截断）后仍含 CJK，且向前 30 字符内没有
      tr(/trLazy(/t( 调用（即不是翻译函数实参）→ 违规（实例
      TodayOverviewWidget.tsx:517-518 `第${n}节` ）。i18n.ts 词典
      已被 walk 排除；跨多行的模板行级配对天然跳过（保守不误伤），
      存量站点按内容锚定 ALLOWLIST 登记带理由，新增直拼直接拦。 */

/** 行级工具：把一行里的单行字符串/模板串内容清空（等长替换，引号保留）。 */
function blankLineStrings(line) {
  return line
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => '"' + " ".repeat(m.length - 2) + '"')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => "'" + " ".repeat(m.length - 2) + "'")
    .replace(/`[^`\n]*`/g, (m) => "`" + " ".repeat(m.length - 2) + "`");
}

/** 行级工具：剔除 ${...} 插值（花括号深度感知，插值内字符串中的 {} 不计深）。 */
function stripInterpolations(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "$" && line[i + 1] === "{") {
      let d = 1;
      i += 2;
      while (i < line.length && d > 0) {
        const c = line[i];
        if (c === '"' || c === "'") {
          const q = c;
          i++;
          while (i < line.length && line[i] !== q) {
            if (line[i] === "\\") i++;
            i++;
          }
          i++;
          continue;
        }
        if (c === "{") d++;
        else if (c === "}") d--;
        i++;
      }
      out += " ";
      continue;
    }
    out += line[i];
    i++;
  }
  return out;
}

/* b) 的存量登记：非界面文案 / 既有中文域内容 / 待修债，逐条带理由；行号
   漂移不影响（按文件路径 + 模板内容锚定）。新增模板直拼不在表内即拦。 */
const TPL_CJK_ALLOWLIST = [
  { re: /domain\/automation\.ts[\s\S]*?非法数字/, reason: "表达式解析器错误消息（开发者诊断，非界面文案）" },
  { re: /domain\/automation\.ts[\s\S]*?无法识别的字符/, reason: "表达式解析器错误消息（开发者诊断，非界面文案）" },
  { re: /domain\/automation\.ts[\s\S]*?缺少「/, reason: "表达式解析器错误消息（开发者诊断，非界面文案）" },
  { re: /domain\/automation\.ts[\s\S]*?意外的内容/, reason: "表达式解析器错误消息（开发者诊断，非界面文案）" },
  {
    re: /domain\/backup-validate\.ts[\s\S]*?备份文件版本/,
    reason: "存量：备份校验失败原因（恢复失败界面展示，待走 tr）"
  },
  { re: /domain\/backup-validate\.ts[\s\S]*?迁移路径/, reason: "存量：备份校验失败原因（待走 tr）" },
  { re: /domain\/backup-validate\.ts[\s\S]*?已从 v/, reason: "存量：备份迁移告警（待走 tr）" },
  { re: /domain\/backup-validate\.ts[\s\S]*?字段不是数组/, reason: "存量：备份校验失败原因（待走 tr）" },
  { re: /domain\/backup-validate\.ts[\s\S]*?存在损坏的记录/, reason: "存量：备份校验失败原因（待走 tr）" },
  { re: /domain\/backup-validate\.ts[\s\S]*?任务 \$\{/, reason: "存量：备份摘要条目（待走 tr）" },
  { re: /domain\/backup-validate\.ts[\s\S]*?专注记录 /, reason: "存量：备份摘要条目（待走 tr）" },
  { re: /domain\/backup-validate\.ts[\s\S]*?设置项 \$\{/, reason: "存量：备份摘要条目（待走 tr）" },
  { re: /domain\/backup-validate\.ts[\s\S]*?中断记录 /, reason: "存量：备份摘要条目（待走 tr）" },
  {
    re: /configs\/notification-center\.tsx[\s\S]*?提醒`/,
    reason: "存量：通知源名称后缀「提醒」（界面文案，待走 tr 模板键）"
  },
  { re: /snip\/snip-logic\.ts[\s\S]*?截图_/, reason: "截图文件名（文件系统内容，非界面文案）" },
  { re: /lib\/lunar\.ts[\s\S]*?月`/, reason: "农历日期名称本身即中文域内容（正月/十五），不参与英文翻译" },
  {
    re: /lib\/spotlight\.ts[\s\S]*?必应|lib\/spotlight\.ts[\s\S]*?百度/,
    reason: "搜索引擎品牌名（专有名词，同 JSX_TEXT_ALLOWLIST 的品牌口径）"
  },
  { re: /lib\/style-presets\.ts[\s\S]*?预设 /, reason: "存量：自动命名预设名（待走 tr）" },
  { re: /store\/habits-store\.ts[\s\S]*?远端习惯表含/, reason: "console.warn 开发诊断日志（非界面文案）" },
  { re: /widget\/timetable-extras\.ts[\s\S]*?教师: /, reason: "ICS 日历导出文件内容（导出物中文，非界面文案）" },
  {
    re: /widget\/timetable-xlsx\.ts[\s\S]*?星期|widget\/timetable-xlsx\.ts[\s\S]*?周`|widget\/timetable-xlsx\.ts[\s\S]*?第.*节|widget\/timetable-xlsx\.ts[\s\S]*?课程列表|widget\/timetable-xlsx\.ts[\s\S]*?周视图|widget\/timetable-xlsx\.ts[\s\S]*?汇总/,
    reason: "XLSX 课表导出文件内容（导出物中文，非界面文案）"
  },
  {
    re: /widget\/timetable\.ts[\s\S]*?星期\$|widget\/timetable\.ts[\s\S]*?周`/,
    reason: "存量：课表复制文本（待走 tr 模板键）"
  }
];

const blindSpotIssues = [];
let tplAllowHits = 0;
for (const f of files) {
  if (!/\.(ts|tsx)$/.test(f)) continue;
  const raw = fs.readFileSync(f, "utf8");
  const strippedLines = stripCommentsForJsxScan(raw).split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  strippedLines.forEach((line, idx) => {
    if (!/[\u4e00-\u9fff]/.test(line)) return;
    // a) 表达式容器间裸中文：字符串清空后仍留下的 }中文{ 才是 JSX 文本区
    const blanked = blankLineStrings(line);
    const fm = /\}\s*([\u4e00-\u9fff]{1,6})\s*\{/.exec(blanked);
    if (fm) {
      blindSpotIssues.push(`${rel}:${idx + 1}  JSX 表达式容器间裸中文「${fm[1]}」（无法原地翻译，改整句 tr() 模板键）`);
      return;
    }
    // b) 模板字符串中文直拼：本行成对反引号段逐段判定
    const tplRe = /`[^`\n]*`/g;
    let tm;
    while ((tm = tplRe.exec(line)) !== null) {
      const noInterp = stripInterpolations(tm[0]);
      if (!/[\u4e00-\u9fff]/.test(noInterp)) continue;
      const before = line.slice(Math.max(0, tm.index - 30), tm.index);
      if (/(?:tr|trLazy|t)\(\s*$/.test(before)) continue; // 翻译函数实参（动态键）
      const rawLine = (rawLines[idx] || "").trim();
      const ctx = rel + "\n" + rawLine;
      if (TPL_CJK_ALLOWLIST.some((a) => a.re.test(ctx))) {
        tplAllowHits++;
        continue;
      }
      blindSpotIssues.push(
        `${rel}:${idx + 1}  模板字符串中文直拼（改 tr() 模板键或并入词典）：${rawLine.slice(0, 80)}`
      );
    }
  });
}

console.log(
  `check-i18n: 映射键 ${defined.size} 个，扫描 ${files.length} 个文件，中文调用串 ${used.size} 个（含 JSX 裸文本）` +
    (tplAllowHits ? `；Q-29b 模板直拼存量登记 ${tplAllowHits} 处` : "")
);
if (missing.size === 0 && blindSpotIssues.length === 0) {
  console.log("check-i18n: OK，无缺失翻译");
  process.exit(0);
}
if (blindSpotIssues.length > 0) {
  console.error(`check-i18n: Q-29b 盲区命中 ${blindSpotIssues.length} 处（表达式容器间裸中文 / 模板直拼）：`);
  for (const s of blindSpotIssues) console.error("  " + s);
}
if (missing.size === 0) process.exit(1);
console.log(`check-i18n: 缺失翻译 ${missing.size} 个：`);
for (const key of [...missing.keys()].sort()) {
  const locs = missing.get(key);
  console.log(
    `  MISSING: ${key}  <=  ${locs.slice(0, 3).join(", ")}${locs.length > 3 ? ` (+${locs.length - 3})` : ""}`
  );
}
process.exit(1);
