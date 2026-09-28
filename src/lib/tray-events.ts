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

/** 设置窗口的 URL 为 index.html#/settings（与 App.tsx / TaskbarConfigSync 同判据）。 */
function isSettingsWindow(): boolean {
  return window.location.hash === "#/settings";
}

/**
 * 订阅托盘/快捷键事件并分发到各 store（中介者模式）。
 *
 * D-2/D-8：番茄钟 toggle、备份、编辑模式切换这类「单点驱动」事件只在
 * 主小组件窗口（widget-0）处理，其余窗口不再各自触发，从根上消除会话
 * 双写、通知 ×N 与幽灵报错；「呼出设置」「恢复后整体 reload」则全窗口处理。
 *
 * @returns 无（副作用型 hook）；浏览器开发模式为 no-op。
 * @throws 无（订阅失败静默忽略；卸载时退订全部已建立监听）。
 *
 * @example
 * ```tsx
 * // App.tsx 顶层挂载一次：
 * useTrayEvents();
 * ```
 */
export function useTrayEvents() {
  useEffect(() => {
    if (!isTauri()) return;

    const primary = isPrimaryWidgetWindow();

    let unsubs: (() => void)[] = [];
    let disposed = false;

    void (async () => {
      const jobs: Promise<() => void>[] = [];

      if (primary) {
        jobs.push(
          listen("tray:toggle-pomodoro", () => {
            togglePomodoroFromSystem();
          }),
          listen("tray:backup", () => {
            // 镜像先同步（补齐 localStorage 备份盲区），落盘交给 Rust 去重。
            flushMirrorSync()
              // P2（审计修复）：此前 .catch(...).then(...) 的链序让 mirror 失败
              // 被吞掉后备份照常继续（catch 返回 undefined，then 必然执行），
              // 与注释意图相反。改为成功路径才继续备份；失败时 reportPersistError
              // 已上报，且不产生"盲区备份"。
              .then(() => sqliteRepo.createBackup().then(() => showToast(t("备份完成"), "ok")))
              .catch(reportPersistError("trayBackup"));
          }),
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
          }),
          listen("shortcut:toggle-pomodoro", () => {
            togglePomodoroFromSystem();
          }),
          listen("shortcut:toggle-edit-mode", () => {
            const { editMode, setEditMode } = useWidgetStore.getState();
            setEditMode(!editMode);
          })
        );
      }

      // 所有窗口都需处理：呼出设置（幂等聚焦）与完整备份恢复后的整体重载
      // （每个 WebView 都要 reload 才能拿到新数据）。
      jobs.push(
        listen("tray:open-settings", () => {
          void openSettingsWindow();
        }),
        listen("app:reload-all", () => {
          window.location.reload();
        })
      );

      // [TB-TRAY] F-11：托盘勾选项 / 快捷键 taskbar:toggle 翻转了任务栏总开关。
      // 只在设置窗处理（任务栏配置的唯一编辑入口，与 TaskbarConfigSync 同窗）：
      // setTaskbar 落盘 localStorage 权威源（Rust 只回写了 SQLite 镜像，重启时
      // hydrate 以 localStorage 为准）并触发既有 sync:settings 跨窗口同步；
      // TaskbarConfigSync 随后对账 get_taskbar_config——Rust 已先行 apply，
      // 配置一致即跳过，不会二次下发。
      if (isSettingsWindow()) {
        jobs.push(
          listen<boolean>("tray:taskbar-enabled", (e) => {
            if (typeof e.payload !== "boolean") return;
            const { general, setTaskbar } = useSettingsStore.getState();
            if (general.taskbar.enabled !== e.payload) setTaskbar({ enabled: e.payload });
          })
        );
      }

      const fns = await Promise.all(jobs);
      if (disposed) {
        fns.forEach((f) => f());
        return;
      }
      unsubs = fns;
    })();

    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, []);
}
