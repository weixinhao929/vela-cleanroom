/**
 * 连接类小组件的设置页配置表单（天气/邮件/蓝牙等）：
 * 城市解析、IMAP 凭据（DPAPI 加密存本地数据库，见 email.rs ）与设备
 * 过滤选项。
 */
import { useEffect, useState } from "react";
import { ClipboardList, Trash2 } from "lucide-react";
import { invoke, isTauri } from "../../../lib/tauri";
import { useSafeTimeout } from "../../../lib/use-safe-timeout";
import { useSliderDraft } from "../../../lib/use-slider-draft";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, type ClipboardPrivacySettings } from "../../../store/settings-store";
import { useT } from "../../../i18n-lite";
import { confirmDialog } from "../../../components/PromptDialog";
import type { WidgetConfig } from "../../../widget/widget-config";
import { Dropdown, Segmented, SettingToggleRow } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

type EmailAccount = {
  server: string;
  port: number;
  email: string;
  password: string;
  use_tls: boolean;
};

const EMPTY_EMAIL_ACCOUNT: EmailAccount = {
  server: "imap.gmail.com",
  port: 993,
  email: "",
  password: "",
  use_tls: true
};

/**
 * 多账户 IMAP 管理：已配置账户列表（可删除）+ 新增账户表单，
 * 整体保存到 email:accounts 键。旧版单账户数据由 Rust 端 load_email_accounts
 * 自动迁移为单元素列表。
 */
