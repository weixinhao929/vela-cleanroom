import { describe, expect, it } from "vitest";
import { pinyinInitials } from "./pinyin";

describe("pinyinInitials", () => {
  it("maps common Chinese app-name characters to initials", () => {
    expect(pinyinInitials("微信")).toBe("wx");
    expect(pinyinInitials("网易云音乐")).toBe("wyyy");
    expect(pinyinInitials("回收站")).toBe("hsz");
  });

  it("keeps ASCII letters and digits as-is (lowercased)", () => {
    expect(pinyinInitials("Chrome")).toBe("chrome");
    expect(pinyinInitials("VS Code")).toBe("vscode");
  });

  it("skips unknown characters instead of guessing", () => {
    // 「囧」不在表里：原样跳过，不会产出错误字母。
    expect(pinyinInitials("囧")).toBe("");
  });
});
