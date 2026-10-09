/**
 * 文件浏览小组件纯逻辑测试：
 *  - displayFileName 三态（完整 / 去扩展名 / 仅图标）与 stripExt 边界；
 *  - sortEntries：目录前置、类型聚簇排序、别名感知的名称序；
 *  - 预览分类（图片 / 可文本预览）。
 */
import { describe, expect, it } from "vitest";
import {
  displayFileName,
  isImageFile,
  isTextPreviewable,
  sortEntries,
  stripExt,
  truncateCrumbs
} from "./FileBrowserWidget";

type Entry = { name: string; path: string; is_dir: boolean; size: number | null; modified: string | null };
const e = (name: string, is_dir = false): Entry => ({
  name,
  path: `C:/d/${name}`,
  is_dir,
  size: null,
  modified: null
});

describe("displayFileName / stripExt", () => {
  it("full 原样返回", () => {
    expect(displayFileName("终版_v3.docx", "full")).toBe("终版_v3.docx");
  });
  it("noext 去掉最后一个扩展名；无扩展名 / 点开头文件名不受影响", () => {
    expect(displayFileName("终版_v3.docx", "noext")).toBe("终版_v3");
    expect(displayFileName("README", "noext")).toBe("README");
    expect(displayFileName(".gitignore", "noext")).toBe(".gitignore");
    expect(stripExt("a.b.c.txt")).toBe("a.b.c");
  });
  it("noname 返回空串（仅图标）", () => {
    expect(displayFileName("x.png", "noname")).toBe("");
  });
});

describe("sortEntries", () => {
  it("目录始终在前（B9 前置不变式）", () => {
    const out = sortEntries([e("z.txt"), e("子目录", true), e("a.txt")], "name", "asc");
    expect(out[0].name).toBe("子目录");
  });
  it("type：扩展名聚簇，同扩展名内按名称（B9）", () => {
    const out = sortEntries([e("b.md"), e("a.png"), e("a.md"), e("z.png")], "type", "asc");
    expect(out.map((x) => x.name)).toEqual(["a.md", "b.md", "a.png", "z.png"]);
  });
  it("type 降序：扩展名倒排，组内名称也倒排", () => {
    const out = sortEntries([e("a.md"), e("b.png")], "type", "desc");
    expect(out.map((x) => x.name)).toEqual(["b.png", "a.md"]);
  });
  it("名称排序经 nameOf 别名感知（B8）", () => {
    const alias: Record<string, string> = { "C:/d/c.txt": "啊最前" };
    const nameOf = (x: Entry) => alias[x.path] ?? x.name;
    // c.txt 显示为「啊最前」，按显示名应排在 b.txt 之前。
    const out = sortEntries([e("b.txt"), e("c.txt")], "name", "asc", nameOf);
    expect(out.map((x) => x.name)).toEqual(["c.txt", "b.txt"]);
  });
});

describe("预览分类（B5）", () => {
  it("图片扩展名识别", () => {
    expect(isImageFile("a.PNG")).toBe(true);
    expect(isImageFile("a.mp4")).toBe(false);
  });
  it("文本预览白名单", () => {
    expect(isTextPreviewable("notes.md")).toBe(true);
    expect(isTextPreviewable("main.rs")).toBe(true);
    expect(isTextPreviewable("photo.jpg")).toBe(false);
    expect(isTextPreviewable("app.exe")).toBe(false);
  });
});

describe("面包屑收敛（truncateCrumbs）", () => {
  const segs = ["C:", "Users", "x", "Desktop", "工作"];
  it("未超保留段数：原样返回、不折叠", () => {
    expect(truncateCrumbs(segs.slice(0, 2), 2)).toEqual({ items: segs.slice(0, 2), truncated: false });
  });
  it("超段数：只留最后 keep 段并标记折叠", () => {
    expect(truncateCrumbs(segs, 2)).toEqual({ items: ["Desktop", "工作"], truncated: true });
    expect(truncateCrumbs(segs, 3)).toEqual({ items: ["x", "Desktop", "工作"], truncated: true });
  });
  it("keep 至少为 1（防呆）", () => {
    expect(truncateCrumbs(segs, 0)).toEqual({ items: ["工作"], truncated: true });
    expect(truncateCrumbs(["仅一段"], 0)).toEqual({ items: ["仅一段"], truncated: false });
  });
});
