import type { AiTask, AiTaskStatus, DailyScheduleSlot } from "../types/index";

export const aiTaskStatuses: Record<AiTaskStatus, { label: string; color: string }> = {
  queued: { label: "等待中", color: "default" },
  running: { label: "执行中", color: "cyan" },
  paused: { label: "已暂停", color: "default" },
  ready: { label: "待我确认", color: "gold" },
  completed: { label: "已完成", color: "green" },
  failed: { label: "失败", color: "red" },
};

export function aiTaskMinutes(task: AiTask): number {
  if (!task.start_time || !task.end_time) return 0;
  const minutes = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  };
  const duration = minutes(task.end_time) - minutes(task.start_time);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function dailyAiSummary(tasks: readonly AiTask[], slots: readonly DailyScheduleSlot[]) {
  const scheduled = [...aiTasksBySlot(tasks, slots).values()].flat();
  return {
    count: scheduled.length,
    minutes: scheduled.reduce((sum, task) => sum + aiTaskMinutes(task), 0),
    untimed: scheduled.filter((task) => !task.start_time || !task.end_time).length,
  };
}

export function aiTasksBySlot(tasks: readonly AiTask[], slots: readonly DailyScheduleSlot[]): Map<number, AiTask[]> {
  const bySlot = new Map<number, AiTask[]>();
  const slotsById = new Map(slots.map(slot => [slot.id, slot]));
  for (const task of tasks) {
    if (task.slot_id == null) continue;
    const slot = slotsById.get(task.slot_id);
    if (slot?.action?.id !== task.action_id || slot.list_date !== task.list_date) continue;
    bySlot.set(slot.id, [...(bySlot.get(slot.id) ?? []), task]);
  }
  return bySlot;
}
