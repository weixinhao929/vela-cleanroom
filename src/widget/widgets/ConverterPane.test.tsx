import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ConverterPane,
  fromBase64,
  matchAlgorithm,
  normalizeExpected,
  toBase64,
  urlDecode,
  urlEncode,
  type HashBundle
} from "./ConverterPane";

/**
 * 计算器「编码 / 哈希」页测试（原 EncoderWidget 并入计算器后迁移）：
 * 纯函数向量（Base64/URL 往返、核对归一化与匹配）、编码页交互
 * （切换格式 / 用作输入回填）、哈希页文本计算与核对徽标。
 */

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => false };
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("纯函数", () => {
  it("Base64 UTF-8 往返", () => {
    expect(toBase64("abc")).toBe("YWJj");
    expect(fromBase64("YWJj")).toBe("abc");
    const zh = "中文测试";
    expect(fromBase64(toBase64(zh))).toBe(zh);
  });
  it("Base64 非法输入抛错", () => {
    expect(() => fromBase64("!!!not-base64!!!")).toThrow();
  });
  it("URL 编解码往返（含 + 与空格兼容）", () => {
    expect(urlEncode("a b&c=1")).toBe("a%20b%26c%3D1");
    expect(urlDecode("a%20b%26c%3D1")).toBe("a b&c=1");
    expect(urlDecode("a+b")).toBe("a b");
  });
  it("期望值归一化：去空格冒号转小写", () => {
    expect(normalizeExpected("AA:BB-CC dd")).toBe("aabb-ccdd");
  });
  it("matchAlgorithm 命中任一算法或 null", () => {
    const h: HashBundle = {
      md5: "900150983cd24fb0d6963f7d28e17f72",
      sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      sha512: "ddaf35a1"
    };
    expect(matchAlgorithm("900150983CD24FB0D6963F7D28E17F72", h)).toBe("MD5");
    expect(matchAlgorithm(" 90 01 50 98 3c d2 4f b0 d6 96 3f 7d 28 e1 7f 72 ", h)).toBe("MD5");
    expect(matchAlgorithm(h.sha256, h)).toBe("SHA-256");
    expect(matchAlgorithm("deadbeef", h)).toBeNull();
  });
});

describe("ConverterPane 编码页", () => {
  it("输入即出结果", () => {
    render(<ConverterPane tab="encode" dragOver={false} dropRequest={null} />);
    const box = screen.getByPlaceholderText("输入要编码的文本");
    fireEvent.change(box, { target: { value: "hello" } });
    expect(screen.getByText("aGVsbG8=")).toBeInTheDocument();
  });

  it("切到 URL 格式后按 URL 编码", () => {
    render(<ConverterPane tab="encode" dragOver={false} dropRequest={null} />);
    fireEvent.change(screen.getByPlaceholderText("输入要编码的文本"), { target: { value: "a b" } });
    fireEvent.click(screen.getByRole("button", { name: "URL" }));
    expect(screen.getByText("a%20b")).toBeInTheDocument();
  });

  it("用作输入：输出回填并翻转方向", () => {
    render(<ConverterPane tab="encode" dragOver={false} dropRequest={null} />);
    fireEvent.change(screen.getByPlaceholderText("输入要编码的文本"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /用作输入/ }));
    expect(screen.getByPlaceholderText("输入要解码的文本")).toHaveValue("aGVsbG8=");
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("非法 Base64 显示人话错误", () => {
    render(<ConverterPane tab="encode" dragOver={false} dropRequest={null} />);
    fireEvent.click(screen.getByRole("button", { name: "解码" }));
    fireEvent.change(screen.getByPlaceholderText("输入要解码的文本"), { target: { value: "@@@@" } });
    expect(screen.getByText("输入内容不是合法的 Base64")).toBeInTheDocument();
  });
});

describe("ConverterPane 哈希页", () => {
  it("文本哈希：四行结果 + 匹配徽标", async () => {
    render(<ConverterPane tab="hash" dragOver={false} dropRequest={null} />);
    fireEvent.change(screen.getByPlaceholderText("输入要计算哈希的文本"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "计算哈希" }));
    await waitFor(() => expect(screen.getByText("900150983cd24fb0d6963f7d28e17f72")).toBeInTheDocument());
    expect(screen.getByText("a9993e364706816aba3e25717850c26c9cd0d89d")).toBeInTheDocument();
    // 大写粘贴也能核对命中 MD5。
    fireEvent.change(screen.getByPlaceholderText("粘贴期望哈希值自动核对"), {
      target: { value: "900150983CD24FB0D6963F7D28E17F72" }
    });
    expect(screen.getByText(/MD5 匹配/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("粘贴期望哈希值自动核对"), { target: { value: "deadbeef" } });
    expect(screen.getByText("不匹配")).toBeInTheDocument();
  });
});
