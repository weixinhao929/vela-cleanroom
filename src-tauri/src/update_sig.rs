//! ：更新清单 Ed25519 签名验证。
//!
//! 信任模型：`.sha256` sidecar 与安装包同源，只防损坏不防「源被攻破后连
//! 哈希一起换」。签名把清单内容（含安装包哈希）锚定到随应用分发的离线
//! 公钥上——更新源即使被完全攻破，也无法伪造能通过验证的清单。
//!
//! 签名对象是规范化载荷字符串（见 [`manifest_payload`]），签名与哈希字段
//! 由 `scripts/release/sign-manifest.mjs` 在发布时生成。
//!
//! ：未携带签名的清单**不再**默认走旧的 sidecar 校验弱路径
//! ——`download_update` 对无签名清单缺省拒绝（fail-closed），只有调用方显式
//! 传 `allow_unsigned_sidecar=true` 才保留「最后兼容路径」（同源 `.sha256`
//! sidecar，仅防损坏不防源被攻破）。签名机制之前的旧 Release 只能手动下载。
//!
//! ：签名验证与下载安装在此绑定——验签通过即把资产
//! (url, sha256, version) 登记为后端侧唯一信任源（进程内证据清单，TTL +
//! 容量上限），`download_update` 只接受命中清单的 (url, sha256)（消费即
//! 移除防重放）且版本必须高于当前版本。前端回传的哈希/地址本身不再构成信任。

use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/* ------------------------------------------------------------------ */
/* 验签清单的后端绑定证据 */
/* ------------------------------------------------------------------ */

/// 证据有效期：检查更新与点击「下载并安装」之间通常只有分钟级间隔；超期即
/// 作废（重新检查一次即重新登记），不给重放留长期窗口。
const VERIFIED_TTL: Duration = Duration::from_secs(30 * 60);
/// 证据容量上限：正常流程一次检查只登记一条。被注入的 webview 即使反复调用
/// verify_update_manifest 也只能把清单撑到这个上限（FIFO 逐出最旧），内存
/// 占用有界。
const VERIFIED_CAP: usize = 8;

/// 一条验签通过的清单资产（签名锚定的 url + sha256 + version 三元组）。
#[derive(Clone)]
struct VerifiedAsset {
    url: String,
    /// 小写归一后的 64 hex（与 download_update 的比对口径一致）。
    sha256: String,
    version: String,
    at: Instant,
}

/// 进程内证据清单（无需跨进程持久——下载与验签在同一后端进程内完成）。
static VERIFIED_ASSETS: Mutex<Vec<VerifiedAsset>> = Mutex::new(Vec::new());

/// 纯函数（单测覆盖）：登记一条证据——先清过期，再按容量 FIFO 逐出最旧。
fn insert_verified_asset(
    store: &mut Vec<VerifiedAsset>,
    version: &str,
    url: &str,
    sha256: &str,
    ttl: Duration,
    cap: usize,
    now: Instant,
) {
    store.retain(|a| now.duration_since(a.at) < ttl);
    while store.len() >= cap {
        store.remove(0);
    }
    store.push(VerifiedAsset {
        url: url.trim().to_string(),
        sha256: sha256.trim().to_ascii_lowercase(),
        version: version.trim().to_string(),
        at: now,
    });
}

/// 纯函数（单测覆盖）：取出与 (url, sha256) 精确匹配且未过期的证据，
/// **取走即移除**（防重放：同一份验签证据只允许驱动一次下载）。
/// 返回其清单版本（供 download_update 做版本下限判定）。
fn take_verified_asset(
    store: &mut Vec<VerifiedAsset>,
    url: &str,
    sha256: &str,
    ttl: Duration,
    now: Instant,
) -> Option<String> {
    let want_sha = sha256.trim().to_ascii_lowercase();
    let idx = store.iter().position(|a| {
        now.duration_since(a.at) < ttl && a.url == url.trim() && a.sha256 == want_sha
    })?;
    Some(store.remove(idx).version)
}

/// verify_update_manifest 成功路径调用：把验签通过的资产登记为后端侧唯一
/// 信任源。download_update 收到的 expected_sha256 必须命中这里登记过的
/// (url, sha256)，前端回传的哈希本身不再被信任。
pub(crate) fn record_verified_manifest(version: &str, url: &str, sha256: &str) {
    let mut guard = VERIFIED_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    insert_verified_asset(
        &mut guard,
        version,
        url,
        sha256,
        VERIFIED_TTL,
        VERIFIED_CAP,
        Instant::now(),
    );
}

/// download_update 消费证据：命中返回清单版本，未命中（未验证 / 已过期 /
/// 已被消费过）返回 None——调用方一律 fail-closed 拒绝下载。
pub(crate) fn take_verified_manifest(url: &str, sha256: &str) -> Option<String> {
    let mut guard = VERIFIED_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    take_verified_asset(&mut guard, url, sha256, VERIFIED_TTL, Instant::now())
}

