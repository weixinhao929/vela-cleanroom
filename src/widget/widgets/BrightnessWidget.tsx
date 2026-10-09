/**
 * §4.12 亮度控制小组件（实验性）。
 *
 * 每台显示器一组滑条：内置屏走 WMI（key `wmi:` 前缀）、外接屏走
 * DDC/CI（key `ddc:` 前缀），枚举与通道解析全在 Rust 侧（brightness.rs）。
 * 拖动跟手走本地乐观值，真正写硬件由 Rust 侧 300ms 重启式防抖收敛；
 * 写失败经 `brightness:write-failed` 事件回标「不支持」。探测失败的屏
 * 显示降级行而不是让整个小组件报错。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MonitorX, RefreshCw, SunDim } from "lucide-react";
import { useT } from "../../i18n-lite";
import { invoke, isTauri } from "../../lib/tauri";
import { notifyOsd } from "../../lib/osd-events";
import { M3Slider } from "../../components/ui/M3Slider";
import "../../styles/feature-brightness.css";

type BrightnessMonitor = {
  key: string;
  slot: number | null;
  label: string;
  kind: "internal" | "ddc";
  supported: boolean;
  current: number | null;
};

export function BrightnessWidget() {
  const tr = useT();
  const [list, setList] = useState<BrightnessMonitor[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 拖动期间的本地乐观值（跟手）；松手后由 Rust 写入，不回读。 */
  const [optimistic, setOptimistic] = useState<Record<string, number>>({});
  /** 写失败的屏 key 集合（事件回标），显示「不支持」。 */
  const failedRef = useRef<Set<string>>(new Set());
  const [failedVer, setFailedVer] = useState(0);

  const markFailed = useCallback((key: string) => {
    if (!failedRef.current.has(key)) {
      failedRef.current.add(key);
      setFailedVer((v) => v + 1);
    }
  }, []);

  const load = useCallback(() => {
    if (!isTauri()) return;
    setLoading(true);
    setError(null);
    invoke<BrightnessMonitor[]>("list_brightness_monitors")
      .then((rows) => {
        setList(rows);
        setOptimistic({});
        // （failedRef 只增不清）：手动「重新检测」成功后清空写失败标记，
        // 恢复的屏不再停留「不支持」态直到重挂。
        if (failedRef.current.size > 0) {
          failedRef.current.clear();
          setFailedVer((v) => v + 1);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    load();
    // 写失败回标：Rust 防抖线程真正落硬件失败（拔线 / HDR / 不响应）时发出。
    // unlisten 必须保存并在卸载时调用：此前直接丢弃，多屏窗口反复挂卸会累积
    // 监听，拔屏写失败还会对已卸载组件 setState。
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (disposed) return;
      listen<{ key: string }>("brightness:write-failed", (e) => {
        if (e.payload?.key) markFailed(e.payload.key);
      })
        .then((f) => {
          if (disposed) f();
          else unlisten = f;
        })
        .catch(() => {});
    });
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, [load, markFailed]);

  const onSlide = (key: string, v: number) => {
    setOptimistic((o) => ({ ...o, [key]: v }));
    /* 画布内调亮度 → 灵动岛 OSD 接管（岛内 BrightnessMini 不发，防自藏）。 */
    notifyOsd("brightness", tr("亮度"), `${v}%`);
    void invoke("set_brightness", { key, value: v }).catch(() => markFailed(key));
  };

  /* 浏览器预览：整块降级说明。 */
  if (!isTauri()) {
    return (
      <div className="bright-panel">
        <div className="bright-head">
          <SunDim size={14} className="bright-ico" />
          <span className="bright-title">{tr("亮度")}</span>
          <span className="bright-badge">{tr("实验性")}</span>
        </div>
        <p className="bright-empty">{tr("浏览器预览下不可用，请在桌面模式使用")}</p>
      </div>
    );
  }

  return (
    <div className="bright-panel">
      <div className="bright-head">
        <SunDim size={14} className="bright-ico" />
        <span className="bright-title">{tr("亮度")}</span>
        <span className="bright-badge">{tr("实验性")}</span>
        <button
          type="button"
          className="bright-refresh"
          data-interactive
          title={tr("重新检测")}
          aria-label={tr("重新检测")}
          disabled={loading}
          onClick={load}
        >
          <RefreshCw size={13} className={loading ? "bright-spinning" : undefined} />
        </button>
      </div>

      {error !== null && (
        <p className="bright-empty">
          {tr("读取亮度信息失败")}
          <span className="bright-error-detail">{error}</span>
        </p>
      )}
      {error === null && list !== null && list.length === 0 && (
        <p className="bright-empty">{tr("未检测到支持亮度控制的显示器")}</p>
      )}

      {error === null && list !== null && list.length > 0 && (
        <div className="bright-rows">
          {list.map((m) => {
            const failed = !m.supported || failedRef.current.has(m.key); // failedVer 变化触发重渲
            void failedVer;
            const shown = optimistic[m.key] ?? m.current ?? 100;
            return (
              <div className={`bright-row${failed ? " is-unsupported" : ""}`} key={m.key}>
                <div className="bright-row-head">
                  <span className="bright-label" title={m.label}>
                    {m.label}
                  </span>
                  {m.slot !== null && (
                    <span className="bright-slot">{tr("屏 {n}").replace("{n}", String(m.slot + 1))}</span>
                  )}
                  <span className="bright-kind">{m.kind === "internal" ? tr("内置屏") : tr("外接屏 · DDC/CI")}</span>
                  {failed && (
                    <span className="bright-unsupported">
                      <MonitorX size={11} />
                      {tr("不支持")}
                    </span>
                  )}
                </div>
                {failed ? (
                  <div className="bright-unsupported-bar" />
                ) : (
                  <M3Slider
                    value={Math.round(shown)}
                    min={0}
                    max={100}
                    step={1}
                    suffix="%"
                    label={m.label}
                    onChange={(v) => onSlide(m.key, v)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="bright-foot">{tr("外接屏经 DDC/CI 控制；HDR 开启或线材转接时可能失效")}</p>
    </div>
  );
}
