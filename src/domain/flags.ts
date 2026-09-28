/**
 * Feature flags allow disabling advanced modules that are not yet complete.
 * Flags live in the browser env for dev mode; the native build can substitute
 * a Tauri-backed config in a later phase.
 *
 * 目前只剩 `autoBackup` 一个开关在用（domain/backup.ts）。曾预留的
 * sqlitePersistence / importExport / advancedPomodoro 从未被读取，已移除；
 * 需要新开关时按同样模式加字段 + VITE_FLAG_* 环境变量即可。
 */
export interface FeatureFlags {
  autoBackup: boolean;
}

const DEFAULTS: FeatureFlags = {
  autoBackup: true
};

/**
 * 读取功能开关（特性开关模式）：VITE_FLAG_* 环境变量优先，缺省用内置
 * 默认值。用于灰度/禁用尚未完成的高级模块；模块加载期一次性求值
 * （见 {@link flags}）。
 *
 * @returns 开关快照。O(1)。
 *
 * @example
 * ```ts
 * if (flags.autoBackup) enableAutoBackup();
 * ```
 */
export function getFeatureFlags(): FeatureFlags {
  const env = import.meta.env ?? {};
  return {
    autoBackup: readEnvBool(env, "VITE_FLAG_AUTO_BACKUP", DEFAULTS.autoBackup)
  };
}

function readEnvBool(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

/** 模块级单例：加载期求值一次的功能开关快照。 */
export const flags = getFeatureFlags();
