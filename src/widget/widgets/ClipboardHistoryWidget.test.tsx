import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSettingsStore } from "../../store/settings-store";
import type { ClipboardEntry } from "../../types/bindings/ClipboardEntry";
import type { ClipboardRestoreOutcome } from "../../types/bindings/ClipboardRestoreOutcome";

/**
 * ClipboardHistoryWidget 回归（剪贴板审计批次）：
 *  - 初始加载（limit 500，与表上限对齐）与三类行渲染（行数角标走 text_lines）；
 *  - 搜索防抖走服务端 query；点击回写 + 文件部分失效 toast；
 *  - 右键菜单（含文本条目的「查看全文」→ get_clipboard_entry 浮层）；
 *  - 删除退场 240ms 后落删，toast 可撤销（undo_delete_clipboard_entry）；
 *  - 清空两段式确认；搜索无结果时清空仍可用（hasAny 而非过滤列表判定）；
 *  - clipboard:changed 载荷 "pin" 跳过刷新；隐私总开关关闭的顶部提示。
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
  menuItems: [] as Array<{ label?: string; onSelect?: () => void; danger?: boolean }>,
  toasts: [] as Array<{ title: string; body: string; kind?: string; action?: { label: string; run: () => void } }>
}));

vi.mock("../../lib/use-tauri-event", () => ({
  useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
    mocks.handlers.set(event, handler);
  }
}));

vi.mock("../../components/ContextMenu", () => ({
  openContextMenu: (_e: unknown, items: Array<{ label?: string; onSelect?: () => void }>) => {
    mocks.menuItems = items as Array<{ label?: string; onSelect?: () => void; danger?: boolean }>;
  }
}));

vi.mock("../../components/ToastHost", () => ({
  pushAppToast: (
    title: string,
    body: string,
    kind?: string,
    opts?: { action?: { label: string; run: () => void } }
  ) => {
    mocks.toasts.push({ title, body, kind, action: opts?.action });
  }
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => mocks.invoke(cmd, args) };
});

/* use-now 的 ticker 会经 use-covered 调真实 @tauri-apps listen（jsdom 下抛
   未处理拒绝）；测试只需一个固定 now。 */
vi.mock("../../lib/use-now", () => ({ useNow: () => new Date() }));

import { ClipboardHistoryWidget } from "./ClipboardHistoryWidget";

