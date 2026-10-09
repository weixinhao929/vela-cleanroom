//! 手写的 Windows.UI.Xaml 接口层。
//!
//! windows crate 0.61 已移除 `UI_Xaml` 投影（需求预判到这一点），因此这里
//! 按**本机 Windows SDK `winrt\windows.ui.xaml*.h`（10.0.26100.0）**逐条转写
//! 需要的接口：IID、vtable 槽位、参数 ABI 都以头文件为准。只声明用到的前缀
//! 方法（COM 布局前缀合法），未用到的尾随方法不声明。
//!
//! windows-interface 0.59 的宏只支持 `Result<()>` 返回：get_*/带出参方法全部
//! 为原始签名 + 独立 `impl` 块的蛇形包装（见各接口底部）。
//!
//! 例外：`IDesktopWindowXamlSourceNative` 在 26100 SDK 头里已被移除，IID
//! 取自旧 SDK / 公开 interop 资料（`3CBCF1BF-...`）。

use windows::Win32::Foundation::HWND;
use windows_core::interface;
use windows_core::Interface;

/// `Windows.UI.Color`（ABI 字段序 A,R,G,B）——windows crate `UI` feature 直供。
pub use windows::UI::Color;

/// 手写 WinRT 接口的基类兼容层：宏只为 IUnknown 特判，基类写
/// `windows_core::IInspectable` 会生成不存在的 `IInspectable_Impl` 约束；
/// 这里提供本地别名 + 空白实现基 trait。
pub mod rt {
    pub use windows_core::IInspectable;

    /// 宏假定父 vtable 提供 `new::<Identity, OFFSET>()` / `matches()`；
    /// windows-core 真身的 IInspectable_Vtbl 形状不同（3 泛型 + 无 matches）。
    /// 本 DLL 对 IInspectable 派生接口**只调用不实现**——这里给出布局等价
    /// 的替身 + 永不触达的构造器。
    #[repr(C)]
    pub struct IInspectable_Vtbl {
        pub base__: windows_core::IUnknown_Vtbl,
        pub GetIids: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *mut u32,
            *mut *mut windows_core::GUID,
        ) -> windows_core::HRESULT,
        pub GetRuntimeClassName: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT,
        pub GetTrustLevel:
            unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> windows_core::HRESULT,
    }

    impl IInspectable_Vtbl {
        #[allow(clippy::extra_unused_type_parameters)]
        pub const fn new<_Identity: windows_core::IUnknownImpl, const _OFFSET: isize>() -> Self {
            panic!("velatap: IInspectable 派生接口只调用、不实现（不应构造 vtable）")
        }
        pub fn matches(iid: &windows_core::GUID) -> bool {
            *iid == <IInspectable as windows_core::Interface>::IID
        }
    }

    /// 宏为 IInspectable 父类生成 `IInspectable_Impl` 约束（core 未提供）。
    #[allow(non_camel_case_types)]
    pub trait IInspectable_Impl: windows_core::IUnknownImpl {}
    impl<T: windows_core::IUnknownImpl + ?Sized> IInspectable_Impl for T {}
}

/// Windows.Foundation.TimeSpan 的最小替身（i64 = 100ns 单位），
/// 仅作 IAcrylicBrush TintTransitionDuration 的 ABI 占位（未调用）。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TimeSpan(pub i64);

/// `AcrylicBackgroundSource::Backdrop = 1`（HostBackdrop=0；任务栏必须用
/// Backdrop——窗口本身透明，取 XAML 背后内容）。
pub const ACRYLIC_BACKGROUND_SOURCE_BACKDROP: i32 = 1;

/// 把出参收成的接口指针转成拥有所有权的 `I`；null → `Err`。
unsafe fn take_interface<I: Interface>(raw: *mut core::ffi::c_void) -> windows_core::Result<I> {
    if raw.is_null() {
        return Err(windows_core::Error::from_hresult(windows_core::HRESULT(
            0x8000_4003_u32 as i32,
        )));
    }
    Ok(unsafe { I::from_raw(raw) })
}

