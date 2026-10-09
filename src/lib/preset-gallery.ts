/**
 * 在线预设画廊：
 * 用户配置画廊源（GitHub 仓库地址或 manifest 直链），拉取
 * { version, presets: [...] } 清单 → 卡片列表 → 下载（sha256 强校验 +
 * .part 原子落盘，Rust download_gallery_file）→ 走既有预设包导入链
 * （import_preset_package_from_path + importPresetsFromPackage）。
 * 零服务器：manifest 与 zip 都放在公开仓库里即可。
 */
import { invoke } from "./tauri";
import { importPresetsFromPackage } from "./style-presets";

export type GalleryPreset = {
  id: string;
  name: string;
  desc: string;
  /** 相对 manifest 的包路径（单段或多段子路径，禁 .. 与反斜杠）。 */
  file: string;
  /** 64 位小写 hex（下载强校验）。 */
  sha256: string;
  /** 字节数（展示用；真实上限在 Rust 侧）。 */
  size: number;
};

export type InstallResult = { added: number; skipped: number };

/** 画廊源 → manifest 地址：GitHub 仓库地址映射到 raw.githubusercontent
 *  的 gallery-manifest.json；`/tree/<branch>`（或 blob）段识别分支，缺省
 *  main；其余按直链使用。 */
export function resolveGalleryManifestUrl(source: string): string | null {
  const src = source.trim();
  if (!src) return null;
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // www.github.com 与 github.com 同站（粘贴浏览器地址栏常带 www）。
    const host = u.hostname.toLowerCase().replace(/^www\.github\.com$/, "github.com");
    if (host === "github.com") {
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length < 2 || u.pathname.includes("/releases")) return null;
      // /tree/<branch>（网页分支视图）或 /blob/<branch>（文件视图）指定分支；
      // 默认分支不是 main 的仓库此前被硬编码 main 映射到 404。
      let branch = "main";
      const ti = segs.findIndex((seg) => seg === "tree" || seg === "blob");
      if (ti >= 0 && segs.length > ti + 1) branch = segs[ti + 1];
      return `https://raw.githubusercontent.com/${segs[0]}/${segs[1]}/${branch}/gallery-manifest.json`;
    }
    return u.href;
  } catch {
    return null;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** 包路径合法性：非空、无 ..、无反斜杠、不以 / 开头（相对路径）。 */
export function safeGalleryFilePath(file: string): boolean {
  const f = file.trim();
  if (!f || f.startsWith("/") || f.includes("\\") || f.includes("..")) return false;
  return /\.(zip|velapreset)$/i.test(f);
}

/** 解析 manifest（逐条校验，坏条目跳过；整体非对象/非数组返回空）。 */
export function parseGalleryManifest(json: unknown): GalleryPreset[] {
  if (!json || typeof json !== "object") return [];
  const list = (json as Record<string, unknown>).presets;
  if (!Array.isArray(list)) return [];
  const out: GalleryPreset[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const file = typeof o.file === "string" ? o.file.trim() : "";
    const sha256 = typeof o.sha256 === "string" ? o.sha256.trim().toLowerCase() : "";
    if (!id || !name || !safeGalleryFilePath(file) || !HEX64.test(sha256)) continue;
    out.push({
      id,
      name,
      desc: typeof o.desc === "string" ? o.desc.slice(0, 200) : "",
      file,
      sha256,
      size: typeof o.size === "number" && o.size >= 0 ? o.size : 0
    });
  }
  return out;
}

/** 包相对路径 → 绝对 URL（基于 manifest 目录解析）。 */
export function galleryFileUrl(manifestUrl: string, file: string): string {
  return new URL(file, manifestUrl).href;
}

/** 拉取并解析画廊清单（Rust 受信代理 fetch_url_text：http/https + 内网拒绝）。 */
export async function fetchGalleryManifest(source: string): Promise<GalleryPreset[]> {
  const manifestUrl = resolveGalleryManifestUrl(source);
  if (!manifestUrl) throw new Error("bad gallery source");
  const text = await invoke<string>("fetch_url_text", { url: manifestUrl });
  return parseGalleryManifest(JSON.parse(text));
}

/** 下载 + 校验 + 导入一个画廊预设（返回新增/跳过计数）。 */
export async function installGalleryPreset(manifestUrl: string, preset: GalleryPreset): Promise<InstallResult> {
  const url = galleryFileUrl(manifestUrl, preset.file);
  const path = await invoke<string>("download_gallery_file", { url, expectedSha256: preset.sha256 });
  const raw = await invoke<string | null>("import_preset_package_from_path", { path });
  if (raw == null) return { added: 0, skipped: 0 };
  return importPresetsFromPackage(raw);
}
