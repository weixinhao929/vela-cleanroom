#!/usr/bin/env node
/**
 * D-1：更新清单 Ed25519 签名工具（发布链配套）。
 *
 * 用法：
 *   node scripts/release/sign-manifest.mjs --key <私钥PEM> \
 *       --version 0.2.0 [--notes "修复若干"] --url https://…/Vela.exe \
 *       --sha256 <安装包64位hex>
 *   省略 --sha256 时可传 --exe <安装包路径> 由本工具现算。
 *
 * 输出：可直接部署的 manifest JSON（version/notes/url/sha256/sig）。
 * 载荷规范与前端 buildManifestPayload / Rust update_sig.rs 逐字一致：
 *   vela-update-manifest-v1|{version}|{notes}|{url}|{sha256}
 *
 * 私钥保存在仓库外（工作区 release-keys/，见其 README）。公钥内嵌于
 * src-tauri/src/update_sig.rs 的 UPDATE_MANIFEST_PUBKEY_HEX。
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const keyPath = opt("key");
const version = opt("version");
const notes = opt("notes") ?? "";
const url = opt("url");
let sha256 = opt("sha256");
const exe = opt("exe");

if (!keyPath || !version || !url) {
  console.error(
    "用法：sign-manifest.mjs --key <私钥PEM> --version vX.Y.Z [--notes …] --url https://… [--sha256 <hex> | --exe <安装包路径>]"
  );
  process.exit(2);
}
if (!/^https:\/\//i.test(url)) {
  console.error("D-1：下载 URL 必须 https");
  process.exit(2);
}
if (!sha256) {
  if (!exe) {
    console.error("需要 --sha256 或 --exe 之一");
    process.exit(2);
  }
  sha256 = createHash("sha256").update(readFileSync(exe)).digest("hex");
}
if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
  console.error("--sha256 必须是 64 位十六进制");
  process.exit(2);
}
sha256 = sha256.toLowerCase();

const v = version.trim().replace(/^v/i, "");
const payload = ["vela-update-manifest-v1", v, notes, url, sha256].join("|");
const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
const sig = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");

const manifest = { version: v, notes, url, sha256, sig };
console.log(JSON.stringify(manifest, null, 2));
console.error(`payload: ${payload}`);
