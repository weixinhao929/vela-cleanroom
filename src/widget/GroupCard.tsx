/**
 * 编组容器卡片：把多个小组件装进一个带标签条
 * 的容器，标签点击切换显示成员（切换走 store.switchGroupTab，跨窗口同步）。
 *
 * 渲染复用 registry 的画布组件（WidgetErrorBoundary + Suspense 同 WidgetCard），
 * 几何由 WidgetGroup 独立持有；编辑模式拖标题条移动整组（吸附网格），右键
 * 菜单：解散编组 / 移除当前成员 / 删除整组。
 *
 * 点击穿透：标签条按钮与成员内容的可交互元素各自上报（SELECTOR 命中
 * button/[data-interactive]）；容器壳的空白区域保持穿透，与卡片不同（v1
 * 有意为之，避免整套 .widget-card 命中逻辑与置顶事件的纠缠）。
 *
 * 标签拖拽（灵动岛 同款范式）：条内拖动 = 重排——幽灵芯片跟手、源标签
 * 压暗占位、其余标签实时让位（reorderShifts）+ 插入竖条预告落位，松手
 * flipReorder 落位一次提交；移出标签条 = 摘出该成员到落点——编辑 /
 * 非编辑模式都可用（非编辑模式靠 data-interactive 幽灵跟手保住窗口交互，
 * 手法同 DockTiles 拖拽幽灵），拖回条内自动切回重排。
 *
 * 编辑模式整组操纵（v3）：组体与标签条（含左端可见把手）按下即起整组拖拽
 * 会话（捕获打在按下最深元素上，成员控件点击语义不变），标签条空白区不再
 * 是唯一把手——标签铺满时照样能移动；8 向缩放手柄编辑模式显形（虚线轮廓 +
 * 实心角标），成员控件自己的 pointerdown 处理器（弹层/滑条等）照常优先。
 *
 * 对等补齐（v4）：拖拽 3px 启动阈值 + 托起态（变量位移 + scale + MAX_Z 抬升
 * + 拖起置顶）+ Esc 原位放回；右键补层级菜单（置顶/移到底层）；解散走两步
 * 确认 + 撤销 toast（restoreGroup 重建快照）；容器级动画（fly-in / pulse /
 * is-exiting / pos-anim）与卡片同语言；标签重排 FLIP、摘出落位脉冲。
 */
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowDownToLine, ArrowUpToLine, Copy, GripVertical, Layers, Pencil, Settings, Trash2, X } from "lucide-react";
import { openContextMenu } from "../components/ContextMenu";
import { confirmDialog } from "../components/PromptDialog";
import { pushAppToast } from "../components/ToastHost";
import { promptRenameGroup, promptRenameInstance } from "./rename";
import { isEditChromeTarget, isWidgetControlTarget } from "./edit-chrome";
import { useT } from "../i18n-lite";
import { flipReorder, pickSpatialEase, prefersReducedMotion } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { makeResettableLazy } from "../lib/make-resettable-lazy";
import { uiZoom } from "../lib/ui-zoom";
import { setWidgetsSyncSuspended } from "../lib/cross-window";
import { useSettingsStore } from "../store/settings-store";
import { getWidgetMeta, resetWidgetLazy } from "./registry";
import { widgetDisplayName } from "./display-name";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";
import { RESIZE_HANDLES } from "./resize-handles";
import { useWidgetStore, GRID, MAX_Z, markEntering, markPulse } from "./widget-store";
import { GROUP_MIN_SIZE, findMergeTargetAt } from "./widget-groups";
import { insertionBarX, reorderShifts } from "./dock/DockTiles";
import { insertionIndexAt } from "./dock/dock-logic";
import { computeAlignAdjust, ALIGN_THRESHOLD_PX } from "./align-guides";
import { GroupBloom, BLOOM_HOVER_INTENT_MS, BLOOM_LEAVE_GRACE_MS, type BloomAnchor } from "./GroupBloom";
import { WidgetConfigPopover } from "./WidgetConfigPopover";

/* 编组配置面板（同款就地弹层：组级透明度 + 成员下一级管理）懒加载：
   M3Slider → motion 引擎只有首次打开配置时才进内存。
   可重置 lazy——chunk 拉取失败后重开面板即重新 import（弹层无本地
   错误边界，失败沿画布冒泡；弃缓存让下一次打开自然重试）。 */
const GroupConfigPanel = makeResettableLazy(
  () => import("./GroupConfigPanel").then((m) => ({ default: m.GroupConfigPanel })),
  "GroupConfigPanel"
);

const TAB_H = 30;
/** 标签拖拽启动阈值：位移超过该值才算「拖动」（对齐 DockTiles/弹层拖拽）。 */
const TAB_DRAG_THRESHOLD = 4;
/** 整组拖拽启动阈值（对齐 WidgetCard DRAG_THRESHOLD_PX）：超过才算拖动，
    成员控件（滑条/弹层把手）上的微动与点击不触发托起、置顶与提交。 */
const GROUP_DRAG_THRESHOLD = 3;

/**
 * 标签拖拽会话（灵动岛 同款）：条内移动 = 重排——幽灵芯片跟手、源标签
 * 压暗占位、其余标签按 reorderShifts 实时让位 + 插入竖条预告，松手
 * flipReorder 落位 + reorderGroupMembers 一次提交；移出标签条 = 摘出（其余
 * 标签收拢让位、幽灵半透明），拖回条内再切回重排。几何快照（rects/others/
 * wrapLeft）在起拖时缓存，会话中不随滚动补正（同 DockTiles 冻结口径）。
 */
type TabDragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  memberId: string;
  memberName: string;
  mode: "reorder" | "extract";
  /** 起拖时 memberIds 快照：松手时组员若已被其它窗口改过则放弃提交。 */
  ids: string[];
  tabEl: HTMLButtonElement;
  ghost: HTMLDivElement | null;
  /* 起拖时缓存的标签矩形（视口坐标，含被拖者）与派生量。 */
  rects: { left: number; width: number }[];
  others: { left: number; width: number }[];
  from: number;
  to: number;
  outside: boolean;
  /** 一枚标签宽 + 间距（布局单位，让位位移用）。 */
  stride: number;
  /** 包裹层视口 left（插入竖条定位基准）。 */
  wrapLeft: number;
  lastX: number;
  lastY: number;
};

/** 整组拖拽会话（混合拖动）：自身组 + 随行的选中实例/组刚性平移，
 *  位移直写各元素 --drag-dx/--drag-dy（卡片/组根节点同变量名），松手按
 *  各自的表一次提交（实例 updateWidget / 组 updateGroup，id 同池）。 */
type GroupDragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  raf: number;
  engaged: boolean;
  cards: { id: string; x: number; y: number }[];
  groups: { id: string; x: number; y: number }[];
};

/** 会话涉及的全部 DOM 元素（卡片/组根节点；React 外查询，元素可能已卸载）。 */
function dragElementsOf(d: { cards: { id: string }[]; groups: { id: string }[] }): (HTMLElement | null)[] {
  return [
    ...d.cards.map((c) => document.querySelector<HTMLElement>(`[data-widget-id="${c.id}"]`)),
    ...d.groups.map((g) => document.querySelector<HTMLElement>(`[data-group-id="${g.id}"]`))
  ];
}

