/**
 * [PASTE]（ZTools 借鉴 #1）命令面板的粘贴态输入路由。
 *
 * ZTools 搜索框的核心输入模型：粘贴或拖入内容后进入三种互斥粘贴态
 * （文本芯片 / 文件列表 / 图片），再按载荷类型匹配动作。Vela 落地：
 *  - 粘贴文本 → 存为便签 / 建任务 / 网页搜索 /（URL 时）打开网址；
 *  - 粘贴或拖入文件 → 打开 / 加入快捷方式组件 / 复制路径 / 打开所在位置 /
 *    移入回收站 /（图片文件时）存入图库；
 *  - 粘贴图片 → 存入图库（字节经 gallery_import_bytes 入库）/ 复制图片。
 *
 * 状态管理与 CommandPalette 的 open 态同款（模块级单值 + 订阅）：
 * 面板与超级面板（#11）共用同一份动作构建器。shortcuts 实例查找经
 * {@link registerPayloadSinks} 注入（避免本模块反向 import widget-store
 * 造成主包 chunk 纠缠）。
 */
import { isTauri, invoke } from "./tauri";
import { loadNotes, pickQuickNoteTarget, saveNotes, type Note } from "../widget/notes-store";
import { loadCustomShortcuts } from "../widget/shortcuts-shared";
import { loadWidgetConfig, saveWidgetConfig } from "../widget/widget-config";
import { useWidgetStore } from "../widget/widget-store";
import type { Command } from "./commands";
import type { SearchEngineId } from "./spotlight";

/** 三种互斥粘贴态。 */
export type PalettePayload =
  | { kind: "text"; text: string }
  | { kind: "files"; paths: string[] }
  | { kind: "image"; name: string; dataUrl: string };

