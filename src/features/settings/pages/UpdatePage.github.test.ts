/**
 * 更新链 GitHub 兜底纯函数测试：
 *  - isGithubRepoUrl：github.com + owner/repo 判定，排除 releases 页与非 GitHub；
 *  - githubLatestProbeUrl：仓库根规范化成 releases/latest 探测地址；
 *  - githubFallbackManifest：tag 去前缀、固定产物名直链、空产物名回退默认；
 *  - compareVersions 既有行为回归（v 前缀容错）。
 */
import { describe, expect, it } from "vitest";

import { compareVersions, isGithubRepoUrl, githubLatestProbeUrl, githubFallbackManifest } from "./UpdatePage";

describe("isGithubRepoUrl", () => {
  it("接受 github.com 仓库根与带尾斜杠/深层路径", () => {
    expect(isGithubRepoUrl("https://github.com/user/vela")).toBe(true);
    expect(isGithubRepoUrl("https://github.com/user/vela/")).toBe(true);
    expect(isGithubRepoUrl("https://github.com/user/vela/tree/main")).toBe(true);
    expect(isGithubRepoUrl("https://GITHUB.COM/user/vela")).toBe(true);
  });

  it("拒绝非仓库形态与非 GitHub 域", () => {
    expect(isGithubRepoUrl("https://github.com/user")).toBe(false);
    expect(isGithubRepoUrl("https://github.com/user/vela/releases")).toBe(false);
    expect(isGithubRepoUrl("https://github.com/user/vela/releases/latest")).toBe(false);
    expect(isGithubRepoUrl("https://example.com/user/vela")).toBe(false);
    expect(isGithubRepoUrl("https://api.github.com/repos/user/vela")).toBe(false); // api 子域不是 github.com
    expect(isGithubRepoUrl("not a url")).toBe(false);
  });
});

describe("githubLatestProbeUrl", () => {
  it("仓库根（含多余段）规范化成 releases/latest", () => {
    expect(githubLatestProbeUrl("https://github.com/user/vela")).toBe("https://github.com/user/vela/releases/latest");
    expect(githubLatestProbeUrl("https://github.com/user/vela/tree/main?x=1")).toBe(
      "https://github.com/user/vela/releases/latest"
    );
  });
});

describe("githubFallbackManifest", () => {
  it("tag 去掉 v 前缀作版本号，直链用固定产物名", () => {
    const m = githubFallbackManifest("https://github.com/user/vela", "v0.2.0", "Vela-win-Setup.exe");
    expect(m.version).toBe("0.2.0");
    expect(m.url).toBe("https://github.com/user/vela/releases/download/v0.2.0/Vela-win-Setup.exe");
  });

  it("产物名为空时回退默认；tag 无 v 前缀原样保留", () => {
    const m = githubFallbackManifest("https://github.com/u/r/", "1.2.3", "  ");
    expect(m.url).toBe("https://github.com/u/r/releases/download/1.2.3/Vela-win-Setup.exe");
    expect(m.version).toBe("1.2.3");
  });
});

describe("compareVersions 回归", () => {
  it("v 前缀与不等长版本号", () => {
    expect(compareVersions("v0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  });
});
