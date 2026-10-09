/**
 * 跨屏布局复制：把 fromScreen 的视图列表 / 每视图实例与编组 / 活动视图
 * 整体搬到 toScreen。此前副屏首用只有手动「导出布局 JSON → 切屏 → 导入」
 * （且导出仅当前视图），用户预期的「把主屏搬过来」没有直达路径。
 *
 * 复制范围与理由：
 *  - 复制：views 列表、每视图 instances/groups、活动视图；
 *  - 不复制：dock（岛配置按屏独立，覆盖目标屏的岛偏好属越权）、模板、
 *    回收站（布局结构语义，跟屏没有意义）。
 * 实例 id 保留：两屏实例共用同一数据桶（便签等 per-instance 数据在两屏
 * 同步呈现）——「同一块便签放两块屏」即本特性的预期语义；需要独立副本
 * 时用布局模板（applyTemplate 会重造 id 并搬数据，见 instance-data.ts）。
 *
 * 落盘：localStorage（权威）+ SQLite 镜像键（与 saveInstances/saveViews
 * 同键型，键型定义集中在 widget-store 的私有 helpers，此处按同构复刻并
 * 注明对应关系）；目标屏窗口冷启动 hydrate 即读到。
 * 实时性：目标屏窗口若存活，emit 一条 sync:widgets（带目标 screenId），
 * 接收方 applyRemoteWidgets 按屏采纳活动视图（非活动视图经落盘在下次
 * 切换/重启生效）。
 */
import { isTauri } from "../lib/tauri";
import { sqliteRepo } from "../lib/persistence/sqlite";
import { isPersistSuspended } from "../lib/persist-gate";
import { useWidgetStore, type ViewDef, type WidgetInstance } from "./widget-store";
import { isValidGroup, sanitizeGroups } from "./widget-groups";
import { scheduleWidgetWindowReconcile } from "./window-reconcile";

type CopyResult = { views: number; instances: number } | null;

