/**
 * [DOCK-COVER]纯函数单测：随机选图与 crossfade
 * 状态机（组件渲染本身只做事件订阅与图层挂类，无可测分支）。
 */
import { describe, expect, it } from "vitest";
import { nextCoverLayers, pickRandomImage, type FileEntryLike } from "./dock-cover-logic";

const entry = (name: string, isDir = false): FileEntryLike => ({ name, path: `C:/x/${name}`, is_dir: isDir });

describe("pickRandomImage", () => {
  it("只挑目录下的图片文件（大小写扩展名不敏感）", () => {
    const list = [entry("a.png"), entry("b.JPG"), entry("c.webp"), entry("notes.txt"), entry("dir", true)];
    for (let i = 0; i < 20; i++) {
      const picked = pickRandomImage(list, () => 0.99);
      expect(picked).toMatch(/^C:\/x\/(a\.png|b\.JPG|c\.webp)$/);
    }
  });

  it("无图片返回 null（空目录 / 全是非图片 / 全是子目录）", () => {
    expect(pickRandomImage([])).toBeNull();
    expect(pickRandomImage([entry("readme.md")])).toBeNull();
    expect(pickRandomImage([entry("photos", true)])).toBeNull();
  });

  it("随机源覆盖全部候选（注入 rand 验证索引映射）", () => {
    const list = [entry("a.png"), entry("b.png"), entry("c.png")];
    expect(pickRandomImage(list, () => 0)?.endsWith("a.png")).toBe(true);
    expect(pickRandomImage(list, () => 0.5)?.endsWith("b.png")).toBe(true);
    expect(pickRandomImage(list, () => 0.99)?.endsWith("c.png")).toBe(true);
    // rand 恰好 1 的越界保护（floor(1*n)=n 会越界，钳到最后一张）。
    expect(pickRandomImage(list, () => 1)?.endsWith("c.png")).toBe(true);
  });
});

describe("nextCoverLayers", () => {
  it("源未变返回原状态（引用相等，不触发重渲）", () => {
    const s = { cur: "a", prev: null };
    expect(nextCoverLayers(s, "a")).toBe(s);
  });

  it("换图：旧图退到 prev 层，新图进 cur 层（crossfade 双层）", () => {
    expect(nextCoverLayers({ cur: "a", prev: null }, "b")).toEqual({ cur: "b", prev: "a" });
    // 退位清理后再换图：prev 槽位始终最多一张。
    expect(nextCoverLayers({ cur: "b", prev: null }, "c")).toEqual({ cur: "c", prev: "b" });
  });

  it("源清空（切歌间隙 / 音乐停止）：旧图退到 prev 层播淡出", () => {
    expect(nextCoverLayers({ cur: "a", prev: null }, null)).toEqual({ cur: null, prev: "a" });
    // prev 尚未清理时再次变更：直接换新，prev 层被替换（不叠加）。
    expect(nextCoverLayers({ cur: null, prev: "a" }, "b")).toEqual({ cur: "b", prev: null });
  });
});
