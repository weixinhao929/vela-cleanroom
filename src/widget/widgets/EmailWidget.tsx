/**
 * 邮件小组件：IMAP 轮询未读（Rust 侧实现协议），展示最近邮件列表，
 * 点击经系统默认客户端打开；密码经 DPAPI 加密存于本地数据库
 * （email:accounts 键），前端只持空掩码、绝不回传明文，不入 localStorage。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCheck, ExternalLink, Inbox, Lock, Mail, MailOpen, RefreshCw, Trash2 } from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { withRetry } from "../../lib/retry";
import { useWidgetConfig } from "../widget-config";
import { useWidgetExpand } from "../expand-store";
import { useT, appLocale } from "../../i18n-lite";
import { sourceNotify } from "../../lib/notifications";
import { openContextMenu, type ContextMenuItem } from "../../components/ContextMenu";
import { useSafeTimeout } from "../../lib/use-safe-timeout";

type Email = {
  id: string;
  account: string;
  from: string;
  subject: string;
  preview: string;
  time: string;
  unread: boolean;
};

type EmailAccount = {
  server: string;
  port: number;
  email: string;
  password: string;
  use_tls: boolean;
};

const DEMO: Email[] = [
  {
    id: "1",
    account: "工作",
    from: "设计团队",
    subject: "本周设计评审会议",
    preview: "请确认周四上午 10 点的设计评审…",
    time: "09:42",
    unread: true
  },
  {
    id: "2",
    account: "个人",
    from: "Steam",
    subject: "您的愿望清单有商品降价",
    preview: "您关注的游戏正在促销…",
    time: "08:15",
    unread: true
  },
  {
    id: "3",
    account: "工作",
    from: "财务部",
    subject: "6 月报销单已通过",
    preview: "您的报销申请已审核通过…",
    time: "昨天",
    unread: false
  },
  {
    id: "4",
    account: "个人",
    from: "GitHub",
    subject: "[PR] 合并请求已合并",
    preview: "您的 pull request 已被合并…",
    time: "昨天",
    unread: false
  }
];
/** 演示数据仅在浏览器开发模式（!isTauri）使用。桌面版无账户时显示空态引导，
 * 不再用捏造邮件冒充真实收件箱。 */
const demoMode = !isTauri();

/** 邮箱域名 → Webmail 收件箱页；未收录域名回退到 https://域名。 */
const WEBMAIL_MAP: [string, string][] = [
  ["gmail.com", "https://mail.google.com/mail/u/0/#inbox"],
  ["googlemail.com", "https://mail.google.com/mail/u/0/#inbox"],
  ["outlook.com", "https://outlook.live.com/mail/0/inbox"],
  ["hotmail.com", "https://outlook.live.com/mail/0/inbox"],
  ["live.com", "https://outlook.live.com/mail/0/inbox"],
  ["qq.com", "https://mail.qq.com/"],
  ["foxmail.com", "https://mail.qq.com/"],
  ["163.com", "https://mail.163.com/"],
  ["126.com", "https://mail.126.com/"],
  ["yeah.net", "https://mail.yeah.net/"],
  ["sina.com", "https://mail.sina.com.cn/"],
  ["icloud.com", "https://www.icloud.com/mail/"],
  ["yahoo.com", "https://mail.yahoo.com/"]
];

function webmailUrl(addr: string): string {
  const domain = (addr.split("@")[1] || "").toLowerCase();
  if (!domain) return "";
  for (const [d, url] of WEBMAIL_MAP) {
    if (domain === d || domain.endsWith(`.${d}`)) return url;
  }
  return `https://${domain}`;
}

/** RFC 822 日期 → 友好时间：今天显示 HH:mm，一周内显示星期，更早显示日期。
 *  经 Intl.DateTimeFormat 跟随应用语言（appLocale，约定）。 */
function friendlyTime(raw: string, tr: (s: string) => string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const now = new Date();
  const locale = appLocale();
  if (d.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 1) return tr("昨天");
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(d);
}

/**
 * Unified inbox widget with multi-account real IMAP support ().
 * In Tauri mode, all configured accounts are polled in parallel and merged
 * into one inbox; falls back to demo data in browser mode or when no account
 * is configured.
 */

