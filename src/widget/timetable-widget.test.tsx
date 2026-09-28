/**
 * 课程表小组件导入链路回归（组件级）。
 *
 * 锁定的 bug：空态（首次使用，data === null）时提前 return 的 JSX 分支
 * 没有渲染导入预览 / 课程编辑弹层——文件选完、解析成功后界面仍停留在
 * 空态，用户看到的就是「点了导入没反应」。本测试从空态出发走完整链路：
 * 点导入 → 选文件 → read_excel_sheet → 预览出现 → 确认 → 周视图渲染。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.fn();
const openMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args)
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {})
}));

import { TimetableWidget } from "./widgets/TimetableWidget";
import { loadWidgetConfig } from "./widget-config";

/** 极简网格式课表：1 门课（周一第 1-2 节，1-16 周）。 */
const GRID_ROWS: string[][] = [
  ["节次", "星期一", "星期二", "星期三", "星期四", "星期五"],
  ["第1节-第2节", "高等数学 1-16周 教1-101", "", "", "", ""],
  ["第3节-第4节", "", "", "", "", ""]
];

describe("TimetableWidget 导入链路（空态）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    openMock.mockResolvedValue("C:/Users/test/Desktop/课表.xlsx");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_excel_sheet") return GRID_ROWS;
      return null;
    });
  });

  it("空态选完文件后应弹出导入预览，确认后渲染周视图并持久化", async () => {
    const user = userEvent.setup();
    render(<TimetableWidget instanceId="tt-ut" />);

    // 空态引导存在。
    expect(screen.getByRole("button", { name: /导入课表/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /导入课表/ }));

    // 文件选择参数：Excel 过滤器在列。
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0][0].filters[0].extensions).toContain("xlsx");
    expect(invokeMock).toHaveBeenCalledWith("read_excel_sheet", {
      path: "C:/Users/test/Desktop/课表.xlsx"
    });

    // 回归点：预览弹层必须在空态下出现（此前永远不渲染）。
    expect(await screen.findByText(/解析结果/)).toBeInTheDocument();
    expect(screen.getByText(/网格式/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认导入" }));

    // 周视图出现课程块，且配置已持久化。
    expect(await screen.findByText(/高等数学/)).toBeInTheDocument();
    const saved = loadWidgetConfig("tt-ut");
    expect((saved.data as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("空态点击「手动添加课程」应打开编辑弹层（同一早退分支的回归）", async () => {
    const user = userEvent.setup();
    render(<TimetableWidget instanceId="tt-ut" />);

    await user.click(screen.getByRole("button", { name: /手动添加课程/ }));

    expect(await screen.findByText("新建课程")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存课程" })).toBeInTheDocument();
  });

  it("解析不到课程时应显示错误而不是停留在无反馈空态", async () => {
    invokeMock.mockResolvedValue([["无关注释"]]);
    const user = userEvent.setup();
    render(<TimetableWidget instanceId="tt-ut" />);

    await user.click(screen.getByRole("button", { name: /导入课表/ }));

    expect(await screen.findByText(/未识别到课程/)).toBeInTheDocument();
  });
});
