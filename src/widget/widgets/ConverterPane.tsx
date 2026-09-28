/* eslint-disable react-refresh/only-export-components -- 纯函数与组件同文件导出供测试（FileBrowserWidget 同款惯例） */
/**
 * 计算器组件的「编码 / 哈希」页（原独立「编码哈希」小组件并入计算器，
 * ClassSoftwareHub #2）：Base64/URL 编解码（「用作输入」一键回填）、
 * 文本 / 文件双模式哈希（MD5 / SHA-1 / SHA-256 / SHA-512）。
 * 文件走 Rust 流式命令 hash_file（1MB 块恒定内存，任意大小不吃内存），
 * 文本侧 MD5 用 domain/md5 纯函数、SHA 系用 WebCrypto；粘贴期望值自动
 * 归一化核对（忽略大小写 / 空白 / 冒号）显示 ✓ / ✗。
 * 页签由计算器外壳持有（config.mode）；OS 文件拖入也由外壳接管后经
 * dropRequest 转发到本页（自动切哈希页开算）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, Check, FileUp, X } from "lucide-react";
import { md5Hex } from "../../domain/md5";
import { copyText } from "../../lib/clipboard";
import { pickFilePath } from "../../lib/file-dialog";
import { invoke } from "../../lib/tauri";
import { useT } from "../../i18n-lite";

export type HashBundle = { md5: string; sha1: string; sha256: string; sha512: string };

/** 外壳（计算器）转发来的 OS 文件拖放请求：seq 单调递增做去重。 */
export type ConverterDropRequest = { path: string; seq: number };

/* ---- 纯函数（供测试）：编解码与哈希核对 ---- */

/** UTF-8 安全的 Base64 编码。 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Base64 解码回 UTF-8 文本；非法输入抛 Error（组件转人话提示）。 */
export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** URL 组件级编解码（与 CSH 一致用 encodeURIComponent 语义）。 */
export function urlEncode(text: string): string {
  return encodeURIComponent(text);
}
export function urlDecode(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, "%20"));
}

/** 期望哈希归一化：去空白与冒号、转小写。 */
export function normalizeExpected(raw: string): string {
  return raw.replace(/[\s:]/g, "").toLowerCase();
}

