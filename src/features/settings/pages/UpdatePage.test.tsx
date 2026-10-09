/**
 * 更新页无签名清单的自动安装入口阻断——
 * GitHub 302 兜底直链与 Insider Releases API 清单天然无 sha256/sig，
 * 主按钮「下载并安装」点击后必被 Rust download_update fail-closed 拒绝
 * （system_integration.rs）。修复后该场景改渲染「打开下载页」主按钮 +
 * autoInstallBlockReason 的阻断文案；带签名清单（sha256+sig 成对且验签
 * 通过）仍走原「下载并安装」入口，Rust 侧二次把关不动。
 *
 * 浏览器态断言不了按钮区（isTauri=false 只渲染占位），此处按
 * GeneralPage.test.tsx 的 vi.hoisted 共享态模式把 isTauri/invoke 打桩成
 * 桌面态，经「打开页面自动检查」effect 走真实 check() 链路。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/* UpdatePage 依赖链里有模块在顶层调用 isTauri()（先于测试体执行），
   mock 工厂共享态必须走 vi.hoisted，避免 TDZ。 */
const h = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
  tauriOn: false
}));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...mod,
    isTauri: () => h.tauriOn,
    invoke: (cmd: string, args?: unknown) => h.invokeMock(cmd, args)
  };
});

import { UpdatePage } from "./UpdatePage";
import { useSettingsStore } from "../../../store/settings-store";
import { UNSIGNED_INSTALL_BLOCKED } from "../../../lib/update-flow";

/** 更新源清单 JSON（extra 覆盖 sha256/sig 即带签名形态）。 */
const manifestJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: "0.2.0",
    notes: "修复若干问题",
    url: "https://example.com/Vela-win-Setup.exe",
    ...extra
  });

/** 桌面态 invoke 分发：当前版本 0.1.0，更新源返回 0.2.0 清单。 */
const stubDesktop = (manifest: string) => {
  h.tauriOn = true;
  h.invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_update_info") return { current_version: "0.1.0" };
    if (cmd === "fetch_url_text") return manifest;
    if (cmd === "verify_update_manifest") return true;
    return null;
  });
};

beforeEach(() => {
  localStorage.clear();
  h.invokeMock.mockReset();
  h.tauriOn = false;
  useSettingsStore.setState((s) => ({
    extra: { ...s.extra, updateEndpoint: "https://example.com/vela-latest.json", updateSkipVersion: "" }
  }));
});

describe("UpdatePage · FE-14 无签名清单阻断自动安装入口", () => {
  it("无签名清单：不渲染「下载并安装」主按钮，改渲染「打开下载页」+ 阻断原因", async () => {
    stubDesktop(manifestJson());
    render(<UpdatePage />);
    // 自动检查完成后出现新版本操作区。
    await waitFor(() => expect(screen.getByText("更新源版本")).toBeInTheDocument());
    expect(screen.getByText("v0.2.0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下载并安装/ })).toBeNull();
    // 主操作改为外链下载页（manifest.url 走 openExternal 通道）。
    expect(screen.getByRole("button", { name: /打开下载页/ })).toBeInTheDocument();
    // 阻断原因 = update-flow 的 UNSIGNED_INSTALL_BLOCKED 同口径文案。
    expect(screen.getByTestId("update-unsigned-reason")).toHaveTextContent(UNSIGNED_INSTALL_BLOCKED);
    // 跳过此版本入口保留（阻断的是自动安装，不是版本管理）。
    expect(screen.getByRole("button", { name: /跳过此版本/ })).toBeInTheDocument();
  });

  it("带签名清单（sha256+sig 成对且验签通过）：仍渲染「下载并安装」主按钮", async () => {
    stubDesktop(manifestJson({ sha256: "a".repeat(64), sig: "test-sig==" }));
    render(<UpdatePage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /下载并安装 v0\.2\.0/ })).toBeInTheDocument());
    expect(screen.queryByTestId("update-unsigned-reason")).toBeNull();
    expect(screen.getByRole("button", { name: /打开下载页/ })).toBeInTheDocument();
  });
});
