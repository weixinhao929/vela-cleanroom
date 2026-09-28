import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CalculatorWidget } from "./CalculatorWidget";
import { __resetMirrorSyncStateForTests } from "../../lib/local-backup";

/**
 * 计算器「计算 / 编码 / 哈希」三页签（编码哈希并入计算器）：默认计算页、
 * 页签切换渲染对应页、当前页签持久化到实例配置、切回计算页键盘仍可用。
 */

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => false };
});

const ID = "calc-mode-test";
const key = `focus-desk.widget-config.${ID}.v1`;

beforeEach(() => localStorage.clear());
afterEach(() => __resetMirrorSyncStateForTests());

describe("CalculatorWidget 页签模式", () => {
  it("默认计算页：数字键盘在、编码输入框不在", () => {
    render(<CalculatorWidget instanceId={ID} />);
    expect(screen.getByRole("button", { name: "=" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("输入要编码的文本")).not.toBeInTheDocument();
  });

  it("切到编码 / 哈希页渲染 ConverterPane，且页签持久化", () => {
    render(<CalculatorWidget instanceId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "编码" }));
    expect(screen.getByPlaceholderText("输入要编码的文本")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(key) || "{}").mode).toBe("encode");

    fireEvent.click(screen.getByRole("button", { name: "哈希" }));
    expect(screen.getByPlaceholderText("输入要计算哈希的文本")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(key) || "{}").mode).toBe("hash");

    fireEvent.click(screen.getByRole("button", { name: "计算" }));
    expect(screen.getByRole("button", { name: "=" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("输入要计算哈希的文本")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(key) || "{}").mode).toBe("calc");
  });

  it("带 mode 的既有配置按持久化页签打开", () => {
    localStorage.setItem(key, JSON.stringify({ mode: "hash" }));
    render(<CalculatorWidget instanceId={ID} />);
    expect(screen.getByPlaceholderText("输入要计算哈希的文本")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "=" })).not.toBeInTheDocument();
  });
});
