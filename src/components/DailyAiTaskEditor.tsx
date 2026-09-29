import { useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Space, Typography } from "antd";
import { Bot, Check, ListTree, Save, Unlink } from "lucide-react";
import { actionsApi, aiTasksApi, eventsApi } from "@/lib/api";
import { aiTaskStatuses } from "@/lib/aiTasks";
import { userFacingError } from "@/lib/errors";
import { sortDailyActions } from "@/lib/dailyActionSort";
import type { Action, AiTask, AiTaskFields, DailyScheduleSlot } from "@/types";

const times = Array.from({ length: 49 }, (_, index) => {
  const value = `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`;
  return { value, label: value };
});

export interface AiTaskSelection { slot: DailyScheduleSlot; task: AiTask | null }

export default function DailyAiTaskEditor({ selection, attachedTasks, onClose, onSaved, onDeleted, onRefresh, onOpenInbox }: {
  selection: AiTaskSelection;
  attachedTasks: AiTask[];
  onClose: () => void;
  onSaved: (task: AiTask) => void;
  onDeleted: (task: AiTask) => void;
  onRefresh: () => void;
  onOpenInbox: () => void;
}) {
  const { slot } = selection;
  const [task, setTask] = useState(selection.task);
  const [form] = Form.useForm<AiTaskFields & { linked_action_id?: number }>();
  const [actions, setActions] = useState<Action[]>([]);
  const [loadingActions, setLoadingActions] = useState(!task);
  const [actionsError, setActionsError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const dirty = useRef(false);
  const status = Form.useWatch("status", form);
  const linkedId = Form.useWatch("linked_action_id", form);
  const selectedAction = actions.find(action => action.id === linkedId);
  const attachedIds = new Set(attachedTasks.filter(item => item.action_id === slot.action?.id).map(item => item.linked_action_id));
  const options = new Map<string, { value: number; label: string }[]>();
  for (const action of sortDailyActions(actions)) {
    if (action.id === slot.action?.id || attachedIds.has(action.id)) continue;
    const event = action.event_title || "未命名事件";
    options.set(event, [...(options.get(event) ?? []), { value: action.id, label: action.title }]);
  }
  useEffect(() => {
    if (task) return;
    let active = true;
    setLoadingActions(true); setActionsError("");
    Promise.all([actionsApi.list(), eventsApi.list()]).then(([allActions, events]) => {
      if (!active) return;
      const activeEvents = new Set(events.filter(event => event.status === 1).map(event => event.id));
      setActions(allActions.filter(action => action.status === 0 && action.event_id != null && activeEvents.has(action.event_id)));
    }).catch(cause => { if (active) setActionsError(userFacingError(cause)); })
      .finally(() => { if (active) setLoadingActions(false); });
    return () => { active = false; };
  }, [task, retry]);
  useEffect(() => {
    form.setFieldsValue(task ? {
      status: task.status, result: task.result,
      start_time: task.start_time ?? undefined, end_time: task.end_time ?? undefined,
    } : { linked_action_id: undefined, status: "queued", result: "", start_time: slot.start_time, end_time: slot.end_time });
    dirty.current = false;
  }, [task, slot.start_time, slot.end_time, form]);

  const leave = (onLeave: () => void) => {
    if (busy.current) return;
    if (dirty.current) {
      Modal.confirm({ title: "放弃未保存的修改？", okText: "放弃修改", cancelText: "继续编辑", onOk: onLeave });
    } else onLeave();
  };
  const close = () => leave(onClose);
  const save = async (confirmResult = false) => {
    if (busy.current || task?.read_only || (!task && (loadingActions || actionsError))) return;
    busy.current = true;
    try {
      const values = await form.validateFields();
      setSaving(true); setError("");
      const fields: AiTaskFields = {
        result: values.result ?? "",
        start_time: values.start_time || null, end_time: values.end_time || null,
        status: confirmResult ? "completed" : values.status,
      };
      const updated = task
        ? await aiTasksApi.update({ ...fields, id: task.id, expected_updated_at: task.updated_at })
        : await aiTasksApi.create({ ...fields, linked_action_id: values.linked_action_id!, action_id: slot.action!.id, list_date: slot.list_date });
      dirty.current = false; setTask(updated); onSaved(updated); onClose();
    } catch (cause) {
      if (!(cause && typeof cause === "object" && "errorFields" in cause)) {
        setError(userFacingError(cause));
        onRefresh();
      }
    } finally { busy.current = false; setSaving(false); }
  };
  const remove = async () => {
    if (!task || busy.current) return;
    busy.current = true; setSaving(true); setError("");
    try {
      await aiTasksApi.delete(task.id, task.updated_at);
      dirty.current = false; onDeleted(task); onClose();
    } catch (cause) { setError(userFacingError(cause)); onRefresh(); }
    finally { busy.current = false; setSaving(false); }
  };
  return <Drawer open title={<span className="daily-ai-editor-title"><Bot size={18} />{task ? "AI 任务详情" : "挂载 AI 任务"}</span>}
    width={460} onClose={close} maskClosable={!saving} keyboard={!saving}
    className="daily-ai-editor"
    footer={<div className="daily-ai-editor-footer">
      {task && <Popconfirm title="解除这个 AI 任务的挂载？" description="事件篮中的行动及其完成状态会保留。" okText="解除挂载" cancelText="取消" onConfirm={() => void remove()} disabled={saving}>
        <Button type="text" icon={<Unlink size={16} />} title="解除挂载" aria-label="解除挂载" disabled={saving} />
      </Popconfirm>}
      <Space wrap><Button onClick={close} disabled={saving}>取消</Button>
        <Button type={status === "ready" ? "default" : "primary"} icon={<Save size={14} />} disabled={task?.read_only || (!task && (loadingActions || Boolean(actionsError)))} loading={saving} onClick={() => void save()}>保存任务</Button>
        {status === "ready" && !task?.read_only && <Button type="primary" icon={<Check size={14} />} loading={saving} onClick={() => void save(true)}>确认结果</Button>}
      </Space>
    </div>}>
    <div className="daily-ai-parent"><Typography.Text type="secondary">{slot.list_date} · 主行动</Typography.Text><Typography.Text strong>{slot.action?.title}</Typography.Text></div>
    {error && <Alert type="error" showIcon message={error} className="page-alert" />}
    {actionsError && <Alert type="error" showIcon message="事件篮加载失败" description={actionsError} className="page-alert" action={<Button size="small" onClick={() => setRetry(value => value + 1)}>重试</Button>} />}
    {task?.read_only && <Alert type="info" showIcon message="所属事件已完成或放弃" className="page-alert" />}
    <div className="daily-ai-source-link"><Button type="link" size="small" icon={<ListTree size={14} />} disabled={saving} onClick={() => leave(onOpenInbox)}>去事件篮</Button></div>
    <Form form={form} layout="vertical" disabled={saving || task?.read_only} onValuesChange={() => { dirty.current = true; }} onFinish={() => void save()}>
      {task ? <Form.Item label="行动"><Typography.Text strong>{task.title}</Typography.Text><div><Typography.Text type="secondary">{task.event_title}</Typography.Text></div></Form.Item>
        : <Form.Item name="linked_action_id" label="选择行动" rules={[{ required: true, message: "请选择事件篮中的行动" }]}>
          <Select showSearch virtual={false} optionFilterProp="label" loading={loadingActions} disabled={saving || loadingActions || Boolean(actionsError)}
            placeholder="搜索事件篮中的行动" options={[...options].map(([label, options]) => ({ label, options }))}
            notFoundContent={loadingActions ? "正在加载…" : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可挂载行动" />} />
        </Form.Item>}
      {(task?.notes || selectedAction?.description) && <Form.Item label="任务说明">
        <Typography.Paragraph className="daily-ai-source-notes">{task?.notes || selectedAction?.description}</Typography.Paragraph>
      </Form.Item>}
      <Form.Item name="status" label="任务状态"><Select virtual={false} options={Object.entries(aiTaskStatuses).map(([value, { label }]) => ({ value, label }))} /></Form.Item>
      <div className="daily-ai-time-fields">
        <Form.Item name="start_time" label="计划开始时间" dependencies={["end_time"]} rules={[({ getFieldValue }) => ({
          validator: (_, value) => !value && getFieldValue("end_time") ? Promise.reject(new Error("请补全开始时间")) : Promise.resolve(),
        })]}><Select allowClear virtual={false} options={times.slice(0, -1)} placeholder="不指定" /></Form.Item>
        <Form.Item name="end_time" label="计划结束时间" dependencies={["start_time"]} rules={[({ getFieldValue }) => ({
          validator: (_, value) => {
            const start = getFieldValue("start_time");
            if (start && !value) return Promise.reject(new Error("请补全结束时间"));
            if (start && value <= start) return Promise.reject(new Error("需晚于开始时间，不能跨天"));
            return Promise.resolve();
          },
        })]}><Select allowClear virtual={false} options={times.slice(1)} placeholder="不指定" /></Form.Item>
      </div>
      <Form.Item name="result" label="结果与记录" rules={[{ max: 20000, message: "最多 20000 个字" }]}><Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} maxLength={20000} /></Form.Item>
    </Form>
  </Drawer>;
}
