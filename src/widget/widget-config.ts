import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/tauri";
import { persistMirrored } from "../lib/local-backup";
import { isPersistSuspended } from "../lib/persist-gate";
import { useTauriEvent } from "../lib/use-tauri-event";

/**
 * 小组件独立配置的共享读写层。
 *
 * 所有小组件与设置页共用同一个 key：`focus-desk.widget-config.<instanceId>.v1`。
 * 同窗口内通过 CustomEvent 实时同步；独立设置窗口与桌面层之间通过
 * Tauri 事件 `sync:widget-config` 同步（携带完整配置，接收方直接应用），
 * 这样在设置页改动配置后桌面小组件立即生效。
 */

/** 小组件配置：自由键值对，各组件自行约定字段（config-schemas.ts 校验）。 */
export type WidgetConfig = Record<string, unknown>;

/** 配置键名构造。O(1)。 */
function configKey(instanceId: string): string {
  return `focus-desk.widget-config.${instanceId}.v1`;
}

/* ══ 跨窗广播防抖（P-perf 三轮）══
   就地配置弹层的滑条拖动每个 pointermove 都会 update → saveWidgetConfig，
   此前每步都做一次整包 Tauri emit（序列化 + 广播到所有窗口 + 接收窗
   setState/reconcile）——透明度滑条还叠加每步整画布 reconcile，是拖动卡顿
   的主要来源。落盘（localStorage.setItem）保持同步：亚毫秒级、且「写入即
   持久」是全项目共享的同步契约（测试与直接读方依赖）。跨窗 emit 走 150ms
   尾随防抖 + pagehide/隐藏冲刷；同窗口 CHANGE_EVENT 保持即时（UI 实时刷新
   通道，成本可忽略）。 */
const SYNC_DEBOUNCE_MS = 150;
const pendingSync = new Map<string, WidgetConfig>();
const syncTimers = new Map<string, number>();

/** 立即广播某实例的待发配置（无待发时 no-op）。 */
export function flushWidgetConfigSync(instanceId: string): void {
  /* persist-gate 挂起期（恢复备份 pause→导入→resume
     的窗口内）不发射——挂起期本窗的 saveWidgetConfig 被 persistMirrored 拦截
     不写 LS，此刻冲刷现读 LS 读到的是恢复前的旧值，的「冲刷现读」与
     「挂起期不写 LS」组合会把旧值广播给对端。挂起期的尾包随恢复 reload
     一并消失，无需发射。 */
  if (isPersistSuspended()) return;
  const timer = syncTimers.get(instanceId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    syncTimers.delete(instanceId);
  }
  if (!pendingSync.has(instanceId)) return;
  pendingSync.delete(instanceId);
  if (isTauri()) {
    /* 发射现读 LS 真值，不再用 pendingSync 里的旧
       快照。根因：槽内快照捕获于最后一次本地编辑，150ms 防抖窗口内远端包被
       采纳（useTauriEvent 只 setConfig、不清槽）后，到点的冲刷会把旧快照整包
       广播出去，回滚对端刚保存的字段——两窗 150ms 内并发编辑同一实例配置时
       必现（groups 通道同族）。选「冲刷现读」而非「远端采纳时清槽」：
       saveWidgetConfig 每次编辑都同步写共享 LS，远端发送方的写也落在同一
       LS——loadWidgetConfig(id) 即「两端最后一次写入」的合并真值，回放它只会
       收敛（等值回声幂等），永不回滚；而清槽无法区分「本地确有更新待发」与
       「陈旧快照」，误清会丢本地编辑。pendingSync 由此退化为「有待发」脏标记，
       快照值不再被消费。 */
    const config = loadWidgetConfig(instanceId);
    /* 静默 catch 改上报（保持不中断语义）——配置
       广播丢失时其他窗口要等重启/下次编辑才追上，留证据可排查。 */
    import("@tauri-apps/api/event")
      .then(({ emit }) => emit("sync:widget-config", { instanceId, config }))
      .catch((err: unknown) => console.error("[widget-config] sync emit failed", err));
  }
}

/**
 * 读取某实例的配置。
 *
 * @param instanceId - 小组件实例 id。
 * @returns 配置对象；缺失/损坏/非纯对象时返回 `{}`（防御原值展开成垃圾键）。
 * @throws 无。
 */
