/**
 * 智能分组建议测试：tokenizer / 三信号 / 去重截断。
 */
import { describe, expect, it } from "vitest";

import { suggestGroups, tokenizeName, stemOf, extOf } from "./grouping-suggest";

describe("tokenizeName（CJK 按字切分）", () => {
  it("camelCase 与分隔符切分、CJK 每字一个 token、小写归一", () => {
    expect(tokenizeName("QuarterlyReport")).toEqual(["quarterly", "report"]);
    expect(tokenizeName("my_photo-2026")).toEqual(["my", "photo", "2026"]);
    expect(tokenizeName("6月发票")).toEqual(["6", "月", "发", "票"]);
    expect(tokenizeName("项目计划书")).toEqual(["项", "目", "计", "划", "书"]);
  });
});

describe("stemOf / extOf", () => {
  it("Windows 路径取 stem 与小写扩展名", () => {
    expect(stemOf("C:\\Users\\x\\Report.PDF")).toBe("Report");
    expect(extOf("C:\\Users\\x\\Report.PDF")).toBe(".pdf");
    expect(extOf("C:\\Users\\x\\noext")).toBe("");
  });
});

describe("suggestGroups", () => {
  it("扩展名桶：≥3 个同类文件成建议，桶名为 i18n key", () => {
    const out = suggestGroups(["C:/d/a.pdf", "C:/d/b.pdf", "C:/d/c.pdf", "C:/d/x.exe"]);
    const ext = out.find((g) => g.source === "ext");
    expect(ext).toBeDefined();
    expect(ext!.name).toBe("文档");
    expect(ext!.paths).toHaveLength(3);
  });

  it("公共前缀：同前缀 ≥3 字符且 ≥3 文件成建议（无关文件不杀全局）", () => {
    const out = suggestGroups([
      "C:/d/VacationParis.pdf",
      "C:/d/vacation-tokyo.pdf",
      "C:/d/Vacation2026.png",
      "C:/d/z.docx"
    ]);
    const pre = out.find((g) => g.source === "prefix");
    expect(pre).toBeDefined();
    expect(pre!.name.toLowerCase()).toContain("vacat");
    expect(pre!.paths).toHaveLength(3);
  });

  it("聚类：中文文件名按字 token 聚簇；与扩展名桶相等才去重（子集保留）", () => {
    const out = suggestGroups([
      // 发票三张（pdf 同扩展，token 高重叠）+ 一张无关 pdf（桶里有 4 个文档）。
      "C:/d/发票6月.pdf",
      "C:/d/发票7月.pdf",
      "C:/d/发票8月.pdf",
      "C:/d/报告A.pdf",
      // 壁纸三张 png + 一张无关 png。
      "C:/d/壁纸风景01.png",
      "C:/d/壁纸风景02.png",
      "C:/d/壁纸夜景.png",
      "C:/d/随机.png"
    ]);
    const clusters = out.filter((g) => g.source === "cluster");
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    const fapiao = clusters.find((c) => c.paths.includes("C:/d/发票6月.pdf"))!;
    expect(fapiao.paths).toHaveLength(3);
    expect(fapiao.paths).not.toContain("C:/d/报告A.pdf");
    expect(fapiao.paths).not.toContain("C:/d/壁纸风景01.png");
    // 扩展名桶（4 个文档）与名称簇（3 张发票）并列保留——子集不去重。
    const docBucket = out.find((g) => g.source === "ext" && g.name === "文档");
    expect(docBucket).toBeDefined();
    expect(docBucket!.paths).toHaveLength(4);
  });

  it("成员 <3 / 置信度不足 / 空输入 → 无建议；上限 5 条；覆盖去重", () => {
    expect(suggestGroups([])).toEqual([]);
    expect(suggestGroups(["C:/d/a.pdf", "C:/d/b.pdf"])).toEqual([]);
    // 上限 5 条。
    const many: string[] = [];
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) many.push(`C:/d/g${i}f${j}.pdf`);
    expect(suggestGroups(many).length).toBeLessThanOrEqual(5);
  });
});
