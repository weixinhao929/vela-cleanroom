import { Fragment, type ReactNode } from "react";

/**
 * 轻量 Markdown 渲染：仅覆盖便签场景的四类语法（标题 / 清单 / 行内代码 /
 * 链接），不引入大库。纯函数、无副作用，可单测。
 *
 * 安全性：不使用 dangerouslySetInnerHTML，全部输出为 React 元素，
 * href 只允许 http(s) 协议，从根源避免 XSS。
 */

const INLINE_CODE = /`([^`\n]+)`/g;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;
const ITALIC = /(?:^|[^*])\*([^*\n]+)\*(?=$|[^*])/g;
const TAG = /(^|\s)(#[\p{L}\p{N}_-]{1,24})/gu;

/** 校验 URL 仅允许 http(s) 协议；非法输入返回 null（XSS 防线之一）。 */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * 行内语法解析：行内代码 → 链接 → 加粗 → 斜体 → #标签。
 * 多趟扫描 + 区间去重（先识别的片段优先，行内代码内部的 * / # 不再解析），
 * 最后按位置排序拼回纯文本片段。O(语法数 × len)。
 *
 * @param text - 单行文本。
 * @param keyPrefix - 生成的 React key 前缀（多行复用时避免冲突）。
 * @returns 混合文本与元素的 ReactNode 数组。
 * @throws 无。
 *
 * @example
 * ```tsx
 * renderInline("看 `code` 和 [文档](https://example.com)");
 * ```
 */
export function renderInline(text: string, keyPrefix = ""): ReactNode[] {
  type Piece = { start: number; end: number; node: ReactNode };
  const pieces: Piece[] = [];

  const scan = (re: RegExp, build: (m: RegExpExecArray) => ReactNode) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // 跳过与已识别片段重叠的匹配（行内代码内部的 * 或 # 不再解析）。
      if (pieces.some((p) => m!.index < p.end && m!.index + m![0].length > p.start)) continue;
      pieces.push({ start: m.index, end: m.index + m[0].length, node: build(m) });
    }
  };

  scan(INLINE_CODE, (m) => (
    <code className="md-code" key={`${keyPrefix}c${m.index}`}>
      {m[1]}
    </code>
  ));
  scan(LINK, (m) => {
    const href = safeHref(m[2]);
    return href ? (
      <a
        className="md-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        key={`${keyPrefix}a${m.index}`}
        data-interactive
      >
        {m[1]}
      </a>
    ) : (
      <Fragment key={`${keyPrefix}a${m.index}`}>{m[0]}</Fragment>
    );
  });
  scan(BOLD, (m) => (
    <strong className="md-bold" key={`${keyPrefix}b${m.index}`}>
      {m[1]}
    </strong>
  ));
  scan(ITALIC, (m) => {
    // 斜体正则可能吞掉前置空白，原样保留。
    const lead = m[0].startsWith("*") ? "" : m[0][0];
    return (
      <Fragment key={`${keyPrefix}i${m.index}`}>
        {lead}
        <em className="md-italic">{m[1]}</em>
      </Fragment>
    );
  });
  scan(TAG, (m) => {
    const lead = m[1];
    return (
      <Fragment key={`${keyPrefix}t${m.index}`}>
        {lead}
        <span className="md-tag" data-tag={m[2].slice(1)}>
          {m[2]}
        </span>
      </Fragment>
    );
  });

  pieces.sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const p of pieces) {
    if (p.start > cursor) out.push(text.slice(cursor, p.start));
    out.push(p.node);
    cursor = p.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export interface MiniMdOptions {
  /** 点击 #标签 时回调（用于过滤）。 */
  onTagClick?: (tag: string) => void;
  /** W-063：点击任务清单复选框时回调（lineIndex 为该行在原文中的行号）。 */
  onToggleTask?: (lineIndex: number, checked: boolean) => void;
}

/**
 * 便签正文 Markdown 渲染（纯函数，无 dangerouslySetInnerHTML）。
 * 按行解析 `#`~`###` 标题、`- [x]` 任务清单（可交互勾选）、普通清单与
 * 空行；行内语法交给 {@link renderInline}。连续清单行合并为一个 ul。
 *
 * @param text - 便签正文全文。
 * @param options - `onTagClick` 点击 #标签 回调；`onToggleTask` 勾选任务
 *                  回调（入参为原文行号与新状态）。
 * @returns 可直接渲染的 ReactNode。
 * @throws 无。
 *
 * @example
 * ```tsx
 * <div>{renderMiniMd(note.text, { onTagClick: setTagFilter, onToggleTask: toggle })}</div>
 * ```
 */
export function renderMiniMd(text: string, options: MiniMdOptions = {}): ReactNode {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const handleTagClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const tag = target.dataset.tag;
    if (tag && options.onTagClick) {
      e.preventDefault();
      e.stopPropagation();
      options.onTagClick(tag);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^###\s+/.test(line)) {
      nodes.push(
        <h4 className="md-h3" key={key++}>
          {renderInline(line.replace(/^###\s+/, ""), `h${key}`)}
        </h4>
      );
    } else if (/^##\s+/.test(line)) {
      nodes.push(
        <h3 className="md-h2" key={key++}>
          {renderInline(line.replace(/^##\s+/, ""), `h${key}`)}
        </h3>
      );
    } else if (/^#\s+/.test(line)) {
      nodes.push(
        <h2 className="md-h1" key={key++}>
          {renderInline(line.replace(/^#\s+/, ""), `h${key}`)}
        </h2>
      );
    } else if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      // 连续的任务清单行合并为一个 ul.md-task-list。
      const items: { text: string; checked: boolean; lineIndex: number }[] = [];
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i])!;
        items.push({ text: m[2], checked: m[1].toLowerCase() === "x", lineIndex: i });
        i++;
      }
      nodes.push(
        <ul className="md-task-list" key={key++}>
          {items.map((it, j) => (
            <li key={j} className={it.checked ? "done" : ""}>
              {options.onToggleTask ? (
                <button
                  className="md-task-box md-task-toggle"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    options.onToggleTask!(it.lineIndex, !it.checked);
                  }}
                  aria-checked={it.checked}
                  role="checkbox"
                  data-interactive
                >
                  {it.checked ? "✓" : ""}
                </button>
              ) : (
                <span className="md-task-box" aria-hidden="true">
                  {it.checked ? "✓" : ""}
                </span>
              )}
              <span className="md-task-text">{renderInline(it.text, `t${key}-${j}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul className="md-list" key={key++}>
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `l${key}-${j}`)}</li>
          ))}
        </ul>
      );
      continue;
    } else if (line.trim() === "") {
      nodes.push(
        <span className="md-br" key={key++}>
          {"\n"}
        </span>
      );
    } else {
      nodes.push(
        <span className="md-line" key={key++}>
          {renderInline(line, `p${key}`)}
        </span>
      );
    }
    i++;
  }

  return (
    <span className="md-body" onClick={handleTagClick}>
      {nodes.map((n, j) => (
        <Fragment key={j}>{n}</Fragment>
      ))}
    </span>
  );
}

/**
 * 从文本中提取全部 #标签（去重，保持发现顺序由 Set 保证唯一）。
 *
 * @param text - 便签正文。
 * @returns 标签名数组（不含 # 前缀）。O(len)。
 * @throws 无。
 *
 * @example
 * ```ts
 * extractTags("买牛奶 #购物 #生活"); // ["购物", "生活"]
 * ```
 */
export function extractTags(text: string): string[] {
  const set = new Set<string>();
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(text)) !== null) set.add(m[2].slice(1));
  return [...set];
}
