import { showToast } from "../components/ToastHost";
import { t } from "../i18n-lite";

/**
 * 持久化失败统一上报，替代散落在各 store 的 `.catch(console.error)`。
 *
 * 用法：`repo.someWrite(args).then(applyToMemory).catch(reportPersistError("someWrite"))`
 *
 * 原则：写库路径一律 persist-first —— 先等 IPC 落库成功再更新内存状态；
 * 失败时内存不变、用户看到 Toast，不再出现"UI 显示成功、重启后数据丢失"
 * 的静默发散。计时类（番茄钟 tick/会话记录）不阻塞主流程，仅上报。
 */

/** 同一上下文 5s 内只弹一次 toast。写链单 op 卡满超时期间
    排队的每个写都会依次失败，无节流时形成"保存失败"toast 风暴（每秒数条）。 */
const TOAST_SUPPRESS_MS = 5000;
const lastToastAt = new Map<string, number>();

/**
 * 生成持久化失败的上报回调（节流装饰器模式）。
 *
 * 用法：`repo.someWrite(args).then(applyToMemory).catch(reportPersistError("someWrite"))`
 * 失败时打 console.error 并弹「保存失败」toast；同一 context 5s 内至多弹一次，
 * 防止写链卡死期间的排队写形成 toast 风暴。
 *
 * @param context - 调用方标识（如 `"saveViews"`），用于节流去重与日志定位。
 * @returns 可直接挂到 Promise.catch 的错误处理函数。
 * @throws 无（本函数自身不抛错）。
 *
 * @example
 * ```ts
 * sqliteRepo.setSetting(key, value).catch(reportPersistError("saveViews"));
 * ```
 */
export function reportPersistError(context: string): (err: unknown) => void {
  return (err: unknown) => {
    console.error(`[persistence] ${context} failed:`, err);
    const now = Date.now();
    const last = lastToastAt.get(context) ?? 0;
    if (now - last < TOAST_SUPPRESS_MS) return;
    lastToastAt.set(context, now);
    // -DDL：把上下文与原始错误带进 toast——「删不掉/存不上」时用户能直接
    // 读到真实原因（如 unknown command / SQLITE_BUSY），不再只有笼统提示。
    const detail =
      typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    showToast(`${t("保存失败，请重试")} [${context}] ${detail.slice(0, 120)}`, "error");
  };
}
