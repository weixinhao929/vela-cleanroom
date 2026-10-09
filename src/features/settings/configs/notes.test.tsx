/**
 * 便签配置（NotesConfig）回收站区块行为测试（真实 notes-store localStorage 链路）：
 *  - 外部变更刷新：其他入口（速记删除 / 小组件侧恢复）经 notes-store 的
 *    notifyNotesChanged 广播后，已打开的设置页重读回收站——外部恢复的条目
 *    从列表消失、外部新删的便签出现在列表，无需重开页面。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NotesConfig } from "./notes";
import { deleteToTrash, restoreFromTrash, saveTrash, type TrashNote } from "../../../widget/notes-store";
import { useSettingsStore } from "../../../store/settings-store";

const ISO = "2026-10-01T08:00:00.000Z";
const T1: TrashNote = { id: "t1", text: "旧便签", updatedAt: ISO, deletedAt: ISO };

beforeEach(() => {
  localStorage.clear();
  saveTrash("n1", [T1]);
  useSettingsStore.setState((s) => ({ extra: { ...s.extra, recycleRetentionDays: 30 } }));
});

describe("NotesConfig · 回收站跟随外部写入刷新（P2-2）", () => {
  it("外部恢复（restoreFromTrash）→ 列表实时变空；外部再删一条（deleteToTrash）→ 新条目实时出现", async () => {
    const user = userEvent.setup();
    render(<NotesConfig config={{}} update={vi.fn()} instanceId="n1" />);
    expect(screen.getByText("旧便签")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空回收站" })).toBeInTheDocument();

    // 外部入口（小组件侧「恢复」）把唯一条目救回：设置页列表随之清空。
    act(() => {
      restoreFromTrash("n1", "t1");
    });
    expect(screen.getByText("回收站为空")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清空回收站" })).toBeNull();

    // 外部入口（速记删除）又删了一条：列表实时出现新条目（而非陈旧空态）。
    act(() => {
      deleteToTrash("n1", { id: "n2", text: "新删除的便签", updatedAt: ISO });
    });
    expect(await screen.findByText("新删除的便签")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空回收站" })).toBeInTheDocument();

    // 本页操作同样走同一存储：恢复按钮移除条目。
    await user.click(screen.getAllByRole("button", { name: "恢复" })[0]);
    expect(screen.getByText("回收站为空")).toBeInTheDocument();
  });

  it("外部清空（emptyTrash 语义）经 saveTrash 广播 → 列表实时变空", () => {
    render(<NotesConfig config={{}} update={vi.fn()} instanceId="n1" />);
    expect(screen.getByText("旧便签")).toBeInTheDocument();
    act(() => {
      saveTrash("n1", []);
    });
    expect(screen.getByText("回收站为空")).toBeInTheDocument();
  });
});
