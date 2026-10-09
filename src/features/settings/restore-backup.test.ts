import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * restoreBackupFromPath 的阶段化语义回归（修复：恢复非原子）：
 *  - 校验失败（导入未下发）→ 闸门释放、不调用导入；
 *  - 全流程成功 → 正常 reload 语义（闸门保持到 reload，不 release）；
 *  - 导入成功但镜像写回抛错 → 闸门【未被 release】（旧实现笼统 release 后，
 *    恢复前内存态的下一次保存会反噬已恢复的库）、迁移标记已置位、广播
 *    reload-all 放行其他窗口、错误消息为「已导入但镜像失败」档、5s 后延迟
 *    自动 reload（文案约 28 汉字，2s 读不完）；
 *  - 导入成功但 reload-all 广播失败 → 补发 sync:persist-resume 兜底（只放
 *    其他窗口）、文案细分到「广播失败」档。
 *
 * 全部外部依赖 mock：sqliteRepo（lib/persistence）、applyLocalStorageMirror
 * （lib/local-backup）、pauseOtherWindowsPersistence（lib/persist-gate）、
 * 校验器（domain/backup-validate）、确认框与 Tauri 事件层。
 */

const h = vi.hoisted(() => {
  return {
    // 各 mock 按被替换真身的调用签名定型（避免 vi.fn() 0 参签名在 tsc 下报
    // ）。
    invokeMock: vi.fn(async (_cmd: string, _args?: unknown) => "{}"),
    restoreMock: vi.fn(async (_payload: unknown) => undefined),
    mirrorMock: vi.fn(async (_overwrite: boolean) => 3),
    emitMock: vi.fn(async (_event: string, _payload?: unknown) => undefined),
    confirmMock: vi.fn(async (_opts: unknown) => true),
    validateMock: vi.fn((_raw: unknown): { ok: boolean; payload?: unknown; warnings?: string[]; reason?: string } => ({
      ok: true
    })),
    releaseSpy: vi.fn(),
    pauseMock: vi.fn((_timeoutMs?: number) => undefined),
    suspended: false
  };
});

vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  invoke: (cmd: string, args?: unknown) => h.invokeMock(cmd, args),
  currentWindowLabel: () => "settings"
}));

vi.mock("../../lib/persistence", () => ({
  sqliteRepo: { restoreFullBackup: (payload: unknown) => h.restoreMock(payload) }
}));

vi.mock("../../lib/local-backup", () => ({
  applyLocalStorageMirror: (overwrite?: boolean) => h.mirrorMock(overwrite ?? false)
}));

vi.mock("../../lib/persist-gate", () => ({
  suspendPersistence: () => {
    h.suspended = true;
  },
  resumePersistence: () => {
    h.suspended = false;
  },
  isPersistSuspended: () => h.suspended,
  // 发起方握手替身：置位闸门并返回 release（记到 releaseSpy 便于断言）。
  pauseOtherWindowsPersistence: (timeoutMs?: number) => {
    h.pauseMock(timeoutMs);
    h.suspended = true;
    return Promise.resolve(() => {
      h.suspended = false;
      h.releaseSpy();
    });
  }
}));

vi.mock("../../components/PromptDialog", () => ({
  confirmDialog: (opts: unknown) => h.confirmMock(opts)
}));

vi.mock("../../domain/backup-validate", () => ({
  // 注意：真身是同步函数（返回 ValidateResult 而非 Promise），mock 也必须
  // 同步（mockReturnValue），否则调用方的 `check.ok` 读到 undefined。
  parseAndValidateBackup: (raw: string) => h.validateMock(raw),
  describeBackup: () => "3 条任务 / 1 条专注记录"
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => h.emitMock(event, payload)
}));

import { restoreBackupFromPath, type RestoreUi } from "./restore-backup";

const PAYLOAD = { version: 2, tasks: [], deadlines: [], pomodoroSessions: [] };

