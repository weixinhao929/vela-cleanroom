//! 任务栏登记表与外观应用——标杆 taskbarappearanceservice.cpp 的 Rust 等价物。
//!
//! 线程模型：所有触及 XAML 对象的操作都在**该任务栏自己的 UI 线程**上执行
//! （登记时捕获 `DispatcherQueue`，见 watcher.rs）；本模块的公开入口
//! [`dispatch`] 只负责按帧投递闭包。多任务栏（主屏 + 副屏）可能分属不同
//! UI 线程——比标杆的单 dispatcher 转发更保守。
//!
//! 锁纪律：REGISTRY 是跨线程快照锁，**锁内只做纯数据读写、COM 指针克隆与
//! 轻量 Win32 查询，不做任何 XAML 属性写**。`put_Fill` 会在设置线程上同步
//! 触发 [`FillChangedHandler`]，后者要进 `with_registry`——持锁 put 即同线程
//! 对非重入 Mutex 二次加锁，任务栏 UI 线程直接冻死（表现为任务栏 / 开始菜单
//! 无响应）。所有 put 统一走 [`set_slot_fill`]：锁内取快照 → 锁外 XAML →
//! 锁内写回。
//!
//! 原始 Fill 保存与刷新：登记时若 Fill 已非空直接存；否则等系统首次赋值时由
//! 属性变更回调补采（对齐系统任务栏外观服务的行为）。回调此后
//! **常驻**：系统因明暗主题 / 强调色变化重设 Fill 时，刷新原始画刷并重套用
//! 当前自定义外观（系统外观变化即重套用的语义），这样恢复
//! 时恢复到的是"当下"的系统画刷，而不是主题切换前采到的旧值。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
};
use windows::UI::Color;
use windows_core::{implement, Interface};

use crate::blur_brush::{create_blur_brush, BlurBrushParams};
use crate::diag::{IXamlDiagnostics, InstanceHandle};
use crate::protocol::{TapAccent, TapMessage};
use crate::xaml::{
    IBrush, IDependencyObject, IDependencyObject2, IDependencyProperty,
    IDependencyPropertyChangedCallback, IDependencyPropertyChangedCallback_Impl, IShape,
    IShapeStatics, ISolidColorBrush, ACRYLIC_BACKGROUND_SOURCE_BACKDROP,
};

/// 线协议 monitor 选择器是否命中某台任务栏（0 = 全部）。纯函数，单测覆盖。
pub fn monitor_matches(target: u64, taskbar_monitor: u64) -> bool {
    target == 0 || target == taskbar_monitor
}

/// σ = blur_radius / 3（D5；radius ∈ [0,750] → σ ∈ [0,250]）。纯函数。
pub fn sigma_from_radius(blur_radius: u32) -> f32 {
    blur_radius as f32 / 3.0
}

/// unpack_abgr + 按 accent 归一颜色。opaque 强制不透明；其余保留 alpha。纯函数。
pub fn effective_color(accent: TapAccent, color_abgr: u32) -> Color {
    let (r, g, b, a) = crate::protocol::unpack_abgr(color_abgr);
    let a = match accent {
        TapAccent::Opaque => 0xFF,
        _ => a,
    };
    Color {
        A: a,
        R: r,
        G: g,
        B: b,
    }
}

/// tint 的线性空间 [r,g,b,a]（Flood 效果用）。
fn tint_float4(c: Color) -> [f32; 4] {
    [
        c.R as f32 / 255.0,
        c.G as f32 / 255.0,
        c.B as f32 / 255.0,
        c.A as f32 / 255.0,
    ]
}

fn same_identity(a: &impl Interface, b: &impl Interface) -> bool {
    match (
        a.cast::<windows_core::IUnknown>(),
        b.cast::<windows_core::IUnknown>(),
    ) {
        (Ok(x), Ok(y)) => Interface::as_raw(&x) == Interface::as_raw(&y),
        _ => false,
    }
}

/// `Option<画刷>` 的身份比较：两侧皆空视为相同（"put 了 null" 与"当前为 null"）。
fn same_brush(a: Option<&IBrush>, b: Option<&IBrush>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => same_identity(x, y),
        _ => false,
    }
}

/// 当前线程宿主的任务栏顶层窗口（`Shell_TrayWnd` / `Shell_SecondaryTrayWnd`）。
/// 可视树回调跑在任务栏自己的 UI 线程上，线程即最强归属证据；多屏任务栏共享
/// 线程时取首个（仅影响逐屏取 monitor 的精度，不影响注册成败）。
fn tray_window_for_current_thread() -> Option<HWND> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId,
    };
    let tid = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    struct Ctx {
        tid: u32,
        found: Option<HWND>,
        ambiguous: bool,
    }
    let mut ctx = Ctx {
        tid,
        found: None,
        ambiguous: false,
    };
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        let mut pid = 0u32;
        if unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) } != ctx.tid {
            return windows::core::BOOL(1);
        }
        let mut buf = [0u16; 32];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) };
        if n == 0 {
            return windows::core::BOOL(1);
        }
        let class = String::from_utf16_lossy(&buf[..n as usize]);
        if class != "Shell_TrayWnd" && class != "Shell_SecondaryTrayWnd" {
            return windows::core::BOOL(1);
        }
        if ctx.found.is_some() {
            ctx.ambiguous = true;
            return windows::core::BOOL(0); // 多屏同线程：取首个即可，提前收尾
        }
        ctx.found = Some(hwnd);
        windows::core::BOOL(1)
    }
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    if ctx.ambiguous {
        crate::vlog!(
            "tray_window_for_current_thread: multiple tray windows on this thread, using first"
        );
    }
    ctx.found
}

