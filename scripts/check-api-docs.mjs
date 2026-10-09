#!/usr/bin/env node
/**
 * M1（文档对账门禁）：docs/API.md 与 lib.rs invoke_handler 注册表的机器 diff。
 *
 * 「生成物即契约」文化的文档侧补齐（同类：gen:types 的 ts-rs 绑定）：命令面
 * 是手写文档最容易漂移的地方——新增命令忘写、改名忘同步、返回类型与实现脱节，
 * 评审靠肉眼抓不全。本脚本做四件事：
 *   1. 从 lib.rs 的 generate_handler! 提取全部注册命令（支持 `module::name`
 *      与 lib.rs 本体定义的裸名两种书写；先剥行注释，防注释里的 `]` 截断块）；
 *   2. 从 API.md 命令表（首格）提取文档化命令（纯 snake_case token；
 *      带冒号的事件名天然不参与比对）；
 *   3. 双向 diff + 文档头部声称的数量核对。任一不一致即非零退出（硬门禁）。
 *   4. 参数级对账（advisory）：解析各 `#[tauri::command]` Rust 源签名
 *      的参数名（剔除 window / app / State<…> 等 Tauri 注入参数），snake→camel
 *      归一后与 API.md 对应行「参数」列包含的参数名比对；不匹配仅输出清单
 *      告警、不非零退出——参数级对账先行告警，稳定后转硬门禁（把
 *      PARAM_GATE_ADVISORY 置 false 即可切硬）。
 *
 * 用法：npm run lint:api（--update 无参数化需求，文档漂移一律手改 API.md）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libPath = join(root, "src-tauri", "src", "lib.rs");
const docPath = join(root, "docs", "API.md");
/** 参数级对账是否阻断（false = 告警）。稳定后置 true 转硬门禁。 */
const PARAM_GATE_ADVISORY = true;

const lib = readFileSync(libPath, "utf8");
// 先剥行注释：generate_handler! 块内有 `// [POWER] …` 这类含 `]` 的注记，
// 不剥会截断非贪婪匹配（实测 190 个命令只解析出 184）。
const stripped = lib
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");
const handlerMatch = stripped.match(/generate_handler!\[([\s\S]*?)\]\)/);
if (!handlerMatch) {
  console.error("lint:api: lib.rs 中找不到 generate_handler! 块");
  process.exit(2);
}
const registered = [];
for (const rawLine of handlerMatch[1].split("\n")) {
  const line = rawLine.trim().replace(/,+$/, "");
  if (!line) continue;
  const mod = line.match(/^([a-z_0-9]+)::([a-z_0-9]+)$/);
  if (mod) {
    registered.push(mod[2]);
    continue;
  }
  if (/^[a-z_0-9]+$/.test(line)) registered.push(line);
}

const doc = readFileSync(docPath, "utf8");
const documented = new Set();
for (const line of doc.split("\n")) {
  if (!line.startsWith("| `")) continue;
  const firstCell = line.split("|")[1] ?? "";
  for (const t of firstCell.match(/`[a-z_][a-z0-9_]*`/g) ?? []) {
    documented.add(t.slice(1, -1));
  }
}

const problems = [];
const regSet = new Set(registered);
const dup = registered.filter((c, i) => registered.indexOf(c) !== i);
if (dup.length) problems.push(`注册表重复命令: ${[...new Set(dup)].join(", ")}`);
const undocumented = registered.filter((c) => !documented.has(c));
if (undocumented.length) problems.push(`已注册但文档缺失(${undocumented.length}): ${undocumented.join(", ")}`);
const phantom = [...documented].filter((c) => !regSet.has(c));
if (phantom.length) problems.push(`文档有但未注册(${phantom.length}): ${phantom.join(", ")}`);

const countClaim = doc.match(/IPC 命令\*\*（(\d+) 个/);
if (!countClaim) {
  problems.push("API.md 头部找不到「IPC 命令**（N 个」数量声明");
} else if (Number(countClaim[1]) !== regSet.size) {
  problems.push(`API.md 头部声称 ${countClaim[1]} 个命令，实际注册 ${regSet.size} 个`);
}

/* ---- ：参数级对账（advisory）。 ---- */

/** 递归收集 src-tauri/src 下全部 .rs 源文件（跳过构建产物目录）。 */
function listRsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "target" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listRsFiles(full, out);
    else if (e.name.endsWith(".rs")) out.push(full);
  }
  return out;
}

/**
 * 解析一条 `#[tauri::command]` fn 签名的参数名列表（按声明顺序）。
 * 剔除 Tauri 运行时注入参数：名为 window/app/app_handle/state 等，或类型为
 * `tauri::Window` / `tauri::AppHandle` / `State<…>`（如 `bc: tauri::State<…>`）。
 * 顶层逗号切分时同步跟踪 ()/[]/{}/<> 深度，兼容 `Option<Vec<String>>`、
 * `HashMap<String, String>` 等嵌套泛型。
 */
