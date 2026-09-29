import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { Alert, Button, Checkbox, DatePicker, Empty, Form, Input, InputNumber, Modal as AntModal, Popconfirm, Select, Space, Tag, Tooltip, Dropdown, Typography, Radio, message } from "antd";
import { ArrowRight, Bot, CalendarDays, ChevronDown, ChevronUp, FileText, GripVertical, ListChecks, Pencil, Plus, RotateCcw, ListTree, Rows3, Unlink } from "lucide-react";
import { actionsApi, aiTasksApi, dailyScheduleApi, eventsApi, recurringActionsApi } from "@/lib/api";
import type { Action, AiTask, DailySchedule, DailyScheduleSlot, DailyTemplateSlot, NewAction, NewRecurringAction, RecurringAction, UpdateRecurringAction } from "@/types";
import { userFacingError } from "@/lib/errors";
import WorkLogModal from "@/components/ui/WorkLogModal";
import DailyStatistics from "@/components/DailyStatistics";
import DailyAiTaskEditor, { type AiTaskSelection } from "@/components/DailyAiTaskEditor";
import { aiTasksBySlot, aiTaskStatuses } from "@/lib/aiTasks";
import { useDailyAiTasks } from "@/lib/useDailyAiTasks";
import { track } from "@/lib/analytics";
import { sortDailyActions } from "@/lib/dailyActionSort";
import { useFeaturePreferences } from "@/lib/featurePreferences";
import { suggestedEndTime } from "@/lib/dailyScheduleTime";

const today = () => dayjs().format("YYYY-MM-DD");
const formatTime = (value: string) => value;
const minutesBetween = (start: string, end: string) => { const [sh, sm] = start.split(":").map(Number); const [eh, em] = end.split(":").map(Number); return (eh * 60 + em) - (sh * 60 + sm); };
const slotLabel = (slot: DailyScheduleSlot) => `${formatTime(slot.start_time)}-${formatTime(slot.end_time)}`;
const pickerTime = (value: string) => dayjs("2000-01-01T00:00").add(minutesBetween("00:00", value), "minute");
const formatPickerTime = (value: Dayjs) => value.isSame(dayjs("2000-01-02"), "day") ? "24:00" : value.format("HH:mm");
const weekdayNames = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const ACTION_VIEW_STORAGE_KEY = "lifeplan-daily-action-picker-view";
const HALF_HOUR_TIMES = Array.from({ length: 48 }, (_, index) => {
  const minutes = index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});
const toHalfHourTime = (value: Dayjs) => {
  const roundedMinutes = value.minute() < 15 ? 0 : value.minute() < 45 ? 30 : 0;
  const hour = value.minute() >= 45 ? value.hour() + 1 : value.hour();
  return `${String(hour % 24).padStart(2, "0")}:${String(roundedMinutes).padStart(2, "0")}`;
};

