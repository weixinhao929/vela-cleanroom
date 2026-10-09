/**
 * localStorage 数据的备份镜像层。
 *
 * 便签、习惯、书签、小组件配置、取色历史等全部存在 localStorage，而
 * Rust 侧自动备份只读 SQLite —— 这些数据曾是备份盲区。本模块在每次
 * 备份前把所有 `focus-desk.*` 键整表镜像进 SQLite（`lsmirror:` 前缀），
 * 恢复时再写回 localStorage，让完整备份真正覆盖全部用户数据。
 */

import { invoke, isTauri } from "./tauri";
import { isPersistSuspended } from "./persist-gate";
import { createQuotaToastOnce, QUOTA_TOAST_TEXT } from "./quota-toast";

/** 不参与备份的瞬态键（导航标记、迁移标记、备份标志本身、崩溃日志）。
    另含浏览器时代的 legacy 快照 `state.v1` / `log.v1`：Tauri 模式下它们只是
    一次性迁移后的回滚残留（只在 localStorage 持久化模式写入）。若随镜像进
    备份，在新机器/新 profile 恢复时会被写回而迁移标记不会——reload 后
    迁移逻辑按"legacy 行数更多则整表替换"把刚恢复的 SQLite 数据反向覆盖。 */
const TRANSIENT_KEYS = new Set([
  "focus-desk.pending-nav",
  "focus-desk.migrated.v1",
  "focus-desk.backup.flag",
  "focus-desk.backup.v1",
  "focus-desk.crash-log.v1",
  "focus-desk.state.v1",
  "focus-desk.log.v1"
]);

export interface MirrorEntry {
  key: string;
  value: string;
}

/**
 * 收集所有需要进备份的 localStorage 条目。
 * 范围：`focus-desk.*` 前缀，排除瞬态键与 `.corrupt-*` 抢救快照
 * （B-审计修复：损坏存证不随镜像/备份携带，避免污染恢复集）。
 *
 * @returns `{key, value}` 数组；localStorage 不可用时返回空数组。
 * @throws 无。O(localStorage 条目数)。
 *
 * @example
 * ```ts
 * const entries = collectLocalStorageEntries();
 * ```
 */
export function collectLocalStorageEntries(): MirrorEntry[] {
  const entries: MirrorEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("focus-desk.") || TRANSIENT_KEYS.has(key)) continue;
      if (key.includes(".corrupt-")) continue;
      const value = localStorage.getItem(key);
      if (value !== null) entries.push({ key, value });
    }
  } catch {
    // best-effort
  }
  return entries;
}

/**
 * 把当前 localStorage 全量同步进 SQLite 镜像表（`mirror_local_storage`，
 * 整表替换）。
 *
 * @returns 完成后 resolve。
 * @throws 仅 Tauri 环境内 IPC 失败时向上抛——调用方（hydrateApp/托盘备份/
 *         手动备份）的 catch 与上报必须生效，否则备份会携带陈旧快照。
 *         浏览器模式静默 no-op。
 */
