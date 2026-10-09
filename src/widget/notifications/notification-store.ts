import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { invoke, isTauri, currentWindowLabel } from "../../lib/tauri";
import { NOTIFICATION_RECORDED_EVENT } from "../../lib/notifications";
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";

/**
 * 通知历史 store（DOCK）：通知中心小组件与 dock 通知磁贴共用的内存事实来源。
 *
 * 数据流：SQLite（权威，v7 表）→ hydrate 拉最近 200 条 → 内存列表（新→旧）；
 * 新通知经 lib/notifications 留档后以 DOM 事件（本窗口）+ Tauri 事件
 * `app:notification`（其它窗口）推入，按 id 去重（发送窗口两路都会收到）。
 * 删除/清空为乐观更新 + fire-and-forget IPC，并把被删记录放进 undo 槽供
 * 「恢复」；恢复走 restore_notification 原样回插。浏览器开发模式无 IPC，
 * 仅内存工作（页面刷新即空）。
 *
 * 跨窗口一致性：新增 / 全部已读之外，删除 / 清空 / 恢复同样以
 * `app:notification-deleted` / `-cleared` / `-restored` 广播——多屏 dock
 * 面板与画布常驻卡并存时，一窗的删除不再让另一窗的角标与列表永久陈旧
 * （画布卡挂载后不会二次 hydrate）。载荷带 origin（窗口 label），收到
 * 自己发的事件直接跳过；对端只改本地内存，不回发 IPC（避免回环）。
 */

/** 内存上限：列表面板只消费最近一两屏，历史全量留在 SQLite。 */
const MEMORY_CAP = 200;
/** undo 槽保留时长：超时后不再提供恢复（UI 侧倒计时同步消隐）。 */
export const UNDO_WINDOW_MS = 6000;

export type UndoEntry = {
  /** 被删记录（单条滑删 = 1 条；一键清除 = 整批）。 */
  records: NotificationRecord[];
  /** 生成时间戳，供 UI 判断是否过期。 */
  at: number;
};

type NotificationState = {
  records: NotificationRecord[];
  hydrated: boolean;
  undo: UndoEntry | null;
  /** 首次读取（Tauri 走 IPC；重复调用幂等）。 */
  hydrate(): Promise<void>;
  /** 推入一条新记录（去重、置顶、裁到内存上限）。 */
  applyRecord(record: NotificationRecord): void;
  /** 乐观删除单条并留 undo。 */
  deleteRecord(id: string): void;
  /** 乐观删除一批（整组滑删）并合并为一个 undo 槽。 */
  deleteRecords(ids: string[]): void;
  /** 一键清除并留整批 undo。 */
  clearAll(): void;
  /** 恢复 undo 槽里的记录（IPC 回插），随后清空槽。 */
  restoreDeleted(): void;
  /** 放弃 undo（超时 / 用户忽略）。 */
  dismissUndo(): void;
  /** 全部标已读（通知中心打开即视为已读）。 */
  markAllRead(): void;
};

let hydrating: Promise<void> | null = null;

/** 跨窗口同步事件的载荷基座：origin = 发起窗口 label，对端据此跳过自己的回声。 */
type SyncOrigin = { origin: string };

/** 本窗 label（浏览器模式无 label 时用占位符，broadcast/fromRemote 两侧一致即可）。 */
function selfLabel(): string {
  return currentWindowLabel() ?? "unknown-window";
}

/** 广播一条跨窗口同步事件（fire-and-forget；浏览器模式无操作）。 */
function broadcastSync(event: string, payload: SyncOrigin & Record<string, unknown>): void {
  if (!isTauri()) return;
  void loadEventApi().then(({ emit }) => emit(event, payload).catch(() => {}));
}

/** 收到远端同步事件时的第一道闸：自己发的回声直接忽略。 */
function fromRemote(origin: unknown): boolean {
  return typeof origin === "string" && origin !== selfLabel();
}

/* event API 的动态 import 缓存：浏览器本就会缓存模块，这里侧重点是消除
   重复 import() 的解析抖动——测试环境下源文件里连续的动态 import 可能解析
   出未 mock 的真实模块（真 emit 在 jsdom 里静默失败），首载定型后全窗口
   复用同一 promise，广播行为在 prod 与 vitest 下一致。 */
let eventApi: Promise<typeof import("@tauri-apps/api/event")> | null = null;
function loadEventApi(): Promise<typeof import("@tauri-apps/api/event")> {
  eventApi ??= import("@tauri-apps/api/event");
  return eventApi;
}

function dedupeUnshift(list: NotificationRecord[], record: NotificationRecord): NotificationRecord[] {
  if (list.some((r) => r.id === record.id)) return list;
  const next = [record, ...list];
  return next.length > MEMORY_CAP ? next.slice(0, MEMORY_CAP) : next;
}

