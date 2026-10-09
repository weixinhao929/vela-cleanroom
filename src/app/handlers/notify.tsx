/**
 * （组合根瘦身）：通知/反馈域全局 handler——番茄钟完成与里程碑通知、
 * 系统级反馈 toast、OS 通知点击落地、钉图事件桥。职责原居 App.tsx，按域
 * 拆出；行为与注释原样迁移。
 */
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri, invoke } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { pomodoroNotification, sourceNotify } from "../../lib/notifications";
import { useAppStore } from "../../store/app-store";
import { useWidgetStore } from "../../widget/widget-store";
import { saveWidgetConfig } from "../../widget/widget-config";
import { SOURCE_TO_WIDGET, findInstanceIdByType, locateInstanceOnCanvas } from "../../widget/locate-widget";
import { useT } from "../../i18n-lite";

/**
 * Fires completion / milestone notifications for the Pomodoro timer at the app
 * level so they work even when the widget is hidden or on another view.
 */
export function PomodoroNotifier() {
  /* （rerender）：此前订阅整 pomodoro 对象 → 运行期 1Hz 重渲。effect 实际
     只用标量值，改为标量 selector（对象内其它字段变化不再触发）。 */
  const isRunning = useAppStore((s) => s.pomodoro.isRunning);
  const remainingSeconds = useAppStore((s) => s.pomodoro.remainingSeconds);
  const mode = useAppStore((s) => s.pomodoro.mode);
  const timerMode = useAppStore((s) => s.pomodoro.timerMode);
  const focusMinutes = useAppStore((s) => s.pomodoroConfig.focusMinutes);
  const countupGoalMinutes = useAppStore((s) => s.pomodoroConfig.countupGoalMinutes);
  const autoCycle = useAppStore((s) => s.pomodoroConfig.autoCycle);
  const advanceGate = useAppStore((s) => s.pomodoroConfig.advanceGate);
  /* 完成信号：由 tickPomodoro 的「倒计时走完」分支显式自增。此前用
     「remaining 跳回满额」推断换段，与「记录中断 / 重置」（同样把 remaining
     重置满额且 isRunning:false）不可区分——用户放弃专注会立刻收到假的
     「阶段完成，休息一下」通知与铃声；autoCycle 关闭时 focus→focus 又没有
     mode 变化可依赖。只有这个信号在各分支下都准确。 */
  const completedSeq = useAppStore((s) => s.pomodoroCompletedSeq);
  const lastCompletedMode = useAppStore((s) => s.pomodoroLastCompletedMode);
  const tr = useT();
  const prevCompletedSeqRef = useRef(completedSeq);
  const lastMilestoneRef = useRef(0);

  useEffect(() => {
    const prevSeq = prevCompletedSeqRef.current;
    prevCompletedSeqRef.current = completedSeq;
    /* 不得用 store 里的 timerMode 做门控——completedSeq 自增时它已经是
       **下一段**的计时方式（reducer 换段时写入 next.timerMode）。专注偏好为
       正计时的用户在休息（倒计时）结束时会因下一段 timerMode="countup" 而
       收不到任何完成通知。seq 只在倒计时完成分支自增，无需再按模式过滤。 */
    if (completedSeq !== prevSeq) {
      // 休息结束处于「等用户回座」时，告知会自动开始。
      const waitActivity = useAppStore.getState().pomodoro.awaitingActivity;
      // （文案如实）：按推进门/循环开关区分下一段语义——autoCycle 关闭时
      // 下一段是新专注而非休息；confirm 门不会自动开始；文案不再恒称「休息
      // 一下，再继续前进」。
      let body: string;
      if (lastCompletedMode === "focus") {
        if (!autoCycle) body = tr("本段专注已完成，随时开始下一段。");
        else if (advanceGate === "confirm") body = tr("专注结束，确认后进入休息。");
        else if (advanceGate === "wait-activity") body = tr("进入休息；休息结束后等你回座再继续。");
        else body = tr("休息一下，再继续前进。");
      } else {
        body = waitActivity ? tr("休息结束——回来后自动开始下一轮专注。") : tr("休息结束，开始下一轮专注。");
      }
      pomodoroNotification({
        kind: "mode-switch",
        title: tr("阶段完成"),
        body,
        // 事件级音效——结束的是专注还是休息，各有各的铃声。
        sound: { event: lastCompletedMode === "focus" ? "focus-end" : "break-end" }
      });
    }
  }, [completedSeq, lastCompletedMode, autoCycle, advanceGate, tr]);

  // Countup milestone: elapsed focus time crossed a full target duration.
  // 目标分钟数可配（0 = 跟随专注时长），每越过一个目标整数倍提醒一次。
  // The message reports the ACTUAL elapsed minutes (not the rounded-down
  // multiple of the target) so it never under-reports.
  useEffect(() => {
    // 正计时段归零 = 新的一段（「结束并记录」后 mode 仍是 focus、remaining 归 0），
    // 必须清里程碑，否则下一段到达第 1 个里程碑时与旧值相等而不提醒。
    if (timerMode === "countup" && remainingSeconds === 0) lastMilestoneRef.current = 0;
    if (timerMode === "countup" && mode === "focus" && isRunning) {
      const goalSec = Math.max(60, (countupGoalMinutes > 0 ? countupGoalMinutes : focusMinutes) * 60);
      const elapsedMin = Math.floor(remainingSeconds / 60);
      const milestone = Math.floor(remainingSeconds / goalSec);
      if (milestone > 0 && milestone !== lastMilestoneRef.current) {
        lastMilestoneRef.current = milestone;
        pomodoroNotification({
          kind: "milestone",
          title: tr("专注提醒"),
          body:
            milestone === 1
              ? tr("已达目标 {n} 分钟，继续保持。").replace("{n}", String(elapsedMin))
              : tr("已专注 {n} 分钟，继续保持。").replace("{n}", String(elapsedMin))
        });
      }
    } else if (mode !== "focus") {
      // Reset milestone tracking only when the focus segment actually ENDED
      // (switched to a break). Pausing/resuming keeps the milestone so the
      // notification doesn't re-fire for the same elapsed time.
      lastMilestoneRef.current = 0;
    }
  }, [remainingSeconds, isRunning, mode, timerMode, focusMinutes, countupGoalMinutes, tr]);

  return null;
}

