//! 快捷方式条目监听：
//!
//! 快捷方式组件的条目是路径引用，目标文件改名 / 删除 / 内容变更时前端需要
//! 感知：改名 → classify 重挂（path/label/kind）、删除 → 标 missing、内容
//! 变更 → 图标缓存失效重提取。本模块 watch 各实例条目**父目录**（非递归，
//! 多实例取并集），事件按 500ms 去抖后合并为一条 `shortcuts-watch:change`
//! { changes: [...] } 全局广播——载荷只带路径与变更类型，各实例前端按自身
//! 条目路径过滤（与 live-folder「事件只当脏标记」同哲学，删除侧前端仍会
//! check_paths_exist 核实后才标缺失）。
//!
//! watcher 生命周期：`apply_shortcut_watch` **按实例 id upsert**（未提及的
//! 实例保持不动——每个组件实例只送自己这一份，多实例互不踩踏；全量替换会让
//! 后调用的实例拆掉先调用实例的监视）。全实例父目录并集哈希未变跳过拆建；
//! 并集为空 = 移除监视。单 watcher + 单接收线程；watcher 被 drop 时 channel
//! 断连，线程随 recv 出错退出。监视失败的目录只 log 跳过（网络盘 / 权限
//! 变化不应拖垮命令）。实例被删除后其条目会残留监视（事件无消费者，无害），
//! 与 auto_organize 的实例残留特性一致。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::{Event, RecursiveMode, Watcher};
use serde::Deserialize;
use tauri::Emitter;

/// 同路径去抖窗口（与 auto_organize 同款 500ms）。
const DEBOUNCE_MS: u64 = 500;
/// 单次广播的变更条数上限：溢出部分丢弃——前端另有 60s 周期复检全量对账
/// 。
const MAX_CHANGES_PER_EMIT: usize = 128;

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutWatchConfig {
    pub instance_id: String,
    /// 本实例条目的目标路径全集（非 url 条目；空 = 不监视）。
    #[serde(default)]
    pub paths: Vec<String>,
}

/// 广播给前端的单条变更。type 用字符串字面量（与前端 WatchChange 对齐）。
pub enum WatchChange {
    Renamed { from: String, to: String },
    Removed { path: String },
    Modified { path: String },
}

impl WatchChange {
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            WatchChange::Renamed { from, to } => {
                serde_json::json!({ "type": "renamed", "from": from, "to": to })
            }
            WatchChange::Removed { path } => serde_json::json!({ "type": "removed", "path": path }),
            WatchChange::Modified { path } => {
                serde_json::json!({ "type": "modified", "path": path })
            }
        }
    }
}

