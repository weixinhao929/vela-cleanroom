import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useSettingsStore } from "../../../store/settings-store";
import type { ClipboardEntry } from "../../../types/bindings/ClipboardEntry";

/**
 * ClipboardMini 回归：首帧拉 list 首条 → 摘要（文本前 24 字 / 图片）；
 * clipboard:changed 事件 150ms 合并后重拉，active=false 不重拉；隐私开关关闭
 * → 禁用态 + title；点击回写 restore_clipboard_entry 并闪「已复制」。
 */
const eventHandlers = new Map<string, (payload: unknown) => void>();
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

vi.mock("../../../lib/use-tauri-event", () => ({
  useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
    eventHandlers.set(event, handler);
  }
}));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

import { ClipboardMini } from "./ClipboardMini";

const entry = (over: Partial<ClipboardEntry> = {}): ClipboardEntry => ({
  id: "e1",
  kind: "text",
  preview: "零一二三四五六七八九十一二三四五六七八九二十一二三四五六七",
  text: null,
  image_file: null,
  image_w: null,
  image_h: null,
  image_bytes: 0,
  files: null,
  source_app: null,
  pinned: false,
  created_at: "2026-09-16T00:00:00.000Z",
  ...over
});

const setEnabled = (enabled: boolean) =>
  useSettingsStore.setState((s) => ({ general: { ...s.general, clipboard: { ...s.general.clipboard, enabled } } }));

const listCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "list_clipboard_history").length;

beforeEach(() => {
  eventHandlers.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "list_clipboard_history" ? [entry()] : null));
  setEnabled(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClipboardMini", () => {
  it("首帧拉 list 首条（limit 1），文本摘要截到前 24 字；点击回写并闪「已复制」", async () => {
    const onTile = vi.fn();
    render(
      <button onClick={onTile}>
        <ClipboardMini active />
      </button>
    );
    expect(invokeMock).toHaveBeenCalledWith("list_clipboard_history", { query: null, limit: 1 });
    const cell = await screen.findByText("零一二三四五六七八九十一二三四五六七八九二十一二");
    expect(cell).toHaveAttribute("role", "button");
    expect(cell).toHaveAttribute("data-interactive");
    fireEvent.click(cell);
    expect(invokeMock).toHaveBeenCalledWith("restore_clipboard_entry", { id: "e1" });
    expect(onTile).not.toHaveBeenCalled();
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("图片条目显示「图片」", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "list_clipboard_history" ? [entry({ kind: "image", preview: "", image_w: 640, image_h: 480 })] : null
    );
    render(<ClipboardMini active />);
    expect(await screen.findByText("图片")).toBeInTheDocument();
  });

  it("clipboard:changed 150ms 合并后重拉一次；active=false 期间忽略事件", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<ClipboardMini active />);
    expect(listCalls()).toBe(1);
    const emit = () => act(() => eventHandlers.get("clipboard:changed")!(undefined));
    emit();
    emit();
    act(() => void vi.advanceTimersByTime(149));
    expect(listCalls()).toBe(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(listCalls()).toBe(2);

    rerender(<ClipboardMini active={false} />);
    emit();
    act(() => void vi.advanceTimersByTime(500));
    expect(listCalls()).toBe(2);
  });

  it("隐私总开关关闭：禁用态 + title 提示，摘要不可点", async () => {
    setEnabled(false);
    const { container } = render(<ClipboardMini active />);
    await screen.findByText("零一二三四五六七八九十一二三四五六七八九二十一二");
    const root = container.querySelector(".dock-mini-clipboard") as HTMLElement;
    expect(root).toHaveClass("is-disabled");
    expect(root).toHaveAttribute("aria-disabled", "true");
    expect(root).toHaveAttribute("title", "记录已在设置中关闭，仅显示已有历史");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
