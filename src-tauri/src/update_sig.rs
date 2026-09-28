//! D-1（审查修复）：更新清单 Ed25519 签名验证。
//!
//! 信任模型：`.sha256` sidecar 与安装包同源，只防损坏不防「源被攻破后连
//! 哈希一起换」。签名把清单内容（含安装包哈希）锚定到随应用分发的离线
//! 公钥上——更新源即使被完全攻破，也无法伪造能通过验证的清单。
//!
//! 签名对象是规范化载荷字符串（见 [`manifest_payload`]），签名与哈希字段
//! 由 `scripts/release/sign-manifest.mjs` 在发布时生成。未携带签名的清单
//! 走旧的 sidecar 校验路径（较弱，更新页会提示）。

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// 离线公钥（Ed25519，32 字节）。对应私钥保存在仓库外（工作区
/// release-keys/），泄漏或轮换时更换此常量并随版本发布。
pub const UPDATE_MANIFEST_PUBKEY_HEX: &str =
    "60167ac3ae5e590d71610aa429d8322121080635a10269bd2a933d7a97f6881b";

/// 载荷域分隔前缀：防跨协议重放（同一签名不能被拿去签别的东西）。
const PAYLOAD_PREFIX: &str = "vela-update-manifest-v1";

/// 清单规范化载荷：前缀 + 五个字段以 `|` 相连（与前端/签名工具逐字一致）。
/// notes/url 缺省时以空串参与拼接，保证三方（前端、Rust、签名工具）对同一
/// 清单算出同一字符串。
pub fn manifest_payload(version: &str, notes: &str, url: &str, sha256: &str) -> String {
    format!("{PAYLOAD_PREFIX}|{version}|{notes}|{url}|{sha256}")
}

/// base64（标准字母表，含 padding）解码。
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("签名 base64 解码失败：{e}"))
}

fn hex_decode32(s: &str) -> Result<[u8; 32], String> {
    let s = s.trim();
    if s.len() != 32 * 2 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("公钥格式无效".into());
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).map_err(|_| "公钥格式无效")?, 16)
            .map_err(|_| "公钥格式无效".to_string())?;
    }
    Ok(out)
}

/// 验证清单签名：payload 为 [`manifest_payload`] 的产出，sig_b64 为 base64
/// Ed25519 签名。任何一步失败都返回 Err（调用方按 fail-closed 处理）。
pub fn verify_manifest_signature(payload: &str, sig_b64: &str) -> Result<(), String> {
    let key_bytes = hex_decode32(UPDATE_MANIFEST_PUBKEY_HEX)?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| "公钥解析失败".to_string())?;
    let sig_bytes = b64_decode(sig_b64)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "签名长度无效".to_string())?;
    key.verify(payload.as_bytes(), &sig)
        .map_err(|_| "更新清单签名验证失败".to_string())
}

/// 前端在解析 manifest 后调用：传 manifest 字段（版本/说明/下载地址/哈希），
/// 载荷规范化由本侧 [`manifest_payload`] 单点完成（不信任前端拼串），签名
/// 有效返回 Ok(true)。挂 trusted_window 闸门（命令本身无副作用，但保持
/// 验证入口不被任意窗口探测公钥行为）。
#[tauri::command]
pub fn verify_update_manifest(
    window: tauri::Window,
    version: String,
    notes: String,
    url: String,
    sha256: String,
    sig: String,
) -> Result<bool, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    let payload = manifest_payload(&version, &notes, &url, &sha256);
    verify_manifest_signature(&payload, &sig)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_payload() -> String {
        manifest_payload(
            "0.2.0",
            "修复若干",
            "https://example.com/Vela.exe",
            &"a".repeat(64),
        )
    }

    #[test]
    fn roundtrip_valid_signature() {
        // 测试密钥对（与内嵌公钥无关）：验证算法接线正确
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let sig = sk.sign(test_payload().as_bytes());
        let sig_b64 = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
        };
        // 用测试公钥直接走底层验证（绕过内嵌常量）
        let vk = ed25519_dalek::VerifyingKey::from(&sk);
        assert!(vk
            .verify(
                test_payload().as_bytes(),
                &Signature::from_slice(&{
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(&sig_b64)
                        .unwrap()
                })
                .unwrap()
            )
            .is_ok());
        // 篡改一个字符必须失败
        let mut tampered = test_payload();
        tampered.replace_range(0..1, "X");
        assert!(vk
            .verify(
                tampered.as_bytes(),
                &Signature::from_slice(&{
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(&sig_b64)
                        .unwrap()
                })
                .unwrap()
            )
            .is_err());
    }

    #[test]
    fn embedded_pubkey_parses() {
        let bytes = hex_decode32(UPDATE_MANIFEST_PUBKEY_HEX).unwrap();
        assert_eq!(bytes.len(), 32);
        assert!(VerifyingKey::from_bytes(&bytes).is_ok());
    }

    #[test]
    fn payload_format_is_stable() {
        let p = manifest_payload("1.0.0", "", "", &"0".repeat(64));
        assert!(p.starts_with("vela-update-manifest-v1|1.0.0|||"));
        assert!(p.ends_with(&"0".repeat(64)));
    }

    #[test]
    fn bad_signature_rejected() {
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let sig = sk.sign(test_payload().as_bytes());
        // 用另一把公钥验证必然失败
        let other = SigningKey::from_bytes(&[3u8; 32]);
        let vk = VerifyingKey::from(&other);
        assert!(vk.verify(test_payload().as_bytes(), &sig).is_err());
    }

    #[test]
    fn known_answer_against_embedded_pubkey() {
        // 由 scripts/release/sign-manifest.mjs + 工作区 release-keys 私钥生成
        // （2026-09-28）：内嵌公钥与签名工具/私钥三方一致的端到端证据。
        let payload = manifest_payload(
            "1.0.0",
            "测试",
            "https://example.com/Vela.exe",
            &"a".repeat(64),
        );
        let sig_b64 = "25iJTtDzXfspEBgG6ZdmwLozenEUbySfboulITpEaV3It8otdO3aQaqa2wB9rUlBSQEOoFhaHt2pZvWeV2ZLBw==";
        assert!(verify_manifest_signature(&payload, sig_b64).is_ok());
        // 载荷任一字段被改动都必须失败
        let tampered = manifest_payload(
            "1.0.1",
            "测试",
            "https://example.com/Vela.exe",
            &"a".repeat(64),
        );
        assert!(verify_manifest_signature(&tampered, sig_b64).is_err());
    }
}