export function loadWidgetConfig(instanceId: string): WidgetConfig {
  try {
    const raw = localStorage.getItem(configKey(instanceId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Only accept a plain object; a primitive/array would spread into garbage
    // keys and could crash widget renderers reading config.<field>.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as WidgetConfig) : {};
  } catch {
    return {};
  }
}

/**
 * 持久化某实例配置并广播变更。落盘（persistMirrored）同步；跨窗 Tauri 事件
 * 150ms 尾随防抖（见文件头「跨窗广播防抖」）；本窗口 CustomEvent 即时。
 *
 * @param instanceId - 小组件实例 id。
 * @param config - 完整配置对象（整体覆写，非增量）。
 * @returns 无。
 */
export function saveWidgetConfig(instanceId: string, config: WidgetConfig) {
  // 小组件配置属用户数据，写入即请求防抖镜像同步（连续调整滑块只落一次）。
  persistMirrored(configKey(instanceId), JSON.stringify(config));
  pendingSync.set(instanceId, config);
  const existing = syncTimers.get(instanceId);
  if (existing !== undefined) window.clearTimeout(existing);
  syncTimers.set(
    instanceId,
    window.setTimeout(() => {
      syncTimers.delete(instanceId);
      flushWidgetConfigSync(instanceId);
    }, SYNC_DEBOUNCE_MS)
  );
  notifyWidgetConfigChanged(instanceId, config);
}

/** 本窗口小组件配置变更事件名（供跨组件订阅其它小组件的配置变化）。 */
export const CHANGE_EVENT = "focus-desk:widget-config-changed";

/** 通知本窗口监听该 instanceId 的小组件重读配置。跨窗口同步不走这里——
 *  emit 已收归防抖 flush（saveWidgetConfig），避免滑条拖动逐帧整包广播。 */
export function notifyWidgetConfigChanged(instanceId: string, _config?: WidgetConfig) {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: instanceId }));
  } catch {
    // ignore
  }
}

/* 防抖窗口收尾：窗口关闭（pagehide）与转入隐藏时冲刷全部待发广播，
   其他窗口不丢最后一次调整。 */
if (typeof window !== "undefined") {
  const flushAllPending = () => {
    for (const id of [...syncTimers.keys()]) flushWidgetConfigSync(id);
  };
  window.addEventListener("pagehide", flushAllPending);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushAllPending();
  });
}

/**
 * 读取并订阅某实例配置（hook）。
 * 同窗口经 CHANGE_EVENT 实时更新；跨窗口监听 `sync:widget-config`，
 * 远端载荷非纯对象时回退本地权威副本（防畸形载荷击穿渲染）。
 *
 * @param instanceId - 小组件实例 id。
 * @returns `{ config, update }`：当前配置与增量合并函数
 *          （update(patch) 合并后自动持久化 + 广播）。
 *
 * @example
 * `tsx
 * const { config, update } = useWidgetConfig(instanceId);
 * <Toggle checked={config.showTags !== false} onChange={(v) => update({ showTags: v })} />
 * `
 */
export function useWidgetConfig(instanceId: string) {
  const [config, setConfig] = useState<WidgetConfig>(() => loadWidgetConfig(instanceId));
  // 最新值镜像：update 据此算 next，既保持 update 引用稳定（仅随 instanceId 变），
  // 又不必把副作用塞进 setState updater。
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === instanceId) {
        setConfig(loadWidgetConfig(instanceId));
      }
    };
    window.addEventListener(CHANGE_EVENT, onChanged);
    return () => window.removeEventListener(CHANGE_EVENT, onChanged);
  }, [instanceId]);

  // 跨窗口：设置窗口保存配置后，桌面层的小组件立即收到并应用。
  useTauriEvent<{ instanceId: string; config?: unknown }>("sync:widget-config", (payload) => {
    if (payload?.instanceId !== instanceId) return;
    // 远端载荷此前不做形状校验直接 setConfig——畸形
    // 载荷（原始值/数组）会展开成垃圾键击穿小组件渲染。非纯对象时回退
    // 读取本窗口持久化的权威副本。
    const incoming = payload.config;
    const next =
      incoming && typeof incoming === "object" && !Array.isArray(incoming)
        ? (incoming as WidgetConfig)
        : loadWidgetConfig(instanceId);
    setConfig(next);
  });

  const update = useCallback(
    (patch: Partial<WidgetConfig>) => {
      // updater 必须纯函数：saveWidgetConfig（localStorage 写 + Tauri mirror 广播）
      // 放进 updater 会在 StrictMode 下双跑（CHANGE_EVENT 双派发、sync:widget-config
      // 双发）。改为从镜像 ref 取最新值、先 set 再落盘。
      const next = { ...configRef.current, ...patch };
      configRef.current = next;
      setConfig(next);
      saveWidgetConfig(instanceId, next);
    },
    [instanceId]
  );

  return { config, update };
}
