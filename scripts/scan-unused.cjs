const fs = require("fs");
const path = require("path");
const root = "src";
function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
let total = 0;
for (const file of walk(root)) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  // collect import specifiers with their line indices
  const importLines = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ")) return;
    if (trimmed.startsWith("import type")) {
      // still may import named types
    }
    // extract names after { ... } or default
    const m = trimmed.match(/^import\s+(?:type\s+)?(?:\{([^}]*)\}|([A-Za-z0-9_$]+))(?:\s*,\s*\{([^}]*)\})?\s+from/);
    if (!m) return;
    const names = [];
    const clean = (s) =>
      s
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop();
    if (m[1]) names.push(...m[1].split(",").map(clean).filter(Boolean));
    if (m[2]) names.push(clean(m[2]));
    if (m[3]) names.push(...m[3].split(",").map(clean).filter(Boolean));
    importLines.push({ line: i, names });
  });
  for (const imp of importLines) {
    for (const n of imp.names) {
      if (n === "default" || n === "*") continue;
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("\\b" + esc + "\\b", "g");
      let count = 0;
      let commentOnly = true;
      lines.forEach((line, i) => {
        if (i === imp.line) return;
        const hits = line.match(re) || [];
        if (hits.length === 0) return;
        count += hits.length;
        // strip comments to see if any usage is in real code
        const code = line
          .replace(/\/\/.*$/, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/['"`][^'"`]*['"`]/g, "");
        if (re.test(code)) commentOnly = false;
      });
      if (count === 0 || commentOnly) {
        console.log(file + ":" + (imp.line + 1) + " : " + n + (commentOnly ? " (comment-only)" : ""));
        total++;
      }
    }
  }
}
console.log("TOTAL potentially unused: " + total);
