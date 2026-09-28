//! 编码哈希工具的文件侧（借鉴 ClassSoftwareHub #2）：对用户指定的本地
//! 文件做流式哈希——1MB 缓冲逐块喂给四个摘要器（MD5 / SHA-1 / SHA-256 /
//! SHA-512），任意大小文件内存占用恒定。路径由用户在组件里拖入或选取，
//! 命令挂 trusted_window 闸门；读取失败返回人话错误，不区分细节防探测。

use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use ts_rs::TS;

use serde::Serialize;

/// 文件哈希结果（hex 小写）。bytes 用于组件展示体积。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct FileHashes {
    pub md5: String,
    pub sha1: String,
    pub sha256: String,
    pub sha512: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 流式读取并同时计算四种摘要；缓冲 1MB（与 CSH EncodingTool 同规格）。
pub fn hash_reader(mut r: impl std::io::Read) -> std::io::Result<FileHashes> {
    let mut md5h = Md5::new();
    let mut sha1h = Sha1::new();
    let mut sha256h = Sha256::new();
    let mut sha512h = Sha512::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut bytes: u64 = 0;
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        md5h.update(chunk);
        sha1h.update(chunk);
        sha256h.update(chunk);
        sha512h.update(chunk);
        bytes += n as u64;
    }
    Ok(FileHashes {
        md5: hex(&md5h.finalize()),
        sha1: hex(&sha1h.finalize()),
        sha256: hex(&sha256h.finalize()),
        sha512: hex(&sha512h.finalize()),
        bytes,
    })
}

#[tauri::command]
pub async fn hash_file(window: tauri::Window, path: String) -> Result<FileHashes, String> {
    if !crate::trusted_window(window.label()) {
        return Err("untrusted window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let f = std::fs::File::open(&path).map_err(|e| format!("打开文件失败：{e}"))?;
        hash_reader(std::io::BufReader::new(f)).map_err(|e| format!("读取文件失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_reader_matches_known_vectors() {
        // "abc" 的标准摘要向量（RFC 1321 / FIPS 180-4）。
        let r = hash_reader(&b"abc"[..]).unwrap();
        assert_eq!(r.md5, "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(r.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            r.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            r.sha512,
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
        assert_eq!(r.bytes, 3);
    }

    #[test]
    fn hash_reader_empty_input() {
        let r = hash_reader(&b""[..]).unwrap();
        assert_eq!(r.md5, "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(r.bytes, 0);
    }

    #[test]
    fn hash_reader_multi_chunk_streaming() {
        // 跨多个 1MB 块的流：用重复模式数据验证分块喂摘要不丢字节。
        let chunk = vec![0xA5u8; 3 * 1024 * 1024 + 17];
        let r = hash_reader(&chunk[..]).unwrap();
        assert_eq!(r.bytes, chunk.len() as u64);
        // 与一次性内存摘要对照（sha2 独立重算）。
        let mut h = Sha256::new();
        h.update(&chunk);
        assert_eq!(r.sha256, hex(&h.finalize()));
    }
}