export const useNotificationStore = create<NotificationState>()(
  subscribeWithSelector((set, get) => ({
    records: [],
    hydrated: false,
    undo: null,

    hydrate: () => {
      if (hydrating) return hydrating;
      if (!isTauri()) {
        set({ hydrated: true });
        hydrating = Promise.resolve();
        return hydrating;
      }
      hydrating = invoke<NotificationRecord[]>("list_notifications", { limit: MEMORY_CAP })
        .then((rows) => {
          // 读库期间可能已有实时推入的记录：合并而非覆盖（实时项优先）。
          const live = get().records;
          const merged = [...live];
          for (const r of rows) if (!merged.some((x) => x.id === r.id)) merged.push(r);
          merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
          set({ records: merged.slice(0, MEMORY_CAP), hydrated: true });
        })
        .catch((err) => {
          console.warn("[notifications] hydrate failed:", err);
          set({ hydrated: true });
        });
      return hydrating;
    },

    applyRecord: (record) => {
      set({ records: dedupeUnshift(get().records, record) });
    },

    deleteRecord: (id) => {
      get().deleteRecords([id]);
    },

    deleteRecords: (ids) => {
      const { records } = get();
      const wanted = new Set(ids);
      const targets = records.filter((r) => wanted.has(r.id));
      if (targets.length === 0) return;
      set({ records: records.filter((r) => !wanted.has(r.id)), undo: { records: targets, at: Date.now() } });
      if (isTauri()) {
        for (const r of targets) {
          void invoke("delete_notification", { id: r.id }).catch((e) =>
            console.warn("[notifications] delete failed:", e)
          );
        }
        broadcastSync("app:notification-deleted", { origin: selfLabel(), ids: targets.map((r) => r.id) });
      }
    },

    clearAll: () => {
      const { records } = get();
      if (records.length === 0) return;
      set({ records: [], undo: { records, at: Date.now() } });
      if (isTauri()) {
        void invoke("clear_notifications").catch((e) => console.warn("[notifications] clear failed:", e));
        broadcastSync("app:notification-cleared", { origin: selfLabel() });
      }
    },

    restoreDeleted: () => {
      const { undo, records } = get();
      if (!undo) return;
      let next = records;
      // 逆序回插保证多条恢复后仍是新→旧（dedupeUnshift 逐条置顶）。
      for (const r of [...undo.records].reverse()) next = dedupeUnshift(next, r);
      next = [...next].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      set({ records: next, undo: null });
      if (isTauri()) {
        for (const record of undo.records) {
          void invoke("restore_notification", { record }).catch((e) =>
            console.warn("[notifications] restore failed:", e)
          );
        }
        broadcastSync("app:notification-restored", { origin: selfLabel(), records: undo.records });
      }
    },

    dismissUndo: () => {
      if (get().undo) set({ undo: null });
    },

    markAllRead: () => {
      const { records } = get();
      if (!records.some((r) => !r.read)) return;
      set({ records: records.map((r) => (r.read ? r : { ...r, read: true })) });
      if (isTauri()) {
        void invoke("read_all_notifications").catch((e) => console.warn("[notifications] read-all failed:", e));
        void loadEventApi().then(({ emit }) => emit("app:notification-read").catch(() => {}));
      }
    }
  }))
);

/** 未读数（dock 磁贴角标）。 */
export function selectUnreadCount(s: { records: NotificationRecord[] }): number {
  let n = 0;
  for (const r of s.records) if (!r.read) n++;
  return n;
}

/* ---- 实时推入：本窗口 DOM 事件 + 跨窗口 Tauri 事件（模块级只挂一次） ---- */

let listenersInstalled = false;

/**
 * 安装实时监听（幂等）。由通知中心 / dock 挂载时调用；不主动卸载——两者
 * 都可能在同一窗口反复挂卸，模块级监听贯穿窗口生命周期成本可忽略。
 */
export function ensureNotificationListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  window.addEventListener(NOTIFICATION_RECORDED_EVENT, (e) => {
    const detail = (e as CustomEvent<NotificationRecord>).detail;
    if (detail && typeof detail.id === "string") useNotificationStore.getState().applyRecord(detail);
  });
  if (!isTauri()) return;
  void loadEventApi().then(({ listen }) => {
    void listen<NotificationRecord>("app:notification", (e) => {
      if (e.payload && typeof e.payload.id === "string") useNotificationStore.getState().applyRecord(e.payload);
    }).catch(() => {});
    // 另一窗口标全部已读：本地同步翻转 read 位，不再回写 IPC（避免回环）。
    void listen("app:notification-read", () => {
      const { records } = useNotificationStore.getState();
      if (records.some((r) => !r.read)) {
        useNotificationStore.setState({ records: records.map((r) => (r.read ? r : { ...r, read: true })) });
      }
    }).catch(() => {});
    /* 跨窗口删除：对端滑删/整组删后本地列表同步移除。不动本地 undo 槽
       （对端删的不是本窗的操作，恢复语义归对端；万一恢复也经 -restored 回流）。 */
    void listen<SyncOrigin & { ids?: unknown }>("app:notification-deleted", (e) => {
      if (!fromRemote(e.payload?.origin) || !Array.isArray(e.payload?.ids)) return;
      const ids = new Set(e.payload.ids as string[]);
      const { records } = useNotificationStore.getState();
      if (records.some((r) => ids.has(r.id))) {
        useNotificationStore.setState({ records: records.filter((r) => !ids.has(r.id)) });
      }
    }).catch(() => {});
    /* 跨窗口清空：本地清列 + 作废 undo 槽（DB 已空，恢复槽会把别窗刚清掉
       的记录复活，不该再提供）。 */
    void listen<SyncOrigin>("app:notification-cleared", (e) => {
      if (!fromRemote(e.payload?.origin)) return;
      const st = useNotificationStore.getState();
      if (st.records.length === 0 && !st.undo) return;
      useNotificationStore.setState({ records: [], undo: null });
    }).catch(() => {});
    /* 跨窗口恢复：按 id 去重回插（与实时新增同一入口的排序纪律）。 */
    void listen<SyncOrigin & { records?: unknown }>("app:notification-restored", (e) => {
      if (!fromRemote(e.payload?.origin) || !Array.isArray(e.payload?.records)) return;
      let next = useNotificationStore.getState().records;
      let changed = false;
      for (const r of e.payload.records as NotificationRecord[]) {
        if (!r || typeof r.id !== "string") continue;
        const before = next;
        next = dedupeUnshift(next, r);
        if (next !== before) changed = true;
      }
      if (changed) {
        next = [...next].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        useNotificationStore.setState({ records: next });
      }
    }).catch(() => {});
  });
}
