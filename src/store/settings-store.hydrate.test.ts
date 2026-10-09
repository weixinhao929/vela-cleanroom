import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * hydrateSettingsFromDb 的三态权威方向回归（修复 + 对账）：
 *  - localStorage 为空或损坏（已隔离）→ DB 镜像是唯一幸存副本，必须整包采纳，
 *    否则全默认值的 current 会把真实设置盖掉；采纳后把快照写回 LS 修复它。
 *    坏 LS 此前会击穿兜底：坏键被 lsPresent 判定算「在场」，DB 快照被整体
 *    丢弃，随后自愈写再把默认值盖回 DB 好副本。
 *  - localStorage 有效 → 权威源：store 保持 LS 值，陈旧 DB 不反向覆盖，也不
 *    做无条件 setSetting 自愈写（纯写放大，(d)）。起该方向改为轻量
 *    对账：一次 get_setting 读，与定稿快照串一致 → 零写；漂移（LS 领先，
 *    pagehide 丢写缺口）→ 一次治愈写把 DB 拉回 LS 侧；null（镜像从未写过）
 *    按最大落后补齐；挂起期间（恢复/重置 pause-ack）不读不写。
 *  - 恢复备份 ack 闸门挂起期间：DB 采纳仍发生，但 LS 写回被跳过（(c)：
 *    自愈写不再可能把恢复前旧快照写回）。
 *
 * 沿用 widget-store.hydrate.test.ts 的模式：只 mock ../lib/tauri
 * （isTauri→true + invoke 按命令名分发），真实 sqliteRepo 参与运行。
 */

const mockInvoke = vi.fn(async (cmd: string, args?: { key?: string; value?: string }): Promise<unknown> => {
  if (cmd === "get_setting") {
    getCalls.push(args?.key ?? "");
    return dbRows.get(args?.key ?? "") ?? null;
  }
  if (cmd === "set_setting") {
    setCalls.push([args?.key ?? "", args?.value ?? ""]);
    return undefined;
  }
  return null;
});

/** 模拟的 SQLite settings 表；setCalls 记录全部回写、getCalls 记录全部读取。 */
const dbRows = new Map<string, string>();
let setCalls: [string, string][] = [];
let getCalls: string[] = [];

// 部分_mock（与 cross-window.test.tsx 同型）：保留 currentWindowLabel 等真身
// 导出——防漂移锁用例会连带加载 cross-window → use-covered，后者在模块顶层
// 调用 currentWindowLabel()，完整替换式 mock 会因缺导出而炸。
vi.mock("../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/tauri")>();
  return {
    ...mod,
    isTauri: () => true,
    invoke: (...a: unknown[]) => (mockInvoke as unknown as (...x: unknown[]) => unknown)(...(a as [string]))
  };
});

async function loadModule() {
  vi.resetModules();
  return await import("./settings-store");
}

