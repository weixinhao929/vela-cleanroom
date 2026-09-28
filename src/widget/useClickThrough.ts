import { useEffect } from "react";
import { invoke, isTauri } from "../lib/tauri";
import { useWidgetStore } from "./widget-store";

/**
 * Elements that should capture mouse events while the widget layer is
 * click-through. The Rust poller uses the reported rectangles to decide when
 * to let the window receive input.
 */
const SELECTOR =
  "button, input, select, textarea, a, [data-interactive], [role=button], [contenteditable], label, .widget-card";

/** 覆盖层显示期间（右键菜单 / 添加面板等）整个视口必须可交互，
 *  否则点击空白处会穿透到桌面，覆盖层无法通过点击外部关闭。
 *  widget-context-menu（快捷方式条目就地菜单）同语义：菜单容器与菜单项之间
 *  的间隙、以及菜单打开到下一轮穿透轮询之间的窗口期都不能退回穿透，
 *  否则实机上「右键 → 点菜单项」的首击会被吞掉。
 *  wcfg-popover（B1 就地配置弹层）同语义：打开期间外点用于关闭弹层。
 *  sfolder-popup（快捷方式文件夹弹层）同语义。 */
const OVERLAY_SELECTOR =
  ".ctx-menu, .widget-menu, .widget-context-menu, .widget-gallery-overlay, .fd-prompt-overlay, .gal-viewer, .cmd-palette, .wcfg-popover, .folder-popup, .sfolder-popup, .tm-cheatsheet";

type Rect = { x: number; y: number; w: number; h: number; id?: string; z?: number };

/**
 * 「命中区已变、请重采」事件：几何只靠 transform / translate 过渡改变而 DOM 没有任何
 * class / style 变化时（灵动岛 QQ 式收合 / 弹出滑到位），MutationObserver 收不到
 * 通知、900ms 兜底也因 dirty 未置位而早退，上报的仍是过渡起点的矩形——收合后岛
 * 原来那块区域会变成吃掉点击的死区。发起方在过渡结束后 dispatch 一次即可。
 */
export const HIT_RECTS_DIRTY_EVENT = "vela:hit-rects-dirty";

/* ══ 拖拽会话挂起（P-perf 三轮）══
   卡片拖拽每帧写 --drag-dx/--drag-dy（style 属性），旧实现会放大成每帧一次
   全文档采集（querySelectorAll + 逐元素 gBCR + JSON 签名）——拖拽期间穿透
   命中矩形本就无需更新（指针被 capture、窗口整层可交互语义不变）。发起方在
   拖拽会话开始/结束调用 suspend/resume；resume 时补一次采集，期间累积的
   几何变化一次追平。 */
let hitSuspendCount = 0;
const onResumeCallbacks = new Set<() => void>();

/** 挂起命中矩形采集（拖拽会话开始；可重入）。 */
export function suspendHitRects(): void {
  hitSuspendCount += 1;
}

/** 恢复命中矩形采集（拖拽会话结束）并请求一次补采集。 */
export function resumeHitRects(): void {
  hitSuspendCount = Math.max(0, hitSuspendCount - 1);
  if (hitSuspendCount === 0) for (const cb of onResumeCallbacks) cb();
}

/**
 * Continuously reports the bounding boxes of interactive elements to the Rust
 * core so the click-through hit tester can enable input exactly over controls.
 * Only active inside the Tauri runtime and when the widget layer is not in
 * edit mode (edit mode keeps the whole window interactive).
 *
 * 坐标系说明：`getBoundingClientRect()` 返回的是**视口 CSS 像素**（已包含
 * 界面缩放的视觉效果），而 Rust 侧把光标物理坐标除以 scale_factor 得到的
 * 也是视口 CSS 像素 —— 两者天然同坐标系，直接上报即可。此前按 zoom 因子
 * 反向缩放矩形会导致命中区域与组件视觉位置错位（缩放 ≠100% 时点空白处
 * 也会命中小组件，触发误置顶）。
 */
/**
 * 持续向 Rust 上报可交互元素的包围盒，使「鼠标穿透」命中测试只在控件
 * 上方启用输入、其余区域直达桌面。仅在 Tauri 且非编辑模式时活动；
 * rAF 节流 + 内容指纹去重（无变化不上报），DOM/尺寸变化与 hover 状态
 * 翻转触发重采集；覆盖层打开期间上报全视口矩形保持窗口可交互。
 *
 * @param active - 是否启用穿透模式（false 时 no-op）。
 * @returns 无（副作用型 hook）。
 */