/// 每帧两个槽位（背景 / 顶线）之一。
struct Slot {
    shape: IShape,
    original_fill: Option<IBrush>,
    /// Fill 属性变更回调 token（0 = 未注册）。
    fill_changed_token: i64,
    /// 本方 put_Fill 进行中：属性变更回调在设置线程上同步触发，据此忽略本次
    /// 变更（否则会把自己刚套上的画刷当成系统新默认值采走）。
    suppress_callback: bool,
    /// 本方最近一次 put 进去的画刷（None = put 了 null）。回调侧的第二道判定：
    /// 当前 Fill 与之同身份即视为本方变更——即便通知被 XAML 延后派发也不误判。
    last_put: Option<IBrush>,
}

impl Slot {
    fn new(shape: IShape) -> Self {
        Self {
            shape,
            original_fill: None,
            fill_changed_token: 0,
            suppress_callback: false,
            last_put: None,
        }
    }
}

/// 最近成功套用到背景槽的自定义外观（None = 系统默认 / 已恢复）。系统重设
/// Fill 后 [`FillChangedHandler`] 据此重套用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AppliedBackground {
    accent: TapAccent,
    color_abgr: u32,
    blur_radius: u32,
}

impl AppliedBackground {
    /// "恢复系统默认"（Normal 不看颜色 / 半径）。
    const NORMAL: Self = Self {
        accent: TapAccent::Normal,
        color_abgr: 0,
        blur_radius: 0,
    };
}

struct TaskbarEntry {
    hwnd: HWND,
    hmonitor: u64,
    dispatcher: Option<windows::System::DispatcherQueue>,
    background: Option<Slot>,
    border: Option<Slot>,
    applied: Option<AppliedBackground>,
    /// 顶线是否被本方隐藏（false = 系统默认 / 已恢复）。
    border_hidden: bool,
}

/// 注册表本体——XAML 成员只在任务栏 UI 线程（或其 Dispatcher 闭包）里访问；
/// 结构整体再套 Mutex 供管道线程做帧快照。
struct Registry {
    taskbars: HashMap<InstanceHandle, TaskbarEntry>,
    /// Add 事件簿记 child→parent：BackgroundFill 向上找 TaskbarFrame 用
    /// （替代标杆 VisualTreeHelper::GetParent 走查——纯数据、零额外 COM
    /// 调用，R3 容错更好）。
    parent_of: HashMap<InstanceHandle, InstanceHandle>,
    /// 尚未匹配到任务栏的 DesktopWindowXamlSource 句柄。
    unmatched_sources: HashSet<InstanceHandle>,
    diag: IXamlDiagnostics,
}

impl Registry {
    /// 沿父子簿记向上找最近的 TaskbarFrame（有界深度 64，防环）。
    fn ancestor_frame(&self, mut handle: InstanceHandle) -> Option<InstanceHandle> {
        for _ in 0..64 {
            match self.parent_of.get(&handle) {
                Some(&parent) => {
                    if self.taskbars.contains_key(&parent) {
                        return Some(parent);
                    }
                    handle = parent;
                }
                None => return None,
            }
        }
        None
    }

    fn slot_mut(&mut self, frame: InstanceHandle, border: bool) -> Option<&mut Slot> {
        let entry = self.taskbars.get_mut(&frame)?;
        if border {
            entry.border.as_mut()
        } else {
            entry.background.as_mut()
        }
    }
}

/// COM/XAML 指针只在所属任务栏 UI 线程上被解引用（dispatcher 投递模型），
/// 静态存放与移动本身线程安全——这里显式声明以通过 Arc<Mutex<_>> 静态检查。
unsafe impl Send for Registry {}
unsafe impl Sync for Registry {}

/// 全局注册表（注入成功后常驻）。
static REGISTRY: OnceLock<Arc<Mutex<Registry>>> = OnceLock::new();
/// 全局关闭标记：**仅**协议版本被拒绝后置位（不可恢复：同一 explorer 会话内
/// 换协议只能重启资源管理器），管道线程据此放弃重连。主进程死亡 / 正常退出
/// **不**置位——DLL 保持待命等新主进程建同名管道（见 parent_watch.rs）。
static SHUTDOWN: AtomicU64 = AtomicU64::new(0);

/// 注入早于任务栏注册的分发竞态兜底：主进程在 `on_ready` 即下发基线外观，
/// 而 XAML 可视树回调稍后才会登记第一台任务栏——快照为空时消息会被静默
/// 丢弃，且主进程侧 `last_sent` 去重不会补发，任务栏从此停在系统默认
/// （真机复现：注入成功但外观不生效，直到下一次状态翻转）。凡
/// ApplyAppearance / SetBorderVisibility **零命中**即按 monitor 暂存于此，
/// [`register_taskbar`] 登记新帧时在任务栏 UI 线程上重放。同 monitor 同类型
/// 的新暂存覆盖旧的，保持最新语义；命中后清除。
static PENDING: Mutex<Vec<PendingMessage>> = Mutex::new(Vec::new());

struct PendingMessage {
    /// 线协议 monitor（0 = 全部）。
    monitor: u64,
    message: TapMessage,
}

fn pending_kind(msg: &TapMessage) -> Option<(u64, u8)> {
    match msg {
        TapMessage::ApplyAppearance { monitor, .. } => Some((*monitor, 0)),
        TapMessage::SetBorderVisibility { monitor, .. } => Some((*monitor, 1)),
        _ => None,
    }
}

