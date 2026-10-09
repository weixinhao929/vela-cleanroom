import type { ComponentType } from "react";
import { create } from "zustand";

/**
 * 沉浸组件契约（registry `WidgetMeta.ExpandedComponent` 的 props）。
 *
 * - `instanceId`：与主组件同源，可经 useWidgetConfig 读同一份实例配置
 *   （城市索引、频谱参数等），保证卡片与沉浸页视图一致；
 * - `active`：当前是否处于展开态。false 时组件**保持挂载**（常驻叠放不
 *   重建）但必须暂停轮询 / rAF / 音频采集等持续性工作——遮罩层会把它置
 *   display:none，屏幕上不可见也不参与点击穿透区域上报。
 */
export type ExpandedComponentProps = { instanceId: string; active: boolean };
export type ExpandedComponentType = ComponentType<ExpandedComponentProps>;

/**
 * 小组件展开态状态机（互斥优先级链模式）。
 *
 * 职责：全画布同一时刻至多一个沉浸表面展开——`expandedId` 是唯一事实
 * 来源，天然互斥（新展开直接顶掉旧展开，无需显式「收起其余」动作）。
 *
 * 常驻叠放不重建（KeystoneSurface.qml 的 `visible: opacity > 0.01` 技巧
 * 的 DOM 适配）：沉浸内容首次展开后进入 `mountedIds`，之后收起只是
 * active=false（内容层播交叉淡化 + 置 display:none），React 树保持挂载、
 * 状态（滚动位置/已拉数据）不丢，重开瞬时可见；组件内部应以 active=false
 * 暂停轮询与动画（本 store 不强制，由 ExpandedComponent 契约约束）。
 * 挂载表有 LRU 上限（MOUNTED_IDS_CAP）：重面板的组件树与订阅不能无上限
 * 常驻，最久未展开的面板被挤出挂载表，重开付一次懒加载重挂。
 *
 * 该状态是纯瞬态 UI 态（不持久化、不跨窗口同步——每屏画布独立展开）。
 */
/**
 * 常驻叠放面板数的上限（LRU）：「常驻叠放不重建」让每个展开过一次的面板
 * 保持挂载（重开瞬时、状态不丢），但音乐沉浸页 / 天气站一类重面板的组件
 * 树、已拉数据与 store 订阅随挂载常驻，长会话反复展开不同面板时只增不减。
 * 超过上限时把最久未展开的面板挤出挂载表（forget 语义），重开付一次懒加载
 * 重挂。淘汰只发生在 expand（伴随 expandedId 变化），不会踢掉当前展开面。
 */
const MOUNTED_IDS_CAP = 6;

type WidgetExpandState = {
  /** 当前展开的实例 id；null = 全部收起。 */
  expandedId: string | null;
  /** 至少展开过一次的实例 id 集合（沉浸层保持挂载，重开不重建），按最近
   *  展开时间排序（队首最旧），超过 MOUNTED_IDS_CAP 淘汰队首。 */
  mountedIds: string[];
  /** 五.5 展开「代数」：每次 expand() 递增——沉浸页可把它当 key，在重开时
   *  重播入场动画（如统计图表生长 / count-up），不必放弃整层常驻挂载。 */
  openEpoch: number;
  /** 展开指定实例；其余（若有）自动收起——互斥由单值语义保证。 */
  expand: (id: string) => void;
  /** 收起当前展开的实例（保留挂载）。 */
  collapse: () => void;
  /** 仅当指定实例处于展开态时收起它（Esc / 遮罩点击的守卫语义）。 */
  collapseIf: (id: string) => void;
  /** 实例从画布移除时清理其展开与挂载记录（卡片卸载时调用）。 */
  forget: (id: string) => void;
};

export const useWidgetExpand = create<WidgetExpandState>()((set, get) => ({
  expandedId: null,
  mountedIds: [],
  openEpoch: 0,

  expand: (id) => {
    const s = get();
    if (s.expandedId === id) return; // 已展开：幂等，避免重播展开动画
    /* LRU：重开已挂载的面板时挪到队尾（新鲜位），队首即最久未展开；挪动总
       是伴随 expandedId 变化发生（订阅者本就要重渲），不产生额外代价。 */
    let mounted = [...s.mountedIds.filter((m) => m !== id), id];
    if (mounted.length > MOUNTED_IDS_CAP) mounted = mounted.slice(mounted.length - MOUNTED_IDS_CAP);
    set({ expandedId: id, mountedIds: mounted, openEpoch: s.openEpoch + 1 });
  },

  collapse: () => {
    if (get().expandedId === null) return;
    set({ expandedId: null });
  },

  collapseIf: (id) => {
    if (get().expandedId !== id) return;
    set({ expandedId: null });
  },

  forget: (id) => {
    const s = get();
    if (!s.mountedIds.includes(id) && s.expandedId !== id) return;
    set({
      expandedId: s.expandedId === id ? null : s.expandedId,
      mountedIds: s.mountedIds.filter((m) => m !== id)
    });
  }
}));
