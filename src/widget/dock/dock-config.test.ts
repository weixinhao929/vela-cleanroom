import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRemoteDock,
  createDockTile,
  createDockTileAutoBound,
  currentScreenId,
  DEFAULT_DOCK,
  DOCK_TILES_DEGRADED_EVENT,
  findDockTileConflict,
  hasPersistedDock,
  parseDockConfig,
  reconcileDockTiles,
  useWidgetStore,
  type DockConfig,
  type DockTile
} from "../widget-store";
import { CHANGE_EVENT } from "../widget-config";
import { DOCK_DEFAULTS, cloneDockDefaults, migrateDockConfig, seedDockTileConfig } from "./dock-logic";

/**
 * dock 配置 v2 的解析、v1 迁移与持久化（按屏分区键 focus-desk.screen.<N>.dock.v1，
 * 键名不变，内容以 version 区分）。jsdom 无 #screen hash → 分区 "0"。
 */
const KEY = "focus-desk.screen.0.dock.v1";
const types = (cfg: DockConfig) => cfg.tiles.map((t) => t.type);
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as DockConfig | null;

describe("applyRemoteDock：等值短路", () => {
  it("与本窗内存一致的整包（重播/回读竞态）：不 setState（磁贴身份不变）、不重写 LS 镜像", () => {
    useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, tiles: [] } });
    const pkt = {
      instanceId: "peer",
      rev: 1,
      screenId: currentScreenId(),
      dock: { ...DEFAULT_DOCK, enabled: true, tiles: [{ id: "t1", type: "clock" }] }
    };
    applyRemoteDock(pkt);
    const before = useWidgetStore.getState().dock;
    const tileRef = before.tiles;
    let changed = 0;
    const unsub = useWidgetStore.subscribe(() => {
      changed += 1;
    });
    localStorage.setItem(KEY, "sentinel");
    applyRemoteDock(pkt); // 同一整包重播：内容未变
    unsub();
    expect(changed).toBe(0);
    expect(useWidgetStore.getState().dock).toBe(before);
    expect(useWidgetStore.getState().dock.tiles).toBe(tileRef);
    expect(localStorage.getItem(KEY)).toBe("sentinel");
  });

  it("内容不同的整包：照常采纳并写 LS 镜像", () => {
    useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, tiles: [] } });
    applyRemoteDock({
      instanceId: "peer",
      rev: 1,
      screenId: currentScreenId(),
      dock: { ...DEFAULT_DOCK, enabled: true, tiles: [{ id: "t2", type: "pomodoro" }] }
    });
    expect(useWidgetStore.getState().dock.tiles.map((t) => t.id)).toEqual(["t2"]);
    expect(stored()?.tiles.map((t: DockTile) => t.id)).toEqual(["t2"]);
  });
});

