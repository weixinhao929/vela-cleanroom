//! Vela 自定义模糊画刷——手工复刻 C++/WinRT 对**可组合（overridable）类**
//! `Windows.UI.Xaml.Media.XamlCompositionBrushBase` 的派生机制。
//!
//! C++/WinRT 的 `XamlCompositionBrushBaseT<T>` 实际做的是
//! COM 聚合：
//! 1. 派生对象 O 先建好（实现 `IXamlCompositionBrushBaseOverrides`）；
//! 2. 经 `IXamlCompositionBrushBaseFactory::CreateInstance(O, &inner, &value)`
//!    创建底层**真实**画刷对象 inner（聚合外层 = O）；
//! 3. O 的 QueryInterface：自身实现的可覆盖接口 → O；其余 → 转发 inner
//!    （inner 持 O 的引用计数，身份规则保持一致）；
//! 4. XAML 把画刷挂上元素时回调 `OnConnected`，派生类经
//!    `IXamlCompositionBrushBaseProtected::put_CompositionBrush` 把
//!    Backdrop → GaussianBlur(σ) → Flood(tint) → SourceOver 效果链设回 inner。
//!
//! 效果链构图：Backdrop → GaussianBlur(σ) → Flood(tint) → SourceOver。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use windows::UI::Composition::{CompositionBackdropBrush, Compositor};
use windows_core::{IInspectable, IUnknown, Interface};

use crate::effects::{CompositeEffect, FloodEffect, GaussianBlurEffect};
use crate::xaml::{
    IBrush, IXamlCompositionBrushBase, IXamlCompositionBrushBaseFactory,
    IXamlCompositionBrushBaseOverrides, IXamlCompositionBrushBaseProtected,
};

/// 哨兵引用计数：析构期间的任何再入 AddRef/Release 都变成无操作
/// （inner 释放对外层 baseInterface 的引用时会再入我们的 Release）。
const REFS_DYING: u32 = u32::MAX / 2;

/// 效果链参数（构造后不可变）。
pub(crate) struct BlurBrushParams {
    pub compositor: Compositor,
    /// 高斯标准差 σ = blur_radius / 3。
    pub sigma: f32,
    /// tint，线性空间 [r,g,b,a]。
    pub tint: [f32; 4],
}

/// 外层对象。所有接口面（overrides / 非委托 IUnknown）都指向同一地址，
/// 面的身份由头部 vtable 指针区分。
///
/// `repr(C)` 不可省：默认 repr 允许 rustc 重排字段（含把带 niche 的字段挪到
/// 头部），一旦 `vt` 不在偏移 0，XAML 对该对象的首次 AddRef/QueryInterface
/// 就会把 `params.compositor` 之类的指针当 vtable 解引用——直接写坏 explorer。
#[repr(C)]
struct BlurBrushOuter {
    /// 必须在偏移 0：COM 侧以此发现 vtable（Rust 侧不直接读）。
    #[allow(dead_code)]
    vt: *const OverridesFaceVtbl,
    refs: AtomicU32,
    /// inner 在 CreateInstance 之后才有效（构造窗口期为 null）。
    inner: Mutex<Option<IInspectable>>,
    params: BlurBrushParams,
    connected: AtomicBool,
}

// COM 身份契约：对象首字即 vtable 指针。编译期钉死，字段增删也不会悄悄漂移。
const _: () = assert!(core::mem::offset_of!(BlurBrushOuter, vt) == 0);

#[repr(C)]
struct OverridesFaceVtbl {
    query_interface: RawQi,
    add_ref: RawUlong,
    release: RawUlong,
    get_iids: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut u32,
        *mut *mut windows_core::GUID,
    ) -> windows_core::HRESULT,
    get_runtime_class_name: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    get_trust_level:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> windows_core::HRESULT,
    on_connected: unsafe extern "system" fn(*mut core::ffi::c_void) -> windows_core::HRESULT,
    on_disconnected: unsafe extern "system" fn(*mut core::ffi::c_void) -> windows_core::HRESULT,
}

type RawQi = unsafe extern "system" fn(
    *mut core::ffi::c_void,
    *const windows_core::GUID,
    *mut *mut core::ffi::c_void,
) -> windows_core::HRESULT;

type RawUlong = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;