export function useClickThrough(active: boolean) {
  useEffect(() => {
    if (!isTauri() || !active) return;

    let raf = 0;
    let lastSent = "";
    /** DOM 变化 / 尺寸变化后置位；下一轮采集消费。 */
    let dirty = true;
    /** 上次采集时处于 hover 的卡片 id（hover 会改变命中矩形——上方 34px 扩展区）。 */
    let lastHoverId: string | null = null;
    /* style-only 变更的节流闸（P-perf 三轮）：番茄钟进度环 / 音乐进度条 /
       电平条等常驻 style 写在桌面层 1-5Hz 起步，拖拽期每帧一次——全部放大成
       全量采集。节流为「领先 1 次 + 尾随合帧」，至多 STYLE_COLLECT_GAP_MS
       一次；结构性 / class / disabled 变化仍走同步路径不受影响。 */
    const STYLE_COLLECT_GAP_MS = 200;
    let lastStyleCollectAt = 0;
    let styleTrailingTimer = 0;

    const collect = () => {
      const regions: Rect[] = [];

      // 覆盖层打开期间：上报一个覆盖整个视口的矩形，保证窗口保持可交互。
      if (document.querySelector(OVERLAY_SELECTOR)) {
        regions.push({
          x: 0,
          y: 0,
          w: window.innerWidth,
          h: window.innerHeight
        });
      }

      document.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
        // 开启「鼠标穿透」的卡片：其自身及内部所有控件都不上报交互矩形，
        // 点击直达桌面。closest 包含自身，卡片本体（.widget-card）同样命中。
        if (el.closest("[data-click-through='true']")) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const rect: Rect = { x: r.x, y: r.y, w: r.width, h: r.height };
          // Widget cards carry their id + stacking z so the native poller can
          // bring the clicked widget to the front directly (race-proof).
          if (el.classList.contains("widget-card")) {
            rect.id = el.dataset.widgetId;
            rect.z = Number(el.style.zIndex) || 0;
            // 仅当卡片处于 hover 且未编辑时，把命中矩形向上扩展 34px 覆盖
            // 快捷操作条区域（top:-30px）。这样操作条出现前后该区域都保持
            // 可交互，鼠标从卡片移到右上角设置按钮时窗口不会退回穿透——
            // 消除设置按钮首击被吞的竞态。**只在 hover 时扩展**：若无条件
            // 扩展，每张卡上方会永久形成一条 34px 的"死区"，把桌面空白处
            // 也变成不可点击（用户反馈"空白地方不能点击"的诱因之一）。
            // 快捷操作条本身（Portal 到 body、data-interactive）也会被单独
            // 上报，因此鼠标进入操作条后该区域由操作条自身矩形接管。
            // （本 effect 在编辑模式下提前 return，collect 只在非编辑模式运行，
            // 因此无需再判断 editMode。）
            if (el.matches(":hover")) {
              // H-审计修复：快捷操作条在卡片贴近屏幕顶部时翻转到卡片下方
              // （WidgetCard: y<40 → top=y+h+4）。命中矩形的扩展方向必须
              // 跟随翻转，否则顶部行卡片上方恒有 34px 桌面点击死区、而真正
              // 的操作条区域反而不受保护。
              const inst = useWidgetStore.getState().instances.find((i) => i.id === el.dataset.widgetId);
              if ((inst?.y ?? Number.POSITIVE_INFINITY) < 40) {
                rect.h += 34;
              } else {
                rect.y -= 34;
                rect.h += 34;
              }
            }
          }
          regions.push(rect);
        }
      });

      const sig = JSON.stringify(regions);
      if (sig !== lastSent) {
        lastSent = sig;
        invoke("set_interactive_regions", { regions }).catch(() => {});
      }
    };

    /** 增量门控：无 DOM/尺寸变化且 hover 卡片未变时直接跳过全量采集。
     *  鼠标划过桌面时 pointermove 每帧都会进来，旧实现每帧做一次全文档
     *  querySelectorAll + JSON.stringify 签名比对，组件越多开销越大；
     *  现在绝大多数帧只花一次 `.widget-card:hover` 查询。 */
    const maybeCollect = () => {
      /* 拖拽会话挂起：只置脏不采集，resume 时统一补一次。 */
      if (hitSuspendCount > 0) return;
      const hoverId = document.querySelector<HTMLElement>(".widget-card:hover")?.dataset.widgetId ?? null;
      if (!dirty && hoverId === lastHoverId) return;
      lastHoverId = hoverId;
      dirty = false;
      collect();
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(maybeCollect);
    };

    /** style-only 变更的节流调度：距上次采集 ≥ GAP 立即采，否则合帧到尾沿。 */
    const scheduleStyleCollect = () => {
      const elapsed = performance.now() - lastStyleCollectAt;
      if (elapsed >= STYLE_COLLECT_GAP_MS) {
        lastStyleCollectAt = performance.now();
        schedule();
        return;
      }
      if (!styleTrailingTimer) {
        styleTrailingTimer = window.setTimeout(() => {
          styleTrailingTimer = 0;
          lastStyleCollectAt = performance.now();
          schedule();
        }, STYLE_COLLECT_GAP_MS - elapsed);
      }
    };

    maybeCollect();
    /* 拖拽挂起结束后的补采集（resumeHitRects → 这里置脏 + 立即采一次）。 */
    const onResume = () => {
      dirty = true;
      schedule();
    };
    onResumeCallbacks.add(onResume);
    // DOM 变化分级处理（P1 合帧优化）：
    //  - 结构性变化（节点增删，如快捷操作条/菜单/弹层 Portal 到 body）与
    //    class/disabled 翻转（可能切换可见性 → 命中矩形集合变化）**同步**
    //    重算并上报——鼠标刚移到新出现的可交互元素上时窗口必须立刻退出
    //    穿透，否则首击被吞（点击落到桌面），原语义保留。
    //  - 纯 style 属性变化（番茄钟/倒计时进度环每秒写 transform、时钟类
    //    组件的 CSS 变量 tick——桌面层常驻 1-5Hz）合帧到 rAF：每帧至多一次
    //    全量采集（querySelectorAll + 逐元素 gBCR + 签名序列化），签名去重
    //    不变；一帧的延迟对 style 变化无首击风险（几何矩形一般不变，即便
    //    变了也只影响 16ms 窗口）。
    const mo = new MutationObserver((records) => {
      dirty = true;
      const needsSync = records.some(
        (r) =>
          (r.type === "childList" && (r.addedNodes.length > 0 || r.removedNodes.length > 0)) ||
          (r.type === "attributes" && r.attributeName !== "style")
      );
      if (needsSync) maybeCollect();
      else scheduleStyleCollect();
    });
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "disabled"]
    });
    const ro = new ResizeObserver(() => {
      dirty = true;
      schedule();
    });
    ro.observe(document.body);
    const onLayoutChange = () => {
      dirty = true;
      schedule();
    };
    window.addEventListener("resize", onLayoutChange);
    window.addEventListener("scroll", onLayoutChange, true);
    window.addEventListener(HIT_RECTS_DIRTY_EVENT, onLayoutChange);
    // 鼠标移动时也重算一次（限帧）：光标移入刚出现的快捷操作条/菜单时，
    // 立即上报其交互矩形，把「穿透→可交互」的切换提前到下一次轮询，
    // 避免首击落在仍处于穿透状态的窗口上被吞掉。
    window.addEventListener("pointermove", schedule, true);

    // Periodic fallback in case layout changes without mutation events.
    // maybeCollect 无变化时早退，因此 900ms 兜底的常态开销只是一次
    // `.widget-card:hover` 查询。
    const iv = setInterval(maybeCollect, 900);
    /* J-1 兜底加固：纯 class 驱动的 CSS 过渡（收合/弹出以外的岛几何变化）
       不产生任何 mutation，dirty 不置位 → 900ms 兜底也早退，命中矩形可
       无限期停留在过渡起点——磁贴视觉已到位但点击穿透直达桌面（实测
       「通知中心磁贴点击零响应」的候选成因）。每 5s 强制一次全量重采
       （签名去重照旧，无变化不发 IPC）：0.2Hz 的 querySelectorAll+gBCR
       相对 P-perf 优化针对的每帧路径可忽略，换来任何来源的陈旧矩形
       至多 5s 自愈。 */
    const forceIv = setInterval(() => {
      if (hitSuspendCount > 0) return;
      dirty = true;
      collect();
    }, 5000);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
      clearInterval(forceIv);
      window.clearTimeout(styleTrailingTimer);
      onResumeCallbacks.delete(onResume);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", onLayoutChange);
      window.removeEventListener("scroll", onLayoutChange, true);
      window.removeEventListener(HIT_RECTS_DIRTY_EVENT, onLayoutChange);
      window.removeEventListener("pointermove", schedule, true);
    };
  }, [active]);
}