describe("parseDockConfig：v1 → v2 迁移", () => {
  it("组合一：三磁贴全开 + 顶部 → 三枚 {id,type}，其余字段回默认", () => {
    const cfg = parseDockConfig(
      JSON.stringify({ enabled: true, edge: "top", tiles: ["clock", "pomodoro", "notifications"] })
    );
    expect(cfg.version).toBe(2);
    expect(cfg.enabled).toBe(true);
    expect(cfg.edge).toBe("top");
    expect(types(cfg)).toEqual(["clock", "pomodoro", "notifications"]);
    for (const t of cfg.tiles) {
      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.instanceId).toBeUndefined();
    }
    expect(new Set(cfg.tiles.map((t) => t.id)).size).toBe(3);
    const { tiles: _tiles, ...rest } = cfg;
    void _tiles;
    const { tiles: _dt, ...defaultsRest } = DEFAULT_DOCK;
    void _dt;
    expect(rest).toEqual({ ...defaultsRest, enabled: true, edge: "top" });
  });

  it("组合二：旧载荷的底部贴边归为顶部（底边选项已退役）+ 子集（保持 v1 顺序）", () => {
    const cfg = parseDockConfig(JSON.stringify({ enabled: false, edge: "bottom", tiles: ["notifications", "clock"] }));
    expect(cfg.enabled).toBe(false);
    expect(cfg.edge).toBe("top");
    expect(types(cfg)).toEqual(["notifications", "clock"]);
  });

  it("组合三：缺字段（{} / 只有 enabled）→ 默认三磁贴，enabled 沿用旧值", () => {
    expect(types(parseDockConfig("{}"))).toEqual(["clock", "pomodoro", "notifications"]);
    const cfg = parseDockConfig(JSON.stringify({ enabled: true }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.edge).toBe("top");
    expect(types(cfg)).toEqual(["clock", "pomodoro", "notifications"]);
  });

  it("坏值：未知磁贴剔除、重复去重、enabled 非布尔 / edge 非法回落；tiles: [] 保持空", () => {
    const cfg = parseDockConfig(
      JSON.stringify({ enabled: "yes", edge: "diagonal", tiles: ["clock", "evil", "clock", "notifications", 42] })
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.edge).toBe("top");
    expect(types(cfg)).toEqual(["clock", "notifications"]);
    expect(parseDockConfig(JSON.stringify({ tiles: [] })).tiles).toEqual([]);
  });

  it("整体损坏 / 非对象 → 默认配置（深拷贝，不与常量共享磁贴对象与子对象）", () => {
    expect(parseDockConfig(null)).toEqual(DEFAULT_DOCK);
    expect(parseDockConfig("{bad")).toEqual(DEFAULT_DOCK);
    expect(parseDockConfig('"str"')).toEqual(DEFAULT_DOCK);
    expect(parseDockConfig("[1,2]")).toEqual(DEFAULT_DOCK);
    expect(parseDockConfig(null).tiles[0]).not.toBe(DEFAULT_DOCK.tiles[0]);
    // mouse / takeover / panel 子对象不得与 DOCK_DEFAULTS / DEFAULT_DOCK 共享引用——
    // 任何一处就地赋值都会污染模块常量（默认值）。
    for (const cfg of [parseDockConfig(null), parseDockConfig("{bad"), migrateDockConfig({}), cloneDockDefaults()]) {
      expect(cfg.mouse).not.toBe(DOCK_DEFAULTS.mouse);
      expect(cfg.takeover).not.toBe(DOCK_DEFAULTS.takeover);
      expect(cfg.panel).not.toBe(DOCK_DEFAULTS.panel);
      expect(cfg.mouse).not.toBe(DEFAULT_DOCK.mouse);
    }
    expect(DEFAULT_DOCK.mouse).not.toBe(DOCK_DEFAULTS.mouse);
    const a = parseDockConfig(null);
    a.mouse.hover = "peak";
    a.takeover.media = false;
    a.panel.mode = "grid";
    expect(DOCK_DEFAULTS.mouse.hover).toBe("none");
    expect(DOCK_DEFAULTS.takeover.media).toBe(true);
    expect(DOCK_DEFAULTS.panel.mode).toBe("carousel");
    expect(parseDockConfig(null).mouse.hover).toBe("none");
  });

  it("启动路径：localStorage 里的 v1 载荷解析后即为 v2 且磁贴一致（底边归顶）", () => {
    localStorage.setItem(KEY, JSON.stringify({ enabled: true, edge: "bottom", tiles: ["clock", "pomodoro"] }));
    const cfg = parseDockConfig(localStorage.getItem(KEY));
    expect(cfg.version).toBe(2);
    expect(cfg.enabled).toBe(true);
    expect(cfg.edge).toBe("top");
    expect(types(cfg)).toEqual(["clock", "pomodoro"]);
  });
});

