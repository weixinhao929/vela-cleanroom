/**
 * 课程表小组件导入链路回归（组件级）。
 *
 * 锁定的 bug：空态（首次使用，data === null）时提前 return 的 JSX 分支
 * 没有渲染导入预览 / 课程编辑弹层——文件选完、解析成功后界面仍停留在
 * 空态，用户看到的就是「点了导入没反应」。本测试从空态出发走完整链路：
 * 点导入 → 选文件 → read_excel_sheet → 预览出现 → 确认 → 周视图渲染。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
import { mondayOf, toISODate } from "./timetable";

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

  it("周次徽标即学期设置入口：改总周数 / 以本周为第 1 周写入 profiles 与镜像", async () => {
    const user = userEvent.setup();
    render(<TimetableWidget instanceId="tt-ut" />);

    // 走完整导入拿到课表数据（学期默认本周为第 1 周）。
    await user.click(screen.getByRole("button", { name: /导入课表/ }));
    await user.click(await screen.findByRole("button", { name: "确认导入" }));
    await screen.findByText(/高等数学/);

    // 周次徽标是按钮，点开学期设置弹层。
    const badge = await screen.findByRole("button", { name: /学期设置：第一周周一 \/ 总周数/ });
    await user.click(badge);
    const weeks = screen.getByRole("spinbutton", { name: "总周数" });
    expect((weeks as HTMLInputElement).value).toBe("16");

    // 受控数字输入逐键写库，一次性赋终值。
    fireEvent.change(weeks, { target: { value: "20" } });
    let saved = loadWidgetConfig("tt-ut");
    expect((saved.data as { totalWeeks: number }).totalWeeks).toBe(20);
    const prof = (saved.profiles as { id: string; data: { totalWeeks: number } }[])[0];
    expect(prof.data.totalWeeks).toBe(20);

    // 快捷项：把第一周周一对齐到本周一。
    await user.click(screen.getByRole("button", { name: "以本周为第 1 周" }));
    saved = loadWidgetConfig("tt-ut");
    expect((saved.data as { semesterStart: string }).semesterStart).toBe(toISODate(mondayOf(new Date())));
  });
});
