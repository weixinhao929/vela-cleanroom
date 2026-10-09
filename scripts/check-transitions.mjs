// Scans CSS files for hover/active/focus rules that change transform/filter/opacity/
// scale/translate but whose base selector lacks a transition covering those properties.
import fs from "node:fs";
import path from "node:path";

/** 递归收集 src/**\/*.css——修复目录逃逸盲区：此前只平铺扫 src/styles，
 *  src/components、src/features 等目录的 .css（wake-slider / super-panel /
 *  snip / fullscreen）不受 hover 门禁、anim-token 与 ease-contract 约束。 */
function walkCss(dirPath, out = []) {
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkCss(p, out);
    else if (ent.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const files = walkCss("src");

// Parse a CSS file into rules: { selector, body }
function parseRules(css) {
  const rules = [];
  // Strip comments
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    const body = m[2].trim();
    if (selector && body) rules.push({ selector, body });
  }
  return rules;
}

const PROP_MAP = {
  transform: ["transform"],
  scale: ["scale"],
  translate: ["translate"],
  filter: ["filter"],
  opacity: ["opacity"]
};

// 交互态改颜色类属性而基类无对应过渡 → 告警级（不阻断）：颜色瞬跳是手感
// 瑕疵不是性能问题，存量较多，先可见再渐进归一（2026-09 通知中心/书签
// 分组头等 7 处 hover 瞬跳就是这么漏的——PROP_MAP 不含颜色属性，门禁
// 对这类缺口全盲）。background 简写同样改变背景色，一并检测。
const COLOR_PROPS = ["background-color", "background", "color", "border-color", "box-shadow"];
// COLOR_RE 从未消费（行 190 内联构造同款正则）——删死代码。

// 四.1 状态类交互态：类/属性切换（.active/.on/.selected/.lit/.open/.checked/
// .expanded 及 .is-* 变体）与 :hover/:active/:focus 同属「瞬时状态变化」，
// 此前颜色瞬跳检测只认伪类，类切换的缺口（2026-09 复扫 10 处：设置侧栏选中、
// 计算器记忆指示、日历选中格等——共性是「过渡在父级、变化在子元素」或基类
// 完全没过渡）持续积累。(?![\\w-]) 防止 .active 匹配到 .active-item 这类
// BEM 修饰名；transform/布局维度的检查维持伪类范围不变（只扩颜色段）。
const STATE_CLASS_RE = /\.(?:is-)?(?:active|on|selected|lit|open|checked|expanded)(?![\w-])/;

/** 剥掉单冒号伪类（:hover/:active/:nth-child(2)…），保留伪元素（::after/::-webkit-*）。
 *  迭代到不动点：单趟正则的前一个匹配会吞掉 [^:] 前导字符，链式伪类
 *  （`.x:disabled:hover`）的第二个伪类会因前导是 ':' 而漏剥——实测导致
 *  :disabled:hover 的基类候选带上 :hover、永远匹配不到已注册的过渡。 */
function stripPseudoClasses(sel) {
  let cur = sel.replace(/:not\([^)]*\)/g, "").replace(/:has\([^)]*\)/g, "");
  for (;;) {
    const prev = cur;
    cur = cur.replace(/(^|[^:]):[\w-]+(\([^)]*\))?/g, "$1");
    if (cur === prev) return cur.trim();
  }
}

/**
 * 交互态选择器 → 可能声明过渡的基选择器候选，按特异度从高到低：
 *   1. 整串剥伪类（`.widget-notes-input button`）；
 *   2. 最后一个复合选择器（`button` / `.calc-key.eq` / `.tm-section::after`）；
 *   3. 复合拆成的单个简单选择器（`.calc-key`、`.eq`，伪元素随身携带）。
 * 过渡必须声明在「真正被改样式的元素」上：`.a:hover .b` 变化的是 .b，
 * 所以候选始终围绕最后一个复合选择器；`.tm-section:hover::after` 变化的是
 * ::after 伪元素，过渡也只能声明在 `.tm-section::after` 上，故伪元素不剥。
 */
function baseCandidates(sel) {
  const full = stripPseudoClasses(sel);
  const parts = full.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || full;
  const out = [full];
  if (last !== full) out.push(last);
  const pe = (last.match(/::[\w-]+$/) || [""])[0];
  const core = pe ? last.slice(0, -pe.length) : last;
  const simples = core.match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*/g) || [];
  if (simples.length > 1) for (const s of simples) out.push(s + pe);
  return [...new Set(out.filter(Boolean))];
}

