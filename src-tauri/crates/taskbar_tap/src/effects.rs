//! Win2D 式图形效果描述对象——`IGraphicsEffect` + `IGraphicsEffectD2D1Interop`
//! 的最小实现。
//!
//! XAML 的 `Compositor::CreateEffectFactory(effect)` 会对 effect 做 D2D1
//! interop 询问（效果 CLSID、属性索引/值、源图），据此在 DComp 里搭出真实
//! 效果图。属性值以 `IPropertyValue` 返回：Flood 的颜色是 **SingleArray×4**、
//! GaussianBlur 的 σ 是 Single、优化/边框是 UInt32——属性类型须逐字节精确。
//!
//! `#[implement]` 必须**显式**列出 `IGraphicsEffectSource`：宏生成的
//! QueryInterface 只应答列出的接口（各 vtable 的 `matches` 只比对自身 IID，
//! 不含 WinRT "requires" 关系）。`IGraphicsEffect` 在元数据上 requires
//! `IGraphicsEffectSource`，Composition 运行时对 `GetSource` 返回的嵌套效果、
//! 以及 blur_brush 把效果塞进 CompositeEffect.sources 的 cast，都要按这个 IID
//! 查询——漏列即 E_NOINTERFACE，模糊画刷 OnConnected 整体失败（真机复现：
//! Blur 下发后 `ui op failed: 0x80004002`，任务栏外观不变）。

use windows::core::PCWSTR;
use windows::Foundation::IPropertyValue;
use windows::Graphics::Effects::{
    IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectSource_Impl, IGraphicsEffect_Impl,
};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_BORDER_MODE_SOFT, D2D1_COMPOSITE_MODE_SOURCE_OVER,
};
use windows::Win32::Graphics::Direct2D::{
    CLSID_D2D1Composite, CLSID_D2D1Flood, CLSID_D2D1GaussianBlur, D2D1_COMPOSITE_PROP_MODE,
    D2D1_FLOOD_PROP_COLOR, D2D1_GAUSSIANBLUR_OPTIMIZATION_BALANCED,
    D2D1_GAUSSIANBLUR_PROP_BORDER_MODE, D2D1_GAUSSIANBLUR_PROP_OPTIMIZATION,
    D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION,
};
use windows_core::Result;
use windows_core::{implement, interface, Interface, GUID, HRESULT};

/// GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT（windows.graphics.effects.interop.h）。
const PROPERTY_MAPPING_DIRECT: u32 = 1;

const GB_PROP_STANDARD_DEVIATION: u32 = D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION.0 as u32;
const GB_PROP_OPTIMIZATION: u32 = D2D1_GAUSSIANBLUR_PROP_OPTIMIZATION.0 as u32;
const GB_PROP_BORDER_MODE: u32 = D2D1_GAUSSIANBLUR_PROP_BORDER_MODE.0 as u32;
const FLOOD_PROP_COLOR: u32 = D2D1_FLOOD_PROP_COLOR.0 as u32;
const COMPOSITE_PROP_MODE: u32 = D2D1_COMPOSITE_PROP_MODE.0 as u32;
const GB_OPTIMIZATION_BALANCED: u32 = D2D1_GAUSSIANBLUR_OPTIMIZATION_BALANCED.0 as u32;
const BORDER_MODE_SOFT: u32 = D2D1_BORDER_MODE_SOFT.0 as u32;
const COMPOSITE_MODE_SOURCE_OVER: u32 = D2D1_COMPOSITE_MODE_SOURCE_OVER.0 as u32;

/// IID `{2FC57384--44D7--30982FCF7177}`——SDK
/// `winrt\windows.graphics.effects.interop.h` 的互操作接口（基于 IUnknown）。
#[interface("2FC57384-A068-44D7-A331-30982FCF7177")]
pub unsafe trait IGraphicsEffectD2D1Interop: windows_core::IUnknown {
    pub unsafe fn GetEffectId(&self, id: *mut GUID) -> HRESULT;
    /// 双出参（index+mapping）且无 retval——保持原始 ABI 签名。
    pub unsafe fn GetNamedPropertyMapping(
        &self,
        name: PCWSTR,
        index: *mut u32,
        mapping: *mut u32,
    ) -> HRESULT;
    pub unsafe fn GetPropertyCount(&self, count: *mut u32) -> HRESULT;
    pub unsafe fn GetProperty(&self, index: u32, value: *mut *mut core::ffi::c_void) -> HRESULT;
    pub unsafe fn GetSource(&self, index: u32, source: *mut *mut core::ffi::c_void) -> HRESULT;
    pub unsafe fn GetSourceCount(&self, count: *mut u32) -> HRESULT;
}

fn property_value_single(v: f32) -> Result<IPropertyValue> {
    let value = windows::Foundation::PropertyValue::CreateSingle(v)?;
    value.cast()
}