export async function syncLocalStorageMirror(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("mirror_local_storage", { entries: collectLocalStorageEntries() });
  } catch (err) {
    // 审计修复：不再吞错——mirror 失败后备份会携带陈旧快照，必须让调用方
    // （hydrateApp / 托盘备份 / AnalyticsPanel 手动备份）的 catch 与上报生效。
    console.error("[local-backup] mirror sync failed", err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 防抖合批
 *
 * 镜像同步是「整表替换」：连续触发 N 次的结果与只在最后触发 1 次完全
 * 等价，中间那 次纯属浪费（每次都要遍历 localStorage、序列化、跨
 * IPC 传输、SQLite 事务重写整表）。批量场景（导入书签、连续编辑便签、
 * 托盘快捷操作）会在极短时间内密集触发，因此这里做尾部防抖合批。
 *
 * 语义保证：
 *  - 窗口内多次调用只落一次，且落的一定是最新快照（整表替换语义使然）。
 *  - `flushMirrorSync()` 立即落盘，用于退出前 / 显式备份前的确定性写入。
 *  - 页面卸载时自动 flush，避免最后一次编辑丢失。
 * ------------------------------------------------------------------ */

/** 防抖窗口：足够合并连续操作，又不至于让用户感知到延迟。 */
const MIRROR_DEBOUNCE_MS = 500;

let mirrorTimer: number | null = null;
/** 记录待落盘状态，供 flush 判断是否需要真正写入。 */
let mirrorPending = false;
/** 正在进行中的同步 Promise，避免并发重入导致的写入顺序错乱。 */
let mirrorInFlight: Promise<void> | null = null;

function clearMirrorTimer(): void {
  if (mirrorTimer !== null) {
    window.clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
}

/** 串行化实际写入：若已有同步在飞，则等它结束后再写，保证最后一次生效。 */
function runMirrorSync(): Promise<void> {
  mirrorPending = false;
  // B-恢复 ack 协议：备份整表替换期间跳过镜像同步（会把旧 LS 快照盖回镜像）。
  if (isPersistSuspended()) return Promise.resolve();
  const next = (mirrorInFlight ?? Promise.resolve()).then(
    () => syncLocalStorageMirror(),
    () => syncLocalStorageMirror()
  );
  mirrorInFlight = next.finally(() => {
    if (mirrorInFlight === next) mirrorInFlight = null;
  });
  return mirrorInFlight;
}

/**
 * 请求一次镜像同步（尾部防抖合批，500ms 窗口）。
 * 窗口内多次调用只落一次且必为最新快照（整表替换语义）；持久化闸门
 * 挂起期间直接跳过。高频写入点（便签编辑/书签导入）应优先用它而非
 * `syncLocalStorageMirror()`，把 N 次整表重写压成 1 次。
 *
 * @returns 无（fire-and-forget；失败已记日志）。
 * @throws 无。
 */
export function scheduleMirrorSync(): void {
  if (!isTauri()) return;
  mirrorPending = true;
  clearMirrorTimer();
  mirrorTimer = window.setTimeout(() => {
    mirrorTimer = null;
    // 后台防抖路径没有调用方 catch 可联动；失败已在 syncLocalStorageMirror
    // 里 console.error，这里只补一个 no-op catch 避免 floating promise 的
    // unhandled rejection。需要确定性保证的路径请用 flushMirrorSync()。
    runMirrorSync().catch(() => undefined);
  }, MIRROR_DEBOUNCE_MS);
}

/**
 * 取消待处理的防抖并**立即执行一次**同步，等待完成。
 * 备份/导出前必须用它（需要「此刻快照已落盘」的确定性保证），同时吞掉
 * 待处理定时任务避免重复整表写。
 *
 * @returns 同步完成后 resolve。
 * @throws 同步失败时向上传播（调用方决定上报/降级）。
 *
 * @example
 * ```ts
 * await flushMirrorSync();
 * await sqliteRepo.createBackup();
 * ```
 */
export async function flushMirrorSync(): Promise<void> {
  if (!isTauri()) return;
  clearMirrorTimer();
  await runMirrorSync();
}

/** 配额首报锁存（共享实现，见 lib/quota-toast；本写路径独立一个实例）。 */
const quotaToast = createQuotaToastOnce();

/**
 * 写入一个受备份保护的 localStorage 键，并请求一次防抖镜像同步。
 * 所有「用户数据」类写入都应走这里（而非裸 setItem），避免新增数据点
 * 漏进备份盲区；配额溢出首次弹 toast、后续仅记日志。
 *
 * @param key - 完整的 localStorage 键名（约定 `focus-desk.` 前缀）。
 * @param value - 序列化后的字符串值。
 * @returns 是否写入成功（配额溢出等为 false）。
 * @throws 无。
 *
 * @example
 * ```ts
 * persistMirrored(notesKey(id), JSON.stringify(notes));
 * ```
 */
export function persistMirrored(key: string, value: string): boolean {
  /* 恢复闸门下沉——备份整表替换期间（pause-ack 协议）不得写共享 LS：
     此前只有镜像 IPC 被拦（runMirrorSync），本窗在飞的用户/远端采纳写入
     仍会把恢复前的旧态盖回权威 LS（habits/notes/dnd 通道）。恢复以 reload
     收尾，挂起期跳过的写由恢复后的新内存态接管，无丢失面。返回 true——
     跳过是既定语义而非配额失败，调用方的失败回退不应触发。 */
  if (isPersistSuspended()) return true;
  try {
    localStorage.setItem(key, value);
    // 从溢出中恢复后复位锁存：后续再次溢出要能重新弹 toast（与
    // local-storage.ts / settings-store.ts 的处理一致）。
    quotaToast.markOk();
  } catch (err) {
    // B-审计修复：配额溢出此前全线静默吞错——"重启即回档"无任何提示。
    // 首次失败弹 toast 上报，后续仅记日志防轰炸。
    quotaToast.fail("[local-backup] persist failed:", QUOTA_TOAST_TEXT.title(), QUOTA_TOAST_TEXT.body(), key, err);
    return false;
  }
  scheduleMirrorSync();
  return true;
}

/** 仅测试使用：重置内部防抖状态，避免用例间互相污染。 */
export function __resetMirrorSyncStateForTests(): void {
  clearMirrorTimer();
  mirrorPending = false;
  mirrorInFlight = null;
}

// 页面卸载兜底：防抖窗口内的未落盘改动在退出时补写一次。
// beforeunload 阶段不能 await，这里只做尽力而为的触发。
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (mirrorPending || mirrorTimer !== null) {
      clearMirrorTimer();
      // 卸载阶段无法上报；同上仅防 unhandled rejection。
      runMirrorSync().catch(() => undefined);
    }
  });
}

