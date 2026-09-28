/**
 * 持久化暂停闸门（B-审计修复：恢复备份 ack 协议）。
 *
 * 恢复完整备份会整表替换 SQLite + 覆盖共享 localStorage。其他窗口在飞的
 * 防抖保存（widget 300ms / settings 350ms / mirror 500ms）若在此期间落盘，
 * 会用恢复前的旧状态覆盖刚恢复的数据。协议：
 *  1. 发起方广播 sync:persist-pause；
 *  2. 各窗口收到后置位本闸门（此后一切防抖落盘直接丢弃，不写不排队），
 *     并回发 sync:persist-acked；
 *  3. 发起方收齐 ack（或超时兜底）后才执行导入；
 *  4. 导入完成后广播 sync:persist-resume 并 reload。
 */
let suspended = false;

/** 置位闸门：此后本窗口一切防抖落盘直接丢弃（恢复备份的 ack 协议第 2 步）。 */
export function suspendPersistence(): void {
  suspended = true;
}

/** 复位闸门：恢复正常落盘（协议第 4 步，通常伴随 reload）。 */
export function resumePersistence(): void {
  suspended = false;
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
  return suspended;
}

/**
 * 发起方侧的握手（协议第 1–3 步）：置位本窗口闸门 → 广播 pause → 等其他窗口
 * 回 ack（每窗口回自己的 window label，按去重计数），超时兜底后返回。
 *
 * 注意 Tauri 的 emit 会回环到发送方自身：本窗口的 pause 监听也会回一条 ack，
 * 必须按 label 排除掉，否则两窗口场景（settings + widget-0）`expected=1`
 * 被自回声瞬间满足，根本没等对端就开始整表导入。
 *
 * 调用方在整表替换/清库完成后应广播 `app:reload-all` 并 reload——其他窗口
 * 直到 reload 前都保持闸门置位，pagehide 冲刷也被丢弃，不会把旧状态写回。
 * **失败路径必须调用返回的 `release()`** 复位本窗口闸门，否则全应用持久化停摆。
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
  const unAck = await listen<string>("sync:persist-acked", (e) => {
    if (typeof e.payload === "string" && e.payload !== me) acked.add(e.payload);
  });
  try {
    await emit("sync:persist-pause");
    const wins = await ww.WebviewWindow.getAll();
    const expected = wins.filter((w) => w.label !== me).length;
    const deadline = Date.now() + timeoutMs;
    while (acked.size < expected && Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 40));
    }
  } finally {
    unAck();
  }
  return resumePersistence;
}
