//! [CRASH-DUMP]崩溃旁车符号化工具。
//!
//! 独立 workspace 成员（与 velatap 同款待遇）：tauri build 只构建根包，本
//! 工具不会被打进安装包、也不会被 bundler 当作应用二进制 patch。
//!
//! 用法：`cargo run -p vela-symbolize -- <崩溃旁车.txt 或含 rva=0x.. 的文本>
//! <对应模块文件（vela.exe 或其 PDB 所在 exe）>`
//!
//! 行为：从旁车解析 `rva=0x…`（异常地址相对模块基址的偏移），dbghelp
//! SymInitialize + SymLoadModuleEx 载入模块符号（PDB 在同目录或 _NT_SYMBOL_PATH），
//! SymFromAddr 还原为 `模块!函数+偏移 [文件:行]`。
//!
//! 发布流程（docs/releasing.md）：官方构建用 `--profile release-with-symbols`
//! 出包并把 PDB 归档在私有位置；用户端崩溃送回旁车 + dmp 后本地/CI 符号化。

use std::path::Path;

fn parse_rva(text: &str) -> Option<u64> {
    // 旁车行：rva=0x1A2B3；大小写不敏感，容忍尾随空白。
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix("rva=")
            .or_else(|| line.strip_prefix("RVA="))
        {
            let hex = rest
                .trim()
                .trim_start_matches("0x")
                .trim_start_matches("0X");
            if let Ok(v) = u64::from_str_radix(hex, 16) {
                return Some(v);
            }
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: {} <崩溃旁车.txt> <模块文件(vela.exe)>", args[0]);
        std::process::exit(2);
    }
    let sidecar = match std::fs::read_to_string(&args[1]) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("读取旁车失败: {e}");
            std::process::exit(1);
        }
    };
    let rva = match parse_rva(&sidecar) {
        Some(v) => v,
        None => {
            eprintln!("旁车里没有可解析的 rva=0x… 行");
            std::process::exit(1);
        }
    };
    let module = Path::new(&args[2]);
    if !module.exists() {
        eprintln!("模块文件不存在: {}", module.display());
        std::process::exit(1);
    }
    symbolize(module, rva);
}

#[cfg(windows)]
fn symbolize(module: &Path, rva: u64) {
    use windows::core::PCWSTR;
    use windows::Win32::System::Diagnostics::Debug::{
        SymFromAddrW, SymInitializeW, SymLoadModuleExW, SymSetSearchPathW, SYMBOL_INFOW,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    let to_wide = |s: &str| -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    };
    // 符号搜索路径：模块目录 + _NT_SYMBOL_PATH（系统默认注入）。
    let dir = module
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let search = format!(
        "{};SRV*C:\\symbols*https://msdl.microsoft.com/download/symbols",
        dir
    );
    let search_w = to_wide(&search);
    let module_w = to_wide(&module.to_string_lossy());

    unsafe {
        let process = GetCurrentProcess();
        if SymInitializeW(process, PCWSTR::null(), true).is_err() {
            eprintln!("SymInitialize 失败");
            std::process::exit(1);
        }
        let _ = SymSetSearchPathW(process, PCWSTR(search_w.as_ptr()));
        // base 传 0：SymLoadModuleEx 只做符号下载/匹配（不实际映射），返回
        // 符号基址；随后 SymFromAddr 用「符号基址 + rva」定位。
        let base = SymLoadModuleExW(
            process,
            None,
            PCWSTR(module_w.as_ptr()),
            PCWSTR::null(),
            0,
            0,
            None,
            Some(windows::Win32::System::Diagnostics::Debug::SYM_LOAD_FLAGS(
                0,
            )),
        );
        if base == 0 {
            eprintln!("SymLoadModuleEx 失败（PDB 不在模块目录 / _NT_SYMBOL_PATH？）");
            std::process::exit(1);
        }
        let addr = base as u64 + rva;
        // SYMBOL_INFOW 变长结构：Name 在结构体尾部，按文档留 1KB 名字缓冲。
        let mut buffer = vec![0u8; std::mem::size_of::<SYMBOL_INFOW>() + 1024];
        let info = buffer.as_mut_ptr() as *mut SYMBOL_INFOW;
        (*info).SizeOfStruct = std::mem::size_of::<SYMBOL_INFOW>() as u32;
        let mut displacement = 0u64;
        if SymFromAddrW(process, addr, Some(&mut displacement), info).is_ok() {
            let name_len = (*info).NameLen as usize;
            let name_start = std::mem::size_of::<SYMBOL_INFOW>();
            let name_bytes = &buffer[name_start..name_start + name_len.min(1024) * 2];
            let name: Vec<u16> = name_bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            println!(
                "{}!{}+0x{displacement:X} (rva 0x{rva:X})",
                module
                    .file_name()
                    .map(|s| s.to_string_lossy())
                    .unwrap_or_default(),
                String::from_utf16_lossy(&name)
            );
        } else {
            println!("rva 0x{rva:X} 未能解析到符号（PDB 与模块不匹配？）");
        }
    }
}

#[cfg(not(windows))]
fn symbolize(_module: &Path, rva: u64) {
    eprintln!("仅支持 Windows；rva=0x{rva:X}");
    std::process::exit(1);
}