describe("parseDockConfig：v2", () => {
  it("往返：完整 v2（含实例绑定 / 磁贴私有配置 / 全部岛级项）序列化再解析深等", () => {
    const cfg: DockConfig = {
      version: 2,
      enabled: true,
      edge: "top",
      offset: 0.75,
      snap: "free",
      style: "bangs",
      tiles: [
        { id: "t-weather", type: "weather", instanceId: "inst-1" },
        { id: "t-calc", type: "calculator", config: { precision: 4, theme: "x" } },
        { id: "t-clock", type: "clock" }
      ],
      mouse: { hover: "peak", blank: "panel", middle: "panel", wheel: "cycle" },
      takeover: {
        pomodoro: false,
        media: true,
        notification: false,
        brightness: true,
        volume: false,
        link: true,
        durationMs: 9000
      },
      autoHide: true,
      panel: { mode: "grid" },
      density: 48,
      topInset: 24,
      viewArrows: false
    };
    expect(parseDockConfig(JSON.stringify(cfg))).toEqual(cfg);
    // 贴边只剩顶边：旧载荷里的 bottom / left / right 一律归 top（设置页已无顶 / 底选择）。
    for (const edge of ["bottom", "left", "right"]) {
      expect(parseDockConfig(JSON.stringify({ ...cfg, edge })).edge).toBe("top");
    }
  });

  it("字段级坏值逐项回默认；磁贴剔除缺 id/type、非对象项并按 id 去重；durationMs 钳 3–15s", () => {
    const cfg = parseDockConfig(
      JSON.stringify({
        version: 2,
        enabled: 1,
        edge: "middle",
        offset: "x",
        snap: "somewhere",
        style: "wave",
        tiles: [
          { id: "a" },
          { type: "clock" },
          "clock",
          { id: "ok", type: "clock", instanceId: 7 },
          { id: "b", type: "todo" },
          { id: "b", type: "notes" },
          { id: "c", type: "habit", config: [1] }
        ],
        mouse: { hover: "dance", blank: "panel", middle: 3 },
        takeover: { pomodoro: "yes", media: false, durationMs: 99_999_999 },
        autoHide: "sometimes",
        panel: { mode: "list" },
        density: 40,
        viewArrows: "yes"
      })
    );
    expect(cfg).toEqual({
      ...DEFAULT_DOCK,
      tiles: [{ id: "b", type: "todo" }],
      mouse: { ...DEFAULT_DOCK.mouse, blank: "panel" },
      takeover: { ...DEFAULT_DOCK.takeover, media: false, durationMs: 15_000 }
    });
  });

  it("offset 钳 0–1；tiles 缺键回默认三磁贴；density 只接受 36/42/48", () => {
    expect(parseDockConfig(JSON.stringify({ version: 2, offset: 1.7 })).offset).toBe(1);
    expect(parseDockConfig(JSON.stringify({ version: 2, offset: -3 })).offset).toBe(0);
    expect(types(parseDockConfig(JSON.stringify({ version: 2 })))).toEqual(["clock", "pomodoro", "notifications"]);
    expect(parseDockConfig(JSON.stringify({ version: 2, density: 36 })).density).toBe(36);
    expect(parseDockConfig(JSON.stringify({ version: 2, density: 48 })).density).toBe(48);
    expect(parseDockConfig(JSON.stringify({ version: 2, density: 44 })).density).toBe(42);
  });

  it("autoHide 支持一.6 when-playing：布尔直取；旧三态折算（fullscreen / idle → true，never → false，垃圾值回默认）；topInset 钳 0–64 并取整", () => {
    const p = (o: Record<string, unknown>) => parseDockConfig(JSON.stringify({ version: 2, ...o }));
    expect(p({}).autoHide).toBe(false);
    expect(p({ autoHide: true }).autoHide).toBe(true);
    expect(p({ autoHide: "fullscreen" }).autoHide).toBe(true);
    expect(p({ autoHide: "idle", autoHideIdleSecs: 900 }).autoHide).toBe(true);
    expect(p({ autoHide: "never" }).autoHide).toBe(false);
    // 一.6：when-playing 字符串原样保留；布尔 / 旧三态语义不变。
    expect(p({ autoHide: "when-playing" }).autoHide).toBe("when-playing");
    expect(p({ autoHide: true }).autoHide).toBe(true);
    expect(p({ autoHide: "sometimes" }).autoHide).toBe(false);
    expect("autoHideIdleSecs" in p({ autoHideIdleSecs: 900 })).toBe(false); // 旧键不再进入配置
    expect(p({}).topInset).toBe(10);
    expect(p({ topInset: -4 }).topInset).toBe(0);
    expect(p({ topInset: 500 }).topInset).toBe(64);
    expect(p({ topInset: 24.4 }).topInset).toBe(24);
    expect(p({ topInset: null }).topInset).toBe(10);
    // 旧 v2 载荷（无这些键）解析后带默认值，往返稳定。
    const legacy = JSON.stringify({ version: 2, enabled: true });
    const cfg = parseDockConfig(legacy);
    expect(parseDockConfig(JSON.stringify(cfg))).toEqual(cfg);
  });
});

