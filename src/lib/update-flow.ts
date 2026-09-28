/**
 * 更新链共享逻辑（BentoDesk 借鉴 #10，从 UpdatePage 拆出供调度器复用）：
 *
 * - **严格 manifest 校验**：版本号必须是 vX.Y.Z 形态、下载 URL 禁止携带
 *   凭据（user:pass@）/非 http(s) 协议——把「manifest 被改成任意下载链接/
 *   凭据钓鱼链接」这类攻击面在前端先关一道（下载域白名单在 Rust 侧）。
 * - **操作状态 CAS 门**：idle/checking/downloading/installing 原子转移，
 *   防止定时检查、手动检查、下载安装并发交叠（BentoDesk UpdateOperation
 *   同款语义；安装后进程退出，不需要显式释放）。
 * - **调度判定纯函数**：isCheckDue（按小时间隔 + 上次检查时间）、
 *   isSkippedVersion。
 *
 * 纯函数在此直接单测；resolveUpdateManifest 是带 IPC 的组装件（manifest
 * 拉取 + GitHub 302 兜底），UpdatePage 与后台调度器共用一份实现。
 */
import { invoke, isTauri } from "./tauri";

export type RemoteManifest = {
  version: string;
  notes?: string;
  url?: string;
  /** 安装包 SHA-256（64 hex）。与 sig 成对出现时经签名锚定，优先于同源 sidecar。 */
  sha256?: string;
  /** Ed25519 签名（base64），签名对象为 buildManifestPayload 的产出。 */
  sig?: string;
};

/* ---- 语义化版本与 GitHub 兜底（原 UpdatePage 实现，测试锚点不变）。 ---- */

/** 语义化版本比较：a > b 返回 1，相等 0，小于 -1。容错非标准输入。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** D-1：更新链只接受 https 绝对地址（http 源对 MITM 无防御力，已停用）。 */
export function safeHttpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** 严格版本形态：v 前缀可选 + 三段数字 + 常规预发布/构建后缀。 */
export function isValidManifestVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+([-+][\w.-]+)?$/i.test(v.trim().replace(/^v/i, ""));
}

/** 下载 URL 附加门槛：非 https（D-1）、携带凭据（user:pass@host）、带空白的一律拒绝。 */
export function manifestUrlSafe(v: string): boolean {
  if (/\s/.test(v)) return false;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") return false;
    // URL 解析后 username/password 非空即携带凭据（浏览器会把它拼进请求头）。
    return u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** DeskOrder 借鉴 #9：更新源是 GitHub 仓库地址（owner/repo 两段、不含 /releases）。 */
export function isGithubRepoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== "github.com") return false;
    const segs = u.pathname.split("/").filter(Boolean);
    return segs.length >= 2 && !u.pathname.includes("/releases");
  } catch {
    return false;
  }
}

/** 仓库根 URL → releases/latest 探测地址。 */
export function githubLatestProbeUrl(url: string): string {
  const u = new URL(url);
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  return `https://github.com/${owner}/${repo}/releases/latest`;
}

/** tag（如 v0.2.0）→ 版本号 + 固定产物名直链。产物名必须是单段文件名
 *  （禁止 / \ 与 ..，防直链路径被改名）。 */