/**
 * 从 SQLite 镜像恢复 localStorage。
 *
 * @param overwrite - false（默认）只补齐本地缺失的键（不覆盖本地较新数据，
 *                    安全合并语义）；true 整体写回（显式恢复备份场景）。
 * @returns 实际写入的键数量；浏览器模式或读取失败返回 0。
 * @throws 仅 overwrite 模式（恢复备份收尾）下 IPC 失败向上抛（静默
 *         返回 0 会让调用方误以为镜像已落地，reload 后出现「DB 已恢复、
 *         LS 仍是旧态」的半恢复）。非 overwrite 保持吞错返回 0（启动补齐
 *         语义：本地缺失键下次启动仍会补齐，无数据风险）。
 *
 * @example
 * `ts
 * const n = await applyLocalStorageMirror(false); // 启动时补齐缺失键
 * `
 */
export async function applyLocalStorageMirror(overwrite = false): Promise<number> {
  if (!isTauri()) return 0;
  try {
    const entries = await invoke<MirrorEntry[]>("get_local_storage_mirror");
    if (!Array.isArray(entries)) return 0;
    let written = 0;
    const mirrored = new Set<string>();
    for (const e of entries) {
      if (!e || typeof e.key !== "string" || typeof e.value !== "string") continue;
      if (!e.key.startsWith("focus-desk.")) continue; // 防御：只接受已知前缀
      // 先入集合再写：单键写入失败（配额/损坏值）的键不会被下面的清理
      // 步骤误删——它属于备份内容，只是没写成功。
      mirrored.add(e.key);
      if (!overwrite && localStorage.getItem(e.key) !== null) continue;
      try {
        localStorage.setItem(e.key, e.value);
        written++;
      } catch {
        // 单键失败（配额/损坏值）不阻断其余恢复
      }
    }
    if (overwrite) {
      // 整包替换语义收尾——备份里不存在的 focus-desk.* 键是「备份前
      // 已删除」的数据（删掉的便签/书签），只写不清会原地复活，违背确认框
      // 的「整包替换」承诺。严格限定镜像命名空间：TRANSIENT_KEYS（导航/迁移
      // /备份标志/崩溃日志/legacy 快照——本机瞬态，从不进备份，删了反而破坏
      // 回滚语义）与 `.corrupt-` 损坏存证保留；非 focus-desk.* 前缀的键（其
      // 他应用共享的 localStorage）绝不动。倒序遍历：边删边遍历索引不漂移。
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("focus-desk.")) continue;
        if (mirrored.has(key) || TRANSIENT_KEYS.has(key) || key.includes(".corrupt-")) continue;
        try {
          localStorage.removeItem(key);
        } catch {
          // best-effort：单键清理失败不阻断其余
        }
      }
    }
    return written;
  } catch (err) {
    console.error("[local-backup] mirror apply failed", err);
    if (overwrite) throw err;
    return 0;
  }
}
