import { describe, expect, it } from "vitest";
import { md5Hex } from "./md5";

/** RFC 1321 标准测试向量 + 长输入跨块（>55 字节触发两轮填充块）。 */
describe("md5Hex", () => {
  it("空串", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
  it("abc", () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
  it("经典狐狸句", () => {
    expect(md5Hex("The quick brown fox jumps over the lazy dog")).toBe("9e107d9d372bb6826bd81d3542a419d6");
  });
  it("跨块长输入（64/56 字节边界两侧）", () => {
    expect(md5Hex("a".repeat(56))).toBe("3b0c8ac703f828b04c6c197006d17218");
    expect(md5Hex("a".repeat(64))).toBe("014842d480b571495a4a0363793f7367");
  });
  it("UTF-8 多字节按字节计数", () => {
    expect(md5Hex("中文")).toBe("a7bac2239fcdcb3a067903d8077c4a07");
  });
});
