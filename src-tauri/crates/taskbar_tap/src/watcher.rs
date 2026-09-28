//! 可视树监视器——标杆 visualtreewatcher.cpp 的等价物。
//!
//! XAML 引擎在任务栏 UI 线程上回调 [`OnVisualTreeChange`]；我们按
//! **type + Name** 做结构探测（R3：Windows 更新改名 → 探测失败 = 忽略该
//! 元素，不崩）：
//!
//! - type `Windows.UI.Xaml.Hosting.DesktopWindowXamlSource` → 暂存候选源；
//! - type `Taskbar.TaskbarFrame` → 经其父 RootGrid 反查候选源的 HWND，
//!   登记任务栏（多任务栏各自登记）；
//! - type `Windows.UI.Xaml.Shapes.Rectangle` + Name `BackgroundFill` /
//!   `BackgroundStroke` → 挂到所属 TaskbarFrame（背景 / 顶线）。
//!
//! 同时为每个 Add 事件簿记 child→parent，供 BackgroundFill 向上找帧。

use windows_core::{implement, Result};

use crate::appearance;
use crate::diag::{
    bstr_to_string_lossy, free_visual_element_strings, IVisualTreeServiceCallback2,
    IVisualTreeServiceCallback2_Impl, IVisualTreeServiceCallback_Impl, InstanceHandle,
    ParentChildRelation, VisualElement, VisualMutationType,
};

/// 诊断树里的类型名常量（与标杆 winrt::name_of<...> 的字符串一致）。
const TYPE_DESKTOP_WINDOW_XAML_SOURCE: &str = "Windows.UI.Xaml.Hosting.DesktopWindowXamlSource";
const TYPE_TASKBAR_FRAME: &str = "Taskbar.TaskbarFrame";
const TYPE_RECTANGLE: &str = "Windows.UI.Xaml.Shapes.Rectangle";
const NAME_BACKGROUND_FILL: &str = "BackgroundFill";
const NAME_BACKGROUND_STROKE: &str = "BackgroundStroke";

/// RAII：回调返回前释放移交给我们 BSTR（对齐标杆 wil::unique_bstr）。
struct ElementGuard(VisualElement);

impl Drop for ElementGuard {
    fn drop(&mut self) {
        unsafe { free_visual_element_strings(&self.0) };
    }
}

#[implement(IVisualTreeServiceCallback2)]
pub(crate) struct VisualTreeWatcher;

impl IVisualTreeServiceCallback_Impl for VisualTreeWatcher_Impl {
    unsafe fn OnVisualTreeChange(
        &self,
        relation: ParentChildRelation,
        element: VisualElement,
        mutationtype: VisualMutationType,
    ) -> Result<()> {
        let element = ElementGuard(element);
        // 所有分支都吃掉错误：树事件处理失败 = 忽略该元素（铁律：不崩）。
        let _ = crate::util::guarded("OnVisualTreeChange", || {
            let type_name = unsafe { bstr_to_string_lossy(element.0.type_name) };
            let name = unsafe { bstr_to_string_lossy(element.0.name) };
            match mutationtype {
                VisualMutationType::Add => {
                    appearance::note_parent(element.0.handle, relation.parent);
                    match type_name.as_str() {
                        TYPE_DESKTOP_WINDOW_XAML_SOURCE => {
                            appearance::note_xaml_source(element.0.handle);
                        }
                        TYPE_TASKBAR_FRAME => {
                            appearance::register_taskbar(element.0.handle, relation.parent);
                        }
                        TYPE_RECTANGLE => match name.as_str() {
                            NAME_BACKGROUND_FILL => {
                                appearance::register_taskbar_fill(element.0.handle, false)
                            }
                            NAME_BACKGROUND_STROKE => {
                                appearance::register_taskbar_fill(element.0.handle, true)
                            }
                            _ => {}
                        },
                        _ => {}
                    }
                }
                VisualMutationType::Remove => {
                    // Remove 事件只有 element.Handle 有效（标杆同款约束）。
                    appearance::note_removed(element.0.handle);
                }
            }
            Ok(())
        });
        Ok(())
    }
}

impl IVisualTreeServiceCallback2_Impl for VisualTreeWatcher_Impl {
    unsafe fn OnElementStateChanged(
        &self,
        _element: InstanceHandle,
        _state: i32,
        _context: windows::core::PCWSTR,
    ) -> Result<()> {
        Ok(()) // 不关心元素状态变化（标杆同样直通 S_OK）。
    }
}
