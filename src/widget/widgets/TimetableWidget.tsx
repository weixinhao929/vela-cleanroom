/**
 * 课程表小组件：Excel/CSV 导入解析、周视图网格 + 列表双视图、当前课程
 * 高亮（30s tick）、冲突检测、节假日调休标注与周次导航。列表分桶排序
 * 已收敛为 byDay memo（P-perf）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  Layers,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  RotateCcw,
  Trash2
} from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { pickFilePath } from "../../lib/file-dialog";
import { useT } from "../../i18n-lite";
import { confirmDialog, promptDialog } from "../../components/PromptDialog";
import { useWidgetConfig } from "../widget-config";
import {
  activeProfileIdOf,
  addMinutesToTime,
  DEFAULT_SECTION_TIMES,
  formatWeeks,
  inferTotalWeeks,
  loadProfiles,
  mondayOf,
  parseISODate,
  parseTimeList,
  parseTimetableRows,
  profilesPatch,
  sessionColors,
  sessionsInWeek,
  toISODate,
  weekNumberFor,
  type TimetableData,
  type TimetableProfile,
  type TimetableSession
} from "../timetable";
import { downloadIcs, draftConflicts, findConflicts, todayClassSlots, weekHolidayMarks } from "../timetable-extras";
import { WidgetSelect } from "../../components/WidgetSelect";
import { downloadTimetableXlsx } from "../timetable-xlsx";
import { sourceNotify } from "../../lib/notifications";
import { markReminded } from "../../lib/remind-dedupe";
import { DAY_NAMES, type Preview } from "./timetable-shared";
import { TimetableImportPreview, TimetableSessionEditor } from "./timetable-dialogs";
import { useNow } from "../../lib/use-now";
import { useSafeTimeout } from "../../lib/use-safe-timeout";

/**
 * 课程表小组件（Wakeup 风格周视图）。
 *
 * 数据流：小组件配置里的 `data` 字段（useWidgetConfig 持久化 + 跨窗口同步）。
 * 导入：pick_file → Rust read_excel_sheet（xlsx/xls/ods/csv → 字符串矩阵）。
 * parseTimetableRows 语义解析（网格式/清单式自适应）→ 预览确认 → 写入配置。
 */
