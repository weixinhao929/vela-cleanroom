//! Real GPU utilization & VRAM collection on Windows via Performance Counters
//! (PDH). No synthetic/estimated values: each number is read from the system.
//!
//! - Utilization: per-adapter (LUID) sums of `\GPU Engine(*)\Utilization
//!   Percentage`, reporting the BUSIEST adapter — Task Manager's default view.
//!   On an iGPU+dGPU host the cross-adapter sum clamps to a meaningless 100%;
//!   on single-GPU hosts there is exactly one adapter, so nothing changes.
//! - VRAM used: `\GPU Adapter Memory(*)\Total Committed` of the same (busiest)
//!   adapter — dedicated + shared committed bytes, matching Task Manager's GPU
//!   memory reading. On laptops with an integrated GPU the `Dedicated Usage`
//!   counter is nearly always 0 (VRAM is shared system memory), so using it
//!   alone produced a misleading "0 GB".
//! - VRAM total: `Dedicated Limit` + `Shared Limit` of the same adapter when
//!   the host exposes them; absent (common on iGPU/`Total Committed`-only
//!   hosts) it stays 0 and the widgets show only the used amount.
//!
//! Performance note: all four counters live in ONE persistent query that is
//! only collected (never rebuilt) per frame. The previous implementation
//! opened 4 queries per read with a 300ms sleep in each (>1.2s blocking per
//! sample), which dragged the whole `sys:stats` broadcast cadence. With a
//! persistent handle, rate counters accumulate across collects, so no sleep is
//! needed at all — but the FIRST read after opening has no baseline and
//! reports `None` (widgets keep their placeholder for one interval).
//!
//! On non-Windows, or when Windows exposes no GPU counters (e.g. a host with no
//! display adapter reporting), the callers get `None` and the widgets hide the
//! GPU section instead of showing a fabricated number.

