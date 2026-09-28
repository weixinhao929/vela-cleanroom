/* eslint-disable react-refresh/only-export-components */
/**
 * 设置页 · 更新页：检查更新（GitHub Releases）、版本对比与下载安装引导；
 * 附启动耗时诊断区（boot-profile）。
 * BentoDesk 借鉴 #10：共享逻辑（严格 manifest 校验 / GitHub 兜底 / CAS 门）
 * 在 lib/update-flow.ts（后台调度器共用一份）；本页补跳过此版本与检查频率。
 */
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Download, ExternalLink, History, RefreshCw, RotateCcw, SkipForward } from "lucide-react";
import { invoke, isTauri } from "../../../lib/tauri";
import { useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { useSettingsStore } from "../../../store/settings-store";
import { useTauriEvent } from "../../../lib/use-tauri-event";
import { Toggle, Segmented } from "../shared";
import { renderMiniMd } from "../../../lib/mini-md";
import {
  compareVersions,
  isGithubRepoUrl,
  githubLatestProbeUrl,
  githubFallbackManifest,
  resolveUpdateManifest,
  acquireUpdateOp,
  releaseUpdateOp,
  isSkippedVersion,
  effectiveUpdateChannel,
  githubReleasesApiUrl,
  parseGithubReleases,
  type GhRelease,
  type UpdateChannel
} from "../../../lib/update-flow";
import { recordCurrentVersion, type VersionEntry } from "../../../lib/version-history";

/* 测试锚点（UpdatePage.github.test.ts 从本文件导入；实现移至 lib/update-flow）。 */
export { compareVersions, isGithubRepoUrl, githubLatestProbeUrl, githubFallbackManifest };

// 线协议单一来源：Rust system_integration.rs::UpdateInfo 经 ts-rs 生成（M3）。
type UpdateInfo = import("../../../types/bindings/UpdateInfo").UpdateInfo;

type RemoteManifest = {
  version: string;
  notes?: string;
  url?: string;
  /** D-1：签名清单携带的安装包哈希（经 Ed25519 验签后随下载命令传给 Rust）。 */
  sha256?: string;
  sig?: string;
};

/** 用系统默认浏览器打开下载页（Tauri 经 open_path 的 URL 分支；浏览器模式 window.open + noopener）。 */
async function openExternal(url: string): Promise<void> {
  const { invoke, isTauri } = await import("../../../lib/tauri");
  if (isTauri()) {
    await invoke("open_path", { path: url }).catch(() => {});
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/**
 * 更新检查（真实链路）：用户在下方配置「更新源 JSON 地址」，应用通过
 * fetch 拉取 { version, notes, url } 并与当前版本做语义化比较。发现新版本
 * 时展示版本说明。更新源提供 `url` 时，可点击「下载并安装」→ Rust 侧
 * 流式下载 NSIS 安装包并静默安装、重启（E1 应用内自动更新）。
 */
export function UpdatePage() {
  const tr = useT();
  const s = useSettingsStore(
    useShallow((st) => ({
      extra: st.extra,
      setExtra: st.setExtra
    }))
  );
  const endpoint = s.extra.updateEndpoint;
  const autoCheck = s.extra.autoCheckUpdates;
  // 输入框走本地草稿、失焦 / Enter 才提交：此前每个按键即 setExtra（localStorage +
  // SQLite IPC 各落一次盘），且自动检查 effect 依赖 endpoint、失败时 checkedAt
  // 恒空 → 边输入边向半截 URL 发 fetch_url_text。
  const [endpointDraft, setEndpointDraft] = useState(endpoint);
  useEffect(() => {
    setEndpointDraft(endpoint);
  }, [endpoint]);
  const commitEndpoint = () => {
    const v = endpointDraft.trim();
    if (v !== endpoint) s.setExtra({ updateEndpoint: v });
  };
  const [current, setCurrent] = useState("");
  const [manifest, setManifest] = useState<RemoteManifest | null>(null);
  // [UPD-CH]（借鉴 CSH #6/#7）：生效通道（用户优先，否则跟随构建）+ 回滚列表 +
  // 本机版本历史。
  const channel: UpdateChannel = effectiveUpdateChannel(s.extra.updateChannel, s.extra.updateChannelSetByUser, current);
  const [releases, setReleases] = useState<GhRelease[] | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [confirmTag, setConfirmTag] = useState<string | null>(null);
  const [history, setHistory] = useState<VersionEntry[]>([]);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // E1：下载/安装状态。
  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState<{ done: number; total: number } | null>(null);
  const [dlDone, setDlDone] = useState(false);
  /** 卸载标记：慢网络的 check()/下载回调晚到时不再 setState。 */
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  // 当前版本来自 Rust 端（Cargo 包版本），同时展示前端构建时间。
  useEffect(() => {
    if (!isTauri()) return;
    invoke<UpdateInfo>("check_updates")
      .then((r) => setCurrent(r.current_version))
      .catch(() => setCurrent("unknown")); // #A-32：失败不伪造版本号，避免误判「有新版本」
  }, []);

  // [UPD-CH] 本机版本历史：进入更新页即刷新（首次运行记录 firstSeen，
  // 之后每次进来刷 lastSeen；通道变化记作新条目）。
  useEffect(() => {
    if (!current || current === "unknown") return;
    setHistory(recordCurrentVersion(current, channel));
  }, [current, channel]);

  // 订阅下载进度事件（Rust 侧流式下载时上报）。公共 hook（浏览器 no-op +
  // 静默失败），替代手写的「动态 import → listen → disposed 守卫」样板。
  // L1：载荷形状守卫——与其余事件消费者（tray-events 等）同款，不裸取下标。
  useTauriEvent<unknown>("update:progress", (p) => {
    if (!Array.isArray(p) || p.length < 2) return;
    const [done, total] = p;
    if (typeof done !== "number" || typeof total !== "number") return;
    setDlProgress({ done, total });
  });
  useTauriEvent<string>("update:progress-done", () => {
    setDlDone(true);
  });

  const check = async () => {
    const url = endpoint.trim();
    if (!url) {
      setError(tr("请先填写更新源地址"));
      return;
    }
    // BentoDesk 借鉴 #10：CAS 门——后台调度器检查/下载进行中放弃本轮。
    if (!acquireUpdateOp("checking")) return;
    setChecking(true);
    setError(null);
    try {
      // DeskOrder 借鉴 #9 + BentoDesk #10：严格校验的 manifest 拉取 +
      // GitHub 302 兜底（lib/update-flow，与后台调度器同一份实现）；
      // [UPD-CH] Insider 通道下 GitHub 源走 Releases API 取预发布。
      const remote = await resolveUpdateManifest(url, s.extra.updateArtifact, channel);
      // 慢网络下用户可能已离开更新页：卸载后不再 setState（React 18 起
      // no-op 但仍触发一次告警日志，且 checkedAt 会写入过期结果）。
      if (disposedRef.current) return;
      setManifest(remote);
      setHasUpdate(current && current !== "unknown" ? compareVersions(remote.version, current) > 0 : false);
      setCheckedAt(Date.now());
      s.setExtra({ updateLastCheckAt: Date.now() });
    } catch (e) {
      if (disposedRef.current) return;
      setManifest(null);
      setHasUpdate(false);
      setError(`${tr("更新源请求失败：")}${e instanceof Error ? e.message : String(e)}`);
      s.setExtra({ updateLastCheckAt: Date.now() });
    } finally {
      releaseUpdateOp();
      if (!disposedRef.current) setChecking(false);
    }
  };

  // 打开更新页自动检查（可在设置关闭）。
  useEffect(() => {
    if (isTauri() && autoCheck && endpoint.trim() && !checkedAt) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck, endpoint, current]);

  // #A-32：当前版本后到（异步载入晚于检查结果）时，用暂存的 manifest 补一次比较；
  // 版本未知时强制判定无更新，避免「unknown vs 任意版本」被误报为新版本。
  useEffect(() => {
    if (current === "unknown") {
      setHasUpdate(false);
      return;
    }
    if (manifest && current) setHasUpdate(compareVersions(manifest.version, current) > 0);
  }, [current, manifest]);

  /** E1：下载安装包并静默安装、重启应用。BentoDesk 借鉴 #10：下载/安装期间
      持有 CAS 门（安装成功后进程退出无需释放；失败在 finally 释放）。 */
  const downloadAndInstall = async () => {
    if (!manifest?.url || !isTauri()) return;
    if (!acquireUpdateOp("downloading")) return;
    setError(null);
    setDownloading(true);
    setDlProgress(null);
    setDlDone(false);
    try {
      const path = await invoke<string>("download_update", {
        url: manifest.url,
        // D-1：清单带签名时以签名锚定的哈希为准（Rust 侧优先于同源 sidecar）
        expectedSha256: manifest.sha256 ?? null
      });
      setDlDone(true);
      await invoke("install_update", { path });
      // 安装器运行后应用会退出；若未退出则给出提示。
    } catch (e) {
      setError(`${tr("更新失败：")}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      releaseUpdateOp();
      setDownloading(false);
    }
  };

  /** [UPD-CH] 回滚（借鉴 CSH #7）：不比版本高低，点哪个装哪个——复用同一套
   *  下载安装流程（sha256 校验与安装参数完全一致）。 */
  const installRelease = async (rel: GhRelease) => {
    if (!rel.url || !isTauri()) return;
    if (!acquireUpdateOp("downloading")) return;
    setError(null);
    setDownloading(true);
    setDlProgress(null);
    setDlDone(false);
    try {
      const path = await invoke<string>("download_update", {
        url: rel.url,
        // 回滚列表来自 GitHub Releases API（无签名清单），走 sidecar 兜底校验
        expectedSha256: null
      });
      setDlDone(true);
      await invoke("install_update", { path });
    } catch (e) {
      setError(`${tr("回滚失败：")}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      releaseUpdateOp();
      setDownloading(false);
      setConfirmTag(null);
    }
  };

  const loadReleases = async () => {
    if (!isGithubRepoUrl(endpoint.trim())) {
      setRollbackError(tr("回滚列表仅支持 GitHub 仓库形式的更新源"));
      return;
    }
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      const text = await invoke<string>("fetch_url_text", { url: githubReleasesApiUrl(endpoint.trim()) });
      const list = parseGithubReleases(JSON.parse(text), s.extra.updateArtifact);
      if (list.length === 0) setRollbackError(tr("仓库没有可用的发布版本"));
      setReleases(list);
    } catch (e) {
      setRollbackError(`${tr("发布列表请求失败：")}${e instanceof Error ? e.message : String(e)}`);
      setReleases(null);
    } finally {
      setRollbackBusy(false);
    }
  };

  const buildTime = (() => {
    try {
      const d = new Date(__BUILD_TIME__);
      if (Number.isNaN(d.getTime())) return "";
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch {
      return "";
    }
  })();

  const progressPct =
    dlProgress && dlProgress.total > 0 ? Math.min(100, Math.round((dlProgress.done / dlProgress.total) * 100)) : null;
  const fmtSize = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        <FxText text={tr("更新")} />
      </div>
      {!isTauri() ? (
        <div className="tm-placeholder">
          {tr("更新检查仅在桌面应用（Tauri）中可用。当前可通过浏览器模式预览界面。")}
        </div>
      ) : (
        <>
          <div className="tm-update-card">
            <div className="tm-update-row">
              <span>{tr("当前版本")}</span>
              <b>v{current && current !== "unknown" ? current : "—"}</b>
            </div>
            {buildTime && (
              <div className="tm-update-row">
                <span>{tr("构建时间")}</span>
                <b>{buildTime}</b>
              </div>
            )}
            {manifest && (
              <>
                <div className="tm-update-row">
                  <span>{tr("更新源版本")}</span>
                  <b>v{manifest.version}</b>
                </div>
                {/* [CHANGELOG]（ZTools 借鉴 #16）更新说明按 markdown 渲染
                    （GitHub Release body 常为 md；纯文本经 mini-md 原样通过）。 */}
                {manifest.notes && (
                  <div className="tm-update-note" data-testid="update-changelog">
                    {renderMiniMd(manifest.notes)}
                  </div>
                )}
                {checkedAt && (
                  <div className="tm-update-note muted">
                    {tr("检查于 {t}", { t: new Date(checkedAt).toLocaleTimeString() })}
                  </div>
                )}
              </>
            )}
            {!manifest && !error && !checking && (
              <div className="tm-update-note muted">
                {endpoint.trim()
                  ? tr("尚未检查，点击下方「检查更新」")
                  : tr("未配置更新源：填写一个返回 { version, notes, url } 的 JSON 地址即可启用真实更新检查")}
              </div>
            )}
            {hasUpdate &&
              manifest?.url &&
              !downloading &&
              !isSkippedVersion(manifest.version, s.extra.updateSkipVersion) && (
                <div className="tm-update-actions">
                  <button
                    className="tm-btn-primary tm-update-dl"
                    onClick={() => void downloadAndInstall()}
                    disabled={downloading}
                  >
                    <Download size={14} /> {tr("下载并安装")} v{manifest.version}
                  </button>
                  <button className="tm-btn-secondary tm-update-dl" onClick={() => void openExternal(manifest.url!)}>
                    <ExternalLink size={14} /> {tr("打开下载页")}
                  </button>
                  {/* BentoDesk 借鉴 #10：跳过此版本——写 updateSkipVersion，后台
                    调度与更新页均不再提示该版本（更高版本出现时自动恢复）。 */}
                  <button
                    className="tm-btn-secondary tm-update-dl"
                    onClick={() => s.setExtra({ updateSkipVersion: manifest.version })}
                    title={tr("本版本不再提示，直到更高版本发布")}
                  >
                    <SkipForward size={14} /> {tr("跳过此版本")}
                  </button>
                </div>
              )}
            {hasUpdate && manifest && isSkippedVersion(manifest.version, s.extra.updateSkipVersion) && (
              <div className="tm-update-note muted">
                {tr("已跳过 v")}
                {manifest.version}
                <button
                  className="tm-btn-secondary"
                  style={{ marginLeft: 8 }}
                  onClick={() => s.setExtra({ updateSkipVersion: "" })}
                >
                  {tr("撤销跳过")}
                </button>
              </div>
            )}
            {downloading && (
              <div className="tm-update-note tm-update-progress">
                <div className="tm-update-progress-bar" aria-hidden="true">
                  <i style={{ transform: `scaleX(${(dlDone ? 100 : (progressPct ?? 4)) / 100})` }} />
                </div>
                <span className="tm-update-progress-text" key={dlDone ? "done" : (progressPct ?? "indeterminate")}>
                  {dlDone
                    ? tr("下载完成，正在安装…")
                    : progressPct != null
                      ? `${tr("正在下载 {done} / {total}", { done: fmtSize(dlProgress!.done), total: fmtSize(dlProgress!.total) })} (${progressPct}%)`
                      : tr("正在下载…")}
                </span>
              </div>
            )}
            {hasUpdate && !manifest?.url && (
              <div className="tm-update-note ok">
                <Check size={13} /> {tr("发现新版本，但更新源未提供下载地址")}
              </div>
            )}
            {!hasUpdate && manifest && (
              <div className="tm-update-note ok">
                <Check size={13} /> {tr("已是最新版本")}
              </div>
            )}
          </div>

          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("更新源地址")}</span>
              <span className="tm-setting-desc">
                {tr("返回 { version, notes, url } 的 JSON 链接，或直接填 GitHub 仓库地址")}
              </span>
            </div>
            <div className="tm-location-controls">
              <input
                className="tm-text-input"
                value={endpointDraft}
                placeholder="https://example.com/vela-latest.json"
                aria-label={tr("更新源地址")}
                onChange={(e) => setEndpointDraft(e.target.value)}
                onBlur={commitEndpoint}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEndpoint();
                }}
              />
            </div>
          </div>

          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("安装包文件名")}</span>
              <span className="tm-setting-desc">
                {tr("GitHub 仓库地址兜底直链用的固定产物名（发布时上传不带版本号的同名文件与 .sha256）")}
              </span>
            </div>
            <div className="tm-location-controls">
              <input
                className="tm-text-input"
                value={s.extra.updateArtifact}
                placeholder="Vela-win-Setup.exe"
                aria-label={tr("安装包文件名")}
                onChange={(e) => s.setExtra({ updateArtifact: e.target.value })}
              />
            </div>
          </div>

          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("打开页面时自动检查")}</span>
              <span className="tm-setting-desc">{tr("进入更新页自动请求一次更新源")}</span>
            </div>
            <Toggle
              on={autoCheck}
              onChange={(v) => s.setExtra({ autoCheckUpdates: v })}
              ariaLabel={tr("打开页面时自动检查")}
            />
          </div>

          {/* [UPD-CH]（借鉴 CSH #6）：双通道 + 通道跟随构建默认。 */}
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("更新通道")}</span>
              <span className="tm-setting-desc">
                {s.extra.updateChannelSetByUser
                  ? tr("稳定通道只收正式版；Insider 通道预发布优先，新功能先到")
                  : tr("未手动选择时跟随安装包来源（版本含 -insider 即 Insider）")}
              </span>
            </div>
            <Segmented
              value={channel}
              options={[
                { id: "stable", label: tr("稳定通道") },
                { id: "insider", label: tr("Insider 通道") }
              ]}
              onChange={(v) => s.setExtra({ updateChannel: v, updateChannelSetByUser: true })}
            />
          </div>

          {/* [UPD-CH]（借鉴 CSH #7）：从仓库加载可回滚的版本。 */}
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("从仓库加载可回滚的版本")}</span>
              <span className="tm-setting-desc">
                {tr("列出最近 20 个发布，点击安装即回滚（同一套校验与静默安装）")}
              </span>
            </div>
            <button
              className="tm-btn-secondary"
              onClick={() => void loadReleases()}
              disabled={rollbackBusy || !endpoint.trim()}
            >
              <RotateCcw size={13} /> {rollbackBusy ? tr("加载中…") : tr("加载版本列表")}
            </button>
          </div>
          {rollbackError && <div className="tm-monitor-msg">{rollbackError}</div>}
          {releases && releases.length > 0 && (
            <div className="tm-update-rollback" data-interactive>
              {releases.map((rel) => (
                <div key={rel.tag} className="tm-update-rollback-row">
                  <span className="tm-update-rollback-version">
                    v{rel.version}
                    {rel.prerelease && <i className="tm-update-prerelease">{tr("预发布")}</i>}
                    {rel.version === current && <i className="tm-update-current-badge">{tr("当前")}</i>}
                  </span>
                  <span className="tm-update-rollback-date">
                    {rel.publishedAt ? new Date(rel.publishedAt).toLocaleDateString() : ""}
                  </span>
                  {rel.url ? (
                    confirmTag === rel.tag ? (
                      <button
                        className="tm-btn-primary"
                        disabled={downloading}
                        onClick={() => void installRelease(rel)}
                      >
                        {downloading ? tr("正在下载…") : tr("确认安装")}
                      </button>
                    ) : (
                      <button
                        className="tm-btn-secondary"
                        disabled={downloading}
                        onClick={() => setConfirmTag(rel.tag)}
                      >
                        {tr("安装此版本")}
                      </button>
                    )
                  ) : (
                    <span className="tm-update-note muted">{tr("无可安装资产")}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* [UPD-CH]（借鉴 CSH #7）：本机版本历史（运行记录，与仓库列表分开）。 */}
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("本机版本历史")}</span>
              <span className="tm-setting-desc">{tr("这台电脑运行过哪些版本（首次 / 最近）")}</span>
            </div>
            <History size={15} style={{ color: "var(--muted-3)", flexShrink: 0 }} />
          </div>
          {history.length > 0 ? (
            <div className="tm-update-rollback" data-interactive>
              {history.map((h) => (
                <div key={`${h.version}-${h.channel}`} className="tm-update-rollback-row">
                  <span className="tm-update-rollback-version">
                    v{h.version}
                    {h.channel === "insider" && <i className="tm-update-prerelease">Insider</i>}
                    {h.version === current && <i className="tm-update-current-badge">{tr("当前")}</i>}
                  </span>
                  <span className="tm-update-rollback-date">
                    {tr("首次 {d}", { d: new Date(h.firstSeen).toLocaleDateString() })} ·{" "}
                    {tr("最近 {d}", { d: new Date(h.lastSeen).toLocaleDateString() })}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="tm-update-note muted">{tr("暂无记录")}</div>
          )}

          {/* BentoDesk 借鉴 #10：定时检查频率（主窗口启动即查 + 周期醒查；
              仅手动 = 关闭后台定时，页面手动检查不受影响）。 */}
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("定时检查频率")}</span>
              <span className="tm-setting-desc">{tr("应用启动后按此周期在后台检查更新（发现新版本弹提醒）")}</span>
            </div>
            <Segmented
              value={
                s.extra.updateCheckIntervalHours >= 168 ? "168" : s.extra.updateCheckIntervalHours >= 1 ? "24" : "0"
              }
              options={[
                { id: "24", label: tr("每天") },
                { id: "168", label: tr("每周") },
                { id: "0", label: tr("仅手动") }
              ]}
              onChange={(v) => s.setExtra({ updateCheckIntervalHours: Number(v) })}
            />
          </div>

          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("检查更新")}</span>
              <span className="tm-setting-desc">{tr("立即向更新源查询新版本")}</span>
            </div>
            <button
              className="tm-btn-secondary"
              onClick={() => void check()}
              disabled={checking || !endpoint.trim() || current === "unknown"}
              title={current === "unknown" ? tr("正在获取当前版本…") : undefined}
            >
              <RefreshCw size={13} className={checking ? "spin" : ""} /> {checking ? tr("检查中…") : tr("检查")}
            </button>
          </div>
          {error && <div className="tm-monitor-msg">{error}</div>}
        </>
      )}
    </section>
  );
}
