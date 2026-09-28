import { useEffect } from "react";
import { create } from "zustand";
import { invoke, isTauri } from "./tauri";
import { useTauriEvent } from "./use-tauri-event";
import type { WallpaperPaletteInfo } from "../types/bindings/WallpaperPaletteInfo";

/**
 * 当前桌面壁纸 · 运行时接线（原 §4.4「跟随壁纸」取色管线的遗留消费面）。
 *
 * 主题不再从壁纸派生颜色，但样式页「壁纸」区仍需要知道当前壁纸是哪张：
 * 挂载时 `get_wallpaper_palette` 拉一次（Rust 侧 path+mtime 缓存，通常命中），
 * 之后只吃 `wallpaper:changed` 事件（Vela 自己换壁纸 / 系统设置换壁纸 /
 * 幻灯片切图都会触发），用于在缩略图网格里高亮当前生效的壁纸。
 */

export type WallpaperStatus = "idle" | "ready" | "unavailable";

interface WallpaperState {
  info: WallpaperPaletteInfo | null;
  status: WallpaperStatus;
}

/** 当前壁纸快照（path/mtime/palette）；无 setter，只由本模块写。 */
export const useWallpaperStore = create<WallpaperState>()(() => ({ info: null, status: "idle" }));

/** 载荷 → store 更新；null = 壁纸不可用（纯色桌面等）。 */
function applyWallpaperInfo(info: WallpaperPaletteInfo | null): void {
  if (!info) {
    useWallpaperStore.setState({ info: null, status: "unavailable" });
    return;
  }
  const prev = useWallpaperStore.getState().info;
  const key = `${info.path}|${info.mtime_ms}`;
  // 同键重复到达（启动拉取与预热轮询撞车等）：不重复写。
  if (prev && `${prev.path}|${prev.mtime_ms}` === key && useWallpaperStore.getState().status === "ready") return;
  useWallpaperStore.setState({ info, status: "ready" });
}

/**
 * 在应用根挂载一次：拉取当前壁纸快照并订阅变化。
 * 浏览器开发模式为 no-op（status 停留 idle，样式页显示不可用态）。
 */
export function useWallpaperTheme(): void {
  useEffect(() => {
    if (!isTauri()) {
      useWallpaperStore.setState({ info: null, status: "unavailable" });
      return;
    }
    let disposed = false;
    invoke<WallpaperPaletteInfo | null>("get_wallpaper_palette")
      .then((info) => {
        if (!disposed) applyWallpaperInfo(info);
      })
      .catch((err) => {
        console.warn("[wallpaper] get_wallpaper_palette failed:", err);
        if (!disposed) applyWallpaperInfo(null);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useTauriEvent<WallpaperPaletteInfo>("wallpaper:changed", applyWallpaperInfo);
}