export default function DailyList() {
  const { features } = useFeaturePreferences();
  const [date, setDate] = useState(today);
  const ai = useDailyAiTasks(date, features.aiParallel);
  const [aiSelection, setAiSelection] = useState<AiTaskSelection | null>(null);
  const [aiRecordSelection, setAiRecordSelection] = useState<AiTaskSelection | null>(null);
  const [aiPickerSlot, setAiPickerSlot] = useState<DailyScheduleSlot | null>(null);
  const [schedule, setSchedule] = useState<DailySchedule | null>(null);
  const [usedDates, setUsedDates] = useState<Set<string>>(() => new Set());
  const [selectedSlot, setSelectedSlot] = useState<DailyScheduleSlot | null>(null);
  const [timeSlot, setTimeSlot] = useState<DailyScheduleSlot | null>(null);
  const [pickerSlot, setPickerSlot] = useState<DailyScheduleSlot | null>(null);
  const [insertPreset, setInsertPreset] = useState<{ startTime?: string; endTime?: string } | null>(null);
  const [workLogOpen, setWorkLogOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const loadVersion = useRef(0);
  const navigate = useNavigate();
  const location = useLocation();

  const load = async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    try {
      const [nextSchedule, usedDateList] = await Promise.all([dailyScheduleApi.get(date), dailyScheduleApi.usedDates()]);
      if (version !== loadVersion.current) return;
      setSchedule(nextSchedule); setUsedDates(new Set(usedDateList)); setError("");
    } catch (cause) {
      if (version === loadVersion.current) setError(userFacingError(cause));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  };
  useEffect(() => { void load(); return () => { loadVersion.current += 1; }; }, [date]);
  useEffect(() => { setAiSelection(null); setAiRecordSelection(null); setAiPickerSlot(null); setPickerSlot(null); }, [date, features.aiParallel]);
  useEffect(() => {
    const reviewActionId = (location.state as { reviewActionId?: number } | null)?.reviewActionId;
    if (!reviewActionId || loading || !schedule || date !== today()) return;
    const reviewSlot = schedule.slots.find((slot) => slot.action_id === reviewActionId || slot.action?.id === reviewActionId);
    if (reviewSlot) setSelectedSlot(reviewSlot);
    navigate(location.pathname, { replace: true, state: null });
  }, [date, loading, location.pathname, location.state, navigate, schedule]);
  const slots = schedule?.slots ?? [];
  const weekdayName = weekdayNames[dayjs(date).day()];
  const isToday = date === today();
  const refreshSlot = (slot: DailyScheduleSlot) => setSchedule((current) => current?.list_date === slot.list_date ? {
    ...current,
    slots: current.slots.map((item) => {
      if (item.id === slot.id) return slot;
      // Action state is shared; reviews remain specific to each time slot.
      return slot.action && item.action_id === slot.action.id ? { ...item, action: slot.action } : item;
    }),
  } : current);
  const attachAiAction = async (action: Action) => {
    if (!features.aiParallel) return;
    if (aiSelection) {
      const updated = await aiTasksApi.replace(aiSelection.task.id, action.id, aiSelection.task.updated_at);
      ai.remove(aiSelection.task);
      ai.upsert(updated);
      setAiSelection(null);
      message.success("AI 行动已更换");
      return;
    }
    if (!aiPickerSlot?.action) return;
    const task = await aiTasksApi.create({
      slot_id: aiPickerSlot.id,
      action_id: aiPickerSlot.action.id, linked_action_id: action.id, list_date: aiPickerSlot.list_date,
      status: "queued", start_time: aiPickerSlot.start_time, end_time: aiPickerSlot.end_time, result: "",
    });
    ai.upsert(task);
    setAiPickerSlot(null);
    message.success("AI 任务已挂载");
  };
  const removeAction = async () => {
    if (aiSelection) {
      await aiTasksApi.delete(aiSelection.task.id, aiSelection.task.updated_at);
      ai.remove(aiSelection.task);
      setAiSelection(null);
    } else if (pickerSlot) {
      const cleared = await dailyScheduleApi.assignAction(pickerSlot.id);
      refreshSlot(cleared);
      setPickerSlot(null);
      ai.retry();
    }
    message.success("已移出今日事，行动保留在事件篮");
  };
  const aiAttachmentSlot = features.aiParallel ? aiSelection?.slot ?? aiPickerSlot : null;
  const activePickerSlot = aiAttachmentSlot ?? pickerSlot;
  const aiParentId = aiAttachmentSlot?.action?.id;
  const moveScheduleContent = (updated: DailyScheduleSlot[], source: DailyScheduleSlot, target: DailyScheduleSlot) => {
    ai.moveWithSlots(source, target);
    setSchedule(current => current?.list_date === date
      ? { ...current, slots: current.slots.map(slot => updated.find(item => item.id === slot.id) ?? slot) }
      : current);
  };

  const saveTemplate = async () => {
    const template: DailyTemplateSlot[] = slots.map((slot, index) => ({ start_time: slot.start_time, end_time: slot.end_time, sort_order: index }));
    const confirmed = await new Promise<boolean>((resolve) => {
      AntModal.confirm({
        title: template.length === 0 ? "保存空模板？" : "保存模板？",
        content: template.length === 0
          ? "以后首次打开的新日期将不会自动生成时间段；已存在日期和当前日期不受影响。"
          : "只影响尚未创建日程的未来日期，不会修改任何已存在日期、行动或复盘记录。",
        okText: "确认保存",
        cancelText: "取消",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;
    try {
      await dailyScheduleApi.saveTemplate(template);
      message.success(template.length === 0 ? "已保存空模板" : "已保存模板");
    } catch (cause) { setError(userFacingError(cause)); }
  };
  const prepareInsertedSlot = (index: number) => { const before = slots[index]; if (!before) return; if (before.end_time === "24:00") { message.warning("当天已没有可新增的时间"); return; } setInsertPreset({ startTime: before.end_time, endTime: suggestedEndTime(before.end_time) }); };

  return <div className="page daily-list-page">
    <header className="page-header daily-list-header"><div><Typography.Title level={2} className="page-title">今日事</Typography.Title><Typography.Paragraph className="page-subtitle">按时间安排行动，并在右侧独立记录该计划执行情况的复盘。</Typography.Paragraph></div><div className="daily-date-panel">{isToday && <Tag color="blue" className="daily-today-tag">今天</Tag>}<DatePicker value={dayjs(date)} format="YYYY年MM月DD日" allowClear={false} cellRender={(current, info) => { if (info.type !== "date" || !usedDates.has(dayjs(current).format("YYYY-MM-DD"))) return info.originNode; return <div className="daily-date-cell is-used">{info.originNode}<span className="daily-date-used-dot" aria-label="这天使用过今日事" /></div>; }} onChange={(value) => value && setDate(value.format("YYYY-MM-DD"))} /><Typography.Text className="daily-date-context"><span className="daily-weekday-name">{weekdayName}</span></Typography.Text></div></header>
    {error && <Alert className="page-alert" type="error" showIcon message={error} closable onClose={() => setError("")} />}
    {ai.error && <Alert className="page-alert" type="warning" showIcon message="AI 任务加载失败" description={ai.error} action={<Button size="small" onClick={ai.retry}>重试</Button>} />}
    {loading ? <div className="card empty">正在加载…</div> : <>{slots.length === 0 ? <div className="card onboarding-empty"><Empty className="empty" description={<div><Typography.Title level={4}>今天还没有安排行动</Typography.Title><Typography.Paragraph type="secondary">先创建一个时间段，再把要做的行动放进去。</Typography.Paragraph><Space><Button type="primary" icon={<Plus size={15} />} onClick={() => setInsertPreset({})}>新增时间段</Button><Button onClick={() => navigate("/inbox")}>去事件篮记录</Button>{features.templates && <Button onClick={() => void saveTemplate()}>保存空模板</Button>}</Space></div>} /></div> : <ScheduleTable key={date} slots={slots} aiTasks={ai.tasks} aiUnavailable={ai.loading || Boolean(ai.error)} onAiTask={(slot, task) => { if (task) setAiSelection({ slot, task }); else setAiPickerSlot(slot); }} onPlan={setPickerSlot} onReview={(slot) => { if (!slot.action) { message.warning({ content: "请先安排行动", className: "daily-review-toast" }); return; } setSelectedSlot(slot); }} onEditTime={setTimeSlot} onInsert={prepareInsertedSlot} onMoved={moveScheduleContent} />}<div className="daily-template-action"><div className="daily-template-action-left"><Button type="text" icon={<Plus size={15} />} onClick={() => setInsertPreset({})}>新增时间段</Button>{features.templates && <Tooltip title="只影响尚未创建日程的未来日期，不修改已有日期"><Button type="text" icon={<CalendarDays size={15} />} onClick={() => void saveTemplate()}>保存模板</Button></Tooltip>}</div>{features.workLog && <Button type="text" className="work-log-trigger" icon={<FileText size={15} />} disabled={slots.length === 0} onClick={() => setWorkLogOpen(true)}>工作日志</Button>}</div></>}
    <ActionPickerModal slot={activePickerSlot} slots={slots} aiTask={aiSelection?.task}
      hasAiTasks={Boolean(activePickerSlot && ai.tasks.some(task => task.slot_id === activePickerSlot.id))}
      onRemove={removeAction}
      onOpenAiRecords={() => { setAiRecordSelection(aiSelection); setAiSelection(null); }}
      onPickAction={aiPickerSlot || aiSelection ? attachAiAction : undefined}
      excludedActionIds={aiParentId ? [aiParentId, ...ai.tasks.filter(task => task.slot_id === aiAttachmentSlot?.id && task.action_id === aiParentId && task.id !== aiSelection?.task.id).map(task => task.linked_action_id)] : []}
      onGuideToInbox={() => navigate("/inbox", { state: { guideNewEvent: true } })}
      onClose={() => { setPickerSlot(null); setAiPickerSlot(null); setAiSelection(null); }}
      onStartPomodoro={(action) => { const minutes = Math.max(30, Math.ceil((action.estimated_hours || 0.5) * 60 / 30) * 30); sessionStorage.setItem("lifeplan-pomodoro-prefill", JSON.stringify({ actionId: action.id, plannedSeconds: minutes * 60 })); setPickerSlot(null); navigate("/pomodoro"); }}
      onAssigned={(assignedSlots) => { setSchedule((current) => current ? { ...current, slots: current.slots.map((item) => assignedSlots.find((assigned) => assigned.id === item.id) ?? item) } : current); setPickerSlot(null); ai.retry(); }} />
    <DailySlotModal slot={selectedSlot} onClose={() => setSelectedSlot(null)} onSaved={(slot) => { refreshSlot(slot); if (slot.action?.status !== selectedSlot?.action?.status) ai.retry(); setSelectedSlot(current => current?.id === slot.id && current.list_date === slot.list_date ? slot : current); }} />
    <TimeSlotModal slot={timeSlot} onClose={() => setTimeSlot(null)} onSaved={async () => { setTimeSlot(null); await load(); }} onDeleted={async () => { setTimeSlot(null); await load(); message.success("时间段已删除"); }} />
    <InsertSlotModal date={date} preset={insertPreset} onClose={() => setInsertPreset(null)} onSaved={async () => { setInsertPreset(null); await load(); message.success("已新增时间段"); }} />
    {features.aiParallel && aiRecordSelection && aiRecordSelection.slot.list_date === date && <DailyAiTaskEditor key={`${date}:${aiRecordSelection.task.id}`} selection={aiRecordSelection} onClose={() => setAiRecordSelection(null)} onSaved={(task) => { ai.upsert(task); ai.retry(); void load(); }} onDeleted={ai.remove} onRefresh={ai.retry} onOpenInbox={() => { setAiRecordSelection(null); navigate("/inbox"); }} />}
    {!loading && !error && schedule?.list_date === date && features.dailyStatistics && <DailyStatistics key={date} date={date} slots={slots} aiTasks={ai.tasks} />}
    {features.workLog && workLogOpen && <WorkLogModal date={date} slots={slots} onClose={() => setWorkLogOpen(false)} />}
  </div>;
}

function ScheduleTable({ slots, aiTasks, aiUnavailable, onAiTask, onPlan, onReview, onEditTime, onInsert, onMoved }: {
  slots: DailyScheduleSlot[];
  aiTasks: AiTask[];
  aiUnavailable: boolean;
  onAiTask: (slot: DailyScheduleSlot, task: AiTask | null) => void;
  onPlan: (slot: DailyScheduleSlot) => void;
  onReview: (slot: DailyScheduleSlot) => void;
  onEditTime: (slot: DailyScheduleSlot) => void;
  onInsert: (index: number) => void;
  onMoved: (slots: DailyScheduleSlot[], source: DailyScheduleSlot, target: DailyScheduleSlot) => void;
}) {
  const { features } = useFeaturePreferences();
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const busy = useRef(false);
  const tasksBySlot = useMemo(() => aiTasksBySlot(aiTasks, slots), [aiTasks, slots]);
  const clearDrag = () => { setDraggedId(null); setTargetId(null); };
  const move = async (sourceId: number, destinationId: number) => {
    const source = slots.find((slot) => slot.id === sourceId);
    const target = slots.find((slot) => slot.id === destinationId);
    if (busy.current || !source?.action || !target || sourceId === destinationId) return;
    busy.current = true;
    setMoving(true);
    clearDrag();
    try {
      const updated = await dailyScheduleApi.moveAction(source.list_date, sourceId, destinationId);
      onMoved(updated, source, target);
      message.success("安排已调整");
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      busy.current = false;
      setMoving(false);
    }
  };
  const startDrag = (event: DragEvent<HTMLButtonElement>, slot: DailyScheduleSlot) => {
    if (busy.current || !slot.action) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-lifeplan-slot", String(slot.id));
    setDraggedId(slot.id);
  };
  return <div className={`daily-schedule-card card${moving ? " is-moving" : ""}`} aria-busy={moving}>
    <div className="daily-schedule-head"><div>时间段</div><div>安排行动</div><div>复盘</div></div>
    <div className="daily-schedule-body">{slots.map((slot, index) => {
      const tasks = tasksBySlot.get(slot.id) ?? [];
      const expanded = features.aiParallel && tasks.length > 0;
      return <div className={`daily-schedule-row-wrap${expanded ? " has-ai-tasks" : ""}`} key={slot.id}>
      <div className={`daily-schedule-row${expanded ? " has-ai-tasks" : ""}${draggedId === slot.id ? " is-dragging" : ""}${targetId === slot.id ? " is-drop-target" : ""}`}
        onDragOver={(event) => {
          if (draggedId === null || draggedId === slot.id || busy.current) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setTargetId(slot.id);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTargetId(null); }}
        onDrop={(event) => {
          if (draggedId === null) return;
          event.preventDefault();
          const sourceId = draggedId;
          clearDrag();
          void move(sourceId, slot.id);
        }}>
        <div className="daily-time-cell" role="button" tabIndex={moving ? -1 : 0} aria-disabled={moving}
          onClick={() => { if (!busy.current) onEditTime(slot); }}
          onKeyDown={(event) => { if (!busy.current && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onEditTime(slot); } }}>
          {slotLabel(slot)}
          {index < slots.length - 1 && <button className="daily-insert-button" type="button" aria-label="插入时间段" title="插入时间段" disabled={moving}
            onClick={(event) => { event.stopPropagation(); if (!busy.current) onInsert(index); }}><span className="daily-insert-plus"><Plus size={14} /></span></button>}
        </div>
        <div className="daily-plan-stack">
          <div className="daily-plan-main">
            <PlanCell slot={slot} disabled={moving} onClick={() => { if (!busy.current) onPlan(slot); }} onDragStart={(event) => startDrag(event, slot)} onDragEnd={clearDrag} />
            {features.aiParallel && slot.action && <>
              <Tooltip title="添加 AI 任务"><button type="button" className="daily-ai-add" aria-label={`为 ${slot.action.title} 添加 AI 任务`} disabled={moving || aiUnavailable}
                onClick={() => { if (!busy.current) onAiTask(slot, null); }}><Bot size={15} /></button></Tooltip>
            </>}
          </div>
          {expanded && <div className="daily-ai-tasks" aria-label={`${slotLabel(slot)} ${slot.action!.title} 的 AI 任务`}>
            {tasks.map((task) => <button type="button" className={`daily-ai-task ${task.status}`} key={task.id} disabled={moving || aiUnavailable} onClick={() => onAiTask(slot, task)}>
              <Bot size={13} aria-hidden="true" />
              <span className="daily-ai-task-name" title={task.title}>{task.title}</span>
              {task.start_time && task.end_time && <span className="daily-ai-task-time">{task.start_time}–{task.end_time}</span>}
              <Tag color={aiTaskStatuses[task.status].color}>{aiTaskStatuses[task.status].label}</Tag>
            </button>)}
          </div>}
        </div>
        <ReviewCell slot={slot} onClick={() => { if (!busy.current) onReview(slot); }} />
      </div>
    </div>; })}</div>
  </div>;
}

function PlanCell({ slot, onClick, disabled, onDragStart, onDragEnd }: {
  slot: DailyScheduleSlot; onClick: () => void; disabled: boolean;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void; onDragEnd: () => void;
}) {
  const action = slot.action; const statusClass = !action ? "empty" : action.status === 1 ? "completed" : action.status === 2 ? "abandoned" : "pending";
  return <button type="button" className={`daily-plan-cell daily-cell-button ${statusClass}`} disabled={disabled} draggable={Boolean(action) && !disabled} onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onClick}>{action ? <><span className="daily-drag-handle" title="拖动到其他时间段"><GripVertical size={14} aria-hidden="true" /></span><span className={`daily-inline-title ${action.status === 1 ? "completed-title" : ""}`}>{action.title}</span></> : <span className="daily-empty-action">+ 点击安排行动</span>}</button>;
}

function ReviewCell({ slot, onClick }: { slot: DailyScheduleSlot; onClick: () => void }) {
  const reviewed = slot.met_expectation !== undefined && slot.focused !== undefined && Boolean(slot.actual_notes);
  return <button type="button" className={`daily-review-cell daily-cell-button ${reviewed ? "reviewed" : "empty"}`} onClick={onClick}>{reviewed ? <><span className="daily-inline-tags"><Tag color={slot.met_expectation === 1 ? "green" : "red"}>{slot.met_expectation === 1 ? "达到预期" : "未达预期"}</Tag><Tag color={slot.focused === 1 ? "blue" : "red"}>{slot.focused === 1 ? "专注" : "未专注"}</Tag></span><span className="daily-review-summary">{slot.actual_notes}</span></> : <span className="daily-review-placeholder">添加复盘</span>}</button>;
}

function HalfHourTimePicker({ value, onChange, className, allowDayEnd = false }: { value?: Dayjs; onChange?: (value: Dayjs | null) => void; className?: string; allowDayEnd?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const currentTime = value ? formatPickerTime(value) : undefined;
  const times = allowDayEnd ? [...HALF_HOUR_TIMES, "24:00"] : HALF_HOUR_TIMES;
  useEffect(() => {
    if (!open || !currentTime) return;
    const frame = requestAnimationFrame(() => {
      const selectedOption = listRef.current?.querySelector<HTMLButtonElement>(`[data-time="${currentTime}"]`);
      selectedOption?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, currentTime]);
  const selectTime = (time: string) => {
    onChange?.(pickerTime(time));
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const selectNow = () => selectTime(toHalfHourTime(dayjs()));
  return <Dropdown open={open} onOpenChange={setOpen} trigger={["click"]} placement="bottomLeft" popupRender={() => <div className="daily-time-picker-panel"><div ref={listRef} className="daily-time-picker-list" role="listbox" aria-label="时间选项">{times.map((time) => <button key={time} data-time={time} type="button" role="option" aria-selected={time === currentTime} className={`daily-time-picker-option ${time === currentTime ? "selected" : ""}`} onClick={() => selectTime(time)}>{time}</button>)}</div><div className="daily-time-picker-footer"><Button type="link" size="small" onClick={selectNow}>此刻</Button></div></div>}><button ref={triggerRef} type="button" className={`daily-time-picker-trigger ${className ?? ""}`} aria-haspopup="listbox" aria-expanded={open}>{currentTime ?? "请选择时间"}</button></Dropdown>;
}

function InsertSlotModal({ date, preset, onClose, onSaved }: { date: string; preset: { startTime?: string; endTime?: string } | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm(); const [saving, setSaving] = useState(false);
  useEffect(() => { if (!preset) return; form.resetFields(); if (preset.startTime && preset.endTime) form.setFieldsValue({ start_time: pickerTime(preset.startTime), end_time: pickerTime(preset.endTime) }); }, [preset, form]);
  if (!preset) return null;
  const submit = async (values: Record<string, unknown>) => { const startTime = formatPickerTime(values.start_time as Dayjs); const endTime = formatPickerTime(values.end_time as Dayjs); if (minutesBetween(startTime, endTime) <= 0) { message.error("结束时间必须晚于开始时间，且不能超过次日 00:00"); return; } setSaving(true); try { await dailyScheduleApi.createSlot({ list_date: date, start_time: startTime, end_time: endTime }); await onSaved(); } catch (cause) { message.error(userFacingError(cause)); } finally { setSaving(false); } };
  return <AntModal open title="新增时间段" onCancel={onClose} footer={null} destroyOnHidden><Form form={form} className="form" layout="vertical" onValuesChange={(changed) => {
    if (changed.start_time) form.setFieldsValue({ end_time: pickerTime(suggestedEndTime(formatPickerTime(changed.start_time))) });
  }} onFinish={(values) => void submit(values)}><div className="form-grid"><Form.Item name="start_time" label="开始时间" rules={[{ required: true }]}><HalfHourTimePicker className="full-width" /></Form.Item><Form.Item name="end_time" label="结束时间" rules={[{ required: true }]}><HalfHourTimePicker className="full-width" allowDayEnd /></Form.Item></div><div className="form-footer"><Button onClick={onClose}>取消</Button><Button type="primary" htmlType="submit" loading={saving}>保存时间段</Button></div></Form></AntModal>;
}

function TimeSlotModal({ slot, onClose, onSaved, onDeleted }: { slot: DailyScheduleSlot | null; onClose: () => void; onSaved: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (slot) form.setFieldsValue({ start_time: pickerTime(slot.start_time), end_time: pickerTime(slot.end_time) });
  }, [slot, form]);
  if (!slot) return null;

  const submit = async (values: Record<string, unknown>) => {
    setSaving(true);
    try {
      await dailyScheduleApi.updateSlot({ id: slot.id, start_time: formatPickerTime(values.start_time as Dayjs), end_time: formatPickerTime(values.end_time as Dayjs) });
      await onSaved();
      message.success("时间段已更新");
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  const split = async () => {
    setSaving(true);
    try {
      await dailyScheduleApi.splitSlot(slot.list_date, slot.id);
      await onSaved();
      message.success({ content: "完成拆分", className: "daily-split-message" });
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await dailyScheduleApi.deleteSlot(slot.list_date, slot.id);
      await onDeleted();
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  return <AntModal open title={`编辑时间段 · ${slotLabel(slot)}`} onCancel={onClose} footer={null} destroyOnHidden><Form form={form} className="form" layout="vertical" onFinish={(values) => void submit(values)}><div className="form-grid"><Form.Item name="start_time" label="开始时间" rules={[{ required: true, message: "请选择开始时间" }]}><HalfHourTimePicker className="full-width" /></Form.Item><Form.Item name="end_time" label="结束时间" dependencies={["start_time"]} rules={[{ required: true, message: "请选择结束时间" }, ({ getFieldValue }) => ({ validator(_, value) { const start = getFieldValue("start_time") as Dayjs | undefined; if (!value || !start || value.isAfter(start)) return Promise.resolve(); return Promise.reject(new Error("结束时间必须晚于开始时间")); } })]}><HalfHourTimePicker className="full-width" allowDayEnd /></Form.Item></div><div className="form-footer">{slot.action_id ? <Button danger disabled title="请先移除已安排的行动">删除</Button> : <Popconfirm title="确定删除这个时间段吗？" onConfirm={() => void remove()} okText="删除" cancelText="取消"><Button danger loading={saving}>删除</Button></Popconfirm>}{minutesBetween(slot.start_time, slot.end_time) > 30 && <Button onClick={() => void split()} loading={saving}>拆分</Button>}<Button type="primary" htmlType="submit" loading={saving}>保存</Button></div></Form></AntModal>;
}

function ActionPickerModal({ slot, slots, aiTask, hasAiTasks, onRemove, onOpenAiRecords, onGuideToInbox, onClose, onStartPomodoro, onAssigned, onPickAction, excludedActionIds = [] }: {
  slot: DailyScheduleSlot | null; slots: DailyScheduleSlot[];
  aiTask?: AiTask; hasAiTasks: boolean; onRemove: () => Promise<void>; onOpenAiRecords: () => void;
  onGuideToInbox: () => void; onClose: () => void; onStartPomodoro: (action: Action) => void;
  onAssigned: (slots: DailyScheduleSlot[]) => void;
  onPickAction?: (action: Action) => Promise<void>; excludedActionIds?: number[];
}) {
  const { features } = useFeaturePreferences();
  const isAi = Boolean(onPickAction);
  const [mode, setMode] = useState<"existing" | "new" | "recurring" | "new-recurring" | "edit-recurring">("existing");
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [query, setQuery] = useState("");
  const [actionView, setActionView] = useState<"flat" | "event">(() => { const saved = localStorage.getItem(ACTION_VIEW_STORAGE_KEY); return saved === "event" ? "event" : "flat"; });
  const [recurringActions, setRecurringActions] = useState<RecurringAction[]>([]);
  const [recurringQuery, setRecurringQuery] = useState("");
  const [editingRecurringAction, setEditingRecurringAction] = useState<RecurringAction | null>(null);
  const [poolActions, setPoolActions] = useState<Action[]>([]);
  const [allActions, setAllActions] = useState<Action[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState("");
  const [poolRetry, setPoolRetry] = useState(0);
  const [pickError, setPickError] = useState("");
  const busy = useRef(false);
  const generatedActions = useRef(new Map<string, Action>());

  useEffect(() => {
    if (!slot) return;
    setMode("existing");
    setQuery("");
    setActionView((current) => { const saved = localStorage.getItem(ACTION_VIEW_STORAGE_KEY); return saved === "event" ? "event" : current; });
    setRecurringQuery("");
    setEditingRecurringAction(null);
    setViewing(Boolean(aiTask) || (!isAi && Boolean(slot.action)));
    setPickError("");
    generatedActions.current.clear();
    void recurringActionsApi.list().then(setRecurringActions).catch((cause) => message.error(userFacingError(cause)));
  }, [slot, isAi, aiTask?.id]);
  useEffect(() => {
    if (!slot) return;
    let active = true;
    setPoolLoading(true); setPoolError(""); setPoolActions([]); setAllActions([]);
    Promise.all([actionsApi.list(), eventsApi.list()]).then(([allActions, events]) => {
      if (!active) return;
      setAllActions(allActions);
      const activeEvents = new Set(events.filter(event => event.status === 1).map(event => event.id));
      setPoolActions(allActions.filter(action => action.event_id != null && activeEvents.has(action.event_id)));
    }).catch(cause => { if (active) setPoolError(userFacingError(cause)); })
      .finally(() => { if (active) setPoolLoading(false); });
    return () => { active = false; };
  }, [slot, poolRetry]);
  const selectableActions = poolActions.filter((action) => action.status === 0 && action.event_id != null && !excludedActionIds.includes(action.id));
  const visibleActions = selectableActions.filter((action) => action.title.toLowerCase().includes(query.trim().toLowerCase()) || action.description?.toLowerCase().includes(query.trim().toLowerCase()));
  const flatVisibleActions = useMemo(() => sortDailyActions(visibleActions), [visibleActions]);
  const visibleRecurringActions = recurringActions.filter((action) => action.title.toLowerCase().includes(recurringQuery.trim().toLowerCase()));

  if (!slot) return null;
  const displayedAction = aiTask ? allActions.find(action => action.id === aiTask.linked_action_id) : slot.action;
  const confirmChange = (content: string) => new Promise<boolean>(resolve => {
    AntModal.confirm({ title: "确认更换行动？", content, okText: "更换行动", cancelText: "取消",
      onOk: () => resolve(true), onCancel: () => resolve(false) });
  });
  const remove = async () => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setPickError("");
    try { await onRemove(); }
    catch (cause) { setPickError(userFacingError(cause)); }
    finally { busy.current = false; setSaving(false); }
  };

  const pickAiAction = async (getAction: () => Promise<Action>) => {
    if (!onPickAction || busy.current) return;
    busy.current = true; setSaving(true); setPickError("");
    try {
      if (aiTask?.result && !await confirmChange("原 AI 任务会解除挂载，原行动和完成状态保留。更换后开始一条新的任务记录。")) return;
      await onPickAction(await getAction());
    }
    catch (cause) { setPickError(userFacingError(cause)); }
    finally { busy.current = false; setSaving(false); }
  };
  const generatedAction = async (key: string, create: () => Promise<Action>) => {
    const existing = generatedActions.current.get(key);
    if (existing) return existing;
    const action = await create();
    generatedActions.current.set(key, action);
    return action;
  };
  const performAssign = async (targets: DailyScheduleSlot[], actionId: number) => {
    setSaving(true);
    try {
      const assigned = [];
      for (const target of targets) assigned.push(await dailyScheduleApi.assignAction(target.id, actionId));
      track("安排到今日", { count: targets.length });
      onAssigned(assigned);
      message.success("行动已安排");
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  const assignAction = async (action: Action) => {
    if (isAi) {
      await pickAiAction(async () => action); return;
    }
    if (slot.action_id !== action.id && (slot.actual_notes || slot.met_expectation != null || slot.focused != null || hasAiTasks)
      && !await confirmChange(features.aiParallel
        ? "会清空当前时间段的复盘并解除 AI 挂载，事件篮中的行动和完成状态保留。"
        : "会清空当前时间段的复盘及关联安排，事件篮中的行动和完成状态保留。")) return;
    const currentIndex = slots.findIndex((item) => item.id === slot.id);
    const previousAssigned = slots.slice(0, currentIndex).some((item) => item.action_id === action.id);
    const currentMinutes = minutesBetween(slot.start_time, slot.end_time);
    const requiredMinutes = Math.max(0, Math.round(action.estimated_hours * 60));
    const targets = [slot];
    if (!previousAssigned && requiredMinutes > currentMinutes) {
      let availableMinutes = currentMinutes;
      for (const next of slots.slice(currentIndex + 1)) {
        if (next.action_id) break;
        targets.push(next);
        availableMinutes += minutesBetween(next.start_time, next.end_time);
        if (availableMinutes >= requiredMinutes) break;
      }
      if (availableMinutes < requiredMinutes) {
        AntModal.confirm({ title: "提示", content: "该行动耗时预计大于当前这段可安排时间", okText: "我已了解", cancelText: "取消", onOk: async () => { await performAssign([slot], action.id); } });
        return;
      }
    }
    await performAssign(targets, action.id);
  };

  const assign = async (actionId: number) => {
    const action = selectableActions.find((item) => item.id === actionId);
    if (action) await assignAction(action);
  };

  const assignRecurring = async (recurringActionId: number) => {
    if (isAi) {
      await pickAiAction(() => generatedAction(`recurring:${recurringActionId}`, () => recurringActionsApi.instantiate(recurringActionId)));
      return;
    }
    try {
      const action = await recurringActionsApi.instantiate(recurringActionId);
      await assignAction(action);
    } catch (cause) {
      message.error(userFacingError(cause));
    }
  };

  const moveRecurring = async (recurringActionId: number, offset: -1 | 1) => {
    const index = recurringActions.findIndex((action) => action.id === recurringActionId);
    const targetIndex = index + offset;
    if (index < 0 || targetIndex < 0 || targetIndex >= recurringActions.length || saving) return;
    const reordered = [...recurringActions];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    setSaving(true);
    try {
      setRecurringActions(await recurringActionsApi.reorder({ action_ids: reordered.map((action) => action.id) }));
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  const createRecurring = async (payload: NewRecurringAction | UpdateRecurringAction) => {
    setSaving(true);
    try {
      const newPayload: NewRecurringAction = {
        title: payload.title,
        estimated_hours: payload.estimated_hours,
        is_frog: payload.is_frog,
        frequency_unit: payload.frequency_unit,
        frequency_count: payload.frequency_count,
      };
      const created = await recurringActionsApi.create(newPayload);
      setRecurringActions((current) => [...current, created]);
      setMode("recurring");
      setRecurringQuery("");
      message.success("重复行动已新增");
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  const deleteRecurring = async () => {
    if (!editingRecurringAction) return;
    setSaving(true);
    try {
      await recurringActionsApi.delete(editingRecurringAction.id);
      setRecurringActions((current) => current.filter((item) => item.id !== editingRecurringAction.id));
      setEditingRecurringAction(null);
      setMode("recurring");
      message.success("重复行动已删除");
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  const updateRecurring = async (payload: NewRecurringAction | UpdateRecurringAction) => {
    setSaving(true);
    try {
      if (!("id" in payload)) throw new Error("重复行动信息已失效，请重新打开编辑");
      const updated = await recurringActionsApi.update(payload);
      setRecurringActions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingRecurringAction(null);
      setMode("recurring");
      message.success("重复行动已更新");
    } catch (cause) {
      message.error(userFacingError(cause));
    } finally {
      setSaving(false);
    }
  };

  if (viewing) return <AntModal open title={`行动详情 · ${slotLabel(slot)}`} onCancel={() => { if (!busy.current) onClose(); }} closable={!saving} maskClosable={!saving} keyboard={!saving} footer={null} destroyOnHidden>
    {pickError && <Alert className="page-alert" type="error" showIcon message={pickError} />}
    {displayedAction ? <ActionPreview action={displayedAction} /> : poolLoading ? <Typography.Paragraph type="secondary">正在加载…</Typography.Paragraph> :
      <Alert type="warning" showIcon message={poolError || "行动信息已变化，请刷新后重试"} action={<Button size="small" onClick={() => setPoolRetry(value => value + 1)}>重试</Button>} />}
    <div className="form-footer daily-action-detail-footer">
      <Popconfirm title="移出这个行动？" description={aiTask ? "仅解除这次 AI 挂载，原行动和完成状态保留。" : features.aiParallel ? "保留时间段和事件篮中的行动，清空该时间段复盘并解除 AI 挂载。" : "保留时间段和事件篮中的行动，清空该时间段的复盘及关联安排。"} okText="移出" cancelText="取消" onConfirm={remove} disabled={saving}>
        <Button icon={<Unlink size={14} />} danger disabled={saving}>移出今日事</Button>
      </Popconfirm>
      <Space wrap><Button disabled={saving || Boolean(aiTask?.read_only)} onClick={() => setViewing(false)}>更换行动</Button>
        {aiTask ? <Button icon={<FileText size={14} />} disabled={saving} onClick={onOpenAiRecords}>任务记录</Button> :
          features.pomodoro && <Button type="primary" disabled={saving} onClick={() => displayedAction && onStartPomodoro(displayedAction)}>开始番茄钟</Button>}
      </Space>
    </div>
  </AntModal>;
  return <AntModal open title={`安排行动 · ${slotLabel(slot)}`} onCancel={() => { if (!saving && !busy.current) onClose(); }} closable={!saving} maskClosable={!saving} keyboard={!saving} footer={null} destroyOnHidden>
    {(mode === "existing" || mode === "recurring" || mode === "new") && <Radio.Group disabled={saving} className="daily-picker-radio" value={mode} onChange={(event) => setMode(event.target.value as "existing" | "recurring" | "new")} optionType="button" buttonStyle="solid"><Radio.Button value="existing">事件行动</Radio.Button><Radio.Button value="recurring">重复行动</Radio.Button><Radio.Button value="new">临时行动</Radio.Button></Radio.Group>}
    {pickError && <Alert className="page-alert" type="error" showIcon message={pickError} />}
    {mode === "existing" && poolLoading && <Typography.Paragraph type="secondary">正在加载…</Typography.Paragraph>}
    {mode === "existing" && poolError && <Alert className="page-alert" type="error" showIcon message="事件篮加载失败" description={poolError} action={<Button size="small" onClick={() => setPoolRetry(value => value + 1)}>重试</Button>} />}
    {mode === "existing" && !poolLoading && !poolError && (selectableActions.length === 0 ? <div className="daily-action-empty-guide"><div className="daily-action-empty-guide-icon"><ListChecks size={30} strokeWidth={1.8} /></div><Typography.Title level={4}>还没有可以直接安排的行动</Typography.Title><Typography.Paragraph>先创建要做的事，再把事情拆解成一步步能马上开始的行动，然后依次安排到每天，会更容易将事情推进完成。</Typography.Paragraph><div className="daily-action-empty-guide-example"><span>例如</span><span>准备汇报</span><ArrowRight size={14} /><span>整理数据 → 写提纲 → 完成初稿</span></div><Button type="primary" icon={<ArrowRight size={15} />} iconPosition="end" onClick={onGuideToInbox}>去事件篮拆分活动</Button></div> : <><div className="daily-picker-search-row"><Input allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索行动标题关键词" /><Button type={actionView === "flat" ? "primary" : "default"} ghost={actionView === "flat"} size="middle" icon={<Rows3 size={15} />} aria-label="平铺视图" title="平铺视图" onClick={() => { setActionView("flat"); localStorage.setItem(ACTION_VIEW_STORAGE_KEY, "flat"); }} /><Button type={actionView === "event" ? "primary" : "default"} ghost={actionView === "event"} size="middle" icon={<ListTree size={15} />} aria-label="按事件视图" title="按事件视图" onClick={() => { setActionView("event"); localStorage.setItem(ACTION_VIEW_STORAGE_KEY, "event"); }} /></div><div className={`daily-action-picker-list ${actionView === "event" ? "daily-action-picker-event-list" : ""}`}>{visibleActions.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的行动" /> : actionView === "flat" ? flatVisibleActions.map((action, index) => <button className={`daily-action-picker-item ${action.id === slot.action_id ? "selected" : ""}`} type="button" key={action.id} onClick={() => void assign(action.id)} disabled={saving}><ActionPreview action={action} index={index + 1} scheduledToday={slots.some((item) => item.action_id === action.id)} /></button>) : <EventActionPicker actions={visibleActions} slots={slots} saving={saving} onAssign={(id) => void assign(id)} />}</div></>)}
    {mode === "recurring" && <><div className="daily-picker-search-row"><Input allowClear value={recurringQuery} onChange={(event) => setRecurringQuery(event.target.value)} placeholder="搜索重复行动标题" /><Button icon={<Plus size={15} />} onClick={() => setMode("new-recurring")}>新增重复行动</Button></div><div className="daily-action-picker-list">{visibleRecurringActions.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={recurringActions.length === 0 ? "还没有重复行动" : "没有符合条件的重复行动"} /> : visibleRecurringActions.map((action, index) => { const actualIndex = recurringActions.findIndex((item) => item.id === action.id); return <div className="daily-recurring-picker-item" key={action.id}><button className="daily-action-picker-item" type="button" onClick={() => void assignRecurring(action.id)} disabled={saving}><RecurringActionPreview action={action} index={index + 1} /></button><div className="daily-recurring-order-actions"><Button type="text" size="small" aria-label="编辑重复行动" title="编辑" icon={<Pencil size={15} />} disabled={saving} onClick={(event) => { event.stopPropagation(); setEditingRecurringAction(action); setMode("edit-recurring"); }} /><Button type="text" size="small" aria-label="上移重复行动" title="上移" icon={<ChevronUp size={15} />} disabled={actualIndex === 0 || saving} onClick={(event) => { event.stopPropagation(); void moveRecurring(action.id, -1); }} /><Button type="text" size="small" aria-label="下移重复行动" title="下移" icon={<ChevronDown size={15} />} disabled={actualIndex === recurringActions.length - 1 || saving} onClick={(event) => { event.stopPropagation(); void moveRecurring(action.id, 1); }} /></div></div>; })}</div></>}
    {mode === "new" && <NewActionForm disabled={saving} onSubmit={async (payload) => {
      if (isAi) { await pickAiAction(() => generatedAction(`new:${JSON.stringify(payload)}`, () => actionsApi.create(payload))); return; }
      try { const action = await actionsApi.create(payload); await assignAction(action); } catch (cause) { message.error(userFacingError(cause)); }
    }} />}
    {(mode === "new-recurring" || mode === "edit-recurring") && <NewRecurringActionForm action={editingRecurringAction} onSubmit={mode === "edit-recurring" ? updateRecurring : createRecurring} />}
    <div className="form-footer">{mode !== "new-recurring" && mode !== "edit-recurring" && <Button disabled={saving} onClick={onClose}>取消</Button>}{mode === "new" && <Button type="primary" form="daily-new-action-form" htmlType="submit" loading={saving}>创建并安排</Button>}{(mode === "new-recurring" || mode === "edit-recurring") && <>{mode === "edit-recurring" && <Popconfirm title="删除后不可恢复，确认删除吗" onConfirm={() => void deleteRecurring()} okText="删除" cancelText="取消"><Button danger loading={saving}>删除</Button></Popconfirm>}<Button disabled={saving} onClick={() => { setEditingRecurringAction(null); setMode("recurring"); }}>取消</Button><Button type="primary" form="daily-new-recurring-action-form" htmlType="submit" loading={saving}>{mode === "edit-recurring" ? "保存修改" : "保存重复行动"}</Button></>}</div>
  </AntModal>;
}
function DailySlotModal({ slot, onClose, onSaved }: { slot: DailyScheduleSlot | null; onClose: () => void; onSaved: (slot: DailyScheduleSlot) => void }) {
  const [form] = Form.useForm(); const [saving, setSaving] = useState(false); const [completeAfterReview, setCompleteAfterReview] = useState(false);
  useEffect(() => {
    if (!slot) return;
    setCompleteAfterReview(false);
    const isNewReview = slot.actual_notes == null && slot.met_expectation == null && slot.focused == null;
    const defaultActualNotes = slot.action ? `${slot.action.event_title ? `${slot.action.event_title}-` : ""}${slot.action.title}` : "";
    form.setFieldsValue({
      actual_notes: isNewReview ? defaultActualNotes : slot.actual_notes,
      met_expectation: isNewReview ? 1 : slot.met_expectation,
      focused: isNewReview ? 1 : slot.focused,
    });
  }, [slot, form]);
  if (!slot) return null;
  const saveReview = async () => { try { setSaving(true); const values = await form.validateFields(["actual_notes", "met_expectation", "focused"]); let reviewed = await dailyScheduleApi.updateReview({ id: slot.id, actual_notes: String(values.actual_notes), met_expectation: Number(values.met_expectation) as 0 | 1, focused: Number(values.focused) as 0 | 1 }); track("完成每日复盘", { met_expectation: Number(values.met_expectation) === 1, focused: Number(values.focused) === 1 }); if (completeAfterReview && slot.action_id) { reviewed = { ...reviewed, action: await actionsApi.complete(slot.action_id) }; } onSaved(reviewed); onClose(); message.success(completeAfterReview ? "复盘已保存，行动已完成" : "复盘已保存"); } catch (cause) { if (cause && typeof cause === "object" && "errorFields" in cause) return; message.error(userFacingError(cause)); } finally { setSaving(false); setCompleteAfterReview(false); } };
  const restore = async () => { if (!slot.action_id) return; try { const action = await actionsApi.restore(slot.action_id); onSaved({ ...slot, action }); message.success("行动已恢复"); } catch (cause) { message.error(userFacingError(cause)); } };
  return <AntModal open title={`时间段详情 · ${slotLabel(slot)}`} onCancel={onClose} footer={null} destroyOnHidden><Form form={form} className="form daily-slot-form" layout="vertical">{slot.action ? <ActionPreview action={slot.action} /> : <div className="daily-action-preview-empty">当前时间段尚未安排行动</div>}<Form.Item name="actual_notes" label="实际工作情况" rules={[{ required: true, whitespace: true, message: "请填写实际工作情况" }]}><Input.TextArea autoSize={{ minRows: 3, maxRows: 5 }} /></Form.Item><div className="form-grid"><Form.Item name="met_expectation" label="是否达到预期" rules={[{ required: true, message: "请选择是否达到预期" }]}><Select options={[{ value: 1, label: "达到预期" }, { value: 0, label: "未达预期" }]} /></Form.Item><Form.Item name="focused" label="是否专注" rules={[{ required: true, message: "请选择是否专注" }]}><Select options={[{ value: 1, label: "专注" }, { value: 0, label: "未专注" }]} /></Form.Item></div><div className="daily-slot-actions"><Space>{slot.action?.status === 0 && <Checkbox checked={completeAfterReview} onChange={(event) => setCompleteAfterReview(event.target.checked)}>已完成行动</Checkbox>}{slot.action?.status === 1 && <Button icon={<RotateCcw size={14} />} onClick={() => void restore()}>恢复行动</Button>}</Space><Space><Button type="primary" onClick={() => void saveReview()} loading={saving}>保存复盘</Button></Space></div></Form></AntModal>;
}

function EventActionPicker({ actions, slots, saving, onAssign }: { actions: Action[]; slots: DailyScheduleSlot[]; saving: boolean; onAssign: (id: number) => void }) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const groups = actions.filter((action) => action.status !== 1).reduce<Array<{ key: string; eventTitle: string; actions: Action[] }>>((result, action) => {
    const key = action.event_id != null ? `event:${action.event_id}` : "unassigned";
    const existing = result.find((item) => item.key === key);
    if (existing) { existing.actions.push(action); }
    else result.push({ key, eventTitle: action.event_title || "所属事件", actions: [action] });
    return result;
  }, []).map((group) => ({ ...group, actions: [...group.actions].sort((left, right) => left.sort_order - right.sort_order) }));
  return <div className="daily-event-action-groups">{groups.map((group) => { const expanded = expandedKeys.has(group.key); return <section className="daily-event-action-group" key={group.key}><button type="button" className="daily-event-action-parent" aria-expanded={expanded} onClick={() => setExpandedKeys((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}><span className="daily-event-action-parent-label">事件：</span><Typography.Text strong className="daily-event-action-parent-title" ellipsis={{ tooltip: group.eventTitle }}>{group.eventTitle}</Typography.Text><span className="daily-event-action-count">{group.actions.length}</span>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>{expanded && <div className="daily-event-action-children">{group.actions.map((action, index) => <button className={`daily-action-picker-item ${slots.some((item) => item.action_id === action.id) ? "selected" : ""}`} type="button" key={action.id} onClick={() => onAssign(action.id)} disabled={saving}><ActionPreview action={action} index={index + 1} scheduledToday={slots.some((item) => item.action_id === action.id)} hideEventRelation hideEventActionMeta /></button>)}</div>}</section>; })}</div>;
}
function ActionPreview({ action, index, scheduledToday = false, hideEventRelation = false, hideEventActionMeta = false }: { action: Action; index?: number; scheduledToday?: boolean; hideEventRelation?: boolean; hideEventActionMeta?: boolean }) {
  const eventLabel = action.event_title ? `所属事件：${action.event_title}` : "";
  const tooltipProps = { color: "#fff", classNames: { root: "daily-action-tooltip" }, styles: { container: { color: "#303133", backgroundColor: "#fff", boxShadow: "0 4px 12px rgba(0, 0, 0, .12)" } } };
  return <div className="daily-action-preview"><div className={`daily-action-preview-title ${action.status === 1 ? "completed-title" : ""}`}>{index !== undefined && <span className="card-index">{index}.</span>}<Tooltip title={action.title} {...tooltipProps}><span className="daily-action-preview-title-text">{action.title}</span></Tooltip>{scheduledToday && <Tag className="daily-action-scheduled-tag">当日已安排</Tag>}</div><div className="daily-action-preview-tags"><Tag color={action.estimated_hours <= 0.5 ? "blue" : action.estimated_hours <= 1 ? "cyan" : action.estimated_hours <= 1.5 ? "orange" : "red"}>{action.estimated_hours === 0.5 ? "30 分钟" : `${action.estimated_hours} 小时`}</Tag>{hideEventActionMeta ? action.start_date && <Tag color="default">开始：{action.start_date}</Tag> : <Tag color={action.status === 1 ? "green" : action.status === 2 ? "red" : "blue"}>{action.status === 1 ? "已完成" : action.status === 2 ? "已放弃" : "待办"}</Tag>}</div>{!hideEventActionMeta && action.start_date && <div className="daily-action-preview-dates"><span>开始：{action.start_date}</span></div>}{eventLabel && !hideEventRelation && <div className="daily-action-preview-event"><Tooltip title={eventLabel} {...tooltipProps}><span className="daily-action-preview-event-text">{eventLabel}</span></Tooltip></div>}{action.description && <Typography.Paragraph className="daily-action-preview-description">{action.description}</Typography.Paragraph>}</div>;
}

function RecurringActionPreview({ action, index }: { action: RecurringAction; index?: number }) {
  const frequencyLabel = `${action.frequency_unit === "daily" ? "每日" : action.frequency_unit === "weekly" ? "每周" : "每月"} ${action.frequency_count} 次`;
  return <div className="daily-action-preview"><div className="daily-action-preview-title">{index !== undefined && <span className="card-index">{index}.</span>}<span className="daily-action-preview-title-text">{action.title}</span></div><div className="daily-action-preview-tags"><Tag color={action.estimated_hours <= 0.5 ? "blue" : action.estimated_hours <= 1 ? "cyan" : action.estimated_hours <= 1.5 ? "orange" : "red"}>{action.estimated_hours === 0.5 ? "30 分钟" : `${action.estimated_hours} 小时`}</Tag><Tag color="purple">{frequencyLabel}</Tag></div></div>;
}

function NewRecurringActionForm({ action, onSubmit }: { action: RecurringAction | null; onSubmit: (payload: NewRecurringAction | UpdateRecurringAction) => Promise<void> }) {
  const [form] = Form.useForm();
  useEffect(() => {
    form.setFieldsValue(action ? {
      title: action.title, estimated_hours: action.estimated_hours, frequency_unit: action.frequency_unit,
      frequency_count: action.frequency_count,
    } : { title: undefined, estimated_hours: 0.5, frequency_unit: "daily", frequency_count: 1 });
  }, [action, form]);
  return <Form id="daily-new-recurring-action-form" form={form} className="form daily-new-action-form" layout="vertical" onFinish={(values) => void onSubmit({ ...(action ? { id: action.id } : {}), title: String(values.title), estimated_hours: Number(values.estimated_hours), is_frog: action?.is_frog ?? 0, frequency_unit: values.frequency_unit, frequency_count: Number(values.frequency_count) })}><Form.Item name="title" label="行动标题" rules={[{ required: true, message: "请输入行动标题" }]}><Input autoFocus /></Form.Item><div className="form-grid action-modal-grid"><Form.Item name="estimated_hours" label="单次耗时" rules={[{ required: true, message: "请选择单次耗时" }]}><Select options={[{ value: 0.5, label: "30 分钟" }, { value: 1, label: "1 小时" }, { value: 1.5, label: "1.5 小时" }, { value: 2, label: "2 小时" }]} /></Form.Item><Form.Item name="frequency_unit" label="频率" rules={[{ required: true }]}><Select options={[{ value: "daily", label: "每日" }, { value: "weekly", label: "每周" }, { value: "monthly", label: "每月" }]} /></Form.Item><Form.Item name="frequency_count" label="次数" rules={[{ required: true, message: "请输入次数" }, { type: "number", min: 1, max: 99, message: "次数范围为 1～99" }]}><InputNumber min={1} max={99} precision={0} className="full-width" /></Form.Item></div></Form>;
}

function NewActionForm({ onSubmit, disabled = false }: { onSubmit: (payload: NewAction) => Promise<void>; disabled?: boolean }) {
  const [form] = Form.useForm();
  return <Form disabled={disabled} id="daily-new-action-form" form={form} className="form daily-new-action-form" layout="vertical" onFinish={(values) => void onSubmit({ title: String(values.title), estimated_hours: Number(values.estimated_hours), start_date: values.start_date ? (values.start_date as Dayjs).format("YYYY-MM-DD") : undefined, is_frog: 0 })}><Form.Item name="title" label="行动标题" rules={[{ required: true, message: "请输入行动标题" }]}><Input autoFocus /></Form.Item><div className="form-grid action-modal-grid"><Form.Item name="estimated_hours" label="预计耗时" initialValue={0.5} rules={[{ required: true }]}><Select options={[{ value: 0.5, label: "30 分钟" }, { value: 1, label: "1 小时" }, { value: 1.5, label: "1.5 小时" }, { value: 2, label: "2 小时" }]} /></Form.Item><Form.Item name="start_date" label="开始日期"><DatePicker className="full-width" format="YYYY-MM-DD" /></Form.Item></div></Form>;
}
