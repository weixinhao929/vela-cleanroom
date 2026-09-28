/**
 * MD5 纯函数实现（编码哈希工具的文本模式用；文件模式走 Rust 流式哈希）。
 * RFC 1321，输入 UTF-8 字节，输出 32 位小写 hex。WebCrypto 不提供 MD5，
 * 这里手写紧凑版供 domain 层单测与组件直接使用。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

/** K[i] = floor(2^32 × |sin(i+1)|)，查表预生成。 */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
}

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** 对 UTF-8 字节做 MD5，返回 32 位小写 hex。 */
export function md5Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  // 填充：0x80 + 0×N + 8 字节位长（bit length），使总长 ≡ 56 (mod 64)。
  const bitLen = BigInt(msg.length) * 8n;
  const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  for (let i = 0; i < 8; i++) {
    padded[padded.length - 8 + i] = Number((bitLen >> BigInt(8 * i)) & 0xffn);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const w = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        padded[off + i * 4] |
        (padded[off + i * 4 + 1] << 8) |
        (padded[off + i * 4 + 2] << 16) |
        (padded[off + i * 4 + 3] << 24);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      B = (B + rotl((A + F + K[i] + w[g]) >>> 0, S[i])) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(0, a0, true);
  new DataView(out.buffer).setUint32(4, b0, true);
  new DataView(out.buffer).setUint32(8, c0, true);
  new DataView(out.buffer).setUint32(12, d0, true);
  let hex = "";
  for (const b of out) hex += b.toString(16).padStart(2, "0");
  return hex;
}