/// 宽松语义化比较：剥可选 `v` 前缀、按 `.` 分段取前导数字（非法段计 0），
/// 逐段比较，candidate **严格大于** current 才返回 true。解析不出任何有效
/// 段的输入（如乱码）在任何当前版本下都判 false——fail-closed：版本不可
/// 判读宁可拒绝升级，也不给降级留缝。
pub fn version_gt(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split('.')
            .map(|seg| {
                let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<u64>().unwrap_or(0)
            })
            .collect()
    };
    let (c, k) = (parse(candidate), parse(current));
    let len = c.len().max(k.len());
    for i in 0..len {
        let a = c.get(i).copied().unwrap_or(0);
        let b = k.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
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
/// 有效返回 Ok(true)。挂 trusted_window 闸门（命令登记下载信任源，保持验证
/// 入口不被任意窗口探测公钥行为）。
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
    // 验签通过不再只是回一个 bool——把资产清单
    // (version, url, sha256) 登记进后端内存，作为 download_update 的唯一
    // (url, sha256) 信任源（下载命中即消费移除）。此前 download 单独信任
    // 前端回传的 expected_sha256，被注入的受信 webview 可以拿任意历史旧版
    // 安装包的真实签名哈希实现静默降级、或安装同域任意 .exe——现在这两个
    // 参数必须与本次验签登记的证据逐字一致。url/sha256 任一为空的清单没有
    // 可下载资产，不占证据容量。
    if !url.trim().is_empty() && !sha256.trim().is_empty() {
        record_verified_manifest(&version, &url, &sha256);
    }
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

    // ---- ：证据清单（绑定 + 防重放 + 过期 + 容量）----

    /// 与全局静态同构的局部 store：避免并行测试触碰进程级 VERIFIED_ASSETS。
    #[test]
    fn verified_asset_roundtrip_replay_and_expiry() {
        let mut store = Vec::new();
        let ttl = Duration::from_secs(1800);
        let t0 = Instant::now();
        let (url, sha) = ("https://example.com/Vela.exe", "a".repeat(64));
        insert_verified_asset(&mut store, "0.3.0", url, &sha, ttl, 8, t0);
        // 命中：哈希大小写归一后比对，返回清单版本。
        assert_eq!(
            take_verified_asset(&mut store, url, &sha.to_ascii_uppercase(), ttl, t0),
            Some("0.3.0".to_string())
        );
        // 重放：同一证据第二次取必须落空（下载只能被驱动一次）。
        assert_eq!(take_verified_asset(&mut store, url, &sha, ttl, t0), None);
        // url 不一致（哪怕同哈希）也不命中——绑定是 (url, sha256) 精确对。
        insert_verified_asset(&mut store, "0.3.0", url, &sha, ttl, 8, t0);
        assert_eq!(
            take_verified_asset(
                &mut store,
                "https://evil.example.com/other.exe",
                &sha,
                ttl,
                t0
            ),
            None
        );
        // TTL 过期后不可取。
        assert_eq!(
            take_verified_asset(&mut store, url, &sha, ttl, t0 + Duration::from_secs(1801)),
            None
        );
    }

    #[test]
    fn verified_asset_insert_prunes_expired_and_evicts_by_cap() {
        let ttl = Duration::from_secs(100);
        let t0 = Instant::now();
        let mut store = Vec::new();
        // 登记时顺手清掉已过期条目（过期证据不占容量）。
        insert_verified_asset(
            &mut store,
            "0.1.0",
            "https://example.com/old.exe",
            &"0".repeat(64),
            ttl,
            8,
            t0,
        );
        insert_verified_asset(
            &mut store,
            "0.2.0",
            "https://example.com/new.exe",
            &"1".repeat(64),
            ttl,
            8,
            t0 + Duration::from_secs(5),
        );
        assert_eq!(store.len(), 2);
        insert_verified_asset(
            &mut store,
            "0.3.0",
            "https://example.com/x.exe",
            &"2".repeat(64),
            ttl,
            8,
            t0 + Duration::from_secs(200),
        );
        // 前两条已过期（200 > 100），登记第三条时被清。
        assert_eq!(store.len(), 1);

        // 容量：灌满 cap 后再插，最旧（FIFO 队头）被逐出。
        let mut store = Vec::new();
        for i in 0..8 {
            insert_verified_asset(
                &mut store,
                "0.0.1",
                &format!("https://example.com/{i}.exe"),
                &format!("{i:064x}"),
                ttl,
                8,
                t0 + Duration::from_secs(i),
            );
        }
        assert_eq!(store.len(), 8);
        let first_url = store[0].url.clone();
        insert_verified_asset(
            &mut store,
            "0.9.9",
            "https://example.com/ninth.exe",
            &"9".repeat(64),
            ttl,
            8,
            t0 + Duration::from_secs(99),
        );
        assert_eq!(store.len(), 8);
        assert_ne!(store[0].url, first_url, "队头最旧证据被逐出");
        assert_eq!(store.last().unwrap().url, "https://example.com/ninth.exe");
    }

    #[test]
    fn version_gt_table() {
        let cur = "0.2.5";
        assert!(version_gt("0.2.6", cur));
        assert!(version_gt("0.3.0", cur));
        assert!(version_gt("1.0.0", cur));
        assert!(version_gt("v0.2.6", cur), "v 前缀容忍");
        assert!(version_gt("0.2.6-insider", cur), "预发布后缀取前导数字");
        // 等于 / 低于当前：一律 false（版本下限是「严格大于」）。
        assert!(!version_gt("0.2.5", cur));
        assert!(!version_gt("v0.2.5", cur));
        assert!(!version_gt("0.2.4", cur));
        assert!(!version_gt("0.2", cur));
        assert!(!version_gt("0.1.99", cur));
        // 不可判读输入 fail-closed：任何形态都不得判「高于」。
        assert!(!version_gt("", cur));
        assert!(!version_gt("garbage", cur));
        assert!(!version_gt("...", cur));
        // 段数不同但语义相等（0.2.5 == 0.2.5.0）不算高于。
        assert!(!version_gt("0.2.5.0", cur));
    }
}
