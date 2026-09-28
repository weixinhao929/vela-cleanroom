/**
 * OS 文件拖放订阅（快捷方式等支持「从桌面拖进来」的小组件共用）。
 *
 * Windows 资源管理器 / 桌面拖动文件悬停到小组件卡片上时，Rust 侧点击穿透
 * 命中测试会把窗口切为可交互（widget.rs），Tauri 的 drag-drop 处理器随即
 * 收到 enter / over / drop 事件（全局物理坐标 + 文件路径）。本钩子把物理
 * 坐标换算成本窗口视口 CSS 像素（(pos − 窗口原点) / scaleFactor），订阅者
 * 拿坐标对自己的根元素 getBoundingClientRect 做命中即可——同一窗口里有
 * 多个实例时互不干扰。
 */
import { useEffect, useRef } from "react";
import { isTauri } from "../lib/tauri";
import { useFileDragStore } from "./file-drag-store";

export type OsFileDropEvent = {
  type: "enter" | "over" | "drop";
  /** drop / enter 时携带的文件路径；over 可能为空数组。 */
  paths: string[];
  /** 光标在本窗口视口内的 CSS 像素坐标。 */
  x: number;
  y: number;
};

export function useOsFileDrop(onEvent: (e: OsFileDropEvent) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let origin: { x: number; y: number } | null = null;
    let scale = 1;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) => {
        if (disposed) return;
        // Tauri API 解析失败（非桌面宿主/测试环境注入缺失）时放弃订阅：
        // 拖放本来就是增强能力，绝不产生未处理的异步异常。
        let win: ReturnType<typeof getCurrentWebviewWindow>;
        try {
          win = getCurrentWebviewWindow();
        } catch {
          return;
        }
        // 窗口原点 / 缩放懒取一次即可（全屏窗口不移动）；失败则忽略事件，
        // 避免拿错误坐标误加条目。
        const syncGeometry = () =>
          Promise.all([win.outerPosition(), win.scaleFactor()])
            .then(([pos, sf]) => {
              origin = { x: pos.x, y: pos.y };
              scale = sf;
            })
            .catch(() => {});
        void syncGeometry();
        void win
          .onDragDropEvent((ev) => {
            // enter = 一次拖动的起点：重取窗口原点/缩放，显示器热插拔或窗口
            // 被移动后缓存的几何信息不会把坐标换算错位（over/drop 复用本次结果）。
            // 全局拖拽态（file-drag-store）不依赖坐标：enter/over 置位、leave/drop
            // 复位，且必须在「origin 尚未取到」的早退之前推进——首次 enter 时
            // syncGeometry 通常还没回来，早退路径不能吞掉显形信号。
            const kind = ev.payload.type;
            if (kind === "enter" || kind === "over") {
              useFileDragStore.getState().setFileDragActive(true);
            } else if (kind === "leave" || kind === "drop") {
              useFileDragStore.getState().setFileDragActive(false);
            }
            if (kind === "enter") void syncGeometry();
            if (kind === "leave" || !origin) return;
            const x = (ev.payload.position.x - origin.x) / scale;
            const y = (ev.payload.position.y - origin.y) / scale;
            const paths = "paths" in ev.payload ? ev.payload.paths : [];
            cb.current({ type: kind, paths, x, y });
          })
          .then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
          });
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
