/**
 * 命令面板的命令目录（buildCommands）与命令类型。
 *
 * 从 CommandPalette.tsx 拆出：速查表（ShortcutCheatsheet）把它当「命令目录」
 * 数据源复用，而组件文件只应导出组件（Fast Refresh 边界）。命令的 run 回调
 * 需要先收起面板，但面板打开态属于组件模块——这里不反向 import 组件，改由
 * 调用方经 `close` 选项注入（速查表只读目录、不执行命令，不传即可）。
 */
import { useWidgetStore } from "../widget/widget-store";
import { useSettingsStore } from "../store/settings-store";
import { useAppStore } from "../store/app-store";
import { pushAppToast } from "../components/ToastHost";
import { openSettingsWindow, isTauri, invoke } from "./tauri";
import { openShortcutCheatsheet } from "./cheatsheet-store";
import { loadWidgetConfig } from "../widget/widget-config";
import { loadCustomShortcuts } from "../widget/shortcuts-shared";
import { listNoteInstances } from "../widget/notes-store";
import { findInstanceIdByType, locateInstanceOnCanvas, locateWidgetCrossWindow } from "../widget/locate-widget";
import { searchMsSettings } from "./ms-settings";

export type Command = {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  hint?: string;
  run: () => void;
  /** 应用项：字母磁贴头像（与启动器小组件无图标时同款配色）。 */
  avatar?: { letter: string; c1: string; c2: string };
  /** 网页兜底项：当前引擎显示名，渲染为可点击切换的芯片。 */
  engineLabel?: string;
  /** 悬停提示（文件项显示完整路径，label 只放文件名）。 */
  title?: string;
};

/** 设置搜索条目（结构化形状——由调用方注入实现，lib 不反向 import features）。 */
export type SettingsSearchEntry = {
  page: string;
  title: string;
  group?: string;
  keywords?: string[];
};

export type BuildCommandsOptions = {
  /** 设置搜索索引的实时查询词（面板输入框内容）。 */
  settingsQuery?: string;
  /** 查询词为空时的回退词（面板模块级暂存的最后一次输入）。 */
  fallbackQuery?: string;
  /** 每条命令执行前先调用：面板传 closeCommandPalette 收起自身；只读目录时不传。 */
  close?: () => void;
  /** 设置索引搜索由调用方注入（lib → features 的全仓唯一反向边，经
   * 依赖注入拆除）；不传则命令目录不含 set- 段。 */
  settingsSearch?: (query: string, limit: number) => SettingsSearchEntry[];
  /** 设置词条命中的行级跳转信道（同上经注入，lib 不反向 import features）：
   *  openSettingsAt 落页后写入 pending 供设置窗滚动定位到具体设置行。 */
  requestSettingsJump?: (page: string, title?: string) => void;
};

const noop = (): void => {};

/** 面板所在窗口为画布窗口时直接定位，否则经事件交给画布窗口执行
 *  （locateInstanceOnCanvas 需要挂载了 WidgetCanvas 的窗口）。 */
function locateInstance(id: string): void {
  const hash = window.location.hash;
  const onCanvas = hash !== "#/settings" && hash !== "#quick-note" && hash !== "#taskbar-net";
  if (onCanvas) locateInstanceOnCanvas(id);
  else locateWidgetCrossWindow(id);
}

/** 定位某类型的组件（找不到该类型组件时不动作）。 */
function locateType(type: string, close: () => void): void {
  const id = findInstanceIdByType(type);
  if (!id) return;
  close();
  locateInstance(id);
}

/** 呼出设置窗口并直达指定页（与 WidgetCard.openConfig 同款双通道）。
 *  title（设置词条标题）可选：携带时落地后行级定位到对应设置行——
 *  jump 由调用方注入（lib 不反向 import features），跨窗事件载荷同步携带。 */
function openSettingsAt(page: string, close: () => void, title?: string, jump?: (p: string, t?: string) => void): void {
  close();
  useSettingsStore.getState().setSettingsPage(page);
  // 浏览器模式（本窗覆盖层）：pending + 同窗事件即可；Tauri 模式下本窗
  // 不渲染设置层，pending 由设置窗经事件侧的 request 重新写入。
  jump?.(page, title);
  try {
    localStorage.setItem("focus-desk.pending-nav", page);
  } catch {
    // best-effort
  }
  if (isTauri()) {
    void openSettingsWindow();
    /* emit 裸链补 catch——导航事件丢失时设置窗仍
       有 localStorage pending-nav 兜底，但 rejection 不该 unhandled。 */
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit("app:navigate-settings", { page, title }))
      .catch((err: unknown) => console.error("[commands] navigate-settings emit failed", err));
  } else {
    useSettingsStore.getState().setSettingsOpen(true);
  }
}

