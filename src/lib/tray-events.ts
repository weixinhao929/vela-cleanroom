import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isPrimaryWidgetWindow, isTauri, openSettingsWindow } from "./tauri";
import { notifyUser } from "./notifications";
import { sqliteRepo } from "./persistence/sqlite";
import { flushMirrorSync } from "./local-backup";
import { useAppStore } from "../store/app-store";
import { useSettingsStore } from "../store/settings-store";
import { useWidgetStore } from "../widget/widget-store";
import { t } from "../i18n-lite";
import { showToast } from "../components/ToastHost";
import { reportPersistError } from "./persist-error";

/** Shared handler for tray / shortcut toggles: starts or pauses the pomodoro,
 *  and if a focus start was blocked (no event selected) tells the user why. */
function togglePomodoroFromSystem() {
  const started = useAppStore.getState().togglePomodoro();
  if (!started) {
    void notifyUser(t("无法开始专注"), t("请先在番茄钟小组件中选择一个专注事件。"));
  }
}

/**
 * 订阅托盘/快捷键事件并分发到各 store（中介者模式）。
 *
 * 番茄钟 toggle、备份、编辑模式切换这类「单点驱动」事件只在
 * 主小组件窗口（widget-0）处理，其余窗口不再各自触发，从根上消除会话
 * 双写、通知 ×N 与幽灵报错；「呼出设置」「恢复后整体 reload」则全窗口处理。
 *
 * @returns 无（副作用型 hook）；浏览器开发模式为 no-op。
 * @throws 无（订阅失败静默忽略；卸载时退订全部已建立监听）。
 *
 * @example
 * `tsx
 * // App.tsx 顶层挂载一次：
 * useTrayEvents();
 * `
 */
export function useTrayEvents() {
  useEffect(() => {
    if (!isTauri()) return;

    const primary = isPrimaryWidgetWindow();

    const unsubs: (() => void)[] = [];
    let disposed = false;

    /* 监听注册改逐个 await + 入列——旧实现
       Promise.all 任一 reject 时整组 unlisten 丢失，且 IIFE 无 .catch 直接
       unhandledrejection；已注册的监听全部泄漏（托盘/快捷键从此失联直到
       reload）。失败先拆已注册者再上报（不中断后续窗口逻辑）；成功路径与
       cleanup 迭代同一数组，unlisten 幂等，重复拆除无害。 */
    const register = async (job: Promise<() => void>): Promise<void> => {
      unsubs.push(await job);
    };

    void (async () => {
      try {
        if (primary) {
          await register(
            listen("tray:toggle-pomodoro", () => {
              togglePomodoroFromSystem();
            })
          );
          await register(
            listen("tray:backup", () => {
              // 镜像先同步（补齐 localStorage 备份盲区），落盘交给 Rust 去重。
              flushMirrorSync()
                // 此前 .catch(...).then(...) 的链序让 mirror 失败
                // 被吞掉后备份照常继续（catch 返回 undefined，then 必然执行），
                // 与注释意图相反。改为成功路径才继续备份；失败时 reportPersistError
                // 已上报，且不产生"盲区备份"。
                .then(() => sqliteRepo.createBackup().then(() => showToast(t("备份完成"), "ok")))
                .catch(reportPersistError("trayBackup"));
            })
          );
          await register(
            listen<string | null>("tray:new-task", (e) => {
              // §4.2 命令面：`vela.exe --new-task "文本"` 经首实例转发时载荷带任务
              // 标题，直接落库（persist-first）；托盘菜单/无文本仍打开输入框。
              const text = typeof e.payload === "string" ? e.payload.trim() : "";
              if (text) {
                useAppStore.getState().addTask(text);
                showToast(`${t("已添加：")}${text}`, "ok");
                return;
              }
              window.dispatchEvent(new CustomEvent("focus-task-input"));
            })
          );
          await register(
            listen("shortcut:toggle-pomodoro", () => {
              togglePomodoroFromSystem();
            })
          );
          await register(
            listen("shortcut:toggle-edit-mode", () => {
              const { editMode, setEditMode } = useWidgetStore.getState();
              setEditMode(!editMode);
            })
          );
          // [ANTICAPTURE]：托盘勾选项翻转防捕获。在
          // widget-0（永远存在）处理：setExtra 完成 localStorage 权威源 +
          // SQLite 镜像落盘，Rust 侧 watcher 随镜像变更对全部窗口重放 affinity，
          // 不依赖设置窗是否打开。
          await register(
            listen<boolean>("tray:anticapture", (e) => {
              if (typeof e.payload !== "boolean") return;
              const { extra, setExtra } = useSettingsStore.getState();
              if (extra.antiCapture !== e.payload) setExtra({ antiCapture: e.payload });
            })
          );
          // [TB-TRAY] ：托盘勾选项 / 快捷键 taskbar:toggle
          // 翻转任务栏总开关。与 anticapture 同款模式在 widget-0 处理——此前
          // 只有设置窗消费，而设置窗「关闭即销毁」：设置窗不在时托盘翻转后
          // localStorage 权威源不更新，下次启动 reconcile 还会用陈旧 LS 反向
          // 覆盖镜像，用户操作被静默撤销。setTaskbar 落 LS + 防抖镜像 +
          // sync:settings 广播；Rust 侧 apply 由托盘 worker 自己驱动，设置窗
          // 若开着，TaskbarConfigSync 对账不等时自动补齐（apply 失败的重试
          // 路径也在这里）。
          await register(
            listen<boolean>("tray:taskbar-enabled", (e) => {
              if (typeof e.payload !== "boolean") return;
              const { general, setTaskbar } = useSettingsStore.getState();
              if (general.taskbar.enabled !== e.payload) setTaskbar({ enabled: e.payload });
            })
          );
        }

        // 所有窗口都需处理：呼出设置（幂等聚焦）与完整备份恢复后的整体重载
        // （每个 WebView 都要 reload 才能拿到新数据）。
        await register(
          listen("tray:open-settings", () => {
            void openSettingsWindow();
          })
        );
        await register(
          listen("app:reload-all", () => {
            window.location.reload();
          })
        );
      } catch (err) {
        // 先拆已注册者防泄漏（未挂载卸载则由下方 cleanup 兜底），再上报。
        unsubs.forEach((f) => f());
        console.error("[tray-events] listen chain interrupted:", err);
        return;
      }
      if (disposed) {
        unsubs.forEach((f) => f());
      }
    })();

    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, []);
}