/** localStorage 布局键族（与 widget-store 私有 helpers 同构，改动需两处同步）。 */
const lsKeys = {
  views: (s: string) => `focus-desk.screen.${s}.widgets.views.v1`,
  activeView: (s: string) => `focus-desk.screen.${s}.widgets.view.v1`,
  layout: (s: string, v: string) => `focus-desk.screen.${s}.widgets.${v}.v1`,
  groups: (s: string, v: string) => `focus-desk.screen.${s}.groups.${v}.v1`,
  /** trash 键与 widget-store 的 trashKeyFor 同构（仅读取，不落盘）。 */
  trash: (s: string) => `focus-desk.screen.${s}.widgets.trash.v1`
};
/** SQLite 镜像键族（同上，对应 dbViewsKey/dbLayoutKey/dbGroupsKey）。 */
const dbKeys = {
  views: (s: string) => `widget:views:${s}`,
  layout: (s: string, v: string) => `widget:layout:${s}:${v}`,
  groups: (s: string, v: string) => `widget:groups:${s}:${v}`
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * 执行复制。源屏没有任何视图（从未使用过）时返回 null（调用方提示）；
 * 目标屏原有视图与布局被整体替换——与「导出→导入」语义一致，且布局
 * 时间线（timeline 键按屏独立）不受影响，源屏可随时再来一次。
 */
export function copyScreenLayout(fromScreen: string, toScreen: string): CopyResult {
  if (!fromScreen || !toScreen || fromScreen === toScreen) return null;
  const views = readJson<{ id: string; name: string }[]>(lsKeys.views(fromScreen), []);
  if (views.length === 0) return null;
  const activeView = (() => {
    try {
      return localStorage.getItem(lsKeys.activeView(fromScreen)) ?? views[0].id;
    } catch {
      return views[0].id;
    }
  })();

  let instanceTotal = 0;
  const perView: { view: string; instances: string; groups: string | null }[] = [];
  for (const v of views) {
    const instances = readJson<unknown[]>(lsKeys.layout(fromScreen, v.id), []);
    const groups = localStorage.getItem(lsKeys.groups(fromScreen, v.id));
    instanceTotal += Array.isArray(instances) ? instances.length : 0;
    perView.push({
      view: v.id,
      instances: JSON.stringify(Array.isArray(instances) ? instances : []),
      groups
    });
  }

  /* 整表写挂闸门（口径）——恢复备份进行中，
     迟到的跨屏复制不得把恢复前的布局整表盖回共享 LS 与 SQLite 镜像；
     下方的 sync:widgets 广播与内存 setState 照常（内存态短暂跟进无害，
     恢复以 reload 收尾）。 */
  const persistAllowed = !isPersistSuspended();
  if (persistAllowed) {
    try {
      localStorage.setItem(lsKeys.views(toScreen), JSON.stringify(views));
      localStorage.setItem(lsKeys.activeView(toScreen), activeView);
      for (const pv of perView) {
        localStorage.setItem(lsKeys.layout(toScreen, pv.view), pv.instances);
        if (pv.groups !== null) localStorage.setItem(lsKeys.groups(toScreen, pv.view), pv.groups);
        else localStorage.removeItem(lsKeys.groups(toScreen, pv.view));
      }
    } catch {
      // localStorage 不可用（极端）时 SQLite 镜像仍可救；上抛由调用方提示。
    }

    if (isTauri()) {
      void sqliteRepo.setSetting(dbKeys.views(toScreen), JSON.stringify(views)).catch(() => {});
      for (const pv of perView) {
        void sqliteRepo.setSetting(dbKeys.layout(toScreen, pv.view), pv.instances).catch(() => {});
        if (pv.groups !== null) {
          void sqliteRepo.setSetting(dbKeys.groups(toScreen, pv.view), pv.groups).catch(() => {});
        }
      }
    }
  }

  /* 目标屏存活窗口按 applyRemoteWidgets 采纳本包时
     会**无条件覆写** trash（镜像写 trash 键 + setState 整表）——此前硬编码
     trash:[] 随包，等于把目标屏回收站清空。读目标屏 trash 原值随包携带
     （对齐 importScreenLayoutSnapshot 的口径），接收方写回的就是它自己的
     现有回收站，净效应为零。LS trash 键本身仍不落盘（不复制回收站语义
     不变——复制只搬布局结构）。 */
  if (isTauri()) {
    const targetTrashRaw = readJson<unknown>(lsKeys.trash(toScreen), []);
    const targetTrash = Array.isArray(targetTrashRaw) ? targetTrashRaw : [];
    const active = perView.find((pv) => pv.view === activeView) ?? perView[0];
    const groupsOfActive = active.groups ? (JSON.parse(active.groups) as unknown[]) : [];
    void import("@tauri-apps/api/event")
      .then(({ emit }) =>
        emit("sync:widgets", {
          instanceId: `layout-copy-${Date.now()}`,
          rev: 1,
          screenId: toScreen,
          instances: JSON.parse(active.instances),
          groups: groupsOfActive,
          views,
          activeView,
          trash: targetTrash
        })
      )
      /* 静默 catch 改上报（保持不中断语义）——复制
         的即时广播丢失时目标屏窗口要等下次水合才应用，留证据可排查。 */
      .catch((err: unknown) => console.error("[layout-copy] sync:widgets emit failed", err));
  }

  // 设置窗口自身的 widgets store 若正管理目标屏分区（screenId === toScreen），
  // 直接刷新内存态：侧栏「视图/小组件」列表立即反映新视图（applyRemoteWidgets
  // 同款直接 setState——不经 action，不触发各 action 内的落盘钩子）。
  if (useWidgetStore.getState().screenId === toScreen) {
    const active = perView.find((pv) => pv.view === activeView) ?? perView[0];
    // groups 必须随 instances 一起整替：LS/DB/广播三路都带，唯独内存漏掉
    // 会让旧编组（成员 id 已全部换新）悬空到下次水合才被 sanitizeGroups 洗掉。
    const groupsRaw = active.groups ? (JSON.parse(active.groups) as unknown[]) : [];
    const clean = sanitizeGroups(
      Array.isArray(groupsRaw) ? groupsRaw.filter(isValidGroup) : [],
      JSON.parse(active.instances) as WidgetInstance[]
    );
    useWidgetStore.setState({
      views: views as ViewDef[],
      activeView,
      instances: clean.instances,
      groups: clean.groups
    });
  }
  // 目标屏可能还没有 widget-N 窗口（空屏不建窗，sync:widgets 广播无人
  // 接收）——排一次窗口对账让 Rust 按刚写的镜像内容建窗。此前此路径不排
  // 对账，复制成功后目标屏要等重启 / 下次热插拔才出现桌面层。
  //（scheduleWidgetWindowReconcile 自带 isTauri 门控，浏览器模式 no-op。）
  scheduleWidgetWindowReconcile();

  return { views: views.length, instances: instanceTotal };
}
