import { t } from "../i18n-lite";

/**
 * 应用错误体系（错误分层模式）：kind 用于 UI 分类展示/上报聚合，
 * code 为稳定机器码（不随文案/i18n 变化）。两个子类对应校验 / 系统两大故障域，
 * 未知异常统一经 {@link asAppError} 归一为 SystemError。
 * （曾预留的 StorageError / PermissionError / SyncError 从未被实例化，已移除；
 * 需要时按同样模式新增子类并扩展 ErrorKind。）
 */
export type ErrorKind = "validation" | "system" | "unknown";

/** 应用错误基类：携带分类 kind、稳定 code 与原始 cause。 */
export class AppError extends Error {
  /** 错误类别（validation/storage/permission/system/sync/unknown）。 */
  readonly kind: ErrorKind;
  /** 稳定机器码，用于埋点与条件分支。 */
  readonly code: string;
  /** 原始底层错误（保留完整堆栈）。 */
  readonly cause?: unknown;

  constructor(kind: ErrorKind, code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.code = code;
    this.cause = cause;
  }
}

/** 参数校验失败（如导入文件字段缺失/格式非法）。 */
export class ValidationError extends AppError {
  constructor(code: string, message: string, cause?: unknown) {
    super("validation", code, message, cause);
    this.name = "ValidationError";
  }
}

/** 系统/平台层故障（IPC 失败、文件系统错误等）。 */
export class SystemError extends AppError {
  constructor(code: string, message: string, cause?: unknown) {
    super("system", code, message, cause);
    this.name = "SystemError";
  }
}

/**
 * 把任意抛出值归一为 AppError（空对象模式 + 适配）。
 *
 * @param err - catch 到的任意值。
 * @returns 已是 AppError 则原样返回；普通 Error 包装为 SystemError
 *          （code=原 message）；其余包装为通用未知错误。
 *
 * @example
 * ```ts
 * catch (e) { showToast(asAppError(e).message); }
 * ```
 */
export function asAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new SystemError("unknown", err.message, err);
  return new SystemError("unknown", t("发生未知错误"), err);
}