/** 打开添加小组件面板：通过自定义事件交给 WidgetCanvas 处理。 */
function openGallery(close: () => void): void {
  close();
  window.dispatchEvent(new CustomEvent("focus-desk:open-gallery"));
}

/** [SYS]关全部窗口的两段式流：枚举 → 样本确认 → 优雅关闭。
 *  第一段只读（数量 + 最多 5 条标题），确认后才把句柄交给第二段执行（执行
 *  时 Rust 侧会重新校验每个句柄，防确认期间窗口已自关）。 */
async function closeAllWindowsFlow(): Promise<void> {
  try {
    const sum = await invoke<{ count: number; samples: string[]; handles: number[] }>("sys_close_all_stage1");
    if (sum.count <= 0) return;
    const { confirmDialog } = await import("../components/PromptDialog");
    const { t } = await import("../i18n-lite");
    const preview = sum.samples.length > 0 ? `：${sum.samples.join("、")}` : "";
    const suffix = sum.count > sum.samples.length ? t("等") : "";
    const ok = await confirmDialog({
      title: t("关闭全部窗口"),
      message: t("将关闭 {n} 个窗口", { n: sum.count }) + preview + suffix,
      danger: true
    });
    if (!ok) return;
    const closed = await invoke<number>("sys_close_all_execute", { handles: sum.handles });
    const { pushAppToast } = await import("../components/ToastHost");
    pushAppToast(t("已下发关闭"), t("共 {n} 个窗口", { n: closed }), "info");
  } catch {
    // 静默失败（与其它系统动作一致，不打断面板体验）。
  }
}

/**
 * 构建当前可执行的命令快照（面板打开时调用一次；速查表打开时取一次作为
 * 「命令目录」——展示的即面板此刻真正可执行的命令）。
 * settingsQuery：设置搜索索引的实时查询词（审计修复——此前固定为空串，
 * 输入框里输入的内容对设置项完全不生效）。
 */
