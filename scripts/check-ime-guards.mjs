#!/usr/bin/env node
/**
 * lint:ime —— keydown Enter 判断的 IME 组合期守卫门禁。
 *
 * 拦截目标：keydown 处理器体内判断 `key === "Enter"`（含 ==/!==/!=、e.key /
 * event.key / nativeEvent.key、单双引号变体）而同体内没有 isComposing 守卫。
 * Chromium 在 IME 组合期按 Enter 确认候选词时，keydown 仍以 key==="Enter"
 * 派发且 nativeEvent.isComposing===true——裸判断会把「回车选字」误当作提交
 * 正确范式见 WidgetCanvas.tsx 与 PromptDialog.tsx：
 *   if (e.key === "Enter" && !e.nativeEvent.isComposing) doSave();
 *
 * 扫描形态（src 下全部 .ts/.tsx，排除 *.test.*、*.spec.* 与 src/.mimosa 扫描产物）：
 *  1) JSX 属性 `onKeyDown={...}`——从 `{` 起字符串感知花括号配对提取处理器体
 *     （表达式体 `(e) => e.key === "Enter" && add()` 同样覆盖）；
 *  2) 对象属性 `onKeyDown: (e) => {...}`——inputProps 注入形态（设置窗
 *     notes.tsx 的编辑行就是这么挂的）；
 *  3) `addEventListener("keydown", ...)`——内联箭头/函数表达式按括号配对提取；
 *     具名引用（onKey）回同文件解析函数定义体；解析不到时保守取其后 25 行
 *     窗口（宁可多报再由 ALLOWLIST 收敛，不可漏报）。
 *
 * 语义级自动豁免（不算违规，无需登记）：
 *  - 处理器体内出现 isComposing（注释里的不算——语料先剥注释再分析）；
 *  - 同体内同时比较 key 与 " "（空格）——Enter+Space 是非文本元素的无障碍
 *    激活范式（按钮 / role=option / 网格单元），文本提交处理器不会配空格。
 *
 * 其余命中 → ALLOWLIST（内容锚定：文件路径 + 处理器体，行号漂移不失效），
 * 每条必须带理由。未豁免命中 exit 1。
 */
import fs from "node:fs";
import path from "node:path";

/* ═══ 语料收集（排除测试与 .mimosa 扫描产物，同口径）═══ */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".mimosa") continue; // 25MB/1938 文件扫描快照，不属于源码
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk("src", []);

/** 剥注释但保长度保换行（行号不漂移；注释里的 isComposing / Enter 示例不算数）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** 跳过一个字符串字面量（含模板串 ${...} 嵌套与转义），返回停在闭引号后。 */
function skipString(text, i) {
  const q = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (q === "`" && text[i] === "$" && text[i + 1] === "{") {
      let d = 1;
      i += 2;
      while (i < text.length && d > 0) {
        if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
          i = skipString(text, i);
          continue;
        }
        if (text[i] === "{") d++;
        else if (text[i] === "}") d--;
        i++;
      }
      continue;
    }
    if (text[i] === q) return i + 1;
    i++;
  }
  return i;
}

/** 从 text[start]（必须指向 open 字符）起做字符串感知配对，返回闭括号下标。 */
function matchDelim(text, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 从 start（值的首字符）起提取「表达式值」：深度 0 遇 `,` `}` `)` 即止。
 *  用于对象属性形态与 addEventListener 实参的处理器值提取（箭头块体的
 *  花括号会使深度 >0，不会提前截断）。返回 { text, end }。 */
function extractValue(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) return { text: text.slice(start, i), end: i };
      depth--;
    } else if (c === "," && depth === 0) return { text: text.slice(start, i), end: i };
    i++;
  }
  return { text: text.slice(start, i), end: i };
}

/** 具名函数解析：在文件内找 `function NAME(` 或 `const NAME =`，花括号配对取函数体。
 *  同名多定义时返回**全部**定义体（数组）——旧实现对
 *  defs 循环内取第一个定义体 return，CommandPalette 的两个 `const onKey`
 *  （呼出键处理器 / Enter 处理器）使 listener 被错配到无 Enter 判断的第一个
 *  定义体，第二个定义体的裸 Enter 静默漏检。改为调用侧对全部定义体逐个体检
 *  查（并集语义：任一同名定义体含 Enter 判断且无 isComposing 即违规），漏报
 *  向收敛，且行号按各自定义体精确定位。 */
