import { describe, expect, it } from "vitest";
import type { ClipboardEntry } from "../../types/bindings/ClipboardEntry";
import { entryTitle, filesListOf, lineCountOf, sortEntries } from "./clipboard-shared";

function textEntry(
  id: string,
  createdAt: string,
  preview: string,
  text: string | null,
  pinned = false
): ClipboardEntry {
  return {
    id,
    kind: "text",
    preview,
    text,
    image_file: null,
    image_w: null,
    image_h: null,
    image_bytes: 0,
    files: null,
    source_app: null,
    pinned,
    created_at: createdAt
  };
}

function imageEntry(id: string, createdAt: string, w: number, h: number): ClipboardEntry {
  return {
    id,
    kind: "image",
    preview: "",
    text: null,
    image_file: `${id}.png`,
    image_w: w,
    image_h: h,
    image_bytes: 1234,
    files: null,
    source_app: null,
    pinned: false,
    created_at: createdAt
  };
}

function filesEntry(id: string, createdAt: string, paths: string[], pinned = false): ClipboardEntry {
  return {
    id,
    kind: "files",
    preview: paths.join(", "),
    text: null,
    image_file: null,
    image_w: null,
    image_h: null,
    image_bytes: 0,
    files: JSON.stringify(paths),
    source_app: null,
    pinned,
    created_at: createdAt
  };
}

describe("clipboard-shared lineCountOf", () => {
  it("单行 / 多行 / 结尾换行 / 空值", () => {
    expect(lineCountOf(null)).toBe(0);
    expect(lineCountOf("")).toBe(0);
    expect(lineCountOf("one line")).toBe(1);
    expect(lineCountOf("a\nb\nc")).toBe(3);
    expect(lineCountOf("a\nb\n")).toBe(2);
    expect(lineCountOf("a\r\nb")).toBe(2);
    expect(lineCountOf("\n\n\n")).toBe(3);
  });
});

describe("clipboard-shared sortEntries", () => {
  it("置顶在前，其余按时间倒序，且不改原数组", () => {
    const old = textEntry("old", "2026-01-01T00:00:00.000Z", "old", "old", true);
    const a = textEntry("a", "2026-01-03T00:00:00.000Z", "a", "a");
    const b = textEntry("b", "2026-01-02T00:00:00.000Z", "b", "b");
    const input = [b, old, a];
    const sorted = sortEntries(input);
    // 置顶最老也在首位；非置顶按时间倒序。
    expect(sorted.map((e) => e.id)).toEqual(["old", "a", "b"]);
    // 原数组不被就地排序。
    expect(input.map((e) => e.id)).toEqual(["b", "old", "a"]);
  });
});

describe("clipboard-shared entryTitle", () => {
  it("图片条目 = 尺寸；文本 = 摘要；空白 = 占位", () => {
    const tr = (zh: string) => (zh === "图片" ? "Image" : zh);
    expect(entryTitle(imageEntry("i", "2026-01-01T00:00:00.000Z", 640, 480), tr)).toBe("Image 640×480");
    expect(entryTitle(textEntry("t", "2026-01-01T00:00:00.000Z", "hello", "hello"), tr)).toBe("hello");
    expect(entryTitle(textEntry("e", "2026-01-01T00:00:00.000Z", "", ""), tr)).toBe("（空白）");
  });
});

describe("clipboard-shared filesListOf [FILES]", () => {
  it("文件条目解析路径列表；坏 JSON / 非数组 / 非字符串过滤", () => {
    const e = filesEntry("f", "2026-01-01T00:00:00.000Z", ["C:/a.pdf", "D:/b.png"]);
    expect(filesListOf(e)).toEqual(["C:/a.pdf", "D:/b.png"]);
    // 非 files 条目恒空。
    expect(filesListOf(textEntry("t", "2026-01-01T00:00:00.000Z", "x", "x"))).toEqual([]);
    expect(filesListOf(imageEntry("i", "2026-01-01T00:00:00.000Z", 1, 1))).toEqual([]);
    // 坏载荷容错。
    expect(filesListOf({ ...e, files: "not json" })).toEqual([]);
    expect(filesListOf({ ...e, files: '[1,"ok",null]' })).toEqual(["ok"]);
    expect(filesListOf({ ...e, files: null })).toEqual([]);
  });

  it("文件条目标题 = 数量徽标", () => {
    const tr = (zh: string) => (zh === "文件" ? "Files" : zh);
    const one = filesEntry("f1", "2026-01-01T00:00:00.000Z", ["C:/a.pdf"]);
    expect(entryTitle(one, tr)).toBe("Files ×1");
    const two = filesEntry("f2", "2026-01-01T00:00:00.000Z", ["C:/a.pdf", "D:/b.png"]);
    expect(entryTitle(two, tr)).toBe("Files ×2");
    // 列表解不出来时退回通用标题。
    expect(entryTitle({ ...one, files: "[]" }, tr)).toBe("Files");
  });
});
