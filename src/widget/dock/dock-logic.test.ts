import { describe, expect, it } from "vitest";
import {
  DOCK_DEFAULTS,
  dockForceVisible,
  dockTucked,
  formatClock,
  formatMMSS,
  insertionIndexAt,
  migrateDockConfig,
  resolveTakeover,
  ringProgress,
  shortenUrl,
  snapOffset,
  takeoverExpired,
  TAKEOVER_MS,
  trackChanged
} from "./dock-logic";

describe("resolveTakeover（互斥优先级链：番茄钟 > 媒体 > 通知）", () => {
  const now = 1_000_000;

  it("空槽 / 已过期 → 接受任意候选并设 6s 到期", () => {
    const t = resolveTakeover(null, { kind: "notification", title: "n" }, now);
    expect(t.kind).toBe("notification");
    expect(t.until).toBe(now + TAKEOVER_MS);
    const expired = { kind: "pomodoro" as const, title: "p", until: now - 1 };
    expect(resolveTakeover(expired, { kind: "notification", title: "n2" }, now).title).toBe("n2");
  });

  it("高优先级抢占低优先级；低优先级不能打断未过期的高优先级", () => {
    const notif = resolveTakeover(null, { kind: "notification", title: "n" }, now);
    const media = resolveTakeover(notif, { kind: "media", title: "song" }, now + 100);
    expect(media.kind).toBe("media");
    const pomo = resolveTakeover(media, { kind: "pomodoro", title: "done" }, now + 200);
    expect(pomo.kind).toBe("pomodoro");
    // 番茄钟接管期间来的通知被丢弃，引用不变。
    const kept = resolveTakeover(pomo, { kind: "notification", title: "late" }, now + 300);
    expect(kept).toBe(pomo);
    const keptMedia = resolveTakeover(pomo, { kind: "media", title: "next" }, now + 300);
    expect(keptMedia).toBe(pomo);
  });

  it("G10 亮度/音量 OSD：压过通知，与媒体同级（最新者胜），被番茄钟压住", () => {
    const notif = resolveTakeover(null, { kind: "notification", title: "n" }, now);
    const bright = resolveTakeover(notif, { kind: "brightness", title: "亮度", sub: "70%" }, now + 100);
    expect(bright.kind).toBe("brightness");
    const vol = resolveTakeover(bright, { kind: "volume", title: "音量", sub: "45%" }, now + 200);
    expect(vol.kind).toBe("volume");
    // 音量接管期间切歌：同级最新者胜。
    const song = resolveTakeover(vol, { kind: "media", title: "song" }, now + 300);
    expect(song.kind).toBe("media");
    // 番茄钟响铃仍最高。
    const pomo = resolveTakeover(song, { kind: "pomodoro", title: "done" }, now + 400);
    expect(pomo.kind).toBe("pomodoro");
    const kept = resolveTakeover(pomo, { kind: "volume", title: "音量" }, now + 500);
    expect(kept).toBe(pomo);
  });

  it("G10 开关：brightness / volume 关闭时候选被丢弃", () => {
    const bright = resolveTakeover(null, { kind: "brightness", title: "亮度" }, now, { brightness: false });
    expect(bright).toBeNull();
    const vol = resolveTakeover(null, { kind: "volume", title: "音量" }, now, { volume: false });
    expect(vol).toBeNull();
    const on = resolveTakeover(null, { kind: "volume", title: "音量" }, now, { volume: true });
    expect(on!.kind).toBe("volume");
  });

  it("同级候选以最新为准（连续两条通知显示后到的）", () => {
    const a = resolveTakeover(null, { kind: "notification", title: "a" }, now);
    const b = resolveTakeover(a, { kind: "notification", title: "b" }, now + 500);
    expect(b.title).toBe("b");
    expect(b.until).toBe(now + 500 + TAKEOVER_MS);
  });

  it("takeoverExpired 边界：until <= now 视为过期", () => {
    expect(takeoverExpired(null, now)).toBe(false);
    expect(takeoverExpired({ kind: "media", title: "", until: now }, now)).toBe(true);
    expect(takeoverExpired({ kind: "media", title: "", until: now + 1 }, now)).toBe(false);
  });

  it("enabledKinds（F-8）：已关闭的 kind 不接管——返回原引用，空槽时返回 null", () => {
    const cur = resolveTakeover(null, { kind: "notification", title: "n" }, now);
    expect(resolveTakeover(cur, { kind: "media", title: "m" }, now + 1, { media: false })).toBe(cur);
    expect(resolveTakeover(cur, { kind: "pomodoro", title: "p" }, now + 1, { pomodoro: false })).toBe(cur);
    expect(resolveTakeover(null, { kind: "media", title: "m" }, now, { media: false })).toBeNull();
    // 已过期的当前 + 被关的候选 → 维持原引用（不复活候选，由 UI 定时器清理）。
    const expired = { kind: "notification" as const, title: "old", until: now - 1 };
    expect(resolveTakeover(expired, { kind: "media", title: "m" }, now, { media: false })).toBe(expired);
  });

  it("enabledKinds 缺省 / 空对象 / 缺项 = 全开（三参调用向后兼容）", () => {
    expect(resolveTakeover(null, { kind: "media", title: "m" }, now).kind).toBe("media");
    expect(resolveTakeover(null, { kind: "media", title: "m" }, now, undefined)?.kind).toBe("media");
    expect(resolveTakeover(null, { kind: "media", title: "m" }, now, {})?.kind).toBe("media");
    expect(resolveTakeover(null, { kind: "media", title: "m" }, now, { pomodoro: false })?.kind).toBe("media");
    // 开着的 kind 照常抢占：关掉通知不影响媒体抢占通知。
    const notif = resolveTakeover(null, { kind: "notification", title: "n" }, now);
    const media = resolveTakeover(notif, { kind: "media", title: "m" }, now + 1, { notification: false });
    expect(media?.kind).toBe("media");
    expect(media?.until).toBe(now + 1 + TAKEOVER_MS);
  });

  it("[ISLAND-LINK] 接管开关：全关一律丢弃；关掉的高优先级不能抢占；同 kind 关掉不刷新到期", () => {
    const allOff = { pomodoro: false, media: false, notification: false };
    expect(resolveTakeover(null, { kind: "pomodoro", title: "p" }, now, allOff)).toBeNull();
    expect(resolveTakeover(null, { kind: "media", title: "m" }, now, allOff)).toBeNull();
    expect(resolveTakeover(null, { kind: "notification", title: "n" }, now, allOff)).toBeNull();
    const cur = resolveTakeover(null, { kind: "media", title: "song" }, now);
    // 番茄钟本该抢占媒体，但被用户关掉 → 媒体接管保持，引用与到期都不动。
    const kept = resolveTakeover(cur, { kind: "pomodoro", title: "done" }, now + 100, { pomodoro: false });
    expect(kept).toBe(cur);
    expect(kept?.until).toBe(now + TAKEOVER_MS);
    // 同 kind 候选在该 kind 关闭期间到达：不换内容、不延长到期（关闭生效于「新接管」，不打断在途）。
    const same = resolveTakeover(cur, { kind: "media", title: "next" }, now + 200, { media: false });
    expect(same).toBe(cur);
    expect(same?.title).toBe("song");
  });

  it("[ISLAND-LINK] 引用语义：接受 = 新对象、丢弃 = 同引用（useDockTakeover 据此决定是否套用配置时长）", () => {
    const cur = resolveTakeover(null, { kind: "notification", title: "n" }, now);
    const accepted = resolveTakeover(cur, { kind: "notification", title: "n2" }, now + 1);
    expect(accepted).not.toBe(cur);
    expect(accepted.until).toBe(now + 1 + TAKEOVER_MS);
    const dropped = resolveTakeover(cur, { kind: "notification", title: "n3" }, now + 1, { notification: false });
    expect(dropped).toBe(cur);
    // 已过期的当前被新候选替换时同样是新对象（到期由调用方按配置时长重算）。
    const expired = { kind: "media" as const, title: "old", until: now - 1 };
    expect(resolveTakeover(expired, { kind: "notification", title: "n" }, now)).not.toBe(expired);
  });

  it("[ISLAND-LINK] DOCK_DEFAULTS.takeover：三 kind 全开且 durationMs 与 TAKEOVER_MS 同源（默认行为 = 2.0 前 6s）", () => {
    expect(DOCK_DEFAULTS.takeover).toEqual({
      pomodoro: true,
      media: true,
      notification: true,
      brightness: true,
      volume: true,
      link: true,
      durationMs: TAKEOVER_MS
    });
    expect(TAKEOVER_MS).toBe(6000);
    // 默认开关表传入 resolveTakeover 等价于全开。
    const { pomodoro, media, notification } = DOCK_DEFAULTS.takeover;
    expect(resolveTakeover(null, { kind: "media", title: "m" }, now, { pomodoro, media, notification })?.kind).toBe(
      "media"
    );
  });
});

