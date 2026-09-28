import { describe, expect, it } from "vitest";
import { matchTierOf, scoreMatch, FIELD_WEIGHT, TIER_BASE } from "./match-tier";

describe("matchTierOf —— 五级分档边界", () => {
  it("exact：查询词与整个字段相等（大小写不敏感）", () => {
    expect(matchTierOf("Chrome", "chrome")).toBe("exact");
    expect(matchTierOf("chrome", "CHROME")).toBe("exact");
    expect(matchTierOf("微信", "微信")).toBe("exact");
  });

  it("prefix：真前缀（去掉首字符即不再命中）", () => {
    expect(matchTierOf("Chrome", "chr")).toBe("prefix");
    expect(matchTierOf("网易云音乐", "网易")).toBe("prefix");
    // 整串相等应升到 exact 而非 prefix。
    expect(matchTierOf("Chrome", "chrome".slice(0, 6))).toBe("exact");
  });

  it("wordStart：空格分隔词首 / camelCase 边界 / 分隔符后 / 汉字字首", () => {
    expect(matchTierOf("Visual Studio Code", "studio")).toBe("wordStart");
    expect(matchTierOf("QuickNote", "note")).toBe("wordStart");
    expect(matchTierOf("7-Zip", "zip")).toBe("wordStart");
    // 每个汉字自身即词首：搜「音乐」命中词首档而非子串档。
    expect(matchTierOf("网易云音乐", "音乐")).toBe("wordStart");
  });

  it("substring：命中在词中（非词首）时才落子串档", () => {
    expect(matchTierOf("Chrome", "hro")).toBe("substring");
    // 「udio」在 studio 词中 → 子串而非词首。
    expect(matchTierOf("Visual Studio Code", "udio")).toBe("substring");
  });

  it("subsequence：字符按序出现即可，顺序错误不命中", () => {
    expect(matchTierOf("Chrome", "ce")).toBe("subsequence");
    expect(matchTierOf("Chrome", "cm")).toBe("subsequence");
    expect(matchTierOf("Chrome", "hc")).toBeNull();
  });

  it("未命中 / 边界情形", () => {
    expect(matchTierOf("Chrome", "zoom")).toBeNull();
    expect(matchTierOf("Chrome", "chromex")).toBeNull(); // 查询比字段长
    expect(matchTierOf("Chrome", "")).toBeNull(); // 空查询不判档
    expect(matchTierOf("", "a")).toBeNull();
  });

  it("分档基分严格递增且档差大于最大字段权重（保证先按档排）", () => {
    expect(TIER_BASE.exact).toBeGreaterThan(TIER_BASE.prefix);
    expect(TIER_BASE.prefix).toBeGreaterThan(TIER_BASE.wordStart);
    expect(TIER_BASE.wordStart).toBeGreaterThan(TIER_BASE.substring);
    expect(TIER_BASE.substring).toBeGreaterThan(TIER_BASE.subsequence);
    expect(TIER_BASE.substring - TIER_BASE.subsequence).toBeGreaterThan(Math.max(...Object.values(FIELD_WEIGHT)));
  });
});

describe("scoreMatch —— 多字段取最大（档 × 字段权重）", () => {
  it("同档不同字段：主名称权重高于关键词", () => {
    const s = scoreMatch({ name: "Steam 客户端", keywords: "steam" }, "ste");
    expect(s).toBe(TIER_BASE.prefix + FIELD_WEIGHT.name);
  });

  it("跨字段取最大：名称不命中时落到首字母字段", () => {
    // 「wyy」是「网易云音乐」首字母串 wyyy 的前缀 → prefix 档 + keywords 权重。
    expect(scoreMatch({ name: "网易云音乐", keywords: "wyyy" }, "wyy")).toBe(TIER_BASE.prefix + FIELD_WEIGHT.keywords);
    // 不带首字母字段时同样的查询不命中。
    expect(scoreMatch({ name: "网易云音乐" }, "wyy")).toBe(0);
  });

  it("高档弱字段 > 低档强字段（档间差距压倒字段权重）", () => {
    const subseqOnName = scoreMatch({ name: "chrome" }, "ce"); // 子序列 + 80
    const exactOnId = scoreMatch({ id: "ce" }, "ce"); // exact + 20
    expect(exactOnId).toBeGreaterThan(subseqOnName);
  });

  it("空查询返回 0（空查询语义由调用方处理）", () => {
    expect(scoreMatch({ name: "Chrome" }, "")).toBe(0);
    expect(scoreMatch({ name: "Chrome" }, "   ")).toBe(0);
  });

  it("空字段跳过、全部未命中返回 0", () => {
    expect(scoreMatch({}, "chr")).toBe(0);
    expect(scoreMatch({ generic: undefined, keywords: "" }, "chr")).toBe(0);
  });
});