function resolveNamedFn(stripped, name) {
  const defs = [];
  const fnRe = new RegExp(
    `(?:function\\s+${name}\\s*\\([^)]*\\)\\s*(?:\\{)|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)\\s*=>|function\\b[^{]*))`,
    "g"
  );
  let m;
  while ((m = fnRe.exec(stripped)) !== null) defs.push(m);
  const bodies = [];
  for (const def of defs) {
    const braceIdx = stripped.indexOf("{", def.index + def[0].length - 1);
    // const NAME = (e) => { … }：def[0] 已含 `=>`，其后第一个 `{` 即函数体；
    // function NAME(…) {：同理。找不到 `{`（表达式体箭头）则退回 extractValue。
    if (braceIdx < 0) continue;
    const close = matchDelim(stripped, braceIdx, "{", "}");
    if (close < 0) continue;
    bodies.push({ text: stripped.slice(braceIdx, close + 1), base: braceIdx });
  }
  return bodies;
}

const enterRe = /\bkey\s*(?:===|==|!==|!=)\s*(["'`])Enter\1/g;
const composeRe = /\bisComposing\b/;
const spacePairRe = /\bkey\s*(?:===|==|!==|!=)\s*(["']) {1}\1/;

const violations = [];
/* 同名定义体并集检查下，同一处理器体可能经多个挂载点
   重复进入检查（CommandPalette 两个 addEventListener("keydown", onKey) 各自对
   全部同名定义体扫一遍）——按文件+命中绝对偏移去重，一处违规只计一次。 */
const seenHits = new Set();
let handlerCount = 0;

function checkHandler(file, kind, handlerText, base) {
  handlerCount++;
  if (!enterRe.test(handlerText)) return;
  enterRe.lastIndex = 0;
  if (composeRe.test(handlerText)) return; // 已有 IME 守卫
  if (spacePairRe.test(handlerText)) return; // Enter+Space 无障碍激活范式（非文本元素）
  enterRe.lastIndex = 0;
  let m;
  while ((m = enterRe.exec(handlerText)) !== null) {
    const abs = base + 1 + m.index; // handlerText 起于 base+1
    const seen = `${file}:${abs}`;
    if (seenHits.has(seen)) continue;
    seenHits.add(seen);
    const line = strippedLineOf(file, abs);
    const rawLine = rawLinesOf(file)[line - 1] ?? "";
    violations.push({ file, line, kind, raw: rawLine.trim(), ctx: `${rel(file)} [${kind}]\n${handlerText}` });
  }
}

// 文件级缓存（stripped 与 raw 行表）
const cache = new Map();
function load(file) {
  if (!cache.has(file)) {
    const raw = fs.readFileSync(file, "utf8");
    cache.set(file, { raw, stripped: stripComments(raw), rawLines: raw.split(/\r?\n/) });
  }
  return cache.get(file);
}
const rel = (f) => f.replace(/\\/g, "/");
function strippedLineOf(file, abs) {
  return load(file).stripped.slice(0, abs).split("\n").length;
}
function rawLinesOf(file) {
  return load(file).rawLines;
}

for (const file of files) {
  const { stripped } = load(file);
  // 1) JSX 属性形态 onKeyDown={…}
  const attrRe = /\bonKeyDown\s*=\s*\{/g;
  let m;
  while ((m = attrRe.exec(stripped)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(stripped, open, "{", "}");
    if (close < 0) continue;
    const body = stripped.slice(open + 1, close);
    /* `onKeyDown={handler}` 具名引用形态提取出的
       "处理器体"只是标识符字符串，旧实现直接送检（Enter 判断永不命中），
       与 addEventListener 形态的 resolveNamedFn 路径不对称——DockTypePicker
       搜索框的裸 Enter 因此静默漏检。识别纯标识符后回同文件解析全部定义体
       逐个检查；解析不到（props 透传等跨文件来源）维持原样放行。定义体内
       无 Enter 判断的具名处理器（DatePicker/WidgetGallery 等）天然不命中，
       不引入误报增量。 */
    const id = /^[A-Za-z_$][\w$]*$/.exec(body.trim());
    if (id) {
      for (const r of resolveNamedFn(stripped, id[0])) checkHandler(file, `onKeyDown-ref:${id[0]}`, r.text, r.base);
    } else {
      checkHandler(file, "onKeyDown", body, open);
    }
  }
  // 2) 对象属性形态 onKeyDown: …（inputProps 注入）
  const propRe = /\bonKeyDown\s*:\s*/g;
  while ((m = propRe.exec(stripped)) !== null) {
    let s = m.index + m[0].length;
    while (s < stripped.length && /\s/.test(stripped[s])) s++;
    if (stripped[s] !== "(" && stripped[s] !== "f" && stripped[s] !== "a") {
      /* 只修了 JSX 形态的具名引用半边——对象属性
         形态（inputProps: { onKeyDown: onKey }）此前直接跳过，具名处理器
         的裸 Enter 静默漏检。与 JSX 分支同款：回同文件解析全部定义体逐个
         检查；解析不到（props 透传等跨文件来源）维持放行。 */
      const idm = /^[A-Za-z_$][\w$]*/.exec(stripped.slice(s));
      if (idm) {
        for (const r of resolveNamedFn(stripped, idm[0])) {
          checkHandler(file, `onKeyDown-prop-ref:${idm[0]}`, r.text, r.base);
        }
      }
      propRe.lastIndex = m.index + m[0].length;
      continue;
    }
    const v = extractValue(stripped, s);
    checkHandler(file, "onKeyDown:", v.text, s);
    propRe.lastIndex = m.index + m[0].length;
  }
  // 3) addEventListener("keydown", …)
  const lRe = /\baddEventListener\(\s*(["'])keydown\1\s*,/g;
  while ((m = lRe.exec(stripped)) !== null) {
    let s = m.index + m[0].length;
    while (s < stripped.length && /\s/.test(stripped[s])) s++;
    const idm = /^[A-Za-z_$][\w$]*/.exec(stripped.slice(s));
    if (idm && stripped[s] !== "(") {
      // 具名引用：解析同文件全部同名函数定义体逐个检查（并集语义，
      // 同名多定义不再错配到第一个）；解析不到退 25 行保守窗口
      const resolved = resolveNamedFn(stripped, idm[0]);
      if (resolved.length > 0) {
        for (const r of resolved) checkHandler(file, `listener:${idm[0]}`, r.text, r.base);
      } else {
        const nl = stripped.indexOf("\n", m.index);
        const from = stripped.lastIndexOf("\n", m.index) + 1;
        const winEnd = Math.min(
          stripped.length,
          nl +
            1 +
            stripped
              .slice(nl + 1)
              .split("\n")
              .slice(0, 25)
              .join("\n").length
        );
        checkHandler(file, `listener-window:${idm[0]}`, stripped.slice(from, winEnd), from);
      }
    } else {
      const v = extractValue(stripped, s);
      checkHandler(file, "listener:inline", v.text, s);
    }
  }
}

/* ═══ ALLOWLIST（内容锚定：relPath + 处理器体；带理由）═══
   语义豁免（isComposing / Enter+Space 激活范式）之外的历史存量。
   初版清单只覆盖 widget 层 9 处高频面，以下站点是清单外的存量债——
   登记在案防止新增裸 Enter 判断漏网，后续批次补守卫后逐条删除。 */
const ALLOWLIST = [
  {
    re: /components\/ui\/controls\.tsx[\s\S]*?\bcommit\(\)/,
    reason: "数字步进输入框（inputMode=numeric）：IME 不参与纯数字输入，无组合期误提交面"
  },
  {
    re: /features\/pomodoro\/PomodoroPanel\.tsx[\s\S]*?\(e\.target as HTMLInputElement\)\.blur\(\)/,
    reason: "数字步进输入框（inputMode=numeric）：IME 不参与纯数字输入，无组合期误提交面"
  },
  {
    re: /features\/pomodoro\/PomodoroPanel\.tsx[\s\S]*?addCustomEvent\(\)/,
    reason: "存量：自定义事件输入框 Enter 添加（存量清单外，待补 isComposing）"
  },
  {
    re: /widget\/WidgetConfigPopoverInner\.tsx[\s\S]*?e\.preventDefault\(\);\s*\n\s*add\(\)/,
    reason: "存量：时区输入框 Enter 添加（IANA 英文名 + datalist 选项，IME 面低）"
  },
  {
    re: /widget\/widgets\/ColorPickerWidget\.tsx \[listener:onKey\][\s\S]*?pickColor\(cur\.hex\)/,
    reason: "取色模式窗级 Enter 采样确认（屏幕取色非文本提交，无 IME 面）"
  },
  {
    re: /features\/deadlines\/DeadlinePanel\.tsx[\s\S]*?saveEdit\(\)/,
    reason: "存量：截止事项编辑行 Enter 提交（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/tasks\/TodayTasksPanel\.tsx[\s\S]*?saveEdit\(\)/,
    reason: "存量：今日任务编辑行 Enter 提交（存量清单外，待补 isComposing）"
  },
  /* HabitWidget 新增/改名两处输入框（原锚一条覆盖
     add()/saveRename(h) 两处）已补 !e.nativeEvent.isComposing 守卫，锚删除。 */
  {
    re: /features\/snip\/SnipView\.tsx[\s\S]*?commitText\(\)/,
    reason: "存量：snip 文字工具 textarea Enter 提交（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/configs\/notes\.tsx[\s\S]*?settle\(false\)/,
    reason: "存量：设置窗便签编辑行 Enter 结束编辑（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/configs\/planner\.tsx[\s\S]*?(?:settle\(false\)|e\.currentTarget\.blur\(\))/,
    reason: "存量：计划表设置编辑行 Enter 提交（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/widget-configs\.tsx[\s\S]*?(?:addToken\(\)|addUrl\(\))/,
    reason: "存量：文件关键字/URL 输入框 Enter 添加（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/configs\/media\.tsx[\s\S]*?addUrl\(\)/,
    reason: "存量：媒体源 URL 输入框 Enter 添加（URL 输入，IME 面低）"
  },
  {
    re: /features\/settings\/configs\/connect\.tsx[\s\S]*?commitPort\(\)/,
    reason: "存量：端口输入框 Enter 提交（纯数字输入，IME 面低）"
  },
  {
    re: /features\/settings\/configs\/notification-center\.tsx[\s\S]*?commitPort\(\)/,
    reason: "存量：端口输入框 Enter 提交（纯数字输入，IME 面低）"
  },
  {
    re: /features\/settings\/pages\/ConnectionPage\.tsx[\s\S]*?(?:commitCity\(\)|addExtraCity\(\))/,
    reason: "存量：城市输入框 Enter 提交（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/pages\/DockPage\.tsx[\s\S]*?commitFocusBg\(\)/,
    reason: "存量：dock 背景值输入框 Enter 提交（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/pages\/GeneralPage\.tsx[\s\S]*?commitBlacklist\(\)/,
    reason: "存量：黑名单输入框 Enter 添加（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/pages\/StylePage\.tsx[\s\S]*?commit\(\)/,
    reason: "存量：样式数值输入框 Enter 提交（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/pages\/UpdatePage\.tsx[\s\S]*?commitEndpoint\(\)/,
    reason: "存量：更新端点输入框 Enter 提交（URL 输入，IME 面低）"
  },
  {
    re: /features\/settings\/pages\/TaskbarPage\.tsx[\s\S]*?\badd\(\)/,
    reason: "存量：任务栏排除列表输入框 Enter 添加（存量清单外，待补 isComposing）"
  },
  {
    re: /features\/settings\/shared\.tsx[\s\S]*?commitHex\(\)/,
    reason: "存量：十六进制色值输入框 Enter 提交（#AABBCC，IME 面低）"
  },
  {
    re: /features\/settings\/BezierCurveEditor\.tsx[\s\S]*?commitTexts\(texts\)/,
    reason: "存量：贝塞尔编辑器数值输入框 Enter 提交（纯数字，IME 面低）"
  },
  {
    re: /features\/settings\/SettingsView\.tsx[\s\S]*?navigate\(pick\.page\)/,
    reason: "存量：设置搜索框 Enter 跳转（搜索/选中项激活范式，选中项非文本提交）"
  },
  /* JSX 具名引用形态（onKeyDown={handler}）补定义体
     解析后浮出的两处既有站点——形态上缺 isComposing，语义上均无 IME 面：
     焦点不在文本输入框时 IME 不会进入组合期，keydown 不会有 isComposing=true。 */
  {
    re: /features\/settings\/shared\.tsx \[onKeyDown-ref:menuKeyDown\][\s\S]*?onChange\(o\.id\)/,
    reason: "Dropdown 菜单 listbox 键盘巡览 Enter 激活：焦点在菜单容器（非文本输入），无 IME 面"
  },
  {
    re: /features\/super-panel\/SuperPanelView\.tsx \[onKeyDown-ref:onPanelKeyDown\][\s\S]*?c\?\.run\(\)/,
    reason: "超级面板容器级 Enter 激活高亮项：target===currentTarget 守卫确保焦点在面板容器（非文本输入），无 IME 面"
  },
  /* 原锚 24（CommandPalette runWithPreference(c)，理由
     「列表激活范式；输入框直搜场景待复核」）删除——命令面板主交互是搜索输入框
     直搜，IME 组合期回车选词会误执行高亮命令，已补 !e.isComposing 守卫；该锚
     此前因 resolveNamedFn 同名多定义错配从未实际触发（死锚），守卫加上后彻底失效。 */
  {
    re: /widget\/QuickNoteView\.tsx[\s\S]*?e\.(?:ctrlKey|metaKey)/,
    reason: "Ctrl/Cmd+Enter 保存：修饰键组合在 IME 组合期不触发保存语义"
  },
  {
    re: /widget\/widgets\/CalendarWidget\.tsx[\s\S]*?setSelected\(key\)/,
    /* 理由勘误——原写「日历快捷输入 Enter 应用」与
       实际语义错位；实为周视图行 div role=button 的键盘激活（已补 " " 空格
       激活进语义豁免，锚保留待死锚检测报告后由后续批次清理）。 */
    reason: "周视图行 div role=button 键盘激活（Enter/Space 激活范式，无 IME 面）"
  },
  {
    re: /widget\/widgets\/UnitConverterWidget\.tsx[\s\S]*?recordCurrent\(\)/,
    reason: "存量：单位换算输入框 Enter 记录（数值输入，IME 面低）"
  },
  /* ShortcutFolderPopup 搜索框已补 isComposing 守卫
     （组合期直接 return），原锚（e.key !== "Enter"）删除。 */
  {
    re: /components\/PromptDialog\.tsx[\s\S]*?state\.kind === "confirm"/,
    reason:
      "confirm 弹窗窗级 Enter 兜底：焦点在输入框内时先经 :279 处理器的 isComposing 守卫（捕获阶段 preventDefault 后不再双触发）"
  }
];

const flagged = [];
let allowHits = 0;
for (const a of ALLOWLIST) a.hit = false; // 死锚检测的命中标记
for (const v of violations) {
  const hit = ALLOWLIST.find((a) => a.re.test(v.ctx));
  if (hit) {
    hit.hit = true;
    allowHits++;
    continue;
  }
  flagged.push(v);
}

console.log(
  `[ime] 扫描 ${files.length} 个文件，keydown 处理器 ${handlerCount} 个；Enter 判断 ${violations.length} 处` +
    `（语义豁免外，其中 ${allowHits} 处命中 ALLOWLIST 存量登记）`
);

/* ALLOWLIST 死锚检测——锚指向的代码已修复/已删除时
   违规不再产生、锚永不匹配，锚腐化此前静默（本轮实证：ColorPicker 守卫加上后
   其锚即死；错配的锚 24 从未活过）。console.warn warning 级输出、不改变
   退出码：内容锚定方向本身良好（漂移即 fail-closed 报错），死锚只是卫生债，
   提示后来者择机清理。 */
const dead = ALLOWLIST.filter((a) => !a.hit);
if (dead.length > 0) {
  console.warn(
    `[ime] 警告：${dead.length} 条 ALLOWLIST 锚本轮未命中任何违规（锚指向的代码已修复/已删除时锚即失效，应清理）：`
  );
  for (const a of dead) console.warn(`  - ${a.reason}`);
}

if (flagged.length === 0) {
  console.log("[ime] OK：全部 Enter 判断均有 isComposing 守卫 / 语义豁免 / 存量登记");
  process.exit(0);
}
console.error(
  `[ime] ${flagged.length} 处 keydown Enter 判断缺 isComposing 守卫（IME 组合期「回车选字」会被误当作提交）：`
);
for (const v of flagged) console.error(`  ${rel(v.file)}:${v.line}  [${v.kind}]  ${v.raw.slice(0, 110)}`);
console.error(
  '  修复：if (e.key === "Enter" && !e.nativeEvent.isComposing) …（对齐 WidgetCanvas.tsx / PromptDialog.tsx 范式）'
);
process.exit(1);
