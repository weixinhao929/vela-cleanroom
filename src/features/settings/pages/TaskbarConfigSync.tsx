/* eslint-disable react-refresh/only-export-components -- 同 TaskbarPage：本文件
   同时导出组件与对账常量/纯函数（单测与页面共用）。 */
/**
 * 生效链路（模式 B，照 App.tsx ShortcutConfigSync）——自
 * TaskbarPage.tsx 拆出：本组件与页面 UI 无共享状态，独立成文件后页面 chunk
 * 与单测边界更清晰；TaskbarPage 仍 re-export 保持既有导入路径。
 *
 * 仅设置窗挂载；订阅 general.taskbar → get_taskbar_config 对账 → 不同才
 * apply_taskbar_config 整包下发。apply 返回的非致命失败项与 Err 均 toast
 * 提示，UI 不因空壳期恒 Err 而中断。
 */
import { useEffect, useRef } from "react";
import { invoke, isTauri } from "../../../lib/tauri";
import { showToast } from "../../../components/ToastHost";
import { t } from "../../../i18n-lite";
import { normalizeTaskbar, useSettingsStore, type TaskbarSettings } from "../../../store/settings-store";

/** 对账防抖：拖动透明度 / 半径期间切片连续变化，静默此时长后只对账 + apply 一次
 *  （与 settings-store scheduleSave 同窗口；「防抖内连续拖动只触发一次」）。 */
export const TASKBAR_APPLY_DEBOUNCE_MS = 350;

/** 两侧均经 normalizeTaskbar 归一后比较：抹平键序 / `inactiveAppearance: null`
 *  等序列化差异（normalizeTaskbar 现对 monitorOverrides 键排序，与 Rust
 *  HashMap 序列化序无关）。 */
export function taskbarConfigEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeTaskbar(a)) === JSON.stringify(normalizeTaskbar(b));
}

/** 在飞链路的串行队列——apply 内部 wait_ready 最长 10s，两次
 * 快速改动产生的并发链即使都有 token 门禁，也已派发的旧 apply 仍可能晚于新
 * apply 在 Rust 侧落定（命令侧无排序保证），引擎停在旧配置。每条链等前一
 * 条 settle（含失败）后才发车，且发车前再验 token：排队期间被取代的链直接
 * 跳过。最终语义：引擎最后落定的必然是最新配置。 */
let chainTail: Promise<void> = Promise.resolve();

export function TaskbarConfigSync() {
  const taskbar = useSettingsStore((s) => s.general.taskbar);
  const seqRef = useRef(0);
  useEffect(() => {
    if (!isTauri() || window.location.hash !== "#/settings") return;
    const seq = ++seqRef.current;
    const timer = window.setTimeout(() => {
      const run = async (): Promise<void> => {
        /* get 与 apply 的失败分开报——读失败被报成「应用失败」
           会误导排障方向（原文案把两种失败混在一个 catch 里）。 */
        let stage: "read" | "apply" = "read";
        try {
          const rust = await invoke<TaskbarSettings>("get_taskbar_config");
          if (seq !== seqRef.current) return;
          if (rust && taskbarConfigEquals(rust, taskbar)) return;
          stage = "apply";
          const failed = await invoke<string[]>("apply_taskbar_config", { config: taskbar });
          if (seq !== seqRef.current) return;
          if (failed && failed.length > 0)
            showToast(t("任务栏配置部分未生效：{parts}", { parts: failed.join("、") }), "error");
        } catch (err) {
          if (seq !== seqRef.current) return;
          showToast(
            stage === "read"
              ? t("任务栏配置读取失败：{err}", { err: String(err) })
              : t("任务栏配置应用失败：{err}", { err: String(err) }),
            "error"
          );
        }
      };
      // 排队串行：前一条 settle（成功或失败）后本条才发车。
      chainTail = chainTail.then(run, run);
    }, TASKBAR_APPLY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [taskbar]);
  return null;
}
