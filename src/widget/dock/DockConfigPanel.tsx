/**
 * 灵动岛配置面板（编辑模式浮层，ISLAND-CFG · 快捷项 + 入口 c）。
 * 由编辑工具栏「灵动岛」按钮弹出，落点与布局模板面板一致（工具栏上方居中）；
 * 全量项在设置窗口「灵动岛」页（features/settings/pages/DockPage.tsx），
 * 两处读写同一份 widget-store.dock，所有改动经 CORE 动作即时按屏落盘。
 *
 * 快捷项：启用 / 位置吸附（左 · 中 · 右 · 自由）+ 偏移滑条（贴边只剩顶边，不再提供顶 / 底选择）
 * （仅自由位可用）/ 悬停行为 / 接管三开关。
 * 磁贴芯片行（可排序多选芯片行）：列出已入岛磁贴，芯片
 * ↑↓ 排序（moveDockTile）、× 移除（removeDockTile），末尾「+」打开类型菜单
 * （addDockTile；registry 全部类型都可入岛）。DockTypePicker 由 SORT 会话提供，
 * 合入前此处先用简单下拉，合入后切换。
 *
 * 控件样式全部在 feature-dock.css ══ CONFIG ══ 区段（桌面层不加载
 * settings.css，不能借用 .tm-toggle / .tm-segmented）；滑条用 M3Slider——它的
 * 样式在两窗共用的 feature-polish.css 里。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp, Plus, X, type LucideIcon } from "lucide-react";
import { useT } from "../../i18n-lite";
import { animDurations } from "../../lib/durations";
import { useDismissable } from "../../lib/use-dismissable";
import { flipReorder, prefersReducedMotion, useDelayedUnmount } from "../../lib/anim";
import { M3Slider } from "../../components/ui/M3Slider";
import { getWidgetMeta, WIDGET_REGISTRY } from "../registry";
import {
  createDockTileAutoBound,
  findDockTileConflict,
  useWidgetStore,
  type DockMouseActions,
  type DockSnap,
  type DockTakeoverConfig,
  type DockTile
} from "../widget-store";

/** 吸附点 → 规范偏移（与 dock-logic.snapOffset 的三点一致）。 */
const SNAP_OFFSET: Record<Exclude<DockSnap, "free">, number> = { start: 0, center: 0.5, end: 1 };

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`dock-cfg-switch${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      data-interactive
    >
      <span className="dock-cfg-switch-thumb" />
    </button>
  );
}

function Seg<T extends string>({
  value,
  label,
  options,
  onChange
}: {
  value: T;
  label: string;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  /* 滑行药丸（对齐设置窗 .tm-segmented 手感）：量测激活段几何，只用
     transform（位移 + scaleX）表达——药丸无文字，缩放不变形，也不触
     layout-anim 门禁。 */
  const listRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; sx: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLButtonElement>(".dock-cfg-seg-item.active");
    if (!list || !active) {
      setPill(null);
      return;
    }
    setPill({ x: active.offsetLeft, sx: active.offsetWidth / list.clientWidth });
  }, [value, options.length]);
  return (
    <div className="dock-cfg-seg" role="radiogroup" aria-label={label} ref={listRef}>
      {pill && (
        <span
          className="dock-cfg-seg-pill"
          aria-hidden="true"
          style={{ transform: `translateX(${pill.x}px) scaleX(${pill.sx})` }}
        />
      )}
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          className={`dock-cfg-seg-item${value === o.id ? " active" : ""}`}
          role="radio"
          aria-checked={value === o.id}
          tabIndex={value === o.id || (i === 0 && !options.some((x) => x.id === value)) ? 0 : -1}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              onChange(options[(i + 1) % options.length].id);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              onChange(options[(i - 1 + options.length) % options.length].id);
            }
          }}
          data-interactive
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DockConfigPanel({ closing, style }: { closing?: boolean; style?: CSSProperties }) {
  const tr = useT();
  const dock = useWidgetStore((s) => s.dock);
  const setDock = useWidgetStore((s) => s.setDock);
  const setDockPlacement = useWidgetStore((s) => s.setDockPlacement);
  const addDockTile = useWidgetStore((s) => s.addDockTile);
  const removeDockTile = useWidgetStore((s) => s.removeDockTile);
  const moveDockTile = useWidgetStore((s) => s.moveDockTile);

  /* 磁贴芯片行反馈：↑↓ 排序走 flipReorder（§4「磁贴增 / 删 / 排序 FLIP 经
     pickSpatialEase」成文规范）；× 移除先播收缩退场再提交 store。 */
  const tilesRef = useRef<HTMLDivElement>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  /* 偏移滑条拖动期只进草稿、松手（onCommitEnd）一次 setDockPlacement——
     此前逐 input 事件全量落盘（localStorage + SQLite 镜像 + 窗口对账）。
     草稿经 ref 保鲜：键盘步进是 onChange + onCommitEnd 同拍触发，闭包里的
     state 是步进前的旧值，直接读会永远提交不出。 */
  const offsetDraftRef = useRef<number | null>(null);
  const [offsetDraft, setOffsetDraft] = useState<number | null>(null);
  const slideOffset = (v: number) => {
    offsetDraftRef.current = v;
    setOffsetDraft(v);
  };
  const commitOffset = () => {
    const v = offsetDraftRef.current;
    offsetDraftRef.current = null;
    setOffsetDraft(null);
    if (v !== null) setDockPlacement({ snap: "free", offset: v / 100 });
  };
  const bumpTile = (id: string, to: number) => {
    if (!tilesRef.current) return;
    flipReorder(tilesRef.current, ".dock-cfg-tile-chip", () => moveDockTile(id, to));
  };
  /* 在途移除定时器记账——面板退场卸载时取消（「卸载后仍提交」）；锁只挡
     同一枚磁贴重复触发，不同磁贴的退场不再互相阻塞（原单飞锁会静默吞掉
     快速连点第二枚的移除）。 */
  const removeTimers = useRef<Set<number>>(new Set());
  useEffect(
    () => () => {
      for (const t of removeTimers.current) window.clearTimeout(t);
      removeTimers.current.clear();
    },
    []
  );
  const removeTile = (id: string) => {
    if (removingId === id) return;
    setRemovingId(id);
    const t = window.setTimeout(
      () => {
        removeTimers.current.delete(t);
        removeDockTile(id);
        setRemovingId((cur) => (cur === id ? null : cur));
      },
      prefersReducedMotion() ? 0 : animDurations().fxFastMs
    );
    removeTimers.current.add(t);
  };

  /* 与 DockPage 同款——子对象补丁取 getState() 当前值，渲染闭包在
     跨窗同步 / 连续回调后会陈旧，展开陈旧兄弟字段会整包回滚对端刚写的字段。 */
  const setMouse = (patch: Partial<DockMouseActions>) =>
    setDock({ mouse: { ...useWidgetStore.getState().dock.mouse, ...patch } });
  const setTakeover = (patch: Partial<DockTakeoverConfig>) =>
    setDock({ takeover: { ...useWidgetStore.getState().dock.takeover, ...patch } });
  const setSnap = (snap: DockSnap) =>
    snap === "free" ? setDockPlacement({ snap }) : setDockPlacement({ snap, offset: SNAP_OFFSET[snap] });

  const snaps: { id: DockSnap; label: string }[] = [
    { id: "start", label: tr("左") },
    { id: "center", label: tr("居中") },
    { id: "end", label: tr("右") },
    { id: "free", label: tr("自由") }
  ];
  const hovers: { id: DockMouseActions["hover"]; label: string }[] = [
    { id: "none", label: tr("无") },
    { id: "peak", label: tr("微涨") },
    { id: "expand-first", label: tr("展开首磁贴") }
  ];

  /* 「+」类型菜单：简单下拉（DockTypePicker 合入后替换）。Esc / 外点关闭
     （统一骨架）；关闭走 useDelayedUnmount 播 .is-closing 退场（弹层退场档）。 */
  const [addOpen, setAddOpen] = useState(false);
  const addKeep = useDelayedUnmount(addOpen, animDurations().fxXfastMs);
  const addRef = useRef<HTMLDivElement>(null);
  useDismissable(addOpen, addRef, () => setAddOpen(false));

  const tileName = (tile: DockTile): string => {
    const meta = getWidgetMeta(tile.type);
    return meta ? tr(meta.name) : tile.type;
  };

  return (
    /* 浮层补对话语义——无 role/无障碍名时读屏只报一坨控件；触发钮的
       aria-expanded / aria-haspopup 在编辑工具栏「灵动岛」按钮上（WidgetCanvas）。
       aria-modal 不标：面板非模态（背景仍可交互、外点关闭），标 true 会让
       读屏把背景全部静音。锚点 style 由 WidgetCanvas 按工具栏位置计算传入。 */
    <div
      id="edit-panel-dock"
      className={`dock-cfg${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-label={tr("灵动岛")}
      style={style}
      data-interactive
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dock-cfg-head">
        <span className="dock-cfg-title">{tr("灵动岛")}</span>
        <span className="dock-cfg-desc">{tr("贴边的常驻小组件聚合条")}</span>
      </div>

      <div className="dock-cfg-row">
        <span className="dock-cfg-label">{tr("启用灵动岛")}</span>
        <Switch on={dock.enabled} label={tr("启用灵动岛")} onChange={(v) => setDock({ enabled: v })} />
      </div>

      <div className="dock-cfg-row">
        <span className="dock-cfg-label">{tr("位置吸附")}</span>
        <Seg value={dock.snap} label={tr("位置吸附")} options={snaps} onChange={setSnap} />
      </div>

      {/* 偏移滑条只在自由位可用：fieldset[disabled] 原生禁用内部 range，无需 M3Slider 支持 disabled。 */}
      <fieldset className="dock-cfg-row dock-cfg-fieldset" disabled={dock.snap !== "free"} aria-label={tr("偏移")}>
        <span className="dock-cfg-label">{tr("偏移")}</span>
        <M3Slider
          label="偏移"
          value={offsetDraft ?? Math.round(dock.offset * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={slideOffset}
          onCommitEnd={commitOffset}
        />
      </fieldset>

      <div className="dock-cfg-row">
        <span className="dock-cfg-label">{tr("悬停")}</span>
        <Seg value={dock.mouse.hover} label={tr("悬停")} options={hovers} onChange={(hover) => setMouse({ hover })} />
      </div>

      <div className="dock-cfg-row is-col">
        <span className="dock-cfg-label">{tr("接管")}</span>
        <div className="dock-cfg-takeover" role="group" aria-label={tr("接管")}>
          <label className="dock-cfg-takeover-item">
            <span>{tr("番茄钟")}</span>
            <Switch
              on={dock.takeover.pomodoro}
              label={tr("番茄钟接管")}
              onChange={(v) => setTakeover({ pomodoro: v })}
            />
          </label>
          <label className="dock-cfg-takeover-item">
            <span>{tr("媒体")}</span>
            <Switch on={dock.takeover.media} label={tr("媒体接管")} onChange={(v) => setTakeover({ media: v })} />
          </label>
          <label className="dock-cfg-takeover-item">
            <span>{tr("通知")}</span>
            <Switch
              on={dock.takeover.notification}
              label={tr("通知接管")}
              onChange={(v) => setTakeover({ notification: v })}
            />
          </label>
          <label className="dock-cfg-takeover-item">
            <span>{tr("亮度")}</span>
            <Switch
              on={dock.takeover.brightness}
              label={tr("亮度接管")}
              onChange={(v) => setTakeover({ brightness: v })}
            />
          </label>
          <label className="dock-cfg-takeover-item">
            <span>{tr("音量")}</span>
            <Switch on={dock.takeover.volume} label={tr("音量接管")} onChange={(v) => setTakeover({ volume: v })} />
          </label>
          <label className="dock-cfg-takeover-item">
            <span>{tr("链接")}</span>
            <Switch on={dock.takeover.link} label={tr("链接快开")} onChange={(v) => setTakeover({ link: v })} />
          </label>
        </div>
      </div>

      <div className="dock-cfg-row is-col">
        <span className="dock-cfg-label">{tr("已入岛磁贴")}</span>
        <div className="dock-cfg-tiles" role="list" aria-label={tr("已入岛磁贴")} ref={tilesRef}>
          {dock.tiles.length === 0 && <span className="dock-cfg-empty">{tr("暂无磁贴，点「+」添加")}</span>}
          {dock.tiles.map((tile, i) => {
            const meta = getWidgetMeta(tile.type);
            const Icon: LucideIcon | undefined = meta?.icon;
            const name = tileName(tile);
            return (
              <div
                key={tile.id}
                className={`dock-cfg-tile-chip${removingId === tile.id ? " is-closing" : ""}`}
                role="listitem"
                data-tile-id={tile.id}
              >
                {Icon && <Icon size={13} />}
                <span className="dock-cfg-tile-name">{name}</span>
                {tile.instanceId && (
                  <span className="dock-cfg-tile-bound" title={tr("已绑定画布实例")} aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="dock-cfg-chip-btn"
                  aria-label={`${tr("上移")} ${name}`}
                  disabled={i === 0}
                  onClick={() => bumpTile(tile.id, i - 1)}
                  data-interactive
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  type="button"
                  className="dock-cfg-chip-btn"
                  aria-label={`${tr("下移")} ${name}`}
                  disabled={i === dock.tiles.length - 1}
                  onClick={() => bumpTile(tile.id, i + 1)}
                  data-interactive
                >
                  <ChevronDown size={12} />
                </button>
                <button
                  type="button"
                  className="dock-cfg-chip-btn is-remove"
                  aria-label={`${tr("移除")} ${name}`}
                  onClick={() => removeTile(tile.id)}
                  data-interactive
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <div className="dock-cfg-add" ref={addRef}>
            <button
              type="button"
              className={`dock-cfg-chip dock-cfg-add-btn${addOpen ? " is-on" : ""}`}
              aria-label={tr("添加磁贴")}
              aria-haspopup="menu"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
              data-interactive
            >
              <Plus size={13} />
            </button>
            {addKeep && (
              <div
                className={`dock-cfg-add-menu${addOpen ? "" : " is-closing"}`}
                role="menu"
                aria-label={tr("添加磁贴")}
                data-interactive
              >
                {/* hidden 内部类型（贴图）不进添加菜单。 */}
                {WIDGET_REGISTRY.filter((meta) => !meta.hidden).map((meta) => {
                  const Icon = meta.icon;
                  // 入岛去重（findDockTileConflict）：同类型无实例磁贴已在岛上 → 禁用，与图库入口一致。
                  const onIsland = !!findDockTileConflict(dock.tiles, { type: meta.type });
                  return (
                    <button
                      key={meta.type}
                      type="button"
                      role="menuitem"
                      className="dock-cfg-add-item"
                      disabled={onIsland}
                      aria-disabled={onIsland}
                      title={onIsland ? tr("已在灵动岛") : undefined}
                      onClick={() => {
                        addDockTile(createDockTileAutoBound(meta.type));
                        setAddOpen(false);
                      }}
                      data-interactive
                    >
                      <Icon size={13} />
                      <span>{tr(meta.name)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
