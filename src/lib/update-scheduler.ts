/**
 * 更新检查调度器（BentoDesk 借鉴 #10）：主窗口（widget-0）启动即查一次、
 * 之后每小时醒一次看是否到期（默认 24h；每周 168h；0 = 仅手动关闭定时）。
 * 到期才真正发请求——空闲时段零网络。
 *
 * 发现新版本且未被跳过时弹 toast：「查看」直达设置更新页、「跳过此版本」
 * 写入 updateSkipVersion（此后该版本不再打扰，直到更高版本出现）。
 * 与检查/下载共用 update-flow 的 CAS 门：下载/安装进行中放弃本轮检查。
 * 检查后无论成败都记录 updateLastCheckAt——失败也按间隔节流，不打爆源站。
 */
import { isTauri, openSettingsWindow } from "./tauri";
import {
  acquireUpdateOp,
  releaseUpdateOp,
  resolveUpdateManifest,
  effectiveUpdateChannel,
  fetchCurrentVersion,
  compareVersions,
  isCheckDue,
  isSkippedVersion
} from "./update-flow";
import { useSettingsStore } from "../store/settings-store";
import { pushAppToast } from "../components/ToastHost";
import { t } from "../i18n-lite";

const HOUR_MS = 3_600_000;

async function maybeCheck(): Promise<void> {
  if (!isTauri()) return;
  const extra = useSettingsStore.getState().extra;
  if (!extra.updateEndpoint.trim() || extra.updateCheckIntervalHours <= 0) return;
  if (!isCheckDue(extra.updateLastCheckAt, extra.updateCheckIntervalHours, Date.now())) return;
  if (!acquireUpdateOp("checking")) return;
  let found: { version: string; skipped: boolean } | null = null;
  try {
    const current = await fetchCurrentVersion();
    if (current) {
      // [UPD-CH] 调度器同样按生效通道解析（Insider 走 Releases API）。
      const remote = await resolveUpdateManifest(
        extra.updateEndpoint,
        extra.updateArtifact,
        effectiveUpdateChannel(extra.updateChannel, extra.updateChannelSetByUser, current)
      );
      if (compareVersions(remote.version, current) > 0) {
        const skipped = isSkippedVersion(remote.version, extra.updateSkipVersion);
        found = { version: remote.version, skipped };
      }
    }
  } catch {
    // 静默：后台检查失败不打扰用户（下次到期再试）。
  } finally {
    releaseUpdateOp();
    useSettingsStore.getState().setExtra({ updateLastCheckAt: Date.now() });
  }
  if (found && !found.skipped) {
    const version = found.version;
    pushAppToast(
      t("发现新版本 v{v}").replace("{v}", () => version),
      "",
      "info",
      {
        // 跳过该版本的入口在更新页（toast 超时消失不等于用户想跳过，不在这里挂跳版）。
        action: {
          label: t("查看"),
          run: () => {
            useSettingsStore.getState().setSettingsPage("update");
            void openSettingsWindow();
          }
        }
      }
    );
  }
}

/** 启动调度器（幂等）：返回清理函数。仅主窗口调用（D-1 同款约束）。 */
export function startUpdateScheduler(): () => void {
  void maybeCheck();
  const timer = window.setInterval(() => void maybeCheck(), HOUR_MS);
  return () => window.clearInterval(timer);
}
