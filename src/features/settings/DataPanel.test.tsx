/**
 * 数据面板（DataPanel）行为测试（走真实 restore-backup 流程，深 mock 其外部依赖，
 * 与 restore-backup.test.ts 同一套替身）：
 *  - 备份列表：Rust list_backups 返回项渲染为逐条「恢复」行 + 「最近：{name}」状态；
 *  - 重入锁：第一条「恢复」进入确认窗口期后，行按钮禁用且密集连点（绕过
 *    disabled 的 fireEvent）不会叠出第二个确认流程（confirmDialog 只被调一次）；
 *  - 恢复失败：导入已落地但镜像写回抛错 → PostImportError 语义文案
 *    「备份已导入数据库，但本地数据镜像写回失败…」经面板 flash 展示，
 *    恢复遮罩随 setRestoring(false) 消失，闸门未被 release。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => "{}"),
  listBackupsMock: vi.fn(async () => [] as { name: string; path: string; created_at: string }[]),
  createBackupMock: vi.fn(async () => ({ name: "b", path: "p", created_at: "t" })),
  restoreMock: vi.fn(async (_payload: unknown) => undefined),
  setSettingMock: vi.fn(async (_key: string, _value: string) => undefined),
  mirrorMock: vi.fn(async (_overwrite?: boolean) => 3),
  emitMock: vi.fn(async (_event: string, _payload?: unknown) => undefined),
  confirmMock: vi.fn(async (_opts: unknown) => true),
  validateMock: vi.fn((_raw: unknown): { ok: boolean; payload?: unknown; warnings?: string[]; reason?: string } => ({
    ok: true
  })),
  releaseSpy: vi.fn()
}));

vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...mod,
    isTauri: () => true,
    invoke: (cmd: string, args?: unknown) => h.invokeMock(cmd, args)
  };
});

/* sqliteRepo 双入口（lib/persistence 与 DataPanel 直引的 lib/persistence/sqlite
   是同一文件）：备份三命令替换为 mock，setSetting 兜住 store 的 SQLite 镜像，
   其余导出经 importOriginal 保留（依赖链顶层还会用到其它成员）。 */
vi.mock("../../lib/persistence/sqlite", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/persistence/sqlite")>();
  return {
    ...mod,
    sqliteRepo: {
      listBackups: () => h.listBackupsMock(),
      createBackup: () => h.createBackupMock(),
      restoreFullBackup: (payload: unknown) => h.restoreMock(payload),
      setSetting: (key: string, value: string) => h.setSettingMock(key, value)
    }
  };
});

vi.mock("../../lib/persistence", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/persistence")>();
  return {
    ...mod,
    sqliteRepo: {
      listBackups: () => h.listBackupsMock(),
      createBackup: () => h.createBackupMock(),
      restoreFullBackup: (payload: unknown) => h.restoreMock(payload),
      setSetting: (key: string, value: string) => h.setSettingMock(key, value)
    }
  };
});

vi.mock("../../lib/local-backup", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/local-backup")>();
  return { ...mod, applyLocalStorageMirror: (overwrite?: boolean) => h.mirrorMock(overwrite ?? false) };
});

vi.mock("../../lib/persist-gate", () => ({
  pauseOtherWindowsPersistence: () => {
    return Promise.resolve(() => {
      h.releaseSpy();
    });
  }
}));

vi.mock("../../components/PromptDialog", () => ({
  confirmDialog: (opts: unknown) => h.confirmMock(opts)
}));

vi.mock("../../domain/backup-validate", () => ({
  parseAndValidateBackup: (raw: string) => h.validateMock(raw),
  describeBackup: () => "3 条任务 / 1 条专注记录"
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => h.emitMock(event, payload)
}));

import { DataPanel } from "./DataPanel";

const BACKUPS = [
  { name: "vela-2026-10-05.json", path: "C:/app/backups/vela-2026-10-05.json", created_at: "2026-10-05T00:00:00Z" },
  { name: "vela-2026-10-04.json", path: "C:/app/backups/vela-2026-10-04.json", created_at: "2026-10-04T00:00:00Z" }
];