fn property_value_u32(v: u32) -> Result<IPropertyValue> {
    let value = windows::Foundation::PropertyValue::CreateUInt32(v)?;
    value.cast()
}

fn property_value_float4(v: [f32; 4]) -> Result<IPropertyValue> {
    let value = windows::Foundation::PropertyValue::CreateSingleArray(&v)?;
    value.cast()
}

fn hstr(s: &str) -> windows_core::HSTRING {
    windows_core::HSTRING::from(s)
}

fn name_arg(name: PCWSTR) -> String {
    if name.is_null() {
        String::new()
    } else {
        unsafe { name.to_string().unwrap_or_default() }
    }
}

/// HRESULT 形态 COM 入口的 guarded 包装。util.rs 铁律「每个 COM/FFI
/// 入口包 guarded」——本文件的效果对象由 XAML 效果工厂在 DComp 内部回调，
/// 任何 panic 穿过 extern "system" 边界即 abort 整个 explorer。
/// （`Result<T>` 形态入口直接用 `crate::util::guarded`——它本就返回摊平的
/// `Result<T>`。）
fn guarded_hresult<F>(what: &'static str, f: F) -> HRESULT
where
    F: FnOnce() -> Result<()> + std::panic::UnwindSafe,
{
    match crate::util::guarded(what, f) {
        Ok(()) => HRESULT(0),
        Err(e) => e.code(),
    }
}

const E_POINTER_CODE: HRESULT = HRESULT(0x8000_4003_u32 as i32);

/// 高斯模糊：CLSID_D2D1GaussianBlur，属性 = [σ, Optimization, BorderMode]。
#[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
pub(crate) struct GaussianBlurEffect {
    /// 效果输入源（`CompositionEffectSourceParameter(L"backdrop")` 的引用）。
    pub source: IGraphicsEffectSource,
    /// 标准差 σ（协议换算 σ = blur_radius / 3）。
    pub standard_deviation: f32,
}

impl IGraphicsEffectSource_Impl for GaussianBlurEffect_Impl {}
impl IGraphicsEffect_Impl for GaussianBlurEffect_Impl {
    fn Name(&self) -> Result<windows_core::HSTRING> {
        crate::util::guarded(
            "blur effect Name",
            std::panic::AssertUnwindSafe(|| Ok(hstr("GaussianBlurEffect"))),
        )
    }
    fn SetName(&self, _name: &windows_core::HSTRING) -> Result<()> {
        crate::util::guarded(
            "blur effect SetName",
            std::panic::AssertUnwindSafe(|| Ok(())),
        )
    }
}

impl IGraphicsEffectD2D1Interop_Impl for GaussianBlurEffect_Impl {
    unsafe fn GetEffectId(&self, id: *mut GUID) -> HRESULT {
        guarded_hresult(
            "blur effect GetEffectId",
            std::panic::AssertUnwindSafe(|| {
                if id.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *id = CLSID_D2D1GaussianBlur };
                Ok(())
            }),
        )
    }
    unsafe fn GetNamedPropertyMapping(
        &self,
        name: PCWSTR,
        index: *mut u32,
        mapping: *mut u32,
    ) -> HRESULT {
        guarded_hresult(
            "blur effect GetNamedPropertyMapping",
            std::panic::AssertUnwindSafe(|| {
                match name_arg(name).as_str() {
                    "BlurAmount" | "StandardDeviation" => unsafe {
                        *index = GB_PROP_STANDARD_DEVIATION;
                        *mapping = PROPERTY_MAPPING_DIRECT;
                        Ok(())
                    },
                    "Optimization" => unsafe {
                        *index = GB_PROP_OPTIMIZATION;
                        *mapping = PROPERTY_MAPPING_DIRECT;
                        Ok(())
                    },
                    "BorderMode" => unsafe {
                        *index = GB_PROP_BORDER_MODE;
                        *mapping = PROPERTY_MAPPING_DIRECT;
                        Ok(())
                    },
                    _ => Err(windows_core::Error::from_hresult(HRESULT(
                        0x8007_0057_u32 as i32, // E_INVALIDARG
                    ))),
                }
            }),
        )
    }
    unsafe fn GetPropertyCount(&self, count: *mut u32) -> HRESULT {
        guarded_hresult(
            "blur effect GetPropertyCount",
            std::panic::AssertUnwindSafe(|| {
                if count.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *count = 3 };
                Ok(())
            }),
        )
    }
    unsafe fn GetProperty(&self, index: u32, value: *mut *mut core::ffi::c_void) -> HRESULT {
        guarded_hresult(
            "blur effect GetProperty",
            std::panic::AssertUnwindSafe(|| {
                if value.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                let pv = match index {
                    GB_PROP_STANDARD_DEVIATION => property_value_single(self.standard_deviation),
                    GB_PROP_OPTIMIZATION => property_value_u32(GB_OPTIMIZATION_BALANCED),
                    GB_PROP_BORDER_MODE => property_value_u32(BORDER_MODE_SOFT),
                    _ => {
                        return Err(windows_core::Error::from_hresult(HRESULT(
                            0x8000_400B_u32 as i32, // E_BOUNDS
                        )));
                    }
                };
                let v = pv?;
                let unk: windows_core::IUnknown = v.into();
                unsafe { *value = windows_core::Interface::as_raw(&unk) };
                // 出参所有权移交：forget 掉 unk 的 Drop。
                core::mem::forget(unk);
                Ok(())
            }),
        )
    }
    unsafe fn GetSource(&self, index: u32, source: *mut *mut core::ffi::c_void) -> HRESULT {
        guarded_hresult(
            "blur effect GetSource",
            std::panic::AssertUnwindSafe(|| {
                if source.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                if index == 0 {
                    let unk: windows_core::IUnknown = self.source.clone().into();
                    unsafe { *source = windows_core::Interface::as_raw(&unk) };
                    core::mem::forget(unk);
                    Ok(())
                } else {
                    Err(windows_core::Error::from_hresult(HRESULT(
                        0x8000_400B_u32 as i32, // E_BOUNDS
                    )))
                }
            }),
        )
    }
    unsafe fn GetSourceCount(&self, count: *mut u32) -> HRESULT {
        guarded_hresult(
            "blur effect GetSourceCount",
            std::panic::AssertUnwindSafe(|| {
                if count.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *count = 1 };
                Ok(())
            }),
        )
    }
}

