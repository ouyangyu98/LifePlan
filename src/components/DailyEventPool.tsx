import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Input, Modal, Progress, Select, Tag, Tooltip } from "antd";
import { CalendarPlus, ChevronUp, GripVertical, Plus, Search, Unlink } from "lucide-react";
import { dailyEventPoolApi, eventsApi } from "@/lib/api";
import { userFacingError } from "@/lib/errors";
import type { Action, DailyEventPool as Pool, DailySchedule, DailyScheduleSlot, Event } from "@/types";

export const POOL_DRAG_TYPE = "application/x-lifeplan-pool-action";
export const actionLabel = (action: Action) => action.event_title ? `${action.event_title} - ${action.title}` : action.title;

export function useDailyEventPool(date: string, revision: DailySchedule | null) {
  const [data, setData] = useState<Pool | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const currentDate = useRef(date);
  currentDate.current = date;
  const saveBusy = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    dailyEventPoolApi.get(date).then((next) => {
      if (!next || next.list_date !== date) throw Error("今日事件池读取失败，请重试");
      if (active) { setData(next); setError(""); }
    }).catch((cause) => {
      if (active) setError(userFacingError(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date, revision, retry]);
  const snapshot = data?.list_date === date ? data : null;
  const save = async (eventIds: number[]) => {
    if (!snapshot || saveBusy.current) throw Error("事件池正在更新，请稍后重试");
    saveBusy.current = true;
    setSaving(true);
    try {
      const next = await dailyEventPoolApi.save(date, snapshot.space_id, eventIds);
      if (currentDate.current === date) { setData(next); setError(""); }
    } catch (cause) {
      if (currentDate.current === date) setError(userFacingError(cause));
      throw cause;
    } finally { saveBusy.current = false; setSaving(false); }
  };
  const actions = snapshot?.entries.flatMap((entry) => entry.actions.filter((action) => action.status !== 2)) ?? [];
  return {
    data: snapshot, error, loading, saving, save,
    completed: actions.filter((action) => action.status === 1).length, total: actions.length,
    refresh: () => setRetry((value) => value + 1),
  };
}

export default function DailyEventPool({ pool, slots, assigning, onClose, onDrag, onAssign, onActionStatus, onOpenInbox }: {
  pool: ReturnType<typeof useDailyEventPool>; slots: DailyScheduleSlot[]; assigning: boolean;
  onClose: () => void; onDrag: (action: Action | null) => void;
  onAssign: (actionId: number, slotId: number) => Promise<void>;
  onActionStatus: (action: Action, completed: boolean) => Promise<void>; onOpenInbox: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [events, setEvents] = useState<Event[]>([]);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<number[]>([]);
  const [pickerError, setPickerError] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [targetAction, setTargetAction] = useState<Action | null>(null);
  const [targetSlot, setTargetSlot] = useState<number>();
  const [assignError, setAssignError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [updatingAction, setUpdatingAction] = useState<number | null>(null);
  const statusBusy = useRef(false);
  const pickerRequest = useRef(0);
  useEffect(() => () => { pickerRequest.current += 1; }, []);
  const disabled = pool.loading || pool.saving || assigning || updatingAction !== null || Boolean(pool.error);
  const changeStatus = async (action: Action, completed: boolean) => {
    if (statusBusy.current) return;
    statusBusy.current = true;
    setUpdatingAction(action.id);
    setStatusError("");
    try { await onActionStatus(action, completed); }
    catch (cause) { setStatusError(userFacingError(cause)); }
    finally { statusBusy.current = false; setUpdatingAction(null); }
  };
  const openPicker = async () => {
    const request = ++pickerRequest.current;
    setPickerOpen(true); setPickerLoading(true); setPickerError(""); setChosen([]); setQuery("");
    try {
      const next = await eventsApi.list();
      if (request === pickerRequest.current) setEvents(next.filter((event) => event.status === 1));
    } catch (cause) {
      if (request === pickerRequest.current) setPickerError(userFacingError(cause));
    } finally { if (request === pickerRequest.current) setPickerLoading(false); }
  };
  const emptySlots = slots.filter((slot) => !slot.action_id && !slot.actual_notes?.trim() && slot.focused == null && slot.met_expectation == null);
  const entries = pool.data?.entries ?? [];
  const availableEvents = events.filter((event) => !pool.data?.event_ids.includes(event.id)
    && [event.title, event.category_name].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase())));
  const percent = pool.total ? Math.round(pool.completed / pool.total * 100) : 0;
  return <section id="daily-event-pool" className="daily-event-pool" aria-label="今日事件池">
    <header className="daily-pool-heading">
      <div><strong>今日事件池</strong><Tooltip title="池内事件的行动完成进度，不含已放弃行动；完成状态来自事件篮，不代表仅在当天完成。">
        <span className="daily-pool-progress-label">行动完成 {pool.completed}/{pool.total}</span>
      </Tooltip><Progress percent={percent} showInfo={false} size="small" /></div>
      <div><Button icon={<Plus size={14} />} disabled={disabled || !pool.data} onClick={() => void openPicker()}>添加事件</Button>
        <Tooltip title="收起事件池"><Button type="text" aria-label="收起今日事件池" icon={<ChevronUp size={16} />} onClick={onClose} /></Tooltip></div>
    </header>
    {pool.error && <Alert type="error" showIcon message={pool.error} action={<Button onClick={pool.refresh}>重试</Button>} />}
    {statusError && <Alert type="error" showIcon message={statusError} closable onClose={() => setStatusError("")} />}
    {pool.loading && !pool.data ? <div className="daily-pool-empty">正在加载…</div> : entries.length === 0 && !pool.error
      ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未添加事件" /> :
      <div className="daily-pool-events">{entries.map(({ event, actions }) => {
        const active = actions.filter((action) => action.status !== 2);
        const completed = active.filter((action) => action.status === 1).length;
        return <div className="daily-pool-event" key={event.id}>
          <div className="daily-pool-event-heading"><span className="daily-pool-event-name">{event.title}</span>
            {event.status !== 1 && <Tag>{event.status === 5 ? "事件已完成" : event.status === 3 ? "已推迟" : "不可安排"}</Tag>}
            {event.category_name && <Tag color={event.category_color}>{event.category_name}</Tag>}
            <span className="daily-pool-event-progress">{completed}/{active.length}</span>
            <Tooltip title="移出今日池，保留事件和已安排的时间段"><Button type="text" size="small" aria-label={`移出今日池：${event.title}`} icon={<Unlink size={14} />}
              disabled={disabled} onClick={() => void pool.save(pool.data!.event_ids.filter((id) => id !== event.id)).catch(() => undefined)} /></Tooltip>
          </div>
          {active.length === 0 ? <span className="daily-pool-no-actions">暂无可安排的行动</span> : <ul>{active.map((action) => {
            const canAssign = !disabled && event.status === 1 && action.status === 0;
            const count = slots.filter((slot) => slot.action_id === action.id).length;
            return <li key={action.id} className={action.status === 1 ? "is-completed" : undefined}>
              <Checkbox className="daily-pool-complete" aria-label={`${action.status === 1 ? "恢复" : "完成"}行动：${actionLabel(action)}`}
                checked={action.status === 1} disabled={disabled || event.status !== 1}
                aria-busy={updatingAction === action.id}
                onChange={(change) => void changeStatus(action, change.target.checked)} />
              <div className="daily-pool-action" draggable={canAssign} aria-label={`拖动行动：${actionLabel(action)}`}
                onDragStart={(drag) => {
                  if (!canAssign) { drag.preventDefault(); return; }
                  drag.dataTransfer.effectAllowed = "copy";
                  drag.dataTransfer.setData(POOL_DRAG_TYPE, JSON.stringify({ actionId: action.id, date: pool.data!.list_date, spaceId: pool.data!.space_id }));
                  onDrag(action);
                }} onDragEnd={() => onDrag(null)}>
                {action.status !== 1 && <GripVertical size={14} />}
                <span title={actionLabel(action)}>{action.title}</span>
              </div>
              {count > 0 && <span className="daily-pool-scheduled">{count} 个时段</span>}
              <Tooltip title={action.status === 1 ? "行动已完成" : "安排到时间段"}>
                <Button type="text" size="small" aria-label={`安排到时间段：${actionLabel(action)}`} icon={<CalendarPlus size={14} />} disabled={!canAssign}
                  onClick={() => { setTargetAction(action); setTargetSlot(undefined); setAssignError(""); }} />
              </Tooltip>
            </li>;
          })}</ul>}
        </div>;
      })}</div>}
    <Modal open={pickerOpen} title="添加事件到今日池" onCancel={() => setPickerOpen(false)} destroyOnHidden
      okText="添加到今日池" cancelText="取消" confirmLoading={pool.saving}
      okButtonProps={{ disabled: !chosen.length || pickerLoading || Boolean(pickerError) }}
      onOk={() => void pool.save([...pool.data!.event_ids, ...chosen]).then(() => setPickerOpen(false)).catch(() => undefined)}>
      {pickerError && <Alert type="error" showIcon message={pickerError} action={<Button onClick={() => void openPicker()}>重试</Button>} />}
      <Input aria-label="搜索事件" placeholder="搜索事件或分类" prefix={<Search size={14} />} value={query} allowClear onChange={(event) => setQuery(event.target.value)} />
      <div className="daily-pool-picker">
        {pickerLoading ? "正在加载…" : availableEvents.map((event) =>
          <Checkbox key={event.id} checked={chosen.includes(event.id)} onChange={(value) =>
            setChosen((current) => value.target.checked ? [...current, event.id] : current.filter((id) => id !== event.id))}>
            <span>{event.title}</span>{event.category_name && <Tag color={event.category_color}>{event.category_name}</Tag>}
          </Checkbox>)}
        {!pickerLoading && availableEvents.length === 0
          && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可添加的进行中事件" />}
      </div>
      <Button type="link" onClick={onOpenInbox}>去事件篮</Button>
    </Modal>
    <Modal open={Boolean(targetAction)} title={`安排行动 · ${targetAction?.title ?? ""}`} destroyOnHidden onCancel={() => setTargetAction(null)}
      okText="确认安排" cancelText="取消" confirmLoading={assigning} okButtonProps={{ disabled: targetSlot == null }}
      onOk={async () => {
        if (!targetAction || targetSlot == null) return;
        try { await onAssign(targetAction.id, targetSlot); setTargetAction(null); }
        catch (cause) { setAssignError(userFacingError(cause)); }
      }}>
      {assignError && <Alert type="error" showIcon message={assignError} />}
      <Select aria-label="选择空时间段" className="full-width" placeholder="选择空时间段" value={targetSlot} onChange={setTargetSlot}
        options={emptySlots.map((slot) => ({ value: slot.id, label: `${slot.start_time}–${slot.end_time}` }))} />
      {emptySlots.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无空时间段" />}
    </Modal>
  </section>;
}