#[cfg(windows)]
pub mod imp {
    use std::alloc::{alloc_zeroed, dealloc, Layout};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
        PDH_MORE_DATA,
    };

    /// 仅测试使用：生产路径（system.rs）已直接基于 read_all_gpus 的本帧样本
    /// 取最忙一块，避免对同一 PDH 查询背靠背 collect 两次。
    #[cfg(test)]
    #[derive(Clone, Copy, Debug)]
    pub struct GpuStats {
        pub usage: f32,
        pub mem_used_gb: f32,
        pub mem_total_gb: f32,
    }

    /// BUG-1（审计）：单块适配器的采样结果。`luid` 为 PDH 实例里的
    /// `0xHHHHHHHH_0xLLLLLLLL` 键，用于与 DXGI 名称目录对齐取型号名。
    #[derive(Clone, Debug)]
    pub struct GpuSample {
        pub luid: String,
        pub usage: f32,
        pub mem_used_gb: f32,
        pub mem_total_gb: f32,
    }

    /// Reads (instance name, value) pairs of every instance of a collected
    /// counter. Returns `None` when the counter yields no data — never a
    /// made-up number.
    fn read_items(counter: PDH_HCOUNTER) -> Option<Vec<(String, f64)>> {
        // First pass: ask for the required buffer size (bytes) and item count.
        let mut buf_size: u32 = 0;
        let mut item_count: u32 = 0;
        // SAFETY: buf_size/item_count are valid out-pointers; None probes size.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                None,
            )
        };
        if status != 0 && status != PDH_MORE_DATA {
            return None;
        }
        if buf_size == 0 || item_count == 0 {
            return None;
        }

        let layout = Layout::from_size_align(
            buf_size as usize,
            std::mem::align_of::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
        )
        .ok()?;
        // SAFETY: layout has non-zero size and correct alignment for the item type.
        let raw = unsafe { alloc_zeroed(layout) } as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if raw.is_null() {
            return None;
        }

        // SAFETY: raw points to a buffer of `buf_size` bytes; the API fills it.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                Some(raw),
            )
        };

        let mut out = Vec::with_capacity(item_count as usize);
        if status == 0 {
            // SAFETY: item_count items were written into the buffer; each is a valid
            // PDH_FMT_COUNTERVALUE_ITEM_W readable for the lifetime of `raw`.
            let items = unsafe { std::slice::from_raw_parts(raw, item_count as usize) };
            for it in items {
                // SAFETY: szName points to a null-terminated wide string owned by
                // the buffer we allocated; it stays alive until dealloc below.
                let name = String::from_utf16_lossy(unsafe { it.szName.as_wide() });
                // SAFETY: the union is initialized when the item is valid.
                out.push((name, unsafe { it.FmtValue.Anonymous.doubleValue }));
            }
        }

        // SAFETY: freeing the allocated buffer matches its layout.
        unsafe {
            dealloc(raw as *mut u8, layout);
        }
        Some(out)
    }

    /// Adapter identity (LUID pair) of a PDH GPU instance name. Engine
    /// instances look like `pid_1234_luid_0x00000000_0x0000C607_phys_0_eng_0`,
    /// adapter-memory instances are the bare LUID pair itself
    /// (`0x00000000_0x0000C607`). Unparseable names fall back to the whole
    /// string so they still form their own per-instance group.
    fn adapter_luid(name: &str) -> String {
        if let Some(idx) = name.find("luid_") {
            let rest = &name[idx + "luid_".len()..];
            let mut parts = rest.split('_');
            if let (Some(a), Some(b)) = (parts.next(), parts.next()) {
                if a.starts_with("0x") && b.starts_with("0x") {
                    return format!("{a}_{b}");
                }
            }
        }
        name.to_string()
    }

    /// Pre-parses raw PDH instance names into `(adapter_luid, value)` pairs so
    /// downstream aggregation never re-runs the per-name string parse per pass
    /// (F-10 / F-12).
    fn parse_items(items: &[(String, f64)]) -> Vec<(String, f64)> {
        items.iter().map(|(n, v)| (adapter_luid(n), *v)).collect()
    }

    /// Sums values whose instance belongs to `luid`; `items` must already be
    /// `parse_items` output. BUG-1（审计）：改为严格匹配、去掉"无匹配回退全
    /// 部求和"——多卡场景把 A 卡显存记到 B 卡是错误的；单卡主机行为不变。
    fn sum_for_luid(items: &[(String, f64)], luid: &str) -> f64 {
        items
            .iter()
            .filter(|(n, _)| n.as_str() == luid)
            .map(|(_, v)| v)
            .sum()
    }

    fn add_counter(query: PDH_HQUERY, path: &str) -> Option<PDH_HCOUNTER> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut counter = PDH_HCOUNTER::default();
        // SAFETY: counter is a valid out-pointer; wide is a null-terminated buffer
        // that stays alive for the duration of the call.
        let status =
            unsafe { PdhAddEnglishCounterW(query, PCWSTR(wide.as_ptr()), 0, &mut counter) };
        if status == 0 {
            Some(counter)
        } else {
            None
        }
    }

    /// Persistent PDH query hosting all four GPU counters. `read()` only
    /// collects — no query open/close, no sleeps. Owns the handles and closes
    /// them on drop.
    pub struct GpuSampler {
        query: PDH_HQUERY,
        engines: PDH_HCOUNTER,
        committed: PDH_HCOUNTER,
        dedicated_limit: PDH_HCOUNTER,
        shared_limit: PDH_HCOUNTER,
        /// False until the first (baseline) collect; rate counters need two.
        primed: bool,
        /// Consecutive failed samples (collect error or empty engine set).
        /// Display-driver updates, GPU hot-unplug or TDR recovery can
        /// invalidate PDH handles/instances; once this crosses the threshold
        /// the caller rebuilds the whole query so the GPU section heals
        /// instead of staying dead until app restart.
        fails: u32,
    }

    /// Consecutive failures after which `read_gpu` rebuilds the query.
    const REBUILD_AFTER_FAILS: u32 = 10;

    // The handles are plain PDH pointers used under an external Mutex
    // (see `GpuHandle`); PDH queries are not thread-safe by themselves but are
    // never accessed concurrently here.
    unsafe impl Send for GpuSampler {}

    impl GpuSampler {
        /// Opens the persistent query. `Err(())` when the host exposes no GPU
        /// engine counter set (callers hide the GPU section permanently).
        pub fn new() -> Result<Self, ()> {
            let mut query = PDH_HQUERY::default();
            // SAFETY: query is a valid out-pointer.
            if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
                return Err(());
            }
            let engines = add_counter(query, r"\GPU Engine(*)\Utilization Percentage");
            let Some(engines) = engines else {
                // SAFETY: query was opened successfully above.
                unsafe {
                    let _ = PdhCloseQuery(query);
                }
                return Err(());
            };
            // Memory counters are optional (unwrap_or(0) semantics preserved).
            let committed =
                add_counter(query, r"\GPU Adapter Memory(*)\Total Committed").unwrap_or_default();
            let dedicated_limit =
                add_counter(query, r"\GPU Adapter Memory(*)\Dedicated Limit").unwrap_or_default();
            let shared_limit =
                add_counter(query, r"\GPU Adapter Memory(*)\Shared Limit").unwrap_or_default();
            Ok(Self {
                query,
                engines,
                committed,
                dedicated_limit,
                shared_limit,
                primed: false,
                fails: 0,
            })
        }

        /// True when the query has failed too many times in a row and should be
        /// dropped and re-created by the caller.
        pub fn needs_rebuild(&self) -> bool {
            self.fails >= REBUILD_AFTER_FAILS
        }

        /// One non-blocking collect + read. `None` until the second call
        /// (rate counters require a baseline sample). BUG-1（审计）：返回
        /// 每块适配器一条样本（引擎∪内存计数器里出现过的 LUID），空闲的
        /// dGPU 也能被看到，不再只报"最忙的一块"。
        pub fn read(&mut self) -> Option<Vec<GpuSample>> {
            // SAFETY: handles are valid for the lifetime of self.
            if unsafe { PdhCollectQueryData(self.query) } != 0 {
                self.fails = self.fails.saturating_add(1);
                return None;
            }
            if !self.primed {
                self.primed = true;
                // 基线采样不算失败。
                return None;
            }
            let engine_items = match read_items(self.engines) {
                Some(items) if !items.is_empty() => items,
                // collect 成功但引擎实例集为空：驱动重装/TDR 后的典型状态，
                // 计为失败以触发重建（否则空查询会一直返回 None）。
                _ => {
                    self.fails = self.fails.saturating_add(1);
                    return None;
                }
            };
            self.fails = 0;
            let engine_parsed = parse_items(&engine_items);
            let committed = parse_items(&read_items(self.committed).unwrap_or_default());
            let dedicated_limit =
                parse_items(&read_items(self.dedicated_limit).unwrap_or_default());
            let shared_limit = parse_items(&read_items(self.shared_limit).unwrap_or_default());

            // 候选适配器 = 引擎实例 ∪ 内存实例出现过的 LUID。空闲独显没有
            // GPU Engine 实例（这正是它此前永远不可见的根因），但通常仍有
            // Adapter Memory 实例；两者皆无时不伪造数据。
            let mut luids: Vec<String> = Vec::new();
            for (k, _) in engine_parsed.iter().chain(committed.iter()) {
                if !luids.iter().any(|l| l == k) {
                    luids.push(k.clone());
                }
            }

            let samples: Vec<GpuSample> = luids
                .into_iter()
                .map(|luid| {
                    let usage = engine_parsed
                        .iter()
                        .filter(|(n, _)| *n == luid)
                        .map(|(_, v)| *v)
                        .sum::<f64>()
                        .min(100.0) as f32;
                    let used_bytes = sum_for_luid(&committed, &luid);
                    let limit_bytes =
                        sum_for_luid(&dedicated_limit, &luid) + sum_for_luid(&shared_limit, &luid);
                    GpuSample {
                        luid,
                        usage,
                        mem_used_gb: (used_bytes / 1024.0 / 1024.0 / 1024.0) as f32,
                        mem_total_gb: (limit_bytes / 1024.0 / 1024.0 / 1024.0) as f32,
                    }
                })
                .collect();
            if samples.is_empty() {
                None
            } else {
                Some(samples)
            }
        }
    }

    impl Drop for GpuSampler {
        fn drop(&mut self) {
            // SAFETY: query was opened in new() and not yet closed.
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }

    /// Process-wide sampler handle. Lazily opened once; `None` forever on
    /// hosts without GPU counters. When the persistent query goes sour
    /// mid-run (driver update, GPU hot-unplug, TDR recovery — the collect
    /// starts failing or the engine instance set empties), it is rebuilt
    /// after `REBUILD_AFTER_FAILS` consecutive failures so the GPU section
    /// recovers without an app restart.
    pub fn read_all_gpus() -> Option<Vec<GpuSample>> {
        static SAMPLER: std::sync::OnceLock<Mutex<Option<GpuSampler>>> = std::sync::OnceLock::new();
        let lock = SAMPLER.get_or_init(|| Mutex::new(GpuSampler::new().ok()));
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        let stats = guard.as_mut().and_then(|s| s.read());
        if guard.as_ref().is_some_and(|s| s.needs_rebuild()) {
            log::warn!("PDH GPU query failing repeatedly; rebuilding query");
            *guard = GpuSampler::new().ok();
        }
        stats
    }

    /// 标量口径（多卡中取最忙的一块）。仅测试使用，见 GpuStats 说明。
    #[cfg(test)]
    pub fn read_gpu() -> Option<GpuStats> {
        let all = read_all_gpus()?;
        let best = all.iter().max_by(|a, b| a.usage.total_cmp(&b.usage))?;
        Some(GpuStats {
            usage: best.usage,
            mem_used_gb: best.mem_used_gb,
            mem_total_gb: best.mem_total_gb,
        })
    }

    /// BUG-1（审计）：DXGI 枚举全部显示适配器，键为与 PDH 实例一致的小写
    /// `0x{high:08x}_0x{low:08x}` 形式。进程内只枚举一次（适配器热插拔在
    /// 桌面场景极罕见；未命中名称的 LUID 由前端回退占位名）。
    pub fn gpu_display_names() -> &'static HashMap<String, String> {
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
        static NAMES: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
        NAMES.get_or_init(|| {
            let mut map: HashMap<String, String> = HashMap::new();
            // SAFETY: 工厂由 RAII 接口对象管理，无裸指针外泄。
            if let Ok(factory) = unsafe { CreateDXGIFactory1::<IDXGIFactory1>() } {
                let mut i: u32 = 0;
                while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
                    // SAFETY: desc 为 API 输出参数。
                    if let Ok(desc) = unsafe { adapter.GetDesc1() } {
                        let name = String::from_utf16_lossy(
                            desc.Description.split(|c| *c == 0).next().unwrap_or(&[]),
                        );
                        map.insert(
                            format!(
                                "0x{:08x}_0x{:08x}",
                                desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
                            ),
                            name.trim().to_string(),
                        );
                    }
                    i += 1;
                    if i > 16 {
                        break; // 防御性上界：正常主机 ≤4 块
                    }
                }
            }
            map
        })
    }

    /// PDH 的 LUID 键 → 显卡型号名；未命中返回空串（前端显示占位名）。
    pub fn model_for_luid(luid: &str) -> String {
        gpu_display_names()
            .get(&luid.to_ascii_lowercase())
            .cloned()
            .unwrap_or_default()
    }
}

