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
  const actionIds = new Set(slots.flatMap((slot) => slot.action ? [slot.action.id] : []));
  const scheduled = tasks.filter((task) => actionIds.has(task.action_id));
  return {
    count: scheduled.length,
    minutes: scheduled.reduce((sum, task) => sum + aiTaskMinutes(task), 0),
    untimed: scheduled.filter((task) => !task.start_time || !task.end_time).length,
    running: scheduled.filter((task) => task.status === "running").length,
    ready: scheduled.filter((task) => task.status === "ready").length,
  };
}

// One task list per action/day, even when an action occupies several slots.
export function aiTaskAnchorSlots(slots: readonly DailyScheduleSlot[]): Map<number, number> {
  const anchors = new Map<number, number>();
  for (const slot of slots) {
    if (slot.action && !anchors.has(slot.action.id)) anchors.set(slot.action.id, slot.id);
  }
  return anchors;
}