/** 「全部」页签的内部哨兵值（此前用翻译串当值，切语言后 matchFilter
 * 对不上、列表被清空——哨兵与语言无关）。 */
const ALL_TAB = "__all__";

/** 模块级已见邮件基线（此前 per-instance ref，卡片+沉浸页双实例各自
 * 建基线 → 同一封新邮件双通知）。所有实例共享，首个拉取者建基线。 */
let sharedSeenIds: Set<string> | null = null;

export function EmailWidget({ instanceId, paused = false }: { instanceId: string; paused?: boolean }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [filter, setFilter] = useState<string>(ALL_TAB);
  const [emails, setEmails] = useState<Email[]>(() => (demoMode ? DEMO : []));
  const [refreshing, setRefreshing] = useState(false);
  // 新邮件一次性高亮 + 删除退场（对齐书签/习惯的 w-item-out 语言）。
  const [newMailKeys, setNewMailKeys] = useState<Set<string>>(new Set());
  const [removingKeys, setRemovingKeys] = useState<Set<string>>(new Set());
  // 删除会 EXPUNGE 服务器邮件：右键菜单内两段式确认（对齐回收站 #71）。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { config } = useWidgetConfig(instanceId);
  const refreshInterval = Math.max(1, (config.refreshInterval as number) || 5) * 60 * 1000;
  const showPreview = (config.showPreview as boolean) !== false;
  const showTime = config.showTime !== false;
  const maxItems = Math.min(50, Math.max(5, (config.maxItems as number) || 20));
  const showUnreadOnly = config.showUnreadOnly === true;
  const notifyNewMail = config.notifyNewMail !== false;
  const dndHour = typeof config.doNotDisturbHour === "number" ? config.doNotDisturbHour : -1;

  /** 定时免打扰：指定小时内不自动检查、不推送新邮件通知。 */
  const dndActive = useCallback(() => dndHour >= 0 && new Date().getHours() === dndHour, [dndHour]);

  const fetchSeq = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** 已见邮件 id 集合（`${账户}|${UID}`），首次拉取只建基线不通知。
   *  基线为模块级共享（sharedSeenIds）——沉浸页/多实例不再各自建基线
   *  导致同一封新邮件重复通知。 */
  // Load saved accounts on mount (Tauri only)
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<EmailAccount[]>("load_email_accounts")
      .then((saved) => {
        if (cancelled) return;
        if (saved && saved.length > 0) setAccounts(saved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchReal = useCallback(() => {
    if (!isTauri() || accounts.length === 0) return;
    const seq = ++fetchSeq.current;
    setRefreshing(true);
    setError(null);
    // 多账户并行拉取；单账户失败不影响其余账户，错误聚合展示。
    // 审计修复：Promise.all 一败全败（与注释矛盾、failures 死代码）→
    // allSettled，成功账户照常落地，失败账户聚合进错误提示。
    Promise.allSettled(
      accounts.map((acct) =>
        withRetry(
          () =>
            invoke<{ id: string; from: string; subject: string; preview: string; date: string; unread: boolean }[]>(
              "fetch_emails",
              { account: acct, limit: maxItems }
            ),
          { retries: 2, baseMs: 1200 }
        ).then((msgs) => ({ acct, msgs }))
      )
    )
      .then((results) => {
        if (!aliveRef.current || seq !== fetchSeq.current) return;
        const mapped: Email[] = [];
        const failures: string[] = [];
        for (const r of results) {
          if (r.status === "rejected") {
            failures.push(String(r.reason instanceof Error ? r.reason.message : r.reason));
            continue;
          }
          for (const m of r.value.msgs) {
            mapped.push({
              id: m.id,
              account: r.value.acct.email,
              from: m.from,
              subject: m.subject,
              preview: m.preview,
              time: friendlyTime(m.date, tr),
              unread: m.unread
            });
          }
        }
        setEmails(mapped);
        setError(
          failures.length === 0
            ? null
            : failures.length < accounts.length
              ? `${tr("部分账户拉取失败：")}${failures.join("；")}`
              : `${tr("全部账户拉取失败：")}${failures.join("；")}`
        );

        // 新邮件通知：与上次快照差集（未读 && 未见过的 UID）。
        const freshKeys = new Set<string>();
        if (notifyNewMail && !dndActive()) {
          const prev = sharedSeenIds;
          if (prev) {
            for (const m of mapped) {
              const key = `${m.account}|${m.id}`;
              if (m.unread && !prev.has(key)) {
                freshKeys.add(key);
                void sourceNotify("email", tr("新邮件"), `${m.from}：${m.subject}`);
              }
            }
          }
        }
        const next = new Set<string>();
        for (const m of mapped) next.add(`${m.account}|${m.id}`);
        sharedSeenIds = next;

        // 新邮件行一次性高亮（accent 淡出），3s 后回归常态。
        if (freshKeys.size > 0) {
          setNewMailKeys(freshKeys);
          safeTimeout(() => {
            if (aliveRef.current) setNewMailKeys(new Set());
          }, 3000);
        }

        setRefreshed(true);
        safeTimeout(() => {
          if (aliveRef.current) setRefreshed(false);
        }, 1200);
      })
      .catch((e) => {
        if (!aliveRef.current || seq !== fetchSeq.current) return;
        setError(String(e));
        setRefreshed(false);
      })
      .finally(() => {
        if (aliveRef.current && seq === fetchSeq.current) setRefreshing(false);
      });
  }, [accounts, maxItems, notifyNewMail, dndActive, tr, safeTimeout]);

  const refresh = useCallback(() => {
    if (isTauri() && accounts.length > 0) {
      fetchReal();
      return;
    }
    setRefreshing(true);
    safeTimeout(() => {
      if (!aliveRef.current) return;
      setRefreshing(false);
      setRefreshed(true);
      safeTimeout(() => setRefreshed(false), 1200);
    }, 600);
  }, [accounts.length, fetchReal, safeTimeout]);

  // Auto-refresh on the configured interval (default 5 minutes).
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  /* 本实例的沉浸页展开时，画布卡片暂停轮询——沉浸页里的 EmailWidget
     副本（paused=!active）在 active 时负责拉取；否则双实例并行对全部账户
     各建一条 TLS+IMAP 会话（Gmail 类并发受限的服务器会互相挤掉连接）。 */
  const expandPaused = useWidgetExpand((s) => s.expandedId === instanceId);
  const effectivePaused = paused || expandPaused;
  useEffect(() => {
    const id = window.setInterval(() => {
      // 不可见即不拉（桌面层被隐藏时不再对全部账户发 IMAP 请求，与
      // system-stats「不可见即不花钱」同原则）；恢复可见立即补一拉。
      // paused：沉浸页收起（active=false）时停轮询——遮罩 display:none
      // 不改 document.hidden，须显式门控。
      if (!effectivePaused && !dndActive() && !document.hidden) refreshRef.current();
    }, refreshInterval);
    const onVis = () => {
      if (!effectivePaused && !document.hidden && !dndActive()) refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshInterval, dndActive, effectivePaused]);

  useEffect(() => {
    if (accounts.length > 0) fetchReal();
  }, [accounts, fetchReal]);

  const markAllRead = () => {
    setEmails((es) => es.map((e) => (e.unread ? { ...e, unread: false } : e)));
    if (isTauri() && accounts.length > 0) {
      const targets = emails.filter((e) => e.unread && e.account.includes("@"));
      const byAddr = new Map(accounts.map((a) => [a.email, a]));
      for (const t of targets) {
        const acct = byAddr.get(t.account);
        if (acct) void invoke("mark_email_seen", { account: acct, uid: t.id }).catch(() => {});
      }
    }
  };

  const markRead = (email: Email, unread: boolean) => {
    setEmails((es) => es.map((e) => (e.id === email.id && e.account === email.account ? { ...e, unread } : e)));
    if (unread === false && isTauri()) {
      const acct = accounts.find((a) => a.email === email.account);
      if (acct) void invoke("mark_email_seen", { account: acct, uid: email.id }).catch(() => {});
    }
  };

  /** 删除回写：服务器 EXPUNGE + 本地移除；演示数据仅本地删除。 */
  const removeEmail = (email: Email) => {
    const key = `${email.account}-${email.id}`;
    setRemovingKeys((s) => new Set(s).add(key));
    safeTimeout(() => {
      setRemovingKeys((s) => {
        const nx = new Set(s);
        nx.delete(key);
        return nx;
      });
      setEmails((es) => es.filter((e) => !(e.id === email.id && e.account === email.account)));
      if (isTauri()) {
        const acct = accounts.find((a) => a.email === email.account);
        if (acct) void invoke("delete_email", { account: acct, uid: email.id }).catch(() => {});
      }
    }, 200);
  };

  /** 点击打开：跳账户对应的 Webmail（演示数据仅切换已读态）。 */
  const openMail = (email: Email) => {
    if (email.account.includes("@")) {
      const url = webmailUrl(email.account);
      if (url && isTauri()) {
        void invoke("open_path", { path: url }).catch(() => {});
        markRead(email, false);
        return;
      }
    }
    markRead(email, !email.unread);
  };

  /** 右键菜单项；confirming 时删除项 morph 为 danger「再次点击确认删除」。 */
  const buildMailMenu = (
    pos: { clientX: number; clientY: number },
    email: Email,
    confirming: boolean
  ): ContextMenuItem[] => [
    {
      label: tr("打开邮件"),
      icon: <ExternalLink size={14} />,
      onSelect: () => openMail(email)
    },
    {
      label: email.unread ? tr("标为已读") : tr("标为未读"),
      icon: email.unread ? <MailOpen size={14} /> : <Mail size={14} />,
      onSelect: () => markRead(email, !email.unread)
    },
    { type: "separator" as const },
    {
      label: confirming ? tr("再次点击确认删除") : tr("删除邮件"),
      icon: <Trash2 size={14} />,
      danger: confirming,
      onSelect: () => {
        if (confirming) {
          setConfirmDeleteId(null);
          removeEmail(email);
          return;
        }
        const key = `${email.account}|${email.id}`;
        setConfirmDeleteId(key);
        // 2s 不确认自动解除武装，防止残留确认态误删。
        safeTimeout(() => setConfirmDeleteId((cur) => (cur === key ? null : cur)), 2000);
        // activate 已把菜单关闭：同位置重开，进入确认态。
        openContextMenu(
          { clientX: pos.clientX, clientY: pos.clientY, preventDefault: () => {}, stopPropagation: () => {} },
          buildMailMenu(pos, email, true)
        );
      }
    }
  ];

  const onItemContextMenu = (e: React.MouseEvent, email: Email) => {
    const key = `${email.account}|${email.id}`;
    // 右键了其他邮件即解除旧确认态。
    if (confirmDeleteId !== null && confirmDeleteId !== key) setConfirmDeleteId(null);
    openContextMenu(e, buildMailMenu({ clientX: e.clientX, clientY: e.clientY }, email, confirmDeleteId === key));
  };

  const tabs =
    accounts.length > 0
      ? [ALL_TAB, ...Array.from(new Set(accounts.map((a) => a.email.split("@")[0])))]
      : demoMode
        ? /* 浏览器演示页签也走 tr（此前只译 ALL_TAB，
             英文预览仍显示中文页签）；matchFilter 对 demo 账户本就按 tr()
             比较，两侧一致。词典键「工作」「个人」已有。 */
          [ALL_TAB, tr("工作"), tr("个人")]
        : [ALL_TAB];
  const realMode = accounts.length > 0;
  /** 页签显示名：「全部」走翻译，其余原样（账户前缀/演示名）。 */
  const tabLabel = (t: string) => (t === ALL_TAB ? tr("全部") : t);

  const matchFilter = (e: Email) => {
    if (filter === ALL_TAB) return true;
    if (!realMode) return tr(e.account) === filter;
    return e.account.split("@")[0] === filter;
  };
  const visible = emails.filter(matchFilter).filter((e) => (showUnreadOnly ? e.unread : true));
  const unread = emails.filter((e) => e.unread).length;

  return (
    <div className="mail">
      <div className="mail-head">
        <div className="mail-title">
          <Inbox size={15} />
          <span>{tr("统一收件箱")}</span>
          <span className="mail-unread" key={unread}>
            {tr("{n} 未读", { n: unread })}
          </span>
        </div>
        <div className="mail-head-actions">
          <button
            className="mail-readall"
            onClick={markAllRead}
            disabled={unread === 0}
            title={tr("全部标为已读")}
            aria-label={tr("全部已读")}
            data-interactive
          >
            <CheckCheck size={14} />
          </button>
          <button
            className={`mail-refresh${refreshed ? " done" : ""}`}
            onClick={refresh}
            disabled={refreshing}
            aria-label={tr("刷新")}
            title={refreshed ? tr("已刷新") : tr("刷新邮件")}
            data-interactive
          >
            {/* 刷新完成：图标旋转 → 绿色对勾交叉淡切 + 一次呼吸光晕 */}
            <span key={refreshed ? "done" : "spin"} className="mail-refresh-ico">
              {refreshed ? <Check size={14} /> : <RefreshCw size={14} className={refreshing ? "spin" : ""} />}
            </span>
          </button>
        </div>
      </div>

      {realMode ? (
        <div className="mail-real-badge" title={tr("账户在设置 → 小组件 → 邮件中管理")}>
          <Lock size={10} /> {tr("已连接 {n} 个账户", { n: accounts.length })}
        </div>
      ) : demoMode ? (
        <div className="mail-real-badge" title={tr("浏览器开发模式演示数据")}>
          <Inbox size={10} /> {tr("演示数据")}
        </div>
      ) : null}

      <div className="mail-tabs">
        {tabs.map((a) => (
          <button
            key={a}
            className={`mail-tab${filter === a ? " active" : ""}`}
            onClick={() => setFilter(a)}
            data-interactive
          >
            {tabLabel(a)}
          </button>
        ))}
      </div>
      <div className="mail-list scroll-fade-y" key={filter}>
        {error && (
          <div className="mail-error">
            {tr("获取邮件失败：")}
            {error}
          </div>
        )}
        {/* [POLISH] 等待指示规范：拉取走覆盖层（docs/ui-guidelines.md），不再用
            占位骨架行——覆盖层不占布局，空态/列表高度稳定无跳动；已有邮件时
            列表原地保留，仅刷新按钮旋转。 */}
        {refreshing && visible.length === 0 && (
          <div className="widget-busy-veil" role="status" aria-label={tr("拉取邮件中…")}>
            <span className="widget-busy-spinner" aria-hidden="true" />
            {tr("拉取邮件中…")}
          </div>
        )}
        {visible.map((e) => {
          const key = `${e.account}-${e.id}`;
          return (
            <button
              key={key}
              className={`mail-item${e.unread ? " unread" : ""}${newMailKeys.has(`${e.account}|${e.id}`) ? " is-new" : ""}${removingKeys.has(key) ? " is-closing" : ""}`}
              onClick={() => openMail(e)}
              onContextMenu={(ev) => onItemContextMenu(ev, e)}
              title={e.account.includes("@") ? tr("点击打开邮件，右键更多操作") : undefined}
              data-interactive
            >
              <div className="mail-account">{realMode ? e.account.split("@")[0] : tr(e.account)}</div>
              <div className="mail-from">{e.from}</div>
              <div className="mail-subject">{e.subject}</div>
              {showPreview && <div className="mail-preview">{e.preview}</div>}
              {showTime && <div className="mail-time">{e.time}</div>}
              {e.unread ? <Mail size={13} className="mail-ic" /> : <MailOpen size={13} className="mail-ic read" />}
            </button>
          );
        })}
        {visible.length === 0 && (
          <div className="mail-empty">
            {!demoMode && !realMode
              ? tr("未连接邮箱账户，请前往 设置 → 小组件 → 邮箱 添加")
              : showUnreadOnly
                ? tr("暂无未读邮件")
                : tr("暂无邮件")}
          </div>
        )}
      </div>
    </div>
  );
}
