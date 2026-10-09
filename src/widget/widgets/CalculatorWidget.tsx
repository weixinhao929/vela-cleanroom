/**
 * 计算器小组件：表达式求值（自写 tokenizer + shunting-yard，无 eval），
 * 支持四则/幂/括号/百分比与历史记录，键盘输入可用。
 * 顶部页签切换「计算 / 编码 / 哈希」三模式：后两页由 ConverterPane 渲染，
 * 当前模式持久化在 config.mode；OS 文件拖入卡片自动切哈希页开算。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Plus, Trash2, X } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { persistMirrored } from "../../lib/local-backup";
import { useWidgetConfig } from "../widget-config";
import { loadInstances, useWidgetStore } from "../widget-store";
import { promptDialog } from "../../components/PromptDialog";
import { useT, appLocale } from "../../i18n-lite";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useOsFileDrop } from "../use-os-file-drop";
import { isTauri } from "../../lib/tauri";
import { ConverterPane, type ConverterDropRequest } from "./ConverterPane";

const KEYS = ["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", ".", "⌫", "="];

/** 科学模式下的函数键：直接作用于当前表达式。 */
const SCI_KEYS: { label: string; apply: (expr: string) => string }[] = [
  { label: "sin", apply: (e) => `sin(${e || "0"})` },
  { label: "cos", apply: (e) => `cos(${e || "0"})` },
  { label: "tan", apply: (e) => `tan(${e || "0"})` },
  { label: "√", apply: (e) => `sqrt(${e || "0"})` },
  { label: "x²", apply: (e) => `(${e || "0"})^2` },
  { label: "1/x", apply: (e) => `1/(${e || "0"})` },
  { label: "ln", apply: (e) => `ln(${e || "0"})` },
  { label: "log", apply: (e) => `log(${e || "0"})` },
  // 表达式非空且不以运算符/左括号结尾时先补 ×（"5"+π → "5PI" 非法）。
  {
    label: "π",
    apply: (e) => (e && !/[+\-*/%(^√]$/.test(e.trimEnd()) ? `${e}*PI` : `${e}PI`)
  },
  {
    label: "e",
    apply: (e) => (e && !/[+\-*/%(^√]$/.test(e.trimEnd()) ? `${e}*E` : `${e}E`)
  },
  { label: "(", apply: (e) => `${e}(` },
  { label: ")", apply: (e) => `${e})` }
];

/** 求值器保留字（函数名/常量），变量替换时跳过。 */
const KNOWN_IDS = new Set(["sin", "cos", "tan", "sqrt", "ln", "log", "PI", "E", "Math"]);

/**
 * 求值前的白名单断言：替换完成后只允许数字、空白、括号、四则/幂/取余运算符
 * 与 KNOWN_IDS 里的函数/常量名。任何其它标识符（alert、fetch、localStorage…）
 * 直接判错、绝不进 `new Function`——参数注入只能遮蔽显式命名的那几个全局，
 * 裸写的全局属性照样可达；而 addVar 又拿 evaluate 当校验器，未经断言等于
 * 把用户输入的任意 JS 先跑一遍再决定要不要存。
 */
function isSafeExpression(cleaned: string): boolean {
  let unknown = false;
  const rest = cleaned
    // 先摘掉数字字面量（含 2e3 / 1.5E-2 科学计数），否则指数里的 e 会被当成标识符。
    .replace(/\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/g, "0")
    .replace(/[A-Za-z_]\w*/g, (m) => {
      if (!KNOWN_IDS.has(m)) unknown = true;
      return "";
    });
  return !unknown && /^[\d\s()+\-*/%.]*$/.test(rest);
}

/**
 * 求值：符号 → JS 标识符后以参数注入实现（deg 模式三角入参 ×π/180；
 * 未知标识符先查变量表）。π→PI、独立 e→E 后再替换变量。
 */
function evaluate(expr: string, angle: "deg" | "rad", vars: Record<string, string>): string {
  const cleaned = expr
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/\^/g, "**")
    .replace(/√\(/g, "sqrt(")
    .replace(/π/g, "PI")
    .replace(/\be\b/g, "E")
    .replace(/\b([A-Za-z_]\w*)\b/g, (m) => (KNOWN_IDS.has(m) ? m : vars[m] !== undefined ? `(${vars[m]})` : m));
  if (!isSafeExpression(cleaned)) return "错误";
  try {
    const fn = new Function("sin", "cos", "tan", "sqrt", "ln", "log", "PI", "E", `"use strict"; return (${cleaned});`);
    const conv = angle === "deg" ? Math.PI / 180 : 1;
    const result: unknown = fn(
      (x: number) => Math.sin(x * conv),
      (x: number) => Math.cos(x * conv),
      (x: number) => Math.tan(x * conv),
      Math.sqrt,
      Math.log,
      Math.log10,
      Math.PI,
      Math.E
    );
    if (typeof result !== "number" || !isFinite(result)) return "错误";
    // 先判有限再舍入——|result| ≳1.8e298 时 ×1e10 会溢出成 Infinity
    // （界面显示 "Infinity"），|result|<1e-11 被舍成 "0"。改为有效位格式化：
    // 大数走科学计数，小数保留 10 位有效数字而非固定小数位。
    const abs = Math.abs(result);
    if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return result.toExponential(6).replace(/\.?0+e/, "e");
    return String(Number(result.toPrecision(12)));
  } catch {
    return "错误";
  }
}

/** Recomputes the live preview from the current expression. */
function preview(expr: string, angle: "deg" | "rad", vars: Record<string, string>): string {
  if (!expr) return "0";
  // A trailing operator has no preview yet.
  if (/[+\-×÷]$/.test(expr)) return "0";
  const r = evaluate(expr, angle, vars);
  return r === "错误" ? "0" : r;
}

/** 结果展示格式化：千分位分组（Intl.NumberFormat，跟随应用语言）；
 *  极大/极小值转科学计数。复制仍取原值。 */
function fmtResult(raw: string): string {
  if (raw === "错误" || raw === "") return raw;
  const v = Number(raw);
  if (!isFinite(v)) return raw;
  if (v !== 0 && (Math.abs(v) >= 1e15 || Math.abs(v) < 1e-9)) {
    return v.toExponential(6).replace(/\.?0+e/, "e");
  }
  return new Intl.NumberFormat(appLocale(), { maximumFractionDigits: 10 }).format(v);
}

/** 历史记录纸带条目。 */
type CalcHistoryItem = { id: string; expr: string; result: string; at: number };
/** 公式变量：name → 可代入的数值表达式。 */
type CalcVar = { name: string; value: string };

export function CalculatorWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const { config, update } = useWidgetConfig(instanceId);
  /* 顶部页签：计算 / 编码 / 哈希（编码哈希并入计算器后不再有独立类型）。 */
  const mode = config.mode === "encode" || config.mode === "hash" ? (config.mode as "encode" | "hash") : "calc";
  const scientificMode = !!config.scientificMode;
  const showExpression = config.showExpression !== false;
  const showHistory = config.showHistory !== false;
  const angle = (config.angleMode as "deg" | "rad") || "deg";
  const [expr, setExpr] = useState("");
  const [result, setResult] = useState("0");
  const [justEq, setJustEq] = useState(false);
  const [copied, setCopied] = useState(false);
  /* 记忆键：会话内保存一个数（M+/M−/MR/MC）。 */
  const [memory, setMemory] = useState<number | null>(null);
  /* 键盘作用域：悬停或内部聚焦时才接管全局按键。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef(false);
  const [hover, setHover] = useState(false);
  hoverRef.current = hover;
  /* 页签切换不重绑监听：onKey 经 ref 读当前模式，编码/哈希页不接管键盘。 */
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /* OS 文件拖入卡片（编码哈希并入后接管）：命中即切哈希页开算，请求按
     seq 单调递增转发给 ConverterPane（重挂载也能按序号去重）。 */
  const [fileDragOver, setFileDragOver] = useState(false);
  const [dropRequest, setDropRequest] = useState<ConverterDropRequest | null>(null);
  const dropSeq = useRef(0);
  useOsFileDrop((ev) => {
    // 拖拽离开窗口：清高亮（leave 此前被钩子吞掉导致 is-over 滞留）。
    if (ev.type === "leave") {
      setFileDragOver(false);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const inside = ev.x >= rect.left && ev.x <= rect.right && ev.y >= rect.top && ev.y <= rect.bottom;
    setFileDragOver(inside && (ev.type === "enter" || ev.type === "over"));
    if (ev.type === "drop" && inside && isTauri() && ev.paths.length > 0) {
      update({ mode: "hash" });
      dropSeq.current += 1;
      setDropRequest({ path: ev.paths[0], seq: dropSeq.current });
    }
  });
  /* 历史纸带（持久化，重启保留）。 */
  const historyKey = `focus-desk.calc.history.${instanceId}`;
  const [history, setHistory] = useState<CalcHistoryItem[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(historyKey) || "[]");
      return Array.isArray(parsed) ? (parsed as CalcHistoryItem[]).slice(0, 50) : [];
    } catch {
      return [];
    }
  });
  /* 清空历史两段式确认：首次点击仅武装，2s 内再次点击才清空。 */
  const [confirmClear, setConfirmClear] = useState(false);
  /* 变量表（持久化）。 */
  const varsKey = `focus-desk.calc.vars.${instanceId}`;
  const [vars, setVars] = useState<CalcVar[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(varsKey) || "[]");
      return Array.isArray(parsed) ? (parsed as CalcVar[]) : [];
    } catch {
      return [];
    }
  });
  /* 最新值镜像：事件处理器据此算 next 并同步落盘，不把 persistMirrored 塞进
     setState updater（updater 须纯函数，StrictMode 双调用会双写 localStorage）。 */
  const historyRef = useRef(history);
  historyRef.current = history;
  const varsRef = useRef(vars);
  varsRef.current = vars;
  const commitHistory = (next: CalcHistoryItem[]) => {
    historyRef.current = next;
    setHistory(next);
    persistMirrored(historyKey, JSON.stringify(next));
  };
  const commitVars = (next: CalcVar[]) => {
    varsRef.current = next;
    setVars(next);
    persistMirrored(varsKey, JSON.stringify(next));
  };
  const varMap = useMemo(() => Object.fromEntries(vars.map((v) => [v.name, v.value])), [vars]);
  /* 表达式受控输入引用（插入变量时保持光标位置）。 */
  const exprRef = useRef<HTMLInputElement | null>(null);

  const views = useWidgetStore((s) => s.views);
  /* 全应用只有一块计算器时保持旧的「全局可输入」体验；多块时仅
     悬停/聚焦的实例响应。 */
  const calcCount = useMemo(() => {
    let n = 0;
    for (const v of views) n += loadInstances(v.id).filter((i) => i.type === "calculator").length;
    return n;
  }, [views]);

  const previewNow = (e: string) => preview(e, angle, varMap);

  const copyResult = () => {
    const target = result !== "0" && result !== "错误" ? result : expr;
    void copyText(target || "0").then((ok) => {
      if (ok) {
        setCopied(true);
        safeTimeout(() => setCopied(false), 1200);
      }
    });
  };

  const applyExpr = (next: string) => {
    setJustEq(false);
    setExpr(next);
    setResult(previewNow(next));
  };

  /** 在光标处插入文本（未聚焦时追加到末尾），共用。 */
  const insert = (text: string) => {
    const el = exprRef.current;
    if (el && document.activeElement === el) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      applyExpr(next);
      requestAnimationFrame(() => {
        el.focus();
        const p = start + text.length;
        el.setSelectionRange(p, p);
      });
    } else {
      applyExpr(expr + text);
    }
  };

  const pushHistory = (e: string, r: string) => {
    if (r === "错误" || !e) return;
    const prev = historyRef.current;
    if (prev[0]?.expr === e && prev[0]?.result === r) return;
    commitHistory([{ id: crypto.randomUUID(), expr: e, result: r, at: Date.now() }, ...prev].slice(0, 50));
  };

  const clearHistory = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      safeTimeout(() => setConfirmClear(false), 2000);
      return;
    }
    setConfirmClear(false);
    commitHistory([]);
  };

  /** 点击历史条目：结果回填为当前算式（可继续运算）。 */
  const reuseHistory = (item: CalcHistoryItem) => {
    setExpr(item.result);
    setResult(item.result);
    setJustEq(true);
  };

  const currentValue = (): number | null => {
    if (justEq && result !== "错误" && result !== "") return Number(result);
    const v = evaluate(expr, angle, varMap);
    return v === "错误" ? null : Number(v);
  };

  const applySci = (fn: (e: string) => string) => {
    const next = fn(expr);
    setJustEq(false);
    setExpr(next);
    setResult(previewNow(next));
  };

  const backspace = () => {
    const next = expr.slice(0, -1);
    setJustEq(false);
    setExpr(next);
    setResult(previewNow(next));
  };

  const press = (k: string) => {
    if (k === "C") {
      setExpr("");
      setResult("0");
      setJustEq(false);
      return;
    }
    if (k === "⌫") {
      backspace();
      return;
    }
    if (k === "±") {
      const next = expr.startsWith("-") ? expr.slice(1) : `-${expr}`;
      applyExpr(next);
      return;
    }
    if (k === "%") {
      setResult(evaluate(`${expr || "0"} / 100`, angle, varMap));
      return;
    }
    if (k === "=") {
      const r = evaluate(expr || "0", angle, varMap);
      setResult(r);
      setExpr(r === "错误" ? "" : r);
      setJustEq(true);
      pushHistory(expr, r);
      return;
    }
    // After "=", typing a digit starts a brand-new calculation instead of
    // appending to the previous result.
    if (justEq && /[\d.]/.test(k)) {
      setJustEq(false);
      setExpr(k);
      setResult(previewNow(k));
      return;
    }
    setJustEq(false);
    const next = expr + k;
    setExpr(next);
    // Live preview: update whenever the last char is a digit or dot.
    if (/[\d.]$/.test(k)) {
      setResult(previewNow(next));
    }
  };

  // Keyboard support: digits, operators, Enter (=), Backspace, Escape (clear).
  // 通过 ref 持有最新 press，避免每次按键都重新绑定监听、以及 justEq 状态过期。
  const pressRef = useRef(press);
  pressRef.current = press;
  /* （按键按压态滞留）：小组件是独立小窗，按住按键拖出窗口边界后 WebView
     收不到 pointerup，CSS :active 的按压/缩放态滞留到下次点击。全局
     pointerup/pointercancel/blur 时释放焦点即可复位 :active。 */
  useEffect(() => {
    const release = () => {
      const el = document.activeElement as HTMLElement | null;
      if (el && rootRef.current?.contains(el)) el.blur();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 编码 / 哈希页不接管键盘：数字键属于文本框，Esc / 退格留给全局手势。
      if (modeRef.current !== "calc") return;
      // 输入控件内的按键属于该控件（便签/习惯/书签等表单）：不拦截、
      // 不送入计算器，否则数字与 Enter/Backspace 会被吞掉无法录入。
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      // 多实例键盘作用域：多块计算器时只响应悬停/聚焦的那块；
      // 单块时保持旧行为（随处可输）。
      const focusedWithin = !!rootRef.current?.contains(document.activeElement);
      if (calcCount > 1 && !hoverRef.current && !focusedWithin) return;
      const map: Record<string, string> = {
        "0": "0",
        "1": "1",
        "2": "2",
        "3": "3",
        "4": "4",
        "5": "5",
        "6": "6",
        "7": "7",
        "8": "8",
        "9": "9",
        ".": ".",
        "+": "+",
        "-": "−",
        "*": "×",
        "/": "÷",
        "%": "%",
        Enter: "=",
        "=": "="
      };
      const k = map[e.key];
      if (k) {
        e.preventDefault();
        pressRef.current(k);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        pressRef.current("⌫");
      } else if (e.key === "Escape") {
        e.preventDefault();
        pressRef.current("C");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calcCount]);

  /* 算式受控输入：光标任意处编辑；「= 后接数字」仍视为新算式。 */
  const onExprChange = (v: string) => {
    if (justEq) {
      const appended = v.length === expr.length + 1 && v.startsWith(expr) && /[\d.]/.test(v.slice(-1));
      if (appended) {
        const digit = v.slice(-1);
        setJustEq(false);
        setExpr(digit);
        setResult(previewNow(digit));
        return;
      }
    }
    applyExpr(v);
  };

  /* 添加变量：名称 → 数值两步输入。 */
  const addVar = async () => {
    const name = await promptDialog({ title: tr("添加变量"), placeholder: tr("变量名（如 a、tax）") });
    const n = name?.trim();
    if (!n || !/^[A-Za-z_]\w*$/.test(n) || KNOWN_IDS.has(n)) return;
    const value = await promptDialog({ title: `${n} =`, placeholder: tr("数值或简单表达式") });
    const v = value?.trim();
    if (!v || evaluate(v, angle, {}) === "错误") return;
    commitVars([...varsRef.current.filter((it) => it.name !== n), { name: n, value: v }]);
    setResult(previewNow(expr));
  };

  const delVar = (name: string) => {
    commitVars(varsRef.current.filter((it) => it.name !== name));
    setResult(previewNow(expr));
  };

  return (
    <div className="calc" ref={rootRef} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div className="enc-tabs" data-interactive>
        <button
          className={mode === "calc" ? "is-active" : ""}
          onClick={() => update({ mode: "calc" })}
          data-interactive
        >
          {tr("计算")}
        </button>
        <button
          className={mode === "encode" ? "is-active" : ""}
          onClick={() => update({ mode: "encode" })}
          data-interactive
        >
          {tr("编码")}
        </button>
        <button
          className={mode === "hash" ? "is-active" : ""}
          onClick={() => update({ mode: "hash" })}
          data-interactive
        >
          {tr("哈希")}
        </button>
      </div>
      {/* tab 内容切换：key={mode} 重挂 + .calc-body/.enc-pane 进场动画（轻
          crossfade+上滑），三个面板不再硬切。 */}
      {mode === "calc" ? (
        <div className="calc-body" key={mode}>
          <div className="calc-display">
            {showExpression && (
              <input
                ref={exprRef}
                className="calc-expr-input"
                value={expr}
                onChange={(e) => onExprChange(e.target.value)}
                onKeyDown={(e) => {
                  /* IME 组合期 Enter（确认候选词）不当作求值。 */
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    pressRef.current("=");
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    pressRef.current("C");
                  }
                }}
                placeholder="0"
                spellCheck={false}
                aria-label={tr("算式")}
                data-interactive
              />
            )}
            <div className="calc-result-row">
              {/* 角度模式：deg 下 sin(30)=0.5，不再反直觉。 */}
              <button
                className="calc-angle"
                onClick={() => update({ angleMode: angle === "deg" ? "rad" : "deg" })}
                title={tr("角度/弧度切换")}
                data-interactive
              >
                {angle.toUpperCase()}
              </button>
              <div className="calc-result" key={result}>
                {fmtResult(result) === "错误" ? tr("错误") : fmtResult(result)}
              </div>
              <button
                className={`calc-copy${copied ? " done" : ""}`}
                onClick={copyResult}
                aria-label={tr("复制结果")}
                title={copied ? tr("已复制") : tr("复制结果")}
                data-interactive
              >
                {copied ? <Copy size={13} /> : <Copy size={13} />}
              </button>
            </div>
          </div>
          {showHistory && history.length > 0 && (
            <div className="calc-history" data-interactive>
              <div className="calc-history-head">
                <span>{tr("历史记录")}</span>
                <button
                  className={`calc-history-clear${confirmClear ? " confirming" : ""}`}
                  onClick={clearHistory}
                  title={confirmClear ? tr("再次点击确认清空") : tr("清空历史")}
                  aria-label={confirmClear ? tr("再次点击确认清空") : tr("清空历史")}
                  data-interactive
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <div className="calc-history-list">
                {history.map((it, hi) => (
                  <div key={it.id} className="calc-history-item" style={{ ["--sti" as string]: Math.min(hi, 12) }}>
                    <button
                      className="calc-history-main"
                      onClick={() => reuseHistory(it)}
                      title={tr("回填")}
                      data-interactive
                    >
                      <span className="calc-history-expr">{it.expr}</span>
                      <span className="calc-history-eq">= {fmtResult(it.result)}</span>
                    </button>
                    <button
                      className="calc-history-copy"
                      onClick={() => void copyText(it.result)}
                      title={tr("复制结果")}
                      data-interactive
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {scientificMode && (
            <div className="calc-sci">
              {SCI_KEYS.map((k) => (
                <button key={k.label} className="calc-sci-key" onClick={() => applySci(k.apply)} data-interactive>
                  {k.label}
                </button>
              ))}
            </div>
          )}
          {scientificMode && vars.length > 0 && (
            <div className="calc-vars">
              {vars.map((v) => (
                <span key={v.name} className="calc-var">
                  <button onClick={() => insert(v.name)} title={tr("插入")} data-interactive>
                    {v.name}={v.value}
                  </button>
                  <button className="calc-var-del" onClick={() => delVar(v.name)} title={tr("删除")} data-interactive>
                    <X size={9} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* 记忆键：标准计算器惯例 M+/M−/MR/MC。 */}
          <div className="calc-mem" data-interactive>
            <span className={`calc-mem-ind${memory !== null ? " on" : ""}`}>M</span>
            <button onClick={() => setMemory(null)} disabled={memory === null}>
              MC
            </button>
            <button
              onClick={() => {
                if (memory !== null) insert(String(memory));
              }}
              disabled={memory === null}
            >
              MR
            </button>
            <button
              onClick={() => {
                const v = currentValue();
                if (v !== null) setMemory((m) => (m ?? 0) + v);
              }}
            >
              M+
            </button>
            <button
              onClick={() => {
                const v = currentValue();
                if (v !== null) setMemory((m) => (m ?? 0) - v);
              }}
            >
              M−
            </button>
            {scientificMode && (
              <button className="calc-var-add" onClick={() => void addVar()}>
                <Plus size={11} />
                {tr("变量")}
              </button>
            )}
          </div>
          <div className="calc-keys">
            {KEYS.map((k) => (
              <button
                key={k}
                className={`calc-key${k === "=" ? " eq" : ""}${["C", "±", "%", "÷", "×", "−", "+"].includes(k) ? " op" : ""}${k === "⌫" ? " del" : ""}`}
                onClick={() => press(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ConverterPane tab={mode} key={mode} dragOver={fileDragOver} dropRequest={dropRequest} />
      )}
    </div>
  );
}
