/**
 * 编组容器卡片（DeskOrder 借鉴 #12，v1）：把多个小组件装进一个带标签条
 * 的容器，标签点击切换显示成员（切换走 store.switchGroupTab，跨窗口同步）。
 *
 * 渲染复用 registry 的画布组件（WidgetErrorBoundary + Suspense 同 WidgetCard），
 * 几何由 WidgetGroup 独立持有；编辑模式拖标题条移动整组（吸附网格），右键
 * 菜单：解散编组 / 移除当前成员 / 删除整组。
 *
 * 点击穿透：标签条按钮与成员内容的可交互元素各自上报（SELECTOR 命中
 * button/[data-interactive]）；容器壳的空白区域保持穿透，与卡片不同（v1
 * 有意为之，避免整套 .widget-card 命中逻辑与置顶事件的纠缠）。
 */
import { memo, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Layers, Trash2, X } from "lucide-react";
import { openContextMenu } from "../components/ContextMenu";
import { useT } from "../i18n-lite";
import { pickSpatialEase, prefersReducedMotion } from "../lib/anim";
import { getWidgetMeta } from "./registry";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";
import { useWidgetStore, GRID } from "./widget-store";
import { GroupBloom, BLOOM_HOVER_INTENT_MS, BLOOM_LEAVE_GRACE_MS, type BloomAnchor } from "./GroupBloom";

const TAB_H = 30;