describe("restoreBackupFromPath 阶段化（P1-2/P1-7）", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let flashSpy: ReturnType<typeof vi.fn>;
  let setRestoringSpy: ReturnType<typeof vi.fn>;
  let ui: RestoreUi;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    for (const m of [
      h.invokeMock,
      h.restoreMock,
      h.mirrorMock,
      h.emitMock,
      h.confirmMock,
      h.validateMock,
      h.releaseSpy,
      h.pauseMock
    ])
      m.mockReset();
    h.suspended = false;
    h.invokeMock.mockResolvedValue("{}");
    h.confirmMock.mockResolvedValue(true);
    h.validateMock.mockReturnValue({ ok: true, payload: PAYLOAD, warnings: [] });
    h.restoreMock.mockResolvedValue(undefined);
    h.mirrorMock.mockResolvedValue(3);
    // jsdom 25 的 location.reload 是不可配置只读属性，spyOn/赋值均不可行；
    // stubGlobal 整体替换 location（restore-backup 只调用 reload）。
    reloadSpy = vi.fn();
    vi.stubGlobal("location", { reload: reloadSpy });
    flashSpy = vi.fn();
    setRestoringSpy = vi.fn();
    ui = {
      flash: flashSpy as (msg: string, ok?: boolean) => void,
      setRestoring: setRestoringSpy as (v: boolean) => void
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("① 校验失败 → 闸门未进入握手、未调用导入、闪示失败原因", async () => {
    h.validateMock.mockReturnValue({ ok: false, reason: "备份文件的版本号无效" });

    await restoreBackupFromPath("/backup/vela-2026.json", ui);

    expect(h.restoreMock).not.toHaveBeenCalled();
    expect(h.pauseMock).not.toHaveBeenCalled(); // 校验在握手之前短路
    expect(h.releaseSpy).not.toHaveBeenCalled();
    expect(h.emitMock).not.toHaveBeenCalledWith("app:reload-all", undefined);
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(flashSpy).toHaveBeenCalledWith(expect.stringContaining("备份文件的版本号无效"), false);
  });

  it("② 全流程成功 → 导入 + 镜像写回 + reload-all + reload，闸门保持不 release", async () => {
    const p = restoreBackupFromPath("/backup/vela-2026.json", ui);
    await vi.advanceTimersByTimeAsync(120); // 遮罩至少一帧的等待
    await p;

    expect(h.restoreMock).toHaveBeenCalledTimes(1);
    expect(h.restoreMock).toHaveBeenCalledWith(PAYLOAD);
    expect(h.mirrorMock).toHaveBeenCalledWith(true);
    // mock 包装层显式透传可选 payload（undefined），与单参调用等价。
    expect(h.emitMock).toHaveBeenCalledWith("app:reload-all", undefined);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // 成功路径不 release（pagehide 冲刷会把旧内存态盖回刚恢复的数据）。
    expect(h.releaseSpy).not.toHaveBeenCalled();
    expect(flashSpy).not.toHaveBeenCalled();
  });

  it("③ 导入成功但镜像写回抛错 → 不 release、广播 reload-all 放行其他窗口、置迁移标记、5s 后自动 reload、文案为镜像失败档", async () => {
    h.mirrorMock.mockRejectedValue(new Error("get_local_storage_mirror failed"));

    await restoreBackupFromPath("/backup/vela-2026.json", ui);

    // 导入确已下发（DB 已是恢复后的权威副本）。
    expect(h.restoreMock).toHaveBeenCalledTimes(1);
    expect(h.mirrorMock).toHaveBeenCalledWith(true);
    // 核心断言：不得 release 闸门——否则旧内存态的后续保存反噬已恢复的库。
    expect(h.releaseSpy).not.toHaveBeenCalled();
    expect(h.suspended).toBe(true);
    // 迁移标记在镜像写回之前置位（与镜像成败无关），防 reload 后
    // 一次性迁移用 legacy 快照反噬刚恢复的库。
    expect(localStorage.getItem("focus-desk.migrated.v1")).toBe("1");
    // DB 已是权威副本，广播 reload-all 让其他窗口 reload 对齐并解除
    // 各自闸门（旧断言「失败路径不得调用 reload-all」把缺陷锁成了期望）。
    expect(h.emitMock).toHaveBeenCalledWith("app:reload-all", undefined);
    expect(h.emitMock).not.toHaveBeenCalledWith("sync:persist-resume", expect.anything());
    // 错误语义可区分（不是笼统的「文件格式不正确」）。
    expect(flashSpy).toHaveBeenCalledWith(expect.stringContaining("已导入"), false);
    expect(flashSpy).toHaveBeenCalledWith(expect.stringContaining("镜像"), false);
    // 延迟自动 reload 已排程：5s 后触发对齐（文案约 28 汉字，2s 读不完）。
    expect(reloadSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4999);
    expect(reloadSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("④ 导入成功但 reload-all 广播失败 → 补发 sync:persist-resume 兜底、不 release、文案为广播失败档、5s 后自动 reload", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // emit 对 app:reload-all 抛错；对其他事件（sync:persist-resume）放行。
    h.emitMock.mockImplementation(async (event: string, _payload?: unknown) => {
      if (event === "app:reload-all") throw new Error("emit down");
      return undefined;
    });

    try {
      await restoreBackupFromPath("/backup/vela-2026.json", ui);

      expect(h.restoreMock).toHaveBeenCalledTimes(1);
      expect(h.mirrorMock).toHaveBeenCalledWith(true);
      // 广播失败后补发尽力而为的 sync:persist-resume：只解除其他窗口的
      // 持久化停摆（本窗闸门保持到 reload）。
      expect(h.emitMock).toHaveBeenCalledWith("sync:persist-resume", expect.any(String));
      expect(h.releaseSpy).not.toHaveBeenCalled();
      expect(h.suspended).toBe(true);
      // 文案按实际失败步骤细分：广播失败档（含「通知其他窗口」而非「镜像」）。
      expect(flashSpy).toHaveBeenCalledWith(expect.stringContaining("已导入"), false);
      expect(flashSpy).toHaveBeenCalledWith(expect.stringContaining("通知其他窗口"), false);
      expect(flashSpy).not.toHaveBeenCalledWith(expect.stringContaining("镜像"), false);
      expect(reloadSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