describe("入岛去重规则（findDockTileConflict）", () => {
  const tiles: DockTile[] = [
    { id: "a", type: "clock" },
    { id: "b", type: "weather", instanceId: "w-1" }
  ];

  it("身份 = 绑定实例取 instanceId，否则取 type：同实例 / 同类型无实例即冲突，不同实例的同类型不冲突", () => {
    expect(findDockTileConflict(tiles, { type: "clock" })?.id).toBe("a");
    expect(findDockTileConflict(tiles, { type: "weather", instanceId: "w-1" })?.id).toBe("b");
    // 岛上已有绑定实例的天气，再加一枚无实例天气：身份不同，允许。
    expect(findDockTileConflict(tiles, { type: "weather" })).toBeUndefined();
    // 另一张天气卡（不同实例）：允许并存。
    expect(findDockTileConflict(tiles, { type: "weather", instanceId: "w-2" })).toBeUndefined();
    // 时钟绑定某实例：与无实例时钟身份不同，允许。
    expect(findDockTileConflict(tiles, { type: "clock", instanceId: "c-1" })).toBeUndefined();
    expect(findDockTileConflict([], { type: "clock" })).toBeUndefined();
  });

  it("addDockTile 强制执行：同实例再拖入 / 同类型无实例再加 → 忽略且不落盘", () => {
    localStorage.clear();
    useWidgetStore.setState({
      dock: { ...parseDockConfig(null), tiles: tiles.map((t) => ({ ...t })) },
      dockDrag: null
    });
    const st = useWidgetStore.getState();
    const before = useWidgetStore.getState().dock.tiles;
    st.addDockTile(createDockTile("clock"));
    st.addDockTile(createDockTile("weather", "w-1"));
    expect(useWidgetStore.getState().dock.tiles).toBe(before);
    expect(hasPersistedDock()).toBe(false);
    st.addDockTile(createDockTile("weather", "w-2"));
    st.addDockTile(createDockTile("weather"));
    expect(types(useWidgetStore.getState().dock)).toEqual(["clock", "weather", "weather", "weather"]);
    expect(hasPersistedDock()).toBe(true);
  });
});

