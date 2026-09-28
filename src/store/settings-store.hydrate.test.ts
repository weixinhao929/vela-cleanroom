import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * hydrateSettingsFromDb 的权威方向回归（P1 修复）：
 *  - localStorage 为空（WebView2 profile 被清理/只迁移 SQLite）→ DB 镜像是
 *    唯一幸存副本，必须整包采纳；否则全默认值的 current 会把真实设置盖掉，
 *    下一次 saveSettings 再把默认值写回两处，设置永久丢失。
 *  - localStorage 有内容 → 仍是 P8 语义：localStorage 胜出，陈旧 DB 不反向
 *    覆盖，并把合并结果回写 DB 自愈分叉。
 *
 * 沿用 widget-store.hydrate.test.ts 的模式：只 mock ../lib/tauri
 * （isTauri→true + invoke 按命令名分发），真实 sqliteRepo 参与运行。
 */

const mockInvoke = vi.fn(async (cmd: string, args?: { key?: string; value?: string }): Promise<unknown> => {
  if (cmd === "get_setting") return dbRows.get(args?.key ?? "") ?? null;
  if (cmd === "set_setting") {
    setCalls.push([args?.key ?? "", args?.value ?? ""]);
    return undefined;
  }
  return null;
});

/** 模拟的 SQLite settings 表；setCalls 记录全部回写。 */
const dbRows = new Map<string, string>();
let setCalls: [string, string][] = [];

vi.mock("../lib/tauri", () => ({
  isTauri: () => true,
  invoke: (...a: unknown[]) => (mockInvoke as unknown as (...x: unknown[]) => unknown)(...(a as [string]))
}));

async function loadModule() {
  vi.resetModules();
  return await import("./settings-store");
}

/** 让 enqueueWrite 的微任务写链与 fire-and-forget 自愈写跑完。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const LS_KEY = "focus-desk.settings.v1";
const DB_KEY = "app:settings:v1";

beforeEach(() => {
  localStorage.clear();
  dbRows.clear();
  setCalls = [];
});

describe("hydrateSettingsFromDb 权威方向", () => {
  it("localStorage 为空 → DB 镜像整包采纳（默认值不得覆盖）", async () => {
    dbRows.set(
      DB_KEY,
      JSON.stringify({
        preset: "terminal",
        themeMode: "dark",
        primaryColor: "#123456",
        zoom: 125,
        cornerRadius: 8,
        spacing: 24,
        general: { language: "English", launchOnStartup: true },
        extra: { updateEndpoint: "https://updates.example.com" }
      })
    );

    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    // 模块加载时 localStorage 为空 → store 是全默认值。
    await hydrateSettingsFromDb();

    const s = useSettingsStore.getState();
    expect(s.preset).toBe("retro"); // 旧 terminal 预设迁移为 retro
    expect(s.themeMode).toBe("dark");
    expect(s.primaryColor).toBe("#123456");
    expect(s.zoom).toBe(125);
    expect(s.cornerRadius).toBe(8);
    expect(s.spacing).toBe(24);
    expect(s.general.language).toBe("English");
    expect(s.general.launchOnStartup).toBe(true);
    expect(s.extra.updateEndpoint).toBe("https://updates.example.com");
    await flush();
    // 该方向不回写 DB（DB 本身就是来源）。
    expect(setCalls).toEqual([]);
  });

  it("localStorage 有内容 → P8 语义保持：current 胜出并回写自愈", async () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ preset: "terminal", zoom: 125, cornerRadius: 8 }) // 旧 id，断言迁移为 retro
    );
    dbRows.set(DB_KEY, JSON.stringify({ preset: "midnight", zoom: 999 })); // 旧 id，LS 胜出后迁移为 default

    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    await hydrateSettingsFromDb();

    const s = useSettingsStore.getState();
    expect(s.preset).toBe("retro"); // 旧 terminal 预设迁移为 retro
    expect(s.zoom).toBe(125);
    await flush();
    // 合并结果回写 DB 自愈镜像分叉。
    expect(setCalls.some(([k, v]) => k === DB_KEY && JSON.parse(v).preset === "retro")).toBe(true);
  });

  it("无 DB 快照时 no-op", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ zoom: 111 }));
    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    await hydrateSettingsFromDb();
    expect(useSettingsStore.getState().zoom).toBe(111);
    expect(setCalls).toEqual([]);
  });
});
