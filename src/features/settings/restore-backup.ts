/**
 * 共享的「按路径恢复完整备份」流程（自 DataPanel 抽出）：
 * 读文件 → 全量校验 → 确认对话框 → pause-ack 协议 → 整库替换 → reload-all。
 *
 * 两个调用方共用同一实现：DataPanel 的「选择文件恢复」（手动挑选）与
 * 自动备份列表的逐条「恢复」（路径已知，跳过文件对话框）。调用方只注入
 * flash / setRestoring 两个 UI 钩子。
 *
 * 安全约束：只能在设置窗口调用——Rust 侧 import_data 有窗口闸门
 * （require_settings_window），整库替换仅允许设置窗发起（防低信任窗注入
 * 构成更新链 RCE），见 commands.rs。
 */
import { invoke, currentWindowLabel } from "../../lib/tauri";
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

/**
 * 导入已成功下发后的收尾失败。语义必须与「校验/导入前失败」区分：
 * 前者 SQLite 已是备份的权威副本，release 闸门会让恢复前内存态的下一次
 * 保存反噬它；后者库未被触碰，解除闸门安全可重试。
 */
class PostImportError extends Error {}

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
    // 先全量校验 + 版本迁移，再落地。任何一项不通过就整体拒绝，
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
    /* 确认后进入恢复中：按钮 disabled + 全页「恢复中」遮罩淡入，
       覆盖 import_data / 镜像落地直到 reload。 */
    ui.setRestoring(true);
    /* B-审计修复（恢复 ack 协议）：广播 pause → 各窗口丢弃在飞落盘并回
       ack → 收齐（或超时兜底）后才导入 → reload-all（其他窗口直到 reload
       前保持闸门置位），防止在飞的防抖保存把旧态盖回刚恢复的数据。 */
    const { emit } = await import("@tauri-apps/api/event");
    const release = await pauseOtherWindowsPersistence();
    /* （恢复非原子 → 阶段化）：restoreFullBackup 一旦成功下发，
       SQLite 里已是备份的权威副本——此后任何失败（镜像写回 / reload 广播）
       都【不得 release 闸门】：解除后本窗口恢复前内存态的任何一次保存都会
       整包写回、反噬刚恢复的库。改为抛 PostImportError（用户可见中文）并
       安排延迟自动 reload（留 5s 让用户读完提示）。校验/导入下发前的失败
       仍走 release() + 原错误——库未被触碰，闸门解除安全（否则全应用持久化
       停摆）。 */
    let imported = false;
    let mirrorDone = false;
    try {
      // route through the write chain so a concurrently-in-flight
      // addSession/toggle can't interleave with this whole-table import.
      await sqliteRepo.restoreFullBackup(check.payload as unknown as AppData);
      imported = true;
      // 刚恢复的 SQLite 即权威：迁移标记在镜像写回**之前**置位（与
      // 镜像写回成败无关）——否则本窗 reload 后 migrateLocalStorageToSqlite
      // 会按 legacy 快照「行数更多则整表替换」把刚恢复的库反噬回浏览器时代
      // 残留。标记本身是瞬态键、从不随备份携带，只能本机补设。
      try {
        localStorage.setItem("focus-desk.migrated.v1", "1");
      } catch {
        // best-effort
      }
      await applyLocalStorageMirror(true);
      mirrorDone = true;
      // 成功路径不 release：本窗口若有在飞的防抖保存，reload 前的 pagehide
      // 冲刷会把旧内存状态盖回刚恢复的数据；闸门保持到 reload，模块态归零。
      await emit("app:reload-all");
      // 让遮罩至少呈现一帧再刷新，避免用户看到闪回。
      await new Promise((r) => window.setTimeout(r, 120));
      window.location.reload();
    } catch (err) {
      if (!imported) {
        // 导入未落地：库未被触碰，安全解除闸门（否则全应用持久化停摆）。
        release();
        throw err;
      }
      // 导入已落地：本窗闸门保持到 reload（在飞防抖保存与 pagehide 冲刷全部
      // 丢弃），但其他窗口必须尽快对齐——DB 已是权威副本，广播 reload-all
      // 让它们整体 reload（顺带解除各自闸门）；广播也失败时再补一次尽力而
      // 为的 sync:persist-resume 兜底：只放其他窗口的持久化停摆（权衡：它们
      // 恢复写回的是恢复前内存态，但「全应用静默停摆到下次 reload」更糟），
      // 本窗闸门始终不动。
      console.error("[restore] imported but post-import step failed", err);
      try {
        await emit("app:reload-all");
      } catch (bcErr) {
        console.error("[restore] reload-all broadcast failed", bcErr);
        try {
          // resume 载荷带发起方 label——按来源解除，并发恢复互不干扰。
          await emit("sync:persist-resume", currentWindowLabel() ?? "settings");
        } catch {
          // best-effort：其他窗口闸门最多保持到它们的下一次用户 reload。
        }
      }
      // 5s（错误文案约 28 汉字，2s 读不完）后自动 reload 对齐内存态。
      window.setTimeout(() => window.location.reload(), 5000);
      throw new PostImportError(
        mirrorDone
          ? t("备份已导入数据库，但通知其他窗口刷新失败，即将自动刷新以同步")
          : t("备份已导入数据库，但本地数据镜像写回失败，即将自动刷新以同步")
      );
    }
  } catch (err) {
    console.error("[restore] failed", err);
    ui.setRestoring(false);
    // 收尾失败给出可区分的用户语义（闸门未解除、reload 已排程）；
    // 其余失败维持原文案。
    ui.flash(err instanceof PostImportError ? err.message : t("恢复失败：文件格式不正确"), false);
  }
}