function parseCommandParams(sig) {
  // 签名片段从 fn 名开始：先定位参数列表的 "("，再取括号平衡的区间。
  const open = sig.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sig.length; i++) {
    const c = sig[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth--;
      if (depth === 0 && c === ")") {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const list = sig.slice(open + 1, close);
  // 顶层逗号切分（深度 0 才算分隔符）。
  const segs = [];
  let d = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") d++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") d--;
    else if (c === "," && d === 0) {
      segs.push(list.slice(start, i));
      start = i + 1;
    }
  }
  segs.push(list.slice(start));
  const INJECTED_NAMES = new Set(["window", "app", "app_handle", "state", "webview", "webview_window"]);
  const params = [];
  for (const raw of segs) {
    const seg = raw.trim();
    if (!seg) continue; // 空参数列表
    // 参数名 = 第一个顶层冒号前的标识符（跳过 mut / pub / r# 裸标识符前缀）。
    const m = seg.match(/^(?:pub\s+)?(?:mut\s+)?(?:r#)?([a-z_][a-z_0-9]*)\s*:/);
    if (!m) continue; // 形如 self 或非普通参数，跳过
    const name = m[1];
    // Tauri 注入参数：按名剔除（window/app/state…），按类型剔除
    // （tauri::Window / tauri::AppHandle / State<…>，注入参数名不一定叫 state）。
    if (INJECTED_NAMES.has(name)) continue;
    if (/:\s*(crate::)?(tauri::)?(Window|AppHandle|State)\s*(<|$)/.test(seg)) continue;
    params.push(name);
  }
  return params;
}

/** 命令名 → 参数名列表：扫描全部 .rs 源里的 #[tauri::command] fn 签名建索引。 */
function buildParamIndex() {
  const idx = new Map();
  for (const file of listRsFiles(join(root, "src-tauri", "src"))) {
    const src = readFileSync(file, "utf8");
    // 按 #[tauri::command] 切块：块内第一个 `fn name(` 即该命令签名起点。
    const parts = src.split("#[tauri::command]");
    for (let i = 1; i < parts.length; i++) {
      const chunk = parts[i];
      // 从 fn 关键字本身起匹配（不吃掉前缀的 #[allow(clippy::…)] 等属性——
      // 属性里的括号会被误认成参数列表）。
      const m = chunk.match(/\bfn\s+([a-z_0-9]+)\s*\(/);
      if (!m) continue;
      const fromFn = chunk.slice(m.index);
      const params = parseCommandParams(fromFn);
      if (params && !idx.has(m[1])) idx.set(m[1], params);
    }
  }
  return idx;
}

/** snake_case → camelCase（Tauri IPC 的 JS 侧参数名口径）。 */
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** 单元格中是否出现该参数名（词边界匹配，兼容 `foo?` / `foo:` / `foo[]` 写法）。 */
function cellHasToken(cell, camel) {
  return new RegExp(`(^|[^A-Za-z0-9])${camel}([^A-Za-z0-9]|$)`).test(cell);
}

// API.md 表格行 → { 命令名列表, 参数列 }。多命令合并行（如
// `get_update_info` / `resolve_latest_tag` / … 共一行）按首格全部命令收录。
const docRows = new Map(); // cmd -> { paramCell, cells aligned? }
const docLines = doc.split("\n");
for (const line of docLines) {
  if (!line.startsWith("| `")) continue;
  // 表格内的转义竖线（`\|`，如 `play\|pause`）不是列分隔符：按未转义竖线切分，
  // 切完再把 `\|` 还原为 `|`，否则参数列在枚举值处被截断、尾部参数误报缺失。
  const parts = line.split(/(?<!\\)\|/);
  const cmdCell = parts[1] ?? "";
  const paramCell = (parts[2] ?? "").replace(/\\\|/g, "|").trim();
  const cmds = (cmdCell.match(/`[a-z_][a-z0-9_]*`/g) ?? []).map((t) => t.slice(1, -1));
  if (!cmds.length) continue;
  // 多命令行且参数列 "/" 段数与命令数一致 → 逐段配对；否则并入共享列。
  const segments = paramCell.split("/").map((s) => s.trim());
  const aligned = cmds.length >= 2 && segments.length === cmds.length;
  cmds.forEach((c, i) => {
    docRows.set(c, { paramCell: aligned ? segments[i] : paramCell, row: line });
  });
}

const paramIndex = buildParamIndex();
const paramProblems = [];
let paramChecked = 0;
for (const cmd of registered) {
  const rustParams = paramIndex.get(cmd);
  const row = docRows.get(cmd);
  if (!rustParams || !row) continue; // 无签名（解析失败）或无文档行：交由上方硬门禁/告警
  paramChecked++;
  const missing = rustParams.filter((p) => !cellHasToken(row.paramCell, toCamel(p)));
  if (missing.length) {
    paramProblems.push(
      `${cmd}: 参数列缺 ${missing.map(toCamel).join(", ")}（Rust 实际参数：${rustParams.map(toCamel).join(", ") || "无"}）`
    );
  }
}

if (paramProblems.length) {
  const head = `lint:api 参数级对账${PARAM_GATE_ADVISORY ? "（E-20，advisory——先告警不阻断，稳定后转硬门禁）" : "（E-20 硬门禁）"}：${paramProblems.length} 处不一致`;
  if (PARAM_GATE_ADVISORY) {
    console.warn(head);
    for (const p of paramProblems) console.warn("  - " + p);
  } else {
    problems.push(head);
    for (const p of paramProblems) problems.push("  - " + p);
  }
}

if (problems.length) {
  console.error("lint:api: API.md 与注册表不一致 ——\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(
  `lint:api OK：${regSet.size} 个注册命令全部文档对齐（无多余、无缺失、无重复）；` +
    `参数级对账覆盖 ${paramChecked} 个命令${paramProblems.length ? `，${paramProblems.length} 处 advisory 告警（见上）` : "，无参数漂移"}。`
);
