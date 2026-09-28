/**
 * 共享的「按路径恢复完整备份」流程（自 DataPanel 抽出）：
 * 读文件 → S2 全量校验 → 确认对话框 → pause-ack 协议 → 整库替换 → reload-all。
 *
 * 两个调用方共用同一实现：DataPanel 的「选择文件恢复」（手动挑选）与
 * 自动备份列表的逐条「恢复」（路径已知，跳过文件对话框）。调用方只注入
 * flash / setRestoring 两个 UI 钩子。
 *
 * 安全约束：只能在设置窗口调用——Rust 侧 import_data 有窗口闸门
 * （require_settings_window），整库替换仅允许设置窗发起（防低信任窗注入
 * 构成更新链 RCE），见 commands.rs。
 */
import { invoke } from "../../lib/tauri";
import { sqliteRepo } from "../../lib/persistence";
import { applyLocalStorageMirror } from "../../lib/local-backup";
import { pauseOtherWindowsPersistence } from "../../lib/persist-gate";
import { confirmDialog } from "../../components/PromptDialog";
import { parseAndValidateBackup, describeBackup } from "../../domain/backup-validate";
import { t } from "../../i18n-lite";
import type { AppData } from "../../types/bindings/AppData";

/** 调用方注入的 UI 反馈钩子（提示条与「恢复中」遮罩的归属组件）。 */
export type RestoreUi = {
  flash: (msg: string, ok?: boolean) => void;
  setRestoring: (v: boolean) => void;
};

/** 备份目录（get_backups_dir 命令的薄封装；浏览器模式返回空串）。 */
export async function fetchBackupsDir(): Promise<string> {
  try {
    return await invoke<string>("get_backups_dir");
  } catch {
    return "";
  }
}

/** 从 vela-*.json 备份文件恢复全部数据（校验 + 确认 + ack 协议 + reload）。 */
export async function restoreBackupFromPath(path: string, ui: RestoreUi): Promise<void> {
  try {
    const raw = await invoke<string>("read_text_file", { path });
    // S2：先全量校验 + 版本迁移，再落地。任何一项不通过就整体拒绝，
    // 绝不做部分导入 —— 因为 applyLocalStorageMirror(true) 是覆盖式的，
    // 半途失败会留下现有数据已清空、新数据不完整的不可逆状态。
    const check = parseAndValidateBackup(raw);
    if (!check.ok) {
      ui.flash(t("恢复失败：") + check.reason, false);
      return;
    }
    // 校验通过后再次确认，让用户看到将要导入的数据量。
    if (
      !(await confirmDialog({
        title: t("确认恢复完整备份"),
        message: `${t("将导入：")}${describeBackup(check.payload)}\n${t(
          "当前的任务、专注记录和小组件数据将被备份文件中的内容替换，此操作不可撤销。"
        )}${check.warnings.length > 0 ? `\n${check.warnings.join("；")}` : ""}`,
        confirmLabel: t("开始恢复"),
        danger: true
      }))
    ) {
      return;
    }
    /* #78 确认后进入恢复中：按钮 disabled + 全页「恢复中」遮罩淡入，
       覆盖 import_data / 镜像落地直到 reload。 */
    ui.setRestoring(true);
    /* B-审计修复（恢复 ack 协议）：广播 pause → 各窗口丢弃在飞落盘并回
       ack → 收齐（或超时兜底）后才导入 → reload-all（其他窗口直到 reload
       前保持闸门置位），防止在飞的防抖保存把旧态盖回刚恢复的数据。 */
    const { emit } = await import("@tauri-apps/api/event");
    const release = await pauseOtherWindowsPersistence();
    try {
      // E-2: route through the write chain so a concurrently-in-flight
      // addSession/toggle can't interleave with this whole-table import.
      await sqliteRepo.restoreFullBackup(check.payload as unknown as AppData);
      await applyLocalStorageMirror(true);
      // 刚恢复的 SQLite 即权威：显式置迁移标记，杜绝 reload 后一次性迁移
      // 把本机残留的浏览器时代快照整表覆盖回来。
      try {
        localStorage.setItem("focus-desk.migrated.v1", "1");
      } catch {
        // best-effort
      }
      // 成功路径不 release：本窗口若有在飞的防抖保存，reload 前的 pagehide
      // 冲刷会把旧内存状态盖回刚恢复的数据；闸门保持到 reload，模块态归零。
      await emit("app:reload-all");
      // 让遮罩至少呈现一帧再刷新，避免用户看到闪回。
      await new Promise((r) => window.setTimeout(r, 120));
      window.location.reload();
    } catch (err) {
      // 失败路径必须解除闸门，否则全应用持久化停摆。
      release();
      throw err;
    }
  } catch (err) {
    console.error("[restore] failed", err);
    ui.setRestoring(false);
    ui.flash(t("恢复失败：文件格式不正确"), false);
  }
}
