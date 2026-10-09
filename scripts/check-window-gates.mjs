#!/usr/bin/env node
// 窗口闸门清单扫描（后为硬门禁：清单非空即 exit 1）。自定义 Tauri 命令不受
// capability 门控，任何 webview 都能调用——带 Window/WebviewWindow 参数的
// 命令必须有 trusted_window / settings_only_window / require_trusted /
// require_settings_window 之一的闸门（或内联 label 白名单判断）。新增命令
// 漏写门控没有编译期提示，本脚本把「带窗口参数但正文无任何闸门痕迹」的
// 命令列成清单：新条目出现时人工复核是否需要补闸（无窗口访问面的命令
// 可加 `// gate: none needed（<原因>）` 标注豁免，从清单消掉）。
//
// （全局深审）：**无窗口参数**的命令不再默认豁免——此前它们不在扫描
// 范围（灵动岛审查 记入的盲区），web-preview 远程页因此可调
// check_paths_exist / window_ops 族等敏感命令（现已全部补闸）。现在无窗口
// 参数的命令必须带 `// gate: none needed（<原因>）` 显式豁免，否则进清单；
// 新命令默认应带 window 参数并挂闸门，而不是依赖人工想起。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] ?? "src-tauri/src");
const GATE_RE =
  /trusted_window\s*\(|settings_only_window\s*\(|enum_system_window\s*\(|local_ui_window\s*\(|require_trusted\s*\(|require_settings_window\s*\(|require_local_ui\s*\(|label(?:\(\))?\s*[!=]=\s*"|label\s*\(\)\s*\.\s*starts_with\(|gate:\s*none/i;

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
const noWindow = [];
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
    const line = src.slice(0, starts[i]).split("\n").length;
    const rel = `${path.relative(process.cwd(), f).replace(/\\/g, "/")}:${line}  ${fn[1]}`;
    const hasWindowParam = /(?:window|win)\s*:\s*(?:tauri::)?(?:Webview)?Window\b/.test(seg);
    if (!hasWindowParam) {
      // 无窗口参数 = 默认禁止（任何 webview 含 web-preview 均可调），
      // 除非命令正文带显式豁免标注。
      if (!GATE_RE.test(seg)) noWindow.push(rel);
      continue;
    }
    if (GATE_RE.test(seg)) continue;
    flagged.push(rel);
  }
}

const problems = [];
if (flagged.length > 0) {
  problems.push(
    `check-window-gates: ${flagged.length} 个带窗口参数的命令正文无闸门痕迹（复核是否需要补闸；确认无窗口访问面可加 // gate: none 标注）：\n` +
      flagged.map((s) => "  " + s).join("\n")
  );
}
if (noWindow.length > 0) {
  problems.push(
    `check-window-gates: ${noWindow.length} 个命令无窗口参数且无豁免标注（E-6：默认禁止——任何 webview（含 web-preview 远程页）均可调；补 window 参数挂闸门，或加 // gate: none needed（原因） 显式豁免）：\n` +
      noWindow.map((s) => "  " + s).join("\n")
  );
}
if (problems.length === 0) {
  console.log("check-window-gates: 带窗口参数的命令均有闸门痕迹（或已标注豁免）；无窗口参数的命令均有豁免标注");
} else {
  console.warn(problems.join("\n\n"));
  // 全量补闸后清单基线为空，新条目 = 漏闸命令——
  // 从 advisory 升级为硬门禁，防止清单再次变非空而无告警。
  process.exit(1);
}
