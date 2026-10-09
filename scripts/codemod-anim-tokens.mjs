// 一次性 codemod：把 transition/animation 声明里的裸时长与裸 ease 关键字
// 归一到 --dur-* / --ease-* / --anim-dur 令牌（anim-token 存量归一）。
//
// 映射表（ms → token，偏差 ≤10%，与 feature-animations.css 的 100% 标准档对应）：
//   100/110/120/130 → var(--dur-fx-xfast, .12s)
//   140/150/160     → var(--dur-fx-fast, .15s)
//   180/200/220     → var(--dur-fx, .2s)
//   250             → var(--anim-dur, .25s)
//   280/300         → var(--dur-fx-slow, .3s)
//   350             → var(--dur-spatial-fast, .35s)
//   450             → var(--dur-dock-spring, .45s)
//   500             → var(--dur-spatial, .5s)
//   650             → var(--dur-spatial-slow, .65s)
//   ease → var(--ease-fx, ease)；ease-out → var(--ease-out, ease-out)；
//   ease-in → var(--ease-in, ease-in)；ease-in-out / linear / steps() 不动。
//
// 保护措施：
//   - 注释与 var(--token[, fallback]) 先占位再还原——绝不在注释或 var 回退值里改写；
//   - 含 calc(<时长>… 的声明整条跳过（--fx-scale 自缩放族与既有的 calc 配对声明，
//     再套 token 会双重缩放）；
//   - ≥1s 的常驻/氛围动画不改（跟随速度三档没有意义）。
//
// 运行：node scripts/codemod-anim-tokens.mjs   （幂等，可重复执行）
import fs from "node:fs";
import path from "node:path";

function walkCss(dirPath, out = []) {
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkCss(p, out);
    else if (ent.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const DUR_MAP = {
  100: "var(--dur-fx-xfast, 0.12s)",
  110: "var(--dur-fx-xfast, 0.12s)",
  120: "var(--dur-fx-xfast, 0.12s)",
  130: "var(--dur-fx-xfast, 0.12s)",
  140: "var(--dur-fx-fast, 0.15s)",
  150: "var(--dur-fx-fast, 0.15s)",
  160: "var(--dur-fx-fast, 0.15s)",
  180: "var(--dur-fx, 0.2s)",
  200: "var(--dur-fx, 0.2s)",
  220: "var(--dur-fx, 0.2s)",
  250: "var(--anim-dur, 0.25s)",
  280: "var(--dur-fx-slow, 0.3s)",
  300: "var(--dur-fx-slow, 0.3s)",
  350: "var(--dur-spatial-fast, 0.35s)",
  450: "var(--dur-dock-spring, 0.45s)",
  500: "var(--dur-spatial, 0.5s)",
  650: "var(--dur-spatial-slow, 0.65s)"
};

const files = walkCss("src");
// lead 必须是捕获组：回调按 (match, lead, prop, value) 解构，非捕获组会让
// match 整体落到 lead 参数上，重写时把原声明 + 新声明双双写回（已踩坑）。
const declRe = /(^|[;{\n]\s*)((?:transition|animation)(?:-property|-duration|-timing-function)?)\s*:\s*([^;{}]+);/g;
let totalDur = 0;
let totalEase = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const spans = [];
  const protect = (re, text) => text.replace(re, (m) => `\u0000${spans.push(m) - 1}\u0000`);
  const restore = (text) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);

  let css = protect(/\/\*[\s\S]*?\*\//g, raw);
  css = protect(/var\((?:[^()]|\([^()]*\))*\)/g, css);

  let durCount = 0;
  let easeCount = 0;
  css = css.replace(declRe, (match, lead, prop, value) => {
    if (/calc\(\s*[\d.]+m?s\b/.test(value)) return lead + `${prop}: ${value};`;
    let v = value;
    v = v.replace(/(^|[\s,])(\d+(?:\.\d+)?|\.\d+)(m?s)\b/g, (m, pre, num, unit) => {
      const ms = unit === "s" ? Math.round(parseFloat(num) * 1000) : parseInt(num, 10);
      const token = DUR_MAP[ms];
      if (!token) return m;
      durCount++;
      return `${pre}${token}`;
    });
    v = v.replace(/(^|[\s,])ease-in-out(?=[\s;,)]|$)/g, "$1ease-in-out"); // 保留（无对应 token）
    v = v.replace(/(^|[\s,])ease-out(?=[\s;,)]|$)/g, (m, pre) => {
      easeCount++;
      return `${pre}var(--ease-out, ease-out)`;
    });
    v = v.replace(/(^|[\s,])ease-in(?=[\s;,)]|$)/g, (m, pre) => {
      easeCount++;
      return `${pre}var(--ease-in, ease-in)`;
    });
    v = v.replace(/(^|[\s,])ease(?=[\s;,)]|$)/g, (m, pre) => {
      easeCount++;
      return `${pre}var(--ease-fx, ease)`;
    });
    return `${lead}${prop}: ${v};`;
  });

  css = restore(css);
  if (durCount + easeCount > 0) {
    fs.writeFileSync(file, css);
    totalDur += durCount;
    totalEase += easeCount;
    console.log(`${path.relative(process.cwd(), file).replace(/\\/g, "/")}: 时长 ${durCount} / ease ${easeCount}`);
  }
}
console.log(`[codemod-anim-tokens] 完成：裸时长 → token ${totalDur} 处，裸 ease → token ${totalEase} 处。`);