const S_OK: windows_core::HRESULT = windows_core::HRESULT(0);
const E_NOINTERFACE: windows_core::HRESULT = windows_core::HRESULT(0x8000_4002_u32 as i32);
const E_POINTER: windows_core::HRESULT = windows_core::HRESULT(0x8000_4003_u32 as i32);

static OVERRIDES_VTBL: OverridesFaceVtbl = OverridesFaceVtbl {
    query_interface: BlurBrushOuter::face_query_interface,
    add_ref: BlurBrushOuter::face_add_ref,
    release: BlurBrushOuter::face_release,
    get_iids: BlurBrushOuter::face_get_iids,
    get_runtime_class_name: BlurBrushOuter::face_get_runtime_class_name,
    get_trust_level: BlurBrushOuter::face_get_trust_level,
    on_connected: BlurBrushOuter::face_on_connected,
    on_disconnected: BlurBrushOuter::face_on_disconnected,
};

fn add_reference(refs: &AtomicU32) -> u32 {
    loop {
        let current = refs.load(Ordering::Acquire);
        if current >= REFS_DYING {
            return 1;
        }
        match refs.compare_exchange_weak(current, current + 1, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => return current + 1,
            Err(_) => continue,
        }
    }
}

/// 挂起引用计数；返回 `Some(剩余数)`，墓碑已立（或再入）时返回 `None`。
///
/// compare_exchange 原子地完成"减计 + 判零 + 立墓碑"：拿到 1→REFS_DYING
/// 交换权的线程独占析构，其他线程的减计要么落在墓碑之上（无操作），
/// 要么把计数停在 ≥1，不可能出现"计数归零但墓碑未立"的观察者。
///
/// 墓碑一旦立起就**不再翻回**：析构期间 inner 释放对外层的引用会再入
/// Release，XAML 侧的迟到 QueryInterface 会再入 AddRef——二者都必须落在
/// 墓碑上成为无操作。若此处把计数归零，再入 AddRef 会以 CAS(0→1) 成功
/// 拿到一个即将被释放对象的"有效"引用，再入 Release 则会下溢。
fn release_reference(refs: &AtomicU32) -> Option<u32> {
    let mut current = refs.load(Ordering::Relaxed);
    loop {
        if current >= REFS_DYING {
            return None;
        }
        match refs.compare_exchange_weak(
            current,
            if current == 1 {
                REFS_DYING
            } else {
                current - 1
            },
            Ordering::AcqRel,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Some(current - 1),
            Err(seen) => current = seen,
        }
    }
}

impl BlurBrushOuter {
    unsafe fn from_face<'a>(this: *mut core::ffi::c_void) -> &'a Self {
        unsafe { &*(this.cast::<BlurBrushOuter>()) }
    }