/** 过渡规则的选择器 key 是否覆盖候选 cand：相等，或以 cand 结尾且前面是组合符/复合边界。 */
function keyCovers(key, cand) {
  if (key === cand) return true;
  if (!key.endsWith(cand)) return false;
  const prev = key[key.length - cand.length - 1];
  // `.x`/`#x`/`[x]`/`::x` 可紧贴前一个简单选择器组成复合（button.gal-del）；
  // 标签名候选（button）前面必须是组合符，否则 `.foo-button` 会串上。
  if (/[.#[:]/.test(cand[0])) return true;
  return /[\s>+~]/.test(prev);
}

/** 逗号分隔的选择器列表拆成单个选择器。 */
function splitSelectorList(sel) {
  return sel
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 按顶层逗号切分（忽略 `var(--a, b)` / `cubic-bezier(…)` 括号内的逗号）。 */
function splitTopLevelCommas(val) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of val) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function transitionProps(body) {
  // find transition / transition-property declarations
  const m = body.match(/transition(?:-property)?\s*:\s*([^;]+)/);
  if (!m) return null;
  const val = m[1].trim();
  if (val === "all") return ["all"];
  // first token of each comma-separated entry is the property (or list)
  return splitTopLevelCommas(val).map((s) => s.trim().split(/\s+/)[0]);
}

const issues = [];
// 颜色类 hover 瞬跳告警集（非阻断；见 PROP_MAP 后的 COLOR_PROPS 注释）。
const colorWarnings = [];
// E-审计补充：layout 属性动画告警集。这些属性的过渡/关键帧动画每帧触发
// layout+paint（transform/opacity 只合成），在常驻桌面场景是耗电主源。
const LAYOUT_PROPS = ["width", "height", "top", "left", "right", "bottom", "margin", "padding"];
const LAYOUT_RE = new RegExp(`(^|;|\\s)(${LAYOUT_PROPS.join("|")})\\s*:`);
const layoutWarnings = [];

// CSS 级联是全局的：`.x { transition }` 常定义在 feature-*.css，而 `.x:hover`
// 写在 feature-animations.css / feature-fx.css。先跨全部文件收集过渡规则表，
// 再逐文件校验交互态，否则跨文件的合法组合会被误报为"无过渡"。
const parsedFiles = files.map((file) => {
  const css = fs.readFileSync(file, "utf8");
  // E-审计修复：@media prelude 被当作 selector 解析、其内部规则与外层交错。
  // 这里把 @media 块体提取出来单独解析，prelude 不再污染规则表。
  const rules = [...parseRules(stripAtBlocks(css, "media")), ...collectMediaInnerRules(css)];
  return { file, css, rules };
});
const baseTransitions = new Map();
for (const { rules } of parsedFiles) {
  for (const r of rules) {
    if (/transition/.test(r.body)) {
      const props = transitionProps(r.body);
      // 选择器列表 `.a, .b { transition }` 逐个登记，避免 `.b` 因整串 key 匹配失败被误判无过渡。
      if (props) {
        for (const s of splitSelectorList(r.selector)) {
          const prev = baseTransitions.get(s);
          baseTransitions.set(s, prev ? [...new Set([...prev, ...props])] : props);
        }
      }
    }
  }
}

for (const { file, css, rules } of parsedFiles) {
  // E-审计修复：@keyframes 内部帧此前完全不扫描——布局属性藏在百分比帧里静默过审。
  const keyframesIssues = scanKeyframes(css, file);
  layoutWarnings.push(...keyframesIssues);
  for (const r of rules) {
    // 四.1：颜色瞬跳段扩到状态类；transform 覆盖（changed/issues）与布局
    // 告警仍限伪类交互态（isInteract），避免状态类规则涌入产生新噪声。
    const isInteract = /:(hover|active|focus)/.test(r.selector);
    const isState = STATE_CLASS_RE.test(r.selector);
    if (!isInteract && !isState) continue;
    // which animated props does this rule change?
    const changed = [];
    for (const [prop, keys] of Object.entries(PROP_MAP)) {
      if (keys.some((k) => new RegExp(`(^|;|\\s)${k}\\s*:`).test(r.body))) changed.push(prop);
    }
    // 颜色类变化：基类无对应过渡 → 告警（候选机制与阻断集共用）。
    const colorChanged = COLOR_PROPS.filter((k) => new RegExp(`(^|;|\\s)${k}\\s*:`).test(r.body));
    if (colorChanged.length > 0) {
      for (const single of splitSelectorList(r.selector)) {
        if (!isInteract && !STATE_CLASS_RE.test(single)) continue;
        const cands = baseCandidates(single);
        let covered = false;
        for (const cand of cands) {
          const props = new Set();
          for (const [sel, p] of baseTransitions) if (keyCovers(sel, cand)) p.forEach((x) => props.add(x));
          if (props.size === 0) continue;
          if (
            props.has("all") ||
            colorChanged.every((c) => [...props].some((p) => p === c || c.startsWith(p) || p.startsWith(c)))
          ) {
            covered = true;
            break;
          }
        }
        if (!covered)
          colorWarnings.push(`${file}: ${single} 改 ${colorChanged.join(",")} 而基类无颜色过渡（hover 瞬跳）`);
      }
    }
    // layout 属性出现在交互态里：无论是否声明 transition 都值得告警（四.1：仍限伪类交互态）
    if (isInteract && LAYOUT_RE.test(r.body)) {
      layoutWarnings.push(
        `${file}: layout-prop animation in "${r.selector}" (${(r.body.match(LAYOUT_RE) || [])[2] || "?"})`
      );
    }
    if (changed.length === 0) continue;
    // 列表里只有含交互伪类的那些选择器才需要校验；每个各自取目标元素。
    for (const single of splitSelectorList(r.selector)) {
      if (!/:(hover|active|focus)/.test(single)) continue;
      const cands = baseCandidates(single);
      if (cands.length === 0) continue;
      // 同一元素可被多条规则命中，过渡属性取并集；候选按特异度从高到低，
      // 命中最特异的一档即止，避免 `button` 这类泛型候选串到别的作用域。
      let found = null;
      let matched = null;
      for (const cand of cands) {
        const props = new Set();
        for (const [sel, p] of baseTransitions) if (keyCovers(sel, cand)) p.forEach((x) => props.add(x));
        if (props.size > 0) {
          found = [...props];
          matched = cand;
          break;
        }
      }
      if (!found) {
        issues.push(`${file}: ${single} -> base "${cands[cands.length - 1]}" has NO transition`);
        continue;
      }
      const missing = changed.filter((c) => !(found.includes("all") || found.includes(c)));
      if (missing.length) {
        issues.push(
          `${file}: ${single} -> base "${matched}" transition missing [${missing.join(",")}] (has: ${found.join(",")})`
        );
      }
    }
  }
}

/** 去掉顶层 @<name> 块（含嵌套花括号）。 */
function stripAtBlocks(css, name) {
  let out = css;
  const re = new RegExp(`@${name}[^{]*\\{`, "g");
  let m;
  while ((m = re.exec(out)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < out.length && depth > 0) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
      i++;
    }
    out = out.slice(0, m.index) + out.slice(i);
    re.lastIndex = m.index;
  }
  return out;
}

/** 收集所有 @media 块内部的规则（prelude 不进规则表）。 */
function collectMediaInnerRules(css) {
  const rules = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    rules.push(...parseRules(css.slice(start, i - 1)));
  }
  return rules;
}

/** 扫描 @keyframes 各帧：布局属性动画逐条告警。 */
function scanKeyframes(css, file) {
  const warnings = [];
  const re = /@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(start, i - 1);
    if (LAYOUT_RE.test(body)) {
      warnings.push(
        `${file}: @keyframes ${m[1]} animates layout properties (${LAYOUT_PROPS.filter((p) => body.includes(`${p}:`)).join(",")})`
      );
    }
  }
  return warnings;
}

if (issues.length === 0) {
  console.log("No issues found.");
} else {
  console.log(issues.join("\n"));
  // 门禁本体：hover/active/focus 改 transform/opacity 等却缺对应 transition 是违规，
  // 缺失即非零退出。此前只打印、恒 exit 0（全文件仅 ease-contract 分支能置 1），
  // ARCHITECTURE 宣称的这道门禁被结构性绕过。
  process.exitCode = 1;
}
if (layoutWarnings.length > 0) {
  // 布局属性动画是告警级（不阻断 CI）：存量改造量大，新增项应自查。
  // 完整分层清单见 scripts/check-layout-anim.mjs（npm run lint:layout-anim）。
  console.warn(`[layout-anim] ${layoutWarnings.length} warning(s):`);
  console.warn(layoutWarnings.join("\n"));
}
if (colorWarnings.length > 0) {
  // 颜色 hover 瞬跳 = 阻断级（2026-09-26 升级）：存量 42 处已全部补齐过渡并清零，
  // 此后新增缺口直接 fail。顺带修复的 stripPseudoClasses 链式伪类 bug 曾让
  // :disabled:hover 的基类匹配永远失败（产生假告警）。
  console.error(`[color-hop] ${colorWarnings.length} 处 hover/active/focus 改颜色类属性而基类无过渡：`);
  console.error(colorWarnings.join("\n"));
  process.exitCode = 1;
}

