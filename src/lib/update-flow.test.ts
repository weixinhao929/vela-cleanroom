/**
 * 更新链共享逻辑纯函数测试：严格校验 / 调度判定 /
 * 跳版 / CAS 门 / 产物名单段化。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  isValidManifestVersion,
  manifestUrlSafe,
  isCheckDue,
  isSkippedVersion,
  sanitizeArtifactName,
  githubFallbackManifest,
  acquireUpdateOp,
  releaseUpdateOp,
  currentUpdateOp,
  defaultUpdateChannel,
  effectiveUpdateChannel,
  githubReleasesApiUrl,
  pickReleaseAsset,
  parseGithubReleases,
  filterByChannel
} from "./update-flow";

describe("isValidManifestVersion（严格版本形态）", () => {
  it("接受三段数字与常规预发布后缀，拒绝任意字符串", () => {
    expect(isValidManifestVersion("0.2.0")).toBe(true);
    expect(isValidManifestVersion("v1.10.3")).toBe(true);
    expect(isValidManifestVersion("1.0.0-beta.1")).toBe(true);
    expect(isValidManifestVersion("1.0.0+build.5")).toBe(true);
    expect(isValidManifestVersion("latest")).toBe(false);
    expect(isValidManifestVersion("1.2")).toBe(false);
    expect(isValidManifestVersion("1.2.x")).toBe(false);
    expect(isValidManifestVersion("<script>")).toBe(false);
    expect(isValidManifestVersion("")).toBe(false);
  });
});

describe("manifestUrlSafe（下载 URL 附加门槛）", () => {
  it("拒绝非 https（D-1）、携带凭据、带空白的 URL", () => {
    expect(manifestUrlSafe("https://example.com/a.exe")).toBe(true);
    // http 源对 MITM 无防御力，更新链已停用（含内网地址）
    expect(manifestUrlSafe("http://192.168.1.4/pkg.exe")).toBe(false);
    expect(manifestUrlSafe("http://example.com/a.exe")).toBe(false);
    expect(manifestUrlSafe("javascript:alert(1)")).toBe(false);
    expect(manifestUrlSafe("file:///C:/x.exe")).toBe(false);
    expect(manifestUrlSafe("https://user:pass@example.com/a.exe")).toBe(false);
    expect(manifestUrlSafe("https://user@example.com/a.exe")).toBe(false);
    expect(manifestUrlSafe("https://example.com/a b.exe")).toBe(false);
    expect(manifestUrlSafe("not a url")).toBe(false);
  });
});

describe("isCheckDue / isSkippedVersion", () => {
  it("到期判定：≤0 仅手动永不到期；按间隔与上次检查时间比较", () => {
    const now = 1_000_000_000;
    expect(isCheckDue(0, 24, now)).toBe(true); // 从未检查 → 到期
    expect(isCheckDue(now - 23 * 3_600_000, 24, now)).toBe(false);
    expect(isCheckDue(now - 25 * 3_600_000, 24, now)).toBe(true);
    expect(isCheckDue(0, 0, now)).toBe(false); // 仅手动
    expect(isCheckDue(0, 168, now)).toBe(true); // 每周
  });

  it("跳版判定：v 前缀归一比较；空标记不跳", () => {
    expect(isSkippedVersion("0.3.0", "0.3.0")).toBe(true);
    expect(isSkippedVersion("v0.3.0", "0.3.0")).toBe(true);
    expect(isSkippedVersion("0.3.0", "")).toBe(false);
    expect(isSkippedVersion("0.4.0", "0.3.0")).toBe(false);
  });
});

describe("sanitizeArtifactName / githubFallbackManifest", () => {
  it("产物名必须是单段文件名：含路径分隔符或 .. 回退默认名", () => {
    expect(sanitizeArtifactName("Vela-win-Setup.exe")).toBe("Vela-win-Setup.exe");
    expect(sanitizeArtifactName("  Vela.exe  ")).toBe("Vela.exe");
    expect(sanitizeArtifactName("a/b.exe")).toBe("");
    expect(sanitizeArtifactName("..\\..\\x.exe")).toBe("");
    expect(sanitizeArtifactName("")).toBe("");
    const m = githubFallbackManifest("https://github.com/u/vela", "v0.2.0", "../evil.exe");
    expect(m.url).toBe("https://github.com/u/vela/releases/download/v0.2.0/Vela-win-Setup.exe");
  });
});

describe("CAS 门", () => {
  afterEach(() => releaseUpdateOp());
  it("idle 独占转移：占用期间其它获取失败，释放后可再获取", () => {
    expect(currentUpdateOp()).toBe("idle");
    expect(acquireUpdateOp("checking")).toBe(true);
    expect(acquireUpdateOp("downloading")).toBe(false);
    expect(currentUpdateOp()).toBe("checking");
    releaseUpdateOp();
    expect(acquireUpdateOp("downloading")).toBe(true);
    expect(currentUpdateOp()).toBe("downloading");
  });
});

/* ---- [UPD-CH] 通道与发布列表。 ---- */