    unsafe extern "system" fn face_query_interface(
        this: *mut core::ffi::c_void,
        iid: *const windows_core::GUID,
        ppv: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT {
        if ppv.is_null() {
            return E_POINTER;
        }
        unsafe { *ppv = core::ptr::null_mut() };
        if iid.is_null() {
            return E_POINTER;
        }
        let iid = unsafe { &*iid };
        let outer = unsafe { Self::from_face(this) };
        // 身份接口与自身实现的可覆盖接口 → 外层面。
        if *iid == IUnknown::IID
            || *iid == IInspectable::IID
            || *iid == IXamlCompositionBrushBaseOverrides::IID
        {
            unsafe { *ppv = this };
            unsafe { Self::face_add_ref(this) };
            return S_OK;
        }
        // 其余一切 → 转发给聚合的 inner（inner 会以外层身份 AddRef）。
        if let Some(inner) = outer.inner.lock().ok().and_then(|g| g.clone()) {
            unsafe {
                let mut raw = core::ptr::null_mut();
                let hr = (Interface::vtable(&inner).base.QueryInterface)(
                    Interface::as_raw(&inner),
                    iid,
                    &mut raw,
                );
                if hr.is_ok() {
                    *ppv = raw;
                    return S_OK;
                }
            }
        }
        E_NOINTERFACE
    }

    unsafe extern "system" fn face_add_ref(this: *mut core::ffi::c_void) -> u32 {
        let outer = unsafe { Self::from_face(this) };
        add_reference(&outer.refs)
    }

    unsafe extern "system" fn face_release(this: *mut core::ffi::c_void) -> u32 {
        let outer = unsafe { Self::from_face(this) };
        let refs = release_reference(&outer.refs);
        if refs == Some(0) {
            let inner = outer.inner.lock().ok().and_then(|mut g| g.take());
            drop(inner);
            drop(unsafe { Box::from_raw(this.cast::<BlurBrushOuter>()) });
        }
        refs.unwrap_or(1)
    }

    // IInspectable::GetIids 契约：出参缓冲由被调方 CoTaskMemAlloc 分配，
    // 调用方（WinRT 投影）用 CoTaskMemFree 释放——谁分配谁释放，两端钉死。
    unsafe extern "system" fn face_get_iids(
        this: *mut core::ffi::c_void,
        count: *mut u32,
        iids: *mut *mut windows_core::GUID,
    ) -> windows_core::HRESULT {
        if count.is_null() || iids.is_null() {
            return E_POINTER;
        }
        unsafe {
            *count = 0;
            *iids = core::ptr::null_mut();
        }
        let _ = this;
        let mut id_array = [IXamlCompositionBrushBaseOverrides::IID];
        let size = core::mem::size_of::<windows_core::GUID>() * id_array.len();
        let alloc = unsafe { windows::Win32::System::Com::CoTaskMemAlloc(size) };
        if alloc.is_null() {
            return windows_core::HRESULT(0x8007_000E_u32 as i32); // E_OUTOFMEMORY
        }
        unsafe {
            core::ptr::copy_nonoverlapping(id_array.as_mut_ptr(), alloc.cast(), id_array.len());
            *count = id_array.len() as u32;
            *iids = alloc.cast();
        }
        S_OK
    }

    unsafe extern "system" fn face_get_runtime_class_name(
        _this: *mut core::ffi::c_void,
        name: *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT {
        if name.is_null() {
            return E_POINTER;
        }
        let h = windows_core::HSTRING::from("Windows.UI.Xaml.Media.XamlCompositionBrushBase");
        // IInspectable::GetRuntimeClassName 契约：出参 HSTRING 的所有权移交
        // 调用方，由其 WindowsDeleteString 释放；本方 forget 即放弃释放义务
        // （不 forget 会在返回时 Drop → 调用方持悬空 HSTRING）。
        let raw: *mut core::ffi::c_void = core::mem::transmute_copy(&h);
        core::mem::forget(h);
        unsafe { *name = raw };
        S_OK
    }

    unsafe extern "system" fn face_get_trust_level(
        _this: *mut core::ffi::c_void,
        trust: *mut i32,
    ) -> windows_core::HRESULT {
        if trust.is_null() {
            return E_POINTER;
        }
        unsafe { *trust = 0 }; // BaseTrust
        S_OK
    }

    unsafe extern "system" fn face_on_connected(
        this: *mut core::ffi::c_void,
    ) -> windows_core::HRESULT {
        let outer = unsafe { Self::from_face(this) };
        // 分步标注失败点：OnConnected 在 put_Fill 内同步触发，错误只以 HRESULT
        // 冒回外层，没有这层日志就无法区分是效果图构建、工厂创建还是挂接失败。
        fn step<T>(what: &str, r: windows_core::Result<T>) -> windows_core::Result<T> {
            if let Err(e) = &r {
                crate::vlog!("blur OnConnected: {what} failed: {e}");
            }
            r
        }
        crate::util::guarded("blur OnConnected", || {
            if outer.connected.swap(true, Ordering::AcqRel) {
                return Ok(()); // 已连过：幂等（对齐 XamlBlurBrush 的判空）。
            }
            let params = &outer.params;
            // Backdrop 源参数引用（"backdrop" 名字与 SetSourceParameter 对应）。
            let backdrop_source = step(
                "CompositionEffectSourceParameter::Create",
                windows::UI::Composition::CompositionEffectSourceParameter::Create(
                    &windows_core::HSTRING::from("backdrop"),
                ),
            )?;
            let blur = GaussianBlurEffect {
                source: step(
                    "backdrop cast IGraphicsEffectSource",
                    backdrop_source.cast(),
                )?,
                standard_deviation: params.sigma,
            };
            let flood = FloodEffect { color: params.tint };
            let blur_as: windows::Graphics::Effects::IGraphicsEffect = blur.into();
            let flood_as: windows::Graphics::Effects::IGraphicsEffect = flood.into();
            let composite = CompositeEffect {
                sources: vec![
                    step("blur cast IGraphicsEffectSource", blur_as.cast())?,
                    step("flood cast IGraphicsEffectSource", flood_as.cast())?,
                ],
            };
            let effect: windows::Graphics::Effects::IGraphicsEffect = composite.into();
            let factory = step(
                "Compositor::CreateEffectFactory",
                params.compositor.CreateEffectFactory(&effect),
            )?;
            let effect_brush = step("CreateBrush", factory.CreateBrush())?;
            let backdrop: CompositionBackdropBrush = step(
                "CreateBackdropBrush",
                params.compositor.CreateBackdropBrush(),
            )?;
            step(
                "SetSourceParameter",
                effect_brush
                    .SetSourceParameter(&windows_core::HSTRING::from("backdrop"), &backdrop),
            )?;
            // 经 protected 接口把效果画刷挂到聚合的底层对象上。
            let protected: IXamlCompositionBrushBaseProtected = step(
                "query IXamlCompositionBrushBaseProtected",
                query_own::<IXamlCompositionBrushBaseProtected>(this),
            )?;
            let effect_brush_iface: windows::UI::Composition::ICompositionBrush =
                step("effect brush cast ICompositionBrush", effect_brush.cast())?;
            step(
                "put_CompositionBrush",
                protected.put_CompositionBrush(&effect_brush_iface),
            )?;
            crate::vlog!(
                "blur OnConnected: effect chain attached (sigma={})",
                params.sigma
            );
            Ok(())
        })
        .map_or_else(
            |e| {
                outer.connected.store(false, Ordering::Release);
                e.code()
            },
            |()| S_OK,
        )
    }

    unsafe extern "system" fn face_on_disconnected(
        this: *mut core::ffi::c_void,
    ) -> windows_core::HRESULT {
        let outer = unsafe { Self::from_face(this) };
        crate::util::guarded("blur OnDisconnected", || {
            if !outer.connected.swap(false, Ordering::AcqRel) {
                return Ok(());
            }
            let protected: IXamlCompositionBrushBaseProtected =
                query_own::<IXamlCompositionBrushBaseProtected>(this)?;
            if let Ok(brush) = protected.composition_brush() {
                let closable: windows_core::Result<windows::Foundation::IClosable> = brush.cast();
                if let Ok(c) = closable {
                    let _ = c.Close();
                }
            }
            protected.put_CompositionBrush(None::<&windows::UI::Composition::ICompositionBrush>)?;
            Ok(())
        })
        .map_or_else(|e| e.code(), |()| S_OK)
    }
}

/// 从外层面对象上按 IID 查询（身份面优先，其余转发 inner）。
unsafe fn query_own<I: Interface>(this: *mut core::ffi::c_void) -> windows_core::Result<I> {
    let mut raw = core::ptr::null_mut();
    let hr = unsafe { BlurBrushOuter::face_query_interface(this, &I::IID, &mut raw) };
    hr.ok()?;
    if raw.is_null() {
        return Err(windows_core::Error::from_hresult(E_NOINTERFACE));
    }
    unsafe { windows_core::IUnknown::from_raw(raw) }.cast()
}

/// 创建模糊画刷：返回**已聚合**的 IBrush（身份 = 外层对象）。
///
/// 必须在任务栏 UI 线程调用（compositor 有线程亲和）。
pub(crate) fn create_blur_brush(params: BlurBrushParams) -> windows_core::Result<IBrush> {
    let outer = Box::new(BlurBrushOuter {
        vt: &OVERRIDES_VTBL,
        refs: AtomicU32::new(1),
        inner: Mutex::new(None),
        params,
        connected: AtomicBool::new(false),
    });
    let face = Box::into_raw(outer).cast::<core::ffi::c_void>();

    let factory: IXamlCompositionBrushBaseFactory =
        crate::util::activation_factory("Windows.UI.Xaml.Media.XamlCompositionBrushBase")
            .inspect_err(|e| {
                crate::vlog!("create_blur_brush: XamlCompositionBrushBase factory failed: {e}");
                // 失败路径：释放外层对象。
                unsafe { BlurBrushOuter::face_release(face) };
            })?;

    let mut inner_raw = core::ptr::null_mut();
    let mut value_raw = core::ptr::null_mut();
    let hr = unsafe { factory.CreateInstance(face, &mut inner_raw, &mut value_raw) };
    if hr.is_err() || inner_raw.is_null() || value_raw.is_null() {
        crate::vlog!(
            "create_blur_brush: CreateInstance failed hr={:#010x} inner_null={} value_null={}",
            hr.0,
            inner_raw.is_null(),
            value_raw.is_null()
        );
        unsafe { BlurBrushOuter::face_release(face) };
        return Err(windows_core::Error::from_hresult(if hr.is_ok() {
            E_POINTER
        } else {
            hr
        }));
    }
    {
        let outer_ref = unsafe { BlurBrushOuter::from_face(face) };
        let mut guard = outer_ref.inner.lock().map_err(|_| {
            unsafe { BlurBrushOuter::face_release(face) };
            windows_core::Error::from_hresult(E_POINTER)
        })?;
        *guard = Some(unsafe { IInspectable::from_raw(inner_raw) });
    }
    // 交出创建者引用（refs 初值 1）。COM 聚合规则下 CreateInstance 返回的 value
    // 是委托到外层对象的默认接口，其 AddRef 已落在外层（此刻 refs=2）；不释放
    // 这一票，refs 永远 ≥1、析构分支永不执行——每次创建泄漏整套外层 + inner +
    // CompositionBrush 效果图链，密集 apply/restore 下 explorer 内存单调增长。
    unsafe { BlurBrushOuter::face_release(face) };

    // value 即聚合实例；cast 消耗 value 的所有权，失败则其 Drop 自然释放。
    let base: IXamlCompositionBrushBase = unsafe { IXamlCompositionBrushBase::from_raw(value_raw) };
    let brush: IBrush = base.cast().inspect_err(|e| {
        crate::vlog!("create_blur_brush: aggregated value cast IBrush failed: {e}");
    })?;
    Ok(brush)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_release_round_trip_below_tombstone() {
        let refs = AtomicU32::new(1);
        assert_eq!(add_reference(&refs), 2);
        assert_eq!(add_reference(&refs), 3);
        assert_eq!(release_reference(&refs), Some(2));
        assert_eq!(release_reference(&refs), Some(1));
        assert_eq!(refs.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn last_release_raises_tombstone_that_never_flips_back() {
        let refs = AtomicU32::new(2);
        assert_eq!(release_reference(&refs), Some(1));
        // 最后一次 Release 独占析构权：计数进入墓碑区。
        assert_eq!(release_reference(&refs), Some(0));
        assert!(refs.load(Ordering::Relaxed) >= REFS_DYING);
        // 析构窗口内的再入 AddRef 不得拿到"有效"引用，再入 Release 不得
        // 二次触发析构，计数始终停在墓碑上。
        assert_eq!(add_reference(&refs), 1);
        assert!(refs.load(Ordering::Relaxed) >= REFS_DYING);
        assert_eq!(release_reference(&refs), None);
        assert!(refs.load(Ordering::Relaxed) >= REFS_DYING);
        assert_eq!(release_reference(&refs), None);
    }

    #[test]
    fn concurrent_release_hands_destruction_to_exactly_one_thread() {
        // N 个线程各做一次 Release（初值 N）：恰有一个线程得到 Some(0)，其余
        // 要么拿到 ≥1 的剩余数，要么落在墓碑上得到 None；终态停在墓碑区。
        for _ in 0..200 {
            let threads = 8u32;
            let refs = std::sync::Arc::new(AtomicU32::new(threads));
            let winners = std::sync::Arc::new(AtomicU32::new(0));
            let handles: Vec<_> = (0..threads)
                .map(|_| {
                    let refs = std::sync::Arc::clone(&refs);
                    let winners = std::sync::Arc::clone(&winners);
                    std::thread::spawn(move || {
                        if release_reference(&refs) == Some(0) {
                            winners.fetch_add(1, Ordering::SeqCst);
                        }
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap();
            }
            assert_eq!(winners.load(Ordering::SeqCst), 1);
            assert!(refs.load(Ordering::SeqCst) >= REFS_DYING);
            // 墓碑立起后的迟到 AddRef 无操作。
            assert_eq!(add_reference(&refs), 1);
            assert!(refs.load(Ordering::SeqCst) >= REFS_DYING);
        }
    }
}