export function githubFallbackManifest(repoUrl: string, tag: string, artifact: string): RemoteManifest {
  const u = new URL(repoUrl);
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  const name = sanitizeArtifactName(artifact) || "Vela-win-Setup.exe";
  return {
    version: tag.replace(/^v/, ""),
    notes: undefined,
    url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`
  };
}

/** 安装包产物名单段化：含路径分隔符或 .. 的输入返回空串（回退默认名）。 */
export function sanitizeArtifactName(name: string): string {
  const n = name.trim();
  if (!n || /[/\\]/.test(n) || n.includes("..")) return "";
  return n;
}

/* ---- 调度与跳版（纯函数）。 ---- */

/** 到期判定：间隔 ≤0（仅手动）永不到期；距上次检查 ≥ 间隔才到期。 */
export function isCheckDue(lastCheckAt: number, intervalHours: number, now: number): boolean {
  if (intervalHours <= 0) return false;
  return now - lastCheckAt >= intervalHours * 3_600_000;
}

/** 跳版判定：跳过标记非空且版本一致（前缀 v 归一后比较）。 */
export function isSkippedVersion(version: string, skipped: string): boolean {
  if (!skipped) return false;
  return version.trim().replace(/^v/i, "") === skipped.trim().replace(/^v/i, "");
}

/* ---- 更新通道（借鉴 ClassSoftwareHub #6：稳定 / Insider 双通道）。 ---- */

export type UpdateChannel = "stable" | "insider";

/** 通道跟随构建：安装包版本带 -insider 后缀 → 默认 Insider。 */
export function defaultUpdateChannel(appVersion: string): UpdateChannel {
  return /-insider/i.test(appVersion.trim()) ? "insider" : "stable";
}

/** 生效通道：用户亲手选过就完全听用户的，否则跟随构建（CSH 同款语义）。 */
export function effectiveUpdateChannel(stored: unknown, setByUser: boolean, appVersion: string): UpdateChannel {
  if (setByUser && (stored === "stable" || stored === "insider")) return stored;
  return defaultUpdateChannel(appVersion);
}

/* ---- GitHub Releases 列表（借鉴 ClassSoftwareHub #7：回滚 = 同一安装流程）。 ---- */

export type GhRelease = {
  tag: string;
  version: string;
  prerelease: boolean;
  publishedAt: string;
  url: string | null;
  notes: string;
};

/** 仓库地址 → Releases API 地址（最近 20 条，与 CSH 回滚列表同规格）。 */
export function githubReleasesApiUrl(repoUrl: string): string {
  const u = new URL(repoUrl);
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  return `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`;
}

type GhAsset = { name: string; size: number; url: string };

/** 资产挑选（CSH 规则）：exe/msi/zip，排除校验和/便携版等杂项；优先用户
 * 配置的固定产物名，其次名字含 setup/installer，再取最大文件。 */
export function pickReleaseAsset(assets: unknown, artifact: string): string | null {
  if (!Array.isArray(assets)) return null;
  const list: GhAsset[] = [];
  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    const url = typeof o.browser_download_url === "string" ? o.browser_download_url : "";
    if (!name || !url) continue;
    if (!/\.(exe|msi|zip)$/i.test(name)) continue;
    if (/checksum|sha256|sha1|md5|portable|blockmap|symbols/i.test(name)) continue;
    list.push({ name, size: typeof o.size === "number" ? o.size : 0, url });
  }
  if (list.length === 0) return null;
  const want = sanitizeArtifactName(artifact).toLowerCase();
  const exact = want ? list.find((a) => a.name.toLowerCase() === want) : undefined;
  if (exact) return exact.url;
  const setup = list.find((a) => /setup|installer/i.test(a.name));
  if (setup) return setup.url;
  return list.reduce((best, a) => (a.size > best.size ? a : best)).url;
}

/** 解析 GitHub Releases API 响应为回滚列表（逐条校验，坏条目跳过）。 */
export function parseGithubReleases(json: unknown, artifact: string): GhRelease[] {
  if (!Array.isArray(json)) return [];
  const out: GhRelease[] = [];
  for (const r of json) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const tag = typeof o.tag_name === "string" ? o.tag_name.trim() : "";
    if (!tag) continue;
    out.push({
      tag,
      version: tag.replace(/^v/i, ""),
      prerelease: o.prerelease === true,
      publishedAt: typeof o.published_at === "string" ? o.published_at : "",
      url: pickReleaseAsset(o.assets, artifact),
      // [CHANGELOG]（ZTools 借鉴 #16）Release body 常为成段 markdown，400 字
      // 只够一行标题——放宽到 4000（更新页用 mini-md 渲染）。
      notes: typeof o.body === "string" ? o.body.slice(0, 4000) : ""
    });
  }
  return out;
}

/** 通道过滤：stable 只看正式发布，insider 全跟。 */
export function filterByChannel(releases: readonly GhRelease[], channel: UpdateChannel): GhRelease[] {
  return channel === "insider" ? [...releases] : releases.filter((r) => !r.prerelease);
}

/* ---- 操作状态 CAS 门。 ---- */

export type UpdateOp = "idle" | "checking" | "downloading" | "installing";
let op: UpdateOp = "idle";

export function currentUpdateOp(): UpdateOp {
  return op;
}

/** 从 idle 原子转移到目标态；已被占用返回 false（调用方静默放弃本轮）。 */
export function acquireUpdateOp(next: UpdateOp): boolean {
  if (op !== "idle") return false;
  op = next;
  return true;
}

export function releaseUpdateOp(): void {
  op = "idle";
}

/* ---- manifest 解析（拉取 + 严格校验 + GitHub 302 兜底）。 ---- */

/** 64 位十六进制校验。 */
function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v);
}

/**
 * 验证清单 Ed25519 签名（Rust 侧离线公钥 + 单点载荷规范化）。带 sig 的清单
 * 签名不过即抛错（fail-closed：宁可不更新也不能装被改过的哈希）。不带 sig
 * 的清单返回 false（走旧的 sidecar 校验路径，较弱但兼容存量更新源）。
 */
export async function verifyManifestSignature(m: RemoteManifest): Promise<boolean> {
  if (!m.sig || !m.sha256) return false;
  return invoke<boolean>("verify_update_manifest", {
    version: m.version,
    notes: m.notes ?? "",
    url: m.url ?? "",
    sha256: m.sha256,
    sig: m.sig
  });
}

/** 拉取并严格校验用户自配更新源 JSON（Rust 受信代理，CSP 不放行 webview 直连）。 */
export async function fetchRemoteManifest(endpoint: string): Promise<RemoteManifest> {
  // D-1：更新源 endpoint 本身必须 https——http 源上的 manifest 可被链路
  // 中间人整体替换，后续同域校验会锚定到攻击者域。
  if (!/^https:\/\//i.test(endpoint.trim())) {
    throw new Error("更新源必须为 https 地址");
  }
  const text = await invoke<string>("fetch_url_text", { url: endpoint });
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) throw new Error("bad manifest");
  const m = data as Record<string, unknown>;
  if (typeof m.version !== "string" || !isValidManifestVersion(m.version)) throw new Error("bad version");
  const url = safeHttpUrl(m.url);
  if (url && !manifestUrlSafe(url)) throw new Error("unsafe manifest url");
  // sha256 与 sig 必须成对出现：只有哈希没有签名没有意义（哈希本身可被换）。
  const hasSig = typeof m.sig === "string" && m.sig.length > 0;
  const sha256 = isSha256Hex(m.sha256) ? (m.sha256 as string).toLowerCase() : undefined;
  if (hasSig !== (sha256 !== undefined)) throw new Error("sig/sha256 必须成对出现");
  return {
    version: m.version.trim().replace(/^v/i, ""),
    notes: typeof m.notes === "string" ? m.notes : undefined,
    url,
    sha256,
    sig: hasSig ? (m.sig as string) : undefined
  };
}

/** manifest + GitHub 兜底的完整解析（UpdatePage.check 与后台调度器共用）。
 *  [UPD-CH] Insider 通道 + GitHub 仓库源改走 Releases API（取通道内最新，
 *  预发布优先）；API 失败回退 latest 302 探测（= 稳定语义）。 */
export async function resolveUpdateManifest(
  endpoint: string,
  artifact: string,
  channel: UpdateChannel = "stable"
): Promise<RemoteManifest> {
  const url = endpoint.trim();
  let manifestError: unknown = null;
  if (channel === "insider" && isGithubRepoUrl(url)) {
    try {
      const text = await invoke<string>("fetch_url_text", { url: githubReleasesApiUrl(url) });
      const releases = parseGithubReleases(JSON.parse(text), artifact);
      const top = filterByChannel(releases, "insider").find((r) => r.url);
      if (top) return { version: top.version, notes: top.notes || undefined, url: top.url ?? undefined };
    } catch (e) {
      manifestError = e;
    }
  }
  let remote: RemoteManifest | null = null;
  try {
    remote = await fetchRemoteManifest(url);
    // D-1：带签名的清单必须验签通过才可用（fail-closed）；无签名清单继续
    // 走 Rust 侧的同源 sidecar 校验（较弱，仅防损坏）。
    if (remote.sig && !(await verifyManifestSignature(remote))) {
      throw new Error("更新清单签名验证失败（更新源可能被篡改，已拒绝）");
    }
  } catch (e) {
    manifestError = e;
  }
  if (!remote && isGithubRepoUrl(url)) {
    const tag = await invoke<string | null>("resolve_latest_tag", {
      url: githubLatestProbeUrl(url)
    }).catch(() => null);
    if (tag) remote = githubFallbackManifest(url, tag, artifact);
  }
  if (!remote) throw manifestError ?? new Error("bad manifest");
  return remote;
}

/** 当前版本（Rust Cargo 包版本）；失败返回 null（不伪造，防误判新版本）。 */
export async function fetchCurrentVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const r = await invoke<{ current_version: string }>("check_updates");
    return r.current_version;
  } catch {
    return null;
  }
}