describe("绑定实例失效对账（reconcileDockTiles）", () => {
  const VIEW_KEY = (view: string) => `focus-desk.screen.0.widgets.${view}.v1`;
  const inst = (id: string) => ({ id, type: "weather", x: 0, y: 0, w: 100, h: 100, z: 1 });
  let events: DockTile[][] = [];
  const onDegraded = (e: Event) => events.push((e as CustomEvent<DockTile[]>).detail);

  beforeEach(() => {
    localStorage.clear();
    events = [];
    window.addEventListener(DOCK_TILES_DEGRADED_EVENT, onDegraded);
    useWidgetStore.setState({
      activeView: "home",
      views: [
        { id: "home", name: "Home" },
        { id: "work", name: "Work" }
      ],
      instances: [inst("w-home")],
      trash: [{ ...inst("w-trash"), view: "home", deletedAt: new Date().toISOString() }],
      dock: {
        ...parseDockConfig(null),
        tiles: [
          { id: "t-home", type: "weather", instanceId: "w-home" },
          { id: "t-work", type: "weather", instanceId: "w-work" },
          { id: "t-trash", type: "weather", instanceId: "w-trash" },
          { id: "t-gone", type: "weather", instanceId: "w-gone" },
          { id: "t-plain", type: "clock" }
        ]
      },
      dockDrag: null
    });
    localStorage.setItem(VIEW_KEY("work"), JSON.stringify([inst("w-work")]));
  });
  afterEach(() => {
    window.removeEventListener(DOCK_TILES_DEGRADED_EVENT, onDegraded);
  });

  it("当前视图 / 其他视图布局 / 回收站里的实例都算存在；只有永久消失的绑定被降级为无实例磁贴并派发事件 + 落盘", () => {
    const degraded = reconcileDockTiles();
    expect(degraded.map((t) => t.id)).toEqual(["t-gone"]);
    const tiles = useWidgetStore.getState().dock.tiles;
    expect(tiles.map((t) => t.id)).toEqual(["t-home", "t-work", "t-trash", "t-gone", "t-plain"]);
    expect(tiles.find((t) => t.id === "t-gone")).toEqual({ id: "t-gone", type: "weather" });
    expect(tiles.find((t) => t.id === "t-home")?.instanceId).toBe("w-home");
    expect(tiles.find((t) => t.id === "t-work")?.instanceId).toBe("w-work");
    expect(tiles.find((t) => t.id === "t-trash")?.instanceId).toBe("w-trash");
    expect(events).toHaveLength(1);
    expect(events[0].map((t) => t.id)).toEqual(["t-gone"]);
    expect(stored()?.tiles.find((t) => t.id === "t-gone")).toEqual({ id: "t-gone", type: "weather" });
    // 幂等：再跑一次无变化、无事件。
    expect(reconcileDockTiles()).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("降级后与岛上既有的无实例同类磁贴同身份 → 移除该枚而非保留两枚（P3：移除不派降级事件——它不是降级）", () => {
    useWidgetStore.setState((s) => ({
      dock: { ...s.dock, tiles: [...s.dock.tiles, { id: "t-weather-plain", type: "weather" }] }
    }));
    const degraded = reconcileDockTiles();
    expect(degraded.map((t) => t.id)).toEqual(["t-gone"]);
    const ids = useWidgetStore.getState().dock.tiles.map((t) => t.id);
    expect(ids).toEqual(["t-home", "t-work", "t-trash", "t-plain", "t-weather-plain"]);
    // 被整体移除的磁贴不再混进「已降级」toast 的事件明细。
    expect(events).toHaveLength(0);
  });

  it("移入回收站不降级（含删视图）；清空回收站才降级（动作内自动对账）", () => {
    const st = useWidgetStore.getState();
    st.removeWidget("w-home");
    expect(useWidgetStore.getState().dock.tiles.find((t) => t.id === "t-home")?.instanceId).toBe("w-home");
    // 上一步的自动对账已把 t-gone 降级（预置的孤儿），事件计 1 次。
    expect(events).toHaveLength(1);
    /* 删视图自「删/清视图进回收站」批起与单个删除同契约：w-work 进回收站，
       t-work 保持绑定（可随恢复点亮）；降级推迟到清空回收站。 */
    st.removeView("work");
    expect(useWidgetStore.getState().dock.tiles.find((t) => t.id === "t-work")?.instanceId).toBe("w-work");
    expect(events).toHaveLength(1);
    st.emptyWidgetTrash();
    const tiles = useWidgetStore.getState().dock.tiles;
    expect(tiles.find((t) => t.id === "t-home")).toBeUndefined();
    expect(tiles.find((t) => t.id === "t-trash")).toBeUndefined();
    expect(tiles.find((t) => t.id === "t-work")).toBeUndefined();
    /* t-home / t-trash / t-work 降级时与已存续的无实例 weather 磁贴（t-gone）
       同身份 → 按去重规则整体移除而非保留——移除不是降级，不再派「已降级」事件。 */
    expect(events).toHaveLength(1);
  });
});

describe("dock 动作（widget-store）", () => {
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({ dock: parseDockConfig(null), dockDrag: null });
  });

  it("setDock 局部更新并落盘到按屏键（内容为 v2）；tiles 过滤非法项并按 id 去重", () => {
    expect(hasPersistedDock()).toBe(false);
    useWidgetStore.getState().setDock({ enabled: true });
    expect(useWidgetStore.getState().dock.enabled).toBe(true);
    expect(useWidgetStore.getState().dock.edge).toBe("top");
    expect(hasPersistedDock()).toBe(true);
    expect(stored()).toEqual({ ...DEFAULT_DOCK, enabled: true });

    const dup: DockTile = { id: "n", type: "notifications" };
    useWidgetStore
      .getState()
      .setDock({ edge: "bottom", tiles: [dup, "bogus" as never, { id: "", type: "clock" }, dup] });
    expect(useWidgetStore.getState().dock).toEqual({ ...DEFAULT_DOCK, enabled: true, edge: "bottom", tiles: [dup] });
    expect(stored()?.tiles).toEqual([dup]);
  });

  it("addDockTile：末尾 / 指定下标 / 越界钳位 / 同 id 幂等 / 非法磁贴忽略，每次落盘", () => {
    const { addDockTile } = useWidgetStore.getState();
    const w = createDockTile("weather", "inst-w");
    addDockTile(w);
    expect(types(useWidgetStore.getState().dock)).toEqual(["clock", "pomodoro", "notifications", "weather"]);
    expect(useWidgetStore.getState().dock.tiles[3]).toEqual({ id: w.id, type: "weather", instanceId: "inst-w" });
    addDockTile({ id: "calc", type: "calculator" }, 0);
    expect(types(useWidgetStore.getState().dock)[0]).toBe("calculator");
    addDockTile({ id: "todo", type: "todo" }, 99);
    expect(types(useWidgetStore.getState().dock).at(-1)).toBe("todo");
    addDockTile({ id: "habit", type: "habit" }, -5);
    expect(types(useWidgetStore.getState().dock)[0]).toBe("habit");
    const before = useWidgetStore.getState().dock.tiles;
    addDockTile({ id: "calc", type: "notes" });
    addDockTile({ id: "", type: "notes" });
    expect(useWidgetStore.getState().dock.tiles).toBe(before);
    expect(stored()?.tiles.map((t) => t.type)).toEqual(types(useWidgetStore.getState().dock));
  });

  it("removeDockTile / moveDockTile：按 id 操作，未知 id 与原位无写入", () => {
    const st = useWidgetStore.getState();
    const [a, b, c] = st.dock.tiles;
    st.removeDockTile("nope");
    expect(useWidgetStore.getState().dock.tiles).toBe(st.dock.tiles);
    st.removeDockTile(b.id);
    expect(types(useWidgetStore.getState().dock)).toEqual(["clock", "notifications"]);
    useWidgetStore.getState().addDockTile(b, 1);
    st.moveDockTile(a.id, 2);
    expect(types(useWidgetStore.getState().dock)).toEqual(["pomodoro", "notifications", "clock"]);
    st.moveDockTile(c.id, 0);
    expect(types(useWidgetStore.getState().dock)).toEqual(["notifications", "pomodoro", "clock"]);
    const before = useWidgetStore.getState().dock.tiles;
    st.moveDockTile(c.id, 0);
    st.moveDockTile("nope", 1);
    expect(useWidgetStore.getState().dock.tiles).toBe(before);
    st.moveDockTile(c.id, 42);
    expect(types(useWidgetStore.getState().dock)).toEqual(["pomodoro", "clock", "notifications"]);
    expect(stored()?.tiles.map((t) => t.type)).toEqual(["pomodoro", "clock", "notifications"]);
  });

  it("setDockPlacement：边 / 偏移（钳 0–1）/ 吸附，非法值忽略，无变化不写", () => {
    const st = useWidgetStore.getState();
    st.setDockPlacement({ edge: "bottom", offset: 1.4, snap: "end" });
    expect(useWidgetStore.getState().dock).toMatchObject({ edge: "bottom", offset: 1, snap: "end" });
    expect(stored()).toMatchObject({ edge: "bottom", offset: 1, snap: "end" });
    st.setDockPlacement({ edge: "diagonal" as never, offset: Number.NaN, snap: "sticky" as never });
    expect(useWidgetStore.getState().dock).toMatchObject({ edge: "bottom", offset: 1, snap: "end" });
    localStorage.removeItem(KEY);
    st.setDockPlacement({ offset: 1 });
    expect(hasPersistedDock()).toBe(false);
    st.setDockPlacement({ offset: 0.25 });
    expect(useWidgetStore.getState().dock.offset).toBe(0.25);
    expect(hasPersistedDock()).toBe(true);
  });

  it("setDockTileConfig：合并到该磁贴 config 并落盘；未知 id 无写入", () => {
    const st = useWidgetStore.getState();
    const id = st.dock.tiles[0].id;
    st.setDockTileConfig(id, { city: "Shanghai" });
    st.setDockTileConfig(id, { unit: "C" });
    expect(useWidgetStore.getState().dock.tiles[0].config).toEqual({ city: "Shanghai", unit: "C" });
    expect(stored()?.tiles[0].config).toEqual({ city: "Shanghai", unit: "C" });
    const before = useWidgetStore.getState().dock.tiles;
    st.setDockTileConfig("nope", { x: 1 });
    expect(useWidgetStore.getState().dock.tiles).toBe(before);
    // 往返：带 config 的磁贴解析后原样保留。
    expect(parseDockConfig(localStorage.getItem(KEY)).tiles[0].config).toEqual({ city: "Shanghai", unit: "C" });
  });

  it("dockDrag 瞬态：setDockDrag / clearDockDrag 只改内存，不落盘", () => {
    const st = useWidgetStore.getState();
    expect(st.dockDrag).toBeNull();
    st.setDockDrag({ pointer: { x: 10, y: 20 }, overIsland: true, insertIndex: 1 });
    expect(useWidgetStore.getState().dockDrag).toEqual({ pointer: { x: 10, y: 20 }, overIsland: true, insertIndex: 1 });
    expect(hasPersistedDock()).toBe(false);
    st.clearDockDrag();
    expect(useWidgetStore.getState().dockDrag).toBeNull();
    expect(hasPersistedDock()).toBe(false);
  });
});