export function EmailConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [draft, setDraft] = useState<EmailAccount>(EMPTY_EMAIL_ACCOUNT);
  /* 刷新间隔 / 每账户条数拖动期草稿、松手一次 update()（同
     widget-configs TimetableConfig 的 useSliderDraft 用法）。 */
  const refreshInterval = useSliderDraft((v) => update({ refreshInterval: v }));
  const maxItems = useSliderDraft((v) => update({ maxItems: v }));
  /* 端口走字符串草稿、提交（blur/回车）时钳 1–65535 再入 draft
     （notification-center 推送端口同款）——此前 Number(v)||993 让清空瞬间
     跳回 993，且无范围校验（0 / 超大数都能进表单）。非法输入回退旧值时
     闪一条行内提示（否则用户以为改成功了）。 */
  const [portDraft, setPortDraft] = useState(String(draft.port));
  const [portRejected, setPortRejected] = useState(false);
  useEffect(() => setPortDraft(String(draft.port)), [draft.port]);
  const commitPort = () => {
    const parsed = Number.parseInt(portDraft, 10);
    const ok = Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535;
    const port = ok ? parsed : draft.port;
    setDraft({ ...draft, port });
    setPortDraft(String(port));
    if (!ok) {
      setPortRejected(true);
      window.setTimeout(() => setPortRejected(false), 2500);
    }
  };
  const [saving, setSaving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  /* IMAP 连接测试（test_email_account）：配完当场验证，不用等轮询才发现
     密码/端口错。测试中的账户草稿与服务端校验互不干扰。 */
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);

  const testAccount = () => {
    const payload = { ...draft, email: draft.email.trim(), server: draft.server.trim() };
    if (!payload.server || !payload.email || !payload.password) {
      setTestOk(false);
      setTestMsg(tr("请填写服务器、邮箱与密码"));
      return;
    }
    setTesting(true);
    setTestMsg(null);
    invoke<string>("test_email_account", { account: payload })
      .then(() => {
        setTestOk(true);
        setTestMsg(tr("连接成功"));
        safeTimeout(() => setTestMsg(null), 3000);
      })
      .catch((e) => {
        setTestOk(false);
        setTestMsg(String(e));
      })
      .finally(() => setTesting(false));
  };

  // Load saved accounts on mount (Tauri only)
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<EmailAccount[]>("load_email_accounts")
      .then((saved) => {
        if (cancelled || !saved) return;
        setAccounts(saved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = (list: EmailAccount[]) => {
    setSaving(true);
    setAccountError(null);
    setSavedMsg(null);
    invoke("save_email_accounts", { accounts: list })
      .then(() => {
        setSavedMsg(tr("账户列表已保存"));
        safeTimeout(() => setSavedMsg(null), 2000);
      })
      .catch((e) => setAccountError(String(e)))
      .finally(() => setSaving(false));
  };

  /** 追加账户：同地址去重后整体落库。 */
  const addAccount = () => {
    const trimmed = { ...draft, email: draft.email.trim(), server: draft.server.trim() };
    if (!trimmed.server || !trimmed.email || !trimmed.password) {
      setAccountError(tr("请填写服务器、邮箱与密码"));
      return;
    }
    if (accounts.some((a) => a.email === trimmed.email)) {
      setAccountError(tr("该邮箱已配置"));
      return;
    }
    const next = [...accounts, trimmed];
    setAccounts(next);
    setDraft(EMPTY_EMAIL_ACCOUNT);
    persist(next);
  };

  /** 删除账户：确认后从列表移除并落库。 */
  const removeAccount = (email: string) => {
    const next = accounts.filter((a) => a.email !== email);
    setAccounts(next);
    persist(next);
  };

  const dndHour = typeof config.doNotDisturbHour === "number" ? config.doNotDisturbHour : -1;
  const hourOptions = [
    { id: "-1", label: tr("关闭") },
    ...Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: `${String(h).padStart(2, "0")}:00` }))
  ];

  return (
    <>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("刷新间隔")}</span>
          <span className="tm-setting-desc">{tr("邮件自动刷新间隔（分钟）")}</span>
        </div>
        <Slider
          label="刷新间隔"
          value={refreshInterval.draft ?? ((config.refreshInterval as number) || 5)}
          min={1}
          max={60}
          step={1}
          suffix={tr("分钟")}
          onChange={refreshInterval.slide}
          onCommitEnd={refreshInterval.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("每账户条数")}</span>
          <span className="tm-setting-desc">{tr("每个账户最多拉取的邮件数")}</span>
        </div>
        <Slider
          label="每账户条数"
          value={maxItems.draft ?? ((config.maxItems as number) || 20)}
          min={5}
          max={50}
          step={5}
          suffix={tr("封")}
          onChange={maxItems.slide}
          onCommitEnd={maxItems.commitEnd}
        />
      </div>
      <SettingToggleRow
        title="显示预览"
        desc="在列表中显示邮件预览文本"
        on={config.showPreview !== false}
        onChange={(v) => update({ showPreview: v })}
      />
      <SettingToggleRow
        title="显示邮件时间"
        desc="在邮件列表中显示接收时间"
        on={config.showTime !== false}
        onChange={(v) => update({ showTime: v })}
      />
      <SettingToggleRow
        title="仅显示未读"
        desc="列表中只显示未读邮件"
        on={config.showUnreadOnly === true}
        onChange={(v) => update({ showUnreadOnly: v })}
      />
      <SettingToggleRow
        title="新邮件通知"
        desc="收到新邮件时推送系统通知"
        on={config.notifyNewMail !== false}
        onChange={(v) => update({ notifyNewMail: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("免打扰时段")}</span>
          <span className="tm-setting-desc">{tr("该小时内不自动检查、不推送通知")}</span>
        </div>
        <Dropdown
          value={String(dndHour)}
          options={hourOptions}
          onChange={(v) => update({ doNotDisturbHour: Number(v) })}
        />
      </div>

      <div className="tm-setting-group-title">{tr("IMAP 账户")}</div>
      {!isTauri() ? (
        <p className="tm-note">{tr("真实 IMAP 连接仅在桌面应用（Tauri）中可用。当前显示演示数据。")}</p>
      ) : (
        <>
          {accounts.length > 0 && (
            <div className="tm-email-account-list">
              {accounts.map((a) => (
                <div className="tm-email-account-row" key={a.email}>
                  <div className="tm-setting-text">
                    <span className="tm-setting-title">{a.email}</span>
                    <span className="tm-setting-desc">
                      {a.server}:{a.port}
                      {a.use_tls ? " (TLS)" : ""}
                    </span>
                  </div>
                  <button
                    className="tm-shortcut-del"
                    onClick={async () => {
                      /* 删除账户会清空其保存的连接配置（不可撤销），补确认。 */
                      if (
                        await confirmDialog({
                          title: tr("删除账户"),
                          message: tr("将移除该邮箱账户及其配置，确定继续？"),
                          confirmLabel: tr("删除"),
                          danger: true
                        })
                      )
                        removeAccount(a.email);
                    }}
                    aria-label={tr("删除账户")}
                    title={tr("删除账户")}
                    data-interactive
                    disabled={saving}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {accounts.length === 0 && <p className="tm-note">{tr("尚未配置账户，添加后即可收取真实邮件。")}</p>}

          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("服务器")}</span>
              <span className="tm-setting-desc">{tr("IMAP 服务器地址")}</span>
            </div>
            <input
              className="tm-text-input"
              style={{ width: 200 }}
              value={draft.server}
              onChange={(e) => setDraft({ ...draft, server: e.target.value })}
              placeholder="imap.gmail.com"
              spellCheck={false}
              autoComplete="off"
              aria-label={tr("IMAP 服务器地址")}
              data-interactive
            />
          </div>
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("端口")}</span>
              <span className="tm-setting-desc">{tr("IMAP 端口（TLS 通常为 993）")}</span>
            </div>
            <input
              className="tm-text-input"
              style={{ width: 96 }}
              type="number"
              min={1}
              max={65535}
              value={portDraft}
              inputMode="numeric"
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPort();
              }}
              autoComplete="off"
              aria-label={tr("IMAP 端口")}
              aria-invalid={portRejected}
              data-interactive
            />
          </div>
          {portRejected && (
            <p className="tm-setting-error">{tr("端口需为 1–65535 之间的整数，已还原为上次保存的值")}</p>
          )}
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("邮箱")}</span>
              <span className="tm-setting-desc">{tr("用于登录的邮箱地址")}</span>
            </div>
            <input
              className="tm-text-input"
              style={{ width: 220 }}
              type="email"
              value={draft.email}
              inputMode="email"
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              placeholder="your@email.com"
              spellCheck={false}
              autoComplete="off"
              aria-label={tr("登录邮箱")}
              data-interactive
            />
          </div>
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("密码")}</span>
              <span className="tm-setting-desc">{tr("应用专用密码（App Password）")}</span>
            </div>
            <input
              className="tm-text-input"
              style={{ width: 220 }}
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              placeholder={tr("应用专用密码")}
              autoComplete="new-password"
              aria-label={tr("应用专用密码")}
              data-interactive
            />
          </div>
          <SettingToggleRow
            title="TLS 加密"
            desc="使用 SSL/TLS 加密连接；关闭后口令将以明文经过网络，仅建议在可信内网环境使用"
            on={draft.use_tls}
            onChange={(v) => setDraft({ ...draft, use_tls: v })}
          />
          <div className="tm-setting-row">
            <button className="tm-btn-secondary" onClick={testAccount} disabled={testing || saving} data-interactive>
              {testing ? (
                <>
                  <span className="tm-spinner" />
                  {tr("测试中…")}
                </>
              ) : (
                tr("测试连接")
              )}
            </button>
            <button className="tm-btn-primary" onClick={addAccount} disabled={saving} data-interactive>
              {saving ? tr("保存中…") : tr("添加账户")}
            </button>
            {savedMsg && <span className="tm-setting-saved">{savedMsg}</span>}
          </div>
          {testMsg && (
            <p className={testOk ? "tm-setting-saved" : "tm-setting-error"} role="status">
              {testMsg}
            </p>
          )}
          {accountError && <p className="tm-setting-error">{accountError}</p>}
          <p className="tm-note">
            {tr("使用应用专用密码（App Password），不要使用主密码。Gmail 需开启 IMAP 并生成应用专用密码。")}
          </p>
        </>
      )}
    </>
  );
}

