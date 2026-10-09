/**
 * 持久化暂停闸门（B-审计修复：恢复备份 ack 协议）。
 *
 * 恢复完整备份会整表替换 SQLite + 覆盖共享 localStorage。其他窗口在飞的
 * 防抖保存（widget 300ms / settings 350ms / mirror 500ms）若在此期间落盘，
 * 会用恢复前的旧状态覆盖刚恢复的数据。协议：
 *  1. 发起方广播 sync:persist-pause（载荷 = 发起方 window label）；
 *  2. 各窗口收到后置位本闸门（此后一切防抖落盘直接丢弃，不写不排队），
 *     并回发 sync:persist-acked；
 *  3. 发起方收齐 ack（或超时兜底）后才执行导入；
 *  4. 导入完成后广播 sync:persist-resume 并 reload。
 *
 * 闸门按「暂停所有者」集合计数——两个窗口并发发起恢复时（可达性
 * 极低但存在），先完成的一方广播 resume 不再解除另一方的暂停；同一发起方
 * 重复 pause 由集合去重，不会 inflate 计数。
 */
const pauseOwners = new Set<string>();

/** 本窗口自发暂停的固定所有者标签（与远端广播来源区分）。 */
const SELF_OWNER = "self";

/**
 * 置位闸门：此后本窗口一切防抖落盘直接丢弃（恢复备份的 ack 协议第 2 步）。
 *
 * @param owner 暂停所有者标签：远端广播携带发起方 label（`remote:<label>`），
 *              本窗口自发暂停缺省 "self"。
 */
export function suspendPersistence(owner: string = SELF_OWNER): void {
  pauseOwners.add(owner);
}

/**
 * 复位闸门（协议第 4 步，通常伴随 reload）。只解除对应所有者的暂停；
 * 仍有其他所有者持有时闸门保持置位。
 */
export function resumePersistence(owner: string = SELF_OWNER): void {
  pauseOwners.delete(owner);
}

/**
 * 查询闸门状态。
 *
 * @returns true 表示持久化已被暂停（写入方应跳过 setItem/invoke）。
 * @example
 * ```ts
 * if (!isPersistSuspended()) persistMirrored(key, json);
 * ```
 */
export function isPersistSuspended(): boolean {
  return pauseOwners.size > 0;
}

/** 测试隔离：清空全部暂停所有者。 */
export function resetPersistGateForTests(): void {
  pauseOwners.clear();
}

/**
 * 发起方侧的握手（协议第 1–3 步）：置位本窗口闸门 → 广播 pause（载荷带
 * 本窗口 label）→ 等其他窗口回 ack（每窗口回自己的 window label，按去重
 * 计数），超时兜底后返回。
 *
 * 注意 Tauri 的 emit 会回环到发送方自身：本窗口的 pause 监听也会回一条 ack，
 * 必须按 label 排除掉，否则两窗口场景（settings + widget-0）`expected=1`
 * 被自回声瞬间满足，根本没等对端就开始整表导入。监听侧把自己发的
 * `remote:<自身label>` 归并进 `self` 所有者（同一所有者，集合天然去重）。
 *
 * 调用方在整表替换/清库完成后应广播 `app:reload-all` 并 reload——其他窗口
 * 直到 reload 前都保持闸门置位，pagehide 冲刷也被丢弃，不会把旧状态写回。
 * **退出契约**：任何路径要么返回 `release()`、要么闸门已自行复位——
 * 握手内部（listen/emit/getAll）抛错时本函数先 `resumePersistence()` 再上抛
 * （此时调用方拿不到 release，若不复位，本窗口的持久化会静默停摆到
 * reload）；成功返回后的业务侧失败则由调用方负责调 `release()`。
 *
 * @param timeoutMs - 等 ack 的上限，默认 1200ms。
 * @returns release：复位本窗口闸门（等价 resumePersistence）。
 */
export async function pauseOtherWindowsPersistence(timeoutMs = 1200): Promise<() => void> {
  const { emit, listen } = await import("@tauri-apps/api/event");
  const ww = await import("@tauri-apps/api/webviewWindow");
  suspendPersistence();
  const me = ww.getCurrentWebviewWindow().label;
  const acked = new Set<string>();
  // listen 的注册也纳入 try——它抛错同样发生在闸门置位之后。
  let unAck: (() => void) | null = null;
  try {
    unAck = await listen<string>("sync:persist-acked", (e) => {
      if (typeof e.payload === "string" && e.payload !== me) acked.add(e.payload);
    });
    // pause 载荷带发起方 label——接收侧按来源计数，并发握手互不干扰。
    await emit("sync:persist-pause", me);
    const wins = await ww.WebviewWindow.getAll();
    const expected = wins.filter((w) => w.label !== me).length;
    const deadline = Date.now() + timeoutMs;
    while (acked.size < expected && Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 40));
    }
  } catch (err) {
    unAck?.();
    // 失败路径先复位本窗闸门再上抛——调用方拿不到 release，不复位
    // 则本窗口持久化静默停摆到 reload（此前 finally 只解绑监听不复位）。
    resumePersistence();
    throw err;
  }
  unAck();
  return () => resumePersistence();
}
