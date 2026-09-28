import type { AppState } from "../domain/schemas";
import { ValidationError } from "../domain/errors";
import { flags } from "../domain/flags";
import { t } from "../i18n-lite";

const BACKUP_KEY = "focus-desk.backup.v1";
const BACKUP_FLAG = "focus-desk.backup.flag";

/** 备份服务接口（策略模式）：JSON 快照的创建/导出/导入三操作。 */
export interface BackupService {
  /** 滚动快照写入 localStorage（flag 门控，best-effort 不阻断主流程）。 */
  createBackup(state: AppState): AppState;
  /** 导出完整校验安全的 JSON 快照字符串。 */
  exportJson(state: AppState): string;
  /** 解析并经 zod 校验后返回状态；失败抛 ValidationError。
      异步：zod/schemas 走动态 import（只在导入文件这条冷路径上需要，
      静态引入会把整个 zod 打进首屏主包）。 */
  importJson(raw: string): Promise<AppState>;
}

/**
 * JSON 备份/导入导出实现（单一事实来源仍是 SQLite/localStorage，
 * 这里只做快照与校验）。importJson 是所有 JSON 导入的唯一入口——
 * 未通过 schema 的数据绝不能进入内存。
 *
 * @example
 * ```ts
 * const state = await jsonBackupService.importJson(fileText);
 * ```
 */
export const jsonBackupService: BackupService = {
  createBackup(state) {
    if (!flags.autoBackup) return state;
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(state));
      localStorage.setItem(BACKUP_FLAG, Date.now().toString());
    } catch {
      // best-effort backup; never block the authoring flow
    }
    return state;
  },

  exportJson(state) {
    return JSON.stringify(state, null, 2);
  },

  async importJson(raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ValidationError("import.invalid-json", t("导入内容不是有效的 JSON"), err);
    }
    const { AppStateSchema } = await import("../domain/schemas");
    const result = AppStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError("import.schema", t("导入内容与数据结构不匹配"), result.error);
    }
    return result.data;
  }
};