/// IID `{8806a321-1e06-422c-a1cc-01696559e021}`。
#[interface("8806A321-1E06-422C-A1CC-01696559E021")]
pub unsafe trait IBrush: rt::IInspectable {
    pub unsafe fn get_Opacity(&self, value: *mut f64) -> windows_core::HRESULT;
    pub unsafe fn put_Opacity(&self, value: f64) -> windows_core::Result<()>;
    pub unsafe fn get_Transform(&self, value: *mut *mut core::ffi::c_void)
        -> windows_core::HRESULT;
    pub unsafe fn put_Transform(
        &self,
        value: windows_core::Ref<rt::IInspectable>,
    ) -> windows_core::Result<()>;
    pub unsafe fn get_RelativeTransform(
        &self,
        value: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
    pub unsafe fn put_RelativeTransform(
        &self,
        value: windows_core::Ref<rt::IInspectable>,
    ) -> windows_core::Result<()>;
}

impl IBrush {
    pub unsafe fn opacity(&self) -> windows_core::Result<f64> {
        let mut v = 0.0;
        unsafe { self.get_Opacity(&mut v) }.ok()?;
        Ok(v)
    }
}

/// IID `{9d850850-66f3-48df-9a8f-824bd5e070af}`。
#[interface("9D850850-66F3-48DF-9A8F-824BD5E070AF")]
pub unsafe trait ISolidColorBrush: rt::IInspectable {
    pub unsafe fn get_Color(&self, value: *mut Color) -> windows_core::HRESULT;
    pub unsafe fn put_Color(&self, value: Color) -> windows_core::Result<()>;
}

impl ISolidColorBrush {
    pub unsafe fn color(&self) -> windows_core::Result<Color> {
        let mut v = Color::default();
        unsafe { self.get_Color(&mut v) }.ok()?;
        Ok(v)
    }
}

/// IID `{79bbcf4e-cd66-4f1b-a8b6-cd6d2977c18d}`。
#[interface("79BBCF4E-CD66-4F1B-A8B6-CD6D2977C18D")]
pub unsafe trait IAcrylicBrush: rt::IInspectable {
    pub unsafe fn get_BackgroundSource(&self, value: *mut i32) -> windows_core::HRESULT;
    pub unsafe fn put_BackgroundSource(&self, value: i32) -> windows_core::Result<()>;
    pub unsafe fn get_TintColor(&self, value: *mut Color) -> windows_core::HRESULT;
    pub unsafe fn put_TintColor(&self, value: Color) -> windows_core::Result<()>;
    pub unsafe fn get_TintOpacity(&self, value: *mut f64) -> windows_core::HRESULT;
    pub unsafe fn put_TintOpacity(&self, value: f64) -> windows_core::Result<()>;
    pub unsafe fn get_TintTransitionDuration(&self, value: *mut TimeSpan) -> windows_core::HRESULT;
    pub unsafe fn put_TintTransitionDuration(&self, value: TimeSpan) -> windows_core::Result<()>;
    pub unsafe fn get_AlwaysUseFallback(&self, value: *mut bool) -> windows_core::HRESULT;
    pub unsafe fn put_AlwaysUseFallback(&self, value: bool) -> windows_core::Result<()>;
}

impl IAcrylicBrush {
    pub unsafe fn tint_color(&self) -> windows_core::Result<Color> {
        let mut v = Color::default();
        unsafe { self.get_TintColor(&mut v) }.ok()?;
        Ok(v)
    }
}

/// IID `{786f2b75-9aa0-454d-ae06-a2466e37c832}`（vtable 前缀：Fill 恰是前两个方法）。
#[interface("786F2B75-9AA0-454D-AE06-A2466E37C832")]
pub unsafe trait IShape: rt::IInspectable {
    pub unsafe fn get_Fill(&self, value: *mut *mut core::ffi::c_void) -> windows_core::HRESULT;
    pub unsafe fn put_Fill(&self, value: windows_core::Ref<IBrush>) -> windows_core::Result<()>;
}

impl IShape {
    /// 当前 Fill；系统未赋值（null）时返回 `None`。
    pub unsafe fn fill(&self) -> windows_core::Result<Option<IBrush>> {
        let mut raw: *mut core::ffi::c_void = core::ptr::null_mut();
        unsafe { self.get_Fill(&mut raw) }.ok()?;
        if raw.is_null() {
            return Ok(None);
        }
        Ok(Some(unsafe { IBrush::from_raw(raw) }))
    }
}

/// IID `{1d7b4c55-9df3-48dc-9194-9d306faa6089}`（前缀：FillProperty 是第一个静态方法）。
#[interface("1D7B4C55-9DF3-48DC-9194-9D306FAA6089")]
pub unsafe trait IShapeStatics: rt::IInspectable {
    pub unsafe fn get_FillProperty(
        &self,
        value: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
}

impl IShapeStatics {
    pub unsafe fn fill_property(&self) -> windows_core::Result<IDependencyProperty> {
        let mut raw: *mut core::ffi::c_void = core::ptr::null_mut();
        unsafe { self.get_FillProperty(&mut raw) }.ok()?;
        unsafe { take_interface(raw) }
    }
}

/// IID `{676d0be9-b65c-41c6-ba40-58cf87f201c1}`——仅作指针类型传递，无调用。
#[interface("676D0BE9-B65C-41C6-BA40-58CF87F201C1")]
pub unsafe trait IUIElement: rt::IInspectable {}

/// IID `{5c526665-f60e-4912-af59-5fe0680f089d}`——仅作指针类型使用，无调用。
#[interface("5C526665-F60E-4912-AF59-5FE0680F089D")]
pub unsafe trait IDependencyObject: rt::IInspectable {}

/// IID `{85b13970-9bc4-4e96-acf1-30c8fd3d55c8}`——DependencyProperty 句柄类。
#[interface("85B13970-9BC4-4E96-ACF1-30C8FD3D55C8")]
pub unsafe trait IDependencyProperty: rt::IInspectable {}

/// IID `{29fed85d-3d22-43a1-add0-17027c08b212}`：属性变更回调注册。
#[interface("29FED85D-3D22-43A1-ADD0-17027C08B212")]
pub unsafe trait IDependencyObject2: rt::IInspectable {
    pub unsafe fn RegisterPropertyChangedCallback(
        &self,
        dp: windows_core::Ref<IDependencyProperty>,
        callback: windows_core::Ref<IDependencyPropertyChangedCallback>,
        result: *mut i64,
    ) -> windows_core::HRESULT;
    pub unsafe fn UnregisterPropertyChangedCallback(
        &self,
        dp: windows_core::Ref<IDependencyProperty>,
        token: i64,
    ) -> windows_core::Result<()>;
}

impl IDependencyObject2 {
    pub unsafe fn register_changed<P0, P1>(&self, dp: P0, callback: P1) -> windows_core::Result<i64>
    where
        P0: windows_core::Param<IDependencyProperty>,
        P1: windows_core::Param<IDependencyPropertyChangedCallback>,
    {
        let dp_val = dp.param();
        let cb_val = callback.param();
        let mut token: i64 = 0;
        unsafe {
            (windows_core::Interface::vtable(self).RegisterPropertyChangedCallback)(
                windows_core::Interface::as_raw(self),
                dp_val.borrow(),
                cb_val.borrow(),
                &mut token,
            )
        }
        .ok()?;
        Ok(token)
    }
}

/// IID `{45883d16-27bf-4bc1-ac26-94c1601f3a49}`——SDK 头里显式基于 **IUnknown**
/// 的 WinRT 委托，Invoke 槽位紧跟 QI/AddRef/Release。
#[interface("45883D16-27BF-4BC1-AC26-94C1601F3A49")]
pub unsafe trait IDependencyPropertyChangedCallback: windows_core::IUnknown {
    pub unsafe fn Invoke(
        &self,
        sender: windows_core::Ref<IDependencyObject>,
        dp: windows_core::Ref<IDependencyProperty>,
    ) -> windows_core::Result<()>;
}

/// IID `{d585bfe1-00ff-51be-ba1d-a1329956ea0a}`（前缀：Content 是第一个属性）。
#[interface("D585BFE1-00FF-51BE-BA1D-A1329956EA0A")]
pub unsafe trait IDesktopWindowXamlSource: rt::IInspectable {
    pub unsafe fn get_Content(&self, value: *mut *mut core::ffi::c_void) -> windows_core::HRESULT;
}

impl IDesktopWindowXamlSource {
    pub unsafe fn content(&self) -> windows_core::Result<windows_core::IInspectable> {
        let mut raw: *mut core::ffi::c_void = core::ptr::null_mut();
        unsafe { self.get_Content(&mut raw) }.ok()?;
        unsafe { take_interface(raw) }
    }
}

/// IID `{3cbcf1bf-2f76-4e9c-96ab-126458175104}`——纯 COM（IUnknown）互操作接口。
#[interface("3CBCF1BF-2F76-4E9C-96AB-126458175104")]
pub unsafe trait IDesktopWindowXamlSourceNative: windows_core::IUnknown {
    pub unsafe fn get_WindowHandle(&self, value: *mut HWND) -> windows_core::HRESULT;
}

impl IDesktopWindowXamlSourceNative {
    pub unsafe fn window_handle(&self) -> windows_core::Result<HWND> {
        let mut hwnd = HWND::default();
        unsafe { self.get_WindowHandle(&mut hwnd) }.ok()?;
        Ok(hwnd)
    }
}

/// IID `{08c92b38-ec99-4c55-bc85-a1c180b27646}`（前缀：GetElementVisual 第一个）。
#[interface("08C92B38-EC99-4C55-BC85-A1C180B27646")]
pub unsafe trait IElementCompositionPreviewStatics: rt::IInspectable {
    pub unsafe fn GetElementVisual(
        &self,
        element: windows_core::Ref<IUIElement>,
        result: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
}

impl IElementCompositionPreviewStatics {
    pub unsafe fn element_visual(
        &self,
        element: &IUIElement,
    ) -> windows_core::Result<windows::UI::Composition::Visual> {
        let element_val = <&IUIElement as windows_core::Param<IUIElement>>::param(element);
        let mut raw: *mut core::ffi::c_void = core::ptr::null_mut();
        unsafe {
            (windows_core::Interface::vtable(self).GetElementVisual)(
                windows_core::Interface::as_raw(self),
                element_val.borrow(),
                &mut raw,
            )
        }
        .ok()?;
        unsafe { take_interface(raw) }
    }
}

/// IID `{03e432d9-b35c-4a79-811c-c5652004da0e}`。
#[interface("03E432D9-B35C-4A79-811C-C5652004DA0E")]
pub unsafe trait IXamlCompositionBrushBase: rt::IInspectable {
    pub unsafe fn get_FallbackColor(&self, value: *mut Color) -> windows_core::HRESULT;
    pub unsafe fn put_FallbackColor(&self, value: Color) -> windows_core::Result<()>;
}

/// IID `{81a32568-f6cc-4013-8363-928ae23b7a61}`——AcrylicBrush 的可组合工厂。
///
/// AcrylicBrush 是 **composable-only** 类：系统的 `IActivationFactory::
/// ActivateInstance` 对它返回 E_NOTIMPL（真机复现），必须按 C++/WinRT 默认
/// 构造的同款路径 `IAcrylicBrushFactory::CreateInstance(null, &inner, &value)`
/// 构造（C++/WinRT 默认构造的等价路径）。
#[interface("81A32568-F6CC-4013-8363-928AE23B7A61")]
pub unsafe trait IAcrylicBrushFactory: rt::IInspectable {
    pub unsafe fn CreateInstance(
        &self,
        baseinterface: *mut core::ffi::c_void,
        innerinterface: *mut *mut core::ffi::c_void,
        value: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
}

/// IID `{1513f3d8-0457-4e1c-ad77-11c1d9879743}`——派生类在 OnConnected 里经
/// 它把 Composition 画刷挂到聚合的底层对象上。
#[interface("1513F3D8-0457-4E1C-AD77-11C1D9879743")]
pub unsafe trait IXamlCompositionBrushBaseProtected: rt::IInspectable {
    pub unsafe fn get_CompositionBrush(
        &self,
        value: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
    pub unsafe fn put_CompositionBrush(
        &self,
        value: windows_core::Ref<windows::UI::Composition::ICompositionBrush>,
    ) -> windows_core::Result<()>;
}

impl IXamlCompositionBrushBaseProtected {
    pub unsafe fn composition_brush(
        &self,
    ) -> windows_core::Result<windows::UI::Composition::ICompositionBrush> {
        let mut raw: *mut core::ffi::c_void = core::ptr::null_mut();
        unsafe { self.get_CompositionBrush(&mut raw) }.ok()?;
        unsafe { take_interface(raw) }
    }
}

/// IID `{d19127f1-38b4-4ea1-8f33-849629a4c9c1}`——overridable 虚方法对。
#[interface("D19127F1-38B4-4EA1-8F33-849629A4C9C1")]
pub unsafe trait IXamlCompositionBrushBaseOverrides: rt::IInspectable {
    pub unsafe fn OnConnected(&self) -> windows_core::Result<()>;
    pub unsafe fn OnDisconnected(&self) -> windows_core::Result<()>;
}

/// IID `{394f0823-2451-4ed8-bd24-488149b3428d}`——composable 工厂。
///
/// CreateInstance 的 ABI 是 `(this, base, inner*, value*)` 且无 retval——
/// 保持原始签名手工调用（唯一调用点在 blur_brush.rs）。
#[interface("394F0823-2451-4ED8-BD24-488149B3428D")]
pub unsafe trait IXamlCompositionBrushBaseFactory: rt::IInspectable {
    pub unsafe fn CreateInstance(
        &self,
        baseinterface: *mut core::ffi::c_void,
        innerinterface: *mut *mut core::ffi::c_void,
        value: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT;
}
