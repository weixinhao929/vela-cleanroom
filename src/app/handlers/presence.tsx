/**
 * F7（组合根瘦身）：presence 域全局 handler——空闲淡化 / 空闲降玻璃 /
 * 空闲装饰降级（G-9）。职责原居 App.tsx，按域拆出；行为与注释原样迁移。
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/tauri";
import { useSettingsStore, reapplyTheme } from "../../store/settings-store";
import { setIdleDecor } from "../../lib/idle-decor";

/** presence:state 事件载荷（presence.rs PresenceSnapshot）。focus 域的
 *  GlobalIdlePause 与本域共用同一快照形状。 */
export type PresenceSnapshot = {
  state: "active" | "idle" | "fullscreen";
  idle_secs: number;
  fullscreen: boolean;
  process_name: string;
  window_title: string;
};

/** A2 空闲淡化阈值：presence Idle 达到该秒数且开启「空闲时淡化卡片」时给
 *  根元素挂 .idle-dim（CSS 统一降卡片透明度）。任何键鼠输入都会让 presence
 *  翻回 active（1s 轮询），类随之摘除——淡化只发生在真正无人操作时。 */
const IDLE_DIM_SECS = 60;

/**
 * A2 空闲淡化（空闲淡化规格）：根类翻转而非逐卡订阅——idle
 * 翻转只改一个 class，N 张 memo 卡片零重渲。挂载在每个 widget 窗口
 * （各屏各自淡化自己的卡片）；设置关闭（含运行中关闭）立即摘类恢复。
 * Idle 稳态每 30s 补发一次快照，挂载时已处于空闲也能在下一拍追上。
 */
export function GlobalIdleDim() {
  const enabled = useSettingsStore((s) => s.extra.idleDim);
  useEffect(() => {
    const apply = (dim: boolean) => document.documentElement.classList.toggle("idle-dim", dim);
    if (!isTauri() || !enabled) {
      apply(false);
      return;
    }
    let un: (() => void) | undefined;
    let disposed = false;
    void listen<PresenceSnapshot>("presence:state", (e) => {
      const p = e.payload;
      if (!p) return;
      apply(p.state === "idle" && p.idle_secs >= IDLE_DIM_SECS);
    }).then((f) => {
      if (disposed) f();
      else un = f;
    });
    return () => {
      disposed = true;
      un?.();
      apply(false);
    };
  }, [enabled]);
  return null;
}

/**
 * P2 空闲降玻璃：presence Idle 达到阈值且开启「空闲时降级玻璃」时挂
 * `data-no-glass="1"`（theme-engine 的全局总闸：一次性关掉全部 56 处
 * backdrop-filter，卡片切纯色半透明底）。桌面层常驻显示，人不在时GPU
 * 不再为毛玻璃保留合成纹理；恢复 active 由主题引擎重放归位。
 * 「减少特效」常开时总闸本就是 1，本组件跳过（避免无意义的属性翻转）。
 * Idle 稳态每 30s 补发一次快照：空闲期间主题引擎若重放了外观（改主题/
 * 外观设置），下一拍会把降级重新挂上。
 */
export function GlobalIdleGlass() {
  const enabled = useSettingsStore((s) => s.extra.idleGlassOff);
  const reduceEffects = useSettingsStore((s) => s.general.reduceEffects);
  useEffect(() => {
    if (!isTauri() || !enabled || reduceEffects) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void listen<PresenceSnapshot>("presence:state", (e) => {
      const p = e.payload;
      if (!p) return;
      if (p.state === "idle" && p.idle_secs >= IDLE_DIM_SECS) {
        document.documentElement.setAttribute("data-no-glass", "1");
      } else if (p.state === "active") {
        reapplyTheme();
      }
    }).then((f) => {
      if (disposed) f();
      else un = f;
    });
    return () => {
      disposed = true;
      un?.();
      // 卸载（开关关闭）恢复生效外观，不把降级泄漏成永久状态。
      reapplyTheme();
    };
  }, [enabled, reduceEffects]);
  return null;
}

/**
 * G-9 空闲装饰降级：presence Idle ≥30s 时两路降载——
 *  ① data-fx-off 追加 ambientMotion token：项目已把纯装饰动画族（封面
 *    呼吸/旋转、天气光晕、倒计时脉冲、习惯火苗、发声点、画廊漂移、岛内
 *    跑马）标注在该特效闸下，追加 token 即整族暂停，零新增 CSS 规则；
 *    功能性警示（课表冲突环等）不受闸，照常运转。
 *  ② setIdleDecor(true)：时钟组件（lib/idle-decor）降为 30s 档并收起
 *    秒位，秒级翻牌重渲停止。
 * 不设开关：无可见状态残留（任何输入立即恢复），纯性能收益。空闲期间
 * 若用户改外观设置，applySettings 会按设置重写 data-fx-off（idle token
 * 暂时丢失）——Idle 稳态每 30s 补发快照，下一拍自动补挂，自愈。
 * 恢复 active 走 reapplyTheme() 重建属性（与 GlobalIdleGlass 同款收尾，
 * 幂等可并存）。
 */
const IDLE_DECOR_SECS = 30;

export function GlobalIdleDecor() {
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    let disposed = false;
    void listen<PresenceSnapshot>("presence:state", (e) => {
      const p = e.payload;
      if (!p) return;
      const idle = p.state === "idle" && p.idle_secs >= IDLE_DECOR_SECS;
      setIdleDecor(idle);
      if (idle) {
        const root = document.documentElement;
        const cur = root.getAttribute("data-fx-off") ?? "";
        if (!cur.split(/\s+/).includes("ambientMotion")) {
          root.setAttribute("data-fx-off", `${cur ? `${cur} ` : ""}ambientMotion`.trim());
        }
      } else {
        reapplyTheme();
      }
    }).then((f) => {
      if (disposed) f();
      else un = f;
    });
    return () => {
      disposed = true;
      un?.();
      setIdleDecor(false);
      reapplyTheme();
    };
  }, []);
  return null;
}