describe("migrateDockConfig（v1 → v2，纯函数）", () => {
  const seq = () => {
    let n = 0;
    return () => `id-${++n}`;
  };

  it("三组合：全开顶部 / 关闭底部 / 磁贴子集——磁贴逐枚变 {id,type}，其余回默认", () => {
    const full = migrateDockConfig(
      { enabled: true, edge: "top", tiles: ["clock", "pomodoro", "notifications"] },
      seq()
    );
    expect(full).toEqual({
      ...DOCK_DEFAULTS,
      enabled: true,
      edge: "top",
      tiles: [
        { id: "id-1", type: "clock" },
        { id: "id-2", type: "pomodoro" },
        { id: "id-3", type: "notifications" }
      ]
    });
    // edge 一律归 top（贴底已退役、竖边无实现；此前保留逻辑被调用点
    // edge:"top" 覆盖成死代码，现归迁移函数自身完成）。
    const bottom = migrateDockConfig({ enabled: false, edge: "bottom", tiles: ["pomodoro"] }, seq());
    expect(bottom).toEqual({
      ...DOCK_DEFAULTS,
      enabled: false,
      edge: "top",
      tiles: [{ id: "id-1", type: "pomodoro" }]
    });
    const subset = migrateDockConfig({ enabled: true, edge: "top", tiles: ["notifications", "clock"] }, seq());
    expect(subset.tiles.map((t) => t.type)).toEqual(["notifications", "clock"]);
  });

  it("坏值：未知 / 重复 / 非字符串磁贴剔除；enabled 非布尔、edge 非法回落；tiles 非数组回默认三枚", () => {
    const bad = migrateDockConfig(
      { enabled: "yes", edge: 3, tiles: ["clock", "evil", "clock", 7, null, "notifications"] },
      seq()
    );
    expect(bad.enabled).toBe(false);
    expect(bad.edge).toBe("top");
    expect(bad.tiles).toEqual([
      { id: "id-1", type: "clock" },
      { id: "id-2", type: "notifications" }
    ]);
    expect(migrateDockConfig({ tiles: "clock" }, seq()).tiles.map((t) => t.type)).toEqual([
      "clock",
      "pomodoro",
      "notifications"
    ]);
    expect(migrateDockConfig({ tiles: [] }, seq()).tiles).toEqual([]);
  });

  it("缺字段：{} / null / 非对象 → 默认三磁贴 + 全默认字段；一切旧边值（含 left/right）都归 top", () => {
    for (const v1 of [{}, null, undefined, "junk", 12]) {
      const cfg = migrateDockConfig(v1, seq());
      expect(cfg.tiles.map((t) => t.type)).toEqual(["clock", "pomodoro", "notifications"]);
      expect(cfg.enabled).toBe(false);
      expect(cfg.edge).toBe("top");
      expect(cfg.version).toBe(2);
    }
    expect(migrateDockConfig({ edge: "left" }, seq()).edge).toBe("top");
    expect(migrateDockConfig({ edge: "right" }, seq()).edge).toBe("top");
  });

  it("P3：autoHide 合法值保留、旧三态折算（never→false / fullscreen·idle→true / when-playing 直传）、垃圾回默认", () => {
    expect(migrateDockConfig({ autoHide: true }, seq()).autoHide).toBe(true);
    expect(migrateDockConfig({ autoHide: false }, seq()).autoHide).toBe(false);
    expect(migrateDockConfig({ autoHide: "when-playing" }, seq()).autoHide).toBe("when-playing");
    expect(migrateDockConfig({ autoHide: "never" }, seq()).autoHide).toBe(false);
    expect(migrateDockConfig({ autoHide: "fullscreen" }, seq()).autoHide).toBe(true);
    expect(migrateDockConfig({ autoHide: "idle" }, seq()).autoHide).toBe(true);
    expect(migrateDockConfig({ autoHide: "junk" }, seq()).autoHide).toBe(DOCK_DEFAULTS.autoHide);
  });

  it("P3：idGen 按磁贴类型取 id（生产注入确定性 `dock-tile-<type>`，多窗口并发迁移不再各造 uuid）", () => {
    const cfg = migrateDockConfig({ tiles: ["clock", "pomodoro"] }, (t) => `dock-tile-${t}`);
    expect(cfg.tiles).toEqual([
      { id: "dock-tile-clock", type: "clock" },
      { id: "dock-tile-pomodoro", type: "pomodoro" }
    ]);
  });

  it("缺省 idGen 产生非空且互不相同的 id（crypto.randomUUID）", () => {
    const cfg = migrateDockConfig({ tiles: ["clock", "pomodoro", "notifications"] });
    const ids = cfg.tiles.map((t) => t.id);
    expect(ids.every((id) => typeof id === "string" && id.length >= 8)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("insertionIndexAt（插入位：中线左侧插前、中线及右侧插后）", () => {
  const rects = [
    { left: 0, width: 40 },
    { left: 44, width: 40 },
    { left: 88, width: 40 }
  ];

  it("空列表恒 0", () => {
    expect(insertionIndexAt([], -100)).toBe(0);
    expect(insertionIndexAt([], 0)).toBe(0);
    expect(insertionIndexAt([], 999)).toBe(0);
  });

  it("首 / 中 / 尾", () => {
    expect(insertionIndexAt(rects, -5)).toBe(0);
    expect(insertionIndexAt(rects, 10)).toBe(0);
    expect(insertionIndexAt(rects, 30)).toBe(1);
    expect(insertionIndexAt(rects, 62)).toBe(1);
    expect(insertionIndexAt(rects, 70)).toBe(2);
    expect(insertionIndexAt(rects, 120)).toBe(3);
    expect(insertionIndexAt(rects, 10_000)).toBe(3);
  });

  it("恰在中线上 → 插到该磁贴之后；与矩形绝对位置无关（只看 left/width）", () => {
    expect(insertionIndexAt(rects, 20)).toBe(1);
    expect(insertionIndexAt(rects, 64)).toBe(2);
    expect(insertionIndexAt(rects, 108)).toBe(3);
    const shifted = rects.map((r) => ({ left: r.left + 1000, width: r.width }));
    expect(insertionIndexAt(shifted, 1062)).toBe(1);
    expect(insertionIndexAt(shifted, 500)).toBe(0);
  });
});

describe("snapOffset（沿边吸附：start=0 / center=0.5 / end=1，阈值按像素）", () => {
  const size = 1000;

  it("阈值内吸到最近点，阈值外保持自由位", () => {
    expect(snapOffset(0.03, size)).toEqual({ offset: 0, snap: "start" });
    expect(snapOffset(0.04, size)).toEqual({ offset: 0.04, snap: "free" });
    expect(snapOffset(0.48, size)).toEqual({ offset: 0.5, snap: "center" });
    expect(snapOffset(0.52, size)).toEqual({ offset: 0.5, snap: "center" });
    expect(snapOffset(0.45, size)).toEqual({ offset: 0.45, snap: "free" });
    expect(snapOffset(0.975, size)).toEqual({ offset: 1, snap: "end" });
    expect(snapOffset(0.9, size)).toEqual({ offset: 0.9, snap: "free" });
    // 恰等于阈值 → 不吸（严格小于）。
    expect(snapOffset(0.032, size)).toEqual({ offset: 0.032, snap: "free" });
  });

  it("边界 0 / 1 恰在吸附点；越界钳回 0–1 后再判", () => {
    expect(snapOffset(0, size)).toEqual({ offset: 0, snap: "start" });
    expect(snapOffset(1, size)).toEqual({ offset: 1, snap: "end" });
    expect(snapOffset(0.5, size)).toEqual({ offset: 0.5, snap: "center" });
    expect(snapOffset(-0.4, size)).toEqual({ offset: 0, snap: "start" });
    expect(snapOffset(1.9, size)).toEqual({ offset: 1, snap: "end" });
    expect(snapOffset(Number.NaN, size)).toEqual({ offset: 0.5, snap: "center" });
  });

  it("自定义阈值 / 尺寸；并列取 start → center → end 先者；size 非正视为无吸附", () => {
    expect(snapOffset(0.25, size, 200)).toEqual({ offset: 0.25, snap: "free" });
    expect(snapOffset(0.32, size, 200)).toEqual({ offset: 0.5, snap: "center" });
    expect(snapOffset(0.25, size, 300)).toEqual({ offset: 0, snap: "start" });
    expect(snapOffset(0.75, size, 300)).toEqual({ offset: 0.5, snap: "center" });
    // 同一比例、屏更窄 → 像素距离更小，更容易吸附。
    expect(snapOffset(0.04, 500)).toEqual({ offset: 0, snap: "start" });
    expect(snapOffset(0.5, 0)).toEqual({ offset: 0.5, snap: "free" });
    expect(snapOffset(0, -10)).toEqual({ offset: 0, snap: "free" });
  });
});

describe("格式与进度", () => {
  it("formatClock 补零 24 小时制", () => {
    expect(formatClock(new Date(2026, 0, 1, 9, 5))).toBe("09:05");
    expect(formatClock(new Date(2026, 0, 1, 23, 59))).toBe("23:59");
  });

  it("formatMMSS 补零并钳负数/非法为 0", () => {
    expect(formatMMSS(1500)).toBe("25:00");
    expect(formatMMSS(65)).toBe("01:05");
    expect(formatMMSS(-3)).toBe("00:00");
    expect(formatMMSS(Number.NaN)).toBe("00:00");
  });

  it("ringProgress：倒计时=已用占比，正计时=已计占比，planned≤0 为 0，夹在 0–1", () => {
    expect(ringProgress(1500, 1500, "countdown")).toBe(0);
    expect(ringProgress(750, 1500, "countdown")).toBeCloseTo(0.5);
    expect(ringProgress(0, 1500, "countdown")).toBe(1);
    expect(ringProgress(300, 1500, "countup")).toBeCloseTo(0.2);
    expect(ringProgress(3000, 1500, "countup")).toBe(1);
    expect(ringProgress(10, 0, "countdown")).toBe(0);
  });

  it("trackChanged：忽略首次采样与空标题；标题或艺术家变化即切歌", () => {
    expect(trackChanged(null, { title: "A", artist: "x" })).toBe(false);
    expect(trackChanged({ title: "A", artist: "x" }, { title: "", artist: "" })).toBe(false);
    expect(trackChanged({ title: "A", artist: "x" }, { title: "A", artist: "x" })).toBe(false);
    expect(trackChanged({ title: "A", artist: "x" }, { title: "B", artist: "x" })).toBe(true);
    expect(trackChanged({ title: "A", artist: "x" }, { title: "A", artist: "y" })).toBe(true);
  });

  it("trackChanged 按 media:snapshot 事件序列推进：校准快照与空闲 null 不触发，恢复播放视为首采样", () => {
    // 模拟 DockContainer 的基准推进：每个事件到达后 prev = next。
    const A = { title: "A", artist: "x" };
    const B = { title: "B", artist: "x" };
    const events: (typeof A | null)[] = [A, A, A, B, B, null, B, null];
    //               初值 校准 校准 切歌 校准 空闲 恢复 空闲
    const fired: boolean[] = [];
    let prev: typeof A | null = null;
    for (const next of events) {
      fired.push(trackChanged(prev, next));
      prev = next;
    }
    expect(fired).toEqual([false, false, false, true, false, false, false, false]);
  });
});

/* ══ 借鉴 同类灵动岛工具 的增强（一.4 / 一.6 / 二.12）══ */

describe("link 接管（一.4）：优先级与媒体同级、压过通知", () => {
  const now = 1_000_000;
  it("链接抢占未过期的通知接管", () => {
    const notif = resolveTakeover(null, { kind: "notification", title: "n" }, now);
    const link = resolveTakeover(notif, { kind: "link", title: "u", url: "https://x" }, now + 100);
    expect(link.kind).toBe("link");
  });
  it("链接与媒体同级最新者胜；番茄钟响铃仍然最高", () => {
    const link = resolveTakeover(null, { kind: "link", title: "u", url: "https://x" }, now);
    expect(resolveTakeover(link, { kind: "media", title: "m" }, now + 100).kind).toBe("media");
    const pomo = resolveTakeover(null, { kind: "pomodoro", title: "p" }, now);
    expect(resolveTakeover(pomo, { kind: "link", title: "u" }, now + 100).kind).toBe("pomodoro");
  });
  it("takeover.link 关闭时候选被丢弃（enabledKinds 门控）", () => {
    const out = resolveTakeover(null, { kind: "link", title: "u" }, now, { link: false });
    expect(out).toBeNull();
  });
});

describe("shortenUrl（链接快开的显示缩短）", () => {
  it("短链接原样返回；长链接折叠并尽量在分隔符处截断", () => {
    expect(shortenUrl("https://a.b/c")).toBe("https://a.b/c");
    const long = "https://example.com/some/very/long/path/segment?q=1";
    const out = shortenUrl(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(49);
    expect(out.startsWith("https://example.com/")).toBe(true);
  });
});

describe("dockForceVisible / dockTucked（二.12 强制弹出单一真源 + 一.6 模式）", () => {
  const idle = { editMode: false, expandedId: null, takeover: null, dragging: false, revealed: false };
  it("任一强制条件成立即弹出：编辑 / 展开 / 接管（全 kind）/ 拖动 / 悬停", () => {
    expect(dockForceVisible({ ...idle, editMode: true })).toBe(true);
    expect(dockForceVisible({ ...idle, expandedId: "dock:x" })).toBe(true);
    expect(dockForceVisible({ ...idle, dragging: true })).toBe(true);
    expect(dockForceVisible({ ...idle, revealed: true })).toBe(true);
    // 全 kind 穷举：任何接管（含新增 link）都算——新增临时内容必须进排除清单。
    for (const kind of ["pomodoro", "media", "notification", "brightness", "volume", "link"] as const) {
      expect(dockForceVisible({ ...idle, takeover: { kind, title: "t" } })).toBe(true);
    }
    expect(dockForceVisible(idle)).toBe(false);
  });
  it("dockTucked：关闭永不收；true 常驻收；when-playing 仅无播放时收；强制弹出恒优先", () => {
    expect(dockTucked(false, false, false)).toBe(false);
    expect(dockTucked(true, true, false)).toBe(true);
    expect(dockTucked(true, false, false)).toBe(true);
    // when-playing：暂停 / 无会话 → 收；播放中 → 弹。
    expect(dockTucked("when-playing", false, false)).toBe(true);
    expect(dockTucked("when-playing", true, false)).toBe(false);
    // 强制弹出（接管 / 悬停等）压过一切收合条件。
    expect(dockTucked(true, false, true)).toBe(false);
    expect(dockTucked("when-playing", false, true)).toBe(false);
  });
});