describe("无实例磁贴落种合并（seedDockTileConfig）", () => {
  const TT_KEY = "focus-desk.widget-config.dock-tile-tt.v1";
  beforeEach(() => {
    localStorage.clear();
  });

  it("组件写进合成键的用户数据（data/profiles）不会被后续重种冲掉；冲突展示字段以 tile.config 为准", () => {
    // 展开面板里导入课表后，合成键持有组件自己写的数据（不含磁贴展示开关）。
    localStorage.setItem(
      TT_KEY,
      JSON.stringify({ compact: false, data: { sessions: [1, 2] }, profiles: [{ id: "default", data: {} }] })
    );
    // 之后弹层改展示开关 → tile.config 变化 → 重种：此前整写会把 data 冲掉。
    seedDockTileConfig({ id: "tt", type: "timetable", config: { compact: true } }, false);
    const merged = JSON.parse(localStorage.getItem(TT_KEY) ?? "{}");
    expect(merged.compact).toBe(true);
    expect(merged.data).toEqual({ sessions: [1, 2] });
    expect(merged.profiles).toEqual([{ id: "default", data: {} }]);
  });

  it("键缺失时按 tile.config 引导；内容未变不重复写、不派发事件", () => {
    let fired = 0;
    const on = () => fired++;
    window.addEventListener(CHANGE_EVENT, on);
    try {
      seedDockTileConfig({ id: "tt", type: "timetable", config: { compact: true } }, true);
      expect(JSON.parse(localStorage.getItem(TT_KEY) ?? "{}")).toEqual({ compact: true });
      expect(fired).toBe(1);
      seedDockTileConfig({ id: "tt", type: "timetable", config: { compact: true } }, true);
      expect(fired).toBe(1);
    } finally {
      window.removeEventListener(CHANGE_EVENT, on);
    }
  });
});