#[cfg(not(windows))]
pub mod imp {
    #[cfg(test)]
    #[derive(Clone, Copy, Debug)]
    pub struct GpuStats {
        pub usage: f32,
        pub mem_used_gb: f32,
        pub mem_total_gb: f32,
    }
    #[derive(Clone, Debug)]
    pub struct GpuSample {
        pub luid: String,
        pub usage: f32,
        pub mem_used_gb: f32,
        pub mem_total_gb: f32,
    }
    pub fn read_all_gpus() -> Option<Vec<GpuSample>> {
        None
    }
    #[cfg(test)]
    pub fn read_gpu() -> Option<GpuStats> {
        None
    }
    pub fn model_for_luid(_luid: &str) -> String {
        String::new()
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::read_gpu;

    #[test]
    fn reads_real_gpu_data_or_explicit_none() {
        // On a machine with a display adapter this must return real counters
        // (usage 0..=100, finite VRAM) after the baseline prime; on a host
        // exposing no GPU counters it returns None — it must never fabricate
        // a value. (First read primes the persistent query, second reads.)
        match read_gpu() {
            Some(_) | None => {}
        }
        match read_gpu() {
            Some(g) => {
                assert!(g.usage.is_finite() && (0.0..=100.0).contains(&g.usage));
                assert!(g.mem_used_gb.is_finite() && g.mem_used_gb >= 0.0);
                assert!(g.mem_total_gb.is_finite() && g.mem_total_gb >= 0.0);
                eprintln!(
                    "[gpu] usage={:.1}% used={:.1}GB total={:.1}GB",
                    g.usage, g.mem_used_gb, g.mem_total_gb
                );
            }
            None => eprintln!("[gpu] no GPU counters exposed on this host"),
        }
    }
}