/** 让 enqueueWrite 的微任务写链与 fire-and-forget 自愈写跑完。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const LS_KEY = "focus-desk.settings.v1";
const DB_KEY = "app:settings:v1";

const GOOD_DB_SNAPSHOT = {
  preset: "terminal",
  themeMode: "dark",
  primaryColor: "#123456",
  zoom: 125,
  cornerRadius: 8,
  spacing: 24,
  general: { language: "English", launchOnStartup: true },
  extra: { updateEndpoint: "https://updates.example.com" }
};

beforeEach(() => {
  localStorage.clear();
  dbRows.clear();
  setCalls = [];
  getCalls = [];
});

describe("hydrateSettingsFromDb 权威方向", () => {
  it("localStorage 为空 → DB 镜像整包采纳（默认值不得覆盖），并把快照写回修复 LS", async () => {
    dbRows.set(DB_KEY, JSON.stringify(GOOD_DB_SNAPSHOT));

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
    // (b)：采纳后的快照写回 LS 修复它——下次启动走「LS 有效」正常路径。
    const repaired = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    expect(repaired).not.toBeNull();
    expect(repaired.preset).toBe("retro");
    expect(repaired.zoom).toBe(125);
  });

  it("localStorage 有效且与定稿快照一致 → 对账读一次 DB、零写（冷启动正常路径 1 读 0 写）", async () => {
    // 构造「一致」态：模块以该 LS 加载（store 定稿），触发一次即时落盘
    // （setWallpaperFolder 不改变值，LS 被重写为 snapshotFor 的规范形态），
    // 把同一份串放进 DB——两侧同源同键序，对账必判一致。
    localStorage.setItem(LS_KEY, JSON.stringify({ preset: "terminal", zoom: 125 })); // 旧 id，迁移为 retro
    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    useSettingsStore.getState().setWallpaperFolder("");
    await flush();
    const canonical = localStorage.getItem(LS_KEY);
    expect(canonical, "规范快照应已落盘").not.toBeNull();
    dbRows.set(DB_KEY, canonical!);
    setCalls = [];
    getCalls = [];

    await hydrateSettingsFromDb();

    // LS 值保持：terminal → retro 迁移生效。
    const s = useSettingsStore.getState();
    expect(s.preset).toBe("retro");
    expect(s.zoom).toBe(125);
    await flush();
    // 新语义：一致时不再「零读写」，而是恰好一次读 + 零写（对账代价下限）。
    expect(getCalls.filter((k) => k === DB_KEY)).toHaveLength(1);
    expect(setCalls).toEqual([]);
    expect(dbRows.get(DB_KEY)).toBe(canonical); // DB 行原样未动
  });

  it("G2：LS 领先 DB（pagehide 丢写缺口残留漂移）→ DB 被治愈为 LS 侧定稿快照", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ preset: "terminal", zoom: 125, cornerRadius: 8 }));
    const staleDb = JSON.stringify({ preset: "midnight", zoom: 999 }); // 旧 id，LS 胜出后迁移为 default
    dbRows.set(DB_KEY, staleDb);

    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    await hydrateSettingsFromDb();

    const s = useSettingsStore.getState();
    // 保护意图不弱化：LS（权威源）的值必须胜出，陈旧 DB 不得反向覆盖。
    expect(s.preset).toBe("retro"); // 旧 terminal 预设迁移为 retro
    expect(s.zoom).toBe(125);
    await flush();
    // 对账恰好一次读；随后恰好一次治愈写，把 DB 拉回 LS 侧定稿快照
    // （sanitize 后的完整形态——不是 LS 原文，更不是 DB 的陈旧值）。
    expect(getCalls.filter((k) => k === DB_KEY)).toHaveLength(1);
    expect(setCalls).toHaveLength(1);
    const [healKey, healValue] = setCalls[0];
    expect(healKey).toBe(DB_KEY);
    const healed = JSON.parse(healValue);
    expect(healed.preset).toBe("retro");
    expect(healed.zoom).toBe(125);
    expect(healed.cornerRadius).toBe(8);
    expect(typeof healed.general).toBe("object");
    expect(typeof healed.extra).toBe("object");
    expect(typeof healed.notifications).toBe("object");
  });

  it("G2：恢复/重置闸门挂起期间 → 不对账不写（reload 后自然补跑）", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ zoom: 125 }));
    dbRows.set(DB_KEY, JSON.stringify({ preset: "midnight", zoom: 999 }));

    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    const gate = await import("../lib/persist-gate");
    gate.suspendPersistence();
    try {
      await hydrateSettingsFromDb();
      // store 照常保持 LS 值（读路径不受闸门影响），但对账整体跳过。
      expect(useSettingsStore.getState().zoom).toBe(125);
      await flush();
      // 连 get_setting 都不发（挂起窗口内的状态等待 reload 对齐后补跑）。
      expect(getCalls.filter((k) => k === DB_KEY)).toHaveLength(0);
      expect(setCalls).toEqual([]);
      expect(JSON.parse(dbRows.get(DB_KEY) ?? "{}").zoom).toBe(999); // DB 陈旧值原样
    } finally {
      gate.resumePersistence();
    }
  });

  it("G2：LS 有效 + 镜像从未写过（null）→ 按最大落后治愈，补齐镜像", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ zoom: 111 }));
    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    await hydrateSettingsFromDb();
    expect(useSettingsStore.getState().zoom).toBe(111);
    await flush();
    expect(getCalls.filter((k) => k === DB_KEY)).toHaveLength(1);
    expect(setCalls).toHaveLength(1);
    expect(JSON.parse(setCalls[0][1]).zoom).toBe(111);
  });

  it("P0-1 回归：LS 损坏 + DB 完好 → 坏键被隔离、DB 整包采纳、DB 未被默认快照反杀、LS 被修复", async () => {
    localStorage.setItem(LS_KEY, "{corrupt-not-json"); // JSON.parse 直接抛错
    dbRows.set(DB_KEY, JSON.stringify(GOOD_DB_SNAPSHOT));

    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    await hydrateSettingsFromDb();

    const s = useSettingsStore.getState();
    // DB 值整包采纳（坏 LS 不再伪装「在场」击穿兜底）。
    expect(s.preset).toBe("retro");
    expect(s.themeMode).toBe("dark");
    expect(s.primaryColor).toBe("#123456");
    expect(s.zoom).toBe(125);
    expect(s.general.language).toBe("English");
    await flush();
    // 原坏键已删、原始串隔离到 .corrupt-<ts> 副本（先写副本成功再删原键）。
    expect(localStorage.getItem(LS_KEY)).not.toBe("{corrupt-not-json");
    const quarantined: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${LS_KEY}.corrupt-`)) quarantined.push(k);
    }
    expect(quarantined).toHaveLength(1);
    expect(localStorage.getItem(quarantined[0])).toBe("{corrupt-not-json");
    // LS 被采纳后的 DB 快照修复（下次启动走正常路径）。
    const repaired = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    expect(repaired?.zoom).toBe(125);
    expect(repaired?.primaryColor).toBe("#123456");
    // DB 未被默认值快照覆盖：本方向根本不应有任何 set_setting 回写。
    expect(setCalls).toEqual([]);
    expect(JSON.parse(dbRows.get(DB_KEY) ?? "{}").zoom).toBe(125);
  });

  it("P2-4：远端包先到 + LS 缺失 → 晚到的 DB 快照不整包回档", async () => {
    // 陈旧 DB（zoom 999）：若无守卫，晚到的水合会把它整包盖进 store。
    dbRows.set(DB_KEY, JSON.stringify({ preset: "midnight", zoom: 999 }));

    const { hydrateSettingsFromDb, scheduleSettingsSave, useSettingsStore } = await loadModule();
    // 模拟 sync:settings 先到：远端态直接进 store（applyRemoteSettings 走
    // setState 而非本地 setter，不写 LS——本窗口 LS 仍缺失），收尾的
    // scheduleSettingsSave 盖上「已见过远端」水印。
    useSettingsStore.setState({ zoom: 125, preset: "retro" });
    scheduleSettingsSave();

    await hydrateSettingsFromDb();

    const s = useSettingsStore.getState();
    expect(s.zoom).toBe(125); // 未被陈旧 DB 的 999 盖掉
    expect(s.preset).toBe("retro"); // 同上（DB 的 midnight 也不得反杀）
    // LS 未被水合修复（守卫分支提前返回；对端窗口的落盘负责修复共享 LS）。
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    // 断言完立即冲刷 scheduleSettingsSave 武装的 350ms 防抖落盘（模块注册的
    // pagehide → flushSettingsSave），防在飞定时器把本用例的旧模块态写进
    // 后续用例的共享 localStorage / setCalls。
    window.dispatchEvent(new Event("pagehide"));
  });

  it("P1-3 (c)：恢复闸门挂起期间 → DB 仍整包采纳，但 LS 写回被跳过（reload 后自然对齐）", async () => {
    localStorage.setItem(LS_KEY, "{corrupt-not-json");
    dbRows.set(DB_KEY, JSON.stringify(GOOD_DB_SNAPSHOT));

    const { hydrateSettingsFromDb, useSettingsStore } = await loadModule();
    const gate = await import("../lib/persist-gate");
    gate.suspendPersistence();
    try {
      await hydrateSettingsFromDb();
      // 内存态已对齐 DB（水合不因闸门跳过——它是读路径）。
      const s = useSettingsStore.getState();
      expect(s.preset).toBe("retro");
      expect(s.zoom).toBe(125);
      // 但一切写被闸门拦下：LS 保持缺失（隔离后已删），等待 reload 对齐。
      expect(localStorage.getItem(LS_KEY)).toBeNull();
      await flush();
      expect(setCalls).toEqual([]);
    } finally {
      gate.resumePersistence();
    }
  });
});

describe("SETTINGS_FIELDS 防漂移锁（P1-4）", () => {
  /**
   * 双向锁：跨窗同步清单与 snapshotFor 的落盘快照必须逐键一致。
   *  - 正向：清单里每个字段都要能在快照中解析到 defined 值（清单引用了
   *    已改名/删除的字段时必红）；
   *  - 反向：快照里每个持久化字段都必须在同步清单里（未来给 snapshotFor
   *    加字段漏更清单时必红——漏同步的字段在其他窗口保持旧值直到重启，
   *    floatingThemeMode 漏同步即此例）。
   */
  it("同步清单与 snapshotFor 落盘快照逐键一致（含 floatingThemeMode）", async () => {
    vi.resetModules();
    const cw = await import("../lib/cross-window");
    const ss = await import("./settings-store");
    // 默认 store 触发一次即时落盘（setWallpaperFolder 不改变默认值，产物即
    // snapshotFor(默认 store) 的真实落盘形态；字段为平铺顶层键）。
    ss.useSettingsStore.getState().setWallpaperFolder("");
    const snap = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    expect(snap, "快照应已落盘").not.toBeNull();

    const fields: readonly string[] = cw.SETTINGS_FIELDS;
    expect(fields).toContain("floatingThemeMode");
    for (const f of fields) {
      expect(snap[f], `同步清单字段 ${f} 未在落盘快照中（清单与 snapshotFor 漂移）`).toBeDefined();
    }
    for (const key of Object.keys(snap)) {
      expect(fields, `持久化字段 ${key} 不在 SETTINGS_FIELDS 内（跨窗同步漏字段）`).toContain(key);
    }
  });
});
