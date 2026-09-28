#!/usr/bin/env node
// A-5：窗口闸门清单扫描（advisory，恒 exit 0）。自定义 Tauri 命令不受
// capability 门控，任何 webview 都能调用——带 Window/WebviewWindow 参数的
// 命令必须有 trusted_window / settings_only_window / require_trusted /
// require_settings_window 之一的闸门（或内联 label 白名单判断）。新增命令
// 漏写门控没有编译期提示，本脚本把「带窗口参数但正文无任何闸门痕迹」的
// 命令列成清单：新条目出现时人工复核是否需要补闸（无窗口访问面的命令
// 可加 `// gate: none needed（<原因>）` 标注豁免，从清单消掉）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] ?? "src-tauri/src");
const GATE_RE =
  /trusted_window\s*\(|settings_only_window\s*\(|require_trusted\s*\(|require_settings_window\s*\(|label(?:\(\))?\s*[!=]=\s*"|label\s*\(\)\s*\.\s*starts_with\(|gate:\s*none/i;

function walkRs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkRs(p, out);
    else if (ent.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

const files = walkRs(ROOT);
const flagged = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  // 逐命令切分：#[tauri::command] 到下一个 #[tauri::command] / EOF。
  const cmdRe = /#\[tauri::command\]/g;
  const starts = [];
  let m;
  while ((m = cmdRe.exec(src)) !== null) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const seg = src.slice(starts[i], starts[i + 1] ?? src.length);
    const fn = /\bfn\s+([a-z_][a-z0-9_]*)/i.exec(seg);
    if (!fn) continue;
    const hasWindowParam = /(?:window|win)\s*:\s*(?:tauri::)?(?:Webview)?Window\b/.test(seg);
    if (!hasWindowParam) continue;
    if (GATE_RE.test(seg)) continue;
    const line = src.slice(0, starts[i]).split("\n").length;
    flagged.push(`  ${path.relative(process.cwd(), f).replace(/\\/g, "/")}:${line}  ${fn[1]}`);
  }
}

if (flagged.length === 0) {
  console.log("check-window-gates: 带窗口参数的命令均有闸门痕迹（或已标注豁免）");
} else {
  console.warn(
    `check-window-gates: ${flagged.length} 个带窗口参数的命令正文无闸门痕迹（复核是否需要补闸；确认无窗口访问面可加 // gate: none 标注）：`
  );
  console.warn(flagged.join("\n"));
}
