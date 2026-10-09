/**
 * （组合根瘦身）：设置→Rust 单向推送桥 + 设置窗专属水合/对账组件。
 * 职责原居 App.tsx，按域拆出；行为与注释原样迁移。
 */
import { useEffect } from "react";
import { invoke, isTauri } from "../../lib/tauri";
import { createSerialChain } from "../../lib/serial-chain";
import { useSettingsStore } from "../../store/settings-store";
import { SHORTCUT_ACTIONS, normalizeAccelerator, toRustAccelerator } from "../../lib/shortcuts";
import { useWidgetStore, readPersistedSettingsScreen } from "../../widget/widget-store";
import { resolveWindowKind } from "../window-kind";

/**
 * Hydrates the widget store in the settings window so it can list, configure
 * and manage the same widgets that live on the desktop layer. The settings
 * window renders SettingsView (not WidgetCanvas), so it must populate the
 * shared widget store itself.
 */
export function WidgetHydrate() {
  useEffect(() => {
    const store = useWidgetStore.getState();
    // then 无 catch 会让 hydrate 失败变成 unhandledrejection 进崩溃日志
    //（本组件没有可降级的 UI，仅记日志）。
    void store
      .hydrate()
      .then(() => {
        // 恢复上次管理的屏幕分区：设置窗口默认只看主屏（screen 0），多显示器
        // 下用户上次切到外接屏管理时，重启后应回到同一屏（分区不存在时
        // switchScreen 会按该屏已存数据重建，拔掉的屏数据仍在，安全）。
        const saved = readPersistedSettingsScreen();
        if (saved !== "0" && saved !== useWidgetStore.getState().screenId) {
          useWidgetStore.getState().switchScreen(saved);
        }
      })
      .catch(console.error);
  }, []);
  return null;
}

/* （对账链串行化）：连续改键时两个 get→apply 链交错（上一轮的 get 未返回、
   下一轮已 apply），Rust 注册态在两次 apply 之间漂移。模块级 in-flight 链把
   每轮对账排成队列（同 local-backup runMirrorSync 的范式）；run 内部吞 IPC
   异常，链条永不 reject。实现经 lib/serial-chain 的共享串行链（与 SQLite 写
   队列、歌词单飞锁同内核）。 */
const shortcutSyncChain = createSerialChain();

/**
 * §4.5 快捷键配置对账（仅设置窗挂载）：store.shortcuts 每次变化（录制保存/
 * 导入/远端同步/重置后重启）把整表下发给 Rust 重注册；与 Rust 当前配置等价
 * 时跳过 IPC。注册失败（组合被其他应用占用）经 `shortcut:register-failed`
 * → SystemFeedbackListeners toast 反馈，无需在此重复提示。
 */
export function ShortcutConfigSync() {
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const isSettings = resolveWindowKind() === "settings";
  useEffect(() => {
    if (!isTauri() || !isSettings) return;
    const sameAsRust = (rust: Record<string, string>) =>
      SHORTCUT_ACTIONS.every((a) => normalizeAccelerator(rust[a] ?? "") === normalizeAccelerator(shortcuts[a]));
    // 入队而非直发：链上排队等前一轮 get→apply 完成后再取当前注册态对账
    //（闭包捕获的 shortcuts 是本轮入队时的快照，末轮总是最新表）。
    void shortcutSyncChain.enqueue(() =>
      invoke<Record<string, string>>("get_shortcut_config")
        .then((rust) => {
          if (sameAsRust(rust ?? {})) return null;
          const config = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, toRustAccelerator(shortcuts[a])]));
          return invoke<string[]>("apply_shortcut_config", { config });
        })
        .catch(() => {
          // Rust 侧另有 shortcut:register-failed 广播；这里只吞 IPC 异常。
        })
    );
  }, [shortcuts, isSettings]);
  return null;
}

/**
 * 媒体监控行为偏好下发：settings.general.media 变更（含挂载首帧）
 * 单向推送给 Rust media watcher（独占播放开关 + 会话黑名单）。持久化在前
 * 端设置层；Rust 只保存运行期副本，重启后由本 hook 的首帧推送恢复。幂等
 * 推送（set 而非 toggle），多窗口并发调用无副作用。
 */
export function useMediaPrefsSync() {
  const media = useSettingsStore((s) => s.general.media);
  const pauseOthers = media?.pauseOthers ?? false;
  const blockedSessions = media?.blockedSessions ?? [];
  /* blockedSessions 是整节替换的数组（每次广播/落盘后引用必变），直接进
     依赖数组会让每个无关广播包都重发一次 set_media_behavior。改用内容摘要
     （NUL join——AUMID 不含 \u0000）作依赖。 */
  const blockedKey = blockedSessions.join("\u0000");
  useEffect(() => {
    if (!isTauri()) return;
    /* set_media_behavior 带 require_trusted（settings/widget/snip/
       taskbar-net），quick-note 等非受信窗的推送恒被拒绝——只产生失败 IPC
       与静默 reportPersistError。设置发起窗与小组件窗已覆盖推送，这里跳过。 */
    const kind = resolveWindowKind();
    if (kind !== "settings" && kind !== "widget" && kind !== "snip" && kind !== "taskbar-net") {
      return;
    }
    /* 推送失败此前被 .catch 静默吞掉且无对账路径。先 get_media_behavior
       回读对账，Rust 侧停留旧值（IPC 失败/水合前推默认值覆盖镜像初值的启动
       窗口）时立即重推；回读失败按不一致处理推一次。每轮 effect 都对账
       （设置变更低频，多一次廉价读无碍），与 Rust 侧 30s 镜像重读互补。 */
    void (async () => {
      let mismatch = true;
      try {
        const r = await invoke<{ pauseOthers: boolean; blockedSessions: string[] }>("get_media_behavior");
        mismatch = r.pauseOthers !== pauseOthers || r.blockedSessions.join("\u0000") !== blockedKey;
      } catch {
        /* 回读失败：按不一致处理，重推一次 */
      }
      if (!mismatch) return;
      void invoke("set_media_behavior", {
        pauseOthers,
        blockedSessions
      }).catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- blockedKey 是 blockedSessions 的内容摘要（见上注释）
  }, [pauseOthers, blockedKey]);
}

/**
 * 把「双击空白桌面切换小组件层显隐」设置单向推送到
 * Rust 鼠标钩子（幂等，多窗口并发调用无副作用）。启动与设置变化都生效，
 * 避免「设置里关掉后重启又变回开」。
 */
export function useDesktopDoubleClickSync() {
  const enabled = useSettingsStore((s) => s.general.desktopDoubleClick) !== false;
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_desktop_double_click", { enabled }).catch(() => {});
  }, [enabled]);
}
