#!/usr/bin/env node
/**
 * Tauri CSP 形态锁——tauri.conf.json 是严格 JSON 不能
 * 携带注释，CSP 的取舍说明与「不得再放宽」防线落在本脚本：
 *
 *  - `style-src 'self' 'unsafe-inline'`：小组件系统（内联几何/主题样式）与
 *    动效库的内联样式是结构性需求。它使「样式注入型」缺陷的爆炸半径从无
 *    变有，因此**锁死为唯一基线**——再放宽（unsafe-eval / 通配）或误删
 *    （小组件样式当场塌掉）都直接 fail。
 *  - `script-src 'self'`：锁死，禁止 unsafe-eval / unsafe-inline / 通配。
 *  - `object-src 'none'`、`base-uri 'self'`、`form-action 'self'`：锁死。
 *  - connect-src 白名单只能收不能放（比对基线集合，新增源即 fail——新增
 *    外呼需求须同步更新本脚本基线并说明用途）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const csp = conf?.app?.security?.csp;
const errors = [];

if (typeof csp !== "string" || csp.length === 0) {
  console.error("csp-lock: app.security.csp 缺失——Tauri 缺省不注入 CSP，必须显式配置");
  process.exit(1);
}

/** 解析 CSP 为指令表（小写指令名 → 源数组；值可能含空格的单源如 host）。 */
const directives = {};
for (const part of csp.split(";")) {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) continue;
  directives[tokens[0].toLowerCase()] = tokens.slice(1).map((s) => s.toLowerCase());
}

const expectSources = (name, expected, { exact = true } = {}) => {
  const got = directives[name] ?? [];
  const want = expected.map((s) => s.toLowerCase());
  const missing = want.filter((s) => !got.includes(s));
  const extra = got.filter((s) => !want.includes(s));
  if (missing.length > 0) errors.push(`${name}: 缺少锁死源 ${missing.join(" ")}`);
  if (exact && extra.length > 0) errors.push(`${name}: 出现基线外源 ${extra.join(" ")}——放宽须先更新本门禁并说明用途`);
};

// 锁死面：script/object/base/form-action 精确匹配；style 允许的基线即全量。
expectSources("script-src", ["'self'"]);
expectSources("style-src", ["'self'", "'unsafe-inline'"]);
expectSources("object-src", ["'none'"]);
expectSources("base-uri", ["'self'"]);
expectSources("form-action", ["'self'"]);
expectSources("default-src", ["'self'"]);

// connect-src：白名单只能收不能放（与 tauri.conf.json 内联白名单对账）。
const CONNECT_BASELINE = new Set([
  "'self'",
  "ipc:",
  "http://ipc.localhost",
  "https://api.open-meteo.com",
  "https://geocoding-api.open-meteo.com",
  "https://air-quality-api.open-meteo.com",
  "https://archive-api.open-meteo.com",
  "https://lrclib.net",
  "https://open.er-api.com",
  "https://api.frankfurter.app",
  "https://speed.cloudflare.com",
  "https://www.gstatic.com",
  "https://ipwho.is",
  "https://api.ip.sb"
]);
const connect = directives["connect-src"] ?? [];
const newSrc = connect.filter((s) => !CONNECT_BASELINE.has(s));
if (newSrc.length > 0) {
  errors.push(`connect-src: 新增外呼源 ${newSrc.join(" ")}——须先在本脚本基线登记并说明用途`);
}

// 通配符与危险源全指令扫荡（img/media/font 等任何指令都不例外）。
for (const [name, sources] of Object.entries(directives)) {
  for (const s of sources) {
    if (s === "*" || s === "http:" || s === "https:" || s.includes("unsafe-eval")) {
      errors.push(`${name}: 危险源 ${s}（通配 / 协议全放 / unsafe-eval 一律禁止）`);
    }
  }
}

if (errors.length > 0) {
  console.error(`csp-lock: CSP 形态偏离锁死基线（${errors.length} 处）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("csp-lock: CSP 形态与锁死基线一致（style-src 'unsafe-inline' 为小组件系统结构性基线，不得再放宽）");
