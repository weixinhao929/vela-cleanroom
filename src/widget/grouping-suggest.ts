/**
 * 智能分组建议：从一组文件路径生成"建议 → 勾选 →
 * 确认才应用"的整理建议，全部本地纯函数、无模型依赖。
 *
 * 三信号：
 * 1. 扩展名分组：8 组预置桶，≥3 个匹配文件才成建议；
 * 2. 公共前缀：文件名 stem 两两最长公共前缀（≥3 字符、≥3 文件，大小写
 *    不敏感）；
 * 3. 层次聚类：单遍凝聚——名称 token Jaccard（0.65）+ 扩展名相同（0.35）
 *    的加权相似度，合并阈值 0.55；tokenizer 按 camelCase/`_`/`-`/空格切分，
 *    **CJK 每字独立成 token**（中文文件名聚类的关键）。
 *
 * 置信度 = 0.55×簇内平均相似度 + 0.25×主导扩展名占比 + 0.2×簇规模饱和项，
 * <0.35 丢弃；路径集合被更高置信度建议完全覆盖的簇去重；按置信度降序
 * **最多 5 条**。聚类参与上限 300 文件（超限只跑扩展名/前缀两路，O(n³)
 * 聚类的保险丝）。
 *
 * 简化说明：同类桌面整理工具 相似度含 0.15 时间衰减项；我们的存量扫描结果不带
 * mtime，v1 权重并给名称/扩展名（0.65/0.35），后续扫描带时间后可补。
 */