/// 单色填充（tint）：CLSID_D2D1Flood，属性 = [Color(SingleArray×4)]，无源。
#[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
pub(crate) struct FloodEffect {
    /// RGBA 线性空间 [r,g,b,a] ∈ [0,1]。
    pub color: [f32; 4],
}

impl IGraphicsEffectSource_Impl for FloodEffect_Impl {}
impl IGraphicsEffect_Impl for FloodEffect_Impl {
    fn Name(&self) -> Result<windows_core::HSTRING> {
        crate::util::guarded(
            "flood effect Name",
            std::panic::AssertUnwindSafe(|| Ok(hstr("FloodEffect"))),
        )
    }
    fn SetName(&self, _name: &windows_core::HSTRING) -> Result<()> {
        crate::util::guarded(
            "flood effect SetName",
            std::panic::AssertUnwindSafe(|| Ok(())),
        )
    }
}

impl IGraphicsEffectD2D1Interop_Impl for FloodEffect_Impl {
    unsafe fn GetEffectId(&self, id: *mut GUID) -> HRESULT {
        guarded_hresult(
            "flood effect GetEffectId",
            std::panic::AssertUnwindSafe(|| {
                if id.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *id = CLSID_D2D1Flood };
                Ok(())
            }),
        )
    }
    unsafe fn GetNamedPropertyMapping(
        &self,
        name: PCWSTR,
        index: *mut u32,
        mapping: *mut u32,
    ) -> HRESULT {
        guarded_hresult(
            "flood effect GetNamedPropertyMapping",
            std::panic::AssertUnwindSafe(|| {
                if name_arg(name) == "Color" {
                    unsafe {
                        *index = FLOOD_PROP_COLOR;
                        *mapping = PROPERTY_MAPPING_DIRECT;
                    }
                    Ok(())
                } else {
                    Err(windows_core::Error::from_hresult(HRESULT(
                        0x8007_0057_u32 as i32, // E_INVALIDARG
                    )))
                }
            }),
        )
    }
    unsafe fn GetPropertyCount(&self, count: *mut u32) -> HRESULT {
        guarded_hresult(
            "flood effect GetPropertyCount",
            std::panic::AssertUnwindSafe(|| {
                if count.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *count = 1 };
                Ok(())
            }),
        )
    }
    unsafe fn GetProperty(&self, index: u32, value: *mut *mut core::ffi::c_void) -> HRESULT {
        guarded_hresult(
            "flood effect GetProperty",
            std::panic::AssertUnwindSafe(|| {
                if value.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                if index != FLOOD_PROP_COLOR {
                    return Err(windows_core::Error::from_hresult(HRESULT(
                        0x8000_400B_u32 as i32, // E_BOUNDS
                    )));
                }
                let v = property_value_float4(self.color)?;
                let unk: windows_core::IUnknown = v.into();
                unsafe { *value = windows_core::Interface::as_raw(&unk) };
                core::mem::forget(unk);
                Ok(())
            }),
        )
    }
    unsafe fn GetSource(&self, _index: u32, source: *mut *mut core::ffi::c_void) -> HRESULT {
        guarded_hresult(
            "flood effect GetSource",
            std::panic::AssertUnwindSafe(|| {
                if !source.is_null() {
                    unsafe { *source = core::ptr::null_mut() };
                }
                Err(windows_core::Error::from_hresult(HRESULT(
                    0x8000_400B_u32 as i32, // E_BOUNDS（Flood 无源）
                )))
            }),
        )
    }
    unsafe fn GetSourceCount(&self, count: *mut u32) -> HRESULT {
        guarded_hresult(
            "flood effect GetSourceCount",
            std::panic::AssertUnwindSafe(|| {
                if count.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *count = 0 };
                Ok(())
            }),
        )
    }
}

