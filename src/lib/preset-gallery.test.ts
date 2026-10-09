import { describe, expect, it } from "vitest";
import { galleryFileUrl, parseGalleryManifest, resolveGalleryManifestUrl, safeGalleryFilePath } from "./preset-gallery";

/** 在线预设画廊纯逻辑：源解析、清单逐条校验、相对路径换算。 */

describe("resolveGalleryManifestUrl", () => {
  it("GitHub 仓库地址映射 raw manifest 直链", () => {
    expect(resolveGalleryManifestUrl("https://github.com/user/vela-presets")).toBe(
      "https://raw.githubusercontent.com/user/vela-presets/main/gallery-manifest.json"
    );
    expect(resolveGalleryManifestUrl("https://github.com/user/vela-presets/")).toBe(
      "https://raw.githubusercontent.com/user/vela-presets/main/gallery-manifest.json"
    );
  });
  it("直链与非 http(s) 处理", () => {
    expect(resolveGalleryManifestUrl("https://example.com/dir/gallery-manifest.json")).toBe(
      "https://example.com/dir/gallery-manifest.json"
    );
    expect(resolveGalleryManifestUrl("ftp://example.com/x.json")).toBeNull();
    expect(resolveGalleryManifestUrl("https://github.com/only-owner")).toBeNull();
    expect(resolveGalleryManifestUrl("https://github.com/a/b/releases")).toBeNull();
    expect(resolveGalleryManifestUrl("")).toBeNull();
    expect(resolveGalleryManifestUrl("not a url")).toBeNull();
  });
  it("GitHub tree/blob 分支段识别（默认分支非 main 的仓库）", () => {
    expect(resolveGalleryManifestUrl("https://github.com/user/vela-presets/tree/master")).toBe(
      "https://raw.githubusercontent.com/user/vela-presets/master/gallery-manifest.json"
    );
    expect(resolveGalleryManifestUrl("https://github.com/user/vela-presets/blob/dev/sub/x")).toBe(
      "https://raw.githubusercontent.com/user/vela-presets/dev/gallery-manifest.json"
    );
    // tree 段后无分支名：回退 main（视为普通仓库地址）。
    expect(resolveGalleryManifestUrl("https://github.com/user/vela-presets/tree")).toBe(
      "https://raw.githubusercontent.com/user/vela-presets/main/gallery-manifest.json"
    );
  });
  it("www.github.com 与 github.com 同站处理（浏览器地址栏常带 www）", () => {
    expect(resolveGalleryManifestUrl("https://www.github.com/user/vela-presets")).toBe(
      "https://raw.githubusercontent.com/user/vela-presets/main/gallery-manifest.json"
    );
  });
});

describe("safeGalleryFilePath", () => {
  it("拒绝绝对路径 / 反斜杠 / 穿越与非包扩展名", () => {
    expect(safeGalleryFilePath("presets/dark.zip")).toBe(true);
    expect(safeGalleryFilePath("a.velapreset")).toBe(true);
    expect(safeGalleryFilePath("/abs.zip")).toBe(false);
    expect(safeGalleryFilePath("..\\evi.zip")).toBe(false);
    expect(safeGalleryFilePath("a/../b.zip")).toBe(false);
    expect(safeGalleryFilePath("notes.txt")).toBe(false);
    expect(safeGalleryFilePath("")).toBe(false);
  });
});

describe("parseGalleryManifest", () => {
  const sha = "a".repeat(64);
  it("逐条校验，坏条目跳过", () => {
    const json = {
      version: 1,
      presets: [
        { id: "1", name: "暗色护眼", desc: "低亮度", file: "presets/dark.zip", sha256: sha, size: 12345 },
        { id: "", name: "x", file: "a.zip", sha256: sha },
        { id: "2", name: "x", file: "a.zip", sha256: "nothex" },
        { id: "3", name: "x", file: "../escape.zip", sha256: sha },
        { id: "4", name: "x", sha256: sha },
        "garbage"
      ]
    };
    const list = parseGalleryManifest(json);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: "1",
      name: "暗色护眼",
      desc: "低亮度",
      file: "presets/dark.zip",
      sha256: sha,
      size: 12345
    });
  });
  it("非对象 / 缺 presets 返回空", () => {
    expect(parseGalleryManifest("[]")).toEqual([]);
    expect(parseGalleryManifest({})).toEqual([]);
    expect(parseGalleryManifest({ presets: "x" })).toEqual([]);
  });
  it("sha256 归一小写", () => {
    const upper = "A".repeat(64);
    expect(parseGalleryManifest({ presets: [{ id: "1", name: "n", file: "a.zip", sha256: upper }] })[0].sha256).toBe(
      upper.toLowerCase()
    );
  });
});

describe("galleryFileUrl", () => {
  it("相对 manifest 目录解析", () => {
    expect(galleryFileUrl("https://example.com/dir/gallery-manifest.json", "presets/a.zip")).toBe(
      "https://example.com/dir/presets/a.zip"
    );
  });
});
