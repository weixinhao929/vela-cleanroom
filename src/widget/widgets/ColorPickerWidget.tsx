/**
 * 取色器小组件：屏幕取色（Rust 轮询光标色，有界会话）、调色盘、
 * HEX/RGB/HSL/HSV/CMYK 多格式换算与复制，取色历史与命名色板跨实例共享。
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Crosshair, Pin, Plus, Trash2, X } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { invoke, isTauri } from "../../lib/tauri";
import { promptDialog } from "../../components/PromptDialog";
import { useWidgetConfig } from "../widget-config";
import { useT } from "../../i18n-lite";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import {
  hexToRgb,
  loadPalettes,
  loadPickerHistory,
  rgbToCmyk,
  rgbToHsl,
  rgbToHsv,
  savePalettes,
  savePickerHistory,
  PALETTES_EVENT,
  type HistoryColor,
  type Palette
} from "../color-shared";

const HEX_RE = /^#?([0-9a-f]{6})$/i;

export function ColorPickerWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const { config } = useWidgetConfig(instanceId);
  // 展示的格式：hex / rgb / hsl 及 W-106 扩展格式可独立开关。
  const showHex = config.showHex !== false;
  const showRgb = config.showRgb !== false;
  const showHsl = config.showHsl !== false;
  const showHsv = !!config.showHsv;
  const showCmyk = !!config.showCmyk;
  const showRgba = !!config.showRgba;
  const showCssVar = !!config.showCssVar;
  const autoCopy = !!config.autoCopy;
  const showHistory = config.showHistory !== false;
  const historyCap = (config.historyCap as number) || 8;

  const [hex, setHex] = useState("#81d4fa");
  /** W-105 HEX 精确输入框的文本态（允许中间态非法，提交时校验）。 */
  const [hexInput, setHexInput] = useState("#81d4fa");
  const [hexBad, setHexBad] = useState(false);
  const [alpha, setAlpha] = useState(1);
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [history, setHistory] = useState<HistoryColor[]>(() => loadPickerHistory(instanceId));
  /** W-108 命名色板（跨实例共享，事件同步）。 */
  const [palettes, setPalettes] = useState<Palette[]>(() => loadPalettes());
  /** W-110 屏幕取色：轮询鼠标下像素，Enter 确认 / Esc 取消。 */
  const [picking, setPicking] = useState(false);
  const [sample, setSample] = useState<{ x: number; y: number; hex: string } | null>(null);
  const sampleRef = useRef(sample);
  sampleRef.current = sample;

  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [hv, sv, vv] = rgbToHsv(r, g, b);
  const [c, m, y, k] = rgbToCmyk(r, g, b);

  /** 选定颜色（或重新选中）：置顶进历史，容量只约束未固定条目（W-107）。 */
  const saveToHistory = (newHex: string) => {
    const normalized = newHex.toLowerCase();
    setHistory((prev) => {
      const item = prev.find((it) => it.hex.toLowerCase() === normalized);
      const kept = prev.filter((it) => it.hex.toLowerCase() !== normalized);
      const newest: HistoryColor = { hex: normalized, pinned: item?.pinned };
      const pinnedList = kept.filter((it) => it.pinned);
      // 最新一条 + 其余未固定条目合计不超过容量；固定条目永不淘汰。
      const rest = kept.filter((it) => !it.pinned).slice(0, Math.max(0, historyCap - 1));
      const next = [newest, ...pinnedList, ...rest];
      savePickerHistory(instanceId, next);
      return next;
    });
  };

  const pickColor = (newHex: string) => {
    const v = newHex.toLowerCase();
    setHex(v);
    setHexInput(v);
    setHexBad(false);
    saveToHistory(v);
  };

  /** W-105 提交输入框：合法 hex 生效；否则标红退回当前值。 */
  const commitHex = () => {
    const m = HEX_RE.exec(hexInput.trim());
    if (m) {
      pickColor(`#${m[1].toLowerCase()}`);
    } else {
      setHexBad(true);
      setHexInput(hex);
      safeTimeout(() => setHexBad(false), 1200);
    }
  };

  const copy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(text);
      setFailed(false);
    } else {
      setFailed(true);
    }
    safeTimeout(() => {
      setCopied(null);
      setFailed(false);
    }, 1200);
  };

  // 开启「自动复制」时，选色即复制 HEX 到剪贴板。
  useEffect(() => {
    if (autoCopy) void copy(hex);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- copy 为组件内闭包，入依赖会每次渲染重复复制
  }, [hex, autoCopy]);

  /* W-108 色板跨实例同步。 */
  useEffect(() => {
    const on = () => setPalettes(loadPalettes());
    window.addEventListener(PALETTES_EVENT, on);
    return () => window.removeEventListener(PALETTES_EVENT, on);
  }, []);

  /* W-110 屏幕取色模式：事件驱动采样——pointermove 置脏标记，rAF 合帧后每帧
     至多一次 IPC（此前 150ms 轮询 ≈ 6.6 IPC/s）。pick_screen_color 在 Rust 侧
     读全局光标位置，JS 无需传坐标，只要「动过了才采样」；指针静止自然停表，
     不再消耗任何 IPC（此前靠逐拍比较坐标跳过）。 */
  useEffect(() => {
    if (!picking || !isTauri()) return;
    let raf = 0;
    let dirty = false;
    const sample = () => {
      raf = 0;
      if (!dirty) return;
      dirty = false;
      invoke<{ x: number; y: number; hex: string }>("pick_screen_color")
        .then((p) => setSample(p))
        .catch(() => {});
    };
    const onMove = () => {
      dirty = true;
      if (!raf) raf = window.requestAnimationFrame(sample);
    };
    // 进入取色模式先采一次（Rust 侧读真实光标位置，不依赖 JS 已知坐标）。
    dirty = true;
    raf = window.requestAnimationFrame(sample);
    window.addEventListener("pointermove", onMove, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const cur = sampleRef.current;
        if (cur) pickColor(cur.hex);
        setPicking(false);
        setSample(null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPicking(false);
        setSample(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);

  const togglePin = (target: string) => {
    setHistory((prev) => {
      const next = prev.map((it) =>
        it.hex.toLowerCase() === target.toLowerCase() ? { ...it, pinned: !it.pinned } : it
      );
      savePickerHistory(instanceId, next);
      return next;
    });
  };

  const removeHistory = (target: string) => {
    setHistory((prev) => {
      const next = prev.filter((it) => it.hex.toLowerCase() !== target.toLowerCase());
      savePickerHistory(instanceId, next);
      return next;
    });
  };

  const addPalette = async () => {
    const name = await promptDialog({ title: tr("新建色板"), placeholder: tr("色板名称，如「品牌色」") });
    if (!name?.trim()) return;
    const next = [...palettes, { id: crypto.randomUUID(), name: name.trim(), colors: [] }];
    savePalettes(next);
    setPalettes(next);
  };

  const removePalette = (id: string) => {
    const next = palettes.filter((p) => p.id !== id);
    savePalettes(next);
    setPalettes(next);
  };

  const addToPalette = (p: Palette) => {
    if (p.colors.some((c) => c.toLowerCase() === hex)) return;
    const next = palettes.map((it) => (it.id === p.id ? { ...it, colors: [...it.colors, hex] } : it));
    savePalettes(next);
    setPalettes(next);
  };

  const removeFromPalette = (p: Palette, target: string) => {
    const next = palettes.map((it) => (it.id === p.id ? { ...it, colors: it.colors.filter((c) => c !== target) } : it));
    savePalettes(next);
    setPalettes(next);
  };

  const rgbaText = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const cssText = `--color: ${hex};`;

  const fieldRow = (label: string, text: string) => (
    <div className="cp-field">
      <span>{label}</span>
      <button onClick={() => void copy(text)} data-interactive>
        {text}
        <Copy size={12} />
      </button>
    </div>
  );

  return (
    <div className="cp">
      <div className="cp-preview" style={{ background: hex }}>
        <span className="cp-pipette">
          <Crosshair size={18} />
        </span>
      </div>
      <div className="cp-input-row">
        <input
          type="color"
          className="cp-input"
          value={hex}
          onChange={(e) => pickColor(e.target.value)}
          aria-label={tr("选择颜色")}
          data-interactive
        />
        {isTauri() && (
          <button
            className={`cp-pick-btn${picking ? " on" : ""}`}
            onClick={() => {
              setPicking((v) => !v);
              if (picking) setSample(null);
            }}
            title={tr("屏幕取色")}
            data-interactive
          >
            <Crosshair size={14} />
          </button>
        )}
      </div>
      {picking && (
        <div className="cp-pick-bar" data-interactive>
          <span className="cp-pick-dot" style={{ background: sample?.hex ?? hex }} />
          <span className="cp-pick-text">
            {sample ? `${sample.x}, ${sample.y} · ${sample.hex}` : tr("移动鼠标到目标像素…")}
          </span>
          <button
            className="cp-pick-ok"
            onClick={() => {
              if (sample) pickColor(sample.hex);
              setPicking(false);
              setSample(null);
            }}
          >
            <Check size={13} />
            {tr("确认")}
          </button>
          <button
            className="cp-pick-cancel"
            onClick={() => {
              setPicking(false);
              setSample(null);
            }}
            aria-label={tr("取消")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className="cp-fields">
        {showHex && (
          <>
            <div className={`cp-field cp-hexrow${hexBad ? " bad" : ""}`}>
              <span>HEX</span>
              {/* W-105 可键入/粘贴精确色值；Enter 或失焦提交。 */}
              <input
                className="cp-hex-input"
                value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                onBlur={commitHex}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitHex();
                  }
                }}
                spellCheck={false}
                aria-label={tr("精确色值")}
                aria-invalid={hexBad || undefined}
                data-interactive
              />
              <button className="cp-copy-btn" onClick={() => void copy(hex)} aria-label={tr("复制")}>
                <Copy size={12} />
              </button>
            </div>
            {hexBad && (
              <div className="cp-hex-error" role="alert">
                {tr("无效 HEX")}
              </div>
            )}
          </>
        )}
        {showRgb && fieldRow("RGB", `rgb(${r}, ${g}, ${b})`)}
        {showHsl && fieldRow("HSL", `hsl(${h}, ${s}%, ${l}%)`)}
        {showHsv && fieldRow("HSV", `hsv(${hv}, ${sv}%, ${vv}%)`)}
        {showCmyk && fieldRow("CMYK", `cmyk(${c}%, ${m}%, ${y}%, ${k}%)`)}
        {showRgba && (
          <div className="cp-field cp-rgba-row">
            <span>RGBA</span>
            <div className="cp-rgba-body">
              <input
                className="widget-range"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={alpha}
                onChange={(e) => setAlpha(Number(e.target.value))}
                aria-label={tr("透明度")}
              />
              <button onClick={() => void copy(rgbaText)} data-interactive>
                {rgbaText}
                <Copy size={12} />
              </button>
            </div>
          </div>
        )}
        {showCssVar && fieldRow("CSS", cssText)}
        <button className="cp-copyall" onClick={() => void copyAllFormats()} data-interactive>
          <Copy size={12} />
          {tr("复制所有格式")}
        </button>
      </div>
      {showHistory && history.length > 0 && (
        <div className="cp-history">
          {history.map((c) => (
            <span key={c.hex} className={`cp-hist-item${c.pinned ? " pinned" : ""}`}>
              <button
                className="cp-swatch"
                style={{ background: c.hex }}
                onClick={() => pickColor(c.hex)}
                title={c.hex}
                aria-label={`${tr("选择颜色")} ${c.hex}`}
                data-interactive
              />
              <button className="cp-hist-pin" onClick={() => togglePin(c.hex)} title={tr("固定")} data-interactive>
                {c.pinned ? <Pin size={9} /> : <Pin size={9} className="cp-pin-off" />}
              </button>
              <button className="cp-hist-del" onClick={() => removeHistory(c.hex)} title={tr("删除")} data-interactive>
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* W-108 命名色板：跨实例共享，色块点击取色，＋ 收藏当前色。 */}
      {palettes.length > 0 && (
        <div className="cp-palettes">
          {palettes.map((p) => (
            <div key={p.id} className="cp-palette">
              <div className="cp-palette-head">
                <span className="cp-palette-name">{p.name}</span>
                <button
                  className="cp-palette-add"
                  onClick={() => addToPalette(p)}
                  title={tr("添加当前颜色")}
                  data-interactive
                >
                  <Plus size={11} />
                </button>
                <button
                  className="cp-palette-del"
                  onClick={() => removePalette(p.id)}
                  title={tr("删除色板")}
                  data-interactive
                >
                  <Trash2 size={11} />
                </button>
              </div>
              {p.colors.length > 0 && (
                <div className="cp-palette-colors">
                  {p.colors.map((c) => (
                    <span key={c} className="cp-pal-item">
                      <button
                        className="cp-swatch"
                        style={{ background: c }}
                        onClick={() => pickColor(c)}
                        title={c}
                        aria-label={`${tr("选择颜色")} ${c}`}
                        data-interactive
                      />
                      <button
                        className="cp-hist-del"
                        onClick={() => removeFromPalette(p, c)}
                        title={tr("删除")}
                        data-interactive
                      >
                        <X size={9} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <button className="cp-add-palette" onClick={() => void addPalette()} data-interactive>
        <Plus size={12} />
        {tr("新建色板")}
      </button>
      <div aria-live="polite">
        {copied && <div className="cp-copied">{tr("已复制 {v}", { v: copied })}</div>}
        {failed && <div className="cp-copied cp-fail">{tr("复制失败，请手动复制")}</div>}
      </div>
    </div>
  );

  function copyAllFormats() {
    const parts: string[] = [];
    if (showHex) parts.push(hex);
    if (showRgb) parts.push(`rgb(${r}, ${g}, ${b})`);
    if (showHsl) parts.push(`hsl(${h}, ${s}%, ${l}%)`);
    if (showHsv) parts.push(`hsv(${hv}, ${sv}%, ${vv}%)`);
    if (showCmyk) parts.push(`cmyk(${c}%, ${m}%, ${y}%, ${k}%)`);
    if (showRgba) parts.push(rgbaText);
    if (showCssVar) parts.push(cssText);
    return copyText(parts.join("\n")).then((ok) => {
      if (ok) {
        setCopied(tr("所有格式"));
        setFailed(false);
      } else {
        setFailed(true);
      }
      safeTimeout(() => {
        setCopied(null);
        setFailed(false);
      }, 1200);
    });
  }
}