/* ═══ 时长/easing 令牌绕过告警（非阻断）═══
   动效时长微调（--anim-dur/--fx-scale）与两族曲线（--ease-*）只作用于消费
   token 的声明；裸 ms 时长 / 裸 ease 关键字完全不受控，调档后同一屏出现
   快慢不一致的混合节奏。已 token 化（var(--dur-x) / var(--ease-x) / var(--anim-dur) / var(--fx-scale)）
   的部分不告警；linear 白名单（渐变插值 / linear() 样条 / 循环动画常态）。
   存量大（数百处），输出采样 + 总数，新代码应走 token。
   OR 语义修复：此前「整行只要含任一 token 就整行跳过」——`transform 0.28s
   var(--ease-spring)` 这类「裸时长 + token 曲线」混血声明从不被告警。现在
   先剔除全部 var(--token[, fallback])（含一层嵌套括号），再对剩余部分分别
   判定裸时长与裸 ease，时长与曲线各自独立过关。 */
/* var() 剥离改括号深度配平（与 check-size-tokens 同款
   助手）——单层容错正则对两层嵌套回退（var(--x, calc(max(14px,1vw)))）剥离
   失败，深层回退里的裸时长对棘轮不可见（漏报向）。 */
function stripWrapped(value, names) {
  let s = value;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const name of names) {
      const needle = name + "(";
      let from = 0;
      let idx;
      while ((idx = s.indexOf(needle, from)) !== -1) {
        const prev = idx === 0 ? "" : s[idx - 1];
        if (/[-\w]/.test(prev)) {
          from = idx + needle.length;
          continue;
        }
        let depth = 0;
        let end = -1;
        for (let i = idx + needle.length - 1; i < s.length; i++) {
          if (s[i] === "(") depth++;
          else if (s[i] === ")") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (end === -1) {
          from = idx + needle.length;
          continue;
        }
        s = s.slice(0, idx) + " " + s.slice(end + 1);
        progressed = true;
        from = idx;
      }
    }
  }
  return s;
}
const bareDurRe = /(^|[\s,(])(\d+(?:\.\d+)?|\.\d+)m?s\b/;
const bareEaseRe = /(^|[\s,(])(ease-in-out|ease-in|ease-out|ease)\b/;
const durHits = [];
const easeHits = [];
/* 连带修复（门禁盲区）命中：`${全大写常量}ms/s` 插值（见下方 TSX 计数块
   内注释）。无基线棘轮——直接阻断，现网要求零存量。 */
const constInterpHits = [];
/* baseline 棘轮（2026-09-27 升级为阻断）：scripts/anim-token-baseline.json
   记录各文件裸时长/裸 ease 存量计数（路径 → {dur, ease}）。当前计数超过
   基线即非零退出——存量保持可自由编辑，新增裸值直接拦下；计数低于基线
   时提示 --update-baseline 收紧。行级内容易随编辑漂移，故取「文件×类型」
   计数粒度，同一文件内的等量置换不会误报。 */
const BASELINE_PATH = "scripts/anim-token-baseline.json";
const updateBaseline = process.argv.includes("--update-baseline");
const fileCounts = new Map();
/* 基线 key 统一 POSIX 斜杠：Windows 上 path 遍历产出反斜杠路径，直接写基线
   会在非 Windows 环境全体失配。读取侧同步归一化，兼容历史反斜杠基线。 */
const posixKey = (f) => f.replace(/\\/g, "/");
/* delay 单独拆桶：animation-delay 的错落阶梯（--sti × 20-40ms 之类）是设计
   意图而非偏离 token 体系的 transition 时长，与真实裸时长混在一个棘轮里会
   掩盖后者的增减（2026-09-27 拆桶）。 */
const bump = (f, kind) => {
  const key = posixKey(f);
  const rec = fileCounts.get(key) ?? { dur: 0, ease: 0, delay: 0 };
  rec[kind] += 1;
  fileCounts.set(key, rec);
};
const delayHits = [];
/* CSS 侧改**声明级**匹配（属性名到分号，跨行）——此前
   逐行正则对 Prettier 折行的长声明（值在后续行）整条不可见，14 处存量裸
   时长正落在盲区里（写成单行即超基线 fail，多行则计 0）。transition/
   animation 值内不含分号（无字符串/无嵌套语句），按 ';' 截断是安全的。 */
/* R-工程-2（复审）：后缀组 (-[a-z]+)* 吃多段连字符——transition-timing-function /
   animation-timing-function 含第二段连字符，单段组让整类属性出扫描面。 */
const cssDeclRe = /(^|[{;])(\s*)(transition|animation)(-[a-z]+)*\s*:([^;]*);/g;
for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  cssDeclRe.lastIndex = 0;
  let m;
  while ((m = cssDeclRe.exec(stripped))) {
    const prop = m[3] + (m[4] ?? "");
    const value = m[5];
    const isDelay = prop === "animation-delay";
    const firstLine = (m[2] + prop + ":" + value).replace(/\s+/g, " ").trim();
    const bare = stripWrapped(value, ["var"]);
    if (isDelay) {
      if (bareDurRe.test(bare)) {
        delayHits.push(`${f}: ${firstLine.slice(0, 90)}`);
        bump(f, "delay");
      }
      continue; // delay 行不再计入 dur 桶
    }
    if (bareDurRe.test(bare)) {
      durHits.push(`${f}: ${firstLine.slice(0, 90)}`);
      bump(f, "dur");
    }
    if (bareEaseRe.test(bare)) {
      easeHits.push(`${f}: ${firstLine.slice(0, 90)}`);
      bump(f, "ease");
    }
  }
}
/* ══ TS/TSX 内联动效棘轮（2026-09-27 扩域，补 CSS-only 盲区）══
   棘轮此前只扫 *.css：TSX 内联 transition 字符串与驼峰分属性
   （transitionDuration / animationDelay 等）完全游离——「曲线管了、时长没管」
   的半开状态。这里用同一套 bareDurRe/bareEaseRe 对 src/** /*.{ts,tsx} 计数，
   并入同一条基线：var()/animDurations() 消费先剥除（与 CSS 侧同语义），
   ${...} 插值保留（stagger 阶梯照常进 delay 桶）。分属性写值由
   transition[A-Za-z-]* 一并覆盖。 */
{
  /* inlineAnimRe 增补裸 `animation:` 简写形态——此前
     棘轮只认 transition* / animationDelay 等，TSX 内联 `animation: "x 300ms ease"`
     完全游离（现网唯一实例 SettingsView.tsx:169 恰好全 token，但盲区存在）。
     命中后走与 transition 同一套剥 var()/animDurations() 再判裸时长/裸 ease 的
     棘轮逻辑，token 化写法照常放行。 */
  const inlineAnimRe =
    /\btransition[A-Za-z-]*\b|\banimationDelay\b|\banimationDuration\b|\banimationTimingFunction\b|\banimation\s*:/;
  const tsFiles = walkSrc("src", []).filter((f) => /\.(ts|tsx)$/.test(f));
  for (const f of tsFiles) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const t = line.trim();
      if (!inlineAnimRe.test(t)) continue;
      /*无字符串行不再整体跳过——`transitionDuration: 200` 这类纯
         数字 prop（React style 单位即 ms）此前游离在棘轮外；无字符串且无数字
         的行（纯字段引用/类型声明）天然不命中各检测，照旧跳过省扫描。 */
      if (!/["'`]/.test(t) && !/\d/.test(t)) continue;
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue; // 注释里的示例/术语不算消费
      // 连带修复（门禁盲区）：`${IDENT}ms` 形态且 IDENT 为全大写常量名时，
      // 下方的棘轮替换按「纯变量引用」剥除放行——但全大写命名几乎必然是写死的
      // 数字常量（实案例：MiscBoardPanel 的 SETTLE_MS=450），曲线走 token 而
      // 时长游离在 设置→动效 速度三档之外。这里直接阻断（无基线棘轮，现网零
      // 存量）；运行时派生值（animDurations() 产物 / 小写局部变量）不受影响。
      const constInterp = /\$\{[A-Z][A-Z0-9_]*\}\s*(m?s\b)?/.exec(t);
      if (constInterp) {
        constInterpHits.push(`  ${posixKey(f)}:${li + 1}  ${constInterp.input.slice(0, 110)}`);
      }
      const isDelay = /\banimationDelay\b|\btransitionDelay\b/.test(t);
      /*无单位纯数字时长（`transitionDuration: 200`）——bareDurRe
         只认带 m/s 单位形态，这里按字段名直接归桶。仅限 .tsx：style 属性的
         实际存在面；.ts 里同名字段多为设置模型数据（settings-store 的
         animationDuration: 100 即时长百分比设置项），不归动效棘轮管。 */
      const numDurField = f.endsWith(".tsx") && /(?:transition|animation)(?:Duration|Delay)\s*[:=]\s*\d/.test(t);
      if (numDurField) {
        bump(f, isDelay ? "delay" : "dur");
        continue;
      }
      const bare = stripWrapped(t, ["var"])
        .replace(/animDurations\(\)[\w.]*/g, " ")
        .replace(/Math\.\w+\(/g, " ")
        // ${...}：内含时长字面量的保留检测（stagger 阶梯；单位写在插值外的
        // `${Math.min(i,7) * 0.03}s` 形态由 unit 后缀捕获兜住），纯变量引用
        // （${ease}/${durMs} 等 pickSpatialEase/animDurations 产物）替换为空。
        .replace(/\$\{([^}]*)\}(m?s\b)?/g, (m2, inner, unit) => {
          if (/\d+(?:\.\d+)?m?s\b/.test(inner)) return ` ${inner} `;
          if (unit && /\d/.test(inner)) return ` ${inner}${unit} `;
          return " ";
        });
      if (isDelay) {
        if (bareDurRe.test(bare)) bump(f, "delay");
        continue;
      }
      if (bareDurRe.test(bare)) bump(f, "dur");
      if (bareEaseRe.test(bare)) bump(f, "ease");
    }
  }
}

if (constInterpHits.length > 0) {
  console.error(
    `[anim-token] ${constInterpHits.length} 处 \`\${全大写常量}ms/s\` 插值——常量时长游离在动效速度三档之外，改用 animDurations() 运行时派生（P1 盲区修复）：`
  );
  console.error(constInterpHits.join("\n"));
  process.exitCode = 1;
}

if (durHits.length > 0 || easeHits.length > 0 || delayHits.length > 0) {
  console.warn(
    `[anim-token] 裸时长 ${durHits.length} 处 / 裸 ease ${easeHits.length} 处 / delay 阶梯 ${delayHits.length} 处（存量渐进归一，新代码应消费 --dur-*/--ease-* token；采样前 15 条）：`
  );
  for (const h of [...durHits.slice(0, 8), ...easeHits.slice(0, 7)]) console.warn(`  ${h}`);
}

if (updateBaseline) {
  const snapshot = Object.fromEntries([...fileCounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `[anim-token] 基线已更新：${BASELINE_PATH}（${durHits.length} dur / ${easeHits.length} ease / ${delayHits.length} delay）`
  );
} else if (fs.existsSync(BASELINE_PATH)) {
  const rawBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  // 历史基线可能是反斜杠 key：读取侧归一化后再比较。
  const baseline = Object.fromEntries(Object.entries(rawBaseline).map(([k, v]) => [posixKey(k), v]));
  const regressions = [];
  for (const [f, cur] of fileCounts) {
    const base = baseline[f] ?? { dur: 0, ease: 0, delay: 0 };
    for (const kind of ["dur", "ease", "delay"]) {
      if (cur[kind] > (base[kind] ?? 0)) {
        regressions.push(`  ${f}: ${kind} ${base[kind] ?? 0}→${cur[kind]}`);
      }
    }
  }
  if (regressions.length > 0) {
    console.error("[anim-token] 裸时长/裸 ease/delay 存量超出基线（新代码必须消费 --dur-*/--ease-* token）：");
    console.error(regressions.join("\n"));
    process.exitCode = 1;
  }
  const baseTotal = Object.values(baseline).reduce((s, v) => s + (v.dur ?? 0) + (v.ease ?? 0) + (v.delay ?? 0), 0);
  /*curTotal 必须与 baseTotal 同口径——TS/TSX 内联棘轮只 bump
     fileCounts 不进 hits 数组，此前用 hits 数组总量（CSS-only）对比基线总量
     （CSS+TS）恒偏小，导致「收紧基线」提示跑完 --update-baseline 也不消失。 */
  const curTotal = [...fileCounts.values()].reduce((s, v) => s + (v.dur ?? 0) + (v.ease ?? 0) + (v.delay ?? 0), 0);
  if (curTotal < baseTotal) {
    console.warn(
      `[anim-token] 存量已从 ${baseTotal} 降到 ${curTotal}，运行 node scripts/check-transitions.mjs --update-baseline 收紧基线`
    );
  }
} else {
  console.warn(
    "[anim-token] 无基线文件（scripts/anim-token-baseline.json）——运行 --update-baseline 生成后本检查升级为阻断级"
  );
}

/* ═══ 裸 cubic-bezier 门禁（阻断级，2026-09-27 收口）═══
   曲线只允许两种存在：feature-animations.css 的 token 定义（值契约由下方
   ease-contract 看守），或带「ease: ok <理由>」行内豁免的私有调参曲线。
   此前本检查对曲线字面量全盲——feature-fx.css 十余处逐字手抄
   --ease-out/--ease-spring 原值（token 调参不会跟改，同屏两套手感）与无名
   私有曲线（绕过契约）全部静默过审。CSS / TS / TSX 内联 transition 同管；
   linear() 采样（dockQ 弹簧）走独立契约不在本闸范围。 */
{
  const allowRe = /ease:\s*ok\b/;
  const curveIssues = [];
  for (const f of walkSrc("src", [])) {
    const base = path.basename(f);
    if (base === "feature-animations.css") continue; // token 定义地
    if (f.replace(/\\/g, "/").endsWith("lib/bezier.ts")) continue; // 贝塞尔编辑器：曲线的唯一合法生产者（产物经 --ease-custom 入体系）
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("cubic-bezier(")) continue;
      // 纯注释行不判（文档里提到曲线不是消费曲线）；豁免注释允许写在命中行
      // 或其上方 3 行内（多行豁免注释的收尾行与命中行常隔 1-2 行）。
      const trimmed = line.trim();
      if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
      let allowed = allowRe.test(line);
      for (let back = 1; back <= 3 && !allowed && i - back >= 0; back++) allowed = allowRe.test(lines[i - back]);
      if (allowed) continue;
      curveIssues.push(`  ${path.relative("src", f).replace(/\\/g, "/")}:${i + 1} ${trimmed.slice(0, 90)}`);
    }
  }
  if (curveIssues.length > 0) {
    console.error(
      `[bare-ease] ${curveIssues.length} 处裸 cubic-bezier 游离在 token 契约外（应消费 var(--ease-*) token；确属专用调参曲线加「ease: ok <理由>」行内豁免）：`
    );
    console.error(curveIssues.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[bare-ease] 裸 cubic-bezier 扫描通过：token 定义地之外零裸曲线（豁免均有据）。");
  }
}

/* ═══ --anim-dur fallback 死值门禁（阻断级，2026-09-27 三轮 ）═══
   theme-engine 无条件把 --anim-dur[-fast|-slow] 内联写在 :root，而 CSS var()
   的 fallback 只在变量未定义时生效——`var(--anim-dur, 0.12s)` 的 0.12s 永远
   不会生效，实际解析为全局当前档位。历史上 157 处此类写法把约 90 处微反馈
   时长与循环周期（1.8s 呼吸变 4Hz 频闪）全部静默击穿。规则：fallback 只允许
   各自变量的标准档（250/125/500ms，theme-engine 未运行的首帧兜底），其他
   时长一律消费语义 token（--dur-fx-xfast/--dur-fx/--dur-fx-slow/--dur-spatial
   等），循环节奏（呼吸/自转）直接写字面量并注明不随速度档。 */
{
  const DUR_FALLBACK_RE = /var\(--anim-dur(-fast|-slow)?,\s*([^)]+)\)/g;
  const STANDARD_MS = { "": 250, "-fast": 125, "-slow": 500 };
  const fallbackIssues = [];
  for (const f of walkCss("src")) {
    const css = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let m;
    while ((m = DUR_FALLBACK_RE.exec(css)) !== null) {
      const raw = m[2].trim();
      const mm = raw.match(/^(\d+(?:\.\d+)?|\.\d+)(m?s)$/);
      const ms = mm ? (mm[2] === "s" ? parseFloat(mm[1]) * 1000 : parseFloat(mm[1])) : NaN;
      if (ms !== STANDARD_MS[m[1] ?? ""]) {
        const line = css.slice(0, m.index).split("\n").length;
        fallbackIssues.push(
          `  ${path.relative("src", f).replace(/\\/g, "/")}:${line} var(--anim-dur${m[1] ?? ""}, ${raw})`
        );
      }
    }
  }
  if (fallbackIssues.length > 0) {
    console.error(
      "[anim-dur-fallback] var(--anim-dur, X) 的 fallback 只允许该变量标准档（250/125/500ms）——theme-engine 无条件内联 :root，其余 fallback 永不生效；请消费语义 token 或写循环字面量："
    );
    console.error(fallbackIssues.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[anim-dur-fallback] --anim-dur fallback 扫描通过：仅存各变量标准档首帧兜底。");
  }
}

/* ═══ 动效两族分档 · token 契约（阻断级防退化） ═══
   expressive 基准曲线必须原值存在、且只在 feature-animations.css 的
   :root 定义一次（其它文件重定义/改值视为体系漂移）；语义别名与 pageDepth
   配方不得被移除。值比对先去全部空白，容忍格式差异。 */
const normalize = (s) => s.replace(/\s+/g, "");
const EASE_CONTRACT = [
  ["--ease-spatial-fast", "cubic-bezier(0.42,1.67,0.21,0.9)"],
  ["--ease-spatial", "cubic-bezier(0.38,1.21,0.22,1)"],
  ["--ease-spatial-slow", "cubic-bezier(0.39,1.29,0.35,0.98)"],
  ["--ease-fx", "cubic-bezier(0.34,0.8,0.34,1)"],
  ["--ease-element-move", "var(--ease-spatial-fast)"],
  ["--ease-card-reflow", "var(--ease-spatial)"],
  /* pageDepth 三 token 已随「切页即时呈现」决策整体下线（settings.css 方向
     感知页切 keyframes 与 feature-animations.css 定义一并删除）——若未来重引入，
     需连同本契约一起恢复。 */
  ["--state-layer-hover", "0.08"],
  ["--state-layer-pressed", "0.12"]
];
const easeIssues = [];
const allCss = files.map((f) => ({ f, raw: fs.readFileSync(f, "utf8") }));
for (const [name, value] of EASE_CONTRACT) {
  const needle = normalize(`${name}: ${value};`);
  // 精确匹配「name:」开头（避免 --ease-spatial 命中 --ease-spatial-fast）
  const defRe = new RegExp(`(^|[\\s;{])${name.replace(/-/g, "\\-")}\\s*:[^;]+;`, "g");
  let defined = 0;
  for (const { f, raw } of allCss) {
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of stripped.matchAll(defRe)) {
      const decl = normalize(m[0].replace(/^[\s;{]/, ""));
      defined++;
      if (decl !== needle) easeIssues.push(`[ease-contract] ${f}: ${name} 定义漂移 → ${m[0].trim()}`);
      else if (path.basename(f) !== "feature-animations.css")
        easeIssues.push(`[ease-contract] ${f}: ${name} 只允许定义在 feature-animations.css`);
    }
  }
  if (defined === 0) easeIssues.push(`[ease-contract] ${name} 未按契约定义（期望 ${name}: ${value}）`);
  else if (defined > 1) easeIssues.push(`[ease-contract] ${name} 定义了 ${defined} 次（应仅 1 次）`);
}

/* dockQ 弹簧：s(t)=1−cos(2π·2.65·t)·e^(−10.8·t) 的
   linear() 采样近似 + 不支持时的 Spatial 回退，两处定义（:root 回退 +
   @supports 覆盖）都只允许在 feature-animations.css；linear() 版必须保留
   1.1583 峰值，回退版必须指向
   --ease-spatial。前代 --ease-island-expand（基准样条 1.035 峰值）已随
   本 token 接任消费点而退役删除。 */
{
  const name = "--ease-dock-spring";
  const defRe = new RegExp(`(^|[\\s;{])${name.replace(/-/g, "\\-")}\\s*:[^;]+;`, "g");
  const defs = [];
  for (const { f, raw } of allCss) {
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of stripped.matchAll(defRe)) defs.push({ f, decl: normalize(m[0].replace(/^[\\s;{]/, "")) });
  }
  const foreign = defs.filter((d) => path.basename(d.f) !== "feature-animations.css");
  for (const d of foreign) easeIssues.push(`[ease-contract] ${d.f}: ${name} 只允许定义在 feature-animations.css`);
  const fallback = defs.filter((d) => d.decl === normalize(`${name}: var(--ease-spatial);`));
  const spline = defs.filter((d) => d.decl.startsWith(normalize(`${name}: linear(`)) && d.decl.includes("1.1583"));
  if (fallback.length !== 1)
    easeIssues.push(`[ease-contract] ${name} 回退定义应恰为 1 处 var(--ease-spatial)（现 ${fallback.length} 处）`);
  if (spline.length !== 1)
    easeIssues.push(`[ease-contract] ${name} linear() 弹簧定义应恰为 1 处且含 1.1583 峰值（现 ${spline.length} 处）`);
  if (defs.length !== 2)
    easeIssues.push(`[ease-contract] ${name} 共定义 ${defs.length} 次（应为 回退 + @supports 覆盖 = 2 次）`);
}

/* 别名消费校验（MOTION 补救，阻断级）：语义别名必须在 src 目录下全部
   .css / .ts / .tsx 文件中各至少一处以 var(--alias) 形式真实消费。
   feature-animations.css 的定义行不算（上面的契约已保证别名只在那里定义）；
   *.test.* / *.spec.* 不算（测试里的期望字串不是运行时消费）；块注释与整行
   // 注释先剔除。零消费 = 「定义了但没人用」的体系漂移，与定义漂移同级阻断。
   --ease-dock-spring（二.7）同列：灵动岛几何 morph（收合 / 吸附 / 接管宽度 /
   磁贴生长）是它的存在理由，feature-dock.css 不再消费即应删 token。 */
const ALIAS_CONSUMERS = ["--ease-element-move", "--ease-card-reflow", "--ease-dock-spring"];
function walkSrc(dirPath, out) {
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkSrc(p, out);
    else if (/\.(css|ts|tsx)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const srcFiles = walkSrc("src", []);
const consumeReport = [];
for (const alias of ALIAS_CONSUMERS) {
  const esc = alias.replace(/-/g, "\\-");
  const useRe = new RegExp(`var\\(\\s*${esc}\\s*[,)]`, "g");
  const defRe = new RegExp(`(^|[\\s;{])${esc}\\s*:[^;]+;`, "g");
  let hits = 0;
  const where = [];
  for (const f of srcFiles) {
    const text = fs
      .readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(defRe, "");
    const n = (text.match(useRe) || []).length;
    if (n > 0) {
      hits += n;
      where.push(`${path.relative("src", f).replace(/\\/g, "/")}×${n}`);
    }
  }
  if (hits === 0)
    easeIssues.push(
      `[ease-contract] 别名消费校验失败：${alias} 在 src/**/*.{css,ts,tsx} 零消费（须至少一处 var(${alias})，定义行与测试不计）`
    );
  else consumeReport.push(`${alias} ${hits} 处（${where.join(", ")}）`);
}

if (easeIssues.length > 0) {
  console.error(easeIssues.join("\n"));
  process.exitCode = 1;
} else {
  console.log("[ease-contract] A3 两族曲线/别名契约完整。");
  console.log(`[ease-contract] 别名消费校验通过：${consumeReport.join("；")}。`);
}

/* ══ WAAPI Element.animate 门禁（阻断级，2026-09-27）══
   .animate() 第二参的 duration/easing 字面量游离在 token 体系外。要求：
   duration 来自 animDurations() 等运行时读取（非数字字面量）、easing 来自
   变量（非字符串字面量），或行内「waapi: ok <理由>」豁免。 */
{
  const waapiIssues = [];
  const allowRe = /waapi:\s*ok\b/;
  for (const f of walkSrc("src", [])) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(".animate(")) continue;
      let reported = false;
      /* 扫描窗 25 → 60 行——.animate( 第二参常用多行
         options 对象（keyframes 数组在前、duration/easing 挤在尾部），实测
         25 行窗会漏掉尾部参数；同时窗口遇下一个 .animate( 即止，防止相邻
         调用的参数互相串窗误报。 */
      for (let j = i; j < Math.min(lines.length, i + 60) && !reported; j++) {
        if (j > i && lines[j].includes(".animate(")) break;
        const l = lines[j];
        let bad = null;
        if (/\bduration:\s*["'`]?\d/.test(l)) bad = "duration 字面量";
        /* 命名常量穿透阻断——`duration: SETTLE_MS` 这类全大写常量几乎
           必然是写死的数字时长（对齐上方 constInterp 思路）；运行时派生值
           （animDurations().fxMs / 小写局部变量）不受影响。 */
        else if (/\bduration:\s*[A-Z][A-Z0-9_]*\b/.test(l)) bad = "duration 命名常量";
        else if (/\beasing:\s*["'`]/.test(l)) bad = "easing 字符串字面量";
        else if (/\beasing:\s*[A-Z][A-Z0-9_]*\b/.test(l)) bad = "easing 命名常量";
        if (bad) {
          /* 豁免窗改为调用行 i±3 与命中行 j±3 的
             并集——违规命中可在调用行后最远 59 行（扫描窗扩到 60 行后
             duration/easing 属性行与 .animate( 调用行相距甚远），豁免注释写
             在直觉位置（属性行旁）时旧窗 i±3 不识别 → 误报。 */
          const winAllowed = (center) => {
            const from = Math.max(0, center - 3);
            const to = Math.min(lines.length, center + 4);
            for (let k = from; k < to; k++) if (allowRe.test(lines[k])) return true;
            return false;
          };
          const allowed = allowRe.test(l) || winAllowed(i) || winAllowed(j);
          if (!allowed) {
            waapiIssues.push(
              `  ${path.relative("src", f).replace(/\\/g, "/")}:${j + 1} ${bad}（应消费 animDurations()/token，或加「waapi: ok <理由>」）`
            );
            reported = true;
          }
          break;
        }
      }
    }
  }
  if (waapiIssues.length > 0) {
    console.error(`[waapi] ${waapiIssues.length} 处 Element.animate 字面量游离在 token 体系外：`);
    console.error(waapiIssues.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[waapi] WAAPI 动画参数检查通过（时长/曲线走运行时读取）。");
  }
}

/* ══ 退场时长配对静态对账══
   useDelayedUnmount(cond, animDurations().TOKEN) 的 JS 卸载等待时长必须与
   同组件 .cls.is-closing 退场动画实际消费的 CSS 时长 token 同档——错档时
   元素会空挂（JS 比 CSS 长）或提前卸载截断动画（JS 比 CSS 短）。两处
   错档（fxMs 200ms vs fx-fast 150ms）就是这么漏的：两侧各自「都用了 token」
   但档位不同，没有任何门禁对账。
   启发式配对（静态近似，宁可漏报不可误伤）：
   1) JS 侧收集 useDelayedUnmount(…, [Math.round(]animDurations().TOKEN) 调用；
   2) CSS 侧收集「选择器以 .X.is-closing 收尾」的规则体里全部时长 var（--dur 族
      与 --anim-dur 族）；
   3) TSX 内每个 is-closing 出现处，取其前方最近 className 字面（剔除 ${…}
      插值后的词元）为类名候选，与最近（按行距）的 useDelayedUnmount 调用配对；
   4) 配对成功且 token 期望 var 不在规则 var 集合 → exit 1；类名候选无 CSS
      规则可对（自定义类/无退场 token）→ 仅警告不拦。 */
{
  /* durations.ts ↔ feature-animations.css 的同源映射（乘数一致，见上方
     contract-sync 块的 multMap；animMs 直取 --anim-dur 本档）。 */
  const TOKEN_VAR = {
    animMs: "--anim-dur",
    fastMs: "--anim-dur-fast",
    slowMs: "--anim-dur-slow",
    fxXfastMs: "--dur-fx-xfast",
    fxFastMs: "--dur-fx-fast",
    fxMs: "--dur-fx",
    fxSlowMs: "--dur-fx-slow",
    spatialFastMs: "--dur-spatial-fast",
    spatialMs: "--dur-spatial",
    spatialSlowMs: "--dur-spatial-slow",
    dockSpringMs: "--dur-dock-spring"
  };
  // CSS 侧：.X.is-closing（选择器末复合）→ 规则体消费的时长 var 集合
  const closingVars = new Map(); // class -> Set<var>
  for (const { rules } of parsedFiles) {
    for (const r of rules) {
      for (const single of splitSelectorList(r.selector)) {
        const cm = /\.([\w-]+)\.is-closing(?![\w-])\s*$/.exec(single.trim());
        if (!cm) continue;
        const vars = new Set(
          (r.body.match(/var\(\s*(--(?:anim-dur|dur)[\w-]*)/g) || []).map((s) => s.replace(/var\(\s*/, ""))
        );
        const prev = closingVars.get(cm[1]) ?? new Set();
        vars.forEach((v) => prev.add(v));
        closingVars.set(cm[1], prev);
      }
    }
  }
  const unmountIssues = [];
  const unpaired = [];
  /* 类名候选与调用配对（两级启发，宁可漏报不可误伤）：
   * A. 驱动表达式匹配——`…${DRIVER ? " is-closing" : ""}` 的 DRIVER 与
   *    某调用的赋值变量（含 Closing↔Keep/Visible/Render 词干等价）或
   *    条件表达式互为包含（payloadState ⊂ payloadState != null）；
   * B. 渲染门回退——DRIVER 匹配不到时，向前找最近的 `{VAR &&` / `{VAR ?`
   *    门（VAR 为调用变量），且 is-closing 必须仍处该门的花括号深度内
   *    （防止列表行误吸隔壁弹层的调用）；
   * 唯一命中才对账，零命中/多义 → 仅提示不拦。 */
  const normExpr = (s) => s.replace(/[!(\s)]/g, "");
  const stem = (name) => name.replace(/(Closing|Keep|Visible|Render|Mounted)$/i, "").toLowerCase();
  for (const f of walkSrc("src", [])) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const raw = fs.readFileSync(f, "utf8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const lineOfIdx = (i) => stripped.slice(0, i).split("\n").length;
    // JS 侧调用点：捕获赋值变量 / 条件 / token（含 Math.round 包裹；+N 余量
    // 后缀不参与档位比较）
    const calls = [];
    const callRe =
      /const\s+([\w$]+)\s*=\s*useDelayedUnmount\s*\(\s*([^,()]+),\s*(?:Math\.round\s*\(\s*)?animDurations\(\)\s*\.\s*(\w+)/g;
    let cm;
    while ((cm = callRe.exec(stripped)) !== null)
      calls.push({ varName: cm[1], cond: cm[2], token: cm[3], line: lineOfIdx(cm.index) });
    if (calls.length === 0) continue;
    const occRe = /is-closing/g;
    let om;
    while ((om = occRe.exec(stripped)) !== null) {
      const occLine = lineOfIdx(om.index);
      // A. 驱动表达式：本出现处（而非窗口内前一个三元）的 `?` 之前的条件文本
      const winStart = Math.max(0, om.index - 250);
      const win = stripped.slice(winStart, om.index + 150);
      const dmRe = /([\w$][\w$.[\]()>!= &|]{0,120})\?[^?]{0,80}(is-closing)/g;
      let driver = "";
      let dm2;
      while ((dm2 = dmRe.exec(win)) !== null) {
        if (winStart + dm2.index + dm2[0].length - "is-closing".length === om.index) {
          driver = dm2[1].trim();
          break;
        }
      }
      let matches = [];
      if (driver) {
        const core = normExpr(driver);
        matches = calls.filter(
          (c) =>
            driver.includes(c.varName) ||
            (stem(driver).length >= 3 && stem(driver) === stem(c.varName)) ||
            normExpr(c.cond).includes(core)
        );
      }
      // B. 渲染门回退：{VAR && …（is-closing 需仍在门的花括号深度内）
      if (matches.length === 0) {
        for (const c of calls) {
          const gateRe = new RegExp(`\\{\\s*\\(?\\s*${c.varName}\\b[\\s\\S]{0,1500}?(&&|\\?)`, "g");
          let gm;
          let contained = false;
          while ((gm = gateRe.exec(stripped)) !== null) {
            if (gm.index > om.index) break;
            // 从门 `{` 起数花括号深度：中途归零说明门已闭合，不含本出现处
            let depth = 0;
            let ok = false;
            for (let i = gm.index; i < om.index; i++) {
              if (stripped[i] === "{") depth++;
              else if (stripped[i] === "}") depth--;
              if (depth <= 0 && i > gm.index) {
                ok = false;
                break;
              }
              ok = depth > 0;
            }
            if (ok) contained = true;
          }
          if (contained) matches.push(c);
        }
        matches = [...new Set(matches)];
      }
      if (matches.length !== 1) {
        unpaired.push(`  ${posixKey(f)}:${occLine}（${matches.length > 1 ? "多义" : "无"}调用可配）`);
        continue;
      }
      const call = matches[0];
      const expected = TOKEN_VAR[call.token];
      if (!expected) continue; // 非 fx/anim 族 token（如自定义时长字段）不参与对账
      const attrRe = /className\s*=\s*\{?\s*(["`])/g;
      let attr = null;
      let am2;
      while ((am2 = attrRe.exec(stripped)) !== null) {
        if (am2.index > om.index) break;
        attr = am2;
      }
      if (!attr) continue;
      const prefix = stripped.slice(attr.index, om.index).replace(/\$\{[^}]*\}/g, " ");
      const candidates = [...new Set(prefix.match(/[\w-]{2,}/g) || [])].filter((w) => w !== "className");
      let paired = false;
      for (const cls of candidates) {
        const vars = closingVars.get(cls);
        if (!vars) continue;
        paired = true;
        if (vars.size === 0) break; // 规则无时长 var，无法对账（不拦）
        if (!vars.has(expected)) {
          unmountIssues.push(
            `  ${posixKey(f)}:${occLine}  useDelayedUnmount(…${call.token}→${expected}) ≠ .${cls}.is-closing 消费 [${[...vars].join(", ")}]（退场等待与动画时长错档，Q-13 同款）`
          );
        }
        break; // 命中第一个有 CSS 规则的候选即定档
      }
      if (!paired) unpaired.push(`  ${posixKey(f)}:${occLine}（类名无 .is-closing 规则可对）`);
    }
  }
  if (unmountIssues.length > 0) {
    console.error(`[unmount-dur] ${unmountIssues.length} 处退场 JS/CSS 时长 token 错档：`);
    console.error(unmountIssues.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[unmount-dur] useDelayedUnmount 退场时长与 .is-closing CSS token 配对一致。");
  }
  if (unpaired.length > 0) {
    console.warn(`[unmount-dur] ${unpaired.length} 处 is-closing 未找到可对账的 CSS 规则（启发式限制，仅提示不拦）：`);
    console.warn([...new Set(unpaired)].slice(0, 12).join("\n"));
  }
}

/* ══ 曲线/时长契约双份对账（阻断级，2026-09-27）══
   bezier.ts 的 BEZIER_PRESETS 与 durations.ts 的乘数表是 CSS 契约的人工同步
   副本（durations.ts 头注自认「以 lint:anim 之外的 review 为准」）——双份
   漂移会让曲线编辑器的预设和 JS 补间时长悄悄偏离 CSS 体系。这里机器对账。 */
{
  const syncIssues = [];
  const animCss = fs
    .readFileSync(path.join("src", "styles", "feature-animations.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const cssDef = (name) => {
    const m = animCss.match(new RegExp(`(^|[\\s;{])${name.replace(/-/g, "\\-")}:\\s*([^;]+);`));
    return m?.[2]?.replace(/\s+/g, "") ?? null;
  };
  // a) 贝塞尔预设 ↔ --ease-*
  const presetToken = {
    spatial: "--ease-spatial",
    "spatial-fast": "--ease-spatial-fast",
    "spatial-slow": "--ease-spatial-slow",
    fx: "--ease-fx",
    out: "--ease-out",
    spring: "--ease-spring"
  };
  const bezierSrc = fs.readFileSync(path.join("src", "lib", "bezier.ts"), "utf8");
  const presetRe = /id:\s*"([\w-]+)",\s*label:\s*"[^"]*",\s*points:\s*\[([\d.,\s]+)\]/g;
  let pm;
  while ((pm = presetRe.exec(bezierSrc)) !== null) {
    const token = presetToken[pm[1]];
    if (!token) continue;
    const pts = pm[2].split(",").map((n) => Number(n.trim()));
    const cssVal = cssDef(token);
    const cm = cssVal?.match(/cubic-bezier\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)/);
    if (!cm) {
      syncIssues.push(`bezier.ts 预设 ${pm[1]} 对应的 ${token} 在 CSS 侧无 cubic-bezier 定义`);
      continue;
    }
    const cssPts = cm.slice(1).map(Number);
    if (pts.length !== 4 || pts.some((v, k) => Math.abs(v - cssPts[k]) > 1e-9)) {
      syncIssues.push(`bezier.ts 预设 ${pm[1]} [${pts}] ≠ CSS ${token} [${cssPts}]（编辑器预设与体系曲线漂移）`);
    }
  }
  // b) durations.ts 乘数 ↔ --dur-* calc 派生
  const durationsSrc = fs.readFileSync(path.join("src", "lib", "durations.ts"), "utf8");
  const multMap = [
    ["--dur-fx-xfast", "fxXfastMs", "anim"],
    ["--dur-fx", "fxMs", "anim"],
    ["--dur-fx-fast", "fxFastMs", "fast"],
    ["--dur-fx-slow", "fxSlowMs", "slow"],
    ["--dur-spatial-fast", "spatialFastMs", "anim"],
    ["--dur-spatial-slow", "spatialSlowMs", "slow"],
    ["--dur-dock-spring", "dockSpringMs", "anim"]
  ];
  for (const [tok, field, base] of multMap) {
    const cssM = animCss.match(
      new RegExp(
        `${tok.replace(/-/g, "\\-")}:\\s*calc\\(var\\(--anim-dur[\\w-]*,\\s*[\\d.]+s\\)\\s*\\*\\s*([\\d.]+)\\s*\\)`
      )
    );
    const tsM = durationsSrc.match(new RegExp(`${field}:\\s*${base}\\s*\\*\\s*([\\d.]+)`));
    if (!cssM || !tsM) {
      syncIssues.push(
        `${tok} ↔ durations.ts ${field} 乘数定义解析失败（CSS=${cssM?.[1] ?? "无"} TS=${tsM?.[1] ?? "无"}）`
      );
      continue;
    }
    if (Math.abs(Number(cssM[1]) - Number(tsM[1])) > 1e-9) {
      syncIssues.push(`${tok} CSS 乘数 ${cssM[1]} ≠ durations.ts ${field} 乘数 ${tsM[1]}`);
    }
  }
  // c) var 形式直引（--dur-spatial = --anim-dur-slow ↔ spatialMs: slow）
  if (cssDef("--dur-spatial") !== "var(--anim-dur-slow,0.5s)") {
    syncIssues.push(`--dur-spatial 应为 var(--anim-dur-slow, 0.5s)（现 ${cssDef("--dur-spatial")}）`);
  }
  if (!/spatialMs:\s*slow\b/.test(durationsSrc)) {
    syncIssues.push("durations.ts spatialMs 应直接取 slow（与 --dur-spatial 同源）");
  }
  if (syncIssues.length > 0) {
    console.error("[contract-sync] 曲线/时长契约双份漂移（改动须两侧同步）：");
    console.error(syncIssues.map((s) => `  ${s}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[contract-sync] bezier.ts 预设 / durations.ts 乘数与 CSS 契约一致。");
  }
}