/**
 * 监听 Rust 侧的系统级反馈事件并给用户一次性提示（#/ #）：
 * - app:exit-blocked：退出被常驻策略阻止时告知用户如何真正退出；
 * - shortcut:register-failed：某个全局快捷键被其他应用占用。
 */
export function SystemFeedbackListeners() {
  const tr = useT();
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unsubs: (() => void)[] = [];
    void listen<number | null>("app:exit-blocked", () => {
      void sourceNotify("app", tr("Vela 仍在运行"), tr("已阻止退出。如需真正退出，请通过托盘菜单选择「退出」。"));
    })
      .then((f) => {
        if (disposed) f();
        else unsubs.push(f);
        /* 监听失败兜底，不留未处理 rejection。 */
      })
      .catch((err: unknown) => console.error("[notify] listen failed:", err));
    void listen<string>("shortcut:register-failed", (e) => {
      void sourceNotify(
        "app",
        tr("快捷键注册失败"),
        tr("快捷键 {key} 可能已被其他应用占用。").replace("{key}", () => e.payload)
      );
    })
      .then((f) => {
        if (disposed) f();
        else unsubs.push(f);
        /* 监听失败兜底，不留未处理 rejection。 */
      })
      .catch((err: unknown) => console.error("[notify] listen failed:", err));
    /* 兜底拉取：启动期 register_all 在 Rust setup 阶段执行，
       shortcut:register-failed 广播早于本监听器挂载即丢（用户零感知）——
       监听就绪后主动拉一次后端暂存的失败清单（shortcuts.rs 的
       REGISTER_FAILURES；Rust 侧另有 5s 退避重试，重试成功即从清单
       移除，此处通常为空）。上限 3 条防通知风暴，其余以事件路径补。 */
    void invoke<string[]>("get_shortcut_register_failures")
      .then((fails) => {
        if (disposed || !Array.isArray(fails)) return;
        for (const key of fails.slice(0, 3)) {
          void sourceNotify(
            "app",
            tr("快捷键注册失败"),
            tr("快捷键 {key} 可能已被其他应用占用。").replace("{key}", () => key)
          );
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubs.forEach((f) => f());
    };
  }, [tr]);
  return null;
}

/**
 * OS 通知点击落地（os_notify.rs 基建的消费端）：Rust 在 WinRT 激活回调里
 * 已把小组件层窗口 show 出来；这里按载荷定位来源组件——instanceId 精确落，
 * 否则按 source 映射组件类型找第一个实例。挂在全部桌面层窗口：广播抵达
 * 每个屏，实例所在的窗口自然命中，跨屏落地免费；未命中（app 来源/无该类
 * 组件）时仅亮层，不动作。
 */
type OsNotifyActivation = { source?: string; instanceId?: string; action?: string };

export function OsNotifyActivationHandler() {
  useTauriEvent<OsNotifyActivation>("os-notify:activated", (p) => {
    let id = p?.instanceId ?? null;
    if (!id) {
      const type = SOURCE_TO_WIDGET[p?.source ?? ""];
      if (type) id = findInstanceIdByType(type);
    }
    if (id) locateInstanceOnCanvas(id);
  });
  return null;
}

/**
 * [SNIP] 钉图事件桥：snip 覆盖窗导出贴图后，
 * 由 primary 桌面层窗口把 pin 组件放上画布（尺寸 1:1，超大时等比钳到
 * 屏幕 80%）；布局变化经既有 sync:widgets 自动同步到其它窗口。
 */
export function PinOnSnipHandler() {
  useTauriEvent<{ path: string; w: number; h: number }>("snip:pin", (payload) => {
    if (!payload?.path || typeof payload.w !== "number" || typeof payload.h !== "number") return;
    const maxW = Math.max(240, window.innerWidth * 0.8);
    const maxH = Math.max(180, window.innerHeight * 0.8);
    const ratio = Math.min(1, maxW / payload.w, maxH / payload.h);
    const size = {
      w: Math.max(80, Math.round(payload.w * ratio)),
      h: Math.max(60, Math.round(payload.h * ratio))
    };
    const id = useWidgetStore.getState().addWidget("pin", size);
    if (id) saveWidgetConfig(id, { src: payload.path, natW: payload.w, natH: payload.h });
  });
  return null;
}
