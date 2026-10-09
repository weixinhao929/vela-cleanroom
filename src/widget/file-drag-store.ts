import { create } from "zustand";

/**
 * OS 文件拖拽进行中状态（拖拽进行态显形规格）。
 *
 *  的收纳盒平时淡出，只有当用户从资源管理器拖着文件路过时
 * 才显形提示可投放。Vela 的对应缺口：此前只有光标正下方的快捷方式落格
 * 会亮（`os-hover`），用户拖文件进屏幕时**看不出哪些卡片能接收**。
 *
 * 本 store 把「一次 OS 拖拽会话」提升为全局瞬态：`use-os-file-drop` 在
 * enter/over 时置 true、leave/drop 时置 false，`WidgetCard` 按 registry 的
 * `acceptsOsFiles` 标记给可接收的卡片挂显形类——光标未到就能看到全部
 * 投放目标，光标命中后仍由组件内部的 `os-hover` 给出更强的「就松手」提示。
 *
 * 纯瞬态 UI 态：不持久化、不跨窗口同步（每个 widget 窗口各自监听各自的
 * 拖拽事件）；幂等写入，多个订阅者（每个挂 useOsFileDrop 的组件）重复
 * 置同值不会触发额外通知。
 */
type FileDragState = {
  /** 是否正处于 OS 文件拖拽会话中（enter/over 之后、leave/drop 之前）。 */
  active: boolean;
  setFileDragActive: (next: boolean) => void;
};

export const useFileDragStore = create<FileDragState>()((set, get) => ({
  active: false,
  setFileDragActive: (next) => {
    if (get().active === next) return; // 幂等：重复 enter/over 不触发订阅者重渲
    set({ active: next });
  }
}));
