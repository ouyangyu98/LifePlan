import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { Alert, Button, Empty, Select, Skeleton, Tooltip, Typography } from "antd";
import { Check, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import MarkdownEditor from "@/components/ui/MarkdownEditor";
import { formatDuration } from "@/lib/dailyStatistics";
import { userFacingError } from "@/lib/errors";
import { loadWeeklyRecords, loadWeeklySummary, saveWeeklySummary } from "@/lib/weeklySummaryPersistence";
import type { WeeklyRecord, WeeklySummary as WeeklySummaryData } from "@/types";

const PAGE_SIZE = 12;

type NoteSession = {
  weekStart: string;
  spaceId: string;
  content: string;
  savedContent: string;
  revision: number;
  pendingWrites: number;
};

const weekStartOf = (value: dayjs.Dayjs) => value.startOf("week").format("YYYY-MM-DD");
const weekEndOf = (weekStart: string) => dayjs(weekStart).add(6, "day").format("YYYY-MM-DD");
const weekRange = (weekStart: string) => `${dayjs(weekStart).format("M月D日")} - ${dayjs(weekEndOf(weekStart)).format("M月D日")}`;
const notePreview = (content: string) => content.replace(/[#>*_`~-]/g, "").replace(/\s+/g, " ").trim() || "尚未写下本周思考";

export default function WeeklySummary() {
  const [weekStart, setWeekStart] = useState(() => weekStartOf(dayjs()));
  const [summary, setSummary] = useState<WeeklySummaryData | null>(null);
  const [records, setRecords] = useState<WeeklyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const [content, setContent] = useState("");
  const requestId = useRef(0);
  const mounted = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const session = useRef<NoteSession | null>(null);

  const draftKey = (spaceId: string, sessionWeekStart: string) => `lifeplan-weekly-summary-draft:${spaceId}:${sessionWeekStart}`;

  const updateRecord = (next: WeeklySummaryData) => {
    setRecords((current) => {
      const record: WeeklyRecord = {
        week_start: next.week_start,
        content: next.content,
        updated_at: next.updated_at,
        total_minutes: next.total_minutes,
      };
      const withoutCurrent = current.filter((item) => item.week_start !== next.week_start);
      return [...withoutCurrent, record].sort((a, b) => b.week_start.localeCompare(a.week_start));
    });
  };

  const flush = async (target = session.current) => {
    if (!target || !target.spaceId || (target.content === target.savedContent && target.pendingWrites === 0)) return;
    const contentToSave = target.content;
    const savingRevision = target.revision;
    target.pendingWrites += 1;
    if (mounted.current && target === session.current) setSaving(true);
    try {
      const savedSummary = await saveWeeklySummary(target.weekStart, contentToSave, target.spaceId);
      target.savedContent = contentToSave;
      if (savingRevision === target.revision && localStorage.getItem(draftKey(target.spaceId, target.weekStart)) === contentToSave) {
        localStorage.removeItem(draftKey(target.spaceId, target.weekStart));
      }
      if (mounted.current && target === session.current) {
        setSummary(savedSummary);
        setSaved(contentToSave === target.content);
        setError("");
        updateRecord(savedSummary);
      }
    } catch (cause) {
      if (mounted.current && target === session.current) setError(userFacingError(cause));
    } finally {
      target.pendingWrites -= 1;
      if (mounted.current && target === session.current) setSaving(target.pendingWrites > 0);
    }
  };

  const loadRecords = async (beforeWeekStart?: string, append = false) => {
    if (!append) setRecordsLoading(true);
    try {
      const next = await loadWeeklyRecords(beforeWeekStart);
      setRecords((current) => {
        const combined = append ? [...current, ...next] : next;
        const unique = new Map(combined.map((record) => [record.week_start, record]));
        return [...unique.values()].sort((a, b) => b.week_start.localeCompare(a.week_start));
      });
      setHasMore(next.length === PAGE_SIZE);
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      if (!append) setRecordsLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void loadRecords();
    const onHide = () => { if (document.visibilityState === "hidden") void flush(); };
    const onLeave = () => { void flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      mounted.current = false;
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onLeave);
      void flush();
    };
  }, []);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setSaving(false);
    setSaved(false);
    setError("");
    void loadWeeklySummary(weekStart)
      .then((nextSummary) => {
        if (!mounted.current || currentRequest !== requestId.current) return;
        let draft: string | null = null;
        try { draft = localStorage.getItem(draftKey(nextSummary.space_id, nextSummary.week_start)); } catch { /* 数据库仍是权威来源。 */ }
        const nextContent = draft ?? nextSummary.content;
        const nextSession: NoteSession = {
          weekStart: nextSummary.week_start,
          spaceId: nextSummary.space_id,
          content: nextContent,
          savedContent: nextSummary.content,
          revision: 0,
          pendingWrites: 0,
        };
        session.current = nextSession;
        setSummary(nextSummary);
        setContent(nextContent);
        setSaved(draft === null || draft === nextSummary.content);
        if (draft !== null && draft !== nextSummary.content) void flush(nextSession);
      })
      .catch((cause) => {
        if (mounted.current && currentRequest === requestId.current) setError(userFacingError(cause));
      })
      .finally(() => {
        if (mounted.current && currentRequest === requestId.current) setLoading(false);
      });
  }, [weekStart]);

  const selectWeek = (nextWeekStart: string) => {
    if (nextWeekStart === weekStart) return;
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    void flush();
    setWeekStart(nextWeekStart);
  };

  const save = (nextContent: string) => {
    const activeSession = session.current;
    if (!activeSession) return;
    activeSession.revision += 1;
    activeSession.content = nextContent;
    setContent(nextContent);
    setSaved(false);
    try {
      localStorage.setItem(draftKey(activeSession.spaceId, activeSession.weekStart), nextContent);
    } catch {
      setError("本地草稿暂存失败，正在直接保存到数据库。");
      void flush(activeSession);
    }
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void flush(activeSession); }, 400);
  };

  const olderWeek = records.length ? records[records.length - 1].week_start : undefined;
  const recordsWithSelected = useMemo(() => {
    if (records.some((record) => record.week_start === weekStart)) return records;
    return [{ week_start: weekStart, content: summary?.content ?? "", updated_at: summary?.updated_at ?? 0, total_minutes: summary?.total_minutes ?? 0 }, ...records]
      .sort((a, b) => b.week_start.localeCompare(a.week_start));
  }, [records, weekStart, summary]);

  const stats = summary;
  return <div className="page weekly-summary-page">
    <header className="page-header weekly-summary-header">
      <div>
        <Typography.Title level={2} className="page-title">周总结</Typography.Title>
        <Typography.Paragraph className="page-subtitle">按已安排的时间段回看一周节奏，并写下自己的思考。</Typography.Paragraph>
      </div>
      <div className="weekly-summary-navigation" aria-label="周次导航">
        <Tooltip title="上一周"><Button aria-label="上一周" icon={<ChevronLeft size={16} />} onClick={() => selectWeek(dayjs(weekStart).subtract(1, "week").format("YYYY-MM-DD"))} /></Tooltip>
        <Button onClick={() => selectWeek(weekStartOf(dayjs()))}>本周</Button>
        <Tooltip title="下一周"><Button aria-label="下一周" icon={<ChevronRight size={16} />} onClick={() => selectWeek(dayjs(weekStart).add(1, "week").format("YYYY-MM-DD"))} /></Tooltip>
      </div>
    </header>

    {error && <Alert className="page-alert" type="error" showIcon message={error} action={<Button onClick={() => void (summary ? flush() : window.location.reload())}>重试</Button>} />}

    <div className="weekly-summary-mobile-selector">
      <Select aria-label="选择周记录" value={weekStart} onChange={selectWeek} options={recordsWithSelected.map((record) => ({
        value: record.week_start,
        label: `${weekRange(record.week_start)} · ${formatDuration(record.total_minutes)}`,
      }))} />
    </div>

    <div className="weekly-summary-layout">
      <aside className="weekly-summary-history" aria-label="周记录">
        <div className="weekly-summary-history-heading"><span>最近周记录</span><span>{recordsLoading ? "读取中…" : `${records.length} 周`}</span></div>
        <div className="weekly-summary-records">
          {recordsLoading ? <Skeleton active title={false} paragraph={{ rows: 4 }} /> : records.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有周记录" /> : records.map((record) => (
            <button type="button" key={record.week_start} className={`weekly-summary-record${record.week_start === weekStart ? " is-selected" : ""}`} onClick={() => selectWeek(record.week_start)}>
              <span className="weekly-summary-record-range">{weekRange(record.week_start)}</span>
              <span className="weekly-summary-record-meta">{formatDuration(record.total_minutes)}</span>
              <span className="weekly-summary-record-preview">{notePreview(record.content)}</span>
            </button>
          ))}
        </div>
        {hasMore && olderWeek && <Button type="link" className="weekly-summary-more" onClick={() => void loadRecords(olderWeek, true)}>查看更多历史</Button>}
      </aside>

      <main className="weekly-summary-detail">
        <section className="weekly-summary-overview" aria-labelledby="weekly-summary-heading" aria-busy={loading}>
          <header className="weekly-summary-detail-heading">
            <div><h3 id="weekly-summary-heading">{weekRange(weekStart)}</h3><span>{weekStart === weekStartOf(dayjs()) ? "本周" : "周计划回顾"}</span></div>
            <span className="weekly-summary-save-state" aria-live="polite">
              {error ? "保存异常" : loading ? "正在读取…" : saving ? <><LoaderCircle size={14} className="insights-saving-icon" />正在保存</> : saved ? <><Check size={14} />已保存</> : "待保存"}
            </span>
          </header>
          {loading ? <Skeleton active title={false} paragraph={{ rows: 4 }} /> : <>
            <div className="weekly-summary-statistics">
              <div className="weekly-summary-total">
                <span>本周已安排</span>
                <strong aria-label={`本周已安排 ${formatDuration(stats?.total_minutes ?? 0)}`}>{formatDuration(stats?.total_minutes ?? 0)}</strong>
                <span>{stats?.categories.length ?? 0} 个分类</span>
              </div>
              <div className="weekly-summary-breakdown">
                {!stats?.categories.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本周暂无已安排行动" /> : <>
                  <div className="daily-statistics-bar" aria-hidden="true">{stats.categories.map((category) => <Tooltip key={category.id ?? "uncategorized"} title={`${category.name} · ${formatDuration(category.minutes)} · ${category.percentage}%`}><span style={{ width: `${category.percentage}%`, backgroundColor: category.color }} /></Tooltip>)}</div>
                  <table className="daily-statistics-table" aria-label="本周分类时长及占比">
                    <colgroup><col /><col className="daily-statistics-duration-column" /><col className="daily-statistics-share-column" /></colgroup>
                    <thead><tr><th scope="col">分类</th><th scope="col">时长</th><th scope="col">占比</th></tr></thead>
                    <tbody>{stats.categories.map((category) => <tr key={category.id ?? "uncategorized"}>
                      <th scope="row"><span className="daily-statistics-category"><i style={{ backgroundColor: category.color }} aria-hidden="true" /><span>{category.name}</span></span></th>
                      <td>{formatDuration(category.minutes)}</td><td>{category.percentage}%</td>
                    </tr>)}</tbody>
                  </table>
                </>}
              </div>
            </div>
          </>}
        </section>

        <section className="weekly-summary-notes" aria-labelledby="weekly-summary-notes-heading">
          <header><div><h3 id="weekly-summary-notes-heading">本周思考</h3><span>写下值得保留的发现、判断和下一步。</span></div></header>
          {loading ? <Skeleton active title={false} paragraph={{ rows: 6 }} /> : summary && <MarkdownEditor value={content} onChange={save} placeholder="写下这一周的思考…" minHeight={300} showToolbar />}
        </section>
      </main>
    </div>
  </div>;
}