/// 路径归一（比较用）：正斜杠统一反斜杠 + 小写。
fn norm_path(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

/// 提取条目路径的父目录（监视目标，归一到小写反斜杠以便并集去重）：
/// 相对路径 / 空路径 / 无父目录返回 None。
pub fn parent_dir_of(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parent = Path::new(trimmed).parent()?;
    if parent.as_os_str().is_empty() {
        return None;
    }
    Some(norm_path(&parent.to_string_lossy()))
}

/// 监视集指纹：归一后的父目录并集逐条哈希再按序折叠（排序后顺序确定）。
fn parents_hash(parents: &BTreeSet<String>) -> u64 {
    let mut normed: Vec<String> = parents.iter().map(|p| norm_path(p)).collect();
    normed.sort();
    let mut h: u64 = 0xcbf29ce484222325;
    for p in normed {
        for b in p.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h ^= 0x1;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 事件分类（纯函数，可单测）：Rename Both → 改名（old→new）；Remove → 删除；
/// 内容/元数据/其它修改 → modified（图标过期）；Create 不关心（入列走
/// auto-organize，引用侧无感）。
pub fn classify_event(kind: &EventKind, paths: &[PathBuf]) -> Vec<WatchChange> {
    let to_str = |p: &Path| p.to_str().map(str::to_string);
    match kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if paths.len() >= 2 {
                match (to_str(&paths[0]), to_str(&paths[1])) {
                    (Some(from), Some(to)) => {
                        return vec![WatchChange::Renamed { from, to }];
                    }
                    _ => return Vec::new(),
                }
            }
            Vec::new()
        }
        EventKind::Remove(_) => paths
            .iter()
            .filter_map(|p| to_str(p).map(|path| WatchChange::Removed { path }))
            .collect(),
        EventKind::Modify(
            ModifyKind::Any | ModifyKind::Data(_) | ModifyKind::Metadata(_) | ModifyKind::Other,
        ) => paths
            .iter()
            .filter_map(|p| to_str(p).map(|path| WatchChange::Modified { path }))
            .collect(),
        _ => Vec::new(),
    }
}

/// watcher 本体由管理表持有：替换/移除时 drop watcher → channel 断连 →
/// 接收线程退出（与 auto_organize 相同的停止语义）。seq 是落座这次 apply 的
/// 世代号（APPLY_SEQ）：并发的旧快照不得覆盖新落座者。
struct WatchEntry {
    _watcher: notify::RecommendedWatcher,
    hash: u64,
    seq: u64,
}

static WATCH: Mutex<Option<WatchEntry>> = Mutex::new(None);
/// 实例 id → 归一目标路径全集（upsert 语义的管理表；单 watcher 只监视
/// 全实例父目录并集，此表只为「未提及的实例保持不动」记账）。
static INSTANCE_PATHS: Mutex<std::collections::BTreeMap<String, BTreeSet<String>>> =
    Mutex::new(std::collections::BTreeMap::new());
static DEBOUNCE: Mutex<Option<std::collections::HashMap<String, Instant>>> = Mutex::new(None);
static APPLY_SEQ: AtomicU64 = AtomicU64::new(0);

/// 按实例 upsert 路径表（纯函数，可单测）：paths 为空的实例移除，其余以
/// 归一路径集写入；表内容有变化返回 true（无变化的 apply 幂等）。
fn upsert_instance_paths(
    map: &mut std::collections::BTreeMap<String, BTreeSet<String>>,
    configs: &[ShortcutWatchConfig],
) -> bool {
    let mut changed = false;
    for c in configs {
        if c.paths.is_empty() {
            changed |= map.remove(&c.instance_id).is_some();
            continue;
        }
        let set: BTreeSet<String> = c.paths.iter().map(|p| norm_path(p)).collect();
        if map.get(&c.instance_id) != Some(&set) {
            map.insert(c.instance_id.clone(), set);
            changed = true;
        }
    }
    changed
}

/// 全实例目标路径的父目录并集（纯函数，可单测）。
fn union_parents(map: &std::collections::BTreeMap<String, BTreeSet<String>>) -> BTreeSet<String> {
    let mut parents = BTreeSet::new();
    for paths in map.values() {
        for p in paths {
            if let Some(dir) = parent_dir_of(p) {
                parents.insert(dir);
            }
        }
    }
    parents
}

fn spawn_watcher(
    app: &tauri::AppHandle,
    parents: &BTreeSet<String>,
) -> Result<notify::RecommendedWatcher, String> {
    let app = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher =
        notify::recommended_watcher(tx).map_err(|e| format!("创建监视器失败：{e}"))?;
    let mut watched = 0usize;
    for dir in parents {
        match watcher.watch(Path::new(dir), RecursiveMode::NonRecursive) {
            Ok(()) => watched += 1,
            Err(e) => log::warn!("快捷方式监听跳过目录（{dir}）：{e}"),
        }
    }
    if watched == 0 {
        return Err("没有可监视的目录".into());
    }
    std::thread::spawn(move || {
        for ev in rx {
            // notify 的运行期错误（目录失效/IO 异常）不再无痕丢弃——否则
            // 引用侧完全失明，只剩 60s 复检兜底却不知道该看哪里。
            let ev = match ev {
                Ok(ev) => ev,
                Err(e) => {
                    log::warn!("快捷方式监听错误：{e}");
                    continue;
                }
            };
            let changes = classify_event(&ev.kind, &ev.paths);
            if changes.is_empty() {
                continue;
            }
            let mut out: Vec<serde_json::Value> = Vec::with_capacity(changes.len());
            for change in changes {
                // 同路径去抖：改名/删除/修改在窗口内的重复事件只发一次。
                let key = match &change {
                    WatchChange::Renamed { from, .. } => from.clone(),
                    WatchChange::Removed { path } => path.clone(),
                    WatchChange::Modified { path } => path.clone(),
                };
                let now = Instant::now();
                {
                    let mut guard = DEBOUNCE.lock().unwrap_or_else(|p| p.into_inner());
                    let map = guard.get_or_insert_with(std::collections::HashMap::new);
                    if let Some(t) = map.get(&key) {
                        if now.duration_since(*t) < Duration::from_millis(DEBOUNCE_MS) {
                            continue;
                        }
                    }
                    map.insert(key.clone(), now);
                    if map.len() > 512 {
                        map.retain(|_, t| now.duration_since(*t) < Duration::from_secs(5));
                    }
                }
                // 图标磁盘缓存失效（扩面）：此前只清 Modified 的新路径——
                // Renamed/Removed 后旧路径的缓存条目留盘，只能等 LRU 逐出；
                // 缓存键即归一路径哈希，把旧路径一并删掉。
                match &change {
                    WatchChange::Modified { path } => {
                        crate::files::invalidate_icon_cache(&app, path);
                    }
                    WatchChange::Renamed { from, .. } => {
                        crate::files::invalidate_icon_cache(&app, from);
                    }
                    WatchChange::Removed { path } => {
                        crate::files::invalidate_icon_cache(&app, path);
                    }
                }
                out.push(change.to_json());
                if out.len() >= MAX_CHANGES_PER_EMIT {
                    break;
                }
            }
            if out.is_empty() {
                continue;
            }
            let _ = app.emit(
                "shortcuts-watch:change",
                serde_json::json!({ "changes": out }),
            );
        }
    });
    Ok(watcher)
}

/// 按实例 id upsert 监视集（未提及的实例保持不动——调用方只送自己这一份，
/// 多实例互不踩踏）；watcher 仍单实例，监视全实例父目录并集（哈希未变跳过
/// 拆建）。paths 为空 = 移除该实例的条目；全并集为空 = 停止监视。
/// 返回 (监视中的父目录数, 本次是否重建)。
#[tauri::command]
pub fn apply_shortcut_watch(
    window: tauri::Window,
    app: tauri::AppHandle,
    configs: Vec<ShortcutWatchConfig>,
) -> Result<(usize, usize), String> {
    crate::require_trusted(&window)?;
    let my_seq = APPLY_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    // 单锁内完成 upsert + 并集快照：并发 apply 各自拿到自己 upsert 后的
    // 一致快照。快照 → 落座之间另一路 apply 可能带着更大的并集先行落座
    // （INSTANCE_PATHS 锁与 WATCH 锁不原子），此时旧快照不得回退覆盖：
    // 小并集 watcher 落在最后会让另一实例的路径漏监视到它的下一次 apply。
    // 落座前比对世代号——序列更晚者已写入就放弃本次存储。
    let parents = {
        let mut guard = INSTANCE_PATHS.lock().unwrap_or_else(|p| p.into_inner());
        upsert_instance_paths(&mut guard, &configs);
        union_parents(&guard)
    };
    let hash = parents_hash(&parents);
    {
        let guard = WATCH.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = guard.as_ref() {
            if entry.hash == hash {
                let count = parents.len();
                return Ok((count, 0));
            }
        }
    }
    {
        let mut guard = WATCH.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = guard.as_ref() {
            if entry.seq > my_seq {
                return Ok((parents.len(), 0));
            }
        }
        // 并集为空 = 停止监视。
        if parents.is_empty() {
            *guard = None;
            return Ok((0, 1));
        }
        let watcher = spawn_watcher(&app, &parents)?;
        *guard = Some(WatchEntry {
            _watcher: watcher,
            hash,
            seq: my_seq,
        });
    }
    Ok((parents.len(), 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(v: &[&str]) -> Vec<PathBuf> {
        v.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn classify_rename_both() {
        let kind = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        let out = classify_event(&kind, &paths(&["C:/a/old.exe", "C:/a/new.exe"]));
        assert_eq!(out.len(), 1);
        match &out[0] {
            WatchChange::Renamed { from, to } => {
                assert_eq!(from, "C:/a/old.exe");
                assert_eq!(to, "C:/a/new.exe");
            }
            _ => panic!("应为 renamed"),
        }
        // 单路径的 Both（畸形事件）不产出。
        assert!(classify_event(&kind, &paths(&["C:/a/old.exe"])).is_empty());
    }

    #[test]
    fn classify_remove_and_modify() {
        let rm = EventKind::Remove(notify::event::RemoveKind::Any);
        let out = classify_event(&rm, &paths(&["C:/a/gone.exe"]));
        assert!(
            matches!(out.as_slice(), [WatchChange::Removed { path }] if path == "C:/a/gone.exe")
        );

        let data = EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Any));
        let out = classify_event(&data, &paths(&["C:/a/x.exe"]));
        assert!(matches!(out.as_slice(), [WatchChange::Modified { path }] if path == "C:/a/x.exe"));

        let meta = EventKind::Modify(ModifyKind::Metadata(notify::event::MetadataKind::Any));
        assert_eq!(classify_event(&meta, &paths(&["C:/a/x.exe"])).len(), 1);
    }

    #[test]
    fn classify_create_ignored() {
        let create = EventKind::Create(notify::event::CreateKind::File);
        assert!(classify_event(&create, &paths(&["C:/a/new.txt"])).is_empty());
    }

    #[test]
    fn parent_dir_extraction() {
        // 归一输出：小写 + 反斜杠（并集去重与哈希都依赖这一点）。
        assert_eq!(parent_dir_of("C:/a/b/c.exe").as_deref(), Some("c:\\a\\b"));
        assert_eq!(
            parent_dir_of("C:\\A\\B\\c.exe").as_deref(),
            Some("c:\\a\\b")
        );
        assert_eq!(parent_dir_of("C:\\file.txt").as_deref(), Some("c:\\"));
        assert_eq!(parent_dir_of(""), None);
        assert_eq!(parent_dir_of("   "), None);
    }

    #[test]
    fn parents_hash_ignores_order_and_case() {
        let mut a = BTreeSet::new();
        a.insert("C:/Apps".into());
        a.insert("C:/Docs".into());
        let mut b = BTreeSet::new();
        b.insert("C:/docs".into());
        b.insert("C:\\apps".into());
        assert_eq!(parents_hash(&a), parents_hash(&b));
        let mut c = a.clone();
        c.insert("C:/Other".into());
        assert_ne!(parents_hash(&a), parents_hash(&c));
    }

    fn cfg(id: &str, paths: &[&str]) -> ShortcutWatchConfig {
        ShortcutWatchConfig {
            instance_id: id.into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn upsert_keeps_unmentioned_instances() {
        // 多实例互不踩踏的核心语义：实例 2 的 apply 不清掉实例 1 的记账。
        let mut map = std::collections::BTreeMap::new();
        assert!(upsert_instance_paths(
            &mut map,
            &[cfg("w1", &["C:/a/x.exe"])]
        ));
        assert!(!upsert_instance_paths(
            &mut map,
            &[cfg("w1", &["C:/A/X.EXE"])]
        )); // 幂等
        assert!(upsert_instance_paths(
            &mut map,
            &[cfg("w2", &["C:/b/y.exe"])]
        ));
        assert!(map.contains_key("w1") && map.contains_key("w2"));
        // paths 空 = 移除该实例（只移自己）。
        assert!(upsert_instance_paths(&mut map, &[cfg("w1", &[])]));
        assert!(!map.contains_key("w1"));
        assert!(map.contains_key("w2"));
        assert!(!upsert_instance_paths(&mut map, &[cfg("w1", &[])])); // 再移幂等
    }

    #[test]
    fn union_parents_across_instances() {
        let mut map = std::collections::BTreeMap::new();
        assert!(upsert_instance_paths(
            &mut map,
            &[cfg("w1", &["C:/a/x.exe", "C:/a/y.exe"])]
        ));
        assert!(upsert_instance_paths(
            &mut map,
            &[cfg("w2", &["C:/A/z.exe"])]
        ));
        let parents = union_parents(&map);
        assert_eq!(parents.len(), 1); // 同目录归一并集去重
        assert!(parents.contains("c:\\a"));
        assert!(upsert_instance_paths(
            &mut map,
            &[cfg("w2", &["C:/b/w.exe"])]
        ));
        let parents = union_parents(&map);
        assert_eq!(parents.len(), 2);
        assert!(parents.contains("c:\\b"));
    }
}
