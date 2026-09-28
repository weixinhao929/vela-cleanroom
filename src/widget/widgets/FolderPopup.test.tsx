/**
 * 文件夹预览小窗测试（jsdom）：
 *  - placeFolderPopup 纯函数：右展开优先 / 右缘放不下翻左 / 底部越界贴底钳制；
 *  - 目录条目渲染：目录排前、按名称序；点击子文件夹就地下钻（list_directory
 *    换路径重拉，标题换新目录名）；点击文件 invoke open_path；
 *  - 关闭路径：Esc 与外点都在 160ms 关闭动画后回调 onClose（世代守卫语义）；
 *  - 加载失败：显示错误态与「重试」按钮，重试重拉目录。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { FolderPopup, breadcrumbSegments, placeFolderPopup } from "./FolderPopup";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>()
}));
vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: invokeMock };
});

const DOCS = [
  { name: "报告.docx", path: "C:/docs/报告.docx", is_dir: false, size: 10, modified: null },
  { name: "子文件夹", path: "C:/docs/子文件夹", is_dir: true, size: null, modified: null },
  { name: "阿图片.png", path: "C:/docs/阿图片.png", is_dir: false, size: 5, modified: null }
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_directory") return (args?.path as string) === "C:/docs" ? DOCS : [];
    if (cmd === "get_app_icon") return null;
    return null;
  });
});

const anchor = { x: 100, y: 100, w: 60, h: 80 };
const renderPopup = (onClose = vi.fn()) => {
  const utils = render(<FolderPopup path="C:/docs" anchor={anchor} onClose={onClose} />);
  return { ...utils, onClose };
};

describe("placeFolderPopup 纯函数", () => {
  it("右缘充足：向右展开、顶对齐锚点", () => {
    const p = placeFolderPopup(anchor, { w: 300, h: 200 }, { w: 1920, h: 1080 });
    expect(p).toEqual({ left: 168, top: 100, side: "right" });
  });

  it("右缘放不下：翻到锚点左侧，side=left", () => {
    const p = placeFolderPopup({ x: 1800, y: 100, w: 60, h: 80 }, { w: 300, h: 200 }, { w: 1920, h: 1080 });
    expect(p.side).toBe("left");
    expect(p.left).toBe(1800 - 300 - 8);
  });

  it("底部越界：贴底钳制不越出视口", () => {
    const p = placeFolderPopup({ x: 100, y: 1000, w: 60, h: 80 }, { w: 300, h: 400 }, { w: 1920, h: 1080 });
    expect(p.top).toBe(1080 - 400 - 10);
  });

  it("左侧也放不下（极小视口）：钳回左留白", () => {
    const p = placeFolderPopup({ x: 0, y: 0, w: 50, h: 50 }, { w: 400, h: 300 }, { w: 420, h: 400 });
    expect(p.left).toBe(10);
  });
});

describe("breadcrumbSegments 面包屑纯函数", () => {
  it("浅路径（≤keep 段）：全保留，末段标记 current", () => {
    const { items, truncated } = breadcrumbSegments("C:/docs/子文件夹");
    expect(truncated).toBe(false);
    expect(items).toEqual([
      { name: "C:", path: "C:", current: false },
      { name: "docs", path: "C:/docs", current: false },
      { name: "子文件夹", path: "C:/docs/子文件夹", current: true }
    ]);
  });

  it("深路径：只保留最后 3 段并标记 truncated", () => {
    const { items, truncated } = breadcrumbSegments("C:/a/b/c/docs");
    expect(truncated).toBe(true);
    expect(items.map((i) => i.name)).toEqual(["b", "c", "docs"]);
    expect(items[0].path).toBe("C:/a/b");
    expect(items[2].current).toBe(true);
  });

  it("反斜杠路径同样切段", () => {
    const { items } = breadcrumbSegments("D:\\work\\子目录");
    expect(items.map((i) => i.name)).toEqual(["D:", "work", "子目录"]);
    expect(items[1].path).toBe("D:/work");
  });
});

describe("FolderPopup 组件", () => {
  it("渲染目录条目：目录在前，点击子文件夹就地下钻、标题跟随", async () => {
    renderPopup();
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByText("子文件夹")).toBeTruthy());
    // 目录排前：子文件夹先于两个文件。
    const names = Array.from(document.querySelectorAll(".folder-popup-name")).map((n) => n.textContent);
    expect(names[0]).toBe("子文件夹");

    fireEvent.click(screen.getByText("子文件夹"));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([c, a]) => c === "list_directory" && (a as { path: string }).path === "C:/docs/子文件夹"
        )
      ).toBe(true)
    );
    await waitFor(() => expect(screen.getByTitle("C:/docs/子文件夹")).toBeTruthy());
    expect(screen.getByTitle("C:/docs/子文件夹").textContent).toContain("子文件夹");
  });

  it("点击文件条目：invoke open_path 打开，不发生下钻", async () => {
    renderPopup();
    await waitFor(() => expect(screen.getByText("报告.docx")).toBeTruthy());
    fireEvent.click(screen.getByText("报告.docx"));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([c, a]) => c === "open_path" && (a as { path: string }).path === "C:/docs/报告.docx"
        )
      ).toBe(true)
    );
  });

  it("点击面包屑祖先段：就地下钻到该目录（B4）", async () => {
    render(<FolderPopup path="C:/docs/子文件夹" anchor={anchor} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("子文件夹")).toBeTruthy());
    // 面包屑：C: / docs / 子文件夹（当前段）——点「docs」回到 C:/docs。
    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([c, a]) => c === "list_directory" && (a as { path: string }).path === "C:/docs")
      ).toBe(true)
    );
  });

  it("Esc 关闭：160ms 关闭动画后回调 onClose", async () => {
    const { onClose } = renderPopup();
    await waitFor(() => expect(screen.getByText("报告.docx")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".folder-popup.is-closing")).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it("外点关闭：弹层外的 pointerdown 同样走关闭动画后回调", async () => {
    const { onClose } = renderPopup();
    await waitFor(() => expect(screen.getByText("报告.docx")).toBeTruthy());
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it("目录读取失败：错误态 + 重试重拉", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_directory") throw new Error("denied");
      return null;
    });
    renderPopup();
    await screen.findByText("目录读取失败");
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "list_directory" ? DOCS : null));
    // 头部还有一个同名的「重试」（刷新）按钮：错误态里的那个在网格之后。
    const retries = screen.getAllByRole("button", { name: "重试" });
    fireEvent.click(retries[retries.length - 1]);
    await waitFor(() => expect(screen.getByText("子文件夹")).toBeTruthy());
  });
});
