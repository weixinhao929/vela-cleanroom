//! 主进程（focus-desk 的 taskbar/ 模块）与注入 DLL（velatap.dll）的共享定义。
//!
//! 本 crate 是两侧唯一的交叠面：管道线协议 + 服务端白名单。只依赖
//! serde / serde_json 与标准库，**不得引用任何一侧的内部类型**——这原先靠
//! `#[path]` 包含文件头部的注释自律，现在是 crate 边界，由编译器保证。

pub mod protocol;
pub mod servers;
