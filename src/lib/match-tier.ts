/**
 * Spotlight 五级 match-tier 评分（SPOT 共享工具）。
 *
 * 把「布尔匹配」升级为「带分匹配」：exact > prefix > 词首 > 子串 > 子序列
 * 五级分档，五级分档（exact 5000 / prefix 4000 /
 * 词首 3000 / 子串 2000 / 子序列 1000），字段权重 name 80 / generic 60 /
 * keywords 40 / id 20，跨字段取最大分。总分 = 分档基分 + 字段权重，档间
 * 差距（1000）远大于最大权重（80），保证「先按档排、同档内按字段排」。
 *
 * 消费方（命令面板、应用启动器）保留各自的使用频率主序，match-tier 作
 * 次级排序键；后续文件搜索模式可直接复用本模块。
 *
 * 命中定义（对单个字段文本，大小写不敏感）：
 *  - exact       查询词与整个字段相等；
 *  - prefix      字段以查询词开头；
 *  - wordStart   查询词出现在某个「词首」位置（串首 / 分隔符后 / camelCase
 *                大写边界 / 任一汉字，汉字自身即词首，如「网易云音乐」搜「音乐」）；
 *  - substring   字段包含查询词；
 *  - subsequence 查询词逐字符按序出现在字段中（顺序不对不命中）。
 */

/** 五级分档基分（数值越大档位越高）。 */
export const TIER_BASE = {
  subsequence: 1000,
  substring: 2000,
  wordStart: 3000,
  prefix: 4000,
  exact: 5000
} as const;

/** 字段权重：主名称最强，标识符最弱。 */
export const FIELD_WEIGHT = {
  name: 80,
  generic: 60,
  keywords: 40,
  id: 20
} as const;

export type MatchTierName = keyof typeof TIER_BASE;
export type MatchFieldName = keyof typeof FIELD_WEIGHT;

/** 多字段输入：全部可选，空字段跳过。 */
export type MatchFields = Partial<Record<MatchFieldName, string>>;

/** 单字段的五级分档（无命中返回 null）。 */
export type MatchTier = MatchTierName | null;

/** 词首判定中的「分隔符」：非字母数字非汉字的字符（空格、-、_、.、/、括号…）。 */
function isSeparator(ch: string): boolean {
  return !/[a-z0-9\u4e00-\u9fff]/i.test(ch);
}

/**
 * 判断 orig 的第 i 个字符是否处于词首位置。
 * 词首 = 串首 / 分隔符之后 / camelCase 小写(或数字)→大写边界 / 前一个字符是汉字
 * （每个汉字都是一个独立词的首字，中文应用名「网易云音乐」搜「云音乐」应命中词首档）。
 */
function isWordStart(orig: string, i: number): boolean {
  if (i === 0) return true;
  const prev = orig[i - 1];
  const cur = orig[i];
  if (isSeparator(prev)) return true;
  if (/[\u4e00-\u9fff]/.test(prev)) return true;
  if (cur !== cur.toLowerCase() && (prev === prev.toLowerCase() || /[0-9]/.test(prev))) return true;
  return false;
}

/**
 * 单字段五级分档。
 *
 * @param text - 字段原文（任意大小写）。
 * @param query - 查询词（任意大小写；去空白后为空返回 null）。
 * @returns 命中的最高档位，未命中返回 null。
 *
 * @example
 * ```ts
 * matchTierOf("Chrome", "chr");   // "prefix"
 * matchTierOf("Visual Studio Code", "studio"); // "wordStart"
 * matchTierOf("Chrome", "hro");   // "substring"
 * matchTierOf("Chrome", "ce");    // "subsequence"
 * matchTierOf("Chrome", "zoom");  // null
 * ```
 */
export function matchTierOf(text: string, query: string): MatchTier {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (text.length < q.length) return null;
  if (text.toLowerCase() === q) return "exact";
  if (text.toLowerCase().startsWith(q)) return "prefix";
  // 词首档：查询词整体出现在任一词首位置（slice 逐段小写比较，保留原文做大写边界判定）。
  for (let i = 0; i + q.length <= text.length; i++) {
    if (text.slice(i, i + q.length).toLowerCase() === q && isWordStart(text, i)) {
      return "wordStart";
    }
  }
  const t = text.toLowerCase();
  if (t.includes(q)) return "substring";
  // 子序列档：查询词的每个字符都按顺序出现在字段里。
  let idx = 0;
  for (const c of q) {
    const found = t.indexOf(c, idx);
    if (found === -1) return null;
    idx = found + 1;
  }
  return "subsequence";
}

/**
 * 多字段带分匹配：每个字段独立判档，取「分档基分 + 字段权重」的最大值。
 *
 * @param fields - 各字段文本（空/缺省字段跳过）。
 * @param query - 查询词；去空白后为空返回 0（调用方需自行处理「空查询=全匹配」语义）。
 * @returns 最高分；任一字段都不命中返回 0。
 *
 * @example
 * ```ts
 * scoreMatch({ name: "网易云音乐", keywords: "wyyy" }, "wyy"); // 4040（首字母前缀档）
 * scoreMatch({ name: "网易云音乐" }, "wyy");                   // 0（不含首字母字段）
 * ```
 */
export function scoreMatch(fields: MatchFields, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best = 0;
  for (const field of Object.keys(FIELD_WEIGHT) as MatchFieldName[]) {
    const text = fields[field];
    if (!text) continue;
    const tier = matchTierOf(text, q);
    if (!tier) continue;
    const s = TIER_BASE[tier] + FIELD_WEIGHT[field];
    if (s > best) best = s;
  }
  return best;
}