export function TimetableWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const { config, update } = useWidgetConfig(instanceId);
  const safeTimeout = useSafeTimeout();
  /* W-019 多方案：profiles 持有全部课表，data 始终镜像激活方案（旧读取方式零改动）。 */
  const profiles = useMemo(
    () => loadProfiles(config),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config 整体即失效信号
    [config.profiles, config.data, config.activeProfile]
  );
  const activeId = activeProfileIdOf(config, profiles);
  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;
  const data = activeProfile?.data ?? null;
  /** 写入当前方案（含镜像 data）。 */
  const writeActive = (next: TimetableData | null) => {
    if (!activeProfile && profiles.length === 0 && next) {
      // 空态首次写入（首次导入 / 手动加课）：尚无任何方案，先落默认方案。
      update(
        profilesPatch([{ id: "default", name: "默认课表", data: next }], "default") as unknown as Record<
          string,
          unknown
        >
      );
      return;
    }
    if (!activeProfile) return;
    const nextProfiles: TimetableProfile[] = next
      ? profiles.map((p) => (p.id === activeProfile.id ? { ...p, data: next } : p))
      : profiles.filter((p) => p.id !== activeProfile.id);
    update(profilesPatch(nextProfiles, activeProfile.id) as unknown as Record<string, unknown>);
  };
  /** 切换激活方案。 */

  const switchProfile = (id: string) => {
    if (id === activeId) return;
    update(profilesPatch(profiles, id) as unknown as Record<string, unknown>);
  };

  const showLocation = config.showLocation !== false;
  const showWeeksBadge = config.showWeeksBadge !== false;
  const showTimes = config.showTimes !== false;
  const compact = !!config.compact;
  /* 固定每日节次数（0=跟随课表数据自动）与课程格尺寸（px，0=自适应）。 */
  const totalSections = typeof config.totalSections === "number" ? config.totalSections : 0;
  const cellHeight = typeof config.cellHeight === "number" && config.cellHeight >= 28 ? config.cellHeight : 28;
  const cellWidth = typeof config.cellWidth === "number" && config.cellWidth >= 24 ? config.cellWidth : 0;
  const sectionTimes = useMemo(() => {
    const list = parseTimeList(config.sectionTimes);
    return list.length ? list : DEFAULT_SECTION_TIMES;
  }, [config.sectionTimes]);
  const sectionTimesEnd = useMemo(() => {
    const list = parseTimeList(config.sectionTimesEnd);
    if (list.length) return list;
    return sectionTimes.map((t) => addMinutesToTime(t, 45));
  }, [config.sectionTimesEnd, sectionTimes]);

  /* ---- 派生数据（hooks 必须全部先于早退 return，否则切空态会崩） ---- */
  // useNow 共享 ticker 每 30s 刷新：today 冻结于挂载时刻会在跨零点后错乱（G-审计）。
  const now = useNow();
  const today = now;
  const currentWeek = data ? weekNumberFor(today, data.semesterStart, data.totalWeeks) : 1;
  const [viewWeek, setViewWeek] = useState(currentWeek);
  useEffect(() => {
    setViewWeek(currentWeek);
  }, [currentWeek]);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [importError, setImportError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  /** 正在编辑的课程：null=关闭弹层，"new"=新建；否则为已有课程 id。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteSession, setConfirmDeleteSession] = useState(false);

  /** 悬停「同格多课」的课程块：浮层列出该时段全部课程（Portal 到 body）。 */
  const [conflictHover, setConflictHover] = useState<{
    x: number;
    y: number;
    list: TimetableSession[];
  } | null>(null);
  /** 冲突浮层退场：先播 120ms 缩放淡出再卸载（动画机会 #117）。 */
  const [tipClosing, setTipClosing] = useState(false);
  /* 退场定时器代数：120ms 内又悬停到别的冲突格时，旧定时器不得把新浮层卸掉。 */
  const tipCloseSeq = useRef(0);
  const showConflictTip = (cell: { x: number; y: number; list: TimetableSession[] }) => {
    tipCloseSeq.current++;
    setTipClosing(false);
    setConflictHover(cell);
  };
  const closeConflictTip = () => {
    const seq = ++tipCloseSeq.current;
    setTipClosing(true);
    safeTimeout(() => {
      if (tipCloseSeq.current !== seq) return;
      setConflictHover(null);
      setTipClosing(false);
    }, 120);
  };
  /* 触控板横向手势一次会连发几十个 wheel 事件，不节流会一口气跳多周。 */
  const lastWheelWeekAt = useRef(0);

  /** 切周方向：+1 前进左入，-1 后退右入；纯淡入（节次/时间列变化，#115/#122）。 */
  const weekDir = useRef(0);

  /** 导出反馈：按钮 accent 脉冲 + title 短暂变「已导出」（#124）。 */
  const [exported, setExported] = useState<"xlsx" | "ics" | null>(null);
  const markExported = (kind: "xlsx" | "ics") => {
    setExported(kind);
    safeTimeout(() => setExported((cur) => (cur === kind ? null : cur)), 1600);
  };

  /** 弹层退场：先播 150ms 淡出再卸载（#116）。 */
  const [modalClosing, setModalClosing] = useState(false);
  const closeModalSoon = (fn: () => void) => {
    if (modalClosing) return;
    setModalClosing(true);
    safeTimeout(() => {
      fn();
      setModalClosing(false);
    }, 150);
  };

  /** 网格滚动边缘渐隐状态（顶/底还能滚则提示「下方还有节次」，#118）。 */
  const [scrollEdge, setScrollEdge] = useState({ top: false, bottom: false });

  /** 触摸/拖拽横向滑动切周的起点（无手势时为空）。 */
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  /** 网格滚动容器：纵向滚轮始终翻看节次（12+ 节课表在悬浮窗里靠它
      上下滚动），并阻止 Chromium 在仅有横向溢出时把纵滚轮转成横滚。
      网格用 key 重挂载来重触发切周动画，监听需随挂载重绑。 */
  const gridRef = useRef<HTMLDivElement>(null);

  /** 切换查看周次（越界自动 clamp）。 */
  const changeWeek = (dir: 1 | -1) => {
    if (!data) return;
    weekDir.current = dir;
    setViewWeek((w) => Math.max(1, Math.min(data.totalWeeks, w + dir)));
  };

  /** 保存新建/编辑的课程（与现有课时间重叠时先确认）。 */
  const saveSession = async (draft: Omit<TimetableSession, "id">) => {
    // 空态（无任何方案）不早退：writeActive 里有「首次写入先落默认方案」的
    // 专门分支，下方 base 兜底同样为其准备。此前 `if (!activeProfile) return`
    // 让空态「手动添加课程」保存后静默无效——弹层不关、课程不写入。
    const base = data ?? {
      semesterStart: toISODate(mondayOf(new Date())),
      totalWeeks: 16,
      sessions: [],
      importedAt: Date.now()
    };
    const editing = editingId && editingId !== "new" ? base.sessions.find((s) => s.id === editingId) : undefined;
    const clean: TimetableSession = {
      id: editing ? editing.id : crypto.randomUUID(),
      name: draft.name,
      rawName: draft.rawName,
      day: draft.day,
      startSection: draft.startSection,
      endSection: draft.endSection,
      weeks: draft.weeks,
      weeksLabel: draft.weeksLabel,
      location: draft.location,
      teacher: draft.teacher,
      colorOverride: draft.colorOverride
    };
    const clashes = draftConflicts(clean, base.sessions, editing?.id);
    if (clashes.length) {
      const names = clashes
        .slice(0, 3)
        .map((c) => c.name)
        .join("、");
      const ok = await confirmDialog({
        title: tr("课程时间冲突"),
        message:
          tr("与以下课程在部分周次重叠：") + names + (clashes.length > 3 ? ` ${tr("等")}` : "") + tr("。仍要保存吗？"),
        confirmLabel: tr("仍要保存"),
        cancelLabel: tr("返回修改")
      });
      if (!ok) return;
    }
    const sessions = editing ? base.sessions.map((s) => (s.id === editing.id ? clean : s)) : [...base.sessions, clean];
    writeActive({ ...base, sessions });
    closeModalSoon(() => setEditingId(null));
    setConfirmDeleteSession(false);
  };

  const removeSession = () => {
    if (!data || !editingId || editingId === "new") return;
    if (!data.sessions.some((s) => s.id === editingId)) {
      setEditingId(null);
      setConfirmDeleteSession(false);
      return;
    }
    if (!confirmDeleteSession) {
      setConfirmDeleteSession(true);
      safeTimeout(() => setConfirmDeleteSession(false), 2000);
      return;
    }
    const sessions = data.sessions.filter((s) => s.id !== editingId);
    writeActive({ ...data, sessions });
    closeModalSoon(() => setEditingId(null));
    setConfirmDeleteSession(false);
  };

  /* W-023 总览模式：开启后不按周次过滤，单双周课程全部可见。 */
  const showAllWeeks = config.showAllWeeks === true;
  const weekSessions = useMemo(
    () => (data ? (showAllWeeks ? data.sessions : sessionsInWeek(data.sessions, viewWeek)) : []),
    [data, viewWeek, showAllWeeks]
  );
  const maxSection = useMemo(
    () => Math.min(30, Math.max(6, totalSections, ...(data ? data.sessions.map((s) => s.endSection) : []))),
    [data, totalSections]
  );
  /** 节次/时间列变化属于布局调整，不做方向化位移（#122）
      （必须在 maxSection 声明之后，避免 TDZ。） */
  useEffect(() => {
    weekDir.current = 0;
  }, [maxSection, showTimes]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (el.scrollHeight <= el.clientHeight + 1) return;
      e.preventDefault();
      el.scrollTop += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewWeek, maxSection, showTimes]);
  const todayDay = ((today.getDay() + 6) % 7) + 1;
  const isThisWeek = viewWeek === currentWeek;
  const weekDates = useMemo(() => {
    if (!data) return null;
    const start = parseISODate(data.semesterStart);
    if (!start) return null;
    const base = mondayOf(start);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + (viewWeek - 1) * 7 + i);
      return d.getDate();
    });
  }, [data, viewWeek]);

  const byCell = useMemo(() => {
    const map = new Map<string, TimetableSession[]>();
    for (const s of weekSessions) {
      const key = `${s.day}:${s.startSection}`;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return map;
  }, [weekSessions]);

  /** 被跨节课程覆盖的格子（这些格子渲染 null，避免空格子压在课程块上）。 */
  const covered = useMemo(() => {
    const set = new Set<string>();
    for (const s of weekSessions) {
      for (let sec = s.startSection + 1; sec <= Math.min(s.endSection, maxSection); sec++) {
        set.add(`${s.day}:${sec}`);
      }
    }
    return set;
  }, [weekSessions, maxSection]);

  /** P-perf：列表视图按日分桶（已按起始节次排序）。此前渲染期对 7 天各做
      一遍 filter+sort（O(7n + Σk·logk)），随每次 30s tick / 状态变化重跑；
      收敛为数据变化时一次 O(n log n) 分桶排序。 */
  const byDay = useMemo(() => {
    const map = new Map<number, TimetableSession[]>();
    for (const s of weekSessions) {
      const list = map.get(s.day);
      if (list) list.push(s);
      else map.set(s.day, [s]);
    }
    for (const list of map.values()) list.sort((a, b) => a.startSection - b.startSection);
    return map;
  }, [weekSessions]);

  /** 全表冲突：涉事课程的 id 集合（周视图中以红色描边提示）。 */
  const conflictIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of findConflicts(data?.sessions ?? [])) {
      set.add(c.a.id);
      set.add(c.b.id);
    }
    return set;
  }, [data]);

  /** 当前视图周的节假日标注（休/班）。 */
  const holidayMarks = useMemo(
    () => (data ? weekHolidayMarks(data.semesterStart, viewWeek) : Array.from({ length: 7 }, () => null)),
    [data, viewWeek]
  );

  const startImport = async () => {
    if (!isTauri()) {
      setImportError(tr("导入需要桌面版"));
      return;
    }
    setImportError("");
    try {
      const path = await pickFilePath({
        title: tr("选择课表文件"),
        filters: [
          { name: tr("Excel 工作簿"), extensions: ["xlsx", "xlsm", "xls", "ods"] },
          { name: "CSV / TSV", extensions: ["csv", "tsv"] }
        ]
      });
      if (!path) return;
      if (!/\.(xlsx|xlsm|xls|ods|csv|tsv)$/i.test(path)) {
        setImportError(tr("请选择 Excel 或 CSV 文件"));
        return;
      }
      const rows = await invoke<string[][]>("read_excel_sheet", { path });
      if (!Array.isArray(rows) || !rows.length) {
        setImportError(tr("文件内容为空"));
        return;
      }
      const result = parseTimetableRows(rows);
      if (!result.sessions.length) {
        setImportError(tr("未识别到课程，请检查表格格式"));
        return;
      }
      setPreview({
        rows,
        sessions: result.sessions,
        mode: result.mode,
        semesterStart: data?.semesterStart ?? toISODate(mondayOf(new Date())),
        totalWeeks: data?.totalWeeks ?? inferTotalWeeks(result.sessions)
      });
    } catch (e) {
      setImportError(e instanceof Error ? e.message : tr("读取文件失败"));
    }
  };

  const confirmImport = () => {
    if (!preview) return;
    const next: TimetableData = {
      semesterStart: preview.semesterStart,
      totalWeeks: preview.totalWeeks,
      sessions: preview.sessions,
      importedAt: Date.now()
    };
    writeActive(next);
    setPreview(null);
    setViewWeek(weekNumberFor(new Date(), next.semesterStart, next.totalWeeks));
  };

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      safeTimeout(() => setConfirmClear(false), 2000);
      return;
    }
    writeActive(null);
    setConfirmClear(false);
  };

  /* ---- W-019 方案管理：新建（复制当前）/ 重命名 / 删除 ---- */
  const addProfile = async () => {
    const name = await promptDialog({
      title: tr("新建课表方案（复制当前课程）"),
      placeholder: tr("下学期 / 单周课表"),
      confirmLabel: tr("创建")
    });
    if (name === null) return;
    const id = crypto.randomUUID();
    const base = data ?? {
      semesterStart: toISODate(mondayOf(new Date())),
      totalWeeks: 16,
      sessions: [],
      importedAt: Date.now()
    };
    update(
      profilesPatch(
        [...profiles, { id, name: name.trim() || tr("新方案"), data: { ...base, sessions: [...base.sessions] } }],
        id
      ) as unknown as Record<string, unknown>
    );
  };

  const renameProfile = async () => {
    if (!activeProfile) return;
    const name = await promptDialog({
      title: tr("重命名方案"),
      placeholder: activeProfile.name,
      initialValue: activeProfile.name,
      confirmLabel: tr("保存")
    });
    if (name === null || !name.trim()) return;
    update(
      profilesPatch(
        profiles.map((p) => (p.id === activeProfile.id ? { ...p, name: name.trim() } : p)),
        activeProfile.id
      ) as unknown as Record<string, unknown>
    );
  };

  const deleteProfile = async () => {
    if (!activeProfile || profiles.length <= 1) return;
    const ok = await confirmDialog({
      title: tr("删除方案"),
      message: tr("将删除「{name}」的全部课程，不可恢复！").replace("{name}", () => activeProfile.name),
      confirmLabel: tr("删除"),
      cancelLabel: tr("取消")
    });
    if (!ok) return;
    const rest = profiles.filter((p) => p.id !== activeProfile.id);
    update(profilesPatch(rest, rest[0].id) as unknown as Record<string, unknown>);
  };

  /* ---- W-021/022 今日课程：每 30s 对表一次当前节次与下节课 ---- */
  const todaySlots = useMemo(
    () => (data ? todayClassSlots(data, sectionTimes, sectionTimesEnd, now) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now 每分钟级变化
    [data, sectionTimes, sectionTimesEnd, Math.floor(now.getTime() / 30000)]
  );
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const currentSlot = todaySlots.find((s) => s.startMin <= nowMin && nowMin < s.endMin) ?? null;
  const nextSlot = todaySlots.find((s) => s.startMin > nowMin) ?? null;
  const liveId = currentSlot?.session.id ?? null;

  /* W-021 上课前提醒：下节课开始前推送一次（localStorage 去重）。
     审计修复：原 [8,10] 分钟窗过窄，睡眠/关闭期间错过即永久漏发——
     放宽为开课前 30 分钟至开课后 45 分钟内到点即补发。 */
  useEffect(() => {
    if (config.classReminder === false || !nextSlot) return;
    const lead = nextSlot.startMin - nowMin;
    if (lead > 30 || lead < -45) return;
    // 去重键按天写入、由 markReminded 顺带清扫过期键（此前永不清除、无限堆积）。
    const today = toISODate(now);
    const key = `focus-desk.tt-remind.${nextSlot.session.id}.${today}`;
    if (!markReminded(key, "focus-desk.tt-remind.", today)) return;
    void sourceNotify(
      "timetable",
      tr("上课提醒"),
      tr("{n} 分钟后上 {name}")
        .replace("{n}", String(Math.max(lead, 0)))
        .replace("{name}", nextSlot.session.name) + (nextSlot.session.location ? ` · ${nextSlot.session.location}` : "")
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 30s 节拍轮询
  }, [Math.floor(now.getTime() / 30000), config.classReminder, nextSlot?.session.id, tr]);

  /* ---- 弹层（导入预览 / 课程编辑）在空态与周视图中都要渲染。
     首次导入解析成功后 data 仍为 null，若只在周视图渲染弹层，
     预览永远不会出现，表现为「选完文件没反应」。 ---- */
  const modals = (
    <>
      {preview && (
        <TimetableImportPreview
          preview={preview}
          closing={modalClosing}
          onChange={setPreview}
          onCancel={() => closeModalSoon(() => setPreview(null))}
          onConfirm={confirmImport}
        />
      )}

      {editingId && (data || editingId === "new") && (
        <TimetableSessionEditor
          key={editingId}
          session={editingId === "new" ? null : (data?.sessions.find((s) => s.id === editingId) ?? null)}
          confirmDelete={confirmDeleteSession}
          closing={modalClosing}
          onSave={saveSession}
          onDelete={removeSession}
          onCancel={() => {
            closeModalSoon(() => setEditingId(null));
            setConfirmDeleteSession(false);
          }}
        />
      )}
    </>
  );

  /* ---- 空态：引导导入 / 手动添加 ---- */
  if (!data) {
    return (
      <div className="tt tt-empty" key="tt-empty">
        <CalendarDays size={28} />
        <div className="tt-empty-title">{tr("课程表")}</div>
        <div className="tt-empty-desc">{tr("导入教务导出的 Excel 课表")}</div>
        <button className="tt-import-btn" onClick={() => void startImport()} data-interactive>
          <CalendarPlus size={14} /> {tr("导入课表")}
        </button>
        <button className="tt-add-btn" onClick={() => setEditingId("new")} data-interactive>
          <Plus size={14} /> {tr("手动添加课程")}
        </button>
        {importError && (
          <div className="tt-error" key={importError}>
            <CircleAlert size={12} /> {importError}
          </div>
        )}
        {modals}
      </div>
    );
  }

  /* ---- 周视图 ---- */
  const sections = Array.from({ length: maxSection }, (_, i) => i + 1);
  const todayCount = isThisWeek ? (byDay.get(todayDay)?.length ?? 0) : 0;

  return (
    <div className="tt" key="tt-grid">
      {/* W-019 方案栏：多套课表（本学期/下学期、单双周）一键切换。 */}
      <div className="tt-profile-bar">
        <WidgetSelect
          value={activeId}
          onChange={switchProfile}
          options={profiles.map((p) => ({ value: p.id, label: p.name }))}
          ariaLabel={tr("课表方案")}
          align="left"
        />
        <button
          className="tt-mini-btn"
          onClick={() => void renameProfile()}
          data-interactive
          title={tr("重命名方案")}
          aria-label={tr("重命名方案")}
        >
          <Pencil size={11} />
        </button>
        <button
          className="tt-mini-btn"
          onClick={() => void addProfile()}
          data-interactive
          title={tr("新建方案（复制当前）")}
          aria-label={tr("新建方案（复制当前）")}
        >
          <Copy size={11} />
        </button>
        {profiles.length > 1 && (
          <button
            className="tt-mini-btn"
            onClick={() => void deleteProfile()}
            data-interactive
            title={tr("删除当前方案")}
            aria-label={tr("删除当前方案")}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <div className="tt-header">
        <div className="tt-week-nav">
          <button
            className="tt-nav-btn"
            disabled={viewWeek <= 1}
            onClick={() => changeWeek(-1)}
            aria-label={tr("上一周")}
            data-interactive
          >
            <ChevronLeft size={14} />
          </button>
          <span key={viewWeek} className={`tt-week-badge${isThisWeek ? " now" : ""}`}>
            {tr("第 {n} 周").replace("{n}", String(viewWeek))}
          </span>
          <button
            className="tt-nav-btn"
            disabled={viewWeek >= data.totalWeeks}
            onClick={() => changeWeek(1)}
            aria-label={tr("下一周")}
            data-interactive
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="tt-header-actions">
          {/* W-023 总览开关：不按周次过滤，单双周全部课程同屏。 */}
          <button
            className={`tt-mini-btn${showAllWeeks ? " on" : ""}`}
            onClick={() => update({ showAllWeeks: !showAllWeeks })}
            data-interactive
            title={showAllWeeks ? tr("总览已开启：显示全部周次课程") : tr("总览模式：不按周次过滤，显示全部课程")}
            aria-label={showAllWeeks ? tr("总览已开启：显示全部周次课程") : tr("总览模式：不按周次过滤，显示全部课程")}
          >
            <Layers size={12} />
          </button>
          {/* W-024 视图切换：网格 / 列表。 */}
          <button
            className={`tt-mini-btn${config.layout === "list" ? " on" : ""}`}
            onClick={() => update({ layout: config.layout === "list" ? "grid" : "list" })}
            data-interactive
            title={config.layout === "list" ? tr("切换为周网格视图") : tr("切换为列表视图（窄尺寸更易读）")}
            aria-label={config.layout === "list" ? tr("切换为周网格视图") : tr("切换为列表视图（窄尺寸更易读）")}
          >
            {config.layout === "list" ? <LayoutGrid size={12} /> : <List size={12} />}
          </button>
          {conflictIds.size > 0 && (
            <button
              className="tt-mini-btn conflict"
              data-interactive
              title={tr("存在时间冲突的课程，红色描边标记")}
              aria-label={tr("课程冲突")}
            >
              <CircleAlert size={12} />{" "}
              <span className="tt-conflict-num" key={conflictIds.size}>
                {conflictIds.size}
              </span>
            </button>
          )}
          {!isThisWeek && (
            <button
              className="tt-mini-btn"
              onClick={() => setViewWeek(currentWeek)}
              data-interactive
              title={tr("回到本周")}
              aria-label={tr("回到本周")}
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            className="tt-mini-btn"
            onClick={() => void startImport()}
            data-interactive
            title={tr("重新导入")}
            aria-label={tr("重新导入")}
          >
            <CalendarPlus size={12} />
          </button>
          <button
            className={`tt-mini-btn${exported === "xlsx" ? " done" : ""}`}
            onClick={() => {
              downloadTimetableXlsx(data, sectionTimes, viewWeek);
              markExported("xlsx");
            }}
            data-interactive
            title={exported === "xlsx" ? tr("已导出") : tr("导出为 Excel (.xlsx)")}
            aria-label={exported === "xlsx" ? tr("已导出") : tr("导出为 Excel (.xlsx)")}
          >
            <Download size={12} />
          </button>
          <button
            className={`tt-mini-btn${exported === "ics" ? " done" : ""}`}
            onClick={() => {
              downloadIcs(data, sectionTimes);
              markExported("ics");
            }}
            data-interactive
            title={exported === "ics" ? tr("已导出") : tr("导出为日历 (.ics)")}
            aria-label={exported === "ics" ? tr("已导出") : tr("导出为日历 (.ics)")}
          >
            <CalendarPlus size={12} />
          </button>
          <button
            className="tt-mini-btn"
            onClick={() => setEditingId("new")}
            data-interactive
            title={tr("添加课程")}
            aria-label={tr("添加课程")}
          >
            <Plus size={12} />
          </button>
          <button
            className={`tt-mini-btn${confirmClear ? " danger" : ""}`}
            onClick={clearAll}
            data-interactive
            title={confirmClear ? tr("再次点击确认清空") : tr("清空课表")}
            aria-label={confirmClear ? tr("再次点击确认清空") : tr("清空课表")}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* 第 1 行为星期表头，节次从第 2 行起；所有格子显式定位，跨节课程
          用 grid-row span 占位，被覆盖的格子渲染 null。 */}
      {/* W-024 列表视图：按天分组的清单（窄尺寸小组件更易读）。 */}
      {config.layout === "list" ? (
        <div
          className={`tt-list${compact ? " compact" : ""}`}
          key={`tt-list:${viewWeek}:${showAllWeeks ? 1 : 0}`}
          style={{ ["--tt-dir" as string]: String(weekDir.current) }}
        >
          {DAY_NAMES.map((d, di) => {
            const daySessions = byDay.get(di + 1) ?? [];
            const isTodayCol = isThisWeek && todayDay === di + 1;
            return (
              <div
                key={d}
                className={`tt-list-day${isTodayCol ? " today" : ""}${daySessions.length === 0 ? " empty" : ""}`}
              >
                <div className="tt-list-day-head">
                  <span className="tt-list-day-name">{tr(`星期${d}`)}</span>
                  {weekDates && <span className="tt-list-day-date">{weekDates[di]}</span>}
                  {holidayMarks[di] === "rest" && <span className="tt-holiday-badge rest">{tr("休")}</span>}
                  {holidayMarks[di] === "work" && <span className="tt-holiday-badge work">{tr("班")}</span>}
                  {daySessions.length === 0 && <span className="tt-list-day-none">{tr("无课")}</span>}
                </div>
                {daySessions.map((s, li) => {
                  const [c1, c2] = sessionColors(s);
                  const start = sectionTimes[s.startSection - 1] ?? "";
                  const end = sectionTimesEnd[s.endSection - 1] ?? "";
                  return (
                    <div
                      key={s.id}
                      className={`tt-list-item${liveId === s.id && isTodayCol ? " live" : ""}`}
                      style={{
                        background: `linear-gradient(135deg, color-mix(in srgb, ${c1} 18%, transparent), color-mix(in srgb, ${c2} 27%, transparent))`,
                        borderColor: `color-mix(in srgb, ${c1} 40%, transparent)`,
                        ["--sti" as string]: li
                      }}
                      onClick={() => setEditingId(s.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditingId(s.id);
                        }
                      }}
                      title={tr("点击编辑课程")}
                      data-interactive
                    >
                      <span className="tt-list-item-bar" style={{ background: c1 }} />
                      <span className="tt-list-item-sec">
                        {s.startSection === s.endSection
                          ? tr("第 {n} 节").replace("{n}", String(s.startSection))
                          : tr("第 {a}-{b} 节")
                              .replace("{a}", String(s.startSection))
                              .replace("{b}", String(s.endSection))}
                      </span>
                      {(start || end) && (
                        <span className="tt-list-item-time">
                          {start}
                          <em>–{end}</em>
                        </span>
                      )}
                      <span className="tt-list-item-name">{s.name}</span>
                      {showLocation && s.location && <span className="tt-list-item-loc">{s.location}</span>}
                      {showWeeksBadge && s.weeksLabel && (
                        <span className="tt-list-item-weeks">{formatWeeks(s.weeks)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <div
          ref={gridRef}
          key={`${viewWeek}:${maxSection}:${showTimes ? 1 : 0}`}
          className={`tt-grid${compact ? " compact" : ""}${showTimes ? " show-times" : ""}${scrollEdge.top ? " sc-top" : ""}${scrollEdge.bottom ? " sc-bot" : ""}`}
          style={{
            ["--tt-rows" as string]: String(maxSection),
            ["--tt-row-h" as string]: `${cellHeight}px`,
            ["--tt-dir" as string]: String(weekDir.current),
            ...(cellWidth ? { ["--tt-col-w" as string]: `${cellWidth}px` } : {})
          }}
          title={tr("滚轮上下翻看节次，左右滑动切换周次")}
          data-testid="tt-grid"
          onScroll={(e) => {
            const el = e.currentTarget;
            const room = el.scrollHeight - el.clientHeight;
            const top = el.scrollTop > 4;
            const bottom = room - el.scrollTop > 4;
            setScrollEdge((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
          }}
          /* 滚轮：横向手势（触控板两指左右）切周；纵向滚轮交给下方原生监听上下滚动。 */
          onWheel={(e) => {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20) {
              const now = Date.now();
              if (now - lastWheelWeekAt.current < 350) return;
              lastWheelWeekAt.current = now;
              changeWeek(e.deltaX > 0 ? 1 : -1);
            }
          }}
          /* 触摸/拖拽：水平滑动超过阈值才切周，垂直滑动（滚动）不触发。 */
          onPointerDown={(e) => {
            swipeStart.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={(e) => {
            const s = swipeStart.current;
            swipeStart.current = null;
            if (!s) return;
            const dx = e.clientX - s.x;
            const dy = e.clientY - s.y;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) changeWeek(dx < 0 ? 1 : -1);
          }}
        >
          <div className="tt-corner" style={{ gridRow: 1, gridColumn: 1 }}>
            {tr("节次")}
          </div>
          {DAY_NAMES.map((d, i) => (
            <div
              key={d}
              className={`tt-day-head${isThisWeek && todayDay === i + 1 ? " today" : ""}`}
              style={{ gridRow: 1, gridColumn: i + 2 }}
            >
              <span>{tr(`星期${d}`)}</span>
              {weekDates && <span className="tt-day-date">{weekDates[i]}</span>}
              {holidayMarks[i] === "rest" && (
                <span className="tt-holiday-badge rest" title={tr("法定节假日")}>
                  {tr("休")}
                </span>
              )}
              {holidayMarks[i] === "work" && (
                <span className="tt-holiday-badge work" title={tr("调休上班")}>
                  {tr("班")}
                </span>
              )}
            </div>
          ))}
          {sections.map((sec) => (
            <div key={sec} className="tt-sec-label" style={{ gridRow: sec + 1, gridColumn: 1 }}>
              <span className="tt-sec-num">{sec}</span>
              {showTimes && sectionTimes[sec - 1] && <span className="tt-sec-time">{sectionTimes[sec - 1]}</span>}
              {showTimes && sectionTimesEnd[sec - 1] && (
                <span className="tt-sec-time end">{sectionTimesEnd[sec - 1]}</span>
              )}
            </div>
          ))}
          {DAY_NAMES.map((_, di) =>
            sections.map((sec) => {
              const key = `${di + 1}:${sec}`;
              const list = byCell.get(key);
              if (list && list.length) {
                const s = list[0];
                const span = Math.min(s.endSection, maxSection) - s.startSection + 1;
                if (span >= 1) {
                  const [c1, c2] = sessionColors(s);
                  /* 同格多课（本周同时段叠课）：左上角数字角标 + 悬停浮层列出全部课程。 */
                  const multi = list.length > 1;
                  /* W-022 当前节次实时高亮（正在上的课）。 */
                  const live = liveId === s.id && isThisWeek && todayDay === s.day;
                  return (
                    <div
                      key={key}
                      className={`tt-course${multi ? " multi" : ""}${isThisWeek && todayDay === s.day ? " today" : ""}${conflictIds.has(s.id) ? " conflict" : ""}${live ? " live" : ""}`}
                      style={{
                        gridRow: `${sec + 1} / span ${span}`,
                        gridColumn: di + 2,
                        background: `linear-gradient(135deg, color-mix(in srgb, ${c1} 18%, transparent), color-mix(in srgb, ${c2} 27%, transparent))`,
                        borderColor: `color-mix(in srgb, ${c1} 40%, transparent)`
                      }}
                      onMouseEnter={
                        multi
                          ? (e) => {
                              const r = e.currentTarget.getBoundingClientRect();
                              showConflictTip({ x: r.left, y: r.top, list: [...list] });
                            }
                          : undefined
                      }
                      onMouseLeave={multi ? () => closeConflictTip() : undefined}
                      onFocus={
                        multi
                          ? (e) => {
                              const r = e.currentTarget.getBoundingClientRect();
                              showConflictTip({ x: r.left, y: r.top, list: [...list] });
                            }
                          : undefined
                      }
                      onBlur={multi ? () => closeConflictTip() : undefined}
                      title={`${s.name} ${s.weeksLabel ? `· ${s.weeksLabel}` : ""}${s.location ? ` · ${s.location}` : ""}${s.teacher ? ` · ${s.teacher}` : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-label={
                        multi
                          ? `${tr("该时段有 {n} 门课").replace("{n}", String(list.length))}：${list.map((x) => x.name).join("、")}`
                          : undefined
                      }
                      onClick={() => setEditingId(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditingId(s.id);
                        }
                      }}
                      data-interactive
                    >
                      {multi && <div className="tt-course-conflict-badge">{list.length}</div>}
                      <div className="tt-course-name">{s.name}</div>
                      {showLocation && s.location && <div className="tt-course-loc">{s.location}</div>}
                      {showWeeksBadge && s.weeksLabel && <div className="tt-course-weeks">{formatWeeks(s.weeks)}</div>}
                      {live && (
                        <div className="tt-course-live">
                          <span className="tt-course-live-dot" />
                          {tr("距下课 {n} 分钟").replace("{n}", String(Math.max(0, currentSlot!.endMin - nowMin)))}
                        </div>
                      )}
                      <div className="tt-course-edit">
                        <Pencil size={10} />
                      </div>
                    </div>
                  );
                }
              }
              if (covered.has(key)) return null;
              return <div key={key} className="tt-cell" style={{ gridRow: sec + 1, gridColumn: di + 2 }} />;
            })
          )}
        </div>
      )}

      <div className="tt-footer">
        {/* W-022 底部实时状态：正在上课 / 下节课倒计时。 */}
        {isThisWeek && currentSlot
          ? tr("正在上 {name}").replace("{name}", currentSlot.session.name) +
            ` · ${tr("距下课 {n} 分钟").replace("{n}", String(Math.max(0, currentSlot.endMin - nowMin)))}`
          : isThisWeek && nextSlot
            ? tr("下节课 {time} {name}").replace("{time}", nextSlot.start).replace("{name}", nextSlot.session.name) +
              ` · ${tr("{n} 分钟后").replace("{n}", String(Math.max(0, nextSlot.startMin - nowMin)))}`
            : isThisWeek
              ? todayCount > 0
                ? tr("今日 {n} 节课").replace("{n}", String(todayCount))
                : tr("今日无课")
              : tr("查看历史 / 未来周次")}
        {importError && (
          <span className="tt-error">
            <CircleAlert size={12} /> {importError}
          </span>
        )}
      </div>

      {conflictHover &&
        createPortal(
          <div
            className={`tt-conflict-tooltip${tipClosing ? " out" : ""}`}
            style={{ left: conflictHover.x, top: conflictHover.y }}
            role="tooltip"
          >
            <div className="tt-conflict-tooltip-title">
              <CircleAlert size={11} />
              {tr("该时段有 {n} 门课").replace("{n}", String(conflictHover.list.length))}
            </div>
            {conflictHover.list.map((s) => {
              const [c1] = sessionColors(s);
              return (
                <div key={s.id} className="tt-conflict-item">
                  <span className="tt-conflict-item-dot" style={{ background: c1 }} />
                  <div className="tt-conflict-item-body">
                    <div className="tt-conflict-item-name">{s.name}</div>
                    <div className="tt-conflict-item-meta">
                      {s.startSection === s.endSection
                        ? tr("第 {n} 节").replace("{n}", String(s.startSection))
                        : tr("第 {a}-{b} 节")
                            .replace("{a}", String(s.startSection))
                            .replace("{b}", String(s.endSection))}
                      {s.location ? ` · ${s.location}` : ""}
                      {s.teacher ? ` · ${s.teacher}` : ""}
                    </div>
                    {s.weeksLabel && <div className="tt-conflict-item-weeks">{formatWeeks(s.weeks)}</div>}
                  </div>
                </div>
              );
            })}
          </div>,
          document.body
        )}

      {modals}
    </div>
  );
}
