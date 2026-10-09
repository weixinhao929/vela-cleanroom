#!/usr/bin/env node
/**
 * i18n 重复键检查（只读）。
 *
 * 历史版本会直接**重写** src/i18n.ts：它只认带引号的 `"键": "值"`，把不带引号的
 * `键: "值"`（Prettier quoteProps: as-needed 的默认产物，占字典 3/4）全部丢掉——
 * 一次误运行就删掉了 ~1700 条映射。现在只报告重复键并以非零退出，不写文件；
 * 重复键本就会被 tsc 以 拦下，这里只是给出更直接的定位。
 *
 * 用法：node scripts/dedupe-i18n.cjs
 */
const fs = require("fs");
const path = require("path");

const file = path.resolve(__dirname, "..", "src", "i18n.ts");
const src = fs.readFileSync(file, "utf8");
const m = src.match(/const ZH_TO_EN: Record<string, string> = \{([\s\S]*?)\n\};/);
if (!m) {
  console.error("dedupe-i18n: 未找到 ZH_TO_EN 映射表");
  process.exit(2);
}

const re = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"'`/[{}][^:\n]*?))\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/gm;
const seen = new Map();
const dups = [];
let mm;
while ((mm = re.exec(m[1]))) {
  const key = mm[1] ?? mm[2];
  const line = src.slice(0, m.index + mm.index).split("\n").length;
  if (seen.has(key)) dups.push([key, seen.get(key), line]);
  else seen.set(key, line);
}

console.log(`dedupe-i18n: 共 ${seen.size + dups.length} 条映射，唯一键 ${seen.size} 个`);
if (dups.length === 0) {
  console.log("dedupe-i18n: OK，无重复键（本脚本只读，不会改写 i18n.ts）");
  process.exit(0);
}
console.error(`dedupe-i18n: 重复键 ${dups.length} 个：`);
for (const [k, first, again] of dups) console.error(`  DUP: ${k}  首见 :${first}，重复 :${again}`);
process.exit(1);