export function buildCommands(
  tr: (zh: string) => string,
  {
    settingsQuery = "",
    fallbackQuery = "",
    close = noop,
    settingsSearch,
    requestSettingsJump
  }: BuildCommandsOptions = {}
): Command[] {
  const widget = useWidgetStore.getState();
  const app = useAppStore.getState();
  const cmds: Command[] = [];

  // 视图切换（无键盘直达组合：此前 hint 标注的「Ctrl+数字」并无对应处理器，
  // 速查表要求与实际一致，故移除该误导提示）
  for (const v of widget.views) {
    const active = v.id === widget.activeView;
    cmds.push({
      id: `view-${v.id}`,
      label: active
        ? tr("切换到视图「{name}」（当前）").replace("{name}", () => v.name)
        : tr("切换到视图「{name}」").replace("{name}", () => v.name),
      group: tr("视图"),
      keywords: ["view", "视图", v.name],
      run: () => {
        close();
        widget.setActiveView(v.id);
      }
    });
  }

  // 编辑模式
  cmds.push({
    id: "edit-mode",
    label: widget.editMode ? tr("退出编辑模式") : tr("进入编辑模式"),
    group: tr("画布"),
    keywords: ["edit", "编辑", "layout", "布局"],
    run: () => {
      close();
      widget.setEditMode(!widget.editMode);
    }
  });
  cmds.push({
    id: "add-widget",
    label: tr("添加小组件"),
    group: tr("画布"),
    keywords: ["add", "gallery", "添加", "小组件"],
    run: () => openGallery(close)
  });

  // 番茄钟
  cmds.push({
    id: "pomodoro",
    label: app.pomodoro.isRunning ? tr("暂停番茄钟") : tr("开始番茄钟"),
    group: tr("专注"),
    keywords: ["pomodoro", "番茄", "focus", "专注"],
    run: () => {
      close();
      // （失败反馈）：未选专注事件时 toggle 返回 false——托盘路径有
      // 「无法开始专注」提示，命令面板此前静默失败，用户以为点错了。
      if (!app.togglePomodoro()) {
        pushAppToast(tr("无法开始专注"), tr("请先在番茄钟中选择或创建一个专注事件"), "error");
      }
    }
  });

  // 设置
  cmds.push({
    id: "settings",
    label: tr("打开设置窗口"),
    group: tr("设置"),
    keywords: ["settings", "设置", "preference"],
    run: () => {
      close();
      void openSettingsWindow();
    }
  });

  // 数据备份（设置页）
  cmds.push({
    id: "backup",
    label: tr("导出 / 导入备份"),
    group: tr("设置"),
    keywords: ["backup", "备份", "export", "import", "导出", "导入"],
    run: () => openSettingsAt("general", close)
  });

  // [SNIP] 截图：抓光标所在显示器 → 框选标注。
  if (isTauri()) {
    cmds.push({
      id: "screenshot",
      label: tr("截图"),
      group: tr("工具"),
      keywords: ["screenshot", "snip", "截图", "标注", "钉图"],
      run: () => {
        close();
        void invoke("start_snip").catch(() => {});
      }
    });
    // [FULLSCREEN] 全屏展示：投影用大字时钟/倒计时/番茄钟。
    for (const [kind, label] of [
      ["clock", "全屏时钟"],
      ["countdown", "全屏倒计时"],
      ["pomodoro", "全屏番茄钟"]
    ] as const) {
      cmds.push({
        id: `fullscreen-${kind}`,
        label: tr(label),
        group: tr("工具"),
        keywords: ["fullscreen", "投影", "present", "clock", kind],
        run: () => {
          close();
          void invoke("show_fullscreen", { kind }).catch(() => {});
        }
      });
    }

    // [SYS]：系统快捷动作——回桌面 / 任务视图 /
    // 关前台 / 关全部（两段式：先枚举+样本，确认后才执行优雅关闭）。
    cmds.push(
      {
        id: "sys-show-desktop",
        label: tr("显示桌面"),
        group: tr("系统"),
        keywords: ["desktop", "show", "win d", "桌面"],
        run: () => {
          close();
          void invoke("sys_show_desktop").catch(() => {});
        }
      },
      {
        id: "sys-task-view",
        label: tr("任务视图"),
        group: tr("系统"),
        keywords: ["task view", "win tab", "任务视图"],
        run: () => {
          close();
          void invoke("sys_task_view").catch(() => {});
        }
      },
      {
        id: "sys-close-foreground",
        label: tr("关闭前台应用"),
        group: tr("系统"),
        keywords: ["close", "foreground", "关闭", "前台"],
        run: () => {
          close();
          void invoke<boolean>("sys_close_foreground").catch(() => {});
        }
      },
      {
        id: "sys-close-all",
        label: tr("关闭全部窗口"),
        group: tr("系统"),
        keywords: ["close all", "windows", "关闭全部", "全部窗口"],
        run: () => {
          close();
          void closeAllWindowsFlow();
        }
      }
    );

    // [WIN-OPS]/[WIN-ACTIONS]：前台窗口快捷操作与
    // 系统动作（虚拟桌面移动 / 系统代理 / 高对比度）。
    cmds.push(
      {
        id: "win-topmost",
        label: tr("前台窗口置顶切换"),
        group: tr("系统"),
        keywords: ["topmost", "pin", "置顶", "前台"],
        run: () => {
          close();
          void invoke<boolean>("win_toggle_topmost").catch(() => {});
        }
      },
      {
        id: "win-opacity-down",
        label: tr("前台窗口透明度 −10%"),
        group: tr("系统"),
        keywords: ["opacity", "transparent", "透明度", "调淡"],
        run: () => {
          close();
          void invoke<number>("win_adjust_opacity", { step: -10 }).catch(() => {});
        }
      },
      {
        id: "win-opacity-up",
        label: tr("前台窗口透明度 +10%"),
        group: tr("系统"),
        keywords: ["opacity", "transparent", "透明度", "调浓"],
        run: () => {
          close();
          void invoke<number>("win_adjust_opacity", { step: 10 }).catch(() => {});
        }
      },
      {
        id: "win-opacity-reset",
        label: tr("前台窗口透明度还原"),
        group: tr("系统"),
        keywords: ["opacity", "reset", "透明度", "还原"],
        run: () => {
          close();
          void invoke("win_reset_opacity").catch(() => {});
        }
      },
      {
        id: "win-center",
        label: tr("前台窗口居中"),
        group: tr("系统"),
        keywords: ["center", "居中"],
        run: () => {
          close();
          void invoke("win_center_foreground").catch(() => {});
        }
      },
      {
        id: "win-snap-left",
        label: tr("前台窗口贴左半屏"),
        group: tr("系统"),
        keywords: ["snap", "left", "half", "分屏", "左半"],
        run: () => {
          close();
          void invoke("win_snap_foreground", { side: "left" }).catch(() => {});
        }
      },
      {
        id: "win-snap-right",
        label: tr("前台窗口贴右半屏"),
        group: tr("系统"),
        keywords: ["snap", "right", "half", "分屏", "右半"],
        run: () => {
          close();
          void invoke("win_snap_foreground", { side: "right" }).catch(() => {});
        }
      },
      {
        id: "vd-move-left",
        label: tr("前台窗口移到上一虚拟桌面"),
        group: tr("系统"),
        keywords: ["virtual desktop", "vd", "虚拟桌面", "移动"],
        run: () => {
          close();
          void invoke("sys_move_window_virtual_desktop", { direction: "left" }).catch(() => {});
        }
      },
      {
        id: "vd-move-right",
        label: tr("前台窗口移到下一虚拟桌面"),
        group: tr("系统"),
        keywords: ["virtual desktop", "vd", "虚拟桌面", "移动"],
        run: () => {
          close();
          void invoke("sys_move_window_virtual_desktop", { direction: "right" }).catch(() => {});
        }
      },
      {
        id: "sys-proxy",
        label: tr("切换系统代理"),
        group: tr("系统"),
        keywords: ["proxy", "代理", "翻墙"],
        run: () => {
          close();
          void invoke<boolean>("sys_toggle_system_proxy").catch(() => {});
        }
      },
      {
        id: "sys-contrast",
        label: tr("切换高对比度"),
        group: tr("系统"),
        keywords: ["high contrast", "accessibility", "高对比度", "辅助"],
        run: () => {
          close();
          void invoke<boolean>("sys_toggle_high_contrast").catch(() => {});
        }
      }
    );

    // [POWER]电源与会话动作：锁屏/睡眠/注销即时执行；
    // 关机/重启先确认（与 closeAllWindowsFlow 同款两段式）。
    const power = (action: string, danger: boolean) => () => {
      close();
      void (async () => {
        if (danger) {
          const { confirmDialog } = await import("../components/PromptDialog");
          const ok = await confirmDialog({
            title: action === "shutdown" ? tr("关闭电脑") : tr("重启电脑"),
            message: tr("未保存的工作将丢失，确定继续吗？"),
            danger: true
          });
          if (!ok) return;
        }
        await invoke("sys_power_action", { action }).catch(() => {});
      })();
    };
    cmds.push(
      {
        id: "power-lock",
        label: tr("锁定电脑"),
        group: tr("系统"),
        keywords: ["lock", "锁屏", "锁定"],
        run: power("lock", false)
      },
      {
        id: "power-sleep",
        label: tr("睡眠"),
        group: tr("系统"),
        keywords: ["sleep", "suspend", "睡眠", "休眠"],
        run: power("sleep", false)
      },
      {
        id: "power-logoff",
        label: tr("注销"),
        group: tr("系统"),
        keywords: ["logoff", "sign out", "注销"],
        run: power("logoff", true)
      },
      {
        id: "power-shutdown",
        label: tr("关机"),
        group: tr("系统"),
        keywords: ["shutdown", "power off", "关机"],
        run: power("shutdown", true)
      },
      {
        id: "power-restart",
        label: tr("重启电脑"),
        group: tr("系统"),
        keywords: ["reboot", "restart", "重启"],
        run: power("restart", true)
      }
    );
  }

  // 快捷键速查表（[POLISH] D 表：Ctrl+? 覆盖层，命令面板也给一个入口）
  cmds.push({
    id: "cheatsheet",
    label: tr("查看快捷键速查表"),
    group: tr("帮助"),
    keywords: ["shortcut", "hotkey", "快捷键", "keyboard", "速查"],
    hint: "Ctrl+?",
    run: () => {
      close();
      openShortcutCheatsheet();
    }
  });

  // 设置搜索项（复用设置页索引，响应输入框实时 query；实现由调用方注入）
  for (const e of settingsSearch?.(settingsQuery.trim() || fallbackQuery || "", 20) ?? []) {
    cmds.push({
      id: `set-${e.page}-${e.title}`,
      // label/group 走 tr——英文界面按翻译后文本搜得到，列表却显示中文
      //（与设置窗侧栏搜索结果的 tr(r.title)/tr(r.group) 同口径）；组名沿用
      //「设置 · 」前缀拼接格式（同下方 mset 段的「设置页 · 」）。
      label: tr(e.title),
      group: `${tr("设置")} · ${e.group ? tr(e.group) : ""}`,
      keywords: e.keywords,
      hint: e.page,
      run: () => openSettingsAt(e.page, close, e.title, requestSettingsJump)
    });
  }

  /* ---- 内容级搜索（便签 / 待办 / DDL / 书签）----
     32 个组件的内容此前没有统一检索入口（「我那条便签写了什么」无处可查）；
     面板的分组/键盘基建现成，缺的只是数据源。只在有真实查询词时收录
     （空查询首屏不被内容淹没），各源限量防撑爆面板 40 条上限。
     匹配自带（不走面板的 matchCommand——settings 段同款预匹配约定），
     因此调用方按 id 前缀 `content-` 取段。 */
  const cq = (settingsQuery.trim() || fallbackQuery).trim().toLowerCase();
  if (cq) {
    // [MSET]系统设置深链：中文名 / 英文别名 / 拼音首字母
    // 三级匹配，调用方按 id 前缀 `mset-` 取段（与 content- 同款预匹配约定）。
    for (const m of searchMsSettings(cq, 12)) {
      cmds.push({
        id: `mset-${m.page}`,
        label: tr(m.zh),
        group: `${tr("设置页")} · ${tr(m.cat)}`,
        keywords: [m.en, m.zh, "settings", "设置"],
        run: () => {
          close();
          void invoke("open_path", { path: `ms-settings:${m.page}` }).catch(() => {});
        }
      });
    }
    // 待办：全局共享（app-store），落地 = 定位待办组件。
    for (const t of app.tasks.filter((x) => x.title.toLowerCase().includes(cq)).slice(0, 15)) {
      cmds.push({
        id: `content-task-${t.id}`,
        label: t.title,
        group: tr("待办"),
        hint: t.completed ? tr("已完成") : undefined,
        keywords: ["todo", "task", "任务", t.title],
        run: () => locateType("todo", close)
      });
    }
    // 截止日期：全局共享，落地 = 定位 DDL 组件。
    for (const d of app.deadlines.filter((x) => x.title.toLowerCase().includes(cq)).slice(0, 15)) {
      cmds.push({
        id: `content-ddl-${d.id}`,
        label: d.title,
        group: tr("截止日期"),
        keywords: ["ddl", "deadline", "截止", d.title],
        run: () => locateType("deadlines", close)
      });
    }
    // 便签：按实例分键（listNoteInstances 枚举），全文匹配、标题取首行；
    // 落地 = 定位拥有该便签的实例。
    let noteCount = 0;
    for (const { instanceId, notes } of listNoteInstances()) {
      if (noteCount >= 15) break;
      for (const n of notes) {
        if (noteCount >= 15) break;
        const text = n.text ?? "";
        if (!text.toLowerCase().includes(cq)) continue;
        noteCount++;
        cmds.push({
          id: `content-note-${instanceId}-${n.id}`,
          label: text.split("\n")[0].slice(0, 40) || tr("（空便签）"),
          group: tr("便签"),
          keywords: ["note", "便签", text.slice(0, 120)],
          run: () => {
            close();
            locateInstance(instanceId);
          }
        });
      }
    }
    // 书签：按实例分键；这里直接扫 localStorage（键型登记见 instance-data.ts），
    // 静态 import BookmarksWidget 会把组件 chunk 拽进主包。落地 = 系统浏览器打开。
    if (isTauri()) {
      let bmCount = 0;
      const prefix = "focus-desk.bookmarks.";
      for (let i = 0; i < localStorage.length && bmCount < 15; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        let arr: unknown;
        try {
          arr = JSON.parse(localStorage.getItem(key) ?? "[]");
        } catch {
          continue;
        }
        if (!Array.isArray(arr)) continue;
        for (const b of arr) {
          if (bmCount >= 15) break;
          if (!b || typeof b !== "object") continue;
          const { name, url } = b as { name?: unknown; url?: unknown };
          if (typeof name !== "string" || typeof url !== "string") continue;
          if (!name.toLowerCase().includes(cq) && !url.toLowerCase().includes(cq)) continue;
          bmCount++;
          cmds.push({
            id: `content-bm-${key}-${bmCount}`,
            label: name,
            group: tr("书签"),
            hint: url,
            keywords: ["bookmark", "url", "链接", name, url],
            run: () => {
              close();
              void invoke("open_path", { path: url }).catch(() => {});
            }
          });
        }
      }
    }
  }

  /* 收录快捷方式组件里的文件条目。激活 = open_path（同组件点击）。 */
  if (isTauri()) {
    for (const inst of widget.instances) {
      if (inst.type !== "shortcuts") continue;
      for (const s of loadCustomShortcuts(loadWidgetConfig(inst.id))) {
        cmds.push({
          id: `file-${inst.id}-${s.id}`,
          label: s.label || s.path,
          group: tr("桌面文件"),
          keywords: ["file", "文件", "打开", s.label, s.path],
          hint: s.path,
          run: () => {
            close();
            void invoke("open_path", { path: s.path }).catch(() => {});
          }
        });
      }
    }
  }

  return cmds;
}
