import type { AppState } from "../../domain/schemas";
import type { PersistenceAdapter } from "../../ports/persistence";
import { pushAppToast } from "../../components/ToastHost";
import { t } from "../../i18n-lite";

const STORAGE_KEY = "focus-desk.state.v1";
let quotaToastShown = false;

/**
 * localStorage 持久化适配器（适配器模式）。
 *
 * 使用场景：浏览器开发模式下 Tauri/SQLite 不可用时的降级存储。
 * load 时经 zod 部分校验；损坏数据隔离为 `.corrupt-<ts>` 副本并弹
 * toast 告知（而非静默清空）；save 配额溢出首次弹 toast、后续仅记日志。
 */
export const localStorageAdapter: PersistenceAdapter = {
  kind: "localStorage",

  async load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      // zod/schemas 动态 import：只在 load 校验这条路径需要，避免整个 zod
      // 随本适配器静态进入首屏主包（浏览器降级模式同样受益于小主包）。
      const { AppStateSchema } = await import("../../domain/schemas");
      const parsed = AppStateSchema.partial().safeParse(JSON.parse(raw));
      if (parsed.success) {
        return parsed.data as Partial<AppState>;
      }
      throw new Error("schema validation failed");
    } catch (err) {
      // A-3/A-35: the stored payload is present but invalid (e.g. a non-ISO date
      // smuggled in by CSV import). Preserve it under a `.corrupt-<ts>` key and
      // log, otherwise the next flush would overwrite the only copy with a
      // near-empty default state — irreversible loss.
      try {
        localStorage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw);
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // best-effort; the console.warn below still records the failure
      }
      console.warn("[persistence] corrupt app state preserved for recovery:", err);
      // P2（审计修复）：隔离对用户完全不可见——UI 以空状态启动，用户看到
      // 的是"任务全没了"，恢复副本埋在无人知晓的 localStorage 键里。弹
      // toast 告知（toast 系统此时可能未挂载，best-effort）。
      try {
        pushAppToast(t("检测到损坏的本地数据"), t("已自动隔离保存副本；本次将以空数据启动。"), "error");
      } catch {
        // best-effort
      }
      return null;
    }
  },

  async save(state: AppState) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      // P2（审计修复）：任一次写入成功即复位提示锁存——此前终身有效，配额
      // 持续紧张时其后几百次关键写入全部无感知丢失。
      quotaToastShown = false;
    } catch (err) {
      // B-审计修复：配额溢出此前静默吞错——"重启即回档"无提示。首次弹
      // toast 上报，后续仅记日志防轰炸（与 local-backup.persistMirrored 同策略）。
      console.error("[persistence] save failed:", err);
      if (!quotaToastShown) {
        quotaToastShown = true;
        try {
          pushAppToast(t("本地保存失败"), t("浏览器存储空间不足或受限，最近的更改可能未保留。"), "error");
        } catch {
          // best-effort
        }
      }
    }
  },

  async clear() {
    localStorage.removeItem(STORAGE_KEY);
  }
};
