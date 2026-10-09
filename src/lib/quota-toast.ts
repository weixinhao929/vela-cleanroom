/**
 * localStorage 配额溢出的「首报锁存」共享实现。
 *
 * 约束：配额溢出此前在三处写路径（local-backup.persistMirrored /
 * persistence/local-storage.save / settings-store 落盘）各自静默吞错——
 * 「重启即回档」零提示；补 toast 后又必须防轰炸：溢出期间每次写失败都弹
 * 会刷屏。统一语义为「同一锁存周期内只弹一次 + 任一次写成功即复位」：
 * 恢复（用户清理 / 换浏览器）后的下一次溢出要能重新提示，锁存不能终身
 * 有效。各调用方持有**独立实例**——三条写路径的锁存周期互不共享，一处
 * 溢出不吞掉另一处的首报。
 *
 * toast 经 pushAppToast best-effort（toast 宿主可能尚未挂载）。
 */
import { pushAppToast } from "../components/ToastHost";
import { t } from "../i18n-lite";

export interface QuotaToastOnce {
  /** 写入成功后调用：复位锁存，恢复后的下一次溢出重新弹 toast。 */
  markOk(): void;
  /** 写入失败时调用：始终记 console.error（前缀 + 调用方给的细节，如键名
   *  与原始异常）；同一锁存周期内首次失败额外弹一次 toast。 */
  fail(logPrefix: string, title: string, body: string, ...logDetails: unknown[]): void;
}

export function createQuotaToastOnce(): QuotaToastOnce {
  let shown = false;
  return {
    markOk() {
      shown = false;
    },
    fail(logPrefix: string, title: string, body: string, ...logDetails: unknown[]) {
      console.error(logPrefix, ...logDetails);
      if (shown) return;
      shown = true;
      try {
        pushAppToast(title, body, "error");
      } catch {
        // best-effort：toast 宿主未挂载时只剩 console 记录
      }
    }
  };
}

/** 通用文案出口：三条写路径的「本地保存失败」toast 共用同一组词条
 *  （settings-store 的「设置保存失败」走自己的词条，仍用同一锁存实现）。 */
export const QUOTA_TOAST_TEXT = {
  title: () => t("本地保存失败"),
  body: () => t("浏览器存储空间不足或受限，最近的更改可能未保留。")
} as const;