/** 建议的扩展名桶（id 即展示名 i18n key）。 */
export const EXT_BUCKETS: { id: string; exts: string[] }[] = [
  { id: "文档", exts: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".csv"] },
  { id: "图片", exts: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic"] },
  { id: "视频", exts: [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"] },
  { id: "音频", exts: [".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a"] },
  {
    id: "代码",
    exts: [
      ".js",
      ".ts",
      ".tsx",
      ".py",
      ".rs",
      ".go",
      ".java",
      ".c",
      ".cpp",
      ".h",
      ".json",
      ".xml",
      ".yml",
      ".yaml",
      ".toml",
      ".html",
      ".css"
    ]
  },
  { id: "压缩包", exts: [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".iso"] },
  { id: "程序", exts: [".exe", ".msi", ".bat", ".cmd", ".ps1"] },
  { id: "快捷方式", exts: [".lnk", ".url"] }
];

export type SuggestSource = "ext" | "prefix" | "cluster";

export type SuggestedGroup = {
  /** 稳定 id：name:count。 */
  id: string;
  /** 展示名（ext 桶为 i18n key；prefix/cluster 为派生词）。 */
  name: string;
  source: SuggestSource;
  paths: string[];
  /** 0–1，降序展示用。 */
  confidence: number;
};

const MIN_GROUP = 3;
const MERGE_THRESHOLD = 0.55;
const MIN_CONFIDENCE = 0.35;
const MAX_SUGGESTIONS = 5;
const CLUSTER_FILE_CAP = 300;

/** 文件名 stem（去扩展名）。 */
export function stemOf(path: string): string {
  const name = path.replace(/[\\/]/g, "/").split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 扩展名（小写含点；无扩展名返回 ""）。 */
export function extOf(path: string): string {
  const name = path.replace(/[\\/]/g, "/").split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * 名称 tokenizer：camelCase / `_` / `-` / 空格切分；CJK（含假名）每字独立
 * 成 token；其余按字母数字连串。全小写归一。
 */
export function tokenizeName(stem: string): string[] {
  const out: string[] = [];
  const words = stem.replace(/[_\-.]+/g, " ").split(/(?<=[a-z0-9])(?=[A-Z])|\s+/);
  for (const w of words) {
    const runs = w.match(/[\u4e00-\u9fff\u3040-\u30ff]|[a-zA-Z0-9]+/g) ?? [];
    for (const r of runs) out.push(r.toLowerCase());
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

type ClusterFile = { path: string; stem: string; ext: string; tokens: Set<string> };

/**
 * 单遍凝聚层次聚类：反复合并平均相似度最高的簇对，直至低于阈值。
 *
 * 性能：文件两两相似度只算一次（对称矩阵预计算）；簇对的两两相似度**和**用
 * 矩阵增量维护（合并 a+b 时，新簇对任一第三簇的和 = 两个旧和相加），每轮
 * 选最佳只做查表除法——不再像旧版那样每轮从头重算全部簇对的 jaccard
 * （n=300 实测 ~870ms → 矩阵化后同一语料 <30ms）。合并顺序、平均链接
 * 语义与旧版一致：每轮取 (i<j) 顺序下平均相似度严格更大的首个簇对。
 */
function clusterFiles(files: ClusterFile[]): { files: ClusterFile[]; avgSim: number }[] {
  const n = files.length;
  /* S[i*n+j] = sim(files[i], files[j])（对称，对角线恒 0——单文件与自身不参与）。 */
  const S = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s =
        0.65 * jaccard(files[i].tokens, files[j].tokens) +
        0.35 * (files[i].ext !== "" && files[i].ext === files[j].ext ? 1 : 0);
      S[i * n + j] = s;
      S[j * n + i] = s;
    }
  }
  /* 簇用「首成员文件下标」作行号；sum[a*n+b] = 簇 a 与簇 b 的成员两两相似度和
     （对称存储）。簇内累计（sumSim/pairs）沿合并链维护，与簇间和无关。 */
  type Cluster = { ids: number[]; key: number; sumSim: number; pairs: number };
  let clusters: Cluster[] = files.map((_, i) => ({ ids: [i], key: i, sumSim: 0, pairs: 0 }));
  const sum = new Float64Array(n * n);
  const addSum = (a: number, b: number, v: number) => {
    sum[a * n + b] += v;
    sum[b * n + a] += v;
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) addSum(i, j, S[i * n + j]);
  for (;;) {
    let best: { i: number; j: number; s: number } | null = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // 平均链接：两簇成员两两相似度取均值。
        const s = sum[clusters[i].key * n + clusters[j].key] / (clusters[i].ids.length * clusters[j].ids.length);
        if (s >= MERGE_THRESHOLD && (!best || s > best.s)) best = { i, j, s };
      }
    }
    if (!best) break;
    const a = clusters[best.i];
    const b = clusters[best.j];
    // 新簇沿用 a 的行号：对每个第三簇把 b 的和并入（Lance-Williams 式增量）。
    for (const c of clusters) {
      if (c === a || c === b) continue;
      addSum(a.key, c.key, sum[b.key * n + c.key]);
    }
    const merged: Cluster = {
      ids: [...a.ids, ...b.ids],
      key: a.key,
      // 簇内平均：a 内对 + b 内对 + 本次合并的跨对（sum 矩阵里现成的两簇和）。
      sumSim: a.sumSim + b.sumSim + sum[a.key * n + b.key],
      pairs: a.pairs + b.pairs + a.ids.length * b.ids.length
    };
    clusters = clusters.filter((_, idx) => idx !== best!.i && idx !== best!.j);
    clusters.push(merged);
  }
  return clusters.map((c) => ({
    files: c.ids.map((i) => files[i]),
    avgSim: c.pairs === 0 ? 0 : c.sumSim / c.pairs
  }));
}

/** 公共前缀成组：stem 小写排序后按代表元分段（同段与前缀 ≥3 字符），
 *  段内前缀 = 首尾 LCP；≥3 成员的段才成建议。可产出多组。 */
function prefixGroups(files: ClusterFile[]): SuggestedGroup[] {
  const sorted = [...files].sort((a, b) => (a.stem.toLowerCase() < b.stem.toLowerCase() ? -1 : 1));
  const segments: ClusterFile[][] = [];
  let cur: ClusterFile[] = [];
  let rep = "";
  for (const f of sorted) {
    const s = f.stem.toLowerCase();
    if (!cur.length) {
      cur = [f];
      rep = s;
      continue;
    }
    let i = 0;
    while (i < rep.length && i < s.length && rep[i] === s[i]) i++;
    if (i >= 3) cur.push(f);
    else {
      segments.push(cur);
      cur = [f];
      rep = s;
    }
  }
  if (cur.length) segments.push(cur);
  const out: SuggestedGroup[] = [];
  for (const seg of segments) {
    if (seg.length < MIN_GROUP) continue;
    const first = seg[0].stem.toLowerCase();
    const last = seg[seg.length - 1].stem.toLowerCase();
    let i = 0;
    while (i < first.length && i < last.length && first[i] === last[i]) i++;
    const prefix = first.slice(0, i);
    if (prefix.length < 3) continue;
    out.push({
      id: `${prefix}:${seg.length}`,
      name: `${prefix}…`,
      source: "prefix",
      paths: seg.map((f) => f.path),
      confidence: Math.min(1, 0.5 + prefix.length / 12 + seg.length / 20)
    });
  }
  return out;
}

/**
 * 建议主管线（纯函数）：paths 为扫描命中的文件路径。返回按置信度降序、
 * 去重后最多 5 条的建议。
 */
export function suggestGroups(paths: string[]): SuggestedGroup[] {
  const files: ClusterFile[] = Array.from(new Set(paths))
    .filter((p) => p && !p.endsWith("\\") && !p.endsWith("/"))
    .map((p) => {
      const stem = stemOf(p);
      return { path: p, stem, ext: extOf(p), tokens: new Set(tokenizeName(stem)) };
    });
  if (files.length < MIN_GROUP) return [];
  const out: SuggestedGroup[] = [];

  // 1) 扩展名桶。
  for (const bucket of EXT_BUCKETS) {
    const hit = files.filter((f) => bucket.exts.includes(f.ext));
    if (hit.length >= MIN_GROUP) {
      out.push({
        id: `${bucket.id}:${hit.length}`,
        name: bucket.id,
        source: "ext",
        paths: hit.map((f) => f.path),
        confidence: Math.min(1, 0.55 + hit.length / (files.length * 1.5))
      });
    }
  }

  // 2) 公共前缀分段成组（可多组）。
  out.push(...prefixGroups(files));

  // 3) 聚类（保险丝：超上限跳过）。
  if (files.length <= CLUSTER_FILE_CAP) {
    for (const c of clusterFiles(files)) {
      if (c.files.length < MIN_GROUP) continue;
      const exts = new Map<string, number>();
      for (const f of c.files) exts.set(f.ext, (exts.get(f.ext) ?? 0) + 1);
      const dominant = Math.max(...exts.values()) / c.files.length;
      const confidence = 0.55 * c.avgSim + 0.25 * dominant + 0.2 * Math.min(1, c.files.length / 6);
      if (confidence < MIN_CONFIDENCE) continue;
      // 簇名：最高频 token（同频取字典序，保证稳定）。
      const freq = new Map<string, number>();
      for (const f of c.files) for (const t of f.tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
      let top = "";
      let topN = 0;
      for (const [t, n] of freq) {
        if (n > topN || (n === topN && t < top)) {
          top = t;
          topN = n;
        }
      }
      out.push({
        id: `${top}:${c.files.length}`,
        name: top,
        source: "cluster",
        paths: c.files.map((f) => f.path),
        confidence
      });
    }
  }

  // 去重：路径集合与更高置信度建议**完全相等**的丢弃（子集保留——名称簇
  // 是扩展名桶的有价值细分，两者并列展示）；按置信度降序取前 5。
  const sorted = out.sort((a, b) => b.confidence - a.confidence);
  const kept: SuggestedGroup[] = [];
  for (const g of sorted) {
    const dup = kept.some((k) => k.paths.length === g.paths.length && g.paths.every((p) => k.paths.includes(p)));
    if (!dup) kept.push(g);
  }
  return kept.slice(0, MAX_SUGGESTIONS);
}
