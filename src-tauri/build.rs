fn main() {
    // lib 的单元测试 harness 不带 tauri_build 的应用清单，而 muda（菜单库）
    // 静态引用 Common-Controls v6 专有入口（TaskDialogIndirect 等）——没有
    // 清单时 harness 绑定默认 v5 comctl32，进程加载即
    // STATUS_ENTRYPOINT_NOT_FOUND。/MANIFESTINPUT 会在 bin 测试与 tauri 的
    // resource.lib 清单重复（CVT1100），故改用 delay-load：comctl32 推迟到
    // 首次调用再解析——不触菜单的测试永远不加载它；应用二进制自带 v6 清单，
    // 首次调用照常解析到 v6，行为不变。
    #[cfg(target_env = "msvc")]
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");
    }
    tauri_build::build()
}