/// 合成：CLSID_D2D1Composite，属性 = [Mode]，源 = [under, over]
/// （源序 = SourceOver 的下/上景）。
#[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
pub(crate) struct CompositeEffect {
    pub sources: Vec<IGraphicsEffectSource>,
}

impl IGraphicsEffectSource_Impl for CompositeEffect_Impl {}
impl IGraphicsEffect_Impl for CompositeEffect_Impl {
    fn Name(&self) -> Result<windows_core::HSTRING> {
        crate::util::guarded(
            "composite effect Name",
            std::panic::AssertUnwindSafe(|| Ok(hstr("CompositeEffect"))),
        )
    }
    fn SetName(&self, _name: &windows_core::HSTRING) -> Result<()> {
        crate::util::guarded(
            "composite effect SetName",
            std::panic::AssertUnwindSafe(|| Ok(())),
        )
    }
}

impl IGraphicsEffectD2D1Interop_Impl for CompositeEffect_Impl {
    unsafe fn GetEffectId(&self, id: *mut GUID) -> HRESULT {
        guarded_hresult(
            "composite effect GetEffectId",
            std::panic::AssertUnwindSafe(|| {
                if id.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *id = CLSID_D2D1Composite };
                Ok(())
            }),
        )
    }
    unsafe fn GetNamedPropertyMapping(
        &self,
        name: PCWSTR,
        index: *mut u32,
        mapping: *mut u32,
    ) -> HRESULT {
        guarded_hresult(
            "composite effect GetNamedPropertyMapping",
            std::panic::AssertUnwindSafe(|| {
                if name_arg(name) == "Mode" {
                    unsafe {
                        *index = COMPOSITE_PROP_MODE;
                        *mapping = PROPERTY_MAPPING_DIRECT;
                    }
                    Ok(())
                } else {
                    Err(windows_core::Error::from_hresult(HRESULT(
                        0x8007_0057_u32 as i32, // E_INVALIDARG
                    )))
                }
            }),
        )
    }
    unsafe fn GetPropertyCount(&self, count: *mut u32) -> HRESULT {
        guarded_hresult(
            "composite effect GetPropertyCount",
            std::panic::AssertUnwindSafe(|| {
                if count.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *count = 1 };
                Ok(())
            }),
        )
    }
    unsafe fn GetProperty(&self, index: u32, value: *mut *mut core::ffi::c_void) -> HRESULT {
        guarded_hresult(
            "composite effect GetProperty",
            std::panic::AssertUnwindSafe(|| {
                if value.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                if index != COMPOSITE_PROP_MODE {
                    return Err(windows_core::Error::from_hresult(HRESULT(
                        0x8000_400B_u32 as i32, // E_BOUNDS
                    )));
                }
                let v = property_value_u32(COMPOSITE_MODE_SOURCE_OVER)?;
                let unk: windows_core::IUnknown = v.into();
                unsafe { *value = windows_core::Interface::as_raw(&unk) };
                core::mem::forget(unk);
                Ok(())
            }),
        )
    }
    unsafe fn GetSource(&self, index: u32, source: *mut *mut core::ffi::c_void) -> HRESULT {
        guarded_hresult(
            "composite effect GetSource",
            std::panic::AssertUnwindSafe(|| {
                if source.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                match self.sources.get(index as usize) {
                    Some(s) => {
                        let unk: windows_core::IUnknown = s.clone().into();
                        unsafe { *source = windows_core::Interface::as_raw(&unk) };
                        core::mem::forget(unk);
                        Ok(())
                    }
                    None => Err(windows_core::Error::from_hresult(HRESULT(
                        0x8000_400B_u32 as i32, // E_BOUNDS
                    ))),
                }
            }),
        )
    }
    unsafe fn GetSourceCount(&self, count: *mut u32) -> HRESULT {
        guarded_hresult(
            "composite effect GetSourceCount",
            std::panic::AssertUnwindSafe(|| {
                if count.is_null() {
                    return Err(windows_core::Error::from_hresult(E_POINTER_CODE));
                }
                unsafe { *count = self.sources.len() as u32 };
                Ok(())
            }),
        )
    }
}
