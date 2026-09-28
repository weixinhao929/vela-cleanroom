import { describe, expect, it } from "vitest";
import { extractTags } from "./mini-md";

describe("extractTags", () => {
  it("collects unique tags", () => {
    expect(extractTags("#工作 记录 #工作 #生活")).toEqual(["工作", "生活"]);
  });

  it("keeps CJK and alnum tags but stops at punctuation", () => {
    expect(extractTags("#todo, #高数_线代!")).toEqual(["todo", "高数_线代"]);
  });

  it("ignores hash inside words and bare #", () => {
    expect(extractTags("C# 代码 #")).toEqual([]);
  });

  it("caps tag length at 24 chars", () => {
    expect(extractTags("#abcdefghijklmnopqrstuvwxyz")).toEqual(["abcdefghijklmnopqrstuvwx"]);
  });
});
