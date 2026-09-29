import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Progress, Skeleton, Tooltip } from "antd";
import { ChartNoAxesCombined, Info, RotateCcw } from "lucide-react";
import { eventsApi } from "@/lib/api";
import { formatDuration, summarizeDailyReview, summarizeDailySchedule } from "@/lib/dailyStatistics";
import { dailyAiSummary } from "@/lib/aiTasks";
import { useFeaturePreferences } from "@/lib/featurePreferences";
import type { AiTask, DailyScheduleSlot, Event } from "@/types";

export default function DailyStatistics({ date, slots, aiTasks = [] }: { date: string; slots: DailyScheduleSlot[]; aiTasks?: AiTask[] }) {
  const { features } = useFeaturePreferences();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    eventsApi.list().then((result) => {
      if (active) setEvents(result);
    }).catch(() => {
      if (active) setFailed(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [date, retry]);
  const stats = useMemo(() => summarizeDailySchedule(slots, events), [slots, events]);
  const review = useMemo(() => summarizeDailyReview(slots), [slots]);
  const ai = dailyAiSummary(aiTasks, slots);

  return <section className="daily-statistics" aria-labelledby="daily-statistics-heading" aria-busy={loading}>
    <header className="daily-statistics-heading">
      <h3 id="daily-statistics-heading"><ChartNoAxesCombined size={18} aria-hidden="true" />数据统计</h3>
      <time dateTime={date}>{date.replace(/-/g, ".")}</time>
    </header>
    {loading ? <Skeleton active title={false} paragraph={{ rows: 3 }} /> : failed ?
      <Alert type="warning" showIcon title="分类统计加载失败" action={<Button size="small" icon={<RotateCcw size={14} />} onClick={() => setRetry((value) => value + 1)}>重试</Button>} /> :
      <div className="daily-statistics-content">
        <div className="daily-statistics-total">
          <span>已安排总时长</span>
          <strong aria-label={`已安排总时长 ${formatDuration(stats.totalMinutes)}`}>
            {Math.floor(stats.totalMinutes / 60)}<small>小时</small>
            {stats.totalMinutes % 60}<small>分钟</small>
          </strong>
          <span>{stats.categories.length} 个分类</span>
        </div>
        <div className="daily-statistics-breakdown">
          {stats.categories.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当日暂无已安排行动" /> : <>
            <div className="daily-statistics-bar" aria-hidden="true">
              {stats.categories.map((category) => <Tooltip key={category.id ?? "uncategorized"} title={`${category.name} · ${formatDuration(category.minutes)} · ${category.percentage}%`}>
                <span style={{ width: `${category.minutes / stats.totalMinutes * 100}%`, backgroundColor: category.color }} />
              </Tooltip>)}
            </div>
            <table className="daily-statistics-table" aria-label="分类时长及占比">
              <colgroup><col /><col className="daily-statistics-duration-column" /><col className="daily-statistics-share-column" /></colgroup>
              <thead><tr><th scope="col">分类</th><th scope="col">时长</th><th scope="col">占比</th></tr></thead>
              <tbody>{stats.categories.map((category) => <tr key={category.id ?? "uncategorized"}>
                <th scope="row"><span className="daily-statistics-category"><i style={{ backgroundColor: category.color }} aria-hidden="true" /><span>{category.name}</span></span></th>
                <td>{formatDuration(category.minutes)}</td>
                <td>{category.percentage}%</td>
              </tr>)}</tbody>
            </table>
          </>}
        </div>
      </div>}
    <div className="daily-review-statistics" aria-label="复盘效率统计">
      <div className="daily-review-metric">
        <Progress type="circle" size={70} strokeWidth={7} strokeColor="#16846c"
          percent={review.efficientPercentage ?? 0} status="normal"
          format={() => review.efficientPercentage === null ? "--" : `${review.efficientPercentage}%`} />
        <div><span className="daily-review-metric-label">高效时段占比<Tooltip title={`已复盘中，同时标记为专注且达到预期的时间段占比；按时间段时长计算${features.aiParallel ? "，不含并行 AI 时长" : ""}。`}><Info size={13} tabIndex={0} aria-label="高效时段占比口径" /></Tooltip></span>
          <strong>{review.reviewedMinutes ? formatDuration(review.efficientMinutes) : "暂无复盘"}</strong>
          <span>已复盘 {formatDuration(review.reviewedMinutes)}</span>
        </div>
      </div>
      <div className="daily-review-metric">
        <Progress type="circle" size={70} strokeWidth={7} strokeColor="#437ec4"
          percent={review.reviewCoverage ?? 0} status="normal"
          format={() => review.reviewCoverage === null ? "--" : `${review.reviewCoverage}%`} />
        <div><span className="daily-review-metric-label">复盘覆盖率<Tooltip title="已完整填写复盘的时长占已安排时长的比例。尚未复盘的时间不会被判为低效。"><Info size={13} tabIndex={0} aria-label="复盘覆盖率口径" /></Tooltip></span>
          <strong>{formatDuration(review.reviewedMinutes)}</strong>
          <span>未复盘 {formatDuration(review.plannedMinutes - review.reviewedMinutes)}</span>
        </div>
      </div>
    </div>
    {features.aiParallel && ai.count > 0 && <div className="daily-ai-statistics" aria-label="AI 任务统计">
      <span>AI 任务 <strong>{ai.count}</strong> 项</span>
      <span>已安排时长 <strong>{formatDuration(ai.minutes)}</strong></span>
      {ai.untimed > 0 && <span>未设时间 {ai.untimed} 项</span>}
    </div>}
  </section>;
}
