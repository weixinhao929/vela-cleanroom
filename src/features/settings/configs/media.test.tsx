/**
 * 图库配置（GalleryConfig）行为测试（真实 gallery-photos localStorage 链路）：
 *  - 写前现读（轮 (a)）：外部（桌面图库组件）已删除某图后，本页添加
 *    新 URL 的提交以 loadGallery 现值为基底——已删图片不被陈旧的渲染闭包
 *    photos 复活进持久化载荷；
 *  - addUrl 校验：非法 URL 行内报错不入库；裸域名补全 https://；
 *    归一化后与现有图片按 url 去重（含补全后命中）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GalleryConfig } from "./media";
import { loadGallery, persistGallery, type GalleryPhoto } from "../../../widget/gallery-photos";

const photo = (id: string, url: string, label = id): GalleryPhoto => ({ id, url, label });
const urls = (id: string) => (loadGallery(id)?.photos ?? []).map((p) => p.url);

beforeEach(() => {
  localStorage.clear();
});

describe("GalleryConfig · 写前现读（P1-2(a) 回归锁）", () => {
  it("外部已删除 B（loadGallery 不含它）后添加新 URL → 提交载荷只含 [A, 新图]，B 不复活", async () => {
    const user = userEvent.setup();
    persistGallery("g1", [photo("a", "https://a.example/1.png", "A"), photo("b", "https://b.example/2.png", "B")]);
    render(<GalleryConfig config={{}} update={vi.fn()} instanceId="g1" />);
    // 挂载时两图都在（渲染态还是陈旧基线——这正是回归场景的前提）。
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();

    // 外部（桌面图库组件）删掉 B：直接写权威存储、不发刷新事件。
    persistGallery("g1", [photo("a", "https://a.example/1.png", "A")]);

    // 本页此时添加新 URL：commit 必须以 loadGallery 现值为基底。
    await user.type(screen.getByLabelText("添加图片链接"), "https://c.example/3.png{enter}");
    expect(urls("g1")).toEqual(["https://a.example/1.png", "https://c.example/3.png"]);
    // 本地面列表随提交后的 CustomEvent 重读对齐（B 从 UI 消失，只剩 A + 新图两行）。
    expect(screen.queryByText("B")).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(document.querySelectorAll(".tm-shortcut-item")).toHaveLength(2);
  });
});

describe("GalleryConfig · addUrl 校验 / 补全 / 去重（P2-4）", () => {
  it("非法 URL（无法解析）被拒：行内错误 + aria-invalid，不入库；输入修正后错误清除", async () => {
    const user = userEvent.setup();
    render(<GalleryConfig config={{}} update={vi.fn()} instanceId="g2" />);
    const input = screen.getByLabelText("添加图片链接") as HTMLInputElement;
    await user.type(input, "not a url{enter}");
    expect(screen.getByText("请输入有效的图片链接")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(loadGallery("g2")?.photos ?? []).toEqual([]);

    // 重新输入即清除行内错误。
    await user.clear(input);
    await user.type(input, "https://ok.example/1.png{enter}");
    expect(screen.queryByText("请输入有效的图片链接")).toBeNull();
    expect(urls("g2")).toEqual(["https://ok.example/1.png"]);
  });

  it("裸域名补全 https:// 入库；归一化后与现有图片按 url 去重（重复添加被拒）", async () => {
    const user = userEvent.setup();
    render(<GalleryConfig config={{}} update={vi.fn()} instanceId="g3" />);
    const input = screen.getByLabelText("添加图片链接") as HTMLInputElement;
    // 无 scheme 的裸域名补全 https://。
    await user.type(input, "pic.example/x.png{enter}");
    expect(urls("g3")).toEqual(["https://pic.example/x.png"]);
    expect(input.value).toBe("");

    // 换个写法（不带 scheme）再添加同一张：归一化后命中现有 url → 去重拒绝。
    await user.type(input, "pic.example/x.png{enter}");
    expect(screen.getByText("该图片链接已存在，请勿重复添加")).toBeInTheDocument();
    expect(loadGallery("g3")?.photos ?? []).toHaveLength(1);
  });
});