beforeEach(() => {
  localStorage.clear();
  for (const key of [
    "invokeMock",
    "listBackupsMock",
    "restoreMock",
    "mirrorMock",
    "emitMock",
    "confirmMock",
    "releaseSpy"
  ] as const) {
    h[key].mockClear();
  }
  h.invokeMock.mockImplementation(async () => "{}");
  h.validateMock.mockImplementation(() => ({
    ok: true,
    payload: { version: 2, tasks: [], deadlines: [], pomodoroSessions: [] },
    warnings: []
  }));
  h.restoreMock.mockImplementation(async () => undefined);
  h.mirrorMock.mockImplementation(async () => 3);
  h.confirmMock.mockImplementation(async () => true);
});

describe("DataPanel · 自动备份列表", () => {
  it("list_backups 返回项渲染为逐条「恢复」行，状态行显示「最近：{name}」", async () => {
    h.listBackupsMock.mockImplementation(async () => BACKUPS);
    render(<DataPanel />);
    expect(await screen.findByText("vela-2026-10-05.json")).toBeInTheDocument();
    expect(screen.getByText("vela-2026-10-04.json")).toBeInTheDocument();
    expect(screen.getByText(/最近：vela-2026-10-05\.json/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "恢复" })).toHaveLength(2);
    // 每行路径以 title 提示。
    expect(screen.getByTitle("C:/app/backups/vela-2026-10-05.json")).toBeInTheDocument();
  });

  it("无备份时不渲染列表区块，状态行显示「暂无备份」", async () => {
    h.listBackupsMock.mockImplementation(async () => []);
    render(<DataPanel />);
    await waitFor(() => expect(screen.getByText(/暂无备份/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
  });
});

describe("DataPanel · 恢复重入锁（F4）", () => {
  it("确认框未决期间：行按钮禁用，连点第二条不叠出第二个确认流程", async () => {
    h.listBackupsMock.mockImplementation(async () => BACKUPS);
    let resolveConfirm!: (v: boolean) => void;
    h.confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((res) => {
          resolveConfirm = res;
        })
    );
    render(<DataPanel />);
    const rows = await screen.findAllByRole("button", { name: "恢复" });
    fireEvent.click(rows[0]);
    // 进入恢复流程：read_text_file 已发、确认框挂起。
    await waitFor(() => expect(h.confirmMock).toHaveBeenCalledTimes(1));
    expect(h.invokeMock.mock.calls.some(([cmd]) => cmd === "read_text_file")).toBe(true);

    // 防呆层：restoreBusy 置位后行按钮禁用。
    await waitFor(() => expect(rows[1]).toBeDisabled());
    // ref 层（密集连点绕过 disabled）：第二条点击直接被重入锁吞掉。
    fireEvent.click(rows[1]);
    fireEvent.click(rows[0]);
    expect(h.confirmMock).toHaveBeenCalledTimes(1);
    expect(h.invokeMock.mock.calls.filter(([cmd]) => cmd === "read_text_file")).toHaveLength(1);
    expect(h.restoreMock).not.toHaveBeenCalled();

    // 用户取消确认：流程结束、锁释放、按钮恢复可用，导入从未下发。
    resolveConfirm(false);
    await waitFor(() => expect(rows[1]).toBeEnabled());
    expect(h.restoreMock).not.toHaveBeenCalled();
    expect(h.emitMock).not.toHaveBeenCalled();
  });
});

describe("DataPanel · 恢复失败（P1-7 PostImportError 路径）", () => {
  it("导入成功但镜像写回抛错：flash 显示「已导入数据库，但本地数据镜像写回失败」文案，遮罩消退，闸门未 release", async () => {
    h.listBackupsMock.mockImplementation(async () => [BACKUPS[0]]);
    h.mirrorMock.mockImplementation(async () => {
      throw new Error("localStorage quota");
    });
    render(<DataPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    // 导入已落地、镜像写回失败 → PostImportError 语义文案经面板状态行展示
    // （mock 链全在微任务里完成，恢复中遮罩只在两帧之间闪现，落点断言终态）。
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent("备份已导入数据库，但本地数据镜像写回失败，即将自动刷新以同步")
    );
    // 恢复遮罩随 setRestoring(false) 消退。
    await waitFor(() => expect(screen.queryByText("正在恢复数据…")).toBeNull());
    // 整库导入确实下发过一次；闸门未被 release（导入后失败不得解除）。
    expect(h.restoreMock).toHaveBeenCalledTimes(1);
    expect(h.releaseSpy).not.toHaveBeenCalled();
    // 其他窗口 reload 广播已发出（兜底对齐）。
    expect(h.emitMock.mock.calls.some(([e]) => e === "app:reload-all")).toBe(true);
  });
});
