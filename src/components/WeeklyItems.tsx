import { useMemo, useState } from "react";
import dayjs from "dayjs";
import { Button, Empty, Input, Modal, Segmented, Tag, Tooltip } from "antd";
import { ArrowUpRight, Bot, Check, ChevronDown, ChevronUp, Circle, CircleCheck, ClipboardList, Info, Search } from "lucide-react";
import { formatDuration } from "@/lib/dailyStatistics";
import { useFeaturePreferences } from "@/lib/featurePreferences";
import type { WeeklyAction } from "@/types";

const PREVIEW_LIMIT = 8;
const statusLabel = (item: WeeklyAction) => item.status === 1 ? "已完成" : item.status === 2 ? "已放弃" : "待完成";

export default function WeeklyItems({ items }: { items: WeeklyAction[] }) {
  const { features } = useFeaturePreferences();
  const [view, setView] = useState<"handled" | "completed">("handled");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const arrangementsOf = (item: WeeklyAction) => item.arrangements.filter((entry) => features.aiParallel || !entry.parallel);
  const handled = items.filter((item) => arrangementsOf(item).length > 0);
  const completed = items.filter((item) => item.completed_in_week);
  const source = view === "handled" ? handled : completed;
  const query = search.trim().toLocaleLowerCase();
  const filtered = source.filter((item) => [item.title, item.event_title, item.category_name]
    .some((value) => value?.toLocaleLowerCase().includes(query)));
  const sorted = [...filtered].sort((a, b) => view === "completed"
    ? (b.completed_at ?? 0) - (a.completed_at ?? 0) || a.id - b.id
    : b.planned_minutes - a.planned_minutes || a.id - b.id);
  const visible = expanded ? sorted : sorted.slice(0, PREVIEW_LIMIT);
  const groups = useMemo(() => {
    const result = new Map<number | null, { title: string; category: string | null; color: string | null; items: WeeklyAction[] }>();
    for (const item of visible) {
      const group = result.get(item.event_id) ?? {
        title: item.event_title ?? "独立行动", category: item.category_name, color: item.category_color, items: [],
      };
      group.items.push(item);
      result.set(item.event_id, group);
    }
    return [...result.entries()];
  }, [visible]);
  const selected = items.find((item) => item.id === selectedId);
  return <section className="weekly-items" aria-labelledby="weekly-items-heading">
    <header className="weekly-items-heading">
      <h3 id="weekly-items-heading">本周事项</h3>
      <Tooltip title={`本周处理：本周安排过的行动${features.aiParallel ? "，含并行 AI" : ""}，按行动去重，不代表已完成。本周完成：完成日期在本周、且当前仍为已完成的行动，包含未排入日程的行动。`}>
        <Info size={14} tabIndex={0} aria-label="本周事项统计口径" />
      </Tooltip>
    </header>
    <div className="weekly-items-toolbar">
      <Segmented<"handled" | "completed"> aria-label="事项范围" value={view} onChange={(value) => { setView(value); setExpanded(false); }}
        options={[
          { value: "handled", icon: <ClipboardList size={14} />, label: `本周处理 ${handled.length}` },
          { value: "completed", icon: <CircleCheck size={14} />, label: `本周完成 ${completed.length}` },
        ]} />
      <Input aria-label="搜索本周事项" placeholder="搜索事项、事件或分类" prefix={<Search size={14} />} allowClear
        value={search} onChange={(event) => { setSearch(event.target.value); setExpanded(false); }} />
    </div>
    {groups.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={query ? "没有匹配的事项" : view === "handled" ? "本周暂无已安排行动" : "本周暂无完成事项"} /> :
      <div className="weekly-items-groups">{groups.map(([id, group]) => <div className="weekly-items-group" key={id ?? "standalone"}>
        <div className="weekly-items-group-heading"><h4>{group.title}</h4>
          {group.category && <span className="weekly-items-category"><i style={{ background: group.color ?? "#8c98a5" }} />{group.category}</span>}
        </div>
        <ul>{group.items.map((item) => {
          const entries = arrangementsOf(item);
          const dates = [...new Set(entries.map((entry) => entry.list_date))];
          return <li key={item.id}><button type="button" className="weekly-item-row" aria-label={`查看事项：${item.title}`} onClick={() => setSelectedId(item.id)}>
            <span className={`weekly-item-status status-${item.status}`} aria-label={statusLabel(item)}>
              {item.status === 1 ? <CircleCheck size={17} /> : item.status === 2 ? <Circle size={17} strokeDasharray="3 3" /> : <Circle size={17} />}
            </span>
            <span className="weekly-item-content"><span className="weekly-item-title">{item.title}</span>
              <span className="weekly-item-meta">{view === "completed" && item.completed_at
                ? `${dayjs(item.completed_at).format("M月D日")}完成`
                : statusLabel(item)}
                <span aria-hidden="true"> · </span>
                {dates.length ? `${dates.length} 天 / ${entries.length} 次安排` : "未排入本周日程"}
              </span>
            </span>
            <span className="weekly-item-duration">{item.planned_minutes > 0 ? formatDuration(item.planned_minutes)
              : entries.some((entry) => entry.parallel) ? <><Bot size={13} />并行</> : "—"}</span>
            <ArrowUpRight size={14} className="weekly-item-open" aria-hidden="true" />
          </button></li>;
        })}</ul>
      </div>)}</div>}
    {sorted.length > PREVIEW_LIMIT && <Button type="link" className="weekly-items-expand"
      icon={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />} onClick={() => setExpanded(!expanded)}>
      {expanded ? "收起事项" : `展开其余 ${sorted.length - PREVIEW_LIMIT} 项`}
    </Button>}
    <Modal open={Boolean(selected)} title="事项详情" onCancel={() => setSelectedId(null)} destroyOnHidden
      footer={<Button onClick={() => setSelectedId(null)}>关闭</Button>} className="weekly-item-modal">
      {selected && <>
        <h4 className="weekly-item-detail-title">{selected.title}</h4>
        <div className="weekly-item-detail-meta"><Tag color={selected.status === 1 ? "green" : undefined}>{statusLabel(selected)}</Tag>
          <span>{selected.event_title ?? "独立行动"}</span>
          {selected.completed_at && selected.status === 1 && <span><Check size={13} />{dayjs(selected.completed_at).format("YYYY年M月D日 HH:mm")}完成</span>}
        </div>
        {selected.description && <p className="weekly-item-description">{selected.description}</p>}
        <div className="weekly-item-arrangements-heading"><h4>本周安排与复盘</h4>
          {selected.planned_minutes > 0 && <span>主行动 {formatDuration(selected.planned_minutes)}</span>}
        </div>
        {arrangementsOf(selected).length ? <ol className="weekly-item-arrangements">{arrangementsOf(selected).map((entry, index) =>
          <li key={index}><div><time dateTime={entry.list_date}>{dayjs(entry.list_date).format("M月D日")}</time>
            <span>{entry.start_time}–{entry.end_time}</span>{entry.parallel && <Tag icon={<Bot size={12} />}>AI 并行</Tag>}</div>
            <p className={!entry.actual_notes?.trim() ? "is-empty" : undefined}>{entry.actual_notes?.trim() || "暂无复盘记录"}</p>
          </li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未排入本周日程" />}
      </>}
    </Modal>
  </section>;
}
