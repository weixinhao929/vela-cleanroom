#!/usr/bin/env node
/**
 * M1（文档对账门禁）：docs/API.md 与 lib.rs invoke_handler 注册表的机器 diff。
 *
 * 「生成物即契约」文化的文档侧补齐（同类：gen:types 的 ts-rs 绑定）：命令面
 * 是手写文档最容易漂移的地方——新增命令忘写、改名忘同步、返回类型与实现脱节，
 * 评审靠肉眼抓不全。本脚本做三件事：
 *   1. 从 lib.rs 的 generate_handler! 提取全部注册命令（支持 `module::name`
 *      与 lib.rs 本体定义的裸名两种书写；先剥行注释，防注释里的 `]` 截断块）；
 *   2. 从 API.md 命令表（首格）提取文档化命令（纯 snake_case token；
 *      带冒号的事件名天然不参与比对）；
 *   3. 双向 diff + 文档头部声称的数量核对。任一不一致即非零退出。
 *
 * 用法：npm run lint:api（--update 无参数化需求，文档漂移一律手改 API.md）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libPath = join(root, "src-tauri", "src", "lib.rs");
const docPath = join(root, "docs", "API.md");

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

if (problems.length) {
  console.error("lint:api: API.md 与注册表不一致 ——\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`lint:api OK：${regSet.size} 个注册命令全部文档对齐（无多余、无缺失、无重复）。`);