describe("课程表磁贴绑定（reconcile 升级 + createDockTileAutoBound）", () => {
  const ttInst = (id: string) => ({ id, type: "timetable", x: 0, y: 0, w: 100, h: 100, z: 1 });
  beforeEach(() => {
    localStorage.clear();
    useWidgetStore.setState({
      activeView: "home",
      views: [{ id: "home", name: "Home" }],
      instances: [ttInst("tt-1")],
      trash: [],
      dock: { ...parseDockConfig(null), tiles: [{ id: "t-tt", type: "timetable" }] },
      dockDrag: null
    });
  });

  it("无实例课程表磁贴自身无数据 → 对账升级为绑定画布实例并落盘；再跑幂等", () => {
    reconcileDockTiles();
    const tiles = useWidgetStore.getState().dock.tiles;
    expect(tiles.find((t) => t.id === "t-tt")?.instanceId).toBe("tt-1");
    expect(stored()?.tiles.find((t) => t.id === "t-tt")?.instanceId).toBe("tt-1");
    // 绑定后升级不再触发（幂等），降级事件也不该有。
    reconcileDockTiles();
    expect(useWidgetStore.getState().dock.tiles.find((t) => t.id === "t-tt")?.instanceId).toBe("tt-1");
  });

  it("磁贴合成键里已有导入的私有数据 → 保持独立，不吞用户数据", () => {
    localStorage.setItem(
      "focus-desk.widget-config.dock-tile-t-tt.v1",
      JSON.stringify({ data: { sessions: [] }, profiles: [{ id: "default", data: {} }] })
    );
    reconcileDockTiles();
    expect(useWidgetStore.getState().dock.tiles.find((t) => t.id === "t-tt")?.instanceId).toBeUndefined();
  });

  it("画布没有课程表实例 → 维持无实例磁贴", () => {
    useWidgetStore.setState({ instances: [] });
    reconcileDockTiles();
    expect(useWidgetStore.getState().dock.tiles.find((t) => t.id === "t-tt")?.instanceId).toBeUndefined();
  });

  it("createDockTileAutoBound：课程表绑已有实例（优先有数据的），其他类型不绑", () => {
    useWidgetStore.setState({ instances: [ttInst("tt-empty"), { ...ttInst("tt-data") }] });
    localStorage.setItem(
      "focus-desk.widget-config.tt-data.v1",
      JSON.stringify({ profiles: [{ id: "default", data: {} }] })
    );
    const bound = createDockTileAutoBound("timetable");
    expect(bound.instanceId).toBe("tt-data");
    expect(createDockTileAutoBound("weather").instanceId).toBeUndefined();
    useWidgetStore.setState({ instances: [] });
    expect(createDockTileAutoBound("timetable").instanceId).toBeUndefined();
  });
});
