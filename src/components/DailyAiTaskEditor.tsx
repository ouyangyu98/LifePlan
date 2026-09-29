import { useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Typography } from "antd";
import { Bot, Check, Save, Trash2 } from "lucide-react";
import { aiTasksApi } from "@/lib/api";
import { aiTaskStatuses } from "@/lib/aiTasks";
import { userFacingError } from "@/lib/errors";
import type { AiTask, AiTaskFields, DailyScheduleSlot } from "@/types";

const times = Array.from({ length: 49 }, (_, index) => {
  const value = `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`;
  return { value, label: value };
});

export interface AiTaskSelection { slot: DailyScheduleSlot; task: AiTask | null }

export default function DailyAiTaskEditor({ selection, onClose, onSaved, onDeleted, onRefresh }: {
  selection: AiTaskSelection;
  onClose: () => void;
  onSaved: (task: AiTask) => void;
  onDeleted: (task: AiTask) => void;
  onRefresh: () => void;
}) {
  const { slot } = selection;
  const [task, setTask] = useState(selection.task);
  const [form] = Form.useForm<AiTaskFields>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const dirty = useRef(false);
  const status = Form.useWatch("status", form);
  useEffect(() => {
    form.setFieldsValue(task ? {
      title: task.title, status: task.status, notes: task.notes, result: task.result,
      start_time: task.start_time ?? undefined, end_time: task.end_time ?? undefined,
    } : { title: "", status: "queued", notes: "", result: "", start_time: slot.start_time, end_time: slot.end_time });
    dirty.current = false;
  }, [task, slot.start_time, slot.end_time, form]);

  const close = () => {
    if (busy.current) return;
    if (dirty.current) {
      Modal.confirm({ title: "放弃未保存的修改？", okText: "放弃修改", cancelText: "继续编辑", onOk: onClose });
    } else onClose();
  };
  const save = async (confirmResult = false) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const values = await form.validateFields();
      setSaving(true); setError("");
      const fields: AiTaskFields = {
        ...values, title: values.title.trim(), notes: values.notes ?? "", result: values.result ?? "",
        start_time: values.start_time || null, end_time: values.end_time || null,
        status: confirmResult ? "completed" : values.status,
      };
      const updated = task
        ? await aiTasksApi.update({ ...fields, id: task.id, expected_updated_at: task.updated_at })
        : await aiTasksApi.create({ ...fields, action_id: slot.action!.id, list_date: slot.list_date });
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
  return <Drawer open title={<span className="daily-ai-editor-title"><Bot size={18} />{task ? "AI 任务详情" : "新增 AI 任务"}</span>}
    width={460} onClose={close} maskClosable={!saving} keyboard={!saving}
    className="daily-ai-editor"
    footer={<div className="daily-ai-editor-footer">
      {task && <Popconfirm title="删除这个 AI 任务？" description="不影响主行动和复盘。" okText="删除" cancelText="取消" onConfirm={() => void remove()} disabled={saving}>
        <Button danger type="text" icon={<Trash2 size={16} />} title="删除 AI 任务" aria-label="删除 AI 任务" disabled={saving} />
      </Popconfirm>}
      <Space wrap><Button onClick={close} disabled={saving}>取消</Button>
        <Button type={status === "ready" ? "default" : "primary"} icon={<Save size={14} />} loading={saving} onClick={() => void save()}>保存任务</Button>
        {status === "ready" && <Button type="primary" icon={<Check size={14} />} loading={saving} onClick={() => void save(true)}>确认结果</Button>}
      </Space>
    </div>}>
    <div className="daily-ai-parent"><Typography.Text type="secondary">{slot.list_date} · 主行动</Typography.Text><Typography.Text strong>{slot.action?.title}</Typography.Text></div>
    {error && <Alert type="error" showIcon message={error} className="page-alert" />}
    <Form form={form} layout="vertical" disabled={saving} onValuesChange={() => { dirty.current = true; }} onFinish={() => void save()}>
      <Form.Item name="title" label="任务名称" rules={[{ required: true, whitespace: true, message: "请填写任务名称" }, { max: 100, message: "最多 100 个字" }]}>
        <Input maxLength={100} autoFocus placeholder="例如：整理竞品材料" />
      </Form.Item>
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
      <Form.Item name="notes" label="任务说明" rules={[{ max: 10000, message: "最多 10000 个字" }]}><Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} maxLength={10000} /></Form.Item>
      <Form.Item name="result" label="结果与记录" rules={[{ max: 20000, message: "最多 20000 个字" }]}><Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} maxLength={20000} /></Form.Item>
    </Form>
  </Drawer>;
}