export function BluetoothConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  const filterType = (config.filterType as string) || "all";
  const sortBy = (config.sortBy as string) || "default";
  const autoRefreshSeconds = typeof config.autoRefreshSeconds === "number" ? config.autoRefreshSeconds : 30;
  const lowBatteryThreshold = typeof config.lowBatteryThreshold === "number" ? config.lowBatteryThreshold : 20;
  return (
    <>
      <SettingToggleRow
        title="显示已断开设备"
        desc="同时显示已断开连接的蓝牙设备"
        on={!!config.showDisconnected}
        onChange={(v) => update({ showDisconnected: v })}
      />
      <SettingToggleRow
        title="显示设备类型"
        desc="悬停时同时显示设备类型"
        on={config.showDeviceType !== false}
        onChange={(v) => update({ showDeviceType: v })}
      />
      <SettingToggleRow
        title="显示电池数字"
        desc="在圆环底部显示电池百分比"
        on={config.showBatteryLabel === true}
        onChange={(v) => update({ showBatteryLabel: v })}
      />
      <SettingToggleRow
        title="显示设备名"
        desc="在圆环下方显示设备名称"
        on={config.showName === true}
        onChange={(v) => update({ showName: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("布局方式")}</span>
          <span className="tm-setting-desc">{tr("设备圆环的排列方式")}</span>
        </div>
        <Segmented
          value={(config.layout as string) || "grid"}
          onChange={(v) => update({ layout: v })}
          options={[
            { id: "grid", label: "网格" },
            { id: "list", label: "列表" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("圆环间距")}</span>
          <span className="tm-setting-desc">{tr("设备圆环之间的空隙")}</span>
        </div>
        <Slider
          label="圆环间距"
          value={(config.gap as number) || ((config.layout as string) === "list" ? 12 : 16)}
          min={4}
          max={40}
          step={2}
          suffix="px"
          onChange={(v) => update({ gap: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("自动刷新")}</span>
          <span className="tm-setting-desc">{tr("定期重新读取设备状态；0 为关闭")}</span>
        </div>
        <Slider
          label="自动刷新"
          value={autoRefreshSeconds}
          min={0}
          max={300}
          step={10}
          suffix={tr("秒")}
          onChange={(v) => update({ autoRefreshSeconds: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("低电量提醒")}</span>
          <span className="tm-setting-desc">{tr("电量低于该值时通知；0 为关闭")}</span>
        </div>
        <Slider
          label="低电量提醒"
          value={lowBatteryThreshold}
          min={0}
          max={50}
          step={5}
          suffix="%"
          onChange={(v) => update({ lowBatteryThreshold: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("类型筛选")}</span>
          <span className="tm-setting-desc">{tr("只显示某一类设备")}</span>
        </div>
        <Dropdown
          value={filterType}
          onChange={(v) => update({ filterType: v })}
          options={[
            { id: "all", label: tr("全部") },
            { id: "音频", label: tr("音频") },
            { id: "鼠标", label: tr("鼠标") },
            { id: "键盘", label: tr("键盘") },
            { id: "手表", label: tr("手表") },
            { id: "手柄", label: tr("手柄") },
            { id: "打印机", label: tr("打印机") },
            { id: "手机", label: tr("手机") },
            { id: "触控笔", label: tr("触控笔") },
            { id: "其他", label: tr("其他") }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("排序方式")}</span>
          <span className="tm-setting-desc">{tr("设备列表的排序规则")}</span>
        </div>
        <Dropdown
          value={sortBy}
          onChange={(v) => update({ sortBy: v })}
          options={[
            { id: "default", label: tr("默认顺序") },
            { id: "battery", label: tr("按电量") },
            { id: "name", label: tr("按名称") },
            { id: "type", label: tr("按类型") }
          ]}
        />
      </div>
      <p className="tm-note">{tr("提示：单击设备圆环可快速连接/断开（经典蓝牙）；右键圆环或空白处有更多操作。")}</p>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 剪贴板历史组件的设置（原「常规 → 隐私」区整体迁入）：三个采集开关只写
 * settings-store 的 general.clipboard，Rust 监听线程每次捕获前从 SQLite
 * 镜像实时读取，位置变化不影响生效链路；目录/清空操作一并跟过来。
 * ------------------------------------------------------------------ */
export function ClipboardConfig() {
  const tr = useT();
  const clip = useSettingsStore(useShallow((s) => s.general.clipboard));
  const safeTimeout = useSafeTimeout();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  const flash = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    safeTimeout(() => setMsg(null), 2600);
  };
  /* （同型，单写者潜伏面）：整节切片写前现取最新基底，与 media
     切片口径统一——防未来新增写者（如跨窗快捷开关）时复发整节回退。 */
  const patch = (p: Partial<ClipboardPrivacySettings>) => {
    const cur = useSettingsStore.getState().general.clipboard;
    useSettingsStore.getState().setGeneral({ clipboard: { ...cur, ...p } });
  };

  const clearAll = async () => {
    if (clearing) return;
    const ok = await confirmDialog({
      title: tr("清空剪贴板历史"),
      message: tr("将删除全部已记录的文本与图片条目（含置顶），不可恢复。"),
      confirmLabel: tr("清空"),
      danger: true
    });
    if (!ok) return;
    setClearing(true);
    try {
      await invoke("clear_clipboard_history");
      flash(true, tr("剪贴板历史已清空"));
    } catch (err) {
      flash(false, tr("清空失败：{err}", { err: String(err) }));
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <SettingToggleRow
        icon={ClipboardList}
        title="剪贴板历史"
        desc="记录复制的文本与图片"
        on={clip.enabled}
        onChange={(v) => patch({ enabled: v })}
      />
      {clip.enabled && (
        <>
          <SettingToggleRow
            title="记录图片"
            desc="图片条目转存到本地 clip 目录"
            on={clip.captureImages}
            onChange={(v) => patch({ captureImages: v })}
          />
          <SettingToggleRow
            title="记录文件"
            desc="文件资源管理器里复制的文件记为文件条目"
            on={clip.captureFiles}
            onChange={(v) => patch({ captureFiles: v })}
          />
          <SettingToggleRow
            title="记录来源进程"
            desc="同时记下复制时所在应用的进程名（默认关闭）"
            on={clip.recordSource}
            onChange={(v) => patch({ recordSource: v })}
          />
          <SettingToggleRow
            title="复制链接快捷打开"
            desc="复制纯链接时灵动岛弹出点击即开的提示条"
            on={clip.linkPopup}
            onChange={(v) => patch({ linkPopup: v })}
          />
        </>
      )}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("剪贴板数据目录")}</span>
          <span className="tm-setting-desc">{tr("只保存在本机，不上传；最多保留 500 条、30 天")}</span>
        </div>
        {isTauri() && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              className="tm-btn-secondary"
              data-interactive
              onClick={() => {
                void invoke("open_clipboard_dir").catch(() => {});
              }}
            >
              {tr("打开目录")}
            </button>
            <button className="tm-btn-danger" data-interactive disabled={clearing} onClick={clearAll}>
              {clearing ? tr("清空中…") : tr("清空历史")}
            </button>
          </div>
        )}
      </div>
      {msg && (
        <span className={msg.ok ? "tm-setting-saved" : "tm-setting-error"} role="status">
          {msg.text}
        </span>
      )}
    </>
  );
}
