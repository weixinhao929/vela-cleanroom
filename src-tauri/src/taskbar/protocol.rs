//! 任务栏线协议的兼容垫片（审计修复）：定义已抽到 workspace 共享
//! crate `taskbar_common`（主进程与 velatap DLL 共同依赖），本文件只做
//! re-export，保持 `crate::taskbar::protocol::*` / `use crate::taskbar::protocol`
//! 的既有路径不变。改动协议请去 crates/taskbar_common/src/protocol.rs
//! （并按其冻结纪律递增 PROTOCOL_VERSION）。

pub use taskbar_common::protocol::*;