describe("update channels", () => {
  it("通道跟随构建：-insider 版本默认 Insider", () => {
    expect(defaultUpdateChannel("0.1.0")).toBe("stable");
    expect(defaultUpdateChannel("0.2.0-insider1.4")).toBe("insider");
  });
  it("用户选过就完全听用户的；非法存储值回退构建默认", () => {
    expect(effectiveUpdateChannel("insider", true, "0.1.0")).toBe("insider");
    expect(effectiveUpdateChannel("stable", true, "0.2.0-insider")).toBe("stable");
    expect(effectiveUpdateChannel("garbage", true, "0.1.0")).toBe("stable");
    expect(effectiveUpdateChannel("stable", false, "0.2.0-insider")).toBe("insider");
  });
});

describe("githubReleasesApiUrl", () => {
  it("仓库地址 → api releases 地址", () => {
    expect(githubReleasesApiUrl("https://github.com/a/b")).toBe(
      "https://api.github.com/repos/a/b/releases?per_page=20"
    );
  });
});

describe("pickReleaseAsset", () => {
  const asset = (name: string, size = 100) => ({ name, size, browser_download_url: `https://x/${name}` });
  it("过滤非安装包与杂项资产", () => {
    expect(
      pickReleaseAsset([asset("notes.txt"), asset("Vela.sha256"), asset("Vela-portable.zip"), asset("Setup.exe")], "")
    ).toBe("https://x/Setup.exe");
  });
  it("优先固定产物名，其次 setup/installer，再取最大文件", () => {
    const list = [asset("Vela-win-Setup.exe", 50), asset("installer-x64.exe", 300), asset("big.zip", 999)];
    expect(pickReleaseAsset(list, "Vela-win-Setup.exe")).toBe("https://x/Vela-win-Setup.exe");
    expect(pickReleaseAsset([asset("a.exe", 1), asset("installer.exe", 2)], "")).toBe("https://x/installer.exe");
    expect(pickReleaseAsset([asset("a.exe", 1), asset("b.zip", 999)], "")).toBe("https://x/b.zip");
  });
});

describe("parseGithubReleases + filterByChannel", () => {
  it("逐条校验，坏条目跳过；stable 滤预发布", () => {
    const json = [
      {
        tag_name: "v1.2.0",
        prerelease: false,
        published_at: "2026-09-01T00:00:00Z",
        assets: [{ name: "Setup.exe", size: 5, browser_download_url: "https://x/Setup.exe" }]
      },
      { tag_name: "", prerelease: false },
      "garbage",
      {
        tag_name: "v1.3.0-beta",
        prerelease: true,
        published_at: "2026-09-20T00:00:00Z",
        assets: [{ name: "Setup.exe", size: 5, browser_download_url: "https://x/Setup2.exe" }]
      }
    ];
    const list = parseGithubReleases(json, "");
    expect(list).toHaveLength(2);
    expect(list[0].version).toBe("1.2.0");
    expect(list[1].prerelease).toBe(true);
    expect(filterByChannel(list, "stable")).toHaveLength(1);
    expect(filterByChannel(list, "insider")).toHaveLength(2);
  });
  it("非数组输入返回空", () => {
    expect(parseGithubReleases({ odd: true }, "")).toEqual([]);
  });
});