/// 暂存/覆盖：同 monitor 同类型只保留最新一条（后到的配置语义更新）。
/// 非 per-monitor 消息（RestoreAll 等）不暂存。纯函数，单测覆盖。
fn upsert_pending(pending: &mut Vec<PendingMessage>, message: TapMessage) {
    let Some((monitor, kind)) = pending_kind(&message) else {
        return;
    };
    if let Some(slot) = pending
        .iter_mut()
        .find(|p| p.monitor == monitor && pending_kind(&p.message) == Some((monitor, kind)))
    {
        slot.message = message;
    } else {
        pending.push(PendingMessage { monitor, message });
    }
}

pub fn mark_shutdown() {
    SHUTDOWN.store(1, Ordering::SeqCst);
}

pub fn is_shutdown() -> bool {
    SHUTDOWN.load(Ordering::SeqCst) != 0
}

/// 注入成功时安装全局注册表（幂等；重复调用返回 false）。
pub fn install_registry(diag: IXamlDiagnostics) -> bool {
    REGISTRY
        .set(Arc::new(Mutex::new(Registry {
            taskbars: HashMap::new(),
            parent_of: HashMap::new(),
            unmatched_sources: HashSet::new(),
            diag,
        })))
        .is_ok()
}

fn with_registry<T>(f: impl FnOnce(&mut Registry) -> T) -> Option<T> {
    REGISTRY
        .get()
        .and_then(|r| r.lock().ok())
        .map(|mut guard| f(&mut guard))
}

/// 任务栏 XAML 岛所在显示器。自动隐藏任务栏完全滑出屏幕时
/// `MONITOR_DEFAULTTONULL` 得 0，主进程的逐屏消息就永远打不中这台任务栏——
/// 回退 `MONITOR_DEFAULTTONEAREST`（任务栏总贴着某屏边，与主进程 injector
/// `taskbar_monitor` 的回退口径一致）；此后每次 [`dispatch`] 前重取，任务栏
/// 在屏时拿到精确值并刷新登记。
fn taskbar_monitor(hwnd: HWND) -> u64 {
    let exact = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL) }.0 as u64;
    if exact != 0 {
        return exact;
    }
    unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) }.0 as u64
}

fn fill_property() -> windows_core::Result<IDependencyProperty> {
    let statics: IShapeStatics = crate::util::activation_factory("Windows.UI.Xaml.Shapes.Shape")?;
    unsafe { statics.fill_property() }
}

fn unregister_fill_changed(shape: &IShape, token: i64) {
    if token == 0 {
        return;
    }
    if let (Ok(dep), Ok(dp)) = (shape.cast::<IDependencyObject2>(), fill_property()) {
        let _ = unsafe { dep.UnregisterPropertyChangedCallback(&dp, token) };
    }
}

// ---------------------------------------------------------------------------
// Fill 属性变更回调（任务栏 UI 线程；登记后常驻）。
// ---------------------------------------------------------------------------

/// Fill 属性变更委托（SDK 里显式基于 IUnknown 的 WinRT 委托，见 xaml.rs）。
/// 首赋值补采原始画刷；系统重设 Fill 时刷新原始画刷并重套用自定义外观。
#[implement(IDependencyPropertyChangedCallback)]
struct FillChangedHandler {
    frame: InstanceHandle,
    border: bool,
}

/// 系统重设 Fill 后要重套用的内容（锁内决策，锁外执行）。
enum Reapply {
    Background(Option<AppliedBackground>),
    Border { hidden: bool },
}