const entry = (over: Partial<ClipboardEntry> = {}): ClipboardEntry => ({
  id: "e1",
  kind: "text",
  preview: "文本摘要",
  text: null,
  text_lines: 3,
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

const FIXTURE: ClipboardEntry[] = [
  entry({ id: "t1", preview: "多行文本" }),
  entry({
    id: "f1",
    kind: "files",
    preview: "报告.pdf, 图.png",
    files: '["C:/a/报告.pdf","D:/b/图.png"]',
    text_lines: 0
  }),
  entry({ id: "i1", kind: "image", preview: "", image_w: 640, image_h: 480, image_file: "i1.png", text_lines: 0 })
];

const setEnabled = (enabled: boolean) =>
  useSettingsStore.setState((s) => ({ general: { ...s.general, clipboard: { ...s.general.clipboard, enabled } } }));

const listCalls = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "list_clipboard_history");
const callsOf = (cmd: string) => mocks.invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  mocks.handlers.clear();
  mocks.menuItems = [];
  mocks.toasts = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_clipboard_history") return FIXTURE;
    if (cmd === "get_clipboard_thumbnail") return null;
    return null;
  });
  setEnabled(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClipboardHistoryWidget", () => {
  it("初始加载 limit 500（与表上限对齐）；行渲染与行数角标（text_lines）", async () => {
    render(<ClipboardHistoryWidget />);
    expect(await screen.findByText("多行文本")).toBeInTheDocument();
    const call = listCalls()[0];
    expect(call?.[1]).toEqual({ query: null, limit: 500 });
    expect(screen.getByText("报告.pdf, 图.png")).toBeInTheDocument();
    expect(screen.getByText("2 个文件")).toBeInTheDocument();
    expect(screen.getByText("3 行")).toBeInTheDocument();
    expect(screen.getByText("640×480")).toBeInTheDocument();
    // 计数徽标 = 条目总数。
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("搜索输入 200ms 防抖后带 query 重拉", async () => {
    vi.useFakeTimers();
    render(<ClipboardHistoryWidget />);
    await act(async () => {});
    expect(screen.getByText("多行文本")).toBeInTheDocument();
    const input = screen.getByLabelText("搜索剪贴板…");
    act(() => {
      fireEvent.change(input, { target: { value: "needle" } });
    });
    expect(listCalls()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(200));
    expect(listCalls()).toHaveLength(2);
    expect(listCalls()[1]?.[1]).toEqual({ query: "needle", limit: 500 });
  });

  it("点击行回写；文件部分失效时 toast 提示其余已复制", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_clipboard_history") return FIXTURE;
      if (cmd === "restore_clipboard_entry")
        return { entry: FIXTURE[1], skipped_missing: 2 } satisfies ClipboardRestoreOutcome;
      return null;
    });
    render(<ClipboardHistoryWidget />);
    fireEvent.click(await screen.findByText("报告.pdf, 图.png"));
    await waitFor(() => expect(callsOf("restore_clipboard_entry")).toHaveLength(1));
    expect(callsOf("restore_clipboard_entry")[0]?.[1]).toEqual({ id: "f1" });
    await waitFor(() => expect(mocks.toasts.some((t) => t.title.includes("部分文件已不存在"))).toBe(true));
  });

  it("右键菜单：文本条目有「查看全文」→ 浮层经 get_clipboard_entry 取全文；图片条目没有", async () => {
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_clipboard_history") return FIXTURE;
      if (cmd === "get_clipboard_entry") {
        const id = (args as { id: string }).id;
        return id === "t1" ? entry({ id: "t1", text: "第一行\n第二行\n第三行" }) : null;
      }
      return null;
    });
    render(<ClipboardHistoryWidget />);
    const textRow = (await screen.findByText("多行文本")).closest("[data-clip-row]") as HTMLElement;
    expect(textRow).not.toBeNull();
    fireEvent.contextMenu(textRow);
    const labels = mocks.menuItems.map((i) => i.label);
    expect(labels).toContain("复制");
    expect(labels).toContain("查看全文");
    expect(labels).toContain("置顶");
    expect(labels).toContain("删除");
    await act(async () => {
      mocks.menuItems.find((i) => i.label === "查看全文")!.onSelect!();
    });
    const pre = document.querySelector(".clipw-detail-text") as HTMLElement;
    expect(pre).not.toBeNull();
    // 直接比 textContent：toHaveTextContent 会做空白归一化，验不出换行保留。
    expect(pre.textContent).toBe("第一行\n第二行\n第三行");
    expect(callsOf("get_clipboard_entry")[0]?.[1]).toEqual({ id: "t1" });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(document.querySelector(".clipw-detail-text")).toBeNull();

    // 图片条目：无「查看全文」。
    const imgRow = screen.getByText("640×480").closest("[data-clip-row]") as HTMLElement;
    fireEvent.contextMenu(imgRow);
    expect(mocks.menuItems.map((i) => i.label)).not.toContain("查看全文");
  });

  it("删除：240ms 退场后落删并给可撤销 toast（文本条目）", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_clipboard_history") return FIXTURE;
      if (cmd === "delete_clipboard_entry") return entry({ id: "t1", preview: "多行文本", text: "完整正文" });
      return null;
    });
    render(<ClipboardHistoryWidget />);
    await act(async () => {});
    const row = screen.getByText("多行文本").closest("[data-clip-row]") as HTMLElement;
    fireEvent.contextMenu(row);
    act(() => void mocks.menuItems.find((i) => i.label === "删除")!.onSelect!());
    expect(row).toHaveClass("is-closing");
    act(() => void vi.advanceTimersByTime(240));
    await act(async () => {});
    expect(callsOf("delete_clipboard_entry")[0]?.[1]).toEqual({ id: "t1" });
    const toast = mocks.toasts.find((x) => x.title === "已删除剪贴板条目" && x.action);
    expect(toast).toBeDefined();
    expect(toast!.action?.label).toBe("撤销");
    act(() => toast!.action!.run());
    await act(async () => {});
    expect(callsOf("undo_delete_clipboard_entry")[0]?.[1]).toEqual({
      kind: "text",
      text: "完整正文",
      files: null
    });
  });

  it("删除图片条目：toast 不带撤销动作（PNG 已物理回收）", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_clipboard_history") return FIXTURE;
      if (cmd === "delete_clipboard_entry") return FIXTURE[2];
      return null;
    });
    render(<ClipboardHistoryWidget />);
    await act(async () => {});
    const row = screen.getByText("640×480").closest("[data-clip-row]") as HTMLElement;
    fireEvent.contextMenu(row);
    act(() => void mocks.menuItems.find((i) => i.label === "删除")!.onSelect!());
    act(() => void vi.advanceTimersByTime(240));
    await act(async () => {});
    expect(mocks.toasts.some((t) => t.title === "已删除剪贴板条目" && !t.action)).toBe(true);
  });

  it("清空两段式确认：第一次进入确认态，第二次才调用 clear", async () => {
    render(<ClipboardHistoryWidget />);
    const clearBtn = await screen.findByRole("button", { name: "清空剪贴板历史" });
    // 按钮要等初始 list_clipboard_history 异步返回置位 hasAny 才脱离 disabled
    // （disabled=!desktop || (!hasAny && entries.length===0)）——慢环境（coverage
    // 全量并发）下按钮先出现后启用，出现即点击会撞上 disabled 期使确认态没
    // 进去。等启用再点，消除时序竞态。
    await waitFor(() => expect(clearBtn).toBeEnabled());
    fireEvent.click(clearBtn);
    expect(callsOf("clear_clipboard_history")).toHaveLength(0);
    // 确认态文案点名含置顶。
    expect(screen.getByRole("button", { name: "将删除全部条目（含置顶），再次点击确认" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "将删除全部条目（含置顶），再次点击确认" }));
    await waitFor(() => expect(callsOf("clear_clipboard_history")).toHaveLength(1));
    expect(await screen.findByText("暂无剪贴板记录")).toBeInTheDocument();
  });

  it("搜索无结果时清空按钮仍可用（hasAny 而非过滤列表判定）", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_clipboard_history") {
        return (args as { query: string | null }).query ? [] : FIXTURE;
      }
      return null;
    });
    render(<ClipboardHistoryWidget />);
    await act(async () => {});
    act(() => {
      fireEvent.change(screen.getByLabelText("搜索剪贴板…"), { target: { value: "zzz" } });
    });
    act(() => void vi.advanceTimersByTime(250));
    await act(async () => {});
    expect(screen.getByText("没有匹配的记录")).toBeInTheDocument();
    const clearBtn = screen.getByRole("button", { name: "清空剪贴板历史" }) as HTMLButtonElement;
    expect(clearBtn.disabled).toBe(false);
  });

  it("置顶乐观重排：菜单置顶后该行移到首位（不等待事件回刷）", async () => {
    render(<ClipboardHistoryWidget />);
    await screen.findByText("多行文本");
    const row = screen.getByText("多行文本").closest("[data-clip-row]") as HTMLElement;
    fireEvent.contextMenu(row);
    act(() => void mocks.menuItems.find((i) => i.label === "置顶")!.onSelect!());
    await waitFor(() => expect(callsOf("toggle_clipboard_pin")).toHaveLength(1));
    const rows = document.querySelectorAll("[data-clip-row]");
    expect(rows[0].textContent).toContain("多行文本");
    expect(rows[0]).toHaveClass("is-pinned");
  });

  it('clipboard:changed 载荷 "pin" 跳过刷新；普通载荷 150ms 合并后刷新', async () => {
    vi.useFakeTimers();
    render(<ClipboardHistoryWidget />);
    await act(async () => {});
    expect(listCalls()).toHaveLength(1);
    const emit = (p: unknown) => act(() => mocks.handlers.get("clipboard:changed")!(p));
    emit("pin");
    act(() => void vi.advanceTimersByTime(500));
    expect(listCalls()).toHaveLength(1);
    emit(undefined);
    act(() => void vi.advanceTimersByTime(150));
    expect(listCalls()).toHaveLength(2);
  });

  it("隐私总开关关闭：顶部提示可见", async () => {
    setEnabled(false);
    render(<ClipboardHistoryWidget />);
    expect(await screen.findByText("记录已在设置中关闭，仅显示已有历史")).toBeInTheDocument();
  });

  it("「/」聚焦搜索框（输入控件内不劫持）", async () => {
    render(<ClipboardHistoryWidget />);
    const root = (await screen.findByText("多行文本")).closest(".clipw") as HTMLElement;
    const input = screen.getByLabelText("搜索剪贴板…");
    fireEvent.keyDown(root, { key: "z" });
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(root, { key: "/" });
    expect(document.activeElement).toBe(input);
  });

  it("键盘 ↑/↓ 在条目间移动焦点", async () => {
    render(<ClipboardHistoryWidget />);
    const first = (await screen.findByText("多行文本")).closest("[data-clip-row]") as HTMLElement;
    first.focus();
    const list = first.closest(".clipw-list") as HTMLElement;
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const rows = document.querySelectorAll("[data-clip-row]");
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
  });
});
