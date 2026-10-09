/**
 * 设置页 · 任务栏（TB-UI）：实时预览通道（TB-PREVIEW）——（深拆）自
 * TaskbarPage.tsx 拆出。TaskbarPage 挂载本 hook，StateCard / RuleList 经
 * TaskbarPreviewHandle 消费；页面仍 re-export 两个常量保持单测既有导入路径。
 *
 * 两条即时链路共用一个 Rust 命令（见 lib/tauri.ts previewTaskbarState）：
 * - 拖动：编辑器每次改动立即 `preview(state, 整套外观)`；最后一次改动后静默
 *   350ms + 余量视为松手——有钉住的卡就切回它，否则 `preview(null)` 取消。真实
 *   落定由 TaskbarConfigSync 的 350ms 对账 apply 负责（Rust 端 apply 即结束预览）。
 * - 钉住：按钮 `preview(state, 该状态外观)` 强制生效；再按 / 60s / 离开页面 / 总开关
 *   关闭 → 解除。Rust 侧同样 60s 自动取消，两侧独立计时、重复取消无副作用。
 * 预览 IPC 是 best-effort：拖动中的失败静默；按钮触发的失败 toast 并回退钉住态。
 * 全程不写切片、不 invoke set_setting / apply_taskbar_config。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { isTauri, previewTaskbarState } from "../../../lib/tauri";
import { TASKBAR_APPLY_DEBOUNCE_MS } from "./TaskbarConfigSync";
import { showToast } from "../../../components/ToastHost";
import { useT } from "../../../i18n-lite";
import type { TaskbarAppearance, TaskbarStateAppearance, TaskbarStateKey } from "../../../store/settings-store";

/** 「预览此状态」钉住时长：与 Rust `PREVIEW_HOLD`（60s）同值，到点两侧各自收尾（重复取消是 no-op）。 */
export const TASKBAR_PREVIEW_HOLD_MS = 60_000;
/** 拖动落定后再留的余量：让 350ms 防抖的真实 apply 先落地，随后才「切回钉住的状态卡 /
 *  取消拖动预览」——否则先到的切回会被紧随的真实 apply 结束，钉住效果闪一下就没了。 */
export const TASKBAR_PREVIEW_SETTLE_GRACE_MS = 120;

/** 状态卡的预览控制面（StateCard 消费）。 */
export type TaskbarPreviewHandle = {
  /** 当前被钉住预览的状态键（null = 无）。 */
  pinned: TaskbarStateKey | null;
  /** 总开关关闭时按钮禁用、拖动不发 IPC（Rust 侧未就绪，预览必失败）。 */
  disabled: boolean;
  /** 钉住 / 解除（再按同卡 = 解除，按他卡 = 直接切换，不经过取消以免闪回真实外观）。 */
  toggle: (key: TaskbarStateKey) => void;
  /** 外观编辑器的一次改动：立即预览；静默落定后回到钉住的卡或取消拖动预览。 */
  onEdit: (key: TaskbarStateKey, next: TaskbarAppearance) => void;
};

/** 切片单态 → 纯外观（去掉 `enabled`，预览载荷只认五个外观字段）。 */
function appearanceOf(state: TaskbarStateAppearance): TaskbarAppearance {
  const { accent, color, showPeek, showLine, blurRadius } = state;
  return { accent, color, showPeek, showLine, blurRadius };
}

function clearTimer(ref: RefObject<number | null>) {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

export function useTaskbarPreview(
  states: Record<TaskbarStateKey, TaskbarStateAppearance>,
  moduleEnabled: boolean
): TaskbarPreviewHandle {
  const tr = useT();
  const [pinned, setPinnedState] = useState<TaskbarStateKey | null>(null);
  const pinnedRef = useRef<TaskbarStateKey | null>(null);
  const statesRef = useRef(states);
  statesRef.current = states;
  const settleTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  /** Rust 侧可能仍有预览在生效（决定卸载 / 解除时是否要发取消）。 */
  const liveRef = useRef(false);

  const setPinned = (key: TaskbarStateKey | null) => {
    pinnedRef.current = key;
    setPinnedState(key);
  };
  const send = (key: TaskbarStateKey | null, overrides?: Partial<TaskbarAppearance>) => {
    liveRef.current = key !== null;
    return previewTaskbarState(key, overrides);
  };
  const unpin = (notifyRust: boolean) => {
    clearTimer(holdTimer);
    setPinned(null);
    if (notifyRust && liveRef.current) void send(null).catch(() => {});
  };

  const toggle = (key: TaskbarStateKey) => {
    if (!isTauri()) {
      showToast(tr("该操作仅在桌面端可用"), "info");
      return;
    }
    if (pinnedRef.current === key) {
      unpin(true);
      return;
    }
    // 拖动落定的回滚不再执行（目标已换）；60s 计时从本次钉住重新起算。
    clearTimer(settleTimer);
    clearTimer(holdTimer);
    setPinned(key);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      unpin(true);
    }, TASKBAR_PREVIEW_HOLD_MS);
    send(key, appearanceOf(statesRef.current[key])).catch((err: unknown) => {
      showToast(tr("预览失败：{err}", { err: String(err) }), "error");
      if (pinnedRef.current === key) unpin(false);
    });
  };

  const onEdit = (key: TaskbarStateKey, next: TaskbarAppearance) => {
    if (!isTauri() || !moduleEnabled) return;
    // 编辑器的 value 运行时是切片单态（可选态带 enabled），载荷只留五个外观字段。
    void send(key, appearanceOf(next)).catch(() => {});
    clearTimer(settleTimer);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      const p = pinnedRef.current;
      if (p !== null) void send(p, appearanceOf(statesRef.current[p])).catch(() => {});
      else void send(null).catch(() => {});
    }, TASKBAR_APPLY_DEBOUNCE_MS + TASKBAR_PREVIEW_SETTLE_GRACE_MS);
  };

  // 总开关关闭：Rust 侧 apply(enabled=false) 已结束预览并恢复系统默认，本地只收钉住态。
  useEffect(() => {
    if (moduleEnabled || pinnedRef.current === null) return;
    clearTimer(holdTimer);
    pinnedRef.current = null;
    setPinnedState(null);
  }, [moduleEnabled]);

  // 离开页面：取消一切预览（「离开页面自动取消」）并清定时器。
  useEffect(
    () => () => {
      clearTimer(settleTimer);
      clearTimer(holdTimer);
      if (liveRef.current && isTauri()) void previewTaskbarState(null).catch(() => {});
    },
    []
  );

  return { pinned, disabled: !moduleEnabled, toggle, onEdit };
}