impl IDependencyPropertyChangedCallback_Impl for FillChangedHandler_Impl {
    unsafe fn Invoke(
        &self,
        sender: windows_core::Ref<IDependencyObject>,
        _dp: windows_core::Ref<IDependencyProperty>,
    ) -> windows_core::Result<()> {
        // 铁律 R1：panic 绝不穿过 COM 边界（extern "system" 非 unwind ABI，漏网即
        // abort 整个 explorer）。本回调此前是全 crate 唯一未包 guarded 的 FFI 入口。
        crate::util::guarded("FillChangedHandler::Invoke", || {
            let Some(sender) = sender.as_ref() else {
                return Ok(());
            };
            // 锁内快照：本方 put 进行中 → 本次变更是自己触发的，忽略。
            let Some((shape, last_put)) = with_registry(|reg| {
                let slot = reg.slot_mut(self.frame, self.border)?;
                if slot.suppress_callback {
                    return None;
                }
                Some((slot.shape.clone(), slot.last_put.clone()))
            })
            .flatten() else {
                return Ok(());
            };
            // 锁外：只采信来自本元素的变更；当前 Fill 与本方最近 put 同身份 = 本方
            // 变更的迟到通知，同样忽略。
            if !same_identity(sender, &shape) {
                return Ok(());
            }
            let current = unsafe { shape.fill() }.unwrap_or(None);
            if same_brush(current.as_ref(), last_put.as_ref()) {
                return Ok(());
            }
            // 系统重设了 Fill：它就是新的原始画刷（null 则留空等下一次赋值再采）。
            let reapply = with_registry(|reg| {
                let entry = reg.taskbars.get_mut(&self.frame)?;
                let slot = if self.border {
                    entry.border.as_mut()?
                } else {
                    entry.background.as_mut()?
                };
                slot.original_fill = current;
                Some(if self.border {
                    Reapply::Border {
                        hidden: entry.border_hidden,
                    }
                } else {
                    Reapply::Background(entry.applied)
                })
            })
            .flatten();
            crate::vlog!(
                "system reset Fill on frame {:#x} ({}), original refreshed",
                self.frame,
                if self.border { "border" } else { "background" }
            );
            // 锁外：身上有自定义外观 → 重套用（系统重设外观后即重套用的语义）。
            match reapply {
                Some(Reapply::Background(Some(applied))) => apply_background(self.frame, applied),
                Some(Reapply::Border { hidden: true }) => apply_border(self.frame, true),
                _ => Ok(()),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// watcher 侧的登记接口（在任务栏 UI 线程上被调用）。
// ---------------------------------------------------------------------------

/// 记录一次可视树父子关系（每个 Add 事件都记；Remove 时清理）。
pub fn note_parent(child: InstanceHandle, parent: InstanceHandle) {
    with_registry(|reg| {
        reg.parent_of.insert(child, parent);
    });
}

/// 元素移除：清簿记；若是任务栏帧则注销（帧已亡，无恢复义务）。回调注销在
/// 锁外执行。
pub fn note_removed(handle: InstanceHandle) {
    let stale: Vec<(IShape, i64)> = with_registry(|reg| {
        // 子树整体销毁时后代条目随 Map 清理由各自 Remove 事件到达。
        reg.parent_of.remove(&handle);
        reg.unmatched_sources.remove(&handle);
        let Some(entry) = reg.taskbars.remove(&handle) else {
            return Vec::new();
        };
        [entry.background, entry.border]
            .into_iter()
            .flatten()
            .filter(|s| s.fill_changed_token != 0)
            .map(|s| (s.shape, s.fill_changed_token))
            .collect()
    })
    .unwrap_or_default();
    for (shape, token) in stale {
        unregister_fill_changed(&shape, token);
    }
}

/// 新的 DesktopWindowXamlSource 出现——暂存，等 TaskbarFrame 匹配。
pub fn note_xaml_source(handle: InstanceHandle) {
    with_registry(|reg| {
        reg.unmatched_sources.insert(handle);
    });
}

/// TaskbarFrame 添加：取其父 RootGrid，反查持有它的 XamlSource → HWND → 登记。
/// 任何一步失败都只是忽略该元素（R3：探测失败 ≠ 崩溃）。COM 反查在锁外。
///
/// 身份匹配：老树（22621 时代）XamlSource 的 content 就是 TaskbarFrame 的直接
/// 父 Grid；24H2 起中间多插了一层 Grid，content 是 frame 父节点的**祖先**——
/// 因此沿 parent_of 簿记向上收集 root_grid 的有界祖先链，content 命中链上任
/// 一节点即视为同一 XAML 岛。
pub fn register_taskbar(frame: InstanceHandle, root_grid: InstanceHandle) {
    let dq = windows::System::DispatcherQueue::GetForCurrentThread().ok();
    let Some((diag, candidates, identity_chain)) = with_registry(|reg| {
        let mut chain = vec![root_grid];
        let mut cur = root_grid;
        for _ in 0..16 {
            match reg.parent_of.get(&cur) {
                Some(&parent) => {
                    chain.push(parent);
                    cur = parent;
                }
                None => break,
            }
        }
        (
            reg.diag.clone(),
            reg.unmatched_sources.iter().copied().collect::<Vec<_>>(),
            chain,
        )
    }) else {
        return;
    };
    for src_handle in candidates {
        let source_inspectable = match (unsafe { diag.inspectable_from_handle(src_handle) }) {
            Ok(s) => s,
            Err(e) => {
                crate::vlog!("register_taskbar: source {src_handle:#x} unresolvable: {e}");
                continue;
            }
        };
        let source = match source_inspectable.cast::<crate::xaml::IDesktopWindowXamlSource>() {
            Ok(s) => s,
            Err(e) => {
                crate::vlog!("register_taskbar: source {src_handle:#x} cast failed: {e}");
                continue;
            }
        };
        let Ok(content) = (unsafe { source.content() }) else {
            crate::vlog!("register_taskbar: source {src_handle:#x} content() failed");
            continue; // 瞬时错误（错线程等）：跳过该源，对齐标杆 continue
        };
        // content → 诊断树句柄，与 frame 父链（含父节点自身）做句柄级比对。
        let content_handle = unsafe { diag.handle_from_inspectable(&content) };
        match content_handle {
            Ok(h) if identity_chain.contains(&h) => {}
            other => {
                crate::vlog!(
                    "register_taskbar: source {src_handle:#x} content {other:?} not in chain {identity_chain:?}"
                );
                continue;
            }
        }
        // HWND：优先 IDesktopWindowXamlSourceNative（旧 SDK 接口，26100 起被
        // 微软移除、QI 可能失败）；失败则按当前线程反查宿主任务栏窗口——可视树
        // 回调就跑在该任务栏自己的 UI 线程上，hwnd 只用于 MonitorFromWindow，
        // 用任务栏顶层窗口与用岛窗口取到的显示器一致。
        let hwnd = match source
            .cast::<crate::xaml::IDesktopWindowXamlSourceNative>()
            .ok()
            .and_then(|native| unsafe { native.window_handle() }.ok())
        {
            Some(h) => h,
            None => {
                match tray_window_for_current_thread() {
                    Some(h) => {
                        crate::vlog!("register_taskbar: native hwnd unavailable, using tray window by thread");
                        h
                    }
                    None => {
                        crate::vlog!("register_taskbar: no hwnd for frame {frame:#x} (native QI failed, no tray window on this thread)");
                        continue;
                    }
                }
            }
        };
        let hmonitor = taskbar_monitor(hwnd);
        crate::vlog!(
            "taskbar registered: frame={frame:#x} hwnd={:#x} monitor={hmonitor:#x}",
            hwnd.0 as usize
        );
        with_registry(|reg| {
            reg.unmatched_sources.remove(&src_handle);
            reg.taskbars.insert(
                frame,
                TaskbarEntry {
                    hwnd,
                    hmonitor,
                    dispatcher: dq.clone(),
                    background: None,
                    border: None,
                    applied: None,
                    border_hidden: false,
                },
            );
        });
        // 重放登记前被暂存的基线消息。经 DispatcherQueue 延后一拍：本回调由
        // TaskbarFrame 的 Add 事件触发，背景矩形（BackgroundFill 等）的 Add
        // 事件通常紧随其后——同步执行会找不到槽位而被 set_slot_fill 静默吞掉。
        // 入队失败则放回暂存，等下一次机会。
        let replay: Vec<TapMessage> = {
            let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
            let mut taken = Vec::new();
            pending.retain(|p| {
                let hit = p.monitor == 0 || p.monitor == hmonitor;
                if hit {
                    taken.push(p.message.clone());
                }
                !hit
            });
            taken
        };
        for message in replay {
            crate::vlog!("replaying parked message for monitor {hmonitor:#x}");
            let Some(dq) = dq.as_ref() else {
                // 没有 DispatcherQueue：放回暂存，下次登记或命中后再试。
                let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
                upsert_pending(&mut pending, message);
                continue;
            };
            let mut msg = Some(message);
            let handler = windows::System::DispatcherQueueHandler::new(move || {
                if let Some(msg) = msg.take() {
                    run_on_ui_thread(frame, msg);
                }
                Ok(())
            });
            // Handler 被 move 进 TryEnqueue；失败即 dispatcher 正在关闭
            // （任务栏在销毁），消息随之作废，不回填暂存。
            if !dq.TryEnqueue(&handler).unwrap_or(false) {
                crate::vlog!("replay TryEnqueue failed for frame {frame:#x}");
            }
        }
        return;
    }
    crate::vlog!("register_taskbar: frame {frame:#x} no matching XamlSource");
}

/// BackgroundFill / BackgroundStroke 矩形挂到所属 TaskbarFrame。解析 shape /
/// 读 Fill / 挂回调都在锁外。
pub fn register_taskbar_fill(handle: InstanceHandle, border: bool) {
    let Some((frame, diag)) = with_registry(|reg| {
        let frame = reg.ancestor_frame(handle)?;
        Some((frame, reg.diag.clone()))
    })
    .flatten() else {
        return;
    };
    let Ok(inspectable) = (unsafe { diag.inspectable_from_handle(handle) }) else {
        return;
    };
    let Ok(shape) = inspectable.cast::<IShape>() else {
        return;
    };
    let mut slot = Slot::new(shape);
    // get_Fill 对 null Fill 返回 Ok(None) → 视为未赋值。
    if let Ok(Some(fill)) = (unsafe { slot.shape.fill() }) {
        slot.original_fill = Some(fill);
    }
    // 始终挂属性变更回调（不再只在 Fill 为空时挂）：Fill 为空则等首赋值补采
    // （标杆 :243-250）；此后系统重设 Fill 时刷新原始画刷并重套用自定义外观。
    let handler: IDependencyPropertyChangedCallback = FillChangedHandler { frame, border }.into();
    if let (Ok(dep), Ok(dp)) = (slot.shape.cast::<IDependencyObject2>(), fill_property()) {
        slot.fill_changed_token = unsafe { dep.register_changed(&dp, &handler) }.unwrap_or(0);
    }
    // 同帧同槽位二次出现（可视树重建）：换掉旧槽位，旧回调锁外注销。
    let replaced: Option<Slot> = with_registry(|reg| {
        let entry = reg.taskbars.get_mut(&frame)?;
        let target = if border {
            &mut entry.border
        } else {
            &mut entry.background
        };
        target.replace(slot)
    })
    .flatten();
    if let Some(old) = replaced {
        unregister_fill_changed(&old.shape, old.fill_changed_token);
    }
}

// ---------------------------------------------------------------------------
// 管道侧的执行入口（投递到任务栏 UI 线程）。
// ---------------------------------------------------------------------------

/// ApplyAppearance / SetBorderVisibility / RestoreAll 的统一入口，管道线程调用。
pub fn dispatch(msg: TapMessage) {
    crate::vlog!("dispatch: {msg:?}");
    let mut hit_any = false;
    let snapshot: Vec<(
        InstanceHandle,
        u64,
        Option<windows::System::DispatcherQueue>,
    )> = with_registry(|reg| {
        reg.taskbars
            .iter_mut()
            .map(|(h, e)| {
                // 任务栏此刻在屏 → 刷新为精确 HMONITOR（屏外保留上次已知值）。
                // MonitorFromWindow 是 user32 纯查询，不触 XAML，锁内可调。
                let exact = unsafe { MonitorFromWindow(e.hwnd, MONITOR_DEFAULTTONULL) }.0 as u64;
                if exact != 0 && exact != e.hmonitor {
                    crate::vlog!(
                        "taskbar frame {h:#x} monitor {:#x} -> {exact:#x}",
                        e.hmonitor
                    );
                    e.hmonitor = exact;
                }
                (*h, e.hmonitor, e.dispatcher.clone())
            })
            .collect()
    })
    .unwrap_or_default();

    for (frame, monitor, dispatcher) in snapshot {
        let hit = match &msg {
            TapMessage::ApplyAppearance { monitor: m, .. }
            | TapMessage::SetBorderVisibility { monitor: m, .. } => monitor_matches(*m, monitor),
            TapMessage::RestoreAll => true,
            _ => false,
        };
        if !hit {
            continue;
        }
        hit_any = true;
        let mut msg = Some(msg.clone());
        match &dispatcher {
            Some(dq) => {
                let handler = windows::System::DispatcherQueueHandler::new(move || {
                    // DispatcherQueueHandler 是 FnMut：Handler 只会被调度一次，
                    // take 保证重复调用的安全性。
                    if let Some(msg) = msg.take() {
                        run_on_ui_thread(frame, msg);
                    }
                    Ok(())
                });
                match dq.TryEnqueue(&handler) {
                    Ok(true) => {}
                    _ => crate::vlog!("TryEnqueue failed for frame {frame:#x}"),
                }
            }
            None => crate::vlog!("no dispatcher for frame {frame:#x}, dropping command"),
        }
    }

    // 零命中 = 目标任务栏尚未登记（注入竞态 / 副屏晚出现）→ 暂存待登记重放；
    // 有命中 = 基线已落位，清掉对应暂存。
    if let Some((monitor, kind)) = pending_kind(&msg) {
        let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
        if hit_any {
            pending.retain(|p| pending_kind(&p.message) != Some((monitor, kind)));
        } else {
            upsert_pending(&mut pending, msg.clone());
            crate::vlog!("dispatch: no taskbar for monitor {monitor:#x}, parking {kind} message");
        }
    }
}

/// UI 线程闭包体：真正的画刷替换 / 恢复。
fn run_on_ui_thread(frame: InstanceHandle, msg: TapMessage) {
    crate::vlog!(
        "ui op enter frame {frame:#x} msg={msg:?} tid={:?}",
        std::thread::current().id()
    );
    let result = crate::util::guarded("ui op", || match &msg {
        TapMessage::ApplyAppearance {
            accent,
            color_abgr,
            blur_radius,
            ..
        } => apply_background(
            frame,
            AppliedBackground {
                accent: *accent,
                color_abgr: *color_abgr,
                blur_radius: *blur_radius,
            },
        ),
        TapMessage::SetBorderVisibility { visible, .. } => apply_border(frame, !*visible),
        TapMessage::RestoreAll => {
            let background = apply_background(frame, AppliedBackground::NORMAL);
            let border = apply_border(frame, false);
            background.and(border)
        }
        _ => Ok(()),
    });
    if let Err(e) = result {
        crate::vlog!("ui op failed on frame {frame:#x}: {e}");
    }
}

// ---------------------------------------------------------------------------
// 画刷替换（任务栏 UI 线程；XAML 调用全部在锁外）。
// ---------------------------------------------------------------------------

/// 背景槽套用一套外观（Normal = 恢复原始画刷、清自定义外观记录）。
fn apply_background(frame: InstanceHandle, applied: AppliedBackground) -> windows_core::Result<()> {
    capture_original_if_missing(frame, false);
    with_registry(|reg| {
        if let Some(entry) = reg.taskbars.get_mut(&frame) {
            entry.applied = (applied.accent != TapAccent::Normal).then_some(applied);
        }
    });
    let color = effective_color(applied.accent, applied.color_abgr);
    set_slot_fill(frame, false, |shape| match applied.accent {
        TapAccent::Normal => Ok(original_fill(frame, false)),
        TapAccent::Opaque | TapAccent::Clear => make_solid_brush(color).map(Some),
        TapAccent::Acrylic => make_acrylic_brush(color).map(Some),
        TapAccent::Blur => {
            let compositor = shape_compositor(shape).inspect_err(|e| {
                crate::vlog!("apply_background: shape_compositor failed: {e}");
            })?;
            create_blur_brush(BlurBrushParams {
                compositor,
                sigma: sigma_from_radius(applied.blur_radius),
                tint: tint_float4(color),
            })
            .inspect_err(|e| crate::vlog!("apply_background: create_blur_brush failed: {e}"))
            .map(Some)
        }
    })
}

/// 顶线槽：隐藏 = Opacity 0 的实心画刷（结构保留、完全透明，对齐标杆
/// taskbarappearanceservice.cpp:134-138）；显示 = 恢复原始画刷。
fn apply_border(frame: InstanceHandle, hidden: bool) -> windows_core::Result<()> {
    capture_original_if_missing(frame, true);
    with_registry(|reg| {
        if let Some(entry) = reg.taskbars.get_mut(&frame) {
            entry.border_hidden = hidden;
        }
    });
    set_slot_fill(frame, true, |_| {
        if hidden {
            let brush = make_solid_brush(Color {
                A: 0,
                R: 0,
                G: 0,
                B: 0,
            })?;
            unsafe { brush.put_Opacity(0.0)? };
            Ok(Some(brush))
        } else {
            Ok(original_fill(frame, true))
        }
    })
}

/// 槽位 put_Fill 的唯一骨架（锁纪律见模块文档）：锁内取 shape、置 suppress →
/// 锁外 `make_brush` 构造画刷并 put → 锁内清 suppress、记 last_put。槽位不存在
/// 时静默成功（帧已亡 / 尚未探测到矩形）。
fn set_slot_fill(
    frame: InstanceHandle,
    border: bool,
    make_brush: impl FnOnce(&IShape) -> windows_core::Result<Option<IBrush>>,
) -> windows_core::Result<()> {
    let Some(shape) = with_registry(|reg| {
        let slot = reg.slot_mut(frame, border)?;
        slot.suppress_callback = true;
        Some(slot.shape.clone())
    })
    .flatten() else {
        return Ok(());
    };
    let outcome = make_brush(&shape)
        .inspect_err(|e| crate::vlog!("set_slot_fill: make_brush failed: {e}"))
        .and_then(|brush| {
            put_fill(&shape, &brush)
                .inspect_err(|e| crate::vlog!("set_slot_fill: put_Fill failed: {e}"))
                .map(|()| brush)
        });
    crate::vlog!(
        "set_slot_fill done frame {frame:#x} border={border} outcome={}",
        outcome.is_ok()
    );
    with_registry(|reg| {
        if let Some(slot) = reg.slot_mut(frame, border) {
            slot.suppress_callback = false;
            if let Ok(brush) = &outcome {
                slot.last_put = brush.clone();
            }
        }
    });
    outcome.map(|_| ())
}

fn put_fill(shape: &IShape, brush: &Option<IBrush>) -> windows_core::Result<()> {
    crate::util::guarded("put_Fill", || unsafe {
        match brush {
            Some(b) => shape.put_Fill(b),
            // 原 Fill 为 null（系统未赋值）→ 恢复为 null：传 None（Param 空指针）。
            None => shape.put_Fill(None::<&IBrush>),
        }
    })
}

/// 原始画刷尚未采到时，把当前 Fill 采为原始值（锁外读，锁内写）。当前 Fill 若
/// 正是本方最近 put 的画刷（系统从未赋值、我们先套了外观）则不采——等系统真正
/// 赋值时由回调补采，否则会把自己的画刷当成"系统默认"恢复回去。
fn capture_original_if_missing(frame: InstanceHandle, border: bool) {
    let Some((shape, last_put)) = with_registry(|reg| {
        let slot = reg.slot_mut(frame, border)?;
        if slot.original_fill.is_some() {
            return None;
        }
        Some((slot.shape.clone(), slot.last_put.clone()))
    })
    .flatten() else {
        return;
    };
    let Ok(Some(fill)) = (unsafe { shape.fill() }) else {
        return;
    };
    if same_brush(Some(&fill), last_put.as_ref()) {
        return;
    }
    with_registry(|reg| {
        if let Some(slot) = reg.slot_mut(frame, border) {
            if slot.original_fill.is_none() {
                slot.original_fill = Some(fill);
            }
        }
    });
}

fn original_fill(frame: InstanceHandle, border: bool) -> Option<IBrush> {
    with_registry(|reg| {
        reg.slot_mut(frame, border)
            .and_then(|s| s.original_fill.clone())
    })
    .flatten()
}

fn make_solid_brush(color: Color) -> windows_core::Result<IBrush> {
    let factory: windows::Win32::System::WinRT::IActivationFactory =
        crate::util::activation_factory("Windows.UI.Xaml.Media.SolidColorBrush")?;
    let instance = unsafe { factory.ActivateInstance() }?;
    let scb: ISolidColorBrush = instance.cast()?;
    unsafe { scb.put_Color(color)? };
    scb.cast()
}

fn make_acrylic_brush(color: Color) -> windows_core::Result<IBrush> {
    use crate::xaml::IAcrylicBrushFactory;
    // AcrylicBrush 是 composable-only：ActivateInstance 对它恒 E_NOTIMPL，
    // 必须走 IAcrylicBrushFactory::CreateInstance(null, &inner, &value)
    // （C++/WinRT `AcrylicBrush acrylicBrush;` 的等价物）。
    let factory: IAcrylicBrushFactory =
        crate::util::activation_factory("Windows.UI.Xaml.Media.AcrylicBrush")
            .inspect_err(|e| crate::vlog!("make_acrylic_brush: factory failed: {e}"))?;
    let mut inner_raw = core::ptr::null_mut();
    let mut value_raw = core::ptr::null_mut();
    let hr =
        unsafe { factory.CreateInstance(core::ptr::null_mut(), &mut inner_raw, &mut value_raw) };
    if hr.is_err() || value_raw.is_null() {
        crate::vlog!(
            "make_acrylic_brush: CreateInstance failed hr={:#010x}",
            hr.0
        );
        return Err(windows_core::Error::from_hresult(if hr.is_ok() {
            windows_core::HRESULT(0x8000_4003_u32 as i32) // E_POINTER
        } else {
            hr
        }));
    }
    // value 即新实例（inner 丢弃：无聚合外层，系统自持）。
    let acrylic: crate::xaml::IAcrylicBrush =
        unsafe { crate::xaml::IAcrylicBrush::from_raw(value_raw) };
    unsafe {
        acrylic
            .put_BackgroundSource(ACRYLIC_BACKGROUND_SOURCE_BACKDROP)
            .inspect_err(|e| {
                crate::vlog!("make_acrylic_brush: put_BackgroundSource failed: {e}");
            })?;
        acrylic.put_TintColor(color).inspect_err(|e| {
            crate::vlog!("make_acrylic_brush: put_TintColor failed: {e}");
        })?;
    }
    acrylic.cast()
}

/// 取 shape 所在元素的 Compositor（ElementCompositionPreview::GetElementVisual
/// → Visual.Compositor，对齐 taskbarappearanceservice.cpp:92）。
fn shape_compositor(shape: &IShape) -> windows_core::Result<windows::UI::Composition::Compositor> {
    let element = shape.cast::<crate::xaml::IUIElement>()?;
    let statics: crate::xaml::IElementCompositionPreviewStatics =
        crate::util::activation_factory("Windows.UI.Xaml.Hosting.ElementCompositionPreview")?;
    let visual = unsafe { statics.element_visual(&element) }?;
    visual.Compositor()
}

// ---------------------------------------------------------------------------
// 单测：纯函数部分。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::pack_abgr;

    #[test]
    fn monitor_zero_targets_all() {
        assert!(monitor_matches(0, 0xdead));
        assert!(monitor_matches(0xdead, 0xdead));
        assert!(!monitor_matches(0xbeef, 0xdead));
    }

    #[test]
    fn sigma_is_radius_over_three() {
        assert_eq!(sigma_from_radius(0), 0.0);
        assert!((sigma_from_radius(30) - 10.0).abs() < f32::EPSILON);
        assert!((sigma_from_radius(750) - 250.0).abs() < f32::EPSILON);
    }

    #[test]
    fn opaque_forces_alpha_but_clear_keeps_it() {
        let packed = pack_abgr(0x11, 0x22, 0x33, 0x44);
        let c = effective_color(TapAccent::Opaque, packed);
        assert_eq!((c.A, c.R, c.G, c.B), (0xFF, 0x11, 0x22, 0x33));
        let c = effective_color(TapAccent::Clear, packed);
        assert_eq!((c.A, c.R, c.G, c.B), (0x44, 0x11, 0x22, 0x33));
        let c = effective_color(TapAccent::Acrylic, pack_abgr(1, 2, 3, 0x80));
        assert_eq!((c.A, c.R, c.G, c.B), (0x80, 1, 2, 3));
    }

    #[test]
    fn tint_float4_is_linear() {
        let c = effective_color(TapAccent::Clear, pack_abgr(0, 0x33, 0x66, 0xFF));
        let t = tint_float4(c);
        assert!((t[0] - 0.0).abs() < 1e-6);
        assert!((t[1] - 0.2).abs() < 1e-3);
        assert!((t[2] - 0.4).abs() < 1e-3);
        assert!((t[3] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn same_brush_treats_two_nulls_as_equal() {
        // "put 了 null" 与"当前 Fill 为 null" 同身份；空对非空不同。
        assert!(same_brush(None, None));
    }

    #[test]
    fn normal_accent_clears_applied_record() {
        // Normal 即"无自定义外观"：applied 记录应为 None（回调不再重套用）。
        let applied = AppliedBackground::NORMAL;
        assert_eq!(
            (applied.accent != TapAccent::Normal).then_some(applied),
            None
        );
        let custom = AppliedBackground {
            accent: TapAccent::Acrylic,
            color_abgr: 1,
            blur_radius: 2,
        };
        assert_eq!(
            (custom.accent != TapAccent::Normal).then_some(custom),
            Some(custom)
        );
    }

    fn apply_msg(monitor: u64, abgr: u32) -> TapMessage {
        TapMessage::ApplyAppearance {
            monitor,
            accent: TapAccent::Clear,
            color_abgr: abgr,
            blur_radius: 0,
        }
    }

    #[test]
    fn pending_park_upserts_per_monitor_and_kind() {
        let mut pending: Vec<PendingMessage> = Vec::new();
        // 首次暂存。
        upsert_pending(&mut pending, apply_msg(0x10001, 1));
        assert_eq!(pending.len(), 1);
        // 同 monitor 同类型：覆盖不新增。
        upsert_pending(&mut pending, apply_msg(0x10001, 2));
        assert_eq!(pending.len(), 1);
        assert!(matches!(
            &pending[0].message,
            TapMessage::ApplyAppearance { color_abgr: 2, .. }
        ));
        // 同 monitor 不同类型（边框）：并存。
        upsert_pending(
            &mut pending,
            TapMessage::SetBorderVisibility {
                monitor: 0x10001,
                visible: false,
            },
        );
        assert_eq!(pending.len(), 2);
        // 不同 monitor：并存。
        upsert_pending(&mut pending, apply_msg(0x10002, 3));
        assert_eq!(pending.len(), 3);
    }

    #[test]
    fn pending_ignores_non_targeted_messages() {
        let mut pending: Vec<PendingMessage> = Vec::new();
        upsert_pending(&mut pending, TapMessage::RestoreAll);
        upsert_pending(&mut pending, TapMessage::Ping);
        assert!(pending.is_empty());
    }

    #[test]
    fn pending_drain_by_monitor_keeps_other_monitors() {
        let mut pending: Vec<PendingMessage> = Vec::new();
        upsert_pending(&mut pending, apply_msg(0x10001, 1));
        upsert_pending(&mut pending, apply_msg(0x10002, 2));
        // monitor 0（全部）与精确 monitor 互为命中：登记 0x10001 时取走 0 与 0x10001。
        let taken: Vec<TapMessage> = {
            let mut out = Vec::new();
            pending.retain(|p| {
                let hit = p.monitor == 0 || p.monitor == 0x10001;
                if hit {
                    out.push(p.message.clone());
                }
                !hit
            });
            out
        };
        assert_eq!(taken.len(), 1);
        assert!(matches!(
            &taken[0],
            TapMessage::ApplyAppearance { color_abgr: 1, .. }
        ));
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].monitor, 0x10002);
    }
}