/* ---- 模块级状态（与 paletteOpen 同款） ---- */
let payload: PalettePayload | null = null;
const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of [...listeners]) fn();
}
export function subscribePayload(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function palettePayload(): PalettePayload | null {
  return payload;
}
export function setPalettePayload(next: PalettePayload | null): void {
  payload = next;
  notify();
}

/** WebView2 里 File 对象可能带宿主路径（Tauri 拖放注入）；能拿到才构成
 *  files 态，纯 blob 降级 image 态。 */
function filePathOf(f: File): string | undefined {
  return (f as File & { path?: string }).path;
}

/** 从 paste/drop 事件提取 payload（无有效内容为 null）。 */
export function payloadFromTransfer(dt: DataTransfer | null): PalettePayload | null {
  if (!dt) return null;
  const files = Array.from(dt.files ?? []);
  if (files.length > 0) {
    const paths = files.map(filePathOf).filter((p): p is string => !!p);
    if (paths.length > 0) return { kind: "files", paths };
    if (files.length === 1 && files[0].type.startsWith("image/")) {
      return {
        kind: "image",
        name: files[0].name || "image.png",
        dataUrl: URL.createObjectURL(files[0])
      };
    }
    return null;
  }
  const text = dt.getData?.("text/plain") ?? "";
  if (text.trim()) return { kind: "text", text: text.trim() };
  return null;
}

/** 敏感长文本截断（便签/任务标题都有长度上限语义）。 */
export const MAX_PAYLOAD_TEXT = 8_000;

/** 纯 URL 判定（与 Rust is_pure_url 同口径：整段就是一个 http(s)/www 链接）。 */
export function isPureUrl(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  return /^https?:\/\//i.test(t) || /^www\./i.test(t);
}

/** 绝对路径判定（「前往文件夹」直达用；容忍首尾引号）。 */
export function isAbsolutePath(text: string): boolean {
  const t = text.trim().replace(/^["']|["']$/g, "");
  return /^[a-zA-Z]:[\\/]/.test(t) || /^\\\\/.test(t);
}

/** 找到第一个快捷方式组件实例 id（无则 null；widget-store 是纯 store，
 *  引入不拖组件 chunk）。 */
function firstShortcutsInstance(): string | null {
  return useWidgetStore.getState().instances.find((i) => i.type === "shortcuts")?.id ?? null;
}

async function toast(title: string, message = ""): Promise<void> {
  try {
    const { pushAppToast } = await import("../components/ToastHost");
    const { t } = await import("../i18n-lite");
    pushAppToast(t(title), message ? t(message) : "", "info");
  } catch {
    // ignore
  }
}

/** 存为便签（速记同款：挑便签数最多的实例，无实例落兜底桶）。 */
export function appendQuickNote(text: string): void {
  const target = pickQuickNoteTarget();
  const note: Note = { id: crypto.randomUUID(), text, updatedAt: new Date().toISOString() };
  saveNotes(target, [note, ...loadNotes(target)]);
  void toast("已存入便签");
}

/** 把一个文件/URL 加入快捷方式组件（无实例时 toast 提示）。 */
export async function addToShortcuts(path: string, label: string): Promise<boolean> {
  const id = firstShortcutsInstance();
  if (!id) {
    void toast("未找到快捷方式组件", "先在画布添加快捷方式组件");
    return false;
  }
  const config = loadWidgetConfig(id);
  const cur = loadCustomShortcuts(config);
  const kind: "file" | "folder" | "url" = isPureUrl(path)
    ? "url"
    : path.endsWith("/") || path.endsWith("\\")
      ? "folder"
      : "file";
  const next = [...cur, { id: crypto.randomUUID(), label, path, kind }];
  saveWidgetConfig(id, { ...config, customShortcuts: next });
  return true;
}

/** 图片 dataUrl → 字节 → 图库（gallery_import_bytes）。 */
async function importImageToGallery(dataUrl: string, name: string): Promise<void> {
  const blob = await fetch(dataUrl).then((r) => r.blob());
  const buf = new Uint8Array(await blob.arrayBuffer());
  await invoke("gallery_import_bytes", { bytes: Array.from(buf), name });
  void toast("已存入图库");
}

/**
 * 构建当前 payload 的动作命令段（面板与超级面板共用）。
 * @param tr 翻译函数
 * @param opts 引擎 / 网页搜索动作 / 面板收起回调
 */
export function buildPayloadCommands(
  tr: (zh: string) => string,
  opts: {
    engine: SearchEngineId;
    openWeb: (engine: SearchEngineId, q: string) => void;
    close: () => void;
  }
): Command[] {
  if (!payload) return [];
  const { close } = opts;
  const group = tr("粘贴内容");
  if (payload.kind === "text") {
    const text = payload.text.slice(0, MAX_PAYLOAD_TEXT);
    const cmds: Command[] = [
      {
        id: "paste-note",
        label: tr("存为便签"),
        group,
        keywords: ["note", "便签", "paste", "粘贴"],
        run: () => {
          close();
          appendQuickNote(text);
        }
      },
      {
        id: "paste-task",
        label: tr("创建任务"),
        group,
        keywords: ["task", "todo", "任务", "待办"],
        run: () => {
          close();
          void import("../store/app-store").then(({ useAppStore }) => {
            useAppStore.getState().addTask(text.split("\n")[0].slice(0, 200));
            void toast("已创建任务");
          });
        }
      },
      {
        id: "paste-search",
        label: tr("搜索该内容"),
        group,
        keywords: ["search", "搜索"],
        run: () => {
          close();
          opts.openWeb(opts.engine, text.split("\n")[0].slice(0, 300));
        }
      }
    ];
    if (isPureUrl(text)) {
      cmds.unshift({
        id: "paste-open-url",
        label: tr("打开网址"),
        group,
        hint: text.slice(0, 60),
        keywords: ["open", "url", "网址", "链接"],
        run: () => {
          close();
          if (isTauri()) void invoke("open_path", { path: text }).catch(() => {});
        }
      });
    }
    return cmds;
  }
  if (payload.kind === "files") {
    const paths = payload.paths.slice(0, 32);
    const first = paths[0] ?? "";
    const many = paths.length > 1;
    const label = many ? tr("{n} 个文件").replace("{n}", String(paths.length)) : first;
    const cmds: Command[] = [
      {
        id: "paste-files-open",
        label: tr("打开"),
        group,
        hint: label,
        keywords: ["open", "打开"],
        run: () => {
          close();
          if (isTauri()) for (const p of paths.slice(0, 8)) void invoke("open_path", { path: p }).catch(() => {});
        }
      },
      {
        id: "paste-files-shortcut",
        label: tr("加入快捷方式组件"),
        group,
        keywords: ["shortcut", "快捷方式", "pin"],
        run: () => {
          close();
          void (async () => {
            let ok = 0;
            for (const p of paths.slice(0, 8)) if (await addToShortcuts(p, p.split(/[\\/]/).pop() ?? p)) ok++;
            if (ok > 0) void toast("已加入快捷方式");
          })();
        }
      },
      {
        id: "paste-files-copy-path",
        label: tr("复制路径"),
        group,
        keywords: ["copy", "path", "复制", "路径"],
        run: () => {
          close();
          if (isTauri()) void invoke("copy_text_to_clipboard", { text: paths.join("\n") }).catch(() => {});
          void toast("已复制路径");
        }
      },
      {
        id: "paste-files-reveal",
        label: tr("打开所在文件夹"),
        group,
        keywords: ["folder", "reveal", "explorer", "所在"],
        run: () => {
          close();
          if (isTauri() && first) void invoke("reveal_in_explorer", { path: first }).catch(() => {});
        }
      },
      {
        id: "paste-files-recycle",
        label: tr("移入回收站"),
        group,
        keywords: ["delete", "recycle", "删除", "回收站"],
        run: () => {
          close();
          if (isTauri())
            void (async () => {
              const { confirmDialog } = await import("../components/PromptDialog");
              const ok = await confirmDialog({
                title: tr("移入回收站"),
                message: tr("将移入 {n} 个文件").replace("{n}", String(paths.length)),
                danger: true
              });
              if (!ok) return;
              for (const p of paths) await invoke("delete_to_recycle_bin", { path: p }).catch(() => {});
              void toast("已移入回收站");
            })();
        }
      }
    ];
    // 单个图片文件可直入图库。
    if (paths.length === 1 && /\.(png|jpe?g|webp|gif|bmp)$/i.test(first)) {
      cmds.splice(1, 0, {
        id: "paste-files-gallery",
        label: tr("存入图库"),
        group,
        keywords: ["gallery", "图库", "image"],
        run: () => {
          close();
          if (isTauri())
            void invoke("gallery_import_file", { path: first })
              .then(() => toast("已存入图库"))
              .catch(() => {});
        }
      });
    }
    return cmds;
  }
  // image blob：入图库 / 复制到剪贴板。
  const img = payload;
  return [
    {
      id: "paste-image-gallery",
      label: tr("存入图库"),
      group,
      keywords: ["gallery", "图库", "image", "图片"],
      run: () => {
        close();
        if (isTauri()) void importImageToGallery(img.dataUrl, img.name).catch(() => {});
      }
    },
    {
      id: "paste-image-copy",
      label: tr("复制图片"),
      group,
      keywords: ["copy", "复制"],
      run: () => {
        close();
        // blob URL 不是 dataURL：Rust 收 base64 段，这里转一次。
        if (isTauri())
          void (async () => {
            const blob = await fetch(img.dataUrl).then((r) => r.blob());
            const reader = new FileReader();
            const dataUrl = await new Promise<string>((resolve) => {
              reader.onload = () => resolve(String(reader.result));
              reader.readAsDataURL(blob);
            });
            await invoke("copy_image_to_clipboard", { dataUrl }).catch(() => {});
            void toast("已复制图片");
          })();
      }
    }
  ];
}
