/**
 * 设置页 · 数据面板：完整备份导出/恢复（校验 + 确认摘要）、自动备份
 * （状态 + 立即备份 + 逐条恢复）、任务 / DDL 的 CSV 导入导出、小组件布局
 * 导入导出与回收站保留期（「清空数据」的危险操作归 GeneralPage 的
 * 「重置」区，本面板不承载——原文件头注释已漂移，修正）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Database,
  DatabaseBackup,
  Download,
  FileJson,
  FileSpreadsheet,
  LayoutTemplate,
  RotateCcw,
  Trash2,
  Upload
} from "lucide-react";
import { Panel } from "../../components/ui/Panel";
import { jsonBackupService } from "../../domain/backup";
import { deadlinesToCsv, tasksToCsv } from "../../domain/csv";
import { useAppStore } from "../../store/app-store";
import { useWidgetStore } from "../../widget/widget-store";
import { useT, t } from "../../i18n-lite";
import { isTauri } from "../../lib/tauri";
import { pickFilePath } from "../../lib/file-dialog";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { sqliteRepo, type BackupInfo } from "../../lib/persistence/sqlite";
import { fetchBackupsDir, restoreBackupFromPath } from "./restore-backup";
import { flushMirrorSync } from "../../lib/local-backup";
import { RecycleConfig } from "./configs/notes";

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DataPanel() {
  const tr = useT();
  const importJson = useAppStore((s) => s.importData);
  const importTasks = useAppStore((s) => s.importTasksCsv);
  const importDeadlines = useAppStore((s) => s.importDeadlinesCsv);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  /* 提示退场：2.5s 后置空 message，延迟卸载保留 200ms 播淡出 */
  const msgVisible = useDelayedUnmount(message !== null, animDurations().fxMs);
  const msgClosing = message === null && msgVisible;
  const flashTimer = useRef<number>(0);
  /* 恢复中：import_data 执行期间按钮 loading + 「恢复中」遮罩（reload 前） */
  const [restoring, setRestoring] = useState(false);
  /* /审计#20：导入期间按钮 loading + 禁用（大文件同步解析不再冻结无反馈）。 */
  const [importing, setImporting] = useState(false);
  const jsonInput = useRef<HTMLInputElement>(null);
  const tasksInput = useRef<HTMLInputElement>(null);
  const deadlinesInput = useRef<HTMLInputElement>(null);
  const layoutInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  function flash(msg: string, ok = true) {
    setMessage({ text: msg, ok });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setMessage(null), 3500);
  }

  /* 退场播放期间 message 已置空，用 ref 保留最后一条文本供淡出帧渲染。 */
  const lastMsg = useRef<{ text: string; ok: boolean }>({ text: "", ok: true });
  if (message !== null) lastMsg.current = message;

  async function handleImport(
    input: HTMLInputElement | null,
    run: (raw: string) => boolean | Promise<boolean>,
    ok: string,
    fail: string
  ) {
    const file = input?.files?.[0];
    if (!file || importing) return;
    // file.text() 抛出（文件被占用/权限）此前会成为未处理
    // rejection，提示条不出现，且 input.value 重置不会执行 → 同一文件重新
    // 选择不触发 onChange。统一 try/catch/finally，finally 里先清空 input。
    let raw: string;
    try {
      raw = await file.text();
    } catch (e) {
      /* 整句模板（拼接式破坏英文语序）。 */
      flash(t("读取文件失败：{err}", { err: e instanceof Error ? e.message : String(e) }), false);
      if (input) input.value = "";
      return;
    }
    /* 大文件解析会冻结主线程——先置 loading 渲染一帧再执行。
       persist-first：run 落库完成后才 resolve（内存未提交），await 确保提示
       条反映真实持久化结果。 */
    setImporting(true);
    await new Promise((r) => window.setTimeout(r, 30));
    try {
      const parsed = await run(raw);
      flash(parsed ? ok : fail, parsed);
    } catch (e) {
      flash(tr("{fail}：{err}", { fail, err: e instanceof Error ? e.message : String(e) }), false);
    } finally {
      setImporting(false);
      if (input) input.value = "";
    }
  }

  /**
   * 从 Rust 自动备份 / 手动备份生成的 vela-*.json 恢复全部数据：
   * 任务、DDL、专注记录、设置（含小组件布局），以及 localStorage 镜像
   * （便签、习惯、书签、小组件配置等）。恢复后广播所有窗口重载。
   * 校验/确认/ack 协议本体在 restore-backup.ts（与自动备份列表共用）。
   */
  /* 自动备份列表（Rust list_backups，新→旧取 5 条）：此前自动备份「有生成
     无恢复」，恢复必须手选文件且默认目录难找。 */
  const [autoBackups, setAutoBackups] = useState<BackupInfo[]>([]);
  /* 「立即备份」动作态：按钮 loading（原专注统计悬浮窗底部入口收编于此）。 */
  const [backingUp, setBackingUp] = useState(false);
  const loadAutoBackups = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const list = await sqliteRepo.listBackups();
      setAutoBackups(Array.isArray(list) ? list.slice(0, 5) : []);
    } catch {
      // 列表加载失败不打断面板：状态行显示为「暂无备份」即可。
    }
  }, []);
  useEffect(() => {
    void loadAutoBackups();
  }, [loadAutoBackups]);

  /** 立即备份：先 flush localStorage 镜像保证便签/习惯/书签等进快照，
      再走 Rust create_backup；结果经面板统一 flash 提示。 */
  async function backupNow() {
    if (!isTauri() || backingUp) return;
    setBackingUp(true);
    try {
      await flushMirrorSync();
      await sqliteRepo.createBackup();
      await loadAutoBackups();
      flash(tr("备份完成"), true);
    } catch (e) {
      flash(tr("备份失败：{err}", { err: e instanceof Error ? e.message : String(e) }), false);
    } finally {
      setBackingUp(false);
    }
  }

  async function restoreFullBackup() {
    if (!isTauri()) return;
    let picked: string | null;
    try {
      // defaultPath 定位备份目录：自动备份文件在 appData/backups，手动
      // 恢复时用户不必知道（也难知道）这个路径。
      picked = await pickFilePath({
        title: t("选择备份文件"),
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: (await fetchBackupsDir()) || undefined
      });
    } catch {
      return;
    }
    if (!picked) return;
    await restoreBackupFromPath(picked, { flash, setRestoring });
  }

  /* 重入锁：从点击「恢复」到危险确认框关闭之间 restoring 仍是 false——
     此前可再点另一条备份叠出第二个确认框，触发两次整库导入。进入恢复流程
     （含文件选择与确认窗口期）即置位，流程结束（确认 / 取消 / 失败；成功
     路径随后整窗 reload）才释放；ref 为准（密集连点下闭包态可能落后），
     state 只负责按钮禁用。 */
  const restoreInFlight = useRef(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  async function runRestore(flow: () => Promise<void>) {
    if (restoreInFlight.current) return;
    restoreInFlight.current = true;
    setRestoreBusy(true);
    try {
      await flow();
    } finally {
      restoreInFlight.current = false;
      setRestoreBusy(false);
    }
  }

  return (
    <Panel title={tr("数据管理")} kicker="DATA" className="data-panel">
      <div className="data-section">
        <h3>
          <FileJson size={14} />
          {tr("完整备份（JSON）")}
        </h3>
        <div className="data-actions">
          <button
            className="data-button"
            onClick={() =>
              download(
                `vela-backup-${stamp()}.json`,
                jsonBackupService.exportJson(useAppStore.getState()),
                "application/json"
              )
            }
          >
            <Download size={14} />
            {tr("导出 JSON")}
          </button>
          <button className="data-button" onClick={() => jsonInput.current?.click()} disabled={importing}>
            {importing ? <span className="tm-spinner" /> : <Upload size={14} />}
            {tr("导入 JSON")}
          </button>
          <input
            ref={jsonInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={() => handleImport(jsonInput.current, importJson, tr("JSON 导入成功"), tr("JSON 导入失败"))}
          />
        </div>
      </div>

      {/* 自动备份（SQLite 每日滚动，保留 7 份）：原专注统计悬浮窗底部的
          入口收编于此 —— 状态行 + 立即备份 + 逐条一键恢复（路径已知，跳过
          文件对话框）；恢复先经校验 + 危险确认，与手动恢复同一套流程。 */}
      <div className="data-section">
        <h3>
          <DatabaseBackup size={14} />
          {tr("自动备份")}
        </h3>
        <p className="data-hint">
          {tr("每日自动滚动备份，保留最近 7 份。")}
          {autoBackups[0] ? ` ${tr("最近：{name}", { name: autoBackups[0].name })}` : ` ${tr("暂无备份")}`}
        </p>
        <div className="data-actions">
          <button
            className="data-button"
            onClick={() => void backupNow()}
            disabled={!isTauri() || backingUp}
            aria-busy={backingUp || undefined}
          >
            {backingUp ? <span className="tm-spinner" /> : <DatabaseBackup size={14} />}
            {backingUp ? tr("备份中…") : tr("立即备份")}
          </button>
        </div>
        {autoBackups.length > 0 && (
          <div className="data-backup-list">
            <p className="data-hint">{tr("自动备份（新→旧）")}</p>
            {autoBackups.map((b) => (
              <div className="data-backup-row" key={b.name}>
                <span className="data-backup-name" title={b.path}>
                  {b.name}
                </span>
                <button
                  className="data-button"
                  disabled={restoring || restoreBusy}
                  onClick={() => void runRestore(() => restoreBackupFromPath(b.path, { flash, setRestoring }))}
                >
                  {tr("恢复")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="data-section">
        <h3>
          <RotateCcw size={14} />
          {tr("恢复完整备份")}
        </h3>
        <p className="data-hint">{tr("从 vela-*.json 备份文件恢复任务、专注记录、小组件布局、便签与习惯等全部数据")}</p>
        <div className="data-actions">
          <button
            className="data-button"
            onClick={() => void runRestore(restoreFullBackup)}
            disabled={!isTauri() || restoring || restoreBusy}
          >
            {restoring ? <span className="tm-spinner" /> : <RotateCcw size={14} />}
            {restoring ? tr("恢复中…") : tr("选择文件恢复")}
          </button>
        </div>
      </div>

      {/* 回收站保留期是全局设置，此前只存在于「回收站」组件实例的配置页
          （没有该组件就找不到入口）；归位到数据管理区，组件配置页保留不动
          （同一 settings key，两处写无不同步风险）。 */}
      <div className="data-section">
        <h3>
          <Trash2 size={14} />
          {tr("回收站")}
        </h3>
        <RecycleConfig />
      </div>

      <div className="data-section">
        <h3>
          <FileSpreadsheet size={14} />
          {tr("任务 / DDL 交换（CSV）")}
        </h3>
        <div className="data-actions">
          <button
            className="data-button"
            onClick={() => download(`tasks-${stamp()}.csv`, tasksToCsv(useAppStore.getState().tasks), "text/csv")}
          >
            <Download size={14} />
            {tr("导出任务")}
          </button>
          <button className="data-button" onClick={() => tasksInput.current?.click()} disabled={importing}>
            {importing ? <span className="tm-spinner" /> : <Upload size={14} />}
            {tr("导入任务")}
          </button>
          <input
            ref={tasksInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={() => handleImport(tasksInput.current, importTasks, tr("任务导入成功"), tr("任务导入失败"))}
          />
          <button
            className="data-button"
            onClick={() =>
              download(`deadlines-${stamp()}.csv`, deadlinesToCsv(useAppStore.getState().deadlines), "text/csv")
            }
          >
            <Download size={14} />
            {tr("导出 DDL")}
          </button>
          <button className="data-button" onClick={() => deadlinesInput.current?.click()} disabled={importing}>
            {importing ? <span className="tm-spinner" /> : <Upload size={14} />}
            {tr("导入 DDL")}
          </button>
          <input
            ref={deadlinesInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={() =>
              handleImport(deadlinesInput.current, importDeadlines, tr("DDL 导入成功"), tr("DDL 导入失败"))
            }
          />
        </div>
      </div>

      <div className="data-section">
        <h3>
          <LayoutTemplate size={14} />
          {tr("小组件布局")}
        </h3>
        <div className="data-actions">
          <button
            className="data-button"
            onClick={() =>
              download(`vela-layout-${stamp()}.json`, useWidgetStore.getState().exportLayout(), "application/json")
            }
          >
            <Download size={14} />
            {tr("导出布局")}
          </button>
          <button className="data-button" onClick={() => layoutInput.current?.click()} disabled={importing}>
            {importing ? <span className="tm-spinner" /> : <Upload size={14} />}
            {tr("导入布局")}
          </button>
          <input
            ref={layoutInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={() =>
              handleImport(
                layoutInput.current,
                (raw) => useWidgetStore.getState().importLayout(raw),
                tr("布局导入成功"),
                tr("布局导入失败")
              )
            }
          />
        </div>
      </div>

      {msgVisible && (
        <p
          className={`data-message${lastMsg.current.ok ? "" : " fail"}${msgClosing ? " is-closing" : ""}`}
          role="status"
        >
          <Database size={13} />
          {lastMsg.current.text}
        </p>
      )}

      {/* 恢复中遮罩：覆盖整个设置窗，阻止恢复期间的误操作 */}
      {restoring && (
        <div className="data-restore-overlay">
          <span className="tm-spinner" />
          <span>{tr("正在恢复数据…")}</span>
        </div>
      )}
    </Panel>
  );
}
