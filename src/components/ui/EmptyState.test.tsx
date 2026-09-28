import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState（统一空状态）", () => {
  it("渲染主文案与缺省图标", () => {
    render(<EmptyState text="暂无书签" />);
    expect(screen.getByText("暂无书签")).toBeInTheDocument();
    expect(document.querySelector(".fd-empty-ico")).not.toBeNull();
    expect(document.querySelector(".fd-empty-hint")).toBeNull();
  });

  it("有行动提示时渲染 hint；compact 挂紧凑类", () => {
    render(<EmptyState text="暂无书签" hint="点击上方添加" compact />);
    expect(screen.getByText("点击上方添加")).toBeInTheDocument();
    expect(document.querySelector(".fd-empty")?.className).toContain("fd-empty-compact");
  });

  it("自定义图标替换缺省 Inbox", () => {
    render(<EmptyState icon={<i data-testid="custom-ico" />} text="暂无数据" />);
    expect(screen.getByTestId("custom-ico")).toBeInTheDocument();
    expect(document.querySelector(".fd-empty-ico")).toBeNull();
  });
});