function GroupCardBase({ group }: { group: import("./widget-groups").WidgetGroup }) {
  const tr = useT();
  // F1（重渲纪律）：订阅原始 instances 数组（引用稳定）+ useMemo 过滤，不把
  // filter 结果直接放 selector——zustand 以 Object.is 比较 selector 返回值，
  // 每次返回新数组会让本组件在 store 任何写入（含画布拖拽每帧的瞬态 set）时
  // 都重渲。与 WidgetCard 的派生标量订阅同一条纪律。
  const allInstances = useWidgetStore((s) => s.instances);
  const memberInstances = useMemo(() => allInstances.filter((i) => i.groupId === group.id), [allInstances, group.id]);
  const switchTab = useWidgetStore((s) => s.switchGroupTab);
  const disband = useWidgetStore((s) => s.disbandGroup);
  const removeMember = useWidgetStore((s) => s.removeGroupMember);
  const removeGroup = useWidgetStore((s) => s.removeGroup);
  const updateGroup = useWidgetStore((s) => s.updateGroup);
  const bringToFront = useWidgetStore((s) => s.bringGroupToFront);
  const editMode = useWidgetStore((s) => s.editMode);

  // memberIds 顺序为准（sanitize 已保证全部存在）。
  const members = group.memberIds
    .map((id) => memberInstances.find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i);
  const active = members.find((m) => m.id === group.activeId) ?? members[0];
  const meta = active ? getWidgetMeta(active.type) : null;
  const Content = meta?.component;

  /* ---- 编辑模式拖标题条移动整组（吸附网格；拖拽期局部 state，松手提交）。 ---- */
  const rootRef = useRef<HTMLDivElement>(null);
  /* 二.4 rAF 合帧 + transform 直写（对齐 WidgetCard 拖拽范式）：此前逐
     pointermove 事件 setState，以指针回报率（125–1000Hz）重渲整组——含成员
     小组件的内容树。拖拽位移不进 React，松手提交一次几何。 */
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    ox: number;
    oy: number;
    dx: number;
    dy: number;
    raf: number;
  } | null>(null);
  const onHeadDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editMode || e.button !== 0) return;
    e.stopPropagation();
    /* 打断尚未播完的吸附回弹（transition/transform 内联残留会让新一轮拖拽滞后）。 */
    const el = rootRef.current;
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      ox: group.x,
      oy: group.y,
      dx: 0,
      dy: 0,
      raf: 0
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.dx = e.clientX - d.startX;
    d.dy = e.clientY - d.startY;
    if (d.raf) return;
    d.raf = window.requestAnimationFrame(() => {
      d.raf = 0;
      const el = rootRef.current;
      if (el) el.style.transform = `translate3d(${d.dx}px, ${d.dy}px, 0)`;
    });
  };
  const onHeadUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    if (d.raf) window.cancelAnimationFrame(d.raf);
    const followX = d.ox + e.clientX - d.startX;
    const followY = d.oy + e.clientY - d.startY;
    const nx = snap(followX);
    const ny = snap(followY);
    if (nx !== group.x || ny !== group.y) updateGroup(group.id, { x: nx, y: ny });
    /* 吸附回弹（FLIP 落位，同 DockShell.animatePlacement 语言）：松手时组停在
       跟手位置，提交吸附后把差值写为起始 transform 过渡回 0——此前 setDrag(null)
       与 updateGroup 同帧执行，位置从跟手终态瞬跳到网格点。回弹 transform 与
       拖拽跟随同属瞬时交互态，不违反画布入场动画禁 transform 的 G-4 纪律。 */
    const dx = followX - nx;
    const dy = followY - ny;
    const el = rootRef.current;
    if (!el || prefersReducedMotion() || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) {
      /* 不播回弹也要摘掉拖拽期的内联 transform：旧实现靠 setDrag(null) 走
         React 清理，直写后必须手动复位（否则 reduce-motion 下组永久位移）。 */
      if (el) {
        el.style.transition = "";
        el.style.transform = "";
      }
      return;
    }
    const { ease, durMs } = pickSpatialEase(Math.max(Math.abs(dx), Math.abs(dy)));
    el.style.transition = "none";
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    void el.getBoundingClientRect();
    window.requestAnimationFrame(() => {
      el.style.transition = `transform ${durMs}ms ${ease}`;
      el.style.transform = "translate3d(0px, 0px, 0)";
      window.setTimeout(() => {
        el.style.transition = "";
        el.style.transform = "";
      }, durMs + 60);
    });
  };
  const onHeadCancel = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.raf) window.cancelAnimationFrame(d.raf);
    const el = rootRef.current;
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
  };

  /* ---- BentoDesk 借鉴 #3：花瓣预览——非编辑模式悬停标签条 300ms 弹出成员
          一览（点击直达）；组与花瓣双双离开 200ms 后收回。编辑模式不弹
          （拖标题条移动会误触）。 ---- */
  const tabsRef = useRef<HTMLDivElement>(null);
  const intentTimer = useRef(0);
  const leaveTimer = useRef(0);
  const [bloomAnchor, setBloomAnchor] = useState<BloomAnchor | null>(null);
  useEffect(
    () => () => {
      window.clearTimeout(intentTimer.current);
      window.clearTimeout(leaveTimer.current);
    },
    []
  );
  const armOpen = () => {
    if (editMode || members.length < 2) return;
    window.clearTimeout(leaveTimer.current);
    if (bloomAnchor) return;
    window.clearTimeout(intentTimer.current);
    intentTimer.current = window.setTimeout(() => {
      const r = tabsRef.current?.getBoundingClientRect();
      if (r) setBloomAnchor({ left: r.left, top: r.top, width: r.width, bottom: r.bottom });
    }, BLOOM_HOVER_INTENT_MS);
  };
  const armClose = () => {
    if (editMode) {
      setBloomAnchor(null);
      return;
    }
    window.clearTimeout(intentTimer.current);
    leaveTimer.current = window.setTimeout(() => setBloomAnchor(null), BLOOM_LEAVE_GRACE_MS);
  };
  const keepOpen = () => window.clearTimeout(leaveTimer.current);

  const onMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, [
      { label: tr("解散编组"), icon: <Layers size={15} />, onSelect: () => disband(group.id) },
      ...(active
        ? [
            {
              label: `${tr("移除成员：")}${displayName(active, tr)}`,
              icon: <X size={15} />,
              onSelect: () => removeMember(group.id, active.id)
            }
          ]
        : []),
      { type: "separator" as const },
      { label: tr("删除整组"), icon: <Trash2 size={15} />, danger: true, onSelect: () => removeGroup(group.id) }
    ]);
  };

  if (!active || !Content) return null;

  return (
    <div
      ref={rootRef}
      className={`widget-group${editMode ? " editing" : ""}`}
      style={{
        left: group.x,
        top: group.y,
        width: group.w,
        height: group.h,
        zIndex: group.z
      }}
      onContextMenu={onMenu}
    >
      <div
        ref={tabsRef}
        className="widget-group-tabs"
        style={{ height: TAB_H }}
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadCancel}
        onDoubleClick={() => bringToFront(group.id)}
        onPointerEnter={armOpen}
        onPointerLeave={armClose}
        data-interactive
      >
        {members.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`widget-group-tab${m.id === active.id ? " active" : ""}`}
            onClick={() => {
              switchTab(group.id, m.id);
              bringToFront(group.id);
            }}
            title={displayName(m, tr)}
            data-interactive
          >
            <span className="widget-group-tab-name">{displayName(m, tr)}</span>
          </button>
        ))}
      </div>
      <div className="widget-group-body">
        <WidgetErrorBoundary instanceId={active.id} type={active.type}>
          {/* key=激活成员：切 tab 重挂播纯 opacity 淡入（桌面透明画布禁 transform，
              G-4 纪律），成员内容不再硬切。 */}
          <div className="widget-group-body-swap" key={active.id}>
            <Suspense fallback={<div className="widget-skeleton" aria-busy="true" />}>
              <Content instanceId={active.id} />
            </Suspense>
          </div>
        </WidgetErrorBoundary>
      </div>
      {bloomAnchor && (
        <GroupBloom
          members={members.map((m) => ({ id: m.id, type: m.type, name: displayName(m, tr) }))}
          activeId={active.id}
          anchor={bloomAnchor}
          onSelect={(id) => {
            switchTab(group.id, id);
            bringToFront(group.id);
          }}
          onClose={() => setBloomAnchor(null)}
          onHoverEnter={keepOpen}
          onHoverLeave={armClose}
        />
      )}
    </div>
  );
}

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

/** memo：props 仅 group 单引用——框选逐帧 setState、参考线变化、透明度滑条等
 *  画布级重渲不再波及每个组卡（含 GroupBloom 子树），组结构变化才失效。
 *  与 WidgetCard 的 memo 同一纪律（此前二者不对称）。 */
export const GroupCard = memo(GroupCardBase);

function displayName(m: { type: string }, tr: (s: string) => string): string {
  const meta = getWidgetMeta(m.type);
  return meta ? tr(String(meta.name)) : m.type;
}
