import { describe, expect, it } from "vitest";
import { extractPalette } from "./MusicImmersive";

/**
 * 封面取色接口契约（供 SYS 会话对接）：media 快照的 `palette` 三色
 * {primary, onPrimary, track} 均为 #RRGGBB[AA] 时才被消费，否则回退主题
 * accent（返回 null）。字段缺失（当前 media.rs 未合入取色）不得抛错。
 */
describe("MusicImmersive.extractPalette（封面取色消费口）", () => {
  it("快照无 palette 字段（取色未合入）→ null，回退主题色", () => {
    expect(extractPalette({ title: "x", thumb: null })).toBeNull();
    expect(extractPalette(null)).toBeNull();
    expect(extractPalette(undefined)).toBeNull();
  });

  it("三色齐全且为合法 hex → 原样透传", () => {
    const p = { primary: "#3355ff", onPrimary: "#FFFFFF", track: "#22334455" };
    expect(extractPalette({ palette: p })).toEqual(p);
  });

  it("任一色缺失或非法 → null（不半吃）", () => {
    expect(extractPalette({ palette: { primary: "#3355ff", onPrimary: "#fff", track: "#000000" } })).toBeNull();
    expect(extractPalette({ palette: { primary: "rgb(1,2,3)", onPrimary: "#ffffff", track: "#000000" } })).toBeNull();
    expect(extractPalette({ palette: { primary: "#3355ff", onPrimary: "#ffffff" } })).toBeNull();
    expect(extractPalette({ palette: null })).toBeNull();
  });
});
