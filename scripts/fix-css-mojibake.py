"""
修复 CSS 注释里的 GBK 双重编码乱码（UTF-8 字节被当作 GBK 解码后再以 UTF-8 存盘）。

只处理 /* ... */ 注释块；对块内每个「非 ASCII 连续片段」尝试
  piece.encode("gbk") -> bytes.decode("utf-8")
两步都严格成功且结果含 CJK 才替换；真正的中文经此转换几乎必然失败（GBK 字节
不构成合法 UTF-8 序列），所以不会误伤正常注释。含 '?' 的片段是当初就丢了字节的，
跳过不动。

用法：python fix-css-mojibake.py [--write] file...

【2026-09-26 审计结论】对存量 src/styles/*.css 全量空跑（本脚本 + cp936/gb18030
多编解码 + 迭代逆转变体）：5082 个非 ASCII 片段 0 个可干净还原——剩余乱码全部
是多轮/丢字节的有损损坏（0x80 字节破坏 GBK 配对，原始文本不可恢复）。自动批量
清理不可行，治理策略改为「改到哪、把那一段注释重写到哪」（改 CSS 规则时顺手
把它的乱码注释重写成正常中文）。
"""
import os
import re
import sys

CJK = re.compile(r"[\u4e00-\u9fff]")
PUA = re.compile(r"[\ue000-\uf8ff\ufffd]")
COMMENT = re.compile(r"/\*.*?\*/", re.S)
NON_ASCII_RUN = re.compile(r"[^\x00-\x7f]+")


def check_path(path: str) -> bool:
    """只允许处理仓库内的 CSS（解析绝对路径并拒绝一切越界，含 ../ 穿越）。
    这是开发机一次性维护脚本，本不该接受仓库外目标——收口 Mimosa HIGH
    （scripts/fix-css-mojibake.py 路径穿越）。"""
    root = os.path.realpath(os.getcwd())
    real = os.path.realpath(os.path.abspath(path))
    return (real + os.sep).startswith(root + os.sep) and real.endswith(".css")


def decode_once(piece: str):
    try:
        return piece.encode("gbk").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None


def looks_chinese(s: str) -> bool:
    """真中文注释的汉字 ≥85% 落在 GB2312 一级常用字区（GBK 首字节 0xB0–0xD7）；
    乱码几乎全是二级/扩展区字符。非汉字字符不参与统计。"""
    total = 0
    common = 0
    for ch in s:
        if not CJK.match(ch):
            continue
        total += 1
        try:
            b = ch.encode("gbk")
        except UnicodeEncodeError:
            continue
        if 0xB0 <= b[0] <= 0xD7:
            common += 1
    return total > 0 and common / total >= 0.85


def fix_piece(piece: str):
    """迭代逆转（最多 4 层）：多重编码的片段一轮之后仍是乱码，继续到结果像真中文
    为止。任何一层出现私用区/替换字符，或层层逆转后仍不像中文（当初已丢字节的
    有损链），整段放弃不动。"""
    cur = piece
    for _ in range(4):
        nxt = decode_once(cur)
        if nxt is None or nxt == cur:
            return None
        if PUA.search(nxt):
            return None
        cur = nxt
        if looks_chinese(cur):
            return cur
    return None


def fix_comment(text: str, stats: dict) -> str:
    def repl(m: re.Match) -> str:
        piece = m.group(0)
        fixed = fix_piece(piece)
        if fixed is None or fixed == piece:
            stats["skipped"] += 1
            return piece
        stats["fixed"] += 1
        if len(stats["samples"]) < 12:
            stats["samples"].append((piece[:40], fixed[:40]))
        return fixed

    return NON_ASCII_RUN.sub(repl, text)


def process(path: str, write: bool) -> None:
    raw = open(path, "rb").read()
    text = raw.decode("utf-8")
    stats = {"fixed": 0, "skipped": 0, "samples": []}
    out = COMMENT.sub(lambda m: fix_comment(m.group(0), stats), text)
    print(f"{path}: fixed runs={stats['fixed']} skipped runs={stats['skipped']}")
    for a, b in stats["samples"]:
        print(f"    {a!r} -> {b!r}")
    if write and out != text:
        open(path, "wb").write(out.encode("utf-8"))
        print("    written")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv
    bad = [p for p in args if not check_path(p)]
    if bad:
        print(f"refusing to touch paths outside repo or non-css: {bad}", file=sys.stderr)
        sys.exit(2)
    for p in args:
        process(p, write)