function GroupCardBase({ group }: { group: import("./widget-groups").WidgetGroup }) {
  const tr = useT();
  /* 原「整订 instances 引用 + useMemo 过滤」在
     zustand Object.is 语义下挡住了同引用写入，但任何实例变化（拖拽提交/
     改任意一张卡/置顶/回收站进出）都换数组引用 → 全部组卡重渲并重算过滤。
     改为 useShallow 的成员过滤订阅：selector 每次返回新数组，但浅比较按
     元素引用判等——成员对象走不可变更新，无关实例的变化浅相等不重渲；
     成员自身被编辑或成员增删才失效（与 WidgetCard 的「同类型成员签名」
     订阅同一条重渲纪律，的目标由浅比较而非引用稳定达成）。 */
  const memberInstances = useWidgetStore(useShallow((s) => s.instances.filter((i) => i.groupId === group.id)));
  /* 标签自动序号的同类型签名（WidgetCard.instanceIndex 同范式）——
     memberName 的自动名依赖「全表同类型实例的 id 有序序列」（跨组/自由实例
     也计数）与成员自身 label（已在成员对象里）。签名串只在同类型成员增删
     时变化；无关实例的移动/编辑不换串。 */
  const sameTypeSig = useWidgetStore((s) => {
    const types = new Set<string>();
    for (const i of s.instances) {
      if (i.groupId === group.id && !types.has(i.type)) types.add(i.type);
    }
    let sig = "";
    for (const i of s.instances) {
      if (types.has(i.type)) sig += `${i.type}:${i.id};`;
    }
    return sig;
  });
  const switchTab = useWidgetStore((s) => s.switchGroupTab);
  const removeMember = useWidgetStore((s) => s.removeGroupMember);
  const bringToFront = useWidgetStore((s) => s.bringGroupToFront);
  const sendToBack = useWidgetStore((s) => s.sendGroupToBack);
  const editMode = useWidgetStore((s) => s.editMode);
  const setEditMode = useWidgetStore((s) => s.setEditMode);
  /* D 节动画标记订阅（派生布尔，组 id 与实例 id 同池）：新建/撤销重建入场、
     并入/摘出/定位脉冲、退场、一次性 left/top 过渡（时间线恢复/视口回收）。 */
  const exiting = useWidgetStore((s) => s.exitingIds.includes(group.id));
  const entering = useWidgetStore((s) => s.enteringIds.includes(group.id));
  const pulsing = useWidgetStore((s) => s.pulseIds.includes(group.id));
  const posAnim = useWidgetStore((s) => s.posAnimIds.includes(group.id));
  /* 同类桌面整理工具 #2 拖拽合并投放目标：拖卡松手到本组上 = 并入本组，亮出提示环。 */
  const isMergeTarget = useWidgetStore((s) => s.mergeTargetId === group.id);
  /* 编辑模式选中态（派生布尔）：框选/Ctrl 点选可包含组，与卡片 .selected
     同语言（对齐根因：组此前在编辑模式完全不可选中）。 */
  const selected = useWidgetStore((s) => s.selectedId === group.id || s.selectedIds.includes(group.id));
  /* 组是主选中单元（selectedId）——此前键盘路径只挂在 WidgetCard 的主
     单元 handler 上，纯组选中（无卡片在选中集）时方向键/Delete/全哑。
     主单元唯一（卡或组只挂一处），moveSelectedBy 不会 ×2 触发。 */
  const primarySelected = useWidgetStore((s) => s.selectedId === group.id);
  /* 编辑模式 8 向缩放：瞬态 resizePreview 以组 id 为键（与卡片缩放同一闸门，
     拖拽期挂起跨窗同步、松手一次提交）。 */
  const resizeRect = useWidgetStore((s) =>
    s.resizePreview && s.resizePreview.id === group.id ? s.resizePreview : null
  );
  /* 全局不透明度驱动整窗透明度，组级 opacity 作为乘数（与卡片同式）；
     配置面板滑条拖动中的瞬态预览只读本组。 */
  const globalOpacity = useSettingsStore((s) => s.widgetOpacity);
  /* （重渲纪律）：组级透明度预览走派生标量订阅，不订阅整个
     opacityPreview 对象——原始引用订阅下，任一编组面板/成员弹层拖透明度
     滑条（预览逐帧写 store、每帧换对象引用）都会让全部编组卡一起重渲；
     只匹配本组 id 时无关预览期间 selector 输出恒为 null（Object.is 稳定），
     与 WidgetCard 的 previewOpacity 订阅同一条纪律。 */
  const previewOpacity = useWidgetStore((s) =>
    s.opacityPreview && s.opacityPreview.id === group.id ? s.opacityPreview.value : null
  );
  /* 编组配置弹层：右键「配置」打开（组级透明度 + 成员下一级管理）。 */
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgArmed, setCfgArmed] = useState(false);
  useEffect(() => {
    if (cfgOpen) setCfgArmed(true);
  }, [cfgOpen]);
  /* 进入编辑模式收起配置弹层（编辑手势与弹层外点语义冲突）——组级面板与
     成员下一级「配置此小组件」弹层都要收（后者开着会让整窗保持可交互，
     与编辑手势/拖拽抢事件；WidgetCard 对自己的弹层同款处理）。 */
  useEffect(() => {
    if (editMode) {
      setCfgOpen(false);
      setMemberCfgOpen(false);
    }
  }, [editMode]);
  /* 成员「配置此小组件」：面板外（本组件）承载成员的就地配置弹层——面板与
     成员弹层共用单例互斥事件，弹层若挂在面板内会被互斥关闭连坐卸载。 */
  const [memberCfg, setMemberCfg] = useState<{ id: string; type: string } | null>(null);
  const [memberCfgOpen, setMemberCfgOpen] = useState(false);
  const openMemberConfig = useCallback((memberId: string, widgetType: string) => {
    setCfgOpen(false);
    setMemberCfg({ id: memberId, type: widgetType });
    setMemberCfgOpen(true);
  }, []);

  // memberIds 顺序为准（sanitize 已保证全部存在）；标签拖拽重排会话期间用
  // 本地 override 预览新顺序，松手才提交 store。
  /* 标签拖拽态（只在离散变化时写 React——源标签压暗 + 插入竖条位置）；
     跟手位移、让位与幽灵全走命令式 DOM，逐指针事件不过 React。 */
  const [tabDrag, setTabDrag] = useState<{ id: string; mode: "reorder" | "extract"; barX: number | null } | null>(null);
  const orderedIds = group.memberIds;
  const members = orderedIds
    .map((id) => memberInstances.find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i);
  const active = members.find((m) => m.id === group.activeId) ?? members[0];
  const meta = active ? getWidgetMeta(active.type) : null;
  const Content = meta?.component;
  /* 成员下一级透明度：组级乘数同时作用于壳与内容（全局 × 组 × 成员逐级
     相乘）——滑条拖低时整组（含成员内容）一起变淡，与「组透明度」直觉一致
     （此前只淡壳背景，内容恒不透明读作「滑条坏了」）；面板滑条经
     opacityPreview（单值、按 id 匹配组或激活成员）即时预览。激活成员的
     预览同样是派生标量订阅：selector 闭包捕获 active.id，切标签后
     组件重渲即换新 selector，只精确订阅当前激活成员。 */
  const activePreviewOpacity = useWidgetStore((s) =>
    s.opacityPreview && active && s.opacityPreview.id === active.id ? s.opacityPreview.value : null
  );
  const groupAlpha = previewOpacity ?? group.opacity ?? 1;
  const activeMemberAlpha = (globalOpacity / 100) * groupAlpha * (activePreviewOpacity ?? active?.opacity ?? 1);

  /** 显示名：同类型 ≥2 实例时追加创建序号（与 WidgetCard 卡片标题同口径）。
      实例视图由同类型签名重建（有序 {id,type}，覆盖全表同类型成员），
      成员的 label 从成员对象补回——widgetDisplayName 的两个输入
      （find(id).label / 同类型计数与序号）分别闭合，渲染输出与整订全表时
      逐字节一致（含跨组/自由实例带来的序号）。 */
  const nameInstances = useMemo(() => {
    const labelById = new Map(memberInstances.map((i) => [i.id, i.label]));
    return sameTypeSig
      .split(";")
      .filter(Boolean)
      .map((token) => {
        const sep = token.indexOf(":");
        const id = token.slice(sep + 1);
        return { id, type: token.slice(0, sep), label: labelById.get(id) };
      });
  }, [memberInstances, sameTypeSig]);
  const memberName = (m: { id: string; type: string }) => widgetDisplayName(m.type, m.id, nameInstances, tr);

  /* ---- 编辑模式拖动整组（吸附网格 + 智能对齐 + 视口钳位；拖拽期局部
          state，松手提交）。混合拖动：选中集合里的实例与其它组随行刚性
          平移（与 WidgetCard 多选拖拽同一语言）。 ---- */
  const rootRef = useRef<HTMLDivElement>(null);
  /* 组卡卸载（解散/删除）时的焦点承接。用「焦点踪迹」判定焦点曾在
     卡内——卸载瞬间被聚焦的标签按钮已随 DOM 移除、activeElement 掉到
     body，cleanup 里直接查 root.contains(activeElement) 恒为假。承接目标
     选激活成员（用户正看着的标签），下一帧其新卡片挂载完成后再聚焦。 */
  const focusWithinRef = useRef(false);
  const activeMemberIdRef = useRef(active?.id ?? "");
  activeMemberIdRef.current = active?.id ?? "";
  useEffect(
    () => () => {
      if (!focusWithinRef.current || document.activeElement !== document.body) return;
      const target = activeMemberIdRef.current;
      if (!target) return;
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-widget-id="${target}"]`);
        /* 解散后成员卡片与组卡卸载同批提交，下一帧可查到；切视图/合并时目标
           卡片不存在，落空即静默。卡片仅编辑模式可聚焦（tabIndex 按模式门控），
           非编辑模式下 focus() 自然无效，不强抢。 */
        if (el) el.focus({ preventScroll: true });
      });
    },
    []
  );
  /* 组体悬停 dwell 置顶——卡片有 140ms hover-dwell 自动抬升，编组此前
     只有点标签条/拖拽/右键可置顶，被高 z 卡片压住大半时难以翻身。非编辑
     模式才触发（编辑模式有明确选中语义，不掺自动 z 写入）。 */
  const raiseTimerRef = useRef(0);
  const cancelRaise = useCallback(() => window.clearTimeout(raiseTimerRef.current), []);
  useEffect(() => cancelRaise, [cancelRaise]);
  /* 拖拽中的托起态（.dragging：变量位移 + scale(1.01) + 主色环 + 深投影，
     zIndex 抬到 MAX_Z+1 压过全部卡片/组——对齐 WidgetCard 拖拽语言）。 */
  const [dragging, setDragging] = useState(false);
  /* 二.4 rAF 合帧 + CSS 变量直写（对齐 WidgetCard 拖拽范式）：位移写
     --drag-dx/--drag-dy（合成器 transform，不重渲整组内容树），松手提交一次
     几何。GROUP_DRAG_THRESHOLD 前不算拖动（成员控件微动不打扰）。 */
  const dragRef = useRef<GroupDragSession | null>(null);
  const clearDragVars = (el: HTMLElement) => {
    el.style.removeProperty("--drag-dx");
    el.style.removeProperty("--drag-dy");
  };
  const onHeadDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editMode || e.button !== 0) return;
    e.stopPropagation();
    /* 组一等公民：编辑模式按下 = 卡片同款选中语义（Ctrl/Shift 翻转多选，
       反选取消则不起拖；否则未选中先单选）。标签按钮自带拖标签会话
       （onTabDown 已截停冒泡），覆盖到的是标签条空白/把手/组体三类起点。 */
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    const st0 = useWidgetStore.getState();
    if (multi) {
      st0.toggleSelect(group.id);
      if (!useWidgetStore.getState().selectedIds.includes(group.id)) return;
    } else if (!st0.selectedIds.includes(group.id)) {
      st0.selectWidget(group.id);
    }
    /* 打断尚未播完的吸附回弹（transition/transform/变量内联残留会让新一轮
       拖拽滞后或带旧位移起步）。 */
    const el = rootRef.current;
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
      clearDragVars(el);
    }
    const stNow = useWidgetStore.getState();
    const selSet = new Set(stNow.selectedIds);
    const cards = stNow.instances.filter((i) => selSet.has(i.id)).map((i) => ({ id: i.id, x: i.x, y: i.y }));
    const groups = stNow.groups.filter((g) => selSet.has(g.id)).map((g) => ({ id: g.id, x: g.x, y: g.y }));
    if (!groups.some((g) => g.id === group.id)) groups.push({ id: group.id, x: group.x, y: group.y });
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      ox: group.x,
      oy: group.y,
      dx: 0,
      dy: 0,
      raf: 0,
      engaged: false,
      cards,
      groups
    };
    /* 捕获打在按下最深元素上（同 WidgetCard onDragStart）：组体现在盖着成员
       交互内容，捕获到 currentTarget 会把随后的合成 click 改道到容器、成员
       控件收不到点击；捕获到 target 则点击语义不变，拖拽跟手经冒泡到根。 */
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.engaged) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < GROUP_DRAG_THRESHOLD) return;
      d.engaged = true;
      setDragging(true);
      /* 拖起置顶 + 挂起跨窗广播（对齐 WidgetCard onDragStart；本会话逐帧写
         参考线与投放目标，不能整包广播）。 */
      bringToFront(group.id);
      setWidgetsSyncSuspended(true);
    }
    if (d.raf) return;
    d.raf = window.requestAnimationFrame(() => {
      d.raf = 0;
      /* 指针位移是视觉坐标（含 uiZoom），组几何/--drag-dx 是布局单位——除回。 */
      const zoom = uiZoom();
      d.dx = (e.clientX - d.startX) / zoom;
      d.dy = (e.clientY - d.startY) / zoom;
      const st = useWidgetStore.getState();
      /* 智能对齐（与卡片拖拽同源纯函数）：主矩形 = 自身组，候选 = 未编组
         实例 ∪ 未随行组（随行者跟着走，不是吸附锚；编组成员坐标不代表视觉
         位置，本就不参与）。 */
      let nx = Math.max(0, snap(d.ox + d.dx));
      let ny = Math.max(0, snap(d.oy + d.dy));
      const draggingIds = new Set<string>([...d.cards.map((c) => c.id), ...d.groups.map((g) => g.id)]);
      const others: { x: number; y: number; w: number; h: number }[] = [
        ...st.instances.filter((i) => !i.groupId && !draggingIds.has(i.id)),
        ...st.groups.filter((g) => !draggingIds.has(g.id))
      ];
      const adj = computeAlignAdjust(nx, ny, group.w, group.h, others, ALIGN_THRESHOLD_PX);
      nx = adj.x;
      ny = adj.y;
      /* 视口钳位（与卡片拖拽同款 40px 抓边）：拖拽期间组不再整只出屏，
         松手不再需要大距离回弹。 */
      const maxX = Math.max(0, window.innerWidth - 40);
      const maxY = Math.max(0, window.innerHeight - 40);
      d.dx = Math.min(Math.max(0, nx), maxX) - d.ox;
      d.dy = Math.min(Math.max(0, ny), maxY) - d.oy;
      for (const el of dragElementsOf(d)) {
        if (!el) continue;
        el.style.setProperty("--drag-dx", `${d.dx}px`);
        el.style.setProperty("--drag-dy", `${d.dy}px`);
      }
      st.setAlignGuides(adj.guideXs, adj.guideYs);
      /* 组×组投放探测：指针（布局坐标）下 z 最高的非随行组 = 目标——提示环
         与松手判定同源（高亮即落点）；卡片不参与，组拖到卡上仍是移动语义。 */
      const px = e.clientX / zoom;
      const py = e.clientY / zoom;
      let probe: string | null = null;
      let probeZ = -Infinity;
      for (const g of st.groups) {
        if (draggingIds.has(g.id)) continue;
        if (px < g.x || px > g.x + g.w || py < g.y || py > g.y + g.h) continue;
        if (g.z > probeZ) {
          probeZ = g.z;
          probe = g.id;
        }
      }
      st.setMergeTargetId(probe);
    });
  };
  /** 收尾共核：清变量，把一组元素从当前跟手位 FLIP 回弹到 (tx,ty)（吸附差值
      或原位；对齐 WidgetCard / DockShell 吸附回弹语言，reduce-motion 直落）。 */
  const settleDrag = useCallback((pairs: { el: HTMLElement | null; tx: number; ty: number }[]) => {
    const reduce = prefersReducedMotion();
    for (const { el, tx, ty } of pairs) {
      if (!el) continue;
      clearDragVars(el);
      if (reduce || (Math.abs(tx) < 1 && Math.abs(ty) < 1)) {
        el.style.transition = "";
        el.style.transform = "";
        continue;
      }
      const { ease, durMs } = pickSpatialEase(Math.max(Math.abs(tx), Math.abs(ty)));
      el.style.transition = "none";
      el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
      void el.getBoundingClientRect();
      window.requestAnimationFrame(() => {
        el.style.transition = `transform ${durMs}ms ${ease}`;
        el.style.transform = "translate3d(0px, 0px, 0)";
        window.setTimeout(() => {
          el.style.transition = "";
          el.style.transform = "";
        }, durMs + 60);
      });
    }
  }, []);
  const onHeadUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    if (d.raf) window.cancelAnimationFrame(d.raf);
    const st = useWidgetStore.getState();
    st.setAlignGuides([], []);
    const mergeTo = st.mergeTargetId;
    st.setMergeTargetId(null);
    /* 未过阈值的按压：无拖拽语义，清干净即返回（不置顶、不提交）。 */
    if (!d.engaged) {
      for (const el of dragElementsOf(d)) if (el) clearDragVars(el);
      return;
    }
    setDragging(false);
    setWidgetsSyncSuspended(false);
    if (e.type === "pointerup" && mergeTo && mergeTo !== group.id) {
      /* 组×组合并：位移不提交，随行元素弹回原位；源组 DOM 由 mergeGroups
         即刻移除，目标组脉冲确认吞并。 */
      const src = st.mergeGroups(group.id, mergeTo);
      settleDrag(dragElementsOf(d).map((el) => ({ el, tx: d.dx, ty: d.dy })));
      if (src) {
        pushAppToast(tr("已合并编组"), "", "info", {
          action: {
            label: tr("撤销"),
            run: () => {
              const s = useWidgetStore.getState();
              for (const id of src.memberIds) s.removeGroupMember(mergeTo, id, { feedback: false });
              s.restoreGroup(src);
            }
          }
        });
      }
      return;
    }
    /* 常规提交：整组（含随行卡片/组）按吸附 + 钳位后的位移一次落位
       （updateWidget/updateGroup 内部再钳视口，位移为 0 的项是 no-op 写）。 */
    for (const c of d.cards) st.updateWidget(c.id, { x: c.x + d.dx, y: c.y + d.dy });
    for (const g of d.groups) st.updateGroup(g.id, { x: g.x + d.dx, y: g.y + d.dy });
    /* 回弹差值以提交后的实际值为准（钳位与吸附值不一致时弹回而非瞬跳）。 */
    const after = useWidgetStore.getState();
    const settlePairs = [
      ...d.cards.map((c) => {
        const a = after.instances.find((i) => i.id === c.id);
        return {
          el: document.querySelector<HTMLElement>(`[data-widget-id="${c.id}"]`),
          tx: c.x + d.dx - (a?.x ?? c.x + d.dx),
          ty: c.y + d.dy - (a?.y ?? c.y + d.dy)
        };
      }),
      ...d.groups.map((g) => {
        const a = after.groups.find((x) => x.id === g.id);
        return {
          el: document.querySelector<HTMLElement>(`[data-group-id="${g.id}"]`),
          tx: g.x + d.dx - (a?.x ?? g.x + d.dx),
          ty: g.y + d.dy - (a?.y ?? g.y + d.dy)
        };
      })
    ];
    settleDrag(settlePairs);
  };
  /** Esc = 原位放回（对齐 WidgetCard cancelDrag 语义）：不提交位移，FLIP 弹回；
      参考线与投放目标是本会话逐帧写入的瞬态，一并清空。 */
  const cancelDrag = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.raf) window.cancelAnimationFrame(d.raf);
    const st = useWidgetStore.getState();
    st.setAlignGuides([], []);
    st.setMergeTargetId(null);
    if (!d.engaged) {
      for (const el of dragElementsOf(d)) if (el) clearDragVars(el);
      return;
    }
    setDragging(false);
    setWidgetsSyncSuspended(false);
    settleDrag(dragElementsOf(d).map((el) => ({ el, tx: d.dx, ty: d.dy })));
  }, [settleDrag]);
  const onHeadCancel = () => cancelDrag();
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragRef.current?.engaged) return;
      e.stopPropagation();
      e.preventDefault();
      cancelDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, cancelDrag]);
  /* 主选中组的键盘路径（与 WidgetCard 同款守卫：输入控件/修饰键/编辑铬件
     忽略——焦点在工具栏/弹层上时按键不得作用到画布层，判定见 edit-chrome.ts）。
     moveSelectedBy/removeSelectionAnimated 本就覆盖混装集合，这里只是
     把「组当主单元」时的触发入口补上。 */
  useEffect(() => {
    if (!editMode || !primarySelected) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isEditChromeTarget(target) || isWidgetControlTarget(target)) return;
      const arrows: Record<string, [number, number]> = {
        ArrowUp: [0, -GRID],
        ArrowDown: [0, GRID],
        ArrowLeft: [-GRID, 0],
        ArrowRight: [GRID, 0]
      };
      const delta = arrows[e.key];
      if (delta) {
        e.preventDefault();
        useWidgetStore.getState().moveSelectedBy(delta[0], delta[1]);
      } else if (e.key === "Delete") {
        e.preventDefault();
        useWidgetStore.getState().removeSelectionAnimated();
      } else if (e.key === "F2") {
        e.preventDefault();
        void promptRenameGroup(group.id, tr);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, primarySelected, group.id, tr]);
  /* 卸载兜底：在途会话的变量/挂起闸残留不能带到下一次挂载（切视图/删组等）。 */
  useEffect(
    () => () => {
      const d = dragRef.current;
      if (d) {
        dragRef.current = null;
        if (d.raf) window.cancelAnimationFrame(d.raf);
        if (d.engaged) {
          setWidgetsSyncSuspended(false);
          /* 拖拽中切视图（Ctrl+1/2/3）卸载本组时，
             画布瞬态同样要就地复位——Esc 监听已随组件消失，残留的对齐
             参考线/合并提示环会挂到下一次拖拽（与 pointerup 路径的复位
             对齐）。 */
          const st = useWidgetStore.getState();
          st.setMergeTargetId(null);
          st.setAlignGuides([], []);
        }
        for (const el of dragElementsOf(d)) if (el) clearDragVars(el);
      }
      const el = rootRef.current;
      if (el) clearDragVars(el);
    },
    []
  );

  /* ---- 编辑模式 8 向缩放整组（与 WidgetCard 缩放同范式）：位移瞬态写
          resizePreview（组 id 为键、挂起跨窗同步），松手一次提交几何；
          只改容器 w/h（含 n/w 边连带 x/y），成员坐标不动（编组是渲染态）。 ---- */
  const resizeRef = useRef<{
    handle: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const resizeRaf = useRef(0);
  const onResizeStart = (handle: string, e: ReactPointerEvent) => {
    if (!editMode || e.button !== 0) return;
    e.stopPropagation();
    resizeRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origX: group.x,
      origY: group.y,
      origW: group.w,
      origH: group.h
    };
    setWidgetsSyncSuspended(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: ReactPointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    cancelAnimationFrame(resizeRaf.current);
    resizeRaf.current = requestAnimationFrame(() => {
      const session = resizeRef.current;
      if (!session) return;
      /* 同拖拽：视觉位移除回 uiZoom 再改布局几何。 */
      const zoom = uiZoom();
      const dx = (e.clientX - session.startX) / zoom;
      const dy = (e.clientY - session.startY) / zoom;
      const { handle, origX, origY, origW, origH } = session;
      let rawLeft = origX;
      let rawTop = origY;
      let rawRight = origX + origW;
      let rawBottom = origY + origH;
      if (handle.includes("e")) rawRight = origX + origW + dx;
      if (handle.includes("w")) rawLeft = origX + dx;
      if (handle.includes("s")) rawBottom = origY + origH + dy;
      if (handle.includes("n")) rawTop = origY + dy;
      const sLeft = Math.max(0, snap(rawLeft));
      const sRight = Math.max(snap(rawRight), sLeft);
      const sTop = Math.max(0, snap(rawTop));
      const sBottom = Math.max(snap(rawBottom), sTop);
      let newX = sLeft;
      let newY = sTop;
      let newW = sRight - sLeft;
      let newH = sBottom - sTop;
      if (newW < GROUP_MIN_SIZE.w) {
        if (handle.includes("w")) newX = sRight - GROUP_MIN_SIZE.w;
        newW = GROUP_MIN_SIZE.w;
      }
      if (newH < GROUP_MIN_SIZE.h) {
        if (handle.includes("n")) newY = sBottom - GROUP_MIN_SIZE.h;
        newH = GROUP_MIN_SIZE.h;
      }
      useWidgetStore.getState().setResizePreview({ id: group.id, x: newX, y: newY, w: newW, h: newH });
    });
  };
  const onResizeEnd = () => {
    cancelAnimationFrame(resizeRaf.current);
    resizeRef.current = null;
    setWidgetsSyncSuspended(false);
    const st = useWidgetStore.getState();
    const pv = st.resizePreview;
    st.setResizePreview(null);
    if (pv && pv.id === group.id) st.updateGroup(group.id, { x: pv.x, y: pv.y, w: pv.w, h: pv.h });
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(resizeRaf.current);
      // 卸载时正在缩放（切视图/组被解散等）：复位挂起闸与本组的瞬态预览。
      if (resizeRef.current) {
        resizeRef.current = null;
        setWidgetsSyncSuspended(false);
        const st = useWidgetStore.getState();
        if (st.resizePreview?.id === group.id) st.setResizePreview(null);
      }
    },
    [group.id]
  );

  /* 编辑模式中途退出（Esc / 跨窗 widget:edit-mode
     事件）时缩放手柄随 {editMode && ...} 条件卸载、pointer capture 静默丢失，
     resizeRef.current 与 setWidgetsSyncSuspended(true) 双双残留。editMode
     翻假即终结会话，走丢弃路径（清预览不 commitResize，回到 resize 前几何）：
     退出编辑视为放弃本次未确认的缩放，内容与上方卸载清理一致。 */
  useEffect(() => {
    if (editMode || !resizeRef.current) return;
    cancelAnimationFrame(resizeRaf.current);
    resizeRef.current = null;
    setWidgetsSyncSuspended(false);
    const st = useWidgetStore.getState();
    if (st.resizePreview?.id === group.id) st.setResizePreview(null);
  }, [editMode, group.id]);

  /* drag 半边的同款终结（只修了 resize）。整组
     拖拽的 pointer capture 打在「按下最深元素」上，而编辑模式的起拖起点
     （把手 span / 标签条空白 / 组体）随 editMode 翻假可能卸载——把手是
     {editMode && …} 条件挂载、全库唯一可作拖拽 capture 目标的此类元素，
     跨窗 widget:edit-mode(false) 广播把它拆掉后 capture 按 Pointer Events
     规范静默丢失 → 指针移出组子树后事件不再冒泡到组根 → onHeadUp 永不
     触发 → 会话残留：.dragging 卡死（组恒浮 MAX_Z+1 + 位移冻结）+
     setWidgetsSyncSuspended(true) 全局挂起（本窗此后所有布局编辑不再跨窗
     广播）。editMode 翻假即走与 Esc 同一套丢弃路径 cancelDrag（清 dragRef/
     rAF、复位挂起闸与拖起态、清参考线与投放目标、预览位移 FLIP 弹回；
     「已 set 未 engaged」的会话由其 !engaged 分支清变量收尾），退出编辑
     视为放弃本次未确认的位移。 */
  useEffect(() => {
    if (editMode || !dragRef.current) return;
    cancelDrag();
  }, [editMode, cancelDrag]);

  /* ---- 花瓣预览——非编辑模式悬停标签条 300ms 弹出成员
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
  const disarmBloom = () => {
    window.clearTimeout(intentTimer.current);
    window.clearTimeout(leaveTimer.current);
    setBloomAnchor(null);
  };
  const armOpen = () => {
    /* 配置弹层（组级或成员级）开着时不弹花瓣——两层弹层叠着，Esc 语义
       也会在两个 capture 监听间含混。 */
    if (editMode || cfgOpen || memberCfgOpen || members.length < 2 || tabDragRef.current) return;
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

  /* 标签重排 FLIP：顺序变化（成员增删 / 拖拽提交）时，先记各标签旧位置、DOM 更新后把位差写成起始 transform 再过渡回 0——
     重排是滑动让位而非瞬跳（与浏览器标签条同一手势语言）。 */
  const prevTabLefts = useRef<Map<string, number> | null>(null);
  /* 拖拽提交那一跳由 flipReorder 承载（First=幽灵跟手位）：跳过本 effect 一轮，
     避免两套 FLIP 同帧互写同一批内联 transform。 */
  const suppressTabFlipRef = useRef(false);
  const tabOrderKey = orderedIds.join("\n");
  /* 改名改变标签宽度——FLIP 基线与溢出渐隐都不能只看顺序：改名后宽度
     引起的位移若不进基线，下次增删成员时 FLIP 会按改名前的旧坐标起步
     （先跳回旧位再滑回）；溢出渐隐同样要在宽度变化时重算。
     键取**计算后的显示名**（memberName）而非原始 label——自动名也会变
     （同类型兄弟增删让「时钟 ↔ 时钟2」翻转、宽度变化），原始 label 键盖不住。 */
  const tabNamesKey = members.map((m) => memberName(m)).join("\n");
  useLayoutEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".widget-group-tab"));
    const next = new Map<string, number>();
    for (const t of tabs) next.set(t.dataset.tabId ?? "", t.offsetLeft);
    const prev = prevTabLefts.current;
    prevTabLefts.current = next;
    if (suppressTabFlipRef.current) {
      suppressTabFlipRef.current = false;
      return;
    }
    if (!prev || prefersReducedMotion()) return;
    const durMs = animDurations().fxFastMs;
    for (const t of tabs) {
      const id = t.dataset.tabId ?? "";
      const before = prev.get(id);
      const after = next.get(id);
      if (before === undefined || after === undefined || before === after) continue;
      t.style.transition = "none";
      t.style.transform = `translateX(${before - after}px)`;
      void t.offsetWidth;
      t.style.transition = `transform ${durMs}ms var(--ease-fx, ease)`;
      t.style.transform = "";
      window.setTimeout(() => {
        t.style.transition = "";
      }, durMs + 60);
    }
    // 依赖序列串而非数组引用：拖拽提交/成员增删/改名宽度变化才换键，
    // 引用无关的重渲不重播。
  }, [tabOrderKey, tabNamesKey]);

  /* 标签条溢出提示：成员多到溢出时左右缘渐隐（滚动条本就隐藏，垂直滚轮
     又不滚横向容器——花瓣可直达，但条内滚动本身需要可发现性）。 */
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const syncTabScroll = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setTabScroll((p) => (p.left === left && p.right === right ? p : { left, right }));
  }, []);
  useLayoutEffect(() => {
    syncTabScroll();
  }, [syncTabScroll, tabOrderKey, tabNamesKey]);

  /* ---- 标签拖拽（灵动岛 范式）：条内 = 重排（幽灵芯片跟手 + 源标签压暗
          占位 + 其余标签 reorderShifts 实时让位 + 插入竖条），移出标签条 =
          摘出/转投（让位收拢、幽灵半透明），拖回条内切回重排。 ---- */
  const tabDragRef = useRef<TabDragSession | null>(null);
  const suppressTabClickRef = useRef(false);
  /* 竖滚轮接横滚（标签条 overflow-x 的滚动条隐藏、垂直滚轮默认不滚横向
     容器——成员多时除花瓣外没有滚动路径；灵动岛 DockTiles 同款手势）。
     React 的 onWheel 是 passive 监听、preventDefault 无效，挂原生非 passive。
     拖拽会话期间冻结：起拖时的矩形快照不随 scrollLeft 补偿，滚了会让插入
     竖条与让位位移和实际矩形错位（DockTiles 同口径）。 */
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (tabDragRef.current) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  /** 拖拽会话的命令式残留统一清点：其余标签的内联 transform/transition。 */
  const clearTabDragInline = useCallback(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    for (const el of strip.querySelectorAll<HTMLElement>(".widget-group-tab")) {
      el.style.transform = "";
      el.style.transition = "";
    }
  }, []);
  /** 标签拖拽 Esc 取消：与整组/卡片拖拽同一键盘语义——不提交重排/摘出，
      会话原位终止（此前只有系统手势 pointercancel 一条取消路径）。 */
  const onTabEscKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = tabDragRef.current;
      if (!s) return;
      e.stopPropagation();
      e.preventDefault();
      tabDragRef.current = null;
      try {
        s.tabEl.releasePointerCapture(s.pointerId);
      } catch {
        // pointerup 已隐式释放：忽略。
      }
      if (s.moved) clearTabDragInline();
      s.ghost?.remove();
      s.ghost = null;
      setTabDrag(null);
      window.removeEventListener("keydown", onTabEscKey, true);
      if (s.moved) {
        // 随后的合成 click 不切标签（同 endTabDrag 的压制）。
        suppressTabClickRef.current = true;
        window.setTimeout(() => {
          suppressTabClickRef.current = false;
        }, 0);
      }
    },
    [clearTabDragInline]
  );
  useEffect(
    () => () => {
      tabDragRef.current?.ghost?.remove();
      tabDragRef.current = null;
      window.removeEventListener("keydown", onTabEscKey, true);
    },
    [onTabEscKey]
  );
  /** 其余标签按让位规则平移（每帧重写，值相同也无妨——FLIP 兜底定时器可能在
      会话中清掉内联 transform，幂等跳过会让让位预览缺失，同 DockTiles ）。 */
  const applyTabShifts = (s: TabDragSession) => {
    const strip = tabsRef.current;
    if (!strip) return;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".widget-group-tab"));
    const shifts = reorderShifts(tabs.length, s.from, s.to, s.stride, s.outside);
    for (let j = 0; j < tabs.length; j++) {
      if (j === s.from) continue;
      const v = shifts.get(j) ?? 0;
      tabs[j].style.transform = v ? `translate3d(${v}px, 0, 0)` : "";
    }
  };
  /** 越过阈值起拖：快照标签矩形、挂幽灵芯片与让位过渡、写初始拖拽态。 */
  const beginTabDrag = (s: TabDragSession, x: number, y: number): boolean => {
    const strip = tabsRef.current;
    const wrap = strip?.parentElement;
    if (!strip || !wrap || s.ids.length < 2) return false;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".widget-group-tab"));
    const from = tabs.indexOf(s.tabEl);
    if (from < 0) return false;
    const zoom = uiZoom();
    const rects = tabs.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    const gap = rects.length > 1 ? Math.max(0, rects[1].left - rects[0].left - rects[0].width) : 2;
    s.rects = rects;
    s.others = rects.filter((_, i) => i !== from);
    s.from = from;
    s.to = from;
    s.outside = false;
    s.stride = (rects[from].width + gap) / zoom;
    s.wrapLeft = wrap.getBoundingClientRect().left;
    s.lastX = x;
    s.lastY = y;
    /* 幽灵芯片：源标签克隆，起于源位、按指针位移跟手（body 直挂不被条的
       overflow 裁切；data-interactive 让穿透采集上报矩形，非编辑模式拖动
       期间窗口保持可交互——同 dock-drag-ghost）。 */
    const ghost = document.createElement("div");
    ghost.className = "group-tab-ghost is-dragging";
    /* 读屏会话期静音（克隆文本是纯视觉跟手件，DockTiles 幽灵同款）——
       插入竖条/图标/把手都有 aria-hidden，唯独幽灵漏了。 */
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("data-interactive", "");
    const sr = s.tabEl.getBoundingClientRect();
    ghost.style.left = `${sr.left / zoom}px`;
    ghost.style.top = `${sr.top / zoom}px`;
    ghost.innerHTML = s.tabEl.innerHTML;
    document.body.appendChild(ghost);
    s.ghost = ghost;
    /* 其余标签挂让位过渡（会话内有效，收尾 clearTabDragInline 统一清）。 */
    const reduce = prefersReducedMotion();
    const { ease, durMs } = pickSpatialEase(s.stride * zoom);
    for (let j = 0; j < tabs.length; j++) {
      if (j !== from) tabs[j].style.transition = reduce ? "none" : `transform ${durMs}ms ${ease}`;
    }
    /* 初始拖动态同步写一次（源压暗 + 竖条在原槽位），离散变化再由 update 补。 */
    setTabDrag({
      id: s.memberId,
      mode: "reorder",
      barX: (insertionBarX(rects, from, from) - s.wrapLeft) / zoom
    });
    return true;
  };
  const updateTabDrag = (s: TabDragSession, x: number, y: number) => {
    s.lastX = x;
    s.lastY = y;
    const zoom = uiZoom();
    if (s.ghost) {
      s.ghost.style.transform = `translate3d(${(x - s.startX) / zoom}px, ${(y - s.startY) / zoom}px, 0)`;
    }
    const strip = tabsRef.current?.getBoundingClientRect();
    /* ±6px 纵向容差：手腕轻微上下抖动不把重排误判成摘出。 */
    const inside = !!strip && x >= strip.left && x <= strip.right && y >= strip.top - 6 && y <= strip.bottom + 6;
    const outside = !inside;
    const to = outside ? s.to : insertionIndexAt(s.others, x);
    if (to === s.to && outside === s.outside) return;
    s.to = to;
    s.outside = outside;
    s.mode = outside ? "extract" : "reorder";
    s.ghost?.classList.toggle("is-removing", outside);
    applyTabShifts(s);
    setTabDrag({
      id: s.memberId,
      mode: s.mode,
      barX: outside ? null : (insertionBarX(s.rects, s.from, s.to) - s.wrapLeft) / zoom
    });
  };
  /** 中键摘出成员——走 removeGroupMember 的反馈路径（「已移出编组」/
   *  「已解散编组」toast + 撤销回组），落位在组右侧偏移一格（中键没有拖拽
   *  落点语义；updateWidget 内部吸附网格并夹回视口）。 */
  const middleExtract = (memberId: string) => {
    const st = useWidgetStore.getState();
    const g = st.groups.find((x) => x.id === group.id);
    const inst = st.instances.find((i) => i.id === memberId);
    if (!g || !g.memberIds.includes(memberId) || !inst) return;
    st.removeGroupMember(group.id, memberId);
    st.updateWidget(memberId, { x: g.x + g.w + GRID, y: g.y });
    st.bringToFront(memberId);
    markPulse([memberId]);
  };
  const onTabDown = (m: { id: string; type: string }, e: ReactPointerEvent<HTMLButtonElement>) => {
    /* 中键 = 摘出该成员（浏览器标签中键习惯；应用内通知列表/dock 中键
       同款先例）。preventDefault 顺带压掉 Windows 中键自动滚动光标。 */
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      middleExtract(m.id);
      return;
    }
    if (e.button !== 0) return;
    // 标签按下不再当整组拖拽把手：编辑模式下移动整组走标签条空白区。
    e.stopPropagation();
    disarmBloom();
    tabDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      memberId: m.id,
      memberName: memberName(m),
      mode: "reorder",
      ids: group.memberIds,
      tabEl: e.currentTarget,
      ghost: null,
      rects: [],
      others: [],
      from: -1,
      to: -1,
      outside: false,
      stride: 0,
      wrapLeft: 0,
      lastX: e.clientX,
      lastY: e.clientY
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      // 会话期挂 Esc 取消（capture）——pointer capture 下键盘是唯一取消路径。
      window.addEventListener("keydown", onTabEscKey, true);
    } catch {
      // 极少数环境不支持捕获：放弃拖拽，点击切签不受影响。
      tabDragRef.current = null;
    }
  };
  const onTabMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = tabDragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    if (!s.moved) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < TAB_DRAG_THRESHOLD) return;
      s.moved = true;
      if (!beginTabDrag(s, e.clientX, e.clientY)) {
        tabDragRef.current = null;
        window.removeEventListener("keydown", onTabEscKey, true);
      }
      return;
    }
    updateTabDrag(s, e.clientX, e.clientY);
  };
  /** 摘出成员到落点（常规路径：摘出 + 中心对齐指针 + 落位脉冲）。 */
  const extractMember = (memberId: string, clientX: number, clientY: number) => {
    const st = useWidgetStore.getState();
    const g = st.groups.find((x) => x.id === group.id);
    const inst = st.instances.find((i) => i.id === memberId);
    if (!g || !g.memberIds.includes(memberId) || !inst) return;
    /* 摘出会令组解散（2 人组）时走反馈路径——「已解散编组」toast + 撤销
       （restoreGroup 重建，摘出者是自由身可被回收）。此前恒静默：整组消失
       零反馈零撤销，而同一结果从右键菜单走却有完整反馈（批的不对称）。
       ≥3 人组维持静默 + 落位脉冲（既有设计：拖出所见即所得）。 */
    const willDisband = g.memberIds.length < 3;
    st.removeGroupMember(g.id, memberId, { feedback: willDisband });
    // 落点即新位：组件中心对齐指针（updateWidget 内部吸附网格并夹回视口）。
    const z = uiZoom();
    st.updateWidget(memberId, { x: clientX / z - inst.w / 2, y: clientY / z - inst.h / 2 });
    st.bringToFront(memberId);
    if (st.editMode) st.selectWidget(memberId);
    /* 摘出落位脉冲：幽灵瞬消后新卡以 accent 描边脉冲确认落点（与拖拽落位/
       图库新增同一语言，此前是原地瞬现无任何反馈）。解散路径不再叠脉冲——
       反馈分支已给全组成员 markEntering（fly-in 回场），两个动画类同帧会
       互抢 animation 属性（addWidget 的「先入场再脉冲」时序同理）。 */
    if (!willDisband) markPulse([memberId]);
  };
  const endTabDrag = (e: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const s = tabDragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    tabDragRef.current = null;
    window.removeEventListener("keydown", onTabEscKey, true);
    try {
      s.tabEl.releasePointerCapture(e.pointerId);
    } catch {
      // pointerup 已隐式释放：忽略。
    }
    const finishCommon = () => {
      clearTabDragInline();
      s.ghost?.remove();
      s.ghost = null;
      setTabDrag(null);
    };
    if (cancelled || !s.moved) {
      finishCommon();
      return;
    }
    // 松手后紧随的合成 click 会切换标签：压住（同 DockTiles 吞 click）。
    suppressTabClickRef.current = true;
    window.setTimeout(() => {
      suppressTabClickRef.current = false;
    }, 0);
    if (!s.outside) {
      /* 条内松手 = 重排落位（灵动岛同款）：源标签先跳到幽灵跟手位（视觉
         连续），flipReorder 以此为 First、以提交后的新槽位为 Last 回弹。
         组员快照过期（其它窗口改过成员）或位置未变则安静收场。 */
      const current = useWidgetStore.getState().groups.find((g) => g.id === group.id)?.memberIds;
      const stale = !current || current.length !== s.ids.length || current.some((v, i) => v !== s.ids[i]);
      if (!stale && s.to !== s.from) {
        const zoom = uiZoom();
        s.tabEl.style.transition = "none";
        s.tabEl.style.transform = `translate3d(${(s.lastX - s.startX) / zoom}px, ${(s.lastY - s.startY) / zoom}px, 0)`;
        s.ghost?.remove();
        s.ghost = null;
        setTabDrag(null);
        void s.tabEl.offsetWidth;
        const rest = s.ids.filter((v) => v !== s.memberId);
        rest.splice(s.to, 0, s.memberId);
        suppressTabFlipRef.current = true;
        const strip = tabsRef.current;
        if (strip) {
          flipReorder(strip, ".widget-group-tab", () => {
            clearTabDragInline();
            useWidgetStore.getState().reorderGroupMembers(group.id, rest);
          });
        } else {
          useWidgetStore.getState().reorderGroupMembers(group.id, rest);
        }
        return;
      }
      finishCommon();
      return;
    }
    /* 条外松手 = 摘出（口径）：先收命令式残留再走转投/常规摘出。 */
    finishCommon();
    const st = useWidgetStore.getState();
    const zoom = uiZoom();
    const point = { x: e.clientX / zoom, y: e.clientY / zoom };
    const target = findMergeTargetAt(
      st.instances,
      st.groups.filter((g) => g.id !== group.id),
      point,
      [s.memberId]
    );
    if (target) {
      /* 转投若令源组解散（2 人组），补「已解散编组」反馈——但撤销不能
         用 removeGroupMember 内置的 restoreGroup（成员转投后已非自由身，
         restoreGroup 的 ≥2 自由成员守卫会静默 no-op），须先从目标组摘回再
         重建源组（与 mergeGroups 的撤销同构）。非解散转投维持静默（并入
         反馈由 mergeIntoGroup 的目标组脉冲承担）。
         反馈在 willDisband 判定处统一给——竞态失败回退路径（目标恰好
         消失）同样解散了源组，此前只有 merged 成功分支有 toast。 */
      const src = st.groups.find((x) => x.id === group.id);
      const willDisband = !!src && src.memberIds.length < 3;
      st.removeGroupMember(group.id, s.memberId, { feedback: false });
      const merged = st.mergeIntoGroup([s.memberId], target);
      if (merged) {
        // 并入=目标组脉冲 / 建组=新组入场（mergeIntoGroup 内已带反馈）。
        st.bringToFront(merged.groupId);
      }
      if (willDisband && src) {
        if (src.activeId === s.memberId) {
          /* 摘走的是显示中的标签：源组随之消失，留下的成员原位回场。 */
          const stay = src.memberIds.find((id) => id !== s.memberId);
          if (stay) markEntering([stay]);
        }
        /* 撤销：先把成员从（若成功的）目标组摘回，再重建源组；竞态失败
           回退时成员已是自由身，直接重建。 */
        const undoFrom = merged ? merged.groupId : null;
        pushAppToast(tr("已解散编组"), "", "info", {
          action: {
            label: tr("撤销"),
            run: () => {
              const s2 = useWidgetStore.getState();
              if (undoFrom) s2.removeGroupMember(undoFrom, s.memberId, { feedback: false });
              s2.restoreGroup(src);
            }
          }
        });
      }
      if (merged) return;
      /* 合并失败（竞态：目标此刻已消失）→ 回退为常规摘出：成员已静默离组，
         直接按落点定位（extractMember 的守卫会因已离组而 no-op，不能复用）。 */
      const inst = st.instances.find((i) => i.id === s.memberId);
      if (inst) {
        st.updateWidget(s.memberId, { x: point.x - inst.w / 2, y: point.y - inst.h / 2 });
        st.bringToFront(s.memberId);
      }
      markPulse([s.memberId]);
      return;
    }
    extractMember(s.memberId, e.clientX, e.clientY);
  };
  const onTabUp = (e: ReactPointerEvent<HTMLButtonElement>) => endTabDrag(e, false);
  const onTabCancel = (e: ReactPointerEvent<HTMLButtonElement>) => endTabDrag(e, true);
  /** 解散编组（桌面侧）：两步确认 + 撤销 toast（设置页同款确认文案；快照经
   *  restoreGroup 原样重建，几何/层级/激活标签都不丢）。 */
  const requestDisband = useCallback(async () => {
    const ok = await confirmDialog({
      title: tr("解散编组"),
      message: tr("解散后成员回到编组前的原位（不删除小组件）。确定继续？"),
      confirmLabel: tr("解散编组"),
      danger: true
    });
    if (!ok) return;
    const snap = useWidgetStore.getState().disbandGroup(group.id);
    if (!snap) return;
    pushAppToast(tr("已解散编组"), "", "info", {
      action: {
        label: tr("撤销"),
        run: () => useWidgetStore.getState().restoreGroup(snap)
      }
    });
  }, [group.id, tr]);
  /** 删除整组（摩擦对齐）：解散（不删组件）有两步确认，删除整组（N 个
   *  组件全进回收站）此前反而零确认——危险度更高的动作不该更轻易。确认后
   *  走 removeGroup（组壳退场 + 成员进回收站 + 统一撤销 toast）。 */
  const requestRemoveGroup = useCallback(async () => {
    const ok = await confirmDialog({
      title: tr("删除整组"),
      message: tr("将删除组内全部小组件并移入回收站（可撤销）。确定继续？"),
      confirmLabel: tr("删除整组"),
      danger: true
    });
    if (!ok) return;
    useWidgetStore.getState().removeGroup(group.id);
  }, [group.id, tr]);
  /** 重命名标签（双击标签 / 右键菜单 / 配置面板与设置页共用）：收口到
   *  共享 promptRenameInstance——写 instance.label、toast 带撤销、超长按
   *  码点截断；widgetDisplayName 全局优先读取（标签 / 花瓣 / 卡片标题 /
   *  配置面板 / 设置页即刻同步），留空恢复默认名。预填自定义名原值 +
   *  placeholder 示默认名（预填自动名会让原样提交把自动名固化成 label）。 */
  const renameMember = useCallback(
    async (memberId: string) => {
      await promptRenameInstance(memberId, tr);
    },
    [tr]
  );
  const onTabMenu = (m: { id: string; type: string }, e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    disarmBloom();
    openContextMenu(e, [
      // 非编辑模式组壳空白处保持穿透，标签条是唯一右键入口：配置/编辑在此可达。
      ...(editMode ? [] : [{ label: tr("编辑布局"), icon: <Pencil size={15} />, onSelect: () => setEditMode(true) }]),
      { label: tr("配置"), icon: <Settings size={15} />, onSelect: () => setCfgOpen(true) },
      { label: tr("重命名标签"), icon: <Pencil size={15} />, onSelect: () => void renameMember(m.id) },
      {
        /* 整句模板 + {name} 占位符（英文按语序重排），不再拼接翻译段。 */
        label: tr("移除成员：{name}", { name: memberName(m) }),
        icon: <X size={15} />,
        onSelect: () => removeMember(group.id, m.id)
      },
      {
        label: tr("解散编组"),
        icon: <Layers size={15} />,
        onSelect: () => void requestDisband()
      }
    ]);
  };

  const onMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, [
      ...(editMode ? [] : [{ label: tr("编辑布局"), icon: <Pencil size={15} />, onSelect: () => setEditMode(true) }]),
      { label: tr("配置"), icon: <Settings size={15} />, onSelect: () => setCfgOpen(true) },
      /* 组名入口（侧栏/设置页/无障碍标签显示用；留空回落「编组」）。 */
      { label: tr("重命名编组"), icon: <Pencil size={15} />, onSelect: () => void promptRenameGroup(group.id, tr) },
      /* V5：整组复制（对齐卡片的「复制小组件」）——组壳/成员同偏移、数据深
         拷贝、组名与自定义名按 副本哲学回落默认。
         store 侧对 <2 存活成员 no-op（解散中间态可产出单员组），菜单
         项按存活数条件渲染——点了没反馈与项目交互纪律不符。 */
      ...(members.length >= 2
        ? [
            {
              label: tr("复制编组"),
              icon: <Copy size={15} />,
              onSelect: () => useWidgetStore.getState().duplicateGroup(group.id)
            }
          ]
        : []),
      { type: "separator" as const },
      /* 层级操作（与卡片右键同款两条）：组此前只有双击标签条一条隐藏置顶路径，
         「移到底层」则完全不存在（sendGroupToBack 本批补齐）。 */
      { label: tr("置顶显示"), icon: <ArrowUpToLine size={15} />, onSelect: () => bringToFront(group.id) },
      { label: tr("移到底层"), icon: <ArrowDownToLine size={15} />, onSelect: () => sendToBack(group.id) },
      { type: "separator" as const },
      { label: tr("解散编组"), icon: <Layers size={15} />, onSelect: () => void requestDisband() },
      ...(active
        ? [
            {
              /* 同上，整句模板 + {name} 占位符。 */
              label: tr("移除成员：{name}", { name: memberName(active) }),
              icon: <X size={15} />,
              onSelect: () => removeMember(group.id, active.id)
            }
          ]
        : []),
      { type: "separator" as const },
      { label: tr("删除整组"), icon: <Trash2 size={15} />, danger: true, onSelect: () => void requestRemoveGroup() }
    ]);
  };

  if (!active || !Content) return null;

  return (
    <div
      ref={rootRef}
      data-group-id={group.id}
      /* 组根 aria-label 对齐卡片——选中态播报可用快捷键（批补的
         键盘路径此前无自述；组无缩放，清单比卡片少一项）。 */
      aria-label={`${group.name?.trim() || tr("编组")} · ${members.length}${
        editMode && selected ? `（${tr("已选中，方向键移动，Delete 删除，F2 重命名")}）` : ""
      }`}
      className={`widget-group${editMode ? " editing" : ""}${dragging ? " dragging" : ""}${isMergeTarget ? " merge-target" : ""}${selected ? " selected" : ""}${exiting ? " is-exiting" : ""}${entering ? " fly-in" : ""}${pulsing ? " pulse-in" : ""}${posAnim ? " pos-anim" : ""}`}
      style={
        {
          left: resizeRect?.x ?? group.x,
          top: resizeRect?.y ?? group.y,
          width: resizeRect?.w ?? group.w,
          height: resizeRect?.h ?? group.h,
          // 拖拽中压在全部卡片/组之上（对齐 WidgetCard 的 MAX_Z+1 抬升）。
          zIndex: dragging ? MAX_Z + 1 : group.z,
          "--widget-bg-alpha": (globalOpacity / 100) * groupAlpha
        } as React.CSSProperties
      }
      onContextMenu={onMenu}
      /* 焦点踪迹：React 合成 focus/blur 会冒泡（focusin/focusout），
         焦点在卡内标签按钮间移动时 relatedTarget 仍在卡内，不清迹。 */
      onFocus={() => {
        focusWithinRef.current = true;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusWithinRef.current = false;
      }}
      /* 悬停 140ms dwell 自动置顶（对齐 WidgetCard 的卡片行为）。 */
      onMouseEnter={() => {
        if (!editMode) {
          cancelRaise();
          raiseTimerRef.current = window.setTimeout(() => bringToFront(group.id), 140);
        }
      }}
      onMouseLeave={cancelRaise}
      /* 整组拖拽的跟手/收尾挂根：捕获打在按下最深元素上（body 也能起拖），
         位移事件经冒泡回到这里，标签条/组体/把手三类起点共用同一会话。 */
      onPointerMove={onHeadMove}
      onPointerUp={onHeadUp}
      onPointerCancel={onHeadCancel}
    >
      {/* 外层只承载溢出渐隐指示（伪元素覆盖层），滚动/命中/花锚点都仍在
          内层标签条上。 */}
      <div
        className={`widget-group-tabs-wrap${tabScroll.left ? " can-left" : ""}${tabScroll.right ? " can-right" : ""}`}
      >
        <div
          ref={tabsRef}
          className="widget-group-tabs"
          style={{ height: TAB_H }}
          role="tablist"
          aria-label={tr("编组成员")}
          onPointerDown={onHeadDown}
          onDoubleClick={() => bringToFront(group.id)}
          onPointerEnter={armOpen}
          onPointerLeave={armClose}
          onScroll={syncTabScroll}
          data-interactive
        >
          {/* 编辑模式可见的整组拖动把手：标签铺满标签条时（无空白区）仍可抓握
              移动整组；pointerdown 冒泡给标签条的 onHeadDown，无需独立会话。 */}
          {editMode && (
            <span className="widget-group-grip" aria-hidden="true">
              <GripVertical size={12} />
            </span>
          )}
          {members.map((m) => {
            const Icon = getWidgetMeta(m.type)?.icon;
            return (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={m.id === active.id}
                /* APG tabs 的 roving tabindex——仅激活标签可 Tab 聚焦，
                   其余 -1（方向键巡览已带焦点随行）。此前所有标签都占一个
                   Tab 停靠点，键盘用户要逐个穿过整个标签条。 */
                tabIndex={m.id === active.id ? 0 : -1}
                /* WAI-ARIA tabs 模式的成对关联——tab ↔ tabpanel 互相引用，
                   屏幕阅读器才能把切换的内容区与标签对上（id 派生自组/成员 id，
                   全局唯一）。 */
                id={`group-${group.id}-tab-${m.id}`}
                aria-controls={`group-${group.id}-panel`}
                className={`widget-group-tab${m.id === active.id ? " active" : ""}${
                  tabDrag?.id === m.id ? " extracting" : ""
                }`}
                onDoubleClick={(e) => {
                  /* 双击改名不冒泡到标签条的 onDoubleClick（bringToFront）——
                     每次改名不该顺带一次 z 序写入。 */
                  e.stopPropagation();
                  void renameMember(m.id);
                }}
                onClick={() => {
                  if (suppressTabClickRef.current) return;
                  switchTab(group.id, m.id);
                  bringToFront(group.id);
                }}
                onKeyDown={(e) => {
                  /* 方向键切签：tablist 的键盘巡览（Home/End 同束），焦点
                     随激活标签走。 */
                  const ids = orderedIds;
                  const cur = ids.indexOf(m.id);
                  let next = -1;
                  if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
                  else if (e.key === "ArrowRight") next = Math.min(ids.length - 1, cur + 1);
                  else if (e.key === "Home") next = 0;
                  else if (e.key === "End") next = ids.length - 1;
                  else return;
                  e.preventDefault();
                  if (next === cur || next < 0) return;
                  const nid = ids[next];
                  switchTab(group.id, nid);
                  bringToFront(group.id);
                  tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${nid}"]`)?.focus();
                }}
                onPointerDown={(e) => onTabDown(m, e)}
                onPointerMove={onTabMove}
                onPointerUp={onTabUp}
                onPointerCancel={onTabCancel}
                onContextMenu={(e) => onTabMenu(m, e)}
                /* tooltip 顺带告知双击手势（右键菜单藏一层，双击零成本）。 */
                title={`${memberName(m)}（${tr("双击重命名")}）`}
                data-tab-id={m.id}
                data-interactive
              >
                {/* 类型图标 + 名称（浏览器标签 favicon 语言；摘出幽灵克隆
                    本节点内容，图标随行）。 */}
                <span className="widget-group-tab-ico" aria-hidden="true">
                  {Icon ? <Icon size={12} /> : null}
                </span>
                <span className="widget-group-tab-name">{memberName(m)}</span>
              </button>
            );
          })}
        </div>
        {/* 灵动岛同款插入竖条：条内拖动时预告落位空槽（barX = 包裹层内布局
            坐标，竖条中心；离散跨槽才更新，不逐帧过 React）。 */}
        {tabDrag?.barX != null && (
          <span
            className="widget-group-insert-bar"
            style={{ transform: `translate3d(${tabDrag.barX - 1}px, 0, 0)` }}
            aria-hidden="true"
          />
        )}
      </div>
      {/* 组体在编辑模式下同卡片一样整体可拖（对齐 WidgetCard：pointerdown 起
          会话、不移动则点击语义原样透传给成员内容）。：role=tabpanel 与
          标签成对（aria-labelledby 指向激活标签的 id，随切签更新）。 */}
      <div
        className="widget-group-body"
        role="tabpanel"
        id={`group-${group.id}-panel`}
        aria-labelledby={`group-${group.id}-tab-${active.id}`}
        onPointerDown={onHeadDown}
      >
        {/* 重试先弃缓存的 rejected import（成员内容经 registry 工厂
            懒加载，resetWidgetLazy 一并覆盖沉浸 / 迷你形态）。 */}
        <WidgetErrorBoundary instanceId={active.id} type={active.type} onRetry={() => resetWidgetLazy(active.type)}>
          {/* key=激活成员：切 tab 重挂播纯 opacity 淡入（桌面透明画布禁 transform，
              纪律），成员内容不再硬切。组壳是组级 alpha，成员内容子树再乘
              成员自身 opacity（下一级；面板滑条经 opacityPreview 即时预览）。 */}
          <div
            className="widget-group-body-swap"
            key={active.id}
            style={{ "--widget-bg-alpha": activeMemberAlpha } as React.CSSProperties}
          >
            <Suspense fallback={<div className="widget-skeleton" aria-busy="true" />}>
              <Content instanceId={active.id} />
            </Suspense>
          </div>
        </WidgetErrorBoundary>
      </div>
      {bloomAnchor && (
        <GroupBloom
          members={members.map((m) => ({ id: m.id, type: m.type, name: memberName(m) }))}
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
      {/* 编辑模式 8 向缩放手柄（与卡片同组手柄；透明命中区，视觉悬停浮现）。 */}
      {editMode &&
        RESIZE_HANDLES.map((h) => (
          <div
            key={h.id}
            data-resize-handle={h.id}
            aria-label={tr(h.label)}
            style={{ position: "absolute", cursor: h.cursor, zIndex: 6, ...h.style }}
            onPointerDown={(e) => onResizeStart(h.id, e)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
          />
        ))}
      {/* 编组配置弹层：右键「配置」打开，锚定组矩形（懒加载，首次打开才拉 chunk）。 */}
      {cfgArmed && (
        <Suspense fallback={null}>
          <GroupConfigPanel.Component
            groupId={group.id}
            anchor={{
              x: resizeRect?.x ?? group.x,
              y: resizeRect?.y ?? group.y,
              w: resizeRect?.w ?? group.w,
              h: resizeRect?.h ?? group.h
            }}
            open={cfgOpen}
            onClose={() => setCfgOpen(false)}
            onOpenMemberConfig={openMemberConfig}
          />
        </Suspense>
      )}
      {/* 成员下一级「配置此小组件」的就地弹层（互斥事件打开时编组面板自行收起）。 */}
      {memberCfg && (
        <WidgetConfigPopover
          key={memberCfg.id}
          instanceId={memberCfg.id}
          widgetType={memberCfg.type}
          anchor={{ x: group.x, y: group.y, w: group.w, h: group.h }}
          open={memberCfgOpen}
          onClose={() => setMemberCfgOpen(false)}
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
