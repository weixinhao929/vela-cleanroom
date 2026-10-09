/**
 * 编组配置弹层（「配置在上下文中」的组级版；组织形式对齐灵动岛配置面板）：
 *  - 组级：透明度滑条（作用于容器壳背景；全局 × 组 × 成员逐级相乘）
 *  - 成员（下一级）：行可下级展开——展开后是成员自身设置（透明度 / 鼠标穿透 /
 *    「配置此小组件」就地弹层入口），写实例、解散后仍随卡片生效
 *  - 底部：解散编组 / 删除整组（与右键菜单同动作）
 *
 * 复用 wcfg-popover 壳与样式（打开期间视口整体可交互，见 useClickThrough
 * OVERLAY_SELECTOR）、placePopover 定位数学（zoom 感知）与单例互斥事件；
 * 由 GroupCard 懒加载（M3Slider → motion 引擎只在本面板打开时进内存）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, ChevronUp, Layers, Pencil, Plus, Trash2, X } from "lucide-react";
import { useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useDismissable } from "../lib/use-dismissable";
import { useFocusReturn } from "../lib/use-focus-return";
import { useT } from "../i18n-lite";
import { pushAppToast } from "../components/ToastHost";
import { confirmDialog } from "../components/PromptDialog";
import { M3Slider as Slider } from "../components/ui/M3Slider";
import { Toggle } from "../components/ui/controls";
import { getWidgetMeta } from "./registry";
import { widgetDisplayName } from "./display-name";
import { promptRenameGroup, promptRenameInstance } from "./rename";
import { useWidgetStore } from "./widget-store";
import {
  openGroupSettingsPage,
  placePopover,
  nextWcfgToken,
  WCFG_OPEN_EVENT,
  type PopoverAnchor
} from "./WidgetConfigPopover";
import "../styles/feature-widget-config.css";

type Placement = ReturnType<typeof placePopover>;

export function GroupConfigPanel({
  groupId,
  anchor,
  open,
  onClose,
  onOpenMemberConfig
}: {
  groupId: string;
  /** 锚定矩形（组几何，画布布局坐标）。open 翻真时取一次快照。 */
  anchor: PopoverAnchor;
  open: boolean;
  onClose: () => void;
  /** 在面板外打开某成员的就地配置弹层（由 GroupCard 承载，避免互斥关闭连坐）。 */
  onOpenMemberConfig?: (memberId: string, widgetType: string) => void;
}) {
  const tr = useT();
  /* 退场：关闭后保留一拍播 .is-closing 缩放淡出再卸载。 */
  const visible = useDelayedUnmount(open, animDurations().fxFastMs);
  const closing = !open && visible;
  /* 关闭归还焦点：打开时记录触发元素（右键「配置」等），关闭（Esc /
     外点 / 互斥连坐）即归还——此前焦点跌落 body，键盘用户需重新 Tab 定位。
     打开时焦点主动进入面板（rAF 落焦面板根，见下方 effect），
     Tab 进面板内部后关闭时的归还因此更加必要。 */
  useFocusReturn(open);
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<PopoverAnchor>(anchor);
  const tokenRef = useRef(0);
  const [pos, setPos] = useState<Placement | null>(null);

  const group = useWidgetStore((s) => s.groups.find((g) => g.id === groupId));
  const allInstances = useWidgetStore((s) => s.instances);
  const previewOpacity = useWidgetStore((s) =>
    s.opacityPreview && s.opacityPreview.id === groupId ? s.opacityPreview.value : null
  );
  const opacity = previewOpacity ?? group?.opacity ?? 1;
  /* 下级展开：单开一个成员的设置区。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /* 组被解散/删除（含面板内摘到只剩 <2 人）：面板随之关闭。 */
  useEffect(() => {
    if (open && !group) onClose();
  }, [open, group, onClose]);

  /* open 翻真：快照锚点、广播单例令牌（与卡片配置弹层互斥）。 */
  useEffect(() => {
    if (!open) return;
    anchorRef.current = anchor;
    /* 令牌改取全局单源自增 nextWcfgToken（与卡片配置弹层同源；
     此前用 Date.now()，毫秒精度下同毫秒连开会撞令牌，互斥漏关——
     见 WidgetConfigPopover.tsx 的单源说明）。 */
    tokenRef.current = nextWcfgToken();
    window.dispatchEvent(new CustomEvent<number>(WCFG_OPEN_EVENT, { detail: tokenRef.current }));
    // anchor 仅在打开瞬间取快照；后续变化不重定位。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* 单例互斥：卡片配置弹层或别的编组面板打开时自动关闭。 */
  useEffect(() => {
    if (!open) return;
    const onOther = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== tokenRef.current) onClose();
    };
    window.addEventListener(WCFG_OPEN_EVENT, onOther);
    return () => window.removeEventListener(WCFG_OPEN_EVENT, onOther);
  }, [open, onClose]);

  /* 透明度拖动会话的了结从「卸载」改挂
     「visible 翻假」——面板常驻挂载，关闭只把 visible 翻假（退场窗后返回
     null）而不卸载；按住滑条超过退场窗松手时 WakeSlider 已随 DOM 移除、
     onCommitEnd 永不触发，瞬态 opacityPreview 残留。退场窗结束即按预览值
     落盘（等效完成提交），只碰本面板管辖的 id（组级 + 成员级，归属判定
     保留）；卸载兜底保留（覆盖面板整体拆除的路径）。 */
  const commitOpacityPreview = useCallback(() => {
    const st = useWidgetStore.getState();
    const pv = st.opacityPreview;
    if (!pv) return;
    if (pv.id === groupId) {
      st.setOpacityPreview(null);
      st.updateGroup(groupId, { opacity: pv.value });
    } else {
      const g = st.groups.find((x) => x.id === groupId);
      if (g?.memberIds?.includes(pv.id)) {
        st.setOpacityPreview(null);
        st.updateWidget(pv.id, { opacity: pv.value });
      }
    }
  }, [groupId]);
  useEffect(() => {
    if (!visible) commitOpacityPreview();
  }, [visible, commitOpacityPreview]);
  useEffect(() => () => commitOpacityPreview(), [commitOpacityPreview]);

  /* 定位：渲染后量实际尺寸（绘制前完成，无闪动）。三个量同为布局单位——
     锚点是组几何（画布布局坐标）、el.offsetWidth 与 window.innerWidth 都是
     未缩放值（CSS zoom 下 fixed left/top 渲染再乘 zoom，不换算才能对准锚点；
     需要除 uiZoom 的是 gBCR/clientX 这类**视觉**坐标，见 ui-zoom.ts）。 */
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchorRef.current;
    setPos(placePopover(a, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }));
  }, []);
  useLayoutEffect(() => {
    if (visible) place();
  }, [visible, place]);
  useEffect(() => {
    if (!visible) return;
    const el = ref.current;
    if (!el) return;
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [visible, place]);

  /* 键盘：Esc 关闭（capture 拦截，不让画布编辑模式的 Esc 抢先）。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 分层关闭：右键菜单（ctx-menu）开着时第一下 Esc 只关菜单（Host 的
        // document 捕获处理器随后接手）；这里 stopPropagation 会拦掉它。
        if (document.querySelector(".ctx-menu")) return;
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  /* 打开即把焦点移入面板（键盘用户不必从触发元素一路 Tab 过来）——
     与实例弹层（WidgetConfigPopoverInner）同款。 */
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  /* Tab 焦点陷阱——在面板内循环，不逃逸到背后的画布（同 Inner）。 */
  useEffect(() => {
    if (!open) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current) return;
      const focusables = Array.from(
        ref.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const ae = document.activeElement;
      if (e.shiftKey && (ae === first || !ref.current.contains(ae))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (ae === last || !ref.current.contains(ae))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, [open]);

  /* 外点关闭（统一骨架）。Esc 由上方 effect 处理。 */
  useDismissable(open, ref, onClose, { escape: false });

  /** 重命名标签：收口到共享 promptRenameInstance（与 GroupCard 双击/右键、
   *  设置页同一实现——含撤销 toast 与码点截断；留空恢复默认名）。 */
  const renameMember = useCallback(
    async (memberId: string) => {
      await promptRenameInstance(memberId, tr);
    },
    [tr]
  );

  if (!visible || !group) return null;

  const members = group.memberIds
    .map((id) => allInstances.find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i);

  /* 面板与设置页对等——成员重排（上移/下移，与桌面拖标签同一
     reorderGroupMembers 写入）与添加成员（当前视图未编组实例并入）。 */
  const moveMember = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= members.length) return;
    const next = [...group.memberIds];
    [next[idx], next[j]] = [next[j], next[idx]];
    useWidgetStore.getState().reorderGroupMembers(groupId, next);
  };
  const ungrouped = allInstances.filter((i) => !i.groupId);

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, transformOrigin: pos.below ? "top center" : "bottom center" }
    : { left: -9999, top: -9999 };

  return createPortal(
    <div
      ref={ref}
      className={`wcfg-popover group-cfg${closing ? " is-closing" : ""}${pos?.below ? " is-below" : ""}`}
      role="dialog"
      aria-label={group.name?.trim() || tr("编组配置")}
      tabIndex={-1}
      data-interactive
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="wcfg-header">
        {/* 标题带组名（未命名回落「编组配置」），与侧栏/设置页同源。 */}
        <span className="wcfg-title">{group.name?.trim() || tr("编组配置")}</span>
        <button type="button" className="wcfg-close" onClick={onClose} aria-label={tr("关闭")} data-interactive>
          <X size={13} />
        </button>
      </div>
      <div className="wcfg-body">
        {/* 组名行（与设置页同入口，改名 + 撤销）。 */}
        <div className="wcfg-row">
          <span className="wcfg-label">{tr("组名")}</span>
          <span className="wcfg-control">
            <button
              type="button"
              className="wcfg-mini-btn"
              onClick={() => void promptRenameGroup(groupId, tr)}
              data-interactive
            >
              {group.name?.trim() || tr("重命名")}
            </button>
          </span>
        </div>
        <div className="wcfg-row">
          <span className="wcfg-label">{tr("透明度")}</span>
          <span className="wcfg-control">
            <Slider
              label={tr("透明度")}
              value={Math.round(opacity * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              onChange={(v) => useWidgetStore.getState().setOpacityPreview({ id: groupId, value: v / 100 })}
              onCommitEnd={() => {
                const st = useWidgetStore.getState();
                const pv = st.opacityPreview;
                st.setOpacityPreview(null);
                if (pv && pv.id === groupId) st.updateGroup(groupId, { opacity: pv.value });
              }}
            />
          </span>
        </div>
        <div className="wcfg-divider" role="separator" />
        <div className="wcfg-row wcfg-row-stack">
          <span className="wcfg-label">
            {tr("成员")} · {members.length}
          </span>
          <div className="group-cfg-members">
            {members.map((m, idx) => {
              const Icon = getWidgetMeta(m.type)?.icon;
              const active = m.id === group.activeId;
              const expanded = expandedId === m.id;
              return (
                <div key={m.id} className="group-cfg-member-wrap">
                  <div
                    className={`group-cfg-member${active ? " active" : ""}${expanded ? " expanded" : ""}`}
                    role="button"
                    tabIndex={0}
                    data-interactive
                    onClick={() => {
                      useWidgetStore.getState().switchGroupTab(groupId, m.id);
                      useWidgetStore.getState().bringGroupToFront(groupId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        useWidgetStore.getState().switchGroupTab(groupId, m.id);
                        useWidgetStore.getState().bringGroupToFront(groupId);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="group-cfg-member-expander"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedId(expanded ? null : m.id);
                      }}
                      aria-expanded={expanded}
                      aria-label={`${widgetDisplayName(m.type, m.id, allInstances, tr)} ${tr("设置")}`}
                      title={tr("展开成员设置")}
                      data-interactive
                    >
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <span className="group-cfg-member-ico">{Icon ? <Icon size={14} /> : null}</span>
                    <span className="group-cfg-member-name">{widgetDisplayName(m.type, m.id, allInstances, tr)}</span>
                    {active && <span className="group-cfg-member-badge">{tr("显示中")}</span>}
                    {/* 重排（上移/下移）——设置页同款，边界禁用。 */}
                    <button
                      type="button"
                      className="wcfg-zone-remove"
                      disabled={idx === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveMember(idx, -1);
                      }}
                      aria-label={tr("上移")}
                      title={tr("上移")}
                      data-interactive
                    >
                      <ChevronUp size={11} />
                    </button>
                    <button
                      type="button"
                      className="wcfg-zone-remove"
                      disabled={idx === members.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveMember(idx, 1);
                      }}
                      aria-label={tr("下移")}
                      title={tr("下移")}
                      data-interactive
                    >
                      <ChevronDown size={11} />
                    </button>
                    <button
                      type="button"
                      className="wcfg-zone-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        void renameMember(m.id);
                      }}
                      aria-label={tr("重命名标签")}
                      title={tr("重命名标签")}
                      data-interactive
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      type="button"
                      className="wcfg-zone-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        useWidgetStore.getState().removeGroupMember(groupId, m.id);
                      }}
                      aria-label={tr("移除成员：{name}", { name: widgetDisplayName(m.type, m.id, allInstances, tr) })}
                      title={tr("移出编组")}
                      data-interactive
                    >
                      <X size={11} />
                    </button>
                  </div>
                  {/* 下一级：成员自身设置（组 × 成员逐级相乘；写实例，解散后仍在）。 */}
                  {expanded && (
                    <div className="group-cfg-member-sub">
                      <div className="wcfg-row">
                        <span className="wcfg-label">{tr("透明度")}</span>
                        <span className="wcfg-control">
                          <MemberOpacityRow instanceId={m.id} />
                        </span>
                      </div>
                      <div className="wcfg-row">
                        <span className="wcfg-label">{tr("鼠标穿透")}</span>
                        <span className="wcfg-control">
                          <Toggle
                            on={m.clickThrough === true}
                            onChange={(v) => useWidgetStore.getState().updateWidget(m.id, { clickThrough: v })}
                            ariaLabel={tr("鼠标穿透")}
                          />
                        </span>
                      </div>
                      {onOpenMemberConfig && (
                        <button
                          type="button"
                          className="wcfg-mini-btn group-cfg-member-more"
                          onClick={() => onOpenMemberConfig(m.id, m.type)}
                          data-interactive
                        >
                          {tr("配置此小组件")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* 添加成员——当前视图未编组实例一键并入（与设置页同入口；此前
            面板只能移除，加入只能靠桌面拖拽）。 */}
        <div className="wcfg-row wcfg-row-stack">
          <span className="wcfg-label">{tr("添加成员")}</span>
          {ungrouped.length === 0 ? (
            <span className="group-cfg-add-empty">{tr("没有未编组的小组件可添加")}</span>
          ) : (
            <div className="group-cfg-add-chips">
              {ungrouped.map((u) => {
                const UIcon = getWidgetMeta(u.type)?.icon;
                return (
                  <button
                    key={u.id}
                    type="button"
                    className="wcfg-mini-btn group-cfg-add-chip"
                    title={widgetDisplayName(u.type, u.id, allInstances, tr)}
                    onClick={() => useWidgetStore.getState().mergeIntoGroup([u.id], { kind: "group", id: groupId })}
                    data-interactive
                  >
                    {UIcon ? <UIcon size={11} /> : <Plus size={11} />}
                    {widgetDisplayName(u.type, u.id, allInstances, tr)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="group-cfg-footer">
        <button
          type="button"
          className="wcfg-mini-btn group-cfg-more"
          onClick={() => {
            onClose();
            openGroupSettingsPage(groupId);
          }}
          data-interactive
        >
          <span>{tr("更多设置")}</span>
          <ChevronRight size={12} />
        </button>
        <button
          type="button"
          className="wcfg-mini-btn"
          onClick={() =>
            void (async () => {
              /* 两步确认（设置页同款文案）+ 撤销 toast：解散不可视觉预览，误触
               成本高；快照经 restoreGroup 原样重建（几何/层级/激活标签不丢）。 */
              const ok = await confirmDialog({
                title: tr("解散编组"),
                message: tr("解散后成员回到编组前的原位（不删除小组件）。确定继续？"),
                confirmLabel: tr("解散编组"),
                danger: true
              });
              if (!ok) return;
              const snap = useWidgetStore.getState().disbandGroup(groupId);
              onClose();
              if (!snap) return;
              pushAppToast(tr("已解散编组"), "", "info", {
                action: {
                  label: tr("撤销"),
                  run: () => useWidgetStore.getState().restoreGroup(snap)
                }
              });
            })()
          }
          data-interactive
        >
          <Layers size={12} /> {tr("解散编组")}
        </button>
        <button
          type="button"
          className="wcfg-mini-btn group-cfg-danger"
          onClick={() =>
            void (async () => {
              /* 摩擦对齐：删除整组（N 个组件进回收站）此前零确认，而更轻的
                 「解散编组」反而有两步确认——危险度更高的动作不该更轻易。 */
              const ok = await confirmDialog({
                title: tr("删除整组"),
                message: tr("将删除组内全部小组件并移入回收站（可撤销）。确定继续？"),
                confirmLabel: tr("删除整组"),
                danger: true
              });
              if (!ok) return;
              useWidgetStore.getState().removeGroup(groupId);
              onClose();
            })()
          }
          data-interactive
        >
          <Trash2 size={12} /> {tr("删除整组")}
        </button>
      </div>
    </div>,
    document.body
  );
}

/**
 * 成员级透明度（下一级）：预览/提交都写实例（与卡片配置弹层 InstanceRows 同
 * 协议）。组在编期间 GroupCard 会把该预览乘进组体的 --widget-bg-alpha，成员
 * 内容即时可见；解散后同一 opacity 继续作用于其卡片。
 */
function MemberOpacityRow({ instanceId }: { instanceId: string }) {
  const inst = useWidgetStore((s) => s.instances.find((i) => i.id === instanceId));
  const preview = useWidgetStore((s) =>
    s.opacityPreview && s.opacityPreview.id === instanceId ? s.opacityPreview.value : null
  );
  return (
    <Slider
      label="透明度"
      value={Math.round((preview ?? inst?.opacity ?? 1) * 100)}
      min={0}
      max={100}
      step={1}
      suffix="%"
      onChange={(v) => useWidgetStore.getState().setOpacityPreview({ id: instanceId, value: v / 100 })}
      onCommitEnd={() => {
        const st = useWidgetStore.getState();
        const pv = st.opacityPreview;
        st.setOpacityPreview(null);
        if (pv && pv.id === instanceId) st.updateWidget(instanceId, { opacity: pv.value });
      }}
    />
  );
}
