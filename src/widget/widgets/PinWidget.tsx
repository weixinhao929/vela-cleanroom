/**
 * 贴图小组件：把截图套件「钉到桌面」的
 * 结果以 1:1 像素常驻画布（图片本体落 gallery 目录，asset scope 已覆盖）。
 * 图片文件被删时显示缺位提示（不自动删组件，等用户处理）。
 */
import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { isTauri } from "../../lib/tauri";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";

export function PinWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const { config } = useWidgetConfig(instanceId);
  const [broken, setBroken] = useState(false);
  const src = typeof config.src === "string" ? config.src : "";
  const [assetUrl, setAssetUrl] = useState("");

  // 动态解析 asset 协议 URL（浏览器模式无此 API，显示占位）。
  useEffect(() => {
    if (!src || !isTauri()) return;
    let alive = true;
    void import("@tauri-apps/api/core").then(({ convertFileSrc }) => {
      if (alive) setAssetUrl(convertFileSrc(src));
    });
    return () => {
      alive = false;
    };
  }, [src]);

  if (!src || broken || !assetUrl) {
    return (
      <div className="pin pin-empty">
        <ImageOff size={20} />
        <span>{src ? tr("图片已不存在") : tr("空贴图")}</span>
      </div>
    );
  }
  return (
    <div className="pin">
      <img
        src={assetUrl}
        alt={tr("贴图")}
        draggable={false}
        onError={() => setBroken(true)}
        style={{ objectFit: "contain" }}
      />
    </div>
  );
}