/** 期望值与四种哈希比对，返回命中的算法名（无命中返回 null）。 */
export function matchAlgorithm(expected: string, hashes: HashBundle): string | null {
  const want = normalizeExpected(expected);
  if (want.length < 8) return null;
  const pairs: [string, string][] = [
    ["MD5", hashes.md5],
    ["SHA-1", hashes.sha1],
    ["SHA-256", hashes.sha256],
    ["SHA-512", hashes.sha512]
  ];
  for (const [name, hex] of pairs) if (want === hex) return name;
  return null;
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 文本四哈希：MD5 纯函数 + WebCrypto SHA 系。 */
export async function hashText(text: string): Promise<HashBundle> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 SHA 计算");
  const bytes = new TextEncoder().encode(text);
  const [sha1, sha256, sha512] = await Promise.all(
    (["SHA-1", "SHA-256", "SHA-512"] as const).map((alg) => subtle.digest(alg, bytes))
  );
  return { md5: md5Hex(text), sha1: bufToHex(sha1), sha256: bufToHex(sha256), sha512: bufToHex(sha512) };
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const HASH_ROWS: { key: keyof HashBundle; label: string }[] = [
  { key: "md5", label: "MD5" },
  { key: "sha1", label: "SHA-1" },
  { key: "sha256", label: "SHA-256" },
  { key: "sha512", label: "SHA-512" }
];

export function ConverterPane({
  tab,
  dragOver,
  dropRequest
}: {
  tab: "encode" | "hash";
  /** OS 文件拖到卡片上（外壳判定命中）：文件投放钮高亮。 */
  dragOver: boolean;
  /** 外壳转发的文件拖放请求（每次 drop seq +1），到货即切文件源开算。 */
  dropRequest: ConverterDropRequest | null;
}) {
  const tr = useT();

  /* ---- 编码页 ---- */
  const [format, setFormat] = useState<"base64" | "url">("base64");
  const [direction, setDirection] = useState<"encode" | "decode">("encode");
  const [input, setInput] = useState("");
  // 输出与错误是纯派生值（渲染期绝不写状态）：非法输入 → 输出空 + 人话提示。
  const { output, encError } = useMemo(() => {
    if (input.length === 0) return { output: "", encError: "" };
    try {
      const out =
        format === "base64"
          ? direction === "encode"
            ? toBase64(input)
            : fromBase64(input)
          : direction === "encode"
            ? urlEncode(input)
            : urlDecode(input);
      return { output: out, encError: "" };
    } catch {
      return {
        output: "",
        encError: format === "base64" ? tr("输入内容不是合法的 Base64") : tr("输入内容不是合法的 URL 编码")
      };
    }
  }, [input, format, direction, tr]);

  /* ---- 哈希页 ---- */
  const [source, setSource] = useState<"text" | "file">("text");
  const [textHashes, setTextHashes] = useState<HashBundle | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileHashes, setFileHashes] = useState<(HashBundle & { bytes: number }) | null>(null);
  const [hashBusy, setHashBusy] = useState(false);
  const [hashError, setHashError] = useState("");
  const [expected, setExpected] = useState("");

  const shown = source === "text" ? textHashes : fileHashes;
  const matched = shown && expected.trim() ? matchAlgorithm(expected, shown) : null;
  const expectedDirty = expected.trim().length > 0 && shown;

  async function computeText() {
    setHashError("");
    try {
      setTextHashes(await hashText(input));
    } catch (e) {
      setHashError(e instanceof Error ? e.message : String(e));
    }
  }

  async function hashPath(path: string) {
    setHashBusy(true);
    setHashError("");
    try {
      const r = await invoke<HashBundle & { bytes: number }>("hash_file", { path });
      setFileHashes(r);
      setFileName(
        path
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ?? path
      );
      setSource("file");
    } catch (e) {
      setHashError(String(e));
    } finally {
      setHashBusy(false);
    }
  }

  async function pickFile() {
    try {
      const path = await pickFilePath({ title: tr("选择要计算哈希的文件") });
      if (path) void hashPath(path);
    } catch {
      // 用户取消 / 对话框失败：保持现状。
    }
  }

  /* 外壳转发的拖放请求：按 seq 去重后开算（组件可能刚被切换出来重新挂载）。 */
  const handledSeq = useRef(0);
  useEffect(() => {
    if (!dropRequest || dropRequest.seq === handledSeq.current) return;
    handledSeq.current = dropRequest.seq;
    void hashPath(dropRequest.path);
  }, [dropRequest]);

  return (
    <div className="enc enc-pane">
      {tab === "encode" ? (
        <div className="enc-body">
          <div className="enc-seg" data-interactive>
            <button
              className={format === "base64" ? "is-active" : ""}
              onClick={() => setFormat("base64")}
              data-interactive
            >
              Base64
            </button>
            <button className={format === "url" ? "is-active" : ""} onClick={() => setFormat("url")} data-interactive>
              URL
            </button>
            <span className="enc-seg-gap" />
            <button
              className={direction === "encode" ? "is-active" : ""}
              onClick={() => setDirection("encode")}
              data-interactive
            >
              {tr("编码")}
            </button>
            <button
              className={direction === "decode" ? "is-active" : ""}
              onClick={() => setDirection("decode")}
              data-interactive
            >
              {tr("解码")}
            </button>
          </div>
          <textarea
            className="enc-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={direction === "encode" ? tr("输入要编码的文本") : tr("输入要解码的文本")}
            spellCheck={false}
            data-interactive
          />
          {encError ? <div className="enc-error">{encError}</div> : null}
          <div className="enc-output" data-interactive>
            <div className="enc-output-text">{output || (input ? "—" : "")}</div>
            <div className="enc-output-actions">
              <button
                className="enc-mini-btn"
                title={tr("复制")}
                disabled={!output}
                onClick={() => output && copyText(output)}
                data-interactive
              >
                {tr("复制")}
              </button>
              <button
                className="enc-mini-btn"
                title={tr("把输出作为新的输入继续转换")}
                disabled={!output}
                onClick={() => {
                  setInput(output);
                  setDirection(direction === "encode" ? "decode" : "encode");
                }}
                data-interactive
              >
                <ArrowUpDown size={11} />
                {tr("用作输入")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="enc-body">
          <div className="enc-seg" data-interactive>
            <button className={source === "text" ? "is-active" : ""} onClick={() => setSource("text")} data-interactive>
              {tr("文本")}
            </button>
            <button className={source === "file" ? "is-active" : ""} onClick={() => setSource("file")} data-interactive>
              {tr("文件")}
            </button>
          </div>

          {source === "text" ? (
            <textarea
              className="enc-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={tr("输入要计算哈希的文本")}
              spellCheck={false}
              data-interactive
            />
          ) : (
            <button
              className={`enc-drop${dragOver ? " is-over" : ""}`}
              onClick={pickFile}
              data-interactive
              title={tr("拖入文件，或点击选择")}
            >
              <FileUp size={16} />
              <span className="enc-drop-name">{fileHashes ? fileName : tr("拖入文件，或点击选择")}</span>
              {fileHashes && <span className="enc-drop-size">{formatBytes(fileHashes.bytes)}</span>}
            </button>
          )}

          {source === "text" && (
            <button className="enc-run" onClick={computeText} disabled={!input} data-interactive>
              {tr("计算哈希")}
            </button>
          )}
          {source === "file" && fileHashes && (
            <button
              className="enc-mini-btn enc-clear"
              onClick={() => {
                setFileHashes(null);
                setFileName("");
              }}
              data-interactive
            >
              <X size={11} />
              {tr("清除")}
            </button>
          )}

          {hashError && <div className="enc-error">{hashError}</div>}
          {hashBusy && <div className="enc-hint">{tr("正在计算…")}</div>}

          {shown && (
            <div className="enc-hashes" data-interactive>
              {HASH_ROWS.map(({ key, label }, hi) => (
                <button
                  key={key}
                  className="enc-hash-row"
                  style={{ ["--sti" as string]: Math.min(hi, 12) }}
                  onClick={() => copyText(shown[key])}
                  title={tr("点击复制")}
                  data-interactive
                >
                  <span className="enc-hash-label">{label}</span>
                  <span className="enc-hash-value">{shown[key]}</span>
                </button>
              ))}
            </div>
          )}

          {shown && (
            <div className="enc-verify" data-interactive>
              <input
                className="enc-verify-input"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                placeholder={tr("粘贴期望哈希值自动核对")}
                spellCheck={false}
              />
              {expectedDirty && (
                <span className={`enc-verify-badge${matched ? " is-ok" : " is-bad"}`}>
                  {matched ? (
                    <>
                      <Check size={11} /> {matched} {tr("匹配")}
                    </>
                  ) : (
                    <>
                      <X size={11} /> {tr("不匹配")}
                    </>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
