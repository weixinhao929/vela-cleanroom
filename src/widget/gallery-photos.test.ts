/**
 * G12 图库上限测试：trimGallery 保留最新、loadGallery 的缺失/损坏回退
 * 与读时截断、evictGalleryFiles 只清本地导入副本（invoke 不在 jsdom 里跑，
 * 断言调用形状即可——isTauri 为 false 时它必须是 no-op）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GALLERY_CAP,
  evictGalleryFiles,
  loadGallery,
  persistGallery,
  trimGallery,
  type GalleryPhoto
} from "./gallery-photos";

const photo = (id: string, storedPath?: string): GalleryPhoto => ({
  id,
  url: `asset://${id}`,
  label: id,
  storedPath
});

describe("trimGallery（G12 上限截断）", () => {
  it("未超量时原样返回且无挤出", () => {
    const list = [photo("a"), photo("b")];
    expect(trimGallery(list)).toEqual({ kept: list, evicted: [] });
  });

  it("超量时最旧出列、最新保留（尾部追加序）", () => {
    const list = Array.from({ length: GALLERY_CAP + 3 }, (_, i) => photo(`p${i}`));
    const { kept, evicted } = trimGallery(list);
    expect(kept).toHaveLength(GALLERY_CAP);
    expect(evicted.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
    expect(kept[0].id).toBe("p3");
    expect(kept.at(-1)!.id).toBe(`p${GALLERY_CAP + 2}`);
  });
});

describe("loadGallery / persistGallery", () => {
  afterEach(() => localStorage.clear());

  it("键缺失 / JSON 损坏 / 非数组 → null（调用方回落演示数据）", () => {
    expect(loadGallery("g1")).toBeNull();
    localStorage.setItem("focus-desk.gallery.g1", "{broken");
    expect(loadGallery("g1")).toBeNull();
    localStorage.setItem("focus-desk.gallery.g1", '"a string"');
    expect(loadGallery("g1")).toBeNull();
  });

  it("空数组是合法值（用户删光 ≠ 回落演示数据）", () => {
    localStorage.setItem("focus-desk.gallery.g2", "[]");
    expect(loadGallery("g2")).toEqual({ photos: [], evicted: [] });
  });

  it("读时截断超量数据并报出被挤出条目", () => {
    const list = Array.from({ length: GALLERY_CAP + 1 }, (_, i) => photo(`p${i}`, i === 0 ? "C:/old.png" : undefined));
    persistGallery("g3", list);
    const res = loadGallery("g3")!;
    expect(res.photos).toHaveLength(GALLERY_CAP);
    expect(res.evicted.map((p) => p.id)).toEqual(["p0"]);
  });
});

describe("evictGalleryFiles", () => {
  it("jsdom（非 Tauri）下 no-op；空列表直接返回", () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(evictGalleryFiles([])).toBeUndefined();
    expect(evictGalleryFiles([photo("a", "C:/x.png"), photo("b")])).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
